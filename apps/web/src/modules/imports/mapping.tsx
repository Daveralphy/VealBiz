import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowRight } from "lucide-react";
import { Avatar, Button, EmptyState, Notice, PageHeader, Pill } from "@windveal/ui";
import { IMPORT_KEEP } from "@windveal/shared";
import { fmtDate } from "../../lib/format";
import { usePatchSheets } from "./sheets";
import { DATE_FORMATS, ErrorNotice, JobGate, Stepper, activeSheets, destOf, plural, useSummary, type Job, type Sheet } from "./shared";

export function MappingPage() {
  const { id } = useParams();
  return <JobGate id={id}>{(job) => <Mapping job={job} />}</JobGate>;
}

/** The row-1 preview: applies the current mapping to the first row of the sheet. */
function previewValues(job: Job, sheet: Sheet) {
  const dest = destOf(job, sheet.destination);
  const row = sheet.preview[0]?.data ?? {};
  const out: { key: string; label: string; value: string; unsure: boolean }[] = [];
  for (const f of dest?.fields ?? []) {
    const col = Object.keys(sheet.mapping).find((c) => sheet.mapping[c] === f.key);
    if (!col || !row[col]) continue;
    out.push({ key: f.key, label: f.label, value: row[col]!, unsure: (sheet.fieldConfidence[col] ?? 0) < 0.9 });
  }
  // Columns kept as extra details appear on the record under their own name.
  for (const col of sheet.columns) {
    if (sheet.mapping[col] === IMPORT_KEEP && row[col]) out.push({ key: `extra:${col}`, label: col, value: row[col]!, unsure: false });
  }
  return out;
}

function Mapping({ job }: { job: Job }) {
  const nav = useNavigate();
  const sheets = activeSheets(job);
  const [tab, setTab] = useState(sheets[0]?.name ?? "");
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const patch = usePatchSheets(job);
  const summary = useSummary(job.id);
  const sheet = sheets.find((s) => s.name === tab) ?? sheets[0];

  if (!sheet) {
    return (
      <div className="imp">
        <PageHeader title="Match your columns" />
        <Stepper current={2} />
        <EmptyState title="No sheets to import" action={<Button onClick={() => nav(`/import/${job.id}/sheets`)}>Back to sheets</Button>}>
          Choose at least one sheet and where it should go.
        </EmptyState>
      </div>
    );
  }
  const dest = destOf(job, sheet.destination)!;
  const used = new Set(Object.values(sheet.mapping).filter(Boolean));
  const missing = dest.fields.filter((f) => f.required && !(f.key === "fullName" ? used.has("fullName") || used.has("firstName") : used.has(f.key)));
  const sheetMissing = (s: Sheet) => {
    const d = destOf(job, s.destination);
    const u = new Set(Object.values(s.mapping).filter(Boolean));
    return (d?.fields ?? []).some((f) => f.required && !(f.key === "fullName" ? u.has("fullName") || u.has("firstName") : u.has(f.key)));
  };
  const blocked = sheets.some(sheetMissing);
  const isField = (v: string | null | undefined) => !!v && v !== IMPORT_KEEP;
  const unsure = sheet.columns.filter((c) => isField(sheet.mapping[c]) && (sheet.fieldConfidence[c] ?? 0) < 0.9 && !confirmed[`${sheet.name}:${c}`]);
  const preview = previewValues(job, sheet);
  const name = preview.find((p) => p.key === "fullName" || p.key === "name" || p.key === "companyName" || p.key === "title")?.value
    ?? [preview.find((p) => p.key === "firstName")?.value, preview.find((p) => p.key === "lastName")?.value].filter(Boolean).join(" ");
  const managerBlank = summary.data?.managers.blank ?? 0;

  const setField = (col: string, field: string) => {
    setConfirmed((c) => ({ ...c, [`${sheet.name}:${col}`]: true }));
    patch.mutate([{ name: sheet.name, mapping: { [col]: field || null } }]);
  };

  return (
    <div className="imp">
      <PageHeader title="Match your columns" subtitle="We matched most columns for you. Columns without a matching field are kept as extra details; nothing is left out unless you choose Skip." />
      <Stepper current={2} />
      {sheets.length > 1 && (
        <div className="imp-pills" role="tablist">
          {sheets.map((s) => (
            <button key={s.name} role="tab" aria-selected={s.name === sheet.name} className={s.name === sheet.name ? "on" : ""} onClick={() => setTab(s.name)}>
              {s.name}<span>{s.rowCount}</span>
            </button>
          ))}
        </div>
      )}
      <div className="grid-side imp-map-grid">
        <section className="card">
          {unsure.map((c) => {
            const f = dest.fields.find((x) => x.key === sheet.mapping[c]);
            return (
              <Notice key={c} tone="warn" icon={<AlertTriangle size={17} />}>
                <b>“{c}” might be the {f?.label.toLowerCase()}.</b>{" "}
                {f?.key === "manager"
                  ? <>We'll link each person to their manager by name.{managerBlank ? ` ${plural(managerBlank, "name")} ${managerBlank === 1 ? "doesn't" : "don't"} match anyone yet and will be left blank.` : ""}</>
                  : "Check it's right, or choose another field."}
              </Notice>
            );
          })}
          {missing.length > 0 && (
            <Notice tone="error">Match a column to <b>{missing.map((m) => m.label).join(", ")}</b>. Every {dest.noun.replace(/s$/, "")} needs it.</Notice>
          )}
          <ErrorNotice error={patch.error} />
          <div className="imp-map">
            <div className="imp-map-head hide-sm"><span>Column in your file</span><span>Example values</span><span /><span>WindVeal field</span><span>Status</span></div>
            {sheet.columns.map((c) => {
              const field = sheet.mapping[c] ?? "";
              const f = dest.fields.find((x) => x.key === field);
              const isUnsure = isField(field) && (sheet.fieldConfidence[c] ?? 0) < 0.9 && !confirmed[`${sheet.name}:${c}`];
              return (
                <div className="imp-map-row" key={c}>
                  <code className="col">{c}</code>
                  <span className="ex">{sheet.examples[c]?.join(", ") || <i className="muted">Empty</i>}</span>
                  <ArrowRight size={15} className="arrow hide-sm" />
                  <div className="pick">
                    <select className={`select ${isUnsure ? "warn" : ""}`} aria-label={`WindVeal field for ${c}`} value={field} disabled={patch.isPending}
                      onChange={(e) => setField(c, e.target.value)}>
                      {dest.fields.map((x) => <option key={x.key} value={x.key}>{x.label}{isUnsure && x.key === field ? "?" : ""}</option>)}
                      <option value={IMPORT_KEEP}>Keep as extra detail (“{c}”)</option>
                      <option value="">Skip this column</option>
                    </select>
                    {f?.type === "date" && (
                      <select className="imp-datefmt" aria-label="Date format" value={sheet.dateFormat ?? "dmy"} disabled={patch.isPending}
                        onChange={(e) => patch.mutate([{ name: sheet.name, dateFormat: e.target.value }])}>
                        {DATE_FORMATS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    )}
                  </div>
                  <span className="st">{!field ? <Pill tone="grey">Skipped</Pill> : field === IMPORT_KEEP ? <Pill tone="blue">Kept</Pill> : isUnsure ? <Pill tone="warn">Check this</Pill> : <Pill tone="ok">Matched</Pill>}</span>
                </div>
              );
            })}
          </div>
        </section>
        <aside className="card imp-preview">
          <div className="section-label">Preview: row 1</div>
          {preview.length ? (
            <>
              <div className="row imp-preview-who">
                <Avatar name={name || "?"} size={38} />
                <div><b>{name || "No name yet"}</b><small>New {dest.noun.replace(/s$/, "")} record</small></div>
              </div>
              <dl className="kv">
                {preview.filter((p) => !["fullName", "firstName", "lastName", "name", "companyName", "title"].includes(p.key)).map((p) => (
                  <div key={p.key}>
                    <dt>{p.label}</dt>
                    <dd className={p.unsure ? "imp-unsure" : undefined}>
                      {p.key === "startDate" && /^\d{4}-\d{2}-\d{2}/.test(p.value) ? fmtDate(p.value, { day: "numeric", month: "long", year: "numeric" }) : p.value}{p.unsure ? "?" : ""}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : <p className="muted">Match some columns to see how the first row will look.</p>}
        </aside>
      </div>
      <div className="imp-foot">
        <button className="btn btn-ghost" onClick={() => nav(`/import/${job.id}/sheets`)}><ArrowLeft size={16} />Back</button>
        <div className="imp-foot-r">
          {blocked && <span className="muted hide-sm">Some sheets still need a required field.</span>}
          <Button disabled={blocked || patch.isPending} onClick={() => nav(`/import/${job.id}/review`)}>Continue to review<ArrowRight size={16} /></Button>
        </div>
      </div>
    </div>
  );
}
