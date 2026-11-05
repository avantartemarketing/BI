/* Gap to target, or Gap to benchmark: each driver as its units added or lost
 * against the level the page's Compare to switch reads against, a bar right
 * of that line in indigo where it added, left in orange where it cost, the
 * figure at the bar's end; the same shape as the email funnel beneath it, no
 * key (5 November 2026, in place of the waterfall). Never both levels on one
 * card (3 November 2026). The drivers are the four stored contributors
 * (organic traffic and conversion, paid spend and efficiency), measured
 * against the target (waterfall.steps) or against the basket
 * (waterfall.stepsBm); Today walks waterfall.today to the units secured so
 * far, At close walks the projection (docs 9). The Channels view reads each
 * channel against its own benchmark (or target), whole units that add up
 * (figures.mjs channelWalk). Demand the edition cannot hold is the last row
 * on a sold-out release. Projection and the to-date figures are stored
 * model outputs, never re-derived here. */
import React, { useState } from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, COL, sw } from "../charts.jsx";
import { fmt, fmtSigned } from "../format.mjs";
import { channelWalk } from "../figures.mjs";
import { wordsOf } from "../vocab.mjs";

const has = (v) => v !== null && v !== undefined;
/* the axis top: a round number with a quarter's headroom for the figures at the bar ends */
const axisTop = (lim) => { const want = lim * 1.3; const p = Math.pow(10, Math.floor(Math.log10(Math.max(want, 1)))); return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((s) => s >= want) || want; };

export default function Waterfall({ snap, vs = "target", horizon = "today" }) {
  const [by, setBy] = useState("drivers");
  const wf = snap.waterfall;
  const W = wordsOf(snap);
  // an older snapshot carries no waterfall.today, so Today falls back to the close shape
  const td = horizon === "today" && wf && wf.today ? wf.today : null;
  const isToday = !!td;
  const complete = !!snap.complete;
  const menu = [
    { label: "Drivers", radio: true, checked: by === "drivers", onClick: () => setBy("drivers") },
    { label: "Channels", radio: true, checked: by === "channels", onClick: () => setBy("channels") },
  ];
  if (!wf) {
    return (
      <Card title={vs === "benchmark" ? "Gap to benchmark" : "Gap to target"} menu={menu}>
        <div className="empty-state">{snap.targeted === false ? "Needs targets: the gap reads against a target" : "No projection model yet"}</div>
      </Card>
    );
  }
  const view = td || wf;
  const target = view.target ?? 0;
  const outcome = (isToday ? view.actual : view.projection) ?? 0;
  const hasBm = vs === "benchmark" && !!snap.benchmark && has(view.benchmark) && Array.isArray(view.stepsBm);
  const ref = hasBm ? view.benchmark : target;
  const refWord = hasBm ? "benchmark" : "target";
  const RefName = hasBm ? "Benchmark" : "Target";
  const cardTitle = `Gap to ${refWord}`;
  const drivers = ((hasBm ? view.stepsBm : view.steps) || []).map((s) => [s.key === "oversubscribed" ? "Beyond sellout" : s.label, s.value ?? 0]);
  const cw = by === "channels" ? channelWalk(snap, { today: isToday, ref: hasBm ? "benchmark" : "target" }) : null;
  const chans = cw ? cw.steps.map((c) => [c.label, c.value]).concat(cw.beyond < 0 ? [["Beyond sellout", cw.beyond]] : []) : [];
  const steps = by === "channels" ? chans : drivers;
  const vals = steps.map((s) => s[1]);
  const top = axisTop(Math.max(1, ...vals.map((v) => Math.abs(v))));
  const net = outcome - ref;
  const closeWord = complete ? "Final" : "Projected";
  const whenWord = isToday ? W.toDate : `${closeWord} at the ${W.closeWord}`;
  const body = by === "channels"
    ? `From the ${hasBm ? "benchmark, the basket's median," : "target"} each channel by its own ${W.unit} against its own ${refWord}, in the page's order; they add up to the release's demand, so on a sold-out release the last row, Beyond sellout, is the drop to the capped figure.`
    : isToday
      ? `Against the ${hasBm ? "benchmark, what launches like this one typically have by now," : "target"} the contributors sum exactly to the gap between it and the ${W.unit} ${W.securedLower} to date.`
      : `Against the ${hasBm ? "benchmark, the basket's median at close," : "target"} the contributors sum exactly to the gap between it and the projection at close; demand beyond the sellout is the last row.`;
  const signed = (v) => fmtSigned(Math.round(v));
  return (
    <Card title={<span title={body}>{cardTitle}</span>} aria={cardTitle} menu={menu}>
      <Head v={fmtSigned(net)} u={`${W.unit} vs ${refWord}${!isToday && !complete ? " at close" : ""}`}
        aside={isToday && snap.day ? `${W.stepWord} ${snap.day}` : ""}
        asideTip={`${whenWord}: ${fmt(outcome)} ${W.unit} against a ${fmt(ref)} ${refWord}`} />
      {steps.length ? (
        <HBarChart H={34 + steps.length * 34} L={164} bh={12} xmin={-top} xmax={top} xticks={[-top, -top / 2, 0, top / 2, top]}
          xfmt={(t) => (t === 0 ? RefName : signed(t))} valFmt={signed}
          rows={steps.map((s) => s[0])} diverging vals={vals} posColor={COL.IND} negColor={COL.ORANGE}
          title={(i) => steps[i][0]}
          rows2={(i) => [{ n: `${W.Unit} ${vals[i] >= 0 ? "added" : "lost"} against the ${refWord}`, v: `${signed(vals[i])} ${W.unit}`, k: sw(vals[i] >= 0 ? COL.IND : COL.ORANGE) }]}
          aria={`${cardTitle}: ${fmtSigned(net)} ${W.unit}; ${steps.map((s) => `${s[0]} ${fmtSigned(s[1])}`).join(", ")}`} />
      ) : <div className="empty-state">No drivers to read yet</div>}
    </Card>
  );
}
