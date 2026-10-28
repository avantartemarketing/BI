/* The Agent: the press bottom right, Linear's, and the chat it opens. It
 * answers questions about the data - this release, or every launch - from
 * the snapshots, the tables and the docs, and can draw charts in the chat
 * (server/agent/). It reads only: nothing it does changes the dashboard.
 *
 * The answer streams back as server-sent events over the POST (status lines
 * while it looks things up, then the text). The thread is kept for the tab
 * (sessionStorage), so a reload or a move to another page keeps the chat. */
import React, { useEffect, useRef, useState } from "react";
import { Agent as AgentIcon, Plus, Minimise, Expand, X, Caret } from "./icons.jsx";
import { AnswerText, historyText } from "./agentText.jsx";
import "./agent.css";

const TRIES = {
  le: ["How is this release pacing?", "Which channel is working?", "Chart units by day against the plan"],
  tl: ["How are signups pacing?", "Which work could sell out?", "Chart signups by channel"],
  all: ["Which live releases are furthest behind target?", "Chart paid spend by month this year", "How do draw releases' sell-through compare by price?"],
};
const STORE = "agentThread";
const load = () => { try { const t = JSON.parse(sessionStorage.getItem(STORE) || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } };
const save = (t) => { try { sessionStorage.setItem(STORE, JSON.stringify(t.slice(-30))); } catch { /* a convenience only */ } };

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

export default function AgentDock({ snap, context }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const [text, setText] = useState("");
  const [thread, setThreadState] = useState(load);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);   // { text, status, charts } while an answer streams
  const [scope, setScope] = useState("release");
  const scroller = useRef(null);
  const abort = useRef(null);
  const setThread = (t) => { setThreadState(t); save(t); };
  const onRelease = !!(context && context.release && snap);
  const releaseScope = onRelease && scope === "release";
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread, open, live]);
  useEffect(() => () => { if (abort.current) abort.current.abort(); }, []);
  const tries = releaseScope ? (snap.type === "TL" ? TRIES.tl : TRIES.le) : TRIES.all;

  const ask = async (q) => {
    q = (q || "").trim();
    if (!q || busy) return;
    const next = [...thread, { role: "user", text: q }];
    setThread(next); setText(""); setOpen(true); setBusy(true);
    setLive({ text: "", status: "Thinking", charts: [] });
    const ac = new AbortController();
    abort.current = ac;
    const ctx = { view: context && context.view, display: context && context.display, tab: context && context.tab, ...(releaseScope ? { release: context.release } : {}) };
    let finished = false;
    const finish = (msg) => { if (finished) return; finished = true; setThread([...next, msg]); };
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
        setLive(acc);
      });
      if (!finished) finish(acc.text ? { role: "assistant", text: acc.text, charts: acc.charts } : { role: "assistant", error: true, text: "The answer was cut off. Try again." });
    } catch (e) {
      finish({ role: "assistant", error: true, text: e.name === "AbortError" ? "Stopped." : "The agent could not be reached." });
    } finally {
      setBusy(false); setLive(null); abort.current = null;
    }
  };
  const stop = () => { if (abort.current) abort.current.abort(); };
  const clear = () => { stop(); setThread([]); setText(""); };

  const firstQ = thread.find((m) => m.role === "user");
  const name = snap ? snap.artist : "";
  const wide = big ? "min(760px, calc(100% - 48px))" : "min(480px, calc(100% - 48px))";
  return (
    <>
      <div className="agentdock">
        <button className="agentbtn" onClick={() => setOpen(!open)} aria-expanded={open}><AgentIcon />Agent</button>
        <button className="nv-ib" aria-label="New chat" title="New chat" onClick={() => { clear(); setOpen(true); }}><Plus /></button>
      </div>
      {open && (
        <section className="agentpop" aria-label="Agent chat" style={{ width: wide, height: big ? "calc(100vh - 80px)" : "min(640px, calc(100vh - 80px))" }}>
          <div style={{ display: "flex", alignItems: "center", height: 48, padding: "0 8px 0 18px", flex: "0 0 auto" }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{firstQ ? firstQ.text : "New chat"}</span>
            <span style={{ flex: 1 }} />
            <button className="nv-ib" aria-label="Minimise" onClick={() => setOpen(false)}><Minimise /></button>
            <button className="nv-ib" aria-label={big ? "Shrink" : "Expand"} onClick={() => setBig(!big)}><Expand /></button>
            <button className="nv-ib" aria-label="Close and clear" onClick={() => { clear(); setOpen(false); }}><X w={15} /></button>
          </div>
          <div ref={scroller} className="agentscroll">
            {thread.length === 0 && !live && (
              <div className="agentempty">
                <span style={{ color: "#6b6b6f", marginBottom: 6 }}><AgentIcon w={18} /></span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{releaseScope ? "Ask about this release" : "Ask about your launches"}</span>
                <span style={{ fontSize: 13, color: "#6b6b6f" }}>{releaseScope ? `${name}'s figures, how they are worked out, or any launch's data` : "Any release, any table behind the dashboard, how a figure is worked out"}</span>
                <span style={{ fontSize: 12, color: "#8a8a8e" }}>It reads the data and can draw charts here; it never changes the dashboard.</span>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 14 }}>
                  {tries.map((q) => <button key={q} className="trychip" onClick={() => ask(q)}>{q}</button>)}
                </div>
              </div>
            )}
            {thread.map((m, i) => (
              <div key={i} className="agentturn">
                {m.role === "user" ? <div className="askq">{m.text}</div>
                  : m.error ? <p className="aska aerr">{m.text}</p>
                  : <AnswerText text={m.text} charts={m.charts} />}
              </div>
            ))}
            {live && (
              <div className="agentturn">
                {live.text ? <AnswerText text={live.text} charts={live.charts} /> : null}
                {live.status && <p className="aska astatus"><span className="adot" />{live.status}…</p>}
              </div>
            )}
          </div>
          <div className="agentin">
            <label htmlFor="agentin" className="sr">Ask the agent</label>
            <textarea id="agentin" rows={1} placeholder={releaseScope ? "Ask about this release, or any launch" : "Ask about any launch or the data"} value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(text); } }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {onRelease ? (
                <button className="nv-row ascope" onClick={() => setScope(scope === "release" ? "all" : "release")} title="What the questions are about">
                  {scope === "release" ? "This release" : "All launches"}<Caret />
                </button>
              ) : <span className="nv-row ascope" style={{ cursor: "default" }}>All launches</span>}
              <span style={{ flex: 1 }} />
              {busy ? (
                <button className="sendr" aria-label="Stop" title="Stop" onClick={stop}>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
                </button>
              ) : (
                <button className="sendr" aria-label="Send" onClick={() => ask(text)} disabled={!text.trim()}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
