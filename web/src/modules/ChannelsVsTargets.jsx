/* Channels vs targets (spec §4.3, LE relabel per §6; reference grammar per
 * BENCHMARK_SPEC 1, 2 and 7) - column form.
 *
 * All five display groups (paid included) as columns rising from a baseline. Each column
 * carries one fill - what this horizon is being judged on - crossed by the two reference
 * marks: the ink line at the target and the cobalt line at what the matched basket
 * typically reaches. The old pale target block is gone with it: a block can only say
 * "over" or "under" by which colour shows at the top, and it cannot hold two references
 * at once. A line can, and it reads the same whether the fill is above it or below it,
 * which is why the fill is inset and the lines run the full column width.
 *
 * One toggle only. BENCHMARK_SPEC 2 moves Today | At close to the page header, so the
 * horizon arrives as a prop and the card keeps just:
 *   % | Units  - % puts every channel against its own target on one 100% scale, so the
 *                ink lines align into a shared reference across the card; Units keeps
 *                real magnitudes, so each column is that channel's own size.
 * Foot per column: the fill as a % of this horizon's target, green at or above and red
 * below. The per-column stretch is not printed - it is the same even uplift in every
 * column (spec §1), so it belongs in the legend once, not five times. */
import React, { useState } from "react";
import { Card, GROUP_DOTS, RefTick, C, fmt, fmtSigned, useTip } from "../ui.jsx";

const BAR_INSET = "8%";   // fill inset so both reference lines clear it either side

export default function ChannelsVsTargets({ snap, horizon = "today" }) {
  const t = useTip();
  const [scale, setScale] = useState("pct");   // pct | units
  const rows = snap?.channels || [];
  // no targets: nothing to compare against, so units only and no toggle
  const targeted = !snap || snap.targeted !== false;
  const today = horizon !== "close";
  const pct = targeted ? scale === "pct" : false;
  const hasBm = targeted && !!snap?.benchmark;

  // Today compares actuals with the target to date; at close compares the projection
  // with the full target (docs §5.4 / §9). The benchmark for the same horizon rides
  // along, absent when the release has no basket.
  const base = rows.map((c) => {
    const ref = (today ? c.exp : c.target) ?? 0;
    const bar = (today ? c.now : c.proj) ?? 0;
    const bmRaw = today ? c.bmExp : c.bm;
    const bm = hasBm && bmRaw !== null && bmRaw !== undefined ? bmRaw : null;
    return {
      key: c.key, name: c.name, parts: c.parts || [], ref, bar, bm,
      pctOfRef: ref > 0 ? Math.round((bar / ref) * 100) : null,
    };
  });

  // one scale across the card: % normalises each channel to its own target, units keeps
  // them comparable in secured units. Both references are in the scale, so a line can
  // never end up outside the plot.
  const val = (v, ref) => (pct ? (ref > 0 ? (v / ref) * 100 : 0) : v);
  const max = Math.max(
    ...base.map((r) => val(r.bar, r.ref)),
    ...base.map((r) => (pct ? 100 : r.ref)),
    ...base.map((r) => (r.bm === null ? 0 : val(r.bm, r.ref))),
    1,
  ) * 1.02;
  const h = (v) => Math.max(0, Math.min((v / max) * 100, 100));

  const cols = base.map((r) => ({
    ...r,
    barH: h(val(r.bar, r.ref)),
    refH: h(pct ? 100 : r.ref),
    bmH: r.bm === null ? null : h(val(r.bm, r.ref)),
  }));

  const fillColor = today ? C.orange : C.orangeLight;
  const fillLabel = today ? "To date" : "Projected";
  const refLabel = today ? "Target today" : "Target";
  const bmLabel = today ? "Benchmark today" : "Benchmark";
  const unit = (v) => fmt(v, v < 10 && v > 0 ? 1 : 0);
  const stretchPct = snap?.benchmark?.stretchPct;

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
  const lineSwatch = (bg) => ({ width: 12, height: 2, background: bg, flex: "0 0 12px" });
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
              const barTip = today
                ? { head: "Secured to date", rows: [
                    { label: "Units", value: unit(c.bar) },
                    ...(c.ref > 0 ? [{ label: refLabel, value: unit(c.ref) }] : []),
                  ] }
                : { head: "Projected at close", rows: [
                    { label: "Units", value: unit(c.bar) },
                    ...(c.ref > 0 ? [{ label: "Target", value: unit(c.ref) }] : []),
                  ] };
              const refTip = { head: refLabel, rows: [{ label: "Units", value: unit(c.ref) }] };
              const bmTip = {
                head: bmLabel,
                rows: [
                  { label: "Units", value: unit(c.bm ?? 0) },
                  ...(c.ref > 0 && c.bm !== null
                    ? [{ label: "Stretch", value: fmtSigned(c.ref - c.bm) }] : []),
                ],
                body: "The median of the matched basket for this channel.",
              };
              return (
                <div key={c.key} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  <div
                    {...t.props(barTip)}
                    style={{
                      position: "absolute", left: BAR_INSET, right: BAR_INSET, bottom: 0,
                      height: `${c.barH}%`, background: fillColor, borderRadius: 3,
                    }}
                  />
                  {c.bmH !== null && (
                    <RefTick pct={c.bmH} kind="benchmark" vertical={false} tip={bmTip} />
                  )}
                  {targeted && c.ref > 0 && (
                    <RefTick pct={c.refH} kind="target" vertical={false} tip={refTip} />
                  )}
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
            {targeted && <span style={legendItem}><span style={lineSwatch(C.ink)} />{refLabel}</span>}
            {hasBm && <span style={legendItem}><span style={lineSwatch(C.cobalt)} />{bmLabel}</span>}
            <span style={{ marginLeft: "auto" }}>
              {hasBm && stretchPct !== null && stretchPct !== undefined
                ? "stretch " + fmtSigned(stretchPct * 100) + "%"
                : !targeted ? "secured units · no targets" : pct ? "target = 100%" : "secured units"}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
