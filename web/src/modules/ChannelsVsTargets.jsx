/* Channels vs targets (spec §4.3, LE relabel per §6) - column form.
 *
 * All five display groups (paid included) as columns rising from a baseline, each
 * one two layers: the reference this page is being read against as a wide tint
 * behind, the actual as a narrower orange column in front. Which of the two
 * references that is comes from the page toggle, and the foot of every column
 * follows it - the percentage and its green or red are against the same thing the
 * tint draws. Reading one against the other is then a matter of which column ends
 * higher, with no line to decode and no case to make for a benchmark that happens
 * to sit above its target: that column is simply taller.
 *
 * Two toggles, neither of them here. The page header carries Today | At close and
 * Benchmark | Target, so the card keeps just:
 *   % | Units  - % puts every channel against its own reference on one 100% scale,
 *                so the tints align into a shared level across the card; Units
 *                keeps real magnitudes, so each column is that channel's own size.
 * The stretch is not drawn at all. It is the same even uplift in every column
 * (spec §1), so it belongs at the foot of the card as one quiet line naming the
 * multiple, not as a band on five bars. */
import React, { useState } from "react";
import { Card, GROUP_DOTS, C, fmt, useTip, useRefMode, refWord, otherWord, pickRef } from "../ui.jsx";

/* The two columns are one inside the other: the reference nearly fills the slot,
 * the actual sits well inside it, so the tint reads on both sides of the orange
 * at every card width rather than only on a wide one. */
const REF_INSET = "6%";
const BAR_INSET = "27%";

export default function ChannelsVsTargets({ snap, horizon = "today" }) {
  const t = useTip();
  const mode = useRefMode();
  const [scale, setScale] = useState("pct");   // pct | units
  const rows = snap?.channels || [];
  // no targets: nothing to compare against, so units only and no toggle
  const targeted = !snap || snap.targeted !== false;
  const today = horizon !== "close";
  const pct = targeted ? scale === "pct" : false;
  const hasBm = targeted && !!snap?.benchmark;

  // Today compares actuals with the reference to date; at close compares the
  // projection with the full one (docs §5.4 / §9). Both references are carried
  // per column so the toggle can pick one and the other can still be named.
  const base = rows.map((c) => {
    const target = (today ? c.exp : c.target) ?? 0;
    const bar = (today ? c.now : c.proj) ?? 0;
    const bmRaw = today ? c.bmExp : c.bm;
    const bm = hasBm && bmRaw !== null && bmRaw !== undefined ? bmRaw : null;
    const ref = pickRef(mode, { bm, target });
    return {
      key: c.key, name: c.name, parts: c.parts || [], ref, bar, target, bm,
      other: mode === "benchmark" ? target : bm,
      pctOfRef: ref > 0 ? Math.round((bar / ref) * 100) : null,
    };
  });

  // one scale across the card: % normalises each channel to its own reference,
  // units keeps them comparable in secured units. The reference is in the scale,
  // so a column can never end up outside the plot.
  const val = (v, ref) => (pct ? (ref > 0 ? (v / ref) * 100 : 0) : v);
  const max = Math.max(
    ...base.map((r) => val(r.bar, r.ref)),
    ...base.map((r) => (pct ? 100 : r.ref)),
    1,
  ) * 1.02;
  const h = (v) => Math.max(0, Math.min((v / max) * 100, 100));

  const cols = base.map((r) => ({
    ...r,
    barH: h(val(r.bar, r.ref)),
    refH: h(pct ? 100 : r.ref),
  }));

  const fillColor = today ? C.orange : C.orangeLight;
  const fillLabel = today ? "To date" : "Projected";
  const refLabel = refWord(mode, horizon);
  const otherLabel = otherWord(mode, horizon);
  const unit = (v) => fmt(v, v < 10 && v > 0 ? 1 : 0);
  const k = snap?.benchmark?.k ?? null;

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
  const legendItem = { display: "flex", alignItems: "center", gap: 5 };

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
              const barTip = {
                head: today ? "Secured to date" : "Projected at close",
                rows: [
                  { label: "Units", value: unit(c.bar) },
                  ...(c.ref > 0 ? [{ label: refLabel, value: unit(c.ref) }] : []),
                ],
              };
              const refTip = {
                head: refLabel,
                rows: [
                  { label: "Units", value: unit(c.ref) },
                  ...(c.other !== null && c.other !== undefined
                    ? [{ label: otherLabel, value: unit(c.other) }] : []),
                ],
                body: mode === "benchmark"
                  ? "The median of the matched basket for this channel."
                  : undefined,
              };
              return (
                <div key={c.key} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  {targeted && c.ref > 0 && (
                    <div
                      {...t.props(refTip)}
                      style={{
                        position: "absolute", left: REF_INSET, right: REF_INSET, bottom: 0,
                        height: `${c.refH}%`, background: C.refFill, borderRadius: "4px 4px 0 0",
                      }}
                    />
                  )}
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
              const capped = c.pctOfRef !== null && c.pctOfRef > 999;
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
                      color: c.pctOfRef === null ? C.muted : c.pctOfRef >= 100 ? C.green : C.red,
                    }}
                  >
                    {c.pctOfRef === null ? "–" : (capped ? "›999%" : c.pctOfRef + "%")}
                  </div>
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 14, flex: "0 0 auto",
              marginTop: 4, paddingTop: 10, borderTop: `1px solid ${C.hairline}`,
              fontSize: 10.5, color: C.muted,
            }}
          >
            <span style={legendItem}><span style={swatch(fillColor)} />{fillLabel}</span>
            {targeted && <span style={legendItem}><span style={swatch(C.refFill)} />{refLabel}</span>}
            <span
              style={{ marginLeft: "auto" }}
              title={hasBm && k > 0
                ? "The even uplift the business put on the basket's median - the same multiple in every channel and on every day"
                : undefined}
            >
              {/* the stretch said once, in words, rather than drawn on five bars */}
              {hasBm && k > 0 ? "target is ×" + fmt(k, 2) + " the benchmark"
                : !targeted ? "secured units · no targets"
                : pct ? refLabel.toLowerCase() + " = 100%" : "secured units"}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
