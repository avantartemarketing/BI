/* Units vs sellout - hero module (spec §4.1, unified secured-units currency, docs §6.4;
 * reference grammar per BENCHMARK_SPEC 1, 2 and 7):
 * secured units = units sold (all routes incl. private room) + 0.8 × eligible entry
 * units not yet converted, capped at the edition size.
 *
 * One bar, one horizon at a time, because the page toggle already says which question
 * the reader is asking. Today reads the fill to date against the target for today (ink)
 * and the benchmark for today (cobalt); At close reads the projection against the
 * sellout and the benchmark for the campaign, with the hatch carrying demand that
 * cannot convert. The two reference marks are the same 2px mark in two colours, so the
 * only thing separating them is the label - which is why the numbers sit next to the
 * ticks rather than in the legend.
 *
 * The stretch row is the whole point of the benchmark model: it names what the business
 * is asking for over and above what the matched basket typically delivers. It is the
 * one legend row that disappears when snap.benchmark is absent, and with it every cobalt
 * mark, leaving the card exactly as it read before. */
import React from "react";
import { Card, TrackBar, HATCH, GROUP_DOTS, C, fmt, fmtSigned, useTip } from "../ui.jsx";

// The stretch is a planning decision, not performance, so its legend swatch
// takes the same grey hatch the waterfall gives the stretch bar. The
// benchmark's own colour here would read as a third reference on the bar.
const STRETCH_HATCH = `repeating-linear-gradient(135deg, ${C.targetLine} 0 1px, transparent 1px 4px)`;

/* TrackBar keeps its own scale (120% of the ink reference, widened when a value
 * overflows). The floating tick labels have to land on the same scale, so the maths is
 * repeated here rather than guessed at - a label that drifts off its tick is worse than
 * no label at all. */
function trackScale({ now, proj, target, bm }) {
  const maxData = Math.max(now ?? 0, proj ?? 0, bm ?? 0);
  const maxV = Math.max(target > 0 ? target * 1.2 : 0, maxData * 1.04);
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

  // cobalt only exists when the release has a basket behind it
  const hasBm = !!snap?.benchmark;
  const bmClose = hasBm ? hero.benchmark ?? null : null;
  const bmToday = hasBm ? hero.benchmarkToday ?? null : null;
  const bm = close ? bmClose : bmToday;

  // the ink reference for this horizon: the target for today, the sellout at close
  const target = close ? sellout : expToday;
  const fill = close ? proj : now;
  const delta = close ? proj - sellout : hero.delta ?? now - expToday;
  const stretch = bm === null ? null : target - bm;

  const pos = trackScale({
    now: close ? null : now, proj: close ? proj : null, target, bm,
  });
  const over = proj - sellout;
  const oversub = hero.oversubscribedUnits ?? 0;
  const overPct = sellout > 0 ? Math.round((proj / sellout) * 100) : null;

  const unitsTip =
    "Secured units = units sold (all routes incl. private room) + 0.8 × eligible " +
    "entry units not yet converted, capped at the edition size.";
  const bmTip = {
    head: close ? "Benchmark at close" : "Benchmark today",
    rows: [
      { label: "Units", value: fmt(bm ?? 0) },
      ...(stretch !== null ? [{ label: "Stretch", value: fmtSigned(stretch) }] : []),
    ],
    body: "The median of the matched basket - what launches like this one typically reach.",
  };
  const targetTip = {
    head: close ? "Sellout" : `Target by day ${day}`,
    rows: [{ label: "Units", value: fmt(target) }],
  };

  const axisLabel = { position: "absolute", top: 4, fontSize: 12, whiteSpace: "nowrap" };

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
        <span className="delta" style={{ color: delta >= 0 ? C.ink : C.red }}>
          {fmtSigned(delta)}
        </span>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          {close ? "vs sellout at close" : "vs target today"}
        </span>
      </div>

      <div style={{ marginTop: 24 }}>
        {/* the ink number rides above its tick, the cobalt one below, so the two
            references never share a line and never need a leader */}
        <div style={{ position: "relative", height: 20, marginBottom: 8 }}>
          {target > 0 && (
            <div
              style={{
                position: "absolute", left: `${pos(target)}%`, bottom: 0,
                transform: "translateX(-50%)", maxWidth: "100%",
                fontSize: 12, color: C.ink, whiteSpace: "nowrap",
              }}
            >
              target {fmt(target)}
            </div>
          )}
        </div>

        <TrackBar
          now={close ? null : now}
          proj={close ? proj : null}
          target={target}
          bm={bm}
          hatchFrom={close ? sellout : null}
          height={24}
          tips={{
            proj: { head: "Projected at close", rows: [
              { label: "Units", value: fmt(proj) },
              ...(overPct !== null ? [{ label: "vs sellout", value: overPct + "%" }] : []),
            ] },
            now: { head: "Secured to date", rows: [{ label: "Units", value: fmt(now) }] },
            overshoot: { head: "Oversubscribed", rows: [{ label: "Units", value: "+" + fmt(Math.abs(over)) }] },
            target: targetTip,
            bm: bm === null ? null : bmTip,
          }}
        />

        <div style={{ position: "relative", height: 20, marginTop: 8 }}>
          <div style={{ ...axisLabel, left: 0, color: C.muted }}>0</div>
          {bm !== null && bm > 0 && (
            <div
              {...t.props(bmTip)}
              style={{ ...axisLabel, left: `${pos(bm)}%`, transform: "translateX(-50%)", color: C.cobalt }}
            >
              benchmark {fmt(bm)}
            </div>
          )}
          <div style={{ ...axisLabel, right: 0, color: C.muted }}>
            sellout {fmt(sellout)}
          </div>
        </div>
      </div>

      <div className="legend-rows">
        <div className="legend-row">
          <span className="swatch" style={{ background: close ? C.orangeLight : C.orange }} />
          <span style={{ color: C.muted }}>{close ? "Projected demand at close" : "To date"}</span>
          <span className="val">{fmt(fill)}</span>
        </div>
        {close ? (
          <div className="legend-row">
            <span className="swatch" style={{ background: HATCH }} />
            <span style={{ color: C.muted }}>Over sellout</span>
            <span className="val">{oversub > 0 ? "+" + fmt(oversub) : fmtSigned(over)}</span>
          </div>
        ) : (
          <div className="legend-row">
            <span className="swatch" style={{ background: C.ink, width: 12, height: 2, borderRadius: 0, flex: "0 0 12px" }} />
            <span style={{ color: C.muted }}>Target today</span>
            <span className="val">{fmt(expToday)}</span>
          </div>
        )}
        {stretch !== null && (
          <div className="legend-row">
            <span className="swatch" style={{ background: STRETCH_HATCH, border: `1px solid ${C.targetLine}` }} />
            <span style={{ color: C.muted }}>
              {close ? "Stretch (target - benchmark)" : "Stretch today (target - benchmark)"}
            </span>
            <span className="val">{fmtSigned(stretch)}</span>
          </div>
        )}
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
