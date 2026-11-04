import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@windveal/ui";
import { DashBars, DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { dayLabel } from "../../lib/format";
import { ResultPill, useImportHistory } from "./start";

const OPEN = ["uploaded", "mapping", "reviewing"];

/** Import data's first page: what has come in lately, and anything left unfinished. */
export function ImportDashboard() {
  const nav = useNavigate();
  const history = useImportHistory();
  const items = history.data ?? [];
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const thisMonth = items.filter((h) => h.status === "committed" && Date.parse(h.committedAt ?? h.createdAt) >= monthStart.getTime());
  const records = thisMonth.reduce((a, h) => a + h.added + h.updated, 0);
  const open = items.filter((h) => OPEN.includes(h.status));
  const finished = items.filter((h) => h.status === "committed");
  const byWorkspace = new Map<string, number>();
  for (const h of finished) for (const w of h.workspaces) byWorkspace.set(w, (byWorkspace.get(w) ?? 0) + h.added + h.updated);
  const openItem = (h: (typeof items)[number]) => nav(OPEN.includes(h.status) ? `/import/${h.id}/sheets` : `/import/${h.id}/result`);
  return (
    <div className="imp">
      <PageHeader title="Import data" subtitle="Bring in the spreadsheets you already use. You'll review everything before it's added."
        actions={<Button icon={<Plus size={16} />} onClick={() => nav("/import/new")}>New import</Button>} />
      <DashKpis loading={history.isLoading} items={[
        { label: "Finished this month", value: thisMonth.length, note: thisMonth.length ? "imports" : "none yet", to: "/import/history" },
        { label: "Records added or updated", value: records.toLocaleString("en-GB"), note: "this month" },
        { label: "Not finished", value: open.length, note: open.length ? "pick up where you left off" : "nothing waiting" },
        { label: "Last import", value: finished[0] ? dayLabel(finished[0].committedAt ?? finished[0].createdAt) : "—", note: finished[0]?.fileName ?? "no imports yet" },
      ]} />
      <DashColumns
        left={<>
          <DashCard title="Recent imports" sub="The latest files and what they added" link={{ to: "/import/history", label: "History" }} loading={history.isLoading}
            empty={!history.isLoading && !items.length && "No imports yet. Start one to bring in your spreadsheets."}>
            {items.slice(0, 5).map((h) => (
              <DashRow key={h.id} title={h.fileName} detail={`${h.workspaces.join(", ") || "Not matched yet"} · ${dayLabel(h.committedAt ?? h.createdAt)} · by ${h.createdByName}`}
                end={<ResultPill h={h} />} onClick={() => openItem(h)} />
            ))}
          </DashCard>
        </>}
        right={<>
          <DashCard title="Records by workspace" sub="Added or updated by finished imports"
            empty={!history.isLoading && !byWorkspace.size && "Nothing imported yet."} loading={history.isLoading}>
            <DashBars rows={[...byWorkspace].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, display: value.toLocaleString("en-GB") }))} />
          </DashCard>
          {!!open.length && (
            <DashCard title="Not finished" sub="Imports you started but haven't added yet">
              {open.slice(0, 5).map((h) => (
                <DashRow key={h.id} title={h.fileName} detail={`Started ${dayLabel(h.createdAt)}`} end={<Button size="sm" variant="secondary" onClick={() => openItem(h)}>Continue</Button>} />
              ))}
            </DashCard>
          )}
        </>}
      />
    </div>
  );
}
