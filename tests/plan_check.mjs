/* The plan check on the page (web/src/planCheck.mjs): a warning at the top of
 * a launch's page when its comms plan is too small for its target, and
 * nothing when the plan is enough or the launch is heading for its target
 * all the same; and the artist's own record as a plain line on the plan
 * card. The cases are the plan cards as they stood on 26 November 2026, when
 * the check was still a line under the card's headline and read "in line with
 * the target" beneath a headline far short of it on four launches, and "33
 * short of the target" beneath one that reached it on a fifth.
 * node tests/plan_check.mjs */
import assert from "node:assert";
import { planWarning, ownRecord } from "../web/src/planCheck.mjs";

// ---- a plan that is enough says nothing, however the launch is running: far behind it, ahead of it, or as planned
const abramovic = { state: "live", against: "in line", target: 861.8, range: [858.6, 928.1], lands: 218.3, notCovered: 0, of: "conversions",
  similar: [{ name: "Bisa Butler · Multiple · 2026 Q4" }, { name: "Marina Abramović · Maria/Marina · 2026 Q1" }] };
assert.strictEqual(planWarning(abramovic), null);
assert.strictEqual(planWarning({ state: "live", against: "in line", target: 200, range: [172.3, 232.2], lands: 250.46 }), null);
assert.strictEqual(planWarning({ state: "live", against: "in line", target: 100, range: [95.7, 160.7], lands: 112.59 }), null);
// ... and so does one bigger than its target needs, and a plan sized the older way, which has no check
assert.strictEqual(planWarning({ state: "start", against: "over", target: 100, range: [140.2, 199.6], lands: 140.2 }), null);
assert.strictEqual(planWarning({ state: "live", target: 100, lands: 80 }), null);
assert.strictEqual(planWarning(null), null);

// ---- a plan too small, before its results: the warning, with what the plan should bring and the launches behind it
const pejac = { state: "start", against: "short", target: 170, expected: 136.76, range: [83.7, 136.8], lands: 136.76, notCovered: 33.24,
  similar: [{ name: "Ai Weiwei · Multiple · 2025 Q4" }, { name: "Glenn Ligon · Multiple · 2026 Q3" }, { name: "Ai Weiwei · Arm · Multiple · 2026 Q2" }] };
assert.deepStrictEqual(planWarning(pejac), { text: "The comms plan is too small for the 170 target", detail: "Going by similar launches, it should bring 84 to 137.",
  tip: "The similar launches: Ai Weiwei, Glenn Ligon" });
// live and still heading under the target: the same warning
assert.strictEqual(planWarning({ ...pejac, state: "live", lands: 120 }).text, "The comms plan is too small for the 170 target");
assert.ok(planWarning({ ...pejac, state: "live", lands: 169.4 }));
// ... which leaves the count of what the launch is short by to the headline: the two rarely give the same figure
assert.ok(!/short/.test(planWarning(pejac).text + planWarning(pejac).detail));

// ---- the same plan on a launch its results have carried to the target (Pejac's own page that day: heading for
// 176 against 170): no warning beside a headline that says it reaches the target
assert.strictEqual(planWarning({ ...pejac, state: "live", lands: 175.77 }), null);
assert.strictEqual(planWarning({ ...pejac, state: "live", lands: 169.6 }), null);   // 170 as the headline prints it

// ---- a timed launch before its window, in signups or in signup conversions: the unit is named
const tl = { state: "live", against: "short", target: 785, range: [556.7, 606.2], lands: 300, notCovered: 185, of: "conversions" };
assert.strictEqual(planWarning(tl).detail, "Going by similar launches, it should bring 557 to 606 conversions.");
assert.strictEqual(planWarning({ ...tl, target: 9700, range: [9000.2, 9500], lands: 4000, of: "signups" }).detail, "Going by similar launches, it should bring 9,000 to 9,500 signups.");
// a range of one figure is not printed as a span, and one with no range says only its verdict
assert.strictEqual(planWarning({ ...pejac, range: [136.6, 137.2] }).detail, "Going by similar launches, it should bring about 137.");
assert.deepStrictEqual(planWarning({ state: "live", against: "short", target: 170, lands: 120 }), { text: "The comms plan is too small for the 170 target", detail: "", tip: undefined });

// ---- the artist's own record, headed as the artist's so it is not read as the similar launches
const miller = { state: "live", against: "in line", target: 100, range: [94.1, 149.1], lands: 39.69, notCovered: 0,
  ownRecord: [{ name: "Harland Miller · York So Good They Named It Once · 2025 Q2", edition: 50, sold: 50, cover: 1.02 }, { name: "Harland Miller · Multiple · 2025 Q3", edition: 125, sold: 118, cover: 1.61 },
    { name: "Harland Miller · Unsold · 2025 Q4", edition: 0, sold: 4 }] };
assert.strictEqual(ownRecord(miller),
  "The artist's earlier launches: York So Good They Named It Once (2025 Q2) sold 50 of 50, entries 1.0 times the edition; Multiple (2025 Q3) sold 118 of 125, entries 1.6 times the edition.");
// none on file, a timed launch (which carries none), a plan sized the older way: no line
assert.strictEqual(ownRecord({ ...miller, ownRecord: [] }), null);
assert.strictEqual(ownRecord(abramovic), null);
assert.strictEqual(ownRecord({ ...miller, against: null }), null);
assert.strictEqual(ownRecord(null), null);

console.log("plan_check: ok");
