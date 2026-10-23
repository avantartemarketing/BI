/* A release's page: the header (where it sits, its name, the type, the
 * Overview and Targets tabs, the freshness, the Display menu), the chips
 * (status, dates, lead, horizon, line), the warning strip, then the tab's
 * body: the Overview's cards, the targets page, or the basket picker. */
import React, { useEffect, useState } from "react";
import { initial as watchInitial, step as watchStep } from "../../shared/refreshWatch.mjs";
import { freshness } from "../../shared/freshness.mjs";
import { Avatar, Badge, Menu, MenuItem, Seg, useMenu } from "./ui.jsx";
import { fmt, fmtDay } from "./format.mjs";
import { Cal, Caret, Chev, Clock, Display, Hamburger, ProgressRing, Ring, Warn, X } from "./icons.jsx";
import { wordsOf } from "./vocab.mjs";
import { releaseClock } from "./sections.mjs";
import { GROUP_WORD, groupOf, nameOf, onDay, rowState, STATE_COLOR, whenWords } from "./rows.mjs";
import Overview from "./Overview.jsx";
import TargetSetting from "./TargetSetting.jsx";
import TLTargets from "./TLTargets.jsx";

/* The Display menu: the settings that hold for every release. */
function DisplayMenu({ directSpread, setDirectSpread, snap }) {
  const m = useMenu();
  const W = wordsOf(snap);
  const tip = W.tl
    ? "Spread shares Direct's sessions, signups and units out over the other channels in proportion, and reads the basket the same way"
    : "Spread shares Direct's sessions, entries and units out over the other channels in proportion, and reads the basket the same way";
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button className="chip" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}><Display />Display</button>
      <Menu open={m.open} onClose={m.close} style={{ top: 32, right: 0, width: 272, padding: 6 }}>
        <div className="dmh">Every release</div>
        <div className="dm" title={tip}>Direct<Seg options={[["channel", "Channel", "Direct stays a channel of its own, as the feed attributes it"], ["spread", "Spread", tip]]} value={directSpread ? "spread" : "channel"} onChange={(v) => setDirectSpread(v === "spread")} label="Direct" /></div>
      </Menu>
    </span>
  );
}

/* The status chip: a ring of the campaign, and where the release is on it. */
function StatusChip({ snap, row, asOf }) {
  const g = snap.catalogue ? "catalogue" : snap.upcoming ? "upcoming" : row ? groupOf(row, asOf) : snap.complete ? "closed" : "live";
  const state = row ? rowState(row) : null;
  const color = state ? STATE_COLOR[state] : "#5e6ad2";
  const clock = releaseClock({ windowEnd: snap.windowEnd, of: snap.of, day: snap.day }, snap.asOf);
  if (snap.type === "TL") {
    const w = row ? whenWords(row, asOf) : { text: "" };
    const st = snap.tlState;
    const pct = st === "signups" ? (snap.of > 0 ? Math.min(1, (snap.day || 0) / snap.of) : 0) : st === "window" ? (snap.clock && snap.clock.hours ? Math.min(1, (snap.day || 0) / snap.clock.hours) : 0.5) : 1;
    const words = st === "upcoming" ? (w.count !== null && w.count !== undefined ? `Announces in ${w.count} days` : "Upcoming")
      : st === "signups" ? (w.count !== null && w.count !== undefined ? `Opens in ${w.count} day${w.count === 1 ? "" : "s"}` : "Signups")
        : st === "window" ? (w.count !== null && w.count !== undefined ? `${w.count} h left` : "Window open")
          : st === "settling" ? w.text.replace("Final", "Settling · final") : w.text;
    return <button className="chip" title={snap.tlLabel || st}>{st === "upcoming" ? <Ring w={12} /> : <ProgressRing pct={pct} color={color} />}{words}</button>;
  }
  if (g === "catalogue") return <button className="chip"><Ring w={12} />Catalogue</button>;
  if (g === "upcoming" || !clock) {
    const w = row ? whenWords(row, asOf) : { text: "Upcoming", count: null };
    return <button className="chip"><Ring w={12} />{w.count !== null && w.count !== undefined ? `${w.text.startsWith("Announces") ? "Announces" : "Closes"} in ${w.count} day${w.count === 1 ? "" : "s"}` : w.text}</button>;
  }
  if (g === "closed" || snap.complete) {
    const ago = asOf ? Math.round((new Date(asOf + "T00:00:00Z") - clock.launch) / 86400000) : null;
    return <button className="chip" title={`Day ${snap.day} of ${snap.of}`}><ProgressRing pct={1} color={color} />{ago !== null && ago >= 0 ? `Closed ${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`}` : `Closed ${onDay(clock.launch, asOf)}`}</button>;
  }
  const left = Math.max(clock.daysLeft, 0);
  return <button className="chip" title={`Day ${snap.day} of ${snap.of}`}><ProgressRing pct={snap.of > 0 ? (snap.day || 0) / snap.of : 0} color={color} />{left === 0 ? "Closes today" : `${left} day${left === 1 ? "" : "s"} left`}</button>;
}

function DatesChip({ snap }) {
  const d = (s) => (s ? fmtDay(new Date(String(s).slice(0, 10) + "T00:00:00Z")) : null);
  const hm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  if (snap.type === "TL" && snap.windowOpen) {
    return <button className="chip" title="The window's open and close, Amsterdam time"><Cal />{d(snap.windowOpen)} {hm(snap.windowOpen)} → {d(snap.windowClose)} {hm(snap.windowClose)}</button>;
  }
  if (!snap.windowStart) return null;
  return <button className="chip" title="The announce and the close"><Cal />{d(snap.windowStart)} → {d(snap.windowEnd)}</button>;
}

const HZ = { today: "Today", close: "At close" };
function HorizonChip({ horizon, onChange, closeLabel }) {
  const m = useMenu();
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button className="chip" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle} title="What every card reads: where the release is today, or the projection at the close">{horizon === "close" ? closeLabel : "Today"}<Caret /></button>
      <Menu open={m.open} onClose={m.close} style={{ top: 30, left: 0, width: 200 }}>
        <MenuItem radio checked={horizon === "today"} onClick={() => { m.close(); onChange("today"); }}>Today</MenuItem>
        <MenuItem radio checked={horizon === "close"} onClick={() => { m.close(); onChange("close"); }}>{closeLabel}</MenuItem>
      </Menu>
    </span>
  );
}
function LineChip({ lines, value, onChange }) {
  const m = useMenu();
  const cur = lines.find((l) => l.key === value);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button className="chip" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle} title="The page for the whole release, or for one line of work">{cur ? cur.name : "All lines"}<Caret /></button>
      <Menu open={m.open} onClose={m.close} style={{ top: 30, left: 0, width: 240 }}>
        <MenuItem radio checked={!value} onClick={() => { m.close(); onChange(null); }}>All lines</MenuItem>
        {lines.map((l) => <MenuItem key={l.key} radio checked={value === l.key} onClick={() => { m.close(); onChange(l.key); }} title={(l.products || []).join(", ")}>{l.name}</MenuItem>)}
      </Menu>
    </span>
  );
}

/* The warning strip under the header: stale data, a failed refresh, a
 * coverage gap, no targets, one line's basis. Only when something needs
 * saying; one line each. */
function Strips({ snap, st, onRefreshed, line, lines, onSetup }) {
  const [hidden, setHidden] = useState({});
  const strips = [];
  // stale: built from data older than the last full day (shared/refreshWatch.mjs says when to reload)
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const ageDays = snap.asOf ? Math.round((today - new Date(snap.asOf + "T00:00:00Z").getTime()) / 86400000) : 0;
  const watch = React.useRef(watchInitial());
  useEffect(() => {
    const r = watchStep(watch.current, st);
    watch.current = r.state;
    if (r.reload) onRefreshed();
  }, [st && st.at, st && st.running]);
  const [retrying, setRetrying] = useState(false);
  const retry = () => { setRetrying(true); fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {}).finally(() => setTimeout(() => setRetrying(false), 4000)); };
  if (ageDays >= 2 && !snap.catalogue) {
    const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const through = fmtDay(new Date(snap.asOf + "T00:00:00Z"), true);
    let what, failed = false;
    if (st && st.running) what = `A refresh started at ${clock(st.runningSince)} is running; this page reloads when it lands`;
    else if (st && st.at && st.ok === false) { failed = true; what = `The last refresh, at ${clock(st.at)}, failed`; }
    else if (st && st.at) what = `The last refresh, at ${clock(st.at)}, did not move this page`;
    else what = "No refresh has completed since the app started";
    strips.push({ key: "stale", icon: <Warn />, text: `Built from data through ${through}, ${ageDays} days behind`, sx: what,
      action: failed && !(st && st.running) ? <button className="sbtn" onClick={retry} disabled={retrying}>{retrying ? "Starting…" : "Retry"}</button> : null });
  }
  const noEvent = snap.untracked && snap.untracked.noEvent;
  if (noEvent && noEvent.high) {
    strips.push({ key: "coverage", icon: <Warn />, text: `${fmt(noEvent.count)} of ${fmt(noEvent.total)} units paid (${Math.round((noEvent.share || 0) * 100)}%) have no purchase event`,
      sx: "They count on Untracked, shared out over the channels; the purchase tag may be missing on part of checkout" });
  }
  if (snap.targeted === false && !snap.catalogue && !snap.upcoming) {
    strips.push({ key: "notargets", icon: <Ring />, text: "No targets yet", sx: "Showing actuals only", action: <button className="sbtn prim" onClick={onSetup}>Set targets</button> });
  }
  if (snap.upcoming && (snap.derived || {}).dates_assumed) {
    strips.push({ key: "assumed", icon: <Ring />, text: "Announce date assumed", sx: (snap.derived || {}).dates_note || "", action: <button className="sbtn" onClick={onSetup}>Set it</button> });
  }
  if (line) {
    const meta = (lines || []).find((l) => l.key === line.key) || {};
    const basis = line.entriesBasis === "draws" ? "its own draws' entries" : line.entriesBasis === "share" ? "the release's entries shared out by its draws" : "no entries of its own yet";
    strips.push({ key: "line", icon: <Ring />, text: `${line.name || meta.name || line.key}: ${basis}`, sx: `units from its own works; paid from ${(line.adsets || []).length ? "its ad set" : "no ad set named"}; sessions shared with the release` });
  }
  return strips.filter((s) => !hidden[s.key]).map((s) => (
    <div key={s.key} className="strip" role="status">{s.icon}<span>{s.text}</span>{s.sx && <span className="sx">{s.sx}</span>}<span className="sp" />{s.action}
      <button className="ib" style={{ margin: 0 }} aria-label="Dismiss" onClick={() => setHidden({ ...hidden, [s.key]: true })}><X /></button></div>
  ));
}

export default function ReleasePage({ snap, snapError, row, asOf, st, route, setRoute, directSpread, setDirectSpread, onSaved, onRefreshed, onOpen, onMenu }) {
  const tab = route.tab || "overview";
  const setTab = (t) => setRoute({ ...route, tab: t, basket: false });
  const [horizon, setHorizon] = useState("today");
  const [lineKey, setLineKey] = useState(null);
  useEffect(() => { setHorizon("today"); setLineKey(null); }, [snap && snap.id]);
  if (!snap) {
    return (
      <main className="page">
        <header className="phead"><button className="ib menub" aria-label="Open the sidebar" onClick={onMenu}><Hamburger /></button><span className="crumb">{row ? nameOf(row).artist : "Release"}</span></header>
        <div style={{ padding: 40, color: "#6b6b6f", maxWidth: 520, lineHeight: 1.5 }}>
          {snapError ? (snapError.pending
            ? <><b style={{ color: "#1b1b1c" }}>{row ? nameOf(row).artist : "This release"}</b> is listed but its page has not been built yet: the first data refresh after a deploy takes a few minutes. Try again shortly.</>
            : <>Could not load this release: {snapError.message}</>) : "Loading…"}
        </div>
      </main>
    );
  }
  const variant = snap.variants && snap.variants.direct_spread;
  const lines = Array.isArray(snap.lines) && snap.lines.length && snap.variants && snap.variants.lines ? snap.lines : null;
  const lineVariant = lines && lineKey ? ((directSpread && snap.variants.lines_direct && snap.variants.lines_direct[lineKey]) || snap.variants.lines[lineKey] || null) : null;
  const view = lineVariant ? { ...snap, ...lineVariant } : directSpread && variant ? { ...snap, ...variant } : snap;
  const isTL = snap.type === "TL";
  const targeted = snap.targeted !== false;
  const W = wordsOf(snap);
  const { artist, work } = nameOf({ releaseName: snap.releaseName, artist: snap.artist, title: snap.title });
  const g = snap.catalogue ? "catalogue" : snap.upcoming ? "upcoming" : row ? groupOf(row, asOf) : snap.complete ? "closed" : "live";
  const crumb = g === "closed" && row && (row.group === "closed") ? "Recent" : GROUP_WORD[g];
  const f = freshness({ asOf: snap.asOf, partial: typeof snap.asOfFraction === "number" && snap.asOfFraction < 1, builtAt: snap.builtAt, st, emailThrough: snap.email && snap.email.feedThrough, funnelNote: snap.funnelNote });
  const showHorizon = targeted && !snap.catalogue && !snap.upcoming && !snap.complete && tab === "overview";
  const targetsWord = targeted ? "Targets" : "Set targets";
  return (
    <main className="page">
      <header className="phead">
        <button className="ib menub" style={{ marginLeft: -8 }} aria-label="Open the sidebar" onClick={onMenu}><Hamburger /></button>
        <span className="crumb">{crumb}</span>
        <Chev />
        <span className="name">{artist}</span><span className="work">{work}</span>
        <Badge type={snap.type} />
        <div className="tabs" role="tablist" aria-label="Release pages">
          <button className={`tab${tab === "overview" ? " on" : ""}`} role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>Overview</button>
          <button className={`tab${tab === "targets" ? " on" : ""}`} role="tab" aria-selected={tab === "targets"} onClick={() => setTab("targets")}>{targetsWord}</button>
        </div>
        <span style={{ flex: 1 }} />
        {tab === "targets" && <span id="phead-status" style={{ display: "inline-flex", alignItems: "center", gap: 8 }} />}
        {f && f.label && tab === "overview" && <span className="fresh" title={[f.head, f.body].filter(Boolean).join(" · ")}>{f.warn ? "⚠ " : ""}{f.label}</span>}
        {tab === "overview" && <DisplayMenu directSpread={directSpread} setDirectSpread={setDirectSpread} snap={snap} />}
      </header>
      {tab === "overview" && (
        <>
          <Strips snap={snap} st={st} onRefreshed={onRefreshed} line={lineVariant ? view.line : null} lines={lines} onSetup={() => setTab("targets")} />
          <div className="chips">
            <StatusChip snap={snap} row={row} asOf={asOf} />
            <DatesChip snap={snap} />
            {isTL && snap.windowHours > 0 && <button className="chip"><Clock />{snap.windowHours % 24 === 0 && snap.windowHours >= 72 ? `${snap.windowHours / 24} day` : `${snap.windowHours} h`} window</button>}
            {snap.marketingLead ? <button className="chip" title={`Marketing lead${String(snap.marketingLead).includes("@") ? " · " + snap.marketingLead : ""}`}><Avatar name={snap.marketingLead} size={16} />{String(snap.marketingLead).split("@")[0]}</button>
              : <button className="chip quiet" title="No marketing lead on file"><Avatar name="" size={16} />No lead</button>}
            {snap.catalogue && <button className="chip"><Cal />Last 90 days</button>}
            {showHorizon && <HorizonChip horizon={horizon} onChange={setHorizon} closeLabel={W.closeLabel} />}
            {lines && <LineChip lines={lines} value={lineKey} onChange={setLineKey} />}
          </div>
          <Overview snap={view} base={snap} horizon={snap.complete ? "close" : horizon} onSetup={() => setTab("targets")} onOpen={onOpen} />
        </>
      )}
      {tab === "targets" && (isTL
        ? <TLTargets snap={snap} onSaved={onSaved} directSpread={!!(variant && directSpread)} route={route} setRoute={setRoute} />
        : <TargetSetting snap={snap} onSaved={onSaved} directSpread={!!(variant && directSpread)} route={route} setRoute={setRoute} />)}
    </main>
  );
}
