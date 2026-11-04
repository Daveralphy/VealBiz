import { useQuery } from "@tanstack/react-query";
import { Avatar } from "@windveal/ui";
import { api, qs } from "../../lib/api";
import { dayLabel, fmtTime, timeAgo } from "../../lib/format";
import { DashBars, DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { keys, useStats, type AppRow, type InterviewListItem, type Job } from "./data";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Candidates still in the running (everyone in the pipeline except those already hired). */
const active = (j: Job) => (j.funnel ?? []).filter((f) => f.stage !== "Hired").reduce((a, f) => a + f.count, 0);

/** The Recruitment dashboard: this week's numbers, and the top five of each list with a link to the full page. */
export function RecruitmentDashboard() {
  const stats = useStats();
  const ivQuery = qs({ range: "upcoming" });
  const interviews = useQuery({ queryKey: keys.interviews(ivQuery), queryFn: () => api.get<{ items: InterviewListItem[] }>(`/api/recruitment/interviews${ivQuery}`) });
  const appQuery = qs({ status: "active" });
  const apps = useQuery({ queryKey: keys.apps(appQuery), queryFn: () => api.get<AppRow[]>(`/api/recruitment/applications${appQuery}`) });
  const jobQuery = qs({ status: "open" });
  const jobs = useQuery({ queryKey: keys.jobs(jobQuery), queryFn: () => api.get<Job[]>(`/api/recruitment/jobs${jobQuery}`) });

  const s = stats.data;
  const now = Date.now();
  const coming = (interviews.data?.items ?? []).filter((i) => i.status === "scheduled" && Date.parse(i.scheduledAt) + i.durationMinutes * 60_000 > now).slice(0, 5);
  const stages = new Map<string, number>();
  for (const j of jobs.data ?? []) for (const f of j.funnel ?? []) if (f.stage !== "Hired") stages.set(f.stage, (stages.get(f.stage) ?? 0) + f.count);
  const roles = [...(jobs.data ?? [])].sort((a, b) => active(b) - active(a)).slice(0, 5);

  return (
    <>
      <DashKpis loading={stats.isLoading} items={[
        { label: "Open roles", value: s?.openRoles ?? 0, note: s?.draftRoles ? `${plural(s.draftRoles, "draft")} too` : undefined, to: "/recruitment/jobs" },
        { label: "New applicants", value: s?.newApplicantsThisWeek ?? 0, note: "this week", to: "/recruitment/candidates" },
        { label: "Interviews", value: s?.interviewsThisWeek ?? 0, note: "this week", to: "/recruitment/interviews" },
        { label: "Hired", value: s?.hiredThisMonth ?? 0, note: "this month" },
      ]} />
      <DashColumns
        left={<>
          <DashCard title="Coming up" link={{ to: "/recruitment/interviews", label: "Interviews" }}
            loading={interviews.isLoading} empty={!coming.length && "No interviews booked. Schedule one from a candidate's profile."}>
            {coming.map((i) => (
              <DashRow key={i.id} to={`/recruitment/applications/${i.applicationId}`} lead={<Avatar name={i.candidateName} size={32} />}
                title={i.candidateName} detail={`${i.jobTitle} · ${i.title.toLowerCase()}`} end={`${dayLabel(i.scheduledAt)} ${fmtTime(i.scheduledAt)}`} />
            ))}
          </DashCard>
          <DashCard title="Latest applicants" link={{ to: "/recruitment/candidates", label: "Candidates" }}
            loading={apps.isLoading} empty={!apps.data?.length && "No one has applied yet."}>
            {apps.data?.slice(0, 5).map((a) => (
              <DashRow key={a.id} to={`/recruitment/applications/${a.id}`} lead={<Avatar name={a.name} size={32} />}
                title={a.name} detail={a.jobTitle} end={timeAgo(a.appliedAt)} />
            ))}
          </DashCard>
        </>}
        right={<>
          <DashCard title="Candidates by stage" sub="Across open roles" loading={jobs.isLoading} empty={!stages.size && "No open roles yet."}>
            <DashBars rows={[...stages].map(([label, value]) => ({ label, value }))} />
          </DashCard>
          <DashCard title="Busiest roles" link={{ to: "/recruitment/jobs", label: "Jobs" }}
            loading={jobs.isLoading} empty={!roles.length && "No open roles. Create a job to start hiring."}>
            {roles.map((j) => (
              <DashRow key={j.id} to={`/recruitment/jobs/${j.id}`} title={j.title}
                detail={[j.department, j.location].filter(Boolean).join(" · ") || undefined} end={plural(active(j), "candidate")} />
            ))}
          </DashCard>
        </>}
      />
    </>
  );
}
