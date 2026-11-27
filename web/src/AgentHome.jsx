/* The home page: a chat with the Agent, laid out as Linear's Agent page. An
 * empty chat is one box in the middle of the page, three examples under it
 * and the last few chats under those; once a question is asked the
 * conversation runs down the page with the box at its foot. The header's name
 * opens the list of chats. A chat held on a release's Agent tab is listed
 * here too, with the artist beside it, and opens on that tab (agentChat.js). */
import React, { useEffect, useRef } from "react";
import { Bars, Caret, Hamburger, Plus, Target, Trend } from "./icons.jsx";
import { Menu, MenuItem, useMenu } from "./ui.jsx";
import { ChatBox, Turns } from "./Agent.jsx";
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

export default function AgentHome({ chat, groups, onMenu, onOpenChat }) {
  const menu = useMenu();
  const scroller = useRef(null);
  const input = useRef(null);
  const { thread, live, chats } = chat;
  const empty = thread.length === 0 && !live;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread, live]);
  // the box takes the typing as the page opens, where there is a keyboard
  useEffect(() => { if (input.current && window.matchMedia("(hover: hover)").matches) input.current.focus(); }, [empty, chat.chatId]);
  const ask = (q) => { if (!(q || "").trim() || chat.busy) return; chat.ask(q); };
  const open = (c) => (onOpenChat ? onOpenChat(c) : chat.openChat(c));
  // a chat held on a release's tab says whose: the artist, from the list of launches
  const whose = (c) => { const r = c.rel && (groups.all || []).find((x) => x.id === c.rel); return r ? nameOf(r).artist : ""; };
  const when = (c) => [whose(c), ago(c.at)].filter(Boolean).join(" · ");

  const box = <ChatBox chat={chat} id="agenthome" inputRef={input} rows={empty ? 2 : 1} placeholder={empty ? "Ask about your launches…" : "Ask a follow-up…"} />;

  return (
    <main className="page ahome">
      <header className="phead">
        <button className="ib menub" style={{ marginLeft: -8 }} aria-label="Open the sidebar" onClick={onMenu}><Hamburger /></button>
        <div style={{ position: "relative", display: "flex", minWidth: 0 }}>
          <button className="ah-name" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}>
            <span>{chat.title || "New chat"}</span><Caret />
          </button>
          <Menu open={menu.open} onClose={menu.close} label="Chats" scroll style={{ top: 32, left: -6, width: 340 }}>
            <MenuItem icon={<Plus />} disabled={empty} onClick={() => { menu.close(); chat.newChat(); }}>New chat</MenuItem>
            {chats.length > 0 && <div className="msep" />}
            {chats.map((c) => (
              <MenuItem key={c.id} checked={c.id === chat.chatId && !empty} right={when(c)} onClick={() => { menu.close(); open(c); }}>{chatTitle(c.thread)}</MenuItem>
            ))}
          </Menu>
        </div>
        <span style={{ flex: 1 }} />
        {!empty && <button className="nv-ib" aria-label="New chat" title="New chat" onClick={chat.newChat}><Plus /></button>}
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
                  <button key={c.id} className="ah-row" onClick={() => open(c)}>
                    <span className="t">{chatTitle(c.thread)}</span><span className="w">{when(c)}</span>
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
