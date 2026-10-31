import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Avatar, Button, Card, Checkbox, ConfirmDialog, EmptyState, IconButton, Input, Loading, Modal, Notice, Pill, Segmented, Select, Textarea, useConfirm, useToast,
} from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { useForm } from "../../lib/form";
import { useSession } from "../../lib/session";
import {
  addDaysYmd, localYmd, mondayOfYmd, peopleKeys, useDepartments, useEmployeeOptions, useLeaveTypes, useStats,
  type Balance, type LeaveRequest, type LeaveType,
} from "./lib";

const short = (d: string) => fmtDate(d, { day: "numeric", month: "short" });
const range = (a: string, b: string) => (a === b ? short(a) : `${short(a)} to ${short(b)}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function balanceText(b: Balance) {
  return b.daysPerYear == null ? "With approval" : `${b.remaining} of ${b.daysPerYear} days left`;
}

const STATUS_TONE = { pending: "warn", approved: "ok", declined: "red", cancelled: "grey" } as const;

export function LeaveRequestRow({ r, showStatus, actions }: { r: LeaveRequest; showStatus?: boolean; actions?: ReactNode }) {
  const today = localYmd();
  const when = r.startDate === today ? "Today" : range(r.startDate, r.endDate);
  return (
    <div className="list-row ppl-leave-row">
      <Avatar name={r.employee?.name ?? "?"} size={36} />
      <div className="grow">
        <b className="ink">{r.employee?.name ?? "Someone"} · {r.leaveType?.name ?? "Leave"}</b>
        <small className="muted">
          {when} · {plural(r.days, "day")}
          {r.remainingAfter != null && ` · ${r.remainingAfter} left after`}
          {r.reason && ` · ${r.reason.length > 60 ? `${r.reason.slice(0, 60)}…` : r.reason}`}
        </small>
        {r.status === "pending" && r.clash.count > 0 && (
          <small className="ppl-clash">{plural(r.clash.count, "other person")} in {r.employee?.departmentName ?? "the team"} {r.clash.count === 1 ? "is" : "are"} off{r.clash.day ? ` on ${short(r.clash.day)}` : ""}</small>
        )}
        {r.status === "pending" && r.approverName && !actions && <small className="muted">Waiting for {r.approverName}</small>}
        {r.decisionNote && r.status !== "pending" && <small className="muted">“{r.decisionNote}”</small>}
      </div>
      {showStatus && <Pill tone={STATUS_TONE[r.status]}>{r.status[0]!.toUpperCase() + r.status.slice(1)}</Pill>}
      {actions}
    </div>
  );
}

export function RequestLeaveModal({ open, onClose, employeeId, employeeName }: { open: boolean; onClose: () => void; employeeId?: string; employeeName?: string }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useLeaveTypes();
  const stats = useStats();
  const canForOthers = can("people", "edit");
  const options = useEmployeeOptions(open && canForOthers && !employeeId);
  const f = useForm({ employeeId: employeeId ?? "", leaveTypeId: "", startDate: "", endDate: "", reason: "" });
  useEffect(() => {
    if (open) f.setValues({ employeeId: employeeId ?? "", leaveTypeId: types.data?.[0]?.id ?? "", startDate: "", endDate: "", reason: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && !f.values.leaveTypeId && types.data?.[0]) f.set("leaveTypeId", types.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.data, open]);
  const who = f.values.employeeId || stats.data?.myEmployeeId || "";
  const balances = useQuery({
    queryKey: ["people", "balances", who], enabled: open && !!who,
    queryFn: () => api.get<{ balances: Balance[] }>(`/api/people/leave/balances${qs({ employeeId: who })}`),
  });
  const { startDate, endDate } = f.values;
  const days = useQuery({
    queryKey: ["people", "working-days", startDate, endDate], enabled: open && !!startDate && !!endDate && endDate >= startDate,
    queryFn: () => api.get<{ days: number }>(`/api/people/leave/working-days${qs({ startDate, endDate })}`),
  });
  const type = types.data?.find((t) => t.id === f.values.leaveTypeId);
  const bal = balances.data?.balances.find((b) => b.leaveTypeId === f.values.leaveTypeId);
  const noRecord = !employeeId && !f.values.employeeId && stats.data && !stats.data.myEmployeeId;

  const save = () => f.submit(async (v) => {
    await api.post("/api/people/leave/requests", { ...v, employeeId: v.employeeId || undefined, endDate: v.endDate || v.startDate });
    toast("Leave request sent for approval");
    qc.invalidateQueries({ queryKey: peopleKeys.all });
    onClose();
  });

  return (
    <Modal open={open} onClose={onClose} title={employeeName ? `Request leave for ${employeeName}` : "Request leave"}
      subtitle="Weekends and public holidays aren't counted."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} disabled={!!noRecord} onClick={save}>Send request</Button></>}>
      {noRecord && !canForOthers && <Notice tone="warn">You don't have an employee record yet. Ask HR to add you to People & HR first.</Notice>}
      <div className="stack">
        {canForOthers && !employeeId && (
          <Select label="For" {...f.bind("employeeId")} placeholder={stats.data?.myEmployeeId ? "Myself" : "Choose a person"}
            options={(options.data ?? []).filter((o) => o.id !== stats.data?.myEmployeeId).map((o) => ({ value: o.id, label: o.name }))} />
        )}
        <Select label="Type of leave" {...f.bind("leaveTypeId")} options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          hint={bal ? balanceText(bal) + (bal.pending ? ` · ${bal.pending} waiting for approval` : "") : undefined} />
        <div className="form-grid">
          <Input label="First day" type="date" {...f.bind("startDate")} onChange={(e) => { f.set("startDate", e.target.value); if (!f.values.endDate || f.values.endDate < e.target.value) f.set("endDate", e.target.value); }} />
          <Input label="Last day" type="date" min={startDate || undefined} {...f.bind("endDate")} />
        </div>
        {days.data && <p className="ppl-days"><b>{plural(days.data.days, "working day")}</b>{bal?.remaining != null && <span className="muted"> · {Math.max(0, bal.remaining - bal.pending - days.data.days)} left after</span>}</p>}
        <Textarea label={type?.requiresNote ? "Note" : "Reason"} optional={!type?.requiresNote} rows={3}
          placeholder={type?.requiresNote ? `A note is needed for ${type.name.toLowerCase()}` : "Anything your manager should know"} {...f.bind("reason")} />
      </div>
    </Modal>
  );
}

export function LeavePage() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [requesting, setRequesting] = useState(false);
  const [declining, setDeclining] = useState<LeaveRequest | null>(null);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const waiting = useQuery({ queryKey: ["people", "leave", "waiting"], queryFn: () => api.get<LeaveRequest[]>("/api/people/leave/requests?scope=waiting") });
  const listQ = useQuery({ queryKey: ["people", "leave", scope], queryFn: () => api.get<LeaveRequest[]>(`/api/people/leave/requests?scope=${scope}`) });
  const myBal = useQuery({ queryKey: ["people", "balances", "me"], queryFn: () => api.get<{ employee: { id: string } | null; balances: Balance[] }>("/api/people/leave/balances") });

  const decide = useMutation({
    mutationFn: ({ id, outcome, note }: { id: string; outcome: "approve" | "decline"; note?: string }) =>
      api.post(`/api/people/leave/requests/${id}/${outcome}`, { note }),
    onSuccess: (_d, v) => { toast(v.outcome === "approve" ? "Leave approved" : "Leave declined"); setDeclining(null); qc.invalidateQueries({ queryKey: peopleKeys.all }); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/api/people/leave/requests/${id}/cancel`),
    onSuccess: () => { toast("Request cancelled"); qc.invalidateQueries({ queryKey: peopleKeys.all }); },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const w = waiting.data ?? [];
  return (
    <div className="grid-2 ppl-leave">
      <div>
        <Card title="Waiting for approval" subtitle="Requests from people you manage."
          actions={w.length > 0 && <Pill tone="blue">{w.length} pending</Pill>}>
          {waiting.isLoading ? <Loading /> : waiting.isError ? <Notice tone="error">{(waiting.error as Error).message}</Notice>
            : w.length === 0 ? <EmptyState title="Nothing waiting for you" icon={<CalendarOff size={24} />}>When someone you manage asks for time off, it shows up here.</EmptyState>
            : w.map((r) => (
              <LeaveRequestRow key={r.id} r={r} actions={r.canDecide && (
                <div className="row ppl-decide">
                  <Button size="sm" variant="secondary" disabled={decide.isPending} onClick={() => setDeclining(r)}>Decline</Button>
                  <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, outcome: "approve" })}>Approve</Button>
                </div>
              )} />
            ))}
        </Card>

        <Card title="Your leave" actions={<Button size="sm" onClick={() => setRequesting(true)}>Request leave</Button>}>
          {myBal.isLoading ? <Loading /> : !myBal.data?.employee ? (
            <p className="muted">You don't have an employee record yet, so there's no balance to show. Ask HR to add you to People & HR.</p>
          ) : (
            <div className="ppl-bal-tiles">
              {myBal.data.balances.map((b) => (
                <div key={b.leaveTypeId} className="ppl-bal-tile">
                  <small>{b.name.replace(/ leave$/i, "")}</small>
                  {b.daysPerYear == null ? <p><b>Any</b> with approval</p> : <p><b>{b.remaining}</b> of {b.daysPerYear} days</p>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Requests" actions={can("people", "view") && <Segmented value={scope} onChange={setScope} options={[{ value: "mine", label: "Mine" }, { value: "all", label: "Everyone" }]} />}>
          {listQ.isLoading ? <Loading /> : listQ.isError ? <Notice tone="error">{(listQ.error as Error).message}</Notice>
            : !listQ.data?.length ? <p className="muted">{scope === "mine" ? "You haven't requested any leave yet." : "No leave requests yet."}</p>
            : listQ.data.slice(0, 30).map((r) => (
              <LeaveRequestRow key={r.id} r={r} showStatus actions={r.canCancel && (
                <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>Cancel</Button>
              )} />
            ))}
        </Card>
      </div>
      <div>
        <WhosOff />
        <LeaveTypesCard />
      </div>
      <RequestLeaveModal open={requesting} onClose={() => setRequesting(false)} />
      <DeclineModal r={declining} onClose={() => setDeclining(null)} busy={decide.isPending}
        onDecline={(note) => declining && decide.mutate({ id: declining.id, outcome: "decline", note })} />
    </div>
  );
}

function DeclineModal({ r, onClose, onDecline, busy }: { r: LeaveRequest | null; onClose: () => void; onDecline: (note: string) => void; busy: boolean }) {
  const [note, setNote] = useState("");
  useEffect(() => setNote(""), [r?.id]);
  return (
    <Modal open={!!r} onClose={onClose} title="Decline this request?" subtitle={r ? `${r.employee?.name} · ${r.leaveType?.name} · ${range(r.startDate, r.endDate)}` : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={() => onDecline(note)}>Decline</Button></>}>
      <Textarea label="Note" optional rows={3} placeholder="Let them know why, or suggest other dates" value={note} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  );
}

type Calendar = {
  from: string; to: string; holidays: { day: string; name: string; recurring: boolean }[];
  people: { id: string; name: string; jobTitle: string | null; entries: { id: string; startDate: string; endDate: string; type: string; kind: "approved" | "pending" | "sick" }[] }[];
};

function WhosOff() {
  const depts = useDepartments();
  const [from, setFrom] = useState(() => mondayOfYmd(localYmd()));
  const [team, setTeam] = useState("all");
  const to = addDaysYmd(from, 13);
  const cal = useQuery({
    queryKey: ["people", "calendar", from, team],
    queryFn: () => api.get<Calendar>(`/api/people/leave/calendar${qs({ from, to, team: team === "mine" ? "mine" : undefined, departmentId: team !== "all" && team !== "mine" ? team : undefined })}`),
  });
  const days = Array.from({ length: 14 }, (_, i) => addDaysYmd(from, i));
  const isHol = (d: string) => cal.data?.holidays.some((h) => (h.recurring ? h.day.slice(5) === d.slice(5) : h.day === d));
  const today = localYmd();
  const teamName = team === "all" ? "Everyone" : team === "mine" ? "Your team" : depts.data?.find((d) => d.id === team)?.name ?? "Team";
  return (
    <Card title="Who's off" subtitle={`${teamName} · ${short(from)} to ${short(to)}`}
      actions={<select className="select chip-select" aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
        <option value="all">Team: Everyone</option>
        <option value="mine">Team: Mine</option>
        {(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>}>
      <div className="between" style={{ marginBottom: 10 }}>
        <IconButton label="Previous week" bordered onClick={() => setFrom(addDaysYmd(from, -7))}><ChevronLeft size={16} /></IconButton>
        <button className="btn btn-ghost btn-sm" onClick={() => setFrom(mondayOfYmd(localYmd()))}>This week</button>
        <IconButton label="Next week" bordered onClick={() => setFrom(addDaysYmd(from, 7))}><ChevronRight size={16} /></IconButton>
      </div>
      {cal.isLoading ? <Loading /> : cal.isError ? <Notice tone="error">{(cal.error as Error).message}</Notice> : (
        <div className="ppl-cal-wrap">
          <table className="ppl-cal">
            <thead>
              <tr>
                <th className="name">{fmtDate(from, { month: "short", year: "numeric" })}</th>
                {days.map((d) => {
                  const dt = new Date(`${d}T12:00:00`);
                  const we = dt.getDay() === 0 || dt.getDay() === 6;
                  return <th key={d} className={`${we ? "we" : ""} ${d === today ? "today" : ""}`} title={isHol(d) ? "Public holiday" : undefined}>
                    {dt.toLocaleDateString("en-GB", { weekday: "narrow" })}<br />{dt.getDate()}
                  </th>;
                })}
              </tr>
            </thead>
            <tbody>
              {(cal.data?.people ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="name">{p.name}</td>
                  {days.map((d) => {
                    const dt = new Date(`${d}T12:00:00`);
                    const we = dt.getDay() === 0 || dt.getDay() === 6;
                    const e = p.entries.find((x) => x.startDate <= d && x.endDate >= d);
                    return <td key={d} className={we || isHol(d) ? "we" : ""}>{e && !we && !isHol(d) && <i className={`ppl-chip ${e.kind}`} title={`${e.type} (${e.kind})`} />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!cal.data?.people.length && <p className="muted" style={{ padding: "14px 4px" }}>No one is off in these two weeks.</p>}
        </div>
      )}
      <div className="ppl-legend">
        <span><i className="ppl-chip approved" />Approved</span><span><i className="ppl-chip pending" />Pending</span><span><i className="ppl-chip sick" />Sick</span>
      </div>
    </Card>
  );
}

function LeaveTypesCard() {
  const { can } = useSession();
  const types = useLeaveTypes();
  const holidays = useQuery({ queryKey: ["people", "holidays"], queryFn: () => api.get<{ id: string; name: string; day: string; recurring: boolean }[]>("/api/people/holidays") });
  const [managing, setManaging] = useState(false);
  const allowance = (t: LeaveType) => t.daysPerYear == null ? "No set limit" : t.daysPerYear % 7 === 0 && t.daysPerYear >= 28 ? `${t.daysPerYear / 7} weeks` : `${t.daysPerYear} days a year`;
  return (
    <Card title="Leave types" subtitle="Set by your HR admins." actions={can("people", "manage") && <button className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>Manage</button>}>
      {types.isLoading ? <Loading /> : !types.data?.length ? <p className="muted">No leave types yet.</p> : (
        <div className="ppl-kv-grid">
          {types.data.map((t) => <div key={t.id} className="ppl-kv"><small>{t.name}{!t.paid && " (unpaid)"}</small><span>{allowance(t)}</span></div>)}
          <div className="ppl-kv"><small>Public holidays</small><span>{holidays.data?.length ? plural(holidays.data.length, "day") : "None added"}</span></div>
        </div>
      )}
      {managing && <ManageLeaveTypes onClose={() => setManaging(false)} />}
    </Card>
  );
}

function ManageLeaveTypes({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const types = useLeaveTypes();
  const holidays = useQuery({ queryKey: ["people", "holidays"], queryFn: () => api.get<{ id: string; name: string; day: string; recurring: boolean }[]>("/api/people/holidays") });
  const [edit, setEdit] = useState<LeaveType | "new" | null>(null);
  const [del, setDel] = useState<LeaveType | null>(null);
  const hol = useForm({ name: "", day: "", recurring: false });
  const { confirm, dialog } = useConfirm();
  const refresh = () => { qc.invalidateQueries({ queryKey: peopleKeys.leaveTypes }); qc.invalidateQueries({ queryKey: ["people", "holidays"] }); };
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/people/leave-types/${id}`),
    onSuccess: () => { setDel(null); toast("Leave type removed"); refresh(); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const removeHol = useMutation({
    mutationFn: (id: string) => api.del(`/api/people/holidays/${id}`),
    onSuccess: () => refresh(), onError: (e: Error) => toast(e.message, "error"),
  });
  const addHol = () => hol.submit(async (v) => {
    await api.post("/api/people/holidays", v);
    hol.setValues({ name: "", day: "", recurring: false });
    refresh();
  });
  return (
    <Modal open onClose={onClose} title="Leave types and holidays" size="lg" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="between" style={{ marginBottom: 8 }}>
        <div className="section-label">Leave types</div>
        <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setEdit("new")}>Add type</Button>
      </div>
      {(types.data ?? []).map((t) => (
        <div key={t.id} className="list-row">
          <div className="grow"><b className="ink">{t.name}</b><small className="muted" style={{ display: "block" }}>
            {t.daysPerYear == null ? "No set limit" : `${t.daysPerYear} days a year`} · {t.paid ? "Paid" : "Unpaid"}{t.requiresNote ? " · note required" : ""}
          </small></div>
          <IconButton label={`Edit ${t.name}`} onClick={() => setEdit(t)}><Pencil size={16} /></IconButton>
          <IconButton label={`Remove ${t.name}`} onClick={() => setDel(t)}><Trash2 size={16} /></IconButton>
        </div>
      ))}
      <div className="section-label" style={{ margin: "22px 0 8px" }}>Public holidays</div>
      <p className="muted" style={{ marginBottom: 10 }}>These days aren't counted when someone takes leave.</p>
      {(holidays.data ?? []).map((h) => (
        <div key={h.id} className="list-row">
          <div className="grow"><b className="ink">{h.name}</b><small className="muted" style={{ display: "block" }}>
            {h.recurring ? `${fmtDate(h.day, { day: "numeric", month: "long" })} every year` : fmtDate(h.day)}
          </small></div>
          <IconButton label={`Remove ${h.name}`} onClick={async () => {
            if (await confirm({ title: `Remove ${h.name}?`, message: "It will count as a normal working day again.", confirmLabel: "Remove" })) removeHol.mutate(h.id);
          }}><Trash2 size={16} /></IconButton>
        </div>
      ))}
      <div className="ppl-hol-form">
        <Input placeholder="Holiday name" aria-label="Holiday name" {...hol.bind("name")} />
        <Input type="date" aria-label="Date" {...hol.bind("day")} />
        <Checkbox label="Every year" checked={hol.values.recurring} onChange={(e) => hol.set("recurring", e.target.checked)} />
        <Button size="sm" variant="secondary" loading={hol.busy} onClick={addHol}>Add</Button>
      </div>
      {edit && <LeaveTypeModal type={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={refresh} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} danger loading={remove.isPending}
        title={`Remove ${del?.name}?`} confirmLabel="Remove">
        <p>People won't be able to request this type any more. Past requests are kept.</p>
      </ConfirmDialog>
      {dialog}
    </Modal>
  );
}

function LeaveTypeModal({ type, onClose, onSaved }: { type: LeaveType | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const f = useForm({ name: type?.name ?? "", daysPerYear: type?.daysPerYear != null ? String(type.daysPerYear) : "", paid: type?.paid ?? true, requiresNote: type?.requiresNote ?? false });
  const save = () => f.submit(async (v) => {
    if (type) await api.patch(`/api/people/leave-types/${type.id}`, v); else await api.post("/api/people/leave-types", v);
    toast(type ? "Leave type saved" : "Leave type added");
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={type ? `Edit ${type.name}` : "Add leave type"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Input label="Name" placeholder="e.g. Study leave" {...f.bind("name")} />
        <Input label="Days a year" optional inputMode="decimal" hint="Leave empty for no set limit" {...f.bind("daysPerYear")} />
        <Checkbox label="Paid leave" checked={f.values.paid} onChange={(e) => f.set("paid", e.target.checked)} />
        <Checkbox label="A note is required (e.g. sick leave)" checked={f.values.requiresNote} onChange={(e) => f.set("requiresNote", e.target.checked)} />
      </div>
    </Modal>
  );
}
