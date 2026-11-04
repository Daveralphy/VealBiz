import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Flag, History, Link2, MessageSquare, Paperclip, Pencil, Plus, Repeat, Trash2, X, FileText, UserRoundCog } from "lucide-react";
import { Avatar, Button, ConfirmDialog, Drawer, EmptyState, Input, Loading, Modal, Notice, Pill, SearchInput, Select, Textarea, useConfirm, useToast } from "@windveal/ui";
import { WORKSPACE_LABELS, formatBytes } from "@windveal/shared";
import { ApiError, api, fileUrl, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dayLabel, fmtDate, fmtTime, timeAgo } from "../../lib/format";
import { useForm } from "../../lib/form";
import { LinkPicker, type LinkTarget } from "../documents/LinkPicker";
import { MoreMenu } from "../../components/actions";

// ---------------- types + shared hooks ----------------

export type Person = { id: string; name: string; role?: string };
export type TaskView = {
  id: string; title: string; description: string | null; status: "todo" | "in_progress" | "done"; priority: "low" | "medium" | "high";
  dueAt: string | null; workspace: string; linkType: string | null; linkId: string | null; linkLabel: string | null; repeatRule: string | null;
  checklistGroup: string | null; completedAt: string | null; assignee: Person | null; createdBy: Person | null; createdAt: string;
  counts: { comments: number; files: number; items: number; itemsDone: number };
};
type TaskGroup = { key: string; label: string; tasks: TaskView[] };
type TaskList = { total: number; groups: TaskGroup[] };
type TaskDetail = {
  task: TaskView;
  items: { id: string; label: string; done: boolean; position: number }[];
  comments: { id: string; body: string; author: Person; createdAt: string }[];
  files: { id: string; name: string; size: number; mime: string }[];
  activity: { id: string; summary: string; actor: string | null; createdAt: string }[];
  canEdit: boolean; canDelete: boolean;
};

export const WS_OPTIONS = (["workflows", "people", "recruitment", "crm", "documents"] as const).map((w) => ({ value: w, label: WORKSPACE_LABELS[w] }));
const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;
const STATUS_LABEL = { todo: "To do", in_progress: "In progress", done: "Done" } as const;

export function useMembers() {
  return useQuery({ queryKey: ["assignable"], queryFn: () => api.get<Person[]>("/api/members/assignable"), staleTime: 120_000 });
}

/** Invalidates everything that shows task data. */
export function useTaskRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["wf-tasks"] });
    qc.invalidateQueries({ queryKey: ["wf-task"] });
    qc.invalidateQueries({ queryKey: ["wf-summary"] });
    qc.invalidateQueries({ queryKey: ["shell-counts"] });
  };
}

export function dueText(t: TaskView): { text: string; overdue: boolean } {
  if (!t.dueAt) return { text: "", overdue: false };
  const d = new Date(t.dueAt);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (t.status !== "done" && d.getTime() < start.getTime()) {
    const days = Math.max(1, Math.round((start.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000));
    return { text: `${days} day${days === 1 ? "" : "s"} overdue`, overdue: true };
  }
  const label = dayLabel(d);
  if (label === "Today") {
    const isDefault = d.getHours() === 17 && d.getMinutes() === 0;
    return { text: isDefault ? "Today" : fmtTime(d), overdue: false };
  }
  return { text: label, overdue: false };
}

function PriorityFlag({ p }: { p: TaskView["priority"] }) {
  return <span className={`wf-flag wf-flag-${p}`} title={`${PRIORITY_LABEL[p]} priority`}><Flag size={15} /></span>;
}

function CircleToggle({ done, onClick, disabled, label }: { done: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" className={`wf-circle ${done ? "done" : ""}`} onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={disabled} aria-label={label} title={label}>
      {done && <Check size={12} strokeWidth={3} />}
    </button>
  );
}

function useToggleComplete() {
  const refresh = useTaskRefresh();
  const toast = useToast();
  return useMutation({
    mutationFn: (t: TaskView) => api.post<{ next?: TaskView | null }>(`/api/workflows/tasks/${t.id}/${t.status === "done" ? "reopen" : "complete"}`),
    onSuccess: (r, t) => {
      refresh();
      if (t.status !== "done") toast(r?.next ? `Done. Next one is due ${dayLabel(r.next.dueAt)}.` : "Task completed");
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't update the task.", "error"),
  });
}

// ---------------- list ----------------

function TaskRow({ t, onOpen }: { t: TaskView; onOpen: () => void }) {
  const toggle = useToggleComplete();
  const due = dueText(t);
  return (
    <div className={`wf-row ${t.status === "done" ? "is-done" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <CircleToggle done={t.status === "done"} disabled={toggle.isPending} onClick={() => toggle.mutate(t)} label={t.status === "done" ? "Reopen task" : "Mark complete"} />
      <div className="wf-row-main">
        <b>{t.title}</b>
        <span className="wf-meta">
          {t.status === "in_progress" && <span className="wf-inprog">In progress</span>}
          {t.counts.items > 0 && <span><CheckCircle2 size={13} />{t.counts.itemsDone}/{t.counts.items}</span>}
          {t.counts.files > 0 && <span><Paperclip size={13} />{t.counts.files}</span>}
          {t.counts.comments > 0 && <span><MessageSquare size={13} />{t.counts.comments}</span>}
          {t.repeatRule && <span><Repeat size={13} />{t.repeatRule === "weekly" ? "Weekly" : "Monthly"}</span>}
        </span>
      </div>
      <span className="wf-ws hide-sm"><Pill tone="blue">{WORKSPACE_LABELS[t.workspace as keyof typeof WORKSPACE_LABELS] ?? t.workspace}</Pill></span>
      <span className="wf-link hide-sm">
        {t.linkLabel ? <><Link2 size={13} />{t.linkLabel}</> : t.repeatRule ? <><Link2 size={13} />Repeats every {t.repeatRule === "weekly" ? "week" : "month"}</> : null}
      </span>
      <span className={`wf-due ${due.overdue ? "od" : ""}`}>{t.status === "done" ? (t.completedAt ? `Done ${dayLabel(t.completedAt)}` : "Done") : due.text}</span>
      <span className="hide-sm"><PriorityFlag p={t.priority} /></span>
      <span className="hide-sm wf-av">{t.assignee ? <Avatar name={t.assignee.name} size={28} /> : <span className="wf-unassigned" title="Unassigned" />}</span>
    </div>
  );
}

export type TaskFilters = { q: string; workspace: string; priority: string; createdBy: string };

export function TaskFilterBar({ f, setF, showAssignedBy = true }: { f: TaskFilters; setF: (f: TaskFilters) => void; showAssignedBy?: boolean }) {
  const { data: members } = useMembers();
  return (
    <div className="toolbar wf-toolbar">
      <SearchInput value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search tasks" />
      <Select className="chip-select" aria-label="Workspace" value={f.workspace} onChange={(e) => setF({ ...f, workspace: e.target.value })}>
        <option value="">Workspace: All</option>
        {WS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      <Select className="chip-select" aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="">Priority: All</option>
        <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
      </Select>
      {showAssignedBy && (
        <Select className="chip-select" aria-label="Assigned by" value={f.createdBy} onChange={(e) => setF({ ...f, createdBy: e.target.value })}>
          <option value="">Assigned by: Anyone</option>
          {members?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      )}
    </div>
  );
}

export function useTaskList(scope: "mine" | "all" | "created", f: TaskFilters) {
  return useQuery({
    queryKey: ["wf-tasks", scope, f],
    queryFn: () => api.get<TaskList>(`/api/workflows/tasks${qs({
      scope, q: f.q.trim(), workspace: f.workspace, priority: f.priority, createdBy: f.createdBy, tz: new Date().getTimezoneOffset(),
    })}`),
    placeholderData: (prev) => prev,
  });
}

export function TaskList({ data, isLoading, error, onOpen, emptyText, filtered, onNew, canCreate }: {
  data?: TaskList; isLoading: boolean; error: unknown; onOpen: (id: string) => void; emptyText: string; filtered: boolean; onNew: () => void; canCreate: boolean;
}) {
  const [showDone, setShowDone] = useState(false);
  if (isLoading && !data) return <Loading />;
  if (error && !data) return <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load tasks. Try again."}</Notice>;
  const groups = data?.groups ?? [];
  const open = groups.filter((g) => g.key !== "done" && g.tasks.length);
  const done = groups.find((g) => g.key === "done");
  if (!open.length && !done?.tasks.length) {
    return (
      <EmptyState title={filtered ? "No tasks match" : "You're all caught up"} icon={<CheckCircle2 size={24} />}
        action={!filtered && canCreate ? <Button icon={<Plus size={16} />} onClick={onNew}>New task</Button> : undefined}>
        {filtered ? "Try a different search or clear the filters." : emptyText}
      </EmptyState>
    );
  }
  return (
    <div className="wf-groups">
      {!open.length && <p className="muted" style={{ marginBottom: 12 }}>No open tasks. {filtered ? "Try clearing the filters." : "Nice work."}</p>}
      {open.map((g) => (
        <section key={g.key}>
          <h4 className="wf-group-head">{g.label}<span>{g.tasks.length}</span></h4>
          <div className={`wf-card ${g.key === "overdue" ? "wf-card-overdue" : ""}`}>
            {g.tasks.map((t) => <TaskRow key={t.id} t={t} onOpen={() => onOpen(t.id)} />)}
          </div>
        </section>
      ))}
      {!!done?.tasks.length && (
        <section>
          <button className="wf-group-head wf-group-toggle" onClick={() => setShowDone((s) => !s)} aria-expanded={showDone}>
            Done recently<span>{done.tasks.length}</span><small>{showDone ? "Hide" : "Show"}</small>
          </button>
          {showDone && <div className="wf-card">{done.tasks.map((t) => <TaskRow key={t.id} t={t} onOpen={() => onOpen(t.id)} />)}</div>}
        </section>
      )}
    </div>
  );
}

// ---------------- board ----------------

export function TaskBoard({ data, isLoading, error, onOpen }: { data?: TaskList; isLoading: boolean; error: unknown; onOpen: (id: string) => void }) {
  const refresh = useTaskRefresh();
  const toast = useToast();
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState<Record<string, TaskView["status"]>>({});
  const all = useMemo(() => (data?.groups ?? []).flatMap((g) => g.tasks), [data]);
  if (isLoading && !data) return <Loading />;
  if (error && !data) return <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load tasks. Try again."}</Notice>;
  const statusOf = (t: TaskView) => moving[t.id] ?? t.status;
  const cols: { key: TaskView["status"]; label: string }[] = [{ key: "todo", label: "To do" }, { key: "in_progress", label: "In progress" }, { key: "done", label: "Done" }];

  async function drop(e: DragEvent, status: TaskView["status"]) {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/task");
    const t = all.find((x) => x.id === id);
    if (!t || statusOf(t) === status) return;
    setMoving((m) => ({ ...m, [id]: status }));
    try {
      if (status === "done") await api.post(`/api/workflows/tasks/${id}/complete`);
      else await api.patch(`/api/workflows/tasks/${id}`, { status });
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't move the task.", "error");
    } finally {
      setMoving((m) => { const n = { ...m }; delete n[id]; return n; });
    }
  }

  return (
    <div className="board wf-board">
      {cols.map((c) => {
        const items = all.filter((t) => statusOf(t) === c.key);
        return (
          <div key={c.key} className={`board-col ${over === c.key ? "drop" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(c.key); }} onDragLeave={() => setOver((o) => (o === c.key ? null : o))} onDrop={(e) => drop(e, c.key)}>
            <h5>{c.label}<span>{items.length}</span></h5>
            {c.key === "done" && <div className="sub">Last two weeks</div>}
            {items.map((t) => {
              const due = dueText(t);
              return (
                <div key={t.id} className="board-card" draggable onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)} onClick={() => onOpen(t.id)}
                  role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}>
                  <b>{t.title}</b>
                  {t.linkLabel && <small className="wf-board-link"><Link2 size={12} /> {t.linkLabel}</small>}
                  <div className="between" style={{ marginTop: 8 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <PriorityFlag p={t.priority} />
                      <small className={due.overdue && c.key !== "done" ? "wf-od" : undefined}>{c.key === "done" ? "" : due.text}</small>
                    </span>
                    {t.assignee && <Avatar name={t.assignee.name} size={24} />}
                  </div>
                </div>
              );
            })}
            {!items.length && <p className="wf-board-empty">Drop tasks here</p>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- new task ----------------

function toIso(date: string, time: string): string | null {
  if (!date) return null;
  return new Date(`${date}T${time || "17:00"}:00`).toISOString();
}

export function NewTaskModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { user } = useSession();
  const { data: members } = useMembers();
  const refresh = useTaskRefresh();
  const toast = useToast();
  const init = { title: "", description: "", assigneeUserId: user.id, dueDate: "", dueTime: "", priority: "medium", workspace: "workflows", repeatRule: "" };
  const form = useForm(init);
  const [link, setLink] = useState<LinkTarget | null>(null);
  useEffect(() => { if (open) { form.setValues(init); setLink(null); form.setErrors({}); form.setFormError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => form.submit(async (v) => {
    if (v.repeatRule && !v.dueDate) { form.setErrors({ dueAt: "Repeating tasks need a first due date." }); throw new ApiError(400, "bad_request", "Some details need fixing."); }
    const r = await api.post<TaskView>("/api/workflows/tasks", {
      title: v.title, description: v.description || null, assigneeUserId: v.assigneeUserId || null, dueAt: toIso(v.dueDate, v.dueTime),
      priority: v.priority, workspace: v.workspace, linkType: link?.type ?? null, linkId: link?.id ?? null, repeatRule: v.repeatRule || null,
    });
    refresh();
    toast("Task created");
    onCreated(r.id);
  });

  return (
    <Modal open={open} onClose={onClose} title="New task" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.busy} onClick={save}>Create task</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input wrapClassName="span-2" label="Title" autoFocus placeholder="e.g. Send revised price list" {...form.bind("title")} />
        <Textarea wrapClassName="span-2" label="Details" optional rows={3} placeholder="Anything the assignee should know" {...form.bind("description")} />
        <Select label="Assigned to" value={form.values.assigneeUserId} onChange={(e) => form.set("assigneeUserId", e.target.value)} error={form.errors.assigneeUserId}>
          <option value="">No one yet</option>
          {members?.map((m) => <option key={m.id} value={m.id}>{m.id === user.id ? `${m.name} (you)` : m.name}</option>)}
        </Select>
        <Select label="Priority" value={form.values.priority} onChange={(e) => form.set("priority", e.target.value)}
          options={[{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }]} />
        <Input label="Due date" optional type="date" value={form.values.dueDate} onChange={(e) => form.set("dueDate", e.target.value)} error={form.errors.dueAt} />
        <Input label="Time" optional type="time" value={form.values.dueTime} onChange={(e) => form.set("dueTime", e.target.value)} disabled={!form.values.dueDate} />
        <Select label="Workspace" value={form.values.workspace} onChange={(e) => form.set("workspace", e.target.value)} options={WS_OPTIONS} />
        <Select label="Repeats" value={form.values.repeatRule} onChange={(e) => form.set("repeatRule", e.target.value)}
          options={[{ value: "", label: "Doesn't repeat" }, { value: "weekly", label: "Every week" }, { value: "monthly", label: "Every month" }]} />
        <div className="field span-2">
          <span className="field-label"><span>Linked to</span><span className="opt">Optional</span></span>
          <LinkPicker endpoint="/api/workflows/link-targets" value={link} onChange={setLink} />
          {form.errors.linkId && <span className="field-error">{form.errors.linkId}</span>}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------- task drawer ----------------

export function TaskDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { user } = useSession();
  const toast = useToast();
  const refresh = useTaskRefresh();
  const { data: members } = useMembers();
  const { data, isLoading, error } = useQuery({
    queryKey: ["wf-task", id], queryFn: () => api.get<TaskDetail>(`/api/workflows/tasks/${id}`), enabled: !!id,
  });
  const [newItem, setNewItem] = useState("");
  const [comment, setComment] = useState("");
  const [showActivity, setShowActivity] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const assigneeRef = useRef<HTMLSelectElement>(null);
  const toggle = useToggleComplete();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", status: "todo", assignee: "", due: "", priority: "medium" });
  const [saving, setSaving] = useState(false);
  const focusAssignee = useRef(false);
  useEffect(() => { setShowActivity(false); setComment(""); setNewItem(""); setEditing(false); }, [id]);
  useEffect(() => { if (editing && focusAssignee.current) { focusAssignee.current = false; assigneeRef.current?.focus(); } }, [editing]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); refresh(); if (ok) toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : "Something went wrong. Please try again.", "error"); }
  };

  const t = data?.task;
  const editable = !!data?.canEdit;
  const itemsDone = data?.items.filter((i) => i.done).length ?? 0;

  async function attach(list: FileList | null) {
    if (!list?.length || !id) return;
    setUploading(true);
    for (const f of Array.from(list)) {
      try { await api.upload("/api/files", f, { kind: "system", linkType: "task", linkId: id }); }
      catch (e) { toast(e instanceof ApiError ? `${f.name}: ${e.message}` : `Couldn't upload ${f.name}.`, "error"); }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
    refresh();
  }

  const dueLocal = t?.dueAt ? (() => { const d = new Date(t.dueAt); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); })() : "";
  const mentionHint = /@\S*$/.test(comment);
  const set = (k: keyof typeof draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  function startEdit(assignee = false) {
    if (!t) return;
    setDraft({ title: t.title, status: t.status, assignee: t.assignee?.id ?? "", due: dueLocal, priority: t.priority });
    focusAssignee.current = assignee;
    setEditing(true);
  }

  async function saveEdit() {
    if (!t) return;
    const title = draft.title.trim();
    if (!title) { toast("Give the task a title.", "error"); return; }
    const body: Record<string, unknown> = {};
    if (title !== t.title) body.title = title;
    if (draft.status !== t.status && draft.status !== "done") body.status = draft.status;
    if (draft.assignee !== (t.assignee?.id ?? "")) body.assigneeUserId = draft.assignee || null;
    if (draft.due !== dueLocal) body.dueAt = draft.due ? new Date(draft.due).toISOString() : null;
    if (draft.priority !== t.priority) body.priority = draft.priority;
    const changed = Object.keys(body).length > 0;
    setSaving(true);
    try {
      if (changed) await api.patch(`/api/workflows/tasks/${t.id}`, body);
      setEditing(false);
      if (draft.status === "done" && t.status !== "done") toggle.mutate(t);
      else if (changed) { refresh(); toast("Task updated"); }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save the task.", "error");
    } finally { setSaving(false); }
  }

  return (
    <Drawer open={!!id} onClose={onClose} title={t?.title ?? (isLoading ? "Loading…" : "Task")}
      headerExtra={t && <CircleToggle done={t.status === "done"} disabled={!editable || editing || toggle.isPending} onClick={() => toggle.mutate(t)} label={t.status === "done" ? "Reopen task" : "Mark complete"} />}
      footer={t && (
        <>
          <button className="link wf-activity-btn" onClick={() => setShowActivity((s) => !s)}><History size={16} />{showActivity ? "Hide activity" : "Activity"}</button>
          {editing ? (
            <div className="row">
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              <Button loading={saving} onClick={saveEdit}>Save</Button>
            </div>
          ) : <div className="row">
            <MoreMenu label="Task actions" items={[
              editable && { label: "Edit", icon: <Pencil size={16} />, onClick: () => startEdit() },
              editable && { label: "Reassign", icon: <UserRoundCog size={16} />, onClick: () => startEdit(true) },
              data.canDelete && { label: "Delete task", icon: <Trash2 size={16} />, danger: true, onClick: () => setConfirmDelete(true) },
            ]} />
            {editable && (t.status === "done"
              ? <Button variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate(t)}>Reopen</Button>
              : <Button icon={<Check size={16} />} loading={toggle.isPending} onClick={() => toggle.mutate(t, { onSuccess: onClose })}>Mark complete</Button>)}
          </div>}
        </>
      )}>
      {isLoading ? <Loading /> : error || !data || !t ? (
        <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load this task."}</Notice>
      ) : (
        <div className={`wf-drawer ${editing ? "is-editing" : ""}`}>
          {editing && (
            <Input aria-label="Title" className="wf-title-input" autoFocus={!focusAssignee.current} value={draft.title} onChange={(e) => set("title", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
          )}
          <dl className="wf-props">
            <div><dt>Status</dt><dd>
              {editing ? (
                <select className={`wf-status wf-status-${draft.status}`} value={draft.status} aria-label="Status" onChange={(e) => set("status", e.target.value)}>
                  {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              ) : <span className={`wf-status wf-status-${t.status}`}>{STATUS_LABEL[t.status]}</span>}
            </dd></div>
            <div><dt>Assigned to</dt><dd>
              {editing ? (
                <select ref={assigneeRef} className="wf-inline-select" aria-label="Assigned to" value={draft.assignee} onChange={(e) => set("assignee", e.target.value)}>
                  <option value="">No one</option>
                  {members?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === user.id ? " (you)" : ""}</option>)}
                </select>
              ) : t.assignee ? <span className="row" style={{ gap: 8 }}><Avatar name={t.assignee.name} size={26} />{t.assignee.name}</span> : "No one"}
            </dd></div>
            <div><dt>Due</dt><dd>
              {editing ? (
                <input type="datetime-local" className="wf-inline-input" aria-label="Due" value={draft.due} onChange={(e) => set("due", e.target.value)} />
              ) : <span className={dueText(t).overdue ? "wf-od" : undefined}>{t.dueAt ? `${dayLabel(t.dueAt)}, ${fmtTime(t.dueAt)}` : "No due date"}</span>}
            </dd></div>
            <div><dt>Priority</dt><dd>
              <span className="row" style={{ gap: 6 }}>
                <PriorityFlag p={(editing ? draft.priority : t.priority) as TaskView["priority"]} />
                {editing ? (
                  <select className="wf-inline-select" aria-label="Priority" value={draft.priority} onChange={(e) => set("priority", e.target.value)}>
                    <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                  </select>
                ) : PRIORITY_LABEL[t.priority]}
              </span>
            </dd></div>
            {t.repeatRule && <div><dt>Repeats</dt><dd><span className="row" style={{ gap: 6 }}><Repeat size={15} />Every {t.repeatRule === "weekly" ? "week" : "month"}</span></dd></div>}
            {t.linkLabel && <div><dt>Linked to</dt><dd><span className="wf-chip"><Link2 size={14} />{t.linkLabel}</span></dd></div>}
            <div><dt>Created by</dt><dd>
              {t.createdBy?.name ?? "WindVeal"}
              {t.workspace !== "workflows" && <span className="muted"> · from {WORKSPACE_LABELS[t.workspace as keyof typeof WORKSPACE_LABELS] ?? t.workspace}</span>}
            </dd></div>
          </dl>
          {t.description && <p className="wf-desc">{t.description}</p>}

          <h4 className="section-label wf-sec">Checklist{data.items.length ? ` · ${itemsDone} of ${data.items.length}` : ""}</h4>
          <div className="wf-checklist">
            {data.items.map((i) => (
              <div key={i.id} className={`wf-item ${i.done ? "done" : ""}`}>
                <CircleToggle done={i.done} disabled={!editable} label={i.done ? "Mark not done" : "Mark done"}
                  onClick={() => run(() => api.patch(`/api/workflows/tasks/${t.id}/items/${i.id}`, { done: !i.done }))} />
                <span>{i.label}</span>
                {editable && <button className="icon-btn wf-item-x" aria-label={`Remove ${i.label}`} onClick={async () => {
                  if (await confirm({ title: "Remove this item?", message: `"${i.label}" will be taken off the checklist.`, confirmLabel: "Remove" })) run(() => api.del(`/api/workflows/tasks/${t.id}/items/${i.id}`));
                }}><X size={15} /></button>}
              </div>
            ))}
            {!data.items.length && !editable && <p className="muted">No checklist.</p>}
            {editable && (
              <form className="wf-add-item" onSubmit={(e) => {
                e.preventDefault();
                const label = newItem.trim();
                if (!label) return;
                setNewItem("");
                run(() => api.post(`/api/workflows/tasks/${t.id}/items`, { label }));
              }}>
                <Plus size={16} />
                <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add an item" aria-label="Add a checklist item" />
              </form>
            )}
          </div>

          <h4 className="section-label wf-sec">Files</h4>
          <div className="wf-files">
            {data.files.map((f) => (
              <span key={f.id} className="wf-file">
                <a href={fileUrl(f.id)} target="_blank" rel="noreferrer" title={`${f.name} · ${formatBytes(f.size)}`}><FileText size={15} />{f.name}</a>
                {editable && <button className="wf-file-x" aria-label={`Remove ${f.name}`} onClick={async () => {
                  if (await confirm({ title: "Remove this file?", message: `${f.name} will be taken off this task.`, confirmLabel: "Remove" })) run(() => api.del(`/api/workflows/tasks/${t.id}/files/${f.id}`), "File removed");
                }}><X size={13} /></button>}
              </span>
            ))}
            {editable && (
              <>
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => attach(e.target.files)} />
                <Button variant="secondary" size="sm" icon={<Plus size={15} />} loading={uploading} onClick={() => fileInput.current?.click()}>Attach</Button>
              </>
            )}
            {!data.files.length && !editable && <p className="muted">No files.</p>}
          </div>

          <h4 className="section-label wf-sec">Comments</h4>
          <div className="wf-comments">
            {data.comments.map((c) => (
              <div key={c.id} className="wf-comment">
                <Avatar name={c.author.name} size={30} />
                <div>
                  <p><b>{c.author.name}</b> <small>{timeAgo(c.createdAt)}</small></p>
                  <p className="wf-comment-body">{renderMentions(c.body)}</p>
                </div>
              </div>
            ))}
            {!data.comments.length && <p className="muted">No comments yet.</p>}
          </div>
          <form className="wf-comment-box" onSubmit={(e) => {
            e.preventDefault();
            const body = comment.trim();
            if (!body) return;
            run(async () => {
              const r = await api.post<{ mentioned: string[] }>(`/api/workflows/tasks/${t.id}/comments`, { body });
              setComment("");
              if (r.mentioned.length) toast(`Notified ${r.mentioned.join(", ")}`);
            });
          }}>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment, use @ to mention someone" aria-label="Comment" />
            <Button size="sm" type="submit" disabled={!comment.trim()}>Send</Button>
          </form>
          {mentionHint && members && (
            <div className="wf-mentions">
              {members.filter((m) => m.name.toLowerCase().startsWith((comment.match(/@(\S*)$/)?.[1] ?? "").toLowerCase())).slice(0, 5).map((m) => (
                <button key={m.id} type="button" onClick={() => setComment(comment.replace(/@\S*$/, `@${m.name} `))}><Avatar name={m.name} size={22} />{m.name}</button>
              ))}
            </div>
          )}

          {showActivity && (
            <>
              <h4 className="section-label wf-sec">Activity</h4>
              <ul className="wf-activity">
                {data.activity.map((a) => <li key={a.id}><span>{a.summary}</span><small>{fmtDate(a.createdAt)} · {fmtTime(a.createdAt)}</small></li>)}
                {!data.activity.length && <li className="muted">No activity recorded yet.</li>}
              </ul>
            </>
          )}
        </div>
      )}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} danger confirmLabel="Delete task" title="Delete this task?"
        onConfirm={() => { setConfirmDelete(false); run(() => api.del(`/api/workflows/tasks/${id}`), "Task deleted").then(onClose); }}>
        It will disappear from everyone's lists. Linked records and files are kept.
      </ConfirmDialog>
      {dialog}
    </Drawer>
  );
}

function renderMentions(body: string) {
  const parts = body.split(/(@[\p{L}][\p{L}'-]*(?: [\p{Lu}][\p{L}'-]*)?)/u);
  return parts.map((p, i) => (p.startsWith("@") ? <span key={i} className="wf-mention">{p}</span> : p));
}
