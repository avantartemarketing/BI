/* Sell-through at close (snap.closeForecast, etl/build.py): the units the
 * release is projected to end on as a share of its edition, with the range
 * eight in ten past launches landed in (read from the backtest at this day
 * of the campaign) and a confidence word set by that range's width. One
 * bar for the release: today's units deep, the units at close light, the
 * range a pale band behind, the units target a dashed tick; then the same
 * bar per work, a work the projection fills marked "Likely sells out". Every
 * bar is a row with its name on the left and its share on the right, the
 * release's first ("All works"), and the key sits under them all at the
 * foot of the card (5 November 2026).
 * The head carries the share at close, a confidence lozenge and the daily
 * spend the projection assumes (the recommended level, reached from today's
 * by steps of up to 30% a day); its change from today's and the spend at
 * close are on that lozenge's hover. The working - what the projection is
 * built from, the range's source and the confidence reason - is on the
 * confidence lozenge's hover. A closed release has the
 * projection equal to its units, so the range and the paid assumption are
 * left off. The works sit under a header per line of work, variants of one
 * work by their variant (workGroups.mjs), each with its share at close;
 * the range, the units and the figures behind the legend are on hover. */
import React, { useState } from "react";
import { Card, Head, Loz, Seg } from "../ui.jsx";
import { COL, Keys, sw, kfmt } from "../charts.jsx";
import { fmt, fmtPct, fmtMoney } from "../format.mjs";
import { groupByLine, shownNames } from "../workGroups.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const money = (v) => fmtMoney(Math.round(v ?? 0));
// money in thousands to one decimal (€10.2k), whole euros under a thousand
const kmoney = (v) => (has(v) ? (Math.abs(v) >= 1000 ? `€${(v / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : money(v)) : "–");
const CONF = { high: ["High", "good"], medium: ["Medium", "amber"], low: ["Low", "warm"] };
const RANGE_BORDER = "#dfe2f8";

/* The bar on its scale (the edition where known): the range pale behind,
 * the units at close light, today's deep, the target a dashed tick. Drawn
 * in percentages of the box, so it needs no measuring. The bars are 16px,
 * as the Sell-through by product card's, the range band 8px taller. */
function RangeBar({ xmax, today, units, lo, hi, target, title }) {
  const p = (v) => (xmax > 0 && has(v) ? Math.max(0, Math.min(100, (v / xmax) * 100)) : null);
  const bh = 16, rh = 24, h = rh + 4, mid = h / 2;
  const pt = p(today), pu = p(units), plo = p(lo), phi = p(hi), ptg = p(target);
  const ranged = plo !== null && phi !== null && phi > plo;
  return (
    <div className="plot" style={{ height: h }} title={title}>
      <svg width="100%" height={h} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
        <rect x="0" y={mid - bh / 2} width="100%" height={bh} rx="4" fill={COL.TRACK} />
        {ranged && <rect x={`${plo}%`} y={mid - rh / 2} width={`${phi - plo}%`} height={rh} rx="5" fill={COL.PALE} stroke={RANGE_BORDER} strokeWidth="1" />}
        {pu !== null && pu > 0 && <rect x="0" y={mid - bh / 2} width={`${pu}%`} height={bh} rx="4" fill={COL.LIGHT} />}
        {pt !== null && pt > 0 && <rect x="0" y={mid - bh / 2} width={`${pt}%`} height={bh} rx="4" fill={COL.DEEP} />}
        {ptg !== null && <line x1={`${ptg}%`} x2={`${ptg}%`} y1={0} y2={h} stroke={COL.MUTED} strokeWidth="1" strokeDasharray="3 2" />}
      </svg>
    </div>
  );
}

/* the scale a bar is read on: the edition, else the furthest figure on it */
const scaleOf = (r) => (has(r.edition) && r.edition > 0 ? r.edition : Math.max(1, ...[r.hi, r.units, r.target, r.today].filter(has)));

// the paid assumptions the card can read the close under (closeForecast.scenarios)
const MODES = [["recommended", "Recommended"], ["current", "Today's"], ["none", "None"]];

export default function SellThroughClose({ snap, vs = "target" }) {
  const base = snap.closeForecast;
  const [mode, setMode] = useState("recommended");
  const title = "Sell-through at close";
  if (!base || !has(base.units)) return <Card title={title}><div className="empty-state">No projection at close yet</div></Card>;
  // the reading under the chosen paid assumption; the block's own figures are the recommended one's
  const scenarios = base.scenarios && base.scenarios.recommended && base.scenarios.current && base.scenarios.none ? base.scenarios : null;
  const cf0 = scenarios && scenarios[mode] ? { ...base, ...scenarios[mode] } : base;
  // the tick is the units target, or the benchmark at close when the page reads against it
  const byBm = vs === "benchmark";
  const bmClose = snap.hero && has(snap.hero.benchmark) ? snap.hero.benchmark : null;
  const refName = byBm ? "Benchmark" : "Target";
  const cf = { ...cf0, target: byBm ? bmClose : cf0.target };
  // closed means the campaign has closed, never that the figures agree: a
  // launch sold out before its close reads today = at close = the edition
  // and still carries its toggle and its paid assumption
  const complete = !!snap.complete;
  const byPct = has(cf.pct);
  const ranged = !complete && has(cf.lo) && has(cf.hi) && cf.hi > cf.lo;
  const rangeWord = ranged ? (has(cf.pctLo) && has(cf.pctHi) ? `${Math.round(cf.pctLo * 100)}-${Math.round(cf.pctHi * 100)}% likely` : `${fmt(cf.lo)}-${fmt(cf.hi)} likely`) : null;
  const [confWord, confKind] = CONF[cf.confidence] || [null, null];
  const days = has(cf.daysLeft) ? cf.daysLeft : null;
  const daysWord = complete ? "closed" : days === null ? "" : days === 1 ? "1 day left" : `${fmt(days)} days left`;
  const b = cf.built || {};
  const paid = cf.paid || null;
  const range = cf.range || null;
  const working = [
    `${title}, how it is read`,
    `Projected ${fmt(cf.units)}${has(cf.edition) ? ` of ${fmt(cf.edition)} (${fmtPct(cf.pct, 0)})` : ""} · today ${fmt(cf.today)}${has(cf.pctToday) ? ` (${fmtPct(cf.pctToday, 0)})` : ""}${daysWord ? ` · ${daysWord}` : ""}`,
    ...(has(cf.target) ? [byBm ? `Benchmark at close ${fmt(cf.target)}` : `Units target ${fmt(cf.target)}`] : []),
    ...(Object.keys(b).length ? [`Built from: sold ${fmt(b.sold)} + in hand ${fmt(b.inHand)} + organic to come ${fmt(b.organic)} + paid to come ${fmt(b.paid)}`] : []),
    ...(paid ? [`Paid: runs at ${money(paid.daily)} a day${has(paid.today) ? ` (today ${money(paid.today)})` : ""}, ${kmoney(paid.spendAtClose)} at close${has(paid.budget) ? ` against a budget of ${money(paid.budget)}` : ""}`, ...(paid.rule ? [paid.rule] : [])] : []),
    ...(ranged ? [`Range ${fmt(cf.lo)}-${fmt(cf.hi)}${has(cf.pctLo) && has(cf.pctHi) ? ` (${Math.round(cf.pctLo * 100)}-${Math.round(cf.pctHi * 100)}%)` : ""}${range && range.note ? `: ${range.note}` : ""}${range && has(range.n) ? ` (${fmt(range.n)} launches)` : ""}`] : []),
    ...(confWord ? [`Confidence ${confWord.toLowerCase()}${cf.confidenceWhy ? `: ${cf.confidenceWhy}` : ""}`] : []),
  ].join("\n");
  const works = Array.isArray(cf.works) ? cf.works.filter((w) => w && has(w.units)) : [];
  const xmax = scaleOf(cf);
  const legend = [
    { n: "Today", k: sw(COL.DEEP), tip: `Today ${fmt(cf.today)}` },
    { n: complete ? "At the close" : "At close", k: sw(COL.LIGHT), tip: `At close ${fmt(cf.units)}${has(cf.edition) ? ` of ${fmt(cf.edition)}` : ""}` },
    ...(ranged ? [{ n: "Likely range", k: { ...sw(COL.PALE), width: 10, height: 10, flex: "0 0 10px", border: `1px solid ${RANGE_BORDER}` }, tip: `${fmt(cf.lo)}-${fmt(cf.hi)}${range && range.note ? `: ${range.note}` : ""}` }] : []),
    ...(has(cf.target) ? [{ n: refName, k: { width: 12, height: 0, flex: "0 0 12px", borderTop: `1px dashed ${COL.MUTED}` }, tip: byBm ? `Benchmark at close ${fmt(cf.target)}` : `Units target ${fmt(cf.target)}` }] : []),
  ];
  // the works: under a header per line, each by its variant where they are variants of one work
  const workRow = (w, shown) => {
    const wr = !complete && has(w.lo) && has(w.hi);
    const tip = `${w.name}${has(w.edition) ? ` · edition ${fmt(w.edition)}` : ""}\nToday ${fmt(w.today)} · at close ${fmt(w.units)}${has(w.pct) ? ` (${fmtPct(w.pct, 0)})` : ""}${wr ? `\nRange ${fmt(w.lo)}-${fmt(w.hi)}${has(w.pctLo) && has(w.pctHi) ? ` (${Math.round(w.pctLo * 100)}-${Math.round(w.pctHi * 100)}%)` : ""}` : ""}${w.sellsOut ? `\n${complete ? "Sold out" : "Likely sells out"}` : ""}`;
    return (
      <div className="prow st" key={w.key} title={tip}>
        <span className="nm">{shown || w.name}</span>
        <RangeBar xmax={scaleOf(w)} today={w.today} units={w.units} lo={wr ? w.lo : null} hi={wr ? w.hi : null} target={null} />
        <span className={`fig${w.sellsOut ? " good" : ""}`}><b>{w.sellsOut ? "100%" : has(w.pct) ? fmtPct(w.pct, 0) : fmt(w.units)}</b></span>
      </div>
    );
  };
  const keyed = works.map((w, i) => ({ ...w, key: w.key || w.name || String(i) }));
  const groups = groupByLine(snap, keyed) || [{ key: "_all", name: "By work", rows: keyed }];
  let nameLen = 0;
  const worksBody = groups.map((g) => {
    const sn = shownNames(g.rows);
    nameLen = Math.max(nameLen, sn.longest);
    return (
      <div className="stgrp" key={`g:${g.key}`}>
        <div className="prow st grp" title={sn.base && g.name !== sn.base ? `${g.name} (${sn.base})` : g.name}><span className="nm">{g.name}</span></div>
        {g.rows.map((w, i) => workRow(w, sn.names[i]))}
      </div>
    );
  });
  // the paid assumption: the change from today's spend, as a share of it
  const dir = paid ? paid.direction : null;
  const chg = paid && has(paid.change) ? Math.round(Math.abs(paid.change) * 100) : null;
  const showChange = paid && has(paid.today) && paid.today !== paid.daily && dir !== "stop";
  const dirWord = dir === "stop" ? "stops now" : dir === "hold" ? "held" : dir === "start" ? "from nothing" : null;
  // the paid assumption's daily spend, its change from today's and the spend at close on hover
  const spendTip = paid ? [
    showChange && chg !== null && chg > 0 ? `${dir === "raise" || dir === "start" ? "Up" : "Down"} ${chg}% from ${money(paid.today)} a day today` : null,
    dirWord ? `Paid ${dirWord}` : null,
    has(paid.spendAtClose) ? `${kmoney(paid.spendAtClose)} spent by close${has(paid.budget) ? `, against a budget of ${money(paid.budget)}` : ""}` : null,
    paid.rule || null,
  ].filter(Boolean).join("\n") : "";
  const spendLoz = paid && has(paid.daily) && !complete
    ? <Loz tip={spendTip || undefined}>{paid.daily > 0 ? `${money(paid.daily)} a day` : "No paid spend"}</Loz>
    : null;
  // the toggle: the three paid assumptions, each with its daily figure
  const seg = scenarios && !complete
    ? <Seg label="Paid assumption" value={mode} onChange={setMode}
        options={MODES.map(([k, l]) => [k, l,
          k === "recommended" ? `${money(scenarios[k].paid && scenarios[k].paid.daily)} a day: the level at which the next euro of paid spend returns what it costs, reached from today's by steps of up to 30% a day`
            : k === "current" ? `${money(scenarios[k].paid && scenarios[k].paid.daily)} a day: today's daily spend held to the close` : "No more paid spend from now: the organic course alone"])} />
    : null;
  return (
    <Card title={title} aria={title} seg={seg}>
      <Head v={byPct ? fmtPct(cf.pct, 0) : fmt(cf.units)} u={complete ? (byPct ? "at the close" : "units at the close") : byPct ? null : "units"}>
        {confWord && <Loz kind={confKind} icon={<span className="dot" />}
          tip={[rangeWord ? `${rangeWord} (${fmt(cf.lo)}-${fmt(cf.hi)})${range && range.note ? `: ${range.note}` : ""}` : null, cf.confidenceWhy || null, "", working].filter((x) => x !== null).join("\n")}>{confWord} confidence</Loz>}
        {spendLoz}
      </Head>
      <div style={{ "--nmw": `${Math.min(Math.max(nameLen, 8), 30)}ch` }}>
        <div className="prow st" title={`Today ${fmt(cf.today)} · at close ${fmt(cf.units)}${ranged ? ` · range ${fmt(cf.lo)}-${fmt(cf.hi)}` : ""}${has(cf.target) ? ` · ${refName.toLowerCase()} ${fmt(cf.target)}` : ""}`}>
          <span className="nm">{works.length > 0 ? "All works" : "Edition"}</span>
          <RangeBar xmax={xmax} today={cf.today} units={cf.units} lo={ranged ? cf.lo : null} hi={ranged ? cf.hi : null} target={cf.target} />
          <span className="fig"><b>{byPct ? fmtPct(cf.pct, 0) : fmt(cf.units)}</b></span>
        </div>
        {worksBody}
      </div>
      <Keys legend={legend} style={{ marginTop: 14 }} />
    </Card>
  );
}
