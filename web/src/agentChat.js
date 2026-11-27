/* The Agent's chats, held once for the whole app (App.jsx) and shown in two
 * kinds of place: the home page (AgentHome.jsx), and the Agent tab of a
 * release's page (AgentTab.jsx). Each place has its own conversation: the
 * home page's, and one per release, so a launch's questions stay with the
 * launch and are still there when the reader comes back to it.
 *
 * An answer streams back as server-sent events over the POST (status lines
 * while it looks things up, then the text). It keeps streaming when the
 * reader moves to another tab or page, and is there on the way back.
 *
 * What is kept, all of it in this browser and none of it on the server:
 *   - the home page's open chat, for the tab (sessionStorage), as before;
 *   - every chat with something in it, newest first (localStorage), each with
 *     the release it was held on, so the home page can list them and a
 *     release's tab can list its own;
 *   - which chat each release's tab shows (localStorage), so a reload, a new
 *     tab or another day opens the launch's conversation where it was left.
 * Nothing here is sent anywhere but the question itself.
 *
 * A skill is a written method the Agent follows for one kind of question
 * (server/agent/skills/). The Diagnose press asks with skill "diagnose". */
import { useEffect, useRef, useState } from "react";
import { historyText } from "./agentText.jsx";

import { HOME, answered, chatTitle, keepChat, loadChats, newId, openFor, saveOpen } from "./agentStore.mjs";

export { HOME, ago, answered, chatTitle } from "./agentStore.mjs";

/* the skills the chat can switch on: the words on the press and the question the thread shows */
export const SKILLS = {
  diagnose: { label: "Diagnose this release", ask: "Diagnose this release", tip: "Goes through the funnel stage by stage, finds where this launch is weak, and compares it with the artist's earlier launches where there are any" },
};

/* the home page's open chat, kept for the tab (sessionStorage), as before the releases had chats of their own */
const STORE = "agentThread";
const IDKEY = "agentChatId";
const loadThread = () => { try { const t = JSON.parse(sessionStorage.getItem(STORE) || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } };
const saveThread = (t) => { try { sessionStorage.setItem(STORE, JSON.stringify(t.slice(-30))); } catch { /* a convenience only */ } };
const loadId = () => { try { return sessionStorage.getItem(IDKEY) || newId(); } catch { return newId(); } };
const saveId = (id) => { try { sessionStorage.setItem(IDKEY, id); } catch { /* a convenience only */ } };
/* the browser's own store, which may refuse (a private window): every call through it is guarded in agentStore.mjs */
const local = { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) };

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

/* `place` is where the reader is: HOME, or a release's id while they are on that release's page (any of its
 * tabs); `context` is what the server is told about the page. */
export function useAgentChat({ place = HOME, context }) {
  const [, redraw] = useState(0);
  const [chats, setChats] = useState(() => loadChats(local));
  /* one slot per place visited: { id, thread, busy, live, abort, run }. Held in a ref, not in state, so an answer
   * that lands after the reader has moved on is written to the chat it belongs to and not to the one on screen. */
  const slots = useRef(new Map());
  const slotOf = (p) => {
    let s = slots.current.get(p);
    if (!s) {
      if (p === HOME) { s = { id: loadId(), thread: loadThread() }; saveId(s.id); }
      else s = openFor(local, p) || { id: newId(), thread: [] };
      Object.assign(s, { busy: false, live: null, abort: null, run: 0 });
      slots.current.set(p, s);
    }
    return s;
  };
  const cur = slotOf(place);
  const draw = () => redraw((n) => n + 1);
  useEffect(() => () => { for (const s of slots.current.values()) if (s.abort) s.abort.abort(); }, []);

  /* a place's thread, on screen and in the store */
  const setThread = (p, s, t) => {
    s.thread = t;
    if (p === HOME) { saveThread(t); if (answered(t)) setChats(keepChat(local, s.id, t)); }
    else if (t.length) { const next = keepChat(local, s.id, t, p); saveOpen(local, p, s.id, next); setChats(next); }
    draw();
  };

  const onRelease = place !== HOME;

  /* opts.skill switches a skill on for this question (the Diagnose press) */
  const ask = async (q, opts = {}) => {
    q = (q || "").trim();
    const p = place, s = slotOf(p);
    if (!q || s.busy) return;
    const mine = ++s.run;
    const here = () => mine === s.run && slots.current.get(p) === s;   // still this chat's answer
    const skill = opts.skill && SKILLS[opts.skill] ? opts.skill : null;
    const next = [...s.thread, { role: "user", text: q, ...(skill ? { skill } : {}) }];
    s.busy = true; s.live = { text: "", status: "Thinking", charts: [] };
    setThread(p, s, next);
    const ac = new AbortController();
    s.abort = ac;
    const ctx = { view: context && context.view, display: context && context.display, tab: context && context.tab, ...(p !== HOME ? { release: p } : {}) };
    let finished = false;
    const finish = (msg) => { if (finished || !here()) return; finished = true; setThread(p, s, [...next, msg]); };
    try {
      const r = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal,
        body: JSON.stringify({ context: ctx, messages: toMessages(next), ...(skill ? { skill } : {}) }),
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
        if (here() && !finished) { s.live = acc; draw(); }
      });
      if (!finished) finish(acc.text ? { role: "assistant", text: acc.text, charts: acc.charts } : { role: "assistant", error: true, text: "The answer was cut off. Try again." });
    } catch (e) {
      finish({ role: "assistant", error: true, text: e.name === "AbortError" ? "Stopped." : "The agent could not be reached." });
    } finally {
      if (here()) { s.busy = false; s.live = null; s.abort = null; draw(); }
    }
  };
  const stop = () => { if (cur.abort) cur.abort.abort(); };

  /* put another chat in a place: an empty one, or one of the kept ones. The answer in flight there is left behind. */
  const swap = (p, chatId, t) => {
    const s = slotOf(p);
    s.run += 1;
    if (s.abort) s.abort.abort();
    Object.assign(s, { id: chatId, thread: t, busy: false, live: null, abort: null });
    if (p === HOME) { saveId(chatId); saveThread(t); }
    else saveOpen(local, p, t.length ? chatId : null);
    draw();
  };
  const newChat = () => swap(place, newId(), []);
  /* a kept chat goes back where it was held: a release's chat on that release's tab, the rest on the home page.
   * The caller moves the reader there (App.jsx); this puts the chat in the place. */
  const openChat = (c) => {
    if (!c) return;
    const p = c.rel || HOME;
    if (slotOf(p).id !== c.id) swap(p, c.id, c.thread);
  };

  const listed = chats.filter((c) => answered(c.thread));
  return {
    place, thread: cur.thread, live: cur.live, busy: cur.busy, ask, stop, newChat, openChat,
    chats: listed, here: onRelease ? listed.filter((c) => c.rel === place) : listed,
    chatId: cur.id, title: chatTitle(cur.thread), onRelease,
  };
}
