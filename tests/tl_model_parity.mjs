// The JS side of tests/test_tl_model.py: runs shared/tlModel.mjs over the
// cases the Python test wrote and prints what it got, for the Python side to
// compare figure by figure.   node tests/tl_model_parity.mjs --cases <file.json>
import { readFileSync } from "node:fs";
import { applyChannelsOff, channelsOffOf, tlTargets } from "../shared/tlModel.mjs";

const args = process.argv.slice(2);
const file = args[args.indexOf("--cases") + 1];
const { bench, cases } = JSON.parse(readFileSync(file, "utf8"));
const out = cases.map((c) => {
  const read = applyChannelsOff(c.profile, channelsOffOf(c.inputs));
  return tlTargets(c.inputs, c.airtable_units, read, c.launch_value, bench);
});
process.stdout.write(JSON.stringify(out));
