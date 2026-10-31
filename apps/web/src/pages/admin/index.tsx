import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, ExternalLink, Eye, FileText, Image as ImageIcon, RotateCcw, X } from "lucide-react";
import {
  Avatar, Button, Card, EmptyState, Loading, Modal, PageHeader, Pill, SearchInput, Segmented, Select, Stat, Switch, Textarea, useToast,
} from "@windveal/ui";
import { PLANS, formatBytes } from "@windveal/shared";
import { api, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
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
const country = (code: string) => new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;

function OrgMark({ name, logoFileId, size = 36 }: { name: string; logoFileId: string | null; size?: number }) {
  return (
    <span className="ad-mark" style={{ width: size, height: size }}>
      {logoFileId ? <img src={adminFileUrl(logoFileId)} alt="" draggable={false} /> : name.slice(0, 1)}
    </span>
  );
}

function AdminTabs() {
  return (
    <div className="tabs">
      <NavLink to="/admin" end className={({ isActive }) => `tab ${isActive ? "active" : ""}`}>Organisations</NavLink>
      <NavLink to="/admin/people" className={({ isActive }) => `tab ${isActive ? "active" : ""}`}>People</NavLink>
    </div>
  );
}

// ---------------- Organisations ----------------
function Organisations() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status | "all">("pending");
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
          { value: "pending", label: "Waiting" }, { value: "verified", label: "Verified" }, { value: "rejected", label: "Not verified" }, { value: "all", label: "All" },
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
                  <td><Pill tone={STATUS[o.verificationStatus as Status].tone}>{STATUS[o.verificationStatus as Status].label}</Pill></td>
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
  if (!q.data) return <EmptyState title="Organisation not found" action={<Button onClick={() => navigate("/admin")}>All organisations</Button>} />;
  const d = q.data;
  const o = d.org;
  const perks: string[] = o.settings?.perks ?? [];
  const image = (fileId: string, name: string) => setViewing({ id: fileId, name, mime: "image/*" });
  const c = d.counts;
  return (
    <>
      <PageHeader title={o.name} subtitle={`${o.legalName} · ${country(o.country)} · registered ${fmtDate(o.createdAt)}`} back={{ label: "All organisations", onClick: () => navigate("/admin") }} />
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
  const { user } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["admin", "users", q], queryFn: () => api.get<any[]>(`/api/admin/users${qs({ q })}`) });
  const setAdmin = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) => api.post(`/api/admin/users/${id}/platform-admin`, { value }),
    onSuccess: (_r, v) => { toast(v.value ? "WindVeal admin access given" : "WindVeal admin access removed"); qc.invalidateQueries({ queryKey: ["admin", "users"] }); },
  });
  return (
    <>
      <div className="between ad-filters"><span className="muted">Everyone with a WindVeal account.</span><SearchInput value={q} onChange={setQ} placeholder="Name or email" /></div>
      {list.isLoading ? <Loading /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th className="hide-sm">Organisation</th><th className="hide-sm">Joined</th><th className="hide-sm">Last signed in</th><th>WindVeal admin</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td><span className="row" style={{ gap: 10 }}><Avatar name={u.name} src={u.avatarFileId ? adminFileUrl(u.avatarFileId) : null} /><span style={{ minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{u.name}</b><small className="muted">{u.email}{!u.emailVerified && " · not verified"}</small></span></span></td>
                  <td className="hide-sm">{u.org ? <button className="link" onClick={() => navigate(`/admin/organisations/${u.org.id}`)}>{u.org.name}</button> : <span className="muted">None yet</span>}{u.org?.role && <small className="muted"> · {u.org.role}</small>}</td>
                  <td className="hide-sm">{fmtDate(u.createdAt)}</td>
                  <td className="hide-sm">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Never"}</td>
                  <td><Switch label={`WindVeal admin for ${u.name}`} checked={u.platformAdmin} disabled={u.id === user.id} onChange={(value) => setAdmin.mutate({ id: u.id, value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      <Route path="*" element={<>
        <PageHeader title="WindVeal admin" subtitle="Review the organisations that sign up and everything they send in." />
        <AdminTabs />
        <Routes>
          <Route index element={<Organisations />} />
          <Route path="people" element={<People />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </>} />
    </Routes>
  );
}
