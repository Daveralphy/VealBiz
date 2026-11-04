import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Download, ExternalLink, Eye, FileText, Image as ImageIcon, KeyRound, LogOut, MailCheck, Pause, RotateCcw, ShieldCheck, X } from "lucide-react";
import {
  Avatar, Button, Card, EmptyState, Loading, Modal, PageHeader, Pill, SearchInput, Segmented, Select, Stat, Textarea, useConfirm, useToast,
} from "@windveal/ui";
import { PLANS, formatBytes } from "@windveal/shared";
import { api, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { DashKpis } from "../../components/dashboard";
import { SITE_URL } from "../../lib/config";
import { fmtDate, timeAgo } from "../../lib/format";
import { FileViewer, type ViewableFile } from "../../components/FileViewer";

const adminFileUrl = (id: string, download = false) => `/api/admin/files/${id}/content${download ? "?download=1" : ""}`;

type Status = "pending" | "verified" | "rejected";
const STATUS: Record<Status, { label: string; tone: "warn" | "ok" | "red" }> = {
  pending: { label: "Waiting for review", tone: "warn" },
  verified: { label: "Verified", tone: "ok" },
  rejected: { label: "Not verified", tone: "red" },
};
const ACCOUNT = { active: "Active", suspended: "Suspended", closed: "Closed" } as const;
const country = (code: string) => new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;

function OrgMark({ name, logoFileId, size = 36 }: { name: string; logoFileId: string | null; size?: number }) {
  return (
    <span className="ad-mark" style={{ width: size, height: size }}>
      {logoFileId ? <img src={adminFileUrl(logoFileId)} alt="" draggable={false} /> : name.slice(0, 1)}
    </span>
  );
}


// ---------------- Organisations ----------------
function Organisations() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status | "suspended" | "closed" | "all">(() => (new URLSearchParams(location.search).get("status") as any) || "pending");
  const [q, setQ] = useState("");
  const summary = useQuery({ queryKey: ["admin", "summary"], queryFn: () => api.get("/api/admin/summary") });
  const list = useQuery({
    queryKey: ["admin", "orgs", status, q],
    queryFn: () => api.get<any[]>(`/api/admin/organisations${qs({ status: status === "all" ? undefined : status, q })}`),
  });
  const s = summary.data;
  return (
    <>
      {s && (
        <div className="ad-stats">
          <Stat label="Waiting for review" value={s.pending} />
          <Stat label="Verified" value={s.verified} />
          <Stat label="Not verified" value={s.rejected} />
          <Stat label="New this week" value={s.newThisWeek} />
          <Stat label="People on WindVeal" value={s.users} />
        </div>
      )}
      <div className="between ad-filters">
        <Segmented value={status} onChange={setStatus} options={[
          { value: "pending", label: "Waiting" }, { value: "verified", label: "Verified" }, { value: "rejected", label: "Not verified" },
          { value: "suspended", label: "Suspended" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" },
        ]} />
        <SearchInput value={q} onChange={setQ} placeholder="Name, registration number or email" />
      </div>
      {list.isLoading ? <Loading /> : !(list.data ?? []).length ? (
        <Card><EmptyState title={status === "pending" ? "Nothing waiting for review" : "No organisations found"}>
          {status === "pending" ? "New organisations appear here as soon as they register." : "Try another filter or search."}
        </EmptyState></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Organisation</th><th className="hide-sm">Registered by</th><th className="hide-sm">Country</th><th className="hide-sm">Plan</th><th className="hide-sm">Documents</th><th>Registered</th><th>Status</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate(`/admin/organisations/${o.id}`)}>
                  <td><span className="row" style={{ gap: 10 }}><OrgMark name={o.name} logoFileId={o.logoFileId} /><span style={{ minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{o.name}</b><small className="muted">{o.legalName}{o.registrationNumber ? ` · ${o.registrationNumber}` : ""}</small></span></span></td>
                  <td className="hide-sm"><span style={{ display: "block" }}>{o.creator.name}</span><small className="muted">{o.creator.email}</small></td>
                  <td className="hide-sm">{country(o.country)}</td>
                  <td className="hide-sm" style={{ textTransform: "capitalize" }}>{o.plan}</td>
                  <td className="hide-sm">{o.documents || <span className="muted">None</span>}</td>
                  <td>{timeAgo(o.createdAt)}</td>
                  <td>{o.accountStatus !== "active" ? <Pill tone={o.accountStatus === "closed" ? "grey" : "red"}>{ACCOUNT[o.accountStatus as "suspended" | "closed"]}</Pill>
                    : <Pill tone={STATUS[o.verificationStatus as Status].tone}>{STATUS[o.verificationStatus as Status].label}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------- One organisation ----------------
function Review({ data }: { data: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const o = data.org;
  const [decision, setDecision] = useState<Status | null>(null);
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<string>(o.plan);
  const [billing, setBilling] = useState<string>(o.billing);
  useEffect(() => { setPlan(o.plan); setBilling(o.billing); }, [o.plan, o.billing]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const decide = useMutation({
    mutationFn: () => api.post(`/api/admin/organisations/${o.id}/verification`, { status: decision, note }),
    onSuccess: () => {
      toast(decision === "verified" ? `${o.name} is verified` : decision === "rejected" ? `${o.name} was told what to fix` : `${o.name} is back in review`);
      setDecision(null); setNote(""); refresh();
    },
  });
  const savePlan = useMutation({
    mutationFn: () => api.post(`/api/admin/organisations/${o.id}/plan`, { plan, billing }),
    onSuccess: () => { toast("Plan updated"); refresh(); },
  });
  const status = o.verificationStatus as Status;
  return (
    <Card title="Review" actions={<Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>}>
      {o.verificationReviewedAt && <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Last decided {fmtDate(o.verificationReviewedAt)}{data.reviewer ? ` by ${data.reviewer.name}` : ""}.</p>}
      {o.verificationNote && <p className={`pf-note ${status === "rejected" ? "bad" : ""}`}><b>Note sent:</b> {o.verificationNote}</p>}
      <div className="stack" style={{ gap: 8 }}>
        {status !== "verified" && <Button block icon={<Check size={16} />} onClick={() => setDecision("verified")}>Approve</Button>}
        {status !== "rejected" && <Button block variant="secondary" icon={<X size={16} />} onClick={() => setDecision("rejected")}>Don't approve</Button>}
        {status !== "pending" && <Button block variant="ghost" icon={<RotateCcw size={16} />} onClick={() => setDecision("pending")}>Send back to review</Button>}
      </div>
      <h4 className="pf-sub">Plan</h4>
      <div className="form-grid">
        <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} options={PLANS.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} />
        <Select label="Billing" value={billing} onChange={(e) => setBilling(e.target.value)} options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]} />
      </div>
      {(plan !== o.plan || billing !== o.billing) && <Button variant="secondary" block style={{ marginTop: 12 }} loading={savePlan.isPending} onClick={() => savePlan.mutate()}>Save plan</Button>}
      <Modal open={!!decision} onClose={() => setDecision(null)}
        title={decision === "verified" ? `Approve ${o.name}?` : decision === "rejected" ? `Don't approve ${o.name}` : "Send back to review"}
        subtitle={decision === "verified" ? "Their careers page goes live and their admins are told." : decision === "rejected" ? "Their admins see this note and can fix their details or send a document." : "It goes back to the waiting list."}
        footer={<>
          <Button variant="secondary" onClick={() => setDecision(null)}>Cancel</Button>
          <Button variant={decision === "rejected" ? "danger" : "primary"} loading={decide.isPending} disabled={decision === "rejected" && !note.trim()} onClick={() => decide.mutate()}>
            {decision === "verified" ? "Approve" : decision === "rejected" ? "Send note" : "Send back"}
          </Button>
        </>}>
        <Textarea label={decision === "rejected" ? "What needs fixing" : "Note to the organisation"} optional={decision !== "rejected"} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={decision === "rejected" ? "e.g. The registration number doesn't match the certificate." : ""} />
      </Modal>
    </Card>
  );
}

function FilesCard({ orgId, onOpen }: { orgId: string; onOpen: (f: ViewableFile) => void }) {
  const [q, setQ] = useState("");
  const files = useQuery({ queryKey: ["admin", "files", orgId, q], queryFn: () => api.get<any[]>(`/api/admin/organisations/${orgId}/files${qs({ q })}`) });
  return (
    <Card title="Everything they've uploaded" subtitle="Documents library, attachments, CVs and branding." actions={<SearchInput value={q} onChange={setQ} placeholder="Search files" />}>
      {files.isLoading ? <Loading /> : !(files.data ?? []).length ? <p className="muted">No files.</p> : (
        <div className="ad-files">
          {(files.data ?? []).map((f) => (
            <div key={f.id} className="list-row">
              {f.mime.startsWith("image/") ? <ImageIcon size={18} className="muted" /> : <FileText size={18} className="muted" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <button className="link pf-file" onClick={() => onOpen(f)}>{f.name}</button>
                <small className="muted" style={{ display: "block" }}>
                  {[f.folder ?? (f.kind === "system" ? "Attachment or branding" : "Documents"), formatBytes(f.size), f.uploader, fmtDate(f.createdAt)].filter(Boolean).join(" · ")}
                </small>
              </div>
              <a className="icon-btn" href={adminFileUrl(f.id, true)} download={f.name} aria-label={`Download ${f.name}`} title="Download"><Download size={16} /></a>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function OrganisationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [viewing, setViewing] = useState<ViewableFile | null>(null);
  const q = useQuery({ queryKey: ["admin", "org", id], queryFn: () => api.get(`/api/admin/organisations/${id}`) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <EmptyState title="Organisation not found" action={<Button onClick={() => navigate("/admin/organisations")}>All organisations</Button>} />;
  const d = q.data;
  const o = d.org;
  const perks: string[] = o.settings?.perks ?? [];
  const image = (fileId: string, name: string) => setViewing({ id: fileId, name, mime: "image/*" });
  const c = d.counts;
  return (
    <>
      <PageHeader title={o.name} subtitle={`${o.legalName} · ${country(o.country)} · registered ${fmtDate(o.createdAt)}`} back={{ label: "All organisations", onClick: () => navigate("/admin/organisations") }} />
      <div className="pf-company">
        <button className="pf-cover ad-cover" disabled={!o.coverFileId} onClick={() => o.coverFileId && image(o.coverFileId, "Cover image")}
          style={o.coverFileId ? { backgroundImage: `url(${adminFileUrl(o.coverFileId)})` } : { background: `linear-gradient(120deg, ${o.brandColor ?? "#263f91"}, var(--night))` }}
          aria-label="Open cover image" />
        <div className="pf-company-bar">
          <button className="pf-logo" style={!o.logoFileId ? { background: o.brandColor ?? "var(--navy)", color: "#fff" } : undefined} disabled={!o.logoFileId}
            onClick={() => o.logoFileId && image(o.logoFileId, "Logo")} aria-label="Open logo">
            {o.logoFileId ? <img src={adminFileUrl(o.logoFileId)} alt="" draggable={false} /> : o.name.slice(0, 1)}
          </button>
          <div className="pf-head-text"><h2>{o.name}</h2><p className="muted">{o.tagline || o.legalName}</p></div>
          {o.verificationStatus === "verified" && <a className="btn btn-ghost btn-sm" href={`${SITE_URL}/careers/${o.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={15} />Careers page</a>}
        </div>
      </div>
      <div className="grid-side side-360">
        <div>
          <Card title="Registration details">
            <dl className="kv pf-kv">
              {([
                ["Registered name", o.legalName], ["Trading name", o.tradingName], ["Registration number", o.registrationNumber],
                ["Industry", o.industry], ["Team size", o.teamSize], ["Country and currency", `${country(o.country)} · ${o.currency}`],
                ["City", o.city], ["Address", o.address],
                ["Website", o.website && <a href={o.website} target="_blank" rel="noreferrer">{o.website.replace(/^https?:\/\//, "")}</a>],
                ["Owner", o.ownerName && `${o.ownerName}${o.ownerEmail ? ` (${o.ownerEmail})` : ""}`],
                ["Setup", o.setupStep === "done" ? "Finished" : `At step: ${o.setupStep}`], ["Web address", `/careers/${o.slug}`],
              ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || <span className="muted">Not given</span>}</dd></div>)}
            </dl>
          </Card>
          <Card title="Verification documents" subtitle="What they sent to prove the business is real.">
            {!d.documents.length ? <p className="muted">They haven't sent any documents.</p> : d.documents.map((f: any) => (
              <div key={f.id} className="list-row">
                <FileText size={18} className="muted" />
                <div style={{ flex: 1, minWidth: 0 }}><button className="link pf-file" onClick={() => setViewing(f)}>{f.name}</button><small className="muted" style={{ display: "block" }}>{formatBytes(f.size)} · {fmtDate(f.createdAt)}</small></div>
                <Button variant="secondary" size="sm" icon={<Eye size={15} />} onClick={() => setViewing(f)}>Open</Button>
              </div>
            ))}
          </Card>
          <Card title="Branding and careers page">
            <dl className="kv pf-kv">
              <div><dt>Logo</dt><dd>{o.logoFileId ? <button className="link" onClick={() => image(o.logoFileId, "Logo")}>Open</button> : <span className="muted">Not given</span>}</dd></div>
              <div><dt>Cover image</dt><dd>{o.coverFileId ? <button className="link" onClick={() => image(o.coverFileId, "Cover image")}>Open</button> : <span className="muted">Not given</span>}</dd></div>
              <div><dt>Brand colour</dt><dd>{o.brandColor ? <span className="row" style={{ justifyContent: "flex-end", gap: 8 }}><i className="pf-swatch" style={{ background: o.brandColor }} />{o.brandColor}</span> : <span className="muted">Not given</span>}</dd></div>
              <div><dt>Tagline</dt><dd>{o.tagline || <span className="muted">Not given</span>}</dd></div>
            </dl>
            <h4 className="pf-sub">About</h4>
            <p className="pf-about">{o.about || <span className="muted">Not given</span>}</p>
            <h4 className="pf-sub">Why work with us</h4>
            {perks.length ? <ul className="pf-perks">{perks.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="muted">Not given</p>}
          </Card>
          <FilesCard orgId={o.id} onOpen={setViewing} />
          <Card title="Activity" subtitle="Their audit history, newest first.">
            {!d.history.length ? <p className="muted">No activity yet.</p> : d.history.map((h: any) => (
              <div key={h.id} className="list-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}><span className="ink">{h.summary}</span><small className="muted" style={{ display: "block" }}>{[h.actor, h.device, `${fmtDate(h.createdAt)} · ${timeAgo(h.createdAt)}`].filter(Boolean).join(" · ")}</small></div>
              </div>
            ))}
          </Card>
        </div>
        <div>
          <Review data={d} />
          <AccountCard org={o} />
          {d.creator && (
            <Card title="Registered by">
              <div className="list-row"><Avatar name={d.creator.name} /><div style={{ minWidth: 0, flex: 1 }}><b className="ink" style={{ display: "block" }}>{d.creator.name}</b><small className="muted">{d.creator.email}</small></div>{d.creator.emailVerified ? <Pill tone="ok">Email verified</Pill> : <Pill tone="warn">Email not verified</Pill>}</div>
              <dl className="kv pf-kv" style={{ marginTop: 12 }}>
                <div><dt>Phone</dt><dd>{d.creator.phone || <span className="muted">Not given</span>}</dd></div>
                <div><dt>Account created</dt><dd>{fmtDate(d.creator.createdAt)}</dd></div>
                <div><dt>Last signed in</dt><dd>{d.creator.lastLoginAt ? timeAgo(d.creator.lastLoginAt) : "Never"}</dd></div>
              </dl>
            </Card>
          )}
          <Card title={`Members (${d.members.length})`}>
            {d.members.map((m: any) => (
              <div key={m.id} className="list-row">
                <Avatar name={m.name} src={m.avatarFileId ? adminFileUrl(m.avatarFileId) : null} />
                <div style={{ minWidth: 0, flex: 1 }}><b className="ink" style={{ display: "block" }}>{m.name}</b><small className="muted">{m.email}{m.jobTitle ? ` · ${m.jobTitle}` : ""}</small></div>
                <Pill tone={m.status === "active" ? "blue" : "grey"}>{m.isPrimaryAdmin ? "Primary admin" : m.role}</Pill>
              </div>
            ))}
            {!!d.invitations.length && <>
              <h4 className="pf-sub">Invited, not joined yet</h4>
              {d.invitations.map((i: any) => <div key={i.id} className="list-row"><div style={{ flex: 1, minWidth: 0 }}><span className="ink">{i.email}</span><small className="muted" style={{ display: "block" }}>Invited {timeAgo(i.createdAt)}</small></div><Pill tone="grey">{i.role}</Pill></div>)}
            </>}
          </Card>
          <Card title="Usage">
            <dl className="kv pf-kv">
              {([["Employees", c.employees], ["Jobs", c.jobs], ["Applications", c.applications], ["Clients and companies", c.companies], ["Leads", c.leads], ["Deals", c.deals], ["Tasks", c.tasks], ["Files", c.files], ["Storage used", formatBytes(d.storageUsed)]] as [string, React.ReactNode][])
                .map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </Card>
        </div>
      </div>
      <FileViewer file={viewing} url={adminFileUrl} onClose={() => setViewing(null)} />
    </>
  );
}

// ---------------- People ----------------
function People() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["admin", "users", q], queryFn: () => api.get<any[]>(`/api/admin/users${qs({ q })}`) });
  return (
    <>
      <div className="between ad-filters"><span className="muted">Everyone with a WindVeal account. Open someone to see their details and manage their account.</span><SearchInput value={q} onChange={setQ} placeholder="Name or email" /></div>
      {list.isLoading ? <Loading /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th className="hide-sm">Organisation</th><th className="hide-sm">Joined</th><th className="hide-sm">Last signed in</th><th>Account</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((u) => (
                <tr key={u.id} className="clickable" onClick={() => navigate(`/admin/people/${u.id}`)}>
                  <td><span className="row" style={{ gap: 10 }}><Avatar name={u.name} src={u.avatarFileId ? adminFileUrl(u.avatarFileId) : null} /><span style={{ minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{u.name}</b><small className="muted">{u.email}{!u.emailVerified && " · not verified"}</small></span></span></td>
                  <td className="hide-sm">{u.org ? <>{u.org.name}{u.org.role && <small className="muted"> · {u.org.role}</small>}</> : <span className="muted">None yet</span>}</td>
                  <td className="hide-sm">{fmtDate(u.createdAt)}</td>
                  <td className="hide-sm">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Never"}</td>
                  <td><span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {u.deactivated ? <Pill tone="red">Deactivated</Pill> : <Pill tone="ok">Active</Pill>}
                    {u.platformAdmin && <Pill tone="violet">WindVeal admin</Pill>}
                  </span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------- Overview ----------------
function Overview() {
  const navigate = useNavigate();
  const summary = useQuery({ queryKey: ["admin", "summary"], queryFn: () => api.get("/api/admin/summary") });
  const o = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api.get("/api/admin/overview") });
  const s = summary.data;
  return (
    <>
      <DashKpis loading={!s} items={[
        { label: "Waiting for approval", value: s?.pending ?? 0, note: s?.pending ? "review now" : "all caught up", to: "/admin/organisations?status=pending" },
        { label: "Verified organisations", value: s?.verified ?? 0, note: `${s?.newThisWeek ?? 0} new this week`, to: "/admin/organisations?status=verified" },
        { label: "Suspended or closed", value: (s?.suspended ?? 0) + (s?.closed ?? 0), note: "organisations", to: "/admin/organisations?status=suspended" },
        { label: "People on WindVeal", value: s?.users ?? 0, note: s?.deactivatedUsers ? `${s.deactivatedUsers} deactivated` : "all active", to: "/admin/people" },
      ]} />
      {o.isLoading ? <Loading /> : o.data && (
        <div className="grid-side side-360">
          <Card title="Review queue" subtitle="Oldest first. Open one to check what they sent in."
            actions={<Button variant="ghost" size="sm" onClick={() => navigate("/admin/organisations?status=pending")}>See all</Button>}>
            {!o.data.waiting.length ? <EmptyState title="Nothing waiting">New organisations appear here as soon as they register.</EmptyState> : o.data.waiting.map((w: any) => (
              <button key={w.id} className="list-row ad-row" onClick={() => navigate(`/admin/organisations/${w.id}`)}>
                <OrgMark name={w.name} logoFileId={w.logoFileId} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b className="ink" style={{ display: "block" }}>{w.name}</b>
                  <small className="muted">{w.creator.name} · {country(w.country)} · {w.documents ? `${w.documents} document${w.documents === 1 ? "" : "s"}` : "no documents yet"}</small>
                </span>
                <small className="muted">waiting {timeAgo(w.createdAt).replace(" ago", "")}</small>
              </button>
            ))}
          </Card>
          <div>
            <Card title="New people">
              {o.data.newUsers.map((u: any) => (
                <button key={u.id} className="list-row ad-row" onClick={() => navigate(`/admin/people/${u.id}`)}>
                  <Avatar name={u.name} size={32} />
                  <span style={{ flex: 1, minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{u.name}</b><small className="muted">{u.org?.name ?? "No organisation yet"}{!u.emailVerified && " · email not verified"}</small></span>
                  <small className="muted">{timeAgo(u.createdAt)}</small>
                </button>
              ))}
            </Card>
            {!!o.data.paused.length && (
              <Card title="Suspended or closed">
                {o.data.paused.map((x: any) => (
                  <button key={x.id} className="list-row ad-row" onClick={() => navigate(`/admin/organisations/${x.id}`)}>
                    <span style={{ flex: 1, minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{x.name}</b><small className="muted">{x.reason ?? ""}</small></span>
                    <Pill tone={x.accountStatus === "closed" ? "grey" : "red"}>{ACCOUNT[x.accountStatus as "suspended" | "closed"]}</Pill>
                  </button>
                ))}
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** A reason box for actions that need one (suspend, close, deactivate). */
function ReasonModal({ open, title, subtitle, label, confirmLabel, danger, needReason, busy, onClose, onConfirm }: {
  open: boolean; title: string; subtitle: string; label: string; confirmLabel: string; danger?: boolean; needReason: boolean; busy: boolean;
  onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (open) setReason(""); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} loading={busy} disabled={needReason && !reason.trim()} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button></>}>
      {needReason && <Textarea label={label} value={reason} onChange={(e) => setReason(e.target.value)} />}
    </Modal>
  );
}

/** Suspend, close or reactivate an organisation's account. */
function AccountCard({ org: o }: { org: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { org: mine } = useSession();
  const [action, setAction] = useState<"suspended" | "closed" | "active" | null>(null);
  const save = useMutation({
    mutationFn: (reason: string) => api.post(`/api/admin/organisations/${o.id}/account`, { status: action, reason }),
    onSuccess: () => {
      toast(action === "active" ? `${o.name} is active again` : `${o.name} was ${action}`);
      setAction(null);
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  const st = o.accountStatus as "active" | "suspended" | "closed";
  const own = o.id === mine.id;
  const copy = {
    suspended: { title: `Suspend ${o.name}?`, sub: "Their team can't use WindVeal and their careers page goes offline until you reactivate them. Nothing is deleted.", label: "Reason (sent to their admins)", btn: "Suspend account" },
    closed: { title: `Close ${o.name}'s account?`, sub: "Their team loses access and their careers page goes offline. Their data is kept, so the account can be reopened.", label: "Reason (sent to their admins)", btn: "Close account" },
    active: { title: `Reactivate ${o.name}?`, sub: "Their team can sign in and use WindVeal again, and their careers page comes back if they're verified.", label: "", btn: "Reactivate" },
  };
  return (
    <Card title="Account" actions={<Pill tone={st === "active" ? "ok" : st === "closed" ? "grey" : "red"}>{ACCOUNT[st]}</Pill>}>
      {st !== "active" && <p className={`pf-note bad`}><b>{ACCOUNT[st]}{o.accountStatusAt ? ` ${fmtDate(o.accountStatusAt)}` : ""}:</b> {o.accountStatusReason ?? "No reason given"}</p>}
      {own ? <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>This is your own organisation, so it can't be suspended or closed here.</p> : (
        <div className="stack" style={{ gap: 8 }}>
          {st === "active" && <>
            <Button block variant="secondary" icon={<Pause size={16} />} onClick={() => setAction("suspended")}>Suspend account</Button>
            <Button block variant="ghost" icon={<Ban size={16} />} onClick={() => setAction("closed")}>Close account</Button>
          </>}
          {st !== "active" && <Button block icon={<RotateCcw size={16} />} onClick={() => setAction("active")}>{st === "closed" ? "Reopen account" : "Reactivate account"}</Button>}
        </div>
      )}
      {action && <ReasonModal open title={copy[action].title} subtitle={copy[action].sub} label={copy[action].label} confirmLabel={copy[action].btn}
        danger={action !== "active"} needReason={action !== "active"} busy={save.isPending} onClose={() => setAction(null)} onConfirm={(r) => save.mutate(r)} />}
    </Card>
  );
}

// ---------------- One person ----------------
function PersonDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useSession();
  const { confirm, dialog } = useConfirm();
  const [deactivating, setDeactivating] = useState(false);
  const q = useQuery({ queryKey: ["admin", "user", id], queryFn: () => api.get(`/api/admin/users/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; ok: string }) => api.post(`/api/admin/users/${id}/${path}`, body ?? {}),
    onSuccess: (_r, v) => { toast(v.ok); setDeactivating(false); refresh(); },
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <EmptyState title="Person not found" action={<Button onClick={() => navigate("/admin/people")}>All people</Button>} />;
  const { user: u, membership: m, devices, activeSessions, activity } = q.data;
  const self = u.id === me.id;
  const ask = async (opts: { title: string; message: string; confirmLabel: string; danger?: boolean }, path: string, ok: string, body?: unknown) => {
    if (await confirm(opts)) act.mutate({ path, body, ok });
  };
  return (
    <>
      <PageHeader title={u.name} subtitle={`${u.email} · on WindVeal since ${fmtDate(u.createdAt)}`} back={{ label: "All people", onClick: () => navigate("/admin/people") }} />
      <div className="grid-side side-360">
        <div>
          <Card>
            <div className="pf-head">
              <Avatar name={u.name} size={72} src={u.avatarFileId ? adminFileUrl(u.avatarFileId) : null} />
              <div className="pf-head-text">
                <h2>{u.name}</h2>
                <p className="muted">{m ? `${m.jobTitle ? `${m.jobTitle} · ` : ""}${m.orgName}` : "Not in an organisation yet"}</p>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {u.deactivatedAt ? <Pill tone="red">Deactivated</Pill> : <Pill tone="ok">Active</Pill>}
                  {u.emailVerified ? <Pill tone="ok">Email verified</Pill> : <Pill tone="warn">Email not verified</Pill>}
                  {u.platformAdmin && <Pill tone="violet">WindVeal admin</Pill>}
                </div>
              </div>
            </div>
            {u.deactivatedAt && <p className="pf-note bad" style={{ marginTop: 16 }}><b>Deactivated {fmtDate(u.deactivatedAt)}:</b> {u.deactivatedReason ?? "No reason given"}</p>}
          </Card>
          <Card title="Account details">
            <dl className="kv pf-kv">
              <div><dt>Email</dt><dd>{u.email}</dd></div>
              <div><dt>Phone</dt><dd>{u.phone || <span className="muted">Not added</span>}</dd></div>
              <div><dt>Joined WindVeal</dt><dd>{fmtDate(u.createdAt)}</dd></div>
              <div><dt>Last signed in</dt><dd>{u.lastLoginAt ? `${fmtDate(u.lastLoginAt)} · ${timeAgo(u.lastLoginAt)}` : "Never"}</dd></div>
              <div><dt>Signed in right now on</dt><dd>{activeSessions} {activeSessions === 1 ? "device" : "devices"}</dd></div>
            </dl>
          </Card>
          <Card title="Organisation">
            {!m ? <p className="muted">Not part of an organisation yet. They may still be setting up.</p> : (
              <dl className="kv pf-kv">
                <div><dt>Organisation</dt><dd><button className="link" onClick={() => navigate(`/admin/organisations/${m.orgId}`)}>{m.orgName}</button>{m.orgAccountStatus !== "active" && <> <Pill tone="red">{ACCOUNT[m.orgAccountStatus as "suspended" | "closed"]}</Pill></>}</dd></div>
                <div><dt>Role</dt><dd style={{ textTransform: "capitalize" }}>{m.role}{m.isPrimaryAdmin ? " · primary admin" : ""}{m.isOwner ? " · owner" : ""}</dd></div>
                <div><dt>Job title</dt><dd>{m.jobTitle || <span className="muted">Not added</span>}</dd></div>
                <div><dt>Access in their organisation</dt><dd>{m.status === "active" ? "Active" : "Suspended by their admin"}</dd></div>
                <div><dt>Joined the organisation</dt><dd>{fmtDate(m.joinedAt)}</dd></div>
              </dl>
            )}
          </Card>
          <Card title="Recent activity">
            {!activity.length ? <p className="muted">Nothing yet.</p> : activity.map((e: any) => (
              <div key={e.id} className="list-row"><div style={{ flex: 1, minWidth: 0 }}><span className="ink">{e.summary}</span><small className="muted" style={{ display: "block" }}>{[e.device, `${fmtDate(e.createdAt)} · ${timeAgo(e.createdAt)}`].filter(Boolean).join(" · ")}</small></div></div>
            ))}
          </Card>
        </div>
        <div>
          <Card title="Manage account">
            {self ? <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>This is your own account. Manage it from Profile.</p> : (
              <div className="stack" style={{ gap: 8 }}>
                {u.deactivatedAt
                  ? <Button block icon={<RotateCcw size={16} />} loading={act.isPending} onClick={() => ask({ title: `Reactivate ${u.name}?`, message: "They can sign in again with their email and password.", confirmLabel: "Reactivate", danger: false }, "account", `${u.name} is active again`, { active: true })}>Reactivate account</Button>
                  : <Button block variant="danger" icon={<Ban size={16} />} onClick={() => setDeactivating(true)}>Deactivate account</Button>}
                <Button block variant="secondary" icon={<LogOut size={16} />} onClick={() => ask({ title: `Sign ${u.name} out everywhere?`, message: "They'll need to sign in again on every device.", confirmLabel: "Sign out everywhere", danger: false }, "sign-out", `${u.name} was signed out everywhere`)}>Sign out everywhere</Button>
                <Button block variant="secondary" icon={<KeyRound size={16} />} onClick={() => ask({ title: `Send ${u.name} a password reset link?`, message: `A link to set a new password goes to ${u.email}. It works once, for 1 hour.`, confirmLabel: "Send link", danger: false }, "password-reset", `Reset link sent to ${u.email}`)}>Send password reset</Button>
                {!u.emailVerified && <Button block variant="secondary" icon={<MailCheck size={16} />} onClick={() => ask({ title: `Mark ${u.email} as verified?`, message: "Only do this if you're sure the address belongs to them.", confirmLabel: "Mark verified", danger: false }, "verify-email", "Email marked as verified")}>Mark email verified</Button>}
                <Button block variant="ghost" icon={<ShieldCheck size={16} />} onClick={() => ask(u.platformAdmin
                  ? { title: `Remove ${u.name}'s WindVeal admin access?`, message: "They'll no longer see the WindVeal admin panel.", confirmLabel: "Remove access" }
                  : { title: `Make ${u.name} a WindVeal admin?`, message: "They'll see every organisation and everything it sent in, and can approve, suspend and manage accounts.", confirmLabel: "Give access", danger: false },
                  "platform-admin", u.platformAdmin ? "WindVeal admin access removed" : "WindVeal admin access given", { value: !u.platformAdmin })}>
                  {u.platformAdmin ? "Remove WindVeal admin access" : "Make WindVeal admin"}
                </Button>
              </div>
            )}
          </Card>
          <Card title={`Devices (${devices.length})`}>
            {!devices.length ? <p className="muted">No devices yet.</p> : devices.map((d: any) => (
              <div key={d.id} className="list-row"><div style={{ flex: 1, minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{d.label}</b><small className="muted">Last active {timeAgo(d.lastSeenAt)}{d.ip ? ` · ${d.ip}` : ""}</small></div>{d.blocked && <Pill tone="red">Blocked</Pill>}</div>
            ))}
          </Card>
        </div>
      </div>
      <ReasonModal open={deactivating} title={`Deactivate ${u.name}?`} subtitle="They're signed out everywhere and can't sign in until you reactivate them. Nothing is deleted."
        label="Reason (emailed to them)" confirmLabel="Deactivate account" danger needReason busy={act.isPending}
        onClose={() => setDeactivating(false)} onConfirm={(reason) => act.mutate({ path: "account", body: { active: false, reason }, ok: `${u.name} was deactivated` })} />
      {dialog}
    </>
  );
}

export function AdminRoutes() {
  const { user } = useSession();
  useEffect(() => { document.title = "WindVeal admin"; }, []);
  if (!user.platformAdmin) return <Navigate to="/" replace />;
  return (
    <Routes>
      <Route path="organisations/:id" element={<OrganisationDetail />} />
      <Route path="people/:id" element={<PersonDetail />} />
      <Route path="*" element={<>
        <PageHeader title="WindVeal admin" subtitle="Approve new organisations, look after accounts and help people on WindVeal." />
        <Routes>
          <Route index element={<Overview />} />
          <Route path="organisations" element={<Organisations />} />
          <Route path="people" element={<People />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </>} />
    </Routes>
  );
}
