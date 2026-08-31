/* Channels vs targets (spec §4.3, LE relabel per §6) - column form.
 *
 * All five display groups (paid included) as columns rising from a baseline.
 * The TARGET is a wide pale block behind a narrower bar, so it stays readable
 * when a bar overtakes it: the block's shoulders show either side, and the
 * block shows above the bar when a channel is short. Colour above the block
 * top = over the reference.
 *
 * Two toggles, both defaulting to the left option:
 *   Today | At close  - actuals vs where the plan says we should be by now,
 *                       or the projection vs the full target (only "at close"
 *                       carries a projected band).
 *   % | Units         - % puts every channel on one 100% scale, so the pale
 *                       blocks line up into a shared reference across the card;
 *                       Units keeps real magnitudes, so each block is that
 *                       channel's own target drawn to scale.
 * Right-hand delta per column: proj (or actual) vs its reference, green when
 * at or above, red below. */
import React, { useState } from "react";
import { Card, GROUP_DOTS, C, fmt, MINUS, useTip } from "../ui.jsx";

const BAR_INSET = "19%";   // bar is narrower than the target block behind it

export default function ChannelsVsTargets({ snap }) {
  const t = useTip();
  const [when, setWhen] = useState("today");   // today | close
  const [scale, setScale] = useState("pct");   // pct | units
  const rows = snap?.channels || [];
  const today = when === "today";
  const pct = scale === "pct";

  // Today compares actuals with the plan to date; at close compares the
  // projection with the full target (docs §5.4 / §9).
  const base = rows.map((c) => {
    const ref = (today ? c.exp : c.target) ?? 0;
    const bar = (today ? c.now : c.proj) ?? 0;
    const now = c.now ?? 0;
    return {
      key: c.key, name: c.name, parts: c.parts || [], ref, bar, now,
      delta: ref > 0 ? Math.round((bar / ref - 1) * 100) : null,
    };
  });

  // one scale across the card: % normalises each channel to its own reference,
  // units keeps them comparable in secured units
  const val = (v, ref) => (pct ? (ref > 0 ? (v / ref) * 100 : 0) : v);
  const max = Math.max(
    ...base.map((r) => val(r.bar, r.ref)),
    ...base.map((r) => (pct ? 100 : r.ref)),
    1,
  ) * 1.02;
  const h = (v) => Math.max(0, Math.min((v / max) * 100, 100));

  const cols = base.map((r) => ({
    ...r,
    refH: h(pct ? 100 : r.ref),
    barH: h(val(r.bar, r.ref)),
    nowH: h(val(r.now, r.ref)),
  }));

  const refLabel = today ? "Expected today" : "Target";
  const unit = (v) => fmt(v, v < 10 && v > 0 ? 1 : 0);

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
      title="Channels vs targets"
    >
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, margin: "10px 0 12px", flex: "0 0 auto" }}>
        {seg(
          [["today", "Today", "Secured so far vs what the plan expects by today"],
           ["close", "At close", "Projected at close vs the full target"]],
          when, setWhen,
        )}
        {seg(
          [["pct", "%", "Every channel against its own reference, on one 100% scale"],
           ["units", "Units", "Secured units, so channels are comparable in size"]],
          scale, setScale,
        )}
      </div>
      {cols.length === 0 ? (
        <div className="empty-state">No channel data yet</div>
      ) : (
        <div className="body" style={{ gap: 6 }}>
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", gap: 8 }}>
            {cols.map((c) => {
              const refTip = {
                head: refLabel,
                rows: [{ label: "Units", value: unit(c.ref) }],
              };
              const nowTip = { head: "Secured to date", rows: [{ label: "Units", value: unit(c.now) }] };
              const barTip = today ? nowTip : {
                head: "Projected at close",
                rows: [
                  { label: "Units", value: unit(c.bar) },
                  { label: "Target", value: unit(c.ref) },
                ],
              };
              return (
                <div key={c.key} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  <div
                    {...t.props(refTip)}
                    style={{
                      position: "absolute", left: 0, right: 0, bottom: 0,
                      height: `${c.refH}%`, background: C.track, borderRadius: 4,
                    }}
                  />
                  {!today && (
                    <div
                      {...t.props(barTip)}
                      style={{
                        position: "absolute", left: BAR_INSET, right: BAR_INSET, bottom: 0,
                        height: `${c.barH}%`, background: C.orangeLight, borderRadius: 3,
                      }}
                    />
                  )}
                  <div
                    {...t.props(nowTip)}
                    style={{
                      position: "absolute", left: BAR_INSET, right: BAR_INSET, bottom: 0,
                      height: `${c.nowH}%`, background: C.orange, borderRadius: 3,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {cols.map((c) => (
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
                    color: c.delta === null ? C.muted : c.delta >= 0 ? C.green : C.red,
                  }}
                >
                  {c.delta === null ? "–" : (c.delta >= 0 ? "+" : MINUS) + Math.abs(c.delta) + "%"}
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 14, flex: "0 0 auto",
              marginTop: 4, paddingTop: 10, borderTop: `1px solid ${C.hairline}`,
              fontSize: 10.5, color: C.muted,
            }}
          >
            <span style={legendItem}><span style={swatch(C.orange)} />To date</span>
            {!today && <span style={legendItem}><span style={swatch(C.orangeLight)} />Projected</span>}
            <span style={legendItem}><span style={swatch(C.track)} />{refLabel}</span>
            <span style={{ marginLeft: "auto" }}>{pct ? "reference = 100%" : "secured units"}</span>
          </div>
        </div>
      )}
    </Card>
  );
}
