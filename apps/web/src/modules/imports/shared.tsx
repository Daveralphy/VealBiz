import { Fragment, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button, EmptyState, Loading, Notice } from "@windveal/ui";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../../lib/api";

export type FieldDef = { key: string; label: string; required: boolean; type: "text" | "email" | "date" | "number" };
export type Destination = {
  key: string; label: string; workspace: string; workspaceLabel: string; noun: string; hint: string; allowed: boolean; fields: FieldDef[];
};
export type Sheet = {
  name: string; columns: string[]; rowCount: number; include: boolean; destination: string | null; confidence: number;
  mapping: Record<string, string | null>; dateFormat?: "dmy" | "mdy" | "ymd";
  fieldConfidence: Record<string, number>; examples: Record<string, string[]>; preview: { rowNumber: number; data: Record<string, string> }[];
};
export type Job = {
  id: string; fileName: string; status: "uploaded" | "mapping" | "reviewing" | "committed" | "cancelled" | "failed" | "undone";
  createdAt: string; committedAt: string | null; undoUntil: string | null; canUndo: boolean; createdBy: string; createdByName: string;
  summary: Record<string, number>; sheets: Sheet[]; destinations: Destination[];
};
export type Row = {
  id: string; sheet: string; rowNumber: number; data: Record<string, string>; values: Record<string, string>;
  status: "ready" | "duplicate" | "invalid" | "excluded" | "imported" | "failed"; issues: { field?: string; message: string }[];
  decision: "skip" | "update" | "create" | null; duplicateOfId: string | null; label: string; destination: string | null;
  edits: Record<string, string>; error: string | null;
};
export type Counts = { all: number; ready: number; attention: number; excluded: number; failed: number; imported: number; willImport: number };
export type Summary = {
  destinations: { destination: string; label: string; workspace: string; workspaceLabel: string; noun: string; new: number; updated: number; skipped: number; excluded: number; invalid: number; departments: number; contacts: number }[];
  newDepartments: number; duplicates: { skip: number; update: number; create: number }; managers: { linked: number; blank: number };
  dateFormat: "dmy" | "mdy" | "ymd"; skippedSheets: { name: string; rowCount: number }[];
  notImported: { skippedSheetRows: number; excluded: number; invalid: number; skipped: number }; toImport: number;
};

export const DATE_FORMATS = [
  { value: "dmy", label: "Day / month / year" },
  { value: "mdy", label: "Month / day / year" },
  { value: "ymd", label: "Year / month / day" },
] as const;
export const dateFormatLabel = (f: string | undefined) => DATE_FORMATS.find((d) => d.value === f)?.label ?? "Day / month / year";

export const jobKey = (id: string) => ["import-job", id];

export function useJob(id: string | undefined) {
  return useQuery({ queryKey: jobKey(id ?? ""), queryFn: () => api.get<{ job: Job }>(`/api/imports/jobs/${id}`).then((r) => r.job), enabled: !!id });
}

export function useRefreshImport(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["import-rows", id] });
    qc.invalidateQueries({ queryKey: ["import-summary", id] });
  };
}

export function useSummary(id: string) {
  return useQuery({ queryKey: ["import-summary", id], queryFn: () => api.get<{ summary: Summary }>(`/api/imports/jobs/${id}/summary`).then((r) => r.summary) });
}

export const destOf = (job: Job, key: string | null | undefined) => job.destinations.find((d) => d.key === key) ?? null;
export const activeSheets = (job: Job) => job.sheets.filter((s) => s.include && s.destination);

/** Where people go to see what was imported. */
export const WORKSPACE_LINKS: Record<string, { to: string; label: string }> = {
  "people.employees": { to: "/people/directory", label: "View employees" },
  "crm.companies": { to: "/crm/companies", label: "View companies" },
  "crm.leads": { to: "/crm/leads", label: "View leads" },
  "recruitment.jobs": { to: "/recruitment/jobs", label: "View job openings" },
};

const STEPS = ["Upload", "Sheets", "Map fields", "Review", "Import"];

export function Stepper({ current }: { current: number }) {
  return (
    <ol className="imp-steps" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className={`imp-line ${i <= current ? "done" : ""}`} aria-hidden />}
          <li className={`imp-step ${i < current ? "done" : i === current ? "on" : ""}`} aria-current={i === current ? "step" : undefined}>
            <span className="dot">{i < current ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
            <span className="lbl">{s}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** Loads the job, handles loading/error/finished states, and renders children with it. */
export function JobGate({ id, children, allowFinished }: { id: string | undefined; children: (job: Job) => ReactNode; allowFinished?: boolean }) {
  const q = useJob(id);
  const nav = useNavigate();
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) {
    return (
      <EmptyState title="We couldn't open this import" action={<Button onClick={() => nav("/import")}>Back to Import data</Button>}>
        {q.error instanceof ApiError ? q.error.message : "Please try again."}
      </EmptyState>
    );
  }
  const job = q.data;
  if (!allowFinished && !["uploaded", "mapping", "reviewing"].includes(job.status)) {
    if (job.status === "committed" || job.status === "undone") {
      return (
        <EmptyState title="This import is finished" action={<Button onClick={() => nav(`/import/${job.id}/result`)}>See the result</Button>}>
          Nothing more can be changed here.
        </EmptyState>
      );
    }
    return <EmptyState title="This import was cancelled" action={<Button onClick={() => nav("/import/new")}>Start a new import</Button>} />;
  }
  return <>{children(job)}</>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice tone="error">{error instanceof ApiError ? error.message : "Something went wrong. Please try again."}</Notice>;
}

/** CSV for the "Download list" button. Cells starting with = + - @ are made safe for spreadsheets. */
export function downloadCsv(fileName: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
