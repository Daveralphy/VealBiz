import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { BarChart, EmptyState, HBarChart, LineChart, Loading, Notice } from "@windveal/ui";
import { ApiError, api } from "../../lib/api";
import { KpiCard, useChangeNote, useFormat } from "./shared";

type Overview = {
  range: { key: string; label: string; compare: string };
  currency: string;
  definitions: Record<string, string>;
  restricted: string[];
  revenueWon?: { value: number; previous: number; change: number | null; deals: number };
  revenueByMonth?: { label: string; value: number }[];
  headcount?: { value: number; starters: number };
  headcountByDepartment?: { label: string; value: number }[];
  leaveByType?: { label: string; value: number }[];
  tasksOnTime?: { value: number | null; previous: number | null; done: number };
  daysToHire?: { value: number | null; previous: number | null; hires: number };
  daysToHireByMonth?: { label: string; value: number; hires: number }[];
};

function ChartCard({ title, subtitle, link, children }: { title: string; subtitle: string; link?: { to: string; label: string }; children: ReactNode }) {
  return (
    <section className="card ins-chart">
      <div className="card-head">
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        {link && <Link className="ins-link" to={link.to}>{link.label}</Link>}
      </div>
      {children}
    </section>
  );
}

const NoAccess = () => <p className="muted ins-empty">You don't have access to these records.</p>;

export function OverviewPage({ range }: { range: string }) {
  const q = useQuery({ queryKey: ["insights", "overview", range], queryFn: () => api.get<Overview>(`/api/insights/overview?range=${range}`) });
  const fmt = useFormat();
  const change = useChangeNote();
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Notice tone="error">{q.error instanceof ApiError ? q.error.message : "We couldn't load Insights. Please try again."}</Notice>;
  const d = q.data;
  const cmp = d.range.compare;
  const rev = d.revenueWon;
  const revNote = rev ? change({ key: "revenueWon", value: rev.value, previous: rev.previous, format: "money" }, cmp) : null;
  const tasks = d.tasksOnTime;
  const taskNote = tasks ? change({ key: "tasksOnTime", value: tasks.value, previous: tasks.previous, format: "percent" }, cmp) : null;
  const hire = d.daysToHire;
  const hireNote = hire ? change({ key: "daysToHire", value: hire.value, previous: hire.previous, format: "days" }, cmp) : null;
  const periodWord = d.range.key === "3m" ? "in the last 3 months" : `${d.range.label.toLowerCase()}`;
  const millions = (rev?.value ?? 0) >= 1_000_000 || (d.revenueByMonth ?? []).some((m) => m.value >= 1_000_000);

  return (
    <>
      <div className="stats ins-stats">
        <KpiCard label="Revenue won" definition={d.definitions.revenueWon!} value={rev ? fmt(rev.value, "money", true) : "—"}
          note={!rev ? "No access" : revNote?.text ?? (rev.value ? `${rev.deals} deal${rev.deals === 1 ? "" : "s"} won` : "No deals won yet")} good={revNote?.good} />
        <KpiCard label="Headcount" definition={d.definitions.headcount!} value={d.headcount ? fmt(d.headcount.value, "number") : "—"}
          note={!d.headcount ? "No access" : `+${d.headcount.starters} ${periodWord}`} good={d.headcount && d.headcount.starters > 0 ? true : undefined} />
        <KpiCard label="Tasks done on time" definition={d.definitions.tasksOnTime!} value={tasks ? fmt(tasks.value, "percent") : "—"}
          note={!tasks ? "No access" : tasks.value === null ? "No tasks with due dates done yet" : taskNote?.text ?? `${tasks.done} tasks with due dates`} good={taskNote?.good} />
        <KpiCard label="Days to hire" definition={d.definitions.daysToHire!} value={hire ? fmt(hire.value, "days") : "—"}
          note={!hire ? "No access" : hire.value === null ? "No hires in this period yet" : hireNote?.text ?? `${hire.hires} hire${hire.hires === 1 ? "" : "s"}`} good={hireNote?.good} />
      </div>
      <div className="grid-2 ins-grid">
        <ChartCard title="Revenue won by month" subtitle={`Deals marked Won · ${millions ? `${d.currency} millions` : d.currency}`} link={{ to: "/insights/sales", label: "Sales report" }}>
          {!d.revenueByMonth ? <NoAccess /> : d.revenueByMonth.every((m) => !m.value) ? (
            <EmptyState title="No deals won yet">Revenue appears here when deals are marked Won in CRM.</EmptyState>
          ) : <BarChart data={d.revenueByMonth} format={(v) => (millions ? (v / 1_000_000).toFixed(1) : fmt(v, "money", true))} />}
        </ChartCard>
        <ChartCard title="Headcount by department" subtitle="Active employees today" link={{ to: "/insights/people", label: "People report" }}>
          {!d.headcountByDepartment ? <NoAccess /> : !d.headcountByDepartment.length ? (
            <EmptyState title="No employees yet">Add people in People & HR to see them here.</EmptyState>
          ) : <HBarChart data={d.headcountByDepartment.slice(0, 8)} />}
        </ChartCard>
        <ChartCard title="Time to hire, month by month" subtitle="Average days from application to hired" link={{ to: "/insights/hiring", label: "Hiring report" }}>
          {!d.daysToHireByMonth ? <NoAccess /> : d.daysToHireByMonth.every((m) => !m.hires) ? (
            <EmptyState title="No hires yet">This fills in as candidates are marked Hired.</EmptyState>
          ) : <LineChart data={d.daysToHireByMonth} />}
        </ChartCard>
        <ChartCard title="Leave taken" subtitle={`Days approved, ${d.range.label.toLowerCase()}`} link={{ to: "/insights/people", label: "People report" }}>
          {!d.leaveByType ? <NoAccess /> : !d.leaveByType.length ? (
            <EmptyState title="No leave taken in this period">Approved leave appears here by type.</EmptyState>
          ) : <BarChart data={d.leaveByType} highlightLast={false} />}
        </ChartCard>
      </div>
      <p className="ins-foot">Every number comes from records in WindVeal. Select the (i) beside any figure to see how it's worked out. You only see data you have access to.</p>
    </>
  );
}
