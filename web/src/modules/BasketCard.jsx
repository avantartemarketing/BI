/* The Benchmark basket card (README, What the dashboard shows): the launches
 * the page's medians are read from, one per row with the figures the picker
 * ranks on, its units of demand (what it would have sold with enough supply,
 * the figure the rule matched it on and the benchmark reads it at) and its
 * unit price, with the units it sold beside them, largest demand first. A
 * page built before the rows carried demand, and a timed launch's page, show
 * the units sold and the price alone. A row opens that launch's own page
 * where the index has one. Nothing else lives
 * here: the rule that picked the launches, their medians and the picker are
 * the Target setting tab's (docs/DATA_MODEL.md 3, docs/TL_SPEC.md 8). The
 * build writes the rows under benchmark.members, the same on both Direct
 * views, so the card has nothing to fetch. */
import React from "react";
import { fmt, fmtMoney } from "../ui.jsx";
import { wordsOf } from "../vocab.mjs";

export default function BasketCard({ snap, index, onOpen }) {
  const bm = snap.benchmark || {};
  const raw = Array.isArray(bm.members) ? bm.members : [];
  if (!raw.length) return null;
  const W = wordsOf(snap);
  // the rows carry demand since the rule ranks on it (etl/baskets.py
  // basket_members); older pages and timed launches carry units sold alone
  const hasDemand = raw.some((m) => m.demand !== undefined && m.demand !== null);
  const size = (m) => (hasDemand ? (m.demand ?? m.units) : m.units);
  const members = raw.slice().sort((a, b) => (size(b) || 0) - (size(a) || 0));
  const rowClass = hasDemand ? "basket-row four" : "basket-row";
  const figure = (v) => (v === null || v === undefined ? "–" : fmt(v));
  // an artist with more than one launch in the basket is told apart by the quarter
  const times = {};
  raw.forEach((m) => { times[m.artist] = (times[m.artist] || 0) + 1; });
  const label = (m) => (m.artist && times[m.artist] > 1 && m.quarter ? `${m.artist} · ${m.quarter}` : m.artist || m.name);
  const idOf = (name) => { const r = (index || []).find((x) => x.releaseName === name); return r ? r.id : null; };
  /* A release selling lines of work (docs/LINES_PLAN.md): on the combined
     page each line has a basket of its own, so the launches sit under a
     heading per line, with the line's basket named and its median units;
     a launch in both baskets is listed under both. A line's own page lists
     its basket plain. */
  const lineBaskets = bm.lines && typeof bm.lines === "object" && !snap.line ? bm.lines : null;
  const lineDefs = Array.isArray(snap.lines) ? snap.lines : [];
  const groups = lineBaskets ? Object.entries(lineBaskets).map(([key, b]) => {
    const def = lineDefs.find((l) => l.key === key) || {};
    const names = new Set(b.members || []);
    return { key, name: def.name || key, basket: b, median: def.benchmarkUnits, rows: members.filter((m) => names.has(m.name)) };
  }).filter((g) => g.rows.length) : null;
  const row = (m, g) => {
    const id = idOf(m.name);
    const cells = (
      <>
        <span className="nm">{label(m)}</span>
        <span className="num units">{figure(size(m))}</span>
        {hasDemand && <span className="num sold">{figure(m.units)}</span>}
        <span className="num price">{fmtMoney(m.price)}</span>
      </>
    );
    const k = g ? `${g.key}:${m.name}` : m.name;
    const what = hasDemand
      ? `${m.name} · demand for ${figure(size(m))} units${m.demand > (m.units || 0) ? ` (sold ${figure(m.units)}, the rest wanted by entrants left without a unit)` : " (all of it sold)"}`
      : m.name;
    return id && onOpen
      ? <button key={k} type="button" className={rowClass} title={`${what} · opens its page`} onClick={() => onOpen(id)}>{cells}</button>
      : <div key={k} className={rowClass} title={what}>{cells}</div>;
  };
  return (
    <div className="card">
      <div className="mod-head">
        <span className="swatch-bm" />
        <span className="title">{groups ? "Benchmark baskets" : "Benchmark basket"}</span>
        <span className="right">{groups ? `${groups.length} lines` : `${members.length} ${W.launches}`}</span>
      </div>
      <div className="spacer-8" />
      <div className={hasDemand ? "basket-cols four" : "basket-cols"} aria-hidden="true"><span />{hasDemand ? <><span title="What the launch would have sold with enough supply: the figure the rule matched it on">Demand</span><span>Sold</span></> : <span>Units</span>}<span>Price</span></div>
      <div className="basket-rows">
        {groups ? groups.map((g) => (
          <React.Fragment key={g.key}>
            <div className={rowClass} style={{ cursor: "default" }}
              title={`${g.name}: benchmarked on ${g.basket.name || g.basket.id}${g.basket.thin ? " (thin)" : ""}${g.median ? `, a median of ${fmt(g.median)} units of demand` : ""}. The launches under it are its basket's.`}>
              <span className="nm" style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 11 }}>{g.name}</span>
              <span className="num units" style={{ fontSize: 11.5 }}>{g.median ? fmt(g.median) : ""}</span>
              {hasDemand && <span className="num sold" />}
              <span className="num price" style={{ fontSize: 11 }}>{g.rows.length} {W.launches}</span>
            </div>
            {g.rows.map((m) => row(m, g))}
          </React.Fragment>
        )) : members.map((m) => row(m, null))}
      </div>
    </div>
  );
}
