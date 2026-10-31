import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Coffee, LogIn, LogOut, Play, Timer } from "lucide-react";
import { Menu, useConfirm, useToast } from "@windveal/ui";
import { api } from "../../lib/api";
import { fmtTime } from "../../lib/format";

type Break = { start: string; end: string | null };
export type ClockRecord = { clockIn: string | null; clockOut: string | null; breaks: Break[]; onBreak: boolean };
export type MyClock = { employee: { id: string; firstName: string } | null; record: ClockRecord | null; date: string };
export type ClockState = "none" | "out" | "in" | "break" | "done";

/** "7h 32m", or "7h 32m 05s" with seconds. */
export function fmtDuration(ms: number, seconds = false) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h}h ${String(m).padStart(2, "0")}m${seconds ? ` ${String(s).padStart(2, "0")}s` : ""}`;
}

export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

/** Time worked from clock in to `until`, not counting breaks. */
function worked(r: ClockRecord, until: number) {
  if (!r.clockIn) return 0;
  const breakMs = r.breaks.reduce((a, b) => a + Math.max(0, Math.min(until, b.end ? Date.parse(b.end) : until) - Date.parse(b.start)), 0);
  return until - Date.parse(r.clockIn) - breakMs;
}

/**
 * The signed-in person's clock for today: state, time worked (live only for them, and only while working),
 * and the actions. Clocking out asks first.
 */
export function useMyClock() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const me = useQuery({ queryKey: ["people", "attendance", "me"], queryFn: () => api.get<MyClock>("/api/people/attendance/me"), staleTime: 60_000 });
  const r = me.data?.record ?? null;
  const state: ClockState = !me.data?.employee ? "none" : r?.clockOut ? "done" : r?.onBreak ? "break" : r?.clockIn ? "in" : "out";
  const now = useNow(1000, state === "in");
  const until = r?.clockOut ? Date.parse(r.clockOut) : state === "break" ? Date.parse(r!.breaks[r!.breaks.length - 1]!.start) : now;
  const workedMs = r?.clockIn ? worked(r, until) : 0;
  const breakMs = r ? r.breaks.reduce((a, b) => a + Math.max(0, (b.end ? Date.parse(b.end) : now) - Date.parse(b.start)), 0) : 0;
  const act = useMutation({
    mutationFn: (what: "clock-in" | "clock-out" | "pause" | "resume") => api.post<{ minutes?: number }>(`/api/people/attendance/${what}`),
    onSuccess: (res, what) => {
      toast({
        "clock-in": "You're clocked in",
        "clock-out": `You're clocked out. You worked ${fmtDuration((res.minutes ?? 0) * 60_000)} today.`,
        pause: "On a break. Your time is paused.",
        resume: "Welcome back. Your time is running again.",
      }[what]);
      qc.invalidateQueries({ queryKey: ["people", "attendance"] });
    },
  });
  const clockOut = async () => {
    if (await confirm({ title: "Clock out for today?", message: `You've worked ${fmtDuration(workedMs)} today.`, confirmLabel: "Clock out", danger: false })) act.mutate("clock-out");
  };
  return {
    state, record: r, workedMs, breakMs, busy: act.isPending, dialog, loading: me.isLoading,
    clockIn: () => act.mutate("clock-in"), pause: () => act.mutate("pause"), resume: () => act.mutate("resume"), clockOut,
  };
}

const LABEL: Record<Exclude<ClockState, "none">, string> = { out: "Not clocked in", in: "Working", break: "On a break", done: "Done for today" };

/** Your clock in the top bar: shows your time; click it to clock in, take a break, resume or clock out. */
export function HeaderClock() {
  const c = useMyClock();
  if (c.loading || c.state === "none") return null;
  const s = c.state;
  return (
    <>
      <Menu trigger={(toggle, open) => (
        <button className={`hclock hclock-${s}`} onClick={toggle} aria-expanded={open} aria-label={`Your time today: ${LABEL[s]}`}>
          {s === "in" ? <i className="hclock-dot" /> : s === "break" ? <Coffee size={15} /> : <Timer size={15} />}
          <span className="hclock-time">{s === "out" ? "Clock in" : fmtDuration(c.workedMs, s === "in")}</span>
          <ChevronDown size={14} className="hclock-caret" />
        </button>
      )}>
        {(close) => (
          <div className="hclock-menu">
            <div className="hclock-head">
              <b>{LABEL[s]}</b>
              <small>
                {c.record?.clockIn ? `In ${fmtTime(c.record.clockIn)}` : "You haven't clocked in today."}
                {c.record?.clockOut ? ` · Out ${fmtTime(c.record.clockOut)}` : ""}
                {c.breakMs >= 60_000 ? ` · Breaks ${fmtDuration(c.breakMs)}` : ""}
              </small>
            </div>
            {s === "out" && <button onClick={() => { close(); c.clockIn(); }} disabled={c.busy}><LogIn size={16} />Clock in</button>}
            {s === "in" && <button onClick={() => { close(); c.pause(); }} disabled={c.busy}><Coffee size={16} />Take a break</button>}
            {s === "break" && <button onClick={() => { close(); c.resume(); }} disabled={c.busy}><Play size={16} />Resume</button>}
            {(s === "in" || s === "break") && <button className="danger" onClick={() => { close(); c.clockOut(); }} disabled={c.busy}><LogOut size={16} />Clock out</button>}
            {s === "done" && <p className="hclock-done">You worked {fmtDuration(c.workedMs)} today.</p>}
          </div>
        )}
      </Menu>
      {c.dialog}
    </>
  );
}
