/* Projection vs target (spec §4.10; benchmark, stretch and horizon per
 * BENCHMARK_SPEC 2, 5 and 7) - horizontal waterfall.
 *
 * The card reads top to bottom as one argument: the matched basket typically
 * reaches the benchmark, the business asked for the stretch on top of it, that
 * makes the target, and the four contributors explain the distance from the
 * target to where the release actually lands. Before the benchmark existed the
 * target was an unexplained starting level; the two new rows say where it came
 * from, which is the whole point of the benchmark model (BENCHMARK_SPEC 1).
 *
 * The stretch bar is grey and hatched and its number is muted, never green or
 * red: it is a planning decision, not performance. Only the four contributors
 * and the header delta are judged.
 *
 * Target, Benchmark, Projection and Actual are level anchor ticks (never
 * floor-anchored columns); the contributor bars step between running levels
 * with grey 1px connector drops, and the two drops at the top carry the reader
 * from the benchmark tick along the stretch bar to the target tick.
 * x-scale = [min, max of every level drawn] ± 10% pad.
 * Projection and the to-date figures are stored model outputs - never
 * re-derived here; on a complete release the projection equals the actual
 * close. When snap.benchmark is absent the two new rows are simply not drawn
 * and the card reads exactly as it did before. */
import React from "react";
import { Card, GROUP_DOTS, RefTick, C, QBadge, fmt, fmtSigned, useTip, STRETCH_HATCH } from "../ui.jsx";

/* The stretch is the one bar on the card that is not an outcome, so it is cut
 * from the plan's cloth - grey hatch on the track, with a hairline border so it
 * still has an edge where it sits on white. */


const STEP_TIPS = {
  organic_traffic: "Organic sessions vs plan",
  organic_conversion: "Session → sale vs benchmark",
  paid_spend: "Spend vs plan",
  paid_efficiency: "Entries per pound vs target",
};

export default function Waterfall({ snap, horizon = "today" }) {
  const tipApi = useTip();
  const wf = snap?.waterfall;
  // an older snapshot carries no waterfall.today, so Today falls back to the
  // close shape rather than emptying the card out from under the page toggle
  const td = horizon === "today" && wf && wf.today ? wf.today : null;
  const isToday = !!td;
  const title = isToday ? "Actual vs target" : "Projection vs target";

  if (!wf) {
    return (
      <Card dot={GROUP_DOTS.outcome} title={title}>
        <div className="empty-state">
          {snap?.targeted === false ? "Needs targets - projection and target are both model outputs" : "No projection model yet"}
        </div>
      </Card>
    );
  }

  const view = td || wf;
  const target = view.target ?? 0;
  const outcome = (isToday ? view.actual : view.projection) ?? 0;
  const complete = !!snap?.complete;
  const steps = view.steps || [];

  // the cobalt rows only exist when the release has a basket behind it
  const bmRaw = view.benchmark;
  const hasBm = !!snap?.benchmark && bmRaw !== null && bmRaw !== undefined;
  const benchmark = hasBm ? bmRaw : null;
  const stretch = hasBm ? view.stretch ?? target - benchmark : null;
  const k = snap?.benchmark?.k ?? null;

  // running levels: target -> after each contributor (last = the outcome)
  let cum = target;
  const path = steps.map((s) => {
    const from = cum;
    cum += s.value ?? 0;
    return { ...s, from, to: cum };
  });
  const levels = [target, ...path.map((p) => p.to)];
  const marks = [outcome, ...levels, ...(hasBm ? [benchmark] : [])];
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const pad = (hi - lo) * 0.1;
  const span = hi + pad - (lo - pad);
  const X = (v) => (span > 0 ? ((v - (lo - pad)) / span) * 100 : 50);

  const head = hasBm ? 2 : 0;                 // Benchmark + Stretch rows above Target
  const nRows = head + steps.length + 2;      // + Target + the outcome row
  const net = outcome - target;
  const netC = net >= 0 ? C.green : C.red;
  const closeWord = complete ? "Final" : "Projected";
  const outcomeLabel = isToday ? "Actual today" : "Projection";
  const netTip = {
    head: isToday ? "Secured to date" : closeWord + " at close",
    rows: [
      { label: outcomeLabel, value: fmt(outcome) },
      { label: isToday ? "Target today" : "Target", value: fmt(target) },
      { label: "Gap", value: fmtSigned(net), color: netC },
    ],
  };

  // every drop hangs from the centre of the row it names to the centre of the
  // next one, so the row count has to be threaded through rather than assumed
  const drops = [
    ...(hasBm ? [{ v: benchmark, row: 0 }, { v: target, row: 1 }] : []),
    ...levels.map((v, i) => ({ v, row: i + head })),
  ];

  const rowGrid = {
    flex: 1, display: "grid", gridTemplateColumns: "116px 1fr 48px",
    gap: 12, alignItems: "center", minHeight: 0,
  };

  const anchorRow = (label, value, x, kind, tip) => (
    <div style={rowGrid}>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ position: "relative", height: 14 }}>
        <RefTick pct={X(x)} kind={kind} tip={tip} />
      </div>
      <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
        {fmt(value)}
      </div>
    </div>
  );

  const bmTip = {
    head: isToday ? "Benchmark today" : "Benchmark at close",
    rows: [{ label: "Units", value: fmt(benchmark ?? 0) }],
    body: "The median of the matched basket - what launches like this one typically reach.",
  };
  const stretchTip = {
    head: "Stretch",
    rows: [
      { label: "Benchmark", value: fmt(benchmark ?? 0) },
      { label: "Target", value: fmt(target) },
      { label: "Stretch", value: fmtSigned(stretch ?? 0) },
      ...(k ? [{ label: "Uplift", value: "×" + fmt(k, 2) }] : []),
    ],
    body: "What the business is asking for over and above the basket - the same even uplift in every channel and on every day.",
  };
  const targetTip = {
    head: isToday ? "Target today" : "Target",
    rows: [{ label: "Units", value: fmt(target) }],
  };
  const outcomeTip = isToday
    ? { head: "Secured to date", rows: [{ label: "Units", value: fmt(outcome) }] }
    : { head: closeWord + " demand at close", rows: [{ label: "Units", value: fmt(outcome) }] };

  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title={title}
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
          {drops.map((d, i) => (
            <div
              key={i}
              style={{
                position: "absolute", left: `${X(d.v)}%`,
                top: `${((d.row + 0.5) / nRows) * 100}%`, height: `${(1 / nRows) * 100}%`,
                width: 1, background: C.planGrey,
              }}
            />
          ))}
        </div>

        {hasBm && anchorRow(isToday ? "Benchmark today" : "Benchmark", benchmark, benchmark, "benchmark", bmTip)}

        {hasBm && (
          <div style={rowGrid}>
            <div style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>Stretch</div>
            <div style={{ position: "relative", height: 14 }}>
              <div
                {...tipApi.props(stretchTip)}
                style={{
                  position: "absolute", top: 0, bottom: 0,
                  left: `${X(Math.min(benchmark, target))}%`,
                  width: `${Math.max(1.2, Math.abs(X(target) - X(benchmark)))}%`,
                  background: STRETCH_HATCH, border: `1px solid ${C.planGrey}`,
                  boxSizing: "border-box", borderRadius: 3,
                }}
              />
            </div>
            <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: C.muted }}>
              {fmtSigned(stretch)}
            </div>
          </div>
        )}

        {anchorRow(isToday ? "Target today" : "Target", target, target, "target", targetTip)}

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
            <div key={p.key} style={rowGrid}>
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

        {anchorRow(outcomeLabel, outcome, outcome, "target", outcomeTip)}
      </div>
      <div style={{ height: 12, flexShrink: 0 }} />
      <div
        style={{
          height: 26, display: "flex", justifyContent: "space-between",
          alignItems: "center", flexShrink: 0,
        }}
      >
        <QBadge content={{
          head: title,
          body: isToday
            ? "Contributors sum exactly to the gap between the target for today and what is secured to date. The stretch above is what the target asks for over the benchmark, not something the release has or has not done."
            : "Contributors sum exactly to the gap between target and projected demand at close. Demand here is unconstrained - the hero caps at the sellout.",
        }} />
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
          {isToday
            ? "secured units" + (snap?.day ? ", day " + snap.day : "")
            : "units at close"}
          {/* an absent benchmark row explains nothing on its own - name the
              model that set the target instead (BENCHMARK_SPEC 4) */}
          {!hasBm && " · levers, no comparable basket"}
        </span>
      </div>
    </Card>
  );
}
