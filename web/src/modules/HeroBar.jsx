/* Units vs sellout - hero module (spec §4.1, unified secured-units currency, docs §6.4):
 * secured units = units sold (all routes incl. private room) + 0.8 × eligible entry
 * units not yet converted, capped at the edition size.
 *
 * One bar, one horizon, one reference, because the two page toggles have already
 * said which question the reader is asking. The bar is two layers: the chosen
 * reference as a tint running out from zero, the actual as a narrower orange bar
 * in front of it, on a track whose right edge is the sellout. The headline delta,
 * the label above the bar and the legend all name the same reference the tint
 * draws; the other one stays readable as a plain figure in the rows underneath,
 * where it is a number to know rather than a second thing to judge against.
 *
 * At close the actual becomes the projection and the hatch carries the demand
 * past the sellout that cannot convert. */
import React from "react";
import {
  Card, TrackBar, HATCH, GROUP_DOTS, C, fmt, fmtSigned, useTip, useWidth,
  labelPx, axisLabelLeft, useRefMode, refWord, otherWord, pickRef,
} from "../ui.jsx";

/* TrackBar's scale, repeated here so the floating labels land on the same one.
 * A label that drifts off the thing it names is worse than no label at all. */
function trackScale({ now, proj, ref, full }) {
  const maxData = Math.max(now ?? 0, proj ?? 0);
  const maxV = full > 0
    ? Math.max(full, ref ?? 0, maxData) * 1.02
    : Math.max(ref > 0 ? ref * 1.2 : 0, maxData * 1.04);
  const scale = maxV > 0 ? 100 / maxV : 0;
  return (v) => Math.max(0, Math.min((v ?? 0) * scale, 100));
}

export default function HeroBar({ snap, horizon = "today" }) {
  const hero = snap?.hero || {};
  if (snap && snap.targeted === false) return <HeroActuals snap={snap} />;
  const t = useTip();
  const mode = useRefMode();

  const close = horizon === "close";
  const now = hero.now ?? 0;
  const proj = hero.projected ?? 0;
  const sellout = hero.target ?? 0;
  const expToday = hero.expectedToday ?? 0;
  const day = snap?.day;

  // a release with no matched basket has no benchmark to switch to
  const hasBm = !!snap?.benchmark;
  const bmClose = hasBm ? hero.benchmark ?? null : null;
  const bmToday = hasBm ? hero.benchmarkToday ?? null : null;
  const bm = close ? bmClose : bmToday;

  // the target for this horizon: the target for today, the sellout at close
  const target = close ? sellout : expToday;
  const ref = pickRef(mode, { bm, target });
  const other = mode === "benchmark" ? target : bm;
  const fill = close ? proj : now;
  const delta = fill - ref;

  const refLabel = refWord(mode, horizon);
  const otherLabel = otherWord(mode, horizon);
  // at close the target IS the sellout, so naming it twice would be a lie about
  // there being two numbers
  const targetWord = close ? "Sellout" : `Target by day ${day}`;
  const refHead = mode === "benchmark"
    ? (close ? "Benchmark at close" : "Benchmark today")
    : targetWord;

  const pos = trackScale({
    now: close ? null : now, proj: close ? proj : null, ref, full: sellout,
  });
  const over = proj - sellout;
  const oversub = hero.oversubscribedUnits ?? 0;
  const overPct = sellout > 0 ? Math.round((proj / sellout) * 100) : null;

  const unitsTip =
    "Secured units = units sold (all routes incl. private room) + 0.8 × eligible " +
    "entry units not yet converted, capped at the edition size.";
  const refTip = {
    head: refHead,
    rows: [
      { label: "Units", value: fmt(ref) },
      ...(other !== null && other !== undefined
        ? [{ label: otherLabel, value: fmt(other) }] : []),
    ],
    body: mode === "benchmark"
      ? "The median of the matched basket - what launches like this one typically reach."
      : undefined,
  };

  const axisLabel = { position: "absolute", top: 4, fontSize: 12, whiteSpace: "nowrap" };

  /* The bar's own label rides above the reference it names. Centred on it
     wherever it fits, tucked against whichever end it would otherwise run off -
     a release near its edition puts the reference at the far right, and a label
     centred there is half outside the card. */
  const [labRef, labW] = useWidth();
  const refText = `${refLabel.toLowerCase()} ${fmt(ref)}`;
  const refLeft = axisLabelLeft({ pct: pos(ref), rowW: labW, textW: labelPx(refText) });

  return (
    <Card
      dot={GROUP_DOTS.volume}
      title="Units vs sellout"
      right={oversub > 0 ? (
        <span
          className="hint-dotted"
          {...t.props({ head: "Oversubscribed", rows: [{ label: "Surplus units", value: "+" + fmt(oversub) }] })}
        >
          oversubscribed +{fmt(oversub)}
        </span>
      ) : null}
    >
      <div className="spacer-8" />
      <div className="lead" {...t.props({ head: close ? "Projected demand" : "Secured units", body: unitsTip }, 300)}>
        {fmt(fill)}
        <span className="delta" style={{ color: delta >= 0 ? C.green : C.red }}>
          {fmtSigned(delta)}
        </span>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          vs {refLabel.toLowerCase()}
        </span>
      </div>

      <div style={{ marginTop: 24 }}>
        <div ref={labRef} style={{ position: "relative", height: 20, marginBottom: 8 }}>
          {ref > 0 && (
            <div
              {...t.props(refTip)}
              style={refLeft === null
                ? { position: "absolute", left: `${pos(ref)}%`, bottom: 0, transform: "translateX(-50%)", fontSize: 12, color: C.ink, whiteSpace: "nowrap" }
                : { position: "absolute", left: refLeft, bottom: 0, fontSize: 12, color: C.ink, whiteSpace: "nowrap" }}
            >
              {refText}
            </div>
          )}
        </div>

        <TrackBar
          now={close ? null : now}
          proj={close ? proj : null}
          refValue={ref}
          full={sellout}
          hatchFrom={close ? sellout : null}
          height={24}
          radius={5}
          tips={{
            proj: { head: "Projected at close", rows: [
              { label: "Units", value: fmt(proj) },
              ...(overPct !== null ? [{ label: "vs sellout", value: overPct + "%" }] : []),
            ] },
            now: { head: "Secured to date", rows: [{ label: "Units", value: fmt(now) }] },
            overshoot: { head: "Oversubscribed", rows: [{ label: "Units", value: "+" + fmt(Math.abs(over)) }] },
            ref: refTip,
          }}
        />

        <div style={{ position: "relative", height: 20, marginTop: 8 }}>
          <div style={{ ...axisLabel, left: 0, color: C.muted }}>0</div>
          <div style={{ ...axisLabel, right: 0, color: C.muted }}>
            {`sellout ${fmt(sellout)}`}
          </div>
        </div>
      </div>

      <div className="legend-rows">
        <div className="legend-row">
          <span className="swatch" style={{ background: close ? C.orangeLight : C.orange }} />
          <span style={{ color: C.muted }}>{close ? "Projected demand at close" : "To date"}</span>
          <span className="val">{fmt(fill)}</span>
        </div>
        <div className="legend-row">
          <span className="swatch" style={{ background: C.refFill }} />
          <span style={{ color: C.muted }}>{refLabel}</span>
          <span className="val">{fmt(ref)}</span>
        </div>
        {/* Third row, and only a third: demand past the sellout when there is
            any, because that is the more urgent fact and the hatch drawing it
            needs naming; otherwise the reference not chosen, as a figure to
            know rather than a second thing to judge against. */}
        {close && (oversub > 0 || over > 0) ? (
          <div className="legend-row">
            <span className="swatch" style={{ background: HATCH }} />
            <span style={{ color: C.muted }}>Over sellout</span>
            <span className="val">{oversub > 0 ? "+" + fmt(oversub) : fmtSigned(over)}</span>
          </div>
        ) : other !== null && other !== undefined ? (
          <div className="legend-row" style={{ color: C.muted }}>
            <span className="swatch" style={{ background: "transparent" }} />
            <span>{otherLabel}</span>
            <span className="val" style={{ fontWeight: 400 }}>{fmt(other)}</span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/* No targets: the number still means the same thing, there is just nothing
 * to measure it against. Sold and banked entries underneath, so the reader
 * can see what secured is made of. */
function HeroActuals({ snap }) {
  const t = useTip();
  const now = snap.hero?.now ?? 0;
  const sold = snap.sellthrough?.sold ?? 0;
  const banked = snap.sellthrough?.soldPredicted ?? 0;
  const unitsTip = "Secured units = units sold (all routes incl. private room) + 0.8 × eligible entry units not yet converted.";
  return (
    <Card dot={GROUP_DOTS.volume} title="Secured units">
      <div className="spacer-8" />
      <div className="lead" {...t.props({ head: "Secured units", body: unitsTip }, 300)}>
        {fmt(now)}
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          {snap.catalogue ? "last 90 days" : "to date"}
        </span>
      </div>
      <div className="lead-caption" style={{ color: C.muted }}>no target set - actuals only</div>
      <div className="legend-rows" style={{ marginTop: 20 }}>
        <div className="legend-row">
          <span className="swatch" style={{ background: C.rust }} />
          <span style={{ color: C.muted }}>Units sold</span>
          <span className="val">{fmt(sold)}</span>
        </div>
        <div className="legend-row">
          <span className="swatch" style={{ background: C.orange }} />
          <span style={{ color: C.muted }}>From entries in hand (× 0.8)</span>
          <span className="val">{fmt(banked)}</span>
        </div>
      </div>
    </Card>
  );
}
