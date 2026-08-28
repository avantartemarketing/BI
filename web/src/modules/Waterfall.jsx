/* Projection vs target (spec §4.10) - horizontal waterfall.
 * Target and Projection are level ink anchor ticks (never floor-anchored
 * columns); the four contributor bars step between running levels with grey
 * 1px connector drops. x-scale = [min, max of running levels] ± 10% pad.
 * Projection is a stored model output - never re-derived here; on a complete
 * release it equals the actual close. */
import React from "react";
import { Card, GROUP_DOTS, C, QBadge, fmt, fmtSigned, useTip } from "../ui.jsx";

const STEP_TIPS = {
  organic_traffic: "Organic sessions vs plan",
  organic_conversion: "Session → sale vs benchmark",
  paid_spend: "Spend vs plan",
  paid_efficiency: "Entries per pound vs target",
};

export default function Waterfall({ snap }) {
  const tipApi = useTip();
  const wf = snap?.waterfall;

  if (!wf) {
    return (
      <Card dot={GROUP_DOTS.outcome} title="Projection vs target">
        <div className="empty-state">No projection model yet</div>
      </Card>
    );
  }

  const target = wf.target ?? 0;
  const projection = wf.projection ?? 0;
  const complete = !!snap?.complete;
  const steps = wf.steps || [];

  // running levels: target -> after each contributor (last = projection)
  let cum = target;
  const path = steps.map((s) => {
    const from = cum;
    cum += s.value ?? 0;
    return { ...s, from, to: cum };
  });
  const levels = [target, ...path.map((p) => p.to)];
  const lo = Math.min(projection, ...levels);
  const hi = Math.max(projection, ...levels);
  const pad = (hi - lo) * 0.1;
  const span = hi + pad - (lo - pad);
  const X = (v) => (span > 0 ? ((v - (lo - pad)) / span) * 100 : 50);

  const nRows = steps.length + 2; // Target + steps + Projection
  const net = projection - target;
  const netC = net >= 0 ? C.green : C.red;
  const closeWord = complete ? "Final" : "Projected";
  const netTip = {
    head: closeWord + " at close",
    rows: [
      { label: "Projection", value: fmt(projection) },
      { label: "Target", value: fmt(target) },
      { label: "Gap", value: fmtSigned(net), color: netC },
    ],
  };

  const anchorRow = (label, value, x, tip) => (
    <div
      style={{
        flex: 1, display: "grid", gridTemplateColumns: "116px 1fr 48px",
        gap: 12, alignItems: "center", minHeight: 0,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ position: "relative", height: 14 }}>
        <div
          {...tipApi.props(tip)}
          style={{
            position: "absolute", left: `${X(x)}%`, top: -2, bottom: -2,
            width: 2, background: C.ink,
          }}
        />
      </div>
      <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
        {fmt(value)}
      </div>
    </div>
  );

  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title="Projection vs target"
      right={
        <span
          className="num"
          {...tipApi.props(netTip)}
          style={{ fontSize: 13.5, fontWeight: 600, color: netC, whiteSpace: "nowrap" }}
        >
          {fmtSigned(net)}
        </span>
      }
    >
      <div className="spacer-16" />
      <div className="body" style={{ position: "relative" }}>
        {/* grey connector drops between running levels (row centre to row centre) */}
        <div style={{ position: "absolute", left: 128, right: 60, top: 0, bottom: 0, pointerEvents: "none" }}>
          {levels.map((v, i) => (
            <div
              key={i}
              style={{
                position: "absolute", left: `${X(v)}%`,
                top: `${((i + 0.5) / nRows) * 100}%`, height: `${(1 / nRows) * 100}%`,
                width: 1, background: C.planGrey,
              }}
            />
          ))}
        </div>

        {anchorRow("Target", target, target, { head: "Target", rows: [{ label: "Units", value: fmt(target) }] })}

        {path.map((p) => {
          const v = p.value ?? 0;
          const up = v >= 0;
          const tip = {
            head: p.label,
            rows: [
              { label: "Contribution", value: fmtSigned(v) + " units", color: up ? "#0f7052" : C.red },
              { label: "Running total", value: fmt(p.to) },
            ],
          };
          return (
            <div
              key={p.key}
              style={{
                flex: 1, display: "grid", gridTemplateColumns: "116px 1fr 48px",
                gap: 12, alignItems: "center", minHeight: 0,
              }}
            >
              <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {p.label}
              </div>
              <div style={{ position: "relative", height: 14 }}>
                <div
                  {...tipApi.props(tip)}
                  style={{
                    position: "absolute", top: 0, bottom: 0,
                    left: `${X(Math.min(p.from, p.to))}%`,
                    width: `${Math.max(1.2, Math.abs(X(p.to) - X(p.from)))}%`,
                    background: up ? C.wfGreen : C.red, borderRadius: 3,
                  }}
                />
              </div>
              <div
                className="num"
                style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: up ? C.green : C.red }}
              >
                {fmtSigned(v)}
              </div>
            </div>
          );
        })}

        {anchorRow("Projection", projection, projection, { head: closeWord + " demand at close", rows: [{ label: "Units", value: fmt(projection) }] })}
      </div>
      <div style={{ height: 12, flexShrink: 0 }} />
      <div
        style={{
          height: 26, display: "flex", justifyContent: "space-between",
          alignItems: "center", flexShrink: 0,
        }}
      >
        <QBadge content={{ head: "Projection vs target", body: "Contributors sum exactly to the gap between target and projected demand at close. Demand here is unconstrained - the hero caps at the sellout." }} />
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>units at close</span>
      </div>
    </Card>
  );
}
