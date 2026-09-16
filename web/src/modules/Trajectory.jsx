/* Unit trajectory (spec §4.2, adapted: unified secured-units currency, docs §6.4;
 * reference grammar per BENCHMARK_SPEC 7).
 * Cumulative secured units (sales + 0.8 × unconverted entries) vs plan per group; the forward projection follows the
 * channel's historic shape curve (paid: projected spend ÷ projected efficiency) -
 * per-day values computed in the ETL (docs §5.4).
 * Real-data bridge: daily[] arrays start at private-room open, so the series is
 * sliced to the campaign window (windowStart .. windowEnd = of+1 points, index = day).
 *
 * Both references, in the marks the bars give them (BENCHMARK_SPEC 7) but as
 * lines, since a pace is a line: the target's pace is a solid line, the
 * benchmark's pace (daily[].bm, summed across groups for "all" exactly as the
 * plan is, so the two are always built the same way) is a dotted one, and the
 * actual is the orange line in front. No area under any of them: a fill said
 * nothing the lines did not, and hid the actual where it ran below the target.
 * The second reference is one more line, not a second system.
 *
 * The two horizons want two pictures. Today the question is "where should we
 * be by now", a reading taken at a single x: both references become short ticks
 * on the today line, and the curves ahead of today fade, because they have not
 * happened yet. At close the question is "where does this land", a pair of
 * levels: both run across the chart and are named together at the left. */
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtSigned, refWords } from "../ui.jsx";

const X1 = 680, Y0 = 148, YTOP = 8;
const LABEL_TODAY_PX = 38; // rendered width of "today" at 12px
const LABEL_DAY_PX = 46;   // rendered width of "day 21" at 12px
const LABEL_DAY1_PX = 36;  // rendered width of "day 1" at 12px

/* ---- placing the readings ----------------------------------------------------
 * The readings on the today line are set where nothing else is drawn. Each has
 * places it would rather be - beside the line, just above or just below its
 * own mark, the roomier side first - and takes the first that no curve, no dot,
 * no other label and no edge of the plot runs through. All of it is in real
 * pixels off the measured plot, with the text measured in the page's own font,
 * so it holds whatever width the card is given. Only when every place is taken
 * does a reading go to its first choice on a card-white patch, so it stays
 * legible whatever the chart does. */
function segHitsBox(x0, y0, x1, y1, b) {
  // Liang-Barsky: does the segment cross the box, edges included
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 - b.x0) && clip(dx, b.x1 - x0) && clip(-dy, y0 - b.y0) && clip(dy, b.y1 - y0);
}
const boxesTouch = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function readingPlacer({ curves, blocks, bounds }) {
  const taken = blocks.slice();
  // what a box would run into: each crossing segment and each touched box
  // counts one, and leaving the plot is worse than any of them
  const clashes = (b) => {
    const p = { x0: b.x0 - 2, y0: b.y0 - 2, x1: b.x1 + 2, y1: b.y1 + 2 };
    if (p.x0 < bounds.x0 || p.x1 > bounds.x1 || p.y0 < bounds.y0 || p.y1 > bounds.y1) return 1000;
    let n = taken.filter((t) => boxesTouch(p, t)).length;
    for (const c of curves) for (let i = 1; i < c.length; i++) if (segHitsBox(c[i - 1].x, c[i - 1].y, c[i].x, c[i].y, p)) n += 1;
    return n;
  };
  return {
    find: (candidates) => candidates.find((b) => clashes(b) === 0) || null,
    // when nothing is clear, the place that runs into the least
    least: (candidates) => candidates.reduce((best, b) => (clashes(b) < clashes(best) ? b : best)),
    commit: (box) => { taken.push(box); return box; },
  };
}
let ctx2d = null, fontFamily = null;
function pageFont() {
  if (fontFamily) return fontFamily;
  try { fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif"; } catch { fontFamily = "sans-serif"; }
  return fontFamily;
}
function textWidth(text, font) {
  try {
    if (!ctx2d) ctx2d = document.createElement("canvas").getContext("2d");
    ctx2d.font = font;
    return ctx2d.measureText(text).width;
  } catch { return text.length * 6.8; }   // no canvas (a test runner): a fair guess at 12px
}

function slicePts(daily, windowStart, of) {
  if (!daily || !daily.length) return [];
  let i0 = daily.findIndex((d) => d.date === windowStart);
  if (i0 < 0) i0 = Math.max(0, daily.length - (of + 1));
  return daily.slice(i0);
}

function seriesFor(snap, sel) {
  const channels = snap.channels || [];
  const of = snap.of || 1;
  if (sel !== "all") {
    const c = channels.find((ch) => ch.key === sel);
    if (c) {
      return {
        now: c.now ?? 0, exp: c.exp ?? 0, proj: c.proj ?? c.now ?? 0,
        target: c.target ?? 0, bm: c.bm ?? null, bmExp: c.bmExp ?? null,
        pts: slicePts(c.daily, snap.windowStart, of),
      };
    }
  }
  // 'all' = element-wise sum of every group's daily series (and summed targets),
  // so this view cannot diverge from the channels module.
  const sliced = channels.map((c) => slicePts(c.daily, snap.windowStart, of));
  const n = sliced.reduce((m, s) => Math.max(m, s.length), 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let a = null, p = null, pr = null, b = null, dt = null;
    for (const s of sliced) {
      const d = s[i];
      if (!d) continue;
      if (!dt) dt = d.date;
      if (d.actual !== null && d.actual !== undefined) a = (a ?? 0) + d.actual;
      if (d.plan !== null && d.plan !== undefined) p = (p ?? 0) + d.plan;
      // shaped forward path: only meaningful once every group projects (future days)
      if (d.proj !== null && d.proj !== undefined) pr = (pr ?? 0) + d.proj;
      if (d.bm !== null && d.bm !== undefined) b = (b ?? 0) + d.bm;
    }
    pts.push({ date: dt, actual: a, plan: p, proj: pr, bm: b });
  }
  const sum = (f) => channels.reduce((t, c) => t + (c[f] ?? 0), 0);
  const has = (f) => channels.some((c) => c[f] !== null && c[f] !== undefined);
  return {
    now: sum("now"), exp: sum("exp"), proj: sum("proj"), target: sum("target"),
    bm: has("bm") ? sum("bm") : null, bmExp: has("bmExp") ? sum("bmExp") : null,
    pts,
  };
}

/* One polyline over an index range, nulls skipped. Kept as a function so the plan and
 * benchmark curves can be cut at today and drawn twice without two spellings of the
 * same maths. */
function pathOf(pts, get, from, to, x, y) {
  const out = [];
  for (let i = Math.max(0, from); i <= to && i < pts.length; i++) {
    const v = get(pts[i]);
    if (v === null || v === undefined) continue;
    out.push((out.length ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1));
  }
  return out.length > 1 ? out.join(" ") : "";
}

/* The same polyline closed back along the baseline, so the reference can be a
 * filled area. Drawn from the first point rather than from x=0 because a series
 * that starts a day in should not be given a day it did not have. */
export default function Trajectory({ snap, horizon = "today" }) {
  const [sel, setSel] = useState("all");
  const [hover, setHover] = useState(null);   // {i, frac}
  // the plot's real height, so label spacing can be set in pixels rather than
  // in a percentage guessed from a card size that is free to change
  const plotRef = useRef(null);
  const [plotH, setPlotH] = useState(0);
  const [plotW, setPlotW] = useState(0);
  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return undefined;
    const measure = () => { setPlotH(el.clientHeight); setPlotW(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const channels = snap.channels || [];
  const of = snap.of || 1;
  const day = Math.max(0, Math.min(snap.day ?? 0, of));
  const complete = !!snap.complete;
  const targeted = snap.targeted !== false;   // no targets: actual line only, unit axis

  const s = useMemo(() => seriesFor(snap, sel), [snap, sel]);

  const right = (
    <select
      className="native"
      value={sel}
      onChange={(e) => setSel(e.target.value)}
      title="Swap the trajectory (and its scale) to a single channel group"
    >
      <option value="all">All channels</option>
      {channels.map((c) => (
        <option key={c.key} value={c.key}>{c.name}</option>
      ))}
    </select>
  );

  if (!s.pts.length) {
    return (
      <Card wide dot={GROUP_DOTS.volume} title="Unit trajectory" right={right}>
        <div className="empty-state">No daily series yet.</div>
      </Card>
    );
  }

  const N = Math.max(1, s.pts.length - 1);
  const hasBm = !!snap.benchmark && s.bm !== null && s.bm > 0;
  const close = horizon === "close";
  const words = refWords(close ? "close" : "today");
  // the target's pace and the benchmark's, each a line
  const has = (v) => v !== null && v !== undefined;
  const planAt = (p) => p.plan;
  const bmAt = (p) => (hasBm ? p.bm : null);
  const yTopV = Math.max(s.target, s.proj, s.now, hasBm ? s.bm : 0, 1) * 1.02;
  const x = (i) => (i / N) * X1;
  const y = (v) => Y0 - (Math.max(0, v) / yTopV) * (Y0 - YTOP);
  const pctTop = (yy) => ((yy / Y0) * 100).toFixed(2) + "%";

  const todayIdx = Math.min(day, N);
  const todayFrac = todayIdx / N;
  const nowVal = s.pts[todayIdx]?.actual ?? s.now;

  // paths, each in a past and a future half so the half that has not happened
  // yet can drop back today; at close the full-width forms are used
  const seg = (fn, from, to) => fn(s.pts, from, to, x, y);
  const targetLine = (pts, from, to, x, y) => pathOf(pts, planAt, from, to, x, y);
  const bmLine = (pts, from, to, x, y) => (hasBm ? pathOf(pts, bmAt, from, to, x, y) : "");
  const halves = { past: [0, todayIdx], future: [todayIdx, N], full: [0, N] };
  const draw = {};
  for (const [name, [a, b]] of Object.entries(halves)) {
    draw[name] = { target: seg(targetLine, a, b), bm: seg(bmLine, a, b) };
  }

  let lastA = -1;
  s.pts.forEach((p, i) => {
    if (p.actual !== null && p.actual !== undefined) lastA = i;
  });
  const actPath =
    lastA >= 1
      ? s.pts
          .slice(0, lastA + 1)
          .map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(p.actual ?? 0).toFixed(1))
          .join(" ")
      : "";

  // Projection follows the historic channel shape (etl emits per-day `proj` values);
  // straight-line fallback only if no shaped path is present.
  const showProjSeg = targeted && !complete && day < of;
  let projPath = "";
  if (showProjSeg) {
    const segs = ["M" + x(todayIdx).toFixed(1) + "," + y(nowVal).toFixed(1)];
    s.pts.forEach((p, i) => {
      if (i > todayIdx && p.proj !== null && p.proj !== undefined) {
        segs.push("L" + x(i).toFixed(1) + "," + y(p.proj).toFixed(1));
      }
    });
    if (segs.length === 1) segs.push("L" + X1 + "," + y(s.proj).toFixed(1));
    projPath = segs.join(" ");
  }

  // the readings taken on the today line
  const planToday = s.pts[todayIdx]?.plan ?? s.exp;
  const bmTodayPt = s.pts[todayIdx]?.bm;
  const bmToday = hasBm ? (bmTodayPt !== null && bmTodayPt !== undefined ? bmTodayPt : s.bmExp) : null;
  const showToday = targeted && !close;
  const showClose = targeted && close;

  const projPct = targeted && s.target > 0 ? Math.round((s.proj / s.target) * 100) : null;
  // axis: % of target when there is one, secured units when there is not
  const axisTop = targeted ? s.target : yTopV / 1.02;
  const axisLabelTop = targeted ? "100%" : fmt(axisTop);
  const axisLabelMid = targeted ? "50%" : axisTop >= 2 ? fmt(axisTop / 2) : "";
  const pctColor = projPct !== null && projPct >= 100 ? C.ink : C.red;
  const nowTip =
    fmt(s.now) + " units secured to date · " + fmt(planToday) + " target by day " + day +
    (bmToday !== null && bmToday !== undefined ? " · " + fmt(bmToday) + " benchmark" : "");
  const projTip = complete
    ? fmt(s.now) + " units at close" + (projPct !== null ? " · " + projPct + "% of target" : "")
    : "Projected " + fmt(s.proj) + " at close" + (projPct !== null ? " · " + projPct + "% of target" : "") +
      (sel === "all" && projPct !== null && projPct > 100
        ? " · demand beyond the sellout cannot convert" : "");
  /* "today" always shows on a live release: it is the reading that matters, and
   * the line it names is otherwise just a line. "day 1" and "day N" sit at the
   * ends, so in the first or last days one of them would overprint it; how
   * close is too close is a pixel question, not a fraction one, so it is
   * measured against the plot, and the end label is the one to give way, since
   * the axis already ends there. The fraction is the fallback before the first
   * measurement lands. */
  const showTodayLabel = !complete;
  const day1Room = plotW > 0
    ? todayFrac * plotW - (LABEL_TODAY_PX / 2 + LABEL_DAY1_PX + 8)
    : (todayFrac < 0.08 ? -1 : 1);
  const endLabelRoom = plotW > 0
    ? (1 - todayFrac) * plotW - (LABEL_TODAY_PX / 2 + LABEL_DAY_PX + 10)
    : (todayFrac > 0.82 ? -1 : 1);
  const showDay1Label = !(showTodayLabel && day1Room < 0);
  const showEndLabel = !(showTodayLabel && endLabelRoom < 0);

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  // a reading on the today line: a 12x2 mark, label alongside; the benchmark's
  // is dotted, as its mark is everywhere else on the page
  const readTick = (v, color, dotted = false) => ({
    position: "absolute", left: `${(todayFrac * 100).toFixed(2)}%`, top: pctTop(y(v)),
    width: 12, margin: "-1px 0 0 -6px",
    ...(dotted ? { height: 0, borderTop: `2px dotted ${color}` } : { height: 2, background: color }),
  });

  /* The readings on the today line, set clear of everything drawn (the placer
   * at the top of the file). The target and the benchmark go as one pair when
   * they are within a few pixels of each other, higher value first, so two
   * figures that are almost the same read as the two references rather than
   * as a clash; a pair that fits nowhere splits into two. The actual is placed
   * first so it gets the best spot, unless placing the references first leaves
   * fewer readings on a patch, which is what matters in the first days when
   * everything crowds the left edge. The today line already says "today", so
   * the readings are the word and the figure. Nothing is placed until the plot
   * has been measured. */
  let readings = [];
  if (showToday && plotW > 0 && plotH > 0) {
    const px = (i) => (i / N) * plotW;
    const py = (v) => (y(v) / Y0) * plotH;
    const polylines = (get, from, to) => {
      const out = []; let run = [];
      for (let i = from; i <= to; i++) {
        const v = has(s.pts[i]) ? get(s.pts[i]) : null;
        if (has(v)) run.push({ x: px(i), y: py(v) }); else if (run.length) { out.push(run); run = []; }
      }
      if (run.length) out.push(run);
      return out;
    };
    const curves = [...polylines((p) => p.actual, 0, lastA), ...polylines(planAt, 0, N), ...(hasBm ? polylines(bmAt, 0, N) : [])];
    if (showProjSeg) {
      const pr = [{ x: px(todayIdx), y: py(nowVal) }];
      s.pts.forEach((p, i) => { if (i > todayIdx && has(p.proj)) pr.push({ x: px(i), y: py(p.proj) }); });
      if (pr.length === 1) pr.push({ x: plotW, y: py(s.proj) });
      curves.push(pr);
    }
    const ax = px(todayIdx), ayNow = py(nowVal), ayEnd = py(complete ? nowVal : s.proj);
    const font = (weight) => `${weight} 12px ${pageFont()}`;
    const blocks = [
      { x0: ax - 5, y0: ayNow - 5, x1: ax + 5, y1: ayNow + 5 },   // the today dot
      ...(targeted && !complete ? [{ x0: plotW - 5, y0: ayEnd - 5, x1: plotW + 5, y1: ayEnd + 5 }] : []),   // the projection's dot
      ...(projPct !== null ? [{ x0: plotW + 10, y0: ayEnd - 8, x1: plotW + 10 + textWidth(`${projPct}%`, font(600)), y1: ayEnd + 8 }] : []),
    ];
    const H = 14, GAP = 10, LIFT = 5;
    const sides = (1 - todayFrac) * plotW > 120 ? ["right", "left"] : ["left", "right"];
    // the places a box of w x h would rather be, nearest first: beside the line,
    // clear above the higher mark or clear below the lower one, the roomier side
    // first; then the same a row further out and a row beyond that; then the
    // same three rows a step along the line, out of the crowd at the today mark
    const spots = (w, h, ayAbove, ayBelow = ayAbove) => [0, 48].flatMap((along) => [0, 1, 2].flatMap((k) =>
      sides.flatMap((side) => ["above", "below"].map((vert) => {
        const x0 = side === "right" ? ax + GAP + along : ax - GAP - along - w;
        const off = LIFT + k * (H + 2);
        const y0 = vert === "above" ? ayAbove - off - h : ayBelow + off;
        // how far from its mark a reading has strayed, for choosing between arrangements
        return { x0, y0, x1: x0 + w, y1: y0 + h, side, cost: k + (along ? 2 : 0) };
      }))));
    // a placed box, written out one line per item, ranged against the today line
    const lines = (box, items) => items.map((it, k) => ({
      ...it, y0: box.y0 + k * (H + 2), x0: box.side === "right" ? box.x0 : box.x1 - it.w, knock: box.knock,
    }));
    const item = (key, text, color, weight) => ({ key, text, color, weight, w: textWidth(text, font(weight)) });
    const nowItem = item("now", `${fmt(nowVal)} ${fmtSigned(nowVal - planToday)}`, C.ink, 600);
    const tItem = item("target", `target ${fmt(planToday)}`, C.ink, 500);
    const bItem = hasBm && has(bmToday) ? item("bm", `benchmark ${fmt(bmToday)}`, C.muted, 500) : null;
    const ayT = py(planToday), ayB = bItem ? py(bmToday) : null;
    const arrange = (referencesFirst) => {
      const { find, least, commit } = readingPlacer({ curves, blocks, bounds: { x0: 0, y0: 0, x1: plotW + 44, y1: plotH } });
      const out = [];
      let knocks = 0, cost = 0;
      const settle = (candidates, items) => {
        const b = find(candidates);
        if (b) cost += b.cost; else knocks += 1;
        out.push(...lines(commit(b ? { ...b, knock: false } : { ...least(candidates), knock: true }), items));
      };
      const actual = () => settle(spots(nowItem.w, H, ayNow), [nowItem]);
      const references = () => {
        if (bItem && Math.abs(ayB - ayT) < 20) {
          const pair = planToday >= bmToday ? [tItem, bItem] : [bItem, tItem];
          const b = find(spots(Math.max(tItem.w, bItem.w), 2 * H + 2, Math.min(ayT, ayB), Math.max(ayT, ayB)));
          if (b) { cost += b.cost; out.push(...lines(commit({ ...b, knock: false }), pair)); return; }
        }
        settle(spots(tItem.w, H, ayT), [tItem]);
        if (bItem) settle(spots(bItem.w, H, ayB), [bItem]);
      };
      if (referencesFirst) { references(); actual(); } else { actual(); references(); }
      return { out, knocks, cost };
    };
    // the arrangement with fewer readings on a patch, then with readings nearer their marks
    const a = arrange(false), b = arrange(true);
    readings = (b.knocks < a.knocks || (b.knocks === a.knocks && b.cost < a.cost)) ? b.out : a.out;
  }

  return (
    <Card wide dot={GROUP_DOTS.volume} title="Unit trajectory" right={right}>
      <div className="spacer-16" />
      <div className="body">
        <div style={{ position: "relative", flex: 1 }}>
          <div
            ref={plotRef}
            style={{ position: "absolute", left: 40, right: 48, top: 0, bottom: 24 }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
              setHover({ i: Math.round(frac * N), frac });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox={`0 0 ${X1} ${Y0}`}
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
            >
              <line x1="0" y1={y(axisTop / 2).toFixed(1)} x2={X1} y2={y(axisTop / 2).toFixed(1)}
                stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={Y0} x2={X1} y2={Y0}
                stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {!complete && (
                <line x1={x(todayIdx).toFixed(1)} y1="0" x2={x(todayIdx).toFixed(1)} y2={Y0}
                  stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
              {/* the target's pace as a solid line, the benchmark's as a dotted
                  one - the bars' marks, with the actual in front. Ahead of
                  today both drop back, because it has not happened yet. */}
              {(showToday ? ["future", "past"] : ["full"]).map((half) => {
                const d = draw[half];
                const dim = half === "future" ? 0.4 : 1;
                return (
                  <g key={half} opacity={dim}>
                    {d.target && (
                      <path d={d.target} fill="none" stroke={C.refLine} strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke" />
                    )}
                    {d.bm && (
                      <path d={d.bm} fill="none" stroke={C.refLine} strokeWidth="1.5"
                        strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                    )}
                  </g>
                );
              })}
              {projPath && (
                <path d={projPath} fill="none" stroke={C.orangeLight} strokeWidth="2.4"
                  strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {actPath && (
                <path d={actPath} fill="none" stroke={C.orange} strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {/* at close both references are levels, drawn right across the
                  chart: the target solid, the benchmark dotted, as everywhere */}
              {showClose && hasBm && (
                <line x1="0" y1={y(s.bm).toFixed(1)} x2={X1} y2={y(s.bm).toFixed(1)}
                  stroke={C.refLine} strokeWidth="2" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
              )}
              {showClose && s.target > 0 && (
                <line x1="0" y1={y(s.target).toFixed(1)} x2={X1} y2={y(s.target).toFixed(1)}
                  stroke={C.refLine} strokeWidth="2" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {/* hover: guide line + marker + light popup */}
            {hover && s.pts[hover.i] && (() => {
              const hp = s.pts[hover.i];
              const val = hp.actual ?? hp.proj ?? hp.plan;
              const flip = hover.i / N > 0.6;
              return (
                <>
                  <div style={{ position: "absolute", left: `${(hover.i / N) * 100}%`, top: 0, bottom: 0, width: 1, background: C.dotted ?? "#ddd9cf", pointerEvents: "none" }} />
                  {val !== null && val !== undefined && (
                    <div style={{ position: "absolute", left: `${(hover.i / N) * 100}%`, top: pctTop(y(val)), width: 7, height: 7, margin: "-3.5px 0 0 -3.5px", borderRadius: "50%", background: C.orange, boxShadow: "0 0 0 2px #fff", pointerEvents: "none" }} />
                  )}
                  <div className="chart-tip" style={{ left: `${(hover.i / N) * 100}%`, top: 4, transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
                    <div className="t-head">Day {hover.i}</div>
                    {hp.actual !== null && hp.actual !== undefined && (
                      <div className="t-row"><span>Secured</span><span className="v">{fmt(hp.actual)}</span></div>
                    )}
                    {hp.proj !== null && hp.proj !== undefined && hover.i > day && (
                      <div className="t-row"><span>Projected</span><span className="v">{fmt(hp.proj)}</span></div>
                    )}
                    {has(hp.plan) && (
                      <div className="t-row"><span>Target</span><span className="v">{fmt(hp.plan)}</span></div>
                    )}
                    {hasBm && has(hp.bm) && (
                      <div className="t-row"><span>Benchmark</span><span className="v">{fmt(hp.bm)}</span></div>
                    )}
                  </div>
                </>
              );
            })()}

            {/* today dot */}
            <div
              title={nowTip}
              style={{
                position: "absolute", left: `${(todayFrac * 100).toFixed(2)}%`, top: pctTop(y(nowVal)),
                width: 9, height: 9, margin: "-4.5px 0 0 -4.5px", borderRadius: "50%", background: C.orange,
              }}
            />

            {/* Today: the three numbers are one reading taken at one x, so they are
                stacked on the today line rather than spread across the chart. */}
            {showToday && (
              <>
                {hasBm && has(bmToday) && <div style={readTick(bmToday, C.refLine, true)} />}
                <div style={readTick(planToday, C.refLine)} />
                {readings.map((r) => (
                  <div key={r.key} style={{
                    position: "absolute", left: r.x0, top: r.y0, height: 14, lineHeight: "14px",
                    fontSize: 12, fontWeight: r.weight, color: r.color, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                    ...(r.knock ? { background: "#fff", padding: "0 3px", margin: "0 -3px", borderRadius: 2 } : {}),
                  }}>{r.text}</div>
                ))}
              </>
            )}

            {/* projection end dot (white-cored); on complete releases projection = actual,
                so the today dot already sits at the close and only the % label remains */}
            {targeted && !complete && (
              <div
                title={projTip}
                style={{
                  position: "absolute", left: "100%", top: pctTop(y(s.proj)),
                  width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                  background: "#fff", border: `2.2px solid ${C.orangeLight}`, boxSizing: "border-box",
                }}
              />
            )}
            {projPct !== null && (
              <div
                title={projTip}
                style={{
                  position: "absolute", left: "100%", top: pctTop(y(complete ? nowVal : s.proj)),
                  transform: "translateY(-50%)", paddingLeft: 10, fontSize: 12, fontWeight: 600,
                  color: pctColor, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                }}
              >
                {projPct}%
              </div>
            )}

            {/* y axis */}
            <div style={{ ...axisLabel, top: pctTop(y(axisTop)) }}>{axisLabelTop}</div>
            <div style={{ ...axisLabel, top: pctTop(y(axisTop / 2)) }}>{axisLabelMid}</div>
            <div style={{ ...axisLabel, top: "100%" }}>0</div>

            {/* At close the reference is one level, named where it sits, with the
                other one alongside it as a plain figure rather than a second
                line to read the release against. */}
            {showClose && s.target > 0 && (
              <div
                style={{
                  position: "absolute", left: 8, top: pctTop(y(Math.max(s.target, hasBm ? s.bm : 0))),
                  transform: "translateY(-145%)",
                  paddingRight: 6, background: "#fff", fontSize: 12, fontWeight: 500,
                  color: C.ink, whiteSpace: "nowrap",
                }}
              >
                target {fmt(s.target)}
                {hasBm && (
                  <span style={{ fontWeight: 400, color: C.muted }}>
                    {"  ·  benchmark " + fmt(s.bm)}
                  </span>
                )}
              </div>
            )}

            {/* x axis */}
            {showDay1Label && <div style={{ ...xLabel, left: 0 }}>day 1</div>}
            {showTodayLabel && (
              <div style={{ ...xLabel, left: `${(todayFrac * 100).toFixed(2)}%`, transform: "translateX(-50%)", color: C.ink }}>
                today
              </div>
            )}
            {showEndLabel && (
              <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }}>day {of}</div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
