import { useQuery } from "@tanstack/react-query";
import { Avatar, Pill } from "@windveal/ui";
import { WORKSPACE_LABELS } from "@windveal/shared";
import { api, qs } from "../../lib/api";
import { dayLabel, timeAgo } from "../../lib/format";
import { DashBars, DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { dueText, useTaskList, type TaskFilters, type TaskView } from "./tasks";
import { KIND_LABEL } from "./approvals";

const EMPTY: TaskFilters = { q: "", workspace: "", priority: "", createdBy: "" };
type WaitingApproval = { id: string; kind: string; title: string; createdAt: string; requester: { id: string; name: string } };

const wsLabel = (w: string) => WORKSPACE_LABELS[w as keyof typeof WORKSPACE_LABELS] ?? w;

function startOfWeek() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d.getTime();
}

/** The Workflows dashboard: today's numbers and the top five of each list, each linking to the full page. */
export function WorkflowsDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const mine = useTaskList("mine", EMPTY);
  const all = useTaskList("all", EMPTY);
  const summary = useQuery({
    queryKey: ["wf-summary"], queryFn: () => api.get<{ myTasks: number; approvalsWaiting: number }>("/api/workflows/summary"), refetchInterval: 60_000,
  });
  const waiting = useQuery({
    queryKey: ["wf-approvals", "waiting", ""], queryFn: () => api.get<WaitingApproval[]>(`/api/workflows/approvals${qs({ scope: "waiting", kind: "" })}`),
  });

  const group = (key: string) => mine.data?.groups.find((g) => g.key === key)?.tasks ?? [];
  const myOpen = (mine.data?.groups ?? []).filter((g) => g.key !== "done").flatMap((g) => g.tasks);
  const weekStart = startOfWeek();
  const doneThisWeek = group("done").filter((t) => t.completedAt && new Date(t.completedAt).getTime() >= weekStart).length;

  const allOpen = (all.data?.groups ?? []).filter((g) => g.key !== "done").flatMap((g) => g.tasks);
  const byWs = new Map<string, number>();
  for (const t of allOpen) byWs.set(t.workspace, (byWs.get(t.workspace) ?? 0) + 1);
  const wsRows = Array.from(byWs, ([w, n]) => ({ label: wsLabel(w), value: n })).sort((a, b) => b.value - a.value);
  const finished = all.data?.groups.find((g) => g.key === "done")?.tasks.slice(0, 5) ?? [];

  const taskEnd = (t: TaskView) => {
    const due = dueText(t);
    return due.text ? <Pill tone={due.overdue ? "red" : due.text === "Today" ? "warn" : "grey"}>{due.text}</Pill> : null;
  };

  return (
    <>
      <DashKpis loading={mine.isLoading || summary.isLoading} items={[
        { label: "Due today", value: group("today").length, note: "Your tasks", to: "/workflows/mine" },
        { label: "Overdue", value: group("overdue").length, note: "Your tasks", to: "/workflows/mine" },
        { label: "Approvals waiting for you", value: summary.data?.approvalsWaiting ?? 0, to: "/workflows/approvals" },
        { label: "Done this week", value: doneThisWeek, note: "Your tasks" },
      ]} />
      <DashColumns
        left={<>
          <DashCard title="Coming up" sub="Your next tasks by due date" link={{ to: "/workflows/mine", label: "My tasks" }}
            loading={mine.isLoading} empty={!myOpen.length && "No open tasks. Nice work."}>
            {myOpen.slice(0, 5).map((t) => (
              <DashRow key={t.id} onClick={() => onOpen(t.id)} title={t.title} detail={t.linkLabel ? `${wsLabel(t.workspace)} · ${t.linkLabel}` : wsLabel(t.workspace)} end={taskEnd(t)} />
            ))}
          </DashCard>
          <DashCard title="Approvals waiting for you" link={{ to: "/workflows/approvals", label: "Approvals" }}
            loading={waiting.isLoading} empty={!waiting.data?.length && "Nothing to approve right now."}>
            {waiting.data?.slice(0, 5).map((a) => (
              <DashRow key={a.id} to={`/workflows/approvals?id=${a.id}`} lead={<Avatar name={a.requester.name} size={32} />} title={a.title}
                detail={`${KIND_LABEL[a.kind] ?? a.kind} · ${a.requester.name}`} end={timeAgo(a.createdAt)} />
            ))}
          </DashCard>
        </>}
        right={<>
          <DashCard title="Open tasks by workspace" sub="Everyone's open tasks" link={{ to: "/workflows/all", label: "All tasks" }}
            loading={all.isLoading} empty={!wsRows.length && "No one has any open tasks."}>
            <DashBars rows={wsRows} />
          </DashCard>
          <DashCard title="Recently finished" loading={all.isLoading} empty={!finished.length && "Nothing finished in the last two weeks."}>
            {finished.map((t) => (
              <DashRow key={t.id} onClick={() => onOpen(t.id)} lead={t.assignee ? <Avatar name={t.assignee.name} size={32} /> : undefined}
                title={t.title} detail={t.assignee?.name ?? "Unassigned"} end={t.completedAt ? dayLabel(t.completedAt) : "Done"} />
            ))}
          </DashCard>
        </>}
      />
    </>
  );
}
