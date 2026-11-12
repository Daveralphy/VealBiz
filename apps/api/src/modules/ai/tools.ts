import type { ToolSpec } from "../../lib/ai";

/** Calls one of WindVeal's own endpoints as the person using the assistant (their access, their rules). */
export type Call = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => Promise<{ status: number; body: any }>;

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Changes something: the person confirms first. */
  change?: boolean;
  /** One plain sentence for the confirmation card. */
  summary?: (args: any) => string;
  run: (call: Call, args: any) => Promise<unknown>;
};

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : "";
};

/** Keeps answers small: short lists, no long texts, no nested detail the model doesn't need. */
export function compact(x: unknown, depth = 0): unknown {
  if (Array.isArray(x)) return x.slice(0, 15).map((v) => compact(v, depth + 1));
  if (x && typeof x === "object") {
    if (depth > 3) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
      if (v === null || v === undefined || v === "" || /Id$|^id$|FileId|avatar|logo|cover|version|deletedAt/.test(k)) continue;
      const c = compact(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  if (typeof x === "string" && x.length > 300) return `${x.slice(0, 300)}…`;
  return x;
}

/** What went wrong, in the API's own words. */
const failed = (r: { status: number; body: any }) => ({ error: r.body?.error?.message ?? `That didn't work (${r.status}).`, details: r.body?.error?.details });
const ok = async (r: Promise<{ status: number; body: any }>) => { const x = await r; return x.status >= 400 ? failed(x) : compact(x.body); };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** "2026-11-24" → "24 Nov" for the confirmation cards (anything else is shown as given). */
const day = (d?: string) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d ?? "";
  return new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.slice(0, 4) !== String(new Date().getFullYear()) ? { year: "numeric" } : {}) });
};

/** Finds one match by name, or says what's ambiguous / missing. */
function pick<T extends { name: string }>(list: T[], name: string, what: string): T | { error: string } {
  const n = norm(name);
  const exact = list.filter((x) => norm(x.name) === n);
  const hits = exact.length ? exact : list.filter((x) => norm(x.name).includes(n));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) return { error: `No ${what} called "${name}".` };
  return { error: `More than one ${what} matches "${name}": ${hits.slice(0, 5).map((h) => h.name).join(", ")}. Which one?` };
}
const isErr = (x: unknown): x is { error: string } => !!x && typeof x === "object" && "error" in x;

async function employee(call: Call, name: string) {
  const r = await call("GET", "/api/people/employees/options");
  if (r.status >= 400) return { error: "You can't see other people's records, so I can't do that for someone else." };
  return pick(r.body as { id: string; name: string }[], name, "person");
}
async function member(call: Call, name: string) {
  const r = await call("GET", "/api/members/assignable");
  return pick(r.body as { id: string; name: string }[], name, "team member");
}

export const TOOLS: Tool[] = [
  // ---------------- looking things up ----------------
  {
    name: "search", description: "Search WindVeal for people, companies, deals, leads, jobs, candidates, files, tasks and members by name or words.",
    parameters: obj({ query: str("What to look for") }, ["query"]),
    run: (call, a) => ok(call("GET", `/api/search${q({ q: a.query })}`)),
  },
  {
    name: "my_tasks", description: "The person's own open tasks, with due dates.",
    parameters: obj({}),
    run: (call) => ok(call("GET", "/api/workflows/tasks?scope=mine")),
  },
  {
    name: "my_leave", description: "The person's own leave balances and leave requests.",
    parameters: obj({}),
    run: async (call) => ({ balances: await ok(call("GET", "/api/people/leave/balances")), requests: await ok(call("GET", "/api/people/leave/requests?scope=mine")) }),
  },
  {
    name: "my_attendance", description: "The person's own clock-ins this month.",
    parameters: obj({}),
    run: (call) => ok(call("GET", "/api/my/attendance")),
  },
  {
    name: "whos_off", description: "Who is on leave (or has asked for leave) between two dates, among the people this person may see.",
    parameters: obj({ from: str("First day, YYYY-MM-DD"), to: str("Last day, YYYY-MM-DD") }),
    run: (call, a) => ok(call("GET", `/api/people/leave/calendar${q({ from: a.from, to: a.to })}`)),
  },
  {
    name: "team_today", description: "Today's attendance for the people this person may see: who is in, late, on leave or not in yet.",
    parameters: obj({}),
    run: (call) => ok(call("GET", "/api/people/attendance")),
  },
  {
    name: "leads", description: "CRM leads, optionally filtered by words.",
    parameters: obj({ query: str("Words to filter by (optional)") }),
    run: (call, a) => ok(call("GET", `/api/crm/leads${q({ q: a.query })}`)),
  },
  {
    name: "deals", description: "CRM deals with their stage and value, optionally filtered by words.",
    parameters: obj({ query: str("Words to filter by (optional)") }),
    run: (call, a) => ok(call("GET", `/api/crm/deals${q({ q: a.query })}`)),
  },
  {
    name: "follow_ups", description: "CRM follow-ups that are due or overdue.",
    parameters: obj({}),
    run: (call) => ok(call("GET", "/api/crm/follow-ups")),
  },
  {
    name: "jobs", description: "Recruitment jobs with how many candidates each has.",
    parameters: obj({ status: str("open, closed or draft (optional)") }),
    run: (call, a) => ok(call("GET", `/api/recruitment/jobs${q({ status: a.status })}`)),
  },
  {
    name: "candidates", description: "Candidates who applied, optionally filtered by name or job.",
    parameters: obj({ query: str("Words to filter by (optional)") }),
    run: (call, a) => ok(call("GET", `/api/recruitment/applications${q({ q: a.query })}`)),
  },

  // ---------------- making changes (always confirmed first) ----------------
  {
    name: "request_leave", change: true,
    description: "Ask for leave for the person themself, or (if they manage people) for someone in their team.",
    parameters: obj({
      person: str("Whose leave, if not the person's own (a name)"), leaveType: str("e.g. Annual leave, Sick leave (optional)"),
      startDate: str("First day, YYYY-MM-DD"), endDate: str("Last day, YYYY-MM-DD (same as startDate for one day)"), reason: str("Reason or note (optional)"),
    }, ["startDate"]),
    summary: (a) => `Ask for ${a.leaveType ?? "leave"} ${a.person ? `for ${a.person} ` : ""}from ${day(a.startDate)}${a.endDate && a.endDate !== a.startDate ? ` to ${day(a.endDate)}` : ""}${a.reason ? ` (${a.reason})` : ""}.`,
    run: async (call, a) => {
      const types = (await call("GET", "/api/people/leave-types")).body as { id: string; name: string }[];
      const type = a.leaveType ? pick(types, a.leaveType, "leave type") : types[0];
      if (!type) return { error: "No leave types are set up yet." };
      if (isErr(type)) return type;
      const who = a.person ? await employee(call, a.person) : null;
      if (isErr(who)) return who;
      return ok(call("POST", "/api/people/leave/requests", { employeeId: who?.id, leaveTypeId: type.id, startDate: a.startDate, endDate: a.endDate || a.startDate, reason: a.reason }));
    },
  },
  {
    name: "create_task", change: true, description: "Create a task, optionally for someone else, with a due date and priority.",
    parameters: obj({
      title: str("What needs doing"), assignee: str("Who it's for (a name; leave out for the person themself)"),
      dueDate: str("Due date, YYYY-MM-DD (optional)"), priority: { type: "string", enum: ["low", "medium", "high"] }, description: str("More detail (optional)"),
    }, ["title"]),
    summary: (a) => `Create the task "${a.title}"${a.assignee ? ` for ${a.assignee}` : ""}${a.dueDate ? `, due ${day(a.dueDate)}` : ""}${a.priority && a.priority !== "medium" ? `, ${a.priority} priority` : ""}.`,
    run: async (call, a) => {
      // Nobody named: it's the person's own task.
      const who = a.assignee ? await member(call, a.assignee) : { id: (await call("GET", "/api/auth/me")).body?.user?.id as string };
      if (isErr(who)) return who;
      return ok(call("POST", "/api/workflows/tasks", { title: a.title, description: a.description, assigneeUserId: who.id, dueAt: a.dueDate || null, priority: a.priority ?? "medium" }));
    },
  },
  {
    name: "complete_task", change: true, description: "Mark one of the person's own tasks as done.",
    parameters: obj({ task: str("The task's title, or words from it") }, ["task"]),
    summary: (a) => `Mark the task "${a.task}" as done.`,
    run: async (call, a) => {
      const r = await call("GET", "/api/workflows/tasks?scope=mine");
      const groups = (r.body?.groups ?? []) as { tasks: { id: string; title: string }[] }[];
      const list = groups.flatMap((g) => g.tasks).map((t) => ({ ...t, name: t.title }));
      const t = pick(list, a.task, "task");
      if (isErr(t)) return t;
      return ok(call("POST", `/api/workflows/tasks/${t.id}/complete`));
    },
  },
  {
    name: "add_lead", change: true, description: "Add a CRM lead (a business that might buy).",
    parameters: obj({
      companyName: str("The business's name"), contactName: str("Who to talk to (optional)"), email: str("Email (optional)"), phone: str("Phone (optional)"),
      source: str("Where the lead came from (optional)"), estimatedValue: { type: "number", description: "Estimated value (optional)" },
      nextStep: str("What to do next (optional)"), nextStepDue: str("When, YYYY-MM-DD (optional)"),
    }, ["companyName"]),
    summary: (a) => `Add ${a.companyName} as a lead${a.contactName ? ` (contact: ${a.contactName})` : ""}${a.nextStep ? `, next step: ${a.nextStep}` : ""}.`,
    run: (call, a) => ok(call("POST", "/api/crm/leads", a)),
  },
  {
    name: "add_company", change: true, description: "Add a company to the CRM.",
    parameters: obj({
      name: str("The company's name"), industry: str("Industry (optional)"), location: str("City or address (optional)"), website: str("Website (optional)"),
      status: { type: "string", enum: ["prospect", "client", "former"] },
    }, ["name"]),
    summary: (a) => `Add the company ${a.name}${a.status ? ` as a ${a.status}` : ""}${a.location ? ` in ${a.location}` : ""}.`,
    run: (call, a) => ok(call("POST", "/api/crm/companies", a)),
  },
  {
    name: "add_deal", change: true, description: "Add a CRM deal with a company (an existing company, or a new one by name).",
    parameters: obj({
      name: str("What the deal is"), company: str("The company's name"), value: { type: "number", description: "Value (optional)" },
      expectedCloseOn: str("Expected close date, YYYY-MM-DD (optional)"),
    }, ["name", "company"]),
    summary: (a) => `Add the deal "${a.name}" with ${a.company}${a.value ? ` worth ${a.value}` : ""}${a.expectedCloseOn ? `, closing ${day(a.expectedCloseOn)}` : ""}.`,
    run: async (call, a) => {
      const r = await call("GET", `/api/crm/companies${q({ q: a.company })}`);
      const list = ((r.body?.items ?? r.body ?? []) as { id: string; name: string }[]);
      const hit = list.find((c) => norm(c.name) === norm(a.company));
      return ok(call("POST", "/api/crm/deals", {
        name: a.name, value: a.value, expectedCloseOn: a.expectedCloseOn,
        ...(hit ? { companyId: hit.id } : { newCompany: { name: a.company } }),
      }));
    },
  },
  {
    name: "add_employee", change: true, description: "Add someone to People & HR.",
    parameters: obj({
      firstName: str("First name"), lastName: str("Last name"), email: str("Email (optional)"), jobTitle: str("Job title (optional)"),
      startDate: str("Start date, YYYY-MM-DD (optional)"), department: str("Department name (optional)"),
    }, ["firstName", "lastName"]),
    summary: (a) => `Add ${a.firstName} ${a.lastName} to People & HR${a.jobTitle ? ` as ${a.jobTitle}` : ""}${a.department ? ` in ${a.department}` : ""}${a.startDate ? `, starting ${day(a.startDate)}` : ""}.`,
    run: async (call, a) => {
      let departmentId: string | undefined;
      if (a.department) {
        const d = pick(((await call("GET", "/api/people/departments")).body ?? []) as { id: string; name: string }[], a.department, "department");
        if (isErr(d)) return d;
        departmentId = d.id;
      }
      const { department: _d, ...rest } = a;
      return ok(call("POST", "/api/people/employees", { ...rest, departmentId }));
    },
  },
  {
    name: "clock", change: true, description: "Clock the person in or out, or start or end a break.",
    parameters: obj({ action: { type: "string", enum: ["in", "out", "break", "resume"] } }, ["action"]),
    summary: (a) => ({ in: "Clock you in.", out: "Clock you out.", break: "Start a break.", resume: "End your break." } as Record<string, string>)[a.action] ?? "Update your clock.",
    run: (call, a) => ok(call("POST", `/api/people/attendance/${({ in: "clock-in", out: "clock-out", break: "pause", resume: "resume" } as Record<string, string>)[a.action] ?? "clock-in"}`)),
  },
];

export const toolSpecs = (tools: Tool[] = TOOLS): ToolSpec[] => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
