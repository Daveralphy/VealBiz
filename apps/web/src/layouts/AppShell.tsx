import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useIsFetching, useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, Building2, ChevronDown, CircleHelp, CreditCard, LayoutGrid, Lock, LogOut, Menu as MenuIcon, Moon, PanelLeftClose, PanelLeftOpen, Search,
  ShieldCheck, User, X,
} from "lucide-react";
import { Avatar, BrandLogo, Button, Menu, PageSkeleton, Switch, IconButton, TopProgress, useFirstVisitHold, usePageTransition } from "@windveal/ui";
import { api, publicFileUrl } from "../lib/api";
import { useSession } from "../lib/session";
import { timeAgo } from "../lib/format";
import { useTheme } from "../lib/theme";
import { useSignOut } from "../lib/signout";
import { usePalette } from "../lib/palette";
import { sectionActive, useAreaAccess, workspaceFor, type WorkspaceDef } from "../lib/workspaces";
import { HeaderClock } from "../modules/people/clock";

export type HomeData = {
  tiles: Partial<Record<string, { value: string; text: string; before?: string }[]>>;
  badges: Record<string, number>;
  adminWaiting: number | null;
};
/** Live lines for Home and the counts beside each workspace's sidebar sections. */
export function useHomeData() {
  return useQuery({ queryKey: ["home"], queryFn: () => api.get<HomeData>("/api/home"), refetchInterval: 60_000 });
}

/** Collapse/expand control. Hidden until the organisation block is hovered (or the control is focused). */
function ToggleButton({ mini, onToggle }: { mini: boolean; onToggle: () => void }) {
  return (
    <button className={`sb-toggle ${mini ? "over" : ""}`} onClick={onToggle} aria-label={mini ? "Expand sidebar" : "Collapse sidebar"}>
      {mini ? <PanelLeftOpen size={mini ? 18 : 16} /> : <PanelLeftClose size={16} />}
      <span className="tip">{mini ? "Expand" : "Collapse"} sidebar<kbd>Ctrl B</kbd></span>
    </button>
  );
}

function OrgMark({ size = 40 }: { size?: number }) {
  const { org } = useSession();
  return (
    // A logo always sits on white; the brand colour is only used behind the initial when there's no logo.
    <span className={`mark ${org.logoFileId ? "has-img" : ""}`} style={{ width: size, height: size, background: org.logoFileId ? "#fff" : org.brandColor || "var(--navy)" }}>
      {org.logoFileId ? <img src={publicFileUrl(org.logoFileId)} alt="" draggable={false} /> : org.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function OrgBlock() {
  const { org } = useSession();
  const statusColor = org.verificationStatus === "verified" ? "var(--ok-dot)" : org.verificationStatus === "rejected" ? "#e5484d" : "#e0a43c";
  const statusText = org.verificationStatus === "verified" ? "Verified" : org.verificationStatus === "rejected" ? "Verification failed" : "Verification pending";
  return (
    <div className="sb-org-name">
      <span style={{ minWidth: 0, flex: 1 }}>
        <b>{org.name}</b>
        <small style={{ color: org.verificationStatus === "verified" ? "var(--ok)" : "var(--warn)" }}><i style={{ background: statusColor }} />{statusText}</small>
      </span>
    </div>
  );
}

/** A workspace's own sidebar: its sections only (the page title already says which workspace this is). */
function Sidebar({ ws, mini, onToggle, onNavigate }: { ws: WorkspaceDef; mini: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { data } = useHomeData();
  const { sectionsOf } = useAreaAccess();
  return (
    <aside className="sb">
      <div className="sb-org">
        <span className="sb-logo">
          <OrgMark />
          {/* Collapsed: hovering the logo reveals the expand control on top of it. */}
          {onToggle && mini && <ToggleButton mini onToggle={onToggle} />}
        </span>
        {!mini && <OrgBlock />}
        {onToggle && !mini && <ToggleButton mini={false} onToggle={onToggle} />}
      </div>
      <nav aria-label={ws.label}>
        {sectionsOf(ws).map((s) => {
          const badge = s.badge ? data?.badges[s.badge] : undefined;
          const active = sectionActive(ws, s, pathname);
          return (
            <NavLink key={s.to} to={s.to} end onClick={onNavigate} className={`sb-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} title={mini ? s.label : undefined}>
              {s.icon}<span className="label">{s.label}</span>{!!badge && <span className="n">{badge}</span>}
            </NavLink>
          );
        })}
      </nav>
      <div className="sb-grow" />
      <div className="sb-foot"><BrandLogo height={18} /><span>v1.0</span></div>
    </aside>
  );
}

type SearchHit = { type: string; id: string; title: string; subtitle?: string; href: string };

function GlobalSearch({ ws }: { ws: WorkspaceDef }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["search", q], enabled: q.trim().length >= 2,
    queryFn: () => api.get<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q.trim())}`),
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  // Search covers this workspace only.
  const results = (data?.results ?? []).filter((r) => r.href === ws.base || r.href.startsWith(`${ws.base}/`) || r.href.startsWith(`${ws.base}?`));
  const groups = Array.from(new Set(results.map((r) => r.type)));
  return (
    <div className="top-search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setTimeout(() => setOpen(false), 150)}>
      <Search size={17} />
      <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder="Search this workspace" aria-label="Search this workspace"
        onKeyDown={(e) => { if (e.key === "Enter" && results[0]) { navigate(results[0].href); setOpen(false); setQ(""); } }} />
      <kbd>Ctrl K</kbd>
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {results.length === 0 && <p className="muted" style={{ padding: 10, fontSize: 13.5 }}>No matches for “{q}”.</p>}
          {groups.map((g) => (
            <div key={g}>
              <div className="grp">{g}</div>
              {results.filter((r) => r.type === g).map((r) => (
                <Link key={r.id} to={r.href} onClick={() => { setOpen(false); setQ(""); }}>
                  <span><b>{r.title}</b>{r.subtitle && <span className="muted"> · {r.subtitle}</span>}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ items: any[]; unread: number }>("/api/notifications"), refetchInterval: 60_000 });
  return (
    <Menu trigger={(toggle) => <IconButton label="Notifications" badge={!!data?.unread} onClick={() => {
      toggle();
      if (data?.unread) api.post("/api/notifications/read-all").then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
    }}><Bell size={20} /></IconButton>}>
      {(close) => (
        <div className="notif-list">
          <div className="between" style={{ padding: "6px 10px 8px" }}><b className="ink">Notifications</b></div>
          {(data?.items ?? []).length === 0 && <p className="muted" style={{ padding: 10 }}>You're all caught up.</p>}
          {(data?.items ?? []).map((n) => (
            <Link key={n.id} to={n.link || "/"} className={`notif ${n.readAt ? "" : "unread"}`} onClick={close}>
              <b>{n.title}</b>{n.body && <span>{n.body}</span>}<small style={{ display: "block" }}>{timeAgo(n.createdAt)}</small>
            </Link>
          ))}
        </div>
      )}
    </Menu>
  );
}

function AccountMenu() {
  const { user, membership } = useSession();
  const { pathname } = useLocation();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const signOut = useSignOut();
  return (
    <>
    <Menu trigger={(toggle) => <button className="me-btn" onClick={toggle} aria-label="Account menu"><Avatar name={user.name} size={36} src={user.avatarFileId ? publicFileUrl(user.avatarFileId) : null} /><ChevronDown size={16} /></button>}>
      {(close) => (
        <div style={{ width: 280 }}>
          <div className="row" style={{ padding: "10px 10px 12px", borderBottom: "1px solid var(--line)", marginBottom: 6 }}>
            <Avatar name={user.name} size={36} src={user.avatarFileId ? publicFileUrl(user.avatarFileId) : null} />
            <div style={{ minWidth: 0 }}><b className="ink" style={{ display: "block" }}>{user.name}</b><small className="muted">{user.email} · {membership.role}</small></div>
          </div>
          {pathname !== "/" && <><button onClick={() => { close(); navigate("/"); }}><LayoutGrid size={16} />Home</button><hr /></>}
          <button onClick={() => { close(); navigate("/profile"); }}><User size={16} />My profile</button>
          <button onClick={() => { close(); navigate("/profile/company"); }}><Building2 size={16} />Company profile</button>
          {user.platformAdmin && <button onClick={() => { close(); navigate("/admin"); }}><ShieldCheck size={16} />WindVeal admin</button>}
          <button onClick={(e) => { e.preventDefault(); setTheme(theme === "dark" ? "light" : "dark"); }}>
            <Moon size={16} />Dark mode<span style={{ marginLeft: "auto" }}><Switch label="Dark mode" checked={theme === "dark"} onChange={(v) => setTheme(v ? "dark" : "light")} /></span>
          </button>
          <hr />
          <button onClick={() => { close(); navigate("/billing"); }}><CreditCard size={16} />Plan and billing</button>
          <button onClick={() => { close(); navigate("/help"); }}><CircleHelp size={16} />Help and support</button>
          <hr />
          <button onClick={() => { close(); signOut.ask(); }}><LogOut size={16} />Sign out</button>
        </div>
      )}
    </Menu>
    {signOut.dialog}
    </>
  );
}

/** Shown instead of any page the person's access doesn't cover, however they got there. */
function NoAccess({ area, whole }: { area?: string; whole: boolean }) {
  const navigate = useNavigate();
  const { org, membership } = useSession();
  useEffect(() => { document.title = "No access · WindVeal"; }, []);
  const role = membership.roleName ?? membership.role;
  return (
    <div className="card no-access">
      <div className="empty">
        <span className="ic"><Lock size={22} /></span>
        <h2>You don't have access to this page</h2>
        <p>{area ? `Your role (${role}) doesn't include ${whole ? area : `this part of ${area}`}.` : `Your role (${role}) doesn't include this page.`} Ask an admin at {org.name} if you need it.</p>
        <Button onClick={() => navigate("/")}>Go to Home</Button>
      </div>
    </div>
  );
}

export function AppShell() {
  const [mini, setMini] = useState(() => { try { return localStorage.getItem("wv-sidebar") === "mini"; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const { org } = useSession();
  const location = useLocation();
  const { canOpen, canOpenPath } = useAreaAccess();
  const area = workspaceFor(location.pathname);
  // An area someone can't open gets no sidebar of its own, just the "no access" page.
  const ws = area && canOpen(area) ? area : null;
  const palette = usePalette();
  const accent = ws ? palette[ws.key] : null;
  const toggle = () => setMini((m) => {
    try { localStorage.setItem("wv-sidebar", m ? "full" : "mini"); } catch { /* ignore */ }
    return !m;
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); toggle(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => setDrawer(false), [location.pathname]);
  // First time on a screen: a short loading moment before it appears. Back/forward shows it as it was.
  const historyMove = useNavigationType() === "POP";
  const held = useFirstVisitHold("app", location.pathname, historyMove);
  const content = usePageTransition<HTMLDivElement>(held ? "held" : location.pathname);
  // While held, the page's own title, back link and tabs stay visible; the placeholder covers only the content below.
  const [skelTop, setSkelTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!held || !content.current) { setSkelTop(null); return; }
    const fixed = content.current.querySelectorAll<HTMLElement>(".page-head, .back-link, .tabs, .imp-pills");
    const last = fixed[fixed.length - 1];
    setSkelTop(last ? last.offsetTop + last.offsetHeight + 4 : null);
  }, [held, location.pathname]);
  const busy = useIsFetching() + useIsMutating() > 0;
  const style = accent ? ({ "--ws-c": accent.c, "--ws-t": accent.t } as CSSProperties) : undefined;
  const allowed = canOpenPath(location.pathname.replace(/\/+$/, "") || "/");
  const page = (
    <main className="content">
      {/* Rendered while held, so the screen's data loads during the pause. */}
      <div ref={content} className={`page-enter page-stage${held ? " holding" : ""}`}>
        {allowed ? <Outlet /> : <NoAccess area={area?.label} whole={!!area && !ws} />}
        {held && <PageSkeleton title={skelTop === null} style={{ position: "absolute", left: 0, right: 0, top: skelTop ?? 0 }} />}
      </div>
    </main>
  );

  // Home, Profile, Settings and the like: no sidebar, just the organisation and your tools along the top.
  if (!ws) {
    return (
      <div className="shell plain">
        <TopProgress active={busy} />
        <div className="main">
          <header className="topbar">
            <span className="tb-brand"><span className="sb-logo"><OrgMark /></span><OrgBlock /></span>
            <div className="right"><HeaderClock /><Notifications /><AccountMenu /></div>
          </header>
          <header className="mtop">
            <span className="tb-brand"><span className="sb-logo" style={{ width: 32, height: 32 }}><OrgMark size={32} /></span><b>{org.name}</b></span>
            <div className="r"><HeaderClock /><Notifications /><AccountMenu /></div>
          </header>
          {page}
        </div>
      </div>
    );
  }

  return (
    <div className={`shell in-ws ${mini ? "mini" : ""}`} style={style}>
      <TopProgress active={busy} />
      <Sidebar ws={ws} mini={mini} onToggle={toggle} />
      <div className="main">
        <header className="topbar">
          {ws.search ? <GlobalSearch ws={ws} /> : <span />}
          <div className="right"><HeaderClock /><Notifications /><AccountMenu /></div>
        </header>
        <header className="mtop">
          <IconButton label="Open menu" onClick={() => setDrawer(true)}><MenuIcon size={22} /></IconButton>
          <div className="r"><HeaderClock /><Notifications /><AccountMenu /></div>
        </header>
        {page}
      </div>
      {drawer && (
        <div className="mobile-drawer" style={style} onClick={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <Sidebar ws={ws} mini={false} onNavigate={() => setDrawer(false)} />
          <IconButton label="Close menu" bordered style={{ position: "absolute", left: 300, top: 12, background: "var(--surface)" }} onClick={() => setDrawer(false)}><X size={20} /></IconButton>
        </div>
      )}
    </div>
  );
}
