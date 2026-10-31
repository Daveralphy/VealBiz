import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, departments, employees, jobs, leads, type ImportSheet } from "../../db/schema";
import { IMPORT_KEEP } from "@windveal/shared";
import { DEST_BY_KEY, EMAIL_RE, isDestination, parseDate, parseNumber, type DestinationDef, type DestinationKey } from "./fields";

export type RowState = {
  id: string;
  sheet: string;
  rowNumber: number;
  data: Record<string, string>;
  values: Record<string, string>;
  status: "ready" | "duplicate" | "invalid" | "excluded" | "imported" | "failed";
  issues: { field?: string; message: string }[];
  decision: "skip" | "update" | "create" | null;
  duplicateOfId: string | null;
};

/** Edits made on the review screen are kept in the raw row under this prefix, so they survive re-mapping. */
export const EDIT_PREFIX = "__field:";
export const SYSTEM_SHEET_PREFIX = "__";
/** Values of columns kept as extra details are stored under this prefix + the column name. */
export const EXTRA_PREFIX = "extra:";

/** The extra details (column name → value) carried by a row's values. */
export function extraDetails(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith(EXTRA_PREFIX)).map(([k, v]) => [k.slice(EXTRA_PREFIX.length), v]));
}

export const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type Existing = {
  employees: { id: string; reference: string | null; firstName: string; lastName: string; email: string | null; phone: string | null; jobTitle: string | null; departmentId: string | null; location: string | null }[];
  companies: { id: string; reference: string | null; name: string; industry: string | null; location: string | null; website: string | null }[];
  leads: { id: string; reference: string | null; companyName: string; contactName: string | null; email: string | null; phone: string | null; source: string | null; stage: string }[];
  jobs: { id: string; reference: string | null; title: string; status: string; location: string | null; employmentType: string | null; departmentId: string | null }[];
  departments: { id: string; name: string }[];
};

export async function loadExisting(orgId: string, dests: Set<string>): Promise<Existing> {
  const out: Existing = { employees: [], companies: [], leads: [], jobs: [], departments: [] };
  out.departments = await db.select({ id: departments.id, name: departments.name }).from(departments)
    .where(and(eq(departments.orgId, orgId), isNull(departments.deletedAt)));
  if (dests.has("people.employees")) {
    out.employees = await db.select({
      id: employees.id, reference: employees.reference, firstName: employees.firstName, lastName: employees.lastName, email: employees.email, phone: employees.phone,
      jobTitle: employees.jobTitle, departmentId: employees.departmentId, location: employees.location,
    }).from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));
  }
  if (dests.has("crm.companies")) {
    out.companies = await db.select({ id: companies.id, reference: companies.reference, name: companies.name, industry: companies.industry, location: companies.location, website: companies.website })
      .from(companies).where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt)));
  }
  if (dests.has("crm.leads")) {
    out.leads = await db.select({
      id: leads.id, reference: leads.reference, companyName: leads.companyName, contactName: leads.contactName, email: leads.email, phone: leads.phone, source: leads.source, stage: leads.stage,
    }).from(leads).where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt)));
  }
  if (dests.has("recruitment.jobs")) {
    out.jobs = await db.select({
      id: jobs.id, reference: jobs.reference, title: jobs.title, status: jobs.status, location: jobs.location, employmentType: jobs.employmentType, departmentId: jobs.departmentId,
    }).from(jobs).where(and(eq(jobs.orgId, orgId), isNull(jobs.deletedAt)));
  }
  return out;
}

/** Turns a raw spreadsheet row into destination values plus blocking issues. */
export function computeValues(sheet: ImportSheet, dest: DestinationDef, data: Record<string, string>) {
  const values: Record<string, string> = {};
  for (const col of sheet.columns) {
    const field = sheet.mapping[col];
    const v = (data[col] ?? "").trim();
    if (field === IMPORT_KEEP) { if (v) values[EXTRA_PREFIX + col] = v; }
    else if (field && v && !values[field]) values[field] = v;
  }
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(EDIT_PREFIX)) {
      const field = k.slice(EDIT_PREFIX.length);
      if (v.trim()) values[field] = v.trim();
      else delete values[field];
    }
  }
  const issues: { field?: string; message: string }[] = [];

  if (dest.key === "people.employees") {
    if (values.fullName && !values.firstName) {
      const parts = values.fullName.split(/\s+/);
      values.firstName = parts[0]!;
      values.lastName = values.lastName ?? parts.slice(1).join(" ");
    }
    if (values.firstName && !values.fullName) values.fullName = [values.firstName, values.lastName].filter(Boolean).join(" ");
    if (!values.firstName) issues.push({ field: "fullName", message: "Missing name" });
  }
  for (const f of dest.fields) {
    const v = values[f.key];
    if (f.required && !v) {
      issues.push({ field: f.key, message: `Missing ${f.label.toLowerCase()}` });
      continue;
    }
    if (!v) continue;
    if (f.type === "email") {
      if (!EMAIL_RE.test(v)) issues.push({ field: f.key, message: `Email address isn't valid: “${v}”` });
      else values[f.key] = v.toLowerCase();
    } else if (f.type === "date") {
      const d = parseDate(v, sheet.dateFormat ?? "dmy");
      if (!d) issues.push({ field: f.key, message: `${f.label} isn't a date we can read: “${v}”` });
      else values[f.key] = d;
    } else if (f.type === "number") {
      const n = parseNumber(v);
      if (n === null) issues.push({ field: f.key, message: `${f.label} isn't a number: “${v}”` });
      else values[f.key] = String(n);
    }
  }
  return { values, issues };
}

/** Keys used to spot the same record twice. */
export function dupKeys(dest: DestinationKey, values: Record<string, string>): string[] {
  // The same ID always means the same record.
  const ref = values.reference ? [`r:${lc(values.reference)}`] : [];
  return [...ref, ...nameKeys(dest, values)];
}

function nameKeys(dest: DestinationKey, values: Record<string, string>): string[] {
  switch (dest) {
    case "people.employees": {
      const keys: string[] = [];
      if (values.email) keys.push(`e:${lc(values.email)}`);
      const name = lc([values.firstName, values.lastName].filter(Boolean).join(" "));
      if (name) keys.push(`n:${name}`);
      return keys;
    }
    case "crm.companies": return values.name ? [`n:${lc(values.name)}`] : [];
    case "crm.leads": return values.companyName ? [`n:${lc(values.companyName)}`] : [];
    case "recruitment.jobs": return values.title ? [`n:${lc(values.title)}`] : [];
  }
}

export function existingIndex(dest: DestinationKey, ex: Existing): Map<string, string> {
  const m = new Map<string, string>();
  const add = (k: string, id: string) => { if (!m.has(k)) m.set(k, id); };
  const refs = { "people.employees": ex.employees, "crm.companies": ex.companies, "crm.leads": ex.leads, "recruitment.jobs": ex.jobs }[dest];
  for (const r of refs) if (r.reference) add(`r:${lc(r.reference)}`, r.id);
  if (dest === "people.employees") for (const e of ex.employees) {
    if (e.email) add(`e:${lc(e.email)}`, e.id);
    add(`n:${lc(`${e.firstName} ${e.lastName}`)}`, e.id);
  }
  if (dest === "crm.companies") for (const c of ex.companies) add(`n:${lc(c.name)}`, c.id);
  if (dest === "crm.leads") for (const l of ex.leads) add(`n:${lc(l.companyName)}`, l.id);
  if (dest === "recruitment.jobs") for (const j of ex.jobs) if (j.status !== "closed") add(`n:${lc(j.title)}`, j.id);
  return m;
}

/** Matches a manager written in the sheet ("Ngozi Eze", "N. Eze") against a list of people. */
export function matchPerson<T extends { firstName: string; lastName: string }>(name: string, people: T[]): T | null {
  const n = lc(name).replace(/\./g, ". ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const exact = people.filter((p) => lc(`${p.firstName} ${p.lastName}`) === n);
  if (exact.length) return exact[0]!;
  const m = /^([a-z])\.?\s+(.+)$/.exec(n);
  if (m) {
    const hits = people.filter((p) => lc(p.firstName).startsWith(m[1]!) && lc(p.lastName) === m[2]!.trim());
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

/**
 * Recomputes values, issues, duplicate state and status for every row of an import.
 * Rows already imported/failed are left alone. Returns the new states (same order).
 */
export function revalidateRows(sheets: ImportSheet[], rows: RowState[], ex: Existing): RowState[] {
  const bySheet = new Map(sheets.map((s) => [s.name, s]));
  const seen = new Map<string, Map<string, number>>(); // destination -> key -> rowNumber
  const indexes = new Map<string, Map<string, string>>();
  const sorted = [...rows].sort((a, b) => (a.sheet === b.sheet ? a.rowNumber - b.rowNumber : sheets.findIndex((s) => s.name === a.sheet) - sheets.findIndex((s) => s.name === b.sheet)));
  const out = new Map<string, RowState>();

  for (const row of sorted) {
    if (row.status === "imported" || row.status === "failed") { out.set(row.id, row); continue; }
    const sheet = bySheet.get(row.sheet);
    const excluded = row.status === "excluded";
    if (!sheet || !sheet.include || !sheet.destination || !isDestination(sheet.destination)) {
      out.set(row.id, { ...row, values: {}, issues: [], status: excluded ? "excluded" : "ready", decision: null, duplicateOfId: null });
      continue;
    }
    const dest = DEST_BY_KEY[sheet.destination];
    const { values, issues } = computeValues(sheet, dest, row.data);
    let status: RowState["status"] = issues.length ? "invalid" : "ready";
    let duplicateOfId: string | null = null;
    let decision: RowState["decision"] = null;
    if (!issues.length) {
      if (!indexes.has(dest.key)) indexes.set(dest.key, existingIndex(dest.key, ex));
      const idx = indexes.get(dest.key)!;
      if (!seen.has(dest.key)) seen.set(dest.key, new Map());
      const fileSeen = seen.get(dest.key)!;
      const keys = dupKeys(dest.key, values);
      const dbHit = keys.map((k) => idx.get(k)).find(Boolean);
      const fileHit = keys.map((k) => fileSeen.get(k)).find((x) => x !== undefined);
      if (dbHit) {
        status = "duplicate";
        duplicateOfId = dbHit;
        decision = row.decision ?? "skip";
      } else if (fileHit !== undefined) {
        status = "duplicate";
        issues.push({ message: `Looks the same as row ${fileHit} in your file` });
        decision = row.decision === "create" ? "create" : "skip";
      }
      if (!excluded && (status === "ready" || decision === "create")) for (const k of keys) if (!fileSeen.has(k)) fileSeen.set(k, row.rowNumber);
    }
    out.set(row.id, { ...row, values, issues, status: excluded ? "excluded" : status, decision: excluded ? row.decision : decision, duplicateOfId });
  }

  // Managers: link by name to an existing employee or another person in this import.
  const incoming = [...out.values()].filter((r) => {
    const s = bySheet.get(r.sheet);
    return s?.include && s.destination === "people.employees" && r.status !== "excluded" && r.status !== "invalid" && r.values.firstName;
  }).map((r) => ({ firstName: r.values.firstName!, lastName: r.values.lastName ?? "" }));
  const everyone = [...ex.employees, ...incoming];
  for (const r of out.values()) {
    const s = bySheet.get(r.sheet);
    if (s?.destination !== "people.employees" || !s.include || !r.values.manager || r.status === "imported" || r.status === "failed") continue;
    if (!matchPerson(r.values.manager, everyone)) {
      r.issues = [...r.issues, { field: "manager", message: `No one called “${r.values.manager}” yet, so the manager will be left blank` }];
    }
  }
  return rows.map((r) => out.get(r.id)!);
}

/** True when a row will be written on commit. */
export function willImport(r: Pick<RowState, "status" | "decision">) {
  return r.status === "ready" || (r.status === "duplicate" && (r.decision === "update" || r.decision === "create"));
}

export function managerBlank(r: Pick<RowState, "issues">) {
  return r.issues.some((i) => i.field === "manager");
}
