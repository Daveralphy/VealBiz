import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, Clock, Info, MessageCircle, RefreshCw, Search, TrendingUp } from "lucide-react";
import { Button, PageHeader, useToast } from "@windveal/ui";
import { AREA_NAMES, type AssistantArea, type Briefing, type BriefingItem } from "@windveal/shared";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import { useVeal } from "../components/Veal";

type Status = { connected: boolean; used: number; limit: number };
type ChatRow = { id: string; title: string; area: string; updatedAt: string };

const SUGGESTED: Record<AssistantArea, string[]> = {
  me: ["How much leave do I have left?", "Did I clock in on time this week?", "What's on my plate this week?"],
  people: ["Who's off this week?", "Who isn't in yet today?", "Which leave requests are waiting?"],
  recruitment: ["Which jobs have no candidates yet?", "Who applied this week?", "Which interviews are coming up?"],
  crm: ["Which deals could close this month?", "Who should I call first today?", "Which leads are going cold?"],
  workflows: ["What's overdue?", "What's waiting for my approval?", "Remind me to send the report on Friday"],
  documents: ["Which files were added this week?", "Find the latest contract", "Help me bring in a spreadsheet"],
  insights: ["How are sales this month?", "How is hiring going?", "What changed since last month?"],
};
const TONE_ICON: Record<BriefingItem["tone"], JSX.Element> = {
  bad: <Clock size={18} />, warn: <AlertTriangle size={18} />, good: <TrendingUp size={18} />, info: <Info size={18} />,
};

const when = (iso: string) => {
  const d = new Date(iso), today = new Date();
  const time = d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const ago = (iso: string) => {
  const d = new Date(iso), days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/**
 * An area's Assistant: what Veal sees there right now (worked out once a day and kept, or again on request),
 * a box to ask about it, and the person's recent chats.
 */
export function AssistantPage({ area }: { area: AssistantArea }) {
  const { org } = useSession();
  const veal = useVeal();
  const qc = useQueryClient();
  const toast = useToast();
  const [ask, setAsk] = useState("");
  const name = AREA_NAMES[area];
  useEffect(() => { document.title = `Assistant · ${name} · WindVeal`; }, [name]);

  const status = useQuery({ queryKey: ["ai", "status"], queryFn: () => api.get<Status>("/api/ai/status") });
  const s = status.data;
  const usable = !!s?.connected && s.limit > 0;
  // Only the last saved look: opening the page never runs Veal. The person asks for a look when they want one.
  const briefing = useQuery({
    queryKey: ["ai", "briefing", area], enabled: usable, retry: false,
    queryFn: async () => (await api.get<{ briefing: Briefing | null }>(`/api/ai/briefing/${area}`)).briefing,
  });
  const again = useMutation({
    mutationFn: () => api.post<{ briefing: Briefing }>(`/api/ai/briefing/${area}/refresh`),
    onSuccess: (r) => { qc.setQueryData(["ai", "briefing", area], r.briefing); void qc.invalidateQueries({ queryKey: ["ai", "status"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Veal couldn't look just now. Try in a moment.", "error"),
  });
  const chats = useQuery({ queryKey: ["ai", "chats", area], queryFn: () => api.get<{ chats: ChatRow[]; keepDays: number }>(`/api/ai/chats?area=${area}`) });

  const send = (q: string) => { if (q.trim()) { veal({ ask: q.trim() }); setAsk(""); } };
  const b = briefing.data;
  const looking = again.isPending;
  const spent = s ? s.used >= s.limit : true;

  return (
    <div className="assist">
      <PageHeader title="Assistant" subtitle={`What Veal sees in ${name} right now.`}
        actions={usable && b && <div className="assist-upd">
          {!looking && <span className="muted hide-sm">Looked {when(b.at)}</span>}
          <Button variant="secondary" icon={<RefreshCw size={15} />} loading={looking} disabled={spent} onClick={() => again.mutate()}>Look again</Button>
        </div>} />
      <div className="assist-grid">
        <div>
          {status.isLoading ? null : !s?.connected ? (
            <div className="card assist-empty"><MessageCircle size={26} /><b>Veal isn't switched on yet</b><p>Once it's connected, it will look at {name} each day and tell you what needs your attention.</p></div>
          ) : s.limit === 0 ? (
            <div className="card assist-empty"><MessageCircle size={26} /><b>Veal comes with Growth</b><p>Each day, Veal looks at {name} in {org.name} and tells you what needs your attention.</p><Link className="btn btn-primary" to="/billing">See plans</Link></div>
          ) : briefing.isLoading ? null : looking && !b ? (
            <div className="card assist-empty"><span className="veal-typing"><i /><i /><i /></span><b>Veal is having a look...</b><p>It reads what you can see in {name}. This can take a minute.</p></div>
          ) : !b ? (
            <div className="card assist-empty"><MessageCircle size={26} /><b>Veal hasn't looked at {name} yet</b>
              <p>Ask it to look, and it will tell you what needs your attention here, with a button to each thing. It uses one of your business's Veal requests.</p>
              <Button icon={<Search size={15} />} disabled={spent} onClick={() => again.mutate()}>Look now</Button>
              {spent && <small className="muted">Your business has used all its Veal requests this month.</small>}
            </div>
          ) : b ? (
            <>
              <div className="assist-sum"><span className="veal-orb"><MessageCircle size={17} /></span><p>{b.summary}</p></div>
              {b.items.length > 0 && <section className="card">
                <div className="section-label">Worth your attention</div>
                {b.items.map((it, i) => (
                  <div key={i} className="assist-item">
                    <span className={`assist-dot ${it.tone}`}>{TONE_ICON[it.tone]}</span>
                    <div className="grow"><b>{it.title}</b>{it.detail && <span>{it.detail}</span>}</div>
                    {it.link && <Link className="btn btn-secondary btn-sm" to={it.link.to}>{it.link.label}</Link>}
                  </div>
                ))}
              </section>}
            </>
          ) : null}
        </div>
        <aside className="assist-side">
          <section className="card">
            <div className="section-label">Ask about {name}</div>
            <form className="assist-ask" onSubmit={(e) => { e.preventDefault(); send(ask); }}>
              <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask Veal..." aria-label={`Ask Veal about ${name}`} disabled={!usable} />
              <button type="submit" className="veal-send" aria-label="Ask" disabled={!usable || !ask.trim()}><ArrowUp size={16} /></button>
            </form>
            <div className="assist-sugg">{SUGGESTED[area].map((q) => <button key={q} disabled={!usable} onClick={() => send(q)}>{q}</button>)}</div>
          </section>
          <section className="card assist-hist">
            <div className="section-label">Your recent chats</div>
            {chats.data?.chats.length ? chats.data.chats.slice(0, 8).map((c) => (
              <button key={c.id} onClick={() => veal({ chatId: c.id })}><b>{c.title}</b><small>{ago(c.updatedAt)}</small></button>
            )) : <p className="muted">Chats you start about {name} show here.</p>}
            <p className="assist-note">Chats are kept for {chats.data?.keepDays ?? 15} days, then cleared.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
