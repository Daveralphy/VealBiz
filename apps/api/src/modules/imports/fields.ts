import ExcelJS from "exceljs";
import Papa from "papaparse";
import { IMPORT_KEEP, type Workspace } from "@windveal/shared";
import type { ImportSheet } from "../../db/schema";

/** Field definitions for each place a spreadsheet can be imported into. Deterministic, no AI. */
export type FieldType = "text" | "email" | "date" | "number";
export type FieldDef = {
  key: string;
  label: string;
  required?: boolean;
  type?: FieldType;
  /** Header words that clearly mean this field (score 1). */
  strong: string[];
  /** Header words that probably mean this field (score 0.6 — shown as "Check this"). */
  weak?: string[];
};
export type DestinationKey = "people.employees" | "crm.companies" | "crm.leads" | "recruitment.jobs";
export type DestinationDef = {
  key: DestinationKey;
  label: string;
  workspace: Workspace;
  workspaceLabel: string;
  entity: string;
  /** Plural noun for counts ("employees") */
  noun: string;
  fields: FieldDef[];
  /** Sheet/file-name words that hint at this destination. */
  sheetWords: string[];
  hint: string;
};

export const DESTINATIONS: DestinationDef[] = [
  {
    key: "people.employees", label: "People & HR · Employees", workspace: "people", workspaceLabel: "People & HR", entity: "employee", noun: "employees",
    sheetWords: ["staff", "employee", "employees", "team", "people", "hr", "personnel", "workers"],
    hint: "Looks like a staff list.",
    fields: [
      { key: "reference", label: "Employee ID", strong: ["id", "employee id", "staff id", "emp id", "employee no", "employee number", "staff no", "staff number", "personnel number", "emp no", "id number", "reference", "ref", "employee code", "staff code"], weak: ["no", "number", "s n", "sn"] },
      { key: "fullName", label: "Employee name", strong: ["full name", "employee name", "name", "staff name", "employee"], weak: ["person", "staff"] },
      { key: "firstName", label: "First name", strong: ["first name", "firstname", "given name", "forename"] },
      { key: "lastName", label: "Last name", strong: ["last name", "lastname", "surname", "family name"] },
      { key: "email", label: "Work email", type: "email", strong: ["email", "work email", "email address", "e mail"], weak: ["mail"] },
      { key: "phone", label: "Phone number", strong: ["phone", "phone no", "phone number", "mobile", "telephone", "tel"], weak: ["contact number", "cell"] },
      { key: "jobTitle", label: "Job title", strong: ["job title", "title", "position", "role", "designation"] },
      { key: "department", label: "Department", strong: ["department", "dept", "team", "division", "unit"] },
      { key: "manager", label: "Reporting manager", strong: ["manager", "line manager", "reporting manager", "reports to", "supervisor"], weak: ["mgr", "boss", "lead"] },
      { key: "location", label: "Location", strong: ["location", "office", "branch", "city", "site"] },
      { key: "employmentType", label: "Employment type", strong: ["employment type", "contract type", "type", "employment"] },
      { key: "startDate", label: "Start date", type: "date", strong: ["start date", "start", "date joined", "joined", "hire date", "date hired", "employment date"], weak: ["joining"] },
    ],
  },
  {
    key: "crm.companies", label: "CRM · Companies and contacts", workspace: "crm", workspaceLabel: "CRM", entity: "company", noun: "companies",
    sheetWords: ["client", "clients", "customer", "customers", "companies", "company", "accounts", "contacts"],
    hint: "Each row becomes a company and its contact.",
    fields: [
      { key: "reference", label: "Company ID", strong: ["id", "company id", "client id", "customer id", "account id", "account number", "customer number", "client number", "reference", "ref", "client code", "customer code"], weak: ["no", "number", "s n", "sn"] },
      { key: "name", label: "Company name", required: true, strong: ["company", "company name", "client", "client name", "customer", "customer name", "organisation", "organization", "business", "account"] },
      { key: "industry", label: "Industry", strong: ["industry", "sector"] },
      { key: "location", label: "Location", strong: ["location", "city", "address", "town", "region"] },
      { key: "website", label: "Website", strong: ["website", "web", "url", "site"] },
      { key: "contactName", label: "Contact name", strong: ["contact", "contact name", "contact person", "primary contact"], weak: ["person", "name"] },
      { key: "contactRole", label: "Contact role", strong: ["contact role", "role", "job title", "position", "title"] },
      { key: "contactEmail", label: "Contact email", type: "email", strong: ["email", "contact email", "email address", "e mail"] },
      { key: "contactPhone", label: "Contact phone", strong: ["phone", "contact phone", "phone number", "mobile", "telephone", "tel"] },
    ],
  },
  {
    key: "crm.leads", label: "CRM · Leads", workspace: "crm", workspaceLabel: "CRM", entity: "lead", noun: "leads",
    sheetWords: ["lead", "leads", "prospect", "prospects", "pipeline", "enquiries", "opportunities"],
    hint: "Each row becomes a lead at the first stage.",
    fields: [
      { key: "reference", label: "Lead ID", strong: ["id", "lead id", "prospect id", "reference", "ref", "lead number", "lead no"], weak: ["no", "number", "s n", "sn"] },
      { key: "companyName", label: "Company name", required: true, strong: ["company", "company name", "lead", "lead name", "prospect", "business", "organisation", "organization"], weak: ["client"] },
      { key: "contactName", label: "Contact name", strong: ["contact", "contact name", "contact person"], weak: ["name", "person"] },
      { key: "email", label: "Email", type: "email", strong: ["email", "email address", "e mail"] },
      { key: "phone", label: "Phone", strong: ["phone", "phone number", "mobile", "telephone", "tel"] },
      { key: "source", label: "Source", strong: ["source", "lead source", "channel", "referral", "how they found us"] },
      { key: "estimatedValue", label: "Estimated value", type: "number", strong: ["estimated value", "value", "deal value", "amount", "budget", "potential value"], weak: ["worth"] },
      { key: "nextStep", label: "Next step", strong: ["next step", "next action", "follow up", "action"], weak: ["notes"] },
    ],
  },
  {
    key: "recruitment.jobs", label: "Recruitment · Job openings", workspace: "recruitment", workspaceLabel: "Recruitment", entity: "job", noun: "job openings",
    sheetWords: ["job", "jobs", "vacancy", "vacancies", "roles", "openings", "positions", "hiring", "recruitment"],
    hint: "Each row becomes a draft job opening.",
    fields: [
      { key: "reference", label: "Job ID", strong: ["id", "job id", "job code", "vacancy id", "requisition id", "requisition number", "req id", "reference", "ref", "job number"], weak: ["no", "number", "s n", "sn"] },
      { key: "title", label: "Job title", required: true, strong: ["job title", "title", "job", "vacancy", "role", "position", "opening"] },
      { key: "department", label: "Department", strong: ["department", "dept", "team", "division"] },
      { key: "location", label: "Location", strong: ["location", "office", "city", "site", "branch"] },
      { key: "employmentType", label: "Employment type", strong: ["employment type", "type", "contract", "contract type"] },
      { key: "description", label: "Description", strong: ["description", "details", "summary", "job description", "about the role"] },
    ],
  },
];

export const DEST_BY_KEY = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d])) as Record<DestinationKey, DestinationDef>;
export const isDestination = (k: unknown): k is DestinationKey => typeof k === "string" && k in DEST_BY_KEY;

export function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** How well a column header matches a field (0..1). */
export function scoreField(header: string, f: FieldDef): number {
  const h = normaliseHeader(header);
  if (!h) return 0;
  if (f.strong.includes(h)) return 1;
  if (f.weak?.includes(h)) return 0.6;
  const words = ` ${h} `;
  for (const s of f.strong) if (s.length > 2 && words.includes(` ${s} `)) return 0.8;
  for (const s of f.weak ?? []) if (s.length > 2 && words.includes(` ${s} `)) return 0.5;
  return 0;
}

/** Suggests a column → field mapping (each field used at most once) plus a per-column confidence. */
export function suggestMapping(columns: string[], dest: DestinationDef) {
  const cands: { col: string; field: string; score: number }[] = [];
  for (const col of columns) for (const f of dest.fields) {
    const s = scoreField(col, f);
    if (s >= 0.5) cands.push({ col, field: f.key, score: s });
  }
  cands.sort((a, b) => b.score - a.score);
  // Columns with no matching field are kept as extra details; only the person importing can choose to skip one.
  const mapping: Record<string, string | null> = Object.fromEntries(columns.map((c) => [c, IMPORT_KEEP]));
  const confidence: Record<string, number> = Object.fromEntries(columns.map((c) => [c, 0]));
  const used = new Set<string>();
  for (const c of cands) {
    if (mapping[c.col] !== IMPORT_KEEP || used.has(c.field)) continue;
    // A full name and split first/last names shouldn't both be used.
    if (c.field === "fullName" && (used.has("firstName") || used.has("lastName"))) continue;
    if ((c.field === "firstName" || c.field === "lastName") && used.has("fullName")) continue;
    mapping[c.col] = c.field;
    confidence[c.col] = c.score;
    used.add(c.field);
  }
  return { mapping, confidence };
}

/** Column confidence for an existing (possibly user-edited) mapping. */
export function mappingConfidence(sheet: ImportSheet): Record<string, number> {
  const dest = sheet.destination && isDestination(sheet.destination) ? DEST_BY_KEY[sheet.destination] : null;
  const out: Record<string, number> = {};
  for (const col of sheet.columns) {
    const key = sheet.mapping[col];
    const f = dest?.fields.find((x) => x.key === key);
    out[col] = f ? Math.max(scoreField(col, f), 0) : 0;
  }
  return out;
}

function hasRequired(dest: DestinationDef, mapping: Record<string, string | null>) {
  const used = new Set(Object.values(mapping).filter((v) => v && v !== IMPORT_KEEP));
  if (dest.key === "people.employees") return used.has("fullName") || used.has("firstName");
  return dest.fields.filter((f) => f.required).every((f) => used.has(f.key));
}

/** Picks the most likely destination for a sheet from its headers and name. */
export function suggestDestination(sheetName: string, columns: string[]) {
  const name = ` ${normaliseHeader(sheetName)} `;
  let best: { dest: DestinationDef; confidence: number; mapping: Record<string, string | null> } | null = null;
  for (const dest of DESTINATIONS) {
    const { mapping, confidence } = suggestMapping(columns, dest);
    const sum = Object.values(confidence).reduce((a, b) => a + b, 0);
    const nameHit = dest.sheetWords.some((w) => name.includes(` ${w} `));
    let conf = (hasRequired(dest, mapping) ? 0.45 : 0) + 0.4 * Math.min(1, sum / 3.5) + (nameHit ? 0.15 : 0);
    // Destination-specific signals that tell similar lists apart.
    const norm = columns.map(normaliseHeader);
    if (dest.key === "crm.leads" && !norm.some((c) => /\b(lead|source|prospect|value|stage|next step)\b/.test(c)) && !nameHit) conf -= 0.2;
    if (dest.key === "crm.companies" && norm.some((c) => /\b(lead|prospect|source|estimated value|next step)\b/.test(c))) conf -= 0.15;
    conf = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
    if (!best || conf > best.confidence) best = { dest, confidence: conf, mapping };
  }
  if (!best || best.confidence < 0.5) {
    return { destination: null, confidence: best?.confidence ?? 0, mapping: Object.fromEntries(columns.map((c) => [c, null])) as Record<string, string | null> };
  }
  return { destination: best.dest.key, confidence: best.confidence, mapping: best.mapping };
}

// ---------------- values ----------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoOf(y: number, m: number, d: number): string | null {
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** Reads a date written in the sheet into YYYY-MM-DD using the chosen order. */
export function parseDate(raw: string, fmt: "dmy" | "mdy" | "ymd" = "dmy"): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return isoOf(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/.exec(s);
  if (m) {
    const [a, b, c] = [+m[1]!, +m[2]!, +m[3]!];
    if (m[1]!.length === 4) return isoOf(a, b, c);
    return fmt === "mdy" ? isoOf(c, a, b) : isoOf(c, b, a);
  }
  // "3 Feb 2021", "3 February 2021", "Feb 3, 2021"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{2,4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return mi >= 0 ? isoOf(+m[3]!, mi + 1, +m[1]!) : null;
  }
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    return mi >= 0 ? isoOf(+m[3]!, mi + 1, +m[2]!) : null;
  }
  return null;
}

/** Guesses the day/month order from sample values. British default. */
export function guessDateFormat(samples: string[]): "dmy" | "mdy" | "ymd" {
  let dmy = 0, mdy = 0, ymd = 0;
  for (const s of samples) {
    const t = s.trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) { ymd++; continue; }
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-]\d{2,4}$/.exec(t);
    if (!m) continue;
    if (+m[1]! > 12) dmy++;
    else if (+m[2]! > 12) mdy++;
  }
  if (mdy > dmy) return "mdy";
  if (dmy === 0 && mdy === 0 && ymd > 0) return "ymd";
  return "dmy";
}

export function parseNumber(raw: string): number | null {
  const s = raw.replace(/[\s,₦$£€]|NGN|GHS|KES|ZAR|USD|GBP/gi, "");
  if (!s) return null;
  let mult = 1;
  let t = s;
  if (/[kK]$/.test(t)) { mult = 1_000; t = t.slice(0, -1); } else if (/[mM]$/.test(t)) { mult = 1_000_000; t = t.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t) * mult;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------- file parsing ----------------

export type ParsedSheet = { name: string; columns: string[]; rows: { rowNumber: number; data: Record<string, string> }[] };

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join("");
    if ("result" in o) return cellToString(o.result as ExcelJS.CellValue);
    if ("text" in o) return cellToString(o.text as ExcelJS.CellValue);
    if ("error" in o) return "";
    return "";
  }
  return String(v);
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function fromMatrix(name: string, matrix: { rowNumber: number; cells: string[] }[]): ParsedSheet | null {
  const nonEmpty = matrix.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return null;
  const head = nonEmpty[0]!;
  let width = head.cells.length;
  while (width > 0 && !head.cells[width - 1]!.trim()) width--;
  const columns = uniqueHeaders(head.cells.slice(0, width));
  const rows = nonEmpty.slice(1).map((r) => ({
    rowNumber: r.rowNumber,
    data: Object.fromEntries(columns.map((c, i) => [c, (r.cells[i] ?? "").trim()])),
  })).filter((r) => Object.values(r.data).some((v) => v !== ""));
  return { name, columns, rows };
}

export async function parseWorkbook(fileName: string, buf: Buffer): Promise<ParsedSheet[]> {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "csv") {
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const res = Papa.parse<string[]>(text, { skipEmptyLines: false });
    const matrix = res.data.map((cells, i) => ({ rowNumber: i + 1, cells: (cells ?? []).map((c) => String(c ?? "")) }));
    const sheet = fromMatrix(fileName.replace(/\.[^.]+$/, ""), matrix);
    return sheet ? [sheet] : [];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    const matrix: { rowNumber: number; cells: string[] }[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellToString(row.getCell(c).value));
      matrix.push({ rowNumber, cells });
    });
    const sheet = fromMatrix(ws.name, matrix);
    if (sheet) out.push(sheet);
  });
  return out;
}
