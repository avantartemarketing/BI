/* Unit trajectory (spec §4.2, adapted: unified secured-units currency, docs §6.4;
 * reference grammar per BENCHMARK_SPEC 7).
 * Cumulative secured units (sales + 0.8 × unconverted entries) vs plan per group; the forward projection follows the
 * channel's historic shape curve (paid: projected spend ÷ projected efficiency) -
 * per-day values computed in the ETL (docs §5.4).
 * Real-data bridge: daily[] arrays start at private-room open, so the series is
 * sliced to the campaign window (windowStart .. windowEnd = of+1 points, index = day).
 *
 * One reference curve, not two, because the page toggle has already said which one
 * the reader is asking about: the plan's own pace, or the basket's (daily[].bm,
 * summed across groups for "all" exactly as the plan is, so the two are always
 * built the same way). It is drawn as a tinted area rather than a line - the same
 * grammar as every bar on the page, the reference behind and the actual in front -
 * which also takes a curve off a chart that had three of them.
 *
 * The two horizons still want two pictures. Today the question is "where should we
 * be by now", a reading taken at a single x: the reference becomes a short tick on
 * the today line and the area ahead of today fades, because it has not happened
 * yet. At close the question is "where does this land", a level: the area runs the
 * full width and its right-hand end is named. */
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtSigned, useRefMode, refWord, otherWord } from "../ui.jsx";

const X1 = 680, Y0 = 148, YTOP = 8;
const LABEL_GAP_PX = 15;   // smallest vertical gap two 12px labels can sit at
const LABEL_TODAY_PX = 38; // rendered width of "today" at 12px
const LABEL_DAY_PX = 46;   // rendered width of "day 21" at 12px

/* Lay a set of readings out down one line without letting any two labels touch.
 * Each item keeps its true position `y` (the tick and the dot stay on the real
 * value, which is what makes the moved label honest) and gains `ly`, where its
 * text goes: sorted top to bottom, pushed apart to `gap`, then squeezed back
 * inside [lo, hi] from whichever end overflowed. Three readings on a 1,200-unit
 * axis can be 56 units apart, which is four pixels, so without this the target
 * and the actual simply print over each other. */
function spreadLabels(items, gap, lo, hi) {
  const out = items.slice().sort((a, b) => a.y - b.y).map((d) => ({ ...d, ly: d.y }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].ly - out[i - 1].ly < gap) out[i].ly = out[i - 1].ly + gap;
  }
  const last = out.length - 1;
  if (last >= 0 && out[last].ly > hi) {
    out[last].ly = hi;
    for (let i = last - 1; i >= 0; i--) out[i].ly = Math.min(out[i].ly, out[i + 1].ly - gap);
  }
  if (out.length && out[0].ly < lo) {
    out[0].ly = lo;
    for (let i = 1; i < out.length; i++) out[i].ly = Math.max(out[i].ly, out[i - 1].ly + gap);
  }
  return out;
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
function areaOf(pts, get, from, to, x, y) {
  const line = [];
  let x0 = null, x1 = null;
  for (let i = Math.max(0, from); i <= to && i < pts.length; i++) {
    const v = get(pts[i]);
    if (v === null || v === undefined) continue;
    if (x0 === null) x0 = x(i);
    x1 = x(i);
    line.push((line.length ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1));
  }
  if (line.length < 2) return "";
  return line.join(" ") + ` L${x1.toFixed(1)},${Y0} L${x0.toFixed(1)},${Y0} Z`;
}

export default function Trajectory({ snap, horizon = "today" }) {
  const mode = useRefMode();
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
  const bmMode = mode === "benchmark" && hasBm;
  // the one reference this chart draws, series and close level alike
  const refAt = (p) => (bmMode ? p.bm : p.plan);
  const refClose = bmMode ? s.bm : s.target;
  const otherClose = bmMode ? s.target : hasBm ? s.bm : null;
  const refLabel = refWord(bmMode ? "benchmark" : "target", close ? "close" : "today");
  const otherLabel = otherWord(bmMode ? "benchmark" : "target", close ? "close" : "today");
  const yTopV = Math.max(s.target, s.proj, s.now, hasBm ? s.bm : 0, 1) * 1.02;
  const x = (i) => (i / N) * X1;
  const y = (v) => Y0 - (Math.max(0, v) / yTopV) * (Y0 - YTOP);
  const pctTop = (yy) => ((yy / Y0) * 100).toFixed(2) + "%";

  const todayIdx = Math.min(day, N);
  const todayFrac = todayIdx / N;
  const nowVal = s.pts[todayIdx]?.actual ?? s.now;

  // paths. Today cuts the reference at today so the half that has not happened
  // yet can drop back; at close it runs the full width.
  const refFull = pathOf(s.pts, refAt, 0, N, x, y);
  const refPast = pathOf(s.pts, refAt, 0, todayIdx, x, y);
  const refFuture = pathOf(s.pts, refAt, todayIdx, N, x, y);
  const areaFull = areaOf(s.pts, refAt, 0, N, x, y);
  const areaPast = areaOf(s.pts, refAt, 0, todayIdx, x, y);
  const areaFuture = areaOf(s.pts, refAt, todayIdx, N, x, y);

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
  const refToday = bmMode ? bmToday : planToday;
  const otherToday = bmMode ? planToday : bmToday;
  const showToday = targeted && !close;
  const showClose = targeted && close;
  // near the close the today line has no room on its right, so the readings flip side
  const flipToday = todayFrac > 0.78;

  const projPct = targeted && refClose > 0 ? Math.round((s.proj / refClose) * 100) : null;
  // axis: % of the chosen reference when there is one, secured units when there is not
  const axisTop = targeted ? refClose : yTopV / 1.02;
  const axisLabelTop = targeted ? "100%" : fmt(axisTop);
  const axisLabelMid = targeted ? "50%" : axisTop >= 2 ? fmt(axisTop / 2) : "";
  const pctColor = projPct !== null && projPct >= 100 ? C.ink : C.red;
  const nowTip =
    fmt(s.now) + " units secured to date · " + fmt(planToday) + " target by day " + day +
    (bmToday !== null && bmToday !== undefined ? " · " + fmt(bmToday) + " benchmark" : "");
  const refLower = refLabel.toLowerCase();
  // the today line and the close level are already labelled as such, so the
  // reading beside them is just the word - "benchmark today 805" on the today
  // line is the same thing said twice, and it is the longest label on the chart
  const refShort = bmMode ? "benchmark" : "target";
  const projTip = complete
    ? fmt(s.now) + " units at close" + (projPct !== null ? " · " + projPct + "% of " + refLower : "")
    : "Projected " + fmt(s.proj) + " at close" + (projPct !== null ? " · " + projPct + "% of " + refLower : "") +
      (sel === "all" && projPct !== null && projPct > 100
        ? " · demand beyond the sellout cannot convert" : "");
  const showTodayLabel = !complete && todayFrac >= 0.08 && todayFrac <= 0.92;
  /* "today" is centred on its line and "day N" is pinned to the right edge, so
   * on a release in its last days the two overprint. How close is too close is
   * a pixel question, not a fraction one - the card is two columns wide now and
   * the same fraction buys twice the room - so it is measured: half of "today"
   * plus "day N" plus a gap, against the pixels actually left. The close label
   * is the one to drop, since the axis already ends there and today is the
   * reading that matters. The fraction is the fallback before the first
   * measurement lands. */
  const endLabelRoom = plotW > 0
    ? (1 - todayFrac) * plotW - (LABEL_TODAY_PX / 2 + LABEL_DAY_PX + 10)
    : (todayFrac > 0.82 ? -1 : 1);
  const showEndLabel = !(showTodayLabel && endLabelRoom < 0);

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  // a reading on the today line: a 12x2 mark, label alongside
  const readTick = (v, color) => ({
    position: "absolute", left: `${(todayFrac * 100).toFixed(2)}%`, top: pctTop(y(v)),
    width: 12, height: 2, margin: "-1px 0 0 -6px", background: color,
  });
  // the label sits at `yy` (already spread), not necessarily on its own value
  const readLabel = (yy, color, weight = 500) => ({
    position: "absolute", left: `${(todayFrac * 100).toFixed(2)}%`, top: pctTop(yy),
    transform: flipToday ? "translate(-100%,-50%)" : "translateY(-50%)",
    [flipToday ? "paddingRight" : "paddingLeft"]: 10,
    fontSize: 12, fontWeight: weight, color, whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  });

  /* Both today readings share one x, so two close values print on top of each
   * other. Spread the LABELS only; the tick and the today dot stay on the true
   * value. The gap is set in real pixels off the measured plot, so it holds
   * whatever width the card is given. Dropping to one reference took a third
   * label off this line, which is most of what was crowding it. */
  const gapY = plotH > 0 ? (LABEL_GAP_PX / plotH) * Y0 : Y0 * 0.1;
  const readings = spreadLabels(
    showToday && refToday !== null && refToday !== undefined
      ? [{ key: "ref", y: y(refToday), color: C.muted, weight: 500,
           text: `${refShort} ${fmt(refToday)}` },
         { key: "now", y: y(nowVal), color: C.ink, weight: 600,
           text: `${fmt(nowVal)} ${fmtSigned(nowVal - refToday)}` }]
      : [],
    gapY, YTOP, Y0 - 2);

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
              {/* the reference as a tinted area with its own top edge - the same
                  grammar as every bar on the page, reference behind, actual in
                  front. Ahead of today it drops back, because it has not
                  happened yet. */}
              {showToday ? (
                <>
                  {areaFuture && <path d={areaFuture} fill={C.refFill} opacity="0.4" stroke="none" />}
                  {areaPast && <path d={areaPast} fill={C.refFill} stroke="none" />}
                  {refFuture && (
                    <path d={refFuture} fill="none" stroke={C.refMark} strokeWidth="1.5" opacity="0.4"
                      vectorEffect="non-scaling-stroke" />
                  )}
                  {refPast && (
                    <path d={refPast} fill="none" stroke={C.refMark} strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke" />
                  )}
                </>
              ) : (
                <>
                  {areaFull && <path d={areaFull} fill={C.refFill} stroke="none" />}
                  {refFull && (
                    <path d={refFull} fill="none" stroke={C.refMark} strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke" />
                  )}
                </>
              )}
              {projPath && (
                <path d={projPath} fill="none" stroke={C.orangeLight} strokeWidth="2.4"
                  strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {actPath && (
                <path d={actPath} fill="none" stroke={C.orange} strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {/* at close the reference is a level, so it is named as one right
                  across the chart rather than left to the area's right-hand end */}
              {showClose && refClose > 0 && (
                <line x1="0" y1={y(refClose).toFixed(1)} x2={X1} y2={y(refClose).toFixed(1)}
                  stroke={C.refMark} strokeWidth="2" vectorEffect="non-scaling-stroke" />
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
                    {refAt(hp) !== null && refAt(hp) !== undefined && (
                      <div className="t-row"><span>{refLabel}</span><span className="v">{fmt(refAt(hp))}</span></div>
                    )}
                    {hasBm && (bmMode ? hp.plan : hp.bm) !== null && (bmMode ? hp.plan : hp.bm) !== undefined && (
                      <div className="t-row"><span>{otherLabel}</span><span className="v">{fmt(bmMode ? hp.plan : hp.bm)}</span></div>
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
                {refToday !== null && refToday !== undefined && (
                  <div style={readTick(refToday, C.refMark)} />
                )}
                {readings.map((r) => (
                  <div key={r.key} style={readLabel(r.ly, r.color, r.weight)}>{r.text}</div>
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
            {showClose && refClose > 0 && (
              <div
                style={{
                  position: "absolute", left: 8, top: pctTop(y(refClose)), transform: "translateY(-145%)",
                  paddingRight: 6, background: "#fff", fontSize: 12, fontWeight: 500,
                  color: C.ink, whiteSpace: "nowrap",
                }}
              >
                {refShort} {fmt(refClose)}
                {otherClose !== null && otherClose !== undefined && (
                  <span style={{ fontWeight: 400, color: C.muted }}>
                    {"  ·  " + (bmMode ? "target" : "benchmark") + " " + fmt(otherClose)}
                  </span>
                )}
              </div>
            )}

            {/* x axis */}
            <div style={{ ...xLabel, left: 0 }}>day 1</div>
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
