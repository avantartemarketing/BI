/* Projection vs target (spec §4.10) - horizontal waterfall.
 *
 * The card reads top to bottom as one argument: here is the target, and here
 * are the contributors that explain the distance from it to where the release
 * actually lands. The benchmark sits on the target's row as a dotted tick - the
 * waterfall's form of the dotted outline every bar carries (BENCHMARK_SPEC 7) -
 * so the reader sees how far the business asked for above the basket without a
 * row of its own for it; the stretch itself is a planning decision, not
 * performance, and is named in the target's popup rather than drawn as a step.
 *
 * Target and outcome are level anchor ticks (never floor-anchored columns); the
 * contributor bars step between running levels with grey 1px connector drops.
 * x-scale = [min, max of every level drawn] ± 10% pad. Projection and the
 * to-date figures are stored model outputs - never re-derived here; on a
 * complete release the projection equals the actual close. */
import React from "react";
import { Card, GROUP_DOTS, Tick, C, QBadge, fmt, fmtSigned, useTip, refWords } from "../ui.jsx";

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
  const words = refWords(isToday ? "today" : "close");

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
  // the benchmark is in the scale so its tick can never fall off the row
  const marks = [outcome, ...levels, ...(hasBm ? [benchmark] : [])];
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  const X = (v) => (span > 0 ? ((v - (lo - pad)) / span) * 100 : 50);

  const nRows = path.length + 2;              // the target + the steps + the outcome
  const net = outcome - target;
  const netC = net >= 0 ? C.green : C.red;
  const closeWord = complete ? "Final" : "Projected";
  const outcomeLabel = isToday ? "Actual today" : "Projection";
  const netTip = {
    head: isToday ? "Secured to date" : closeWord + " at close",
    rows: [
      { label: outcomeLabel, value: fmt(outcome) },
      { label: words.target, value: fmt(target) },
      { label: "Gap", value: fmtSigned(net), color: netC },
    ],
  };

  // every drop hangs from the centre of the row it names to the centre of the next
  const drops = levels.map((v, i) => ({ v, row: i }));

  const rowGrid = {
    flex: 1, display: "grid", gridTemplateColumns: "116px 1fr 48px",
    gap: 12, alignItems: "center", minHeight: 0,
  };

  const targetTip = {
    head: words.target,
    rows: [
      { label: "Units", value: fmt(target) },
      ...(hasBm ? [
        { label: words.bm, value: fmt(benchmark) },
        { label: "Stretch", value: fmtSigned(stretch) },
        ...(k ? [{ label: "Uplift", value: "×" + fmt(k, 2) }] : []),
      ] : []),
    ],
    body: hasBm
      ? "The stretch is what the business asked for over and above the basket - the same even uplift in every channel and on every day."
      : undefined,
  };
  const bmTip = {
    head: words.bm,
    rows: [{ label: "Units", value: fmt(benchmark ?? 0) }],
    body: "The median of the matched basket - what launches like this one typically reach.",
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

        {/* the target's row carries both references: its own solid tick and the
            benchmark's dotted one */}
        <div style={rowGrid}>
          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{words.target}</div>
          <div style={{ position: "relative", height: 14 }}>
            {hasBm && <Tick pct={X(benchmark)} color={C.refLine} dotted tip={bmTip} />}
            <Tick pct={X(target)} color={C.refLine} tip={targetTip} />
          </div>
          <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
            {fmt(target)}
          </div>
        </div>

        {path.map((p) => {
          const v = p.value ?? 0;
          const up = v >= 0;
          const tip = {
            head: p.label,
            rows: [
              { label: "Contribution", value: fmtSigned(v) + " units", color: up ? C.green : C.red },
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

        <div style={rowGrid}>
          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{outcomeLabel}</div>
          <div style={{ position: "relative", height: 14 }}>
            <Tick pct={X(outcome)} color={C.orange} tip={outcomeTip} />
          </div>
          <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
            {fmt(outcome)}
          </div>
        </div>
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
            ? "Contributors sum exactly to the gap between the target for today and what is secured to date. The dotted tick on the target's row is the benchmark: what the matched basket typically has by now."
            : "Contributors sum exactly to the gap between target and projected demand at close. Demand here is unconstrained - the hero caps at the sellout. The dotted tick on the target's row is the benchmark.",
        }} />
        <span style={{
          fontSize: 12, color: C.muted, whiteSpace: "nowrap",
          minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", paddingLeft: 10,
        }}>
          {/* the benchmark as a figure to know; and where there is no basket at
              all, the model that set the target instead */}
          {hasBm ? words.bm.toLowerCase() + " " + fmt(benchmark) : "levers, no comparable basket"}
          {" · "}
          {isToday
            ? "secured units" + (snap?.day ? ", day " + snap.day : "")
            : "units at close"}
        </span>
      </div>
    </Card>
  );
}
