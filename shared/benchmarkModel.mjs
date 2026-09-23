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
 * them: units, sessions, entries, units_p25, units_p75, units_by_group,
 * sessions_by_group, share_units, share_sessions, conv.
 * The snapshot's benchmark block carries the same figures under camel-case
 * names, with the basket's full medians as the *All fields; profileOf turns
 * that block back into a profile so the switches can be re-read in place.
 */
export const GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
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
    units_all: num(profile.units), sessions_all: num(profile.sessions), entries_all: num(profile.entries),
    units_by_group_all: unitsAll, sessions_by_group_all: sessAll,
  };
  if (!offList.length) return out;
  const keep = GROUPS.filter((g) => !set.has(g));
  const units = keep.reduce((s, g) => s + unitsAll[g], 0);
  const sessions = keep.reduce((s, g) => s + sessAll[g], 0);
  const ratio = out.units_all > 0 ? units / out.units_all : 0;
  out.units = units;
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
    units_p25: num(bm.unitsP25All ?? bm.unitsP25), units_p75: num(bm.unitsP75All ?? bm.unitsP75),
    price: num(bm.price), price_p25: num(bm.priceP25), price_p75: num(bm.priceP75), n_priced: num(bm.nPriced),
    campaign_days: num(bm.campaignDays),
    units_by_group: byGroup(unitsByGroup, (_g, v) => v), sessions_by_group: byGroup(sessByGroup, (_g, v) => v),
    share_units: shares(unitsByGroup), share_sessions: shares(sessByGroup),
    conv: byGroup(bm.convByGroupAll || bm.convByGroup, (_g, v) => v),
    units_per_buyer: num(bm.unitsPerBuyer),
  };
}

/* The targets from a basket's medians (BENCHMARK_SPEC 4): one even uplift
 * K = sellout / median units carries every volume, conversion rates are held.
 * `inp` is the release: edition_size, unit_price, cost_per_purchase (blank
 * means the panel's median), units_per_buyer (the plan's rate, from the
 * snapshot). `b` is etl/benchmarks.json. Returns the figures the rail prints,
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
  const own = num(inp.entry_conversion_rate);
  const e2o = own > 0 && own <= 1 ? own : (num(b.eligible_entry_to_order) || 0.8);
  // what a paid unit costs to buy: the release's own figure, else the panel's
  // median (etl/build.py cost_per_purchase_for)
  const cpp = num(inp.cost_per_purchase) > 0 ? num(inp.cost_per_purchase) : num((b.cost_per_purchase || {}).Median);
  const upb = num(inp.units_per_buyer) > 0 ? num(inp.units_per_buyer) : (num(profile.units_per_buyer) > 0 ? num(profile.units_per_buyer) : 1);
  const price = num(inp.unit_price);
  const maxPct = num(b.budget_sense_check_max_pct_of_launch_value);
  const ug = byGroup(profile.units_by_group, (_g, v) => v);
  const sg = byGroup(profile.sessions_by_group, (_g, v) => v);
  const bmPaid = ug.paid;
  const bmSessions = GROUPS.reduce((s, g) => s + sg[g], 0);
  const bmBudget = bmPaid * cpp, bmLaunchValue = median * price;
  const paidUnits = bmPaid * k;
  const budget = bmBudget * k, launchValue = size * price;
  return {
    k, edition_size: size, cost_per_purchase: cpp, units_per_buyer: upb,
    units_by_group: byGroup(ug, (_g, v) => v * k), sessions_by_group: byGroup(sg, (_g, v) => v * k),
    paid_units: paidUnits, organic_units: size - paidUnits,
    buyers: size / upb,
    // every unit of the edition is asked for as an entry at the eligible-entry
    // rate (etl/build.py benchmark_targets): the whole edition over that rate
    entries_target: size / e2o,
    entry_rate: e2o,
    total_sessions: bmSessions * k,
    paid: {
      units: paidUnits, budget,
      budget_pct_of_launch_value: launchValue > 0 ? budget / launchValue : null,
      sense_check_breached: launchValue > 0 ? budget / launchValue > maxPct : false,
    },
    launch_value: launchValue,
    benchmark: {
      units: median, paid_units: bmPaid,
      // the basket's median units asked for as entries the way the target is,
      // so the row keeps the K ratio like every other; the basket's measured
      // median entries stay on the snapshot as data (benchmark.entries)
      buyers: median / upb, entries: median / e2o, sessions: bmSessions,
      paid_budget: bmBudget, budget_pct_of_launch_value: bmLaunchValue > 0 ? bmBudget / bmLaunchValue : null,
    },
  };
}
