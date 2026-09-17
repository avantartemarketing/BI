/* retargetSnapshot (server/retarget.js) re-runs the per-product sell-through
 * on a save: takes a committed snapshot, gives it a synthetic draw feed, and
 * saves new product editions and a new rate over it. The products, the
 * headline and the rate must follow.  node tests/retarget_products.mjs */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { computeTargets } from "../shared/targetModel.mjs";
import * as sellThrough from "../shared/sellThrough.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const { retargetSnapshot } = require(path.join(ROOT, "server", "retarget.js"));

const inputsDoc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "inputs.json"), "utf8"));
const curves = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "curves.json"), "utf8"));
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "releases", "glennligon_le_26.json"), "utf8"));
const base = inputsDoc.releases.glennligon_le_26;

// a synthetic draw feed on the snapshot: two draws, some flexible entrants
snap.sellthrough = {
  ...snap.sellthrough,
  conversion: 0.8, inHandUnits: 50,
  draws: [
    { id: "g1", first: "2026-08-17", last: "2026-09-10", entrants: 40, eligible: 40, winners: 0, sold: 0, open: 40, wonUnpaid: 0, purchaseUnits: 0 },
    { id: "g2", first: "2026-08-18", last: "2026-09-10", entrants: 25, eligible: 25, winners: 0, sold: 0, open: 25, wonUnpaid: 0, purchaseUnits: 0 },
  ],
  patterns: [
    { open: ["g1"], won: [], sold: [], bought: 0, max: 1, n: 30 },
    { open: ["g2"], won: [], sold: [], bought: 0, max: 1, n: 15 },
    { open: ["g1", "g2"], won: [], sold: [], bought: 0, max: 1, n: 10 },
  ],
};

let failed = 0;
const check = (c, m) => { if (!c) { failed += 1; console.error("FAIL", m); } };

const inputs = {
  ...base, channel_quality_default: inputsDoc.channel_quality_default, stretch_mode: "levers",
  products: [{ key: "g1", name: "Etching", edition: 50 }, { key: "g2", name: "Lithograph", edition: 100 }],
  entry_conversion_rate: 0.75,
};
const out = retargetSnapshot(JSON.parse(JSON.stringify(snap)), inputs, inputsDoc.benchmarks, curves, computeTargets, sellThrough);
const st = out.sellthrough;
check(st.conversion === 0.75, `rate ${st.conversion}`);
check(st.products && st.products.map((p) => p.name).join(",") === "Etching,Lithograph", `products ${JSON.stringify(st.products && st.products.map((p) => p.name))}`);
const [a, b] = st.products;
check(a.edition === 50 && b.edition === 100, "editions from the save");
// Etching is fuller (30 x .75 / 50 = .45) than Lithograph (15 x .75 / 100 = .11): the 10 flexible go to Lithograph
check(a.allocated === 30 && b.allocated === 25, `allocation ${a.allocated}, ${b.allocated}`);
// the headline is the per-product sum, capped at what the release has left to sell
const left = Math.max(150 - (snap.sellthrough.sold ?? 0), 0);
check(st.soldPredicted === Math.min(Math.round(55 * 0.75 * 10) / 10, left), `headline ${st.soldPredicted} (left ${left})`);
check(st.editionSum === 150 && st.editionMismatch === false, "the typed editions add up to the release's 150");
check(st.sold === snap.sellthrough.sold, "sold units carry over");
check(st.benchmarkUnits === undefined, "no benchmark in lever mode");

// without the feed the release-level path still works and the rate re-prices the in-hand units
const bare = JSON.parse(JSON.stringify(snap));
delete bare.sellthrough.draws; delete bare.sellthrough.patterns;
const out2 = retargetSnapshot(bare, { ...inputs, entry_conversion_rate: 0.5 }, inputsDoc.benchmarks, curves, computeTargets, sellThrough);
check(out2.sellthrough.products === undefined, "no products without the feed");
check(out2.sellthrough.soldPredicted === Math.min(25, Math.max(150 - out2.sellthrough.sold, 0)), `in hand at 50%: ${out2.sellthrough.soldPredicted}`);
console.log(failed ? `${failed} failure(s)` : "ok: retarget re-runs the per-product rule");
process.exit(failed ? 1 : 0);
