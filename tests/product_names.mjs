/* A product's name on the Target setting tab: Airtable's title unless a name
 * was typed. The server saves "" for an Airtable product nobody named, and
 * that empty string used to count as typed, so the Cattelan works read
 * "unnamed" over "Not Afraid of Love" and "Novecento" (30 September 2026).
 *
 *   node tests/product_names.mjs
 */
import assert from "node:assert";
import { resolveProducts } from "../shared/economics.mjs";

const b = { frame_conversion: 0.2, frame_profit_per_unit: 50 };
const airtable = [
  { airtable_id: "2672", project_code: "MAURIZIOC-2672", name: "Not Afraid of Love", edition: 1000, unit_price: 1500, currency: "EUR" },
  { airtable_id: "2671", project_code: "MAURIZIOC-2671", name: "Novecento", edition: 1000, unit_price: 1500, currency: "EUR" },
];
const names = (typed) => resolveProducts(airtable, typed, b).map((p) => p.name);

// saved with the figures typed and no name: Airtable's titles stand
assert.deepStrictEqual(names([
  { airtable_id: "2672", name: "", artist_profit_per_unit: 781, aa_profit_per_unit: 335 },
  { airtable_id: "2671", name: "", artist_profit_per_unit: 781, aa_profit_per_unit: 335 },
]), ["Not Afraid of Love", "Novecento"]);
// nothing typed at all, and a name of spaces
assert.deepStrictEqual(names([]), ["Not Afraid of Love", "Novecento"]);
assert.deepStrictEqual(names([{ airtable_id: "2672", name: "   " }]), ["Not Afraid of Love", "Novecento"]);
// a typed name stands over Airtable's
assert.deepStrictEqual(names([{ airtable_id: "2671", name: "Horse" }]), ["Not Afraid of Love", "Horse"]);
// a product added by hand keeps its own name, after Airtable's
assert.deepStrictEqual(names([{ manual: true, name: "Frame", edition: 100 }]), ["Not Afraid of Love", "Novecento", "Frame"]);

console.log("product names: ok");
