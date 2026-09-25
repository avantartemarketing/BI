"""Sell-through per product: the allocation rule (docs/DATA_MODEL.md §6.3).

The reference implementation the snapshot is built from. shared/sellThrough.mjs
is the same rule for the server and the web app, and tests/sellthrough_parity
checks the two agree to the unit on the same fixtures; change one and change
the other.

A release runs one draw per product. An entrant who enters several draws but
wants fewer pieces than they entered for is one conversion on their maximum
quantity of products, not on all of them, and the allocator resolves which at
close for revenue: the priciest of their products with a unit left. This
module counts the entries in hand the same way before close:

  appetite = max quantity - pieces already bought (no cap: all they entered)
  unpaid wins spend the appetite first but count no units: a winner who has
  not paid is a draft when an advisor has an order out for them, and nowhere
  otherwise. The appetite left goes to
  the open entries. An entrant whose appetite covers every open entry counts
  once on each; one whose appetite is smaller is FLEXIBLE and is placed one
  unit at a time for revenue: on the priciest product whose expected orders
  (sold, drafts, and the entries counted so far at their rates) are still
  short of its edition, so the editions that drive the most revenue are
  filled to sell-out first and over-allocated for the payments expected to
  fail - the last entrant may take a product past its edition, where the
  card caps it; the lowest fill (expected orders over the edition) among
  equal prices; and only once every product is full, on the lowest fill, so
  oversubscription spreads evenly; taken from the flexible entrant with the
  fewest other options. Every entry converts at the release's rates, the
  two the Target setting tab shows: a pre-order's card is already
  authorised, so it has a rate of its own. Prices are the list prices the orders feed carries: a product
  without one takes the median of the others, with none at all the rule is
  fill alone, and when editions are not all known there is no room to judge,
  so the rule is plain units.

Inputs are aggregate PATTERNS - how many entrants share this combination of
open entries, unpaid wins, paid wins, pieces bought and maximum quantity - so
nothing here sees a person. Nothing is capped here: `allocated` is the demand
counted on a product, `room` (edition - sold) is what the card caps it
against, so oversubscription stays visible.
"""
from __future__ import annotations

import math
import re


def _finite(v) -> bool:
    try:
        return v is not None and not isinstance(v, bool) and math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _product_sets(products: list[dict]):
    by_draw: dict[str, int] = {}
    for i, p in enumerate(products):
        for d in p.get("draws") or []:
            by_draw[str(d)] = i

    def to_set(draws) -> list[int]:
        return sorted({by_draw[str(d)] for d in (draws or []) if str(d) in by_draw})
    return to_set


def allocate_entries(products: list[dict], patterns: list[dict], rate: float = 0.8,
                     preorder_rate: float | None = None) -> dict:
    n_products = len(products)
    r = float(rate) if _finite(rate) else 0.8
    # a pre-order entry has the card already authorised, so it converts at its
    # own rate: the release's, else the plain entry rate - one rate for every
    # product, the one the Target setting tab shows
    def _rate(v, fallback: float) -> float:
        return float(v) if _finite(v) and 0 < float(v) <= 1 else fallback
    pre_default = _rate(preorder_rate, r)
    pre_rates = [pre_default] * n_products
    # sold and drafts both take room out of the edition
    sold = [float(p.get("sold") or 0) + (float(p["drafts"]) if _finite(p.get("drafts")) else 0.0) for p in products]
    editions = [float(p["edition"]) if _finite(p.get("edition")) and float(p["edition"]) > 0 else None
                for p in products]
    by_fill = n_products > 0 and all(e is not None for e in editions)
    pinned = [0] * n_products
    fixed = [0] * n_products
    flexible = [0] * n_products
    # people with an entry in hand on each product, before the rule is applied
    open_people = [0] * n_products
    won_people = [0] * n_products
    to_set = _product_sets(products)

    # the units counted on a product: fixed and flexible entries. Unpaid wins
    # are tracked as `pinned` (they spend the winner's appetite) but count
    # nothing: a winner who has not paid is in the drafts when an advisor has
    # an order out for them, and nowhere otherwise
    def total(i: int) -> int:
        return fixed[i] + flexible[i]

    # the orders those entries are expected to become: each at its own rate,
    # so a product's prediction is the sum and not a count times one rate
    pred = [0.0] * n_products

    def fill(i: int) -> float:
        v = sold[i] + pred[i]
        return v / editions[i] if by_fill else v

    # list prices for the revenue rule: a product without one takes the median
    # of the others; with none at all every price is 0 and fill decides
    def price_of(p):
        return float(p["listPrice"]) if _finite(p.get("listPrice")) and float(p["listPrice"]) > 0 else None
    known = sorted(v for v in (price_of(p) for p in products) if v is not None)
    median_price = known[len(known) // 2] if known else 0.0
    prices = [price_of(p) if price_of(p) is not None else median_price for p in products]

    def has_room(i: int) -> bool:
        # the orders expected so far (sold, drafts, the entries counted at
        # their rates) are still short of the edition: another entrant is the
        # over-allocation that covers the payments expected to fail, and the
        # last one may take the product past its edition, where the card caps
        # the shown figure
        return sold[i] + pred[i] < editions[i] - 1e-9

    def better(i: int, best: int) -> bool:
        # where the next flexible unit goes: revenue first, then fill
        if by_fill:
            ri, rb = has_room(i), has_room(best)
            if ri != rb:
                return ri
            if ri and abs(prices[i] - prices[best]) > 1e-9:
                return prices[i] > prices[best]
        fi, fb = fill(i), fill(best)
        if abs(fi - fb) > 1e-12:
            return fi < fb
        ti, tb = total(i), total(best)
        if ti != tb:
            return ti < tb
        return i < best

    pre_sets: list[set] = []

    def rate_at(i: int, pre: set) -> float:
        return pre_rates[i] if i in pre else r

    entrants = flexible_entrants = surplus = uncapped = unpaid_winners = 0
    subs: list[dict] = []
    order = 0
    for pi, pat in enumerate(patterns):
        n = int(pat.get("n") or 0)
        if n <= 0:
            continue
        entrants += n
        won = to_set(pat.get("won"))
        sold_set = to_set(pat.get("sold"))
        pre_set = set(to_set(pat.get("pre")))
        while len(pre_sets) <= pi:
            pre_sets.append(set())
        pre_sets[pi] = pre_set
        won_set = set(won)
        open_ = [i for i in to_set(pat.get("open")) if i not in won_set and i not in sold_set]
        for i in open_:
            open_people[i] += n
        for i in won:
            won_people[i] += n
        cap = float(pat["max"]) if _finite(pat.get("max")) else None
        if cap is None:
            uncapped += n
        bought = float(pat.get("bought") or 0)
        appetite = math.inf if cap is None else max(cap - bought, 0)
        if won:
            unpaid_winners += n
        if len(won) <= appetite:
            for i in won:
                pinned[i] += n
            appetite -= len(won)
        else:
            subs.append({"options": won, "need": int(appetite), "n": n, "order": order, "pattern": pi, "kind": "pinned"})
            order += 1
            appetite = 0
        if not open_ or appetite <= 0:
            if open_ and appetite <= 0:
                surplus += n * len(open_)
            continue
        if appetite >= len(open_):
            for i in open_:
                fixed[i] += n
                pred[i] += n * rate_at(i, pre_set)
            continue
        flexible_entrants += n
        surplus += n * (len(open_) - int(appetite))
        subs.append({"options": open_, "need": int(appetite), "n": n, "order": order, "pattern": pi, "kind": "flexible"})
        order += 1

    def key_of(s: dict) -> str:
        return f"{s['pattern']}|{s['kind']}|{s['need']}|{','.join(map(str, s['options']))}"

    index = {key_of(s): s for s in subs}
    while True:
        best = -1
        for i in range(n_products):
            if not any(s["n"] > 0 and s["need"] > 0 and i in s["options"] for s in subs):
                continue
            if best < 0 or better(i, best):
                best = i
        if best < 0:
            break
        pick = None
        for s in subs:
            if s["n"] <= 0 or s["need"] <= 0 or best not in s["options"]:
                continue
            if (pick is None or len(s["options"]) < len(pick["options"])
                    or (len(s["options"]) == len(pick["options"])
                        and (s["pattern"] < pick["pattern"]
                             or (s["pattern"] == pick["pattern"] and s["order"] < pick["order"])))):
                pick = s
        pick["n"] -= 1
        if pick["kind"] == "pinned":
            pinned[best] += 1
        else:
            flexible[best] += 1
            pred[best] += rate_at(best, pre_sets[pick["pattern"]])
        rest = [i for i in pick["options"] if i != best]
        need = pick["need"] - 1
        if need > 0 and rest:
            nk = f"{pick['pattern']}|{pick['kind']}|{need}|{','.join(map(str, rest))}"
            nxt = index.get(nk)
            if nxt is None:
                nxt = {"options": rest, "need": need, "n": 0, "order": order, "pattern": pick["pattern"], "kind": pick["kind"]}
                order += 1
                index[nk] = nxt
                subs.append(nxt)
            nxt["n"] += 1

    out = []
    for i, p in enumerate(products):
        allocated = total(i)
        predicted = pred[i]
        room = None if editions[i] is None else max(editions[i] - sold[i], 0.0)
        shown = predicted if room is None else min(predicted, room)
        out.append({"key": p.get("key"), "allocated": allocated, "pinned": pinned[i], "fixed": fixed[i],
                    "flexible": flexible[i], "inHand": {"open": open_people[i], "won": won_people[i]},
                    "predicted": predicted, "shown": shown, "room": room,
                    "oversubscribed": 0.0 if room is None else max(predicted - room, 0.0)})
    return {"rate": r, "preorderRate": pre_default, "measure": "fill" if by_fill else "units", "products": out,
            "entrants": entrants, "flexibleEntrants": flexible_entrants, "surplusEntries": surplus,
            "uncapped": uncapped, "unpaidWinners": unpaid_winners}


def _r1(v: float) -> float:
    return round(v * 10) / 10


def _r4(v: float) -> float:
    return round(v * 10000) / 10000


def sell_through_products(products: list[dict], patterns: list[dict], rate: float = 0.8, edition=None,
                          sold_total=None, future_units: float = 0.0, expected_today=None,
                          benchmark_today=None, benchmark_close=None, preorder_rate=None) -> dict:
    """The per-product block the card reads (mirror of sellThroughProducts)."""
    attributed = sum(float(p.get("sold") or 0) for p in products)
    sold_all = max(float(sold_total), attributed) if _finite(sold_total) else attributed
    unattributed = max(sold_all - attributed, 0.0)
    editions = [float(p["edition"]) if _finite(p.get("edition")) and float(p["edition"]) > 0 else None
                for p in products]
    all_editions = len(products) > 0 and all(e is not None for e in editions)
    edition_sum = sum(editions) if all_editions else None
    # sales no product can be named for are split by edition size (by eligible
    # entrants until every edition is typed), as their own "assumed" segment
    weights = [editions[i] if all_editions else max(float(p.get("entrants") or 0), 0.0) for i, p in enumerate(products)]
    w_sum = sum(weights)
    assumed = [unattributed * (weights[i] / w_sum if w_sum > 0 else 1.0 / len(products)) if unattributed > 0 else 0.0
               for i in range(len(products))]
    with_assumed = [{**p, "sold": float(p.get("sold") or 0) + assumed[i]} for i, p in enumerate(products)]
    alloc = allocate_entries(with_assumed, patterns, rate, preorder_rate)
    future = max(float(future_units or 0), 0.0)
    room_after = [None if a["room"] is None else max(a["room"] - a["shown"], 0.0) for a in alloc["products"]]
    room_sum = sum(room_after) if all_editions else None
    def drafts_of(p):
        return float(p["drafts"]) if _finite(p.get("drafts")) else 0.0
    demand = [float(products[i].get("sold") or 0) + assumed[i] + drafts_of(products[i]) + a["shown"]
              for i, a in enumerate(alloc["products"])]
    demand_sum = sum(demand)
    future_share = []
    for i, a in enumerate(alloc["products"]):
        if all_editions:
            future_share.append(future * (room_after[i] / room_sum) if room_sum > 0 else 0.0)
        elif demand_sum > 0:
            future_share.append(future * (demand[i] / demand_sum))
        else:
            future_share.append(future / len(products) if products else 0.0)

    def pace_of(v):
        return float(v) / float(edition) if _finite(v) and _finite(edition) and float(edition) > 0 else None
    pace_exp, pace_bm_today, pace_bm_close = pace_of(expected_today), pace_of(benchmark_today), pace_of(benchmark_close)

    rows = []
    for i, p in enumerate(products):
        a = alloc["products"][i]
        s = float(p.get("sold") or 0)
        e = editions[i]
        today = s + assumed[i] + drafts_of(p) + a["shown"]
        close = today + future_share[i]
        rows.append({
            "key": p.get("key"), "name": p.get("name"), "draws": p.get("draws") or [], "edition": e,
            "entrants": p.get("entrants"), "inHand": a["inHand"],
            "sold": s, "soldAssumed": _r1(assumed[i]), "drafts": float(p["drafts"]) if _finite(p.get("drafts")) else None,
            "winnerDrafts": float(p["winnerDrafts"]) if _finite(p.get("winnerDrafts")) else None,
            "winnerDraftsLapsed": float(p["winnerDraftsLapsed"]) if _finite(p.get("winnerDraftsLapsed")) else None,
            "allocated": a["allocated"], "pinned": a["pinned"], "fixed": a["fixed"], "flexible": a["flexible"],
            "predicted": _r1(a["predicted"]), "shown": _r1(a["shown"]), "room": a["room"],
            "oversubscribed": _r1(a["oversubscribed"]),
            "futurePredicted": _r1(future_share[i]),
            "pct": _r4(min(today / e, 1.0)) if e else None,
            "pctClose": _r4(min(close / e, 1.0)) if e else None,
            "expectedToday": _r1(e * pace_exp) if e is not None and pace_exp is not None else None,
            "benchmarkToday": _r1(e * pace_bm_today) if e is not None and pace_bm_today is not None else None,
            "benchmarkClose": _r1(e * pace_bm_close) if e is not None and pace_bm_close is not None else None,
        })
    shown_sum = sum(x["shown"] for x in rows)
    future_sum = sum(x["futurePredicted"] for x in rows)
    ed = float(edition) if _finite(edition) and float(edition) > 0 else None
    drafts_all = sum(drafts_of(p) for p in products) if any(_finite(p.get("drafts")) for p in products) else None
    inventory_left = None if ed is None else max(ed - sold_all - (drafts_all or 0.0), 0.0)
    predicted_all = shown_sum if inventory_left is None else min(shown_sum, inventory_left)
    future_all = future_sum if inventory_left is None else min(future_sum, max(inventory_left - predicted_all, 0.0))
    return {
        "conversion": alloc["rate"], "measure": alloc["measure"],
        "products": rows,
        "attributedSold": attributed, "unattributedSold": unattributed, "drafts": drafts_all,
        "soldPredicted": _r1(predicted_all), "futureEntriesPredicted": _r1(future_all),
        "pct": None if ed is None else _r4(min((sold_all + (drafts_all or 0.0) + predicted_all + future_all) / ed, 1.0)),
        "editionSum": edition_sum,
        "editionMismatch": edition_sum is not None and ed is not None and round(edition_sum) != round(ed),
        "allocation": {
            "entrants": alloc["entrants"], "flexibleEntrants": alloc["flexibleEntrants"],
            "surplusEntries": alloc["surplusEntries"], "uncapped": alloc["uncapped"],
            "unpaidWinners": alloc["unpaidWinners"], "flexibleUnits": sum(x["flexible"] for x in rows),
        },
    }


_DEFAULT_NAME = re.compile(r"^Draw \d+$")


def _draft_count(r: dict) -> float:
    """A product's drafts as the card counts them: the draft lines a person
    raised that are not the payment step of a live entry - the way the sales
    team counts its own drafts."""
    return float(r.get("drafts") or 0)


def _cap_drafts(drafts: float, edition, sold: float) -> float:
    """Drafts never claim more than the room left on the product: offers out
    past the edition are offers, not sales in waiting."""
    if _finite(edition) and float(edition) > 0:
        return max(min(drafts, float(edition) - float(sold)), 0.0)
    return drafts


def attach_orders(products: list[dict], orders: dict | None, draw_products: dict | None, source: str,
                  orders_only: bool = False) -> tuple[list[dict], str]:
    """Sales and draft orders per product from the orders feed (docs #6.3;
    shared/sellThrough.mjs attachOrders is the same rule).

    `orders` is {product title: {unitsPaid, drafts, listPrice, edition}} and
    `draw_products` {draw id: product title}, the product a draw's winners
    bought. A product whose draws name a title takes that title's paid units
    as sold and its orders awaiting payment as drafts, and the title as its
    name where nobody typed one; a title already taken by an earlier product
    is not taken twice. Titles no draw names are added as products of their
    own only once every draw is named, because before that they are
    ambiguous and stay at release level. Returns the products and the sold
    source: "orders" once every product has its sales from the feed.

    `orders_only` when the page's units sold are the orders feed's over its
    window (docs 6.3): a product none of whose draws the feed names then
    takes no sales of its own rather than the event feed's winners who bought
    or tagged purchases, which are counted over all time on another basis;
    its units stay at release level with the rest of what no product is named
    for, so the rows add up to the page's units sold.
    """
    if not orders:
        # nothing paid on any title in the window: with the orders as the
        # page's units, no product has sales of its own to show
        return ([{**p, "sold": 0.0} for p in products] if orders_only else products), source
    dp = {str(k): v for k, v in (draw_products or {}).items()}
    used: set[str] = set()
    all_named = True
    out = []
    for p in products:
        titles = []
        for d in p.get("draws") or []:
            t = dp.get(str(d))
            if t and t in orders and t not in titles and t not in used:
                titles.append(t)
        if not titles:
            all_named = False
            q = dict(p)
            if orders_only:
                q["sold"] = 0.0
            out.append(q)
            continue
        used.update(titles)
        rows = [orders[t] for t in titles]
        q = dict(p)
        q["sold"] = float(sum(float(r.get("unitsPaid") or 0) for r in rows))
        q["drafts"] = float(sum(_draft_count(r) for r in rows))
        if not q.get("name") or _DEFAULT_NAME.match(str(q["name"])):
            q["name"] = " / ".join(titles)
        if not (_finite(q.get("edition")) and float(q["edition"]) > 0):
            eds = [float(r["edition"]) for r in rows if _finite(r.get("edition")) and float(r["edition"]) > 0]
            if eds and len(eds) == len(rows):
                q["edition"] = int(round(sum(eds)))
        q["drafts"] = _cap_drafts(q["drafts"], q.get("edition"), q["sold"])
        q["winnerDrafts"] = float(sum(float(r.get("winnerDrafts") or 0) for r in rows))
        q["winnerDraftsLapsed"] = float(sum(float(r.get("winnerDraftsLapsed") or 0) for r in rows))
        prices = [float(r["listPrice"]) for r in rows if _finite(r.get("listPrice"))]
        if prices:
            q["listPrice"] = max(prices)
        q["titles"] = titles
        out.append(q)
    if all_named:
        for t, r in orders.items():
            if t in used:
                continue
            if not (float(r.get("unitsPaid") or 0) > 0 or float(r.get("drafts") or 0) > 0):
                continue
            ed = int(round(float(r["edition"]))) if _finite(r.get("edition")) and float(r["edition"]) > 0 else None
            sold = float(r.get("unitsPaid") or 0)
            extra = {"key": f"p:{t}", "name": t, "edition": ed, "draws": [], "sold": sold,
                     "entrants": 0, "drafts": _cap_drafts(float(_draft_count(r)), ed, sold), "titles": [t]}
            if _finite(r.get("listPrice")):
                extra["listPrice"] = float(r["listPrice"])
            out.append(extra)
    return out, ("orders" if all_named else source)


def products_from_draws(draws: list[dict], configured, edition_size=None) -> tuple[list[dict], str]:
    """The products of a release from the draws the feed found and what was
    typed against them (mirror of productsFromDraws): one draw per product,
    draws with the same typed name merged, unnamed draws "Draw N" in
    first-entry order; sold from winners who bought, or from the purchases the
    feed tags with a draw where it does; a single unsized product takes the
    release's edition."""
    sorted_draws = sorted(draws or [], key=lambda d: (str(d.get("first") or ""), str(d.get("id"))))
    cfg = [c for c in (configured or []) if isinstance(c, dict)] if isinstance(configured, list) else []
    by_key = {str(c["key"]): c for c in cfg if c.get("key") not in (None, "")}
    legacy = [c for c in cfg if c.get("key") in (None, "")]
    tagged = any(float(d.get("purchaseUnits") or 0) > 0 for d in sorted_draws)
    groups: dict[str, dict] = {}
    for i, d in enumerate(sorted_draws):
        c = by_key.get(str(d.get("id")))
        if c is None and legacy:
            c = legacy.pop(0)
        name = (c.get("name").strip() if c and isinstance(c.get("name"), str) and c.get("name").strip() else None) or f"Draw {i + 1}"
        edition = int(round(float(c["edition"]))) if c and _finite(c.get("edition")) and float(c["edition"]) > 0 else None
        g = groups.get(name)
        if g is None:
            g = {"key": str(d.get("id")), "name": name, "edition": edition, "draws": [], "sold": 0,
                 "entrants": 0, "drafts": None}
            groups[name] = g
        if g["edition"] is None and edition is not None:
            g["edition"] = edition
        g["draws"].append(str(d.get("id")))
        g["sold"] += float(d.get("purchaseUnits") or 0) if tagged else float(d.get("sold") or 0)
        g["entrants"] += int(d.get("eligible") or 0)
    products = list(groups.values())
    if len(products) == 1 and products[0]["edition"] is None and _finite(edition_size) and float(edition_size) > 0:
        products[0]["edition"] = int(round(float(edition_size)))
    return products, ("purchases" if tagged else "winners")
