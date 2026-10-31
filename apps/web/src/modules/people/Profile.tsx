import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Eye, Lock, Mail, MapPin, MoreHorizontal, Pencil, Phone, Trash2, Upload } from "lucide-react";
import { formatBytes } from "@windveal/shared";
import {
  Avatar, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, Modal, Notice, Pill, Progress, Select, Tabs, useToast,
} from "@windveal/ui";
import { ApiError, api, fileUrl } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { EmployeeDrawer } from "./EmployeeForm";
import { LeaveRequestRow, RequestLeaveModal, balanceText } from "./Leave";
import { STATUS, fileKind, localYmd, peopleKeys, statusLabel, tenure, type LeaveRequest, type Profile } from "./lib";

const TABS = [
  { key: "overview", label: "Overview" }, { key: "job", label: "Job and pay" }, { key: "leave", label: "Leave" },
  { key: "documents", label: "Documents" }, { key: "history", label: "History" },
];

export function ProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [left, setLeft] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const key = ["people", "employee", id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Profile>(`/api/people/employees/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: peopleKeys.all });

  const markLeft = useMutation({
    mutationFn: () => api.post<{ accessRemoved: boolean }>(`/api/people/employees/${id}/left`, {}),
    onSuccess: (r) => { setLeft(false); toast(r.accessRemoved ? "Marked as left. Their WindVeal access was removed." : "Marked as left."); refresh(); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const startOnboarding = useMutation({
    mutationFn: () => api.post(`/api/people/employees/${id}/checklists`, { kind: "onboarding" }),
    onSuccess: () => { toast("Onboarding checklist started"); refresh(); },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const back = <button className="back-link ppl-back" onClick={() => navigate("/people")}><ChevronLeft size={16} />Back to directory</button>;
  if (q.isLoading) return <>{back}<Loading /></>;
  if (q.isError || !q.data) {
    const nf = q.error instanceof ApiError && q.error.status === 404;
    return <>{back}<Card><EmptyState title={nf ? "This person wasn't found" : "Couldn't load this profile"}>{nf ? "They may have been removed." : (q.error as Error)?.message}</EmptyState></Card></>;
  }
  const e = q.data;
  const canEdit = can("people", "edit");
  const canManage = can("people", "manage");
  const isGone = e.status === "left";

  return (
    <>
      {back}
      <section className="card ppl-hero">
        <div className="ppl-cover" />
        <div className="ppl-hero-body">
          <span className="ppl-hero-av"><Avatar name={e.name} size={92} /></span>
          <div className="ppl-hero-main">
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <h2>{e.name}</h2>
              <Pill tone={STATUS[e.status].tone}>{statusLabel(e)}</Pill>
            </div>
            <div className="ppl-meta">
              {e.jobTitle && <span>{e.jobTitle}</span>}
              {e.location && <span><MapPin size={14} />{e.location}</span>}
              {e.email && <span><Mail size={14} /><a href={`mailto:${e.email}`}>{e.email}</a></span>}
              {e.phone && <span><Phone size={14} /><a href={`tel:${e.phone}`}>{e.phone}</a></span>}
            </div>
          </div>
          <div className="ppl-hero-actions">
            {e.email && <a className="icon-btn bordered" href={`mailto:${e.email}`} aria-label="Send email" title="Send email"><Mail size={17} /></a>}
            {canEdit && !isGone && (
              <Menu trigger={(toggle) => <IconButton label="More actions" bordered onClick={toggle}><MoreHorizontal size={18} /></IconButton>}>
                {(close) => <>
                  {!e.checklists.some((c) => c.kind === "onboarding") && (
                    <button onClick={() => { close(); startOnboarding.mutate(); }}>Start onboarding checklist</button>
                  )}
                  {e.status !== "leaving" && <button onClick={() => { close(); setLeaving(true); }}>Mark as leaving</button>}
                  {canManage && <><hr /><button className="danger" onClick={() => { close(); setLeft(true); }}>Mark as left</button></>}
                </>}
              </Menu>
            )}
            {canEdit && <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit</Button>}
          </div>
        </div>
      </section>

      {isGone && <Notice tone="info">{e.firstName} left{e.endDate ? ` on ${fmtDate(e.endDate)}` : ""}. Their record is kept for your history.</Notice>}

      <Tabs items={TABS} value={tab} onChange={setTab} />

      {tab === "overview" && (
        <div className="grid-side ppl-profile-grid">
          <div>
            <EmploymentCard e={e} />
            <PayCard e={e} />
            <PersonalCard e={e} />
          </div>
          <div>
            <ReportingCard e={e} />
            <BalanceCard e={e} onRequest={(e.isSelf || canEdit) && !isGone ? () => setRequesting(true) : undefined} />
            <DocumentsCard e={e} limit={3} onAll={() => setTab("documents")} />
            <HistoryCard e={e} limit={3} onAll={() => setTab("history")} />
          </div>
        </div>
      )}
      {tab === "job" && (
        <div className="grid-side ppl-profile-grid">
          <div><EmploymentCard e={e} /><PayCard e={e} /></div>
          <div><ReportingCard e={e} /><ChecklistsCard e={e} /></div>
        </div>
      )}
      {tab === "leave" && <LeaveTab e={e} onRequest={(e.isSelf || canEdit) && !isGone ? () => setRequesting(true) : undefined} />}
      {tab === "documents" && <DocumentsCard e={e} />}
      {tab === "history" && <div className="ppl-narrow"><HistoryCard e={e} /><ChecklistsCard e={e} /></div>}

      {canEdit && <EmployeeDrawer open={editing} employee={e} onClose={() => setEditing(false)} onSaved={() => qc.invalidateQueries({ queryKey: key })} />}
      <LeavingModal open={leaving} e={e} onClose={() => setLeaving(false)} onDone={() => { setLeaving(false); refresh(); }} />
      <ConfirmDialog open={left} onClose={() => setLeft(false)} onConfirm={() => markLeft.mutate()} loading={markLeft.isPending} danger
        title={`Mark ${e.firstName} as left?`} confirmLabel="Mark as left">
        <p>{e.firstName}'s status changes to Left{e.endDate ? ` (last day ${fmtDate(e.endDate)})` : " from today"}.</p>
        {e.hasAccount && <p style={{ marginTop: 10 }}><b className="ink">Their WindVeal access will be removed</b> and they'll be signed out on every device.</p>}
      </ConfirmDialog>
      <RequestLeaveModal open={requesting} onClose={() => setRequesting(false)} employeeId={e.id} employeeName={e.isSelf ? undefined : e.name} />
    </>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ppl-kv"><small>{label}</small><span>{children || "—"}</span></div>;
}

function EmploymentCard({ e }: { e: Profile }) {
  const t = tenure(e.startDate);
  return (
    <Card title="Employment">
      <div className="ppl-kv-grid">
        <Kv label="Department">{e.departmentName}</Kv>
        <Kv label="Job title">{e.jobTitle}</Kv>
        <Kv label="Employment type">{e.employmentType}</Kv>
        <Kv label="Start date">{e.startDate ? `${fmtDate(e.startDate, { day: "numeric", month: "long", year: "numeric" })}${t ? ` (${t})` : ""}` : null}</Kv>
        <Kv label="Work location">{e.location}</Kv>
        <Kv label="Employee ID">{e.employeeCode}</Kv>
        {e.endDate && <Kv label="Last day">{fmtDate(e.endDate, { day: "numeric", month: "long", year: "numeric" })}</Kv>}
      </div>
    </Card>
  );
}

function PersonalCard({ e }: { e: Profile }) {
  return (
    <Card title="Personal">
      {e.personal ? (
        <div className="ppl-kv-grid">
          <Kv label="Date of birth">{e.personal.dateOfBirth ? fmtDate(e.personal.dateOfBirth, { day: "numeric", month: "long", year: "numeric" }) : null}</Kv>
          <Kv label="Emergency contact">{e.personal.emergencyContact}</Kv>
          <Kv label="Home address">{e.personal.homeAddress}</Kv>
          <Kv label="National ID">{e.personal.nationalId}</Kv>
        </div>
      ) : <p className="muted">Personal details are only visible to HR and to {e.firstName}.</p>}
    </Card>
  );
}

type Pay = { salaryAmount: string | null; currency: string; payFrequency: string | null; bankName: string | null; accountNumber: string | null; updatedAt: string | null };

function PayCard({ e }: { e: Profile }) {
  const { can } = useSession();
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const pay = useQuery({ queryKey: ["people", "pay", e.id], queryFn: () => api.get<Pay>(`/api/people/employees/${e.id}/pay`), enabled: shown && e.canSeePay, staleTime: 0, gcTime: 0 });
  const money = (v: string | null, cur: string) => {
    if (v == null) return null;
    try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(Number(v)); } catch { return `${cur} ${v}`; }
  };
  return (
    <Card title="Pay and bank details" subtitle="Sensitive information"
      actions={shown && pay.data ? <div className="row">
        {can("people", "edit") && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
        <Button size="sm" variant="ghost" onClick={() => setShown(false)}>Hide</Button>
      </div> : undefined}>
      {!e.canSeePay ? (
        <div className="ppl-locked">
          <span className="ic"><Lock size={18} /></span>
          <div><b>You can't see pay details</b><p>Only people allowed to see pay can view this. Ask an admin if you need access.</p></div>
        </div>
      ) : !shown ? (
        <div className="ppl-locked">
          <span className="ic"><Lock size={18} /></span>
          <div><b>Hidden for your privacy</b><p>Only people allowed to see pay details can view this. Viewing is recorded in the audit history.</p></div>
          <Button variant="secondary" size="sm" icon={<Eye size={15} />} onClick={() => setShown(true)}>Show</Button>
        </div>
      ) : pay.isLoading ? <Loading /> : pay.isError ? <Notice tone="error">{(pay.error as Error).message}</Notice> : pay.data && (
        <>
          <div className="ppl-kv-grid">
            <Kv label="Salary">{money(pay.data.salaryAmount, pay.data.currency)}</Kv>
            <Kv label="Pay frequency">{pay.data.payFrequency}</Kv>
            <Kv label="Bank">{pay.data.bankName}</Kv>
            <Kv label="Account number">{pay.data.accountNumber}</Kv>
          </div>
          {!pay.data.updatedAt && <p className="muted" style={{ marginTop: 12 }}>No pay details yet.</p>}
          <PayModal open={editing} onClose={() => setEditing(false)} e={e} pay={pay.data} onSaved={() => pay.refetch()} />
        </>
      )}
    </Card>
  );
}

function PayModal({ open, onClose, e, pay, onSaved }: { open: boolean; onClose: () => void; e: Profile; pay: Pay; onSaved: () => void }) {
  const toast = useToast();
  const f = useForm({
    salaryAmount: pay.salaryAmount ?? "", currency: pay.currency, payFrequency: pay.payFrequency ?? "Monthly",
    bankName: pay.bankName ?? "", accountNumber: pay.accountNumber ?? "",
  });
  const save = () => f.submit(async (v) => {
    await api.put(`/api/people/employees/${e.id}/pay`, v);
    toast("Pay details saved");
    onSaved();
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title={`${e.firstName}'s pay details`} subtitle="Changes are recorded in the audit history."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Input label="Salary" inputMode="decimal" {...f.bind("salaryAmount")} />
        <Input label="Currency" maxLength={3} {...f.bind("currency")} />
        <Select label="Pay frequency" {...f.bind("payFrequency")} options={["Monthly", "Fortnightly", "Weekly", "Daily", "Hourly"]} />
        <Input label="Bank" optional {...f.bind("bankName")} />
        <Input label="Account number" optional wrapClassName="span-2" {...f.bind("accountNumber")} />
      </div>
    </Modal>
  );
}

function ReportingCard({ e }: { e: Profile }) {
  return (
    <Card title="Reporting">
      <div className="ppl-sub">Reports to</div>
      {e.manager ? (
        <Link to={`/people/${e.manager.id}`} className="ppl-mini-person">
          <Avatar name={e.manager.name} size={34} /><div><b>{e.manager.name}</b><small>{e.manager.jobTitle ?? "—"}</small></div>
        </Link>
      ) : <p className="muted">No manager set.</p>}
      <div className="ppl-sub" style={{ marginTop: 14 }}>{e.reports.length ? `Manages ${e.reports.length} ${e.reports.length === 1 ? "person" : "people"}` : "Doesn't manage anyone"}</div>
      {e.reports.length > 0 && (
        <div className="ppl-stack-avatars">
          {e.reports.slice(0, 8).map((r) => <Link key={r.id} to={`/people/${r.id}`} title={r.name}><Avatar name={r.name} size={28} /></Link>)}
          {e.reports.length > 8 && <span className="more">+{e.reports.length - 8}</span>}
        </div>
      )}
    </Card>
  );
}

function BalanceCard({ e, onRequest }: { e: Profile; onRequest?: () => void }) {
  const items = e.balances.filter((b) => b.daysPerYear != null);
  return (
    <Card title="Leave balance" actions={onRequest && <button className="btn btn-ghost btn-sm" onClick={onRequest}>Request leave</button>}>
      {items.length === 0 ? <p className="muted">No leave types with an allowance yet.</p> : (
        <div className="stack" style={{ gap: 12 }}>
          {items.map((b, i) => (
            <div key={b.leaveTypeId}>
              <div className="between ppl-bal"><span>{b.name}</span><b>{balanceText(b)}</b></div>
              <div className={`ppl-bar ${i % 2 ? "alt" : ""}`}><Progress value={b.daysPerYear ? ((b.remaining ?? 0) / b.daysPerYear) * 100 : 0} /></div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DocumentsCard({ e, limit, onAll }: { e: Profile; limit?: number; onAll?: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Profile["documents"][number] | null>(null);
  const canEdit = can("people", "edit");
  const refresh = () => qc.invalidateQueries({ queryKey: ["people", "employee", e.id] });
  const upload = async (file: File) => {
    setBusy(true);
    try {
      await api.upload("/api/files", file, { kind: "system", linkType: "employee", linkId: e.id, folderId: undefined });
      toast(`${file.name} uploaded`);
      refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = useMutation({
    mutationFn: (linkId: string) => api.del(`/api/people/employees/${e.id}/documents/${linkId}`),
    onSuccess: () => { setRemoving(null); toast("Document removed from this profile"); refresh(); },
    onError: (err: Error) => toast(err.message, "error"),
  });
  const docs = limit ? e.documents.slice(0, limit) : e.documents;
  return (
    <Card title="Documents"
      actions={canEdit && <>
        <input ref={input} type="file" hidden onChange={(ev) => ev.target.files?.[0] && upload(ev.target.files[0])} />
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{busy ? "Uploading…" : "Upload"}</button>
      </>}>
      {e.documentsHidden ? <p className="muted">Documents are only visible to HR and to {e.firstName}.</p> : e.documents.length === 0 ? <p className="muted">No documents yet{canEdit ? ". Upload contracts, IDs and letters here." : "."}</p> : (
        <div>
          {docs.map((d) => (
            <div key={d.linkId} className="list-row ppl-doc">
              <span className={`ppl-doc-ic ${/pdf/i.test(d.name) ? "pdf" : ""}`}>{fileKind(d.name)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <a href={fileUrl(d.id)} target="_blank" rel="noreferrer" className="ppl-doc-name">{d.name}</a>
                <small className="muted">{formatBytes(d.size)} · {fmtDate(d.createdAt, { month: "short", year: "numeric" })}</small>
              </div>
              {canEdit && !limit && <IconButton label={`Remove ${d.name}`} onClick={() => setRemoving(d)}><Trash2 size={16} /></IconButton>}
            </div>
          ))}
          {limit && e.documents.length > limit && <button className="btn btn-ghost btn-sm" onClick={onAll}>See all {e.documents.length}</button>}
        </div>
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.linkId)} loading={remove.isPending}
        danger title="Remove this document?" confirmLabel="Remove">
        <p>{removing?.name} will no longer appear on {e.firstName}'s profile.</p>
      </ConfirmDialog>
    </Card>
  );
}

function HistoryCard({ e, limit, onAll }: { e: Profile; limit?: number; onAll?: () => void }) {
  const items = limit ? e.history.slice(0, limit) : e.history;
  return (
    <Card title="History">
      {items.length === 0 ? <p className="muted">No changes recorded yet.</p> : (
        <ul className="ppl-timeline">
          {items.map((h) => (
            <li key={h.id}>
              <b>{h.event}</b>
              <small>{fmtDate(h.occurredOn, { month: "long", year: "numeric" })}{h.details ? ` · ${h.details}` : ""}{h.actorName ? ` · by ${h.actorName}` : ""}</small>
            </li>
          ))}
        </ul>
      )}
      {limit && e.history.length > limit && <button className="btn btn-ghost btn-sm" onClick={onAll}>See full history</button>}
    </Card>
  );
}

function ChecklistsCard({ e }: { e: Profile }) {
  if (!e.checklists.length) return null;
  return (
    <Card title="Checklists">
      <div className="stack" style={{ gap: 12 }}>
        {e.checklists.map((c) => (
          <Link key={c.id} to={`/people/onboarding?id=${c.id}`} className="ppl-cl-link">
            <div className="between"><b>{c.kind === "onboarding" ? "Onboarding" : "Offboarding"}</b><small className="muted">{c.done} of {c.total} done</small></div>
            <div className={`ppl-bar ${c.kind === "offboarding" ? "warn" : ""}`}><Progress value={c.total ? (c.done / c.total) * 100 : 0} /></div>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function LeaveTab({ e, onRequest }: { e: Profile; onRequest?: () => void }) {
  const list = useQuery({
    queryKey: ["people", "leave", "employee", e.id],
    queryFn: () => api.get<LeaveRequest[]>(e.isSelf ? "/api/people/leave/requests?scope=mine" : `/api/people/leave/requests?scope=all&employeeId=${e.id}`),
  });
  return (
    <div className="grid-side ppl-profile-grid">
      <Card title="Leave requests" actions={onRequest && <Button size="sm" onClick={onRequest}>Request leave</Button>}>
        {list.isLoading ? <Loading /> : list.isError ? <Notice tone="error">{(list.error as Error).message}</Notice>
          : !list.data?.length ? <EmptyState title="No leave requests yet" />
          : list.data.filter((r) => r.employee?.id === e.id).map((r) => <LeaveRequestRow key={r.id} r={r} showStatus />)}
      </Card>
      <BalanceCard e={e} />
    </div>
  );
}

function LeavingModal({ open, e, onClose, onDone }: { open: boolean; e: Profile; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const f = useForm({ endDate: e.endDate ?? localYmd(new Date(Date.now() + 14 * 86_400_000)), reason: "" });
  const save = () => f.submit(async (v) => {
    const r = await api.post<{ checklistId: string | null }>(`/api/people/employees/${e.id}/leaving`, v);
    toast(r.checklistId ? `${e.firstName} is leaving. The offboarding checklist has started.` : `${e.firstName} is marked as leaving.`);
    onDone();
  });
  return (
    <Modal open={open} onClose={onClose} title={`Mark ${e.firstName} as leaving`} subtitle="This starts the offboarding checklist, including removing app access on the last day."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Mark as leaving</Button></>}>
      <div className="stack">
        <Input label="Last working day" type="date" {...f.bind("endDate")} />
        <Input label="Reason" optional placeholder="e.g. Resigned, end of contract" {...f.bind("reason")} />
      </div>
    </Modal>
  );
}
