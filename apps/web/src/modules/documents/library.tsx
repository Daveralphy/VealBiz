import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, ChevronRight, Download, Folder, FolderOpen, FolderPlus, LayoutGrid, Link2, List, Lock, MoreHorizontal, MoveRight, Pencil,
  Shield, Tag, Trash2, Upload,
} from "lucide-react";
import { Button, ConfirmDialog, EmptyState, Loading, Menu, Notice, SearchInput, Select, useToast } from "@windveal/ui";
import { formatBytes } from "@windveal/shared";
import { ApiError, api, fileUrl, qs } from "../../lib/api";
import { useSession } from "../../lib/session";
import { fmtDate, timeAgo } from "../../lib/format";
import {
  DetailsModal, FolderAccessModal, MoveModal, NewFolderModal, RenameModal, TypeBadge, folderPath, useDocsRefresh, useFolders,
  type FileRow, type FolderNode,
} from "./shared";

export type LibraryView = "all" | "recent" | "shared" | "archive";

function useDebounced(v: string, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function FolderTreeNav({ folders, rootTotal, current, archived, view }: { folders: FolderNode[]; rootTotal: number; current: string | null; archived: number; view: LibraryView }) {
  const open = new Set(folderPath(folders, current).map((f) => f.id));
  const render = (parent: string | null, depth: number) =>
    folders.filter((f) => f.parentId === parent).sort((a, b) => a.name.localeCompare(b.name)).map((f) => {
      const hasKids = folders.some((c) => c.parentId === f.id);
      return (
        <div key={f.id}>
          <Link to={`/documents/folder/${f.id}`} className={`dc-tree-item ${current === f.id && view === "all" ? "on" : ""}`} style={{ paddingLeft: 10 + depth * 16 }}>
            {f.restricted ? <Lock size={15} /> : current === f.id ? <FolderOpen size={15} /> : <Folder size={15} />}
            <span>{f.name}</span><small>{f.totalCount}</small>
          </Link>
          {hasKids && open.has(f.id) && render(f.id, depth + 1)}
        </div>
      );
    });
  return (
    <nav className="dc-tree" aria-label="Folders">
      <Link to="/documents/library" className={`dc-tree-item ${!current && view === "all" ? "on" : ""}`}><Folder size={15} /><span>All files</span><small>{rootTotal}</small></Link>
      {render(null, 0)}
      <hr />
      <Link to="/documents/archive" className={`dc-tree-item ${view === "archive" ? "on" : ""}`}><Archive size={15} /><span>Archive</span><small>{archived}</small></Link>
    </nav>
  );
}

export function Library({ view, folderId, onUpload, archivedCount }: { view: LibraryView; folderId: string | null; onUpload: () => void; archivedCount: number }) {
  const { can, isAdmin } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useDocsRefresh();
  const canEdit = can("documents", "edit");
  const canManage = can("documents", "manage");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [linked, setLinked] = useState("");
  const [layout, setLayout] = useState<"list" | "grid">(() => { try { return localStorage.getItem("wv-dc-layout") === "grid" ? "grid" : "list"; } catch { return "list"; } });
  const search = useDebounced(q.trim());
  const { data: tree, isLoading: treeLoading, error: treeError } = useFolders();
  const filtered = !!(search || type || linked);
  const { data: files, isLoading, error } = useQuery({
    queryKey: ["dc-files", view, folderId, search, type, linked],
    queryFn: () => api.get<FileRow[]>(`/api/documents/files${qs({ view, folderId: view === "all" ? folderId : undefined, q: search, type, linked })}`),
    placeholderData: (p) => p,
  });

  const [rename, setRename] = useState<FileRow | null>(null);
  const [move, setMove] = useState<FileRow | null>(null);
  const [details, setDetails] = useState<FileRow | null>(null);
  const [del, setDel] = useState<FileRow | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderRename, setFolderRename] = useState(false);
  const [folderAccess, setFolderAccess] = useState(false);
  const [folderDelete, setFolderDelete] = useState(false);

  const folders = tree?.folders ?? [];
  const current = folderId ? folders.find((f) => f.id === folderId) ?? null : null;
  const path = folderPath(folders, folderId);
  const subFolders = view === "all" && !filtered ? folders.filter((f) => f.parentId === (folderId ?? null)).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const rootTotal = (tree?.rootFiles ?? 0) + folders.filter((f) => !f.parentId).reduce((s, f) => s + f.totalCount, 0);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); refresh(); toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : "Something went wrong. Please try again.", "error"); }
  };

  if (treeLoading) return <Loading />;
  if (treeError) return <Notice tone="error">{treeError instanceof ApiError ? treeError.message : "Couldn't load your folders."}</Notice>;
  if (folderId && !current) {
    return <EmptyState title="Folder not found" action={<Button variant="secondary" onClick={() => navigate("/documents/library")}>Back to all files</Button>}>It may have been deleted, or you don't have access to it.</EmptyState>;
  }

  const fileMenu = (f: FileRow) => (
    <Menu trigger={(t) => <button className="icon-btn" aria-label={`Actions for ${f.name}`} onClick={(e) => { e.stopPropagation(); t(); }}><MoreHorizontal size={18} /></button>}>
      {(close) => (
        <div onClick={(e) => e.stopPropagation()}>
          <a href={fileUrl(f.id, true)} onClick={close}><Download size={16} />Download</a>
          {canEdit && <>
            <button onClick={() => { close(); setRename(f); }}><Pencil size={16} />Rename</button>
            <button onClick={() => { close(); setMove(f); }}><MoveRight size={16} />Move</button>
            <button onClick={() => { close(); setDetails(f); }}><Tag size={16} />Edit details</button>
            {f.archivedAt
              ? <button onClick={() => { close(); act(() => api.post(`/api/documents/files/${f.id}/unarchive`), "Restored from the archive"); }}><ArchiveRestore size={16} />Unarchive</button>
              : <button onClick={() => { close(); act(() => api.post(`/api/documents/files/${f.id}/archive`), "File archived"); }}><Archive size={16} />Archive</button>}
          </>}
          {canManage && <><hr /><button className="danger" onClick={() => { close(); setDel(f); }}><Trash2 size={16} />Delete</button></>}
        </div>
      )}
    </Menu>
  );

  const empty = () => {
    if (filtered) return <EmptyState title="No files match">Try another search, or clear the filters.</EmptyState>;
    if (view === "archive") return <EmptyState title="Nothing archived" icon={<Archive size={24} />}>Archived files are kept here, out of the way, until you need them again.</EmptyState>;
    if (view === "recent") return <EmptyState title="No files yet">Files you and your team upload show up here.</EmptyState>;
    if (view === "shared") return <EmptyState title="Nothing new from your team">Files others uploaded in the last 30 days appear here.</EmptyState>;
    if (subFolders.length) return null;
    return (
      <EmptyState title={current ? "This folder is empty" : "No files here yet"} icon={<FolderOpen size={24} />}
        action={canEdit ? <Button icon={<Upload size={16} />} onClick={onUpload}>Upload</Button> : undefined}>
        {canEdit ? "Upload contracts, invoices and policies to keep them in one safe place." : "Files your team adds will appear here."}
      </EmptyState>
    );
  };

  return (
    <div className="dc-lib">
      <aside className="dc-side hide-sm"><FolderTreeNav folders={folders} rootTotal={rootTotal} current={folderId} archived={archivedCount} view={view} /></aside>
      <div className="dc-main">
        <div className="toolbar dc-toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search files by name, tag or category" />
          <Select className="chip-select" aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Type: All</option>
            <option value="pdf">PDF</option><option value="doc">Documents</option><option value="xls">Spreadsheets</option><option value="img">Images</option><option value="other">Other</option>
          </Select>
          <Select className="chip-select" aria-label="Linked to" value={linked} onChange={(e) => setLinked(e.target.value)}>
            <option value="">Linked to: Any</option>
            <option value="any">Linked to something</option><option value="none">Not linked</option>
            <option value="company">Companies</option><option value="deal">Deals</option><option value="employee">Employees</option><option value="task">Tasks</option>
            <option value="application">Applications</option>
          </Select>
          <div className="dc-layout hide-sm" role="radiogroup" aria-label="Layout">
            {(["list", "grid"] as const).map((l) => (
              <button key={l} role="radio" aria-checked={layout === l} aria-label={l === "list" ? "List" : "Grid"} className={layout === l ? "on" : ""}
                onClick={() => { setLayout(l); try { localStorage.setItem("wv-dc-layout", l); } catch { /* ignore */ } }}>
                {l === "list" ? <List size={17} /> : <LayoutGrid size={17} />}
              </button>
            ))}
          </div>
        </div>

        {view === "all" && (
          <div className="between dc-crumbs-row">
            <nav className="dc-crumbs" aria-label="Breadcrumb">
              <Link to="/documents/library">All files</Link>
              {path.map((p, i) => (
                <span key={p.id} className="row" style={{ gap: 6 }}>
                  <ChevronRight size={14} />
                  {i === path.length - 1 ? <b>{p.name}</b> : <Link to={`/documents/folder/${p.id}`}>{p.name}</Link>}
                </span>
              ))}
              {filtered && <span className="muted">· search results{current ? " in this folder" : ""}</span>}
            </nav>
            {current && (canEdit || isAdmin) && (
              <Menu trigger={(t) => <button className="icon-btn" aria-label="Folder actions" onClick={t}><MoreHorizontal size={18} /></button>}>
                {(close) => <>
                  {canEdit && <button onClick={() => { close(); setNewFolder(true); }}><FolderPlus size={16} />New folder inside</button>}
                  {canEdit && !current.system && <button onClick={() => { close(); setFolderRename(true); }}><Pencil size={16} />Rename folder</button>}
                  {isAdmin && <button onClick={() => { close(); setFolderAccess(true); }}><Shield size={16} />Who can see this</button>}
                  {canManage && !current.system && <><hr /><button className="danger" onClick={() => { close(); setFolderDelete(true); }}><Trash2 size={16} />Delete folder</button></>}
                </>}
              </Menu>
            )}
          </div>
        )}

        {!!subFolders.length && (
          <div className="dc-folders">
            {subFolders.map((f) => (
              <Link key={f.id} to={`/documents/folder/${f.id}`} className="dc-folder-card">
                <span className="dc-folder-ic">{f.restricted ? <Lock size={18} /> : <Folder size={18} />}</span>
                <span><b>{f.name}</b><small>{f.totalCount} file{f.totalCount === 1 ? "" : "s"}</small></span>
              </Link>
            ))}
          </div>
        )}

        {isLoading && !files ? <Loading /> : error && !files ? (
          <Notice tone="error">{error instanceof ApiError ? error.message : "Couldn't load files."}</Notice>
        ) : !files?.length ? empty() : layout === "grid" ? (
          <div className="dc-grid">
            {files.map((f) => (
              <div key={f.id} className="dc-grid-card" role="button" tabIndex={0} onClick={() => navigate(`/documents/file/${f.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/documents/file/${f.id}`)}>
                <div className="between"><TypeBadge name={f.name} size={38} />{fileMenu(f)}</div>
                <b title={f.name}>{f.name}</b>
                <small>{formatBytes(f.size)} · {timeAgo(f.updatedAt)}</small>
              </div>
            ))}
          </div>
        ) : (
          <div className="dc-table-wrap">
            <table className="table dc-table">
              <thead>
                <tr>
                  <th style={{ width: 52 }} aria-label="Type" />
                  <th>Name</th>
                  <th className="hide-sm">Linked to</th>
                  <th className="hide-sm">Access</th>
                  <th className="hide-sm">Size</th>
                  <th className="hide-sm">{view === "archive" ? "Archived" : "Updated"}</th>
                  <th style={{ width: 52 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => navigate(`/documents/file/${f.id}`)}>
                    <td><TypeBadge name={f.name} /></td>
                    <td className="dc-name">
                      <Link to={`/documents/file/${f.id}`} onClick={(e) => e.stopPropagation()}><b>{f.name}</b></Link>
                      <small>{f.uploaderName}{f.currentVersion > 1 ? ` · v${f.currentVersion}` : ""}{(filtered || view !== "all") && f.folderName ? ` · ${f.folderName}` : ""}</small>
                    </td>
                    <td className="hide-sm">{f.linkedTo ? <span className="dc-linked"><Link2 size={13} />{f.linkedTo.label}{f.linkCount > 1 ? ` +${f.linkCount - 1}` : ""}</span> : <span className="muted">—</span>}</td>
                    <td className="hide-sm">{f.access.restricted ? <span className="row" style={{ gap: 5 }}><Lock size={13} />{f.access.label}</span> : f.access.label}</td>
                    <td className="hide-sm">{formatBytes(f.size)}</td>
                    <td className="hide-sm">{view === "archive" && f.archivedAt ? fmtDate(f.archivedAt, { day: "numeric", month: "short" }) : timeAgo(f.updatedAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>{fileMenu(f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RenameModal open={!!rename} onClose={() => setRename(null)} title="Rename file" current={rename?.name ?? ""}
        onSave={async (name) => { await api.patch(`/api/documents/files/${rename!.id}`, { name }); refresh(); toast("File renamed"); }} />
      <MoveModal open={!!move} onClose={() => setMove(null)} file={move} folders={folders} />
      <DetailsModal open={!!details} onClose={() => setDetails(null)} file={details} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} danger confirmLabel="Delete file" title={`Delete ${del?.name ?? "this file"}?`}
        onConfirm={() => { const f = del!; setDel(null); act(() => api.del(`/api/documents/files/${f.id}`), "File deleted"); }}>
        It will be removed everywhere it's linked. If you might need it later, archive it instead.
      </ConfirmDialog>
      <NewFolderModal open={newFolder} onClose={() => setNewFolder(false)} parentId={folderId} folders={folders} onCreated={(id) => navigate(`/documents/folder/${id}`)} />
      <RenameModal open={folderRename} onClose={() => setFolderRename(false)} title="Rename folder" current={current?.name ?? ""}
        onSave={async (name) => { await api.patch(`/api/documents/folders/${folderId}`, { name }); refresh(); toast("Folder renamed"); }} />
      <FolderAccessModal open={folderAccess} onClose={() => setFolderAccess(false)} folder={current} />
      <ConfirmDialog open={folderDelete} onClose={() => setFolderDelete(false)} danger confirmLabel="Delete folder" title={`Delete ${current?.name ?? "this folder"}?`}
        onConfirm={async () => {
          setFolderDelete(false);
          try {
            await api.del(`/api/documents/folders/${folderId}`);
            refresh(); toast("Folder deleted");
            navigate(current?.parentId ? `/documents/folder/${current.parentId}` : "/documents/library");
          } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't delete the folder.", "error"); }
        }}>
        Only empty folders can be deleted.
      </ConfirmDialog>
    </div>
  );
}
