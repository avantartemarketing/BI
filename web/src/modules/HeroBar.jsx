/* Units vs sellout - hero module (spec §4.1, unified secured-units currency, docs §6.3½):
 * secured units = units paid (all routes incl. private room) + draft orders not
 * yet paid + the orders expected from the entries still in the draw, work by
 * work, capped at the edition size (the sell-through's own count).
 *
 * One bar, one horizon, both references (BENCHMARK_SPEC 7). The fill is the
 * target - darker from zero to whichever of target and benchmark is lower,
 * lighter from the benchmark up to the target when the target is the higher -
 * the benchmark is the dotted outline over it, and the actual is the narrower
 * blue bar in front, carrying its own figure at its tip. The track is the
 * sellout: it ends there, the room left to it is the track's grey, and demand
 * past it runs on past the track's end as the same solid fill. Nothing is
 * written above or below the bar: each mark says what it is and its figure on
 * hover, and one line of figures under the bar names the three (to date or
 * projected, target, benchmark - or, at close with demand past the sellout,
 * what is over). Redrawn this way on 4 October 2026 from the routes page;
 * before, the references were named on two rows above the bar with an axis
 * row below, and the overshoot was hatched inside the track. The headline
 * delta reads against the target: it is what the business committed to. */
import React from "react";
import { Card, TrackBar, GROUP_DOTS, HorizonBadge, C, fmt, fmtSigned, useTip, BADGE_WORDS, dayLabel } from "../ui.jsx";
import { stretchWords } from "../ui.jsx";
import { wordsOf } from "../vocab.mjs";
import { Ex } from "../explain/Explain.jsx";

/* The key's outline swatch: the same dotted silhouette the bar carries. */
const OUTLINE_SWATCH = (
  <svg className="swatch" width="12" height="10" viewBox="0 0 12 10" style={{ flex: "0 0 12px", borderRadius: 0 }} aria-hidden="true">
    <path d="M1 10 V1.5 H11 V10" fill="none" stroke={C.refLine} strokeWidth="1.5" strokeDasharray="1.6 1.6" />
  </svg>
);

/* What secured units are made of, as the sell-through counts them (docs 6.3½):
 * the draw's part is the entries still in hand, allocated work by work, at the
 * release's entry → order rate (and a pre-order's own rate). */
function securedTip(snap) {
  const st = snap?.sellthrough || {};
  const pct = (x) => Math.round(x * 100) + "%";
  const rate = Number.isFinite(st.conversion) ? st.conversion : 0.8;
  const pre = Number.isFinite(st.preorderConversion) && st.preorderConversion !== rate ? st.preorderConversion : null;
  return "Secured units = units paid (all routes incl. private room) + draft orders not yet paid + the orders " +
    `expected from the entries still in the draw, work by work, at ${pct(rate)}${pre !== null ? ` (${pct(pre)} for a pre-order)` : ""}`;
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
  const words = BADGE_WORDS;
  // the quantity's words: units against a sellout on an LE, signups or units
  // against a target on a timed launch (vocab.mjs)
  const W = wordsOf(snap);
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

  const over = proj - sellout;
  const oversub = hero.oversubscribedUnits ?? 0;
  const overPct = sellout > 0 ? Math.round((proj / sellout) * 100) : null;

  const unitsTip = W.tl
    ? (close
      ? `${W.projected} = the ${W.unit} so far and what each channel is on course to add by the ${W.closeWord}, at its pace against the plan.`
      : W.state === "signups"
        ? "Every signup event the TL funnel export tags to the release before its window opens; signups with no channel are spread over the channels in proportion."
        : "Units sold in the window: the orders table's paid lines plus the orders awaiting payment, by pieces, from the sales open.")
    : close
      ? "Projected demand = the units secured today and what each channel is on course to add by the close, capped at the edition size."
      : securedTip(snap) + ", capped at the edition size.";
  const refRows = [
    { label: words.target, value: fmt(target) },
    ...(bm !== null ? [{ label: words.bm, value: fmt(bm) }] : []),
    ...(!close && sellout > 0 && !W.tl ? [{ label: "Sellout", value: fmt(sellout) }] : []),
  ];
  const targetTip = {
    // at close the target IS the sellout, so it is named as that
    head: close ? (W.tl ? `${W.Unit} target` : partial ? `Target · ${Math.round((100 * sellout) / editionTotal)}% of the ${fmt(editionTotal)} edition` : "Sellout") : `Target by ${dayLabel(snap, day)}`,
    rows: refRows,
  };
  const stretchTip = bm === null ? null : {
    head: "Stretch",
    rows: [
      ...refRows,
      { label: "Stretch", value: fmtSigned(stretch) },
      ...(k ? [{ label: "Uplift", value: "×" + fmt(k, 2) }] : []),
    ],
    body: `What the business is asking for over and above the basket - ${stretchWords(snap)}.`,
  };
  const bmTip = bm === null ? null : {
    head: "Benchmark",
    rows: refRows,
    body: W.tl
      ? `The median of the matched basket of timed launches - the ${W.unit} launches like this one typically reach${close ? "" : " by now"}.`
      : "The median of the matched basket - the demand launches like this one typically reach: units sold, plus what the entrants left without a unit would have bought at the entry rate.",
  };

  return (
    <Card
      dot={GROUP_DOTS.volume}
      title={partial ? W.heroTitlePartial : W.heroTitle}
      badge={<HorizonBadge horizon={horizon} />}
      // "oversubscribed +N" takes a line of its own on a narrow card rather
      // than break the title, the horizon chip and itself each onto two
      wrapHead
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
      <div className="lead" {...t.props({ head: close ? W.projected : W.securedUnits, body: unitsTip }, 300)}>
        <Ex k="hero.fill" arg={{ close }} focus>{fmt(fill)}</Ex>
        <span className="delta" style={{ color: delta >= 0 ? C.green : C.red }}>
          <Ex k="hero.delta" arg={{ close }}>{fmtSigned(delta)}</Ex>
        </span>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          {close && !partial && !W.tl ? "vs sellout" : "vs target"}
        </span>
      </div>

      <div style={{ marginTop: 28, marginBottom: 22 }}>
        <TrackBar
          now={close ? null : now}
          proj={close ? proj : null}
          projColor={C.blue}
          target={target}
          bm={bm}
          full={sellout}
          bounded
          label={fmt(fill)}
          height={40}
          radius={8}
          inset={10}
          tips={{
            proj: { head: W.projected, rows: [
              { label: W.Unit, value: fmt(proj) },
              ...(overPct !== null ? [{ label: `vs ${W.sellout}`, value: overPct + "%" }] : []),
            ] },
            now: { head: W.toDate, rows: [{ label: W.Unit, value: fmt(now) }] },
            track: { head: W.tl ? `${W.Unit} target` : partial ? "Target" : "Sellout", rows: [{ label: W.Unit, value: fmt(sellout) }],
                     body: "The bar runs from zero to here; demand past it runs on past the bar's end." },
            target: targetTip,
            base: bm !== null && bm < target ? bmTip : targetTip,
            stretch: stretchTip,
          }}
        />
      </div>

      {/* one line of figures under the bar, in the bar's own marks: what is
          counted, the target, and the benchmark - or, at close with demand
          past the sellout, what is over, since the fill running past the
          bar's end needs naming more than the outline does */}
      <div className="hero-stats">
        <div className="stat" {...t.props({ head: close ? W.projected : W.securedUnits, body: unitsTip }, 300)}>
          <div className="k"><span className="swatch" style={{ background: C.blue }} />{close ? "Projected" : "To date"}</div>
          <div className="v"><Ex k="hero.fill" arg={{ close }}>{fmt(fill)}</Ex></div>
        </div>
        <div className="stat" {...t.props(stretchTip || targetTip)}>
          <div className="k"><span className="swatch" style={{ background: C.refBase }} />Target</div>
          <div className="v"><Ex k="hero.target" arg={{ close }}>{fmt(target)}</Ex></div>
        </div>
        {close && !W.tl && (oversub > 0 || over > 0) ? (
          <div className="stat" {...t.props({ head: "Over sellout", rows: [{ label: "Units", value: "+" + fmt(oversub > 0 ? oversub : Math.abs(over)) }],
                                               body: "Demand past the sellout, which cannot convert: the fill runs on past the bar's end." })}>
            <div className="k"><span className="swatch" style={{ background: C.blue }} />Over sellout</div>
            <div className="v"><Ex k="hero.over">{oversub > 0 ? "+" + fmt(oversub) : fmtSigned(over)}</Ex></div>
          </div>
        ) : bm !== null ? (
          <div className="stat" {...t.props(bmTip)}>
            <div className="k">{OUTLINE_SWATCH}Benchmark</div>
            <div className="v"><Ex k="hero.bm" arg={{ close }}>{fmt(bm)}</Ex></div>
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
  const W = wordsOf(snap);
  const now = snap.hero?.now ?? 0;
  const sold = snap.sellthrough?.sold ?? 0;
  const drafts = snap.sellthrough?.drafts;
  const banked = snap.sellthrough?.soldPredicted ?? 0;
  const unitsTip = W.tl ? `${W.securedUnits} to date, every channel.` : securedTip(snap) + ".";
  return (
    <Card dot={GROUP_DOTS.volume} title={W.securedUnits}>
      <div className="spacer-8" />
      <div className="lead" {...t.props({ head: W.securedUnits, body: unitsTip }, 300)}>
        <Ex k="hero.secured" focus>{fmt(now)}</Ex>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          {snap.catalogue ? "last 90 days" : "to date"}
        </span>
      </div>
      <div className="lead-caption" style={{ color: C.muted }}>no target set - actuals only</div>
      {!W.tl && <div className="legend-rows" style={{ marginTop: 20 }}>
        {/* the parts of the lead, in the sell-through's ramp of blues, so the
            rows add up to it */}
        <div className="legend-row">
          <span className="swatch" style={{ background: C.blueDeep }} />
          <span style={{ color: C.muted }}>Units paid</span>
          <span className="val"><Ex k="st.paid">{fmt(sold)}</Ex></span>
        </div>
        {Number.isFinite(drafts) && (
          <div className="legend-row">
            <span className="swatch" style={{ background: C.blue }} />
            <span style={{ color: C.muted }}>Draft orders</span>
            <span className="val"><Ex k="st.drafts">{fmt(drafts)}</Ex></span>
          </div>
        )}
        <div className="legend-row">
          <span className="swatch" style={{ background: C.blueLight }} />
          <span style={{ color: C.muted }}>Expected from the draw</span>
          <span className="val"><Ex k="st.draw">{fmt(banked)}</Ex></span>
        </div>
      </div>}
    </Card>
  );
}
