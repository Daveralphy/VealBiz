import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Star, Users } from "lucide-react";
import { Button, Checkbox, Input, Modal, Notice, Select, Textarea, useToast } from "@windveal/ui";
import { ApiError, api } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { useForm } from "../../lib/form";
import {
  CRITERIA, RATING_WORDS, RECOMMENDATIONS, SOURCES, useDepartments, useMembers, useRefresh,
  type ApplicationDetail, type Recommendation,
} from "./data";

export function Stars({ value, size = 12 }: { value: number | null; size?: number }) {
  const v = Math.round(value ?? 0);
  return (
    <span className="rc-stars" aria-label={value === null ? "Not scored" : `${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => <Star key={i} size={size} className={i <= v ? "on" : ""} fill={i <= v ? "currentColor" : "none"} />)}
    </span>
  );
}

// ---------------- add candidate ----------------
export function AddCandidateModal({ jobId, open, onClose }: { jobId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const f = useForm({ firstName: "", lastName: "", email: "", phone: "", location: "", source: "Added manually" });
  useEffect(() => { if (open) f.setValues({ firstName: "", lastName: "", email: "", phone: "", location: "", source: "Added manually" }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => f.submit(async (v) => {
    await api.post(`/api/recruitment/jobs/${jobId}/candidates`, v);
    toast(`${v.firstName} ${v.lastName} added`);
    await refresh();
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="Add candidate" subtitle="They'll start at the first stage. If they're already a candidate, we'll reuse their details."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Add candidate</Button></>}>
      <div className="form-grid">
        <Input label="First name" {...f.bind("firstName")} autoFocus />
        <Input label="Last name" {...f.bind("lastName")} />
        <Input label="Email" type="email" {...f.bind("email")} wrapClassName="span-2" />
        <Input label="Phone" optional {...f.bind("phone")} />
        <Input label="Location" optional {...f.bind("location")} />
        <Select label="Source" options={SOURCES.filter((s) => s !== "Careers page")} {...f.bind("source")} wrapClassName="span-2" />
      </div>
    </Modal>
  );
}

// ---------------- reject ----------------
export function RejectModal({ applicationId, name, open, onClose }: { applicationId: string; name: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const f = useForm({ reason: "" });
  const save = () => f.submit(async (v) => {
    await api.post(`/api/recruitment/applications/${applicationId}/reject`, v);
    toast(`${name} rejected`);
    await refresh();
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title={`Reject ${name}?`} subtitle="They'll leave the pipeline. You can restore them later."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={f.busy} onClick={save}>Reject</Button></>}>
      <Select label="Reason" placeholder="Choose a reason" {...f.bind("reason")}
        options={["Not enough experience", "Skills don't match the role", "Salary expectations too high", "Withdrew their application", "Position filled", "Didn't attend interview"]} />
      <Textarea label="Or write your own" optional style={{ minHeight: 70 }} value={f.values.reason} onChange={(e) => f.set("reason", e.target.value)} wrapClassName="rc-mt" />
    </Modal>
  );
}

// ---------------- schedule interview ----------------
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleModal({ applicationId, name, open, onClose }: { applicationId: string; name: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const members = useMembers();
  const tomorrow = new Date(Date.now() + 86_400_000); tomorrow.setHours(10, 0, 0, 0);
  const f = useForm({ title: "Interview", when: localInput(tomorrow), durationMinutes: "45", mode: "office", location: "", interviewerUserIds: [] as string[] });
  const toggle = (id: string) => f.set("interviewerUserIds", f.values.interviewerUserIds.includes(id) ? f.values.interviewerUserIds.filter((x) => x !== id) : [...f.values.interviewerUserIds, id]);
  const save = () => f.submit(async (v) => {
    const d = new Date(v.when);
    if (!v.when || Number.isNaN(d.getTime())) { f.setErrors({ scheduledAt: "Choose a date and time" }); throw new ApiError(400, "bad_request", "Choose a date and time"); }
    await api.post(`/api/recruitment/applications/${applicationId}/interviews`, {
      title: v.title, scheduledAt: d.toISOString(), durationMinutes: Number(v.durationMinutes), mode: v.mode, location: v.location || null, interviewerUserIds: v.interviewerUserIds,
    });
    toast("Interview scheduled. Interviewers have been notified.");
    await refresh();
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="Schedule interview" subtitle={`With ${name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Schedule</Button></>}>
      <div className="form-grid">
        <Input label="Title" {...f.bind("title")} wrapClassName="span-2" placeholder="Phone screen, final interview…" />
        <Input label="Date and time" type="datetime-local" value={f.values.when} onChange={(e) => f.set("when", e.target.value)} error={f.errors.scheduledAt} />
        <Select label="Length" {...f.bind("durationMinutes")} options={["15", "30", "45", "60", "90"].map((m) => ({ value: m, label: `${m} minutes` }))} />
        <Select label="Where" {...f.bind("mode")} options={[{ value: "office", label: "Office" }, { value: "phone", label: "Phone" }, { value: "video", label: "Video call" }]} />
        <Input label={f.values.mode === "video" ? "Meeting link" : f.values.mode === "phone" ? "Phone number" : "Address or room"} optional {...f.bind("location")} />
      </div>
      <div className="field rc-mt">
        <span className="field-label">Interviewers</span>
        {members.isLoading ? <span className="muted">Loading team…</span> : (
          <div className="rc-check-list">
            {(members.data ?? []).map((m) => (
              <Checkbox key={m.id} label={m.name} checked={f.values.interviewerUserIds.includes(m.id)} onChange={() => toggle(m.id)} />
            ))}
          </div>
        )}
        {f.errors.interviewerUserIds && <span className="field-error">{f.errors.interviewerUserIds}</span>}
      </div>
    </Modal>
  );
}

// ---------------- scorecard ----------------
export function ScorecardForm({ applicationId, interviewId, initial, onSaved }: {
  applicationId: string; interviewId: string | null;
  initial: { ratings: Record<string, number>; recommendation: Recommendation | null; notes: string | null; submittedAt: string | null } | null;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const [ratings, setRatings] = useState<Record<string, number>>(initial?.ratings ?? {});
  const [rec, setRec] = useState<Recommendation | null>(initial?.recommendation ?? null);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const locked = !!initial?.submittedAt;

  useEffect(() => {
    setRatings(initial?.ratings ?? {}); setRec(initial?.recommendation ?? null); setNotes(initial?.notes ?? ""); setError(null); setFieldErrors({});
  }, [applicationId, interviewId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(submit: boolean) {
    setBusy(submit ? "submit" : "draft"); setError(null); setFieldErrors({});
    try {
      await api.put(`/api/recruitment/applications/${applicationId}/scorecard`, { interviewId, ratings, recommendation: rec, notes, submit });
      toast(submit ? "Feedback submitted" : "Draft saved");
      await refresh();
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiError) { setError(e.message); setFieldErrors(e.details ?? {}); } else setError("Something went wrong. Please try again.");
    } finally { setBusy(null); }
  }

  return (
    <div className="rc-scorecard">
      {locked && <Notice tone="ok">You submitted this feedback on {fmtDate(initial!.submittedAt)}.</Notice>}
      {CRITERIA.map((c) => (
        <div key={c} className="rc-crit">
          <div className="between"><b>{c}</b><span className="muted">{RATING_WORDS[ratings[c] ?? 0] || "Not rated"}</span></div>
          <div className="rc-rate" role="radiogroup" aria-label={c}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={ratings[c] === n} disabled={locked}
                className={ratings[c] === n ? "on" : ""} onClick={() => setRatings((r) => ({ ...r, [c]: n }))}>{n}</button>
            ))}
          </div>
          {fieldErrors[`ratings.${c}`] && <span className="field-error">{fieldErrors[`ratings.${c}`]}</span>}
        </div>
      ))}
      <div className="rc-crit">
        <b>Your recommendation</b>
        <div className="rc-recs" role="radiogroup" aria-label="Recommendation">
          {RECOMMENDATIONS.map((r) => (
            <button key={r.value} type="button" role="radio" aria-checked={rec === r.value} disabled={locked}
              className={rec === r.value ? `on ${r.value.includes("no") ? "neg" : "pos"}` : ""} onClick={() => setRec(r.value)}>{r.label}</button>
          ))}
        </div>
        {fieldErrors.recommendation && <span className="field-error">{fieldErrors.recommendation}</span>}
      </div>
      <Textarea label="Notes" value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} placeholder="What stood out? Anything to follow up on?" />
      {error && <Notice tone="error">{error}</Notice>}
      {!locked && (
        <div className="rc-actions-end">
          <Button variant="secondary" loading={busy === "draft"} disabled={!!busy} onClick={() => save(false)}>Save draft</Button>
          <Button loading={busy === "submit"} disabled={!!busy} onClick={() => save(true)}>Submit feedback</Button>
        </div>
      )}
      <p className="rc-footnote">Other interviewers' scores stay hidden until you submit, so feedback stays fair.</p>
    </div>
  );
}

// ---------------- hire ----------------
type EmployeeOption = { id: string; name: string };

function useEmployees(enabled: boolean) {
  return useQuery({
    queryKey: ["recruitment", "employee-options"],
    enabled,
    retry: false,
    queryFn: async (): Promise<EmployeeOption[]> => {
      const r = await api.get<unknown>("/api/people/employees");
      const list = Array.isArray(r) ? r : ((r as { items?: unknown[]; employees?: unknown[] })?.items ?? (r as { employees?: unknown[] })?.employees ?? []);
      return (list as Record<string, unknown>[])
        .filter((e) => typeof e?.id === "string")
        .map((e) => ({ id: e.id as string, name: (e.name as string) || [e.firstName, e.lastName].filter(Boolean).join(" ") || "Unnamed" }));
    },
  });
}

export function HireModal({ detail, open, onClose }: { detail: ApplicationDetail; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const departments = useDepartments();
  const employees = useEmployees(open);
  const first = detail.candidate.firstName;
  const f = useForm({ jobTitle: detail.job.title, departmentId: detail.job.departmentId ?? "", managerEmployeeId: "", startDate: "" });
  const [done, setDone] = useState<{ id: string; already: boolean } | null>(null);
  useEffect(() => { if (open) setDone(null); }, [open]);
  const deptName = departments.data?.find((d) => d.id === f.values.departmentId)?.name;
  const save = () => f.submit(async (v) => {
    if (!v.startDate) { f.setErrors({ startDate: "Choose a start date" }); throw new ApiError(400, "bad_request", "Choose a start date", { startDate: "Choose a start date" }); }
    const r = await api.post<{ employee: { id: string }; alreadyHired: boolean }>(`/api/recruitment/applications/${detail.application.id}/hire`, {
      jobTitle: v.jobTitle, departmentId: v.departmentId || null, managerEmployeeId: v.managerEmployeeId || null, startDate: v.startDate,
    });
    setDone({ id: r.employee.id, already: r.alreadyHired });
    toast(r.alreadyHired ? `${detail.candidate.name} was already hired` : `${detail.candidate.name} hired`);
    await refresh();
  });

  if (done) {
    return (
      <Modal open={open} onClose={onClose} title={done.already ? `${detail.candidate.name} is already hired` : `${detail.candidate.name} is hired`}
        footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Link className="btn btn-primary" to={`/people/employees/${done.id}`}>Open employee record</Link></>}>
        <Notice tone="ok">{done.already ? "Their employee record already exists, so nothing was duplicated." : `${first}'s employee record is ready in People & HR and their onboarding checklist has started in Workflows.`}</Notice>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" title={`Hire ${detail.candidate.name}`}
      subtitle="This creates their employee record in People & HR. Check the details first."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Hire and create employee</Button></>}>
      <div className="form-grid">
        <Input label="Job title" {...f.bind("jobTitle")} />
        <Select label="Department" placeholder={departments.data?.length ? "No department" : "No departments yet"} options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} {...f.bind("departmentId")} />
        <Select label="Manager" placeholder="No manager" options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.name }))} {...f.bind("managerEmployeeId")}
          hint={employees.isError ? "Managers can be set later in People & HR." : undefined} />
        <Input label="Start date" type="date" {...f.bind("startDate")} />
      </div>
      <div className="section-label rc-mt">What moves across</div>
      <ul className="rc-moves">
        <li><Checkbox label="Name, email and phone" checked readOnly disabled /><span>Copied to the employee record</span></li>
        <li><Checkbox label="CV and application answers" checked readOnly disabled /><span>{detail.application.cvFileId ? "Filed in Documents" : "No CV on file"}</span></li>
        <li><Checkbox label="Interview feedback" checked={false} readOnly disabled /><span>Stays in Recruitment only</span></li>
        <li><Checkbox label="Expected salary" checked={false} readOnly disabled /><span>You'll confirm pay in People & HR</span></li>
      </ul>
      <Notice tone="info" icon={<Users size={18} />}>
        {first} will appear in <b>People & HR</b>{f.values.startDate ? <> as <b>Starting {fmtDate(f.values.startDate, { day: "numeric", month: "short" })}</b></> : null}
        {deptName ? <> in <b>{deptName}</b></> : null}, and the onboarding checklist will begin in Workflows.
      </Notice>
    </Modal>
  );
}
