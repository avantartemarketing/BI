/* Signup conversions (assumed): a timed launch's page before its window, read
 * in the signups expected to buy and not in signups (25 November 2026, asked
 * by the repository owner). Counted in signups, paid looks far bigger than it
 * is, because a paid signup goes on to order far less often than one from an
 * email or a post; here every channel's signups are weighted by the share of
 * that channel's signups the basket's launches saw order
 * (targets.signup_order_rate_by_group, docs/TL_SPEC.md 3), so the channels
 * stand at what they are worth and the target is the orders the launch needs
 * from its signups (targets.orders_needed).
 *
 * The page's figures are sums over the channel groups, so the reading is one
 * weight a group laid over the view the page has already chosen (as the feed
 * attributes Direct, with Direct spread, or the plan-based one): the channels
 * and their daily paths, the headline, the gap's drivers, the plan card's
 * rows and the suggested actions' sizes. The paid cards keep their own terms
 * (cost per signup, return on spend), which already carry paid's own rate.
 * Nothing is stored: the switch at the top of the page turns it on and off.
 * Plain JavaScript, no JSX, so the tests can import it. */
import { closeWalk } from "./figures.mjs";

export const GROUPS = ["aa_email", "aa_social", "referral_artist", "organic_search", "direct_other", "paid"];
const WHO = { email: "aa_email", aa: "aa_social", artist: "referral_artist", partner: "referral_artist", search: "organic_search", other: "direct_other", paid: "paid" };
const CHANNEL = { Email: "aa_email", "AA Email": "aa_email", "AA Social": "aa_social", Artist: "referral_artist", Partner: "referral_artist", Paid: "paid" };
const CONTRIB = ["contrib_traffic", "contrib_conversion", "contrib_buyers", "contrib_per_buyer", "contrib_traffic_bm", "contrib_conversion_bm", "contrib_buyers_bm", "contrib_per_buyer_bm"];
const num = (v) => typeof v === "number" && Number.isFinite(v);
const sum = (a) => a.reduce((t, v) => t + (num(v) ? v : 0), 0);

/* Whether the page can be read this way: a timed launch gathering signups
 * whose targets carry a rate for paid and for a channel beside it. */
export function canConvert(snap) {
  return !!(snap && snap.type === "TL" && snap.tlState === "signups" && conversionRates(snap));
}

/* The weight on each group's signups: its own rate (the blended one where the
 * basket has none for it), times the one factor that keeps the target at the
 * orders the launch needs, whichever way Direct is shown (spread over the
 * other channels, Direct's signups would otherwise take those channels'
 * rates and the target would move with the Display menu). */
export function conversionRates(view) {
  const t = (view && view.targets) || {};
  const by = t.signup_order_rate_by_group || {};
  const blended = num(t.signup_order_rate) && t.signup_order_rate > 0 ? t.signup_order_rate : (num(t.signup_order_rate_median) ? t.signup_order_rate_median : 0);
  const raw = {};
  for (const g of GROUPS) raw[g] = num(by[g]) && by[g] > 0 ? by[g] : blended;
  if (!(raw.paid > 0) || !GROUPS.some((g) => g !== "paid" && raw[g] > 0)) return null;
  const sg = t.signups_by_group || {};
  const weighted = sum(GROUPS.map((g) => (num(sg[g]) ? sg[g] : 0) * raw[g]));
  const k = num(t.orders_needed) && t.orders_needed > 0 && weighted > 0 ? t.orders_needed / weighted : 1;
  const rates = {};
  for (const g of GROUPS) rates[g] = raw[g] * k;
  return { rates, blended: blended * k || rates.paid, target: num(t.orders_needed) && t.orders_needed > 0 ? t.orders_needed : null };
}

const scaleKeys = (o, keys, r) => { const out = { ...o }; for (const k of keys) if (num(o[k])) out[k] = o[k] * r; return out; };

function channelsOf(view, R) {
  return (view.channels || []).map((c) => {
    const r = R.rates[c.key] ?? R.blended;
    const out = scaleKeys(c, ["now", "exp", "proj", "target", "bm", "bmExp"], r);
    if (Array.isArray(c.parts)) out.parts = c.parts.map((p) => scaleKeys(p, ["value"], r));
    if (Array.isArray(c.daily)) out.daily = c.daily.map((d) => scaleKeys(d, ["actual", "plan", "proj", "bm"], r));
    return out;
  });
}

/* the plan card's rows: every piece at its channel's weight, a row the sum of its pieces; what the plan leaves
 * of the target is worked out again in this unit */
function planOf(plan, R, target, byToday) {
  if (!plan || !Array.isArray(plan.rows)) return plan;
  const keys = ["expected", "in", "toCome"];
  const rows = plan.rows.filter((r) => r.moment !== "Not covered").map((r) => {
    const pieces = (r.pieces || []).map((x) => scaleKeys(x, keys, R.rates[WHO[x.who]] ?? R.blended));
    const out = pieces.length ? { ...r, pieces } : scaleKeys(r, keys, R.blended);
    if (pieces.length) for (const k of keys) out[k] = sum(pieces.map((x) => x[k]));
    out.lands = (out.in || 0) + (out.toCome || 0);
    return out;
  });
  const tot = (k) => sum(rows.map((r) => r[k]));
  const expected = tot("expected");
  const ratio = plan.expected > 0 ? expected / plan.expected : R.blended;
  const range = Array.isArray(plan.range) ? plan.range.map((v) => (num(v) ? v * ratio : v)) : plan.range;
  // the plan check's verdict, read again in this unit (as etl/plan_view.py reads it: in line when the target sits
  // inside the range). The weights move the plan and the target by different amounts, a plan heavy on email being
  // worth more conversions than its signups say, so the signups' verdict can sit against the figures printed beside it
  const ranged = Array.isArray(range) && num(range[0]) && num(range[1]);
  const against = plan.against && ranged ? (target - range[1] >= 0.5 ? "short" : range[0] - target >= 0.5 ? "over" : "in line") : plan.against;
  const left = against === "short" ? Math.max(target - expected, 0) : 0;
  const was = plan.rows.find((r) => r.moment === "Not covered") || { moment: "Not covered", pieces: [], note: "The part of the target that nothing in the plan covers." };
  if (left >= 0.5) rows.push({ ...was, expected: left, in: 0, toCome: 0, lands: 0 });
  const lands = plan.state === "start" ? expected : tot("lands");
  return {
    ...plan, rows, target, expected, in: tot("in"), toCome: tot("toCome"), lands, byToday, range, against,
    landsRecommended: num(plan.landsRecommended) && num(plan.lands) ? lands + (plan.landsRecommended - plan.lands) * R.rates.paid : plan.landsRecommended,
    notCovered: left >= 0.5 ? left : 0, of: "conversions",
  };
}

const sized = (c, R) => {
  const r = R.rates[CHANNEL[c.channel]] ?? R.blended;
  const u = (x) => (x && num(x.low) && num(x.high) ? { ...x, low: x.low * r, high: x.high * r } : x);
  const out = { ...c, units: u(c.units) };
  for (const k of ["alternatives", "alts"]) if (Array.isArray(c[k])) out[k] = c[k].map((a) => ({ ...a, units: u(a.units) }));
  return out;
};

/* the gap's four drivers at the channels' weights: organic traffic and conversion from each organic channel's
 * own share of them, paid's two at paid's rate, closed onto the gap the card prints as the build closes its own */
function driversOf(steps, fbg, R, sfx, start, outcome) {
  if (!Array.isArray(steps)) return steps;
  const organic = GROUPS.filter((g) => g !== "paid");
  const share = (key, field) => {
    const raw = sum(organic.map((g) => (fbg[g] || {})[field + sfx]));
    const w = sum(organic.map((g) => ((fbg[g] || {})[field + sfx] || 0) * R.rates[g]));
    const s = steps.find((x) => x.key === key);
    return s ? (raw !== 0 ? (s.value || 0) * (w / raw) : (s.value || 0) * R.blended) : 0;
  };
  const kept = steps.filter((s) => s.key !== "oversubscribed");
  const vals = kept.map((s) => (s.key === "organic_traffic" ? share(s.key, "contrib_traffic") : s.key === "organic_conversion" ? share(s.key, "contrib_conversion")
    : (s.value || 0) * (s.key === "paid_spend" || s.key === "paid_efficiency" ? R.rates.paid : R.blended)));
  const whole = closeWalk(vals, Math.round(start), Math.round(outcome), 0, { whole: true });
  return kept.map((s, i) => ({ ...s, value: whole[i] }));
}

/* The view in signup conversions. `view` is the page as ReleasePage has
 * chosen it; a page this reading does not fit comes back as it is. */
export function toConversions(view) {
  const R = canConvert(view) ? conversionRates(view) : null;
  if (!R) return view;
  const channels = channelsOf(view, R);
  const tot = (k) => sum(channels.map((c) => c[k]));
  const anyBm = channels.some((c) => num(c.bm));
  const planMode = view.method === "plan" && !!view.plan;
  const target = planMode && R.target ? R.target : tot("target");
  const now = tot("now"), exp = tot("exp");
  const plan = planMode ? planOf(view.plan, R, target, exp) : view.plan;
  const projected = planMode ? plan.lands : tot("proj");
  const bm = anyBm ? tot("bm") : null, bmToday = anyBm ? tot("bmExp") : null;
  const h = view.hero || {};
  const hero = {
    ...h, now, unique: now, expectedToday: exp, delta: now - exp, projected, target,
    statusPct: exp > 0 ? now / exp - 1 : 0, benchmark: bm, benchmarkToday: bmToday,
    benchmarkPct: bmToday > 0 ? now / bmToday - 1 : null, stretch: bm !== null ? target - bm : null,
    preAnnounce: num(h.preAnnounce) && h.now > 0 ? h.preAnnounce * (now / h.now) : h.preAnnounce,
  };
  let waterfall = view.waterfall;
  if (waterfall) {
    const fbg = view.funnelByGroup || {};
    const td = waterfall.today;
    waterfall = { ...waterfall, target: Math.round(target), projection: Math.round(projected) };
    if (planMode) {
      const steps = [{ key: "plan", label: "The plan against the target", value: plan.expected - target },
        ...plan.rows.map((r) => ({ key: r.moment, label: r.moment, value: r.lands - r.expected }))];
      const whole = closeWalk(steps.map((s) => s.value), Math.round(target), Math.round(projected), 0, { whole: true });
      waterfall.steps = steps.map((s, i) => ({ ...s, value: whole[i] }));
    } else {
      waterfall.steps = driversOf(waterfall.steps, fbg, R, "", target, projected);
    }
    if (bm !== null && Array.isArray(waterfall.stepsBm)) {
      waterfall.benchmark = Math.round(bm);
      waterfall.stretch = Math.round(target) - Math.round(bm);
      waterfall.stepsBm = driversOf(waterfall.stepsBm, fbg, R, "_bm", bm, projected);
    }
    if (td) {
      waterfall.today = { ...td, target: Math.round(exp), actual: Math.round(now), steps: driversOf(td.steps, fbg, R, "", exp, now) };
      if (bmToday !== null && Array.isArray(td.stepsBm)) {
        Object.assign(waterfall.today, { benchmark: Math.round(bmToday), stretch: Math.round(exp) - Math.round(bmToday), stepsBm: driversOf(td.stepsBm, fbg, R, "_bm", bmToday, now) });
      }
    }
  }
  // the funnel table's second view: each channel's signups added or lost, at its weight
  const fb = view.funnelByGroup;
  const funnelByGroup = fb ? Object.fromEntries(Object.entries(fb).map(([g, v]) => [g, scaleKeys(v || {}, CONTRIB, R.rates[g] ?? R.blended)])) : fb;
  const pc = view.planChanges;
  const planChanges = pc ? { ...pc, changes: (pc.changes || []).map((c) => sized(c, R)), more: (pc.more || []).map((c) => sized(c, R)) } : pc;
  return { ...view, countAs: "conversions", conversionRates: R.rates, channels, hero, waterfall, funnelByGroup, plan, planChanges };
}
