import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { MarketingLayout, Benefits, CtaBand, ArrowLink } from "../components/Layout";
import { AppShot, BarChartMock, DashboardMock, Folders, MiniDeals, MiniPeople, MiniPipeline, MiniTasks } from "../components/Mocks";
import { DOWNLOAD_PATH, useTitle } from "../lib/site";

export function PageHero({ title, accent, children, accentBreak }: { title: string; accent: string; children: ReactNode; accentBreak?: boolean }) {
  return (
    <section className="page-hero">
      <div className="container">
        <h1>
          {title} {accentBreak && <br className="hide-mobile" />}
          <span className="accent">{accent}</span>
        </h1>
        <p className="lede">{children}</p>
        <div className="hero-buttons">
          <Link to={DOWNLOAD_PATH} className="btn btn-primary btn-lg">
            Download WindVeal <ArrowRight size={16} aria-hidden />
          </Link>
          <Link to="/pricing" className="btn btn-secondary btn-lg">
            See pricing
          </Link>
        </div>
      </div>
    </section>
  );
}

const ROWS: { n: string; name: string; text: string; to: string; visual: ReactNode; dark?: boolean }[] = [
  { n: "01", name: "Recruitment", text: "Post jobs, collect applications and move every candidate forward from one simple pipeline.", to: "/product/recruitment", visual: <MiniPipeline /> },
  { n: "02", name: "People & HR", text: "Keep every employee record, leave request and attendance log in one place your whole HR team can trust.", to: "/product/people-hr", visual: <MiniPeople /> },
  { n: "03", name: "CRM", text: "Track companies, contacts, leads and deals in one place, so no client or follow-up slips through.", to: "/product/crm", visual: <MiniDeals />, dark: true },
  { n: "04", name: "Workflows", text: "Assign tasks, set deadlines and handle approvals across every part of your business.", to: "/product/workflows", visual: <MiniTasks /> },
  { n: "05", name: "Documents", text: "Store, organise and share your business documents securely, with access set by role.", to: "/product/documents", visual: <Folders /> },
  { n: "06", name: "Insights", text: "Get clear dashboards and reports built from the work your team already does in WindVeal.", to: "/product/insights", visual: <BarChartMock /> },
];

export default function Product() {
  useTitle("Product · WindVeal");
  return (
    <MarketingLayout>
      <PageHero title="One platform." accent="Six workspaces.">
        Everything your business runs on, connected, so your team works from the same people, files and records.
      </PageHero>

      <section className="container shot-section">
        <AppShot active="Overview" label="The WindVeal overview: team, deals, open roles and tasks due today.">
          <DashboardMock rows={4} />
        </AppShot>
      </section>

      <section className="section">
        <div className="container">
          {ROWS.map((r, i) => (
            <div key={r.n} className={`ws-row${i % 2 ? " flip" : ""}`}>
              <div className="ws-row-text">
                <span className="ws-num">{r.n}</span>
                <h2>{r.name}</h2>
                <p>{r.text}</p>
                <ArrowLink to={r.to}>Explore {r.name}</ArrowLink>
              </div>
              <div className={`ws-row-visual${r.dark ? " dark" : ""}`} aria-hidden>
                {r.visual}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section section-tight">
        <div className="container">
          <h2 className="section-title">Better together.</h2>
          <Benefits
            items={[
              { title: "A hire becomes an employee", text: "Recruitment hands new starters straight to People & HR." },
              { title: "A deal becomes a client", text: "CRM keeps the whole relationship, files and tasks in one place." },
              { title: "Every number is real", text: "Insights reports on the work your team actually does." },
            ]}
          />
        </div>
      </section>

      <CtaBand />
    </MarketingLayout>
  );
}
