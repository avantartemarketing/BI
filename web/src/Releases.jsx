/* The releases list, the page the app opens on: every launch in flight,
 * upcoming and recently closed, as Linear lists issues - a dot, the artist
 * and the work, the type, a bar against target, the status in a lozenge,
 * the lead and when it closes or opens. Views narrow it; the LE and TL pills
 * filter by type. */
import React, { useState } from "react";
import { Avatar, Badge, Loz } from "./ui.jsx";
import { nameOf, stateColor, statusWord, vsTarget, whenWords } from "./rows.mjs";

const VIEWS = [["all", "All"], ["live", "In flight"], ["upcoming", "Upcoming"], ["recent", "Recent"], ["closed", "Closed"]];
const GDOT = {
  live: { width: 10, height: 10, borderRadius: "50%", border: "2px solid #5e6ad2" },
  upcoming: { width: 10, height: 10, borderRadius: "50%", border: "1.5px dashed #a1a1aa" },
  recent: { width: 10, height: 10, borderRadius: "50%", background: "#5e6ad2" },
  closed: { width: 10, height: 10, borderRadius: "50%", background: "#5e6ad2" },
};

function Row({ r, asOf, onPick }) {
  const { artist, work } = nameOf(r);
  const color = stateColor(r);
  const vs = vsTarget(r);
  const p = r.targeted !== false && r.statusPct !== null && r.statusPct !== undefined ? 1 + r.statusPct : null;
  const word = statusWord(r, asOf);
  const kind = color === "#b8461d" ? "warm" : p !== null && p >= 1 ? "ind" : undefined;
  return (
    <button className="rrow" onClick={() => onPick(r.id)}>
      {color ? <span className="nv-dot" style={{ background: color }} /> : <span className="nv-ring" />}
      <span className="nm"><b>{artist}</b><span className="wk">{work}</span></span>
      <Badge type={r.type} />
      <span>{p !== null && (
        <span className="pbar" title={`${Math.round(p * 100)}% of target so far`}>
          <i style={{ width: `${Math.min(100, (p / 1.3) * 100).toFixed(1)}%`, background: p >= 1 ? "#5e6ad2" : "#e8915a" }} />
          <s style={{ left: `${((1 / 1.3) * 100).toFixed(1)}%` }} />
        </span>
      )}</span>
      <span><Loz kind={kind}>{vs || word}</Loz></span>
      <Avatar name={r.lead} size={20} title={r.lead || "No lead on file"} />
      <span className="when">{whenWords(r, asOf).text}</span>
    </button>
  );
}

export default function Releases({ groups, asOf, onPick }) {
  const [view, setView] = useState("all");
  const [type, setType] = useState(null);
  const keep = (r) => !type || r.type === type;
  const sections = [["live", "In flight", groups.live], ["upcoming", "Upcoming", groups.upcoming], ["recent", "Recent", groups.recent], ["closed", "Closed", groups.closed]]
    .filter(([k]) => (view === "all" ? k !== "closed" : k === view))
    .map(([k, name, rows]) => ({ k, name, rows: rows.filter(keep) }))
    .filter((s) => s.rows.length);
  const count = (k) => (k === "all" ? [...groups.live, ...groups.upcoming, ...groups.recent] : groups[k] || []).filter(keep).length;
  return (
    <main className="page">
      <header className="phead">
        <span className="name">Releases</span>
        <span style={{ flex: 1 }} />
      </header>
      <div className="vrow">
        {VIEWS.map(([k, name]) => (
          <button key={k} className={`vp${view === k ? " on" : ""}`} aria-pressed={view === k} onClick={() => setView(k)}>{name}<span className="c">{count(k)}</span></button>
        ))}
        <span style={{ flex: 1 }} />
        {["LE", "TL"].map((t) => (
          <button key={t} className={`vp${type === t ? " on" : ""}`} aria-pressed={type === t} onClick={() => setType(type === t ? null : t)}><Badge type={t} /></button>
        ))}
      </div>
      <div className="rrow rhead"><span /><span>Launch</span><span>Type</span><span>Against target</span><span>Status</span><span>Lead</span><span className="when">Closes or opens</span></div>
      {sections.map((s) => (
        <div key={s.k}>
          <div className="gband"><span style={GDOT[s.k]} />{s.name}<span className="c">{s.rows.length}</span></div>
          {s.rows.map((r) => <Row key={r.id} r={r} asOf={asOf} onPick={onPick} />)}
        </div>
      ))}
      {sections.length === 0 && <div className="empty">Nothing here</div>}
    </main>
  );
}
