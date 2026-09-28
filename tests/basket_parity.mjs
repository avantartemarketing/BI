/* The basket rule, JS side, over a cases file: for each case the members in
 * basket order, the reach, the axes that ranked them and the artist's own, as
 * JSON, so tests/test_basket_parity.py can hold the Python rule to it. A case
 * may carry its own asOf and rows (a panel with a launch added); the file's
 * are the default. Beside them: the recent tier's cut-off day for each of
 * `monthDays` (monthsBefore, held to pandas' DateOffset), and each of
 * `resolve` - {id, rec} - as the basket API reads the release (server/baskets.js
 * resolveRelease, held to etl/build.py resolve_release).
 *   node tests/basket_parity.mjs --cases <file> */
import fs from "node:fs";
import { createRequire } from "node:module";
import { similarMembers, ownMembers, monthsBefore, RECENT_MONTHS } from "../shared/basketRule.mjs";

const require = createRequire(import.meta.url);
const at = process.argv.indexOf("--cases");
const doc = JSON.parse(fs.readFileSync(process.argv[at + 1], "utf8"));
const cases = doc.cases.map((c) => {
  const rows = c.rows || doc.rows, asOf = c.asOf || doc.asOf;
  const r = similarMembers(rows, c.release, { asOf, preferRecent: c.preferRecent });
  return { name: c.name, members: r.members, reach: r.reach, on: r.on, own: ownMembers(rows, c.release, { asOf }) };
});
const iso = (d) => d.toISOString().slice(0, 10);
const months = (doc.monthDays || []).map((s) => iso(monthsBefore(new Date(s + "T00:00:00Z"), RECENT_MONTHS)));
let resolved = [];
if (Array.isArray(doc.resolve) && doc.resolve.length) {
  const { resolveRelease } = require("../server/baskets.js");
  resolved = await Promise.all(doc.resolve.map(async ({ id, rec }) => {
    const r = await resolveRelease(rec, id);
    return { id, edition_size: r.edition_size ?? null, unit_price: r.unit_price ?? null, currency: r.currency || "EUR",
      private_room_open: r.private_room_open || null, announce_date: r.announce_date || null, launch_end: r.launch_end || null };
  }));
}
process.stdout.write(JSON.stringify({ cases, months, resolved }));
