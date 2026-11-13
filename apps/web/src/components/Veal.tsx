import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUp, Check, FileSpreadsheet, Maximize2, MessageCircle, Minus, Paperclip, Plus, X } from "lucide-react";
import { Button, useToast } from "@windveal/ui";
import { ASSISTANT_AREAS, type AssistantArea, type VealLink } from "@windveal/shared";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/session";

/** The conversation in the standard chat format, plus WindVeal's extras (buttons, files, confirm cards). */
export type ChatMessage =
  | { role: "user"; content: string; file?: { name: string; jobId: string } }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; links?: VealLink[]; proposal?: string }
  | { role: "tool"; tool_call_id: string; content: string };
type Status = { connected: boolean; model: string | null; used: number; limit: number };
type Answer = { messages: ChatMessage[]; reply?: string; proposal?: { toolCallId: string; tool: string; summary: string }; done?: boolean };

const STARTERS = ["How much leave do I have left?", "What's on my plate this week?", "Remind me to call a client tomorrow"];
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ (Math.random() * 16) >> (+c / 4)).toString(16)));
export const assistantPath = (area: string) => (area === "me" || !(ASSISTANT_AREAS as readonly string[]).includes(area) ? "/me/assistant" : `/${area}/assistant`);

// ---------------- opening Veal from anywhere ----------------

type Open = (o?: { chatId?: string; ask?: string }) => void;
const VealCtx = createContext<{ open: Open }>({ open: () => {} });
/** Opens the chat window: a saved chat, or a new one with a first question. */
export const useVeal = () => useContext(VealCtx).open;

// ---------------- where the button sits ----------------

const BTN = { w: 196, h: 52 };
const WIN = { w: 384, h: 560 };
const MARGIN = 12;
type Pos = { r: number; b: number }; // distance from the right and bottom of the window
const loadPos = (): Pos => { try { const p = JSON.parse(localStorage.getItem("veal-pos") ?? ""); if (typeof p?.r === "number") return p; } catch { /* first time */ } return { r: 28, b: 28 }; };
const savePos = (p: Pos) => { try { localStorage.setItem("veal-pos", JSON.stringify(p)); } catch { /* private window */ } };
const clampPos = (p: Pos): Pos => ({
  r: Math.min(Math.max(p.r, MARGIN), Math.max(MARGIN, window.innerWidth - BTN.w - MARGIN)),
  b: Math.min(Math.max(p.b, MARGIN), Math.max(MARGIN, window.innerHeight - BTN.h - MARGIN)),
});

/** The window opens where the button was: growing up and left from it, or down and right, whichever fits. */
function windowAt(p: Pos) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(WIN.w, vw - MARGIN * 2), h = Math.min(WIN.h, vh - MARGIN * 2);
  const btnLeft = vw - p.r - BTN.w, btnTop = vh - p.b - BTN.h;
  let left = btnLeft + BTN.w / 2 > vw / 2 ? vw - p.r - w : btnLeft;
  let top = btnTop + BTN.h / 2 > vh / 2 ? vh - p.b - h : btnTop;
  left = Math.min(Math.max(left, MARGIN), vw - w - MARGIN);
  top = Math.min(Math.max(top, MARGIN), vh - h - MARGIN);
  return { left, top, w, h };
}

/** Drag to move; a press that doesn't move counts as a click. */
function useDrag(onMove: (dx: number, dy: number) => void, onClick?: () => void) {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return {
    onPointerDown: (e: RPointerEvent) => {
      if ((e.target as HTMLElement).closest("button:not([data-drag]), a, textarea, input")) return;
      start.current = { x: e.clientX, y: e.clientY, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: RPointerEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.moved && Math.hypot(dx, dy) < 5) return;
      s.moved = true;
      onMove(dx, dy);
      s.x = e.clientX; s.y = e.clientY;
    },
    onPointerUp: () => { const s = start.current; start.current = null; if (s && !s.moved) onClick?.(); },
  };
}

/** Veal: the floating "Chat with Veal" button on every screen, and the chat window it opens. */
export function VealProvider({ area, children }: { area: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<{ chatId?: string; ask?: string; n: number } | null>(null);
  const [pos, setPos] = useState<Pos>(() => clampPos(loadPos()));
  useEffect(() => {
    const fit = () => setPos((p) => clampPos(p));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const show = useCallback<Open>((o) => { setRequest(o ? { ...o, n: Date.now() } : null); setOpen(true); }, []);
  const drag = useDrag((dx, dy) => setPos((p) => clampPos({ r: p.r - dx, b: p.b - dy })), () => setOpen(true));
  useEffect(() => { savePos(pos); }, [pos]);

  return (
    <VealCtx.Provider value={{ open: show }}>
      {children}
      {open
        ? <ChatWindow at={windowAt(pos)} area={area} request={request} onMinimise={() => setOpen(false)} />
        : <button type="button" className="veal-fab" style={{ right: pos.r, bottom: pos.b }} {...drag} data-drag
            aria-label="Chat with Veal" onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}>
            <span className="veal-orb"><MessageCircle size={17} /></span>Chat with Veal<span className="veal-grip" aria-hidden><i /><i /><i /><i /><i /><i /></span>
          </button>}
    </VealCtx.Provider>
  );
}

// ---------------- the chat window ----------------

type Item =
  | { kind: "you"; text: string }
  | { kind: "ai"; text: string; links?: VealLink[] }
  | { kind: "file"; name: string }
  | { kind: "proposal"; toolCallId: string; summary: string; answer?: "done" | "cancelled" | "failed" };

/** What to show for a conversation: worked out from the messages, so a saved chat looks the same when reopened. */
function itemsOf(messages: ChatMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push(m.file ? { kind: "file", name: m.file.name } : { kind: "you", text: m.content });
    else if (m.role === "assistant") {
      const change = m.proposal ? m.tool_calls?.[0] : undefined;
      if (change && m.proposal) {
        const answer = messages.find((x) => x.role === "tool" && x.tool_call_id === change.id) as { content: string } | undefined;
        out.push({ kind: "proposal", toolCallId: change.id, summary: m.proposal,
          answer: !answer ? undefined : /"cancelled":true/.test(answer.content) ? "cancelled" : /"error"/.test(answer.content) ? "failed" : "done" });
      } else if (m.content) out.push({ kind: "ai", text: m.content, links: m.links });
    }
  }
  return out;
}

/** Plain text with "- " lists and **bold**, which is all Veal writes. */
function Rich({ text }: { text: string }) {
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{bold(l)}</li>)}</ul>); list = []; };
  for (const line of text.split("\n")) {
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) { list.push(li[1]!); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{bold(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function ChatWindow({ at, area, request, onMinimise }: { at: { left: number; top: number; w: number; h: number }; area: string; request: { chatId?: string; ask?: string; n: number } | null; onMinimise: () => void }) {
  const { org } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const status = useQuery({ queryKey: ["ai", "status"], queryFn: () => api.get<Status>("/api/ai/status") });
  const [chatId, setChatId] = useState(newId);
  const [chatArea, setChatArea] = useState(area);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notes, setNotes] = useState<{ after: number; text: string }[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState(at);
  const body = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Only the conversation scrolls, never the page behind it.
  useLayoutEffect(() => { const el = body.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, notes, busy]);
  useEffect(() => { input.current?.focus(); }, []);
  const drag = useDrag((dx, dy) => setPlace((p) => ({
    ...p, left: Math.min(Math.max(p.left + dx, MARGIN), window.innerWidth - p.w - MARGIN), top: Math.min(Math.max(p.top + dy, MARGIN), window.innerHeight - p.h - MARGIN),
  })));

  const s = status.data;
  const ready = !!s?.connected && s.limit > 0 && s.used < s.limit;
  const saving = { chatId, area: chatArea === "home" || (ASSISTANT_AREAS as readonly string[]).includes(chatArea) ? chatArea : "home" };
  const after = (r: Answer) => {
    setMessages(r.messages);
    void qc.invalidateQueries({ queryKey: ["ai", "status"] });
    void qc.invalidateQueries({ queryKey: ["ai", "chats"] });
  };
  /** An error shows in the conversation, under whatever it was about. */
  const fail = (e: unknown, upTo: ChatMessage[]) => setNotes((n) => [...n, { after: itemsOf(upTo).length, text: e instanceof ApiError ? e.message : "Something went wrong. Try again." }]);

  const send = async (q = text) => {
    const content = q.trim();
    if (!content || busy || !ready) return;
    setText("");
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setBusy(true);
    try { after(await api.post<Answer>("/api/ai/chat", { messages: next, ...saving })); } catch (e) { fail(e, next); }
    finally { setBusy(false); }
  };

  const answer = async (toolCallId: string, confirm: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<Answer>("/api/ai/confirm", { messages, toolCallId, confirm, ...saving });
      after(r);
      // Whatever it changed shows straight away elsewhere in WindVeal.
      if (r.done) void qc.invalidateQueries();
    } catch (e) { fail(e, messages); }
    finally { setBusy(false); }
  };

  // A spreadsheet goes to Import data (nothing is added yet); Veal then says what it sees and where it belongs.
  const upload = async (f?: File) => {
    if (!f || busy) return;
    setBusy(true);
    try {
      const up = await api.upload<{ job: { id: string } }>("/api/imports/upload", f);
      after(await api.post<Answer>("/api/ai/files", { jobId: up.job.id, messages, ...saving }));
    } catch (e) { toast(e instanceof ApiError ? e.message : "Upload failed", "error"); }
    finally { setBusy(false); }
  };

  const fresh = () => { setChatId(newId()); setChatArea(area); setMessages([]); setNotes([]); setText(""); };

  // Opened from an Assistant page: a saved chat, or a first question.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handled.current === request.n || !s) return;
    handled.current = request.n;
    if (request.chatId) {
      api.get<{ id: string; area: string; messages: ChatMessage[] }>(`/api/ai/chats/${request.chatId}`)
        .then((c) => { setChatId(c.id); setChatArea(c.area); setMessages(c.messages); setNotes([]); })
        .catch((e) => toast(e instanceof ApiError ? e.message : "That chat couldn't be opened", "error"));
    } else if (request.ask) { fresh(); setTimeout(() => void send(request.ask), 0); }
  }, [request, s]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = itemsOf(messages);
  const pending = items.some((it) => it.kind === "proposal" && !it.answer);
  const go = (to: string) => nav(to);

  return (
    <div className="veal-win" role="dialog" aria-label="Chat with Veal" style={{ left: place.left, top: place.top, width: place.w, height: place.h }}>
      <div className="veal-head" {...drag}>
        <span className="veal-orb"><MessageCircle size={16} /></span>
        <div className="grow"><b>Veal</b><small>Asks before changing anything.</small></div>
        {messages.length > 0 && <button className="veal-ic" title="New chat" aria-label="New chat" onClick={fresh}><Plus size={18} /></button>}
        <button className="veal-ic" title="Open Assistant" aria-label="Open Assistant" onClick={() => { onMinimise(); go(assistantPath(area)); }}><Maximize2 size={16} /></button>
        <button className="veal-ic" title="Minimise" aria-label="Minimise" onClick={onMinimise}><Minus size={18} /></button>
      </div>
      <div className="veal-body" ref={body}>
        {status.isLoading ? null : !s?.connected ? (
          <div className="veal-empty"><MessageCircle size={26} /><b>Veal isn't switched on yet</b><p>It will answer here once it's connected. Everything else in WindVeal works as normal.</p></div>
        ) : s.limit === 0 ? (
          <div className="veal-empty"><MessageCircle size={26} /><b>Veal comes with Growth</b><p>Ask about anything in {org.name}, or have it add tasks, leads and leave for you.</p><Link className="btn btn-primary btn-sm" to="/billing" onClick={onMinimise}>See plans</Link></div>
        ) : !items.length && !busy ? (
          <div className="veal-empty">
            <MessageCircle size={26} /><b>Ask about anything in {org.name}</b>
            <p>Veal sees only what you can see, and asks before changing anything. You can also add a spreadsheet.</p>
            <div className="veal-starters">{STARTERS.map((q) => <button key={q} onClick={() => void send(q)}>{q}</button>)}</div>
          </div>
        ) : items.map((it, i) => {
          const note = notes.filter((n) => n.after === i + 1).map((n, j) => <div key={`n${i}-${j}`} className="vm ai err">{n.text}</div>);
          let el: ReactNode;
          if (it.kind === "you") el = <div className="vm you">{it.text}</div>;
          else if (it.kind === "file") el = <div className="vfile"><FileSpreadsheet size={18} /><b>{it.name}</b></div>;
          else if (it.kind === "ai") el = (
            <div className="vm ai"><Rich text={it.text} />
              {!!it.links?.length && <div className="vgo-row">{it.links.map((l) => <button key={l.to} className="vgo" onClick={() => go(l.to)}>{l.label}<ArrowRight size={14} /></button>)}</div>}
            </div>
          );
          else el = (
            <div className={`vcard ${it.answer ?? ""}`}>
              <small>{it.answer === "done" ? "Done" : it.answer === "cancelled" ? "Cancelled" : it.answer === "failed" ? "Didn't work" : "Do this?"}</small><b>{it.summary}</b>
              {!it.answer && <div className="row">
                <Button variant="secondary" size="sm" icon={<X size={14} />} disabled={busy} onClick={() => void answer(it.toolCallId, false)}>Cancel</Button>
                <Button size="sm" icon={<Check size={14} />} disabled={busy} onClick={() => void answer(it.toolCallId, true)}>Confirm</Button>
              </div>}
            </div>
          );
          return <div key={i} className="veal-turn">{el}{note}</div>;
        })}
        {busy && <div className="vm ai veal-typing"><i /><i /><i /></div>}
      </div>
      <div className="veal-compose">
        <button className="veal-ic" title="Add a spreadsheet" aria-label="Add a spreadsheet" onClick={() => file.current?.click()} disabled={!ready || busy}><Paperclip size={18} /></button>
        <input ref={file} type="file" accept=".xlsx,.csv" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        <textarea ref={input} value={text} rows={1} disabled={!ready} placeholder={ready ? "Ask Veal anything..." : "Veal isn't available"}
          aria-label="Message Veal" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="veal-send" aria-label="Send" onClick={() => void send()} disabled={!ready || busy || pending || !text.trim()}><ArrowUp size={17} /></button>
      </div>
      {s?.connected && s.limit > 0 && <div className="veal-foot">{s.used} of {s.limit} this month</div>}
    </div>
  );
}
