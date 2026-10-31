import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, KeyRound, Mail, MailCheck, UserPlus } from "lucide-react";
import { BrandLogo, Button, Checkbox, Input, Loading, Notice, PasswordInput } from "@windveal/ui";
import { api, ApiError } from "../../lib/api";

import { ME_KEY, useMe, type Me } from "../../lib/session";
import { useForm } from "../../lib/form";
import { useSignOut } from "../../lib/signout";

function AuthLayout({ children, photo, aside }: { children: ReactNode; photo: string; aside: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-form">
        <Link to="/welcome" className="logo" aria-label="WindVeal"><BrandLogo height={40} /></Link>
        <div className="auth-box page-enter">{children}</div>
        <div className="auth-legal"><span>© {new Date().getFullYear()} WindVeal</span><span>Privacy · Terms</span></div>
      </div>
      <div className="auth-photo" style={{ backgroundImage: `linear-gradient(0deg,rgba(14,28,69,.95) 0%,rgba(14,28,69,.55) 45%,rgba(14,28,69,.1) 75%),url(${photo})` }}>
        {aside}
      </div>
    </div>
  );
}

function SoloLayout({ children, topRight }: { children: ReactNode; topRight?: ReactNode }) {
  return (
    <div className="solo">
      <div className="solo-top"><Link to="/welcome" aria-label="WindVeal"><BrandLogo height={38} /></Link>{topRight}</div>
      <div className="solo-card page-enter">{children}</div>
    </div>
  );
}

function useAfterAuth() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (me: Me) => {
    qc.setQueryData(ME_KEY, me);
    const next = params.get("next");
    if (!me.user?.emailVerified) {
      // Remember where to go after verification (e.g. back to an invitation link).
      try { if (next) sessionStorage.setItem("wv-next", next); } catch { /* ignore */ }
      return navigate("/verify-email");
    }
    navigate(next && next.startsWith("/") ? next : "/");
  };
}

export function SignIn() {
  const f = useForm({ email: "", password: "", remember: true });
  const after = useAfterAuth();
  useEffect(() => { document.title = "Sign in · WindVeal"; }, []);
  return (
    <AuthLayout photo="/images/hero.jpg" aside={<><h2>Your business, <span>in one place.</span></h2><p>Pick up right where you left off.</p></>}>
      <h1>Welcome back.</h1>
      <p className="sub">Sign in to your WindVeal account.</p>
      <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => after(await api.post<Me>("/api/auth/login", v))); }}>
        <Input label="Email" type="email" autoComplete="email" autoFocus {...f.bind("email")} />
        <div className="field">
          <div className="between"><label className="field-label" htmlFor="pw">Password</label><Link to="/forgot-password" className="link" style={{ fontSize: 13 }}>Forgot password?</Link></div>
          <PasswordInput id="pw" autoComplete="current-password" {...f.bind("password")} />
        </div>
        <Checkbox label="Keep me signed in on this computer" checked={f.values.remember} onChange={(e) => f.set("remember", e.target.checked)} />
        <Button type="submit" size="lg" block loading={f.busy}>Sign in <ArrowRight size={16} /></Button>
      </form>
      <p className="swap">New to WindVeal? <Link to="/create-account" className="link">Create an account</Link></p>
      <Link to="/invited" className="invited-link"><MailCheck size={18} /><span><b>Invited by your employer?</b><small>Join with the email your invite was sent to.</small></span><ArrowRight size={16} /></Link>
    </AuthLayout>
  );
}

const RULES: [string, (s: string) => boolean][] = [
  ["At least 10 characters", (s) => s.length >= 10],
  ["One number", (s) => /[0-9]/.test(s)],
  ["One uppercase letter", (s) => /[A-Z]/.test(s)],
  ["One symbol", (s) => /[^A-Za-z0-9]/.test(s)],
];

function PasswordRules({ value }: { value: string }) {
  const passed = RULES.filter(([, t]) => t(value)).length;
  return (
    <>
      <div className="pw-meter" aria-hidden>{RULES.map((_, i) => <i key={i} className={i < passed ? "on" : ""} />)}</div>
      <div className="pw-rules">{RULES.map(([label, t]) => <span key={label} className={t(value) ? "ok" : ""}><Check size={13} strokeWidth={3} />{label}</span>)}</div>
    </>
  );
}

export function CreateAccount() {
  const [params] = useSearchParams();
  const f = useForm({ name: "", email: params.get("email") ?? "", password: "", acceptTerms: false });
  const after = useAfterAuth();
  useEffect(() => { document.title = "Create account · WindVeal"; }, []);
  return (
    <AuthLayout photo="/images/about.jpg" aside={<>
      <h2>Set up in <span>minutes.</span></h2>
      <div className="auth-steps">
        <div className="on"><b>1</b>Create your account</div><div><b>2</b>Verify your email</div>
        <div><b>3</b>Set up your business</div><div><b>4</b>Invite your team</div>
      </div>
    </>}>
      <h1>Create your account.</h1>
      <p className="sub">Start with your own account. You'll set up your business next.</p>
      <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => after(await api.post<Me>("/api/auth/register", v))); }}>
        <Input label="Full name" autoComplete="name" autoFocus {...f.bind("name")} />
        <Input label="Email" type="email" autoComplete="email" {...f.bind("email")} />
        <div className="field">
          <PasswordInput label="Password" autoComplete="new-password" {...f.bind("password")} />
          <PasswordRules value={f.values.password} />
        </div>
        <div className="field">
          <Checkbox label={<>I agree to the <a className="link" href="#">Terms</a> and <a className="link" href="#">Privacy Policy</a>.</>}
            checked={f.values.acceptTerms} onChange={(e) => f.set("acceptTerms", e.target.checked)} />
          {f.errors.acceptTerms && <span className="field-error">{f.errors.acceptTerms}</span>}
        </div>
        <Button type="submit" size="lg" block loading={f.busy}>Create account <ArrowRight size={16} /></Button>
      </form>
      <p className="swap">Already have an account? <Link to="/sign-in" className="link">Sign in</Link></p>
      <Link to="/invited" className="invited-link"><MailCheck size={18} /><span><b>Invited by your employer?</b><small>Join with the email your invite was sent to.</small></span><ArrowRight size={16} /></Link>
    </AuthLayout>
  );
}

/** Joining from an invitation without its link: email → code → name and password → straight into WindVeal. */
export function Invited() {
  const [step, setStep] = useState<"email" | "code" | "account">("email");
  const [invite, setInvite] = useState<{ orgName: string; role: string; invitedBy: string } | null>(null);
  const f = useForm({ email: "", code: "", name: "", password: "" });
  const after = useAfterAuth();
  useEffect(() => { document.title = "Join your team · WindVeal"; }, []);
  const steps = ["Your email", "Confirm it's you", "Set your password"];
  const current = step === "email" ? 0 : step === "code" ? 1 : 2;
  return (
    <AuthLayout photo="/images/team.jpg" aside={<>
      <h2>Join <span>your team.</span></h2>
      <div className="auth-steps">
        {steps.map((s, i) => <div key={s} className={i <= current ? "on" : ""}><b>{i < current ? <Check size={13} strokeWidth={3} /> : i + 1}</b>{s}</div>)}
      </div>
    </>}>
      {step === "email" && <>
        <h1>Invited to WindVeal?</h1>
        <p className="sub">Enter the email address your invitation was sent to. We'll send you a code to confirm it's you.</p>
        <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => { await api.post("/api/invited/start", { email: v.email }); setStep("code"); }); }}>
          <Input label="Email" type="email" autoComplete="email" autoFocus {...f.bind("email")} />
          <Button type="submit" size="lg" block loading={f.busy}>Send code <ArrowRight size={16} /></Button>
        </form>
      </>}
      {step === "code" && <>
        <h1>Check your email.</h1>
        <p className="sub">If there's an invitation for <b className="ink">{f.values.email}</b>, we've sent it a 6-digit code. Already have an account? We've emailed you a link to sign in instead.</p>
        <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => {
          setInvite(await api.post("/api/invited/verify", { email: v.email, code: v.code }));
          setStep("account");
        }); }}>
          <Input label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus {...f.bind("code")} />
          <Button type="submit" size="lg" block loading={f.busy}>Continue <ArrowRight size={16} /></Button>
        </form>
        <p className="swap"><button className="link" onClick={() => { f.set("code", ""); setStep("email"); }}>Use a different email</button></p>
      </>}
      {step === "account" && invite && <>
        <h1>Welcome to {invite.orgName}.</h1>
        <p className="sub">{invite.invitedBy} invited you to join as {invite.role}. Set up your account to get started.</p>
        <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => after(await api.post<Me>("/api/invited/complete", v))); }}>
          <Input label="Email" value={f.values.email} disabled readOnly />
          <Input label="Full name" autoComplete="name" autoFocus {...f.bind("name")} />
          <div className="field">
            <PasswordInput label="Password" autoComplete="new-password" {...f.bind("password")} />
            <PasswordRules value={f.values.password} />
          </div>
          <Button type="submit" size="lg" block loading={f.busy}>Join {invite.orgName} <ArrowRight size={16} /></Button>
        </form>
      </>}
      <p className="swap">Not invited? <Link to="/create-account" className="link">Create an account</Link> · <Link to="/sign-in" className="link">Sign in</Link></p>
    </AuthLayout>
  );
}

export function VerifyEmail() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(45);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => { document.title = "Verify your email · WindVeal"; }, []);
  useEffect(() => { const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000); return () => clearInterval(t); }, []);
  if (isLoading) return <Loading />;
  if (!me?.user) { navigate("/sign-in"); return null; }
  if (me.user.emailVerified) { navigate("/"); return null; }

  const submit = async (code: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<Me>("/api/auth/verify-email", { code });
      qc.setQueryData(ME_KEY, r);
      let next: string | null = null;
      try { next = sessionStorage.getItem("wv-next"); sessionStorage.removeItem("wv-next"); } catch { /* ignore */ }
      navigate(next && next.startsWith("/") ? next : "/setup");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
      setDigits(["", "", "", "", "", ""]);
      refs.current[0]?.focus();
    } finally { setBusy(false); }
  };
  const setDigit = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) {
      const all = clean.slice(0, 6).split("");
      const next = [...digits]; all.forEach((d, k) => { if (i + k < 6) next[i + k] = d; });
      setDigits(next);
      if (next.every(Boolean)) submit(next.join(""));
      else refs.current[Math.min(5, i + all.length)]?.focus();
      return;
    }
    const next = [...digits]; next[i] = clean; setDigits(next);
    if (clean && i < 5) refs.current[i + 1]?.focus();
    if (next.every(Boolean)) submit(next.join(""));
  };
  const signOut = useSignOut();
  return (
    <SoloLayout topRight={<><button className="link" onClick={signOut.ask}>Sign out</button>{signOut.dialog}</>}>
      <span className="ic"><Mail size={28} /></span>
      <h1>Check your email.</h1>
      <p className="sub">We sent a 6-digit code to <b className="ink">{me.user.email}</b>. Enter it below to verify your email.</p>
      {changing ? (
        <form onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { qc.setQueryData(ME_KEY, await api.post<Me>("/api/auth/change-email", { email: newEmail })); setChanging(false); setCooldown(45); }
          catch (err) { setError(err instanceof ApiError ? err.message : "Something went wrong."); }
        }}>
          {error && <Notice tone="error">{error}</Notice>}
          <Input label="New email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoFocus />
          <Button type="submit" block>Send code to this email</Button>
          <button type="button" className="link" onClick={() => setChanging(false)}>Cancel</button>
        </form>
      ) : (
        <>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="code-boxes" onPaste={(e) => { e.preventDefault(); setDigit(0, e.clipboardData.getData("text")); }}>
            {digits.map((d, i) => (
              <span key={i} style={{ display: "contents" }}>
                {i === 3 && <span className="gap" />}
                <input ref={(el) => { refs.current[i] = el; }} value={d} inputMode="numeric" maxLength={6} aria-label={`Digit ${i + 1}`} autoFocus={i === 0}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus(); }} />
              </span>
            ))}
          </div>
          <Button block size="lg" loading={busy} disabled={digits.some((d) => !d)} onClick={() => submit(digits.join(""))}>Verify email <ArrowRight size={16} /></Button>
          <p className="muted" style={{ marginTop: 20, fontSize: 14 }}>
            Didn't get it? Check your spam folder or{" "}
            {cooldown > 0 ? <>resend the code in 0:{String(cooldown).padStart(2, "0")}.</> :
              <button className="link" onClick={async () => { await api.post("/api/auth/resend-code"); setCooldown(45); }}>resend the code</button>}
          </p>
          <button className="link" style={{ marginTop: 18, display: "inline-flex", gap: 6, alignItems: "center" }} onClick={() => setChanging(true)}><ArrowLeft size={15} />Use a different email</button>
          {import.meta.env.DEV && <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>Testing locally? Your code is in the <Link className="link" to="/dev/mailbox" target="_blank">dev mailbox</Link>.</p>}
        </>
      )}
    </SoloLayout>
  );
}

export function ForgotPassword() {
  const f = useForm({ email: "" });
  const [sent, setSent] = useState(false);
  useEffect(() => { document.title = "Reset password · WindVeal"; }, []);
  return (
    <SoloLayout topRight={<Link to="/sign-in" className="link">Sign in</Link>}>
      <span className="ic"><KeyRound size={28} /></span>
      {sent ? (
        <>
          <h1>Check your email.</h1>
          <p className="sub">If <b className="ink">{f.values.email}</b> has a WindVeal account, we've sent a link to reset the password. It works for 1 hour.</p>
          {import.meta.env.DEV && <p className="muted" style={{ fontSize: 12.5 }}>Testing locally? Open the <Link className="link" to="/dev/mailbox" target="_blank">dev mailbox</Link>.</p>}
          <Link to="/sign-in" className="link" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginTop: 20 }}><ArrowLeft size={15} />Back to sign in</Link>
        </>
      ) : (
        <>
          <h1>Forgot your password?</h1>
          <p className="sub">Enter the email you use for WindVeal and we'll send you a link to reset it.</p>
          <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => { await api.post("/api/auth/forgot-password", v); setSent(true); }); }}>
            <Input label="Email" type="email" autoFocus {...f.bind("email")} />
            <Button type="submit" size="lg" block loading={f.busy}>Send reset link <ArrowRight size={16} /></Button>
          </form>
          <Link to="/sign-in" className="link" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginTop: 20 }}><ArrowLeft size={15} />Back to sign in</Link>
        </>
      )}
    </SoloLayout>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const f = useForm({ password: "" });
  const [done, setDone] = useState(false);
  return (
    <SoloLayout>
      <span className="ic"><KeyRound size={28} /></span>
      {done ? (
        <>
          <h1>Password updated.</h1>
          <p className="sub">For your security we signed you out on every device. Sign in with your new password.</p>
          <Link to="/sign-in" className="btn btn-primary btn-lg btn-block">Sign in</Link>
        </>
      ) : (
        <>
          <h1>Choose a new password.</h1>
          <p className="sub">Make it something you don't use anywhere else.</p>
          <form noValidate onSubmit={(e) => { e.preventDefault(); f.submit(async (v) => { await api.post("/api/auth/reset-password", { token, password: v.password }); setDone(true); }); }}>
            <div className="field">
              <PasswordInput label="New password" autoFocus autoComplete="new-password" {...f.bind("password")} />
              <PasswordRules value={f.values.password} />
            </div>
            <Button type="submit" size="lg" block loading={f.busy}>Update password</Button>
          </form>
        </>
      )}
    </SoloLayout>
  );
}

export function AcceptInvite() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const inv = useQuery({ queryKey: ["invite", token], queryFn: () => api.get(`/api/invite/${token}`), retry: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (inv.isLoading) return <Loading />;
  if (inv.isError || !inv.data) {
    return <SoloLayout><span className="ic"><UserPlus size={28} /></span><h1>Invitation not found.</h1><p className="sub">This link isn't valid. Ask your admin to send a new invitation.</p></SoloLayout>;
  }
  const d = inv.data;
  const accept = async () => {
    setBusy(true); setError(null);
    try { qc.setQueryData(ME_KEY, await api.post<Me>(`/api/invite/${token}/accept`)); navigate("/"); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  };
  const signedInAsInvitee = me?.user && me.user.email === d.email;
  return (
    <SoloLayout>
      <span className="ic"><UserPlus size={28} /></span>
      <h1>Join {d.orgName}</h1>
      <p className="sub">{d.invitedBy} invited <b className="ink">{d.email}</b> to join {d.orgName} on WindVeal as {d.role === "admin" ? "an admin" : `a ${d.role}`}.</p>
      {d.expired ? <Notice tone="warn">This invitation has expired. Ask {d.invitedBy} to send a new one.</Notice>
        : d.accepted ? <Notice tone="info">This invitation has already been used. <Link className="link" to="/sign-in">Sign in</Link></Notice>
        : signedInAsInvitee ? (
          !me!.user!.emailVerified ? <Notice tone="info">Verify your email first. <Link className="link" to="/verify-email">Verify now</Link></Notice> : (
            <>
              {error && <Notice tone="error">{error}</Notice>}
              <Button size="lg" block loading={busy} onClick={accept}>Accept and join</Button>
            </>
          )
        ) : me?.user ? (
          <Notice tone="warn">You're signed in as {me.user.email}. Sign out and sign in as {d.email} to accept.</Notice>
        ) : (
          <div className="stack">
            <Link className="btn btn-primary btn-lg btn-block" to={d.hasAccount ? `/sign-in?next=/invite/${token}` : `/create-account?email=${encodeURIComponent(d.email)}&next=/invite/${token}`}>
              {d.hasAccount ? "Sign in to accept" : "Create your account to accept"}
            </Link>
            <p className="muted" style={{ fontSize: 13.5 }}>After verifying your email, open this invitation link again to join.</p>
          </div>
        )}
    </SoloLayout>
  );
}
