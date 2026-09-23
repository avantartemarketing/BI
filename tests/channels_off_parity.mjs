// The JS side of tests/test_channels_off.py: runs shared/benchmarkModel.mjs
// over the cases the Python test wrote and prints what it got, one result per
// case, for the Python side to compare figure by figure.
//   node tests/channels_off_parity.mjs --cases <file.json>
import { readFileSync } from "node:fs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf } from "../shared/benchmarkModel.mjs";

const args = process.argv.slice(2);
const file = args[args.indexOf("--cases") + 1];
const { bench, cases } = JSON.parse(readFileSync(file, "utf8"));

const out = cases.map((c) => {
  const off = channelsOffOf({ channels_off: c.off });
  const profile = applyChannelsOff(c.profile, off);
  const t = benchmarkTargets(profile, c.inp, bench);
  return { name: c.name, off, profile, targets: t };
});
process.stdout.write(JSON.stringify(out));
