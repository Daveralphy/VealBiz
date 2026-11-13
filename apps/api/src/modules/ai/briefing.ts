import { z } from "zod";
import { AREA_NAMES, AREA_PAGES, type AssistantArea, type Briefing, type BriefingItem } from "@windveal/shared";
import { chatCompletion } from "../../lib/ai";
import { AppError } from "../../lib/http";
import type { OrgContext } from "../../lib/context";
import { localDate } from "../people/util";
import { compact, type Call } from "./tools";

/** What Veal reads for each area: WindVeal's own screens' data, fetched as the person, so it sees only what they can. */
const SOURCES: Record<AssistantArea, string[]> = {
  me: ["/api/my/summary", "/api/people/leave/balances", "/api/people/leave/requests?scope=mine", "/api/workflows/tasks?scope=mine"],
  people: ["/api/people/stats", "/api/people/attendance", "/api/people/leave/requests"],
  recruitment: ["/api/recruitment/stats", "/api/recruitment/jobs", "/api/recruitment/interviews"],
  crm: ["/api/crm/overview", "/api/crm/deals", "/api/crm/follow-ups"],
  workflows: ["/api/workflows/summary", "/api/workflows/tasks?scope=mine", "/api/workflows/approvals"],
  documents: ["/api/documents/dashboard"],
  insights: ["/api/insights/overview"],
};

const reply = z.object({
  summary: z.string().min(1),
  items: z.array(z.object({
    tone: z.enum(["bad", "warn", "good", "info"]).catch("info"),
    title: z.string().min(1),
    detail: z.string().default(""),
    page: z.string().nullable().optional(),
  })).default([]),
});

export async function makeBriefing(ctx: OrgContext, call: Call, area: AssistantArea): Promise<Briefing> {
  const data: string[] = [];
  for (const path of SOURCES[area]) {
    const r = await call("GET", path).catch(() => null);
    if (!r || r.status >= 400) continue;
    data.push(`${path}:\n${JSON.stringify(compact(r.body)).slice(0, 3500)}`);
  }
  const pages = AREA_PAGES[area];
  const prompt = [
    `You are Veal, the assistant in WindVeal, a business app for ${ctx.org.tradingName || ctx.org.legalName}.`,
    `Write ${ctx.user.name}'s briefing for ${AREA_NAMES[area]}. Today is ${localDate()}.`,
    "Here is what they can see there right now (JSON from WindVeal):",
    data.join("\n\n") || "(nothing yet)",
    "Pages they can be sent to (path: name):",
    ...pages.map((p) => `- ${p.to}: ${p.label}`),
    "Reply with JSON only, no other text, in this shape:",
    `{"summary": "<one or two plain sentences on how things stand>", "items": [{"tone": "bad|warn|good|info", "title": "<short, specific, with names and numbers>", "detail": "<one sentence on why it matters>", "page": "<one of the paths above, or null>"}]}`,
    "Give up to 5 items, most urgent first: overdue or stuck things are bad, things to watch are warn, good news is good. Only use facts from the data. If there's little data, say so kindly and suggest a first step.",
    "Plain English, no markdown, dates like 12 Nov.",
  ].join("\n");

  const res = await chatCompletion([{ role: "user", content: prompt }], []);
  const json = (res.content ?? "").match(/\{[\s\S]*\}/)?.[0];
  const parsed = reply.safeParse((() => { try { return JSON.parse(json ?? ""); } catch { return null; } })());
  if (!parsed.success) throw new AppError(502, "ai_unreadable", "Veal couldn't put this together. Try Look again.");
  const items: BriefingItem[] = parsed.data.items.slice(0, 5).map((it) => {
    const page = pages.find((p) => p.to === it.page);
    return { tone: it.tone, title: it.title.slice(0, 160), detail: it.detail.slice(0, 300), ...(page ? { link: { label: `Open ${page.label}`, to: page.to } } : {}) };
  });
  return { summary: parsed.data.summary.slice(0, 600), items, at: new Date().toISOString() };
}
