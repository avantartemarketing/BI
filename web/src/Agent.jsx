/* The Agent's chat, the parts its two pages share: the home page
 * (AgentHome.jsx) and the Agent tab of a release's page (AgentTab.jsx). It
 * answers questions about the data - this release, or every launch - from
 * the snapshots, the tables and the docs, and can draw charts in the chat
 * (server/agent/). It reads only: nothing it does changes the dashboard.
 *
 * The conversations themselves are held by the app (agentChat.js). Here are
 * the turns, the box a question is typed in, and its send press. */
import React, { useState } from "react";
import { Pulse } from "./icons.jsx";
import { AnswerText } from "./agentText.jsx";
import "./agent.css";

/* the conversation: each question, its answer, and the answer streaming in */
export function Turns({ chat }) {
  const { thread, live } = chat;
  return (
    <>
      {thread.map((m, i) => (
        <div key={i} className="agentturn">
          {m.role === "user" ? <div className={`askq${m.skill ? " skill" : ""}`}>{m.skill ? <Pulse w={13} /> : null}{m.text}</div>
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

/* The box a question is typed in: Enter sends, Shift+Enter breaks the line.
 * `left` is what sits at the foot's left, opposite the send press (a release's
 * tab puts its Diagnose press there). */
export function ChatBox({ chat, id, placeholder, rows = 1, left, inputRef }) {
  const [text, setText] = useState("");
  const ask = () => { if (!text.trim() || chat.busy) return; const q = text; setText(""); chat.ask(q); };
  return (
    <div className="ah-box">
      <label htmlFor={id} className="sr">Ask the agent</label>
      <textarea id={id} ref={inputRef} rows={rows} placeholder={placeholder} value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} />
      <div className="ah-boxfoot">{left || null}<span style={{ flex: 1 }} /><SendPress chat={chat} text={text} onSend={ask} solid /></div>
    </div>
  );
}
