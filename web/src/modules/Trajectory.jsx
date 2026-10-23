/* Unit trajectory (a timed launch's signup trajectory before its window):
 * cumulative secured units by day against the target's pace and the
 * benchmark's, the projection running on from today to the close. The
 * series is the element-wise sum of every channel group's daily[] rows
 * (actual, plan, proj, bm), sliced to the campaign window so day N is index
 * N, and capped at the edition on a draw launch, whose secured units cannot
 * pass its sellout; the per-day values are the ETL's (docs 5.4). The head
 * reads today's units against the target and the benchmark by today (exp,
 * bmExp: the hero's expectedToday and benchmarkToday, summed the same way),
 * and the projection at the close sits in the legend and the hover. */
import React, { useMemo } from "react";
import { Card, Head, vsDelta } from "../ui.jsx";
import { LineChart, niceAxis, kfmt, COL, lk } from "../charts.jsx";
import { fmt, dayLabel, dayElapsed } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";
import { stepTicks } from "./clock.mjs";

const has = (v) => v !== null && v !== undefined;

function slicePts(daily, windowStart, of) {
  if (!daily || !daily.length) return [];
  let i0 = daily.findIndex((d) => d.date === windowStart);
  if (i0 < 0) i0 = Math.max(0, daily.length - (of + 1));
  return daily.slice(i0);
}

/* every group's daily series summed (and the summed targets), so the card
 * cannot diverge from the channels card; the release cannot sell more than
 * its edition, so the line flattens at the sellout, where the hero caps (a
 * timed launch's edition is no ceiling on its units) */
function seriesFor(snap) {
  const channels = snap.channels || [];
  const of = snap.of || 1;
  const cap = snap.type !== "TL" && snap.edition && snap.edition.total > 0 ? snap.edition.total : null;
  const clamp = (v) => (has(v) && cap !== null ? Math.min(v, cap) : v);
  const sliced = channels.map((c) => slicePts(c.daily, snap.windowStart, of));
  const n = sliced.reduce((m, s) => Math.max(m, s.length), 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let a = null, p = null, pr = null, b = null, dt = null;
    for (const s of sliced) {
      const d = s[i];
      if (!d) continue;
      if (!dt) dt = d.date;
      if (has(d.actual)) a = (a ?? 0) + d.actual;
      if (has(d.plan)) p = (p ?? 0) + d.plan;
      if (has(d.proj)) pr = (pr ?? 0) + d.proj;
      if (has(d.bm)) b = (b ?? 0) + d.bm;
    }
    pts.push({ date: dt, actual: clamp(a), plan: p, proj: clamp(pr), bm: b });
  }
  const sum = (f) => channels.reduce((t, c) => t + (c[f] ?? 0), 0);
  const some = (f) => channels.some((c) => has(c[f]));
  return {
    now: clamp(sum("now")), exp: sum("exp"), proj: clamp(sum("proj")), target: sum("target"),
    bm: some("bm") ? sum("bm") : null, bmExp: some("bmExp") ? sum("bmExp") : null, pts,
  };
}

export default function Trajectory({ snap }) {
  const s = useMemo(() => seriesFor(snap), [snap]);
  const W = wordsOf(snap);
  const of = snap.of || 1;
  const day = Math.max(0, Math.min(snap.day ?? 0, of));
  const complete = !!snap.complete;
  // where today sits on the clock: the day so far at the share of it seen
  const elapsed = complete ? day : Math.max(0, Math.min(dayElapsed(snap), of));
  const targeted = snap.targeted !== false;
  if (!s.pts.length) {
    return <Card wide title={W.trajTitle}><div className="empty-state">No {W.stepWord}-by-{W.stepWord} series yet</div></Card>;
  }
  const pts = s.pts, N = Math.max(1, pts.length - 1);
  const hasBm = !!snap.benchmark && s.bm !== null && s.bm > 0;
  const showProj = targeted && !complete && day < of;
  let lastA = -1;
  pts.forEach((p, i) => { if (has(p.actual)) lastA = i; });
  const todayIdx = Math.min(day, N);
  const nowVal = pts[todayIdx]?.actual ?? s.now;

  const actual = pts.map((p, i) => (i <= lastA && has(p.actual) ? p.actual : null));
  const target = targeted ? pts.map((p) => (has(p.plan) ? p.plan : null)) : null;
  const bm = hasBm ? pts.map((p) => (has(p.bm) ? p.bm : null)) : null;
  let proj = null;
  if (showProj) {
    proj = pts.map((p, i) => (i === todayIdx ? nowVal : i > todayIdx && has(p.proj) ? p.proj : null));
    // no shaped path on an older snapshot: a straight line to the close
    if (!proj.some((v, i) => i > todayIdx && has(v))) proj[N] = s.proj;
  }
  const top = Math.max(1, ...[actual, target, bm, proj].filter(Boolean).flat().filter(has));
  const ax = niceAxis(top);

  const planToday = s.exp, bmToday = hasBm ? s.bmExp : null;
  const hero = snap.hero || {};
  const heroPct = Number.isFinite(hero.projected) && hero.target > 0 ? Math.round((hero.projected / hero.target) * 100) : null;
  const projPct = targeted && s.target > 0 ? heroPct ?? Math.round((s.proj / s.target) * 100) : null;
  const nowTip = `${fmt(s.now)} ${W.unit} ${W.securedLower} to date` + (targeted ? ` · ${fmt(planToday)} target by ${W.stepWord} ${day}` : "")
    + (has(bmToday) ? ` · ${fmt(bmToday)} benchmark` : "");
  const projTip = complete
    ? `${fmt(s.now)} ${W.unit} at the ${W.closeWord}` + (projPct !== null ? ` · ${projPct}% of target` : "")
    : `Projected ${fmt(s.proj)} at the ${W.closeWord}` + (projPct !== null ? ` · ${projPct}% of target` : "")
      + (!W.tl && projPct !== null && projPct > 100 ? " · demand beyond the sellout cannot convert" : "");

  const series = [
    ...(target ? [{ name: "Target", color: COL.LIGHT, w: 2, vals: target }] : []),
    ...(bm ? [{ name: "Benchmark", color: COL.INK, w: 1.5, da: "1 4", vals: bm }] : []),
    ...(proj ? [{ name: "Projected", color: COL.IND, w: 1.5, da: "4 4", vals: proj }] : []),
    { name: W.secured, color: COL.IND, w: 2, area: true, vals: actual },
  ];
  const legend = [
    { n: W.secured, v: fmt(s.now), k: lk(COL.IND), tip: nowTip },
    ...(proj ? [{ n: "Projected", v: fmt(s.proj), k: lk(COL.IND, "dashed"), tip: projTip }] : []),
    ...(target ? [{ n: "Target", v: fmt(s.target), k: lk(COL.LIGHT), tip: `${fmt(planToday)} target by ${W.stepWord} ${day} · ${fmt(s.target)} at the ${W.closeWord}` }] : []),
    ...(bm ? [{ n: "Benchmark", v: fmt(s.bm), k: lk(COL.INK, "dotted"), tip: `${fmt(bmToday)} benchmark by ${W.stepWord} ${day} · ${fmt(s.bm)} at the ${W.closeWord}: the median of the matched basket` }] : []),
  ];
  const aside = complete ? "final" : `${W.stepWord} ${day} of ${of}`;
  return (
    <Card wide title={W.trajTitle} aria={`${W.trajTitle}: cumulative ${W.unit} by ${W.stepWord}`}>
      <Head v={fmt(nowVal)} u={W.unit}
        deltas={[
          targeted ? vsDelta(nowVal, planToday, "target", `${fmt(nowVal)} against the ${fmt(planToday)} the target expects by ${W.stepWord} ${day}`) : null,
          hasBm ? vsDelta(nowVal, bmToday, "benchmark", `${fmt(nowVal)} against the basket's ${fmt(bmToday)} by ${W.stepWord} ${day}`) : null,
        ]}
        aside={aside} asideTip={showProj ? projTip : nowTip} />
      <LineChart H={260} L={40} n={pts.length} ymax={ax.ymax} yticks={ax.ticks} yfmt={kfmt} xticks={stepTicks(snap, N)}
        marks={complete ? [] : [Math.min(elapsed, N)]} series={series} legend={legend}
        dotAt={(i) => (has(actual[i]) ? actual[i] : proj && has(proj[i]) ? proj[i] : null)}
        title={(i) => dayLabel(snap, i, true) + (!complete && i === todayIdx ? ", today" : i === N ? `, the ${W.closeWord}` : "")}
        rows={(i) => {
          const p = pts[i];
          const ahead = !has(actual[i]) && proj && has(proj[i]);
          return [
            { n: ahead ? "Projected" : W.secured, v: has(actual[i]) ? fmt(actual[i]) : ahead ? fmt(proj[i]) : "–", k: lk(COL.IND, ahead ? "dashed" : "solid") },
            ...(target && has(p.plan) ? [{ n: "Target", v: fmt(p.plan), k: lk(COL.LIGHT) }] : []),
            ...(bm && has(p.bm) ? [{ n: "Benchmark", v: fmt(p.bm), k: lk(COL.INK, "dotted") }] : []),
          ];
        }}
        aria={`${W.trajTitle}: ${fmt(nowVal)} ${W.unit} by ${W.stepWord} ${day}${targeted ? ` against ${fmt(planToday)} target` : ""}`} />
    </Card>
  );
}
