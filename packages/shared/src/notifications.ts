/** Kinds of notification. Everyone gets all of them to start; each person can turn off the ones they don't need. */
export const NOTIFICATION_KINDS = {
  leave: { name: "Leave", what: "Requests to approve, and answers to your own requests" },
  people: { name: "People & HR", what: "New starters, onboarding and changes to your team" },
  hiring: { name: "Hiring", what: "New applications, interviews and offers" },
  crm: { name: "CRM", what: "Follow-ups due and deals that need you" },
  tasks: { name: "Tasks and approvals", what: "Tasks given to you, comments, mentions and approvals" },
  documents: { name: "Documents and imports", what: "Files shared with you and imports that finish" },
  team: { name: "Your team", what: "People joining, invitations and role changes" },
  account: { name: "Your business", what: "WindVeal's review, plan and account" },
  windveal: { name: "WindVeal admin", what: "Businesses waiting for review (WindVeal staff only)" },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export const NOTIFICATION_KIND_KEYS = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

/** Which kind a notification is, from where it takes you. */
export function notificationKind(link: string | null | undefined): NotificationKind {
  const l = link ?? "/";
  if (l.startsWith("/people/leave") || l.startsWith("/me/leave")) return "leave";
  if (l.startsWith("/people") || l.startsWith("/me")) return "people";
  if (l.startsWith("/recruitment")) return "hiring";
  if (l.startsWith("/crm")) return "crm";
  if (l.startsWith("/workflows")) return "tasks";
  if (l.startsWith("/documents") || l.startsWith("/import")) return "documents";
  if (l.startsWith("/settings")) return "team";
  if (l.startsWith("/admin")) return "windveal";
  return "account";
}

/** A person's choices. `off` lists the kinds they've turned off; `desktop` shows pop-ups on their computer. */
export type NotificationPrefs = { off: NotificationKind[]; desktop: boolean };
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { off: [], desktop: true };
