import type { ReactNode } from "react";
import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { Button, IconButton, Menu } from "@windveal/ui";

export type Action = { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string };

/**
 * One "New" button for pages that can create several kinds of thing (e.g. company, deal, lead).
 * With a single option it's just that button.
 */
export function NewMenu({ items, label = "New" }: { items: Action[]; label?: string }) {
  if (!items.length) return null;
  if (items.length === 1) {
    const a = items[0]!;
    return <Button icon={a.icon ?? <Plus size={16} />} onClick={a.onClick} disabled={a.disabled}>{a.label}</Button>;
  }
  return (
    <Menu trigger={(toggle, open) => (
      <Button icon={<Plus size={16} />} onClick={toggle} aria-expanded={open}>{label}<ChevronDown size={15} /></Button>
    )}>
      {(close) => <>{items.map((a) => (
        <button key={a.label} disabled={a.disabled} title={a.title} onClick={() => { close(); a.onClick(); }}>{a.icon}{a.label}</button>
      ))}</>}
    </Menu>
  );
}

/** Less-used actions tucked into a "⋯" menu, so a page shows one main button. */
export function MoreMenu({ items, label = "More actions", className }: { items: (Action | false | null | undefined)[]; label?: string; className?: string }) {
  const list = items.filter(Boolean) as Action[];
  if (!list.length) return null;
  return (
    <Menu trigger={(toggle) => <IconButton label={label} bordered className={className} onClick={toggle}><MoreHorizontal size={18} /></IconButton>}>
      {(close) => <>{list.map((a) => (
        <button key={a.label} className={a.danger ? "danger" : undefined} disabled={a.disabled} title={a.title} onClick={() => { close(); a.onClick(); }}>{a.icon}{a.label}</button>
      ))}</>}
    </Menu>
  );
}
