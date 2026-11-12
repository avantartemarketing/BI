/* What an ad set drives (snap.paid.adsetEntries, etl/build.py adset_entries):
 * under a line's paid cards, the entries its ad set's clicks made on each
 * line of the release, what those entrants have paid for, what still waits
 * as pre-orders and as draw entries, and the units all of it is taken to
 * come to: the paid units, the pre-orders at the pre-order rate and the draw
 * entries at the entry rate, the figure the ROI beside it is read on. The
 * switch picks the days: the whole campaign, or the last seven, three or
 * one full days. Only on a line read by its ad sets (docs METHODOLOGY 7b). */
import React, { useState } from "react";
import { Card, Seg } from "../ui.jsx";
import { fmt, fmtPct } from "../format.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const PERIODS = [["all", "All", "The whole campaign so far, today included"], ["7d", "7d", "The last seven full days"],
  ["3d", "3d", "The last three full days"], ["1d", "1d", "The last full day"]];
const DAYS = { "7d": 7, "3d": 3, "1d": 1 };
const num = (v) => (has(v) && Math.abs(v) > 1e-9 ? fmt(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1) : "–");

export default function AdsetEntries({ snap }) {
  const [period, setPeriod] = useState("all");
  const paid = snap.paid || {};
  const ae = paid.adsetEntries;
  if (!ae || !Array.isArray(ae.lines) || !ae.lines.length) return null;
  const pre = has(paid.preorderRate) ? paid.preorderRate : 0.95;
  const ent = has(paid.dropOff) ? 1 - paid.dropOff : 0.8;
  // the last full day the paid series reads: the windows end on it
  const full = (paid.daily || []).filter((d) => !d.partial).map((d) => d.date).sort();
  const last = full.length ? full[full.length - 1] : null;
  const from = (() => {
    if (period === "all" || !last) return null;
    const d = new Date(`${last}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (DAYS[period] - 1));
    return d.toISOString().slice(0, 10);
  })();
  const inPeriod = (d) => (from === null ? true : d >= from && d <= last);
  const rows = ae.lines.map((l) => {
    const r = { key: l.key, name: l.name, own: l.own, entries: 0, paid: 0, preorders: 0, draws: 0 };
    for (const x of ae.daily || []) {
      if (x.line !== l.key || !inPeriod(x.date)) continue;
      r.entries += x.entries || 0; r.paid += x.paid || 0; r.preorders += x.preorders || 0; r.draws += x.draws || 0;
    }
    r.units = r.paid + r.preorders * pre + r.draws * ent;
    return r;
  });
  const tot = rows.reduce((a, r) => ({ entries: a.entries + r.entries, paid: a.paid + r.paid, preorders: a.preorders + r.preorders, draws: a.draws + r.draws, units: a.units + r.units }),
    { entries: 0, paid: 0, preorders: 0, draws: 0, units: 0 });
  const adset = ((snap.line || {}).adsets || []).join(", ");
  const title = "Entries by line";
  return (
    <Card wide title={title} aria={title} seg={<Seg label="Days" value={period} onChange={setPeriod} options={PERIODS} />}>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left", paddingLeft: 0 }} title={adset ? `What the clicks on ${adset} went on to enter` : undefined}>Entered for</th>
              <th title="Draw entries made, one for each work entered">Entries</th>
              <th title="Units those entrants have paid for">Paid</th>
              <th title={`Pre-order entries still waiting, counted at ${fmtPct(pre, 0)}`}>Pre-orders</th>
              <th title={`Draw entries still waiting, counted at ${fmtPct(ent, 0)}`}>Draws</th>
              <th title={`Paid, plus pre-orders at ${fmtPct(pre, 0)} and draws at ${fmtPct(ent, 0)}: the units the ROI is read on`}>Total assumed units</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={{ textAlign: "left" }}>{r.name}</td>
                <td>{num(r.entries)}</td><td>{num(r.paid)}</td><td>{num(r.preorders)}</td><td>{num(r.draws)}</td><td>{num(r.units)}</td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr className="recrow">
                <td style={{ textAlign: "left" }}>Total</td>
                <td>{num(tot.entries)}</td><td>{num(tot.paid)}</td><td>{num(tot.preorders)}</td><td>{num(tot.draws)}</td><td>{num(tot.units)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
