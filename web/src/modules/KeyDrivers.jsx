/* Organic funnel / funnel key drivers (spec §4.5, LE relabel per §6).
 * Three-state seg: Funnel (default) | Adding | Costing.
 *
 * Funnel - the organic funnel at a grouped level (the four non-paid display
 * groups combined) as deviation rungs vs target, per the agreed design:
 *   Top of funnel  - emails delivered + posts/stories; no targets yet, so the
 *                    rung is neutral and the counts live in the hover popup
 *   Mid funnel     - sessions vs expected today
 *   Low funnel     - session → entry conversion vs expected (entry-weighted:
 *                    Σ sessions×conv / Σ sessions on each side)
 * Rung mechanics as in Funnel by channel: eff = relPct, dot x = clamp(50 +
 * eff/25×46, 4, 96), RAG green / amber (> −10) / red.
 *
 * Adding | Costing - per-group step contributions from funnelByGroup, top 4 by
 * |value| of the chosen sign. Methodology notes live in tooltips only. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt, fmtSigned, MINUS, useTip } from "../ui.jsx";

const GROUPS = [
  { key: "aa_email", name: "AA Email", short: "Email" },
  { key: "aa_social", name: "AA Meta", short: "Meta" },
  { key: "referral_artist", name: "Referral artist", short: "Referral" },
  { key: "search_direct_other", name: "Search / direct / other", short: "Search" },
  { key: "paid", name: "Paid", short: "Paid" },
];
const ORGANIC = ["aa_email", "aa_social", "referral_artist", "search_direct_other"];

const NOTE =
  "Each step's contribution is repriced one-at-a-time vs plan; together the steps sum to the gap vs expected today.";
const SCALE = 25;
const RING = "0 0 0 1px rgba(20,20,19,.45)";

function FunnelRung({ tier, metric, relPct, tip }) {
  const tipApi = useTip();
  const neutral = relPct === null;
  const eff = relPct ?? 0;
  const dev = neutral ? 50 : Math.max(4, Math.min(96, 50 + (eff / SCALE) * 46));
  const up = eff >= 0;
  const rag = neutral ? C.muted : eff >= 0 ? C.green : eff > -10 ? C.amber : C.red;
  const delta = neutral ? "–" : (eff >= 0 ? "+" : MINUS) + Math.abs(Math.round(eff)) + "%";
  return (
    <div
      {...tipApi.props(tip)}
      style={{
        flex: 1, minHeight: 0, display: "grid",
        gridTemplateColumns: "128px 1fr 56px", gap: 10, alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{tier}</div>
        <div style={{ fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }}>{metric}</div>
      </div>
      <div style={{ position: "relative", height: 12 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: C.hairline }} />
        <div style={{ position: "absolute", left: "50%", top: -14, bottom: -14, width: 1, background: "#ddd9cf" }} />
        {!neutral && (
          <div
            style={{
              position: "absolute", left: "50%", top: 5, height: 4,
              width: `${Math.abs(dev - 50)}%`,
              marginLeft: `${up ? 0 : dev - 50}%`,
              background: up ? "#f7c4ad" : "#eeb9a3", borderRadius: 2,
            }}
          />
        )}
        <div
          style={{
            position: "absolute", left: `${dev}%`, top: 1, width: 10, height: 10,
            marginLeft: -5, borderRadius: "50%",
            background: neutral ? "#c8c5bc" : up ? C.orange : C.red,
            boxShadow: RING,
          }}
        />
      </div>
      <div className="num" style={{ fontSize: 13.5, fontWeight: 600, textAlign: "right", color: rag }}>
        {delta}
      </div>
    </div>
  );
}

function FunnelView({ snap }) {
  const fbg = snap?.funnelByGroup || {};
  const email = snap?.email || {};
  const social = snap?.social || {};

  let sessA = 0, sessE = 0, entA = 0, entE = 0;
  for (const k of ORGANIC) {
    const g = fbg[k];
    if (!g) continue;
    const sa = g.sessions_actual ?? 0, se = g.sessions_expected ?? 0;
    sessA += sa; sessE += se;
    entA += sa * (g.conv_actual ?? 0);
    entE += se * (g.conv_expected ?? 0);
  }
  const convA = sessA > 0 ? entA / sessA : null;
  const convE = sessE > 0 ? entE / sessE : null;

  const rel = (a, e) => (a !== null && e ? (a / e - 1) * 100 : null);
  const sessRel = sessE > 0 ? rel(sessA, sessE) : null;
  const convRel = convA !== null && convE ? rel(convA, convE) : null;

  const posts = (social.posts ?? 0) + (social.stories ?? 0);
  const pctTxt = (x) => (x === null ? "–" : fmt(x * 100, 1) + "%");
  const relRow = (r) => (r === null ? [] : [{
    label: "vs expected",
    value: (r >= 0 ? "+" : MINUS) + Math.abs(r).toFixed(1) + "%",
    color: r >= 0 ? C.green : r > -10 ? C.amber : C.red,
  }]);

  return (
    <>
      <FunnelRung
        tier="Top of funnel" metric="Emails + posts" relPct={null}
        tip={{
          head: "Top of funnel",
          rows: [
            { label: "Emails delivered", value: fmt(email.delivered ?? null) },
            { label: "Posts + stories", value: fmt(posts) },
            { label: "Target", value: "–" },
          ],
        }}
      />
      <FunnelRung
        tier="Mid funnel" metric="Sessions" relPct={sessRel}
        tip={{
          head: "Mid funnel · Sessions",
          rows: [
            { label: "Actual", value: fmt(sessA) },
            { label: "Expected today", value: fmt(sessE) },
            ...relRow(sessRel),
          ],
        }}
      />
      <FunnelRung
        tier="Low funnel" metric="Session → entry" relPct={convRel}
        tip={{
          head: "Low funnel · Session → entry",
          rows: [
            { label: "Actual", value: pctTxt(convA) },
            { label: "Expected", value: pctTxt(convE) },
            ...relRow(convRel),
          ],
        }}
      />
    </>
  );
}

export default function KeyDrivers({ snap }) {
  const tipApi = useTip();
  const [view, setView] = React.useState("funnel"); // 'funnel' | 'pos' | 'neg'
  React.useEffect(() => setView("funnel"), [snap?.id]);

  const fbg = snap?.funnelByGroup || {};
  const isPos = view === "pos";

  const all = [];
  GROUPS.forEach((g) => {
    const f = fbg[g.key];
    if (!f) return;
    all.push({ ...g, step: "Traffic", v: f.contrib_traffic ?? 0 });
    all.push({ ...g, step: "Conversion", v: f.contrib_conversion ?? 0 });
  });
  const rows = all
    .filter((r) => (isPos ? r.v > 0 : r.v < 0))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 4);

  return (
    <Card
      dot={GROUP_DOTS.funnel}
      title={view === "funnel" ? "Organic funnel" : "Funnel key drivers"}
      right={
        <span className="seg">
          <button
            className={view === "funnel" ? "active" : ""}
            title="Organic funnel at a grouped level vs target: emails + posts, sessions, session → entry"
            onClick={() => setView("funnel")}
          >
            Funnel
          </button>
          <button
            className={view === "pos" ? "active" : ""}
            title={"Steps adding units vs expected\n" + NOTE}
            onClick={() => setView("pos")}
          >
            Adding
          </button>
          <button
            className={view === "neg" ? "active" : ""}
            title={"Steps costing units vs expected\n" + NOTE}
            onClick={() => setView("neg")}
          >
            Costing
          </button>
        </span>
      }
    >
      <div className="spacer-16" />
      <div className="body">
        {view === "funnel" ? (
          <FunnelView snap={snap} />
        ) : rows.length === 0 ? (
          <div className="empty-state">
            {isPos ? "No steps adding units vs expected yet" : "No steps costing units vs expected"}
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r.key + r.step}
              style={{
                flex: 1, minHeight: 0, display: "grid",
                gridTemplateColumns: "20px 1fr 56px", gap: 12,
                alignItems: "center", borderTop: `1px solid ${C.hairline}`,
              }}
            >
              <div className="num" style={{ fontSize: 12, color: C.muted }}>{i + 1}</div>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`chan-loz ${r.key}`} style={{ flexShrink: 0 }}>{r.short}</span>
                <span style={{ fontSize: 13, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.step}
                </span>
              </div>
              <div
                className="num"
                {...tipApi.props({
                  head: `${r.name} · ${r.step}`,
                  rows: [{ label: "vs expected today", value: fmtSigned(r.v, 1) + " units", color: r.v >= 0 ? "#0f7052" : "#b8461d" }],
                })}
                style={{
                  fontSize: 13.5, fontWeight: 600, textAlign: "right",
                  color: r.v > 0 ? C.green : C.red,
                }}
              >
                {fmtSigned(r.v, 1)}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
