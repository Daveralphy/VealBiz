import ExcelJS from "exceljs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { fileVersions, files, folders, type importJobs } from "../../db/schema";
import type { OrgContext } from "../../lib/context";
import { putObject } from "../../lib/storage";
import { audit } from "../../lib/audit";
import { DEST_BY_KEY, type DestinationKey } from "./fields";
import { EXTRA_PREFIX, type RowState } from "./validate";

export const IMPORTS_FOLDER = "Imports";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The Documents folder that keeps a copy of every import (admins and managers only). */
async function importsFolder(ctx: OrgContext): Promise<string> {
  const [f] = await db.select({ id: folders.id }).from(folders)
    .where(and(eq(folders.orgId, ctx.org.id), eq(folders.name, IMPORTS_FOLDER), eq(folders.system, true), isNull(folders.parentId), isNull(folders.deletedAt))).limit(1);
  if (f) return f.id;
  const [created] = await db.insert(folders).values({
    orgId: ctx.org.id, name: IMPORTS_FOLDER, system: true, restricted: true, accessRoles: ["admin", "manager"], createdBy: ctx.user.id,
  }).returning({ id: folders.id });
  return created!.id;
}

/**
 * Saves what an import actually added, after matching and fixes, as a spreadsheet in Documents › Imports:
 * one sheet per destination, columns named as in WindVeal, plus any columns kept as extra details.
 */
export async function saveImportCopy(ctx: OrgContext, job: typeof importJobs.$inferSelect, imported: Map<DestinationKey, RowState[]>) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "WindVeal";
  for (const [dest, rows] of imported) {
    if (!rows.length) continue;
    const def = DEST_BY_KEY[dest];
    const fields = def.fields.filter((f) => rows.some((r) => r.values[f.key]));
    const extras = Array.from(new Set(rows.flatMap((r) => Object.keys(r.values).filter((k) => k.startsWith(EXTRA_PREFIX)))));
    const ws = wb.addWorksheet(def.label.split("·").pop()!.trim().slice(0, 31));
    ws.columns = [
      ...fields.map((f) => ({ header: f.label, key: f.key, width: Math.max(14, f.label.length + 4) })),
      ...extras.map((k) => ({ header: k.slice(EXTRA_PREFIX.length), key: k, width: Math.max(14, k.length) })),
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(Object.fromEntries([...fields.map((f) => [f.key, r.values[f.key] ?? ""]), ...extras.map((k) => [k, r.values[k] ?? ""])]));
  }
  if (!wb.worksheets.length) return null;
  const data = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  const base = job.fileName.replace(/\.[^.]+$/, "");
  const name = `${base} (imported ${new Date().toISOString().slice(0, 10)}).xlsx`;
  const stored = await putObject(ctx.org.id, data);
  const folderId = await importsFolder(ctx);
  const [f] = await db.insert(files).values({
    orgId: ctx.org.id, folderId, name, mime: XLSX, size: stored.size, storageKey: stored.key, sha256: stored.sha256,
    kind: "document", category: "Import", tags: ["import"], uploadedBy: ctx.user.id,
  }).returning();
  await db.insert(fileVersions).values({ fileId: f!.id, version: 1, storageKey: stored.key, size: stored.size, uploadedBy: ctx.user.id, note: `From the import of ${job.fileName}` });
  await audit(ctx, { action: "file.uploaded", category: "data", entityType: "file", entityId: f!.id, summary: `${ctx.user.name}'s import of ${job.fileName} was saved to Documents › ${IMPORTS_FOLDER}` });
  return f!.id;
}
