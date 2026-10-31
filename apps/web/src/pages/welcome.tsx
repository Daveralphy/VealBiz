import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandLogo } from "@windveal/ui";

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
        <p className="welcome-note">Joining your team? Use the email your invitation was sent to.</p>
      </div>
      <p className="welcome-foot">© {new Date().getFullYear()} WindVeal</p>
    </div>
  );
}
