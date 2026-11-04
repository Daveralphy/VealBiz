import { useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { useSession } from "../lib/session";
import { usePalette } from "../lib/palette";
import { WORKSPACE_DEFS, useAreaAccess, type WorkspaceDef } from "../lib/workspaces";
import { useHomeData } from "../layouts/AppShell";

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/**
 * A grid of tiles: a photo of the area, what it's for, and a bell when something there is waiting for you
 * (the same counts as the sidebar badges).
 */
function Tiles({ areas }: { areas: WorkspaceDef[] }) {
  const palette = usePalette();
  const { data } = useHomeData();
  const { sectionsOf } = useAreaAccess();
  const waiting = (w: WorkspaceDef) => sectionsOf(w).some((s) => {
    if (!s.badge || !data) return false;
    return (data.badges[s.badge] ?? (s.badge === "adminWaiting" ? data.adminWaiting : 0) ?? 0) > 0;
  });
  return (
    <div className="home-tiles">
      {areas.map((w) => {
        const accent = palette[w.key];
        const bell = waiting(w);
        return (
          <Link key={w.key} to={sectionsOf(w)[0]?.to ?? w.base} className="home-tile" style={{ "--ws-c": accent.c, "--ws-t": accent.t } as CSSProperties}
            aria-label={bell ? `${w.label}, something to check` : w.label}>
            <span className="home-photo" style={{ backgroundImage: `url(/images/home/${w.key}.jpg)` }} aria-hidden />
            <div className="home-body">
              <div><h2>{w.label}</h2><p>{w.blurb}</p></div>
              {bell && <span className="home-bell" title="Something to check"><Bell size={18} /><i /></span>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** Home: where everyone lands after signing in. A tile for each workspace and each management area they can open. */
export function Home() {
  const { user } = useSession();
  const { canOpen } = useAreaAccess();
  const today = new Date();
  useEffect(() => { document.title = "Home · WindVeal"; }, []);
  const workspaces = WORKSPACE_DEFS.filter((w) => w.group === "workspace" && canOpen(w));
  const manage = WORKSPACE_DEFS.filter((w) => w.group === "manage" && canOpen(w));
  return (
    <div className="home">
      <div className="home-hello">
        <h1>{greeting(today)}, {user.name.split(" ")[0]}</h1>
        <p>{today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · Pick a workspace to get started.</p>
      </div>
      {workspaces.length ? <Tiles areas={workspaces} /> : <p className="muted">You don't have access to any workspaces yet. Ask an admin to give you access.</p>}
      {!!manage.length && <>
        <h3 className="home-more-title">Manage</h3>
        <Tiles areas={manage} />
      </>}
    </div>
  );
}
