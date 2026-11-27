/* The Agent tab of a release's page, beside Overview and Targets: the chat
 * about this launch, laid out as the home page's (AgentHome.jsx) - the box
 * in the middle of an empty page with examples under it, then the
 * conversation down the page with the box at its foot.
 *
 * The conversation is the launch's own and is remembered in this browser
 * (agentChat.js): leaving the tab, the page or the browser and coming back
 * finds it where it was. New chat starts another; the earlier ones stay in
 * the header's list and under the examples.
 *
 * The box carries the Diagnose press. It asks with the diagnosis skill
 * switched on (server/agent/skills/diagnose.md): the Agent goes through the
 * launch's funnel stage by stage, finds where it is weak, and compares it
 * with the artist's earlier launches where there are any, else with the
 * launches its targets were set from. */
import React, { useEffect, useRef } from "react";
import { Bars, History, Plus, Pulse, Target, Trend } from "./icons.jsx";
import { Menu, MenuItem, useMenu } from "./ui.jsx";
import { ChatBox, Turns } from "./Agent.jsx";
import { ago, chatTitle, SKILLS } from "./agentChat.js";

/* three ways in under the box, in the words of the launch's kind */
const CARDS = {
  LE: [
    { icon: <Trend w={16} />, title: "Check the pace", q: "How is this release pacing?" },
    { icon: <Target w={16} />, title: "Compare the channels", q: "Which channel is working?" },
    { icon: <Bars w={15} />, title: "Chart it", q: "Chart units by day against the plan" },
  ],
  TL: [
    { icon: <Trend w={16} />, title: "Check the pace", q: "How are signups pacing?" },
    { icon: <Target w={16} />, title: "Look at the works", q: "Which work could sell out?" },
    { icon: <Bars w={15} />, title: "Chart it", q: "Chart signups by channel" },
  ],
};

/* the press that switches the diagnosis skill on for one question */
function DiagnosePress({ chat }) {
  const s = SKILLS.diagnose;
  return (
    <button className="skillb" title={s.tip} disabled={chat.busy} onClick={() => chat.ask(s.ask, { skill: "diagnose" })}>
      <Pulse w={14} />{s.label}
    </button>
  );
}

/* the header's right side on this tab: the launch's earlier chats, and a new one */
export function AgentTabHead({ chat }) {
  const menu = useMenu();
  const empty = chat.thread.length === 0 && !chat.live;
  const earlier = chat.here;
  return (
    <>
      {earlier.length > 0 && (
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button className="nv-ib" aria-label="This launch's chats" title="This launch's chats" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}><History /></button>
          <Menu open={menu.open} onClose={menu.close} label="This launch's chats" scroll style={{ top: 32, right: 0, width: 340 }}>
            {earlier.map((c) => (
              <MenuItem key={c.id} checked={c.id === chat.chatId && !empty} right={ago(c.at)} onClick={() => { menu.close(); chat.openChat(c); }}>{chatTitle(c.thread)}</MenuItem>
            ))}
          </Menu>
        </span>
      )}
      {!empty && <button className="nv-ib" aria-label="New chat" title="New chat" onClick={chat.newChat}><Plus /></button>}
    </>
  );
}

export default function AgentTab({ chat, snap }) {
  const scroller = useRef(null);
  const input = useRef(null);
  const { thread, live } = chat;
  const empty = thread.length === 0 && !live;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [thread, live]);
  // the box takes the typing as the tab opens, where there is a keyboard
  useEffect(() => { if (input.current && window.matchMedia("(hover: hover)").matches) input.current.focus(); }, [empty, chat.chatId]);
  const ask = (q) => { if (!(q || "").trim() || chat.busy) return; chat.ask(q); };
  const cards = CARDS[snap.type === "TL" ? "TL" : "LE"];
  const earlier = chat.here;

  const box = <ChatBox chat={chat} id="agenttab" inputRef={input} rows={empty ? 2 : 1} left={<DiagnosePress chat={chat} />}
    placeholder={empty ? `Ask about ${snap.artist || "this release"}'s launch…` : "Ask a follow-up…"} />;

  return empty ? (
    <div className="ah-mid">
      <div className="ah-col ah-start">
        {box}
        <div className="ah-cap">Or start with a question</div>
        <div className="ah-cards">
          {cards.map((x) => (
            <button key={x.q} className="ah-card" onClick={() => ask(x.q)}>
              {x.icon}
              <span className="t">{x.title}</span>
              <span className="d">{x.q}</span>
            </button>
          ))}
        </div>
        {earlier.length > 0 && (
          <div className="ah-recent">
            {earlier.slice(0, 5).map((c) => (
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
  );
}
