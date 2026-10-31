import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  ACCESS_LEVELS, DEFAULT_ACCESS, DEFAULT_SPECIAL, type AccessLevel, type Role, type SpecialPermission, type Workspace, WORKSPACES,
} from "@windveal/shared";
import { db } from "../db/client";
import { devices, memberships, organisations, sessions, users } from "../db/schema";
import { sha256 } from "./crypto";
import { forbidden, unauthorized } from "./http";

export const SESSION_COOKIE = "wv_session";
export const DEVICE_COOKIE = "wv_device";

type User = typeof users.$inferSelect;
type Org = typeof organisations.$inferSelect;
type Membership = typeof memberships.$inferSelect;

export type AuthState = { user: User; sessionId: string; deviceId: string | null; deviceLabel: string | null };
export type OrgContext = {
  user: User;
  org: Org;
  membership: Membership;
  access: Record<Workspace, AccessLevel>;
  special: SpecialPermission[];
  deviceLabel: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthState | null;
    orgCtx?: OrgContext;
  }
}

/** onRequest hook: resolves the signed-in user from the session cookie (if any). */
export async function loadSession(req: FastifyRequest): Promise<void> {
  req.auth = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return;
  const [row] = await db
    .select({ s: sessions, u: users, d: devices })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return;
  if (row.d?.blockedAt || row.u.deactivatedAt) return;
  req.auth = { user: row.u, sessionId: row.s.id, deviceId: row.d?.id ?? null, deviceLabel: row.d?.label ?? null };
  // Touch last-seen at most once a minute.
  if (Date.now() - row.s.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.s.id));
    if (row.d) await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, row.d.id));
  }
}

export function requireUser(req: FastifyRequest, opts: { verified?: boolean } = { verified: true }): AuthState {
  if (!req.auth) throw unauthorized();
  if (opts.verified !== false && !req.auth.user.emailVerifiedAt) throw forbidden("Please verify your email first.");
  return req.auth;
}

export function computeAccess(org: Org, m: Membership): Record<Workspace, AccessLevel> {
  const role = m.role as Role;
  if (role === "admin") return { ...DEFAULT_ACCESS.admin };
  const base = { ...DEFAULT_ACCESS[role], ...(org.settings.roleAccess?.[role] ?? {}) };
  return Object.fromEntries(WORKSPACES.map((w) => [w, m.workspaceAccess?.[w] ?? base[w]])) as Record<Workspace, AccessLevel>;
}

export function computeSpecial(org: Org, m: Membership): SpecialPermission[] {
  const role = m.role as Role;
  if (role === "admin") return [...DEFAULT_SPECIAL.admin];
  const base = (org.settings.roleSpecial?.[role] as SpecialPermission[] | undefined) ?? DEFAULT_SPECIAL[role];
  return Array.from(new Set([...base, ...((m.specialPermissions ?? []) as SpecialPermission[])]));
}

/** Loads the user's active organisation and membership. Every org-scoped route starts here. */
export async function requireOrg(req: FastifyRequest): Promise<OrgContext> {
  if (req.orgCtx) return req.orgCtx;
  const auth = requireUser(req);
  const [row] = await db
    .select({ m: memberships, o: organisations })
    .from(memberships)
    .innerJoin(organisations, eq(organisations.id, memberships.orgId))
    .where(and(eq(memberships.userId, auth.user.id), isNull(memberships.deletedAt), isNull(organisations.deletedAt)))
    .limit(1);
  if (!row) throw forbidden("You're not part of an organisation yet.");
  if (row.m.status !== "active") throw forbidden("Your access to this organisation has been suspended.");
  if (row.o.accountStatus !== "active") {
    throw forbidden(row.o.accountStatus === "closed"
      ? "This organisation's WindVeal account is closed. Contact WindVeal support if you need it back."
      : "This organisation's WindVeal account is paused. Contact WindVeal support.");
  }
  req.orgCtx = {
    user: auth.user,
    org: row.o,
    membership: row.m,
    access: computeAccess(row.o, row.m),
    special: computeSpecial(row.o, row.m),
    deviceLabel: auth.deviceLabel,
  };
  return req.orgCtx;
}

/** Requires at least `level` access to a workspace. Returns the org context. */
export async function requireAccess(req: FastifyRequest, ws: Workspace, level: AccessLevel = "view"): Promise<OrgContext> {
  const ctx = await requireOrg(req);
  if (ACCESS_LEVELS.indexOf(ctx.access[ws]) < ACCESS_LEVELS.indexOf(level)) {
    throw forbidden(level === "view" ? "You don't have access to this workspace." : "You don't have permission to change this.");
  }
  return ctx;
}

export async function requireAdmin(req: FastifyRequest): Promise<OrgContext> {
  const ctx = await requireOrg(req);
  if (ctx.membership.role !== "admin") throw forbidden("Only admins can do that.");
  return ctx;
}

export function can(ctx: OrgContext, p: SpecialPermission): boolean {
  return ctx.special.includes(p);
}

export function requireSpecial(ctx: OrgContext, p: SpecialPermission): void {
  if (!can(ctx, p)) throw forbidden();
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number | null) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}),
  });
}
