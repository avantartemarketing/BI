/* Units vs sellout - hero module (spec §4.1, unified secured-units currency, docs §6.4):
 * secured units = units sold (all routes incl. private room) + 0.8 × eligible entry
 * units not yet converted, capped at the edition size.
 *
 * One bar, one horizon, both references (BENCHMARK_SPEC 7). The fill is the
 * target - darker from zero to whichever of target and benchmark is lower,
 * lighter from the benchmark up to the target when the target is the higher -
 * the benchmark is the dotted outline over it, and the actual is the narrower
 * orange bar in front, on a track whose right edge is the sellout. The two
 * references are named above the bar on two rows of their own, the benchmark
 * above the target, so neither ever prints through the other however close
 * they sit. The headline delta reads against the target: it is what the
 * business committed to.
 *
 * At close the actual becomes the projection and the hatch carries the demand
 * past the sellout that cannot convert. */
import React from "react";
import {
  Card, TrackBar, HATCH, GROUP_DOTS, C, fmt, fmtSigned, useTip, useWidth,
  labelPx, axisLabelLeft, refWords,
} from "../ui.jsx";

/* The legend's outline swatch: the same dotted silhouette the bar carries. */
const OUTLINE_SWATCH = (
  <svg className="swatch" width="12" height="10" viewBox="0 0 12 10" style={{ flex: "0 0 12px", borderRadius: 0 }} aria-hidden="true">
    <path d="M1 10 V1.5 H11 V10" fill="none" stroke={C.refLine} strokeWidth="1.5" strokeDasharray="1.6 1.6" />
  </svg>
);

/* TrackBar's scale, repeated here so the floating labels land on the same one.
 * A label that drifts off the thing it names is worse than no label at all. */
function trackScale({ now, proj, target, bm, full }) {
  const maxData = Math.max(now ?? 0, proj ?? 0);
  const refMax = Math.max(target ?? 0, bm ?? 0);
  const maxV = full > 0
    ? Math.max(full, refMax, maxData) * 1.02
    : Math.max(refMax > 0 ? refMax * 1.2 : 0, maxData * 1.04);
  const scale = maxV > 0 ? 100 / maxV : 0;
  return (v) => Math.max(0, Math.min((v ?? 0) * scale, 100));
}

export default function HeroBar({ snap, horizon = "today" }) {
  const hero = snap?.hero || {};
  if (snap && snap.targeted === false) return <HeroActuals snap={snap} />;
  const t = useTip();

  const close = horizon === "close";
  const now = hero.now ?? 0;
  const proj = hero.projected ?? 0;
  const sellout = hero.target ?? 0;
  const expToday = hero.expectedToday ?? 0;
  const day = snap?.day;
  const words = refWords(horizon);
  // the target is only part of the edition (Warhol: 2,440 of 6,100): the card
  // says target where it would otherwise say sellout
  const partial = !!(snap?.edition && snap.edition.total > snap.edition.target);
  const editionTotal = partial ? snap.edition.total : null;

  // the outline only exists when the release has a basket behind it
  const hasBm = !!snap?.benchmark;
  const bmClose = hasBm ? hero.benchmark ?? null : null;
  const bmToday = hasBm ? hero.benchmarkToday ?? null : null;
  const bm = close ? bmClose : bmToday;
  const k = snap?.benchmark?.k ?? null;

  // the target for this horizon: the target for today, the sellout at close
  const target = close ? sellout : expToday;
  const fill = close ? proj : now;
  const delta = fill - target;
  const stretch = bm === null ? null : target - bm;

  const pos = trackScale({
    now: close ? null : now, proj: close ? proj : null, target, bm, full: sellout,
  });
  const over = proj - sellout;
  const oversub = hero.oversubscribedUnits ?? 0;
  const overPct = sellout > 0 ? Math.round((proj / sellout) * 100) : null;

  const unitsTip =
    "Secured units = units sold (all routes incl. private room) + 0.8 × eligible " +
    "entry units not yet converted, capped at the edition size.";
  const refRows = [
    { label: words.target, value: fmt(target) },
    ...(bm !== null ? [{ label: words.bm, value: fmt(bm) }] : []),
  ];
  const targetTip = {
    // at close the target IS the sellout, so it is named as that
    head: close ? (partial ? `Target · ${Math.round((100 * sellout) / editionTotal)}% of the ${fmt(editionTotal)} edition` : "Sellout") : `Target by day ${day}`,
    rows: refRows,
  };
  const stretchTip = bm === null ? null : {
    head: "Stretch",
    rows: [
      ...refRows,
      { label: "Stretch", value: fmtSigned(stretch) },
      ...(k ? [{ label: "Uplift", value: "×" + fmt(k, 2) }] : []),
    ],
    body: "What the business is asking for over and above the basket - the same even uplift in every channel and on every day.",
  };
  const bmTip = bm === null ? null : {
    head: close ? "Benchmark at close" : "Benchmark today",
    rows: refRows,
    body: "The median of the matched basket - what launches like this one typically reach.",
  };

  const axisLabel = { position: "absolute", top: 4, fontSize: 12, whiteSpace: "nowrap" };

  /* Two label rows above the bar, the benchmark on the upper and the target on
     the lower, each centred on the thing it names and tucked against whichever
     end it would otherwise run off. Two rows because the two figures are often
     within a few pixels of each other, and a label printed through another
     number says less than no label. */
  const [labRef, labW] = useWidth();
  const labelAt = (text, v) => {
    const left = axisLabelLeft({ pct: pos(v), rowW: labW, textW: labelPx(text) });
    return left === null
      ? { position: "absolute", left: `${pos(v)}%`, bottom: 0, transform: "translateX(-50%)", fontSize: 12, whiteSpace: "nowrap" }
      : { position: "absolute", left, bottom: 0, fontSize: 12, whiteSpace: "nowrap" };
  };
  const targetText = `${words.target.toLowerCase()} ${fmt(target)}`;
  const bmText = bm === null ? "" : `${words.bm.toLowerCase()} ${fmt(bm)}`;

  return (
    <Card
      dot={GROUP_DOTS.volume}
      title={partial ? "Units vs target" : "Units vs sellout"}
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
          {close ? (partial ? "vs target at close" : "vs sellout at close") : "vs target today"}
        </span>
      </div>

      <div style={{ marginTop: 14 }}>
        <div ref={labRef} style={{ position: "relative", height: 17 }}>
          {bm !== null && bm > 0 && (
            <div {...t.props(bmTip)} style={{ ...labelAt(bmText, bm), color: C.muted }}>{bmText}</div>
          )}
        </div>
        <div style={{ position: "relative", height: 19, marginBottom: 6 }}>
          {target > 0 && (
            <div {...t.props(targetTip)} style={{ ...labelAt(targetText, target), color: C.ink }}>{targetText}</div>
          )}
        </div>

        <TrackBar
          now={close ? null : now}
          proj={close ? proj : null}
          target={target}
          bm={bm}
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
            target: targetTip,
            base: bm !== null && bm < target ? bmTip : targetTip,
            stretch: stretchTip,
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
        <div className="legend-row" {...t.props(stretchTip || targetTip)}>
          <span className="swatch" style={{ background: C.refBase }} />
          <span style={{ color: C.muted }}>{words.target}</span>
          <span className="val">{fmt(target)}</span>
        </div>
        {/* Third row, and only a third: demand past the sellout when there is
            any, because that is the more urgent fact and the hatch drawing it
            needs naming; otherwise the benchmark, which the label above the bar
            already places. */}
        {close && (oversub > 0 || over > 0) ? (
          <div className="legend-row">
            <span className="swatch" style={{ background: HATCH }} />
            <span style={{ color: C.muted }}>Over sellout</span>
            <span className="val">{oversub > 0 ? "+" + fmt(oversub) : fmtSigned(over)}</span>
          </div>
        ) : bm !== null ? (
          <div className="legend-row" {...t.props(bmTip)}>
            {OUTLINE_SWATCH}
            <span style={{ color: C.muted }}>{words.bm}</span>
            <span className="val">{fmt(bm)}</span>
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
