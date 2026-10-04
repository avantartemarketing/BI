/* Framing: frames per print, on the prints a frame was on offer for
 * (docs/DATA_MODEL.md 6.4). The headline counts the same units as the
 * sell-through card beside it, at the page's horizon: the paid prints and
 * the frames bought with them, the drafts awaiting payment and the frames on
 * them, and the draw's forecast conversions at the rate the entrants ask
 * for. Below it, its two parts as bars on the dashboard's own scale, each
 * with its number: the paid prints, and the prints the people still in the
 * draw have pre-authorised (on a timed launch, docs/TL_SPEC.md §5, the
 * window's orders awaiting payment). No plan and no benchmark: the card
 * reads what is, and nothing on it is a target (3 October 2026). A snapshot
 * built before the forecast heads the card with the paid prints' rate. The
 * card is off the page when nothing on the release has been offered a
 * frame. */
import React from "react";
import { Card, TrackBar, HorizonBadge, GROUP_DOTS, C, fmt, fmtPct, useTip } from "../ui.jsx";
import { Ex } from "../explain/Explain.jsx";

function Row({ label, sub, value, tip, x, children }) {
  const t = useTip();
  return (
    <div style={{ marginBottom: 10 }} {...t.props(tip, 300)}>
      <div style={{ display: "flex", alignItems: "baseline", fontSize: 12.5, marginBottom: 5 }}>
        <span>{label}</span>
        <span style={{ color: C.muted, marginLeft: 6 }}>{sub}</span>
        <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{x ? <Ex k={x}>{value}</Ex> : value}</span>
      </div>
      {children}
    </div>
  );
}

export default function Framing({ snap, horizon = "today" }) {
  const f = snap.framing;
  const t = useTip();
  if (!f || (!(f.prints > 0) && !f.entrants)) return null;
  // a timed launch (docs/TL_SPEC.md §5): the window's paid prints and the
  // orders awaiting payment, no draw and no forecast
  const tl = !!f.tl;
  const close = horizon === "close";
  const rate = f.rate ?? null;   // the paid prints' own, the Buyers bar
  const ent = f.entrants;
  const notOffered = f.notOffered || { units: 0, works: [] };
  // the headline: the forecast on the sell-through's units at this horizon;
  // the paid prints' rate on a snapshot built before it
  const fc = f.forecast && f.forecast[close ? "close" : "today"];
  const head = fc && fc.prints > 0 && fc.rate !== null && fc.rate !== undefined ? fc : null;
  const headRate = head ? head.rate : rate;
  const leftOut = head ? head.notOffered ?? 0 : notOffered.units;

  const leadTip = head ? {
    head: close ? "Frames per print at close" : "Frames per print",
    rows: (f.forecast.products || []).map((r) => {
      const x = r[close ? "close" : "today"];
      return { label: r.name, value: x && x.prints > 0 ? `${fmt(x.frames)} of ${fmt(x.prints)} · ${fmtPct(x.rate)}` : "–" };
    }),
    body: `Frames on the prints the sell-through counts ${close ? "at close" : "today"}: paid, awaiting payment and expected from the draw. A frame per print at most.`,
  } : {
    head: "Frames per print",
    body: "Frames bought with the prints sold, over the prints a frame was on offer for.",
  };
  const worksTip = {
    head: "Paid prints, by work",
    rows: (f.works || []).map((w) => ({ label: w.name, value: `${fmt(w.frames)} of ${fmt(w.prints)} · ${fmtPct(w.rate)}` })),
    body: notOffered.works.length ? `No frame on offer: ${notOffered.works.join(", ")}` : null,
  };
  const entTip = ent ? (tl ? {
    head: "Awaiting payment",
    rows: [{ label: "Prints on orders not yet paid", value: fmt(ent.prints) }, { label: "With a frame", value: fmt(ent.frames) }],
    body: "The frames on the window's orders awaiting payment.",
  } : {
    head: "Entrants still in the draw",
    rows: [{ label: "Prints pre-authorised", value: fmt(ent.prints) }, { label: "With a frame", value: fmt(ent.frames) }],
    body: "The frames on the draw's pre-authorisations.",
  }) : null;

  return (
    <Card dot={GROUP_DOTS.outcome} title="Framing" badge={head ? <HorizonBadge horizon={horizon} /> : null}>
      <div className="spacer-8" />
      <div className="lead" {...t.props(leadTip, 300)}>
        <span>{headRate !== null ? <Ex k="framing.head" arg={{ close }} focus>{fmtPct(headRate)}</Ex> : "–"}</span>
      </div>
      <div className="lead-caption">
        {head
          ? <>{fmt(head.frames)} of {fmt(head.prints)} prints framed{close ? " at close" : ""}</>
          : rate !== null
            ? <>{fmt(f.frames)} of {fmt(f.prints)} paid prints framed</>
            : <>no prints sold yet</>}
      </div>
      <div style={{ marginTop: 14 }}>
        {rate !== null && (
          <Row label="Buyers" sub="paid prints" value={fmtPct(rate)} tip={worksTip} x="framing.buyers">
            <TrackBar now={rate} max={1} />
          </Row>
        )}
        {ent && (
          <Row label={f.entrantsLabel || "Entrants"} sub={f.entrantsSub || "pre-authorised"} value={fmtPct(ent.rate)} tip={entTip} x="framing.entrants">
            <TrackBar now={0} proj={ent.rate} max={1} />
          </Row>
        )}
      </div>
      {Math.round(leftOut) > 0 && (
        <div className="legend-rows tight">
          <div className="legend-row" title={notOffered.works.length ? notOffered.works.join(", ") : undefined}>
            <span className="swatch" style={{ background: C.track }} />
            <span style={{ color: C.muted }}>No frame on offer</span>
            <span className="val">{fmt(leftOut)} units</span>
          </div>
        </div>
      )}
    </Card>
  );
}
