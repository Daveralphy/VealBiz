import { useState } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Columns3, List, Plus } from "lucide-react";
import { Button, EmptyState, PageHeader } from "@windveal/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { NewTaskModal, TaskBoard, TaskDrawer, TaskFilterBar, TaskList, useTaskList, type TaskFilters } from "./tasks";
import { ApprovalsView } from "./approvals";
import { TemplatePage, TemplatesView } from "./templates";
import { WorkflowsDashboard } from "./dashboard";
import "./workflows.css";
import { MoreMenu } from "../../components/actions";

const EMPTY: TaskFilters = { q: "", workspace: "", priority: "", createdBy: "" };

function readView(): "list" | "board" {
  try { return localStorage.getItem("wv-wf-view") === "board" ? "board" : "list"; } catch { return "list"; }
}

function TasksTab({ scope, view, onOpen, onNew }: { scope: "mine" | "all"; view: "list" | "board"; onOpen: (id: string) => void; onNew: () => void }) {
  const { can } = useSession();
  const [f, setF] = useState<TaskFilters>(EMPTY);
  const { data, isLoading, error } = useTaskList(scope, f);
  const filtered = !!(f.q || f.workspace || f.priority || f.createdBy);
  return (
    <>
      <TaskFilterBar f={f} setF={setF} />
      {view === "board"
        ? <TaskBoard data={data} isLoading={isLoading} error={error} onOpen={onOpen} />
        : <TaskList data={data} isLoading={isLoading} error={error} onOpen={onOpen} filtered={filtered} onNew={onNew} canCreate={can("workflows", "edit")}
            emptyText={scope === "mine" ? "Tasks assigned to you from every workspace show up here." : "No one in your organisation has any open tasks."} />}
    </>
  );
}

export default function WorkflowsModule() {
  const { can } = useSession();
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<"list" | "board">(readView);
  const { data: summary } = useQuery({
    queryKey: ["wf-summary"], queryFn: () => api.get<{ myTasks: number; approvalsWaiting: number }>("/api/workflows/summary"), refetchInterval: 60_000,
  });

  if (!can("workflows", "view")) {
    return <><PageHeader title="Workflows" /><EmptyState title="You don't have access to Workflows">Ask an admin if you need it.</EmptyState></>;
  }

  const path = loc.pathname.replace(/\/+$/, "");
  const page = path === "/workflows" ? "dashboard" : path.startsWith("/workflows/mine") ? "mine" : path.startsWith("/workflows/all") ? "all" : "other";
  const taskId = params.get("task");
  const newOpen = params.get("new") === "task";
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };
  const toggleView = () => {
    const next = view === "list" ? "board" : "list";
    setView(next);
    try { localStorage.setItem("wv-wf-view", next); } catch { /* ignore */ }
  };
  const openTask = (id: string) => setParam("task", id);
  const newTask = () => setParam("new", "task");
  const isTaskPage = page === "mine" || page === "all";
  const my = summary?.myTasks ?? 0;
  const waiting = summary?.approvalsWaiting ?? 0;

  return (
    <div className="wf">
      <PageHeader
        title="Workflows"
        // The dashboard shows these counts itself, so its header doesn't repeat them.
        subtitle={page === "dashboard" ? "Tasks, approvals and checklists" : summary ? `${my} task${my === 1 ? "" : "s"} for you · ${waiting} approval${waiting === 1 ? "" : "s"} waiting` : " "}
        actions={<>
          {can("workflows", "edit") && (page === "dashboard" || isTaskPage) && <Button className="wf-new-btn" icon={<Plus size={16} />} onClick={newTask}>New task</Button>}
          <MoreMenu label="View options" className="hide-sm" items={[
            isTaskPage && { label: view === "list" ? "Show as board" : "Show as list", icon: view === "list" ? <Columns3 size={16} /> : <List size={16} />, onClick: toggleView },
          ]} />
        </>}
      />
      <Routes>
        <Route index element={<WorkflowsDashboard onOpen={openTask} />} />
        <Route path="mine" element={<TasksTab key="mine" scope="mine" view={view} onOpen={openTask} onNew={newTask} />} />
        <Route path="all" element={<TasksTab key="all" scope="all" view={view} onOpen={openTask} onNew={newTask} />} />
        <Route path="approvals" element={<ApprovalsView />} />
        <Route path="templates" element={<TemplatesView />} />
        <Route path="templates/:id" element={<TemplatePage />} />
        <Route path="*" element={<Navigate to="/workflows" replace />} />
      </Routes>
      <NewTaskModal open={newOpen} onClose={() => setParam("new", null)} onCreated={(id) => {
        const p = new URLSearchParams(params);
        p.delete("new");
        p.set("task", id);
        setParams(p, { replace: true });
      }} />
      <TaskDrawer id={taskId} onClose={() => setParam("task", null)} />
    </div>
  );
}
