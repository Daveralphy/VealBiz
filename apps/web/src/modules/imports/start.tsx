import { useRef, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button, Card, EmptyState, Loading, Notice, PageHeader, Pill } from "@windveal/ui";
import { api } from "../../lib/api";
import { dayLabel } from "../../lib/format";
import { ErrorNotice, Stepper, type Destination, type Job } from "./shared";

const MAX_BYTES = 20 * 1024 * 1024;

const TEMPLATES = [
  { key: "people.employees", title: "Employees", ws: "People & HR" },
  { key: "crm.companies", title: "Clients and contacts", ws: "CRM" },
  { key: "crm.leads", title: "Leads", ws: "CRM" },
  { key: "recruitment.jobs", title: "Job openings", ws: "Recruitment" },
];

type HistoryItem = {
  id: string; fileName: string; status: Job["status"]; createdAt: string; committedAt: string | null; createdByName: string;
  workspaces: string[]; added: number; updated: number; failed: number;
};

function ResultPill({ h }: { h: HistoryItem }) {
  if (h.status === "committed") return <Pill tone={h.failed ? "warn" : "ok"}>{h.added} added{h.failed ? ` · ${h.failed} not added` : ""}</Pill>;
  if (h.status === "undone") return <Pill tone="grey">Undone</Pill>;
  if (h.status === "cancelled") return <Pill tone="grey">Cancelled</Pill>;
  if (h.status === "failed") return <Pill tone="red">Failed</Pill>;
  return <Pill tone="blue">Not finished</Pill>;
}

export function StartPage() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const dests = useQuery({ queryKey: ["import-destinations"], queryFn: () => api.get<{ destinations: Destination[]; canImport: boolean }>("/api/imports/destinations") });
  const canImport = dests.data?.canImport ?? true;

  async function pick(file: File | undefined) {
    setError(null);
    setLocalError(null);
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "xlsx" && ext !== "csv") return setLocalError("Use an Excel (.xlsx) or CSV file.");
    if (file.size > MAX_BYTES) return setLocalError("That file is larger than 20 MB. Split it into smaller files and try again.");
    setBusy(true);
    try {
      const r = await api.upload<{ job: Job }>("/api/imports/upload", file);
      nav(`/import/${r.job.id}/sheets`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (canImport && !busy) pick(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="imp">
      <PageHeader title="Import data" subtitle="Bring in the spreadsheets you already use. You'll review everything before it's added." />
      <Stepper current={0} />
      {!canImport && (
        <Notice tone="warn">You need manage access to People & HR, CRM or Recruitment to import data. Ask an admin if you need it.</Notice>
      )}
      <section className="card imp-drop-card">
        <div className={`imp-drop ${drag ? "drag" : ""} ${!canImport ? "off" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (canImport) setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <span className="imp-drop-ic">{busy ? <span className="spinner" /> : <Upload size={24} />}</span>
          <h2>{busy ? "Reading your file…" : "Drop your file here"}</h2>
          <p>Excel (.xlsx) or CSV, up to 20 MB. Nothing is added until you confirm.</p>
          <input ref={input} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
            onChange={(e) => pick(e.target.files?.[0])} />
          <Button size="lg" disabled={!canImport} loading={busy} onClick={() => input.current?.click()}>Choose a file</Button>
          <small>Staff lists, client lists, leads and job openings. One file can have several sheets.</small>
        </div>
        {localError && <Notice tone="error">{localError}</Notice>}
        <ErrorNotice error={error} />
      </section>

      <Card title="Not sure how to lay out your file?" subtitle="Start from a template. It's optional, any layout works.">
        <div className="imp-templates">
          {TEMPLATES.map((t) => (
            <a key={t.key} className="imp-template" href={`/api/imports/templates/${t.key}`} download>
              <span className="ic"><FileSpreadsheet size={18} /></span>
              <span className="tx"><b>{t.title}</b><small>{t.ws}</small></span>
              <Download size={16} className="muted" aria-label="Download template" />
            </a>
          ))}
        </div>
      </Card>

    </div>
  );
}

export function useImportHistory() {
  return useQuery({ queryKey: ["import-history"], queryFn: () => api.get<HistoryItem[]>("/api/imports/jobs") });
}
export type { HistoryItem };
export { ResultPill };

/** Every import, newest first, with what was added and a way back into unfinished ones. */
export function HistoryPage() {
  const nav = useNavigate();
  const history = useImportHistory();
  return (
    <div className="imp">
      <PageHeader title="Import data" subtitle="Every file you've imported, and what it added." />
      <Card>
        {history.isLoading ? <Loading /> : history.error ? <ErrorNotice error={history.error} /> : !history.data?.length ? (
          <EmptyState title="No imports yet">Files you import will be listed here, with what was added.</EmptyState>
        ) : (
          <div className="imp-history">
            <div className="imp-history-head hide-sm"><span>File</span><span>Added to</span><span>Date</span><span>Result</span><span /></div>
            {history.data.map((h) => {
              const done = ["committed", "undone", "failed"].includes(h.status);
              const open = ["uploaded", "mapping", "reviewing"].includes(h.status);
              return (
                <div className="imp-history-row" key={h.id}>
                  <span className="file"><b>{h.fileName}</b><small>by {h.createdByName}</small></span>
                  <span className="ws">{h.workspaces.join(", ") || "—"}</span>
                  <span className="date">{dayLabel(h.committedAt ?? h.createdAt)}</span>
                  <span><ResultPill h={h} /></span>
                  <span className="act">
                    {done && <button className="btn btn-ghost" onClick={() => nav(`/import/${h.id}/result`)}>View</button>}
                    {open && <button className="btn btn-ghost" onClick={() => nav(`/import/${h.id}/sheets`)}>Continue</button>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
