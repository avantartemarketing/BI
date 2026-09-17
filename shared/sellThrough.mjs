/* Sell-through per product (docs/DATA_MODEL.md §6.3).
 *
 * A release with several products runs one draw per product, and an entrant
 * can enter more than one draw while wanting fewer pieces than they entered
 * for: someone who enters four products with a maximum quantity of two is one
 * conversion on two products, not four. The allocator resolves that at close
 * by awarding the least-demanded of their products, and the sell-through
 * prediction has to count the same way before close or it overstates demand
 * on every product the flexible entrants also entered.
 *
 * This module is that counting rule, shared by the ETL's Python mirror
 * (etl/sellthrough.py, the reference the snapshot is built from), the server
 * (a save that changes product editions or the entry → order rate re-runs it on
 * the snapshot's own patterns) and the web app. Inputs are aggregate only: the
 * draw feed is reduced to PATTERNS - how many entrants have this exact
 * combination of open entries, unpaid wins, paid wins and maximum quantity -
 * so nothing here ever sees a person.
 *
 *   products  [{ key, name, edition, draws: [drawId], sold, drafts }]
 *             edition null when nobody has typed it; sold = units already paid
 *             for and attributed to the product; drafts = draft orders not yet
 *             paid (null until a feed carries them), which take room like a sale
 *   patterns  [{ open: [drawId], won: [drawId], sold: [drawId], bought, max, n }]
 *             open = eligible entries still in the draw (not won, not bought);
 *             won = won and not yet paid; sold = won and paid; bought = pieces
 *             bought in all, which is what has used up the entrant's appetite;
 *             max = the entrant's maximum quantity, null for no cap; n = how
 *             many entrants share the pattern
 *   rate      the entry → order rate the in-hand entries convert at (0.8)
 *
 * The rule, entrant by entrant:
 *   appetite  = max − bought (no cap: everything they entered)
 *   unpaid wins are pinned to their product first - the allocation is done;
 *   what appetite is left goes to the open entries. An entrant whose appetite
 *   covers every open entry counts once on each; one whose appetite is
 *   smaller is FLEXIBLE and is counted on the products with the most room.
 * The flexible entrants are placed one unit at a time: take the product with
 * the lowest fill (sold plus the units counted so far at the rate, over the
 * edition; plain units when editions are not all known), and give it to the
 * flexible entrant who entered it and has the fewest other options left. So a
 * product short of demand is topped up before a product already spoken for,
 * and an entrant with one alternative is placed before one with five. Ties
 * break on product order and then pattern order, so the same input always
 * gives the same answer on either side.
 *
 * Nothing here is capped: `allocated` is the demand counted on the product,
 * `predicted` that demand at the rate, and `room` (edition − sold) is what the
 * card caps it against, so oversubscription stays visible rather than being
 * silently rounded off. */

const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/* Draw ids -> product index, and a pattern's draw sets -> sorted unique
 * product index arrays. A draw no product claims is dropped (the build gives
 * every draw a product, so this is belt and braces). */
function productSets(products) {
  const byDraw = new Map();
  products.forEach((p, i) => (p.draws || []).forEach((d) => byDraw.set(String(d), i)));
  const toSet = (draws) => {
    const s = new Set();
    for (const d of draws || []) { const i = byDraw.get(String(d)); if (i !== undefined) s.add(i); }
    return Array.from(s).sort((a, b) => a - b);
  };
  return toSet;
}

export function allocateEntries({ products, patterns, rate = 0.8 }) {
  const P = products.length;
  const r = finite(rate) ? Number(rate) : 0.8;
  // sold and drafts both take room out of the edition
  const sold = products.map((p) => (Number(p.sold) || 0) + (finite(p.drafts) ? Number(p.drafts) : 0));
  const editions = products.map((p) => (finite(p.edition) && Number(p.edition) > 0 ? Number(p.edition) : null));
  // fill is a share of the edition when every product has one; a product
  // count otherwise, so a release with editions typed for half its products
  // is not ranked on two different measures at once
  const byFill = P > 0 && editions.every((e) => e !== null);
  const pinned = new Array(P).fill(0);
  const fixed = new Array(P).fill(0);
  const flexible = new Array(P).fill(0);
  // people with an entry in hand on each product, before the rule is applied
  const openPeople = new Array(P).fill(0);
  const wonPeople = new Array(P).fill(0);
  const total = (i) => pinned[i] + fixed[i] + flexible[i];
  const fill = (i) => (byFill ? (sold[i] + r * total(i)) / editions[i] : sold[i] + r * total(i));
  const toSet = productSets(products);

  // entrant-level bookkeeping, as counts
  let entrants = 0, flexibleEntrants = 0, surplusEntries = 0, uncapped = 0, unpaidWinners = 0;
  const subs = [];   // flexible sub-patterns: { options, need, n, order }
  let order = 0;
  patterns.forEach((pat, pi) => {
    const n = Number(pat.n) || 0;
    if (n <= 0) return;
    entrants += n;
    const won = toSet(pat.won);
    const soldSet = toSet(pat.sold);
    const wonSet = new Set(won);
    const open = toSet(pat.open).filter((i) => !wonSet.has(i) && !soldSet.includes(i));
    for (const i of open) openPeople[i] += n;
    for (const i of won) wonPeople[i] += n;
    const cap = finite(pat.max) ? Number(pat.max) : null;
    if (cap === null) uncapped += n;
    const bought = Number(pat.bought) || 0;
    let appetite = cap === null ? Infinity : Math.max(cap - bought, 0);
    if (won.length) unpaidWinners += n;
    if (won.length <= appetite) {
      // the allocation has already been made for these: pin them
      for (const i of won) pinned[i] += n;
      appetite -= won.length;
    } else {
      // won more than they still want (rare): they take `appetite` of their
      // wins, placed by the same rule as everything else
      subs.push({ options: won, need: appetite, n, order: order++, pattern: pi, kind: "pinned" });
      appetite = 0;
    }
    if (!open.length || appetite <= 0) {
      if (open.length && appetite <= 0) surplusEntries += n * open.length;
      return;
    }
    if (appetite >= open.length) {
      for (const i of open) fixed[i] += n;
      return;
    }
    flexibleEntrants += n;
    surplusEntries += n * (open.length - appetite);
    subs.push({ options: open, need: appetite, n, order: order++, pattern: pi, kind: "flexible" });
  });

  // water-fill the flexible units
  const key = (s) => `${s.pattern}|${s.kind}|${s.need}|${s.options.join(",")}`;
  const index = new Map(subs.map((s) => [key(s), s]));
  const bump = (i, s) => { if (s.kind === "pinned") pinned[i] += 1; else flexible[i] += 1; };
  for (;;) {
    // which products can still take a flexible unit, and from whom
    let best = -1, bestFill = 0, bestTotal = 0;
    for (let i = 0; i < P; i++) {
      let can = false;
      for (const s of subs) if (s.n > 0 && s.need > 0 && s.options.includes(i)) { can = true; break; }
      if (!can) continue;
      const f = fill(i), t = total(i);
      if (best < 0 || f < bestFill - 1e-12 || (Math.abs(f - bestFill) <= 1e-12 && (t < bestTotal || (t === bestTotal && i < best)))) {
        best = i; bestFill = f; bestTotal = t;
      }
    }
    if (best < 0) break;
    // the most constrained entrant who entered it
    let pick = null;
    for (const s of subs) {
      if (s.n <= 0 || s.need <= 0 || !s.options.includes(best)) continue;
      if (pick === null || s.options.length < pick.options.length
        || (s.options.length === pick.options.length && (s.pattern < pick.pattern
          || (s.pattern === pick.pattern && s.order < pick.order)))) pick = s;
    }
    pick.n -= 1;
    bump(best, pick);
    const rest = pick.options.filter((i) => i !== best);
    const need = pick.need - 1;
    if (need > 0 && rest.length) {
      const nk = `${pick.pattern}|${pick.kind}|${need}|${rest.join(",")}`;
      let next = index.get(nk);
      if (!next) {
        next = { options: rest, need, n: 0, order: order++, pattern: pick.pattern, kind: pick.kind };
        index.set(nk, next);
        subs.push(next);
      }
      next.n += 1;
    }
  }

  const out = products.map((p, i) => {
    const allocated = total(i);
    const predicted = allocated * r;
    const room = editions[i] === null ? null : Math.max(editions[i] - sold[i], 0);
    const shown = room === null ? predicted : Math.min(predicted, room);
    return {
      key: p.key, allocated, pinned: pinned[i], fixed: fixed[i], flexible: flexible[i],
      inHand: { open: openPeople[i], won: wonPeople[i] },
      predicted, shown, room, oversubscribed: room === null ? 0 : Math.max(predicted - room, 0),
    };
  });
  return {
    rate: r, measure: byFill ? "fill" : "units", products: out,
    entrants, flexibleEntrants, surplusEntries, uncapped, unpaidWinners,
  };
}

/* The whole per-product block the card reads: the allocation above, the
 * units still to come spread over the room left, and the shares. `sold` on a
 * product is what the draw feed could attribute to it; `unattributedSold` is
 * the rest of the release's sold units (private room, pre-orders, re-offers)
 * that no product can be named for yet, and it is carried at release level
 * rather than guessed onto products. */
export function sellThroughProducts({ products, patterns, rate = 0.8, edition = null, soldTotal = null, futureUnits = 0,
  expectedToday = null, benchmarkToday = null, benchmarkClose = null }) {
  const attributed = products.reduce((t, p) => t + (Number(p.sold) || 0), 0);
  const soldAll = finite(soldTotal) ? Math.max(Number(soldTotal), attributed) : attributed;
  const unattributed = Math.max(soldAll - attributed, 0);
  const editions = products.map((p) => (finite(p.edition) && Number(p.edition) > 0 ? Number(p.edition) : null));
  const allEditions = products.length > 0 && editions.every((e) => e !== null);
  const editionSum = allEditions ? editions.reduce((t, e) => t + e, 0) : null;
  /* Sales the feed cannot name a product for (private room, pre-orders) are
   * real units out of some product's edition. Left off the rows they would
   * overstate every product's room - on a private-room-led launch by most of
   * the edition - so they are split across the products by edition size (by
   * eligible entrants until every edition is typed), drawn as their own
   * "assumed" segment and said in words, never passed off as attributed. */
  const weights = products.map((p, i) => (allEditions ? editions[i] : Math.max(Number(p.entrants) || 0, 0)));
  const wSum = weights.reduce((t, w) => t + w, 0);
  const assumed = products.map((p, i) => (unattributed > 0
    ? unattributed * (wSum > 0 ? weights[i] / wSum : 1 / products.length) : 0));
  const withAssumed = products.map((p, i) => ({ ...p, sold: (Number(p.sold) || 0) + assumed[i] }));
  const alloc = allocateEntries({ products: withAssumed, patterns, rate });
  // units still to come: over the room left after what is in hand, else (no
  // editions) by each product's share of the demand so far
  const future = Math.max(Number(futureUnits) || 0, 0);
  const roomAfter = alloc.products.map((a, i) => (a.room === null ? null : Math.max(a.room - a.shown, 0)));
  const roomSum = allEditions ? roomAfter.reduce((t, v) => t + v, 0) : null;
  const draftsOf = (p) => (finite(p.drafts) ? Number(p.drafts) : 0);
  const demand = alloc.products.map((a, i) => (Number(products[i].sold) || 0) + assumed[i] + draftsOf(products[i]) + a.shown);
  const demandSum = demand.reduce((t, v) => t + v, 0);
  const futureShare = alloc.products.map((a, i) => {
    if (allEditions) return roomSum > 0 ? future * (roomAfter[i] / roomSum) : 0;
    return demandSum > 0 ? future * (demand[i] / demandSum) : (products.length ? future / products.length : 0);
  });
  // the references, as the release's pace applied to each product's edition:
  // a product is expected to sell through at the rate the release is
  const paceOf = (v) => (finite(v) && finite(edition) && Number(edition) > 0 ? Number(v) / Number(edition) : null);
  const paceExp = paceOf(expectedToday), paceBmToday = paceOf(benchmarkToday), paceBmClose = paceOf(benchmarkClose);

  const rows = products.map((p, i) => {
    const a = alloc.products[i];
    const sold = Number(p.sold) || 0;
    const e = editions[i];
    const today = sold + assumed[i] + draftsOf(p) + a.shown;
    const close = today + futureShare[i];
    return {
      key: p.key, name: p.name, draws: p.draws || [], edition: e,
      entrants: p.entrants ?? null, inHand: a.inHand,
      sold, soldAssumed: r1(assumed[i]), drafts: finite(p.drafts) ? Number(p.drafts) : null,
      allocated: a.allocated, pinned: a.pinned, fixed: a.fixed, flexible: a.flexible,
      predicted: r1(a.predicted), shown: r1(a.shown), room: a.room, oversubscribed: r1(a.oversubscribed),
      futurePredicted: r1(futureShare[i]),
      pct: e ? r4(Math.min(today / e, 1)) : null,
      pctClose: e ? r4(Math.min(close / e, 1)) : null,
      expectedToday: e !== null && paceExp !== null ? r1(e * paceExp) : null,
      benchmarkToday: e !== null && paceBmToday !== null ? r1(e * paceBmToday) : null,
      benchmarkClose: e !== null && paceBmClose !== null ? r1(e * paceBmClose) : null,
    };
  });
  const shownSum = rows.reduce((t, x) => t + x.shown, 0);
  const futureSum = rows.reduce((t, x) => t + x.futurePredicted, 0);
  const ed = finite(edition) && Number(edition) > 0 ? Number(edition) : null;
  const draftsAll = products.some((p) => finite(p.drafts)) ? products.reduce((t, p) => t + draftsOf(p), 0) : null;
  const inventoryLeft = ed === null ? null : Math.max(ed - soldAll - (draftsAll || 0), 0);
  const predictedAll = inventoryLeft === null ? shownSum : Math.min(shownSum, inventoryLeft);
  const futureAll = inventoryLeft === null ? futureSum : Math.min(futureSum, Math.max(inventoryLeft - predictedAll, 0));
  return {
    conversion: alloc.rate, measure: alloc.measure,
    products: rows,
    attributedSold: attributed, unattributedSold: unattributed, drafts: draftsAll,
    soldPredicted: r1(predictedAll), futureEntriesPredicted: r1(futureAll),
    pct: ed === null ? null : r4(Math.min((soldAll + (draftsAll || 0) + predictedAll + futureAll) / ed, 1)),
    editionSum, editionMismatch: editionSum !== null && ed !== null && Math.round(editionSum) !== Math.round(ed),
    allocation: {
      entrants: alloc.entrants, flexibleEntrants: alloc.flexibleEntrants, surplusEntries: alloc.surplusEntries,
      uncapped: alloc.uncapped, unpaidWinners: alloc.unpaidWinners,
      flexibleUnits: rows.reduce((t, x) => t + x.flexible, 0),
    },
  };
}

/* The products of a release, from the draws the event feed found and what
 * was typed against them on the Target setting tab. One draw is one product
 * unless two draws are given the same name, which merges them (a re-run or a
 * second wave of the same product). A draw nobody has named is "Draw N" in
 * first-entry order. Typed entries carry the draw id as `key`; an entry with
 * no key (the older hand-typed list) is matched to the unclaimed draws in
 * order. Sold units come from the draw feed: winners who bought, or the
 * purchases the feed tags with a draw where it does. A single product with no
 * edition typed is the edition itself.
 *   draws       [{ id, first, entrants, eligible, winners, sold, open, wonUnpaid, purchaseUnits }]
 *   configured  [{ key, name, edition }]  (may be empty)
 *   editionSize the release's edition, or null */
export function productsFromDraws(draws, configured, editionSize) {
  const sorted = (draws || []).slice().sort((a, b) =>
    String(a.first || "").localeCompare(String(b.first || "")) || String(a.id).localeCompare(String(b.id)));
  const cfg = Array.isArray(configured) ? configured.filter((c) => c && typeof c === "object") : [];
  const byKey = new Map(cfg.filter((c) => c.key !== undefined && c.key !== null && c.key !== "").map((c) => [String(c.key), c]));
  const legacy = cfg.filter((c) => c.key === undefined || c.key === null || c.key === "");
  const tagged = sorted.some((d) => Number(d.purchaseUnits) > 0);
  const groups = new Map();
  sorted.forEach((d, i) => {
    let c = byKey.get(String(d.id)) || null;
    if (!c && legacy.length) c = legacy.shift();
    const name = (c && typeof c.name === "string" && c.name.trim()) || `Draw ${i + 1}`;
    const edition = c && finite(c.edition) && Number(c.edition) > 0 ? Math.round(Number(c.edition)) : null;
    let g = groups.get(name);
    if (!g) { g = { key: String(d.id), name, edition, draws: [], sold: 0, entrants: 0, drafts: null }; groups.set(name, g); }
    if (g.edition === null && edition !== null) g.edition = edition;
    g.draws.push(String(d.id));
    g.sold += tagged ? (Number(d.purchaseUnits) || 0) : (Number(d.sold) || 0);
    g.entrants += Number(d.eligible) || 0;
  });
  const products = Array.from(groups.values());
  if (products.length === 1 && products[0].edition === null && finite(editionSize) && Number(editionSize) > 0) {
    products[0].edition = Math.round(Number(editionSize));
  }
  return { products, soldSource: tagged ? "purchases" : "winners" };
}

const r1 = (v) => Math.round(v * 10) / 10;
const r4 = (v) => Math.round(v * 10000) / 10000;
