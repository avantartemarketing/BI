/* A timed launch's page read in signup conversions (web/src/conversions.mjs):
 * each channel's signups at its own rate, the target the orders the launch
 * needs from its signups whichever way Direct is shown, the headline the sum
 * of the channels, the gap's drivers and the plan card's rows adding up in
 * the new unit, and a page it does not fit left as it is.
 * node tests/conversions.mjs */
import assert from "node:assert";
import { canConvert, conversionRates, toConversions, GROUPS } from "../web/src/conversions.mjs";
import { wordsOf } from "../web/src/vocab.mjs";
import { tlForecastRows } from "../web/src/tlForecastRows.mjs";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);
const rates = { aa_email: 0.3, aa_social: 0.2, referral_artist: 0.1, organic_search: 0.3, direct_other: 0.15, paid: 0.05 };
const targetBy = { aa_email: 700, aa_social: 200, referral_artist: 150, organic_search: 150, direct_other: 500, paid: 8000 };
const orders = GROUPS.reduce((t, g) => t + targetBy[g] * rates[g], 0);   // 785
const chan = (key, now, exp, proj) => ({ key, name: key, now, exp, proj, target: targetBy[key], bm: targetBy[key] * 0.9, bmExp: exp * 0.9,
  parts: [{ name: "a", value: now }], daily: [{ date: "2026-11-18", actual: now / 2, plan: exp / 2, proj: null, bm: exp * 0.45 }, { date: "2026-11-19", actual: now, plan: exp, proj: null, bm: exp * 0.9 }] });
const channels = [chan("aa_email", 200, 350, 500), chan("aa_social", 120, 100, 240), chan("referral_artist", 0, 75, 50), chan("organic_search", 20, 70, 60), chan("direct_other", 30, 230, 180), chan("paid", 430, 3800, 3000)];
const tot = (k) => channels.reduce((t, c) => t + c[k], 0);
const fbg = Object.fromEntries(GROUPS.map((g) => [g, { sessions_actual: 100, conv_actual: 0.1, contrib_traffic: -40, contrib_conversion: -10, contrib_traffic_bm: -30, contrib_conversion_bm: -5 }]));
const page = {
  id: "x_tl", type: "TL", tlState: "signups", builtAt: "t", day: 7, of: 20, windowStart: "2026-11-18",
  targets: { signup_order_rate: orders / 9700, signup_order_rate_by_group: rates, signups_by_group: targetBy, orders_needed: orders },
  hero: { now: tot("now"), expectedToday: tot("exp"), projected: tot("proj"), target: 9700, benchmark: 8730, benchmarkToday: tot("exp") * 0.9, preAnnounce: 80 },
  channels, funnelByGroup: fbg, benchmark: { n: 4 },
  waterfall: { target: 9700, projection: tot("proj"), benchmark: 8730,
    steps: [{ key: "organic_traffic", label: "Organic traffic", value: -500 }, { key: "organic_conversion", label: "Organic conversion", value: -70 }, { key: "paid_spend", label: "Paid spend", value: -3000 }, { key: "paid_efficiency", label: "Paid efficiency", value: -2100 }],
    stepsBm: [{ key: "organic_traffic", label: "Organic traffic", value: -400 }, { key: "organic_conversion", label: "Organic conversion", value: -50 }, { key: "paid_spend", label: "Paid spend", value: -2500 }, { key: "paid_efficiency", label: "Paid efficiency", value: -1750 }],
    today: { target: tot("exp"), actual: tot("now"), benchmark: tot("exp") * 0.9,
      steps: [{ key: "organic_traffic", label: "Organic traffic", value: -400 }, { key: "organic_conversion", label: "Organic conversion", value: -55 }, { key: "paid_spend", label: "Paid spend", value: -2200 }, { key: "paid_efficiency", label: "Paid efficiency", value: -1170 }],
      stepsBm: [{ key: "organic_traffic", label: "Organic traffic", value: -300 }, { key: "organic_conversion", label: "Organic conversion", value: -40 }, { key: "paid_spend", label: "Paid spend", value: -1900 }, { key: "paid_efficiency", label: "Paid efficiency", value: -1122.5 }] } },
  sellForecast: { source: "signup pages", keyed: 100, unkeyedProduct: 0, releaseSignups: 0, open: { signups: tot("proj"), su: 500, non: 300, units: 800, target: 1600, works: [{ key: "a", name: "A", keyed: 100, share: 1, target: 1600, su: 500, non: 300, units: 800 }] }, today: { signups: tot("now") } },
};

// ---- the weights: each channel's own rate, and the target is the orders the launch needs
assert.ok(canConvert(page));
const R = conversionRates(page);
for (const g of GROUPS) near(R.rates[g], rates[g]);
const c = toConversions(page);
assert.strictEqual(c.countAs, "conversions");
near(c.hero.target, orders);
near(c.hero.now, 200 * 0.3 + 120 * 0.2 + 0 + 20 * 0.3 + 30 * 0.15 + 430 * 0.05);
near(c.hero.projected, channels.reduce((t, x) => t + x.proj * rates[x.key], 0));
near(c.hero.statusPct, c.hero.now / c.hero.expectedToday - 1);
// paid is half the signups to date and far less of the conversions: the point of the reading
const paid = c.channels.find((x) => x.key === "paid");
assert.ok(430 / tot("now") > 0.5 && paid.now / c.hero.now < 0.2);
// a channel's parts and its daily path move with it; what is not a count of signups stays
near(paid.parts[0].value, 430 * 0.05);
near(paid.daily[1].actual, 430 * 0.05);
near(paid.daily[1].plan, 3800 * 0.05);
assert.strictEqual(paid.daily[0].proj, null);
assert.strictEqual(c.funnelByGroup.paid.sessions_actual, 100);
assert.strictEqual(c.funnelByGroup.paid.conv_actual, 0.1);
near(c.funnelByGroup.aa_email.contrib_traffic, -40 * 0.3);
// the page it was made from is untouched
assert.strictEqual(page.channels[5].now, 430);
assert.strictEqual(page.countAs, undefined);

// ---- the gap's drivers are whole and add up to the gap the card prints, today and at the open, on both references
const adds = (steps, from, to) => assert.strictEqual(steps.reduce((t, s) => t + s.value, 0), Math.round(to) - Math.round(from));
adds(c.waterfall.steps, c.hero.target, c.hero.projected);
adds(c.waterfall.today.steps, c.hero.expectedToday, c.hero.now);
adds(c.waterfall.stepsBm, c.hero.benchmark, c.hero.projected);
adds(c.waterfall.today.stepsBm, c.hero.benchmarkToday, c.hero.now);
assert.ok(c.waterfall.steps.every((s) => Number.isInteger(s.value)));
// paid's two drivers shrink far more than the organic ones do
const step = (w, k) => w.find((s) => s.key === k).value;
assert.ok(Math.abs(step(c.waterfall.today.steps, "paid_spend")) / 2200 < Math.abs(step(c.waterfall.today.steps, "organic_traffic")) / 400);

// ---- Direct spread over the other channels: the same target, to the order
const spreadBy = { ...targetBy, direct_other: 300, paid: 8200 };   // Direct's signups shown on paid, which converts least
const spread = { ...page, targets: { ...page.targets, signups_by_group: spreadBy }, channels: channels.map((x) => ({ ...x, target: spreadBy[x.key] })) };
near(toConversions(spread).hero.target, orders, 1e-6);
assert.ok(conversionRates(spread).rates.paid > rates.paid);

// ---- the forecast table's signups side follows the headline
const rows = tlForecastRows(c);
near(rows.all.signups, c.hero.now);
near(rows.all.forecastSignups, c.hero.projected);
assert.strictEqual(rows.all.su, 500);
near(tlForecastRows(page).all.forecastSignups, tot("proj"));

// ---- the plan-based view: every piece at its channel's rate, the rows and the card adding up
const planPage = {
  ...page, method: "plan",
  plan: { state: "live", target: 9700, expected: 9500, in: 800, toCome: 700, lands: 1500, range: [9000, 9500], landsRecommended: 3500, against: "short", notCovered: 200, of: "signups",
    rows: [
      { moment: "Announce", expected: 900, in: 300, toCome: 0, lands: 300, pieces: [{ who: "email", name: "Email", expected: 700, in: 250, toCome: 0 }, { who: "aa", name: "Posts", expected: 150, in: 50, toCome: 0 }, { who: "artist", name: "Artist", expected: 50, in: 0, toCome: 0 }] },
      { moment: "Baseline", expected: 600, in: 70, toCome: 100, lands: 170, pieces: [{ who: "search", name: "Search", expected: 200, in: 20, toCome: 40 }, { who: "other", name: "Other", expected: 400, in: 50, toCome: 60 }] },
      { moment: "Paid", expected: 8000, in: 430, toCome: 600, lands: 1030, pieces: [{ who: "paid", name: "spent", expected: 3800, in: 430, toCome: 0 }, { who: "paid", name: "a day", expected: 4200, in: 0, toCome: 600 }] },
      { moment: "Not covered", expected: 200, in: 0, toCome: 0, lands: 0, pieces: [] },
    ] },
  planChanges: { changes: [{ key: "p", title: "Paid daily budget", channel: "Paid", units: { low: 2000, high: 2000 } }, { key: "a", title: "AA IG post", channel: "AA Social", units: { low: 10, high: 25 }, alts: [{ key: "b", units: { low: 5, high: 10 } }] }], more: [] },
};
const pc = toConversions(planPage);
const P = pc.plan;
assert.strictEqual(P.of, "conversions");
near(P.target, orders);
const announce = P.rows.find((r) => r.moment === "Announce");
near(announce.expected, 700 * 0.3 + 150 * 0.2 + 50 * 0.1);
near(announce.lands, 250 * 0.3 + 50 * 0.2);
near(P.rows.find((r) => r.moment === "Paid").expected, 8000 * 0.05);
const covered = P.rows.filter((r) => r.moment !== "Not covered").reduce((t, r) => t + r.expected, 0);
near(P.expected, covered);
near(P.notCovered, orders - covered);
near(P.rows.find((r) => r.moment === "Not covered").expected, orders - covered);
near(P.lands, P.rows.reduce((t, r) => t + r.lands, 0));
near(pc.hero.projected, P.lands);
near(P.landsRecommended, P.lands + 2000 * 0.05);
adds(pc.waterfall.steps, P.target, P.lands);
assert.deepStrictEqual(pc.waterfall.steps.map((s) => s.key), ["plan", "Announce", "Baseline", "Paid", "Not covered"]);
near(pc.planChanges.changes[0].units.high, 2000 * 0.05);
near(pc.planChanges.changes[1].units.low, 10 * 0.2);
near(pc.planChanges.changes[1].alts[0].units.high, 10 * 0.2);
assert.strictEqual(P.against, "short");

// ---- the plan check's verdict is read again in conversions, so the card's sentence agrees with the figures beside
// it: the target inside the range reads in line, above it short (with the part not covered as a row), below it over
const mix = (rows, extra) => toConversions({ ...planPage, plan: { ...planPage.plan, rows, ...extra } }).plan;
const paidRow = planPage.plan.rows.find((r) => r.moment === "Paid");
// short in signups, but heavy on email and search, whose signups order most: worth more than the orders needed
const rich = [{ moment: "Announce", expected: 1100, in: 0, toCome: 0, lands: 0, pieces: [{ who: "email", name: "Email", expected: 900, in: 0, toCome: 0 }, { who: "aa", name: "Posts", expected: 150, in: 0, toCome: 0 }, { who: "artist", name: "Artist", expected: 50, in: 0, toCome: 0 }] },
  { moment: "Baseline", expected: 400, in: 0, toCome: 0, lands: 0, pieces: [{ who: "search", name: "Search", expected: 400, in: 0, toCome: 0 }] }, paidRow, planPage.plan.rows.find((r) => r.moment === "Not covered")];
const inLine = mix(rich, { range: [8900, 9500] });
near(inLine.expected, 900 * 0.3 + 150 * 0.2 + 50 * 0.1 + 400 * 0.3 + 8000 * 0.05);   // 825 against the 785 needed
assert.strictEqual(inLine.against, "in line");
assert.strictEqual(inLine.notCovered, 0);
assert.ok(!inLine.rows.some((r) => r.moment === "Not covered"));
assert.ok(inLine.range[0] <= inLine.target && inLine.target <= inLine.range[1]);
assert.strictEqual(mix(rich, { range: [9100, 9500] }).against, "over");
// in line in signups, but on the artist's and other channels, whose signups order least: short in conversions
const lean = [{ moment: "Announce", expected: 1100, in: 0, toCome: 0, lands: 0, pieces: [{ who: "artist", name: "Artist", expected: 1100, in: 0, toCome: 0 }] },
  { moment: "Baseline", expected: 600, in: 0, toCome: 0, lands: 0, pieces: [{ who: "other", name: "Other", expected: 600, in: 0, toCome: 0 }] }, paidRow];
const short = mix(lean, { expected: 9700, range: [9000, 9800], against: "in line", notCovered: 0 });
assert.strictEqual(short.against, "short");
near(short.notCovered, orders - (1100 * 0.1 + 600 * 0.15 + 8000 * 0.05));
near(short.rows.find((r) => r.moment === "Not covered").expected, short.notCovered);
assert.ok(short.target > short.range[1]);
// a plan sized the older way has no verdict in either unit
assert.strictEqual(mix(lean, { against: null }).against, null);

// ---- the words follow the reading, and the paid cards keep the signup's
assert.strictEqual(wordsOf(c).unit, "conversions");
assert.strictEqual(wordsOf(c).trajTitle, "Signup conversions (assumed)");
assert.strictEqual(wordsOf(c).paidCost, "Cost per signup");
assert.strictEqual(wordsOf(page).unit, "signups");

// ---- a page it does not fit comes back as it is: a draw launch, a timed launch in its window, one with no rates
const le = { ...page, type: "LE" };
assert.strictEqual(toConversions(le), le);
const open = { ...page, tlState: "window" };
assert.strictEqual(toConversions(open), open);
assert.strictEqual(wordsOf({ ...open, countAs: "conversions" }).unit, "units");
const bare = { ...page, targets: {} };
assert.ok(!canConvert(bare));
assert.strictEqual(toConversions(bare), bare);
// a channel the basket has no rate for takes the blended one
const gap = toConversions({ ...page, targets: { ...page.targets, signup_order_rate_by_group: { ...rates, referral_artist: 0 } } });
assert.ok(gap.channels.find((x) => x.key === "referral_artist").target > 0);

console.log("conversions: ok");
