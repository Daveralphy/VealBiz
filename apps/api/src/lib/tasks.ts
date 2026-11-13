import { and, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { checklists, employees, memberships, taskTemplates, tasks } from "../db/schema";
import { notify } from "./audit";

export type NewTask = {
  orgId: string;
  title: string;
  description?: string | null;
  workspace: "recruitment" | "people" | "crm" | "workflows" | "documents";
  assigneeUserId?: string | null;
  createdBy?: string | null;
  dueAt?: Date | null;
  priority?: "low" | "medium" | "high";
  linkType?: string | null;
  linkId?: string | null;
  linkLabel?: string | null;
  checklistId?: string | null;
  checklistGroup?: string | null;
};

/**
 * The shared task engine. Any workspace creates tasks here (follow-ups, onboarding steps,
 * hiring steps). Tasks point at the original record instead of copying it, and the
 * assignee gets a notification.
 */
export async function createTask(t: NewTask, tx: Tx = db) {
  const [row] = await tx.insert(tasks).values({
    orgId: t.orgId,
    title: t.title,
    description: t.description ?? null,
    workspace: t.workspace,
    assigneeUserId: t.assigneeUserId ?? null,
    createdBy: t.createdBy ?? null,
    dueAt: t.dueAt ?? null,
    priority: t.priority ?? "medium",
    linkType: t.linkType ?? null,
    linkId: t.linkId ?? null,
    linkLabel: t.linkLabel ?? null,
    checklistId: t.checklistId ?? null,
    checklistGroup: t.checklistGroup ?? null,
  }).returning();
  if (t.assigneeUserId && t.assigneeUserId !== t.createdBy) {
    await notify(t.orgId, t.assigneeUserId, `New task: ${t.title}`, t.linkLabel ?? undefined, `/me/tasks?task=${row!.id}`, tx);
  }
  return row!;
}

/** Finds an active admin to receive tasks that are meant for "HR" when no HR person is set. */
async function fallbackAssignee(orgId: string, tx: Tx): Promise<string | null> {
  const [m] = await tx.select().from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin"), eq(memberships.status, "active"), isNull(memberships.deletedAt)))
    .limit(1);
  return m?.userId ?? null;
}

/**
 * Starts an onboarding/offboarding checklist for an employee from a template.
 * Tasks are assigned by role: "manager" → the employee's manager (if they use WindVeal),
 * "employee" → the employee, otherwise HR/admin. Due dates are relative to `anchorDate`.
 */
export async function startChecklist(opts: {
  orgId: string; employeeId: string; templateId?: string | null; kind: "onboarding" | "offboarding";
  anchorDate: string; createdBy: string; tx?: Tx;
}) {
  const tx = opts.tx ?? db;
  const [emp] = await tx.select().from(employees).where(eq(employees.id, opts.employeeId)).limit(1);
  if (!emp) return null;
  let template = opts.templateId
    ? (await tx.select().from(taskTemplates).where(eq(taskTemplates.id, opts.templateId)).limit(1))[0]
    : (await tx.select().from(taskTemplates)
        .where(and(eq(taskTemplates.orgId, opts.orgId), eq(taskTemplates.kind, opts.kind), isNull(taskTemplates.deletedAt))).limit(1))[0];
  if (!template) return null;
  const [cl] = await tx.insert(checklists).values({
    orgId: opts.orgId, employeeId: emp.id, kind: opts.kind, templateId: template.id,
    title: `${emp.firstName} ${emp.lastName}'s ${opts.kind}`,
  }).returning();
  let managerUserId: string | null = null;
  if (emp.managerId) {
    const [mgr] = await tx.select().from(employees).where(eq(employees.id, emp.managerId)).limit(1);
    managerUserId = mgr?.userId ?? null;
  }
  const hr = await fallbackAssignee(opts.orgId, tx);
  const anchor = new Date(`${opts.anchorDate}T09:00:00`);
  for (const item of template.items) {
    const due = new Date(anchor.getTime() + item.offsetDays * 86_400_000);
    const assignee =
      item.assigneeRole === "manager" ? managerUserId ?? hr
      : item.assigneeRole === "employee" ? emp.userId ?? hr
      : item.assigneeRole === "creator" ? opts.createdBy
      : hr;
    await createTask({
      orgId: opts.orgId, title: item.title, workspace: "people", assigneeUserId: assignee, createdBy: opts.createdBy,
      dueAt: due, linkType: "employee", linkId: emp.id, linkLabel: `${emp.firstName} ${emp.lastName} · ${opts.kind}`,
      checklistId: cl!.id, checklistGroup: item.group ?? null,
    }, tx);
  }
  await tx.update(taskTemplates).set({ timesUsed: template.timesUsed + 1 }).where(eq(taskTemplates.id, template.id));
  return cl!;
}
