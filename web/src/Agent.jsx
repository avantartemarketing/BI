/* The Agent: the press bottom right, Linear's, and the chat it opens. It
 * answers questions about the data - this release, or every launch - from
 * the snapshots, the tables and the docs, and can draw charts in the chat
 * (server/agent/). It reads only: nothing it does changes the dashboard.
 *
 * The conversation itself is held by the app (agentChat.js), so this popup
 * and the home page (AgentHome.jsx) show the same one. The turns and the send
 * press are drawn here for both. */
import React, { useEffect, useRef, useState } from "react";
import { Agent as AgentIcon, Plus, Minimise, Expand, X, Caret } from "./icons.jsx";
import { AnswerText } from "./agentText.jsx";
import "./agent.css";

/* the conversation: each question, its answer, and the answer streaming in */
export function Turns({ chat }) {
  const { thread, live } = chat;
  return (
    <>
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
    </>
  );
}

/* the round press at the box's right: send, or stop while an answer streams */
export function SendPress({ chat, text, onSend, solid }) {
  const cls = `sendr${solid ? " solid" : ""}`;
  return chat.busy ? (
    <button className={cls} aria-label="Stop" title="Stop" onClick={chat.stop}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
    </button>
  ) : (
    <button className={cls} aria-label="Send" onClick={onSend} disabled={!text.trim()}>
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
    </button>
  );
}

export default function AgentDock({ chat, snap }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const [text, setText] = useState("");
  const scroller = useRef(null);
  const { thread, live, scope, setScope, onRelease, releaseScope, tries } = chat;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread, open, live]);
  const ask = (q) => { if (!(q || "").trim() || chat.busy) return; setText(""); setOpen(true); chat.ask(q); };
  // a card hands a question over (the Suggested actions card's Ask): it is asked here, in the open chat
  const askRef = useRef(null);
  askRef.current = ask;
  useEffect(() => {
    const on = (e) => { const q = e && e.detail && e.detail.text; if (q && askRef.current) askRef.current(q); };
    window.addEventListener("agent:ask", on);
    return () => window.removeEventListener("agent:ask", on);
  }, []);
  const clear = () => { chat.newChat(); setText(""); };

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
            <span style={{ fontSize: 13.5, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{chat.title || "New chat"}</span>
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
            <Turns chat={chat} />
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
              <SendPress chat={chat} text={text} onSend={() => ask(text)} />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
