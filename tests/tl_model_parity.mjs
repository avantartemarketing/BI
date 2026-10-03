// The JS side of tests/test_tl_model.py: runs shared/tlModel.mjs over the
// cases the Python test wrote and prints what it got, for the Python side to
// compare figure by figure.   node tests/tl_model_parity.mjs --cases <file.json>
import { readFileSync } from "node:fs";
import { applyChannelsOff, channelsOffOf, tlEconomics, tlPaidValue, tlTargets } from "../shared/tlModel.mjs";

const args = process.argv.slice(2);
const file = args[args.indexOf("--cases") + 1];
const { bench, cases, paid_cases: paidCases } = JSON.parse(readFileSync(file, "utf8"));
const targets = cases.map((c) => {
  const read = applyChannelsOff(c.profile, channelsOffOf(c.inputs));
  return tlTargets(c.inputs, c.airtable_units, read, c.launch_value, bench);
});
// the value of a paid signup: the targets, the works' economics, the value
const paid = (paidCases || []).map((c) => {
  const read = applyChannelsOff(c.profile, channelsOffOf(c.inputs));
  const T = tlTargets(c.inputs, c.airtable_units, read, c.launch_value, bench);
  return tlPaidValue(c.inputs, read, T, tlEconomics(c.rows), bench);
});
process.stdout.write(JSON.stringify({ targets, paid }));
