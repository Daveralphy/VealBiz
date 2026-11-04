import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Ban, Briefcase, Check, Download, Info, RotateCcw, UserPlus, Users } from "lucide-react";
import { Button, Card, Checkbox, ConfirmDialog, Loading, Notice, PageHeader, Pill, useToast } from "@windveal/ui";
import { api } from "../../lib/api";
import { fmtDate, timeAgo } from "../../lib/format";
import {
  ErrorNotice, JobGate, Stepper, WORKSPACE_LINKS, dateFormatLabel, downloadCsv, jobKey, plural, useSummary, type Job, type Row,
} from "./shared";

const WS_ICON: Record<string, JSX.Element> = {
  people: <Users size={17} />, crm: <Briefcase size={17} />, recruitment: <UserPlus size={17} />,
};

export function ConfirmPage() {
  const { id } = useParams();
  return <JobGate id={id}>{(job) => <Confirm job={job} />}</JobGate>;
}

function Confirm({ job }: { job: Job }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [checked, setChecked] = useState(false);
  const summary = useSummary(job.id);
  const commit = useMutation({
    mutationFn: () => api.post<{ job: Job }>(`/api/imports/jobs/${job.id}/commit`, { confirm: true }),
    onSuccess: (r) => {
      qc.setQueryData(jobKey(job.id), r.job);
      qc.invalidateQueries({ queryKey: ["import-history"] });
      toast(`${r.job.summary.added ?? 0} records added`);
      nav(`/import/${job.id}/result`);
    },
  });
  if (summary.isLoading) return <Loading />;
  if (!summary.data) return <ErrorNotice error={summary.error} />;
  const s = summary.data;
  const notImported = s.notImported.skippedSheetRows + s.notImported.excluded + s.notImported.invalid + s.notImported.skipped;
  const hasEmployees = s.destinations.some((d) => d.destination === "people.employees");
  const hasDates = job.sheets.some((sh) => sh.include && Object.values(sh.mapping).includes("startDate"));
  const dup = s.duplicates;
  const dupParts = [dup.skip && `${dup.skip} skipped`, dup.update && `${dup.update} will update an existing record`, dup.create && `${dup.create} added as new`].filter(Boolean);

  return (
    <div className="imp">
      <PageHeader title="Ready to import" subtitle="Here's exactly what will be added. You can undo this import for 24 hours." />
      <Stepper current={4} />
      <div className="imp-sum-cards">
        {s.destinations.map((d) => {
          const parts = [
            `new ${d.noun}`,
            d.updated ? `${d.updated} updated` : null,
            d.destination === "crm.companies" && d.contacts ? plural(d.contacts, "contact") : null,
            (d.destination === "people.employees" || d.destination === "recruitment.jobs") && d.departments ? `${plural(d.departments, "new department")}` : null,
          ].filter(Boolean);
          return (
            <div className="card imp-sum" key={d.destination}>
              <div className="imp-sum-h">{WS_ICON[d.workspace]}{d.workspaceLabel}</div>
              <b>{d.new.toLocaleString("en-GB")}</b>
              <small>{parts.join(" · ")}</small>
            </div>
          );
        })}
        <div className="card imp-sum">
          <div className="imp-sum-h"><Ban size={17} />Not imported</div>
          <b>{notImported.toLocaleString("en-GB")}</b>
          <small>
            {[
              ...s.skippedSheets.map((sh) => `${sh.rowCount} ${sh.name.toLowerCase()} skipped`),
              s.notImported.excluded && `${s.notImported.excluded} left out`,
              s.notImported.invalid && `${s.notImported.invalid} need fixing`,
              s.notImported.skipped && `${s.notImported.skipped} duplicates skipped`,
            ].filter(Boolean).join(" · ") || "Nothing left behind"}
          </small>
        </div>
      </div>

      <Card title="Before you import">
        <dl className="imp-before">
          <div><dt>Possible duplicates</dt><dd>{dupParts.length ? dupParts.join(", ") : "None found"}</dd></div>
          {hasEmployees && <div><dt>Managers linked by name</dt><dd>{s.managers.linked} linked, {s.managers.blank} left blank</dd></div>}
          {hasDates && <div><dt>Dates read as</dt><dd>{dateFormatLabel(s.dateFormat)}</dd></div>}
          {s.notImported.invalid > 0 && <div><dt>Rows with problems</dt><dd>{plural(s.notImported.invalid, "row")} won't be imported until fixed</dd></div>}
          <div><dt>Storage used</dt><dd>None. Your file isn't kept.</dd></div>
        </dl>
        <div className="imp-reviewed">
          <Checkbox label="I've reviewed these changes" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        </div>
      </Card>
      <Notice tone="info" icon={<Info size={17} />}>You can undo this import for 24 hours. Records it adds will be removed; updates to existing records stay.</Notice>
      <ErrorNotice error={commit.error} />
      <div className="imp-foot">
        <button className="btn btn-ghost" onClick={() => nav(`/import/${job.id}/review`)}><ArrowLeft size={16} />Back</button>
        <div className="imp-foot-r">
          <Button disabled={!checked || s.toImport === 0} loading={commit.isPending} onClick={() => commit.mutate()}>
            Import {plural(s.toImport, "record")}<ArrowRight size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ResultPage() {
  const { id } = useParams();
  return <JobGate id={id} allowFinished>{(job) => <Result job={job} />}</JobGate>;
}

const SEGMENTS = [
  { key: "employees", label: "employees", one: "employee", color: "var(--ok-dot)" },
  { key: "companies", label: "companies", one: "company", color: "var(--blue)" },
  { key: "leads", label: "leads", one: "lead", color: "#8b5cf6" },
  { key: "jobs", label: "job openings", one: "job opening", color: "#e0a32e" },
  { key: "updated", label: "updated", one: "updated", color: "#9aa6c4" },
  { key: "failed", label: "not added", one: "not added", color: "#e5484d" },
];

function Result({ job }: { job: Job }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmUndo, setConfirmUndo] = useState(false);
  const failed = useQuery({
    queryKey: ["import-rows", job.id, "failed"], enabled: (job.summary.failed ?? 0) > 0,
    queryFn: () => api.get<{ rows: Row[] }>(`/api/imports/jobs/${job.id}/rows?tab=failed&pageSize=200`).then((r) => r.rows),
  });
  const undo = useMutation({
    mutationFn: () => api.post<{ job: Job; removed: number }>(`/api/imports/jobs/${job.id}/undo`),
    onSuccess: (r) => {
      qc.setQueryData(jobKey(job.id), r.job);
      qc.invalidateQueries({ queryKey: ["import-history"] });
      setConfirmUndo(false);
      toast(`Import undone. ${plural(r.removed, "record")} removed.`);
    },
  });

  if (job.status !== "committed" && job.status !== "undone") {
    return <Notice tone="warn">This import hasn't been added yet. <button className="btn btn-ghost" onClick={() => nav(`/import/${job.id}/sheets`)}>Continue it</button></Notice>;
  }
  const s = job.summary;
  const added = s.added ?? 0, updated = s.updated ?? 0, fails = s.failed ?? 0;
  const total = s.total ?? added + updated + fails;
  const segs = SEGMENTS.map((x) => ({ ...x, n: s[x.key] ?? 0 })).filter((x) => x.n > 0);
  const barTotal = Math.max(1, segs.reduce((a, x) => a + x.n, 0));
  const destKeys = Array.from(new Set(job.sheets.filter((sh) => sh.include && sh.destination).map((sh) => sh.destination!)));
  const undone = job.status === "undone";

  const download = () => {
    const rows = failed.data ?? [];
    const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r.data))));
    downloadCsv(`${job.fileName.replace(/\.[^.]+$/, "")}-not-added.csv`, ["Sheet", "Row", "Reason", ...cols], rows.map((r) => [r.sheet, r.rowNumber, r.error ?? "", ...cols.map((c) => r.data[c] ?? "")]));
  };

  return (
    <div className="imp">
      <PageHeader title={undone ? "Import undone" : "Import finished"} subtitle={`${job.fileName} · ${undone ? "undone" : `finished ${timeAgo(job.committedAt).toLowerCase()}`}`}
        back={{ label: "Import data", onClick: () => nav("/import") }} />
      <section className="card imp-result">
        <span className={`imp-result-ic ${undone ? "grey" : ""}`}>{undone ? <RotateCcw size={26} /> : <Check size={28} strokeWidth={2.6} />}</span>
        <h2>{undone ? `${plural(added, "record")} removed` : `${(added + updated).toLocaleString("en-GB")} of ${plural(total, "record")} added`}</h2>
        <p>
          {undone ? "Everything this import added has been removed. Updates to existing records were kept."
            : fails ? `Everything else is in place. ${plural(fails, "record")} couldn't be added. Download the list to sort them out later.`
              : "Everything is in place."}
        </p>
        {!undone && segs.length > 0 && (
          <>
            <div className="imp-bar" aria-hidden>{segs.map((x) => <i key={x.key} style={{ width: `${(x.n / barTotal) * 100}%`, background: x.color }} />)}</div>
            <div className="imp-legend">{segs.map((x) => <span key={x.key}><i style={{ background: x.color }} />{x.n} {x.n === 1 ? x.one : x.label}</span>)}</div>
          </>
        )}
        {!undone && (s.departments ?? 0) > 0 && <small className="muted">{plural(s.departments!, "new department")} created.</small>}
      </section>

      {!undone && fails > 0 && (
        <Card title={`${plural(fails, "record")} ${fails === 1 ? "wasn't" : "weren't"} added`} subtitle="The rest of your import isn't affected."
          actions={<Button variant="secondary" icon={<Download size={16} />} disabled={!failed.data} onClick={download}>Download list</Button>}>
          {failed.isLoading ? <Loading /> : (
            <div className="imp-failed">
              {(failed.data ?? []).map((r) => (
                <div key={r.id} className="imp-failed-row">
                  <Pill tone="red">Row {r.rowNumber}</Pill>
                  <b>{r.label || "—"}</b>
                  <span className="muted">{r.error}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      <ErrorNotice error={undo.error} />
      <div className="imp-foot">
        <div>
          {job.canUndo && (
            <button className="btn btn-ghost" onClick={() => setConfirmUndo(true)}><RotateCcw size={16} />Undo this import</button>
          )}
          {job.canUndo && job.undoUntil && <small className="muted imp-undo-note">Until {fmtDate(job.undoUntil, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>}
        </div>
        <div className="imp-foot-r">
          {!undone && destKeys.map((k, i) => WORKSPACE_LINKS[k] && (
            <Button key={k} variant={i === destKeys.length - 1 ? "primary" : "secondary"} onClick={() => nav(WORKSPACE_LINKS[k]!.to)}>
              {WORKSPACE_LINKS[k]!.label}{i === destKeys.length - 1 && <ArrowRight size={16} />}
            </Button>
          ))}
          {undone && <Button onClick={() => nav("/import/new")}>Start a new import</Button>}
        </div>
      </div>
      <ConfirmDialog open={confirmUndo} onClose={() => setConfirmUndo(false)} onConfirm={() => undo.mutate()} loading={undo.isPending}
        title="Undo this import?" confirmLabel="Undo import" danger>
        <p>The {plural(added, "record")} this import added will be removed. {updated ? `The ${plural(updated, "existing record")} it updated will stay as they are now.` : ""}</p>
      </ConfirmDialog>
    </div>
  );
}
