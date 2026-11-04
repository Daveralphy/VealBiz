import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Clock, ExternalLink, FileText, Mail, KeyRound, Pencil, Trash2, Upload } from "lucide-react";
import {
  Avatar, Button, Card, IconButton, Input, Loading, Modal, PageHeader, PasswordInput, Pill, Select, Textarea, useToast,
} from "@windveal/ui";
import { INDUSTRIES, TEAM_SIZES } from "@windveal/shared";
import { api, ApiError, fileUrl, publicFileUrl } from "../../lib/api";
import { ME_KEY, useSession, type Me } from "../../lib/session";
import { useForm } from "../../lib/form";
import { SITE_URL } from "../../lib/config";
import { fmtDate, timeAgo } from "../../lib/format";
import { FileViewer, type ViewableFile } from "../../components/FileViewer";
import { useSignOut } from "../../lib/signout";


const ROLE_LABEL: Record<string, string> = { admin: "Admin", manager: "Manager", member: "Member" };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children || <span className="muted">Not added</span>}</dd></div>;
}

/** Uploads an image as a private-until-saved system file. Returns its id. */
async function uploadImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new ApiError(400, "file_type", "Choose an image (PNG, JPG or WebP).");
  const r = await api.upload<{ file: { id: string } }>("/api/files", file, { kind: "system" });
  return r.file.id;
}

// ---------------- Personal ----------------
function Personal() {
  const { user, org, membership } = useSession();
  const navigate = useNavigate();
  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api.get<any[]>("/api/auth/devices") });
  const signOutAll = useSignOut({ everywhere: true });
  return (
    <>
      <Card>
        <div className="pf-head">
          <Avatar name={user.name} size={88} src={user.avatarFileId ? publicFileUrl(user.avatarFileId) : null} />
          <div className="pf-head-text">
            <h2>{user.name}</h2>
            <p className="muted">{[membership.jobTitle, org.name].filter(Boolean).join(" · ")}</p>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Pill tone="blue">{ROLE_LABEL[membership.role]}</Pill>
              {membership.isPrimaryAdmin && <Pill tone="grey">Primary admin</Pill>}
              {user.platformAdmin && <Pill tone="violet">WindVeal admin</Pill>}
            </div>
          </div>
          <Button icon={<Pencil size={15} />} onClick={() => navigate("/profile/edit")}>Edit profile</Button>
        </div>
      </Card>
      <div className="grid-2">
        <div>
          <Card title="Personal details">
            <dl className="kv pf-kv">
              <Detail label="Full name">{user.name}</Detail>
              <Detail label="Phone">{user.phone}</Detail>
              <Detail label="Job title">{membership.jobTitle}</Detail>
              <Detail label="Role">{ROLE_LABEL[membership.role]}</Detail>
              <Detail label="Organisation">{org.name}</Detail>
              <Detail label="On WindVeal since">{user.createdAt ? fmtDate(user.createdAt) : ""}</Detail>
            </dl>
          </Card>
          <Card title="Sign-in and security" subtitle="Changes here are confirmed with a code sent by email.">
            <div className="list-row">
              <Mail size={18} className="muted" />
              <div style={{ flex: 1, minWidth: 0 }}><b className="ink" style={{ display: "block" }}>Email</b><small className="muted">{user.email}</small></div>
              <Button variant="secondary" size="sm" onClick={() => setEmailOpen(true)}>Change</Button>
            </div>
            <div className="list-row">
              <KeyRound size={18} className="muted" />
              <div style={{ flex: 1 }}><b className="ink" style={{ display: "block" }}>Password</b><small className="muted">••••••••••</small></div>
              <Button variant="secondary" size="sm" onClick={() => setPasswordOpen(true)}>Change</Button>
            </div>
          </Card>
        </div>
        <Card title="Your devices" subtitle="Where you're signed in to WindVeal."
          actions={<Button variant="danger" size="sm" onClick={signOutAll.ask}>Sign out everywhere</Button>}>
          {devices.isLoading ? <Loading /> : (devices.data ?? []).map((d) => (
            <div key={d.id} className="list-row"><Clock size={18} className="muted" /><div style={{ flex: 1 }}><b className="ink" style={{ display: "block" }}>{d.label}{d.current && <> <Pill tone="ok">This device</Pill></>}</b><small className="muted">Last active {timeAgo(d.lastSeenAt)}</small></div>{d.blocked && <Pill tone="red">Blocked</Pill>}</div>
          ))}
        </Card>
      </div>
      {signOutAll.dialog}
      <EmailChange open={emailOpen} onClose={() => setEmailOpen(false)} />
      <PasswordChange open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}

function PersonalEdit() {
  const { user, membership } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const f = useForm({ name: user.name, phone: user.phone ?? "", jobTitle: membership.jobTitle ?? "" });
  const [avatar, setAvatar] = useState<string | null>(user.avatarFileId);
  const [preview, setPreview] = useState<string | null>(user.avatarFileId ? publicFileUrl(user.avatarFileId) : null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      setAvatar(await uploadImage(file));
      setPreview(URL.createObjectURL(file));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  };
  return (
    <Card title="Edit profile" subtitle="Your email and password are changed from your profile, with an emailed code.">
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        f.submit(async (v) => {
          const me = await api.patch<Me>("/api/auth/profile", { ...v, avatarFileId: avatar });
          qc.setQueryData(ME_KEY, me);
          qc.invalidateQueries({ queryKey: ["employees"] });
          toast("Profile saved");
          navigate("/profile");
        });
      }}>
        <div className="pf-photo">
          <Avatar name={f.values.name || user.name} size={88} src={preview} />
          <div className="stack" style={{ gap: 8 }}>
            <b className="ink">Profile photo</b>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="secondary" size="sm" icon={<Camera size={15} />} loading={uploading} onClick={() => input.current?.click()}>
                {avatar ? "Change photo" : "Add a photo"}
              </Button>
              {avatar && <Button type="button" variant="ghost" size="sm" icon={<Trash2 size={15} />} onClick={() => { setAvatar(null); setPreview(null); }}>Remove</Button>}
            </div>
            <small className="muted">PNG, JPG or WebP. A square photo works best.</small>
          </div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <div className="form-grid">
          <Input label="Full name" autoComplete="name" {...f.bind("name")} />
          <Input label="Phone" optional type="tel" autoComplete="tel" {...f.bind("phone")} />
          <Input label="Job title" optional {...f.bind("jobTitle")} />
          <Input label="Email" value={user.email} disabled readOnly hint="Change it from your profile (needs a code)." />
        </div>
        <div className="pf-actions">
          <Button type="button" variant="secondary" onClick={() => navigate("/profile")}>Cancel</Button>
          <Button type="submit" loading={f.busy} disabled={uploading}>Save changes</Button>
        </div>
      </form>
    </Card>
  );
}

function EmailChange({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const step1 = useForm({ newEmail: "", currentPassword: "" });
  const step2 = useForm({ code: "" });
  const close = () => { setSentTo(null); step1.setValues({ newEmail: "", currentPassword: "" }); step2.setValues({ code: "" }); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Change your email" subtitle={sentTo ? `We sent a 6-digit code to ${sentTo}.` : "We'll send a code to the new address to confirm it's yours."}
      footer={<>
        <Button variant="secondary" onClick={close}>Cancel</Button>
        {sentTo
          ? <Button loading={step2.busy} onClick={() => step2.submit(async (v) => {
              qc.setQueryData(ME_KEY, await api.post<Me>("/api/auth/email-change/confirm", v));
              toast("Email changed. Use it next time you sign in.");
              close();
            })}>Confirm</Button>
          : <Button loading={step1.busy} onClick={() => step1.submit(async (v) => {
              const r = await api.post<{ sentTo: string }>("/api/auth/email-change/request", v);
              setSentTo(r.sentTo);
            })}>Send code</Button>}
      </>}>
      {sentTo ? (
        <div className="stack">
          <Input label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...step2.bind("code")} />
          <button className="link" type="button" onClick={() => setSentTo(null)}>Use a different email</button>
        </div>
      ) : (
        <div className="stack">
          <Input label="New email" type="email" autoComplete="email" {...step1.bind("newEmail")} />
          <PasswordInput label="Your password" autoComplete="current-password" {...step1.bind("currentPassword")} />
        </div>
      )}
    </Modal>
  );
}

function PasswordChange({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useSession();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const step1 = useForm({ currentPassword: "" });
  const step2 = useForm({ code: "", password: "" });
  const close = () => { setSent(false); step1.setValues({ currentPassword: "" }); step2.setValues({ code: "", password: "" }); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Change your password"
      subtitle={sent ? `We sent a 6-digit code to ${user.email}.` : "First confirm your current password. We'll then email you a code."}
      footer={<>
        <Button variant="secondary" onClick={close}>Cancel</Button>
        {sent
          ? <Button loading={step2.busy} onClick={() => step2.submit(async (v) => {
              await api.post("/api/auth/change-password", v);
              toast("Password changed. Your other devices were signed out.");
              close();
            })}>Change password</Button>
          : <Button loading={step1.busy} onClick={() => step1.submit(async (v) => {
              await api.post("/api/auth/change-password/request", v);
              setSent(true);
            })}>Send code</Button>}
      </>}>
      {sent ? (
        <div className="stack">
          <Input label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...step2.bind("code")} />
          <PasswordInput label="New password" autoComplete="new-password" hint="At least 10 characters with a number, an uppercase letter and a symbol." {...step2.bind("password")} />
        </div>
      ) : (
        <PasswordInput label="Current password" autoComplete="current-password" {...step1.bind("currentPassword")} />
      )}
    </Modal>
  );
}

// ---------------- Company ----------------
function useOrg() {
  return useQuery({ queryKey: ["org"], queryFn: () => api.get<{ org: any }>("/api/org") });
}

function Company() {
  const { isAdmin, membership } = useSession();
  const navigate = useNavigate();
  const orgQ = useOrg();
  const membersQ = useQuery({ queryKey: ["members"], queryFn: () => api.get<any[]>("/api/members") });
  const o = orgQ.data?.org;
  if (!o) return <Loading />;
  const countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(o.country) ?? o.country;
  const owner = (membersQ.data ?? []).find((m) => m.isOwner);
  const primary = (membersQ.data ?? []).find((m) => m.isPrimaryAdmin);
  const perks: string[] = o.settings?.perks ?? [];
  const careersUrl = `${SITE_URL}/careers/${o.slug}`;
  return (
    <>
      <div className="pf-company">
        <div className="pf-cover" style={o.coverFileId ? { backgroundImage: `url(${publicFileUrl(o.coverFileId)})` } : { background: `linear-gradient(120deg, ${o.brandColor ?? "#263f91"}, var(--night))` }} />
        <div className="pf-company-bar">
          <span className="pf-logo" style={!o.logoFileId ? { background: o.brandColor ?? "var(--navy)", color: "#fff" } : undefined}>
            {o.logoFileId ? <img src={publicFileUrl(o.logoFileId)} alt="" draggable={false} /> : o.name.slice(0, 1)}
          </span>
          <div className="pf-head-text">
            <h2>{o.name}</h2>
            <p className="muted">{o.tagline || o.legalName}</p>
          </div>
          {isAdmin && <Button icon={<Pencil size={15} />} onClick={() => navigate("/profile/company/edit")}>Edit company</Button>}
        </div>
      </div>
      <div className="grid-side side-360">
        <div>
          <Card title="Business details">
            <dl className="kv pf-kv">
              <Detail label="Registered name">{o.legalName}</Detail>
              <Detail label="Trading name">{o.tradingName}</Detail>
              <Detail label="Industry">{o.industry}</Detail>
              <Detail label="Team size">{o.teamSize}</Detail>
              <Detail label="Country and currency">{`${countryName} · ${o.currency}`}</Detail>
              <Detail label="City">{o.city}</Detail>
              <Detail label="Address">{o.address}</Detail>
              <Detail label="Registration number">{o.registrationNumber}</Detail>
              <Detail label="Website">{o.website && <a href={o.website} target="_blank" rel="noreferrer">{o.website.replace(/^https?:\/\//, "")}</a>}</Detail>
            </dl>
          </Card>
          <Card title="Branding and careers page" subtitle="Shown on your careers page."
            actions={o.verificationStatus === "verified" && <a className="btn btn-ghost btn-sm" href={careersUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open careers page</a>}>
            <dl className="kv pf-kv">
              <Detail label="Brand colour">{o.brandColor && <span className="row" style={{ justifyContent: "flex-end", gap: 8 }}><i className="pf-swatch" style={{ background: o.brandColor }} />{o.brandColor}</span>}</Detail>
              <Detail label="Tagline">{o.tagline}</Detail>
            </dl>
            <h4 className="pf-sub">About</h4>
            <p className="pf-about">{o.about || <span className="muted">Not added</span>}</p>
            <h4 className="pf-sub">Why work with us</h4>
            {perks.length ? <ul className="pf-perks">{perks.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="muted">Not added</p>}
          </Card>
        </div>
        <div>
          <Verification org={o} />
          <Card title="Ownership" subtitle="The owner and primary admin can't be removed.">
            <div className="stack" style={{ gap: 0 }}>
              <div className="list-row"><Avatar name={o.ownerName ?? owner?.name ?? "Owner"} /><div style={{ minWidth: 0, flex: 1 }}><b className="ink" style={{ display: "block" }}>{o.ownerName ?? owner?.name ?? "Not set"}</b><small className="muted">{o.ownerEmail ?? ""}</small></div><Pill>Owner</Pill></div>
              {primary && <div className="list-row"><Avatar name={primary.name} /><div style={{ minWidth: 0, flex: 1 }}><b className="ink" style={{ display: "block" }}>{primary.name}{primary.isYou && <> <Pill tone="blue">You</Pill></>}</b><small className="muted">{primary.jobTitle ?? primary.email}</small></div><Pill>Primary admin</Pill></div>}
            </div>
            {membership.isPrimaryAdmin && <TransferPrimary members={membersQ.data ?? []} />}
          </Card>
        </div>
      </div>
    </>
  );
}

function Verification({ org: o }: { org: any }) {
  const { isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [viewing, setViewing] = useState<ViewableFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const docs = useQuery({ queryKey: ["verification-documents"], queryFn: () => api.get<ViewableFile[]>("/api/org/verification-documents") });
  const status = o.verificationStatus as string;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["org"] });
    await qc.invalidateQueries({ queryKey: ["verification-documents"] });
    await qc.invalidateQueries({ queryKey: ME_KEY });
  };
  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await api.upload<{ file: { id: string } }>("/api/files", file, { kind: "system" });
      await api.post("/api/org/verification-document", { fileId: r.file.id });
      await refresh();
      toast("Document sent. WindVeal will review it.");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  };
  const remove = async (id: string) => {
    try { await api.del(`/api/org/verification-document/${id}`); await refresh(); toast("Document removed"); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't remove it", "error"); }
  };
  return (
    <Card title="Verification" subtitle={status === "verified" ? `Verified${o.verificationReviewedAt ? ` on ${fmtDate(o.verificationReviewedAt)}` : ""}.` : "WindVeal checks your details, usually within 1 to 2 working days."}
      actions={<Pill tone={status === "verified" ? "ok" : status === "rejected" ? "red" : "warn"}>{status === "verified" ? "Verified" : status === "rejected" ? "Not verified" : "Pending"}</Pill>}>
      {status !== "verified" && (
        <div className="stack" style={{ gap: 12, marginBottom: 16, fontSize: 14 }}>
          <div className="row"><Pill tone="ok">✓</Pill><span>Business details submitted<br /><small className="muted">{fmtDate(o.createdAt)}</small></span></div>
          <div className="row"><Pill tone={status === "rejected" ? "red" : "warn"}>{status === "rejected" ? "!" : "…"}</Pill><span>WindVeal checks your details<br /><small className="muted">{status === "rejected" ? "Needs changes" : "In progress"}</small></span></div>
          <div className="row"><Pill tone="grey">3</Pill><span>Careers page goes live<br /><small className="muted">After verification</small></span></div>
        </div>
      )}
      {o.verificationNote && <p className={`pf-note ${status === "rejected" ? "bad" : ""}`}><b>Note from WindVeal:</b> {o.verificationNote}</p>}
      <h4 className="pf-sub">Documents sent</h4>
      {docs.isLoading ? <Loading /> : !(docs.data ?? []).length ? <p className="muted" style={{ fontSize: 13.5 }}>None yet.</p> : (docs.data ?? []).map((d) => (
        <div key={d.id} className="list-row">
          <FileText size={18} className="muted" />
          <button className="link pf-file" onClick={() => setViewing(d)}>{d.name}</button>
          {isAdmin && status !== "verified" && <IconButton label={`Remove ${d.name}`} onClick={() => remove(d.id)}><Trash2 size={15} /></IconButton>}
        </div>
      ))}
      {isAdmin && status !== "verified" && <>
        <Button variant="secondary" block icon={<Upload size={15} />} loading={uploading} style={{ marginTop: 12 }} onClick={() => input.current?.click()}>
          Send a certificate or document
        </Button>
        <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
      </>}
      <FileViewer file={viewing} url={fileUrl} onClose={() => setViewing(null)} />
    </Card>
  );
}

function TransferPrimary({ members }: { members: any[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  return (
    <>
      <Button variant="secondary" block style={{ marginTop: 14 }} onClick={() => setOpen(true)}>Transfer primary admin</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Transfer primary admin" subtitle="The new primary admin gets full control and becomes the only person who can transfer it again."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!target} onClick={async () => {
          try { await api.post("/api/org/transfer-primary-admin", { membershipId: target }); await qc.invalidateQueries(); setOpen(false); toast("Primary admin transferred"); }
          catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't transfer", "error"); }
        }}>Transfer</Button></>}>
        <Select label="New primary admin" placeholder="Choose a member" value={target} onChange={(e) => setTarget(e.target.value)}
          options={members.filter((m) => !m.isYou && m.status === "active").map((m) => ({ value: m.id, label: `${m.name} (${m.role})` }))} />
      </Modal>
    </>
  );
}

function ImagePicker({ label, hint, id, preview, onPick, onClear, wide }: {
  label: string; hint: string; id: string | null; preview: string | null; onPick: (f: File) => void; onClear: () => void; wide?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className={`pf-pick ${wide ? "wide" : ""}`}>
        <span className="pf-pick-img" style={preview ? { backgroundImage: `url(${preview})` } : undefined}>{!preview && <Camera size={20} className="muted" />}</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>{id ? "Change" : "Upload"}</Button>
          {id && <Button type="button" variant="ghost" size="sm" onClick={onClear}>Remove</Button>}
        </div>
      </div>
      <small className="field-hint">{hint}</small>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
    </div>
  );
}

function CompanyEdit() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const orgQ = useOrg();
  const o = orgQ.data?.org;
  const f = useForm({
    legalName: "", tradingName: "", industry: "", teamSize: "", city: "", address: "", registrationNumber: "", website: "",
    brandColor: "#486FE4", tagline: "", about: "", perks: "",
  });
  const [logo, setLogo] = useState<{ id: string | null; preview: string | null }>({ id: null, preview: null });
  const [cover, setCover] = useState<{ id: string | null; preview: string | null }>({ id: null, preview: null });
  const [uploading, setUploading] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (!o || loaded.current) return;
    loaded.current = true;
    f.setValues({
      legalName: o.legalName, tradingName: o.tradingName ?? "", industry: o.industry ?? "", teamSize: o.teamSize ?? "", city: o.city ?? "",
      address: o.address ?? "", registrationNumber: o.registrationNumber ?? "", website: o.website ?? "",
      brandColor: o.brandColor ?? "#486FE4", tagline: o.tagline ?? "", about: o.about ?? "", perks: (o.settings?.perks ?? []).join("\n"),
    });
    setLogo({ id: o.logoFileId, preview: o.logoFileId ? publicFileUrl(o.logoFileId) : null });
    setCover({ id: o.coverFileId, preview: o.coverFileId ? publicFileUrl(o.coverFileId) : null });
  }, [o]);
  if (!o) return <Loading />;
  const countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(o.country) ?? o.country;
  const pick = (set: typeof setLogo) => async (file: File) => {
    setUploading(true);
    try { set({ id: await uploadImage(file), preview: URL.createObjectURL(file) }); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Upload failed", "error"); }
    finally { setUploading(false); }
  };
  return (
    <form noValidate onSubmit={(e) => {
      e.preventDefault();
      f.submit(async (v) => {
        const { brandColor, tagline, about, perks, ...details } = v;
        await api.patch("/api/org/details", details);
        await api.patch("/api/org/branding", {
          brandColor, tagline, about, logoFileId: logo.id, coverFileId: cover.id,
          perks: perks.split("\n").map((p) => p.trim()).filter(Boolean),
        });
        await qc.invalidateQueries({ queryKey: ["org"] });
        await qc.invalidateQueries({ queryKey: ME_KEY });
        toast("Company profile saved");
        navigate("/profile/company");
      });
    }}>
      <Card title="Business details" subtitle="Used for verification, invoices and your careers page.">
        <div className="form-grid">
          <Input label="Registered business name" {...f.bind("legalName")} />
          <Input label="Trading name" optional {...f.bind("tradingName")} />
          <Select label="Industry" options={INDUSTRIES} {...f.bind("industry")} />
          <Select label="Team size" options={TEAM_SIZES} {...f.bind("teamSize")} />
          <Input label="Country" value={`${countryName} · ${o.currency}`} disabled readOnly hint="Sets your currency. Contact support to change it." />
          <Input label="City" {...f.bind("city")} />
          <Input label="Business address" wrapClassName="span-2" {...f.bind("address")} />
          <Input label="Company registration number" {...f.bind("registrationNumber")} />
          <Input label="Website" {...f.bind("website")} />
        </div>
      </Card>
      <Card title="Branding and careers page" subtitle="Your logo, cover and colour appear on your careers page and in WindVeal.">
        <div className="form-grid">
          <ImagePicker label="Logo" hint="Square, at least 256 × 256." id={logo.id} preview={logo.preview} onPick={pick(setLogo)} onClear={() => setLogo({ id: null, preview: null })} />
          <ImagePicker label="Cover image" hint="Wide, at least 1600 × 500." id={cover.id} preview={cover.preview} onPick={pick(setCover)} onClear={() => setCover({ id: null, preview: null })} wide />
          <label className="field"><span className="field-label">Brand colour</span>
            <span className="row"><input type="color" value={f.values.brandColor} onChange={(e) => f.set("brandColor", e.target.value.toUpperCase())} /><span className="muted">{f.values.brandColor}</span></span>
          </label>
          <Input label="Tagline" optional {...f.bind("tagline")} />
          <Textarea label="About your business" optional wrapClassName="span-2" {...f.bind("about")} />
          <Textarea label="Why work with us" optional hint="One perk per line." wrapClassName="span-2" {...f.bind("perks")} />
        </div>
      </Card>
      <div className="pf-actions">
        <Button type="button" variant="secondary" onClick={() => navigate("/profile/company")}>Cancel</Button>
        <Button type="submit" loading={f.busy} disabled={uploading}>Save changes</Button>
      </div>
    </form>
  );
}

export function ProfileRoutes() {
  const { isAdmin } = useSession();
  useEffect(() => { document.title = "Profile · WindVeal"; }, []);
  return (
    <>
      <PageHeader title="Profile" subtitle="Your details and your company's." />
      <Routes>
        <Route index element={<Personal />} />
        <Route path="edit" element={<PersonalEdit />} />
        <Route path="company" element={<Company />} />
        <Route path="company/edit" element={isAdmin ? <CompanyEdit /> : <Navigate to="/profile/company" replace />} />
        <Route path="*" element={<Navigate to="/profile" replace />} />
      </Routes>
    </>
  );
}

