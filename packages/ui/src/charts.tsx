import type { ReactNode } from "react";

/** Simple vertical bar chart. The last bar is highlighted unless `highlightLast` is false. */
export function BarChart({ data, format = (v) => String(v), highlightLast = true }: {
  data: { label: string; value: number }[]; format?: (v: number) => ReactNode; highlightLast?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="bars">
        {data.map((d, i) => (
          <div key={d.label + i} title={`${d.label}: ${d.value}`}>
            <span>{format(d.value)}</span>
            <i className={highlightLast && i === data.length - 1 ? "on" : ""} style={{ height: `${(d.value / max) * 82}%` }} />
          </div>
        ))}
      </div>
      <div className="bar-labels">{data.map((d, i) => <span key={d.label + i}>{d.label}</span>)}</div>
    </div>
  );
}

export function HBarChart({ data, format = (v) => String(v) }: { data: { label: string; value: number }[]; format?: (v: number) => ReactNode }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      {data.map((d) => (
        <div className="hbar" key={d.label}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
          <i style={{ width: `${(d.value / max) * 100}%` }} />
          <b>{format(d.value)}</b>
        </div>
      ))}
    </div>
  );
}

export function LineChart({ data, height = 170 }: { data: { label: string; value: number }[]; height?: number }) {
  if (data.length < 2) return <p className="muted">Not enough data yet.</p>;
  const max = Math.max(1, ...data.map((d) => d.value));
  const pts = data.map((d, i) => `${(i / (data.length - 1)) * 300},${120 - (d.value / max) * 100}`).join(" ");
  return (
    <div>
      <div style={{ height, borderBottom: "1px solid var(--line)" }}>
        <svg viewBox="0 0 300 120" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
          <polyline fill="var(--ws-t, rgba(72,111,228,.08))" stroke="none" points={`0,120 ${pts} 300,120`} />
          <polyline fill="none" stroke="var(--ws-c, #486FE4)" strokeWidth="3" points={pts} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="bar-labels">{data.map((d, i) => <span key={i}>{d.label}</span>)}</div>
    </div>
  );
}
