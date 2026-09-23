// The JS side of tests/test_release_inputs.py: runs shared/economics.mjs over
// the cases the Python test wrote and prints what it got, for the Python side
// to compare figure by figure.   node tests/release_inputs_parity.mjs --cases <file.json>
import { readFileSync } from "node:fs";
import { resolveProducts, releaseEconomics } from "../shared/economics.mjs";

const args = process.argv.slice(2);
const file = args[args.indexOf("--cases") + 1];
const { bench, cases } = JSON.parse(readFileSync(file, "utf8"));
const out = cases.map((c) => {
  const products = resolveProducts(c.airtable, c.typed, bench);
  return { name: c.name, products, economics: releaseEconomics(products, c.legacy, bench) };
});
process.stdout.write(JSON.stringify(out));
