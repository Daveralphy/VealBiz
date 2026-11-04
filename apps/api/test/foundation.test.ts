import { describe, expect, it } from "vitest";
import { recentMail } from "../src/lib/mailer";
import { Client, PASSWORD, addMember, getApp, signUp, signUpWithOrg } from "./helpers";

describe("health", () => {
  it("reports database status", async () => {
    const app = await getApp();
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json().database).toBe("up");
  });
});

describe("accounts", () => {
  it("registers, verifies with a code, and signs in", async () => {
    const app = await getApp();
    const { c, email } = await signUp(app);
    const me = await c.get("/api/auth/me");
    expect(me.body.user.emailVerified).toBe(true);
    await c.post("/api/auth/logout");
    expect((await c.get("/api/auth/me")).body.user).toBeNull();
    const bad = await c.post("/api/auth/login", { email, password: "Wrong#password1" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe("Email or password is incorrect.");
    const ok = await c.post("/api/auth/login", { email, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it("rejects weak passwords with field messages", async () => {
    const app = await getApp();
    const r = await new Client(app).post("/api/auth/register", { name: "A B", email: "weak@example.com", password: "short", acceptTerms: true });
    expect(r.status).toBe(400);
    expect(r.body.error.details.password).toBeTruthy();
  });

  it("reset tokens are single-use and sign out other sessions", async () => {
    const app = await getApp();
    const { c, email } = await signUp(app);
    await new Client(app).post("/api/auth/forgot-password", { email });
    const token = recentMail(email).find((m) => m.link?.includes("reset-password"))!.link!.split("token=")[1]!;
    const first = await new Client(app).post("/api/auth/reset-password", { token, password: "New#Password99" });
    expect(first.status).toBe(200);
    const again = await new Client(app).post("/api/auth/reset-password", { token, password: "New#Password98" });
    expect(again.status).toBe(400);
    expect((await c.get("/api/auth/me")).body.user).toBeNull();
  });
});

describe("organisations and members", () => {
  it("creates an org with the creator as primary admin, pending verification", async () => {
    const app = await getApp();
    const { c, org } = await signUpWithOrg(app, undefined, { approved: false });
    expect(org.verificationStatus).toBe("pending");
    // Nothing but setup and its review works until WindVeal approves it.
    expect((await c.get("/api/people/employees")).status).toBe(403);
    expect((await c.post("/api/invitations", { invites: [{ email: "x@example.com", role: "member" }] })).status).toBe(403);
    expect((await c.get("/api/org/review")).status).toBe(200);
    expect(org.currency).toBe("NGN");
    const me = await c.get("/api/auth/me");
    expect(me.body.membership.role).toBe("admin");
    expect(me.body.membership.isPrimaryAdmin).toBe(true);
  });

  it("enforces one organisation per person", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const r = await c.post("/api/org", { legalName: "Second Ltd", industry: "Retail", teamSize: "1 to 10 people", country: "GH", city: "Accra", address: "1 Ring Road" });
    expect(r.status).toBe(409);
  });

  it("keeps organisations isolated from each other", async () => {
    const app = await getApp();
    const a = await signUpWithOrg(app);
    const b = await signUpWithOrg(app);
    const membersA = (await a.c.get("/api/members")).body;
    const membersB = (await b.c.get("/api/members")).body;
    expect(membersA).toHaveLength(1);
    expect(membersB).toHaveLength(1);
    expect(membersA[0].userId).not.toBe(membersB[0].userId);
  });

  it("invites, accepts, and protects the last admin", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: member } = await addMember(app, admin, "member", "Kofi Mensah");
    const members = (await admin.get("/api/members")).body;
    expect(members).toHaveLength(2);
    // A member can't manage people.
    expect((await member.post("/api/invitations", { invites: [{ email: "x@example.com", role: "member" }] })).status).toBe(403);
    // The primary admin can't be demoted.
    const me = members.find((m: any) => m.isYou);
    expect((await admin.patch(`/api/members/${me.id}`, { role: "member" })).status).toBe(403);
    // Suspending someone signs them out.
    const kofi = members.find((m: any) => !m.isYou);
    expect((await admin.patch(`/api/members/${kofi.id}`, { status: "suspended" })).status).toBe(200);
    expect((await member.get("/api/members")).status).toBe(401);
    // Audit history recorded it.
    const audit = (await admin.get("/api/audit")).body.items;
    expect(audit.some((e: any) => e.action === "member.updated")).toBe(true);
  });
});
