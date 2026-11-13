import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { Button, Card, EmptyState, Loading, PageHeader, Pill, Select } from "@windveal/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dayLabel, fmtDate, fmtTime } from "../../lib/format";
import { DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { LeaveRequestRow, RequestLeaveModal, balanceText } from "../people/Leave";
import { ChecklistDetail } from "../people/Onboarding";
import type { Balance, LeaveRequest } from "../people/lib";
import { TaskDrawer, TaskList, useTaskList } from "../workflows/tasks";
import "./me.css";

type Summary = {
  employee: { id: string; firstName: string; jobTitle: string | null; startDate: string | null; status: string } | null;
  onboarding: boolean; nextStep: { title: string; dueAt: string | null } | null;
};
type Day = { date: string; clockIn: string | null; clockOut: string | null; breaks: number; corrected: boolean; note: string | null; minutes: number | null };
type Today = { record: { clockIn: string | null; clockOut: string | null; onBreak?: boolean } | null };

/** What My space has for this person; also decides which sections the sidebar shows. */
export function useMySummary() {
  return useQuery({ queryKey: ["my", "summary"], queryFn: () => api.get<Summary>("/api/my/summary"), staleTime: 60_000 });
}
const useMyLeave = () => useQuery({ queryKey: ["people", "leave", "mine"], queryFn: () => api.get<LeaveRequest[]>("/api/people/leave/requests?scope=mine") });
const useMyBalances = () => useQuery({ queryKey: ["people", "balances", "me"], queryFn: () => api.get<{ balances: Balance[] }>("/api/people/leave/balances") });
const useMonth = (month: string) => useQuery({ queryKey: ["my", "attendance", month], queryFn: () => api.get<{ days: Day[] }>(`/api/my/attendance?month=${month}`) });

const hours = (m: number | null) => (m == null ? "" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const useMyChecklists = () => useQuery({ queryKey: ["my", "checklists"], queryFn: () => api.get<{ id: string; kind: string; title: string; status: string; total: number; done: number }[]>("/api/my/checklists") });

function Overview() {
  const summary = useMySummary();
  const today = useQuery({ queryKey: ["attendance", "me"], queryFn: () => api.get<Today>("/api/people/attendance/me") });
  const balances = useMyBalances();
  const leave = useMyLeave();
  const month = useMonth(thisMonth());
  const lists = useMyChecklists();
  const onb = lists.data?.find((c) => c.kind === "onboarding" && c.status !== "done") ?? lists.data?.[0];
  const r = today.data?.record;
  const main = balances.data?.balances.find((b) => b.daysPerYear != null);
  const worked = (month.data?.days ?? []).reduce((a, d) => a + (d.minutes ?? 0), 0);
  return (
    <>
      <DashKpis loading={today.isLoading || balances.isLoading} items={[
        { label: "Today", value: !r?.clockIn ? "Not in" : r.clockOut ? "Done" : r.onBreak ? "On a break" : "In", note: r?.clockIn ? `since ${fmtTime(r.clockIn)}` : "clock in from the top bar", to: "/me/attendance" },
        { label: "Worked this month", value: hours(worked) || "0h", note: `${month.data?.days.length ?? 0} days`, to: "/me/attendance" },
        { label: main ? `${main.name} left` : "Leave", value: main?.remaining ?? "—", note: main ? `of ${main.daysPerYear} days this year` : "no allowance set", to: "/me/leave" },
        ...(onb ? [{ label: "Onboarding", value: `${onb.done} of ${onb.total}`, note: summary.data?.nextStep ? `next: ${summary.data.nextStep.title}` : "all steps done", to: "/me/onboarding" }] : []),
      ]} />
      <DashColumns
        left={
          <DashCard title="Your attendance" sub="This month" link={{ to: "/me/attendance", label: "Attendance" }} loading={month.isLoading}
            empty={!month.isLoading && !month.data?.days.length && "You haven't clocked in this month yet."}>
            {(month.data?.days ?? []).slice(0, 5).map((d) => (
              <DashRow key={d.date} title={dayLabel(d.date)} detail={`${d.clockIn ? fmtTime(d.clockIn) : "—"} to ${d.clockOut ? fmtTime(d.clockOut) : "now"}`} end={hours(d.minutes)} />
            ))}
          </DashCard>
        }
        right={
          <DashCard title="Your leave" sub="Requests and answers" link={{ to: "/me/leave", label: "Leave" }} loading={leave.isLoading}
            empty={!leave.isLoading && !leave.data?.length && "You haven't asked for any leave yet."}>
            {(leave.data ?? []).slice(0, 5).map((l) => (
              <DashRow key={l.id} title={l.leaveType?.name ?? "Leave"} detail={`${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ` to ${fmtDate(l.endDate)}` : ""} · ${l.days} day${l.days === 1 ? "" : "s"}`}
                end={<Pill tone={l.status === "approved" ? "ok" : l.status === "pending" ? "warn" : l.status === "declined" ? "red" : "grey"}>{l.status[0]!.toUpperCase() + l.status.slice(1)}</Pill>} />
            ))}
          </DashCard>
        }
      />
    </>
  );
}

function Attendance() {
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); });
  const [month, setMonth] = useState(months[0]!);
  const q = useMonth(month);
  const total = (q.data?.days ?? []).reduce((a, d) => a + (d.minutes ?? 0), 0);
  return (
    <>
      <div className="toolbar">
        <Select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}
          options={months.map((m) => ({ value: m, label: new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) }))} />
        <span className="grow" />
        {!!q.data?.days.length && <span className="muted">{q.data.days.length} days · {hours(total)} worked</span>}
      </div>
      {q.isLoading ? <Loading /> : !q.data?.days.length ? <Card><EmptyState title="No clock-ins this month">Clock in from the top bar when you start work.</EmptyState></Card> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Day</th><th>In</th><th>Out</th><th className="hide-sm">Breaks</th><th>Worked</th></tr></thead>
            <tbody>{q.data.days.map((d) => (
              <tr key={d.date}>
                <td><b className="ink">{fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" })}</b>{d.corrected && <small className="muted" style={{ display: "block" }}>Corrected by HR{d.note ? `: ${d.note}` : ""}</small>}</td>
                <td>{d.clockIn ? fmtTime(d.clockIn) : "—"}</td>
                <td>{d.clockOut ? fmtTime(d.clockOut) : d.clockIn ? "Still in" : "—"}</td>
                <td className="hide-sm">{d.breaks || "—"}</td>
                <td>{hours(d.minutes)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Leave() {
  const summary = useMySummary();
  const balances = useMyBalances();
  const leave = useMyLeave();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <div className="toolbar"><span className="grow" /><Button icon={<CalendarPlus size={16} />} onClick={() => setAsking(true)}>Ask for leave</Button></div>
      <div className="me-balances">
        {balances.isLoading ? <Loading /> : (balances.data?.balances ?? []).map((b) => (
          <div key={b.leaveTypeId} className="card me-balance"><b className="ink">{b.name}</b><span>{balanceText(b)}</span>{!!b.pending && <small className="muted">{b.pending} waiting for approval</small>}</div>
        ))}
      </div>
      <Card title="Your requests" flush={!!leave.data?.length}>
        {leave.isLoading ? <Loading /> : !leave.data?.length ? <EmptyState title="No leave requests yet">Ask for leave and your manager will be told.</EmptyState>
          : leave.data.map((r) => <LeaveRequestRow key={r.id} r={r} showStatus />)}
      </Card>
      <RequestLeaveModal open={asking} onClose={() => setAsking(false)} myEmployeeId={summary.data?.employee?.id} />
    </>
  );
}

function Pay() {
  const { money } = useSession();
  const q = useQuery({ queryKey: ["my", "pay"], queryFn: () => api.get<{ pay: { salaryAmount: string | null; currency: string; payFrequency: string | null; bankName: string | null; accountNumber: string | null; updatedAt: string } | null; employmentType: string | null; startDate: string | null }>("/api/my/pay") });
  if (q.isLoading) return <Loading />;
  const p = q.data?.pay;
  const masked = (s: string | null) => (s ? `•••• ${s.slice(-4)}` : null);
  const rows: [string, string | null | undefined][] = [
    ["Salary", p?.salaryAmount ? `${money(p.salaryAmount)}${p.payFrequency ? ` ${p.payFrequency.toLowerCase()}` : ""}` : null],
    ["Employment", q.data?.employmentType], ["Started", q.data?.startDate ? fmtDate(q.data.startDate) : null],
    ["Bank", p?.bankName], ["Account", masked(p?.accountNumber ?? null)],
  ];
  return (
    <>
      <Card title="Your pay" subtitle={p ? `Last updated ${fmtDate(p.updatedAt)}. Only you and HR can see this.` : "Only you and HR can see this."}>
        {!p ? <EmptyState title="No pay details yet">HR hasn't added your pay details. Ask them if something should be here.</EmptyState> : (
          <dl className="kv pf-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || <span className="muted">Not given</span>}</dd></div>)}</dl>
        )}
      </Card>
      <Card title="Payslips"><EmptyState title="Payslips are coming">Once WindVeal runs payroll, each month's payslip will be here.</EmptyState></Card>
    </>
  );
}

function Onboarding() {
  const q = useMyChecklists();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (!open && q.data?.[0]) setOpen(q.data[0].id); }, [q.data, open]);
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <Card><EmptyState title="No onboarding steps">You're all set. Nothing is waiting for you here.</EmptyState></Card>;
  return (
    <>
      {q.data.length > 1 && (
        <div className="toolbar">
          <Select aria-label="Checklist" value={open ?? ""} onChange={(e) => setOpen(e.target.value)} options={q.data.map((c) => ({ value: c.id, label: `${c.title} · ${c.done} of ${c.total}` }))} />
        </div>
      )}
      {open && <ChecklistDetail id={open} mine />}
    </>
  );
}


/** My Workspace: each person's own attendance, leave, tasks, pay and onboarding. Only theirs. */
/** The tasks given to this person from anywhere in WindVeal; no Workflows access needed. */
function MyTasks() {
  const [params, setParams] = useSearchParams();
  const { data, isLoading, error } = useTaskList("mine", { q: "", workspace: "", priority: "", createdBy: "" });
  const open = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set("task", id); else p.delete("task"); setParams(p, { replace: true }); };
  return (
    <>
      <TaskList data={data} isLoading={isLoading} error={error} onOpen={open} filtered={false} onNew={() => {}} canCreate={false}
        emptyText="Tasks given to you, from anywhere in WindVeal, show up here." />
      <TaskDrawer id={params.get("task")} onClose={() => open(null)} />
    </>
  );
}

export default function MySpace() {
  const { user } = useSession();
  useEffect(() => { document.title = "My Workspace · WindVeal"; }, []);
  const summary = useMySummary();
  return (
    <div className="me">
      <PageHeader title="My Workspace" subtitle={summary.data?.employee?.jobTitle ? `${user.name} · ${summary.data.employee.jobTitle}` : user.name} />
      <Routes>
        <Route index element={<Overview />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="leave" element={<Leave />} />
        <Route path="tasks" element={<MyTasks />} />
        <Route path="pay" element={<Pay />} />
        <Route path="onboarding" element={<Onboarding />} />
        <Route path="*" element={<Navigate to="/me" replace />} />
      </Routes>
      <p className="muted me-note">Your personal details are in <Link className="link" to="/profile">Profile</Link>.</p>
    </div>
  );
}
