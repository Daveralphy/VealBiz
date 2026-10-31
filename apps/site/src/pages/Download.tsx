import { useMemo, type ComponentType } from "react";
import { ArrowDown, ArrowRight, Clock, Globe } from "lucide-react";
import { useToast } from "@windveal/ui";
import { MarketingLayout } from "../components/Layout";
import { AppShot, DashboardMock } from "../components/Mocks";
import { AndroidIcon, AppleIcon, LinuxIcon, WindowsIcon } from "../components/PlatformIcons";
import { DOWNLOADS, WEB_APP_URL, useTitle, type PlatformKey } from "../lib/site";

type Platform = { key: PlatformKey; name: string; icon: ComponentType<{ size?: number }>; needs: string; action: string; store?: string };

const DESKTOP: Platform[] = [
  { key: "windows", name: "Windows", icon: WindowsIcon, needs: "Windows 10 or later, 64-bit", action: "Download for Windows" },
  { key: "mac", name: "macOS", icon: AppleIcon, needs: "macOS 12 Monterey or later, Apple silicon and Intel", action: "Download for Mac" },
  { key: "linux", name: "Linux", icon: LinuxIcon, needs: "Ubuntu 22.04, Debian 12, Fedora 38 or later", action: "Download for Linux" },
];
const MOBILE: Platform[] = [
  { key: "android", name: "Android", icon: AndroidIcon, needs: "Android 9 or later", action: "Get it on", store: "Google Play" },
  { key: "ios", name: "iPhone and iPad", icon: AppleIcon, needs: "iOS and iPadOS 16 or later", action: "Download on the", store: "App Store" },
];
const ALL = [...DESKTOP, ...MOBILE];

/** Works out the visitor's platform from the browser, to offer the right download first. */
function detectPlatform(): PlatformKey {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Mac OS X|Macintosh/.test(ua)) return "mac";
  if (/Linux|X11/.test(ua)) return "linux";
  return "windows";
}

/** A download button: downloads when a build is published, otherwise says it's on the way. */
function useGetApp() {
  const toast = useToast();
  return (p: Platform) => {
    const url = DOWNLOADS[p.key];
    if (url) { window.location.href = url; return; }
    toast(`WindVeal for ${p.name} is almost ready. Until then, use WindVeal in your browser: same account, same everything.`);
  };
}

function PhoneMock() {
  return (
    <div className="phone" role="img" aria-label="WindVeal on a phone: clock in for the day and see today's tasks.">
      <div className="phone-screen">
        <div className="phone-notch" />
        <p className="phone-hi">Good morning, Amaka</p>
        <div className="phone-clock">
          <span><Clock size={14} aria-hidden /> Not clocked in</span>
          <b>08:57</b>
          <i>Clock in</i>
        </div>
        <p className="phone-label">Today</p>
        {["Approve leave for Kofi", "Call Northline Hotels", "Review 4 new applicants"].map((t) => (
          <div key={t} className="phone-task"><em />{t}</div>
        ))}
      </div>
    </div>
  );
}

function PlatformCard({ p, featured, onGet }: { p: Platform; featured: boolean; onGet: (p: Platform) => void }) {
  const ready = !!DOWNLOADS[p.key];
  return (
    <article className={`dl-card${featured ? " dl-card-you" : ""}`}>
      {featured && <span className="dl-you">Your device</span>}
      <span className="dl-glyph"><p.icon size={30} /></span>
      <h3>{p.name}</h3>
      <p>{p.needs}</p>
      {p.store ? (
        <button type="button" className="store-badge" onClick={() => onGet(p)}>
          <p.icon size={22} />
          <span><small>{p.action}</small><b>{p.store}</b></span>
        </button>
      ) : (
        <button type="button" className="btn btn-primary dl-btn" onClick={() => onGet(p)}>
          <p.icon size={16} /> Download
        </button>
      )}
      {!ready && <span className="dl-status">Coming soon</span>}
    </article>
  );
}

/** Where people get the WindVeal app (the website has no sign-in; everything happens in the app). */
export default function Download() {
  useTitle("Download WindVeal");
  const mine = useMemo(detectPlatform, []);
  const primary = ALL.find((p) => p.key === mine)!;
  const getApp = useGetApp();
  return (
    <MarketingLayout overlayHeader>
      <section className="dl-hero">
        <div className="container dl-hero-in">
          <div className="dl-hero-copy">
            <h1>WindVeal for <span>every device.</span></h1>
            <p>Run your business from your desk, and clock in, approve and follow up from your phone. One account across all of them.</p>
            <div className="dl-hero-actions">
              <button type="button" className="btn btn-light btn-lg" onClick={() => getApp(primary)}>
                <primary.icon size={18} /> {primary.store ? `${primary.action} ${primary.store}` : primary.action}
              </button>
              <a href="#platforms" className="btn btn-text-light btn-lg">Other platforms <ArrowDown size={16} aria-hidden /></a>
            </div>
            <p className="dl-hero-meta">
              {primary.needs}{DOWNLOADS[primary.key] ? "" : " · Coming soon"} · Free to download
            </p>
          </div>
          <div className="dl-devices" aria-hidden>
            <div className="dl-desktop">
              <AppShot active="Overview" label="WindVeal on a computer" short>
                <DashboardMock rows={2} />
              </AppShot>
            </div>
            <PhoneMock />
          </div>
        </div>
      </section>

      <section id="platforms" className="section dl-platforms">
        <div className="container">
          <div className="dl-group">
            <h2>Desktop</h2>
            <p>The full workspace, built for long days at a computer.</p>
          </div>
          <div className="dl-grid dl-grid-3">
            {DESKTOP.map((p) => <PlatformCard key={p.key} p={p} featured={p.key === mine} onGet={getApp} />)}
          </div>
          <div className="dl-group">
            <h2>Mobile</h2>
            <p>Clock in, approve requests and follow up wherever you are.</p>
          </div>
          <div className="dl-grid dl-grid-2">
            {MOBILE.map((p) => <PlatformCard key={p.key} p={p} featured={p.key === mine} onGet={getApp} />)}
          </div>

          <div className="dl-web">
            <span className="dl-glyph"><Globe size={28} aria-hidden /></span>
            <div>
              <h3>Prefer your browser?</h3>
              <p>WindVeal also runs in any up-to-date browser, with nothing to install.</p>
            </div>
            <a href={WEB_APP_URL} className="btn btn-secondary btn-lg">
              Open in your browser <ArrowRight size={16} aria-hidden />
            </a>
          </div>
          <p className="dl-note">Invited by your employer? Install WindVeal, choose <b>Invited by your employer?</b> and use the email your invitation was sent to.</p>
        </div>
      </section>
    </MarketingLayout>
  );
}
