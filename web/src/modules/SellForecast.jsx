/* Sell-through forecast by work (docs/TL_SPEC.md §4b): a timed launch before
 * its window opens. Wide card (2 cols × 1 row), one row per work, as the
 * sell-through card lays its rows out once the window has opened.
 *
 * Each row is the work's edition, and on it the units the window is expected
 * to sell: the signup-led ones (deep blue: the signups keyed to the work and
 * its share of the rest, at the basket's signup -> order rates by channel and
 * kind, times the pieces an order takes) and the non-signup ones (light blue:
 * the basket's window sales to people who never signed up, by channel, moved
 * a fifth of the way with this launch's signup window, and spread over the
 * works by the same shares). Behind them a paler band says where completed
 * launches landed around their forecast (the middle half, 0.63 to 1.62 times).
 * A tick marks the work's units target. Each row carries its units of the
 * edition in muted text and its sell-through in ink, no RAG colour.
 *
 * The card follows the page's horizon: Today reads today's signups, At the
 * open the signups projected to the open. The headline is the release's
 * forecast sell-through on that horizon, with the band's ends beside it; the
 * badge carries the working and where every figure came from. Without a
 * product page behind enough signups the works split by their units target,
 * and the foot of the card says so. */
import React from "react";
import { Card, HorizonBadge, GROUP_DOTS, C, fmt, fmtPct, useTip } from "../ui.jsx";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const SEG = { su: C.blueDeep, non: C.blueLight, band: C.refTrack };
const ROWS_H = 176;
const PITCH_MAX = 60;
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
      {/* the band: where completed launches landed around their forecast */}
      <div {...t.props(tips.band)} style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(w.lo)}%`, width: `${pct(w.hi) - pct(w.lo)}%`,
        background: "rgba(76, 110, 245, 0.10)", borderRadius: radius }} />
      <div {...t.props(tips.su)} style={{ position: "absolute", top: inset, bottom: inset, left: 0, width: `${pct(w.su)}%`, background: SEG.su,
        borderRadius: `${innerR}px 0 0 ${innerR}px` }} />
      <div {...t.props(tips.non)} style={{ position: "absolute", top: inset, bottom: inset, left: `${pct(w.su)}%`, width: `${pct(w.su + w.non) - pct(w.su)}%`, background: SEG.non,
        borderRadius: `0 ${innerR}px ${innerR}px 0` }} />
      {finite(w.target) && w.target > 0 && (
        <div {...t.props(tips.target)} style={{ position: "absolute", top: -2, bottom: -2, left: `${pct(w.target)}%`, width: 2, marginLeft: -1, background: C.refLine, borderRadius: 1 }} />
      )}
    </div>
  );
}

export default function SellForecast({ snap, horizon = "today" }) {
  const f = snap?.sellForecast;
  const atOpen = horizon === "close";
  const H = f ? (atOpen ? f.open : f.today) : null;
  if (!f || !H || !H.works || !H.works.length) {
    return (
      <Card wide dot={GROUP_DOTS.outcome} title="Sell-through forecast by work">
        <div className="empty-state">No works from Airtable and no units target yet, so there is nothing to forecast against.</div>
      </Card>
    );
  }
  const when = atOpen ? "if the signups keep their pace to the open" : "on today's signups";
  const whenShort = atOpen ? "at the open" : "today";
  const whenCap = atOpen ? "if signups keep pace" : "on today's signups";
  const rates = f.rates || { prod: {}, rel: {} };
  const rateWords = rates.source === "release" ? "the rate typed on the Target setting tab for both kinds" : "the basket's signup → order rates by channel, product signups and release signups apart";
  const keyedWords = f.source === "signup pages"
    ? `${fmt(f.keyed)} product signups keyed to a work by the product page of their session (${f.keyedShare !== null && f.keyedShare !== undefined ? fmtPct(f.keyedShare, 0) : "–"} of product signups); the ${fmt(f.releaseSignups)} release signups and the ${fmt(f.unkeyedProduct)} product signups without a page spread pro rata`
    : `fewer than ${f.minKeyed} signups keyed to a work so far, so the works split by their units target${f.keyed > 0 ? ` (${fmt(f.keyed)} keyed)` : ""}`;
  const moreTip = {
    head: `Sell-through forecast ${whenShort} - how it is read`,
    rows: [
      { label: `Signups ${whenShort}`, value: fmt(H.signups) },
      { label: "Signup-led units", value: fmt(H.su) },
      { label: "Non-signup units", value: fmt(H.non) },
      { label: "= units at close", value: fmt(H.units) },
      { label: "Range (middle half of past launches)", value: `${fmt(H.lo)} to ${fmt(H.hi)}` },
      ...(H.edition ? [{ label: "Edition", value: fmt(H.edition) }, { label: "= sell-through", value: fmtPct(H.pct, 0) }] : []),
      ...(H.target ? [{ label: "Units target", value: fmt(H.target) }, { label: "Of target", value: fmtPct(H.pctTarget, 0) }] : []),
      { label: "Pieces per order", value: `${fmt(f.ppo, 2)} (${f.ppoSource === "release" ? "typed" : "the basket's"})` },
      ...Object.keys(GROUP_NAMES).map((g) => ({ label: `${GROUP_NAMES[g]}: rate product / release · non-signup units`, value: `${fmtPct(rates.prod[g] ?? 0, 0)} / ${fmtPct(rates.rel[g] ?? 0, 0)} · ${fmt(H.nonByGroup ? H.nonByGroup[g] : 0)} at ×${fmt(H.perfByGroup ? H.perfByGroup[g] : 1, 2)}` })),
      { label: "Basket", value: `${fmt(f.basketN ?? 0)} launches` },
    ],
    body: `Signup-led units: each channel's signups ${when}, at ${rateWords}, times the pieces an order takes. ${keyedWords[0].toUpperCase()}${keyedWords.slice(1)}. `
      + `Non-signup units: the basket's median window sales to buyers who never signed up, by channel, moved ${Math.round(f.beta * 100)}% of the way with this launch's signups against the basket's (the ratio held between ${f.perfClip[0]} and ${f.perfClip[1]}), and spread over the works by the same shares. `
      + `The band is where completed launches landed around this forecast: the middle half fell between ${f.band[0]} and ${f.band[1]} times it.`,
  };
  const n = H.works.length;
  const pitch = Math.min(PITCH_MAX, Math.floor(ROWS_H / n));
  const barH = Math.max(10, Math.min(30, Math.round(pitch / 2)));
  const lead = H.pct !== null && H.pct !== undefined ? fmtPct(H.pct, 0) : H.pctTarget !== null && H.pctTarget !== undefined ? fmtPct(H.pctTarget, 0) : fmt(H.units);
  const leadCap = H.pct !== null && H.pct !== undefined
    ? `sell-through at close, ${whenCap} · ${fmt(H.units)} of ${fmt(H.edition)} · range ${fmtPct(H.lo / H.edition, 0)} to ${fmtPct(H.hi / H.edition, 0)}`
    : H.target ? `of the units target at close, ${whenCap} · ${fmt(H.units)} of ${fmt(H.target)}` : `units at close, ${whenCap}`;
  const legend = (
    <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11.5, color: C.muted, flex: "0 0 auto" }}>
      <span style={legendItem}><span style={swatch(SEG.su)} />signup-led</span>
      <span style={legendItem}><span style={swatch(SEG.non)} />non-signup</span>
      <span style={legendItem}><span style={{ ...swatch("rgba(76, 110, 245, 0.18)") }} />range</span>
      <span style={legendItem}><span style={{ width: 2, height: 11, background: C.refLine, flex: "0 0 2px" }} />target</span>
    </div>
  );
  return (
    <Card wide dot={GROUP_DOTS.outcome} title="Sell-through forecast by work" badge={<HorizonBadge horizon={horizon} closeLabel="At the open" />}>
      <div className="spacer-8" />
      <div className="lead" style={{ flex: "0 0 auto" }}>
        <span>{lead}</span>
        <span style={{ fontSize: 12, fontWeight: 400, letterSpacing: 0, color: C.muted, whiteSpace: "nowrap" }}>{leadCap}</span>
        <span className="qbadge" {...useTip().props(moreTip, 300)}>?</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", flex: "0 0 auto", paddingTop: 2 }}>{legend}</div>
      <div style={{ height: 6, flex: "0 0 6px" }} />
      <div className="body" style={{ overflowY: n > 7 ? "auto" : "visible" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, 1.1fr) 3fr auto auto", columnGap: 10, rowGap: 0, alignItems: "center" }}>
          {H.works.map((w) => {
            const scale = Math.max(w.edition || 0, w.hi || 0, w.target || 0, w.units || 0) || 1;
            const tips = {
              su: { head: `${w.name} · signup-led`, rows: [{ label: "Keyed signups", value: fmt(w.keyed) }, { label: "Share of the rest", value: fmtPct(w.share, 0) }, { label: "Units", value: fmt(w.su) }],
                body: `The signups keyed to this work plus its share of the release signups and the unkeyed product signups, at the basket's rates by channel and kind, times ${fmt(f.ppo, 2)} pieces an order.` },
              non: { head: `${w.name} · non-signup`, rows: [{ label: "Units", value: fmt(w.non) }], body: `${fmtPct(w.share, 0)} of the ${fmt(H.non)} units the basket says buyers who never signed up will take, moved ${Math.round(f.beta * 100)}% of the way with this launch's signup window.` },
              band: { head: `${w.name} · range`, rows: [{ label: "Low", value: fmt(w.lo) }, { label: "Forecast", value: fmt(w.units) }, { label: "High", value: fmt(w.hi) }], body: `Where the middle half of completed launches landed around their forecast: ${f.band[0]} to ${f.band[1]} times it.` },
              target: { head: `${w.name} · units target`, rows: [{ label: "Target", value: fmt(w.target) }, { label: "Forecast of target", value: w.pctTarget !== null && w.pctTarget !== undefined ? fmtPct(w.pctTarget, 0) : "–" }], body: "The work's units target from Airtable, or typed on the Target setting tab." },
            };
            return (
              <React.Fragment key={w.key}>
                <div style={{ height: pitch, display: "flex", alignItems: "center", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={w.name}>{w.name}</div>
                <div style={{ height: pitch, display: "flex", alignItems: "center" }}><div style={{ width: "100%" }}><WorkBar w={w} maxV={scale} tips={tips} height={barH} /></div></div>
                <div className="num" style={{ fontSize: 12, color: C.muted, textAlign: "right", whiteSpace: "nowrap" }}>{fmt(w.units)}{w.edition ? ` of ${fmt(w.edition)}` : w.target ? ` of ${fmt(w.target)} target` : ""}</div>
                <div className="num" style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, textAlign: "right", minWidth: 42 }}>{w.pct !== null && w.pct !== undefined ? fmtPct(w.pct, 0) : w.pctTarget !== null && w.pctTarget !== undefined ? fmtPct(w.pctTarget, 0) : "–"}</div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, flex: "0 0 auto", paddingTop: 6 }}>{keyedWords[0].toUpperCase()}{keyedWords.slice(1)}.</div>
    </Card>
  );
}
