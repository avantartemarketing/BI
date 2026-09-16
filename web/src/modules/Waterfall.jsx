/* Projection vs target (spec §4.10) - horizontal waterfall.
 *
 * The card reads top to bottom as one argument: here is what launches like
 * this one reach, here is what the business asked for on top of that, so here
 * is the target, and here are the contributors that explain the distance from
 * it to where the release actually lands. The benchmark opens the list as a
 * dotted tick, its mark everywhere (BENCHMARK_SPEC 7); the stretch is the
 * first step, a bar in the stretch tint from the benchmark to the target, so
 * the distance the business asked for is drawn like every other distance on
 * the card. Without a basket the list opens at the target.
 *
 * Drawn with the page's one horizontal waterfall (LevelWaterfall in ui.jsx):
 * benchmark, target and outcome are level ticks, the bars step between running
 * levels with grey drops, x-scale = [min, max of every mark] ± 10% pad.
 * Projection and the to-date figures are stored model outputs - never
 * re-derived here; on a complete release the projection equals the actual
 * close. */
import React, { useState } from "react";
import { Card, GROUP_DOTS, C, QBadge, fmt, fmtSigned, useTip, refWords, LevelWaterfall, waterfallOpening, waterfallScale } from "../ui.jsx";

export default function Waterfall({ snap, horizon = "today" }) {
  const tipApi = useTip();
  // drivers: the four stored contributors; channels: each channel's units
  // against its own target, off the channels the page's other cards draw
  const [by, setBy] = useState("drivers");
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
  const k = snap?.benchmark?.k ?? null;

  // running levels: target -> after each contributor (last = the outcome)
  let cum = target;
  const path = steps.map((s) => {
    const from = cum;
    cum += s.value ?? 0;
    return { ...s, from, to: cum };
  });

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
  /* By channel: each channel steps from its target to its actual (today) or
   * from its target to its projection (at close), in the order the page lists
   * them. The channels add up to the hero's figure before the sellout cap, so
   * on a sold-out release the last drop is the cap, and the outcome's popup
   * says so rather than the card hiding it. */
  const channels = (snap?.channels || []).map((c) => ({
    key: c.key, label: c.name,
    value: (isToday ? (c.now ?? 0) - (c.exp ?? 0) : (c.proj ?? 0) - (c.target ?? 0)),
    a: isToday ? c.now ?? 0 : c.proj ?? 0, e: isToday ? c.exp ?? 0 : c.target ?? 0,
  }));
  let run = target;
  const chanPath = channels.map((c) => { const from = run; run += c.value; return { ...c, from, to: run }; });
  const residual = outcome - run;
  const capped = by === "channels" && Math.abs(residual) > 0.5;
  const stepRows = by === "channels"
    ? chanPath.map((c) => ({
        kind: "step", key: c.key, label: c.label, value: c.value, from: c.from, to: c.to,
        tip: {
          head: c.label,
          rows: [
            { label: isToday ? "Secured to date" : "Projected", value: fmt(c.a) },
            { label: words.target, value: fmt(c.e) },
            { label: "Gap", value: fmtSigned(c.value), color: c.value >= 0 ? C.green : C.red },
            { label: "Running total", value: fmt(c.to) },
          ],
        },
      }))
    : path.map((p) => {
        const v = p.value ?? 0;
        return {
          kind: "step", key: p.key, label: p.label, value: v, from: p.from, to: p.to,
          tip: {
            head: p.label,
            rows: [
              { label: "Contribution", value: fmtSigned(v) + " units", color: v >= 0 ? C.green : C.red },
              { label: "Running total", value: fmt(p.to) },
            ],
          },
        };
      });
  const rows = [
    ...waterfallOpening({ hasBm, bm: benchmark, target, words, k }),
    ...stepRows,
    { kind: "level", key: "outcome", label: outcomeLabel, value: outcome, color: C.orange,
      tip: {
        head: isToday ? "Secured to date" : closeWord + " demand at close",
        rows: [{ label: "Units", value: fmt(outcome) }],
        body: capped ? `The channels add up to ${fmt(run)} - the sellout caps the ${isToday ? "actual" : "projection"}.` : undefined,
      } },
  ];
  const X = waterfallScale([outcome, target, ...path.map((p) => p.to), ...(by === "channels" ? chanPath.map((c) => c.to) : []), ...(hasBm ? [benchmark] : [])]);
  const seg = (
    <span className="seg compact" role="group" aria-label="Waterfall by">
      {[["drivers", "Drivers", "The four stored contributors: organic traffic and conversion, paid spend and efficiency"],
        ["channels", "Channels", "Each channel's units against its own target"]].map(([v, label, tip]) => (
        <button key={v} className={by === v ? "active" : ""} onClick={() => setBy(v)} title={tip}>{label}</button>
      ))}
    </span>
  );

  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title={title}
      right={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {seg}
          <span
            className="num"
            {...tipApi.props(netTip)}
            style={{ fontSize: 13.5, fontWeight: 600, color: netC, whiteSpace: "nowrap" }}
          >
            {fmtSigned(net)}
          </span>
        </span>
      }
    >
      <div className="spacer-16" />
      <LevelWaterfall rows={rows} X={X} />
      <div style={{ height: 12, flexShrink: 0 }} />
      <div
        style={{
          height: 26, display: "flex", justifyContent: "space-between",
          alignItems: "center", flexShrink: 0,
        }}
      >
        <QBadge content={{
          head: title,
          body: by === "channels"
            ? "The list opens at the benchmark and the stretch is what the business asked for on top of it, which makes the target. From there each channel steps by its own units against its own target, in the page's order; they add up to the release before the sellout cap, so on a sold-out release the last drop is the cap."
            : isToday
            ? "The list opens at the benchmark, what the matched basket typically has by now, and the stretch is what the business asked for on top of it, which makes the target. From there the contributors sum exactly to the gap between the target for today and what is secured to date."
            : "The list opens at the benchmark and the stretch is what the business asked for on top of it, which makes the target. From there the contributors sum exactly to the gap between target and projected demand at close. Demand here is unconstrained - the hero caps at the sellout.",
        }} />
        <span style={{
          fontSize: 12, color: C.muted, whiteSpace: "nowrap",
          minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", paddingLeft: 10,
        }}>
          {/* where there is no basket at all, the model that set the target instead */}
          {hasBm ? "" : "levers, no comparable basket · "}
          {isToday
            ? "secured units" + (snap?.day ? ", day " + snap.day : "")
            : "units at close"}
        </span>
      </div>
    </Card>
  );
}
