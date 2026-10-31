import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, SearchX } from "lucide-react";
import { brandVars, websiteHref, type ApiError, type CareersOrg } from "./api";

export function OrgLogo({ org, size = 40, className = "" }: { org: CareersOrg; size?: number; className?: string }) {
  return (
    <span className={`org-logo ${org.logoUrl ? "has-img" : ""} ${className}`} style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {org.logoUrl ? <img src={org.logoUrl} alt={`${org.name} logo`} /> : <span aria-hidden>{org.name.trim().charAt(0).toUpperCase()}</span>}
    </span>
  );
}

export function CareersLayout({ org, children }: { org: CareersOrg; children: ReactNode }) {
  return (
    <div className="careers" style={brandVars(org.brandColor) as CSSProperties}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="careers-header">
        <div className="careers-container careers-header-inner">
          <Link to={`/careers/${org.slug}`} className="careers-brand">
            <OrgLogo org={org} size={40} />
            <span>
              <b>{org.name}</b> <span className="careers-word">Careers</span>
            </span>
          </Link>
          {org.website && (
            <a href={websiteHref(org.website)} className="careers-site-link" target="_blank" rel="noopener noreferrer">
              Visit our website <ArrowUpRight size={15} aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      </header>
      <main id="main">{children}</main>
      <CareersFooter name={org.name} />
    </div>
  );
}

function CareersFooter({ name }: { name?: string }) {
  return (
    <footer className="careers-footer">
      <div className="careers-container careers-footer-inner">
        <span>{name ? `© ${new Date().getFullYear()} ${name}` : ""}</span>
        <span>
          Careers page powered by{" "}
          <Link to="/" className="powered">
            WindVeal
          </Link>
        </span>
      </div>
    </footer>
  );
}

/** Shown while loading, when the page isn't live (404) or on other errors. Has no company branding. */
export function CareersState({ state, error, onRetry }: { state: "loading" | "error"; error?: ApiError; onRetry?: () => void }) {
  const notFound = error && error.status === 404;
  return (
    <div className="careers careers-plain" style={brandVars(null) as CSSProperties}>
      <main id="main" className="careers-state">
        {state === "loading" ? (
          <div className="spinner" role="status" aria-label="Loading" />
        ) : notFound ? (
          <div className="careers-empty">
            <span className="careers-empty-icon">
              <SearchX size={26} aria-hidden />
            </span>
            <h1>This careers page isn't available</h1>
            <p>The link may be out of date, or the company may have closed its careers page for now.</p>
            <Link to="/" className="btn btn-secondary">
              Go to WindVeal
            </Link>
          </div>
        ) : (
          <div className="careers-empty">
            <h1>Something went wrong</h1>
            <p>{error?.message ?? "Please try again."}</p>
            {onRetry && (
              <button type="button" className="btn btn-secondary" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
      </main>
      <CareersFooter />
    </div>
  );
}
