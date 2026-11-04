import { useNavigate } from "react-router-dom";
import { DashCard, DashRow } from "../../components/dashboard";
import { dayLabel } from "../../lib/format";
import { ResultPill, useImportHistory } from "./start";

const OPEN = ["uploaded", "mapping", "reviewing"];

/** Recent imports, on the Documents dashboard (Import data lives in Documents). */
export function RecentImportsCard() {
  const nav = useNavigate();
  const history = useImportHistory();
  const items = history.data ?? [];
  const openItem = (h: (typeof items)[number]) => nav(OPEN.includes(h.status) ? `/import/${h.id}/sheets` : `/import/${h.id}/result`);
  return (
    <DashCard title="Recent imports" sub="Spreadsheets brought in, and any left unfinished" link={{ to: "/import/history", label: "Import history" }} loading={history.isLoading}
      empty={!history.isLoading && !items.length && "No imports yet. Bring in a spreadsheet from Import data."}>
      {items.slice(0, 5).map((h) => (
        <DashRow key={h.id} title={h.fileName} detail={`${h.workspaces.join(", ") || "Not matched yet"} · ${dayLabel(h.committedAt ?? h.createdAt)} · by ${h.createdByName}`}
          end={<ResultPill h={h} />} onClick={() => openItem(h)} />
      ))}
    </DashCard>
  );
}
