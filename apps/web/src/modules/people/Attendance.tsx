import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Download, LogIn, LogOut, Pencil } from "lucide-react";
import { Avatar, Button, EmptyState, IconButton, Input, Loading, Modal, Notice, Pill, SearchInput, Stat, Textarea, useToast, type Tone } from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { useDebounced } from "./Directory";
import { fmtMinutes, localYmd } from "./lib";

type Status = "present" | "late" | "not_in" | "on_leave" | "sick";
type Row = {
  employee: { id: string; name: string; jobTitle: string | null; location: string | null };
  record: { id: string; clockIn: string | null; clockOut: string | null; source: string; note: string | null; corrected: boolean } | null;
  status: Status; statusLabel: string; minutes: number | null; leaveType: string | null;
};
type Board = { date: string; workdayStart: string; rows: Row[]; stats: { total: number; present: number; late: number; away: number; notIn: number } };
type Me = { employee: { id: string; firstName: string } | null; record: { clockIn: string | null; clockOut: string | null } | null; date: string };

const TONE: Record<Status, Tone> = { present: "ok", late: "warn", not_in: "grey", on_leave: "blue", sick: "red" };

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function ClockBar() {
  const { user } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const now = useNow();
  const me = useQuery({ queryKey: ["people", "attendance", "me"], queryFn: () => api.get<Me>("/api/people/attendance/me") });
  const clock = useMutation({
    mutationFn: (dir: "in" | "out") => api.post(`/api/people/attendance/clock-${dir}`),
    onSuccess: (_d, dir) => { toast(dir === "in" ? "You're clocked in" : "You're clocked out. See you tomorrow."); qc.invalidateQueries({ queryKey: ["people", "attendance"] }); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const r = me.data?.record;
  const first = me.data?.employee?.firstName ?? user.name.split(" ")[0];
  return (
    <div className="ppl-clockbar">
      <div>
        <small>{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</small>
        <h2>{greeting(now)}, {first}</h2>
      </div>
      <b className="time" aria-live="off">{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b>
      <div className="act">
        {me.isLoading ? null : !me.data?.employee ? (
          <small>Ask HR to add you to People & HR to clock in.</small>
        ) : r?.clockOut ? (
          <small>Clocked in {fmtTime(r.clockIn)} · out {fmtTime(r.clockOut)}</small>
        ) : r?.clockIn ? (
          <>
            <small className="hide-sm">In since {fmtTime(r.clockIn)}</small>
            <button className="btn ppl-clockbtn" disabled={clock.isPending} onClick={() => clock.mutate("out")}><LogOut size={16} />Clock out</button>
          </>
        ) : (
          <button className="btn ppl-clockbtn" disabled={clock.isPending} onClick={() => clock.mutate("in")}><LogIn size={16} />Clock in</button>
        )}
      </div>
    </div>
  );
}

export function AttendancePage() {
  const { can, hasSpecial } = useSession();
  const [date, setDate] = useState(localYmd());
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("");
  const [fixing, setFixing] = useState<Row | null>(null);
  const q = useDebounced(search);
  const board = useQuery({
    queryKey: ["people", "attendance", "board", date, q, location],
    queryFn: () => api.get<Board>(`/api/people/attendance${qs({ date, search: q, location })}`),
    refetchInterval: date === localYmd() ? 60_000 : false,
  });
  const locs = useQuery({ queryKey: ["people", "locations"], queryFn: () => api.get<{ locations: string[] }>("/api/people/employees?pageSize=1&status=all").then((r) => r.locations) });
  const b = board.data;
  const canFix = can("people", "edit");
  return (
    <>
      <ClockBar />
      <div className="stats">
        <Stat label="Present" value={b?.stats.present ?? "—"} note={b ? `of ${b.stats.total}` : undefined} />
        <Stat label="Late" value={b?.stats.late ?? "—"} note={b ? `after ${b.workdayStart}` : undefined} />
        <Stat label="On leave or sick" value={b?.stats.away ?? "—"} note="approved" />
        <Stat label="Not in yet" value={b?.stats.notIn ?? "—"} note="no clock-in" />
      </div>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search people" />
        <input className="input chip-select ppl-date" type="date" aria-label="Date" value={date} max={localYmd()} onChange={(e) => setDate(e.target.value || localYmd())} />
        <select className="select chip-select" aria-label="Location" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">Location: All</option>
          {(locs.data ?? []).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <span className="grow" />
        {hasSpecial("export_data") && (
          <a className="btn btn-secondary hide-sm" href={`/api/people/attendance/export${qs({ date, location, search: q })}`} download><Download size={16} />Export</a>
        )}
      </div>
      {board.isLoading ? <Loading /> : board.isError ? <Notice tone="error">{(board.error as Error).message}</Notice>
        : !b?.rows.length ? <div className="card"><EmptyState title="No one to show" icon={<Clock size={24} />}>{q || location ? "Try a different search or location." : "Add people in the Directory to track attendance."}</EmptyState></div>
        : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th className="hide-sm">Location</th><th>Clock in</th><th className="hide-sm">Clock out</th><th className="hide-sm">Hours</th><th>Status</th>
                  {canFix && <th aria-label="Correct" />}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r) => (
                  <tr key={r.employee.id}>
                    <td><div className="cell-main"><Avatar name={r.employee.name} size={36} /><div><b>{r.employee.name}</b><small>{r.employee.jobTitle ?? "—"}</small></div></div></td>
                    <td className="hide-sm">{r.employee.location ?? "—"}</td>
                    <td>{fmtTime(r.record?.clockIn)}</td>
                    <td className="hide-sm">{fmtTime(r.record?.clockOut)}</td>
                    <td className="hide-sm">{fmtMinutes(r.minutes)}</td>
                    <td><Pill tone={TONE[r.status]}>{r.statusLabel}</Pill>{r.record?.corrected && <small className="muted ppl-corrected" title={r.record.note ?? undefined}> corrected</small>}</td>
                    {canFix && <td className="num"><IconButton label={`Correct ${r.employee.name}'s times`} onClick={() => setFixing(r)}><Pencil size={15} /></IconButton></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <p className="muted ppl-foot">People clock in from WindVeal on their computer or phone. Managers can correct times, and every change is recorded.</p>
      {fixing && <CorrectionModal row={fixing} date={date} onClose={() => setFixing(null)} />}
    </>
  );
}

const hm = (iso: string | null | undefined) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "");

function CorrectionModal({ row, date, onClose }: { row: Row; date: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const f = useForm({ clockIn: hm(row.record?.clockIn), clockOut: hm(row.record?.clockOut), note: "" });
  const toIso = (t: string) => (t ? new Date(`${date}T${t}:00`).toISOString() : null);
  const save = () => f.submit(async (v) => {
    await api.post("/api/people/attendance/corrections", { employeeId: row.employee.id, date, clockIn: toIso(v.clockIn), clockOut: toIso(v.clockOut), note: v.note });
    toast(`${row.employee.name}'s times were corrected`);
    qc.invalidateQueries({ queryKey: ["people", "attendance"] });
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={`Correct ${row.employee.name}'s times`} subtitle={new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Save correction</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label="Clock in" type="time" {...f.bind("clockIn")} />
          <Input label="Clock out" type="time" optional {...f.bind("clockOut")} />
        </div>
        <Textarea label="Reason for the change" rows={2} placeholder="e.g. Forgot to clock in, arrived at 8:05" hint="Recorded in the audit history." {...f.bind("note")} />
      </div>
    </Modal>
  );
}
