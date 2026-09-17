/* Sell-through by product (docs/DATA_MODEL.md §6.3). Wide card (2 cols × 1 row).
 *
 * The question is "how much of each edition is spoken for", so the card is
 * one row per product. Each row is that product's edition, and on it the
 * units already paid for (rust), the entries in hand counted on the product
 * at the entry → order rate (orange), and at close the units still to come
 * (the projection's light orange). Demand in hand beyond the product's room
 * is the hatch past its sellout, drawn in both horizons because it is the
 * fact the allocator most needs.
 *
 * The entries in hand are not simply everyone who entered the product. An
 * entrant who entered four products but wants two is one conversion on two
 * of them, and is counted on whichever of their products have the most room
 * - the same rule the allocator applies at close (shared/sellThrough.mjs).
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
/* Sold units the feed could not name a product for, split by edition size:
 * rust, but striped, so it never passes for an attributed sale. */
const ASSUMED = `repeating-linear-gradient(135deg, ${C.rust} 0 2px, #d7a998 2px 5px)`;
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
  const sold = row.sold ?? 0;
  const assumed = row.soldAssumed ?? 0;
  const inHand = row.shown ?? 0;
  const future = close ? row.futurePredicted ?? 0 : 0;
  const over = row.oversubscribed ?? 0;
  const segs = [
    { key: "sold", v: sold, color: C.rust, tip: tips.sold },
    ...(assumed > 0 ? [{ key: "assumed", v: assumed, color: ASSUMED, tip: tips.assumed }] : []),
    ...(finite(row.drafts) && row.drafts > 0 ? [{ key: "drafts", v: row.drafts, color: "#c0522a", tip: tips.drafts }] : []),
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
  const inHandAll = st.soldPredicted ?? 0;
  const futureAll = close ? st.futureEntriesPredicted ?? 0 : 0;
  const fromFeed = Array.isArray(st.products) && st.products.length > 0;

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
  const soldOf = (r) => (r.sold ?? 0) + (r.soldAssumed ?? 0);
  const demandOf = (r) => soldOf(r) + (r.shown ?? 0) + (close ? r.futurePredicted ?? 0 : 0) + (r.oversubscribed ?? 0);
  const unitsMax = Math.max(...rows.map((r) => Math.max(r.edition ?? 0, demandOf(r))), 1) * 1.02;
  const maxFor = (r) => (byEdition ? Math.max(r.edition, demandOf(r)) * 1.02 : unitsMax);

  // the headline: what is spoken for today, or the prediction at close
  const headPct = edition ? (close ? st.pct ?? 0 : Math.min((sold + inHandAll) / edition, 1)) : null;
  const headUnits = sold + inHandAll + futureAll;

  const rateText = `${Math.round(rate * 100)}%`;
  const methodTip = {
    head: "How the card counts",
    body: `Sold is units paid for. From entries in hand is every eligible entry still in the draw, counted at ${rateText} entry → order. ` +
      "An entrant who entered more products than they want is counted on their maximum quantity of products only, placed where there is most room - the rule the allocator applies at close." +
      (close ? " Still to come is the projection's further units, spread over the room left." : ""),
  };
  /* No copy under the rows. The allocation's account lives in the popup of
     the "From entries in hand" row, the split sales in the striped segment's,
     and the editions in Target setting, where they can be fixed. */
  const alloc = st.allocation || null;
  const moved = fromFeed ? st.products.filter((p) => (p.flexible ?? 0) > 0) : [];
  const inHandTip = {
    head: "From entries in hand",
    rows: [
      ...(alloc ? [{ label: "Entrants in hand", value: fmt(alloc.entrants) }] : []),
      ...(alloc && alloc.flexibleEntrants > 0 ? [
        { label: "Want fewer than entered for", value: fmt(alloc.flexibleEntrants) },
        { label: "Entries not counted", value: fmt(alloc.surplusEntries) },
        ...moved.map((p) => ({ label: "Placed on " + p.name, value: "+" + fmt(p.flexible) })),
      ] : []),
      ...(alloc && alloc.unpaidWinners > 0 ? [{ label: "Won, not yet paid", value: fmt(alloc.unpaidWinners) }] : []),
      { label: `Units at ${rateText}`, value: fmt(inHandAll) },
    ],
    body: alloc && alloc.flexibleEntrants > 0
      ? "An entrant who entered more products than their maximum quantity is counted on that many products only, on whichever of the products they entered have the most room - the rule the allocator applies at close."
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
  const rowH = many ? 24 : rows.length > 4 ? 30 : 38;
  const barH = many ? 12 : 16;

  const leftRow = (key, sw, label, value, tip) => (
    <div key={key} {...t.props(tip)} style={{
      display: "flex", alignItems: "center", gap: 8, height: 24, fontSize: 12,
      borderTop: `1px solid ${C.hairline}`,
    }}>
      {sw}
      <span style={{ color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span className="num" style={{ marginLeft: "auto", fontWeight: 600, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );

  return (
    <Card
      dot={GROUP_DOTS.outcome}
      title={close ? "Predicted sell-through by product" : "Sell-through by product"}
      right={(
        <>
          <span className="hint-dotted" {...t.props(methodTip, 300)}>at {rateText} entry → order</span>
          {allEditions && rows.length > 1 && seg(
            [["pct", "%", "Every product on its own edition, so the rows read as sell-through"],
             ["units", "Units", "One scale for every product, so the rows read as size"]],
            scale, setScale,
          )}
        </>
      )}
    >
      <div className="spacer-8" />
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 28 }}>
        {/* the release: headline and what it is made of */}
        <div style={{ flex: "0 0 196px", display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div className="lead" {...t.props(methodTip, 300)}>
            {headPct === null ? <span style={{ color: C.ink }}>{fmt(headUnits)}</span>
              : <span style={{ color: ragColor(headPct) }}>{Math.round(headPct * 100)}%</span>}
            <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
              {edition ? `of ${fmt(edition)} units` : "units"}
            </span>
          </div>
          <div className="lead-caption">{close ? "predicted at close" : "spoken for today"}{edition === null ? " · no edition size set" : ""}</div>
          <div style={{ marginTop: 10 }}>
            {leftRow("sold", <span style={swatch(C.rust)} />, "Sold", fmt(sold), {
              head: "Sold", rows: [
                { label: "Units", value: fmt(sold) },
                ...(fromFeed ? [
                  { label: "By product", value: fmt(st.attributedSold ?? 0) },
                  { label: "Not by product", value: fmt(st.unattributedSold ?? 0) },
                ] : []),
              ],
            })}
            {leftRow("inhand", <span style={swatch(C.orange)} />, "From entries in hand", fmt(inHandAll), inHandTip)}
            {close && leftRow("future", <span style={swatch(C.orangeLight)} />, "Still to come", fmt(futureAll), {
              head: "Still to come", rows: [{ label: "Units", value: fmt(futureAll) }],
              body: "The projection's further units, spread over the products with room left.",
            })}
          </div>
        </div>

        {/* the products */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: many ? "auto" : "visible", display: "flex", flexDirection: "column", justifyContent: many ? "flex-start" : "center", gap: many ? 2 : 0 }}>
            {rows.map((r) => {
              const pctRow = close ? r.pctClose : r.pct;
              const roomLeft = r.room === null || r.room === undefined ? null : Math.max(r.room - (r.shown ?? 0), 0);
              const tips = {
                sold: { head: r.name, rows: [{ label: "Sold", value: fmt(r.sold ?? 0) }], body: fromFeed ? "Units paid for by winners of this product's draw." : undefined },
                assumed: { head: r.name, rows: [
                  { label: "Sold outside the draw", value: fmt(r.soldAssumed ?? 0) },
                  { label: "Across the release", value: fmt(st.unattributedSold ?? 0) },
                ], body: `Private-room and pre-order sales the feed cannot name a product for, split by ${allEditions ? "edition size" : "entrants"}: this product's share.` },
                drafts: { head: r.name, rows: [{ label: "Drafts", value: fmt(r.drafts ?? 0) }] },
                inHand: { head: r.name, rows: [
                  ...(r.inHand ? [{ label: "Entrants in hand", value: fmt((r.inHand.open ?? 0) + (r.inHand.won ?? 0)) }] : []),
                  ...(finite(r.allocated) ? [{ label: "Counted here", value: fmt(r.allocated) }] : []),
                  ...((r.flexible ?? 0) > 0 ? [{ label: "Of which placed by room", value: fmt(r.flexible) }] : []),
                  { label: `Units at ${rateText}`, value: fmt(r.shown ?? 0) },
                  ...(roomLeft !== null ? [{ label: "Room left", value: fmt(roomLeft) }] : []),
                ] },
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
                  display: "grid", gridTemplateColumns: "minmax(0, 128px) 1fr 84px", gap: 10, alignItems: "center", height: rowH,
                }}>
                  <div {...t.props(nameTip)} style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.name}
                  </div>
                  <ProductBar row={r} close={close} maxV={maxFor(r)} tips={tips} height={barH} />
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
      <div style={{ flex: "0 0 auto", paddingTop: 10, display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 14px", fontSize: 11, color: C.muted }}>
        <span style={legendItem}><span style={swatch(C.rust)} />Sold</span>
        {rows.some((r) => (r.soldAssumed ?? 0) > 0) && <span style={legendItem}><span style={{ ...swatch(ASSUMED), background: ASSUMED }} />Sold, split by {allEditions ? "edition" : "entrants"}</span>}
        {rows.some((r) => finite(r.drafts) && r.drafts > 0) && <span style={legendItem}><span style={swatch("#c0522a")} />Drafts</span>}
        <span style={legendItem}><span style={swatch(C.orange)} />From entries in hand</span>
        {close && <span style={legendItem}><span style={swatch(C.orangeLight)} />Still to come</span>}
        {rows.some((r) => (r.oversubscribed ?? 0) > 0) && (
          <span style={legendItem}><span style={{ ...swatch(HATCH), background: HATCH }} />Beyond the edition</span>
        )}
        <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
          {allEditions && rows.length > 1 ? (byEdition ? "each bar is its edition" : "one scale, sellout at the paler end") : edition ? "sellout at the paler end" : "units"}
        </span>
      </div>
    </Card>
  );
}
