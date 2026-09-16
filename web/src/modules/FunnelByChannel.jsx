/* Funnel by channel (spec §4.4, LE relabel per §6). Tall card (1 col × 2 rows).
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
 *   Paid      - Spend vs pro-rata budget (un-inverted per artboard) · Cost per
 *               entry vs cost-per-purchase target × 0.8 (inverted)
 *
 * The target runs down the centre of every rung, the dot is the actual, and the
 * benchmark is a dotted tick wherever the basket's own figure lands on the same
 * log scale - the rung's form of the dotted outline every bar carries
 * (BENCHMARK_SPEC 7). ×4 either way fills the rung; the printed figure and its
 * RAG are against the target. Volume rungs (delivered emails, posts, sessions,
 * spend) carry the even uplift, so their target is the benchmark × K and the
 * tick sits 1/K off the centre; rate rungs (open, click, sessions per click,
 * session → sale, cost per entry) are held at the benchmark, so their tick sits
 * on the centre line. Without a basket the plan is the centre, the line goes to
 * the neutral plan grey and there is no tick.
 * Inverted metrics (cost per entry) are placed by their judged direction, so
 * the ratio is inverted before it is positioned - cheap right, dear left.
 * Null value or missing/zero reference → neutral: centred grey dot, delta '–'. */
import React from "react";
import {
  Card, GROUP_DOTS, C, fmt, fmtSigned, fmtMoney, MINUS, useTip,
  rungGeom, rungPos, RungTrack, RungKey, Tick, refWords,
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
      <div style={{ position: "relative" }}>
        <RungTrack dev={r.dev} bmPos={r.bmPos} up={r.up} neutral={r.neutral} bench={bench} />
        {r.beyond && (
          /* the dot ran off the scale - say so at the end it ran off, rather
             than letting it pile up silently against the clamp */
          <span style={{
            position: "absolute", top: -1, fontSize: 11, lineHeight: "12px", color: C.muted,
            ...(r.dev >= 96 ? { left: "calc(100% + 2px)" } : { right: "calc(100% + 2px)" }),
          }}>
            {r.dev >= 96 ? "›" : "‹"}
          </span>
        )}
      </div>
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
 * open rate, clicks per opened email and sessions per click. Rate references
 * are the ETL's cohort medians (fixed defaults until two launches qualify);
 * the sessions-per-click reference is the plan's expected AA Email sessions by
 * today over its expected clicks (delivered target x reference open rate x
 * reference clicks per open), so the chain's expected side multiplies out to
 * the plan's expected sessions. Percentages are 0-100 here. */
function emailStages(snap) {
  const email = snap?.email || {};
  const b = snap?.benchmarks || {};
  const fbg = (snap?.funnelByGroup || {}).aa_email || {};
  const openRef = b.emailOpenRateRef ?? 19.6;
  const clickRef = b.emailClickRateRef ?? 4.3;
  const ctorRef = b.emailClickToOpenRef ?? (clickRef / openRef) * 100;
  const delivA = email.delivered ?? 0, delivE = email.deliveredTarget ?? null;
  const opensA = email.opened ?? 0, clicksA = email.clicked ?? 0;
  const sessA = fbg.sessions_actual ?? 0, sessE = fbg.sessions_expected ?? null;
  const clicksE = finite(delivE) && delivE > 0 ? delivE * (openRef / 100) * (ctorRef / 100) : null;
  /* Zero sends has two very different causes and the card used to report both
   * the same way. Marketing sent nothing, or the email feed stops before this
   * campaign even starts - an ingestion fault that says nothing about the
   * campaign. feedThrough is the last send anywhere in the file, so the second
   * case is the one that can be proved. */
  const feedThrough = email.feedThrough ?? null;
  const feedEndsFirst = !!(feedThrough && snap?.windowStart && feedThrough < snap.windowStart);
  return {
    delivA, delivE, opensA, clicksA, sessA, sessE, clicksE, openRef, clickRef, ctorRef,
    feedThrough, feedEndsFirst,
    openA: delivA > 0 ? (opensA / delivA) * 100 : null,
    ctorA: opensA > 0 ? (clicksA / opensA) * 100 : null,
    spcA: clicksA > 0 ? sessA / clicksA : null,
    spcE: finite(clicksE) && clicksE > 0 && finite(sessE) ? sessE / clicksE : null,
  };
}

function groupWaterfall(g, snap) {
  const ch = (snap.channels || []).find((c) => c.key === g.key) || {};
  const now = ch.now ?? 0, exp = ch.exp ?? 0;
  const fbg = (snap.funnelByGroup || {})[g.key] || {};
  const sessA = fbg.sessions_actual ?? 0, sessE = fbg.sessions_expected ?? 0;
  const convA = fbg.conv_actual ?? 0, convE = fbg.conv_expected ?? 0;
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
         note: "sessions that became a buyer, vs plan - the pieces each buyer took are a release-level row of their own" },
       // the rate is one release-level fact, so its step is collected out of
       // the groups and printed once below them rather than five times
       { label: "Units per buyer", a: upbA, e: upbE, show: R, perBuyer: true,
         note: "pieces per buyer across the release, vs what the target assumed for this many products" }]
    : [{ label: "Session → sale", a: convA, e: convE, show: P, note: "session → sale rate vs plan" }];
  const info = (label, v, ref, unit, note) => rows.push({ label, value: null, note, display: fmtVal(v, unit),
    tipRows: [{ label: "Actual", value: fmtVal(v, unit) }, { label: "Reference", value: fmtVal(ref, unit) }] });
  const twoFactor = () => chainSteps([
    { label: "Sessions", a: sessA, e: sessE, show: N, note: "sessions vs plan" },
    ...saleSteps,
  ]);

  let steps;
  if (g.key === "aa_email") {
    const em = emailStages(snap);
    const { delivA, delivE, opensA, clicksA, clicksE } = em;
    const openRef = em.openRef / 100, ctorRef = em.ctorRef / 100;
    const chainable = finite(delivE) && delivE > 0 && clicksA > 0 && finite(clicksE) && clicksE > 0 && sessE > 0;
    const delivered = { label: "Delivered emails", a: delivA, e: delivE, show: N,
      note: "sends delivered vs the cohort-median delivery curve" };
    const perClick = { label: "Sessions per click", a: sessA / clicksA, e: sessE / clicksE, show: R,
      note: "AA Email sessions per email click vs the plan's expected sessions over expected clicks - traffic the clicks did not explain" };

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
        note: "sessions vs plan - carries the whole traffic gap while the click chain has no reference" },
      ...saleSteps,
    ]));
    return { name: g.name, rows, now, exp };
  }
  if (g.key === "paid") {
    const paid = snap.paid || {};
    const day = snap.day ?? 0, of = snap.of ?? 0;
    const spendA = paid.spendToDate ?? 0;
    const spendE = of > 0 && paid.spendBudget ? (paid.spendBudget * day) / of : null;
    if (finite(spendE) && spendE > 0 && spendA > 0 && exp > 0) {
      steps = chainSteps([
        { label: "Spend", a: spendA, e: spendE, show: (v) => fmtVal(v, "eur"), note: "spend to date vs the plan's share of budget by today" },
        { label: "Cost per entry", a: now / spendA, e: exp / spendE, show: (v) => (v > 0 ? fmtVal(1 / v, "eur") + " per unit" : "–"),
          note: "secured units per pound, actual vs plan - the cost-per-entry side of the ledger" },
      ]);
      rows.push(...steps);
      return { name: g.name, rows, now, exp };
    }
    info("Spend", spendA, spendE, "eur", "no plan or no spend yet");
    rows.push({ label: "Cost per entry", value: now - exp, note: snap.campaignName ? "residual: paid units vs plan" : "no campaign matched - the whole paid gap",
      tipRows: [{ label: "Secured", value: fmtVal(now, "count") }, { label: "Expected", value: fmtVal(exp, "count") }] });
    return { name: g.name, rows, now, exp };
  }
  const social = snap.social || {};
  if (g.key === "aa_social") {
    info("Posts", (social.posts ?? 0) + (social.stories ?? 0), null, "count", "no reference - context only");
  }
  if (g.key === "referral_artist") {
    const of = snap.of ?? 0, day = snap.day ?? 0;
    const postsA = social.artistPosts ?? null;
    const postsE = of > 0 && social.artistPostsTarget ? (social.artistPostsTarget * day) / of : null;
    if (finite(postsA) && finite(postsE) && postsA > 0 && postsE > 0 && sessE > 0) {
      rows.push(...chainSteps([
        { label: "Posts", a: postsA, e: postsE, show: N, note: "artist-account posts vs the tier benchmark, pro-rated" },
        { label: "Sessions", a: sessA / postsA, e: sessE / postsE, show: R, note: "sessions per post vs plan" },
        ...saleSteps,
      ]));
      return { name: g.name, rows, now, exp };
    }
    info("Posts", postsA, postsE, "count", "no artist-post feed or benchmark yet");
  }
  rows.push(...twoFactor());
  return { name: g.name, rows, now, exp };
}

function FunnelWaterfall({ snap, groups }) {
  const tipApi = useTip();
  const expTotal = snap?.hero?.expectedToday ?? 0;
  const nowTotal = snap?.hero?.now ?? 0;
  const day = snap?.day ?? 0;

  const sections = groups.map((g) => groupWaterfall(g, snap));
  const stepRows = sections.flatMap((s) => s.rows.filter((r) => finite(r.value)));
  if (!stepRows.length) return <div className="empty-state">No funnel data yet</div>;
  // per-group rounding only: each group's steps sum to its own gap by
  // construction; the difference to the hero is the edition cap, left visible
  const residual = (nowTotal - expTotal) - stepRows.reduce((a, r) => a + r.value, 0);
  if (Math.abs(residual) <= 0.5) {
    const biggest = stepRows.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
    biggest.value += residual;
  }
  const capped = Math.abs(residual) > 0.5;

  // running level through every row (info rows carry the level across)
  let cum = expTotal;
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
      if (finite(r.value)) { const from = cum; cum += r.value; flat.push({ ...r, from, to: cum }); }
      else flat.push({ ...r, level: cum });
    }
  }
  if (perBuyerRow && Math.abs(perBuyerTotal) > 0.05) {
    const from = cum; cum += perBuyerTotal;
    flat.push({ header: "All channels" });
    flat.push({ ...perBuyerRow, value: perBuyerTotal, from, to: cum });
  }
  /* The same grammar as the outcome waterfall, off the same snapshot figures:
   * the target's row carries the benchmark as a dotted tick beside the target's
   * own, so the reader sees how far the business asked for above the basket
   * without a row of its own for it. Absent a benchmark there is no tick, as
   * everywhere else. */
  const bmTotal = snap?.hero?.benchmarkToday ?? null;
  const hasBm = !!snap?.benchmark && bmTotal !== null && bmTotal !== undefined;
  const stretchTotal = hasBm ? expTotal - bmTotal : null;
  const words = refWords("today");

  const levels = [expTotal, ...flat.filter((r) => r.to !== undefined).map((r) => r.to),
    ...(hasBm ? [bmTotal] : [])];
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  const X = (v) => ((v - (lo - pad)) / span) * 100;

  /* Every row states a base height and grows in proportion to it, so a short
   * funnel spreads to the foot of the card instead of stopping two thirds of the
   * way down, and a long one keeps its base heights and scrolls. The bars grow
   * with their rows between 12px and 18px thick. */
  const ROW = (base) => ({ flex: `${base} 0 ${base}px`, minHeight: base });
  const BAR_INSET = "clamp(calc(50% - 9px), 22%, calc(50% - 6px))";

  const anchorRow = (label, value, tip, color = C.refLine, extra = null) => (
    <div style={{ ...ROW(28), display: "grid", gridTemplateColumns: GRID, gap: COL_GAP, alignItems: "center" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ position: "relative", height: 16 }}>
        {extra}
        <div {...tipApi.props(tip)} style={{ position: "absolute", left: `${X(value)}%`, top: -2, bottom: -2, width: 2, background: color }} />
      </div>
      <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{fmt(value)}</div>
    </div>
  );

  return (
    /* Two anchor rows were added above Target today, which on a five-group
       funnel is enough to push Actual today past the bottom of the card. The
       rows were trimmed to absorb most of it; the scroll is the guarantee that
       the closing anchor is never simply cut off on a release with more groups
       or more stages than this one. */
    <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", overflowY: "auto" }}>
      {anchorRow("Target today", expTotal, {
        head: `Target by day ${day}`,
        rows: [
          { label: "Secured units", value: fmt(expTotal) },
          ...(hasBm ? [
            { label: words.bm, value: fmt(bmTotal) },
            { label: "Stretch", value: fmtSigned(stretchTotal) },
            ...(snap?.benchmark?.k ? [{ label: "Uplift", value: "×" + fmt(snap.benchmark.k, 2) }] : []),
          ] : []),
        ],
        body: hasBm
          ? "The stretch is what the business asked for over and above the basket - the same even uplift in every channel and on every day."
          : undefined,
      }, C.refLine, hasBm ? (
        <Tick pct={X(bmTotal)} color={C.refLine} dotted tip={{
          head: "Benchmark today",
          rows: [{ label: "Secured units", value: fmt(bmTotal) }],
          body: "The median of the matched basket - what launches like this one typically reach by now.",
        }} />
      ) : null)}
      {flat.map((r, i) => r.header ? (
        <div key={"h" + i} style={{ ...ROW(27), display: "flex", alignItems: "flex-end", paddingBottom: 4 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{r.header}</div>
        </div>
      ) : r.to !== undefined ? (
        <div key={r.label + i} style={{ ...ROW(22), display: "grid", gridTemplateColumns: GRID, gap: COL_GAP, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
          <div style={{ position: "relative", alignSelf: "stretch" }}>
            <div {...tipApi.props({
              head: r.label, body: r.note,
              rows: [
                ...(r.show ? [{ label: "Actual", value: r.show(r.a) }, { label: "Reference", value: r.show(r.e) }] : []),
                { label: "vs expected", value: fmtSigned(r.value, 1) + " units", color: r.value >= 0 ? C.green : C.red },
                { label: "Running total", value: fmt(r.to, 1) },
              ],
            })} style={{
              position: "absolute", top: BAR_INSET, bottom: BAR_INSET,
              left: `${X(Math.min(r.from, r.to))}%`,
              width: `${Math.max(1.2, Math.abs(X(r.to) - X(r.from)))}%`,
              background: r.value >= 0 ? C.wfGreen : C.red, borderRadius: 3,
            }} />
          </div>
          <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: r.value >= 0 ? C.green : C.red }}>
            {fmtSigned(r.value, 1)}
          </div>
        </div>
      ) : (
        <div key={r.label + i} style={{ ...ROW(22), display: "grid", gridTemplateColumns: GRID, gap: COL_GAP, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
          <div style={{ position: "relative", alignSelf: "stretch" }}>
            <div {...tipApi.props({ head: r.label, body: r.note, rows: r.tipRows })} style={{
              position: "absolute", left: `${X(r.level)}%`, top: "50%", marginTop: -5, width: 10, height: 10, marginLeft: -5,
              borderRadius: "50%", background: NEUTRAL_DOT, boxShadow: RING,
            }} />
          </div>
          <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: C.muted }}>{r.display ?? "–"}</div>
        </div>
      ))}
      {anchorRow("Actual today", nowTotal, {
        head: "Secured to date",
        rows: [{ label: "Secured units", value: fmt(nowTotal) }],
        body: capped ? "The steps add up to more than the gap - the sellout caps the actual." : undefined,
      }, C.orange)}
    </div>
  );
}

/* `horizon` is accepted and ignored: this card is always the Today horizon
 * (BENCHMARK_SPEC 2), so the page toggle must not reach it. */
export default function FunnelByChannel({ snap, horizon }) {
  const targeted = snap?.targeted !== false;
  // waterfall leads when there is a plan to step from; without targets only the
  // funnel's actual side exists
  const [view, setView] = React.useState(targeted ? "wf" : "funnel");
  React.useEffect(() => setView(targeted ? "wf" : "funnel"), [snap?.id, targeted]);
  const fbg = snap?.funnelByGroup || {};
  const email = snap?.email || {};
  const social = snap?.social || {};
  const paid = snap?.paid || {};
  const day = snap?.day ?? 0;
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
   * benchmark.sessionsByGroup, which is the at-close figure. Conversion is a
   * rate held at the benchmark, so either source gives the same number. */
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
      bm: rate(g.conv_benchmark ?? bmConv[key] ?? null, upbPlan),
    };
  };

  const clock = of > 0 ? day / of : null;
  const spendPlan = clock !== null && paid.spendBudget ? paid.spendBudget * clock : null;
  const spendBm = clock !== null && paid.benchmarkBudget ? paid.benchmarkBudget * clock : null;
  const cpp = snap?.targets?.paid?.cost_per_purchase;
  const cpeRef = cpp ? cpp * 0.8 : null;
  const postsBm = of > 0 && social.artistPostsTarget ? (social.artistPostsTarget * day) / of : null;
  const cohort = snap?.benchmarks?.emailRefCohort;
  const REF_NOTE = cohort
    ? `Reference: median pooled rate across ${cohort.n} completed draw launches with sends on file (closed ${cohort.from} to ${cohort.to})`
    : "Reference: fixed default until two completed draw launches have sends on file";
  const em = emailStages(snap);
  const SPC_NOTE = "AA Email sessions per email click. Reference: the plan's expected AA Email sessions by today over its expected clicks (delivered target × reference open rate × reference clicks per open) - the traffic the clicks do not explain";

  /* The email stage rates have no basket behind them: their reference is
   * already the cohort median, which is exactly what a benchmark is, so the
   * benchmark and the target are the same line and the ring sits on centre. */
  const groups = [
    {
      key: "aa_email", name: "AA Email",
      rungs: [
        // benchmark = cohort median delivered total x pooled delivery-timing
        // curve at today's pdsa (computed in the ETL as email.deliveredTarget);
        // the target lifts it by K like any other volume
        { label: "Delivered emails", kind: "vol", unit: "count",
          v: email.delivered ?? null, plan: email.deliveredTarget ?? null, bm: email.deliveredTarget ?? null,
          note: "Benchmark: median delivered total across completed configured launches, on the pooled delivery-timing curve at today's point in the window." },
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
      key: "aa_social", name: "AA Meta",
      rungs: [
        { label: "Posts", kind: "vol", unit: "count",
          v: (social.posts ?? 0) + (social.stories ?? 0), plan: null, bm: null,
          note: `${fmt(social.posts ?? 0)} posts + ${fmt(social.stories ?? 0)} stories to date` },
        sess("aa_social"),
        conv("aa_social"),
      ],
    },
    {
      key: "referral_artist", name: "Referral artist",
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
      key: "search_direct_other", name: "Search / direct / other",
      rungs: [sess("search_direct_other"), conv("search_direct_other")],
    },
    {
      key: "paid", name: "Paid",
      rungs: [
        { label: "Spend", kind: "vol", unit: "eur", v: paid.spendToDate ?? null, plan: spendPlan, bm: spendBm,
          note: "Budget × share of days elapsed. The benchmark budget is the basket's paid spend on the same clock." },
        { label: "Cost per entry", kind: "rate", unit: "eur", inv: true,
          v: paid.l3dCpe ?? null, plan: cpeRef, bm: cpeRef,
          note: "Last 3 days; reference = paid cost-per-purchase target × 0.8. Lower is better, so cheap sits right." },
      ],
    },
  ];

  return (
    <Card
      tall
      dot={GROUP_DOTS.funnel}
      title="Funnel by channel"
      right={targeted ? (
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
      {view === "wf" ? <FunnelWaterfall snap={snap} groups={groups} /> : (
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
      )}
    </Card>
  );
}
