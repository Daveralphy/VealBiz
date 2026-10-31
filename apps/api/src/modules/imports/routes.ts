import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql as dsql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_LEAD_STAGES, DEFAULT_RECRUITMENT_STAGES, IMPORT_KEEP, slugify, type Workspace } from "@windveal/shared";
import { db, type Tx } from "../../db/client";
import {
  companies, contacts, departments, employees, employmentHistory, files, importJobs, importRows, jobs, leads, users, type ImportSheet,
} from "../../db/schema";
import { requireOrg, type OrgContext } from "../../lib/context";
import { AppError, badRequest, conflict, forbidden, notFound, parse, today } from "../../lib/http";
import { audit } from "../../lib/audit";
import { toCsv } from "../../lib/csv";
import {
  DESTINATIONS, DEST_BY_KEY, guessDateFormat, isDestination, mappingConfidence, suggestDestination, suggestMapping,
  parseWorkbook, type DestinationKey,
} from "./fields";
import { saveImportCopy } from "./copy";
import {
  EDIT_PREFIX, SYSTEM_SHEET_PREFIX, extraDetails, lc, loadExisting, managerBlank, matchPerson, revalidateRows, willImport, type RowState,
} from "./validate";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20_000;
const UNDO_HOURS = 24;
const DEPARTMENTS_SHEET = `${SYSTEM_SHEET_PREFIX}departments`;
const EDITABLE = ["uploaded", "mapping", "reviewing"] as const;

type Job = typeof importJobs.$inferSelect;
type RowRec = typeof importRows.$inferSelect;

const canImportTo = (ctx: OrgContext, ws: Workspace) => ctx.membership.role === "admin" || ctx.access[ws] === "manage";
const canImportAnywhere = (ctx: OrgContext) => DESTINATIONS.some((d) => canImportTo(ctx, d.workspace));

function requireDestination(ctx: OrgContext, dest: string) {
  if (!isDestination(dest)) throw badRequest("Choose where this sheet should go.");
  const d = DEST_BY_KEY[dest];
  if (!canImportTo(ctx, d.workspace)) throw forbidden(`You need manage access to ${d.workspaceLabel} to import there.`);
  return d;
}

async function loadJob(ctx: OrgContext, id: string): Promise<Job> {
  if (!z.string().uuid().safeParse(id).success) throw notFound("That import");
  const [job] = await db.select().from(importJobs)
    .where(and(eq(importJobs.id, id), eq(importJobs.orgId, ctx.org.id), isNull(importJobs.deletedAt))).limit(1);
  if (!job) throw notFound("That import");
  if (job.createdBy !== ctx.user.id && ctx.membership.role !== "admin") throw notFound("That import");
  return job;
}

function assertEditable(job: Job) {
  if (!(EDITABLE as readonly string[]).includes(job.status)) throw conflict("This import is already finished, so it can't be changed.");
}

async function jobRows(jobId: string): Promise<RowRec[]> {
  return db.select().from(importRows)
    .where(and(eq(importRows.jobId, jobId), isNull(importRows.deletedAt), ne(importRows.sheet, DEPARTMENTS_SHEET)))
    .orderBy(asc(importRows.rowNumber));
}

const toState = (r: RowRec): RowState => ({
  id: r.id, sheet: r.sheet, rowNumber: r.rowNumber, data: r.data, values: r.values, status: r.status, issues: r.issues,
  decision: r.decision ?? null, duplicateOfId: r.duplicateOfId ?? null,
});

/** Re-runs validation for the whole import and saves rows whose state changed. */
async function revalidateJob(ctx: OrgContext, job: Job) {
  const rows = await jobRows(job.id);
  const dests = new Set(job.sheets.filter((s) => s.include && s.destination).map((s) => s.destination!));
  const ex = await loadExisting(ctx.org.id, dests);
  const next = revalidateRows(job.sheets, rows.map(toState), ex);
  const changed = next.filter((n, i) => {
    const o = rows[i]!;
    return JSON.stringify([o.values, o.issues, o.status, o.decision ?? null, o.duplicateOfId ?? null])
      !== JSON.stringify([n.values, n.issues, n.status, n.decision, n.duplicateOfId]);
  });
  if (changed.length) {
    await db.transaction(async (tx) => {
      for (const n of changed) {
        await tx.update(importRows).set({
          values: n.values, issues: n.issues, status: n.status, decision: n.decision, duplicateOfId: n.duplicateOfId,
          version: dsql`${importRows.version} + 1`,
        }).where(eq(importRows.id, n.id));
      }
    });
  }
  return next;
}

const visibleData = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("__")));

function rowLabel(dest: string | null | undefined, v: Record<string, string>, data: Record<string, string>) {
  switch (dest) {
    case "people.employees": return v.fullName || [v.firstName, v.lastName].filter(Boolean).join(" ");
    case "crm.companies": return v.name ?? "";
    case "crm.leads": return v.companyName ?? "";
    case "recruitment.jobs": return v.title ?? "";
    default: return Object.values(visibleData(data)).find(Boolean) ?? "";
  }
}

function rowView(r: RowRec | RowState & { error?: string | null; resultEntityType?: string | null; resultEntityId?: string | null }, sheets: ImportSheet[]) {
  const dest = sheets.find((s) => s.name === r.sheet)?.destination ?? null;
  return {
    id: r.id, sheet: r.sheet, rowNumber: r.rowNumber, data: visibleData(r.data), values: r.values, status: r.status, issues: r.issues,
    decision: r.decision ?? null, duplicateOfId: r.duplicateOfId ?? null, label: rowLabel(dest, r.values, r.data), destination: dest,
    edits: Object.fromEntries(Object.entries(r.data).filter(([k]) => k.startsWith(EDIT_PREFIX)).map(([k, v]) => [k.slice(EDIT_PREFIX.length), v])),
    error: "error" in r ? r.error ?? null : null,
    resultEntityType: "resultEntityType" in r ? r.resultEntityType ?? null : null,
    resultEntityId: "resultEntityId" in r ? r.resultEntityId ?? null : null,
  };
}

function destinationCatalog(ctx: OrgContext) {
  return DESTINATIONS.map((d) => ({
    key: d.key, label: d.label, workspace: d.workspace, workspaceLabel: d.workspaceLabel, noun: d.noun, hint: d.hint,
    allowed: canImportTo(ctx, d.workspace),
    fields: d.fields.map((f) => ({ key: f.key, label: f.label, required: !!f.required || (d.key === "people.employees" && f.key === "fullName"), type: f.type ?? "text" })),
  }));
}

async function jobView(ctx: OrgContext, job: Job) {
  const [creator] = await db.select({ name: users.name }).from(users).where(eq(users.id, job.createdBy)).limit(1);
  const sheets = await Promise.all(job.sheets.map(async (s) => {
    const sample = await db.select({ data: importRows.data, rowNumber: importRows.rowNumber }).from(importRows)
      .where(and(eq(importRows.jobId, job.id), eq(importRows.sheet, s.name), isNull(importRows.deletedAt)))
      .orderBy(asc(importRows.rowNumber)).limit(30);
    const examples: Record<string, string[]> = {};
    for (const c of s.columns) {
      const vals: string[] = [];
      for (const r of sample) {
        const v = r.data[c];
        if (v && !vals.includes(v)) vals.push(v);
        if (vals.length >= 3) break;
      }
      examples[c] = vals;
    }
    return {
      ...s, fieldConfidence: mappingConfidence(s), examples,
      preview: sample.slice(0, 3).map((r) => ({ rowNumber: r.rowNumber, data: visibleData(r.data) })),
    };
  }));
  return {
    id: job.id, fileName: job.fileName, status: job.status, createdAt: job.createdAt, committedAt: job.committedAt, undoUntil: job.undoUntil,
    canUndo: job.status === "committed" && !!job.undoUntil && job.undoUntil.getTime() > Date.now(),
    createdBy: job.createdBy, createdByName: creator?.name ?? "", summary: job.summary, sheets, destinations: destinationCatalog(ctx),
  };
}

// ---------------- summary ----------------

async function buildSummary(ctx: OrgContext, job: Job, rows: RowState[]) {
  const ex = await loadExisting(ctx.org.id, new Set(["people.employees"]));
  const existingDepts = new Set(ex.departments.map((d) => lc(d.name)));
  const destinations: Record<string, { destination: string; label: string; workspace: string; workspaceLabel: string; noun: string; new: number; updated: number; skipped: number; excluded: number; invalid: number; departments: number; contacts: number }> = {};
  const newDepts = new Set<string>();
  let linked = 0, blank = 0;
  const dup = { skip: 0, update: 0, create: 0 };
  const skippedSheets: { name: string; rowCount: number }[] = [];
  for (const s of job.sheets) {
    if (!s.include || !s.destination || !isDestination(s.destination)) { skippedSheets.push({ name: s.name, rowCount: s.rowCount }); continue; }
    const d = DEST_BY_KEY[s.destination];
    const agg = destinations[d.key] ??= { destination: d.key, label: d.label, workspace: d.workspace, workspaceLabel: d.workspaceLabel, noun: d.noun, new: 0, updated: 0, skipped: 0, excluded: 0, invalid: 0, departments: 0, contacts: 0 };
    for (const r of rows.filter((x) => x.sheet === s.name)) {
      if (r.status === "excluded") { agg.excluded++; continue; }
      if (r.status === "invalid") { agg.invalid++; continue; }
      if (r.status === "duplicate") dup[r.decision ?? "skip"]++;
      if (!willImport(r)) { agg.skipped++; continue; }
      if (r.status === "duplicate" && r.decision === "update") agg.updated++;
      else agg.new++;
      if (r.values.department && !existingDepts.has(lc(r.values.department))) newDepts.add(lc(r.values.department));
      if (d.key === "crm.companies" && r.values.contactName && !(r.status === "duplicate" && r.decision === "update")) agg.contacts++;
      if (d.key === "people.employees" && r.values.manager) managerBlank(r) ? blank++ : linked++;
    }
  }
  const dests = Object.values(destinations);
  const toImport = dests.reduce((a, d) => a + d.new + d.updated, 0);
  const dateSheet = job.sheets.find((s) => s.include && s.destination && Object.values(s.mapping).some((f) => f === "startDate")) ?? job.sheets.find((s) => s.include);
  return {
    destinations: dests.map((d) => ({ ...d, departments: d.destination === "people.employees" || d.destination === "recruitment.jobs" ? newDepts.size : 0 })),
    newDepartments: newDepts.size,
    duplicates: dup,
    managers: { linked, blank },
    dateFormat: dateSheet?.dateFormat ?? "dmy",
    skippedSheets,
    notImported: {
      skippedSheetRows: skippedSheets.reduce((a, s) => a + s.rowCount, 0),
      excluded: dests.reduce((a, d) => a + d.excluded, 0),
      invalid: dests.reduce((a, d) => a + d.invalid, 0),
      skipped: dests.reduce((a, d) => a + d.skipped, 0),
    },
    toImport,
  };
}

// ---------------- commit ----------------

/** Adds imported extra details to a record's existing ones (new values win). */
const mergeExtra = (col: AnyColumn, extra: Record<string, string>) => dsql`coalesce(${col}, '{}'::jsonb) || ${JSON.stringify(extra)}::jsonb`;

type WriteResult = { entityType: string; entityId: string; contacts?: number };

async function writeRow(tx: Tx, ctx: OrgContext, job: Job, dest: DestinationKey, r: RowState, deptId: (name: string | undefined) => string | null): Promise<WriteResult> {
  const v = r.values;
  const orgId = ctx.org.id;
  const update = r.status === "duplicate" && r.decision === "update" && !!r.duplicateOfId;
  const recheck = r.status === "ready";
  switch (dest) {
    case "people.employees": {
      const fields = {
        email: v.email || undefined, phone: v.phone || undefined, jobTitle: v.jobTitle || undefined, departmentId: deptId(v.department) ?? undefined,
        location: v.location || undefined, employmentType: v.employmentType || undefined, startDate: v.startDate || undefined,
        reference: v.reference || undefined,
      };
      const extra = extraDetails(v);
      if (update) {
        const [u] = await tx.update(employees).set({ ...fields, firstName: v.firstName!, lastName: v.lastName ?? "", extraDetails: mergeExtra(employees.extraDetails, extra), version: dsql`${employees.version} + 1` })
          .where(and(eq(employees.id, r.duplicateOfId!), eq(employees.orgId, orgId), isNull(employees.deletedAt))).returning({ id: employees.id });
        if (!u) throw new AppError(409, "gone", "The existing record was removed while you were importing.");
        return { entityType: "employee.updated", entityId: u.id };
      }
      if (recheck) {
        const name = lc(`${v.firstName} ${v.lastName ?? ""}`);
        const [hit] = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt),
          v.email ? dsql`(lower(${employees.email}) = ${lc(v.email)} or lower(${employees.firstName} || ' ' || ${employees.lastName}) = ${name})`
            : dsql`lower(${employees.firstName} || ' ' || ${employees.lastName}) = ${name}`)).limit(1);
        if (hit) throw new AppError(409, "dup", "This person was added by someone else while you were importing.");
      }
      const status = v.startDate && v.startDate > today() ? "onboarding" : "active";
      const [e] = await tx.insert(employees).values({ orgId, firstName: v.firstName!, lastName: v.lastName ?? "", ...fields, extraDetails: extra, status }).returning({ id: employees.id });
      await tx.insert(employmentHistory).values({
        orgId, employeeId: e!.id, occurredOn: v.startDate || today(), event: v.jobTitle ? `Joined as ${v.jobTitle}` : "Joined",
        details: `Added from the import of ${job.fileName}`, actorUserId: ctx.user.id,
      });
      return { entityType: "employee", entityId: e!.id };
    }
    case "crm.companies": {
      const fields = { industry: v.industry || undefined, location: v.location || undefined, website: v.website || undefined, reference: v.reference || undefined };
      const extra = extraDetails(v);
      if (update) {
        const [u] = await tx.update(companies).set({ ...fields, name: v.name!, extraDetails: mergeExtra(companies.extraDetails, extra), version: dsql`${companies.version} + 1` })
          .where(and(eq(companies.id, r.duplicateOfId!), eq(companies.orgId, orgId), isNull(companies.deletedAt))).returning({ id: companies.id });
        if (!u) throw new AppError(409, "gone", "The existing record was removed while you were importing.");
        if (v.contactName) {
          const [c] = await tx.select({ id: contacts.id }).from(contacts)
            .where(and(eq(contacts.companyId, u.id), isNull(contacts.deletedAt), dsql`lower(${contacts.name}) = ${lc(v.contactName)}`)).limit(1);
          if (c) await tx.update(contacts).set({ role: v.contactRole || undefined, email: v.contactEmail || undefined, phone: v.contactPhone || undefined, version: dsql`${contacts.version} + 1` }).where(eq(contacts.id, c.id));
          else await tx.insert(contacts).values({ orgId, companyId: u.id, name: v.contactName, role: v.contactRole || null, email: v.contactEmail || null, phone: v.contactPhone || null });
        }
        return { entityType: "company.updated", entityId: u.id };
      }
      if (recheck) {
        const [hit] = await tx.select({ id: companies.id }).from(companies)
          .where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt), dsql`lower(${companies.name}) = ${lc(v.name)}`)).limit(1);
        if (hit) throw new AppError(409, "dup", "This company was added by someone else while you were importing.");
      }
      const [c] = await tx.insert(companies).values({ orgId, name: v.name!, ...fields, extraDetails: extra, ownerUserId: ctx.user.id }).returning({ id: companies.id });
      if (v.contactName) {
        await tx.insert(contacts).values({ orgId, companyId: c!.id, name: v.contactName, role: v.contactRole || null, email: v.contactEmail || null, phone: v.contactPhone || null, isPrimary: true });
      }
      return { entityType: "company", entityId: c!.id, contacts: v.contactName ? 1 : 0 };
    }
    case "crm.leads": {
      const fields = {
        contactName: v.contactName || undefined, email: v.email || undefined, phone: v.phone || undefined, source: v.source || undefined,
        estimatedValue: v.estimatedValue || undefined, nextStep: v.nextStep || undefined, reference: v.reference || undefined,
      };
      const extra = extraDetails(v);
      if (update) {
        const [u] = await tx.update(leads).set({ ...fields, companyName: v.companyName!, extraDetails: mergeExtra(leads.extraDetails, extra), version: dsql`${leads.version} + 1` })
          .where(and(eq(leads.id, r.duplicateOfId!), eq(leads.orgId, orgId), isNull(leads.deletedAt))).returning({ id: leads.id });
        if (!u) throw new AppError(409, "gone", "The existing record was removed while you were importing.");
        return { entityType: "lead.updated", entityId: u.id };
      }
      if (recheck) {
        const [hit] = await tx.select({ id: leads.id }).from(leads)
          .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), dsql`lower(${leads.companyName}) = ${lc(v.companyName)}`)).limit(1);
        if (hit) throw new AppError(409, "dup", "This lead was added by someone else while you were importing.");
      }
      const stage = ctx.org.settings.leadStages?.[0] ?? DEFAULT_LEAD_STAGES[0]!;
      const [l] = await tx.insert(leads).values({ orgId, companyName: v.companyName!, ...fields, extraDetails: extra, stage, ownerUserId: ctx.user.id }).returning({ id: leads.id });
      return { entityType: "lead", entityId: l!.id };
    }
    case "recruitment.jobs": {
      const fields = {
        departmentId: deptId(v.department) ?? undefined, location: v.location || undefined, employmentType: v.employmentType || undefined,
        description: v.description || undefined, reference: v.reference || undefined,
      };
      const extra = extraDetails(v);
      if (update) {
        const [u] = await tx.update(jobs).set({ ...fields, title: v.title!, extraDetails: mergeExtra(jobs.extraDetails, extra), version: dsql`${jobs.version} + 1` })
          .where(and(eq(jobs.id, r.duplicateOfId!), eq(jobs.orgId, orgId), isNull(jobs.deletedAt))).returning({ id: jobs.id });
        if (!u) throw new AppError(409, "gone", "The existing record was removed while you were importing.");
        return { entityType: "job.updated", entityId: u.id };
      }
      if (recheck) {
        const [hit] = await tx.select({ id: jobs.id }).from(jobs)
          .where(and(eq(jobs.orgId, orgId), isNull(jobs.deletedAt), dsql`${jobs.status} <> 'closed'`, dsql`lower(${jobs.title}) = ${lc(v.title)}`)).limit(1);
        if (hit) throw new AppError(409, "dup", "This job opening was added by someone else while you were importing.");
      }
      const slug = `${slugify(v.title!) || "job"}-${randomUUID().slice(0, 6)}`;
      const [j] = await tx.insert(jobs).values({
        orgId, title: v.title!, slug, ...fields, extraDetails: extra, status: "draft", stages: [...DEFAULT_RECRUITMENT_STAGES], createdBy: ctx.user.id,
      }).returning({ id: jobs.id });
      return { entityType: "job", entityId: j!.id };
    }
  }
}

const CREATED_TABLES = { employee: employees, company: companies, lead: leads, job: jobs, department: departments } as const;

// ---------------- routes ----------------

const sheetPatch = z.object({
  sheets: z.array(z.object({
    name: z.string(),
    include: z.boolean().optional(),
    destination: z.string().nullable().optional(),
    mapping: z.record(z.string().nullable()).optional(),
    dateFormat: z.enum(["dmy", "mdy", "ymd"]).optional(),
  })).min(1),
});

const rowPatch = z.object({
  values: z.record(z.string().max(2000)).optional(),
  excluded: z.boolean().optional(),
  decision: z.enum(["skip", "update", "create"]).optional(),
});

const TAB_STATUSES: Record<string, RowState["status"][] | null> = {
  all: null, ready: ["ready"], attention: ["invalid", "duplicate"], excluded: ["excluded"], failed: ["failed"], imported: ["imported"],
};

export default async function importsRoutes(app: FastifyInstance) {
  app.get("/api/imports/destinations", async (req) => {
    const ctx = await requireOrg(req);
    return { destinations: destinationCatalog(ctx), canImport: canImportAnywhere(ctx) };
  });

  app.get<{ Params: { destination: string } }>("/api/imports/templates/:destination", async (req, reply) => {
    await requireOrg(req);
    const key = req.params.destination;
    if (!isDestination(key)) throw notFound("That template");
    const d = DEST_BY_KEY[key];
    const headers = d.fields.filter((f) => f.key !== "firstName" && f.key !== "lastName").map((f) => f.label);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="windveal-${d.noun.replace(/\s+/g, "-")}-template.csv"`);
    return reply.send(toCsv(headers, []));
  });

  app.post("/api/imports/upload", async (req) => {
    const ctx = await requireOrg(req);
    if (!canImportAnywhere(ctx)) throw forbidden("You don't have permission to import data. Ask an admin for manage access.");
    const part = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
    if (!part) throw badRequest("Choose a file to upload.");
    const ext = part.filename.split(".").pop()?.toLowerCase();
    if (ext !== "xlsx" && ext !== "csv") throw new AppError(415, "file_type", "Use an Excel (.xlsx) or CSV file.");
    const buf = await part.toBuffer().catch(() => null);
    if (!buf || part.file.truncated) throw new AppError(413, "file_too_large", "That file is too large. The limit is 20 MB.");
    if (buf.length === 0) throw badRequest("That file is empty.");
    let parsed;
    try {
      parsed = await parseWorkbook(part.filename, buf);
    } catch {
      throw badRequest("We couldn't read that file. Check it opens in Excel and try again.");
    }
    if (!parsed.length || parsed.every((s) => !s.rows.length)) throw badRequest("We couldn't find any rows in that file.");
    const total = parsed.reduce((a, s) => a + s.rows.length, 0);
    if (total > MAX_ROWS) throw badRequest(`That file has ${total.toLocaleString("en-GB")} rows. Split it into files of up to ${MAX_ROWS.toLocaleString("en-GB")} rows.`);

    const sheets: ImportSheet[] = parsed.filter((p) => p.rows.length).map((p) => {
      const s = suggestDestination(p.name, p.columns);
      let destination = s.destination;
      if (destination && !canImportTo(ctx, DEST_BY_KEY[destination].workspace)) destination = null;
      const dateCols = destination ? Object.entries(s.mapping).filter(([, f]) => DEST_BY_KEY[destination!].fields.find((x) => x.key === f)?.type === "date").map(([c]) => c) : [];
      const samples = (dateCols.length ? dateCols : p.columns).flatMap((c) => p.rows.slice(0, 200).map((r) => r.data[c] ?? ""));
      return {
        name: p.name, columns: p.columns, rowCount: p.rows.length, include: true, destination, confidence: s.confidence,
        mapping: destination ? s.mapping : Object.fromEntries(p.columns.map((c) => [c, null])), dateFormat: guessDateFormat(samples),
      };
    });
    const jobId = randomUUID();
    const states: RowState[] = parsed.flatMap((p) => p.rows.map((r) => ({
      id: randomUUID(), sheet: p.name, rowNumber: r.rowNumber, data: r.data, values: {}, status: "ready" as const, issues: [], decision: null, duplicateOfId: null,
    })));
    const ex = await loadExisting(ctx.org.id, new Set(sheets.map((s) => s.destination).filter(Boolean) as string[]));
    const computed = revalidateRows(sheets, states, ex);
    await db.transaction(async (tx) => {
      await tx.insert(importJobs).values({ id: jobId, orgId: ctx.org.id, fileName: part.filename.slice(0, 200), createdBy: ctx.user.id, status: "uploaded", sheets });
      for (let i = 0; i < computed.length; i += 1000) {
        await tx.insert(importRows).values(computed.slice(i, i + 1000).map((r) => ({
          id: r.id, orgId: ctx.org.id, jobId, sheet: r.sheet, rowNumber: r.rowNumber, data: r.data, values: r.values, status: r.status,
          issues: r.issues, decision: r.decision, duplicateOfId: r.duplicateOfId,
        })));
      }
    });
    const job = await loadJob(ctx, jobId);
    return { job: await jobView(ctx, job) };
  });

  app.get("/api/imports/jobs", async (req) => {
    const ctx = await requireOrg(req);
    const where = [eq(importJobs.orgId, ctx.org.id), isNull(importJobs.deletedAt)];
    if (ctx.membership.role !== "admin") where.push(eq(importJobs.createdBy, ctx.user.id));
    const rows = await db.select({ j: importJobs, name: users.name }).from(importJobs).innerJoin(users, eq(users.id, importJobs.createdBy))
      .where(and(...where)).orderBy(desc(importJobs.createdAt)).limit(50);
    return rows.map(({ j, name }) => {
      const workspaces = Array.from(new Set(j.sheets.filter((s) => s.include && s.destination && isDestination(s.destination)).map((s) => DEST_BY_KEY[s.destination as DestinationKey].workspaceLabel)));
      return {
        id: j.id, fileName: j.fileName, status: j.status, createdAt: j.createdAt, committedAt: j.committedAt, createdByName: name,
        workspaces, added: j.summary.added ?? 0, updated: j.summary.updated ?? 0, failed: j.summary.failed ?? 0,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/api/imports/jobs/:id", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    return { job: await jobView(ctx, job) };
  });

  app.patch<{ Params: { id: string } }>("/api/imports/jobs/:id/sheets", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    assertEditable(job);
    const input = parse(sheetPatch, req.body);
    const sheets = job.sheets.map((s) => ({ ...s, mapping: { ...s.mapping } }));
    for (const p of input.sheets) {
      const s = sheets.find((x) => x.name === p.name);
      if (!s) throw badRequest(`There's no sheet called “${p.name}” in this file.`);
      if (p.include !== undefined) s.include = p.include;
      if (p.destination !== undefined && p.destination !== s.destination) {
        if (p.destination === null) {
          s.destination = null;
          s.mapping = Object.fromEntries(s.columns.map((c) => [c, null]));
        } else {
          const d = requireDestination(ctx, p.destination);
          s.destination = d.key;
          s.confidence = 1;
          s.mapping = suggestMapping(s.columns, d).mapping;
        }
      }
      if (p.mapping) {
        if (!s.destination) throw badRequest(`Choose where “${s.name}” should go before matching its columns.`);
        const d = DEST_BY_KEY[s.destination as DestinationKey];
        for (const [col, field] of Object.entries(p.mapping)) {
          if (!s.columns.includes(col)) throw badRequest(`“${col}” isn't a column in “${s.name}”.`);
          if (field !== null && field !== IMPORT_KEEP && !d.fields.some((f) => f.key === field)) throw badRequest(`“${field}” isn't a field in ${d.label}.`);
          // A field can only come from one column.
          if (field && field !== IMPORT_KEEP) for (const c of Object.keys(s.mapping)) if (c !== col && s.mapping[c] === field) s.mapping[c] = IMPORT_KEEP;
          s.mapping[col] = field;
        }
      }
      if (p.dateFormat) s.dateFormat = p.dateFormat;
      if (s.include && s.destination) requireDestination(ctx, s.destination);
    }
    const [updated] = await db.update(importJobs).set({ sheets, status: "mapping", version: dsql`${importJobs.version} + 1` })
      .where(eq(importJobs.id, job.id)).returning();
    await revalidateJob(ctx, updated!);
    return { job: await jobView(ctx, updated!) };
  });

  app.get<{ Params: { id: string }; Querystring: { sheet?: string; tab?: string; page?: string; pageSize?: string } }>("/api/imports/jobs/:id/rows", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    const tab = req.query.tab ?? "all";
    if (!(tab in TAB_STATUSES)) throw badRequest("Unknown tab.");
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const importable = job.sheets.filter((s) => s.include && s.destination).map((s) => s.name);
    const sheetNames = req.query.sheet ? [req.query.sheet].filter((s) => importable.includes(s)) : importable;
    if (!sheetNames.length) return { rows: [], total: 0, page, pageSize, counts: { all: 0, ready: 0, attention: 0, excluded: 0, failed: 0, imported: 0, willImport: 0 } };
    const base = [eq(importRows.jobId, job.id), isNull(importRows.deletedAt), inArray(importRows.sheet, sheetNames)];
    const grouped = await db.select({ status: importRows.status, decision: importRows.decision, n: dsql<number>`count(*)::int` }).from(importRows)
      .where(and(...base)).groupBy(importRows.status, importRows.decision);
    const count = (st: string[]) => grouped.filter((g) => st.includes(g.status)).reduce((a, g) => a + g.n, 0);
    const counts = {
      all: grouped.reduce((a, g) => a + g.n, 0), ready: count(["ready"]), attention: count(["invalid", "duplicate"]), excluded: count(["excluded"]),
      failed: count(["failed"]), imported: count(["imported"]),
      willImport: grouped.filter((g) => willImport({ status: g.status, decision: g.decision ?? null })).reduce((a, g) => a + g.n, 0),
    };
    const statuses = TAB_STATUSES[tab];
    const where = statuses ? and(...base, inArray(importRows.status, statuses)) : and(...base);
    const rows = await db.select().from(importRows).where(where).orderBy(asc(importRows.sheet), asc(importRows.rowNumber))
      .limit(pageSize).offset((page - 1) * pageSize);
    const total = statuses ? count(statuses) : counts.all;
    return { rows: rows.map((r) => rowView(r, job.sheets)), total, page, pageSize, counts };
  });

  app.patch<{ Params: { id: string } }>("/api/imports/rows/:id", async (req) => {
    const ctx = await requireOrg(req);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("That row");
    const [row] = await db.select().from(importRows)
      .where(and(eq(importRows.id, req.params.id), eq(importRows.orgId, ctx.org.id), isNull(importRows.deletedAt))).limit(1);
    if (!row || row.sheet.startsWith(SYSTEM_SHEET_PREFIX)) throw notFound("That row");
    const job = await loadJob(ctx, row.jobId);
    assertEditable(job);
    const input = parse(rowPatch, req.body);
    const sheet = job.sheets.find((s) => s.name === row.sheet);
    const patch: Partial<RowRec> = {};
    if (input.values) {
      if (!sheet?.destination) throw badRequest("Choose where this sheet goes before editing its rows.");
      const d = DEST_BY_KEY[sheet.destination as DestinationKey];
      const data = { ...row.data };
      for (const [k, v] of Object.entries(input.values)) {
        if (!d.fields.some((f) => f.key === k)) throw badRequest(`“${k}” isn't a field in ${d.label}.`);
        data[`${EDIT_PREFIX}${k}`] = v;
      }
      patch.data = data;
    }
    if (input.excluded === true) patch.status = "excluded";
    if (input.excluded === false && row.status === "excluded") patch.status = "ready";
    if (input.decision) {
      if (row.status !== "duplicate") throw badRequest("Only possible duplicates need a decision.");
      if (input.decision === "update" && !row.duplicateOfId) throw badRequest("This row matches another row in your file, so there's nothing to update.");
      patch.decision = input.decision;
    }
    if (Object.keys(patch).length) {
      await db.update(importRows).set({ ...patch, version: dsql`${importRows.version} + 1` }).where(eq(importRows.id, row.id));
    }
    await db.update(importJobs).set({ status: "reviewing" }).where(eq(importJobs.id, job.id));
    const next = await revalidateJob(ctx, job);
    const mine = next.find((r) => r.id === row.id)!;
    return { row: rowView(mine, job.sheets) };
  });

  app.get<{ Params: { id: string; rowId: string } }>("/api/imports/jobs/:id/duplicate/:rowId", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    if (!z.string().uuid().safeParse(req.params.rowId).success) throw notFound("That row");
    const [row] = await db.select().from(importRows)
      .where(and(eq(importRows.id, req.params.rowId), eq(importRows.jobId, job.id), isNull(importRows.deletedAt))).limit(1);
    if (!row) throw notFound("That row");
    const sheet = job.sheets.find((s) => s.name === row.sheet);
    if (!sheet?.destination || !isDestination(sheet.destination)) throw badRequest("This sheet isn't going anywhere yet.");
    const d = DEST_BY_KEY[sheet.destination];
    let existing: Record<string, string> | null = null;
    if (row.duplicateOfId) {
      const ex = await loadExisting(ctx.org.id, new Set([d.key]));
      const deptName = (id: string | null) => ex.departments.find((x) => x.id === id)?.name ?? "";
      if (d.key === "people.employees") {
        const e = ex.employees.find((x) => x.id === row.duplicateOfId);
        if (e) existing = { fullName: `${e.firstName} ${e.lastName}`.trim(), email: e.email ?? "", phone: e.phone ?? "", jobTitle: e.jobTitle ?? "", department: deptName(e.departmentId), location: e.location ?? "" };
      } else if (d.key === "crm.companies") {
        const c = ex.companies.find((x) => x.id === row.duplicateOfId);
        if (c) {
          const [ct] = await db.select().from(contacts).where(and(eq(contacts.companyId, c.id), isNull(contacts.deletedAt))).orderBy(desc(contacts.isPrimary)).limit(1);
          existing = { name: c.name, industry: c.industry ?? "", location: c.location ?? "", website: c.website ?? "", contactName: ct?.name ?? "", contactRole: ct?.role ?? "", contactEmail: ct?.email ?? "", contactPhone: ct?.phone ?? "" };
        }
      } else if (d.key === "crm.leads") {
        const l = ex.leads.find((x) => x.id === row.duplicateOfId);
        if (l) existing = { companyName: l.companyName, contactName: l.contactName ?? "", email: l.email ?? "", phone: l.phone ?? "", source: l.source ?? "", stage: l.stage };
      } else {
        const j = ex.jobs.find((x) => x.id === row.duplicateOfId);
        if (j) existing = { title: j.title, department: deptName(j.departmentId), location: j.location ?? "", employmentType: j.employmentType ?? "", status: j.status };
      }
    }
    const fields = d.fields.filter((f) => f.key !== "firstName" && f.key !== "lastName").map((f) => ({ key: f.key, label: f.label }));
    const differences = existing ? fields.filter((f) => (existing![f.key] ?? "") && (row.values[f.key] ?? "") && lc(existing![f.key]) !== lc(row.values[f.key])).map((f) => f.key) : [];
    return {
      destination: d.key, workspaceLabel: d.workspaceLabel, entity: d.entity, fields, existing, incoming: row.values,
      rowNumber: row.rowNumber, differences, note: row.duplicateOfId ? null : row.issues.find((i) => !i.field)?.message ?? null,
    };
  });

  app.get<{ Params: { id: string } }>("/api/imports/jobs/:id/summary", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    const rows = (await jobRows(job.id)).map(toState);
    return { summary: await buildSummary(ctx, job, rows) };
  });

  app.post<{ Params: { id: string } }>("/api/imports/jobs/:id/commit", async (req) => {
    const ctx = await requireOrg(req);
    parse(z.object({ confirm: z.literal(true, { errorMap: () => ({ message: "Tick “I've reviewed these changes” first." }) }) }), req.body);
    let job = await loadJob(ctx, req.params.id);
    assertEditable(job);
    for (const s of job.sheets) if (s.include && s.destination) requireDestination(ctx, s.destination);
    const states = await revalidateJob(ctx, job);
    // Lock the job so it can only be committed once.
    const [locked] = await db.update(importJobs).set({ status: "committed", committedAt: new Date(), version: dsql`${importJobs.version} + 1` })
      .where(and(eq(importJobs.id, job.id), inArray(importJobs.status, [...EDITABLE]))).returning();
    if (!locked) throw conflict("This import is already being added.");
    job = locked;

    const toWrite = new Map<DestinationKey, RowState[]>();
    for (const s of job.sheets) {
      if (!s.include || !s.destination || !isDestination(s.destination)) continue;
      const list = toWrite.get(s.destination) ?? [];
      list.push(...states.filter((r) => r.sheet === s.name && willImport(r)));
      toWrite.set(s.destination, list);
    }

    // Departments first (outside row transactions so every row sees the same ids).
    const ex = await loadExisting(ctx.org.id, new Set());
    const deptIds = new Map(ex.departments.map((d) => [lc(d.name), d.id]));
    const createdDepts: { id: string; name: string }[] = [];
    for (const dest of ["people.employees", "recruitment.jobs"] as const) {
      for (const r of toWrite.get(dest) ?? []) {
        const name = r.values.department?.trim();
        if (!name || deptIds.has(lc(name))) continue;
        const [d] = await db.insert(departments).values({ orgId: ctx.org.id, name }).returning({ id: departments.id });
        deptIds.set(lc(name), d!.id);
        createdDepts.push({ id: d!.id, name });
      }
    }
    if (createdDepts.length) {
      await db.insert(importRows).values(createdDepts.map((d, i) => ({
        orgId: ctx.org.id, jobId: job.id, sheet: DEPARTMENTS_SHEET, rowNumber: i + 1, data: { name: d.name },
        status: "imported" as const, resultEntityType: "department", resultEntityId: d.id,
      })));
    }
    const deptId = (name: string | undefined) => (name ? deptIds.get(lc(name)) ?? null : null);

    const counts: Record<string, number> = { added: 0, updated: 0, failed: 0, contacts: 0, departments: createdDepts.length, employees: 0, companies: 0, leads: 0, jobs: 0 };
    const nounKey: Record<DestinationKey, string> = { "people.employees": "employees", "crm.companies": "companies", "crm.leads": "leads", "recruitment.jobs": "jobs" };
    const managerRows: { entityId: string; manager: string }[] = [];
    const imported = new Map<DestinationKey, RowState[]>();
    for (const dest of ["people.employees", "recruitment.jobs", "crm.companies", "crm.leads"] as const) {
      for (const r of toWrite.get(dest) ?? []) {
        try {
          const res = await db.transaction((tx) => writeRow(tx, ctx, job, dest, r, deptId));
          await db.update(importRows).set({ status: "imported", resultEntityType: res.entityType, resultEntityId: res.entityId, error: null, version: dsql`${importRows.version} + 1` })
            .where(eq(importRows.id, r.id));
          imported.set(dest, [...(imported.get(dest) ?? []), r]);
          if (res.entityType.endsWith(".updated")) counts.updated!++;
          else { counts.added!++; counts[nounKey[dest]]!++; }
          counts.contacts! += res.contacts ?? 0;
          if (dest === "people.employees" && r.values.manager) managerRows.push({ entityId: res.entityId, manager: r.values.manager });
        } catch (err) {
          counts.failed!++;
          const message = err instanceof AppError ? err.message : "This row couldn't be added. Check its values and try again.";
          if (!(err instanceof AppError)) req.log.error({ err }, "import row failed");
          await db.update(importRows).set({ status: "failed", error: message, version: dsql`${importRows.version} + 1` }).where(eq(importRows.id, r.id));
        }
      }
    }

    // Link managers by name now that everyone in the file exists.
    if (managerRows.length) {
      const people = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees)
        .where(and(eq(employees.orgId, ctx.org.id), isNull(employees.deletedAt)));
      let linked = 0;
      for (const m of managerRows) {
        const hit = matchPerson(m.manager, people.filter((p) => p.id !== m.entityId));
        if (hit) {
          await db.update(employees).set({ managerId: hit.id, version: dsql`${employees.version} + 1` }).where(eq(employees.id, m.entityId));
          linked++;
        }
      }
      counts.managersLinked = linked;
      counts.managersBlank = managerRows.length - linked;
    }

    const total = [...toWrite.values()].reduce((a, l) => a + l.length, 0);
    counts.total = total;
    const undoUntil = new Date(Date.now() + UNDO_HOURS * 3600_000);
    // Keep a copy of what was added in Documents › Imports. The import still counts if saving the copy fails.
    let copyId: string | null = null;
    try { copyId = await saveImportCopy(ctx, job, imported); } catch (err) { req.log.error({ err }, "import copy failed"); }
    const [done] = await db.update(importJobs).set({ summary: counts, undoUntil, fileId: copyId, version: dsql`${importJobs.version} + 1` })
      .where(eq(importJobs.id, job.id)).returning();
    await audit(ctx, {
      action: "import.committed", category: "data", entityType: "import", entityId: job.id,
      summary: `${ctx.user.name} imported ${job.fileName}: ${counts.added} added${counts.updated ? `, ${counts.updated} updated` : ""}${counts.failed ? `, ${counts.failed} not added` : ""}`,
      meta: counts,
    });
    return { job: await jobView(ctx, done!) };
  });

  app.post<{ Params: { id: string } }>("/api/imports/jobs/:id/undo", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    if (job.status !== "committed") throw conflict("Only finished imports can be undone.");
    if (!job.undoUntil || job.undoUntil.getTime() < Date.now()) throw conflict("The 24 hours to undo this import have passed.");
    if (job.createdBy !== ctx.user.id && ctx.membership.role !== "admin") throw forbidden("Only the person who imported this file or an admin can undo it.");
    const created = await db.select().from(importRows)
      .where(and(eq(importRows.jobId, job.id), eq(importRows.status, "imported"), inArray(importRows.resultEntityType, Object.keys(CREATED_TABLES))));
    const now = new Date();
    let removed = 0;
    await db.transaction(async (tx) => {
      for (const type of Object.keys(CREATED_TABLES) as (keyof typeof CREATED_TABLES)[]) {
        const ids = created.filter((r) => r.resultEntityType === type && r.resultEntityId).map((r) => r.resultEntityId!);
        if (!ids.length) continue;
        const t = CREATED_TABLES[type];
        await tx.update(t).set({ deletedAt: now, version: dsql`${t.version} + 1` })
          .where(and(inArray(t.id, ids), eq(t.orgId, ctx.org.id), isNull(t.deletedAt)));
        if (type === "company") {
          await tx.update(contacts).set({ deletedAt: now, version: dsql`${contacts.version} + 1` })
            .where(and(inArray(contacts.companyId, ids), eq(contacts.orgId, ctx.org.id), isNull(contacts.deletedAt)));
        }
        if (type !== "department") removed += ids.length;
      }
      await tx.update(importJobs).set({ status: "undone", version: dsql`${importJobs.version} + 1` }).where(eq(importJobs.id, job.id));
      // The saved copy in Documents no longer matches anything: archive it (it can still be restored).
      if (job.fileId) await tx.update(files).set({ archivedAt: new Date() }).where(and(eq(files.id, job.fileId), eq(files.orgId, ctx.org.id)));
      await audit(ctx, {
        action: "import.undone", category: "data", entityType: "import", entityId: job.id,
        summary: `${ctx.user.name} undid the import of ${job.fileName}: ${removed} removed`,
      }, tx);
    });
    const [after] = await db.select().from(importJobs).where(eq(importJobs.id, job.id)).limit(1);
    return { job: await jobView(ctx, after!), removed };
  });

  app.post<{ Params: { id: string } }>("/api/imports/jobs/:id/cancel", async (req) => {
    const ctx = await requireOrg(req);
    const job = await loadJob(ctx, req.params.id);
    assertEditable(job);
    await db.update(importJobs).set({ status: "cancelled", version: dsql`${importJobs.version} + 1` }).where(eq(importJobs.id, job.id));
    return { ok: true };
  });
}
