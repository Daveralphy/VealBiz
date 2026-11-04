import { useMemo, useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarClock, Plus, Users } from "lucide-react";
import { Avatar, Button, Card, EmptyState, Loading, Pill, SearchInput, cx } from "@windveal/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dayLabel, fmtDate, fmtTime, isOverdue } from "../../lib/format";
import {
  followUpKind, useDeals, useFollowUps, useMembers, useOverview, useRefreshCrm, useSummary,
  type ActivityType, type Deal, type FollowUp,
} from "./data";
import {
  CoMark, DealDrawer, ErrorNotice, FollowUpModal, FollowUpRow, LogFollowUpModal, MoveTo, Owner, StagesModal, useAction, useCrmAccess,
} from "./parts";
import { DashKpis } from "../../components/dashboard";

const STAGE_SHADES = ["#9db4f5", "#486fe4", "#263f91", "#172b63", "#6b8be9", "#3554b8", "#0e1c45"];

// ============================================================ overview

export function OverviewPage() {
  const q = useOverview();
  const { money, user } = useSession();
  const navigate = useNavigate();
  const [log, setLog] = useState<FollowUp | null>(null);
  const summary = useSummary();
  const lastLeadStage = summary.data?.leadStages[summary.data.leadStages.length - 1];
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorNotice error={q.error} retry={() => q.refetch()} />;
  const { stats, pipeline, followUps, recentWins, leadsToContact } = q.data;
  const winsThisMonth = stats.wonThisMonthCount;
  return (
    <>
      <DashKpis items={[
        { label: "Open pipeline", value: money(stats.openValue, true), note: `${stats.openCount} deal${stats.openCount === 1 ? "" : "s"}`, to: "/crm/pipeline" },
        { label: "Won this month", value: money(stats.wonThisMonth, true), note: `${winsThisMonth} deal${winsThisMonth === 1 ? "" : "s"}` },
        { label: "Win rate", value: stats.winRate === null ? "—" : `${stats.winRate}%`, note: stats.winRate === null ? "no closed deals yet" : "last 90 days" },
        { label: "Follow-ups due", value: stats.followUpsDue, note: stats.followUpsOverdue ? <span className="crm-red">{stats.followUpsOverdue} overdue</span> : "none overdue", to: "/crm/follow-ups" },
      ]} />
      <div className="crm-ov-grid">
        <Card title="Pipeline by stage" subtitle="Value of open deals at each stage"
          actions={<Link className="crm-link" to="/crm/pipeline">See all →</Link>}>
          {stats.openCount === 0 ? (
            <EmptyState title="No open deals yet" action={<Button size="sm" icon={<Plus size={15} />} onClick={() => navigate("/crm/pipeline?new=deal")}>New deal</Button>}>
              Add a deal or convert a qualified lead to start your pipeline.
            </EmptyState>
          ) : (
            <>
              <div className="crm-stackbar" role="img" aria-label="Pipeline value by stage">
                {pipeline.filter((p) => p.value > 0).map((p) => (
                  <i key={p.stage} title={`${p.stage}: ${money(p.value)}`} style={{ flexGrow: p.value, background: STAGE_SHADES[pipeline.indexOf(p) % STAGE_SHADES.length] }} />
                ))}
              </div>
              <ul className="crm-stage-list">
                {pipeline.map((p, i) => (
                  <li key={p.stage}>
                    <span className="crm-swatch" style={{ background: STAGE_SHADES[i % STAGE_SHADES.length] }} />
                    <span className="grow">{p.stage}</span>
                    <span className="muted">{p.count} deal{p.count === 1 ? "" : "s"}</span>
                    <b>{money(p.value, true)}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Card title="Recent wins" actions={<Link className="crm-link" to="/crm/pipeline">See all →</Link>}>
          {recentWins.length === 0 ? <p className="muted crm-small">No wins yet. Mark a deal as won from the pipeline.</p> : (
            <div>
              {recentWins.map((d) => (
                <Link key={d.id} to={`/crm/companies/${d.companyId}`} className="list-row crm-row-link">
                  <CoMark name={d.companyName ?? d.name} size={36} />
                  <div className="grow crm-min0">
                    <b className="ink crm-ellipsis">{d.companyName}</b>
                    <small className="muted crm-ellipsis">{d.name}{d.ownerName ? ` · won by ${d.ownerName.split(" ")[0]}` : ""} · {fmtDate(d.wonAt, { day: "numeric", month: "short" })}</small>
                  </div>
                  <b className="crm-green">{money(d.value, true)}</b>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card title="Your follow-ups" subtitle="Today and overdue" actions={<Link className="crm-link" to="/crm/follow-ups">See all →</Link>}>
          {followUps.length === 0
            ? <EmptyState icon={<CalendarClock size={24} />} title="You're all caught up">Follow-ups you add when logging calls and meetings show up here.</EmptyState>
            : followUps.map((t) => <FollowUpRow key={t.id} t={t} onLog={setLog} />)}
        </Card>
        <Card title="Leads to contact" actions={<Link className="crm-link" to="/crm/leads">See all →</Link>}>
          {leadsToContact.length === 0 ? (
            <EmptyState icon={<Users size={24} />} title="No leads waiting">
              <Link className="crm-link" to="/crm/leads?new=lead">Add a lead</Link>
            </EmptyState>
          ) : leadsToContact.map((l) => (
            <Link key={l.id} to={`/crm/leads?lead=${l.id}`} className="list-row crm-row-link">
              <Avatar name={l.companyName} size={34} />
              <div className="grow crm-min0">
                <b className="ink crm-ellipsis">{l.companyName}</b>
                <small className="muted crm-ellipsis">{[l.source, l.nextStep ?? (l.qualificationScore === 4 ? "ready to convert" : null), l.ownerUserId === user.id ? null : l.ownerName].filter(Boolean).join(" · ") || "No next step"}</small>
              </div>
              <Pill tone={l.stage === lastLeadStage ? "ok" : "blue"}>{l.stage}</Pill>
            </Link>
          ))}
        </Card>
      </div>
      <LogFollowUpModal t={log} onClose={() => setLog(null)} />
    </>
  );
}

// ============================================================ pipeline

function DealCard({ d, stages, canEdit, onOpen, onMove, onWon }: {
  d: Deal; stages: string[]; canEdit: boolean; onOpen: () => void; onMove: (s: string) => void; onWon: () => void;
}) {
  const { money } = useSession();
  const t = d.nextTask;
  const overdue = !!t?.dueAt && isOverdue(t.dueAt);
  const next = d.status === "won" ? `Won ${fmtDate(d.wonAt, { day: "numeric", month: "short" })}`
    : t ? (overdue ? `Overdue: ${t.title}` : t.dueAt ? `${t.title} · ${dayLabel(t.dueAt) === "Today" ? fmtTime(t.dueAt) : dayLabel(t.dueAt)}` : t.title)
      : d.nextStep ?? "No next step";
  const draggable = canEdit && d.status === "open";
  return (
    <div className={cx("board-card crm-card", draggable && "draggable")} draggable={draggable} role="button" tabIndex={0}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", d.id); e.dataTransfer.effectAllowed = "move"; }}
      onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="crm-card-head">
        <CoMark name={d.companyName ?? d.name} />
        <div className="crm-min0"><b>{d.companyName}</b><small>{d.name}</small></div>
      </div>
      <div className="crm-card-value">{money(d.value, true)}</div>
      <div className="crm-card-foot">
        <span className={cx("crm-ellipsis", overdue && "crm-red strong")}>{next}</span>
        <Owner name={d.ownerName} />
      </div>
      {draggable && (
        <div className="crm-card-move">
          <MoveTo stages={[...stages, "Won"]} value={d.stage} onMove={(s) => (s === "Won" ? onWon() : onMove(s))} />
        </div>
      )}
    </div>
  );
}

export function PipelinePage() {
  const { user, money } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("");
  const [stagesOpen, setStagesOpen] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const deals = useDeals({ q: q.trim() || undefined, owner: owner || undefined });
  const members = useMembers();
  const { canEdit, canManage } = useCrmAccess();
  const refresh = useRefreshCrm();
  const [run] = useAction();
  const openId = params.get("deal");
  const setOpen = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set("deal", id); else p.delete("deal"); setParams(p, { replace: !id }); };
  const stages = deals.data?.stages ?? [];

  const columns = useMemo(() => {
    const items = deals.data?.items ?? [];
    const cols = stages.map((s) => ({ key: s, label: s, won: false, items: items.filter((d) => d.status === "open" && d.stage === s) }));
    const orphan = items.filter((d) => d.status === "open" && !stages.includes(d.stage));
    if (orphan.length && cols[0]) cols[0].items.push(...orphan);
    cols.push({ key: "__won", label: "Won", won: true, items: items.filter((d) => d.status === "won") });
    return cols;
  }, [deals.data, stages]);

  const move = (d: Deal, stage: string) => run(async () => { await api.post(`/api/crm/deals/${d.id}/move`, { stage }); refresh(); }, `${d.name} moved to ${stage}`);
  const won = (d: Deal) => run(async () => { await api.post(`/api/crm/deals/${d.id}/won`); refresh(); }, `${d.name} won`);
  const onDrop = (e: DragEvent, col: { key: string; won: boolean }) => {
    e.preventDefault();
    setDropOn(null);
    const id = e.dataTransfer.getData("text/plain");
    const d = deals.data?.items.find((x) => x.id === id);
    if (!d || d.status !== "open") return;
    if (col.won) void won(d);
    else if (d.stage !== col.key) void move(d, col.key);
  };

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search deals" />
        <select className="select chip-select" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Owner: Everyone</option>
          <option value={user.id}>Owner: Me</option>
          {(members.data ?? []).filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>Owner: {m.name}</option>)}
        </select>
        <span className="grow" />
        {canManage && <button className="crm-link" onClick={() => setStagesOpen(true)}>Edit stages</button>}
      </div>
      {deals.isLoading ? <Loading /> : deals.error ? <ErrorNotice error={deals.error} retry={() => deals.refetch()} /> : (
        <>
          {deals.data!.items.length === 0 && !q && !owner && (
            <EmptyState title="Your pipeline is empty" action={canEdit && <Button icon={<Plus size={15} />} onClick={() => { const p = new URLSearchParams(params); p.set("new", "deal"); setParams(p); }}>New deal</Button>}>
              Deals move from {stages[0] ?? "Qualified"} through to Won. Add one, or convert a qualified lead.
            </EmptyState>
          )}
          {(deals.data!.items.length > 0 || q || owner) && (
            <div className="board crm-board">
              {columns.map((col) => {
                const value = col.items.reduce((s, d) => s + d.value, 0);
                return (
                  <section key={col.key} className={cx("board-col", col.won && "crm-col-won", dropOn === col.key && "drop")}
                    onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDropOn(col.key); } }}
                    onDragLeave={() => setDropOn((x) => (x === col.key ? null : x))}
                    onDrop={(e) => onDrop(e, col)} aria-label={col.label}>
                    <h5>{col.label}</h5>
                    <div className="sub">{col.won ? `This month · ${money(value, true)}` : `${col.items.length} · ${money(value, true)}`}</div>
                    {col.items.map((d) => (
                      <DealCard key={d.id} d={d} stages={stages} canEdit={canEdit} onOpen={() => setOpen(d.id)} onMove={(s) => move(d, s)} onWon={() => won(d)} />
                    ))}
                    {col.items.length === 0 && <div className="crm-col-empty">{col.won ? "No wins this month yet" : "No deals"}</div>}
                  </section>
                );
              })}
            </div>
          )}
          {(q || owner) && deals.data!.items.length === 0 && <p className="muted crm-small">No deals match these filters.</p>}
        </>
      )}
      <DealDrawer id={openId} onClose={() => setOpen(null)} stages={stages} />
      <StagesModal open={stagesOpen} onClose={() => setStagesOpen(false)} kind="deals" />
    </>
  );
}

// ============================================================ follow-ups

const GROUPS: { key: "overdue" | "today" | "week" | "later"; label: string }[] = [
  { key: "overdue", label: "Overdue" }, { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "later", label: "Later" },
];

export function FollowUpsPage() {
  const [assignee, setAssignee] = useState<"me" | "all">("me");
  const [type, setType] = useState<"" | ActivityType>("");
  const [creating, setCreating] = useState(false);
  const [log, setLog] = useState<FollowUp | null>(null);
  const q = useFollowUps(assignee);
  const summary = useSummary();
  const { canEdit } = useCrmAccess();
  const filter = (list: FollowUp[]) => (type ? list.filter((t) => followUpKind(t.title) === type) : list);
  const anything = q.data && GROUPS.some((g) => filter(q.data[g.key]).length);
  return (
    <>
      <div className="toolbar">
        <select className="select chip-select" aria-label="Assigned to" value={assignee} onChange={(e) => setAssignee(e.target.value as "me" | "all")}>
          <option value="me">Assigned to: Me</option>
          <option value="all">Assigned to: Everyone</option>
        </select>
        <select className="select chip-select" aria-label="Type" value={type} onChange={(e) => setType(e.target.value as ActivityType | "")}>
          <option value="">Type: All</option>
          <option value="call">Type: Calls</option>
          <option value="email">Type: Emails</option>
          <option value="meeting">Type: Meetings</option>
          <option value="note">Type: Other</option>
        </select>
        <span className="grow" />
        {canEdit && <Button variant="secondary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New follow-up</Button>}
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNotice error={q.error} retry={() => q.refetch()} /> : !anything ? (
        <EmptyState icon={<CalendarClock size={24} />} title={type ? "No follow-ups of this type" : assignee === "me" ? "You're all caught up" : "No open follow-ups"}
          action={canEdit && <Button icon={<Plus size={15} />} onClick={() => setCreating(true)}>New follow-up</Button>}>
          {summary.data?.companies ? "Add follow-ups when you log a call or meeting, or create one here." : "Add a company or lead first, then plan your next step."}
        </EmptyState>
      ) : GROUPS.map((g) => {
        const list = filter(q.data![g.key]);
        if (!list.length) return null;
        return (
          <section key={g.key} className="crm-fu-group">
            <div className="section-label crm-sec">{g.label}</div>
            <div className="card crm-fu-card">
              {list.map((t) => <FollowUpRow key={t.id} t={t} onLog={setLog} showAssignee />)}
            </div>
          </section>
        );
      })}
      <p className="muted crm-small crm-foot-note">Follow-ups also appear in Workflows as tasks, so they show up on everyone's Overview.</p>
      <FollowUpModal open={creating} onClose={() => setCreating(false)} />
      <LogFollowUpModal t={log} onClose={() => setLog(null)} />
    </>
  );
}

