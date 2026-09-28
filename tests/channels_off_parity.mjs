// The JS side of tests/test_channels_off.py: runs shared/benchmarkModel.mjs
// over the cases the Python test wrote and prints what it got, one result per
// case, for the Python side to compare figure by figure.
//   node tests/channels_off_parity.mjs --cases <file.json>
// With --snaps it reads built snapshots instead and rebuilds the Target
// setting tab's header from each one's benchmark block, as the tab does with
// nothing edited: profileOf, less the channels the release set aside.
//   node tests/channels_off_parity.mjs --snaps <file.json>
import { readFileSync } from "node:fs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf, profileOf } from "../shared/benchmarkModel.mjs";

const args = process.argv.slice(2);
const fromSnaps = args.includes("--snaps");
const file = args[args.indexOf(fromSnaps ? "--snaps" : "--cases") + 1];
const { bench, cases, snaps } = JSON.parse(readFileSync(file, "utf8"));

const tab = (c) => {
  const profile = applyChannelsOff(profileOf(c.benchmark), channelsOffOf({ channels_off: c.benchmark.channelsOff }));
  const t = benchmarkTargets(profile, c.inp, bench);
  return { name: c.name, k: t.k, paid_units: t.paid_units, paid_budget: t.paid.budget, bm_paid_budget: t.benchmark.paid_budget };
};

const out = fromSnaps ? snaps.map(tab) : cases.map((c) => {
  const off = channelsOffOf({ channels_off: c.off });
  const profile = applyChannelsOff(c.profile, off);
  const t = benchmarkTargets(profile, c.inp, bench);
  return { name: c.name, off, profile, targets: t };
});
process.stdout.write(JSON.stringify(out));
