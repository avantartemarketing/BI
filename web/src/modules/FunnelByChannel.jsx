/* Funnel by channel (spec §4.4, LE relabel per §6). Tall card (1 col × 2 rows).
 * Five display groups; rungs are built from real snapshot data instead of the
 * mock's static list:
 *   AA Email  - Delivered emails vs cohort-median delivery curve · Open rate vs 19.6% · Click rate vs
 *               4.3% (historical LE launch-send medians) · Session → entry
 *   AA Meta   - Posts + stories (no ref) · Sessions · Session → entry
 *   Referral artist - Posts (artist accounts; no feed yet, renders neutral) ·
 *               Sessions · Session → entry
 *   Search-direct-other - Sessions · Session → entry
 *   Paid      - Spend vs pro-rata budget (un-inverted per artboard) · Cost per
 *               entry vs cost-per-purchase target × 0.8 (inverted)
 * Rung mechanics per spec: relPct=(v/ref−1)×100; dot x = clamp(50+relPct/25×46, 4, 96);
 * delta = relative % vs reference for every unit; RAG on eff = inv ? −relPct : relPct.
 * Null value or missing/zero reference → neutral: centred grey dot, delta '–'. */
import React from "react";
import { Card, GROUP_DOTS, C, QBadge, fmt, fmtSigned, fmtMoney, MINUS, useTip } from "../ui.jsx";

const SCALE = 25;
const RING = "0 0 0 1px rgba(20,20,19,.45)";
const NEUTRAL_DOT = "#c8c5bc";

function fmtVal(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (unit === "%") return fmt(v, 1) + "%";
  if (unit === "eur") return fmtMoney(v, Math.abs(v) < 100 ? 2 : 0);
  return fmt(v);
}

/* [label, value, reference, unit, invert?, note?] -> render model */
function buildRung([label, v, ref, unit, inv, note]) {
  const noVal = v === null || v === undefined || Number.isNaN(v);
  const noRef = ref === null || ref === undefined || Number.isNaN(ref) || ref === 0;
  if (noVal || noRef) {
    // no reference: show the value itself where the delta would go, rather
    // than a dash that reads as "no data"
    return {
      label, neutral: true, delta: noVal ? "–" : fmtVal(v, unit), rag: C.muted, dev: 50,
      tip: {
        head: label,
        rows: [
          { label: "Actual", value: fmtVal(v, unit) },
          { label: "Reference", value: "–" },
        ],
      },
    };
  }
  const relPct = (v / ref - 1) * 100;
  const dAbs = Math.abs(Math.round(relPct)) + "%";
  const dPos = relPct >= 0;
  const eff = inv ? -relPct : relPct;
  // Inverted (cost) metrics plot by their JUDGED direction: bad always goes left,
  // good always right - an over-benchmark cost per entry sits left, not right.
  return {
    label,
    neutral: false,
    up: eff >= 0,
    dev: Math.max(4, Math.min(96, 50 + (eff / SCALE) * 46)),
    delta: (dPos ? "+" : MINUS) + dAbs,
    rag: eff >= 0 ? C.green : eff > -10 ? C.amber : C.red,
    tip: {
      head: label,
      rows: [
        { label: "Actual", value: fmtVal(v, unit) },
        { label: "Target", value: fmtVal(ref, unit) },
        { label: "vs target",
          value: (relPct >= 0 ? "+" : MINUS) + Math.abs(relPct).toFixed(1) + "%",
          color: eff >= 0 ? C.green : eff > -10 ? C.amber : C.red },
      ],
    },
  };
}

function Rung({ r }) {
  const tipApi = useTip();
  return (
    <div
      {...tipApi.props(r.tip)}
      style={{
        height: 28, flex: "0 0 28px", display: "grid",
        gridTemplateColumns: "112px 1fr 56px", gap: 10, alignItems: "center",
      }}
    >
      <div style={{ fontSize: 13, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {r.label}
      </div>
      <div style={{ position: "relative", height: 12 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: C.hairline }} />
        {!r.neutral && (
          <div
            style={{
              position: "absolute", left: "50%", top: 5, height: 4,
              width: `${Math.abs(r.dev - 50)}%`,
              marginLeft: `${r.up ? 0 : r.dev - 50}%`,
              background: r.up ? "#f7c4ad" : "#eeb9a3", borderRadius: 2,
            }}
          />
        )}
        <div
          style={{
            position: "absolute", left: `${r.dev}%`, top: 1, width: 10, height: 10,
            marginLeft: -5, borderRadius: "50%",
            background: r.neutral ? NEUTRAL_DOT : r.up ? C.orange : C.red,
            boxShadow: RING,
          }}
        />
      </div>
      <div className="num" style={{ fontSize: 13.5, fontWeight: 600, textAlign: "right", color: r.rag }}>
        {r.delta}
      </div>
    </div>
  );
}

/* Waterfall view: expected -> actual secured units today, stepped by the
 * SAME rows the funnel view shows, group by group. Each group's secured units
 * are a chain of the funnel's own factors (AA Email: delivered x click rate x
 * sessions per click x session->sale; Paid: spend x units per pound; the
 * rest: sessions x session->sale) and each step reprices one factor from its
 * reference to its actual with the earlier factors at actual and the later at
 * reference (the §4.5 one-at-a-time method), so the steps sum exactly to the
 * group's gap and the groups sum to the hero's. A row without a reference
 * (Posts, Open rate) is shown in place with no step - it is context, not a
 * component of the arithmetic. Rounding residual is parked on the largest
 * step; a real residual (the hero is capped at the edition) is left visible. */
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
const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);

function groupWaterfall(g, snap) {
  const ch = (snap.channels || []).find((c) => c.key === g.key) || {};
  const now = ch.now ?? 0, exp = ch.exp ?? 0;
  const fbg = (snap.funnelByGroup || {})[g.key] || {};
  const sessA = fbg.sessions_actual ?? 0, sessE = fbg.sessions_expected ?? 0;
  const convA = fbg.conv_actual ?? 0, convE = fbg.conv_expected ?? 0;
  const rows = [];   // [{label, step (number|null), note, tip rows}]
  const info = (label, v, ref, unit, note) => rows.push({ label, value: null, note,
    tipRows: [{ label: "Actual", value: fmtVal(v, unit) }, { label: "Reference", value: fmtVal(ref, unit) }] });
  const twoFactor = () => chainSteps([
    { label: "Sessions", a: sessA, e: sessE, note: "sessions vs plan" },
    { label: "Session → sale", a: convA, e: convE, note: "session → sale rate vs plan" },
  ]);

  let steps;
  if (g.key === "aa_email") {
    const em = snap.email || {};
    const b = snap.benchmarks || {};
    const clickRef = (b.emailClickRateRef ?? 4.3) / 100, openRef = (b.emailOpenRateRef ?? 19.6) / 100;
    const delivA = em.delivered ?? 0, delivE = em.deliveredTarget ?? null;
    const clickA = em.clickRate ?? null;
    const clicksA = delivA * (clickA ?? 0), clicksE = finite(delivE) ? delivE * clickRef : null;
    const chainable = finite(delivE) && delivE > 0 && clicksA > 0 && clicksE > 0 && sessE > 0;
    info("Open rate", (em.openRate ?? null) !== null ? em.openRate * 100 : null, openRef * 100, "%",
      "context only - clicks, not opens, carry into sessions");
    if (chainable) {
      steps = chainSteps([
        { label: "Delivered emails", a: delivA, e: delivE, note: "sends delivered vs the cohort-median delivery curve" },
        { label: "Click rate", a: clickA, e: clickRef, note: `clicks per delivered email vs ${(clickRef * 100).toFixed(1)}%` },
        { label: "Sessions", a: sessA / clicksA, e: sessE / clicksE, note: "sessions per click vs plan - traffic the clicks did not explain" },
        { label: "Session → sale", a: convA, e: convE, note: "session → sale rate vs plan" },
      ]);
      // keep the funnel's row order: Delivered, Open rate, Click rate, Sessions, Session -> sale
      rows.splice(0, 0, steps[0]); rows.push(steps[1], steps[2], steps[3]);
      return { name: g.name, rows, now, exp };
    }
    rows.unshift({ label: "Delivered emails", value: null, note: "no delivery benchmark yet",
      tipRows: [{ label: "Actual", value: fmtVal(delivA, "count") }, { label: "Reference", value: "–" }] });
    rows.push({ label: "Click rate", value: null, note: "context only",
      tipRows: [{ label: "Actual", value: fmtVal(clickA !== null ? clickA * 100 : null, "%") }, { label: "Reference", value: fmtVal(clickRef * 100, "%") }] });
    rows.push(...twoFactor());
    return { name: g.name, rows, now, exp };
  }
  if (g.key === "paid") {
    const paid = snap.paid || {};
    const day = snap.day ?? 0, of = snap.of ?? 0;
    const spendA = paid.spendToDate ?? 0;
    const spendE = of > 0 && paid.spendBudget ? (paid.spendBudget * day) / of : null;
    if (finite(spendE) && spendE > 0 && spendA > 0 && exp > 0) {
      steps = chainSteps([
        { label: "Spend", a: spendA, e: spendE, note: "spend to date vs the plan's share of budget by today" },
        { label: "Cost per entry", a: now / spendA, e: exp / spendE, note: "secured units per pound, actual vs plan - the cost-per-entry side of the ledger" },
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
        { label: "Posts", a: postsA, e: postsE, note: "artist-account posts vs the tier benchmark, pro-rated" },
        { label: "Sessions", a: sessA / postsA, e: sessE / postsE, note: "sessions per post vs plan" },
        { label: "Session → sale", a: convA, e: convE, note: "session → sale rate vs plan" },
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
  for (const s of sections) {
    flat.push({ header: s.name });
    for (const r of s.rows) {
      if (finite(r.value)) { const from = cum; cum += r.value; flat.push({ ...r, from, to: cum }); }
      else flat.push({ ...r, level: cum });
    }
  }
  const levels = [expTotal, ...flat.filter((r) => r.to !== undefined).map((r) => r.to)];
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  const X = (v) => ((v - (lo - pad)) / span) * 100;
  const GRID = "112px 1fr 56px";

  const anchorRow = (label, value, tip) => (
    <div style={{ height: 28, flex: "0 0 28px", display: "grid", gridTemplateColumns: GRID, gap: 10, alignItems: "center" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ position: "relative", height: 14 }}>
        <div {...tipApi.props(tip)} style={{ position: "absolute", left: `${X(value)}%`, top: -2, bottom: -2, width: 2, background: C.ink }} />
      </div>
      <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{fmt(value)}</div>
    </div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      {anchorRow("Expected today", expTotal,
        { head: `Expected by day ${day}`, rows: [{ label: "Secured units", value: fmt(expTotal) }] })}
      {flat.map((r, i) => r.header ? (
        <div key={"h" + i} style={{ height: 22, flex: "0 0 22px", display: "flex", alignItems: "center", marginTop: 2 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{r.header}</div>
        </div>
      ) : r.to !== undefined ? (
        <div key={r.label + i} style={{ height: 24, flex: "0 0 24px", display: "grid", gridTemplateColumns: GRID, gap: 10, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
          <div style={{ position: "relative", height: 12 }}>
            <div {...tipApi.props({
              head: r.label, body: r.note,
              rows: [
                { label: "vs expected", value: fmtSigned(r.value, 1) + " units", color: r.value >= 0 ? C.green : C.red },
                { label: "Running total", value: fmt(r.to, 1) },
              ],
            })} style={{
              position: "absolute", top: 0, bottom: 0,
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
        <div key={r.label + i} style={{ height: 24, flex: "0 0 24px", display: "grid", gridTemplateColumns: GRID, gap: 10, alignItems: "center" }}>
          <div style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</div>
          <div style={{ position: "relative", height: 12 }}>
            <div {...tipApi.props({ head: r.label, body: r.note, rows: r.tipRows })} style={{
              position: "absolute", left: `${X(r.level)}%`, top: 1, width: 10, height: 10, marginLeft: -5,
              borderRadius: "50%", background: NEUTRAL_DOT, boxShadow: RING,
            }} />
          </div>
          <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: C.muted }}>–</div>
        </div>
      ))}
      {anchorRow("Actual today", nowTotal,
        { head: "Secured to date", rows: [{ label: "Secured units", value: fmt(nowTotal) }] })}
      <div style={{ height: 24, flex: "0 0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <QBadge content={{
          head: "Target to actual",
          body: "The same rows as the funnel view. Each row reprices one funnel factor from its reference to its actual, one at a time; within a group the steps sum to that group's gap and the groups sum to the gap between expected and actual secured units today. Grey rows have no reference and carry no step.",
        }} />
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
          {capped ? "steps exceed the gap - sellout caps it" : `secured units, day ${day}`}
        </span>
      </div>
    </div>
  );
}

export default function FunnelByChannel({ snap }) {
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

  const pct = (x) => (x === null || x === undefined ? null : x * 100);
  const sess = (k) => {
    const g = fbg[k] || {};
    return ["Sessions", g.sessions_actual ?? null, g.sessions_expected ?? null, "count"];
  };
  const conv = (k) => {
    const g = fbg[k] || {};
    return ["Session → sale", pct(g.conv_actual), pct(g.conv_expected), "%"];
  };

  const spendPlan = of > 0 && paid.spendBudget ? (paid.spendBudget * day) / of : null;
  const cpp = snap?.targets?.paid?.cost_per_purchase;
  const cpeRef = cpp ? cpp * 0.8 : null;
  const REF_NOTE = "Reference: historical LE launch-send median";

  const groups = [
    {
      key: "aa_email", name: "AA Email",
      rungs: [
        // reference = cohort median delivered total x pooled delivery-timing
        // curve at today's pdsa (computed in the ETL as email.deliveredTarget)
        ["Delivered emails", email.delivered ?? null, email.deliveredTarget ?? null, "count"],
        ["Open rate", pct(email.openRate), snap?.benchmarks?.emailOpenRateRef ?? 19.6, "%", false, REF_NOTE],
        ["Click rate", pct(email.clickRate), snap?.benchmarks?.emailClickRateRef ?? 4.3, "%", false, REF_NOTE],
        sess("aa_email"),
        conv("aa_email"),
      ],
    },
    {
      key: "aa_social", name: "AA Meta",
      rungs: [
        ["Posts", (social.posts ?? 0) + (social.stories ?? 0), null, "count", false,
          `${fmt(social.posts ?? 0)} posts + ${fmt(social.stories ?? 0)} stories to date`],
        sess("aa_social"),
        conv("aa_social"),
      ],
    },
    {
      key: "referral_artist", name: "Referral artist",
      rungs: [
        // artist-account posts from the Notion log; reference = tier benchmark
        // (median posts among completed campaigns in the same Referral Artist
        // tier) pro-rated by days elapsed. Neutral until the feed/benchmark exist.
        ["Posts", social.artistPosts ?? null,
          of > 0 && social.artistPostsTarget ? (social.artistPostsTarget * day) / of : null,
          "count"],
        sess("referral_artist"),
        conv("referral_artist"),
      ],
    },
    { key: "search_direct_other", name: "Search / direct / other", rungs: [sess("search_direct_other"), conv("search_direct_other")] },
    {
      key: "paid", name: "Paid",
      rungs: [
        ["Spend", paid.spendToDate ?? null, spendPlan, "eur", false,
          "Plan: campaign budget × share of days elapsed"],
        ["Cost per entry", paid.l3dCpe ?? null, cpeRef, "eur", true,
          "Last 3 days; reference = paid cost-per-purchase target × 0.8"],
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
            title="Each funnel metric as a deviation vs its reference">Funnel</button>
          <button className={view === "wf" ? "active" : ""} onClick={() => setView("wf")}
            title="Waterfall from expected to actual secured units today, stepped by the same funnel components">Waterfall</button>
        </span>
      ) : (
        <span style={{ fontSize: 11.5, color: C.muted }} title="Grey dots: no reference to judge against until targets are set. The number is the actual.">actuals · no targets</span>
      )}
    >
      <div className="spacer-16" />
      {view === "wf" ? <FunnelWaterfall snap={snap} groups={groups} /> : (
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* shared centre reference line behind all groups (112px label + 10 gap / 56px delta + 10 gap) */}
        <div style={{ position: "absolute", left: 138, right: 62, top: 0, bottom: 0, pointerEvents: "none" }}>
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#ddd9cf" }} />
        </div>
        {groups.map((g) => (
          <div key={g.name} style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ height: 24, flex: "0 0 24px", display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap" }}>{g.name}</div>
            </div>
            {g.rungs.map((raw) => {
              const r = buildRung(raw);
              return <Rung key={r.label} r={r} />;
            })}
          </div>
        ))}
      </div>
      )}
    </Card>
  );
}
