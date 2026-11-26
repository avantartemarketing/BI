/* The plan check, in words (the grey line under the plan card's headline):
 * whether the plan is the right size for the target, going by the launches
 * that sold nearest it at a similar price, with the artist's own earlier
 * launches beside it. The target says how much the work is wanted; this says
 * only whether the comms are enough for a launch that size (etl/plan_view.py
 * override). Nothing on a plan sized the older way.
 *
 * The line reads the plan before any results and the headline above it reads
 * where the launch is heading, so the two can point opposite ways: a plan
 * about right for its target on a launch landing far short of it, or one too
 * small on a launch that reaches it. On 26 November 2026 five of the eight
 * live plan pages read like that, and the repository owner found the line
 * confusing. So once a launch is live and heading outside what its plan
 * should bring, a last sentence says where it is heading and why, and no
 * figure in the line is called "short" beside the headline's own.
 *
 * Plain JavaScript, no JSX, so the tests can import it. */
import { fmt } from "./format.mjs";

const n = (v) => fmt(Math.round(v));
const num = (v) => typeof v === "number" && Number.isFinite(v);

export function planCheck(p) {
  if (!p || !p.against) return null;
  const ranged = Array.isArray(p.range) && num(p.range[0]) && num(p.range[1]);
  const lo = ranged ? Math.round(p.range[0]) : null, hi = ranged ? Math.round(p.range[1]) : null;
  // a timed launch before its window is read in signups, or in signup conversions (web/src/conversions.mjs)
  const unit = p.of === "conversions" ? " conversions" : p.of === "signups" ? " signups" : "";
  const tg = `${n(p.target)} target`;
  const lead = p.against === "in line" ? `The plan is about right for the ${tg}.`
    : p.against === "short" ? `The plan is too small for the ${tg}.`
      : `The plan is bigger than the ${tg} needs.`;
  // what the plan should bring: the similar launches' range, and under a plan too small the part of the target
  // left over, in the words of its row in the bars
  const gap = Math.round(p.notCovered || 0);
  const left = p.against === "short" && gap > 0 ? `, which leaves ${n(gap)} not covered` : "";
  const span = ranged ? ` Going by similar launches, it should bring ${lo === hi ? `about ${n(lo)}` : `${n(lo)} to ${n(hi)}`}${unit}${left}.` : "";
  // where the launch is heading instead, once it has results and they take it outside that range
  const lands = num(p.lands) ? Math.round(p.lands) : null;
  const off = p.state === "start" || !ranged || lands === null ? null : lands < lo ? "behind" : lands > hi ? "ahead of" : null;
  const now = off ? ` The launch is heading for ${n(lands)} because it is running ${off} the plan, and the bars below show where.` : "";
  const title = (name) => { const b = String(name || "").split(" · "); return b.length > 2 ? `${b[1]} (${b[b.length - 1]})` : name; };
  const own = (p.ownRecord || []).filter((r) => r && r.edition > 0 && r.sold !== null && r.sold !== undefined);
  const record = own.length ? "The artist's earlier launches: " + own.map((r) => `${title(r.name)} sold ${n(r.sold)} of ${n(r.edition)}${r.cover ? `, entries ${r.cover.toFixed(1)} times the edition` : ""}`).join("; ") + "." : null;
  return { kind: p.against, lead, span, now, record, similar: (p.similar || []).map((x) => String(x.name || "").split(" · ")[0]) };
}
