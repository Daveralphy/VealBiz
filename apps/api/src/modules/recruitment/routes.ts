import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_RECRUITMENT_STAGES, slugify } from "@windveal/shared";
import { db, type Tx } from "../../db/client";
import {
  applicationStageHistory, applications, candidateNotes, candidates, departments, employees, employmentHistory, fileLinks, files,
  interviews, jobs, memberships, scorecards, users, type JobQuestion,
} from "../../db/schema";
import { requireAccess, type OrgContext } from "../../lib/context";
import { badRequest, conflict, forbidden, iso, notFound, parse } from "../../lib/http";
import { audit, notify } from "../../lib/audit";
import { startChecklist } from "../../lib/tasks";
import { env } from "../../env";

export const SCORE_CRITERIA = ["Skills and knowledge", "Attention to detail", "Communication", "Fit with the team"] as const;
const DAY = 86_400_000;

type Job = typeof jobs.$inferSelect;
type Application = typeof applications.$inferSelect;
type Org = OrgContext["org"];

// ---------------- validation ----------------
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const money = z.union([z.number(), z.string()]).optional().nullable().transform((v, c) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) { c.addIssue({ code: "custom", message: "Enter a valid amount" }); return z.NEVER; }
  return n;
});

const questionInput = z.object({
  id: z.string().trim().max(64).optional(),
  label: z.string().trim().min(2, "Enter the question").max(300),
  type: z.enum(["text", "choice", "yesno", "number"]),
  options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  required: z.boolean().default(false),
}).superRefine((q, c) => {
  if (q.type === "choice" && (q.options?.length ?? 0) < 2) c.addIssue({ code: "custom", path: ["options"], message: "Add at least two options" });
});

const jobInput = z.object({
  title: z.string().trim().min(2, "Enter a job title").max(120),
  departmentId: z.string().uuid().optional().nullable(),
  location: optText(120),
  employmentType: optText(80),
  salaryMin: money,
  salaryMax: money,
  salaryPeriod: z.enum(["hour", "day", "week", "month", "year"]).optional().default("month"),
  showSalary: z.boolean().optional().default(false),
  description: optText(20_000),
  applyBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date").optional().nullable().or(z.literal("").transform(() => null)),
  hiringManagerUserId: z.string().uuid().optional().nullable(),
  hiringTeamUserIds: z.array(z.string().uuid()).max(30).optional().default([]),
  stages: z.array(z.string().trim().min(1, "Stage names can't be empty").max(40)).min(2, "Keep at least two stages").max(12).optional(),
  questions: z.array(questionInput).max(30).optional().default([]),
  status: z.enum(["draft", "open", "closed"]).optional().default("draft"),
  published: z.boolean().optional().default(false),
}).superRefine((j, c) => {
  if (j.salaryMin !== null && j.salaryMax !== null && j.salaryMin > j.salaryMax) {
    c.addIssue({ code: "custom", path: ["salaryMax"], message: "The maximum must be at least the minimum" });
  }
  if (j.stages) {
    const lower = j.stages.map((s) => s.toLowerCase());
    if (new Set(lower).size !== lower.length) c.addIssue({ code: "custom", path: ["stages"], message: "Stage names must be different" });
  }
});

const candidateInput = z.object({
  firstName: z.string().trim().min(1, "Enter a first name").max(80),
  lastName: z.string().trim().min(1, "Enter a last name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  phone: optText(40),
  location: optText(120),
  source: z.string().trim().min(1).max(60).optional().default("Added manually"),
});

const interviewInput = z.object({
  title: z.string().trim().min(2, "Enter a title").max(120).optional().default("Interview"),
  scheduledAt: z.string().datetime({ offset: true, message: "Choose a date and time" }),
  durationMinutes: z.number().int().min(5).max(480).optional().default(45),
  mode: z.enum(["office", "phone", "video"]).optional().default("office"),
  location: optText(300),
  interviewerUserIds: z.array(z.string().uuid()).min(1, "Choose at least one interviewer").max(10),
});

const scorecardInput = z.object({
  interviewId: z.string().uuid().optional().nullable(),
  ratings: z.record(z.number().int().min(1).max(5)).optional().default({}),
  recommendation: z.enum(["strong_no", "no", "yes", "strong_yes"]).optional().nullable(),
  notes: optText(5000),
  submit: z.boolean().optional().default(false),
});

// ---------------- helpers ----------------
/** `parse` with the schema's output type (defaults applied). */
const parseZ = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> => parse(schema, data) as z.output<S>;

const name = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

export function jobPublicUrl(org: Org, job: Pick<Job, "slug">) {
  return `${env.siteUrl}/careers/${org.slug}/jobs/${job.slug}`;
}

function isLive(org: Org, job: Job) {
  return job.published && job.status === "open" && org.verificationStatus === "verified";
}

async function uniqueJobSlug(orgId: string, title: string): Promise<string> {
  const root = slugify(title) || "job";
  for (let i = 0; i < 100; i++) {
    const s = i === 0 ? root : `${root}-${i + 1}`;
    const [hit] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.slug, s))).limit(1);
    if (!hit) return s;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

async function loadJob(ctx: OrgContext, id: string, tx: Tx = db): Promise<Job> {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That job");
  const [j] = await tx.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.orgId, ctx.org.id), isNull(jobs.deletedAt))).limit(1);
  if (!j) throw notFound("That job");
  return j;
}

async function loadApplication(ctx: OrgContext, id: string, tx: Tx = db) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That application");
  const [row] = await tx.select({ a: applications, c: candidates, j: jobs }).from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.id, id), eq(applications.orgId, ctx.org.id), isNull(applications.deletedAt), isNull(jobs.deletedAt))).limit(1);
  if (!row) throw notFound("That application");
  return row;
}

/** Users that are active members of the organisation (filters out anyone else). */
async function memberUserIds(orgId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ id: memberships.userId }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.userId, ids), eq(memberships.status, "active"), isNull(memberships.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (!uniq.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function departmentName(orgId: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [d] = await db.select({ name: departments.name }).from(departments).where(and(eq(departments.id, id), eq(departments.orgId, orgId))).limit(1);
  return d?.name ?? null;
}

function avgRating(r: Record<string, number>): number | null {
  const vals = Object.values(r).filter((n) => typeof n === "number");
  return vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : null;
}

/** Admins and the job's hiring manager always see every scorecard. */
function seesAllScorecards(ctx: OrgContext, job: Job) {
  return ctx.membership.role === "admin" || job.hiringManagerUserId === ctx.user.id;
}

function jobView(org: Org, j: Job, extra: Record<string, unknown> = {}) {
  return {
    id: j.id, title: j.title, slug: j.slug, departmentId: j.departmentId, location: j.location, employmentType: j.employmentType,
    salaryMin: j.salaryMin === null ? null : Number(j.salaryMin), salaryMax: j.salaryMax === null ? null : Number(j.salaryMax),
    salaryPeriod: j.salaryPeriod, showSalary: j.showSalary, description: j.description, status: j.status, published: j.published,
    applyBy: j.applyBy, hiringManagerUserId: j.hiringManagerUserId, hiringTeamUserIds: j.hiringTeamUserIds, stages: j.stages,
    questions: j.questions, openedAt: iso(j.openedAt), createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt), version: j.version,
    publicUrl: jobPublicUrl(org, j), isLive: isLive(org, j), reference: j.reference, extraDetails: j.extraDetails, ...extra,
  };
}

function normaliseQuestions(qs: z.infer<typeof questionInput>[]): JobQuestion[] {
  const seen = new Set<string>();
  return qs.map((q) => {
    let id = q.id && /^[A-Za-z0-9_-]+$/.test(q.id) ? q.id : `q_${randomUUID().slice(0, 8)}`;
    if (seen.has(id)) id = `q_${randomUUID().slice(0, 8)}`;
    seen.add(id);
    return { id, label: q.label, type: q.type, required: q.required, ...(q.type === "choice" ? { options: q.options ?? [] } : {}) };
  });
}

async function checkJobRefs(ctx: OrgContext, input: z.infer<typeof jobInput>) {
  const details: Record<string, string> = {};
  if (input.departmentId) {
    const [d] = await db.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.id, input.departmentId), eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt))).limit(1);
    if (!d) details.departmentId = "Choose a department from the list";
  }
  const people = [...input.hiringTeamUserIds, ...(input.hiringManagerUserId ? [input.hiringManagerUserId] : [])];
  const ok = await memberUserIds(ctx.org.id, people);
  if (input.hiringManagerUserId && !ok.has(input.hiringManagerUserId)) details.hiringManagerUserId = "Choose someone in your organisation";
  if (input.hiringTeamUserIds.some((u) => !ok.has(u))) details.hiringTeamUserIds = "Choose people in your organisation";
  if (input.published && ctx.org.verificationStatus !== "verified") details.published = "Jobs can go on the careers page once your organisation is verified";
  if (Object.keys(details).length) throw badRequest("Some details need fixing.", details);
}

async function recordStage(tx: Tx, orgId: string, applicationId: string, from: string | null, to: string, actor: string | null) {
  await tx.insert(applicationStageHistory).values({ orgId, applicationId, fromStage: from, toStage: to, actorUserId: actor });
}

/** Week boundaries (Monday 00:00 UTC to next Monday). */
function weekRange(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;
  const start = new Date(d.getTime() - dow * DAY);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

export async function findOrCreateCandidate(tx: Tx, orgId: string, c: { firstName: string; lastName: string; email: string; phone?: string | null; location?: string | null }) {
  const email = c.email.trim().toLowerCase();
  const [existing] = await tx.select().from(candidates)
    .where(and(eq(candidates.orgId, orgId), eq(candidates.email, email), isNull(candidates.deletedAt))).limit(1);
  if (existing) {
    const [u] = await tx.update(candidates).set({
      firstName: c.firstName || existing.firstName, lastName: c.lastName || existing.lastName,
      phone: c.phone || existing.phone, location: c.location || existing.location, version: dsql`${candidates.version} + 1`,
    }).where(eq(candidates.id, existing.id)).returning();
    return u!;
  }
  const [row] = await tx.insert(candidates).values({
    orgId, firstName: c.firstName, lastName: c.lastName, email, phone: c.phone || null, location: c.location || null,
  }).returning();
  return row!;
}

// ---------------- routes ----------------
export default async function recruitmentRoutes(app: FastifyInstance) {
  // ----- reference data -----
  app.get("/api/recruitment/departments", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    return db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt))).orderBy(asc(departments.name));
  });

  // ----- stats -----
  app.get("/api/recruitment/stats", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const orgId = ctx.org.id;
    const [jobCounts] = await db.select({
      open: dsql<number>`count(*) filter (where ${jobs.status} = 'open')::int`,
      draft: dsql<number>`count(*) filter (where ${jobs.status} = 'draft')::int`,
    }).from(jobs).where(and(eq(jobs.orgId, orgId), isNull(jobs.deletedAt)));
    const weekAgo = new Date(Date.now() - 7 * DAY);
    const [apps] = await db.select({
      newThisWeek: dsql<number>`count(*) filter (where ${applications.createdAt} >= ${weekAgo.toISOString()})::int`,
      active: dsql<number>`count(*) filter (where ${applications.rejectedAt} is null and ${applications.hiredAt} is null)::int`,
    }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(eq(applications.orgId, orgId), isNull(applications.deletedAt), isNull(jobs.deletedAt)));
    const { start, end } = weekRange();
    const todayStart = new Date(new Date().setUTCHours(0, 0, 0, 0));
    const todayEnd = new Date(todayStart.getTime() + DAY);
    const [iv] = await db.select({
      week: dsql<number>`count(*)::int`,
      today: dsql<number>`count(*) filter (where ${interviews.scheduledAt} >= ${todayStart.toISOString()} and ${interviews.scheduledAt} < ${todayEnd.toISOString()})::int`,
      mine: dsql<number>`count(*) filter (where ${interviews.interviewerUserIds} @> ${JSON.stringify([ctx.user.id])}::jsonb and ${interviews.status} = 'scheduled' and ${interviews.scheduledAt} >= now())::int`,
    }).from(interviews).where(and(eq(interviews.orgId, orgId), isNull(interviews.deletedAt), ne(interviews.status, "cancelled"),
      gte(interviews.scheduledAt, start), lt(interviews.scheduledAt, end)));
    const [hire] = await db.select({
      recent: dsql<number | null>`avg(extract(epoch from (${applications.hiredAt} - ${applications.createdAt})) / 86400) filter (where ${applications.hiredAt} >= now() - interval '90 days')`,
      previous: dsql<number | null>`avg(extract(epoch from (${applications.hiredAt} - ${applications.createdAt})) / 86400) filter (where ${applications.hiredAt} < now() - interval '90 days' and ${applications.hiredAt} >= now() - interval '180 days')`,
      all: dsql<number | null>`avg(extract(epoch from (${applications.hiredAt} - ${applications.createdAt})) / 86400)`,
    }).from(applications).where(and(eq(applications.orgId, orgId), isNull(applications.deletedAt), isNotNull(applications.hiredAt)));
    const round = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v)));
    return {
      openRoles: jobCounts?.open ?? 0, draftRoles: jobCounts?.draft ?? 0,
      newApplicantsThisWeek: apps?.newThisWeek ?? 0, activeCandidates: apps?.active ?? 0,
      interviewsThisWeek: iv?.week ?? 0, interviewsToday: iv?.today ?? 0, myUpcomingInterviews: iv?.mine ?? 0,
      averageDaysToHire: round(hire?.recent ?? hire?.all), previousAverageDaysToHire: round(hire?.previous),
    };
  });

  // ----- jobs -----
  app.get<{ Querystring: { status?: string; departmentId?: string; q?: string } }>("/api/recruitment/jobs", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const conds = [eq(jobs.orgId, ctx.org.id), isNull(jobs.deletedAt)];
    const st = (req.query.status ?? "").split(",").filter((s): s is "draft" | "open" | "closed" => ["draft", "open", "closed"].includes(s));
    if (st.length) conds.push(inArray(jobs.status, st));
    if (req.query.departmentId && z.string().uuid().safeParse(req.query.departmentId).success) conds.push(eq(jobs.departmentId, req.query.departmentId));
    if (req.query.q) conds.push(ilike(jobs.title, `%${req.query.q.replace(/[%_]/g, "")}%`));
    const rows = await db.select({ j: jobs, dept: departments.name }).from(jobs).leftJoin(departments, eq(departments.id, jobs.departmentId))
      .where(and(...conds)).orderBy(dsql`case ${jobs.status} when 'open' then 0 when 'draft' then 1 else 2 end`, desc(jobs.createdAt));
    const ids = rows.map((r) => r.j.id);
    const counts = ids.length
      ? await db.select({ jobId: applications.jobId, stage: applications.stage, n: dsql<number>`count(*)::int` }).from(applications)
        .where(and(inArray(applications.jobId, ids), isNull(applications.deletedAt), isNull(applications.rejectedAt)))
        .groupBy(applications.jobId, applications.stage)
      : [];
    return rows.map(({ j, dept }) => {
      const mine = counts.filter((c) => c.jobId === j.id);
      const funnel = j.stages.map((s) => ({ stage: s, count: mine.find((c) => c.stage === s)?.n ?? 0 }));
      return jobView(ctx.org, j, { department: dept, funnel, totalApplications: funnel.reduce((s, f) => s + f.count, 0) });
    });
  });

  app.post("/api/recruitment/jobs", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const input = parseZ(jobInput, req.body);
    await checkJobRefs(ctx, input);
    const slug = await uniqueJobSlug(ctx.org.id, input.title);
    const [j] = await db.insert(jobs).values({
      orgId: ctx.org.id, title: input.title, slug, departmentId: input.departmentId ?? null, location: input.location,
      employmentType: input.employmentType, salaryMin: input.salaryMin === null ? null : String(input.salaryMin),
      salaryMax: input.salaryMax === null ? null : String(input.salaryMax), salaryPeriod: input.salaryPeriod, showSalary: input.showSalary,
      description: input.description, status: input.status, published: input.published, applyBy: input.applyBy ?? null,
      hiringManagerUserId: input.hiringManagerUserId ?? null, hiringTeamUserIds: Array.from(new Set(input.hiringTeamUserIds)),
      stages: input.stages ?? [...DEFAULT_RECRUITMENT_STAGES], questions: normaliseQuestions(input.questions),
      openedAt: input.status === "open" ? new Date() : null, createdBy: ctx.user.id,
    }).returning();
    await audit(ctx, { action: "job.created", category: "data", entityType: "job", entityId: j!.id, summary: `${ctx.user.name} created the job ${j!.title}` });
    return { job: jobView(ctx.org, j!, { department: await departmentName(ctx.org.id, j!.departmentId) }) };
  });

  app.patch<{ Params: { id: string } }>("/api/recruitment/jobs/:id", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const job = await loadJob(ctx, req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Merge with the current job so partial updates work.
    const current = {
      title: job.title, departmentId: job.departmentId, location: job.location, employmentType: job.employmentType,
      salaryMin: job.salaryMin, salaryMax: job.salaryMax, salaryPeriod: job.salaryPeriod ?? "month", showSalary: job.showSalary,
      description: job.description, applyBy: job.applyBy, hiringManagerUserId: job.hiringManagerUserId, hiringTeamUserIds: job.hiringTeamUserIds,
      stages: job.stages, questions: job.questions, status: job.status, published: job.published,
    };
    const input = parseZ(jobInput, { ...current, ...body });
    // Only re-check verification when publishing is being turned on now.
    await checkJobRefs(ctx, { ...input, published: input.published && !job.published });
    const stages = input.stages ?? job.stages;
    const removed = job.stages.filter((s) => !stages.includes(s));
    if (removed.length) {
      const inUse = await db.select({ stage: applications.stage, n: dsql<number>`count(*)::int` }).from(applications)
        .where(and(eq(applications.jobId, job.id), isNull(applications.deletedAt), inArray(applications.stage, removed)))
        .groupBy(applications.stage);
      if (inUse.length) {
        throw conflict(`You can't remove ${inUse.map((u) => `"${u.stage}"`).join(", ")} while candidates are in it. Move them first.`,
          { stages: "A removed stage still has candidates" });
      }
    }
    const [j] = await db.update(jobs).set({
      title: input.title, departmentId: input.departmentId ?? null, location: input.location, employmentType: input.employmentType,
      salaryMin: input.salaryMin === null ? null : String(input.salaryMin), salaryMax: input.salaryMax === null ? null : String(input.salaryMax),
      salaryPeriod: input.salaryPeriod, showSalary: input.showSalary, description: input.description, applyBy: input.applyBy ?? null,
      hiringManagerUserId: input.hiringManagerUserId ?? null, hiringTeamUserIds: Array.from(new Set(input.hiringTeamUserIds)),
      stages, questions: normaliseQuestions(input.questions), status: input.status, published: input.published,
      openedAt: input.status === "open" && !job.openedAt ? new Date() : job.openedAt, version: dsql`${jobs.version} + 1`,
    }).where(eq(jobs.id, job.id)).returning();
    const what = input.status !== job.status ? `${input.status === "open" ? "opened" : input.status === "closed" ? "closed" : "moved to draft"} the job` : "updated the job";
    await audit(ctx, { action: "job.updated", category: "data", entityType: "job", entityId: job.id, summary: `${ctx.user.name} ${what} ${j!.title}`, meta: { fields: Object.keys(body) } });
    return { job: jobView(ctx.org, j!, { department: await departmentName(ctx.org.id, j!.departmentId) }) };
  });

  app.post<{ Params: { id: string } }>("/api/recruitment/jobs/:id/close", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const job = await loadJob(ctx, req.params.id);
    const [j] = await db.update(jobs).set({ status: "closed", version: dsql`${jobs.version} + 1` }).where(eq(jobs.id, job.id)).returning();
    await audit(ctx, { action: "job.closed", category: "data", entityType: "job", entityId: job.id, summary: `${ctx.user.name} closed the job ${job.title}` });
    return { job: jobView(ctx.org, j!) };
  });

  app.delete<{ Params: { id: string } }>("/api/recruitment/jobs/:id", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "manage");
    const job = await loadJob(ctx, req.params.id);
    await db.update(jobs).set({ deletedAt: new Date(), published: false, status: "closed", version: dsql`${jobs.version} + 1` }).where(eq(jobs.id, job.id));
    await audit(ctx, { action: "job.deleted", category: "data", entityType: "job", entityId: job.id, summary: `${ctx.user.name} deleted the job ${job.title}` });
    return { ok: true };
  });

  /** Job detail + pipeline: applications grouped by stage. */
  app.get<{ Params: { id: string } }>("/api/recruitment/jobs/:id", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const job = await loadJob(ctx, req.params.id);
    const rows = await db.select({ a: applications, c: candidates }).from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .where(and(eq(applications.jobId, job.id), isNull(applications.deletedAt))).orderBy(desc(applications.stageChangedAt));
    const appIds = rows.map((r) => r.a.id);
    const cards = appIds.length
      ? await db.select().from(scorecards).where(and(inArray(scorecards.applicationId, appIds), isNull(scorecards.deletedAt))) : [];
    const now = new Date();
    const upcoming = appIds.length
      ? await db.select().from(interviews).where(and(inArray(interviews.applicationId, appIds), isNull(interviews.deletedAt),
        eq(interviews.status, "scheduled"), gte(interviews.scheduledAt, now))).orderBy(asc(interviews.scheduledAt)) : [];
    const all = seesAllScorecards(ctx, job);
    const card = ({ a, c }: (typeof rows)[number]) => {
      const mine = cards.filter((s) => s.applicationId === a.id);
      const visible = all || mine.some((s) => s.interviewerUserId === ctx.user.id && s.submittedAt);
      const scores = mine.filter((s) => s.submittedAt).map((s) => avgRating(s.ratings)).filter((n): n is number => n !== null);
      const next = upcoming.find((i) => i.applicationId === a.id);
      return {
        id: a.id, candidateId: c.id, name: name(c), email: c.email, source: a.source, stage: a.stage,
        averageScore: visible && scores.length ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 10) / 10 : null,
        scoreCount: scores.length, scoreHidden: !visible && scores.length > 0,
        daysInStage: Math.floor((now.getTime() - a.stageChangedAt.getTime()) / DAY),
        stageChangedAt: iso(a.stageChangedAt), appliedAt: iso(a.createdAt), rejectedAt: iso(a.rejectedAt), rejectionReason: a.rejectionReason,
        hiredAt: iso(a.hiredAt), employeeId: a.employeeId, nextInterviewAt: next ? iso(next.scheduledAt) : null,
      };
    };
    const active = rows.filter((r) => !r.a.rejectedAt);
    const names = await userNames([job.hiringManagerUserId ?? "", ...job.hiringTeamUserIds]);
    return {
      job: jobView(ctx.org, job, {
        department: await departmentName(ctx.org.id, job.departmentId),
        hiringManagerName: job.hiringManagerUserId ? names.get(job.hiringManagerUserId) ?? null : null,
        hiringTeam: job.hiringTeamUserIds.map((id) => ({ userId: id, name: names.get(id) ?? "Former member" })),
      }),
      stages: job.stages.map((s) => ({ name: s, applications: active.filter((r) => r.a.stage === s).map(card) })),
      rejected: rows.filter((r) => r.a.rejectedAt).map(card),
      canSeeAllScores: all,
    };
  });

  // ----- candidates / applications -----
  app.post<{ Params: { id: string } }>("/api/recruitment/jobs/:id/candidates", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const job = await loadJob(ctx, req.params.id);
    const input = parseZ(candidateInput, req.body);
    const result = await db.transaction(async (tx) => {
      const cand = await findOrCreateCandidate(tx, ctx.org.id, input);
      const [dup] = await tx.select({ id: applications.id }).from(applications)
        .where(and(eq(applications.jobId, job.id), eq(applications.candidateId, cand.id), isNull(applications.deletedAt))).limit(1);
      if (dup) throw conflict(`${name(cand)} has already applied for this job.`, { email: "Already a candidate for this job" });
      const [a] = await tx.insert(applications).values({
        orgId: ctx.org.id, jobId: job.id, candidateId: cand.id, stage: job.stages[0]!, source: input.source,
      }).returning();
      await recordStage(tx, ctx.org.id, a!.id, null, a!.stage, ctx.user.id);
      await audit(ctx, { action: "application.created", category: "data", entityType: "application", entityId: a!.id, summary: `${ctx.user.name} added ${name(cand)} to ${job.title}` }, tx);
      return a!;
    });
    return { application: { id: result.id, stage: result.stage } };
  });

  app.get<{ Querystring: { q?: string; stage?: string; jobId?: string; status?: string } }>("/api/recruitment/applications", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const conds = [eq(applications.orgId, ctx.org.id), isNull(applications.deletedAt), isNull(jobs.deletedAt)];
    const status = req.query.status ?? "active";
    if (status === "active") conds.push(isNull(applications.rejectedAt), isNull(applications.hiredAt));
    else if (status === "rejected") conds.push(isNotNull(applications.rejectedAt));
    else if (status === "hired") conds.push(isNotNull(applications.hiredAt));
    if (req.query.stage) conds.push(eq(applications.stage, req.query.stage));
    if (req.query.jobId && z.string().uuid().safeParse(req.query.jobId).success) conds.push(eq(applications.jobId, req.query.jobId));
    if (req.query.q) {
      const like = `%${req.query.q.replace(/[%_]/g, "")}%`;
      conds.push(or(ilike(dsql`${candidates.firstName} || ' ' || ${candidates.lastName}`, like), ilike(candidates.email, like), ilike(jobs.title, like))!);
    }
    const rows = await db.select({ a: applications, c: candidates, j: jobs }).from(applications)
      .innerJoin(candidates, eq(candidates.id, applications.candidateId)).innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(...conds)).orderBy(desc(applications.createdAt)).limit(500);
    const now = Date.now();
    return rows.map(({ a, c, j }) => ({
      id: a.id, candidateId: c.id, name: name(c), email: c.email, phone: c.phone, jobId: j.id, jobTitle: j.title, stage: a.stage,
      source: a.source, appliedAt: iso(a.createdAt), daysInStage: Math.floor((now - a.stageChangedAt.getTime()) / DAY),
      rejectedAt: iso(a.rejectedAt), hiredAt: iso(a.hiredAt), employeeId: a.employeeId,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/recruitment/applications/:id", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const { a, c, j } = await loadApplication(ctx, req.params.id);
    const [notes, ivs, cards, history, cv] = await Promise.all([
      db.select({ n: candidateNotes, author: users.name }).from(candidateNotes).innerJoin(users, eq(users.id, candidateNotes.authorUserId))
        .where(and(eq(candidateNotes.applicationId, a.id), isNull(candidateNotes.deletedAt))).orderBy(desc(candidateNotes.createdAt)),
      db.select().from(interviews).where(and(eq(interviews.applicationId, a.id), isNull(interviews.deletedAt))).orderBy(asc(interviews.scheduledAt)),
      db.select({ s: scorecards, who: users.name }).from(scorecards).innerJoin(users, eq(users.id, scorecards.interviewerUserId))
        .where(and(eq(scorecards.applicationId, a.id), isNull(scorecards.deletedAt))),
      db.select().from(applicationStageHistory).where(eq(applicationStageHistory.applicationId, a.id)).orderBy(asc(applicationStageHistory.createdAt)),
      a.cvFileId ? db.select().from(files).where(and(eq(files.id, a.cvFileId), eq(files.orgId, ctx.org.id), isNull(files.deletedAt))).limit(1) : Promise.resolve([]),
    ]);
    const names = await userNames([...ivs.flatMap((i) => i.interviewerUserIds), j.hiringManagerUserId ?? ""]);
    const all = seesAllScorecards(ctx, j);
    const submittedOwn = cards.some(({ s }) => s.interviewerUserId === ctx.user.id && s.submittedAt);
    const visibleOthers = all || submittedOwn;
    const ivTitle = new Map(ivs.map((i) => [i.id, i.title]));
    const submitted = cards.filter(({ s }) => s.submittedAt);
    const scoreVals = submitted.map(({ s }) => avgRating(s.ratings)).filter((n): n is number => n !== null);
    const scorecardView = ({ s, who }: (typeof cards)[number]) => ({
      id: s.id, interviewId: s.interviewId, interviewTitle: s.interviewId ? ivTitle.get(s.interviewId) ?? null : null,
      interviewerUserId: s.interviewerUserId, interviewerName: who, ratings: s.ratings, average: avgRating(s.ratings),
      recommendation: s.recommendation, notes: s.notes, submittedAt: iso(s.submittedAt), isMine: s.interviewerUserId === ctx.user.id,
    });
    return {
      application: {
        id: a.id, stage: a.stage, source: a.source, appliedAt: iso(a.createdAt), stageChangedAt: iso(a.stageChangedAt), coverLetter: a.coverLetter,
        expectedSalary: a.expectedSalary === null ? null : Number(a.expectedSalary), consentAt: iso(a.consentAt),
        rejectedAt: iso(a.rejectedAt), rejectionReason: a.rejectionReason, hiredAt: iso(a.hiredAt), employeeId: a.employeeId, version: a.version,
        answers: j.questions.filter((q) => a.answers[q.id] !== undefined && a.answers[q.id] !== "")
          .map((q) => ({ questionId: q.id, label: q.label, type: q.type, value: a.answers[q.id] })),
        cvFileId: a.cvFileId,
        cv: cv[0] ? { id: cv[0].id, name: cv[0].name, mime: cv[0].mime, size: cv[0].size } : null,
      },
      candidate: { id: c.id, firstName: c.firstName, lastName: c.lastName, name: name(c), email: c.email, phone: c.phone, location: c.location },
      job: {
        id: j.id, title: j.title, stages: j.stages, departmentId: j.departmentId, department: await departmentName(ctx.org.id, j.departmentId),
        location: j.location, employmentType: j.employmentType, hiringManagerUserId: j.hiringManagerUserId,
        hiringManagerName: j.hiringManagerUserId ? names.get(j.hiringManagerUserId) ?? null : null,
      },
      notes: notes.map(({ n, author }) => ({
        id: n.id, body: n.body, authorUserId: n.authorUserId, authorName: author, createdAt: iso(n.createdAt), updatedAt: iso(n.updatedAt), isMine: n.authorUserId === ctx.user.id,
      })),
      interviews: ivs.map((i) => ({
        id: i.id, title: i.title, scheduledAt: iso(i.scheduledAt), durationMinutes: i.durationMinutes, mode: i.mode, location: i.location,
        status: i.status, interviewers: i.interviewerUserIds.map((u) => ({ userId: u, name: names.get(u) ?? "Former member" })),
      })),
      scorecards: cards.filter(({ s }) => s.interviewerUserId === ctx.user.id || (visibleOthers && s.submittedAt)).map(scorecardView),
      feedback: {
        submittedCount: submitted.length,
        average: visibleOthers && scoreVals.length ? Math.round((scoreVals.reduce((s, n) => s + n, 0) / scoreVals.length) * 10) / 10 : null,
        hiddenCount: visibleOthers ? 0 : submitted.filter(({ s }) => s.interviewerUserId !== ctx.user.id).length,
        canSeeAll: all,
      },
      history: history.map((h) => ({ from: h.fromStage, to: h.toStage, at: iso(h.createdAt) })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/recruitment/applications/:id/stage", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const { stage } = parseZ(z.object({ stage: z.string().trim().min(1, "Choose a stage") }), req.body);
    const { a, c, j } = await loadApplication(ctx, req.params.id);
    if (!j.stages.includes(stage)) throw badRequest("That stage isn't part of this job.", { stage: "Unknown stage" });
    if (a.hiredAt) throw conflict(`${name(c)} has already been hired.`);
    if (a.rejectedAt) throw conflict(`${name(c)} was rejected. Restore them first.`);
    if (stage === j.stages[j.stages.length - 1]) throw badRequest(`Use Hire to move someone to ${stage}.`, { stage: "Use Hire for the last stage" });
    if (stage === a.stage) return { ok: true, stage };
    await db.transaction(async (tx) => {
      await tx.update(applications).set({ stage, stageChangedAt: new Date(), version: dsql`${applications.version} + 1` }).where(eq(applications.id, a.id));
      await recordStage(tx, ctx.org.id, a.id, a.stage, stage, ctx.user.id);
      await audit(ctx, {
        action: "application.stage_changed", category: "data", entityType: "application", entityId: a.id,
        summary: `${ctx.user.name} moved ${name(c)} from ${a.stage} to ${stage} for ${j.title}`, meta: { from: a.stage, to: stage },
      }, tx);
    });
    return { ok: true, stage };
  });

  app.post<{ Params: { id: string } }>("/api/recruitment/applications/:id/reject", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const { reason } = parseZ(z.object({ reason: z.string().trim().min(2, "Give a short reason").max(500) }), req.body);
    const { a, c, j } = await loadApplication(ctx, req.params.id);
    if (a.hiredAt) throw conflict(`${name(c)} has already been hired.`);
    await db.update(applications).set({ rejectedAt: new Date(), rejectionReason: reason, version: dsql`${applications.version} + 1` }).where(eq(applications.id, a.id));
    await audit(ctx, { action: "application.rejected", category: "data", entityType: "application", entityId: a.id, summary: `${ctx.user.name} rejected ${name(c)} for ${j.title}`, meta: { reason } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/recruitment/applications/:id/restore", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const { a, c, j } = await loadApplication(ctx, req.params.id);
    await db.update(applications).set({ rejectedAt: null, rejectionReason: null, version: dsql`${applications.version} + 1` }).where(eq(applications.id, a.id));
    await audit(ctx, { action: "application.restored", category: "data", entityType: "application", entityId: a.id, summary: `${ctx.user.name} restored ${name(c)} for ${j.title}` });
    return { ok: true };
  });

  // ----- notes -----
  app.post<{ Params: { id: string } }>("/api/recruitment/applications/:id/notes", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const { body } = parseZ(z.object({ body: z.string().trim().min(1, "Write a note").max(5000) }), req.body);
    const { a } = await loadApplication(ctx, req.params.id);
    const [n] = await db.insert(candidateNotes).values({ orgId: ctx.org.id, applicationId: a.id, authorUserId: ctx.user.id, body }).returning();
    return { note: { id: n!.id, body: n!.body, authorUserId: ctx.user.id, authorName: ctx.user.name, createdAt: iso(n!.createdAt), updatedAt: iso(n!.updatedAt), isMine: true } };
  });

  async function loadOwnNote(ctx: OrgContext, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("That note");
    const [n] = await db.select().from(candidateNotes).where(and(eq(candidateNotes.id, id), eq(candidateNotes.orgId, ctx.org.id), isNull(candidateNotes.deletedAt))).limit(1);
    if (!n) throw notFound("That note");
    if (n.authorUserId !== ctx.user.id) throw forbidden("Only the author can change this note.");
    return n;
  }

  app.patch<{ Params: { id: string } }>("/api/recruitment/notes/:id", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const { body } = parseZ(z.object({ body: z.string().trim().min(1, "Write a note").max(5000) }), req.body);
    const n = await loadOwnNote(ctx, req.params.id);
    await db.update(candidateNotes).set({ body, version: dsql`${candidateNotes.version} + 1` }).where(eq(candidateNotes.id, n.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/recruitment/notes/:id", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const n = await loadOwnNote(ctx, req.params.id);
    await db.update(candidateNotes).set({ deletedAt: new Date(), version: dsql`${candidateNotes.version} + 1` }).where(eq(candidateNotes.id, n.id));
    return { ok: true };
  });

  // ----- interviews -----
  app.post<{ Params: { id: string } }>("/api/recruitment/applications/:id/interviews", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const input = parseZ(interviewInput, req.body);
    const { a, c, j } = await loadApplication(ctx, req.params.id);
    if (a.rejectedAt || a.hiredAt) throw conflict("Interviews can only be scheduled for active candidates.");
    const ids = Array.from(new Set(input.interviewerUserIds));
    const ok = await memberUserIds(ctx.org.id, ids);
    if (ids.some((u) => !ok.has(u))) throw badRequest("Some details need fixing.", { interviewerUserIds: "Choose people in your organisation" });
    const when = new Date(input.scheduledAt);
    const iv = await db.transaction(async (tx) => {
      const [row] = await tx.insert(interviews).values({
        orgId: ctx.org.id, applicationId: a.id, title: input.title, scheduledAt: when, durationMinutes: input.durationMinutes,
        mode: input.mode, location: input.location, interviewerUserIds: ids,
      }).returning();
      for (const u of ids) {
        if (u === ctx.user.id) continue;
        await notify(ctx.org.id, u, `Interview: ${name(c)}`, `${j.title} · ${input.title} · ${when.toISOString().slice(0, 16).replace("T", " ")} UTC`, `/recruitment/interviews?interview=${row!.id}`, tx);
      }
      await audit(ctx, { action: "interview.scheduled", category: "data", entityType: "interview", entityId: row!.id, summary: `${ctx.user.name} scheduled ${input.title.toLowerCase()} with ${name(c)} for ${j.title}` }, tx);
      return row!;
    });
    return { interview: { id: iv.id, scheduledAt: iso(iv.scheduledAt), status: iv.status } };
  });

  app.get<{ Querystring: { from?: string; to?: string; range?: string; interviewer?: string; status?: string } }>("/api/recruitment/interviews", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    let from: Date; let to: Date;
    const range = req.query.range ?? (req.query.from ? "custom" : "week");
    if (range === "custom") {
      from = new Date(req.query.from ?? Date.now());
      to = new Date(req.query.to ?? from.getTime() + 7 * DAY);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest("Choose a valid date range.");
    } else if (range === "upcoming") {
      from = new Date(new Date().setUTCHours(0, 0, 0, 0)); to = new Date(from.getTime() + 60 * DAY);
    } else if (range === "next_week") {
      const w = weekRange(); from = w.end; to = new Date(w.end.getTime() + 7 * DAY);
    } else {
      const w = weekRange(); from = w.start; to = w.end;
    }
    const conds = [eq(interviews.orgId, ctx.org.id), isNull(interviews.deletedAt), isNull(applications.deletedAt), isNull(jobs.deletedAt),
      gte(interviews.scheduledAt, from), lt(interviews.scheduledAt, to)];
    if (req.query.interviewer === "me") conds.push(dsql`${interviews.interviewerUserIds} @> ${JSON.stringify([ctx.user.id])}::jsonb`);
    if (req.query.status !== "all") conds.push(ne(interviews.status, "cancelled"));
    const rows = await db.select({ i: interviews, a: applications, c: candidates, j: jobs }).from(interviews)
      .innerJoin(applications, eq(applications.id, interviews.applicationId))
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(...conds)).orderBy(asc(interviews.scheduledAt));
    const names = await userNames(rows.flatMap((r) => r.i.interviewerUserIds));
    const ids = rows.map((r) => r.i.id);
    const mine = ids.length ? await db.select().from(scorecards)
      .where(and(inArray(scorecards.interviewId, ids), eq(scorecards.interviewerUserId, ctx.user.id), isNull(scorecards.deletedAt))) : [];
    return {
      from: from.toISOString(), to: to.toISOString(),
      items: rows.map(({ i, a, c, j }) => {
        const sc = mine.find((s) => s.interviewId === i.id);
        return {
          id: i.id, title: i.title, scheduledAt: iso(i.scheduledAt), durationMinutes: i.durationMinutes, mode: i.mode, location: i.location, status: i.status,
          applicationId: a.id, candidateName: name(c), jobId: j.id, jobTitle: j.title,
          interviewers: i.interviewerUserIds.map((u) => ({ userId: u, name: names.get(u) ?? "Former member" })),
          isInterviewer: i.interviewerUserIds.includes(ctx.user.id),
          myScorecard: sc ? { id: sc.id, ratings: sc.ratings, recommendation: sc.recommendation, notes: sc.notes, submittedAt: iso(sc.submittedAt) } : null,
        };
      }),
    };
  });

  app.post<{ Params: { id: string; action: string } }>("/api/recruitment/interviews/:id/:action", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const action = req.params.action;
    if (action !== "cancel" && action !== "complete") throw notFound("That action");
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That interview");
    const [iv] = await db.select().from(interviews).where(and(eq(interviews.id, req.params.id), eq(interviews.orgId, ctx.org.id), isNull(interviews.deletedAt))).limit(1);
    if (!iv) throw notFound("That interview");
    const status = action === "cancel" ? "cancelled" : "completed";
    await db.update(interviews).set({ status, version: dsql`${interviews.version} + 1` }).where(eq(interviews.id, iv.id));
    if (status === "cancelled") {
      for (const u of iv.interviewerUserIds) if (u !== ctx.user.id) await notify(ctx.org.id, u, `Interview cancelled: ${iv.title}`, undefined, `/recruitment/applications/${iv.applicationId}`);
    }
    await audit(ctx, { action: `interview.${status}`, category: "data", entityType: "interview", entityId: iv.id, summary: `${ctx.user.name} marked ${iv.title.toLowerCase()} as ${status}` });
    return { ok: true, status };
  });

  // ----- scorecards -----
  /** Save (draft) or submit the caller's own scorecard. Submitted scorecards are final. */
  app.put<{ Params: { id: string } }>("/api/recruitment/applications/:id/scorecard", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "view");
    const input = parseZ(scorecardInput, req.body);
    const { a } = await loadApplication(ctx, req.params.id);
    const bad = Object.keys(input.ratings).filter((k) => !(SCORE_CRITERIA as readonly string[]).includes(k));
    if (bad.length) throw badRequest("Some details need fixing.", { ratings: `Unknown criteria: ${bad.join(", ")}` });
    if (input.interviewId) {
      const [iv] = await db.select().from(interviews).where(and(eq(interviews.id, input.interviewId), eq(interviews.applicationId, a.id), isNull(interviews.deletedAt))).limit(1);
      if (!iv) throw badRequest("That interview isn't for this candidate.", { interviewId: "Unknown interview" });
    }
    if (input.submit) {
      const details: Record<string, string> = {};
      for (const k of SCORE_CRITERIA) if (!input.ratings[k]) details[`ratings.${k}`] = "Give a rating";
      if (!input.recommendation) details.recommendation = "Choose a recommendation";
      if (Object.keys(details).length) throw badRequest("Rate every area and choose a recommendation before submitting.", details);
    }
    const [existing] = await db.select().from(scorecards).where(and(
      eq(scorecards.applicationId, a.id), eq(scorecards.interviewerUserId, ctx.user.id), isNull(scorecards.deletedAt),
      input.interviewId ? eq(scorecards.interviewId, input.interviewId) : isNull(scorecards.interviewId),
    )).limit(1);
    if (existing?.submittedAt) throw conflict("You've already submitted this feedback.");
    const values = {
      ratings: input.ratings, recommendation: input.recommendation ?? null, notes: input.notes,
      submittedAt: input.submit ? new Date() : null,
    };
    const [sc] = existing
      ? await db.update(scorecards).set({ ...values, version: dsql`${scorecards.version} + 1` }).where(eq(scorecards.id, existing.id)).returning()
      : await db.insert(scorecards).values({ ...values, orgId: ctx.org.id, applicationId: a.id, interviewId: input.interviewId ?? null, interviewerUserId: ctx.user.id }).returning();
    if (input.submit) {
      await audit(ctx, { action: "scorecard.submitted", category: "data", entityType: "application", entityId: a.id, summary: `${ctx.user.name} submitted interview feedback` });
    }
    return { scorecard: { id: sc!.id, ratings: sc!.ratings, recommendation: sc!.recommendation, notes: sc!.notes, submittedAt: iso(sc!.submittedAt) } };
  });

  // ----- hire -----
  app.post<{ Params: { id: string } }>("/api/recruitment/applications/:id/hire", async (req) => {
    const ctx = await requireAccess(req, "recruitment", "edit");
    const input = parseZ(z.object({
      jobTitle: z.string().trim().min(2, "Enter a job title").max(120),
      departmentId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
      managerEmployeeId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a start date"),
    }), req.body);
    await loadApplication(ctx, req.params.id); // 404 for other orgs before taking a lock
    const result = await db.transaction(async (tx) => {
      // Lock the application so two hire clicks can't create two employees.
      const [a] = await tx.select().from(applications).where(and(eq(applications.id, req.params.id), eq(applications.orgId, ctx.org.id))).limit(1).for("update");
      if (!a) throw notFound("That application");
      if (a.employeeId) {
        const [emp] = await tx.select().from(employees).where(eq(employees.id, a.employeeId)).limit(1);
        return { employee: emp!, alreadyHired: true, checklistId: null as string | null };
      }
      if (a.rejectedAt) throw conflict("This candidate was rejected. Restore them before hiring.");
      const [c] = await tx.select().from(candidates).where(eq(candidates.id, a.candidateId)).limit(1);
      const [j] = await tx.select().from(jobs).where(eq(jobs.id, a.jobId)).limit(1);
      const details: Record<string, string> = {};
      if (input.departmentId) {
        const [d] = await tx.select({ id: departments.id }).from(departments)
          .where(and(eq(departments.id, input.departmentId), eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt))).limit(1);
        if (!d) details.departmentId = "Choose a department from the list";
      }
      if (input.managerEmployeeId) {
        const [m] = await tx.select({ id: employees.id }).from(employees)
          .where(and(eq(employees.id, input.managerEmployeeId), eq(employees.orgId, ctx.org.id), isNull(employees.deletedAt))).limit(1);
        if (!m) details.managerEmployeeId = "Choose a manager from the list";
      }
      if (Object.keys(details).length) throw badRequest("Some details need fixing.", details);
      const [emp] = await tx.insert(employees).values({
        orgId: ctx.org.id, firstName: c!.firstName, lastName: c!.lastName, email: c!.email, phone: c!.phone, jobTitle: input.jobTitle,
        departmentId: input.departmentId ?? null, managerId: input.managerEmployeeId ?? null, location: j!.location,
        employmentType: j!.employmentType, startDate: input.startDate, status: "onboarding", sourceApplicationId: a.id,
      }).returning();
      await tx.insert(employmentHistory).values({
        orgId: ctx.org.id, employeeId: emp!.id, occurredOn: input.startDate, event: `Joined as ${input.jobTitle}`,
        details: `Hired through Recruitment (${j!.title})`, actorUserId: ctx.user.id,
      });
      if (a.cvFileId) {
        await tx.insert(fileLinks).values({ orgId: ctx.org.id, fileId: a.cvFileId, linkType: "employee", linkId: emp!.id, label: "CV" });
      }
      const last = j!.stages[j!.stages.length - 1]!;
      const now = new Date();
      await tx.update(applications).set({
        stage: last, hiredAt: now, employeeId: emp!.id, stageChangedAt: now, version: dsql`${applications.version} + 1`,
      }).where(eq(applications.id, a.id));
      if (a.stage !== last) await recordStage(tx, ctx.org.id, a.id, a.stage, last, ctx.user.id);
      const cl = await startChecklist({ orgId: ctx.org.id, employeeId: emp!.id, kind: "onboarding", anchorDate: input.startDate, createdBy: ctx.user.id, tx });
      await audit(ctx, {
        action: "application.hired", category: "data", entityType: "employee", entityId: emp!.id,
        summary: `${ctx.user.name} hired ${name(c!)} as ${input.jobTitle}`, meta: { applicationId: a.id, jobId: j!.id, startDate: input.startDate },
      }, tx);
      return { employee: emp!, alreadyHired: false, checklistId: cl?.id ?? null };
    });
    return {
      employee: { id: result.employee.id, firstName: result.employee.firstName, lastName: result.employee.lastName, startDate: result.employee.startDate, status: result.employee.status },
      alreadyHired: result.alreadyHired, checklistId: result.checklistId,
    };
  });
}
