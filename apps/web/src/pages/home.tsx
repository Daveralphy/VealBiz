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
            <div className="grow"><b>{w.label}</b><span>{w.blurb}</span></div>
            {dot && <i className="home-dot" title="Something to check" />}
          </Link>
        );
      })}
    </div>
  );
}

function Group({ title, note, areas }: { title: string; note?: string; areas: WorkspaceDef[] }) {
  if (!areas.length) return null;
  return (
    <section className="home-group">
      <h2 className="home-group-title">{title}{note && <small>{note}</small>}</h2>
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
        ? <Group title="Workspaces" note="What you work on with your team" areas={workspaces} />
        : <p className="muted home-group">You don't have access to any team workspaces yet. Ask an admin to give you access.</p>}
      <Group title="Manage the business" areas={manage} />
      {admin && (
        <section className="home-group">
          <Link to={sectionsOf(admin)[0]?.to ?? admin.base} className="home-admin" style={{ "--ws-c": palette.admin.c } as CSSProperties}>
            <Art k="admin" />
            <div className="grow"><small>WindVeal staff only</small><b>{admin.label}</b><span>{admin.blurb}</span></div>
            {waiting(admin) && <i className="home-dot" title="Something to check" />}
          </Link>
        </section>
      )}
    </div>
  );
}
