import type { FastifyInstance } from "fastify";
import { and, eq, gte, isNotNull, isNull, lt, lte, ne, sql as dsql } from "drizzle-orm";
import { formatMoney, hasAccess, type Workspace } from "@windveal/shared";
import { db } from "../../db/client";
import {
  applications, approvalSteps, approvals, attendance, checklists, deals, employees, files, importJobs, interviews, invitations, jobs, memberships,
  organisations, tasks, users,
} from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { planStorageBytes } from "../../lib/pricing";
import { storageUsed } from "../files/routes";
import { localDate } from "../people/util";

const DAY = 86_400_000;
const count = dsql<number>`count(*)::int`;
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const startOfMonth = () => { const x = startOfDay(); x.setDate(1); return x; };
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

/** One live line on a Home tile: a highlighted figure and the words after it. */
type Line = { value: string; text: string; before?: string };

/**
 * Home: three live lines per workspace the person can open, and the small counts shown in each
 * workspace's sidebar. Everything is counted from real records and respects workspace access.
 */
export default async function homeRoutes(app: FastifyInstance) {
  app.get("/api/home", async (req) => {
    const ctx = await requireOrg(req);
    const orgId = ctx.org.id;
    const can = (ws: Workspace) => hasAccess(ctx.access[ws], "view");
    const today = startOfDay();
    const tomorrow = new Date(today.getTime() + DAY);
    const weekAgo = new Date(today.getTime() - 7 * DAY);
    const todayStr = localDate();
    const money = (v: number) => formatMoney(v, ctx.org.currency, true);
    const tiles: Partial<Record<Workspace | "settings" | "import" | "admin", Line[]>> = {};
    const badges: Record<string, number> = {};

    // Approvals waiting on me (leave requests are approvals too).
    const waiting = await db.select({ kind: approvals.kind, n: count }).from(approvalSteps)
      .innerJoin(approvals, eq(approvals.id, approvalSteps.approvalId))
      .where(and(eq(approvalSteps.orgId, orgId), eq(approvalSteps.approverUserId, ctx.user.id), eq(approvalSteps.status, "pending"), eq(approvals.status, "pending")))
      .groupBy(approvals.kind);
    const waitingLeave = waiting.find((w) => w.kind === "leave")?.n ?? 0;
    const waitingAll = waiting.reduce((a, w) => a + w.n, 0);

    if (can("people")) {
      const people = await db.select({ id: employees.id, startDate: employees.startDate }).from(employees)
        .where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt), ne(employees.status, "left")));
      const current = people.filter((p) => !p.startDate || p.startDate <= todayStr);
      const [inToday] = await db.select({ n: count }).from(attendance)
        .where(and(eq(attendance.orgId, orgId), eq(attendance.workDate, todayStr), isNotNull(attendance.clockIn), isNull(attendance.deletedAt)));
      const soon = people.filter((p) => p.startDate && p.startDate > todayStr && p.startDate <= localDate(new Date(today.getTime() + 14 * DAY)));
      const [onboarding] = await db.select({ n: count }).from(checklists)
        .where(and(eq(checklists.orgId, orgId), eq(checklists.kind, "onboarding"), eq(checklists.status, "in_progress"), isNull(checklists.deletedAt)));
      tiles.people = [
        { value: `${inToday?.n ?? 0} of ${current.length}`, text: "in today" },
        { value: String(waitingLeave), text: `leave ${plural(waitingLeave, "request")} waiting for you` },
        { value: String(soon.length), text: `${plural(soon.length, "person", "people")} starting in the next 2 weeks` },
      ];
      badges.leave = waitingLeave;
      badges.onboarding = onboarding?.n ?? 0;
    }

    if (can("recruitment")) {
      const [iv] = await db.select({ n: count }).from(interviews)
        .where(and(eq(interviews.orgId, orgId), eq(interviews.status, "scheduled"), gte(interviews.scheduledAt, today), lt(interviews.scheduledAt, tomorrow), isNull(interviews.deletedAt)));
      const [apps] = await db.select({ n: count }).from(applications)
        .where(and(eq(applications.orgId, orgId), gte(applications.createdAt, weekAgo), isNull(applications.deletedAt)));
      const [open] = await db.select({ n: count }).from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.status, "open"), isNull(jobs.deletedAt)));
      const [upcoming] = await db.select({ n: count }).from(interviews)
        .where(and(eq(interviews.orgId, orgId), eq(interviews.status, "scheduled"), gte(interviews.scheduledAt, new Date()), isNull(interviews.deletedAt),
          dsql`${interviews.interviewerUserIds} @> ${JSON.stringify([ctx.user.id])}::jsonb`));
      tiles.recruitment = [
        { value: String(iv?.n ?? 0), text: `${plural(iv?.n ?? 0, "interview")} today` },
        { value: String(apps?.n ?? 0), text: `new ${plural(apps?.n ?? 0, "applicant")} this week` },
        { value: String(open?.n ?? 0), text: `open ${plural(open?.n ?? 0, "role")}` },
      ];
      badges.interviews = upcoming?.n ?? 0;
    }

    if (can("crm")) {
      const [open] = await db.select({ n: count, v: dsql<string>`coalesce(sum(${deals.value}),0)` }).from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.status, "open"), isNull(deals.deletedAt)));
      const [won] = await db.select({ n: count }).from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.status, "won"), gte(deals.wonAt, startOfMonth()), isNull(deals.deletedAt)));
      const [follow] = await db.select({ n: count }).from(tasks)
        .where(and(eq(tasks.orgId, orgId), eq(tasks.workspace, "crm"), eq(tasks.assigneeUserId, ctx.user.id), ne(tasks.status, "done"), lt(tasks.dueAt, tomorrow), isNull(tasks.deletedAt)));
      tiles.crm = [
        { value: money(Number(open?.v ?? 0)), text: `in ${open?.n ?? 0} open ${plural(open?.n ?? 0, "deal")}` },
        { value: String(follow?.n ?? 0), text: `${plural(follow?.n ?? 0, "follow-up")} due today` },
        { value: String(won?.n ?? 0), text: `${plural(won?.n ?? 0, "deal")} won this month` },
      ];
      badges.followUps = follow?.n ?? 0;
    }

    if (can("workflows")) {
      const mine = and(eq(tasks.orgId, orgId), eq(tasks.assigneeUserId, ctx.user.id), ne(tasks.status, "done"), isNull(tasks.deletedAt));
      const [dueToday] = await db.select({ n: count }).from(tasks).where(and(mine, gte(tasks.dueAt, today), lt(tasks.dueAt, tomorrow)));
      const [overdue] = await db.select({ n: count }).from(tasks).where(and(mine, lt(tasks.dueAt, today)));
      const [open] = await db.select({ n: count }).from(tasks).where(mine);
      tiles.workflows = [
        { value: String(dueToday?.n ?? 0), text: `${plural(dueToday?.n ?? 0, "task")} due today` },
        { value: String(overdue?.n ?? 0), text: "overdue" },
        { value: String(waitingAll), text: `${plural(waitingAll, "approval")} waiting for you` },
      ];
      badges.myTasks = open?.n ?? 0;
      badges.approvals = waitingAll;
    }

    if (can("documents")) {
      const live = and(eq(files.orgId, orgId), eq(files.kind, "document"), isNull(files.deletedAt), isNull(files.archivedAt));
      const [added] = await db.select({ n: count }).from(files).where(and(live, gte(files.createdAt, weekAgo)));
      const [expiring] = await db.select({ n: count }).from(files)
        .where(and(live, isNotNull(files.expiresOn), gte(files.expiresOn, todayStr), lte(files.expiresOn, localDate(new Date(today.getTime() + 30 * DAY)))));
      const used = await storageUsed(orgId);
      tiles.documents = [
        { value: String(added?.n ?? 0), text: `${plural(added?.n ?? 0, "file")} added this week` },
        { value: String(expiring?.n ?? 0), text: `${plural(expiring?.n ?? 0, "document")} expiring in 30 days` },
        { value: gb(used), text: `of ${gb(planStorageBytes(ctx.org.plan))} used` },
      ];
    }

    if (can("insights")) {
      const monthStart = startOfMonth();
      const lastStart = new Date(monthStart); lastStart.setMonth(lastStart.getMonth() - 1);
      const wonIn = async (from: Date, to: Date) => {
        const [r] = await db.select({ v: dsql<string>`coalesce(sum(${deals.value}),0)` }).from(deals)
          .where(and(eq(deals.orgId, orgId), eq(deals.status, "won"), gte(deals.wonAt, from), lt(deals.wonAt, to), isNull(deals.deletedAt)));
        return Number(r?.v ?? 0);
      };
      const thisMonth = await wonIn(monthStart, new Date(today.getTime() + DAY));
      const lastMonth = await wonIn(lastStart, monthStart);
      const change = lastMonth ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null;
      const [hires] = await db.select({ n: count }).from(applications)
        .where(and(eq(applications.orgId, orgId), isNotNull(applications.hiredAt), gte(applications.hiredAt, monthStart), isNull(applications.deletedAt)));
      const [done] = await db.select({ n: count }).from(tasks)
        .where(and(eq(tasks.orgId, orgId), eq(tasks.status, "done"), gte(tasks.completedAt, weekAgo), isNull(tasks.deletedAt)));
      tiles.insights = [
        change === null
          ? { value: money(thisMonth), text: "won this month" }
          : { before: "Sales", value: `${change >= 0 ? "up" : "down"} ${Math.abs(change)}%`, text: "on last month" },
        { value: String(hires?.n ?? 0), text: `${plural(hires?.n ?? 0, "hire")} this month` },
        { value: String(done?.n ?? 0), text: `${plural(done?.n ?? 0, "task")} finished this week` },
      ];
    }

    // Settings: the team.
    const team = await db.select({ role: memberships.role, n: count }).from(memberships)
      .where(and(eq(memberships.orgId, orgId), isNull(memberships.deletedAt), eq(memberships.status, "active"))).groupBy(memberships.role);
    const members = team.reduce((a, r) => a + r.n, 0);
    const [inv] = await db.select({ n: count }).from(invitations)
      .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gte(invitations.expiresAt, new Date())));
    const admins = team.find((r) => r.role === "admin")?.n ?? 0;
    tiles.settings = [
      { value: String(members), text: `${plural(members, "member")} on the team` },
      { value: String(inv?.n ?? 0), text: `${plural(inv?.n ?? 0, "invitation")} waiting to be accepted` },
      { value: String(admins), text: plural(admins, "admin") },
    ];
    badges.invitations = inv?.n ?? 0;

    // Import data: what's come in this month.
    const canImport = ctx.membership.role === "admin" || ["people", "crm", "recruitment"].some((w) => hasAccess(ctx.access[w as Workspace], "manage"));
    if (canImport) {
      const jobsThisMonth = await db.select({ status: importJobs.status, summary: importJobs.summary }).from(importJobs)
        .where(and(eq(importJobs.orgId, orgId), gte(importJobs.createdAt, startOfMonth()), isNull(importJobs.deletedAt)));
      const done = jobsThisMonth.filter((j) => j.status === "committed");
      const rows = done.reduce((a, j) => a + (j.summary.added ?? 0) + (j.summary.updated ?? 0), 0);
      const open = jobsThisMonth.filter((j) => ["uploaded", "mapping", "reviewing"].includes(j.status)).length;
      tiles.import = [
        { value: String(done.length), text: `${plural(done.length, "import")} finished this month` },
        { value: String(rows), text: `${plural(rows, "record")} added or updated` },
        { value: String(open), text: `${plural(open, "import")} not finished yet` },
      ];
      badges.importsOpen = open;
    }

    // WindVeal admin (WindVeal staff only).
    let adminWaiting: number | null = null;
    if (ctx.user.platformAdmin) {
      const [p] = await db.select({ n: count }).from(organisations)
        .where(and(eq(organisations.verificationStatus, "pending"), isNotNull(organisations.verificationSubmittedAt), eq(organisations.accountStatus, "active"), isNull(organisations.deletedAt)));
      const [o] = await db.select({ n: count }).from(organisations).where(isNull(organisations.deletedAt));
      const [u] = await db.select({ n: count }).from(users);
      adminWaiting = p?.n ?? 0;
      tiles.admin = [
        { value: String(adminWaiting), text: `${plural(adminWaiting, "organisation")} waiting for approval` },
        { value: String(o?.n ?? 0), text: `${plural(o?.n ?? 0, "organisation")} on WindVeal` },
        { value: String(u?.n ?? 0), text: `${plural(u?.n ?? 0, "person", "people")} with an account` },
      ];
      badges.adminWaiting = adminWaiting;
    }
    return { tiles, badges, adminWaiting };
  });
}
