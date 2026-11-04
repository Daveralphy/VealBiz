import { and, count, eq, isNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/client";
import { employees, employmentHistory, users } from "../db/schema";
import { localDate } from "../modules/people/util";

/**
 * Everyone in a business is on its team in People & HR, whatever their role, so they can clock in, ask for
 * leave and be given work without HR adding them first. Links the person to an existing record with their
 * email if there is one; otherwise creates one. A record HR deliberately deleted isn't brought back.
 */
export async function ensureTeamRecord(orgId: string, userId: string, jobTitle?: string | null): Promise<void> {
  const [ever] = await db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.orgId, orgId), eq(employees.userId, userId))).limit(1);
  if (ever) return;
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return;
  // Already on the team under their email (added by HR, hired from Recruitment or imported): link it.
  const [byEmail] = await db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.orgId, orgId), isNull(employees.userId), isNull(employees.deletedAt), dsql`lower(${employees.email}) = lower(${u.email})`)).limit(1);
  if (byEmail) {
    await db.update(employees).set({ userId }).where(eq(employees.id, byEmail.id));
    return;
  }
  const [first, ...rest] = u.name.trim().split(/\s+/);
  const [n] = await db.select({ n: count() }).from(employees).where(eq(employees.orgId, orgId));
  const today = localDate();
  const [e] = await db.insert(employees).values({
    orgId, userId, firstName: first || u.name, lastName: rest.join(" "), email: u.email, phone: u.phone,
    jobTitle: jobTitle || null, startDate: today, status: "active", employeeCode: `EMP-${String((n?.n ?? 0) + 1).padStart(4, "0")}`,
  }).returning();
  await db.insert(employmentHistory).values({ orgId, employeeId: e!.id, occurredOn: today, actorUserId: userId, event: jobTitle ? `Joined as ${jobTitle}` : "Joined" });
}
