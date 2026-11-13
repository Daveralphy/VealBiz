import type { Workspace } from "./constants";

/** Areas with an Assistant page: "me" is My Workspace (everyone's own things). */
export const ASSISTANT_AREAS = ["me", "people", "recruitment", "crm", "workflows", "documents", "insights"] as const;
export type AssistantArea = (typeof ASSISTANT_AREAS)[number];

/** The workspace whose access decides whether someone may open an area's pages ("me" is everyone's). */
export const AREA_ACCESS: Record<AssistantArea, Workspace | null> = {
  me: null, people: "people", recruitment: "recruitment", crm: "crm", workflows: "workflows", documents: "documents", insights: "insights",
};

export const AREA_NAMES: Record<AssistantArea, string> = {
  me: "My Workspace", people: "People & HR", recruitment: "Recruitment", crm: "CRM", workflows: "Workflows", documents: "Documents", insights: "Insights",
};

/**
 * The pages Veal may send someone to, by area. A button in a chat or a briefing can only point at one of these,
 * so the AI can't invent a link.
 */
export const AREA_PAGES: Record<AssistantArea, { to: string; label: string }[]> = {
  me: [
    { to: "/me", label: "My Workspace" }, { to: "/me/attendance", label: "My attendance" }, { to: "/me/leave", label: "My leave" }, { to: "/me/tasks", label: "My tasks" },
    { to: "/me/pay", label: "My pay" }, { to: "/me/onboarding", label: "My onboarding" },
  ],
  people: [
    { to: "/people", label: "People dashboard" }, { to: "/people/attendance", label: "Attendance" }, { to: "/people/directory", label: "Directory" },
    { to: "/people/departments", label: "Departments" }, { to: "/people/leave", label: "Leave" }, { to: "/people/onboarding", label: "Onboarding" },
  ],
  recruitment: [
    { to: "/recruitment", label: "Recruitment dashboard" }, { to: "/recruitment/jobs", label: "Jobs" },
    { to: "/recruitment/candidates", label: "Candidates" }, { to: "/recruitment/interviews", label: "Interviews" },
  ],
  crm: [
    { to: "/crm", label: "CRM dashboard" }, { to: "/crm/pipeline", label: "Pipeline" }, { to: "/crm/companies", label: "Companies" },
    { to: "/crm/leads", label: "Leads" }, { to: "/crm/follow-ups", label: "Follow-ups" },
  ],
  workflows: [
    { to: "/workflows", label: "Workflows dashboard" }, { to: "/workflows/mine", label: "My tasks" },
    { to: "/workflows/approvals", label: "Approvals" }, { to: "/workflows/all", label: "All tasks" },
  ],
  documents: [
    { to: "/documents", label: "Documents dashboard" }, { to: "/documents/library", label: "All files" }, { to: "/documents/recent", label: "Recent files" },
    { to: "/import/new", label: "Import data" }, { to: "/import/history", label: "Import history" },
  ],
  insights: [
    { to: "/insights", label: "Insights dashboard" }, { to: "/insights/sales", label: "Sales report" }, { to: "/insights/people", label: "People report" },
    { to: "/insights/hiring", label: "Hiring report" }, { to: "/insights/work", label: "Work report" },
  ],
};

/** A button Veal adds under a reply: a page to go to. */
export type VealLink = { label: string; to: string };

/** One thing Veal noticed on an area's Assistant page. */
export type BriefingItem = { tone: "bad" | "warn" | "good" | "info"; title: string; detail: string; link?: VealLink };
export type Briefing = { summary: string; items: BriefingItem[]; at: string };

/** Chats are kept this long after they were last used, then cleared. */
export const CHAT_KEEP_DAYS = 15;
