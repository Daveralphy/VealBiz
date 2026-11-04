import type { ReactNode } from "react";
import {
  Briefcase, Building2, CalendarDays, CheckSquare, Clock, FileText, Flag, FolderOpen, Globe, History, LayoutDashboard, LineChart, ListChecks,
  ListTodo, Network, Phone, Rows3, Share2, Archive, SquareCheck, Stamp, UserPlus, UserSearch, Users, Workflow, BarChart3, Kanban,
  Settings, Download, ShieldCheck, Mail, KeyRound, ScrollText, Upload, User, Building, Building2 as Org,
} from "lucide-react";
import type { Workspace } from "@windveal/shared";
import { useSession } from "./session";

/** What decides whether someone can see an area or one of its sections. */
export type Viewer = { isAdmin: boolean; platformAdmin: boolean; canImport: boolean; canManageMembers: boolean };

/** A page inside a workspace, shown in that workspace's sidebar. */
export type Section = {
  /** Hide from people who can't use it (e.g. admin-only pages). */
  visible?: (v: Viewer) => boolean;
  to: string;
  label: string;
  icon: ReactNode;
  /** Name of a count from /api/home `badges` to show beside it. */
  badge?: string;
  /** Extra paths that also count as this section (e.g. a record page under a list). */
  also?: RegExp;
};
export type AreaKey = Workspace | "settings" | "import" | "admin" | "profile";
export type WorkspaceDef = {
  key: AreaKey; label: string; base: string; icon: (size?: number) => ReactNode; blurb: string; sections: Section[];
  /** "workspace" tiles come first on Home; "manage" tiles (Settings, Import, Admin) after; "account" has no tile. */
  group: "workspace" | "manage" | "account";
  visible?: (v: Viewer) => boolean;
  /** Whether the top bar offers search here. */
  search?: boolean;
};

const i = (Icon: typeof Users) => (size = 18) => <Icon size={size} />;
const UUID = "[0-9a-f-]{36}";

/** The six workspaces, in the order they appear on Home. Each has its own dashboard and sidebar. */
export const WORKSPACE_DEFS: WorkspaceDef[] = [
  {
    key: "people", label: "People & HR", base: "/people", icon: i(Users), blurb: "Team, attendance and leave", group: "workspace", search: true,
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
    key: "recruitment", label: "Recruitment", base: "/recruitment", icon: i(UserPlus), blurb: "Jobs, candidates and interviews", group: "workspace", search: true,
    sections: [
      { to: "/recruitment", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/recruitment/jobs", label: "Jobs", icon: <Briefcase size={18} /> },
      { to: "/recruitment/candidates", label: "Candidates", icon: <UserSearch size={18} />, also: /^\/recruitment\/applications\// },
      { to: "/recruitment/interviews", label: "Interviews", icon: <CalendarDays size={18} />, badge: "interviews" },
      { to: "/recruitment/careers", label: "Careers page", icon: <Globe size={18} /> },
    ],
  },
  {
    key: "crm", label: "CRM", base: "/crm", icon: i(Briefcase), blurb: "Leads, deals and clients", group: "workspace", search: true,
    sections: [
      { to: "/crm", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/crm/pipeline", label: "Pipeline", icon: <Kanban size={18} /> },
      { to: "/crm/companies", label: "Companies", icon: <Building2 size={18} /> },
      { to: "/crm/leads", label: "Leads", icon: <Rows3 size={18} /> },
      { to: "/crm/follow-ups", label: "Follow-ups", icon: <Phone size={18} />, badge: "followUps" },
    ],
  },
  {
    key: "workflows", label: "Workflows", base: "/workflows", icon: i(SquareCheck), blurb: "Tasks, approvals and checklists", group: "workspace", search: true,
    sections: [
      { to: "/workflows", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/workflows/mine", label: "My tasks", icon: <CheckSquare size={18} />, badge: "myTasks" },
      { to: "/workflows/approvals", label: "Approvals", icon: <Stamp size={18} />, badge: "approvals" },
      { to: "/workflows/all", label: "All tasks", icon: <ListTodo size={18} /> },
      { to: "/workflows/templates", label: "Templates", icon: <ListChecks size={18} /> },
    ],
  },
  {
    key: "documents", label: "Documents", base: "/documents", icon: i(FileText), blurb: "Every business file in one place", group: "workspace", search: true,
    sections: [
      { to: "/documents", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/documents/library", label: "All files", icon: <FolderOpen size={18} />, also: /^\/documents\/(folder|file|files)\// },
      { to: "/documents/recent", label: "Recent", icon: <History size={18} /> },
      { to: "/documents/shared", label: "Shared with me", icon: <Share2 size={18} /> },
      { to: "/documents/archive", label: "Archive", icon: <Archive size={18} /> },
    ],
  },
  {
    key: "insights", label: "Insights", base: "/insights", icon: i(LineChart), blurb: "Reports on how the business is doing", group: "workspace", search: true,
    sections: [
      { to: "/insights", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/insights/sales", label: "Sales", icon: <BarChart3 size={18} /> },
      { to: "/insights/people", label: "People", icon: <Users size={18} /> },
      { to: "/insights/hiring", label: "Hiring", icon: <UserPlus size={18} /> },
      { to: "/insights/work", label: "Work", icon: <Workflow size={18} /> },
    ],
  },
  {
    key: "settings", label: "Settings", base: "/settings", icon: i(Settings), blurb: "Team and permissions", group: "manage",
    visible: (v) => v.isAdmin || v.canManageMembers,
    sections: [
      { to: "/settings", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/settings/members", label: "Members", icon: <Users size={18} /> },
      { to: "/settings/invitations", label: "Invitations", icon: <Mail size={18} />, badge: "invitations" },
      { to: "/settings/roles", label: "Roles", icon: <KeyRound size={18} />, visible: (v) => v.isAdmin },
      { to: "/settings/audit", label: "Audit history", icon: <ScrollText size={18} />, visible: (v) => v.isAdmin },
    ],
  },
  {
    key: "import", label: "Import data", base: "/import", icon: i(Download), blurb: "Bring in spreadsheets", group: "manage",
    visible: (v) => v.canImport,
    sections: [
      { to: "/import", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/import/new", label: "New import", icon: <Upload size={18} />, also: new RegExp(`^/import/${UUID}`) },
      { to: "/import/history", label: "History", icon: <History size={18} />, badge: "importsOpen" },
    ],
  },
  {
    key: "admin", label: "WindVeal admin", base: "/admin", icon: i(ShieldCheck), blurb: "Organisations and accounts", group: "manage",
    visible: (v) => v.platformAdmin,
    sections: [
      { to: "/admin", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
      { to: "/admin/organisations", label: "Organisations", icon: <Building size={18} />, badge: "adminWaiting" },
      { to: "/admin/people", label: "People", icon: <Users size={18} /> },
    ],
  },
  {
    key: "profile", label: "Profile", base: "/profile", icon: i(User), blurb: "Your details and your company's", group: "account",
    sections: [
      { to: "/profile", label: "Personal", icon: <User size={18} /> },
      { to: "/profile/company", label: "Company", icon: <Org size={18} /> },
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

/** Who can open which areas and sections (workspace access for workspaces; roles for the rest). */
export function useAreaAccess() {
  const { isAdmin, user, can, hasSpecial } = useSession();
  const importer = hasSpecial("import_data");
  const viewer: Viewer = {
    isAdmin, platformAdmin: !!user.platformAdmin, canManageMembers: hasSpecial("manage_members"),
    canImport: isAdmin || (["people", "crm", "recruitment"] as Workspace[]).some((w) => can(w, "manage") || (importer && can(w, "edit"))),
  };
  const canOpen = (w: WorkspaceDef) => (w.group === "workspace" ? can(w.key as Workspace) : w.visible ? w.visible(viewer) : true);
  const sectionsOf = (w: WorkspaceDef) => w.sections.filter((s) => !s.visible || s.visible(viewer));
  /**
   * Whether a page can be opened at all, however it was reached (a link, the address bar, an old bookmark).
   * The server checks the same rules on every request; this keeps people from landing on a screen they can't use.
   */
  const canOpenPath = (path: string) => {
    const w = workspaceFor(path);
    if (!w) return true;
    if (!canOpen(w)) return false;
    const section = w.sections.find((s) => s.to !== w.base && sectionActive(w, s, path));
    if (section?.visible && !section.visible(viewer)) return false;
    // Creating or editing something needs Edit in that workspace.
    if (w.group === "workspace" && /\/(new|edit)$/.test(path) && !can(w.key as Workspace, "edit")) return false;
    return true;
  };
  return { viewer, canOpen, sectionsOf, canOpenPath };
}
