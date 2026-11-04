import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { organisations } from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { recentMail } from "../../lib/mailer";
import { env } from "../../env";

/** Development-only helpers. Never registered in production. */
export default async function devRoutes(app: FastifyInstance) {
  if (env.isProd) return;

  app.get<{ Querystring: { to?: string } }>("/api/dev/mailbox", async (req) => ({ items: recentMail(req.query.to) }));

  /** Stand-in for WindVeal's own verification review, so the careers page can be tested. */
  app.post<{ Body: { status?: "verified" | "pending" | "rejected" } }>("/api/dev/verify-org", async (req) => {
    const ctx = await requireOrg(req, { beforeApproval: true });
    const status = req.body?.status ?? "verified";
    await db.update(organisations).set({ verificationStatus: status }).where(eq(organisations.id, ctx.org.id));
    return { ok: true, status };
  });
}
