import { and, eq, isNull } from "drizzle-orm";
import { REVIEW_REQUESTS, type ReviewRequest } from "@windveal/shared";
import { db } from "../db/client";
import { memberships, organisations, users } from "../db/schema";
import { notify } from "./audit";
import { sendMail } from "./mailer";
import { env } from "../env";

type Org = typeof organisations.$inferSelect;

export const orgName = (o: Org) => o.tradingName || o.legalName;

/** Emails (and notifies) the organisation's admins about its WindVeal review. Links open the app, which shows the review screen. */
export async function tellBusinessAdmins(o: Org, subject: string, body: string) {
  const admins = await db.select({ u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, o.id), eq(memberships.role, "admin"), isNull(memberships.deletedAt)));
  for (const { u } of admins) {
    await notify(o.id, u.id, subject, body, "/");
    await sendMail({ to: u.email, subject, text: `Hi ${u.name.split(" ")[0]}, ${body}`, link: `${env.appUrl}/` });
  }
}

/** The business-facing wording of one requested item. */
export function requestLabel(item: ReviewRequest["items"][number]) {
  return item.key === "other" ? (item.label || REVIEW_REQUESTS.other.need) : REVIEW_REQUESTS[item.key].need;
}

/** "a, b and c" */
export function listOf(parts: string[]) {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
