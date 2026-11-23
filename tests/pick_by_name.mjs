/* pickByName (web/src/workGroups.mjs): a row is paired with its own forecast,
 * framing and target by name, never with those of the row beside it whose
 * name starts with its own (the Pejac page: "BARBED WIRE" beside "BARBED WIRE
 * [Special Print Edition]", Airtable naming both by a bracketed variant).
 *   node tests/pick_by_name.mjs */
import assert from "node:assert";
import { pickByName } from "../web/src/workGroups.mjs";

const rows = ["BARBED WIRE", "BARBED WIRE [Special Print Edition]", "MIND TRIP", "MIND TRIP [Special Print Edition]"];
const own = rows.map((name, i) => ({ name, v: i }));
const airtable = [{ name: "Barbed Wire [Special Print Edition]", v: 20 }, { name: "Barbed Wire [Standard Print Edition]", v: 80 },
  { name: "Mind Trip [Special Print Edition]", v: 20 }, { name: "Mind Trip [Standard Print Edition]", v: 80 }];

// the same name wins over a name that starts it
assert.deepStrictEqual(rows.map((n) => pickByName(own, n, rows).v), [0, 1, 2, 3]);
// the bare title reads the variant its sibling does not name, case aside
assert.deepStrictEqual(rows.map((n) => pickByName(airtable, n, rows).v), [80, 20, 80, 20]);
// with no siblings to tell them apart, two variants are no match
assert.strictEqual(pickByName(airtable, "BARBED WIRE"), null);
// a short title against a long one, as before
assert.strictEqual(pickByName([{ name: "Red print on paper" }, { name: "Blue print" }], "Red print", ["Red print", "Blue print"]).name, "Red print on paper");
// nothing to match
assert.strictEqual(pickByName(airtable, "Poster", rows), null);
assert.strictEqual(pickByName(airtable, "", rows), null);
assert.strictEqual(pickByName([], "BARBED WIRE", rows), null);
console.log("ok: pick by name");
