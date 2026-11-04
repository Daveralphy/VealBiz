import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Download, Plus } from "lucide-react";
import { Button, EmptyState, PageHeader } from "@windveal/ui";
import { useSession } from "../../lib/session";
import { useStats } from "./lib";
import { Directory } from "./Directory";
import { ProfilePage } from "./Profile";
import { Departments } from "./Departments";
import { LeavePage } from "./Leave";
import { AttendancePage } from "./Attendance";
import { PeopleDashboard } from "./Dashboard";
import { OnboardingPage } from "./Onboarding";
import { EmployeeDrawer } from "./EmployeeForm";
import "./people.css";

export default function PeopleModule() {
  const { can, hasSpecial } = useSession();
  const stats = useStats();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const adding = params.get("new") === "employee";
  const { pathname } = useLocation();
  const section = pathname.split("/")[2] ?? "";

  if (!can("people", "view")) {
    return (
      <>
        <PageHeader title="People & HR" />
        <EmptyState title="You don't have access to People & HR">Ask an admin if you need it.</EmptyState>
      </>
    );
  }

  const s = stats.data;
  const subtitle = s ? `${s.headcount} ${s.headcount === 1 ? "person" : "people"} across ${s.departments} department${s.departments === 1 ? "" : "s"}` : " ";
  const openAdd = () => setParams((p) => { p.set("new", "employee"); return p; });
  const closeAdd = () => setParams((p) => { p.delete("new"); return p; }, { replace: true });

  return (
    <div className="people">
      <PageHeader
        title="People & HR"
        subtitle={subtitle}
        actions={<>
          {/* Exporting the employee list belongs with the Directory (Attendance has its own export). */}
          {hasSpecial("export_data") && section === "directory" && (
            <a className="btn btn-secondary hide-sm" href="/api/people/employees/export" download><Download size={16} />Export</a>
          )}
          {can("people", "edit") && <Button className="ppl-add" icon={<Plus size={16} strokeWidth={2.4} />} onClick={openAdd}>Add employee</Button>}
        </>}
      />
      <Routes>
        <Route index element={<PeopleDashboard />} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="directory" element={<Directory onAdd={openAdd} />} />
        <Route path="departments" element={<Departments />} />
        <Route path="leave" element={<LeavePage />} />
        <Route path="onboarding" element={<OnboardingPage />} />
        <Route path="employees/:id" element={<ProfilePage />} />
        <Route path=":id" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/people" replace />} />
      </Routes>
      {can("people", "edit") && (
        <EmployeeDrawer open={adding} onClose={closeAdd} onSaved={(id) => { closeAdd(); navigate(`/people/${id}`); }} />
      )}
    </div>
  );
}
