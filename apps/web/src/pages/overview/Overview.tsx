import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Check, Clock, SquareCheck, UserPlus, Users, X } from "lucide-react";
import { Avatar, Button, Card, EmptyState, IconButton, Loading, Notice, Pill, Progress, useToast } from "@windveal/ui";
import { WORKSPACE_LABELS, type Workspace } from "@windveal/shared";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dayLabel, isOverdue, timeAgo } from "../../lib/format";

type OverviewData = {
  kpis: Record<"team" | "deals" | "roles" | "tasks", { value: number; extra?: number } | null>;
  myTasks: { id: string; title: string; workspace: string; linkLabel: string | null; dueAt: string | null; priority: string }[];
  approvals: { id: string; kind: string; title: string; details: string | null; amount: string | null; requestedBy: string; createdAt: string }[];
  comingUp: { date: string; title: string; subtitle: string; href: string }[];
  activity: { id: string; summary: string; actor: string; createdAt: string }[];
  setup: { key: string; label: string; done: boolean; href: string }[] | null;
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function Overview() {
  const { user, org, money, isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<OverviewData>("/api/overview"), refetchInterval: 120_000 });
  const [hideBanner, setHideBanner] = useState(() => { try { return sessionStorage.getItem("wv-hide-verify") === "1"; } catch { return false; } });
  useEffect(() => { document.title = "Overview · WindVeal"; }, []);

  const completeTask = async (id: string) => {
    try { await api.post(`/api/workflows/tasks/${id}/complete`); qc.invalidateQueries({ queryKey: ["overview"] }); qc.invalidateQueries({ queryKey: ["shell-counts"] }); toast("Task completed"); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't complete the task", "error"); }
  };
  const decide = async (id: string, decision: "approve" | "decline") => {
    try { await api.post(`/api/workflows/approvals/${id}/decide`, { decision }); qc.invalidateQueries({ queryKey: ["overview"] }); toast(decision === "approve" ? "Approved" : "Declined"); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't record your decision", "error"); }
  };

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Notice tone="error">We couldn't load your overview. Refresh to try again.</Notice>;
  const d = q.data;
  const setupDone = d.setup?.filter((s) => s.done).length ?? 0;
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      {org.verificationStatus !== "verified" && !hideBanner && (
        <Notice tone="warn" icon={<Clock size={20} />} action={
          <span className="row">{isAdmin && <Link to="/profile/company" style={{ color: "var(--warn)" }}>Check status</Link>}
            <IconButton label="Dismiss" onClick={() => { setHideBanner(true); try { sessionStorage.setItem("wv-hide-verify", "1"); } catch { /* ignore */ } }}><X size={16} /></IconButton></span>
        }>
          <b>We're verifying {org.name}.</b> Your careers page goes live once you're verified, usually within 1 to 2 working days.
        </Notice>
      )}
      <div className="page-head" style={{ marginBottom: 22 }}>
        <div><h1>{greeting()}, {user.name.split(" ")[0]}</h1><p>{today} · Here's what's happening at {org.name} today.</p></div>
      </div>

      {d.setup && setupDone < d.setup.length && (
        <div className="setup-card">
          <div>
            <h3>Finish setting up</h3>
            <p style={{ fontSize: 13.5 }}>A few more steps to get the most out of WindVeal.</p>
            <Progress value={(setupDone / d.setup.length) * 100} />
            <small>{setupDone} of {d.setup.length} done</small>
          </div>
          <div className="setup-items">
            {d.setup.map((s) => (
              <div key={s.key} className={`setup-item ${s.done ? "done" : ""}`}>
                <span className="c">{s.done && <Check size={12} strokeWidth={3} />}</span>{s.label}
                {!s.done && <Link to={s.href}>Start →</Link>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="stats">
        {d.kpis.team && <Link to="/people" className="stat"><small className="row" style={{ justifyContent: "space-between" }}>Team members <Users size={16} color="var(--blue)" /></small><b>{d.kpis.team.value}</b><em>{d.kpis.team.extra} on leave today</em></Link>}
        {d.kpis.deals && <Link to="/crm/pipeline" className="stat"><small className="row" style={{ justifyContent: "space-between" }}>Open deals <Briefcase size={16} color="var(--blue)" /></small><b>{d.kpis.deals.value}</b><em className="up">{money(d.kpis.deals.extra ?? 0, true)} in pipeline</em></Link>}
        {d.kpis.roles && <Link to="/recruitment" className="stat"><small className="row" style={{ justifyContent: "space-between" }}>Open roles <UserPlus size={16} color="var(--blue)" /></small><b>{d.kpis.roles.value}</b><em>{d.kpis.roles.extra} new applicants this week</em></Link>}
        {d.kpis.tasks && <Link to="/workflows" className="stat"><small className="row" style={{ justifyContent: "space-between" }}>Tasks due this week <SquareCheck size={16} color="var(--blue)" /></small><b>{d.kpis.tasks.value}</b><em>{d.kpis.tasks.extra} overdue</em></Link>}
      </div>

      <div className="grid-side side-wide">
        <div>
          <Card title="My tasks" actions={<Link className="link" to="/workflows">View all</Link>}>
            {d.myTasks.length === 0 ? <EmptyState title="Nothing on your list">Tasks assigned to you from any workspace show up here.</EmptyState> : d.myTasks.map((t) => (
              <div key={t.id} className="task-row">
                <button className="circle-check" aria-label={`Complete ${t.title}`} onClick={() => completeTask(t.id)} />
                <Link to={`/workflows?task=${t.id}`} style={{ minWidth: 0 }}><b>{t.title}</b><small>{t.linkLabel ?? " "}</small></Link>
                <span className="hide-sm"><Pill>{WORKSPACE_LABELS[t.workspace as Workspace] ?? t.workspace}</Pill></span>
                <span className={`due ${isOverdue(t.dueAt) ? "od" : ""}`}>{t.dueAt ? dayLabel(t.dueAt) : "No date"}</span>
              </div>
            ))}
          </Card>
          <Card title="Waiting for your approval" actions={<Link className="link" to="/workflows/approvals">View all</Link>}>
            {d.approvals.length === 0 ? <EmptyState title="Nothing waiting for you" /> : d.approvals.map((a) => (
              <div key={a.id} className="list-row" style={{ flexWrap: "wrap" }}>
                <Avatar name={a.requestedBy} size={32} />
                <Link to={`/workflows/approvals?id=${a.id}`} style={{ flex: 1, minWidth: 160 }}><b className="ink" style={{ display: "block" }}>{a.title}</b><small className="muted">{a.requestedBy}{a.amount ? ` · ${money(a.amount)}` : ""} · {timeAgo(a.createdAt)}</small></Link>
                <span className="row"><Button size="sm" variant="secondary" onClick={() => decide(a.id, "decline")}>Decline</Button><Button size="sm" onClick={() => decide(a.id, "approve")}>Approve</Button></span>
              </div>
            ))}
          </Card>
        </div>
        <div>
          <Card title="Coming up">
            {d.comingUp.length === 0 ? <EmptyState title="Nothing in the next two weeks" /> : d.comingUp.map((c, i) => {
              const date = new Date(c.date.length === 10 ? `${c.date}T00:00:00` : c.date);
              return (
                <Link key={i} to={c.href} className="list-row">
                  <span className="date-chip"><small>{date.toLocaleDateString("en-GB", { month: "short" })}</small><b>{date.getDate()}</b></span>
                  <span><b className="ink" style={{ display: "block" }}>{c.title}</b><small className="muted">{c.subtitle}</small></span>
                </Link>
              );
            })}
          </Card>
          <Card title="Recent activity">
            {d.activity.length === 0 ? <EmptyState title="No activity yet">As your team works, updates appear here.</EmptyState> : d.activity.map((a) => (
              <div key={a.id} className="list-row" style={{ alignItems: "flex-start" }}>
                <Avatar name={a.actor} size={30} />
                <span style={{ fontSize: 13.5 }}>{a.summary}<small className="muted" style={{ display: "block" }}>{timeAgo(a.createdAt)}</small></span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
