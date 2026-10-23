/* The sidebar: the workspace menu and the search at the top, Releases and
 * Targets, then In flight, Upcoming and Recent with a dot per release and
 * nothing else on the row; a slim hover card says the status, the pace
 * against target and when the release closes or opens. On a phone it is a
 * drawer the page's menu button opens. */
import React, { useState } from "react";
import { Caret, Caret8, Search, Releases as ReleasesIcon, Targets as TargetsIcon, Book, Key, SignOut } from "./icons.jsx";
import { Badge, Menu, MenuItem, useMenu } from "./ui.jsx";
import { nameOf, stateColor, statusWord, vsTarget, whenWords } from "./rows.mjs";

function Row({ r, asOf, on, onPick, onHover, onLeave }) {
  const color = stateColor(r);
  const { artist } = nameOf(r);
  return (
    <button className={`nv-row${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => onPick(r.id)}
      onMouseEnter={(e) => onHover(r, e.currentTarget.getBoundingClientRect().top)} onMouseLeave={onLeave}>
      {color ? <span className="nv-dot" style={{ background: color }} /> : <span className="nv-ring" />}
      <span className="nm">{artist}</span>
    </button>
  );
}

export default function Sidebar({ groups, asOf, currentId, view, me, open, onClose, onPick, onReleases, onTargets, onPermissions, onSearch }) {
  const ws = useMenu();
  const [hov, setHov] = useState(null);   // { r, top }
  const onHover = (r, top) => setHov({ r, top });
  const onLeave = () => setHov(null);
  const sections = [["In flight", groups.live], ["Upcoming", groups.upcoming], ["Recent", groups.recent]].filter(([, rows]) => rows.length);
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
            <MenuItem icon={<Book />} onClick={() => { ws.close(); window.open("/methodology", "_blank", "noreferrer"); }}>Methodology</MenuItem>
            {me && me.admin && <MenuItem icon={<Key />} onClick={() => { ws.close(); onPermissions(); }}>Permissions</MenuItem>}
            <div className="msep" />
            <MenuItem icon={<SignOut />} right={me && me.email ? me.email.split("@")[0] : ""} onClick={() => { window.location.href = "/auth/logout"; }}>Sign out</MenuItem>
          </Menu>
        </div>
        <button className={`nv-row${view === "releases" ? " on" : ""}`} onClick={onReleases}><ReleasesIcon />Releases</button>
        <button className="nv-row" onClick={onTargets} title="This release's targets"><TargetsIcon />Targets</button>
        {sections.map(([name, rows]) => (
          <div key={name} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <div className="nv-gap" />
            <button className="nv-lbl" aria-expanded="true">{name} <Caret8 /></button>
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
