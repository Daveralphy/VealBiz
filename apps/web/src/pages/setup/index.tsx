import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, Check, Clock, Plus, Upload, UserCheck, X } from "lucide-react";
import { BrandLogo, Button, IconButton, Input, Notice, Segmented, Select, Textarea, usePageTransition } from "@windveal/ui";
import { INDUSTRIES, TEAM_SIZES, formatMoney } from "@windveal/shared";
import { monthlyPrice, usePricing, yearlyTotal, type PricingPlan } from "../../lib/pricing";
import { api, ApiError, publicFileUrl } from "../../lib/api";
import { ME_KEY, useMe, type Me } from "../../lib/session";
import { useForm } from "../../lib/form";
import { useSignOut } from "../../lib/signout";
import { CONTACT_EMAIL } from "../../lib/config";

const STEPS = [
  { key: "account", label: "Your account" },
  { key: "verify", label: "Verify email" },
  { key: "details", label: "Business details" },
  { key: "role", label: "Your role" },
  { key: "branding", label: "Branding" },
  { key: "plan", label: "Choose a plan" },
  { key: "team", label: "Invite your team" },
];

function Wizard({ step, children }: { step: string; children: ReactNode }) {
  const idx = step === "done" ? STEPS.length : STEPS.findIndex((s) => s.key === step);
  const exit = useSignOut({ title: "Save and exit?", message: "Your progress is saved. Sign in again any time to finish setting up.", confirmLabel: "Save and exit" });
  const panel = usePageTransition<HTMLElement>(step);
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="wz-top"><div className="in"><BrandLogo height={36} /><button className="link" onClick={exit.ask}>Save and exit</button></div></header>
      {exit.dialog}
      <div className="wz-bar"><i style={{ width: `${((idx + 1) / STEPS.length) * 100}%` }} /></div>
      <div className="wz">
        <aside className="wz-side">
          <ul className="wz-steps">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i < idx ? "done" : i === idx ? "on" : ""}>
                <b>{i < idx ? <Check size={14} strokeWidth={3} /> : i + 1}</b>{s.label}
              </li>
            ))}
          </ul>
          <div className="wz-help"><b className="ink" style={{ display: "block", marginBottom: 4 }}>Need a hand?</b>You can save and come back to finish any time.</div>
        </aside>
        <main className="wz-panel page-enter" ref={panel}>{children}</main>
      </div>
    </div>
  );
}

function useMeUpdater() {
  const qc = useQueryClient();
  return async () => { await qc.invalidateQueries({ queryKey: ME_KEY }); };
}

function Details() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const refresh = useMeUpdater();
  const orgQ = useQuery({ queryKey: ["org"], queryFn: () => api.get("/api/org"), enabled: !!me?.org });
  const f = useForm({ legalName: "", tradingName: "", industry: "", teamSize: "", country: "NG", city: "", address: "", registrationNumber: "", website: "" });
  const loaded = useRef(false);
  useEffect(() => {
    const o = orgQ.data?.org;
    if (o && !loaded.current) {
      loaded.current = true;
      f.setValues({ legalName: o.legalName, tradingName: o.tradingName ?? "", industry: o.industry ?? "", teamSize: o.teamSize ?? "", country: o.country, city: o.city ?? "", address: o.address ?? "", registrationNumber: o.registrationNumber ?? "", website: o.website ?? "" });
    }
  }, [orgQ.data]);
  const pricing = usePricing();
  const countries = pricing.data?.countries ?? [];
  const currency = countries.find((c) => c.code === f.values.country)?.currency ?? "";
  const currencyName = currency ? new Intl.DisplayNames(["en"], { type: "currency" }).of(currency) : "";
  return (
    <Wizard step="details">
      <h1>Tell us about your business.</h1>
      <p className="sub">This sets up your organisation in WindVeal. Use your official details so we can verify your business.</p>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        f.submit(async (v) => {
          if (me?.org) await api.patch("/api/org/details", { ...v, country: undefined });
          else await api.post("/api/org", v);
          await refresh();
          navigate("/setup/role");
        });
      }}>
        <div className="form-grid">
          <Input label="Registered business name" {...f.bind("legalName")} autoFocus />
          <Input label="Trading name" optional {...f.bind("tradingName")} />
          <Select label="Industry" placeholder="Choose an industry" options={INDUSTRIES} {...f.bind("industry")} />
          <Select label="Team size" placeholder="Choose a team size" options={TEAM_SIZES} {...f.bind("teamSize")} />
        </div>
        <div className="wz-group">
          <h3>Location</h3>
          <div className="form-grid">
            <Select label="Country" options={countries.map((c) => ({ value: c.code, label: c.name }))} disabled={!!me?.org}
              hint={currency ? `Your prices will be shown in ${currencyName} (${currency}).` : "Loading countries…"} {...f.bind("country")} />
            <Input label="City" {...f.bind("city")} />
            <Input label="Business address" wrapClassName="span-2" {...f.bind("address")} />
          </div>
        </div>
        <div className="wz-group">
          <h3>Verification</h3>
          <div className="form-grid">
            <Input label="Company registration number" optional hint="Adding this now helps us verify you sooner." {...f.bind("registrationNumber")} />
            <Input label="Website" optional placeholder="www.yourbusiness.com" {...f.bind("website")} />
          </div>
        </div>
        <div className="wz-foot"><span /><div className="r"><Button type="submit" size="lg" loading={f.busy}>Continue <ArrowRight size={16} /></Button></div></div>
      </form>
    </Wizard>
  );
}

function Role() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const refresh = useMeUpdater();
  const [relation, setRelation] = useState<"owner" | "representative">("owner");
  const f = useForm({ ownerName: "", ownerEmail: "", jobTitle: "" });
  return (
    <Wizard step="role">
      <h1>What's your role?</h1>
      <p className="sub">Tell us how you're connected to <b className="ink">{me?.org?.legalName}</b>. Either way, you'll be the main administrator of this account.</p>
      <div className="stack" style={{ marginBottom: 20 }}>
        <button type="button" className={`choice ${relation === "owner" ? "on" : ""}`} onClick={() => setRelation("owner")}>
          <span className="ci"><Building2 size={22} /></span>
          <span><h4>I own this business</h4><span>I'm the owner, a co-founder or a director.</span></span><span className="rd" />
        </button>
        <button type="button" className={`choice ${relation === "representative" ? "on" : ""}`} onClick={() => setRelation("representative")}>
          <span className="ci"><UserCheck size={22} /></span>
          <span><h4>I'm setting it up for the owner</h4><span>I work here, for example as a manager or in HR, and have permission to set this up.</span></span><span className="rd" />
        </button>
      </div>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        f.submit(async (v) => {
          await api.post("/api/org/role", relation === "owner" ? { relation, jobTitle: v.jobTitle } : { relation, ...v });
          await refresh();
          navigate("/setup/branding");
        });
      }}>
        {relation === "representative" ? (
          <div className="wz-group" style={{ marginTop: 0 }}>
            <h3>Who owns the business?</h3>
            <p className="muted" style={{ margin: "-8px 0 16px" }}>We'll let them know you've set up WindVeal for their business.</p>
            <div className="form-grid">
              <Input label="Owner's full name" {...f.bind("ownerName")} />
              <Input label="Owner's email" type="email" {...f.bind("ownerEmail")} />
              <Input label="Your job title" wrapClassName="span-2" {...f.bind("jobTitle")} />
            </div>
          </div>
        ) : (
          <div className="form-grid"><Input label="Your job title" optional placeholder="Managing Director" {...f.bind("jobTitle")} /></div>
        )}
        <div className="wz-foot">
          <Link to="/setup/details" className="link row"><ArrowLeft size={15} />Back</Link>
          <div className="r"><Button type="submit" size="lg" loading={f.busy}>Continue <ArrowRight size={16} /></Button></div>
        </div>
      </form>
    </Wizard>
  );
}

const SWATCHES = ["#1E6B47", "#486FE4", "#B42318", "#C7781A", "#6D3FC0", "#0F1A3A"];

/** Picks a representative colour from an image (ignores near-white/black and grey pixels). */
async function dominantColour(file: File): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = 48; c.height = 48;
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0, 48, 48);
    const d = g.getImageData(0, 0, 48, 48).data;
    const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b, a] = [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
      if (a < 200) continue;
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
      if (max > 235 || max < 30 || max - min < 40) continue;
      const k = `${r >> 5}-${gg >> 5}-${b >> 5}`;
      const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += gg; e.b += b;
      buckets.set(k, e);
    }
    const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
    if (!best) return null;
    const hex = (v: number) => Math.round(v / best.n).toString(16).padStart(2, "0");
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`.toUpperCase();
  } catch { return null; }
}

function ImageTile({ label, hint, fileId, onFile, logo }: { label: string; hint: string; fileId: string | null; onFile: (f: File) => Promise<void>; logo?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <button type="button" className={`upload-tile ${logo ? "logo" : ""}`} onClick={() => input.current?.click()} disabled={busy}>
        {fileId ? <img src={publicFileUrl(fileId)} alt="" /> : <><Upload size={20} color="var(--blue)" /><b>{busy ? "Uploading…" : `Upload ${label.toLowerCase()}`}</b>{hint}</>}
      </button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy(true);
        try { await onFile(file); } finally { setBusy(false); e.target.value = ""; }
      }} />
    </div>
  );
}

function Branding() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const refresh = useMeUpdater();
  const orgQ = useQuery({ queryKey: ["org"], queryFn: () => api.get("/api/org") });
  const o = orgQ.data?.org;
  const [color, setColor] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = useForm({ tagline: "", about: "" });
  const loaded = useRef(false);
  useEffect(() => {
    if (o && !loaded.current) {
      loaded.current = true;
      setColor(o.brandColor ?? "#1E6B47"); setLogo(o.logoFileId); setCover(o.coverFileId);
      f.setValues({ tagline: o.tagline ?? "", about: o.about ?? "" });
    }
  }, [o]);
  const upload = async (file: File) => {
    setError(null);
    try {
      const r = await api.upload<{ file: { id: string } }>("/api/files", file, { kind: "system" });
      return r.file.id;
    } catch (e) { setError(e instanceof ApiError ? e.message : "Upload failed."); throw e; }
  };
  const save = (next: boolean) => f.submit(async (v) => {
    await api.patch("/api/org/branding", { brandColor: color ?? undefined, tagline: v.tagline, about: v.about, logoFileId: logo, coverFileId: cover });
    if (!next) await api.post("/api/org/setup-step", { step: "plan" });
    await refresh();
    navigate("/setup/plan");
  });
  const brand = color ?? "#1E6B47";
  const name = me?.org?.name ?? "";
  return (
    <Wizard step="branding">
      <h1>Make it yours.</h1>
      <p className="sub">Your logo, cover and colour appear in your workspace and on your public careers page.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid-side">
        <div className="stack">
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 16 }}>
            <ImageTile label="Logo" hint="PNG or JPG" fileId={logo} logo onFile={async (file) => {
              const id = await upload(file); setLogo(id);
              const c = await dominantColour(file); if (c) setColor(c);
            }} />
            <ImageTile label="Cover image" hint="JPG or PNG, at least 1600 × 500" fileId={cover} onFile={async (file) => setCover(await upload(file))} />
          </div>
          <div className="field">
            <span className="field-label">Brand colour</span>
            <div className="swatches">
              {Array.from(new Set([brand, ...SWATCHES])).map((c) => <button key={c} type="button" aria-label={`Use ${c}`} className={`swatch ${c === brand ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />)}
              <input type="color" value={brand} onChange={(e) => setColor(e.target.value.toUpperCase())} aria-label="Custom colour" style={{ width: 40, height: 34, border: 0, background: "none" }} />
              <span className="mono muted" style={{ fontSize: 13 }}>{brand}</span>
            </div>
            <span className="field-hint">{logo ? "We picked this from your logo. Change it any time." : "Upload a logo and we'll suggest a colour."}</span>
          </div>
          <Input label="Tagline" placeholder="What your business does, in one line" {...f.bind("tagline")} />
          <Textarea label="About your business" optional rows={4} {...f.bind("about")} />
        </div>
        <div>
          <span className="field-label" style={{ display: "block", marginBottom: 8 }}>Careers page preview</span>
          <div className="careers-preview">
            <div className="cov" style={{ backgroundImage: cover ? `url(${publicFileUrl(cover)})` : `linear-gradient(120deg, ${brand}, ${brand}88)` }} />
            <div className="id">
              <div className="lg" style={{ background: logo ? "#fff" : brand }}>{logo ? <img src={publicFileUrl(logo)} alt="" /> : name.slice(0, 1)}</div>
              <h4>{name}</h4>
              <p>{f.values.tagline || "Your tagline appears here."}</p>
              <span className="btnp" style={{ background: brand }}>See open roles</span>
            </div>
          </div>
          <p className="muted row" style={{ fontSize: 13, marginTop: 12, alignItems: "flex-start" }}><Clock size={15} style={{ flex: "none", marginTop: 2 }} />Your careers page goes live once your business is verified.</p>
        </div>
      </div>
      <div className="wz-foot">
        <Link to="/setup/role" className="link row"><ArrowLeft size={15} />Back</Link>
        <div className="r"><button className="link" onClick={() => save(false)}>Skip for now</button><Button size="lg" loading={f.busy} onClick={() => save(true)}>Continue <ArrowRight size={16} /></Button></div>
      </div>
    </Wizard>
  );
}

function Plan() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const refresh = useMeUpdater();
  const [plan, setPlan] = useState<PricingPlan["key"]>("free");
  const [billing, setBilling] = useState<"monthly" | "yearly">("yearly");
  const [busy, setBusy] = useState(false);
  const pricing = usePricing();
  const orgCurrency = me?.org?.currency ?? "";
  const cards = (pricing.data?.plans ?? []).filter((p) => !p.custom);
  const enterprise = pricing.data?.plans.find((p) => p.custom);
  const go = async () => {
    setBusy(true);
    try { await api.post("/api/org/plan", { plan, billing }); await refresh(); navigate("/setup/team"); } finally { setBusy(false); }
  };
  return (
    <Wizard step="plan">
      <h1>Choose your plan.</h1>
      <p className="sub">Start free and finish setting up. Upgrade whenever you need more space or AI.</p>
      <div style={{ marginBottom: 20 }}>
        <Segmented value={billing} onChange={setBilling} options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: <>Yearly <span style={{ fontSize: 12, opacity: .8 }}>{pricing.data?.yearlyMonthsFree ?? 2} months free</span></> }]} />
      </div>
      <div className="plans">
        {pricing.data && cards.map((c) => {
          const { amount, currency } = monthlyPrice(pricing.data!, c, orgCurrency);
          return (
            <button key={c.key} type="button" className={`plan-card ${plan === c.key ? "on" : ""}`} onClick={() => setPlan(c.key)}>
              {c.popular && <span className="pop">Popular</span>}
              <h4>{c.name}</h4>
              <div className="pr">{formatMoney(amount, currency)}<small>per month{billing === "yearly" && amount > 0 ? ` · ${formatMoney(yearlyTotal(pricing.data!, amount), currency)} a year` : ""}</small></div>
              <ul>{c.features.slice(0, 3).map((i) => <li key={i}>{i}</li>)}</ul>
            </button>
          );
        })}
      </div>
      {enterprise && <div className="ent-row"><div><h4 style={{ fontSize: 17 }}>{enterprise.name}</h4><span>{enterprise.description}</span></div><a className="btn btn-secondary" href={`mailto:${CONTACT_EMAIL}`}>Talk to us</a></div>}
      <p className="field-hint" style={{ marginTop: 12 }}>No payment needed now. {plan !== "free" ? "You'll start on Free and can add payment details to upgrade from Settings → Plan and billing." : ""}</p>
      <div className="wz-foot">
        <Link to="/setup/branding" className="link row"><ArrowLeft size={15} />Back</Link>
        <div className="r"><Button size="lg" loading={busy} onClick={go}>{plan === "free" ? "Continue with Free" : "Continue"} <ArrowRight size={16} /></Button></div>
      </div>
    </Wizard>
  );
}

function Team() {
  const navigate = useNavigate();
  const refresh = useMeUpdater();
  const [rows, setRows] = useState([{ email: "", role: "member" }, { email: "", role: "member" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = async (send: boolean) => {
    setBusy(true); setError(null);
    try {
      const invites = rows.filter((r) => r.email.trim());
      if (send && invites.length) await api.post("/api/invitations", { invites });
      await api.post("/api/org/setup-step", { step: "done" });
      // Go to the final screen first; refreshing marks setup complete, which would otherwise redirect to Overview.
      navigate("/setup/done");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? (e.details ? "Check the email addresses." : e.message) : "Something went wrong.");
    } finally { setBusy(false); }
  };
  return (
    <Wizard step="team">
      <h1>Invite your team.</h1>
      <p className="sub">Add the people you work with. They'll get an email to join on WindVeal.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="stack" style={{ gap: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr) 40px", gap: 10, alignItems: "center" }}>
            <Input type="email" placeholder="colleague@email.com" aria-label="Email" value={r.email} onChange={(e) => setRows(rows.map((x, k) => k === i ? { ...x, email: e.target.value } : x))} />
            <Select aria-label="Role" value={r.role} onChange={(e) => setRows(rows.map((x, k) => k === i ? { ...x, role: e.target.value } : x))}
              options={[{ value: "admin", label: "Admin" }, { value: "manager", label: "Manager" }, { value: "member", label: "Member" }]} />
            <IconButton label="Remove" onClick={() => setRows(rows.filter((_, k) => k !== i))}><X size={16} /></IconButton>
          </div>
        ))}
      </div>
      <button className="link row" style={{ marginTop: 12 }} onClick={() => setRows([...rows, { email: "", role: "member" }])}><Plus size={15} />Add another</button>
      <div className="wz-group">
        <h3>What each role can do</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
          {[["Admin", "Manage members, settings and billing."], ["Manager", "Run their team's work and approve requests."], ["Member", "Work in the workspaces they're given."]].map(([t, d]) => (
            <div key={t} style={{ background: "var(--soft)", borderRadius: 14, padding: 14, fontSize: 13.5 }}><b className="ink" style={{ display: "block" }}>{t}</b>{d}</div>
          ))}
        </div>
        <p className="field-hint" style={{ marginTop: 10 }}>You can fine-tune what each person sees later in Settings.</p>
      </div>
      <div className="wz-foot">
        <Link to="/setup/plan" className="link row"><ArrowLeft size={15} />Back</Link>
        <div className="r"><button className="link" onClick={() => finish(false)}>Skip for now</button><Button size="lg" loading={busy} onClick={() => finish(true)}>Send invites <ArrowRight size={16} /></Button></div>
      </div>
    </Wizard>
  );
}

function Done() {
  const { data: me } = useMe();
  return (
    <Wizard step="done">
      <div style={{ textAlign: "center", maxWidth: 620, margin: "0 auto" }}>
        <span style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--ok-bg)", color: "var(--ok)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}><Check size={34} strokeWidth={3} /></span>
        <h1>You're all set, {me?.user?.name.split(" ")[0]}.</h1>
        <p className="sub" style={{ margin: "0 auto 28px" }}>{me?.org?.name} is ready on WindVeal. Here's what happens next.</p>
        <div style={{ textAlign: "left" }}>
          <Notice tone="warn" icon={<Clock size={20} />}><b>We're verifying {me?.org?.name}.</b> This usually takes 1 to 2 working days. You can use WindVeal straight away. Your public careers page goes live once you're verified.</Notice>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, textAlign: "left", margin: "8px 0 28px" }}>
          {[["Import your data", "Bring in staff, client or job spreadsheets.", "/import"], ["Set up your team", "Add departments and people.", "/people"], ["Explore the workspaces", "See what each part of WindVeal can do.", "/"]].map(([t, d, h]) => (
            <Link key={t} to={h!} className="card" style={{ padding: 16 }}><b className="ink" style={{ display: "block" }}>{t}</b><span style={{ fontSize: 13.5 }}>{d}</span></Link>
          ))}
        </div>
        <Link to="/" className="btn btn-primary btn-lg">Go to my workspace <ArrowRight size={16} /></Link>
      </div>
    </Wizard>
  );
}

export function SetupRoutes() {
  const { data: me } = useMe();
  const step = me?.org?.setupStep ?? "details";
  return (
    <Routes>
      <Route index element={<Navigate to={me?.org ? `/setup/${step === "done" ? "done" : step}` : "/setup/details"} replace />} />
      <Route path="details" element={<Details />} />
      <Route path="role" element={me?.org ? <Role /> : <Navigate to="/setup/details" replace />} />
      <Route path="branding" element={me?.org ? <Branding /> : <Navigate to="/setup/details" replace />} />
      <Route path="plan" element={me?.org ? <Plan /> : <Navigate to="/setup/details" replace />} />
      <Route path="team" element={me?.org ? <Team /> : <Navigate to="/setup/details" replace />} />
      <Route path="done" element={<Done />} />
      <Route path="*" element={<Navigate to="/setup" replace />} />
    </Routes>
  );
}

export type { Me };
