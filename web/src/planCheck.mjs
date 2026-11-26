/* The plan check on the page (docs/PLAN_MODEL.md 6). The build reads whether
 * a launch's comms plan is the right size for its target, going by the
 * launches that sold nearest it at a similar price (etl/plan_view.py
 * override: "in line", "short" or "over"). The page says nothing while the
 * plan is enough. A plan too small is a warning in the strip at the top of
 * the launch's page (ReleasePage.jsx Strips), whichever way the page is
 * switched.
 *
 * Until 26 November 2026 the verdict was a line under the plan card's
 * headline on every page that had one. It read the plan before any results
 * while the headline above it read where the launch was heading, so the two
 * pointed opposite ways on five of the eight live pages that day ("in line
 * with the 862 target" under "644 short of the 862 target"), and the
 * repository owner asked for it to go, with a warning at the top of the
 * dashboard in its place when the plan is not enough.
 *
 * Plain JavaScript, no JSX, so the tests can import it. */
import { fmt } from "./format.mjs";

const n = (v) => fmt(Math.round(v));
const num = (v) => typeof v === "number" && Number.isFinite(v);

/* The warning, or null: {text, detail, tip}. `p` is the plan as the page counts it (a timed launch before its
 * window in signups or in signup conversions, web/src/conversions.mjs). No warning on a launch its results have
 * carried to the target all the same: the page already says it reaches it, and a warning beside that is the
 * two readings pointing opposite ways again. */
export function planWarning(p) {
  if (!p || p.against !== "short") return null;
  if (num(p.lands) && num(p.target) && Math.round(p.lands) >= Math.round(p.target)) return null;
  const ranged = Array.isArray(p.range) && num(p.range[0]) && num(p.range[1]);
  const lo = ranged ? Math.round(p.range[0]) : null, hi = ranged ? Math.round(p.range[1]) : null;
  const unit = p.of === "conversions" ? " conversions" : p.of === "signups" ? " signups" : "";
  // what the plan should bring, and no count of what that leaves: "short" and its figure are the headline's,
  // which counts from where the launch is heading and so rarely gives the same number
  const detail = ranged ? `Going by similar launches, it should bring ${lo === hi ? `about ${n(lo)}` : `${n(lo)} to ${n(hi)}`}${unit}.` : "";
  const similar = [...new Set((p.similar || []).map((x) => String((x && x.name) || "").split(" · ")[0]).filter(Boolean))];
  return { text: `The comms plan is too small for the ${n(p.target)} target`, detail, tip: similar.length ? `The similar launches: ${similar.join(", ")}` : undefined };
}

/* The artist's own earlier launches, as a plain line on the plan card: what each sold of its edition and how
 * many times over it was entered for. It moves no figure: the target carries the judgement of how much the work
 * is wanted, and this is what that judgement can be checked against. Headed as the artist's, so it is not read
 * as the similar launches. Nothing on a plan sized the older way, which is sized on these launches itself. */
export function ownRecord(p) {
  if (!p || !p.against) return null;
  const title = (name) => { const b = String(name || "").split(" · "); return b.length > 2 ? `${b[1]} (${b[b.length - 1]})` : name; };
  const own = (p.ownRecord || []).filter((r) => r && r.edition > 0 && r.sold !== null && r.sold !== undefined);
  if (!own.length) return null;
  return "The artist's earlier launches: " + own.map((r) => `${title(r.name)} sold ${n(r.sold)} of ${n(r.edition)}${r.cover ? `, entries ${r.cover.toFixed(1)} times the edition` : ""}`).join("; ") + ".";
}
