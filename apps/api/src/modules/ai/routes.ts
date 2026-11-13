import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, lt, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { ASSISTANT_AREAS, CHAT_KEEP_DAYS, WORKSPACES, WORKSPACE_LABELS, type AssistantArea, type VealLink } from "@windveal/shared";
import { db } from "../../db/client";
import { aiBriefings, aiChats, aiUsage } from "../../db/schema";
import { requireOrg, type OrgContext } from "../../lib/context";
import { AppError, badRequest, forbidden, notFound, parse } from "../../lib/http";
import { AiUnavailable, aiConnected, chatCompletion, type ChatMessage } from "../../lib/ai";
import { loadPricing } from "../../lib/pricing";
import { env } from "../../env";
import { localDate } from "../people/util";
import { toolByName, toolSpecs, type Call } from "./tools";
import { toolsFor } from "./topics";
import { checkColumns, describeFile } from "./imports";
import { canOpenArea, linksFor } from "./links";
import { makeBriefing } from "./briefing";

const MAX_STEPS = 6;
const month = () => localDate().slice(0, 7);

/** How much Veal the business can use this month (by plan) and how much it has used. */
async function allowance(ctx: OrgContext) {
  const limit = loadPricing().plans.find((p) => p.key === ctx.org.plan)?.aiRequestsPerMonth ?? 0;
  const [u] = await db.select({ n: aiUsage.count }).from(aiUsage).where(and(eq(aiUsage.orgId, ctx.org.id), eq(aiUsage.month, month()))).limit(1);
  return { used: u?.n ?? 0, limit };
}

async function useOne(ctx: OrgContext) {
  const { used, limit } = await allowance(ctx);
  if (limit === 0) throw new AppError(402, "ai_plan", "Veal comes with the Growth plan. Upgrade in Plan and billing to use it.");
  if (used >= limit) throw new AppError(429, "ai_limit", `Your business has used all ${limit} Veal requests this month. More come with the next plan, or next month.`);
  await db.insert(aiUsage).values({ orgId: ctx.org.id, month: month(), count: 1 })
    .onConflictDoUpdate({ target: [aiUsage.orgId, aiUsage.month], set: { count: dsql`${aiUsage.count} + 1` } });
}

function systemPrompt(ctx: OrgContext) {
  const open = WORKSPACES.filter((w) => ctx.access[w] !== "none").map((w) => `${WORKSPACE_LABELS[w]} (${ctx.access[w]})`).join(", ");
  return [
    `You are Veal, the assistant inside WindVeal, a business app for ${ctx.org.tradingName || ctx.org.legalName}.`,
    `You're helping ${ctx.user.name} (${ctx.role?.name ?? (ctx.membership.role === "admin" ? "Admin" : ctx.membership.role)}). Today is ${localDate()}.`,
    `They can open: ${open || "only their own things"}. Everyone also has My Workspace (their own attendance, leave, pay and onboarding).`,
    "Use the tools to look things up and to make changes. Never make up names, numbers or dates: look them up.",
    "To change something, call the change tool straight away with what you know; WindVeal shows the person a card to confirm before anything happens, so don't ask them to confirm in words.",
    "If something essential is missing (like the dates for leave), ask one short question instead.",
    "If a tool says they don't have access, tell them plainly and suggest asking an admin.",
    "Answer in short, plain English. Use dates like 12 Nov. No markdown tables. WindVeal adds a button to the right page under your reply, so don't paste links.",
  ].join("\n");
}

const link = z.object({ label: z.string().max(80), to: z.string().regex(/^\/[a-z0-9/_-]*$/i).max(200) });
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string().max(4000), file: z.object({ name: z.string().max(300), jobId: z.string().uuid() }).optional() }),
  z.object({
    role: z.literal("assistant"), content: z.string().max(8000).nullable(),
    tool_calls: z.array(z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string().max(8000) }) })).optional(),
    links: z.array(link).max(3).optional(),
    proposal: z.string().max(500).optional(),
  }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string().max(12000) }),
]);
const conversation = z.array(message).min(1).max(60);
/** Where a chat lives: its id (made by the app) and the area it was started in. Without it, nothing is saved. */
const saving = { chatId: z.string().uuid().optional(), area: z.enum([...ASSISTANT_AREAS, "home"]).optional() };

type Msg = ChatMessage & { links?: VealLink[]; file?: { name: string; jobId: string }; proposal?: string };
type Outcome =
  | { messages: Msg[]; reply: string; links: VealLink[] }
  | { messages: Msg[]; proposal: { toolCallId: string; tool: string; summary: string } };

function args(raw: string) { try { return JSON.parse(raw || "{}"); } catch { return {}; } }

/** What the model is sent: the standard chat format, without WindVeal's own extras (buttons, files). */
const forModel = (messages: Msg[]): ChatMessage[] => messages.map((m) => {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") return { role: "assistant", content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) };
  return m;
});

/**
 * One turn: the model reads, looks things up with tools, and answers. A change stops the turn and comes
 * back as a proposal for the person to confirm. A reply ends with buttons to the pages it drew on.
 */
async function converse(ctx: OrgContext, call: Call, messages: Msg[]): Promise<Outcome> {
  const system: ChatMessage = { role: "system", content: systemPrompt(ctx) };
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await chatCompletion([system, ...forModel(messages)], toolSpecs(toolsFor(messages, ctx.access)));
    if (!res.toolCalls.length) {
      const reply = res.content?.trim() || "Sorry, I didn't catch that. Could you say it another way?";
      const links = linksFor(ctx, messages);
      messages.push({ role: "assistant", content: reply, ...(links.length ? { links } : {}) });
      return { messages, reply, links };
    }
    const said: Msg = { role: "assistant", content: res.content, tool_calls: res.toolCalls };
    messages.push(said);
    for (const tc of res.toolCalls) {
      const tool = toolByName(tc.function.name);
      if (!tool) { messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: `There's no tool called ${tc.function.name}.` }) }); continue; }
      if (tool.change) {
        // Anything after the change waits until the person has answered.
        for (const later of res.toolCalls.slice(res.toolCalls.indexOf(tc) + 1)) {
          messages.push({ role: "tool", tool_call_id: later.id, content: JSON.stringify({ error: "Not done yet: waiting for the person to confirm the earlier change." }) });
        }
        const summary = tool.summary?.(args(tc.function.arguments)) ?? tool.description;
        // Kept on the message, so a saved chat can show the card again.
        said.proposal = summary;
        return { messages, proposal: { toolCallId: tc.id, tool: tool.name, summary } };
      }
      const out = await tool.run(call, args(tc.function.arguments)).catch(() => ({ error: "That lookup failed." }));
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) });
    }
  }
  const reply = "I couldn't finish that. Could you ask in a simpler way?";
  messages.push({ role: "assistant", content: reply });
  return { messages, reply, links: [] };
}

/** Lets a tool call WindVeal's own endpoints as the person (same cookie, so same access and rules). */
function callerFor(app: FastifyInstance, req: FastifyRequest): Call {
  return async (method, url, body) => {
    const r = await app.inject({ method, url, payload: body as object | undefined, headers: { cookie: req.headers.cookie ?? "" } });
    let parsed: unknown = null;
    try { parsed = r.json(); } catch { parsed = r.body; }
    return { status: r.statusCode, body: parsed };
  };
}

async function run<T>(fn: () => Promise<T>) {
  try { return await fn(); }
  catch (e) { if (e instanceof AiUnavailable) throw new AppError(503, "ai_unavailable", e.message); throw e; }
}

// ---------------- saved chats ----------------

const keepFrom = () => new Date(Date.now() - CHAT_KEEP_DAYS * 86_400_000);
/** Chats not used for 15 days are cleared. */
const clearOld = (ctx: OrgContext) => db.delete(aiChats).where(and(eq(aiChats.userId, ctx.user.id), lt(aiChats.updatedAt, keepFrom())));

function titleOf(messages: Msg[]) {
  const first = messages.find((m) => m.role === "user") as { content: string; file?: { name: string } } | undefined;
  const t = first?.file ? first.file.name : first?.content ?? "Chat";
  return t.length > 70 ? `${t.slice(0, 67)}...` : t;
}

async function saveChat(ctx: OrgContext, chatId: string | undefined, area: string | undefined, messages: Msg[]) {
  if (!chatId) return;
  const [existing] = await db.select({ userId: aiChats.userId }).from(aiChats).where(eq(aiChats.id, chatId)).limit(1);
  if (existing && existing.userId !== ctx.user.id) return; // someone else's id: never overwrite it
  if (existing) await db.update(aiChats).set({ messages, updatedAt: new Date() }).where(eq(aiChats.id, chatId));
  else await db.insert(aiChats).values({ id: chatId, orgId: ctx.org.id, userId: ctx.user.id, area: area ?? "home", title: titleOf(messages), messages });
  await clearOld(ctx);
}

const areaParam = (raw: string, ctx: OrgContext): AssistantArea => {
  const area = ASSISTANT_AREAS.find((a) => a === raw);
  if (!area) throw notFound("That area");
  if (!canOpenArea(ctx, area)) throw forbidden("You don't have access to this area.");
  return area;
};

export default async function aiRoutes(app: FastifyInstance) {
  app.get("/api/ai/status", async (req) => {
    const ctx = await requireOrg(req);
    const a = await allowance(ctx);
    return { connected: aiConnected(), model: aiConnected() ? env.aiModel : null, ...a };
  });

  /** A new message from the person. */
  app.post("/api/ai/chat", async (req) => {
    const ctx = await requireOrg(req);
    const input = parse(z.object({ messages: conversation, ...saving }), req.body);
    const messages = input.messages as Msg[];
    if (messages[messages.length - 1]!.role !== "user") throw badRequest("Send a message to Veal.");
    if (!aiConnected()) throw new AppError(503, "ai_unavailable", "Veal isn't connected yet.");
    await useOne(ctx);
    const out = await run(() => converse(ctx, callerFor(app, req), messages));
    await saveChat(ctx, input.chatId, input.area, out.messages);
    return out;
  });

  /** The person's answer to a proposed change: do it (or not), then Veal carries on. */
  app.post("/api/ai/confirm", async (req) => {
    const ctx = await requireOrg(req);
    const input = parse(z.object({ messages: conversation, toolCallId: z.string(), confirm: z.boolean(), ...saving }), req.body);
    const messages = input.messages as Msg[];
    const last = messages[messages.length - 1];
    const tc = last?.role === "assistant" ? last.tool_calls?.find((t) => t.id === input.toolCallId) : messages
      .flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : [])).find((t) => t.id === input.toolCallId);
    const tool = tc && toolByName(tc.function.name);
    if (!tc || !tool?.change) throw badRequest("There's nothing waiting to be confirmed.");
    if (messages.some((m) => m.role === "tool" && m.tool_call_id === tc.id)) throw badRequest("That change has already been answered.");
    const call = callerFor(app, req);
    const result = input.confirm
      ? await tool.run(call, args(tc.function.arguments)).catch(() => ({ error: "That didn't work." }))
      : { cancelled: true, note: "The person chose not to do this." };
    messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
    const done = !(result && typeof result === "object" && "error" in result);
    if (!aiConnected()) {
      const reply = input.confirm ? (done ? "Done." : "That didn't work.") : "Okay, I won't do that.";
      messages.push({ role: "assistant", content: reply });
      await saveChat(ctx, input.chatId, input.area, messages);
      return { messages, reply, links: [], done };
    }
    await useOne(ctx);
    const out = await run(() => converse(ctx, call, messages));
    await saveChat(ctx, input.chatId, input.area, out.messages);
    return { ...out, done: input.confirm && done };
  });

  /**
   * A spreadsheet added in the chat (already uploaded to Import data): Veal says what it sees and where it
   * belongs, with a button to check it there. Nothing is added from the chat.
   */
  app.post("/api/ai/files", async (req) => {
    const ctx = await requireOrg(req);
    const input = parse(z.object({ jobId: z.string().uuid(), messages: z.array(message).max(60).default([]), ...saving }), req.body);
    if (!aiConnected()) throw new AppError(503, "ai_unavailable", "Veal isn't connected yet.");
    await useOne(ctx);
    const d = await run(() => describeFile(callerFor(app, req), input.jobId));
    const links: VealLink[] = [{ label: "Review in Import data", to: `/import/${input.jobId}/sheets` }];
    const messages = [...(input.messages as Msg[]),
      { role: "user", content: `I've added the file ${d.fileName}.`, file: { name: d.fileName, jobId: input.jobId } },
      { role: "assistant", content: `${d.reply}\n\nNothing is added until you check it.`, links },
    ] as Msg[];
    await saveChat(ctx, input.chatId, input.area, messages);
    return { messages, reply: messages[messages.length - 1]!.content, links, file: { name: d.fileName, sheets: d.sheets, rows: d.rows } };
  });

  /** The person's recent chats (their own only), newest first. */
  app.get<{ Querystring: { area?: string } }>("/api/ai/chats", async (req) => {
    const ctx = await requireOrg(req);
    await clearOld(ctx);
    const where = req.query.area ? and(eq(aiChats.userId, ctx.user.id), eq(aiChats.orgId, ctx.org.id), eq(aiChats.area, req.query.area))
      : and(eq(aiChats.userId, ctx.user.id), eq(aiChats.orgId, ctx.org.id));
    const rows = await db.select({ id: aiChats.id, title: aiChats.title, area: aiChats.area, updatedAt: aiChats.updatedAt }).from(aiChats)
      .where(where).orderBy(desc(aiChats.updatedAt)).limit(20);
    return { chats: rows, keepDays: CHAT_KEEP_DAYS };
  });

  app.get<{ Params: { id: string } }>("/api/ai/chats/:id", async (req) => {
    const ctx = await requireOrg(req);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That chat");
    const [c] = await db.select().from(aiChats).where(and(eq(aiChats.id, req.params.id), eq(aiChats.userId, ctx.user.id), eq(aiChats.orgId, ctx.org.id))).limit(1);
    if (!c || c.updatedAt < keepFrom()) throw notFound("That chat");
    return { id: c.id, area: c.area, title: c.title, messages: c.messages };
  });

  app.delete<{ Params: { id: string } }>("/api/ai/chats/:id", async (req) => {
    const ctx = await requireOrg(req);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That chat");
    await db.delete(aiChats).where(and(eq(aiChats.id, req.params.id), eq(aiChats.userId, ctx.user.id)));
    return { ok: true };
  });

  // ---------------- an area's Assistant page ----------------

  /** What Veal sees in an area for this person: worked out once a day, then kept, so opening the page costs nothing. */
  app.get<{ Params: { area: string } }>("/api/ai/briefing/:area", async (req) => {
    const ctx = await requireOrg(req);
    const area = areaParam(req.params.area, ctx);
    const [b] = await db.select().from(aiBriefings).where(and(eq(aiBriefings.orgId, ctx.org.id), eq(aiBriefings.userId, ctx.user.id), eq(aiBriefings.area, area))).limit(1);
    if (b && b.day === localDate()) return { briefing: b.content, fresh: false };
    return { briefing: await brief(ctx, area, req), fresh: true };
  });

  /** "Look again": work it out afresh now. */
  app.post<{ Params: { area: string } }>("/api/ai/briefing/:area/refresh", async (req) => {
    const ctx = await requireOrg(req);
    const area = areaParam(req.params.area, ctx);
    return { briefing: await brief(ctx, area, req), fresh: true };
  });

  async function brief(ctx: OrgContext, area: AssistantArea, req: FastifyRequest) {
    if (!aiConnected()) throw new AppError(503, "ai_unavailable", "Veal isn't connected yet.");
    await useOne(ctx);
    const content = await run(() => makeBriefing(ctx, callerFor(app, req), area));
    await db.insert(aiBriefings).values({ orgId: ctx.org.id, userId: ctx.user.id, area, day: localDate(), content })
      .onConflictDoUpdate({ target: [aiBriefings.orgId, aiBriefings.userId, aiBriefings.area], set: { day: localDate(), content, createdAt: new Date() } });
    return content;
  }

  /** Reads a sheet in an import (headers and sample values) and suggests what each column really is. */
  app.post<{ Params: { id: string } }>("/api/ai/imports/:id/check", async (req) => {
    const ctx = await requireOrg(req);
    const { sheet } = parse(z.object({ sheet: z.string().min(1).max(200) }), req.body);
    if (!aiConnected()) throw new AppError(503, "ai_unavailable", "Veal isn't connected yet.");
    await useOne(ctx);
    return run(() => checkColumns(callerFor(app, req), req.params.id, sheet));
  });
}
