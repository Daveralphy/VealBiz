import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar, Clock, FileText, Mail, Phone, Plus, StickyNote, Trash2, X } from "lucide-react";
import {
  Avatar, Button, Checkbox, Drawer, Field, Input, Loading, Modal, Notice, Pill, Select, Textarea, cx, useToast,
} from "@windveal/ui";
import { initials } from "@windveal/shared";
import { api, ApiError } from "../../lib/api";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { dayLabel, fmtDate, fmtTime, isOverdue, timeAgo, toDateInput } from "../../lib/format";
import {
  followUpKind, useCompanies, useDeal, useDeals, useLead, useLeads, useMembers, useRefreshCrm, useSummary,
  type Activity, type ActivityType, type Contact, type Deal, type FollowUp, type Lead, type Company,
} from "./data";
import { ExtraDetailsList } from "../../components/ExtraDetails";

// ------------------------------------------------------------ small bits

export const ACT_LABEL: Record<ActivityType, string> = { note: "Note", call: "Call", meeting: "Meeting", email: "Email" };
const ACT_ICON: Record<ActivityType, (s: number) => ReactNode> = {
  note: (s) => <StickyNote size={s} />, call: (s) => <Phone size={s} />, meeting: (s) => <Calendar size={s} />, email: (s) => <Mail size={s} />,
};

export function ActIcon({ type, size = 36 }: { type: ActivityType; size?: number }) {
  return <span className={`crm-act-ic crm-act-${type}`} style={{ width: size, height: size }}>{ACT_ICON[type](Math.round(size * 0.45))}</span>;
}

const MARK_TONES = ["violet", "red", "blue", "ok", "warn", "grey"];
export function CoMark({ name, size = 30 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`crm-mark crm-tone-${MARK_TONES[h % MARK_TONES.length]}`} style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }} aria-hidden>
      {initials(name || "?")}
    </span>
  );
}

export function Owner({ name }: { name: string | null }) {
  if (!name) return <span className="crm-owner-none" title="Unassigned">—</span>;
  return <Avatar name={name} size={22} />;
}

export function useCrmAccess() {
  const { can } = useSession();
  return { canEdit: can("crm", "edit"), canManage: can("crm", "manage") };
}

/** Wraps an async action with a toast on error. Returns [run, busy]. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Something went wrong. Please try again.", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return [run, busy] as const;
}

export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Notice tone="error" action={retry && <button className="crm-link" onClick={retry}>Try again</button>}>
      {error instanceof ApiError ? error.message : "We couldn't load this. Check your connection and try again."}
    </Notice>
  );
}

export function dueText(d: string | null, withTime = false): { text: string; overdue: boolean } {
  if (!d) return { text: "No date", overdue: false };
  if (isOverdue(d)) {
    const days = Math.max(1, Math.round((new Date().setHours(0, 0, 0, 0) - new Date(new Date(d).setHours(0, 0, 0, 0)).getTime()) / 86_400_000));
    return { text: `${days} day${days === 1 ? "" : "s"} overdue`, overdue: true };
  }
  const label = dayLabel(d);
  const date = new Date(d);
  const hasTime = withTime && !(date.getHours() === 0 && date.getMinutes() === 0);
  return { text: hasTime ? (label === "Today" ? fmtTime(d) : `${label} ${fmtTime(d)}`) : label, overdue: false };
}

/** "datetime-local" input value ↔ ISO. */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const defaultDue = () => { const d = new Date(Date.now() + 86_400_000); d.setHours(9, 0, 0, 0); return toLocalInput(d); };

export function MoveTo({ stages, value, onMove, disabled, label = "Move to" }: { stages: string[]; value: string; onMove: (s: string) => void; disabled?: boolean; label?: string }) {
  return (
    <select className="select crm-move" aria-label={label} value="" disabled={disabled}
      onClick={(e) => e.stopPropagation()} onChange={(e) => e.target.value && onMove(e.target.value)}>
      <option value="">{label.startsWith("Stage:") ? label : `${label}…`}</option>
      {stages.filter((s) => s !== value).map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

function MemberSelect({ value, onChange, label = "Owner", error, allowNone = true }: { value: string; onChange: (v: string) => void; label?: string; error?: string; allowNone?: boolean }) {
  const members = useMembers();
  return (
    <Select label={label} value={value} error={error} onChange={(e) => onChange(e.target.value)}
      placeholder={allowNone ? "Unassigned" : undefined}
      options={(members.data ?? []).map((m) => ({ value: m.id, label: m.name }))} />
  );
}

// ------------------------------------------------------------ company modal

export function CompanyModal({ open, onClose, company, onSaved }: { open: boolean; onClose: () => void; company?: Company | null; onSaved?: (id: string) => void }) {
  const { user } = useSession();
  const refresh = useRefreshCrm();
  const toast = useToast();
  const f = useForm({ name: "", industry: "", location: "", website: "", status: "prospect", ownerUserId: user.id, notes: "" });
  useEffect(() => {
    if (!open) return;
    f.setValues({
      name: company?.name ?? "", industry: company?.industry ?? "", location: company?.location ?? "", website: company?.website ?? "",
      status: company?.status ?? "prospect", ownerUserId: company ? company.ownerUserId ?? "" : user.id, notes: company?.notes ?? "",
    });
    f.setErrors({}); f.setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company?.id]);
  const save = () => f.submit(async (v) => {
    const body = { ...v, ownerUserId: v.ownerUserId || null };
    const r = company ? await api.patch(`/api/crm/companies/${company.id}`, body) : await api.post("/api/crm/companies", body);
    refresh();
    toast(company ? "Company updated" : `${v.name} added`);
    onClose();
    onSaved?.(r.id);
  });
  return (
    <Modal open={open} onClose={onClose} title={company ? `Edit ${company.name}` : "New company"} subtitle={company ? undefined : "Add a business you sell to or want to sell to."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>{company ? "Save changes" : "Add company"}</Button></>}>
      <div className="form-grid">
        <Input label="Company name" wrapClassName="span-2" autoFocus {...f.bind("name")} />
        <Input label="Industry" optional placeholder="e.g. Hospitality" {...f.bind("industry")} />
        <Input label="Location" optional placeholder="e.g. Victoria Island, Lagos" {...f.bind("location")} />
        <Input label="Website" optional placeholder="example.com" {...f.bind("website")} />
        <Select label="Status" value={f.values.status} onChange={(e) => f.set("status", e.target.value)}
          options={[{ value: "prospect", label: "Prospect" }, { value: "client", label: "Client" }, { value: "former", label: "Former client" }]} />
        <MemberSelect value={f.values.ownerUserId} onChange={(v) => f.set("ownerUserId", v)} error={f.errors.ownerUserId} />
        <Textarea label="Notes" optional wrapClassName="span-2" rows={3} {...f.bind("notes")} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ deal modal

export function DealModal({ open, onClose, companyId, onSaved }: { open: boolean; onClose: () => void; companyId?: string; onSaved?: (d: Deal) => void }) {
  const { user, org } = useSession();
  const summary = useSummary();
  const stages = summary.data?.dealStages ?? [];
  const companies = useCompanies({});
  const refresh = useRefreshCrm();
  const toast = useToast();
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const f = useForm({ companyId: companyId ?? "", newCompanyName: "", name: "", value: "", stage: "", expectedCloseOn: "", ownerUserId: user.id, nextStep: "", contactId: "" });
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    if (!open) return;
    f.setValues({ companyId: companyId ?? "", newCompanyName: "", name: "", value: "", stage: "", expectedCloseOn: "", ownerUserId: user.id, nextStep: "", contactId: "" });
    f.setErrors({}); f.setFormError(null);
    setMode("existing");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, companyId]);
  useEffect(() => {
    setContacts([]);
    if (!f.values.companyId || mode !== "existing") return;
    api.get(`/api/crm/companies/${f.values.companyId}`).then((r) => setContacts(r.contacts)).catch(() => {});
  }, [f.values.companyId, mode]);
  const save = () => f.submit(async (v) => {
    const body = {
      ...(mode === "existing" ? { companyId: v.companyId || null } : { newCompany: { name: v.newCompanyName } }),
      name: v.name, value: v.value, stage: v.stage || undefined, expectedCloseOn: v.expectedCloseOn || null,
      ownerUserId: v.ownerUserId || null, nextStep: v.nextStep, contactId: v.contactId || null,
    };
    const d = await api.post<Deal>("/api/crm/deals", body);
    refresh();
    toast(`${d.name} added to the pipeline`);
    onClose();
    onSaved?.(d);
  });
  const companyList = companies.data ?? [];
  return (
    <Modal open={open} onClose={onClose} title="New deal" subtitle="Track an opportunity through your pipeline."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Add deal</Button></>}>
      <div className="form-grid">
        {!companyId && (
          <div className="span-2">
            {mode === "existing" ? (
              <Field label="Company" error={f.errors.companyId}
                hint={<button type="button" className="crm-link" onClick={() => setMode("new")}><Plus size={13} /> Create a new company</button>}>
                <select className="select" value={f.values.companyId} onChange={(e) => f.set("companyId", e.target.value)} aria-invalid={!!f.errors.companyId}>
                  <option value="">{companies.isLoading ? "Loading companies…" : "Choose a company"}</option>
                  {companyList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="New company name" error={f.errors["newCompany.name"]}
                hint={companyList.length ? <button type="button" className="crm-link" onClick={() => setMode("existing")}>Choose an existing company instead</button> : undefined}>
                <input className="input" autoFocus value={f.values.newCompanyName} onChange={(e) => f.set("newCompanyName", e.target.value)} aria-invalid={!!f.errors["newCompany.name"]} />
              </Field>
            )}
          </div>
        )}
        <Input label="Deal name" wrapClassName="span-2" placeholder="e.g. Staff canteen supply" {...f.bind("name")} />
        <Input label={`Value (${org.currency})`} inputMode="decimal" placeholder="0" {...f.bind("value")} />
        <Select label="Stage" value={f.values.stage || stages[0] || ""} onChange={(e) => f.set("stage", e.target.value)} options={stages} error={f.errors.stage} />
        {mode === "existing" && contacts.length > 0 && (
          <Select label="Contact" optional value={f.values.contactId} onChange={(e) => f.set("contactId", e.target.value)} placeholder="No contact"
            options={contacts.map((c) => ({ value: c.id, label: c.name }))} error={f.errors.contactId} />
        )}
        <Input label="Expected close" optional type="date" {...f.bind("expectedCloseOn")} />
        <MemberSelect value={f.values.ownerUserId} onChange={(v) => f.set("ownerUserId", v)} error={f.errors.ownerUserId} />
        <Input label="Next step" optional wrapClassName="span-2" placeholder="e.g. Send proposal" {...f.bind("nextStep")} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ lead modal

const SOURCES = ["Website", "Referral", "Cold call", "LinkedIn", "Trade fair", "Walk-in", "Imported", "Other"];

export function LeadModal({ open, onClose, lead }: { open: boolean; onClose: () => void; lead?: Lead | null }) {
  const { user, org } = useSession();
  const refresh = useRefreshCrm();
  const toast = useToast();
  const blank = { companyName: "", contactName: "", contactRole: "", email: "", phone: "", source: "", ownerUserId: user.id, estimatedValue: "", nextStep: "", nextStepDue: "" };
  const f = useForm(blank);
  useEffect(() => {
    if (!open) return;
    f.setValues(lead ? {
      companyName: lead.companyName, contactName: lead.contactName ?? "", contactRole: lead.contactRole ?? "", email: lead.email ?? "", phone: lead.phone ?? "",
      source: lead.source ?? "", ownerUserId: lead.ownerUserId ?? "", estimatedValue: lead.estimatedValue != null ? String(lead.estimatedValue) : "",
      nextStep: lead.nextStep ?? "", nextStepDue: toDateInput(lead.nextStepDue),
    } : blank);
    f.setErrors({}); f.setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead?.id]);
  const save = () => f.submit(async (v) => {
    const body = { ...v, ownerUserId: v.ownerUserId || null, nextStepDue: v.nextStepDue || null };
    if (lead) await api.patch(`/api/crm/leads/${lead.id}`, body);
    else await api.post("/api/crm/leads", body);
    refresh();
    toast(lead ? "Lead updated" : `${v.companyName} added to leads`);
    onClose();
  });
  const sources = Array.from(new Set([...SOURCES, ...(f.values.source ? [f.values.source] : [])]));
  return (
    <Modal open={open} onClose={onClose} title={lead ? `Edit ${lead.companyName}` : "Add lead"} subtitle={lead ? undefined : "Someone you might sell to. Qualify them before they become a deal."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>{lead ? "Save changes" : "Add lead"}</Button></>}>
      <div className="form-grid">
        <Input label="Company name" wrapClassName="span-2" autoFocus {...f.bind("companyName")} />
        <Input label="Contact name" optional {...f.bind("contactName")} />
        <Input label="Their role" optional placeholder="e.g. Head of Admin" {...f.bind("contactRole")} />
        <Input label="Email" optional type="email" {...f.bind("email")} />
        <Input label="Phone" optional type="tel" {...f.bind("phone")} />
        <Select label="Source" optional value={f.values.source} onChange={(e) => f.set("source", e.target.value)} placeholder="Not sure" options={sources} />
        <MemberSelect value={f.values.ownerUserId} onChange={(v) => f.set("ownerUserId", v)} error={f.errors.ownerUserId} />
        <Input label={`Estimated value (${org.currency})`} optional inputMode="decimal" {...f.bind("estimatedValue")} />
        <Input label="Next step due" optional type="date" {...f.bind("nextStepDue")} />
        <Input label="Next step" optional wrapClassName="span-2" placeholder="e.g. Reach out by Thursday" {...f.bind("nextStep")} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ convert modal

type Preview = { existingCompany: { id: string; name: string; contactCount: number; createdAt: string } | null; dealStages: string[] };

export function ConvertModal({ lead, onClose, onDone }: { lead: Lead | null; onClose: () => void; onDone?: (r: { companyId: string; dealId: string }) => void }) {
  const refresh = useRefreshCrm();
  const toast = useToast();
  const navigate = useNavigate();
  const { org } = useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [choice, setChoice] = useState<"existing" | "new">("existing");
  const f = useForm({ dealName: "", stage: "", value: "", contactName: "", contactRole: "", contactEmail: "", contactPhone: "" });
  useEffect(() => {
    if (!lead) return;
    setPreview(null); setLoadError(null);
    f.setValues({
      dealName: "", stage: "", value: lead.estimatedValue != null ? String(lead.estimatedValue) : "",
      contactName: lead.contactName ?? "", contactRole: lead.contactRole ?? "", contactEmail: lead.email ?? "", contactPhone: lead.phone ?? "",
    });
    f.setErrors({}); f.setFormError(null);
    api.get<Preview>(`/api/crm/leads/${lead.id}/convert-preview`).then((p) => {
      setPreview(p);
      setChoice(p.existingCompany ? "existing" : "new");
      f.set("stage", p.dealStages[0] ?? "");
    }).catch(setLoadError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);
  if (!lead) return null;
  const existing = preview?.existingCompany ?? null;
  const targetName = choice === "existing" && existing ? existing.name : lead.companyName;
  const convert = () => f.submit(async (v) => {
    const r = await api.post<{ companyId: string; dealId: string }>(`/api/crm/leads/${lead.id}/convert`, {
      useExistingCompanyId: choice === "existing" && existing ? existing.id : null,
      contact: v.contactName ? { name: v.contactName, role: v.contactRole, email: v.contactEmail, phone: v.contactPhone } : undefined,
      deal: { name: v.dealName, stage: v.stage, value: v.value },
    });
    refresh();
    toast(`${targetName} is now in your pipeline`);
    onClose();
    if (onDone) onDone(r);
    else navigate(`/crm/companies/${r.companyId}`);
  });
  return (
    <Modal open onClose={onClose} title={`Convert ${lead.companyName}`} subtitle="Turn this lead into a company, contact and deal."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} disabled={!preview} onClick={convert}>Convert to client</Button></>}>
      {loadError ? <ErrorNotice error={loadError} /> : !preview ? <Loading /> : (
        <div className="stack">
          <div>
            <div className="section-label crm-sec">Company</div>
            {existing && (
              <label className={cx("crm-choice", choice === "existing" && "on")}>
                <input type="radio" name="co" checked={choice === "existing"} onChange={() => setChoice("existing")} />
                <span>
                  <b>{existing.name} is already in CRM</b>
                  <small>Added {fmtDate(existing.createdAt)} · {existing.contactCount} contact{existing.contactCount === 1 ? "" : "s"}</small>
                </span>
              </label>
            )}
            <label className={cx("crm-choice", choice === "new" && "on")}>
              <input type="radio" name="co" checked={choice === "new"} onChange={() => setChoice("new")} />
              <span>
                <b>{existing ? "Create a new company instead" : `Create ${lead.companyName}`}</b>
                {!existing && <small>New company, added as a prospect</small>}
              </span>
            </label>
          </div>
          <div>
            <div className="section-label crm-sec">Contact</div>
            {f.values.contactName ? (
              <div className="crm-choice on static">
                <span>
                  <b>{f.values.contactName}{f.values.contactRole && <span className="muted"> · {f.values.contactRole}</span>}</b>
                  <small>New contact, added to {targetName}{f.values.contactEmail ? ` · ${f.values.contactEmail}` : ""}</small>
                </span>
              </div>
            ) : <p className="muted crm-small">No contact on this lead. You can add one on the company page.</p>}
          </div>
          <div>
            <div className="section-label crm-sec">Deal</div>
            <div className="form-grid">
              <Input label="Deal name" placeholder="e.g. Staff canteen supply" autoFocus value={f.values.dealName} onChange={(e) => f.set("dealName", e.target.value)} error={f.errors["deal.name"]} />
              <Select label="Stage" value={f.values.stage} onChange={(e) => f.set("stage", e.target.value)} options={preview.dealStages} error={f.errors["deal.stage"]} />
              <Input label={`Value (${org.currency})`} inputMode="decimal" value={f.values.value} onChange={(e) => f.set("value", e.target.value)} error={f.errors["deal.value"]} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ reason modal

export function ReasonModal({ open, onClose, title, subtitle, label, confirm, onSubmit, suggestions = [] }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; label: string; confirm: string;
  onSubmit: (reason: string) => Promise<unknown>; suggestions?: string[];
}) {
  const f = useForm({ reason: "" });
  useEffect(() => { if (open) { f.setValues({ reason: "" }); f.setErrors({}); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const go = () => f.submit(async (v) => { await onSubmit(v.reason); onClose(); });
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={f.busy} onClick={go}>{confirm}</Button></>}>
      {suggestions.length > 0 && (
        <div className="crm-chips">
          {suggestions.map((s) => <button key={s} type="button" className={cx("crm-chip", f.values.reason === s && "on")} onClick={() => f.set("reason", s)}>{s}</button>)}
        </div>
      )}
      <Input label={label} autoFocus {...f.bind("reason")} />
    </Modal>
  );
}

// ------------------------------------------------------------ stages modal

export function StagesModal({ open, onClose, kind }: { open: boolean; onClose: () => void; kind: "leads" | "deals" }) {
  const summary = useSummary();
  const refresh = useRefreshCrm();
  const toast = useToast();
  const current = kind === "leads" ? summary.data?.leadStages : summary.data?.dealStages;
  const [stages, setStages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && current) { setStages([...current]); setError(null); } }, [open, current]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api.put(`/api/crm/stages/${kind}`, { stages: stages.map((s) => s.trim()).filter(Boolean) });
      refresh();
      toast("Stages saved");
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };
  const move = (i: number, d: number) => setStages((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); return n; });
  return (
    <Modal open={open} onClose={onClose} title={kind === "leads" ? "Edit lead stages" : "Edit deal stages"}
      subtitle={kind === "leads" ? "Closed is added automatically. The last stage is where leads are ready to convert." : "Won and Lost are added automatically. New deals start at the first stage."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save stages</Button></>}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="stack" style={{ gap: 8 }}>
        {stages.map((s, i) => (
          <div className="row" key={i}>
            <span className="crm-stage-n">{i + 1}</span>
            <input className="input" value={s} aria-label={`Stage ${i + 1}`} onChange={(e) => setStages((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
            <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
            <Button variant="ghost" size="sm" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
            <Button variant="ghost" size="sm" disabled={stages.length <= 1} onClick={() => setStages((x) => x.filter((_, j) => j !== i))} aria-label="Remove stage"><X size={15} /></Button>
          </div>
        ))}
        {stages.length < 12 && <div><Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => setStages((s) => [...s, ""])}>Add stage</Button></div>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ activity composer + timeline

type Target = { companyId?: string; dealId?: string; leadId?: string; name: string };

export function ActivityComposer({ target, contacts = [], initialType = "note", onSaved, autoFocus }: {
  target: Target; contacts?: Contact[]; initialType?: ActivityType; onSaved?: () => void; autoFocus?: boolean;
}) {
  const { user } = useSession();
  const refresh = useRefreshCrm();
  const toast = useToast();
  const [type, setType] = useState<ActivityType>(initialType);
  const [withFollowUp, setWithFollowUp] = useState(false);
  const blank = { subject: "", body: "", contactId: "", durationMinutes: "", fuTitle: "", fuDue: defaultDue(), fuAssignee: user.id };
  const f = useForm(blank);
  const placeholder = type === "note" ? `Write a note about ${target.name}…` : type === "call" ? "What was said on the call?" : type === "meeting" ? "How did the meeting go?" : "What was the email about?";
  const save = () => f.submit(async (v) => {
    await api.post("/api/crm/activities", {
      type, subject: v.subject, body: v.body, contactId: v.contactId || null,
      durationMinutes: v.durationMinutes ? Number(v.durationMinutes) : null,
      companyId: target.companyId ?? null, dealId: target.dealId ?? null, leadId: target.leadId ?? null,
      followUp: withFollowUp ? { title: v.fuTitle, dueAt: fromLocalInput(v.fuDue), assigneeUserId: v.fuAssignee || null } : null,
    });
    f.setValues({ ...blank, fuDue: defaultDue() });
    setWithFollowUp(false);
    refresh();
    toast(withFollowUp ? `${ACT_LABEL[type]} saved and follow-up added` : `${ACT_LABEL[type]} saved`);
    onSaved?.();
  });
  return (
    <div className="crm-composer">
      <div className="crm-composer-tabs" role="tablist">
        {(Object.keys(ACT_LABEL) as ActivityType[]).map((t) => (
          <button key={t} role="tab" aria-selected={type === t} className={cx(type === t && "on")} onClick={() => setType(t)}>
            {ACT_ICON[t](15)}{ACT_LABEL[t]}
          </button>
        ))}
      </div>
      {type !== "note" && (
        <div className="crm-composer-meta">
          <input className="input" placeholder={type === "email" ? "Subject" : type === "call" ? "Call with…" : "Meeting title"} aria-label="Subject"
            value={f.values.subject} onChange={(e) => f.set("subject", e.target.value)} />
          {contacts.length > 0 && (
            <select className="select" aria-label="Contact" value={f.values.contactId} onChange={(e) => f.set("contactId", e.target.value)}>
              <option value="">No contact</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {type !== "email" && (
            <input className="input crm-dur" type="number" min={0} placeholder="Minutes" aria-label="Duration in minutes"
              value={f.values.durationMinutes} onChange={(e) => f.set("durationMinutes", e.target.value)} />
          )}
        </div>
      )}
      <textarea className="crm-composer-text" placeholder={placeholder} aria-label={placeholder} rows={3} autoFocus={autoFocus}
        value={f.values.body} onChange={(e) => f.set("body", e.target.value)} />
      {withFollowUp && (
        <div className="crm-composer-fu">
          <input className="input" placeholder="Follow-up, e.g. Call Grace about the proposal" aria-label="Follow-up" value={f.values.fuTitle}
            onChange={(e) => f.set("fuTitle", e.target.value)} aria-invalid={!!f.errors["followUp.title"]} />
          <input className="input" type="datetime-local" aria-label="Due" value={f.values.fuDue} onChange={(e) => f.set("fuDue", e.target.value)} />
          <AssigneeSelect value={f.values.fuAssignee} onChange={(v) => f.set("fuAssignee", v)} />
        </div>
      )}
      <div className="crm-composer-foot">
        <Button variant="secondary" size="sm" icon={withFollowUp ? <X size={14} /> : <Clock size={14} />} onClick={() => setWithFollowUp((x) => !x)}>
          {withFollowUp ? "No follow-up" : "Add follow-up"}
        </Button>
        <Button size="sm" loading={f.busy} onClick={save}>Save</Button>
      </div>
    </div>
  );
}

function AssigneeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const members = useMembers();
  return (
    <select className="select" aria-label="Assigned to" value={value} onChange={(e) => onChange(e.target.value)}>
      {(members.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );
}

function activityTitle(a: Activity) {
  if (a.type === "note") return a.subject ? a.subject : `${a.authorName} added a note`;
  const prefix = a.type === "call" ? "Call" : a.type === "meeting" ? "Meeting" : "Email sent";
  if (a.subject) return a.type === "call" && /^call\b/i.test(a.subject) ? a.subject : `${prefix}: ${a.subject}`;
  return a.contactName ? `${prefix} with ${a.contactName}` : prefix;
}

export function Timeline({ items, filter = "all" }: { items: Activity[]; filter?: string }) {
  const { user } = useSession();
  const { canManage } = useCrmAccess();
  const refresh = useRefreshCrm();
  const [run] = useAction();
  const list = filter === "all" ? items : items.filter((a) => a.type === filter);
  if (!list.length) return <p className="muted crm-small crm-pad">No activity yet. Log a call, meeting or note above.</p>;
  return (
    <ul className="crm-timeline">
      {list.map((a) => {
        const meta = [
          timeAgo(a.occurredAt) === "Yesterday" ? `Yesterday, ${fmtTime(a.occurredAt)}` : `${fmtDate(a.occurredAt, { day: "numeric", month: "short" })}${dayLabel(a.occurredAt) === "Today" ? `, ${fmtTime(a.occurredAt)}` : ""}`,
          a.type !== "note" ? a.authorName : null,
          a.type !== "note" && a.contactName && a.subject ? `with ${a.contactName}` : null,
          a.durationMinutes ? `${a.durationMinutes} min` : null,
        ].filter(Boolean).join(" · ");
        return (
          <li key={a.id}>
            <ActIcon type={a.type} size={32} />
            <div className="crm-tl-body">
              <div className="between">
                <b>{activityTitle(a)}</b>
                {(a.authorUserId === user.id || canManage) && (
                  <button className="crm-icon-ghost" aria-label="Delete activity" title="Delete"
                    onClick={() => run(async () => { await api.del(`/api/crm/activities/${a.id}`); refresh(); }, "Activity deleted")}><Trash2 size={14} /></button>
                )}
              </div>
              <small>{meta}</small>
              {a.body && <p>{a.body}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------ follow-ups

export function FollowUpRow({ t, onLog, showAssignee }: { t: FollowUp; onLog?: (t: FollowUp) => void; showAssignee?: boolean }) {
  const navigate = useNavigate();
  const money = useSession().money;
  const { canEdit } = useCrmAccess();
  const refresh = useRefreshCrm();
  const [run, busy] = useAction();
  const kind = followUpKind(t.title);
  const due = dueText(t.dueAt, true);
  const ctx = [t.companyName, t.dealName ? `${t.dealName}${t.dealValue ? ` ${money(t.dealValue, true)}` : ""}` : t.linkType === "lead" ? "lead" : null].filter(Boolean).join(" · ");
  const open = () => {
    if (t.linkType === "lead" && t.leadId) navigate(`/crm/leads?lead=${t.leadId}`);
    else if (t.linkType === "deal" && t.dealId) navigate(`/crm/pipeline?deal=${t.dealId}`);
    else if (t.companyId) navigate(`/crm/companies/${t.companyId}`);
  };
  const done = () => run(async () => { await api.post(`/api/crm/follow-ups/${t.id}/done`); refresh(); }, "Follow-up done");
  const action = !canEdit ? <Button variant="secondary" size="sm" onClick={open}>Open</Button>
    : due.overdue || dueText(t.dueAt).text === "Today"
      ? kind === "call" || kind === "meeting"
        ? <Button variant="secondary" size="sm" onClick={() => onLog?.(t)}>Log {kind}</Button>
        : <Button variant="secondary" size="sm" loading={busy} onClick={done}>Mark done</Button>
      : <Button variant="secondary" size="sm" onClick={open}>Open</Button>;
  return (
    <div className="crm-fu-row">
      <ActIcon type={kind} size={34} />
      <button className="crm-fu-main" onClick={open}>
        <b>{t.title}</b>
        <small>{ctx || t.linkLabel || "—"}</small>
      </button>
      <span className={cx("crm-fu-due", due.overdue && "overdue")}>{due.text}</span>
      {showAssignee && <Owner name={t.assigneeName} />}
      {action}
    </div>
  );
}

/** "Log call" from a follow-up: records the activity on the same record and completes the follow-up. */
export function LogFollowUpModal({ t, onClose }: { t: FollowUp | null; onClose: () => void }) {
  const refresh = useRefreshCrm();
  if (!t) return null;
  const kind = followUpKind(t.title);
  const target: Target = {
    name: t.companyName ?? t.linkLabel ?? "this record",
    ...(t.linkType === "deal" ? { dealId: t.linkId! } : t.linkType === "lead" ? { leadId: t.linkId! } : { companyId: t.linkId! }),
  };
  return (
    <Modal open onClose={onClose} title={`Log ${ACT_LABEL[kind].toLowerCase()}`} subtitle={`${t.title}${t.companyName ? ` · ${t.companyName}` : ""}`}>
      <ActivityComposer target={target} initialType={kind} autoFocus onSaved={async () => {
        await api.post(`/api/crm/follow-ups/${t.id}/done`).catch(() => {});
        refresh();
        onClose();
      }} />
      <p className="muted crm-small" style={{ marginTop: 10 }}>Saving also marks this follow-up as done.</p>
    </Modal>
  );
}

export function FollowUpModal({ open, onClose, target }: { open: boolean; onClose: () => void; target?: Target }) {
  const { user } = useSession();
  const refresh = useRefreshCrm();
  const toast = useToast();
  const companies = useCompanies({});
  const deals = useDeals({});
  const leads = useLeads({});
  const f = useForm({ title: "", dueAt: defaultDue(), assigneeUserId: user.id, ref: "" });
  useEffect(() => { if (open) { f.setValues({ title: "", dueAt: defaultDue(), assigneeUserId: user.id, ref: "" }); f.setErrors({}); f.setFormError(null); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const save = () => f.submit(async (v) => {
    let link: Record<string, string | null> = {};
    if (target) link = { companyId: target.companyId ?? null, dealId: target.dealId ?? null, leadId: target.leadId ?? null };
    else if (v.ref) { const [k, id] = v.ref.split(":"); link = { [`${k}Id`]: id! }; }
    await api.post("/api/crm/follow-ups", { title: v.title, dueAt: fromLocalInput(v.dueAt), assigneeUserId: v.assigneeUserId || null, ...link });
    refresh();
    toast("Follow-up added");
    onClose();
  });
  const refError = f.errors.companyId;
  return (
    <Modal open={open} onClose={onClose} title="New follow-up" subtitle={target ? target.name : "A reminder to get back to a client, deal or lead."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Add follow-up</Button></>}>
      <div className="form-grid">
        <Input label="What needs to happen" wrapClassName="span-2" autoFocus placeholder="e.g. Call Grace about the proposal" {...f.bind("title")} />
        {!target && (
          <Field label="For" className="span-2" error={refError}>
            <select className="select" value={f.values.ref} onChange={(e) => f.set("ref", e.target.value)} aria-invalid={!!refError}>
              <option value="">Choose a company, deal or lead</option>
              {!!deals.data?.items.filter((d) => d.status === "open").length && (
                <optgroup label="Open deals">{deals.data.items.filter((d) => d.status === "open").map((d) => <option key={d.id} value={`deal:${d.id}`}>{d.companyName} · {d.name}</option>)}</optgroup>
              )}
              {!!companies.data?.length && <optgroup label="Companies">{companies.data.map((c) => <option key={c.id} value={`company:${c.id}`}>{c.name}</option>)}</optgroup>}
              {!!leads.data?.items.filter((l) => l.stage !== "Closed").length && (
                <optgroup label="Leads">{leads.data.items.filter((l) => l.stage !== "Closed").map((l) => <option key={l.id} value={`lead:${l.id}`}>{l.companyName} (lead)</option>)}</optgroup>
              )}
            </select>
          </Field>
        )}
        <Input label="Due" type="datetime-local" error={f.errors.dueAt} value={f.values.dueAt} onChange={(e) => f.set("dueAt", e.target.value)} />
        <MemberSelect label="Assigned to" allowNone={false} value={f.values.assigneeUserId} onChange={(v) => f.set("assigneeUserId", v)} error={f.errors.assigneeUserId} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ deal drawer

export function DealDrawer({ id, onClose, stages }: { id: string | null; onClose: () => void; stages: string[] }) {
  const q = useDeal(id);
  const navigate = useNavigate();
  const { money, org } = useSession();
  const { canEdit, canManage } = useCrmAccess();
  const refresh = useRefreshCrm();
  const [run, busy] = useAction();
  const [lost, setLost] = useState(false);
  const [edit, setEdit] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const d = q.data?.deal;
  return (
    <Drawer open={!!id} onClose={onClose} title={d?.name ?? "Deal"}
      headerExtra={d && <CoMark name={d.companyName ?? d.name} size={34} />}
      footer={d && canEdit && (
        d.status === "open" ? (
          <>
            <Button variant="secondary" onClick={() => setLost(true)}>Mark lost</Button>
            <Button loading={busy} onClick={() => run(async () => { await api.post(`/api/crm/deals/${d.id}/won`); refresh(); }, `${d.name} won`)}>Mark won</Button>
          </>
        ) : (
          <>
            <span className="muted crm-small">{d.status === "won" ? `Won ${fmtDate(d.wonAt)}` : `Lost ${fmtDate(d.lostAt)}${d.lostReason ? ` · ${d.lostReason}` : ""}`}</span>
            <Button variant="secondary" loading={busy} onClick={() => run(async () => { await api.post(`/api/crm/deals/${d.id}/reopen`); refresh(); }, "Deal reopened")}>Reopen</Button>
          </>
        )
      )}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNotice error={q.error} retry={() => q.refetch()} /> : d && (
        <div className="stack">
          <div className="between">
            <div>
              <div className="crm-big">{money(d.value)}</div>
              <button className="crm-link" onClick={() => navigate(`/crm/companies/${d.companyId}`)}>{d.companyName}</button>
            </div>
            {d.status === "open" ? (
              canEdit ? <MoveTo stages={stages} value={d.stage} label={`Stage: ${d.stage}`} disabled={busy}
                onMove={(s) => run(async () => { await api.post(`/api/crm/deals/${d.id}/move`, { stage: s }); refresh(); }, `Moved to ${s}`)} />
                : <Pill tone="blue">{d.stage}</Pill>
            ) : <Pill tone={d.status === "won" ? "ok" : "grey"}>{d.status === "won" ? "Won" : "Lost"}</Pill>}
          </div>
          <dl className="kv">
            <div><dt>Stage</dt><dd>{d.stage}</dd></div>
            <div><dt>Contact</dt><dd>{d.contactName ?? "—"}</dd></div>
            <div><dt>Owner</dt><dd>{d.ownerName ?? "Unassigned"}</dd></div>
            <div><dt>Expected close</dt><dd>{fmtDate(d.expectedCloseOn)}</dd></div>
            <div><dt>Next step</dt><dd>{d.nextStep ?? "—"}</dd></div>
            <div><dt>Currency</dt><dd>{d.currency || org.currency}</dd></div>
          </dl>
          {canEdit && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <Button variant="secondary" size="sm" onClick={() => setEdit(true)}>Edit details</Button>
              <Button variant="secondary" size="sm" icon={<Clock size={14} />} onClick={() => setFollowUp(true)}>Add follow-up</Button>
              {canManage && <Button variant="ghost" size="sm" onClick={() => run(async () => { await api.del(`/api/crm/deals/${d.id}`); refresh(); onClose(); }, "Deal deleted")}>Delete</Button>}
            </div>
          )}
          {!!q.data!.followUps.length && (
            <div>
              <div className="section-label crm-sec">Follow-ups</div>
              {q.data!.followUps.map((t) => <FollowUpRow key={t.id} t={t} />)}
            </div>
          )}
          <div>
            <div className="section-label crm-sec">Activity</div>
            {canEdit && <ActivityComposer target={{ dealId: d.id, name: d.name }} contacts={q.data!.contacts} />}
            <Timeline items={q.data!.activities} />
          </div>
        </div>
      )}
      {d && (
        <>
          <ReasonModal open={lost} onClose={() => setLost(false)} title={`Mark ${d.name} as lost`} label="Why was it lost?" confirm="Mark lost"
            suggestions={["Price", "Went with a competitor", "No budget", "No response", "Timing"]}
            onSubmit={async (reason) => { await api.post(`/api/crm/deals/${d.id}/lost`, { reason }); refresh(); }} />
          <DealEditModal open={edit} onClose={() => setEdit(false)} deal={d} contacts={q.data?.contacts ?? []} />
          <FollowUpModal open={followUp} onClose={() => setFollowUp(false)} target={{ dealId: d.id, name: `${d.companyName} · ${d.name}` }} />
        </>
      )}
    </Drawer>
  );
}

function DealEditModal({ open, onClose, deal, contacts }: { open: boolean; onClose: () => void; deal: Deal; contacts: Contact[] }) {
  const { org } = useSession();
  const refresh = useRefreshCrm();
  const f = useForm({ name: "", value: "", expectedCloseOn: "", ownerUserId: "", nextStep: "", contactId: "" });
  useEffect(() => {
    if (open) f.setValues({ name: deal.name, value: String(deal.value), expectedCloseOn: toDateInput(deal.expectedCloseOn), ownerUserId: deal.ownerUserId ?? "", nextStep: deal.nextStep ?? "", contactId: deal.contactId ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = () => f.submit(async (v) => {
    await api.patch(`/api/crm/deals/${deal.id}`, { ...v, expectedCloseOn: v.expectedCloseOn || null, ownerUserId: v.ownerUserId || null, contactId: v.contactId || null });
    refresh();
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="Edit deal"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Save changes</Button></>}>
      <div className="form-grid">
        <Input label="Deal name" wrapClassName="span-2" {...f.bind("name")} />
        <Input label={`Value (${org.currency})`} inputMode="decimal" {...f.bind("value")} />
        <Input label="Expected close" optional type="date" {...f.bind("expectedCloseOn")} />
        <Select label="Contact" optional value={f.values.contactId} onChange={(e) => f.set("contactId", e.target.value)} placeholder="No contact"
          options={contacts.map((c) => ({ value: c.id, label: c.name }))} error={f.errors.contactId} />
        <MemberSelect value={f.values.ownerUserId} onChange={(v) => f.set("ownerUserId", v)} error={f.errors.ownerUserId} />
        <Input label="Next step" optional wrapClassName="span-2" {...f.bind("nextStep")} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ lead drawer

const QUAL: { key: "need" | "budget" | "decisionMaker" | "timeline"; label: string; hint: string }[] = [
  { key: "need", label: "They have a real need", hint: "What problem are they solving?" },
  { key: "budget", label: "Budget is available", hint: "Roughly how much, and approved by whom?" },
  { key: "decisionMaker", label: "We're talking to the decision maker", hint: "Who signs off?" },
  { key: "timeline", label: "There's a timeline", hint: "When do they want to start?" },
];

export function QualMeter({ score }: { score: number }) {
  return <span className="crm-qual" title={`${score} of 4 qualification checks`}>{[0, 1, 2, 3].map((i) => <i key={i} className={i < score ? "on" : ""} />)}</span>;
}

export function LeadDrawer({ id, onClose, stages, onConvert }: { id: string | null; onClose: () => void; stages: string[]; onConvert: (l: Lead) => void }) {
  const q = useLead(id);
  const navigate = useNavigate();
  const { money } = useSession();
  const { canEdit, canManage } = useCrmAccess();
  const refresh = useRefreshCrm();
  const [run, busy] = useAction();
  const [notFit, setNotFit] = useState(false);
  const [edit, setEdit] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const l = q.data?.lead;
  useEffect(() => { setNotes(l?.qualification.notes ?? {}); }, [l?.id, l?.qualification.notes]);
  const closed = l?.stage === "Closed";
  const setQual = (patch: Record<string, unknown>) => l && run(async () => { await api.put(`/api/crm/leads/${l.id}/qualification`, patch); refresh(); });
  const contactLine = useMemo(() => l ? [l.contactName, l.contactRole].filter(Boolean).join(" · ") : "", [l]);
  return (
    <Drawer open={!!id} onClose={onClose} title={l?.companyName ?? "Lead"} headerExtra={l && <CoMark name={l.companyName} size={34} />}
      footer={l && canEdit && !closed && (
        <>
          <Button variant="secondary" onClick={() => setNotFit(true)}>Not a fit</Button>
          <Button onClick={() => onConvert(l)}>Convert to client</Button>
        </>
      )}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNotice error={q.error} retry={() => q.refetch()} /> : l && (
        <div className="stack">
          <div className="between">
            <div>
              <b className="ink">{contactLine || "No contact yet"}</b>
              <div className="muted crm-small">{[l.email, l.phone, l.source].filter(Boolean).join(" · ") || "No contact details"}</div>
            </div>
            {closed ? <Pill tone={l.closedOutcome === "converted" ? "ok" : "grey"}>{l.closedOutcome === "converted" ? "Converted" : "Not interested"}</Pill>
              : canEdit ? <MoveTo stages={stages} value={l.stage} label={`Stage: ${l.stage}`} disabled={busy}
                onMove={(s) => run(async () => { await api.post(`/api/crm/leads/${l.id}/move`, { stage: s }); refresh(); }, `Moved to ${s}`)} />
                : <Pill tone="blue">{l.stage}</Pill>}
          </div>
          {closed && l.closedOutcome === "converted" && l.convertedCompanyId && (
            <Notice tone="ok" action={<button className="crm-link" onClick={() => navigate(`/crm/companies/${l.convertedCompanyId}`)}>Open company</button>}>
              Converted {fmtDate(l.closedAt)}.
            </Notice>
          )}
          {closed && l.closedOutcome === "not_interested" && (
            <Notice tone="info" action={canEdit && <button className="crm-link" onClick={() => run(async () => { await api.post(`/api/crm/leads/${l.id}/move`, { stage: stages[0] }); refresh(); }, "Lead reopened")}>Reopen</button>}>
              Closed {fmtDate(l.closedAt)}{l.closedReason ? `: ${l.closedReason}` : ""}.
            </Notice>
          )}
          <dl className="kv">
            <div><dt>Estimated value</dt><dd>{l.estimatedValue != null ? money(l.estimatedValue) : "—"}</dd></div>
            <div><dt>Owner</dt><dd>{l.ownerName ?? "Unassigned"}</dd></div>
            <div><dt>Next step</dt><dd>{l.nextStep ?? "—"}{l.nextStepDue ? ` · ${dayLabel(l.nextStepDue)}` : ""}</dd></div>
            <div><dt>Added</dt><dd>{fmtDate(l.createdAt)}</dd></div>
          </dl>
          <ExtraDetailsList reference={l.reference} referenceLabel="Lead ID" extra={l.extraDetails} />
          {canEdit && <div><Button variant="secondary" size="sm" onClick={() => setEdit(true)}>Edit details</Button></div>}
          <div>
            <div className="between"><div className="section-label crm-sec">Qualification</div><QualMeter score={l.qualificationScore} /></div>
            <div className="stack" style={{ gap: 10 }}>
              {QUAL.map((x) => (
                <div key={x.key} className="crm-qual-item">
                  <Checkbox label={x.label} checked={!!l.qualification[x.key]} disabled={!canEdit || closed || busy}
                    onChange={(e) => setQual({ [x.key]: e.target.checked })} />
                  <input className="input" placeholder={x.hint} aria-label={`${x.label} notes`} disabled={!canEdit || closed}
                    value={notes[x.key] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [x.key]: e.target.value }))}
                    onBlur={() => (notes[x.key] ?? "") !== (l.qualification.notes?.[x.key] ?? "") && setQual({ notes: { [x.key]: notes[x.key] ?? "" } })} />
                </div>
              ))}
            </div>
          </div>
          {!!q.data!.followUps.length && (
            <div>
              <div className="section-label crm-sec">Follow-ups</div>
              {q.data!.followUps.map((t) => <FollowUpRow key={t.id} t={t} />)}
            </div>
          )}
          <div>
            <div className="section-label crm-sec">Activity</div>
            {canEdit && !closed && <ActivityComposer target={{ leadId: l.id, name: l.companyName }} />}
            <Timeline items={q.data!.activities} />
          </div>
          {canManage && <div><Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => run(async () => { await api.del(`/api/crm/leads/${l.id}`); refresh(); onClose(); }, "Lead deleted")}>Delete lead</Button></div>}
        </div>
      )}
      {l && (
        <>
          <ReasonModal open={notFit} onClose={() => setNotFit(false)} title={`Close ${l.companyName}`} subtitle="The lead moves to Closed as not interested." label="Why isn't it a fit?" confirm="Close lead"
            suggestions={["Has a supplier", "No budget", "Too small", "No response", "Wrong contact"]}
            onSubmit={async (reason) => { await api.post(`/api/crm/leads/${l.id}/close`, { reason }); refresh(); onClose(); }} />
          <LeadModal open={edit} onClose={() => setEdit(false)} lead={l} />
        </>
      )}
    </Drawer>
  );
}

export function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.slice(0, 4).toUpperCase() ?? "";
  return <span className="crm-file-ic">{ext || <FileText size={14} />}</span>;
}
