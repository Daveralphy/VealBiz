import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, ne, notInArray, or, sql as dsql } from "drizzle-orm";
import { hasAccess } from "@windveal/shared";
import { db } from "../../db/client";
import {
  applications, approvalSteps, approvals, auditEvents, candidates, companies, deals, employees, files, importJobs, interviews,
  invitations, jobs, leads, leaveRequests, memberships, organisations, tasks, users,
} from "../../db/schema";
import { requireOrg } from "../../lib/context";

const DAY = 86_400_000;
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const count = dsql<number>`count(*)::int`;

export default async function overviewRoutes(app: FastifyInstance) {
  /** Small badge counts for the sidebar. */
  app.get("/api/overview/counts", async (req) => {
    const ctx = await requireOrg(req);
    const [t] = await db.select({ n: count }).from(tasks)
      .where(and(eq(tasks.orgId, ctx.org.id), eq(tasks.assigneeUserId, ctx.user.id), ne(tasks.status, "done"), isNull(tasks.deletedAt)));
    return { tasks: t?.n ?? 0 };
  });

  app.get("/api/overview", async (req) => {
    const ctx = await requireOrg(req);
    const orgId = ctx.org.id;
    const can = (ws: keyof typeof ctx.access) => hasAccess(ctx.access[ws], "view");
    const today = startOfDay();
    const tomorrow = new Date(today.getTime() + DAY);
    const weekAgo = new Date(today.getTime() - 7 * DAY);
    const in14 = new Date(today.getTime() + 14 * DAY);
    const todayStr = ymd(today);

    const kpis: Record<string, { value: number; note?: string; extra?: number } | null> = { team: null, deals: null, roles: null, tasks: null };
    if (can("people")) {
      const active = await db.select({ status: employees.status, n: count }).from(employees)
        .where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt), ne(employees.status, "left"))).groupBy(employees.status);
      const [onLeave] = await db.select({ n: count }).from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "approved"), lte(leaveRequests.startDate, todayStr), gte(leaveRequests.endDate, todayStr), isNull(leaveRequests.deletedAt)));
      kpis.team = { value: active.reduce((s, r) => s + r.n, 0), extra: onLeave?.n ?? 0 };
    }
    if (can("crm")) {
      const [d] = await db.select({ n: count, v: dsql<string>`coalesce(sum(${deals.value}),0)` }).from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.status, "open"), isNull(deals.deletedAt)));
      kpis.deals = { value: d?.n ?? 0, extra: Number(d?.v ?? 0) };
    }
    if (can("recruitment")) {
      const [r] = await db.select({ n: count }).from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.status, "open"), isNull(jobs.deletedAt)));
      const [a] = await db.select({ n: count }).from(applications).where(and(eq(applications.orgId, orgId), gte(applications.createdAt, weekAgo), isNull(applications.deletedAt)));
      kpis.roles = { value: r?.n ?? 0, extra: a?.n ?? 0 };
    }
    const myOpen = and(eq(tasks.orgId, orgId), eq(tasks.assigneeUserId, ctx.user.id), ne(tasks.status, "done"), isNull(tasks.deletedAt));
    const [due] = await db.select({ n: count }).from(tasks).where(and(myOpen, lte(tasks.dueAt, new Date(today.getTime() + 7 * DAY))));
    const [overdue] = await db.select({ n: count }).from(tasks).where(and(myOpen, dsql`${tasks.dueAt} < ${today.toISOString()}`));
    kpis.tasks = { value: due?.n ?? 0, extra: overdue?.n ?? 0 };

    const myTasks = await db.select().from(tasks).where(myOpen)
      .orderBy(dsql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt)).limit(6);

    const approvalRows = await db.select({ a: approvals, s: approvalSteps, u: users }).from(approvalSteps)
      .innerJoin(approvals, eq(approvals.id, approvalSteps.approvalId)).innerJoin(users, eq(users.id, approvals.requestedBy))
      .where(and(eq(approvalSteps.orgId, orgId), eq(approvalSteps.approverUserId, ctx.user.id), eq(approvalSteps.status, "pending"), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt)).limit(5);

    // Coming up: interviews I'm on, deals closing, approved leave starting soon.
    const coming: { date: string; title: string; subtitle: string; href: string }[] = [];
    if (can("recruitment")) {
      const ivs = await db.select({ i: interviews, c: candidates, j: jobs }).from(interviews)
        .innerJoin(applications, eq(applications.id, interviews.applicationId))
        .innerJoin(candidates, eq(candidates.id, applications.candidateId)).innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(and(eq(interviews.orgId, orgId), eq(interviews.status, "scheduled"), gte(interviews.scheduledAt, today), lte(interviews.scheduledAt, in14), isNull(interviews.deletedAt)))
        .orderBy(interviews.scheduledAt).limit(5);
      for (const { i, c, j } of ivs) {
        coming.push({ date: i.scheduledAt.toISOString(), title: `Interview: ${c.firstName} ${c.lastName}`, subtitle: `${j.title} · ${i.scheduledAt.toISOString().slice(11, 16)}`, href: "/recruitment/interviews" });
      }
    }
    if (can("crm")) {
      const ds = await db.select({ d: deals, c: companies }).from(deals).innerJoin(companies, eq(companies.id, deals.companyId))
        .where(and(eq(deals.orgId, orgId), eq(deals.status, "open"), gte(deals.expectedCloseOn, todayStr), lte(deals.expectedCloseOn, ymd(in14)), isNull(deals.deletedAt))).limit(5);
      for (const { d, c } of ds) coming.push({ date: d.expectedCloseOn!, title: `${d.name} expected to close`, subtitle: c.name, href: `/crm/companies/${c.id}` });
    }
    if (can("people")) {
      const lv = await db.select({ l: leaveRequests, e: employees }).from(leaveRequests).innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
        .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "approved"), gte(leaveRequests.startDate, todayStr), lte(leaveRequests.startDate, ymd(in14)), isNull(leaveRequests.deletedAt))).limit(5);
      for (const { l, e } of lv) coming.push({ date: l.startDate, title: `${e.firstName} ${e.lastName} on leave`, subtitle: `${Number(l.days)} day${Number(l.days) === 1 ? "" : "s"}`, href: "/people/leave" });
    }
    coming.sort((a, b) => a.date.localeCompare(b.date));

    // Recent activity: data changes only (no access/sensitive events).
    const activity = await db.select({ e: auditEvents, u: users }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.orgId, orgId), inArray(auditEvents.category, ["data", "general"]), dsql`${auditEvents.action} not like '%pay%'`))
      .orderBy(desc(auditEvents.createdAt)).limit(6);

    // Finish-setting-up checklist.
    const [members] = await db.select({ n: count }).from(memberships).where(and(eq(memberships.orgId, orgId), isNull(memberships.deletedAt)));
    const [invites] = await db.select({ n: count }).from(invitations).where(eq(invitations.orgId, orgId));
    const [emps] = await db.select({ n: count }).from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));
    const [imports] = await db.select({ n: count }).from(importJobs).where(and(eq(importJobs.orgId, orgId), eq(importJobs.status, "committed")));
    const [jobCount] = await db.select({ n: count }).from(jobs).where(and(eq(jobs.orgId, orgId), isNull(jobs.deletedAt)));
    const [companyCount] = await db.select({ n: count }).from(companies).where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt)));
    const setup = [
      { key: "details", label: "Add business details", done: true, href: "/profile/company" },
      { key: "logo", label: "Add your logo", done: !!ctx.org.logoFileId, href: "/profile/company/edit" },
      { key: "team", label: "Invite your team", done: (members?.n ?? 0) > 1 || (invites?.n ?? 0) > 0, href: "/settings" },
      { key: "import", label: "Import your data", done: (imports?.n ?? 0) > 0, href: "/import" },
      { key: "people", label: "Add your first employee", done: (emps?.n ?? 0) > 0, href: "/people/directory?new=employee" },
      { key: "clients", label: "Add a client or lead", done: (companyCount?.n ?? 0) > 0, href: "/crm/leads?new=lead" },
      { key: "job", label: "Post your first job", done: (jobCount?.n ?? 0) > 0, href: "/recruitment/jobs/new" },
    ];

    return {
      kpis,
      myTasks: myTasks.map((t) => ({ id: t.id, title: t.title, workspace: t.workspace, linkLabel: t.linkLabel, dueAt: t.dueAt, priority: t.priority })),
      approvals: approvalRows.map(({ a, u }) => ({ id: a.id, kind: a.kind, title: a.title, details: a.details, amount: a.amount, requestedBy: u.name, createdAt: a.createdAt })),
      comingUp: coming.slice(0, 6),
      activity: activity.map(({ e, u }) => ({ id: e.id, summary: e.summary, actor: u?.name ?? "Someone", createdAt: e.createdAt })),
      setup: ctx.membership.role === "admin" ? setup : null,
    };
  });

  /**
   * Search. From Home it covers everything the person can see; inside an area (`scope`) it covers that area only.
   */
  app.get<{ Querystring: { q?: string; scope?: string } }>("/api/search", async (req) => {
    const ctx = await requireOrg(req);
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return { results: [] };
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const orgId = ctx.org.id;
    const scope = req.query.scope || "all";
    const here = (area: string) => scope === "all" || scope === area;
    const can = (ws: keyof typeof ctx.access) => here(ws) && hasAccess(ctx.access[ws], "view");
    const results: { type: string; id: string; title: string; subtitle?: string; href: string }[] = [];
    if (can("people")) {
      const rows = await db.select().from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt),
        or(ilike(dsql`${employees.firstName} || ' ' || ${employees.lastName}`, like), ilike(employees.jobTitle, like), ilike(employees.email, like)))).limit(5);
      for (const e of rows) results.push({ type: "People", id: e.id, title: `${e.firstName} ${e.lastName}`, subtitle: e.jobTitle ?? undefined, href: `/people/employees/${e.id}` });
    }
    if (can("crm")) {
      const cs = await db.select().from(companies).where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt), ilike(companies.name, like))).limit(5);
      for (const c of cs) results.push({ type: "Companies", id: c.id, title: c.name, subtitle: c.status, href: `/crm/companies/${c.id}` });
      const ds = await db.select().from(deals).where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), ilike(deals.name, like))).limit(5);
      for (const d of ds) results.push({ type: "Deals", id: d.id, title: d.name, subtitle: d.stage, href: `/crm/companies/${d.companyId}` });
      const ls = await db.select().from(leads).where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), or(ilike(leads.companyName, like), ilike(leads.contactName, like)))).limit(5);
      for (const l of ls) results.push({ type: "Leads", id: l.id, title: l.companyName, subtitle: l.stage, href: `/crm/leads?lead=${l.id}` });
    }
    if (can("recruitment")) {
      const js = await db.select().from(jobs).where(and(eq(jobs.orgId, orgId), isNull(jobs.deletedAt), ilike(jobs.title, like))).limit(5);
      for (const j of js) results.push({ type: "Jobs", id: j.id, title: j.title, subtitle: j.status, href: `/recruitment/jobs/${j.id}` });
      const cs = await db.select({ a: applications, c: candidates, j: jobs }).from(applications)
        .innerJoin(candidates, eq(candidates.id, applications.candidateId)).innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(and(eq(applications.orgId, orgId), isNull(applications.deletedAt), or(ilike(dsql`${candidates.firstName} || ' ' || ${candidates.lastName}`, like), ilike(candidates.email, like)))).limit(5);
      for (const { a, c, j } of cs) results.push({ type: "Candidates", id: a.id, title: `${c.firstName} ${c.lastName}`, subtitle: j.title, href: `/recruitment/applications/${a.id}` });
    }
    if (can("documents")) {
      const fs = await db.select().from(files).where(and(eq(files.orgId, orgId), isNull(files.deletedAt), eq(files.kind, "document"), ilike(files.name, like))).limit(5);
      for (const f of fs) results.push({ type: "Files", id: f.id, title: f.name, href: `/documents/files/${f.id}` });
    }
    if (can("workflows")) {
      const ts = await db.select().from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), ilike(tasks.title, like),
        or(eq(tasks.assigneeUserId, ctx.user.id), eq(tasks.createdBy, ctx.user.id), notInArray(tasks.workspace, ["people"])))).limit(5);
      for (const t of ts) results.push({ type: "Tasks", id: t.id, title: t.title, subtitle: t.linkLabel ?? undefined, href: `/me/tasks?task=${t.id}` });
    }
    // Settings: the team (for people who manage members).
    if (here("settings") && (ctx.membership.role === "admin" || ctx.special.includes("manage_members"))) {
      const ms = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, orgId), isNull(memberships.deletedAt), or(ilike(users.name, like), ilike(users.email, like)))).limit(5);
      for (const { m, u } of ms) results.push({ type: "Members", id: m.id, title: u.name, subtitle: m.jobTitle ?? u.email, href: `/settings/members/${m.id}` });
    }
    // WindVeal admin: businesses and accounts (WindVeal staff only).
    if (here("admin") && ctx.user.platformAdmin) {
      const os = await db.select().from(organisations).where(and(isNull(organisations.deletedAt),
        or(ilike(organisations.legalName, like), ilike(organisations.tradingName, like), ilike(organisations.registrationNumber, like)))).limit(5);
      for (const o of os) results.push({ type: "Businesses", id: o.id, title: o.tradingName || o.legalName, subtitle: o.registrationNumber ?? undefined, href: `/admin/organisations/${o.id}` });
      const us = await db.select().from(users).where(or(ilike(users.name, like), ilike(users.email, like))).limit(5);
      for (const u of us) results.push({ type: "Accounts", id: u.id, title: u.name, subtitle: u.email, href: `/admin/people/${u.id}` });
    }
    return { results };
  });
}
