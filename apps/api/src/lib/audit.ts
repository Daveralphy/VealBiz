import { db, type Tx } from "../db/client";
import { eq } from "drizzle-orm";
import { notificationKind } from "@windveal/shared";
import { auditEvents, notifications, users } from "../db/schema";
import type { OrgContext } from "./context";

type AuditInput = {
  action: string;
  summary: string;
  category?: "access" | "data" | "sync" | "settings" | "general";
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
};

/**
 * Only changes that matter are kept: who can do what, the business's settings and WindVeal review, pay,
 * data leaving or coming in (imports can be undone), attendance corrections and people leaving.
 * Everyday adding, editing and deleting isn't recorded.
 */
export const KEPT_ACTIONS = String.raw`^(member\.|role\.|user\.|auth\.email_changed$|org\.(created|details_updated|plan_|verification_|account_|primary_admin)|pay\.|import\.|approval_rule\.|leave_type\.|attendance\.corrected$|employee\.(deleted|left|leaving)$|file\.version_restored$)|\.exported$|_stages_updated$`;
const KEPT = new RegExp(KEPT_ACTIONS);
export const worthKeeping = (action: string) => KEPT.test(action);

/** Records an immutable audit event, if it's one worth keeping. Audit history cannot be edited or deleted. */
export async function audit(ctx: Pick<OrgContext, "org" | "user" | "deviceLabel">, input: AuditInput, tx: Tx = db) {
  if (!worthKeeping(input.action)) return;
  await tx.insert(auditEvents).values({
    orgId: ctx.org.id,
    actorUserId: ctx.user.id,
    action: input.action,
    category: input.category ?? "general",
    entityType: input.entityType,
    entityId: input.entityId,
    summary: input.summary,
    meta: input.meta ?? {},
    deviceLabel: ctx.deviceLabel,
  });
}

/** Sends an in-app notification, unless the person has turned that kind off. */
export async function notify(orgId: string, userId: string, title: string, body?: string, link?: string, tx: Tx = db) {
  const kind = notificationKind(link);
  const [u] = await tx.select({ prefs: users.notificationPrefs }).from(users).where(eq(users.id, userId)).limit(1);
  if (u?.prefs?.off?.includes(kind)) return;
  await tx.insert(notifications).values({ orgId, userId, title, body, link, kind });
}
