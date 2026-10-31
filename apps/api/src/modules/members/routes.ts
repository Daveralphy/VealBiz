import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import {
  ACCESS_LEVELS, DEFAULT_ACCESS, DEFAULT_SPECIAL, SPECIAL_PERMISSIONS, WORKSPACES, invitedCompleteInput, invitedStartInput, invitedVerifyInput,
  inviteInput, memberUpdateInput,
} from "@windveal/shared";
import { db } from "../../db/client";
import { invitations, memberships, organisations, sessions, users } from "../../db/schema";
import { computeAccess, requireAdmin, requireOrg, requireUser } from "../../lib/context";
import { hashPassword, randomToken, sha256, sixDigitCode } from "../../lib/crypto";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit, notify } from "../../lib/audit";
import { sendMail } from "../../lib/mailer";
import { env } from "../../env";
import { mePayload, startSession } from "../auth/routes";

const CLAIM_LIMIT = { config: { rateLimit: { max: env.isTest ? 10_000 : 10, timeWindow: "1 minute" } } };

/** The newest invitation still waiting for this email address. */
async function waitingInvitation(email: string) {
  const [row] = await db.select({ i: invitations, o: organisations, by: users }).from(invitations)
    .innerJoin(organisations, eq(organisations.id, invitations.orgId)).innerJoin(users, eq(users.id, invitations.invitedBy))
    .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt)).limit(1);
  return row ?? null;
}

/** Checks the emailed code for an invitation. Wrong codes count towards a limit. */
async function checkClaimCode(email: string, code: string) {
  const row = await waitingInvitation(email);
  const inv = row?.i;
  if (!inv || !inv.claimCodeHash || !inv.claimExpiresAt || inv.claimExpiresAt < new Date()) {
    throw badRequest("That code has expired. Ask for a new one.", { code: "Code expired" });
  }
  if (inv.claimAttempts >= 5) throw badRequest("Too many attempts. Ask for a new code.", { code: "Too many attempts" });
  if (inv.claimCodeHash !== sha256(code)) {
    await db.update(invitations).set({ claimAttempts: inv.claimAttempts + 1 }).where(eq(invitations.id, inv.id));
    throw badRequest("That code isn't right.", { code: "That code isn't right" });
  }
  return row!;
}

const INVITE_DAYS = 7;

async function activeAdminCount(orgId: string) {
  const [r] = await db.select({ n: dsql<number>`count(*)::int` }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin"), eq(memberships.status, "active"), isNull(memberships.deletedAt)));
  return r?.n ?? 0;
}

async function sendInvite(orgName: string, inviterName: string, email: string, role: string, token: string) {
  const link = `${env.appUrl}/invite/${token}`;
  await sendMail({
    to: email, subject: `${inviterName} invited you to ${orgName} on WindVeal`, link,
    text: [
      `${inviterName} invited you to join ${orgName} on WindVeal as ${role}.`,
      `1. Get the WindVeal app: ${env.siteUrl}/download`,
      `2. Accept your invitation (expires in ${INVITE_DAYS} days): ${link}`,
      `Sign up or sign in with this email address (${email}).`,
    ].join("\n"),
  });
}

export default async function memberRoutes(app: FastifyInstance) {
  app.get("/api/members", async (req) => {
    const ctx = await requireOrg(req);
    const rows = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, ctx.org.id), isNull(memberships.deletedAt))).orderBy(users.name);
    return rows.map(({ m, u }) => ({
      id: m.id, userId: u.id, name: u.name, email: u.email, role: m.role, status: m.status, isPrimaryAdmin: m.isPrimaryAdmin,
      isOwner: m.isOwner, jobTitle: m.jobTitle, access: computeAccess(ctx.org, m), workspaceAccess: m.workspaceAccess,
      lastActiveAt: u.lastLoginAt, isYou: u.id === ctx.user.id,
    }));
  });

  app.patch<{ Params: { id: string } }>("/api/members/:id", async (req) => {
    const ctx = await requireAdmin(req);
    const input = parse(memberUpdateInput, req.body);
    const [target] = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, req.params.id), eq(memberships.orgId, ctx.org.id), isNull(memberships.deletedAt))).limit(1);
    if (!target) throw notFound("That member");
    if (target.m.isPrimaryAdmin && (input.role && input.role !== "admin" || input.status === "suspended")) {
      throw forbidden("The primary admin can't be demoted or suspended. Transfer primary admin first.");
    }
    const losingAdmin = target.m.role === "admin" && ((input.role && input.role !== "admin") || input.status === "suspended");
    if (losingAdmin && (await activeAdminCount(ctx.org.id)) <= 1) throw forbidden("You can't remove the last admin.");
    const [m] = await db.update(memberships).set({
      role: input.role ?? target.m.role, status: input.status ?? target.m.status,
      workspaceAccess: input.workspaceAccess ?? target.m.workspaceAccess, version: dsql`${memberships.version} + 1`,
    }).where(eq(memberships.id, target.m.id)).returning();
    if (input.status === "suspended") {
      await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, target.u.id), isNull(sessions.revokedAt)));
    }
    const changes: string[] = [];
    if (input.role && input.role !== target.m.role) changes.push(`role from ${target.m.role} to ${input.role}`);
    if (input.status && input.status !== target.m.status) changes.push(input.status === "suspended" ? "suspended access" : "restored access");
    if (input.workspaceAccess) changes.push("workspace access");
    await audit(ctx, {
      action: "member.updated", category: "access", entityType: "membership", entityId: m!.id,
      summary: `${ctx.user.name} changed ${target.u.name}'s ${changes.join(", ") || "settings"}`, meta: { ...input },
    });
    return { ok: true };
  });

  /** Remove from organisation: ends membership and signs them out everywhere. */
  app.delete<{ Params: { id: string } }>("/api/members/:id", async (req) => {
    const ctx = await requireAdmin(req);
    const [target] = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, req.params.id), eq(memberships.orgId, ctx.org.id), isNull(memberships.deletedAt))).limit(1);
    if (!target) throw notFound("That member");
    if (target.m.isPrimaryAdmin) throw forbidden("The primary admin can't be removed. Transfer primary admin first.");
    if (target.m.role === "admin" && (await activeAdminCount(ctx.org.id)) <= 1) throw forbidden("You can't remove the last admin.");
    await db.transaction(async (tx) => {
      // Hard-delete the membership row so the person can join another organisation later (one-org rule).
      await tx.delete(memberships).where(eq(memberships.id, target.m.id));
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, target.u.id), isNull(sessions.revokedAt)));
      await audit(ctx, { action: "member.removed", category: "access", summary: `${ctx.user.name} removed ${target.u.name} from the organisation` }, tx);
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/members/:id/password-reset", async (req) => {
    const ctx = await requireAdmin(req);
    const [target] = await db.select({ u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, req.params.id), eq(memberships.orgId, ctx.org.id))).limit(1);
    if (!target) throw notFound("That member");
    await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: target.u.email } });
    return { ok: true };
  });

  // ---------------- invitations ----------------
  app.get("/api/invitations", async (req) => {
    const ctx = await requireOrg(req);
    const rows = await db.select({ i: invitations, by: users }).from(invitations).innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.orgId, ctx.org.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .orderBy(desc(invitations.createdAt));
    return rows.map(({ i, by }) => ({ id: i.id, email: i.email, role: i.role, invitedBy: by.name, expiresAt: i.expiresAt, expired: i.expiresAt < new Date(), createdAt: i.createdAt }));
  });

  app.post("/api/invitations", async (req) => {
    const ctx = await requireAdmin(req);
    const { invites } = parse(inviteInput, req.body);
    const results: { email: string; status: "sent" | "already_member" | "already_invited" }[] = [];
    for (const inv of invites) {
      const [u] = await db.select().from(users).where(eq(users.email, inv.email)).limit(1);
      if (u) {
        const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, u.id), isNull(memberships.deletedAt))).limit(1);
        if (m) { results.push({ email: inv.email, status: "already_member" }); continue; }
      }
      const [pending] = await db.select().from(invitations).where(and(eq(invitations.orgId, ctx.org.id), eq(invitations.email, inv.email),
        isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))).limit(1);
      if (pending) { results.push({ email: inv.email, status: "already_invited" }); continue; }
      const token = randomToken();
      await db.insert(invitations).values({
        orgId: ctx.org.id, email: inv.email, role: inv.role, tokenHash: sha256(token), invitedBy: ctx.user.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      });
      await sendInvite(ctx.org.tradingName || ctx.org.legalName, ctx.user.name, inv.email, inv.role, token);
      await audit(ctx, { action: "member.invited", category: "access", summary: `${ctx.user.name} invited ${inv.email} as ${inv.role}` });
      results.push({ email: inv.email, status: "sent" });
    }
    return { results };
  });

  app.post<{ Params: { id: string } }>("/api/invitations/:id/resend", async (req) => {
    const ctx = await requireAdmin(req);
    const [inv] = await db.select().from(invitations).where(and(eq(invitations.id, req.params.id), eq(invitations.orgId, ctx.org.id))).limit(1);
    if (!inv || inv.acceptedAt || inv.revokedAt) throw notFound("That invitation");
    const token = randomToken();
    await db.update(invitations).set({ tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) }).where(eq(invitations.id, inv.id));
    await sendInvite(ctx.org.tradingName || ctx.org.legalName, ctx.user.name, inv.email, inv.role, token);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/invitations/:id", async (req) => {
    const ctx = await requireAdmin(req);
    await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, req.params.id), eq(invitations.orgId, ctx.org.id)));
    await audit(ctx, { action: "member.invite_cancelled", category: "access", summary: `${ctx.user.name} cancelled an invitation` });
    return { ok: true };
  });

  /** Public preview of an invitation (used by the accept page before sign-in). */
  app.get<{ Params: { token: string } }>("/api/invite/:token", async (req) => {
    const [row] = await db.select({ i: invitations, o: organisations, by: users }).from(invitations)
      .innerJoin(organisations, eq(organisations.id, invitations.orgId)).innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(eq(invitations.tokenHash, sha256(req.params.token))).limit(1);
    if (!row || row.i.revokedAt) throw notFound("This invitation");
    const existing = (await db.select({ id: users.id }).from(users).where(eq(users.email, row.i.email)).limit(1))[0];
    return {
      orgName: row.o.tradingName || row.o.legalName, email: row.i.email, role: row.i.role, invitedBy: row.by.name,
      expired: row.i.expiresAt < new Date(), accepted: !!row.i.acceptedAt, hasAccount: !!existing,
    };
  });

  // ---------------- "I was invited" (without the email link) ----------------
  /** Step 1: email. A code goes to the address if an invitation is waiting. The answer is the same either way. */
  app.post("/api/invited/start", CLAIM_LIMIT, async (req) => {
    const { email } = parse(invitedStartInput, req.body);
    const row = await waitingInvitation(email);
    if (row) {
      const orgName = row.o.tradingName || row.o.legalName;
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing) {
        await sendMail({
          to: email, subject: `Your invitation to ${orgName}`, link: `${env.appUrl}/sign-in`,
          text: `You already have a WindVeal account with this email. Sign in and your invitation to ${orgName} will be waiting: ${env.appUrl}/sign-in`,
        });
      } else {
        const code = sixDigitCode();
        await db.update(invitations).set({ claimCodeHash: sha256(code), claimExpiresAt: new Date(Date.now() + 15 * 60_000), claimAttempts: 0 })
          .where(eq(invitations.id, row.i.id));
        await sendMail({
          to: email, subject: `Your code to join ${orgName} on WindVeal`, code,
          text: `${row.by.name} invited you to ${orgName}. Enter ${code} in WindVeal to set up your account. It expires in 15 minutes.`,
        });
      }
    }
    return { ok: true };
  });

  /** Step 2: the code. Shows who the invitation is from before the person sets a password. */
  app.post("/api/invited/verify", CLAIM_LIMIT, async (req) => {
    const { email, code } = parse(invitedVerifyInput, req.body);
    const row = await checkClaimCode(email, code);
    return { orgName: row.o.tradingName || row.o.legalName, role: row.i.role, invitedBy: row.by.name };
  });

  /** Step 3: name and password. Creates the (already verified) account, joins the organisation and signs in. */
  app.post("/api/invited/complete", CLAIM_LIMIT, async (req, reply) => {
    const input = parse(invitedCompleteInput, req.body);
    const row = await checkClaimCode(input.email, input.code);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (existing) throw conflict("You already have an account with this email. Sign in instead.");
    const inv = row.i;
    const user = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({
        email: input.email, name: input.name, passwordHash: await hashPassword(input.password), emailVerifiedAt: new Date(),
      }).returning();
      await tx.insert(memberships).values({ orgId: inv.orgId, userId: u!.id, role: inv.role });
      await tx.update(invitations).set({ acceptedAt: new Date(), claimCodeHash: null, claimExpiresAt: null }).where(eq(invitations.id, inv.id));
      await audit({ org: row.o, user: u!, deviceLabel: null }, {
        action: "member.joined", category: "access", summary: `${u!.name} accepted the invitation and joined as ${inv.role}`,
      }, tx);
      await notify(inv.orgId, inv.invitedBy, `${u!.name} joined ${row.o.tradingName || row.o.legalName}`, undefined, "/settings", tx);
      return u!;
    });
    await startSession(req, reply, user.id, false);
    return mePayload(user.id);
  });

  app.post<{ Params: { token: string } }>("/api/invite/:token/accept", async (req) => {
    const auth = requireUser(req);
    const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, sha256(req.params.token))).limit(1);
    if (!inv || inv.revokedAt) throw notFound("This invitation");
    if (inv.acceptedAt) throw conflict("This invitation has already been used.");
    if (inv.expiresAt < new Date()) throw badRequest("This invitation has expired. Ask your admin to send a new one.");
    if (inv.email !== auth.user.email) throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
    const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, auth.user.id), isNull(memberships.deletedAt))).limit(1);
    if (m) throw conflict("You already belong to an organisation. You can only be in one organisation at a time.");
    const [org] = await db.select().from(organisations).where(eq(organisations.id, inv.orgId)).limit(1);
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ orgId: inv.orgId, userId: auth.user.id, role: inv.role });
      await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
      await audit({ org: org!, user: auth.user, deviceLabel: auth.deviceLabel }, {
        action: "member.joined", category: "access", summary: `${auth.user.name} accepted the invitation and joined as ${inv.role}`,
      }, tx);
      await notify(inv.orgId, inv.invitedBy, `${auth.user.name} joined ${org!.tradingName || org!.legalName}`, undefined, "/settings/members", tx);
    });
    return mePayload(auth.user.id);
  });

  // ---------------- roles ----------------
  app.get("/api/roles", async (req) => {
    const ctx = await requireOrg(req);
    const counts = await db.select({ role: memberships.role, n: dsql<number>`count(*)::int` }).from(memberships)
      .where(and(eq(memberships.orgId, ctx.org.id), isNull(memberships.deletedAt))).groupBy(memberships.role);
    const n = (r: string) => counts.find((c) => c.role === r)?.n ?? 0;
    return {
      roles: (["admin", "manager", "member"] as const).map((r) => ({
        key: r, count: n(r),
        access: r === "admin" ? DEFAULT_ACCESS.admin : { ...DEFAULT_ACCESS[r], ...(ctx.org.settings.roleAccess?.[r] ?? {}) },
        special: r === "admin" ? DEFAULT_SPECIAL.admin : (ctx.org.settings.roleSpecial?.[r] ?? DEFAULT_SPECIAL[r]),
        editable: r !== "admin",
      })),
      customRolesAvailable: ctx.org.plan !== "free",
    };
  });

  app.put<{ Params: { role: "manager" | "member" } }>("/api/roles/:role", async (req) => {
    const ctx = await requireAdmin(req);
    if (!["manager", "member"].includes(req.params.role)) throw badRequest("Only the Manager and Member roles can be edited.");
    const input = parse(z.object({
      access: z.record(z.enum(WORKSPACES), z.enum(ACCESS_LEVELS)),
      special: z.array(z.enum(SPECIAL_PERMISSIONS)),
    }), req.body);
    const settings = {
      ...ctx.org.settings,
      roleAccess: { ...(ctx.org.settings.roleAccess ?? {}), [req.params.role]: input.access },
      roleSpecial: { ...(ctx.org.settings.roleSpecial ?? {}), [req.params.role]: input.special },
    };
    await db.update(organisations).set({ settings }).where(eq(organisations.id, ctx.org.id));
    await audit(ctx, { action: "role.updated", category: "access", summary: `${ctx.user.name} changed what the ${req.params.role} role can do`, meta: input });
    return { ok: true };
  });

  app.get("/api/members/assignable", async (req) => {
    const ctx = await requireOrg(req);
    const rows = await db.select({ id: users.id, name: users.name, role: memberships.role }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.status, "active"), isNull(memberships.deletedAt)))
      .orderBy(users.name);
    return rows;
  });
}
