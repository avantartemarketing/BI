/* A chart the Agent draws in the chat, from the spec its make_chart tool
 * returns (server/agent/tools.js), drawn with the dashboard's own chart
 * components so it reads like a card: actual in indigo, target grey,
 * benchmark dotted, projection dashed. Lives only in the chat. */
import React, { useState } from "react";
import { LineChart, BarChart, HBarChart, niceAxis, COL, sw, lk, Keys } from "./charts.jsx";
import { useBoxSize } from "./ui.jsx";

const PALETTE = [COL.IND, COL.ORANGE, COL.DEEP, COL.GREY, COL.GREEN, COL.AMBER, COL.LIGHT, COL.RED];
const REF_STYLES = ["target", "benchmark"];

function styleOf(s, i) {
  switch (s.style) {
    case "actual": return { color: COL.IND, da: "none", w: 2 };
    case "target": return { color: COL.GREY, da: "4 4", w: 1.5 };
    case "benchmark": return { color: COL.INK, da: "1 4", w: 2 };
    case "projection": return { color: COL.IND, da: "5 4", w: 2 };
    case "positive": return { color: COL.IND, da: "none", w: 2 };
    case "negative": return { color: COL.ORANGE, da: "none", w: 2 };
    default: return { color: PALETTE[i % PALETTE.length], da: "none", w: 2 };
  }
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* "2026-09-03" -> "3 Sep", "2026-09" -> "Sep 26", anything else as it is */
function shortLabel(s) {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${Number(m[3])} ${MON[Number(m[2]) - 1]}`;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${MON[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  return s;
}

function fmt(format, compact) {
  const n = (v, d) => Number(v).toLocaleString("en-GB", { maximumFractionDigits: d });
  const k = (v) => (Math.abs(v) >= 1e6 ? n(v / 1e6, 1) + "m" : Math.abs(v) >= 1000 ? n(v / 1000, 1) + "k" : n(v, Math.abs(v) < 10 ? 2 : 1));
  return (v) => {
    if (v == null || v === "") return "-";
    switch (format) {
      case "percent": return n(v * 100, compact ? 0 : 1) + "%";
      case "euro": return "€" + (compact ? k(v) : n(v, Math.abs(v) < 100 ? 2 : 0));
      default: return compact ? k(v) : n(v, Math.abs(v) < 10 ? 2 : Math.abs(v) < 1000 ? 1 : 0);
    }
  };
}

/* an axis over [lo, hi] that includes 0 */
function axis(lo, hi) {
  if (lo >= 0) { const a = niceAxis(hi || 1); return { ymin: 0, ymax: a.ymax, ticks: a.ticks }; }
  if (hi <= 0) { const a = niceAxis(-lo || 1); return { ymin: -a.ymax, ymax: 0, ticks: a.ticks.map((t) => -t).reverse() }; }
  const a = niceAxis(Math.max(hi, -lo));
  const ticks = [...a.ticks.slice(1).map((t) => -t).reverse().filter((t) => t >= lo - a.ticks[1]), ...a.ticks.filter((t) => t <= hi + a.ticks[1])];
  return { ymin: ticks[0], ymax: ticks[ticks.length - 1], ticks };
}

/* about six labels along an axis of n categories */
function someTicks(labels) {
  const n = labels.length;
  if (n <= 8) return labels.map((l, i) => [i, shortLabel(l)]);
  const step = Math.ceil(n / 6);
  const out = [];
  for (let i = 0; i < n; i += step) out.push([i, shortLabel(labels[i])]);
  return out;
}

function ScatterChart({ spec }) {
  const [ref, wRaw] = useBoxSize();
  const [hover, setHover] = useState(null);
  const W = Math.max(240, Math.round(wRaw || 400)), H = 260, L = 44, R = 10, T = 10, B = 30;
  const pts = spec.points;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const pad = (lo, hi) => (hi === lo ? [lo - 1, hi + 1] : [lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05]);
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const ya = axis(Math.min(0, ...ys), Math.max(...ys));
  const xa = axis(Math.min(0, x0), x1);
  const x = (v) => L + ((v - xa.ymin) / (xa.ymax - xa.ymin)) * (W - L - R);
  const y = (v) => T + (1 - (v - ya.ymin) / (ya.ymax - ya.ymin)) * (H - T - B);
  const groups = [...new Set(pts.map((p) => p.group).filter(Boolean))];
  const colorOf = (p) => (p.group ? PALETTE[groups.indexOf(p.group) % PALETTE.length] : COL.IND);
  const fy = fmt(spec.format, true), fx = fmt(spec.x_format, true);
  const fyl = fmt(spec.format, false), fxl = fmt(spec.x_format, false);
  const P = (v, t) => ((v / t) * 100).toFixed(3) + "%";
  const hp = hover != null ? pts[hover] : null;
  return (
    <>
      <div className="plot" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} className="svg" role="img" aria-label={spec.title}>
          {ya.ticks.map((t) => <path key={"y" + t} d={`M${L} ${y(t) + 0.5}H${W - R}`} stroke={t === 0 ? "#e2e2e6" : COL.GRID} strokeWidth="1" />)}
          {pts.map((p, i) => (
            <circle key={i} cx={x(p.x)} cy={y(p.y)} r={hover === i ? 5 : 3.5} fill={colorOf(p)} fillOpacity={hover === i ? 1 : 0.75} stroke="#fff" strokeWidth="1"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} style={{ cursor: "default" }} />
          ))}
        </svg>
        {ya.ticks.map((t) => <span key={"ly" + t} className="lab" style={{ left: P(L - 8, W), top: P(y(t), H), transform: "translate(-100%,-50%)" }}>{fy(t)}</span>)}
        {xa.ticks.map((t) => <span key={"lx" + t} className="lab" style={{ left: P(x(t), W), top: P(H - B + 9, H), transform: "translate(-50%,0)" }}>{fx(t)}</span>)}
        {hp && (
          <div className="tip" style={{ top: 0, left: P(x(hp.x), W), transform: `translateX(${x(hp.x) / W > 0.55 ? "calc(-100% - 10px)" : "10px"})` }}>
            <div className="tt">{hp.label || "Point"}</div>
            <div className="tr"><span style={sw(colorOf(hp))} />{spec.x_label || "x"}<b>{fxl(hp.x)}</b></div>
            <div className="tr"><span style={sw(colorOf(hp))} />{spec.y_label || "y"}<b>{fyl(hp.y)}</b></div>
          </div>
        )}
      </div>
      {groups.length > 0 && <Keys legend={groups.map((g, i) => ({ n: g, k: sw(PALETTE[i % PALETTE.length]) }))} />}
    </>
  );
}

function Plot({ spec }) {
  const f = fmt(spec.format, false), fa = fmt(spec.format, true);
  if (spec.type === "scatter") return <ScatterChart spec={spec} />;
  const x = spec.x, series = spec.series;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const rows = (i) => series.map((s, si) => ({ n: s.name, v: f(s.values[i]), k: REF_STYLES.includes(s.style) || s.style === "projection" ? lk(styleOf(s, si).color, s.style === "benchmark" ? "dotted" : "dashed") : sw(styleOf(s, si).color) }));

  // horizontal bars: a ranking; a single series with negatives diverges from zero
  const asHbar = spec.type === "hbar" || (spec.type === "bar" && lo < 0 && series.length === 1 && x.length <= 40);
  if (asHbar) {
    const bars = series.filter((s) => !REF_STYLES.includes(s.style));
    const ref = series.find((s) => REF_STYLES.includes(s.style));
    const main = bars.length ? bars : series;
    const totals = x.map((_, i) => main.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
    const a = axis(lo, Math.max(...totals, ref ? Math.max(...ref.values.filter((v) => v != null)) : 0));
    const longest = Math.max(...x.map((l) => l.length));
    const L = Math.min(170, Math.max(70, longest * 6.6 + 16));
    const diverging = lo < 0 && main.length === 1;
    return (
      <HBarChart L={L} rows={x} xmin={a.ymin} xmax={a.ymax} xticks={a.ticks} xfmt={fa} labelW={L - 16}
        diverging={diverging} vals={diverging ? main[0].values.map((v) => v || 0) : []}
        series={diverging ? [] : main.map((s, i) => ({ color: styleOf(s, i).color, vals: s.values }))}
        ticks={ref ? ref.values : undefined} tickColor={COL.INK} tickDa={ref && ref.style === "benchmark" ? "1 3" : "none"}
        title={(i) => x[i]} rows2={rows} aria={spec.title}
        legend={series.length > 1 ? series.map((s, i) => ({ n: s.name, k: REF_STYLES.includes(s.style) ? lk(COL.INK, s.style === "benchmark" ? "dotted" : "solid") : sw(styleOf(s, i).color) })) : []} />
    );
  }

  if (spec.type === "bar" || spec.type === "stacked_bar") {
    const bars = series.filter((s) => !REF_STYLES.includes(s.style));
    const refs = series.filter((s) => REF_STYLES.includes(s.style));
    const stacked = spec.type === "stacked_bar";
    let drawn = bars.map((s, i) => ({ name: s.name, color: styleOf(s, i).color, vals: s.values.map((v) => (v == null ? null : Math.max(0, v))) }));
    let top = Math.max(1, ...all);
    if (stacked) {
      // overlaid bars of the running totals, the tallest first, read as a stack
      const cum = drawn.map((_, si) => x.map((__, i) => drawn.slice(0, si + 1).reduce((a, s) => a + (s.vals[i] || 0), 0)));
      top = Math.max(1, ...cum.flat(), ...refs.flatMap((r) => r.values.filter((v) => v != null)));
      drawn = drawn.map((s, si) => ({ ...s, vals: cum[si] })).reverse();
    }
    const a = axis(0, top);
    const legend = [...bars.map((s, i) => ({ n: s.name, k: sw(styleOf(s, i).color) })), ...refs.map((r) => ({ n: r.name, k: lk(COL.INK, r.style === "benchmark" ? "dotted" : "solid") }))];
    return (
      <BarChart L={44} cats={x.map(shortLabel)} xlab={x.length > 8 ? someTicks(x) : undefined} ymax={a.ymax} yticks={a.ticks} yfmt={fa}
        overlay={stacked} series={drawn} refs={refs.map((r) => ({ name: r.name, color: r.style === "target" ? COL.GREY : COL.INK, vals: r.values, da: r.style === "benchmark" ? "1 4" : "none" }))}
        title={(i) => x[i]} rows={rows} aria={spec.title} legend={legend.length > 1 ? legend : []} noLegend={legend.length <= 1} />
    );
  }

  // line
  const a = axis(lo, hi);
  const firstActual = series.findIndex((s) => !s.style || s.style === "actual");
  return (
    <LineChart L={44} n={x.length} ymin={a.ymin} ymax={a.ymax} yticks={a.ticks} yfmt={fa} xticks={someTicks(x)}
      series={series.map((s, i) => { const st = styleOf(s, i); return { name: s.name, vals: s.values, color: st.color, da: st.da, w: st.w, area: i === firstActual }; })}
      dotAt={(i) => (firstActual >= 0 ? series[firstActual].values[i] : null)} title={(i) => x[i]} rows={rows} aria={spec.title} noLegend={series.length < 2} />
  );
}

/* charts are drawn from model output: one that will not draw shows its title and a note, not a blank page */
class Guard extends React.Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="achart-note">This chart could not be drawn.</div> : this.props.children; }
}

export default function AgentChart({ spec }) {
  if (!spec) return null;
  return (
    <figure className="achart">
      <figcaption>
        <span className="achart-t">{spec.title}</span>
        {spec.subtitle && <span className="achart-s">{spec.subtitle}</span>}
      </figcaption>
      <Guard><Plot spec={spec} /></Guard>
      {spec.source && <div className="achart-src">Source: {spec.source}</div>}
    </figure>
  );
}
