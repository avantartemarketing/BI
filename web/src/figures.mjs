/* Figures more than one place prints, worked out once: a card, the
 * explainer (web/src/explain) and the tests all import them from here, so
 * the two cannot round or read apart. Plain JavaScript, no JSX. */
import { fmtDay, paidDayFrac } from "./format.mjs";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/* ---- the walks ----
 * The outcome waterfall's Channels view and the Funnel by channel walk step
 * from a level (the benchmark, or the target) to the outcome the hero prints.
 * Their steps are demand, so on a release over its edition they add up to
 * more than the capped outcome, and the difference is a Beyond sellout step
 * (or, on the funnel walk, a gap left open). Whether a release is capped is
 * the snapshot's to say, never the size of what is left over: the channels
 * are kept to 0.1 of a unit and the levels to whole units, so the leftover of
 * any walk carries rounding of up to a unit either way. */

/* Units of demand past the edition on the walk this horizon draws: the
 * drivers' own Beyond sellout step (the ETL's `oversubscribed`, docs 9), off
 * the steps the card walks - against the basket where there is one - or,
 * with no stored walk for the horizon, the hero's oversubscribedUnits once
 * the release is at its edition. 0 when the release is not over. */
export function walkCap(snap, close = false) {
  const s = snap || {};
  const wf = s.waterfall;
  const view = wf ? (close ? wf : wf.today) : null;
  if (view) {
    const bm = !!s.benchmark && finite(view.benchmark) && Array.isArray(view.stepsBm);
    const steps = (bm ? view.stepsBm : view.steps) || [];
    const over = steps.find((x) => x && x.key === "oversubscribed");
    return over && finite(over.value) ? Math.max(-over.value, 0) : 0;
  }
  const h = s.hero || {};
  const units = finite(h.oversubscribedUnits) && h.oversubscribedUnits > 0 ? h.oversubscribedUnits : 0;
  if (close) return units;
  const total = s.edition && s.edition.total;
  return finite(total) && finite(h.now) && h.now >= total ? units : 0;
}

/* The steps of a walk from `start` that land on `outcome` once `over` units
 * of demand have come off: the rounding left over parked on the largest step,
 * the rule the ETL closes its own walks by, so the steps add up to the figure
 * printed. `whole` is for a card that prints whole units: the steps are then
 * whole numbers that still add up, each within a unit of its own value. */
export function closeWalk(values, start, outcome, over = 0, { whole = false } = {}) {
  const vs = values.map((v) => (finite(v) ? v : 0));
  if (!vs.length) return vs;
  const gap = outcome - start + (over || 0);
  const rest = gap - vs.reduce((a, b) => a + b, 0);
  let big = 0;
  vs.forEach((v, i) => { if (Math.abs(v) > Math.abs(vs[big])) big = i; });
  vs[big] += rest;
  return whole ? wholeParts(vs, Math.round(gap)) : vs;
}

/* Whole numbers that add up to `total`, each within a unit of its value:
 * every value floored, the spare units to the largest remainders (a tie to
 * the larger value, where a unit moves the figure least), as the explainer's
 * roundParts does. */
function wholeParts(vs, total) {
  const out = vs.map((v) => Math.floor(v));
  let spare = total - out.reduce((a, b) => a + b, 0);
  const order = vs.map((v, i) => ({ i, v, r: Math.round((v - Math.floor(v)) * 1e6) }))
    .sort((a, b) => b.r - a.r || b.v - a.v);
  for (let j = 0; spare > 0 && j < order.length; j++, spare--) out[order[j].i] += 1;
  for (let j = order.length - 1; spare < 0 && j >= 0; j--, spare++) out[order[j].i] -= 1;
  return out;
}

/* The outcome waterfall's Channels view as data: each channel steps from its
 * reference to its own units (today) or its projection (at close), whole
 * units that add up, from the benchmark (or the target without a basket) to
 * the outcome, with the Beyond sellout step, `beyond` (negative), only on a
 * release really over its edition. `today` is the card's horizon as it
 * reads it (false where the snapshot has no Today walk and the card shows
 * the close). */
export function channelWalk(snap, { today = false } = {}) {
  const s = snap || {};
  const wf = s.waterfall;
  if (!wf) return null;
  const view = today && wf.today ? wf.today : wf;
  const isToday = today && !!wf.today;
  const hasBm = !!s.benchmark && finite(view.benchmark) && Array.isArray(view.stepsBm);
  const start = hasBm ? view.benchmark : view.target ?? 0;
  const outcome = (isToday ? view.actual : view.projection) ?? 0;
  const over = walkCap(s, !isToday);
  const chans = (s.channels || []).map((c) => {
    const a = isToday ? c.now ?? 0 : c.proj ?? 0;
    const e = hasBm ? (isToday ? c.bmExp ?? 0 : c.bm ?? 0) : (isToday ? c.exp ?? 0 : c.target ?? 0);
    return { key: c.key, label: c.name, a, e };
  });
  const values = closeWalk(chans.map((c) => c.a - c.e), start, outcome, over, { whole: true });
  let run = start;
  const steps = chans.map((c, i) => { const from = run; run += values[i]; return { ...c, value: values[i], from, to: run }; });
  return { start, outcome, hasBm, steps, beyond: over > 0 ? -over : 0, end: run };
}

/* ---- paid ---- */

/* Paid's units against its target: the one figure the Channels card's Paid
 * column, the Paid spend card's units bar and the paid.units explanation
 * print. It is the paid channel row, the fields the Channels card divides
 * (now and exp today, proj and target at close), so the three cannot round
 * apart; a snapshot without a paid row falls back to the paid block. */
export function paidUnits(snap, close = false) {
  const s = snap || {};
  const p = s.paid || {};
  const c = (s.channels || []).find((x) => x && x.key === "paid");
  const hasBm = !!s.benchmark;
  let now, proj, target, bm;
  if (c) {
    now = c.now ?? 0;
    proj = c.proj ?? now;
    target = (close ? c.target : c.exp) ?? 0;
    const b = close ? c.bm : c.bmExp;
    bm = hasBm && finite(b) ? b : null;
  } else {
    const frac = paidDayFrac(s, close);
    now = p.unitsToDate ?? 0;
    proj = s.complete ? now : p.unitProjected ?? now;
    target = (p.unitTarget ?? 0) * frac;
    bm = hasBm && finite(p.benchmarkUnits) ? p.benchmarkUnits * frac : null;
  }
  const fill = close ? proj : now;
  return { now, proj, fill, target, bm, pct: target > 0 ? fill / target : null, fromRow: !!c };
}

/* ---- social ---- */

/* How far the AA Meta post count reaches. The Emplifi export is a file
 * somebody regenerates by hand, so where it stops before the release's
 * window the count is not known (a dash, not a zero), and where it stops
 * inside the window the count runs to its last day only. Null when the count
 * covers the window: the live Notion log, or an export that reaches it. */
export function postsCover(snap) {
  const so = (snap && snap.social) || {};
  if (!so.postsThrough || !(so.postsEndsFirst || so.postsPartial)) return null;
  const d = new Date(String(so.postsThrough).slice(0, 10) + "T00:00:00Z");
  const through = Number.isFinite(d.getTime()) ? fmtDay(d) : String(so.postsThrough);
  return { through, endsFirst: !!so.postsEndsFirst, partial: !so.postsEndsFirst && !!so.postsPartial };
}
