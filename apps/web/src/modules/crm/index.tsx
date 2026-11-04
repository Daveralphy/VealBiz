import { useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "@windveal/ui";
import { CompanyModal, DealModal, LeadModal, useCrmAccess } from "./parts";
import { CompaniesPage, CompanyPage } from "./companies";
import { FollowUpsPage, OverviewPage, PipelinePage } from "./pages";
import { LeadsPage } from "./leads";
import "./crm.css";
import { NewMenu } from "../../components/actions";

export default function CrmModule() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { canEdit } = useCrmAccess();
  const [newCompany, setNewCompany] = useState(false);

  const section = location.pathname.replace(/^\/crm\/?/, "").split("/")[0] ?? "";
  // The numbers live on the dashboard; the header just says what this workspace is for.
  const subtitle = "Leads, deals and clients";
  const newParam = params.get("new");
  const closeNew = () => { const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); };
  const openNewDeal = () => { const p = new URLSearchParams(params); p.set("new", "deal"); setParams(p); };

  return (
    <div className="crm">
      <PageHeader title="CRM" subtitle={subtitle}
        actions={canEdit && <NewMenu items={[
          { label: "Lead", onClick: () => { const p = new URLSearchParams(params); p.set("new", "lead"); setParams(p); } },
          { label: "Deal", onClick: openNewDeal },
          { label: "Company", onClick: () => setNewCompany(true) },
        ]} />} />
      <Routes>
        <Route index element={<OverviewPage />} />
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="companies" element={<CompaniesPage onNew={() => setNewCompany(true)} />} />
        <Route path="companies/:id" element={<CompanyPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="follow-ups" element={<FollowUpsPage />} />
        <Route path="*" element={<Navigate to="/crm" replace />} />
      </Routes>
      {canEdit && (
        <>
          <CompanyModal open={newCompany} onClose={() => setNewCompany(false)} onSaved={(id) => navigate(`/crm/companies/${id}`)} />
          <DealModal open={newParam === "deal"} onClose={closeNew}
            onSaved={(d) => { if (section !== "pipeline" && section !== "companies") navigate(`/crm/pipeline?deal=${d.id}`); }} />
          <LeadModal open={newParam === "lead"} onClose={closeNew} />
        </>
      )}
    </div>
  );
}
