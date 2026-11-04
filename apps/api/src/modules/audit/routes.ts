import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, ilike, isNull, lt, or, sql as dsql } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents, notifications, users } from "../../db/schema";
import { requireAdmin, requireOrg } from "../../lib/context";
import { KEPT_ACTIONS } from "../../lib/audit";
import { toCsv } from "../../lib/csv";

type AuditQuery = { q?: string; actor?: string; category?: string; days?: string; before?: string; format?: string };

export default async function auditRoutes(app: FastifyInstance) {
  /** Audit history: read-only. There are no update or delete endpoints by design. */
  app.get<{ Querystring: AuditQuery }>("/api/audit", async (req, reply) => {
    const ctx = await requireAdmin(req);
    const q = req.query;
    const since = new Date(Date.now() - Number(q.days ?? 30) * 86_400_000);
    // Older everyday entries (from before only important changes were kept) stay hidden.
    const conds = [eq(auditEvents.orgId, ctx.org.id), gte(auditEvents.createdAt, since), dsql`${auditEvents.action} ~ ${KEPT_ACTIONS}`];
    if (q.actor) conds.push(eq(auditEvents.actorUserId, q.actor));
    if (q.category) conds.push(eq(auditEvents.category, q.category));
    if (q.before) conds.push(lt(auditEvents.createdAt, new Date(q.before)));
    if (q.q) conds.push(or(ilike(auditEvents.summary, `%${q.q}%`), ilike(auditEvents.action, `%${q.q}%`))!);
    const rows = await db.select({ e: auditEvents, u: users }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(...conds)).orderBy(desc(auditEvents.createdAt)).limit(q.format === "csv" ? 5000 : 200);
    const items = rows.map(({ e, u }) => ({
      id: e.id, action: e.action, category: e.category, summary: e.summary, actor: u ? { id: u.id, name: u.name } : null,
      device: e.deviceLabel, entityType: e.entityType, entityId: e.entityId, meta: e.meta, createdAt: e.createdAt,
    }));
    if (q.format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", 'attachment; filename="audit-history.csv"');
      return toCsv(["Time", "Person", "Action", "What happened", "Device"],
        items.map((i) => [new Date(i.createdAt).toISOString(), i.actor?.name ?? "", i.action, i.summary, i.device ?? ""]));
    }
    return { items };
  });

  app.get("/api/notifications", async (req) => {
    const ctx = await requireOrg(req);
    const rows = await db.select().from(notifications).where(and(eq(notifications.userId, ctx.user.id), eq(notifications.orgId, ctx.org.id)))
      .orderBy(desc(notifications.createdAt)).limit(50);
    return { items: rows, unread: rows.filter((r) => !r.readAt).length };
  });

  app.post("/api/notifications/read-all", async (req) => {
    const ctx = await requireOrg(req);
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt)));
    return { ok: true };
  });
}
