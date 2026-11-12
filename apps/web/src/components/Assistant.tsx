import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, FileSpreadsheet, Paperclip, Sparkles, X } from "lucide-react";
import { Button, Drawer, IconButton, useToast } from "@windveal/ui";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/session";

/** The conversation in the standard chat format; it lives only in this window and is gone when the panel closes. */
type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
type Proposal = { toolCallId: string; tool: string; summary: string };
type Item =
  | { kind: "you"; text: string }
  | { kind: "ai"; text: string }
  | { kind: "proposal"; proposal: Proposal; answer?: "done" | "cancelled" | "failed" }
  | { kind: "file"; name: string; jobId: string };
type Status = { connected: boolean; model: string | null; used: number; limit: number };

const STARTERS = ["How much leave do I have left?", "What's on my plate this week?", "Remind me to call a client tomorrow"];

/** WindVeal AI: ask about anything you can see in WindVeal, or ask it to do something (you confirm first). */
export function Assistant() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label="WindVeal AI" onClick={() => setOpen(true)} className="ai-btn"><Sparkles size={20} /></IconButton>
      {open && <AssistantPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function AssistantPanel({ onClose }: { onClose: () => void }) {
  const { org } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["ai", "status"], queryFn: () => api.get<Status>("/api/ai/status") });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [items, busy]);

  const s = status.data;
  const ready = !!s?.connected && s.limit > 0 && s.used < s.limit;
  const handle = (r: { messages: ChatMessage[]; reply?: string; proposal?: Proposal }) => {
    setMessages(r.messages);
    setItems((x) => [...x, r.proposal ? { kind: "proposal", proposal: r.proposal } : { kind: "ai", text: r.reply ?? "" }]);
    void qc.invalidateQueries({ queryKey: ["ai", "status"] });
  };
  const fail = (e: unknown) => setItems((x) => [...x, { kind: "ai", text: e instanceof ApiError ? e.message : "Something went wrong. Try again." }]);

  const send = async (q = text) => {
    const content = q.trim();
    if (!content || busy || !ready) return;
    setText("");
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setItems((x) => [...x, { kind: "you", text: content }]);
    setBusy(true);
    try { handle(await api.post("/api/ai/chat", { messages: next })); } catch (e) { setMessages(next); fail(e); }
    finally { setBusy(false); }
  };

  const answer = async (index: number, p: Proposal, confirm: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{ messages: ChatMessage[]; reply?: string; proposal?: Proposal; done: boolean }>("/api/ai/confirm", { messages, toolCallId: p.toolCallId, confirm });
      setItems((x) => x.map((it, i) => (i === index && it.kind === "proposal" ? { ...it, answer: confirm ? (r.done ? "done" : "failed") : "cancelled" } : it)));
      handle(r);
      // Whatever it changed shows straight away elsewhere in WindVeal.
      if (r.done) void qc.invalidateQueries();
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  };

  // A spreadsheet dropped in the chat goes to Import data, where it's split into tables and reviewed before anything is added.
  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.upload<{ job: { id: string } }>("/api/imports/upload", f);
      setItems((x) => [...x, { kind: "file", name: f.name, jobId: r.job.id }]);
    } catch (e) { toast(e instanceof ApiError ? e.message : "Upload failed", "error"); }
    finally { setBusy(false); }
  };

  const pending = items.some((it) => it.kind === "proposal" && !it.answer);
  return (
    <Drawer open onClose={onClose} title="WindVeal AI" headerExtra={<span className="ai-mark"><Sparkles size={16} /></span>}
      footer={<div className="ai-foot">
        <div className="ai-compose">
          <IconButton label="Add a spreadsheet" onClick={() => file.current?.click()} disabled={!ready || busy}><Paperclip size={18} /></IconButton>
          <input ref={file} type="file" accept=".xlsx,.csv" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
          <textarea value={text} rows={1} disabled={!ready} placeholder={ready ? "Ask anything, or ask it to do something" : "WindVeal AI isn't available"}
            aria-label="Message WindVeal AI" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <IconButton label="Send" onClick={() => void send()} disabled={!ready || busy || pending || !text.trim()} className="ai-send"><ArrowUp size={18} /></IconButton>
        </div>
        {s?.connected && s.limit > 0 && <p className="ai-allowance">{s.used} of {s.limit} this month</p>}
      </div>}>
      <div className="ai-body">
        {status.isLoading ? null : !s?.connected ? (
          <div className="ai-empty"><Sparkles size={26} /><b>WindVeal AI isn't switched on yet</b><p>It will appear here once it's connected. Everything else in WindVeal works as normal.</p></div>
        ) : s.limit === 0 ? (
          <div className="ai-empty"><Sparkles size={26} /><b>WindVeal AI comes with Growth</b><p>Ask about anything in {org.name}, or have it add tasks, leads and leave for you.</p><Link className="btn btn-primary" to="/billing" onClick={onClose}>See plans</Link></div>
        ) : !items.length ? (
          <div className="ai-empty">
            <Sparkles size={26} /><b>Ask about anything in {org.name}</b>
            <p>It only sees what you can see, and asks before changing anything. Nothing is saved: closing this clears the chat.</p>
            <div className="ai-starters">{STARTERS.map((q) => <button key={q} onClick={() => void send(q)}>{q}</button>)}</div>
          </div>
        ) : items.map((it, i) => {
          if (it.kind === "you") return <div key={i} className="ai-msg you">{it.text}</div>;
          if (it.kind === "ai") return <div key={i} className="ai-msg">{it.text}</div>;
          if (it.kind === "file") return (
            <div key={i} className="ai-card"><FileSpreadsheet size={18} /><div className="grow"><b>{it.name}</b><small>Split into tables. Check them before anything is added.</small></div>
              <Link className="btn btn-secondary btn-sm" to={`/import/${it.jobId}/sheets`} onClick={onClose}>Review</Link></div>
          );
          return (
            <div key={i} className={`ai-card proposal ${it.answer ?? ""}`}>
              <div className="grow"><small>{it.answer === "done" ? "Done" : it.answer === "cancelled" ? "Cancelled" : it.answer === "failed" ? "Didn't work" : "Do this?"}</small><b>{it.proposal.summary}</b></div>
              {!it.answer && <div className="row">
                <Button variant="secondary" size="sm" icon={<X size={14} />} disabled={busy} onClick={() => void answer(i, it.proposal, false)}>Cancel</Button>
                <Button size="sm" icon={<Check size={14} />} disabled={busy} onClick={() => void answer(i, it.proposal, true)}>Confirm</Button>
              </div>}
            </div>
          );
        })}
        {busy && <div className="ai-msg ai-typing"><i /><i /><i /></div>}
        <div ref={end} />
      </div>
    </Drawer>
  );
}
