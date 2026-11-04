import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { REVIEW_REQUEST_KEYS, type ReviewRequest } from "@windveal/shared";
import { db } from "../../db/client";
import { files, organisations, users } from "../../db/schema";
import { requireAdmin, requireOrg } from "../../lib/context";
import { badRequest, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { notifyPlatformAdmins } from "../../lib/platform";
import { listOf, orgName, requestLabel, tellBusinessAdmins } from "../../lib/review";
import { fileView } from "../files/routes";
import { orgView } from "./routes";

const PRE = { beforeApproval: true };

/**
 * The business side of WindVeal's review: what it shows while the business waits, sending it for review
 * at the end of setup, and replying when WindVeal asks for more.
 */
export default async function reviewRoutes(app: FastifyInstance) {
  /** Everything the review screen shows. */
  app.get("/api/org/review", async (req) => {
    const ctx = await requireOrg(req, PRE);
    const o = ctx.org;
    const [creator] = await db.select({ createdAt: users.createdAt, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, o.createdBy)).limit(1);
    const ids = o.verificationDocumentIds;
    const docs = ids.length ? await db.select().from(files).where(and(inArray(files.id, ids), isNull(files.deletedAt))) : [];
    return {
      org: orgView(o),
      status: o.verificationStatus,
      submittedAt: o.verificationSubmittedAt,
      decidedAt: o.verificationReviewedAt,
      note: o.verificationNote,
      request: o.verificationRequest,
      createdAt: creator?.createdAt ?? o.createdAt,
      emailVerifiedAt: creator?.emailVerifiedAt ?? null,
      documents: docs.map((f) => ({ ...fileView(f), proof: o.verificationDocumentKinds[f.id] ?? "other" })),
      canAct: ctx.membership.role === "admin",
    };
  });

  /** End of setup: the business sends what it has to WindVeal. */
  app.post("/api/org/submit-review", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const o = ctx.org;
    if (o.verificationSubmittedAt) return { org: orgView(o) };
    const hasCertificate = o.verificationDocumentIds.some((id) => o.verificationDocumentKinds[id] === "certificate");
    if (!hasCertificate) throw badRequest("Upload your certificate of incorporation first.", { certificate: "Required" });
    const [u] = await db.update(organisations).set({ verificationSubmittedAt: new Date(), setupStep: "done" })
      .where(eq(organisations.id, o.id)).returning();
    await audit(ctx, { action: "org.verification_submitted", category: "settings", entityType: "organisation", entityId: o.id, summary: `${ctx.user.name} sent ${u!.legalName} for review` });
    await tellBusinessAdmins(u!, `We're reviewing ${orgName(u!)}`,
      "thanks, your email is verified. WindVeal checks every business before it goes live; this usually takes one working day. We'll email you as soon as it's done.");
    await notifyPlatformAdmins(`New business to review: ${orgName(u!)}`,
      `${ctx.user.name} (${ctx.user.email}) registered ${u!.legalName}${u!.registrationNumber ? `, ${u!.registrationNumber}` : ""}, ${u!.country}. ${u!.verificationDocumentIds.length} document${u!.verificationDocumentIds.length === 1 ? "" : "s"} attached.`,
      `/admin/organisations/${u!.id}`);
    return { org: orgView(u!) };
  });

  /** Ticks off a requested item that isn't a file: a corrected detail, or a note in reply. */
  app.post("/api/org/review/item", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const input = parse(z.object({ key: z.enum(REVIEW_REQUEST_KEYS as [string, ...string[]]), note: z.string().trim().max(1000).optional() }), req.body);
    const r = ctx.org.verificationRequest;
    if (ctx.org.verificationStatus !== "needs_info" || !r) throw badRequest("WindVeal hasn't asked for anything.");
    const item = r.items.find((i) => i.key === input.key);
    if (!item) throw notFound("That request");
    const next: ReviewRequest = { ...r, items: r.items.map((i) => i.key === input.key ? { ...i, doneAt: new Date().toISOString(), note: input.note || i.note || null } : i) };
    const [o] = await db.update(organisations).set({ verificationRequest: next }).where(eq(organisations.id, ctx.org.id)).returning();
    return { org: orgView(o!), request: next };
  });

  /** Sends the requested items back to WindVeal; the business goes back into the review queue. */
  app.post("/api/org/review/submit", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const r = ctx.org.verificationRequest;
    if (ctx.org.verificationStatus !== "needs_info" || !r) throw badRequest("There's nothing to send right now.");
    const open = r.items.filter((i) => !i.doneAt);
    if (open.length) throw badRequest(`Finish ${listOf(open.map((i) => requestLabel(i).toLowerCase()))} first.`);
    const [o] = await db.update(organisations).set({ verificationStatus: "pending", verificationSubmittedAt: new Date() })
      .where(eq(organisations.id, ctx.org.id)).returning();
    const files = r.items.reduce((n, i) => n + (i.fileIds?.length ?? 0), 0);
    const what = [...r.items.filter((i) => i.key === "registration_number").map(() => "checked the registration number"),
      ...(files ? [`uploaded ${files} file${files === 1 ? "" : "s"}`] : []),
      ...(r.items.some((i) => i.note) ? ["added a note"] : [])];
    await audit(ctx, {
      action: "org.verification_resubmitted", category: "settings", entityType: "organisation", entityId: o!.id,
      summary: `${ctx.user.name} sent more for review`, meta: { request: r, what },
    });
    await notifyPlatformAdmins(`${orgName(o!)} sent more for review`,
      `They ${listOf(what) || "replied"} in reply to your request.`, `/admin/organisations/${o!.id}`);
    return { org: orgView(o!) };
  });
}
