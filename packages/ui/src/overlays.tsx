import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="drawer-head">
          <div className="row" style={{ minWidth: 0 }}>{headerExtra}<h2>{title}</h2></div>
          <IconButton label="Close" bordered onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/** Click-outside dropdown menu anchored to its trigger. */
export function Menu({ trigger, children, align = "right" }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEscape(() => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && <div className="menu" style={{ top: "calc(100% + 6px)", [align]: 0 }}>{children(() => setOpen(false))}</div>}
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
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={loading} onClick={onConfirm}>{confirmLabel}</button>
      </>}>
      {children}
    </Modal>
  );
}
