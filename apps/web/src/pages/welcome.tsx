import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandLogo } from "@windveal/ui";
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
