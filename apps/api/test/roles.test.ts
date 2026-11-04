import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db/client";
import { organisations } from "../src/db/schema";
import { recentMail } from "../src/lib/mailer";
import { Client, getApp, signUp, signUpWithOrg } from "./helpers";

const NONE = { people: "none", recruitment: "none", crm: "none", workflows: "none", documents: "none", insights: "none" };

/** Invites someone with a role id (or "admin") and returns them signed in. */
async function join(app: FastifyInstance, admin: Client, roleId: string, name = "New Person") {
  const { c, email } = await signUp(app, name);
  const r = await admin.post("/api/invitations", { invites: [{ email, roleId }] });
  if (r.status !== 200) throw new Error(`invite failed: ${JSON.stringify(r.body)}`);
  const token = recentMail(email).find((m) => m.link?.includes("/invite/"))!.link!.split("/invite/")[1]!;
  expect((await c.post(`/api/invite/${token}/accept`)).status).toBe(200);
  const me = (await c.get("/api/auth/me")).body;
  return { c, email, membershipId: me.membership.id as string, me };
}

async function growth(orgId: string) {
  await db.update(organisations).set({ plan: "growth" }).where(eq(organisations.id, orgId));
}

describe("roles", () => {
  it("on Free there's Admin and Manager only; custom roles need Growth", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const list = await admin.get("/api/roles");
    expect(list.body.canCustomise).toBe(false);
    expect(list.body.roles.map((r: any) => r.name)).toEqual(["Manager"]);
    expect((await admin.post("/api/roles", { name: "Sales rep", access: { ...NONE, crm: "edit" }, special: [] })).status).toBe(403);

    // Manager can still be tuned on Free, and people invited as Manager get exactly that.
    const manager = list.body.roles[0];
    expect((await admin.patch(`/api/roles/${manager.id}`, { name: "Manager", access: { ...manager.access, insights: "none" }, special: [] })).status).toBe(200);
    const { me } = await join(app, admin, manager.id, "Kofi Mensah");
    expect(me.membership.roleName).toBe("Manager");
    expect(me.membership.access.insights).toBe("none");
    expect(me.membership.special).toEqual([]);
  });

  it("custom roles decide what people can open, and an admin can add more for one person", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    await growth(org.id);
    const hr = await admin.post("/api/roles", {
      name: "HR officer", description: "Runs people and hiring", access: { ...NONE, people: "manage", recruitment: "edit" }, special: ["approve_leave", "see_pay"],
    });
    expect(hr.status).toBe(200);
    expect((await admin.post("/api/roles", { name: "hr officer", access: NONE, special: [] })).status).toBe(409);

    const { c: person, membershipId, me } = await join(app, admin, hr.body.role.id, "Fatima Abubakar");
    expect(me.membership.roleName).toBe("HR officer");
    expect(me.membership.access).toMatchObject({ people: "manage", recruitment: "edit", crm: "none" });

    // Anything outside the role is closed, however it's asked for.
    expect((await person.get("/api/crm/companies")).status).toBe(403);
    expect((await person.get("/api/recruitment/jobs")).status).toBe(200);
    expect((await person.get("/api/roles")).status).toBe(403);
    expect((await person.get("/api/invitations")).status).toBe(403);

    // Extra access for just this person.
    const detail = await admin.get(`/api/members/${membershipId}`);
    expect(detail.body.role.name).toBe("HR officer");
    expect(detail.body.fromRole.access.crm).toBe("none");
    expect((await admin.patch(`/api/members/${membershipId}`, { workspaceAccess: { crm: "view" }, specialPermissions: ["export_data"] })).status).toBe(200);
    const after = (await person.get("/api/auth/me")).body.membership;
    expect(after.access.crm).toBe("view");
    expect(after.special).toEqual(expect.arrayContaining(["approve_leave", "see_pay", "export_data"]));
    expect((await person.get("/api/crm/companies")).status).toBe(200);
    expect((await person.post("/api/crm/companies", { name: "Apex Bakery" })).status).toBe(403);

    // A role in use can't be deleted; once nobody has it, it can.
    expect((await admin.del(`/api/roles/${hr.body.role.id}`)).status).toBe(409);
    const manager = (await admin.get("/api/roles")).body.roles.find((r: any) => r.kind === "manager");
    expect((await admin.patch(`/api/members/${membershipId}`, { roleId: manager.id })).status).toBe(200);
    expect((await person.get("/api/auth/me")).body.membership.roleName).toBe("Manager");
    expect((await admin.del(`/api/roles/${hr.body.role.id}`)).status).toBe(200);
    expect((await admin.del(`/api/roles/${manager.id}`)).status).toBe(403);
  });

  it("people who can manage members invite and change roles, but only admins deal with admins", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    await growth(org.id);
    const lead = (await admin.post("/api/roles", { name: "Team lead", access: { ...NONE, workflows: "edit" }, special: ["manage_members"] })).body.role;
    const { c: teamLead } = await join(app, admin, lead.id, "Team Lead");
    const { email } = await signUp(app, "Invitee");
    expect((await teamLead.post("/api/invitations", { invites: [{ email, roleId: "admin" }] })).status).toBe(403);
    expect((await teamLead.post("/api/invitations", { invites: [{ email, roleId: lead.id }] })).status).toBe(200);
    expect((await teamLead.get("/api/roles")).status).toBe(403);
    const adminRow = (await admin.get("/api/members")).body.find((m: any) => m.role === "admin");
    expect((await teamLead.patch(`/api/members/${adminRow.id}`, { roleId: lead.id })).status).toBe(403);
  });

  it("people on the old built-in Member role keep their access", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { email } = await signUp(app, "Old Member");
    await admin.post("/api/invitations", { invites: [{ email, role: "member" }] });
    const roles = (await admin.get("/api/roles")).body.roles.map((r: any) => r.name);
    expect(roles).toEqual(["Manager", "Member"]);
  });
});

describe("audit history", () => {
  it("keeps changes that matter and leaves out everyday adding and deleting", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    await admin.post("/api/crm/companies", { name: "Apex Bakery" });
    const { email } = await signUp(app, "Invited Person");
    await admin.post("/api/invitations", { invites: [{ email, role: "manager" }] });
    const items = (await admin.get("/api/audit?days=1")).body.items.map((i: any) => i.action);
    expect(items).toContain("member.invited");
    expect(items.some((a: string) => a.startsWith("crm."))).toBe(false);
  });
});

describe("notifications", () => {
  it("are all on to start, and a kind someone turns off doesn't reach them", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    expect((await admin.get("/api/notifications/settings")).body.prefs).toEqual({ off: [], desktop: true });
    expect((await admin.put("/api/notifications/settings", { off: ["team"], desktop: false })).status).toBe(200);
    // Someone joining is a "team" notification: turned off, so it never arrives.
    const { c: person, email } = await signUp(app, "New Joiner");
    await admin.post("/api/invitations", { invites: [{ email, role: "manager" }] });
    const token = recentMail(email).find((m) => m.link?.includes("/invite/"))!.link!.split("/invite/")[1]!;
    await person.post(`/api/invite/${token}/accept`);
    const items = (await admin.get("/api/notifications")).body.items;
    expect(items.some((n: any) => /joined/.test(n.title))).toBe(false);
  });
});

describe("search", () => {
  it("covers everything from Home and only the area you're in otherwise", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    await admin.post("/api/crm/companies", { name: "Zephyr Bakery" });
    const everywhere = (await admin.get("/api/search?q=zephyr")).body.results;
    expect(everywhere.map((r: any) => r.type)).toContain("Companies");
    expect((await admin.get("/api/search?scope=crm&q=zephyr")).body.results.length).toBe(1);
    expect((await admin.get("/api/search?scope=people&q=zephyr")).body.results).toEqual([]);
    expect((await admin.get("/api/search?scope=settings&q=amaka")).body.results.map((r: any) => r.type)).toEqual(["Members"]);
  });
});

describe("everyone is on the team, and sees only their own things", () => {
  it("someone with no People & HR access can clock in and sees only their own records in My space", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    await growth(org.id);
    const driver = (await admin.post("/api/roles", { name: "Driver", access: NONE, special: [] })).body.role;
    const { c: person, me } = await join(app, admin, driver.id, "Musa Bello");
    expect(me.membership.access.people).toBe("none");
    expect((await person.post("/api/people/attendance/clock-in", {})).status).toBe(200);
    expect((await person.get("/api/my/attendance")).body.days).toHaveLength(1);
    expect((await person.get("/api/my/summary")).body.employee.firstName).toBe("Musa");
    expect((await person.get("/api/my/pay")).status).toBe(200);
    // Nobody else's records.
    expect((await person.get("/api/people/employees")).status).toBe(403);
    expect((await person.get("/api/people/attendance")).status).toBe(403);
    expect(JSON.stringify((await admin.get("/api/people/employees")).body)).toContain("Musa");
  });

  it("a manager with People & HR View sees only the people who report to them", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    await growth(org.id);
    const lead = (await admin.post("/api/roles", { name: "Team lead", access: { ...NONE, people: "view" }, special: [] })).body.role;
    const { c: boss } = await join(app, admin, lead.id, "Ngozi Eze");
    await boss.get("/api/my/summary");
    const bossId = (await admin.get("/api/people/employees?search=Ngozi")).body.items[0].id;
    const mine = (await admin.post("/api/people/employees", { firstName: "Tobi", lastName: "Ade", managerId: bossId })).body.employee;
    const other = (await admin.post("/api/people/employees", { firstName: "Kemi", lastName: "Ola" })).body.employee;
    const names = (await boss.get("/api/people/employees")).body.items.map((e: any) => e.firstName);
    expect(names.sort()).toEqual(["Ngozi", "Tobi"]);
    expect((await boss.get(`/api/people/employees/${mine.id}`)).status).toBe(200);
    expect((await boss.get(`/api/people/employees/${other.id}`)).status).toBe(404);
    expect((await boss.get("/api/people/attendance")).body.rows.map((r: any) => r.employee.name)).not.toContain("Kemi Ola");
  });
});
