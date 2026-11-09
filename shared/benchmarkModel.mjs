/* The benchmark target model, JS side: a basket read without the channels a
 * release will not run, and the targets and benchmarks that follow from it.
 *
 * This mirrors etl/baskets.py apply_channels_off and etl/build.py
 * benchmark_targets to the figure, and tests/test_channels_off.py holds the
 * two to it over the live baskets with every channel switch flipped. The
 * Python side is what the build runs when targets are saved; this side is
 * what the Target setting rail and the picker show as the switches are
 * flipped and the sellout is typed, so the page can answer at once and say
 * the same thing the build will.
 *
 * A profile is the basket's medians as etl/baskets.py basket_profile writes
 * them: units (demand: what the launches would have sold with enough
 * supply), units_sold, n_short, sessions, entries, units_p25, units_p75,
 * units_by_group, sessions_by_group, share_units, share_sessions, conv.
 * The snapshot's benchmark block carries the same figures under camel-case
 * names, with the basket's full medians as the *All fields; profileOf turns
 * that block back into a profile so the switches can be re-read in place.
 */
import { averagePrice, marginalPrice, spendForEntries } from "./paidCost.mjs";

export const GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const typed = (v) => (v === null || v === undefined || v === "" ? 0 : Math.max(num(v), 0));
const byGroup = (src, f) => Object.fromEntries(GROUPS.map((g) => [g, f(g, num((src || {})[g]))]));

/* The groups this release will not run, kept to the known ones, deduplicated
 * and in GROUPS order - the same normalisation as etl/baskets.py channels_off_of. */
export function channelsOffOf(inp) {
  let raw = (inp && inp.channels_off) || [];
  if (typeof raw === "string") raw = [raw];
  const wanted = new Set(raw.map((g) => String(g).trim()));
  return GROUPS.filter((g) => wanted.has(g));
}

/* The basket read without the channels set aside (BENCHMARK_SPEC 4.3): those
 * groups' medians go to zero, the headline medians drop to what the rest add
 * up to, entries and the middle half fall by the same share, the shares are
 * renormalised over the groups in plan and the group's conversion is zero.
 * The basket's full medians ride along as the *_all fields. */
export function applyChannelsOff(profile, off) {
  const set = new Set(off || []);
  const offList = GROUPS.filter((g) => set.has(g));
  const unitsAll = byGroup(profile.units_by_group, (_g, v) => v);
  const sessAll = byGroup(profile.sessions_by_group, (_g, v) => v);
  const out = {
    ...profile,
    channels_off: offList,
    units_all: num(profile.units), units_sold_all: num(profile.units_sold ?? profile.units),
    sessions_all: num(profile.sessions), entries_all: num(profile.entries),
    units_by_group_all: unitsAll, sessions_by_group_all: sessAll,
  };
  if (!offList.length) return out;
  const keep = GROUPS.filter((g) => !set.has(g));
  const units = keep.reduce((s, g) => s + unitsAll[g], 0);
  const sessions = keep.reduce((s, g) => s + sessAll[g], 0);
  const ratio = out.units_all > 0 ? units / out.units_all : 0;
  out.units = units;
  out.units_sold = out.units_sold_all * ratio;
  out.sessions = sessions;
  out.entries = out.entries_all * ratio;
  out.units_p25 = num(profile.units_p25) * ratio;
  out.units_p75 = num(profile.units_p75) * ratio;
  out.units_by_group = byGroup(unitsAll, (g, v) => (set.has(g) ? 0 : v));
  out.sessions_by_group = byGroup(sessAll, (g, v) => (set.has(g) ? 0 : v));
  for (const key of ["share_units", "share_sessions"]) {
    const raw = byGroup(profile[key], (g, v) => (set.has(g) ? 0 : v));
    const tot = GROUPS.reduce((s, g) => s + raw[g], 0);
    out[key] = byGroup(raw, (_g, v) => (tot > 0 ? v / tot : 0));
  }
  out.conv = byGroup(profile.conv, (g, v) => (set.has(g) ? 0 : v));
  return out;
}

/* A snapshot's benchmark block as the profile it was built from: the basket's
 * full medians, before any channel was set aside, so applyChannelsOff can be
 * run on it again with whatever the switches say now. An older snapshot has
 * no *All fields and reads as built. */
export function profileOf(bm) {
  if (!bm) return null;
  const unitsByGroup = bm.unitsByGroupAll || bm.unitsByGroup || {};
  const sessByGroup = bm.sessionsByGroupAll || bm.sessionsByGroup || {};
  const shares = (src) => {
    const tot = GROUPS.reduce((s, g) => s + num(src[g]), 0);
    return byGroup(src, (_g, v) => (tot > 0 ? v / tot : 0));
  };
  return {
    n: bm.basket ? bm.basket.n : null,
    units: num(bm.unitsAll ?? bm.units), sessions: num(bm.sessionsAll ?? bm.sessions), entries: num(bm.entriesAll ?? bm.entries),
    // the sales beside the demand, and the members that sold out short; a
    // snapshot built before demand reads its units as both
    units_sold: num(bm.unitsSoldAll ?? bm.unitsSold ?? bm.unitsAll ?? bm.units), n_short: num(bm.nShort),
    units_p25: num(bm.unitsP25All ?? bm.unitsP25), units_p75: num(bm.unitsP75All ?? bm.unitsP75),
    price: num(bm.price), price_p25: num(bm.priceP25), price_p75: num(bm.priceP75), n_priced: num(bm.nPriced),
    campaign_days: num(bm.campaignDays),
    units_by_group: byGroup(unitsByGroup, (_g, v) => v), sessions_by_group: byGroup(sessByGroup, (_g, v) => v),
    share_units: shares(unitsByGroup), share_sessions: shares(sessByGroup),
    conv: byGroup(bm.convByGroupAll || bm.convByGroup, (_g, v) => v),
    units_per_buyer: num(bm.unitsPerBuyer),
    // what a paid unit cost the basket's launches (0: none read), and how many had a reading
    cost_per_purchase: num(bm.costPerPurchase), n_costed: num(bm.costPerPurchaseN),
    // and a paid entry: at the reference spend on the curve, as paid, the
    // paid entry to unit rate, and the members with a reading
    cost_per_entry_ref: num(bm.costPerEntryRef), cost_per_entry: num(bm.costPerEntry),
    paid_entry_to_unit: num(bm.paidEntryToUnit), n_costed_entries: num(bm.costPerEntryN),
  };
}

/* The panel's terms for pricing a paid entry (etl/build.py paid_terms): the
 * build's, on the benchmarks as paid_cost, else the file's defaults with no
 * reference price, which leaves the constant per unit to stand in. */
export function paidTerms(b) {
  const t = { ...((b && b.paid_cost) || {}) };
  const bounds = (b && b.paid_cost_slope_bounds) || [0.2, 0.7];
  if (!(num(t.k) > 0)) t.k = num(b && b.cpe_wearout_k) || 100;
  if (!(num(t.reference_spend) > 0)) t.reference_spend = num(b && b.paid_cost_reference_spend) || 10000;
  if (t.slope === null || t.slope === undefined) t.slope = num(bounds[0]);
  t.slope = num(t.slope);
  t.reference_price = num(t.reference_price);
  t.entry_to_unit = num(t.entry_to_unit);
  return t;
}

/* The paid budget for `units` paid units and the prices behind it, to the
 * figure of etl/build.py paid_pricing (docs step 5): the units asked for as
 * entries at the basket's paid entry to unit rate (else the panel's, else
 * the entry rate), priced flat at a typed figure (per unit, cost_per_purchase,
 * or per entry, cost_per_entry), else on the curve at the basket's reference
 * price (three costed members), else at the panel's, else flat at the
 * constant per unit while the panel is too thin. A profile read with Direct
 * spread carries cost_scale: the typed figures and the panel's take it, the
 * basket's already have. */
export function paidPricing(profile, inp, b, units, e2o) {
  const prof = profile || {};
  const t = paidTerms(b);
  const scale = num(prof.cost_scale) > 0 ? num(prof.cost_scale) : 1;
  const slope = t.slope, k = t.k, sRef = t.reference_spend;
  const e2u = num(prof.paid_entry_to_unit) > 0 ? num(prof.paid_entry_to_unit) : t.entry_to_unit > 0 ? t.entry_to_unit : num(e2o);
  units = num(units);
  const entries = e2u > 0 ? units / e2u : 0;
  const ownUnit = typed(inp && inp.cost_per_purchase), ownEntry = typed(inp && inp.cost_per_entry);
  const basketRef = num(prof.cost_per_entry_ref), basketUnit = num(prof.cost_per_purchase), panelRef = t.reference_price;
  let ref = null, flat = 0, source, basis;
  if (ownUnit > 0) { flat = ownUnit * scale; source = "release"; basis = "unit"; }
  else if (ownEntry > 0) { flat = e2u > 0 ? (ownEntry * scale) / e2u : 0; source = "release"; basis = "entry"; }
  else if (basketRef > 0) { ref = basketRef; source = "basket"; basis = "curve"; }
  else if (basketUnit > 0) { flat = basketUnit; source = "basket"; basis = "unit"; }
  else if (panelRef > 0) { ref = panelRef * scale; source = "panel"; basis = "curve"; }
  else {
    const table = (b && b.cost_per_purchase) || {};
    const pick = inp && inp.cpp_pick;
    flat = num(pick && table[pick] !== undefined ? table[pick] : table.Median) * scale; source = "panel"; basis = "unit";
  }
  let budget, perUnit, perEntry, marginal;
  if (ref !== null) {
    budget = spendForEntries(entries, ref, slope, k, sRef);
    perEntry = entries > 0 ? budget / entries : averagePrice(0, ref, slope, k, sRef);
    marginal = marginalPrice(budget, ref, slope, k, sRef);
    perUnit = units > 0 ? budget / units : e2u > 0 ? perEntry / e2u : 0;
  } else {
    budget = units * flat;
    perUnit = flat;
    perEntry = flat * e2u;
    marginal = perEntry;
  }
  return {
    budget, entries, entry_to_unit: e2u,
    cost_per_purchase: perUnit, cost_per_purchase_source: source, cost_source: source, cost_basis: basis,
    cost_per_entry: perEntry, cost_per_entry_ref: ref, marginal_cost_per_entry: marginal,
    cost_slope: ref !== null ? slope : null,
  };
}

/* Where the stretch comes from (BENCHMARK_SPEC 4.4, etl/build.py
 * stretch_weights): the share of the gap between the target and the basket's
 * median each group is asked for. The release's stretch_from when typed (a
 * share per group, over the groups in plan that have a benchmark to lift,
 * renormalised), else the basket's own unit shares - the even uplift. */
export function stretchWeights(inp, unitsByGroup) {
  const bm = byGroup(unitsByGroup, (_g, v) => v);
  const total = GROUPS.reduce((s, g) => s + (bm[g] > 0 ? bm[g] : 0), 0);
  const even = byGroup(bm, (_g, v) => (total > 0 && v > 0 ? v / total : 0));
  const raw = inp && inp.stretch_from;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return even;
  const w = byGroup(bm, (g, v) => (v > 0 ? Math.max(num(raw[g]), 0) : 0));
  const s = GROUPS.reduce((t, g) => t + w[g], 0);
  return s > 0 ? byGroup(w, (_g, v) => v / s) : even;
}

/* Whether the release placed its stretch: a share on a group with a benchmark to lift. */
export function stretchTyped(inp, unitsByGroup) {
  const raw = inp && inp.stretch_from;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return GROUPS.some((g) => num((unitsByGroup || {})[g]) > 0 && num(raw[g]) > 0);
}

/* The Target setting tab's sliders: one group's share moved to `value` (a
 * fraction), the other active groups rescaled so the shares still add to 1,
 * each keeping its proportion of the rest; when the others held nothing (the
 * moved group had it all) the rest is spread evenly over them. Groups not
 * active (set aside, or with no benchmark to lift) are left out. Shares are
 * kept to four places as the server keeps them; the moved group holds the
 * value it was given and the rounding remainder goes on the largest of the
 * others, so the sum is exactly 1. */
export function rebalanceShares(shares, key, value, active) {
  const act = active || [];
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const cur = Object.fromEntries(act.map((g) => [g, Math.max(num((shares || {})[g]), 0)]));
  if (!act.includes(key)) return cur;
  const others = act.filter((g) => g !== key);
  if (!others.length) return { [key]: 1 };
  const v = r4(Math.min(Math.max(num(value), 0), 1));
  const tot = others.reduce((s, g) => s + cur[g], 0);
  const out = { [key]: v };
  for (const g of others) out[g] = r4(tot > 0 ? (1 - v) * cur[g] / tot : (1 - v) / others.length);
  const rem = r4(1 - v - others.reduce((s, g) => s + out[g], 0));
  if (rem) {
    const big = others.reduce((a, g) => (out[g] > out[a] ? g : a), others[0]);
    out[big] = r4(out[big] + rem);
  }
  return out;
}

/* Each group's target units: its benchmark plus its share of the stretch (the
 * edition less the basket's median, negative when the basket reached more). A
 * cut a group cannot carry stops at zero and the rest falls on the others by
 * their shares, so the groups always sum to the edition (etl/build.py
 * allocate_stretch). */
export function allocateStretch(unitsByGroup, size, weights) {
  let units = byGroup(unitsByGroup, (_g, v) => v);
  const w = byGroup(weights, (_g, v) => Math.max(v, 0));
  for (let i = 0; i <= GROUPS.length; i += 1) {
    const gap = size - GROUPS.reduce((s, g) => s + units[g], 0);
    const tot = GROUPS.reduce((s, g) => s + w[g], 0);
    if (Math.abs(gap) < 1e-9 || tot <= 0) break;
    const out = byGroup(units, (g, v) => v + gap * w[g] / tot);
    const short = GROUPS.filter((g) => out[g] < -1e-9);
    if (!short.length) { units = out; break; }
    for (const g of short) { units[g] = 0; w[g] = 0; }
  }
  return units;
}

/* One clause on where the stretch comes from, for the cards: the shares the
 * Target setting tab placed, else the even uplift. `names` maps a group key
 * to its display name; `bm` is a snapshot's benchmark block. */
export function describeStretch(bm, names = {}) {
  if (!bm || !bm.stretchTyped) return "the same even uplift in every channel and on every day";
  const from = bm.stretchFrom || {}, kg = bm.kByGroup || {};
  const parts = GROUPS.filter((g) => num(from[g]) > 0).sort((a, b) => num(from[b]) - num(from[a]))
    .map((g) => `${names[g] || g} ${Math.round(num(from[g]) * 100)}% (×${num(kg[g]).toFixed(2)})`);
  return `placed on the Target setting tab: ${parts.join(", ")}; the other channels stay at their benchmark`;
}

/* The targets from a basket's medians (BENCHMARK_SPEC 4): one even uplift
 * K = sellout / median units carries every volume, conversion rates are held,
 * unless the stretch was placed (4.4), when each group carries its own.
 * `inp` is the release: edition_size, unit_price, cost_per_purchase (blank
 * means the basket's median cost per paid unit, else the panel's median),
 * units_per_buyer (the plan's rate, from the
 * snapshot), stretch_from (a share per group, blank for the even uplift).
 * `b` is etl/benchmarks.json. Returns the figures the rail prints,
 * each beside the benchmark it is lifted from - the basket's own median,
 * unscaled - so benchmark + stretch = target on every row. Null when the
 * profile has no median units to lift. */
export function benchmarkTargets(profile, inp, b) {
  const size = num(inp.edition_size);
  const median = num(profile.units);
  if (!(median > 0) || !(size > 0)) return null;
  const k = size / median;
  // the release's own entry -> order rate (Target setting), else the panel's:
  // the rate the whole page runs on (etl/build.py entry_rate)
  const ownRate = num(inp.entry_conversion_rate);
  const e2o = ownRate > 0 && ownRate <= 1 ? ownRate : (num(b.eligible_entry_to_order) || 0.8);
  const upb = num(inp.units_per_buyer) > 0 ? num(inp.units_per_buyer) : (num(profile.units_per_buyer) > 0 ? num(profile.units_per_buyer) : 1);
  const price = num(inp.unit_price);
  const maxPct = num(b.budget_sense_check_max_pct_of_launch_value);
  const ug = byGroup(profile.units_by_group, (_g, v) => v);
  const sg = byGroup(profile.sessions_by_group, (_g, v) => v);
  const bmPaid = ug.paid;
  const bmSessions = GROUPS.reduce((s, g) => s + sg[g], 0);
  const bmLaunchValue = median * price;
  // where the stretch comes from (4.4): each group's target is its benchmark
  // plus its share of the gap to the edition, its sessions at its own uplift;
  // the basket's own shares, the default, lift every group by K
  const weights = stretchWeights(inp, ug);
  const units = allocateStretch(ug, size, weights);
  const kg = byGroup(ug, (g, v) => (v > 0 ? units[g] / v : 0));
  const sessions = byGroup(sg, (g, v) => v * kg[g]);
  const paidUnits = units.paid;
  // the paid units asked for as entries and priced on the curve, or flat
  // where a figure was typed (paidPricing, etl/build.py paid_pricing); the
  // benchmark's budget is its paid units at the plan's average price per unit
  const pricing = paidPricing(profile, inp, b, paidUnits, e2o);
  const cpp = pricing.cost_per_purchase, cppSource = pricing.cost_source;
  const budget = pricing.budget, launchValue = size * price;
  const bmBudget = bmPaid * cpp;
  return {
    k, k_by_group: kg, stretch_from: weights, stretch_typed: stretchTyped(inp, ug), stretch_units: size - median,
    edition_size: size, cost_per_purchase: cpp, cost_per_purchase_source: cppSource, units_per_buyer: upb,
    units_by_group: units, sessions_by_group: sessions,
    paid_units: paidUnits, organic_units: size - paidUnits,
    buyers: size / upb,
    // every unit of the edition is asked for as an entry at the eligible-entry
    // rate (etl/build.py benchmark_targets): the whole edition over that rate
    entries_target: size / e2o,
    entry_rate: e2o,
    total_sessions: GROUPS.reduce((s, g) => s + sessions[g], 0),
    paid: {
      units: paidUnits, ...pricing,
      budget_pct_of_launch_value: launchValue > 0 ? budget / launchValue : null,
      sense_check_breached: launchValue > 0 ? budget / launchValue > maxPct : false,
    },
    launch_value: launchValue,
    benchmark: {
      units: median, units_sold: num(profile.units_sold) || median, n_short: num(profile.n_short), paid_units: bmPaid,
      // the basket's median units asked for as entries the way the target is,
      // so the row keeps the K ratio like every other; the basket's measured
      // median entries stay on the snapshot as data (benchmark.entries)
      buyers: median / upb, entries: median / e2o, sessions: bmSessions,
      paid_budget: bmBudget, budget_pct_of_launch_value: bmLaunchValue > 0 ? bmBudget / bmLaunchValue : null,
    },
  };
}
