import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Download, LogIn, LogOut, Pencil, Coffee, Play } from "lucide-react";
import { Avatar, Button, EmptyState, IconButton, Input, Loading, Modal, Notice, Pill, SearchInput, Textarea, useToast, type Tone } from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import { useDebounced } from "./Directory";
import { fmtMinutes, localYmd } from "./lib";
import { fmtDuration, useMyClock } from "./clock";

type Status = "present" | "late" | "not_in" | "on_leave" | "sick";
type Row = {
  employee: { id: string; name: string; jobTitle: string | null; location: string | null };
  record: { id: string; clockIn: string | null; clockOut: string | null; source: string; note: string | null; corrected: boolean; onBreak: boolean } | null;
  status: Status; statusLabel: string; minutes: number | null; leaveType: string | null;
};
export type Board = { date: string; workdayStart: string; rows: Row[]; stats: { total: number; present: number; late: number; away: number; notIn: number } };

const TONE: Record<Status, Tone> = { present: "ok", late: "warn", not_in: "grey", on_leave: "blue", sick: "red" };

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** Your own day: clock-in and clock-out times, and the time worked (counting live only while you're clocked in). */
function MyDay() {
  const { user } = useSession();
  const c = useMyClock();
  const today = new Date();
  const first = user.name.split(" ")[0];
  return (
    <div className="ppl-clockbar">
      <div>
        <small>{today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</small>
        <h2>{greeting(today)}, {first}</h2>
      </div>
      {c.state === "none" ? (
        <small className="act">You're not on the team list. Ask an admin to add you back in People & HR.</small>
      ) : (
        <div className="ppl-myday">
          <div className="ppl-myday-times">
            <span>In <b>{c.record?.clockIn ? fmtTime(c.record.clockIn) : "—"}</b></span>
            <span>Out <b>{c.record?.clockOut ? fmtTime(c.record.clockOut) : "—"}</b></span>
          </div>
          {/* The total appears once there's time to show; before clocking in it's just the times and the button. */}
          {c.state !== "out" && (
            <div className="ppl-myday-total">
              <b>{fmtDuration(c.workedMs, c.state === "in")}</b>
              {c.state === "break" && <small>On a break</small>}
            </div>
          )}
          <div className="ppl-myday-actions">
            {c.state === "out" && <button className="btn ppl-clockbtn" disabled={c.busy} onClick={c.clockIn}><LogIn size={16} />Clock in</button>}
            {c.state === "in" && <button className="btn ppl-clockbtn ghost" disabled={c.busy} onClick={c.pause}><Coffee size={16} />Take a break</button>}
            {(c.state === "break" || c.state === "done") && <button className="btn ppl-clockbtn" disabled={c.busy} onClick={c.resume}><Play size={16} />Resume</button>}
            {(c.state === "in" || c.state === "break") && <button className="btn ppl-clockbtn" disabled={c.busy} onClick={c.clockOut}><LogOut size={16} />Clock out</button>}
          </div>
        </div>
      )}
      {c.dialog}
    </div>
  );
}

/** Someone's day in the team list: times small, the total underneath (no running count for other people). */
function DayCell({ r }: { r: Row }) {
  if (!r.record?.clockIn) return <span className="muted">—</span>;
  return (
    <div className="ppl-daycell">
      <small>{fmtTime(r.record.clockIn)} – {r.record.clockOut ? fmtTime(r.record.clockOut) : "now"}</small>
      {r.minutes != null ? <b>{fmtMinutes(r.minutes)}</b> : r.record.onBreak ? <span className="ppl-working break"><i />On a break</span> : <span className="ppl-working"><i />Still working</span>}
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
      <MyDay />
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
                  <th>Name</th><th className="hide-sm">Location</th><th>{date === localYmd() ? "Worked today" : "Worked"}</th><th>Status</th>
                  {canFix && <th aria-label="Correct" />}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r) => (
                  <tr key={r.employee.id}>
                    <td><div className="cell-main"><Avatar name={r.employee.name} size={36} /><div><b>{r.employee.name}</b><small>{r.employee.jobTitle ?? "—"}</small></div></div></td>
                    <td className="hide-sm">{r.employee.location ?? "—"}</td>
                    <td><DayCell r={r} /></td>
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
