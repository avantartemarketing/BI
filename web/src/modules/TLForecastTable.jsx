/* A timed launch before its window, as one table across the page under the
 * signup trajectory (12 November 2026, docs/TL_SPEC.md 4c): the LE page's
 * sell-through table in a timed launch's terms. A row per work, the release
 * as the last row where there is more than one work. Signups to date, the
 * target's pace by today and the gap to it; the signups forecast at the
 * open; the sales those signups are forecast to make, the sales forecast
 * from buyers who never signed up and their sum, with the likely range on
 * hover; the units target; and the forecast as a share of the target (a
 * timed launch has no edition to sell through, so its target is the
 * measure). The rows are tlForecastRows'. */
import React from "react";
import { Card } from "../ui.jsx";
import { fmt, fmtPct } from "../format.mjs";
import { tlForecastRows } from "../tlForecastRows.mjs";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const rag = (p) => (p >= 0 ? "rag-up" : p >= -0.2 ? "rag-near" : "rag-dn");
const signed = (p) => `${p >= 0 ? "+" : "−"}${Math.abs(Math.round(p * 100))}%`;
const num = (v) => (has(v) ? fmt(v) : "–");

export default function TLForecastTable({ snap }) {
  const title = "Sell-through forecast";
  const f = snap.sellForecast;
  const { rows, all, byPage } = tlForecastRows(snap);
  if (!f || !all) return <Card title={title} wide><div className="empty-state">No forecast yet: it needs the works from Airtable or a units target</div></Card>;
  const ranged = (r) => has(r.lo) && has(r.hi) && r.hi > r.lo;
  const cells = (r) => {
    const vs = has(r.signups) && has(r.targetToDate) && r.targetToDate > 0 ? r.signups / r.targetToDate - 1 : null;
    const pct = has(r.units) && has(r.target) ? r.units / r.target : null;
    return (
      <>
        <td className={has(r.signups) ? "b" : "dim"}>{num(r.signups)}</td>
        <td className={has(r.targetToDate) ? "" : "dim"}>{num(r.targetToDate)}</td>
        <td className={vs === null ? "dim" : rag(vs)}>{vs === null ? "–" : signed(vs)}</td>
        <td className={has(r.forecastSignups) ? "" : "dim"}>{num(r.forecastSignups)}</td>
        <td className={has(r.su) ? "" : "dim"}>{num(r.su)}</td>
        <td className={has(r.non) ? "" : "dim"}>{num(r.non)}</td>
        <td className={has(r.units) ? "b" : "dim"} title={ranged(r) ? `Likely ${fmt(r.lo)} to ${fmt(r.hi)}` : undefined}>{num(r.units)}</td>
        <td className={has(r.target) ? "" : "dim"}>{num(r.target)}</td>
        <td className={pct === null ? "dim" : pct >= 1 ? "good b" : "b"} title={ranged(r) && has(r.target) ? `Likely ${fmtPct(r.lo / r.target, 0)} to ${fmtPct(r.hi / r.target, 0)}` : undefined}>{pct === null ? "–" : fmtPct(pct, 0)}</td>
      </>
    );
  };
  const rowTip = (r) => [
    r.name,
    byPage ? "Signups: the ones made from this work's page, plus its share of the signups that name no work" : "Signups: the release's, shared out by each work's units target (too few name a work so far)",
  ].join("\n");
  return (
    <Card title={title} wide className="stt-card" aria="Sell-through forecast by work">
      <div className="stt-wrap">
        <table className="stt">
          <colgroup>{[19, 8, 9, 8, 9, 10, 10, 9, 8, 10].map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
          <thead><tr>
            <th>Work</th><th>Signups</th><th>Signup target to date</th><th>vs target</th><th>Forecast signups</th><th>Forecast sales from signups</th><th>Forecast non-signup sales</th><th>Forecast total sales</th><th>Target</th>
            <th><span className="sorted">Forecast <span aria-hidden="true">↓</span></span></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} title={rows.length > 1 ? rowTip(r) : undefined}>
                <td><span className="nmw"><span className="ldot" style={{ background: "var(--ind)" }} /><span className="nm2"><span className="n">{r.name}</span></span></span></td>
                {cells(rows.length > 1 ? r : { ...r, ...all, key: r.key, name: r.name })}
              </tr>
            ))}
            {rows.length > 1 && (
              <tr className="all">
                <td><span className="nmw"><span className="ldot" style={{ background: "var(--muted)" }} /><span className="nm2"><span className="n">{all.name}</span></span></span></td>
                {cells(all)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
