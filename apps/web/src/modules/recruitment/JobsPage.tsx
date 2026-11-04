import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Globe, Lock, MoreHorizontal } from "lucide-react";
import { Button, ConfirmDialog, EmptyState, IconButton, Loading, Menu, Notice, Pill, SearchInput, Select, useToast } from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { keys, useDepartments, useRefresh, type Job } from "./data";

export function statusPill(status: Job["status"]) {
  return status === "open" ? <Pill tone="ok">Open</Pill> : status === "draft" ? <Pill tone="grey">Draft</Pill> : <Pill tone="red">Closed</Pill>;
}

export function publishState(job: Job, verified: boolean) {
  if (job.isLive) return { icon: <Globe size={15} />, text: "Live on careers page", live: true };
  if (job.status === "closed") return { icon: <Lock size={15} />, text: "Closed to applicants", live: false };
  if (!verified && job.status === "open") return { icon: <Lock size={15} />, text: "Ready to publish after verification", live: false };
  return { icon: <Lock size={15} />, text: "Not on careers page", live: false };
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function JobCard({ job, verified }: { job: Job; verified: boolean }) {
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefresh();
  const { can } = useSession();
  const [confirm, setConfirm] = useState<"close" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const max = Math.max(1, ...(job.funnel ?? []).map((f) => f.count));
  const pub = publishState(job, verified);
  const meta = [job.department, job.location, job.employmentType].filter(Boolean).join(" · ");

  async function act() {
    setBusy(true);
    try {
      if (confirm === "close") await api.post(`/api/recruitment/jobs/${job.id}/close`);
      else await api.del(`/api/recruitment/jobs/${job.id}`);
      toast(confirm === "close" ? `${job.title} closed` : `${job.title} deleted`);
      await refresh();
      setConfirm(null);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally { setBusy(false); }
  }

  return (
    <div className="rc-job" role="link" tabIndex={0} onClick={() => nav(`/recruitment/jobs/${job.id}`)}
      onKeyDown={(e) => e.key === "Enter" && nav(`/recruitment/jobs/${job.id}`)}>
      <div className="rc-job-main">
        <div className="row"><h3>{job.title}</h3>{statusPill(job.status)}</div>
        <p className="muted">{meta || "No details yet"}</p>
      </div>
      <div className="rc-funnel">
        {(job.funnel ?? []).map((f) => (
          <div key={f.stage}>
            <b>{f.count}</b>
            <small>{f.stage}</small>
            <i style={{ width: f.count ? `${Math.max(12, (f.count / max) * 100)}%` : "100%" }} className={f.count ? "on" : ""} />
          </div>
        ))}
      </div>
      <div className={`rc-pub ${pub.live ? "live" : ""}`}>{pub.icon}<span>{pub.text}</span></div>
      <div className="rc-job-menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Menu trigger={(t) => <IconButton label="Job actions" onClick={t}><MoreHorizontal size={18} /></IconButton>}>
          {(close) => <>
            <button onClick={() => { close(); nav(`/recruitment/jobs/${job.id}`); }}>Open pipeline</button>
            {can("recruitment", "edit") && <button onClick={() => { close(); nav(`/recruitment/jobs/${job.id}/edit`); }}>Edit job</button>}
            {job.isLive && <button onClick={async () => { close(); toast((await copyText(job.publicUrl)) ? "Link copied" : job.publicUrl); }}>Copy link</button>}
            {can("recruitment", "edit") && job.status !== "closed" && <><hr /><button onClick={() => { close(); setConfirm("close"); }}>Close job</button></>}
            {can("recruitment", "manage") && <button className="danger" onClick={() => { close(); setConfirm("delete"); }}>Delete job</button>}
          </>}
        </Menu>
      </div>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={act} loading={busy} danger={confirm === "delete"}
        title={confirm === "close" ? `Close ${job.title}?` : `Delete ${job.title}?`} confirmLabel={confirm === "close" ? "Close job" : "Delete job"}>
        <p className="muted">{confirm === "close"
          ? "It comes off the careers page and stops taking applications. Candidates already in the pipeline stay."
          : "The job and its pipeline disappear from Recruitment. Hired employees aren't affected."}</p>
      </ConfirmDialog>
    </div>
  );
}

export function JobsPage() {
  const { org, can } = useSession();
  const nav = useNavigate();
  const verified = org.verificationStatus === "verified";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("open,draft");
  const [dept, setDept] = useState("");
  const departments = useDepartments();
  const params = qs({ status: status === "all" ? "" : status, departmentId: dept, q: q.trim() });
  const jobs = useQuery({ queryKey: keys.jobs(params), queryFn: () => api.get<Job[]>(`/api/recruitment/jobs${params}`), placeholderData: (p) => p });
  const filtered = !!(q || dept || status !== "open,draft");

  return (
    <>
      {!verified && (
        <Notice tone="warn" icon={<Lock size={18} />} action={<Link to="/profile/company">Check status</Link>}>
          <b>Your careers page isn't live yet.</b> Jobs can be shared publicly once {org.name} is verified. You can prepare them now.
        </Notice>
      )}
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search jobs" />
        <Select className="chip-select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[
          { value: "open,draft", label: "Status: Open and draft" }, { value: "open", label: "Status: Open" }, { value: "draft", label: "Status: Draft" },
          { value: "closed", label: "Status: Closed" }, { value: "all", label: "Status: All" },
        ]} />
        <Select className="chip-select" aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)}
          options={[{ value: "", label: "Department: All" }, ...(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))]} />
      </div>
      {jobs.isLoading ? <Loading /> : jobs.isError ? (
        <Notice tone="error" action={<button className="btn btn-ghost" onClick={() => jobs.refetch()}>Try again</button>}>{(jobs.error as Error).message}</Notice>
      ) : !jobs.data?.length ? (
        <div className="card">
          <EmptyState icon={<Briefcase size={24} />} title={filtered ? "No jobs match" : "No jobs yet"}
            action={!filtered && can("recruitment", "edit") ? <Button onClick={() => nav("/recruitment/jobs/new")}>Create your first job</Button> : undefined}>
            {filtered ? "Try a different search or filter." : "Create a job to start collecting applications and tracking candidates."}
          </EmptyState>
        </div>
      ) : (
        <div className="stack">{jobs.data.map((j) => <JobCard key={j.id} job={j} verified={verified} />)}</div>
      )}
    </>
  );
}
