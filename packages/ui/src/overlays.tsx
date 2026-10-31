import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./components";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

export function Modal({ open, onClose, title, subtitle, children, footer, size }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: "lg";
}) {
  useEscape(onClose);
  if (!open) return null;
  return createPortal(
    // Clicks inside a pop-up never reach what it was declared inside (e.g. a clickable card behind it).
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onClick={stop} onKeyDown={stop}>
      <div className={`modal ${size === "lg" ? "modal-lg" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="modal-head">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <IconButton label="Close" bordered onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer, headerExtra }: {
  open: boolean; onClose: () => void; title: ReactNode; children?: ReactNode; footer?: ReactNode; headerExtra?: ReactNode;
}) {
  useEscape(onClose);
  if (!open) return null;
  return createPortal(
    <div className="drawer-root" onClick={stop} onKeyDown={stop}>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="drawer-head">
          <div className="row" style={{ minWidth: 0 }}>{headerExtra}<h2>{title}</h2></div>
          <IconButton label="Close" bordered onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * Click-outside dropdown menu anchored to its trigger. It floats above the page (never cut off by a card
 * or list it sits in) and opens upwards when there isn't room below.
 */
export function Menu({ trigger, children, align = "right" }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); setPos(null); };

  // Place the menu next to its trigger, flipping up or in from the edge so it stays on screen.
  useLayoutEffect(() => {
    if (!open || !ref.current || !menuRef.current) return;
    const place = () => {
      const t = ref.current!.getBoundingClientRect();
      const m = menuRef.current!.getBoundingClientRect();
      const gap = 6, edge = 8;
      const up = t.bottom + gap + m.height > window.innerHeight - edge && t.top - gap - m.height > edge;
      const top = up ? t.top - gap - m.height : Math.min(t.bottom + gap, window.innerHeight - edge - m.height);
      let left = align === "right" ? t.right - m.width : t.left;
      left = Math.max(edge, Math.min(left, window.innerWidth - edge - m.width));
      setPos({ top: Math.max(edge, top), left, up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", close, true); };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n) && !menuRef.current?.contains(n)) close();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEscape(close);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      {trigger(() => (open ? close() : setOpen(true)), open)}
      {open && createPortal(
        <div ref={menuRef} className={`menu menu-float${pos?.up ? " up" : ""}`} onClick={stop} onKeyDown={stop}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}>
          {children(close)}
        </div>,
        document.body,
      )}
    </div>
  );
}

type Toast = { id: number; text: ReactNode; tone: "default" | "error" };
type Push = (text: ReactNode, tone?: "default" | "error") => void;
const ToastCtx = createContext<Push>(() => {});
export const useToast = () => useContext(ToastCtx);

let globalPush: Push | null = null;
/** Shows a toast from outside React (e.g. a query client error handler). */
export function showToast(text: ReactNode, tone: "default" | "error" = "default") {
  globalPush?.(text, tone);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const recent = useRef(new Map<string, number>());
  const push = useCallback<Push>((text, tone = "default") => {
    // The same message raised twice in a moment (e.g. by a form and the query client) shows once.
    if (typeof text === "string") {
      const now = Date.now();
      if ((recent.current.get(text) ?? 0) > now - 2000) return;
      recent.current.set(text, now);
    }
    const id = Date.now() + Math.random();
    setItems((t) => [...t, { id, text, tone }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3800);
  }, []);
  useEffect(() => {
    globalPush = push;
    return () => { if (globalPush === push) globalPush = null; };
  }, [push]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" aria-live="polite">
          {items.map((t) => <div key={t.id} className={`toast ${t.tone === "error" ? "error" : ""}`} role={t.tone === "error" ? "alert" : undefined}>{t.text}</div>)}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = "Confirm", danger, loading }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; children?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={loading} onClick={onConfirm}>
          {loading && <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />}{confirmLabel}
        </button>
      </>}>
      {children}
    </Modal>
  );
}

type ConfirmOptions = { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean };

/**
 * Ask before doing something that can't easily be taken back. `confirm(...)` resolves to true or false;
 * render `dialog` somewhere in the component.
 */
export function useConfirm() {
  const [ask, setAsk] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setAsk({ ...opts, resolve })), []);
  const finish = (ok: boolean) => { ask?.resolve(ok); setAsk(null); };
  const dialog = ask ? (
    <ConfirmDialog open onClose={() => finish(false)} onConfirm={() => finish(true)} title={ask.title}
      confirmLabel={ask.confirmLabel ?? "Confirm"} danger={ask.danger ?? true}>
      {ask.message && <p className="muted" style={{ margin: 0 }}>{ask.message}</p>}
    </ConfirmDialog>
  ) : null;
  return { confirm, dialog };
}
