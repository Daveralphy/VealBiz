import {
  forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Eye, EyeOff, Search as SearchIcon, ChevronLeft, Inbox } from "lucide-react";
import { initials } from "@windveal/shared";
import { useToast } from "./overlays";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
};
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "primary", size = "md", block, loading, icon, className, children, disabled, type = "button", ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading}
      className={cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", className)} {...rest}>
      {loading ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, bordered, badge, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; bordered?: boolean; badge?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx("icon-btn", bordered && "bordered", className)} {...rest}>
      {children}
      {badge && <i className="dot-badge" />}
    </button>
  );
}

type FieldProps = { label?: ReactNode; hint?: ReactNode; error?: string; optional?: boolean; className?: string; children: ReactNode; htmlFor?: string };
export function Field({ label, hint, error, optional, className, children, htmlFor }: FieldProps) {
  return (
    <div className={cx("field", className)}>
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          <span>{label}</span>
          {optional && <span className="opt">Optional</span>}
        </label>
      )}
      {children}
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string; optional?: boolean; wrapClassName?: string };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, optional, wrapClassName, id, className, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  const el = <input ref={ref} id={fid} aria-invalid={!!error} className={cx("input", className)} {...rest} />;
  if (!label && !hint && !error) return el;
  return <Field label={label} hint={hint} error={error} optional={optional} className={wrapClassName} htmlFor={fid}>{el}</Field>;
});

export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput({ label, hint, error, optional, wrapClassName, id, ...rest }, ref) {
  const [show, setShow] = useState(false);
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} className={wrapClassName} htmlFor={fid}>
      <div className="input-wrap">
        <input ref={ref} id={fid} aria-invalid={!!error} type={show ? "text" : "password"} className="input" {...rest} />
        <IconButton className="trail" label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff size={17} /> : <Eye size={17} />}
        </IconButton>
      </div>
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: ReactNode; hint?: ReactNode; error?: string; optional?: boolean; wrapClassName?: string;
  options?: (string | { value: string; label: string })[]; placeholder?: string;
};
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, optional, wrapClassName, options, placeholder, id, className, children, ...rest }, ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  const el = (
    <select ref={ref} id={fid} aria-invalid={!!error} className={cx("select", className)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
      {children}
    </select>
  );
  if (!label && !hint && !error) return el;
  return <Field label={label} hint={hint} error={error} optional={optional} className={wrapClassName} htmlFor={fid}>{el}</Field>;
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string; optional?: boolean; wrapClassName?: string };
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, optional, wrapClassName, id, className, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  const el = <textarea ref={ref} id={fid} aria-invalid={!!error} className={cx("textarea", className)} {...rest} />;
  if (!label && !hint && !error) return el;
  return <Field label={label} hint={hint} error={error} optional={optional} className={wrapClassName} htmlFor={fid}>{el}</Field>;
});

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Card({ title, subtitle, actions, children, className, flush }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx("card", flush && "card-flush", className)}>
      {(title || actions) && (
        <div className="card-head" style={flush ? { padding: "18px 20px 0" } : undefined}>
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = "ok" | "warn" | "red" | "blue" | "grey" | "violet";
export function Pill({ tone = "blue", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx("pill", `pill-${tone}`, className)}>{children}</span>;
}

const AV_COLORS = [["#DCE4FA", "#263F91"], ["#FDEBD3", "#8A5A10"], ["#DDF3EA", "#146B49"], ["#EEE3FB", "#5B2E91"], ["#FDE7E7", "#A23434"], ["#F1F2F6", "#38425E"]];
export function Avatar({ name, size = 34, src }: { name: string; size?: number; src?: string | null }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = AV_COLORS[h % AV_COLORS.length]!;
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.max(10, size * 0.34) }} title={name}>
      {src ? <img src={src} alt="" /> : initials(name || "?")}
    </span>
  );
}

export function Stat({ label, value, note, up }: { label: ReactNode; value: ReactNode; note?: ReactNode; up?: boolean }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b>{value}</b>
      {note && <em className={up ? "up" : undefined}>{note}</em>}
    </div>
  );
}

export type TabItem = { key: string; label: ReactNode; count?: number };
export function Tabs({ items, value, onChange }: { items: TabItem[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} className={cx("tab", t.key === value && "active")} onClick={() => onChange(t.key)}>
          {t.label}
          {!!t.count && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="search">
      <SearchIcon size={16} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { label: string; onClick: () => void } }) {
  return (
    <>
      {back && (
        <button className="back-link btn-ghost" style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }} onClick={back.onClick}>
          <ChevronLeft size={16} />{back.label}
        </button>
      )}
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </>
  );
}

export function EmptyState({ title, children, action, icon }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <span className="ic">{icon ?? <Inbox size={24} />}</span>
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="loading" role="status" aria-label={label}><span className="spinner" /></div>;
}

export function Notice({ tone = "info", icon, children, action }: { tone?: "info" | "warn" | "error" | "ok"; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  if (tone === "error") return <ErrorNotice action={action}>{children}</ErrorNotice>;
  return (
    <div className={cx("notice", `notice-${tone}`)}>
      {icon}
      <span>{children}</span>
      {action && <span className="act">{action}</span>}
    </div>
  );
}

/** Errors are shown as toasts. Only a retry action (if any) stays on the page. */
function ErrorNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const toast = useToast();
  const key = typeof children === "string" ? children : null;
  const shown = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (shown.current === key && shown.current !== undefined) return;
    shown.current = key;
    toast(children, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return action ? <div className="notice-retry">{action}</div> : null;
}

export function Progress({ value }: { value: number }) {
  return <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
