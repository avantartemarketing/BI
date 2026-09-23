/* The per-product sell-through rule, JS side: runs every fixture through
 * shared/sellThrough.mjs, checks the expectations, and prints the full result
 * as JSON so tests/test_sellthrough.py can compare the Python mirror against
 * it to the unit.  node tests/sellthrough_parity.mjs [--json] */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sellThroughProducts } from "../shared/sellThrough.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, "sellthrough_fixtures.json"), "utf8"));
const json = process.argv.includes("--json");

let failed = 0;
const results = [];
for (const c of fixtures.cases) {
  const out = sellThroughProducts({
    products: c.products, patterns: c.patterns, rate: c.rate, edition: c.edition,
    soldTotal: c.soldTotal, futureUnits: c.futureUnits, preorderRate: c.preorderRate ?? null,
  });
  results.push({ name: c.name, out });
  const got = {
    allocated: out.products.map((p) => p.allocated),
    shown: out.products.map((p) => p.shown),
    oversubscribed: out.products.map((p) => p.oversubscribed),
    soldAssumed: out.products.map((p) => p.soldAssumed),
    room: out.products.map((p) => p.room),
    flexibleEntrants: out.allocation.flexibleEntrants,
    surplusEntries: out.allocation.surplusEntries,
    unattributedSold: out.unattributedSold,
    measure: out.measure,
  };
  for (const [k, want] of Object.entries(c.expect)) {
    const have = got[k];
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      failed += 1;
      if (!json) console.error(`FAIL ${c.name}: ${k} = ${JSON.stringify(have)}, expected ${JSON.stringify(want)}`);
    }
  }
}
if (json) {
  process.stdout.write(JSON.stringify(results));
} else {
  console.log(failed ? `${failed} expectation(s) failed` : `ok: ${fixtures.cases.length} cases`);
}
process.exit(failed ? 1 : 0);
