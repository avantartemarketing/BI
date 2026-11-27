/* The plan (the plan-based view, docs/PLAN_MODEL.md), as two cards.
 *
 * "The plan": each phase of the comms plan as one bar - the plan in grey, as
 * long as the plan and ending at its tick, and on it what the phase has
 * brought and what is still to come - with its plan and its actuals beside
 * it. The forecast (the actuals and what is still to come) is the bar itself,
 * and its figures are in the readout a bar shows when it is hovered or
 * touched. The card's headline is what is in so far, with the forecast
 * beside it.
 *
 * Under it, a second card of the same name: every email and post as a row of
 * a table, a column per fact - when, which phase, whose channel, what it is,
 * then its own bar, plan and actuals - and a mark at the head of the row that
 * says where the piece stands (web/src/planPieces.mjs). Until 27 November
 * 2026 the pieces were a box inside the plan card, beside the bars, as high
 * as the bars and scrolling within: five rows of thirteen showed, and a
 * piece's name carried its sender, its size and its day in one phrase. With
 * nothing picked the table lists every email and post in date order; pick a
 * phase by its bar and it lists that phase's alone under the phase's name,
 * its last line what came by search, a typed address or days later (the
 * baseline, shared over the phases: docs/PLAN_MODEL.md 6), or paid by what is
 * spent and still to spend. Pick it again to go back. The table shows its
 * first rows and folds the rest away (planPieces.mjs foldAt). The card says
 * no more than that: it had a longer title, a line counting the pieces and
 * naming their order, and a switch for the phases in its head, and the owner
 * had all three out the day it went live, with the order changed from the
 * piece furthest behind its plan first to the plan's own, by date.
 *
 * The figures are etl/plan_view.py's; on a timed launch gathering signups
 * they are etl/tl_plan.py's, in signups to the sales open, with paid read
 * from the spend still to come. */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Card, Head, vsDelta } from "../ui.jsx";
import { COL, sw } from "../charts.jsx";
import { fmt } from "../format.mjs";
import { ownRecord } from "../planCheck.mjs";
import { byDay, CHANNELS, describe, foldAt } from "../planPieces.mjs";
import { Chev, Euro, Img, Mail, Pair, People, Search } from "../icons.jsx";

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
 * held under it, which could leave a row's pieces one short of the row once the actuals were printed). A piece
 * carries its phase (`stage`), which the table prints beside it. */
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
    return {
      key: r.moment, name: r.moment, note: r.note, exp: exp[i], inn: inn[i], come: cme[i], lands: inn[i] + cme[i],
      pieces: ps.map((x, j) => ({ ...x, stage: r.moment, exp: pe[j], inn: pi[j], come: pc[j], lands: pi[j] + pc[j] })),
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

/* A bar's readout: the forecast and what it is made of, which the row itself does not print (27 November 2026:
 * the figure beside a bar is its actuals). One to a card: `host` is the element it is placed in, `over` what a
 * bar wears, `node` the readout itself. It starts at the bar's left edge in the left half of its card and ends
 * at its right edge in the right half, above its bar and in line with it, kept inside the card's width, and
 * under the bar where the window has no room above it. Not before anything has gone out (`off`), when the
 * forecast is the plan. An empty title keeps the row's own hint off the bar. */
function useReadout(off) {
  const host = useRef(null), box = useRef(null);
  const [tip, setTip] = useState(null);   // the bar under the pointer: its figures, its name and where its readout sits
  useLayoutEffect(() => {
    const el = box.current, h = host.current;
    if (!el || !h || !tip) return;
    const w = el.offsetWidth, ht = el.offsetHeight;
    const left = Math.max(0, Math.min(tip.right ? tip.at - w : tip.at, h.clientWidth - w));
    const above = tip.room >= ht + 16;
    el.style.left = `${left}px`;
    el.style.top = `${above ? tip.top - 8 - ht : tip.bottom + 8}px`;
    el.style.visibility = "visible";
  }, [tip]);
  const show = (e, x, title) => {
    const h = host.current;
    if (!h) return;
    const hb = h.getBoundingClientRect(), bb = e.currentTarget.getBoundingClientRect();
    const right = bb.left + bb.width / 2 > hb.left + hb.width / 2;
    setTip({ x, title, right, at: (right ? bb.right : bb.left) - hb.left, top: bb.top - hb.top, bottom: bb.bottom - hb.top, room: bb.top });
  };
  const hide = () => setTip(null);
  const over = (x, title) => (off ? undefined : {
    title: "", role: "img", "aria-label": `Forecast ${n(x.lands)}: ${n(x.inn)} actuals and ${n(x.come)} still to come, against a plan of ${n(x.exp)}`,
    onMouseEnter: (e) => show(e, x, title), onTouchStart: (e) => show(e, x, title), onMouseLeave: hide,
  });
  const node = tip && (
    <div className="tip plan-tip" ref={box} aria-hidden="true">
      <div className="tt">{tip.title}</div>
      <div className="tr"><span style={sw(COL.DEEP)} />Actuals<b>{n(tip.x.inn)}</b></div>
      <div className="tr"><span style={sw(COL.LIGHT)} />Still to come<b>{n(tip.x.come)}</b></div>
      <div className="tr"><span style={sw(`linear-gradient(90deg, ${COL.DEEP} 50%, ${COL.LIGHT} 50%)`)} />Forecast<b>{n(tip.x.lands)}</b></div>
      <div className="tr"><span style={{ width: 8, height: 11, flex: "0 0 8px", background: `linear-gradient(${COL.INK}, ${COL.INK}) 3px 0 / 2px 100% no-repeat` }} />Plan<b>{n(tip.x.exp)}</b></div>
    </div>
  );
  return { host, over, node, hide };
}

/* Where a piece stands, at the head of its row, drawn as Linear marks an issue: a dashed ring for one still to
 * come, a ring that fills with the share of its plan the piece has brought, a tick once it has brought it all,
 * and a struck disc for one that was dropped. The bar beside it is on the list's scale, where a small piece is a
 * sliver; the mark is on the piece's own. */
function Mark({ d }) {
  const word = d.state === "dropped" ? "Dropped" : d.state === "to come" ? "Still to come"
    : d.share >= 1 ? "Brought its plan" : `Brought ${Math.round(d.share * 100)}% of its plan`;
  return (
    <svg className="pp-mark" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={word}>
      <title>{word}</title>
      {d.state === "dropped" ? <><circle cx="7" cy="7" r="6.5" fill="#b4b4b8" /><path d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></>
        : d.state === "to come" ? <circle cx="7" cy="7" r="5.75" fill="none" stroke="#a1a1aa" strokeWidth="1.5" strokeDasharray="2.1 2.42" />
          : d.share >= 1 ? <><circle cx="7" cy="7" r="6.5" fill={COL.IND} /><path d="M4.1 7.3l1.9 1.9 3.9-4.1" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>
            : <><circle cx="7" cy="7" r="5.75" fill="none" stroke={COL.IND} strokeWidth="1.5" />{d.share > 0 && <circle cx="7" cy="7" r="2" fill="none" stroke={COL.IND} strokeWidth="4" strokeDasharray={`${(d.share * 12.566).toFixed(2)} 12.566`} transform="rotate(-90 7 7)" />}</>}
    </svg>
  );
}

/* a channel's glyph, on a wash of the channel's own colour */
const GLYPH = { email: Mail, aa: Img, artist: People, other: Pair, paid: Euro, tail: Search };
function Channel({ k }) {
  const c = CHANNELS[k] || CHANNELS.tail, G = GLYPH[k] || Search;
  return <span className="cn"><span className="pp-ci" style={{ color: c.color }}><G w={12} /></span>{c.name}</span>;
}

export default function PlanCard({ snap }) {
  const p = snap.plan;
  const [sel, setSel] = useState(null);     // the phase picked, or none: every email and post
  const [all, setAll] = useState(false);    // the folded rows, opened
  const start = !!p && p.state === "start";
  const bars = useReadout(start), table = useReadout(start);
  useEffect(() => { setSel(null); setAll(false); bars.hide(); table.hide(); }, [snap.id]);
  if (!p || !Array.isArray(p.rows)) return null;
  const m = planModel(p);
  const s = m.rows.find((r) => r.key === sel);
  // every email and post: a phase's last line (what no one piece's link brought, `tail`) is no piece, and is
  // listed inside its phase alone
  const every = m.rows.filter((r) => r.key !== "Paid").flatMap((r) => r.pieces).filter((x) => !x.tail);
  const list = s ? s.pieces : byDay(every);
  const ptop = Math.max(1, ...list.map((x) => Math.max(x.exp, x.lands))) * 1.06;
  const shown = all ? list : list.slice(0, foldAt(list.length));
  const short = Math.round(p.target) - Math.round(p.lands);
  const likely = Array.isArray(p.range) ? `likely ${n(p.range[0])} to ${n(p.range[1])}` : undefined;
  /* The card's headline is what is in so far, the Actuals column's own total, with the forecast beside it in a
   * few words, green where it reaches the target and red where it falls short (27 November 2026, at the owner's
   * asking: until then the headline was the forecast, "115 at the close", beside a sentence on the target and
   * the campaign's day, which the trajectory above already gives). Before anything has gone out there is nothing
   * in, so the headline is still the forecast, against the target the way the page's other cards put it. */
  const tl = snap.type === "TL";
  const unit = tl ? (p.of === "conversions" ? "conversions" : "signups") : "units";
  const now = m.rows.reduce((t, r) => t + r.inn, 0);
  const notes = (p.notes || []).join(" ");
  const outlook = `Heading for ${n(p.lands)} ${tl ? "at the open" : "at the close"}, ${short > 0 ? `${n(short)} short of` : "which reaches"} the ${n(p.target)} target`;
  const rec = ownRecord(p);   // the plan check itself is a warning at the top of the page, and only when the plan is too small (web/src/planCheck.mjs)
  const pick = (k) => { setSel(k === sel ? null : k); setAll(false); table.hide(); };
  return (
    <>
      <Card wide title="The plan" className={`plan-card${m.start ? " start" : ""}`} aria="The plan, phase by phase">
        {m.start
          ? <Head v={n(p.lands)} u={tl ? `${unit} at the open` : "at the close"} tip={notes} deltas={[vsDelta(p.lands, p.target, "target", outlook)]} aside={likely} asideTip={notes} />
          : <Head v={n(now)} u={`${unit} now`} tip={notes} deltas={[{ t: `${n(p.lands)} ${tl ? "at the open" : "at close"}`, dir: short > 0 ? "dn" : "up", tip: outlook }]} />}
        {rec && <div className="plan-rec">{rec}</div>}
        <div className="plan-host" ref={bars.host}>
          <div className="plan-rows">
            <div className="plan-r head"><span /><span /><span>Plan</span>{!m.start && <span>Actuals</span>}</div>
            {m.rows.map((r) => (
              <button type="button" key={r.key} className={`plan-r row${sel === r.key ? " sel" : ""}`} disabled={!r.pieces.length} aria-pressed={sel === r.key}
                title={r.pieces.length ? (sel === r.key ? "Back to every piece" : `Show what is inside ${r.name}`) : undefined} onClick={() => pick(r.key)}>
                <span className="nm">{r.name}</span>
                <Bar x={r} top={m.top} over={bars.over(r, r.name)} />
                <span className="pl">{n(r.exp)}</span>
                {!m.start && <span className="ac">{n(r.inn)}</span>}
              </button>
            ))}
          </div>
          {bars.node}
        </div>
        <div className="keys">
          {!m.start && <span className="key"><span style={sw(COL.DEEP)} />Actuals</span>}
          <span className="key"><span style={sw(COL.LIGHT)} />Still to come</span>
          <span className="key"><span style={{ width: 0, height: 12, borderLeft: `2px solid ${COL.INK}` }} />Plan</span>
        </div>
      </Card>
      <Card wide className={`pp-card${m.start ? " start" : ""}`} aria={s ? `The plan: inside ${s.name}` : "The plan, piece by piece"} title={s ? s.name : "The plan"}>
        {s && s.note && <div className="pp-note">{s.note}</div>}
        <div className="pp" ref={table.host} role="table" aria-label={s ? `Inside ${s.name}` : "Every piece of the plan"}>
          <div className="pp-r head" role="row">
            <span className="mk" role="columnheader" aria-label="Standing" /><span className="wh" role="columnheader">When</span><span className="sg" role="columnheader">Stage</span><span className="cw" role="columnheader">Channel</span><span className="ds" role="columnheader">Description</span>
            <span className="bw" role="columnheader" aria-label="Against the plan" /><span className="pl" role="columnheader">Plan</span>{!m.start && <span className="ac" role="columnheader">Actuals</span>}
          </div>
          {shown.map((x, i) => {
            const d = describe(x, snap.asOf);
            return (
              <div className={`pp-r${d.state === "dropped" ? " off" : ""}`} role="row" key={`${i}-${x.date || ""}-${x.name}`}>
                <span role="cell" className="mk"><Mark d={m.start ? { ...d, state: d.state === "dropped" ? "dropped" : "to come" } : d} /></span>
                <span role="cell" className="wh">{x.when}</span>
                <span role="cell" className="sg">{x.stage}</span>
                <span role="cell" className="cw"><Channel k={d.channel} /></span>
                <span role="cell" className="ds" title={x.tip || d.what}>{d.what}{d.state === "dropped" && <i className="tg">Dropped</i>}</span>
                <span role="cell" className="bw"><Bar x={x} top={ptop} over={table.over(x, [x.when, d.what].filter(Boolean).join(" "))} /></span>
                <span role="cell" className="pl">{n(x.exp)}</span>
                {!m.start && <span role="cell" className="ac">{n(x.inn)}</span>}
              </div>
            );
          })}
          {!list.length && <div className="pp-none">No emails or posts in the plan yet</div>}
          {list.length > foldAt(list.length) && (
            <button type="button" className={`pc-fold${all ? " on" : ""}`} aria-expanded={all} onClick={() => { setAll(!all); table.hide(); }}><Chev />{all ? "Fewer" : `${list.length - shown.length} more`}</button>
          )}
          {table.node}
        </div>
      </Card>
    </>
  );
}
