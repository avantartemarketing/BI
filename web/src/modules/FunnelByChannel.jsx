/* Funnel by channel (spec §4.4, LE relabel per §6). Tall card (1 col × 2 rows),
 * and a 2 × 2 version (FunnelByChannelWide, at the foot of this file) that
 * gives the waterfall view two columns by two rows of room.
 * Always the Today horizon, so the page toggle is accepted and ignored.
 * Five display groups; rungs are built from real snapshot data instead of the
 * mock's static list:
 *   AA Email  - a stage-by-stage chain: Delivered emails vs cohort-median delivery
 *               curve · Open rate · Click rate (clicks per opened email) · Sessions per
 *               click · Session → entry. Rate references are the ETL's cohort medians
 *               (fixed defaults until two launches qualify); sessions per click is
 *               judged against the plan's expected sessions over expected clicks.
 *   AA Meta   - Posts + stories (no ref) · Sessions · Session → entry
 *   Referral artist - Posts (artist accounts; no feed yet, renders neutral) ·
 *               Sessions · Session → entry
 *   Search-direct-other - Sessions · Session → entry
 *   Paid      - Spend vs the budget's share of the days paid runs · Cost per
 *               unit (spend over paid secured units) vs the plan's cost per
 *               purchase (inverted)
 *
 * The target runs down the centre of every rung, the dot is the actual, and the
 * benchmark is a dotted tick wherever the basket's own figure lands on the same
 * log scale - the rung's form of the dotted outline every bar carries
 * (BENCHMARK_SPEC 7). ×4 either way fills the rung; the printed figure and its
 * RAG are against the target. Volume rungs (delivered emails, posts, sessions,
 * spend) carry the even uplift, so their target is the benchmark × K and the
 * tick sits 1/K off the centre; rate rungs (open, click, sessions per click,
 * session → sale, cost per unit) are held at the benchmark, so their tick sits
 * on the centre line. Without a basket the plan is the centre, the line goes to
 * the neutral plan grey and there is no tick.
 * Inverted metrics (cost per entry) are placed by their judged direction, so
 * the ratio is inverted before it is positioned - cheap right, dear left.
 * Null value or missing/zero reference → neutral: centred grey dot, delta '–'. */
import React from "react";
import {
  Card, GROUP_DOTS, C, fmt, fmtSigned, fmtMoney, MINUS, useTip,
  rungGeom, rungPos, RungTrack, RungKey, Tick, refWords, dayElapsed, paidDayFrac, dayLabel,
} from "../ui.jsx";

const RING = "0 0 0 1px rgba(20,20,19,.45)";
const NEUTRAL_DOT = "#c8c5bc";
const GUIDE = "#ddd9cf";

/* One grid for the rungs, the waterfall rows and the centre-line overlay, so
 * the three cannot drift apart. The rung track is the middle column, which
 * starts a gap after the label and ends a gap before the delta - inset the
 * overlay by those and its 50% is the rung's own 50%. */
const LABEL_W = 112, DELTA_W = 56, COL_GAP = 10;
const GRID = `${LABEL_W}px 1fr ${DELTA_W}px`;
const TRACK_L = LABEL_W + COL_GAP, TRACK_R = DELTA_W + COL_GAP;
/* The stack has to hold five groups, fifteen rungs and the key inside a tall
 * card, so the rows are 26px and the groups are 10px apart. */
const RUNG_H = 26, GROUP_GAP = 10;

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const usable = (v) => finite(v) && v !== 0;

function fmtVal(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (unit === "%") return fmt(v, 1) + "%";
  if (unit === "eur") return fmtMoney(v, Math.abs(v) < 100 ? 2 : 0);
  if (unit === "ratio") return fmt(v, 2);
  return fmt(v);
}

/* { label, v, bm, plan, unit, kind, inv, note } -> render model.
 * `bm` is the benchmark for today, `plan` the reference the lever model set.
 * The target is the rung centre - bm × K on a volume, bm itself on a rate, the
 * plan where there is no basket - and the benchmark's tick is placed on the
 * same scale, in the same judged direction as the dot. */
function buildRung(spec, bench, k) {
  const { label, v, unit, inv, note, kind } = spec;
  const bmv = bench && usable(spec.bm) ? spec.bm : null;
  const words = refWords("today");
  const target = bmv !== null ? bmv * (kind === "vol" && k > 0 ? k : 1) : spec.plan;
  const ref = target;
  const noVal = v === null || v === undefined || Number.isNaN(v);
  if (noVal || !usable(ref)) {
    // no reference: show the value itself where the delta would go, rather
    // than a dash that reads as "no data"
    return {
      label, neutral: true, delta: noVal ? "–" : fmtVal(v, unit), rag: C.muted,
      dev: 50, bmPos: null, beyond: false,
      tip: {
        head: label, body: note,
        rows: [
          { label: "Actual", value: fmtVal(v, unit) },
          { label: words.target, value: "–" },
        ],
      },
    };
  }
  const relPct = (v / ref - 1) * 100;
  const eff = inv ? -relPct : relPct;
  const rag = eff >= 0 ? C.green : eff > -10 ? C.amber : C.red;
  // Inverted (cost) metrics plot by their JUDGED direction: bad always goes
  // left, good always right - an over-reference cost per entry sits left, not
  // right.
  const geom = rungGeom(inv ? ref / v : v / ref) || {};
  return {
    label,
    neutral: false,
    up: eff >= 0,
    dev: geom.dev ?? 50,
    bmPos: bmv !== null ? rungPos(inv ? ref / bmv : bmv / ref) : null,
    beyond: !!geom.beyond,
    delta: (relPct >= 0 ? "+" : MINUS) + Math.abs(Math.round(relPct)) + "%",
    rag,
    tip: {
      head: label,
      body: (note ? note + " " : "") + (bmv !== null
        ? kind === "vol"
          ? `Target is the benchmark × K (${fmt(k, 2)}), the even uplift to the edition size.`
          : "Rates are held at the benchmark, so the target and the benchmark are the same figure."
        : ""),
      rows: [
        { label: "Actual", value: fmtVal(v, unit) },
        { label: words.target, value: fmtVal(target, unit) },
        ...(bmv === null ? [] : [{ label: words.bm, value: fmtVal(bmv, unit) }]),
        { label: "vs target",
          value: (relPct >= 0 ? "+" : MINUS) + Math.abs(relPct).toFixed(1) + "%",
          color: rag },
      ],
    },
  };
}

/* The rung's marks in their cell: the track, and where the dot ran off the
 * scale a flag at the end it ran off, rather than letting it pile up silently
 * against the clamp. Both cards draw their rungs with it. */
function RungMarks({ r, bench }) {
  return (
    <div style={{ position: "relative" }}>
      <RungTrack dev={r.dev} bmPos={r.bmPos} up={r.up} neutral={r.neutral} bench={bench} />
      {r.beyond && (
        <span style={{
          position: "absolute", top: -1, fontSize: 11, lineHeight: "12px", color: C.muted,
          ...(r.dev >= 96 ? { left: "calc(100% + 2px)" } : { right: "calc(100% + 2px)" }),
        }}>
          {r.dev >= 96 ? "›" : "‹"}
        </span>
      )}
    </div>
  );
}

function Rung({ r, bench }) {
  const tipApi = useTip();
  return (
    <div
      {...tipApi.props(r.tip)}
      style={{
        height: RUNG_H, flex: `0 0 ${RUNG_H}px`, display: "grid",
        gridTemplateColumns: GRID, gap: COL_GAP, alignItems: "center",
      }}
    >
      <div style={{ fontSize: 13, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {r.label}
      </div>
      <RungMarks r={r} bench={bench} />
      <div className="num" style={{ fontSize: 13.5, fontWeight: 600, textAlign: "right", color: r.rag }}>
        {r.delta}
      </div>
    </div>
  );
}

/* Waterfall view: expected -> actual secured units today, stepped by the
 * SAME rows the funnel view shows, group by group. Each group's secured units
 * are a chain of the funnel's own factors (AA Email: delivered x open rate x
 * clicks per open x sessions per click x session->sale, the stages emailStages
 * gives both views; Paid: spend x units per pound; the rest: sessions x
 * session->sale) and each step reprices one factor from its reference to its
 * actual with the earlier factors at actual and the later at reference (the
 * §4.5 one-at-a-time method), so the steps sum exactly to the group's gap and
 * the groups sum to the hero's. A row without a reference (Posts, or the email
 * stages before a delivery benchmark exists) is shown in place with no step
 * and its actual in grey - context, not a component of the arithmetic.
 * Rounding residual is parked on the largest step; a real residual (the hero
 * is capped at the edition) is left visible. */
function chainSteps(factors) {
  // factors: [{label, a, e, note}] -> steps summing to prod(a) - prod(e)
  const out = [];
  for (let i = 0; i < factors.length; i++) {
    let v = factors[i].a - factors[i].e;
    for (let j = 0; j < i; j++) v *= factors[j].a;
    for (let j = i + 1; j < factors.length; j++) v *= factors[j].e;
    out.push({ ...factors[i], value: v });
  }
  return out;
}

/* The AA Email stages both views share: actual and reference for delivered,
 * open rate, clicks per opened email and sessions per click. The rate
 * references, sessions per click included, are the ETL's cohort medians
 * (fixed defaults for the first two until two launches qualify); the delivered
 * target is the sends the plan's expected AA Email sessions imply at those
 * rates, so the chain's expected side multiplies out to the plan's expected
 * sessions. Where the ETL has no sessions-per-click median yet, the delivered
 * target is the cohort's median send and sessions per click falls back to the
 * plan's sessions over that send's expected clicks, which closes the chain
 * the same way. Percentages are 0-100 here. */
function emailStages(snap) {
  const email = snap?.email || {};
  const b = snap?.benchmarks || {};
  const fbg = (snap?.funnelByGroup || {}).aa_email || {};
  const openRef = b.emailOpenRateRef ?? 19.6;
  const clickRef = b.emailClickRateRef ?? 4.3;
  const ctorRef = b.emailClickToOpenRef ?? (clickRef / openRef) * 100;
  const spcRef = b.emailSessionsPerClickRef ?? null;
  const delivA = email.delivered ?? 0, delivE = email.deliveredTarget ?? null;
  const opensA = email.opened ?? 0, clicksA = email.clicked ?? 0;
  const sessA = fbg.sessions_actual ?? 0, sessE = fbg.sessions_expected ?? null;
  const clicksE = finite(delivE) && delivE > 0 ? delivE * (openRef / 100) * (ctorRef / 100) : null;
  // the same at the basket's pace: the waterfall walks from the benchmark
  const delivB = email.deliveredBenchmark ?? delivE;
  const clicksB = finite(delivB) && delivB > 0 ? delivB * (openRef / 100) * (ctorRef / 100) : null;
  /* Zero sends has two very different causes and the card used to report both
   * the same way. Marketing sent nothing, or the email feed stops before this
   * campaign even starts - an ingestion fault that says nothing about the
   * campaign. feedThrough is the last send anywhere in the file, so the second
   * case is the one that can be proved. */
  const feedThrough = email.feedThrough ?? null;
  const feedEndsFirst = !!(feedThrough && snap?.windowStart && feedThrough < snap.windowStart);
  return {
    delivA, delivE, delivB, opensA, clicksA, sessA, sessE, clicksE, clicksB, openRef, clickRef, ctorRef, spcRef,
    feedThrough, feedEndsFirst,
    openA: delivA > 0 ? (opensA / delivA) * 100 : null,
    ctorA: opensA > 0 ? (clicksA / opensA) * 100 : null,
    spcA: clicksA > 0 ? sessA / clicksA : null,
    spcE: finite(spcRef) && spcRef > 0 ? spcRef
      : finite(clicksE) && clicksE > 0 && finite(sessE) ? sessE / clicksE : null,
  };
}

/* `vsBm`: every reference read off the basket - the benchmark's pace by today -
 * rather than the target, for the waterfall's walk from the benchmark, so the
 * rows sum to the group's actual less its benchmark. Off, they read against
 * the plan and sum to actual less target, as they do without a basket. */
function groupWaterfall(g, snap, vsBm = false) {
  const ch = (snap.channels || []).find((c) => c.key === g.key) || {};
  const now = ch.now ?? 0, exp = (vsBm ? ch.bmExp : ch.exp) ?? 0;
  const fbg = (snap.funnelByGroup || {})[g.key] || {};
  const sessA = fbg.sessions_actual ?? 0, sessE = (vsBm ? fbg.sessions_benchmark : fbg.sessions_expected) ?? 0;
  const convA = fbg.conv_actual ?? 0;
  const convE = vsBm ? (fbg.conv_benchmark_today ?? (sessE > 0 ? exp / sessE : 0)) : (fbg.conv_expected ?? 0);
  const REF = vsBm ? "benchmark" : "plan";
  const rows = [];   // [{label, step (number|null), note, tip rows}]
  const P = (v) => fmtVal(v * 100, "%"), N = (v) => fmtVal(v, "count"), R = (v) => fmt(v, 2);
  /* Session → sale is two things at once: how many sessions became a buyer, and
     how many pieces each buyer took. On a multi-product release those are
     different problems with different fixes - one is a traffic and offer
     problem, the other is a merchandising one - so the step is split. The
     multi-buy rate is measured for the release rather than per channel, because
     the only buyer count that is neither double-counted across channel-days nor
     missing on the releases the channel feed does not reach is the release's own
     distinct one (BENCHMARK_SPEC 4.2). Where the two rates are equal the second
     step is zero and this reads exactly as the single step did. */
  const upb = snap.unitsPerBuyer || {};
  const upbA = upb.actual > 0 ? upb.actual : 1;
  const upbE = upb.plan > 0 ? upb.plan : 1;
  const splitBuy = Math.abs(upbA - upbE) > 0.001;
  const saleSteps = splitBuy
    ? [{ label: "Session → buyer", a: convA / upbA, e: convE / upbE, show: P,
         note: `sessions that became a buyer, vs ${REF} - the pieces each buyer took are a release-level row of their own` },
       // the rate is one release-level fact, so its step is collected out of
       // the groups and printed once below them rather than five times
       { label: "Units per buyer", a: upbA, e: upbE, show: R, perBuyer: true,
         note: "pieces per buyer across the release, vs what the target assumed for this many products" }]
    : [{ label: "Session → sale", a: convA, e: convE, show: P, note: `session → sale rate vs ${REF}` }];
  const info = (label, v, ref, unit, note) => rows.push({ label, value: null, note, display: fmtVal(v, unit),
    tipRows: [{ label: "Actual", value: fmtVal(v, unit) }, { label: "Reference", value: fmtVal(ref, unit) }] });
  const twoFactor = () => chainSteps([
    { label: "Sessions", a: sessA, e: sessE, show: N, note: `sessions vs ${REF}` },
    ...saleSteps,
  ]);

  let steps;
  if (g.key === "aa_email") {
    const em = emailStages(snap);
    const { delivA, opensA, clicksA } = em;
    const delivE = vsBm ? em.delivB : em.delivE, clicksE = vsBm ? em.clicksB : em.clicksE;
    const openRef = em.openRef / 100, ctorRef = em.ctorRef / 100;
    const chainable = finite(delivE) && delivE > 0 && clicksA > 0 && finite(clicksE) && clicksE > 0 && sessE > 0;
    const delivered = { label: "Delivered emails", a: delivA, e: delivE, show: N,
      note: em.spcRef
        ? `sends delivered vs the sends the ${vsBm ? "basket's" : "plan's"} AA Email sessions imply at the cohort's rates`
        : "sends delivered vs the cohort-median delivery curve" };
    const perClick = { label: "Sessions per click", a: sessA / clicksA, e: em.spcE, show: R,
      note: em.spcRef
        ? "AA Email sessions per email click vs the cohort median - traffic the clicks did not explain"
        : "AA Email sessions per email click vs the plan's expected sessions over expected clicks - traffic the clicks did not explain" };

    if (chainable && opensA > 0) {
      rows.push(...chainSteps([
        delivered,
        { label: "Open rate", a: opensA / delivA, e: openRef, show: P, note: `opens per delivered email vs ${P(openRef)}` },
        { label: "Click rate", a: clicksA / opensA, e: ctorRef, show: P, note: `clicks per opened email vs ${P(ctorRef)}` },
        perClick, ...saleSteps,
      ]));
      return { name: g.name, rows, now, exp };
    }
    if (chainable) {
      // clicks recorded but no opens: click rate per delivered email carries; open rate is context
      const clickE = clicksE / delivE;
      steps = chainSteps([
        delivered,
        { label: "Click rate", a: clicksA / delivA, e: clickE, show: P, note: `clicks per delivered email vs ${P(clickE)} - no opens recorded` },
        perClick, ...saleSteps,
      ]);
      rows.push(steps[0]);
      info("Open rate", null, em.openRef, "%", "no opens recorded - context only");
      rows.push(steps[1], steps[2], steps[3]);
      return { name: g.name, rows, now, exp };
    }
    // no delivery benchmark or no clicks yet: the stages are context and
    // sessions vs plan carries the traffic gap
    /* Two different faults, and the card used to report both as silence. The
     * feed can stop before the campaign starts, which is an ingestion problem;
     * or it can be current and no send names this release, which is a naming
     * one - HubSpot joins on the campaign code appearing in the email or
     * campaign name, so the code is what the reader needs to go and check. */
    const noSends = em.feedEndsFirst
      ? `the email feed stops at ${em.feedThrough}, before this campaign began - no sends can join it`
      : snap.campaignCode
        ? `no send names ${snap.campaignCode} - the email feed reaches ${em.feedThrough || "no date"}`
        : "no sends have joined this release yet";
    rows.push({ label: "Delivered emails", value: null, display: fmtVal(delivA, "count"),
      note: delivA > 0 ? "no delivery benchmark yet" : noSends,
      tipRows: [
        { label: "Actual", value: fmtVal(delivA, "count") },
        { label: "Reference", value: fmtVal(delivE, "count") },
        ...(em.feedThrough ? [{ label: "Feed ends", value: em.feedThrough }] : []),
      ] });
    info("Open rate", em.openA, em.openRef, "%", "context only");
    info("Click rate", em.ctorA, em.ctorRef, "%", "clicks per opened email - context only");
    info("Sessions per click", em.spcA, null, "ratio", "no expected clicks to judge against yet");
    rows.push(...chainSteps([
      { label: "Sessions", a: sessA, e: sessE, show: N,
        note: `sessions vs ${REF} - carries the whole traffic gap while the click chain has no reference` },
      ...saleSteps,
    ]));
    return { name: g.name, rows, now, exp };
  }
  if (g.key === "paid") {
    const paid = snap.paid || {};
    const day = dayElapsed(snap), of = snap.of ?? 0;
    const spendA = paid.spendToDate ?? 0;
    const budget = vsBm ? paid.benchmarkBudget : paid.spendBudget;
    // paid runs from the day after the announce: its budget's share by today
    const spendE = of > 0 && budget ? budget * paidDayFrac(snap) : null;
    if (finite(spendE) && spendE > 0 && spendA > 0 && exp > 0) {
      steps = chainSteps([
        { label: "Spend", a: spendA, e: spendE, show: (v) => fmtVal(v, "eur"), note: `spend to date vs the ${REF}'s share of budget by today` },
        { label: "Cost per secured unit", a: now / spendA, e: exp / spendE, show: (v) => (v > 0 ? fmtVal(1 / v, "eur") + " per unit" : "–"),
          note: `secured units per euro, actual vs ${REF} - the cost side of the ledger` },
      ]);
      rows.push(...steps);
      return { name: g.name, rows, now, exp };
    }
    info("Spend", spendA, spendE, "eur", "no plan or no spend yet");
    rows.push({ label: "Cost per secured unit", value: now - exp, note: snap.campaignName ? `residual: paid units vs ${REF}` : "no campaign matched - the whole paid gap",
      tipRows: [{ label: "Secured", value: fmtVal(now, "count") }, { label: "Expected", value: fmtVal(exp, "count") }] });
    return { name: g.name, rows, now, exp };
  }
  const social = snap.social || {};
  if (g.key === "aa_social") {
    info("Posts", (social.posts ?? 0) + (social.stories ?? 0), null, "count", "no reference - context only");
  }
  if (g.key === "referral_artist") {
    const of = snap.of ?? 0, day = dayElapsed(snap);
    const postsA = social.artistPosts ?? null;
    const postsE = of > 0 && social.artistPostsTarget ? (social.artistPostsTarget * day) / of : null;
    if (finite(postsA) && finite(postsE) && postsA > 0 && postsE > 0 && sessE > 0) {
      rows.push(...chainSteps([
        { label: "Posts", a: postsA, e: postsE, show: N, note: "artist-account posts vs the tier benchmark, pro-rated" },
        { label: "Sessions", a: sessA / postsA, e: sessE / postsE, show: R, note: `sessions per post vs ${REF}` },
        ...saleSteps,
      ]));
      return { name: g.name, rows, now, exp };
    }
    info("Posts", postsA, postsE, "count", "no artist-post feed or benchmark yet");
  }
  rows.push(...twoFactor());
  return { name: g.name, rows, now, exp };
}

/* Every row of the walk states a base height and grows or shrinks in
 * proportion to it, so the stack always fills its card exactly and never
 * scrolls: a short walk spreads to the foot of the card instead of stopping
 * two thirds of the way down, and a long one gives up a little height per row
 * rather than growing a scrollbar. The longest walk the page can build (every
 * AA Email stage, the split buyer row, the levels) is 22 rows, inside the tall
 * card's room at base. The bars grow with their rows, 12px to 18px thick. */
const BAR_INSET = "clamp(calc(50% - 9px), 20%, calc(50% - 6px))";
const FIT = { flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", overflow: "hidden" };
const ANCHOR_LABEL = { fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" };
const ANCHOR_NUM = { fontSize: 12.5, fontWeight: 600, textAlign: "right" };
const ROW_LABEL = { fontSize: 12, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_NUM = { fontSize: 12.5, fontWeight: 600, textAlign: "right" };

/* The walk, as data: from the target - or, with a basket, from the benchmark
 * with the stretch set aside - down every group's rows to the actual. Null
 * when there is nothing to walk: no row with a reference yet. */
function buildWaterfall(snap, groups) {
  const expTotal = snap?.hero?.expectedToday ?? 0;
  const nowTotal = snap?.hero?.now ?? 0;
  const day = snap?.day ?? 0;

  /* Off the same snapshot figures as the outcome waterfall: the list opens at
   * the benchmark, shows the stretch beneath it as the band up to the target
   * with the target's tick at its end, and walks from the benchmark with every
   * row read against the basket, so the rows sum to actual less benchmark and,
   * with the stretch, to actual less target. Absent a benchmark the list opens
   * at the target and the rows read against the plan, as everywhere else. */
  const bmTotal = snap?.hero?.benchmarkToday ?? null;
  const hasBm = !!snap?.benchmark && bmTotal !== null && bmTotal !== undefined;
  const stretchTotal = hasBm ? expTotal - bmTotal : null;
  const words = refWords("today");
  const startTotal = hasBm ? bmTotal : expTotal;

  const sections = groups.map((g) => ({ key: g.key, short: g.short, ...groupWaterfall(g, snap, hasBm) }));
  const stepRows = sections.flatMap((s) => s.rows.filter((r) => finite(r.value)));
  if (!stepRows.length) return null;
  // per-group rounding only: each group's steps sum to its own gap by
  // construction; the difference to the hero is the edition cap, left visible
  const residual = (nowTotal - startTotal) - stepRows.reduce((a, r) => a + r.value, 0);
  if (Math.abs(residual) <= 0.5) {
    const biggest = stepRows.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
    biggest.value += residual;
  }
  const capped = Math.abs(residual) > 0.5;

  // running level through every row (info rows carry the level across); each
  // row remembers its group, which is how the 2 × 2 card finds its rung
  let cum = startTotal;
  const flat = [];
  // the units-per-buyer steps are one release-level effect split across the
  // groups only because each group has its own units; they are summed and shown
  // once, after the groups and under a header of their own, so the card gains
  // one row rather than five and the row reads as the whole campaign's, not as
  // the last group's
  const perBuyerTotal = sections.reduce(
    (t, s) => t + s.rows.filter((r) => r.perBuyer && finite(r.value)).reduce((a, r) => a + r.value, 0), 0);
  const perBuyerRow = sections.flatMap((s) => s.rows).find((r) => r.perBuyer) || null;
  for (const s of sections) {
    flat.push({ header: s.name });
    for (const r of s.rows) {
      if (r.perBuyer) continue;
      if (finite(r.value)) { const from = cum; cum += r.value; flat.push({ ...r, group: s.key, short: s.short, from, to: cum }); }
      else flat.push({ ...r, group: s.key, short: s.short, level: cum });
    }
  }
  if (perBuyerRow && Math.abs(perBuyerTotal) > 0.05) {
    const from = cum; cum += perBuyerTotal;
    flat.push({ header: "All channels" });
    flat.push({ ...perBuyerRow, group: "all", value: perBuyerTotal, from, to: cum });
  }
  const levels = [expTotal, ...flat.filter((r) => r.to !== undefined).map((r) => r.to),
    ...(hasBm ? [bmTotal] : [])];
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  const X = (v) => ((v - (lo - pad)) / span) * 100;

  /* The stretch: the band from the benchmark up (or down) to the target in the
   * stretch tint, the same band the bars and the trajectory draw between the
   * two references. A planning decision rather than performance, so its
   * figure is in ink, not the step colours; the rows below read against the
   * basket, so this is the part of the gap to target that is ambition. */
  const stretchTip = hasBm ? {
    head: "Stretch",
    rows: [
      { label: words.target, value: fmt(expTotal) },
      { label: words.bm, value: fmt(bmTotal) },
      { label: "Stretch", value: fmtSigned(stretchTotal) },
      ...(snap?.benchmark?.k ? [{ label: "Uplift", value: "×" + fmt(snap.benchmark.k, 2) }] : []),
    ],
    body: "What the business asked for over and above the basket - the same even uplift in every channel and on every day. The rows below read against the basket, so this step is the part of the gap to target that is ambition rather than performance.",
  } : null;

  return { flat, X, domain: [lo - pad, hi + pad], expTotal, bmTotal, nowTotal, hasBm, day, dayText: dayLabel(snap, day), words, capped, stretchTip };
}

const targetTip = (wf) => ({
  head: `Target by ${wf.dayText}`,
  rows: [{ label: "Secured units", value: fmt(wf.expTotal) }],
});
const bmTip = (wf) => ({
  head: "Benchmark today",
  rows: [{ label: "Secured units", value: fmt(wf.bmTotal) }],
  body: "The median of the matched basket - what launches like this one typically reach by now. The rows walk from here.",
});
const actualTip = (wf) => ({
  head: "Secured to date",
  rows: [{ label: "Secured units", value: fmt(wf.nowTotal) }],
  body: wf.capped ? "The steps add up to more than the gap - the sellout caps the actual." : undefined,
});
const stepTip = (r, hasBm) => ({
  head: r.label, body: r.note,
  rows: [
    ...(r.show ? [{ label: "Actual", value: r.show(r.a) }, { label: "Reference", value: r.show(r.e) }] : []),
    { label: hasBm ? "vs benchmark" : "vs expected", value: fmtSigned(r.value, 1) + " units", color: r.value >= 0 ? C.green : C.red },
    { label: "Running total", value: fmt(r.to, 1) },
  ],
});
const infoTip = (r) => ({ head: r.label, body: r.note, rows: r.tipRows });

/* The rungs, as data: five groups of { label, v, bm, plan, unit, kind, inv,
 * note } for buildRung, off the same snapshot the waterfall walks. */
function rungModel(snap) {
  const targeted = snap?.targeted !== false;
  const fbg = snap?.funnelByGroup || {};
  const email = snap?.email || {};
  const social = snap?.social || {};
  const paid = snap?.paid || {};
  const day = dayElapsed(snap);
  const of = snap?.of ?? 0;
  const bench = !!snap?.benchmark;
  const k = snap?.benchmark?.k ?? 1;
  const bmConv = snap?.benchmark?.convByGroup || {};
  // the same two rates the waterfall view divides by, so the two tabs of this
  // card cannot describe one quantity differently
  const _upb = snap?.unitsPerBuyer || {};
  const upbActual = _upb.actual > 0 ? _upb.actual : 1;
  const upbPlan = _upb.plan > 0 ? _upb.plan : 1;
  const splitBuyRung = Math.abs(upbActual - upbPlan) > 0.001;

  const pct = (x) => (x === null || x === undefined ? null : x * 100);
  /* Sessions read the per-group benchmark the ETL pro-rated to today, not
   * benchmark.sessionsByGroup, which is the at-close figure. Conversion reads
   * the basket's conversion by today as well (conv_benchmark_today, the figure
   * the waterfall view walks against): a basket's sessions come earlier than
   * its units, so its conversion by today sits well under its conversion at
   * close, and a rung read against the at-close figure was behind on every
   * release for most of the campaign while the walk beside it said otherwise.
   * The at-close conv_benchmark is the fallback for an older snapshot. */
  const sess = (key) => {
    const g = fbg[key] || {};
    return {
      label: "Sessions", kind: "vol", unit: "count",
      v: g.sessions_actual ?? null,
      plan: g.sessions_expected ?? null,
      bm: g.sessions_benchmark ?? null,
    };
  };
  /* The waterfall view splits this into buyers and pieces per buyer, so the
     rung view has to call it the same thing rather than leaving one tab of the
     card describing the quantity two ways. The rung stays a single rate - a
     release-level multi-buy rate would be the same rung five times over, which
     is why the waterfall prints it once below the groups instead - but it is
     the buyer rate, which is the half a campaign can act on. Where plan and
     actual rates agree there is nothing to divide out and it reads as it did. */
  const conv = (key) => {
    const g = fbg[key] || {};
    const rate = (v, by) => (v === null || v === undefined ? null : pct(v / (by || 1)));
    return {
      label: splitBuyRung ? "Session → buyer" : "Session → sale",
      kind: "rate", unit: "%",
      v: rate(g.conv_actual, upbActual),
      plan: rate(g.conv_expected, upbPlan),
      bm: rate(g.conv_benchmark_today ?? g.conv_benchmark ?? bmConv[key] ?? null, upbPlan),
    };
  };

  // paid runs from the day after the announce: its budget's share by today is
  // the share of those days (paidDayFrac), the figure the tall card, the paid
  // card and the waterfall read
  const paidFrac = of > 0 ? paidDayFrac(snap) : null;
  const spendPlan = paidFrac !== null && paid.spendBudget ? paid.spendBudget * paidFrac : null;
  const spendBm = paidFrac !== null && paid.benchmarkBudget ? paid.benchmarkBudget * paidFrac : null;
  // cost per unit to date: spend over the paid group's secured units (its
  // column on the channels card), against the plan's cost per unit - the
  // target's cost per purchase, which the benchmark budget is priced at too
  const cpp = snap?.targets?.paid?.cost_per_purchase;
  const paidNow = ((snap?.channels || []).find((c) => c.key === "paid") || {}).now ?? null;
  const costPerUnit = (paid.spendToDate ?? 0) > 0 && paidNow > 0 ? paid.spendToDate / paidNow : null;
  const postsBm = of > 0 && social.artistPostsTarget ? (social.artistPostsTarget * day) / of : null;
  const cohort = snap?.benchmarks?.emailRefCohort;
  const REF_NOTE = cohort
    ? `Reference: median pooled rate across ${cohort.n} completed draw launches with sends on file (closed ${cohort.from} to ${cohort.to})`
    : "Reference: fixed default until two completed draw launches have sends on file";
  const em = emailStages(snap);
  const SPC_NOTE = em.spcRef
    ? `AA Email sessions per email click. Reference: the median sessions per click across ${cohort ? cohort.n + " " : ""}completed draw launches with sends on file - the traffic the clicks do not explain`
    : "AA Email sessions per email click. Reference: the plan's expected AA Email sessions by today over its expected clicks (delivered target × reference open rate × reference clicks per open) - the traffic the clicks do not explain";

  /* The email stage rates have no basket behind them: their reference is
   * already the cohort median, which is exactly what a benchmark is, so the
   * benchmark and the target are the same line and the ring sits on centre. */
  const groups = [
    {
      key: "aa_email", name: "AA Email", short: "Email",
      rungs: [
        // benchmark = cohort median delivered total x pooled delivery-timing
        // curve at today's pdsa (computed in the ETL as email.deliveredTarget);
        // the target lifts it by K like any other volume
        { label: "Delivered emails", kind: "vol", unit: "count",
          v: email.delivered ?? null, plan: email.deliveredTarget ?? null, bm: email.deliveredBenchmark ?? email.deliveredTarget ?? null,
          note: em.spcRef
            ? "Reference: the sends the plan's expected AA Email sessions by today imply at the cohort's open rate, clicks per open and sessions per click - a volume that fits this release's list."
            : "Benchmark: median delivered total across completed configured launches, on the pooled delivery-timing curve at today's point in the window." },
        { label: "Open rate", kind: "rate", unit: "%", v: em.openA, plan: em.openRef, bm: em.openRef,
          note: "Opens per delivered email. " + REF_NOTE + "." },
        { label: "Click rate", kind: "rate", unit: "%", v: em.ctorA, plan: em.ctorRef, bm: em.ctorRef,
          note: "Clicks per opened email (click-to-open). " + REF_NOTE + "." },
        { label: "Sessions per click", kind: "rate", unit: "ratio", v: em.spcA, plan: em.spcE, bm: em.spcE,
          note: SPC_NOTE + "." },
        conv("aa_email"),
      ],
    },
    {
      key: "aa_social", name: "AA Meta", short: "Meta",
      rungs: [
        // the Notion log records a row per post and no format, so there is no
        // post/story split to show when it is the source; the Emplifi export
        // carries one, and says so
        { label: "Posts", kind: "vol", unit: "count",
          v: (social.posts ?? 0) + (social.stories ?? 0), plan: null, bm: null,
          note: social.postsSource === "notion"
            ? `${fmt(social.posts ?? 0)} posts to date, from the Notion log`
            : `${fmt(social.posts ?? 0)} posts + ${fmt(social.stories ?? 0)} stories to date` },
        sess("aa_social"),
        conv("aa_social"),
      ],
    },
    {
      key: "referral_artist", name: "Referral artist", short: "Artist",
      rungs: [
        // artist-account posts from the Notion log; benchmark = tier benchmark
        // (median posts among completed campaigns in the same Referral Artist
        // tier) pro-rated by days elapsed. Neutral until the feed/benchmark exist.
        { label: "Posts", kind: "vol", unit: "count",
          v: social.artistPosts ?? null, plan: postsBm, bm: postsBm },
        sess("referral_artist"),
        conv("referral_artist"),
      ],
    },
    {
      key: "search_direct_other", name: "Search / direct / other", short: "Direct etc.",
      rungs: [sess("search_direct_other"), conv("search_direct_other")],
    },
    {
      key: "paid", name: "Paid", short: "Paid",
      rungs: [
        { label: "Spend", kind: "vol", unit: "eur", v: paid.spendToDate ?? null, plan: spendPlan, bm: spendBm,
          note: "Spend to date against the budget's share of the days paid runs, the day after the announce to the close. The benchmark budget is the basket's paid spend on the same clock." },
        { label: "Cost per secured unit", kind: "rate", unit: "eur", inv: true,
          v: costPerUnit, plan: cpp ?? null, bm: cpp ?? null,
          note: "Spend to date over paid secured units to date, against the plan's cost per unit (the target's cost per purchase). The paid cards price a converting entry instead, which is a different quantity. Lower is better, so cheap sits right." },
      ],
    },
  ];
  return { targeted, groups, bench, k };
}

/* The tall card's funnel view: the groups stacked, one centre line behind them. */
function RungStack({ m }) {
  const { groups, bench, k } = m;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", gap: GROUP_GAP }}>
        {/* One centre line behind every group, so the rungs read as one scale.
            It has to sit on the middle of the TRACK column, not the middle of
            the row: inset by the label and the delta plus their gaps. The
            reference tone when there is a basket to name, neutral grey when
            there is not. */}
        <div style={{ position: "absolute", left: TRACK_L, right: TRACK_R, top: 0, bottom: 0, pointerEvents: "none" }}>
          <div style={{
            position: "absolute", left: "50%", top: 0, bottom: 0,
            width: bench ? 1.5 : 1, marginLeft: bench ? -0.75 : -0.5,
            background: bench ? C.refLine : GUIDE,
          }} />
        </div>
        {groups.map((g) => (
          <div key={g.name} style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
            <div style={{ height: 24, flex: "0 0 24px", display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap" }}>{g.name}</div>
            </div>
            {g.rungs.map((raw) => {
              const r = buildRung(raw, bench, k);
              return <Rung key={r.label} r={r} bench={bench} />;
            })}
          </div>
        ))}
      </div>
      <RungKey bench={bench} />
    </div>
  );
}

/* `horizon` is accepted and ignored: this card is always the Today horizon
 * (BENCHMARK_SPEC 2), so the page toggle must not reach it. `only` pins one
 * view and drops the toggle: the 2 × 2 card falls back to it when there is no
 * walk to draw beside the rungs. */
export default function FunnelByChannel({ snap, horizon, only }) {
  const targeted = snap?.targeted !== false;
  // waterfall leads when there is a plan to step from; without targets only the
  // funnel's actual side exists
  const home = only || (targeted ? "wf" : "funnel");
  const [view, setView] = React.useState(home);
  React.useEffect(() => setView(home), [snap?.id, home]);
  const m = rungModel(snap);
  const wf = view === "wf" ? buildWaterfall(snap, m.groups) : null;

  return (
    <Card
      tall
      dot={GROUP_DOTS.funnel}
      title="Funnel by channel"
      right={only ? null : targeted ? (
        <span className="seg">
          <button className={view === "funnel" ? "active" : ""} onClick={() => setView("funnel")}
            title="Each funnel metric as a deviation: target down the centre, benchmark as a dotted tick, actual as a dot">Funnel</button>
          <button className={view === "wf" ? "active" : ""} onClick={() => setView("wf")}
            title="Waterfall from expected to actual secured units today, stepped by the same funnel components">Waterfall</button>
        </span>
      ) : (
        <span style={{ fontSize: 11.5, color: C.muted }} title="Grey dots: no reference to judge against until targets are set. The number is the actual.">actuals · no targets</span>
      )}
    >
      <div className="spacer-16" />
      {view === "wf"
        ? (wf ? <Walk wf={wf} layout={WALK_TALL} /> : <div className="empty-state">No funnel data yet</div>)
        : <RungStack m={m} />}
    </Card>
  );
}

/* The 2 × 2 card: the waterfall and the funnel on the same rows, so a step's
 * units and its stage's deviation read across one line with the label shared
 * between them. The walk's rows lead; each finds its rung by label in its own
 * group (the buyer row under All channels has a rung of its own), and a row
 * the funnel has no rung for keeps its rung cells empty. The rung's centre
 * line runs through the group rows only, never through the anchors, which are
 * levels of the walk and not stages. Without a walk to draw - no targets, or
 * no row with a reference yet - the card is the tall card's funnel view at
 * this size. */

/* ---- the waterfall view, in both cards -----------------------------------
 * The walk opens at the benchmark, with the stretch beneath it as the band up
 * to the target and the target's tick at its end, and steps down every
 * channel's rows to the actual. Grey 1px drops carry the running level from
 * each row to the next, so the walk reads as one line, as the outcome
 * waterfall draws it (BENCHMARK_SPEC 9). The channels are blocks of rows
 * rather than rows of their own: the 2 × 2 card names them in a column to
 * the left and keeps a figure column, running the bars across the card on a
 * unit axis; the tall card has neither column, so its row labels carry the
 * channel where the label alone would not say it (Email sessions, Paid spend
 * - the email chain's own stages and the release-level buyer row stand as they
 * are), a row's figures are in its popup, on the bar or on its name, and the
 * levels print theirs beside their label. Pointing at a name lights its bar
 * and pointing at a bar lights its name; a channel's name lights every row it
 * has. */
const WALK_TALL = { group: 0, label: 172, delta: 0, gap: 8, axis: false };
const WALK_WIDE = { group: 118, label: 112, delta: 56, gap: 10, axis: true, nameSize: 12.5 };
const HOT_RING = "0 0 0 2px rgba(20,20,19,.35)";
const HOT_DOT = "#a9a59a";
/* labels that say which channel they are, or belong to no channel */
const SELF_NAMED = new Set(["Delivered emails", "Open rate", "Click rate", "Sessions per click", "Units per buyer"]);
const withChannel = (r) => (SELF_NAMED.has(r.label) || !r.short ? r.label : `${r.short} ${r.label[0].toLowerCase()}${r.label.slice(1)}`);

/* The walk as blocks: the opening levels, one block per channel, the closing
 * level. Every row carries the running level in and out, which is where its
 * drops are drawn from and to. */
function walkBlocks(wf) {
  const { flat, expTotal, bmTotal, nowTotal, hasBm, words } = wf;
  const open = hasBm ? [
    { id: "bm", kind: "level", base: 26, label: words.bm, value: bmTotal, level: bmTotal, tip: bmTip(wf), color: C.refLine, dotted: true },
    // the stretch: the band from the benchmark to the target, the target's tick
    // at its end; the walk goes on from the benchmark
    { id: "stretch", kind: "stretch", base: 24, label: "Stretch to target", from: bmTotal, to: expTotal, value: expTotal, level: bmTotal,
      tip: wf.stretchTip, targetTip: targetTip(wf) },
  ] : [
    { id: "target", kind: "level", base: 26, label: words.target, value: expTotal, level: expTotal, tip: targetTip(wf), color: C.refLine },
  ];
  const groups = [];
  for (const r of flat) {
    if (r.header) { groups.push({ name: r.header, rows: [] }); continue; }
    const g = groups[groups.length - 1];
    const step = r.to !== undefined;
    g.rows.push({ id: `${g.name}:${g.rows.length}`, group: g.name, kind: step ? "step" : "info", base: 24, r, level: step ? r.to : r.level, full: withChannel(r) });
  }
  const close = [{ id: "actual", kind: "level", base: 26, label: "Actual today", value: nowTotal, level: nowTotal, tip: actualTip(wf), color: C.blue }];
  const all = [...open, ...groups.flatMap((g) => g.rows), ...close];
  let lvl = null;
  for (const row of all) { row.entry = lvl; lvl = row.level; row.exit = lvl; }
  all[all.length - 1].exit = null;
  return { open, groups, close };
}

/* the grey drops: from the level a row enters at down to its own mark, and
 * from the level it leaves at down to the next row */
function Drops({ entry, exit, X }) {
  const line = (level, top, bottom) => (
    <div style={{ position: "absolute", left: `${X(level)}%`, top, bottom, width: 1, marginLeft: -0.5, background: C.planGrey }} />
  );
  return (
    <>
      {entry !== null && entry !== undefined && line(entry, 0, "50%")}
      {exit !== null && exit !== undefined && line(exit, "50%", 0)}
    </>
  );
}

/* the unit axis: a round step that gives the walk's range at most seven marks */
function niceTicks([lo, hi]) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  const step = steps.find((st) => (hi - lo) / st <= 7) || steps[steps.length - 1];
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

function Walk({ wf, layout: L }) {
  const tipApi = useTip();
  const [hot, setHot] = React.useState(null);   // { row } or { group }: what the pointer is on
  const { open, groups, close } = walkBlocks(wf);
  const { X, hasBm } = wf;
  // the columns: the channel name (2 × 2 only), the label, the track, the figure (2 × 2 only)
  const cols = `${L.group ? `${L.group}px ` : ""}${L.label}px 1fr${L.delta ? ` ${L.delta}px` : ""}`;
  const col = (n) => n + (L.group ? 1 : 0);   // n: 1 label, 2 track, 3 figure
  const trackL = (L.group ? L.group + COL_GAP : 0) + L.label + COL_GAP, trackR = L.delta ? L.delta + COL_GAP : 0;
  const lit = (row) => !!hot && ((hot.row !== undefined && hot.row === row.id) || (hot.group !== undefined && hot.group === row.group));
  // the popup and the highlight from one pair of handlers
  const point = (at, tip) => {
    const t = tipApi.props(tip);
    return {
      onMouseEnter: (e) => { setHot(at); if (t.onMouseEnter) t.onMouseEnter(e); },
      onMouseLeave: (e) => { setHot(null); if (t.onMouseLeave) t.onMouseLeave(e); },
    };
  };
  const grid = (base, gap = 0) => ({
    flex: `${base + gap} 1 ${base + gap}px`, minHeight: 0, paddingTop: gap,
    display: "grid", gridTemplateColumns: cols, columnGap: COL_GAP, alignItems: "center",
  });
  const bar = (row, from, to, color, tip) => (
    <div {...point({ row: row.id }, tip)} style={{
      position: "absolute", top: BAR_INSET, bottom: BAR_INSET,
      left: `${X(Math.min(from, to))}%`, width: `${Math.max(1.2, Math.abs(X(to) - X(from)))}%`,
      background: color, borderRadius: 3, boxShadow: lit(row) ? HOT_RING : "none",
    }} />
  );
  const tick = (value, color, dotted, tip) => (
    <div style={{ position: "absolute", left: 0, right: 0, top: "50%", marginTop: -7, height: 14 }}>
      <Tick pct={X(value)} color={color} dotted={dotted} tip={tip} />
    </div>
  );

  // a level, or the stretch, on a row of its own: the label spans the name and
  // the label columns, and carries the figure where there is no column for it
  const levelRow = (row, gap = 0) => {
    const stretch = row.kind === "stretch";
    const v = fmt(row.value);
    return (
      <div key={row.id} style={grid(row.base, gap)}>
        <div {...point({ row: row.id }, row.tip)} style={{
          gridColumn: L.group ? "1 / 3" : "1", overflow: "hidden", textOverflow: "ellipsis",
          ...(stretch ? { fontSize: 12, color: C.muted, whiteSpace: "nowrap" } : ANCHOR_LABEL),
        }}>
          {row.label}
          {!L.delta && <span className="num" style={{ fontWeight: 600, color: C.ink, marginLeft: 6 }}>{v}</span>}
        </div>
        <div style={{ position: "relative", alignSelf: "stretch" }}>
          <Drops entry={row.entry} exit={row.exit} X={X} />
          {stretch ? (
            <>
              {bar(row, row.from, row.to, C.refStretch, row.tip)}
              {tick(row.to, C.refLine, false, row.targetTip)}
            </>
          ) : tick(row.value, row.color, !!row.dotted, row.tip)}
        </div>
        {L.delta ? <div className="num" style={ANCHOR_NUM}>{v}</div> : null}
      </div>
    );
  };

  // one channel: its rows share the block's height in proportion to their base
  // heights, its name at the top left where the layout has a column for it
  const channelBlock = (g) => {
    const sum = g.rows.reduce((a, r) => a + r.base, 0);
    return (
      <div key={g.name} style={{ ...grid(sum, L.gap), gridTemplateRows: g.rows.map((r) => `minmax(0, ${r.base}fr)`).join(" ") }}>
        {L.group ? (
          <div {...point({ group: g.name }, null)} style={{
            gridColumn: 1, gridRow: "1 / -1", alignSelf: "start", paddingTop: 4,
            fontSize: L.nameSize, fontWeight: 600, lineHeight: 1.25,
          }}>
            {g.name}
          </div>
        ) : null}
        {g.rows.map((row, i) => {
          const r = row.r, step = row.kind === "step", on = lit(row);
          // the popup names the row in full, whichever card it is on
          const tip = { ...(step ? stepTip(r, hasBm) : infoTip(r)), head: row.full };
          const at = { gridRow: i + 1 };
          return (
            <React.Fragment key={row.id}>
              <div {...point({ row: row.id }, tip)} style={{ ...at, gridColumn: col(1), ...ROW_LABEL, color: on ? C.ink : C.muted }}>
                {L.group ? r.label : row.full}
              </div>
              <div style={{ ...at, gridColumn: col(2), position: "relative", alignSelf: "stretch" }}>
                <Drops entry={row.entry} exit={row.exit} X={X} />
                {step ? bar(row, r.from, r.to, r.value >= 0 ? C.wfGreen : C.red, tip) : (
                  <div {...point({ row: row.id }, tip)} style={{
                    position: "absolute", left: `${X(r.level)}%`, top: "50%", marginTop: -5, width: 10, height: 10, marginLeft: -5,
                    borderRadius: "50%", background: on ? HOT_DOT : NEUTRAL_DOT, boxShadow: RING,
                  }} />
                )}
              </div>
              {L.delta ? (
                <div className="num" style={{ ...at, gridColumn: col(3), ...ROW_NUM, color: step ? (r.value >= 0 ? C.green : C.red) : C.muted }}>
                  {step ? fmtSigned(r.value, 1) : (r.display ?? "–")}
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  const ticks = L.axis ? niceTicks(wf.domain) : [];
  return (
    <>
      <div style={FIT}>
        {L.axis && (
          <div style={{ position: "absolute", left: trackL, right: trackR, top: 0, bottom: 0, pointerEvents: "none" }}>
            {ticks.map((t) => <div key={t} style={{ position: "absolute", left: `${X(t)}%`, top: 0, bottom: 0, width: 1, background: C.track }} />)}
          </div>
        )}
        {open.map((row) => levelRow(row))}
        {groups.map(channelBlock)}
        {close.map((row) => levelRow(row, L.gap))}
      </div>
      {L.axis && (
        <div style={{ flex: "0 0 18px", position: "relative", marginLeft: trackL, marginRight: trackR, fontSize: 11, color: C.muted }}>
          {ticks.map((t) => (
            <span key={t} className="num" style={{ position: "absolute", left: `${X(t)}%`, top: 4, transform: "translateX(-50%)" }}>{fmt(t)}</span>
          ))}
        </div>
      )}
    </>
  );
}

/* The 2 × 2 card: the waterfall view with two columns by two rows of room.
 * Without a walk to draw - no targets, or no row with a reference yet - it is
 * the tall card's funnel view at this size. */
export function FunnelByChannelWide({ snap }) {
  const m = rungModel(snap);
  const wf = m.targeted ? buildWaterfall(snap, m.groups) : null;
  if (!wf) return <FunnelByChannel snap={snap} only="funnel" />;
  return (
    <Card dot={GROUP_DOTS.funnel} title="Funnel by channel"
      right={<span style={{ fontSize: 11.5, color: C.muted }}>waterfall · secured units, day {wf.day}</span>}>
      <div className="spacer-16" />
      <Walk wf={wf} layout={WALK_WIDE} />
    </Card>
  );
}
