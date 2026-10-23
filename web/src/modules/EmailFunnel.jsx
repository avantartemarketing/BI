/* Email funnel: the release's email rates against the basket's, one bar a
 * stage, the basket a dotted tick. Open rate and click rate come from the
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
  const xmax = Math.max(100, ...steps.map((s) => Math.max(s.v, s.ref || 0)));
  const top = xmax > 100 ? Math.ceil(xmax / 25) * 25 : 100;
  return (
    <Card title="Email funnel" aria="Email funnel">
      {head}
      <HBarChart H={34 + steps.length * 34} L={164} bh={12} xmin={0} xmax={top} xticks={[0, 25, 50, 75, 100].filter((t) => t <= top)} xfmt={(t) => `${t}%`}
        rows={steps.map((s) => s.name)}
        series={[{ color: COL.IND, vals: steps.map((s) => s.v) }, { color: COL.TRACK, vals: steps.map((s) => Math.max(0, top - s.v)) }]}
        ticks={steps.map((s) => s.ref)} tickDa="1 3"
        legend={[{ n: "This launch", k: sw(COL.IND) }, { n: "Basket", k: lk(COL.INK, "dotted") }]}
        title={(i) => steps[i].name}
        rows2={(i) => {
          const s = steps[i];
          const d = finite(s.ref) && s.ref > 0 ? Math.round((s.v / s.ref - 1) * 100) : null;
          return [
            { n: "This launch", v: `${pc(s.v)} · ${s.n}`, k: sw(COL.IND) },
            s.ref != null ? { n: s.src === "sends" ? "Basket" : "Basket, organic sessions", v: `${pc(s.ref)}  ${d >= 0 ? "+" : "−"}${Math.abs(d)}%`, k: lk(COL.INK, "dotted") } : { n: "Basket", v: "no reading", k: lk(COL.INK, "dotted") },
          ];
        }}
        aria={`Email funnel: ${steps.map((s) => `${s.name} ${pc(s.v)}${s.ref != null ? ` against ${pc(s.ref)} in ${basketWords}` : ""}`).join("; ")}`} />
    </Card>
  );
}
