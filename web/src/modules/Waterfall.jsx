/* Projection vs target (spec §4.10) - horizontal waterfall.
 *
 * The card reads top to bottom as one argument: here is the target, here is
 * how much of it was ambition beyond what launches like this one reach, and
 * from the basket's level here is how each contributor did against the basket
 * on the way to where the release actually lands. The target opens the list,
 * the stretch is the first step (a bar in the stretch tint down, or up, to the
 * benchmark's dotted tick, its mark everywhere - BENCHMARK_SPEC 7), and every
 * step after it reads against the benchmark, so the steps sum to the outcome
 * less the benchmark and, with the stretch, to the gap the header prints.
 * Without a basket the list opens at the target and the steps read against it.
 *
 * Drawn with the page's one horizontal waterfall (LevelWaterfall in ui.jsx):
 * benchmark, target and outcome are level ticks, the bars step between running
 * levels with grey drops, x-scale = [min, max of every mark] ± 10% pad.
 * Projection and the to-date figures are stored model outputs - never
 * re-derived here; on a complete release the projection equals the actual
 * close. */
import React, { useState } from "react";
import { Card, HorizonBadge, GROUP_DOTS, BADGE_WORDS, C, QBadge, fmt, fmtSigned, useTip, LevelWaterfall, waterfallOpening, waterfallScale, HATCH, stretchWords } from "../ui.jsx";
import { Ex } from "../explain/Explain.jsx";
import { channelWalk } from "../figures.mjs";
import { wordsOf } from "../vocab.mjs";

/* Demand the edition cannot hold: the last step of a walk on a sold-out
 * release, in the hero's over-sellout hatch, dropping to the capped figure
 * the hero prints. */
const beyondStep = (value, from, to, xArg) => ({
  kind: "step", key: "oversubscribed", label: "Beyond sellout", value, from, to, fill: HATCH,
  x: { k: "wf.step", arg: { key: "oversubscribed", ...xArg } },
  tip: {
    head: "Beyond sellout",
    rows: [{ label: "Units the edition cannot hold", value: fmt(Math.abs(value)) }, { label: "Running total", value: fmt(to) }],
    body: "Demand past the sellout cannot convert, so the walk drops back to the capped figure the hero prints.",
  },
});

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
  const W = wordsOf(snap);   // units, or a timed launch's signups (vocab.mjs)
  const title = isToday ? W.outcomeWaterfall : W.projectionWaterfall;

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
  const words = BADGE_WORDS;

  const bmRaw = view.benchmark;
  // the walk from the benchmark needs the contributors measured against it; an
  // older snapshot without them walks from the target as it used to
  const hasBm = !!snap?.benchmark && bmRaw !== null && bmRaw !== undefined && Array.isArray(view.stepsBm);
  const benchmark = hasBm ? bmRaw : null;
  const k = snap?.benchmark?.k ?? null;
  const start = hasBm ? benchmark : target;

  // running levels: the start -> after each contributor (last = the outcome)
  let cum = start;
  const path = (hasBm ? view.stepsBm : steps).map((s) => {
    const from = cum;
    cum += s.value ?? 0;
    return { ...s, from, to: cum };
  });

  const net = outcome - target;
  const netC = net >= 0 ? C.green : C.red;
  const closeWord = complete ? "Final" : "Projected";
  const outcomeLabel = isToday ? "Actual" : "Projection";
  const netTip = {
    head: isToday ? W.toDate : closeWord,
    rows: [
      { label: outcomeLabel, value: fmt(outcome) },
      { label: words.target, value: fmt(target) },
      { label: "Gap", value: fmtSigned(net), color: netC },
    ],
  };
  /* By channel: each channel steps from its target to its actual (today) or
   * from its target to its projection (at close), in the order the page lists
   * them, in whole units that add up (figures.mjs). The channels add up to the
   * release's demand, so on a release over its edition the walk ends with a
   * Beyond sellout step down to the capped figure: the drivers view's own
   * step, taken from the snapshot, never from what rounding leaves over. */
  const cw = channelWalk(snap, { today: isToday });
  const chanPath = cw ? cw.steps : [];
  const xClose = { close: !isToday };
  const xHere = { ...xClose, where: title };   // the figures this card shows that the hero owns
  const stepRows = by === "channels"
    ? chanPath.map((c) => ({
        kind: "step", key: c.key, label: c.label, value: c.value, from: c.from, to: c.to,
        x: { k: "wf.channel", arg: { key: c.key, ...xClose } },
        tip: {
          head: c.label,
          rows: [
            { label: isToday ? W.toDate : "Projected", value: fmt(c.a) },
            { label: hasBm ? words.bm : words.target, value: fmt(c.e) },
            { label: "Gap", value: fmtSigned(c.value), color: c.value >= 0 ? C.green : C.red },
            { label: "Running total", value: fmt(c.to) },
          ],
        },
      }))
    : path.map((p) => {
        const v = p.value ?? 0;
        if (p.key === "oversubscribed") return beyondStep(v, p.from, p.to, xClose);
        return {
          kind: "step", key: p.key, label: p.label, value: v, from: p.from, to: p.to,
          x: { k: "wf.step", arg: { key: p.key, ...xClose } },
          tip: {
            head: p.label,
            rows: [
              { label: "Contribution", value: fmtSigned(v) + " " + W.unit, color: v >= 0 ? C.green : C.red },
              { label: "Running total", value: fmt(p.to) },
            ],
          },
        };
      });
  // the channels add up to the demand; the cap is its own step down to the outcome
  if (by === "channels" && cw && cw.beyond < 0) stepRows.push(beyondStep(cw.beyond, cw.end, outcome, xClose));
  const rows = [
    ...waterfallOpening({ hasBm, bm: benchmark, target, words, k, xArg: xHere, stretchNote: stretchWords(snap), unitWord: W.Unit }),
    ...stepRows,
    { kind: "level", key: "outcome", label: outcomeLabel, value: outcome, color: C.blue, x: { k: "hero.fill", arg: xHere },
      tip: {
        head: isToday ? W.toDate : `${closeWord} at the ${W.closeWord}`,
        rows: [{ label: W.Unit, value: fmt(outcome) }],
      } },
  ];
  const X = waterfallScale([outcome, target, ...path.map((p) => p.to), ...(by === "channels" ? chanPath.map((c) => c.to) : []), ...(hasBm ? [benchmark] : [])]);
  const seg = (
    <span className="seg compact" role="group" aria-label="Waterfall by" style={{ flexShrink: 0 }}>
      {[["drivers", "Drivers", "The four stored contributors: organic traffic and conversion, paid spend and efficiency"],
        ["channels", "Channels", "Each channel's units against its own target"]].map(([v, label, tip]) => (
        <button key={v} className={by === v ? "active" : ""} onClick={() => setBy(v)} title={tip}>{label}</button>
      ))}
    </span>
  );

  /* The head carries the title, the horizon and the gap, and nothing else: the
     gap is the card's headline figure and is never cut. Where the card is too
     narrow for all three on one line the gap takes a line of its own (the
     head's wrap); the Drivers / Channels switch sits in the foot. */
  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title={title}
      badge={<HorizonBadge horizon={isToday ? "today" : "close"} closeLabel={W.closeLabel} />}
      wrapHead
      right={
        <span
          className="num"
          {...tipApi.props(netTip)}
          style={{ fontSize: 13.5, fontWeight: 600, color: netC, whiteSpace: "nowrap", flexShrink: 0 }}
        >
          <Ex k="wf.net" arg={xHere} focus>{fmtSigned(net)}</Ex>
        </span>
      }
    >
      <div className="spacer-16" />
      <LevelWaterfall rows={rows} X={X} />
      <div style={{ height: 12, flexShrink: 0 }} />
      <div
        style={{
          height: 26, display: "flex", gap: 10,
          alignItems: "center", flexShrink: 0,
        }}
      >
        <QBadge content={{
          head: title,
          body: by === "channels"
            ? "The list opens at the target; the stretch is the part of the gap that is ambition beyond the basket, and from the benchmark each channel steps by its own units against its own benchmark, in the page's order. They add up to the release's demand, so on a sold-out release the last step, Beyond sellout, drops to the capped figure the hero prints. Without a basket the channels read against their targets."
            : isToday
            ? "The list opens at the target; the stretch is the part of the gap that is ambition beyond the basket, what launches like this one typically have by now. From the benchmark the contributors read against the basket and sum exactly to the gap between it and what is secured to date, so with the stretch they sum to the gap the header prints. Without a basket they read against the target."
            : "The list opens at the target; the stretch is the part of the gap that is ambition beyond the basket. From the benchmark the contributors read against the basket and sum exactly to the gap between it and the projection at close. Demand beyond the sellout is the last step, so the walk lands on the capped figure the hero prints.",
        }} />
        {seg}
        {/* the day first, so that on a narrow card the ellipsis takes words, not the number */}
        <span style={{
          marginLeft: "auto", fontSize: 12, color: C.muted, whiteSpace: "nowrap",
          minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {isToday && snap?.day ? `${W.stepWord} ` + snap.day + " · " : ""}
          {/* where there is no basket at all, the model that set the target instead */}
          {hasBm ? "" : "no comparable basket · "}
          {isToday ? W.securedUnits.toLowerCase() : W.unit}
        </span>
      </div>
    </Card>
  );
}
