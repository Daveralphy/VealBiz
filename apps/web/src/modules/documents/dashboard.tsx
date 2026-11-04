import { useQuery } from "@tanstack/react-query";
import { Pill } from "@windveal/ui";
import { formatBytes } from "@windveal/shared";
import { api } from "../../lib/api";
import { fmtDate, timeAgo } from "../../lib/format";
import { DashBars, DashCard, DashColumns, DashKpis, DashRow } from "../../components/dashboard";
import { TypeBadge, useFolders, type FileRow } from "./shared";

type DashData = { addedThisWeek: number; expiringCount: number; expiring: FileRow[] };

function daysUntil(day: string) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${day}T00:00:00`).getTime() - start.getTime()) / 86_400_000);
}

function expiryText(day: string) {
  const n = daysUntil(day);
  return n <= 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`;
}

/** The Documents dashboard: a few numbers and the top five of each list, each linking to the full page. */
export function DocumentsDashboard() {
  const summary = useQuery({ queryKey: ["dc-summary"], queryFn: () => api.get<{ files: number; archived: number }>("/api/documents/summary") });
  const storage = useQuery({ queryKey: ["storage"], queryFn: () => api.get<{ used: number; limit: number }>("/api/storage"), staleTime: 60_000 });
  const dash = useQuery({ queryKey: ["dc-dashboard"], queryFn: () => api.get<DashData>("/api/documents/dashboard") });
  const recent = useQuery({ queryKey: ["dc-files", "recent", null, "", "", ""], queryFn: () => api.get<FileRow[]>("/api/documents/files?view=recent") });
  const shared = useQuery({ queryKey: ["dc-files", "shared", null, "", "", ""], queryFn: () => api.get<FileRow[]>("/api/documents/files?view=shared") });
  const tree = useFolders();

  const folders = (tree.data?.folders ?? []).filter((f) => !f.parentId && f.totalCount > 0)
    .sort((a, b) => b.totalCount - a.totalCount).slice(0, 5)
    .map((f) => ({ label: f.name, value: f.totalCount }));
  const fileLead = (f: FileRow) => <TypeBadge name={f.name} size={32} />;

  return (
    <>
      <DashKpis loading={summary.isLoading || dash.isLoading} items={[
        { label: "Files", value: (summary.data?.files ?? 0).toLocaleString("en-GB"), to: "/documents/library" },
        { label: "Added this week", value: dash.data?.addedThisWeek ?? 0, to: "/documents/recent" },
        { label: "Expiring in 30 days", value: dash.data?.expiringCount ?? 0 },
        { label: "Storage used", value: storage.data ? formatBytes(storage.data.used) : "—", note: storage.data ? `of ${formatBytes(storage.data.limit)}` : undefined },
      ]} />
      <DashColumns
        left={<>
          <DashCard title="Recent files" sub="Latest changes" link={{ to: "/documents/library", label: "All files" }}
            loading={recent.isLoading} empty={!recent.data?.length && "No files yet. Upload one to get started."}>
            {recent.data?.slice(0, 5).map((f) => (
              <DashRow key={f.id} to={`/documents/file/${f.id}`} lead={fileLead(f)} title={f.name}
                detail={`${f.folderName ?? "Top level"} · ${f.uploaderName}`} end={timeAgo(f.updatedAt)} />
            ))}
          </DashCard>
          <DashCard title="Expiring soon"
            loading={dash.isLoading} empty={!dash.data?.expiring.length && "Nothing expires in the next 30 days."}>
            {dash.data?.expiring.map((f) => (
              <DashRow key={f.id} to={`/documents/file/${f.id}`} lead={fileLead(f)} title={f.name}
                detail={fmtDate(`${f.expiresOn}T00:00:00`)}
                end={<Pill tone={daysUntil(f.expiresOn!) <= 7 ? "red" : "warn"}>{expiryText(f.expiresOn!)}</Pill>} />
            ))}
          </DashCard>
        </>}
        right={<>
          <DashCard title="Files by folder" loading={tree.isLoading} empty={!folders.length && "No files in folders yet."}>
            <DashBars rows={folders} />
          </DashCard>
          <DashCard title="Shared with me" sub="Added by others in the last 30 days" link={{ to: "/documents/shared", label: "Shared with me" }}
            loading={shared.isLoading} empty={!shared.data?.length && "Nothing new from others."}>
            {shared.data?.slice(0, 5).map((f) => (
              <DashRow key={f.id} to={`/documents/file/${f.id}`} lead={fileLead(f)} title={f.name} detail={f.uploaderName} end={timeAgo(f.createdAt)} />
            ))}
          </DashCard>
        </>}
      />
    </>
  );
}
