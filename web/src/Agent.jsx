/* The Agent: the press bottom right, Linear's, and the chat it opens. The
 * questions go to /api/agent with the release's id; the server answers them
 * from the snapshot through the Claude API. */
import React, { useEffect, useRef, useState } from "react";
import { Agent as AgentIcon, History, Minimise, Expand, X, Caret } from "./icons.jsx";

const TRIES = {
  le: ["How is this release pacing?", "Which channel is working?", "What should we do now?"],
  tl: ["How are signups pacing?", "Which work could sell out?", "What should we do now?"],
};

export default function AgentDock({ snap }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const [text, setText] = useState("");
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);
  useEffect(() => { setThread([]); setText(""); }, [snap && snap.id]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread, open]);
  const name = snap ? `${snap.artist}` : "this release";
  const ask = async (q) => {
    q = (q || "").trim();
    if (!q || busy) return;
    const next = [...thread, { role: "user", text: q }];
    setThread(next); setText(""); setOpen(true); setBusy(true);
    try {
      const r = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ release: snap ? snap.id : null, messages: next.map((m) => ({ role: m.role, content: m.text })) }) });
      const d = await r.json().catch(() => ({}));
      setThread([...next, { role: "assistant", text: r.ok ? (d.text || "") : (d.error || "The agent could not answer.") }]);
    } catch (e) {
      setThread([...next, { role: "assistant", text: "The agent could not be reached." }]);
    } finally { setBusy(false); }
  };
  return (
    <>
      <div className="agentdock">
        <button className="agentbtn" onClick={() => setOpen(!open)} aria-expanded={open}><AgentIcon />Agent</button>
        <button className="nv-ib" aria-label="Chat history" title="Chat history"><History /></button>
      </div>
      {open && (
        <section className="agentpop" aria-label="Agent chat" style={big ? { width: "min(720px, calc(100% - 48px))", height: "calc(100vh - 80px)" } : { width: "min(440px, calc(100% - 48px))", height: "min(600px, calc(100vh - 80px))" }}>
          <div style={{ display: "flex", alignItems: "center", height: 48, padding: "0 8px 0 18px", flex: "0 0 auto" }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{thread.length ? thread[0].text : "New chat"}</span>
            <span style={{ flex: 1 }} />
            <button className="nv-ib" aria-label="Minimise" onClick={() => setOpen(false)}><Minimise /></button>
            <button className="nv-ib" aria-label={big ? "Shrink" : "Expand"} onClick={() => setBig(!big)}><Expand /></button>
            <button className="nv-ib" aria-label="Close" onClick={() => { setOpen(false); setThread([]); setText(""); }}><X w={15} /></button>
          </div>
          <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto", margin: "0 6px", padding: "8px 12px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
            {thread.length === 0 && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 6, paddingBottom: 12, textAlign: "center" }}>
                <span style={{ color: "#6b6b6f", marginBottom: 6 }}><AgentIcon w={18} /></span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Ask about this release</span>
                <span style={{ fontSize: 13, color: "#6b6b6f" }}>Ask anything about {name}’s figures</span>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 14 }}>
                  {(snap && snap.type === "TL" ? TRIES.tl : TRIES.le).map((q) => <button key={q} className="trychip" onClick={() => ask(q)}>{q}</button>)}
                </div>
              </div>
            )}
            {thread.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {m.role === "user" ? <div className="askq">{m.text}</div> : <p className="aska">{m.text}</p>}
              </div>
            ))}
            {busy && <p className="aska" style={{ color: "#8a8a8e" }}>Thinking…</p>}
          </div>
          <div style={{ margin: "0 8px 8px", border: "1px solid #e6e6e8", borderRadius: 12, padding: "10px 10px 8px 14px", display: "flex", flexDirection: "column", gap: 8, flex: "0 0 auto" }}>
            <label htmlFor="agentin" className="sr">Ask the agent</label>
            <input id="agentin" type="text" placeholder="Ask about the figures on this page" value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") ask(text); }} style={{ border: 0, outline: 0, font: "inherit", fontSize: 13.5, background: "transparent", color: "#1b1b1c" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="nv-row" style={{ width: "auto", height: 26, fontSize: 12.5, color: "#3a3a3c", cursor: "default" }}>This release<Caret /></span>
              <span style={{ flex: 1 }} />
              <button className="sendr" aria-label="Send" onClick={() => ask(text)} disabled={busy || !text.trim()}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
