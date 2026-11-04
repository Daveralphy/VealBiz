import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, isNull, lte, ne, or, sql as dsql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "../../db/client";
import {
  approvalSteps, approvals, checklists, departments, employeePay, employees, employmentHistory, fileLinks, files, leaveRequests,
  memberships, sessions, taskTemplates, users,
} from "../../db/schema";
import { can, requireAccess, requireOrg, type OrgContext } from "../../lib/context";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { startChecklist } from "../../lib/tasks";
import { toCsv } from "../../lib/csv";
import { fileView } from "../files/routes";
import {
  balancesFor, checklistProgress, dateStr, employeeSummary, fullName, getDepartment, getEmployee, hasLevel, myEmployee, notDeleted, optDate, optId, optText,
  syncLeaveStatuses, type Employee,
  getTeamEmployee, inTeam, teamScope,
} from "./shared";
import { localDate } from "./util";
import leaveRoutes from "./leave";
import attendanceRoutes from "./attendance";
import onboardingRoutes from "./onboarding";
import mySpaceRoutes from "./me";

const mgr = alias(employees, "mgr");
const STATUSES = ["onboarding", "active", "on_leave", "leaving", "left"] as const;

const employeeFields = {
  email: z.union([z.string().trim().toLowerCase().email("Enter a valid email address").max(200), z.literal(""), z.null()]).optional()
    .transform((v) => (v === "" ? null : v)),
  phone: optText(40),
  jobTitle: optText(120),
  departmentId: optId,
  managerId: optId,
  location: optText(120),
  employmentType: optText(60),
  startDate: optDate,
  employeeCode: optText(40),
  dateOfBirth: optDate,
  homeAddress: optText(300),
  emergencyContact: optText(200),
  nationalId: optText(60),
};
const createInput = z.object({
  firstName: z.string().trim().min(1, "Enter a first name").max(80),
  lastName: z.string().trim().min(1, "Enter a last name").max(80),
  ...employeeFields,
  startOnboarding: z.boolean().optional(),
});
const updateInput = z.object({
  firstName: z.string().trim().min(1, "Enter a first name").max(80).optional(),
  lastName: z.string().trim().min(1, "Enter a last name").max(80).optional(),
  ...employeeFields,
});
const payInput = z.object({
  salaryAmount: z.union([z.literal(""), z.null(), z.coerce.number({ invalid_type_error: "Enter an amount" }).min(0, "Enter a positive amount").max(1e12)]).optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  currency: optText(3),
  payFrequency: optText(30),
  bankName: optText(120),
  accountNumber: optText(40),
});
const deptInput = z.object({
  name: z.string().trim().min(1, "Enter a department name").max(80),
  headEmployeeId: optId,
});

async function deptName(orgId: string, id: string | null | undefined) {
  if (!id) return null;
  return (await getDepartment(orgId, id)).name;
}

/** Validates a manager choice: same organisation, not themselves, and no reporting loops. */
async function checkManager(orgId: string, employeeId: string | null, managerId: string | null | undefined) {
  if (!managerId) return null;
  if (managerId === employeeId) throw badRequest("Some details need fixing.", { managerId: "Someone can't be their own manager" });
  let cur: Employee | null = await getEmployee(orgId, managerId).catch(() => null);
  if (!cur) throw badRequest("Some details need fixing.", { managerId: "Choose someone from your organisation" });
  const m = cur;
  for (let i = 0; i < 50 && cur?.managerId; i++) {
    if (cur.managerId === employeeId) throw badRequest("Some details need fixing.", { managerId: "That would create a reporting loop" });
    cur = (await db.select().from(employees).where(eq(employees.id, cur.managerId)).limit(1))[0] ?? null;
  }
  return m;
}

/** Links an employee to a WindVeal user in this organisation by matching email. */
async function memberUserIdByEmail(orgId: string, email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const [r] = await db.select({ userId: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), isNull(memberships.deletedAt), eq(users.email, email))).limit(1);
  if (!r) return null;
  const [taken] = await db.select({ id: employees.id }).from(employees).where(and(notDeleted(orgId), eq(employees.userId, r.userId))).limit(1);
  return taken ? null : r.userId;
}

async function nextEmployeeCode(orgId: string) {
  const [r] = await db.select({ n: count() }).from(employees).where(eq(employees.orgId, orgId));
  return `EMP-${String((r?.n ?? 0) + 1).padStart(4, "0")}`;
}

async function pendingForMeCount(ctx: OrgContext) {
  const [r] = await db.select({ n: count() }).from(approvalSteps).innerJoin(approvals, eq(approvals.id, approvalSteps.approvalId))
    .where(and(eq(approvalSteps.orgId, ctx.org.id), eq(approvalSteps.approverUserId, ctx.user.id), eq(approvalSteps.status, "pending"),
      eq(approvals.kind, "leave"), eq(approvals.status, "pending"), isNull(approvals.deletedAt)));
  return r?.n ?? 0;
}

function listFilters(orgId: string, q: { search?: string; departmentId?: string; location?: string; status?: string }, team: string[] | null = null) {
  const conds = [notDeleted(orgId), inTeam(team)];
  if (q.search?.trim()) {
    const pat = `%${q.search.trim().replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(
      ilike(dsql`(${employees.firstName} || ' ' || ${employees.lastName})`, pat), ilike(employees.jobTitle, pat),
      ilike(departments.name, pat), ilike(employees.email, pat),
    )!);
  }
  if (q.departmentId) conds.push(q.departmentId === "none" ? isNull(employees.departmentId) : eq(employees.departmentId, q.departmentId));
  if (q.location) conds.push(eq(employees.location, q.location));
  const st = q.status ?? "current";
  if (st === "current") conds.push(ne(employees.status, "left"));
  else if ((STATUSES as readonly string[]).includes(st)) conds.push(eq(employees.status, st as Employee["status"]));
  return and(...conds);
}

export default async function peopleRoutes(app: FastifyInstance) {
  await app.register(leaveRoutes);
  await app.register(attendanceRoutes);
  await app.register(onboardingRoutes);
  await app.register(mySpaceRoutes);

  // ---------------- overview ----------------
  app.get("/api/people/stats", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    await syncLeaveStatuses(ctx.org.id);
    const today = localDate();
    const team = await teamScope(ctx);
    const current = await db.select().from(employees).where(and(notDeleted(ctx.org.id), ne(employees.status, "left"), inTeam(team)));
    const [deptCount] = await db.select({ n: count() }).from(departments).where(and(eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt)));
    const m = Number(today.slice(5, 7));
    const quarterStart = `${today.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
    const onLeaveRows = await db.select({ id: employees.id, firstName: employees.firstName, endDate: leaveRequests.endDate })
      .from(leaveRequests).innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
      .where(and(eq(leaveRequests.orgId, ctx.org.id), eq(leaveRequests.status, "approved"), isNull(leaveRequests.deletedAt),
        isNull(employees.deletedAt), lte(leaveRequests.startDate, today), gte(leaveRequests.endDate, today), inTeam(team)));
    const onLeave = [...new Map(onLeaveRows.map((r) => [r.id, r])).values()];
    const in14 = localDate(new Date(Date.now() + 14 * 86_400_000));
    const starting = current.filter((e) => e.status === "onboarding" || (e.startDate && e.startDate > today))
      .sort((a, b) => (a.startDate ?? "9999").localeCompare(b.startDate ?? "9999"));
    const leaving = current.filter((e) => e.status === "leaving").sort((a, b) => (a.endDate ?? "9999").localeCompare(b.endDate ?? "9999"));
    const [onb] = await db.select({ n: count() }).from(checklists)
      .innerJoin(employees, eq(employees.id, checklists.employeeId))
      .where(and(eq(checklists.orgId, ctx.org.id), eq(checklists.status, "in_progress"), isNull(checklists.deletedAt), isNull(employees.deletedAt), inTeam(team)));
    return {
      headcount: current.length,
      joinedThisQuarter: current.filter((e) => e.startDate && e.startDate >= quarterStart && e.startDate <= today).length,
      departments: deptCount?.n ?? 0,
      onLeaveToday: {
        count: onLeave.length, names: onLeave.map((e) => e.firstName),
        // The last day anyone is away (when the latest of today's leave ends).
        until: onLeaveRows.length ? onLeaveRows.reduce((m, r) => (r.endDate > m ? r.endDate : m), today) : null,
      },
      startingSoon: {
        count: starting.length, nextStart: starting.find((e) => e.startDate && e.startDate >= today)?.startDate ?? null,
        next14Days: current.filter((e) => e.startDate && e.startDate >= today && e.startDate <= in14).length,
      },
      leaving: { count: leaving.length, next: leaving[0] ? { name: leaving[0].firstName, endDate: leaving[0].endDate } : null },
      pendingForMe: await pendingForMeCount(ctx),
      onboardingInProgress: onb?.n ?? 0,
      myEmployeeId: (await myEmployee(ctx))?.id ?? null,
    };
  });

  // ---------------- employees ----------------
  app.get<{ Querystring: { search?: string; departmentId?: string; location?: string; status?: string; page?: string; pageSize?: string } }>(
    "/api/people/employees", async (req) => {
      const ctx = await requireAccess(req, "people", "view");
      await syncLeaveStatuses(ctx.org.id);
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
      const where = listFilters(ctx.org.id, req.query, await teamScope(ctx));
      const base = () => db.select({ e: employees, dept: departments.name, mFirst: mgr.firstName, mLast: mgr.lastName }).from(employees)
        .leftJoin(departments, eq(departments.id, employees.departmentId))
        .leftJoin(mgr, eq(mgr.id, employees.managerId));
      const [total] = await db.select({ n: count() }).from(employees).leftJoin(departments, eq(departments.id, employees.departmentId)).where(where);
      const rows = await base().where(where).orderBy(asc(employees.firstName), asc(employees.lastName))
        .limit(pageSize).offset((page - 1) * pageSize);
      const locs = await db.selectDistinct({ l: employees.location }).from(employees)
        .where(and(notDeleted(ctx.org.id), dsql`${employees.location} is not null`)).orderBy(employees.location);
      return {
        items: rows.map((r) => employeeSummary(r.e, { departmentName: r.dept, managerName: r.mFirst ? `${r.mFirst} ${r.mLast}` : null })),
        total: total?.n ?? 0, page, pageSize, locations: locs.map((l) => l.l).filter(Boolean),
      };
    });

  /** Light list for pickers (manager, head of department…). */
  app.get("/api/people/employees/options", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    const rows = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, jobTitle: employees.jobTitle,
      departmentId: employees.departmentId, userId: employees.userId, status: employees.status })
      .from(employees).where(and(notDeleted(ctx.org.id), ne(employees.status, "left"))).orderBy(employees.firstName, employees.lastName);
    return rows.map((r) => ({ ...r, name: fullName(r) }));
  });

  app.get<{ Querystring: { search?: string; departmentId?: string; location?: string; status?: string } }>("/api/people/employees/export", async (req, reply) => {
    const ctx = await requireAccess(req, "people", "view");
    if (!can(ctx, "export_data")) throw forbidden("You don't have permission to export data.");
    const rows = await db.select({ e: employees, dept: departments.name, mFirst: mgr.firstName, mLast: mgr.lastName }).from(employees)
      .leftJoin(departments, eq(departments.id, employees.departmentId)).leftJoin(mgr, eq(mgr.id, employees.managerId))
      .where(listFilters(ctx.org.id, req.query, await teamScope(ctx))).orderBy(employees.firstName, employees.lastName);
    await audit(ctx, { action: "people.exported", category: "data", summary: `${ctx.user.name} exported ${rows.length} people` });
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="people-${localDate()}.csv"`);
    return toCsv(
      ["Employee ID", "First name", "Last name", "Email", "Phone", "Job title", "Department", "Manager", "Location", "Employment type", "Start date", "End date", "Status"],
      rows.map(({ e, dept, mFirst, mLast }) => [e.employeeCode, e.firstName, e.lastName, e.email, e.phone, e.jobTitle, dept,
        mFirst ? `${mFirst} ${mLast}` : "", e.location, e.employmentType, e.startDate, e.endDate, e.status]),
    );
  });

  app.get<{ Params: { id: string } }>("/api/people/employees/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    await syncLeaveStatuses(ctx.org.id);
    const e = await getTeamEmployee(ctx, req.params.id);
    const isSelf = e.userId === ctx.user.id;
    const canEdit = hasLevel(ctx, "edit");
    const department = e.departmentId ? (await db.select().from(departments).where(eq(departments.id, e.departmentId)).limit(1))[0] : null;
    const manager = e.managerId ? (await db.select().from(employees).where(and(eq(employees.id, e.managerId), isNull(employees.deletedAt))).limit(1))[0] : null;
    const reports = await db.select().from(employees)
      .where(and(notDeleted(ctx.org.id), eq(employees.managerId, e.id), ne(employees.status, "left"))).orderBy(employees.firstName);
    const docs = await db.select({ f: files, l: fileLinks }).from(fileLinks).innerJoin(files, eq(files.id, fileLinks.fileId))
      .where(and(eq(fileLinks.orgId, ctx.org.id), eq(fileLinks.linkType, "employee"), eq(fileLinks.linkId, e.id), isNull(files.deletedAt)))
      .orderBy(desc(fileLinks.createdAt));
    const history = await db.select({ h: employmentHistory, actor: users.name }).from(employmentHistory)
      .leftJoin(users, eq(users.id, employmentHistory.actorUserId))
      .where(and(eq(employmentHistory.orgId, ctx.org.id), eq(employmentHistory.employeeId, e.id)))
      .orderBy(desc(employmentHistory.occurredOn), desc(employmentHistory.createdAt));
    const clRows = await db.select().from(checklists)
      .where(and(eq(checklists.orgId, ctx.org.id), eq(checklists.employeeId, e.id), isNull(checklists.deletedAt)))
      .orderBy(desc(checklists.createdAt));
    const prog = await checklistProgress(clRows.map((c) => c.id));
    const cls = clRows.map((c) => ({ c, total: prog.get(c.id)?.total ?? 0, done: prog.get(c.id)?.done ?? 0 }));
    const showPersonal = canEdit || isSelf;
    const mask = (s: string | null) => (s && !canEdit ? `${s.slice(0, 3)}${"•".repeat(Math.max(0, s.length - 4))}${s.slice(-1)}` : s);
    return {
      ...employeeSummary(e, { departmentName: department?.name ?? null, managerName: manager ? fullName(manager) : null }),
      reference: e.reference,
      // Columns kept from an imported spreadsheet can hold anything, so they're private like personal details.
      extraDetails: showPersonal ? e.extraDetails : {},
      personal: showPersonal ? {
        dateOfBirth: e.dateOfBirth, homeAddress: e.homeAddress, emergencyContact: e.emergencyContact, nationalId: mask(e.nationalId),
      } : null,
      manager: manager ? { id: manager.id, name: fullName(manager), jobTitle: manager.jobTitle } : null,
      reports: reports.map((r) => ({ id: r.id, name: fullName(r), jobTitle: r.jobTitle })),
      balances: await balancesFor(ctx.org.id, e.id),
      // Contracts and IDs are private: only HR (people "edit") and the person themself see them.
      documents: showPersonal ? docs.map(({ f, l }) => ({ ...fileView(f), linkId: l.id, label: l.label })) : [],
      documentsHidden: !showPersonal,
      history: history.map(({ h, actor }) => ({ id: h.id, occurredOn: h.occurredOn, event: h.event, details: h.details, actorName: actor })),
      checklists: cls.map(({ c, total, done }) => ({ id: c.id, kind: c.kind, title: c.title, status: c.status, total, done })),
      canSeePay: can(ctx, "see_pay"),
      isSelf,
      hasAccount: !!e.userId,
    };
  });

  app.post("/api/people/employees", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const input = parse(createInput, req.body);
    const dName = await deptName(ctx.org.id, input.departmentId).catch(() => {
      throw badRequest("Some details need fixing.", { departmentId: "Choose a department" });
    });
    await checkManager(ctx.org.id, null, input.managerId);
    if (input.email) {
      const [dup] = await db.select().from(employees)
        .where(and(notDeleted(ctx.org.id), dsql`lower(${employees.email}) = lower(${input.email})`, ne(employees.status, "left"))).limit(1);
      // A member who joined is already on the team (their record was made for them): HR's details fill it in.
      if (dup?.userId) {
        const { startOnboarding: _ignored, ...details } = input;
        const fill = Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        const [e] = await db.update(employees).set({ ...fill, version: dsql`${employees.version} + 1` }).where(eq(employees.id, dup.id)).returning();
        return { employee: employeeSummary(e!, { departmentName: dName }), checklistId: null, notice: `${fullName(e!)} was already on the team, so their record was updated.` };
      }
      if (dup) throw conflict("Someone with this email is already in your directory.", { email: "Already in your directory" });
    }
    const today = localDate();
    const startDate = input.startDate ?? today;
    const willOnboard = input.startOnboarding === true;
    const status = startDate > today || willOnboard ? "onboarding" : "active";
    const { startOnboarding: _s, ...fields } = input;
    const result = await db.transaction(async (tx) => {
      const [e] = await tx.insert(employees).values({
        ...fields, orgId: ctx.org.id, startDate, status,
        employeeCode: input.employeeCode ?? (await nextEmployeeCode(ctx.org.id)),
        userId: await memberUserIdByEmail(ctx.org.id, input.email),
      }).returning();
      await tx.insert(employmentHistory).values({
        orgId: ctx.org.id, employeeId: e!.id, occurredOn: startDate, actorUserId: ctx.user.id,
        event: `Joined${input.jobTitle ? ` as ${input.jobTitle}` : ""}`, details: dName ? `${dName} department` : null,
      });
      let checklistId: string | null = null;
      let onboardingNote: string | null = null;
      if (willOnboard) {
        const cl = await startChecklist({ orgId: ctx.org.id, employeeId: e!.id, kind: "onboarding", anchorDate: startDate, createdBy: ctx.user.id, tx });
        checklistId = cl?.id ?? null;
        if (!cl) onboardingNote = "No onboarding checklist template is set up yet, so no tasks were created.";
      }
      await audit(ctx, { action: "employee.created", category: "data", entityType: "employee", entityId: e!.id,
        summary: `${ctx.user.name} added ${fullName(e!)} to People` }, tx);
      return { employee: e!, checklistId, onboardingNote };
    });
    return { employee: employeeSummary(result.employee, { departmentName: dName }), checklistId: result.checklistId, notice: result.onboardingNote };
  });

  app.patch<{ Params: { id: string } }>("/api/people/employees/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const e = await getTeamEmployee(ctx, req.params.id);
    const input = parse(updateInput, req.body);
    const patch: Partial<typeof employees.$inferInsert> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    const events: { event: string; details?: string | null }[] = [];
    if (patch.departmentId !== undefined && patch.departmentId !== e.departmentId) {
      const name = await deptName(ctx.org.id, patch.departmentId).catch(() => {
        throw badRequest("Some details need fixing.", { departmentId: "Choose a department" });
      });
      events.push({ event: name ? `Moved to ${name}` : "Removed from department", details: e.departmentId ? `from ${await deptName(ctx.org.id, e.departmentId).catch(() => "a removed department")}` : null });
    }
    if (patch.managerId !== undefined && patch.managerId !== e.managerId) {
      const m = await checkManager(ctx.org.id, e.id, patch.managerId);
      events.push({ event: m ? `Now reports to ${fullName(m)}` : "No longer has a manager" });
    }
    if (patch.jobTitle !== undefined && patch.jobTitle !== e.jobTitle && patch.jobTitle) {
      events.push({ event: `Became ${patch.jobTitle}`, details: e.jobTitle ? `previously ${e.jobTitle}` : null });
    }
    if (patch.location !== undefined && patch.location !== e.location && patch.location) {
      events.push({ event: `Moved to ${patch.location}`, details: e.location ? `from ${e.location}` : null });
    }
    if (patch.email && patch.email !== e.email && !e.userId) patch.userId = await memberUserIdByEmail(ctx.org.id, patch.email);
    if (Object.keys(patch).length === 0) return { employee: employeeSummary(e) };
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(employees).set({ ...patch, version: dsql`${employees.version} + 1` }).where(eq(employees.id, e.id)).returning();
      for (const ev of events) {
        await tx.insert(employmentHistory).values({ orgId: ctx.org.id, employeeId: e.id, occurredOn: localDate(), actorUserId: ctx.user.id, ...ev });
      }
      await audit(ctx, { action: "employee.updated", category: "data", entityType: "employee", entityId: e.id,
        summary: `${ctx.user.name} updated ${fullName(u!)}'s details`, meta: { fields: Object.keys(patch) } }, tx);
      return u!;
    });
    return { employee: employeeSummary(updated) };
  });

  /** Mark leaving: sets the last day and starts the offboarding checklist. */
  app.post<{ Params: { id: string } }>("/api/people/employees/:id/leaving", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const e = await getTeamEmployee(ctx, req.params.id);
    const { endDate, reason } = parse(z.object({ endDate: dateStr, reason: optText(300) }), req.body);
    if (e.status === "left") throw conflict(`${fullName(e)} has already left.`);
    if (e.startDate && endDate < e.startDate) throw badRequest("Some details need fixing.", { endDate: "The last day can't be before the start date" });
    const r = await db.transaction(async (tx) => {
      await tx.update(employees).set({ endDate, status: "leaving", version: dsql`${employees.version} + 1` }).where(eq(employees.id, e.id));
      await tx.insert(employmentHistory).values({ orgId: ctx.org.id, employeeId: e.id, occurredOn: localDate(), actorUserId: ctx.user.id,
        event: `Leaving on ${endDate}`, details: reason ?? null });
      const [existing] = await tx.select().from(checklists).where(and(eq(checklists.employeeId, e.id), eq(checklists.kind, "offboarding"),
        eq(checklists.status, "in_progress"), isNull(checklists.deletedAt))).limit(1);
      const cl = existing ?? await startChecklist({ orgId: ctx.org.id, employeeId: e.id, kind: "offboarding", anchorDate: endDate, createdBy: ctx.user.id, tx });
      await audit(ctx, { action: "employee.leaving", category: "data", entityType: "employee", entityId: e.id,
        summary: `${ctx.user.name} marked ${fullName(e)} as leaving on ${endDate}` }, tx);
      return cl;
    });
    return { ok: true, checklistId: r?.id ?? null };
  });

  /** Mark left: offboarding removes access — suspends their membership and signs them out everywhere. */
  app.post<{ Params: { id: string } }>("/api/people/employees/:id/left", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const e = await getTeamEmployee(ctx, req.params.id);
    const { endDate } = parse(z.object({ endDate: optDate }), req.body);
    if (e.status === "left") throw conflict(`${fullName(e)} has already left.`);
    const last = endDate ?? e.endDate ?? localDate();
    let membership: typeof memberships.$inferSelect | undefined;
    if (e.userId) {
      if (e.userId === ctx.user.id) throw forbidden("You can't mark yourself as left.");
      [membership] = await db.select().from(memberships)
        .where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.userId, e.userId), isNull(memberships.deletedAt))).limit(1);
      if (membership?.isPrimaryAdmin) throw forbidden("The primary admin can't be offboarded. Transfer primary admin first.");
    }
    await db.transaction(async (tx) => {
      await tx.update(employees).set({ status: "left", endDate: last, version: dsql`${employees.version} + 1` }).where(eq(employees.id, e.id));
      await tx.insert(employmentHistory).values({ orgId: ctx.org.id, employeeId: e.id, occurredOn: last, actorUserId: ctx.user.id, event: "Left the organisation" });
      // Pending leave no longer applies.
      await tx.update(leaveRequests).set({ status: "cancelled", version: dsql`${leaveRequests.version} + 1` })
        .where(and(eq(leaveRequests.employeeId, e.id), eq(leaveRequests.status, "pending")));
      if (membership) {
        await tx.update(memberships).set({ status: "suspended", version: dsql`${memberships.version} + 1` }).where(eq(memberships.id, membership.id));
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, e.userId!), isNull(sessions.revokedAt)));
        await audit(ctx, { action: "member.updated", category: "access", entityType: "membership", entityId: membership.id,
          summary: `${ctx.user.name} removed ${fullName(e)}'s access to WindVeal (offboarding)` }, tx);
      }
      await audit(ctx, { action: "employee.left", category: "data", entityType: "employee", entityId: e.id,
        summary: `${ctx.user.name} marked ${fullName(e)} as left on ${last}` }, tx);
    });
    return { ok: true, accessRemoved: !!membership };
  });

  app.delete<{ Params: { id: string } }>("/api/people/employees/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const e = await getTeamEmployee(ctx, req.params.id);
    await db.transaction(async (tx) => {
      await tx.update(employees).set({ deletedAt: new Date(), version: dsql`${employees.version} + 1` }).where(eq(employees.id, e.id));
      await tx.update(employees).set({ managerId: null, version: dsql`${employees.version} + 1` }).where(eq(employees.managerId, e.id));
      await tx.update(departments).set({ headEmployeeId: null, version: dsql`${departments.version} + 1` }).where(eq(departments.headEmployeeId, e.id));
      await audit(ctx, { action: "employee.deleted", category: "data", entityType: "employee", entityId: e.id, summary: `${ctx.user.name} deleted ${fullName(e)}'s record` }, tx);
    });
    return { ok: true };
  });

  /** Starts a checklist by hand (e.g. onboarding wasn't started when the person was added). */
  app.post<{ Params: { id: string } }>("/api/people/employees/:id/checklists", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const e = await getTeamEmployee(ctx, req.params.id);
    const { kind, templateId } = parse(z.object({ kind: z.enum(["onboarding", "offboarding"]), templateId: optId }), req.body);
    if (templateId) {
      const [t] = await db.select().from(taskTemplates).where(and(eq(taskTemplates.id, templateId), eq(taskTemplates.orgId, ctx.org.id))).limit(1);
      if (!t) throw notFound("That template");
    }
    const anchor = kind === "onboarding" ? e.startDate ?? localDate() : e.endDate ?? localDate();
    const cl = await startChecklist({ orgId: ctx.org.id, employeeId: e.id, kind, templateId, anchorDate: anchor, createdBy: ctx.user.id });
    if (!cl) throw badRequest(`There's no ${kind} checklist template yet. Create one in Workflows first.`);
    await audit(ctx, { action: "checklist.started", category: "data", entityType: "employee", entityId: e.id, summary: `${ctx.user.name} started ${cl.title}` });
    return { checklistId: cl.id };
  });

  app.delete<{ Params: { id: string; linkId: string } }>("/api/people/employees/:id/documents/:linkId", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const e = await getTeamEmployee(ctx, req.params.id);
    const [l] = await db.select().from(fileLinks).where(and(eq(fileLinks.id, req.params.linkId), eq(fileLinks.orgId, ctx.org.id),
      eq(fileLinks.linkType, "employee"), eq(fileLinks.linkId, e.id))).limit(1);
    if (!l) throw notFound("That document");
    await db.delete(fileLinks).where(eq(fileLinks.id, l.id));
    await audit(ctx, { action: "employee.document_removed", category: "data", entityType: "employee", entityId: e.id, summary: `${ctx.user.name} removed a document from ${fullName(e)}'s profile` });
    return { ok: true };
  });

  // ---------------- pay (sensitive; permission-checked and audited) ----------------
  app.get<{ Params: { id: string } }>("/api/people/employees/:id/pay", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    if (!can(ctx, "see_pay")) throw forbidden("You don't have permission to see pay details.");
    const e = await getTeamEmployee(ctx, req.params.id);
    const [p] = await db.select().from(employeePay).where(and(eq(employeePay.employeeId, e.id), eq(employeePay.orgId, ctx.org.id))).limit(1);
    await audit(ctx, { action: "pay.viewed", category: "access", entityType: "employee", entityId: e.id, summary: `${ctx.user.name} viewed pay details for ${fullName(e)}` });
    return {
      salaryAmount: p?.salaryAmount ?? null, currency: p?.currency ?? ctx.org.currency, payFrequency: p?.payFrequency ?? null,
      bankName: p?.bankName ?? null, accountNumber: p?.accountNumber ?? null, updatedAt: p?.updatedAt ?? null,
    };
  });

  app.put<{ Params: { id: string } }>("/api/people/employees/:id/pay", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    if (!can(ctx, "see_pay")) throw forbidden("You don't have permission to change pay details.");
    const e = await getTeamEmployee(ctx, req.params.id);
    const input = parse(payInput, req.body);
    const values = {
      salaryAmount: input.salaryAmount != null ? String(input.salaryAmount) : null, currency: (input.currency ?? ctx.org.currency).toUpperCase(),
      payFrequency: input.payFrequency ?? null, bankName: input.bankName ?? null, accountNumber: input.accountNumber ?? null,
    };
    await db.transaction(async (tx) => {
      await tx.insert(employeePay).values({ employeeId: e.id, orgId: ctx.org.id, ...values })
        .onConflictDoUpdate({ target: employeePay.employeeId, set: { ...values, updatedAt: new Date() } });
      await audit(ctx, { action: "pay.updated", category: "access", entityType: "employee", entityId: e.id, summary: `${ctx.user.name} changed pay details for ${fullName(e)}` }, tx);
    });
    return { ok: true };
  });

  // ---------------- departments ----------------
  app.get("/api/people/departments", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    const depts = await db.select().from(departments).where(and(eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt))).orderBy(departments.name);
    const people = await db.select().from(employees).where(and(notDeleted(ctx.org.id), ne(employees.status, "left"))).orderBy(employees.firstName);
    return depts.map((d) => {
      const members = people.filter((p) => p.departmentId === d.id);
      const head = people.find((p) => p.id === d.headEmployeeId);
      return {
        id: d.id, name: d.name, headEmployeeId: d.headEmployeeId, count: members.length,
        head: head ? { id: head.id, name: fullName(head), jobTitle: head.jobTitle } : null,
        members: members.map((m) => ({ id: m.id, name: fullName(m), jobTitle: m.jobTitle })),
      };
    });
  });

  app.post("/api/people/departments", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const input = parse(deptInput, req.body);
    const [dup] = await db.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt), dsql`lower(${departments.name}) = lower(${input.name})`)).limit(1);
    if (dup) throw conflict("A department with this name already exists.", { name: "Already exists" });
    if (input.headEmployeeId) await getEmployee(ctx.org.id, input.headEmployeeId);
    const [d] = await db.insert(departments).values({ orgId: ctx.org.id, name: input.name, headEmployeeId: input.headEmployeeId ?? null }).returning();
    await audit(ctx, { action: "department.created", category: "data", entityType: "department", entityId: d!.id, summary: `${ctx.user.name} created the ${d!.name} department` });
    return d!;
  });

  app.patch<{ Params: { id: string } }>("/api/people/departments/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const d = await getDepartment(ctx.org.id, req.params.id);
    const input = parse(deptInput.partial(), req.body);
    if (input.name && input.name.toLowerCase() !== d.name.toLowerCase()) {
      const [dup] = await db.select({ id: departments.id }).from(departments)
        .where(and(eq(departments.orgId, ctx.org.id), isNull(departments.deletedAt), dsql`lower(${departments.name}) = lower(${input.name})`)).limit(1);
      if (dup) throw conflict("A department with this name already exists.", { name: "Already exists" });
    }
    if (input.headEmployeeId) await getEmployee(ctx.org.id, input.headEmployeeId);
    const [u] = await db.update(departments).set({
      name: input.name ?? d.name, headEmployeeId: input.headEmployeeId !== undefined ? input.headEmployeeId : d.headEmployeeId,
      version: dsql`${departments.version} + 1`,
    }).where(eq(departments.id, d.id)).returning();
    await audit(ctx, { action: "department.updated", category: "data", entityType: "department", entityId: d.id, summary: `${ctx.user.name} updated the ${u!.name} department` });
    return u!;
  });

  app.delete<{ Params: { id: string } }>("/api/people/departments/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const d = await getDepartment(ctx.org.id, req.params.id);
    await db.transaction(async (tx) => {
      await tx.update(departments).set({ deletedAt: new Date(), version: dsql`${departments.version} + 1` }).where(eq(departments.id, d.id));
      await tx.update(employees).set({ departmentId: null, version: dsql`${employees.version} + 1` }).where(eq(employees.departmentId, d.id));
      await audit(ctx, { action: "department.deleted", category: "data", entityType: "department", entityId: d.id, summary: `${ctx.user.name} deleted the ${d.name} department` }, tx);
    });
    return { ok: true };
  });

  /** Reporting structure built from each person's manager. */
  app.get("/api/people/org-chart", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    const people = await db.select({ e: employees, dept: departments.name }).from(employees)
      .leftJoin(departments, eq(departments.id, employees.departmentId))
      .where(and(notDeleted(ctx.org.id), ne(employees.status, "left"))).orderBy(employees.firstName);
    const ids = new Set(people.map((p) => p.e.id));
    const node = (p: (typeof people)[number]) => ({
      id: p.e.id, name: fullName(p.e), jobTitle: p.e.jobTitle, departmentName: p.dept,
      reportsCount: people.filter((x) => x.e.managerId === p.e.id).length,
    });
    const top = people.filter((p) => !p.e.managerId || !ids.has(p.e.managerId));
    return {
      top: top.map((t) => ({ ...node(t), reports: people.filter((x) => x.e.managerId === t.e.id).map(node) })),
      total: people.length,
    };
  });

}
