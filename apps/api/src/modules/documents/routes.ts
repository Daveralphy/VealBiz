import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql as dsql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_ACCESS, hasAccess, type AccessLevel } from "@windveal/shared";
import { createHash } from "node:crypto";
import { db } from "../../db/client";
import { fileLinks, fileVersions, files, folders, users } from "../../db/schema";
import { requireAccess, type OrgContext } from "../../lib/context";
import { badRequest, conflict, forbidden, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { readObjectBuffer } from "../../lib/storage";
import { fileView } from "../files/routes";
import { localDate } from "../people/util";
import { LINK_TYPES, resolveTarget, resolveTargets, searchTargets } from "./targets";

const P = "/api/documents";
const DAY = 86_400_000;
type Folder = typeof folders.$inferSelect;
type FileRow = typeof files.$inferSelect;

const ROLE_LABEL: Record<string, string> = { admin: "Admins", manager: "Managers", member: "Members" };
const isUuid = (s: unknown) => z.string().uuid().safeParse(s).success;

function canAccessFolder(ctx: OrgContext, f: Folder) {
  return ctx.membership.role === "admin" || !f.restricted || f.accessRoles.includes(ctx.membership.role);
}

/** Loads the organisation's folders and works out which ones this person can see (a folder and all its parents must be open to them). */
async function folderIndex(ctx: OrgContext) {
  const all = await db.select().from(folders).where(and(eq(folders.orgId, ctx.org.id), isNull(folders.deletedAt))).orderBy(asc(folders.name));
  const byId = new Map(all.map((f) => [f.id, f]));
  const visible = new Set<string>();
  for (const f of all) {
    let cur: Folder | undefined = f;
    let ok = true;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur.id) || !canAccessFolder(ctx, cur)) { ok = false; break; }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    if (ok) visible.add(f.id);
  }
  const path = (id: string | null) => {
    const out: { id: string; name: string }[] = [];
    let cur = id ? byId.get(id) : undefined;
    while (cur && out.length < 20) { out.unshift({ id: cur.id, name: cur.name }); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  };
  return { all, byId, visible, path };
}

/** Files that belong in the library and that this person may see. */
function libraryCond(ctx: OrgContext, visible: Set<string>): SQL {
  const ids = Array.from(visible);
  const inVisible = ids.length ? inArray(files.folderId, ids) : dsql`false`;
  return and(
    eq(files.orgId, ctx.org.id), isNull(files.deletedAt),
    or(and(eq(files.kind, "document"), or(isNull(files.folderId), inVisible)), and(eq(files.kind, "system"), inVisible)),
  )!;
}

function accessLabel(folder: Folder | undefined) {
  if (!folder?.restricted) return { label: "Everyone", restricted: false };
  const roles = Array.from(new Set(["admin", ...folder.accessRoles]));
  return { label: roles.length === 1 ? "Admins only" : roles.map((r) => ROLE_LABEL[r] ?? r).join(", "), restricted: true };
}

const TYPE_PATTERNS: Record<string, string> = {
  pdf: "\\.pdf$", doc: "\\.(docx?|txt|pptx?|rtf|odt)$", xls: "\\.(xlsx?|csv|ods)$", img: "\\.(png|jpe?g|gif|webp)$",
};

async function loadFile(ctx: OrgContext, id: string, idx: Awaited<ReturnType<typeof folderIndex>>) {
  if (!isUuid(id)) throw notFound("That file");
  const [f] = await db.select().from(files).where(and(eq(files.id, id), libraryCond(ctx, idx.visible))).limit(1);
  if (!f) throw notFound("That file");
  return f;
}

async function listViews(ctx: OrgContext, rows: FileRow[], idx: Awaited<ReturnType<typeof folderIndex>>) {
  if (!rows.length) return [];
  const ids = rows.map((f) => f.id);
  const links = await db.select().from(fileLinks).where(and(eq(fileLinks.orgId, ctx.org.id), inArray(fileLinks.fileId, ids)));
  const [targets, names] = await Promise.all([
    resolveTargets(ctx.org.id, links),
    db.select({ id: users.id, name: users.name }).from(users)
      .where(inArray(users.id, Array.from(new Set(rows.map((r) => r.uploadedBy).filter((x): x is string => !!x))).concat(["00000000-0000-0000-0000-000000000000"]))),
  ]);
  const nm = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((f) => {
    const mine = links.filter((l) => l.fileId === f.id).map((l) => targets.get(`${l.linkType}:${l.linkId}`)).filter(Boolean);
    const folder = f.folderId ? idx.byId.get(f.folderId) : undefined;
    return {
      ...fileView(f),
      uploaderName: f.uploadedBy ? nm.get(f.uploadedBy) ?? "Unknown" : "Unknown",
      folderName: folder?.name ?? null,
      linkedTo: mine[0] ? { type: mine[0].type, id: mine[0].id, label: mine[0].label } : null,
      linkCount: mine.length,
      access: accessLabel(folder),
    };
  });
}

function levelFor(ctx: OrgContext, role: "manager" | "member"): AccessLevel {
  return (ctx.org.settings.roleAccess?.[role]?.documents ?? DEFAULT_ACCESS[role].documents) as AccessLevel;
}
const LEVEL_TEXT: Record<AccessLevel, string> = { none: "No access", view: "Can view", edit: "Can edit", manage: "Can manage" };

const folderInput = z.object({ name: z.string().trim().min(1, "Give the folder a name.").max(80), parentId: z.string().uuid().nullable().optional() });
const folderPatch = z.object({
  name: z.string().trim().min(1, "Give the folder a name.").max(80).optional(),
  parentId: z.string().uuid().nullable().optional(),
  restricted: z.boolean().optional(),
  accessRoles: z.array(z.enum(["admin", "manager", "member"])).max(3).optional(),
});
const filePatch = z.object({
  name: z.string().trim().min(1, "Give the file a name.").max(200).optional(),
  folderId: z.string().uuid().nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date.").nullable().optional(),
});

export default async function documentsRoutes(app: FastifyInstance) {
  // ----- summary + folders -----
  app.get(`${P}/summary`, async (req) => {
    const ctx = await requireAccess(req, "documents", "view");
    const idx = await folderIndex(ctx);
    const [r] = await db.select({
      files: dsql<number>`count(*) filter (where ${files.archivedAt} is null)::int`,
      archived: dsql<number>`count(*) filter (where ${files.archivedAt} is not null)::int`,
    }).from(files).where(libraryCond(ctx, idx.visible));
    return { files: r?.files ?? 0, archived: r?.archived ?? 0 };
  });

  /** Numbers for the Documents dashboard: files added this week and the next ones to expire. */
  app.get(`${P}/dashboard`, async (req) => {
    const ctx = await requireAccess(req, "documents", "view");
    const idx = await folderIndex(ctx);
    const live = and(libraryCond(ctx, idx.visible), isNull(files.archivedAt))!;
    const today = localDate();
    const in30 = localDate(new Date(Date.now() + 30 * DAY));
    const soon = and(live, isNotNull(files.expiresOn), gte(files.expiresOn, today), lte(files.expiresOn, in30))!;
    const [[counts], expiring] = await Promise.all([
      db.select({
        added: dsql<number>`count(*) filter (where ${files.createdAt} >= ${new Date(Date.now() - 7 * DAY).toISOString()}::timestamptz)::int`,
        expiring: dsql<number>`count(*) filter (where ${files.expiresOn} >= ${today} and ${files.expiresOn} <= ${in30})::int`,
      }).from(files).where(live),
      db.select().from(files).where(soon).orderBy(asc(files.expiresOn), asc(files.name)).limit(5),
    ]);
    return { addedThisWeek: counts?.added ?? 0, expiringCount: counts?.expiring ?? 0, expiring: await listViews(ctx, expiring, idx) };
  });

  app.get(`${P}/folders`, async (req) => {
    const ctx = await requireAccess(req, "documents", "view");
    const idx = await folderIndex(ctx);
    const counts = await db.select({ id: files.folderId, n: dsql<number>`count(*)::int` }).from(files)
      .where(and(libraryCond(ctx, idx.visible), isNull(files.archivedAt))).groupBy(files.folderId);
    const cm = new Map(counts.map((c) => [c.id ?? "root", c.n]));
    const vis = idx.all.filter((f) => idx.visible.has(f.id));
    // Total includes files in sub-folders.
    const total = (id: string, depth = 0): number =>
      (cm.get(id) ?? 0) + (depth > 20 ? 0 : vis.filter((c) => c.parentId === id).reduce((s, c) => s + total(c.id, depth + 1), 0));
    return {
      rootFiles: cm.get("root") ?? 0,
      folders: vis.map((f) => ({
        id: f.id, name: f.name, parentId: f.parentId && idx.visible.has(f.parentId) ? f.parentId : null, restricted: f.restricted, accessRoles: f.accessRoles,
        system: f.system, fileCount: cm.get(f.id) ?? 0, totalCount: total(f.id), access: accessLabel(f),
      })),
    };
  });

  app.post(`${P}/folders`, async (req) => {
    const ctx = await requireAccess(req, "documents", "edit");
    const input = parse(folderInput, req.body);
    const idx = await folderIndex(ctx);
    if (input.parentId && !idx.visible.has(input.parentId)) throw badRequest("Some details need fixing.", { parentId: "That folder wasn't found." });
    const clash = idx.all.find((f) => (f.parentId ?? null) === (input.parentId ?? null) && f.name.toLowerCase() === input.name.toLowerCase());
    if (clash) throw conflict("A folder with that name is already here.", { name: "A folder with that name is already here." });
    const parent = input.parentId ? idx.byId.get(input.parentId) : undefined;
    const [f] = await db.insert(folders).values({
      orgId: ctx.org.id, name: input.name, parentId: input.parentId ?? null, createdBy: ctx.user.id,
      // New sub-folders inherit their parent's restriction.
      restricted: parent?.restricted ?? false, accessRoles: parent?.accessRoles ?? [],
    }).returning();
    await audit(ctx, { action: "folder.created", category: "data", entityType: "folder", entityId: f!.id, summary: `${ctx.user.name} created the folder ${f!.name}` });
    return { id: f!.id, name: f!.name, parentId: f!.parentId };
  });

  app.patch<{ Params: { id: string } }>(`${P}/folders/:id`, async (req) => {
    const ctx = await requireAccess(req, "documents", "edit");
    const input = parse(folderPatch, req.body);
    const idx = await folderIndex(ctx);
    const f = isUuid(req.params.id) && idx.visible.has(req.params.id) ? idx.byId.get(req.params.id) : undefined;
    if (!f) throw notFound("That folder");
    if ((input.restricted !== undefined || input.accessRoles !== undefined) && ctx.membership.role !== "admin") throw forbidden("Only admins can change who can see a folder.");
    if (f.system && (input.name !== undefined || input.parentId !== undefined)) throw forbidden("System folders can't be renamed or moved.");
    const set: Partial<typeof folders.$inferInsert> = {};
    const changes: string[] = [];
    if (input.name !== undefined && input.name !== f.name) {
      const clash = idx.all.find((o) => o.id !== f.id && (o.parentId ?? null) === (f.parentId ?? null) && o.name.toLowerCase() === input.name!.toLowerCase());
      if (clash) throw conflict("A folder with that name is already here.", { name: "A folder with that name is already here." });
      set.name = input.name; changes.push(`renamed it to ${input.name}`);
    }
    if (input.parentId !== undefined && input.parentId !== f.parentId) {
      if (input.parentId) {
        if (!idx.visible.has(input.parentId)) throw badRequest("Some details need fixing.", { parentId: "That folder wasn't found." });
        let cur: Folder | undefined = idx.byId.get(input.parentId);
        while (cur) {
          if (cur.id === f.id) throw badRequest("A folder can't be moved inside itself.");
          cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
        }
      }
      set.parentId = input.parentId; changes.push("moved it");
    }
    if (input.restricted !== undefined) { set.restricted = input.restricted; changes.push(input.restricted ? "restricted it" : "opened it to everyone"); }
    if (input.accessRoles !== undefined) { set.accessRoles = input.accessRoles; changes.push(`limited it to ${input.accessRoles.join(", ") || "admins"}`); }
    if (!changes.length) return { ok: true };
    await db.update(folders).set({ ...set, version: dsql`${folders.version} + 1` }).where(eq(folders.id, f.id));
    await audit(ctx, {
      action: set.restricted !== undefined || set.accessRoles ? "folder.access_changed" : "folder.updated",
      category: set.restricted !== undefined || set.accessRoles ? "access" : "data", entityType: "folder", entityId: f.id,
      summary: `${ctx.user.name} changed the folder ${f.name}: ${changes.join(", ")}`,
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>(`${P}/folders/:id`, async (req) => {
    const ctx = await requireAccess(req, "documents", "manage");
    const idx = await folderIndex(ctx);
    const f = isUuid(req.params.id) && idx.visible.has(req.params.id) ? idx.byId.get(req.params.id) : undefined;
    if (!f) throw notFound("That folder");
    if (f.system) throw forbidden("System folders can't be deleted.");
    if (idx.all.some((o) => o.parentId === f.id)) throw conflict("Move or delete the folders inside first.");
    const [r] = await db.select({ n: dsql<number>`count(*)::int` }).from(files).where(and(eq(files.folderId, f.id), isNull(files.deletedAt)));
    if ((r?.n ?? 0) > 0) throw conflict("Only empty folders can be deleted. Move or delete its files first (including archived ones).");
    await db.update(folders).set({ deletedAt: new Date(), version: dsql`${folders.version} + 1` }).where(eq(folders.id, f.id));
    await audit(ctx, { action: "folder.deleted", category: "data", entityType: "folder", entityId: f.id, summary: `${ctx.user.name} deleted the folder ${f.name}` });
    return { ok: true };
  });

  // ----- files -----
  app.get<{ Querystring: { view?: string; folderId?: string; q?: string; type?: string; linked?: string } }>(`${P}/files`, async (req) => {
    const ctx = await requireAccess(req, "documents", "view");
    const idx = await folderIndex(ctx);
    const q = req.query;
    const view = ["recent", "shared", "archive"].includes(q.view ?? "") ? q.view! : "all";
    const conds: SQL[] = [libraryCond(ctx, idx.visible)];
    conds.push(view === "archive" ? isNotNull(files.archivedAt) : isNull(files.archivedAt));
    const search = (q.q ?? "").trim();
    const filtered = !!search || !!q.type || !!q.linked;
    if (view === "all" && !filtered) {
      if (q.folderId) {
        if (!isUuid(q.folderId) || !idx.visible.has(q.folderId)) throw notFound("That folder");
        conds.push(eq(files.folderId, q.folderId));
      } else conds.push(isNull(files.folderId));
    } else if (view === "all" && q.folderId && isUuid(q.folderId) && idx.visible.has(q.folderId)) {
      // Search within a folder and its sub-folders.
      const within = new Set([q.folderId]);
      let grew = true;
      while (grew) { grew = false; for (const f of idx.all) if (f.parentId && within.has(f.parentId) && !within.has(f.id) && idx.visible.has(f.id)) { within.add(f.id); grew = true; } }
      conds.push(inArray(files.folderId, Array.from(within)));
    }
    if (view === "shared") {
      conds.push(ne(files.uploadedBy, ctx.user.id));
      conds.push(gte(files.createdAt, new Date(Date.now() - 30 * DAY)));
    }
    if (search) {
      for (const word of search.split(/\s+/).slice(0, 6)) {
        const term = `%${word.replace(/[%_]/g, "")}%`;
        const folderIds = idx.all.filter((f) => f.name.toLowerCase().includes(word.toLowerCase())).map((f) => f.id);
        conds.push(or(
          ilike(files.name, term), ilike(files.category, term), ilike(dsql`${files.tags}::text`, term),
          folderIds.length ? inArray(files.folderId, folderIds) : undefined,
        )!);
      }
    }
    if (q.type && TYPE_PATTERNS[q.type]) conds.push(dsql`${files.name} ~* ${TYPE_PATTERNS[q.type]}`);
    if (q.type === "other") conds.push(dsql`${files.name} !~* ${Object.values(TYPE_PATTERNS).map((p) => `(${p})`).join("|")}`);
    if (q.linked) {
      const exists = (type?: string) => dsql`exists (select 1 from ${fileLinks} where ${fileLinks.fileId} = ${files.id}${type ? dsql` and ${fileLinks.linkType} = ${type}` : dsql``})`;
      if (q.linked === "none") conds.push(dsql`not ${exists()}`);
      else if (q.linked === "any") conds.push(exists());
      else if ((LINK_TYPES as readonly string[]).includes(q.linked)) conds.push(exists(q.linked));
    }
    const order = view === "archive" ? desc(files.archivedAt) : view === "all" && !filtered ? asc(files.name) : desc(files.updatedAt);
    const rows = await db.select().from(files).where(and(...conds)).orderBy(order).limit(view === "recent" ? 50 : 300);
    return listViews(ctx, rows, idx);
  });

  app.get<{ Params: { id: string } }>(`${P}/files/:id`, async (req) => {
    const ctx = await requireAccess(req, "documents", "view");
    const idx = await folderIndex(ctx);
    const f = await loadFile(ctx, req.params.id, idx);
    const [links, versions, [view]] = await Promise.all([
      db.select().from(fileLinks).where(and(eq(fileLinks.orgId, ctx.org.id), eq(fileLinks.fileId, f.id))).orderBy(asc(fileLinks.createdAt)),
      db.select({ v: fileVersions, name: users.name }).from(fileVersions).leftJoin(users, eq(users.id, fileVersions.uploadedBy))
        .where(eq(fileVersions.fileId, f.id)).orderBy(desc(fileVersions.version)),
      listViews(ctx, [f], idx),
    ]);
    const targets = await resolveTargets(ctx.org.id, links);
    const folder = f.folderId ? idx.byId.get(f.folderId) : undefined;
    const roleRow = (role: "manager" | "member") => {
      const lvl = folder?.restricted && !folder.accessRoles.includes(role) ? "none" : levelFor(ctx, role);
      return { who: ROLE_LABEL[role]!, level: LEVEL_TEXT[lvl] };
    };
    return {
      file: view,
      folderPath: idx.path(f.folderId),
      links: links.map((l) => {
        const t = targets.get(`${l.linkType}:${l.linkId}`);
        return { id: l.id, linkType: l.linkType, linkId: l.linkId, label: t?.label ?? l.label ?? "Removed record", sub: t?.sub ?? l.linkType, exists: !!t };
      }),
      versions: versions.map(({ v, name }) => ({ id: v.id, version: v.version, size: v.size, note: v.note, uploader: name ?? "Unknown", createdAt: v.createdAt, current: v.version === f.currentVersion })),
      access: {
        source: folder ? `Follows the ${folder.name} folder` : "Not in a folder",
        folderId: folder?.id ?? null,
        restricted: !!folder?.restricted,
        rows: [{ who: "Admins", level: LEVEL_TEXT.manage }, roleRow("manager"), roleRow("member")],
      },
      canEdit: hasAccess(ctx.access.documents, "edit"),
      canManage: hasAccess(ctx.access.documents, "manage"),
      canChangeAccess: ctx.membership.role === "admin" && !!folder,
    };
  });

  app.patch<{ Params: { id: string } }>(`${P}/files/:id`, async (req) => {
    const ctx = await requireAccess(req, "documents", "edit");
    const input = parse(filePatch, req.body);
    const idx = await folderIndex(ctx);
    const f = await loadFile(ctx, req.params.id, idx);
    if (input.folderId && !idx.visible.has(input.folderId)) throw badRequest("Some details need fixing.", { folderId: "That folder wasn't found." });
    const set: Partial<typeof files.$inferInsert> = {};
    const changes: string[] = [];
    if (input.name !== undefined && input.name !== f.name) { set.name = input.name; changes.push(`renamed it to ${input.name}`); }
    if (input.folderId !== undefined && input.folderId !== f.folderId) {
      set.folderId = input.folderId; changes.push(`moved it to ${input.folderId ? idx.byId.get(input.folderId)?.name : "All files"}`);
    }
    if (input.category !== undefined) { set.category = input.category || null; changes.push("category"); }
    if (input.tags !== undefined) { set.tags = Array.from(new Set(input.tags)); changes.push("tags"); }
    if (input.expiresOn !== undefined) { set.expiresOn = input.expiresOn; changes.push("expiry date"); }
    if (!changes.length) return (await listViews(ctx, [f], idx))[0];
    const [u] = await db.update(files).set({ ...set, version: dsql`${files.version} + 1` }).where(eq(files.id, f.id)).returning();
    await audit(ctx, { action: "file.updated", category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} changed ${f.name}: ${changes.join(", ")}` });
    return (await listViews(ctx, [u!], idx))[0];
  });

  for (const action of ["archive", "unarchive"] as const) {
    app.post<{ Params: { id: string } }>(`${P}/files/:id/${action}`, async (req) => {
      const ctx = await requireAccess(req, "documents", "edit");
      const idx = await folderIndex(ctx);
      const f = await loadFile(ctx, req.params.id, idx);
      await db.update(files).set({ archivedAt: action === "archive" ? new Date() : null, version: dsql`${files.version} + 1` }).where(eq(files.id, f.id));
      await audit(ctx, { action: `file.${action}d`, category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} ${action === "archive" ? "archived" : "restored from the archive"} ${f.name}` });
      return { ok: true };
    });
  }

  app.delete<{ Params: { id: string } }>(`${P}/files/:id`, async (req) => {
    const ctx = await requireAccess(req, "documents", "manage");
    const idx = await folderIndex(ctx);
    const f = await loadFile(ctx, req.params.id, idx);
    await db.update(files).set({ deletedAt: new Date(), version: dsql`${files.version} + 1` }).where(eq(files.id, f.id));
    await audit(ctx, { action: "file.deleted", category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} deleted ${f.name}` });
    return { ok: true };
  });

  /** Restoring an old version makes a new version with the old content, so history is never lost. */
  app.post<{ Params: { id: string; versionId: string } }>(`${P}/files/:id/versions/:versionId/restore`, async (req) => {
    const ctx = await requireAccess(req, "documents", "edit");
    const idx = await folderIndex(ctx);
    const f = await loadFile(ctx, req.params.id, idx);
    if (!isUuid(req.params.versionId)) throw notFound("That version");
    const [old] = await db.select().from(fileVersions).where(and(eq(fileVersions.id, req.params.versionId), eq(fileVersions.fileId, f.id))).limit(1);
    if (!old) throw notFound("That version");
    if (old.version === f.currentVersion) throw conflict("That's already the current version.");
    const sha = createHash("sha256").update(await readObjectBuffer(old.storageKey)).digest("hex");
    const v = f.currentVersion + 1;
    await db.transaction(async (tx) => {
      await tx.insert(fileVersions).values({ fileId: f.id, version: v, storageKey: old.storageKey, size: old.size, note: `Restored version ${old.version}`, uploadedBy: ctx.user.id });
      await tx.update(files).set({ storageKey: old.storageKey, size: old.size, sha256: sha, currentVersion: v, version: dsql`${files.version} + 1` }).where(eq(files.id, f.id));
      await audit(ctx, { action: "file.version_restored", category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} restored version ${old.version} of ${f.name} (now version ${v})` }, tx);
    });
    return { ok: true, currentVersion: v };
  });

  // ----- links -----
  app.post<{ Params: { id: string } }>(`${P}/files/:id/links`, async (req) => {
    const ctx = await requireAccess(req, "documents", "edit");
    const input = parse(z.object({ linkType: z.enum(LINK_TYPES), linkId: z.string().uuid("Choose a record.") }), req.body);
    const idx = await folderIndex(ctx);
    const f = await loadFile(ctx, req.params.id, idx);
    const target = await resolveTarget(ctx.org.id, input.linkType, input.linkId);
    if (!target) throw badRequest("Some details need fixing.", { linkId: "That record wasn't found." });
    const [existing] = await db.select().from(fileLinks)
      .where(and(eq(fileLinks.fileId, f.id), eq(fileLinks.linkType, input.linkType), eq(fileLinks.linkId, input.linkId))).limit(1);
    if (existing) return { id: existing.id, label: target.label };
    const [l] = await db.insert(fileLinks).values({ orgId: ctx.org.id, fileId: f.id, linkType: input.linkType, linkId: input.linkId, label: target.label }).returning();
    await audit(ctx, { action: "file.linked", category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} linked ${f.name} to ${target.label}` });
    return { id: l!.id, label: target.label };
  });

  app.delete<{ Params: { id: string; linkId: string } }>(`${P}/files/:id/links/:linkId`, async (req) => {
    const ctx = await requireAccess(req, "documents", "edit");
    const idx = await folderIndex(ctx);
    const f = await loadFile(ctx, req.params.id, idx);
    if (!isUuid(req.params.linkId)) throw notFound("That link");
    const [l] = await db.delete(fileLinks).where(and(eq(fileLinks.id, req.params.linkId), eq(fileLinks.fileId, f.id), eq(fileLinks.orgId, ctx.org.id))).returning();
    if (!l) throw notFound("That link");
    await audit(ctx, { action: "file.unlinked", category: "data", entityType: "file", entityId: f.id, summary: `${ctx.user.name} removed a link from ${f.name}` });
    return { ok: true };
  });

  app.get<{ Querystring: { q?: string } }>(`${P}/link-targets`, async (req) => {
    const ctx = await requireAccess(req, "documents", "view");
    const q = (req.query.q ?? "").trim();
    if (!q) return [];
    return searchTargets(ctx.org.id, q);
  });
}
