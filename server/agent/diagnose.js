/* The diagnosis sheet: the evidence the diagnosis skill works from
 * (server/agent/skills/diagnose.md).
 *
 * A diagnosis walks a launch's funnel stage by stage and finds where it first
 * falls away. The reading is the model's; the arithmetic is not left to it.
 * This lays the stages out once, in order, each with the launch's figure so
 * far beside what to hold it against:
 *   - the plan: what the targets expect by now (the page's own figures);
 *   - similar past launches: the reference launches the targets were set from,
 *     by the same point of their campaigns (the page's own, and the launches'
 *     days for what the page does not carry);
 *   - the artist's own earlier launches at the same point, from the launches'
 *     days (data/app/funnel_daily.csv, tl_funnel_daily.csv; etl/funnel_daily.py).
 * "The same point" is the same share of the campaign gone, the rule the build
 * reads a basket by (etl/build.py page_funnel_member_window), with the part of
 * today not yet seen taken off, so a morning is not set against a whole day.
 *
 * Every figure is read off the page's snapshot as the reader sees it (their
 * Direct display applied) or summed from the tables: nothing here estimates.
 * A stage's `read` is a first pass on fixed thresholds, for the model to weigh.
 * Read-only, like everything the Agent can reach. */
"use strict";

const WELL_SHORT = 0.7, SHORT = 0.9, AHEAD = 1.15;   // a figure against its yardstick: under 70%, under 90%, over 115%
const MIN_VISITS = 30;     // a rate is read over at least this many visits (the page funnel's own floor, build.py)
const MAX_EARLIER = 4;     // the artist's earlier launches laid out, newest first
const MAX_SENDS = 10;      // the launch's latest sends listed
const PAID_START_DAYS = 1; // ads are planned from the day after the announce (build.py)

const num = (v) => (typeof v === "number" ? (isFinite(v) ? v : null) : v === null || v === undefined || v === "" || !isFinite(Number(v)) ? null : Number(v));
const rnd = (v, d = 0) => { const x = num(v); if (x === null) return undefined; const k = 10 ** d; return Math.round(x * k) / k; };
const frac = (v) => rnd(v, 4);                       // a rate, as a fraction of one
const div = (a, b) => (num(a) !== null && num(b) > 0 ? num(a) / num(b) : null);
const artistOf = (name) => String(name || "").split(" · ")[0].trim().toLowerCase();
/* "Harland Miller · York So Good They Named It Once · 2025 Q2" -> "York So Good They Named It Once (2025 Q2)" */
function shortName(name) {
  const parts = String(name || "").split(" · ").map((s) => s.trim());
  if (parts.length < 3) return String(name || "");
  return `${parts.slice(1, -1).join(" · ")} (${parts[parts.length - 1]})`;
}
const median = (xs) => { const s = xs.filter((x) => num(x) !== null).map(Number).sort((a, b) => a - b); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/* how a figure stands against a yardstick, in a word or two; `of` is the visits a rate was read over */
function reading(now, ref, { of, floor } = {}) {
  const a = num(now), b = num(ref);
  if (a === null || b === null || !(b > 0)) return undefined;
  if (of !== undefined && (num(of) === null || num(of) < MIN_VISITS)) return "too few to read";
  if (floor !== undefined && b < floor && a < floor) return "too few to read";
  const r = a / b;
  return r < WELL_SHORT ? "well short" : r < SHORT ? "short" : r <= AHEAD ? "in line" : "ahead";
}

/* drop what is empty, so the sheet carries only what it knows */
function clean(v) {
  if (Array.isArray(v)) { const a = v.map(clean).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = clean(x); if (c !== undefined) o[k] = c; }
    return Object.keys(o).length ? o : undefined;
  }
  return v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v)) ? undefined : v;
}

/* ------------------------------------------------------------ the launches' days
 * A day-by-day table by release, with each launch's announce and length, kept beside the parsed table for as long
 * as the table itself is (server/agent/tools.js keeps it until its file changes). */
const indexes = new WeakMap();
function dailyIndex(tools, name) {
  let t;
  try { t = tools.loadTable(name); } catch { return null; }
  const hit = indexes.get(t);
  if (hit) return hit;
  const ix = Object.fromEntries(t.columns.map((c, i) => [c, i]));
  if (ix.release === undefined || ix.day === undefined || ix.date === undefined) return null;
  const by = new Map();
  for (const r of t.rows) { let a = by.get(r[ix.release]); if (!a) by.set(r[ix.release], a = []); a.push(r); }
  const meta = new Map();
  for (const [rel, rows] of by) {
    const d = new Date(rows[0][ix.date] + "T00:00:00Z");
    if (isNaN(d)) continue;
    d.setUTCDate(d.getUTCDate() - Number(rows[0][ix.day]));
    meta.set(rel, { announce: d.toISOString().slice(0, 10), of: Number(rows[0][ix.of]) });
  }
  const out = { ix, by, meta };
  indexes.set(t, out);
  return out;
}

const SUMS = { LE: ["visits", "entrants", "eligible", "entries", "units"], TL: ["visits", "signups", "orders", "units"] };
const PAGE = ["release_page_visits", "went_to_product", "product_page_visits", "entered_from_product"];

/* A launch's days added up over the rows `keep` lets through: the totals, the channels as the reader's page shows
 * them (Direct spread over the others, or left in Other), and on a draw launch the steps through its pages for
 * ads and for everything else. Null for a launch the table has no rows for. */
function tally(idx, release, keep, kind, spreadOn) {
  const rows = idx && idx.by.get(release);
  if (!rows) return null;
  const { ix } = idx;
  const main = kind === "TL" ? "signups" : "entries";
  const tot = Object.fromEntries(SUMS[kind].map((c) => [c, 0]));
  const ch = new Map();
  const add = (name, v, m, u) => { let a = ch.get(name); if (!a) ch.set(name, a = { visits: 0, main: 0, units: 0 }); a.visits += v; a.main += m; a.units += u; };
  const page = { organic: [0, 0, 0, 0], paid: [0, 0, 0, 0] };
  let n = 0;
  for (const r of rows) {
    if (!keep(r)) continue;
    n += 1;
    for (const c of SUMS[kind]) tot[c] += Number(r[ix[c]]) || 0;
    const name = r[ix.channel];
    if (spreadOn) add(name, Number(r[ix.visits_spread]) || 0, Number(r[ix[`${main}_spread`]]) || 0, Number(r[ix.units_spread]) || 0);
    else add(name === "Direct" ? "Other" : name, Number(r[ix.visits]) || 0, Number(r[ix[main]]) || 0, Number(r[ix.units]) || 0);
    if (kind === "LE" && name !== "Untracked" && ix[PAGE[0]] !== undefined) {
      const side = name === "Paid" ? page.paid : page.organic;
      PAGE.forEach((c, i) => { side[i] += Number(r[ix[c]]) || 0; });
    }
  }
  if (!n) return { ...tot, rows: 0, byChannel: {}, pages: null };
  // with Direct as a channel a draw launch's page still shares Untracked out; a timed launch's keeps it apart
  if (!spreadOn && kind === "LE" && ch.has("Untracked")) {
    const u = ch.get("Untracked");
    ch.delete("Untracked");
    for (const f of ["visits", "main", "units"]) {
      const rest = [...ch.values()].reduce((a, x) => a + x[f], 0);
      if (rest > 0) for (const x of ch.values()) x[f] += u[f] * x[f] / rest;
    }
  }
  const byChannel = {};
  for (const [name, a] of ch) if (a.visits > 0.5 || a.main > 0.05 || a.units > 0.05) byChannel[name] = { visits: rnd(a.visits), [main]: rnd(a.main, 1), units: rnd(a.units, 1) };
  // a step nobody took carries no rate: a launch of one work has no release page to speak of
  const step = (through, visits) => (visits >= MIN_VISITS && through > 0 ? { rate: frac(through / visits), of: visits } : { of: visits });
  const side = (s) => ({ toAWork: step(s[1], s[0]), entered: step(s[3], s[2]) });
  return { ...tot, rows: n, byChannel, pages: kind === "LE" ? { organic: side(page.organic), paid: side(page.paid) } : null };
}

/* the share of this launch's campaign gone, as the build reads today on the clock: the part of today not yet seen
 * comes off, and a campaign that has closed is whole */
function shareGone(day, of, seen, complete) {
  const d = num(day), l = num(of);
  if (complete) return 1;
  if (d === null || !(l > 0)) return null;
  const part = num(seen) !== null && seen < 1 ? 1 - seen : 0;
  return Math.max(0, Math.min(1, (d - part) / l));
}

/* an earlier launch's days up to the same share of its own campaign (every day once this campaign is whole) */
function upTo(idx, release, share) {
  const m = idx.meta.get(release);
  const { ix } = idx;
  if (share === null || share >= 1 || !m || !(m.of > 0)) return { keep: () => true, point: "its whole campaign", day: null };
  const day = Math.round(share * m.of);
  return { keep: (r) => Number(r[ix.day]) <= day, point: `day ${day} of ${m.of}`, day };
}

function createDiagnose({ tools, readSnapshot }) {
  const indexRow = (name) => (tools.readIndex().releases || []).find((r) => r.releaseName === name) || null;

  /* what is known of an earlier launch beyond its days: its edition, price and where it ended */
  function facts(name, members, panel) {
    const row = indexRow(name);
    let snap = null;
    try { snap = row && readSnapshot ? readSnapshot(row.id) : null; } catch { snap = null; }
    const member = (members || []).find((m) => m.name === name) || {};
    const p = panel && panel.get(name);
    const edition = num(snap && snap.edition && snap.edition.total) ?? num(snap && snap.sellthrough && snap.sellthrough.editionSum) ?? num(p && p.edition) ?? num(snap && snap.economics && snap.economics.edition_size);
    const price = num(member.price) ?? num(snap && snap.economics && (snap.economics.unitPrice ?? snap.economics.unit_price_eur)) ?? num(p && p.price);
    return { id: row && row.id, edition, price, units: num(snap && snap.hero && snap.hero.now) ?? num(member.units) ?? num(p && p.units), closed: row ? row.windowEnd || row.windowClose : undefined };
  }

  /* release_clusters and tl_panel by release name, for an earlier launch's edition, price and totals */
  function panelOf(kind) {
    const out = new Map();
    try {
      const t = tools.loadTable(kind === "TL" ? "tl_panel" : "release_clusters");
      const ix = Object.fromEntries(t.columns.map((c, i) => [c, i]));
      for (const r of t.rows) {
        const g = (c) => (ix[c] === undefined ? null : num(r[ix[c]]));
        out.set(r[ix.release_name], kind === "TL"
          ? { edition: g("edition_size"), price: g("unit_price_eur"), units: g("units"), signups: g("signups"), signupToOrder: g("signup_order_rate"), costPerSignup: g("cost_per_signup"), windowHours: g("window_hours") }
          : { edition: g("edition_size"), price: g("unit_price_eur"), units: g("tot_total_product_units") });
      }
    } catch { /* a server without the panel: the facts come from the pages alone */ }
    return out;
  }

  /* The launches to hold this one against, read from their own days: the artist's earlier launches of the same
   * kind, newest first, and the reference launches' medians, each cut at the same point of its campaign. */
  function history(view, kind, share, spreadOn) {
    const idx = dailyIndex(tools, kind === "TL" ? "tl_funnel_daily" : "funnel_daily");
    const members = (view.benchmark && view.benchmark.members) || [];
    const others = (tools.readIndex().releases || []).filter((r) => r.releaseName !== view.releaseName && artistOf(r.releaseName) === artistOf(view.releaseName));
    const otherKind = others.filter((r) => r.type !== kind && r.status !== "upcoming").map((r) => shortName(r.releaseName)).slice(0, 6);
    if (!idx) return { self: null, earlier: [], ref: null, otherKind, missing: "The launches' day-by-day history has not been built on this server yet, so there is no same-point comparison with earlier launches." };
    const main = kind === "TL" ? "signups" : "entries";
    const panel = panelOf(kind);
    const mine = idx.meta.get(view.releaseName);
    const started = (mine && mine.announce) || String(view.windowStart || "9999");
    const read = (name) => {
      const cut = upTo(idx, name, share);
      const at = tally(idx, name, cut.keep, kind, spreadOn);
      const all = share !== null && share < 1 ? tally(idx, name, () => true, kind, spreadOn) : at;
      if (!at || !all) return null;
      return { name, cut, at, all };
    };
    const shape = (x) => clean({
      visits: rnd(x.visits), ...(kind === "TL" ? { signups: rnd(x.signups), orders: rnd(x.orders) } : { entrants: rnd(x.entrants), eligibleEntrants: rnd(x.eligible), entries: rnd(x.entries) }),
      unitsPaid: rnd(x.units),
      [`${main}PerVisit`]: x.visits >= MIN_VISITS ? frac(x[main] / x.visits) : undefined,
      ...(kind === "LE" && x.entrants >= 10 ? { eligibleShare: frac(x.eligible / x.entrants) } : {}),
    });
    const names = [...idx.meta.keys()].filter((n) => n !== view.releaseName && artistOf(n) === artistOf(view.releaseName) && idx.meta.get(n).announce < started)
      .sort((a, b) => (idx.meta.get(a).announce < idx.meta.get(b).announce ? 1 : -1)).slice(0, MAX_EARLIER);
    const earlier = names.map(read).filter(Boolean).map((x) => {
      const f = facts(x.name, members, panel);
      const m = idx.meta.get(x.name);
      return {
        launch: shortName(x.name), name: x.name, announced: m.announce, campaignDays: m.of,
        edition: rnd(f.edition), price: rnd(f.price), finalUnits: rnd(f.units ?? x.all.units),
        point: x.cut.point, at: x.at, all: x.all,
        byThisPoint: shape(x.at), final: shape(x.all),
        shareOfFinalByThisPoint: clean({ visits: frac(div(x.at.visits, x.all.visits)), [main]: frac(div(x.at[main], x.all[main])) }),
      };
    });
    // the reference launches at the same point: the median over the members the history holds
    let ref = null;
    const got = members.map((m) => read(m.name)).filter(Boolean);
    if (got.length) {
      const med = (f) => median(got.map(f));
      ref = {
        launchesRead: got.length, of: members.length,
        byThisPoint: clean({
          visits: rnd(med((x) => x.at.visits)),
          ...(kind === "TL" ? { signups: rnd(med((x) => x.at.signups)) } : { entrants: rnd(med((x) => x.at.entrants)), eligibleEntrants: rnd(med((x) => x.at.eligible)), entries: rnd(med((x) => x.at.entries)) }),
          unitsPaid: rnd(med((x) => x.at.units)),
          [`${main}PerVisit`]: frac(med((x) => (x.at.visits >= MIN_VISITS ? x.at[main] / x.at.visits : null))),
          ...(kind === "LE" ? { eligibleShare: frac(med((x) => (x.at.entrants >= 10 ? x.at.eligible / x.at.entrants : null))) } : {}),
        }),
        shareOfFinalByThisPoint: clean({ visits: frac(med((x) => div(x.at.visits, x.all.visits))), [main]: frac(med((x) => div(x.at[main], x.all[main]))) }),
      };
    }
    const self = tally(idx, view.releaseName, () => true, kind, spreadOn);
    return { self, earlier, ref, otherKind, shape };
  }

  /* ---------------------------------------------------------- the parts every kind of launch shares */
  const groupsOf = (view) => (view.channels || []).map((c) => [c.key, c.name]).filter(([k]) => view.funnelByGroup && view.funnelByGroup[k]);

  function toldEmails(view, targeted) {
    const e = view.email || {};
    if (!(num(e.sends) > 0)) return { sends: 0, note: "No sends on file for this launch yet.", dataThrough: e.feedThrough };
    const list = (e.sequence || []).slice(-MAX_SENDS).map((s) => clean({
      name: s.name, date: s.date, delivered: rnd(s.delivered), opened: frac(div(s.opened, s.delivered)), clicked: frac(div(s.clicked, s.delivered)),
    }));
    return {
      sends: e.sends, delivered: rnd(e.delivered),
      plan: targeted ? rnd(e.deliveredTarget) : undefined, reference: rnd(e.deliveredBenchmark),
      planMeans: targeted && num(e.deliveredTarget) !== null ? "the emails that the plan's email visits by now would take, at the usual open and click rates" : undefined,
      read: reading(e.delivered, targeted && num(e.deliveredTarget) !== null ? e.deliveredTarget : e.deliveredBenchmark),
      dataThrough: e.feedThrough, list,
    };
  }

  function toldPosts(view) {
    const s = view.social;
    if (!s) return undefined;
    if (s.postsEndsFirst) return { note: `The posts on file stop at ${s.postsThrough || "an earlier day"}, before this launch: not known here.` };
    return {
      ourPosts: rnd(s.posts), ourStories: rnd(s.stories), artistPosts: rnd(s.artistPosts), artistPostsPlanned: rnd(s.artistPostsTarget),
      note: s.postsPartial ? `The posts on file stop at ${s.postsThrough}, part way through this launch.` : undefined,
    };
  }

  function responded(view) {
    const e = view.email || {}, b = view.benchmarks || {};
    if (!(num(e.delivered) > 0)) return undefined;
    const usualOpen = num(b.emailOpenRateRef) !== null ? b.emailOpenRateRef / 100 : null;
    const usualClick = num(b.emailClickRateRef) !== null ? b.emailClickRateRef / 100 : null;
    return {
      stage: "Responded",
      opened: { now: frac(e.openRate), usual: frac(usualOpen), read: reading(e.openRate, usualOpen) },
      clicked: { now: frac(e.clickRate), usual: frac(usualClick), read: reading(e.clickRate, usualClick), of: "emails delivered" },
      usualMeans: b.emailRefCohort && b.emailRefCohort.n ? `the median of ${b.emailRefCohort.n} launches that closed in the last two years` : undefined,
    };
  }

  function visited(view, hist, targeted, bench) {
    const fb = view.funnelByGroup || {};
    const groups = groupsOf(view);
    const sum = (f) => groups.reduce((a, [k]) => a + (num(fb[k][f]) || 0), 0);
    const now = sum("sessions_actual");
    return {
      stage: "Visited",
      total: { now: rnd(now), plan: targeted ? rnd(sum("sessions_expected")) : undefined, reference: bench ? rnd(sum("sessions_benchmark")) : undefined,
        read: reading(now, targeted ? sum("sessions_expected") : bench ? sum("sessions_benchmark") : null, { floor: MIN_VISITS }) },
      byChannel: groups.map(([k, name]) => ({
        channel: name, now: rnd(fb[k].sessions_actual), plan: targeted ? rnd(fb[k].sessions_expected) : undefined, reference: bench ? rnd(fb[k].sessions_benchmark) : undefined,
        read: reading(fb[k].sessions_actual, targeted ? fb[k].sessions_expected : bench ? fb[k].sessions_benchmark : null, { floor: MIN_VISITS }),
      })),
      sameArtist: hist.earlier.map((m) => ({ launch: m.launch, byThisPoint: rnd(m.at.visits), final: rnd(m.all.visits),
        byChannel: Object.fromEntries(Object.entries(m.at.byChannel).map(([c, x]) => [c, x.visits]).filter(([, v]) => v > 0)) })),
    };
  }

  /* the build's own split of the gap, in units: by driver against the plan and against the reference launches,
   * and channel by channel between visits and what the visits turned into */
  const PART = { organic_traffic: "visits, ads apart", organic_conversion: "what those visits turned into", paid_spend: "ad spend, more or less than planned", paid_efficiency: "what the ads returned for the spend" };
  function gapOf(view, targeted, bench, unit) {
    const w = (view.waterfall && view.waterfall.today) || view.waterfall || {};
    const h = view.hero || {};
    const fb = view.funnelByGroup || {};
    const parts = (steps) => (steps || []).map((s) => ({ part: PART[s.key] || s.label, [unit]: rnd(s.value) }));
    const net = (a, b) => (num(a) === null || num(b) === null ? undefined : rnd(num(a) + num(b), 1));
    const byChannel = groupsOf(view).map(([k, name]) => clean({
      channel: name,
      visits: targeted ? rnd(fb[k].contrib_traffic, 1) : undefined, conversion: targeted ? rnd(fb[k].contrib_conversion, 1) : undefined,
      net: targeted ? net(fb[k].contrib_traffic, fb[k].contrib_conversion) : undefined,
      visitsAgainstReference: bench ? rnd(fb[k].contrib_traffic_bm, 1) : undefined, conversionAgainstReference: bench ? rnd(fb[k].contrib_conversion_bm, 1) : undefined,
      netAgainstReference: bench ? net(fb[k].contrib_traffic_bm, fb[k].contrib_conversion_bm) : undefined,
    })).filter(Boolean);
    return clean({
      unit: `${unit} gained (+) or lost (-) so far`,
      againstPlan: targeted && num(h.expectedToday) !== null ? { total: rnd(num(h.now) - num(h.expectedToday)), parts: parts(w.steps) } : undefined,
      againstReference: bench && num(h.benchmarkToday) !== null ? { total: rnd(num(h.now) - num(h.benchmarkToday)), parts: parts(w.stepsBm) } : undefined,
      byChannel,
      note: "visits: more or fewer visits than expected, at the expected rate. conversion: what the visits it had turned into, against the expected rate. net: the two together. Read Paid by its net alone: more ad spend buys visits at a lower rate, so its visits and its conversion offset each other.",
    });
  }

  /* the first pass: the largest single loss in the split, said in words for the model to test */
  function firstRead(gap, unit) {
    if (!gap || !gap.byChannel) return undefined;
    const vsPlan = !!gap.againstPlan;
    const cells = [];
    for (const c of gap.byChannel) {
      const v = vsPlan ? c.visits : c.visitsAgainstReference, k = vsPlan ? c.conversion : c.conversionAgainstReference;
      // ads are one figure: the visits they bought and the rate they came at offset each other
      if (c.channel === "Paid") { const n = vsPlan ? c.net : c.netAgainstReference; if (num(n) !== null) cells.push({ what: "ads overall (spend and what it returned together)", units: n }); continue; }
      if (num(v) !== null) cells.push({ what: `visits from ${c.channel}`, units: v });
      if (num(k) !== null) cells.push({ what: `what ${c.channel} visits turned into`, units: k });
    }
    const worst = cells.filter((x) => x.units < -0.5).sort((a, b) => a.units - b.units)[0];
    const total = vsPlan ? gap.againstPlan.total : gap.againstReference && gap.againstReference.total;
    if (!worst) return num(total) !== null && total >= 0 ? `Nothing in the split is losing ${unit}: the launch is at or ahead of ${vsPlan ? "its plan" : "similar past launches"}.` : undefined;
    return `Largest single loss against ${vsPlan ? "the plan" : "similar past launches"}: ${worst.what}, ${rnd(worst.units)} ${unit}${num(total) !== null && total < 0 ? ` of the ${rnd(total)} it is behind by` : ""}. A first pass to test, not a finding.`;
  }

  function compared(view, hist, share, kind, bench) {
    const b = view.benchmark || {};
    const basket = b.basket || {};
    const day = num(view.day), of = num(view.of);
    return clean({
      point: share === null ? undefined : share >= 1 ? "whole campaigns: this one has closed" : `the same share of each campaign as this one has run (${Math.round(share * 100)}%${kind === "LE" && day !== null && of ? `: day ${day} of ${of} here` : ""})`,
      sameArtist: hist.earlier.map((m) => ({ launch: m.launch, announced: m.announced, campaignDays: m.campaignDays, edition: m.edition, price: m.price, finalUnits: m.finalUnits, readTo: m.point })),
      sameArtistNote: hist.earlier.length ? undefined
        : hist.missing || `No earlier ${kind === "TL" ? "timed launch" : "draw launch"} by this artist in the day-by-day history${hist.otherKind && hist.otherKind.length ? ` (they have had ${kind === "TL" ? "draw launches" : "timed launches"}: ${hist.otherKind.join(", ")})` : ""}: use similar past launches.`,
      reference: bench ? {
        name: basket.name, launches: (b.members || []).map((m) => clean({ launch: `${m.artist} · ${m.title} (${m.quarter})`, units: rnd(m.units), price: rnd(m.price) })),
        thin: basket.thin ? "only a few launches: weak evidence" : undefined,
        readFromTheirDays: hist.ref ? `${hist.ref.launchesRead} of ${hist.ref.of}` : undefined,
      } : undefined,
      referenceNote: bench ? undefined : "No reference launches on this page: nobody has set its targets.",
    });
  }

  /* ---------------------------------------------------------- a draw launch */
  function leSheet(view, applied, spreadOn) {
    const h = view.hero || {}, st = view.sellthrough || {}, t = view.targets || {}, p = view.paid || {}, bm = view.benchmark || {};
    const targeted = view.targeted !== false && !!view.targets && num(h.target) !== null;
    const bench = !!(bm.basket && (bm.members || []).length);
    const closed = !!view.complete;
    const share = shareGone(view.day, view.of, view.asOfFraction, closed);
    const hist = history(view, "LE", share, spreadOn);
    const self = hist.self;
    const fb = view.funnelByGroup || {};
    const pf = view.pageFunnel || {};
    const day = num(view.day), of = num(view.of);

    const stages = [];
    // 1. told
    const pace = share !== null && of > PAID_START_DAYS ? Math.max(0, Math.min(1, (share * of - PAID_START_DAYS) / (of - PAID_START_DAYS))) : null;
    const spendPlan = targeted && num(p.spendBudget) !== null && pace !== null ? p.spendBudget * pace : null;
    stages.push({
      stage: "Told",
      emails: toldEmails(view, targeted),
      posts: toldPosts(view),
      ads: clean({ spendSoFar: rnd(p.spendToDate), planByNow: rnd(spendPlan), budgetForTheCampaign: targeted ? rnd(p.spendBudget) : undefined, started: num(p.spendToDate) > 0,
        read: reading(p.spendToDate, spendPlan, { floor: 50 }) }),
    });
    // 2. responded
    stages.push(responded(view));
    // 3. visited
    stages.push(visited(view, hist, targeted, bench));
    // 4. looked at a work: the release page to a product page
    const side = (s, key) => {
      const x = (pf[s] || {})[key];
      if (!x) return undefined;
      return clean({ visitors: rnd(x.sessions), wentOn: rnd(x.through), rate: frac(x.rate), reference: frac(x.bm), referenceLaunches: x.bmN || undefined, read: reading(x.rate, x.bm, { of: x.sessions }) });
    };
    const steps = (key, mine) => clean({
      everythingButAds: side("organic", key), ads: side("paid", key),
      sameArtist: hist.earlier.map((m) => clean({ launch: m.launch, everythingButAds: m.at.pages && m.at.pages.organic[mine].rate, ads: m.at.pages && m.at.pages.paid[mine].rate })).filter((x) => x && Object.keys(x).length > 1),
    });
    if (pf.organic || pf.paid) {
      const landed = ["organic", "paid"].reduce((a, k) => a + (num(((pf[k] || {}).clickThrough || {}).sessions) || 0), 0);
      const onWork = ["organic", "paid"].reduce((a, k) => a + (num(((pf[k] || {}).entry || {}).sessions) || 0), 0);
      stages.push({ stage: "Looked at a work", what: "of visitors to the release page, the share who went on to a product page",
        note: onWork > 0 && landed < 0.25 * onWork ? "Few visitors see a release page here: nearly all land straight on a work's page, so this step says little." : undefined,
        ...steps("clickThrough", "toAWork") });
    }
    // 5. entered
    const entered = { stage: "Entered", fromAWorkPage: (pf.organic || pf.paid) ? { what: "of visitors to a product page, the share who entered the draw", ...steps("entry", "entered") } : undefined };
    if (self && self.rows) {
      entered.soFar = clean({
        entrants: rnd(self.entrants), eligibleEntrants: rnd(self.eligible), eligibleShare: self.entrants >= 10 ? frac(self.eligible / self.entrants) : undefined,
        entries: rnd(self.entries), entriesPerVisit: self.visits >= MIN_VISITS ? frac(self.entries / self.visits) : undefined,
        means: "entrants: people who entered. eligible: those whose entry stands. entries: the units the eligible asked for, which is what the page counts.",
      });
    }
    entered.planForTheWholeCampaign = targeted ? rnd(t.entries_target) : undefined;
    entered.sameArtist = hist.earlier.map((m) => ({ launch: m.launch, byThisPoint: m.byThisPoint, final: m.final, shareOfFinalByThisPoint: m.shareOfFinalByThisPoint }));
    entered.reference = hist.ref ? { launches: `${hist.ref.launchesRead} of ${hist.ref.of} read from their own days`, medianByThisPoint: hist.ref.byThisPoint, medianShareOfFinalByThisPoint: hist.ref.shareOfFinalByThisPoint } : undefined;
    if (self && hist.earlier.length) {
      const best = hist.earlier[0];
      entered.read = reading(div(self.entries, self.visits), div(best.at.entries, best.at.visits), { of: Math.min(self.visits, best.at.visits) });
      entered.readAgainst = entered.read ? `entries per visit against ${best.launch}` : undefined;
    } else if (self && hist.ref && hist.ref.byThisPoint && hist.ref.byThisPoint.entriesPerVisit) {
      entered.read = reading(div(self.entries, self.visits), hist.ref.byThisPoint.entriesPerVisit, { of: self.visits });
      entered.readAgainst = entered.read ? "entries per visit against similar past launches" : undefined;
    }
    stages.push(entered);
    // 6. bought
    const draws = Array.isArray(st.draws) ? st.draws : [];
    const dsum = (f) => draws.reduce((a, d) => a + (num(d[f]) || 0), 0);
    stages.push({
      stage: "Bought",
      now: clean({
        unitsPaid: rnd(st.unitsPaidOrders ?? st.sold), awaitingPayment: rnd(st.drafts), entriesInHand: closed ? undefined : rnd(st.inHandUnits, 1),
        entriesToOrdersRate: closed ? undefined : frac(st.conversion), rateMeans: closed ? undefined : "the rate entries in hand are counted at, assumed until the draw is drawn",
        countedAsSoldOrSpokenFor: rnd(h.now),
      }),
      draws: draws.length ? clean({ entrants: dsum("entrants"), eligible: dsum("eligible"), winners: dsum("winners"), winnersPaid: dsum("sold"), wonNotYetPaid: dsum("wonUnpaid"), stillOpen: dsum("open") }) : undefined,
      unitsPerBuyer: view.unitsPerBuyer ? clean({ plan: rnd(view.unitsPerBuyer.plan, 2), now: rnd(view.unitsPerBuyer.actual, 2), read: reading(view.unitsPerBuyer.actual, view.unitsPerBuyer.plan) }) : undefined,
      perVisitByChannel: groupsOf(view).map(([k, name]) => clean({
        channel: name, now: frac(fb[k].conv_actual), plan: targeted ? frac(fb[k].conv_expected) : undefined, reference: bench ? frac(fb[k].conv_benchmark_today) : undefined,
        read: reading(fb[k].conv_actual, targeted ? fb[k].conv_expected : bench ? fb[k].conv_benchmark_today : null, { of: fb[k].sessions_actual }),
      })),
      perVisitMeans: "units sold or spoken for per visit",
      sameArtist: hist.earlier.map((m) => clean({ launch: m.launch, unitsPaidByThisPoint: rnd(m.at.units), finalUnits: m.finalUnits, edition: m.edition, soldOfEdition: frac(div(m.finalUnits, m.edition)) })),
    });
    // 7. which work
    const works = (st.products || []).filter((x) => num(x.edition) > 0).map((x) => clean({
      work: x.name, edition: rnd(x.edition), paid: rnd(x.sold), likelyFromEntries: rnd(x.shown ?? x.predicted, 1), entrants: rnd(x.entrants),
      planByNow: targeted ? rnd(x.expectedToday, 1) : undefined, referenceByNow: bench ? rnd(x.benchmarkToday, 1) : undefined,
      read: reading((num(x.sold) || 0) + (num(x.shown ?? x.predicted) || 0), targeted ? x.expectedToday : x.benchmarkToday, { floor: 3 }),
    }));
    if (works.length > 1) stages.push({ stage: "Which work", works: works.slice(0, 12), lines: Array.isArray(view.lines) && view.lines.length ? view.lines.map((l) => l.name || l.key) : undefined });

    const paidFb = fb.paid || {};
    const tp = t.paid || {};
    const ads = clean({
      started: num(p.spendToDate) > 0, spendSoFar: rnd(p.spendToDate), planByNow: rnd(spendPlan), budgetForTheCampaign: targeted ? rnd(p.spendBudget) : undefined,
      visits: { now: rnd(paidFb.sessions_actual), plan: targeted ? rnd(paidFb.sessions_expected) : undefined, reference: bench ? rnd(paidFb.sessions_benchmark) : undefined },
      entries: rnd(p.entriesToDate, 1),
      costPerEntry: { now: rnd(p.cumCpe, 2), lastThreeDays: rnd(p.l3dCpe, 2), plan: targeted ? rnd(tp.cost_per_entry, 2) : undefined, reference: rnd(num(bm.costPerEntryRef) || num(bm.costPerEntry) || null, 2),
        read: num(p.cumCpe) > 0 ? reading(targeted && num(tp.cost_per_entry) > 0 ? tp.cost_per_entry : num(bm.costPerEntryRef) || bm.costPerEntry, p.cumCpe) : undefined,
        readMeans: "short means entries are costing more than the yardstick" },
      profitBackPerEuro: { now: rnd(p.cumRoi, 2), lastThreeDays: rnd(p.l3dRoi, 2), aim: rnd(p.roiTarget, 2) },
    });

    const gap = targeted || bench ? gapOf(view, targeted, bench, "units") : undefined;
    const cf = view.closeForecast || {};
    return {
      sheet: "The diagnosis sheet for a draw launch. Rates are fractions of one (0.012 is 1.2%). plan = what the targets expect by now; reference = similar past launches by the same point; sameArtist = the artist's earlier launches by the same point.",
      release: clean({
        id: view.id, name: view.releaseName, artist: view.artist, kind: "draw launch (limited edition)",
        state: closed ? "closed" : day !== null && of ? `live: day ${day} of ${of}, ${Math.max(of - day, 0)} days left` : "live",
        dataThrough: view.asOf, todaySoFar: !closed && num(view.asOfFraction) !== null && view.asOfFraction < 1 ? `${Math.round(view.asOfFraction * 100)}% of today is in the data` : undefined,
        targetsSet: targeted, edition: rnd((view.edition || {}).total), unitPrice: rnd((view.economics || {}).unitPrice),
        lines: Array.isArray(view.lines) && view.lines.length ? view.lines.map((l) => l.name || l.key) : undefined, channelsShown: applied,
      }),
      comparison: compared(view, hist, share, "LE", bench),
      outcome: clean({
        counts: closed ? "units paid" : "units sold or spoken for: paid, awaiting payment, and entries in hand at the rate they turn into orders",
        now: rnd(h.now), plan: targeted ? rnd(h.expectedToday) : undefined, reference: bench ? rnd(h.benchmarkToday) : undefined,
        read: reading(h.now, targeted ? h.expectedToday : bench ? h.benchmarkToday : null, { floor: 3 }),
        headingFor: closed ? undefined : rnd(h.projected), target: targeted ? rnd(h.target) : undefined, referenceAtClose: bench ? rnd(h.benchmark) : undefined,
        likelyRangeAtClose: !closed && num(cf.lo) !== null && num(cf.hi) !== null ? `${rnd(cf.lo)} to ${rnd(cf.hi)} (${cf.confidence || "unrated"} confidence)` : undefined,
      }),
      stages: stages.filter(Boolean).map(clean).filter(Boolean),
      ads,
      gap,
      firstRead: firstRead(gap, "units"),
    };
  }

  /* ---------------------------------------------------------- a timed launch */
  function tlSheet(view, applied, spreadOn) {
    const h = view.hero || {}, t = view.targets || {}, p = view.paid || {}, bm = view.benchmark || {}, sg = view.signups || {}, sales = view.sales || null;
    const state = view.tlState;
    const before = state === "signups";
    const targeted = view.targeted !== false && num(h.target) !== null;
    const bench = !!(bm.basket && (bm.members || []).length);
    const clock = view.clock || {};
    const share = before ? shareGone(clock.day ?? view.day, clock.of ?? view.of, view.asOfFraction, false) : 1;
    const hist = history(view, "TL", share, spreadOn);
    const self = hist.self;
    const unit = before ? "signups" : "units";

    const stages = [];
    const spendPlan = before && targeted && num(p.spendBudget) !== null && share !== null ? p.spendBudget * share : null;
    const e = view.email || {};
    stages.push({
      stage: "Told",
      emails: toldEmails(view, targeted),
      posts: toldPosts(view),
      ads: clean({ spendSoFar: rnd(p.spendToDate), planByNow: rnd(spendPlan), budgetBeforeTheWindow: targeted ? rnd(p.spendBudget) : undefined, started: num(p.spendToDate) > 0,
        read: reading(p.spendToDate, spendPlan, { floor: 50 }), planMeans: spendPlan !== null ? "the budget spread evenly from the announce to the day sales open" : undefined }),
    });
    stages.push(responded(view));
    stages.push(visited(view, hist, targeted, bench));
    // signed up: by channel, the visits that signed up and the signups they made
    const rows = Array.isArray(sg.byGroup) ? sg.byGroup : [];
    stages.push({
      stage: "Signed up",
      total: clean({ now: rnd(sg.total ?? h.now), people: rnd(sg.unique), beforeTheAnnounce: rnd(sg.preAnnounce), untracked: rnd((sg.untracked || {}).signups),
        plan: before && targeted ? rnd(h.expectedToday) : undefined, reference: before && bench ? rnd(h.benchmarkToday) : undefined,
        read: before ? reading(h.now, targeted ? h.expectedToday : bench ? h.benchmarkToday : null, { floor: 10 }) : undefined }),
      byChannel: rows.filter((x) => !x.off).map((x) => clean({
        channel: x.name, signups: rnd(x.now), plan: before && targeted ? rnd(x.exp) : undefined, reference: before && bench ? rnd(x.bmExp) : undefined,
        perVisit: num(x.sessions) >= MIN_VISITS ? frac(x.rate) : undefined, perVisitReference: bench ? frac(x.bmRate) : undefined,
        read: reading(x.rate, x.bmRate, { of: x.sessions }), readMeans: undefined,
      })),
      readMeans: "each channel's read is its signups per visit against similar past launches",
      sameArtist: hist.earlier.map((m) => ({ launch: m.launch, byThisPoint: m.byThisPoint, final: m.final, shareOfFinalByThisPoint: m.shareOfFinalByThisPoint })),
      reference: hist.ref ? { launches: `${hist.ref.launchesRead} of ${hist.ref.of} read from their own days`, medianByThisPoint: hist.ref.byThisPoint, medianShareOfFinalByThisPoint: hist.ref.shareOfFinalByThisPoint } : undefined,
    });
    // bought
    const panel = panelOf("TL");
    const bought = { stage: "Bought" };
    if (before) {
      bought.note = "Sales have not opened: what signups turn into is assumed from similar past launches until they do.";
      bought.assumed = clean({ signupsToOrders: frac(t.signup_order_rate), piecesPerOrder: rnd(t.purchases_per_order, 2), unitsTarget: rnd(t.units_target), signupsNeeded: rnd(t.signup_target) });
    } else if (sales) {
      bought.now = clean({ units: rnd(sales.units), orders: rnd(sales.orders), piecesPerOrder: rnd(sales.piecesPerOrder, 2), target: targeted ? rnd(sales.unitsTarget) : undefined,
        expectedByNow: targeted ? rnd(sales.expectedNow) : undefined, reference: bench ? rnd(sales.bmNow) : undefined,
        read: reading(sales.units, targeted ? sales.expectedNow : sales.bmNow, { floor: 5 }) });
      bought.fromSignups = clean({ signups: rnd(sg.total), ordersPerSignup: frac(div(sales.orders, sg.total)), assumed: frac(t.signup_order_rate),
        read: reading(div(sales.orders, sg.total), t.signup_order_rate, { of: sg.total }), note: "orders over all signups: buyers who never signed up are in the orders too" });
    }
    bought.sameArtist = hist.earlier.map((m) => { const x = panel.get(m.name) || {}; return clean({ launch: m.launch, units: rnd(x.units ?? m.finalUnits), signups: rnd(x.signups), signupsToOrders: frac(x.signupToOrder), costPerSignup: rnd(x.costPerSignup, 2), windowHours: rnd(x.windowHours) }); });
    stages.push(bought);

    const paidRow = rows.find((x) => x.key === "paid") || {};
    const ads = clean({
      started: num(p.spendToDate) > 0, spendSoFar: rnd(p.spendToDate), planByNow: rnd(spendPlan), budgetBeforeTheWindow: targeted ? rnd(p.spendBudget) : undefined,
      signups: rnd(p.signups), signupsPlanByNow: before && targeted ? rnd(paidRow.exp) : undefined,
      costPerSignup: { now: rnd(p.costPerSignup, 2), plan: rnd(p.costPlan, 2), reference: rnd(p.bmCostPerSignup ?? p.costBm, 2),
        read: num(p.costPerSignup) > 0 ? reading(num(p.costPlan) || p.bmCostPerSignup, p.costPerSignup) : undefined, readMeans: "short means a signup is costing more than the yardstick" },
      shareOfSignups: { now: frac(p.shareSignups), reference: frac(p.bmShareSignups) },
    });

    const gap = (targeted || bench) && view.funnelByGroup ? gapOf(view, targeted, bench, unit) : undefined;
    const sheet = {
      sheet: "The diagnosis sheet for a timed launch. Rates are fractions of one (0.05 is 5%). plan = what the targets expect by now; reference = similar past launches by the same point; sameArtist = the artist's earlier timed launches by the same point.",
      release: clean({
        id: view.id, name: view.releaseName, artist: view.artist, kind: "timed launch",
        state: state === "upcoming" ? "not announced yet" : before ? `gathering signups: day ${clock.day ?? view.day} of ${clock.of ?? view.of}, sales open in ${h.daysToOpen} days`
          : state === "window" ? "the sales window is open" : state === "settling" ? "the window has shut and the last orders are settling" : "closed",
        dataThrough: view.asOf, todaySoFar: before && num(view.asOfFraction) !== null && view.asOfFraction < 1 ? `${Math.round(view.asOfFraction * 100)}% of today is in the data` : undefined,
        targetsSet: targeted, windowHours: rnd(view.windowHours), channelsShown: applied,
      }),
      comparison: compared(view, hist, share, "TL", bench),
      outcome: before ? clean({
        counts: "signups so far (sales have not opened)", now: rnd(h.now), plan: targeted ? rnd(h.expectedToday) : undefined, reference: bench ? rnd(h.benchmarkToday) : undefined,
        read: reading(h.now, targeted ? h.expectedToday : bench ? h.benchmarkToday : null, { floor: 10 }),
        headingFor: rnd(h.projected), target: targeted ? rnd(h.target) : undefined, referenceByOpening: bench ? rnd(h.benchmark) : undefined,
      }) : clean({
        counts: "units sold", now: rnd(h.now), plan: targeted ? rnd(h.expectedToday) : undefined, reference: bench ? rnd(h.benchmarkToday) : undefined,
        read: reading(h.now, targeted ? h.expectedToday : bench ? h.benchmarkToday : null, { floor: 5 }), target: targeted ? rnd(h.target) : undefined,
      }),
      stages: stages.filter(Boolean).map(clean).filter(Boolean),
      ads,
      gap,
      firstRead: firstRead(gap, unit),
    };
    if (self && self.rows) sheet.release.soFarFromItsDays = clean({ visits: rnd(self.visits), signups: rnd(self.signups), unitsOrdered: rnd(self.units) });
    return sheet;
  }

  /* The sheet for a release id, as the reader's page shows it (their Direct display). A launch with nothing to
   * diagnose yet says so in `nothingYet` and carries no stages. */
  function diagnose({ id, display } = {}) {
    const { view, applied } = tools.pageView({ id, display });
    const spreadOn = /spread/i.test(applied) && !/as a channel/i.test(applied);
    const head = { id: view.id, name: view.releaseName, artist: view.artist };
    if (view.upcoming || view.tlState === "upcoming") return { release: head, nothingYet: "This launch has not been announced: there is nothing to diagnose yet. Its page shows the dates, the works and the targets set so far." };
    if (view.catalogue) return { release: head, nothingYet: "This is an older work still selling, with no campaign running: there is no funnel to diagnose. Its page shows the last 90 days." };
    const fb = view.funnelByGroup || {};
    const visits = Object.values(fb).reduce((a, g) => a + (num(g && g.sessions_actual) || 0), 0);
    if (!(visits > 0) && !(num((view.hero || {}).now) > 0) && !(num((view.email || {}).delivered) > 0)) {
      return { release: head, nothingYet: "Nothing has happened on this launch yet: no visits, no emails and no sales in the data. There is nothing to diagnose until it starts." };
    }
    const sheet = view.type === "TL" ? tlSheet(view, applied, spreadOn) : leSheet(view, applied, spreadOn);
    return clean(sheet);
  }

  return { diagnose };
}

module.exports = { createDiagnose, reading, shareGone, shortName, tally, dailyIndex };
