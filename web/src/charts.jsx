/* The page's charts, one grammar for every card (the Linear redesign, October
 * 2026): a line chart with the actual as an area under its line, target and
 * benchmark as thinner lines; columns where the target is a pale grey bar the
 * actual fills in indigo, anything past the target a lighter indigo above a
 * 2px gap, the benchmark a dotted mark; horizontal bars, stacked or diverging;
 * a waterfall from the benchmark through each driver to the actual, the target
 * a dashed line across. Values live in the hover readout and the legend, never
 * printed on the plot.
 *
 * Each chart measures the width it is shown at (useBoxSize) and draws its
 * SVG in those pixels, so labels placed by percentage land where the figures
 * are. Hover is a row of invisible hit boxes over the plot; the readout is a
 * small panel inside the plot, to the right of the hover line, or to its left
 * past the middle. */
import React, { useState } from "react";
import { useBoxSize } from "./ui.jsx";

export const COL = {
  IND: "#5e6ad2", DEEP: "#3f4bb0", MID: "#7c86dd", LIGHT: "#c3c8f2", OVER: "#a7aeec", PALE: "#eceefc",
  GREY: "#a1a1aa", SOFT: "#d9d9de", TRACK: "#ededf0", TARGET: "#e8e8eb", ORANGE: "#e8915a", GRID: "#f0f0f2",
  INK: "#1b1b1c", MUTED: "#8a8a8e", DARK: "#71717a", HOVER: "#f4f4f6",
  GREEN: "#0f7052", RED: "#b8461d", AMBER: "#8a5f00",
};

/* legend and readout swatches: a square of a colour, or a line (solid, dashed, dotted) */
export const sw = (c) => ({ width: 8, height: 8, borderRadius: 2, flex: "0 0 8px", background: c });
export const lk = (c, style = "solid") => ({ width: 12, height: 0, flex: "0 0 12px", borderTop: `2px ${style} ${c}` });
const dashStyle = (da) => (da === "1 4" ? "dotted" : da && da !== "none" ? "dashed" : "solid");

const f0 = (n) => Math.round(n).toLocaleString("en-GB");
const P2 = (v, t) => ((v / t) * 100).toFixed(3) + "%";
const pathStyle = (p) => ({
  d: p.d || "M0 0", stroke: p.st || "none", fill: p.fl || "none", fillOpacity: p.fo == null ? 1 : p.fo,
  strokeWidth: p.sw || 0, strokeDasharray: p.da || "none",
});
const box = (o, x, y, w, h) => ({ position: "absolute", left: P2(x, o.W), top: P2(y, o.H), width: P2(w, o.W), height: P2(h, o.H) });
const labY = (o, t, x, y, extra) => ({ t, s: { left: P2(x, o.W), top: P2(y, o.H), transform: "translate(-100%,-50%)", ...(extra || {}) } });
const labX = (o, t, x, y, extra) => ({ t, s: { left: P2(x, o.W), top: P2(y, o.H), transform: "translate(-50%,0)", ...(extra || {}) } });
const tipAt = (o, x, title, rows) => ({
  on: true, title, rows: rows || [],
  s: { top: 0, left: P2(x, o.W), transform: `translateX(${x / o.W > 0.55 ? "calc(-100% - 10px)" : "10px"})` },
});
const noTip = { on: false, s: {}, title: "", rows: [] };

const line = (pts) => {
  let d = "", on = false;
  pts.forEach((p) => {
    if (p == null) { on = false; return; }
    d += (on ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
    on = true;
  });
  return d;
};
const rr = (x, y, w, h, r) => {
  if (w <= 0.2) return "";
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
};
const topBar = (x, y, w, h, r) => {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
};

/* The plot, the labels, the hit boxes and the readout, then the legend. */
function Frame({ o, paths, labs, hits, tip, legend, dot, aria, setHover, plotRef, children }) {
  return (
    <>
      <div className="plot" ref={plotRef}>
        <svg viewBox={`0 0 ${o.W} ${o.H}`} className="svg" role="img" aria-label={aria}>
          {paths.filter((p) => p && p.d).map((p, i) => <path key={i} {...pathStyle(p)} />)}
          {dot && dot.r > 0 && <circle cx={dot.x} cy={dot.y} r={dot.r} fill={COL.IND} stroke="#fff" strokeWidth="2" />}
          {children}
        </svg>
        {labs.map((l, i) => <span key={i} className="lab" style={l.s}>{l.t}</span>)}
        <div className="hit" onMouseLeave={() => setHover(null)}>
          {hits.map((z, i) => <div key={i} style={z.s} onMouseEnter={z.e} onTouchStart={z.e} />)}
        </div>
        {tip.on && (
          <div className="tip" style={tip.s}>
            <div className="tt">{tip.title}</div>
            {tip.rows.map((r, i) => <div className="tr" key={i}><span style={r.k} />{r.n}<b>{r.v}</b></div>)}
          </div>
        )}
      </div>
      {legend && legend.length > 0 && <Keys legend={legend} />}
    </>
  );
}

export function Keys({ legend, style }) {
  return (
    <div className="keys" style={style}>
      {legend.map((g, i) => (
        <span className="key" key={i} title={g.tip}><span style={g.k} />{g.n}{g.v !== undefined && g.v !== "" && g.v !== null && <b className="kv">{g.v}</b>}</span>
      ))}
    </div>
  );
}

/* the measured width, with a guess until the plot has mounted */
function useW(fallback = 520) {
  const [ref, w] = useBoxSize();
  return [ref, Math.max(240, Math.round(w || fallback))];
}

/* ---------------------------------------------------------------- line chart
 * series: [{ name, value, color, vals: [number|null], w, da, area }]; a null
 * leaves a gap. xticks: [[index, label]]; marks: indexes to draw a dotted
 * vertical at (today). dotAt(i): the value the hover dot sits on. title(i),
 * rows(i): the readout; rows are [{ n, v, k }], k a swatch style (sw, lk). */
export function LineChart({ H = 250, L = 36, R = 8, T = 10, B = 26, n, ymax, ymin = 0, yticks = [], yfmt = String, xticks = [],
  marks = [], series = [], dotAt, title, rows, aria = "", legend: legendIn, noLegend = false, fallbackW }) {
  const [ref, W] = useW(fallbackW);
  const [hover, setHover] = useState(null);
  const o = { W, H, L, R, T, B };
  const N = Math.max(1, n - 1);
  const x = (i) => L + (i * (W - L - R)) / N;
  const y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const paths = [], labs = [], hits = [];
  let g = "";
  yticks.forEach((t) => { g += `M${L} ${(y(t) + 0.5).toFixed(1)}H${W - R}`; labs.push(labY(o, yfmt(t), L - 8, y(t))); });
  paths.push({ d: g, st: COL.GRID, sw: 1 });
  xticks.forEach((t) => labs.push(labX(o, t[1], x(t[0]), H - B + 9)));
  marks.forEach((m) => paths.push({ d: `M${x(m)} ${T}V${H - B}`, st: COL.SOFT, sw: 1, da: "2 3" }));
  series.forEach((s) => {
    const pts = s.vals.map((v, i) => (v == null ? null : [x(i), y(v)]));
    const d = line(pts);
    if (s.area) {
      const f = pts.filter(Boolean);
      if (f.length > 1) paths.push({ d: d + `L${f[f.length - 1][0].toFixed(1)} ${y(ymin)}L${f[0][0].toFixed(1)} ${y(ymin)}Z`, fl: s.color, fo: 0.07 });
    }
    paths.push({ d, st: s.color, sw: s.w || 2, da: s.da || "none" });
  });
  let dot = null, tip = noTip;
  if (hover != null) {
    paths.push({ d: `M${x(hover)} ${T}V${H - B}`, st: "#c4c4c8", sw: 1 });
    const pv = dotAt ? dotAt(hover) : null;
    if (pv != null) dot = { x: x(hover), y: y(pv), r: 4 };
    tip = tipAt(o, x(hover), title ? title(hover) : "", rows ? rows(hover) : []);
  }
  const step = (W - L - R) / N;
  for (let i = 0; i < n; i++) hits.push({ s: box(o, x(i) - step / 2, 0, step, H - B), e: () => setHover(i) });
  const legend = noLegend ? [] : legendIn || series.filter((s) => s.name).map((s) => ({ n: s.name, v: s.value, k: lk(s.color, dashStyle(s.da)) }));
  return <Frame o={o} paths={paths} labs={labs} hits={hits} tip={tip} legend={legend} dot={dot} aria={aria} setHover={setHover} plotRef={ref} />;
}

/* ---------------------------------------------------------------- columns against targets
 * rows: [[name, actual, target, benchmark|null]]. The target is the pale bar,
 * the actual fills it; past the target the lighter indigo rises above a 2px
 * gap; the benchmark is a dotted mark across the column. */
export function ColChart({ H = 250, L = 30, R = 4, T = 10, B = 26, gw = 0.32, ymax, yticks = [], yfmt = String, cats, rows,
  title, tipRows, aria = "", legend: legendIn, fallbackW }) {
  const [ref, W] = useW(fallbackW);
  const [hover, setHover] = useState(null);
  const o = { W, H, L, R, T, B };
  const n = cats.length, slot = (W - L - R) / n, bw = slot * gw;
  const y = (v) => T + (1 - v / ymax) * (H - T - B);
  const paths = [], labs = [], hits = [];
  paths.push(hover == null ? {} : { d: rr(L + slot * hover + 1, T - 4, slot - 2, H - T - B + 4, 4), fl: COL.HOVER });
  let g = "";
  yticks.forEach((t) => { if (t) g += `M${L} ${(y(t) + 0.5).toFixed(1)}H${W - R}`; labs.push(labY(o, yfmt(t), L - 8, y(t))); });
  paths.push({ d: g, st: COL.GRID, sw: 1 });
  paths.push({ d: `M${L} ${y(0) + 0.5}H${W - R}`, st: "#e2e2e6", sw: 1 });
  let trk = "", fil = "", ovr = "", bm = "";
  rows.forEach((r, i) => {
    const a = r[1] ?? 0, t = r[2] ?? 0, b = r[3], x0 = L + slot * i + (slot - bw) / 2;
    if (t > 0) trk += topBar(x0, y(t), bw, y(0) - y(t), 3);
    if (a <= t || t <= 0) { if (a > 0) fil += topBar(x0, y(a), bw, Math.max(y(0) - y(a), 1), 2); }
    else {
      fil += `M${x0} ${y(0)}V${y(t).toFixed(1)}H${x0 + bw}V${y(0)}Z`;
      ovr += topBar(x0, y(a), bw, Math.max(y(t) - 2 - y(a), 1.5), 3);
    }
    if (b != null && b > 0) bm += `M${(x0 - 4).toFixed(1)} ${y(b).toFixed(1)}H${(x0 + bw + 4).toFixed(1)}`;
  });
  paths.push({ d: trk, fl: COL.TARGET }); paths.push({ d: fil, fl: COL.IND }); paths.push({ d: ovr, fl: COL.OVER });
  paths.push({ d: bm, st: COL.INK, sw: 2, da: "1 4" });
  cats.forEach((c, i) => labs.push(labX(o, c, L + slot * i + slot / 2, H - B + 9)));
  for (let i = 0; i < n; i++) hits.push({ s: box(o, L + slot * i, 0, slot, H - B), e: () => setHover(i) });
  const tip = hover == null ? noTip : tipAt(o, L + slot * hover + slot / 2, title ? title(hover) : cats[hover], tipRows ? tipRows(hover) : []);
  const anyT = rows.some((r) => r[2] > 0), anyB = rows.some((r) => r[3] != null && r[3] > 0), anyO = rows.some((r) => r[2] > 0 && r[1] > r[2]);
  const legend = legendIn || [
    { n: "Actual", k: sw(COL.IND) },
    ...(anyO ? [{ n: "Over target", k: sw(COL.OVER) }] : []),
    ...(anyT ? [{ n: "Target", k: sw(COL.TARGET) }] : []),
    ...(anyB ? [{ n: "Benchmark", k: lk(COL.INK, "dotted") }] : []),
  ];
  return <Frame o={o} paths={paths} labs={labs} hits={hits} tip={tip} legend={legend} aria={aria} setHover={setHover} plotRef={ref} />;
}

/* ---------------------------------------------------------------- vertical bars
 * series: [{ name, color, vals }], grouped side by side or overlaid in one
 * slot; refs: [{ name, color, vals, da }] drawn as short level marks across
 * each slot. xlab: [[index, label]] when the categories are too many to name. */
export function BarChart({ H = 250, L = 40, R = 4, T = 10, B = 26, gw = 0.64, overlay = false, ymax, yticks = [], yfmt = String, cats, xlab,
  series = [], refs = [], title, rows, aria = "", noLegend = false, legend: legendIn, fallbackW }) {
  const [ref, W] = useW(fallbackW);
  const [hover, setHover] = useState(null);
  const o = { W, H, L, R, T, B };
  const n = cats.length, slot = (W - L - R) / n, ns = overlay ? 1 : series.length;
  const g2 = slot * gw, bw = (g2 - (ns - 1) * 2) / ns;
  const y = (v) => T + (1 - v / ymax) * (H - T - B);
  const paths = [], labs = [], hits = [];
  paths.push(hover == null ? {} : { d: rr(L + slot * hover + 1, T - 4, slot - 2, H - T - B + 4, 4), fl: COL.HOVER });
  let g = "";
  yticks.forEach((t) => { if (t) g += `M${L} ${(y(t) + 0.5).toFixed(1)}H${W - R}`; labs.push(labY(o, yfmt(t), L - 8, y(t))); });
  paths.push({ d: g, st: COL.GRID, sw: 1 });
  paths.push({ d: `M${L} ${y(0) + 0.5}H${W - R}`, st: "#e2e2e6", sw: 1 });
  series.forEach((s, si) => {
    let d = "";
    s.vals.forEach((v, i) => {
      if (v == null) return;
      const x0 = L + slot * i + (slot - g2) / 2 + (overlay ? 0 : si * (bw + 2));
      d += topBar(x0, y(Math.min(v, ymax)), bw, Math.max(y(0) - y(Math.min(v, ymax)), 1), 2);
    });
    paths.push({ d, fl: s.color });
  });
  refs.forEach((rf) => {
    let d = "";
    rf.vals.forEach((v, i) => { if (v == null) return; const x0 = L + slot * i + (slot - g2) / 2; d += `M${(x0 - 6).toFixed(1)} ${y(v).toFixed(1)}H${(x0 + g2 + 6).toFixed(1)}`; });
    paths.push({ d, st: rf.color, sw: 2, da: rf.da || "none" });
  });
  (xlab || cats.map((c, i) => [i, c])).forEach((t) => labs.push(labX(o, t[1], L + slot * t[0] + slot / 2, H - B + 9)));
  for (let i = 0; i < n; i++) hits.push({ s: box(o, L + slot * i, 0, slot, H - B), e: () => setHover(i) });
  const tip = hover == null ? noTip : tipAt(o, L + slot * hover + slot / 2, title ? title(hover) : cats[hover], rows ? rows(hover) : []);
  const legend = noLegend ? [] : legendIn || series.filter((s) => s.name).map((s) => ({ n: s.name, k: sw(s.color), v: s.value }))
    .concat(refs.filter((rf) => rf.name).map((rf) => ({ n: rf.name, k: lk(rf.color, dashStyle(rf.da)) })));
  return <Frame o={o} paths={paths} labs={labs} hits={hits} tip={tip} legend={legend} aria={aria} setHover={setHover} plotRef={ref} />;
}

/* ---------------------------------------------------------------- horizontal bars
 * rows: the labels; stacked (series: [{ color, vals }]) or diverging (vals,
 * posColor, negColor, greyRows). ranges: [[lo, hi]] drawn pale behind each
 * row; ticks: an upright mark per row (a target); vline: one dotted line down
 * the chart (an edition). rows2(i): the readout rows. */
export function HBarChart({ H, L = 110, R = 8, T = 4, B = 26, bh = 10, xmin = 0, xmax, xticks = [], xfmt = String, rows, series = [],
  diverging = false, vals = [], posColor = COL.IND, negColor = COL.ORANGE, greyRows = [], ranges, ticks, tickColor = COL.INK, tickDa = "none", vline,
  title, rows2, aria = "", legend = [], labelW, fallbackW }) {
  const [ref, W] = useW(fallbackW);
  const [hover, setHover] = useState(null);
  const nr = rows.length;
  const height = H || 34 + nr * 34;
  const o = { W, H: height, L, R, T, B };
  const band = (height - T - B) / nr;
  const x = (v) => L + ((v - xmin) / (xmax - xmin)) * (W - L - R);
  const paths = [], labs = [], hits = [];
  paths.push(hover == null ? {} : { d: rr(4, T + band * hover + 1, W - 8, band - 2, 4), fl: COL.HOVER });
  let g = "";
  xticks.forEach((t) => { g += `M${(x(t) + 0.5).toFixed(1)} ${T}V${height - B}`; labs.push(labX(o, xfmt(t), x(t), height - B + 9)); });
  paths.push({ d: g, st: COL.GRID, sw: 1 });
  if (ranges) {
    let rg = "";
    ranges.forEach((q, i) => { if (!q) return; const yc = T + band * i + band / 2; rg += rr(x(q[0]), yc - bh / 2 - 4, x(q[1]) - x(q[0]), bh + 8, 4); });
    paths.push({ d: rg, fl: COL.PALE });
  }
  if (xmin < 0) paths.push({ d: `M${x(0) + 0.5} ${T}V${height - B}`, st: "#cfcfd4", sw: 1 });
  if (diverging) {
    let pos = "", neg = "", gry = "";
    vals.forEach((v, i) => {
      const yc = T + band * i + band / 2;
      const d = v >= 0 ? rr(x(0) + 1, yc - bh / 2, x(v) - x(0) - 1, bh, 2) : rr(x(v), yc - bh / 2, x(0) - x(v) - 1, bh, 2);
      if (greyRows.includes(i)) gry += d; else if (v >= 0) pos += d; else neg += d;
    });
    paths.push({ d: pos, fl: posColor }); paths.push({ d: neg, fl: negColor }); paths.push({ d: gry, fl: COL.SOFT });
  } else {
    const segs = series.map(() => "");
    rows.forEach((r, i) => {
      const yc = T + band * i + band / 2;
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.vals[i];
        if (!v) return;
        segs[si] += rr(x(acc) + (acc > 0 ? 1 : 0), yc - bh / 2, x(acc + v) - x(acc) - (acc > 0 ? 2 : 1), bh, 2);
        acc += v;
      });
    });
    series.forEach((s, si) => paths.push({ d: segs[si], fl: s.color }));
  }
  if (ticks) {
    let tk = "";
    ticks.forEach((t, i) => { if (t == null) return; const yc = T + band * i + band / 2; tk += `M${x(t).toFixed(1)} ${(yc - bh / 2 - 5).toFixed(1)}V${(yc + bh / 2 + 5).toFixed(1)}`; });
    paths.push({ d: tk, st: tickColor, sw: 2, da: tickDa });
  }
  if (vline != null) paths.push({ d: `M${(x(vline) + 0.5).toFixed(1)} ${T}V${height - B}`, st: "#c4c4c8", sw: 1, da: "3 3" });
  rows.forEach((r, i) => {
    labs.push(labY(o, r, L - 12, T + band * i + band / 2, { color: "#3a3a3c", fontSize: 12, maxWidth: labelW || L - 16, overflow: "hidden", textOverflow: "ellipsis" }));
    hits.push({ s: box(o, 0, T + band * i, W, band), e: () => setHover(i) });
  });
  let tip = noTip;
  if (hover != null) {
    tip = { on: true, title: title ? title(hover) : rows[hover], rows: rows2 ? rows2(hover) : [], s: { top: P2(T + band * (hover + 1), height), left: P2(L, W) } };
  }
  return <Frame o={o} paths={paths} labs={labs} hits={hits} tip={tip} legend={legend} aria={aria} setHover={setHover} plotRef={ref} />;
}

/* ---------------------------------------------------------------- waterfall
 * A grey bar for the start (the benchmark), each step up in indigo or down in
 * orange from where the last left off, the result as an indigo bar; the target
 * a dashed line across with its figure at the end. steps: [[name, value]];
 * short: the column labels (a "\n" breaks a line). */
export function WaterfallChart({ H = 262, L = 36, R = 4, T = 10, B = 40, ymin = 0, ymax, yticks = [], yfmt = String, start, startName = "Benchmark",
  steps = [], endName = "Actual", short, target, unit = "units", aria = "", fmtV = f0, fallbackW }) {
  const [ref, W] = useW(fallbackW);
  const [hover, setHover] = useState(null);
  const o = { W, H, L, R, T, B };
  const n = steps.length + 2, slot = (W - L - R) / n, bw = slot * 0.56;
  const y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const paths = [], labs = [], hits = [];
  paths.push(hover == null ? {} : { d: rr(L + slot * hover + 1, T - 4, slot - 2, H - T - B + 4, 4), fl: COL.HOVER });
  let g = "";
  yticks.forEach((t) => { g += `M${L} ${(y(t) + 0.5).toFixed(1)}H${W - R}`; labs.push(labY(o, yfmt(t), L - 8, y(t))); });
  paths.push({ d: g, st: COL.GRID, sw: 1 });
  const x0 = (i) => L + slot * i + (slot - bw) / 2;
  const cols = [{ name: startName, v: start, kind: "total" }];
  let up = "", dn = "", con = "", run = start;
  const base = topBar(x0(0), y(start), bw, y(ymin) - y(start), 2);
  steps.forEach((st, i) => {
    const a = run, b = run + (st[1] || 0), top = Math.max(a, b), bot = Math.min(a, b);
    con += `M${(x0(i) + bw).toFixed(1)} ${y(a).toFixed(1)}H${x0(i + 1).toFixed(1)}`;
    const d = rr(x0(i + 1), y(top), bw, Math.max(1.5, y(bot) - y(top)), 2);
    if ((st[1] || 0) >= 0) up += d; else dn += d;
    cols.push({ name: st[0], v: st[1] || 0, kind: "step" });
    run = b;
  });
  con += `M${(x0(n - 2) + bw).toFixed(1)} ${y(run).toFixed(1)}H${x0(n - 1).toFixed(1)}`;
  const res = topBar(x0(n - 1), y(run), bw, y(ymin) - y(run), 2);
  cols.push({ name: endName, v: run, kind: "total" });
  paths.push({ d: base, fl: COL.GREY }); paths.push({ d: up, fl: COL.IND }); paths.push({ d: dn, fl: COL.ORANGE }); paths.push({ d: res, fl: COL.IND });
  paths.push({ d: con, st: "#c4c4c8", sw: 1 });
  if (target != null) {
    paths.push({ d: `M${L} ${y(target).toFixed(1)}H${W - R}`, st: COL.INK, sw: 1.5, da: "4 4" });
    labs.push({ t: `Target ${fmtV(target)}`, s: { right: P2(R, W), top: P2(y(target) - 15, H), color: COL.INK, fontWeight: 500, background: "rgba(255,255,255,.85)", padding: "0 2px" } });
  }
  const names = short || cols.map((c) => c.name);
  cols.forEach((c, i) => {
    labs.push(labX(o, names[i], L + slot * i + slot / 2, H - B + 9, { whiteSpace: "pre-line", textAlign: "center", lineHeight: 1.3 }));
    hits.push({ s: box(o, L + slot * i, 0, slot, H - B), e: () => setHover(i) });
  });
  let tip = noTip;
  if (hover != null) {
    const c = cols[hover];
    tip = tipAt(o, L + slot * hover + slot / 2, c.name, c.kind === "total"
      ? [{ n: c.name, v: fmtV(c.v), k: sw(hover === 0 ? COL.GREY : COL.IND) }, ...(target != null ? [{ n: "Target", v: fmtV(target), k: lk(COL.INK, "dashed") }] : [])]
      : [{ n: c.v >= 0 ? "Adds" : "Costs", v: fmtV(Math.abs(c.v)) + " " + unit, k: sw(c.v >= 0 ? COL.IND : COL.ORANGE) }]);
  }
  const legend = [{ n: startName, k: sw(COL.GREY) }, { n: "Adds", k: sw(COL.IND) }, { n: "Costs", k: sw(COL.ORANGE) }, ...(target != null ? [{ n: "Target", v: fmtV(target), k: lk(COL.INK, "dashed") }] : [])];
  return <Frame o={o} paths={paths} labs={labs} hits={hits} tip={tip} legend={legend} aria={aria} setHover={setHover} plotRef={ref} />;
}

/* round steps for an axis: 1, 2, 2.5 or 5 times a power of ten, two to four
 * of them under the top; returns { ymax, ticks } with the top rounded up */
export function niceAxis(top, want = 3) {
  if (!(top > 0)) return { ymax: 1, ticks: [0, 1] };
  const raw = top / want;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const ticks = [0];
  for (let v = step; v < top + step; v += step) ticks.push(v);
  return { ymax: ticks[ticks.length - 1], ticks };
}
/* "4k" for an axis of thousands, else the number */
export const kfmt = (t) => (t >= 1000 ? (t / 1000).toLocaleString("en-GB") + "k" : String(t));
