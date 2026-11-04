import { Children, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loading } from "@windveal/ui";

/**
 * Building blocks for workspace dashboards. They pick up the workspace's colour (--ws-c / --ws-t,
 * set by the workspace layout) so every dashboard looks the same and stays on brand.
 */

export type Kpi = { label: string; value: ReactNode; note?: ReactNode; to?: string };

/** A row of four numbers; the first is highlighted in the workspace colour. */
export function DashKpis({ items, loading }: { items: Kpi[]; loading?: boolean }) {
  return (
    <div className="dash-kpis">
      {items.map((k, i) => {
        const body = <><small>{k.label}</small><b>{loading ? "—" : k.value}</b>{k.note && <span>{loading ? " " : k.note}</span>}</>;
        const cls = `dash-kpi${i === 0 ? " hi" : ""}`;
        return k.to ? <Link key={k.label} to={k.to} className={cls}>{body}</Link> : <div key={k.label} className={cls}>{body}</div>;
      })}
    </div>
  );
}

/** Two columns of cards (wide on the left), stacking on phones. */
export function DashColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return <div className="dash-cols"><div>{left}</div><div>{right}</div></div>;
}

/** Lists on dashboards stop here; "See all" opens the full page. */
export const DASH_LIMIT = 5;

/**
 * A dashboard card with a title, a short line under it and a "See all" link to the full page. Lists inside
 * show at most DASH_LIMIT items, so dashboards stay even.
 */
export function DashCard({ title, sub, link, children, loading, empty }: {
  title: string; sub?: string; link?: { to: string; label: string }; children?: ReactNode; loading?: boolean;
  /** Shown instead of the content when there's nothing to list. */
  empty?: ReactNode | false;
}) {
  const items = Children.toArray(children);
  const shown = items.length > 1 ? items.slice(0, DASH_LIMIT) : children;
  return (
    <section className="dash-card">
      <div className="dash-card-hd">
        <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {link && <Link to={link.to} className="dash-link" aria-label={`See all: ${link.label}`}>See all →</Link>}
      </div>
      {loading ? <Loading lines={3} /> : empty ? <p className="dash-empty">{empty}</p> : shown}
    </section>
  );
}

/** One line in a card: avatar/icon, title and detail on the left, a value or pill on the right. */
export function DashRow({ lead, title, detail, end, to, onClick }: {
  lead?: ReactNode; title: ReactNode; detail?: ReactNode; end?: ReactNode; to?: string; onClick?: () => void;
}) {
  const inner = <>{lead}<span className="dash-row-main"><b>{title}</b>{detail && <small>{detail}</small>}</span>{end && <span className="dash-row-end">{end}</span>}</>;
  if (to) return <Link to={to} className="dash-row link">{inner}</Link>;
  if (onClick) return <button type="button" className="dash-row link" onClick={onClick}>{inner}</button>;
  return <div className="dash-row">{inner}</div>;
}

/** Horizontal bars, longest first, in the workspace colour. */
export function DashBars({ rows }: { rows: { label: string; value: number; display?: ReactNode }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="dash-bars">
      {rows.map((r) => (
        <div key={r.label} className="dash-bar">
          <span>{r.label}</span>
          <i><u style={{ width: `${Math.max(r.value ? 4 : 0, (r.value / max) * 100)}%` }} /></i>
          <b>{r.display ?? r.value}</b>
        </div>
      ))}
    </div>
  );
}
