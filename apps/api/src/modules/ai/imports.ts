import { z } from "zod";
import { IMPORT_KEEP } from "@windveal/shared";
import { chatCompletion } from "../../lib/ai";
import { badRequest, notFound } from "../../lib/http";
import type { Call } from "./tools";

type Field = { key: string; label: string; required: boolean; type: string };
type Destination = { key: string; label: string; allowed: boolean; fields: Field[] };
type Sheet = { name: string; columns: string[]; destination: string | null; mapping: Record<string, string | null>; examples: Record<string, string[]> };

export type ColumnCheck = {
  destination: string | null;
  /** What the AI thinks each column is (a field key, "keep" for an extra detail, or null to leave it out). */
  mapping: Record<string, string | null>;
  /** Columns whose meaning differs from what the header suggests, in plain words. */
  notes: string[];
  /** Columns where the AI disagrees with WindVeal's own matching. */
  changes: string[];
};

/**
 * Reads a sheet the way a person would: each column's header *and* a few of its values, so a column headed
 * "Col B" full of emails, or "Remark" holding phone numbers, is matched to what it really is. It only suggests:
 * the person applies the suggestions on the matching screen, and still reviews every row before anything is added.
 */
export async function checkColumns(call: Call, jobId: string, sheetName: string): Promise<ColumnCheck> {
  const r = await call("GET", `/api/imports/jobs/${jobId}`);
  if (r.status >= 400) throw notFound("That import");
  const job = (r.body?.job ?? r.body) as { sheets: Sheet[]; destinations: Destination[] };
  const sheet = job.sheets.find((s) => s.name === sheetName);
  if (!sheet) throw badRequest(`There's no sheet called “${sheetName}” in this file.`);
  const destinations = job.destinations.filter((d) => d.allowed);
  if (!destinations.length) throw badRequest("You can't import to any workspace.");

  const prompt = [
    "You match spreadsheet columns to fields in WindVeal, a business app. Judge each column by its sample values first and its header second: headers are often wrong, vague or missing.",
    `Sheet "${sheet.name}". Columns with up to three sample values:`,
    ...sheet.columns.map((c) => `- ${JSON.stringify(c)}: ${JSON.stringify(sheet.examples[c] ?? [])}`),
    "Where it can go, with the fields each accepts (key: label):",
    ...destinations.map((d) => `- ${d.key} (${d.label}): ${d.fields.map((f) => `${f.key}: ${f.label}${f.required ? " (required)" : ""}`).join("; ")}`),
    sheet.destination ? `WindVeal's own guess is ${sheet.destination}.` : "",
    "Reply with JSON only, no other text, in this shape:",
    `{"destination": "<a destination key or null>", "mapping": {"<column>": "<field key, or \\"keep\\" to keep it as an extra detail, or null to leave it out>"}, "notes": ["<one short sentence for each column whose real meaning differs from its header>"]}`,
    "Use each field key at most once. Include every column in mapping.",
  ].filter(Boolean).join("\n");

  const res = await chatCompletion([{ role: "user", content: prompt }], []);
  const json = (res.content ?? "").match(/\{[\s\S]*\}/)?.[0];
  const parsed = z.object({
    destination: z.string().nullable().optional(),
    mapping: z.record(z.string(), z.string().nullable()).default({}),
    notes: z.array(z.string()).default([]),
  }).safeParse((() => { try { return JSON.parse(json ?? ""); } catch { return null; } })());
  if (!parsed.success) throw badRequest("Veal couldn't read this sheet. Try again, or match the columns yourself.");

  // Only keep what WindVeal can actually use: a real destination, real columns, real fields, each field once.
  const dest = destinations.find((d) => d.key === parsed.data.destination) ?? destinations.find((d) => d.key === sheet.destination) ?? null;
  const mapping: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const col of sheet.columns) {
    const v = parsed.data.mapping[col];
    const field = v === "keep" ? IMPORT_KEEP : v && dest?.fields.some((f) => f.key === v) && !used.has(v) ? v : v === null ? null : sheet.mapping[col] ?? null;
    if (field && field !== IMPORT_KEEP) used.add(field);
    mapping[col] = field;
  }
  const changes = dest?.key === sheet.destination ? sheet.columns.filter((c) => (mapping[c] ?? null) !== (sheet.mapping[c] ?? null)) : sheet.columns;
  return { destination: dest?.key ?? null, mapping, notes: parsed.data.notes.slice(0, 10).map((n) => n.slice(0, 200)), changes };
}

/**
 * A file added in the chat: Veal reads every sheet (headers and sample values) and says, in a few lines,
 * what each one is, where it belongs in WindVeal, and anything that isn't what it seems. It doesn't add
 * anything: the reply ends with a button to Import data, where the person checks it all first.
 */
export async function describeFile(call: Call, jobId: string): Promise<{ reply: string; fileName: string; rows: number; sheets: number }> {
  const r = await call("GET", `/api/imports/jobs/${jobId}`);
  if (r.status >= 400) throw notFound("That file");
  const job = (r.body?.job ?? r.body) as { fileName: string; sheets: (Sheet & { rowCount: number })[]; destinations: Destination[] };
  const destinations = job.destinations.filter((d) => d.allowed);
  const label = (key: string | null) => destinations.find((d) => d.key === key)?.label ?? null;
  const prompt = [
    "You are Veal, the assistant in WindVeal, a business app. Someone has just added a spreadsheet in the chat.",
    `File "${job.fileName}". Its sheets, with each column's header and up to three sample values:`,
    ...job.sheets.map((s) => [
      `Sheet "${s.name}" (${s.rowCount} rows${label(s.destination) ? `, WindVeal guessed ${label(s.destination)}` : ""}):`,
      ...s.columns.map((c) => `  - ${JSON.stringify(c)}: ${JSON.stringify(s.examples[c] ?? [])}`),
    ].join("\n")),
    `Places WindVeal can bring rows into: ${destinations.map((d) => d.label).join(", ") || "none for this person"}.`,
    "Tell them what you see, in short plain English: one line starting with \"- \" per sheet saying what it holds and where it belongs (or that WindVeal can't bring it in).",
    "Then a line for any column whose values don't match its header (like \"Col B\" holding emails). Judge columns by their values, not their headers.",
    "No headings, no tables, no greeting. Use **bold** only for sheet and place names. Don't say you've added anything: nothing is added until they check it.",
  ].join("\n");
  const res = await chatCompletion([{ role: "user", content: prompt }], []);
  const reply = (res.content ?? "").trim() || `I can see ${job.sheets.length} sheet${job.sheets.length === 1 ? "" : "s"} in ${job.fileName}.`;
  return { reply: reply.slice(0, 2500), fileName: job.fileName, rows: job.sheets.reduce((n, s) => n + (s.rowCount ?? 0), 0), sheets: job.sheets.length };
}
