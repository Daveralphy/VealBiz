import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, ne, sql as dsql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { hasAccess } from "@windveal/shared";
import { db, type Tx } from "../../db/client";
import {
  approvalRules, approvalSteps, approvals, employees, fileLinks, files, memberships, taskComments, taskItems, taskTemplates, tasks, users,
} from "../../db/schema";
import { requireAccess, requireAdmin, requireOrg, type OrgContext } from "../../lib/context";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit, notify } from "../../lib/audit";
import { createTask, startChecklist } from "../../lib/tasks";
import { approvalHandler, createApproval } from "../../lib/approvals";
import { LINK_TYPES, resolveTarget, searchTargets } from "../documents/targets";

const DAY = 86_400_000;
const P = "/api/workflows";

type Task = typeof tasks.$inferSelect;
type Approval = typeof approvals.$inferSelect;

const WORKSPACE_VALUES = ["recruitment", "people", "crm", "workflows", "documents"] as const;
const uuid = z.string().uuid("Choose a valid option.");

// ---------------- helpers ----------------

async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (!list.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function isActiveMember(orgId: string, userId: string, tx: Tx = db): Promise<boolean> {
  const [m] = await tx.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId), eq(memberships.status, "active"), isNull(memberships.deletedAt))).limit(1);
  return !!m;
}

function canSeeTask(ctx: OrgContext, t: Task) {
  return hasAccess(ctx.access.workflows, "view") || t.assigneeUserId === ctx.user.id || t.createdBy === ctx.user.id;
}
function canEditTask(ctx: OrgContext, t: Task) {
  return hasAccess(ctx.access.workflows, "edit") || t.assigneeUserId === ctx.user.id || t.createdBy === ctx.user.id;
}

async function loadTask(ctx: OrgContext, id: string, opts: { edit?: boolean } = {}): Promise<Task> {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That task");
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.orgId, ctx.org.id), isNull(tasks.deletedAt))).limit(1);
  if (!t || !canSeeTask(ctx, t)) throw notFound("That task");
  if (opts.edit && !canEditTask(ctx, t)) throw forbidden("You can't change this task.");
  return t;
}

/** Adds names and comment / file / checklist counts to a set of tasks. */
async function taskViews(rows: Task[]) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const [comments, links, items, names] = await Promise.all([
    db.select({ id: taskComments.taskId, n: dsql<number>`count(*)::int` }).from(taskComments)
      .where(and(inArray(taskComments.taskId, ids), isNull(taskComments.deletedAt))).groupBy(taskComments.taskId),
    db.select({ id: fileLinks.linkId, n: dsql<number>`count(*)::int` }).from(fileLinks).innerJoin(files, eq(files.id, fileLinks.fileId))
      .where(and(eq(fileLinks.linkType, "task"), inArray(fileLinks.linkId, ids), isNull(files.deletedAt))).groupBy(fileLinks.linkId),
    db.select({ id: taskItems.taskId, n: dsql<number>`count(*)::int`, done: dsql<number>`count(*) filter (where ${taskItems.done})::int` })
      .from(taskItems).where(and(inArray(taskItems.taskId, ids), isNull(taskItems.deletedAt))).groupBy(taskItems.taskId),
    userNames(rows.flatMap((t) => [t.assigneeUserId, t.createdBy])),
  ]);
  const cm = new Map(comments.map((c) => [c.id, c.n]));
  const fm = new Map(links.map((c) => [c.id, c.n]));
  const im = new Map(items.map((c) => [c.id, c]));
  return rows.map((t) => taskView(t, names, { comments: cm.get(t.id) ?? 0, files: fm.get(t.id) ?? 0, items: im.get(t.id)?.n ?? 0, itemsDone: im.get(t.id)?.done ?? 0 }));
}

function taskView(t: Task, names: Map<string, string>, counts: { comments: number; files: number; items: number; itemsDone: number }) {
  return {
    id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, dueAt: t.dueAt,
    workspace: t.workspace, linkType: t.linkType, linkId: t.linkId, linkLabel: t.linkLabel, repeatRule: t.repeatRule,
    checklistId: t.checklistId, checklistGroup: t.checklistGroup, completedAt: t.completedAt,
    assignee: t.assigneeUserId ? { id: t.assigneeUserId, name: names.get(t.assigneeUserId) ?? "Unknown" } : null,
    createdBy: t.createdBy ? { id: t.createdBy, name: names.get(t.createdBy) ?? "Unknown" } : null,
    createdAt: t.createdAt, updatedAt: t.updatedAt, version: t.version, counts,
  };
}

function nextDue(from: Date, rule: string): Date {
  const d = new Date(from);
  if (rule === "weekly") return new Date(d.getTime() + 7 * DAY);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Marks a task done. Repeating tasks get their next occurrence created. */
async function completeTask(ctx: OrgContext, t: Task) {
  return db.transaction(async (tx) => {
    const [done] = await tx.update(tasks).set({
      status: "done", completedAt: new Date(), completedBy: ctx.user.id, version: dsql`${tasks.version} + 1`,
    }).where(eq(tasks.id, t.id)).returning();
    let next: Task | null = null;
    if (t.repeatRule && t.status !== "done") {
      next = await createTask({
        orgId: ctx.org.id, title: t.title, description: t.description, workspace: t.workspace as "workflows",
        assigneeUserId: t.assigneeUserId, createdBy: t.createdBy ?? ctx.user.id, dueAt: nextDue(t.dueAt ?? new Date(), t.repeatRule),
        priority: t.priority, linkType: t.linkType, linkId: t.linkId, linkLabel: t.linkLabel,
      }, tx);
      [next] = await tx.update(tasks).set({ repeatRule: t.repeatRule }).where(eq(tasks.id, next!.id)).returning();
      const items = await tx.select().from(taskItems).where(and(eq(taskItems.taskId, t.id), isNull(taskItems.deletedAt))).orderBy(asc(taskItems.position));
      if (items.length) {
        await tx.insert(taskItems).values(items.map((i) => ({ orgId: ctx.org.id, taskId: next!.id, label: i.label, position: i.position })));
      }
    }
    await audit(ctx, { action: "task.completed", category: "data", entityType: "task", entityId: t.id, summary: `${ctx.user.name} completed "${t.title}"` }, tx);
    if (t.createdBy && t.createdBy !== ctx.user.id) {
      await notify(ctx.org.id, t.createdBy, `${ctx.user.name} completed: ${t.title}`, undefined, `/me/tasks?task=${t.id}`, tx);
    }
    return { task: done!, next };
  });
}

/** Finds people named with @First Last or @First in a comment. */
async function mentionedUsers(orgId: string, body: string, exclude: string): Promise<{ id: string; name: string }[]> {
  if (!body.includes("@")) return [];
  const rows = await db.select({ id: users.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), isNull(memberships.deletedAt)));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rows.filter((u) => {
    if (u.id === exclude) return false;
    const full = u.name.trim();
    const first = full.split(/\s+/)[0] ?? "";
    if (new RegExp(`@${esc(full)}(?![\\p{L}\\p{N}])`, "iu").test(body)) return true;
    return !!first && new RegExp(`@${esc(first)}(?![\\p{L}\\p{N}])`, "iu").test(body);
  });
}

// ---------------- schemas ----------------

const dueInput = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).nullable().optional();
const toDue = (v: string | null | undefined) => (v == null ? v : new Date(v.length === 10 ? `${v}T17:00:00` : v));

const taskInput = z.object({
  title: z.string().trim().min(1, "Give the task a title.").max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  assigneeUserId: uuid.nullable().optional(),
  dueAt: dueInput,
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  workspace: z.enum(WORKSPACE_VALUES).default("workflows"),
  linkType: z.enum(LINK_TYPES).nullable().optional(),
  linkId: uuid.nullable().optional(),
  repeatRule: z.enum(["weekly", "monthly"]).nullable().optional(),
});

const taskPatch = z.object({
  title: z.string().trim().min(1, "Give the task a title.").max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  assigneeUserId: uuid.nullable().optional(),
  dueAt: dueInput,
  priority: z.enum(["low", "medium", "high"]).optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  linkType: z.enum(LINK_TYPES).nullable().optional(),
  linkId: uuid.nullable().optional(),
  repeatRule: z.enum(["weekly", "monthly"]).nullable().optional(),
});

const approvalInput = z.object({
  kind: z.enum(["purchase", "document", "other"]),
  title: z.string().trim().min(1, "Say what this request is for.").max(200),
  details: z.string().trim().max(5000).nullable().optional(),
  amount: z.coerce.number().nonnegative("Enter an amount of 0 or more.").max(1e12).nullable().optional(),
});

const ruleInput = z.object({
  kind: z.enum(["purchase", "document", "offer", "other"]),
  minAmount: z.coerce.number().nonnegative().max(1e12).nullable().optional(),
  approverUserId: uuid,
  label: z.string().trim().max(80).nullable().optional(),
  position: z.coerce.number().int().min(0).max(100).default(0),
});

const templateItem = z.object({
  title: z.string().trim().min(1, "Every task needs a title.").max(200),
  group: z.string().trim().max(80).optional(),
  assigneeRole: z.enum(["hr", "manager", "employee", "creator", "admin"]),
  offsetDays: z.coerce.number().int().min(-365).max(365),
});
const templateInput = z.object({
  name: z.string().trim().min(1, "Give the template a name.").max(120),
  kind: z.enum(["onboarding", "offboarding", "general"]).default("general"),
  trigger: z.object({ event: z.string().max(60), departmentId: uuid.optional() }).nullable().optional(),
  items: z.array(templateItem).max(100).default([]),
});

// ---------------- routes ----------------

export default async function workflowsRoutes(app: FastifyInstance) {
  // ----- summary for the header -----
  app.get(`${P}/summary`, async (req) => {
    const ctx = await requireOrg(req);
    const [t] = await db.select({ n: dsql<number>`count(*)::int` }).from(tasks)
      .where(and(eq(tasks.orgId, ctx.org.id), isNull(tasks.deletedAt), eq(tasks.assigneeUserId, ctx.user.id), ne(tasks.status, "done")));
    const [a] = await db.select({ n: dsql<number>`count(distinct ${approvals.id})::int` }).from(approvalSteps)
      .innerJoin(approvals, eq(approvals.id, approvalSteps.approvalId))
      .where(and(eq(approvals.orgId, ctx.org.id), isNull(approvals.deletedAt), eq(approvals.status, "pending"),
        eq(approvalSteps.status, "pending"), eq(approvalSteps.approverUserId, ctx.user.id)));
    return { myTasks: t?.n ?? 0, approvalsWaiting: a?.n ?? 0 };
  });

  // ----- tasks -----
  app.get<{ Querystring: { scope?: string; workspace?: string; priority?: string; status?: string; q?: string; createdBy?: string; tz?: string } }>(
    `${P}/tasks`, async (req) => {
      const ctx = await requireOrg(req);
      const q = req.query;
      const scope = q.scope === "created" ? "created" : q.scope === "all" ? "all" : "mine";
      if (scope === "all" && !hasAccess(ctx.access.workflows, "view")) throw forbidden("You don't have access to this workspace.");
      const conds: SQL[] = [eq(tasks.orgId, ctx.org.id), isNull(tasks.deletedAt)];
      if (scope === "mine") conds.push(eq(tasks.assigneeUserId, ctx.user.id));
      if (scope === "created") conds.push(eq(tasks.createdBy, ctx.user.id));
      if (q.workspace && (WORKSPACE_VALUES as readonly string[]).includes(q.workspace)) conds.push(eq(tasks.workspace, q.workspace));
      if (q.priority && ["low", "medium", "high"].includes(q.priority)) conds.push(eq(tasks.priority, q.priority as "low"));
      if (q.createdBy && z.string().uuid().safeParse(q.createdBy).success) conds.push(eq(tasks.createdBy, q.createdBy));
      if (q.q?.trim()) conds.push(ilike(tasks.title, `%${q.q.trim().replace(/[%_]/g, "")}%`));
      const wantDone = !q.status || q.status === "done";
      const wantOpen = !q.status || q.status === "todo" || q.status === "in_progress" || q.status === "open";
      const open = wantOpen
        ? await db.select().from(tasks).where(and(...conds, q.status === "todo" || q.status === "in_progress" ? eq(tasks.status, q.status) : ne(tasks.status, "done")))
          .orderBy(dsql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt)).limit(500)
        : [];
      const done = wantDone
        ? await db.select().from(tasks).where(and(...conds, eq(tasks.status, "done"), gte(tasks.completedAt, new Date(Date.now() - 14 * DAY))))
          .orderBy(desc(tasks.completedAt)).limit(30)
        : [];
      const views = await taskViews([...open, ...done]);
      // Group by the viewer's local day (tz = minutes from Date.getTimezoneOffset()).
      const tz = Number.isFinite(Number(q.tz)) ? Math.max(-840, Math.min(840, Number(q.tz))) : 0;
      const localNow = Date.now() - tz * 60_000;
      const startToday = Math.floor(localNow / DAY) * DAY + tz * 60_000;
      const endToday = startToday + DAY;
      const endWeek = startToday + 7 * DAY;
      const groups = { overdue: [] as typeof views, today: [] as typeof views, week: [] as typeof views, later: [] as typeof views, done: [] as typeof views };
      for (const v of views) {
        if (v.status === "done") { groups.done.push(v); continue; }
        const due = v.dueAt ? new Date(v.dueAt).getTime() : null;
        if (due === null) groups.later.push(v);
        else if (due < startToday) groups.overdue.push(v);
        else if (due < endToday) groups.today.push(v);
        else if (due < endWeek) groups.week.push(v);
        else groups.later.push(v);
      }
      return {
        total: open.length,
        groups: [
          { key: "overdue", label: "Overdue", tasks: groups.overdue },
          { key: "today", label: "Today", tasks: groups.today },
          { key: "week", label: "This week", tasks: groups.week },
          { key: "later", label: "Later", tasks: groups.later },
          { key: "done", label: "Done recently", tasks: groups.done },
        ],
      };
    });

  app.post(`${P}/tasks`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "edit");
    const input = parse(taskInput, req.body);
    if (input.assigneeUserId && !(await isActiveMember(ctx.org.id, input.assigneeUserId))) throw badRequest("Some details need fixing.", { assigneeUserId: "Choose someone in your organisation." });
    let linkLabel: string | null = null;
    if (input.linkType && input.linkId) {
      const target = await resolveTarget(ctx.org.id, input.linkType, input.linkId);
      if (!target) throw badRequest("Some details need fixing.", { linkId: "That record wasn't found." });
      linkLabel = input.linkType === "deal" ? `${target.label} deal` : target.label;
    }
    const t = await db.transaction(async (tx) => {
      let row = await createTask({
        orgId: ctx.org.id, title: input.title, description: input.description ?? null, workspace: input.workspace ?? "workflows",
        assigneeUserId: input.assigneeUserId ?? null, createdBy: ctx.user.id, dueAt: toDue(input.dueAt) ?? null, priority: input.priority ?? "medium",
        linkType: linkLabel ? input.linkType : null, linkId: linkLabel ? input.linkId : null, linkLabel,
      }, tx);
      if (input.repeatRule) [row] = await tx.update(tasks).set({ repeatRule: input.repeatRule }).where(eq(tasks.id, row.id)).returning();
      await audit(ctx, { action: "task.created", category: "data", entityType: "task", entityId: row!.id, summary: `${ctx.user.name} created "${row!.title}"` }, tx);
      return row!;
    });
    return (await taskViews([t]))[0];
  });

  app.get<{ Params: { id: string } }>(`${P}/tasks/:id`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id);
    const [items, comments, linked, view] = await Promise.all([
      db.select().from(taskItems).where(and(eq(taskItems.taskId, t.id), isNull(taskItems.deletedAt))).orderBy(asc(taskItems.position), asc(taskItems.createdAt)),
      db.select({ c: taskComments, name: users.name }).from(taskComments).innerJoin(users, eq(users.id, taskComments.authorUserId))
        .where(and(eq(taskComments.taskId, t.id), isNull(taskComments.deletedAt))).orderBy(asc(taskComments.createdAt)),
      db.select({ f: files }).from(fileLinks).innerJoin(files, eq(files.id, fileLinks.fileId))
        .where(and(eq(fileLinks.orgId, ctx.org.id), eq(fileLinks.linkType, "task"), eq(fileLinks.linkId, t.id), isNull(files.deletedAt))),
      taskViews([t]),
    ]);
    return {
      task: view[0],
      items: items.map((i) => ({ id: i.id, label: i.label, done: i.done, position: i.position })),
      comments: comments.map(({ c, name }) => ({ id: c.id, body: c.body, author: { id: c.authorUserId, name }, createdAt: c.createdAt })),
      files: linked.map(({ f }) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind, createdAt: f.createdAt })),
      canEdit: canEditTask(ctx, t),
      canDelete: t.createdBy === ctx.user.id || hasAccess(ctx.access.workflows, "manage"),
    };
  });

  app.patch<{ Params: { id: string } }>(`${P}/tasks/:id`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id, { edit: true });
    const input = parse(taskPatch, req.body);
    if (input.assigneeUserId && !(await isActiveMember(ctx.org.id, input.assigneeUserId))) throw badRequest("Some details need fixing.", { assigneeUserId: "Choose someone in your organisation." });
    const set: Partial<typeof tasks.$inferInsert> = {};
    const changed: string[] = [];
    if (input.title !== undefined && input.title !== t.title) { set.title = input.title; changed.push("title"); }
    if (input.description !== undefined) { set.description = input.description; changed.push("description"); }
    if (input.priority && input.priority !== t.priority) { set.priority = input.priority; changed.push(`priority to ${input.priority}`); }
    if (input.dueAt !== undefined) { set.dueAt = toDue(input.dueAt) ?? null; changed.push("due date"); }
    if (input.repeatRule !== undefined) { set.repeatRule = input.repeatRule; changed.push("repeat"); }
    if (input.assigneeUserId !== undefined && input.assigneeUserId !== t.assigneeUserId) { set.assigneeUserId = input.assigneeUserId; changed.push("assignee"); }
    if (input.linkType !== undefined || input.linkId !== undefined) {
      if (input.linkType && input.linkId) {
        const target = await resolveTarget(ctx.org.id, input.linkType, input.linkId);
        if (!target) throw badRequest("Some details need fixing.", { linkId: "That record wasn't found." });
        Object.assign(set, { linkType: input.linkType, linkId: input.linkId, linkLabel: input.linkType === "deal" ? `${target.label} deal` : target.label });
      } else Object.assign(set, { linkType: null, linkId: null, linkLabel: null });
      changed.push("linked record");
    }
    if (input.status && input.status !== "done" && input.status !== t.status) {
      set.status = input.status;
      if (t.status === "done") Object.assign(set, { completedAt: null, completedBy: null });
      changed.push(`status to ${input.status === "in_progress" ? "in progress" : "to do"}`);
    }
    let row = t;
    if (Object.keys(set).length) {
      [row] = (await db.update(tasks).set({ ...set, version: dsql`${tasks.version} + 1` }).where(eq(tasks.id, t.id)).returning()) as Task[];
      await audit(ctx, { action: "task.updated", category: "data", entityType: "task", entityId: t.id, summary: `${ctx.user.name} changed the ${changed.join(", ")} of "${row!.title}"` });
      if (set.assigneeUserId && set.assigneeUserId !== ctx.user.id) {
        await notify(ctx.org.id, set.assigneeUserId, `${ctx.user.name} assigned you: ${row!.title}`, undefined, `/me/tasks?task=${t.id}`);
      }
    }
    if (input.status === "done" && t.status !== "done") row = (await completeTask(ctx, row!)).task;
    return (await taskViews([row!]))[0];
  });

  app.post<{ Params: { id: string } }>(`${P}/tasks/:id/complete`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id, { edit: true });
    if (t.status === "done") throw conflict("This task is already complete.");
    const r = await completeTask(ctx, t);
    const views = await taskViews(r.next ? [r.task, r.next] : [r.task]);
    return { task: views[0], next: views[1] ?? null };
  });

  app.post<{ Params: { id: string } }>(`${P}/tasks/:id/reopen`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id, { edit: true });
    if (t.status !== "done") throw conflict("This task is still open.");
    const [row] = await db.update(tasks).set({ status: "todo", completedAt: null, completedBy: null, version: dsql`${tasks.version} + 1` })
      .where(eq(tasks.id, t.id)).returning();
    await audit(ctx, { action: "task.reopened", category: "data", entityType: "task", entityId: t.id, summary: `${ctx.user.name} reopened "${t.title}"` });
    return (await taskViews([row!]))[0];
  });

  app.delete<{ Params: { id: string } }>(`${P}/tasks/:id`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id);
    if (t.createdBy !== ctx.user.id && !hasAccess(ctx.access.workflows, "manage")) throw forbidden("Only the person who created this task or an admin can delete it.");
    await db.update(tasks).set({ deletedAt: new Date(), version: dsql`${tasks.version} + 1` }).where(eq(tasks.id, t.id));
    await audit(ctx, { action: "task.deleted", category: "data", entityType: "task", entityId: t.id, summary: `${ctx.user.name} deleted "${t.title}"` });
    return { ok: true };
  });

  // ----- checklist items -----
  app.post<{ Params: { id: string } }>(`${P}/tasks/:id/items`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id, { edit: true });
    const { label } = parse(z.object({ label: z.string().trim().min(1, "Write the checklist item.").max(300) }), req.body);
    const [max] = await db.select({ n: dsql<number>`coalesce(max(${taskItems.position}), -1)::int` }).from(taskItems).where(eq(taskItems.taskId, t.id));
    const [i] = await db.insert(taskItems).values({ orgId: ctx.org.id, taskId: t.id, label, position: (max?.n ?? -1) + 1 }).returning();
    return { id: i!.id, label: i!.label, done: i!.done, position: i!.position };
  });

  async function loadItem(ctx: OrgContext, taskId: string, itemId: string) {
    const t = await loadTask(ctx, taskId, { edit: true });
    if (!z.string().uuid().safeParse(itemId).success) throw notFound("That checklist item");
    const [i] = await db.select().from(taskItems)
      .where(and(eq(taskItems.id, itemId), eq(taskItems.taskId, t.id), eq(taskItems.orgId, ctx.org.id), isNull(taskItems.deletedAt))).limit(1);
    if (!i) throw notFound("That checklist item");
    return i;
  }

  app.patch<{ Params: { id: string; itemId: string } }>(`${P}/tasks/:id/items/:itemId`, async (req) => {
    const ctx = await requireOrg(req);
    const i = await loadItem(ctx, req.params.id, req.params.itemId);
    const input = parse(z.object({
      label: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional(), position: z.number().int().min(0).optional(),
    }), req.body);
    const [u] = await db.update(taskItems).set({ ...input, version: dsql`${taskItems.version} + 1` }).where(eq(taskItems.id, i.id)).returning();
    return { id: u!.id, label: u!.label, done: u!.done, position: u!.position };
  });

  app.delete<{ Params: { id: string; itemId: string } }>(`${P}/tasks/:id/items/:itemId`, async (req) => {
    const ctx = await requireOrg(req);
    const i = await loadItem(ctx, req.params.id, req.params.itemId);
    await db.update(taskItems).set({ deletedAt: new Date(), version: dsql`${taskItems.version} + 1` }).where(eq(taskItems.id, i.id));
    return { ok: true };
  });

  // ----- comments -----
  app.post<{ Params: { id: string } }>(`${P}/tasks/:id/comments`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id);
    const { body } = parse(z.object({ body: z.string().trim().min(1, "Write a comment first.").max(5000) }), req.body);
    const [c] = await db.insert(taskComments).values({ orgId: ctx.org.id, taskId: t.id, authorUserId: ctx.user.id, body }).returning();
    const mentioned = await mentionedUsers(ctx.org.id, body, ctx.user.id);
    const notified = new Set<string>();
    for (const u of mentioned) {
      notified.add(u.id);
      await notify(ctx.org.id, u.id, `${ctx.user.name} mentioned you on: ${t.title}`, body.slice(0, 200), `/me/tasks?task=${t.id}`);
    }
    for (const uid of [t.assigneeUserId, t.createdBy]) {
      if (uid && uid !== ctx.user.id && !notified.has(uid)) {
        notified.add(uid);
        await notify(ctx.org.id, uid, `${ctx.user.name} commented on: ${t.title}`, body.slice(0, 200), `/me/tasks?task=${t.id}`);
      }
    }
    await audit(ctx, { action: "task.commented", category: "data", entityType: "task", entityId: t.id, summary: `${ctx.user.name} commented on "${t.title}"` });
    return { id: c!.id, body: c!.body, author: { id: ctx.user.id, name: ctx.user.name }, createdAt: c!.createdAt, mentioned: mentioned.map((m) => m.name) };
  });

  /** Removes a file from a task (the file itself stays). */
  app.delete<{ Params: { id: string; fileId: string } }>(`${P}/tasks/:id/files/:fileId`, async (req) => {
    const ctx = await requireOrg(req);
    const t = await loadTask(ctx, req.params.id, { edit: true });
    if (!z.string().uuid().safeParse(req.params.fileId).success) throw notFound("That file");
    await db.delete(fileLinks).where(and(eq(fileLinks.orgId, ctx.org.id), eq(fileLinks.linkType, "task"), eq(fileLinks.linkId, t.id), eq(fileLinks.fileId, req.params.fileId)));
    await audit(ctx, { action: "task.file_removed", category: "data", entityType: "task", entityId: t.id, summary: `${ctx.user.name} removed a file from "${t.title}"` });
    return { ok: true };
  });

  app.get<{ Querystring: { q?: string } }>(`${P}/link-targets`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "edit");
    const q = (req.query.q ?? "").trim();
    if (q.length < 1) return [];
    return searchTargets(ctx.org.id, q);
  });

  // ----- approvals -----
  async function approvalViews(rows: Approval[], ctx: OrgContext) {
    if (!rows.length) return [];
    const steps = await db.select().from(approvalSteps).where(inArray(approvalSteps.approvalId, rows.map((a) => a.id))).orderBy(asc(approvalSteps.position));
    const names = await userNames([...rows.map((a) => a.requestedBy), ...steps.map((s) => s.approverUserId)]);
    return rows.map((a) => {
      const mine = steps.filter((s) => s.approvalId === a.id);
      const current = mine.find((s) => s.status === "pending") ?? null;
      return {
        id: a.id, kind: a.kind, title: a.title, details: a.details, amount: a.amount, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt,
        requester: { id: a.requestedBy, name: names.get(a.requestedBy) ?? "Unknown" },
        currentApprover: current ? { id: current.approverUserId, name: names.get(current.approverUserId) ?? "Unknown" } : null,
        steps: mine.length,
        myTurn: a.status === "pending" && current?.approverUserId === ctx.user.id,
      };
    });
  }

  app.get<{ Querystring: { scope?: string; kind?: string; status?: string } }>(`${P}/approvals`, async (req) => {
    const ctx = await requireOrg(req);
    const scope = req.query.scope === "mine" ? "mine" : req.query.scope === "all" ? "all" : "waiting";
    if (scope === "all" && ctx.membership.role !== "admin") throw forbidden("Only admins can see every approval.");
    const conds: SQL[] = [eq(approvals.orgId, ctx.org.id), isNull(approvals.deletedAt)];
    if (req.query.kind && ["leave", "purchase", "document", "offer", "other"].includes(req.query.kind)) conds.push(eq(approvals.kind, req.query.kind as "leave"));
    if (req.query.status && ["pending", "approved", "declined"].includes(req.query.status)) conds.push(eq(approvals.status, req.query.status as "pending"));
    if (scope === "mine") conds.push(eq(approvals.requestedBy, ctx.user.id));
    if (scope === "waiting") {
      conds.push(eq(approvals.status, "pending"));
      conds.push(dsql`exists (select 1 from ${approvalSteps} where ${approvalSteps.approvalId} = ${approvals.id}
        and ${approvalSteps.status} = 'pending' and ${approvalSteps.approverUserId} = ${ctx.user.id})`);
    }
    const rows = await db.select().from(approvals).where(and(...conds)).orderBy(desc(approvals.createdAt)).limit(200);
    return approvalViews(rows, ctx);
  });

  async function loadApproval(ctx: OrgContext, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("That approval");
    const [a] = await db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.orgId, ctx.org.id), isNull(approvals.deletedAt))).limit(1);
    if (!a) throw notFound("That approval");
    const steps = await db.select().from(approvalSteps).where(eq(approvalSteps.approvalId, a.id)).orderBy(asc(approvalSteps.position));
    const allowed = ctx.membership.role === "admin" || a.requestedBy === ctx.user.id || steps.some((s) => s.approverUserId === ctx.user.id);
    if (!allowed) throw notFound("That approval");
    return { a, steps };
  }

  app.get<{ Params: { id: string } }>(`${P}/approvals/:id`, async (req) => {
    const ctx = await requireOrg(req);
    const { a, steps } = await loadApproval(ctx, req.params.id);
    const names = await userNames([a.requestedBy, ...steps.map((s) => s.approverUserId)]);
    const [reqMember] = await db.select({ jobTitle: memberships.jobTitle }).from(memberships)
      .where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.userId, a.requestedBy))).limit(1);
    const attachments = await db.select({ f: files }).from(fileLinks).innerJoin(files, eq(files.id, fileLinks.fileId))
      .where(and(eq(fileLinks.orgId, ctx.org.id), eq(fileLinks.linkType, "approval"), eq(fileLinks.linkId, a.id), isNull(files.deletedAt)));
    const current = steps.find((s) => s.status === "pending");
    return {
      id: a.id, kind: a.kind, title: a.title, details: a.details, amount: a.amount, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt,
      linkType: a.linkType, linkId: a.linkId,
      requester: { id: a.requestedBy, name: names.get(a.requestedBy) ?? "Unknown", jobTitle: reqMember?.jobTitle ?? null },
      steps: steps.map((s) => ({
        id: s.id, position: s.position, label: s.label, status: s.status, comment: s.comment, decidedAt: s.decidedAt,
        approver: { id: s.approverUserId, name: names.get(s.approverUserId) ?? "Unknown" }, isMe: s.approverUserId === ctx.user.id,
      })),
      files: attachments.map(({ f }) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })),
      canDecide: a.status === "pending" && !!current && (current.approverUserId === ctx.user.id || ctx.membership.role === "admin"),
    };
  });

  app.post(`${P}/approvals`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "edit");
    const input = parse(approvalInput, req.body);
    if (input.kind === "purchase" && input.amount == null) throw badRequest("Some details need fixing.", { amount: "Enter the amount for this purchase." });
    // First approver: the requester's manager (if they use WindVeal), otherwise an admin.
    let first: string | null = null;
    let firstLabel = "Manager";
    const [me] = await db.select().from(employees).where(and(eq(employees.orgId, ctx.org.id), eq(employees.userId, ctx.user.id), isNull(employees.deletedAt))).limit(1);
    if (me?.managerId) {
      const [mgr] = await db.select().from(employees).where(and(eq(employees.id, me.managerId), eq(employees.orgId, ctx.org.id), isNull(employees.deletedAt))).limit(1);
      if (mgr?.userId && mgr.userId !== ctx.user.id && (await isActiveMember(ctx.org.id, mgr.userId))) first = mgr.userId;
    }
    if (!first) {
      firstLabel = "Admin";
      const admins = await db.select({ userId: memberships.userId, primary: memberships.isPrimaryAdmin }).from(memberships)
        .where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.role, "admin"), eq(memberships.status, "active"), isNull(memberships.deletedAt)))
        .orderBy(desc(memberships.isPrimaryAdmin), asc(memberships.createdAt));
      first = admins.find((m) => m.userId !== ctx.user.id)?.userId ?? admins[0]?.userId ?? null;
    }
    if (!first) throw badRequest("There's no one to approve this yet. Ask an admin for help.");
    const a = await db.transaction(async (tx) => {
      const row = await createApproval({
        orgId: ctx.org.id, kind: input.kind, title: input.title, details: input.details ?? null, amount: input.amount ?? null,
        requestedBy: ctx.user.id, firstApproverUserId: first!, firstLabel, tx,
      });
      await audit(ctx, { action: "approval.requested", category: "data", entityType: "approval", entityId: row.id, summary: `${ctx.user.name} requested approval: ${row.title}` }, tx);
      return row;
    });
    return (await approvalViews([a], ctx))[0];
  });

  app.post<{ Params: { id: string } }>(`${P}/approvals/:id/decide`, async (req) => {
    const ctx = await requireOrg(req);
    const input = parse(z.object({ decision: z.enum(["approve", "decline"]), comment: z.string().trim().max(2000).nullable().optional() }), req.body);
    const { a } = await loadApproval(ctx, req.params.id);
    if (a.status !== "pending") throw conflict("This request has already been decided.");
    const result = await db.transaction(async (tx) => {
      const steps = await tx.select().from(approvalSteps).where(eq(approvalSteps.approvalId, a.id)).orderBy(asc(approvalSteps.position)).for("update");
      const current = steps.find((s) => s.status === "pending");
      if (!current) throw conflict("This request has no step waiting for a decision.");
      if (current.approverUserId !== ctx.user.id && ctx.membership.role !== "admin") throw forbidden("It's not your turn to decide on this request.");
      const now = new Date();
      const comment = input.comment || null;
      await tx.update(approvalSteps).set({ status: input.decision === "approve" ? "approved" : "declined", comment, decidedAt: now })
        .where(eq(approvalSteps.id, current.id));
      let outcome: "approved" | "declined" | null = null;
      if (input.decision === "decline") {
        outcome = "declined";
        await tx.update(approvalSteps).set({ status: "skipped" }).where(and(eq(approvalSteps.approvalId, a.id), eq(approvalSteps.status, "waiting")));
      } else {
        const next = steps.find((s) => s.position > current.position && s.status === "waiting");
        if (next) {
          await tx.update(approvalSteps).set({ status: "pending" }).where(eq(approvalSteps.id, next.id));
          await notify(ctx.org.id, next.approverUserId, `Approval needed: ${a.title}`, `${ctx.user.name} approved it and passed it to you.`, `/workflows/approvals?id=${a.id}`, tx);
        } else outcome = "approved";
      }
      let updated = a;
      if (outcome) {
        [updated] = (await tx.update(approvals).set({ status: outcome, decidedAt: now, version: dsql`${approvals.version} + 1` })
          .where(eq(approvals.id, a.id)).returning()) as Approval[];
        await approvalHandler(updated!.kind)?.(updated!, outcome, ctx.user.id, tx);
      } else {
        [updated] = (await tx.update(approvals).set({ version: dsql`${approvals.version} + 1` }).where(eq(approvals.id, a.id)).returning()) as Approval[];
      }
      if (a.requestedBy !== ctx.user.id) {
        const title = outcome === "approved" ? `Approved: ${a.title}` : outcome === "declined" ? `Declined: ${a.title}` : `${ctx.user.name} approved a step: ${a.title}`;
        await notify(ctx.org.id, a.requestedBy, title, comment ?? undefined, `/workflows/approvals?id=${a.id}`, tx);
      }
      await audit(ctx, {
        action: input.decision === "approve" ? "approval.approved" : "approval.declined", category: "data", entityType: "approval", entityId: a.id,
        summary: `${ctx.user.name} ${input.decision === "approve" ? "approved" : "declined"} ${a.title}${outcome === null ? " (passed to the next approver)" : ""}`,
        meta: { comment, step: current.position },
      }, tx);
      return updated!;
    });
    return { status: result.status };
  });

  // ----- approval rules (admin) -----
  app.get(`${P}/approval-rules`, async (req) => {
    const ctx = await requireAdmin(req);
    const rows = await db.select({ r: approvalRules, name: users.name }).from(approvalRules).innerJoin(users, eq(users.id, approvalRules.approverUserId))
      .where(and(eq(approvalRules.orgId, ctx.org.id), isNull(approvalRules.deletedAt))).orderBy(asc(approvalRules.kind), asc(approvalRules.position));
    return rows.map(({ r, name }) => ({ id: r.id, kind: r.kind, minAmount: r.minAmount, label: r.label, position: r.position, approver: { id: r.approverUserId, name } }));
  });

  app.post(`${P}/approval-rules`, async (req) => {
    const ctx = await requireAdmin(req);
    const input = parse(ruleInput, req.body);
    if (!(await isActiveMember(ctx.org.id, input.approverUserId))) throw badRequest("Some details need fixing.", { approverUserId: "Choose someone in your organisation." });
    const [r] = await db.insert(approvalRules).values({
      orgId: ctx.org.id, kind: input.kind, minAmount: input.minAmount != null ? String(input.minAmount) : null,
      approverUserId: input.approverUserId, label: input.label ?? null, position: input.position,
    }).returning();
    await audit(ctx, { action: "approval_rule.created", category: "settings", entityType: "approval_rule", entityId: r!.id, summary: `${ctx.user.name} added an approval rule for ${input.kind}` });
    return { id: r!.id };
  });

  app.patch<{ Params: { id: string } }>(`${P}/approval-rules/:id`, async (req) => {
    const ctx = await requireAdmin(req);
    const input = parse(ruleInput.partial(), req.body);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That rule");
    if (input.approverUserId && !(await isActiveMember(ctx.org.id, input.approverUserId))) throw badRequest("Some details need fixing.", { approverUserId: "Choose someone in your organisation." });
    const set: Partial<typeof approvalRules.$inferInsert> = {};
    if (input.kind) set.kind = input.kind;
    if (input.minAmount !== undefined) set.minAmount = input.minAmount != null ? String(input.minAmount) : null;
    if (input.approverUserId) set.approverUserId = input.approverUserId;
    if (input.label !== undefined) set.label = input.label;
    if (input.position !== undefined) set.position = input.position;
    const [r] = await db.update(approvalRules).set({ ...set, version: dsql`${approvalRules.version} + 1` })
      .where(and(eq(approvalRules.id, req.params.id), eq(approvalRules.orgId, ctx.org.id), isNull(approvalRules.deletedAt))).returning();
    if (!r) throw notFound("That rule");
    await audit(ctx, { action: "approval_rule.updated", category: "settings", entityType: "approval_rule", entityId: r.id, summary: `${ctx.user.name} changed an approval rule for ${r.kind}` });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>(`${P}/approval-rules/:id`, async (req) => {
    const ctx = await requireAdmin(req);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That rule");
    const [r] = await db.update(approvalRules).set({ deletedAt: new Date(), version: dsql`${approvalRules.version} + 1` })
      .where(and(eq(approvalRules.id, req.params.id), eq(approvalRules.orgId, ctx.org.id), isNull(approvalRules.deletedAt))).returning();
    if (!r) throw notFound("That rule");
    await audit(ctx, { action: "approval_rule.deleted", category: "settings", entityType: "approval_rule", entityId: r.id, summary: `${ctx.user.name} removed an approval rule for ${r.kind}` });
    return { ok: true };
  });

  // ----- templates -----
  const templateView = (t: typeof taskTemplates.$inferSelect) => ({
    id: t.id, name: t.name, kind: t.kind, trigger: t.trigger, items: t.items, timesUsed: t.timesUsed, updatedAt: t.updatedAt, version: t.version,
  });

  async function loadTemplate(ctx: OrgContext, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("That template");
    const [t] = await db.select().from(taskTemplates).where(and(eq(taskTemplates.id, id), eq(taskTemplates.orgId, ctx.org.id), isNull(taskTemplates.deletedAt))).limit(1);
    if (!t) throw notFound("That template");
    return t;
  }

  app.get(`${P}/templates`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "view");
    const rows = await db.select().from(taskTemplates).where(and(eq(taskTemplates.orgId, ctx.org.id), isNull(taskTemplates.deletedAt))).orderBy(asc(taskTemplates.name));
    return rows.map(templateView);
  });

  app.get<{ Params: { id: string } }>(`${P}/templates/:id`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "view");
    return templateView(await loadTemplate(ctx, req.params.id));
  });

  app.post(`${P}/templates`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "manage");
    const input = parse(templateInput, req.body);
    const [t] = await db.insert(taskTemplates).values({ orgId: ctx.org.id, name: input.name, kind: input.kind, trigger: input.trigger ?? null, items: input.items }).returning();
    await audit(ctx, { action: "template.created", category: "settings", entityType: "task_template", entityId: t!.id, summary: `${ctx.user.name} created the template "${t!.name}"` });
    return templateView(t!);
  });

  app.patch<{ Params: { id: string } }>(`${P}/templates/:id`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "manage");
    const t = await loadTemplate(ctx, req.params.id);
    const input = parse(templateInput.partial(), req.body);
    const [u] = await db.update(taskTemplates).set({
      ...(input.name !== undefined ? { name: input.name } : {}), ...(input.kind ? { kind: input.kind } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}), ...(input.items ? { items: input.items } : {}),
      version: dsql`${taskTemplates.version} + 1`,
    }).where(eq(taskTemplates.id, t.id)).returning();
    await audit(ctx, { action: "template.updated", category: "settings", entityType: "task_template", entityId: t.id, summary: `${ctx.user.name} changed the template "${u!.name}"` });
    return templateView(u!);
  });

  app.delete<{ Params: { id: string } }>(`${P}/templates/:id`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "manage");
    const t = await loadTemplate(ctx, req.params.id);
    await db.update(taskTemplates).set({ deletedAt: new Date(), version: dsql`${taskTemplates.version} + 1` }).where(eq(taskTemplates.id, t.id));
    await audit(ctx, { action: "template.deleted", category: "settings", entityType: "task_template", entityId: t.id, summary: `${ctx.user.name} deleted the template "${t.name}"` });
    return { ok: true };
  });

  /** Use a template: for an employee it starts a checklist; otherwise the tasks are created for the person using it. */
  app.post<{ Params: { id: string } }>(`${P}/templates/:id/use`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "edit");
    const t = await loadTemplate(ctx, req.params.id);
    const input = parse(z.object({ employeeId: uuid.nullable().optional(), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.").optional() }), req.body);
    const today = new Date().toISOString().slice(0, 10);
    if (input.employeeId) {
      const [emp] = await db.select().from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.orgId, ctx.org.id), isNull(employees.deletedAt))).limit(1);
      if (!emp) throw badRequest("Some details need fixing.", { employeeId: "That employee wasn't found." });
      const kind = t.kind === "offboarding" ? "offboarding" : "onboarding";
      const anchorDate = input.anchorDate ?? (kind === "offboarding" ? emp.endDate : emp.startDate) ?? today;
      const cl = await db.transaction(async (tx) => {
        const c = await startChecklist({ orgId: ctx.org.id, employeeId: emp.id, templateId: t.id, kind, anchorDate, createdBy: ctx.user.id, tx });
        await audit(ctx, { action: "template.used", category: "data", entityType: "task_template", entityId: t.id, summary: `${ctx.user.name} started "${t.name}" for ${emp.firstName} ${emp.lastName}` }, tx);
        return c;
      });
      return { checklistId: cl?.id ?? null, created: t.items.length };
    }
    const anchor = new Date(`${input.anchorDate ?? today}T09:00:00`);
    await db.transaction(async (tx) => {
      for (const item of t.items) {
        await createTask({
          orgId: ctx.org.id, title: item.title, workspace: "workflows", assigneeUserId: ctx.user.id, createdBy: ctx.user.id,
          dueAt: new Date(anchor.getTime() + item.offsetDays * DAY),
        }, tx);
      }
      await tx.update(taskTemplates).set({ timesUsed: t.timesUsed + 1 }).where(eq(taskTemplates.id, t.id));
      await audit(ctx, { action: "template.used", category: "data", entityType: "task_template", entityId: t.id, summary: `${ctx.user.name} used the template "${t.name}"` }, tx);
    });
    return { checklistId: null, created: t.items.length };
  });

  /** Lightweight employee picker for "Use template". */
  app.get<{ Querystring: { q?: string } }>(`${P}/employees`, async (req) => {
    const ctx = await requireAccess(req, "workflows", "edit");
    const q = (req.query.q ?? "").trim().replace(/[%_]/g, "");
    const rows = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, jobTitle: employees.jobTitle, startDate: employees.startDate, status: employees.status })
      .from(employees)
      .where(and(eq(employees.orgId, ctx.org.id), isNull(employees.deletedAt), ne(employees.status, "left"),
        q ? ilike(dsql`${employees.firstName} || ' ' || ${employees.lastName}`, `%${q}%`) : undefined))
      .orderBy(asc(employees.firstName)).limit(30);
    return rows.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, jobTitle: e.jobTitle, startDate: e.startDate, status: e.status }));
  });
}

