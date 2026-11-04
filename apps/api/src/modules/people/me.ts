import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "../../db/client";
import {
  applicationStageHistory, applications, attendance, checklists, employeePay, files, interviews, jobs, tasks,
} from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { notFound } from "../../lib/http";
import { readObject } from "../../lib/storage";
import { checklistProgress, myEmployee } from "./shared";
import { workedMinutes } from "./attendance";
import { localDate } from "./util";

/**
 * My space: a person's own things, whatever their role. Nothing here shows anyone else's records,
 * and none of it needs People & HR access.
 */
export default async function mySpaceRoutes(app: FastifyInstance) {
  /** What My space has for this person (so the sidebar only shows what applies). */
  app.get("/api/my/summary", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) return { employee: null, onboarding: false, application: false };
    const [cl] = await db.select({ id: checklists.id }).from(checklists)
      .where(and(eq(checklists.employeeId, me.id), isNull(checklists.deletedAt))).limit(1);
    const [ap] = await db.select({ id: applications.id }).from(applications)
      .where(and(eq(applications.orgId, ctx.org.id), isNull(applications.deletedAt), me.sourceApplicationId
        ? or(eq(applications.employeeId, me.id), eq(applications.id, me.sourceApplicationId)) : eq(applications.employeeId, me.id))).limit(1);
    // The next onboarding step that isn't done.
    const [next] = cl ? await db.select({ title: tasks.title, dueAt: tasks.dueAt }).from(tasks).innerJoin(checklists, eq(checklists.id, tasks.checklistId))
      .where(and(eq(checklists.employeeId, me.id), isNull(tasks.deletedAt), isNull(checklists.deletedAt), eq(checklists.status, "in_progress")))
      .orderBy(asc(tasks.dueAt)).limit(1) : [];
    return {
      employee: { id: me.id, firstName: me.firstName, jobTitle: me.jobTitle, startDate: me.startDate, status: me.status },
      onboarding: !!cl, application: !!ap, nextStep: next ?? null,
    };
  });

  /** Their own clock-ins, a month at a time. */
  app.get<{ Querystring: { month?: string } }>("/api/my/attendance", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    const month = /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month! : localDate().slice(0, 7);
    if (!me) return { month, days: [] };
    const [y, m] = month.split("-").map(Number) as [number, number];
    const last = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    const rows = await db.select().from(attendance)
      .where(and(eq(attendance.employeeId, me.id), isNull(attendance.deletedAt), gte(attendance.workDate, `${month}-01`), lte(attendance.workDate, last)))
      .orderBy(desc(attendance.workDate));
    return {
      month,
      days: rows.map((r) => ({
        date: r.workDate, clockIn: r.clockIn, clockOut: r.clockOut, breaks: r.breaks.length, corrected: r.source === "correction", note: r.note,
        minutes: r.clockIn ? workedMinutes(r, r.clockOut ?? (r.workDate === localDate() ? new Date() : null)) : null,
      })),
    };
  });

  /** Their own pay details (no payroll yet, so no payslips). */
  app.get("/api/my/pay", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    const [p] = me ? await db.select().from(employeePay).where(eq(employeePay.employeeId, me.id)).limit(1) : [];
    return {
      pay: p ? {
        salaryAmount: p.salaryAmount, currency: p.currency ?? ctx.org.currency, payFrequency: p.payFrequency,
        bankName: p.bankName, accountNumber: p.accountNumber, updatedAt: p.updatedAt,
      } : null,
      employmentType: me?.employmentType ?? null, startDate: me?.startDate ?? null,
    };
  });

  /** Their onboarding (and offboarding) checklists. Each one opens with /api/people/checklists/:id. */
  app.get("/api/my/checklists", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) return [];
    const rows = await db.select().from(checklists).where(and(eq(checklists.employeeId, me.id), isNull(checklists.deletedAt))).orderBy(desc(checklists.createdAt));
    const prog = await checklistProgress(rows.map((c) => c.id));
    return rows.map((c) => ({ id: c.id, kind: c.kind, title: c.title, status: c.status, total: prog.get(c.id)?.total ?? 0, done: prog.get(c.id)?.done ?? 0 }));
  });

  async function myApplication(req: Parameters<typeof requireOrg>[0]) {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) return null;
    const [row] = await db.select({ a: applications, j: jobs }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(eq(applications.orgId, ctx.org.id), isNull(applications.deletedAt), me.sourceApplicationId
        ? or(eq(applications.employeeId, me.id), eq(applications.id, me.sourceApplicationId)) : eq(applications.employeeId, me.id)))
      .orderBy(desc(applications.createdAt)).limit(1);
    return row ?? null;
  }

  /** The job they were hired from: what they sent, and each step to being hired. Reviewers' notes and scores stay private. */
  app.get("/api/my/application", async (req) => {
    const row = await myApplication(req);
    if (!row) return { application: null };
    const { a, j } = row;
    const history = await db.select().from(applicationStageHistory).where(eq(applicationStageHistory.applicationId, a.id)).orderBy(asc(applicationStageHistory.createdAt));
    const meetings = await db.select().from(interviews).where(and(eq(interviews.applicationId, a.id), isNull(interviews.deletedAt))).orderBy(asc(interviews.scheduledAt));
    const [cv] = a.cvFileId ? await db.select({ id: files.id, name: files.name, mime: files.mime, size: files.size }).from(files).where(eq(files.id, a.cvFileId)).limit(1) : [];
    return {
      application: {
        job: { title: j.title, location: j.location ?? null },
        appliedAt: a.createdAt, source: a.source, hiredAt: a.hiredAt, coverLetter: a.coverLetter, cv: cv ?? null,
        answers: (j.questions ?? []).filter((q) => a.answers[q.id] !== undefined && a.answers[q.id] !== "").map((q) => ({ question: q.label, answer: a.answers[q.id] })),
        steps: [
          { label: "Applied", at: a.createdAt },
          ...history.map((h) => ({ label: h.toStage, at: h.createdAt })),
        ],
        interviews: meetings.map((m) => ({ title: m.title, at: m.scheduledAt, mode: m.mode, status: m.status })),
      },
    };
  });

  /** Their own CV, as they sent it. */
  app.get("/api/my/application/cv", async (req, reply) => {
    const row = await myApplication(req);
    if (!row?.a.cvFileId) throw notFound("Your CV");
    const [f] = await db.select().from(files).where(and(eq(files.id, row.a.cvFileId), isNull(files.deletedAt))).limit(1);
    if (!f) throw notFound("Your CV");
    reply.header("Content-Type", f.mime || "application/octet-stream");
    reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(f.name)}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(readObject(f.storageKey));
  });
}
