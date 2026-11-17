/* The line a line chart draws through its points (charts.jsx). It curves
 * through each point where it used to turn a corner at it (17 November
 * 2026: the owner asked for the lines on the line graphs to be a bit more
 * curved), and the curve is the cautious kind: it still passes through
 * every point, where the hover dot sits, and between two points it never
 * leaves the heights they span, so a level run stays level, a running total
 * never dips and nothing rises past a value the data never reached. A
 * stretch with no bend in it is the straight line it always was. The Spend
 * levels card draws its band's edges with it and places its marks on it.
 * Plain JavaScript, no JSX: tests/chart_line.mjs. */

/* The slope of the line at each of its points [[x, y]]: Steffen's monotone
 * curve (the one d3 calls monotoneX). Where the line turns back on itself,
 * or runs level on either side, the slope is nothing; points in a row keep
 * the straight line's. */
function slopes(r) {
  const n = r.length, s = [], m = [];
  for (let i = 1; i < n; i++) s.push((r[i][1] - r[i - 1][1]) / (r[i][0] - r[i - 1][0]));
  for (let i = 1; i < n - 1; i++) {
    const a = s[i - 1], b = s[i], h0 = r[i][0] - r[i - 1][0], h1 = r[i + 1][0] - r[i][0];
    m[i] = (Math.sign(a) + Math.sign(b)) * Math.min(Math.abs(a), Math.abs(b), Math.abs((a * h1 + b * h0) / (h0 + h1)) / 2);
  }
  m[0] = n > 2 ? (3 * s[0] - m[1]) / 2 : s[0];
  m[n - 1] = n > 2 ? (3 * s[n - 2] - m[n - 2]) / 2 : s[0];
  return m;
}

const px = (v) => v.toFixed(1);

/* The path through pts [[x, y]], a null leaving a gap. */
export function line(pts) {
  let d = "", run = [];
  const draw = () => {
    const m = run.length > 1 ? slopes(run) : [];
    run.forEach((p, i) => {
      const q = run[i - 1];
      if (!q) { d += `M${px(p[0])} ${px(p[1])}`; return; }
      const dx = (p[0] - q[0]) / 3, s = (p[1] - q[1]) / (p[0] - q[0]);
      d += m[i - 1] === s && m[i] === s ? `L${px(p[0])} ${px(p[1])}`
        : `C${px(q[0] + dx)} ${px(q[1] + dx * m[i - 1])} ${px(p[0] - dx)} ${px(p[1] - dx * m[i])} ${px(p[0])} ${px(p[1])}`;
    });
    run = [];
  };
  pts.forEach((p) => { if (p == null) draw(); else run.push(p); });
  draw();
  return d;
}

/* The height of that line between two of its points: i a place along vals,
 * the whole numbers the points themselves. For a mark that sits on the line
 * where no point is (the Spend levels card's dots and ring). */
export function lineAt(vals, i) {
  const k = Math.max(0, Math.min(Math.floor(i), vals.length - 2)), t = i - k;
  const m = slopes(vals.map((v, j) => [j, v])), a = vals[k], g = vals[k + 1] - a;
  return a + t * (m[k] + t * (3 * g - 2 * m[k] - m[k + 1] + t * (m[k] + m[k + 1] - 2 * g)));
}
