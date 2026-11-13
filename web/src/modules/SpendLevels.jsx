/* Spend levels (snap.paid.levels, etl/build.py): what to set tomorrow's
 * daily budget to, the level it is heading for, how likely that level is
 * to lose money, and AA's profit from the paid spend still to come at each
 * flat daily spend with the range it could land in (eight in ten runs)
 * once the window's price, the elasticity, the wear-out and the close's
 * lift are each allowed their uncertainty (11 November 2026). The level is
 * the cautious peak: the daily spend that earns the most if the campaign
 * turns out dear (the 25th percentile of the profit), not the point
 * estimate's. A dotted mark shows the campaign's biggest day so far:
 * beyond it the price is an extrapolation. No table and no key. The head is
 * the figure alone, "a day": today's level and the aim are marked on the
 * plot, and the working is on the figure's hover (13 November 2026).
 *
 * When paid stops there is no curve: the stop, its reason and two rows.
 * When the build has no level to give (no entries in the last three days,
 * a closed release, no targets) the card stays and says why (noLevels.mjs,
 * 12 November 2026); until then it was left out of the page.
 * A snapshot built before the range was carried draws the card as it was
 * (the point estimate's peak, the elasticity's band, the four-row table). */
import React from "react";
import { Card, Head, Loz, useBoxSize } from "../ui.jsx";
import { LineChart, Keys, niceAxis, kfmt, COL, lk, sw } from "../charts.jsx";
import { fmt, fmtPct, fmtMoney, MINUS } from "../format.mjs";
import { noLevels } from "./noLevels.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const money = (v) => fmtMoney(Math.round(v ?? 0));
// money in thousands to one decimal (€5.6k), whole euros under a thousand
const kmoney = (v) => (has(v) && v > 0 ? (v >= 1000 ? `€${(v / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : money(v)) : "–");
// the same for a figure that can be negative (a profit)
const kprofit = (v) => (has(v) ? (Math.abs(v) >= 1000 ? `${v < 0 ? MINUS : ""}€${(Math.abs(v) / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : `${v < 0 ? MINUS : ""}${money(Math.abs(v))}`) : "–");
const BAND_BORDER = "#dfe2f8";
/* "1 in 14" for a probability, "under 1 in 50" when it is tiny */
function oneIn(p) {
  if (!has(p) || p <= 0) return "under 1 in 50";
  const n = Math.round(1 / p);
  return n >= 50 ? "under 1 in 50" : n <= 1 ? "more likely than not" : `1 in ${n}`;
}
const WORDS = { none: "no paid", half: "half", recommended: "recommended", double: "double", today: "today's, held" };
const STOP = {
  supply: ["Edition spoken for", "Paid stops: the edition is spoken for without it, so a further entry buys nothing."],
  marginal: ["Next euro under 1.0", "Paid stops: even the smallest day's next euro returns less than it costs."],
  zero_conversion_pause: ["No entries for 3 days", "Paid pauses: three days of spend have bought no entries."],
};
const H = 190, L = 40, R = 10, T = 14, B = 26;
// the card read under uncertainty draws its plot as tall as the Paid ROI
// card's beside it, both set on the foot of their cards, and carries no key
// (12 November 2026): the marks are labelled on the plot and the hover names the rest
const HC = 250;

/* a daily spend's place on the curve, as a fractional index between the
 * points either side of it, and the profit there; null off the curve */
function onCurve(curve, daily, key = "profit") {
  if (!has(daily) || curve.length < 2) return null;
  if (daily < curve[0].daily || daily > curve[curve.length - 1].daily) return null;
  for (let k = 0; k < curve.length - 1; k++) {
    const a = curve[k], c = curve[k + 1];
    if (daily >= a.daily && daily <= c.daily) {
      const f = c.daily > a.daily ? (daily - a.daily) / (c.daily - a.daily) : 0;
      return { i: k + f, v: (a[key] ?? 0) + f * ((c[key] ?? 0) - (a[key] ?? 0)) };
    }
  }
  return null;
}

/* The band, the drop line, the dots, the ring and their labels, drawn in
 * the same pixels the line chart measures (the plot's width, H high). The
 * band goes behind the chart, the marks over it; the legend sits outside
 * the measured box so the labels' places are shares of the plot alone. */
function Marks({ W, y, x, band, drop, dots, ring, labels, layer }) {
  if (!(W > 0)) return null;
  const style = { position: "absolute", left: 0, top: 0, width: "100%", height: "auto", display: "block", overflow: "visible", pointerEvents: "none" };
  if (layer === "under") {
    return <svg viewBox={`0 0 ${W} ${H}`} style={style} aria-hidden="true">{band && <path d={band} fill={COL.PALE} />}</svg>;
  }
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={style} aria-hidden="true">
        {drop && <path d={`M${x(drop.i).toFixed(1)} ${y(drop.v).toFixed(1)}V${y(Math.max(0, drop.base)).toFixed(1)}`} stroke={COL.IND} strokeWidth="1" strokeDasharray="3 3" fill="none" />}
        {dots.map((d, k) => <circle key={k} cx={x(d.i).toFixed(1)} cy={y(d.v).toFixed(1)} r={d.r} fill={d.fill} stroke="#fff" strokeWidth="2" />)}
        {ring && <circle cx={x(ring.i).toFixed(1)} cy={y(ring.v).toFixed(1)} r="4.5" fill="#fff" stroke={COL.INK} strokeWidth="2" />}
        {ring && ring.lead && <path d={ring.lead} stroke={COL.GREY} strokeWidth="1" fill="none" />}
      </svg>
      {labels.map((l, k) => <span key={k} className="lab" style={l.s}>{l.t}</span>)}
    </>
  );
}

export default function SpendLevels({ snap }) {
  const [ref, boxW] = useBoxSize();
  const lv = snap.paid && snap.paid.levels;
  const title = "Spend levels";
  const curve = lv && Array.isArray(lv.curve) ? lv.curve.filter((p) => p && has(p.daily) && has(p.profit)) : [];
  // paid stops (the level is nothing): no curve to draw, the stop and its reason instead
  const stop = !!lv && has(lv.recommended) && lv.recommended <= 0;
  // no level from the build: the card stays, and says why there is none
  if (!lv || !has(lv.recommended) || (!stop && curve.length < 2)) {
    const none = noLevels(snap);
    return (
      <Card title={title} aria={title}>
        <Head v={none.v} u={none.u} aside={none.aside}>
          {none.loz && <Loz kind={none.kind} tip={none.why}>{none.loz}</Loz>}
        </Head>
        <div className="nbox">{none.why}</div>
      </Card>
    );
  }
  const W = Math.max(240, Math.round(boxW || 520));
  const rows = Array.isArray(lv.rows) ? lv.rows.filter((r) => r && has(r.daily)) : [];
  const rec = lv.recommended, today = has(lv.today) ? lv.today : null;

  // ----- the head: the recommended level against today's -----
  const cp = (snap.closeForecast && snap.closeForecast.paid) || null;
  const change = cp && has(cp.change) ? cp.change : today !== null && today > 0 ? (rec - today) / today : null;
  const dir = cp && cp.direction ? cp.direction : rec === 0 ? "stop" : today === null || today === 0 ? "start" : change !== null && Math.abs(change) < 0.005 ? "hold" : change < 0 ? "cut" : "raise";
  const chgWord = dir === "hold" ? "held" : dir === "stop" ? "a stop" : dir === "start" ? "from nothing" : change !== null ? `a ${Math.round(Math.abs(change) * 100)}% ${dir}` : dir;
  const aside = today !== null ? `today ${money(today)} · ${chgWord}` : "";
  const band = Array.isArray(lv.elasticityBand) && lv.elasticityBand.length === 2 ? lv.elasticityBand : null;
  const working = [
    `${title}, how they are read`,
    `Recommended ${money(rec)} a day: the level at which the next euro of spend returns 1.0`,
    ...(today !== null ? [`Today ${money(today)} a day${has(lv.marginalToday) ? ` · the next euro returns ${fmt(lv.marginalToday, 2)}` : ""}`] : []),
    has(lv.sellout) ? `Sells out at ${money(lv.sellout)} a day, flat to the close` : "No flat daily spend sells the edition out by the close",
    ...(has(lv.ppu) ? [`AA's profit on a paid unit ${fmtMoney(lv.ppu)}${has(lv.cannibalisation) ? `, net of ${fmtPct(lv.cannibalisation, 0)} cannibalisation` : ""}`] : []),
    ...(has(lv.elasticity) ? [`Elasticity ${fmt(lv.elasticity, 2)}${band ? ` (${fmt(band[0], 2)} to ${fmt(band[1], 2)}: the band)` : ""}`] : []),
    ...(has(lv.daysLeft) ? [`${fmt(lv.daysLeft)} day${lv.daysLeft === 1 ? "" : "s"} left`] : []),
    "The curve is AA's profit from the spend still to come at a flat daily spend; ROI is that profit over AA's share of the spend, the next euro's return the slope of it.",
  ].join("\n");

  if (stop) {
    const [word, why] = STOP[lv.stop] || STOP.marginal;
    const next = has(lv.marginalToday) && today !== null && today > 0 ? ` At today's ${money(today)} the next euro returns ${fmt(lv.marginalToday, 2)}.` : "";
    return (
      <Card title={title} aria={title}>
        <Head v={money(0)} u="a day recommended" aside={today !== null && today > 0 ? `today ${money(today)} · a stop` : ""} asideTip={working}>
          <Loz kind="warm" tip={why}>{word}</Loz>
        </Head>
        <div className="nbox">{why}{next}</div>
        <LevelsTable rows={rows} />
      </Card>
    );
  }

  // the card read under uncertainty, where the snapshot carries the range
  if (has(lv.lossAtRecommended) && curve.every((p) => has(p.median))) return <Cautious lv={lv} curve={curve} title={title} boxRef={ref} W={W} />;

  // ----- the scale -----
  // the axis spans the whole curve, the band included, so a profit that goes
  // negative gets a few ticks below zero rather than one tick step repeated
  // down to it; at most a handful of ticks either way
  const top = Math.max(1, ...curve.map((p) => Math.max(p.profit, p.hi ?? p.profit)));
  const low = Math.min(0, ...curve.map((p) => Math.min(p.profit, p.lo ?? p.profit)));
  const ax = niceAxis((top - low) * 1.05);
  const step = ax.ticks.length > 1 ? ax.ticks[1] - ax.ticks[0] : ax.ymax;
  const ymin = low < 0 ? -Math.ceil(-low / step) * step : 0;
  const ymaxV = Math.max(step, Math.ceil(top / step) * step);
  const yticks = [];
  for (let v = ymin; v <= ymaxV + 1e-9 && yticks.length < 12; v += step) yticks.push(v);
  ax.ymax = ymaxV;
  const n = curve.length, N = n - 1;
  const x = (i) => L + (i * (W - L - R)) / N;
  const y = (v) => T + (1 - (v - ymin) / (ax.ymax - ymin)) * (H - T - B);
  const yl = (t) => (t < 0 ? MINUS + kfmt(-t) : t ? kfmt(t) : "0");
  const maxDaily = curve[n - 1].daily;
  const xa = niceAxis(maxDaily, 6);
  const xt = xa.ticks.filter((t) => t <= maxDaily + 1e-9).map((t) => onCurve(curve, t, "daily")).filter(Boolean);
  const xticks = xt.map((p, k) => [p.i, `${k === 0 ? "€" : ""}${fmt(p.v)}${k === xt.length - 1 ? " a day" : ""}`]);

  // ----- the band, the marks and their labels -----
  const banded = curve.some((p) => has(p.lo) && has(p.hi));
  const bandPath = banded
    ? curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.hi ?? p.profit).toFixed(1)}`).join("") + curve.map((p, i) => `L${x(i).toFixed(1)} ${y(p.lo ?? p.profit).toFixed(1)}`).reverse().join("") + "Z"
    : null;
  const recPt = onCurve(curve, rec);
  const todayPt = today !== null && today > 0 ? onCurve(curve, today) : null;
  const dots = rows.filter((r) => r.daily > 0).map((r) => ({ ...onCurve(curve, r.daily), key: r.key })).filter((d) => has(d.i))
    .map((d) => ({ i: d.i, v: d.v, r: d.key === "recommended" ? 5 : 4, fill: d.key === "recommended" ? COL.DEEP : COL.MID }));
  if (recPt && !dots.some((d) => Math.abs(d.i - recPt.i) < 1e-6)) dots.push({ i: recPt.i, v: recPt.v, r: 5, fill: COL.DEEP });
  const P = (v, t) => `${((v / t) * 100).toFixed(3)}%`;
  const labels = [];
  if (recPt) labels.push({ t: `Recommended ${money(rec)}`, s: { left: P(x(recPt.i), W), top: P(y(recPt.v) - 22, H), transform: "translate(-50%,0)", color: COL.INK, fontWeight: 500 } });
  let ring = null;
  if (todayPt) {
    const right = x(todayPt.i) < W * 0.7;
    const lx = x(todayPt.i) + (right ? 28 : -28), ly = y(todayPt.v) + 16;
    ring = { i: todayPt.i, v: todayPt.v, lead: `M${(x(todayPt.i) + (right ? 4 : -4)).toFixed(1)} ${(y(todayPt.v) + 5).toFixed(1)}L${(lx + (right ? -3 : 3)).toFixed(1)} ${(ly - 3).toFixed(1)}` };
    labels.push({ t: `Today ${money(today)}`, s: { left: P(lx, W), top: P(ly - 5, H), transform: right ? "none" : "translate(-100%,0)", color: COL.MUTED } });
  }
  const legend = [
    { n: "Profit from the spend still to come", k: lk(COL.IND) },
    ...(banded ? [{ n: "Where the peak may sit", k: { ...sw(COL.PALE), width: 10, height: 10, flex: "0 0 10px", border: "1px solid #dfe2f8" }, tip: band ? `The same profit with the elasticity at ${fmt(band[0], 2)} and ${fmt(band[1], 2)}` : undefined }] : []),
    ...(ring ? [{ n: "Today", k: { width: 8, height: 8, flex: "0 0 8px", borderRadius: "50%", border: `2px solid ${COL.INK}` } }] : []),
  ];
  const rowAt = (i) => curve[i];
  const peakWord = recPt ? `peaks at ${money(rec)} a day` : "";
  return (
    <Card title={title} aria={title}>
      <Head v={money(rec)} u="a day recommended" aside={aside} asideTip={working}>
        <Loz kind="ind" tip={has(lv.marginalToday) && today !== null ? `At today's ${money(today)} the next euro returns ${fmt(lv.marginalToday, 2)}; at ${money(rec)} it returns 1.0` : "The level at which the next euro of spend returns what it costs"}>Next euro returns 1.0</Loz>
      </Head>
      <div ref={ref} style={{ position: "relative" }}>
        <Marks W={W} layer="under" band={bandPath} x={x} y={y} dots={[]} labels={[]} />
        <div style={{ position: "relative" }}>
          <LineChart H={H} L={L} R={R} T={T} B={B} n={n} ymin={ymin} ymax={ax.ymax} yticks={yticks} yfmt={yl} xticks={xticks} noLegend
            series={[{ name: "Profit", color: COL.IND, w: 2, vals: curve.map((p) => p.profit) }]}
            dotAt={(i) => curve[i].profit}
            title={(i) => `${money(rowAt(i).daily)} a day`}
            rows={(i) => [
              { n: "Profit to come", v: money(rowAt(i).profit), k: lk(COL.IND) },
              ...(has(rowAt(i).lo) && has(rowAt(i).hi) ? [{ n: "Range", v: `${money(rowAt(i).lo)} to ${money(rowAt(i).hi)}`, k: sw(COL.PALE) }] : []),
            ]}
            aria={`Profit from the spend still to come at each daily spend${peakWord ? `: ${peakWord}` : ""}`} />
          <Marks W={W} layer="over" x={x} y={y} drop={recPt ? { ...recPt, base: ymin } : null} dots={dots} ring={ring} labels={labels} />
        </div>
      </div>
      <Keys legend={legend} />
      <LevelsTable rows={rows} />
    </Card>
  );
}

/* The marks of the card read under uncertainty: the range behind the line,
 * the zero line, the campaign's biggest day so far, the aim's drop and dot,
 * today's ring, and their labels, in the pixels the line chart measures. */
function CautiousMarks({ W, x, y, band, zero, drop, dot, ring, tested, labels, layer }) {
  if (!(W > 0)) return null;
  const style = { position: "absolute", left: 0, top: 0, width: "100%", height: "auto", display: "block", overflow: "visible", pointerEvents: "none" };
  if (layer === "under") {
    return <svg viewBox={`0 0 ${W} ${HC}`} style={style} aria-hidden="true">{band && <path d={band} fill={COL.PALE} stroke={BAND_BORDER} strokeWidth="1" />}</svg>;
  }
  return (
    <>
      <svg viewBox={`0 0 ${W} ${HC}`} style={style} aria-hidden="true">
        {zero && <path d={zero} stroke="#d9d9de" strokeWidth="1" fill="none" />}
        {tested && <path d={tested} stroke={COL.GREY} strokeWidth="1" strokeDasharray="2 3" fill="none" />}
        {drop && <path d={drop} stroke={COL.IND} strokeWidth="1" strokeDasharray="3 3" fill="none" />}
        {dot && <circle cx={x(dot.i).toFixed(1)} cy={y(dot.v).toFixed(1)} r="5" fill={COL.DEEP} stroke="#fff" strokeWidth="2" />}
        {ring && <circle cx={x(ring.i).toFixed(1)} cy={y(ring.v).toFixed(1)} r="4.5" fill="#fff" stroke={COL.INK} strokeWidth="2" />}
        {ring && ring.lead && <path d={ring.lead} stroke={COL.GREY} strokeWidth="1" fill="none" />}
      </svg>
      {labels.map((l, k) => <span key={k} className="lab" style={l.s}>{l.t}</span>)}
    </>
  );
}

/* The card read under uncertainty: tomorrow's budget, the level it is
 * heading for, the chance that level loses money, and the profit to come
 * with its likely range. */
function Cautious({ lv, curve, title, boxRef, W }) {
  const TT = 18, H = HC;
  const rec = lv.recommended, today = has(lv.today) ? lv.today : null, tomorrow = has(lv.tomorrow) ? lv.tomorrow : rec;
  const lossP = lv.lossAtRecommended;
  const pr = lv.profitAtRecommended || {};

  // ----- the head: tomorrow's budget alone (13 November 2026); today's level
  // and the aim are marked on the plot, the working is on the figure's hover -----
  const riskKind = !has(lossP) ? undefined : lossP <= 0.1 ? "good" : lossP <= 0.25 ? "amber" : "warm";
  const working = [
    `${title}, how they are read`,
    `Tomorrow ${money(tomorrow)} a day: today's ${money(today)} moved by at most 30%, toward ${money(rec)}`,
    `Aim ${money(rec)} a day: the daily spend that earns the most if the campaign turns out dear (the 25th percentile of the profit to come)`,
    `At that level the spend to come is ${kprofit(lv.spendToCome)} over ${fmt(lv.daysLeft)} day${lv.daysLeft === 1 ? "" : "s"}, the profit on it ${kprofit(pr.median)} (${kprofit(pr.p10)} to ${kprofit(pr.p90)})${has(lv.unitsAtRecommended) ? ` and the close ${fmt(lv.unitsAtRecommended)}${has(lv.edition) ? ` of ${fmt(lv.edition)}` : ""} units` : ""}`,
    ...(has(lv.pointLevel) ? [`The point estimate's peak, where the next euro returns 1.0, is ${money(lv.pointLevel)} a day${has(lv.lossAtPoint) ? `, with a ${oneIn(lv.lossAtPoint)} chance of a loss` : ""}`] : []),
    ...(today !== null && has(lv.marginalToday) ? [`At today's ${money(today)} the next euro returns ${fmt(lv.marginalToday, 2)}`] : []),
    `The range is where eight in ten runs land once the window's price${has(lv.entriesWindow) ? ` (${fmt(lv.entriesWindow, 1)} entries over three days)` : ""}, the elasticity${has(lv.elasticity) ? ` (${fmt(lv.elasticity, 2)})` : ""}, the wear-out${has(lv.wearout) ? ` (${fmt(lv.wearout, 2)})` : ""} and the close's lift are each allowed their uncertainty`,
    has(lv.sellout) ? `Sells out at ${money(lv.sellout)} a day, flat to the close` : "No flat daily spend sells the edition out by the close",
    ...(has(lv.ppu) ? [`AA's profit on a paid unit ${fmtMoney(lv.ppu)}${has(lv.cannibalisation) ? `, net of ${fmtPct(lv.cannibalisation, 0)} cannibalisation` : ""}`] : []),
  ].join("\n");

  // ----- the scale: the range's reach, a few ticks below zero where it goes there -----
  const top = Math.max(1, ...curve.map((p) => Math.max(p.median, p.p90 ?? p.median)));
  const low = Math.min(0, ...curve.map((p) => Math.min(p.median, p.p10 ?? p.median)));
  const ax = niceAxis((top - low) * 1.05);
  const step = ax.ticks.length > 1 ? ax.ticks[1] - ax.ticks[0] : ax.ymax;
  const ymin = low < 0 ? -Math.ceil(-low / step) * step : 0;
  const ymaxV = Math.max(step, Math.ceil(top / step) * step);
  const yticks = [];
  for (let v = ymin; v <= ymaxV + 1e-9 && yticks.length < 12; v += step) yticks.push(v);
  const n = curve.length, N = n - 1;
  const x = (i) => L + (i * (W - L - R)) / N;
  const y = (v) => TT + (1 - (v - ymin) / (ymaxV - ymin)) * (H - TT - B);
  const yl = (t) => (t < 0 ? MINUS + kfmt(-t) : t ? kfmt(t) : "0");
  const maxDaily = curve[n - 1].daily;
  const xa = niceAxis(maxDaily, 6);
  const xt = xa.ticks.filter((t) => t <= maxDaily + 1e-9).map((t) => onCurve(curve, t, "daily")).filter(Boolean);
  const xticks = xt.map((p, k) => [p.i, `${k === 0 ? "€" : ""}${fmt(p.v)}${k === xt.length - 1 ? " a day" : ""}`]);

  // ----- the range, the marks and their labels -----
  const banded = curve.some((p) => has(p.p10) && has(p.p90));
  const bandPath = banded
    ? curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.p90 ?? p.median).toFixed(1)}`).join("") + curve.map((p, i) => `L${x(i).toFixed(1)} ${y(p.p10 ?? p.median).toFixed(1)}`).reverse().join("") + "Z"
    : null;
  const zero = ymin < 0 ? `M${L} ${(y(0) + 0.5).toFixed(1)}H${W - R}` : null;
  const recPt = onCurve(curve, rec, "median");
  const todayPt = today !== null && today > 0 ? onCurve(curve, today, "median") : null;
  const testedPt = has(lv.biggestDay) && lv.biggestDay > 0 ? onCurve(curve, lv.biggestDay, "daily") : null;
  const P = (v, t) => `${((v / t) * 100).toFixed(3)}%`;
  const labels = [];
  if (recPt) labels.push({ t: `Aim ${money(rec)}`, s: { left: P(x(recPt.i), W), top: P(y(recPt.v) - 22, H), transform: "translate(-50%,0)", color: COL.INK, fontWeight: 500 } });
  let ring = null;
  if (todayPt) {
    const right = x(todayPt.i) < W * 0.7;
    const lx = x(todayPt.i) + (right ? 28 : -28);
    let ly = y(todayPt.v) + 16;
    // the aim's dashed drop runs from its dot to the zero line: a label that
    // would cross it sits under the zero line instead
    if (recPt && ymin < 0) {
      const dropX = x(recPt.i), lo = right ? lx : lx - 72, hi = right ? lx + 72 : lx;
      if (dropX > lo && dropX < hi && ly - 5 < y(0)) ly = y(0) + 16;
    }
    ring = { i: todayPt.i, v: todayPt.v, lead: `M${(x(todayPt.i) + (right ? 4 : -4)).toFixed(1)} ${(y(todayPt.v) + 5).toFixed(1)}L${(lx + (right ? -3 : 3)).toFixed(1)} ${(ly - 3).toFixed(1)}` };
    labels.push({ t: `Today ${money(today)}`, s: { left: P(lx, W), top: P(ly - 5, H), transform: right ? "none" : "translate(-100%,0)", color: COL.MUTED } });
  }
  let tested = null;
  if (testedPt) {
    // the label on the side of the line with the room for it
    const leftSide = x(testedPt.i) > W * 0.6;
    tested = `M${x(testedPt.i).toFixed(1)} ${TT + 2}V${H - B}`;
    labels.push({ t: `Untested above ${money(lv.biggestDay)}`, s: { left: P(x(testedPt.i) + (leftSide ? -7 : 7), W), top: P(TT + 2, H), transform: leftSide ? "translate(-100%,0)" : "none", color: COL.MUTED } });
  }
  const rowAt = (i) => curve[i];
  return (
    <Card title={title} aria={title}>
      <Head v={money(tomorrow)} u="a day" tip={working}>
        {has(lossP) && <Loz kind={riskKind} tip={`At ${money(rec)} a day the spend still to come loses money in ${oneIn(lossP)} runs${has(lv.lossAtPoint) && has(lv.pointLevel) ? `; at the point estimate's peak, ${money(lv.pointLevel)}, in ${oneIn(lv.lossAtPoint)}` : ""}`}><span className="dot" />{oneIn(lossP)} chance of a loss</Loz>}
      </Head>
      <div ref={boxRef} style={{ position: "relative", marginTop: "auto" }}>
        <CautiousMarks W={W} layer="under" band={bandPath} x={x} y={y} labels={[]} />
        <div style={{ position: "relative" }}>
          <LineChart H={H} L={L} R={R} T={TT} B={B} n={n} ymin={ymin} ymax={ymaxV} yticks={yticks} yfmt={yl} xticks={xticks} noLegend
            series={[{ name: "Profit", color: COL.IND, w: 2, vals: curve.map((p) => p.median) }]}
            dotAt={(i) => curve[i].median}
            title={(i) => `${money(rowAt(i).daily)} a day`}
            rows={(i) => [
              { n: "Profit to come, likely", v: kprofit(rowAt(i).median), k: lk(COL.IND) },
              ...(has(rowAt(i).p10) && has(rowAt(i).p90) ? [{ n: "8 in 10 runs", v: `${kprofit(rowAt(i).p10)} to ${kprofit(rowAt(i).p90)}`, k: sw(COL.PALE) }] : []),
              ...(has(rowAt(i).lossP) && rowAt(i).daily > 0 ? [{ n: "Chance of a loss", v: oneIn(rowAt(i).lossP), k: { width: 8, flex: "0 0 8px" } }] : []),
            ]}
            aria={`Profit from the spend still to come at each daily spend, with its likely range; aim ${money(rec)} a day`} />
          <CautiousMarks W={W} layer="over" x={x} y={y} zero={zero} tested={tested} drop={recPt ? `M${x(recPt.i).toFixed(1)} ${y(recPt.v).toFixed(1)}V${y(Math.max(0, ymin)).toFixed(1)}` : null} dot={recPt} ring={ring} labels={labels} />
        </div>
      </div>
    </Card>
  );
}

/* The levels, one row each: the daily spend and its word, the units at
 * close with the share of the edition, the spend to come and the ROI on it. */
function LevelsTable({ rows }) {
  if (!rows.length) return null;
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr><th>Daily spend</th><th>Units at close</th><th>Spend to come</th><th>ROI on it</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.key === "recommended" ? "recrow" : undefined} title={has(r.marginal) ? `At ${money(r.daily)} a day the next euro returns ${fmt(r.marginal, 1)}` : undefined}>
              <td>{money(r.daily)}<span className="lvl-w">{WORDS[r.key] || r.key}</span></td>
              <td>{fmt(r.unitsAtClose)}<span className="pctw">{has(r.pct) ? fmtPct(r.pct, 0) : ""}</span></td>
              <td className={has(r.spendToCome) && r.spendToCome > 0 ? undefined : "dim"}>{kmoney(r.spendToCome)}</td>
              <td className={has(r.roi) ? undefined : "dim"}>{has(r.roi) ? fmt(r.roi, 1) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
