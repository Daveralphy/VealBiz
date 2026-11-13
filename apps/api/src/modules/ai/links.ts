import { AREA_ACCESS, type AssistantArea, type VealLink } from "@windveal/shared";
import type { ChatMessage } from "../../lib/ai";
import type { OrgContext } from "../../lib/context";

/**
 * The page that goes with each tool, so a reply can end with a button to where the answer lives
 * ("Open My leave"). Worked out from what Veal actually looked at, never made up by the model.
 */
const PAGE: Record<string, { area: AssistantArea; link: VealLink }> = {
  my_leave: { area: "me", link: { label: "Open My leave", to: "/me/leave" } },
  request_leave: { area: "me", link: { label: "Open My leave", to: "/me/leave" } },
  my_attendance: { area: "me", link: { label: "Open My attendance", to: "/me/attendance" } },
  clock: { area: "me", link: { label: "Open My attendance", to: "/me/attendance" } },
  my_tasks: { area: "workflows", link: { label: "Open My tasks", to: "/workflows/mine" } },
  create_task: { area: "workflows", link: { label: "Open My tasks", to: "/workflows/mine" } },
  complete_task: { area: "workflows", link: { label: "Open My tasks", to: "/workflows/mine" } },
  whos_off: { area: "people", link: { label: "Open Leave", to: "/people/leave" } },
  team_today: { area: "people", link: { label: "Open Attendance", to: "/people/attendance" } },
  add_employee: { area: "people", link: { label: "Open Directory", to: "/people/directory" } },
  leads: { area: "crm", link: { label: "Open Leads", to: "/crm/leads" } },
  add_lead: { area: "crm", link: { label: "Open Leads", to: "/crm/leads" } },
  deals: { area: "crm", link: { label: "Open Pipeline", to: "/crm/pipeline" } },
  add_deal: { area: "crm", link: { label: "Open Pipeline", to: "/crm/pipeline" } },
  add_company: { area: "crm", link: { label: "Open Companies", to: "/crm/companies" } },
  follow_ups: { area: "crm", link: { label: "Open Follow-ups", to: "/crm/follow-ups" } },
  jobs: { area: "recruitment", link: { label: "Open Jobs", to: "/recruitment/jobs" } },
  candidates: { area: "recruitment", link: { label: "Open Candidates", to: "/recruitment/candidates" } },
};

export const canOpenArea = (ctx: OrgContext, area: AssistantArea) => {
  const w = AREA_ACCESS[area];
  return !w || ctx.access[w] !== "none";
};

/** Buttons for the tools used since the person's last message: at most two, only to pages they can open. */
export function linksFor(ctx: OrgContext, messages: ChatMessage[]): VealLink[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const used = messages.slice(lastUser + 1).flatMap((m) => (m.role === "assistant" ? m.tool_calls?.map((t) => t.function.name) ?? [] : []));
  const out: VealLink[] = [];
  for (const name of used) {
    const p = PAGE[name];
    if (!p || !canOpenArea(ctx, p.area) || out.some((l) => l.to === p.link.to)) continue;
    out.push(p.link);
  }
  return out.slice(0, 2);
}
