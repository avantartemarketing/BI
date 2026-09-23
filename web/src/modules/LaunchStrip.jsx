/* The campaign clock: a thin strip showing where the release sits between
 * announcement and launch. Blue fills to today, a knob marks the day (the
 * day of the window is in the strip's popup, not printed over the knob), a
 * tick marks the launch, and the days to go are the strip's only bold words.
 * It is a card of the Overview (Layout.jsx, size "strip": a full-width row of
 * its own), first by default and movable like the rest, and it replaces the
 * "Day N of M" chip the header carried, which gave the position but not the
 * distance or the dates. A catalogue release has no window and gets no strip. */
import React from "react";
import { fmtDay, useTip } from "../ui.jsx";

const DAY_MS = 86400000;
const iso = (s) => new Date(s + "T00:00:00Z");
const days = (n) => `${n} ${Math.abs(n) === 1 ? "day" : "days"}`;

export default function LaunchStrip({ snap }) {
  const t = useTip();
  if (!snap || snap.catalogue || !snap.windowStart || !snap.windowEnd || !snap.asOf) return null;
  const announce = iso(snap.windowStart), launch = iso(snap.windowEnd), today = iso(snap.asOf);
  const span = Math.round((launch - announce) / DAY_MS);
  if (!(span > 0)) return null;
  const elapsed = Math.round((today - announce) / DAY_MS);
  const left = span - elapsed;
  const opened = elapsed >= 0, launched = elapsed >= span;
  const p = Math.max(0, Math.min(elapsed / span, 1)) * 100;

  const rows = [
    { label: opened ? "Announced" : "Announces", value: fmtDay(announce, true) },
    { label: launched ? "Launched" : "Launch", value: fmtDay(launch, true) },
    { label: "Window", value: days(span) },
    { label: "Today", value: !opened ? `opens in ${days(-elapsed)}` : launched ? (left === 0 ? "launch day" : `${days(-left)} after launch`) : `day ${snap.day} of ${snap.of}` },
  ];
  if (opened && !launched) rows.push({ label: "Days left", value: String(left) });

  const right = !launched
    ? <><b>{days(left)} to launch</b> · {fmtDay(launch, true)}</>
    : left === 0
      ? <><b>Launch day</b> · {fmtDay(launch, true)}</>
      : <>Launched {fmtDay(launch, true)}</>;

  return (
    <div className="launch-strip" {...t.props({ head: "Campaign window", rows })}>
      <span>{opened ? "Announced" : "Announces"} {fmtDay(announce, true)}</span>
      <span className="track">
        <span className="fill" style={{ width: `${p}%` }} />
        {opened && !launched && <span className="knob" style={{ left: `${p}%` }} />}
        <span className="launch" />
      </span>
      <span>{right}</span>
    </div>
  );
}
