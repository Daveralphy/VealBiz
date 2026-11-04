import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandLogo, Button, useToast } from "@windveal/ui";
import { api, ApiError } from "../lib/api";
import { useSetMe, type Me } from "../lib/session";
import { useSignOut } from "../lib/signout";
import { SUPPORT_EMAIL } from "../lib/config";

/** The app's front door: where WindVeal opens for someone who isn't signed in (and where the desktop app starts). */
export function Welcome() {
  useEffect(() => { document.title = "Welcome · WindVeal"; }, []);
  return (
    <div className="welcome">
      <div className="welcome-photo" aria-hidden />
      <div className="welcome-in page-enter">
        <BrandLogo height={44} tone="light" />
        <div className="welcome-copy">
          <h1>Welcome to <span>WindVeal.</span></h1>
          <p>Your people, customers, documents and daily work, together in one place.</p>
        </div>
        <div className="welcome-actions">
          <Link to="/create-account" className="btn btn-light btn-lg">Create an account<ArrowRight size={18} /></Link>
          <Link to="/sign-in" className="btn btn-outline-light btn-lg">Sign in</Link>
        </div>
        <Link to="/invited" className="welcome-note">Invited by your employer? <b>Join your team</b> <ArrowRight size={14} /></Link>
      </div>
      <p className="welcome-foot">© {new Date().getFullYear()} WindVeal</p>
    </div>
  );
}

/** Shown instead of the workspace when WindVeal has suspended or closed the organisation's account. */
export function AccountPaused({ orgName, status, reason }: { orgName: string; status: "suspended" | "closed"; reason: string | null }) {
  const signOut = useSignOut();
  useEffect(() => { document.title = "Account unavailable · WindVeal"; }, []);
  return (
    <div className="welcome">
      <div className="welcome-photo" aria-hidden />
      <div className="welcome-in page-enter">
        <BrandLogo height={44} tone="light" />
        <div className="welcome-copy">
          <h1>{orgName}'s account is <span>{status === "closed" ? "closed." : "paused."}</span></h1>
          <p>{reason ? `${reason}. ` : ""}Your data is safe. Contact WindVeal support to get access back.</p>
        </div>
        <div className="welcome-actions">
          <a href={`mailto:${SUPPORT_EMAIL}`} className="btn btn-light btn-lg">Contact support</a>
          <button className="btn btn-outline-light btn-lg" onClick={signOut.ask}>Sign out</button>
        </div>
      </div>
      {signOut.dialog}
    </div>
  );
}

/** Shown to someone who signed up with an email that was invited to a business: one click to join it. */
export function JoinInvitation({ invite }: { invite: NonNullable<Me["pendingInvitation"]> }) {
  const signOut = useSignOut();
  const setMe = useSetMe();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = `Join ${invite.orgName} · WindVeal`; }, [invite.orgName]);
  const join = async () => {
    setBusy(true);
    try { setMe(await api.post<Me>("/api/invitations/accept-waiting")); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't join just now", "error"); setBusy(false); }
  };
  return (
    <div className="welcome">
      <div className="welcome-photo" aria-hidden />
      <div className="welcome-in page-enter">
        <BrandLogo height={44} tone="light" />
        <div className="welcome-copy">
          <h1>You're invited to <span>{invite.orgName}.</span></h1>
          <p>{invite.invitedBy ? `${invite.invitedBy} invited you` : "You've been invited"} to join as {invite.roleName === "Admin" ? "an admin" : invite.roleName}. You'll see what your role allows as soon as you join.</p>
        </div>
        <div className="welcome-actions">
          <Button className="btn-light btn-lg" loading={busy} onClick={join}>Join {invite.orgName}</Button>
          <button className="btn btn-outline-light btn-lg" onClick={signOut.ask}>Sign out</button>
        </div>
      </div>
      {signOut.dialog}
    </div>
  );
}
