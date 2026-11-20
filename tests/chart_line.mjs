/* The line a line chart draws through its points (web/src/chartLine.mjs): it
 * bends at each point, the corner it used to turn there softened by BEND,
 * passes through every one, never leaves the heights two neighbours span (a
 * running total never dips, a level run stays level), keeps a straight
 * stretch the straight line it always was, leaves a gap at a null, and
 * lineAt reads the height of the same line between two points.
 *   node tests/chart_line.mjs */
import assert from "node:assert";
import { line, lineAt, BEND } from "../web/src/chartLine.mjs";

/* a path back as its pieces, each with the point it starts from:
 * [{ c: "M" | "L" | "C", from: [x, y], n: [numbers] }] */
function parse(d) {
  const out = [];
  let at = null;
  for (const m of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = m[2].trim().split(/\s+/).map(Number);
    out.push({ c: m[1], from: at, n });
    at = n.slice(-2);
  }
  return out;
}
/* the four points of a piece as a cubic (a straight piece's handles sit on it) and the point at t along it */
const cubic = (s) => (s.c === "C" ? [s.from, s.n.slice(0, 2), s.n.slice(2, 4), s.n.slice(4)]
  : [s.from, [0, 1].map((k) => s.from[k] + (s.n[k] - s.from[k]) / 3), [0, 1].map((k) => s.n[k] - (s.n[k] - s.from[k]) / 3), s.n]);
const at = (b, t) => [0, 1].map((k) => (1 - t) ** 3 * b[0][k] + 3 * (1 - t) ** 2 * t * b[1][k] + 3 * (1 - t) * t ** 2 * b[2][k] + t ** 3 * b[3][k]);
const TS = Array.from({ length: 21 }, (_, i) => i / 20);
// the path is written to a tenth of a pixel, so a pixel reading is good to about that
const NEAR = 0.15;

assert.ok(BEND > 0 && BEND <= 1, `the line bends, and no further than the full curve: ${BEND}`);
const slope = (a, b) => (b[1] - a[1]) / (b[0] - a[0]);

// ---- a straight stretch is the line it always was
assert.strictEqual(line([[0, 0], [10, 5]]), "M0.0 0.0L10.0 5.0", "two points: a straight line");
assert.strictEqual(line([[0, 40], [10, 40], [20, 40], [30, 40]]), "M0.0 40.0L10.0 40.0L20.0 40.0L30.0 40.0", "a level run (a target across the chart)");
assert.strictEqual(line([[0, 0], [10, 10], [20, 20]]), "M0.0 0.0L10.0 10.0L20.0 20.0", "points in a row");

// ---- a null leaves a gap, and a point alone draws nothing
assert.strictEqual(line([null, [0, 0], [10, 5], null, [30, 7], null]), "M0.0 0.0L10.0 5.0M30.0 7.0");
assert.strictEqual(line([]), "");
assert.strictEqual(line([null, null]), "");

/* what holds for any run drawn across a plot: x a step apart, y falling as the value rises */
const X = (i) => 40 + i * 39.9, Y = (v) => 234 - v * 3.7;
function holds(vals, name) {
  const pts = vals.map((v, i) => [X(i), Y(v)]);
  const segs = parse(line(pts));
  assert.strictEqual(segs.length, pts.length, `${name}: a piece per point`);
  segs.forEach((s, i) => {
    // through every point
    const end = s.n.slice(-2);
    assert.ok(Math.abs(end[0] - pts[i][0]) <= 0.05 + 1e-9 && Math.abs(end[1] - pts[i][1]) <= 0.05 + 1e-9, `${name}: the line passes through point ${i}`);
    if (!i) { assert.strictEqual(s.c, "M"); return; }
    // between two points it stays within their heights, and never doubles back
    const b = cubic(s), lo = Math.min(pts[i - 1][1], pts[i][1]) - NEAR, hi = Math.max(pts[i - 1][1], pts[i][1]) + NEAR;
    let lastX = -Infinity;
    for (const t of TS) {
      const [x, y] = at(b, t);
      assert.ok(y >= lo && y <= hi, `${name}: between points ${i - 1} and ${i} the line stays within their heights (${y.toFixed(2)} outside ${lo.toFixed(2)}..${hi.toFixed(2)})`);
      assert.ok(x >= lastX - 1e-9, `${name}: the line never doubles back`);
      lastX = x;
    }
    // a level stretch is drawn level
    if (vals[i] === vals[i - 1]) assert.strictEqual(s.c, "L", `${name}: the level stretch into point ${i} stays level`);
    // the corner at a point inside the run is softened: of the turn the straight lines made there, 1 - BEND is left
    if (i < segs.length - 1) {
      const next = cubic(segs[i + 1]);
      const arrive = slope(b[2], b[3]), leave = slope(next[0], next[1]);
      const corner = slope(pts[i], pts[i + 1]) - slope(pts[i - 1], pts[i]);
      assert.ok(Math.abs(leave - arrive - (1 - BEND) * corner) <= 0.02 * (1 + Math.abs(arrive) + Math.abs(leave)),
        `${name}: the corner at point ${i} is softened by ${BEND} (a turn of ${(leave - arrive).toFixed(3)} against the straight lines' ${corner.toFixed(3)})`);
    }
  });
  // lineAt reads the same line: a mark placed with it sits on the line as drawn
  for (let k = 0; k < vals.length - 1; k++) {
    const b = cubic(segs[k + 1]);
    for (const t of [0.2, 0.5, 0.8]) {
      const drawn = at(b, t)[1], read = Y(lineAt(vals, k + t));
      assert.ok(Math.abs(drawn - read) <= NEAR, `${name}: lineAt at ${k + t} is on the line (${read.toFixed(2)} against ${drawn.toFixed(2)})`);
    }
    assert.strictEqual(lineAt(vals, k), vals[k], `${name}: lineAt at a point is the point`);
  }
  assert.ok(Math.abs(lineAt(vals, vals.length - 1) - vals[vals.length - 1]) < 1e-9, `${name}: lineAt at the last point is the point`);
  // drawn backwards (the far edge of a band) it is the same line
  const back = parse(line(pts.slice().reverse()));
  for (let k = 1; k < segs.length; k++) {
    const f = cubic(segs[k]), r = cubic(back[segs.length - k]);
    for (const t of [0.25, 0.5, 0.75]) {
      const a = at(f, t), c = at(r, 1 - t);
      assert.ok(Math.abs(a[0] - c[0]) <= NEAR && Math.abs(a[1] - c[1]) <= NEAR, `${name}: drawn backwards the curve is the same between points ${k - 1} and ${k}`);
    }
  }
  return segs;
}

// ---- a running total in steps (a launch's secured units by day): never a dip, the level days level
const total = [15, 20.4, 20.4, 29, 30, 30.2, 35.7, 38.6, 40.7, 40.8, 40.8, 42, 42, 42, 43];
const drawn = holds(total, "a running total");
assert.ok(drawn.some((s) => s.c === "C"), "the days that rise are bent");
for (let i = 0; i <= (total.length - 1) * 20; i++) {
  assert.ok(lineAt(total, (i + 1) / 20) >= lineAt(total, i / 20) - 1e-9 || i === (total.length - 1) * 20, "a running total never dips between its days");
}

// ---- a rate that rises and falls (the paid ROI by day): no further up or down than the days themselves
holds([23.7, 18.9, 16.1, 11.8, 10.2, 12.4, 9.1, 9.1, 13.3, 4.5], "a rate that rises and falls");
// ---- a curve that peaks and goes under zero (the profit to come at each daily spend)
holds([0, 16000, 24000, 30000, 34000, 36500, 37000, 36000, 31000, 20000, 2000, -9000], "a curve that peaks");
// ---- a jump on the last day, and a single step
holds([2, 2.5, 3, 3.2, 3.3, 40], "a jump on the last day");
holds([0, 0, 0, 10, 10, 10], "a single step");

// ---- between points in a row lineAt is the straight line
assert.ok(Math.abs(lineAt([0, 10, 20], 0.5) - 5) < 1e-9 && Math.abs(lineAt([0, 10, 20], 1.25) - 12.5) < 1e-9);
assert.strictEqual(lineAt([3, 7], 0.5), 5, "two points: half way between them");
console.log("chart line: ok");
