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
 * today, so they live in the hover and in the names' tooltips.
 *
 * "By channel" in the head swaps the references out for the projection's
 * make-up: the same total, secured to today and projected on to the close,
 * with the five channel groups stacked under it, each band the units it
 * contributes, so the bands add up to the line exactly (scaled by one factor
 * where the total is held at the edition). The scale is units, the total's
 * figure sits at the end of its line, and a legend under the plot gives each
 * group's units and share at close; the hover reads them on any day. */
import React, { useMemo, useState } from "react";
import {
  Card, GROUP_DOTS, C, fmt, dayLabel, dayAxisLabel, dayElapsed, textPx, timeAxis, nameLines, useBoxSize, LineNames,
} from "../ui.jsx";
import { Ex } from "../explain/Explain.jsx";

const X1 = 680, Y0 = 148, YTOP = 8;

/* By channel: the groups bottom to top, in a fixed order so a band keeps its
 * place and colour from release to release. Paid sits on the baseline, where
 * a share reads most exactly, then AA Email, Artist, AA Meta, and the
 * catch-all Direct etc. on top, under the total's line. The four hues follow
 * each group's colour elsewhere on the page (Paid's section orange, the
 * email blue, the artist green, the Meta violet) and pass the categorical
 * checks against their neighbours in this order: lightness band, chroma,
 * colour-blind and normal-vision separation, 3:1 on the card. Direct etc. is
 * a warm grey, as a catch-all is, light enough to stay clear of the violet
 * below it; its figures are in the legend and the hover. Ahead of today the
 * bands drop back to half strength, as the projection's line does. */
const STACK = [
  { key: "paid", color: "#dd7a50" },
  { key: "aa_email", color: "#6390dc" },
  { key: "referral_artist", color: "#46a283" },
  { key: "aa_social", color: "#9a86d4" },
  { key: "search_direct_other", color: "#b1ab9d" },
];
const STACK_OTHER = "#c8c5bc";
const shareOf = (v, total) => {
  if (!(total > 0)) return "";
  const pc = (100 * v) / total;
  return pc > 0 && pc < 0.5 ? "<1%" : `${Math.round(pc)}%`;
};
const AHEAD_STRENGTH = 0.5;

/* round steps for a units axis: 1, 2, 2.5 or 5 times a power of ten, the
 * two or three of them that fit under the top */
function unitTicks(top) {
  if (!(top > 0)) return [];
  const raw = top / 3;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((st) => st >= raw);
  const out = [];
  for (let v = step; v <= top + 1e-9; v += step) out.push(v);
  return out;
}
/* The names are set by nameLines, the placer this card grew and the charts
 * now share (web/src/labels.mjs): each line named once, in a word in clear
 * space with a thin leader to a point on it, all in real pixels off the
 * measured plot, with the text measured in the page's own font. */

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
  const [view, setView] = useState("lines");   // "lines" (against target) | "channels"
  const byChannel = view === "channels";
  const [hover, setHover] = useState(null);   // {i, frac}
  // the plot's real size, so label spacing can be set in pixels rather than
  // in a percentage guessed from a card size that is free to change
  const [plotRef, plotW, plotH] = useBoxSize();
  const channels = snap.channels || [];
  const of = snap.of || 1;
  const day = Math.max(0, Math.min(snap.day ?? 0, of));
  const complete = !!snap.complete;
  // where today sits on the campaign clock: the day so far, at the share of
  // it seen (dayElapsed), which is where the hero reads its target by today;
  // the whole day once the window has closed
  const elapsed = complete ? day : Math.max(0, Math.min(dayElapsed(snap), of));
  const targeted = snap.targeted !== false;   // no targets: actual line only, unit axis

  const s = useMemo(() => seriesFor(snap, byChannel ? "all" : sel), [snap, sel, byChannel]);

  const right = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {!byChannel && (
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
      )}
      <span className="seg compact" role="group" aria-label="What the trajectory shows">
        <button type="button" className={byChannel ? "" : "active"} onClick={() => setView("lines")}
          title={targeted ? "The total against the target's pace and the benchmark's" : "The total secured, day by day"}>
          {targeted ? "Against target" : "Total"}
        </button>
        <button type="button" className={byChannel ? "active" : ""} onClick={() => setView("channels")}
          title="The total alone, with the channel groups shaded under it by the units each contributes">
          By channel
        </button>
      </span>
    </div>
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
  // the projection runs on from today while the release is live and targeted
  const showProjSeg = targeted && !complete && day < of;
  // the scale: against target, room for the target, the benchmark and the
  // projection; by channel, the total alone, secured and (while it runs) projected
  const maxActual = s.pts.reduce((m, p) => Math.max(m, p.actual ?? 0), 0);
  const yTopV = byChannel
    ? Math.max(maxActual, s.now, showProjSeg ? s.proj : 0, 1) * 1.04
    : Math.max(s.target, s.proj, s.now, hasBm ? s.bm : 0, 1) * 1.02;
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

  /* By channel: every group's units at each point the total's line passes
   * through - its secured units to today, its projection after - so the
   * bands stack to the line exactly. Where the total is held at the edition
   * the groups are scaled by one factor, the share each carries unchanged. */
  let stack = null;
  if (byChannel) {
    const cap = snap.edition && snap.edition.total > 0 ? snap.edition.total : null;
    const rank = (k) => { const i = STACK.findIndex((b) => b.key === k); return i < 0 ? STACK.length : i; };
    const groups = channels
      .map((c) => ({
        key: c.key, name: c.name || c.key, now: c.now ?? 0,
        color: (STACK.find((b) => b.key === c.key) || { color: STACK_OTHER }).color,
        pts: slicePts(c.daily, snap.windowStart, of),
      }))
      .sort((a, b) => rank(a.key) - rank(b.key));
    const cols = [];
    for (let i = 0; i <= lastA; i++) {
      cols.push({ t: i === lastA && lastA === todayIdx && !complete ? todayPos : i, i, ahead: false,
        vals: groups.map((g) => g.pts[i]?.actual ?? 0) });
    }
    if (showProjSeg) {
      if (lastA < todayIdx) cols.push({ t: todayPos, i: todayIdx, ahead: false, vals: groups.map((g) => g.now) });
      for (let i = todayIdx + 1; i < s.pts.length; i++) {
        if (!has(s.pts[i]?.proj)) continue;
        cols.push({ t: i, i, ahead: true, vals: groups.map((g) => g.pts[i]?.proj ?? 0) });
      }
    }
    for (const col of cols) {
      const tot = col.vals.reduce((a, b) => a + b, 0);
      const f = cap !== null && tot > cap ? cap / tot : 1;
      col.vals = col.vals.map((v) => v * f);
      col.total = tot * f;
    }
    const X = (t) => x(t).toFixed(1), Yv = (v) => y(v).toFixed(1);
    const bands = groups.map((g, k) => {
      const top = cols.map((c) => c.vals.slice(0, k + 1).reduce((a, b) => a + b, 0));
      const bot = cols.map((c) => c.vals.slice(0, k).reduce((a, b) => a + b, 0));
      const edge = cols.map((c, j) => (j ? "L" : "M") + X(c.t) + "," + Yv(top[j])).join(" ");
      const back = cols.map((c, j) => "L" + X(c.t) + "," + Yv(bot[j])).reverse().join(" ");
      return { ...g, edge, area: edge + " " + back + " Z" };
    });
    stack = cols.length > 1 ? { groups, cols, bands, last: cols[cols.length - 1] } : null;
  }
  const clipBase = "traj-" + String(snap.id || "release").replace(/[^A-Za-z0-9_-]/g, "");
  const ticks = byChannel ? unitTicks(yTopV / 1.04) : [];

  // the readings taken on the today line: the target and the benchmark by
  // today at the share of the day seen (exp, bmExp) - the hero's expectedToday
  // and benchmarkToday, summed the same way - rather than the whole day's row,
  // which on a morning reading is hours the release has not had yet
  const planToday = s.exp;
  const bmToday = hasBm ? s.bmExp : null;
  const showToday = targeted;

  // All channels ends on the hero's projection over the hero's target, the pair
  // the hero and the explainer print: the channels' sums are kept to 0.1 of a
  // unit and can round to the other side of a half percent (98% against 99%)
  const hero = snap.hero || {};
  const heroPct = (byChannel || sel === "all") && Number.isFinite(hero.projected) && hero.target > 0
    ? Math.round((hero.projected / hero.target) * 100) : null;
  const projPct = targeted && s.target > 0 ? heroPct ?? Math.round((s.proj / s.target) * 100) : null;
  // axis: % of target when there is one, secured units when there is not -
  // a group set aside for the release has no target for 100% to be, and its
  // 100%, 50% and 0 all printed on the baseline
  const pctAxis = targeted && s.target > 0;
  const axisTop = pctAxis ? s.target : yTopV / 1.02;
  const axisLabelTop = pctAxis ? "100%" : fmt(axisTop);
  const axisLabelMid = pctAxis ? "50%" : axisTop >= 2 ? fmt(axisTop / 2) : "";
  // a y label a line's height from another gives way, the middle one first
  // (in pixels, off the measured plot)
  const yPx = (v) => (y(v) / Y0) * plotH;
  const clearOf = (a, b) => !(plotH > 0) || Math.abs(yPx(a) - yPx(b)) >= 15;
  const showAxisTop = clearOf(axisTop, 0);
  const showAxisMid = showAxisTop && clearOf(axisTop / 2, 0) && clearOf(axisTop, axisTop / 2);
  const pctColor = projPct !== null && projPct >= 100 ? C.ink : C.red;
  const nowTip = byChannel ? fmt(s.now) + " units secured to date" :
    fmt(s.now) + " units secured to date · " + fmt(planToday) + " target by day " + day +
    (bmToday !== null && bmToday !== undefined ? " · " + fmt(bmToday) + " benchmark" : "");
  // by channel, the total's figure at the end of its line, in units
  const endVal = showProjSeg ? s.proj : nowVal;
  const endTip = (showProjSeg ? "Projected " : complete ? "" : "Secured to date: ") + fmt(endVal) + " units" + (showProjSeg || complete ? " at close" : "");
  const projTip = complete
    ? fmt(s.now) + " units at close" + (projPct !== null ? " · " + projPct + "% of target" : "")
    : "Projected " + fmt(s.proj) + " at close" + (projPct !== null ? " · " + projPct + "% of target" : "") +
      (sel === "all" && projPct !== null && projPct > 100
        ? " · demand beyond the sellout cannot convert" : "");
  /* "today" always shows on a live release: it is the reading that matters, and
   * the line it names is otherwise just a line. The axis ends are the announce
   * and close dates ("3 Sep", "30 Sep": the points at index 0 and index of),
   * the day number when the window has no start, so in the first or last days
   * one of them would overprint it; how close is too close is a pixel
   * question, not a fraction one, so timeAxis measures the words against the
   * plot, keeps "today" inside it, and lets the end label give way, since the
   * axis already ends there. */
  const showTodayLabel = !complete;
  const day1Text = dayAxisLabel(snap, 0), endText = dayAxisLabel(snap, of);
  const xAxis = timeAxis({ rowW: plotW, frac: todayFrac, live: showTodayLabel, startText: day1Text, endText });
  const showDay1Label = xAxis.start, showEndLabel = xAxis.end;

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  /* The names, set clear of everything drawn (nameLines, labels.mjs): secured
   * at its dot, projected, target and benchmark each anchored somewhere along
   * their line, in that order, so the one that matters most gets the best
   * place. An anchor is a day's point on the line, away from the ends and
   * from the today dot. The today line is one of the lines a name keeps off
   * where it can. Nothing is placed until the plot has been measured. */
  let names = [];
  if (!byChannel && showToday && plotW > 0 && plotH > 0) {
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
      ...(!complete ? [{ pts: [{ x: px(todayPos), y: 0 }, { x: px(todayPos), y: plotH }] }] : []),
    ];
    const ax = px(todayPos), ayNow = py(nowVal), ayEnd = py(complete ? nowVal : s.proj);
    const blocks = [
      { x0: ax - 6, y0: ayNow - 6, x1: ax + 6, y1: ayNow + 6 },   // the today dot
      ...(targeted && !complete ? [{ x0: plotW - 6, y0: ayEnd - 6, x1: plotW + 6, y1: ayEnd + 6 }] : []),   // the projection's dot
      ...(projPct !== null ? [{ x0: plotW + 8, y0: ayEnd - 8, x1: plotW + 12 + textPx(`${projPct}%`, 12, 600), y1: ayEnd + 8 }] : []),
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
    const label = (key, text, color, weight, title, anchors) => ({ key, text, color, weight, title, anchors, w: textPx(text, 12, weight), h: H });
    const labels = [
      // its leader stops short of the today dot it names
      { ...label("now", "secured", C.ink, 600, nowTip, [{ x: ax, y: ayNow, cost: 0 }]), dot: 6.5 },
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
              {(byChannel ? ticks : [axisTop / 2]).map((v) => (
                <line key={v} x1="0" y1={y(v).toFixed(1)} x2={X1} y2={y(v).toFixed(1)}
                  stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
              <line x1="0" y1={Y0} x2={X1} y2={Y0}
                stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {/* by channel: the bands, full strength to today and half after,
                  a 2px gap of the card between neighbours */}
              {stack && (
                <>
                  <defs>
                    <clipPath id={`${clipBase}-past`}><rect x="-2" y="-20" width={(x(todayPos) + 2).toFixed(1)} height={Y0 + 40} /></clipPath>
                    <clipPath id={`${clipBase}-ahead`}><rect x={x(todayPos).toFixed(1)} y="-20" width={(X1 - x(todayPos) + 2).toFixed(1)} height={Y0 + 40} /></clipPath>
                  </defs>
                  {[["past", 1], ["ahead", AHEAD_STRENGTH]].map(([half, strength]) => (
                    <g key={half} clipPath={`url(#${clipBase}-${half})`} opacity={strength}>
                      {stack.bands.map((b) => <path key={b.key} d={b.area} fill={b.color} />)}
                    </g>
                  ))}
                  {stack.bands.slice(0, -1).map((b) => (
                    <path key={b.key} d={b.edge} fill="none" stroke={C.white} strokeWidth="2" strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke" />
                  ))}
                </>
              )}
              {!complete && (
                <line x1={x(todayPos).toFixed(1)} y1="0" x2={x(todayPos).toFixed(1)} y2={Y0}
                  stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
              {/* the target's pace as a solid line, the benchmark's as a dotted
                  one - the bars' marks, with the actual in front. Ahead of
                  today both drop back, because it has not happened yet. */}
              {!byChannel && (showToday ? ["future", "past"] : ["full"]).map((half) => {
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
            {byChannel && hover && stack && (() => {
              const at = hover.frac * N;
              const col = stack.cols.reduce((b, c) => (Math.abs(c.t - at) < Math.abs(b.t - at) ? c : b), stack.cols[0]);
              if (at > stack.last.t + 0.5) return null;
              const left = `${(col.t / N) * 100}%`;
              const flip = col.t / N > 0.6;
              const rows = stack.groups.map((g, k) => ({ g, v: col.vals[k] })).reverse();
              return (
                <>
                  <div style={{ position: "absolute", left, top: 0, bottom: 0, width: 1, background: C.dotted ?? "#ddd9cf", pointerEvents: "none" }} />
                  <div style={{
                    position: "absolute", left, top: pctTop(y(col.total)), width: 7, height: 7, margin: "-3.5px 0 0 -3.5px",
                    borderRadius: "50%", boxShadow: "0 0 0 2px #fff", pointerEvents: "none", background: col.ahead ? C.blueLight : C.blue,
                  }} />
                  <div className="chart-tip" style={{ left, top: 4, transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
                    <div className="t-head">{dayLabel(snap, col.i, true)}</div>
                    <div className="t-row"><span>{col.ahead ? "Projected" : "Secured"}</span><span className="v">{fmt(col.total)}</span></div>
                    {rows.map(({ g, v }) => (
                      <div className="t-row" key={g.key}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                          <span style={{ width: 9, height: 9, borderRadius: 2, background: g.color, flex: "0 0 9px" }} />{g.name}
                        </span>
                        <span className="v">{fmt(v)}<span style={{ color: C.muted, fontWeight: 400 }}>{col.total > 0 ? ` · ${shareOf(v, col.total)}` : ""}</span></span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
            {!byChannel && hover && s.pts[hover.i] && (() => {
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
            {showToday && <LineNames names={names} />}

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
            {byChannel && (
              <div
                title={endTip}
                style={{
                  position: "absolute", left: "100%", top: pctTop(y(endVal)),
                  transform: "translateY(-50%)", paddingLeft: 10, fontSize: 12, fontWeight: 600,
                  color: C.ink, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                }}
              >
                <Ex k="hero.fill" arg={{ close: showProjSeg, where: "Unit trajectory" }}>{fmt(endVal)}</Ex>
              </div>
            )}
            {!byChannel && projPct !== null && (
              <div
                title={projTip}
                style={{
                  position: "absolute", left: "100%", top: pctTop(y(complete ? nowVal : s.proj)),
                  transform: "translateY(-50%)", paddingLeft: 10, fontSize: 12, fontWeight: 600,
                  color: pctColor, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                }}
              >
                <Ex k="traj.end" arg={{ sel }}>{projPct}%</Ex>
              </div>
            )}

            {/* y axis */}
            {byChannel ? ticks.map((v) => (
              <div key={v} style={{ ...axisLabel, top: pctTop(y(v)) }}>{fmt(v)}</div>
            )) : (
              <>
                {showAxisTop && <div style={{ ...axisLabel, top: pctTop(y(axisTop)) }}>{axisLabelTop}</div>}
                {showAxisMid && <div style={{ ...axisLabel, top: pctTop(y(axisTop / 2)) }}>{axisLabelMid}</div>}
              </>
            )}
            <div style={{ ...axisLabel, top: "100%" }}>0</div>

            {/* x axis */}
            {showDay1Label && <div style={{ ...xLabel, left: 0 }} title="announced">{day1Text}</div>}
            {showTodayLabel && (
              <div style={{
                ...xLabel, color: C.ink,
                ...(xAxis.todayLeft === null ? { left: `${(todayFrac * 100).toFixed(2)}%`, transform: "translateX(-50%)" } : { left: xAxis.todayLeft }),
              }}>
                today
              </div>
            )}
            {showEndLabel && (
              <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }} title={`close · day ${of}`}>{endText}</div>
            )}
          </div>
        </div>
        {stack && (
          <div className="traj-legend" aria-label="Units by channel group">
            <div className="cap">{showProjSeg ? "Projected at close" : complete ? "At close" : "Secured to date"}</div>
            <div className="its">
              {stack.groups.map((g, k) => ({ g, v: stack.last.vals[k] })).reverse().map(({ g, v }) => (
                <span className="it" key={g.key}>
                  <span className="sw" style={{ background: g.color }} />
                  <span className="nm">{g.name}</span>
                  <span className="v"><Ex k="traj.group" arg={{ key: g.key, value: v, total: stack.last.total, ahead: showProjSeg }}>{fmt(v)}</Ex>{stack.last.total > 0 ? ` · ${shareOf(v, stack.last.total)}` : ""}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
