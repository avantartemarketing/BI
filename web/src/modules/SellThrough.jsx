/* Sell-through by product (docs/DATA_MODEL.md 6.3): one row per product,
 * its bar the edition, on it the paid units (deep indigo), the draft orders
 * not yet paid (mid) and the draw winners the entries in hand imply at the
 * entry to order rate (light); at close the units still to come (pale). An
 * entrant who entered more products than they want is counted where it
 * earns the most, as the allocator awards them (shared/sellThrough.mjs);
 * demand a work has no room for is in the row's hover, not drawn. A timed
 * launch (docs/TL_SPEC.md 5) reads paid and awaiting payment on each work's
 * units target, the target a mark. Until the feeds carry sales by product
 * the snapshot says what is missing (sellthrough.incomplete) and the head
 * wears an Incomplete data lozenge; where the works' editions do not add up
 * to the release's, an editions lozenge says so. The menu posts the card to
 * Slack as a message composed on the server from the same snapshot
 * (server/slack.js), at the page's horizon and, on a line's page, for that
 * line. A release selling two lines of work lists the rows under a header
 * per line. Rows that are variants of one work ("Toy Brick (Red)", "Toy
 * Brick (Blue)") show only the variant, the shared name in the header and
 * the full name in the hover. */
import React, { useState } from "react";
import { Card, Head, Loz, Note } from "../ui.jsx";
import { Keys, COL, sw } from "../charts.jsx";
import { fmt, fmtDay } from "../format.mjs";
import { inDraw } from "../../../shared/sellThrough.mjs";
import { wordsOf } from "../vocab.mjs";
import { namesTitle, groupByLine, shownNames } from "../workGroups.mjs";
import { Slack } from "../icons.jsx";
import "../cards.css";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const SEG = { paid: COL.DEEP, drafts: COL.MID, winners: COL.LIGHT, future: COL.PALE };

/* a row's segments in the order they stack */
function segmentsOf(row, close) {
  const segs = [{ key: "sold", v: (row.sold ?? 0) + (row.soldAssumed ?? 0), color: SEG.paid }];
  if (finite(row.drafts) && row.drafts > 0) segs.push({ key: "drafts", v: row.drafts, color: SEG.drafts });
  segs.push({ key: "inhand", v: row.shown ?? 0, color: SEG.winners });
  if (close && (row.futurePredicted ?? 0) > 0) segs.push({ key: "future", v: row.futurePredicted, color: SEG.future });
  return segs.filter((x) => x.v > 0);
}

function Bar({ row, close, maxV, tick }) {
  const pct = (v) => (maxV > 0 ? Math.max(0, Math.min(((v ?? 0) / maxV) * 100, 100)) : 0);
  let at = 0;
  return (
    <div className="strack">
      {finite(row.edition) && row.edition > 0 && <i style={{ left: 0, width: `${pct(row.edition)}%`, background: "#e4e4e8" }} />}
      {segmentsOf(row, close).map((s) => {
        const left = at; at += s.v;
        return <i key={s.key} style={{ left: `${pct(left)}%`, width: `${pct(left + s.v) - pct(left)}%`, background: s.color }} />;
      })}
      {finite(tick) && tick > 0 && <s style={{ left: `${pct(tick)}%` }} />}
    </div>
  );
}

export default function SellThrough({ snap, horizon = "today" }) {
  const [note, setNote] = useState(null);   // the Post to Slack toast
  const [posting, setPosting] = useState(false);
  const st = snap.sellthrough;
  const close = horizon === "close";
  const W = wordsOf(snap);
  const tl = !!(st && st.tl);
  if (!st) return <Card title={W.sellThroughTitle}><div className="empty-state">No sell-through model yet</div></Card>;

  const edition = finite(st.edition) ? st.edition : null;
  const rate = finite(st.conversion) ? st.conversion : 1 - (snap.benchmarks?.chargeDropOff ?? 0.2);
  const sold = st.sold ?? 0;
  const draftsAll = finite(st.drafts) ? st.drafts : null;
  const inHandAll = st.soldPredicted ?? 0;
  const futureAll = close ? st.futureEntriesPredicted ?? 0 : 0;
  const fromFeed = Array.isArray(st.products) && st.products.length > 0;
  const winnerDraftsAll = fromFeed ? st.products.reduce((n, p) => n + (finite(p.winnerDrafts) ? p.winnerDrafts : 0), 0) : 0;
  const winnerDraftsLapsedAll = fromFeed ? st.products.reduce((n, p) => n + (finite(p.winnerDraftsLapsed) ? p.winnerDraftsLapsed : 0), 0) : 0;
  const incomplete = Array.isArray(st.incomplete) ? st.incomplete : (fromFeed ? [] : ["products"]);
  const rows = fromFeed ? st.products : [{
    key: "release", name: snap.title || "Release", draws: [], edition, sold, soldAssumed: 0, shown: inHandAll, futurePredicted: st.futureEntriesPredicted ?? 0,
    room: edition === null ? null : Math.max(edition - sold, 0), oversubscribed: 0, allocated: null, inHand: null, entrants: null, flexible: 0,
    pct: edition ? Math.min((sold + inHandAll) / edition, 1) : null, pctClose: st.pct ?? null,
  }];
  const byEdition = rows.every((r) => finite(r.edition) && r.edition > 0);
  const soldOf = (r) => (r.sold ?? 0) + (r.soldAssumed ?? 0) + (finite(r.drafts) ? r.drafts : 0);
  const unitsOf = (r) => soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0);
  const overOf = (r) => (r.oversubscribed ?? 0) + (close ? r.futureOversubscribed ?? 0 : 0);
  const unitsMax = Math.max(...rows.map((r) => Math.max(r.edition ?? 0, unitsOf(r))), 1);
  const maxFor = (r) => (byEdition ? Math.max(r.edition, unitsOf(r)) : unitsMax);
  const headPct = edition ? (close ? st.pct ?? 0 : tl ? (sold + (draftsAll ?? 0) + inHandAll) / edition : Math.min((sold + (draftsAll ?? 0) + inHandAll) / edition, 1)) : null;
  const headUnits = sold + (draftsAll ?? 0) + inHandAll + futureAll;
  const rateText = `${Math.round(rate * 100)}%`;
  const preRate = finite(st.preorderConversion) ? st.preorderConversion : null;
  const preRateText = preRate === null ? null : `${Math.round(preRate * 100)}%`;
  const twoRates = preRateText !== null && preRateText !== rateText;
  const method = tl
    ? "Paid is the orders table's paid lines in the window, by pieces. Awaiting payment is the orders raised in the window and not yet paid, pending and draft, which count as units sold until they lapse. Each row is a work against its units target, the bar running past the target where the work has sold more." + (close ? " Still to come is the projection's further units, spread over the works in proportion to their sales." : "")
    : `Paid is units paid for. Drafts are orders raised but not yet paid, including the orders advisors have out for winners; they take room like a sale. Draw winners (estimate) are the people still in the draw, counted at ${rateText}${twoRates ? `, or at ${preRateText} where they entered as a pre-order and their card is already authorised` : ""}. Winners who have not paid are not counted: the order sent after a failed payment is in Drafts for 72 hours, and after that it is out. A draw round's winners whose claim the order feed has not caught up with yet still count, at the pre-order rate, until their orders land${finite(st.claimsInFlight) && st.claimsInFlight > 0 ? ` (${fmt(st.claimsInFlight)} landing now)` : ""}. Someone who entered more products than they want is counted on the number they want, on the priciest of them with room first, which is how the allocator awards them.` + (close ? " Still to come is the projection's further entrants, taken to look like those so far and placed where there is room." : "");
  const salesWindow = snap.unitsSource === "orders" ? snap.salesWindow || null : null;
  const outside = salesWindow ? st.unitsOutsideWindow || null : null;
  const dayText = (iso) => fmtDay(new Date(iso + "T00:00:00Z"));
  const alloc = st.allocation || null;
  const moved = fromFeed ? st.products.filter((p) => (p.flexible ?? 0) > 0) : [];
  const paidTip = [
    ...(fromFeed && (st.unattributedSold ?? 0) > 0 ? [`${fmt(st.attributedSold ?? 0)} named by product, ${fmt(st.unattributedSold)} estimated: the draw feed only names the product of a sale that came through a draw win; the rest is split across the products by edition size`] : []),
    ...(salesWindow ? [`Counted ${dayText(salesWindow.start)} to ${dayText(salesWindow.end)} from the orders table`] : []),
    ...(outside && outside.before > 0 ? [`Paid earlier, not counted: ${fmt(outside.before)}`] : []),
    ...(outside && outside.after > 0 ? [`Paid after the window shut, not counted: ${fmt(outside.after)}`] : []),
    ...(outside && outside.pending > 0 ? [`Paid since ${dayText(salesWindow.end)}, counts on the next refresh: ${fmt(outside.pending)}`] : []),
  ].join("\n") || "Units paid for";
  const draftsTip = [
    tl ? "Orders raised in the window and not yet paid, pending and draft, by pieces: they count as units sold until they lapse" : "Draft orders raised but not yet paid. They take room like a sale. The order an advisor sends a winner after a failed payment counts for 72 hours; unpaid after that, it is out",
    ...(winnerDraftsAll > 0 ? [`Of which winners' claims under 72 hours old: ${fmt(winnerDraftsAll)}`] : []),
    ...(winnerDraftsLapsedAll > 0 ? [`Winners' claims unpaid after 72 hours, not counted: ${fmt(winnerDraftsLapsedAll)}`] : []),
  ].join("\n");
  const inHandTip = [
    ...(fromFeed && Array.isArray(st.patterns) ? [`People still in the draw: ${fmt(inDraw({ products: st.products, patterns: st.patterns }).people)}`] : []),
    ...(alloc && alloc.unpaidWinners > 0 ? [`Won, not yet paid, not counted: ${fmt(alloc.unpaidWinners)}`] : []),
    ...(alloc && alloc.flexibleEntrants > 0 ? [`Entered more products than they want: ${fmt(alloc.flexibleEntrants)}`, ...moved.map((p) => `Counted on ${p.name}: +${fmt(p.flexible)}`)] : []),
    `${twoRates ? `Draw winners at ${rateText}, pre-orders at ${preRateText}` : `Draw winners at ${rateText}`}: ${fmt(inHandAll)}`,
  ].join("\n");

  // a release selling two lines of work (docs/LINES_PLAN.md): a header per line
  const groups = fromFeed ? groupByLine(snap, rows) : null;

  // ----- Post to Slack: the server composes the message from the same snapshot -----
  const channel = (snap.slack && snap.slack.channel) || null;
  const directSpread = ((v) => !!v && Object.keys(v).length > 0 && Object.keys(v).every((k) => snap[k] === v[k]))(snap.variants && snap.variants.direct_spread);
  const postToSlack = async () => {
    setPosting(true);
    try {
      const body = { horizon: close ? "close" : "today", directSpread };
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
  const menu = !tl && snap.id ? [{
    label: posting ? "Posting…" : "Post to Slack", icon: <Slack />, right: channel ? `#${channel}` : "no channel", disabled: !channel || posting, onClick: postToSlack,
  }] : undefined;

  const mismatch = fromFeed && !!st.editionMismatch && finite(st.editionSum) && edition !== null;
  const right = (
    <>
      {incomplete.length > 0 && (
        <Loz kind="warm" tip={`Not in the feed yet: ${incomplete.join(", ")}. ${incomplete.includes("orders table")
          ? "The orders table has no lines for this launch yet, so its units are the feed's purchase events and the launch is one row."
          : incomplete.includes("products") ? "The event feed has no draws for this release yet, so the release is one row. The rows by product appear after the next data refresh."
          : "Sales the draw cannot name a product for are split by edition size inside the paid segment until the sales feed carries the product."}`}>Incomplete data</Loz>
      )}
      {mismatch && (
        <Loz kind="warm" tip={`The works' editions add up to ${fmt(st.editionSum)}, the release's edition is ${fmt(edition)}. The head and the room left read the release's; each row reads its own work's. One of the two is wrong: check them on the Targets tab.`}>editions add to {fmt(st.editionSum)}</Loz>
      )}
    </>
  );
  const row = (r, short) => {
    const over = overOf(r);
    const tip = [
      `${r.name}${finite(r.edition) ? ` · ${fmt(unitsOf(r))} of ${fmt(r.edition)}` : ` · ${fmt(unitsOf(r))}`}`,
      `Paid ${fmt((r.sold ?? 0) + (r.soldAssumed ?? 0))}`,
      `${tl ? "Awaiting payment" : "Drafts"} ${fmt(r.drafts ?? 0)}`,
      ...(tl ? (finite(r.orders) ? [`Orders ${fmt(r.orders)}`] : []) : [`Draw winners (estimate) ${fmt(r.shown ?? 0)}`]),
      ...(close && (r.futurePredicted ?? 0) > 0 ? [`Still to come ${fmt(r.futurePredicted)}`] : []),
      ...(over > 0 ? [`Beyond the edition, no room: +${fmt(over)}`] : []),
      ...(finite(r.entrants) ? [`Eligible entrants ${fmt(r.entrants)}`] : []),
    ].join("\n");
    const pctRow = close ? r.pctClose : r.pct;
    return (
      <div className="prow st" key={r.key} title={tip}>
        <span className="nm">{short || r.name}</span>
        <Bar row={r} close={close} maxV={maxFor(r)} tick={tl ? r.edition : null} />
        <span className="fig"><b>{finite(pctRow) ? `${Math.round(pctRow * 100)}%` : fmt(unitsOf(r))}</b></span>
      </div>
    );
  };
  const groupHead = (g, base) => {
    const ed = g.rows.every((r) => finite(r.edition) && r.edition > 0) ? g.rows.reduce((s, r) => s + r.edition, 0) : null;
    const u = g.rows.reduce((s, r) => s + unitsOf(r), 0);
    const sameName = base && namesTitle(base, g.name);
    const figs = ed ? `${fmt(u)} of ${fmt(ed)}, ${Math.round(Math.min(u / ed, 1) * 100)}%` : fmt(u);
    return (
      <div className="prow st grp" key={`line:${g.key}`} title={`${g.name}${base && !sameName ? ` (${base})` : ""}: ${figs}`}>
        <span className="nm">{g.name}</span>
      </div>
    );
  };
  let longest = 0;   // the longest name a row shows, to size the name column
  // a group's rows, each by its variant when the group's rows are variants of one work
  const groupRows = (g) => {
    const sn = shownNames(g.rows);
    longest = Math.max(longest, sn.longest);
    return { v: sn.base ? { base: sn.base } : null, rows: g.rows.map((r, i) => row(r, sn.names[i])) };
  };
  const body = (() => {
    if (groups) return groups.map((g) => {
      const { v, rows: rs } = groupRows(g);
      return <div className="stgrp" key={`g:${g.key}`}>{groupHead(g, v && v.base)}{rs}</div>;
    });
    const { v, rows: rs } = groupRows({ rows });
    // one list of variants: their shared name heads it
    return v ? <div className="stgrp">{groupHead({ key: "_all", name: v.base, rows }, v.base)}{rs}</div> : rs;
  })();
  return (
    <Card title={W.sellThroughTitle} menu={menu} right={right} aria={W.sellThroughTitle}>
      <Head v={fmt(headUnits)} u={edition ? `of ${fmt(edition)}${st.editionWord ? ` ${st.editionWord}` : ""}` : "units, no edition size set"}
        aside={headPct !== null ? `${Math.round(headPct * 100)}%` : null}
        asideTip={method} />
      <div style={{ "--nmw": `${Math.min(Math.max(longest, 8), 30)}ch` }}>{body}</div>
      <Keys style={{ marginTop: 20 }} legend={[
        { n: "Paid", k: sw(SEG.paid), tip: `${fmt(sold)} paid\n${paidTip}` },
        ...(draftsAll !== null && draftsAll > 0 ? [{ n: tl ? "Awaiting payment" : "Drafts", k: sw(SEG.drafts), tip: `${fmt(draftsAll)} ${tl ? "awaiting payment" : "drafts"}\n${draftsTip}` }] : []),
        ...(!tl ? [{ n: "Likely winners", k: sw(SEG.winners), tip: `${fmt(inHandAll)} draw winners (estimate)\n${inHandTip}` }] : []),
        ...(close && futureAll > 0 ? [{ n: "Still to come", k: sw(SEG.future), tip: `${fmt(futureAll)}: the projection's further units, spread over the products with room left` }] : []),
        ...(tl ? [{ n: "Target", k: { width: 2, height: 11, flex: "0 0 2px", background: COL.INK } }] : []),
      ]} />
      <Note text={note ? note.text : ""} bad={note ? note.bad : false} onClose={() => setNote(null)} />
    </Card>
  );
}
