/* The plan (the plan-based view, docs/PLAN_MODEL.md): each phase of the comms
 * plan as one bar - what it has brought, what is still to come, and a tick
 * where the plan put it - with its two figures, and beside the bars a box of
 * the pieces inside. With nothing picked the box lists every email and post,
 * the one furthest behind its plan first (in date order before anything has
 * gone out); pick a phase and it lists that phase's alone, the baseline by
 * channel, or paid by what is spent and still to spend. Pick it again to go
 * back. The box keeps the height of the bars and scrolls inside, fading at
 * its foot while there is more below. The figures are etl/plan_view.py's; on
 * a timed launch gathering signups they are etl/tl_plan.py's, in signups to
 * the sales open, with paid read from the spend still to come. */
import React, { useEffect, useRef, useState } from "react";
import { Card, Head } from "../ui.jsx";
import { COL, sw } from "../charts.jsx";
import { fmt } from "../format.mjs";

const n = (v) => fmt(Math.round(v));
/* whole units that add up to `total` (the rounded sum when none is given): the largest remainders take the units left over */
function fit(vals, total) {
  const want = total === undefined ? Math.round(vals.reduce((a, b) => a + b, 0)) : total;
  const out = vals.map(Math.floor);
  const order = vals.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  const need = want - out.reduce((a, b) => a + b, 0);
  for (let k = 0; k < need && order.length; k++) out[order[k % order.length][1]] += 1;
  return out;
}

/* the rows and their pieces in whole units that add up: the rows' landings to the card's headline, and each
 * row's pieces to the row */
export function planModel(p) {
  const start = p.state === "start";
  const exp = fit(p.rows.map((r) => r.expected));
  const lnd = start ? exp : fit(p.rows.map((r) => (r.in || 0) + (r.toCome || 0)));
  const inn = start ? p.rows.map(() => 0) : fit(p.rows.map((r) => r.in || 0)).map((v, i) => Math.min(v, lnd[i]));
  const rows = p.rows.map((r, i) => {
    const ps = r.pieces || [];
    const pe = fit(ps.map((x) => x.expected), exp[i]);
    const pl = start ? pe : fit(ps.map((x) => (x.in || 0) + (x.toCome || 0)), lnd[i]);
    const pi = start ? ps.map(() => 0) : fit(ps.map((x) => x.in || 0), inn[i]).map((v, j) => Math.min(v, pl[j]));
    const dates = [...new Set(ps.map((x) => x.when).filter(Boolean))];
    return {
      key: r.moment, name: r.moment, note: r.note, exp: exp[i], inn: inn[i], come: lnd[i] - inn[i], lands: lnd[i], dates,
      pieces: ps.map((x, j) => ({ ...x, exp: pe[j], inn: pi[j], come: pl[j] - pi[j], lands: pl[j] })),
    };
  });
  const top = Math.max(1, ...rows.map((r) => Math.max(r.exp, r.lands))) * 1.04;
  return { start, rows, top };
}
const pct = (v, top) => `${Math.min(Math.max(v / top, 0), 1) * 100}%`;

/* The plan check, in words: whether the plan as written is in line with the
 * target, on the launches that sold nearest it at a similar price, and the
 * artist's own earlier launches beside it. The target says how much the work
 * is wanted; this says only whether the comms are enough for a launch that
 * size (etl/plan_view.py override). Nothing on a plan sized the older way. */
export function planCheck(p) {
  if (!p || !p.against) return null;
  const lo = Array.isArray(p.range) ? n(p.range[0]) : null, hi = Array.isArray(p.range) ? n(p.range[1]) : null;
  const span = lo !== null ? ` Launches that sold about this many at a similar price would have brought ${lo} to ${hi} with these comms.` : "";
  const gap = Math.round(p.notCovered || 0);
  const lead = p.against === "in line" ? `The plan as written is in line with the ${n(p.target)} target.`
    : p.against === "short" ? `The plan as written is ${gap} short of the ${n(p.target)} target: it is lighter than the plans of launches that sold this many.`
      : `The plan as written is heavier than launches that sold ${n(p.target)} have needed.`;
  const title = (name) => { const b = String(name || "").split(" \u00b7 "); return b.length > 2 ? `${b[1]} (${b[b.length - 1]})` : name; };
  const own = (p.ownRecord || []).filter((r) => r && r.edition > 0 && r.sold !== null && r.sold !== undefined);
  const record = own.length ? "Earlier launches: " + own.map((r) => `${title(r.name)} sold ${n(r.sold)} of ${n(r.edition)}${r.cover ? `, entered for ${r.cover.toFixed(1)} times the edition` : ""}`).join("; ") + "." : null;
  return { kind: p.against, lead, span, record, similar: (p.similar || []).map((x) => String(x.name || "").split(" \u00b7 ")[0]) };
}

/* one bar: in so far, still to come, and the plan's tick */
function Bar({ x, top }) {
  return (
    <span className="strack">
      <i style={{ left: 0, width: pct(x.inn, top), background: COL.DEEP }} />
      <i style={{ left: pct(x.inn, top), width: pct(x.come, top), background: COL.LIGHT }} />
      <s style={{ left: `calc(${pct(x.exp, top)} - 1px)` }} />
    </span>
  );
}

export default function PlanCard({ snap }) {
  const p = snap.plan;
  const [sel, setSel] = useState(null);
  const box = useRef(null);
  const [more, setMore] = useState(false);
  const check = () => { const el = box.current; if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2); };
  useEffect(() => { setSel(null); }, [snap.id]);
  useEffect(() => { if (box.current) box.current.scrollTop = 0; }, [sel, snap.id]);
  useEffect(check);
  if (!p || !Array.isArray(p.rows)) return null;
  const m = planModel(p);
  const s = m.rows.find((r) => r.key === sel);
  const every = m.rows.filter((r) => r.key !== "Baseline" && r.key !== "Paid").flatMap((r) => r.pieces);
  const gaps = every.some((x) => x.lands !== x.exp);
  const list = s ? s.pieces : gaps ? every.slice().sort((a, b) => (a.lands - a.exp) - (b.lands - b.exp)) : every;
  const ptop = Math.max(1, ...list.map((x) => Math.max(x.exp, x.lands))) * 1.06;
  const dated = s ? s.dates.length > 1 : true;
  const short = Math.round(p.target) - Math.round(p.lands);
  const likely = Array.isArray(p.range) ? `likely ${n(p.range[0])} to ${n(p.range[1])}` : undefined;
  const chk = planCheck(p);
  return (
    <Card wide title="The plan" className={`plan-card${m.start ? " start" : ""}`} aria="The plan, phase by phase">
      <Head v={n(p.lands)} u={snap.type === "TL" ? "signups at the open" : "at the close"} tip={(p.notes || []).join(" ")}
        deltas={[short > 0 ? { t: `${n(short)} short of the ${n(p.target)} target`, dir: "dn" } : { t: `reaches the ${n(p.target)} target`, dir: "up" }]}
        aside={m.start ? likely : `day ${snap.day} of ${snap.of}`} asideTip={(p.notes || []).join(" ")} />
      {chk && (
        <div className={`plan-chk ${chk.kind === "short" ? "dn" : "ok"}`} title={chk.similar.length ? `Read against ${[...new Set(chk.similar)].join(", ")}` : undefined}>
          <b>{chk.lead}</b>{chk.span}
          {chk.record && <span className="rec">{chk.record}</span>}
        </div>
      )}
      <div className="pv-split">
        <div className="plan-rows">
          <div className="plan-r head"><span /><span /><span>Plan</span>{!m.start && <span>Lands at</span>}</div>
          {m.rows.map((r) => (
            <button type="button" key={r.key} className={`plan-r row${sel === r.key ? " sel" : ""}`} disabled={!r.pieces.length} aria-pressed={sel === r.key}
              title={r.pieces.length ? (sel === r.key ? "Back to every piece" : `Show what is inside ${r.name}`) : undefined} onClick={() => setSel(sel === r.key ? null : r.key)}>
              <span className="nm">{r.name}</span>
              <Bar x={r} top={m.top} />
              <span className="pl">{n(r.exp)}</span>
              {!m.start && <span className="ld">{n(r.lands)}</span>}
            </button>
          ))}
        </div>
        <div className="pv-rw">
          <aside className="pv-side" aria-label={s ? `Inside ${s.name}` : "Every piece of the plan"}>
            <div className="pv-ph">
              <span className="t">{s ? s.name : `All ${every.length} pieces`}</span>
              <span className="d">{s ? (!dated && s.dates[0]) || "" : gaps ? "furthest behind plan first" : "in date order"}</span>
            </div>
            {s && s.note && <div className="pv-pn">{s.note}</div>}
            <div className="pv-l head"><span /><span /><span>Plan</span>{!m.start && <span>Lands at</span>}</div>
            <div className={`pv-list${more ? " more" : ""}`} ref={box} onScroll={check} tabIndex={0}>
              {list.map((x, i) => (
                <div className="pv-l" key={`${i}-${x.when}-${x.name}`}>
                  <span className="nm" title={x.name}>{dated && x.when && <em>{x.when}</em>}{x.name}</span>
                  <Bar x={x} top={ptop} />
                  <span className="pl">{n(x.exp)}</span>
                  {!m.start && <span className="ld">{n(x.lands)}</span>}
                </div>
              ))}
              {!list.length && <div className="pv-pn">No emails or posts in the plan yet</div>}
            </div>
          </aside>
        </div>
      </div>
      <div className="keys">
        {!m.start && <span className="key"><span style={sw(COL.DEEP)} />In so far</span>}
        <span className="key"><span style={sw(COL.LIGHT)} />Still to come</span>
        <span className="key"><span style={{ width: 0, height: 12, borderLeft: `2px solid ${COL.INK}` }} />Plan</span>
      </div>
    </Card>
  );
}
