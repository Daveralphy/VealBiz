import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { memberships, users } from "../db/schema";
import { requireUser, type AuthState } from "./context";
import { forbidden } from "./http";
import { notify } from "./audit";
import { sendMail } from "./mailer";
import { env } from "../env";

/** WindVeal staff only (users.platformAdmin): the WindVeal admin panel. */
export function requirePlatformAdmin(req: FastifyRequest): AuthState {
  const auth = requireUser(req);
  if (!auth.user.platformAdmin) throw forbidden("Only WindVeal admins can do that.");
  return auth;
}

/** Tells every WindVeal admin about something to review (in-app notification and email). */
export async function notifyPlatformAdmins(title: string, body: string, path: string) {
  const admins = await db.select({ u: users, m: memberships }).from(users)
    .leftJoin(memberships, and(eq(memberships.userId, users.id), isNull(memberships.deletedAt)))
    .where(eq(users.platformAdmin, true));
  for (const { u, m } of admins) {
    if (m) await notify(m.orgId, u.id, title, body, path);
    await sendMail({ to: u.email, subject: title, text: `${body}\n\nReview it: ${env.appUrl}${path}`, link: `${env.appUrl}${path}` });
  }
}
