/* The plan check's words (web/src/planCheck.mjs): the verdict, what the plan
 * should bring going by similar launches, and, once a launch is live and
 * heading outside that, where it is heading and why, so the line never sits
 * against the headline above it. The cases are the plan cards as they stood
 * on 26 November 2026, when the line read "in line with the target" under a
 * headline far short of it on four launches, and "short of the target" under
 * one that reached it on a fifth.
 * node tests/plan_check.mjs */
import assert from "node:assert";
import { planCheck } from "../web/src/planCheck.mjs";

const line = (p) => { const c = planCheck(p); return c.lead + c.span + c.now; };

// ---- a timed launch before its window, in signup conversions: a plan about right, a launch far behind it
const abramovic = { state: "live", against: "in line", target: 861.8, range: [858.6, 928.1], lands: 218.3, notCovered: 0, of: "conversions",
  similar: [{ name: "Bisa Butler · Multiple · 2026 Q4" }, { name: "Marina Abramović · Maria/Marina · 2026 Q1" }] };
assert.strictEqual(line(abramovic), "The plan is about right for the 862 target. Going by similar launches, it should bring 859 to 928 conversions. "
  + "The launch is heading for 218 because it is running behind the plan, and the bars below show where.");
assert.strictEqual(planCheck(abramovic).kind, "in line");
assert.deepStrictEqual(planCheck(abramovic).similar, ["Bisa Butler", "Marina Abramović"]);
// ... and the same page in signups
assert.strictEqual(line({ ...abramovic, target: 9560, range: [8864.3, 9582.3], lands: 1574.4, of: "signups" }),
  "The plan is about right for the 9,560 target. Going by similar launches, it should bring 8,864 to 9,582 signups. "
  + "The launch is heading for 1,574 because it is running behind the plan, and the bars below show where.");

// ---- a draw launch whose plan is too small and whose results are ahead of it: the part left over is named as
// its row in the bars is, and the headline's "reaches the target" is accounted for
const pejac = { state: "live", against: "short", target: 170, expected: 136.76, range: [83.7, 136.8], lands: 175.77, notCovered: 33.24 };
assert.strictEqual(line(pejac), "The plan is too small for the 170 target. Going by similar launches, it should bring 84 to 137, which leaves 33 not covered. "
  + "The launch is heading for 176 because it is running ahead of the plan, and the bars below show where.");
assert.strictEqual(planCheck(pejac).kind, "short");

// ---- heading inside what the plan should bring: nothing to add, either side of the target
const armstrong = { state: "live", against: "in line", target: 100, range: [95.7, 160.7], lands: 112.59, notCovered: 0 };
assert.strictEqual(line(armstrong), "The plan is about right for the 100 target. Going by similar launches, it should bring 96 to 161.");
assert.strictEqual(planCheck({ ...armstrong, lands: 97 }).now, "");
// the edges of the range are inside it, as the page prints them
assert.strictEqual(planCheck({ ...armstrong, lands: 95.6 }).now, "");
assert.strictEqual(planCheck({ ...armstrong, lands: 161.4 }).now, "");
assert.ok(planCheck({ ...armstrong, lands: 94 }).now.includes("heading for 94 because it is running behind the plan"));

// ---- before anything has gone out the headline is the plan itself, so there is no second reading to square
assert.strictEqual(planCheck({ ...abramovic, state: "start", lands: 925.9 }).now, "");
assert.strictEqual(planCheck({ ...pejac, state: "start", lands: 136.76 }).now, "");

// ---- a plan bigger than its target needs
assert.strictEqual(line({ state: "start", against: "over", target: 100, range: [140.2, 199.6], lands: 140.2, notCovered: 0 }),
  "The plan is bigger than the 100 target needs. Going by similar launches, it should bring 140 to 200.");
// a range of one figure is not printed as a span
assert.ok(line({ state: "start", against: "in line", target: 50, range: [50.2, 50.4], lands: 50 }).includes("it should bring about 50."));

// ---- the line never calls a figure "short" beside the headline's own count of what the launch is short by
for (const p of [abramovic, pejac, armstrong]) assert.ok(!/short/.test(line(p)), line(p));

// ---- the artist's own record beside it, named as the artist's so it is not read as the similar launches
const miller = { state: "live", against: "in line", target: 100, range: [94.1, 149.1], lands: 39.69, notCovered: 0,
  ownRecord: [{ name: "Harland Miller · York So Good They Named It Once · 2025 Q2", edition: 50, sold: 50, cover: 1.02 }, { name: "Harland Miller · Multiple · 2025 Q3", edition: 125, sold: 118, cover: 1.61 },
    { name: "Harland Miller · Unsold · 2025 Q4", edition: 0, sold: 4 }] };
assert.strictEqual(planCheck(miller).record,
  "The artist's earlier launches: York So Good They Named It Once (2025 Q2) sold 50 of 50, entries 1.0 times the edition; Multiple (2025 Q3) sold 118 of 125, entries 1.6 times the edition.");
assert.strictEqual(planCheck(armstrong).record, null);

// ---- a plan sized the older way has no check, and one with no range says only its verdict
assert.strictEqual(planCheck({ state: "live", target: 100, lands: 80 }), null);
assert.strictEqual(planCheck(null), null);
assert.strictEqual(line({ state: "live", against: "in line", target: 100, lands: 80 }), "The plan is about right for the 100 target.");

console.log("plan_check: ok");
