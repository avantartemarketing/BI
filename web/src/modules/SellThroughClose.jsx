/* Sell-through at close (snap.closeForecast, etl/build.py): the units the
 * release is projected to end on as a share of its edition, with the range
 * eight in ten past launches landed in (read from the backtest at this day
 * of the campaign) and a confidence word set by that range's width. One
 * bar for the release: today's units deep, the units at close light, the
 * range a pale band behind, the units target a dashed tick; then the same
 * bar per work, a work the projection fills marked "Likely sells out".
 * Under it the paid assumption the projection rests on: the daily spend it
 * runs at (the recommended level, reached from today's by steps of up to
 * 30% a day) against today's, and the spend at close. The working - what
 * the projection is built from, the paid rule, the range's source and the
 * confidence reason - is on the aside's hover. A closed release has the
 * projection equal to its units, so the range and the paid assumption are
 * left off. */
import React, { useState } from "react";
import { Card, Head, Loz, Seg } from "../ui.jsx";
import { COL, Keys, sw, kfmt } from "../charts.jsx";
import { Up, Dn } from "../icons.jsx";
import { fmt, fmtPct, fmtMoney } from "../format.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const money = (v) => fmtMoney(Math.round(v ?? 0));
// money in thousands to one decimal (€10.2k), whole euros under a thousand
const kmoney = (v) => (has(v) ? (Math.abs(v) >= 1000 ? `€${(v / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : money(v)) : "–");
const CONF = { high: ["High", "good"], medium: ["Medium", "amber"], low: ["Low", "warm"] };
const RANGE_BORDER = "#dfe2f8";

/* The bar on its scale (the edition where known): the range pale behind,
 * the units at close light, today's deep, the target a dashed tick. Drawn
 * in percentages of the box, so it needs no measuring; the target's label
 * sits beside the tick the way chart labels do. */
function RangeBar({ xmax, today, units, lo, hi, target, big, title }) {
  const p = (v) => (xmax > 0 && has(v) ? Math.max(0, Math.min(100, (v / xmax) * 100)) : null);
  const h = big ? 34 : 14, bh = big ? 8 : 6, rh = big ? 18 : 14;
  const mid = big ? 21 : 7;
  const pt = p(today), pu = p(units), plo = p(lo), phi = p(hi), ptg = p(target);
  const ranged = plo !== null && phi !== null && phi > plo;
  return (
    <div className="plot" style={{ height: h }} title={title}>
      <svg width="100%" height={h} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
        <rect x="0" y={mid - bh / 2} width="100%" height={bh} rx={bh / 2} fill={COL.TRACK} />
        {ranged && <rect x={`${plo}%`} y={mid - rh / 2} width={`${phi - plo}%`} height={rh} rx="3" fill={COL.PALE} stroke={RANGE_BORDER} strokeWidth="1" />}
        {pu !== null && pu > 0 && <rect x="0" y={mid - bh / 2} width={`${pu}%`} height={bh} rx={bh / 2} fill={COL.LIGHT} />}
        {pt !== null && pt > 0 && <rect x="0" y={mid - bh / 2} width={`${pt}%`} height={bh} rx={bh / 2} fill={COL.DEEP} />}
        {ptg !== null && <line x1={`${ptg}%`} x2={`${ptg}%`} y1={mid - rh / 2 - 2} y2={mid + rh / 2 + 2} stroke={COL.MUTED} strokeWidth="1" strokeDasharray="3 2" />}
      </svg>
      {ptg !== null && big && (ptg > 80
        ? <span className="lab" style={{ right: `calc(${100 - ptg}% + 5px)`, top: -1, color: COL.MUTED }}>Target {fmt(target)}</span>
        : <span className="lab" style={{ left: `calc(${ptg}% + 5px)`, top: -1, color: COL.MUTED }}>Target {fmt(target)}</span>)}
    </div>
  );
}

/* the scale a bar is read on: the edition, else the furthest figure on it */
const scaleOf = (r) => (has(r.edition) && r.edition > 0 ? r.edition : Math.max(1, ...[r.hi, r.units, r.target, r.today].filter(has)));

// the paid assumptions the card can read the close under (closeForecast.scenarios)
const MODES = [["recommended", "Recommended"], ["current", "Today's"], ["none", "No more paid"]];

export default function SellThroughClose({ snap }) {
  const base = snap.closeForecast;
  const [mode, setMode] = useState("recommended");
  const title = "Sell-through at close";
  if (!base || !has(base.units)) return <Card title={title}><div className="empty-state">No projection at close yet</div></Card>;
  // the reading under the chosen paid assumption; the block's own figures are the recommended one's
  const scenarios = base.scenarios && base.scenarios.recommended && base.scenarios.current && base.scenarios.none ? base.scenarios : null;
  const cf = scenarios && scenarios[mode] ? { ...base, ...scenarios[mode] } : base;
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
  const aside = [has(cf.edition) ? `${fmt(cf.units)} of ${fmt(cf.edition)}` : `${fmt(cf.units)} units`, daysWord].filter(Boolean).join(" · ");
  const b = cf.built || {};
  const paid = cf.paid || null;
  const range = cf.range || null;
  const working = [
    `${title}, how it is read`,
    `Projected ${fmt(cf.units)}${has(cf.edition) ? ` of ${fmt(cf.edition)} (${fmtPct(cf.pct, 0)})` : ""} · today ${fmt(cf.today)}${has(cf.pctToday) ? ` (${fmtPct(cf.pctToday, 0)})` : ""}${daysWord ? ` · ${daysWord}` : ""}`,
    ...(has(cf.target) ? [`Units target ${fmt(cf.target)}`] : []),
    ...(Object.keys(b).length ? [`Built from: sold ${fmt(b.sold)} + in hand ${fmt(b.inHand)} + organic to come ${fmt(b.organic)} + paid to come ${fmt(b.paid)}`] : []),
    ...(paid ? [`Paid: runs at ${money(paid.daily)} a day${has(paid.today) ? ` (today ${money(paid.today)})` : ""}, ${kmoney(paid.spendAtClose)} at close${has(paid.budget) ? ` against a budget of ${money(paid.budget)}` : ""}`, ...(paid.rule ? [paid.rule] : [])] : []),
    ...(ranged ? [`Range ${fmt(cf.lo)}-${fmt(cf.hi)}${has(cf.pctLo) && has(cf.pctHi) ? ` (${Math.round(cf.pctLo * 100)}-${Math.round(cf.pctHi * 100)}%)` : ""}${range && range.note ? `: ${range.note}` : ""}${range && has(range.n) ? ` (${fmt(range.n)} launches)` : ""}`] : []),
    ...(confWord ? [`Confidence ${confWord.toLowerCase()}${cf.confidenceWhy ? `: ${cf.confidenceWhy}` : ""}`] : []),
  ].join("\n");
  const works = Array.isArray(cf.works) ? cf.works.filter((w) => w && has(w.units)) : [];
  const xmax = scaleOf(cf);
  const legend = [
    { n: "Today", v: fmt(cf.today), k: sw(COL.DEEP) },
    { n: complete ? "At the close" : "At close", v: fmt(cf.units), k: sw(COL.LIGHT) },
    ...(ranged ? [{ n: "Range", v: `${fmt(cf.lo)}-${fmt(cf.hi)}`, k: { ...sw(COL.PALE), width: 10, height: 10, flex: "0 0 10px", border: `1px solid ${RANGE_BORDER}` }, tip: range && range.note ? range.note : undefined }] : []),
    ...(has(cf.target) ? [{ n: "Target", v: fmt(cf.target), k: { width: 12, height: 0, flex: "0 0 12px", borderTop: `1px dashed ${COL.MUTED}` } }] : []),
  ];
  // the paid assumption: the change from today's spend, as a share of it
  const dir = paid ? paid.direction : null;
  const chg = paid && has(paid.change) ? Math.round(Math.abs(paid.change) * 100) : null;
  const showChange = paid && has(paid.today) && paid.today !== paid.daily && dir !== "stop";
  const dirWord = dir === "stop" ? "stops now" : dir === "hold" ? "held" : dir === "start" ? "from nothing" : null;
  // the toggle: the three paid assumptions, each with its daily figure
  const seg = scenarios && !complete
    ? <Seg label="Paid assumption" value={mode} onChange={setMode}
        options={MODES.map(([k, l]) => [k, k === "none" ? l : `${l} ${money(scenarios[k].paid && scenarios[k].paid.daily)}`,
          k === "recommended" ? "The level at which the next euro of paid spend returns what it costs, reached from today's by steps of up to 30% a day"
            : k === "current" ? "Today's daily spend held to the close" : "No more paid spend from now: the organic course alone"])} />
    : null;
  return (
    <Card title={title} aria={title} seg={seg}>
      <Head v={byPct ? fmtPct(cf.pct, 0) : fmt(cf.units)} u={complete ? (byPct ? "at the close" : "units at the close") : byPct ? "projected" : "units projected"} aside={aside} asideTip={working}>
        {rangeWord && <Loz kind="ind" tip={range && range.note ? `${fmt(cf.lo)}-${fmt(cf.hi)} units: ${range.note}` : `${fmt(cf.lo)}-${fmt(cf.hi)} units`}>{rangeWord}</Loz>}
        {confWord && <Loz kind={confKind} tip={cf.confidenceWhy || undefined} icon={<span className="dot" />}>{confWord} confidence</Loz>}
      </Head>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <RangeBar big xmax={xmax} today={cf.today} units={cf.units} lo={ranged ? cf.lo : null} hi={ranged ? cf.hi : null} target={cf.target}
          title={`Today ${fmt(cf.today)} · at close ${fmt(cf.units)}${ranged ? ` · range ${fmt(cf.lo)}-${fmt(cf.hi)}` : ""}${has(cf.target) ? ` · target ${fmt(cf.target)}` : ""}`} />
        <Keys legend={legend} />
      </div>
      {works.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div className="prow cw grp"><span className="nm">By work</span></div>
          {works.map((w, i) => {
            const wr = !complete && has(w.lo) && has(w.hi);
            const tip = `${w.name}${has(w.edition) ? ` · edition ${fmt(w.edition)}` : ""}\nToday ${fmt(w.today)} · at close ${fmt(w.units)}${has(w.pct) ? ` (${fmtPct(w.pct, 0)})` : ""}${wr ? `\nRange ${fmt(w.lo)}-${fmt(w.hi)}` : ""}${w.sellsOut ? "\nLikely sells out" : ""}`;
            return (
              <div className="prow cw" key={w.name || i} title={tip}>
                <span className="nm">{w.name}</span>
                <RangeBar xmax={scaleOf(w)} today={w.today} units={w.units} lo={wr ? w.lo : null} hi={wr ? w.hi : null} target={null} />
                {w.sellsOut
                  ? <span className="fig good">{complete ? "Sold out" : "Likely sells out"}</span>
                  : <span className="fig">{has(w.pct) ? fmtPct(w.pct, 0) : fmt(w.units)}{wr && <i>{has(w.pctLo) && has(w.pctHi) ? `${Math.round(w.pctLo * 100)}-${Math.round(w.pctHi * 100)}` : `${fmt(w.lo)}-${fmt(w.hi)}`}</i>}</span>}
              </div>
            );
          })}
        </div>
      )}
      {paid && has(paid.daily) && !complete && (
        <div className="nbox assume" title={paid.rule || undefined}>
          <span className="cap">Paid social</span>
          <span className="it"><span className="big">{money(paid.daily)}</span> a day
            {showChange && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 2 }}>
                {chg !== null && chg > 0 && <span className="chg">{dir === "raise" || dir === "start" ? <Up /> : <Dn />}{chg}%</span>}
                <span className="was">{money(paid.today)}</span>
              </span>
            )}
            {dirWord && <span style={{ marginLeft: 2 }}>· {dirWord}</span>}
          </span>
          {has(paid.spendAtClose) && <span className="it" title={has(paid.budget) ? `Spend to date plus the spend to the close under this assumption, against a budget of ${money(paid.budget)}` : "Spend to date plus the spend to the close under this assumption"}><span className="big">{kmoney(paid.spendAtClose)}</span> by the close</span>}
        </div>
      )}
    </Card>
  );
}
