/* The timed-launch target model, JS side (docs/TL_SPEC.md §7). Mirrors
 * etl/tl.py apply_channels_off, stretch_weights, allocate_stretch and
 * tl_targets to the figure, so the Target setting header can answer as the
 * boxes are typed and say what the build will say; tests/test_tl_model.py
 * holds the two together over the panel's own baskets.
 *
 *   orders needed     = units target / purchases per order
 *   signup target     = orders needed / signup -> order rate
 *   group targets     = the basket's group benchmarks plus their share of the stretch
 *   sessions needed   = group signup target / session -> signup rate
 *   pre-window budget = paid signup target x cost per signup
 *   in-window budget  = paid share of units x units target x cost per sale
 *
 * The signup -> order rate, when not typed, is the rate the basket's mix of
 * signups converts at: each group's own median rate weighted by the basket's
 * share of signups from it (a paid signup converts at a fraction of an email
 * one), else the basket's overall median. A profile is the basket's medians
 * as etl/tl.py basket_profile writes them (the snapshot carries it under
 * benchmark.profile, already read with the channels off applied; the *_all
 * fields hold the full medians). */
export const GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"];
export const TL_CANNIBALISATION = 0.1;
export const TL_PAID_SPLIT_PRE = 0.7;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const byGroup = (src, f) => Object.fromEntries(GROUPS.map((g) => [g, f(g, num((src || {})[g]))]));

export function channelsOffOf(inp) {
  let raw = (inp && inp.channels_off) || [];
  if (typeof raw === "string") raw = [raw];
  const wanted = new Set(raw.map((g) => String(g).trim()));
  return GROUPS.filter((g) => wanted.has(g));
}

/* The full medians a snapshot's profile was read from, before any channel was set aside. */
export function fullProfile(profile) {
  if (!profile) return null;
  const p = { ...profile };
  if (profile.signups_by_group_all) {
    p.signups = num(profile.signups_all); p.sessions = num(profile.sessions_all); p.units = num(profile.units_all);
    p.signups_by_group = { ...profile.signups_by_group_all };
    p.sessions_by_group = { ...profile.sessions_by_group_all };
    p.units_by_group = { ...profile.units_by_group_all };
    const shares = (src) => { const tot = GROUPS.reduce((s, g) => s + num(src[g]), 0); return byGroup(src, (_g, v) => (tot > 0 ? v / tot : 0)); };
    p.share_signups = shares(p.signups_by_group); p.share_sessions = shares(p.sessions_by_group); p.share_units = shares(p.units_by_group);
    p.conv = { ...(profile.conv_all || profile.conv) };
    p.signup_order_rate_by_group = { ...(profile.signup_order_rate_by_group_all || profile.signup_order_rate_by_group) };
  }
  delete p.channels_off;
  return p;
}

export function applyChannelsOff(profile, off) {
  const set = new Set(off || []);
  const out = { ...profile, channels_off: GROUPS.filter((g) => set.has(g)) };
  out.signups_all = num(profile.signups); out.sessions_all = num(profile.sessions); out.units_all = num(profile.units);
  out.signups_by_group_all = byGroup(profile.signups_by_group, (_g, v) => v);
  out.sessions_by_group_all = byGroup(profile.sessions_by_group, (_g, v) => v);
  out.units_by_group_all = byGroup(profile.units_by_group, (_g, v) => v);
  if (!out.channels_off.length) return out;
  const keep = GROUPS.filter((g) => !set.has(g));
  for (const [key, tot] of [["signups_by_group", "signups"], ["sessions_by_group", "sessions"], ["units_by_group", "units"]]) {
    out[key] = byGroup(profile[key], (g, v) => (set.has(g) ? 0 : v));
    out[tot] = keep.reduce((s, g) => s + out[key][g], 0);
  }
  for (const key of ["share_signups", "share_sessions", "share_units"]) {
    const raw = byGroup(profile[key], (g, v) => (set.has(g) ? 0 : v));
    const t = GROUPS.reduce((s, g) => s + raw[g], 0);
    out[key] = byGroup(raw, (_g, v) => (t > 0 ? v / t : 0));
  }
  out.conv = byGroup(profile.conv, (g, v) => (set.has(g) ? 0 : v));
  out.signup_order_rate_by_group = byGroup(profile.signup_order_rate_by_group, (g, v) => (set.has(g) ? 0 : v));
  out.paid_share_signups = out.share_signups.paid;
  out.paid_share_units = out.share_units.paid;
  return out;
}

export function stretchWeights(inp, bmByGroup) {
  const bm = byGroup(bmByGroup, (_g, v) => v);
  const total = GROUPS.reduce((s, g) => s + (bm[g] > 0 ? bm[g] : 0), 0);
  const even = byGroup(bm, (_g, v) => (total > 0 && v > 0 ? v / total : 0));
  const raw = inp && inp.stretch_from;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return even;
  const w = byGroup(bm, (g, v) => (v > 0 ? Math.max(num(raw[g]), 0) : 0));
  const s = GROUPS.reduce((t, g) => t + w[g], 0);
  return s > 0 ? byGroup(w, (_g, v) => v / s) : even;
}

export function allocateStretch(bmByGroup, size, weights) {
  const total = GROUPS.reduce((s, g) => s + num(bmByGroup[g]), 0);
  const gap = size - total;
  return byGroup(bmByGroup, (g, v) => Math.max(v + num(weights[g]) * gap, 0));
}

/* The targets, or null without a units target. `airtableUnits` is Airtable's
 * units target summed over the ticked works; `launchValue` prices the sense
 * check; `b` holds budget_sense_check_max_pct_of_launch_value. */
export function tlTargets(inp, airtableUnits, profile, launchValue, b = {}) {
  inp = inp || {};
  const units = num(inp.units_target) > 0 ? num(inp.units_target) : num(airtableUnits);
  if (!(units > 0)) return null;
  const ppoTyped = num(inp.purchases_per_order);
  const ppo = ppoTyped > 0 ? ppoTyped : (num(profile.purchases_per_order) || 1);
  const s2oTyped = num(inp.signup_order_rate);
  const byG = profile.signup_order_rate_by_group || {};
  const shares = profile.share_signups || {};
  const rated = GROUPS.filter((g) => num(byG[g]) > 0 && num(shares[g]) > 0);
  const ratedShare = rated.reduce((s, g) => s + num(shares[g]), 0);
  const blended = rated.length && ratedShare > 0 ? rated.reduce((s, g) => s + num(shares[g]) * num(byG[g]), 0) / ratedShare : 0;
  const typedOk = s2oTyped > 0 && s2oTyped <= 1;
  const s2oSrc = typedOk ? "release" : blended > 0 ? "basket_mix" : num(profile.signup_order_rate) > 0 ? "basket" : "none";
  const s2o = typedOk ? s2oTyped : (blended || num(profile.signup_order_rate) || 0);
  const orders = units / ppo;
  const signupTarget = s2o > 0 ? orders / s2o : null;
  const bmSignups = num(profile.signups);
  const bmByGroup = byGroup(profile.signups_by_group, (_g, v) => v);
  const weights = stretchWeights(inp, bmByGroup);
  const groups = signupTarget !== null ? allocateStretch(bmByGroup, signupTarget, weights) : byGroup(bmByGroup, () => 0);
  const k = signupTarget !== null && bmSignups > 0 ? signupTarget / bmSignups : null;
  const conv = profile.conv || {};
  const sessions = byGroup(groups, (g, v) => (num(conv[g]) > 0 ? v / num(conv[g]) : null));
  const cpsTyped = num(inp.cost_per_signup);
  const cps = cpsTyped > 0 ? cpsTyped : num(profile.cost_per_signup);
  const cpsSrc = cpsTyped > 0 ? "release" : num(profile.cost_per_signup) > 0 ? "basket" : "none";
  const cpuTyped = num(inp.cost_per_purchase);
  const cpu = cpuTyped > 0 ? cpuTyped : num(profile.cost_per_sale);
  const cpuSrc = cpuTyped > 0 ? "release" : num(profile.cost_per_sale) > 0 ? "basket" : "none";
  const paidUnits = num((profile.share_units || {}).paid) * units;
  // paid set aside: no paid signups, no paid units, no budget at all
  const paidOff = (profile.channels_off || []).includes("paid");
  const budgetPre = cps > 0 && !paidOff ? groups.paid * cps : null;
  const budgetWin = cpu > 0 && !paidOff ? paidUnits * cpu : null;
  const total = (budgetPre || 0) + (budgetWin || 0);
  const maxPct = num(b.budget_sense_check_max_pct_of_launch_value) || 0.06;
  const anyBudget = budgetPre !== null || budgetWin !== null;
  const sessionsNeeded = GROUPS.some((g) => sessions[g] !== null) ? GROUPS.reduce((s, g) => s + (sessions[g] || 0), 0) : null;
  return {
    units_target: units, units_target_source: num(inp.units_target) > 0 ? "release" : "airtable",
    purchases_per_order: ppo, purchases_per_order_source: ppoTyped > 0 ? "release" : num(profile.purchases_per_order) > 0 ? "basket" : "default",
    signup_order_rate: s2o, signup_order_rate_source: s2oSrc, signup_order_rate_by_group: byGroup(byG, (_g, v) => v),
    signup_order_rate_median: num(profile.signup_order_rate),
    orders_needed: orders, signup_target: signupTarget, k,
    stretch_from: weights,
    stretch_typed: !!(inp.stretch_from && typeof inp.stretch_from === "object" && Object.values(inp.stretch_from).some((v) => num(v) > 0)),
    signups_by_group: groups, sessions_by_group: sessions, sessions_needed: sessionsNeeded,
    paid_signups: groups.paid, paid_units: paidUnits,
    cost_per_signup: cps > 0 ? cps : null, cost_per_signup_source: cpsSrc,
    cost_per_sale: cpu > 0 ? cpu : null, cost_per_sale_source: cpuSrc,
    budget_pre: budgetPre, budget_window: budgetWin, budget_total: anyBudget ? total : null,
    budget_pct_of_launch_value: launchValue > 0 && anyBudget ? total / launchValue : null,
    sense_check_breached: !!(launchValue > 0 && anyBudget && total / launchValue > maxPct),
    cannibalisation: inp.cannibalisation === null || inp.cannibalisation === undefined || inp.cannibalisation === "" ? TL_CANNIBALISATION : num(inp.cannibalisation),
    benchmark: { signups: bmSignups, signups_by_group: bmByGroup, sessions: num(profile.sessions), units: num(profile.units),
                 paid_signups: bmByGroup.paid, budget_pre: cps > 0 ? bmByGroup.paid * cps : null },
  };
}

/* The Target setting tab's sliders, as shared/benchmarkModel.mjs rebalanceShares. */
export { rebalanceShares } from "./benchmarkModel.mjs";
