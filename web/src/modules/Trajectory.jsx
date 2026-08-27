/* Unit trajectory (spec §4.2, adapted: unified secured-units currency, docs §6.4).
 * Cumulative secured units (sales + 0.8 × unconverted entries) vs plan per group; the forward projection follows the
 * channel's historic shape curve (paid: projected spend ÷ projected efficiency) —
 * per-day values computed in the ETL (docs §5.4).
 * Real-data bridge: daily[] arrays start at private-room open, so the series is
 * sliced to the campaign window (windowStart .. windowEnd = of+1 points, index = day). */
import React, { useMemo, useState } from "react";
import { Card, GROUP_DOTS, C, fmt } from "../ui.jsx";

const X1 = 680, Y0 = 148, YTOP = 8;

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
        target: c.target ?? 0, pts: slicePts(c.daily, snap.windowStart, of),
      };
    }
  }
  // 'all' = element-wise sum of every group's daily series (and summed targets),
  // so this view cannot diverge from the channels module.
  const sliced = channels.map((c) => slicePts(c.daily, snap.windowStart, of));
  const n = sliced.reduce((m, s) => Math.max(m, s.length), 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let a = null, p = null, pr = null;
    for (const s of sliced) {
      const d = s[i];
      if (!d) continue;
      if (d.actual !== null && d.actual !== undefined) a = (a ?? 0) + d.actual;
      if (d.plan !== null && d.plan !== undefined) p = (p ?? 0) + d.plan;
      // shaped forward path: only meaningful once every group projects (future days)
      if (d.proj !== null && d.proj !== undefined) pr = (pr ?? 0) + d.proj;
    }
    pts.push({ actual: a, plan: p, proj: pr });
  }
  const sum = (f) => channels.reduce((t, c) => t + (c[f] ?? 0), 0);
  return { now: sum("now"), exp: sum("exp"), proj: sum("proj"), target: sum("target"), pts };
}

export default function Trajectory({ snap }) {
  const [sel, setSel] = useState("all");
  const channels = snap.channels || [];
  const of = snap.of || 1;
  const day = Math.max(0, Math.min(snap.day ?? 0, of));
  const complete = !!snap.complete;

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
      <Card dot={GROUP_DOTS.volume} title="Unit trajectory" right={right}>
        <div className="empty-state">No daily series yet.</div>
      </Card>
    );
  }

  const N = Math.max(1, s.pts.length - 1);
  const yTopV = Math.max(s.target, s.proj, s.now, 1) * 1.02;
  const x = (i) => (i / N) * X1;
  const y = (v) => Y0 - (Math.max(0, v) / yTopV) * (Y0 - YTOP);
  const pctTop = (yy) => ((yy / Y0) * 100).toFixed(2) + "%";

  const todayIdx = Math.min(day, N);
  const todayFrac = todayIdx / N;
  const nowVal = s.pts[todayIdx]?.actual ?? s.now;

  // paths
  const planPath = s.pts
    .map((p, i) => (p.plan === null || p.plan === undefined ? null : { i, v: p.plan }))
    .filter(Boolean)
    .map((p, k) => (k ? "L" : "M") + x(p.i).toFixed(1) + "," + y(p.v).toFixed(1))
    .join(" ");

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
  const showProjSeg = !complete && day < of;
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

  const projPct = s.target > 0 ? Math.round((s.proj / s.target) * 100) : null;
  const pctColor = projPct !== null && projPct >= 100 ? C.ink : C.red;
  const nowTip =
    fmt(s.now) + " units secured to date · " + fmt(s.exp) + " expected by day " + day;
  const projTip = complete
    ? fmt(s.now) + " units at close" + (projPct !== null ? " · " + projPct + "% of target" : "")
    : "Projected " + fmt(s.proj) + " at close" + (projPct !== null ? " · " + projPct + "% of target" : "") +
      (sel === "all" && projPct !== null && projPct > 100
        ? " · demand beyond the sellout cannot convert" : "");
  const showTodayLabel = !complete && todayFrac >= 0.08 && todayFrac <= 0.92;

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };

  return (
    <Card dot={GROUP_DOTS.volume} title="Unit trajectory" right={right}>
      <div className="spacer-16" />
      <div className="body">
        <div style={{ position: "relative", flex: 1 }}>
          <div style={{ position: "absolute", left: 40, right: 48, top: 0, bottom: 24 }}>
            <svg
              viewBox={`0 0 ${X1} ${Y0}`}
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
            >
              <line x1="0" y1={y(s.target / 2).toFixed(1)} x2={X1} y2={y(s.target / 2).toFixed(1)}
                stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={Y0} x2={X1} y2={Y0}
                stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {!complete && (
                <line x1={x(todayIdx).toFixed(1)} y1="0" x2={x(todayIdx).toFixed(1)} y2={Y0}
                  stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
              {planPath && (
                <path d={planPath} fill="none" stroke={C.planGrey} strokeWidth="2"
                  strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
              )}
              {projPath && (
                <path d={projPath} fill="none" stroke={C.orangeLight} strokeWidth="2.4"
                  strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {actPath && (
                <path d={actPath} fill="none" stroke={C.orange} strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              <line x1="0" y1={y(s.target).toFixed(1)} x2={X1} y2={y(s.target).toFixed(1)}
                stroke={C.targetLine} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>

            {/* today dot */}
            <div
              title={nowTip}
              style={{
                position: "absolute", left: `${(todayFrac * 100).toFixed(2)}%`, top: pctTop(y(nowVal)),
                width: 9, height: 9, margin: "-4.5px 0 0 -4.5px", borderRadius: "50%", background: C.orange,
              }}
            />
            {/* projection end dot (white-cored); on complete releases projection = actual,
                so the today dot already sits at the close and only the % label remains */}
            {!complete && (
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
            <div style={{ ...axisLabel, top: pctTop(y(s.target)) }}>100%</div>
            <div style={{ ...axisLabel, top: pctTop(y(s.target / 2)) }}>50%</div>
            <div style={{ ...axisLabel, top: "100%" }}>0</div>

            {/* target line label */}
            <div
              style={{
                position: "absolute", left: 8, top: pctTop(y(s.target)), transform: "translateY(-145%)",
                paddingRight: 6, background: "#fff", fontSize: 12, fontWeight: 500,
                color: C.muted, whiteSpace: "nowrap",
              }}
            >
              target {fmt(s.target)}
            </div>

            {/* x axis */}
            <div style={{ ...xLabel, left: 0 }}>day 1</div>
            {showTodayLabel && (
              <div style={{ ...xLabel, left: `${(todayFrac * 100).toFixed(2)}%`, transform: "translateX(-50%)", color: C.ink }}>
                today
              </div>
            )}
            <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }}>day {of}</div>
          </div>
        </div>
      </div>
    </Card>
  );
}
