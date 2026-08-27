/* Entries by country (spec §4.9).
 * The country dimension is not in the BigQuery funnel feed yet (docs §12) —
 * snap.geo is null for every release, so this renders the module chrome with
 * an empty state (an allowed visible caption) to keep the 10-module grid
 * shape. If geo data ever arrives it renders the top-5 layout per spec. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt } from "../ui.jsx";

export default function Geo({ snap }) {
  const g = snap?.geo;
  const raw = Array.isArray(g) ? g : g?.rows;
  const rows = (raw || [])
    .map((r) => ({ name: r.country ?? r.name, v: r.entries ?? r.value ?? 0 }))
    .sort((a, b) => b.v - a.v);

  if (rows.length === 0) {
    return (
      <Card dot={GROUP_DOTS.outcome} title="Entries by country">
        <div className="empty-state">
          <div>Country split not in the funnel feed yet</div>
          <div style={{ fontSize: 12 }}>Add geo to the BigQuery export to light this up</div>
        </div>
      </Card>
    );
  }

  const total = snap?.hero?.now || rows.reduce((a, r) => a + r.v, 0);
  const top5 = rows.slice(0, 5);
  const max = top5[0].v || 1;
  const share = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const top5Share = share(top5.reduce((a, r) => a + r.v, 0));

  return (
    <Card dot={GROUP_DOTS.outcome} title="Entries by country">
      <div className="spacer-16" />
      <div className="body">
        {top5.map((r) => {
          const tip = `${r.name}\n${fmt(r.v)} entries · ${share(r.v)}% of all entries`;
          return (
            <div
              key={r.name}
              style={{
                flex: 1, display: "grid", gridTemplateColumns: "104px 1fr 48px",
                gap: 12, alignItems: "center",
              }}
            >
              <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.name}
              </div>
              <div style={{ position: "relative", height: 14, background: C.track, borderRadius: 4 }}>
                <div
                  title={tip}
                  style={{
                    position: "absolute", left: 0, top: 0, bottom: 0,
                    width: `${(r.v / max) * 100}%`, background: C.orange, borderRadius: 4,
                  }}
                />
              </div>
              <div className="num" title={tip} style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
                {share(r.v)}%
              </div>
            </div>
          );
        })}
        <div style={{ height: 12, flexShrink: 0 }} />
        <div
          style={{
            height: 26, display: "flex", justifyContent: "space-between",
            alignItems: "center", flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>Top 5 share of all entries</span>
          <span className="num" style={{ fontSize: 12, fontWeight: 600 }}>{top5Share}%</span>
        </div>
      </div>
    </Card>
  );
}
