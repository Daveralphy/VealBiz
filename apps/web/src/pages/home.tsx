import { useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CircleHelp, Download, Settings, ShieldCheck } from "lucide-react";
import { Skeleton } from "@windveal/ui";
import { useSession } from "../lib/session";
import { usePalette } from "../lib/palette";
import { WORKSPACE_DEFS } from "../lib/workspaces";
import { useHomeData } from "../layouts/AppShell";

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** Home: where everyone lands after signing in. One tile per workspace they can open, with live lines from their data. */
export function Home() {
  const { user, can, isAdmin } = useSession();
  const palette = usePalette();
  const { data, isLoading } = useHomeData();
  const today = new Date();
  useEffect(() => { document.title = "Home · WindVeal"; }, []);
  const workspaces = WORKSPACE_DEFS.filter((w) => can(w.key));
  const canImport = isAdmin || can("people", "manage") || can("crm", "manage") || can("recruitment", "manage");
  const more = [
    canImport && { to: "/import", label: "Import data", sub: "Bring in spreadsheets", icon: <Download size={18} /> },
    { to: "/settings", label: "Settings", sub: "Team and permissions", icon: <Settings size={18} /> },
    { to: "/help", label: "Help", sub: "Guides and support", icon: <CircleHelp size={18} /> },
    user.platformAdmin && {
      to: "/admin", label: "WindVeal admin", icon: <ShieldCheck size={18} />,
      sub: data?.adminWaiting ? `${data.adminWaiting} waiting for approval` : "Organisations and accounts",
    },
  ].filter(Boolean) as { to: string; label: string; sub: string; icon: JSX.Element }[];

  return (
    <div className="home">
      <div className="home-hello">
        <h1>{greeting(today)}, {user.name.split(" ")[0]}</h1>
        <p>{today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · Here's where things stand. Pick a workspace to get started.</p>
      </div>
      {!workspaces.length ? (
        <p className="muted">You don't have access to any workspaces yet. Ask an admin to give you access.</p>
      ) : (
        <div className="home-tiles">
          {workspaces.map((w) => {
            const lines = data?.tiles[w.key];
            const accent = palette[w.key];
            return (
              <Link key={w.key} to={w.base} className="home-tile" style={{ "--ws-c": accent.c, "--ws-t": accent.t } as CSSProperties}>
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
      )}
      <h3 className="home-more-title">More</h3>
      <div className="home-more">
        {more.map((m) => (
          <Link key={m.to} to={m.to} className="home-more-item">
            <span className="home-more-ic">{m.icon}</span>
            <span><b>{m.label}</b><small>{m.sub}</small></span>
          </Link>
        ))}
      </div>
    </div>
  );
}
