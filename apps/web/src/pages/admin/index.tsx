import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, ExternalLink, FileText, KeyRound, LogOut, MailCheck, Pause, RotateCcw, ShieldCheck } from "lucide-react";
import { Avatar, Button, Card, EmptyState, Input, Loading, Modal, PageHeader, Pill, SearchInput, Segmented, Select, Textarea, useConfirm, useToast } from "@windveal/ui";
import { PLANS, REVIEW_CHECKS, REVIEW_REQUESTS, REVIEW_REQUEST_KEYS, VERIFICATION_DOC_KINDS, formatBytes, type ReviewRequestKey } from "@windveal/shared";
import { api, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { DashKpis } from "../../components/dashboard";
import { SITE_URL } from "../../lib/config";
import { fmtDate, fmtTime, timeAgo } from "../../lib/format";
import { FileViewer, type ViewableFile } from "../../components/FileViewer";

const adminFileUrl = (id: string, download = false) => `/api/admin/files/${id}/content${download ? "?download=1" : ""}`;

type Status = "pending" | "needs_info" | "verified" | "rejected";
const STATUS: Record<Status, { label: string; tone: "warn" | "ok" | "red" | "blue" }> = {
  pending: { label: "Waiting for review", tone: "warn" },
  needs_info: { label: "Waiting for them", tone: "blue" },
  verified: { label: "Verified", tone: "ok" },
  rejected: { label: "Not approved", tone: "red" },
};
/** A business that hasn't finished setting up isn't in the review queue yet. */
const statusOf = (o: { verificationStatus: Status; submittedAt?: string | null; verificationSubmittedAt?: string | null }) =>
  o.verificationStatus === "pending" && !(o.submittedAt ?? o.verificationSubmittedAt) ? { label: "Setting up", tone: "grey" as const } : STATUS[o.verificationStatus];
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
  const list = useQuery({
    queryKey: ["admin", "orgs", status, q],
    queryFn: () => api.get<any[]>(`/api/admin/organisations${qs({ status: status === "all" ? undefined : status, q })}`),
  });
  return (
    <>
      <div className="between ad-filters">
        <Segmented value={status} onChange={setStatus} options={[
          { value: "pending", label: "Waiting" }, { value: "needs_info", label: "Asked for more" }, { value: "verified", label: "Verified" }, { value: "rejected", label: "Not approved" },
          { value: "suspended", label: "Suspended" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" },
        ]} />
        <SearchInput value={q} onChange={setQ} placeholder="Name, registration number or email" />
      </div>
      {list.isLoading ? <Loading /> : !(list.data ?? []).length ? (
        <Card><EmptyState title={status === "pending" ? "Nothing waiting for review" : "No organisations found"}>
          {status === "pending" ? "Businesses appear here once they finish setting up and send themselves for review." : "Try another filter or search."}
        </EmptyState></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Organisation</th><th className="hide-sm">Registered by</th><th className="hide-sm">Country</th><th className="hide-sm">Plan</th><th className="hide-sm">Documents</th><th>{status === "pending" ? "Sent" : "Registered"}</th><th className="hide-sm">Last active</th><th>Status</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate(`/admin/organisations/${o.id}`)}>
                  <td><span className="row" style={{ gap: 10 }}><OrgMark name={o.name} logoFileId={o.logoFileId} /><span style={{ minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{o.name}</b><small className="muted">{o.legalName}{o.registrationNumber ? ` · ${o.registrationNumber}` : ""}</small></span></span></td>
                  <td className="hide-sm"><span style={{ display: "block" }}>{o.creator.name}</span><small className="muted">{o.creator.email}</small></td>
                  <td className="hide-sm">{country(o.country)}</td>
                  <td className="hide-sm" style={{ textTransform: "capitalize" }}>{o.plan}</td>
                  <td className="hide-sm">{o.documents || <span className="muted">None</span>}</td>
                  <td>{timeAgo(status === "pending" ? o.submittedAt : o.createdAt)}</td>
                  <td className="hide-sm">{o.lastActiveAt ? timeAgo(o.lastActiveAt) : <span className="muted">Never</span>}</td>
                  <td>{o.accountStatus !== "active" ? <Pill tone={o.accountStatus === "closed" ? "grey" : "red"}>{ACCOUNT[o.accountStatus as "suspended" | "closed"]}</Pill>
                    : o.secondLook ? <Pill tone="warn">Second look</Pill> : <Pill tone={statusOf(o).tone}>{statusOf(o).label}</Pill>}</td>
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
type Decision = "verified" | "needs_info" | "rejected" | "pending";

/** The decision bar at the top of a business's page: approve, ask for more, or don't approve. */
function DecisionBar({ data }: { data: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const o = data.org;
  const r = data.review;
  const [open, setOpen] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [items, setItems] = useState<ReviewRequestKey[]>([]);
  const [other, setOther] = useState("");
  const decide = useMutation({
    mutationFn: () => api.post(`/api/admin/organisations/${o.id}/verification`,
      open === "needs_info" ? { status: open, items, other: other || undefined, message: note } : open === "pending" ? { status: open } : { status: open, note }),
    onSuccess: () => {
      toast(open === "verified" ? `${o.name} is approved` : open === "needs_info" ? `${o.name} was asked for more` : open === "rejected" ? `${o.name} wasn't approved` : `${o.name} is back in the queue`);
      setOpen(null); setNote(""); setItems([]); setOther("");
      void qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  const status = r.status as Status;
  const checks = Object.keys(REVIEW_CHECKS).filter((k) => r.checks?.[k]).length;
  const total = Object.keys(REVIEW_CHECKS).length;
  const req = r.request;
  const done = req ? req.items.filter((i: any) => i.doneAt).length : 0;
  let title = "Your decision", sub = `${checks} of ${total} checks done. They'll get an email and see your decision when they open WindVeal.`;
  if (!r.submittedAt && status === "pending") { title = "Still setting up"; sub = `They're at the "${o.setupStep}" step. You can review once they send themselves in.`; }
  if (status === "needs_info") { title = "Waiting for them"; sub = `You asked for more ${timeAgo(req?.at)}. They've done ${done} of ${req?.items.length ?? 0}.`; }
  if (status === "verified") { title = "Approved"; sub = r.decidedAt ? `Approved ${fmtDate(r.decidedAt)}${data.reviewer ? ` by ${data.reviewer.name}` : ""}.` : "This business is approved."; }
  if (status === "rejected") { title = "Not approved"; sub = `Decided ${fmtDate(r.decidedAt)}${data.reviewer ? ` by ${data.reviewer.name}` : ""}. Reason: ${r.note}`; }
  const canDecide = status === "pending" ? !!r.submittedAt : status === "needs_info";
  return (
    <Card className="ad-decide">
      <div className="ad-decide-text"><h3>{title}</h3><p>{sub}</p></div>
      <div className="ad-decide-btns">
        {canDecide && <>
          <Button variant="secondary" onClick={() => setOpen("rejected")}>Don't approve</Button>
          {status === "pending" && <Button variant="secondary" onClick={() => setOpen("needs_info")}>Ask for more</Button>}
          <Button icon={<Check size={16} />} onClick={() => setOpen("verified")}>Approve</Button>
        </>}
        {(status === "verified" || status === "rejected") && <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={() => setOpen("pending")}>Reopen review</Button>}
      </div>
      <Modal open={open === "verified"} onClose={() => setOpen(null)} title={`Approve ${o.name}?`}
        subtitle="They can start using WindVeal straight away, and their admins get an email."
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button loading={decide.isPending} onClick={() => decide.mutate()}>Approve</Button></>}>
        {checks < total && <p className="muted" style={{ margin: 0 }}>{total - checks} of the checks aren't ticked yet.</p>}
      </Modal>
      <Modal open={open === "needs_info"} onClose={() => setOpen(null)} title={`Ask ${o.name} for more`}
        subtitle="They'll get an email, and WindVeal will show them exactly what to send."
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
          <Button loading={decide.isPending} disabled={!items.length || !note.trim() || (items.includes("other") && !other.trim())} onClick={() => decide.mutate()}>Send request</Button></>}>
        <span className="field-label" style={{ marginBottom: 6 }}>What do they need to send?</span>
        <div className="ad-ask">
          {REVIEW_REQUEST_KEYS.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={items.includes(k)} onChange={(e) => setItems(e.target.checked ? [...items, k] : items.filter((x) => x !== k))} />
              {REVIEW_REQUESTS[k].ask}
            </label>
          ))}
        </div>
        {items.includes("other") && <Input label="What else?" value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. A recent tax clearance certificate" wrapClassName="ad-ask-other" />}
        <Textarea label="Message to them" rows={4} value={note} onChange={(e) => setNote(e.target.value)} wrapClassName="ad-ask-other"
          placeholder="e.g. The registration number on your certificate doesn't match the one you entered." />
      </Modal>
      <Modal open={open === "rejected"} onClose={() => setOpen(null)} title={`Don't approve ${o.name}`}
        subtitle="They won't be able to use WindVeal. Their admins see your reason and can contact support."
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button variant="danger" loading={decide.isPending} disabled={!note.trim()} onClick={() => decide.mutate()}>Don't approve</Button></>}>
        <Textarea label="Reason" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. We couldn't find a registered business with this name and number." />
      </Modal>
      <Modal open={open === "pending"} onClose={() => setOpen(null)} title="Reopen the review?"
        subtitle={status === "verified" ? "They'll be held at the review screen again until you decide." : "They go back into the review queue."}
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button loading={decide.isPending} onClick={() => decide.mutate()}>Reopen</Button></>} />
    </Card>
  );
}

/** What a reviewer ticks off, with everything needed to check each one. Ticks are private to WindVeal. */
function ChecksCard({ data, onOpen }: { data: any; onOpen: (f: ViewableFile) => void }) {
  const qc = useQueryClient();
  const o = data.org;
  // Ticks show straight away; the server catches up.
  const [checks, setChecks] = useState<Record<string, boolean>>(data.review.checks ?? {});
  useEffect(() => { setChecks(data.review.checks ?? {}); }, [data.review.checks]);
  const tick = useMutation({
    mutationFn: (v: { key: string; done: boolean }) => { setChecks((c) => ({ ...c, [v.key]: v.done })); return api.post(`/api/admin/organisations/${o.id}/checks`, v); },
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "org", o.id] }),
  });
  const docs = (proof: string) => data.documents.filter((f: any) => f.proof === proof);
  const doc = (f: any) => (
    <div key={f.id} className="ad-doc">
      <span className="th"><FileText size={18} /></span>
      <div><b>{f.name}</b><small>Uploaded {fmtDate(f.createdAt)} · {formatBytes(f.size)}</small></div>
      <button className="link" onClick={() => onOpen(f)}>Open</button>
    </div>
  );
  const lookup = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const website = o.website && (o.website.startsWith("http") ? o.website : `https://${o.website}`);
  const rows: [string, ReactNode, ReactNode, string | null][] = [
    ["name", o.legalName, null, lookup(`${o.legalName} ${country(o.country)} company registry`)],
    ["registration_number", o.registrationNumber || <span className="muted">Not given</span>, null, o.registrationNumber ? lookup(`${o.registrationNumber} ${o.legalName}`) : null],
    ["certificate", null, docs("certificate").length ? docs("certificate").map(doc) : <small>Not sent</small>, null],
    ["address", [o.address, o.city].filter(Boolean).join(", ") || <span className="muted">Not given</span>, docs("address").length ? docs("address").map(doc) : <small>No proof of address sent</small>, null],
    ["person", data.creator ? `${data.creator.name} · ${data.creator.email}` : "",
      data.creator && <small>{[data.creator.emailVerified ? "Email verified" : "Email not verified", data.creator.phone && `phone ${data.creator.phone}`, data.creatorJobTitle].filter(Boolean).join(" · ")}</small>, null],
    ["website", o.website || <span className="muted">Not given</span>, null, website || null],
  ];
  const others = data.documents.filter((f: any) => f.proof !== "certificate" && f.proof !== "address");
  return (
    <Card title="Check these" subtitle="Ticks are only for you and other WindVeal reviewers.">
      {rows.map(([key, value, extra, link]) => (
        <div key={key} className={`ad-chk ${checks[key] ? "on" : ""}`}>
          <label className="ad-chk-box"><input type="checkbox" checked={!!checks[key]} onChange={(e) => tick.mutate({ key, done: e.target.checked })} aria-label={REVIEW_CHECKS[key as keyof typeof REVIEW_CHECKS]} /></label>
          <div><b>{REVIEW_CHECKS[key as keyof typeof REVIEW_CHECKS]}</b>{value && <span>{value}</span>}{extra}</div>
          {link ? <a className="link ad-chk-link" href={link} target="_blank" rel="noreferrer">{key === "website" ? "Open" : "Look it up"}<ExternalLink size={13} /></a> : <span />}
        </div>
      ))}
      {!!others.length && (
        <div className="ad-chk"><span /><div><b>Other documents</b>{others.map((f: any) => <div key={f.id}><small className="muted">{VERIFICATION_DOC_KINDS[f.proof as keyof typeof VERIFICATION_DOC_KINDS]}</small>{doc(f)}</div>)}</div><span /></div>
      )}
    </Card>
  );
}

/** What was asked for, and how far they've got. */
function RequestCard({ request }: { request: any }) {
  return (
    <Card title="What you asked for" subtitle={`${fmtDate(request.at)} · ${request.by}`}>
      <p className="ad-quote">{request.message}</p>
      {request.items.map((i: any) => (
        <div key={i.key} className="list-row">
          {i.doneAt ? <Pill tone="ok">Done</Pill> : <Pill tone="grey">Not yet</Pill>}
          <div style={{ minWidth: 0, flex: 1 }}><span className="ink">{i.key === "other" ? i.label : REVIEW_REQUESTS[i.key as ReviewRequestKey].ask}</span>
            {i.note && <small className="muted" style={{ display: "block" }}>{i.note}</small>}</div>
        </div>
      ))}
    </Card>
  );
}

const HISTORY_DOT: Record<string, string> = {
  "account.created": "ok", "account.email_verified": "ok", "org.verification_submitted": "b", "org.verification_resubmitted": "b",
  "org.verification_needs_info": "w", "org.verification_verified": "ok", "org.verification_rejected": "r", "org.verification_pending": "b",
};

function HistoryCard({ history }: { history: any[] }) {
  return (
    <Card title="Review history">
      <div className="ad-tl">
        {history.slice(0, 8).map((h, i) => (
          <div key={i}>
            <i className={HISTORY_DOT[h.action] ?? ""} />
            <span><b>{h.summary}</b><small>{fmtDate(h.createdAt)}, {fmtTime(h.createdAt)}{h.actor ? ` · ${h.actor}` : ""}</small>
              {h.meta?.items && <q>{(h.meta.items as string[]).join(", ")}</q>}
              {h.meta?.what?.length ? <q>{(h.meta.what as string[]).join("; ")}</q> : null}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PlanCard({ org: o }: { org: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [plan, setPlan] = useState<string>(o.plan);
  const [billing, setBilling] = useState<string>(o.billing);
  useEffect(() => { setPlan(o.plan); setBilling(o.billing); }, [o.plan, o.billing]);
  const savePlan = useMutation({
    mutationFn: () => api.post(`/api/admin/organisations/${o.id}/plan`, { plan, billing }),
    onSuccess: () => { toast("Plan updated"); void qc.invalidateQueries({ queryKey: ["admin"] }); },
  });
  return (
    <Card title="Plan">
      <div className="form-grid">
        <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} options={PLANS.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} />
        <Select label="Billing" value={billing} onChange={(e) => setBilling(e.target.value)} options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]} />
      </div>
      {(plan !== o.plan || billing !== o.billing) && <Button variant="secondary" block style={{ marginTop: 12 }} loading={savePlan.isPending} onClick={() => savePlan.mutate()}>Save plan</Button>}
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
  return (
    <>
      <PageHeader title={o.name} back={{ label: "All organisations", onClick: () => navigate("/admin/organisations") }}
        subtitle={[o.legalName, country(o.country), d.review.submittedAt ? `sent for review ${fmtDate(d.review.submittedAt)}, ${fmtTime(d.review.submittedAt)}` : `registered ${fmtDate(o.createdAt)}`,
          d.review.request && d.review.status === "pending" ? "second look" : null].filter(Boolean).join(" · ")} />
      <DecisionBar data={d} />
      <div className="grid-side side-360 ad-review-grid">
        <div>
          <ChecksCard data={d} onOpen={setViewing} />
          {d.review.request && d.review.status !== "verified" && <RequestCard request={d.review.request} />}
        </div>
        <div><HistoryCard history={d.review.history} /></div>
      </div>
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
        </div>
        <div>
          <AccountCard org={o} />
          <PlanCard org={o} />
          {d.creator && (
            <Card title="Registered by">
              <div className="list-row"><Avatar name={d.creator.name} /><div style={{ minWidth: 0, flex: 1 }}><b className="ink" style={{ display: "block" }}>{d.creator.name}</b><small className="muted">{d.creator.email}</small></div>{d.creator.emailVerified ? <Pill tone="ok">Email verified</Pill> : <Pill tone="warn">Email not verified</Pill>}</div>
              <dl className="kv pf-kv" style={{ marginTop: 12 }}>
                <div><dt>Phone</dt><dd>{d.creator.phone || <span className="muted">Not given</span>}</dd></div>
                <div><dt>Account created</dt><dd>{fmtDate(d.creator.createdAt)}</dd></div>
                <div><dt>Last signed in</dt><dd>{d.creator.lastLoginAt ? timeAgo(d.creator.lastLoginAt) : "Never"}</dd></div>
                <div><dt>Business last active</dt><dd>{d.lastActiveAt ? timeAgo(d.lastActiveAt) : "Never"}</dd></div>
                <div><dt>People in WindVeal</dt><dd>{d.memberCount}</dd></div>
              </dl>
              <p className="muted ad-private">WindVeal only sees what the business sent when it registered. Its records, files and activity stay private.</p>
            </Card>
          )}
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
            <Card title="New people" actions={<Button variant="ghost" size="sm" onClick={() => navigate("/admin/people")}>See all</Button>}>
              {o.data.newUsers.map((u: any) => (
                <button key={u.id} className="list-row ad-row" onClick={() => navigate(`/admin/people/${u.id}`)}>
                  <Avatar name={u.name} size={32} />
                  <span style={{ flex: 1, minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{u.name}</b><small className="muted">{u.org?.name ?? "No organisation yet"}{!u.emailVerified && " · email not verified"}</small></span>
                  <small className="muted">{timeAgo(u.createdAt)}</small>
                </button>
              ))}
            </Card>
            {!!o.data.paused.length && (
              <Card title="Suspended or closed" actions={<Button variant="ghost" size="sm" onClick={() => navigate("/admin/organisations?status=suspended")}>See all</Button>}>
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
  const { user: u, membership: m, devices, activeSessions } = q.data;
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
