import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Avatar, Button, Pill } from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { fmtDate, fmtTime } from "../../lib/format";
import { DashBars, DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { fmtMinutes, localYmd, useDepartments, useStats, type LeaveRequest } from "./lib";
import type { Board } from "./Attendance";

type Checklist = {
  id: string; total: number; done: number;
  employee: { id: string; name: string; jobTitle: string | null; startDate: string | null };
};

const short = (d: string) => fmtDate(d, { day: "numeric", month: "short" });

/** "until Fri", "until 12 Nov", "last day today". */
function untilText(day: string, today: string) {
  if (day === today) return "last day today";
  const days = Math.round((new Date(`${day}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000);
  return `until ${days < 7 ? new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" }) : short(day)}`;
}

/** The People & HR dashboard: today at a glance, and the top five of each list with a link to the full page. */
export function PeopleDashboard() {
  const nav = useNavigate();
  const today = localYmd();
  const stats = useStats();
  const board = useQuery({
    queryKey: ["people", "attendance", "board", today, "", ""],
    queryFn: () => api.get<Board>(`/api/people/attendance${qs({ date: today })}`), refetchInterval: 60_000,
  });
  const waiting = useQuery({ queryKey: ["people", "leave", "waiting"], queryFn: () => api.get<LeaveRequest[]>("/api/people/leave/requests?scope=waiting") });
  const depts = useDepartments();
  const onb = useQuery({
    queryKey: ["people", "checklists", "in_progress", "onboarding"],
    queryFn: () => api.get<Checklist[]>(`/api/people/checklists${qs({ status: "in_progress", kind: "onboarding" })}`),
  });

  const s = stats.data;
  const b = board.data;
  // Still on the clock first, then by who came in earliest.
  const inToday = (b?.rows ?? []).filter((r) => r.record?.clockIn)
    .sort((x, y) => Number(!!x.record!.clockOut) - Number(!!y.record!.clockOut) || x.record!.clockIn!.localeCompare(y.record!.clockIn!));
  const unassigned = s ? s.headcount - (depts.data ?? []).reduce((a, d) => a + d.count, 0) : 0;
  const bars = [...(depts.data ?? []).map((d) => ({ label: d.name, value: d.count })), ...(unassigned > 0 ? [{ label: "No department", value: unassigned }] : [])]
    .filter((r) => r.value > 0).sort((x, y) => y.value - x.value).slice(0, 6);

  return (
    <>
      <DashKpis loading={board.isLoading || stats.isLoading} items={[
        { label: "In today", value: b?.stats.present ?? 0, note: b ? (b.stats.notIn ? `${b.stats.notIn} not in yet` : "everyone's in") : undefined, to: "/people/attendance" },
        { label: "On leave", value: s?.onLeaveToday.count ?? 0, note: s?.onLeaveToday.until ? untilText(s.onLeaveToday.until, today) : "no one away", to: "/people/leave" },
        { label: "Late today", value: b?.stats.late ?? 0, note: b ? `after ${b.workdayStart}` : undefined },
        { label: "Starting soon", value: s?.startingSoon.next14Days ?? 0, note: "next 14 days", to: "/people/onboarding" },
      ]} />
      <DashColumns
        left={<>
          <DashCard title="Who's in today" link={{ to: "/people/attendance", label: "Attendance" }}
            loading={board.isLoading} empty={!inToday.length && "No one has clocked in yet."}>
            {inToday.slice(0, 5).map(({ employee: e, record: r, status, minutes }) => (
              <DashRow key={e.id} to={`/people/${e.id}`} lead={<Avatar name={e.name} size={32} />} title={e.name} detail={e.jobTitle ?? undefined}
                end={r!.clockOut ? fmtMinutes(minutes) : <>
                  <small>{fmtTime(r!.clockIn)} – now</small>{" "}
                  {r!.onBreak ? <Pill tone="grey">On a break</Pill> : status === "late" ? <Pill tone="warn">Late</Pill> : <Pill tone="ok">Working</Pill>}
                </>} />
            ))}
          </DashCard>
          <DashCard title="Leave waiting for you" loading={waiting.isLoading} empty={!waiting.data?.length && "Nothing waiting for you."}>
            {waiting.data?.slice(0, 5).map((r) => (
              <DashRow key={r.id} lead={<Avatar name={r.employee?.name ?? "?"} size={32} />} title={r.employee?.name ?? "Someone"}
                detail={`${r.leaveType?.name ?? "Leave"} · ${r.startDate === r.endDate ? short(r.startDate) : `${short(r.startDate)} to ${short(r.endDate)}`}`}
                end={<Button size="sm" variant="secondary" onClick={() => nav("/people/leave")}>Review</Button>} />
            ))}
          </DashCard>
        </>}
        right={<>
          <DashCard title="Headcount by department" link={{ to: "/people/departments", label: "Departments" }}
            loading={depts.isLoading || stats.isLoading} empty={!bars.length && "No one added yet."}>
            <DashBars rows={bars} />
          </DashCard>
          <DashCard title="Onboarding" link={{ to: "/people/onboarding", label: "Onboarding" }}
            loading={onb.isLoading} empty={!onb.data?.length && "No one is onboarding right now."}>
            {onb.data?.slice(0, 5).map((c) => {
              const start = c.employee.startDate;
              const when = start ? (start > today ? `starts ${short(start)}` : `started ${short(start)}`) : null;
              return (
                <DashRow key={c.id} to={`/people/onboarding?id=${c.id}`} lead={<Avatar name={c.employee.name} size={32} />} title={c.employee.name}
                  detail={[c.employee.jobTitle, when].filter(Boolean).join(" · ") || undefined}
                  end={<Pill tone={c.total && c.done === c.total ? "ok" : "blue"}>{c.done} of {c.total} done</Pill>} />
              );
            })}
          </DashCard>
        </>}
      />
    </>
  );
}
