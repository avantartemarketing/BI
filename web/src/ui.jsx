/* Shared primitives for dashboard modules.
 * Chart conventions (design handoff, final):
 *  actual = solid #eb6834 · projection = #f2a07f · overshoot = 135° hatch
 *  reference = a tint of the actual's own orange, drawn BEHIND the actual
 *  bar tracks run to 120% of the reference, so the reference bar ends at 83.3%.
 * One reference at a time. The page header carries "Against Benchmark | Target"
 * and every card reads against whichever is chosen - the bar, the percentage
 * under it, its red or green, and the headline delta all switch together. The
 * reference that is not chosen stays readable as a plain figure in the card's
 * footer rows, never as a second mark on the bar. Drawing both at once is what
 * the two-tone bands, the reference lines and the stretch shading were for, and
 * they are all retired with it.
 * The drawing grammar lives here rather than in each module so every card says it
 * the same way; these signatures are fixed because the modules are written
 * against them in parallel. */
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
  // orangeLight is the projection: the same orange at less than full strength,
  // because a projection is the actual's own quantity not yet earned. It was a
  // paler #f7c4ad while the reference was a blue mark; now the reference is a
  // tint of this same orange sitting directly behind it, and two pale oranges
  // one in front of the other told the reader nothing. Deep enough to read as
  // orange against refFill, light enough never to be mistaken for the solid.
  orange: "#eb6834", orangeLight: "#f2a07f", rust: "#8f3415",
  track: "#ece9e1", ink: "#141413", muted: "#6c6b68", hairline: "#f2f0ea",
  planGrey: "#c8c5bc", targetLine: "#b8b3a6", border: "#e5e4df",
  green: "#0f7052", amber: "#8a5f00", red: "#b8461d", wfGreen: "#2f7d3f",
  periwinkle: "#a5b6e3", todayLine: "#eeece5", white: "#fffefb",
  // The reference, in one hue: a tint of the actual's own orange, so the two are
  // plainly the same measurement at two weights rather than two systems sharing
  // a card. refFill sits behind a bar, refTrack carries a bar's remaining room
  // out to the sellout, and refMark is the same reference where a bar cannot be
  // drawn - a rung centre, a trajectory edge, a waterfall anchor.
  refFill: "#f8ddd0", refTrack: "#faf7f4", refMark: "#e8a98b",
};

/* The one reference the whole page is read against. It is page state rather
 * than a prop because every card follows it - the funnels and the drivers
 * included - and threading it through ten call sites twice over would leave the
 * cards free to drift apart. Default "target": the page is a plan report first,
 * and the benchmark is the thing the plan was built from. */
const RefCtx = createContext("target");

export function RefProvider({ mode, children }) {
  return <RefCtx.Provider value={mode === "benchmark" ? "benchmark" : "target"}>{children}</RefCtx.Provider>;
}

export function useRefMode() {
  return useContext(RefCtx);
}

/* What the chosen reference is called, so no two cards name it differently.
 * The horizon only changes the words, never the mark. */
export function refWord(mode, horizon) {
  const today = horizon !== "close";
  return mode === "benchmark"
    ? (today ? "Benchmark today" : "Benchmark")
    : (today ? "Target today" : "Target");
}

export function otherWord(mode, horizon) {
  return refWord(mode === "benchmark" ? "target" : "benchmark", horizon);
}

/* Pick this card's reference value. `bm` falls back to `target` because a
 * release with no matched basket has nothing to switch to, and a blank bar
 * would say less than the target it already had. */
export function pickRef(mode, { bm, target }) {
  if (mode !== "benchmark") return target;
  return bm === null || bm === undefined ? target : bm;
}

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

/* The stretch step: flat plan grey, never hatched and never RAG-coloured. Both
 * waterfalls draw the same step from the benchmark up to the target when the
 * page is read against the benchmark, and it is a planning decision rather than
 * anything the release has or has not done. */
export const STRETCH_FILL = C.planGrey;

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

/* One 2px mark, bleeding 3px past the bar it crosses so it still reads on white
 * either side of a fill. Used where a bar cannot be drawn at all - the waterfall
 * anchors, which are levels rather than quantities rising from zero. The colour
 * is the caller's, because by the time a card draws a mark it already knows
 * whether it is naming the reference or the actual. `vertical` is the mark on a
 * horizontal bar; the horizontal form lies across a column, so the bleed swaps
 * to left/right. `inset` is how far the bar itself is inset from this box: the
 * mark measures the BAR plus the bleed, never the whole column. */
export function Tick({ pct, color, vertical = true, tip, inset = "0px" }) {
  const t = useTip();
  const box = vertical
    ? { left: `calc(${pct}% - 1px)`, top: -3, bottom: -3, width: 2 }
    : { bottom: `calc(${pct}% - 1px)`, left: `calc(${inset} - 3px)`, right: `calc(${inset} - 3px)`, height: 2 };
  return <div {...t.props(tip)} style={{ position: "absolute", background: color, ...box }} />;
}

/* Horizontal bar, two layers: the reference as a wide tint behind, the actual as
 * a narrower orange bar in front. Reading one against the other is then a matter
 * of which one ends further right, with no third colour and no mark to decode.
 *
 * Scale. By default the track runs to 120% of the reference, so the reference
 * ends at 83.3% and there is room to see an actual that beats it; a value past
 * that widens the scale rather than clipping. `full` overrides that with a fixed
 * right edge - the hero's sellout, which is the natural end of its bar - and
 * paints the room up to it in the paler refTrack, so anything drawn beyond the
 * sellout sits on the darker track and says so on sight.
 *
 * Layers, bottom to top: track -> reference tint -> projected fill -> to-date
 * fill -> over-target hatch. The actual is inset top and bottom so the tint
 * still shows on both sides of it and the two never read as one bar. */
export function TrackBar({
  now, proj, refValue, full, hatchFrom, height = 20, radius = 4, tips = {},
}) {
  const t = useTip();
  const tp = (x) => t.props(typeof x === "string" ? { head: x } : x);
  // `refValue`, not `ref`: React reserves `ref` and would never hand it over
  const r = refValue ?? 0;
  const maxData = Math.max(now ?? 0, proj ?? 0);
  const maxV = full > 0
    ? Math.max(full, r, maxData) * 1.02
    : Math.max(r > 0 ? r * 1.2 : 0, maxData * 1.04);
  const scale = maxV > 0 ? 100 / maxV : 0;
  const pct = (v) => Math.max(0, Math.min((v ?? 0) * scale, 100));
  const projW = pct(proj);
  const nowW = pct(now);
  const fillW = Math.max(projW, nowW);
  const inset = Math.max(3, Math.round(height * 0.2));
  const innerR = Math.max(2, radius - 2);
  const hatchAt = hatchFrom === undefined || hatchFrom === null ? null : pct(hatchFrom);
  const showHatch = hatchAt !== null && fillW > hatchAt;
  return (
    <div style={{ position: "relative", height, background: C.track, borderRadius: radius }}>
      {full > 0 && (
        /* the sellout is the end of the bar's meaning: room left over is the
           paler track, and anything drawn past it sits on the darker one, so a
           reference or a projection beyond the edition says so on sight */
        <div style={{
          position: "absolute", inset: 0, width: `${pct(full)}%`,
          background: C.refTrack, borderRadius: radius,
        }} />
      )}
      {r > 0 && (
        <div {...tp(tips.ref)} style={{
          position: "absolute", inset: 0, width: `${pct(r)}%`,
          background: C.refFill, borderRadius: radius,
        }} />
      )}
      <div {...tp(tips.proj)} style={{
        position: "absolute", top: inset, bottom: inset, left: 0, width: `${projW}%`,
        background: C.orangeLight, borderRadius: innerR,
      }} />
      <div {...tp(tips.now)} style={{
        position: "absolute", top: inset, bottom: inset, left: 0, width: `${nowW}%`,
        background: C.orange, borderRadius: innerR,
      }} />
      {showHatch && (
        <div {...tp(tips.overshoot)} style={{
          position: "absolute", top: inset, bottom: inset,
          left: `${hatchAt}%`, width: `${fillW - hatchAt}%`,
          background: HATCH,
          borderTopRightRadius: innerR, borderBottomRightRadius: innerR,
        }} />
      )}
    </div>
  );
}

/* Deviation rung geometry. The reference is the rung centre (ratio = 1), so the
 * scale is a log one: a ratio and its reciprocal have to sit the same distance
 * either side of the centre, which a linear percentage scale cannot do. ×4
 * either way fills the rung, and anything past that is clamped and flagged
 * `beyond` so the caller can mark it rather than silently pile up at the end.
 *   aOverRef : actual / the chosen reference   (null -> neutral rung)
 * With one reference there is nothing else on the rung to place, so the target
 * ring is gone: the centre IS whichever reference the page is being read
 * against, and `rel` is the % against that same thing. */
export function rungGeom(aOverRef) {
  if (aOverRef === null || aOverRef === undefined || Number.isNaN(aOverRef)) return null;
  const pos = (ratio) => (ratio > 0
    ? Math.max(4, Math.min(96, 50 + (Math.log2(ratio) / 2) * 46))
    : 4);
  const far = (ratio) => ratio > 4 || (ratio > 0 && 1 / ratio > 4) || ratio <= 0;
  return {
    rel: (aOverRef - 1) * 100,
    dev: pos(aOverRef),
    beyond: far(aOverRef),
  };
}

/* The rung itself: hairline rail, the reference down the centre, a pale bar
 * spanning centre to actual so the gap has length, and the dot. `guide` extends
 * the centre line past the rail to tie stacked rungs together, as the organic
 * funnel does. Neutral means no reference to judge against, so only a grey dot
 * on the centre. `bench` is false on a release with no matched basket, where the
 * centre falls back to the neutral guide grey - there is a reference, but it is
 * the lever plan rather than anything a comparable launch reached. */
export function RungTrack({ dev, up, neutral, guide, bench = true }) {
  return (
    <div style={{ position: "relative", height: 12 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: C.hairline }} />
      <div style={{
        position: "absolute", left: "50%", marginLeft: -0.75, width: 1.5,
        top: guide ? -14 : 0, bottom: guide ? -14 : 0,
        background: bench ? C.refMark : C.planGrey,
      }} />
      {!neutral && (
        <div style={{
          position: "absolute", top: 5, height: 4,
          left: `${Math.min(dev, 50)}%`, width: `${Math.abs(dev - 50)}%`,
          background: C.refFill, borderRadius: 2,
        }} />
      )}
      <div style={{
        position: "absolute", left: `${neutral ? 50 : dev}%`, top: 1,
        width: 10, height: 10, marginLeft: -5, borderRadius: "50%",
        background: neutral ? "#c8c5bc" : up ? C.orange : C.red,
        boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
      }} />
    </div>
  );
}

/* The rung grammar in two marks, so nobody has to guess what the centre is.
 * Which reference the centre names is the page toggle's business, so the caller
 * passes the word rather than the key deciding it. */
export function RungKey({ word, bench = true }) {
  const item = {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 11.5, color: C.muted, whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 18px", marginTop: 6 }}>
      <span style={item}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", flex: "0 0 10px",
          background: C.orange, boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
        }} />
        Actual
      </span>
      <span style={item}>
        <span style={{ width: 2, height: 11, background: bench ? C.refMark : C.planGrey, flex: "0 0 2px" }} />
        {word}
      </span>
      <span style={{ ...item, marginLeft: "auto" }}>×4 fills the rung</span>
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
