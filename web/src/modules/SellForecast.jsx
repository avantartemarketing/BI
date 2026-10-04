/* Sell-through forecast by work (docs/TL_SPEC.md §4b): a timed launch before
 * its window opens. Wide card (2 cols × 1 row), one row per work, laid out as
 * the sell-through card lays its rows once the window has opened.
 *
 * The headline is the units the window is expected to sell on the page's
 * horizon (today's signups, or the signups projected to the open), the
 * sell-through and the range beside it in small type. Each row is the work's
 * edition, and on it the signup-led units (deep blue) and the non-signup
 * units (light blue), a paler band behind them for where completed launches
 * landed around their forecast, and a tick at the work's units target; the
 * work's units in ink, its sell-through muted. The rows share the body evenly
 * and never spread past PITCH_MAX; past seven they scroll. The working, the
 * rates and how the works were keyed are in the badge and the row popups,
 * not on the card. */
import React from "react";
import { Card, HorizonBadge, GROUP_DOTS, C, fmt, fmtPct, useTip } from "../ui.jsx";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const SEG = { su: C.blueDeep, non: C.blueLight, band: "rgba(79, 128, 214, 0.12)" };
const PITCH_MAX = 64;
const GROUP_NAMES = { aa_email: "AA Email", aa_social: "AA Meta", referral_artist: "Referral artist", search_direct_other: "Search / direct / other", paid: "Paid" };
const swatch = (bg) => ({ width: 9, height: 9, borderRadius: 2, background: bg, flex: "0 0 9px" });
const legendItem = { display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" };

function WorkBar({ w, maxV, tips, height = 14, radius = 4 }) {
  const t = useTip();
  const pct = (v) => (maxV > 0 ? Math.max(0, Math.min(((v ?? 0) / maxV) * 100, 100)) : 0);
  const inset = Math.max(2, Math.round(height * 0.14));
  const innerR = Math.max(2, radius - 2);
  return (
    <div style={{ position: "relative", height, background: C.track, borderRadius: radius }}>
      {finite(w.edition) && w.edition > 0 && (
        <div style={{ position: "absolute", inset: 0, width: `${pct(w.edition)}%`, background: C.refTrack, borderRadius: radius }} />
      )}
      <div {...t.props(tips.band)} style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(w.lo)}%`, width: `${pct(w.hi) - pct(w.lo)}%`, background: SEG.band, borderRadius: radius }} />
      <div {...t.props(tips.su)} style={{ position: "absolute", top: inset, bottom: inset, left: 0, width: `${pct(w.su)}%`, background: SEG.su, borderRadius: `${innerR}px 0 0 ${innerR}px` }} />
      <div {...t.props(tips.non)} style={{ position: "absolute", top: inset, bottom: inset, left: `${pct(w.su)}%`, width: `${pct(w.su + w.non) - pct(w.su)}%`, background: SEG.non, borderRadius: `0 ${innerR}px ${innerR}px 0` }} />
      {finite(w.target) && w.target > 0 && (
        <div {...t.props(tips.target)} style={{ position: "absolute", top: -3, bottom: -3, left: `${pct(w.target)}%`, width: 2, marginLeft: -1, background: C.refLine, borderRadius: 1 }} />
      )}
    </div>
  );
}

export default function SellForecast({ snap, horizon = "today" }) {
  const t = useTip();
  const f = snap?.sellForecast;
  const atOpen = horizon === "close";
  const H = f ? (atOpen ? f.open : f.today) : null;
  if (!f || !H || !H.works || !H.works.length) {
    return (
      <Card wide dot={GROUP_DOTS.outcome} title="Sell-through forecast by work">
        <div className="empty-state">No works from Airtable and no units target yet: nothing to forecast against.</div>
      </Card>
    );
  }
  const whenShort = atOpen ? "at the open" : "today";
  const rates = f.rates || { prod: {}, rel: {} };
  const basketWords = `the page's basket of ${fmt(f.basketN ?? 0)} launches`;
  const keyedWords = f.source === "signup pages"
    ? `${fmt(f.keyed)} product signups are keyed to a work by the product page of their session (${finite(f.keyedShare) ? fmtPct(f.keyedShare, 0) : "–"} of product signups); the ${fmt(f.releaseSignups)} release signups and the ${fmt(f.unkeyedProduct)} product signups without a page spread pro rata.`
    : `Fewer than ${f.minKeyed} signups are keyed to a work so far, so the works split by their units target.`;
  const moreTip = {
    head: `Units at close ${whenShort} - how it is read`,
    rows: [
      { label: `Signups ${whenShort}`, value: fmt(H.signups) },
      { label: "Signup-led units", value: fmt(H.su) },
      { label: "+ non-signup units", value: fmt(H.non) },
      { label: "= units at close", value: fmt(H.units) },
      { label: "Range, middle half of past launches", value: `${fmt(H.lo)} to ${fmt(H.hi)}` },
      ...(H.edition ? [{ label: "Edition", value: fmt(H.edition) }, { label: "Sell-through", value: fmtPct(H.pct, 0) }] : []),
      ...(H.target ? [{ label: "Units target", value: fmt(H.target) }, { label: "Of target", value: fmtPct(H.pctTarget, 0) }] : []),
      { label: "Pieces per order", value: `${fmt(f.ppo, 2)} (${f.ppoSource === "release" ? "typed" : "the basket's"})` },
      ...Object.keys(GROUP_NAMES).map((g) => ({ label: `${GROUP_NAMES[g]}: product / release rate · non-signup units`, value: `${fmtPct(rates.prod[g] ?? 0, 0)} / ${fmtPct(rates.rel[g] ?? 0, 0)} · ${fmt(H.nonByGroup ? H.nonByGroup[g] : 0)} at ×${fmt(H.perfByGroup ? H.perfByGroup[g] : 1, 2)}` })),
    ],
    body: `Signup-led units: each channel's signups ${atOpen ? "projected to the open" : "to date"}, product subscriptions and release ones apart, at ${rates.source === "release" ? "the rate typed on the Target setting tab" : `${basketWords}' signup → order rates for that channel and kind`}, times the pieces an order takes. ${keyedWords} `
      + `Non-signup units: the same launches' median window sales to buyers who never signed up, by channel, moved ${Math.round(f.beta * 100)}% of the way with this launch's signups against theirs (the ratio held between ${f.perfClip[0]} and ${f.perfClip[1]}), spread over the works by the same shares. `
      + `The band is where completed launches landed around this forecast: the middle half between ${f.band[0]} and ${f.band[1]} times it.`,
  };
  const n = H.works.length;
  const legend = (
    <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }}>
      <span style={legendItem}><span style={swatch(SEG.su)} />signup-led</span>
      <span style={legendItem}><span style={swatch(SEG.non)} />non-signup</span>
      <span style={legendItem}><span style={swatch("rgba(79, 128, 214, 0.22)")} />range</span>
      <span style={legendItem}><span style={{ width: 2, height: 11, background: C.refLine, flex: "0 0 2px" }} />target</span>
    </div>
  );
  const subs = [
    atOpen ? "units at close if signups keep pace" : "units at close on today's signups",
    ...(H.edition ? [`${fmtPct(H.pct, 0)} of the ${fmt(H.edition)} edition`] : H.target ? [`${fmtPct(H.pctTarget, 0)} of the ${fmt(H.target)} target`] : []),
    `${fmt(H.lo)} to ${fmt(H.hi)}`,
  ];
  const right = (
    <span style={{ fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }}
      title={`${keyedWords} ${basketWords[0].toUpperCase()}${basketWords.slice(1)}.`}>
      {f.source === "signup pages" && finite(f.keyedShare) ? `${fmtPct(f.keyedShare, 0)} keyed · ` : ""}{fmt(f.basketN ?? 0)} launches
    </span>
  );
  return (
    <Card wide dot={GROUP_DOTS.outcome} title="Sell-through forecast by work" badge={<HorizonBadge horizon={horizon} closeLabel="At the open" />} right={right}>
      <div className="spacer-8" />
      <div className="lead" style={{ alignItems: "baseline", flex: "0 0 auto" }}>
        <span>{fmt(H.units)}</span>
        <span style={{ fontSize: 12, fontWeight: 400, letterSpacing: 0, color: C.muted, whiteSpace: "nowrap" }}>{subs.join(" · ")}</span>
        <span className="qbadge" {...t.props(moreTip, 300)}>?</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", flex: "0 0 auto", paddingTop: 4 }}>{legend}</div>
      <div className="body" style={{ overflowY: n > 7 ? "auto" : "visible", paddingTop: 4 }}>
        <div style={{ height: "100%", display: "grid", gridTemplateColumns: "minmax(140px, 1.6fr) 3fr auto auto", columnGap: 14, alignContent: n > 7 ? "start" : "space-evenly", alignItems: "center",
          gridAutoRows: n > 7 ? `${PITCH_MAX / 2}px` : `minmax(0, ${PITCH_MAX}px)` }}>
          {H.works.map((w) => {
            const scale = Math.max(w.edition || 0, w.hi || 0, w.target || 0, w.units || 0) || 1;
            const tips = {
              su: { head: `${w.name} · signup-led`, rows: [{ label: "Keyed signups", value: fmt(w.keyed) }, { label: "Share of the rest", value: fmtPct(w.share, 0) }, { label: "Units", value: fmt(w.su) }],
                body: `The signups keyed to this work plus its share of the release signups and the unkeyed product signups, at the rates by channel and kind, times ${fmt(f.ppo, 2)} pieces an order.` },
              non: { head: `${w.name} · non-signup`, rows: [{ label: "Units", value: fmt(w.non) }], body: `${fmtPct(w.share, 0)} of the ${fmt(H.non)} units buyers who never signed up are expected to take.` },
              band: { head: `${w.name} · range`, rows: [{ label: "Low", value: fmt(w.lo) }, { label: "Forecast", value: fmt(w.units) }, { label: "High", value: fmt(w.hi) }, ...(w.edition ? [{ label: "Edition", value: fmt(w.edition) }] : [])], body: `Where the middle half of completed launches landed around their forecast: ${f.band[0]} to ${f.band[1]} times it.` },
              target: { head: `${w.name} · units target`, rows: [{ label: "Target", value: fmt(w.target) }, { label: "Forecast of target", value: finite(w.pctTarget) ? fmtPct(w.pctTarget, 0) : "–" }], body: "The work's units target from Airtable, or typed on the Target setting tab." },
            };
            const pctWord = finite(w.pct) ? `${fmtPct(w.pct, 0)} of ${fmt(w.edition)}` : finite(w.pctTarget) ? `${fmtPct(w.pctTarget, 0)} of target` : "";
            return (
              <React.Fragment key={w.key}>
                <div style={n <= 4
                  ? { fontSize: 12.5, fontWeight: 600, lineHeight: 1.25, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }
                  : { fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={w.name}>{w.name}</div>
                <WorkBar w={w} maxV={scale} tips={tips} height={n <= 3 ? 22 : n <= 5 ? 16 : 12} radius={n <= 3 ? 5 : 4} />
                <div className="num" style={{ fontSize: 13, fontWeight: 600, color: C.ink, textAlign: "right", whiteSpace: "nowrap", minWidth: 44 }}>{fmt(w.units)}</div>
                <div className="num" style={{ fontSize: 12, color: C.muted, textAlign: "right", whiteSpace: "nowrap", minWidth: 84 }}>{pctWord}</div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
