import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus } from "lucide-react";
import { Avatar, Button, EmptyState, Loading, Notice, PageHeader, SearchInput, Select, useToast } from "@windveal/ui";
import { api } from "../../lib/api";
import { dayLabel, fmtTime, timeAgo } from "../../lib/format";
import { useSession } from "../../lib/session";
import { keys, useRefresh, type Card, type Pipeline } from "./data";
import { copyText, statusPill } from "./JobsPage";
import { AddCandidateModal, Stars } from "./widgets";
import { ExtraDetailsCard } from "../../components/ExtraDetails";
import { MoreMenu } from "../../components/actions";

function BoardCard({ card, stages, canEdit, onMove, onOpen }: {
  card: Card; stages: string[]; canEdit: boolean; onMove: (c: Card, s: string) => void; onOpen: () => void;
}) {
  const last = stages[stages.length - 1];
  return (
    <div className="board-card rc-card" draggable={canEdit && !card.hiredAt}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", card.id); e.dataTransfer.effectAllowed = "move"; }}
      onClick={onOpen} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Avatar name={card.name} size={30} />
        <div style={{ minWidth: 0 }}>
          <b>{card.name}</b>
          <small>{card.nextInterviewAt ? `Interview ${dayLabel(card.nextInterviewAt)} ${fmtTime(card.nextInterviewAt)}` : card.source}</small>
        </div>
      </div>
      <div className="between rc-card-foot">
        {card.averageScore !== null ? <Stars value={card.averageScore} /> : <small>{card.scoreHidden ? "Scores hidden" : "Not scored"}</small>}
        <small title={`In this stage for ${card.daysInStage} day${card.daysInStage === 1 ? "" : "s"}`}>{card.daysInStage < 1 ? timeAgo(card.stageChangedAt).replace(" ago", "") : `${card.daysInStage}d`}</small>
      </div>
      {canEdit && !card.hiredAt && (
        <select className="select rc-moveto" aria-label={`Move ${card.name} to`} value="" onClick={(e) => e.stopPropagation()}
          onChange={(e) => e.target.value && onMove(card, e.target.value)}>
          <option value="">Move to…</option>
          {stages.filter((s) => s !== card.stage).map((s) => <option key={s} value={s}>{s === last ? `${s} (hire)` : s}</option>)}
        </select>
      )}
    </div>
  );
}

export function PipelinePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefresh();
  const { can, org } = useSession();
  const canEdit = can("recruitment", "edit");
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");
  const [score, setScore] = useState("");
  const [drop, setDrop] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const pipe = useQuery({ queryKey: keys.job(id!), queryFn: () => api.get<Pipeline>(`/api/recruitment/jobs/${id}`) });

  if (pipe.isLoading) return <Loading />;
  if (pipe.isError) {
    return <EmptyState title="We couldn't load this job" action={<Button onClick={() => nav("/recruitment/jobs")}>Back to jobs</Button>}>{(pipe.error as Error).message}</EmptyState>;
  }
  const { job, stages, rejected } = pipe.data!;
  const last = job.stages[job.stages.length - 1]!;
  const all = stages.flatMap((s) => s.applications);
  const sources = Array.from(new Set(all.map((c) => c.source))).sort();
  const match = (c: Card) => {
    if (q && !`${c.name} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (source && c.source !== source) return false;
    if (score === "none" && c.averageScore !== null) return false;
    if (score && score !== "none" && (c.averageScore ?? 0) < Number(score)) return false;
    return true;
  };

  async function move(card: Card, stage: string) {
    if (stage === card.stage) return;
    if (stage === last) { nav(`/recruitment/applications/${card.id}?hire=1`); return; }
    // Optimistic move so the board feels instant.
    qc.setQueryData<Pipeline>(keys.job(id!), (p) => p && ({
      ...p,
      stages: p.stages.map((s) => ({
        ...s,
        applications: s.name === stage ? [{ ...card, stage, daysInStage: 0, stageChangedAt: new Date().toISOString() }, ...s.applications.filter((a) => a.id !== card.id)]
          : s.applications.filter((a) => a.id !== card.id),
      })),
    }));
    try {
      await api.post(`/api/recruitment/applications/${card.id}/stage`, { stage });
      toast(`${card.name} moved to ${stage}`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      await refresh();
    }
  }

  const meta = [job.department, job.location, job.employmentType, job.openedAt ? `posted ${timeAgo(job.openedAt).toLowerCase()}` : null,
    job.hiringManagerName ? `hiring manager ${job.hiringManagerName}` : null].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader back={{ label: "All jobs", onClick: () => nav("/recruitment/jobs") }}
        title={<span className="row" style={{ gap: 12, flexWrap: "wrap" }}>{job.title}{statusPill(job.status)}</span>}
        subtitle={meta || undefined}
        actions={<>
          {canEdit && job.status !== "closed" && <Button className="rc-block-sm" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add candidate</Button>}
          <MoreMenu label="Job actions" items={[
            canEdit && { label: "Edit job", icon: <Pencil size={15} />, onClick: () => nav(`/recruitment/jobs/${job.id}/edit`) },
            { label: "Copy link", icon: <Copy size={15} />, disabled: !job.isLive,
              title: job.isLive ? job.publicUrl : org.verificationStatus !== "verified" ? "Available once your organisation is verified" : "Show this job on the careers page to share a link",
              onClick: async () => toast((await copyText(job.publicUrl)) ? "Link copied" : job.publicUrl) },
          ]} />
        </>} />
      {job.status === "draft" && <Notice tone="info">This job is a draft. Open it to start taking applications.</Notice>}
      <div className="toolbar rc-mt">
        <SearchInput value={q} onChange={setQ} placeholder="Search candidates" />
        <Select className="chip-select" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}
          options={[{ value: "", label: "Source: All" }, ...sources.map((s) => ({ value: s, label: s }))]} />
        <Select className="chip-select" aria-label="Score" value={score} onChange={(e) => setScore(e.target.value)}
          options={[{ value: "", label: "Score: Any" }, { value: "4", label: "Score: 4 and up" }, { value: "3", label: "Score: 3 and up" }, { value: "none", label: "Not scored" }]} />
      </div>
      <div className="board rc-board">
        {stages.map((s) => {
          const items = s.applications.filter(match);
          const isLast = s.name === last;
          return (
            <section key={s.name} className={`board-col ${drop === s.name ? "drop" : ""}`} aria-label={s.name}
              onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); setDrop(s.name); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
              onDrop={(e) => {
                e.preventDefault(); setDrop(null);
                const cid = e.dataTransfer.getData("text/plain");
                const card = all.find((c) => c.id === cid);
                if (card) void move(card, s.name);
              }}>
              <h5>{s.name}<span>{s.applications.length}</span></h5>
              {items.map((c) => (
                <BoardCard key={c.id} card={c} stages={job.stages} canEdit={canEdit} onMove={move} onOpen={() => nav(`/recruitment/applications/${c.id}`)} />
              ))}
              {!items.length && (
                <div className="rc-col-empty">{isLast && canEdit ? "Drag a candidate here to hire" : s.applications.length ? "No matches" : "No one here yet"}</div>
              )}
            </section>
          );
        })}
      </div>
      {!all.length && !rejected.length && (
        <div className="card rc-mt">
          <EmptyState title="No candidates yet" action={canEdit && job.status !== "closed" ? <Button onClick={() => setAdding(true)}>Add candidate</Button> : undefined}>
            {job.isLive ? "Share the job link, or add someone you've met yourself." : "Add candidates yourself, or show this job on your careers page once you're verified."}
          </EmptyState>
        </div>
      )}
      {!!rejected.length && (
        <div className="rc-mt">
          <Button variant="ghost" onClick={() => setShowRejected((x) => !x)}>{showRejected ? "Hide" : "Show"} rejected ({rejected.length})</Button>
          {showRejected && (
            <div className="table-wrap rc-mt">
              <table className="table">
                <thead><tr><th>Candidate</th><th>Stage</th><th className="hide-sm">Reason</th></tr></thead>
                <tbody>
                  {rejected.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => nav(`/recruitment/applications/${c.id}`)}>
                      <td><div className="cell-main"><Avatar name={c.name} size={28} /><div><b>{c.name}</b><small>{c.source}</small></div></div></td>
                      <td>{c.stage}</td>
                      <td className="hide-sm">{c.rejectionReason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="rc-mt"><ExtraDetailsCard reference={job.reference} referenceLabel="Job ID" extra={job.extraDetails} /></div>
      <AddCandidateModal jobId={job.id} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
