/* Email funnel: each stage of the release's email funnel as its deviation
 * from the plan or the basket, as the page's Compare to switch reads (the
 * basket alone on a release without targets), a bar right of the line where
 * this launch runs above it and left where below, no key; the figures
 * themselves in the readout. The first four stages are the chain the email
 * sessions are built from (docs/DATA_MODEL.md, email.deliveredTarget):
 * delivered x open rate x sessions per open = AA Email sessions, so their
 * deviations multiply to the sessions' own against the same reference, the
 * figure Funnel by channel shows (9 November 2026; the clicks step folded
 * into sessions per open the same day, at the owner's request). The
 * plan holds every rate at the basket's and scales only the volume, so the
 * rates read the same reference either way and Delivered is where the plan
 * and the basket differ. The sends come from the sends on file (snap.email),
 * the sessions from the funnel (funnelByGroup.aa_email); the page stages
 * (release page to product page when the release has more than one work,
 * product page to signup, entry or order) from the organic side of the
 * pages feed (snap.pageFunnel). A stage with nothing to read sits on the
 * line in grey, and a card with no stage says so. */
import React from "react";
import { Card, Head, vsDelta } from "../ui.jsx";
import { HBarChart, COL, sw, lk } from "../charts.jsx";
import { fmt, fmtPct } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";
import "../cards.css";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const pc = (x) => `${Math.round(x * 10) / 10}%`;

export function emailStages(snap, vs = "target") {
  const e = snap.email || {};
  const refs = snap.benchmarks || {};
  const pf = snap.pageFunnel || null;
  const org = (pf && pf.organic) || {};
  const works = (snap.sellthrough && snap.sellthrough.products ? snap.sellthrough.products.length : 0) || (snap.works || []).length;
  const W = wordsOf(snap);
  const entryWord = snap.type === "TL" ? (snap.tlState === "window" || snap.tlState === "settling" || snap.tlState === "closed" ? "order" : "signup") : "entry";
  const byPlan = vs !== "benchmark" && snap.targeted !== false && finite(e.deliveredTarget) && e.deliveredTarget > 0;
  const sessions = ((snap.funnelByGroup || {}).aa_email || {}).sessions_actual;
  const pctRef = (v) => (finite(v) && v > 0 ? v / 100 : null);
  const out = [];
  if (e.delivered > 0) {
    const ref = byPlan ? e.deliveredTarget : e.deliveredBenchmark;
    out.push({ name: "Delivered", v: e.delivered, ref: finite(ref) && ref > 0 ? ref : null, n: `${fmt(e.sends)} send${e.sends === 1 ? "" : "s"}`, kind: "count" });
  }
  if (e.delivered > 0 && finite(e.opened)) out.push({ name: "Open rate", v: e.opened / e.delivered, ref: pctRef(refs.emailOpenRateRef), n: `${fmt(e.opened)} of ${fmt(e.delivered)} delivered` });
  // sessions per open: the basket's clicks per open x its sessions per click
  const spoRef = finite(refs.emailClickToOpenRef) && refs.emailClickToOpenRef > 0 && finite(refs.emailSessionsPerClickRef) && refs.emailSessionsPerClickRef > 0
    ? (refs.emailClickToOpenRef / 100) * refs.emailSessionsPerClickRef : null;
  if (e.opened > 0 && finite(sessions)) out.push({ name: "Sessions per open", v: sessions / e.opened, ref: spoRef, n: `${fmt(sessions)} AA Email sessions from ${fmt(e.opened)} opened`, kind: "ratio" });
  const ct = org.clickThrough;
  if (works > 1 && ct && finite(ct.rate)) out.push({ name: "Release to product page", v: ct.rate, ref: finite(ct.bm) && ct.bm > 0 ? ct.bm : null, n: `${fmt(ct.through)} of ${fmt(ct.sessions)} organic sessions`, src: "pages" });
  const en = org.entry;
  if (en && finite(en.rate)) out.push({ name: `Product page to ${entryWord}`, v: en.rate, ref: finite(en.bm) && en.bm > 0 ? en.bm : null, n: `${fmt(en.through)} of ${fmt(en.sessions)} organic sessions`, src: "pages" });
  return { steps: out, byPlan, sessions };
}

export default function EmailFunnel({ snap, vs = "target" }) {
  const { steps, byPlan, sessions } = emailStages(snap, vs);
  const e = snap.email || {};
  const g = (snap.funnelByGroup || {}).aa_email || {};
  const cohort = (snap.benchmarks || {}).emailRefCohort;
  const basketWords = cohort ? `the ${fmt(cohort.n)} launches with sends on file` : "the basket";
  const units = finite(g.units_actual) ? g.units_actual : null;
  const emailCh = (snap.channels || []).find((c) => c.key === "aa_email");
  const unitsNow = emailCh ? emailCh.now : units;
  const byBm = vs === "benchmark";
  const unitsExp = emailCh ? (byBm ? emailCh.bmExp : emailCh.exp) : null;
  const W = wordsOf(snap);
  const head = finite(unitsNow)
    ? <Head v={fmt(unitsNow)} u={`${W.unit} from email`} deltas={[byBm ? vsDelta(unitsNow, unitsExp, "benchmark", "Against the basket's AA Email units by today") : vsDelta(unitsNow, unitsExp, "plan", "Against the plan's AA Email units by today")]} aside={e.sends ? `${fmt(e.sends)} send${e.sends === 1 ? "" : "s"}` : ""} />
    : null;
  if (!steps.length) {
    return <Card title="Email funnel" aria="Email funnel">{head}<div className="empty-state">No sends on file for this release yet</div></Card>;
  }
  // the reference the bars are read against, as Funnel by channel reads it
  const refWord = byPlan ? "plan" : "basket";
  const RefWord = byPlan ? "Plan" : "Basket";
  // each stage as its deviation from the reference: a bar right of zero
  // where this launch runs above it, left where below; a stage with no
  // reference sits on the line in grey
  const dev = steps.map((s) => (finite(s.ref) && s.ref > 0 ? (s.v / s.ref - 1) * 100 : 0));
  const grey = steps.map((s, i) => (finite(s.ref) && s.ref > 0 ? null : i)).filter((i) => i !== null);
  const lim = Math.max(25, ...dev.map((d) => Math.abs(d)));
  const top = lim <= 50 ? 50 : lim <= 100 ? 100 : Math.ceil(lim / 100) * 100;
  const xt = top <= 100 ? [-top, -top / 2, 0, top / 2, top] : [-top, 0, top];
  const signedPc = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d))}%`;
  const show = (s, v) => (s.kind === "count" ? fmt(v) : s.kind === "ratio" ? (Math.round(v * 100) / 100).toFixed(2) : pc(v * 100));
  const refName = (s) => (s.kind === "count" ? (byPlan ? "Plan by today" : "Basket by today") : s.src === "pages" ? `${RefWord}, organic sessions` : byPlan ? "Plan (the basket's rate)" : "Basket");
  // the four sends stages multiply to the AA Email sessions against the same reference
  const sessRef = byPlan ? g.sessions_expected : g.sessions_benchmark;
  const sessDev = finite(sessions) && finite(sessRef) && sessRef > 0 ? (sessions / sessRef - 1) * 100 : null;
  const chained = steps.filter((s) => !s.src).length === 3 && steps.filter((s) => !s.src).every((s) => finite(s.ref) && s.ref > 0);
  return (
    <Card title="Email funnel" aria="Email funnel">
      {head}
      <HBarChart H={34 + steps.length * 34} L={164} bh={12} xmin={-top} xmax={top} xticks={xt} xfmt={(t) => (t === 0 ? RefWord : signedPc(t))}
        rows={steps.map((s) => s.name)} diverging vals={dev} greyRows={grey} posColor={COL.IND} negColor={COL.ORANGE}
        title={(i) => steps[i].name}
        rows2={(i) => {
          const s = steps[i];
          const has = finite(s.ref) && s.ref > 0;
          return [
            { n: "This launch", v: `${show(s, s.v)} · ${s.n}`, k: sw(has ? (dev[i] >= 0 ? COL.IND : COL.ORANGE) : COL.SOFT) },
            has ? { n: refName(s), v: show(s, s.ref), k: lk(COL.INK, "dotted") } : { n: RefWord, v: "no reading", k: lk(COL.INK, "dotted") },
            ...(has ? [{ n: `Against the ${refWord}`, v: signedPc(dev[i]), k: null }] : []),
          ];
        }}
        aria={`Email funnel against the ${refWord}: ${steps.map((s, i) => `${s.name} ${show(s, s.v)}${finite(s.ref) && s.ref > 0 ? ` (${signedPc(dev[i])} against ${show(s, s.ref)})` : ""}`).join("; ")}`} />
      {chained && sessDev !== null && (
        <div className="cnote" title={`Delivered x open rate x sessions per open = AA Email sessions, so the three bars multiply to the sessions against the ${refWord}, the figure Funnel by channel shows. The plan holds the rates at ${basketWords}' and scales the volume, so Delivered is where the plan and the basket part.`}>
          Together: AA Email sessions <b className={sessDev >= 0 ? "rag-up" : sessDev >= -20 ? "rag-near" : "rag-dn"}>{signedPc(sessDev)}</b> vs {refWord}
        </div>
      )}
    </Card>
  );
}
