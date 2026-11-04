import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BellRing, Pencil } from "lucide-react";
import { Button, Card, Loading, Pill, Switch, useToast } from "@windveal/ui";
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_KEYS, type NotificationKind } from "@windveal/shared";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useNotificationPrefs } from "../../layouts/AppShell";

const browserState = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

/** Profile, Notifications: what you're told about, and whether it pops up on your computer. Everything is on to start. */
export function NotificationSettings() {
  const { user } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useNotificationPrefs();
  const [editing, setEditing] = useState(false);
  const [off, setOff] = useState<NotificationKind[]>([]);
  const [desktop, setDesktop] = useState(true);
  const [saving, setSaving] = useState(false);
  const [browser, setBrowser] = useState(browserState);
  const reset = () => { if (q.data) { setOff([...q.data.prefs.off]); setDesktop(q.data.prefs.desktop); } };
  useEffect(reset, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return <Loading />;
  // WindVeal's own alerts only matter to WindVeal staff.
  const kinds = NOTIFICATION_KIND_KEYS.filter((k) => k !== "windveal" || user.platformAdmin);
  const save = async () => {
    setSaving(true);
    try {
      await api.put("/api/notifications/settings", { off, desktop });
      await Promise.all([qc.invalidateQueries({ queryKey: ["notification-prefs"] }), qc.invalidateQueries({ queryKey: ["notifications"] })]);
      toast("Notification settings saved"); setEditing(false);
    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save", "error"); }
    finally { setSaving(false); }
  };
  const allow = async () => { if (typeof Notification !== "undefined") setBrowser(await Notification.requestPermission()); };
  return (
    <div className="ac-page">
      <Card title="What you're told about" subtitle="Turn off anything you don't need. You won't get those at all, in WindVeal or on your computer."
        actions={editing ? <div className="row">
          <Button variant="secondary" onClick={() => { reset(); setEditing(false); }} disabled={saving}>Cancel</Button>
          <Button loading={saving} onClick={save}>Save</Button>
        </div> : <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit</Button>}>
        {kinds.map((k) => {
          const on = !off.includes(k);
          return (
            <div key={k} className="ac-row">
              <div><b>{NOTIFICATION_KINDS[k].name}</b><small>{NOTIFICATION_KINDS[k].what}</small></div>
              <div className="ac-right">
                {editing ? <Switch label={NOTIFICATION_KINDS[k].name} checked={on} onChange={(v) => setOff(v ? off.filter((x) => x !== k) : [...off, k])} />
                  : <Pill tone={on ? "ok" : "grey"}>{on ? "On" : "Off"}</Pill>}
              </div>
            </div>
          );
        })}
      </Card>
      <Card title="On your computer" subtitle="New notifications pop up even when WindVeal isn't the window you're looking at.">
        <div className="ac-row">
          <div><b>Pop-up notifications</b>
            <small>{browser === "granted" ? "Allowed on this computer." : browser === "denied" ? "Blocked in this browser's settings. Allow notifications for WindVeal there to get them."
              : browser === "unsupported" ? "This browser can't show them." : "This computer needs your permission first."}</small>
          </div>
          <div className="ac-right">
            {editing ? <Switch label="Pop-up notifications" checked={desktop} onChange={setDesktop} />
              : <Pill tone={desktop ? "ok" : "grey"}>{desktop ? "On" : "Off"}</Pill>}
          </div>
        </div>
        {desktop && browser === "default" && <Button variant="secondary" icon={<BellRing size={15} />} onClick={allow} style={{ marginTop: 12 }}>Allow on this computer</Button>}
      </Card>
    </div>
  );
}
