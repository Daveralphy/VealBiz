import { useQuery } from "@tanstack/react-query";
import type { Tone } from "@windveal/ui";
import { api } from "../../lib/api";
import { fmtDate } from "../../lib/format";

export type EmployeeStatus = "onboarding" | "active" | "on_leave" | "leaving" | "left";

export type Employee = {
  id: string; firstName: string; lastName: string; name: string; email: string | null; phone: string | null; jobTitle: string | null;
  departmentId: string | null; departmentName: string | null; managerId: string | null; managerName: string | null;
  location: string | null; employmentType: string | null; startDate: string | null; endDate: string | null; status: EmployeeStatus;
  employeeCode: string | null; userId: string | null;
};

export type Balance = {
  leaveTypeId: string; name: string; paid: boolean; requiresNote: boolean; daysPerYear: number | null; used: number; pending: number; remaining: number | null;
};

export type Profile = Employee & {
  reference: string | null; extraDetails: Record<string, string>;
  personal: { dateOfBirth: string | null; homeAddress: string | null; emergencyContact: string | null; nationalId: string | null } | null;
  manager: { id: string; name: string; jobTitle: string | null } | null;
  reports: { id: string; name: string; jobTitle: string | null }[];
  balances: Balance[];
  documents: { id: string; name: string; mime: string; size: number; createdAt: string; linkId: string; category: string | null }[];
  history: { id: string; occurredOn: string; event: string; details: string | null; actorName: string | null }[];
  checklists: { id: string; kind: "onboarding" | "offboarding"; title: string; status: string; total: number; done: number }[];
  canSeePay: boolean; isSelf: boolean; hasAccount: boolean; documentsHidden: boolean;
};

export type Stats = {
  headcount: number; joinedThisQuarter: number; departments: number;
  onLeaveToday: { count: number; names: string[]; until: string | null };
  startingSoon: { count: number; nextStart: string | null; next14Days: number };
  leaving: { count: number; next: { name: string; endDate: string | null } | null };
  pendingForMe: number; onboardingInProgress: number; myEmployeeId: string | null;
};

export type Department = {
  id: string; name: string; headEmployeeId: string | null; count: number;
  head: { id: string; name: string; jobTitle: string | null } | null;
  members: { id: string; name: string; jobTitle: string | null }[];
};

export type EmployeeOption = { id: string; name: string; jobTitle: string | null; departmentId: string | null; userId: string | null; status: EmployeeStatus };

export type LeaveType = { id: string; name: string; daysPerYear: number | null; paid: boolean; requiresNote: boolean };

export type LeaveRequest = {
  id: string; startDate: string; endDate: string; days: number; reason: string | null; status: "pending" | "approved" | "declined" | "cancelled";
  decidedAt: string | null; decisionNote: string | null; createdAt: string;
  employee: { id: string; name: string; jobTitle: string | null; departmentName: string | null; userId: string | null } | null;
  leaveType: { id: string; name: string } | null;
  approvalId: string | null; approverName: string | null; canDecide: boolean; canCancel: boolean; remainingAfter: number | null;
  clash: { count: number; day: string | null };
};

export const STATUS: Record<EmployeeStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  onboarding: { label: "Onboarding", tone: "blue" },
  on_leave: { label: "On leave", tone: "warn" },
  leaving: { label: "Leaving", tone: "grey" },
  left: { label: "Left", tone: "grey" },
};

export function statusLabel(e: { status: EmployeeStatus; endDate: string | null }) {
  if (e.status === "leaving" && e.endDate) return `Leaving ${fmtDate(e.endDate, { day: "numeric", month: "short" })}`;
  return STATUS[e.status].label;
}

export const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Temporary", "Intern"];

export const peopleKeys = {
  all: ["people"] as const,
  stats: ["people", "stats"] as const,
  options: ["people", "options"] as const,
  departments: ["people", "departments"] as const,
  leaveTypes: ["people", "leave-types"] as const,
};

export function useStats() {
  return useQuery({ queryKey: peopleKeys.stats, queryFn: () => api.get<Stats>("/api/people/stats") });
}
export function useEmployeeOptions(enabled = true) {
  return useQuery({ queryKey: peopleKeys.options, queryFn: () => api.get<EmployeeOption[]>("/api/people/employees/options"), enabled });
}
export function useDepartments() {
  return useQuery({ queryKey: peopleKeys.departments, queryFn: () => api.get<Department[]>("/api/people/departments") });
}
export function useLeaveTypes() {
  return useQuery({ queryKey: peopleKeys.leaveTypes, queryFn: () => api.get<LeaveType[]>("/api/people/leave-types") });
}

export function monthYear(d: string | null) {
  return d ? fmtDate(d, { month: "short", year: "numeric" }) : "—";
}

/** "4 years", "7 months", "2 weeks" since a date. */
export function tenure(start: string | null): string | null {
  if (!start) return null;
  const s = new Date(`${start}T00:00:00`);
  const now = new Date();
  if (s > now) return "starts soon";
  const months = (now.getFullYear() - s.getFullYear()) * 12 + now.getMonth() - s.getMonth() - (now.getDate() < s.getDate() ? 1 : 0);
  if (months >= 12) { const y = Math.floor(months / 12); return `${y} year${y === 1 ? "" : "s"}`; }
  if (months >= 1) return `${months} month${months === 1 ? "" : "s"}`;
  const days = Math.floor((now.getTime() - s.getTime()) / 86_400_000);
  return days < 7 ? "new" : `${Math.floor(days / 7)} weeks`;
}

export function localYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDaysYmd(day: string, n: number) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localYmd(d);
}
export function mondayOfYmd(day: string) {
  const w = new Date(`${day}T12:00:00`).getDay();
  return addDaysYmd(day, w === 0 ? -6 : 1 - w);
}

export function fmtMinutes(m: number | null): string {
  if (m == null) return "—";
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fileKind(name: string) {
  const ext = name.split(".").pop()?.toUpperCase() ?? "";
  return ext.length <= 4 ? ext : "FILE";
}
