import { Navigate, Route, Routes } from "react-router-dom";
import { HistoryPage, StartPage } from "./start";
import { SheetsPage } from "./sheets";
import { MappingPage } from "./mapping";
import { ImportDashboard } from "./dashboard";
import { ReviewPage } from "./review";
import { ConfirmPage, ResultPage } from "./finish";
import "./imports.css";

export default function ImportModule() {
  return (
    <Routes>
      <Route index element={<ImportDashboard />} />
      <Route path="new" element={<StartPage />} />
      <Route path="history" element={<HistoryPage />} />
      <Route path=":id" element={<Navigate to="sheets" replace />} />
      <Route path=":id/sheets" element={<SheetsPage />} />
      <Route path=":id/mapping" element={<MappingPage />} />
      <Route path=":id/review" element={<ReviewPage />} />
      <Route path=":id/confirm" element={<ConfirmPage />} />
      <Route path=":id/result" element={<ResultPage />} />
      <Route path="*" element={<Navigate to="/import" replace />} />
    </Routes>
  );
}
