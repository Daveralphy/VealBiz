import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Building2, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { Avatar, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, Loading, Menu, Modal, Notice, Pill, SearchInput, Select, useToast } from "@windveal/ui";
import { api } from "../../lib/api";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { peopleKeys, useDepartments, useEmployeeOptions, type Department, type Employee } from "./lib";

type ChartNode = { id: string; name: string; jobTitle: string | null; departmentName: string | null; reportsCount: number };
type Chart = { top: (ChartNode & { reports: ChartNode[] })[]; total: number };

export function Departments() {
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Department | "new" | null>(null);
  const [del, setDel] = useState<Department | null>(null);
  const [full, setFull] = useState(false);
  const depts = useDepartments();
  const chart = useQuery({ queryKey: ["people", "org-chart"], queryFn: () => api.get<Chart>("/api/people/org-chart") });
  const canManage = can("people", "manage");
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/people/departments/${id}`),
    onSuccess: () => { setDel(null); toast("Department deleted"); qc.invalidateQueries({ queryKey: peopleKeys.all }); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const list = (depts.data ?? []).filter((d) => !search.trim() || d.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search departments" />
        <span className="grow" />
        {canManage && <Button variant="secondary" icon={<Plus size={16} />} onClick={() => setEdit("new")}>New department</Button>}
      </div>

      <Card title="Reporting structure" subtitle="Who reports to whom, built from each person's manager."
        actions={chart.data && chart.data.total > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setFull(true)}>Full chart<ChevronRight size={15} /></button>}>
        {chart.isLoading ? <Loading /> : chart.isError ? <Notice tone="error">{(chart.error as Error).message}</Notice>
          : !chart.data?.total ? <p className="muted">Add people and set their managers to see your reporting structure.</p>
          : <OrgChart chart={chart.data} />}
      </Card>

      {depts.isLoading ? <Loading /> : depts.isError ? <Notice tone="error">{(depts.error as Error).message}</Notice>
        : list.length === 0 ? (
          <div className="card" style={{ marginTop: 20 }}>
            <EmptyState title={search ? "No departments match" : "No departments yet"} icon={<Building2 size={24} />}
              action={canManage && !search ? <Button icon={<Plus size={16} />} onClick={() => setEdit("new")}>New department</Button> : undefined}>
              {search ? "Try a different search." : "Group people into departments like Sales, Operations or Finance."}
            </EmptyState>
          </div>
        ) : (
          <div className="ppl-depts">
            {list.map((d) => (
              <div key={d.id} className="ppl-dept" role="link" tabIndex={0} onClick={() => navigate(`/people?departmentId=${d.id}`)}
                onKeyDown={(e) => e.key === "Enter" && navigate(`/people?departmentId=${d.id}`)}>
                <div className="between">
                  <h3>{d.name}</h3>
                  <div className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <Pill tone="grey">{d.count} {d.count === 1 ? "person" : "people"}</Pill>
                    {canManage && (
                      <Menu trigger={(t) => <IconButton label={`Options for ${d.name}`} onClick={t}><MoreHorizontal size={17} /></IconButton>}>
                        {(close) => <>
                          <button onClick={() => { close(); setEdit(d); }}>Edit department</button>
                          <button className="danger" onClick={() => { close(); setDel(d); }}>Delete department</button>
                        </>}
                      </Menu>
                    )}
                  </div>
                </div>
                {d.head ? (
                  <div className="ppl-head"><Avatar name={d.head.name} size={30} /><div><b>{d.head.name}</b><small>{d.head.jobTitle ?? "Head of department"}</small></div></div>
                ) : <div className="ppl-head empty"><small>No head set</small></div>}
                <div className="ppl-stack-avatars">
                  {d.members.slice(0, 5).map((m) => <Avatar key={m.id} name={m.name} size={24} />)}
                  {d.members.length > 5 && <span className="more">+{d.members.length - 5}</span>}
                  {d.members.length === 0 && <small className="muted">No one yet</small>}
                </div>
              </div>
            ))}
          </div>
        )}
      {edit && <DepartmentModal dept={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} loading={remove.isPending} danger
        title={`Delete ${del?.name}?`} confirmLabel="Delete department">
        <p>{del?.count ? `The ${del.count} ${del.count === 1 ? "person" : "people"} in it will have no department. ` : ""}No one is removed from People & HR.</p>
      </ConfirmDialog>
      {full && <FullChart onClose={() => setFull(false)} />}
    </>
  );
}

function OrgChart({ chart }: { chart: Chart }) {
  // One leader at the top (the usual case): leader with their direct reports below.
  const leaders = chart.top.filter((t) => t.reports.length > 0);
  const loose = chart.top.filter((t) => t.reports.length === 0);
  return (
    <div className="ppl-chart">
      {leaders.map((t) => (
        <div key={t.id} className="ppl-chart-tree">
          <ChartCard n={t} lead />
          <div className="ppl-chart-line" />
          <div className="ppl-chart-row">
            {t.reports.map((r) => <ChartCard key={r.id} n={r} />)}
          </div>
        </div>
      ))}
      {loose.length > 0 && (
        <div className="ppl-chart-loose">
          {leaders.length > 0 && <small className="muted">No manager set</small>}
          <div className="ppl-chart-row">{loose.map((r) => <ChartCard key={r.id} n={r} />)}</div>
        </div>
      )}
    </div>
  );
}

function ChartCard({ n, lead }: { n: ChartNode; lead?: boolean }) {
  return (
    <Link to={`/people/${n.id}`} className={`ppl-node ${lead ? "lead" : ""}`}>
      <Avatar name={n.name} size={34} />
      <div>
        <b>{n.name}</b>
        <small>{lead ? n.jobTitle ?? "—" : [n.departmentName ?? n.jobTitle, n.reportsCount ? String(n.reportsCount) : null].filter(Boolean).join(" · ") || "—"}</small>
      </div>
    </Link>
  );
}

type TreeNode = Employee & { children: TreeNode[] };

function FullChart({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ["people", "employees", "chart"], queryFn: () => api.get<{ items: Employee[] }>("/api/people/employees?pageSize=200") });
  const roots = useMemo(() => {
    const items = q.data?.items ?? [];
    const map = new Map<string, TreeNode>(items.map((e) => [e.id, { ...e, children: [] }]));
    const out: TreeNode[] = [];
    for (const n of map.values()) {
      const p = n.managerId ? map.get(n.managerId) : undefined;
      if (p) p.children.push(n); else out.push(n);
    }
    return out;
  }, [q.data]);
  const render = (n: TreeNode) => (
    <li key={n.id}>
      <Link to={`/people/${n.id}`} className="ppl-tree-item" onClick={onClose}>
        <Avatar name={n.name} size={26} /><span><b>{n.name}</b> <small className="muted">{n.jobTitle ?? ""}</small></span>
      </Link>
      {n.children.length > 0 && <ul>{n.children.map(render)}</ul>}
    </li>
  );
  return (
    <Modal open onClose={onClose} title="Full reporting chart" size="lg">
      {q.isLoading ? <Loading /> : q.isError ? <Notice tone="error">{(q.error as Error).message}</Notice> : <ul className="ppl-tree">{roots.map(render)}</ul>}
    </Modal>
  );
}

function DepartmentModal({ dept, onClose }: { dept: Department | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const options = useEmployeeOptions();
  const f = useForm({ name: dept?.name ?? "", headEmployeeId: dept?.headEmployeeId ?? "" });
  const save = () => f.submit(async (v) => {
    if (dept) await api.patch(`/api/people/departments/${dept.id}`, v); else await api.post("/api/people/departments", v);
    toast(dept ? "Department saved" : `${v.name} department created`);
    qc.invalidateQueries({ queryKey: peopleKeys.all });
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={dept ? `Edit ${dept.name}` : "New department"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>{dept ? "Save" : "Create department"}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Name" autoFocus placeholder="e.g. Operations" {...f.bind("name")} />
        <Select label="Head of department" optional {...f.bind("headEmployeeId")} placeholder="No one yet"
          options={(options.data ?? []).map((o) => ({ value: o.id, label: o.jobTitle ? `${o.name} · ${o.jobTitle}` : o.name }))} />
      </form>
    </Modal>
  );
}
