/* Unit trajectory (spec §4.2, adapted: unified secured-units currency, docs §6.4;
 * reference grammar per BENCHMARK_SPEC 1, 2 and 7).
 * Cumulative secured units (sales + 0.8 × unconverted entries) vs plan per group; the forward projection follows the
 * channel's historic shape curve (paid: projected spend ÷ projected efficiency) -
 * per-day values computed in the ETL (docs §5.4).
 * Real-data bridge: daily[] arrays start at private-room open, so the series is
 * sliced to the campaign window (windowStart .. windowEnd = of+1 points, index = day).
 *
 * The two horizons want two different pictures of the same three curves, and drawing
 * both at once turns the chart into a thicket, so only one set of reference marks is
 * ever on the canvas. Today the question is "where should we be by now", which is a
 * reading taken at a single x: the target and the benchmark become short ticks sitting
 * on the today line, and the curves ahead of today fade because they are not part of
 * that reading yet. At close the question is "where does this land", which is a pair of
 * levels: both references stretch across the chart and the gap between them is the
 * stretch the business has taken on. The benchmark series is the basket's own pace
 * (daily[].bm), summed across groups for "all" exactly as the plan is, so the two
 * curves are always built the same way. */
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtSigned } from "../ui.jsx";

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
  const yTopV = Math.max(s.target, s.proj, s.now, hasBm ? s.bm : 0, 1) * 1.02;
  const x = (i) => (i / N) * X1;
  const y = (v) => Y0 - (Math.max(0, v) / yTopV) * (Y0 - YTOP);
  const pctTop = (yy) => ((yy / Y0) * 100).toFixed(2) + "%";

  const todayIdx = Math.min(day, N);
  const todayFrac = todayIdx / N;
  const nowVal = s.pts[todayIdx]?.actual ?? s.now;

  // paths. Today cuts the plan and benchmark curves at today so the half that has not
  // happened yet can drop back; at close both run the full width.
  const planFull = pathOf(s.pts, (p) => p.plan, 0, N, x, y);
  const planPast = pathOf(s.pts, (p) => p.plan, 0, todayIdx, x, y);
  const planFuture = pathOf(s.pts, (p) => p.plan, todayIdx, N, x, y);
  const bmFull = hasBm ? pathOf(s.pts, (p) => p.bm, 0, N, x, y) : "";
  const bmPast = hasBm ? pathOf(s.pts, (p) => p.bm, 0, todayIdx, x, y) : "";
  const bmFuture = hasBm ? pathOf(s.pts, (p) => p.bm, todayIdx, N, x, y) : "";

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

  // the two readings taken on the today line
  const targetToday = s.pts[todayIdx]?.plan ?? s.exp;
  const bmTodayPt = s.pts[todayIdx]?.bm;
  const bmToday = hasBm ? (bmTodayPt !== null && bmTodayPt !== undefined ? bmTodayPt : s.bmExp) : null;
  const showToday = targeted && !close;
  const showClose = targeted && close;
  const stretch = hasBm ? s.target - s.bm : null;
  // a bracket needs room between the two levels or it reads as a smudge
  const bracketDy = hasBm ? y(s.bm) - y(s.target) : 0;
  const showBracket = showClose && hasBm && bracketDy > 18;
  // near the close the today line has no room on its right, so the readings flip side
  const flipToday = todayFrac > 0.78;

  const projPct = targeted && s.target > 0 ? Math.round((s.proj / s.target) * 100) : null;
  // axis: % of target when there is one, secured units when there is not
  const axisTop = targeted ? s.target : yTopV / 1.02;
  const axisLabelTop = targeted ? "100%" : fmt(axisTop);
  const axisLabelMid = targeted ? "50%" : axisTop >= 2 ? fmt(axisTop / 2) : "";
  const pctColor = projPct !== null && projPct >= 100 ? C.ink : C.red;
  const nowTip =
    fmt(s.now) + " units secured to date · " + fmt(targetToday) + " target by day " + day +
    (bmToday !== null && bmToday !== undefined ? " · " + fmt(bmToday) + " benchmark" : "");
  const projTip = complete
    ? fmt(s.now) + " units at close" + (projPct !== null ? " · " + projPct + "% of target" : "")
    : "Projected " + fmt(s.proj) + " at close" + (projPct !== null ? " · " + projPct + "% of target" : "") +
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
  // a reading on the today line: a 12x2 mark in the reference colour, label alongside
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

  /* The three today readings share one x, so two close values print on top of
   * each other. Spread the LABELS only; every tick and the today dot stay on
   * the true value. The gap is set in real pixels off the measured plot, so it
   * holds whatever width the card is given. */
  const gapY = plotH > 0 ? (LABEL_GAP_PX / plotH) * Y0 : Y0 * 0.1;
  const readings = spreadLabels([
    ...(showToday && hasBm && bmToday !== null && bmToday !== undefined
      ? [{ key: "bm", y: y(bmToday), color: C.refBm, weight: 500,
           text: `benchmark ${fmt(bmToday)}` }] : []),
    ...(showToday
      ? [{ key: "target", y: y(targetToday), color: C.refTarget, weight: 500,
           text: `target ${fmt(targetToday)}` },
         { key: "now", y: y(nowVal), color: C.refTarget, weight: 600,
           text: `${fmt(nowVal)} ${fmtSigned(nowVal - targetToday)}` }] : []),
  ], gapY, YTOP, Y0 - 2);

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
              {showToday ? (
                <>
                  {planPast && (
                    <path d={planPast} fill="none" stroke={C.planGrey} strokeWidth="2"
                      strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                  {planFuture && (
                    <path d={planFuture} fill="none" stroke={C.planGrey} strokeWidth="2" opacity="0.35"
                      strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                  {bmPast && (
                    <path d={bmPast} fill="none" stroke={C.refBm} strokeWidth="1.5" opacity="0.45"
                      strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                  {bmFuture && (
                    <path d={bmFuture} fill="none" stroke={C.refBm} strokeWidth="1.5" opacity="0.35"
                      strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                </>
              ) : (
                <>
                  {planFull && (
                    <path d={planFull} fill="none" stroke={C.planGrey} strokeWidth="2"
                      strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
                  )}
                  {bmFull && (
                    <path d={bmFull} fill="none" stroke={C.refBm} strokeWidth="1.5" opacity="0.45"
                      strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
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
              {/* at close both references are levels, drawn as the same 2px mark in two
                  colours; the benchmark goes down first so the target survives a tie */}
              {showClose && hasBm && (
                <line x1="0" y1={y(s.bm).toFixed(1)} x2={X1} y2={y(s.bm).toFixed(1)}
                  stroke={C.refBm} strokeWidth="2" vectorEffect="non-scaling-stroke" />
              )}
              {showClose && (
                <line x1="0" y1={y(s.target).toFixed(1)} x2={X1} y2={y(s.target).toFixed(1)}
                  stroke={C.refTarget} strokeWidth="2" vectorEffect="non-scaling-stroke" />
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
                    {hp.plan !== null && hp.plan !== undefined && (
                      <div className="t-row"><span>Target</span><span className="v">{fmt(hp.plan)}</span></div>
                    )}
                    {hasBm && hp.bm !== null && hp.bm !== undefined && (
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
                {hasBm && bmToday !== null && bmToday !== undefined && (
                  <div style={readTick(bmToday, C.refBm)} />
                )}
                <div style={readTick(targetToday, C.refTarget)} />
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

            {/* At close: the two levels are named where they sit, and the bracket between
                them is the stretch the business has taken on above the basket. */}
            {showClose && (
              <div
                style={{
                  position: "absolute", left: 8, top: pctTop(y(s.target)), transform: "translateY(-145%)",
                  paddingRight: 6, background: "#fff", fontSize: 12, fontWeight: 500,
                  color: C.refTarget, whiteSpace: "nowrap",
                }}
              >
                target {fmt(s.target)}
              </div>
            )}
            {showClose && hasBm && (
              <div
                style={{
                  position: "absolute", left: 8, top: pctTop(y(s.bm)), transform: "translateY(45%)",
                  paddingRight: 6, background: "#fff", fontSize: 12, fontWeight: 500,
                  color: C.refBm, whiteSpace: "nowrap",
                }}
              >
                benchmark {fmt(s.bm)}
              </div>
            )}
            {showBracket && (
              <div
                style={{
                  position: "absolute", left: 10, top: pctTop(y(s.target)),
                  height: `${((bracketDy / Y0) * 100).toFixed(2)}%`, width: 5,
                  borderLeft: `1px solid ${C.planGrey}`,
                  borderTop: `1px solid ${C.planGrey}`,
                  borderBottom: `1px solid ${C.planGrey}`,
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute", left: "100%", top: "50%", transform: "translateY(-50%)",
                    paddingLeft: 5, fontSize: 11, color: C.muted, whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  stretch {fmtSigned(stretch)}
                </div>
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
