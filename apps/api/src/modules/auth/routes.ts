import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import {
  emailChangeInput, forgotPasswordInput, loginInput, passwordChangeInput, passwordCodeInput, profileInput, registerInput,
  resetPasswordInput, verifyEmailInput,
} from "@windveal/shared";
import { db } from "../../db/client";
import { authTokens, devices, employees, files, invitations, memberships, organisations, sessions, users } from "../../db/schema";
import { DEVICE_COOKIE, SESSION_COOKIE, computeAccess, computeSpecial, requireOrg, requireUser, setSessionCookie } from "../../lib/context";
import { hashPassword, randomToken, sha256, sixDigitCode, verifyPassword } from "../../lib/crypto";
import { AppError, badRequest, conflict, parse } from "../../lib/http";
import { sendMail } from "../../lib/mailer";
import { env } from "../../env";
import { audit } from "../../lib/audit";

const DAY = 86_400_000;
// Generous limit under automated tests (many sign-ups from one address), strict otherwise.
const AUTH_LIMIT = { config: { rateLimit: { max: env.authRateLimit, timeWindow: "1 minute" } } };

function deviceLabelFrom(ua: string | undefined): string {
  const s = ua ?? "";
  const os = /Windows/.test(s) ? "Windows" : /Mac OS/.test(s) ? "Mac" : /Android/.test(s) ? "Android" : /iPhone|iPad/.test(s) ? "iPhone" : /Linux/.test(s) ? "Linux" : "Unknown";
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

/** Creates a session (and registers the device). Returns whether the device is new for this user. */
export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, remember: boolean) {
  let deviceId = req.cookies?.[DEVICE_COOKIE];
  let isNewDevice = false;
  let device = deviceId
    ? (await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, userId))).limit(1))[0]
    : undefined;
  if (device?.blockedAt) throw new AppError(403, "device_blocked", "This device has been blocked by your organisation.");
  if (!device) {
    isNewDevice = true;
    [device] = await db.insert(devices).values({
      userId, label: deviceLabelFrom(req.headers["user-agent"]), userAgent: req.headers["user-agent"] ?? null, ip: req.ip,
    }).returning();
    deviceId = device!.id;
    reply.setCookie(DEVICE_COOKIE, deviceId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 * 5 });
  }
  const token = randomToken();
  const ttl = remember ? 30 * DAY : 1 * DAY;
  await db.insert(sessions).values({ userId, deviceId: device!.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttl) });
  setSessionCookie(reply, token, remember ? ttl / 1000 : null);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { isNewDevice, device: device! };
}

async function sendVerificationCode(user: { id: string; email: string; name: string }) {
  const code = sixDigitCode();
  await db.update(authTokens).set({ usedAt: new Date() })
    .where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, "verify_email"), isNull(authTokens.usedAt)));
  await db.insert(authTokens).values({ userId: user.id, purpose: "verify_email", tokenHash: sha256(code), expiresAt: new Date(Date.now() + 15 * 60_000) });
  await sendMail({ to: user.email, subject: "Your WindVeal verification code", text: `Hi ${user.name}, your code is ${code}. It expires in 15 minutes.`, code });
}

/** Checks the latest unused emailed code for a purpose; marks it used when it matches. */
async function checkCode(userId: string, purpose: "change_email" | "change_password", code: string) {
  const [tok] = await db.select().from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)))
    .orderBy(desc(authTokens.createdAt)).limit(1);
  if (!tok || tok.expiresAt < new Date()) throw badRequest("That code has expired. Ask for a new one.", { code: "Code expired" });
  if (tok.attempts >= 5) throw badRequest("Too many attempts. Ask for a new code.", { code: "Too many attempts" });
  if (tok.tokenHash !== sha256(code)) {
    await db.update(authTokens).set({ attempts: tok.attempts + 1 }).where(eq(authTokens.id, tok.id));
    throw badRequest("That code isn't right.", { code: "That code isn't right" });
  }
  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, tok.id));
  return tok;
}

/** Everything the app needs to know about the signed-in person. */
export async function mePayload(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return null;
  const [row] = await db.select({ m: memberships, o: organisations }).from(memberships)
    .innerJoin(organisations, eq(organisations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), isNull(memberships.deletedAt))).limit(1);
  const [invite] = row ? [] : await db.select({ i: invitations, o: organisations }).from(invitations)
    .innerJoin(organisations, eq(organisations.id, invitations.orgId))
    .where(and(eq(invitations.email, u.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt)).limit(1);
  return {
    user: {
      id: u.id, name: u.name, email: u.email, emailVerified: !!u.emailVerifiedAt, phone: u.phone, avatarFileId: u.avatarFileId,
      platformAdmin: u.platformAdmin, createdAt: u.createdAt,
    },
    org: row ? {
      id: row.o.id, name: row.o.tradingName || row.o.legalName, legalName: row.o.legalName, slug: row.o.slug,
      country: row.o.country, currency: row.o.currency, plan: row.o.plan, verificationStatus: row.o.verificationStatus,
      brandColor: row.o.brandColor, logoFileId: row.o.logoFileId, setupStep: row.o.setupStep,
    } : null,
    membership: row ? {
      id: row.m.id, role: row.m.role, status: row.m.status, isPrimaryAdmin: row.m.isPrimaryAdmin, jobTitle: row.m.jobTitle,
      access: computeAccess(row.o, row.m), special: computeSpecial(row.o, row.m),
    } : null,
    pendingInvitation: invite ? { orgName: invite.o.tradingName || invite.o.legalName, role: invite.i.role } : null,
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/register", AUTH_LIMIT, async (req, reply) => {
    const input = parse(registerInput, req.body);
    const existing = (await db.select().from(users).where(eq(users.email, input.email)).limit(1))[0];
    if (existing) throw conflict("An account with this email already exists. Try signing in.", { email: "This email is already registered" });
    const [user] = await db.insert(users).values({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password) }).returning();
    await sendVerificationCode(user!);
    await startSession(req, reply, user!.id, false);
    return mePayload(user!.id);
  });

  app.post("/api/auth/verify-email", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req, { verified: false });
    const { code } = parse(verifyEmailInput, req.body);
    const [tok] = await db.select().from(authTokens)
      .where(and(eq(authTokens.userId, auth.user.id), eq(authTokens.purpose, "verify_email"), isNull(authTokens.usedAt)))
      .orderBy(desc(authTokens.createdAt)).limit(1);
    if (!tok || tok.expiresAt < new Date()) throw badRequest("That code has expired. Send a new one.", { code: "Code expired" });
    if (tok.attempts >= 5) throw badRequest("Too many attempts. Send a new code.", { code: "Too many attempts" });
    if (tok.tokenHash !== sha256(code)) {
      await db.update(authTokens).set({ attempts: tok.attempts + 1 }).where(eq(authTokens.id, tok.id));
      throw badRequest("That code isn't right.", { code: "That code isn't right" });
    }
    await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, tok.id));
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, auth.user.id));
    return mePayload(auth.user.id);
  });

  app.post("/api/auth/resend-code", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req, { verified: false });
    if (auth.user.emailVerifiedAt) return { ok: true };
    await sendVerificationCode(auth.user);
    return { ok: true };
  });

  app.post("/api/auth/change-email", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req, { verified: false });
    if (auth.user.emailVerifiedAt) throw badRequest("Your email is already verified.");
    const { email } = parse(forgotPasswordInput, req.body);
    const taken = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (taken && taken.id !== auth.user.id) throw conflict("That email is already in use.", { email: "Already in use" });
    const [u] = await db.update(users).set({ email }).where(eq(users.id, auth.user.id)).returning();
    await sendVerificationCode(u!);
    return mePayload(u!.id);
  });

  app.post("/api/auth/login", AUTH_LIMIT, async (req, reply) => {
    const input = parse(loginInput, req.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    // Same message whether the email or the password is wrong.
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
    }
    const { isNewDevice, device } = await startSession(req, reply, user.id, !!input.remember);
    const me = await mePayload(user.id);
    if (isNewDevice && me?.org) {
      const [o] = await db.select().from(organisations).where(eq(organisations.id, me.org.id)).limit(1);
      await audit({ org: o!, user, deviceLabel: device.label }, {
        action: "auth.new_device", category: "access", summary: `${user.name} signed in from a new device`, meta: { device: device.label },
      });
    }
    return me;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.auth) await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, req.auth.sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/logout-all", async (req, reply) => {
    const auth = requireUser(req, { verified: false });
    await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, auth.user.id), isNull(sessions.revokedAt)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/forgot-password", AUTH_LIMIT, async (req) => {
    const { email } = parse(forgotPasswordInput, req.body);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user) {
      const token = randomToken();
      await db.insert(authTokens).values({ userId: user.id, purpose: "reset_password", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) });
      const link = `${env.appUrl}/reset-password?token=${token}`;
      await sendMail({ to: user.email, subject: "Reset your WindVeal password", text: `Use this link within 1 hour: ${link}`, link });
    }
    // Always the same answer, so this can't be used to find out who has an account.
    return { ok: true };
  });

  app.post("/api/auth/reset-password", AUTH_LIMIT, async (req) => {
    const input = parse(resetPasswordInput, req.body);
    const [tok] = await db.select().from(authTokens)
      .where(and(eq(authTokens.tokenHash, sha256(input.token)), eq(authTokens.purpose, "reset_password"))).limit(1);
    if (!tok || tok.usedAt || tok.expiresAt < new Date()) {
      throw badRequest("This reset link has expired or was already used. Ask for a new one.");
    }
    await db.transaction(async (tx) => {
      // This link and any other unused reset links for the account stop working.
      await tx.update(authTokens).set({ usedAt: new Date() })
        .where(and(eq(authTokens.userId, tok.userId), eq(authTokens.purpose, "reset_password"), isNull(authTokens.usedAt)));
      await tx.update(users).set({ passwordHash: await hashPassword(input.password), emailVerifiedAt: new Date() }).where(eq(users.id, tok.userId));
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, tok.userId), isNull(sessions.revokedAt)));
    });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    if (!req.auth) return { user: null };
    return mePayload(req.auth.user.id);
  });

  /** Personal details (Profile → Personal). */
  app.patch("/api/auth/profile", async (req) => {
    const auth = requireUser(req);
    const input = parse(profileInput, req.body);
    if (input.avatarFileId) {
      const [f] = await db.select().from(files).where(and(eq(files.id, input.avatarFileId), eq(files.uploadedBy, auth.user.id), isNull(files.deletedAt))).limit(1);
      if (!f || !f.mime.startsWith("image/")) throw badRequest("Upload a photo (PNG, JPG or WebP).");
      // Profile photos are shown wherever the person appears, like the organisation logo.
      await db.update(files).set({ isPublic: true }).where(eq(files.id, f.id));
    }
    const phone = input.phone || null;
    const jobTitle = input.jobTitle || null;
    await db.update(users).set({
      name: input.name, phone, ...(input.avatarFileId !== undefined ? { avatarFileId: input.avatarFileId } : {}),
    }).where(eq(users.id, auth.user.id));
    const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, auth.user.id), isNull(memberships.deletedAt))).limit(1);
    if (m) {
      await db.update(memberships).set({ jobTitle }).where(eq(memberships.id, m.id));
      // Keep their employee record (People & HR) in step with what they entered.
      await db.update(employees).set({ phone, jobTitle })
        .where(and(eq(employees.orgId, m.orgId), eq(employees.userId, auth.user.id), isNull(employees.deletedAt)));
    }
    return mePayload(auth.user.id);
  });

  /** Email change, step 1: confirm the password, then a code goes to the NEW address. */
  app.post("/api/auth/email-change/request", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req);
    const input = parse(emailChangeInput, req.body);
    if (!(await verifyPassword(auth.user.passwordHash, input.currentPassword))) {
      throw badRequest("Your password isn't right.", { currentPassword: "Incorrect password" });
    }
    if (input.newEmail === auth.user.email) throw badRequest("That's already your email.", { newEmail: "Same as your current email" });
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.newEmail)).limit(1);
    if (taken) throw conflict("That email is already in use.", { newEmail: "Already in use" });
    const code = sixDigitCode();
    await db.update(authTokens).set({ usedAt: new Date() })
      .where(and(eq(authTokens.userId, auth.user.id), eq(authTokens.purpose, "change_email"), isNull(authTokens.usedAt)));
    await db.insert(authTokens).values({
      userId: auth.user.id, purpose: "change_email", tokenHash: sha256(code), payload: input.newEmail, expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await sendMail({ to: input.newEmail, subject: "Confirm your new WindVeal email", text: `Hi ${auth.user.name}, enter ${code} to make this your WindVeal email. It expires in 15 minutes.`, code });
    return { ok: true, sentTo: input.newEmail };
  });

  /** Email change, step 2: the code from the new address switches the email and tells the old one. */
  app.post("/api/auth/email-change/confirm", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req);
    const { code } = parse(verifyEmailInput, req.body);
    const tok = await checkCode(auth.user.id, "change_email", code);
    const newEmail = tok.payload!;
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).limit(1);
    if (taken) throw conflict("That email is already in use.");
    const oldEmail = auth.user.email;
    await db.update(users).set({ email: newEmail, emailVerifiedAt: new Date() }).where(eq(users.id, auth.user.id));
    await sendMail({
      to: oldEmail, subject: "Your WindVeal email was changed",
      text: `Hi ${auth.user.name}, your WindVeal sign-in email was changed to ${newEmail}. If you didn't do this, contact support straight away.`,
    });
    const ctx = await requireOrg(req).catch(() => null);
    if (ctx) await audit(ctx, { action: "auth.email_changed", category: "access", summary: `${auth.user.name} changed their sign-in email`, meta: { from: oldEmail, to: newEmail } });
    return mePayload(auth.user.id);
  });

  /** Password change, step 1: confirm the current password, then a code goes to their email. */
  app.post("/api/auth/change-password/request", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req);
    const input = parse(passwordCodeInput, req.body);
    if (!(await verifyPassword(auth.user.passwordHash, input.currentPassword))) {
      throw badRequest("Your current password isn't right.", { currentPassword: "Incorrect password" });
    }
    const code = sixDigitCode();
    await db.update(authTokens).set({ usedAt: new Date() })
      .where(and(eq(authTokens.userId, auth.user.id), eq(authTokens.purpose, "change_password"), isNull(authTokens.usedAt)));
    await db.insert(authTokens).values({ userId: auth.user.id, purpose: "change_password", tokenHash: sha256(code), expiresAt: new Date(Date.now() + 15 * 60_000) });
    await sendMail({
      to: auth.user.email, subject: "Confirm your WindVeal password change",
      text: `Hi ${auth.user.name}, enter ${code} to change your password. It expires in 15 minutes. If you didn't ask for this, change your password now.`, code,
    });
    return { ok: true, sentTo: auth.user.email };
  });

  /** Password change, step 2: the emailed code plus the new password. Other sessions are signed out. */
  app.post("/api/auth/change-password", AUTH_LIMIT, async (req) => {
    const auth = requireUser(req);
    const input = parse(passwordChangeInput, req.body);
    await checkCode(auth.user.id, "change_password", input.code);
    await db.update(users).set({ passwordHash: await hashPassword(input.password) }).where(eq(users.id, auth.user.id));
    await db.update(sessions).set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, auth.user.id), isNull(sessions.revokedAt), dsql`${sessions.id} <> ${auth.sessionId}`));
    await sendMail({ to: auth.user.email, subject: "Your WindVeal password was changed", text: `Hi ${auth.user.name}, your password was changed and your other devices were signed out.` });
    return { ok: true };
  });

  app.get("/api/auth/devices", async (req) => {
    const auth = requireUser(req);
    const rows = await db.select().from(devices).where(eq(devices.userId, auth.user.id)).orderBy(desc(devices.lastSeenAt));
    return rows.map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, current: d.id === auth.deviceId, blocked: !!d.blockedAt }));
  });
}
