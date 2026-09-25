/* attachOrders (shared/sellThrough.mjs) on the fixtures, and the JSON the
 * Python side compares itself against.  node tests/attach_orders.mjs [--json] */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachOrders } from "../shared/sellThrough.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, "attach_orders_fixtures.json"), "utf8"));
const json = process.argv.includes("--json");
let failed = 0;
const results = [];
for (const c of fixtures.cases) {
  const { products, source } = attachOrders(c.products, c.orders, c.drawProducts, c.source, !!c.ordersOnly);
  const got = {
    names: products.map((p) => p.name), sold: products.map((p) => p.sold), drafts: products.map((p) => p.drafts),
    editions: products.map((p) => p.edition), source,
  };
  results.push({ name: c.name, out: { products, source } });
  for (const [k, want] of Object.entries(c.expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(want)) {
      failed += 1;
      if (!json) console.error(`FAIL ${c.name}: ${k} = ${JSON.stringify(got[k])}, expected ${JSON.stringify(want)}`);
    }
  }
}
if (json) process.stdout.write(JSON.stringify(results));
else console.log(failed ? `${failed} expectation(s) failed` : `ok: ${fixtures.cases.length} cases`);
process.exit(failed ? 1 : 0);
