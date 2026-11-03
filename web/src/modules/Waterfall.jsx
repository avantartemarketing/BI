/* Gap to target, or Gap to benchmark: from the level the page's Compare to
 * switch reads against through each driver to the units, never both levels
 * on one card (3 November 2026). The drivers are the four stored
 * contributors (organic traffic and conversion, paid spend and efficiency),
 * measured against the target (waterfall.steps) or against the basket
 * (waterfall.stepsBm); Today walks waterfall.today to the units
 * secured so far, At close walks the projection (docs 9). The Channels view
 * steps each channel from its benchmark (or target) to its own units, whole
 * units that add up (figures.mjs channelWalk). Demand the edition cannot
 * hold is the last step down on a sold-out release. Projection and the
 * to-date figures are stored model outputs, never re-derived here. */
import React, { useState } from "react";
import { Card, Head } from "../ui.jsx";
import { WaterfallChart, niceAxis, kfmt } from "../charts.jsx";
import { fmt, fmtSigned } from "../format.mjs";
import { channelWalk } from "../figures.mjs";
import { wordsOf } from "../vocab.mjs";

const has = (v) => v !== null && v !== undefined;
const brk = (s) => (s.length > 8 && s.includes(" ") ? s.replace(" ", "\n") : s);

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
  const start = hasBm ? view.benchmark : target;
  const ref = start;
  const refWord = hasBm ? "benchmark" : "target";
  const RefName = hasBm ? "Benchmark" : "Target";
  const cardTitle = `Gap to ${refWord}`;
  const drivers = ((hasBm ? view.stepsBm : view.steps) || []).map((s) => [s.key === "oversubscribed" ? "Beyond sellout" : s.label, s.value ?? 0]);
  const cw = by === "channels" ? channelWalk(snap, { today: isToday, ref: hasBm ? "benchmark" : "target" }) : null;
  const chans = cw ? cw.steps.map((c) => [c.label, c.value]).concat(cw.beyond < 0 ? [["Beyond sellout", cw.beyond]] : []) : [];
  const steps = by === "channels" ? chans : drivers;
  // the running levels set the scale, the target with them
  const levels = [start, outcome];
  let run = start;
  steps.forEach((s) => { run += s[1]; levels.push(run); });
  const lo = Math.min(0, ...levels), hi = Math.max(1, ...levels);
  const ax = niceAxis(hi);
  const ymin = lo < 0 ? -niceAxis(-lo).ymax : 0;
  const net = outcome - ref;
  const endName = !isToday && !complete ? "Projected" : "Actual";
  const closeWord = complete ? "Final" : "Projected";
  const body = by === "channels"
    ? `From the ${hasBm ? "benchmark, the basket's median," : "target"} each channel steps by its own ${W.unit} against its own ${refWord}, in the page's order; they add up to the release's demand, so on a sold-out release the last step, Beyond sellout, drops to the capped figure.`
    : isToday
      ? `From the ${hasBm ? "benchmark, what launches like this one typically have by now," : "target"} the contributors sum exactly to the gap between it and the ${W.unit} ${W.securedLower} to date.`
      : `From the ${hasBm ? "benchmark, the basket's median at close," : "target"} the contributors sum exactly to the gap between it and the projection at close; demand beyond the sellout is the last step.`;
  return (
    <Card title={<span title={body}>{cardTitle}</span>} aria={cardTitle} menu={menu}>
      <Head v={fmtSigned(net)} u={`${W.unit} vs ${refWord}${!isToday && !complete ? " at close" : ""}`}
        aside={isToday && snap.day ? `${W.stepWord} ${snap.day}` : ""}
        asideTip={`${isToday ? W.toDate : `${closeWord} at the ${W.closeWord}`}: ${fmt(outcome)} ${W.unit} against a ${fmt(ref)} ${refWord}`} />
      <WaterfallChart H={262} L={40} ymin={ymin} ymax={ax.ymax} yticks={ax.ticks.filter((t) => t >= ymin)} yfmt={kfmt}
        start={start} startName={RefName} steps={steps} endName={endName}
        short={[RefName, ...steps.map((s) => brk(s[0])), endName]} target={ref} targetName={RefName} unit={W.unit}
        aria={`${cardTitle}: ${fmtSigned(net)} ${W.unit}; ${steps.map((s) => `${s[0]} ${fmtSigned(s[1])}`).join(", ")}`} />
    </Card>
  );
}
