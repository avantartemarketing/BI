// The JS side of tests/test_tl_basket_parity.py: the picker's rule over the TL
// candidate rows, as BasketPicker.jsx runs it for a timed launch - the launches
// of the same window length first when at least THIN_MEMBERS of them (this
// launch's own row aside) are on file, else every length - and prints the
// members it picked, for the Python side to compare one by one.
//   node tests/tl_basket_parity.mjs --cases <file.json>
import { readFileSync } from "node:fs";
import { similarMembers, THIN_MEMBERS } from "../shared/basketRule.mjs";

const args = process.argv.slice(2);
const { rows, cases } = JSON.parse(readFileSync(args[args.indexOf("--cases") + 1], "utf8"));
const out = cases.map((c) => {
  const L = c.L;
  const same = c.length_hours ? rows.filter((r) => Number(r.window_hours) === Number(c.length_hours)) : null;
  const filtered = !!(same && same.filter((r) => r.release_name !== L.name).length >= THIN_MEMBERS);
  const ruleRows = filtered ? same : rows;
  const r = similarMembers(ruleRows, L, { preferRecent: c.prefer_recent, asOf: c.as_of });
  return { members: r.members, filtered, reach: r.reach };
});
process.stdout.write(JSON.stringify(out));
