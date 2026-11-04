import { and, eq, gte, inArray, isNull, lte, ne, notInArray, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { ACCESS_LEVELS, type AccessLevel } from "@windveal/shared";
import { db, type Tx } from "../../db/client";
import { departments, employees, leaveRequests, leaveTypes, memberships, publicHolidays, tasks } from "../../db/schema";
import type { OrgContext } from "../../lib/context";
import { notFound } from "../../lib/http";
import { ensureTeamRecord } from "../../lib/team";
import { DATE_RE, localDate } from "./util";

export type Employee = typeof employees.$inferSelect;

export const dateStr = z.string().regex(DATE_RE, "Use a date like 2026-11-10");
/** Optional text: "" and null become null. */
export const optText = (max = 200) =>
  z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === "" ? null : v));
export const optDate = z.union([dateStr, z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v));
export const optId = z.union([z.string().uuid(), z.literal(""), z.null()]).optional().transform((v) => (v === "" ? null : v));

export const hasLevel = (ctx: OrgContext, level: AccessLevel) => ACCESS_LEVELS.indexOf(ctx.access.people) >= ACCESS_LEVELS.indexOf(level);

export const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();

export const notDeleted = (orgId: string) => and(eq(employees.orgId, orgId), isNull(employees.deletedAt));

export async function getEmployee(orgId: string, id: string, tx: Tx = db): Promise<Employee> {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That person");
  const [e] = await tx.select().from(employees).where(and(eq(employees.id, id), notDeleted(orgId))).limit(1);
  if (!e) throw notFound("That person");
  return e;
}

/**
 * The signed-in person's own record in People & HR. Everyone in the business is on the team, so the first
 * time they need it (clocking in, their attendance, leave) it's linked or made for them (see ensureTeamRecord).
 */
export async function myEmployee(ctx: OrgContext): Promise<Employee | null> {
  const find = async () => (await db.select().from(employees)
    .where(and(notDeleted(ctx.org.id), eq(employees.userId, ctx.user.id), ne(employees.status, "left"))).limit(1))[0] ?? null;
  const e = await find();
  if (e) return e;
  await ensureTeamRecord(ctx.org.id, ctx.user.id, ctx.membership.jobTitle);
  return find();
}

export async function getDepartment(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That department");
  const [d] = await db.select().from(departments)
    .where(and(eq(departments.id, id), eq(departments.orgId, orgId), isNull(departments.deletedAt))).limit(1);
  if (!d) throw notFound("That department");
  return d;
}

export async function holidaysFor(orgId: string) {
  return db.select({ day: publicHolidays.day, recurring: publicHolidays.recurring, name: publicHolidays.name, id: publicHolidays.id })
    .from(publicHolidays).where(eq(publicHolidays.orgId, orgId)).orderBy(publicHolidays.day);
}

export async function activeAdminUserId(orgId: string, preferNot?: string): Promise<string | null> {
  const admins = await db.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin"), eq(memberships.status, "active"), isNull(memberships.deletedAt)));
  return admins.find((a) => a.userId !== preferNot)?.userId ?? admins[0]?.userId ?? null;
}

/**
 * Keeps "on leave" in step with approved leave: people whose approved leave covers today are
 * on leave; people marked on leave whose leave has ended go back to active.
 */
export async function syncLeaveStatuses(orgId: string) {
  const today = localDate();
  const covering = db.select({ id: leaveRequests.employeeId }).from(leaveRequests)
    .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "approved"), isNull(leaveRequests.deletedAt),
      lte(leaveRequests.startDate, today), gte(leaveRequests.endDate, today)));
  await db.update(employees).set({ status: "on_leave", version: dsql`${employees.version} + 1` })
    .where(and(notDeleted(orgId), eq(employees.status, "active"), inArray(employees.id, covering)));
  await db.update(employees).set({ status: "active", version: dsql`${employees.version} + 1` })
    .where(and(notDeleted(orgId), eq(employees.status, "on_leave"), notInArray(employees.id, covering)));
}

/** Leave balances for the current calendar year: daysPerYear minus approved days. */
export async function balancesFor(orgId: string, employeeId: string, year = Number(localDate().slice(0, 4))) {
  const types = await db.select().from(leaveTypes)
    .where(and(eq(leaveTypes.orgId, orgId), isNull(leaveTypes.deletedAt))).orderBy(leaveTypes.createdAt, leaveTypes.name);
  const sums = await db.select({ typeId: leaveRequests.leaveTypeId, status: leaveRequests.status, days: dsql<string>`coalesce(sum(${leaveRequests.days}),0)` })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.employeeId, employeeId), isNull(leaveRequests.deletedAt),
      inArray(leaveRequests.status, ["approved", "pending"]), gte(leaveRequests.startDate, `${year}-01-01`), lte(leaveRequests.startDate, `${year}-12-31`)))
    .groupBy(leaveRequests.leaveTypeId, leaveRequests.status);
  return types.map((t) => {
    const used = Number(sums.find((s) => s.typeId === t.id && s.status === "approved")?.days ?? 0);
    const pending = Number(sums.find((s) => s.typeId === t.id && s.status === "pending")?.days ?? 0);
    const allowance = t.daysPerYear != null ? Number(t.daysPerYear) : null;
    return {
      leaveTypeId: t.id, name: t.name, paid: t.paid, requiresNote: t.requiresNote, daysPerYear: allowance,
      used, pending, remaining: allowance != null ? Math.max(0, allowance - used) : null,
    };
  });
}

export function employeeSummary(e: Employee, extra: { departmentName?: string | null; managerName?: string | null } = {}) {
  return {
    id: e.id, firstName: e.firstName, lastName: e.lastName, name: fullName(e), email: e.email, phone: e.phone, jobTitle: e.jobTitle,
    departmentId: e.departmentId, departmentName: extra.departmentName ?? null, managerId: e.managerId, managerName: extra.managerName ?? null,
    location: e.location, employmentType: e.employmentType, startDate: e.startDate, endDate: e.endDate, status: e.status,
    employeeCode: e.employeeCode, userId: e.userId,
  };
}

/** done / total tasks per checklist. */
export async function checklistProgress(ids: string[]) {
  const out = new Map<string, { total: number; done: number }>();
  if (!ids.length) return out;
  const rows = await db.select({
    id: tasks.checklistId, total: dsql<number>`count(*)::int`, done: dsql<number>`(count(*) filter (where ${tasks.status} = 'done'))::int`,
  }).from(tasks).where(and(inArray(tasks.checklistId, ids), isNull(tasks.deletedAt))).groupBy(tasks.checklistId);
  for (const r of rows) if (r.id) out.set(r.id, { total: r.total, done: r.done });
  return out;
}
