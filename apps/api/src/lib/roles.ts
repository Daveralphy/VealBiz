import { and, eq, isNull, sql as dsql } from "drizzle-orm";
import { DEFAULT_ACCESS, DEFAULT_SPECIAL, FREE_ROLES_WITH_ACCESS, opensMore, planAtLeast, type AccessLevel, type Workspace } from "@windveal/shared";
import { db } from "../db/client";
import { employees, invitations, memberships, organisations, roles } from "../db/schema";
import { AppError, notFound } from "./http";

type Org = typeof organisations.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
type Q = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Growth and up: any number of roles can open more than My Workspace. On Free, three can. */
export const canCustomiseRoles = (org: Org) => planAtLeast(org.plan, "growth");

/** How many roles open more than My Workspace, and how many may (null: no limit). */
export async function roleAllowance(org: Org, exceptId?: string) {
  const list = await db.select().from(roles).where(and(eq(roles.orgId, org.id), isNull(roles.deletedAt)));
  return { used: list.filter((r) => r.id !== exceptId && opensMore(r)).length, limit: canCustomiseRoles(org) ? null : FREE_ROLES_WITH_ACCESS };
}

/** Stops a role being given more than My Workspace when the plan's roles with access are all used. */
export async function checkRoleAllowance(org: Org, next: { access: Partial<Record<Workspace, AccessLevel>>; special: string[] }, exceptId?: string) {
  if (!opensMore(next)) return;
  const { used, limit } = await roleAllowance(org, exceptId);
  if (limit !== null && used >= limit) {
    throw new AppError(402, "plan_roles", `On the Free plan, ${limit} roles can open more than My Workspace, and they're all in use. Upgrade to Growth to give more roles access.`);
  }
}

/**
 * Every job title in People & HR is a role in Settings: a role is made for any title that doesn't have one yet,
 * opening only My Workspace until an admin gives it more.
 */
export async function syncJobRoles(org: Org): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(dsql`select pg_advisory_xact_lock(hashtext(${`${org.id}:roles`}))`);
    const titles = await q.selectDistinct({ t: dsql<string>`trim(${employees.jobTitle})` }).from(employees)
      .where(and(eq(employees.orgId, org.id), isNull(employees.deletedAt), dsql`coalesce(trim(${employees.jobTitle}), '') <> ''`, dsql`${employees.status} <> 'left'`));
    const have = new Set((await q.select({ n: roles.name }).from(roles).where(and(eq(roles.orgId, org.id), isNull(roles.deletedAt)))).map((r) => r.n.toLowerCase()));
    have.add("admin");
    const seen = new Set<string>();
    for (const { t } of titles) {
      const key = t.toLowerCase();
      if (have.has(key) || seen.has(key)) continue;
      seen.add(key);
      await q.insert(roles).values({ orgId: org.id, name: t, kind: "job", access: NO_ACCESS, special: [] });
    }
  });
}

const NO_ACCESS = { recruitment: "none", people: "none", crm: "none", workflows: "none", documents: "none", insights: "none" } as Record<Workspace, AccessLevel>;

/** The membership tier a role gives (used by older rules such as restricted folders). */
export const tierOf = (role: RoleRow) => (role.kind === "manager" ? "manager" : "member") as "manager" | "member";

/**
 * Makes sure the organisation has its roles and everyone is on one. Every organisation has Manager; people
 * who were on the old built-in Member role get a "Member" custom role with the same access, so nobody loses anything.
 */
export async function ensureRoles(org: Org): Promise<void> {
  // One request at a time per organisation, so two pages opening at once can't both create the roles.
  await db.transaction(async (q) => {
    await q.execute(dsql`select pg_advisory_xact_lock(hashtext(${org.id}))`);
    await setUpRoles(q, org);
  });
}

async function setUpRoles(q: Q, org: Org): Promise<void> {
  const existing = await q.select().from(roles).where(and(eq(roles.orgId, org.id), isNull(roles.deletedAt)));
  let manager = existing.find((r) => r.kind === "manager");
  if (!manager) {
    [manager] = await q.insert(roles).values({
      orgId: org.id, name: "Manager", description: "Runs a team's work", kind: "manager",
      access: { ...DEFAULT_ACCESS.manager, ...(org.settings.roleAccess?.manager ?? {}) } as Record<Workspace, AccessLevel>,
      special: org.settings.roleSpecial?.manager ?? DEFAULT_SPECIAL.manager,
    }).returning();
  }
  await q.update(memberships).set({ roleId: manager!.id })
    .where(and(eq(memberships.orgId, org.id), eq(memberships.role, "manager"), isNull(memberships.roleId)));
  await q.update(invitations).set({ roleId: manager!.id })
    .where(and(eq(invitations.orgId, org.id), eq(invitations.role, "manager"), isNull(invitations.roleId)));

  const [needsMember] = await q.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.orgId, org.id), eq(memberships.role, "member"), isNull(memberships.roleId))).limit(1);
  const [inviteNeedsMember] = await q.select({ id: invitations.id }).from(invitations)
    .where(and(eq(invitations.orgId, org.id), eq(invitations.role, "member"), isNull(invitations.roleId))).limit(1);
  if (needsMember || inviteNeedsMember) {
    const member = await memberRole(org, existing, q);
    await q.update(memberships).set({ roleId: member.id })
      .where(and(eq(memberships.orgId, org.id), eq(memberships.role, "member"), isNull(memberships.roleId)));
    await q.update(invitations).set({ roleId: member.id })
      .where(and(eq(invitations.orgId, org.id), eq(invitations.role, "member"), isNull(invitations.roleId)));
  }
}

/** The organisation's "Member" role, made from the old built-in one if it isn't there yet. */
async function memberRole(org: Org, existing?: RoleRow[], q: Q = db): Promise<RoleRow> {
  const list = existing ?? await q.select().from(roles).where(and(eq(roles.orgId, org.id), isNull(roles.deletedAt)));
  const found = list.find((r) => r.kind === "custom" && r.name.toLowerCase() === "member");
  if (found) return found;
  const [created] = await q.insert(roles).values({
    orgId: org.id, name: "Member", description: "Works in assigned workspaces", kind: "custom",
    access: { ...DEFAULT_ACCESS.member, ...(org.settings.roleAccess?.member ?? {}) } as Record<Workspace, AccessLevel>,
    special: org.settings.roleSpecial?.member ?? DEFAULT_SPECIAL.member,
  }).returning();
  return created!;
}

export async function loadRole(orgId: string, id: string | null | undefined): Promise<RoleRow | null> {
  if (!id) return null;
  const [r] = await db.select().from(roles).where(and(eq(roles.id, id), eq(roles.orgId, orgId), isNull(roles.deletedAt))).limit(1);
  return r ?? null;
}

/**
 * Works out which role someone is being given: "admin", a role id, or (older callers) a built-in name.
 */
export async function resolveRole(org: Org, pick: { roleId?: string; role?: "admin" | "manager" | "member" }): Promise<{ tier: "admin" | "manager" | "member"; role: RoleRow | null }> {
  if (pick.roleId === "admin" || (!pick.roleId && pick.role === "admin")) return { tier: "admin", role: null };
  await ensureRoles(org);
  let role: RoleRow | null = null;
  if (pick.roleId) {
    if (!/^[0-9a-f-]{36}$/i.test(pick.roleId)) throw notFound("That role");
    role = await loadRole(org.id, pick.roleId);
    if (!role) throw notFound("That role");
  } else if (pick.role === "manager") {
    [role] = await db.select().from(roles).where(and(eq(roles.orgId, org.id), eq(roles.kind, "manager"), isNull(roles.deletedAt))).limit(1);
  } else {
    role = await memberRole(org);
  }
  return { tier: tierOf(role!), role: role! };
}

/** Roles of many memberships at once. */
export async function rolesById(orgId: string): Promise<Map<string, RoleRow>> {
  const rows = await db.select().from(roles).where(and(eq(roles.orgId, orgId), isNull(roles.deletedAt)));
  return new Map(rows.map((r) => [r.id, r]));
}
