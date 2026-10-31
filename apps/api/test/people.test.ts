import { beforeAll, describe, expect, it } from "vitest";
import { addMember, getApp, signUpWithOrg, type Client } from "./helpers";

// Sign-ups are rate limited (10 a minute), so the tests share one organisation.
type Person = { c: Client; email: string };
let admin: Person, manager: Person, member: Person, other: Person, leaver: Person, orgB: Person;
beforeAll(async () => {
  const app = await getApp();
  admin = await signUpWithOrg(app);
  manager = await addMember(app, admin.c, "manager", "Ama Darko");
  member = await addMember(app, admin.c, "member", "John Obi");
  other = await addMember(app, admin.c, "member", "Tunde Bello");
  leaver = await addMember(app, admin.c, "member", "Samuel Boateng");
  orgB = await signUpWithOrg(app);
});

/** Next Monday (so leave requests always land on working days). */
function nextMonday(weeksAhead = 1) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const add = ((8 - d.getDay()) % 7 || 7) + (weeksAhead - 1) * 7;
  d.setDate(d.getDate() + add);
  return d;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

async function createEmployee(c: Client, body: Record<string, unknown>) {
  const r = await c.post("/api/people/employees", body);
  if (r.status !== 200) throw new Error(`create employee failed: ${JSON.stringify(r.body)}`);
  return r.body.employee as { id: string; status: string; name: string };
}

describe("people: employees", () => {
  it("creates, lists, updates (with history) and validates employees", async () => {
    const c = admin.c;
    const dept = (await c.post("/api/people/departments", { name: "Sales" })).body;
    expect(dept.id).toBeTruthy();

    const bad = await c.post("/api/people/employees", { firstName: "", lastName: "Mensah", email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.firstName).toBeTruthy();
    expect(bad.body.error.details.email).toBeTruthy();

    const future = ymd(plus(new Date(), 10));
    const kofi = await createEmployee(c, { firstName: "Kofi", lastName: "Mensah", jobTitle: "Sales Associate", departmentId: dept.id, location: "Accra" });
    expect(kofi.status).toBe("active");
    const efua = await createEmployee(c, { firstName: "Efua", lastName: "Nyarko", jobTitle: "Sales Associate", startDate: future, managerId: kofi.id, startOnboarding: true });
    expect(efua.status).toBe("onboarding");

    const list = await c.get("/api/people/employees?search=sales associate");
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const byDept = await c.get(`/api/people/employees?departmentId=${dept.id}`);
    expect(byDept.body.items.map((e: any) => e.name)).toEqual(["Kofi Mensah"]);

    const stats = (await c.get("/api/people/stats")).body;
    expect(stats.headcount).toBeGreaterThanOrEqual(2);
    expect(stats.startingSoon.count).toBeGreaterThanOrEqual(1);
    expect(stats.onboardingInProgress).toBeGreaterThanOrEqual(1);

    const upd = await c.patch(`/api/people/employees/${kofi.id}`, { jobTitle: "Sales Team Lead" });
    expect(upd.status).toBe(200);
    const loop = await c.patch(`/api/people/employees/${kofi.id}`, { managerId: efua.id });
    expect(loop.status).toBe(400);
    expect(loop.body.error.details.managerId).toMatch(/loop/);

    const profile = (await c.get(`/api/people/employees/${kofi.id}`)).body;
    expect(profile.jobTitle).toBe("Sales Team Lead");
    expect(profile.history.map((h: any) => h.event)).toContain("Became Sales Team Lead");
    expect(profile.reports.map((r: any) => r.name)).toEqual(["Efua Nyarko"]);
    expect(profile).not.toHaveProperty("salaryAmount");
    expect(profile.balances.find((b: any) => b.name === "Annual leave").remaining).toBe(20);

    const efuaProfile = (await c.get(`/api/people/employees/${efua.id}`)).body;
    expect(efuaProfile.checklists[0].kind).toBe("onboarding");
    expect(efuaProfile.checklists[0].total).toBeGreaterThan(0);

    // Onboarding checklist: toggle a task and add a task.
    const cl = (await c.get(`/api/people/checklists/${efuaProfile.checklists[0].id}`)).body;
    const first = cl.groups[0].tasks[0];
    const t = await c.patch(`/api/people/checklists/${cl.id}/tasks/${first.id}`, { done: true });
    expect(t.body.done).toBe(1);
    const add = await c.post(`/api/people/checklists/${cl.id}/tasks`, { title: "Order laptop", group: "Before day one" });
    expect(add.status).toBe(200);
    expect((await c.get(`/api/people/checklists/${cl.id}`)).body.total).toBe(cl.total + 1);
  });
});

describe("people: pay details", () => {
  it("only people with see_pay can view pay, and every view is audited", async () => {
    const e = await createEmployee(admin.c, { firstName: "Yaw", lastName: "Boakye" });

    const put = await admin.c.put(`/api/people/employees/${e.id}/pay`, { salaryAmount: 450000, payFrequency: "Monthly", bankName: "GTBank", accountNumber: "0123456789" });
    expect(put.status).toBe(200);

    const denied = await other.c.get(`/api/people/employees/${e.id}/pay`);
    expect(denied.status).toBe(403);
    const deniedPut = await other.c.put(`/api/people/employees/${e.id}/pay`, { salaryAmount: 1 });
    expect(deniedPut.status).toBe(403);
    const memberProfile = (await other.c.get(`/api/people/employees/${e.id}`)).body;
    expect(memberProfile.canSeePay).toBe(false);
    expect(JSON.stringify(memberProfile)).not.toContain("0123456789");

    const seen = await admin.c.get(`/api/people/employees/${e.id}/pay`);
    expect(seen.status).toBe(200);
    expect(Number(seen.body.salaryAmount)).toBe(450000);
    expect(seen.body.accountNumber).toBe("0123456789");

    const items = (await admin.c.get("/api/audit")).body.items;
    expect(items.some((a: any) => a.summary?.includes("viewed pay details for Yaw Boakye"))).toBe(true);
  });
});

describe("people: leave", () => {
  it("routes a leave request to the manager; approval reduces the balance", async () => {
    const dept = (await admin.c.post("/api/people/departments", { name: "Logistics" })).body;
    const ama = await createEmployee(admin.c, { firstName: "Ama", lastName: "Darko", email: manager.email, departmentId: dept.id });
    const john = await createEmployee(admin.c, { firstName: "John", lastName: "Obi", email: member.email, managerId: ama.id, departmentId: dept.id });
    const types = (await member.c.get("/api/people/leave-types")).body;
    const annual = types.find((t: any) => t.name === "Annual leave");
    const sick = types.find((t: any) => t.name === "Sick leave");

    const mon = nextMonday(2);
    // Sick leave requires a note.
    const noNote = await member.c.post("/api/people/leave/requests", { leaveTypeId: sick.id, startDate: ymd(mon), endDate: ymd(mon) });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.details.reason).toBeTruthy();

    // Mon to next Mon = 6 working days (weekend excluded).
    const r = await member.c.post("/api/people/leave/requests", { leaveTypeId: annual.id, startDate: ymd(mon), endDate: ymd(plus(mon, 7)), reason: "Family visit" });
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(6);
    expect(r.body.status).toBe("pending");
    const leaveId = r.body.id;

    // Shows in the manager's queue, not the member's.
    const waiting = (await manager.c.get("/api/people/leave/requests?scope=waiting")).body;
    expect(waiting.map((w: any) => w.id)).toContain(leaveId);
    expect(waiting[0].canDecide).toBe(true);
    expect((await member.c.get("/api/people/leave/requests?scope=waiting")).body).toHaveLength(0);
    expect((await manager.c.get("/api/people/stats")).body.pendingForMe).toBe(1);

    // A member who isn't the approver can't decide it, nor can the requester.
    expect((await other.c.post(`/api/people/leave/requests/${leaveId}/approve`)).status).toBe(403);
    expect((await member.c.post(`/api/people/leave/requests/${leaveId}/approve`)).status).toBe(403);

    const ok = await manager.c.post(`/api/people/leave/requests/${leaveId}/approve`, { note: "Enjoy" });
    expect(ok.status).toBe(200);
    expect((await manager.c.post(`/api/people/leave/requests/${leaveId}/approve`)).status).toBe(409);

    const mine = (await member.c.get("/api/people/leave/requests?scope=mine")).body;
    expect(mine.find((m: any) => m.id === leaveId).status).toBe("approved");
    const bal = (await member.c.get("/api/people/leave/balances")).body;
    const annualBal = bal.balances.find((b: any) => b.name === "Annual leave");
    // Balances are per calendar year; near year end the request may fall into next year.
    if (ymd(mon).slice(0, 4) === String(new Date().getFullYear())) expect(annualBal.remaining).toBe(14);
    const notes = (await member.c.get("/api/notifications")).body.items;
    expect(notes.some((n: any) => /was approved/.test(n.title))).toBe(true);

    // Calendar shows the approved leave.
    const cal = (await admin.c.get(`/api/people/leave/calendar?from=${ymd(mon)}&to=${ymd(plus(mon, 13))}`)).body;
    expect(cal.people.find((p: any) => p.id === john.id).entries[0].kind).toBe("approved");

    // Clash warning for a colleague in the same department; then cancel own pending request.
    const amaReq = await manager.c.post("/api/people/leave/requests", { leaveTypeId: annual.id, startDate: ymd(plus(mon, 1)), endDate: ymd(plus(mon, 1)) });
    expect(amaReq.status).toBe(200);
    expect(amaReq.body.clash.count).toBe(1);
    expect((await member.c.post(`/api/people/leave/requests/${amaReq.body.id}/cancel`)).status).toBe(403);
    expect((await manager.c.post(`/api/people/leave/requests/${amaReq.body.id}/cancel`)).status).toBe(200);
  });
});

describe("people: offboarding", () => {
  it("marking someone as left suspends their membership and signs them out", async () => {
    const e = await createEmployee(admin.c, { firstName: "Samuel", lastName: "Boateng", email: leaver.email });
    expect((await leaver.c.get("/api/people/attendance/me")).body.employee.id).toBe(e.id);

    const lastDay = ymd(plus(new Date(), 14));
    const leaving = await admin.c.post(`/api/people/employees/${e.id}/leaving`, { endDate: lastDay });
    expect(leaving.status).toBe(200);
    expect(leaving.body.checklistId).toBeTruthy();
    expect((await admin.c.get(`/api/people/employees/${e.id}`)).body.status).toBe("leaving");

    // Only "manage" can mark someone as left.
    expect((await leaver.c.post(`/api/people/employees/${e.id}/left`)).status).toBe(403);

    const left = await admin.c.post(`/api/people/employees/${e.id}/left`, {});
    expect(left.status).toBe(200);
    expect(left.body.accessRemoved).toBe(true);
    expect((await admin.c.get(`/api/people/employees/${e.id}`)).body.status).toBe("left");

    expect((await leaver.c.get("/api/auth/me")).body.user).toBeNull();
    const members = (await admin.c.get("/api/members")).body;
    expect(members.find((m: any) => m.email === leaver.email).status).toBe("suspended");
  });
});

describe("people: attendance", () => {
  it("clocks in and out, and corrections need a note", async () => {
    const e = await createEmployee(admin.c, { firstName: "Amaka", lastName: "Okafor", email: admin.email });
    expect((await admin.c.post("/api/people/attendance/clock-in")).status).toBe(200);
    expect((await admin.c.post("/api/people/attendance/clock-in")).status).toBe(409);
    // Breaks: pause, then resume; pausing twice or resuming when not paused is refused.
    expect((await admin.c.post("/api/people/attendance/resume")).status).toBe(409);
    const paused = await admin.c.post("/api/people/attendance/pause");
    expect(paused.body.record.onBreak).toBe(true);
    expect((await admin.c.post("/api/people/attendance/pause")).status).toBe(409);
    expect((await admin.c.get("/api/people/attendance")).body.rows.find((r: any) => r.employee.id === e.id).record.onBreak).toBe(true);
    const resumed = await admin.c.post("/api/people/attendance/resume");
    expect(resumed.body.record.onBreak).toBe(false);
    expect(resumed.body.record.breaks).toHaveLength(1);
    await admin.c.post("/api/people/attendance/pause");
    // Clocking out during a break closes the break.
    const out = await admin.c.post("/api/people/attendance/clock-out");
    expect(out.status).toBe(200);
    expect(out.body.record.breaks.every((b: any) => b.end)).toBe(true);
    expect(typeof out.body.minutes).toBe("number");
    // Clocked out by mistake: Resume reopens the day; the time away is a break, not work.
    const reopened = await admin.c.post("/api/people/attendance/resume");
    expect(reopened.status).toBe(200);
    expect(reopened.body.record.clockOut).toBeNull();
    expect(reopened.body.record.breaks.at(-1).end).toBeTruthy();
    expect((await admin.c.post("/api/people/attendance/clock-out")).status).toBe(200);
    expect((await admin.c.post("/api/people/attendance/pause")).status).toBe(409);
    const board = (await admin.c.get("/api/people/attendance")).body;
    const row = board.rows.find((r: any) => r.employee.id === e.id);
    expect(["present", "late"]).toContain(row.status);
    const now = new Date();
    const body = { employeeId: e.id, date: ymd(now), clockIn: new Date(now.getTime() - 3600_000).toISOString(), clockOut: now.toISOString(), note: "Forgot to clock in" };
    // A member (people "view") can't correct times.
    expect((await member.c.post("/api/people/attendance/corrections", body)).status).toBe(403);
    expect((await admin.c.post("/api/people/attendance/corrections", { ...body, note: "" })).status).toBe(400);
    expect((await admin.c.post("/api/people/attendance/corrections", body)).status).toBe(200);
    const csv = await admin.c.get(`/api/people/attendance/export?date=${ymd(now)}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain("Amaka Okafor");
  });
});

describe("people: organisation isolation", () => {
  it("org B can't read or change org A's employees", async () => {
    const e = await createEmployee(admin.c, { firstName: "Fatima", lastName: "Abubakar" });
    expect((await orgB.c.get(`/api/people/employees/${e.id}`)).status).toBe(404);
    expect((await orgB.c.patch(`/api/people/employees/${e.id}`, { jobTitle: "Hacker" })).status).toBe(404);
    expect((await orgB.c.get(`/api/people/employees/${e.id}/pay`)).status).toBe(404);
    expect((await orgB.c.post(`/api/people/employees/${e.id}/left`, {})).status).toBe(404);
    expect((await orgB.c.get("/api/people/employees")).body.total).toBe(0);
  });
});

describe("people: supporting endpoints", () => {
  it("serves the org chart, departments, checklists, calendar, holidays and exports", async () => {
    const c = admin.c;
    for (const url of [
      "/api/people/org-chart", "/api/people/departments", "/api/people/checklists", "/api/people/checklists?status=all",
      "/api/people/leave/calendar?team=mine", "/api/people/holidays", "/api/people/employees/options", "/api/people/leave/requests?scope=all",
      "/api/people/leave/working-days?startDate=2026-11-02&endDate=2026-11-08", "/api/people/attendance/me",
    ]) {
      const r = await c.get(url);
      expect(r.status, url).toBe(200);
    }
    expect((await c.get("/api/people/leave/working-days?startDate=2026-11-02&endDate=2026-11-08")).body.days).toBe(5);
    const hol = await c.post("/api/people/holidays", { name: "Test Day", day: "2026-11-04" });
    expect(hol.status).toBe(200);
    expect((await c.get("/api/people/leave/working-days?startDate=2026-11-02&endDate=2026-11-08")).body.days).toBe(4);
    expect((await c.del(`/api/people/holidays/${hol.body.id}`)).status).toBe(200);
    const csv = await c.get("/api/people/employees/export");
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain("Kofi");
    expect((await member.c.get("/api/people/employees/export")).status).toBe(403);
    // Departments and leave types need "manage".
    expect((await member.c.post("/api/people/departments", { name: "Nope" })).status).toBe(403);
    expect((await member.c.post("/api/people/leave-types", { name: "Nope" })).status).toBe(403);
    const lt = await c.post("/api/people/leave-types", { name: "Study leave", daysPerYear: 5 });
    expect(lt.status).toBe(200);
    expect((await c.patch(`/api/people/leave-types/${lt.body.id}`, { daysPerYear: "" })).body.daysPerYear).toBeNull();
    const chart = (await c.get("/api/people/org-chart")).body;
    expect(chart.top.some((t: any) => t.reports.length > 0)).toBe(true);
  });
});
