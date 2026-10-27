/* Spend levels (snap.paid.levels, etl/build.py): AA's profit from the paid
 * spend still to come at each flat daily spend, from nothing to two and a
 * half times the recommended level. The line is the profit at the fitted
 * elasticity, the pale band behind it the same profit at the ends of the
 * elasticity's band (where the peak may sit); the recommended level is the
 * spend at which the next euro returns what it costs, marked by a dashed
 * drop and a deep dot, the half and double levels by lighter dots, today's
 * spend by a ring. The head is the recommended daily spend against today's;
 * the table under the chart reads four levels (none, half, recommended,
 * double) in units at close, spend to come and the ROI on that spend. The
 * working (today's marginal return, the sell-out spend, the profit on a
 * paid unit, the elasticity) is on the aside's hover. */
import React from "react";
import { Card, Head, Loz, useBoxSize } from "../ui.jsx";
import { LineChart, Keys, niceAxis, kfmt, COL, lk, sw } from "../charts.jsx";
import { fmt, fmtPct, fmtMoney, MINUS } from "../format.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const money = (v) => fmtMoney(Math.round(v ?? 0));
// money in thousands to one decimal (€5.6k), whole euros under a thousand
const kmoney = (v) => (has(v) && v > 0 ? (v >= 1000 ? `€${(v / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k` : money(v)) : "–");
const WORDS = { none: "no paid", half: "half", recommended: "recommended", double: "double" };
const H = 190, L = 40, R = 10, T = 14, B = 26;

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
  if (!lv || !has(lv.recommended) || curve.length < 2) return <Card title={title}><div className="empty-state">No spend levels yet: they need a paid campaign with spend and a profit split</div></Card>;
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

  // ----- the scale -----
  const top = Math.max(1, ...curve.map((p) => Math.max(p.profit, p.hi ?? p.profit)));
  const ax = niceAxis(top * 1.05);
  const step = ax.ticks.length > 1 ? ax.ticks[1] - ax.ticks[0] : ax.ymax;
  const low = Math.min(0, ...curve.map((p) => Math.min(p.profit, p.lo ?? p.profit)));
  const ymin = low < 0 ? -Math.ceil(-low / step) * step : 0;
  const yticks = [];
  for (let v = ymin; v <= ax.ymax + 1e-9; v += step) yticks.push(v);
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
      {rows.length > 0 && (
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
      )}
    </Card>
  );
}
