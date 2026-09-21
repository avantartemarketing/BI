/* Sell-through by product (docs/DATA_MODEL.md §6.3). Wide card (2 cols × 1 row).
 *
 * The question is "how much of each edition is spoken for", so the card is
 * one row per product. Each row is that product's edition, and on it the
 * units already paid for (rust), draft orders not yet paid (rust, striped),
 * the entries in hand counted on the product at the entry → order rate
 * (orange), and at close the units still to come (the projection's light
 * orange). Demand in hand beyond the product's room is the hatch past its
 * sellout, drawn in both horizons because it is the fact the allocator most
 * needs.
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
 * the popup of the in-hand row, the split of sales the feed cannot name a
 * product for in the striped segment's, and the editions are checked where
 * they are typed, on the Target setting tab.
 *
 * No target and no benchmark on this card, by decision: both are on the hero
 * and the channels, and here they only crowded the reading. Each row is the
 * product against its own edition and nothing else.
 *
 * One toggle: % puts every product on its own edition, so the rows read as
 * sell-through; Units keeps one scale, so the rows read as size. Without
 * product editions the card runs on units and says what is missing. Without
 * the draw feed at all it is one row, the release, as before. */
import React, { useState } from "react";
import { Card, GROUP_DOTS, HATCH, C, fmt, ragColor, useTip } from "../ui.jsx";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
/* Draft orders: sold in all but payment, so rust, but striped. */
const DRAFTS = `repeating-linear-gradient(135deg, ${C.rust} 0 2px, #d7a998 2px 5px)`;
const swatch = (bg) => ({ width: 9, height: 9, borderRadius: 2, background: bg, flex: "0 0 9px" });
const legendItem = { display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" };

/* One product's bar. Layers, bottom to top: track → the paler room out to the
 * sellout → the segments inset → the hatch for demand past the sellout.
 * `maxV` is the bar's scale in units; in the % view it is the product's own
 * edition (plus any overshoot), in the Units view the same for every row. */
function ProductBar({ row, close, maxV, tips, height = 16, radius = 4 }) {
  const t = useTip();
  const tp = (x) => t.props(x);
  const pct = (v) => (maxV > 0 ? Math.max(0, Math.min(((v ?? 0) / maxV) * 100, 100)) : 0);
  const edition = row.edition;
  const inset = Math.max(3, Math.round(height * 0.2));
  const innerR = Math.max(2, radius - 2);
  // the sold segment carries the estimated split too, named in its popup
  const sold = (row.sold ?? 0) + (row.soldAssumed ?? 0);
  const inHand = row.shown ?? 0;
  const future = close ? row.futurePredicted ?? 0 : 0;
  const over = row.oversubscribed ?? 0;
  const segs = [
    { key: "sold", v: sold, color: C.rust, tip: tips.sold },
    ...(finite(row.drafts) && row.drafts > 0 ? [{ key: "drafts", v: row.drafts, color: DRAFTS, tip: tips.drafts }] : []),
    { key: "inhand", v: inHand, color: C.orange, tip: tips.inHand },
    ...(future > 0 ? [{ key: "future", v: future, color: C.orangeLight, tip: tips.future }] : []),
  ];
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
      {over > 0 && finite(edition) && (
        <div {...tp(tips.over)} style={{
          position: "absolute", top: inset, bottom: inset, left: `${pct(edition)}%`,
          width: `${pct(edition + over) - pct(edition)}%`, background: HATCH,
          borderTopRightRadius: innerR, borderBottomRightRadius: innerR,
        }} />
      )}
    </div>
  );
}

export default function SellThrough({ snap, horizon = "today" }) {
  const t = useTip();
  const [scale, setScale] = useState("pct");   // pct | units
  const [post, setPost] = useState({ state: "idle" });   // the Post to Slack button: idle | posting | done | error
  const st = snap?.sellthrough;
  const close = horizon === "close";
  const targeted = !snap || snap.targeted !== false;

  if (!st) {
    return (
      <Card dot={GROUP_DOTS.outcome} title="Sell-through by product">
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
  const byEdition = allEditions && scale === "pct";
  // one scale for the Units view: the biggest edition, or the biggest demand
  const soldOf = (r) => (r.sold ?? 0) + (r.soldAssumed ?? 0) + (finite(r.drafts) ? r.drafts : 0);
  const demandOf = (r) => soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0) + (r.oversubscribed ?? 0);
  const unitsMax = Math.max(...rows.map((r) => Math.max(r.edition ?? 0, demandOf(r))), 1) * 1.02;
  const maxFor = (r) => (byEdition ? Math.max(r.edition, demandOf(r)) * 1.02 : unitsMax);

  // the headline: what is spoken for today, or the prediction at close
  const headPct = edition ? (close ? st.pct ?? 0 : Math.min((sold + (draftsAll ?? 0) + inHandAll) / edition, 1)) : null;
  const headUnits = sold + (draftsAll ?? 0) + inHandAll + futureAll;
  const stampTip = incomplete.length ? {
    head: "Incomplete data",
    rows: incomplete.map((m) => ({ label: "Not in the feed yet", value: m })),
    body: incomplete.includes("products")
      ? "The event feed has no draws for this release yet, so the release is one row. The per-product rows appear after the next data refresh."
      : "Sales the draw cannot name a product for are split by edition size inside the sold segment until the sales feed carries the product; draft orders are not drawn until a feed carries them.",
  } : null;

  const rateText = `${Math.round(rate * 100)}%`;
  const methodTip = {
    head: "How the card counts",
    body: `Paid is units paid for. Drafts are orders raised but not yet paid, including the orders advisors have out for winners; they take room like a sale. Draw winners (estimate) are the people still in the draw at the ${rateText} rate at which entries become orders. Winners who have not paid are not counted: the order sent after a failed payment is in Drafts for 72 hours, and after that it is out. ` +
      "Someone who entered more products than they want is counted on the number they want, on the priciest of them with room first, which is how the allocator awards them." +
      (close ? " Still to come is the projection's further units, spread over the room left." : ""),
  };
  /* No copy under the rows. The allocation's account lives in the popup of
     the "Draw conversions" row, the split sales in the striped segment's,
     and the editions in Target setting, where they can be fixed. */
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
      { label: `Draw winners at ${rateText}`, value: fmt(inHandAll) },
    ],
    body: alloc && alloc.flexibleEntrants > 0
      ? "Someone who entered more products than they want is counted on the number they want, on the priciest of them with room first, which is how the allocator awards them."
      : undefined,
  };

  const seg = (opts, value, set) => (
    <span className="seg compact">
      {opts.map(([v, label, tip]) => (
        <button key={v} className={value === v ? "active" : ""} onClick={() => set(v)} title={tip}>{label}</button>
      ))}
    </span>
  );
  const many = rows.length > 6;
  // the bars share the card's height: fatter for three products than for six,
  // capped so a single product is not a slab
  const barH = Math.max(12, Math.min(30, Math.round(96 / Math.max(rows.length, 1))));
  const rowH = Math.max(24, Math.min(48, barH + 16));
  const barR = Math.max(4, Math.round(barH / 4));

  /* One key at the foot of the card: swatch, what it is, and the release's
     total. The totals used to sit in a column of their own beside the
     headline; they are here so the product titles get that width. */
  const legendChip = ({ key, sw, label, value, tip }) => (
    <span key={key} {...(tip ? t.props(tip) : {})} style={{ ...legendItem, cursor: tip ? "help" : "default" }}>
      {sw}
      <span>{label}</span>
      {value !== null && value !== undefined && (
        <span className="num" style={{ fontWeight: 600, color: C.ink }}>{value}</span>
      )}
    </span>
  );

  // "Post to Slack": today's figures to the channel set on the Target setting
  // tab, composed on the server from this same snapshot (server/slack.js)
  const channel = (snap && snap.slack && snap.slack.channel) || null;
  const postToSlack = async () => {
    setPost({ state: "posting" });
    try {
      const r = await fetch(`/api/releases/${snap.id}/slack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Slack post failed (${r.status})`);
      setPost({ state: "done", channel: d.channel });
      setTimeout(() => setPost((p) => (p.state === "done" ? { state: "idle" } : p)), 5000);
    } catch (e) {
      setPost({ state: "error", message: String(e.message || e) });
    }
  };
  const slackButton = snap && snap.id ? (
    <button
      className="btn secondary small"
      disabled={!channel || post.state === "posting"}
      onClick={postToSlack}
      title={channel
        ? `Post today's sell-through figures to #${channel}`
        : "Set a Slack channel for this release on the Target setting tab, then this posts the figures there"}
    >
      {post.state === "posting" ? "Posting…" : post.state === "done" ? `Posted to #${post.channel}` : post.state === "error" ? "Post failed" : "Post to Slack"}
    </button>
  ) : null;

  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title={close ? "Predicted sell-through by product" : "Sell-through by product"}
      right={(
        <>
          {slackButton}
          <span className="hint-dotted" {...t.props(methodTip, 300)}>at {rateText} entry → order</span>
          {allEditions && rows.length > 1 && seg(
            [["pct", "%", "Every product on its own edition, so the rows read as sell-through"],
             ["units", "Units", "One scale for every product, so the rows read as size"]],
            scale, setScale,
          )}
        </>
      )}
    >
      {/* a refused post says why, in a line of its own so the header keeps its shape */}
      {post.state === "error"
        ? <div style={{ color: C.red, fontSize: 12, margin: "2px 0 6px" }}>Not posted to Slack: {post.message}</div>
        : <div className="spacer-8" />}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 28 }}>
        {/* the release: headline and what it is made of */}
        <div style={{ flex: "0 0 132px", display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div className="lead" {...t.props(methodTip, 300)}>
            {headPct === null ? <span style={{ color: C.ink }}>{fmt(headUnits)}</span>
              : <span style={{ color: ragColor(headPct) }}>{Math.round(headPct * 100)}%</span>}
            <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
              {edition ? `of ${fmt(edition)} units` : "units"}
            </span>
          </div>
          <div className="lead-caption">{close ? "predicted at close" : "as of today"}{edition === null ? " · no edition size set" : ""}</div>
        </div>

        {/* the products, and the stamp over them while a feed is missing */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
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
          <div style={{ flex: 1, minHeight: 0, overflowY: many ? "auto" : "visible", display: "flex", flexDirection: "column", justifyContent: many ? "flex-start" : "center", gap: many ? 2 : 0 }}>
            {rows.map((r) => {
              const pctRow = close ? r.pctClose : r.pct;
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
              return (
                <div key={r.key} style={{
                  display: "grid", gridTemplateColumns: "minmax(0, 256px) 1fr 84px", gap: 12, alignItems: "center", height: rowH,
                }}>
                  <div {...t.props(nameTip)} style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.name}
                  </div>
                  <ProductBar row={r} close={close} maxV={maxFor(r)} tips={tips} height={barH} radius={barR} />
                  <div className="num" style={{ textAlign: "right", whiteSpace: "nowrap", lineHeight: 1.15 }}>
                    {pctRow !== null && pctRow !== undefined ? (
                      <>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: ragColor(pctRow) }}>{Math.round(pctRow * 100)}%</span>
                        <span style={{ fontSize: 10.5, color: C.muted, marginLeft: 5 }}>
                          {fmt(soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0))}/{fmt(r.edition)}
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{fmt(soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0))}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* legend, no rule */}
      <div style={{ flex: "0 0 auto", paddingTop: 10, display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px 18px", fontSize: 11.5, color: C.muted }}>
        {legendChip({
          key: "sold", sw: <span style={swatch(C.rust)} />, label: "Paid", value: fmt(sold),
          tip: { head: "Paid", rows: [
            { label: "Units", value: fmt(sold) },
            ...(fromFeed && (st.unattributedSold ?? 0) > 0 ? [
              { label: "Of which named by product", value: fmt(st.attributedSold ?? 0) },
              { label: "Of which estimated", value: fmt(st.unattributedSold ?? 0) },
            ] : []),
          ],
          body: fromFeed && (st.unattributedSold ?? 0) > 0
            ? "The draw feed only names the product of a sale that came through a draw win; the rest is split across the products by edition size until the sales feed carries the product."
            : undefined },
        })}
        {draftsAll !== null && draftsAll > 0 && legendChip({
          key: "drafts", sw: <span style={{ ...swatch(DRAFTS), background: DRAFTS }} />, label: "Drafts", value: fmt(draftsAll),
          tip: { head: "Drafts", rows: [
            { label: "Units", value: fmt(draftsAll) },
            ...(winnerDraftsAll > 0 ? [{ label: "Of which winners' claims, under 72 hours old", value: fmt(winnerDraftsAll) }] : []),
            ...(winnerDraftsLapsedAll > 0 ? [{ label: "Winners' claims unpaid after 72 hours (not counted)", value: fmt(winnerDraftsLapsedAll) }] : []),
          ],
          body: "Draft orders raised but not yet paid. They take room like a sale. The order an advisor sends a winner after a failed payment counts for 72 hours; unpaid after that, it is out." },
        })}
        {legendChip({
          key: "inhand", sw: <span style={swatch(C.orange)} />, label: "Draw winners (estimate)", value: fmt(inHandAll), tip: inHandTip,
        })}
        {close && legendChip({
          key: "future", sw: <span style={swatch(C.orangeLight)} />, label: "Still to come", value: fmt(futureAll),
          tip: { head: "Still to come", rows: [{ label: "Units", value: fmt(futureAll) }],
            body: "The projection's further units, spread over the products with room left." },
        })}
        {rows.some((r) => (r.oversubscribed ?? 0) > 0) && legendChip({
          key: "over", sw: <span style={{ ...swatch(HATCH), background: HATCH }} />, label: "Beyond the edition", value: null,
        })}
        <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
          {allEditions && rows.length > 1 ? (byEdition ? "each bar is its edition" : "one scale, sellout at the paler end") : edition ? "sellout at the paler end" : "units"}
        </span>
      </div>
    </Card>
  );
}
