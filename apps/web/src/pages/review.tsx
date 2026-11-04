import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Mail, Pencil, Upload } from "lucide-react";
import { BrandLogo, Button, Input, Loading, Modal, Pill, Textarea, useToast } from "@windveal/ui";
import { REVIEW_REQUESTS, VERIFICATION_DOC_KINDS, type ReviewRequest, type ReviewRequestItem } from "@windveal/shared";
import { api, ApiError, fileUrl, publicFileUrl } from "../lib/api";
import { ME_KEY } from "../lib/session";
import { useSignOut } from "../lib/signout";
import { fmtDate, fmtTime } from "../lib/format";
import { SUPPORT_EMAIL } from "../lib/config";
import { FileViewer, type ViewableFile } from "../components/FileViewer";

type Doc = ViewableFile & { proof: keyof typeof VERIFICATION_DOC_KINDS; createdAt: string };
type Review = {
  org: { name: string; legalName: string; tradingName: string | null; registrationNumber: string | null; address: string | null; city: string | null; website: string | null; logoFileId: string | null };
  status: "pending" | "needs_info" | "verified" | "rejected";
  submittedAt: string | null; decidedAt: string | null; note: string | null; request: ReviewRequest | null;
  createdAt: string; emailVerifiedAt: string | null; documents: Doc[]; canAct: boolean;
};

const when = (d: string | null | undefined) => (d ? `${fmtDate(d)}, ${fmtTime(d)}` : "");
/** Which kind of proof a requested upload is. */
const PROOF: Record<string, keyof typeof VERIFICATION_DOC_KINDS> = { certificate: "certificate", address: "address", owner_id: "owner_id", other: "other" };
const itemLabel = (i: ReviewRequestItem) => (i.key === "other" ? i.label || REVIEW_REQUESTS.other.need : REVIEW_REQUESTS[i.key].need);

/**
 * What a business sees until WindVeal approves it: where its review has got to, and, when WindVeal asks
 * for more, exactly what to send. Nothing else in WindVeal opens until it's approved.
 */
export function ReviewStatus({ email }: { email: string }) {
  const qc = useQueryClient();
  const signOut = useSignOut();
  // Check back now and then, so the business is let in as soon as it's approved.
  const q = useQuery({ queryKey: ["org-review"], queryFn: () => api.get<Review>("/api/org/review"), refetchInterval: 60_000, refetchOnWindowFocus: true });
  const status = q.data?.status;
  useEffect(() => {
    if (status === "verified") void qc.invalidateQueries({ queryKey: ME_KEY });
  }, [status, qc]);
  useEffect(() => { document.title = "Your WindVeal review · WindVeal"; }, []);

  if (!q.data) return <div className="rv"><Loading /></div>;
  const r = q.data;
  const copy = {
    pending: ["We're reviewing your business.", "WindVeal checks every business before it goes live, so everyone on the platform is real. This usually takes one working day. We'll email you as soon as it's done."],
    needs_info: ["WindVeal needs a little more from you.", `We couldn't finish checking ${r.org.name} yet. Send the items below and we'll look again, usually within one working day.`],
    rejected: [`We couldn't approve ${r.org.name}.`, "Your account can't be used on WindVeal. If you think this is a mistake, reply to our email or contact support and we'll take another look."],
    verified: ["You're approved.", "Opening WindVeal…"],
  }[r.status];

  return (
    <div className="rv">
      <div className="rv-l">
        <div className="rv-photo" aria-hidden />
        <BrandLogo height={30} tone="light" />
        <div className="rv-copy">
          <span className="rv-org">
            <i>{r.org.logoFileId ? <img src={publicFileUrl(r.org.logoFileId)} alt="" /> : r.org.name.slice(0, 1)}</i>{r.org.name}
          </span>
          <h1>{copy[0]}</h1>
          <p>{copy[1]}</p>
        </div>
        <small>Questions? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></small>
      </div>
      <div className="rv-r page-enter">
        <div className="rv-top">
          <span className="muted">Signed in as {email}</span>
          <Button variant="secondary" size="sm" onClick={signOut.ask}>Sign out</Button>
        </div>
        {r.status === "needs_info" ? <NeedsInfo r={r} /> : (
          <>
            <div className="card"><Steps r={r} /></div>
            {r.status === "rejected" && r.note && (
              <div className="rv-msg red"><small>Reason from the WindVeal review team</small>{r.note}</div>
            )}
            {r.status === "pending" && <Sent r={r} />}
            {r.status === "rejected" && (
              <div className="rv-foot">
                <small>Your details stay on record with WindVeal.</small>
                <a className="btn btn-primary btn-lg" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Review of ${r.org.name}`)}`}><Mail size={16} />Contact support</a>
              </div>
            )}
          </>
        )}
      </div>
      {signOut.dialog}
    </div>
  );
}

function Step({ state, title, sub, pill }: { state: "done" | "now" | "bad" | "later"; title: string; sub: string; pill?: ReactNode }) {
  return (
    <div className={`rv-step ${state}`}>
      <span className="c">{state === "done" && <Check size={14} strokeWidth={3} />}</span>
      <div><b>{title}</b><small>{sub}</small></div>
      {pill}
    </div>
  );
}

function Steps({ r }: { r: Review }) {
  return (
    <div className="rv-steps">
      <Step state="done" title="Account created" sub={when(r.createdAt)} />
      <Step state="done" title="Email verified" sub={when(r.emailVerifiedAt)} />
      <Step state="done" title="Business details sent" sub={r.submittedAt ? when(r.submittedAt) : "Registration, address and documents"} />
      {r.status === "rejected"
        ? <Step state="bad" title="WindVeal review" sub={`Finished ${when(r.decidedAt)}`} pill={<Pill tone="red">Not approved</Pill>} />
        : <Step state="now" title="WindVeal review" sub={r.submittedAt ? `Started ${when(r.submittedAt)}` : "Starting soon"} pill={<Pill tone="warn">In progress</Pill>} />}
      <Step state="later" title="Start using WindVeal" sub="Your team can join once you're approved" />
    </div>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["org-review"] });
}

/** While waiting: what they sent, and a way to correct it. */
function Sent({ r }: { r: Review }) {
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<ViewableFile | null>(null);
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>What you sent</h3><p>You can still correct these while we review.</p></div>
        {r.canAct && <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Update details</Button>}
      </div>
      <dl className="rv-kv">
        <dt>Registered name</dt><dd>{r.org.legalName}</dd>
        <dt>Registration number</dt><dd>{r.org.registrationNumber || "Not given"}</dd>
        <dt>Address</dt><dd>{[r.org.address, r.org.city].filter(Boolean).join(", ") || "Not given"}</dd>
        <dt>Documents</dt>
        <dd className="stack" style={{ gap: 6 }}>
          {r.documents.length ? r.documents.map((d) => (
            <button key={d.id} className="rv-file" onClick={() => setViewing(d)}><FileText size={15} />{d.name}<span className="muted">{VERIFICATION_DOC_KINDS[d.proof]}</span></button>
          )) : "None"}
        </dd>
      </dl>
      <DetailsModal open={editing} onClose={() => setEditing(false)} r={r} />
      <FileViewer file={viewing} url={fileUrl} onClose={() => setViewing(null)} />
    </div>
  );
}

function DetailsModal({ open, onClose, r, only }: { open: boolean; onClose: () => void; r: Review; only?: "registrationNumber" }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [v, setV] = useState({ legalName: "", registrationNumber: "", address: "", city: "", website: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setV({ legalName: r.org.legalName, registrationNumber: r.org.registrationNumber ?? "", address: r.org.address ?? "", city: r.org.city ?? "", website: r.org.website ?? "" });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await api.patch("/api/org/details", only ? { registrationNumber: v.registrationNumber } : v);
      await refresh(); toast("Details updated"); onClose();
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save that", "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={only ? "Registration number" : "Update details"} subtitle={only ? "Check it matches your certificate of incorporation." : "WindVeal reviews what's here."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        {!only && <Input label="Registered name" value={v.legalName} onChange={set("legalName")} />}
        <Input label="Registration number" value={v.registrationNumber} onChange={set("registrationNumber")} />
        {!only && <>
          <Input label="Address" value={v.address} onChange={set("address")} />
          <Input label="City" value={v.city} onChange={set("city")} />
          <Input label="Website" optional value={v.website} onChange={set("website")} />
        </>}
      </div>
    </Modal>
  );
}

/** WindVeal asked for more: each item is a to-do with the right button, then "Send for review". */
function NeedsInfo({ r }: { r: Review }) {
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefresh();
  const req = r.request!;
  const done = req.items.filter((i) => i.doneAt).length;
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      await api.post("/api/org/review/submit");
      await refresh(); await qc.invalidateQueries({ queryKey: ME_KEY });
      toast("Sent. WindVeal will look again soon.");
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't send it", "error"); }
    finally { setSending(false); }
  };
  return (
    <>
      <div className="card">
        <div className="card-head"><div><h3>What we need</h3><p>{done} of {req.items.length} done</p></div></div>
        <div className="rv-msg"><small>From the WindVeal review team · {fmtDate(req.at)}</small>{req.message}</div>
        <div className="rv-reqs">{req.items.map((i) => <RequestItem key={i.key} item={i} r={r} />)}</div>
      </div>
      <div className="rv-foot">
        <small>{r.canAct ? "We'll look again as soon as you send this." : `An admin at ${r.org.name} can send what's needed.`}</small>
        {r.canAct && <Button size="lg" loading={sending} disabled={done < req.items.length} onClick={send}>Send for review</Button>}
      </div>
    </>
  );
}

function RequestItem({ item, r }: { item: ReviewRequestItem; r: Review }) {
  const toast = useToast();
  const refresh = useRefresh();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [noting, setNoting] = useState(false);
  const kind = REVIEW_REQUESTS[item.key].kind;
  const files = r.documents.filter((d) => item.fileIds?.includes(d.id));
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const f = await api.upload<{ file: { id: string } }>("/api/files", file, { kind: "system" });
      await api.post("/api/org/verification-document", { fileId: f.file.id, proof: PROOF[item.key], item: item.key });
      await refresh(); toast("Uploaded");
    } catch (e) { toast(e instanceof ApiError ? e.message : "Upload failed", "error"); }
    finally { setBusy(false); }
  };
  const confirm = async (note: string) => {
    setBusy(true);
    try { await api.post("/api/org/review/item", { key: item.key, note }); await refresh(); setNoting(false); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save that", "error"); }
    finally { setBusy(false); }
  };
  const sub = item.doneAt
    ? files.length ? files.map((f) => f.name).join(", ") : item.note || "Done"
    : item.key === "registration_number" ? `Now ${r.org.registrationNumber || "not given"}. ${REVIEW_REQUESTS[item.key].hint}` : REVIEW_REQUESTS[item.key].hint;
  return (
    <div className={`rv-req ${item.doneAt ? "done" : ""}`}>
      <span className="c">{item.doneAt && <Check size={14} strokeWidth={3} />}</span>
      <div><b>{itemLabel(item)}</b><small>{sub}</small></div>
      {r.canAct && (
        <div className="rv-req-act">
          {kind === "field" && <>
            {!item.doneAt && <Button variant="ghost" size="sm" loading={busy} onClick={() => confirm("Checked: the number is correct")}>It's correct</Button>}
            <Button variant={item.doneAt ? "ghost" : "secondary"} size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Change</Button>
          </>}
          {kind === "upload_or_note" && !item.doneAt && <Button variant="ghost" size="sm" onClick={() => setNoting(true)}>Reply with a note</Button>}
          {kind !== "field" && (
            <Button variant={item.doneAt ? "ghost" : "secondary"} size="sm" icon={<Upload size={14} />} loading={busy} onClick={() => input.current?.click()}>
              {item.doneAt ? "Add another" : "Upload"}
            </Button>
          )}
          <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      )}
      {kind === "field" && <DetailsModal open={editing} onClose={() => setEditing(false)} r={r} only="registrationNumber" />}
      <NoteModal open={noting} onClose={() => setNoting(false)} onSave={confirm} busy={busy} />
    </div>
  );
}

function NoteModal({ open, onClose, onSave, busy }: { open: boolean; onClose: () => void; onSave: (note: string) => void; busy: boolean }) {
  const [note, setNote] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Reply to WindVeal" subtitle="Tell the review team what they asked for."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!note.trim()} onClick={() => onSave(note.trim())}>Save</Button></>}>
      <Textarea label="Your reply" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  );
}
