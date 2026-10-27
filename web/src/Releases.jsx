/* The releases list, the page the app opens on: every launch in flight,
 * upcoming and recently closed, laid out as Linear lists issues. Each group
 * is a rounded band with a caret that folds it, a status icon, the name and
 * the count. Each row reads left to right: the state dot, the type where
 * Linear puts the issue ID, the artist and the work, then on the right a chip
 * with a ring for progress against target, the lead and when it closes or
 * opens. Views narrow it; the LE and TL pills filter by type. */
import React, { useState } from "react";
import { Avatar, Badge } from "./ui.jsx";
import { Caret8 } from "./icons.jsx";
import { nameOf, stateColor, statusWord, vsTarget, whenWords } from "./rows.mjs";

const VIEWS = [["all", "All"], ["live", "In flight"], ["upcoming", "Upcoming"], ["recent", "Recent"], ["closed", "Closed"]];
const IND = "#5e6ad2";
const WARM = "#e8915a";

/* the group's status icon, after Linear's: half full in flight, dashed for
 * upcoming, a filled check once closed */
function GroupIcon({ k }) {
  const p = { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true, style: { flex: "0 0 14px" } };
  if (k === "live") return <svg {...p}><circle cx="7" cy="7" r="5.75" fill="none" stroke={IND} strokeWidth="1.5" /><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={IND} /></svg>;
  if (k === "upcoming") return <svg {...p}><circle cx="7" cy="7" r="5.75" fill="none" stroke="#a1a1aa" strokeWidth="1.5" strokeDasharray="1.6 1.9" /></svg>;
  const c = k === "closed" ? "#a1a1aa" : IND;
  return <svg {...p}><circle cx="7" cy="7" r="6.5" fill={c} /><path d="M4.3 7.2l1.8 1.7 3.6-3.7" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/* a ring that fills toward target, the way Linear shows progress in a chip */
function Ring({ p, color }) {
  const r = 5, len = 2 * Math.PI * r, f = Math.max(0, Math.min(1, p));
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: "0 0 14px" }}>
      <circle cx="7" cy="7" r={r} fill="none" stroke="#e4e4e7" strokeWidth="2" />
      {f > 0 && <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(f * len).toFixed(2)} ${len.toFixed(2)}`} transform="rotate(-90 7 7)" />}
    </svg>
  );
}

function Row({ r, asOf, onPick }) {
  const { artist, work } = nameOf(r);
  const color = stateColor(r);
  const vs = vsTarget(r);
  const p = r.targeted !== false && r.statusPct !== null && r.statusPct !== undefined ? 1 + r.statusPct : null;
  const word = statusWord(r, asOf);
  return (
    <button className="rrow" onClick={() => onPick(r.id)}>
      {color ? <span className="nv-dot" style={{ background: color }} /> : <span className="nv-ring" />}
      <Badge type={r.type} />
      <span className="nm"><b>{artist}</b>{work && <span className="wk">{work}</span>}</span>
      <span className="lchip" title={p !== null ? `${Math.round(p * 100)}% of target so far` : undefined}>
        {p !== null && <Ring p={p} color={p >= 1 ? IND : WARM} />}
        {vs || word}
      </span>
      <Avatar name={r.lead} size={18} title={r.lead || "No lead on file"} />
      <span className="when">{whenWords(r, asOf).text}</span>
    </button>
  );
}

export default function Releases({ groups, asOf, onPick }) {
  const [view, setView] = useState("all");
  const [type, setType] = useState(null);
  const [shut, setShut] = useState(() => new Set());
  const keep = (r) => !type || r.type === type;
  const sections = [["live", "In flight", groups.live], ["upcoming", "Upcoming", groups.upcoming], ["recent", "Recent", groups.recent], ["closed", "Closed", groups.closed]]
    .filter(([k]) => (view === "all" ? k !== "closed" : k === view))
    .map(([k, name, rows]) => ({ k, name, rows: rows.filter(keep) }))
    .filter((s) => s.rows.length);
  const count = (k) => (k === "all" ? [...groups.live, ...groups.upcoming, ...groups.recent] : groups[k] || []).filter(keep).length;
  const fold = (k) => setShut((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    <main className="page rel">
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
      <div className="rlist">
        {sections.map((s) => {
          const open = !shut.has(s.k);
          return (
            <section key={s.k}>
              <button className={`gband${open ? "" : " shut"}`} aria-expanded={open} onClick={() => fold(s.k)}>
                <span className="caret"><Caret8 /></span>
                <GroupIcon k={s.k} />
                <span>{s.name}</span>
                <span className="c">{s.rows.length}</span>
              </button>
              {open && s.rows.map((r) => <Row key={r.id} r={r} asOf={asOf} onPick={onPick} />)}
            </section>
          );
        })}
        {sections.length === 0 && <div className="empty">Nothing here</div>}
      </div>
    </main>
  );
}
