import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useIsFetching, useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, Briefcase, ChevronDown, CircleHelp, CreditCard, Download, FileText, Home, LineChart, LogOut, Menu as MenuIcon, Moon,
  PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, ShieldCheck, SquareCheck, User, UserPlus, Users, X, Building2,
} from "lucide-react";
import { Avatar, BrandLogo, Menu, PageSkeleton, Progress, Switch, IconButton, TopProgress, useFirstVisitHold, usePageTransition } from "@windveal/ui";
import { formatBytes, type Workspace } from "@windveal/shared";
import { api, publicFileUrl } from "../lib/api";
import { useSession } from "../lib/session";
import { timeAgo } from "../lib/format";
import { useTheme } from "../lib/theme";
import { useSignOut } from "../lib/signout";
import { HeaderClock } from "../modules/people/clock";

const NAV: { to: string; label: string; icon: ReactNode; ws?: Workspace; badgeKey?: string }[] = [
  { to: "/recruitment", label: "Recruitment", icon: <UserPlus size={18} />, ws: "recruitment" },
  { to: "/people", label: "People & HR", icon: <Users size={18} />, ws: "people" },
  { to: "/crm", label: "CRM", icon: <Briefcase size={18} />, ws: "crm" },
  { to: "/workflows", label: "Workflows", icon: <SquareCheck size={18} />, ws: "workflows", badgeKey: "tasks" },
  { to: "/documents", label: "Documents", icon: <FileText size={18} />, ws: "documents" },
  { to: "/insights", label: "Insights", icon: <LineChart size={18} />, ws: "insights" },
];

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

function Sidebar({ mini, onToggle, onNavigate }: { mini: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  const { org, user, can, isAdmin } = useSession();
  const { data: counts } = useQuery({ queryKey: ["shell-counts"], queryFn: () => api.get<{ tasks: number }>("/api/overview/counts"), refetchInterval: 60_000 });
  const { data: storage } = useQuery({ queryKey: ["storage"], queryFn: () => api.get<{ used: number; limit: number }>("/api/storage"), staleTime: 300_000 });
  const statusColor = org.verificationStatus === "verified" ? "var(--ok-dot)" : org.verificationStatus === "rejected" ? "#e5484d" : "#e0a43c";
  const statusText = org.verificationStatus === "verified" ? "Verified" : org.verificationStatus === "rejected" ? "Verification failed" : "Verification pending";
  const item = (to: string, label: string, icon: ReactNode, badge?: number, end?: boolean) => (
    <NavLink key={to} to={to} end={end} onClick={onNavigate} className={({ isActive }) => `sb-item ${isActive ? "active" : ""}`} title={mini ? label : undefined}>
      {icon}<span className="label">{label}</span>{!!badge && <span className="n">{badge}</span>}
    </NavLink>
  );
  return (
    <aside className="sb">
      <div className="sb-org">
        <span className="sb-logo">
          <OrgMark />
          {/* Collapsed: hovering the logo reveals the expand control on top of it. */}
          {onToggle && mini && <ToggleButton mini onToggle={onToggle} />}
        </span>
        {!mini && (
          <div className="sb-org-name">
            <span style={{ minWidth: 0, flex: 1 }}>
              <b>{org.name}</b>
              <small style={{ color: org.verificationStatus === "verified" ? "var(--ok)" : "var(--warn)" }}><i style={{ background: statusColor }} />{statusText}</small>
            </span>
          </div>
        )}
        {onToggle && !mini && <ToggleButton mini={false} onToggle={onToggle} />}
      </div>
      <nav aria-label="Main">
        {item("/", "Overview", <Home size={18} />, undefined, true)}
        <div className="sb-lab">Workspaces</div><div className="sb-sep" />
        {NAV.filter((n) => !n.ws || can(n.ws)).map((n) => item(n.to, n.label, n.icon, n.badgeKey === "tasks" ? counts?.tasks : undefined))}
        <div className="sb-lab">Organisation</div><div className="sb-sep" />
        {(isAdmin || can("people", "manage") || can("crm", "manage") || can("recruitment", "manage")) && item("/import", "Import data", <Download size={18} />)}
        {item("/settings", "Settings", <Settings size={18} />)}
        {user.platformAdmin && item("/admin", "WindVeal admin", <ShieldCheck size={18} />)}
        {item("/help", "Help", <CircleHelp size={18} />)}
      </nav>
      <div className="sb-grow" />
      {storage && (
        <div className="sb-store">
          <div className="between"><span>Storage</span><b className="ink">{formatBytes(storage.used)} of {formatBytes(storage.limit)}</b></div>
          <Progress value={(storage.used / storage.limit) * 100} />
          <Link to="/billing" onClick={onNavigate}>Upgrade for more space →</Link>
        </div>
      )}
      <div className="sb-foot"><BrandLogo height={18} /><span>v1.0</span></div>
    </aside>
  );
}

type SearchHit = { type: string; id: string; title: string; subtitle?: string; href: string };

function GlobalSearch() {
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
  const results = data?.results ?? [];
  const groups = Array.from(new Set(results.map((r) => r.type)));
  return (
    <div className="top-search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setTimeout(() => setOpen(false), 150)}>
      <Search size={17} />
      <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder="Search people, clients, files and more" aria-label="Search"
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

function NewMenu() {
  const { can } = useSession();
  const navigate = useNavigate();
  const go = (to: string, close: () => void) => { close(); navigate(to); };
  return (
    <Menu trigger={(toggle) => <button className="btn btn-primary" onClick={toggle}><Plus size={16} strokeWidth={2.4} />New</button>}>
      {(close) => (
        <>
          {can("workflows", "edit") && <button onClick={() => go("/workflows?new=task", close)}><SquareCheck size={16} />Task</button>}
          {can("people", "edit") && <button onClick={() => go("/people?new=employee", close)}><Users size={16} />Employee</button>}
          {can("recruitment", "edit") && <button onClick={() => go("/recruitment/jobs/new", close)}><UserPlus size={16} />Job</button>}
          {can("crm", "edit") && <button onClick={() => go("/crm/leads?new=lead", close)}><Briefcase size={16} />Lead</button>}
          {can("crm", "edit") && <button onClick={() => go("/crm/pipeline?new=deal", close)}><Briefcase size={16} />Deal</button>}
          {can("documents", "edit") && <button onClick={() => go("/documents?upload=1", close)}><FileText size={16} />Upload file</button>}
        </>
      )}
    </Menu>
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

export function AppShell() {
  const [mini, setMini] = useState(() => { try { return localStorage.getItem("wv-sidebar") === "mini"; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const { org } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
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
  return (
    <div className={`shell ${mini ? "mini" : ""}`}>
      <TopProgress active={busy} />
      <Sidebar mini={mini} onToggle={toggle} />
      <div className="main">
        <header className="topbar">
          <GlobalSearch />
          <div className="right">
            <HeaderClock />
            <NewMenu />
            <Notifications />
            <AccountMenu />
          </div>
        </header>
        <header className="mtop">
          <IconButton label="Open menu" onClick={() => setDrawer(true)}><MenuIcon size={22} /></IconButton>
          <span className="sb-logo" style={{ width: 32, height: 32 }}><OrgMark size={32} /></span>
          <b>{org.name}</b>
          <div className="r"><HeaderClock /><Notifications /><AccountMenu /></div>
        </header>
        <main className="content">
          {/* Rendered while held, so the screen's data loads during the pause. */}
          <div ref={content} className={`page-enter page-stage${held ? " holding" : ""}`}>
            <Outlet />
            {held && <PageSkeleton title={skelTop === null} style={{ position: "absolute", left: 0, right: 0, top: skelTop ?? 0 }} />}
          </div>
        </main>
        <button className="fab" aria-label="Create" onClick={() => navigate("/workflows?new=task")}><Plus size={24} strokeWidth={2.4} /></button>
      </div>
      {drawer && (
        <div className="mobile-drawer" onClick={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <Sidebar mini={false} onNavigate={() => setDrawer(false)} />
          <IconButton label="Close menu" bordered style={{ position: "absolute", left: 300, top: 12, background: "var(--surface)" }} onClick={() => setDrawer(false)}><X size={20} /></IconButton>
        </div>
      )}
    </div>
  );
}
