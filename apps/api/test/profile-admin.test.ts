import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema";
import { recentMail } from "../src/lib/mailer";
import { Client, PASSWORD, getApp, signUp, signUpWithOrg } from "./helpers";

const NEW_PASSWORD = "Another#2026pass";

async function makePlatformAdmin(email: string) {
  await db.update(users).set({ platformAdmin: true }).where(eq(users.email, email));
}

describe("profile", () => {
  it("updates personal details and keeps the employee record in step", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const r = await c.patch("/api/auth/profile", { name: "Amaka Okafor-Bello", phone: "+234 801 000 0000", jobTitle: "Founder" });
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe("Amaka Okafor-Bello");
    expect(r.body.user.phone).toBe("+234 801 000 0000");
    expect(r.body.membership.jobTitle).toBe("Founder");
  });

  it("only accepts a photo the person uploaded themself", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const r = await c.patch("/api/auth/profile", { name: "Amaka Okafor", avatarFileId: "00000000-0000-4000-8000-000000000000" });
    expect(r.status).toBe(400);
  });

  it("changes email only after a code sent to the new address", async () => {
    const app = await getApp();
    const { c, email } = await signUpWithOrg(app);
    const newEmail = `new-${Date.now()}@example.com`;
    const wrongPw = await c.post("/api/auth/email-change/request", { newEmail, currentPassword: "Wrong#pass2026" });
    expect(wrongPw.status).toBe(400);
    expect((await c.post("/api/auth/email-change/request", { newEmail, currentPassword: PASSWORD })).status).toBe(200);
    // Nothing changes until the code is entered.
    expect((await c.get("/api/auth/me")).body.user.email).toBe(email);
    expect((await c.post("/api/auth/email-change/confirm", { code: "000000" })).status).toBe(400);
    const code = recentMail(newEmail)[0]!.code!;
    const r = await c.post("/api/auth/email-change/confirm", { code });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe(newEmail);
    expect(recentMail(email)[0]!.subject).toMatch(/email was changed/);
    // The code can't be used twice.
    expect((await c.post("/api/auth/email-change/confirm", { code })).status).toBe(400);
  });

  it("changes password only with the emailed code, and signs out other devices", async () => {
    const app = await getApp();
    const { c, email } = await signUp(app);
    const other = new Client(app);
    await other.post("/api/auth/login", { email, password: PASSWORD });
    expect((await c.post("/api/auth/change-password", { code: "123456", password: NEW_PASSWORD })).status).toBe(400);
    expect((await c.post("/api/auth/change-password/request", { currentPassword: PASSWORD })).status).toBe(200);
    const code = recentMail(email)[0]!.code!;
    expect((await c.post("/api/auth/change-password", { code, password: NEW_PASSWORD })).status).toBe(200);
    expect((await other.get("/api/auth/me")).body.user).toBeNull();
    expect((await c.get("/api/auth/me")).body.user.email).toBe(email);
    expect((await new Client(app).post("/api/auth/login", { email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("using one reset link cancels the other unused ones", async () => {
    const app = await getApp();
    const { email } = await signUp(app);
    const anon = new Client(app);
    await anon.post("/api/auth/forgot-password", { email });
    await anon.post("/api/auth/forgot-password", { email });
    const [second, first] = recentMail(email).filter((m) => m.link?.includes("reset-password")).map((m) => m.link!.split("token=")[1]!);
    expect((await anon.post("/api/auth/reset-password", { token: second, password: NEW_PASSWORD })).status).toBe(200);
    expect((await anon.post("/api/auth/reset-password", { token: first, password: NEW_PASSWORD })).status).toBe(400);
  });
});

/** Uploads a small PDF as the given client and returns its file id. */
async function uploadPdf(app: Awaited<ReturnType<typeof getApp>>, c: Client, name = "certificate.pdf") {
  const up = await app.inject({
    method: "POST", url: "/api/files?kind=system",
    headers: { cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "multipart/form-data; boundary=X" },
    payload: `--X\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 test\r\n--X--\r\n`,
  });
  return up.json().file.id as string;
}

describe("WindVeal review", () => {
  it("is sent at the end of setup, asks for more, takes the reply and approves", async () => {
    const app = await getApp();
    const { c, org, email } = await signUpWithOrg(app, undefined, { approved: false });
    const { c: platform, email: staff } = await signUpWithOrg(app, "WindVeal Staff Org");
    await makePlatformAdmin(staff);

    // A certificate is needed before it can be sent.
    expect((await c.post("/api/org/submit-review")).status).toBe(400);
    const cert = await uploadPdf(app, c);
    expect((await c.post("/api/org/verification-document", { fileId: cert, proof: "certificate" })).status).toBe(200);
    expect((await c.post("/api/org/submit-review")).status).toBe(200);
    expect(recentMail(email)[0]!.subject).toMatch(/^We're reviewing/);
    expect(recentMail(staff)[0]!.subject).toMatch(/^New business to review/);
    expect((await platform.get("/api/admin/organisations?status=pending")).body.some((o: any) => o.id === org.id)).toBe(true);

    // Asking for more needs what and why.
    expect((await platform.post(`/api/admin/organisations/${org.id}/verification`, { status: "needs_info", items: [], message: "x" })).status).toBe(400);
    const ask = await platform.post(`/api/admin/organisations/${org.id}/verification`, {
      status: "needs_info", items: ["address", "registration_number"], message: "The number doesn't match the certificate.",
    });
    expect(ask.status).toBe(200);
    expect(recentMail(email)[0]!.subject).toMatch(/needs a little more/);
    let review = (await c.get("/api/org/review")).body;
    expect(review.status).toBe("needs_info");
    expect(review.request.items.map((i: any) => i.key)).toEqual(["address", "registration_number"]);

    // It can't be sent back until every item is done.
    expect((await c.post("/api/org/review/submit")).status).toBe(400);
    const bill = await uploadPdf(app, c, "bill.pdf");
    await c.post("/api/org/verification-document", { fileId: bill, proof: "address", item: "address" });
    await c.patch("/api/org/details", { registrationNumber: "RC 99887" });
    review = (await c.get("/api/org/review")).body;
    expect(review.request.items.every((i: any) => i.doneAt)).toBe(true);
    expect((await c.post("/api/org/review/submit")).status).toBe(200);
    expect(recentMail(staff)[0]!.subject).toMatch(/sent more for review/);

    // The reviewer sees the documents (and which proof each one is), ticks checks and approves.
    const detail = await platform.get(`/api/admin/organisations/${org.id}`);
    expect(detail.body.documents.map((f: any) => [f.id, f.proof])).toEqual(expect.arrayContaining([[cert, "certificate"], [bill, "address"]]));
    expect(detail.body.review.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(["org.verification_submitted", "org.verification_needs_info", "org.verification_resubmitted"]));
    expect((await platform.post(`/api/admin/organisations/${org.id}/checks`, { key: "certificate", done: true })).body.checks.certificate).toBe(true);
    const file = await app.inject({ method: "GET", url: `/api/admin/files/${cert}/content`, headers: { cookie: Object.entries(platform.cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
    expect(file.body).toContain("%PDF-1.4 test");
    expect((await platform.post(`/api/admin/organisations/${org.id}/verification`, { status: "verified" })).status).toBe(200);
    expect(recentMail(email)[0]!.subject).toMatch(/is approved$/);
    expect((await c.get("/api/people/employees")).status).toBe(200);
  });

  it("not approving needs a reason, and the business stays locked out", async () => {
    const app = await getApp();
    const { c, org, email } = await signUpWithOrg(app, undefined, { approved: false });
    const { c: platform, email: staff } = await signUpWithOrg(app, "WindVeal Staff Org");
    await makePlatformAdmin(staff);
    expect((await platform.post(`/api/admin/organisations/${org.id}/verification`, { status: "rejected" })).status).toBe(400);
    expect((await platform.post(`/api/admin/organisations/${org.id}/verification`, { status: "rejected", note: "Not a registered business" })).status).toBe(200);
    expect(recentMail(email)[0]!.subject).toMatch(/^We couldn't approve/);
    const review = (await c.get("/api/org/review")).body;
    expect([review.status, review.note]).toEqual(["rejected", "Not a registered business"]);
    expect((await c.get("/api/crm/companies")).status).toBe(403);
  });
});

describe("WindVeal admin panel", () => {
  it("is closed to everyone who isn't WindVeal staff, including organisation admins", async () => {
    const app = await getApp();
    const { c, org } = await signUpWithOrg(app);
    for (const url of ["/api/admin/summary", "/api/admin/organisations", `/api/admin/organisations/${org.id}`, "/api/admin/users"]) {
      expect((await c.get(url)).status).toBe(403);
    }
    expect((await c.post(`/api/admin/organisations/${org.id}/verification`, { status: "verified" })).status).toBe(403);
    expect((await new Client(app).get("/api/admin/summary")).status).toBe(401);
  });

  it("reviews an organisation, approves it and tells its admins", async () => {
    const app = await getApp();
    const { c, org } = await signUpWithOrg(app, undefined, { approved: false });
    const cert = await uploadPdf(app, c);
    await c.post("/api/org/verification-document", { fileId: cert, proof: "certificate" });
    await c.post("/api/org/submit-review");
    const { c: platform, email: staff } = await signUpWithOrg(app, "WindVeal Review Org");
    await makePlatformAdmin(staff);

    const list = await platform.get("/api/admin/organisations?status=pending");
    expect(list.body.some((o: any) => o.id === org.id)).toBe(true);
    const detail = await platform.get(`/api/admin/organisations/${org.id}`);
    // Only what the business sent at registration: no members, records, files or activity.
    expect(detail.body.members).toBeUndefined();
    expect(detail.body.counts).toBeUndefined();
    expect(detail.body.history).toBeUndefined();
    expect(detail.body.memberCount).toBe(1);
    expect(detail.body.lastActiveAt).toBeTruthy();
    expect((await platform.get(`/api/admin/organisations/${org.id}/files`)).status).toBe(404);
    expect(detail.body.creator.name).toBe("Amaka Okafor");
    expect(detail.body.review.history.some((h: any) => h.action === "org.verification_submitted")).toBe(true);

    const r = await platform.post(`/api/admin/organisations/${org.id}/verification`, { status: "verified" });
    expect(r.body.org.verificationStatus).toBe("verified");
    expect((await c.get("/api/org")).body.org.verificationStatus).toBe("verified");
    const notes = await c.get("/api/notifications");
    expect(JSON.stringify(notes.body)).toMatch(/is approved/);
    const audit = await c.get("/api/audit");
    expect(JSON.stringify(audit.body)).toMatch(/WindVeal approved the business/);

    expect((await platform.post(`/api/admin/organisations/${org.id}/plan`, { plan: "pro", billing: "yearly" })).body.org.plan).toBe("pro");
  });

  it("can't remove its own admin access", async () => {
    const app = await getApp();
    const { c, email } = await signUp(app);
    await makePlatformAdmin(email);
    const me = (await c.get("/api/auth/me")).body.user;
    expect(me.platformAdmin).toBe(true);
    expect((await c.post(`/api/admin/users/${me.id}/platform-admin`, { value: false })).status).toBe(400);
  });
});

describe("joining from an invitation without the link", () => {
  it("finds the invitation by email, confirms a code, then creates the account and joins", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);
    const email = `invitee-${Date.now()}@example.com`;
    await admin.post("/api/invitations", { invites: [{ email, role: "member" }] });
    const anon = new Client(app);
    // The answer doesn't reveal whether an invitation exists.
    expect((await anon.post("/api/invited/start", { email: "nobody-invited@example.com" })).body).toEqual({ ok: true });
    expect((await anon.post("/api/invited/start", { email })).body).toEqual({ ok: true });
    const code = recentMail(email).find((m) => m.code)!.code!;
    expect((await anon.post("/api/invited/verify", { email, code: "000000" })).status).toBe(400);
    const v = await anon.post("/api/invited/verify", { email, code });
    expect(v.body.orgName).toBe(org.name);
    const done = await anon.post("/api/invited/complete", { email, code, name: "Chidi Nwosu", password: PASSWORD });
    expect(done.status).toBe(200);
    expect(done.body.user.emailVerified).toBe(true);
    expect(done.body.org.id).toBe(org.id);
    expect(done.body.membership.role).toBe("member");
    // Signed in, and the code can't be used again.
    expect((await anon.get("/api/auth/me")).body.user.email).toBe(email);
    expect((await new Client(app).post("/api/invited/complete", { email, code, name: "Someone Else", password: PASSWORD })).status).toBe(400);
  });
});

describe("WindVeal admin: accounts", () => {
  it("suspends and reactivates an organisation; its people are locked out meanwhile", async () => {
    const app = await getApp();
    const { c, org } = await signUpWithOrg(app);
    const { c: platform, email: staff, org: staffOrg } = await signUpWithOrg(app, "WindVeal Accounts Org");
    await makePlatformAdmin(staff);
    expect((await platform.post(`/api/admin/organisations/${org.id}/account`, { status: "suspended" })).status).toBe(400);
    expect((await platform.post(`/api/admin/organisations/${staffOrg.id}/account`, { status: "suspended", reason: "x" })).status).toBe(400);
    const r = await platform.post(`/api/admin/organisations/${org.id}/account`, { status: "suspended", reason: "Payment overdue" });
    expect(r.body.org.accountStatus).toBe("suspended");
    expect((await c.get("/api/org")).status).toBe(403);
    expect((await c.get("/api/auth/me")).body.org.accountStatus).toBe("suspended");
    expect((await platform.get("/api/admin/organisations?status=suspended")).body.some((o: any) => o.id === org.id)).toBe(true);
    await platform.post(`/api/admin/organisations/${org.id}/account`, { status: "active" });
    expect((await c.get("/api/org")).status).toBe(200);
  });

  it("deactivates a person (signed out, can't sign in), shows their details, and reactivates them", async () => {
    const app = await getApp();
    const { c, email } = await signUpWithOrg(app);
    const { c: platform, email: staff } = await signUpWithOrg(app, "WindVeal People Org");
    await makePlatformAdmin(staff);
    const me = (await c.get("/api/auth/me")).body.user;
    const detail = await platform.get(`/api/admin/users/${me.id}`);
    expect(detail.body.user.email).toBe(email);
    expect(detail.body.membership.role).toBe("admin");
    expect(detail.body.activeSessions).toBeGreaterThan(0);
    expect((await platform.post(`/api/admin/users/${me.id}/account`, { active: false, reason: "Reported misuse" })).status).toBe(200);
    expect((await c.get("/api/auth/me")).body.user).toBeNull();
    const login = await new Client(app).post("/api/auth/login", { email, password: PASSWORD });
    expect(login.status).toBe(403);
    await platform.post(`/api/admin/users/${me.id}/account`, { active: true });
    expect((await new Client(app).post("/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
    expect((await platform.post(`/api/admin/users/${me.id}/password-reset`)).status).toBe(200);
    expect(recentMail(email)[0]!.link).toMatch(/reset-password/);
    const platformMe = (await platform.get("/api/auth/me")).body.user;
    expect((await platform.post(`/api/admin/users/${platformMe.id}/account`, { active: false, reason: "x" })).status).toBe(400);
    expect((await platform.get("/api/admin/overview")).status).toBe(200);
  });
});
