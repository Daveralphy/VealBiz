import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql as dsql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { attendance, employees, leaveRequests, leaveTypes } from "../../db/schema";
import { can, requireAccess, requireOrg, type OrgContext } from "../../lib/context";
import { badRequest, conflict, forbidden, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { toCsv } from "../../lib/csv";
import { dateStr, fullName, getEmployee, myEmployee, notDeleted, optDate } from "./shared";
import { eachDay, localDate, minutesOfDay, parseHm } from "./util";

type Status = "present" | "late" | "not_in" | "on_leave" | "sick";
type Row = typeof attendance.$inferSelect;

/** Minutes worked between clock in and `until` (clock out, or now), not counting breaks. */
export function workedMinutes(r: Pick<Row, "clockIn" | "clockOut" | "breaks">, until: Date | null = r.clockOut) {
  if (!r.clockIn || !until) return null;
  const end = until.getTime();
  const breakMs = (r.breaks ?? []).reduce((a, b) => a + Math.max(0, Math.min(end, b.end ? Date.parse(b.end) : end) - Date.parse(b.start)), 0);
  return Math.max(0, Math.round((end - r.clockIn.getTime() - breakMs) / 60_000));
}
const onBreak = (r: Pick<Row, "breaks" | "clockOut"> | null | undefined) => !!r && !r.clockOut && !!r.breaks?.length && !r.breaks[r.breaks.length - 1]!.end;
/**
 * A day's clock can't run into the next day: anything still open from an earlier day is clocked out
 * at the end of that day (a break still running ends then too). The next day starts with a new clock in.
 */
export async function closeEndedDays(scope: SQL) {
  const open = await db.select().from(attendance)
    .where(and(scope, isNull(attendance.deletedAt), isNotNull(attendance.clockIn), isNull(attendance.clockOut), lt(attendance.workDate, localDate())));
  for (const r of open) {
    let end = new Date(`${r.workDate}T23:59:59.999`);
    if (end < r.clockIn!) end = r.clockIn!;
    const iso = end.toISOString();
    await db.update(attendance).set({
      clockOut: end, breaks: r.breaks.map((b) => (b.end ? b : { ...b, end: iso })),
      note: r.note ?? "Clocked out automatically at the end of the day", version: dsql`${attendance.version} + 1`,
    }).where(eq(attendance.id, r.id));
  }
}

const clockView = (r: Row) => ({ id: r.id, clockIn: r.clockIn, clockOut: r.clockOut, breaks: r.breaks, onBreak: onBreak(r) });

const STATUS_LABEL: Record<Status, string> = { present: "Present", late: "Late", not_in: "Not in yet", on_leave: "On leave", sick: "Sick" };

/** Builds the attendance board for one day: everyone current, with their record and status. */
async function board(ctx: OrgContext, date: string, opts: { search?: string; location?: string } = {}) {
  await closeEndedDays(eq(attendance.orgId, ctx.org.id));
  const workdayStart = ctx.org.settings.workdayStart ?? "09:00";
  const startMin = parseHm(workdayStart);
  const people = (await db.select().from(employees)
    .where(and(notDeleted(ctx.org.id), ne(employees.status, "left"))).orderBy(employees.firstName, employees.lastName))
    .filter((e) => !e.startDate || e.startDate <= date)
    .filter((e) => !opts.location || e.location === opts.location)
    .filter((e) => {
      const s = opts.search?.trim().toLowerCase();
      return !s || fullName(e).toLowerCase().includes(s) || (e.jobTitle ?? "").toLowerCase().includes(s);
    });
  const ids = people.map((p) => p.id);
  const records = ids.length ? await db.select().from(attendance)
    .where(and(eq(attendance.orgId, ctx.org.id), eq(attendance.workDate, date), isNull(attendance.deletedAt), inArray(attendance.employeeId, ids))) : [];
  const leaves = ids.length ? await db.select({ employeeId: leaveRequests.employeeId, type: leaveTypes.name }).from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .where(and(eq(leaveRequests.orgId, ctx.org.id), eq(leaveRequests.status, "approved"), isNull(leaveRequests.deletedAt),
      lte(leaveRequests.startDate, date), gte(leaveRequests.endDate, date), inArray(leaveRequests.employeeId, ids))) : [];
  const rows = people.map((e) => {
    const r = records.find((x) => x.employeeId === e.id) ?? null;
    const leave = leaves.find((l) => l.employeeId === e.id);
    let status: Status;
    if (r?.clockIn) status = minutesOfDay(r.clockIn) > startMin ? "late" : "present";
    else if (leave) status = /sick/i.test(leave.type) ? "sick" : "on_leave";
    else status = "not_in";
    // Time worked is known once someone clocks out; until then they're "still working" (no running count here).
    const minutes = r ? workedMinutes(r) : null;
    return {
      employee: { id: e.id, name: fullName(e), jobTitle: e.jobTitle, location: e.location, userId: e.userId },
      record: r ? { id: r.id, clockIn: r.clockIn, clockOut: r.clockOut, source: r.source, note: r.note, corrected: !!r.correctedBy, onBreak: onBreak(r) } : null,
      status, statusLabel: STATUS_LABEL[status], minutes, leaveType: leave?.type ?? null,
    };
  });
  return {
    date, workdayStart, rows,
    stats: {
      total: rows.length,
      present: rows.filter((r) => r.status === "present" || r.status === "late").length,
      late: rows.filter((r) => r.status === "late").length,
      away: rows.filter((r) => r.status === "on_leave" || r.status === "sick").length,
      notIn: rows.filter((r) => r.status === "not_in").length,
    },
  };
}

/** Today's record for the signed-in person, which must be clocked in and not yet out. */
async function myOpenRecord(ctx: OrgContext) {
  const me = await myEmployee(ctx);
  if (!me) throw badRequest("You're not on the team list. Ask an admin to add you back in People & HR.");
  await closeEndedDays(eq(attendance.employeeId, me.id));
  const [r] = await db.select().from(attendance)
    .where(and(eq(attendance.employeeId, me.id), eq(attendance.workDate, localDate()), isNull(attendance.deletedAt))).limit(1);
  if (!r?.clockIn) throw conflict("You haven't clocked in today.");
  if (r.clockOut) throw conflict("You've already clocked out today.");
  return r;
}

export default async function attendanceRoutes(app: FastifyInstance) {
  /** The signed-in person's own clock for today. */
  app.get("/api/people/attendance/me", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) return { employee: null, record: null, date: localDate() };
    await closeEndedDays(eq(attendance.employeeId, me.id));
    const [r] = await db.select().from(attendance)
      .where(and(eq(attendance.employeeId, me.id), eq(attendance.workDate, localDate()), isNull(attendance.deletedAt))).limit(1);
    return {
      employee: { id: me.id, name: fullName(me), firstName: me.firstName },
      record: r ? clockView(r) : null, date: localDate(),
    };
  });

  app.post("/api/people/attendance/clock-in", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) throw badRequest("You're not on the team list. Ask an admin to add you back in People & HR.");
    await closeEndedDays(eq(attendance.employeeId, me.id));
    const today = localDate();
    const [r] = await db.select().from(attendance)
      .where(and(eq(attendance.employeeId, me.id), eq(attendance.workDate, today), isNull(attendance.deletedAt))).limit(1);
    if (r?.clockIn && !r.clockOut) throw conflict("You're already clocked in.");
    if (r?.clockOut) throw conflict("You've already clocked out today. Ask your manager to correct your times if needed.");
    const now = new Date();
    if (r) await db.update(attendance).set({ clockIn: now, version: dsql`${attendance.version} + 1` }).where(eq(attendance.id, r.id));
    else await db.insert(attendance).values({ orgId: ctx.org.id, employeeId: me.id, workDate: today, clockIn: now, source: "app" });
    return { ok: true, clockIn: now };
  });

  app.post("/api/people/attendance/clock-out", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) throw badRequest("You're not on the team list. Ask an admin to add you back in People & HR.");
    await closeEndedDays(eq(attendance.employeeId, me.id));
    const [r] = await db.select().from(attendance)
      .where(and(eq(attendance.employeeId, me.id), eq(attendance.workDate, localDate()), isNull(attendance.deletedAt))).limit(1);
    if (!r?.clockIn) throw conflict("You haven't clocked in today.");
    if (r.clockOut) throw conflict("You've already clocked out.");
    const now = new Date();
    // Clocking out during a break ends the break at the same moment.
    const breaks = r.breaks.map((b) => (b.end ? b : { ...b, end: now.toISOString() }));
    const [u] = await db.update(attendance).set({ clockOut: now, breaks, version: dsql`${attendance.version} + 1` }).where(eq(attendance.id, r.id)).returning();
    return { ok: true, record: clockView(u!), minutes: workedMinutes(u!) };
  });

  /** Take a break: the time stops counting until Resume. */
  app.post("/api/people/attendance/pause", async (req) => {
    const ctx = await requireOrg(req);
    const r = await myOpenRecord(ctx);
    if (onBreak(r)) throw conflict("You're already on a break.");
    const [u] = await db.update(attendance).set({ breaks: [...r.breaks, { start: new Date().toISOString(), end: null }], version: dsql`${attendance.version} + 1` })
      .where(eq(attendance.id, r.id)).returning();
    return { ok: true, record: clockView(u!) };
  });

  /** Back from a break, or back after clocking out (e.g. by mistake): the time away counts as a break. */
  app.post("/api/people/attendance/resume", async (req) => {
    const ctx = await requireOrg(req);
    const me = await myEmployee(ctx);
    if (!me) throw badRequest("You're not on the team list. Ask an admin to add you back in People & HR.");
    await closeEndedDays(eq(attendance.employeeId, me.id));
    const [done] = await db.select().from(attendance)
      .where(and(eq(attendance.employeeId, me.id), eq(attendance.workDate, localDate()), isNull(attendance.deletedAt))).limit(1);
    if (done?.clockIn && done.clockOut) {
      const now = new Date().toISOString();
      const [u] = await db.update(attendance).set({
        clockOut: null, breaks: [...done.breaks, { start: done.clockOut.toISOString(), end: now }], version: dsql`${attendance.version} + 1`,
      }).where(eq(attendance.id, done.id)).returning();
      return { ok: true, record: clockView(u!) };
    }
    const r = await myOpenRecord(ctx);
    if (!onBreak(r)) throw conflict("You're not on a break.");
    const breaks = r.breaks.map((b, i) => (i === r.breaks.length - 1 ? { ...b, end: new Date().toISOString() } : b));
    const [u] = await db.update(attendance).set({ breaks, version: dsql`${attendance.version} + 1` }).where(eq(attendance.id, r.id)).returning();
    return { ok: true, record: clockView(u!) };
  });

  app.get<{ Querystring: { date?: string; search?: string; location?: string } }>("/api/people/attendance", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    const { date } = parse(z.object({ date: optDate }), { date: req.query.date });
    return board(ctx, date ?? localDate(), req.query);
  });

  /** Corrections by HR / managers with people "edit". Every change needs a note and is audited. */
  app.post("/api/people/attendance/corrections", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const input = parse(z.object({
      employeeId: z.string().uuid(),
      date: dateStr,
      clockIn: z.union([z.string().datetime({ offset: true }), z.null()]),
      clockOut: z.union([z.string().datetime({ offset: true }), z.null()]),
      note: z.string().trim().min(3, "Say why the times were changed").max(300),
    }), req.body);
    const e = await getEmployee(ctx.org.id, input.employeeId);
    const clockIn = input.clockIn ? new Date(input.clockIn) : null;
    const clockOut = input.clockOut ? new Date(input.clockOut) : null;
    if (clockOut && !clockIn) throw badRequest("Some details need fixing.", { clockIn: "Add a clock-in time" });
    if (clockIn && clockOut && clockOut <= clockIn) throw badRequest("Some details need fixing.", { clockOut: "Clock out must be after clock in" });
    const [r] = await db.select().from(attendance)
      .where(and(eq(attendance.employeeId, e.id), eq(attendance.workDate, input.date), isNull(attendance.deletedAt))).limit(1);
    const values = { clockIn, clockOut, correctedBy: ctx.user.id, note: input.note, source: "correction" };
    await db.transaction(async (tx) => {
      if (r) await tx.update(attendance).set({ ...values, version: dsql`${attendance.version} + 1` }).where(eq(attendance.id, r.id));
      else await tx.insert(attendance).values({ ...values, orgId: ctx.org.id, employeeId: e.id, workDate: input.date });
      const t = (d: Date | null) => (d ? d.toISOString().slice(11, 16) + " UTC" : "none");
      await audit(ctx, {
        action: "attendance.corrected", category: "data", entityType: "employee", entityId: e.id,
        summary: `${ctx.user.name} corrected ${fullName(e)}'s attendance for ${input.date}`,
        meta: { before: r ? { clockIn: r.clockIn, clockOut: r.clockOut } : null, after: { clockIn: t(clockIn), clockOut: t(clockOut) }, note: input.note },
      }, tx);
    });
    return { ok: true };
  });

  app.get<{ Querystring: { from?: string; to?: string; date?: string; location?: string; search?: string } }>("/api/people/attendance/export", async (req, reply) => {
    const ctx = await requireAccess(req, "people", "view");
    if (!can(ctx, "export_data")) throw forbidden("You don't have permission to export data.");
    const q = parse(z.object({ from: optDate, to: optDate, date: optDate }), { from: req.query.from, to: req.query.to, date: req.query.date });
    const from = q.from ?? q.date ?? localDate();
    const to = q.to ?? q.date ?? from;
    if (to < from) throw badRequest("Some details need fixing.", { to: "The end date can't be before the start date" });
    const days = eachDay(from, to, 93);
    const rows: unknown[][] = [];
    const hm = (d: Date | null | undefined) => (d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "");
    for (const d of days) {
      const b = await board(ctx, d, req.query);
      for (const r of b.rows) {
        rows.push([d, r.employee.name, r.employee.jobTitle, r.employee.location, hm(r.record?.clockIn), hm(r.record?.clockOut),
          r.minutes != null ? (r.minutes / 60).toFixed(2) : "", r.statusLabel, r.record?.note ?? ""]);
      }
    }
    await audit(ctx, { action: "attendance.exported", category: "data", summary: `${ctx.user.name} exported attendance for ${from === to ? from : `${from} to ${to}`}` });
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="attendance-${from}${to !== from ? `-to-${to}` : ""}.csv"`);
    return toCsv(["Date", "Name", "Job title", "Location", "Clock in", "Clock out", "Hours", "Status", "Note"], rows);
  });
}
