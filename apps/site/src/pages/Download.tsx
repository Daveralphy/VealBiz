import { ArrowRight, Globe, Monitor, Smartphone } from "lucide-react";
import { MarketingLayout } from "../components/Layout";
import { WEB_APP_URL, useTitle } from "../lib/site";

const PLATFORMS = [
  { icon: Monitor, name: "Windows", text: "The WindVeal desktop app for Windows computers.", status: "Coming soon" },
  { icon: Smartphone, name: "Android", text: "WindVeal on your Android phone, for work on the go.", status: "Coming soon" },
  { icon: Smartphone, name: "iPhone", text: "WindVeal on your iPhone, for work on the go.", status: "Coming soon" },
];

/** Where people get the WindVeal app. The website itself has no sign-in: everything happens in the app. */
export default function Download() {
  useTitle("Download WindVeal");
  return (
    <MarketingLayout>
      <section className="page-hero download-hero">
        <div className="container">
          <h1>
            Get <span className="accent">WindVeal.</span>
          </h1>
          <p className="lede">Set up your business, or join your team when your employer invites you. Everything happens in the WindVeal app.</p>
        </div>
      </section>
      <section className="container download-body">
        <div className="download-grid">
          {PLATFORMS.map((p) => (
            <article key={p.name} className="download-card">
              <span className="download-icon"><p.icon size={24} aria-hidden /></span>
              <h2>{p.name}</h2>
              <p>{p.text}</p>
              <span className="download-soon">{p.status}</span>
            </article>
          ))}
        </div>
        <div className="download-web">
          <span className="download-icon"><Globe size={24} aria-hidden /></span>
          <div>
            <h2>Use WindVeal in your browser</h2>
            <p>Until the apps are ready, WindVeal works in any up-to-date browser: same account, same everything.</p>
          </div>
          <a href={WEB_APP_URL} className="btn btn-primary btn-lg">
            Open WindVeal <ArrowRight size={16} aria-hidden />
          </a>
        </div>
        <p className="download-note">Invited by your employer? Sign in with the email address your invitation was sent to.</p>
      </section>
    </MarketingLayout>
  );
}
