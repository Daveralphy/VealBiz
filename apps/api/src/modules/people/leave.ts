import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "../../db/client";
import {
  approvalSteps, approvals, departments, employees, leaveRequests, leaveTypes, organisations, publicHolidays, users,
} from "../../db/schema";
import { requireAccess, requireOrg, type OrgContext } from "../../lib/context";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit, notify } from "../../lib/audit";
import { createApproval, onApprovalDecided } from "../../lib/approvals";
import {
  activeAdminUserId, balancesFor, dateStr, fullName, hasLevel, holidaysFor, myEmployee, notDeleted, optDate, optId, optText,
  getTeamEmployee, inTeam, teamScope,
} from "./shared";
import { addDays, fmtDay, localDate, mondayOf, workingDays } from "./util";

type LeaveRequest = typeof leaveRequests.$inferSelect;
const LINK_TYPE = "leave_request";

const leaveTypeInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  daysPerYear: z.union([z.literal(""), z.null(), z.coerce.number().min(0, "Use 0 or more").max(366, "That's more than a year")]).optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  paid: z.boolean().optional(),
  requiresNote: z.boolean().optional(),
});
const requestInput = z.object({
  employeeId: optId,
  leaveTypeId: z.string().uuid("Choose a leave type"),
  startDate: dateStr,
  endDate: dateStr,
  reason: optText(1000),
});

/**
 * Applies a final decision to a leave request. Used both by the shared approvals engine
 * (Workflows → Approvals) and by the People & HR approve/decline buttons.
 */
async function applyLeaveDecision(orgId: string, leaveId: string, outcome: "approved" | "declined", actorUserId: string, tx: Tx, note?: string | null) {
  const [lr] = await tx.select().from(leaveRequests).where(and(eq(leaveRequests.id, leaveId), eq(leaveRequests.orgId, orgId))).limit(1);
  if (!lr || lr.status !== "pending") return;
  await tx.update(leaveRequests).set({
    status: outcome, decidedBy: actorUserId, decidedAt: new Date(), decisionNote: note ?? null, version: dsql`${leaveRequests.version} + 1`,
  }).where(eq(leaveRequests.id, lr.id));
  const [emp] = await tx.select().from(employees).where(eq(employees.id, lr.employeeId)).limit(1);
  const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, lr.leaveTypeId)).limit(1);
  const today = localDate();
  if (outcome === "approved" && emp && emp.status === "active" && lr.startDate <= today && lr.endDate >= today) {
    await tx.update(employees).set({ status: "on_leave", version: dsql`${employees.version} + 1` }).where(eq(employees.id, emp.id));
  }
  const name = emp ? fullName(emp) : "Someone";
  const what = `${type?.name ?? "Leave"} ${fmtDay(lr.startDate)} to ${fmtDay(lr.endDate)}`;
  const title = `Your ${what} was ${outcome}`;
  const recipients = new Set([lr.requestedBy, emp?.userId].filter((x): x is string => !!x && x !== actorUserId));
  for (const r of recipients) await notify(orgId, r, r === emp?.userId ? title : `${name}'s ${what} was ${outcome}`, note ?? undefined, r === emp?.userId ? "/me/leave" : "/people/leave", tx);
  const [org] = await tx.select().from(organisations).where(eq(organisations.id, orgId)).limit(1);
  const [actor] = await tx.select().from(users).where(eq(users.id, actorUserId)).limit(1);
  if (org && actor) {
    await audit({ org, user: actor, deviceLabel: null }, {
      action: `leave.${outcome}`, category: "data", entityType: "leave_request", entityId: lr.id,
      summary: `${actor.name} ${outcome} ${name}'s ${what}`,
    }, tx);
  }
}

// Registered at module load so Workflows' approval queue can finish leave requests too.
onApprovalDecided("leave", async (approval, outcome, actorUserId, tx) => {
  if (approval.linkType !== LINK_TYPE || !approval.linkId) return;
  await applyLeaveDecision(approval.orgId, approval.linkId, outcome, actorUserId, tx);
});

async function getLeave(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That leave request");
  const [lr] = await db.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.orgId, orgId), isNull(leaveRequests.deletedAt))).limit(1);
  if (!lr) throw notFound("That leave request");
  return lr;
}

async function pendingStepFor(orgId: string, leaveId: string) {
  const [row] = await db.select({ a: approvals, s: approvalSteps }).from(approvals)
    .innerJoin(approvalSteps, and(eq(approvalSteps.approvalId, approvals.id), eq(approvalSteps.status, "pending")))
    .where(and(eq(approvals.orgId, orgId), eq(approvals.linkType, LINK_TYPE), eq(approvals.linkId, leaveId), eq(approvals.status, "pending"), isNull(approvals.deletedAt)))
    .limit(1);
  return row ?? null;
}

const canOverride = (ctx: OrgContext) => ctx.membership.role === "admin" || hasLevel(ctx, "manage");

/** Others in the same department off (approved or pending) on overlapping days. */
async function clashFor(orgId: string, lr: Pick<LeaveRequest, "employeeId" | "startDate" | "endDate">, departmentId: string | null) {
  if (!departmentId) return { count: 0, day: null as string | null };
  const rows = await db.select({ employeeId: leaveRequests.employeeId, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate })
    .from(leaveRequests).innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
    .where(and(eq(leaveRequests.orgId, orgId), isNull(leaveRequests.deletedAt), inArray(leaveRequests.status, ["approved", "pending"]),
      eq(employees.departmentId, departmentId), ne(leaveRequests.employeeId, lr.employeeId), isNull(employees.deletedAt),
      lte(leaveRequests.startDate, lr.endDate), gte(leaveRequests.endDate, lr.startDate)));
  const people = new Set(rows.map((r) => r.employeeId));
  const day = rows.length ? rows.map((r) => (r.startDate > lr.startDate ? r.startDate : lr.startDate)).sort()[0]! : null;
  return { count: people.size, day };
}

async function leaveView(ctx: OrgContext, rows: LeaveRequest[]) {
  if (!rows.length) return [];
  const empIds = [...new Set(rows.map((r) => r.employeeId))];
  const emps = await db.select({ e: employees, dept: departments.name }).from(employees)
    .leftJoin(departments, eq(departments.id, employees.departmentId)).where(inArray(employees.id, empIds));
  const types = await db.select().from(leaveTypes).where(eq(leaveTypes.orgId, ctx.org.id));
  const steps = await db.select({ linkId: approvals.linkId, approvalId: approvals.id, s: approvalSteps, approver: users.name }).from(approvals)
    .innerJoin(approvalSteps, eq(approvalSteps.approvalId, approvals.id)).innerJoin(users, eq(users.id, approvalSteps.approverUserId))
    .where(and(eq(approvals.orgId, ctx.org.id), eq(approvals.linkType, LINK_TYPE), inArray(approvals.linkId, rows.map((r) => r.id))));
  const balanceCache = new Map<string, Awaited<ReturnType<typeof balancesFor>>>();
  const out = [];
  for (const r of rows) {
    const emp = emps.find((x) => x.e.id === r.employeeId);
    const type = types.find((t) => t.id === r.leaveTypeId);
    const step = steps.find((s) => s.linkId === r.id && s.s.status === "pending") ?? steps.find((s) => s.linkId === r.id);
    let remainingAfter: number | null = null;
    if (r.status === "pending" && type?.daysPerYear != null) {
      if (!balanceCache.has(r.employeeId)) balanceCache.set(r.employeeId, await balancesFor(ctx.org.id, r.employeeId));
      const b = balanceCache.get(r.employeeId)!.find((x) => x.leaveTypeId === r.leaveTypeId);
      remainingAfter = b?.remaining != null ? b.remaining - Number(r.days) : null;
    }
    out.push({
      id: r.id, startDate: r.startDate, endDate: r.endDate, days: Number(r.days), reason: r.reason, status: r.status,
      decidedAt: r.decidedAt, decisionNote: r.decisionNote, createdAt: r.createdAt,
      employee: emp ? { id: emp.e.id, name: fullName(emp.e), jobTitle: emp.e.jobTitle, departmentName: emp.dept, userId: emp.e.userId } : null,
      leaveType: type ? { id: type.id, name: type.name } : null,
      approvalId: step?.approvalId ?? null, approverName: step?.approver ?? null,
      canDecide: r.status === "pending" && (step?.s.status === "pending" && step.s.approverUserId === ctx.user.id || canOverride(ctx)),
      canCancel: r.status === "pending" && (r.requestedBy === ctx.user.id || emp?.e.userId === ctx.user.id),
      remainingAfter,
      clash: r.status === "pending" ? await clashFor(ctx.org.id, r, emp?.e.departmentId ?? null) : { count: 0, day: null },
    });
  }
  return out;
}

export default async function leaveRoutes(app: FastifyInstance) {
  // ---------------- leave types ----------------
  app.get("/api/people/leave-types", async (req) => {
    const ctx = await requireOrg(req);
    const rows = await db.select().from(leaveTypes).where(and(eq(leaveTypes.orgId, ctx.org.id), isNull(leaveTypes.deletedAt)))
      .orderBy(asc(leaveTypes.createdAt), asc(leaveTypes.name));
    return rows.map((t) => ({ id: t.id, name: t.name, daysPerYear: t.daysPerYear != null ? Number(t.daysPerYear) : null, paid: t.paid, requiresNote: t.requiresNote }));
  });

  app.post("/api/people/leave-types", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const input = parse(leaveTypeInput, req.body);
    const [t] = await db.insert(leaveTypes).values({
      orgId: ctx.org.id, name: input.name, daysPerYear: input.daysPerYear != null ? String(input.daysPerYear) : null,
      paid: input.paid ?? true, requiresNote: input.requiresNote ?? false,
    }).returning();
    await audit(ctx, { action: "leave_type.created", category: "settings", entityType: "leave_type", entityId: t!.id, summary: `${ctx.user.name} added the leave type ${t!.name}` });
    return t!;
  });

  app.patch<{ Params: { id: string } }>("/api/people/leave-types/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const input = parse(leaveTypeInput.partial(), req.body);
    const [t] = await db.select().from(leaveTypes).where(and(eq(leaveTypes.id, req.params.id), eq(leaveTypes.orgId, ctx.org.id), isNull(leaveTypes.deletedAt))).limit(1);
    if (!t) throw notFound("That leave type");
    const [u] = await db.update(leaveTypes).set({
      name: input.name ?? t.name,
      daysPerYear: "daysPerYear" in (req.body as object ?? {}) ? (input.daysPerYear != null ? String(input.daysPerYear) : null) : t.daysPerYear,
      paid: input.paid ?? t.paid, requiresNote: input.requiresNote ?? t.requiresNote, version: dsql`${leaveTypes.version} + 1`,
    }).where(eq(leaveTypes.id, t.id)).returning();
    await audit(ctx, { action: "leave_type.updated", category: "settings", entityType: "leave_type", entityId: t.id, summary: `${ctx.user.name} updated the leave type ${u!.name}` });
    return u!;
  });

  app.delete<{ Params: { id: string } }>("/api/people/leave-types/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const [t] = await db.select().from(leaveTypes).where(and(eq(leaveTypes.id, req.params.id), eq(leaveTypes.orgId, ctx.org.id), isNull(leaveTypes.deletedAt))).limit(1);
    if (!t) throw notFound("That leave type");
    await db.update(leaveTypes).set({ deletedAt: new Date(), version: dsql`${leaveTypes.version} + 1` }).where(eq(leaveTypes.id, t.id));
    await audit(ctx, { action: "leave_type.deleted", category: "settings", entityType: "leave_type", entityId: t.id, summary: `${ctx.user.name} removed the leave type ${t.name}` });
    return { ok: true };
  });

  // ---------------- public holidays ----------------
  app.get("/api/people/holidays", async (req) => {
    const ctx = await requireOrg(req);
    return holidaysFor(ctx.org.id);
  });
  app.post("/api/people/holidays", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    const input = parse(z.object({ name: z.string().trim().min(1, "Enter a name").max(80), day: dateStr, recurring: z.boolean().optional() }), req.body);
    const [h] = await db.insert(publicHolidays).values({ orgId: ctx.org.id, name: input.name, day: input.day, recurring: input.recurring ?? false }).returning();
    await audit(ctx, { action: "holiday.created", category: "settings", summary: `${ctx.user.name} added the public holiday ${h!.name}` });
    return h!;
  });
  app.delete<{ Params: { id: string } }>("/api/people/holidays/:id", async (req) => {
    const ctx = await requireAccess(req, "people", "manage");
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That holiday");
    const [h] = await db.delete(publicHolidays).where(and(eq(publicHolidays.id, req.params.id), eq(publicHolidays.orgId, ctx.org.id))).returning();
    if (!h) throw notFound("That holiday");
    await audit(ctx, { action: "holiday.deleted", category: "settings", summary: `${ctx.user.name} removed the public holiday ${h.name}` });
    return { ok: true };
  });

  // ---------------- balances ----------------
  app.get<{ Querystring: { employeeId?: string } }>("/api/people/leave/balances", async (req) => {
    const ctx = await requireOrg(req);
    const mine = await myEmployee(ctx);
    let emp = mine;
    if (req.query.employeeId && req.query.employeeId !== mine?.id) {
      await requireAccess(req, "people", "view");
      emp = await getTeamEmployee(ctx, req.query.employeeId);
    }
    if (!emp) return { employee: null, balances: [] };
    return { employee: { id: emp.id, name: fullName(emp) }, balances: await balancesFor(ctx.org.id, emp.id) };
  });

  /** Working days for a date range, so the request form can show the total before sending. */
  app.get<{ Querystring: { startDate?: string; endDate?: string } }>("/api/people/leave/working-days", async (req) => {
    const ctx = await requireOrg(req);
    const { startDate, endDate } = parse(z.object({ startDate: dateStr, endDate: dateStr }), req.query);
    if (endDate < startDate) return { days: 0 };
    return { days: workingDays(startDate, endDate, await holidaysFor(ctx.org.id)) };
  });

  // ---------------- requests ----------------
  app.post("/api/people/leave/requests", async (req) => {
    const ctx = await requireOrg(req);
    const input = parse(requestInput, req.body);
    const mine = await myEmployee(ctx);
    let emp = mine;
    if (input.employeeId && input.employeeId !== mine?.id) {
      await requireAccess(req, "people", "edit");
      emp = await getTeamEmployee(ctx, input.employeeId);
    }
    if (!emp) throw badRequest("You're not on the team list. Ask an admin to add you back in People & HR.");
    if (emp.status === "left") throw badRequest(`${fullName(emp)} has left the organisation.`);
    const [type] = await db.select().from(leaveTypes)
      .where(and(eq(leaveTypes.id, input.leaveTypeId), eq(leaveTypes.orgId, ctx.org.id), isNull(leaveTypes.deletedAt))).limit(1);
    if (!type) throw badRequest("Some details need fixing.", { leaveTypeId: "Choose a leave type" });
    if (input.endDate < input.startDate) throw badRequest("Some details need fixing.", { endDate: "The end date can't be before the start date" });
    if (type.requiresNote && !input.reason) throw badRequest("Some details need fixing.", { reason: `Add a note for ${type.name.toLowerCase()}` });
    const days = workingDays(input.startDate, input.endDate, await holidaysFor(ctx.org.id));
    if (days <= 0) throw badRequest("Some details need fixing.", { endDate: "Those dates are all weekends or public holidays" });
    const [overlap] = await db.select({ id: leaveRequests.id }).from(leaveRequests)
      .where(and(eq(leaveRequests.employeeId, emp.id), isNull(leaveRequests.deletedAt), inArray(leaveRequests.status, ["approved", "pending"]),
        lte(leaveRequests.startDate, input.endDate), gte(leaveRequests.endDate, input.startDate))).limit(1);
    if (overlap) throw conflict("There's already a leave request for some of these days.", { startDate: "Overlaps another request" });
    if (type.daysPerYear != null) {
      const b = (await balancesFor(ctx.org.id, emp.id, Number(input.startDate.slice(0, 4)))).find((x) => x.leaveTypeId === type.id);
      const available = (b?.remaining ?? 0) - (b?.pending ?? 0);
      if (days > available) throw badRequest("Some details need fixing.", { endDate: `Only ${Math.max(0, available)} day${available === 1 ? "" : "s"} of ${type.name.toLowerCase()} left` });
    }
    // The employee's manager decides; if they don't use WindVeal, an admin does.
    let approver: string | null = null;
    let label = "Manager";
    if (emp.managerId) {
      const [m] = await db.select().from(employees).where(and(eq(employees.id, emp.managerId), isNull(employees.deletedAt))).limit(1);
      if (m?.userId && m.userId !== emp.userId) approver = m.userId;
    }
    if (!approver) {
      approver = await activeAdminUserId(ctx.org.id, emp.userId ?? undefined);
      label = "Admin";
    }
    if (!approver) throw badRequest("There's no one to approve this request yet.");
    const name = fullName(emp);
    const lr = await db.transaction(async (tx) => {
      const [lr] = await tx.insert(leaveRequests).values({
        orgId: ctx.org.id, employeeId: emp.id, leaveTypeId: type.id, startDate: input.startDate, endDate: input.endDate,
        days: String(days), reason: input.reason ?? null, requestedBy: ctx.user.id,
      }).returning();
      await createApproval({
        orgId: ctx.org.id, kind: "leave", title: `${name} · ${type.name}`, requestedBy: ctx.user.id, firstApproverUserId: approver!, firstLabel: label,
        details: `${fmtDay(input.startDate)} to ${fmtDay(input.endDate)} · ${days} day${days === 1 ? "" : "s"}${input.reason ? ` · ${input.reason}` : ""}`,
        linkType: LINK_TYPE, linkId: lr!.id, tx,
      });
      await audit(ctx, { action: "leave.requested", category: "data", entityType: "leave_request", entityId: lr!.id,
        summary: `${ctx.user.name} requested ${type.name.toLowerCase()} for ${name} (${fmtDay(input.startDate)} to ${fmtDay(input.endDate)})` }, tx);
      return lr!;
    });
    return (await leaveView(ctx, [lr]))[0];
  });

  app.get<{ Querystring: { scope?: string; status?: string; employeeId?: string } }>("/api/people/leave/requests", async (req) => {
    const ctx = await requireOrg(req);
    const scope = req.query.scope ?? "mine";
    const base = and(eq(leaveRequests.orgId, ctx.org.id), isNull(leaveRequests.deletedAt));
    let rows: LeaveRequest[];
    if (scope === "waiting") {
      const ids = db.select({ id: approvals.linkId }).from(approvals).innerJoin(approvalSteps, eq(approvalSteps.approvalId, approvals.id))
        .where(and(eq(approvals.orgId, ctx.org.id), eq(approvals.linkType, LINK_TYPE), eq(approvals.status, "pending"),
          eq(approvalSteps.status, "pending"), eq(approvalSteps.approverUserId, ctx.user.id)));
      rows = await db.select().from(leaveRequests).where(and(base, eq(leaveRequests.status, "pending"), inArray(leaveRequests.id, ids)))
        .orderBy(asc(leaveRequests.startDate));
    } else if (scope === "mine") {
      const mine = await myEmployee(ctx);
      rows = await db.select().from(leaveRequests)
        .where(and(base, mine ? or(eq(leaveRequests.requestedBy, ctx.user.id), eq(leaveRequests.employeeId, mine.id)) : eq(leaveRequests.requestedBy, ctx.user.id)))
        .orderBy(desc(leaveRequests.startDate)).limit(100);
    } else {
      await requireAccess(req, "people", "view");
      const conds = [base, inTeam(await teamScope(ctx), leaveRequests.employeeId)];
      if (req.query.status && ["pending", "approved", "declined", "cancelled"].includes(req.query.status)) conds.push(eq(leaveRequests.status, req.query.status as LeaveRequest["status"]));
      if (req.query.employeeId) conds.push(eq(leaveRequests.employeeId, (await getTeamEmployee(ctx, req.query.employeeId)).id));
      rows = await db.select().from(leaveRequests).where(and(...conds)).orderBy(desc(leaveRequests.startDate)).limit(200);
    }
    return leaveView(ctx, rows);
  });

  async function decide(req: FastifyRequest, id: string, outcome: "approved" | "declined") {
    const ctx = await requireOrg(req);
    const { note } = parse(z.object({ note: optText(1000) }), req.body);
    const lr = await getLeave(ctx.org.id, id);
    if (lr.status !== "pending") throw conflict(`This request has already been ${lr.status}.`);
    const row = await pendingStepFor(ctx.org.id, lr.id);
    const isApprover = row?.s.approverUserId === ctx.user.id;
    if (!isApprover && !canOverride(ctx)) throw forbidden("Only the person's manager or an admin can decide this request.");
    await db.transaction(async (tx) => {
      if (row) {
        await tx.update(approvalSteps).set({ status: outcome, comment: note ?? null, decidedAt: new Date() }).where(eq(approvalSteps.id, row.s.id));
        await tx.update(approvalSteps).set({ status: "skipped" })
          .where(and(eq(approvalSteps.approvalId, row.a.id), inArray(approvalSteps.status, ["waiting", "pending"]), ne(approvalSteps.id, row.s.id)));
        await tx.update(approvals).set({ status: outcome, decidedAt: new Date(), version: dsql`${approvals.version} + 1` }).where(eq(approvals.id, row.a.id));
      }
      await applyLeaveDecision(ctx.org.id, lr.id, outcome, ctx.user.id, tx, note);
    });
    return { ok: true, status: outcome };
  }
  app.post<{ Params: { id: string } }>("/api/people/leave/requests/:id/approve", async (req) => decide(req, req.params.id, "approved"));
  app.post<{ Params: { id: string } }>("/api/people/leave/requests/:id/decline", async (req) => decide(req, req.params.id, "declined"));

  app.post<{ Params: { id: string } }>("/api/people/leave/requests/:id/cancel", async (req) => {
    const ctx = await requireOrg(req);
    const lr = await getLeave(ctx.org.id, req.params.id);
    const [emp] = await db.select().from(employees).where(eq(employees.id, lr.employeeId)).limit(1);
    if (lr.requestedBy !== ctx.user.id && emp?.userId !== ctx.user.id) throw forbidden("You can only cancel your own requests.");
    if (lr.status !== "pending") throw conflict(`This request has already been ${lr.status}.`);
    await db.transaction(async (tx) => {
      await tx.update(leaveRequests).set({ status: "cancelled", version: dsql`${leaveRequests.version} + 1` }).where(eq(leaveRequests.id, lr.id));
      const [a] = await tx.select().from(approvals).where(and(eq(approvals.orgId, ctx.org.id), eq(approvals.linkType, LINK_TYPE), eq(approvals.linkId, lr.id))).limit(1);
      if (a && a.status === "pending") {
        // Approvals have no "cancelled" status: close it as declined and skip any open steps.
        await tx.update(approvals).set({ status: "declined", decidedAt: new Date(), details: `${a.details ?? ""} · cancelled by the requester`.replace(/^ · /, ""), version: dsql`${approvals.version} + 1` }).where(eq(approvals.id, a.id));
        await tx.update(approvalSteps).set({ status: "skipped" }).where(and(eq(approvalSteps.approvalId, a.id), inArray(approvalSteps.status, ["waiting", "pending"])));
      }
      await audit(ctx, { action: "leave.cancelled", category: "data", entityType: "leave_request", entityId: lr.id, summary: `${ctx.user.name} cancelled a leave request` }, tx);
    });
    return { ok: true };
  });

  // ---------------- who's off ----------------
  app.get<{ Querystring: { from?: string; to?: string; departmentId?: string; team?: string } }>("/api/people/leave/calendar", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    const q = parse(z.object({ from: optDate, to: optDate, departmentId: optId, team: z.enum(["all", "mine"]).optional() }), req.query);
    const from = q.from ?? mondayOf(localDate());
    let to = q.to ?? addDays(from, 13);
    if (to < from) to = from;
    if (to > addDays(from, 62)) to = addDays(from, 62);
    const conds = [eq(leaveRequests.orgId, ctx.org.id), isNull(leaveRequests.deletedAt), inArray(leaveRequests.status, ["approved", "pending"]),
      lte(leaveRequests.startDate, to), gte(leaveRequests.endDate, from), notDeleted(ctx.org.id), inTeam(await teamScope(ctx))];
    if (q.departmentId) conds.push(eq(employees.departmentId, q.departmentId));
    if (q.team === "mine") {
      const me = await myEmployee(ctx);
      if (!me) return { from, to, holidays: [], people: [] };
      conds.push(or(eq(employees.id, me.id), eq(employees.managerId, me.id), me.departmentId ? eq(employees.departmentId, me.departmentId) : undefined)!);
    }
    const rows = await db.select({ lr: leaveRequests, e: employees, type: leaveTypes.name }).from(leaveRequests)
      .innerJoin(employees, eq(employees.id, leaveRequests.employeeId)).innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(and(...conds)).orderBy(employees.firstName, leaveRequests.startDate);
    const people = new Map<string, { id: string; name: string; jobTitle: string | null; entries: unknown[] }>();
    for (const r of rows) {
      if (!people.has(r.e.id)) people.set(r.e.id, { id: r.e.id, name: fullName(r.e), jobTitle: r.e.jobTitle, entries: [] });
      people.get(r.e.id)!.entries.push({
        id: r.lr.id, startDate: r.lr.startDate, endDate: r.lr.endDate, type: r.type,
        kind: r.lr.status === "pending" ? "pending" : /sick/i.test(r.type) ? "sick" : "approved",
      });
    }
    const holidays = (await holidaysFor(ctx.org.id)).filter((h) => h.recurring || (h.day >= from && h.day <= to));
    return { from, to, holidays, people: [...people.values()] };
  });
}
