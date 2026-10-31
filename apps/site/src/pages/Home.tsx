import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { MarketingLayout, Benefits, ArrowLink } from "../components/Layout";
import { AppShot, DashboardMock } from "../components/Mocks";
import { DOWNLOAD_PATH, useTitle } from "../lib/site";

function TileHead({ title, text, to }: { title: string; text: string; to: string }) {
  return (
    <>
      <h3>{title}</h3>
      <p>{text}</p>
      <Link to={to} className="tile-link">
        Learn more <span aria-hidden>→</span>
        <span className="sr-only"> about {title}</span>
      </Link>
    </>
  );
}

export default function Home() {
  useTitle("WindVeal · Your business, in one place");
  return (
    <MarketingLayout overlayHeader>
      <section className="hero">
        <div className="hero-media" aria-hidden>
          <img src="/images/hero.jpg" alt="" />
        </div>
        <div className="container hero-content">
          <h1>
            Your business,
            <br />
            <span>in one place.</span>
          </h1>
          <p>
            <b>WindVeal Biz Platform</b> brings your people, customers, documents and daily work into one simple workspace for your whole team.
          </p>
          <div className="hero-actions">
<Link to={DOWNLOAD_PATH} className="btn btn-light btn-lg">
              Get started <ArrowRight size={16} aria-hidden />
            </Link>
            <Link to="/product" className="btn btn-text-light btn-lg">
              Explore the product <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head split">
            <h2>
              Everything your
              <br className="hide-mobile" /> business runs on.
            </h2>
            <ArrowLink to="/product">Explore all workspaces</ArrowLink>
          </div>
          <div className="bento">
            <article className="tile tile-wide tile-pale">
              <TileHead title="People & HR" text="Your team's records, leave and attendance, always up to date." to="/product/people-hr" />
              <div className="tile-visual tile-people" aria-hidden>
                <div className="m-row m-row-card">
                  <span className="m-av">AO</span>
                  <span className="grow">
                    <b>Amaka Okafor</b>
                    <small>Finance · Accounts Officer</small>
                  </span>
                  <span className="m-tag m-ok">Active</span>
                </div>
                <div className="m-row m-row-card">
                  <span className="m-av m-av-warm">KM</span>
                  <span className="grow">
                    <b>Kofi Mensah</b>
                    <small>Sales · Team Lead</small>
                  </span>
                  <span className="m-tag m-warn">On leave</span>
                </div>
              </div>
            </article>
            <article className="tile tile-wide tile-navy">
              <TileHead title="CRM" text="Every client, lead and deal, from first call to signed contract." to="/product/crm" />
              <div className="tile-visual crm-stages" aria-hidden>
                {[
                  ["Leads", "24", 90],
                  ["Qualified", "11", 55],
                  ["Proposal", "6", 35],
                  ["Won", "4", 20],
                ].map(([l, n, w], i) => (
                  <div key={l as string} className="crm-stage">
                    <small>{l}</small>
                    <b>{n}</b>
                    <i style={{ width: `${w}%` }} className={i === 3 ? "won" : undefined} />
                  </div>
                ))}
              </div>
            </article>
            <article className="tile">
              <TileHead title="Recruitment" text="Post jobs and hire the right people." to="/product/recruitment" />
              <div className="tile-visual tile-chips" aria-hidden>
                <span>Applied</span>
                <span>Screening</span>
                <span className="on">Interview</span>
                <span>Offer</span>
              </div>
            </article>
            <article className="tile">
              <TileHead title="Workflows" text="Tasks and approvals that keep work moving." to="/product/workflows" />
              <div className="tile-visual tile-tasks" aria-hidden>
                <div className="m-row m-row-card done">
                  <i className="m-check on" />
                  <b>Send quote</b>
                </div>
                <div className="m-row m-row-card">
                  <i className="m-check" />
                  <b>Approve leave</b>
                </div>
              </div>
            </article>
            <article className="tile">
              <TileHead title="Documents" text="Every business file, safe and easy to find." to="/product/documents" />
              <div className="tile-visual tile-docs" aria-hidden>
                <div className="doc-card doc-back">
                  <b>Contract.pdf</b>
                  <small>Legal</small>
                  <i />
                  <i />
                </div>
                <div className="doc-card doc-front">
                  <b>Policy.docx</b>
                  <small>HR</small>
                  <i />
                  <i />
                </div>
              </div>
            </article>
            <article className="tile">
              <TileHead title="Insights" text="Clear reports on how the business is doing." to="/product/insights" />
              <div className="tile-visual tile-bars" aria-hidden>
                {[30, 50, 40, 65, 90].map((h, i) => (
                  <i key={i} style={{ height: `${h}%` }} className={i === 4 ? "on" : undefined} />
                ))}
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section section-tight">
        <div className="container">
          <div className="glance">
            <h2>See your whole business at a glance.</h2>
            <p>One home for the work, the people and the numbers that matter today.</p>
            <AppShot active="Overview" label="The WindVeal overview: team, deals, open roles and tasks due today." short>
              <DashboardMock rows={3} />
            </AppShot>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2 className="section-title narrow">Built for how your business really works.</h2>
          <Benefits
            items={[
              { title: "Everything in one place", text: "Stop switching between spreadsheets, chats and apps. Your whole team works from one place." },
              { title: "The right access for everyone", text: "Give each person the workspaces they need, and keep sensitive details like pay private." },
              { title: "Start with what you have", text: "Bring in the spreadsheets you already use and be up and running fast." },
            ]}
          />
        </div>
      </section>

      <section className="section section-last">
        <div className="container">
          <div className="photo-cta">
            <div className="photo-cta-text">
              <h2>Ready to bring it all together?</h2>
              <p>Set up your organisation in minutes and choose the plan that fits as you grow.</p>
              <div className="cta-actions">
                <Link to={DOWNLOAD_PATH} className="btn btn-primary btn-lg">
                  Get started <ArrowRight size={16} aria-hidden />
                </Link>
                <Link to="/pricing" className="btn btn-secondary btn-lg">
                  See pricing
                </Link>
              </div>
            </div>
            <div className="photo-cta-media">
              <img src="/images/team.jpg" alt="A team working together around a table" />
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
