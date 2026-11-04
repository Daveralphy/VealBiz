import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button, EmptyState, PageHeader } from "@windveal/ui";
import { useSession } from "../../lib/session";
import { useStats } from "./data";
import { JobsPage } from "./JobsPage";
import { RecruitmentDashboard } from "./Dashboard";
import { JobFormPage } from "./JobForm";
import { PipelinePage } from "./Pipeline";
import { CandidatePage } from "./CandidatePage";
import { CandidatesTab } from "./CandidatesTab";
import { InterviewsTab } from "./InterviewsTab";
import { CareersTab } from "./CareersTab";
import "./recruitment.css";

export default function RecruitmentModule() {
  const { can } = useSession();
  const nav = useNavigate();
  const path = useLocation().pathname.replace(/\/+$/, "");
  const stats = useStats();
  const s = stats.data;

  if (!can("recruitment", "view")) {
    return (
      <>
        <PageHeader title="Recruitment" />
        <EmptyState title="You don't have access to Recruitment">Ask an admin if you need to see jobs and candidates.</EmptyState>
      </>
    );
  }

  return (
    <div className="rc">
      <PageHeader
        title="Recruitment"
        subtitle={s ? `${s.activeCandidates} active candidate${s.activeCandidates === 1 ? "" : "s"}` : " "}
        actions={can("recruitment", "edit") && (path === "/recruitment" || path === "/recruitment/jobs") && <Button className="rc-block-sm" icon={<Plus size={16} />} onClick={() => nav("/recruitment/jobs/new")}>New job</Button>}
      />
      <Routes>
        <Route index element={<RecruitmentDashboard />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/new" element={<JobFormPage />} />
        <Route path="jobs/:id/edit" element={<JobFormPage />} />
        <Route path="jobs/:id" element={<PipelinePage />} />
        <Route path="applications/:id" element={<CandidatePage />} />
        <Route path="candidates" element={<CandidatesTab />} />
        <Route path="interviews" element={<InterviewsTab />} />
        <Route path="careers" element={<CareersTab />} />
        <Route path="*" element={<EmptyState title="Page not found" action={<Button onClick={() => nav("/recruitment/jobs")}>Back to jobs</Button>} />} />
      </Routes>
    </div>
  );
}
