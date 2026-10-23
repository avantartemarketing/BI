/* The page for a launch Airtable knows and the funnel report does not yet
 * (docs/DATA_MODEL.md 1.7): there are no actuals to draw, so the page says
 * it is not live, offers the one thing to do (set its targets before it
 * opens), and lists what is known: the milestones (the private room, the
 * announce, which may be assumed, and the close) and the details from
 * Airtable (the works, the edition, the price, the project's status and
 * the campaign code guessed from the feeds). Fills the plain body. */
import React from "react";
import { fmt, fmtMoney, fmtDay } from "../format.mjs";
import { Loz } from "../ui.jsx";
import { Ring, Diamond, Cal } from "../icons.jsx";
import "../cards.css";

const day = (s) => (s ? fmtDay(new Date(s + "T00:00:00Z"), true) : "–");

export default function Upcoming({ snap, onSetup }) {
  const a = snap.airtable || {};
  const d = snap.derived || {};
  // "assumed" only where the announce is a stand-in; a page built before
  // the flag says so in its note's opening words
  const assumed = d.dates_assumed ?? /^announce date assumed/.test(d.dates_note || "");
  const works = String(a.titles || "").split(" / ").filter(Boolean);
  const native = a.unit_price_native && a.currency_native && a.currency_native !== "EUR" ? ` (${a.currency_native} ${fmt(a.unit_price_native)} in Airtable)` : "";
  const daysToOpen = snap.windowStart && snap.asOf ? Math.round((new Date(snap.windowStart + "T00:00:00Z") - new Date(snap.asOf + "T00:00:00Z")) / 86400000) : null;
  const tl = snap.type === "TL";
  const miles = [
    ...(snap.privateRoomOpen ? [{ n: "Private room", d: day(snap.privateRoomOpen) }] : []),
    { n: "Announce", d: day(snap.windowStart), warn: assumed, tip: d.dates_note || undefined },
    ...(tl && snap.windowOpen ? [{ n: "Sales open", d: day(String(snap.windowOpen).slice(0, 10)) }] : []),
    { n: tl ? "Window closes" : "Draw closes", d: day(snap.windowEnd) },
  ];
  const facts = [
    { l: works.length > 1 ? `Works (${works.length})` : "Work", v: works.length ? works.join(" · ") : snap.title || "–" },
    { l: "Edition", v: a.edition_size ? `${fmt(a.edition_size)} units` : "–" },
    { l: "Price", v: a.unit_price ? fmtMoney(a.unit_price) + native : "–", tip: "Converted to euros at the fixed table the panel uses; check it on the Targets tab" },
    { l: "Airtable", v: [a.airtable_release, a.project_status, a.launch_type || "launch type not set"].filter(Boolean).join(" · ") || "–" },
    { l: "Campaign code", v: d.campaign_code || "none yet", tag: d.campaign_code ? "Guessed" : null,
      tip: d.campaign_code ? "Guessed from the codes the email and content feeds already use: correct it when you set targets" : "No code in the email or content feeds yet: type it when you set targets" },
  ];
  const targeted = snap.targeted !== false && !!(snap.hero && snap.hero.target > 0);
  return (
    <div className="upc">
      <div className="state-card">
        <Ring w={36} />
        <div className="big">Not live yet</div>
        <div className="sub">
          Figures start when the funnel report carries this release{daysToOpen !== null && daysToOpen > 0 ? `: it announces in ${daysToOpen} day${daysToOpen === 1 ? "" : "s"}` : ""} and closes {day(snap.windowEnd)}
        </div>
        <div className="btns">
          {targeted ? <span className="loz good">Targets set</span> : <button className="sbtn prim" onClick={onSetup} title="Set its targets now; when the report starts carrying the launch, its actuals attach to them here">Set targets</button>}
          {a.url && <a className="sbtn" href={a.url} target="_blank" rel="noreferrer">Open in Airtable</a>}
        </div>
      </div>
      {!targeted && <div style={{ fontSize: 12.5, color: "#8a8a8e", textAlign: "center", marginTop: 10 }}>No targets yet</div>}
      <div className="ch">Milestones<Loz kind="ghost">{miles.length}</Loz></div>
      <div className="list">
        {miles.map((m) => (
          <div className="prow" key={m.n} title={m.tip}>
            <span className="ic"><Diamond filled={false} /></span><span className="l">{m.n}</span>
            <span className="v">{m.warn && <Loz kind="warm" tip={d.dates_note || "No announce date in Airtable; a date before the close is assumed"}>Assumed</Loz>}<Loz><Cal w={12} />{m.d}</Loz></span>
          </div>
        ))}
      </div>
      {d.dates_note && <div style={{ fontSize: 12, color: "#8a5f00", lineHeight: 1.5, marginTop: 10 }}>{d.dates_note}: set the real one with the targets.</div>}
      <div className="ch">Details</div>
      <div className="list">
        {facts.map((f) => (
          <div className="prow fact" key={f.l} title={f.tip}>
            <span className="l">{f.l}</span><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.v}</span>
            <span className="v">{f.tag && <Loz kind="ghost">{f.tag}</Loz>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
