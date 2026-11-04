import { useMemo, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { Button, EmptyState, Loading, SearchInput, cx } from "@windveal/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dayLabel, fmtDate, isOverdue, timeAgo } from "../../lib/format";
import { useLeads, useMembers, useRefreshCrm, useSummary, type Lead } from "./data";
import { CoMark, ConvertModal, ErrorNotice, LeadDrawer, MoveTo, Owner, QualMeter, StagesModal, useAction, useCrmAccess } from "./parts";

const STAGE_HINTS = ["planned outreach", "waiting to hear back", "in conversation", "ready to convert"];
const ACT_VERB = { call: "Called", email: "Emailed", meeting: "Met", note: "Note added" } as const;

function nextLine(l: Lead): { text: string; overdue: boolean } {
  if (l.stage === "Closed") {
    return l.closedOutcome === "converted"
      ? { text: `Converted ${fmtDate(l.closedAt, { day: "numeric", month: "short" })}`, overdue: false }
      : { text: l.closedReason ?? "Not interested", overdue: false };
  }
  if (l.nextStepDue && isOverdue(l.nextStepDue)) return { text: l.nextStep ? `Overdue: ${l.nextStep}` : "Follow up overdue", overdue: true };
  if (l.nextStep) return { text: l.nextStepDue ? `${l.nextStep} · ${dayLabel(l.nextStepDue)}` : l.nextStep, overdue: false };
  if (l.lastActivity) return { text: `${ACT_VERB[l.lastActivity.type]} ${timeAgo(l.lastActivity.occurredAt).toLowerCase()}`, overdue: false };
  if (!l.contactName) return { text: "Find a contact", overdue: false };
  return { text: "No next step", overdue: false };
}

function LeadCard({ l, stages, last, canEdit, onOpen, onMove, onConvert }: {
  l: Lead; stages: string[]; last: string; canEdit: boolean; onOpen: () => void; onMove: (s: string) => void; onConvert: () => void;
}) {
  const { money } = useSession();
  const closed = l.stage === "Closed";
  const next = nextLine(l);
  const draggable = canEdit && !closed;
  const sub = closed ? (l.closedOutcome === "converted" ? "Converted to client" : "Not interested")
    : [l.contactName, l.contactRole].filter(Boolean).join(" · ") || l.contactRole || "No contact yet";
  return (
    <div className={cx("board-card crm-card", closed && "crm-card-closed", draggable && "draggable")} role="button" tabIndex={0} draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; }}
      onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="crm-card-head">
        <CoMark name={l.companyName} />
        <div className="crm-min0"><b>{l.companyName}</b><small>{sub}</small></div>
      </div>
      <div className="crm-card-foot">
        <span className={cx(next.overdue && "crm-red strong")}>{l.stage === last && l.estimatedValue ? `${money(l.estimatedValue, true)} estimated` : next.text}</span>
        <Owner name={l.ownerName} />
      </div>
      <div className="crm-card-foot crm-card-src">
        <span>{l.source ?? "No source"}</span>
        {!closed && l.qualificationScore > 0 && <QualMeter score={l.qualificationScore} />}
      </div>
      {canEdit && !closed && l.stage === last && (
        <Button block size="sm" className="crm-convert" onClick={(e) => { e.stopPropagation(); onConvert(); }}>Convert to client</Button>
      )}
      {draggable && (
        <div className="crm-card-move"><MoveTo stages={stages} value={l.stage} onMove={onMove} /></div>
      )}
    </div>
  );
}

export function LeadsPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("");
  const [source, setSource] = useState("");
  const [stagesOpen, setStagesOpen] = useState(false);
  const [converting, setConverting] = useState<Lead | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const members = useMembers();
  const summary = useSummary();
  const data = useLeads({ q: q.trim() || undefined, owner: owner || undefined, source: source || undefined });
  const { canEdit, canManage } = useCrmAccess();
  const refresh = useRefreshCrm();
  const [run] = useAction();
  const openId = params.get("lead");
  const setOpen = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set("lead", id); else p.delete("lead"); setParams(p, { replace: !id }); };
  const addLead = () => { const p = new URLSearchParams(params); p.set("new", "lead"); setParams(p); };
  const stages = data.data?.stages ?? [];
  const last = stages[stages.length - 1] ?? "";

  const columns = useMemo(() => {
    const items = data.data?.items ?? [];
    const cols = stages.map((s, i) => ({
      key: s, closed: false, items: items.filter((l) => l.stage === s),
      hint: i === stages.length - 1 ? "ready to convert" : STAGE_HINTS[Math.min(i, STAGE_HINTS.length - 2)],
    }));
    const orphan = items.filter((l) => l.stage !== "Closed" && !stages.includes(l.stage));
    if (orphan.length && cols[0]) cols[0].items.push(...orphan);
    cols.push({ key: "Closed", closed: true, items: items.filter((l) => l.stage === "Closed"), hint: "This month" });
    return cols;
  }, [data.data, stages]);

  const move = (l: Lead, stage: string) => run(async () => { await api.post(`/api/crm/leads/${l.id}/move`, { stage }); refresh(); }, `${l.companyName} moved to ${stage}`);
  const onDrop = (e: DragEvent, key: string, closed: boolean) => {
    e.preventDefault();
    setDropOn(null);
    const l = data.data?.items.find((x) => x.id === e.dataTransfer.getData("text/plain"));
    if (!l || l.stage === "Closed") return;
    if (closed) { setOpen(l.id); return; } // closing needs a reason or the convert flow
    if (l.stage !== key) void move(l, key);
  };

  const filtered = !!(q || owner || source);
  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search leads" />
        <select className="select chip-select" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Owner: All</option>
          <option value={user.id}>Owner: Me</option>
          <option value="none">Unassigned</option>
          {(members.data ?? []).filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>Owner: {m.name}</option>)}
        </select>
        <select className="select chip-select" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Source: All</option>
          {(data.data?.sources ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <span className="grow" />
        {canManage && <button className="crm-link" onClick={() => setStagesOpen(true)}>Edit lead stages</button>}
      </div>
      {data.isLoading ? <Loading /> : data.error ? <ErrorNotice error={data.error} retry={() => data.refetch()} /> : (
        data.data!.items.length === 0 && !filtered ? (
          <EmptyState icon={<Users size={24} />} title="No leads yet" action={canEdit && <Button icon={<Plus size={15} />} onClick={addLead}>Add lead</Button>}>
            Leads are people you might sell to. Qualify them, then convert them into a company and a deal.
          </EmptyState>
        ) : (
          <div className="board crm-board">
            {columns.map((col) => (
              <section key={col.key} aria-label={col.key} className={cx("board-col", col.closed && "crm-col-won", dropOn === col.key && "drop")}
                onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDropOn(col.key); } }}
                onDragLeave={() => setDropOn((x) => (x === col.key ? null : x))}
                onDrop={(e) => onDrop(e, col.key, col.closed)}>
                <h5>{col.key}</h5>
                <div className="sub">{col.closed ? col.hint : `${col.items.length} · ${col.hint}`}</div>
                {col.items.map((l) => (
                  <LeadCard key={l.id} l={l} stages={stages} last={last} canEdit={canEdit}
                    onOpen={() => setOpen(l.id)} onMove={(st) => move(l, st)} onConvert={() => setConverting(l)} />
                ))}
                {col.items.length === 0 && <div className="crm-col-empty">{col.closed ? "Nothing closed this month" : filtered ? "No matches" : "No leads"}</div>}
              </section>
            ))}
          </div>
        )
      )}
      <p className="muted crm-small crm-foot-note">
        Converting a qualified lead creates the company, contact and a deal that starts at <b className="ink">{summary.data?.dealStages[0] ?? "Qualified"}</b> in the deals pipeline.
      </p>
      <LeadDrawer id={openId} onClose={() => setOpen(null)} stages={stages} onConvert={(l) => setConverting(l)} />
      <ConvertModal lead={converting} onClose={() => setConverting(null)} />
      <StagesModal open={stagesOpen} onClose={() => setStagesOpen(false)} kind="leads" />
    </>
  );
}
