/* Labels that must not collide: the pixel arithmetic the charts share. Plain
 * JavaScript with no JSX, so the tests can import it; ui.jsx re-exports it.
 *
 * Whether two labels collide is a pixel question, never a fraction one: two
 * labels 20% apart are comfortable on a wide card and on top of each other
 * on a narrow one. So a chart measures its plot and measures its words in the
 * page's own font, then either lets the less important label give way or sets
 * a label in clear space with a thin leader to what it names (nameLines, the
 * placer the unit trajectory grew, now shared). */

/* Roughly how wide a 12px label renders: the stand-in where there is no
 * canvas to measure with. Erring high only buys a little more clearance. */
export const labelPx = (text) => String(text).length * 6.7;

/* A label's width as the page draws it: measured in the page's own font at
 * the size and weight given, the estimate where there is no canvas (a test
 * run). A width taken before the webfont has landed is the fallback face's,
 * which is why the cards that measure re-render once the fonts are in
 * (useBoxSize in ui.jsx). */
let ctx2d = null, family = null;
export function textPx(text, size = 12, weight = 400) {
  const s = String(text ?? "");
  try {
    if (!ctx2d) ctx2d = document.createElement("canvas").getContext("2d");
    if (!family) family = getComputedStyle(document.body).fontFamily || "sans-serif";
    ctx2d.font = `${weight} ${size}px ${family}`;
    const w = ctx2d.measureText(s).width;
    if (w > 0 || !s) return w;
  } catch { /* no canvas */ }
  return (labelPx(s) * size) / 12;
}

/* A time axis: the window's first day at the left end, its last at the
 * right, and "today" under the today line. On a live release "today" always
 * shows - it is the reading that matters, and the line it names is otherwise
 * just a line - centred on its line and kept inside the row; an end label that
 * would print into it gives way, since the axis already ends there. All in
 * pixels: rowW is the plot's measured width, and before the first measurement
 * lands the ends give way inside a fraction of the row instead. Returns the
 * left edge of "today" in px (null when not live or not measured) and which
 * end labels show. */
export function timeAxis({ rowW, frac, live = true, startText = "", endText = "", gap = 8, size = 12 }) {
  if (!live) return { todayLeft: null, start: true, end: true };
  const f = Math.max(0, Math.min(1, frac || 0));
  if (!(rowW > 0)) return { todayLeft: null, start: f >= 0.08, end: f <= 0.82 };
  const tw = textPx("today", size);
  const left = Math.max(0, Math.min(f * rowW - tw / 2, rowW - tw));
  return {
    todayLeft: left,
    start: textPx(startText, size) + gap <= left,
    end: left + tw + gap <= rowW - textPx(endText, size),
  };
}

/* ---- naming the lines --------------------------------------------------------
 * A name is a word in clear space with a leader to a point on its line. It
 * may sit anywhere no curve, no dot, no figure and no other name runs
 * through, its leader may cross no name, no dot and no other leader, and
 * among those places it takes the one with the shortest leader, the fewest
 * curves under the leader, and an anchor near the middle of its line, spread
 * from the other names' anchors. The names are set one after another, each
 * treating the ones already set as walls, so two never overlap. Only when a
 * name has nowhere that clear does it settle for a place across a curve or a
 * leader, and only when it has nowhere at all does it go on a card-white
 * patch where it runs into the least. Another name is the one wall that
 * holds in every tier, so two names never overlap. All of
 * it is in real pixels off the measured plot, with the text measured in the
 * page's own font, so it holds whatever width the card is given.
 *   labels  [{ key, text, w, h, anchors: [{ x, y, cost }], ... }] in the
 *           order they choose, the one that matters most first
 *   curves  [{ pts: [{ x, y }] }] the lines drawn (a name avoids them)
 *   blocks  [{ x0, y0, x1, y1 }] the marks a name never sits on: dots,
 *           figures, bars
 *   bounds  the box the names stay inside
 * Each placed name comes back with its box (x0, y0), its leader (start ->
 * anchor) and `knock` when it had to go on a white patch. */
function segHitsBox(x0, y0, x1, y1, b) {
  // Liang-Barsky: does the segment cross the box, edges included
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 - b.x0) && clip(dx, b.x1 - x0) && clip(-dy, y0 - b.y0) && clip(dy, b.y1 - y0);
}
const boxesTouch = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
// do two segments cross (touching counts)
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const on = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
// where a leader leaves its name: the point where the line from the box's
// centre to the anchor crosses the box's edge, a step clear of the text
function leaderStart(box, anchor) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const dx = anchor.x - cx, dy = anchor.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx !== 0 ? ((dx > 0 ? box.x1 : box.x0) - cx) / dx : Infinity;
  const ty = dy !== 0 ? ((dy > 0 ? box.y1 : box.y0) - cy) / dy : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t + (dx / len) * 3, y: cy + dy * t + (dy / len) * 3 };
}
// the eight ways a name can sit off its anchor, at four distances
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
  .map(([dx, dy]) => { const n = Math.hypot(dx, dy); return [dx / n, dy / n]; });
const DISTS = [18, 30, 44, 60];
export function nameLines({ labels, curves, blocks, bounds }) {
  const names = [];                      // each name's box as it is set: nothing may ever touch these
  const leaders = [];                    // each leader as it is set
  const anchorsSet = [];
  const segs = curves.flatMap((c) => c.pts.slice(1).map((p, i) => ({ a: c.pts[i], b: p })));
  const near = (s, pt) => Math.hypot(s.a.x - pt.x, s.a.y - pt.y) < 7 || Math.hypot(s.b.x - pt.x, s.b.y - pt.y) < 7;
  const inside = (pt, b) => pt.x >= b.x0 && pt.x <= b.x1 && pt.y >= b.y0 && pt.y <= b.y1;
  const out = [];
  for (const lb of labels) {
    const candidates = [];
    for (const anchor of lb.anchors) {
      // the leader may run into the mark it points at (the today dot), not into any other
      const marks = blocks.filter((b) => !inside(anchor, b));
      for (const [ux, uy] of DIRS) for (const d of DISTS) {
        const ax = anchor.x + ux * d, ay = anchor.y + uy * d;
        const x0 = ux < 0 ? ax - lb.w : ux > 0 ? ax : ax - lb.w / 2;
        const y0 = uy < 0 ? ay - lb.h : uy > 0 ? ay : ay - lb.h / 2;
        const box = { x0, y0, x1: x0 + lb.w, y1: y0 + lb.h };
        const pad = { x0: x0 - 2, y0: y0 - 2, x1: box.x1 + 2, y1: box.y1 + 2 };
        if (pad.x0 < bounds.x0 || pad.x1 > bounds.x1 || pad.y0 < bounds.y0 || pad.y1 > bounds.y1) continue;
        const start = leaderStart(box, anchor);
        const onName = names.some((n) => boxesTouch(pad, n) || segHitsBox(start.x, start.y, anchor.x, anchor.y, n));
        if (onName) continue;            // never on another name, never a leader through one
        const onMark = blocks.filter((b) => boxesTouch(pad, b)).length + marks.filter((b) => segHitsBox(start.x, start.y, anchor.x, anchor.y, b)).length;
        const onLeader = leaders.filter((l) => segHitsBox(l.a.x, l.a.y, l.b.x, l.b.y, pad) || segsCross(start, anchor, l.a, l.b)).length;
        const underBox = segs.filter((s) => segHitsBox(s.a.x, s.a.y, s.b.x, s.b.y, pad)).length;
        const underLeader = segs.filter((s) => !near(s, anchor) && segsCross(start, anchor, s.a, s.b)).length;
        const len = Math.hypot(start.x - anchor.x, start.y - anchor.y);
        const crowd = anchorsSet.filter((p) => Math.abs(p.x - anchor.x) < 48).length;
        candidates.push({
          box, start, anchor, underBox,
          cost: underBox * 10 + underLeader * 3 + len * 0.04 + (anchor.cost || 0) + crowd * 4,
          // the tiers, worst first: on a dot or the figure; across a leader or under a curve; clear
          hard: onMark, soft: onLeader + underBox,
        });
      }
    }
    if (!candidates.length) continue;
    const pick = (list) => list.reduce((best, c) => (c.cost < best.cost ? c : best));
    const clear = candidates.filter((c) => c.hard === 0 && c.soft === 0);
    const clearish = candidates.filter((c) => c.hard === 0);
    const best = clear.length ? pick(clear) : clearish.length ? pick(clearish)
      : pick(candidates.map((c) => ({ ...c, cost: c.cost + c.hard * 100 })));
    const knock = best.hard > 0 || best.underBox > 0;
    names.push({ x0: best.box.x0 - 2, y0: best.box.y0 - 2, x1: best.box.x1 + 2, y1: best.box.y1 + 2 });
    leaders.push({ a: best.start, b: best.anchor });
    anchorsSet.push(best.anchor);
    out.push({ ...lb, x0: best.box.x0, y0: best.box.y0, start: best.start, anchor: best.anchor, knock });
  }
  return out;
}
