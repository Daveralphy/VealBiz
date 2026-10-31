import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_DEAL_STAGES, DEFAULT_LEAD_STAGES } from "@windveal/shared";
import { db, type Tx } from "../../db/client";
import {
  activities, companies, contacts, deals, fileLinks, files, leads, memberships, organisations, tasks, users,
  type LeadQualification,
} from "../../db/schema";
import { requireAccess, type OrgContext } from "../../lib/context";
import { badRequest, conflict, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { createTask } from "../../lib/tasks";
import { fileView } from "../files/routes";

// ---------------------------------------------------------------- helpers

const CLOSED = "Closed";
const DAY = 86_400_000;
const RESERVED_STAGES = ["closed", "won", "lost"];

type Org = OrgContext["org"];
const leadStagesOf = (org: Org) => (org.settings.leadStages?.length ? org.settings.leadStages : DEFAULT_LEAD_STAGES);
const dealStagesOf = (org: Org) => (org.settings.dealStages?.length ? org.settings.dealStages : DEFAULT_DEAL_STAGES);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const bump = (col: unknown) => dsql`${col} + 1`;
const startOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };

/** Optional text: "" → null; undefined stays undefined (so PATCH leaves it alone). */
const optText = (max = 200) => z.string().trim().max(max, `Keep this under ${max} characters.`).nullish()
  .transform((v) => (v === undefined ? undefined : v ? v : null));
const reqText = (label: string, max = 200) => z.string({ required_error: `Enter ${label}.` }).trim().min(1, `Enter ${label}.`).max(max, `Keep this under ${max} characters.`);
const optMoney = z.union([z.number(), z.string()]).nullish().transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v.replace(/,/g, "").trim());
  if (!Number.isFinite(n)) { ctx.addIssue({ code: "custom", message: "Enter an amount, like 250000." }); return z.NEVER; }
  if (n < 0) { ctx.addIssue({ code: "custom", message: "The amount can't be negative." }); return z.NEVER; }
  if (n > 1e12) { ctx.addIssue({ code: "custom", message: "That amount is too large." }); return z.NEVER; }
  return n;
});
const blankToNull = <T>(v: T | "" | null | undefined): T | null | undefined => (v === "" ? null : v);
const optUuid = z.union([z.literal(""), z.string().uuid("Choose a valid option.")]).nullish().transform(blankToNull);
const optDate = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.")]).nullish().transform(blankToNull);
const optEmail = z.union([z.literal(""), z.string().trim().email("Enter a valid email address.").max(200)]).nullish().transform(blankToNull);
const optDateTime = z.union([z.string(), z.date()]).nullish().transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: "custom", message: "Enter a valid date and time." }); return z.NEVER; }
  return d;
});

/** Typed wrapper so transformed (output) types flow through. */
const parseInput = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> => parse(schema, data) as z.output<S>;

async function memberNames(orgId: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: users.id, name: users.name }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.orgId, orgId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function assertMember(orgId: string, userId: string | null | undefined, field = "ownerUserId") {
  if (!userId) return;
  const [m] = await db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId), isNull(memberships.deletedAt))).limit(1);
  if (!m) throw badRequest("Some details need fixing.", { [field]: "Choose someone in your organisation." });
}

async function getCompany(orgId: string, id: string, tx: Tx = db) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That company");
  const [c] = await tx.select().from(companies).where(and(eq(companies.id, id), eq(companies.orgId, orgId), isNull(companies.deletedAt))).limit(1);
  if (!c) throw notFound("That company");
  return c;
}
async function getDeal(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That deal");
  const [d] = await db.select().from(deals).where(and(eq(deals.id, id), eq(deals.orgId, orgId), isNull(deals.deletedAt))).limit(1);
  if (!d) throw notFound("That deal");
  return d;
}
async function getLead(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That lead");
  const [l] = await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.orgId, orgId), isNull(leads.deletedAt))).limit(1);
  if (!l) throw notFound("That lead");
  return l;
}
async function getContact(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That contact");
  const [c] = await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.orgId, orgId), isNull(contacts.deletedAt))).limit(1);
  if (!c) throw notFound("That contact");
  return c;
}

const qualScore = (q: LeadQualification) => [q.need, q.budget, q.decisionMaker, q.timeline].filter(Boolean).length;

type LeadRow = typeof leads.$inferSelect;
function leadView(l: LeadRow, names: Map<string, string>, last?: { type: string; occurredAt: Date } | null) {
  return {
    id: l.id, companyName: l.companyName, contactName: l.contactName, contactRole: l.contactRole, email: l.email, phone: l.phone,
    source: l.source, stage: l.stage, ownerUserId: l.ownerUserId, ownerName: l.ownerUserId ? names.get(l.ownerUserId) ?? null : null,
    estimatedValue: numOrNull(l.estimatedValue), qualification: l.qualification, qualificationScore: qualScore(l.qualification),
    nextStep: l.nextStep, nextStepDue: l.nextStepDue, closedOutcome: l.closedOutcome, closedReason: l.closedReason, closedAt: l.closedAt,
    convertedCompanyId: l.convertedCompanyId, convertedDealId: l.convertedDealId, createdAt: l.createdAt, updatedAt: l.updatedAt,
    version: l.version, lastActivity: last ?? null, reference: l.reference, extraDetails: l.extraDetails,
  };
}

type DealRow = typeof deals.$inferSelect;
type NextTask = { id: string; title: string; dueAt: Date | null } | null;
function dealView(d: DealRow, names: Map<string, string>, extra: { companyName?: string | null; contactName?: string | null; nextTask?: NextTask } = {}) {
  return {
    id: d.id, name: d.name, value: num(d.value), currency: d.currency, stage: d.stage, status: d.status,
    companyId: d.companyId, companyName: extra.companyName ?? null, contactId: d.contactId, contactName: extra.contactName ?? null,
    ownerUserId: d.ownerUserId, ownerName: d.ownerUserId ? names.get(d.ownerUserId) ?? null : null, expectedCloseOn: d.expectedCloseOn,
    nextStep: d.nextStep, nextTask: extra.nextTask ?? null, wonAt: d.wonAt, lostAt: d.lostAt, lostReason: d.lostReason,
    createdAt: d.createdAt, updatedAt: d.updatedAt, version: d.version,
  };
}

function companyView(c: typeof companies.$inferSelect, names: Map<string, string>) {
  return {
    id: c.id, name: c.name, industry: c.industry, location: c.location, website: c.website, status: c.status, notes: c.notes,
    reference: c.reference, extraDetails: c.extraDetails,
    ownerUserId: c.ownerUserId, ownerName: c.ownerUserId ? names.get(c.ownerUserId) ?? null : null,
    createdAt: c.createdAt, updatedAt: c.updatedAt, version: c.version,
  };
}

function contactView(c: typeof contacts.$inferSelect) {
  return { id: c.id, companyId: c.companyId, name: c.name, role: c.role, email: c.email, phone: c.phone, isPrimary: c.isPrimary, createdAt: c.createdAt };
}

async function activityList(orgId: string, where: ReturnType<typeof and>, names: Map<string, string>, limit = 100) {
  const rows = await db.select({ a: activities, contactName: contacts.name }).from(activities)
    .leftJoin(contacts, eq(contacts.id, activities.contactId))
    .where(and(eq(activities.orgId, orgId), isNull(activities.deletedAt), where))
    .orderBy(desc(activities.occurredAt), desc(activities.createdAt)).limit(limit);
  return rows.map(({ a, contactName }) => ({
    id: a.id, type: a.type, subject: a.subject, body: a.body, occurredAt: a.occurredAt, durationMinutes: numOrNull(a.durationMinutes),
    companyId: a.companyId, dealId: a.dealId, leadId: a.leadId, contactId: a.contactId, contactName,
    authorUserId: a.authorUserId, authorName: names.get(a.authorUserId) ?? "Someone", createdAt: a.createdAt,
  }));
}

/** Open CRM follow-up tasks with the record they point at (company/deal/lead) resolved for display. */
type TaskRow = typeof tasks.$inferSelect;
async function followUpViews(orgId: string, rows: TaskRow[], names: Map<string, string>) {
  const dealIds = rows.filter((t) => t.linkType === "deal" && t.linkId).map((t) => t.linkId!);
  const leadIds = rows.filter((t) => t.linkType === "lead" && t.linkId).map((t) => t.linkId!);
  const companyIds = rows.filter((t) => t.linkType === "company" && t.linkId).map((t) => t.linkId!);
  const dealRows = dealIds.length
    ? await db.select({ id: deals.id, name: deals.name, value: deals.value, companyId: deals.companyId, companyName: companies.name })
      .from(deals).innerJoin(companies, eq(companies.id, deals.companyId)).where(and(eq(deals.orgId, orgId), inArray(deals.id, dealIds)))
    : [];
  const leadRows = leadIds.length
    ? await db.select({ id: leads.id, companyName: leads.companyName }).from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.id, leadIds)))
    : [];
  const companyRows = companyIds.length
    ? await db.select({ id: companies.id, name: companies.name }).from(companies).where(and(eq(companies.orgId, orgId), inArray(companies.id, companyIds)))
    : [];
  const dm = new Map(dealRows.map((d) => [d.id, d]));
  const lm = new Map(leadRows.map((l) => [l.id, l]));
  const cm = new Map(companyRows.map((c) => [c.id, c]));
  return rows.map((t) => {
    const d = t.linkType === "deal" ? dm.get(t.linkId!) : undefined;
    const l = t.linkType === "lead" ? lm.get(t.linkId!) : undefined;
    const c = t.linkType === "company" ? cm.get(t.linkId!) : undefined;
    return {
      id: t.id, title: t.title, description: t.description, status: t.status, dueAt: t.dueAt, completedAt: t.completedAt,
      assigneeUserId: t.assigneeUserId, assigneeName: t.assigneeUserId ? names.get(t.assigneeUserId) ?? null : null,
      linkType: t.linkType, linkId: t.linkId, linkLabel: t.linkLabel,
      companyId: d?.companyId ?? c?.id ?? null, companyName: d?.companyName ?? c?.name ?? l?.companyName ?? null,
      dealId: d?.id ?? null, dealName: d?.name ?? null, dealValue: d ? num(d.value) : null, leadId: l?.id ?? null,
    };
  });
}

const openCrmTasks = (orgId: string) => and(eq(tasks.orgId, orgId), eq(tasks.workspace, "crm"), ne(tasks.status, "done"), isNull(tasks.deletedAt));

/** Earliest open follow-up per linked record. */
async function nextTasksFor(orgId: string, linkType: string, ids: string[]): Promise<Map<string, NonNullable<NextTask>>> {
  const out = new Map<string, NonNullable<NextTask>>();
  if (!ids.length) return out;
  const rows = await db.select().from(tasks)
    .where(and(openCrmTasks(orgId), eq(tasks.linkType, linkType), inArray(tasks.linkId, ids)))
    .orderBy(dsql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt));
  for (const t of rows) if (!out.has(t.linkId!)) out.set(t.linkId!, { id: t.id, title: t.title, dueAt: t.dueAt });
  return out;
}

/** Start of "today" in the viewer's time zone (offset = Date#getTimezoneOffset() minutes). */
function dayStart(tzOffset: number, addDays = 0) {
  const now = Date.now() - tzOffset * 60_000; // shift to local wall-clock in UTC terms
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + tzOffset * 60_000 + addDays * DAY);
}
const tzOf = (q: { tz?: string }) => {
  const n = Number(q.tz);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 0;
};

async function mergeSettings(orgId: string, patch: Record<string, unknown>, tx: Tx = db) {
  await tx.update(organisations).set({
    settings: dsql`coalesce(${organisations.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    version: bump(organisations.version),
  }).where(eq(organisations.id, orgId));
}

// ---------------------------------------------------------------- input schemas

const companyInput = z.object({
  name: reqText("the company name", 160),
  industry: optText(120), location: optText(160), website: optText(200), notes: optText(4000),
  status: z.enum(["prospect", "client", "former"]).optional(),
  ownerUserId: optUuid,
});
const contactInput = z.object({
  name: reqText("their name", 160), role: optText(120),
  email: optEmail,
  phone: optText(40), isPrimary: z.boolean().optional(),
});
const leadInput = z.object({
  companyName: reqText("the company name", 160), contactName: optText(160), contactRole: optText(120),
  email: optEmail,
  phone: optText(40), source: optText(80), ownerUserId: optUuid, estimatedValue: optMoney,
  nextStep: optText(200), nextStepDue: optDate, stage: z.string().trim().max(60).optional(),
});
const qualificationInput = z.object({
  need: z.boolean().optional(), budget: z.boolean().optional(), decisionMaker: z.boolean().optional(), timeline: z.boolean().optional(),
  notes: z.record(z.string().max(40), z.string().max(1000)).optional(),
});
const dealInput = z.object({
  companyId: optUuid,
  newCompany: z.object({ name: reqText("the company name", 160), industry: optText(120), location: optText(160) }).optional(),
  contactId: optUuid,
  name: reqText("a deal name", 160),
  value: optMoney,
  stage: z.string().trim().max(60).optional(),
  expectedCloseOn: optDate, ownerUserId: optUuid, nextStep: optText(200),
});
const followUpInput = z.object({
  title: reqText("what needs to happen", 200),
  dueAt: optDateTime,
  assigneeUserId: optUuid,
});
const activityInput = z.object({
  type: z.enum(["note", "call", "meeting", "email"]),
  subject: optText(200), body: optText(10_000),
  occurredAt: optDateTime,
  durationMinutes: z.union([z.literal(""), z.number().int("Use whole minutes.").min(0).max(24 * 60, "That's longer than a day.")]).nullish().transform((v) => (v === "" || v === null ? undefined : v)),
  companyId: optUuid, dealId: optUuid, leadId: optUuid, contactId: optUuid,
  followUp: followUpInput.nullish(),
});
const stagesInput = z.object({
  stages: z.array(z.string().trim().min(1, "Stage names can't be empty.").max(40, "Keep stage names short.")).min(1, "Keep at least one stage.").max(12, "Use 12 stages or fewer."),
});

// ---------------------------------------------------------------- routes

export default async function crmRoutes(app: FastifyInstance) {
  // ---------- summary (header line + tab counts) ----------
  app.get("/api/crm/summary", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const orgId = ctx.org.id;
    const [[c], [d], [l], [f]] = await Promise.all([
      db.select({ n: dsql<number>`count(*)::int` }).from(companies).where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt))),
      db.select({ n: dsql<number>`count(*)::int`, v: dsql<string>`coalesce(sum(${deals.value}),0)` }).from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.status, "open"), isNull(deals.deletedAt))),
      db.select({ n: dsql<number>`count(*)::int` }).from(leads).where(and(eq(leads.orgId, orgId), ne(leads.stage, CLOSED), isNull(leads.deletedAt))),
      db.select({ n: dsql<number>`count(*)::int` }).from(tasks).where(and(openCrmTasks(orgId), eq(tasks.assigneeUserId, ctx.user.id))),
    ]);
    return {
      companies: c?.n ?? 0, openDeals: d?.n ?? 0, openValue: num(d?.v), activeLeads: l?.n ?? 0, myFollowUps: f?.n ?? 0,
      leadStages: leadStagesOf(ctx.org), dealStages: dealStagesOf(ctx.org),
    };
  });

  // ---------- overview ----------
  app.get<{ Querystring: { tz?: string } }>("/api/crm/overview", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const orgId = ctx.org.id;
    const tz = tzOf(req.query);
    const names = await memberNames(orgId);
    const monthStart = startOfMonth();
    const since90 = new Date(Date.now() - 90 * DAY);
    const endOfToday = dayStart(tz, 1);
    const todayStart = dayStart(tz);
    const stages = dealStagesOf(ctx.org);

    const byStage = await db.select({ stage: deals.stage, n: dsql<number>`count(*)::int`, v: dsql<string>`coalesce(sum(${deals.value}),0)` })
      .from(deals).where(and(eq(deals.orgId, orgId), eq(deals.status, "open"), isNull(deals.deletedAt))).groupBy(deals.stage);
    const stageNames = [...stages, ...byStage.map((s) => s.stage).filter((s) => !stages.includes(s))];
    const pipeline = stageNames.map((s) => {
      const r = byStage.find((x) => x.stage === s);
      return { stage: s, count: r?.n ?? 0, value: num(r?.v) };
    });

    const [won] = await db.select({ n: dsql<number>`count(*)::int`, v: dsql<string>`coalesce(sum(${deals.value}),0)` }).from(deals)
      .where(and(eq(deals.orgId, orgId), eq(deals.status, "won"), gte(deals.wonAt, monthStart), isNull(deals.deletedAt)));
    const [rate] = await db.select({
      won: dsql<number>`count(*) filter (where ${deals.status} = 'won' and ${deals.wonAt} >= ${since90.toISOString()}::timestamptz)::int`,
      lost: dsql<number>`count(*) filter (where ${deals.status} = 'lost' and ${deals.lostAt} >= ${since90.toISOString()}::timestamptz)::int`,
    }).from(deals).where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt)));
    const closed = (rate?.won ?? 0) + (rate?.lost ?? 0);

    const myTasks = await db.select().from(tasks)
      .where(and(openCrmTasks(orgId), eq(tasks.assigneeUserId, ctx.user.id), lt(tasks.dueAt, endOfToday)))
      .orderBy(asc(tasks.dueAt));
    const overdue = myTasks.filter((t) => t.dueAt && t.dueAt < todayStart).length;
    // Upcoming (not yet due) follow-ups so the card isn't empty when nothing is due today.
    const upcoming = await db.select().from(tasks)
      .where(and(openCrmTasks(orgId), eq(tasks.assigneeUserId, ctx.user.id), or(gte(tasks.dueAt, endOfToday), isNull(tasks.dueAt))))
      .orderBy(dsql`${tasks.dueAt} asc nulls last`).limit(Math.max(0, 5 - myTasks.length));

    const wins = await db.select({ d: deals, companyName: companies.name }).from(deals).innerJoin(companies, eq(companies.id, deals.companyId))
      .where(and(eq(deals.orgId, orgId), eq(deals.status, "won"), isNull(deals.deletedAt))).orderBy(desc(deals.wonAt)).limit(5);

    const leadStages = leadStagesOf(ctx.org);
    const toContact = await db.select().from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), inArray(leads.stage, [leadStages[0]!, leadStages[leadStages.length - 1]!])))
      .orderBy(dsql`${leads.nextStepDue} asc nulls last`, desc(leads.createdAt)).limit(5);

    const [openTotals] = await db.select({ n: dsql<number>`count(*)::int`, v: dsql<string>`coalesce(sum(${deals.value}),0)` }).from(deals)
      .where(and(eq(deals.orgId, orgId), eq(deals.status, "open"), isNull(deals.deletedAt)));

    return {
      stats: {
        openValue: num(openTotals?.v), openCount: openTotals?.n ?? 0,
        wonThisMonth: num(won?.v), wonThisMonthCount: won?.n ?? 0,
        winRate: closed ? Math.round(((rate?.won ?? 0) / closed) * 100) : null,
        followUpsDue: myTasks.length, followUpsOverdue: overdue,
      },
      pipeline,
      followUps: await followUpViews(orgId, [...myTasks, ...upcoming], names),
      recentWins: wins.map(({ d, companyName }) => dealView(d, names, { companyName })),
      leadsToContact: toContact.map((l) => leadView(l, names)),
    };
  });

  // ---------- stages ----------
  app.get("/api/crm/stages", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    return { leadStages: leadStagesOf(ctx.org), dealStages: dealStagesOf(ctx.org) };
  });

  function checkStageNames(stages: string[]) {
    const lower = stages.map((s) => s.toLowerCase());
    if (new Set(lower).size !== lower.length) throw badRequest("Each stage needs a different name.", { stages: "Each stage needs a different name." });
    const bad = stages.find((s) => RESERVED_STAGES.includes(s.toLowerCase()));
    if (bad) throw badRequest(`"${bad}" is added automatically. Pick another name.`, { stages: `"${bad}" is added automatically.` });
  }

  app.put("/api/crm/stages/leads", async (req) => {
    const ctx = await requireAccess(req, "crm", "manage");
    const { stages } = parseInput(stagesInput, req.body);
    checkStageNames(stages);
    const removed = leadStagesOf(ctx.org).filter((s) => !stages.includes(s));
    if (removed.length) {
      const inUse = await db.select({ stage: leads.stage, n: dsql<number>`count(*)::int` }).from(leads)
        .where(and(eq(leads.orgId, ctx.org.id), isNull(leads.deletedAt), inArray(leads.stage, removed))).groupBy(leads.stage);
      if (inUse.length) {
        throw conflict(`Move the ${inUse.map((u) => `${u.n} lead${u.n === 1 ? "" : "s"} in ${u.stage}`).join(" and ")} before removing ${inUse.length === 1 ? "that stage" : "those stages"}.`);
      }
    }
    await mergeSettings(ctx.org.id, { leadStages: stages });
    await audit(ctx, { action: "crm.lead_stages_updated", category: "settings", summary: `${ctx.user.name} changed the lead stages`, meta: { stages } });
    return { leadStages: stages };
  });

  app.put("/api/crm/stages/deals", async (req) => {
    const ctx = await requireAccess(req, "crm", "manage");
    const { stages } = parseInput(stagesInput, req.body);
    checkStageNames(stages);
    const removed = dealStagesOf(ctx.org).filter((s) => !stages.includes(s));
    if (removed.length) {
      const inUse = await db.select({ stage: deals.stage, n: dsql<number>`count(*)::int` }).from(deals)
        .where(and(eq(deals.orgId, ctx.org.id), eq(deals.status, "open"), isNull(deals.deletedAt), inArray(deals.stage, removed))).groupBy(deals.stage);
      if (inUse.length) {
        throw conflict(`Move the ${inUse.map((u) => `${u.n} open deal${u.n === 1 ? "" : "s"} in ${u.stage}`).join(" and ")} before removing ${inUse.length === 1 ? "that stage" : "those stages"}.`);
      }
    }
    await mergeSettings(ctx.org.id, { dealStages: stages });
    await audit(ctx, { action: "crm.deal_stages_updated", category: "settings", summary: `${ctx.user.name} changed the deal stages`, meta: { stages } });
    return { dealStages: stages };
  });

  // ---------- companies ----------
  app.get<{ Querystring: { q?: string; status?: string; owner?: string } }>("/api/crm/companies", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const names = await memberNames(ctx.org.id);
    const conds = [eq(companies.orgId, ctx.org.id), isNull(companies.deletedAt)];
    const q = req.query.q?.trim();
    if (q) conds.push(or(ilike(companies.name, `%${q}%`), ilike(companies.industry, `%${q}%`), ilike(companies.location, `%${q}%`))!);
    if (req.query.status && ["prospect", "client", "former"].includes(req.query.status)) conds.push(eq(companies.status, req.query.status as "client"));
    if (req.query.owner && z.string().uuid().safeParse(req.query.owner).success) conds.push(eq(companies.ownerUserId, req.query.owner));
    const rows = await db.select({
      c: companies,
      openValue: dsql<string>`(select coalesce(sum(d.value),0) from deals d where d.company_id = "companies"."id" and d.status = 'open' and d.deleted_at is null)`,
      openDeals: dsql<number>`(select count(*)::int from deals d where d.company_id = "companies"."id" and d.status = 'open' and d.deleted_at is null)`,
      contactCount: dsql<number>`(select count(*)::int from contacts ct where ct.company_id = "companies"."id" and ct.deleted_at is null)`,
      primaryContact: dsql<string | null>`(select ct.name from contacts ct where ct.company_id = "companies"."id" and ct.deleted_at is null order by ct.is_primary desc, ct.created_at asc limit 1)`,
      lastActivityAt: dsql<string | null>`(select max(a.occurred_at) from activities a where a.company_id = "companies"."id" and a.deleted_at is null)`,
    }).from(companies).where(and(...conds)).orderBy(asc(companies.name)).limit(500);
    return rows.map((r) => ({
      ...companyView(r.c, names), openValue: num(r.openValue), openDeals: r.openDeals, contactCount: r.contactCount,
      primaryContact: r.primaryContact, lastActivityAt: r.lastActivityAt,
    }));
  });

  app.post("/api/crm/companies", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const input = parseInput(companyInput, req.body);
    await assertMember(ctx.org.id, input.ownerUserId);
    const [dup] = await db.select({ id: companies.id }).from(companies)
      .where(and(eq(companies.orgId, ctx.org.id), isNull(companies.deletedAt), dsql`lower(trim(${companies.name})) = lower(${input.name})`)).limit(1);
    if (dup) throw conflict(`${input.name} is already in your CRM.`, { name: "A company with this name already exists.", existingId: dup.id });
    const [c] = await db.insert(companies).values({
      orgId: ctx.org.id, name: input.name, industry: input.industry ?? null, location: input.location ?? null, website: input.website ?? null,
      notes: input.notes ?? null, status: input.status ?? "prospect", ownerUserId: input.ownerUserId ?? ctx.user.id,
    }).returning();
    await audit(ctx, { action: "crm.company_created", category: "data", entityType: "company", entityId: c!.id, summary: `${ctx.user.name} added ${c!.name}` });
    return companyView(c!, await memberNames(ctx.org.id));
  });

  app.get<{ Params: { id: string } }>("/api/crm/companies/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const orgId = ctx.org.id;
    const c = await getCompany(orgId, req.params.id);
    const names = await memberNames(orgId);
    const contactRows = await db.select().from(contacts).where(and(eq(contacts.companyId, c.id), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)))
      .orderBy(desc(contacts.isPrimary), asc(contacts.createdAt));
    const dealRows = await db.select().from(deals).where(and(eq(deals.companyId, c.id), eq(deals.orgId, orgId), isNull(deals.deletedAt)))
      .orderBy(dsql`case ${deals.status} when 'open' then 0 when 'won' then 1 else 2 end`, desc(deals.createdAt));
    const dealIds = dealRows.map((d) => d.id);
    const nextByDeal = await nextTasksFor(orgId, "deal", dealIds);
    const acts = await activityList(orgId, dealIds.length ? or(eq(activities.companyId, c.id), inArray(activities.dealId, dealIds)) : eq(activities.companyId, c.id), names);
    const fileRows = await db.select({ f: files, label: fileLinks.label, linkedAt: fileLinks.createdAt }).from(fileLinks)
      .innerJoin(files, eq(files.id, fileLinks.fileId))
      .where(and(eq(fileLinks.orgId, orgId), eq(fileLinks.linkType, "company"), eq(fileLinks.linkId, c.id), isNull(files.deletedAt)))
      .orderBy(desc(fileLinks.createdAt));
    const taskConds = dealIds.length
      ? or(and(eq(tasks.linkType, "company"), eq(tasks.linkId, c.id)), and(eq(tasks.linkType, "deal"), inArray(tasks.linkId, dealIds)))
      : and(eq(tasks.linkType, "company"), eq(tasks.linkId, c.id));
    const taskRows = await db.select().from(tasks).where(and(openCrmTasks(orgId), taskConds))
      .orderBy(dsql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt));
    const followUps = await followUpViews(orgId, taskRows, names);
    const contactNames = new Map(contactRows.map((x) => [x.id, x.name]));
    return {
      company: companyView(c, names),
      contacts: contactRows.map(contactView),
      deals: dealRows.map((d) => dealView(d, names, { companyName: c.name, contactName: d.contactId ? contactNames.get(d.contactId) : null, nextTask: nextByDeal.get(d.id) ?? null })),
      activities: acts,
      files: fileRows.map((r) => ({ ...fileView(r.f), label: r.label, linkedAt: r.linkedAt })),
      followUps,
      nextFollowUp: followUps[0] ?? null,
    };
  });

  app.patch<{ Params: { id: string } }>("/api/crm/companies/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const c = await getCompany(ctx.org.id, req.params.id);
    const input = parseInput(companyInput.partial(), req.body);
    await assertMember(ctx.org.id, input.ownerUserId);
    if (input.name && input.name.toLowerCase() !== c.name.trim().toLowerCase()) {
      const [dup] = await db.select({ id: companies.id }).from(companies)
        .where(and(eq(companies.orgId, ctx.org.id), isNull(companies.deletedAt), ne(companies.id, c.id), dsql`lower(trim(${companies.name})) = lower(${input.name})`)).limit(1);
      if (dup) throw conflict(`${input.name} is already in your CRM.`, { name: "A company with this name already exists." });
    }
    const [u] = await db.update(companies).set({ ...input, version: bump(companies.version) }).where(eq(companies.id, c.id)).returning();
    if (input.status && input.status !== c.status) {
      await audit(ctx, { action: "crm.company_status", category: "data", entityType: "company", entityId: c.id, summary: `${ctx.user.name} marked ${c.name} as ${input.status}` });
    }
    return companyView(u!, await memberNames(ctx.org.id));
  });

  app.delete<{ Params: { id: string } }>("/api/crm/companies/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "manage");
    const c = await getCompany(ctx.org.id, req.params.id);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(companies).set({ deletedAt: now, version: bump(companies.version) }).where(eq(companies.id, c.id));
      await tx.update(contacts).set({ deletedAt: now, version: bump(contacts.version) }).where(and(eq(contacts.companyId, c.id), isNull(contacts.deletedAt)));
      await tx.update(deals).set({ deletedAt: now, version: bump(deals.version) }).where(and(eq(deals.companyId, c.id), isNull(deals.deletedAt)));
      await audit(ctx, { action: "crm.company_deleted", category: "data", entityType: "company", entityId: c.id, summary: `${ctx.user.name} deleted ${c.name}` }, tx);
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; fileId: string } }>("/api/crm/companies/:id/files/:fileId", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const c = await getCompany(ctx.org.id, req.params.id);
    if (!z.string().uuid().safeParse(req.params.fileId).success) throw notFound("That file");
    await db.delete(fileLinks).where(and(eq(fileLinks.orgId, ctx.org.id), eq(fileLinks.linkType, "company"), eq(fileLinks.linkId, c.id), eq(fileLinks.fileId, req.params.fileId)));
    return { ok: true };
  });

  // ---------- contacts ----------
  app.post<{ Params: { id: string } }>("/api/crm/companies/:id/contacts", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const c = await getCompany(ctx.org.id, req.params.id);
    const input = parseInput(contactInput, req.body);
    const row = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: dsql<number>`count(*)::int` }).from(contacts).where(and(eq(contacts.companyId, c.id), isNull(contacts.deletedAt))) as [{ n: number }];
      const primary = input.isPrimary || n === 0;
      if (primary) await tx.update(contacts).set({ isPrimary: false }).where(and(eq(contacts.companyId, c.id), eq(contacts.isPrimary, true)));
      const [r] = await tx.insert(contacts).values({
        orgId: ctx.org.id, companyId: c.id, name: input.name, role: input.role ?? null, email: input.email ?? null, phone: input.phone ?? null, isPrimary: primary,
      }).returning();
      return r!;
    });
    return contactView(row);
  });

  app.patch<{ Params: { id: string } }>("/api/crm/contacts/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const ct = await getContact(ctx.org.id, req.params.id);
    const input = parseInput(contactInput.partial(), req.body);
    const row = await db.transaction(async (tx) => {
      if (input.isPrimary && ct.companyId) {
        await tx.update(contacts).set({ isPrimary: false }).where(and(eq(contacts.companyId, ct.companyId), eq(contacts.isPrimary, true)));
      }
      const [r] = await tx.update(contacts).set({ ...input, version: bump(contacts.version) }).where(eq(contacts.id, ct.id)).returning();
      return r!;
    });
    return contactView(row);
  });

  app.delete<{ Params: { id: string } }>("/api/crm/contacts/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const ct = await getContact(ctx.org.id, req.params.id);
    await db.transaction(async (tx) => {
      await tx.update(contacts).set({ deletedAt: new Date(), isPrimary: false, version: bump(contacts.version) }).where(eq(contacts.id, ct.id));
      if (ct.isPrimary && ct.companyId) {
        const [next] = await tx.select({ id: contacts.id }).from(contacts)
          .where(and(eq(contacts.companyId, ct.companyId), isNull(contacts.deletedAt))).orderBy(asc(contacts.createdAt)).limit(1);
        if (next) await tx.update(contacts).set({ isPrimary: true }).where(eq(contacts.id, next.id));
      }
    });
    return { ok: true };
  });

  // ---------- leads ----------
  app.get<{ Querystring: { q?: string; owner?: string; source?: string } }>("/api/crm/leads", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const orgId = ctx.org.id;
    const names = await memberNames(orgId);
    const stages = leadStagesOf(ctx.org);
    const monthStart = startOfMonth();
    const conds = [eq(leads.orgId, orgId), isNull(leads.deletedAt), or(ne(leads.stage, CLOSED), gte(leads.closedAt, monthStart))!];
    const q = req.query.q?.trim();
    if (q) conds.push(or(ilike(leads.companyName, `%${q}%`), ilike(leads.contactName, `%${q}%`), ilike(leads.email, `%${q}%`))!);
    if (req.query.owner === "none") conds.push(isNull(leads.ownerUserId));
    else if (req.query.owner && z.string().uuid().safeParse(req.query.owner).success) conds.push(eq(leads.ownerUserId, req.query.owner));
    if (req.query.source) conds.push(eq(leads.source, req.query.source));
    const rows = await db.select().from(leads).where(and(...conds))
      .orderBy(dsql`${leads.nextStepDue} asc nulls last`, desc(leads.createdAt)).limit(1000);

    const ids = rows.map((r) => r.id);
    const lastActs = ids.length
      ? await db.selectDistinctOn([activities.leadId], { leadId: activities.leadId, type: activities.type, occurredAt: activities.occurredAt })
        .from(activities).where(and(inArray(activities.leadId, ids), isNull(activities.deletedAt)))
        .orderBy(activities.leadId, desc(activities.occurredAt))
      : [];
    const lastMap = new Map(lastActs.map((a) => [a.leadId!, { type: a.type, occurredAt: a.occurredAt }]));

    // Stats are org-wide (not filtered) so they stay stable while searching.
    const weekAgo = new Date(Date.now() - 7 * DAY);
    const since90 = new Date(Date.now() - 90 * DAY);
    const last = stages[stages.length - 1]!;
    const [s] = await db.select({
      active: dsql<number>`count(*) filter (where ${leads.stage} <> ${CLOSED})::int`,
      notContacted: dsql<number>`count(*) filter (where ${leads.stage} = ${stages[0]!})::int`,
      ready: dsql<number>`count(*) filter (where ${leads.stage} = ${last})::int`,
      readyValue: dsql<string>`coalesce(sum(${leads.estimatedValue}) filter (where ${leads.stage} = ${last}),0)`,
      converted90: dsql<number>`count(*) filter (where ${leads.closedOutcome} = 'converted' and ${leads.closedAt} >= ${since90.toISOString()}::timestamptz)::int`,
      closed90: dsql<number>`count(*) filter (where ${leads.stage} = ${CLOSED} and ${leads.closedAt} >= ${since90.toISOString()}::timestamptz)::int`,
    }).from(leads).where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt)));
    const [contacted] = await db.select({
      leads: dsql<number>`count(distinct ${activities.leadId})::int`, people: dsql<number>`count(distinct ${activities.authorUserId})::int`,
    }).from(activities).where(and(eq(activities.orgId, orgId), isNotNull(activities.leadId), gte(activities.occurredAt, weekAgo), isNull(activities.deletedAt)));
    const sources = await db.selectDistinct({ source: leads.source }).from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), isNotNull(leads.source))).orderBy(asc(leads.source));

    return {
      stages,
      items: rows.map((l) => leadView(l, names, lastMap.get(l.id))),
      stats: {
        active: s?.active ?? 0, notContacted: s?.notContacted ?? 0, ready: s?.ready ?? 0, readyValue: num(s?.readyValue),
        contactedThisWeek: contacted?.leads ?? 0, contactedBy: contacted?.people ?? 0,
        conversionRate: s?.closed90 ? Math.round(((s.converted90 ?? 0) / s.closed90) * 100) : null,
      },
      sources: sources.map((x) => x.source!).filter(Boolean),
    };
  });

  app.get<{ Params: { id: string } }>("/api/crm/leads/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const l = await getLead(ctx.org.id, req.params.id);
    const names = await memberNames(ctx.org.id);
    const acts = await activityList(ctx.org.id, eq(activities.leadId, l.id), names);
    const taskRows = await db.select().from(tasks).where(and(openCrmTasks(ctx.org.id), eq(tasks.linkType, "lead"), eq(tasks.linkId, l.id)))
      .orderBy(dsql`${tasks.dueAt} asc nulls last`);
    return { lead: leadView(l, names, acts[0] ? { type: acts[0].type, occurredAt: acts[0].occurredAt } : null), activities: acts, followUps: await followUpViews(ctx.org.id, taskRows, names) };
  });

  app.post("/api/crm/leads", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const input = parseInput(leadInput, req.body);
    await assertMember(ctx.org.id, input.ownerUserId);
    const stages = leadStagesOf(ctx.org);
    const stage = input.stage || stages[0]!;
    if (!stages.includes(stage)) throw badRequest("Some details need fixing.", { stage: "Choose one of your lead stages." });
    const [l] = await db.insert(leads).values({
      orgId: ctx.org.id, companyName: input.companyName, contactName: input.contactName ?? null, contactRole: input.contactRole ?? null,
      email: input.email ?? null, phone: input.phone ?? null, source: input.source ?? null, stage,
      ownerUserId: input.ownerUserId === undefined ? ctx.user.id : input.ownerUserId,
      estimatedValue: input.estimatedValue != null ? String(input.estimatedValue) : null,
      nextStep: input.nextStep ?? null, nextStepDue: input.nextStepDue ?? null,
    }).returning();
    await audit(ctx, { action: "crm.lead_created", category: "data", entityType: "lead", entityId: l!.id, summary: `${ctx.user.name} added the lead ${l!.companyName}` });
    return leadView(l!, await memberNames(ctx.org.id));
  });

  app.patch<{ Params: { id: string } }>("/api/crm/leads/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const l = await getLead(ctx.org.id, req.params.id);
    const input = parseInput(leadInput.partial().extend({ qualification: qualificationInput.optional() }), req.body);
    await assertMember(ctx.org.id, input.ownerUserId);
    if (input.stage !== undefined && input.stage !== l.stage) throw badRequest("Use Move to change the stage.", { stage: "Use Move to change the stage." });
    const { estimatedValue, qualification, stage: _s, ...rest } = input;
    const [u] = await db.update(leads).set({
      ...rest,
      ...(estimatedValue !== undefined ? { estimatedValue: estimatedValue === null ? null : String(estimatedValue) } : {}),
      ...(qualification ? { qualification: { ...l.qualification, ...qualification, notes: { ...(l.qualification.notes ?? {}), ...(qualification.notes ?? {}) } } } : {}),
      version: bump(leads.version),
    }).where(eq(leads.id, l.id)).returning();
    return leadView(u!, await memberNames(ctx.org.id));
  });

  app.put<{ Params: { id: string } }>("/api/crm/leads/:id/qualification", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const l = await getLead(ctx.org.id, req.params.id);
    const q = parseInput(qualificationInput, req.body);
    const merged: LeadQualification = { ...l.qualification, ...q, notes: { ...(l.qualification.notes ?? {}), ...(q.notes ?? {}) } };
    const [u] = await db.update(leads).set({ qualification: merged, version: bump(leads.version) }).where(eq(leads.id, l.id)).returning();
    return leadView(u!, await memberNames(ctx.org.id));
  });

  app.post<{ Params: { id: string } }>("/api/crm/leads/:id/move", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const l = await getLead(ctx.org.id, req.params.id);
    const { stage } = parseInput(z.object({ stage: reqText("a stage", 60) }), req.body);
    const stages = leadStagesOf(ctx.org);
    if (!stages.includes(stage)) throw badRequest("Choose one of your lead stages.", { stage: "Choose one of your lead stages." });
    if (l.closedOutcome === "converted") throw conflict("This lead has already been converted to a client.");
    if (l.stage === stage) return leadView(l, await memberNames(ctx.org.id));
    const [u] = await db.update(leads).set({
      stage, closedOutcome: null, closedReason: null, closedAt: null, version: bump(leads.version),
    }).where(eq(leads.id, l.id)).returning();
    await audit(ctx, { action: "crm.lead_moved", category: "data", entityType: "lead", entityId: l.id, summary: `${ctx.user.name} moved ${l.companyName} from ${l.stage} to ${stage}`, meta: { from: l.stage, to: stage } });
    return leadView(u!, await memberNames(ctx.org.id));
  });

  app.post<{ Params: { id: string } }>("/api/crm/leads/:id/close", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const l = await getLead(ctx.org.id, req.params.id);
    const { reason } = parseInput(z.object({ reason: reqText("a reason", 300) }), req.body);
    if (l.stage === CLOSED) throw conflict("This lead is already closed.");
    const [u] = await db.update(leads).set({
      stage: CLOSED, closedOutcome: "not_interested", closedReason: reason, closedAt: new Date(), version: bump(leads.version),
    }).where(eq(leads.id, l.id)).returning();
    await audit(ctx, { action: "crm.lead_closed", category: "data", entityType: "lead", entityId: l.id, summary: `${ctx.user.name} closed ${l.companyName} as not interested`, meta: { reason } });
    return leadView(u!, await memberNames(ctx.org.id));
  });

  app.delete<{ Params: { id: string } }>("/api/crm/leads/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "manage");
    const l = await getLead(ctx.org.id, req.params.id);
    await db.update(leads).set({ deletedAt: new Date(), version: bump(leads.version) }).where(eq(leads.id, l.id));
    await audit(ctx, { action: "crm.lead_deleted", category: "data", entityType: "lead", entityId: l.id, summary: `${ctx.user.name} deleted the lead ${l.companyName}` });
    return { ok: true };
  });

  async function findCompanyByName(orgId: string, name: string) {
    const [row] = await db.select({
      id: companies.id, name: companies.name, createdAt: companies.createdAt,
      contactCount: dsql<number>`(select count(*)::int from contacts ct where ct.company_id = "companies"."id" and ct.deleted_at is null)`,
    }).from(companies)
      .where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt), dsql`lower(trim(${companies.name})) = lower(trim(${name}))`))
      .orderBy(asc(companies.createdAt)).limit(1);
    return row ?? null;
  }

  app.get<{ Params: { id: string } }>("/api/crm/leads/:id/convert-preview", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const l = await getLead(ctx.org.id, req.params.id);
    return { existingCompany: await findCompanyByName(ctx.org.id, l.companyName), dealStages: dealStagesOf(ctx.org) };
  });

  app.post<{ Params: { id: string } }>("/api/crm/leads/:id/convert", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const lead0 = await getLead(ctx.org.id, req.params.id);
    const input = parseInput(z.object({
      useExistingCompanyId: optUuid,
      contact: z.object({
        name: optText(160), role: optText(120), phone: optText(40),
        email: optEmail,
      }).optional(),
      deal: z.object({ name: reqText("a deal name", 160), value: optMoney, stage: z.string().trim().max(60).optional() }),
    }), req.body);
    const stages = dealStagesOf(ctx.org);
    const stage = input.deal.stage || stages[0]!;
    if (!stages.includes(stage)) throw badRequest("Some details need fixing.", { "deal.stage": "Choose one of your deal stages." });

    const result = await db.transaction(async (tx) => {
      // Lock the lead so two quick clicks can't convert it twice.
      const [lead] = await tx.select().from(leads).where(eq(leads.id, lead0.id)).for("update");
      if (!lead || lead.deletedAt) throw notFound("That lead");
      if (lead.closedOutcome === "converted" || lead.convertedDealId) throw conflict("This lead has already been converted to a client.");
      if (lead.closedOutcome === "not_interested") throw conflict("This lead was closed as not interested. Move it back to a stage first.");

      let company: typeof companies.$inferSelect;
      let createdCompany = false;
      if (input.useExistingCompanyId) {
        company = await getCompany(ctx.org.id, input.useExistingCompanyId, tx);
      } else {
        const [c] = await tx.insert(companies).values({
          orgId: ctx.org.id, name: lead.companyName.trim(), status: "prospect", ownerUserId: lead.ownerUserId ?? ctx.user.id,
        }).returning();
        company = c!;
        createdCompany = true;
      }

      const contactName = (input.contact?.name ?? lead.contactName)?.trim() || null;
      const contactEmail = input.contact ? (input.contact.email ?? null) : lead.email;
      let contactId: string | null = null;
      if (contactName) {
        const existing = await tx.select().from(contacts).where(and(eq(contacts.companyId, company.id), isNull(contacts.deletedAt)));
        const same = existing.find((x) => (contactEmail && x.email && x.email.toLowerCase() === contactEmail.toLowerCase())
          || (!contactEmail && x.name.trim().toLowerCase() === contactName.toLowerCase()));
        if (same) contactId = same.id;
        else {
          const [ct] = await tx.insert(contacts).values({
            orgId: ctx.org.id, companyId: company.id, name: contactName,
            role: (input.contact ? input.contact.role : lead.contactRole) ?? null,
            email: contactEmail ?? null, phone: (input.contact ? input.contact.phone : lead.phone) ?? null,
            isPrimary: existing.length === 0,
          }).returning();
          contactId = ct!.id;
        }
      }

      const value = input.deal.value ?? numOrNull(lead.estimatedValue) ?? 0;
      const [deal] = await tx.insert(deals).values({
        orgId: ctx.org.id, companyId: company.id, contactId, name: input.deal.name, value: String(value), currency: ctx.org.currency,
        stage, ownerUserId: lead.ownerUserId ?? ctx.user.id, nextStep: lead.nextStep,
      }).returning();

      await tx.update(leads).set({
        stage: CLOSED, closedOutcome: "converted", closedAt: new Date(), convertedCompanyId: company.id, convertedDealId: deal!.id,
        version: bump(leads.version),
      }).where(eq(leads.id, lead.id));
      // Keep the lead's history visible on the company page.
      await tx.update(activities).set({ companyId: company.id }).where(and(eq(activities.leadId, lead.id), isNull(activities.companyId)));

      await audit(ctx, {
        action: "crm.lead_converted", category: "data", entityType: "lead", entityId: lead.id,
        summary: `${ctx.user.name} converted ${lead.companyName} to a client${createdCompany ? "" : ` (added to the existing ${company.name})`} with the deal ${deal!.name}`,
        meta: { companyId: company.id, dealId: deal!.id, contactId, reusedCompany: !createdCompany },
      }, tx);
      return { companyId: company.id, dealId: deal!.id, contactId, createdCompany };
    });
    return result;
  });

  // ---------- deals ----------
  app.get<{ Querystring: { q?: string; owner?: string } }>("/api/crm/deals", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const orgId = ctx.org.id;
    const names = await memberNames(orgId);
    const conds = [eq(deals.orgId, orgId), isNull(deals.deletedAt), or(eq(deals.status, "open"), and(eq(deals.status, "won"), gte(deals.wonAt, startOfMonth())))!];
    const q = req.query.q?.trim();
    if (q) conds.push(or(ilike(deals.name, `%${q}%`), ilike(companies.name, `%${q}%`))!);
    if (req.query.owner && z.string().uuid().safeParse(req.query.owner).success) conds.push(eq(deals.ownerUserId, req.query.owner));
    const rows = await db.select({ d: deals, companyName: companies.name, contactName: contacts.name }).from(deals)
      .innerJoin(companies, eq(companies.id, deals.companyId)).leftJoin(contacts, eq(contacts.id, deals.contactId))
      .where(and(...conds)).orderBy(desc(deals.value), desc(deals.createdAt)).limit(1000);
    const next = await nextTasksFor(orgId, "deal", rows.map((r) => r.d.id));
    return {
      stages: dealStagesOf(ctx.org),
      items: rows.map((r) => dealView(r.d, names, { companyName: r.companyName, contactName: r.contactName, nextTask: next.get(r.d.id) ?? null })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/crm/deals/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const d = await getDeal(ctx.org.id, req.params.id);
    const names = await memberNames(ctx.org.id);
    const [c] = await db.select().from(companies).where(eq(companies.id, d.companyId)).limit(1);
    const ct = d.contactId ? (await db.select().from(contacts).where(eq(contacts.id, d.contactId)).limit(1))[0] : null;
    const companyContacts = await db.select().from(contacts).where(and(eq(contacts.companyId, d.companyId), isNull(contacts.deletedAt))).orderBy(desc(contacts.isPrimary));
    const acts = await activityList(ctx.org.id, eq(activities.dealId, d.id), names);
    const taskRows = await db.select().from(tasks).where(and(openCrmTasks(ctx.org.id), eq(tasks.linkType, "deal"), eq(tasks.linkId, d.id)))
      .orderBy(dsql`${tasks.dueAt} asc nulls last`);
    const followUps = await followUpViews(ctx.org.id, taskRows, names);
    return {
      deal: dealView(d, names, { companyName: c?.name, contactName: ct?.name ?? null, nextTask: followUps[0] ? { id: followUps[0].id, title: followUps[0].title, dueAt: followUps[0].dueAt } : null }),
      contacts: companyContacts.map(contactView), activities: acts, followUps,
    };
  });

  app.post("/api/crm/deals", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const input = parseInput(dealInput, req.body);
    await assertMember(ctx.org.id, input.ownerUserId);
    const stages = dealStagesOf(ctx.org);
    const stage = input.stage || stages[0]!;
    if (!stages.includes(stage)) throw badRequest("Some details need fixing.", { stage: "Choose one of your deal stages." });
    if (!input.companyId && !input.newCompany) throw badRequest("Some details need fixing.", { companyId: "Choose a company or add a new one." });
    const row = await db.transaction(async (tx) => {
      let companyId = input.companyId ?? null;
      if (companyId) await getCompany(ctx.org.id, companyId, tx);
      else {
        const name = input.newCompany!.name;
        const [dup] = await tx.select({ id: companies.id }).from(companies)
          .where(and(eq(companies.orgId, ctx.org.id), isNull(companies.deletedAt), dsql`lower(trim(${companies.name})) = lower(${name})`)).limit(1);
        if (dup) throw conflict(`${name} is already in your CRM. Choose it from the list.`, { "newCompany.name": "This company already exists.", existingId: dup.id });
        const [c] = await tx.insert(companies).values({
          orgId: ctx.org.id, name, industry: input.newCompany!.industry ?? null, location: input.newCompany!.location ?? null, ownerUserId: input.ownerUserId ?? ctx.user.id,
        }).returning();
        companyId = c!.id;
      }
      if (input.contactId) {
        const ct = await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.companyId, companyId), isNull(contacts.deletedAt))).limit(1);
        if (!ct.length) throw badRequest("Some details need fixing.", { contactId: "Choose a contact at this company." });
      }
      const [d] = await tx.insert(deals).values({
        orgId: ctx.org.id, companyId, contactId: input.contactId ?? null, name: input.name, value: String(input.value ?? 0), currency: ctx.org.currency,
        stage, expectedCloseOn: input.expectedCloseOn ?? null, ownerUserId: input.ownerUserId ?? ctx.user.id, nextStep: input.nextStep ?? null,
      }).returning();
      await audit(ctx, { action: "crm.deal_created", category: "data", entityType: "deal", entityId: d!.id, summary: `${ctx.user.name} added the deal ${d!.name}` }, tx);
      return d!;
    });
    return dealView(row, await memberNames(ctx.org.id));
  });

  app.patch<{ Params: { id: string } }>("/api/crm/deals/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const d = await getDeal(ctx.org.id, req.params.id);
    const input = parseInput(dealInput.omit({ companyId: true, newCompany: true, stage: true }).partial(), req.body);
    await assertMember(ctx.org.id, input.ownerUserId);
    if (input.contactId) {
      const ct = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.companyId, d.companyId), isNull(contacts.deletedAt))).limit(1);
      if (!ct.length) throw badRequest("Some details need fixing.", { contactId: "Choose a contact at this company." });
    }
    const { value, ...rest } = input;
    const [u] = await db.update(deals).set({
      ...rest, ...(value !== undefined ? { value: String(value ?? 0) } : {}), version: bump(deals.version),
    }).where(eq(deals.id, d.id)).returning();
    return dealView(u!, await memberNames(ctx.org.id));
  });

  app.post<{ Params: { id: string } }>("/api/crm/deals/:id/move", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const d = await getDeal(ctx.org.id, req.params.id);
    const { stage } = parseInput(z.object({ stage: reqText("a stage", 60) }), req.body);
    if (!dealStagesOf(ctx.org).includes(stage)) throw badRequest("Choose one of your deal stages.", { stage: "Choose one of your deal stages." });
    if (d.status !== "open") throw conflict("Reopen this deal before moving it.");
    if (d.stage === stage) return dealView(d, await memberNames(ctx.org.id));
    const [u] = await db.update(deals).set({ stage, version: bump(deals.version) }).where(eq(deals.id, d.id)).returning();
    await audit(ctx, { action: "crm.deal_moved", category: "data", entityType: "deal", entityId: d.id, summary: `${ctx.user.name} moved ${d.name} from ${d.stage} to ${stage}`, meta: { from: d.stage, to: stage } });
    return dealView(u!, await memberNames(ctx.org.id));
  });

  app.post<{ Params: { id: string } }>("/api/crm/deals/:id/won", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const d = await getDeal(ctx.org.id, req.params.id);
    if (d.status === "won") throw conflict("This deal is already won.");
    const row = await db.transaction(async (tx) => {
      const [u] = await tx.update(deals).set({ status: "won", wonAt: new Date(), lostAt: null, lostReason: null, version: bump(deals.version) })
        .where(eq(deals.id, d.id)).returning();
      await tx.update(companies).set({ status: "client", version: bump(companies.version) }).where(and(eq(companies.id, d.companyId), ne(companies.status, "client")));
      await audit(ctx, { action: "crm.deal_won", category: "data", entityType: "deal", entityId: d.id, summary: `${ctx.user.name} marked ${d.name} as won`, meta: { value: num(d.value) } }, tx);
      return u!;
    });
    return dealView(row, await memberNames(ctx.org.id));
  });

  app.post<{ Params: { id: string } }>("/api/crm/deals/:id/lost", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const d = await getDeal(ctx.org.id, req.params.id);
    const { reason } = parseInput(z.object({ reason: reqText("a reason", 300) }), req.body);
    if (d.status === "lost") throw conflict("This deal is already marked as lost.");
    const [u] = await db.update(deals).set({ status: "lost", lostAt: new Date(), lostReason: reason, wonAt: null, version: bump(deals.version) })
      .where(eq(deals.id, d.id)).returning();
    await audit(ctx, { action: "crm.deal_lost", category: "data", entityType: "deal", entityId: d.id, summary: `${ctx.user.name} marked ${d.name} as lost`, meta: { reason } });
    return dealView(u!, await memberNames(ctx.org.id));
  });

  app.post<{ Params: { id: string } }>("/api/crm/deals/:id/reopen", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const d = await getDeal(ctx.org.id, req.params.id);
    if (d.status === "open") throw conflict("This deal is already open.");
    const stages = dealStagesOf(ctx.org);
    const { stage } = parseInput(z.object({ stage: z.string().trim().max(60).optional() }), req.body);
    const target = stage && stages.includes(stage) ? stage : stages.includes(d.stage) ? d.stage : stages[stages.length - 1]!;
    const [u] = await db.update(deals).set({ status: "open", stage: target, wonAt: null, lostAt: null, lostReason: null, version: bump(deals.version) })
      .where(eq(deals.id, d.id)).returning();
    await audit(ctx, { action: "crm.deal_reopened", category: "data", entityType: "deal", entityId: d.id, summary: `${ctx.user.name} reopened ${d.name}` });
    return dealView(u!, await memberNames(ctx.org.id));
  });

  app.delete<{ Params: { id: string } }>("/api/crm/deals/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "manage");
    const d = await getDeal(ctx.org.id, req.params.id);
    await db.update(deals).set({ deletedAt: new Date(), version: bump(deals.version) }).where(eq(deals.id, d.id));
    await audit(ctx, { action: "crm.deal_deleted", category: "data", entityType: "deal", entityId: d.id, summary: `${ctx.user.name} deleted the deal ${d.name}` });
    return { ok: true };
  });

  // ---------- activities ----------
  /** Resolves a link target and returns the task link fields for a follow-up. */
  async function resolveTarget(orgId: string, t: { companyId?: string | null; dealId?: string | null; leadId?: string | null }) {
    if (t.dealId) {
      const d = await getDeal(orgId, t.dealId);
      const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, d.companyId)).limit(1);
      return { companyId: d.companyId, dealId: d.id, leadId: null, linkType: "deal", linkId: d.id, linkLabel: `${c?.name ?? "Deal"} · ${d.name}` };
    }
    if (t.leadId) {
      const l = await getLead(orgId, t.leadId);
      return { companyId: l.convertedCompanyId, dealId: null, leadId: l.id, linkType: "lead", linkId: l.id, linkLabel: `${l.companyName} · lead` };
    }
    if (t.companyId) {
      const c = await getCompany(orgId, t.companyId);
      return { companyId: c.id, dealId: null, leadId: null, linkType: "company", linkId: c.id, linkLabel: c.name };
    }
    throw badRequest("Choose a company, deal or lead for this.", { companyId: "Choose a company, deal or lead." });
  }

  app.post("/api/crm/activities", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const input = parseInput(activityInput, req.body);
    if (!input.subject && !input.body) throw badRequest("Some details need fixing.", { body: "Write something first." });
    const target = await resolveTarget(ctx.org.id, input);
    if (input.contactId) await getContact(ctx.org.id, input.contactId);
    if (input.followUp) await assertMember(ctx.org.id, input.followUp.assigneeUserId, "followUp.assigneeUserId");
    const out = await db.transaction(async (tx) => {
      const [a] = await tx.insert(activities).values({
        orgId: ctx.org.id, companyId: target.companyId, dealId: target.dealId, leadId: target.leadId, contactId: input.contactId ?? null,
        type: input.type, subject: input.subject ?? null, body: input.body ?? null, occurredAt: input.occurredAt ?? new Date(),
        durationMinutes: input.durationMinutes != null ? String(input.durationMinutes) : null, authorUserId: ctx.user.id,
      }).returning();
      let task = null;
      if (input.followUp) {
        task = await createTask({
          orgId: ctx.org.id, title: input.followUp.title, workspace: "crm", assigneeUserId: input.followUp.assigneeUserId ?? ctx.user.id,
          createdBy: ctx.user.id, dueAt: input.followUp.dueAt ?? null, linkType: target.linkType, linkId: target.linkId, linkLabel: target.linkLabel,
        }, tx);
      }
      return { activity: a!, task };
    });
    return { id: out.activity.id, taskId: out.task?.id ?? null };
  });

  app.delete<{ Params: { id: string } }>("/api/crm/activities/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That activity");
    const [a] = await db.select().from(activities).where(and(eq(activities.id, req.params.id), eq(activities.orgId, ctx.org.id), isNull(activities.deletedAt))).limit(1);
    if (!a) throw notFound("That activity");
    if (a.authorUserId !== ctx.user.id && ctx.access.crm !== "manage") throw badRequest("Only the person who wrote this can delete it.");
    await db.update(activities).set({ deletedAt: new Date(), version: bump(activities.version) }).where(eq(activities.id, a.id));
    return { ok: true };
  });

  // ---------- follow-ups ----------
  app.get<{ Querystring: { assignee?: string; tz?: string } }>("/api/crm/follow-ups", async (req) => {
    const ctx = await requireAccess(req, "crm", "view");
    const orgId = ctx.org.id;
    const names = await memberNames(orgId);
    const tz = tzOf(req.query);
    const conds = [openCrmTasks(orgId)];
    if (req.query.assignee !== "all") conds.push(eq(tasks.assigneeUserId, ctx.user.id));
    const rows = await db.select().from(tasks).where(and(...conds)).orderBy(dsql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt)).limit(500);
    const items = await followUpViews(orgId, rows, names);
    const today = dayStart(tz), tomorrow = dayStart(tz, 1), week = dayStart(tz, 7);
    const groups = { overdue: [] as typeof items, today: [] as typeof items, week: [] as typeof items, later: [] as typeof items };
    for (const t of items) {
      const due = t.dueAt;
      if (!due) groups.later.push(t);
      else if (due < today) groups.overdue.push(t);
      else if (due < tomorrow) groups.today.push(t);
      else if (due < week) groups.week.push(t);
      else groups.later.push(t);
    }
    return { ...groups, total: items.length };
  });

  app.post("/api/crm/follow-ups", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const input = parseInput(followUpInput.extend({ companyId: optUuid, dealId: optUuid, leadId: optUuid, description: optText(2000) }), req.body);
    const target = await resolveTarget(ctx.org.id, input);
    await assertMember(ctx.org.id, input.assigneeUserId, "assigneeUserId");
    const t = await createTask({
      orgId: ctx.org.id, title: input.title, description: input.description ?? null, workspace: "crm",
      assigneeUserId: input.assigneeUserId ?? ctx.user.id, createdBy: ctx.user.id, dueAt: input.dueAt ?? null,
      linkType: target.linkType, linkId: target.linkId, linkLabel: target.linkLabel,
    });
    return { id: t.id };
  });

  async function getCrmTask(orgId: string, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("That follow-up");
    const [t] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.orgId, orgId), eq(tasks.workspace, "crm"), isNull(tasks.deletedAt))).limit(1);
    if (!t) throw notFound("That follow-up");
    return t;
  }

  app.post<{ Params: { id: string } }>("/api/crm/follow-ups/:id/done", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const t = await getCrmTask(ctx.org.id, req.params.id);
    if (t.status === "done") return { ok: true };
    await db.update(tasks).set({ status: "done", completedAt: new Date(), completedBy: ctx.user.id, version: bump(tasks.version) }).where(eq(tasks.id, t.id));
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/crm/follow-ups/:id", async (req) => {
    const ctx = await requireAccess(req, "crm", "edit");
    const t = await getCrmTask(ctx.org.id, req.params.id);
    const input = parseInput(followUpInput.partial(), req.body);
    await assertMember(ctx.org.id, input.assigneeUserId, "assigneeUserId");
    await db.update(tasks).set({ ...input, version: bump(tasks.version) }).where(eq(tasks.id, t.id));
    return { ok: true };
  });
}
