/* The Agent's chat, held once for the whole app so the home page and the
 * press bottom right show the same conversation (Agent.jsx, AgentHome.jsx).
 *
 * The answer streams back as server-sent events over the POST (status lines
 * while it looks things up, then the text). The open chat is kept for the tab
 * (sessionStorage), so a reload or a move to another page keeps it; the last
 * few chats are kept in this browser (localStorage) so the home page can list
 * them. Nothing here is sent anywhere but the question itself. */
import { useEffect, useRef, useState } from "react";
import { historyText } from "./agentText.jsx";

export const TRIES = {
  le: ["How is this release pacing?", "Which channel is working?", "Chart units by day against the plan"],
  tl: ["How are signups pacing?", "Which work could sell out?", "Chart signups by channel"],
  all: ["Which live releases are furthest behind target?", "Chart paid spend by month this year", "How do draw releases' sell-through compare by price?"],
};

const STORE = "agentThread";
const IDKEY = "agentChatId";
const CHATS = "agentChats";
const KEEP = 12;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const loadThread = () => { try { const t = JSON.parse(sessionStorage.getItem(STORE) || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } };
const saveThread = (t) => { try { sessionStorage.setItem(STORE, JSON.stringify(t.slice(-30))); } catch { /* a convenience only */ } };
const loadId = () => { try { return sessionStorage.getItem(IDKEY) || newId(); } catch { return newId(); } };
const saveId = (id) => { try { sessionStorage.setItem(IDKEY, id); } catch { /* a convenience only */ } };
const loadChats = () => {
  try { const c = JSON.parse(localStorage.getItem(CHATS) || "[]"); return Array.isArray(c) ? c.filter((x) => x && x.id && Array.isArray(x.thread) && x.thread.length) : []; } catch { return []; }
};
/* when the browser's store is full the oldest chats go first */
const saveChats = (c) => {
  for (let n = c.length; ; n = Math.floor(n / 2)) {
    try { localStorage.setItem(CHATS, JSON.stringify(c.slice(0, n))); return; } catch { if (!n) return; }
  }
};
const answered = (t) => t.some((m) => m.role === "assistant" && !m.error);
const keepChat = (id, thread) => {
  const next = [{ id, at: Date.now(), thread: thread.slice(-30) }, ...loadChats().filter((c) => c.id !== id)].slice(0, KEEP);
  saveChats(next);
  return next;
};

/* a chat's name is its first question */
export const chatTitle = (thread) => { const q = (thread || []).find((m) => m.role === "user"); return q ? q.text : ""; };
/* how long ago, the short way a list says it: now, 5m, 3h, 2d, 4w */
export function ago(at, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  const d = Math.floor(m / (60 * 24));
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

/* the thread as the server takes it: plain text turns, the newest last, within ~50k characters */
function toMessages(thread) {
  const out = [];
  let size = 0;
  for (let i = thread.length - 1; i >= 0 && out.length < 16; i--) {
    const m = thread[i];
    if (m.error) continue;
    const content = m.role === "assistant" ? historyText(m.text, m.charts) : m.text;
    if (!content) continue;
    size += content.length;
    if (size > 50000 && out.length) break;
    out.unshift({ role: m.role, content });
  }
  return out;
}

/* read a server-sent event stream from a fetch response */
async function readEvents(res, on) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) { try { on(event, JSON.parse(data)); } catch { /* a malformed event is skipped */ } }
    }
  }
}

export function useAgentChat({ snap, context }) {
  const [thread, setThreadState] = useState(loadThread);
  const [chats, setChats] = useState(loadChats);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);   // { text, status, charts } while an answer streams
  const [scope, setScope] = useState("release");
  const id = useRef(null);
  if (id.current === null) { id.current = loadId(); saveId(id.current); }
  const abort = useRef(null);
  const run = useRef(0);   // the answer in flight; a new or reopened chat leaves it behind
  const setThread = (t) => { setThreadState(t); saveThread(t); if (answered(t)) setChats(keepChat(id.current, t)); };
  const onRelease = !!(context && context.release && snap);
  const releaseScope = onRelease && scope === "release";
  useEffect(() => () => { if (abort.current) abort.current.abort(); }, []);
  const tries = releaseScope ? (snap.type === "TL" ? TRIES.tl : TRIES.le) : TRIES.all;

  const ask = async (q) => {
    q = (q || "").trim();
    if (!q || busy) return;
    const mine = ++run.current;
    const here = () => mine === run.current;
    const next = [...thread, { role: "user", text: q }];
    setThread(next); setBusy(true);
    setLive({ text: "", status: "Thinking", charts: [] });
    const ac = new AbortController();
    abort.current = ac;
    const ctx = { view: context && context.view, display: context && context.display, tab: context && context.tab, ...(releaseScope ? { release: context.release } : {}) };
    let finished = false;
    const finish = (msg) => { if (finished || !here()) return; finished = true; setThread([...next, msg]); };
    try {
      const r = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal,
        body: JSON.stringify({ context: ctx, messages: toMessages(next) }),
      });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("text/event-stream")) {
        const d = await r.json().catch(() => ({}));
        finish({ role: "assistant", error: true, text: d.error || "The agent could not answer." });
        return;
      }
      let acc = { text: "", status: "Thinking", charts: [] };
      await readEvents(r, (ev, d) => {
        if (ev === "status") acc = { ...acc, status: d.text };
        else if (ev === "delta") acc = { ...acc, text: acc.text + d.text, status: "" };
        else if (ev === "reset") acc = { ...acc, text: "" };
        else if (ev === "chart") acc = { ...acc, charts: [...acc.charts, d] };
        else if (ev === "done") finish({ role: "assistant", text: d.text, charts: d.charts || [] });
        else if (ev === "error") finish({ role: "assistant", error: true, text: d.error });
        if (here()) setLive(acc);
      });
      if (!finished) finish(acc.text ? { role: "assistant", text: acc.text, charts: acc.charts } : { role: "assistant", error: true, text: "The answer was cut off. Try again." });
    } catch (e) {
      finish({ role: "assistant", error: true, text: e.name === "AbortError" ? "Stopped." : "The agent could not be reached." });
    } finally {
      if (here()) { setBusy(false); setLive(null); abort.current = null; }
    }
  };
  const stop = () => { if (abort.current) abort.current.abort(); };
  /* put another chat on screen: an empty one, or one of the kept ones */
  const swap = (chatId, t) => {
    run.current += 1;
    stop(); abort.current = null;
    id.current = chatId; saveId(chatId);
    setThreadState(t); saveThread(t);
    setBusy(false); setLive(null);
  };
  const newChat = () => swap(newId(), []);
  const openChat = (c) => { if (c && c.id !== id.current) swap(c.id, c.thread); };

  return { thread, live, busy, ask, stop, newChat, openChat, chats, chatId: id.current, title: chatTitle(thread), scope, setScope, onRelease, releaseScope, tries };
}
