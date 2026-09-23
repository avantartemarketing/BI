/* The page for a launch Airtable knows and the funnel report does not yet
 * (docs/DATA_MODEL.md 1.7): what is known about it - the dates, the edition,
 * the price, the works, where the project stands in Airtable - and the one
 * thing to do with it, which is to set its targets before it opens. There
 * are no actuals to draw, so this card stands in for the whole overview. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt, fmtMoney, fmtDay } from "../ui.jsx";

const day = (s) => (s ? fmtDay(new Date(s + "T00:00:00Z"), true) : "–");

export default function Upcoming({ snap, onSetup }) {
  const a = snap.airtable || {};
  const d = snap.derived || {};
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  const works = String(a.titles || "").split(" / ").filter(Boolean);
  const native = a.unit_price_native && a.currency_native && a.currency_native !== "EUR"
    ? ` (${a.currency_native} ${fmt(a.unit_price_native)} in Airtable)` : "";
  const daysToOpen = snap.windowStart && snap.asOf
    ? Math.round((new Date(snap.windowStart + "T00:00:00Z") - new Date(snap.asOf + "T00:00:00Z")) / 86400000) : null;
  return (
    <Card dot={GROUP_DOTS.outcome} title="Upcoming launch">
      <div className="spacer-8" />
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
        Known to Airtable, not yet to the funnel report: {daysToOpen !== null && daysToOpen > 0
          ? <>it opens in <b>{daysToOpen} day{daysToOpen === 1 ? "" : "s"}</b> and</>
          : <>it</>} closes <b>{day(snap.windowEnd)}</b>. Set its targets now; when the report starts carrying
        the launch, its actuals attach to them here.
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={row}><span style={{ color: C.muted }}>Private room opens</span><span className="num">{day(snap.privateRoomOpen)}</span></div>
        <div style={row}>
          <span style={{ color: C.muted }}>Announce</span>
          <span className="num" title={d.dates_note || undefined}>{day(snap.windowStart)}{d.dates_note ? " (assumed)" : ""}</span>
        </div>
        <div style={row}><span style={{ color: C.muted }}>Draw closes</span><span className="num">{day(snap.windowEnd)}</span></div>
        <div style={row}><span style={{ color: C.muted }}>Edition</span><span className="num">{a.edition_size ? `${fmt(a.edition_size)} units` : "–"}</span></div>
        <div style={row}>
          <span style={{ color: C.muted }}>Unit price</span>
          <span className="num" title="Converted to euros at the fixed table the panel uses; check it on the Set up targets tab">{a.unit_price ? fmtMoney(a.unit_price) + native : "–"}</span>
        </div>
        <div style={row}>
          <span style={{ color: C.muted }}>{works.length > 1 ? `Works (${works.length})` : "Work"}</span>
          <span style={{ textAlign: "right", maxWidth: 360 }}>{works.length ? works.join(" · ") : snap.title}</span>
        </div>
        <div style={row}>
          <span style={{ color: C.muted }}>Airtable</span>
          <span className="num">{[a.airtable_release, a.project_status, a.launch_type ? a.launch_type : "launch type not set"].filter(Boolean).join(" · ")}</span>
        </div>
        <div style={{ ...row, borderBottom: "none" }}>
          <span style={{ color: C.muted }}>Campaign code</span>
          <span className="num" title={d.campaign_code ? "Guessed from the codes the email and content feeds already use - correct it when you set targets" : "No code in the email or content feeds yet - type it when you set targets"}>
            {d.campaign_code ? `${d.campaign_code} (guessed)` : "none yet"}
          </span>
        </div>
      </div>
      {d.dates_note && (
        <div style={{ fontSize: 12, color: C.amber, lineHeight: 1.5, marginTop: 10 }}>{d.dates_note} - set the real one with the targets.</div>
      )}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={onSetup}>Set up targets</button>
      </div>
    </Card>
  );
}
