import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "../../lib/api";

export type ActivityType = "note" | "call" | "meeting" | "email";

export type Summary = {
  companies: number; openDeals: number; openValue: number; activeLeads: number; myFollowUps: number;
  leadStages: string[]; dealStages: string[];
};

export type FollowUp = {
  id: string; title: string; description: string | null; status: string; dueAt: string | null; completedAt: string | null;
  assigneeUserId: string | null; assigneeName: string | null; linkType: string | null; linkId: string | null; linkLabel: string | null;
  companyId: string | null; companyName: string | null; dealId: string | null; dealName: string | null; dealValue: number | null; leadId: string | null;
};

export type Deal = {
  id: string; name: string; value: number; currency: string; stage: string; status: "open" | "won" | "lost";
  companyId: string; companyName: string | null; contactId: string | null; contactName: string | null;
  ownerUserId: string | null; ownerName: string | null; expectedCloseOn: string | null; nextStep: string | null;
  nextTask: { id: string; title: string; dueAt: string | null } | null;
  wonAt: string | null; lostAt: string | null; lostReason: string | null; createdAt: string; updatedAt: string;
};

export type Qualification = { need?: boolean; budget?: boolean; decisionMaker?: boolean; timeline?: boolean; notes?: Record<string, string> };

export type Lead = {
  id: string; companyName: string; contactName: string | null; contactRole: string | null; email: string | null; phone: string | null;
  source: string | null; stage: string; ownerUserId: string | null; ownerName: string | null; estimatedValue: number | null;
  qualification: Qualification; qualificationScore: number; nextStep: string | null; nextStepDue: string | null;
  closedOutcome: "converted" | "not_interested" | null; closedReason: string | null; closedAt: string | null;
  convertedCompanyId: string | null; convertedDealId: string | null; createdAt: string; updatedAt: string;
  lastActivity: { type: ActivityType; occurredAt: string } | null;
  reference: string | null; extraDetails: Record<string, string>;
};

export type Company = {
  id: string; name: string; industry: string | null; location: string | null; website: string | null;
  status: "prospect" | "client" | "former"; notes: string | null; ownerUserId: string | null; ownerName: string | null;
  createdAt: string; updatedAt: string; reference: string | null; extraDetails: Record<string, string>;
};
export type CompanyRow = Company & { openValue: number; openDeals: number; contactCount: number; primaryContact: string | null; lastActivityAt: string | null };

export type Contact = { id: string; companyId: string | null; name: string; role: string | null; email: string | null; phone: string | null; isPrimary: boolean; createdAt: string };

export type Activity = {
  id: string; type: ActivityType; subject: string | null; body: string | null; occurredAt: string; durationMinutes: number | null;
  companyId: string | null; dealId: string | null; leadId: string | null; contactId: string | null; contactName: string | null;
  authorUserId: string; authorName: string; createdAt: string;
};

export type CrmFile = { id: string; name: string; mime: string; size: number; createdAt: string; linkedAt: string };

export type Overview = {
  stats: { openValue: number; openCount: number; wonThisMonth: number; wonThisMonthCount: number; winRate: number | null; followUpsDue: number; followUpsOverdue: number };
  pipeline: { stage: string; count: number; value: number }[];
  followUps: FollowUp[];
  recentWins: Deal[];
  leadsToContact: Lead[];
};

export type LeadsBoard = {
  stages: string[]; items: Lead[]; sources: string[];
  stats: { active: number; notContacted: number; ready: number; readyValue: number; contactedThisWeek: number; contactedBy: number; conversionRate: number | null };
};

export type CompanyDetail = {
  company: Company; contacts: Contact[]; deals: Deal[]; activities: Activity[]; files: CrmFile[]; followUps: FollowUp[]; nextFollowUp: FollowUp | null;
};

export type FollowUpGroups = { overdue: FollowUp[]; today: FollowUp[]; week: FollowUp[]; later: FollowUp[]; total: number };

export type Member = { id: string; name: string; role: string };

const tz = () => new Date().getTimezoneOffset();

export const keys = {
  all: ["crm"] as const,
  summary: ["crm", "summary"] as const,
  overview: ["crm", "overview"] as const,
  deals: (f: object) => ["crm", "deals", f] as const,
  deal: (id: string) => ["crm", "deal", id] as const,
  leads: (f: object) => ["crm", "leads", f] as const,
  lead: (id: string) => ["crm", "lead", id] as const,
  companies: (f: object) => ["crm", "companies", f] as const,
  company: (id: string) => ["crm", "company", id] as const,
  followUps: (assignee: string) => ["crm", "follow-ups", assignee] as const,
};

export const useSummary = () => useQuery({ queryKey: keys.summary, queryFn: () => api.get<Summary>("/api/crm/summary") });
export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<Overview>(`/api/crm/overview${qs({ tz: tz() })}`) });
export const useDeals = (f: { q?: string; owner?: string }) =>
  useQuery({ queryKey: keys.deals(f), queryFn: () => api.get<{ stages: string[]; items: Deal[] }>(`/api/crm/deals${qs(f)}`) });
export const useDeal = (id: string | null) => useQuery({
  queryKey: keys.deal(id ?? ""), enabled: !!id,
  queryFn: () => api.get<{ deal: Deal; contacts: Contact[]; activities: Activity[]; followUps: FollowUp[] }>(`/api/crm/deals/${id}`),
});
export const useLeads = (f: { q?: string; owner?: string; source?: string }) =>
  useQuery({ queryKey: keys.leads(f), queryFn: () => api.get<LeadsBoard>(`/api/crm/leads${qs(f)}`) });
export const useLead = (id: string | null) => useQuery({
  queryKey: keys.lead(id ?? ""), enabled: !!id,
  queryFn: () => api.get<{ lead: Lead; activities: Activity[]; followUps: FollowUp[] }>(`/api/crm/leads/${id}`),
});
export const useCompanies = (f: { q?: string; status?: string; owner?: string }) =>
  useQuery({ queryKey: keys.companies(f), queryFn: () => api.get<CompanyRow[]>(`/api/crm/companies${qs(f)}`) });
export const useCompany = (id: string) => useQuery({ queryKey: keys.company(id), queryFn: () => api.get<CompanyDetail>(`/api/crm/companies/${id}`) });
export const useFollowUps = (assignee: "me" | "all") =>
  useQuery({ queryKey: keys.followUps(assignee), queryFn: () => api.get<FollowUpGroups>(`/api/crm/follow-ups${qs({ assignee, tz: tz() })}`) });
export const useMembers = () =>
  useQuery({ queryKey: ["members", "assignable"], queryFn: () => api.get<Member[]>("/api/members/assignable"), staleTime: 60_000 });

/** Refresh every CRM query after a change (lists, boards, counts all depend on each other). */
export function useRefreshCrm() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.all });
}

/** Follow-ups don't carry a type, so infer an icon from the wording. */
export function followUpKind(title: string): ActivityType {
  const t = title.toLowerCase();
  if (/\b(call|phone|ring)\b/.test(t)) return "call";
  if (/\b(email|e-mail|send|sent|reply)\b/.test(t)) return "email";
  if (/\b(meet|meeting|visit|tasting|demo|lunch|walkthrough)\b/.test(t)) return "meeting";
  return "note";
}
