import { useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Calendar, Download, Lock, ShieldCheck } from "lucide-react";
import { Button, EmptyState, Modal, PageHeader } from "@windveal/ui";
import { qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { OverviewPage } from "./overview";
import { ReportPage, useReport } from "./report";
import { RANGES, REPORT_TABS } from "./shared";
import "./insights.css";

export default function InsightsModule() {
  const { can, hasSpecial } = useSession();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const range = RANGES.some((r) => r.value === params.get("range")) ? params.get("range")! : "3m";
  const owner = params.get("owner") ?? "everyone";
  const section = pathname.replace(/^\/insights\/?/, "").split("/")[0] ?? "";
  const [exporting, setExporting] = useState(false);

  if (!can("insights", "view")) {
    return (
      <>
        <PageHeader title="Insights" />
        <EmptyState icon={<Lock size={22} />} title="You don't have access to Insights">Ask an admin if you need to see reports.</EmptyState>
      </>
    );
  }
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <div className="ins">
      <PageHeader title="Insights" subtitle="Built from your records · updated just now"
        actions={<>
          <label className="ins-range">
            <Calendar size={16} />
            <select aria-label="Period" value={range} onChange={(e) => setParam("range", e.target.value)}>
              {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          {hasSpecial("export_data") && (
            <Button variant="secondary" icon={<Download size={16} />} onClick={() => setExporting(true)}>Export</Button>
          )}
        </>} />
      <Routes>
        <Route index element={<OverviewPage range={range} />} />
        {REPORT_TABS.filter((t) => t.key).map((t) => (
          <Route key={t.key} path={t.key} element={<ReportPage name={t.key} range={range} owner={owner} setOwner={(o) => setParam("owner", o)} />} />
        ))}
        <Route path="*" element={<EmptyState title="That report doesn't exist" action={<Button onClick={() => nav("/insights")}>Back to Insights</Button>} />} />
      </Routes>
      {exporting && <ExportModal initial={section || "sales"} range={range} owner={owner} onClose={() => setExporting(false)} />}
    </div>
  );
}

function ExportModal({ initial, range, owner, onClose }: { initial: string; range: string; owner: string; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const report = useReport(name, range, owner);
  const columns = report.data?.table.columns ?? [];
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  useEffect(() => setPicked({}), [name]);
  const chosen = columns.filter((c) => picked[c.key] !== false).map((c) => c.key);
  const rows = report.data?.table.rows.length ?? 0;
  const ownerName = report.data?.filters?.owners.find((o) => o.id === owner)?.name;
  const subtitle = [RANGES.find((r) => r.value === range)?.label, name === "sales" ? (ownerName ?? "everyone") : null].filter(Boolean).join(" · ");

  const download = () => {
    const url = `/api/insights/reports/${name}/export${qs({ format, range, owner: name === "sales" ? owner : undefined, columns: chosen.join(",") })}`;
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  };

  return (
    <Modal open onClose={onClose} title={`Export ${report.data?.title.toLowerCase() ?? "report"}`} subtitle={subtitle}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={<Download size={16} />} disabled={!chosen.length || !report.data || report.data.restricted} onClick={download}>
          Export {rows} row{rows === 1 ? "" : "s"}
        </Button>
      </>}>
      <div className="stack">
        <select className="select" aria-label="Report" value={name} onChange={(e) => setName(e.target.value)}>
          {REPORT_TABS.filter((t) => t.key).map((t) => <option key={t.key} value={t.key}>{t.label} report</option>)}
        </select>
        <div className="ins-formats" role="radiogroup" aria-label="File type">
          <button role="radio" aria-checked={format === "xlsx"} className={format === "xlsx" ? "on" : ""} onClick={() => setFormat("xlsx")}>
            <span className="ic xls">XLS</span><span><b>Excel</b><small>.xlsx with formatting</small></span>
          </button>
          <button role="radio" aria-checked={format === "csv"} className={format === "csv" ? "on" : ""} onClick={() => setFormat("csv")}>
            <span className="ic">CSV</span><span><b>CSV</b><small>Plain data for other tools</small></span>
          </button>
        </div>
        <div>
          <div className="section-label" style={{ marginBottom: 10 }}>Columns</div>
          <div className="ins-cols">
            {columns.map((c) => (
              <label key={c.key} className="check">
                <input type="checkbox" checked={picked[c.key] !== false} onChange={(e) => setPicked((p) => ({ ...p, [c.key]: e.target.checked }))} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
          {report.data?.restricted && <p className="field-error">You don't have access to the records behind this report.</p>}
        </div>
        <div className="ins-safe"><ShieldCheck size={16} /><span>Cells that start with =, +, - or @ are saved as plain text, so the file can't run hidden formulas when it's opened.</span></div>
        <div className="ins-safe"><Lock size={16} /><span>Only includes records you're allowed to see. This export will be recorded in the audit history.</span></div>
      </div>
    </Modal>
  );
}
