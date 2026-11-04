import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronLeft, Download, FileQuestion, Link2, MoreHorizontal, MoveRight, Pencil, Plus, Share2, Tag, Trash2, Upload, X } from "lucide-react";
import { Avatar, Button, Card, ConfirmDialog, EmptyState, Loading, Menu, Modal, Pill, useConfirm, useToast } from "@windveal/ui";
import { formatBytes } from "@windveal/shared";
import { ApiError, api, fileUrl } from "../../lib/api";
import { fmtDate, timeAgo } from "../../lib/format";
import { LINK_ICON, LinkPicker, type LinkTarget } from "./LinkPicker";
import { DetailsModal, FolderAccessModal, MoveModal, RenameModal, TypeBadge, fileKind, useDocsRefresh, useFolders, type FileRow } from "./shared";

type Detail = {
  file: FileRow;
  folderPath: { id: string; name: string }[];
  links: { id: string; linkType: string; linkId: string; label: string; sub: string; exists: boolean }[];
  versions: { id: string; version: number; size: number; note: string | null; uploader: string; createdAt: string; current: boolean }[];
  access: { source: string; folderId: string | null; restricted: boolean; rows: { who: string; level: string }[] };
  canEdit: boolean; canManage: boolean; canChangeAccess: boolean;
};

const LINK_ROUTE: Record<string, (id: string) => string> = {
  task: (id) => `/workflows/mine?task=${id}`,
};

export function FilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useDocsRefresh();
  const { data: tree } = useFolders();
  const { data, isLoading, error } = useQuery({ queryKey: ["dc-file", id], queryFn: () => api.get<Detail>(`/api/documents/files/${id}`), enabled: !!id });
  const versionInput = useRef<HTMLInputElement>(null);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState<LinkTarget | null>(null);
  const [linking, setLinking] = useState(false);
  const [restore, setRestore] = useState<Detail["versions"][number] | null>(null);
  const [rename, setRename] = useState(false);
  const [move, setMove] = useState(false);
  const [details, setDetails] = useState(false);
  const [del, setDel] = useState(false);
  const [access, setAccess] = useState(false);
  const { confirm, dialog } = useConfirm();

  if (isLoading) return <Loading />;
  if (error || !data) {
    return (
      <EmptyState title={error instanceof ApiError && error.status === 404 ? "File not found" : "Couldn't open this file"} icon={<FileQuestion size={24} />}
        action={<Button variant="secondary" onClick={() => navigate("/documents/library")}>Back to all files</Button>}>
        {error instanceof ApiError && error.status === 404 ? "It may have been deleted, or it's in a folder you can't see." : "Please try again."}
      </EmptyState>
    );
  }
  const f = data.file;
  const kind = fileKind(f.name);
  const parent = data.folderPath[data.folderPath.length - 1];
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); refresh(); toast(ok); } catch (e) { toast(e instanceof ApiError ? e.message : "Something went wrong. Please try again.", "error"); }
  };

  async function newVersion(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setUploadingVersion(true);
    try {
      await api.upload("/api/files", file, { replaceFileId: f.id, kind: f.kind });
      refresh();
      toast(`Version ${f.currentVersion + 1} uploaded`);
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't upload the new version.", "error"); }
    finally { setUploadingVersion(false); if (versionInput.current) versionInput.current.value = ""; }
  }

  async function share() {
    const url = `${window.location.origin}/documents/file/${f.id}`;
    try { await navigator.clipboard.writeText(url); toast("Link copied. Only people who can see this folder can open it."); }
    catch { toast(url); }
  }

  async function addLink() {
    if (!link) return;
    setLinking(true);
    try {
      await api.post(`/api/documents/files/${f.id}/links`, { linkType: link.type, linkId: link.id });
      refresh();
      toast(`Linked to ${link.label}`);
      setLinkOpen(false); setLink(null);
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't add the link.", "error"); }
    finally { setLinking(false); }
  }

  const folder = tree?.folders.find((x) => x.id === data.access.folderId) ?? null;

  return (
    <div className="dc-file">
      <button className="back-link dc-back" onClick={() => navigate(parent ? `/documents/folder/${parent.id}` : "/documents/library")}>
        <ChevronLeft size={16} />{parent?.name ?? "All files"}
      </button>
      <div className="dc-file-head">
        <div className="dc-file-title">
          <TypeBadge name={f.name} size={36} />
          <div style={{ minWidth: 0 }}>
            <h1>{f.name}</h1>
            <p className="muted">
              {formatBytes(f.size)} · in {data.folderPath.length ? data.folderPath.map((p) => p.name).join(" / ") : "All files"}
              {f.archivedAt && <> · <Pill tone="grey">Archived</Pill></>}
            </p>
          </div>
        </div>
        <div className="dc-file-actions">
          <Button variant="secondary" icon={<Share2 size={16} />} onClick={share}>Share</Button>
          {data.canEdit && (
            <>
              <input ref={versionInput} type="file" hidden onChange={(e) => newVersion(e.target.files)} />
              <Button variant="secondary" icon={<Upload size={16} />} loading={uploadingVersion} onClick={() => versionInput.current?.click()}>New version</Button>
            </>
          )}
          <a className="btn btn-primary" href={fileUrl(f.id, true)}><Download size={16} />Download</a>
          {data.canEdit && (
            <Menu trigger={(t) => <button className="icon-btn bordered" aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></button>}>
              {(close) => <>
                <button onClick={() => { close(); setRename(true); }}><Pencil size={16} />Rename</button>
                <button onClick={() => { close(); setMove(true); }}><MoveRight size={16} />Move</button>
                <button onClick={() => { close(); setDetails(true); }}><Tag size={16} />Edit details</button>
                {f.archivedAt
                  ? <button onClick={() => { close(); run(() => api.post(`/api/documents/files/${f.id}/unarchive`), "Restored from the archive"); }}><ArchiveRestore size={16} />Unarchive</button>
                  : <button onClick={() => { close(); run(() => api.post(`/api/documents/files/${f.id}/archive`), "File archived"); }}><Archive size={16} />Archive</button>}
                {data.canManage && <><hr /><button className="danger" onClick={() => { close(); setDel(true); }}><Trash2 size={16} />Delete</button></>}
              </>}
            </Menu>
          )}
        </div>
      </div>

      <div className="dc-file-grid">
        <div>
          <div className="dc-preview">
            {kind === "img" ? <img src={`${fileUrl(f.id)}?v=${f.currentVersion}`} alt={f.name} />
              : kind === "pdf" ? <iframe title={f.name} src={`${fileUrl(f.id)}?v=${f.currentVersion}#view=FitH`} />
              : (
                <div className="dc-noprev">
                  <TypeBadge name={f.name} size={56} />
                  <b>No preview for this type of file</b>
                  <p className="muted">Download it to open it on your device.</p>
                  <a className="btn btn-secondary" href={fileUrl(f.id, true)}><Download size={16} />Download {formatBytes(f.size)}</a>
                </div>
              )}
          </div>
        </div>

        <div className="dc-file-side">
          <Card title="Details" actions={data.canEdit ? <button className="link" onClick={() => setDetails(true)}>Edit</button> : undefined}>
            <dl className="kv">
              <div><dt>Uploaded by</dt><dd>{f.uploaderName}</dd></div>
              <div><dt>Added</dt><dd>{fmtDate(f.createdAt)}</dd></div>
              <div><dt>Category</dt><dd>{f.category ?? <span className="muted">—</span>}</dd></div>
              <div><dt>Expires</dt><dd className={f.expiresOn && f.expiresOn < new Date().toISOString().slice(0, 10) ? "dc-expired" : f.expiresOn ? "dc-expires" : undefined}>{f.expiresOn ? fmtDate(f.expiresOn) : <span className="muted">—</span>}</dd></div>
              <div><dt>Tags</dt><dd>{f.tags.length ? f.tags.join(", ") : <span className="muted">—</span>}</dd></div>
            </dl>
          </Card>

          <Card title="Linked to" subtitle="Stored once, shown wherever it's linked."
            actions={data.canEdit ? <button className="link row" style={{ gap: 4 }} onClick={() => setLinkOpen(true)}><Plus size={15} />Link</button> : undefined}>
            {!data.links.length ? <p className="muted">Not linked to any record yet.</p> : (
              <div className="dc-links">
                {data.links.map((l) => {
                  const route = LINK_ROUTE[l.linkType]?.(l.linkId);
                  const body = (
                    <>
                      <span className="lp-ic">{LINK_ICON[l.linkType] ?? <Link2 size={15} />}</span>
                      <span className="lp-text"><b>{l.label}</b><small>{l.exists ? l.sub : "This record was removed"}</small></span>
                    </>
                  );
                  return (
                    <div key={l.id} className="dc-link">
                      {route ? <a href={route} onClick={(e) => { e.preventDefault(); navigate(route); }}>{body}</a> : <span className="dc-link-body">{body}</span>}
                      {data.canEdit && <button className="icon-btn" aria-label={`Remove link to ${l.label}`} onClick={async () => {
                        if (!(await confirm({ title: "Remove this link?", message: `The file will no longer show on ${l.label}. The file itself is kept.`, confirmLabel: "Remove" }))) return;
                        run(() => api.del(`/api/documents/files/${f.id}/links/${l.id}`), "Link removed");
                      }}><X size={15} /></button>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Who can see this" subtitle={data.access.source}
            actions={data.canChangeAccess && folder ? <button className="link" onClick={() => setAccess(true)}>Change</button> : undefined}>
            <dl className="kv">
              {data.access.rows.map((r) => <div key={r.who}><dt>{r.who}</dt><dd>{r.level}</dd></div>)}
            </dl>
          </Card>

          <Card title="Versions">
            <div className="dc-versions">
              {data.versions.map((v) => (
                <div key={v.id} className="dc-version">
                  <Avatar name={v.uploader} size={30} />
                  <div className="grow">
                    <b>Version {v.version}</b>
                    <small>{v.uploader} · {timeAgo(v.createdAt)} · {formatBytes(v.size)}{v.note ? ` · ${v.note}` : ""}</small>
                  </div>
                  {v.current ? <Pill tone="ok">Current</Pill> : data.canEdit ? <button className="link" onClick={() => setRestore(v)}>Restore</button> : null}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Modal open={linkOpen} onClose={() => { setLinkOpen(false); setLink(null); }} title="Link to a record" subtitle="The file stays in one place and shows up on the record too."
        footer={<><Button variant="secondary" onClick={() => { setLinkOpen(false); setLink(null); }}>Cancel</Button><Button disabled={!link} loading={linking} onClick={addLink}>Link</Button></>}>
        <LinkPicker endpoint="/api/documents/link-targets" value={link} onChange={setLink} exclude={data.links.map((l) => `${l.linkType}:${l.linkId}`)} />
      </Modal>
      <ConfirmDialog open={!!restore} onClose={() => setRestore(null)} title={`Restore version ${restore?.version}?`} confirmLabel="Restore"
        onConfirm={() => { const v = restore!; setRestore(null); run(() => api.post(`/api/documents/files/${f.id}/versions/${v.id}/restore`), `Version ${v.version} restored as the current version`); }}>
        It becomes the new current version. Nothing is lost: the version you have now stays in the history.
      </ConfirmDialog>
      <RenameModal open={rename} onClose={() => setRename(false)} title="Rename file" current={f.name}
        onSave={async (name) => { await api.patch(`/api/documents/files/${f.id}`, { name }); refresh(); toast("File renamed"); }} />
      <MoveModal open={move} onClose={() => setMove(false)} file={f} folders={tree?.folders ?? []} />
      <DetailsModal open={details} onClose={() => setDetails(false)} file={f} />
      <FolderAccessModal open={access} onClose={() => setAccess(false)} folder={folder} />
      <ConfirmDialog open={del} onClose={() => setDel(false)} danger confirmLabel="Delete file" title={`Delete ${f.name}?`}
        onConfirm={async () => {
          setDel(false);
          try { await api.del(`/api/documents/files/${f.id}`); refresh(); toast("File deleted"); navigate(parent ? `/documents/folder/${parent.id}` : "/documents/library"); }
          catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't delete the file.", "error"); }
        }}>
        It will be removed everywhere it's linked. If you might need it later, archive it instead.
      </ConfirmDialog>
      {dialog}
    </div>
  );
}
