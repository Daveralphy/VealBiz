import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { WORKSPACES, WORKSPACE_LABELS } from "@windveal/shared";
import { db } from "../../db/client";
import { aiUsage } from "../../db/schema";
import { requireOrg, type OrgContext } from "../../lib/context";
import { AppError, badRequest, parse } from "../../lib/http";
import { AiUnavailable, aiConnected, chatCompletion, type ChatMessage } from "../../lib/ai";
import { loadPricing } from "../../lib/pricing";
import { env } from "../../env";
import { localDate } from "../people/util";
import { toolByName, toolSpecs, type Call } from "./tools";
import { checkColumns } from "./imports";

const MAX_STEPS = 6;
const month = () => localDate().slice(0, 7);

/** How much WindVeal AI the business can use this month (by plan) and how much it has used. */
async function allowance(ctx: OrgContext) {
  const limit = loadPricing().plans.find((p) => p.key === ctx.org.plan)?.aiRequestsPerMonth ?? 0;
  const [u] = await db.select({ n: aiUsage.count }).from(aiUsage).where(and(eq(aiUsage.orgId, ctx.org.id), eq(aiUsage.month, month()))).limit(1);
  return { used: u?.n ?? 0, limit };
}

async function useOne(ctx: OrgContext) {
  const { used, limit } = await allowance(ctx);
  if (limit === 0) throw new AppError(402, "ai_plan", "WindVeal AI comes with the Growth plan. Upgrade in Plan and billing to use it.");
  if (used >= limit) throw new AppError(429, "ai_limit", `Your business has used all ${limit} WindVeal AI requests this month. More come with the next plan, or next month.`);
  await db.insert(aiUsage).values({ orgId: ctx.org.id, month: month(), count: 1 })
    .onConflictDoUpdate({ target: [aiUsage.orgId, aiUsage.month], set: { count: dsql`${aiUsage.count} + 1` } });
}

function systemPrompt(ctx: OrgContext) {
  const open = WORKSPACES.filter((w) => ctx.access[w] !== "none").map((w) => `${WORKSPACE_LABELS[w]} (${ctx.access[w]})`).join(", ");
  return [
    `You are WindVeal AI, the assistant inside WindVeal, a business app for ${ctx.org.tradingName || ctx.org.legalName}.`,
    `You're helping ${ctx.user.name} (${ctx.role?.name ?? (ctx.membership.role === "admin" ? "Admin" : ctx.membership.role)}). Today is ${localDate()}.`,
    `They can open: ${open || "only their own things"}. Everyone also has My space (their own attendance, leave, pay and onboarding).`,
    "Use the tools to look things up and to make changes. Never make up names, numbers or dates: look them up.",
    "To change something, call the change tool straight away with what you know; WindVeal shows the person a card to confirm before anything happens, so don't ask them to confirm in words.",
    "If something essential is missing (like the dates for leave), ask one short question instead.",
    "If a tool says they don't have access, tell them plainly and suggest asking an admin.",
    "Answer in short, plain English. Use dates like 12 Nov. No markdown tables.",
  ].join("\n");
}

const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string().max(4000) }),
  z.object({
    role: z.literal("assistant"), content: z.string().max(8000).nullable(),
    tool_calls: z.array(z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string().max(8000) }) })).optional(),
  }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string().max(12000) }),
]);
const conversation = z.array(message).min(1).max(60);

type Outcome =
  | { messages: ChatMessage[]; reply: string }
  | { messages: ChatMessage[]; proposal: { toolCallId: string; tool: string; summary: string } };

function args(raw: string) { try { return JSON.parse(raw || "{}"); } catch { return {}; } }

/**
 * One turn: the model reads, looks things up with tools, and answers. A change stops the turn and comes
 * back as a proposal for the person to confirm. Nothing is stored: the app sends the conversation each time.
 */
async function converse(ctx: OrgContext, call: Call, messages: ChatMessage[]): Promise<Outcome> {
  const system: ChatMessage = { role: "system", content: systemPrompt(ctx) };
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await chatCompletion([system, ...messages], toolSpecs());
    if (!res.toolCalls.length) {
      const reply = res.content?.trim() || "Sorry, I didn't catch that. Could you say it another way?";
      messages.push({ role: "assistant", content: reply });
      return { messages, reply };
    }
    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      const tool = toolByName(tc.function.name);
      if (!tool) { messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: `There's no tool called ${tc.function.name}.` }) }); continue; }
      if (tool.change) {
        // Anything after the change waits until the person has answered.
        for (const later of res.toolCalls.slice(res.toolCalls.indexOf(tc) + 1)) {
          messages.push({ role: "tool", tool_call_id: later.id, content: JSON.stringify({ error: "Not done yet: waiting for the person to confirm the earlier change." }) });
        }
        return { messages, proposal: { toolCallId: tc.id, tool: tool.name, summary: tool.summary?.(args(tc.function.arguments)) ?? tool.description } };
      }
      const out = await tool.run(call, args(tc.function.arguments)).catch(() => ({ error: "That lookup failed." }));
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) });
    }
  }
  const reply = "I couldn't finish that. Could you ask in a simpler way?";
  messages.push({ role: "assistant", content: reply });
  return { messages, reply };
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

async function run(fn: () => Promise<Outcome>) {
  try { return await fn(); }
  catch (e) { if (e instanceof AiUnavailable) throw new AppError(503, "ai_unavailable", e.message); throw e; }
}

export default async function aiRoutes(app: FastifyInstance) {
  app.get("/api/ai/status", async (req) => {
    const ctx = await requireOrg(req);
    const a = await allowance(ctx);
    return { connected: aiConnected(), model: aiConnected() ? env.aiModel : null, ...a };
  });

  /** A new message from the person. */
  app.post("/api/ai/chat", async (req) => {
    const ctx = await requireOrg(req);
    const { messages } = parse(z.object({ messages: conversation }), req.body);
    if (messages[messages.length - 1]!.role !== "user") throw badRequest("Send a message to WindVeal AI.");
    if (!aiConnected()) throw new AppError(503, "ai_unavailable", "WindVeal AI isn't connected yet.");
    await useOne(ctx);
    return run(() => converse(ctx, callerFor(app, req), messages as ChatMessage[]));
  });

  /** Reads a sheet in an import (headers and sample values) and suggests what each column really is. */
  app.post<{ Params: { id: string } }>("/api/ai/imports/:id/check", async (req) => {
    const ctx = await requireOrg(req);
    const { sheet } = parse(z.object({ sheet: z.string().min(1).max(200) }), req.body);
    if (!aiConnected()) throw new AppError(503, "ai_unavailable", "WindVeal AI isn't connected yet.");
    await useOne(ctx);
    try { return await checkColumns(callerFor(app, req), req.params.id, sheet); }
    catch (e) { if (e instanceof AiUnavailable) throw new AppError(503, "ai_unavailable", e.message); throw e; }
  });

  /** The person's answer to a proposed change: do it (or not), then the assistant carries on. */
  app.post("/api/ai/confirm", async (req) => {
    const ctx = await requireOrg(req);
    const input = parse(z.object({ messages: conversation, toolCallId: z.string(), confirm: z.boolean() }), req.body);
    const messages = input.messages as ChatMessage[];
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
    if (!aiConnected()) return { messages, reply: input.confirm ? (done ? "Done." : "That didn't work.") : "Okay, I won't do that.", done };
    await useOne(ctx);
    const out = await run(() => converse(ctx, call, messages));
    return { ...out, done: input.confirm && done };
  });
}
