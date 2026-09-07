/* Shown in place of the target-driven modules on a release nobody has set
 * targets for. Says what the page is showing (actuals from the funnel feed),
 * what it is not (expected-today, projections, paid ROI, sell-through), where
 * the dates came from, and how to turn the model on. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt } from "../ui.jsx";

export default function NoTargets({ snap, onSetup }) {
  const d = snap.derived || {};
  const t = snap.totals || {};
  const dated = !!snap.windowEnd;
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  return (
    <Card dot={GROUP_DOTS.outcome} title="No targets set">
      <div className="spacer-8" />
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
        {dated
          ? <>Dates come from the funnel export's campaign clock: announced <b>{d.announce_date}</b>, closes <b>{d.launch_end}</b>. They can be a day out - check them when you set targets.</>
          : <>No campaign dates in the funnel export for this release, so it is shown as a catalogue item: the last 90 days of traffic{d.dates_note ? ` (${d.dates_note})` : ""}.</>}
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={row}><span style={{ color: C.muted }}>Sessions in window</span><span className="num">{fmt(t.sessions ?? 0)}</span></div>
        <div style={row}><span style={{ color: C.muted }}>Eligible entries</span><span className="num">{fmt(t.entries ?? 0)}</span></div>
        <div style={row}><span style={{ color: C.muted }}>Units sold</span><span className="num">{fmt(t.units ?? 0)}</span></div>
        <div style={{ ...row, borderBottom: "none" }}>
          <span style={{ color: C.muted }}>Campaign code</span>
          <span className="num" title={d.campaign_code ? "Guessed from the email and content feeds by artist and year - correct it in Target setting if it is wrong" : "None found in the email or content feeds"}>
            {d.campaign_code ? `${d.campaign_code} (guessed)` : "none matched"}
          </span>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginTop: 12 }}>
        Expected-today, projections, paid ROI and sell-through need an edition size, price and profit split.
      </div>
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={onSetup}>Set up targets</button>
      </div>
    </Card>
  );
}
