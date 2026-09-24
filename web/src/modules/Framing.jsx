/* Framing: frames per print, on the prints a frame was on offer for
 * (docs/DATA_MODEL.md 6.4). The headline counts the same units as the
 * sell-through card beside it, at the page's horizon: the paid prints and
 * the frames bought with them, the drafts awaiting payment and the frames on
 * them, and the draw's forecast conversions (at close the entries still to
 * come) at the rate the entrants ask for - so it sits between its two parts,
 * drawn below as bars on the dashboard's own scale: the paid prints, and the
 * prints the people still in the draw have pre-authorised. On each, the
 * plan's rate as the pale fill and the basket's median as the dotted
 * outline, the way every other bar on the page carries its two references.
 * A snapshot built before the forecast heads the card with the paid prints'
 * rate and says so. The card is off the page when nothing on the release has
 * been offered a frame. */
import React from "react";
import { Card, TrackBar, HorizonBadge, GROUP_DOTS, C, fmt, fmtPct, fmtSigned, useTip } from "../ui.jsx";

/* The legend's outline swatch: the same dotted silhouette the bar carries. */
const OUTLINE_SWATCH = (
  <svg className="swatch" width="12" height="10" viewBox="0 0 12 10" style={{ flex: "0 0 12px", borderRadius: 0 }} aria-hidden="true">
    <path d="M1 10 V1.5 H11 V10" fill="none" stroke={C.refLine} strokeWidth="1.5" strokeDasharray="1.6 1.6" />
  </svg>
);

const pts = (x) => Math.round(x * 100);

function Row({ label, sub, value, tip, children }) {
  const t = useTip();
  return (
    <div style={{ marginBottom: 10 }} {...t.props(tip, 300)}>
      <div style={{ display: "flex", alignItems: "baseline", fontSize: 12.5, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color: C.muted, marginLeft: 6 }}>{sub}</span>
        <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{value}</span>
      </div>
      {children}
    </div>
  );
}

export default function Framing({ snap, horizon = "today" }) {
  const f = snap.framing;
  const t = useTip();
  if (!f || (!(f.prints > 0) && !f.entrants)) return null;
  const close = horizon === "close";
  const rate = f.rate ?? null;   // the paid prints' own, the Buyers bar
  const plan = f.plan ?? null;
  const bench = f.benchmark || null;
  const bm = bench ? bench.rate : null;
  const ent = f.entrants;
  const notOffered = f.notOffered || { units: 0, works: [] };
  // the headline: the forecast on the sell-through's units at this horizon;
  // the paid prints' rate on a snapshot built before it
  const fc = f.forecast && f.forecast[close ? "close" : "today"];
  const head = fc && fc.prints > 0 && fc.rate !== null && fc.rate !== undefined ? fc : null;
  const headRate = head ? head.rate : rate;
  const delta = headRate !== null && plan !== null ? pts(headRate) - pts(plan) : null;
  const leftOut = head ? head.notOffered ?? 0 : notOffered.units;

  const leadTip = head ? {
    head: close ? "Frames per print at close" : "Frames per print",
    rows: (f.forecast.products || []).map((r) => {
      const x = r[close ? "close" : "today"];
      return { label: r.name, value: x && x.prints > 0 ? `${fmt(x.frames)} of ${fmt(x.prints)} · ${fmtPct(x.rate)}` : "–" };
    }),
    body: `On the prints the sell-through counts ${close ? "at close" : "today"}, where a frame is on offer: the paid prints and the frames bought with them, ` +
      "the drafts awaiting payment and the frames on them, and the draw winners the entries imply" +
      (close ? " and the entries still to come" : "") + ", at the rate the entrants ask for on their pre-authorisations. " +
      "A frame per print at most. Prints with no framing option are left out and counted in the key.",
  } : {
    head: "Frames per print",
    body: "The frames bought with the prints sold, over the prints sold that a frame was on offer for - a frame per print at most. " +
      "Prints with no framing option are left out of the rate and counted in the key.",
  };
  const worksTip = {
    head: "Frames per print on paid prints, by work",
    rows: (f.works || []).map((w) => ({ label: w.name, value: `${fmt(w.frames)} of ${fmt(w.prints)} · ${fmtPct(w.rate)}` })),
    body: notOffered.works.length ? `No frame on offer: ${notOffered.works.join(", ")}` : null,
  };
  const entTip = ent ? {
    head: "Entrants still in the draw",
    rows: [{ label: "Prints pre-authorised", value: fmt(ent.prints) }, { label: "With a frame", value: fmt(ent.frames) }],
    body: "The frame lines on the app's pre-authorisation drafts: the rate the prints still to be allocated will frame at if they win",
  } : null;
  const planTip = plan !== null ? {
    head: "Plan",
    body: `The economics assume ${fmtPct(plan)} of prints frame - the frame conversion on the Set up targets tab, or the panel default`,
  } : null;
  const bmTip = bench ? {
    head: "Benchmark",
    body: `The median frames per print over ${bench.n} of the basket's ${bench.of} launches with 30 or more prints on offer in the orders feed`,
  } : {
    head: "Benchmark",
    body: "No launch in the basket has enough framed orders in the feed to read a rate from",
  };

  return (
    <Card dot={GROUP_DOTS.outcome} title="Framing" badge={head ? <HorizonBadge horizon={horizon} /> : null}>
      <div className="spacer-8" />
      <div className="lead" {...t.props(leadTip, 300)}>
        <span>{headRate !== null ? fmtPct(headRate) : "–"}</span>
        {delta !== null && (
          <span className="delta" style={{ color: delta >= 0 ? C.green : C.red }}>{fmtSigned(delta)} pts vs plan</span>
        )}
      </div>
      <div className="lead-caption">
        {head
          ? <>of prints framed{close ? " at close" : ", forecast included"} · {fmt(head.frames)} of {fmt(head.prints)}</>
          : rate !== null
            ? <>of paid prints went out framed · {fmt(f.frames)} of {fmt(f.prints)}</>
            : <>no prints sold yet - the entrants' frames below</>}
      </div>
      <div style={{ marginTop: 14 }}>
        {rate !== null && (
          <Row label="Buyers" sub="paid prints" value={fmtPct(rate)} tip={worksTip}>
            <TrackBar now={rate} target={plan} bm={bm} max={1} />
          </Row>
        )}
        {ent && (
          <Row label="Entrants" sub="pre-authorised" value={fmtPct(ent.rate)} tip={entTip}>
            <TrackBar now={0} proj={ent.rate} target={plan} bm={bm} max={1} />
          </Row>
        )}
      </div>
      <div className="legend-rows">
        {plan !== null && (
          <div className="legend-row" {...t.props(planTip)}>
            <span className="swatch" style={{ background: C.refBase }} />
            <span style={{ color: C.muted }}>Plan</span>
            <span className="val">{fmtPct(plan)}</span>
          </div>
        )}
        <div className="legend-row" {...t.props(bmTip)}>
          {OUTLINE_SWATCH}
          <span style={{ color: C.muted }}>Benchmark{bench ? ` · ${bench.n} launches` : ""}</span>
          <span className="val">{bm !== null ? fmtPct(bm) : "–"}</span>
        </div>
        {Math.round(leftOut) > 0 && (
          <div className="legend-row" title={notOffered.works.length ? notOffered.works.join(", ") : undefined}>
            <span className="swatch" style={{ background: C.track }} />
            <span style={{ color: C.muted }}>No frame on offer</span>
            <span className="val">{fmt(leftOut)} units</span>
          </div>
        )}
      </div>
    </Card>
  );
}
