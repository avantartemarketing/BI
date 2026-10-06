/* The Benchmark basket card (README, What the dashboard shows): the launches
 * the page's medians are read from, one per row with the two figures the
 * picker shows, the units it sold and its unit price, largest first. A row
 * opens that launch's own page where the index has one. Nothing else lives
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
  const members = raw.slice().sort((a, b) => (b.units || 0) - (a.units || 0));
  // an artist with more than one launch in the basket is told apart by the quarter
  const times = {};
  raw.forEach((m) => { times[m.artist] = (times[m.artist] || 0) + 1; });
  const label = (m) => (m.artist && times[m.artist] > 1 && m.quarter ? `${m.artist} · ${m.quarter}` : m.artist || m.name);
  const idOf = (name) => { const r = (index || []).find((x) => x.releaseName === name); return r ? r.id : null; };
  return (
    <div className="card">
      <div className="mod-head">
        <span className="swatch-bm" />
        <span className="title">Benchmark basket</span>
        <span className="right">{members.length} {W.launches}</span>
      </div>
      <div className="spacer-8" />
      <div className="basket-cols" aria-hidden="true"><span /><span>Units</span><span>Price</span></div>
      <div className="basket-rows">
        {members.map((m) => {
          const id = idOf(m.name);
          const cells = (
            <>
              <span className="nm">{label(m)}</span>
              <span className="num units">{m.units === null || m.units === undefined ? "–" : fmt(m.units)}</span>
              <span className="num price">{fmtMoney(m.price)}</span>
            </>
          );
          return id && onOpen
            ? <button key={m.name} type="button" className="basket-row" title={`${m.name} · opens its page`} onClick={() => onOpen(id)}>{cells}</button>
            : <div key={m.name} className="basket-row" title={m.name}>{cells}</div>;
        })}
      </div>
    </div>
  );
}
