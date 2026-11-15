/* The home page: a chat with the Agent, laid out as Linear's Agent page. An
 * empty chat is one box in the middle of the page, three examples under it
 * and the last few chats under those; once a question is asked the
 * conversation runs down the page with the box at its foot. The header's name
 * opens the list of chats. It is the same conversation the press bottom right
 * shows on the other pages (agentChat.js). */
import React, { useEffect, useRef, useState } from "react";
import { Bars, Caret, Hamburger, Plus, Target, Trend } from "./icons.jsx";
import { Menu, MenuItem, useMenu } from "./ui.jsx";
import { Turns, SendPress } from "./Agent.jsx";
import { ago, chatTitle } from "./agentChat.js";
import { nameOf } from "./rows.mjs";

/* three ways in: what needs attention, a chart, and the live release furthest
 * behind its target (a comparison when none is behind) */
function examples(live) {
  const behind = (live || []).filter((r) => r.targeted !== false && typeof r.statusPct === "number" && r.statusPct < 0)
    .sort((a, b) => a.statusPct - b.statusPct)[0];
  return [
    { icon: <Trend w={16} />, title: "See what needs attention", q: "Which live releases are furthest behind target?" },
    { icon: <Bars w={15} />, title: "Chart a trend", q: "Chart paid spend by month this year" },
    behind
      ? { icon: <Target w={16} />, title: "Dig into a release", q: `Why is ${nameOf(behind).artist} behind target?` }
      : { icon: <Target w={16} />, title: "Compare launches", q: "How do draw releases' sell-through compare by price?" },
  ];
}

export default function AgentHome({ chat, groups, onMenu }) {
  const [text, setText] = useState("");
  const menu = useMenu();
  const scroller = useRef(null);
  const input = useRef(null);
  const { thread, live, chats } = chat;
  const empty = thread.length === 0 && !live;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread, live]);
  // the box takes the typing as the page opens, where there is a keyboard
  useEffect(() => { if (input.current && window.matchMedia("(hover: hover)").matches) input.current.focus(); }, [empty, chat.chatId]);
  const ask = (q) => { if (!(q || "").trim() || chat.busy) return; setText(""); chat.ask(q); };
  const fresh = () => { chat.newChat(); setText(""); };

  const box = (
    <div className="ah-box">
      <label htmlFor="agenthome" className="sr">Ask the agent</label>
      <textarea id="agenthome" ref={input} rows={empty ? 2 : 1} placeholder={empty ? "Ask about your launches…" : "Ask a follow-up…"} value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(text); } }} />
      <div className="ah-boxfoot"><SendPress chat={chat} text={text} onSend={() => ask(text)} solid /></div>
    </div>
  );

  return (
    <main className="page ahome">
      <header className="phead">
        <button className="ib menub" style={{ marginLeft: -8 }} aria-label="Open the sidebar" onClick={onMenu}><Hamburger /></button>
        <div style={{ position: "relative", display: "flex", minWidth: 0 }}>
          <button className="ah-name" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}>
            <span>{chat.title || "New chat"}</span><Caret />
          </button>
          <Menu open={menu.open} onClose={menu.close} label="Chats" scroll style={{ top: 32, left: -6, width: 320 }}>
            <MenuItem icon={<Plus />} disabled={empty} onClick={() => { menu.close(); fresh(); }}>New chat</MenuItem>
            {chats.length > 0 && <div className="msep" />}
            {chats.map((c) => (
              <MenuItem key={c.id} checked={c.id === chat.chatId && !empty} right={ago(c.at)} onClick={() => { menu.close(); chat.openChat(c); }}>{chatTitle(c.thread)}</MenuItem>
            ))}
          </Menu>
        </div>
        <span style={{ flex: 1 }} />
        {!empty && <button className="nv-ib" aria-label="New chat" title="New chat" onClick={fresh}><Plus /></button>}
      </header>
      {empty ? (
        <div className="ah-mid">
          <div className="ah-col ah-start">
            {box}
            <div className="ah-cap">Get started with some examples</div>
            <div className="ah-cards">
              {examples(groups.live).map((x) => (
                <button key={x.q} className="ah-card" onClick={() => ask(x.q)}>
                  {x.icon}
                  <span className="t">{x.title}</span>
                  <span className="d">{x.q}</span>
                </button>
              ))}
            </div>
            {chats.length > 0 && (
              <div className="ah-recent">
                {chats.slice(0, 5).map((c) => (
                  <button key={c.id} className="ah-row" onClick={() => chat.openChat(c)}>
                    <span className="t">{chatTitle(c.thread)}</span><span className="w">{ago(c.at)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div ref={scroller} className="ah-scroll"><div className="ah-col ah-turns"><Turns chat={chat} /></div></div>
          <div className="ah-foot"><div className="ah-col">{box}</div></div>
        </>
      )}
    </main>
  );
}
