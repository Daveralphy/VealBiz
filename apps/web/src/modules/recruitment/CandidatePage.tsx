import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Calendar, Download, FileText, Mail, MapPin, MoreHorizontal, Phone } from "lucide-react";
import { formatBytes } from "@windveal/shared";
import {
  Avatar, Button, Card, ConfirmDialog, Drawer, EmptyState, IconButton, Loading, Menu, Notice, Pill, Textarea, useToast,
} from "@windveal/ui";
import { api, fileUrl } from "../../lib/api";
import { fmtDate, fmtTime, timeAgo } from "../../lib/format";
import { useSession } from "../../lib/session";
import { MODE_LABEL, keys, recLabel, recTone, useRefresh, type ApplicationDetail } from "./data";
import { HireModal, RejectModal, ScheduleModal, ScorecardForm, Stars } from "./widgets";
import { MoreMenu } from "../../components/actions";

function Notes({ d }: { d: ApplicationDetail }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok); await refresh(); return true; } catch (e) { toast((e as Error).message, "error"); return false; } finally { setBusy(false); }
  }
  return (
    <Card title="Notes">
      {!d.notes.length && <p className="muted">No notes yet.</p>}
      {d.notes.map((n) => (
        <div key={n.id} className="rc-note">
          <Avatar name={n.authorName} size={30} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="between">
              <span><b className="ink">{n.authorName}</b> <span className="muted">· {timeAgo(n.createdAt)}</span></span>
              {n.isMine && (
                <Menu trigger={(t) => <IconButton label="Note actions" onClick={t}><MoreHorizontal size={16} /></IconButton>}>
                  {(close) => <>
                    <button onClick={() => { close(); setEditing({ id: n.id, body: n.body }); }}>Edit</button>
                    <button className="danger" onClick={() => { close(); setDeleting(n.id); }}>Delete</button>
                  </>}
                </Menu>
              )}
            </div>
            {editing?.id === n.id ? (
              <div className="stack" style={{ gap: 8 }}>
                <Textarea aria-label="Edit note" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                <div className="rc-actions-end">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button size="sm" loading={busy} disabled={!editing.body.trim()}
                    onClick={async () => (await run(() => api.patch(`/api/recruitment/notes/${n.id}`, { body: editing.body }), "Note updated")) && setEditing(null)}>Save</Button>
                </div>
              </div>
            ) : <p className="rc-pre">{n.body}</p>}
          </div>
        </div>
      ))}
      <div className="rc-note-add">
        <Textarea aria-label="Add a note" placeholder="Add a note for the hiring team…" value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 64 }} />
        {body.trim() && (
          <div className="rc-actions-end">
            <Button size="sm" loading={busy} onClick={async () => (await run(() => api.post(`/api/recruitment/applications/${d.application.id}/notes`, { body }), "Note added")) && setBody("")}>Add note</Button>
          </div>
        )}
      </div>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger confirmLabel="Delete" title="Delete this note?" loading={busy}
        onConfirm={async () => { await run(() => api.del(`/api/recruitment/notes/${deleting}`), "Note deleted"); setDeleting(null); }} />
    </Card>
  );
}

export function CandidatePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefresh();
  const [params, setParams] = useSearchParams();
  const { can, user, money } = useSession();
  const canEdit = can("recruitment", "edit");
  const q = useQuery({ queryKey: keys.app(id!), queryFn: () => api.get<ApplicationDetail>(`/api/recruitment/applications/${id}`) });
  const [modal, setModal] = useState<"reject" | "schedule" | "hire" | "feedback" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (params.get("hire") === "1" && q.data && canEdit && !q.data.application.hiredAt) {
      setModal("hire");
      params.delete("hire"); setParams(params, { replace: true });
    }
  }, [params, q.data, canEdit, setParams]);

  if (q.isLoading) return <Loading />;
  if (q.isError) return <EmptyState title="We couldn't load this candidate" action={<Button onClick={() => nav("/recruitment/candidates")}>All candidates</Button>}>{(q.error as Error).message}</EmptyState>;
  const d = q.data!;
  const { application: a, candidate: c, job } = d;
  const idx = job.stages.indexOf(a.stage);
  const last = job.stages[job.stages.length - 1]!;
  const next = idx >= 0 && idx < job.stages.length - 1 ? job.stages[idx + 1]! : null;
  const active = !a.rejectedAt && !a.hiredAt;
  const upcoming = d.interviews.filter((i) => i.status === "scheduled" && new Date(i.scheduledAt).getTime() > Date.now() - 2 * 3_600_000);
  const myInterview = d.interviews.find((i) => i.status !== "cancelled" && i.interviewers.some((x) => x.userId === user.id));
  const myCard = d.scorecards.find((s) => s.isMine && (s.interviewId ?? null) === (myInterview?.id ?? null)) ?? d.scorecards.find((s) => s.isMine);
  const others = d.scorecards.filter((s) => s.submittedAt);

  async function moveTo(stage: string) {
    if (stage === last) return setModal("hire");
    setBusy(true);
    try {
      await api.post(`/api/recruitment/applications/${a.id}/stage`, { stage });
      toast(`${c.name} moved to ${stage}`);
      await refresh();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true);
    try { await api.post(`/api/recruitment/applications/${a.id}/restore`); toast(`${c.name} restored`); await refresh(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  async function setInterview(iid: string, action: "cancel" | "complete") {
    try { await api.post(`/api/recruitment/interviews/${iid}/${action}`); toast(action === "cancel" ? "Interview cancelled" : "Marked as done"); await refresh(); }
    catch (e) { toast((e as Error).message, "error"); }
  }

  const isPdf = a.cv && (a.cv.mime === "application/pdf" || a.cv.name.toLowerCase().endsWith(".pdf"));

  return (
    <>
      <button className="back-link" style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }} onClick={() => nav(`/recruitment/jobs/${job.id}`)}>
        ‹ {job.title} pipeline
      </button>
      <section className="card rc-head">
        <div className="rc-head-top">
          <Avatar name={c.name} size={64} />
          <div className="rc-head-info">
            <h1>{c.name}</h1>
            <div className="rc-contact">
              <span>Applied for {job.title}</span>
              <a href={`mailto:${c.email}`}><Mail size={15} />{c.email}</a>
              {c.phone && <a href={`tel:${c.phone.replace(/\s/g, "")}`}><Phone size={15} />{c.phone}</a>}
              {c.location && <span><MapPin size={15} />{c.location}</span>}
            </div>
          </div>
          {canEdit && (
            <div className="rc-head-actions">
              {a.rejectedAt && <Button variant="secondary" loading={busy} onClick={restore}>Restore</Button>}
              {active && <MoreMenu label="Candidate actions" items={[
                { label: "Schedule interview", icon: <Calendar size={15} />, onClick: () => setModal("schedule") },
                { label: "Reject", danger: true, onClick: () => setModal("reject") },
              ]} />}
              {active && next && (
                <Button loading={busy} onClick={() => moveTo(next)}>{next === last ? "Hire" : `Move to ${next}`}<ArrowRight size={16} /></Button>
              )}
            </div>
          )}
        </div>
        {a.hiredAt && (
          <Notice tone="ok" action={a.employeeId ? <Link to={`/people/employees/${a.employeeId}`}>Open employee record</Link> : undefined}>
            Hired on {fmtDate(a.hiredAt)}.
          </Notice>
        )}
        {a.rejectedAt && <Notice tone="warn">Rejected on {fmtDate(a.rejectedAt)}{a.rejectionReason ? `: ${a.rejectionReason}` : ""}.</Notice>}
        <div className="rc-stagebar" role="list">
          {job.stages.map((s, i) => (
            <button key={s} role="listitem" className={i < idx ? "past" : i === idx ? "now" : ""} aria-current={i === idx ? "step" : undefined}
              disabled={!canEdit || !active || i === idx || busy} onClick={() => moveTo(s)} title={canEdit && active && i !== idx ? (s === last ? "Hire" : `Move to ${s}`) : s}>
              {s}
            </button>
          ))}
        </div>
      </section>

      <div className="grid-side rc-mt">
        <div className="stack" style={{ gap: 20 }}>
          <Card title="CV" subtitle={a.cv ? `${a.cv.name} · ${formatBytes(a.cv.size)}` : undefined}
            actions={a.cv ? <a className="btn btn-ghost" href={fileUrl(a.cv.id, true)}><Download size={15} />Download</a> : undefined}>
            {!a.cv ? <EmptyState icon={<FileText size={24} />} title="No CV">{a.source === "Careers page" ? "This application came without a CV." : "Candidates added by hand don't have a CV yet."}</EmptyState>
              : isPdf ? <iframe className="rc-cv" title={`${c.name}'s CV`} src={fileUrl(a.cv.id)} />
              : <div className="rc-cv-file"><FileText size={28} /><div><b className="ink">{a.cv.name}</b><p className="muted">Word documents can't be previewed here.</p></div><a className="btn btn-secondary" href={fileUrl(a.cv.id, true)}>Download</a></div>}
          </Card>

          <Card title="Interview feedback"
            actions={d.feedback.average !== null ? <div className="rc-avg"><b>{d.feedback.average.toFixed(1)}</b><span> / 5 from {d.feedback.submittedCount} scorecard{d.feedback.submittedCount === 1 ? "" : "s"}</span></div> : undefined}>
            {d.feedback.hiddenCount > 0 && (
              <Notice tone="info">{d.feedback.hiddenCount} other scorecard{d.feedback.hiddenCount === 1 ? " is" : "s are"} hidden until you submit your own feedback.</Notice>
            )}
            {!others.length && !d.feedback.hiddenCount && <p className="muted">No feedback yet.</p>}
            {others.map((s) => (
              <div key={s.id} className="rc-fb">
                <Avatar name={s.interviewerName} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="between">
                    <span><b className="ink">{s.interviewerName}</b>{s.interviewTitle && <span className="muted"> · {s.interviewTitle}</span>}</span>
                    <Pill tone={recTone(s.recommendation)}>{recLabel(s.recommendation)}</Pill>
                  </div>
                  <Stars value={s.average} />
                  {s.notes && <p className="rc-pre">{s.notes}</p>}
                </div>
              </div>
            ))}
            {(myInterview || active) && !(myCard?.submittedAt) && (
              <Button variant="secondary" className="rc-mt" onClick={() => setModal("feedback")}>{myCard ? "Continue your feedback" : "Add your feedback"}</Button>
            )}
          </Card>

          {a.coverLetter && <Card title="Cover letter"><p className="rc-pre">{a.coverLetter}</p></Card>}
        </div>

        <div className="stack" style={{ gap: 20 }}>
          <Card title="Application">
            <dl className="rc-answers">
              {a.answers.map((x) => <div key={x.questionId}><dt>{x.label}</dt><dd>{x.type === "number" && /salary|pay/i.test(x.label) ? money(Number(x.value)) : x.value}</dd></div>)}
              <div><dt>Applied</dt><dd>{fmtDate(a.appliedAt)} · {a.source}</dd></div>
              {a.expectedSalary !== null && <div><dt>Expected salary</dt><dd>{money(a.expectedSalary)}</dd></div>}
            </dl>
          </Card>

          <Card title="Coming up">
            {!upcoming.length ? <p className="muted">No interviews scheduled.</p> : upcoming.map((i) => (
              <div key={i.id} className="rc-up">
                <div className="rc-up-time"><b>{fmtTime(i.scheduledAt)}</b><small>{fmtDate(i.scheduledAt, { weekday: "short", day: "numeric", month: "short" })}</small></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b className="ink">{i.title}</b>
                  <small className="muted" style={{ display: "block" }}>With {i.interviewers.map((x) => x.name).join(" and ")}</small>
                  <small className="muted" style={{ display: "block" }}>{i.durationMinutes} min · {MODE_LABEL[i.mode]}{i.location ? ` · ${i.location}` : ""}</small>
                </div>
                {canEdit && (
                  <Menu trigger={(t) => <IconButton label="Interview actions" onClick={t}><MoreHorizontal size={16} /></IconButton>}>
                    {(close) => <>
                      <button onClick={() => { close(); void setInterview(i.id, "complete"); }}>Mark as done</button>
                      <button className="danger" onClick={() => { close(); void setInterview(i.id, "cancel"); }}>Cancel interview</button>
                    </>}
                  </Menu>
                )}
              </div>
            ))}
          </Card>

          <Notes d={d} />
        </div>
      </div>

      <RejectModal applicationId={a.id} name={c.name} open={modal === "reject"} onClose={() => setModal(null)} />
      <ScheduleModal applicationId={a.id} name={c.name} open={modal === "schedule"} onClose={() => setModal(null)} />
      {canEdit && <HireModal detail={d} open={modal === "hire"} onClose={() => setModal(null)} />}
      <Drawer open={modal === "feedback"} onClose={() => setModal(null)} title={`Scorecard: ${c.name}`}>
        <p className="muted" style={{ marginBottom: 14 }}>{job.title}{myInterview ? ` · ${myInterview.title} · ${fmtDate(myInterview.scheduledAt)}` : ""}</p>
        <ScorecardForm applicationId={a.id} interviewId={myCard?.interviewId ?? myInterview?.id ?? null} initial={myCard ?? null} onSaved={() => setModal(null)} />
      </Drawer>
    </>
  );
}
