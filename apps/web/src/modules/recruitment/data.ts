import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

export type QuestionType = "text" | "choice" | "yesno" | "number";
export type Question = { id: string; label: string; type: QuestionType; options?: string[]; required: boolean };

export type Job = {
  id: string; title: string; slug: string; departmentId: string | null; department?: string | null; location: string | null;
  employmentType: string | null; salaryMin: number | null; salaryMax: number | null; salaryPeriod: string | null; showSalary: boolean;
  description: string | null; status: "draft" | "open" | "closed"; published: boolean; applyBy: string | null;
  hiringManagerUserId: string | null; hiringTeamUserIds: string[]; stages: string[]; questions: Question[];
  openedAt: string | null; createdAt: string; publicUrl: string; isLive: boolean;
  reference?: string | null; extraDetails?: Record<string, string>;
  funnel?: { stage: string; count: number }[]; totalApplications?: number;
  hiringManagerName?: string | null; hiringTeam?: { userId: string; name: string }[];
};

export type Card = {
  id: string; candidateId: string; name: string; email: string; source: string; stage: string; averageScore: number | null;
  scoreCount: number; scoreHidden: boolean; daysInStage: number; stageChangedAt: string; appliedAt: string;
  rejectedAt: string | null; rejectionReason: string | null; hiredAt: string | null; employeeId: string | null; nextInterviewAt: string | null;
};

export type Pipeline = { job: Job; stages: { name: string; applications: Card[] }[]; rejected: Card[]; canSeeAllScores: boolean };

export type Stats = {
  openRoles: number; draftRoles: number; newApplicantsThisWeek: number; activeCandidates: number; interviewsThisWeek: number;
  interviewsToday: number; myUpcomingInterviews: number; averageDaysToHire: number | null; previousAverageDaysToHire: number | null;
};

export type Recommendation = "strong_no" | "no" | "yes" | "strong_yes";
export type Scorecard = {
  id: string; interviewId: string | null; interviewTitle: string | null; interviewerUserId: string; interviewerName: string;
  ratings: Record<string, number>; average: number | null; recommendation: Recommendation | null; notes: string | null;
  submittedAt: string | null; isMine: boolean;
};

export type InterviewRow = {
  id: string; title: string; scheduledAt: string; durationMinutes: number; mode: "office" | "phone" | "video"; location: string | null;
  status: "scheduled" | "completed" | "cancelled"; interviewers: { userId: string; name: string }[];
};

export type ApplicationDetail = {
  application: {
    id: string; stage: string; source: string; appliedAt: string; stageChangedAt: string; coverLetter: string | null; expectedSalary: number | null;
    rejectedAt: string | null; rejectionReason: string | null; hiredAt: string | null; employeeId: string | null;
    answers: { questionId: string; label: string; type: QuestionType; value: string }[];
    cvFileId: string | null; cv: { id: string; name: string; mime: string; size: number } | null;
  };
  candidate: { id: string; firstName: string; lastName: string; name: string; email: string; phone: string | null; location: string | null };
  job: {
    id: string; title: string; stages: string[]; departmentId: string | null; department: string | null; location: string | null;
    employmentType: string | null; hiringManagerUserId: string | null; hiringManagerName: string | null;
  };
  notes: { id: string; body: string; authorUserId: string; authorName: string; createdAt: string; updatedAt: string; isMine: boolean }[];
  interviews: InterviewRow[];
  scorecards: Scorecard[];
  feedback: { submittedCount: number; average: number | null; hiddenCount: number; canSeeAll: boolean };
  history: { from: string | null; to: string; at: string }[];
};

export type AppRow = {
  id: string; candidateId: string; name: string; email: string; phone: string | null; jobId: string; jobTitle: string; stage: string;
  source: string; appliedAt: string; daysInStage: number; rejectedAt: string | null; hiredAt: string | null; employeeId: string | null;
};

export type InterviewListItem = InterviewRow & {
  applicationId: string; candidateName: string; jobId: string; jobTitle: string; isInterviewer: boolean;
  myScorecard: { id: string; ratings: Record<string, number>; recommendation: Recommendation | null; notes: string | null; submittedAt: string | null } | null;
};

export type Member = { id: string; name: string; role: string };
export type Department = { id: string; name: string };

export const CRITERIA = ["Skills and knowledge", "Attention to detail", "Communication", "Fit with the team"] as const;
export const RATING_WORDS = ["", "Poor", "Fair", "Good", "Very good", "Excellent"];
export const RECOMMENDATIONS: { value: Recommendation; label: string }[] = [
  { value: "strong_no", label: "Strong no" }, { value: "no", label: "No" }, { value: "yes", label: "Yes" }, { value: "strong_yes", label: "Strong yes" },
];
export const recLabel = (r: Recommendation | null) => RECOMMENDATIONS.find((x) => x.value === r)?.label ?? "No recommendation";
export const recTone = (r: Recommendation | null) => (r === "strong_yes" || r === "yes" ? "ok" : r ? "red" : "grey") as "ok" | "red" | "grey";
export const MODE_LABEL = { office: "Office", phone: "Phone", video: "Video" } as const;
export const SOURCES = ["Added manually", "Referral", "Walk-in", "Job board", "Social media", "Agency", "Careers page"];
export const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Temporary", "Internship"];

export const keys = {
  all: ["recruitment"] as const,
  stats: ["recruitment", "stats"] as const,
  jobs: (params: string) => ["recruitment", "jobs", params] as const,
  job: (id: string) => ["recruitment", "job", id] as const,
  app: (id: string) => ["recruitment", "application", id] as const,
  apps: (params: string) => ["recruitment", "applications", params] as const,
  interviews: (params: string) => ["recruitment", "interviews", params] as const,
};

export const useStats = () => useQuery({ queryKey: keys.stats, queryFn: () => api.get<Stats>("/api/recruitment/stats") });
export const useDepartments = () =>
  useQuery({ queryKey: ["recruitment", "departments"], queryFn: () => api.get<Department[]>("/api/recruitment/departments"), staleTime: 60_000 });
export const useMembers = () =>
  useQuery({ queryKey: ["members", "assignable"], queryFn: () => api.get<Member[]>("/api/members/assignable"), staleTime: 60_000 });

/** Invalidate every recruitment query (lists, stats, pipelines). */
export function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.all });
}

export const SITE_URL: string = (import.meta.env.VITE_SITE_URL as string | undefined) ?? "http://localhost:5174";
export const careersUrl = (slug: string) => `${SITE_URL}/careers/${slug}`;

export function salaryText(money: (v: number) => string, min: number | null, max: number | null, period: string | null) {
  if (min === null && max === null) return null;
  const per = period ? ` a ${period}` : "";
  if (min !== null && max !== null) return `${money(min)} to ${money(max)}${per}`;
  return `${min !== null ? `From ${money(min)}` : `Up to ${money(max!)}`}${per}`;
}

export const ageLabel = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "now";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
