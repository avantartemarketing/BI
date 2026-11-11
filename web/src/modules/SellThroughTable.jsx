/* Sell-through as one table across the page (11 November 2026), under the
 * trajectory and above the sell-through bar cards it sums up: a row per
 * work, the release as the last row. Today's side reads sellthrough.products
 * (docs/DATA_MODEL.md 6.3): paid, the drafts not yet paid, the draw winners
 * the entries in hand imply, their sum as the units sold, the plan's units
 * by today (expectedToday) and the gap to it, the work's target at close
 * (economics.products: the edition at its target sell-through), the edition
 * and the sell-through. Framing is frames per print on the prints a frame
 * was on offer for (framing.works). The forecast columns read closeForecast
 * under the paid assumption the dropdown picks (closeForecast.scenarios:
 * recommended, today's spend held, none; the recommended figures when a
 * snapshot has no scenarios), each work's units and share at close with the
 * likely range on hover; on a closed release the units at the close, no
 * dropdown. Rows that are variants of one work show the variant with the
 * shared name under it; on a release selling lines of work the line sits
 * under the work. The Incomplete data and editions lozenges, and the Post
 * to Slack menu, are the Sell-through by product card's too. */
import React, { useState } from "react";
import { Card, Loz, Menu, MenuItem, Note, useMenu } from "../ui.jsx";
import { fmt, fmtPct, fmtMoney } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";
import { namesTitle, shownNames } from "../workGroups.mjs";
import { Caret, Slack } from "../icons.jsx";
import "../cards.css";

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
const MODES = [["recommended", "Recommended"], ["current", "Today's"], ["none", "None"]];
const money = (v) => fmtMoney(Math.round(v ?? 0));
const CONF = { high: ["High", "good"], medium: ["Medium", "amber"], low: ["Low", "warm"] };
const LINE_COLORS = ["var(--ind)", "#d2855e", "#0f7052", "#8a5f00", "#6d3fa8"];
const rag = (p) => (p >= 0 ? "rag-up" : p >= -0.2 ? "rag-near" : "rag-dn");
const signed = (p) => `${p >= 0 ? "+" : "−"}${Math.abs(Math.round(p * 100))}%`;

/* the paid assumption the forecast runs on, as a dropdown with each one's daily spend */
function PaidPick({ scenarios, mode, onChange }) {
  const m = useMenu();
  const daily = (k) => (scenarios[k] && scenarios[k].paid && scenarios[k].paid.daily) || 0;
  const tip = {
    recommended: `${money(daily("recommended"))} a day: the level at which the next euro of paid spend returns what it costs, reached from today's by steps of up to 30% a day`,
    current: `${money(daily("current"))} a day: today's daily spend held to the close`,
    none: "No more paid spend from now: the organic course alone",
  };
  const cur = MODES.find(([k]) => k === mode) || MODES[0];
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button className="chip" aria-haspopup="menu" aria-expanded={m.open} aria-label={`Forecast on ${cur[1]} paid`} title={tip[cur[0]]} onClick={m.toggle}>Forecast on {cur[1].toLowerCase()} paid<Caret /></button>
      <Menu open={m.open} onClose={m.close} label="Paid assumption" style={{ top: 30, right: 0, width: 260 }}>
        {MODES.map(([k, l]) => (
          <MenuItem key={k} radio checked={mode === k} title={tip[k]} right={`${money(daily(k))}/day`} onClick={() => { m.close(); onChange(k); }}>{l}</MenuItem>
        ))}
      </Menu>
    </span>
  );
}

/* the table's rows off the snapshot, and the release's row from them */
export function tableRows(snap, mode = "recommended") {
  const st = snap.sellthrough || {};
  const base = snap.closeForecast || {};
  const scenarios = base.scenarios && base.scenarios.recommended && base.scenarios.current && base.scenarios.none ? base.scenarios : null;
  const cf = scenarios && scenarios[mode] ? { ...base, ...scenarios[mode] } : base;
  const works = cf.works || [];
  const framing = ((snap.framing || {}).works || []);
  const econ = ((snap.economics || {}).products || []);
  const lines = !snap.line && Array.isArray(snap.lines) && snap.lines.length > 1 ? snap.lines : null;
  const rows = (st.products || []).map((p) => {
    const w = works.find((x) => namesTitle(x.name, p.name)) || {};
    const f = framing.find((x) => namesTitle(p.name, x.name)) || null;
    const e = econ.find((x) => namesTitle(x.name, p.name)) || null;
    const li = lines ? lines.findIndex((l) => (l.products || []).some((n) => namesTitle(n, p.name))) : -1;
    return {
      key: p.key || p.name, name: p.name, line: li >= 0 ? lines[li].name : null, color: li >= 0 ? LINE_COLORS[li % LINE_COLORS.length] : "var(--ind)",
      paid: (p.sold ?? 0) + (p.soldAssumed ?? 0), drafts: p.drafts ?? 0, winners: p.shown ?? 0,
      edition: has(p.edition) && p.edition > 0 ? p.edition : null, targetToDate: has(p.expectedToday) ? p.expectedToday : null,
      targetClose: e && has(e.target_units) && e.target_units > 0 ? e.target_units : null,
      framing: f && has(f.rate) ? f.rate : null, framingPrints: f ? f.prints : 0,
      forecast: has(w.units) ? w.units : null, lo: has(w.lo) ? w.lo : null, hi: has(w.hi) ? w.hi : null, sellsOut: !!w.sellsOut,
      entrants: p.entrants,
    };
  });
  const sn = shownNames(rows);
  rows.forEach((r, i) => { r.shown = sn.names[i]; if (!r.line && sn.base) r.line = sn.base; });
  const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const some = (f) => rows.some((r) => has(f(r)));
  const framed = rows.filter((r) => r.framing !== null && r.framingPrints > 0);
  const all = {
    key: "_all", name: "All works", shown: "All works", line: null, color: "var(--muted)",
    paid: has(st.sold) ? st.sold : sum((r) => r.paid), drafts: has(st.drafts) ? st.drafts : sum((r) => r.drafts), winners: sum((r) => r.winners),
    edition: has(st.edition) && st.edition > 0 ? st.edition : (some((r) => r.edition) ? sum((r) => r.edition) : null),
    targetToDate: some((r) => r.targetToDate) ? sum((r) => r.targetToDate) : null,
    targetClose: has(base.target) && base.target > 0 ? base.target : (some((r) => r.targetClose) ? sum((r) => r.targetClose) : null),
    framing: framed.length ? framed.reduce((s, r) => s + r.framing * r.framingPrints, 0) / framed.reduce((s, r) => s + r.framingPrints, 0) : null,
    forecast: has(cf.units) ? cf.units : (some((r) => r.forecast) ? sum((r) => r.forecast) : null), lo: has(cf.lo) ? cf.lo : null, hi: has(cf.hi) ? cf.hi : null,
    sellsOut: false,
  };
  return { rows, all, cf, scenarios };
}

export default function SellThroughTable({ snap }) {
  const [mode, setMode] = useState("recommended");
  const [note, setNote] = useState(null);
  const [posting, setPosting] = useState(false);
  const W = wordsOf(snap);
  const st = snap.sellthrough;
  const title = "Sell-through";
  if (!st) return <Card title={title} wide><div className="empty-state">No sell-through model yet</div></Card>;
  const { rows, all, cf, scenarios } = tableRows(snap, mode);
  const complete = !!snap.complete;
  const [confWord, confKind] = CONF[cf.confidence] || [null, null];
  const paid = cf.paid || null;
  const rateText = has(st.conversion) ? fmtPct(st.conversion, 0) : "the entry rate";

  // ----- Post to Slack, as the card this replaces: the server composes the message from the same snapshot -----
  const channel = (snap.slack && snap.slack.channel) || null;
  const directSpread = ((v) => !!v && Object.keys(v).length > 0 && Object.keys(v).every((k) => snap[k] === v[k]))(snap.variants && snap.variants.direct_spread);
  const postToSlack = async () => {
    setPosting(true);
    try {
      const body = { horizon: complete ? "close" : "today", directSpread };
      if (snap.line && snap.line.key) body.line = snap.line.key;
      const r = await fetch(`/api/releases/${snap.id}/slack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Slack post failed (${r.status})`);
      setNote({ text: `Posted to #${d.channel}${d.warning ? `, but ${d.warning}` : ""}`, bad: !!d.warning });
    } catch (e) {
      setNote({ text: `Not posted to Slack: ${String(e.message || e)}`, bad: true });
    }
    setPosting(false);
  };
  const menu = snap.id ? [{
    label: posting ? "Posting…" : "Post to Slack", icon: <Slack />, right: channel ? `#${channel}` : "no channel", disabled: !channel || posting, onClick: postToSlack,
  }] : undefined;

  const incomplete = Array.isArray(st.incomplete) ? st.incomplete : [];
  const mismatch = !!st.editionMismatch && has(st.editionSum) && has(st.edition);
  const right = (
    <>
      {incomplete.length > 0 && (
        <Loz kind="warm" tip={`Not in the feed yet: ${incomplete.join(", ")}. ${incomplete.includes("orders table")
          ? "The orders table has no lines for this launch yet, so its units are the feed's purchase events and the launch is one row."
          : incomplete.includes("products") ? "The event feed has no draws for this release yet, so the release is one row. The rows by work appear after the next data refresh."
          : "Sales the draw cannot name a product for are split by edition size inside the paid figure until the sales feed carries the product."}`}>Incomplete data</Loz>
      )}
      {mismatch && (
        <Loz kind="warm" tip={`The works' editions add up to ${fmt(st.editionSum)}, the release's edition is ${fmt(st.edition)}. The All works row reads the release's; each work its own. One of the two is wrong: check them on the Targets tab.`}>editions add to {fmt(st.editionSum)}</Loz>
      )}
      {confWord && !complete && (
        <Loz kind={confKind} icon={<span className="dot" />} tip={[cf.confidenceWhy || null, has(cf.lo) && has(cf.hi) && cf.hi > cf.lo ? `Likely ${fmt(cf.lo)} to ${fmt(cf.hi)} at the close${cf.range && cf.range.note ? `: ${cf.range.note}` : ""}` : null].filter(Boolean).join("\n") || undefined}>{confWord} confidence</Loz>
      )}
      {paid && has(paid.daily) && !complete && (
        <Loz tip={[has(paid.spendAtClose) ? `${money(paid.spendAtClose)} spent by close${has(paid.budget) ? `, against a budget of ${money(paid.budget)}` : ""}` : null, paid.rule || null].filter(Boolean).join("\n") || undefined}>{paid.daily > 0 ? `${money(paid.daily)} a day` : "No paid spend"}</Loz>
      )}
      {scenarios && !complete && <PaidPick scenarios={scenarios} mode={mode} onChange={setMode} />}
    </>
  );

  const cells = (r) => {
    const sold = r.paid + r.drafts + r.winners;
    const vs = has(r.targetToDate) && r.targetToDate > 0 ? sold / r.targetToDate - 1 : null;
    const sells = r.sellsOut || (has(r.forecast) && has(r.edition) && r.forecast >= r.edition - 0.5);
    const ranged = has(r.lo) && has(r.hi) && r.hi > r.lo;
    return (
      <>
        <td>{fmt(r.paid)}</td>
        <td className={r.drafts > 0 ? "" : "dim"}>{fmt(r.drafts)}</td>
        <td className={r.winners > 0 ? "" : "dim"}>{fmt(r.winners)}</td>
        <td className="b">{fmt(sold)}</td>
        <td className={has(r.targetToDate) ? "" : "dim"}>{has(r.targetToDate) ? fmt(r.targetToDate) : "–"}</td>
        <td className={vs === null ? "dim" : rag(vs)}>{vs === null ? "–" : signed(vs)}</td>
        <td className={has(r.targetClose) ? "" : "dim"} title={has(r.targetClose) && r.edition ? `${fmtPct(r.targetClose / r.edition, 0)} of the edition` : undefined}>{has(r.targetClose) ? fmt(r.targetClose) : "–"}</td>
        <td className={r.edition ? "" : "dim"}>{r.edition ? fmt(r.edition) : "–"}</td>
        <td className="b">{r.edition ? fmtPct(Math.min(sold / r.edition, 1), 0) : "–"}</td>
        <td className={r.framing === null ? "dim" : ""} title={r.framing === null ? "No frame on offer" : `${fmt(r.framing * r.framingPrints)} frames on ${fmt(r.framingPrints)} prints`}>{r.framing === null ? "–" : fmtPct(r.framing, 0)}</td>
        <td className={has(r.forecast) ? "" : "dim"} title={ranged ? `Likely ${fmt(r.lo)} to ${fmt(r.hi)}` : undefined}>{has(r.forecast) ? fmt(r.forecast) : "–"}</td>
        <td className={sells ? "good b" : has(r.forecast) ? "b" : "dim"} title={ranged && r.edition ? `Likely ${fmtPct(r.lo / r.edition, 0)} to ${fmtPct(r.hi / r.edition, 0)}` : undefined}>
          {sells ? (complete ? "Sold out" : "Sells out") : has(r.forecast) && r.edition ? fmtPct(Math.min(r.forecast / r.edition, 1), 0) : "–"}
        </td>
      </>
    );
  };
  const rowTip = (r) => [
    r.name,
    `Paid ${fmt(r.paid)}`, `Drafts ${fmt(r.drafts)}: orders raised but not yet paid`,
    `Draw winners (estimate) ${fmt(r.winners)}: the entries in hand at ${rateText}`,
    ...(has(r.entrants) ? [`Eligible entrants ${fmt(r.entrants)}`] : []),
  ].join("\n");
  const sortWord = complete ? "At close" : "Forecast";
  return (
    <Card title={title} wide className="stt-card" menu={menu} right={right} aria="Sell-through by work">
      <div className="stt-wrap">
        <table className="stt">
          <colgroup>{[17, 6, 6, 7, 6.5, 7, 7, 7, 6.5, 7.5, 6.5, 7.5, 8.5].map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
          <thead><tr>
            <th>Work</th><th>Paid</th><th>Drafts</th><th>Likely winners</th><th>Total sold</th><th>Target to date</th><th>vs target</th><th>Target at close</th><th>Edition size</th><th>Sell-through</th><th>Framing</th><th>{complete ? "Units at close" : "Forecast units"}</th>
            <th><span className="sorted">{sortWord} <span aria-hidden="true">↓</span></span></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} title={rowTip(r)}>
                <td><span className="nmw"><span className="ldot" style={{ background: r.color }} /><span className="nm2"><span className="n">{r.shown || r.name}</span>{r.line && <span className="code">{r.line}</span>}</span></span></td>
                {cells(r)}
              </tr>
            ))}
            {rows.length > 0 && (
              <tr className="all">
                <td><span className="nmw"><span className="ldot" style={{ background: all.color }} /><span className="nm2"><span className="n">{all.name}</span></span></span></td>
                {cells(all)}
              </tr>
            )}
            {rows.length === 0 && <tr><td colSpan={13} className="dim">No works by draw yet: the rows appear once the event feed carries this release's draws</td></tr>}
          </tbody>
        </table>
      </div>
      {note && <Note text={note.text} bad={note.bad} onClose={() => setNote(null)} />}
    </Card>
  );
}
