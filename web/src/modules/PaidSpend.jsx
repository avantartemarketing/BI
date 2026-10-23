/* Paid spend: the spend by day as bars, the plan's daily pace as a dashed
 * mark across every day, and ahead of today the daily budget the rules
 * recommend (paid.budget.recommended, docs 7) as lighter bars to the close.
 * The head is the spend to date against the budget's share by today: paid
 * runs from the day after the announce to the close with its budget planned
 * evenly over those days (paidDayFrac), so that share of the days is the
 * share of it that should be spent; at close the whole budget. The rule
 * that shaped the recommendation ("Capped by") and its working are on the
 * lozenge's hover; the paid units against their target (figures.mjs
 * paidUnits) are on the aside's. A timed launch paces the budget left
 * evenly over the time left instead (docs/TL_SPEC.md 7); a release without
 * targets shows the spend alone. Suggested actions on the budget (Implement
 * and Ignore) are in beta and off the page. */
import React from "react";
import { Card, Head, Loz, vsDelta } from "../ui.jsx";
import { BarChart, niceAxis, kfmt, COL, sw, lk } from "../charts.jsx";
import { fmt, fmtMoney, fmtSigned, fmtDay, dayLabel, dayElapsed, paidDayFrac } from "../format.mjs";
import { paidUnits } from "../figures.mjs";
import { wordsOf, hourClock } from "../vocab.mjs";
import { stepTicks, stepOf } from "./clock.mjs";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const money = (v) => fmtMoney(Math.round(v ?? 0));
const CAPS = {
  supply: ["Sellout", "Supply - sell-out", "The spend that sells the edition out by launch, at the cost per entry that spend implies: more would buy entries the edition cannot hold."],
  roi_floor: ["Floor", "ROI floor", "The floor is on ROI at close, on the cost path the Paid ROI chart draws: cost per entry rises as the campaign's spend adds up, so a bigger budget wears it out faster. The recommendation is the spend at which that reading ends on the floor."],
  pacing: ["Pacing", "Pacing ±30% / day", "The workbook's pacing rule: never move the daily budget by more than 30% in a day, since a bigger jump resets Meta's learning and the price with it."],
  roi_band_hold: ["Hold", "ROI band - hold", "Cumulative ROI is between 0.9 and 1.3: the rules say hold, so spend is not raised even though more would sell more."],
  roi_band_decrease: ["Decrease", "ROI band - decrease", "Cumulative ROI is below 0.9: the rules say decrease, by up to 30% a day."],
  forced_decrease: ["Forced", "3 days below target ROI - forced decrease", "The trailing 3-day ROI has been below target on each of the last three full days: the rules force a decrease."],
  plan_rate: ["Plan", "Plan rate (first day)", "No spend yet to anchor a price on, so the first day starts at the plan's daily rate."],
  zero_conversion: ["Zero", "Zero conversion yesterday", "The LE spend rules: a day that spent and bought no entries cuts the budget by 30%."],
  zero_conversion_pause: ["Pause", "3 days of zero conversion - pause", "The LE spend rules: three days of spend with no entries pause the campaign."],
  hold_small_change: ["Steady", "Change under 10% - hold", "The recommendation is within 10% of today's spend, which the rules treat as no change."],
};

export default function PaidSpend({ snap, horizon = "today" }) {
  const V = wordsOf(snap);
  const tl = snap.type === "TL";
  const hours = hourClock(snap);
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const budget = paid.budget || {};
  const targeted = snap.targeted !== false;
  const complete = !!snap.complete;
  const close = horizon === "close" || complete;
  const noCampaign = !snap.campaignName;
  const of = Math.max(1, snap.of || 1);
  const today = Math.max(0, Math.min(snap.day ?? 0, of));
  const n = of + 1;
  const hasBm = !!snap.benchmark;
  const paidOff = hasBm && (snap.benchmark.channelsOff || []).includes("paid");

  // ----- the spend by step -----
  const rows = daily.map((d, i) => {
    let s = stepOf(snap, d.date);
    if (s === null) s = (snap.day ?? 0) - (daily.length - 1 - i);
    return { s: Math.round(s), spend: d.spend ?? 0, entries: d.entries ?? null, converting: d.converting, partial: !!d.partial, date: d.date };
  }).filter((r) => r.s >= 0 && r.s <= of);
  const byStep = new Map(rows.map((r) => [r.s, r]));
  const spendVals = Array.from({ length: n }, (_, i) => (byStep.has(i) ? byStep.get(i).spend : i <= today ? 0 : null));
  const spendNow = paid.spendToDate ?? rows.reduce((a, r) => a + r.spend, 0);

  // ----- the pace: the plan's daily rate, and what to spend from here -----
  const spendBudget = targeted && has(paid.spendBudget) ? paid.spendBudget : null;
  const paidDays = has(paid.paidDays) && paid.paidDays > 0 ? paid.paidDays : Math.max(1, of - (paid.paidStartDays ?? 1));
  const planPace = spendBudget !== null ? spendBudget / (hours ? paidDays * 24 : paidDays) : null;
  const dayFrac = paidDayFrac(snap, close);
  const spendTarget = spendBudget !== null ? spendBudget * dayFrac : null;
  // the daily budget from here: the rules' recommendation on a draw launch,
  // the budget left over the time left on a timed launch
  const left = Math.max(of - dayElapsed(snap), 0);
  const rec = complete || noCampaign ? null
    : tl ? (spendBudget !== null && left > 0 ? Math.max((spendBudget - spendNow) / left, 0) : null)
    : has(budget.recommended) ? budget.recommended : null;
  const recVals = Array.from({ length: n }, (_, i) => (rec !== null && i > today ? rec : null));
  const cur = has(budget.current) ? budget.current : null;
  const d = cur !== null && rec !== null ? Math.round(rec) - Math.round(cur) : null;

  // ----- "Capped by": what bound the recommendation -----
  const showCap = !tl && !complete && !noCampaign && rec !== null && !!budget.cap;
  const [capWord, capName, capBody] = CAPS[budget.cap] || [budget.cap, budget.cap, ""];
  const fullWorks = (Array.isArray(budget.fullWorks) ? budget.fullWorks : []).map((w) => (typeof w === "string" ? { name: w, date: null } : w)).filter((w) => w && w.name);
  const yieldNow = typeof budget.yieldNow === "number" ? Math.round(budget.yieldNow * 100) : null;
  const yieldEnd = typeof budget.yieldAtClose === "number" ? Math.round(budget.yieldAtClose * 100) : null;
  const capTip = [
    `${capName}${budget.paced ? " · paced" : ""}`, capBody,
    `Current ${cur !== null ? money(cur) : "–"}${budget.offToday ? " · off today" : ""} · recommended ${money(rec)}${d ? ` (${fmtSigned(d)})` : ""}`,
    `Cost per unit now ${budget.cpeNow ? fmtMoney(budget.cpeNow) : "–"} · at recommended ${budget.cpeAtRecommended ? fmtMoney(budget.cpeAtRecommended) : "–"}`,
    `ROI at close at recommended ${fmt(budget.finalDayRoi, 2)} · cumulative ROI ${budget.cumRoi ? fmt(budget.cumRoi, 2) : "–"} · floor ${fmt(budget.floor ?? 1, 1)}`,
    `Spend to sell out ${has(budget.supplySpend) ? money(budget.supplySpend) : "–"} a day · at the ROI floor ${has(budget.roiSpend) ? money(budget.roiSpend) : "–"} a day`,
    ...(yieldNow !== null && (budget.yieldNow < 0.999 || fullWorks.length)
      ? [`Entries that buy a unit: ${yieldEnd !== null && yieldEnd !== yieldNow ? `${yieldNow}% today, ${yieldEnd}% by the end of the run` : `${yieldNow}%`}`,
         ...fullWorks.map((w) => `${w.name}: ${w.date ? `full from ${fmtDay(new Date(w.date + "T00:00:00Z"))}` : "full now"}`)] : []),
    ...(budget.paced ? ["Pacing: move limited to 30% a day"] : []),
  ].filter(Boolean).join("\n");

  // ----- the paid units against their target, on the aside -----
  const pu = paidUnits(snap, close);
  const unitsBm = hasBm ? pu.bm : null;
  const unitsTip = [
    `${V.paidUnits}: ${fmt(pu.now)} to date${close && !complete ? `, ${fmt(pu.proj)} projected` : ""}`,
    ...(targeted ? [`Target ${close ? "" : "today "}${fmt(pu.target)}${pu.pct !== null ? ` (${Math.round(pu.pct * 100)}%)` : ""}`] : []),
    ...(unitsBm !== null ? [`Benchmark ${close ? "" : "today "}${fmt(unitsBm)}, the median of the matched basket`] : []),
    ...(paidOff ? ["Paid is not in plan for this release: no target and no budget. The spend and units are what actually ran."] : []),
  ].join("\n");

  const top = Math.max(1, ...spendVals.filter(has), rec ?? 0, planPace ?? 0);
  const ax = niceAxis(top);
  const title = "Paid spend";
  if (!rows.length && !(spendNow > 0)) {
    return <Card title={title}><div className="empty-state">{noCampaign ? "No Meta campaign matched to this release: set one on the Targets tab" : "No paid spend yet"}</div></Card>;
  }
  const paceName = tl ? `Pace to the ${V.closeWord}` : "Recommended";
  return (
    <Card title={title} aria="Paid spend by day">
      <Head v={fmtMoney(spendNow, 0)} u="in total"
        deltas={[spendTarget !== null ? vsDelta(spendNow, spendTarget, complete ? "budget" : "budget pace", `${money(spendNow)} spent against the ${money(spendTarget)} the budget ${complete ? "set" : `plans by ${V.stepWord} ${today}`}${spendBudget !== null ? ` (${money(spendBudget)} in all)` : ""}`) : null]}
        aside={`${fmt(pu.now)} paid ${V.unit}`} asideTip={unitsTip}>
        {showCap && <Loz kind="ghost" tip={capTip}>Capped by {capWord}</Loz>}
      </Head>
      <BarChart H={250} L={44} overlay ymax={ax.ymax} yticks={ax.ticks} yfmt={(t) => (t ? `€${kfmt(t)}` : "0")}
        cats={Array.from({ length: n }, (_, i) => dayLabel(snap, i))} xlab={stepTicks(snap, of)}
        series={[{ name: "Spend", color: COL.IND, vals: spendVals }, ...(rec !== null ? [{ name: paceName, color: COL.LIGHT, vals: recVals }] : [])]}
        refs={planPace !== null ? [{ name: "Plan pace", color: COL.DARK, da: "4 4", vals: Array.from({ length: n }, (_, i) => (i >= (paid.paidStartDays ?? 1) ? planPace : null)) }] : []}
        legend={[
          { n: "Spend", v: fmtMoney(spendNow, 0), k: sw(COL.IND) },
          ...(rec !== null ? [{ n: paceName, v: `${money(rec)} a ${hours ? "hour" : "day"}`, k: sw(COL.LIGHT), tip: tl ? `The ${V.state === "signups" ? "pre-window" : "window"} budget left, spread evenly over the time left to the ${V.closeWord}: pacing, not a recommendation` : capTip }] : []),
          ...(planPace !== null ? [{ n: "Plan pace", v: `${money(planPace)} a ${hours ? "hour" : "day"}`, k: lk(COL.DARK, "dashed"), tip: `The budget of ${money(spendBudget)} planned evenly over the ${paidDays} days paid runs` }] : []),
        ]}
        title={(i) => dayLabel(snap, i, true) + (!complete && i === today ? ", today" : "")}
        rows={(i) => {
          const r = byStep.get(i);
          if (!r) return i > today && rec !== null ? [{ n: paceName, v: `${money(rec)} a ${hours ? "hour" : "day"}`, k: sw(COL.LIGHT) }] : [{ n: "Spend", v: "€0", k: sw(COL.IND) }];
          return [
            { n: r.partial ? "Spend so far today" : "Spend", v: fmtMoney(r.spend, 0), k: sw(COL.IND) },
            ...(has(r.entries) ? [{ n: tl ? `Paid ${V.unit}` : "Entries", v: fmt(r.entries), k: { width: 8, flex: "0 0 8px" } }] : []),
            ...(has(r.converting) ? [{ n: "Converting", v: fmt(r.converting, 1), k: { width: 8, flex: "0 0 8px" } }] : []),
            ...(planPace !== null ? [{ n: "Plan pace", v: money(planPace), k: lk(COL.DARK, "dashed") }] : []),
          ];
        }}
        aria={`Paid spend by day: ${fmtMoney(spendNow, 0)} in total${spendTarget !== null ? ` against ${money(spendTarget)} planned` : ""}`} />
    </Card>
  );
}
