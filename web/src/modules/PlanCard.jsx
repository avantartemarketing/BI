/* The plan (the plan-based view, docs/PLAN_MODEL.md): each phase of the comms
 * plan as one bar - the plan in grey, as long as the plan and ending at its
 * tick, and on it what the phase has brought and what is still to come - with
 * its plan and its actuals beside it, and beside the bars a box of the pieces
 * inside. The forecast (the actuals and what is still to come) is the bar
 * itself, and its figures are in the readout a bar shows when it is hovered
 * or touched. With nothing picked the box lists every email and post,
 * the one furthest behind its plan first (in date order before anything has
 * gone out); pick a phase and it lists that phase's alone, its last line what
 * came by search, a typed address or days later (the baseline, shared over the
 * phases: docs/PLAN_MODEL.md 6), or paid by what is spent and still to spend.
 * Pick it again to go back. The box keeps the height of the bars and scrolls inside, fading at
 * its foot while there is more below. The figures are etl/plan_view.py's; on
 * a timed launch gathering signups they are etl/tl_plan.py's, in signups to
 * the sales open, with paid read from the spend still to come. */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Card, Head } from "../ui.jsx";
import { COL, sw } from "../charts.jsx";
import { fmt } from "../format.mjs";
import { ownRecord } from "../planCheck.mjs";

const n = (v) => fmt(Math.round(v));
/* whole units that add up to `total` (the rounded sum when none is given): the largest remainders take the units left
 * over, and where the total is below what the values floor to, the smallest give one back */
function fit(vals, total) {
  const want = total === undefined ? Math.round(vals.reduce((a, b) => a + b, 0)) : total;
  const out = vals.map(Math.floor);
  const order = vals.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  let need = want - out.reduce((a, b) => a + b, 0);
  for (let k = 0; k < need && order.length; k++) out[order[k % order.length][1]] += 1;
  for (let k = order.length - 1; need < 0 && out.some((v) => v > 0); k = (k + order.length - 1) % order.length) {
    if (out[order[k][1]] > 0) { out[order[k][1]] -= 1; need += 1; }
  }
  return out;
}

/* The rows and their pieces in whole units that add up: the rows' actuals to what is in so far, their forecasts
 * (in the readouts) to the card's headline, and each row's pieces to the row, figure by figure. The actuals are
 * shared out first and what is still to come out of what the headline leaves, so a forecast is its actuals and its
 * still to come and never below its actuals (27 November 2026: the forecast was shared out first and the actuals
 * held under it, which could leave a row's pieces one short of the row once the actuals were printed). */
export function planModel(p) {
  const start = p.state === "start";
  const sum = (a) => a.reduce((t, v) => t + v, 0);
  const exp = fit(p.rows.map((r) => r.expected));
  const inn = start ? p.rows.map(() => 0) : fit(p.rows.map((r) => r.in || 0));
  const cme = start ? exp : fit(p.rows.map((r) => r.toCome || 0), Math.max(Math.round(sum(p.rows.map((r) => (r.in || 0) + (r.toCome || 0)))) - sum(inn), 0));
  const rows = p.rows.map((r, i) => {
    const ps = r.pieces || [];
    const pe = fit(ps.map((x) => x.expected), exp[i]);
    const pi = start ? ps.map(() => 0) : fit(ps.map((x) => x.in || 0), inn[i]);
    const pc = start ? pe : fit(ps.map((x) => x.toCome || 0), cme[i]);
    const dates = [...new Set(ps.map((x) => x.when).filter(Boolean))];
    return {
      key: r.moment, name: r.moment, note: r.note, exp: exp[i], inn: inn[i], come: cme[i], lands: inn[i] + cme[i], dates,
      pieces: ps.map((x, j) => ({ ...x, exp: pe[j], inn: pi[j], come: pc[j], lands: pi[j] + pc[j] })),
    };
  });
  const top = Math.max(1, ...rows.map((r) => Math.max(r.exp, r.lands))) * 1.04;
  return { start, rows, top };
}
const pct = (v, top) => `${Math.min(Math.max(v / top, 0), 1) * 100}%`;

/* one bar: the plan in grey, as long as the plan and ending at its tick, and on it what is in so far and what is
 * still to come. The grey left showing is what the plan is short by; a bar that passes the tick is over it.
 * Nothing in yet draws no first segment, so the bar's rounded end is the next one's. `over` is what the card
 * hangs on a bar for its readout (the hover, the touch, and the same figures in words). */
function Bar({ x, top, over }) {
  return (
    <span className="strack" {...over}>
      <b style={{ width: pct(x.exp, top) }} />
      {x.inn > 0 && <i style={{ left: 0, width: pct(x.inn, top), background: COL.DEEP }} />}
      <i style={{ left: pct(x.inn, top), width: pct(x.come, top), background: COL.LIGHT }} />
      <s style={{ left: `calc(${pct(x.exp, top)} - 1px)` }} />
    </span>
  );
}

export default function PlanCard({ snap }) {
  const p = snap.plan;
  const [sel, setSel] = useState(null);
  const box = useRef(null);
  const split = useRef(null);
  const tipBox = useRef(null);
  const [tip, setTip] = useState(null);   // the bar under the pointer: its row, its name and where its readout sits
  const [more, setMore] = useState(false);
  const check = () => { const el = box.current; if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2); };
  useEffect(() => { setSel(null); setTip(null); }, [snap.id]);
  useEffect(() => { if (box.current) box.current.scrollTop = 0; }, [sel, snap.id]);
  useEffect(check);
  /* the readout is placed once it has a size: above its bar and in line with it, kept inside the card's width,
   * and under the bar where the window has no room above it */
  useLayoutEffect(() => {
    const el = tipBox.current, host = split.current;
    if (!el || !host || !tip) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(0, Math.min(tip.right ? tip.at - w : tip.at, host.clientWidth - w));
    const above = tip.room >= h + 16;
    el.style.left = `${left}px`;
    el.style.top = `${above ? tip.top - 8 - h : tip.bottom + 8}px`;
    el.style.visibility = "visible";
  }, [tip]);
  if (!p || !Array.isArray(p.rows)) return null;
  const m = planModel(p);
  const s = m.rows.find((r) => r.key === sel);
  // every email and post: a phase's last line (what no one piece's link brought, `tail`) is no piece, and is
  // listed inside its phase alone
  const every = m.rows.filter((r) => r.key !== "Paid").flatMap((r) => r.pieces).filter((x) => !x.tail);
  const gaps = every.some((x) => x.lands !== x.exp);
  const list = s ? s.pieces : gaps ? every.slice().sort((a, b) => (a.lands - a.exp) - (b.lands - b.exp)) : every;
  const ptop = Math.max(1, ...list.map((x) => Math.max(x.exp, x.lands))) * 1.06;
  const dated = s ? s.dates.length > 1 : true;
  const short = Math.round(p.target) - Math.round(p.lands);
  const likely = Array.isArray(p.range) ? `likely ${n(p.range[0])} to ${n(p.range[1])}` : undefined;
  const rec = ownRecord(p);   // the plan check itself is a warning at the top of the page, and only when the plan is too small (web/src/planCheck.mjs)
  /* A bar's readout: the forecast and what it is made of, which the row itself no longer prints (27 November
   * 2026: the figure beside a bar is its actuals). It starts at the bar's left edge in the left half of the
   * card and ends at its right edge in the right half (the effect above places it). Not before anything has
   * gone out, when the forecast is the plan. An empty title keeps the row's own hint off the bar. */
  const show = (e, x, title) => {
    const host = split.current;
    if (!host) return;
    const hb = host.getBoundingClientRect(), bb = e.currentTarget.getBoundingClientRect();
    const right = bb.left + bb.width / 2 > hb.left + hb.width / 2;
    setTip({ x, title, right, at: (right ? bb.right : bb.left) - hb.left, top: bb.top - hb.top, bottom: bb.bottom - hb.top, room: bb.top });
  };
  const over = (x, title) => (m.start ? undefined : {
    title: "", role: "img", "aria-label": `Forecast ${n(x.lands)}: ${n(x.inn)} actuals and ${n(x.come)} still to come, against a plan of ${n(x.exp)}`,
    onMouseEnter: (e) => show(e, x, title), onTouchStart: (e) => show(e, x, title), onMouseLeave: () => setTip(null),
  });
  return (
    <Card wide title="The plan" className={`plan-card${m.start ? " start" : ""}`} aria="The plan, phase by phase">
      <Head v={n(p.lands)} u={snap.type === "TL" ? `${p.of === "conversions" ? "conversions" : "signups"} at the open` : "at the close"} tip={(p.notes || []).join(" ")}
        deltas={[short > 0 ? { t: `${n(short)} short of the ${n(p.target)} target`, dir: "dn" } : { t: `reaches the ${n(p.target)} target`, dir: "up" }]}
        aside={m.start ? likely : `day ${snap.day} of ${snap.of}`} asideTip={(p.notes || []).join(" ")} />
      {rec && <div className="plan-rec">{rec}</div>}
      <div className="pv-split" ref={split}>
        <div className="plan-rows">
          <div className="plan-r head"><span /><span /><span>Plan</span>{!m.start && <span>Actuals</span>}</div>
          {m.rows.map((r) => (
            <button type="button" key={r.key} className={`plan-r row${sel === r.key ? " sel" : ""}`} disabled={!r.pieces.length} aria-pressed={sel === r.key}
              title={r.pieces.length ? (sel === r.key ? "Back to every piece" : `Show what is inside ${r.name}`) : undefined} onClick={() => setSel(sel === r.key ? null : r.key)}>
              <span className="nm">{r.name}</span>
              <Bar x={r} top={m.top} over={over(r, r.name)} />
              <span className="pl">{n(r.exp)}</span>
              {!m.start && <span className="ac">{n(r.inn)}</span>}
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
            <div className="pv-l head"><span /><span /><span>Plan</span>{!m.start && <span>Actuals</span>}</div>
            <div className={`pv-list${more ? " more" : ""}`} ref={box} onScroll={() => { check(); if (tip) setTip(null); }} tabIndex={0}>
              {list.map((x, i) => (
                <div className="pv-l" key={`${i}-${x.when}-${x.name}`}>
                  <span className="nm" title={x.tip || x.name}>{dated && x.when && <em>{x.when}</em>}{x.name}</span>
                  <Bar x={x} top={ptop} over={over(x, dated && x.when ? `${x.when} ${x.name}` : x.name)} />
                  <span className="pl">{n(x.exp)}</span>
                  {!m.start && <span className="ac">{n(x.inn)}</span>}
                </div>
              ))}
              {!list.length && <div className="pv-pn">No emails or posts in the plan yet</div>}
            </div>
          </aside>
        </div>
        {tip && (
          <div className="tip plan-tip" ref={tipBox} aria-hidden="true">
            <div className="tt">{tip.title}</div>
            <div className="tr"><span style={sw(COL.DEEP)} />Actuals<b>{n(tip.x.inn)}</b></div>
            <div className="tr"><span style={sw(COL.LIGHT)} />Still to come<b>{n(tip.x.come)}</b></div>
            <div className="tr"><span style={sw(`linear-gradient(90deg, ${COL.DEEP} 50%, ${COL.LIGHT} 50%)`)} />Forecast<b>{n(tip.x.lands)}</b></div>
            <div className="tr"><span style={{ width: 8, height: 11, flex: "0 0 8px", background: `linear-gradient(${COL.INK}, ${COL.INK}) 3px 0 / 2px 100% no-repeat` }} />Plan<b>{n(tip.x.exp)}</b></div>
          </div>
        )}
      </div>
      <div className="keys">
        {!m.start && <span className="key"><span style={sw(COL.DEEP)} />Actuals</span>}
        <span className="key"><span style={sw(COL.LIGHT)} />Still to come</span>
        <span className="key"><span style={{ width: 0, height: 12, borderLeft: `2px solid ${COL.INK}` }} />Plan</span>
      </div>
    </Card>
  );
}
