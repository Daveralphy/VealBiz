import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client";
import { employees } from "../src/db/schema";
import { addMember, getApp, giveAccess, signUpWithOrg, type Client } from "./helpers";

/** Each request gets a random client IP so the per-IP sign-up rate limit doesn't trip across many test sign-ups. */
beforeAll(async () => {
  const app = await getApp();
  const orig = app.inject.bind(app) as (o: any) => any;
  const n = () => Math.floor(Math.random() * 250) + 1;
  (app as any).inject = (opts: any) => orig({ ...opts, headers: { "x-forwarded-for": `10.${n()}.${n()}.${n()}`, ...(opts?.headers ?? {}) } });
});

async function myUserId(c: Client): Promise<string> {
  return (await c.get("/api/auth/me")).body.user.id;
}

describe("workflows: tasks", () => {
  it("creates, assigns, completes and reopens a task", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: member } = await addMember(app, admin, "member", "Kofi Mensah");
    const memberId = await myUserId(member);

    const bad = await admin.post("/api/workflows/tasks", { title: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.title).toBeTruthy();

    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const r = await admin.post("/api/workflows/tasks", { title: "Send revised price list", assigneeUserId: memberId, dueAt: due, priority: "high" });
    expect(r.status).toBe(200);
    expect(r.body.assignee.id).toBe(memberId);
    const id = r.body.id;

    const mine = await member.get("/api/workflows/tasks?scope=mine");
    const all = mine.body.groups.flatMap((g: any) => g.tasks);
    expect(all.map((t: any) => t.id)).toContain(id);
    const notes = await member.get("/api/notifications");
    expect(notes.body.items.some((n: any) => n.title.includes("Send revised price list"))).toBe(true);

    const done = await member.post(`/api/workflows/tasks/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe("done");
    expect(done.body.next).toBeNull();
    expect((await member.post(`/api/workflows/tasks/${id}/complete`)).status).toBe(409);

    const re = await member.post(`/api/workflows/tasks/${id}/reopen`);
    expect(re.body.status).toBe("todo");

    const detail = await admin.get(`/api/workflows/tasks/${id}`);
    expect(detail.body.activity).toBeUndefined();

    // Checklist items
    const item = await member.post(`/api/workflows/tasks/${id}/items`, { label: "Check prices" });
    expect(item.status).toBe(200);
    const tog = await member.patch(`/api/workflows/tasks/${id}/items/${item.body.id}`, { done: true });
    expect(tog.body.done).toBe(true);

    // Only the creator or an admin can delete
    expect((await member.del(`/api/workflows/tasks/${id}`)).status).toBe(403);
    expect((await admin.del(`/api/workflows/tasks/${id}`)).status).toBe(200);
    expect((await admin.get(`/api/workflows/tasks/${id}`)).status).toBe(404);
  });

  it("creates the next occurrence when a repeating task is completed", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const due = new Date("2026-11-03T09:00:00.000Z");
    const r = await admin.post("/api/workflows/tasks", { title: "Weekly stock count", dueAt: due.toISOString(), repeatRule: "weekly", assigneeUserId: await myUserId(admin) });
    await admin.post(`/api/workflows/tasks/${r.body.id}/items`, { label: "Count the cold room" });
    const done = await admin.post(`/api/workflows/tasks/${r.body.id}/complete`);
    expect(done.body.next).toBeTruthy();
    expect(done.body.next.title).toBe("Weekly stock count");
    expect(done.body.next.repeatRule).toBe("weekly");
    expect(new Date(done.body.next.dueAt).getTime()).toBe(due.getTime() + 7 * 86_400_000);
    expect(done.body.next.counts.items).toBe(1);

    const monthly = await admin.post("/api/workflows/tasks", { title: "Month-end close", dueAt: "2026-01-31T09:00:00.000Z", repeatRule: "monthly" });
    const m = await admin.post(`/api/workflows/tasks/${monthly.body.id}/complete`);
    expect(new Date(m.body.next.dueAt).getUTCMonth()).toBeGreaterThanOrEqual(1);
  });

  it("notifies people @mentioned in a comment", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: ngozi } = await addMember(app, admin, "member", "Ngozi Eze");
    const { c: kofi } = await addMember(app, admin, "member", "Kofi Mensah");
    const t = await admin.post("/api/workflows/tasks", { title: "Renew service agreement" });
    const cm = await admin.post(`/api/workflows/tasks/${t.body.id}/comments`, { body: "@Ngozi Eze the new price is fine." });
    expect(cm.status).toBe(200);
    expect(cm.body.mentioned).toEqual(["Ngozi Eze"]);
    const n1 = await ngozi.get("/api/notifications");
    expect(n1.body.items.some((n: any) => n.title.includes("mentioned you"))).toBe(true);
    const n2 = await kofi.get("/api/notifications");
    expect(n2.body.items.some((n: any) => n.title.includes("mentioned you"))).toBe(false);

    await admin.post(`/api/workflows/tasks/${t.body.id}/comments`, { body: "Over to you, @kofi!" });
    const n3 = await kofi.get("/api/notifications");
    expect(n3.body.items.some((n: any) => n.title.includes("mentioned you"))).toBe(true);

    const detail = await admin.get(`/api/workflows/tasks/${t.body.id}`);
    expect(detail.body.comments).toHaveLength(2);
  });
});

describe("workflows: approvals", () => {
  it("routes a purchase over a rule's amount through the manager and then finance", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    const { c: manager } = await addMember(app, admin, "manager", "Amaka Manager");
    const { c: finance, email: financeEmail } = await addMember(app, admin, "member", "Ngozi Finance");
    const { c: requester, email: requesterEmail } = await addMember(app, admin, "member", "Yaw Boakye");
    await giveAccess(admin, financeEmail, { workflows: "edit" });
    await giveAccess(admin, requesterEmail, { workflows: "edit" });
    const [managerId, financeId, requesterId] = await Promise.all([myUserId(manager), myUserId(finance), myUserId(requester)]);

    // Requester reports to the manager (People & HR data).
    const [mgrEmp] = await db.insert(employees).values({ orgId: org.id, userId: managerId, firstName: "Amaka", lastName: "Manager" }).returning();
    await db.insert(employees).values({ orgId: org.id, userId: requesterId, firstName: "Yaw", lastName: "Boakye", managerId: mgrEmp!.id });

    // Only admins manage rules.
    expect((await manager.post("/api/workflows/approval-rules", { kind: "purchase", minAmount: 250000, approverUserId: financeId })).status).toBe(403);
    const rule = await admin.post("/api/workflows/approval-rules", { kind: "purchase", minAmount: 250000, approverUserId: financeId, label: "Finance" });
    expect(rule.status).toBe(200);

    // Small purchase: manager only.
    const small = await requester.post("/api/workflows/approvals", { kind: "purchase", title: "Printer paper", amount: 20000 });
    expect(small.body.steps).toBe(1);

    const r = await requester.post("/api/workflows/approvals", { kind: "purchase", title: "Delivery van tyres", details: "4 tyres", amount: 480000 });
    expect(r.status).toBe(200);
    expect(r.body.steps).toBe(2);
    expect(r.body.currentApprover.id).toBe(managerId);
    const id = r.body.id;

    const waiting = await manager.get("/api/workflows/approvals?scope=waiting");
    expect(waiting.body.map((a: any) => a.id)).toContain(id);
    expect((await finance.get("/api/workflows/approvals?scope=waiting")).body.map((a: any) => a.id)).not.toContain(id);

    // Not their turn yet.
    expect((await finance.post(`/api/workflows/approvals/${id}/decide`, { decision: "approve" })).status).toBe(403);
    expect((await requester.post(`/api/workflows/approvals/${id}/decide`, { decision: "approve" })).status).toBe(403);

    const d1 = await manager.post(`/api/workflows/approvals/${id}/decide`, { decision: "approve", comment: "Needed for safety" });
    expect(d1.status).toBe(200);
    expect(d1.body.status).toBe("pending");
    expect((await manager.post(`/api/workflows/approvals/${id}/decide`, { decision: "approve" })).status).toBe(403);

    const detail = await finance.get(`/api/workflows/approvals/${id}`);
    expect(detail.body.canDecide).toBe(true);
    expect(detail.body.steps.map((s: any) => s.status)).toEqual(["approved", "pending"]);
    expect(detail.body.steps[1].label).toBe("Finance");

    const d2 = await finance.post(`/api/workflows/approvals/${id}/decide`, { decision: "approve" });
    expect(d2.body.status).toBe("approved");
    expect((await finance.post(`/api/workflows/approvals/${id}/decide`, { decision: "approve" })).status).toBe(409);

    const notes = await requester.get("/api/notifications");
    expect(notes.body.items.some((n: any) => n.title === "Approved: Delivery van tyres")).toBe(true);

    // Only admins see every approval.
    expect((await requester.get("/api/workflows/approvals?scope=all")).status).toBe(403);
    expect((await admin.get("/api/workflows/approvals?scope=all")).body.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to an admin when the requester has no manager, and a decline ends the request", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: member, email } = await addMember(app, admin, "member", "Efua Nyarko");
    await giveAccess(admin, email, { workflows: "edit" });
    const adminId = await myUserId(admin);
    const r = await member.post("/api/workflows/approvals", { kind: "other", title: "Work from Kumasi for a week" });
    expect(r.body.currentApprover.id).toBe(adminId);
    const d = await admin.post(`/api/workflows/approvals/${r.body.id}/decide`, { decision: "decline", comment: "Not this month" });
    expect(d.body.status).toBe("declined");
  });
});

describe("workflows: templates", () => {
  it("lists default templates, edits one and uses it for an employee", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    const list = await admin.get("/api/workflows/templates");
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const onboarding = list.body.find((t: any) => t.kind === "onboarding");
    const up = await admin.patch(`/api/workflows/templates/${onboarding.id}`, {
      items: [...onboarding.items, { title: "Product and pricing training", group: "First week", assigneeRole: "manager", offsetDays: 6 }],
    });
    expect(up.body.items).toHaveLength(onboarding.items.length + 1);
    const [emp] = await db.insert(employees).values({ orgId: org.id, firstName: "Efua", lastName: "Nyarko", startDate: "2026-11-10" }).returning();
    const use = await admin.post(`/api/workflows/templates/${onboarding.id}/use`, { employeeId: emp!.id });
    expect(use.status).toBe(200);
    expect(use.body.checklistId).toBeTruthy();
    const all = await admin.get("/api/workflows/tasks?scope=all&workspace=people");
    expect(all.body.groups.flatMap((g: any) => g.tasks).length).toBe(onboarding.items.length + 1);

    const { c: member } = await addMember(app, admin, "member", "Kofi Mensah");
    expect((await member.post("/api/workflows/templates", { name: "Mine", items: [] })).status).toBe(403);
  });
});

describe("workflows: organisation isolation", () => {
  it("keeps tasks and approvals inside their organisation", async () => {
    const app = await getApp();
    const a = await signUpWithOrg(app);
    const b = await signUpWithOrg(app);
    const { c: aMember } = await addMember(app, a.c, "member", "Grace Eze");
    const t = await a.c.post("/api/workflows/tasks", { title: "Secret task" });
    const ap = await aMember.post("/api/workflows/approvals", { kind: "purchase", title: "Chairs", amount: 1000 });
    expect((await b.c.get(`/api/workflows/tasks/${t.body.id}`)).status).toBe(404);
    expect((await b.c.patch(`/api/workflows/tasks/${t.body.id}`, { title: "Hacked" })).status).toBe(404);
    expect((await b.c.post(`/api/workflows/tasks/${t.body.id}/comments`, { body: "hi" })).status).toBe(404);
    expect((await b.c.get(`/api/workflows/approvals/${ap.body.id}`)).status).toBe(404);
    expect((await b.c.post(`/api/workflows/approvals/${ap.body.id}/decide`, { decision: "approve" })).status).toBe(404);
    const bAll = await b.c.get("/api/workflows/tasks?scope=all");
    expect(bAll.body.groups.flatMap((g: any) => g.tasks).map((x: any) => x.id)).not.toContain(t.body.id);
    expect((await b.c.get("/api/workflows/approvals?scope=all")).body.map((x: any) => x.id)).not.toContain(ap.body.id);
    // Can't assign to someone from another organisation.
    const aUser = (await a.c.get("/api/auth/me")).body.user.id;
    expect((await b.c.post("/api/workflows/tasks", { title: "x", assigneeUserId: aUser })).status).toBe(400);
  });
});
