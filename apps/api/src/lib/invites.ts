import { and, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/client";
import { invitations, memberships, organisations, roles, users } from "../db/schema";
import { randomToken, sha256 } from "./crypto";
import { sendMail } from "./mailer";
import { audit } from "./audit";
import { env } from "../env";
import type { OrgContext } from "./context";
import { ensureRoles, type RoleRow } from "./roles";

type Org = typeof organisations.$inferSelect;
export const INVITE_DAYS = 7;

export async function sendInvite(orgName: string, inviterName: string, email: string, role: string, token: string) {
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

/** Writes an invitation and emails it. */
export async function createInvitation(ctx: Pick<OrgContext, "org" | "user">, email: string, tier: "admin" | "manager" | "member", role: RoleRow | null) {
  const token = randomToken();
  await db.insert(invitations).values({
    orgId: ctx.org.id, email, role: tier, roleId: role?.id ?? null, tokenHash: sha256(token), invitedBy: ctx.user.id,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
  });
  await sendInvite(ctx.org.tradingName || ctx.org.legalName, ctx.user.name, email, role?.name ?? "Admin", token);
}

/**
 * The role for a job title: an existing role with the same name, or a new one that opens only My Workspace.
 * This is how Settings → Roles fills itself with the roles the company really has.
 */
export async function roleForJob(org: Org, jobTitle: string | null | undefined): Promise<RoleRow> {
  await ensureRoles(org);
  const title = jobTitle?.trim();
  if (!title) return memberRoleOf(org);
  return db.transaction(async (q) => {
    await q.execute(dsql`select pg_advisory_xact_lock(hashtext(${`${org.id}:roles`}))`);
    const [hit] = await q.select().from(roles).where(and(eq(roles.orgId, org.id), isNull(roles.deletedAt), dsql`lower(${roles.name}) = lower(${title})`)).limit(1);
    if (hit) return hit;
    const [r] = await q.insert(roles).values({ orgId: org.id, name: title, kind: "job", access: NO_ACCESS, special: [] }).returning();
    return r!;
  });
}

/** Opens nothing but My Workspace (everyone's own things). */
export const NO_ACCESS = { recruitment: "none", people: "none", crm: "none", workflows: "none", documents: "none", insights: "none" } as const;

/** Staff without a job title go on the plain "Staff" role (My Workspace only). */
async function memberRoleOf(org: Org): Promise<RoleRow> {
  return db.transaction(async (q) => {
    await q.execute(dsql`select pg_advisory_xact_lock(hashtext(${`${org.id}:roles`}))`);
    const [hit] = await q.select().from(roles).where(and(eq(roles.orgId, org.id), isNull(roles.deletedAt), dsql`lower(${roles.name}) = 'staff'`)).limit(1);
    if (hit) return hit;
    const [r] = await q.insert(roles).values({ orgId: org.id, name: "Staff", description: "Everyone without a job title yet", kind: "job", access: NO_ACCESS, special: [] }).returning();
    return r!;
  });
}

/**
 * Someone new on the team gets their access straight away: an invitation to WindVeal on their job title's
 * role (My Workspace only until an admin gives that role more). Skipped when they already have an account
 * here or anywhere else (one organisation per person), or an invitation is already waiting.
 */
export async function inviteNewStaff(ctx: Pick<OrgContext, "org" | "user">, person: { email?: string | null; jobTitle?: string | null; status?: string | null }) {
  const email = person.email?.trim().toLowerCase();
  if (!email || person.status === "left") return "skipped" as const;
  const [u] = await db.select({ id: users.id }).from(users).where(dsql`lower(${users.email}) = ${email}`).limit(1);
  if (u) {
    const [m] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, u.id), isNull(memberships.deletedAt))).limit(1);
    if (m) return "has_account" as const;
  }
  const [pending] = await db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.orgId, ctx.org.id), dsql`lower(${invitations.email}) = ${email}`,
    isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))).limit(1);
  if (pending) return "already_invited" as const;
  const role = await roleForJob(ctx.org, person.jobTitle);
  await createInvitation(ctx, email, role.kind === "manager" ? "manager" : "member", role);
  await audit(ctx as OrgContext, { action: "member.invited", category: "access", summary: `${ctx.user.name} added ${email} to the team, so WindVeal invited them as ${role.name}` });
  return "sent" as const;
}

/** Takes back invitations that haven't been used yet (e.g. when an import is undone). */
export async function cancelWaitingInvites(orgId: string, emails: string[]) {
  for (const email of emails) {
    await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.orgId, orgId), dsql`lower(${invitations.email}) = lower(${email})`,
      isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  }
}

/**
 * When someone's job title changes, their role follows it, as long as their role came from their job title
 * (an admin who chose Manager or a role of their own for them keeps that choice). A waiting invitation follows too.
 */
export async function followJobTitle(org: Org, person: { userId?: string | null; email?: string | null }, jobTitle: string | null | undefined) {
  const role = await roleForJob(org, jobTitle);
  const tier = role.kind === "manager" ? "manager" as const : "member" as const;
  const fromTitle = async (roleId: string | null) => {
    if (!roleId) return true;
    const [r] = await db.select({ kind: roles.kind }).from(roles).where(eq(roles.id, roleId)).limit(1);
    return !r || r.kind === "job";
  };
  if (person.userId) {
    const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, org.id), eq(memberships.userId, person.userId), isNull(memberships.deletedAt))).limit(1);
    if (m && m.role !== "admin" && await fromTitle(m.roleId)) await db.update(memberships).set({ roleId: role.id, role: tier, jobTitle: jobTitle ?? null }).where(eq(memberships.id, m.id));
  } else if (person.email) {
    const waiting = await db.select().from(invitations).where(and(eq(invitations.orgId, org.id), dsql`lower(${invitations.email}) = lower(${person.email})`,
      isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    for (const i of waiting) if (i.role !== "admin" && await fromTitle(i.roleId)) await db.update(invitations).set({ roleId: role.id, role: tier }).where(eq(invitations.id, i.id));
  }
}
