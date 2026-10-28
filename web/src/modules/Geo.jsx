/* Orders by country (snap.geo, etl/build.py geo_block): the units paid by
 * the country the order ships to, from the orders feed's paid lines counted
 * inside BigQuery (data/units_by_country.csv; counts only). The top five
 * countries as bars with the units and the share of the whole, the rest as
 * one row; the orders behind each on the hover. The Overview shows the card
 * only when the snapshot carries rows. */
import React from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, niceAxis, kfmt, COL, sw } from "../charts.jsx";
import { fmt } from "../format.mjs";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);

export default function Geo({ snap }) {
  const g = snap.geo;
  const raw = Array.isArray(g) ? g : g && g.rows;
  const rows = (raw || []).map((r) => ({ name: r.country ?? r.name, v: r.units ?? r.entries ?? r.value ?? 0, orders: r.orders }))
    .filter((r) => r.name && r.v > 0).sort((a, b) => (a.name === "Unknown") - (b.name === "Unknown") || b.v - a.v);
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.v, 0);
  const orders = rows.reduce((a, r) => a + (has(r.orders) ? r.orders : 0), 0);
  const top = rows.slice(0, 5);
  const restRows = rows.slice(5);
  const rest = restRows.reduce((a, r) => a + r.v, 0);
  const shown = rest > 0 ? [...top, { name: restRows.length === 1 ? restRows[0].name : `Elsewhere (${restRows.length})`, v: rest, orders: restRows.reduce((a, r) => a + (has(r.orders) ? r.orders : 0), 0) }] : top;
  const share = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const ax = niceAxis(Math.max(1, ...shown.map((r) => r.v)), 2);
  const unit = (g && g.unit) || "units";
  return (
    <Card title="Orders by country" aria="Orders by country">
      <Head v={fmt(total)} u={unit} aside={`${share(top.reduce((a, r) => a + r.v, 0))}% in the top ${top.length}${orders > 0 ? ` · ${fmt(orders)} orders` : ""}`}
        asideTip="Units paid by the country the order ships to (else is billed to), counted on the orders feed; a unit with no country on its order is Unknown" />
      <HBarChart H={34 + shown.length * 30} L={118} bh={10} xmin={0} xmax={ax.ymax} xticks={ax.ticks} xfmt={kfmt}
        rows={shown.map((r) => r.name)} series={[{ color: COL.IND, vals: shown.map((r) => r.v) }]}
        title={(i) => shown[i].name}
        rows2={(i) => [
          { n: unit[0].toUpperCase() + unit.slice(1), v: fmt(shown[i].v), k: sw(COL.IND) },
          ...(has(shown[i].orders) && shown[i].orders > 0 ? [{ n: "Orders", v: fmt(shown[i].orders), k: { width: 8, flex: "0 0 8px" } }] : []),
          { n: "Share", v: `${share(shown[i].v)}%`, k: { width: 8, flex: "0 0 8px" } },
        ]}
        aria={`Orders by country: ${shown.map((r) => `${r.name} ${fmt(r.v)}`).join(", ")}`} />
    </Card>
  );
}
