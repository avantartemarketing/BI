/* Sell-through by product (docs/DATA_MODEL.md §6.3). Wide card (2 cols × 1 row).
 *
 * The question is "how much of each edition is spoken for", so the card is
 * one row per product. Each row is that product's edition, and on it one
 * ramp of the page's blue, deepest to palest as the units get less certain:
 * paid (deep), draft orders not yet paid (the actual's own blue), the draw
 * winners the entries in hand imply at the entry → order rate (light), and
 * at close the units still to come (palest). No hatching anywhere - the
 * ramp is the whole key, and where a bar runs past its edition the paler
 * room behind it stops, which is what says the demand has nowhere to go.
 *
 * One row of the grid whatever the count. The rows have ROWS_H of the card;
 * the pitch is that shared by the count, capped at PITCH_MAX, and the bar is
 * half the pitch: seven products are 14px bars on 28, four are 24 on 49,
 * three or fewer 30 on 60, the cap being what keeps one edition from
 * filling the card. The rows start under the headline and never spread;
 * past seven they scroll. The key sits on the headline's own line, which is
 * what gives the rows their height. Each row carries its units of the
 * edition (198 of 1,000) in muted text and its percentage in ink, each in a
 * column of its own so the two never read as one figure, and no RAG colour,
 * which said "bad" about a product that was simply mid-campaign. The Units
 * toggle puts the bars on one scale for the card.
 *
 * Until the feeds carry sales by product and draft orders, the snapshot says
 * what is missing (`sellthrough.incomplete`) and the card wears an
 * "Incomplete data" stamp over the rows; sales the draw cannot name a product
 * for are then split by edition size and sit inside the sold segment, named
 * as an estimate in its popup. The stamp leaves by itself when the list is
 * empty.
 *
 * The entries in hand are not simply everyone who entered the product. An
 * entrant who entered four products but wants two is one conversion on two
 * of them, and is counted where it earns the most: the priciest of their
 * products with room, then whichever has the most room - the same rule the
 * allocator applies at close (shared/sellThrough.mjs).
 * The card carries no copy about it: the account of who moved where is in
 * the popup of the draw-winners key, the split of sales the feed cannot name
 * a product for in the paid key's, and the editions are checked where they
 * are typed, on the Target setting tab.
 *
 * "Post to Slack" sends the card as a Block Kit message composed on the
 * server from the same snapshot by the same rules (server/slack.js), at the
 * horizon this page is on: Slack's data table, one row per work with its
 * units, target, edition and sell-through, and a bold Total row.
 *
 * No target and no benchmark on this card, by decision: both are on the hero
 * and the channels, and here they only crowded the reading. Each row is the
 * product against its own edition and nothing else.
 *
 * Nothing in the head but the title and the horizon: no toggle and no rate,
 * by decision. Every bar is its product against its own edition; the rate
 * the estimate runs at is in the headline's popup and in the Slack message.
 * Without product editions the card runs on units and says what is
 * missing. Without the draw feed at all it is one row, the release, as
 * before. */
import React, { useState } from "react";
import { Card, HorizonBadge, GROUP_DOTS, C, fmt, fmtDay, useTip } from "../ui.jsx";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
/* One ramp of the page's blue, deepest to palest as the units get less
 * certain: money in the bank, then an order raised, then the winners the
 * entries imply, then the campaign's remaining days. Nothing is hatched -
 * four solid tints of one hue carry the whole reading, and the key is the
 * same four swatches. */
const SEG = { paid: C.blueDeep, drafts: C.blue, winners: C.blueLight, future: C.refBase };

/* The rows' geometry: the height they share, and the most one row may take.
 * ROWS_H is seven rows at 28px - what a wide card has left under its head,
 * the headline line and the gaps around them, less 5px to spare. */
const ROWS_H = 196;
const PITCH_MAX = 60;

/* A row's segments, in the order they stack. The card's bars and the picture
 * posted to Slack both draw from this, so the two cannot drift apart. */
function segmentsOf(row, close) {
  const segs = [{ key: "sold", v: (row.sold ?? 0) + (row.soldAssumed ?? 0), color: SEG.paid }];
  if (finite(row.drafts) && row.drafts > 0) segs.push({ key: "drafts", v: row.drafts, color: SEG.drafts });
  segs.push({ key: "inhand", v: row.shown ?? 0, color: SEG.winners });
  if (close && (row.futurePredicted ?? 0) > 0) segs.push({ key: "future", v: row.futurePredicted, color: SEG.future });
  return segs.filter((x) => x.v > 0);
}
const swatch = (bg) => ({ width: 9, height: 9, borderRadius: 2, background: bg, flex: "0 0 9px" });
const legendItem = { display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" };

/* One product's bar. Layers, bottom to top: track → the paler room out to the
 * sellout → the segments inset → the winners' tint carrying on past the
 * sellout for demand with no room. `maxV` is the bar's scale in units; in
 * the % view it is the product's own edition (plus any overshoot), in the
 * Units view the same for every row. */
function ProductBar({ row, close, maxV, tips, height = 14, radius = 4 }) {
  const t = useTip();
  const tp = (x) => t.props(x);
  const pct = (v) => (maxV > 0 ? Math.max(0, Math.min(((v ?? 0) / maxV) * 100, 100)) : 0);
  const edition = row.edition;
  const inset = Math.max(2, Math.round(height * 0.14));
  const innerR = Math.max(2, radius - 2);
  const over = row.oversubscribed ?? 0;
  const segs = segmentsOf(row, close).map((x) => ({ ...x, tip: tips[x.key === "sold" ? "sold" : x.key === "drafts" ? "drafts" : x.key === "future" ? "future" : "inHand"] }));
  let at = 0;
  return (
    <div style={{ position: "relative", height, background: C.track, borderRadius: radius }}>
      {finite(edition) && edition > 0 && (
        <div style={{ position: "absolute", inset: 0, width: `${pct(edition)}%`, background: C.refTrack, borderRadius: radius }} />
      )}
      {segs.map((s) => {
        const left = at; at += s.v;
        if (!(s.v > 0)) return null;
        return (
          <div key={s.key} {...tp(s.tip)} style={{
            position: "absolute", top: inset, bottom: inset, left: `${pct(left)}%`,
            width: `${pct(left + s.v) - pct(left)}%`, background: s.color,
            borderRadius: left === 0 ? `${innerR}px 0 0 ${innerR}px` : 0,
          }} />
        );
      })}
      {/* demand with no room left: the winners' own tint, carrying on past
          the point where the paler room stops - the change of ground under
          the bar is what says it has nowhere to go */}
      {over > 0 && finite(edition) && (
        <div {...tp(tips.over)} style={{
          position: "absolute", top: inset, bottom: inset, left: `${pct(edition)}%`,
          width: `${pct(edition + over) - pct(edition)}%`, background: SEG.winners,
          borderTopRightRadius: innerR, borderBottomRightRadius: innerR,
        }} />
      )}
    </div>
  );
}

export default function SellThrough({ snap, horizon = "today" }) {
  const t = useTip();
  const [post, setPost] = useState({ state: "idle" });   // the Post to Slack button: idle | posting | done | error
  const st = snap?.sellthrough;
  const close = horizon === "close";

  if (!st) {
    return (
      <Card dot={GROUP_DOTS.outcome} title="Sell-through by product" badge={<HorizonBadge horizon={horizon} />}>
        <div className="empty-state">No sell-through model yet</div>
      </Card>
    );
  }

  const edition = finite(st.edition) ? st.edition : null;
  // the rate the prediction ran at; an older snapshot carries only the panel's drop-off
  const rate = finite(st.conversion) ? st.conversion : 1 - (snap?.benchmarks?.chargeDropOff ?? 0.2);
  const sold = st.sold ?? 0;
  const draftsAll = finite(st.drafts) ? st.drafts : null;
  const inHandAll = st.soldPredicted ?? 0;
  const futureAll = close ? st.futureEntriesPredicted ?? 0 : 0;
  const fromFeed = Array.isArray(st.products) && st.products.length > 0;
  const winnerDraftsAll = fromFeed ? st.products.reduce((n, p) => n + (finite(p.winnerDrafts) ? p.winnerDrafts : 0), 0) : 0;
  const winnerDraftsLapsedAll = fromFeed ? st.products.reduce((n, p) => n + (finite(p.winnerDraftsLapsed) ? p.winnerDraftsLapsed : 0), 0) : 0;
  // what the feeds do not carry yet; an older snapshot without the field is
  // read the same way the ETL writes it
  const incomplete = Array.isArray(st.incomplete) ? st.incomplete : (fromFeed ? [] : ["products"]);

  /* The rows. From the draw feed when it is there; otherwise the release as
     one row, so the card reads the same way on a release the feed has no
     draws for and says what is missing. */
  const rows = fromFeed ? st.products : [{
    key: "release", name: snap?.title || "Release", draws: [], edition,
    sold, soldAssumed: 0, shown: inHandAll, futurePredicted: st.futureEntriesPredicted ?? 0,
    room: edition === null ? null : Math.max(edition - sold, 0), oversubscribed: 0,
    allocated: null, inHand: null, entrants: null, flexible: 0,
    pct: edition ? Math.min((sold + inHandAll) / edition, 1) : null,
    pctClose: st.pct ?? null,
  }];
  const allEditions = rows.every((r) => finite(r.edition) && r.edition > 0);
  const byEdition = allEditions;
  // one scale when an edition is missing: the biggest edition, or the biggest demand
  const soldOf = (r) => (r.sold ?? 0) + (r.soldAssumed ?? 0) + (finite(r.drafts) ? r.drafts : 0);
  const demandOf = (r) => soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0) + (r.oversubscribed ?? 0);
  const unitsOf = (r) => soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0);
  // no headroom past the edition: the bar's end is the edition's, so the pale
  // room runs to the track's corner and no grey shows past it
  const unitsMax = Math.max(...rows.map((r) => Math.max(r.edition ?? 0, demandOf(r))), 1);
  const maxFor = (r) => (byEdition ? Math.max(r.edition, demandOf(r)) : unitsMax);

  // the headline: what is spoken for today, or the prediction at close
  const headPct = edition ? (close ? st.pct ?? 0 : Math.min((sold + (draftsAll ?? 0) + inHandAll) / edition, 1)) : null;
  const headUnits = sold + (draftsAll ?? 0) + inHandAll + futureAll;
  const headText = headPct !== null ? `${Math.round(headPct * 100)}%` : fmt(headUnits);
  /* The two figures a row carries, each in a column of its own: its units, of
     the edition where there is one, and its percentage where there is one. */
  const figureOf = (r) => {
    const pctRow = close ? r.pctClose : r.pct;
    return {
      units: finite(r.edition) && r.edition > 0 ? `${fmt(unitsOf(r))} of ${fmt(r.edition)}` : fmt(unitsOf(r)),
      pct: pctRow !== null && pctRow !== undefined ? `${Math.round(pctRow * 100)}%` : null,
    };
  };
  const stampTip = incomplete.length ? {
    head: "Incomplete data",
    rows: incomplete.map((m) => ({ label: "Not in the feed yet", value: m })),
    body: incomplete.includes("products")
      ? "The event feed has no draws for this release yet, so the release is one row. The per-product rows appear after the next data refresh."
      : "Sales the draw cannot name a product for are split by edition size inside the sold segment until the sales feed carries the product; draft orders are not drawn until a feed carries them.",
  } : null;

  // the days the page counts sales over, when its units are the orders
  // table's (docs 6.3), and what was paid outside them
  const salesWindow = snap.unitsSource === "orders" ? snap.salesWindow || null : null;
  const outside = salesWindow ? st.unitsOutsideWindow || null : null;
  const dayText = (iso) => fmtDay(new Date(iso + "T00:00:00Z"));
  const windowText = !salesWindow ? null : snap.catalogue
    ? "Units paid from the orders table over the last 90 days, the days every card on the page counts."
    : "Units paid from the orders table, over the days every card on the page counts: from the first paid order or the campaign start, whichever is earlier (never more than 45 days before the announce), " +
      (salesWindow.closed ? "to two days after the close." : "to the data's last day; the window shuts two days after the close.");

  const rateText = `${Math.round(rate * 100)}%`;
  const preRate = finite(st.preorderConversion) ? st.preorderConversion : null;
  const preRateText = preRate === null ? null : `${Math.round(preRate * 100)}%`;
  const twoRates = preRateText !== null && preRateText !== rateText;
  const methodTip = {
    head: "How the card counts",
    body: `Paid is units paid for. Drafts are orders raised but not yet paid, including the orders advisors have out for winners; they take room like a sale. Draw winners (estimate) are the people still in the draw, counted at ${rateText}${twoRates ? `, or at ${preRateText} where they entered as a pre-order and their card is already authorised` : ""}. Winners who have not paid are not counted: the order sent after a failed payment is in Drafts for 72 hours, and after that it is out. ` +
      "Someone who entered more products than they want is counted on the number they want, on the priciest of them with room first, which is how the allocator awards them." +
      (close ? " Still to come is the projection's further units, spread over the room left." : ""),
  };
  /* No copy under the rows. The allocation's account lives in the popup of
     the draw-winners key, the split sales in the paid key's, and the
     editions in Target setting, where they can be fixed. */
  const alloc = st.allocation || null;
  const moved = fromFeed ? st.products.filter((p) => (p.flexible ?? 0) > 0) : [];
  const inHandTip = {
    head: "Draw winners (estimate)",
    rows: [
      ...(alloc ? [{ label: "People still in the draw", value: fmt(Math.max((alloc.entrants || 0) - (alloc.unpaidWinners || 0), 0)) }] : []),
      ...(alloc && alloc.unpaidWinners > 0 ? [{ label: "Won, not yet paid (not counted)", value: fmt(alloc.unpaidWinners) }] : []),
      ...(alloc && alloc.flexibleEntrants > 0 ? [
        { label: "Entered more products than they want", value: fmt(alloc.flexibleEntrants) },
        ...moved.map((p) => ({ label: "Counted on " + p.name, value: "+" + fmt(p.flexible) })),
      ] : []),
      { label: twoRates ? `Draw winners at ${rateText}, pre-orders ${preRateText}` : `Draw winners at ${rateText}`, value: fmt(inHandAll) },
    ],
    body: alloc && alloc.flexibleEntrants > 0
      ? "Someone who entered more products than they want is counted on the number they want, on the priciest of them with room first, which is how the allocator awards them."
      : undefined,
  };

  /* One rule for the rows: the pitch is the height they share divided by the
     count, capped, and the bar is half of it. */
  const n = Math.max(rows.length, 1);
  const pitch = Math.min(PITCH_MAX, Math.floor(ROWS_H / n));
  const barH = Math.floor(pitch / 2);
  const barR = Math.max(4, Math.round(barH / 5));

  /* The key: swatch, what it is, and the release's total. It sits on the
     headline's line, the release's figure on the left and its composition
     on the right, which is what leaves the rows their height. */
  const legendChip = ({ key, sw, label, value, tip }) => (
    <span key={key} {...(tip ? t.props(tip) : {})} style={{ ...legendItem, cursor: tip ? "help" : "default" }}>
      {sw}
      <span>{label}</span>
      {value !== null && value !== undefined && (
        <span className="num" style={{ fontWeight: 600, color: C.ink }}>{value}</span>
      )}
    </span>
  );

  /* "Post to Slack": the card as a message, to the channel set on the Target
     setting tab, at the horizon this page is on. The server composes it from
     the same snapshot (server/slack.js). */
  const channel = (snap && snap.slack && snap.slack.channel) || null;
  const postToSlack = async () => {
    setPost({ state: "posting" });
    try {
      const r = await fetch(`/api/releases/${snap.id}/slack`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ horizon: close ? "close" : "today" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Slack post failed (${r.status})`);
      setPost({ state: "done", channel: d.channel, warning: d.warning || null });
      setTimeout(() => setPost((p) => (p.state === "done" ? { state: "idle" } : p)), 6000);
    } catch (e) {
      setPost({ state: "error", message: String(e.message || e) });
    }
  };
  /* The button keeps one width through its states, so the head never
     reflows while it works: Post to Slack, Posting…, Done, Failed. What
     happened in detail (the channel, a picture that did not go up, why a
     post was refused) is on its hover, not on a line of its own. */
  const slackTitle = post.state === "error"
    ? `Not posted to Slack: ${post.message}`
    : post.state === "done"
      ? `Posted to #${post.channel}${post.warning ? `, but ${post.warning}` : ""}`
      : channel
        ? `Post this card, as a message with a table of the works, to #${channel}`
        : "Set a Slack channel for this release on the Target setting tab, then this posts the card there";
  const slackButton = snap && snap.id ? (
    <button
      className="btn secondary small"
      disabled={!channel || post.state === "posting"}
      onClick={postToSlack}
      title={slackTitle}
      style={{
        minWidth: 100, textAlign: "center",
        color: post.state === "error" ? C.red : post.state === "done" && post.warning ? C.amber : undefined,
      }}
    >
      {post.state === "posting" ? "Posting…" : post.state === "done" ? "Done" : post.state === "error" ? "Failed" : "Post to Slack"}
    </button>
  ) : null;

  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title="Sell-through by product"
      badge={<HorizonBadge horizon={horizon} />}
      right={slackButton}
    >
      {/* the headline line: the release's figure on the left, its key on the
          right, one line, spaced from the head as every card's lead is (an
          8px spacer and the lead's own line) */}
      <div style={{ marginTop: 8, height: 39, flex: "0 0 39px", display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <div className="lead" {...t.props(methodTip, 300)} style={{ lineHeight: "39px", whiteSpace: "nowrap", color: C.ink }}>
          <span>{headText}</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: C.muted }}>
            {edition ? `of ${fmt(edition)} units` : "units"}
          </span>
        </div>
        {edition === null && <span className="lead-caption" style={{ marginTop: 0, whiteSpace: "nowrap" }}>no edition size set</span>}
        <div style={{ marginLeft: "auto", minWidth: 0, overflow: "hidden", display: "flex", alignItems: "center", gap: 16, fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }}>
          {legendChip({
            key: "sold", sw: <span style={swatch(SEG.paid)} />, label: "Paid", value: fmt(sold),
            tip: { head: "Paid", rows: [
              { label: "Units", value: fmt(sold) },
              ...(fromFeed && (st.unattributedSold ?? 0) > 0 ? [
                { label: "Of which named by product", value: fmt(st.attributedSold ?? 0) },
                { label: "Of which estimated", value: fmt(st.unattributedSold ?? 0) },
              ] : []),
              ...(salesWindow ? [{ label: "Counted", value: `${dayText(salesWindow.start)} to ${dayText(salesWindow.end)}` }] : []),
              ...(outside && outside.before > 0 ? [{ label: "Paid earlier (not counted)", value: fmt(outside.before) }] : []),
              ...(outside && outside.after > 0 ? [{ label: "Paid after the window shut (not counted)", value: fmt(outside.after) }] : []),
              ...(outside && outside.pending > 0 ? [{ label: `Paid since ${dayText(salesWindow.end)} (counts on the next refresh)`, value: fmt(outside.pending) }] : []),
            ],
            body: [
              fromFeed && (st.unattributedSold ?? 0) > 0
                ? "The draw feed only names the product of a sale that came through a draw win; the rest is split across the products by edition size until the sales feed carries the product."
                : null,
              salesWindow ? windowText : null,
            ].filter(Boolean).join(" ") || undefined },
          })}
          {draftsAll !== null && draftsAll > 0 && legendChip({
            key: "drafts", sw: <span style={swatch(SEG.drafts)} />, label: "Drafts", value: fmt(draftsAll),
            tip: { head: "Drafts", rows: [
              { label: "Units", value: fmt(draftsAll) },
              ...(winnerDraftsAll > 0 ? [{ label: "Of which winners' claims, under 72 hours old", value: fmt(winnerDraftsAll) }] : []),
              ...(winnerDraftsLapsedAll > 0 ? [{ label: "Winners' claims unpaid after 72 hours (not counted)", value: fmt(winnerDraftsLapsedAll) }] : []),
            ],
            body: "Draft orders raised but not yet paid. They take room like a sale. The order an advisor sends a winner after a failed payment counts for 72 hours; unpaid after that, it is out." },
          })}
          {legendChip({
            key: "inhand", sw: <span style={swatch(SEG.winners)} />, label: "Draw winners (estimate)", value: fmt(inHandAll), tip: inHandTip,
          })}
          {close && legendChip({
            key: "future", sw: <span style={swatch(SEG.future)} />, label: "Still to come", value: fmt(futureAll),
            tip: { head: "Still to come", rows: [{ label: "Units", value: fmt(futureAll) }],
              body: "The projection's further units, spread over the products with room left." },
          })}
        </div>
      </div>

      {/* the products, and the stamp over them while a feed is missing. The
          rows are one grid: the name column is as wide as the longest name
          on the card, up to 260px, so a short name sits by its bar and the
          bars still line up; the two figure columns, units and percentage,
          are one number wide each. */}
      <div style={{ flex: 1, minHeight: 0, marginTop: 10, display: "flex", flexDirection: "column" }}>
        <div style={{ position: "relative", flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {stampTip && (
            <div {...t.props(stampTip)} style={{
              position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%) rotate(-7deg)",
              padding: "5px 12px", border: `2px solid ${C.amber}`, borderRadius: 6, color: C.amber,
              background: "rgba(255,254,251,0.78)", fontSize: 12, fontWeight: 700, letterSpacing: "0.12em",
              textTransform: "uppercase", whiteSpace: "nowrap", zIndex: 2, cursor: "help",
            }}>
              Incomplete data
            </div>
          )}
          <div style={{
            minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "fit-content(260px) minmax(0, 1fr) 92px 56px",
            gridAutoRows: `${pitch}px`, columnGap: 14, alignItems: "center", alignContent: "start",
          }}>
            {rows.map((r) => {
              const rowTip = { head: r.name, rows: [
                { label: "Paid", value: fmt((r.sold ?? 0) + (r.soldAssumed ?? 0)) },
                { label: "Drafts", value: fmt(r.drafts ?? 0) },
                { label: "Draw winners (estimate)", value: fmt(r.shown ?? 0) },
              ] };
              const tips = {
                sold: rowTip, drafts: rowTip, inHand: rowTip,
                future: { head: r.name, rows: [{ label: "Still to come", value: fmt(r.futurePredicted ?? 0) }] },
                over: { head: r.name, rows: [{ label: "Demand beyond the edition", value: "+" + fmt(r.oversubscribed ?? 0) }],
                  body: "Entries in hand at the rate that this product has no room for." },
              };
              const nameTip = { head: r.name, rows: [
                ...(finite(r.edition) ? [{ label: "Edition", value: fmt(r.edition) }] : [{ label: "Edition", value: "not set" }]),
                ...(finite(r.entrants) ? [{ label: "Eligible entrants", value: fmt(r.entrants) }] : []),
                ...(r.draws && r.draws.length > 1 ? [{ label: "Draws", value: fmt(r.draws.length) }] : []),
              ] };
              const fig = figureOf(r);
              return (
                <React.Fragment key={r.key}>
                  <div {...t.props(nameTip)} style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.name}
                  </div>
                  <ProductBar row={r} close={close} maxV={maxFor(r)} tips={tips} height={barH} radius={barR} />
                  <div className="num" {...t.props(nameTip)} style={{ textAlign: "right", whiteSpace: "nowrap", fontSize: 12.5, color: C.muted }}>
                    {fig.units}
                  </div>
                  <div className="num" style={{ textAlign: "right", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600, color: C.ink }}>
                    {fig.pct}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}
