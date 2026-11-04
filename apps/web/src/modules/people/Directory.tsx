import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LayoutGrid, List, MoreHorizontal, Plus, Users } from "lucide-react";
import { Avatar, Button, EmptyState, IconButton, Loading, Menu, Notice, Pill, SearchInput } from "@windveal/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { STATUS, monthYear, statusLabel, useDepartments, type Employee } from "./lib";

type ListResponse = { items: Employee[]; total: number; page: number; pageSize: number; locations: string[] };

const STATUS_OPTIONS = [
  { value: "current", label: "Current" }, { value: "active", label: "Active" }, { value: "onboarding", label: "Onboarding" },
  { value: "on_leave", label: "On leave" }, { value: "leaving", label: "Leaving" }, { value: "left", label: "Left" }, { value: "all", label: "Everyone" },
];
const PAGE_SIZE = 20;

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function readView(): "list" | "grid" {
  try { return localStorage.getItem("wv.people.view") === "grid" ? "grid" : "list"; } catch { return "list"; }
}

export function Directory({ onAdd }: { onAdd: () => void }) {
  const navigate = useNavigate();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDebounced(search);
  const departmentId = params.get("departmentId") ?? "";
  const location = params.get("location") ?? "";
  const status = params.get("status") ?? "current";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [view, setView] = useState<"list" | "grid">(readView);
  const depts = useDepartments();

  const setParam = (k: string, v: string) => setParams((p) => {
    if (v) p.set(k, v); else p.delete(k);
    if (k !== "page") p.delete("page");
    return p;
  }, { replace: true });
  useEffect(() => { if ((params.get("q") ?? "") !== q) setParam("q", q); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);
  const changeView = (v: "list" | "grid") => { setView(v); try { localStorage.setItem("wv.people.view", v); } catch { /* ignore */ } };

  const list = useQuery({
    queryKey: ["people", "employees", { q, departmentId, location, status, page }],
    queryFn: () => api.get<ListResponse>(`/api/people/employees?${new URLSearchParams({ search: q, departmentId, location, status, page: String(page), pageSize: String(PAGE_SIZE) })}`),
    placeholderData: keepPreviousData,
  });

  const data = list.data;
  const filtered = !!(q || departmentId || location || status !== "current");
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>

      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, role or department" />
        <select className="select chip-select" aria-label="Department" value={departmentId} onChange={(e) => setParam("departmentId", e.target.value)}>
          <option value="">Department: All</option>
          {(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value="none">No department</option>
        </select>
        <select className="select chip-select" aria-label="Location" value={location} onChange={(e) => setParam("location", e.target.value)}>
          <option value="">Location: All</option>
          {(data?.locations ?? []).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <select className="select chip-select" aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value === "current" ? "" : e.target.value)}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>Status: {o.label}</option>)}
        </select>
        <span className="grow" />
        <div className="ppl-viewtoggle hide-sm" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === "list"} className={view === "list" ? "on" : ""} onClick={() => changeView("list")} title="List"><List size={17} /></button>
          <button role="radio" aria-checked={view === "grid"} className={view === "grid" ? "on" : ""} onClick={() => changeView("grid")} title="Grid"><LayoutGrid size={17} /></button>
        </div>
      </div>

      {list.isLoading ? <Loading /> : list.isError ? (
        <Notice tone="error" action={<button className="btn btn-ghost btn-sm" onClick={() => list.refetch()}>Try again</button>}>
          {(list.error as Error).message}
        </Notice>
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          {filtered ? (
            <EmptyState title="No one matches" icon={<Users size={24} />}>Try a different search or clear the filters.</EmptyState>
          ) : (
            <EmptyState title="No one here yet" icon={<Users size={24} />}
              action={can("people", "edit") ? <Button icon={<Plus size={16} />} onClick={onAdd}>Add your first employee</Button> : undefined}>
              Add the people who work with you to keep their details, leave and documents in one place.
            </EmptyState>
          )}
        </div>
      ) : (
        <>
          {view === "list" ? (
            <div className="table-wrap ppl-table">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th><th className="hide-sm">Department</th><th className="hide-sm">Manager</th><th className="hide-sm">Location</th>
                    <th className="hide-sm">Started</th><th>Status</th><th className="hide-sm" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => navigate(`/people/${e.id}`)}>
                      <td>
                        <div className="cell-main"><Avatar name={e.name} size={36} /><div><b>{e.name}</b><small>{e.jobTitle || "—"}</small></div></div>
                      </td>
                      <td className="hide-sm">{e.departmentName ?? "—"}</td>
                      <td className="hide-sm">{e.managerName ?? "—"}</td>
                      <td className="hide-sm">{e.location ?? "—"}</td>
                      <td className="hide-sm">{monthYear(e.startDate)}</td>
                      <td><Pill tone={STATUS[e.status].tone}>{statusLabel(e)}</Pill></td>
                      <td className="hide-sm num" onClick={(ev) => ev.stopPropagation()}>
                        <Menu trigger={(toggle) => <IconButton label={`Actions for ${e.name}`} onClick={toggle}><MoreHorizontal size={18} /></IconButton>}>
                          {(close) => <>
                            <button onClick={() => { close(); navigate(`/people/${e.id}`); }}>View profile</button>
                            {e.email && <a href={`mailto:${e.email}`} onClick={close}>Send email</a>}
                            {e.departmentId && <button onClick={() => { close(); setParam("departmentId", e.departmentId!); }}>Show {e.departmentName}</button>}
                          </>}
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="ppl-grid">
              {data.items.map((e) => (
                <button key={e.id} className="ppl-person" onClick={() => navigate(`/people/${e.id}`)}>
                  <Avatar name={e.name} size={52} />
                  <b>{e.name}</b>
                  <small>{e.jobTitle || "—"}</small>
                  <small className="muted">{[e.departmentName, e.location].filter(Boolean).join(" · ") || " "}</small>
                  <Pill tone={STATUS[e.status].tone}>{statusLabel(e)}</Pill>
                </button>
              ))}
            </div>
          )}
          <Pager page={page} pages={pages} total={data.total} shown={data.items.length} pageSize={PAGE_SIZE} onPage={(p) => setParam("page", p > 1 ? String(p) : "")} />
        </>
      )}
    </>
  );
}

export function Pager({ page, pages, total, shown, pageSize, onPage }: { page: number; pages: number; total: number; shown: number; pageSize: number; onPage: (p: number) => void }) {
  const from = (page - 1) * pageSize + 1;
  const nums: (number | "…")[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <div className="ppl-pager">
      <span className="muted">Showing {from} to {from + shown - 1} of {total}</span>
      {pages > 1 && (
        <div className="row" style={{ gap: 6 }}>
          {nums.map((n, i) => n === "…"
            ? <span key={`e${i}`} className="ppl-page dots">…</span>
            : <button key={n} className={`ppl-page ${n === page ? "on" : ""}`} aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>)}
        </div>
      )}
    </div>
  );
}
