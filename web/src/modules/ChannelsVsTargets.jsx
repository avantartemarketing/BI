/* Channels vs targets (spec §4.3, LE relabel per §6) - column form.
 *
 * All five display groups (paid included) as columns rising from a baseline, each
 * one carrying both references and the actual (BENCHMARK_SPEC 7): the target as
 * the fill, darker from the baseline to whichever of target and benchmark is
 * lower and lighter from the benchmark up to the target when the target is the
 * higher; the benchmark as a dotted outline of the column it would make, over
 * the fill; the actual as the narrower orange column in front. Nothing about the
 * drawing changes between a release whose targets sit above the basket and one
 * whose targets sit below it - only where the outline lands - so the legend has
 * the same shape either way and a benchmark above its target needs no special
 * case.
 *
 * One toggle only. The page header carries Today | At close, so the horizon
 * arrives as a prop and the card keeps just:
 *   % | Units  - % puts every channel against its own target on one 100% scale,
 *                so the fills align into a shared level across the card and,
 *                the uplift being one even multiple, so do the outlines; Units
 *                keeps real magnitudes, so each column is that channel's own size.
 * Foot per column: the actual as a % of this horizon's target, green at or above
 * and red below. The stretch multiple is said once, at the foot of the card,
 * rather than drawn on five bars. */
import React, { useState } from "react";
import { Card, GROUP_DOTS, BmOutline, C, fmt, useTip, refWords } from "../ui.jsx";

/* The fill nearly fills the slot and the actual sits well inside it, so the
 * tints and the outline read on both sides of the orange at every card width. */
const REF_INSET = "6%";
const BAR_INSET = "27%";

/* The legend's outline swatch: the same dotted silhouette the columns carry. */
const OUTLINE_SWATCH = (
  <svg width="12" height="9" viewBox="0 0 12 9" style={{ flex: "0 0 12px" }} aria-hidden="true">
    <path d="M1 9 V1.5 H11 V9" fill="none" stroke={C.refLine} strokeWidth="1.5" strokeDasharray="1.6 1.6" />
  </svg>
);

export default function ChannelsVsTargets({ snap, horizon = "today" }) {
  const t = useTip();
  const [scale, setScale] = useState("pct");   // pct | units
  const rows = snap?.channels || [];
  // no targets: nothing to compare against, so units only and no toggle
  const targeted = !snap || snap.targeted !== false;
  const today = horizon !== "close";
  const pct = targeted ? scale === "pct" : false;
  const hasBm = targeted && !!snap?.benchmark;
  const words = refWords(horizon);

  // Today compares actuals with the target to date; at close compares the projection
  // with the full target (docs §5.4 / §9). The benchmark for the same horizon rides
  // along, absent when the release has no basket.
  const base = rows.map((c) => {
    const target = (today ? c.exp : c.target) ?? 0;
    const bar = (today ? c.now : c.proj) ?? 0;
    const bmRaw = today ? c.bmExp : c.bm;
    const bm = hasBm && bmRaw !== null && bmRaw !== undefined ? bmRaw : null;
    return {
      key: c.key, name: c.name, parts: c.parts || [], bar, target, bm,
      pctOfTarget: target > 0 ? Math.round((bar / target) * 100) : null,
    };
  });

  // one scale across the card: % normalises each channel to its own target, units
  // keeps them comparable in secured units. Both references are in the scale, so
  // neither the fill nor the outline can end up outside the plot.
  const val = (v, target) => (pct ? (target > 0 ? (v / target) * 100 : 0) : v);
  const max = Math.max(
    ...base.map((r) => val(r.bar, r.target)),
    ...base.map((r) => (pct ? 100 : r.target)),
    ...base.map((r) => (r.bm === null ? 0 : val(r.bm, r.target))),
    1,
  ) * 1.02;
  const h = (v) => Math.max(0, Math.min((v / max) * 100, 100));

  const cols = base.map((r) => ({
    ...r,
    barH: h(val(r.bar, r.target)),
    targetH: h(pct ? 100 : r.target),
    bmH: r.bm === null ? null : h(val(r.bm, r.target)),
  }));

  const fillColor = today ? C.orange : C.orangeLight;
  const fillLabel = today ? "To date" : "Projected";
  const unit = (v) => fmt(v, v < 10 && v > 0 ? 1 : 0);
  const k = snap?.benchmark?.k ?? null;
  // the uplift is one multiple, so the stretch band is on every column or none
  const anyStretch = cols.some((c) => c.bm !== null && c.target > c.bm);
  const stretchNote = k > 0
    ? `The target is ×${fmt(k, 2)} the benchmark - the same even uplift in every channel and on every day.`
    : undefined;

  const seg = (opts, value, set) => (
    <span className="seg compact">
      {opts.map(([v, label, tip]) => (
        <button key={v} className={value === v ? "active" : ""} onClick={() => set(v)} title={tip}>
          {label}
        </button>
      ))}
    </span>
  );

  const swatch = (bg) => ({ width: 9, height: 9, borderRadius: 2, background: bg, flex: "0 0 9px" });
  const legendItem = { display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" };

  return (
    <Card
      dot={GROUP_DOTS.volume}
      title={targeted ? "Channels vs targets" : "Channels"}
    >
      {targeted && <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, margin: "10px 0 12px", flex: "0 0 auto" }}>
        {seg(
          [["pct", "%", "Every channel against its own target, on one 100% scale"],
           ["units", "Units", "Secured units, so channels are comparable in size"]],
          scale, setScale,
        )}
      </div>}
      {!targeted && <div style={{ height: 12, flex: "0 0 auto" }} />}
      {cols.length === 0 ? (
        <div className="empty-state">No channel data yet</div>
      ) : (
        <div className="body" style={{ gap: 6 }}>
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", gap: 8 }}>
            {cols.map((c) => {
              const withBm = c.bm !== null;
              const lo = withBm ? Math.min(c.targetH, c.bmH) : c.targetH;
              const stretch = withBm && c.targetH > c.bmH;
              const refRows = [
                { label: words.target, value: unit(c.target) },
                ...(withBm ? [{ label: words.bm, value: unit(c.bm) }] : []),
              ];
              const barTip = {
                head: today ? "Secured to date" : "Projected at close",
                rows: [{ label: "Units", value: unit(c.bar) }, ...refRows],
              };
              const refTip = {
                head: c.name,
                rows: refRows,
                body: withBm
                  ? "The fill is the target; the dotted outline is the median of the matched basket for this channel."
                  : undefined,
              };
              return (
                <div key={c.key} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  {targeted && lo > 0 && (
                    <div
                      {...t.props(refTip)}
                      style={{
                        position: "absolute", left: REF_INSET, right: REF_INSET, bottom: 0,
                        height: `${lo}%`, background: C.refBase,
                        // square under a band, rounded when it is the top of the fill
                        borderRadius: stretch ? 0 : "4px 4px 0 0",
                      }}
                    />
                  )}
                  {targeted && stretch && (
                    <div
                      {...t.props(refTip)}
                      style={{
                        position: "absolute", left: REF_INSET, right: REF_INSET, bottom: `${c.bmH}%`,
                        height: `${c.targetH - c.bmH}%`, background: C.refStretch, borderRadius: "4px 4px 0 0",
                      }}
                    />
                  )}
                  {targeted && withBm && c.bmH > 0 && <BmOutline pct={c.bmH} column inset={REF_INSET} />}
                  <div
                    {...t.props(barTip)}
                    style={{
                      position: "absolute", left: BAR_INSET, right: BAR_INSET, bottom: 0,
                      height: `${c.barH}%`, background: fillColor, borderRadius: "3px 3px 0 0",
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {cols.map((c) => {
              // a channel with a token target can read in the thousands of per cent,
              // which says nothing except "off the scale" - so it is clamped and marked
              const capped = c.pctOfTarget !== null && c.pctOfTarget > 999;
              return (
                <div key={c.key} style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
                  <div
                    {...t.props(c.parts && c.parts.length > 1 ? {
                      head: c.name,
                      body: "Secured units to date, by channel",
                      rows: c.parts.map((p) => ({ label: p.name, value: unit(p.value) })),
                    } : { head: c.name })}
                    style={{
                      fontSize: 9, color: C.muted, lineHeight: 1.2, height: 22, overflow: "hidden",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                    }}
                  >
                    {c.name}
                  </div>
                  <div
                    className="num"
                    style={{
                      fontSize: 11, fontWeight: 600,
                      color: c.pctOfTarget === null ? C.muted : c.pctOfTarget >= 100 ? C.green : C.red,
                    }}
                  >
                    {c.pctOfTarget === null ? "–" : (capped ? "›999%" : c.pctOfTarget + "%")}
                  </div>
                </div>
              );
            })}
          </div>
          {/* the legend wraps rather than clips: with both references named it is
              four items, and the note at the end is the first thing to drop a line */}
          <div
            style={{
              display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 14px", flex: "0 0 auto",
              marginTop: 4, paddingTop: 10, borderTop: `1px solid ${C.hairline}`,
              fontSize: 10.5, color: C.muted,
            }}
          >
            <span style={legendItem}><span style={swatch(fillColor)} />{fillLabel}</span>
            {targeted && <span style={legendItem}><span style={swatch(C.refBase)} />Target</span>}
            {anyStretch && (
              <span style={legendItem} title={stretchNote}><span style={swatch(C.refStretch)} />Stretch</span>
            )}
            {hasBm && <span style={legendItem} title="The median of the matched basket, per channel">{OUTLINE_SWATCH}Benchmark</span>}
            <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }} title={stretchNote}>
              {/* the stretch said once, in words, rather than drawn on five bars */}
              {hasBm && k > 0 ? "target is ×" + fmt(k, 2) + " the benchmark"
                : !targeted ? "secured units · no targets"
                : pct ? "target = 100%" : "secured units"}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
