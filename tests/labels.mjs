/* Labels that must not collide (web/src/labels.mjs): the "today" and axis-end
 * rule the time charts share, and the placer that sets a word in clear space
 * with a leader to what it names. In node there is no canvas, so widths are
 * the length estimate; the rules are the same whatever measures the words. */
import assert from "node:assert";
import { timeAxis, nameLines, textPx, placeTip, placeBeside } from "../web/src/labels.mjs";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const TW = textPx("today");

/* ---- timeAxis ------------------------------------------------------------ */
// the reported case: Paid ROI on a live release two days from its close (day
// 25 of 27), a 360px plot, where "today" printed over the close date
{
  const ax = timeAxis({ rowW: 360, frac: 24 / 26, startText: "3 Sep", endText: "30 Sep" });
  ok(!ax.end, "the close date gives way to today near the close");
  ok(ax.start, "the announce date stays when it is clear");
  ok(ax.todayLeft >= 0 && ax.todayLeft + TW <= 360, "today stays inside the plot");
}
// mid-window both ends show, and today sits centred on its line
{
  const ax = timeAxis({ rowW: 600, frac: 0.5, startText: "3 Sep", endText: "30 Sep" });
  ok(ax.start && ax.end, "mid-window both ends show");
  ok(Math.abs(ax.todayLeft + TW / 2 - 300) < 1e-9, "today is centred on its line");
}
// the first day: the announce date gives way, today is kept inside the row
{
  const ax = timeAxis({ rowW: 600, frac: 0, startText: "3 Sep", endText: "30 Sep" });
  ok(!ax.start && ax.end && ax.todayLeft === 0, "day one: today at the start, the announce date gives way");
}
// the close day: today at the end of the row, the close date gives way
{
  const ax = timeAxis({ rowW: 600, frac: 1, startText: "3 Sep", endText: "30 Sep" });
  ok(ax.start && !ax.end && Math.abs(ax.todayLeft - (600 - TW)) < 1e-9, "close day: today at the end, the close date gives way");
}
// a closed release has no today, and both ends show
{
  const ax = timeAxis({ rowW: 600, frac: 0.97, live: false, startText: "3 Sep", endText: "30 Sep" });
  ok(ax.start && ax.end && ax.todayLeft === null, "not live: no today, both ends");
}
// before the plot is measured the ends give way inside a share of the row
{
  const a = timeAxis({ rowW: 0, frac: 0.95, startText: "3 Sep", endText: "30 Sep" });
  const b = timeAxis({ rowW: 0, frac: 0.03, startText: "3 Sep", endText: "30 Sep" });
  ok(a.todayLeft === null && a.start && !a.end && !b.start && b.end, "unmeasured: the fraction fallback");
}
// whatever the width and the day, the labels that show never touch and stay
// inside the row
for (const rowW of [120, 180, 240, 320, 360, 480, 640, 900]) {
  for (let i = 0; i <= 80; i++) {
    const frac = i / 80;
    const startText = "13 Sep", endText = "30 Sep";
    const ax = timeAxis({ rowW, frac, startText, endText, gap: 8 });
    const bs = [
      ...(ax.start ? [[0, textPx(startText)]] : []),
      [ax.todayLeft, ax.todayLeft + TW],
      ...(ax.end ? [[rowW - textPx(endText), rowW]] : []),
    ];
    for (let k = 0; k + 1 < bs.length; k++) ok(bs[k + 1][0] - bs[k][1] >= 8 - 1e-9, `labels touch at ${rowW}px, frac ${frac}`);
    ok(bs[0][0] >= 0 && bs[bs.length - 1][1] <= rowW + 1e-9, `a label leaves the row at ${rowW}px, frac ${frac}`);
  }
}

/* ---- nameLines ------------------------------------------------------------- */
const touch = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function segHits(s, b) {
  // sampled: does the segment pass through the box
  for (let t = 0; t <= 1; t += 1 / 200) {
    const x = s.a.x + (s.b.x - s.a.x) * t, y = s.a.y + (s.b.y - s.a.y) * t;
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return true;
  }
  return false;
}
const boxOf = (nm) => ({ x0: nm.x0, y0: nm.y0, x1: nm.x0 + nm.w, y1: nm.y0 + nm.h });

/* The Paid ROI plot near the close, as reported: spend bars up to the today
   line, the ROI line above them, the today line through the band. "daily
   spend" is set clear of all of it, with its leader on a bar's top. */
function roiPlot(W, Hh, todayX) {
  const bars = [], tops = [];
  for (let x = 6; x + 8 <= todayX; x += 14) {
    const h = 12 + ((x * 7) % 40);
    bars.push({ x0: x, y0: Hh - h, x1: x + 8, y1: Hh });
    tops.push({ x: x + 4, y: Hh - h });
  }
  const line = { pts: [] };
  for (let x = 0; x <= todayX; x += 20) line.pts.push({ x, y: 40 + 20 * Math.sin(x / 40) });
  const today = { pts: [{ x: todayX, y: 0 }, { x: todayX, y: Hh }] };
  return { bars, tops, curves: [line, today] };
}
for (const [W, Hh, todayX] of [[360, 150, 332], [480, 160, 440], [640, 170, 600], [900, 170, 860], [360, 150, 180]]) {
  const { bars, tops, curves } = roiPlot(W, Hh, todayX);
  const mid = (tops[0].x + tops[tops.length - 1].x) / 2;
  const label = { key: "spend", text: "daily spend", w: textPx("daily spend"), h: 14, anchors: tops.map((t) => ({ ...t, cost: Math.abs(t.x - mid) * 0.02 })) };
  const [nm] = nameLines({ labels: [label], curves, blocks: bars, bounds: { x0: 0, y0: 0, x1: W, y1: Hh } });
  ok(nm, `a place is found at ${W}px`);
  const b = boxOf(nm);
  ok(!nm.knock, `clear space is found at ${W}px`);
  ok(bars.every((bar) => !touch(b, bar)), `the name sits on no bar at ${W}px`);
  const segs = curves.flatMap((c) => c.pts.slice(1).map((p, i) => ({ a: c.pts[i], b: p })));
  ok(segs.every((s) => !segHits(s, b)), `no line runs through the name at ${W}px (the today line included)`);
  ok(b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= Hh, `the name stays in the plot at ${W}px`);
  ok(tops.some((t) => t.x === nm.anchor.x && t.y === nm.anchor.y), `the leader ends on a bar's top at ${W}px`);
}

/* Names set one after another never overlap, even where every place is
   crowded and a name has to settle for a white patch. */
{
  const curves = [];
  for (let y = 5; y < 100; y += 9) curves.push({ pts: [{ x: 0, y }, { x: 300, y }] });   // no clear space anywhere
  const labels = ["secured", "projected", "target", "benchmark"].map((t, i) => ({
    key: t, text: t, w: textPx(t), h: 14, anchors: [{ x: 60 + i * 50, y: 50, cost: 0 }, { x: 150, y: 50, cost: 1 }],
  }));
  const names = nameLines({ labels, curves, blocks: [], bounds: { x0: 0, y0: 0, x1: 300, y1: 100 } });
  ok(names.length === 4, "every name is placed");
  ok(names.some((x) => x.knock), "with no clear space a name goes on a white patch");
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) ok(!touch(boxOf(names[i]), boxOf(names[j])), `${names[i].key} and ${names[j].key} overlap`);
  }
}

/* ---- popups are never cut ------------------------------------------------ */
// every placement stays inside the window, margin to spare, over a sweep of
// anchors, popup sizes and window sizes
const inWindow = (p, w, h, vw, vh, m = 8) => p.left >= m - 1e-9 && p.top >= m - 1e-9 && p.left + w <= vw - m + 1e-9 && p.top + h <= vh - m + 1e-9;
for (const [vw, vh] of [[1280, 800], [1440, 900], [900, 600]]) {
  for (const w of [120, 280, 350, 560]) {
    for (const h of [60, 180, 320]) {
      for (let ax = 0; ax <= vw; ax += vw / 16) {
        for (let ay = 0; ay <= vh; ay += vh / 8) {
          const anchor = { left: ax - 20, right: ax + 20, top: ay - 8, bottom: ay + 8 };
          ok(inWindow(placeTip({ anchor, w, h, vw, vh }), w, h, vw, vh), `placeTip ${w}x${h} at ${ax},${ay} in ${vw}x${vh}`);
          const within = { left: Math.max(0, ax - 150), right: Math.min(vw, ax + 130) };
          ok(inWindow(placeBeside({ x: ax, top: ay, w, h, vw, vh, within }), w, h, vw, vh), `placeBeside ${w}x${h} at ${ax},${ay} in ${vw}x${vh}`);
        }
      }
    }
  }
}
// the reported case: the sidebar's popup (about 350px) over a row whose middle
// is 150px from the window's left edge ran 25px off it; now it starts at the margin
{
  const p = placeTip({ anchor: { left: 16, right: 284, top: 400, bottom: 440 }, w: 350, h: 150, vw: 1440, vh: 900 });
  ok(p.left === 8 && p.top === 400 - 10 - 150, `the sidebar popup starts inside the window, above its row: ${JSON.stringify(p)}`);
}
// centred on what it describes and above it, where there is room
{
  const p = placeTip({ anchor: { left: 600, right: 700, top: 400, bottom: 420 }, w: 200, h: 100, vw: 1440, vh: 900 });
  ok(p.left === 550 && p.top === 290, `centred above: ${JSON.stringify(p)}`);
  const q = placeTip({ anchor: { left: 600, right: 700, top: 40, bottom: 60 }, w: 200, h: 100, vw: 1440, vh: 900 });
  ok(q.top === 70, `below where there is no room above: ${JSON.stringify(q)}`);
}
// a chart readout: right of the line inside its card, left where the card
// has no room on the right, and never past the window
{
  const card = { left: 300, right: 580 };
  const r = placeBeside({ x: 350, top: 200, w: 180, h: 120, vw: 1280, vh: 800, within: card });
  ok(r.left === 360, `right of the line inside the card: ${JSON.stringify(r)}`);
  const l = placeBeside({ x: 540, top: 200, w: 180, h: 120, vw: 1280, vh: 800, within: card });
  ok(l.left === 350, `left of the line where the card has no room on the right: ${JSON.stringify(l)}`);
  const edge = placeBeside({ x: 1270, top: 780, w: 180, h: 120, vw: 1280, vh: 800, within: { left: 1000, right: 1280 } });
  ok(edge.left === 1080 && edge.top === 800 - 8 - 120, `at the window's corner it turns left and up: ${JSON.stringify(edge)}`);
}

console.log(`labels: ${n} checks ok`);
