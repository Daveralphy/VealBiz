import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, isNull, sql as dsql } from "drizzle-orm";
import { hasAccess, type Workspace } from "@windveal/shared";
import { loadPricing, planStorageBytes } from "../../lib/pricing";
import { db } from "../../db/client";
import { employees, fileLinks, fileVersions, files, folders } from "../../db/schema";
import { requireOrg, type OrgContext } from "../../lib/context";
import { AppError, badRequest, forbidden, notFound } from "../../lib/http";
import { MAX_UPLOAD_BYTES, checkFileType, putObject, readObject } from "../../lib/storage";
import { audit } from "../../lib/audit";

export async function storageUsed(orgId: string): Promise<number> {
  const [r] = await db.select({ n: dsql<number>`coalesce(sum(${files.size}),0)::bigint` }).from(files)
    .where(and(eq(files.orgId, orgId), isNull(files.deletedAt)));
  return Number(r?.n ?? 0);
}

const LINK_WORKSPACE: Record<string, Workspace> = {
  employee: "people", application: "recruitment", job: "recruitment",
  company: "crm", deal: "crm", lead: "crm", task: "workflows",
};

/**
 * Can this member see / attach files on a record? Employee files are sensitive: only People & HR
 * editors or the employee themself. Other records follow the workspace they belong to.
 */
export async function canAccessLinkTarget(ctx: OrgContext, linkType: string, linkId: string, level: "view" | "edit"): Promise<boolean> {
  if (ctx.membership.role === "admin") return true;
  const ws = LINK_WORKSPACE[linkType];
  if (!ws) return false;
  if (linkType === "employee") {
    if (hasAccess(ctx.access.people, "edit")) return true;
    const [e] = await db.select({ userId: employees.userId }).from(employees).where(and(eq(employees.id, linkId), eq(employees.orgId, ctx.org.id))).limit(1);
    return e?.userId === ctx.user.id;
  }
  return hasAccess(ctx.access[ws], level);
}

/** Can this member open a file? Restricted folders limit access to listed roles; admins see everything. */
export async function canReadFile(ctx: OrgContext, f: typeof files.$inferSelect): Promise<boolean> {
  if (f.orgId !== ctx.org.id) return false;
  if (ctx.membership.role === "admin") return true;
  if (f.kind === "system") {
    // Attachments are protected by the record(s) they're linked to.
    if (f.isPublic || f.uploadedBy === ctx.user.id) return true;
    const links = await db.select().from(fileLinks).where(eq(fileLinks.fileId, f.id));
    for (const l of links) if (await canAccessLinkTarget(ctx, l.linkType, l.linkId, "view")) return true;
    return false;
  }
  if (!hasAccess(ctx.access.documents, "view")) return false;
  return folderVisible(ctx, f.folderId);
}

/** A folder is visible only if it and every folder above it allow this member's role. */
export async function folderVisible(ctx: OrgContext, folderId: string | null): Promise<boolean> {
  if (ctx.membership.role === "admin") return true;
  let id = folderId;
  for (let depth = 0; id && depth < 50; depth++) {
    const [folder] = await db.select().from(folders).where(and(eq(folders.id, id), eq(folders.orgId, ctx.org.id))).limit(1);
    if (!folder) return false;
    if (folder.restricted && !folder.accessRoles.includes(ctx.membership.role)) return false;
    id = folder.parentId;
  }
  return true;
}

type UploadQuery = { folderId?: string; kind?: "document" | "system"; linkType?: string; linkId?: string; category?: string; allowDuplicate?: string; replaceFileId?: string };

/** Shared upload handler: validation (type, size, plan storage), duplicate detection, versioning. */
export async function handleUpload(req: FastifyRequest<{ Querystring: UploadQuery }>, ctx: OrgContext) {
  const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
  if (!part) throw badRequest("Choose a file to upload.");
  const typeError = checkFileType(part.filename, part.mimetype);
  if (typeError) throw new AppError(415, "file_type", typeError);
  const buf = await part.toBuffer().catch(() => null);
  if (!buf || part.file.truncated) throw new AppError(413, "file_too_large", `Too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  if (buf.length === 0) throw badRequest("That file is empty.");
  const used = await storageUsed(ctx.org.id);
  if (used + buf.length > planStorageBytes(ctx.org.plan)) {
    throw new AppError(413, "storage_full", "Your organisation has run out of storage. Upgrade your plan for more space.");
  }
  const q = req.query;
  const kind = q.kind ?? "document";
  if (q.linkType || q.linkId) {
    if (!q.linkType || !q.linkId || !(await canAccessLinkTarget(ctx, q.linkType, q.linkId, "edit"))) {
      throw forbidden("You can't attach files to that record.");
    }
  }
  if (q.folderId) {
    const [folder] = await db.select().from(folders).where(and(eq(folders.id, q.folderId), eq(folders.orgId, ctx.org.id), isNull(folders.deletedAt))).limit(1);
    if (!folder) throw notFound("That folder");
    if (!(await folderVisible(ctx, folder.id))) throw forbidden();
  }
  const stored = await putObject(ctx.org.id, buf);

  // New version of an existing file.
  if (q.replaceFileId) {
    const [f] = await db.select().from(files).where(and(eq(files.id, q.replaceFileId), eq(files.orgId, ctx.org.id))).limit(1);
    if (!f) throw notFound("That file");
    const v = f.currentVersion + 1;
    await db.insert(fileVersions).values({ fileId: f.id, version: v, storageKey: stored.key, size: stored.size, uploadedBy: ctx.user.id });
    const [u] = await db.update(files).set({ storageKey: stored.key, size: stored.size, sha256: stored.sha256, currentVersion: v, mime: part.mimetype })
      .where(eq(files.id, f.id)).returning();
    await audit(ctx, { action: "file.new_version", category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} uploaded version ${v} of ${f.name}` });
    return { file: u!, duplicateOf: null };
  }

  if (q.allowDuplicate !== "1" && kind === "document") {
    const [dup] = await db.select().from(files)
      .where(and(eq(files.orgId, ctx.org.id), eq(files.sha256, stored.sha256), isNull(files.deletedAt), isNull(files.archivedAt))).limit(1);
    // Only reveal the duplicate if this member could open it anyway.
    if (dup && (await canReadFile(ctx, dup))) return { file: null, duplicateOf: { id: dup.id, name: dup.name, folderId: dup.folderId } };
  }

  const [f] = await db.insert(files).values({
    orgId: ctx.org.id, folderId: q.folderId ?? null, name: part.filename, mime: part.mimetype, size: stored.size, storageKey: stored.key,
    sha256: stored.sha256, kind, category: q.category ?? null, uploadedBy: ctx.user.id,
  }).returning();
  await db.insert(fileVersions).values({ fileId: f!.id, version: 1, storageKey: stored.key, size: stored.size, uploadedBy: ctx.user.id });
  if (q.linkType && q.linkId) {
    await db.insert(fileLinks).values({ orgId: ctx.org.id, fileId: f!.id, linkType: q.linkType, linkId: q.linkId });
  }
  if (kind === "document") {
    await audit(ctx, { action: "file.uploaded", category: "data", entityType: "file", entityId: f!.id, summary: `${ctx.user.name} uploaded ${f!.name}` });
  }
  return { file: f!, duplicateOf: null };
}

export function fileView(f: typeof files.$inferSelect) {
  return {
    id: f.id, name: f.name, mime: f.mime, size: f.size, folderId: f.folderId, category: f.category, tags: f.tags, expiresOn: f.expiresOn,
    currentVersion: f.currentVersion, kind: f.kind, uploadedBy: f.uploadedBy, createdAt: f.createdAt, updatedAt: f.updatedAt, archivedAt: f.archivedAt,
  };
}

export default async function fileRoutes(app: FastifyInstance) {
  app.post<{ Querystring: UploadQuery }>("/api/files", async (req) => {
    // Branding and verification files are needed while WindVeal reviews the business; Documents waits for approval.
    const ctx = await requireOrg(req, { beforeApproval: (req.query.kind ?? "document") !== "document" });
    if ((req.query.kind ?? "document") === "document" && !hasAccess(ctx.access.documents, "edit")) throw forbidden("You can't upload to Documents.");
    const r = await handleUpload(req, ctx);
    return { file: r.file ? fileView(r.file) : null, duplicateOf: r.duplicateOf };
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/files/:id/content", async (req, reply) => {
    const ctx = await requireOrg(req, { beforeApproval: true });
    const [f] = await db.select().from(files).where(and(eq(files.id, req.params.id), isNull(files.deletedAt))).limit(1);
    if (!f || !(await canReadFile(ctx, f))) throw notFound("That file");
    reply.header("Content-Type", f.mime || "application/octet-stream");
    reply.header("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${encodeURIComponent(f.name)}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(readObject(f.storageKey));
  });

  /** Public images (organisation logo/cover for the careers page). */
  app.get<{ Params: { id: string } }>("/api/public/files/:id", async (req, reply) => {
    const [f] = await db.select().from(files).where(and(eq(files.id, req.params.id), eq(files.isPublic, true), isNull(files.deletedAt))).limit(1);
    if (!f || !f.mime.startsWith("image/")) throw notFound("That file");
    reply.header("Content-Type", f.mime);
    reply.header("Cache-Control", "public, max-age=300");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(readObject(f.storageKey));
  });

  /** Public pricing (plans, prices per currency, supported countries) from data/pricing.json. */
  app.get("/api/public/pricing", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=60");
    return loadPricing();
  });

  app.get("/api/storage", async (req) => {
    const ctx = await requireOrg(req);
    return { used: await storageUsed(ctx.org.id), limit: planStorageBytes(ctx.org.plan) };
  });
}
