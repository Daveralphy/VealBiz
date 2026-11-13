import { useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../lib/session";
import { usePalette } from "../lib/palette";
import { areaArt } from "../lib/areaArt";
import { WORKSPACE_DEFS, useAreaAccess, type WorkspaceDef } from "../lib/workspaces";
import { useHomeData } from "../layouts/AppShell";

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** What each card says: a fuller line than the sidebar's, about what you can do there. */
const ABOUT: Record<string, string> = {
  me: "Clock in, check your leave balance, see your pay and finish your onboarding.",
  people: "See who's in today, approve leave, and keep everyone's records up to date.",
  recruitment: "Post jobs on your careers page, move candidates along and book interviews.",
  crm: "Follow leads and deals through your pipeline, and never miss a follow-up.",
  workflows: "Hand out tasks, get approvals signed off and run checklists that keep work moving.",
  documents: "Keep every business file in one place, and bring in your spreadsheets.",
  insights: "Reports on sales, people, hiring and work, so you see how the business is doing.",
  settings: "Invite your team, set up roles and decide who can see and change what.",
  admin: "Approve new businesses, look after accounts and help people who are stuck.",
};

/** A drawing of what the area is for, in its own colour (static markup from areaArt). */
const Art = ({ k }: { k: string }) => <div className="art" aria-hidden dangerouslySetInnerHTML={{ __html: areaArt(k) }} />;

/** Whether anything in an area is waiting for this person (the same counts as the sidebar badges). */
function useWaiting() {
  const { data } = useHomeData();
  const { sectionsOf } = useAreaAccess();
  return (w: WorkspaceDef) => sectionsOf(w).some((s) => {
    if (!s.badge || !data) return false;
    return (data.badges[s.badge] ?? (s.badge === "adminWaiting" ? data.adminWaiting : 0) ?? 0) > 0;
  });
}

function Cards({ areas }: { areas: WorkspaceDef[] }) {
  const palette = usePalette();
  const waiting = useWaiting();
  const { sectionsOf } = useAreaAccess();
  return (
    <div className="home-grid">
      {areas.map((w) => {
        const accent = palette[w.key];
        const dot = waiting(w);
        return (
          <Link key={w.key} to={sectionsOf(w)[0]?.to ?? w.base} className="home-card" style={{ "--ws-c": accent.c, "--ws-t": accent.t } as CSSProperties}
            aria-label={dot ? `${w.label}, something to check` : w.label}>
            <Art k={w.key} />
            <b>{w.label}</b><span>{ABOUT[w.key] ?? w.blurb}</span>
            {dot && <i className="home-dot" title="Something to check" />}
          </Link>
        );
      })}
    </div>
  );
}

function Group({ title, areas }: { title: string; areas: WorkspaceDef[] }) {
  if (!areas.length) return null;
  return (
    <section className="home-group">
      <h2 className="home-group-title">{title}</h2>
      <Cards areas={areas} />
    </section>
  );
}

/**
 * Home: where everyone lands after signing in. Their own space first, then the workspaces they share with
 * their team, then running the business, and WindVeal's own admin set apart for WindVeal staff.
 */
export function Home() {
  const { user } = useSession();
  const { canOpen, sectionsOf } = useAreaAccess();
  const palette = usePalette();
  const waiting = useWaiting();
  const today = new Date();
  useEffect(() => { document.title = "Home · WindVeal"; }, []);
  const open = WORKSPACE_DEFS.filter(canOpen);
  const mine = open.filter((w) => w.key === "me");
  const workspaces = open.filter((w) => w.group === "workspace" && w.key !== "me");
  const manage = open.filter((w) => w.group === "manage" && w.key !== "admin");
  const admin = open.find((w) => w.key === "admin");
  return (
    <div className="home">
      <div className="home-hello">
        <h1>{greeting(today)}, {user.name.split(" ")[0]}</h1>
        <p>{today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · Pick a workspace to get started.</p>
      </div>
      <Group title="Just for you" areas={mine} />
      {workspaces.length
        ? <Group title="With your team" areas={workspaces} />
        : <p className="muted home-group">You don't have access to any team workspaces yet. Ask an admin to give you access.</p>}
      <Group title="Manage the business" areas={manage} />
      {admin && (
        <section className="home-group">
          <h2 className="home-group-title">Platform</h2>
          <div className="home-grid">
            <Link to={sectionsOf(admin)[0]?.to ?? admin.base} className="home-card home-admin" style={{ "--ws-c": palette.admin.c } as CSSProperties}>
              <Art k="admin" />
              <b>{admin.label}</b><span>{ABOUT.admin}</span>
              {waiting(admin) && <i className="home-dot" title="Something to check" />}
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
