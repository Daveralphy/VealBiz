import { useState } from "react";
import { Navigate, Route, Routes, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderPlus, Upload } from "lucide-react";
import { EmptyState, PageHeader } from "@windveal/ui";
import { formatBytes } from "@windveal/shared";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Library, type LibraryView } from "./library";
import { FilePage } from "./file";
import { DocumentsDashboard } from "./dashboard";
import { UploadModal } from "./upload";
import { NewFolderModal, useFolders } from "./shared";
import "./documents.css";
import { NewMenu } from "../../components/actions";

function FolderRoute({ view, onUpload, archived }: { view: LibraryView; onUpload: () => void; archived: number }) {
  const m = useMatch("/documents/folder/:id");
  return <Library key={view} view={view} folderId={m?.params.id ?? null} onUpload={onUpload} archivedCount={archived} />;
}

export default function DocumentsModule() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [newFolder, setNewFolder] = useState(false);
  const { data: summary } = useQuery({ queryKey: ["dc-summary"], queryFn: () => api.get<{ files: number; archived: number }>("/api/documents/summary"), enabled: can("documents", "view") });
  const { data: storage } = useQuery({ queryKey: ["storage"], queryFn: () => api.get<{ used: number; limit: number }>("/api/storage"), staleTime: 60_000 });
  const { data: tree } = useFolders();
  const folderMatch = useMatch("/documents/folder/:id");
  const folderId = folderMatch?.params.id ?? null;
  // The dashboard already shows the file count and storage, so its header doesn't repeat them.
  const onDashboard = !!useMatch("/documents");

  if (!can("documents", "view")) {
    return <><PageHeader title="Documents" /><EmptyState title="You don't have access to Documents">Ask an admin if you need it.</EmptyState></>;
  }

  const canEdit = can("documents", "edit");
  const uploadOpen = params.get("upload") === "1";
  const setUpload = (open: boolean) => {
    const p = new URLSearchParams(params);
    if (open) p.set("upload", "1"); else p.delete("upload");
    setParams(p, { replace: true });
  };
  const subtitle = onDashboard ? "Every business file in one place" : summary
    ? `${summary.files.toLocaleString("en-GB")} file${summary.files === 1 ? "" : "s"}${storage ? ` · ${formatBytes(storage.used)} of ${formatBytes(storage.limit)} used` : ""}`
    : " ";

  return (
    <div className="dc">
      <PageHeader title="Documents" subtitle={subtitle}
        actions={canEdit ? <NewMenu items={[
          { label: "Upload file", icon: <Upload size={16} />, onClick: () => setUpload(true) },
          { label: "New folder", icon: <FolderPlus size={16} />, onClick: () => setNewFolder(true) },
        ]} /> : undefined} />
      <Routes>
        <Route index element={<DocumentsDashboard />} />
        <Route path="library" element={<FolderRoute view="all" onUpload={() => setUpload(true)} archived={summary?.archived ?? 0} />} />
        <Route path="folder/:id" element={<FolderRoute view="all" onUpload={() => setUpload(true)} archived={summary?.archived ?? 0} />} />
        <Route path="recent" element={<FolderRoute view="recent" onUpload={() => setUpload(true)} archived={summary?.archived ?? 0} />} />
        <Route path="shared" element={<FolderRoute view="shared" onUpload={() => setUpload(true)} archived={summary?.archived ?? 0} />} />
        <Route path="archive" element={<FolderRoute view="archive" onUpload={() => setUpload(true)} archived={summary?.archived ?? 0} />} />
        <Route path="file/:id" element={<FilePage />} />
        <Route path="files/:id" element={<FilePage />} />
        <Route path="*" element={<Navigate to="/documents" replace />} />
      </Routes>
      {canEdit && <UploadModal open={uploadOpen} onClose={() => setUpload(false)} folderId={folderId} folders={tree?.folders ?? []} />}
      {canEdit && <NewFolderModal open={newFolder} onClose={() => setNewFolder(false)} parentId={folderId} folders={tree?.folders ?? []} onCreated={(id) => navigate(`/documents/folder/${id}`)} />}
    </div>
  );
}
