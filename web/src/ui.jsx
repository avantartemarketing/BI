/* Shared primitives for dashboard modules.
 * Chart conventions (design handoff, final; reference marks per BENCHMARK_SPEC 1 and 7):
 *  actual = solid #eb6834 · projection = dotted #f7c4ad · plan = grey dashed #c8c5bc
 *  target = ink 2px mark · benchmark = cobalt 2px mark · overshoot = 135° hatch
 *  bar tracks run to 120% of the reference, so the target mark sits at 83.3%.
 * Target and benchmark are drawn identically - same 2px, same 3px bleed past the bar
 * they cross, never a halo - so colour and label are the only thing telling them
 * apart. The old white "expected" tick said the same thing in a third visual
 * language and is retired.
 * The drawing grammar lives here rather than in each module so every card says it
 * the same way; these signatures are fixed by BENCHMARK_SPEC 9 because the modules
 * are written against them in parallel. */
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

/* ---- the popup system (agreed on the Dashboard Popups canvas) ----
 * One chrome, three tiers: chart readouts (inline, .chart-tip), element details
 * (this fixed singleton layer, 150ms, header + label/value rows ONLY - no prose),
 * methodology (same layer, 300ms, titled prose for ? badges).
 * Content: { head, rows?: [{ label, value, color? }], body? } */
const TipCtx = createContext(null);

export function TipProvider({ children }) {
  const [tip, setTip] = useState(null);
  const timer = useRef(null);
  const api = useMemo(() => ({
    show(el, content, delay) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.top < 160;
        setTip({
          x: Math.min(Math.max(r.left + r.width / 2, 140), window.innerWidth - 140),
          y: below ? r.bottom + 10 : r.top - 10,
          below, content,
        });
      }, delay);
    },
    hide() { clearTimeout(timer.current); setTip(null); },
  }), []);
  return (
    <TipCtx.Provider value={api}>
      {children}
      {tip && (
        <div className="sys-tip" style={{
          left: tip.x, top: tip.y,
          transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
        }}>
          {tip.content.head && <div className="t-head">{tip.content.head}</div>}
          {(tip.content.rows || []).map((r, i) => (
            <div className="t-row" key={i}>
              <span>{r.label}</span>
              <span className="v" style={r.color ? { color: r.color } : undefined}>{r.value}</span>
            </div>
          ))}
          {tip.content.body && <div className="t-body">{tip.content.body}</div>}
        </div>
      )}
    </TipCtx.Provider>
  );
}

export function useTip() {
  const ctx = useContext(TipCtx);
  return useMemo(() => ({
    props: (content, delay = 150) => (content && ctx ? {
      onMouseEnter: (e) => ctx.show(e.currentTarget, content, delay),
      onMouseLeave: ctx.hide,
    } : {}),
  }), [ctx]);
}


export const C = {
  orange: "#eb6834", orangeLight: "#f7c4ad", rust: "#8f3415",
  track: "#ece9e1", ink: "#141413", muted: "#6c6b68", hairline: "#f2f0ea",
  planGrey: "#c8c5bc", targetLine: "#b8b3a6", border: "#e5e4df",
  green: "#0f7052", amber: "#8a5f00", red: "#b8461d", wfGreen: "#2f7d3f",
  periwinkle: "#a5b6e3", todayLine: "#eeece5", white: "#fffefb",
  // the two reference marks - two shades of one hue, never two hues; see
  // tokens.css for why. refTarget is for MARKS only: values and body text stay
  // on `ink`, or the page turns navy.
  refTarget: "#122b5c", refBm: "#2f62c4",
  cobalt: "#2f62c4",   // alias kept so any stray caller still gets the benchmark
};

export const GROUP_DOTS = {
  volume: "#b8862d", funnel: "#4f6fc0", paid: "#eb6834", outcome: "#8a7a52",
};

export const MINUS = "−";

export function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const v = Number(n);
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return v < 0 ? MINUS + s : s;
}

export function fmtSigned(n, digits = 0) {
  if (n === null || n === undefined) return "–";
  return (n >= 0 ? "+" : MINUS) + fmt(Math.abs(n), digits);
}

export function fmtMoney(n, digits = 0) {
  if (n === null || n === undefined) return "–";
  return (n < 0 ? MINUS : "") + "£" + fmt(Math.abs(n), digits);
}

export function fmtK(n) {
  if (n === null || n === undefined) return "–";
  return Math.abs(n) >= 10000 ? fmt(n / 1000, 1) + "k" : fmt(n);
}

export function fmtPct(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return fmt(x * 100, digits) + "%";
}

export function ragColor(pct) {
  // sell-through style: ≥90 ink, ≥70 amber, else red
  if (pct >= 0.9) return C.ink;
  if (pct >= 0.7) return C.amber;
  return C.red;
}

export function Card({ tall, wide, dot, title, right, children, style }) {
  return (
    <div className={`card${tall ? " tall" : ""}${wide ? " wide" : ""}`} style={style}>
      <div className="mod-head">
        <span className="gdot" style={{ background: dot }} />
        <span className="title">{title}</span>
        {right ? <span className="right">{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function QBadge({ tip, content }) {
  const t = useTip();
  if (content) return <span className="qbadge" {...t.props(content, 300)}>?</span>;
  return <span className="qbadge" title={tip}>?</span>;
}

/* The 135° overshoot hatch, shared so the hero legend swatch and the bar itself
 * are cut from the same cloth. */
export const HATCH = `repeating-linear-gradient(135deg, ${C.orange} 0 1.5px, ${C.orangeLight} 1.5px 5px)`;

/* The live width of an element. Label collision is a pixel question, never a
 * fraction one - two labels 20% apart are comfortable on a wide card and on top
 * of each other on a narrow one - so a card that places labels by value measures
 * the row it is placing them in. */
export function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* Roughly how wide a 12px axis label renders. Tabular numerals and a system
 * sans sit close enough to this for collision work, and erring high only ever
 * buys a little more clearance. */
export const labelPx = (text) => String(text).length * 6.7;

/* Place a value-anchored label on an axis row that also carries fixed labels at
 * its ends. Centred on its own tick wherever it fits; slid just clear of an end
 * label when it would otherwise print across one. A slid label still sits under
 * its tick's half of the row, so the pairing survives - which a label printed
 * through another number does not. Returns a px `left` for a row-relative box.
 *   pct    where the tick is, 0-100
 *   rowW   the row's measured width (0 before the first measurement)
 *   textW  this label's width
 *   loW/hiW  how much room the left and right end labels take */
export function axisLabelLeft({ pct, rowW, textW, loW = 0, hiW = 0, gap = 10 }) {
  if (!rowW) return null;   // unmeasured: caller falls back to a plain percentage
  const half = textW / 2;
  const lo = loW ? loW + gap : 0;
  const hi = rowW - (hiW ? hiW + gap : 0);
  let left = (pct / 100) * rowW - half;
  if (left + textW > hi) left = hi - textW;
  if (left < lo) left = lo;
  return Math.max(0, Math.min(left, Math.max(0, rowW - textW)));
}

/* One reference mark: the target (the deep shade) or the benchmark (the light
 * one), 2px, bleeding 3px past the bar it crosses so the colour still reads on
 * white either side of a fill. No box-shadow and no halo, ever - a halo would
 * make one reference look heavier than the other, and the two are meant to be
 * the same mark in two shades (BENCHMARK_SPEC 1). `vertical` is the mark on a
 * horizontal bar; the horizontal form lies across a column, so the bleed swaps
 * to left/right. `inset` is how far the bar itself is inset from this box: the
 * mark measures the BAR plus the bleed, never the whole column. A mark drawn
 * column-wide leaves only the column gap between one segment and the next, and
 * a row of them reads as one broken line across the card rather than as five
 * separate per-column marks. */
export function RefTick({ pct, kind, vertical = true, tip, inset = "0px" }) {
  const t = useTip();
  const color = kind === "benchmark" ? C.refBm : C.refTarget;
  const box = vertical
    ? { left: `calc(${pct}% - 1px)`, top: -3, bottom: -3, width: 2 }
    : { bottom: `calc(${pct}% - 1px)`, left: `calc(${inset} - 3px)`, right: `calc(${inset} - 3px)`, height: 2 };
  return <div {...t.props(tip)} style={{ position: "absolute", background: color, ...box }} />;
}

/* Horizontal bar on a vs-target track. The target mark sits at 83.3% (a
 * 120%-of-target track) unless a value would overflow - then the scale widens
 * so the largest bar fits with a little headroom and the marks slide left.
 * Layers, bottom to top: track -> projected fill (light) -> to-date fill
 * (orange) -> over-target hatch -> benchmark mark (cobalt) -> target mark (ink).
 * The target is drawn last because it is the thing being judged against, so it
 * must survive landing on top of the benchmark.
 * `exp` is the retired white tick's old prop: callers mid-migration still pass
 * it, and it meant the same reference the ink mark now carries, so it stands in
 * for `target` when `target` is absent. Prefer `target`. */
export function TrackBar({
  now, proj, target, bm, hatchFrom, height = 20, radius = 4, tips = {}, exp,
}) {
  const t = useTip();
  const tp = (x) => t.props(typeof x === "string" ? { head: x } : x);
  const TICK = 100 / 1.2; // 83.333
  const ref = target ?? exp;
  const maxData = Math.max(now ?? 0, proj ?? 0, bm ?? 0);
  const maxV = Math.max(ref > 0 ? ref * 1.2 : 0, maxData * 1.04);
  const scale = maxV > 0 ? 100 / maxV : 0;
  const pct = (v) => Math.max(0, Math.min((v ?? 0) * scale, 100));
  const projW = pct(proj);
  const nowW = pct(now);
  const fillW = Math.max(projW, nowW);
  const tickPct = ref > 0 ? pct(ref) : TICK;
  const hatchAt = hatchFrom === undefined || hatchFrom === null ? null : pct(hatchFrom);
  const showHatch = hatchAt !== null && fillW > hatchAt;
  return (
    <div style={{ position: "relative", height, background: C.track, borderRadius: radius }}>
      <div {...tp(tips.proj)} style={{
        position: "absolute", inset: 0, width: `${projW}%`,
        background: C.orangeLight, borderRadius: radius,
      }} />
      <div {...tp(tips.now)} style={{
        position: "absolute", inset: 0, width: `${nowW}%`,
        background: C.orange, borderRadius: radius,
      }} />
      {showHatch && (
        <div {...tp(tips.overshoot)} style={{
          position: "absolute", top: 0, bottom: 0,
          left: `${hatchAt}%`, width: `${fillW - hatchAt}%`,
          background: HATCH,
          borderTopRightRadius: radius, borderBottomRightRadius: radius,
        }} />
      )}
      {bm !== undefined && bm !== null && (
        <RefTick pct={pct(bm)} kind="benchmark" tip={tips.bm} />
      )}
      <RefTick pct={tickPct} kind="target" tip={tips.target} />
    </div>
  );
}

/* Deviation rung geometry, shared by Funnel by channel and Organic funnel
 * (BENCHMARK_SPEC 7 and 9). The benchmark is the rung centre (b = 1), so the
 * scale is a log one: a ratio and its reciprocal have to sit the same distance
 * either side of the centre, which a linear percentage scale cannot do. ×4
 * either way fills the rung, and anything past that is clamped and flagged
 * `beyond` so the caller can mark it rather than silently pile up at the end.
 *   aOverB : actual / benchmark   (null -> neutral rung, so we return null)
 *   kind   : "vol"  target = benchmark × k (volumes carry the even uplift)
 *            "rate" target = benchmark     (rates are held at the benchmark)
 * `rel` is the % vs TARGET, not vs benchmark: the target is what the business
 * committed to, so it is what the card prints and RAG-colours. */
export function rungGeom(aOverB, kind, k) {
  if (aOverB === null || aOverB === undefined || Number.isNaN(aOverB)) return null;
  const targetRatio = kind === "vol" ? (k > 0 ? k : 1) : 1;
  const pos = (ratio) => (ratio > 0
    ? Math.max(4, Math.min(96, 50 + (Math.log2(ratio) / 2) * 46))
    : 4);
  const far = (ratio) => ratio > 4 || (ratio > 0 && 1 / ratio > 4) || ratio <= 0;
  return {
    rel: (aOverB / targetRatio - 1) * 100,
    dev: pos(aOverB),
    ring: pos(targetRatio),
    beyond: far(aOverB) || far(targetRatio),
  };
}

/* The rung itself: hairline rail, cobalt benchmark line down the centre, a pale
 * bar spanning target ring to actual dot so the gap has length, the dot, and the
 * hollow ink target ring drawn LAST so it stays legible when the dot lands on
 * it. `guide` extends the centre line past the rail to tie stacked rungs
 * together, as the organic funnel does. Neutral means no reference to judge
 * against, so only a grey dot on the centre. */
export function RungTrack({ dev, ring, up, neutral, guide }) {
  const lo = Math.min(dev, ring);
  return (
    <div style={{ position: "relative", height: 12 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: C.hairline }} />
      <div style={{
        position: "absolute", left: "50%", marginLeft: -0.75, width: 1.5,
        top: guide ? -14 : 0, bottom: guide ? -14 : 0, background: C.refBm,
      }} />
      {!neutral && (
        <div style={{
          position: "absolute", top: 5, height: 4, left: `${lo}%`,
          width: `${Math.abs(dev - ring)}%`,
          background: up ? "#f7c4ad" : "#eeb9a3", borderRadius: 2,
        }} />
      )}
      <div style={{
        position: "absolute", left: `${neutral ? 50 : dev}%`, top: 1,
        width: 10, height: 10, marginLeft: -5, borderRadius: "50%",
        background: neutral ? "#c8c5bc" : up ? C.orange : C.red,
        boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
      }} />
      {!neutral && (
        <div style={{
          position: "absolute", left: `${ring}%`, top: 0,
          width: 12, height: 12, marginLeft: -6, borderRadius: "50%",
          border: `1.5px solid ${C.refTarget}`, background: "transparent", boxSizing: "border-box",
        }} />
      )}
    </div>
  );
}

/* The legend marks, in one place so every card names the references the same
 * way (BENCHMARK_SPEC 2: "expected" and "benchmark pace" are retired). The
 * horizon only changes the words, never the marks. Any trailing note - the
 * stretch figure, a count - is the caller's own and arrives as children,
 * because only the card knows the number. */
export function RefKey({ horizon, showStretch, children }) {
  const close = horizon === "close";
  const item = { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" };
  const line = (bg) => ({ width: 12, height: 2, background: bg, flex: "0 0 12px" });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <span style={item}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: C.orange, flex: "0 0 10px" }} />
        {close ? "Projected" : "To date"}
      </span>
      <span style={item}>
        <span style={line(C.refTarget)} />
        {close ? "Target" : "Target today"}
      </span>
      <span style={item}>
        <span style={line(C.refBm)} />
        {close ? "Benchmark" : "Benchmark today"}
      </span>
      {showStretch && (
        <span style={item}>
          <span style={{
            width: 10, height: 10, borderRadius: 2, flex: "0 0 10px",
            background: "repeating-linear-gradient(135deg, #c8c5bc 0 1.5px, #ece9e1 1.5px 5px)",
          }} />
          Stretch
        </span>
      )}
      {children}
    </div>
  );
}

export function Lozenge({ dir, children, tip, content, color }) {
  const t = useTip();
  const cls = color || (dir === "up" ? "up" : dir === "down" ? "down" : "neutral");
  if (content) return <span className={`lozenge ${cls}`} {...t.props(content)}>{children}</span>;
  return <span className={`lozenge ${cls}`} title={tip}>{children}</span>;
}

export async function postDecision(payload) {
  try {
    const res = await fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
