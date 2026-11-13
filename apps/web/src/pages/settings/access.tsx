import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, KeyRound, Lock, Pause, Pencil, Plus, Trash2, X, Copy } from "lucide-react";
import {
  Avatar, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, Loading, Modal, Pill, Segmented, Select, Switch, useToast,
} from "@windveal/ui";
import { ACCESS_LEVELS, SPECIAL_LABELS, SPECIAL_PERMISSIONS, WORKSPACES, WORKSPACE_LABELS, type AccessLevel, type SpecialPermission, type Workspace } from "@windveal/shared";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { MoreMenu } from "../../components/actions";

const LEVEL: Record<AccessLevel, { label: string; tone: "grey" | "blue" | "violet" | "ok" }> = {
  none: { label: "No access", tone: "grey" }, view: { label: "View", tone: "blue" }, edit: { label: "Edit", tone: "violet" }, manage: { label: "Manage", tone: "ok" },
};
const WS_WHAT: Record<Workspace, string> = {
  people: "Everyone's records with Manage; their own team's with View or Edit", recruitment: "Jobs, candidates and interviews", crm: "Leads, deals and companies",
  workflows: "Tasks, approvals and templates", documents: "Files and folders", insights: "Reports across the business",
};
const rank = (l: AccessLevel) => ACCESS_LEVELS.indexOf(l);
const first = (name: string) => name.split(" ")[0];

type Role = { id: string; name: string; description: string | null; kind: "manager" | "custom" | "job"; access: Record<Workspace, AccessLevel>; special: string[]; opensMore: boolean; people: number; invited: number };
type Allowance = { used: number; limit: number | null };
const roleNote = (r: Role) => r.description || (r.kind === "manager" ? "Runs a team's work" : r.kind === "job" ? "Job title in People & HR" : "");

/** On Free, how many roles can open more than My Workspace (Admin doesn't count). */
function AllowanceNote({ a }: { a: Allowance }) {
  if (a.limit === null) return null;
  return <span className="ac-upsell"><Lock size={14} />Free plan: {a.used} of {a.limit} roles open more than My Workspace. <Link className="link" to="/billing">See plans</Link></span>;
}
type RoleOption = { id: string; name: string; description: string | null; access: Record<Workspace, AccessLevel> | null };

function useToastError() {
  const toast = useToast();
  return (e: unknown, fallback = "Something went wrong") => toast(e instanceof ApiError ? e.message : fallback, "error");
}

/** One workspace's level: a pill when reading, a choice when editing. */
function LevelRow({ ws, level, editing, onChange, tag, from }: { ws: Workspace; level: AccessLevel; editing: boolean; onChange?: (l: AccessLevel) => void; tag?: string; from?: string }) {
  return (
    <div className="ac-row">
      <div><b>{WORKSPACE_LABELS[ws]}{tag && <span className="ac-tag">{tag}</span>}</b>
        <small>{WS_WHAT[ws]}</small></div>
      <div className="ac-right">
        {editing
          ? <Segmented value={level} onChange={(v) => onChange?.(v as AccessLevel)} options={ACCESS_LEVELS.map((l) => ({ value: l, label: LEVEL[l].label }))} />
          : <Pill tone={LEVEL[level].tone}>{LEVEL[level].label}</Pill>}
        {from && <span className="ac-from">{from}</span>}
      </div>
    </div>
  );
}

function PermRow({ p, on, editing, onChange, disabled, tag, from }: { p: SpecialPermission; on: boolean; editing: boolean; onChange?: (v: boolean) => void; disabled?: boolean; tag?: string; from?: string }) {
  return (
    <div className="ac-row">
      <div><b>{SPECIAL_LABELS[p].name}{tag && <span className="ac-tag">{tag}</span>}</b><small>{SPECIAL_LABELS[p].what}</small></div>
      <div className="ac-right">
        {editing
          ? <Switch label={SPECIAL_LABELS[p].name} checked={on} disabled={disabled} onChange={(v) => onChange?.(v)} />
          : <Pill tone={on ? "ok" : "grey"}>{on ? "Allowed" : "Not allowed"}</Pill>}
        {from && <span className="ac-from">{from}</span>}
      </div>
    </div>
  );
}

function Chips({ access }: { access: Record<Workspace, AccessLevel> }) {
  const open = WORKSPACES.filter((w) => access[w] !== "none");
  if (!open.length) return <span className="muted">My Workspace only</span>;
  return <div className="ac-chips">{open.map((w) => <span key={w}>{WORKSPACE_LABELS[w]} <em>{LEVEL[access[w]].label.toLowerCase()}</em></span>)}</div>;
}

// ---------------- Roles list ----------------
export function RolesList() {
  const navigate = useNavigate();
  const toast = useToast();
  const fail = useToastError();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["roles"], queryFn: () => api.get<{ canCustomise: boolean; allowance: Allowance; admins: number; roles: Role[] }>("/api/roles") });
  const [deleting, setDeleting] = useState<Role | null>(null);
  if (!q.data) return <Loading />;
  const { allowance, roles, admins } = q.data;
  const duplicate = async (r: Role) => {
    try { const c = await api.post<{ role: Role }>(`/api/roles/${r.id}/duplicate`); await qc.invalidateQueries({ queryKey: ["roles"] }); navigate(`/settings/roles/${c.role.id}?edit=1`); }
    catch (e) { fail(e); }
  };
  return (
    <>
      <div className="toolbar">
        <p className="muted ac-lead">Every job title in People &amp; HR is a role here, and everyone starts with My Workspace. Give a role more, or add extra access for one person from their page.</p>
        <span className="grow" />
        <AllowanceNote a={allowance} />
        <Button icon={<Plus size={15} />} onClick={() => navigate("/settings/roles/new")}>New role</Button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Role</th><th>People</th><th className="hide-sm">What it can open</th><th /></tr></thead>
          <tbody>
            <tr>
              <td><div className="ac-role"><b><Lock size={13} />Admin</b><small>Everything, including settings and billing</small></div></td>
              <td>{admins}</td>
              <td className="hide-sm"><div className="ac-chips"><span>All workspaces</span></div></td>
              <td />
            </tr>
            {roles.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/settings/roles/${r.id}`)}>
                <td><div className="ac-role"><b>{r.name}</b><small>{roleNote(r)}</small></div></td>
                <td>{r.people}{r.invited ? <small className="muted"> · {r.invited} invited</small> : null}</td>
                <td className="hide-sm"><Chips access={r.access} /></td>
                <td style={{ width: 48 }} onClick={(e) => e.stopPropagation()}>
                  {r.kind !== "manager" && (
                    <MoreMenu label={`Actions for ${r.name}`} items={[
                      { label: "Duplicate", icon: <Copy size={16} />, onClick: () => duplicate(r) },
                      { label: "Delete role", icon: <Trash2 size={16} />, danger: true, onClick: () => setDeleting(r) },
                    ]} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger title={`Delete ${deleting?.name}?`} confirmLabel="Delete role"
        onConfirm={async () => {
          const r = deleting!; setDeleting(null);
          try { await api.del(`/api/roles/${r.id}`); await qc.invalidateQueries({ queryKey: ["roles"] }); toast(`${r.name} deleted`); } catch (e) { fail(e); }
        }}>
        People can't be left without a role, so a role that someone has can't be deleted.
      </ConfirmDialog>
    </>
  );
}

// ---------------- One role ----------------
const BLANK = Object.fromEntries(WORKSPACES.map((w) => [w, "none"])) as Record<Workspace, AccessLevel>;

/** Each role (and "new") gets a fresh page, so moving between them never carries over unsaved edits. */
export function RolePage() {
  const { id = "" } = useParams();
  return <RoleEditor key={`${id}${location.search}`} id={id} />;
}

function RoleEditor({ id }: { id: string }) {
  const isNew = id === "new";
  const navigate = useNavigate();
  const toast = useToast();
  const fail = useToastError();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["role", id], enabled: !isNew, queryFn: () => api.get<{ role: Role; people: any[]; canEdit: boolean; canCustomise: boolean; allowance: Allowance; locked: boolean }>(`/api/roles/${id}`) });
  const role = q.data?.role;
  const [editing, setEditing] = useState(isNew || new URLSearchParams(location.search).has("edit"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<Record<Workspace, AccessLevel>>(BLANK);
  const [special, setSpecial] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const reset = () => {
    if (!role) return;
    setName(role.name); setDescription(role.description ?? ""); setAccess({ ...role.access }); setSpecial([...role.special]);
  };
  useEffect(reset, [role]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!isNew && q.isLoading) return <Loading />;
  if (!isNew && !role) return <EmptyState title="That role doesn't exist" action={<Button onClick={() => navigate("/settings/roles")}>All roles</Button>} />;
  const isManager = role?.kind === "manager";
  const fromJob = role?.kind === "job";
  const canEdit = isNew || !!q.data?.canEdit;
  const save = async () => {
    setSaving(true);
    try {
      const body = { name, description, access, special };
      if (isNew) {
        const r = await api.post<{ role: Role }>("/api/roles", body);
        await qc.invalidateQueries({ queryKey: ["roles"] });
        toast(`${r.role.name} created`);
        navigate(`/settings/roles/${r.role.id}`, { replace: true });
      } else {
        await api.patch(`/api/roles/${id}`, body);
        await Promise.all([qc.invalidateQueries({ queryKey: ["roles"] }), qc.invalidateQueries({ queryKey: ["role", id] }), qc.invalidateQueries({ queryKey: ["members"] })]);
        toast("Role saved"); setEditing(false);
      }
    } catch (e) { fail(e, "Couldn't save the role"); }
    finally { setSaving(false); }
  };
  const cancel = () => { if (isNew) navigate("/settings/roles"); else { reset(); setEditing(false); } };
  const duplicate = async () => {
    try { const c = await api.post<{ role: Role }>(`/api/roles/${id}/duplicate`); await qc.invalidateQueries({ queryKey: ["roles"] }); navigate(`/settings/roles/${c.role.id}?edit=1`); }
    catch (e) { fail(e); }
  };
  return (
    <div className="ac-page">
      <div>
        <Link to="/settings/roles" className="back-link"><ChevronLeft size={16} />All roles</Link>
        <div className="ac-head">
          {editing ? (
            <div className="ac-head-fields">
              <Input aria-label="Role name" placeholder="Role name, e.g. HR officer" value={name} disabled={isManager || fromJob} title={fromJob ? "Change the job title in People & HR to rename this role" : undefined} onChange={(e) => setName(e.target.value)} className="ac-name" />
              <Input aria-label="Description" placeholder="What this role is for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          ) : (
            <div><h2>{role!.name}</h2><p className="muted">{[roleNote(role!), `${role!.people} ${role!.people === 1 ? "person" : "people"}`].filter(Boolean).join(" · ")}</p></div>
          )}
          <div className="ac-actions">
            {editing ? <>
              <Button variant="secondary" onClick={cancel} disabled={saving}>Cancel</Button>
              <Button loading={saving} disabled={!name.trim()} onClick={save}>{isNew ? "Create role" : "Save role"}</Button>
            </> : <>
              {canEdit && <Button icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit role</Button>}
              {!isManager && <MoreMenu label="Role actions" items={[
                { label: "Duplicate", icon: <Copy size={16} />, onClick: duplicate },
                { label: "Delete role", icon: <Trash2 size={16} />, danger: true, onClick: () => setDeleting(true) },
              ]} />}
            </>}
          </div>
        </div>
        {q.data?.locked && <p className="ac-upsell" style={{ marginTop: 12 }}><Lock size={14} />On the Free plan, {q.data.allowance.limit} roles can open more than My Workspace, and they're all in use. Upgrade, or take access away from another role, to give this one more. <Link className="link" to="/billing">See plans</Link></p>}
      </div>
      <Card title="Workspaces" subtitle="View lets them look. Edit lets them add and change. Manage also lets them delete and change the workspace's settings.">
        {WORKSPACES.map((w) => <LevelRow key={w} ws={w} level={access[w]} editing={editing} onChange={(l) => setAccess({ ...access, [w]: l })} />)}
      </Card>
      <Card title="Extra permissions" subtitle="Things that need more trust than workspace access.">
        {SPECIAL_PERMISSIONS.map((p) => (
          <PermRow key={p} p={p} on={special.includes(p)} editing={editing} onChange={(v) => setSpecial(v ? [...special, p] : special.filter((x) => x !== p))} />
        ))}
      </Card>
      {!isNew && !editing && (
        <Card title="People with this role">
          {!q.data!.people.length ? <p className="muted" style={{ margin: 0 }}>No one has this role yet.</p> : q.data!.people.map((m) => (
            <Link key={m.id} to={`/settings/members/${m.id}`} className="list-row ac-person">
              <Avatar name={m.name} size={34} /><div><b className="ink">{m.name}</b><small className="muted">{m.jobTitle || m.email}</small></div>
            </Link>
          ))}
        </Card>
      )}
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} danger title={`Delete ${role?.name}?`} confirmLabel="Delete role"
        onConfirm={async () => {
          setDeleting(false);
          try { await api.del(`/api/roles/${id}`); await qc.invalidateQueries({ queryKey: ["roles"] }); toast(`${role!.name} deleted`); navigate("/settings/roles"); } catch (e) { fail(e); }
        }}>
        People can't be left without a role, so a role that someone has can't be deleted.
      </ConfirmDialog>
    </div>
  );
}

// ---------------- One person ----------------
type MemberDetail = {
  id: string; name: string; email: string; avatarFileId: string | null; jobTitle: string | null; status: string; isPrimaryAdmin: boolean; isYou: boolean;
  role: { id: string; name: string; kind: string } | null;
  fromRole: { access: Record<Workspace, AccessLevel>; special: string[] };
  own: { access: Partial<Record<Workspace, AccessLevel>>; special: string[] };
  access: Record<Workspace, AccessLevel>; special: string[]; canEditAccess: boolean;
};

export function MemberPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const fail = useToastError();
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const q = useQuery({ queryKey: ["member", id], queryFn: () => api.get<MemberDetail>(`/api/members/${id}`) });
  const m = q.data;
  const [editing, setEditing] = useState(false);
  const [access, setAccess] = useState<Partial<Record<Workspace, AccessLevel>>>({});
  const [special, setSpecial] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [changingRole, setChangingRole] = useState(false);
  const [confirm, setConfirm] = useState<"remove" | "suspend" | null>(null);
  const reset = () => { if (m) { setAccess({ ...m.own.access }); setSpecial([...m.own.special]); } };
  useEffect(reset, [m]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Loading />;
  if (!m) return <EmptyState title="That person isn't a member" action={<Button onClick={() => navigate("/settings/members")}>All members</Button>} />;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["member", id] }), qc.invalidateQueries({ queryKey: ["members"] }), qc.invalidateQueries({ queryKey: ["roles"] })]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); await refresh(); toast(ok); } catch (e) { fail(e); } };
  const isAdminMember = m.role?.id === "admin";
  const roleName = m.role?.name ?? "their role";
  const levelFor = (w: Workspace) => access[w] ?? m.fromRole.access[w];
  const extras = WORKSPACES.filter((w) => m.own.access[w] && m.own.access[w] !== m.fromRole.access[w]).length
    + m.own.special.filter((p) => !m.fromRole.special.includes(p)).length;
  const save = async () => {
    setSaving(true);
    // Only keep what differs from the role, so the person follows the role everywhere else.
    const changed = Object.fromEntries(Object.entries(access).filter(([w, l]) => l !== m.fromRole.access[w as Workspace]));
    try {
      await api.patch(`/api/members/${id}`, { workspaceAccess: changed, specialPermissions: special.filter((p) => !m.fromRole.special.includes(p)) });
      await refresh(); toast("Access saved"); setEditing(false);
    } catch (e) { fail(e, "Couldn't save"); }
    finally { setSaving(false); }
  };
  return (
    <div className="ac-page">
      <div>
        <Link to="/settings/members" className="back-link"><ChevronLeft size={16} />All members</Link>
        <div className="ac-head">
          <div className="ac-person-head">
            <Avatar name={m.name} size={56} />
            <div><h2>{m.name}{m.isYou && <Pill>You</Pill>}</h2><p className="muted">{[m.email, m.jobTitle, m.status === "active" ? "Active" : "Suspended"].filter(Boolean).join(" · ")}</p></div>
          </div>
          <div className="ac-actions">
            {editing ? <>
              <Button variant="secondary" onClick={() => { reset(); setEditing(false); }} disabled={saving}>Cancel</Button>
              <Button loading={saving} onClick={save}>Save access</Button>
            </> : <>
              {m.canEditAccess && <Button icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit access</Button>}
              {!m.isYou && <MoreMenu label={`Actions for ${m.name}`} items={[
                { label: "Send password reset", icon: <KeyRound size={16} />, onClick: () => act(() => api.post(`/api/members/${id}/password-reset`), `Reset link sent to ${m.email}`) },
                m.status === "active"
                  ? !m.isPrimaryAdmin && { label: "Suspend access", icon: <Pause size={16} />, onClick: () => setConfirm("suspend") }
                  : { label: "Restore access", icon: <Pause size={16} />, onClick: () => act(() => api.patch(`/api/members/${id}`, { status: "active" }), `${m.name}'s access restored`) },
                !m.isPrimaryAdmin && { label: "Remove from organisation", icon: <Trash2 size={16} />, danger: true, onClick: () => setConfirm("remove") },
              ]} />}
            </>}
          </div>
        </div>
      </div>
      <Card className="ac-rolebar">
        <div className="grow">
          <h3>Role: {m.role?.name ?? "None"}</h3>
          <p className="muted">{isAdminMember ? "Admins can open everything, including settings and billing."
            : `${first(m.name)} sees what ${roleName} allows${extras ? `, plus ${extras} change${extras === 1 ? "" : "s"} made for ${first(m.name)} only` : ""}.`}</p>
        </div>
        {!m.isPrimaryAdmin && !m.isYou && (isAdmin || !isAdminMember) && <Button variant="secondary" onClick={() => setChangingRole(true)}>Change role</Button>}
      </Card>
      {!isAdminMember && <>
        <Card title="Workspaces">
          {WORKSPACES.map((w) => {
            const mine = levelFor(w), base = m.fromRole.access[w];
            const tag = mine === base ? undefined : rank(mine) > rank(base) ? `Added for ${first(m.name)}` : `Changed for ${first(m.name)}`;
            return <LevelRow key={w} ws={w} level={mine} editing={editing} tag={tag}
              from={mine === base ? `From ${roleName}` : `${roleName} has ${LEVEL[base].label.toLowerCase()}`}
              onChange={(l) => setAccess({ ...access, [w]: l })} />;
          })}
        </Card>
        <Card title="Extra permissions">
          {SPECIAL_PERMISSIONS.map((p) => {
            const fromRole = m.fromRole.special.includes(p);
            const on = fromRole || special.includes(p);
            return <PermRow key={p} p={p} on={on} editing={editing} disabled={fromRole}
              tag={!fromRole && on ? `Added for ${first(m.name)}` : undefined}
              from={fromRole ? `From ${roleName}` : on ? `${roleName} doesn't have this` : undefined}
              onChange={(v) => setSpecial(v ? [...special, p] : special.filter((x) => x !== p))} />;
          })}
        </Card>
      </>}
      <ChangeRoleModal open={changingRole} member={m} onClose={() => setChangingRole(false)}
        onSave={(roleId, label) => act(async () => { await api.patch(`/api/members/${id}`, { roleId }); setChangingRole(false); }, `${m.name} is now ${label}`)} />
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} danger
        title={confirm === "remove" ? `Remove ${m.name}?` : `Suspend ${m.name}?`} confirmLabel={confirm === "remove" ? "Remove" : "Suspend access"}
        onConfirm={() => {
          const c = confirm; setConfirm(null);
          if (c === "remove") act(async () => { await api.del(`/api/members/${id}`); navigate("/settings/members"); }, `${m.name} was removed`);
          else act(() => api.patch(`/api/members/${id}`, { status: "suspended" }), `${m.name} was suspended and signed out`);
        }}>
        {confirm === "remove" ? "They'll lose access straight away and be signed out on every device. Their work stays in WindVeal." : "They'll be signed out on every device until you restore their access."}
      </ConfirmDialog>
    </div>
  );
}

export function useRoleOptions(enabled = true) {
  return useQuery({ queryKey: ["role-options"], enabled, queryFn: () => api.get<RoleOption[]>("/api/roles/options") });
}

/** What a role can open, in one line (shown under the role picker). */
function roleSummary(o: RoleOption | undefined) {
  if (!o) return "";
  if (!o.access) return "Everything, including settings and billing";
  const open = WORKSPACES.filter((w) => o.access![w] !== "none").map((w) => `${WORKSPACE_LABELS[w]} (${LEVEL[o.access![w]].label.toLowerCase()})`);
  return open.length ? open.join(", ") : "No workspaces yet";
}

function ChangeRoleModal({ open, member, onClose, onSave }: { open: boolean; member: MemberDetail; onClose: () => void; onSave: (roleId: string, label: string) => void }) {
  const options = useRoleOptions(open);
  const [roleId, setRoleId] = useState(member.role?.id ?? "");
  useEffect(() => { if (open) setRoleId(member.role?.id ?? ""); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = options.data?.find((o) => o.id === roleId);
  return (
    <Modal open={open} onClose={onClose} title={`Change ${member.name}'s role`} subtitle="Anything you've added for them stays on top of the new role."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!picked || roleId === member.role?.id} onClick={() => onSave(roleId, picked!.name === "Admin" ? "an admin" : picked!.name)}>Save role</Button></>}>
      <Select label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)} options={(options.data ?? []).map((o) => ({ value: o.id, label: o.name }))} />
      <p className="ac-hint">{roleSummary(picked)}</p>
    </Modal>
  );
}

/** Invite people by email, each with a role. */
export function InviteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const options = useRoleOptions(open);
  const fallback = options.data?.find((o) => o.id !== "admin")?.id ?? "";
  const [rows, setRows] = useState([{ email: "", roleId: "" }]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setRows([{ email: "", roleId: "" }]); }, [open]);
  const rowsWithRole = rows.map((r) => ({ ...r, roleId: r.roleId || fallback }));
  const ready = rowsWithRole.filter((r) => r.email.trim());
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ results: { email: string; status: string }[] }>("/api/invitations", { invites: ready });
      const sent = r.results.filter((x) => x.status === "sent").length;
      const skipped = r.results.filter((x) => x.status !== "sent");
      toast(`${sent} invitation${sent === 1 ? "" : "s"} sent${skipped.length ? `, ${skipped.length} skipped (already a member or invited)` : ""}`);
      onDone(); onClose();
    } catch (e) { toast(e instanceof ApiError ? (e.details ? "Check the email addresses." : e.message) : "Something went wrong", "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Invite people" subtitle="They'll get an email to join. Invitations expire after 7 days."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!ready.length} onClick={send}>{ready.length > 1 ? `Send ${ready.length} invites` : "Send invite"}</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {rowsWithRole.map((r, i) => (
          <div key={i}>
            <div className="ac-invite-row">
              <Input type="email" placeholder="colleague@email.com" aria-label="Email" value={r.email} onChange={(e) => setRows(rows.map((x, k) => k === i ? { ...x, email: e.target.value } : x))} />
              <Select aria-label="Role" value={r.roleId} onChange={(e) => setRows(rows.map((x, k) => k === i ? { ...x, roleId: e.target.value } : x))}
                options={(options.data ?? []).map((o) => ({ value: o.id, label: o.name }))} />
              <IconButton label="Remove" onClick={() => setRows(rows.length > 1 ? rows.filter((_, k) => k !== i) : rows)}><X size={16} /></IconButton>
            </div>
            <p className="ac-hint">{roleSummary(options.data?.find((o) => o.id === r.roleId))}</p>
          </div>
        ))}
      </div>
      <button className="link row" style={{ marginTop: 12 }} onClick={() => setRows([...rows, { email: "", roleId: "" }])}><Plus size={15} />Add another</button>
      <p className="ac-hint" style={{ marginTop: 14 }}>They'll see exactly what their role allows. You can add more for one person from their page after they join.</p>
    </Modal>
  );
}
