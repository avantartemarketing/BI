/* The sidebar: the workspace menu (all releases, methodology, sign out) and
 * the search at the top, then In flight, Upcoming and Recent. A row is the
 * release's type as a tag in its state colour (LE or TL; grey outline without
 * targets), the artist, and the days to launch on the right (the day it
 * launched under Recent); a slim hover card says the status, the pace against
 * target and when the release closes or opens. On a phone it is a drawer the
 * page's menu button opens. */
import React, { useState } from "react";
import { Caret, Caret8, Search, Releases as ReleasesIcon, Book, Key, SignOut } from "./icons.jsx";
import { Badge, Menu, MenuItem, useMenu } from "./ui.jsx";
import { byLaunch, byLaunched, launchWords, nameOf, rowState, stateColor, statusWord, typeOf, TYPE_WORD, vsTarget, whenWords } from "./rows.mjs";

/* what the column on the right counts, said once on the section's label */
const COUNTS = { "In flight": "days to launch", Upcoming: "days to launch", Recent: "launched" };

function Row({ r, asOf, on, onPick, onHover, onLeave }) {
  const state = rowState(r);
  const type = typeOf(r);
  const { artist } = nameOf(r);
  const lw = launchWords(r, asOf);
  return (
    <button className={`nv-row${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => onPick(r.id)}
      aria-label={[artist, TYPE_WORD[type], statusWord(r, asOf), whenWords(r, asOf).text].filter(Boolean).join(", ")}
      onMouseEnter={(e) => onHover(r, e.currentTarget.getBoundingClientRect().top)} onMouseLeave={onLeave}>
      <span className={`nv-tag${state ? " " + state : ""}`}>{type}</span>
      <span className="nm">{artist}</span>
      {lw.text && <span className={`nv-when${lw.soon ? " soon" : ""}`}>{lw.text}</span>}
    </button>
  );
}

export default function Sidebar({ groups, asOf, currentId, view, me, open, onClose, onPick, onReleases, onPermissions, onSearch }) {
  const ws = useMenu();
  const [hov, setHov] = useState(null);   // { r, top }
  const onHover = (r, top) => setHov({ r, top });
  const onLeave = () => setHov(null);
  /* each section in the order of the count on its rows */
  const sections = [["In flight", byLaunch(groups.live, asOf)], ["Upcoming", byLaunch(groups.upcoming, asOf)], ["Recent", byLaunched(groups.recent)]].filter(([, rows]) => rows.length);
  const hc = hov ? { ...nameOf(hov.r), status: statusWord(hov.r, asOf), color: stateColor(hov.r), vs: vsTarget(hov.r), when: whenWords(hov.r, asOf) } : null;
  return (
    <>
      {open && <button className="navscrim" aria-label="Close the sidebar" onClick={onClose} tabIndex={-1} />}
      <nav aria-label="Releases" className={`sidenav${open ? " open" : ""}`} id="release-list">
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 2, marginBottom: 12 }}>
          <button className="nv-row" style={{ flex: 1, fontWeight: 500 }} aria-haspopup="menu" aria-expanded={ws.open} onClick={ws.toggle}>
            <span className="ws-mark">A</span>Avant Arte<Caret />
          </button>
          <button className="nv-ib" aria-label="Search releases" title="Search releases  ⌘K" onClick={onSearch}><Search /></button>
          <Menu open={ws.open} onClose={ws.close} style={{ top: 32, left: 0, width: 220 }}>
            <MenuItem icon={<ReleasesIcon />} onClick={() => { ws.close(); onReleases(); }}>All releases</MenuItem>
            <MenuItem icon={<Book />} onClick={() => { ws.close(); window.open("/methodology", "_blank", "noreferrer"); }}>Methodology</MenuItem>
            {me && me.admin && <MenuItem icon={<Key />} onClick={() => { ws.close(); onPermissions(); }}>Permissions</MenuItem>}
            <div className="msep" />
            <MenuItem icon={<SignOut />} right={me && me.email ? me.email.split("@")[0] : ""} onClick={() => { window.location.href = "/auth/logout"; }}>Sign out</MenuItem>
          </Menu>
        </div>
        {sections.map(([name, rows], i) => (
          <div key={name} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <div className="nv-gap" />
            <div className="nv-head">
              <button className="nv-lbl" aria-expanded="true">{name} <Caret8 /></button>
              {/* said on the first section and again only where the column changes meaning */}
              {(i === 0 || COUNTS[name] !== COUNTS[sections[i - 1][0]]) && <span className="nv-cap">{COUNTS[name]}</span>}
            </div>
            {rows.map((r) => <Row key={r.id} r={r} asOf={asOf} on={view === "release" && r.id === currentId} onPick={onPick} onHover={onHover} onLeave={onLeave} />)}
          </div>
        ))}
        <div style={{ flex: 1, minHeight: 24 }} />
        <a className="nv-ib help-ring" href="/methodology" target="_blank" rel="noreferrer" aria-label="Methodology" title="How every number is worked out" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>?</a>
      </nav>
      {hc && (
        <div className="hovcard" style={{ top: Math.max(8, hov.top - 6) }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 500 }}>{hc.artist}<Badge type={hov.r.type} /></div>
          <div style={{ color: "#8a8a8e", marginTop: 2 }}>{hc.work}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}>
            <span className="loz"><span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 7px", ...(hc.color ? { background: hc.color } : { border: "1.3px solid #a3a3a3" }) }} />{hc.status}</span>
            {hc.vs && <span className="loz">{hc.vs}</span>}
            {hc.when.text && <span className="loz ghost">{hc.when.text}</span>}
          </div>
        </div>
      )}
    </>
  );
}
