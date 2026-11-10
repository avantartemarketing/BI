/* docs/METHODOLOGY.md, the page the dashboard serves at /methodology
 * (server/methodology.js). Its worked example is a made-up release computed
 * with the current rules, so it cannot go stale against a real page: every
 * figure it quotes is worked out again here with the model the Target setting
 * tab runs (shared/benchmarkModel.mjs, which the parity tests hold to
 * etl/build.py), the channel split the build uses (etl/benchmarks.json
 * order_split) and the paid plan the cards read (web/src/format.mjs), and a
 * rule change that moves one fails here until the example is redone. The page
 * has to render as it is written: the example stays prose and one table, the
 * retired rules stay gone, and there is no em dash.
 * node tests/methodology.mjs */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { benchmarkTargets, GROUPS } from "../shared/benchmarkModel.mjs";
import { fmt, fmtPct, paidDayFrac } from "../web/src/format.mjs";

const require = createRequire(import.meta.url);
const { render } = require("../server/methodology.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const md = read("../docs/METHODOLOGY.md");
// the benchmarks with the panel's terms for a paid entry as a build writes
// them (etl/build.py paid_terms): the example states its own slope
const bench = { ...JSON.parse(read("../etl/benchmarks.json")),
  paid_cost: { slope: 0.5, k: 100, reference_spend: 10000, reference_price: 159, entry_to_unit: 1.16 } };

/* ---- the worked example: an illustration, labelled as one ---- */
const at = md.indexOf("### Worked example");
assert.ok(at > 0, "the worked example is on the page");
const ex = md.slice(at, md.indexOf("\n## ", at));
assert.ok(/illustrative/.test(ex.split("\n")[0]) && ex.includes("made up") && ex.includes("not a release on the dashboard"),
  "the example says it is an illustration, not a release on the dashboard");
// read as the page renders it: a line break in the source is a space
const flat = (text) => text.replace(/\s+/g, " ");
const exFlat = flat(ex);
const says = (text, why) => assert.ok(exFlat.includes(flat(text)), `the example says "${flat(text)}" (${why})`);

// the release and its basket, as the example states them
const release = { edition_size: 300, unit_price: 1500 };
const median = 240;
const share = { aa_email: 0.40, aa_social: 0.05, referral_artist: 0.025, search_direct_other: 0.325, paid: 0.20 };
const sessions = { aa_email: 8000, aa_social: 2000, referral_artist: 1000, search_direct_other: 5000, paid: 4000 };
const costed = 6, ref = 150, e2u = 1.2;
const profile = {
  units: median, units_by_group: Object.fromEntries(GROUPS.map((g) => [g, share[g] * median])),
  sessions_by_group: sessions, units_per_buyer: 1,
  cost_per_entry_ref: ref, cost_per_entry: 140, paid_entry_to_unit: e2u, n_costed_entries: costed, cost_per_purchase: 120, n_costed: costed,
};
const t = benchmarkTargets(profile, release, bench);

// K, the one even uplift
says(`An edition of ${release.edition_size} at €${fmt(release.unit_price)} a unit`, "the release");
says(`the launch value is €${fmt(t.launch_value)}`, "edition x price");
says(`**K = ${release.edition_size} ÷ ${median} = ${fmt(t.k, 2)}**`, "K = target units / benchmark units");
assert.strictEqual(t.k, 1.25);

// the channel split: each group's median share of the median launch, times K
const rows = { aa_email: "AA Email", aa_social: "AA Meta", referral_artist: "Artist's own channels", search_direct_other: "Search / direct / other", paid: "Paid" };
const num = (v) => (Number.isInteger(v) ? fmt(v) : fmt(v, 1));
for (const g of GROUPS) {
  const bm = profile.units_by_group[g], tg = t.units_by_group[g];
  assert.ok(Math.abs(tg - bm * t.k) < 1e-9, `${g}: target = benchmark x K`);
  says(`| ${rows[g]} | ${fmtPct(share[g], share[g] * 100 % 1 ? 1 : 0)} | ${num(bm)} | ${num(tg)} |`, `${g}'s row`);
}
says(`| All five | 100% | ${median} | ${release.edition_size} |`, "the groups sum to the median and to the edition");
assert.ok(Math.abs(GROUPS.reduce((a, g) => a + t.units_by_group[g], 0) - release.edition_size) < 1e-9);

// inside a group: the order-split medians, renormalised (etl/build.py _group_channel_split)
const med = (c) => Number(bench.order_split[c].Medium);
const man = med("AA Email Man") / (med("AA Email Man") + med("AA Email Auto"));
const email = t.units_by_group.aa_email;
says(`AA Email's ${fmt(email)} go about ${fmt(man * 100)}% to the manual sends and ${fmt((1 - man) * 100)}% to the`, "the order-split shares");
says(`${fmt(email * man)} and ${fmt(email * (1 - man))}`, "the order-split units");

// sessions carry the uplift; entries are every unit asked for at the 0.8 rate
const bmSessions = GROUPS.reduce((a, g) => a + sessions[g], 0);
says(`median of ${fmt(bmSessions)} becoming a target of ${fmt(bmSessions)} × ${fmt(t.k, 2)} = ${fmt(t.total_sessions)}`, "sessions x K");
assert.strictEqual(t.entry_rate, 0.8);
says(`Entries target ${release.edition_size} ÷ 0.8 = ${fmt(t.entries_target)}, against ${median} ÷ 0.8 = ${fmt(t.benchmark.entries)} for the benchmark`, "entries at the rate");

// paid: the units asked for as entries at the basket's rate and priced on the
// curve at the basket's median reference price, three readings needed, else
// the panel's; the constant per unit only while the panel is too thin
assert.strictEqual(t.paid.cost_source, "basket");
assert.strictEqual(t.paid.cost_basis, "curve");
assert.ok(/PAID_COST_MIN_MEMBERS = 3\b/.test(read("../etl/baskets.py")), "a basket's median needs three launches with a reading");
says(`${costed} of the 8 launches in the basket have a cost per paid entry on file`, "the readings");
says(`the median of their reference prices, €${fmt(ref)} an entry at €${fmt(bench.paid_cost.reference_spend)} of spend, prices the paid entries on the curve (slope ${bench.paid_cost.slope} here`, "the basket's median reference price");
says(`brought ${e2u} paid units of demand per paid entry, so the ${fmt(t.paid.units)} paid units are ${fmt(t.paid.entries)} entries`, "the units asked for as entries");
says(`the spend that buys ${fmt(t.paid.entries)} entries on the curve is **€${fmt(t.paid.budget)}**: €${fmt(t.paid.cost_per_entry)} an entry on average, €${fmt(t.paid.cost_per_purchase)} a unit, and €${fmt(t.paid.marginal_cost_per_entry)} for the last entry bought`, "the budget, the average and the marginal price");
assert.ok(t.paid.marginal_cost_per_entry > t.paid.cost_per_entry && t.paid.cost_per_entry > t.paid.cost_per_purchase, "the last entry costs more than the average, an entry more than a unit at 1.2 units an entry");
assert.ok(Math.abs(t.paid.budget - t.paid.units * t.paid.cost_per_purchase) < 1e-6, "the budget is the units at the average price per unit");
says(`${fmtPct(t.paid.budget_pct_of_launch_value, 1)} of the launch value and inside the ${fmtPct(bench.budget_sense_check_max_pct_of_launch_value)} sense check`, "the sense check");
says(`the benchmark's ${fmt(t.benchmark.paid_units)} units at the same €${fmt(t.paid.cost_per_purchase)} are €${fmt(t.benchmark.paid_budget)}`, "the benchmark's budget, unscaled");
assert.strictEqual(t.paid.sense_check_breached, false);
const thin = { ...profile, cost_per_entry_ref: 0, paid_entry_to_unit: 0, n_costed_entries: 2, cost_per_purchase: 0, n_costed: 2 };
const panel = benchmarkTargets(thin, release, bench);
assert.ok(panel.paid.cost_source === "panel" && panel.paid.cost_basis === "curve"
  && Math.abs(panel.paid.entries - t.paid.units / bench.paid_cost.entry_to_unit) < 1e-9,
  "under three readings the panel's reference price prices the entries, at the panel's rate");
const konst = benchmarkTargets(thin, release, { ...bench, paid_cost: undefined });
assert.ok(konst.paid.cost_source === "panel" && konst.paid.cost_basis === "unit", "a panel too thin to backtest prices flat at the constant");
says(`the constant €${fmt(bench.cost_per_purchase.Median)} per unit: ${fmt(t.paid.units)} × €${fmt(bench.cost_per_purchase.Median)} = €${fmt(konst.paid.budget)}`, "the constant's fallback");
const typed = benchmarkTargets(profile, { ...release, cost_per_entry: 250 }, bench);
assert.ok(typed.paid.cost_per_entry === 250 && typed.paid.cost_source === "release" && typed.paid.cost_basis === "entry", "a typed figure comes first (Step 5)");
const typedUnit = benchmarkTargets(profile, { ...release, cost_per_purchase: 200 }, bench);
assert.ok(typedUnit.paid.cost_per_purchase === 200 && typedUnit.paid.budget === 200 * t.paid.units && typedUnit.paid.cost_basis === "unit", "the older cost per unit still prices flat");

// the even paid plan: the day after the announce to the close
assert.ok(/^PAID_START_DAYS = 1\b/m.test(read("../etl/build.py")), "paid starts the day after the announce");
const L = 25, day = 13;
const frac = paidDayFrac({ day, of: L, asOfFraction: 1, paid: { paidStartDays: 1 } });
assert.strictEqual(frac, 0.5);
says(`On a campaign ${L} days long that is ${L - 1} days, so the plan spends €${fmt(t.paid.budget)} ÷ ${L - 1} = €${fmt(t.paid.budget / (L - 1))} a day`, "the plan's daily rate");
says(`${day} days after the announce the paid plan by today is (${day} − 1) ÷ ${L - 1} = half of it: ${fmt(t.paid.units * frac)} of the ${fmt(t.paid.units)} units, and €${fmt(t.paid.budget * frac)} spent`, "the paid plan by today");

/* ---- the rules the example leans on, stated as the code runs them ---- */
const step5 = md.slice(md.indexOf("### Step 5"), md.indexOf("### Step 6"));
assert.ok(/release's own figure[\s\S]*basket's median reference price[\s\S]*three or more[\s\S]*costed panel's median reference price[\s\S]*constant €177 per unit/.test(step5),
  "Step 5 prices a paid entry in the build's order: the release's, the basket's median, the panel's, the constant");
assert.ok(flat(step5).includes("leave-one-out backtest") && flat(step5).includes("reference spend of €10,000"), "Step 5 states the curve and its backtest");
const step6 = md.slice(md.indexOf("### Step 6"), at);
assert.ok(step6.includes("benchmark's pace for today") && step6.includes("less than 10% short") && step6.includes("colours nothing"),
  "Step 6 gives the colours the page draws, not the workbook's buffer");
for (const stale of ["(the release's figure, else €177)", "between buffer and target is amber", "a product can set its own",
  "entries needed = sell-out gap × 1.2", "trailing-3-day adjusted CPE × 1.5", "`spend^0.38`", "Forecast ROI below target"]) {
  assert.ok(!flat(md).includes(stale), `retired rule still on the page: ${stale}`);
}
assert.ok(!/\u2014/.test(md), "no em dash on the page");

/* ---- the page renders as written ---- */
const html = render(md);
const exHtml = html.slice(html.indexOf('<h3 id="worked-example'), html.indexOf("<h2", html.indexOf('<h3 id="worked-example')));
assert.ok(exHtml.length > 0 && (exHtml.match(/<table>/g) || []).length === 1, "the example renders its one table");
assert.ok(!/<ol>|<ul>|<pre>/.test(exHtml), "no line of the example is taken for a list or code");
assert.ok((exHtml.match(/<tr>/g) || []).length === GROUPS.length + 2, "a header, the five groups and the total");
for (const id of ["step-5-paid-budget", "step-6-status-colours", "worked-example-an-illustrative-release", "7-paid-in-flight-model"]) {
  assert.ok(html.includes(`id="${id}"`), `the page has its ${id} heading`);
}
console.log(`methodology: the worked example recomputes (K ${t.k}, budget €${fmt(t.paid.budget)}, plan ${fmtPct(frac)} by day ${day}) and the page renders`);
