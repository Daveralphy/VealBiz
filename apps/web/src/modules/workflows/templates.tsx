import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CalendarDays, ChevronLeft, Clock, GripVertical, LogOut, MoreHorizontal, Pencil, Play, Plus, Trash2, User, Users, X } from "lucide-react";
import { Button, Card, ConfirmDialog, EmptyState, Input, Loading, Menu, Modal, Notice, SearchInput, Select, useToast } from "@windveal/ui";
import { ApiError, api, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { fmtDate } from "../../lib/format";

type Role = "hr" | "manager" | "employee" | "creator" | "admin";
type Item = { title: string; group?: string; assigneeRole: Role; offsetDays: number };
type Template = { id: string; name: string; kind: "onboarding" | "offboarding" | "general"; trigger: { event: string } | null; items: Item[]; timesUsed: number; updatedAt: string };

const ROLE_LABEL: Record<Role, string> = { hr: "HR", manager: "Their manager", employee: "The employee", creator: "Whoever starts it", admin: "An admin" };
const KIND_FROM: Record<Template["kind"], string> = { onboarding: "Their start date", offboarding: "Their last working day", general: "The day it's started" };
const TRIGGERS = [
  { value: "", label: "Started by hand" },
  { value: "employee_joined", label: "A new employee joins" },
  { value: "employee_leaving", label: "An employee is leaving" },
];

function timing(kind: Template["kind"], d: number) {
  if (kind === "general") return d === 0 ? "Same day" : d > 0 ? `${d} day${d === 1 ? "" : "s"} after` : `${-d} day${d === -1 ? "" : "s"} before`;
  const ref = kind === "onboarding" ? "start" : "last day";
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} before ${ref}`;
  if (kind === "offboarding") return d === 0 ? "On the last day" : `${d} day${d === 1 ? "" : "s"} after`;
  return `Day ${d + 1}`;
}

function KindIcon({ t }: { t: Template }) {
  const cls = `wf-tpl-ic wf-tpl-${t.kind}`;
  return <span className={cls}>{t.kind === "onboarding" ? <Users size={18} /> : t.kind === "offboarding" ? <LogOut size={18} /> : <CalendarDays size={18} />}</span>;
}

export function TemplatesView() {
  const { can } = useSession();
  const canManage = can("workflows", "manage");
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ["wf-templates"], queryFn: () => api.get<Template[]>("/api/workflows/templates") });
  const list = useMemo(() => (data ?? []).filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);
  useEffect(() => {
    if (!selected && data?.length && window.matchMedia("(min-width: 901px)").matches) setSelected(data[0]!.id);
  }, [data, selected]);

  async function create() {
    try {
      const t = await api.post<Template>("/api/workflows/templates", {
        name: "New template", kind: "general", items: [{ title: "First task", group: "Tasks", assigneeRole: "creator", offsetDays: 0 }],
      });
      await qc.invalidateQueries({ queryKey: ["wf-templates"] });
      setFresh(t.id);
      setSelected(t.id);
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't create the template.", "error"); }
  }

  if (isLoading) return <Loading />;
  if (error) return <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load templates."}</Notice>;
  const current = data?.find((t) => t.id === selected) ?? null;

  return (
    <div className={`wf-templates ${current ? "has-selection" : ""}`}>
      <div className="wf-tpl-list">
        <SearchInput value={q} onChange={setQ} placeholder="Search templates" />
        {list.map((t) => (
          <button key={t.id} className={`wf-tpl-card ${selected === t.id ? "on" : ""}`} onClick={() => { setSelected(t.id); if (t.id !== fresh) setFresh(null); }}>
            <KindIcon t={t} />
            <span><b>{t.name}</b><small>{t.items.length} task{t.items.length === 1 ? "" : "s"} · used {t.timesUsed} time{t.timesUsed === 1 ? "" : "s"}</small></span>
          </button>
        ))}
        {!list.length && <p className="muted" style={{ padding: "8px 4px" }}>{q ? "No templates match." : "No templates yet."}</p>}
        {canManage && <Button variant="secondary" block icon={<Plus size={16} />} onClick={create}>New template</Button>}
      </div>
      <div className="wf-tpl-editor">
        {current ? <TemplateEditor key={current.id + current.updatedAt} t={current} canManage={canManage} isNew={fresh === current.id} onSaved={() => setFresh(null)} onBack={() => setSelected(null)} onDeleted={() => setSelected(null)} />
          : <Card className="hide-sm"><EmptyState title="Choose a template">Templates turn a repeat process into a ready-made list of tasks.</EmptyState></Card>}
      </div>
    </div>
  );
}

function TemplateEditor({ t, canManage, isNew, onSaved, onBack, onDeleted }: {
  t: Template; canManage: boolean; isNew: boolean; onSaved: () => void; onBack: () => void; onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [name, setName] = useState(t.name);
  const [kind, setKind] = useState(t.kind);
  const [trigger, setTrigger] = useState(t.trigger?.event ?? "");
  const [items, setItems] = useState<Item[]>(t.items.map((i) => ({ ...i, group: i.group ?? "Tasks" })));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [useOpen, setUseOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [editing, setEditing] = useState(canManage && isNew);
  const dirty = JSON.stringify({ name, kind, trigger, items }) !== JSON.stringify({ name: t.name, kind: t.kind, trigger: t.trigger?.event ?? "", items: t.items.map((i) => ({ ...i, group: i.group ?? "Tasks" })) });

  const groups = useMemo(() => {
    const out: { name: string; rows: { item: Item; index: number }[] }[] = [];
    items.forEach((item, index) => {
      const g = item.group || "Tasks";
      let grp = out.find((x) => x.name === g);
      if (!grp) { grp = { name: g, rows: [] }; out.push(grp); }
      grp.rows.push({ item, index });
    });
    return out;
  }, [items]);

  const update = (i: number, patch: Partial<Item>) => setItems((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (from: number, to: number) => setItems((list) => {
    if (to < 0 || to >= list.length || from === to) return list;
    const copy = [...list];
    const [it] = copy.splice(from, 1);
    copy.splice(to, 0, { ...it!, group: list[to]!.group });
    return copy;
  });
  const addTo = (group: string) => setItems((list) => {
    const lastIdx = list.map((x) => x.group).lastIndexOf(group);
    const copy = [...list];
    const prev = list[lastIdx];
    copy.splice(lastIdx + 1, 0, { title: "", group, assigneeRole: prev?.assigneeRole ?? "hr", offsetDays: prev?.offsetDays ?? 0 });
    return copy;
  });
  const renameGroup = (from: string, to: string) => setItems((list) => list.map((x) => (x.group === from ? { ...x, group: to } : x)));

  async function save() {
    setSaving(true);
    setErrors({});
    try {
      await api.patch(`/api/workflows/templates/${t.id}`, { name, kind, trigger: trigger ? { event: trigger } : null, items: items.map((i) => ({ ...i, group: i.group?.trim() || undefined })) });
      onSaved();
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ["wf-templates"] });
      toast("Template saved");
    } catch (e) {
      if (e instanceof ApiError && e.details) setErrors(e.details);
      toast(e instanceof ApiError ? e.message : "Couldn't save the template.", "error");
    } finally { setSaving(false); }
  }
  function cancel() {
    setName(t.name); setKind(t.kind); setTrigger(t.trigger?.event ?? "");
    setItems(t.items.map((i) => ({ ...i, group: i.group ?? "Tasks" })));
    setErrors({}); setEditing(false); onSaved();
  }
  async function remove() {
    try {
      await api.del(`/api/workflows/templates/${t.id}`);
      await qc.invalidateQueries({ queryKey: ["wf-templates"] });
      toast("Template deleted");
      onDeleted();
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't delete the template.", "error"); }
  }

  const explain = trigger === "employee_joined" ? "Starts automatically when someone joins. " : trigger === "employee_leaving" ? "Starts automatically when someone is leaving. " : "Start it whenever you need it. ";

  return (
    <Card className="wf-tpl-card-editor">
      <button className="back-link btn-ghost wf-ap-back" onClick={onBack}><ChevronLeft size={16} />All templates</button>
      <div className="between" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          {editing ? <input className="wf-tpl-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" /> : <h3>{t.name}</h3>}
          {errors.name && <span className="field-error">{errors.name}</span>}
          <p className="muted wf-small">{explain}Tasks are given to roles, so the right people get them each time.</p>
        </div>
        <div className="row">
          {editing ? (
            <>
              <Button variant="secondary" size="sm" onClick={cancel} disabled={saving}>Cancel</Button>
              <Button size="sm" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
            </>
          ) : (
            <>
              {can("workflows", "edit") && <Button variant="secondary" size="sm" icon={<Play size={14} />} onClick={() => setUseOpen(true)}>Use</Button>}
              {canManage && <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit template</Button>}
            </>
          )}
          {canManage && !editing && (
            <Menu trigger={(tg) => <button className="icon-btn" aria-label="More" onClick={tg}><MoreHorizontal size={18} /></button>}>
              {(close) => <button className="danger" onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={16} />Delete template</button>}
            </Menu>
          )}
        </div>
      </div>
      <div className="form-grid wf-tpl-settings">
        <Select label="Starts when" value={trigger} disabled={!editing} onChange={(e) => {
          setTrigger(e.target.value);
          if (e.target.value === "employee_joined") setKind("onboarding");
          if (e.target.value === "employee_leaving") setKind("offboarding");
        }} options={TRIGGERS} />
        <Select label="Dates counted from" value={kind} disabled={!editing} onChange={(e) => setKind(e.target.value as Template["kind"])}
          options={(["onboarding", "offboarding", "general"] as const).map((k) => ({ value: k, label: KIND_FROM[k] }))} />
      </div>
      {groups.map((g) => (
        <section key={g.name} className="wf-tpl-group">
          {editing ? (
            <input className="wf-tpl-group-name" defaultValue={g.name} aria-label="Group name" onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== g.name) renameGroup(g.name, v); }} />
          ) : <h4 className="section-label">{g.name}</h4>}
          {g.rows.map(({ item, index }) => (
            <div key={index} className={`wf-tpl-row ${drag === index ? "dragging" : ""}`}
              draggable={editing} onDragStart={() => setDrag(index)} onDragEnd={() => setDrag(null)}
              onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, index); setDrag(null); }}>
              {editing && <span className="wf-grip" aria-hidden><GripVertical size={16} /></span>}
              {editing ? (
                <input className="wf-tpl-title" value={item.title} placeholder="Task title" aria-label="Task title" onChange={(e) => update(index, { title: e.target.value })}
                  aria-invalid={!!errors[`items.${index}.title`]} />
              ) : <b className="wf-tpl-title">{item.title}</b>}
              <label className="wf-tpl-pick"><User size={14} />
                {editing ? (
                  <select value={item.assigneeRole} onChange={(e) => update(index, { assigneeRole: e.target.value as Role })} aria-label="Assigned to">
                    {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                ) : <span>{ROLE_LABEL[item.assigneeRole]}</span>}
              </label>
              <label className="wf-tpl-pick wf-tpl-when" title={timing(kind, item.offsetDays)}><Clock size={14} />
                {editing ? (
                  <>
                    <input type="number" value={item.offsetDays} min={-365} max={365} aria-label="Days from the start date" onChange={(e) => update(index, { offsetDays: Number(e.target.value) || 0 })} />
                    <span>{timing(kind, item.offsetDays)}</span>
                  </>
                ) : <span>{timing(kind, item.offsetDays)}</span>}
              </label>
              {editing && (
                <span className="wf-tpl-actions">
                  <button className="icon-btn" aria-label="Move up" disabled={index === 0} onClick={() => move(index, index - 1)}><ArrowUp size={15} /></button>
                  <button className="icon-btn" aria-label="Move down" disabled={index === items.length - 1} onClick={() => move(index, index + 1)}><ArrowDown size={15} /></button>
                  <button className="icon-btn" aria-label="Remove task" onClick={() => setItems((l) => l.filter((_, j) => j !== index))}><X size={15} /></button>
                </span>
              )}
            </div>
          ))}
          {editing && <button className="link wf-add-task" onClick={() => addTo(g.name)}><Plus size={15} />Add task</button>}
        </section>
      ))}
      {!items.length && <p className="muted">No tasks yet.</p>}
      {editing && (
        <button className="link wf-add-task" onClick={() => setItems((l) => [...l, { title: "", group: `Group ${groups.length + 1}`, assigneeRole: "hr", offsetDays: 0 }])}>
          <Plus size={15} />Add group
        </button>
      )}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); remove(); }} danger title="Delete this template?" confirmLabel="Delete template">
        Checklists already started from it keep their tasks.
      </ConfirmDialog>
      <UseTemplateModal open={useOpen} onClose={() => setUseOpen(false)} t={t} />
    </Card>
  );
}

function UseTemplateModal({ open, onClose, t }: { open: boolean; onClose: () => void; t: Template }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsEmployee = t.kind !== "general";
  const { data: emps, isLoading } = useQuery({
    queryKey: ["wf-employees", q], queryFn: () => api.get<{ id: string; name: string; jobTitle: string | null; startDate: string | null }[]>(`/api/workflows/employees${qs({ q })}`),
    enabled: open && needsEmployee,
  });
  useEffect(() => { if (open) { setEmployeeId(""); setDate(""); setErr(null); setQ(""); } }, [open]);
  async function go() {
    if (needsEmployee && !employeeId) { setErr("Choose who this is for."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ created: number }>(`/api/workflows/templates/${t.id}/use`, { employeeId: employeeId || null, anchorDate: date || undefined });
      qc.invalidateQueries({ queryKey: ["wf-tasks"] });
      qc.invalidateQueries({ queryKey: ["wf-templates"] });
      qc.invalidateQueries({ queryKey: ["wf-summary"] });
      toast(`${r.created} task${r.created === 1 ? "" : "s"} created`);
      onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Couldn't start the template."); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Use "${t.name}"`} subtitle={`Creates ${t.items.length} task${t.items.length === 1 ? "" : "s"} for the right people.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={go}>Start</Button></>}>
      <div className="stack">
        {err && <Notice tone="error">{err}</Notice>}
        {needsEmployee && (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search employees" />
            <div className="wf-emp-list">
              {isLoading ? <Loading /> : !emps?.length ? <p className="muted">No employees found. Add people in People &amp; HR first.</p> : emps.map((e) => (
                <label key={e.id} className={`wf-emp ${employeeId === e.id ? "on" : ""}`}>
                  <input type="radio" name="emp" checked={employeeId === e.id} onChange={() => setEmployeeId(e.id)} />
                  <span><b>{e.name}</b><small>{[e.jobTitle, e.startDate ? `starts ${fmtDate(e.startDate)}` : null].filter(Boolean).join(" · ") || "—"}</small></span>
                </label>
              ))}
            </div>
          </>
        )}
        <Input type="date" label={`Count dates from (${KIND_FROM[t.kind].toLowerCase()})`} optional hint={needsEmployee ? "Leave empty to use the date on their profile." : "Leave empty to start today."}
          value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
    </Modal>
  );
}
