import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import {
  Avatar, Button, Card, Checkbox, EmptyState, IconButton, Input, Loading, Modal, Notice, PageHeader, Select, Switch, Textarea, useToast,
} from "@windveal/ui";
import { DEFAULT_RECRUITMENT_STAGES } from "@windveal/shared";
import { ApiError, api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { EMPLOYMENT_TYPES, keys, useDepartments, useMembers, useRefresh, type Job, type Pipeline, type Question, type QuestionType } from "./data";

type DraftQuestion = Question & { optionsText: string };

type Values = {
  title: string; departmentId: string; location: string; employmentType: string; salaryMin: string; salaryMax: string; salaryPeriod: string;
  applyBy: string; description: string; showSalary: boolean; published: boolean; hiringManagerUserId: string; hiringTeamUserIds: string[];
  stages: string[]; questions: DraftQuestion[];
};

const TYPE_LABEL: Record<QuestionType, string> = { text: "Short answer", choice: "Choice", yesno: "Yes / no", number: "Number" };
let qid = 0;
const newQuestion = (): DraftQuestion => ({ id: `new_${Date.now().toString(36)}_${qid++}`, label: "", type: "text", required: false, optionsText: "" });

function fromJob(j: Job | null): Values {
  return {
    title: j?.title ?? "", departmentId: j?.departmentId ?? "", location: j?.location ?? "", employmentType: j?.employmentType ?? "Full-time",
    salaryMin: j?.salaryMin != null ? String(j.salaryMin) : "", salaryMax: j?.salaryMax != null ? String(j.salaryMax) : "",
    salaryPeriod: j?.salaryPeriod ?? "month", applyBy: j?.applyBy ?? "", description: j?.description ?? "", showSalary: j?.showSalary ?? false,
    published: j?.published ?? false, hiringManagerUserId: j?.hiringManagerUserId ?? "", hiringTeamUserIds: j?.hiringTeamUserIds ?? [],
    stages: j?.stages ?? [...DEFAULT_RECRUITMENT_STAGES],
    questions: (j?.questions ?? []).map((q) => ({ ...q, optionsText: (q.options ?? []).join("\n") })),
  };
}

function StagesModal({ open, stages, onClose, onSave }: { open: boolean; stages: string[]; onClose: () => void; onSave: (s: string[]) => void }) {
  const [list, setList] = useState(stages);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setList(stages); setErr(null); } }, [open, stages]);
  const move = (i: number, d: number) => setList((l) => { const n = [...l]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); return n; });
  function save() {
    const clean = list.map((s) => s.trim());
    if (clean.some((s) => !s)) return setErr("Stage names can't be empty.");
    if (clean.length < 2) return setErr("Keep at least two stages.");
    if (new Set(clean.map((s) => s.toLowerCase())).size !== clean.length) return setErr("Stage names must be different.");
    onSave(clean); onClose();
  }
  return (
    <Modal open={open} onClose={onClose} title="Pipeline stages" subtitle="The last stage is where hired candidates end up. You can't remove a stage that still has candidates."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save}>Save stages</Button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="stack" style={{ gap: 8 }}>
        {list.map((s, i) => (
          <div key={i} className="row">
            <Input aria-label={`Stage ${i + 1}`} value={s} onChange={(e) => setList((l) => l.map((x, j) => (j === i ? e.target.value : x)))} />
            <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} /></IconButton>
            <IconButton label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} /></IconButton>
            <IconButton label="Remove stage" disabled={list.length <= 2} onClick={() => setList((l) => l.filter((_, j) => j !== i))}><Trash2 size={16} /></IconButton>
          </div>
        ))}
      </div>
      <Button variant="ghost" icon={<Plus size={16} />} className="rc-mt" onClick={() => setList((l) => [...l.slice(0, -1), "", l[l.length - 1]!])}>Add stage</Button>
    </Modal>
  );
}

function JobForm({ job }: { job: Job | null }) {
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefresh();
  const { org, money } = useSession();
  const verified = org.verificationStatus === "verified";
  const departments = useDepartments();
  const members = useMembers();
  const [v, setV] = useState<Values>(() => fromJob(job));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const set = <K extends keyof Values>(k: K, val: Values[K]) => { setV((s) => ({ ...s, [k]: val })); if (errors[k]) setErrors((e) => ({ ...e, [k]: "" })); };
  const setQ = (i: number, patch: Partial<DraftQuestion>) => set("questions", v.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const moveQ = (i: number, d: number) => { const n = [...v.questions]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); set("questions", n); };
  const [dragQ, setDragQ] = useState<number | null>(null);

  async function save(status: Job["status"]) {
    setBusy(status); setErrors({}); setFormError(null);
    const body = {
      title: v.title, departmentId: v.departmentId || null, location: v.location, employmentType: v.employmentType,
      salaryMin: v.salaryMin.replace(/[,\s]/g, "") || null, salaryMax: v.salaryMax.replace(/[,\s]/g, "") || null, salaryPeriod: v.salaryPeriod,
      showSalary: v.showSalary, applyBy: v.applyBy || null, description: v.description, status,
      published: verified ? v.published : job?.published ?? false,
      hiringManagerUserId: v.hiringManagerUserId || null, hiringTeamUserIds: v.hiringTeamUserIds, stages: v.stages,
      questions: v.questions.map((q) => ({
        id: q.id.startsWith("new_") ? undefined : q.id, label: q.label, type: q.type, required: q.required,
        ...(q.type === "choice" ? { options: q.optionsText.split("\n").map((o) => o.trim()).filter(Boolean) } : {}),
      })),
    };
    try {
      const r = job ? await api.patch<{ job: Job }>(`/api/recruitment/jobs/${job.id}`, body) : await api.post<{ job: Job }>("/api/recruitment/jobs", body);
      toast(status === "open" && job?.status !== "open" ? `${r.job.title} is open` : job ? "Changes saved" : "Draft saved");
      await refresh();
      nav(`/recruitment/jobs/${r.job.id}`);
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.details ?? {}); setFormError(e.message); } else setFormError("Something went wrong. Please try again.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally { setBusy(null); }
  }

  const memberName = (id: string) => members.data?.find((m) => m.id === id)?.name ?? "Team member";
  const team = Array.from(new Set([...(v.hiringManagerUserId ? [v.hiringManagerUserId] : []), ...v.hiringTeamUserIds]));
  const qErr = (i: number, f: string) => errors[`questions.${i}.${f}`];
  const salaryPreview = v.salaryMin || v.salaryMax
    ? [v.salaryMin && money(Number(v.salaryMin.replace(/[,\s]/g, ""))), v.salaryMax && money(Number(v.salaryMax.replace(/[,\s]/g, "")))].filter(Boolean).join(" to ") + ` a ${v.salaryPeriod}`
    : null;

  return (
    <>
      <PageHeader back={{ label: job ? job.title : "All jobs", onClick: () => nav(job ? `/recruitment/jobs/${job.id}` : "/recruitment/jobs") }}
        title={job ? "Edit job" : "New job"}
        subtitle={job ? (job.status === "draft" ? "This job is a draft." : job.status === "open" ? "This job is open." : "This job is closed.") : "Save it as a draft, or open it to start taking applications."}
        actions={<>
          {(!job || job.status === "draft") && <Button variant="secondary" loading={busy === "draft"} disabled={!!busy} onClick={() => save("draft")}>Save draft</Button>}
          {job && job.status !== "draft" && <Button variant="secondary" loading={busy === job.status} disabled={!!busy} onClick={() => save(job.status)}>Save changes</Button>}
          {(!job || job.status !== "open") && <Button loading={busy === "open"} disabled={!!busy} onClick={() => save("open")}>{job?.status === "closed" ? "Reopen job" : "Open job"}</Button>}
        </>} />
      {formError && <Notice tone="error">{formError}</Notice>}
      <div className="grid-side rc-mt">
        <div className="stack" style={{ gap: 20 }}>
          <Card title="Job details">
            <div className="form-grid">
              <Input label="Job title" value={v.title} onChange={(e) => set("title", e.target.value)} error={errors.title} placeholder="Sales Representative" autoFocus={!job} />
              <Select label="Department" value={v.departmentId} onChange={(e) => set("departmentId", e.target.value)} error={errors.departmentId}
                placeholder={departments.data?.length ? "No department" : "No departments yet"} options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
              <Input label="Location" value={v.location} onChange={(e) => set("location", e.target.value)} error={errors.location} placeholder={org.name ? "Lagos" : ""} />
              <Select label="Employment type" value={v.employmentType} onChange={(e) => set("employmentType", e.target.value)} options={EMPLOYMENT_TYPES} />
              <div className="field">
                <span className="field-label"><span>Salary range</span><span className="opt">Optional</span></span>
                <div className="rc-salary">
                  <input className="input" inputMode="numeric" aria-label="Minimum salary" placeholder="Min" value={v.salaryMin} onChange={(e) => set("salaryMin", e.target.value)} aria-invalid={!!errors.salaryMin} />
                  <span className="muted">to</span>
                  <input className="input" inputMode="numeric" aria-label="Maximum salary" placeholder="Max" value={v.salaryMax} onChange={(e) => set("salaryMax", e.target.value)} aria-invalid={!!errors.salaryMax} />
                  <select className="select" aria-label="Salary period" value={v.salaryPeriod} onChange={(e) => set("salaryPeriod", e.target.value)}>
                    {["hour", "day", "week", "month", "year"].map((p) => <option key={p} value={p}>a {p}</option>)}
                  </select>
                </div>
                {errors.salaryMin || errors.salaryMax ? <span className="field-error">{errors.salaryMin || errors.salaryMax}</span> : salaryPreview ? <span className="field-hint">{salaryPreview}</span> : null}
              </div>
              <Input label="Apply by" optional type="date" value={v.applyBy} onChange={(e) => set("applyBy", e.target.value)} error={errors.applyBy} />
              <Textarea label="Description" wrapClassName="span-2" className="rc-desc" value={v.description} onChange={(e) => set("description", e.target.value)} error={errors.description}
                placeholder={"What the role is about.\n\nWhat you'll do\n• …\n\nWhat you'll need\n• …"} />
            </div>
          </Card>

          <Card title="Questions for applicants" subtitle="Shown on the application form. Drag or use the arrows to reorder."
            actions={<Button variant="ghost" icon={<Plus size={16} />} onClick={() => set("questions", [...v.questions, newQuestion()])}>Add question</Button>}>
            {errors.questions && <Notice tone="error">{errors.questions}</Notice>}
            {!v.questions.length ? <p className="muted">No questions yet. Applicants will only send their details and CV.</p> : (
              <div className="stack" style={{ gap: 10 }}>
                {v.questions.map((q, i) => (
                  <div key={q.id} className={`rc-q ${dragQ === i ? "dragging" : ""}`} draggable
                    onDragStart={() => setDragQ(i)} onDragEnd={() => setDragQ(null)}
                    onDragOver={(e) => { e.preventDefault(); if (dragQ !== null && dragQ !== i) { moveQ(dragQ, i - dragQ); setDragQ(i); } }}>
                    <div className="rc-q-row">
                      <span className="rc-grip" aria-hidden>⋮⋮</span>
                      <Input aria-label={`Question ${i + 1}`} placeholder="Ask something…" value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} error={qErr(i, "label")} wrapClassName="grow" />
                      <Select aria-label="Answer type" value={q.type} onChange={(e) => setQ(i, { type: e.target.value as QuestionType })}
                        options={(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
                    </div>
                    {q.type === "choice" && (
                      <Textarea aria-label="Options" placeholder={"One option per line"} style={{ minHeight: 72 }} value={q.optionsText}
                        onChange={(e) => setQ(i, { optionsText: e.target.value })} error={qErr(i, "options")} />
                    )}
                    <div className="between">
                      <Checkbox label="Required" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} />
                      <div className="row" style={{ gap: 2 }}>
                        <IconButton label="Move up" disabled={i === 0} onClick={() => moveQ(i, -1)}><ArrowUp size={16} /></IconButton>
                        <IconButton label="Move down" disabled={i === v.questions.length - 1} onClick={() => moveQ(i, 1)}><ArrowDown size={16} /></IconButton>
                        <IconButton label="Remove question" onClick={() => set("questions", v.questions.filter((_, j) => j !== i))}><Trash2 size={16} /></IconButton>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="stack" style={{ gap: 20 }}>
          <Card title="Publishing">
            <div className="rc-toggle">
              <div><b>Show on careers page</b><small>{verified ? "Applicants can find and apply for it while it's open." : `Available once ${org.name} is verified.`}</small></div>
              <Switch label="Show on careers page" checked={verified && v.published} disabled={!verified} onChange={(c) => set("published", c)} />
            </div>
            {errors.published && <span className="field-error">{errors.published}</span>}
            <div className="rc-toggle">
              <div><b>Show salary range</b><small>Jobs with a salary get more applicants.</small></div>
              <Switch label="Show salary range" checked={v.showSalary} onChange={(c) => set("showSalary", c)} />
            </div>
          </Card>

          <Card title="Hiring team" subtitle="They'll see candidates and give feedback."
            actions={<Button variant="ghost" icon={<Plus size={16} />} onClick={() => setTeamOpen(true)}>{team.length ? "Edit" : "Add"}</Button>}>
            {errors.hiringManagerUserId && <span className="field-error">{errors.hiringManagerUserId}</span>}
            {errors.hiringTeamUserIds && <span className="field-error">{errors.hiringTeamUserIds}</span>}
            {!team.length ? <p className="muted">No one added yet.</p> : team.map((id) => (
              <div key={id} className="list-row">
                <Avatar name={memberName(id)} size={34} />
                <div style={{ minWidth: 0 }}><b className="ink">{memberName(id)}</b><small className="muted" style={{ display: "block" }}>{id === v.hiringManagerUserId ? "Hiring manager" : "Interviewer"}</small></div>
              </div>
            ))}
          </Card>

          <Card title="Pipeline stages" actions={<Button variant="ghost" onClick={() => setStagesOpen(true)}>Edit</Button>}>
            <p className="ink">{v.stages.join(" → ")}</p>
            {errors.stages && <span className="field-error">{errors.stages}</span>}
          </Card>
        </div>
      </div>

      <StagesModal open={stagesOpen} stages={v.stages} onClose={() => setStagesOpen(false)} onSave={(s) => set("stages", s)} />
      <Modal open={teamOpen} onClose={() => setTeamOpen(false)} title="Hiring team" footer={<Button onClick={() => setTeamOpen(false)}>Done</Button>}>
        {members.isLoading ? <Loading /> : members.isError ? <Notice tone="error">Couldn't load your team.</Notice> : (
          <>
            <Select label="Hiring manager" placeholder="No hiring manager" value={v.hiringManagerUserId} onChange={(e) => set("hiringManagerUserId", e.target.value)}
              hint="Gets notified about new applicants and can always see every scorecard." options={(members.data ?? []).map((m) => ({ value: m.id, label: m.name }))} />
            <div className="field rc-mt">
              <span className="field-label">Interviewers</span>
              <div className="rc-check-list">
                {(members.data ?? []).filter((m) => m.id !== v.hiringManagerUserId).map((m) => (
                  <Checkbox key={m.id} label={m.name} checked={v.hiringTeamUserIds.includes(m.id)}
                    onChange={(e) => set("hiringTeamUserIds", e.target.checked ? [...v.hiringTeamUserIds, m.id] : v.hiringTeamUserIds.filter((x) => x !== m.id))} />
                ))}
              </div>
            </div>
            {!!v.hiringTeamUserIds.length && (
              <div className="row rc-mt" style={{ flexWrap: "wrap", gap: 6 }}>
                {v.hiringTeamUserIds.map((id) => (
                  <span key={id} className="pill pill-blue">{memberName(id)}
                    <button className="rc-x" aria-label={`Remove ${memberName(id)}`} onClick={() => set("hiringTeamUserIds", v.hiringTeamUserIds.filter((x) => x !== id))}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}

export function JobFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const q = useQuery({ queryKey: keys.job(id ?? "new"), queryFn: () => api.get<Pipeline>(`/api/recruitment/jobs/${id}`), enabled: !!id });
  if (!can("recruitment", "edit")) return <EmptyState title="You can't edit jobs">Ask an admin for edit access to Recruitment.</EmptyState>;
  if (!id) return <JobForm job={null} />;
  if (q.isLoading) return <Loading />;
  if (q.isError) return <EmptyState title="We couldn't load this job" action={<Button onClick={() => nav("/recruitment/jobs")}>Back to jobs</Button>}>{(q.error as Error).message}</EmptyState>;
  return <JobForm key={q.data!.job.id} job={q.data!.job} />;
}
