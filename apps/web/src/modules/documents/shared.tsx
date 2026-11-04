import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Input, Modal, Notice, Select, Switch, useToast } from "@windveal/ui";
import { ApiError, api } from "../../lib/api";
import { useForm } from "../../lib/form";

export type FolderNode = {
  id: string; name: string; parentId: string | null; restricted: boolean; accessRoles: string[]; system: boolean;
  fileCount: number; totalCount: number; access: { label: string; restricted: boolean };
};
export type FolderTree = { rootFiles: number; folders: FolderNode[] };
export type FileRow = {
  id: string; name: string; mime: string; size: number; folderId: string | null; category: string | null; tags: string[]; expiresOn: string | null;
  currentVersion: number; kind: string; uploadedBy: string | null; createdAt: string; updatedAt: string; archivedAt: string | null;
  uploaderName: string; folderName: string | null; linkedTo: { type: string; id: string; label: string } | null; linkCount: number;
  access: { label: string; restricted: boolean };
};

export const CATEGORIES = ["Client contract", "Supplier contract", "Invoice", "Receipt", "Proposal", "Policy", "Employee record", "Certificate", "Report", "Other"];
export const ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif";
export const ALLOWED_EXT = ACCEPT.split(",").map((e) => e.slice(1));
export const MAX_BYTES = 50 * 1024 * 1024;

export function useFolders() {
  return useQuery({ queryKey: ["dc-folders"], queryFn: () => api.get<FolderTree>("/api/documents/folders") });
}

export function useDocsRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["dc-folders", "dc-files", "dc-file", "dc-summary", "dc-dashboard", "storage"]) qc.invalidateQueries({ queryKey: [k] });
  };
}

export function fileKind(name: string): "pdf" | "doc" | "xls" | "img" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "txt", "ppt", "pptx", "rtf", "odt"].includes(ext)) return "doc";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "xls";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "img";
  return "other";
}

export function TypeBadge({ name, size = 34 }: { name: string; size?: number }) {
  const k = fileKind(name);
  const label = k === "other" ? (name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE") : k.toUpperCase();
  return <span className={`dc-badge dc-badge-${k}`} style={{ width: size, height: size }}>{label}</span>;
}

/** Path from the root to a folder, e.g. [Contracts, Clients]. */
export function folderPath(folders: FolderNode[], id: string | null): FolderNode[] {
  const out: FolderNode[] = [];
  let cur = id ? folders.find((f) => f.id === id) : undefined;
  while (cur && out.length < 20) {
    out.unshift(cur);
    cur = cur.parentId ? folders.find((f) => f.id === cur!.parentId) : undefined;
  }
  return out;
}

/** Folders flattened depth-first for <select> lists. */
export function folderOptions(folders: FolderNode[], exclude?: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.id === exclude) continue;
      out.push({ value: f.id, label: `${"   ".repeat(depth)}${f.name}${f.restricted ? " (restricted)" : ""}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function NewFolderModal({ open, onClose, parentId, folders, onCreated }: {
  open: boolean; onClose: () => void; parentId: string | null; folders: FolderNode[]; onCreated?: (id: string) => void;
}) {
  const refresh = useDocsRefresh();
  const toast = useToast();
  const form = useForm({ name: "", parentId: parentId ?? "" });
  useEffect(() => { if (open) { form.setValues({ name: "", parentId: parentId ?? "" }); form.setErrors({}); form.setFormError(null); } }, [open, parentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => form.submit(async (v) => {
    const r = await api.post<{ id: string }>("/api/documents/folders", { name: v.name, parentId: v.parentId || null });
    refresh();
    toast("Folder created");
    onCreated?.(r.id);
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="New folder"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.busy} onClick={save}>Create folder</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Name" autoFocus placeholder="e.g. Suppliers" {...form.bind("name")} />
        <Select label="Inside" value={form.values.parentId} onChange={(e) => form.set("parentId", e.target.value)} error={form.errors.parentId}>
          <option value="">All files (top level)</option>
          {folderOptions(folders).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <p className="muted dc-small">New folders follow the access of the folder they're in.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function RenameModal({ open, onClose, title, current, onSave }: { open: boolean; onClose: () => void; title: string; current: string; onSave: (name: string) => Promise<void> }) {
  const form = useForm({ name: current });
  useEffect(() => { if (open) { form.setValues({ name: current }); form.setErrors({}); form.setFormError(null); } }, [open, current]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => form.submit(async (v) => { await onSave(v.name.trim()); onClose(); });
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.busy} onClick={save}>Save</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Name" autoFocus {...form.bind("name")} />
      </form>
    </Modal>
  );
}

export function MoveModal({ open, onClose, file, folders }: { open: boolean; onClose: () => void; file: { id: string; name: string; folderId: string | null } | null; folders: FolderNode[] }) {
  const refresh = useDocsRefresh();
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setTarget(file?.folderId ?? ""); setErr(null); } }, [open, file]);
  async function save() {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/documents/files/${file.id}`, { folderId: target || null });
      refresh();
      toast("File moved");
      onClose();
    } catch (e) { setErr(errText(e, "Couldn't move the file.")); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Move ${file?.name ?? "file"}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={(file?.folderId ?? "") === target}>Move here</Button></>}>
      {err && <Notice tone="error">{err}</Notice>}
      <Select label="Folder" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">All files (top level)</option>
        {folderOptions(folders).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </Modal>
  );
}

export function DetailsModal({ open, onClose, file }: { open: boolean; onClose: () => void; file: FileRow | null }) {
  const refresh = useDocsRefresh();
  const toast = useToast();
  const form = useForm({ category: "", tags: "", expiresOn: "" });
  useEffect(() => {
    if (open && file) { form.setValues({ category: file.category ?? "", tags: file.tags.join(", "), expiresOn: file.expiresOn ?? "" }); form.setErrors({}); form.setFormError(null); }
  }, [open, file]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => form.submit(async (v) => {
    await api.patch(`/api/documents/files/${file!.id}`, {
      category: v.category.trim() || null, tags: v.tags.split(",").map((t) => t.trim()).filter(Boolean), expiresOn: v.expiresOn || null,
    });
    refresh();
    toast("Details saved");
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="Edit details"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.busy} onClick={save}>Save</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Category" optional list="dc-categories" placeholder="e.g. Client contract" {...form.bind("category")} />
        <datalist id="dc-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        <Input label="Tags" optional hint="Separate with commas, e.g. renewal, linen" {...form.bind("tags")} />
        <Input label="Expires" optional type="date" {...form.bind("expiresOn")} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const ROLE_OPTIONS = [{ value: "manager", label: "Managers" }, { value: "member", label: "Members" }];

export function FolderAccessModal({ open, onClose, folder }: { open: boolean; onClose: () => void; folder: FolderNode | null }) {
  const refresh = useDocsRefresh();
  const toast = useToast();
  const [restricted, setRestricted] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open && folder) { setRestricted(folder.restricted); setRoles(folder.accessRoles.filter((r) => r !== "admin")); setErr(null); } }, [open, folder]);
  async function save() {
    if (!folder) return;
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/documents/folders/${folder.id}`, { restricted, accessRoles: restricted ? ["admin", ...roles] : [] });
      refresh();
      toast("Access updated");
      onClose();
    } catch (e) { setErr(errText(e, "Couldn't change access.")); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Who can see ${folder?.name ?? "this folder"}`} subtitle="Files in this folder and its sub-folders follow this setting."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        {err && <Notice tone="error">{err}</Notice>}
        <div className="between">
          <span><b className="ink">Restricted</b><br /><small className="muted">Only the roles you pick (and admins) can open it.</small></span>
          <Switch checked={restricted} onChange={setRestricted} label="Restricted" />
        </div>
        {restricted && (
          <div className="stack" style={{ gap: 10 }}>
            <Checkbox label="Admins (always)" checked disabled />
            {ROLE_OPTIONS.map((r) => (
              <Checkbox key={r.value} label={r.label} checked={roles.includes(r.value)}
                onChange={(e) => setRoles((s) => (e.target.checked ? [...s, r.value] : s.filter((x) => x !== r.value)))} />
            ))}
          </div>
        )}
        {!restricted && <Notice tone="info">Everyone with access to Documents can see this folder.</Notice>}
      </div>
    </Modal>
  );
}
