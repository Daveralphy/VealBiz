import type { FastifyInstance } from "fastify";
import { and, desc, eq, getTableColumns, gt, ilike, inArray, isNotNull, isNull, or, sql as dsql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { PLANS } from "@windveal/shared";
import { db } from "../../db/client";
import {
  applications, auditEvents, authTokens, companies, deals, devices, employees, files, folders, invitations, jobs, leads, memberships, organisations, sessions, tasks, users,
} from "../../db/schema";
import { requirePlatformAdmin } from "../../lib/platform";
import { badRequest, notFound, parse } from "../../lib/http";
import { audit, notify } from "../../lib/audit";
import { sendMail } from "../../lib/mailer";
import { readObject } from "../../lib/storage";
import { randomToken, sha256 } from "../../lib/crypto";
import { env } from "../../env";
import { orgView } from "../org/routes";
import { fileView, storageUsed } from "../files/routes";

/** Live (not deleted) rows of an org-scoped table. */
async function countFor(table: PgTable, orgId: string): Promise<number> {
  const cols = getTableColumns(table) as Record<string, any>;
  const where: SQL[] = [eq(cols.orgId, orgId)];
  if (cols.deletedAt) where.push(isNull(cols.deletedAt));
  const [r] = await db.select({ n: dsql<number>`count(*)::int` }).from(table).where(and(...where));
  return r?.n ?? 0;
}

async function loadOrg(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That organisation");
  const [o] = await db.select().from(organisations).where(eq(organisations.id, id)).limit(1);
  if (!o) throw notFound("That organisation");
  return o;
}

/**
 * The WindVeal admin panel: WindVeal staff review every organisation that signs up, open everything
 * it sent in, and approve or reject it. Every decision is written to that organisation's audit history.
 */
export default async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/summary", async (req) => {
    requirePlatformAdmin(req);
    const byStatus = await db.select({ status: organisations.verificationStatus, n: dsql<number>`count(*)::int` })
      .from(organisations).where(isNull(organisations.deletedAt)).groupBy(organisations.verificationStatus);
    const [u] = await db.select({ n: dsql<number>`count(*)::int` }).from(users);
    const [recent] = await db.select({ n: dsql<number>`count(*)::int` }).from(organisations)
      .where(and(isNull(organisations.deletedAt), dsql`${organisations.createdAt} > now() - interval '7 days'`));
    const count = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;
    const byAccount = await db.select({ status: organisations.accountStatus, n: dsql<number>`count(*)::int` })
      .from(organisations).where(isNull(organisations.deletedAt)).groupBy(organisations.accountStatus);
    const [off] = await db.select({ n: dsql<number>`count(*)::int` }).from(users).where(isNotNull(users.deactivatedAt));
    return {
      pending: count("pending"), verified: count("verified"), rejected: count("rejected"), users: u?.n ?? 0, newThisWeek: recent?.n ?? 0,
      suspended: byAccount.find((r) => r.status === "suspended")?.n ?? 0, closed: byAccount.find((r) => r.status === "closed")?.n ?? 0,
      deactivatedUsers: off?.n ?? 0,
    };
  });

  app.get<{ Querystring: { status?: string; q?: string } }>("/api/admin/organisations", async (req) => {
    requirePlatformAdmin(req);
    const where: SQL[] = [isNull(organisations.deletedAt)];
    const status = req.query.status;
    if (status === "pending" || status === "verified" || status === "rejected") where.push(eq(organisations.verificationStatus, status));
    if (status === "suspended" || status === "closed") where.push(eq(organisations.accountStatus, status));
    const q = req.query.q?.trim();
    if (q) {
      const like = `%${q}%`;
      where.push(or(ilike(organisations.legalName, like), ilike(organisations.tradingName, like), ilike(organisations.registrationNumber, like), ilike(users.email, like), ilike(users.name, like))!);
    }
    const rows = await db.select({ o: organisations, creator: { name: users.name, email: users.email } })
      .from(organisations).innerJoin(users, eq(users.id, organisations.createdBy))
      .where(and(...where)).orderBy(desc(organisations.createdAt)).limit(500);
    const ids = rows.map((r) => r.o.id);
    const memberCounts = ids.length ? await db.select({ orgId: memberships.orgId, n: dsql<number>`count(*)::int` }).from(memberships)
      .where(and(inArray(memberships.orgId, ids), isNull(memberships.deletedAt))).groupBy(memberships.orgId) : [];
    return rows.map((r) => ({
      id: r.o.id, name: r.o.tradingName || r.o.legalName, legalName: r.o.legalName, slug: r.o.slug, country: r.o.country, industry: r.o.industry,
      registrationNumber: r.o.registrationNumber, verificationStatus: r.o.verificationStatus, accountStatus: r.o.accountStatus, plan: r.o.plan, setupStep: r.o.setupStep,
      logoFileId: r.o.logoFileId, documents: r.o.verificationDocumentIds.length, createdAt: r.o.createdAt, creator: r.creator,
      members: memberCounts.find((m) => m.orgId === r.o.id)?.n ?? 0,
    }));
  });

  /** Everything an organisation sent in: details, people, documents, branding, activity. */
  app.get<{ Params: { id: string } }>("/api/admin/organisations/:id", async (req) => {
    requirePlatformAdmin(req);
    const o = await loadOrg(req.params.id);
    const [creator] = await db.select().from(users).where(eq(users.id, o.createdBy)).limit(1);
    const reviewer = o.verificationReviewedBy
      ? (await db.select({ name: users.name }).from(users).where(eq(users.id, o.verificationReviewedBy)).limit(1))[0] : null;
    const members = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, o.id), isNull(memberships.deletedAt))).orderBy(memberships.createdAt);
    const invites = await db.select().from(invitations)
      .where(and(eq(invitations.orgId, o.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt))).orderBy(desc(invitations.createdAt));
    const docIds = o.verificationDocumentIds;
    const docs = docIds.length ? await db.select().from(files).where(inArray(files.id, docIds)) : [];
    const history = await db.select({ e: auditEvents, actor: users.name }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(eq(auditEvents.orgId, o.id)).orderBy(desc(auditEvents.createdAt)).limit(100);
    const [nEmployees, nJobs, nApplications, nCompanies, nLeads, nDeals, nTasks, nFiles] = await Promise.all(
      [employees, jobs, applications, companies, leads, deals, tasks, files].map((t) => countFor(t, o.id)),
    );
    return {
      org: orgView(o),
      creator: creator && { id: creator.id, name: creator.name, email: creator.email, phone: creator.phone, emailVerified: !!creator.emailVerifiedAt, createdAt: creator.createdAt, lastLoginAt: creator.lastLoginAt },
      reviewer,
      members: members.map(({ m, u }) => ({
        id: m.id, userId: u.id, name: u.name, email: u.email, phone: u.phone, avatarFileId: u.avatarFileId, role: m.role, status: m.status,
        jobTitle: m.jobTitle, isOwner: m.isOwner, isPrimaryAdmin: m.isPrimaryAdmin, joinedAt: m.createdAt, lastLoginAt: u.lastLoginAt,
      })),
      invitations: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt })),
      documents: docs.map(fileView),
      counts: { employees: nEmployees, jobs: nJobs, applications: nApplications, companies: nCompanies, leads: nLeads, deals: nDeals, tasks: nTasks, files: nFiles },
      storageUsed: await storageUsed(o.id),
      history: history.map(({ e, actor }) => ({ id: e.id, action: e.action, summary: e.summary, category: e.category, actor, device: e.deviceLabel, createdAt: e.createdAt })),
    };
  });

  /** Every file the organisation has stored (Documents library, attachments, CVs, branding). */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/admin/organisations/:id/files", async (req) => {
    requirePlatformAdmin(req);
    const o = await loadOrg(req.params.id);
    const where: SQL[] = [eq(files.orgId, o.id), isNull(files.deletedAt)];
    if (req.query.q?.trim()) where.push(ilike(files.name, `%${req.query.q.trim()}%`));
    const rows = await db.select({ f: files, uploader: users.name, folder: folders.name }).from(files)
      .leftJoin(users, eq(users.id, files.uploadedBy)).leftJoin(folders, eq(folders.id, files.folderId))
      .where(and(...where)).orderBy(desc(files.createdAt)).limit(500);
    return rows.map(({ f, uploader, folder }) => ({ ...fileView(f), uploader, folder }));
  });

  /** Opens (or downloads) any stored file. */
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/admin/files/:id/content", async (req, reply) => {
    requirePlatformAdmin(req);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That file");
    const [f] = await db.select().from(files).where(and(eq(files.id, req.params.id), isNull(files.deletedAt))).limit(1);
    if (!f) throw notFound("That file");
    reply.header("Content-Type", f.mime || "application/octet-stream");
    reply.header("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${encodeURIComponent(f.name)}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(readObject(f.storageKey));
  });

  /** Approve or reject an organisation (or send it back to review). The organisation's admins are told. */
  app.post<{ Params: { id: string } }>("/api/admin/organisations/:id/verification", async (req) => {
    const auth = requirePlatformAdmin(req);
    const o = await loadOrg(req.params.id);
    const input = parse(z.object({
      status: z.enum(["verified", "rejected", "pending"]),
      note: z.string().trim().max(1000).optional().or(z.literal("")),
    }).refine((v) => v.status !== "rejected" || !!v.note, { message: "Tell them why so they can fix it", path: ["note"] }), req.body);
    const [updated] = await db.update(organisations).set({
      verificationStatus: input.status, verificationNote: input.note || null,
      verificationReviewedAt: new Date(), verificationReviewedBy: auth.user.id,
    }).where(eq(organisations.id, o.id)).returning();
    const label = input.status === "verified" ? "approved" : input.status === "rejected" ? "not approved" : "sent back for review";
    await audit({ org: updated!, user: auth.user, deviceLabel: auth.deviceLabel }, {
      action: `org.verification_${input.status}`, category: "settings", entityType: "organisation", entityId: o.id,
      summary: `WindVeal ${label} the verification (${auth.user.name})`, meta: { note: input.note || null },
    });
    if (input.status !== "pending") {
      const admins = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, o.id), eq(memberships.role, "admin"), isNull(memberships.deletedAt)));
      const title = input.status === "verified" ? `${updated!.legalName} is verified` : `${updated!.legalName} couldn't be verified yet`;
      const body = input.status === "verified"
        ? "Your business is verified. Your careers page is now live."
        : `We couldn't verify your business yet: ${input.note}. Update your details or send a document from Profile → Company.`;
      for (const { u } of admins) {
        await notify(o.id, u.id, title, body, "/profile/company");
        await sendMail({ to: u.email, subject: title, text: `Hi ${u.name}, ${body}`, link: `${env.appUrl}/profile/company` });
      }
    }
    return { org: orgView(updated!) };
  });

  /** Set an organisation's plan directly (e.g. an Enterprise agreement or a paid invoice). */
  app.post<{ Params: { id: string } }>("/api/admin/organisations/:id/plan", async (req) => {
    const auth = requirePlatformAdmin(req);
    const o = await loadOrg(req.params.id);
    const input = parse(z.object({ plan: z.enum(PLANS), billing: z.enum(["monthly", "yearly"]) }), req.body);
    const [updated] = await db.update(organisations).set({ plan: input.plan, billing: input.billing }).where(eq(organisations.id, o.id)).returning();
    await audit({ org: updated!, user: auth.user, deviceLabel: auth.deviceLabel }, {
      action: "org.plan_changed", category: "settings", summary: `WindVeal changed the plan to ${input.plan} (${input.billing}) (${auth.user.name})`,
    });
    return { org: orgView(updated!) };
  });

  app.get<{ Querystring: { q?: string } }>("/api/admin/users", async (req) => {
    requirePlatformAdmin(req);
    const q = req.query.q?.trim();
    const rows = await db.select({ u: users, m: memberships, o: { id: organisations.id, name: organisations.legalName } }).from(users)
      .leftJoin(memberships, and(eq(memberships.userId, users.id), isNull(memberships.deletedAt)))
      .leftJoin(organisations, eq(organisations.id, memberships.orgId))
      .where(q ? or(ilike(users.name, `%${q}%`), ilike(users.email, `%${q}%`)) : undefined)
      .orderBy(desc(users.createdAt)).limit(500);
    return rows.map(({ u, m, o }) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, avatarFileId: u.avatarFileId, emailVerified: !!u.emailVerifiedAt,
      platformAdmin: u.platformAdmin, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, deactivated: !!u.deactivatedAt,
      org: o?.id ? { id: o.id, name: o.name, role: m?.role ?? null } : null,
    }));
  });

  /** What needs attention: organisations waiting for review (oldest first) and the newest sign-ups. */
  app.get("/api/admin/overview", async (req) => {
    requirePlatformAdmin(req);
    const waiting = await db.select({ o: organisations, creator: { name: users.name, email: users.email } })
      .from(organisations).innerJoin(users, eq(users.id, organisations.createdBy))
      .where(and(isNull(organisations.deletedAt), eq(organisations.verificationStatus, "pending"), eq(organisations.accountStatus, "active")))
      .orderBy(organisations.createdAt).limit(5);
    const newest = await db.select({ u: users, org: organisations.legalName, orgId: organisations.id }).from(users)
      .leftJoin(memberships, and(eq(memberships.userId, users.id), isNull(memberships.deletedAt)))
      .leftJoin(organisations, eq(organisations.id, memberships.orgId))
      .orderBy(desc(users.createdAt)).limit(5);
    const paused = await db.select().from(organisations)
      .where(and(isNull(organisations.deletedAt), dsql`${organisations.accountStatus} <> 'active'`)).orderBy(desc(organisations.accountStatusAt)).limit(5);
    return {
      waiting: waiting.map(({ o, creator }) => ({
        id: o.id, name: o.tradingName || o.legalName, legalName: o.legalName, country: o.country, logoFileId: o.logoFileId,
        documents: o.verificationDocumentIds.length, setupStep: o.setupStep, createdAt: o.createdAt, creator,
      })),
      newUsers: newest.map(({ u, org, orgId }) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, emailVerified: !!u.emailVerifiedAt, org: org ? { id: orgId, name: org } : null })),
      paused: paused.map((o) => ({ id: o.id, name: o.tradingName || o.legalName, accountStatus: o.accountStatus, reason: o.accountStatusReason, at: o.accountStatusAt })),
    };
  });

  /** Suspend, close or reactivate an organisation's account. Its admins are told; its data is kept. */
  app.post<{ Params: { id: string } }>("/api/admin/organisations/:id/account", async (req) => {
    const auth = requirePlatformAdmin(req);
    const o = await loadOrg(req.params.id);
    const input = parse(z.object({
      status: z.enum(["active", "suspended", "closed"]),
      reason: z.string().trim().max(500).optional().or(z.literal("")),
    }).refine((v) => v.status === "active" || !!v.reason, { message: "Say why, so their admins know", path: ["reason"] }), req.body);
    const [mine] = await db.select({ orgId: memberships.orgId }).from(memberships).where(and(eq(memberships.userId, auth.user.id), isNull(memberships.deletedAt))).limit(1);
    if (mine?.orgId === o.id && input.status !== "active") throw badRequest("You can't suspend or close your own organisation.");
    const [updated] = await db.update(organisations).set({
      accountStatus: input.status, accountStatusReason: input.status === "active" ? null : input.reason || null, accountStatusAt: new Date(),
    }).where(eq(organisations.id, o.id)).returning();
    const verb = { active: "reactivated", suspended: "suspended", closed: "closed" }[input.status];
    await audit({ org: updated!, user: auth.user, deviceLabel: auth.deviceLabel }, {
      action: `org.account_${verb}`, category: "access", entityType: "organisation", entityId: o.id,
      summary: `WindVeal ${verb} this organisation's account (${auth.user.name})`, meta: { reason: input.reason || null },
    });
    const admins = await db.select({ u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, o.id), eq(memberships.role, "admin"), isNull(memberships.deletedAt)));
    const name = updated!.tradingName || updated!.legalName;
    const text = input.status === "active"
      ? `${name}'s WindVeal account is active again. Your team can sign in as usual.`
      : `${name}'s WindVeal account has been ${verb}${input.reason ? `: ${input.reason}` : ""}. Your data is kept. Reply to this email or contact WindVeal support to sort it out.`;
    for (const { u } of admins) await sendMail({ to: u.email, subject: `Your WindVeal account was ${verb}`, text: `Hi ${u.name}, ${text}` });
    return { org: orgView(updated!) };
  });

  async function loadUser(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("That person");
    const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw notFound("That person");
    return u;
  }

  /** Everything about one person: account, organisation and role, devices, sessions and recent activity. */
  app.get<{ Params: { id: string } }>("/api/admin/users/:id", async (req) => {
    requirePlatformAdmin(req);
    const u = await loadUser(req.params.id);
    const [m] = await db.select({ m: memberships, o: organisations }).from(memberships).innerJoin(organisations, eq(organisations.id, memberships.orgId))
      .where(and(eq(memberships.userId, u.id), isNull(memberships.deletedAt))).limit(1);
    const devs = await db.select().from(devices).where(eq(devices.userId, u.id)).orderBy(desc(devices.lastSeenAt));
    const live = await db.select({ n: dsql<number>`count(*)::int` }).from(sessions)
      .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
    const activity = await db.select().from(auditEvents).where(eq(auditEvents.actorUserId, u.id)).orderBy(desc(auditEvents.createdAt)).limit(30);
    return {
      user: {
        id: u.id, name: u.name, email: u.email, phone: u.phone, avatarFileId: u.avatarFileId, emailVerified: !!u.emailVerifiedAt,
        platformAdmin: u.platformAdmin, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
        deactivatedAt: u.deactivatedAt, deactivatedReason: u.deactivatedReason,
      },
      membership: m ? {
        orgId: m.o.id, orgName: m.o.tradingName || m.o.legalName, role: m.m.role, status: m.m.status, jobTitle: m.m.jobTitle,
        isOwner: m.m.isOwner, isPrimaryAdmin: m.m.isPrimaryAdmin, joinedAt: m.m.createdAt, orgAccountStatus: m.o.accountStatus,
      } : null,
      devices: devs.map((d) => ({ id: d.id, label: d.label, ip: d.ip, firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, blocked: !!d.blockedAt })),
      activeSessions: live[0]?.n ?? 0,
      activity: activity.map((e) => ({ id: e.id, summary: e.summary, action: e.action, device: e.deviceLabel, createdAt: e.createdAt })),
    };
  });

  /** Records a WindVeal action on a person in their organisation's audit history (if they have one). */
  async function auditUser(auth: ReturnType<typeof requirePlatformAdmin>, u: typeof users.$inferSelect, action: string, summary: string) {
    const [m] = await db.select({ o: organisations }).from(memberships).innerJoin(organisations, eq(organisations.id, memberships.orgId))
      .where(and(eq(memberships.userId, u.id), isNull(memberships.deletedAt))).limit(1);
    if (m) await audit({ org: m.o, user: auth.user, deviceLabel: auth.deviceLabel }, { action, category: "access", entityType: "user", entityId: u.id, summary });
  }

  /** Deactivate (can't sign in; signed out everywhere) or reactivate a person's account. */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/account", async (req) => {
    const auth = requirePlatformAdmin(req);
    const u = await loadUser(req.params.id);
    const input = parse(z.object({ active: z.boolean(), reason: z.string().trim().max(500).optional().or(z.literal("")) })
      .refine((v) => v.active || !!v.reason, { message: "Say why", path: ["reason"] }), req.body);
    if (u.id === auth.user.id) throw badRequest("You can't deactivate your own account.");
    await db.update(users).set({ deactivatedAt: input.active ? null : new Date(), deactivatedReason: input.active ? null : input.reason || null }).where(eq(users.id, u.id));
    if (!input.active) await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
    await auditUser(auth, u, input.active ? "user.reactivated" : "user.deactivated",
      `WindVeal ${input.active ? "reactivated" : "deactivated"} ${u.name}'s account (${auth.user.name})`);
    await sendMail({
      to: u.email, subject: input.active ? "Your WindVeal account is active again" : "Your WindVeal account was deactivated",
      text: input.active ? `Hi ${u.name}, your WindVeal account is active again. You can sign in as usual.`
        : `Hi ${u.name}, your WindVeal account was deactivated${input.reason ? `: ${input.reason}` : ""}. Contact WindVeal support if you think this is a mistake.`,
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/sign-out", async (req) => {
    const auth = requirePlatformAdmin(req);
    const u = await loadUser(req.params.id);
    await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
    await auditUser(auth, u, "user.signed_out_everywhere", `WindVeal signed ${u.name} out on every device (${auth.user.name})`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/password-reset", async (req) => {
    const auth = requirePlatformAdmin(req);
    const u = await loadUser(req.params.id);
    const token = randomToken();
    await db.insert(authTokens).values({ userId: u.id, purpose: "reset_password", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) });
    const link = `${env.appUrl}/reset-password?token=${token}`;
    await sendMail({ to: u.email, subject: "Reset your WindVeal password", text: `WindVeal support sent you a link to set a new password. Use it within 1 hour: ${link}`, link });
    await auditUser(auth, u, "user.password_reset_sent", `WindVeal sent ${u.name} a password reset link (${auth.user.name})`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/verify-email", async (req) => {
    const auth = requirePlatformAdmin(req);
    const u = await loadUser(req.params.id);
    if (u.emailVerifiedAt) return { ok: true };
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, u.id));
    await auditUser(auth, u, "user.email_verified", `WindVeal marked ${u.name}'s email as verified (${auth.user.name})`);
    return { ok: true };
  });

  /** Give or remove WindVeal admin access. You can't remove your own. */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/platform-admin", async (req) => {
    const auth = requirePlatformAdmin(req);
    const { value } = parse(z.object({ value: z.boolean() }), req.body);
    if (req.params.id === auth.user.id && !value) throw badRequest("You can't remove your own WindVeal admin access.");
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That person");
    const [u] = await db.update(users).set({ platformAdmin: value }).where(eq(users.id, req.params.id)).returning();
    if (!u) throw notFound("That person");
    return { id: u.id, platformAdmin: u.platformAdmin };
  });
}
