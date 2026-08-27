/* Predicted sell-through (spec §4.8, LE 3-segment recut §6.4).
 * Lead = release-level sell-through % of edition, RAG-colored.
 * One stacked bar on the #ece9e1 track: Sold (rust) -> Sold predicted
 * (orange, from entries in hand) -> Future entries (light orange, from
 * entries still to come). If the draw feed is present, a "Demand by
 * product" mini-table (per-product eligible entries; the feed carries no
 * per-product edition sizes yet). Horizontal legend at the bottom, no rule. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt, ragColor } from "../ui.jsx";

const SEGS = [
  { key: "sold", color: C.rust, label: "Sold", tip: (v) => `${fmt(v)} sold` },
  {
    key: "soldPredicted", color: C.orange, label: "Sold predicted",
    tip: (v) => `${fmt(v)} sales predicted from entries in hand`,
  },
  {
    key: "futureEntriesPredicted", color: C.orangeLight, label: "Future entries",
    tip: (v) => `${fmt(v)} sales predicted from entries still to come`,
  },
];

export default function SellThrough({ snap }) {
  const st = snap?.sellthrough;
  const draw = snap?.draw;

  if (!st) {
    return (
      <Card dot={GROUP_DOTS.outcome} title="Predicted sell-through">
        <div className="empty-state">No sell-through model yet</div>
      </Card>
    );
  }

  const edition = st.edition ?? 0;
  const pctFrac = st.pct ?? 0;
  const pct = Math.round(pctFrac * 100);
  const w = (v) => (edition > 0 ? Math.max(0, (v / edition) * 100) : 0);

  const products = draw?.per_product || [];
  const maxEntries = products.reduce((m, p) => Math.max(m, p.entries ?? 0), 0);

  return (
    <Card dot={GROUP_DOTS.outcome} title="Predicted sell-through">
      <div className="spacer-8" />
      <div className="lead">
        <span style={{ color: ragColor(pctFrac) }}>{pct}%</span>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          of {fmt(edition)} units
        </span>
      </div>
      <div className="spacer-16" />
      <div className="body">
        <div
          style={{
            flex: 1, display: "flex", flexDirection: "column",
            justifyContent: "center", gap: 16, minHeight: 0,
          }}
        >
          {/* release-level stacked bar */}
          <div
            style={{
              height: 20, flexShrink: 0, background: C.track,
              borderRadius: 5, overflow: "hidden", display: "flex",
            }}
          >
            {SEGS.map((s) => (
              <div
                key={s.key}
                title={s.tip(st[s.key] ?? 0)}
                style={{ width: `${w(st[s.key] ?? 0)}%`, background: s.color }}
              />
            ))}
          </div>

          {/* demand by product — only when the draw feed is present */}
          {products.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
              <div style={{ fontSize: 12, color: C.muted }}>Demand by product</div>
              {products.map((p) => (
                <div
                  key={p.name}
                  style={{
                    display: "grid", gridTemplateColumns: "104px 1fr 44px",
                    gap: 12, alignItems: "center",
                  }}
                >
                  <div
                    title={p.name}
                    style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {p.name}
                  </div>
                  <div style={{ position: "relative", height: 14, background: C.track, borderRadius: 4 }}>
                    <div
                      title={`${fmt(p.entries)} eligible entries · edition size not in feed yet`}
                      style={{
                        position: "absolute", left: 0, top: 0, bottom: 0,
                        width: `${maxEntries > 0 ? ((p.entries ?? 0) / maxEntries) * 100 : 0}%`,
                        background: C.orange, borderRadius: 4,
                      }}
                    />
                  </div>
                  <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
                    {fmt(p.entries)}
                  </div>
                </div>
              ))}
              <div
                title="Units demanded sums every eligible product entry — one entrant can demand several units across products"
                style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}
              >
                {fmt(draw.units_demanded)} units demanded · {fmt(draw.eligible)} eligible entrants
              </div>
            </div>
          )}
        </div>

        {/* bottom horizontal legend, no rule */}
        <div style={{ marginTop: "auto", paddingTop: 12, height: 26, display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
          {SEGS.map((s) => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
