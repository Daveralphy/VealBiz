import type { ReactNode } from "react";
import {
  Briefcase, Building2, CalendarDays, CheckSquare, Clock, FileText, Flag, FolderOpen, Globe, History, LayoutDashboard, LineChart, ListChecks,
  ListTodo, Network, Phone, Rows3, Share2, Archive, SquareCheck, Stamp, UserPlus, UserSearch, Users, Workflow, BarChart3, Kanban,
} from "lucide-react";
import type { Workspace } from "@windveal/shared";

/** A page inside a workspace, shown in that workspace's sidebar. */
export type Section = {
  to: string;
  label: string;
  icon: ReactNode;
  /** Name of a count from /api/home `badges` to show beside it. */
  badge?: string;
  /** Extra paths that also count as this section (e.g. a record page under a list). */
  also?: RegExp;
};
export type WorkspaceDef = { key: Workspace; label: string; base: string; icon: (size?: number) => ReactNode; blurb: string; sections: Section[] };

const i = (Icon: typeof Users) => (size = 18) => <Icon size={size} />;
const UUID = "[0-9a-f-]{36}";

/** The six workspaces, in the order they appear on Home. Each has its own dashboard and sidebar. */
export const WORKSPACE_DEFS: WorkspaceDef[] = [
  {
    key: "people", label: "People & HR", base: "/people", icon: i(Users), blurb: "Team, attendance and leave",
    sections: [
      { to: "/people", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/people/attendance", label: "Attendance", icon: <Clock size={18} /> },
      { to: "/people/directory", label: "Directory", icon: <Users size={18} />, also: new RegExp(`^/people/(employees/)?${UUID}`) },
      { to: "/people/departments", label: "Departments", icon: <Network size={18} /> },
      { to: "/people/leave", label: "Leave", icon: <CalendarDays size={18} />, badge: "leave" },
      { to: "/people/onboarding", label: "Onboarding", icon: <Flag size={18} />, badge: "onboarding" },
    ],
  },
  {
    key: "recruitment", label: "Recruitment", base: "/recruitment", icon: i(UserPlus), blurb: "Jobs, candidates and interviews",
    sections: [
      { to: "/recruitment", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/recruitment/jobs", label: "Jobs", icon: <Briefcase size={18} /> },
      { to: "/recruitment/candidates", label: "Candidates", icon: <UserSearch size={18} />, also: /^\/recruitment\/applications\// },
      { to: "/recruitment/interviews", label: "Interviews", icon: <CalendarDays size={18} />, badge: "interviews" },
      { to: "/recruitment/careers", label: "Careers page", icon: <Globe size={18} /> },
    ],
  },
  {
    key: "crm", label: "CRM", base: "/crm", icon: i(Briefcase), blurb: "Leads, deals and clients",
    sections: [
      { to: "/crm", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/crm/pipeline", label: "Pipeline", icon: <Kanban size={18} /> },
      { to: "/crm/companies", label: "Companies", icon: <Building2 size={18} /> },
      { to: "/crm/leads", label: "Leads", icon: <Rows3 size={18} /> },
      { to: "/crm/follow-ups", label: "Follow-ups", icon: <Phone size={18} />, badge: "followUps" },
    ],
  },
  {
    key: "workflows", label: "Workflows", base: "/workflows", icon: i(SquareCheck), blurb: "Tasks, approvals and checklists",
    sections: [
      { to: "/workflows", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/workflows/mine", label: "My tasks", icon: <CheckSquare size={18} />, badge: "myTasks" },
      { to: "/workflows/approvals", label: "Approvals", icon: <Stamp size={18} />, badge: "approvals" },
      { to: "/workflows/all", label: "All tasks", icon: <ListTodo size={18} /> },
      { to: "/workflows/templates", label: "Templates", icon: <ListChecks size={18} /> },
    ],
  },
  {
    key: "documents", label: "Documents", base: "/documents", icon: i(FileText), blurb: "Every business file in one place",
    sections: [
      { to: "/documents", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/documents/library", label: "All files", icon: <FolderOpen size={18} />, also: /^\/documents\/(folder|file|files)\// },
      { to: "/documents/recent", label: "Recent", icon: <History size={18} /> },
      { to: "/documents/shared", label: "Shared with me", icon: <Share2 size={18} /> },
      { to: "/documents/archive", label: "Archive", icon: <Archive size={18} /> },
    ],
  },
  {
    key: "insights", label: "Insights", base: "/insights", icon: i(LineChart), blurb: "Reports on how the business is doing",
    sections: [
      { to: "/insights", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/insights/sales", label: "Sales", icon: <BarChart3 size={18} /> },
      { to: "/insights/people", label: "People", icon: <Users size={18} /> },
      { to: "/insights/hiring", label: "Hiring", icon: <UserPlus size={18} /> },
      { to: "/insights/work", label: "Work", icon: <Workflow size={18} /> },
    ],
  },
];

/** The workspace a path belongs to, if any (Home, Profile, Settings and the like aren't in a workspace). */
export function workspaceFor(path: string): WorkspaceDef | null {
  return WORKSPACE_DEFS.find((w) => path === w.base || path.startsWith(`${w.base}/`)) ?? null;
}

/** Whether a section is the one being shown: its own page, a deeper page under it, or one of its `also` paths. */
export function sectionActive(ws: WorkspaceDef, s: Section, path: string): boolean {
  if (s.to === ws.base) return path === ws.base;
  if (path === s.to || path.startsWith(`${s.to}/`)) return true;
  return !!s.also?.test(path);
}
