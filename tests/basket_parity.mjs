/* The basket rule, JS side, over a cases file: for each case the members in
 * basket order, the reach, the axes that ranked them and the artist's own, as
 * JSON, so tests/test_basket_parity.py can hold the Python rule to it.
 *   node tests/basket_parity.mjs --cases <file> */
import fs from "node:fs";
import { similarMembers, ownMembers } from "../shared/basketRule.mjs";

const at = process.argv.indexOf("--cases");
const doc = JSON.parse(fs.readFileSync(process.argv[at + 1], "utf8"));
const out = doc.cases.map((c) => {
  const r = similarMembers(doc.rows, c.release, { asOf: doc.asOf, preferRecent: c.preferRecent });
  return { name: c.name, members: r.members, reach: r.reach, on: r.on, own: ownMembers(doc.rows, c.release, { asOf: doc.asOf }) };
});
process.stdout.write(JSON.stringify(out));
