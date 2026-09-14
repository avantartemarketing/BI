/* Projection vs target (spec §4.10) - horizontal waterfall.
 *
 * The card reads top to bottom as one argument: here is the reference the page
 * is being read against, and here are the contributors that explain the distance
 * from it to where the release actually lands.
 *
 * Read against the target, that is Target -> four contributors -> outcome, which
 * is the card as it always was. Read against the benchmark, one row is inserted
 * above them: the stretch the business put on the basket's median to arrive at
 * the target. It is a planning decision rather than performance, so it is flat
 * plan grey and its number is muted, never green or red - but it is a real step
 * between the two levels, so it is drawn as one and the arithmetic still closes.
 *
 * The reference and the outcome are level anchor ticks (never floor-anchored
 * columns); the contributor bars step between running levels with grey 1px
 * connector drops. x-scale = [min, max of every level drawn] ± 10% pad.
 * Projection and the to-date figures are stored model outputs - never
 * re-derived here; on a complete release the projection equals the actual
 * close. */
import React from "react";
import {
  Card, GROUP_DOTS, Tick, C, QBadge, fmt, fmtSigned, useTip, STRETCH_FILL,
  useRefMode, refWord, otherWord,
} from "../ui.jsx";

export default function Waterfall({ snap, horizon = "today" }) {
  const tipApi = useTip();
  const mode = useRefMode();
  const wf = snap?.waterfall;
  // an older snapshot carries no waterfall.today, so Today falls back to the
  // close shape rather than emptying the card out from under the page toggle
  const td = horizon === "today" && wf && wf.today ? wf.today : null;
  const isToday = !!td;
  // the title names the comparison, so it follows the page toggle with the rest
  // of the card - it cannot say "vs target" while the top row is the benchmark
  const against = mode === "benchmark" && snap?.benchmark ? "benchmark" : "target";
  const title = (isToday ? "Actual vs " : "Projection vs ") + against;

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

  const bmRaw = view.benchmark;
  const hasBm = !!snap?.benchmark && bmRaw !== null && bmRaw !== undefined;
  const benchmark = hasBm ? bmRaw : null;
  const stretch = hasBm ? view.stretch ?? target - benchmark : null;
  const k = snap?.benchmark?.k ?? null;
  const bmMode = mode === "benchmark" && hasBm;

  const refLabel = refWord(bmMode ? "benchmark" : "target", horizon === "close" ? "close" : "today");
  const otherLabel = otherWord(bmMode ? "benchmark" : "target", horizon === "close" ? "close" : "today");
  const other = bmMode ? target : benchmark;

  /* Running levels from the anchor down. In benchmark mode the stretch is the
   * first step, which is what keeps the arithmetic closing: benchmark plus the
   * stretch is the target, and the contributors carry on from there. */
  const base = bmMode ? benchmark : target;
  const path = [];
  let cum = base;
  if (bmMode) {
    path.push({
      key: "__stretch", label: "Stretch to target", value: stretch, plan: true,
      from: base, to: base + stretch,
    });
    cum = base + stretch;
  }
  for (const s of steps) {
    const from = cum;
    cum += s.value ?? 0;
    path.push({ ...s, from, to: cum });
  }
  const levels = [base, ...path.map((p) => p.to)];
  const marks = [outcome, ...levels];
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  const X = (v) => (span > 0 ? ((v - (lo - pad)) / span) * 100 : 50);

  const nRows = path.length + 2;              // the anchor + the steps + the outcome
  const net = outcome - base;
  const netC = net >= 0 ? C.green : C.red;
  const closeWord = complete ? "Final" : "Projected";
  const outcomeLabel = isToday ? "Actual today" : "Projection";
  const netTip = {
    head: isToday ? "Secured to date" : closeWord + " at close",
    rows: [
      { label: outcomeLabel, value: fmt(outcome) },
      { label: refLabel, value: fmt(base) },
      { label: "Gap", value: fmtSigned(net), color: netC },
    ],
  };

  // every drop hangs from the centre of the row it names to the centre of the next
  const drops = levels.map((v, i) => ({ v, row: i }));

  const rowGrid = {
    flex: 1, display: "grid", gridTemplateColumns: "116px 1fr 48px",
    gap: 12, alignItems: "center", minHeight: 0,
  };

  const anchorRow = (label, value, color, tip) => (
    <div style={rowGrid}>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ position: "relative", height: 14 }}>
        <Tick pct={X(value)} color={color} tip={tip} />
      </div>
      <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
        {fmt(value)}
      </div>
    </div>
  );

  const refTip = {
    head: refLabel,
    rows: [
      { label: "Units", value: fmt(base) },
      ...(other !== null && other !== undefined ? [{ label: otherLabel, value: fmt(other) }] : []),
    ],
    body: bmMode
      ? "The median of the matched basket - what launches like this one typically reach."
      : undefined,
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

        {anchorRow(refLabel, base, C.refMark, refTip)}

        {path.map((p) => {
          const v = p.value ?? 0;
          const up = v >= 0;
          const tip = p.plan ? stretchTip : {
            head: p.label,
            rows: [
              { label: "Contribution", value: fmtSigned(v) + " units", color: up ? C.green : C.red },
              { label: "Running total", value: fmt(p.to) },
            ],
          };
          return (
            <div key={p.key} style={rowGrid}>
              <div style={{
                fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                color: p.plan ? C.muted : undefined,
              }}>
                {p.label}
              </div>
              <div style={{ position: "relative", height: 14 }}>
                <div
                  {...tipApi.props(tip)}
                  style={{
                    position: "absolute", top: 0, bottom: 0,
                    left: `${X(Math.min(p.from, p.to))}%`,
                    width: `${Math.max(1.2, Math.abs(X(p.to) - X(p.from)))}%`,
                    background: p.plan ? STRETCH_FILL : up ? C.wfGreen : C.red,
                    borderRadius: 3,
                  }}
                />
              </div>
              <div
                className="num"
                style={{
                  fontSize: 12.5, fontWeight: 600, textAlign: "right",
                  color: p.plan ? C.muted : up ? C.green : C.red,
                }}
              >
                {fmtSigned(v)}
              </div>
            </div>
          );
        })}

        {anchorRow(outcomeLabel, outcome, C.orange, outcomeTip)}
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
            ? "Contributors sum exactly to the gap between the reference for today and what is secured to date. Read against the benchmark, the stretch row above them is what the target asks for over the basket, not something the release has or has not done."
            : "Contributors sum exactly to the gap between the reference and projected demand at close. Demand here is unconstrained - the hero caps at the sellout.",
        }} />
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
          {/* the reference not chosen, as a figure to know; and where there is no
              basket at all, the model that set the target instead */}
          {other !== null && other !== undefined
            ? otherLabel.toLowerCase() + " " + fmt(other)
            : "levers, no comparable basket"}
          {" · "}
          {isToday
            ? "secured units" + (snap?.day ? ", day " + snap.day : "")
            : "units at close"}
        </span>
      </div>
    </Card>
  );
}
