/* A timed launch's paid chart (docs/TL_SPEC.md §4, §5): the Paid ROI card's
 * shape, in TL words. A timed launch's paid buys signups before the window
 * opens and sales inside it, and its products carry no profit split, so the
 * card reads the cost of what paid bought rather than a return: daily spend
 * bars on their own axis in the bottom band, the trailing three-day cost per
 * signup (or per sale, in the window) as the line, and the plan's cost - the
 * basket's median, or the figure typed on the Target setting tab - as the
 * reference line it is judged against. The headline is the last three full
 * days' cost; the totals beside it the whole period's cost and the paid
 * signups or units to date. Before the window the clock runs in days from
 * the announce, inside it in hours from the sales open, and a day's spend
 * then spans its hours. The words on the plot are set in clear space with a
 * leader to what they name, as the LE charts set theirs (labels.mjs). */
import React, { useState } from "react";
import {
  Card, QBadge, GROUP_DOTS, C, fmt, fmtMoney, dayLabel, dayAxisLabel, textPx, timeAxis, nameLines, useBoxSize, LineNames, ChartTip,
} from "../ui.jsx";
import { wordsOf, hourClock } from "../vocab.mjs";

const W = 480, H = 200, BAND_TOP = 132;
const DAY_MS = 86400000, HOUR_MS = 3600000;

export default function PaidCost({ snap }) {
  const [hover, setHover] = useState(null);   // a step of the clock
  const [plotRef, plotW, plotH] = useBoxSize();
  const V = wordsOf(snap);
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const complete = !!snap.complete;
  const hours = hourClock(snap);
  const of = Math.max(1, snap.of || 1);
  const today = Math.max(0, Math.min(snap.day ?? 0, of));
  const unitWord = paid.unit === "sale" ? "sale" : "signup";
  const hasSpend = (paid.spendToDate ?? 0) > 0 || daily.some((d) => (d.spend ?? 0) > 0);

  if (!hasSpend) {
    return (
      <Card wide dot={GROUP_DOTS.paid} title={V.paidTitle}>
        <div className="empty-state">
          {snap.campaignName ? "No paid spend yet." : "No Meta campaign matched to this launch - set one in Target setting."}
        </div>
      </Card>
    );
  }

  // ----- each day of spend on the clock: a day is a step before the window, 24 steps inside it -----
  const start = hours ? Date.parse(snap.clock.start) : Date.parse(snap.windowStart + "T00:00:00Z");
  const stepOf = (dateStr) => {
    const t = Date.parse(dateStr + "T00:00:00Z");
    if (!Number.isFinite(t) || !Number.isFinite(start)) return null;
    return hours ? (t - start) / HOUR_MS : Math.round((t - start) / DAY_MS);
  };
  const span = hours ? 24 : 1;   // the steps a day covers
  const pts = daily.map((d) => ({ ...d, s0: stepOf(d.date) })).filter((p) => p.s0 !== null && p.s0 + span > 0 && p.s0 <= of)
    .map((p) => ({ ...p, a: Math.max(p.s0, 0), b: Math.min(p.s0 + span, of), mid: (Math.max(p.s0, 0) + Math.min(p.s0 + span, of)) / 2 }));
  const costPts = pts.filter((p) => !p.partial && p.cost3 !== null && p.cost3 !== undefined);
  const lastCost = costPts.length ? costPts[costPts.length - 1] : null;
  const plan = paid.costPlan ?? null;
  const bm = paid.costBm ?? null;

  // ----- the cost axis: the line and the references, padded, from zero -----
  const domVals = [...costPts.map((p) => p.cost3), ...(plan !== null ? [plan] : []), ...(bm !== null ? [bm] : [])];
  let hi = 1;
  if (domVals.length) {
    const top = Math.max(...domVals);
    hi = Math.ceil((top * 1.15) / 0.5) * 0.5 || 1;
  }
  const x = (st) => (st / of) * W;
  const y = (v) => H - (Math.max(0, Math.min(v, hi)) / hi) * H;
  const leftPct = (st) => ((x(st) / W) * 100).toFixed(2) + "%";
  const topPct = (v) => ((y(v) / H) * 100).toFixed(2) + "%";
  const costPath = costPts.length >= 2 ? costPts.map((p, k) => (k ? "L" : "M") + x(p.mid).toFixed(1) + "," + y(p.cost3).toFixed(1)).join(" ") : "";

  // ----- the spend bars: their own axis in the bottom band -----
  const spendPts = pts.filter((p) => p.spend > 0);
  const spendHi = Math.max(100, Math.ceil(Math.max(0, ...spendPts.map((p) => p.spend)) / 100) * 100);
  const bars = spendPts.map((p) => {
    const h = (p.spend / spendHi) * (H - BAND_TOP);
    const w = Math.max(x(p.b) - x(p.a) - 2, 2);
    return { key: p.date, x: (x(p.a) + 1).toFixed(1), w: w.toFixed(1), y: (H - h).toFixed(1), h: h.toFixed(1), partial: p.partial, mid: p.mid,
      tip: `${p.date}: spend €${fmt(p.spend)}${p.partial ? " so far today" : ""}` };
  });

  // ----- the words -----
  const lead = complete ? paid.cumCost : paid.l3dCost;
  const leadCaption = complete ? `cost per ${unitWord}, the whole ${V.state === "signups" ? "pre-window" : "window"}` : `cost per ${unitWord}, last 3 full days`;
  const moreTip = {
    head: `Cost per ${unitWord} - how it is read`,
    rows: [
      { label: "Spend to date", value: fmtMoney(paid.spendToDate ?? 0, 0) },
      { label: `Paid ${V.unit} to date`, value: fmt(paid.unitsToDate ?? 0) },
      { label: `Cost per ${unitWord}, whole period`, value: paid.cumCost ? fmtMoney(paid.cumCost, 2) : "–" },
      { label: `Cost per ${unitWord}, last 3 full days`, value: paid.l3dCost ? fmtMoney(paid.l3dCost, 2) : "–" },
      { label: `Plan (${paid.costPlanSource === "release" ? "typed" : "the basket's median"})`, value: plan !== null ? fmtMoney(plan, 2) : "–" },
    ],
    body: V.state === "signups"
      ? "Meta's spend under the campaign code before the open, over the paid signups it bought on each day (the signups the feed attributes to paid, with untracked signups folded in at the tracked paid share). The line is the trailing three full days; the plan is the price the pre-window budget was set at."
      : "Meta's spend under the campaign code inside the window, over the paid units sold on each day. The line is the trailing three full days; the plan is the price the window budget was set at.",
  };
  const totals = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flex: "0 0 auto", fontSize: 12, color: C.muted }}>
      <span style={{ display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" }}>
        cost per {unitWord} total <span className="num" style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{paid.cumCost ? fmtMoney(paid.cumCost, 2) : "–"}</span>
      </span>
      <span style={{ display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" }}>
        paid {V.unit} <span className="num" style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{fmt(paid.unitsToDate ?? 0)}</span>
      </span>
    </div>
  );

  // ----- the axis and the names on the plot -----
  const todayFrac = today / of;
  const startText = dayAxisLabel(snap, 0), endText = dayAxisLabel(snap, of);
  const xAxis = timeAxis({ rowW: plotW, frac: todayFrac, live: !complete, startText, endText });
  let names = [];
  if (plotW > 0 && plotH > 0) {
    const sx = plotW / W, sy = plotH / H;
    const curves = [
      ...(costPts.length >= 2 ? [{ pts: costPts.map((p) => ({ x: x(p.mid) * sx, y: y(p.cost3) * sy })) }] : []),
      ...(plan !== null ? [{ pts: [{ x: 0, y: y(plan) * sy }, { x: plotW, y: y(plan) * sy }] }] : []),
      ...(!complete ? [{ pts: [{ x: x(today) * sx, y: 0 }, { x: x(today) * sx, y: plotH }] }] : []),
    ];
    const blocks = bars.map((b) => ({ x0: +b.x * sx, y0: +b.y * sy, x1: (+b.x + +b.w) * sx, y1: plotH }));
    const label = (key, text, title, anchors) => ({ key, text, title, anchors, color: C.muted, weight: 400, w: textPx(text), h: 14 });
    const standing = bars.filter((b) => !b.partial && +b.h * sy >= 3);
    const tops = (standing.length ? standing : bars).map((b) => ({ x: (+b.x + +b.w / 2) * sx, y: +b.y * sy, cost: 0 }));
    const labels = [
      ...(plan !== null ? [label("plan", `plan ${fmtMoney(plan, 2)}`, moreTip.rows[4].label, [{ x: plotW * 0.3, y: y(plan) * sy, cost: 0 }, { x: plotW * 0.7, y: y(plan) * sy, cost: 1 }])] : []),
      ...(tops.length ? [label("spend", "daily spend", `Daily spend bars on their own axis: €0 to €${fmt(spendHi)}`, tops)] : []),
    ];
    names = nameLines({ labels, curves, blocks, bounds: { x0: 0, y0: 0, x1: plotW, y1: plotH } });
  }
  const byStep = (st) => pts.find((p) => st >= p.a && st < p.b) || null;

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };

  return (
    <Card wide dot={GROUP_DOTS.paid} title={V.paidTitle}>
      <div className="spacer-8" />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flex: "0 0 auto" }}>
        <div className="lead">
          <span>{lead ? fmtMoney(lead, 2) : "–"}</span>
          <span style={{ fontSize: 12, fontWeight: 400, letterSpacing: 0, color: C.muted, whiteSpace: "nowrap" }}>{leadCaption}</span>
          <QBadge content={moreTip} />
        </div>
        {totals}
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      <div className="body">
        <div style={{ position: "relative", flex: 1 }}>
          <div
            ref={plotRef}
            style={{ position: "absolute", left: 56, right: 56, top: 0, bottom: 24 }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
              setHover(Math.min(Math.max(frac * of, 0), of));
            }}
            onMouseLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}>
              <line x1="0" y1={H} x2={W} y2={H} stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {bars.map((b) => (
                <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill={C.track}><title>{b.tip}</title></rect>
              ))}
              {plan !== null && (
                <line x1="0" y1={y(plan).toFixed(1)} x2={W} y2={y(plan).toFixed(1)} stroke={C.refLine} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              )}
              {bm !== null && plan !== null && Math.abs(bm - plan) > 0.005 && (
                <line x1="0" y1={y(bm).toFixed(1)} x2={W} y2={y(bm).toFixed(1)} stroke={C.refLine} strokeWidth="1.5" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
              )}
              {costPath && (
                <path d={costPath} fill="none" stroke={C.blue} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {!complete && (
                <line x1={x(today).toFixed(1)} y1="0" x2={x(today).toFixed(1)} y2={H} stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {hover !== null && (() => {
              const p = byStep(hover);
              if (!p) return null;
              const cost = !p.partial && p.cost3 !== null && p.cost3 !== undefined ? p.cost3 : null;
              return (
                <>
                  <div style={{ position: "absolute", left: leftPct(p.mid), top: 0, bottom: 0, width: 1, background: "#ddd9cf", pointerEvents: "none" }} />
                  {cost !== null && (
                    <div style={{ position: "absolute", left: leftPct(p.mid), top: topPct(cost), width: 7, height: 7, margin: "-3.5px 0 0 -3.5px", borderRadius: "50%", background: C.blue, boxShadow: "0 0 0 2px #fff", pointerEvents: "none" }} />
                  )}
                  <ChartTip left={leftPct(p.mid)}>
                    <div className="t-head">{hours ? p.date : dayLabel(snap, Math.round(p.mid), true)}{p.partial ? " · so far today" : ""}</div>
                    <div className="t-row"><span>Spend</span><span className="v">€{fmt(p.spend, 2)}</span></div>
                    <div className="t-row"><span>Paid {V.unit}</span><span className="v">{fmt(p.entries ?? 0)}</span></div>
                    <div className="t-row"><span>Cost per {unitWord} (3d)</span><span className="v">{cost !== null ? fmtMoney(cost, 2) : "–"}</span></div>
                    {p.cost1 !== null && p.cost1 !== undefined && <div className="t-row"><span>Cost per {unitWord}, the day</span><span className="v">{fmtMoney(p.cost1, 2)}</span></div>}
                  </ChartTip>
                </>
              );
            })()}

            {lastCost && (
              <div title={`Cost per ${unitWord}, last 3 full days: ${fmtMoney(lastCost.cost3, 2)}`}
                style={{ position: "absolute", left: leftPct(lastCost.mid), top: topPct(lastCost.cost3), width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%", background: C.blue, boxShadow: "0 0 0 2px #fff" }} />
            )}
            {costPts.length > 0 && <div style={{ ...axisLabel, top: 0 }}>€{fmt(hi, hi < 10 ? 1 : 0)}</div>}
            {costPts.length > 0 && <div style={{ ...axisLabel, top: "100%" }}>€0</div>}
            <LineNames names={names} />
            {xAxis.start && <div style={{ ...xLabel, left: 0 }} title={V.state === "signups" ? "the announce" : "the sales open"}>{startText}</div>}
            {!complete && (
              <div style={{ ...xLabel, color: C.ink, ...(xAxis.todayLeft === null ? { left: leftPct(today), transform: "translateX(-50%)" } : { left: xAxis.todayLeft }) }}>today</div>
            )}
            {xAxis.end && <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }} title={`the ${V.closeWord}`}>{endText}</div>}
          </div>
        </div>
      </div>
    </Card>
  );
}
