/* Funnel key drivers (spec §4.5, LE relabel per §6).
 * Adding | Costing segmented toggle (default side = sign of hero.delta).
 * Rows = per-group contributions from funnelByGroup — two entries per group
 * (Traffic = contrib_traffic, Session → entry = contrib_conversion) — top 4
 * by |value| of the chosen sign. Methodology note lives in tooltips only. */
import React from "react";
import { Card, GROUP_DOTS, C, fmtSigned } from "../ui.jsx";

const GROUPS = [
  { key: "aa_email", name: "AA Email", short: "Email" },
  { key: "aa_social", name: "AA Meta", short: "Meta" },
  { key: "referral_artist", name: "Referral artist", short: "Referral" },
  { key: "search_direct_other", name: "Search / direct / other", short: "Search" },
  { key: "paid", name: "Paid", short: "Paid" },
];

const NOTE =
  "Each step's contribution is repriced one-at-a-time vs plan; together the steps sum to the gap vs expected today.";

export default function KeyDrivers({ snap }) {
  const [side, setSide] = React.useState(null);
  React.useEffect(() => setSide(null), [snap?.id]);

  const fbg = snap?.funnelByGroup || {};
  const delta = snap?.hero?.delta ?? 0;
  const active = side ?? (delta >= 0 ? "pos" : "neg");
  const isPos = active === "pos";

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
      title="Funnel key drivers"
      right={
        <span className="seg">
          <button
            className={isPos ? "active" : ""}
            title={"Steps adding units vs expected\n" + NOTE}
            onClick={() => setSide("pos")}
          >
            Adding
          </button>
          <button
            className={isPos ? "" : "active"}
            title={"Steps costing units vs expected\n" + NOTE}
            onClick={() => setSide("neg")}
          >
            Costing
          </button>
        </span>
      }
    >
      <div className="spacer-16" />
      <div className="body">
        {rows.length === 0 ? (
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
                title={`${r.name} · ${r.step}\n${fmtSigned(r.v, 1)} units vs expected today`}
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
