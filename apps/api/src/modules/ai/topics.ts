import type { Workspace } from "@windveal/shared";
import type { ChatMessage } from "../../lib/ai";
import { TOOLS, type Tool } from "./tools";

/**
 * Which tools to offer for a question. A small model on a plain computer spends most of its time reading the
 * list of tools, so it's sent only the ones the question is about (a leave question gets the leave tools,
 * not the CRM ones), and never tools for areas the person can't open.
 */
const TOPICS: { tools: string[]; words: RegExp }[] = [
  { tools: ["my_leave", "whos_off", "request_leave"], words: /\b(leave|off|holiday|vacation|sick|annual|maternity|paternity|absent|away|time off)/ },
  { tools: ["my_attendance", "team_today", "clock"], words: /\b(clock|break|attendance|late|present|in today|who'?s in|who is in|punch|check(ed)? in|hours)/ },
  { tools: ["my_tasks", "create_task", "complete_task"], words: /\b(task|to-?do|remind|plate|done|finish|complete|deadline|due|work on|busy)/ },
  { tools: ["leads", "deals", "follow_ups", "add_lead", "add_company", "add_deal"], words: /\b(lead|deal|client|customer|compan|prospect|pipeline|sale|follow[- ]?up|crm|contact|call|buyer)/ },
  { tools: ["add_employee", "team_today", "whos_off"], words: /\b(employee|staff|team|colleague|worker|new hire|joined|manager|department|people)/ },
  { tools: ["jobs", "candidates"], words: /\b(job|candidate|applicant|appl(y|ied|ication)|interview|recruit|hiring|vacanc|opening|position|cv)/ },
];

/** Search works anywhere, so it's always there. */
const ALWAYS = ["search"];

/** Tools that need an area the person might not have; the rest are about the person's own things. */
const AREA: Partial<Record<string, Workspace>> = {
  leads: "crm", deals: "crm", follow_ups: "crm", add_lead: "crm", add_company: "crm", add_deal: "crm",
  jobs: "recruitment", candidates: "recruitment",
  add_employee: "people",
  my_tasks: "workflows", create_task: "workflows", complete_task: "workflows",
};

const matching = (text: string) => TOPICS.filter((t) => t.words.test(text.toLowerCase())).flatMap((t) => t.tools);

export function toolsFor(messages: ChatMessage[], access: Record<Workspace, string>): Tool[] {
  const said = messages.flatMap((m) => (m.role === "user" ? [m.content] : []));
  // The latest message decides; a short follow-up ("make it Friday") carries on with the earlier topic.
  let names = matching(said.at(-1) ?? "");
  for (let i = said.length - 2; !names.length && i >= 0; i--) names = matching(said[i]!);
  // Tools already used in this conversation stay, so the model can carry on where it was.
  const used = messages.flatMap((m) => (m.role === "assistant" ? m.tool_calls?.map((t) => t.function.name) ?? [] : []));
  const wanted = names.length ? new Set([...ALWAYS, ...names, ...used]) : null;
  return TOOLS.filter((t) => (!wanted || wanted.has(t.name)) && (!AREA[t.name] || access[AREA[t.name]!] !== "none"));
}
