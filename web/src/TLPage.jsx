/* The timed-launch page's own pieces (docs/TL_SPEC.md §4, §5, §9). The
 * cards are the LE cards, rendered through the shared layout in the state's
 * words (web/src/vocab.mjs): signups before the window opens, units inside
 * it. What a timed launch has that an LE has not lives here: the header's
 * chips (the state, the open and the close, the units target), the clock
 * strip that runs announce -> open -> close with hours inside the window, and
 * the pre-window's result once the window has opened. */
import React from "react";
import { Card, C, GROUP_DOTS, fmt, fmtPct, fmtDay, useTip } from "./ui.jsx";

const DAY_MS = 86400000;
const when = (iso, withTime = true) => {
  if (!iso) return "–";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  const day = fmtDay(d, true);
  if (!withTime || !/T/.test(String(iso))) return day;
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  return `${day} ${hm}`;
};
const hours = (h) => (h === null || h === undefined ? "" : h % 24 === 0 && h >= 72 ? `${h / 24} days` : `${Math.round(h)} hours`);
const STATE_WORDS = {
  upcoming: "Upcoming", signups: "Signups", window: "Window open", settling: "Settling", closed: "Closed",
};

/* ---------------------------------------------------------------- header chips */

export function TLChips({ snap }) {
  const t = useTip();
  const st = snap.tlState;
  const rows = [
    { label: "Announced", value: when(snap.windowStart, false) },
    ...(snap.earlyAccessOpen ? [{ label: snap.earlyAccessAssumed ? "Early access (expected)" : "Early access", value: when(snap.earlyAccessOpen) }] : []),
    { label: "Opens", value: when(snap.windowOpen) },
    { label: "Closes", value: when(snap.windowClose) },
    { label: "Window", value: hours(snap.windowHours) },
    { label: "Settles", value: when(snap.settleEnd, false) },
  ];
  const note = (snap.derived || {}).dates_note;
  return (
    <>
      <span className="chip" {...t.props({ head: `${STATE_WORDS[st] || st} · ${snap.tlLabel || ""}`, rows, body: note || undefined })}
        style={st === "window" ? { background: "#e4f3ec", color: C.green } : undefined}>
        {snap.tlLabel || STATE_WORDS[st]}
      </span>
      <span className="chip" title="The public window, Amsterdam time: Airtable's launch date at its launch time, else the feed's timestamp, else 14:00">
        {st === "window" ? `Closes ${when(snap.windowClose)}` : st === "settling" || st === "closed" ? `Closed ${when(snap.windowClose)}` : `Opens ${when(snap.windowOpen)}`} · {hours(snap.windowHours)}
      </span>
      {snap.economics && snap.economics.units_target > 0 && (
        <span className="chip" title={`Airtable's units target summed over the ticked works${snap.economics.edition_size ? `, of an edition of ${fmt(snap.economics.edition_size)}` : ""}`}>
          Target {fmt(snap.economics.units_target)} units{snap.economics.edition_size ? ` · ${fmt(snap.economics.edition_size)} edition` : ""}
        </span>
      )}
      {!snap.targeted && (
        <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }}
          title="No units target in Airtable and none typed, so there is no signup target - the page shows actuals and the basket">No target</span>
      )}
      {(snap.derived || {}).dates_assumed && (
        <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }} title={note || "A date is assumed"}>Dates assumed</span>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- the strip */

export function TLStrip({ snap }) {
  const t = useTip();
  if (!snap.windowStart || !snap.salesOpen) return null;
  const announce = new Date(snap.windowStart + "T00:00:00Z");
  const open = new Date(snap.salesOpen);
  const close = new Date(snap.windowClose);
  const now = snap.builtAt ? new Date(snap.builtAt) : new Date();
  const st = snap.tlState;
  const inWindow = st === "window" || st === "settling" || st === "closed";
  const a = inWindow ? open : announce, b = inWindow ? close : open;
  const span = b - a;
  const p = span > 0 ? Math.max(0, Math.min((now - a) / span, 1)) * 100 : 0;
  const daysTo = Math.ceil((open - now) / DAY_MS);
  const hoursLeft = (close - now) / 3600000;
  const rows = [
    { label: "Announced", value: when(snap.windowStart, false) },
    { label: snap.earlyAccessAssumed ? "Early access expected" : snap.earlyAccessOpen ? "Early access" : "Sales open", value: when(snap.salesOpen) },
    { label: "Public open", value: when(snap.windowOpen) },
    { label: "Closes", value: when(snap.windowClose) },
    { label: "Window", value: hours(snap.windowHours) },
  ];
  let right;
  if (st === "upcoming" || st === "signups") right = <><b>{daysTo} {daysTo === 1 ? "day" : "days"} to the open</b> · {when(snap.salesOpen)}</>;
  else if (st === "window") right = <><b>{Math.max(Math.ceil(hoursLeft), 0)} h left</b> · closes {when(snap.windowClose)}</>;
  else if (st === "settling") right = <><b>Settling</b> · final {when(snap.settleEnd, false)}</>;
  else right = <>Closed {when(snap.windowClose)}</>;
  return (
    <div className="launch-strip" {...t.props({ head: "Launch window", rows })}>
      <span>{inWindow ? `Opened ${when(snap.salesOpen)}` : `Announced ${when(snap.windowStart, false)}`}</span>
      <span className="track">
        <span className="fill" style={{ width: `${p}%` }} />
        {p > 0 && p < 100 && <span className="knob" style={{ left: `${p}%` }} />}
        <span className="launch" />
      </span>
      <span>{right}</span>
    </div>
  );
}

/* The pre-window's result, once the window has opened: a card of the layout
 * (Layout.jsx tl_signups), on a timed launch only. */
export function TLSignupsOutcome({ snap }) {
  const hero = snap.hero || {};
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  const sg = snap.signups || {};
  return (
    <Card dot={GROUP_DOTS.outcome} title="Pre-window signups">
      <div className="spacer-8" />
      <div style={row}><span style={{ color: C.muted }}>Signups before the open</span><span className="num">{fmt(sg.preWindow || 0)}</span></div>
      {hero.target ? <div style={row}><span style={{ color: C.muted }}>Signup target</span><span className="num">{fmt(hero.target)}</span></div> : null}
      {hero.benchmark ? <div style={row}><span style={{ color: C.muted }}>Benchmark</span><span className="num">{fmt(hero.benchmark)}</span></div> : null}
      <div style={row}><span style={{ color: C.muted }}>Signups since the open</span><span className="num">{fmt(Math.max((sg.total || 0) - (sg.preWindow || 0), 0))}</span></div>
      <div style={{ ...row, borderBottom: "none" }}><span style={{ color: C.muted }}>Signups that converted (feed flag)</span><span className="num">{sg.converted !== null && sg.converted !== undefined ? `${fmt(sg.converted)} · ${sg.total > 0 ? fmtPct(sg.converted / sg.total, 1) : "–"}` : "–"}</span></div>
    </Card>
  );
}

export default TLChips;
