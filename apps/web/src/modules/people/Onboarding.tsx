import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Check, ClipboardList, Plus } from "lucide-react";
import { Avatar, Button, Card, EmptyState, Input, Loading, Modal, Notice, Progress, Select, useToast } from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { dayLabel, fmtDate, isOverdue } from "../../lib/format";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { localYmd, peopleKeys } from "./lib";

type ChecklistItem = {
  id: string; kind: "onboarding" | "offboarding"; title: string; status: "in_progress" | "done"; templateName: string | null; total: number; done: number;
  employee: { id: string; name: string; jobTitle: string | null; startDate: string | null; endDate: string | null; status: string };
};
type Task = {
  id: string; title: string; description: string | null; status: "todo" | "in_progress" | "done"; dueAt: string | null; completedAt: string | null;
  assignee: { id: string; name: string } | null; canToggle: boolean;
};
type Detail = Omit<ChecklistItem, "employee"> & {
  employee: ChecklistItem["employee"] & { firstName: string };
  groups: { name: string; tasks: Task[] }[];
};

function subline(c: ChecklistItem) {
  const e = c.employee;
  const short = (d: string) => fmtDate(d, { day: "numeric", month: "short" });
  if (c.kind === "offboarding") return `Leaving${e.endDate ? ` · last day ${short(e.endDate)}` : ""}`;
  const today = localYmd();
  const when = e.startDate ? (e.startDate > today ? short(e.startDate) : `started ${short(e.startDate)}`) : "";
  return ["Starting", e.jobTitle, when].filter(Boolean).join(" · ");
}

export function OnboardingPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("in_progress");
  const list = useQuery({ queryKey: ["people", "checklists", status], queryFn: () => api.get<ChecklistItem[]>(`/api/people/checklists${qs({ status })}`) });
  const selected = params.get("id") ?? list.data?.[0]?.id ?? null;
  const select = (id: string) => setParams((p) => { p.set("id", id); return p; }, { replace: true });

  return (
    <div className="ppl-onb">
      <div>
        <div className="between" style={{ marginBottom: 14 }}>
          <select className="select chip-select" aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="in_progress">In progress</option>
            <option value="done">Completed</option>
            <option value="all">All</option>
          </select>
          <Link to="/workflows/templates" className="btn btn-ghost btn-sm">Checklist templates</Link>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <Notice tone="error">{(list.error as Error).message}</Notice>
          : !list.data?.length ? (
            <div className="card"><EmptyState title={status === "done" ? "No completed checklists" : "No one is onboarding right now"} icon={<ClipboardList size={24} />}>
              Checklists start when you add someone with "Start the onboarding checklist" ticked, or mark someone as leaving.
            </EmptyState></div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {list.data.map((c) => (
                <button key={c.id} className={`ppl-onb-item ${c.id === selected ? "on" : ""}`} onClick={() => select(c.id)}>
                  <Avatar name={c.employee.name} size={40} />
                  <div>
                    <b>{c.employee.name}</b>
                    <small>{subline(c)}</small>
                    <div className={`ppl-bar ${c.kind === "offboarding" ? "warn" : ""}`}><Progress value={c.total ? (c.done / c.total) * 100 : 0} /></div>
                  </div>
                </button>
              ))}
            </div>
          )}
      </div>
      <div>{selected && <ChecklistDetail id={selected} />}</div>
    </div>
  );
}

function ChecklistDetail({ id }: { id: string }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const key = ["people", "checklist", id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/api/people/checklists/${id}`) });
  const toggle = useMutation({
    mutationFn: (t: Task) => api.patch(`/api/people/checklists/${id}/tasks/${t.id}`, { done: t.status !== "done" }),
    onMutate: async (t) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Detail>(key);
      if (prev) {
        const flip = (x: Task) => (x.id === t.id ? { ...x, status: x.status === "done" ? "todo" as const : "done" as const } : x);
        const groups = prev.groups.map((g) => ({ ...g, tasks: g.tasks.map(flip) }));
        qc.setQueryData<Detail>(key, { ...prev, groups, done: groups.flatMap((g) => g.tasks).filter((x) => x.status === "done").length });
      }
      return { prev };
    },
    onError: (e: Error, _t, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); toast(e.message, "error"); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["people", "checklists"] }); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: peopleKeys.stats }); },
  });

  if (q.isLoading) return <Card><Loading /></Card>;
  if (q.isError || !q.data) return <Card><EmptyState title="Couldn't load this checklist">{(q.error as Error)?.message}</EmptyState></Card>;
  const d = q.data;
  return (
    <Card title={<Link to={`/people/${d.employee.id}`}>{d.employee.name}'s {d.kind}</Link>}
      subtitle={`${d.done} of ${d.total} done${d.templateName ? ` · from the "${d.templateName}" template` : ""} · tasks also appear in Workflows`}
      actions={can("people", "edit") && <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add task</Button>}>
      {d.groups.length === 0 ? <p className="muted">No tasks yet.</p> : d.groups.map((g) => (
        <div key={g.name} className="ppl-group">
          <div className="section-label">{g.name}</div>
          {g.tasks.map((t) => {
            const done = t.status === "done";
            const od = !done && isOverdue(t.dueAt);
            return (
              <div key={t.id} className={`ppl-task ${done ? "done" : ""}`}>
                <button className={`circle-check ${done ? "done" : ""}`} aria-label={done ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`}
                  disabled={!t.canToggle || toggle.isPending} onClick={() => toggle.mutate(t)}>
                  {done && <Check size={12} strokeWidth={3} />}
                </button>
                <div className="grow">
                  <b>{t.title}</b>
                  {t.description && <small>{t.description}</small>}
                </div>
                {t.assignee && <Avatar name={t.assignee.name} size={26} />}
                <span className={`ppl-due ${od ? "od" : ""}`}>{done ? "Done" : t.dueAt ? (od ? `Overdue · ${dayLabel(t.dueAt)}` : `Due ${dayLabel(t.dueAt)}`) : "—"}</span>
              </div>
            );
          })}
        </div>
      ))}
      {adding && <AddTaskModal checklist={d} onClose={() => setAdding(false)} onSaved={() => qc.invalidateQueries({ queryKey: ["people"] })} />}
    </Card>
  );
}

function AddTaskModal({ checklist, onClose, onSaved }: { checklist: Detail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<{ userId: string; name: string; status: string }[]>("/api/members") });
  const groups = useMemo(() => checklist.groups.map((g) => g.name), [checklist]);
  const f = useForm({ title: "", description: "", group: groups[0] ?? "", newGroup: "", assigneeUserId: "", dueDate: "" });
  useEffect(() => { if (!groups.length) f.set("group", "__new"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const save = () => f.submit(async (v) => {
    await api.post(`/api/people/checklists/${checklist.id}/tasks`, {
      title: v.title, description: v.description, group: v.group === "__new" ? v.newGroup : v.group, assigneeUserId: v.assigneeUserId, dueDate: v.dueDate,
    });
    toast("Task added");
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Add task" subtitle={`To ${checklist.employee.name}'s ${checklist.kind}. It also appears in Workflows.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Add task</Button></>}>
      <div className="stack">
        <Input label="Task" autoFocus placeholder="e.g. Order laptop" {...f.bind("title")} />
        <Input label="Details" optional {...f.bind("description")} />
        <div className="form-grid">
          <Select label="Group" {...f.bind("group")} options={[...groups.map((g) => ({ value: g, label: g })), { value: "__new", label: "New group…" }]} />
          {f.values.group === "__new" ? <Input label="Group name" placeholder="e.g. First week" {...f.bind("newGroup")} /> : <span />}
          <Select label="Assign to" optional {...f.bind("assigneeUserId")} placeholder="No one yet"
            options={(members.data ?? []).filter((m) => m.status === "active").map((m) => ({ value: m.userId, label: m.name }))} />
          <Input label="Due date" optional type="date" {...f.bind("dueDate")} />
        </div>
      </div>
    </Modal>
  );
}
