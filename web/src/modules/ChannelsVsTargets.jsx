/* Channels vs targets (spec §4.3, LE relabel per §6).
 * The four non-paid display groups, each on its own 120%-of-target track
 * (target tick fixed at 83.3%); right-hand text = proj / target + signed
 * delta % (ink when >= 0, red when negative). Tooltips per spec voice. */
import React from "react";
import { Card, TrackBar, GROUP_DOTS, C, fmt, MINUS } from "../ui.jsx";

export default function ChannelsVsTargets({ snap }) {
  const rows = (snap?.channels || []).filter((c) => c.key !== "paid");

  return (
    <Card
      dot={GROUP_DOTS.volume}
      title="Channels vs targets"
      right={<span style={{ whiteSpace: "nowrap" }}>at close</span>}
    >
      <div className="spacer-16" />
      <div className="body">
        {rows.length === 0 ? (
          <div className="empty-state">No channel data yet</div>
        ) : (
          rows.map((c) => {
            const now = c.now ?? 0;
            const exp = c.exp ?? 0;
            const proj = c.proj ?? 0;
            const target = c.target ?? 0;
            const dPct = target > 0 ? Math.round((proj / target - 1) * 100) : null;
            const deltaText =
              dPct === null ? "–" : (dPct >= 0 ? "+" : MINUS) + Math.abs(dPct) + "%";
            const overF = fmt(Math.max(0, proj - target));
            return (
              <div
                key={c.key}
                style={{
                  flex: 1, display: "flex", flexDirection: "column",
                  justifyContent: "center", gap: 4, minHeight: 0,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {c.name}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
                    <span className="num" style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
                      {fmt(proj)} / {fmt(target)}
                    </span>
                    <span
                      className="num"
                      style={{ fontSize: 12, fontWeight: 600, color: dPct !== null && dPct < 0 ? C.red : C.ink }}
                    >
                      {deltaText}
                    </span>
                  </div>
                </div>
                <TrackBar
                  now={now}
                  exp={exp > 0 ? exp : null}
                  proj={proj}
                  target={target}
                  height={20}
                  radius={5}
                  tips={{
                    proj: { head: "Projected at close", rows: [{ label: "Units", value: fmt(proj) }] },
                    now: { head: "Secured to date", rows: [{ label: "Units", value: fmt(now) }] },
                    exp: { head: "Expected by today", rows: [{ label: "Units", value: fmt(exp) }] },
                    overshoot: { head: "Over target", rows: [{ label: "Units", value: "+" + overF }] },
                    target: { head: "Target", rows: [{ label: "Units", value: fmt(target) }] },
                  }}
                />
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
