import type { FastifyInstance } from "fastify";
import { and, eq, isNull, ne, sql as dsql } from "drizzle-orm";
import { DEFAULT_ACCESS, roleInput, withMinimum, type AccessLevel, type Workspace } from "@windveal/shared";
import { db } from "../../db/client";
import { invitations, memberships, roles, users } from "../../db/schema";
import { requireAdmin, requireMemberManager } from "../../lib/context";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { canCustomiseRoles, ensureRoles, loadRole, type RoleRow } from "../../lib/roles";

const GROWTH = "Custom roles come with the Growth plan.";

function roleView(r: RoleRow, people: number, invited: number) {
  return { id: r.id, name: r.name, description: r.description, kind: r.kind, access: withMinimum({ ...DEFAULT_ACCESS.member, ...r.access }), special: r.special, people, invited, updatedAt: r.updatedAt };
}

async function nameTaken(orgId: string, name: string, except?: string) {
  const where = [eq(roles.orgId, orgId), isNull(roles.deletedAt), dsql`lower(${roles.name}) = lower(${name})`];
  if (except) where.push(ne(roles.id, except));
  const [hit] = await db.select({ id: roles.id }).from(roles).where(and(...where)).limit(1);
  return !!hit || name.trim().toLowerCase() === "admin";
}

/**
 * Settings → Roles. Admin is built in (everything, can't be changed). Manager is on every plan and can be
 * changed; custom roles come with Growth and up. Only admins manage roles.
 */
export default async function roleRoutes(app: FastifyInstance) {
  app.get("/api/roles", async (req) => {
    const ctx = await requireAdmin(req);
    await ensureRoles(ctx.org);
    const list = await db.select().from(roles).where(and(eq(roles.orgId, ctx.org.id), isNull(roles.deletedAt))).orderBy(roles.createdAt);
    const people = await db.select({ roleId: memberships.roleId, role: memberships.role, n: dsql<number>`count(*)::int` }).from(memberships)
      .where(and(eq(memberships.orgId, ctx.org.id), isNull(memberships.deletedAt))).groupBy(memberships.roleId, memberships.role);
    const invited = await db.select({ roleId: invitations.roleId, n: dsql<number>`count(*)::int` }).from(invitations)
      .where(and(eq(invitations.orgId, ctx.org.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt))).groupBy(invitations.roleId);
    const sorted = [...list.filter((r) => r.kind === "manager"), ...list.filter((r) => r.kind !== "manager").sort((a, b) => a.name.localeCompare(b.name))];
    return {
      canCustomise: canCustomiseRoles(ctx.org),
      admins: people.filter((p) => p.role === "admin").reduce((n, p) => n + p.n, 0),
      roles: sorted.map((r) => roleView(r, people.find((p) => p.roleId === r.id)?.n ?? 0, invited.find((p) => p.roleId === r.id)?.n ?? 0)),
    };
  });

  /** The roles someone can be given (for invitations and changing a role). On Free that's Admin and Manager. */
  app.get("/api/roles/options", async (req) => {
    const ctx = await requireMemberManager(req);
    await ensureRoles(ctx.org);
    const list = await db.select().from(roles).where(and(eq(roles.orgId, ctx.org.id), isNull(roles.deletedAt))).orderBy(roles.createdAt);
    const usable = list.filter((r) => r.kind === "manager" || canCustomiseRoles(ctx.org));
    return [
      ...(ctx.membership.role === "admin" ? [{ id: "admin", name: "Admin", description: "Everything, including settings and billing", access: null }] : []),
      ...[...usable.filter((r) => r.kind === "manager"), ...usable.filter((r) => r.kind !== "manager").sort((a, b) => a.name.localeCompare(b.name))]
        .map((r) => ({ id: r.id, name: r.name, description: r.description, access: { ...DEFAULT_ACCESS.member, ...r.access } })),
    ];
  });

  app.get<{ Params: { id: string } }>("/api/roles/:id", async (req) => {
    const ctx = await requireAdmin(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound("That role");
    const r = await loadRole(ctx.org.id, req.params.id);
    if (!r) throw notFound("That role");
    const people = await db.select({ id: memberships.id, name: users.name, email: users.email, avatarFileId: users.avatarFileId, jobTitle: memberships.jobTitle })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.roleId, r.id), isNull(memberships.deletedAt))).orderBy(users.name);
    const [inv] = await db.select({ n: dsql<number>`count(*)::int` }).from(invitations)
      .where(and(eq(invitations.roleId, r.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    return {
      role: roleView(r, people.length, inv?.n ?? 0), people,
      canEdit: r.kind === "manager" || canCustomiseRoles(ctx.org), canCustomise: canCustomiseRoles(ctx.org),
    };
  });

  app.post("/api/roles", async (req) => {
    const ctx = await requireAdmin(req);
    if (!canCustomiseRoles(ctx.org)) throw forbidden(GROWTH);
    const input = parse(roleInput, req.body);
    if (await nameTaken(ctx.org.id, input.name)) throw conflict("There's already a role with that name.", { name: "Already used" });
    const [r] = await db.insert(roles).values({
      orgId: ctx.org.id, name: input.name, description: input.description || null, kind: "custom",
      access: withMinimum({ ...DEFAULT_ACCESS.member, ...input.access } as Record<Workspace, AccessLevel>), special: input.special, createdBy: ctx.user.id,
    }).returning();
    await audit(ctx, { action: "role.created", category: "access", entityType: "role", entityId: r!.id, summary: `${ctx.user.name} created the ${r!.name} role`, meta: input });
    return { role: roleView(r!, 0, 0) };
  });

  app.patch<{ Params: { id: string } }>("/api/roles/:id", async (req) => {
    const ctx = await requireAdmin(req);
    const r = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await loadRole(ctx.org.id, req.params.id) : null;
    if (!r) throw notFound("That role");
    if (r.kind !== "manager" && !canCustomiseRoles(ctx.org)) throw forbidden(GROWTH);
    const input = parse(roleInput, req.body);
    if (r.kind === "manager" && input.name.trim().toLowerCase() !== "manager") throw badRequest("The Manager role keeps its name.", { name: "Can't be renamed" });
    if (await nameTaken(ctx.org.id, input.name, r.id)) throw conflict("There's already a role with that name.", { name: "Already used" });
    const [u] = await db.update(roles).set({
      name: input.name, description: input.description || null, access: withMinimum({ ...DEFAULT_ACCESS.member, ...input.access } as Record<Workspace, AccessLevel>),
      special: input.special, version: dsql`${roles.version} + 1`,
    }).where(eq(roles.id, r.id)).returning();
    await audit(ctx, { action: "role.updated", category: "access", entityType: "role", entityId: r.id, summary: `${ctx.user.name} changed what the ${u!.name} role can do`, meta: input });
    return { role: roleView(u!, 0, 0) };
  });

  app.post<{ Params: { id: string } }>("/api/roles/:id/duplicate", async (req) => {
    const ctx = await requireAdmin(req);
    if (!canCustomiseRoles(ctx.org)) throw forbidden(GROWTH);
    const r = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await loadRole(ctx.org.id, req.params.id) : null;
    if (!r) throw notFound("That role");
    let name = `${r.name} copy`;
    for (let i = 2; await nameTaken(ctx.org.id, name); i++) name = `${r.name} copy ${i}`;
    const [c] = await db.insert(roles).values({ orgId: ctx.org.id, name, description: r.description, kind: "custom", access: r.access, special: r.special, createdBy: ctx.user.id }).returning();
    await audit(ctx, { action: "role.created", category: "access", entityType: "role", entityId: c!.id, summary: `${ctx.user.name} copied the ${r.name} role as ${name}` });
    return { role: roleView(c!, 0, 0) };
  });

  app.delete<{ Params: { id: string } }>("/api/roles/:id", async (req) => {
    const ctx = await requireAdmin(req);
    const r = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await loadRole(ctx.org.id, req.params.id) : null;
    if (!r) throw notFound("That role");
    if (r.kind === "manager") throw forbidden("The Manager role can't be deleted.");
    const [inUse] = await db.select({ n: dsql<number>`count(*)::int` }).from(memberships)
      .where(and(eq(memberships.roleId, r.id), isNull(memberships.deletedAt)));
    const [waiting] = await db.select({ n: dsql<number>`count(*)::int` }).from(invitations)
      .where(and(eq(invitations.roleId, r.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    if ((inUse?.n ?? 0) > 0) throw conflict(`${inUse!.n} ${inUse!.n === 1 ? "person has" : "people have"} this role. Give them another role first.`);
    if ((waiting?.n ?? 0) > 0) throw conflict("Someone has been invited with this role. Cancel or resend that invitation with another role first.");
    await db.update(roles).set({ deletedAt: new Date() }).where(eq(roles.id, r.id));
    await audit(ctx, { action: "role.deleted", category: "access", entityType: "role", entityId: r.id, summary: `${ctx.user.name} deleted the ${r.name} role` });
    return { ok: true };
  });
}
