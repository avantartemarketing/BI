/* Shared primitives for dashboard modules.
 * Chart conventions (design handoff, final - the "G" board of Target and
 * Benchmark Together):
 *  actual = solid #4f80d6 · projection = #a3bfeb · overshoot = 135° hatch
 *  target = the fill, in two tints of the actual's own blue: the darker from
 *           zero to whichever of target and benchmark is lower, the lighter from
 *           the benchmark up to the target when the target is the higher
 *  benchmark = a dotted outline of the column it would make, drawn over the
 *           fill in a step darker tone - tracing the fill's edges where it sits
 *           inside the target, standing in the air above it where it does not
 *  bar tracks run to 120% of the higher reference, so neither ever clips.
 * Both references are on every bar, always. The fill says what the business
 * asked for and where the basket agrees with it; the outline says what the
 * basket typically reaches. Nothing about the drawing changes between a target
 * above its benchmark and one below - only where the outline sits - so the
 * legend has the same shape on every card. Percentages, RAG colours and the
 * headline deltas read against the target: it is what the business committed
 * to, and the benchmark is there to say how ambitious that commitment was.
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
  // The page's hue: one blue, at the strengths a reading needs. blue is the
  // actual on every bar and line. blueLight is the projection: the same blue
  // at less than full strength, because a projection is the actual's own
  // quantity not yet earned - deep enough to read as blue against the
  // reference tints sitting directly behind it, light enough never to pass
  // for the solid. blueDeep is what is most certain, the units paid on the
  // sell-through card. The hue was an orange until September 2026; every
  // token kept its role.
  blue: "#4f80d6", blueLight: "#a3bfeb", blueDeep: "#2f5fb3",
  track: "#ece9e1", ink: "#141413", muted: "#6c6b68", hairline: "#f2f0ea",
  planGrey: "#c8c5bc", targetLine: "#b8b3a6", border: "#e5e4df",
  green: "#0f7052", amber: "#8a5f00", red: "#b8461d", wfGreen: "#2f7d3f",
  todayLine: "#eeece5", white: "#fffefb",
  // The two references, in one hue - tints of the actual's own blue, so they
  // read as the same measurement at other weights rather than as systems of
  // their own. refBase is the ground both agree on: the fill from zero to
  // whichever is lower. refStretch is the target's extra above the benchmark.
  // refLine is the benchmark's own mark, the dotted outline, a step darker than
  // either tint so it reads on both. refTrack carries a bar's remaining room
  // out to the sellout.
  refBase: "#d9e4f7", refStretch: "#e6eefa", refLine: "#7fa2e0", refTrack: "#f3f6fc",
};

/* What the two references are called on a card, so no two cards name them
 * differently. The horizon only changes the words, never the marks. */
export function refWords(horizon) {
  const today = horizon !== "close";
  return {
    target: today ? "Target today" : "Target",
    bm: today ? "Benchmark today" : "Benchmark",
  };
}

/* The same two references named plainly, for a card that wears the horizon
   badge: the lozenge beside the title already says which horizon is being
   read, so repeating "today" on every row is noise. The cards that read one
   fixed horizon and carry no badge keep refWords and the word with it. */
export const BADGE_WORDS = { target: "Target", bm: "Benchmark" };

/* The horizon a card is reading, as a chip beside its title. The cards that
   answer the page's Today / At close toggle wear it, so the words inside them
   do not have to repeat which horizon they are on. */
export function HorizonBadge({ horizon }) {
  const close = horizon === "close";
  return (
    <Lozenge color="neutral" tip={close
      ? "This card is reading the projection at close. The page's Compare toggle switches it."
      : "This card is reading where the release is today. The page's Compare toggle switches it."}>
      {close ? "At close" : "Today"}
    </Lozenge>
  );
}

export const GROUP_DOTS = {
  volume: "#b8862d", funnel: "#4f80d6", paid: "#eb6834", outcome: "#8a7a52",
};

export const MINUS = "−";

/* Days of the window seen so far, with the part day counted for the share of
 * it observed (snapshot asOfFraction; 1 on a full day and once the window has
 * closed). The pro-rata references - the budget by today, the posts by today -
 * read this rather than `day`, which is the day in progress. */
export const dayElapsed = (snap) => Math.max(0, (snap?.day ?? 0) - (1 - (snap?.asOfFraction ?? 1)));
/* The share of the paid plan due by today: paid runs from the day after the
 * announce (paid.paidStartDays, 1) to the close, and its budget is planned
 * evenly over those days, so days elapsed less the first, over the paid
 * days, is the share of it that should be spent and bought (docs 7). At
 * close the whole of it. */
export const paidDayFrac = (snap, close = false) => {
  if (close) return 1;
  const start = snap?.paid?.paidStartDays ?? 1;
  const span = (snap?.of ?? 0) - start;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (dayElapsed(snap) - start) / span));
};

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
  return (n < 0 ? MINUS : "") + "€" + fmt(Math.abs(n), digits);
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

export function Card({ tall, wide, dot, title, badge, right, children, style }) {
  return (
    <div className={`card${tall ? " tall" : ""}${wide ? " wide" : ""}`} style={style}>
      <div className="mod-head">
        <span className="gdot" style={{ background: dot }} />
        <span className="title">{title}</span>
        {badge || null}
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
export const HATCH = `repeating-linear-gradient(135deg, ${C.blue} 0 1.5px, ${C.blueLight} 1.5px 5px)`;

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
export function Tick({ pct, color, vertical = true, tip, inset = "0px", dotted = false }) {
  const t = useTip();
  // a dotted tick is the benchmark's mark; a solid one is a level of the target's
  const box = vertical
    ? (dotted
      ? { left: `calc(${pct}% - 1px)`, top: -3, bottom: -3, width: 0, borderLeft: `2px dotted ${color}` }
      : { left: `calc(${pct}% - 1px)`, top: -3, bottom: -3, width: 2, background: color })
    : (dotted
      ? { bottom: `calc(${pct}% - 1px)`, left: `calc(${inset} - 3px)`, right: `calc(${inset} - 3px)`, height: 0, borderTop: `2px dotted ${color}` }
      : { bottom: `calc(${pct}% - 1px)`, left: `calc(${inset} - 3px)`, right: `calc(${inset} - 3px)`, height: 2, background: color });
  return <div {...t.props(tip)} style={{ position: "absolute", ...box }} />;
}

/* The benchmark's mark: a dotted outline of the column (or bar) it would make,
 * drawn over the target's fill in refLine. Where the benchmark sits inside the
 * target the dots trace the fill's edges up to the lid; where it sits above they
 * stand in the air. `pct` is the benchmark on the container's scale and `inset`
 * the fill's own inset from the container's sides, so the outline and the fill
 * share a silhouette. It takes no hover of its own - it would otherwise sit on
 * top of every fill beneath it and steal theirs - so the figure it names goes in
 * the fills' popups. */
/* ---- the horizontal waterfall (BENCHMARK_SPEC 9) ----------------------------
 * Levels are ticks (never floor-anchored columns) and steps are bars between
 * running levels, with a grey 1px drop from each row's level to the next row.
 * Both the outcome card and the channels card's waterfall view draw with it.
 * rows: { kind: "level", key, label, value, tip, dotted, color } for a level -
 * dotted is the benchmark's mark - and { kind: "step", key, label, value, from,
 * to, tip, fill } for a step; a step with its own fill (the stretch) is a
 * planning quantity, so its figure is in ink rather than the step colours. */
export function LevelWaterfall({ rows, X, labelW = 116, valueW = 48, gap = 12 }) {
  const tipApi = useTip();
  const n = rows.length;
  const levelOf = (r) => (r.kind === "step" ? r.to : r.value);
  const grid = {
    flex: 1, display: "grid", gridTemplateColumns: `${labelW}px 1fr ${valueW}px`,
    gap, alignItems: "center", minHeight: 0,
  };
  return (
    <div className="body" style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: labelW + gap, right: valueW + gap, top: 0, bottom: 0, pointerEvents: "none" }}>
        {rows.slice(0, -1).map((r, i) => (
          <div key={r.key} style={{
            position: "absolute", left: `${X(levelOf(r))}%`,
            top: `${((i + 0.5) / n) * 100}%`, height: `${(1 / n) * 100}%`,
            width: 1, background: C.planGrey,
          }} />
        ))}
      </div>
      {rows.map((r) => {
        const level = r.kind === "level";
        const up = (r.value ?? 0) >= 0;
        return (
          <div key={r.key} style={grid}>
            <div style={{ fontSize: 12.5, fontWeight: level ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {r.label}
            </div>
            <div style={{ position: "relative", height: 14 }}>
              {level ? (
                <Tick pct={X(r.value)} color={r.color || C.refLine} dotted={!!r.dotted} tip={r.tip} />
              ) : (
                <div {...tipApi.props(r.tip)} style={{
                  position: "absolute", top: 0, bottom: 0,
                  left: `${X(Math.min(r.from, r.to))}%`,
                  width: `${Math.max(1.2, Math.abs(X(r.to) - X(r.from)))}%`,
                  background: r.fill || (up ? C.wfGreen : C.red), borderRadius: 3,
                }} />
              )}
            </div>
            <div className="num" style={{
              fontSize: 12.5, fontWeight: 600, textAlign: "right",
              color: level || r.fill ? C.ink : (up ? C.green : C.red),
            }}>
              {level ? fmt(r.value) : fmtSigned(r.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* The rows every waterfall opens with: the target's tick, the stretch as a bar
 * in the stretch tint from the target to the benchmark, then the benchmark's
 * dotted tick, so that the steps below can read against the basket and still
 * close on the outcome: the stretch is the part of the gap to target that is
 * ambition, the steps are the part that is performance. Without a basket the
 * target opens alone and the steps read against it. */
export function waterfallOpening({ hasBm, bm, target, words, k, targetHead, unitWord = "Units" }) {
  const targetRow = {
    kind: "level", key: "target", label: words.target, value: target,
    tip: { head: targetHead || words.target, rows: [{ label: unitWord, value: fmt(target) }] },
  };
  if (!hasBm) return [targetRow];
  const stretch = target - bm;
  return [
    targetRow,
    { kind: "step", key: "stretch", label: "Stretch", value: bm - target, from: target, to: bm, fill: C.refStretch,
      tip: {
        head: "Stretch",
        rows: [
          { label: words.target, value: fmt(target) },
          { label: words.bm, value: fmt(bm) },
          { label: "Stretch", value: fmtSigned(stretch) },
          ...(k ? [{ label: "Uplift", value: "×" + fmt(k, 2) }] : []),
        ],
        body: "What the business asked for over and above the basket - the same even uplift in every channel and on every day. The rows below read against the basket, so this step is the part of the gap to target that is ambition rather than performance.",
      } },
    { kind: "level", key: "bm", label: words.bm, value: bm, dotted: true,
      tip: { head: words.bm, rows: [{ label: unitWord, value: fmt(bm) }],
             body: "The median of the matched basket - what launches like this one typically reach. The steps walk from here." } },
  ];
}

/* One x scale for a waterfall: every mark drawn, with a tenth of the range each side. */
export function waterfallScale(marks) {
  const lo = Math.min(...marks), hi = Math.max(...marks);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  return (v) => (span > 0 ? ((v - (lo - pad)) / span) * 100 : 50);
}

export function BmOutline({ pct, column = false, inset = "0px", radius = 4 }) {
  const edge = `2px dotted ${C.refLine}`;
  const box = column
    ? { left: inset, right: inset, bottom: 0, height: `${pct}%`,
        borderTop: edge, borderLeft: edge, borderRight: edge, borderRadius: `${radius}px ${radius}px 0 0` }
    : { left: 0, top: -1, bottom: -1, width: `${pct}%`,
        borderTop: edge, borderBottom: edge, borderRight: edge, borderRadius: `0 ${radius}px ${radius}px 0` };
  return <div style={{ position: "absolute", boxSizing: "border-box", pointerEvents: "none", ...box }} />;
}

/* Horizontal bar with both references and the actual. The fill is the target,
 * darker from zero to whichever of target and benchmark is lower and lighter
 * from the benchmark up to the target when the target is the higher; the
 * benchmark is the dotted outline over it; the actual is the narrower blue
 * bar in front. A release with no basket has no `bm`, and then the fill is one
 * tint to the target and there is no outline.
 *
 * Scale. By default the track runs to 120% of the higher reference, so neither
 * can clip and there is room to see an actual that beats them; a value past that
 * widens the scale. `full` overrides that with a fixed right edge - the hero's
 * sellout, which is the natural end of its bar - and paints the room up to it in
 * the paler refTrack, so anything drawn beyond the sellout sits on the darker
 * track and says so on sight.
 *
 * Layers, bottom to top: track -> base tint -> stretch tint -> benchmark
 * outline -> projected fill -> to-date fill -> over-target hatch. The actual is
 * inset top and bottom so the tints still show on both sides of it. */
export function TrackBar({
  now, proj, target, bm, full, max, hatchFrom, height = 20, radius = 4, tips = {}, projColor = C.blueLight,
}) {
  const t = useTip();
  const tp = (x) => t.props(typeof x === "string" ? { head: x } : x);
  const tgt = target ?? 0;
  const hasBm = bm !== null && bm !== undefined;
  const lo = hasBm ? Math.min(tgt, bm) : tgt;
  const refMax = hasBm ? Math.max(tgt, bm) : tgt;
  const maxData = Math.max(now ?? 0, proj ?? 0);
  // `max` is a hard ceiling for a bar on a bounded scale (a rate: the track
  // is exactly 0 to 100%, with no room drawn past it); `full` is a sellout,
  // which a reference or a projection can run past and the bar should show
  const maxV = max > 0 ? max : full > 0
    ? Math.max(full, refMax, maxData) * 1.02
    : Math.max(refMax > 0 ? refMax * 1.2 : 0, maxData * 1.04);
  const scale = maxV > 0 ? 100 / maxV : 0;
  const pct = (v) => Math.max(0, Math.min((v ?? 0) * scale, 100));
  const projW = pct(proj);
  const nowW = pct(now);
  const fillW = Math.max(projW, nowW);
  const inset = Math.max(3, Math.round(height * 0.2));
  const innerR = Math.max(2, radius - 2);
  const stretch = hasBm && tgt > bm;
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
      {lo > 0 && (
        <div {...tp(tips.base ?? tips.target)} style={{
          position: "absolute", inset: 0, width: `${pct(lo)}%`,
          background: C.refBase,
          borderRadius: stretch ? `${radius}px 0 0 ${radius}px` : radius,
        }} />
      )}
      {stretch && (
        <div {...tp(tips.stretch ?? tips.target)} style={{
          position: "absolute", top: 0, bottom: 0, left: `${pct(bm)}%`, width: `${pct(tgt) - pct(bm)}%`,
          background: C.refStretch, borderRadius: `0 ${radius}px ${radius}px 0`,
        }} />
      )}
      {hasBm && bm > 0 && <BmOutline pct={pct(bm)} radius={radius} />}
      <div {...tp(tips.proj)} style={{
        position: "absolute", top: inset, bottom: inset, left: 0, width: `${projW}%`,
        background: projColor, borderRadius: innerR,
      }} />
      <div {...tp(tips.now)} style={{
        position: "absolute", top: inset, bottom: inset, left: 0, width: `${nowW}%`,
        background: C.blue, borderRadius: innerR,
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

/* Deviation rung geometry. The target is the rung centre (ratio = 1), so the
 * scale is a log one: a ratio and its reciprocal have to sit the same distance
 * either side of the centre, which a linear percentage scale cannot do. ×4
 * either way fills the rung, and anything past that is clamped and flagged
 * `beyond` so the caller can mark it rather than silently pile up at the end.
 *   aOverTarget : actual / target   (null -> neutral rung)
 * `rungPos` is the same scale on its own, for placing the benchmark's tick. */
export function rungPos(ratio) {
  return ratio > 0 ? Math.max(4, Math.min(96, 50 + (Math.log2(ratio) / 2) * 46)) : 4;
}

export function rungGeom(aOverTarget) {
  if (aOverTarget === null || aOverTarget === undefined || Number.isNaN(aOverTarget)) return null;
  const far = (ratio) => ratio > 4 || (ratio > 0 && 1 / ratio > 4) || ratio <= 0;
  return {
    rel: (aOverTarget - 1) * 100,
    dev: rungPos(aOverTarget),
    beyond: far(aOverTarget),
  };
}

/* The rung itself: hairline rail, the target down the centre, a pale bar
 * spanning centre to actual so the gap has length, the dot, and the benchmark
 * as a dotted tick wherever the basket's own figure lands on the same scale -
 * the rung's form of the dotted outline every bar carries. `guide` extends the
 * centre line past the rail to tie stacked rungs together, as the organic
 * funnel does. Neutral means no reference to judge against, so only a grey dot
 * on the centre. `bench` is false on a release with no matched basket: the
 * centre is then the lever plan and goes to the neutral guide grey, and there
 * is no tick to draw. */
export function RungTrack({ dev, bmPos, up, neutral, guide, bench = true }) {
  return (
    <div style={{ position: "relative", height: 12 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: C.hairline }} />
      <div style={{
        position: "absolute", left: "50%", marginLeft: -0.75, width: 1.5,
        top: guide ? -14 : 0, bottom: guide ? -14 : 0,
        background: bench ? C.refLine : C.planGrey,
      }} />
      {!neutral && (
        <div style={{
          position: "absolute", top: 5, height: 4,
          left: `${Math.min(dev, 50)}%`, width: `${Math.abs(dev - 50)}%`,
          background: C.refStretch, borderRadius: 2,
        }} />
      )}
      {bench && bmPos !== null && bmPos !== undefined && (
        <div style={{
          position: "absolute", left: `${bmPos}%`, marginLeft: -1, width: 0, top: -2, bottom: -2,
          borderLeft: `2px dotted ${C.refLine}`,
        }} />
      )}
      <div style={{
        position: "absolute", left: `${neutral ? 50 : dev}%`, top: 1,
        width: 10, height: 10, marginLeft: -5, borderRadius: "50%",
        background: neutral ? "#c8c5bc" : up ? C.blue : C.red,
        boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
      }} />
    </div>
  );
}

/* The rung grammar in three marks, so nobody has to guess what the centre or
 * the tick is. The tick is dropped with no basket, exactly as the rung drops it. */
export function RungKey({ bench = true }) {
  const item = {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 11.5, color: C.muted, whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 18px", marginTop: 6 }}>
      <span style={item}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", flex: "0 0 10px",
          background: C.blue, boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
        }} />
        Actual
      </span>
      <span style={item}>
        <span style={{ width: 2, height: 11, background: bench ? C.refLine : C.planGrey, flex: "0 0 2px" }} />
        Target
      </span>
      {bench && (
        <span style={item}>
          <span style={{ width: 0, height: 11, borderLeft: `2px dotted ${C.refLine}`, flex: "0 0 2px" }} />
          Benchmark
        </span>
      )}
      <span style={{ ...item, marginLeft: "auto" }}>×4 fills the rung</span>
    </div>
  );
}

export function Lozenge({ dir, children, tip, content, color }) {
  const t = useTip();
  const cls = color || (dir === "up" ? "up" : dir === "down" ? "down" : "neutral");
  // a lozenge with a popup behind it says so with the cursor, as titled elements do
  if (content) return <span className={`lozenge ${cls}`} style={{ cursor: "help" }} {...t.props(content)}>{children}</span>;
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

/* "17 Sep" or "Mon 17 Sep". Dates in the snapshots are ISO days read as UTC
 * midnight, so the browser's zone never moves them across a day boundary; the
 * names are spelt here because en-GB locales write "Sept". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const fmtDay = (d, weekday = false) =>
  `${weekday ? WEEKDAYS[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/* The calendar day a day of the window is. The ETL counts days from the
 * announce (snap.windowStart): day 0 is the announce day, snap.day is the
 * as-of day, snap.of is the close, and the daily arrays are indexed the same
 * way, so day N is windowStart + N days. Null on a snapshot without a window. */
export const windowDate = (snap, day) => {
  if (!snap || !snap.windowStart || !(day >= 0)) return null;
  const t = Date.parse(snap.windowStart + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t + day * 86400000) : null;
};

/* A day of the window named by its date, with the day number after it: a day
 * number alone only reads against the campaign clock, a date reads on its
 * own. "Mon 21 Sep · day 18"; "day 18" when the window has no start. */
export const dayLabel = (snap, day, weekday = false) => {
  const d = windowDate(snap, day);
  return d ? `${fmtDay(d, weekday)} · day ${day}` : `day ${day}`;
};

/* The date alone for an axis end, falling back to the day number. */
export const dayAxisLabel = (snap, day) => {
  const d = windowDate(snap, day);
  return d ? fmtDay(d) : `day ${day}`;
};
