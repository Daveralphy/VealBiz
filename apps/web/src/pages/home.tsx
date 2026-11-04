import { useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@windveal/ui";
import { useSession } from "../lib/session";
import { usePalette } from "../lib/palette";
import { WORKSPACE_DEFS, useAreaAccess, type WorkspaceDef } from "../lib/workspaces";
import { useHomeData } from "../layouts/AppShell";

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** A grid of tiles, each with three live lines from the area it opens. */
function Tiles({ areas }: { areas: WorkspaceDef[] }) {
  const palette = usePalette();
  const { data, isLoading } = useHomeData();
  const { sectionsOf } = useAreaAccess();
  return (
    <div className="home-tiles">
      {areas.map((w) => {
        const lines = data?.tiles[w.key];
        const accent = palette[w.key];
        return (
          <Link key={w.key} to={sectionsOf(w)[0]?.to ?? w.base} className="home-tile" style={{ "--ws-c": accent.c, "--ws-t": accent.t } as CSSProperties}>
            <ArrowRight size={18} className="home-go" />
            <span className="home-ic">{w.icon(26)}</span>
            <h2>{w.label}</h2>
            <div className="home-live">
              {isLoading || !lines
                ? [0, 1, 2].map((i) => <Skeleton key={i} width={["72%", "84%", "60%"][i]} height={13} />)
                : lines.map((l, i) => (
                  <span key={i} className={i > 0 ? "more-line" : undefined}><em />{l.before && <>{l.before} </>}<b>{l.value}</b> {l.text}</span>
                ))}
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
        <p>{today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · Here's where things stand. Pick a workspace to get started.</p>
      </div>
      {workspaces.length ? <Tiles areas={workspaces} /> : <p className="muted">You don't have access to any workspaces yet. Ask an admin to give you access.</p>}
      {!!manage.length && <>
        <h3 className="home-more-title">Manage</h3>
        <Tiles areas={manage} />
      </>}
    </div>
  );
}
