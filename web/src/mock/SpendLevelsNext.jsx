/* Spend levels, proposed (mock, 9 November 2026). What the card says: what
 * to set tomorrow's daily budget to, the level it is heading for, how likely
 * that level is to lose money, and the profit from the spend still to come
 * at each daily spend with the range it could land in (eight in ten runs)
 * once the price's noise, the elasticity, the wear-out and the close's lift
 * are each allowed their uncertainty. The level is the cautious peak: the
 * daily spend that earns the most if the campaign turns out dear (the 25th
 * percentile of the profit), not the point estimate's peak. A dotted mark
 * shows the campaign's biggest day so far: beyond it the price is an
 * extrapolation, and the band says so by widening. No table. */
import React from "react";
import { Card, Head, Loz, useBoxSize } from "../ui.jsx";
import { LineChart, Keys, niceAxis, kfmt, COL, lk, sw } from "../charts.jsx";
import { fmt, fmtMoney, MINUS } from "../format.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const money = (v) => fmtMoney(Math.round(v ?? 0));
const kmoney = (v) => (has(v) ? (Math.abs(v) >= 1000 ? `${v < 0 ? MINUS : ""}€${(Math.abs(v) / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : money(v)) : "–");
const H = 190, L = 40, R = 10, T = 18, B = 26;
const BAND_BORDER = "#dfe2f8";

/* "1 in 14" for a probability, "under 1 in 50" when it is tiny */
function oneIn(p) {
  if (!has(p) || p <= 0) return "under 1 in 50";
  const n = Math.round(1 / p);
  return n >= 50 ? "under 1 in 50" : `1 in ${n}`;
}

/* a daily spend's place on the curve, as a fractional index, and the value there */
function onCurve(curve, daily, key = "median") {
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

function Marks({ W, x, y, band, zero, drop, dot, ring, tested, labels, layer }) {
  if (!(W > 0)) return null;
  const style = { position: "absolute", left: 0, top: 0, width: "100%", height: "auto", display: "block", overflow: "visible", pointerEvents: "none" };
  if (layer === "under") {
    return <svg viewBox={`0 0 ${W} ${H}`} style={style} aria-hidden="true">{band && <path d={band} fill={COL.PALE} stroke={BAND_BORDER} strokeWidth="1" />}</svg>;
  }
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={style} aria-hidden="true">
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

export default function SpendLevelsNext({ snap }) {
  const [ref, boxW] = useBoxSize();
  const lv = snap.paid && snap.paid.levelsNext;
  const title = "Spend levels";
  const curve = lv && Array.isArray(lv.curve) ? lv.curve.filter((p) => p && has(p.daily) && has(p.median)) : [];
  if (!lv || !has(lv.recommended) || curve.length < 2) return <Card title={title}><div className="empty-state">No spend levels yet: they need a paid campaign with spend and a profit split</div></Card>;
  const W = Math.max(240, Math.round(boxW || 516));
  const rec = lv.recommended, today = has(lv.today) ? lv.today : null, tomorrow = has(lv.tomorrow) ? lv.tomorrow : rec;
  const lossP = lv.lossAtRecommended;
  const pr = lv.profitAtRecommended || {};

  // ----- the head: tomorrow's budget, then where it is heading -----
  const change = today !== null && today > 0 ? (tomorrow - today) / today : null;
  const dir = today === null || today === 0 ? "start" : change !== null && Math.abs(change) < 0.005 ? "hold" : change < 0 ? "down" : "up";
  const chgWord = dir === "hold" ? `held at ${money(today)}` : dir === "start" ? "from nothing" : `${dir} ${Math.round(Math.abs(change) * 100)}% from ${money(today)}`;
  const aimWord = Math.abs(rec - tomorrow) < 0.5 ? "" : ` · aiming for ${money(rec)}`;
  const riskKind = !has(lossP) ? undefined : lossP <= 0.1 ? "good" : lossP <= 0.25 ? "amber" : "warm";
  const working = [
    `${title}, how they are read`,
    `Tomorrow ${money(tomorrow)} a day: today's ${money(today)} moved by at most 30%, toward ${money(rec)}`,
    `Aim ${money(rec)} a day: the daily spend that earns the most if the campaign turns out dear (the 25th percentile of the profit to come)`,
    `At that level the spend to come is ${kmoney(lv.spendToCome)} over ${fmt(lv.daysLeft)} days, the profit on it ${kmoney(pr.median)} (${kmoney(pr.p10)} to ${kmoney(pr.p90)}) and the close ${fmt(lv.unitsAtRecommended)}${has(lv.edition) ? ` of ${fmt(lv.edition)}` : ""} units`,
    ...(has(lv.pointLevel) ? [`The point estimate's peak is ${money(lv.pointLevel)} a day, with a ${oneIn(lv.lossAtPoint)} chance of a loss`] : []),
    ...(Array.isArray(lv.peakRange) ? [`The peak itself likely sits between ${money(lv.peakRange[0])} and ${money(lv.peakRange[1])} a day`] : []),
    `The band is where eight in ten runs land once the window's price (${fmt(lv.entriesWindow, 1)} entries over three days), the elasticity (${fmt(lv.elasticity, 2)}), the wear-out (${fmt(lv.wearout, 2)}) and the close's lift are each allowed their uncertainty`,
    ...(has(lv.sellout) ? [`Sells out at ${money(lv.sellout)} a day, flat to the close`] : []),
    `${fmt(lv.daysLeft)} day${lv.daysLeft === 1 ? "" : "s"} left · AA's profit on a paid unit ${money(lv.gain)}`,
  ].join("\n");

  // ----- the scale: the band's reach, a few ticks below zero where it goes there -----
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
  const y = (v) => T + (1 - (v - ymin) / (ymaxV - ymin)) * (H - T - B);
  const yl = (t) => (t < 0 ? MINUS + kfmt(-t) : t ? kfmt(t) : "0");
  const maxDaily = curve[n - 1].daily;
  const xa = niceAxis(maxDaily, 6);
  const xt = xa.ticks.filter((t) => t <= maxDaily + 1e-9).map((t) => onCurve(curve, t, "daily")).filter(Boolean);
  const xticks = xt.map((p, k) => [p.i, `${k === 0 ? "€" : ""}${fmt(p.v)}${k === xt.length - 1 ? " a day" : ""}`]);

  // ----- the band, the marks and their labels -----
  const banded = curve.some((p) => has(p.p10) && has(p.p90));
  const bandPath = banded
    ? curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.p90 ?? p.median).toFixed(1)}`).join("") + curve.map((p, i) => `L${x(i).toFixed(1)} ${y(p.p10 ?? p.median).toFixed(1)}`).reverse().join("") + "Z"
    : null;
  const zero = ymin < 0 ? `M${L} ${(y(0) + 0.5).toFixed(1)}H${W - R}` : null;
  const recPt = onCurve(curve, rec);
  const todayPt = today !== null && today > 0 ? onCurve(curve, today) : null;
  const testedPt = has(lv.biggestDay) ? onCurve(curve, lv.biggestDay, "daily") : null;
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
    tested = `M${x(testedPt.i).toFixed(1)} ${T + 2}V${H - B}`;
    labels.push({ t: `Untested above ${money(lv.biggestDay)}`, s: { left: P(x(testedPt.i) + 7, W), top: P(T + 2, H), color: COL.MUTED } });
  }
  const legend = [
    { n: "Profit from the spend to come", k: lk(COL.IND), tip: "The likely profit (the median run): AA's profit on the units a flat daily spend buys to the close, less its share of that spend" },
    ...(banded ? [{ n: "Likely range", k: { ...sw(COL.PALE), width: 10, height: 10, flex: "0 0 10px", border: `1px solid ${BAND_BORDER}` }, tip: "Where eight in ten runs land, once the window's price, the elasticity, the wear-out and the close's lift are each allowed their uncertainty" }] : []),
    ...(ring ? [{ n: "Today", k: { width: 8, height: 8, flex: "0 0 8px", borderRadius: "50%", border: `2px solid ${COL.INK}` } }] : []),
  ];
  const rowAt = (i) => curve[i];
  return (
    <Card title={title} aria={title}>
      <Head v={money(tomorrow)} u="a day tomorrow" aside={`${chgWord}${aimWord}`} asideTip={working}>
        {has(lossP) && <Loz kind={riskKind} tip={`At ${money(rec)} a day the spend still to come loses money in ${oneIn(lossP)} runs${has(lv.lossAtPoint) && has(lv.pointLevel) ? `; the point estimate's peak, ${money(lv.pointLevel)}, in ${oneIn(lv.lossAtPoint)}` : ""}`}><span className="dot" />{oneIn(lossP)} chance of a loss</Loz>}
      </Head>
      <div ref={ref} style={{ position: "relative" }}>
        <Marks W={W} layer="under" band={bandPath} x={x} y={y} labels={[]} />
        <div style={{ position: "relative" }}>
          <LineChart H={H} L={L} R={R} T={T} B={B} n={n} ymin={ymin} ymax={ymaxV} yticks={yticks} yfmt={yl} xticks={xticks} noLegend
            series={[{ name: "Profit", color: COL.IND, w: 2, vals: curve.map((p) => p.median) }]}
            dotAt={(i) => curve[i].median}
            title={(i) => `${money(rowAt(i).daily)} a day`}
            rows={(i) => [
              { n: "Profit to come, likely", v: money(rowAt(i).median), k: lk(COL.IND) },
              ...(has(rowAt(i).p10) && has(rowAt(i).p90) ? [{ n: "8 in 10 runs", v: `${kmoney(rowAt(i).p10)} to ${kmoney(rowAt(i).p90)}`, k: sw(COL.PALE) }] : []),
              ...(has(rowAt(i).lossP) && rowAt(i).daily > 0 ? [{ n: "Chance of a loss", v: oneIn(rowAt(i).lossP), k: { width: 8, flex: "0 0 8px" } }] : []),
            ]}
            aria={`Profit from the spend still to come at each daily spend, with its likely range; aim ${money(rec)} a day`} />
          <Marks W={W} layer="over" x={x} y={y} zero={zero} tested={tested} drop={recPt ? `M${x(recPt.i).toFixed(1)} ${y(recPt.v).toFixed(1)}V${y(Math.max(0, ymin)).toFixed(1)}` : null} dot={recPt} ring={ring} labels={labels} />
        </div>
      </div>
      <Keys legend={legend} />
    </Card>
  );
}
