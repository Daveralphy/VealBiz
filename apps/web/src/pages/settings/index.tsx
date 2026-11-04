import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, Lock, MoreHorizontal, Pause, Pencil, Plus, Shield, Trash2, UserCog, X } from "lucide-react";
import {
  Avatar, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, Modal, Notice, PageHeader, Pill, Progress,
  SearchInput, Segmented, Select, Switch, useToast,
} from "@windveal/ui";
import {
  ACCESS_LEVELS, SPECIAL_PERMISSIONS, WORKSPACES, WORKSPACE_LABELS, formatBytes, formatMoney,
} from "@windveal/shared";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { DashBars, DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { CONTACT_EMAIL } from "../../lib/config";
import { monthlyPrice, usePricing, yearlyTotal, type PricingPlan } from "../../lib/pricing";
import { fmtDate, timeAgo } from "../../lib/format";

// ---------------- Dashboard ----------------
const ROLE_NAMES: Record<string, string> = { admin: "Admins", manager: "Managers", member: "Members" };

function SettingsDashboard() {
  const { isAdmin } = useSession();
  const membersQ = useQuery({ queryKey: ["members"], queryFn: () => api.get<any[]>("/api/members") });
  const invitesQ = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<any[]>("/api/invitations"), enabled: isAdmin });
  const auditQ = useQuery({ queryKey: ["audit", "dashboard"], queryFn: () => api.get<{ items: any[] }>("/api/audit?days=30"), enabled: isAdmin });
  const members = membersQ.data ?? [];
  const active = members.filter((m) => m.status === "active");
  const monthAgo = Date.now() - 30 * 86_400_000;
  const joined = members.filter((m) => m.joinedAt && Date.parse(m.joinedAt) > monthAgo).length;
  const waiting = (invitesQ.data ?? []).filter((i) => !i.expired);
  const newest = [...members].sort((a, b) => Date.parse(b.joinedAt ?? 0) - Date.parse(a.joinedAt ?? 0)).slice(0, 5);
  const byRole = ["admin", "manager", "member"].map((r) => ({ label: ROLE_NAMES[r]!, value: active.filter((m) => m.role === r).length }));
  return (
    <>
      <DashKpis loading={membersQ.isLoading} items={[
        { label: "Team", value: active.length, note: members.length > active.length ? `${members.length - active.length} suspended` : "all active", to: "/settings/members" },
        { label: "Joined in the last 30 days", value: joined, note: joined ? "welcome them in" : "no one new" },
        ...(isAdmin ? [
          { label: "Invitations waiting", value: waiting.length, note: waiting.length ? "not accepted yet" : "none waiting", to: "/settings/invitations" },
          { label: "Changes in the last 30 days", value: auditQ.data?.items.length ?? 0, note: "in the audit history", to: "/settings/audit" },
        ] : []),
      ]} />
      <DashColumns
        left={<>
          <DashCard title="Newest members" sub="Who joined most recently" link={{ to: "/settings/members", label: "Members" }} loading={membersQ.isLoading}>
            {newest.map((m) => (
              <DashRow key={m.id} lead={<Avatar name={m.name} size={34} />} title={m.name} detail={m.jobTitle || m.email}
                end={<small className="muted">{m.joinedAt ? timeAgo(m.joinedAt) : ""}</small>} />
            ))}
          </DashCard>
          {isAdmin && (
            <DashCard title="Recent changes" sub="From the audit history" link={{ to: "/settings/audit", label: "Audit history" }} loading={auditQ.isLoading}
              empty={!auditQ.isLoading && !(auditQ.data?.items.length) && "Nothing has changed in the last 30 days."}>
              {(auditQ.data?.items ?? []).slice(0, 5).map((e) => (
                <DashRow key={e.id} title={e.summary} detail={`${e.actor?.name ?? "WindVeal"} · ${timeAgo(e.createdAt)}`} />
              ))}
            </DashCard>
          )}
        </>}
        right={<>
          <DashCard title="People by role" sub="Active members">
            <DashBars rows={byRole} />
          </DashCard>
          {isAdmin && (
            <DashCard title="Waiting to join" sub="Invited but not accepted yet" link={{ to: "/settings/invitations", label: "Invitations" }} loading={invitesQ.isLoading}
              empty={!invitesQ.isLoading && !waiting.length && "Everyone you invited has joined."}>
              {waiting.slice(0, 5).map((i) => (
                <DashRow key={i.id} title={i.email} detail={`Invited by ${i.invitedBy} · ${timeAgo(i.createdAt)}`}
                  end={<Pill tone="grey">{i.role[0].toUpperCase() + i.role.slice(1)}</Pill>} />
              ))}
            </DashCard>
          )}
        </>}
      />
    </>
  );
}

// ---------------- Members ----------------
/** Members and Invitations are separate pages in the sidebar; they share the same actions and dialogs. */
function Members({ view }: { view: "members" | "invites" }) {
  const { isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "remove" | "suspend"; m: any } | null>(null);
  const [accessFor, setAccessFor] = useState<any | null>(null);
  const [roleFor, setRoleFor] = useState<any | null>(null);
  const membersQ = useQuery({ queryKey: ["members"], queryFn: () => api.get<any[]>("/api/members") });
  const invitesQ = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<any[]>("/api/invitations") });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["members"] }); qc.invalidateQueries({ queryKey: ["invitations"] }); qc.invalidateQueries({ queryKey: ["audit"] }); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); refresh(); toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : "Something went wrong", "error"); }
  };
  const members = (membersQ.data ?? []).filter((m) =>
    (!q || `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase())) && (!role || m.role === role) && (!status || m.status === status));
  return (
    <>
      <div className="toolbar">
        {view === "members" && <>
          <SearchInput value={q} onChange={setQ} placeholder="Search members" />
          <select className="select chip-select" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="">Role: All</option><option value="admin">Admin</option><option value="manager">Manager</option><option value="member">Member</option></select>
          <select className="select chip-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Status: All</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
        </>}
        <span className="grow" />
        {isAdmin && <Button icon={<Plus size={15} />} onClick={() => setInviteOpen(true)}>Invite people</Button>}
      </div>
      {view === "members" ? (
        membersQ.isLoading ? <Loading /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th className="hide-sm">Workspace access</th><th>Status</th><th className="hide-sm">Last active</th><th /></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td><div className="cell-main"><Avatar name={m.name} /><div style={{ minWidth: 0 }}><b>{m.name} {m.isYou && <Pill>You</Pill>}</b><small>{m.email}</small></div></div></td>
                    <td><span className="row muted" style={{ gap: 6 }}>{m.isPrimaryAdmin && <Lock size={13} />}{m.role[0].toUpperCase() + m.role.slice(1)}</span></td>
                    <td className="hide-sm"><div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                      {m.role === "admin" ? <Pill tone="grey">All workspaces</Pill> : WORKSPACES.filter((w) => m.access[w] !== "none").map((w) => <Pill key={w} tone="grey">{WORKSPACE_LABELS[w]}</Pill>)}
                    </div></td>
                    <td><Pill tone={m.status === "active" ? "ok" : "grey"}>{m.status === "active" ? "Active" : "Suspended"}</Pill></td>
                    <td className="hide-sm muted">{m.isYou ? "Now" : m.lastActiveAt ? timeAgo(m.lastActiveAt) : "Not yet"}</td>
                    <td style={{ width: 40 }}>{isAdmin && !m.isYou && (
                      <Menu trigger={(t) => <IconButton label={`Actions for ${m.name}`} onClick={t}><MoreHorizontal size={18} /></IconButton>}>
                        {(close) => <>
                          {!m.isPrimaryAdmin && <button onClick={() => { close(); setRoleFor(m); }}><UserCog size={16} />Change role</button>}
                          <button onClick={() => { close(); setAccessFor(m); }}><Shield size={16} />Edit workspace access</button>
                          <button onClick={() => { close(); act(() => api.post(`/api/members/${m.id}/password-reset`), `Reset link sent to ${m.email}`); }}><KeyRound size={16} />Send password reset</button>
                          <hr />
                          {m.status === "active"
                            ? <button disabled={m.isPrimaryAdmin} onClick={() => { close(); setConfirm({ kind: "suspend", m }); }}><Pause size={16} />Suspend access</button>
                            : <button onClick={() => { close(); act(() => api.patch(`/api/members/${m.id}`, { status: "active" }), `${m.name}'s access restored`); }}><Pause size={16} />Restore access</button>}
                          <button className="danger" disabled={m.isPrimaryAdmin} onClick={() => { close(); setConfirm({ kind: "remove", m }); }}><Trash2 size={16} />Remove from organisation</button>
                        </>}
                      </Menu>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {members.length === 0 && <EmptyState title="No members match">Try a different search or filter.</EmptyState>}
          </div>
        )
      ) : (
        invitesQ.isLoading ? <Loading /> : (invitesQ.data ?? []).length === 0 ? <Card><EmptyState title="No pending invitations" action={isAdmin && <Button onClick={() => setInviteOpen(true)}>Invite people</Button>} /></Card> : (
          <table className="table">
            <thead><tr><th>Email</th><th>Role</th><th className="hide-sm">Invited by</th><th>Expires</th><th /></tr></thead>
            <tbody>{(invitesQ.data ?? []).map((i) => (
              <tr key={i.id}><td><b className="ink">{i.email}</b></td><td>{i.role}</td><td className="hide-sm">{i.invitedBy}</td>
                <td>{i.expired ? <Pill tone="red">Expired</Pill> : fmtDate(i.expiresAt)}</td>
                <td>{isAdmin && <div className="row" style={{ justifyContent: "flex-end" }}>
                  <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/api/invitations/${i.id}/resend`), "Invitation sent again")}>Resend</Button>
                  <IconButton label="Cancel invitation" onClick={() => act(() => api.del(`/api/invitations/${i.id}`), "Invitation cancelled")}><X size={16} /></IconButton>
                </div>}</td></tr>
            ))}</tbody>
          </table>
        )
      )}
      {isAdmin && <p className="muted row" style={{ marginTop: 14, fontSize: 13 }}><Lock size={15} />The primary admin can't be demoted or removed. Transfer primary admin in Organisation first.</p>}
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} onDone={refresh} />
      {accessFor && <AccessModal member={accessFor} onClose={() => setAccessFor(null)} onSaved={refresh} />}
      {roleFor && <RoleModal member={roleFor} onClose={() => setRoleFor(null)} onSave={(role) => act(async () => { await api.patch(`/api/members/${roleFor.id}`, { role }); setRoleFor(null); }, `${roleFor.name} is now ${role === "admin" ? "an admin" : `a ${role}`}`)} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} danger
        title={confirm?.kind === "remove" ? `Remove ${confirm?.m.name}?` : `Suspend ${confirm?.m.name}?`}
        confirmLabel={confirm?.kind === "remove" ? "Remove" : "Suspend access"}
        onConfirm={() => {
          const c = confirm!; setConfirm(null);
          act(() => c.kind === "remove" ? api.del(`/api/members/${c.m.id}`) : api.patch(`/api/members/${c.m.id}`, { status: "suspended" }),
            c.kind === "remove" ? `${c.m.name} was removed` : `${c.m.name} was suspended and signed out`);
        }}>
        {confirm?.kind === "remove" ? "They'll lose access straight away and be signed out on every device. Their work stays in WindVeal." : "They'll be signed out on every device until you restore their access."}
      </ConfirmDialog>
    </>
  );
}

function InviteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState([{ email: "", role: "member" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ results: { email: string; status: string }[] }>("/api/invitations", { invites: rows.filter((x) => x.email.trim()) });
      const sent = r.results.filter((x) => x.status === "sent").length;
      const skipped = r.results.filter((x) => x.status !== "sent");
      toast(`${sent} invitation${sent === 1 ? "" : "s"} sent${skipped.length ? `, ${skipped.length} skipped (already a member or invited)` : ""}`);
      setRows([{ email: "", role: "member" }]); onDone(); onClose();
    } catch (e) { setErr(e instanceof ApiError ? (e.details ? "Check the email addresses." : e.message) : "Something went wrong"); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Invite people" subtitle="They'll get an email to join. Invitations expire after 7 days."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={send}>Send invites</Button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="stack" style={{ gap: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr) 36px", gap: 8 }}>
            <Input type="email" placeholder="colleague@email.com" aria-label="Email" value={r.email} onChange={(e) => setRows(rows.map((x, k) => k === i ? { ...x, email: e.target.value } : x))} />
            <Select aria-label="Role" value={r.role} onChange={(e) => setRows(rows.map((x, k) => k === i ? { ...x, role: e.target.value } : x))} options={[{ value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "member", label: "Member" }]} />
            <IconButton label="Remove" onClick={() => setRows(rows.length > 1 ? rows.filter((_, k) => k !== i) : rows)}><X size={16} /></IconButton>
          </div>
        ))}
      </div>
      <button className="link row" style={{ marginTop: 12 }} onClick={() => setRows([...rows, { email: "", role: "member" }])}><Plus size={15} />Add another</button>
    </Modal>
  );
}

function RoleModal({ member, onClose, onSave }: { member: any; onClose: () => void; onSave: (role: string) => void }) {
  const [role, setRole] = useState<string>(member.role);
  return (
    <Modal open onClose={onClose} title={`Change ${member.name}'s role`} subtitle="Their workspace access follows the new role's defaults."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={role === member.role} onClick={() => onSave(role)}>Save role</Button></>}>
      <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}
        options={[{ value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "member", label: "Member" }]} />
    </Modal>
  );
}

function AccessModal({ member, onClose, onSaved }: { member: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [access, setAccess] = useState<Record<string, string>>({ ...member.access });
  return (
    <Modal open onClose={onClose} title={`Workspace access: ${member.name}`} subtitle={member.role === "admin" ? "Admins always have full access." : "Overrides the defaults for their role."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={member.role === "admin"} onClick={async () => {
        try { await api.patch(`/api/members/${member.id}`, { workspaceAccess: access }); onSaved(); onClose(); toast("Access updated"); }
        catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save", "error"); }
      }}>Save</Button></>}>
      <AccessMatrix value={access} onChange={setAccess} disabled={member.role === "admin"} />
    </Modal>
  );
}

const LEVEL_LABEL: Record<string, string> = { none: "None", view: "View", edit: "Edit", manage: "Manage" };
function AccessMatrix({ value, onChange, disabled, readOnly }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; disabled?: boolean; readOnly?: boolean }) {
  if (readOnly) {
    return (
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Workspace</th><th>Access</th></tr></thead>
          <tbody>{WORKSPACES.map((w) => (
            <tr key={w}><td className="ink" style={{ fontWeight: 500 }}>{WORKSPACE_LABELS[w]}</td>
              <td><Pill tone={value[w] === "none" ? "grey" : value[w] === "manage" ? "violet" : "blue"}>{LEVEL_LABEL[value[w] ?? "none"]}</Pill></td></tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Workspace</th>{ACCESS_LEVELS.map((l) => <th key={l} style={{ textAlign: "center" }}>{LEVEL_LABEL[l]}</th>)}</tr></thead>
        <tbody>{WORKSPACES.map((w) => (
          <tr key={w}><td className="ink" style={{ fontWeight: 500 }}>{WORKSPACE_LABELS[w]}</td>
            {ACCESS_LEVELS.map((l) => <td key={l} style={{ textAlign: "center" }}>
              <input type="radio" name={`acc-${w}`} aria-label={`${WORKSPACE_LABELS[w]}: ${LEVEL_LABEL[l]}`} disabled={disabled} checked={value[w] === l} onChange={() => onChange({ ...value, [w]: l })} style={{ width: 18, height: 18, accentColor: "var(--blue)" }} />
            </td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ---------------- Roles ----------------
const SPECIAL_LABELS: Record<string, [string, string]> = {
  approve_leave: ["Approve leave for their team", "Leave requests from people they manage."],
  see_pay: ["See salaries and pay details", "Sensitive People & HR information."],
  export_data: ["Export data", "Download reports and lists to Excel or CSV."],
  manage_billing: ["Manage billing", "Change plan and payment details."],
};
function Roles() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["roles"], queryFn: () => api.get("/api/roles") });
  const [sel, setSel] = useState("manager");
  const [access, setAccess] = useState<Record<string, string>>({});
  const [special, setSpecial] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const role = q.data?.roles.find((r: any) => r.key === sel);
  const reset = () => { if (role) { setAccess({ ...role.access }); setSpecial([...role.special]); } };
  useEffect(() => { reset(); setEditing(false); }, [role?.key, q.data]);
  if (!q.data) return <Loading />;
  const label = (k: string) => k[0]!.toUpperCase() + k.slice(1);
  const desc: Record<string, string> = { admin: "Full access to everything", manager: "Runs a team's work", member: "Works in assigned workspaces" };
  return (
    <div className="grid-side side-left-260">
      <Card flush className="">
        <div style={{ padding: 8 }}>
          {q.data.roles.map((r: any) => (
            <button key={r.key} onClick={() => setSel(r.key)} className="between" style={{ width: "100%", padding: "12px 14px", borderRadius: 11, border: 0, cursor: "pointer", background: sel === r.key ? "var(--pale)" : "transparent", textAlign: "left" }}>
              <span><b className="ink" style={{ display: "block" }}>{label(r.key)}</b><small className="muted">{desc[r.key]}</small></span><Pill tone="grey">{r.count}</Pill>
            </button>
          ))}
          <div className="between" style={{ padding: "12px 14px", borderTop: "1px solid var(--line)", marginTop: 6, color: "var(--muted)", fontSize: 14 }}>
            <span className="row" style={{ gap: 6 }}><Plus size={15} />Create custom role</span><Pill tone="blue">Growth</Pill>
          </div>
        </div>
      </Card>
      <div>
        <Card title={label(sel)} subtitle={sel === "admin" ? "Admins can see and do everything. This role can't be changed." : `What ${sel}s can see and do in each workspace. ${role?.count ?? 0} people have this role.`}
          actions={role?.editable && !editing && <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button>}>
          <AccessMatrix value={access} onChange={setAccess} readOnly={!editing} />
        </Card>
        <Card title="Special permissions" subtitle="Extra abilities on top of workspace access.">
          {SPECIAL_PERMISSIONS.map((p) => (
            <div key={p} className="list-row" style={{ justifyContent: "space-between" }}>
              <div><b className="ink" style={{ display: "block" }}>{SPECIAL_LABELS[p]![0]}</b><small className="muted">{SPECIAL_LABELS[p]![1]}</small></div>
              {editing
                ? <Switch label={SPECIAL_LABELS[p]![0]} checked={special.includes(p)} onChange={(v) => setSpecial(v ? [...special, p] : special.filter((x) => x !== p))} />
                : <Pill tone={special.includes(p) ? "ok" : "grey"}>{special.includes(p) ? "Allowed" : "Not allowed"}</Pill>}
            </div>
          ))}
          {editing && <div className="row" style={{ justifyContent: "flex-end", borderTop: "1px solid var(--line)", paddingTop: 16, marginTop: 8 }}>
            <Button variant="secondary" onClick={() => { reset(); setEditing(false); }}>Cancel</Button>
            <Button loading={saving} onClick={async () => {
              setSaving(true);
              try { await api.put(`/api/roles/${sel}`, { access, special }); await qc.invalidateQueries(); toast("Role saved"); setEditing(false); }
              catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save", "error"); }
              finally { setSaving(false); }
            }}>Save changes</Button>
          </div>}
        </Card>
      </div>
    </div>
  );
}

// ---------------- Billing (its own page: account menu → Plan and billing) ----------------
export function BillingPage() {
  useEffect(() => { document.title = "Plan and billing · WindVeal"; }, []);
  return (
    <>
      <PageHeader title="Plan and billing" subtitle="Your plan, storage and payment details." />
      <Billing />
    </>
  );
}

function Billing() {
  const { org, hasSpecial } = useSession();
  const storage = useQuery({ queryKey: ["storage"], queryFn: () => api.get("/api/storage") });
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<any[]>("/api/members") });
  const pricing = usePricing();
  const [billing, setBilling] = useState<"monthly" | "yearly">("yearly");
  const [upgrade, setUpgrade] = useState<string | null>(null);
  if (!pricing.data) return <Loading />;
  const plans = pricing.data.plans;
  const current = plans.find((p) => p.key === org.plan) ?? plans[0]!;
  const enterprise = plans.find((p) => p.custom);
  // Upgrades = plans listed after the current one that have a price.
  const upgrades = plans.slice(plans.indexOf(current) + 1).filter((p) => !p.custom);
  const perMonth = (p: PricingPlan) => {
    const { amount, currency } = monthlyPrice(pricing.data!, p, org.currency);
    return formatMoney(billing === "yearly" ? yearlyTotal(pricing.data!, amount) / 12 : amount, currency);
  };
  return (
    <>
      <Card>
        <div className="grid-2">
          <div>
            <p className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Current plan</p>
            <p style={{ fontFamily: "var(--display)", fontSize: 28, fontWeight: 800, color: "var(--ink)" }}>{current.name} <span className="muted" style={{ fontSize: 14, fontWeight: 500, fontFamily: "var(--font)" }}>{current.custom ? "Custom pricing" : `${perMonth(current)} per month`}</span></p>
            <p style={{ margin: "6px 0 14px" }}>{current.description}</p>
          </div>
          <div className="stack" style={{ gap: 14 }}>
            <div><div className="between" style={{ fontSize: 13.5, marginBottom: 6 }}><span>Storage</span><b className="ink">{storage.data ? `${formatBytes(storage.data.used)} of ${formatBytes(storage.data.limit)}` : "…"}</b></div><Progress value={storage.data ? (storage.data.used / storage.data.limit) * 100 : 0} /></div>
            <div className="between" style={{ fontSize: 13.5 }}><span>WindVeal AI requests this month</span><b className="ink">{current.aiRequestsPerMonth ? `0 of ${current.aiRequestsPerMonth.toLocaleString("en-GB")}` : "Not included"}</b></div>
            <div className="between" style={{ fontSize: 13.5 }}><span>Team members</span><b className="ink">{members.data?.length ?? "…"} · no limit</b></div>
          </div>
        </div>
      </Card>
      {(upgrades.length > 0 || (enterprise && !current.custom)) && (
        <Card title="Upgrade for more space and AI" subtitle={`Prices in ${org.currency}. Switch any time.`} actions={upgrades.length > 0 && <Segmented value={billing} onChange={setBilling} options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]} />}>
          {upgrades.length > 0 && <div className="grid-2">
            {upgrades.map((p) => (
              <div key={p.key} style={{ border: `1.5px solid ${p.popular ? "var(--blue)" : "var(--line)"}`, borderRadius: 16, padding: 20 }}>
                <div className="between"><h4 style={{ fontSize: 17 }}>{p.name}</h4>{p.popular && <Pill>Popular</Pill>}</div>
                <p style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 800, color: "var(--ink)", margin: "6px 0 2px" }}>{perMonth(p)} <small className="muted" style={{ fontSize: 13, fontFamily: "var(--font)", fontWeight: 500 }}>per month{billing === "yearly" ? ", billed yearly" : ""}</small></p>
                <ul style={{ paddingLeft: 18, margin: "12px 0 16px", fontSize: 13.5 }}>{p.features.slice(1, 4).map((f) => <li key={f}>{f}</li>)}</ul>
                <Button block variant={p.popular ? "primary" : "secondary"} disabled={!hasSpecial("manage_billing")} onClick={() => setUpgrade(p.key)}>Upgrade to {p.name}</Button>
              </div>
            ))}
          </div>}
          {enterprise && !current.custom && <div className="ent-row" style={{ marginTop: 14 }}><div><b className="ink" style={{ fontFamily: "var(--display)", fontSize: 16, display: "block" }}>{enterprise.name}</b>{enterprise.description}</div><a className="btn btn-secondary" href={`mailto:${CONTACT_EMAIL}`}>Talk to us</a></div>}
        </Card>
      )}
      <div className="grid-2">
        <Card title="Payment method" subtitle="Added when you upgrade."><EmptyState title="No payment method">{org.plan === "free" ? "You're on the Free plan." : org.plan === "enterprise" ? "Billed by agreement with WindVeal." : ""}</EmptyState></Card>
        <Card title="Invoices" subtitle="Download receipts for your records."><EmptyState title="No invoices yet">Invoices will appear here after you upgrade.</EmptyState></Card>
      </div>
      <Modal open={!!upgrade} onClose={() => setUpgrade(null)} title="Online payments are coming soon" footer={<Button onClick={() => setUpgrade(null)}>OK</Button>}>
        <p>Card and bank payments for {org.currency} will be added before launch. To upgrade now, email <a className="link" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we'll set it up for you.</p>
      </Modal>
    </>
  );
}

// ---------------- Audit ----------------
function Audit() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [days, setDays] = useState("30");
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<any[]>("/api/members") });
  const [actor, setActor] = useState("");
  const params = new URLSearchParams({ days, ...(q ? { q } : {}), ...(category ? { category } : {}), ...(actor ? { actor } : {}) });
  const audit = useQuery({ queryKey: ["audit", params.toString()], queryFn: () => api.get<{ items: any[] }>(`/api/audit?${params}`) });
  const items = audit.data?.items ?? [];
  const groups = new Map<string, any[]>();
  for (const i of items) {
    const d = new Date(i.createdAt); const today = new Date();
    const key = d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === new Date(Date.now() - 86_400_000).toDateString() ? "Yesterday" : fmtDate(d);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const chip: Record<string, [string, "red" | "warn" | "blue"]> = { access: ["Access", "red"], sync: ["Sync", "warn"], settings: ["Settings", "blue"] };
  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search activity" />
        <select className="select chip-select" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Person"><option value="">Person: All</option>{(members.data ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>
        <select className="select chip-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Type"><option value="">Type: All</option><option value="access">Access</option><option value="data">Data</option><option value="settings">Settings</option></select>
        <select className="select chip-select" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Range"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select>
        <span className="grow" />
        <a className="btn btn-secondary" href={`/api/audit?${params}&format=csv`}><Download size={15} />Export</a>
      </div>
      {audit.isLoading ? <Loading /> : items.length === 0 ? <Card><EmptyState title="No activity in this period" /></Card> : [...groups.entries()].map(([day, rows]) => (
        <div key={day}>
          <p className="section-label" style={{ margin: "16px 0 8px" }}>{day}</p>
          <div className="card card-flush">
            {rows.map((i) => (
              <div key={i.id} className="list-row" style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
                <span className="muted hide-sm" style={{ width: 48, fontSize: 12.5 }}>{new Date(i.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                <Avatar name={i.actor?.name ?? "?"} size={30} />
                <span style={{ flex: 1, minWidth: 0 }}>{i.summary}{chip[i.category] && <Pill tone={chip[i.category]![1]} className="" >{chip[i.category]![0]}</Pill>}</span>
                <span className="muted hide-sm" style={{ fontSize: 12.5 }}>{i.device ?? ""}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="muted row" style={{ marginTop: 14, fontSize: 13 }}><Lock size={15} />Audit history can't be edited or deleted.</p>
    </>
  );
}

export function SettingsRoutes() {
  const { org, isAdmin } = useSession();
  useEffect(() => { document.title = "Settings · WindVeal"; }, []);
  return (
    <>
      <PageHeader title="Settings" subtitle={`Manage ${org.name}'s team and permissions. Your details and the company's are in Profile.`} />
      <Routes>
        <Route index element={<SettingsDashboard />} />
        <Route path="members" element={<Members view="members" />} />
        <Route path="invitations" element={isAdmin ? <Members view="invites" /> : <Navigate to="/settings" replace />} />
        <Route path="roles" element={isAdmin ? <Roles /> : <Navigate to="/settings" replace />} />
        <Route path="billing" element={<Navigate to="/billing" replace />} />
        <Route path="audit" element={isAdmin ? <Audit /> : <Navigate to="/settings" replace />} />
        <Route path="profile" element={<Navigate to="/profile" replace />} />
        <Route path="*" element={<Navigate to="/settings" replace />} />
      </Routes>
    </>
  );
}
