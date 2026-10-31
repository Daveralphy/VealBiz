import { useEffect, useRef, useState, type CSSProperties } from "react";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Fades and lifts an element in whenever `key` changes (e.g. the route path), so moving between
 * pages doesn't jump. Works without remounting the page. Skipped for people who prefer less motion.
 */
export function usePageTransition<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== "function") return;
    // The first render uses the CSS entrance; later changes animate here.
    if (first.current) { first.current = false; return; }
    el.animate(
      [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
      { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
  }, [key]);
  return ref;
}

/** One shimmering placeholder block. */
export function Skeleton({ width = "100%", height = 14, radius = 6, style, className = "" }: {
  width?: number | string; height?: number | string; radius?: number; style?: CSSProperties; className?: string;
}) {
  return <span className={`skel ${className}`} style={{ width, height, borderRadius: radius, ...style }} aria-hidden />;
}

/** Placeholder lines shaped like text. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  const widths = ["92%", "78%", "64%", "86%", "54%"];
  return (
    <span className="skel-text" aria-hidden>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} width={widths[i % widths.length]} />)}
    </span>
  );
}

/** A whole-page placeholder: a title, a row of tiles and a couple of cards. */
export function PageSkeleton() {
  return (
    <div className="skel-page" role="status" aria-label="Loading">
      <Skeleton width={220} height={30} radius={8} />
      <Skeleton width={320} height={14} style={{ marginTop: 10 }} />
      <div className="skel-tiles">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="skel-card"><Skeleton width="40%" height={12} /><Skeleton width="60%" height={26} style={{ marginTop: 12 }} /></div>)}
      </div>
      <div className="skel-cols">
        <div className="skel-card tall"><SkeletonText lines={5} /></div>
        <div className="skel-card tall"><SkeletonText lines={4} /></div>
      </div>
    </div>
  );
}

/**
 * Thin bar along the top of the window while something is loading or saving. Appears only if the
 * work takes longer than a moment, so quick actions don't flicker.
 */
export function TopProgress({ active }: { active: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const t = setTimeout(() => setShown(true), 180);
    return () => clearTimeout(t);
  }, [active]);
  return <div className={`top-progress ${shown ? "on" : ""}`} role="progressbar" aria-hidden={!shown} aria-label="Loading" />;
}
