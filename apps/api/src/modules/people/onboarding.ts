import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, isNull, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { checklists, employees, memberships, taskTemplates, tasks, users } from "../../db/schema";
import { requireAccess, requireOrg, type OrgContext } from "../../lib/context";
import { badRequest, forbidden, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { createTask } from "../../lib/tasks";
import { checklistProgress, fullName, hasLevel, inTeam, optDate, optId, optText, teamScope } from "./shared";

async function getChecklist(ctx: OrgContext, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That checklist");
  const [row] = await db.select({ c: checklists, e: employees }).from(checklists).innerJoin(employees, eq(employees.id, checklists.employeeId))
    .where(and(eq(checklists.id, id), eq(checklists.orgId, ctx.org.id), isNull(checklists.deletedAt), isNull(employees.deletedAt))).limit(1);
  if (!row) throw notFound("That checklist");
  // Someone's own checklist, or one in their team.
  const team = await teamScope(ctx);
  if (team && !team.includes(row.e.id) && row.e.userId !== ctx.user.id) throw notFound("That checklist");
  return row;
}

/** Marks a checklist done when all its tasks are done (and back to in progress if one is reopened). */
async function refreshChecklistStatus(checklistId: string) {
  const [r] = await db.select({
    total: dsql<number>`count(*)::int`, done: dsql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
  }).from(tasks).where(and(eq(tasks.checklistId, checklistId), isNull(tasks.deletedAt)));
  const status = r && r.total > 0 && r.done === r.total ? "done" : "in_progress";
  await db.update(checklists).set({ status, version: dsql`${checklists.version} + 1` })
    .where(and(eq(checklists.id, checklistId), dsql`${checklists.status} <> ${status}`));
  return { total: r?.total ?? 0, done: r?.done ?? 0, status };
}

export default async function onboardingRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; kind?: string } }>("/api/people/checklists", async (req) => {
    const ctx = await requireAccess(req, "people", "view");
    const status = req.query.status ?? "in_progress";
    const conds = [eq(checklists.orgId, ctx.org.id), isNull(checklists.deletedAt), isNull(employees.deletedAt), inTeam(await teamScope(ctx))];
    if (status === "in_progress" || status === "done") conds.push(eq(checklists.status, status));
    if (req.query.kind === "onboarding" || req.query.kind === "offboarding") conds.push(eq(checklists.kind, req.query.kind));
    const rows = await db.select({
      c: checklists, e: employees, template: taskTemplates.name,
    }).from(checklists).innerJoin(employees, eq(employees.id, checklists.employeeId))
      .leftJoin(taskTemplates, eq(taskTemplates.id, checklists.templateId))
      .where(and(...conds)).orderBy(desc(checklists.createdAt));
    const prog = await checklistProgress(rows.map((r) => r.c.id));
    return rows.map(({ c, e, template }) => ({
      id: c.id, kind: c.kind, title: c.title, status: c.status, templateName: template, createdAt: c.createdAt,
      total: prog.get(c.id)?.total ?? 0, done: prog.get(c.id)?.done ?? 0,
      employee: { id: e.id, name: fullName(e), jobTitle: e.jobTitle, startDate: e.startDate, endDate: e.endDate, status: e.status },
    }));
  });

  app.get<{ Params: { id: string } }>("/api/people/checklists/:id", async (req) => {
    const ctx = await requireOrg(req);
    const { c, e } = await getChecklist(ctx, req.params.id);
    const [template] = c.templateId ? await db.select().from(taskTemplates).where(eq(taskTemplates.id, c.templateId)).limit(1) : [];
    const rows = await db.select({ t: tasks, assignee: users.name }).from(tasks).leftJoin(users, eq(users.id, tasks.assigneeUserId))
      .where(and(eq(tasks.checklistId, c.id), eq(tasks.orgId, ctx.org.id), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.dueAt), asc(tasks.createdAt));
    // Keep groups in the template's order, then any extra groups in the order they appear.
    const order = [...new Set([...(template?.items ?? []).map((i) => i.group ?? "Other"), ...rows.map((r) => r.t.checklistGroup ?? "Other")])];
    const groups = order.map((name) => ({
      name,
      tasks: rows.filter((r) => (r.t.checklistGroup ?? "Other") === name).map(({ t, assignee }) => ({
        id: t.id, title: t.title, description: t.description, status: t.status, dueAt: t.dueAt, completedAt: t.completedAt,
        assignee: t.assigneeUserId ? { id: t.assigneeUserId, name: assignee ?? "Someone" } : null,
        canToggle: hasLevel(ctx, "edit") || t.assigneeUserId === ctx.user.id,
      })),
    })).filter((g) => g.tasks.length > 0);
    return {
      id: c.id, kind: c.kind, title: c.title, status: c.status, templateName: template?.name ?? null,
      total: rows.length, done: rows.filter((r) => r.t.status === "done").length,
      employee: { id: e.id, name: fullName(e), firstName: e.firstName, jobTitle: e.jobTitle, startDate: e.startDate, endDate: e.endDate, status: e.status },
      groups,
    };
  });

  app.post<{ Params: { id: string } }>("/api/people/checklists/:id/tasks", async (req) => {
    const ctx = await requireAccess(req, "people", "edit");
    const { c, e } = await getChecklist(ctx, req.params.id);
    const input = parse(z.object({
      title: z.string().trim().min(1, "Enter a task").max(200),
      description: optText(1000),
      group: optText(80),
      assigneeUserId: optId,
      dueDate: optDate,
    }), req.body);
    if (input.assigneeUserId) {
      const [m] = await db.select().from(memberships)
        .where(and(eq(memberships.orgId, ctx.org.id), eq(memberships.userId, input.assigneeUserId), isNull(memberships.deletedAt))).limit(1);
      if (!m) throw badRequest("Some details need fixing.", { assigneeUserId: "Choose someone in your organisation" });
    }
    const t = await createTask({
      orgId: ctx.org.id, title: input.title, description: input.description ?? null, workspace: "people",
      assigneeUserId: input.assigneeUserId ?? null, createdBy: ctx.user.id, dueAt: input.dueDate ? new Date(`${input.dueDate}T09:00:00`) : null,
      linkType: "employee", linkId: e.id, linkLabel: `${fullName(e)} · ${c.kind}`, checklistId: c.id, checklistGroup: input.group ?? null,
    });
    await refreshChecklistStatus(c.id);
    await audit(ctx, { action: "checklist.task_added", category: "data", entityType: "employee", entityId: e.id, summary: `${ctx.user.name} added "${t.title}" to ${c.title}` });
    return { id: t.id };
  });

  app.patch<{ Params: { id: string; taskId: string } }>("/api/people/checklists/:id/tasks/:taskId", async (req) => {
    const ctx = await requireOrg(req);
    const { c } = await getChecklist(ctx, req.params.id);
    const { done } = parse(z.object({ done: z.boolean() }), req.body);
    if (!z.string().uuid().safeParse(req.params.taskId).success) throw notFound("That task");
    const [t] = await db.select().from(tasks)
      .where(and(eq(tasks.id, req.params.taskId), eq(tasks.checklistId, c.id), eq(tasks.orgId, ctx.org.id), isNull(tasks.deletedAt))).limit(1);
    if (!t) throw notFound("That task");
    if (!hasLevel(ctx, "edit") && t.assigneeUserId !== ctx.user.id) throw forbidden("Only the person it's assigned to or HR can tick this off.");
    await db.update(tasks).set({
      status: done ? "done" : "todo", completedAt: done ? new Date() : null, completedBy: done ? ctx.user.id : null,
      version: dsql`${tasks.version} + 1`,
    }).where(eq(tasks.id, t.id));
    const progress = await refreshChecklistStatus(c.id);
    return { ok: true, ...progress };
  });
}
