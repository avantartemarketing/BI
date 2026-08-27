/* Paid ROI (spec §4.6) — wide 2-col card.
 * Daily spend bars (own axis, bottom band) + actual ROI line + modelled decline
 * dotted from today's L3D ROI to close: roi(i) = roiDeclineModel.start × dailyFactor^i.
 * Real-data bridges: paid.daily starts at private-room open, so points are mapped to
 * campaign day via date − windowStart and clipped to day 1..of; roi is null on
 * zero-entry days — the line connects across the gaps (null points skipped);
 * the y-domain (series ∪ target ± 12%, snapped to 0.25) is clamped at 0 since a
 * negative ROI axis is meaningless; complete releases draw actuals only. */
import React, { useState } from "react";
import { Card, QBadge, GROUP_DOTS, C, fmt } from "../ui.jsx";

const W = 480, H = 200, BAND_TOP = 132;
const DAY_MS = 86400000;

function dayIndex(dateStr, windowStart, fallback) {
  if (windowStart) {
    const t = Date.parse(dateStr), t0 = Date.parse(windowStart);
    if (!Number.isNaN(t) && !Number.isNaN(t0)) return Math.round((t - t0) / DAY_MS);
  }
  return fallback;
}

export default function PaidRoi({ snap }) {
  const [hover, setHover] = useState(null);   // day number
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const complete = !!snap.complete;
  const of = snap.of || 1;
  const DAYS = Math.max(1, of - 1);
  const today = Math.max(1, Math.min(snap.day ?? 0, of));

  const hasSpend =
    (paid.spendToDate ?? 0) > 0 || daily.some((d) => (d.spend ?? 0) > 0);

  if (!hasSpend) {
    return (
      <Card wide dot={GROUP_DOTS.paid} title="Paid ROI">
        <div className="empty-state">No paid spend yet.</div>
      </Card>
    );
  }

  // ----- series mapped onto campaign days 1..of -----
  const n = daily.length;
  const pts = daily
    .map((d, i) => ({
      d: dayIndex(d.date, snap.windowStart, (snap.day ?? 0) - (n - 1 - i)),
      spend: d.spend ?? 0,
      roi: d.roi ?? null,
    }))
    .filter((p) => p.d >= 1 && p.d <= of);

  const roiPts = pts.filter((p) => p.roi !== null);
  const last24 = roiPts.length ? roiPts[roiPts.length - 1].roi : null;

  // modelled decline from today's L3D ROI to close
  const model = paid.roiDeclineModel || {};
  const declStart = model.start ?? null;
  const factor = model.dailyFactor ?? null;
  const showModel = !complete && declStart !== null && factor !== null && today <= of;
  const decline = showModel
    ? Array.from({ length: of - today + 1 }, (_, i) => ({
        d: today + i,
        v: declStart * Math.pow(factor, i),
      }))
    : [];
  const declineEnd = decline.length ? decline[decline.length - 1].v : null;
  const finalVal = paid.budget?.finalDayRoi ?? declineEnd;

  // ----- ROI y-domain: series ∪ target ± 12%, snapped to 0.25, clamped at 0 -----
  const domVals = [
    ...roiPts.map((p) => p.roi),
    ...decline.map((p) => p.v),
    ...(paid.roiTarget !== null && paid.roiTarget !== undefined ? [paid.roiTarget] : []),
  ];
  let lo = 0, hi = 1;
  if (domVals.length) {
    const lo2 = Math.min(...domVals), hi2 = Math.max(...domVals);
    const pad = (hi2 - lo2) * 0.12 || Math.abs(hi2) * 0.12 || 0.5;
    lo = Math.max(0, Math.floor((lo2 - pad) / 0.25) * 0.25);
    hi = Math.ceil((hi2 + pad) / 0.25) * 0.25;
    if (hi <= lo) hi = lo + 1;
  }
  const x = (d) => ((d - 1) / DAYS) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const leftPct = (d) => ((x(d) / W) * 100).toFixed(2) + "%";
  const topPct = (v) => ((y(v) / H) * 100).toFixed(2) + "%";

  const path = (arr, val) =>
    arr.map((p, k) => (k ? "L" : "M") + x(p.d).toFixed(1) + "," + y(val(p)).toFixed(1)).join(" ");
  const actualPath = roiPts.length >= 2 ? path(roiPts, (p) => p.roi) : "";
  const declinePath = decline.length >= 2 ? path(decline, (p) => p.v) : "";

  // ----- spend bars: own axis 0..ceil(max/100)*100 in the bottom band -----
  const spendPts = pts.filter((p) => p.spend > 0);
  const spendHi = Math.max(100, Math.ceil(Math.max(0, ...spendPts.map((p) => p.spend)) / 100) * 100);
  const step = W / DAYS;
  const bw = step * 0.52;
  const bars = spendPts.map((p) => {
    const h = (p.spend / spendHi) * (H - BAND_TOP);
    return {
      d: p.d,
      x: Math.min(Math.max(x(p.d) - bw / 2, 0), W - bw).toFixed(1),
      y: (H - h).toFixed(1),
      h: h.toFixed(1),
      tip: "Day " + p.d + " spend £" + fmt(p.spend),
    };
  });

  // ----- lead + header stats -----
  const leadVal = complete ? paid.cumRoi : paid.l3dRoi;
  const leadCaption = complete ? "ROI final" : "ROI last 3 days";
  const moreTip =
    "ROI total " + fmt(paid.cumRoi, 2) +
    (paid.l3dCpe !== null && paid.l3dCpe !== undefined ? "\n£/entry L3D " + fmt(paid.l3dCpe, 2) : "") +
    (paid.cumCpe !== null && paid.cumCpe !== undefined ? "\n£/entry total " + fmt(paid.cumCpe, 2) : "");
  const todayTip =
    "ROI last 3 days " + fmt(paid.l3dRoi, 2) +
    "\nLast 24h " + fmt(last24, 2) +
    "\nTarget " + fmt(paid.roiTarget, 2);
  const projTip = "Projected ROI at close " + fmt(finalVal, 2) + "\nTarget " + fmt(paid.roiTarget, 2);
  const finalTip = "ROI final " + fmt(paid.cumRoi, 2) + "\nTarget " + fmt(paid.roiTarget, 2);

  const statVal = { fontSize: 13, fontWeight: 600, color: C.ink };
  const right = (
    <div style={{ display: "flex", gap: 20, alignItems: "baseline" }}>
      <span
        title="Cumulative profit-based ROI: profit attributed to paid entries ÷ total spend, whole campaign"
        style={{ display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" }}
      >
        ROI total <span className="num" style={statVal}>{fmt(paid.cumRoi, 2)}</span>
      </span>
      <span
        title="Cumulative cost per draw entry across the whole campaign"
        style={{ display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" }}
      >
        £/entry total <span className="num" style={statVal}>{fmt(paid.cumCpe, 2)}</span>
      </span>
    </div>
  );

  const todayFrac = (today - 1) / DAYS;
  const showTodayLabel = !complete && todayFrac >= 0.06 && todayFrac <= 0.94;
  const lastRoiPt = roiPts.length ? roiPts[roiPts.length - 1] : null;

  const byDay = new Map(pts.map((p) => [p.d, p]));
  const dateByDay = new Map(daily.map((d2, i) => [dayIndex(d2.date, snap.windowStart, (snap.day ?? 0) - (n - 1 - i)), d2.date]));
  const declByDay = new Map(decline.map((p) => [p.d, p.v]));

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };

  return (
    <Card wide dot={GROUP_DOTS.paid} title="Paid ROI" right={right}>
      <div className="spacer-8" />
      <div className="lead">{fmt(leadVal, 2)}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, flex: "0 0 auto" }}>
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{leadCaption}</span>
        <QBadge tip={moreTip} />
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      <div className="body">
        <div style={{ position: "relative", flex: 1 }}>
          <div
            style={{ position: "absolute", left: 48, right: 56, top: 0, bottom: 24 }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
              setHover(Math.min(Math.max(Math.round(frac * DAYS) + 1, 1), of));
            }}
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
            >
              <line x1="0" y1={H} x2={W} y2={H} stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {bars.map((b) => (
                <rect key={b.d} x={b.x} y={b.y} width={bw.toFixed(1)} height={b.h} rx="1" fill={C.track}>
                  <title>{b.tip}</title>
                </rect>
              ))}
              {declinePath && (
                <path d={declinePath} fill="none" stroke={C.orangeLight} strokeWidth="2.6"
                  strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {actualPath && (
                <path d={actualPath} fill="none" stroke={C.orange} strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {!complete && (
                <line x1={x(today).toFixed(1)} y1="0" x2={x(today).toFixed(1)} y2={H}
                  stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {/* hover: guide line + marker + light popup */}
            {hover !== null && (() => {
              const p = byDay.get(hover);
              const projV = declByDay.get(hover);
              const roiV = p && p.roi !== null && p.roi !== undefined ? p.roi : null;
              const markV = roiV ?? projV ?? null;
              const flip = (hover - 1) / DAYS > 0.6;
              const dt = dateByDay.get(hover);
              if (!p && projV === undefined) return null;
              return (
                <>
                  <div style={{ position: "absolute", left: leftPct(hover), top: 0, bottom: 0, width: 1, background: "#ddd9cf", pointerEvents: "none" }} />
                  {markV !== null && markV !== undefined && (
                    <div style={{ position: "absolute", left: leftPct(hover), top: topPct(markV), width: 7, height: 7, margin: "-3.5px 0 0 -3.5px", borderRadius: "50%", background: roiV !== null ? C.orange : C.orangeLight, boxShadow: "0 0 0 2px #fff", pointerEvents: "none" }} />
                  )}
                  <div className="chart-tip" style={{ left: leftPct(hover), top: 4, transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
                    <div className="t-head">Day {hover}{dt ? " · " + dt : ""}</div>
                    {roiV !== null && <div className="t-row"><span>ROI</span><span className="v">{fmt(roiV, 2)}</span></div>}
                    {roiV === null && projV !== undefined && <div className="t-row"><span>ROI projected</span><span className="v">{fmt(projV, 2)}</span></div>}
                    {p && <div className="t-row"><span>Spend</span><span className="v">£{fmt(p.spend, 2)}</span></div>}
                    {p && <div className="t-row"><span>Entries</span><span className="v">{fmt(p.entries ?? 0)}</span></div>}
                  </div>
                </>
              );
            })()}

            {/* today dot on the modelled level (L3D ROI) */}
            {!complete && declStart !== null && (
              <div
                title={todayTip}
                style={{
                  position: "absolute", left: leftPct(today), top: topPct(declStart),
                  width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                  background: C.orange, boxShadow: "0 0 0 2px #fff",
                }}
              />
            )}
            {/* complete: end dot on the last actual ROI point */}
            {complete && lastRoiPt && (
              <div
                title={finalTip}
                style={{
                  position: "absolute", left: leftPct(lastRoiPt.d), top: topPct(lastRoiPt.roi),
                  width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                  background: C.orange, boxShadow: "0 0 0 2px #fff",
                }}
              />
            )}
            {/* projection end dot (white-cored) + label */}
            {showModel && declineEnd !== null && (
              <>
                <div
                  title={projTip}
                  style={{
                    position: "absolute", left: "100%", top: topPct(declineEnd),
                    width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                    background: "#fff", border: `2.2px solid ${C.orangeLight}`, boxSizing: "border-box",
                  }}
                />
                <div
                  style={{
                    position: "absolute", left: "100%", top: topPct(declineEnd),
                    transform: "translateY(-50%)", paddingLeft: 10,
                    fontSize: 12, color: C.muted, whiteSpace: "nowrap",
                  }}
                >
                  projected
                </div>
              </>
            )}

            {/* y axis (snapped to 0.25) */}
            <div style={{ ...axisLabel, top: 0 }}>{hi.toFixed(2)}</div>
            <div style={{ ...axisLabel, top: "100%" }}>{lo.toFixed(2)}</div>

            {/* x axis */}
            <div style={{ ...xLabel, left: 0 }}>day 1</div>
            {showTodayLabel && (
              <div style={{ ...xLabel, left: leftPct(today), transform: "translateX(-50%)", color: C.ink }}>
                today
              </div>
            )}
            <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }}>day {of}</div>

            {/* spend band caption */}
            <div
              title={"Daily spend bars on their own axis: £0 to £" + fmt(spendHi)}
              style={{ position: "absolute", right: "2%", top: "82%", fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}
            >
              daily spend
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
