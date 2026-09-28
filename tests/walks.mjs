/* The walks that step from a level to the outcome the hero prints: the
 * outcome waterfall's Channels view (web/src/figures.mjs channelWalk) and the
 * Funnel by channel walk (FunnelByChannel.jsx buildWaterfall, bundled here
 * from the card itself). A walk is capped, with a Beyond sellout step or the
 * funnel's "the sellout caps the actual", only where the snapshot says the
 * release is over its edition - never because rounding left something over -
 * and otherwise it lands exactly on the outcome. Every snapshot on file, both
 * ways Direct can be read, both horizons. */
import assert from "node:assert";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { walkCap, closeWalk, channelWalk } from "../web/src/figures.mjs";

/* ---- closing a walk ---- */
// rounding left over goes to the largest step, so the steps add up
assert.deepStrictEqual(closeWalk([-56.7, 18.2, 84.3, 12.6, 57.1], 476, 591, 0, { whole: true }), [-57, 18, 84, 13, 57]);
assert.deepStrictEqual(closeWalk([82.3, -5.2, 26.1, 4.9, 38.2, -63.7], 217, 300, 0, { whole: true }).reduce((a, b) => a + b, 0), 83);
// a real cap: the steps add up to the outcome plus the demand past the edition
{
  const v = closeWalk([12.4, 1.1, 3.2, 18.3, -15.5], 132, 150, 1, { whole: true });
  assert.strictEqual(132 + v.reduce((a, b) => a + b, 0) - 1, 150);
}
// unrounded, the walk closes to the float
{
  const v = closeWalk([-96.5, 10.2, 0.3], 714, 1090 - 450, 0);
  assert.ok(Math.abs(714 + v.reduce((a, b) => a + b, 0) - 640) < 1e-9);
}
// the cap is the snapshot's: the drivers' step for the horizon, else the hero's
assert.strictEqual(walkCap({ waterfall: { steps: [{ key: "oversubscribed", value: -3 }] } }, true), 3);
assert.strictEqual(walkCap({ waterfall: { steps: [{ key: "paid_spend", value: -3 }] } }, true), 0);
assert.strictEqual(walkCap({ benchmark: {}, waterfall: { today: { benchmark: 5, stepsBm: [{ key: "oversubscribed", value: -2 }], steps: [] } } }, false), 2);
assert.strictEqual(walkCap({ hero: { oversubscribedUnits: 4, now: 100 }, edition: { total: 100 } }, false), 4);
assert.strictEqual(walkCap({ hero: { oversubscribedUnits: 4, now: 90 }, edition: { total: 100 } }, false), 0, "under its edition today: not capped today");

const root = new URL("../data/app/", import.meta.url);
// the committed pages, and the built ones where a refresh has left them (not committed)
const files = [
  ...readdirSync(new URL("releases/", root)).filter((f) => f.endsWith(".json")).map((f) => new URL(`releases/${f}`, root)),
  ...(existsSync(new URL("derived/", root)) ? readdirSync(new URL("derived/", root)).filter((f) => f.endsWith(".json")).map((f) => new URL(`derived/${f}`, root)) : []),
];
const views = [];
for (const f of files) {
  const raw = JSON.parse(readFileSync(f, "utf8"));
  views.push({ name: `${raw.id}`, s: raw });
  if (raw.variants && raw.variants.direct_spread) views.push({ name: `${raw.id} (Direct spread)`, s: { ...raw, ...raw.variants.direct_spread } });
}
assert.ok(views.length >= 10, "the snapshots on file");

/* ---- the outcome waterfall, Channels view ---- */
let walks = 0, capped = 0;
for (const { name, s } of views) {
  if (!s.waterfall) continue;
  for (const today of [true, false]) {
    const w = channelWalk(s, { today });
    if (!w) continue;
    walks++;
    const where = `${name} ${today ? "today" : "close"}`;
    const isToday = today && !!s.waterfall.today;
    const view = isToday ? s.waterfall.today : s.waterfall;
    const drivers = (w.hasBm ? view.stepsBm : view.steps) || [];
    const over = drivers.find((x) => x.key === "oversubscribed");
    // Beyond sellout only where the drivers carry it, and the same size
    assert.strictEqual(w.beyond, over ? over.value : 0, `${where}: Beyond sellout ${w.beyond}, the drivers' ${over ? over.value : "none"}`);
    if ((s.hero || {}).oversubscribedUnits === 0) assert.strictEqual(w.beyond, 0, `${where}: a release not over its edition has no Beyond sellout`);
    if (w.beyond) capped++;
    // whole units, and the printed steps add up to the printed outcome
    for (const st of w.steps) assert.ok(Number.isInteger(st.value), `${where}: ${st.key} is a whole unit (${st.value})`);
    assert.strictEqual(w.start + w.steps.reduce((a, x) => a + x.value, 0) + w.beyond, w.outcome, `${where}: the steps add up to the outcome`);
    assert.strictEqual(w.end + w.beyond, w.outcome, `${where}: the walk ends on the outcome`);
    // each step is its channel's own gap, give or take the rounding it carries
    // (under a unit each, and the walk's own leftover on the largest)
    for (const st of w.steps) assert.ok(Math.abs(st.value - (st.a - st.e)) < 2, `${where}: ${st.key} ${st.value} against ${st.a - st.e}`);
  }
}
assert.ok(walks >= 30, `channel walks: ${walks}`);
// Glenn Ligon is really over its edition, by one, and says so whichever way Direct reads
for (const { name, s } of views.filter((v) => /^glennligon_le_26/.test(v.name))) {
  for (const today of [true, false]) assert.strictEqual(channelWalk(s, { today }).beyond, -1, `${name}: Beyond sellout -1`);
}

/* ---- the Funnel by channel walk, off the card's own code ---- */
let esbuild = null;
try { esbuild = await import("esbuild"); } catch { esbuild = null; }
if (!esbuild) {
  console.log("walks: the Funnel by channel walk skipped (esbuild is not installed: npm install)");
} else {
  const out = join(tmpdir(), `fbc-walk-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL("../web/src/modules/FunnelByChannel.jsx", import.meta.url))],
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  let fbc;
  try { fbc = await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
  let funnels = 0;
  for (const { name, s } of views) {
    if (s.targeted === false) continue;
    const wf = fbc.buildWaterfall(s, fbc.rungModel(s).groups);
    if (!wf) continue;
    funnels++;
    const over = walkCap(s, false);
    const steps = wf.flat.filter((r) => r.to !== undefined);
    const end = steps.length ? steps[steps.length - 1].to : null;
    assert.strictEqual(wf.capped, over > 0, `${name}: capped ${wf.capped} where the snapshot's cap today is ${over}`);
    // the walk lands on the actual, or, over the edition, on the demand past it
    assert.ok(Math.abs(end - (wf.nowTotal + over)) < 1e-6, `${name}: the walk ends at ${end}, the actual ${wf.nowTotal} plus ${over}`);
  }
  assert.ok(funnels >= 9, `funnel walks: ${funnels}`);
}

console.log(`walks: ${walks} channel walks (${capped} capped) and the funnel walks ok`);
