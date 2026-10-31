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

const FIRST_VISIT_MS = 550;
const visitedCache = new Map<string, Set<string>>();

function visitedFor(scope: string): Set<string> {
  let set = visitedCache.get(scope);
  if (!set) {
    let saved: string[] = [];
    try { saved = JSON.parse(sessionStorage.getItem(`wv-visited:${scope}`) ?? "[]"); } catch { /* ignore */ }
    set = new Set(saved);
    visitedCache.set(scope, set);
  }
  return set;
}

/**
 * The first time a page is opened (this browser session), hold it back for about half a second behind
 * a loading state, so screens don't snap in instantly. Pages already seen, and going back or forward
 * in history, show straight away. The page still renders (and loads its data) underneath while held.
 */
export function useFirstVisitHold(scope: string, path: string, isHistoryMove: boolean, ms = FIRST_VISIT_MS) {
  const visited = visitedFor(scope);
  const [held, setHeld] = useState(() => !isHistoryMove && !visited.has(path) && !reducedMotion());
  const [heldPath, setHeldPath] = useState(path);
  // Decide during render for a new path, so the page never flashes before the hold starts.
  if (heldPath !== path) {
    setHeldPath(path);
    setHeld(!isHistoryMove && !visited.has(path) && !reducedMotion());
  }
  useEffect(() => {
    visited.add(path);
    try { sessionStorage.setItem(`wv-visited:${scope}`, JSON.stringify([...visited].slice(-300))); } catch { /* ignore */ }
    if (!held) return;
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [path, held]);
  return held;
}

/**
 * Remembers how far down each page was scrolled. Going back or forward returns to the same spot;
 * opening a page from a link starts at the top (or at #anchor). For routers without built-in
 * scroll restoration.
 */
export function useScrollMemory(locationKey: string, isHistoryMove: boolean, hash = "") {
  const positions = useRef(new Map<string, number>());
  const current = useRef(locationKey);
  useEffect(() => {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const save = () => positions.current.set(current.current, window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    return () => window.removeEventListener("scroll", save);
  }, []);
  useEffect(() => {
    current.current = locationKey;
    if (isHistoryMove && positions.current.has(locationKey)) {
      const y = positions.current.get(locationKey)!;
      // Wait a frame so the page has its height back before scrolling.
      requestAnimationFrame(() => window.scrollTo(0, y));
    } else if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }, [locationKey]);
}
