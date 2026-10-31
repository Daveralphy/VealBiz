import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Check, ChevronLeft, FileText, Plus, Settings2, Trash2, X } from "lucide-react";
import {
  Avatar, Button, Card, EmptyState, Input, Loading, Modal, Notice, Pill, Select, Textarea, useConfirm, useToast, type Tone,
} from "@windveal/ui";
import { ApiError, api, fileUrl, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { fmtDate, fmtTime, timeAgo } from "../../lib/format";
import { useForm } from "../../lib/form";
import { useMembers } from "./tasks";

type ApprovalRow = {
  id: string; kind: string; title: string; details: string | null; amount: string | null; status: "pending" | "approved" | "declined";
  createdAt: string; requester: { id: string; name: string }; currentApprover: { id: string; name: string } | null; steps: number; myTurn: boolean;
};
type Step = {
  id: string; position: number; label: string | null; status: "waiting" | "pending" | "approved" | "declined" | "skipped"; comment: string | null;
  decidedAt: string | null; approver: { id: string; name: string }; isMe: boolean;
};
type ApprovalDetail = Omit<ApprovalRow, "currentApprover" | "steps" | "myTurn"> & {
  decidedAt: string | null; requester: { id: string; name: string; jobTitle: string | null }; steps: Step[];
  files: { id: string; name: string; size: number }[]; canDecide: boolean;
};
type Rule = { id: string; kind: string; minAmount: string | null; label: string | null; position: number; approver: { id: string; name: string } };

export const KIND_LABEL: Record<string, string> = { purchase: "Purchase", leave: "Leave", document: "Document", offer: "Offer", other: "Other" };
const KIND_TONE: Record<string, Tone> = { purchase: "warn", leave: "ok", document: "blue", offer: "violet", other: "grey" };
const first = (name: string) => name.split(/\s+/)[0] ?? name;

function useRefreshApprovals() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["wf-approvals"] });
    qc.invalidateQueries({ queryKey: ["wf-approval"] });
    qc.invalidateQueries({ queryKey: ["wf-summary"] });
    qc.invalidateQueries({ queryKey: ["shell-counts"] });
  };
}

export function ApprovalsView() {
  const { isAdmin, money, can } = useSession();
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const [scope, setScope] = useState<"waiting" | "mine" | "all">("waiting");
  const [kind, setKind] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["wf-approvals", scope, kind],
    queryFn: () => api.get<ApprovalRow[]>(`/api/workflows/approvals${qs({ scope, kind })}`),
  });
  const select = (id: string | null, replace = false) => {
    const p = new URLSearchParams(params);
    if (id) p.set("id", id); else p.delete("id");
    setParams(p, { replace: replace || !id });
  };
  // Auto-open the first item on wide screens.
  useEffect(() => {
    if (!selected && data?.length && window.matchMedia("(min-width: 901px)").matches) select(data[0]!.id, true);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`wf-approvals ${selected ? "has-selection" : ""}`}>
      <div className="wf-ap-list">
        <div className="toolbar">
          <Select className="chip-select" aria-label="Show" value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); select(null); }}>
            <option value="waiting">Waiting for me</option>
            <option value="mine">Requested by me</option>
            {isAdmin && <option value="all">All requests</option>}
          </Select>
          <Select className="chip-select" aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Type: All</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <span className="grow" />
          {isAdmin && <button className="link" onClick={() => setShowRules(true)}>Approval rules</button>}
          {can("workflows", "edit") && <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setShowNew(true)}>New request</Button>}
        </div>
        {isLoading ? <Loading /> : error ? (
          <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load approvals."}</Notice>
        ) : !data?.length ? (
          <div className="wf-card">
            <EmptyState title={scope === "waiting" ? "Nothing waiting for you" : scope === "mine" ? "You haven't asked for anything yet" : "No requests yet"} icon={<Check size={24} />}
              action={scope === "mine" && can("workflows", "edit") ? <Button icon={<Plus size={16} />} onClick={() => setShowNew(true)}>New request</Button> : undefined}>
              {scope === "waiting" ? "When someone needs your sign-off, it shows up here." : "Purchases, documents and other requests appear here."}
            </EmptyState>
          </div>
        ) : (
          <div className="wf-card">
            {data.map((a) => (
              <button key={a.id} className={`wf-ap-row ${selected === a.id ? "on" : ""}`} onClick={() => select(a.id)}>
                <Avatar name={a.requester.name} size={36} />
                <span className="wf-ap-main">
                  <b>{a.title}</b>
                  <small>
                    {a.requester.name}
                    {a.amount != null && ` · ${money(a.amount)}`}
                    {` · ${timeAgo(a.createdAt)}`}
                    {scope !== "waiting" && a.status === "pending" && a.currentApprover && ` · with ${first(a.currentApprover.name)}`}
                  </small>
                </span>
                <span className="wf-ap-pills">
                  {a.status !== "pending" && <Pill tone={a.status === "approved" ? "ok" : "red"}>{a.status === "approved" ? "Approved" : "Declined"}</Pill>}
                  <Pill tone={KIND_TONE[a.kind] ?? "grey"}>{KIND_LABEL[a.kind] ?? a.kind}</Pill>
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="wf-footnote">Approvals come from every workspace. Leave goes to the person's manager; purchases follow the rules set by your admins.</p>
      </div>
      <div className="wf-ap-detail">
        {selected ? <ApprovalDetailCard id={selected} onBack={() => select(null)} /> : (
          <Card className="hide-sm"><EmptyState title="Choose a request">Pick one from the list to see the details and decide.</EmptyState></Card>
        )}
      </div>
      <NewRequestModal open={showNew} onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setScope("mine"); select(id); }} />
      {isAdmin && <RulesModal open={showRules} onClose={() => setShowRules(false)} />}
    </div>
  );
}

function stepText(s: Step, all: Step[]) {
  if (s.status === "approved") return `Approved${s.decidedAt ? ` · ${fmtDate(s.decidedAt, { day: "numeric", month: "short" })}, ${fmtTime(s.decidedAt)}` : ""}`;
  if (s.status === "declined") return `Declined${s.decidedAt ? ` · ${fmtDate(s.decidedAt, { day: "numeric", month: "short" })}, ${fmtTime(s.decidedAt)}` : ""}`;
  if (s.status === "skipped") return "Not needed";
  if (s.status === "pending") return s.isMe ? "Waiting for your decision" : `Waiting for ${first(s.approver.name)}`;
  const prev = all.filter((x) => x.position < s.position).length;
  return prev ? "Next, after the step above" : "Waiting";
}

function ApprovalDetailCard({ id, onBack }: { id: string; onBack: () => void }) {
  const { money } = useSession();
  const toast = useToast();
  const refresh = useRefreshApprovals();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const { data: a, isLoading, error } = useQuery({ queryKey: ["wf-approval", id], queryFn: () => api.get<ApprovalDetail>(`/api/workflows/approvals/${id}`) });
  useEffect(() => setComment(""), [id]);
  if (isLoading) return <Card><Loading /></Card>;
  if (error || !a) return <Card><Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load this request."}</Notice><Button variant="secondary" onClick={onBack}>Back</Button></Card>;
  const current = a.steps.find((s) => s.status === "pending");
  const next = current ? a.steps.find((s) => s.position > current.position && s.status === "waiting") : undefined;

  async function decide(decision: "approve" | "decline") {
    setBusy(decision);
    try {
      const r = await api.post<{ status: string }>(`/api/workflows/approvals/${id}/decide`, { decision, comment: comment.trim() || null });
      toast(decision === "decline" ? "Request declined" : r.status === "approved" ? "Request approved" : `Approved and sent to ${next ? (next.label ?? first(next.approver.name)) : "the next approver"}`);
      setComment("");
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save your decision.", "error");
    } finally { setBusy(null); }
  }

  return (
    <Card className="wf-ap-card">
      <button className="back-link btn-ghost wf-ap-back" onClick={onBack}><ChevronLeft size={16} />All requests</button>
      <div className="row" style={{ gap: 8 }}>
        <Pill tone={KIND_TONE[a.kind] ?? "grey"}>{KIND_LABEL[a.kind] ?? a.kind} request</Pill>
        {a.status !== "pending" && <Pill tone={a.status === "approved" ? "ok" : "red"}>{a.status === "approved" ? "Approved" : "Declined"}</Pill>}
      </div>
      <h3 className="wf-ap-title">{a.title}</h3>
      <p className="muted wf-ap-sub">Requested by {a.requester.name}{a.requester.jobTitle ? ` · ${a.requester.jobTitle}` : ""} · {timeAgo(a.createdAt)}</p>
      {a.amount != null && <p className="wf-ap-amount">{money(a.amount)}</p>}
      {a.details && <p className="wf-ap-details">{a.details}</p>}
      {!!a.files.length && (
        <div className="wf-files" style={{ marginTop: 12 }}>
          {a.files.map((f) => <span className="wf-file" key={f.id}><a href={fileUrl(f.id)} target="_blank" rel="noreferrer"><FileText size={15} />{f.name}</a></span>)}
        </div>
      )}
      <h4 className="section-label wf-sec">Approval steps</h4>
      <ol className="wf-steps">
        <li className="done">
          <span className="wf-step-dot ok"><Check size={13} strokeWidth={3} /></span>
          <div><b>Requested by {a.requester.name}</b><small>{fmtDate(a.createdAt, { day: "numeric", month: "short" })}, {fmtTime(a.createdAt)}</small></div>
        </li>
        {a.steps.map((s) => (
          <li key={s.id} className={s.status}>
            <span className={`wf-step-dot ${s.status === "approved" ? "ok" : s.status === "declined" ? "bad" : s.status === "pending" ? "now" : ""}`}>
              {s.status === "approved" ? <Check size={13} strokeWidth={3} /> : s.status === "declined" ? <X size={13} strokeWidth={3} /> : initialsOf(s.approver.name)}
            </span>
            <div>
              <b>{s.isMe ? "You" : s.approver.name}{s.label ? ` · ${s.label}` : ""}</b>
              <small>{stepText(s, a.steps)}</small>
              {s.comment && <q className="wf-step-comment">{s.comment}</q>}
            </div>
          </li>
        ))}
      </ol>
      {a.canDecide && (
        <div className="wf-decide">
          <Textarea label="Comment" optional rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={`Add a note for ${first(a.requester.name)}`} />
          <div className="wf-decide-btns">
            <Button variant="secondary" loading={busy === "decline"} disabled={!!busy} onClick={() => decide("decline")}>Decline</Button>
            <Button loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>
              {next ? `Approve and send to ${next.label ?? first(next.approver.name)}` : "Approve"}
            </Button>
          </div>
          {current && !current.isMe && <p className="muted wf-small">You're deciding as an admin on behalf of {current.approver.name}.</p>}
        </div>
      )}
    </Card>
  );
}

const initialsOf = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

function NewRequestModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { org } = useSession();
  const refresh = useRefreshApprovals();
  const toast = useToast();
  const init = { kind: "purchase", title: "", amount: "", details: "" };
  const form = useForm(init);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { form.setValues(init); setFile(null); form.setErrors({}); form.setFormError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => form.submit(async (v) => {
    const r = await api.post<ApprovalRow>("/api/workflows/approvals", {
      kind: v.kind, title: v.title, details: v.details || null, amount: v.amount === "" ? null : Number(v.amount.replace(/,/g, "")),
    });
    if (file) {
      try { await api.upload("/api/files", file, { kind: "system", linkType: "approval", linkId: r.id }); }
      catch (e) { toast(e instanceof ApiError ? `Request sent, but the file wasn't attached: ${e.message}` : "Request sent, but the file wasn't attached.", "error"); }
    }
    refresh();
    toast(`Sent to ${r.currentApprover?.name ?? "an approver"}`);
    onCreated(r.id);
  });
  return (
    <Modal open={open} onClose={onClose} title="New request" subtitle="It goes to your manager first, then anyone your admins' rules add."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.busy} onClick={save}>Send request</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Select label="Type" value={form.values.kind} onChange={(e) => form.set("kind", e.target.value)}
          options={[{ value: "purchase", label: "Purchase" }, { value: "document", label: "Document sign-off" }, { value: "other", label: "Something else" }]} />
        <Input label="What's it for?" autoFocus placeholder="e.g. Delivery van tyres" {...form.bind("title")} />
        <Input label={`Amount (${org.currency})`} optional={form.values.kind !== "purchase"} inputMode="decimal" placeholder="0" {...form.bind("amount")} />
        <Textarea label="Details" optional rows={3} placeholder="Why it's needed, quotes compared…" {...form.bind("details")} />
        <div className="field">
          <span className="field-label"><span>Attachment</span><span className="opt">Optional</span></span>
          <input ref={fileRef} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file ? (
            <span className="wf-file"><span className="row" style={{ gap: 6 }}><FileText size={15} />{file.name}</span>
              <button type="button" className="wf-file-x" aria-label="Remove attachment" onClick={() => setFile(null)}><X size={13} /></button></span>
          ) : <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={() => fileRef.current?.click()}>Attach a quote or document</Button>}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function RulesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { money, org } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: members } = useMembers();
  const { data: rules, isLoading, error } = useQuery({ queryKey: ["wf-rules"], queryFn: () => api.get<Rule[]>("/api/workflows/approval-rules"), enabled: open });
  const form = useForm({ kind: "purchase", minAmount: "", approverUserId: "", label: "" });
  const add = () => form.submit(async (v) => {
    await api.post("/api/workflows/approval-rules", {
      kind: v.kind, minAmount: v.minAmount === "" ? null : Number(v.minAmount.replace(/,/g, "")), approverUserId: v.approverUserId,
      label: v.label || null, position: (rules?.filter((r) => r.kind === v.kind).length ?? 0) + 1,
    });
    form.setValues({ kind: v.kind, minAmount: "", approverUserId: "", label: "" });
    qc.invalidateQueries({ queryKey: ["wf-rules"] });
    toast("Rule added");
  });
  const { confirm, dialog } = useConfirm();
  async function remove(r: Rule) {
    if (!(await confirm({ title: "Remove this rule?", message: "New requests won't need this approval any more. Requests already waiting aren't affected.", confirmLabel: "Remove rule" }))) return;
    try { await api.del(`/api/workflows/approval-rules/${r.id}`); qc.invalidateQueries({ queryKey: ["wf-rules"] }); toast("Rule removed"); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't remove the rule.", "error"); }
  }
  return (
    <>
    {dialog}
    <Modal open={open} onClose={onClose} size="lg" title="Approval rules" subtitle="After the requester's manager, these people also approve. New rules apply to new requests.">
      {isLoading ? <Loading /> : error ? <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load the rules."}</Notice> : (
        <div className="wf-rules">
          {!rules?.length && <p className="muted">No rules yet. Requests only need the manager's approval.</p>}
          {rules?.map((r) => (
            <div key={r.id} className="wf-rule">
              <Settings2 size={16} className="muted" />
              <span className="grow">
                <b>{KIND_LABEL[r.kind] ?? r.kind}{r.minAmount != null ? ` over ${money(r.minAmount)}` : ""}</b>
                <small>Also needs {r.approver.name}{r.label ? ` (${r.label})` : ""}</small>
              </span>
              <button className="icon-btn" aria-label="Remove rule" onClick={() => remove(r)}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      )}
      <h4 className="section-label wf-sec">Add a rule</h4>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Select label="For" value={form.values.kind} onChange={(e) => form.set("kind", e.target.value)}
          options={[{ value: "purchase", label: "Purchases" }, { value: "document", label: "Documents" }, { value: "offer", label: "Job offers" }, { value: "other", label: "Other requests" }]} />
        <Input label={`Over amount (${org.currency})`} optional inputMode="decimal" placeholder="Any amount" {...form.bind("minAmount")} />
        <Select label="Also approved by" placeholder="Choose someone" value={form.values.approverUserId} onChange={(e) => form.set("approverUserId", e.target.value)}
          error={form.errors.approverUserId} options={members?.map((m) => ({ value: m.id, label: m.name })) ?? []} />
        <Input label="Shown as" optional placeholder="e.g. Finance" {...form.bind("label")} />
        <div className="span-2"><Button type="submit" loading={form.busy} icon={<Plus size={16} />}>Add rule</Button></div>
      </form>
    </Modal>
    </>
  );
}
