/* Funnel by channel (spec §4.4, LE relabel per §6). Tall card (1 col × 2 rows).
 * Five display groups; rungs are built from real snapshot data instead of the
 * mock's static list:
 *   AA Email  — Delivered emails (no ref) · Open rate vs 19.6% · Click rate vs
 *               4.3% (historical LE launch-send medians) · Session → entry
 *   AA Meta   — Posts + stories (no ref) · Sessions · Session → entry
 *   Referral artist / Search-direct-other — Sessions · Session → entry
 *   Paid      — Spend vs pro-rata budget (un-inverted per artboard) · Cost per
 *               entry vs cost-per-purchase target × 0.8 (inverted) · Session → entry
 * Rung mechanics per spec: relPct=(v/ref−1)×100; dot x = clamp(50+relPct/25×46, 4, 96);
 * delta = pt diff for '%' units else %; RAG on eff = inv ? −relPct : relPct.
 * Null value or missing/zero reference → neutral: centred grey dot, delta '–'. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt, fmtMoney, MINUS } from "../ui.jsx";

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
      tip:
        label +
        "\nActual  " + fmtVal(v, unit) +
        "\nNo reference for this step" +
        (note ? "\n" + note : ""),
    };
  }
  const relPct = (v / ref - 1) * 100;
  const isPct = unit === "%";
  const dAbs = isPct ? Math.abs(v - ref).toFixed(1) + "pt" : Math.abs(Math.round(relPct)) + "%";
  const dPos = isPct ? v - ref >= 0 : relPct >= 0;
  const eff = inv ? -relPct : relPct;
  return {
    label,
    neutral: false,
    up: relPct >= 0,
    dev: Math.max(4, Math.min(96, 50 + (relPct / SCALE) * 46)),
    delta: (dPos ? "+" : MINUS) + dAbs,
    rag: eff >= 0 ? C.green : eff > -10 ? C.amber : C.red,
    tip:
      label +
      "\n" + (relPct >= 0 ? "+" : MINUS) + Math.abs(relPct).toFixed(1) + "% vs target" +
      "\nActual  " + fmtVal(v, unit) +
      "\nTarget  " + fmtVal(ref, unit) +
      (note ? "\n" + note : ""),
  };
}

function Rung({ r }) {
  return (
    <div
      title={r.tip}
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

export default function FunnelByChannel({ snap }) {
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
    return ["Session → entry", pct(g.conv_actual), pct(g.conv_expected), "%"];
  };

  const spendPlan = of > 0 && paid.spendBudget ? (paid.spendBudget * day) / of : null;
  const cpp = snap?.targets?.paid?.cost_per_purchase;
  const cpeRef = cpp ? cpp * 0.8 : null;
  const REF_NOTE = "Reference: historical LE launch-send median";

  const groups = [
    {
      name: "AA Email",
      rungs: [
        ["Delivered emails", email.delivered ?? null, null, "count"],
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
    { name: "Referral artist", rungs: [sess("referral_artist"), conv("referral_artist")] },
    { name: "Search / direct / other", rungs: [sess("search_direct_other"), conv("search_direct_other")] },
    {
      name: "Paid",
      rungs: [
        ["Spend", paid.spendToDate ?? null, spendPlan, "eur", false,
          "Plan: campaign budget × share of days elapsed"],
        ["Cost per entry", paid.l3dCpe ?? null, cpeRef, "eur", true,
          "Last 3 days; reference = paid cost-per-purchase target × 0.8"],
        conv("paid"),
      ],
    },
  ];

  return (
    <Card tall dot={GROUP_DOTS.funnel} title="Funnel by channel">
      <div className="spacer-16" />
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
    </Card>
  );
}
