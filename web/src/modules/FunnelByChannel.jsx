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
    return {
      label, neutral: true, delta: "–", rag: C.muted, dev: 50,
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

/* Waterfall view: expected -> actual secured units today, stepped by the same
 * funnel components at group level (Traffic and Conversion per display group,
 * the §4.5 one-at-a-time repricing - steps sum exactly to the gap; any rounding
 * residual is parked on the largest step). Same visual language as the
 * Projection-vs-target waterfall: ink anchor ticks, floating step bars, grey
 * connector drops. */
function FunnelWaterfall({ snap }) {
  const tipApi = useTip();
  const fbg = snap?.funnelByGroup || {};
  const exp = snap?.hero?.expectedToday ?? 0;
  const now = snap?.hero?.now ?? 0;
  const day = snap?.day ?? 0;

  const steps = [];
  for (const [k, name] of [
    ["aa_email", "Email"], ["aa_social", "Meta"], ["referral_artist", "Referral"],
    ["search_direct_other", "Search"], ["paid", "Paid"],
  ]) {
    const g = fbg[k];
    if (!g) continue;
    steps.push({ key: k + "-t", label: name + " · Traffic", value: g.contrib_traffic ?? 0 });
    steps.push({ key: k + "-c", label: name + " · Conv", value: g.contrib_conversion ?? 0 });
  }
  if (!steps.length) return <div className="empty-state">No funnel data yet</div>;
  const residual = (now - exp) - steps.reduce((a, s) => a + s.value, 0);
  const biggest = steps.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
  biggest.value += residual;

  let cum = exp;
  const path = steps.map((s) => { const from = cum; cum += s.value; return { ...s, from, to: cum }; });
  const levels = [exp, ...path.map((p) => p.to)];
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const pad = (hi - lo) * 0.1 || 1;
  const span = hi + pad - (lo - pad);
  const X = (v) => ((v - (lo - pad)) / span) * 100;
  const nRows = steps.length + 2;

  const anchorRow = (label, value, tip) => (
    <div style={{ flex: 1, display: "grid", gridTemplateColumns: "112px 1fr 56px", gap: 10, alignItems: "center", minHeight: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ position: "relative", height: 14 }}>
        <div {...tipApi.props(tip)} style={{ position: "absolute", left: `${X(value)}%`, top: -2, bottom: -2, width: 2, background: C.ink }} />
      </div>
      <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{fmt(value)}</div>
    </div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "absolute", left: 122, right: 66, top: 0, bottom: 0, pointerEvents: "none" }}>
        {levels.map((v, i) => (
          <div key={i} style={{
            position: "absolute", left: `${X(v)}%`,
            top: `${((i + 0.5) / nRows) * 100}%`, height: `${(1 / nRows) * 100}%`,
            width: 1, background: C.planGrey,
          }} />
        ))}
      </div>

      {anchorRow("Expected today", exp,
        { head: `Expected by day ${day}`, rows: [{ label: "Secured units", value: fmt(exp) }] })}
      {path.map((p) => {
        const up = p.value >= 0;
        const tip = {
          head: p.label,
          rows: [
            { label: "vs expected", value: fmtSigned(p.value, 1) + " units", color: up ? C.green : C.red },
            { label: "Running total", value: fmt(p.to, 1) },
          ],
        };
        return (
          <div key={p.key} style={{ flex: 1, display: "grid", gridTemplateColumns: "112px 1fr 56px", gap: 10, alignItems: "center", minHeight: 0 }}>
            <div style={{ fontSize: 12.5, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.label}
            </div>
            <div style={{ position: "relative", height: 14 }}>
              <div {...tipApi.props(tip)} style={{
                position: "absolute", top: 0, bottom: 0,
                left: `${X(Math.min(p.from, p.to))}%`,
                width: `${Math.max(1.2, Math.abs(X(p.to) - X(p.from)))}%`,
                background: up ? C.wfGreen : C.red, borderRadius: 3,
              }} />
            </div>
            <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: up ? C.green : C.red }}>
              {fmtSigned(p.value, 1)}
            </div>
          </div>
        );
      })}
      {anchorRow("Actual today", now,
        { head: "Secured to date", rows: [{ label: "Secured units", value: fmt(now) }] })}

      <div style={{ height: 24, flex: "0 0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <QBadge content={{
          head: "Target to actual",
          body: "Each funnel component is repriced one-at-a-time vs plan; together the steps sum to the gap between expected and actual secured units today.",
        }} />
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>secured units, day {day}</span>
      </div>
    </div>
  );
}

export default function FunnelByChannel({ snap }) {
  const [view, setView] = React.useState("funnel"); // 'funnel' | 'wf'
  React.useEffect(() => setView("funnel"), [snap?.id]);
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
      name: "AA Email",
      rungs: [
        // reference = cohort median delivered total x pooled delivery-timing
        // curve at today's pdsa (computed in the ETL as email.deliveredTarget)
        ["Delivered emails", email.delivered ?? null, email.deliveredTarget ?? null, "count"],
        ["Open rate", pct(email.openRate), 19.6, "%", false, REF_NOTE],
        ["Click rate", pct(email.clickRate), 4.3, "%", false, REF_NOTE],
        conv("aa_email"),
      ],
    },
    {
      name: "AA Meta",
      rungs: [
        ["Posts", (social.posts ?? 0) + (social.stories ?? 0), null, "count", false,
          `${fmt(social.posts ?? 0)} posts + ${fmt(social.stories ?? 0)} stories to date`],
        sess("aa_social"),
        conv("aa_social"),
      ],
    },
    {
      name: "Referral artist",
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
    { name: "Search / direct / other", rungs: [sess("search_direct_other"), conv("search_direct_other")] },
    {
      name: "Paid",
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
      right={
        <span className="seg">
          <button className={view === "funnel" ? "active" : ""} onClick={() => setView("funnel")}
            title="Each funnel metric as a deviation vs its reference">Funnel</button>
          <button className={view === "wf" ? "active" : ""} onClick={() => setView("wf")}
            title="Waterfall from expected to actual secured units today, stepped by the same funnel components">Waterfall</button>
        </span>
      }
    >
      <div className="spacer-16" />
      {view === "wf" ? <FunnelWaterfall snap={snap} /> : (
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* shared centre reference line behind all groups (112px label + 10 gap / 56px delta + 10 gap) */}
        <div style={{ position: "absolute", left: 122, right: 66, top: 0, bottom: 0, pointerEvents: "none" }}>
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
