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
 * actual is the blue line in front. No area under any of them: a fill said
 * nothing the lines did not, and hid the actual where it ran below the target.
 * The second reference is one more line, not a second system.
 *
 * One picture, whichever horizon the page is on. The chart already answers both
 * questions at once: where the lines stand at the today line says where the
 * release should be by now, and the dashed projection running on to the last
 * day, with its percentage of target at the end, says where it lands. Redrawing
 * the references as levels for the second question only took the first one
 * away, so the card no longer follows the page toggle and carries no horizon
 * badge.
 *
 * Each line is named once, in a word set in clear space with a thin leader
 * to a point on the line (the secured line at its dot): secured, projected,
 * target, benchmark, the hover's own words. The figures are not on the plot:
 * a figure beside a line read as the line's total when it was the reading by
 * today, so they live in the hover and in the names' tooltips. */
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, dayLabel, dayAxisLabel, labelPx, dayElapsed } from "../ui.jsx";

const X1 = 680, Y0 = 148, YTOP = 8;
const LABEL_TODAY_PX = 38; // rendered width of "today" at 12px

/* ---- naming the lines --------------------------------------------------------
 * A name is a word in clear space with a leader to a point on its line. It
 * may sit anywhere no curve, no dot, no figure and no other name runs
 * through, its leader may cross no name, no dot and no other leader, and
 * among those places it takes the one with the shortest leader, the fewest
 * curves under the leader, and an anchor near the middle of its line, spread
 * from the other names' anchors. The names are set one after another, each
 * treating the ones already set as walls, so two never overlap. Only when a
 * name has nowhere that clear does it settle for a place across a curve or a
 * leader, and only when it has nowhere at all does it go on a card-white
 * patch where it runs into the least. Another name is the one wall that
 * holds in every tier, so two names never overlap. All of
 * it is in real pixels off the measured plot, with the text measured in the
 * page's own font, so it holds whatever width the card is given. */
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
// do two segments cross (touching counts)
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const on = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
// where a leader leaves its name: the point where the line from the box's
// centre to the anchor crosses the box's edge, a step clear of the text
function leaderStart(box, anchor) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const dx = anchor.x - cx, dy = anchor.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx !== 0 ? ((dx > 0 ? box.x1 : box.x0) - cx) / dx : Infinity;
  const ty = dy !== 0 ? ((dy > 0 ? box.y1 : box.y0) - cy) / dy : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t + (dx / len) * 3, y: cy + dy * t + (dy / len) * 3 };
}
// the eight ways a name can sit off its anchor, at four distances
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
  .map(([dx, dy]) => { const n = Math.hypot(dx, dy); return [dx / n, dy / n]; });
const DISTS = [18, 30, 44, 60];
function nameLines({ labels, curves, blocks, bounds }) {
  const names = [];                      // each name's box as it is set: nothing may ever touch these
  const leaders = [];                    // each leader as it is set
  const anchorsSet = [];
  const segs = curves.flatMap((c) => c.pts.slice(1).map((p, i) => ({ a: c.pts[i], b: p })));
  const near = (s, pt) => Math.hypot(s.a.x - pt.x, s.a.y - pt.y) < 7 || Math.hypot(s.b.x - pt.x, s.b.y - pt.y) < 7;
  const inside = (pt, b) => pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1;
  const out = [];
  for (const lb of labels) {
    const candidates = [];
    for (const anchor of lb.anchors) {
      // the leader may run into the mark it points at (the today dot), not into any other
      const marks = blocks.filter((b) => !inside(anchor, b));
      for (const [ux, uy] of DIRS) for (const d of DISTS) {
        const ax = anchor.x + ux * d, ay = anchor.y + uy * d;
        const x0 = ux < 0 ? ax - lb.w : ux > 0 ? ax : ax - lb.w / 2;
        const y0 = uy < 0 ? ay - lb.h : uy > 0 ? ay : ay - lb.h / 2;
        const box = { x0, y0, x1: x0 + lb.w, y1: y0 + lb.h };
        const pad = { x0: x0 - 2, y0: y0 - 2, x1: box.x1 + 2, y1: box.y1 + 2 };
        if (pad.x0 < bounds.x0 || pad.x1 > bounds.x1 || pad.y0 < bounds.y0 || pad.y1 > bounds.y1) continue;
        const start = leaderStart(box, anchor);
        const onName = names.some((n) => boxesTouch(pad, n) || segHitsBox(start.x, start.y, anchor.x, anchor.y, n));
        if (onName) continue;            // never on another name, never a leader through one
        const onMark = blocks.filter((b) => boxesTouch(pad, b)).length + marks.filter((b) => segHitsBox(start.x, start.y, anchor.x, anchor.y, b)).length;
        const onLeader = leaders.filter((l) => segHitsBox(l.a.x, l.a.y, l.b.x, l.b.y, pad) || segsCross(start, anchor, l.a, l.b)).length;
        const underBox = segs.filter((s) => segHitsBox(s.a.x, s.a.y, s.b.x, s.b.y, pad)).length;
        const underLeader = segs.filter((s) => !near(s, anchor) && segsCross(start, anchor, s.a, s.b)).length;
        const len = Math.hypot(start.x - anchor.x, start.y - anchor.y);
        const crowd = anchorsSet.filter((p) => Math.abs(p.x - anchor.x) < 48).length;
        candidates.push({
          box, start, anchor, underBox,
          cost: underBox * 10 + underLeader * 3 + len * 0.04 + (anchor.cost || 0) + crowd * 4,
          // the tiers, worst first: on a dot or the figure; across a leader or under a curve; clear
          hard: onMark, soft: onLeader + underBox,
        });
      }
    }
    if (!candidates.length) continue;
    const pick = (list) => list.reduce((best, c) => (c.cost < best.cost ? c : best));
    const clear = candidates.filter((c) => c.hard === 0 && c.soft === 0);
    const clearish = candidates.filter((c) => c.hard === 0);
    const best = clear.length ? pick(clear) : clearish.length ? pick(clearish)
      : pick(candidates.map((c) => ({ ...c, cost: c.cost + c.hard * 100 })));
    const knock = best.hard > 0 || best.underBox > 0;
    names.push({ x0: best.box.x0 - 2, y0: best.box.y0 - 2, x1: best.box.x1 + 2, y1: best.box.y1 + 2 });
    leaders.push({ a: best.start, b: best.anchor });
    anchorsSet.push(best.anchor);
    out.push({ ...lb, x0: best.box.x0, y0: best.box.y0, start: best.start, anchor: best.anchor, knock });
  }
  return out;
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
  // so this view cannot diverge from the channels module. The release cannot
  // sell more than its edition, so the line flattens at the sellout, where the
  // hero caps; a single channel's demand is its own and is not capped.
  const cap = snap.edition && snap.edition.total > 0 ? snap.edition.total : null;
  const clamp = (v) => (v !== null && v !== undefined && cap !== null ? Math.min(v, cap) : v);
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
    pts.push({ date: dt, actual: clamp(a), plan: p, proj: clamp(pr), bm: b });
  }
  const sum = (f) => channels.reduce((t, c) => t + (c[f] ?? 0), 0);
  const has = (f) => channels.some((c) => c[f] !== null && c[f] !== undefined);
  return {
    now: clamp(sum("now")), exp: sum("exp"), proj: clamp(sum("proj")), target: sum("target"),
    bm: has("bm") ? sum("bm") : null, bmExp: has("bmExp") ? sum("bmExp") : null,
    pts,
  };
}

/* The same polyline closed back along the baseline, so the reference can be a
 * filled area. Drawn from the first point rather than from x=0 because a series
 * that starts a day in should not be given a day it did not have. */
export default function Trajectory({ snap }) {
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
  // where today sits on the campaign clock: the day so far, at the share of
  // it seen (dayElapsed), which is where the hero reads its target by today;
  // the whole day once the window has closed
  const elapsed = complete ? day : Math.max(0, Math.min(dayElapsed(snap), of));
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
  // the target's pace and the benchmark's, each a line
  const has = (v) => v !== null && v !== undefined;
  const planAt = (p) => p.plan;
  const bmAt = (p) => (hasBm ? p.bm : null);
  const yTopV = Math.max(s.target, s.proj, s.now, hasBm ? s.bm : 0, 1) * 1.02;
  const x = (i) => (i / N) * X1;
  const y = (v) => Y0 - (Math.max(0, v) / yTopV) * (Y0 - YTOP);
  const pctTop = (yy) => ((yy / Y0) * 100).toFixed(2) + "%";

  const todayIdx = Math.min(day, N);            // the day's own row, for the point read on it
  const todayPos = Math.min(elapsed, N);        // the today line, at the share of the day seen
  const todayFrac = todayPos / N;
  const nowVal = s.pts[todayIdx]?.actual ?? s.now;

  // a series' value at a fractional index, read off the straight line between
  // its neighbours, so a path can be cut at the today line rather than at the
  // nearest whole day
  const valueAt = (get, t) => {
    const i = Math.floor(t), j = Math.min(i + 1, N), f = t - i;
    const a = has(s.pts[i]) ? get(s.pts[i]) : null, b = has(s.pts[j]) ? get(s.pts[j]) : null;
    if (!has(a)) return null;
    if (!has(b) || f === 0) return a;
    return a + (b - a) * f;
  };
  // one polyline over a range whose ends may fall inside a day, nulls skipped
  const cutPath = (get, from, to) => {
    const out = [];
    const push = (t, v) => { if (has(v)) out.push((out.length ? "L" : "M") + x(t).toFixed(1) + "," + y(v).toFixed(1)); };
    if (from !== Math.floor(from)) push(from, valueAt(get, from));
    for (let i = Math.ceil(from); i <= Math.floor(to) && i < s.pts.length; i++) push(i, has(s.pts[i]) ? get(s.pts[i]) : null);
    if (to !== Math.floor(to)) push(to, valueAt(get, to));
    return out.length > 1 ? out.join(" ") : "";
  };

  // paths, each in a past and a future half so the half that has not happened
  // yet can drop back at the today line
  const halves = { past: [0, todayPos], future: [todayPos, N], full: [0, N] };
  const draw = {};
  for (const [name, [a, b]] of Object.entries(halves)) {
    draw[name] = { target: cutPath(planAt, a, b), bm: hasBm ? cutPath(bmAt, a, b) : "" };
  }

  let lastA = -1;
  s.pts.forEach((p, i) => {
    if (p.actual !== null && p.actual !== undefined) lastA = i;
  });
  // the day so far is the last point, and it sits on the today line: at the
  // share of the day seen, not at the whole of it
  const actX = (i) => x(i === lastA && lastA === todayIdx && !complete ? todayPos : i);
  const actPath =
    lastA >= 1
      ? s.pts
          .slice(0, lastA + 1)
          .map((p, i) => (i ? "L" : "M") + actX(i).toFixed(1) + "," + y(p.actual ?? 0).toFixed(1))
          .join(" ")
      : "";

  // Projection follows the historic channel shape (etl emits per-day `proj` values);
  // straight-line fallback only if no shaped path is present.
  const showProjSeg = targeted && !complete && day < of;
  let projPath = "";
  if (showProjSeg) {
    const segs = ["M" + x(todayPos).toFixed(1) + "," + y(nowVal).toFixed(1)];
    s.pts.forEach((p, i) => {
      if (i > todayIdx && p.proj !== null && p.proj !== undefined) {
        segs.push("L" + x(i).toFixed(1) + "," + y(p.proj).toFixed(1));
      }
    });
    if (segs.length === 1) segs.push("L" + X1 + "," + y(s.proj).toFixed(1));
    projPath = segs.join(" ");
  }

  // the readings taken on the today line: the target and the benchmark by
  // today at the share of the day seen (exp, bmExp) - the hero's expectedToday
  // and benchmarkToday, summed the same way - rather than the whole day's row,
  // which on a morning reading is hours the release has not had yet
  const planToday = s.exp;
  const bmToday = hasBm ? s.bmExp : null;
  const showToday = targeted;

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
  // the axis ends are the announce and close dates ("3 Sep", "30 Sep": the
  // points at index 0 and index of), the day number when the window has no
  // start; their widths as drawn at 12px
  const day1Text = dayAxisLabel(snap, 0), endText = dayAxisLabel(snap, of);
  const day1Room = plotW > 0
    ? todayFrac * plotW - (LABEL_TODAY_PX / 2 + labelPx(day1Text) + 8)
    : (todayFrac < 0.08 ? -1 : 1);
  const endLabelRoom = plotW > 0
    ? (1 - todayFrac) * plotW - (LABEL_TODAY_PX / 2 + labelPx(endText) + 10)
    : (todayFrac > 0.82 ? -1 : 1);
  const showDay1Label = !(showTodayLabel && day1Room < 0);
  const showEndLabel = !(showTodayLabel && endLabelRoom < 0);

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  /* The names, set clear of everything drawn (the placer at the top of the
   * file): secured at its dot, projected, target and benchmark each anchored
   * somewhere along their line, in that order, so the one that matters most
   * gets the best place. An anchor is a day's point on the line, away from
   * the ends and from the today dot. Nothing is placed until the plot has
   * been measured. */
  let names = [];
  if (showToday && plotW > 0 && plotH > 0) {
    const px = (i) => (i / N) * plotW;
    const py = (v) => (y(v) / Y0) * plotH;
    const polylines = (get, from, to) => {
      const out = []; let run = [];
      for (let i = from; i <= to; i++) {
        const v = has(s.pts[i]) ? get(s.pts[i]) : null;
        if (has(v)) run.push({ x: px(i), y: py(v), i }); else if (run.length) { out.push(run); run = []; }
      }
      if (run.length) out.push(run);
      return out;
    };
    const targetRuns = polylines(planAt, 0, N), bmRuns = hasBm ? polylines(bmAt, 0, N) : [];
    const projRun = [];
    if (showProjSeg) {
      projRun.push({ x: px(todayPos), y: py(nowVal), i: todayPos });
      s.pts.forEach((p, i) => { if (i > todayIdx && has(p.proj)) projRun.push({ x: px(i), y: py(p.proj), i }); });
      if (projRun.length === 1) projRun.push({ x: plotW, y: py(s.proj), i: N });
    }
    const curves = [
      ...polylines((p) => p.actual, 0, lastA).map((pts) => ({ pts })),
      ...targetRuns.map((pts) => ({ pts })), ...bmRuns.map((pts) => ({ pts })),
      ...(projRun.length > 1 ? [{ pts: projRun }] : []),
    ];
    const ax = px(todayPos), ayNow = py(nowVal), ayEnd = py(complete ? nowVal : s.proj);
    const font = (weight) => `${weight} 12px ${pageFont()}`;
    const blocks = [
      { x0: ax - 6, y0: ayNow - 6, x1: ax + 6, y1: ayNow + 6 },   // the today dot
      ...(targeted && !complete ? [{ x0: plotW - 6, y0: ayEnd - 6, x1: plotW + 6, y1: ayEnd + 6 }] : []),   // the projection's dot
      ...(projPct !== null ? [{ x0: plotW + 8, y0: ayEnd - 8, x1: plotW + 12 + textWidth(`${projPct}%`, font(600)), y1: ayEnd + 8 }] : []),
    ];
    // the anchors a line offers: its points a day in from either end and a day
    // clear of the today dot, each costing a little for its distance from the
    // middle of the line, so a name settles near the middle when it can
    const anchorsOn = (runs, skipToday) => {
      const pts = runs.flat().filter((p) => p.i > 0 && p.i < N && (!skipToday || Math.abs(p.i - todayIdx) > 1));
      if (!pts.length) return runs.flat();
      const xs = pts.map((p) => p.x), mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      return pts.map((p) => ({ x: p.x, y: p.y, cost: Math.abs(p.x - mid) * 0.02 }));
    };
    const projAnchors = () => {
      const inner = projRun.slice(1, -1).filter((p) => p.i - todayIdx > 1);
      if (inner.length) return anchorsOn([inner], false);
      const a = projRun[0], b = projRun[projRun.length - 1];
      return [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, cost: 0 }];
    };
    const H = 14;
    const label = (key, text, color, weight, title, anchors) => ({ key, text, color, weight, title, anchors, w: textWidth(text, font(weight)), h: H });
    const labels = [
      label("now", "secured", C.ink, 600, nowTip, [{ x: ax, y: ayNow, cost: 0 }]),
      ...(showProjSeg && projRun.length > 1 ? [label("proj", "projected", C.muted, 500, projTip, projAnchors())] : []),
      label("target", "target", C.ink, 500,
        `${fmt(planToday)} target by day ${day} · ${fmt(s.target)} at close`, anchorsOn(targetRuns, true)),
      ...(hasBm && has(bmToday) ? [label("bm", "benchmark", C.muted, 500,
        `${fmt(bmToday)} benchmark by day ${day} · ${fmt(s.bm)} at close`, anchorsOn(bmRuns, true))] : []),
    ].filter((lb) => lb.anchors.length);
    names = nameLines({ labels, curves, blocks, bounds: { x0: 0, y0: -10, x1: plotW + 44, y1: plotH } });
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
                <path d={projPath} fill="none" stroke={C.blueLight} strokeWidth="2.4"
                  strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {actPath && (
                <path d={actPath} fill="none" stroke={C.blue} strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {/* hover: guide line + a marker on every line the guide crosses +
                light popup. The popup reads three figures off one day, so each
                one is marked where it was read: the actual (or, ahead of today,
                the projection) in its blue, the target as a solid reference
                dot and the benchmark as a hollow one, the same solid-and-outline
                grammar the references wear everywhere else. */}
            {hover && s.pts[hover.i] && (() => {
              const hp = s.pts[hover.i];
              const ahead = has(hp.actual) ? false : has(hp.proj);
              const val = hp.actual ?? hp.proj ?? hp.plan;
              const flip = hover.i / N > 0.6;
              const at = `${(hover.i / N) * 100}%`;
              const mark = (v, extra) => ({
                position: "absolute", left: at, top: pctTop(y(v)),
                width: 7, height: 7, margin: "-3.5px 0 0 -3.5px", borderRadius: "50%",
                boxShadow: "0 0 0 2px #fff", pointerEvents: "none", boxSizing: "border-box", ...extra,
              });
              return (
                <>
                  <div style={{ position: "absolute", left: at, top: 0, bottom: 0, width: 1, background: C.dotted ?? "#ddd9cf", pointerEvents: "none" }} />
                  {targeted && has(hp.plan) && <div style={mark(hp.plan, { background: C.refLine })} />}
                  {hasBm && has(hp.bm) && <div style={mark(hp.bm, { background: "#fff", border: `2px solid ${C.refLine}` })} />}
                  {has(val) && (
                    <div style={mark(val, { background: ahead ? C.blueLight : C.blue })} />
                  )}
                  <div className="chart-tip" style={{ left: `${(hover.i / N) * 100}%`, top: 4, transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
                    <div className="t-head">{dayLabel(snap, hover.i, true)}</div>
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
                width: 9, height: 9, margin: "-4.5px 0 0 -4.5px", borderRadius: "50%", background: C.blue,
              }}
            />

            {/* the names and their leaders: a leader runs from the name's edge to
                a grey point on its line, or up to the edge of the today dot */}
            {showToday && names.length > 0 && (
              <>
                <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }} aria-hidden="true">
                  {names.map((n) => {
                    const toDot = n.key === "now";
                    const dx = n.anchor.x - n.start.x, dy = n.anchor.y - n.start.y, len = Math.hypot(dx, dy) || 1;
                    const end = toDot ? { x: n.anchor.x - (dx / len) * 6.5, y: n.anchor.y - (dy / len) * 6.5 } : n.anchor;
                    return (
                      <g key={n.key}>
                        <line x1={n.start.x.toFixed(1)} y1={n.start.y.toFixed(1)} x2={end.x.toFixed(1)} y2={end.y.toFixed(1)} stroke={C.targetLine} strokeWidth="1" />
                        {!toDot && <circle cx={n.anchor.x.toFixed(1)} cy={n.anchor.y.toFixed(1)} r="2.4" fill={C.targetLine} />}
                      </g>
                    );
                  })}
                </svg>
                {names.map((n) => (
                  <div key={n.key} title={n.title} style={{
                    position: "absolute", left: n.x0, top: n.y0, height: n.h, lineHeight: `${n.h}px`,
                    fontSize: 12, fontWeight: n.weight, color: n.color, whiteSpace: "nowrap",
                    ...(n.knock ? { background: "#fff", padding: "0 3px", margin: "0 -3px", borderRadius: 2 } : {}),
                  }}>{n.text}</div>
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
                  background: "#fff", border: `2.2px solid ${C.blueLight}`, boxSizing: "border-box",
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

            {/* x axis */}
            {showDay1Label && <div style={{ ...xLabel, left: 0 }} title="announced">{day1Text}</div>}
            {showTodayLabel && (
              <div style={{ ...xLabel, left: `${(todayFrac * 100).toFixed(2)}%`, transform: "translateX(-50%)", color: C.ink }}>
                today
              </div>
            )}
            {showEndLabel && (
              <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }} title={`close · day ${of}`}>{endText}</div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
