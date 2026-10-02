/* The Target setting tab's stretch sliders (shared/benchmarkModel.mjs
 * rebalanceShares): moving one channel's share rescales the others so the
 * shares always add to 1, each keeping its proportion of the rest.
 *   node tests/stretch_sliders.mjs */
import { rebalanceShares, GROUPS } from "../shared/benchmarkModel.mjs";

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const close = (a, b) => Math.abs(a - b) <= 1e-9;
const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
const ACTIVE = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"];

// paid slid up to 60%: the other four keep their proportions of the remaining 40%
const basket = { aa_email: 0.2, aa_social: 0.1, referral_artist: 0.3, search_direct_other: 0.1, paid: 0.3 };
const up = rebalanceShares(basket, "paid", 0.6, ACTIVE);
check(close(up.paid, 0.6), `paid takes the value: ${up.paid}`);
check(Math.abs(up.aa_email - 0.4 * 0.2 / 0.7) < 0.0002, `the others rescale in proportion: aa_email ${up.aa_email}`);
check(Math.abs(up.referral_artist / up.aa_email - 1.5) < 0.01, `and keep their proportions to each other (${up.referral_artist} / ${up.aa_email})`);
check(close(sum(up), 1), `the shares add to 1 exactly: ${sum(up)}`);
check(GROUPS.every((g) => Math.abs(up[g] * 10000 - Math.round(up[g] * 10000)) < 1e-6), "kept to four places");
// the moved group holds the value it was given; the remainder lands elsewhere
const odd = rebalanceShares({ a: 0.3333, b: 0.3333, c: 0.3334 }, "a", 0.5, ["a", "b", "c"]);
check(close(odd.a, 0.5) && close(sum(odd), 1), `the moved group holds its value and the sum is 1: ${JSON.stringify(odd)}`);
// paid slid down to 0: the others share everything
const down = rebalanceShares(basket, "paid", 0, ACTIVE);
check(close(down.paid, 0) && close(sum(down), 1) && Math.abs(down.referral_artist - 0.3 / 0.7) < 0.0002, `paid at nothing, the rest carry it: ${JSON.stringify(down)}`);
// the moved group had it all: the rest is spread evenly over the others
const spread = rebalanceShares({ paid: 1 }, "paid", 0.5, ACTIVE);
check(close(spread.paid, 0.5) && close(spread.aa_email, 0.125) && close(spread.search_direct_other, 0.125) && close(sum(spread), 1), `from all-paid, the others split the rest evenly: ${JSON.stringify(spread)}`);
// only the active groups take a share: a group set aside is left out
const few = rebalanceShares(basket, "paid", 0.5, ["paid", "aa_email"]);
check(close(few.paid, 0.5) && close(few.aa_email, 0.5) && !("aa_social" in few) && !("referral_artist" in few), `inactive groups are left out: ${JSON.stringify(few)}`);
// one active group: it carries everything whatever the slider says
const one = rebalanceShares(basket, "paid", 0.3, ["paid"]);
check(close(one.paid, 1) && Object.keys(one).length === 1, `a lone group carries it all: ${JSON.stringify(one)}`);
// values are clamped to a share
check(close(rebalanceShares(basket, "paid", 1.7, ACTIVE).paid, 1) && close(rebalanceShares(basket, "paid", -0.2, ACTIVE).paid, 0), "clamped to 0..1");
// a slider on a group not in the active set changes nothing
const noop = rebalanceShares(basket, "paid", 0.9, ["aa_email", "aa_social"]);
check(close(noop.aa_email, 0.2) && close(noop.aa_social, 0.1) && !("paid" in noop), `an inactive slider changes nothing: ${JSON.stringify(noop)}`);
// rounding: three ways of a third still add to exactly 1
const thirds = rebalanceShares({ a: 1, b: 1, c: 1 }, "a", 1 / 3, ["a", "b", "c"]);
check(close(sum(thirds), 1), `thirds add to 1 exactly: ${JSON.stringify(thirds)}`);

if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("stretch sliders: ok");
