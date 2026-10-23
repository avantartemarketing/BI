/* Where the buyers are: the top countries by entries (snap.geo, rows of
 * country and entries), each a bar with its units and share of the whole.
 * The country split is not in the BigQuery funnel feed for every release
 * (docs 12); the Overview shows the card only when the snapshot carries it,
 * and the card is empty when the rows are. */
import React from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, niceAxis, kfmt, COL, sw } from "../charts.jsx";
import { fmt } from "../format.mjs";

export default function Geo({ snap }) {
  const g = snap.geo;
  const raw = Array.isArray(g) ? g : g && g.rows;
  const rows = (raw || []).map((r) => ({ name: r.country ?? r.name, v: r.entries ?? r.value ?? 0 })).filter((r) => r.name).sort((a, b) => b.v - a.v);
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.v, 0);
  const top = rows.slice(0, 5);
  const rest = total - top.reduce((a, r) => a + r.v, 0);
  const shown = rest > 0 ? [...top, { name: "Elsewhere", v: rest }] : top;
  const share = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const ax = niceAxis(Math.max(1, ...shown.map((r) => r.v)), 2);
  return (
    <Card title="Where the buyers are" aria="Entries by country">
      <Head v={fmt(total)} u="entries" aside={`${share(top.reduce((a, r) => a + r.v, 0))}% in the top ${top.length}`} />
      <HBarChart H={34 + shown.length * 30} L={110} bh={10} xmin={0} xmax={ax.ymax} xticks={ax.ticks} xfmt={kfmt}
        rows={shown.map((r) => r.name)} series={[{ color: COL.IND, vals: shown.map((r) => r.v) }]}
        title={(i) => shown[i].name}
        rows2={(i) => [{ n: "Entries", v: fmt(shown[i].v), k: sw(COL.IND) }, { n: "Share", v: `${share(shown[i].v)}%`, k: { width: 8, flex: "0 0 8px" } }]}
        aria={`Entries by country: ${shown.map((r) => `${r.name} ${fmt(r.v)}`).join(", ")}`} />
    </Card>
  );
}
