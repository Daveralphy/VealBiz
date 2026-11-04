import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import {
  REVIEW_REQUEST_KEYS, VERIFICATION_DOC_KINDS, orgBrandingInput, orgDetailsInput, orgPlanInput, orgRoleInput, slugify,
  type ReviewRequestKey, type VerificationDocKind,
} from "@windveal/shared";
import { db } from "../../db/client";
import { files, memberships, organisations, users } from "../../db/schema";
import { requireAdmin, requireOrg, requireUser } from "../../lib/context";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { sendMail } from "../../lib/mailer";
import { mePayload } from "../auth/routes";
import { seedOrgDefaults } from "./defaults";
import { currencyForCountry } from "../../lib/pricing";
import { notifyPlatformAdmins } from "../../lib/platform";
import { fileView } from "../files/routes";

export function orgView(o: typeof organisations.$inferSelect) {
  return {
    id: o.id, slug: o.slug, legalName: o.legalName, tradingName: o.tradingName, name: o.tradingName || o.legalName,
    industry: o.industry, teamSize: o.teamSize, country: o.country, currency: o.currency, city: o.city, address: o.address,
    registrationNumber: o.registrationNumber, website: o.website, verificationStatus: o.verificationStatus, verificationNote: o.verificationNote,
    verificationDocumentIds: o.verificationDocumentIds, verificationReviewedAt: o.verificationReviewedAt,
    verificationSubmittedAt: o.verificationSubmittedAt, verificationDocumentKinds: o.verificationDocumentKinds,
    accountStatus: o.accountStatus, accountStatusReason: o.accountStatusReason, accountStatusAt: o.accountStatusAt,
    ownerName: o.ownerName, ownerEmail: o.ownerEmail, brandColor: o.brandColor, tagline: o.tagline, about: o.about,
    logoFileId: o.logoFileId, coverFileId: o.coverFileId, plan: o.plan, billing: o.billing, settings: o.settings,
    setupStep: o.setupStep, createdAt: o.createdAt,
  };
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "organisation";
  for (let i = 0; i < 50; i++) {
    const s = i === 0 ? root : `${root}-${i + 1}`;
    const [hit] = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.slug, s)).limit(1);
    if (!hit) return s;
  }
  return `${root}-${Date.now()}`;
}

/** Everything here works while WindVeal reviews the business: setup, its details and its documents. */
const PRE = { beforeApproval: true };

export default async function orgRoutes(app: FastifyInstance) {
  /** Step 3 of setup: creates the organisation; the creator becomes its primary admin. */
  app.post("/api/org", async (req) => {
    const auth = requireUser(req);
    const input = parse(orgDetailsInput, req.body);
    const [existing] = await db.select().from(memberships).where(and(eq(memberships.userId, auth.user.id), isNull(memberships.deletedAt))).limit(1);
    if (existing) throw conflict("You already belong to an organisation.");
    // Possible duplicate business: same registration number, or same legal name in the same country.
    if (input.registrationNumber) {
      const [dup] = await db.select({ id: organisations.id }).from(organisations)
        .where(and(eq(organisations.country, input.country), dsql`lower(${organisations.registrationNumber}) = lower(${input.registrationNumber})`)).limit(1);
      if (dup) throw conflict("A business with this registration number is already on WindVeal. Ask its admin to invite you, or contact support.",
        { registrationNumber: "Already registered" });
    }
    const currency = currencyForCountry(input.country);
    if (!currency) throw badRequest("WindVeal isn't available in that country yet.", { country: "Choose a supported country" });
    const slug = await uniqueSlug(input.tradingName || input.legalName);
    const org = await db.transaction(async (tx) => {
      const stages = await (async () => {
        const [o] = await tx.insert(organisations).values({
          slug, legalName: input.legalName, tradingName: input.tradingName || null, industry: input.industry, teamSize: input.teamSize,
          country: input.country, currency, city: input.city, address: input.address,
          registrationNumber: input.registrationNumber || null, website: input.website || null, createdBy: auth.user.id, setupStep: "role",
        }).returning();
        await tx.insert(memberships).values({ orgId: o!.id, userId: auth.user.id, role: "admin", isPrimaryAdmin: true });
        const s = await seedOrgDefaults(tx, o!.id, auth.user.id);
        const [o2] = await tx.update(organisations).set({ settings: { leadStages: s.leadStages, dealStages: s.dealStages } })
          .where(eq(organisations.id, o!.id)).returning();
        return o2!;
      })();
      await audit({ org: stages, user: auth.user, deviceLabel: auth.deviceLabel }, {
        action: "org.created", category: "settings", entityType: "organisation", entityId: stages.id,
        summary: `${auth.user.name} registered ${stages.legalName}`,
      }, tx);
      return stages;
    });
    // WindVeal's reviewers hear about it once setup is finished and it's sent for review (see review.ts).
    return { org: orgView(org) };
  });

  app.get("/api/org", async (req) => {
    const ctx = await requireOrg(req, PRE);
    return { org: orgView(ctx.org) };
  });

  /** Edit business details (Settings → Organisation). Country/currency are fixed after setup. */
  app.patch("/api/org/details", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const input = parse(orgDetailsInput.omit({ country: true }).partial(), req.body);
    const [o] = await db.update(organisations).set({
      ...input, tradingName: input.tradingName === "" ? null : input.tradingName,
      registrationNumber: input.registrationNumber === "" ? null : input.registrationNumber,
      website: input.website === "" ? null : input.website, version: dsql`${organisations.version} + 1`,
    }).where(eq(organisations.id, ctx.org.id)).returning();
    await audit(ctx, { action: "org.details_updated", category: "settings", summary: `${ctx.user.name} updated the business details`, meta: { fields: Object.keys(input) } });
    const numberChanged = input.registrationNumber !== undefined && (input.registrationNumber || null) !== ctx.org.registrationNumber;
    const keyChanged = (input.legalName !== undefined && input.legalName !== ctx.org.legalName) || numberChanged;
    // A corrected registration number answers WindVeal's request for one.
    const r = o!.verificationRequest;
    if (numberChanged && o!.verificationStatus === "needs_info" && r?.items.some((i) => i.key === "registration_number")) {
      const next = { ...r, items: r.items.map((i) => i.key === "registration_number" ? { ...i, doneAt: new Date().toISOString(), note: `Changed to ${o!.registrationNumber ?? "nothing"}` } : i) };
      await db.update(organisations).set({ verificationRequest: next }).where(eq(organisations.id, o!.id));
      o!.verificationRequest = next;
    }
    // Reviewers only need telling once the business is in the queue or already approved.
    const inQueue = (o!.verificationStatus === "pending" && !!o!.verificationSubmittedAt) || o!.verificationStatus === "verified";
    if (keyChanged && inQueue) {
      await notifyPlatformAdmins(`${o!.legalName} changed its registration details`, `${ctx.user.name} changed the registered name or registration number. You may want to check it again.`, `/admin/organisations/${o!.id}`);
    }
    return { org: orgView(o!) };
  });

  app.post("/api/org/role", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const input = parse(orgRoleInput, req.body);
    const patch = input.relation === "owner"
      ? { ownerName: ctx.user.name, ownerEmail: ctx.user.email }
      : { ownerName: input.ownerName, ownerEmail: input.ownerEmail };
    const [o] = await db.update(organisations).set({ ...patch, setupStep: ctx.org.setupStep === "role" ? "branding" : ctx.org.setupStep })
      .where(eq(organisations.id, ctx.org.id)).returning();
    await db.update(memberships).set({ isOwner: input.relation === "owner", jobTitle: input.jobTitle || null }).where(eq(memberships.id, ctx.membership.id));
    if (input.relation === "representative") {
      await sendMail({
        to: input.ownerEmail, subject: `${ctx.user.name} set up ${o!.legalName} on WindVeal`,
        text: `${ctx.user.name} (${input.jobTitle}) registered ${o!.legalName} on WindVeal and named you as the owner. If this wasn't expected, reply to let us know.`,
      });
    }
    return { org: orgView(o!) };
  });

  app.patch("/api/org/branding", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const input = parse(orgBrandingInput, req.body);
    for (const fid of [input.logoFileId, input.coverFileId]) {
      if (!fid) continue;
      const [f] = await db.select().from(files).where(and(eq(files.id, fid), eq(files.orgId, ctx.org.id))).limit(1);
      if (!f) throw badRequest("That image wasn't found.");
      await db.update(files).set({ isPublic: true }).where(eq(files.id, fid));
    }
    const settings = input.perks ? { ...ctx.org.settings, perks: input.perks } : ctx.org.settings;
    const [o] = await db.update(organisations).set({
      brandColor: input.brandColor ?? ctx.org.brandColor, tagline: input.tagline ?? ctx.org.tagline, about: input.about ?? ctx.org.about,
      logoFileId: input.logoFileId === undefined ? ctx.org.logoFileId : input.logoFileId,
      coverFileId: input.coverFileId === undefined ? ctx.org.coverFileId : input.coverFileId,
      settings, setupStep: ctx.org.setupStep === "branding" ? "plan" : ctx.org.setupStep,
    }).where(eq(organisations.id, ctx.org.id)).returning();
    await audit(ctx, { action: "org.branding_updated", category: "settings", summary: `${ctx.user.name} updated the branding` });
    return { org: orgView(o!) };
  });

  app.post("/api/org/setup-step", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const { step } = parse(z.object({ step: z.enum(["role", "branding", "plan", "documents"]) }), req.body);
    const [o] = await db.update(organisations).set({ setupStep: step }).where(eq(organisations.id, ctx.org.id)).returning();
    return { org: orgView(o!) };
  });

  /** Plan choice. No payment is taken during setup; paid plans are activated after payment details are added. */
  app.post("/api/org/plan", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const input = parse(orgPlanInput, req.body);
    const [o] = await db.update(organisations).set({
      plan: input.plan === "free" ? "free" : ctx.org.plan, billing: input.billing,
      setupStep: ctx.org.setupStep === "plan" ? "documents" : ctx.org.setupStep,
    }).where(eq(organisations.id, ctx.org.id)).returning();
    await audit(ctx, { action: "org.plan_selected", category: "settings", summary: `${ctx.user.name} chose the ${input.plan} plan (${input.billing})` });
    return { org: orgView(o!), paymentRequired: input.plan !== "free" };
  });

  /** Documents sent in for verification (certificate of incorporation, etc.). */
  app.get("/api/org/verification-documents", async (req) => {
    const ctx = await requireOrg(req, PRE);
    const ids = ctx.org.verificationDocumentIds;
    const rows = ids.length ? await db.select().from(files).where(and(inArray(files.id, ids), isNull(files.deletedAt))) : [];
    return rows.map(fileView);
  });

  app.post("/api/org/verification-document", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    const { fileId, proof, item } = parse(z.object({
      fileId: z.string().uuid(),
      proof: z.enum(Object.keys(VERIFICATION_DOC_KINDS) as [VerificationDocKind, ...VerificationDocKind[]]).default("other"),
      /** The WindVeal request this file answers, if any. */
      item: z.enum(REVIEW_REQUEST_KEYS as [ReviewRequestKey, ...ReviewRequestKey[]]).optional(),
    }), req.body);
    const [f] = await db.select().from(files).where(and(eq(files.id, fileId), eq(files.orgId, ctx.org.id), eq(files.uploadedBy, ctx.user.id))).limit(1);
    if (!f) throw notFound("That file");
    if (ctx.org.verificationDocumentIds.length >= 10) throw badRequest("You can send up to 10 documents. Remove one first.");
    const r = ctx.org.verificationRequest;
    const answers = item && ctx.org.verificationStatus === "needs_info" && r?.items.some((i) => i.key === item);
    const [o] = await db.update(organisations).set({
      verificationDocumentIds: Array.from(new Set([...ctx.org.verificationDocumentIds, f.id])),
      verificationDocumentKinds: { ...ctx.org.verificationDocumentKinds, [f.id]: proof ?? "other" },
      ...(answers ? { verificationRequest: { ...r!, items: r!.items.map((i) => i.key === item ? { ...i, fileIds: [...(i.fileIds ?? []), f.id], doneAt: new Date().toISOString() } : i) } } : {}),
    }).where(eq(organisations.id, ctx.org.id)).returning();
    await audit(ctx, { action: "org.verification_document", category: "settings", summary: `${ctx.user.name} sent ${f.name} for verification`, entityType: "file", entityId: f.id });
    if (o!.verificationStatus === "pending" && o!.verificationSubmittedAt) {
      await notifyPlatformAdmins(`${o!.legalName} sent a verification document`, `${ctx.user.name} uploaded ${f.name}.`, `/admin/organisations/${o!.id}`);
    }
    return { org: orgView(o!) };
  });

  app.delete<{ Params: { fileId: string } }>("/api/org/verification-document/:fileId", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    if (!ctx.org.verificationDocumentIds.includes(req.params.fileId)) throw notFound("That document");
    // Removing the only file that answered a request reopens that request.
    const r = ctx.org.verificationRequest;
    const request = r && {
      ...r, items: r.items.map((i) => {
        if (!i.fileIds?.includes(req.params.fileId)) return i;
        const left = i.fileIds.filter((x) => x !== req.params.fileId);
        return { ...i, fileIds: left, doneAt: left.length || i.note ? i.doneAt : null };
      }),
    };
    const [o] = await db.update(organisations).set({
      verificationDocumentIds: ctx.org.verificationDocumentIds.filter((x) => x !== req.params.fileId),
      ...(request ? { verificationRequest: request } : {}),
    }).where(eq(organisations.id, ctx.org.id)).returning();
    await audit(ctx, { action: "org.verification_document_removed", category: "settings", summary: `${ctx.user.name} removed a verification document`, entityType: "file", entityId: req.params.fileId });
    return { org: orgView(o!) };
  });

  app.post("/api/org/transfer-primary-admin", async (req) => {
    const ctx = await requireAdmin(req, PRE);
    if (!ctx.membership.isPrimaryAdmin) throw forbidden("Only the primary admin can transfer this role.");
    const { membershipId } = parse(z.object({ membershipId: z.string().uuid() }), req.body);
    const [target] = await db.select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.org.id), isNull(memberships.deletedAt))).limit(1);
    if (!target || target.m.status !== "active") throw badRequest("Choose an active member.");
    await db.transaction(async (tx) => {
      await tx.update(memberships).set({ isPrimaryAdmin: false }).where(eq(memberships.id, ctx.membership.id));
      await tx.update(memberships).set({ isPrimaryAdmin: true, role: "admin" }).where(eq(memberships.id, target.m.id));
      await audit(ctx, { action: "org.primary_admin_transferred", category: "access", summary: `${ctx.user.name} made ${target.u.name} the primary admin` }, tx);
    });
    return mePayload(ctx.user.id);
  });
}
