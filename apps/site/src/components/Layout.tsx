import { COMPANY_CAREERS_PATH } from "../lib/site";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Header, Logo } from "./Header";
import { DOWNLOAD_PATH } from "../lib/site";
import { WORKSPACE_LIST } from "../lib/workspaces";

export function MarketingLayout({ children, overlayHeader }: { children: ReactNode; overlayHeader?: boolean }) {
  return (
    <div className="site">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header overlay={overlayHeader} />
      <main id="main">{children}</main>
      <Footer />
    </div>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link to="/" aria-label="WindVeal home">
              <Logo light />
            </Link>
            <p>WindVeal Biz Platform. Your business, in one place.</p>
          </div>
          <div className="footer-col">
            <h2>Product</h2>
            <ul>
              {WORKSPACE_LIST.map((w) => (
                <li key={w.key}>
                  <Link to={w.path}>{w.name}</Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="footer-col">
            <h2>Company</h2>
            <ul>
              <li>
                <Link to="/about">About</Link>
              </li>
              <li>
                <Link to="/contact">Contact</Link>
              </li>
              <li>
                <Link to={COMPANY_CAREERS_PATH}>Careers at WindVeal</Link>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h2>Get the app</h2>
            <ul>
              <li>
                <Link to={DOWNLOAD_PATH}>Download</Link>
              </li>
              <li>
                <Link to="/pricing">Pricing</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} WindVeal. All rights reserved.</span>
          <span>
            <Link to="/contact">Privacy</Link> · <Link to="/contact">Terms</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}

type CtaAction = { label: string; href: string; external?: boolean };

function CtaLink({ action, className, arrow }: { action: CtaAction; className: string; arrow?: boolean }) {
  const content = (
    <>
      {action.label}
      {arrow && <ArrowRight size={16} aria-hidden />}
    </>
  );
  return action.external ? (
    <a href={action.href} className={className}>
      {content}
    </a>
  ) : (
    <Link to={action.href} className={className}>
      {content}
    </Link>
  );
}

/** Dark call-to-action band used at the bottom of most marketing pages. */
export function CtaBand({
  title = "Ready to bring it all together?",
  text = "Set up your organisation in minutes and choose the plan that fits as you grow.",
  primary = { label: "Download WindVeal", href: DOWNLOAD_PATH },
  secondary = { label: "See pricing", href: "/pricing" },
}: {
  title?: string;
  text?: string;
  primary?: CtaAction;
  secondary?: CtaAction;
}) {
  return (
    <section className="section-cta">
      <div className="container">
        <div className="cta-band">
          <div>
            <h2>{title}</h2>
            <p>{text}</p>
          </div>
          <div className="cta-actions">
            <CtaLink action={primary} className="btn btn-light btn-lg" arrow />
            <CtaLink action={secondary} className="btn btn-outline-light btn-lg" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Three-up list of benefits with a heavy rule above each. */
export function Benefits({ items }: { items: { title: string; text: string }[] }) {
  return (
    <div className="benefits">
      {items.map((b) => (
        <div key={b.title} className="benefit">
          <h3>{b.title}</h3>
          <p>{b.text}</p>
        </div>
      ))}
    </div>
  );
}

export function ArrowLink({ to, children, className = "" }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={`arrow-link ${className}`}>
      {children} <ArrowRight size={15} aria-hidden />
    </Link>
  );
}
