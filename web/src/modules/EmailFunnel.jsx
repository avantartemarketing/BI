/* Email funnel: each stage of the release's email funnel as its deviation
 * from the basket's rate, a bar right of the basket line where this launch
 * runs above it and left where below; the rates themselves in the readout. Open rate and click rate come from the
 * sends on file (snap.email); the page stages (release page to product page
 * when the release has more than one work, product page to signup, entry or
 * order) from the organic side of the pages feed (snap.pageFunnel). A stage
 * with nothing to read is left out, and a card with no stage says so. */
import React from "react";
import { Card, Head, vsDelta } from "../ui.jsx";
import { HBarChart, COL, sw, lk } from "../charts.jsx";
import { fmt, fmtPct } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const pc = (x) => `${Math.round(x * 10) / 10}%`;

export function emailStages(snap) {
  const e = snap.email || {};
  const refs = snap.benchmarks || {};
  const pf = snap.pageFunnel || null;
  const org = (pf && pf.organic) || {};
  const works = (snap.sellthrough && snap.sellthrough.products ? snap.sellthrough.products.length : 0) || (snap.works || []).length;
  const W = wordsOf(snap);
  const entryWord = snap.type === "TL" ? (snap.tlState === "window" || snap.tlState === "settling" || snap.tlState === "closed" ? "order" : "signup") : "entry";
  const out = [];
  if (finite(e.openRate) && e.delivered > 0) out.push({ name: "Open rate", v: e.openRate * 100, ref: finite(refs.emailOpenRateRef) ? refs.emailOpenRateRef : null, n: `${fmt(e.opened)} of ${fmt(e.delivered)} delivered`, src: "sends" });
  if (finite(e.clickRate) && e.delivered > 0) out.push({ name: "Click rate", v: e.clickRate * 100, ref: finite(refs.emailClickRateRef) ? refs.emailClickRateRef : null, n: `${fmt(e.clicked)} of ${fmt(e.delivered)} delivered`, src: "sends" });
  const ct = org.clickThrough;
  if (works > 1 && ct && finite(ct.rate)) out.push({ name: "Release to product page", v: ct.rate * 100, ref: finite(ct.bm) && ct.bm > 0 ? ct.bm * 100 : null, n: `${fmt(ct.through)} of ${fmt(ct.sessions)} sessions`, src: "pages" });
  const en = org.entry;
  if (en && finite(en.rate)) out.push({ name: `Product page to ${entryWord}`, v: en.rate * 100, ref: finite(en.bm) && en.bm > 0 ? en.bm * 100 : null, n: `${fmt(en.through)} of ${fmt(en.sessions)} sessions`, src: "pages" });
  return out;
}

export default function EmailFunnel({ snap }) {
  const steps = emailStages(snap);
  const e = snap.email || {};
  const g = (snap.funnelByGroup || {}).aa_email || {};
  const cohort = (snap.benchmarks || {}).emailRefCohort;
  const basketWords = cohort ? `the ${fmt(cohort.n)} launches with sends on file` : "the basket";
  const units = finite(g.units_actual) ? g.units_actual : null;
  const emailCh = (snap.channels || []).find((c) => c.key === "aa_email");
  const unitsNow = emailCh ? emailCh.now : units;
  const unitsExp = emailCh ? emailCh.exp : null;
  const W = wordsOf(snap);
  const head = finite(unitsNow)
    ? <Head v={fmt(unitsNow)} u={`${W.unit} from email`} deltas={[vsDelta(unitsNow, unitsExp, "plan", "Against the plan's AA Email units by today")]} aside={e.sends ? `${fmt(e.sends)} send${e.sends === 1 ? "" : "s"}` : ""} />
    : null;
  if (!steps.length) {
    return <Card title="Email funnel" aria="Email funnel">{head}<div className="empty-state">No sends on file for this release yet</div></Card>;
  }
  // each stage as its deviation from the basket's rate: a bar right of zero
  // where this launch runs above it, left where below; a stage the basket
  // has no reading for sits on the line in grey
  const dev = steps.map((s) => (finite(s.ref) && s.ref > 0 ? (s.v / s.ref - 1) * 100 : 0));
  const grey = steps.map((s, i) => (finite(s.ref) && s.ref > 0 ? null : i)).filter((i) => i !== null);
  const lim = Math.max(25, ...dev.map((d) => Math.abs(d)));
  const top = lim <= 50 ? 50 : lim <= 100 ? 100 : Math.ceil(lim / 100) * 100;
  const xt = top <= 100 ? [-top, -top / 2, 0, top / 2, top] : [-top, 0, top];
  const signedPc = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d))}%`;
  return (
    <Card title="Email funnel" aria="Email funnel">
      {head}
      <HBarChart H={34 + steps.length * 34} L={164} bh={12} xmin={-top} xmax={top} xticks={xt} xfmt={(t) => (t === 0 ? "Basket" : signedPc(t))}
        rows={steps.map((s) => s.name)} diverging vals={dev} greyRows={grey} posColor={COL.IND} negColor={COL.ORANGE}
        legend={[{ n: "Above the basket", k: sw(COL.IND) }, { n: "Below the basket", k: sw(COL.ORANGE) }]}
        title={(i) => steps[i].name}
        rows2={(i) => {
          const s = steps[i];
          const has = finite(s.ref) && s.ref > 0;
          return [
            { n: "This launch", v: `${pc(s.v)} · ${s.n}`, k: sw(has ? (dev[i] >= 0 ? COL.IND : COL.ORANGE) : COL.SOFT) },
            has ? { n: s.src === "sends" ? "Basket" : "Basket, organic sessions", v: pc(s.ref), k: lk(COL.INK, "dotted") } : { n: "Basket", v: "no reading", k: lk(COL.INK, "dotted") },
            ...(has ? [{ n: "Against the basket", v: signedPc(dev[i]), k: null }] : []),
          ];
        }}
        aria={`Email funnel against the basket: ${steps.map((s, i) => `${s.name} ${pc(s.v)}${finite(s.ref) && s.ref > 0 ? ` (${signedPc(dev[i])} against ${pc(s.ref)} in ${basketWords})` : ""}`).join("; ")}`} />
    </Card>
  );
}
