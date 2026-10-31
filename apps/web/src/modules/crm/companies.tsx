import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Building2, ChevronLeft, Globe, MapPin, Pencil, Phone, Mail, Plus, Upload, X } from "lucide-react";
import { Avatar, Button, Card, EmptyState, Input, Loading, Modal, Notice, PageHeader, Pill, SearchInput, cx, useConfirm, useToast } from "@windveal/ui";
import { formatBytes } from "@windveal/shared";
import { api, ApiError, fileUrl } from "../../lib/api";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { fmtDate, timeAgo } from "../../lib/format";
import { useCompanies, useCompany, useMembers, useRefreshCrm, useSummary, type Company, type Contact, type FollowUp } from "./data";
import {
  ActIcon, ActivityComposer, CoMark, CompanyModal, DealDrawer, DealModal, ErrorNotice, FileIcon, FollowUpModal, LogFollowUpModal,
  Timeline, dueText, useAction, useCrmAccess,
} from "./parts";
import { followUpKind } from "./data";
import { ExtraDetailsCard } from "../../components/ExtraDetails";

const STATUS: Record<Company["status"], { label: string; tone: "blue" | "ok" | "grey" }> = {
  prospect: { label: "Prospect", tone: "blue" }, client: { label: "Client", tone: "ok" }, former: { label: "Former client", tone: "grey" },
};

export function CompaniesPage({ onNew }: { onNew: () => void }) {
  const navigate = useNavigate();
  const { money, user } = useSession();
  const { canEdit } = useCrmAccess();
  const members = useMembers();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const list = useCompanies({ q: q.trim() || undefined, status: status || undefined, owner: owner || undefined });
  const filtered = !!(q || status || owner);
  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search companies" />
        <select className="select chip-select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status: All</option>
          <option value="prospect">Prospects</option>
          <option value="client">Clients</option>
          <option value="former">Former clients</option>
        </select>
        <select className="select chip-select" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Owner: Everyone</option>
          <option value={user.id}>Owner: Me</option>
          {(members.data ?? []).filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>Owner: {m.name}</option>)}
        </select>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorNotice error={list.error} retry={() => list.refetch()} /> : !list.data!.length ? (
        <EmptyState icon={<Building2 size={24} />} title={filtered ? "No companies match" : "No companies yet"}
          action={!filtered && canEdit && <Button icon={<Plus size={15} />} onClick={onNew}>New company</Button>}>
          {filtered ? "Try a different search or filter." : "Add the businesses you sell to, or import them from a spreadsheet."}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th><th className="hide-sm">Status</th><th className="hide-sm">Main contact</th>
                <th className="num">Open deals</th><th className="hide-sm">Owner</th><th className="hide-sm">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/crm/companies/${c.id}`)}>
                  <td>
                    <div className="cell-main">
                      <CoMark name={c.name} size={34} />
                      <div className="crm-min0"><b>{c.name}</b><small>{[c.industry, c.location].filter(Boolean).join(" · ") || "—"}</small></div>
                    </div>
                  </td>
                  <td className="hide-sm"><Pill tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill></td>
                  <td className="hide-sm">{c.primaryContact ?? <span className="muted">—</span>}{c.contactCount > 1 && <span className="muted"> +{c.contactCount - 1}</span>}</td>
                  <td className="num"><b className="ink">{c.openDeals ? money(c.openValue, true) : "—"}</b>{c.openDeals > 0 && <div className="muted crm-small">{c.openDeals} deal{c.openDeals === 1 ? "" : "s"}</div>}</td>
                  <td className="hide-sm">{c.ownerName ?? <span className="muted">Unassigned</span>}</td>
                  <td className="hide-sm muted">{c.lastActivityAt ? timeAgo(c.lastActivityAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ============================================================ company page

export function CompanyPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useCompany(id);
  const summary = useSummary();
  const { money, can } = useSession();
  const { canEdit, canManage } = useCrmAccess();
  const refresh = useRefreshCrm();
  const toast = useToast();
  const [run] = useAction();
  const [edit, setEdit] = useState(false);
  const [newDeal, setNewDeal] = useState(false);
  const [contact, setContact] = useState<Contact | "new" | null>(null);
  const [filter, setFilter] = useState("all");
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState(false);
  const [log, setLog] = useState<FollowUp | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { confirm, dialog } = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const back = { label: "All companies", onClick: () => navigate("/crm/companies") };
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) {
    return (
      <>
        <PageHeader title="" back={back} />
        {q.error instanceof ApiError && q.error.status === 404
          ? <EmptyState title="Company not found">It may have been deleted, or the link is wrong.</EmptyState>
          : <ErrorNotice error={q.error} retry={() => q.refetch()} />}
      </>
    );
  }
  const { company: c, contacts, deals, activities, files, followUps } = q.data;
  const next = followUps[0];

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const kind = can("documents", "edit") ? "document" : "system";
      await api.upload("/api/files", file, { kind, linkType: "company", linkId: c.id, allowDuplicate: "1", category: "Client" });
      refresh();
      toast(`${file.name} uploaded`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Upload failed. Please try again.", "error");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <>
      <button className="back-link crm-back" onClick={back.onClick}><ChevronLeft size={16} />All companies</button>
      <div className="card crm-co-head">
        <CoMark name={c.name} size={60} />
        <div className="crm-co-title">
          <div className="row" style={{ flexWrap: "wrap" }}><h2>{c.name}</h2><Pill tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill></div>
          <div className="crm-co-meta">
            {c.industry && <span><Building2 size={14} />{c.industry}</span>}
            {c.location && <span><MapPin size={14} />{c.location}</span>}
            {c.website && <a href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer noopener"><Globe size={14} />{c.website.replace(/^https?:\/\//, "")}</a>}
            <span>Owner: {c.ownerName ?? "Unassigned"}</span>
          </div>
        </div>
        {canEdit && (
          <div className="crm-co-actions">
            <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => setEdit(true)}>Edit</Button>
            <Button icon={<Plus size={16} />} onClick={() => setNewDeal(true)}>New deal</Button>
          </div>
        )}
      </div>

      <div className="grid-side crm-co-grid">
        <Card title="Activity" actions={
          <select className="select chip-select" aria-label="Filter activity" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All activity</option><option value="note">Notes</option><option value="call">Calls</option>
            <option value="meeting">Meetings</option><option value="email">Emails</option>
          </select>
        }>
          {canEdit && <ActivityComposer target={{ companyId: c.id, name: c.name }} contacts={contacts} />}
          <Timeline items={activities} filter={filter} />
        </Card>

        <div className="crm-side">
          <Card title="Contacts" actions={canEdit && <button className="crm-link" onClick={() => setContact("new")}><Plus size={14} /> Add</button>}>
            {contacts.length === 0 ? <p className="muted crm-small">No contacts yet. Add the people you talk to here.</p> : contacts.map((ct) => (
              <div key={ct.id} className="list-row">
                <Avatar name={ct.name} size={34} />
                <button className="grow crm-min0 crm-plain" onClick={() => canEdit && setContact(ct)} disabled={!canEdit}>
                  <b className="ink">{ct.name} {ct.isPrimary && <Pill tone="blue" className="crm-pill-sm">Main</Pill>}</b>
                  <small className="muted crm-ellipsis">{ct.role ?? ct.email ?? "—"}</small>
                </button>
                {ct.phone ? <a className="crm-icon-ghost" href={`tel:${ct.phone}`} aria-label={`Call ${ct.name}`}><Phone size={16} /></a>
                  : ct.email ? <a className="crm-icon-ghost" href={`mailto:${ct.email}`} aria-label={`Email ${ct.name}`}><Mail size={16} /></a> : null}
              </div>
            ))}
          </Card>

          <Card title="Deals" actions={canEdit && <button className="crm-link" onClick={() => setNewDeal(true)}><Plus size={14} /> Add</button>}>
            {deals.length === 0 ? <p className="muted crm-small">No deals yet.</p> : deals.map((d) => (
              <button key={d.id} className={cx("crm-deal-tile", d.status === "lost" && "lost")} onClick={() => setOpenDeal(d.id)}>
                <div className="between"><b>{d.name}</b><b>{money(d.value, true)}</b></div>
                <small>
                  {d.status === "open" ? `${d.stage}${d.expectedCloseOn ? ` · expected close ${fmtDate(d.expectedCloseOn, { day: "numeric", month: "short" })}` : ""}`
                    : d.status === "won" ? `Won · ${fmtDate(d.wonAt, { day: "numeric", month: "short" })}` : `Lost${d.lostReason ? ` · ${d.lostReason.toLowerCase()}` : ""}`}
                </small>
              </button>
            ))}
          </Card>

          <Card title="Follow-up" actions={canEdit && <button className="crm-link" onClick={() => setFollowUp(true)}><Plus size={14} /> Add</button>}>
            {!next ? <p className="muted crm-small">Nothing planned. Add a follow-up so this doesn't go quiet.</p> : (
              <>
                {followUps.slice(0, 3).map((t) => {
                  const due = dueText(t.dueAt, true);
                  return (
                    <div key={t.id} className="list-row">
                      <ActIcon type={followUpKind(t.title)} size={34} />
                      <div className="grow crm-min0">
                        <b className="ink">{t.title}</b>
                        <small className={cx("crm-small", due.overdue ? "crm-red strong" : "muted")}>
                          {due.overdue ? `Overdue by ${due.text.replace(" overdue", "")}` : due.text}{t.assigneeName ? ` · ${t.assigneeName}` : ""}
                        </small>
                      </div>
                      {canEdit && <Button variant="secondary" size="sm" onClick={() => (["call", "meeting"].includes(followUpKind(t.title)) ? setLog(t) : run(async () => { await api.post(`/api/crm/follow-ups/${t.id}/done`); refresh(); }, "Follow-up done"))}>Done</Button>}
                    </div>
                  );
                })}
                {followUps.length > 3 && <p className="muted crm-small">+{followUps.length - 3} more</p>}
              </>
            )}
          </Card>

          <ExtraDetailsCard reference={c.reference} referenceLabel="Company ID" extra={c.extraDetails} />

          <Card title="Files" actions={canEdit && (
            <button className="crm-link" disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={14} /> {uploading ? "Uploading…" : "Upload"}</button>
          )}>
            <input ref={fileInput} type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            {files.length === 0 ? <p className="muted crm-small">Proposals, contracts and price lists for {c.name} live here.</p> : files.map((f) => (
              <div key={f.id} className="list-row">
                <FileIcon name={f.name} />
                <a className="grow crm-min0 crm-plain" href={fileUrl(f.id)} target="_blank" rel="noreferrer">
                  <b className="ink crm-ellipsis">{f.name}</b>
                  <small className="muted">{formatBytes(f.size)} · added {fmtDate(f.linkedAt, { day: "numeric", month: "short" })}</small>
                </a>
                {canEdit && (
                  <button className="crm-icon-ghost" aria-label={`Remove ${f.name}`} title="Remove from this company"
                    onClick={async () => {
                      if (!(await confirm({ title: `Remove ${f.name}?`, message: `It is unlinked from ${c.name}. The file stays in Documents.`, confirmLabel: "Remove" }))) return;
                      run(async () => { await api.del(`/api/crm/companies/${c.id}/files/${f.id}`); refresh(); }, "File removed");
                    }}><X size={15} /></button>
                )}
              </div>
            ))}
          </Card>

          {canManage && <div><Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>Delete company</Button></div>}
        </div>
      </div>

      <CompanyModal open={edit} onClose={() => setEdit(false)} company={c} />
      <DealModal open={newDeal} onClose={() => setNewDeal(false)} companyId={c.id} />
      <ContactModal companyId={c.id} contact={contact} onClose={() => setContact(null)} />
      <DealDrawer id={openDeal} onClose={() => setOpenDeal(null)} stages={summary.data?.dealStages ?? []} />
      <FollowUpModal open={followUp} onClose={() => setFollowUp(false)} target={{ companyId: c.id, name: c.name }} />
      <LogFollowUpModal t={log} onClose={() => setLog(null)} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${c.name}?`}
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => run(async () => { await api.del(`/api/crm/companies/${c.id}`); refresh(); navigate("/crm/companies"); }, `${c.name} deleted`)}>Delete company</Button>
        </>}>
        <p>Its contacts and deals are removed from the CRM too. Files stay in Documents.</p>
      </Modal>
      {dialog}
    </>
  );
}

function ContactModal({ companyId, contact, onClose }: { companyId: string; contact: Contact | "new" | null; onClose: () => void }) {
  const refresh = useRefreshCrm();
  const toast = useToast();
  const existing = contact && contact !== "new" ? contact : null;
  const f = useForm({ name: "", role: "", email: "", phone: "", isPrimary: false });
  const { confirm, dialog } = useConfirm();
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = contact === "new" ? "new" : existing?.id ?? null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    f.setValues({ name: existing?.name ?? "", role: existing?.role ?? "", email: existing?.email ?? "", phone: existing?.phone ?? "", isPrimary: existing?.isPrimary ?? false });
    f.setErrors({}); f.setFormError(null);
  }
  const save = () => f.submit(async (v) => {
    if (existing) await api.patch(`/api/crm/contacts/${existing.id}`, v);
    else await api.post(`/api/crm/companies/${companyId}/contacts`, v);
    refresh();
    toast(existing ? "Contact updated" : `${v.name} added`);
    onClose();
  });
  const remove = async () => {
    if (!(await confirm({ title: `Remove ${existing!.name}?`, message: "They will be removed from this company's contacts.", confirmLabel: "Remove" }))) return;
    await removeNow();
  };
  const removeNow = () => f.submit(async () => {
    await api.del(`/api/crm/contacts/${existing!.id}`);
    refresh();
    toast("Contact removed");
    onClose();
  });
  return (
    <Modal open={!!contact} onClose={onClose} title={existing ? `Edit ${existing.name}` : "Add contact"}
      footer={<>
        {existing && <Button variant="ghost" onClick={remove} style={{ marginRight: "auto" }}>Remove</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={f.busy} onClick={save}>{existing ? "Save" : "Add contact"}</Button>
      </>}>
      <div className="form-grid">
        <Input label="Name" autoFocus {...f.bind("name")} />
        <Input label="Role" optional placeholder="e.g. Purchasing Manager" {...f.bind("role")} />
        <Input label="Email" optional type="email" {...f.bind("email")} />
        <Input label="Phone" optional type="tel" {...f.bind("phone")} />
        <label className="check span-2">
          <input type="checkbox" checked={f.values.isPrimary} onChange={(e) => f.set("isPrimary", e.target.checked)} disabled={existing?.isPrimary} />
          <span>Main contact for this company</span>
        </label>
      </div>
      {dialog}
    </Modal>
  );
}
