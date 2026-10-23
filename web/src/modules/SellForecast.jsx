/* Sell-through forecast by work (docs/TL_SPEC.md 4b): a timed launch before
 * its window opens. Each work's forecast units on its edition, the
 * signup-led units (deep indigo: the signups keyed to the work plus its
 * share of the rest, at the basket's signup to order rates by channel and
 * kind, times the pieces an order takes) and the non-signup units (mid:
 * the basket's median window sales to buyers who never signed up, moved
 * part of the way with this launch's signups against theirs); a pale band
 * where completed launches landed around their forecast, a tick at the
 * work's units target, a dotted line at the edition. The head is the
 * forecast as a share of the edition on the page's horizon: today's
 * signups, or the signups projected to the open. The working is on the
 * head's hover. */
import React from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, COL, sw, lk } from "../charts.jsx";
import { fmt, fmtPct } from "../format.mjs";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const GROUP_NAMES = { aa_email: "AA Email", aa_social: "AA Meta", referral_artist: "Artist", search_direct_other: "Direct etc.", paid: "Paid" };
const short = (s) => (s && s.length > 18 ? s.slice(0, 17) + "…" : s || "");

export default function SellForecast({ snap, horizon = "today" }) {
  const f = snap.sellForecast;
  const atOpen = horizon === "close";
  const H = f ? (atOpen ? f.open : f.today) : null;
  if (!f || !H || !H.works || !H.works.length) {
    return <Card title="Sell-through forecast by work"><div className="empty-state">No works from Airtable and no units target yet: nothing to forecast against</div></Card>;
  }
  const whenShort = atOpen ? "at the open" : "today";
  const rates = f.rates || { prod: {}, rel: {} };
  const band = Array.isArray(f.band) ? f.band : [0.63, 1.62];
  const keyedWords = f.source === "signup pages"
    ? `${fmt(f.keyed)} product signups are keyed to a work by the product page of their session (${finite(f.keyedShare) ? fmtPct(f.keyedShare, 0) : "–"} of product signups); the ${fmt(f.releaseSignups)} release signups and the ${fmt(f.unkeyedProduct)} product signups without a page spread pro rata.`
    : `Fewer than ${fmt(f.minKeyed)} signups are keyed to a work so far, so the works split by their units target.`;
  const working = [
    `Units at close ${whenShort}, how it is read`,
    `Signups ${whenShort} ${fmt(H.signups)} · signup-led units ${fmt(H.su)} + non-signup units ${fmt(H.non)} = ${fmt(H.units)} units at close`,
    `Range, the middle half of past launches: ${fmt(H.lo)} to ${fmt(H.hi)}`,
    ...(H.edition ? [`Edition ${fmt(H.edition)} · sell-through ${fmtPct(H.pct, 0)}`] : []),
    ...(H.target ? [`Units target ${fmt(H.target)} · ${fmtPct(H.pctTarget, 0)} of it`] : []),
    `Pieces per order ${fmt(f.ppo, 2)} (${f.ppoSource === "release" ? "typed" : "the basket's"})`,
    ...Object.keys(GROUP_NAMES).map((g) => `${GROUP_NAMES[g]}: product / release rate ${fmtPct((rates.prod || {})[g] ?? 0, 0)} / ${fmtPct((rates.rel || {})[g] ?? 0, 0)} · ${fmt(H.nonByGroup ? H.nonByGroup[g] : 0)} non-signup units at ×${fmt(H.perfByGroup ? H.perfByGroup[g] : 1, 2)}`),
    `Signup-led units: each channel's signups ${atOpen ? "projected to the open" : "to date"}, product subscriptions and release ones apart, at ${rates.source === "release" ? "the rate typed on the Targets tab" : `the basket's (${fmt(f.basketN ?? 0)} launches) signup to order rates for that channel and kind`}, times the pieces an order takes. ${keyedWords}`,
    `Non-signup units: the same launches' median window sales to buyers who never signed up, by channel, moved ${Math.round((f.beta ?? 0) * 100)}% of the way with this launch's signups against theirs${Array.isArray(f.perfClip) ? ` (the ratio held between ${f.perfClip[0]} and ${f.perfClip[1]})` : ""}, spread over the works by the same shares.`,
    `The band is where completed launches landed around this forecast: the middle half, ${band[0]} to ${band[1]} times it.`,
  ].join("\n");
  // on each edition where every work has one, else on units
  const works = H.works;
  const byEd = works.every((w) => finite(w.edition) && w.edition > 0);
  const scaleOf = (w) => (byEd ? w.edition : 1);
  const unitsMax = Math.max(1, ...works.map((w) => Math.max(w.hi || 0, w.units || 0, w.target || 0, w.edition || 0)));
  const val = (w, v) => (byEd ? ((v ?? 0) / scaleOf(w)) * 100 : v ?? 0);
  const xmax = byEd ? Math.max(100, Math.min(200, Math.ceil(Math.max(...works.map((w) => val(w, w.hi))) / 20) * 20)) : Math.ceil(unitsMax / 50) * 50 || 50;
  const xticks = byEd ? [0, 50, 100, 150, 200].filter((t) => t <= xmax) : [0, xmax / 2, xmax].map(Math.round);
  const pctWord = finite(H.pct) ? `${fmtPct(H.pct, 0)}` : finite(H.pctTarget) ? `${fmtPct(H.pctTarget, 0)} of target` : fmt(H.units);
  return (
    <Card title="Sell-through forecast by work" aria="Sell-through forecast by work">
      <Head v={pctWord} u="forecast"
        aside={finite(H.edition) && H.edition > 0 ? `${Math.round(((H.lo ?? 0) / H.edition) * 100)}–${Math.round(((H.hi ?? 0) / H.edition) * 100)}% · ${fmt(H.units)} of ${fmt(H.edition)}` : `${fmt(H.lo)}–${fmt(H.hi)} · ${fmt(H.units)} units`}
        asideTip={working} />
      <HBarChart H={34 + works.length * 34} L={150} bh={14} xmin={0} xmax={xmax} xticks={xticks} xfmt={(t) => (byEd ? `${t}%` : fmt(t))}
        rows={works.map((w) => short(w.name))}
        ranges={works.map((w) => (finite(w.lo) && finite(w.hi) ? [val(w, w.lo), Math.min(xmax, val(w, w.hi))] : null))}
        series={[{ color: COL.DEEP, vals: works.map((w) => val(w, w.su)) }, { color: COL.MID, vals: works.map((w) => val(w, w.non)) }]}
        ticks={works.map((w) => (finite(w.target) && w.target > 0 ? val(w, w.target) : null))} vline={byEd ? 100 : undefined}
        legend={[{ n: "Signup-led", v: fmt(H.su), k: sw(COL.DEEP) }, { n: "Not signed up", v: fmt(H.non), k: sw(COL.MID) }, { n: "Range", k: sw(COL.PALE) }, { n: "Target", k: lk(COL.INK) }, ...(byEd ? [{ n: "Edition", k: lk("#c4c4c8", "dashed") }] : [])]}
        title={(i) => `${works[i].name}${finite(works[i].edition) ? ` · edition ${fmt(works[i].edition)}` : ""}`}
        rows2={(i) => {
          const w = works[i];
          return [
            { n: "Signup-led", v: fmt(w.su), k: sw(COL.DEEP) },
            { n: "Not signed up", v: fmt(w.non), k: sw(COL.MID) },
            { n: "Forecast", v: `${fmt(w.units)}${finite(w.pct) ? ` (${fmtPct(w.pct, 0)})` : ""}`, k: { width: 8, flex: "0 0 8px" } },
            { n: "Range", v: `${fmt(w.lo)}–${fmt(w.hi)}`, k: sw(COL.PALE) },
            ...(finite(w.target) ? [{ n: "Target", v: `${fmt(w.target)}${finite(w.pctTarget) ? ` · ${fmtPct(w.pctTarget, 0)} of it` : ""}`, k: lk(COL.INK) }] : []),
            ...(finite(w.keyed) ? [{ n: "Keyed signups", v: `${fmt(w.keyed)} · ${fmtPct(w.share, 0)} of the rest`, k: { width: 8, flex: "0 0 8px" } }] : []),
          ];
        }}
        aria={`Sell-through forecast by work: ${works.map((w) => `${w.name} ${fmt(w.units)}`).join(", ")}`} />
    </Card>
  );
}
