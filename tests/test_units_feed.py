#!/usr/bin/env python3
"""Units from the orders table (docs 6.3): one count of units on every card.

A synthetic release is built with a funnel frame whose units deliberately
disagree with an injected units feed (data/units_paid.csv, as
server/bigquery.js unitsPaidSql writes it). The page must count the feed's
units, on each order's own channel, over one window on every card: opened by
the first paid order when it came before the private room (never more than
45 days before the announce), shut two days after the close. Once the
window has shut, drafts and entries in hand stop counting. With no feed the
page reads the funnel's units, as before.
python3 tests/test_units_feed.py (needs pandas)"""
import sys, json, pathlib, random, copy, tempfile, shutil
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["release_name"] = "Synthetic Artist · Synthetic Units · 2026 Q3"
base["campaign_name"] = "Synthetic · Enter draw"
base["campaign_names"] = [base["campaign_name"]]
announce, launch = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
pr_open = date.fromisoformat(base["private_room_open"])
name = base["release_name"]
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Direct", 200, 0.8),
      ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)
close = lambda a, b, tol=0.51: a is not None and b is not None and abs(a - b) <= tol

def frame(through, channels=CH, entries=True):
    rows, rnd, d = [], random.Random(3), min(pr_open, announce) - timedelta(days=10)
    LL = (launch - announce).days
    while d <= through:
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in channels:
            ent = ent if entries else 0.0
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": sess * (1 + 0.1 * rnd.random()),
                         # the funnel's own units: deliberately not the orders'
                         "Total_Product_Units": ent * 0.9, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": ent * 0.7, "Draw_Entries_Eligible_Units": ent,
                         "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(through):
    rows, d = [], announce
    while d <= through:
        rows.append({"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 500.0})
        d += timedelta(days=1)
    return pd.DataFrame(rows, columns=["campaign_name", "spend_date", "impressions", "reach", "link_clicks", "spend"])

# the units feed: paid units per product x CET day x channel, each order on its
# purchase event's channel; Untracked with no purchase event where the funnel
# never saw the order
first_paid = pr_open - timedelta(days=3)
FEED = [
    # (day, product, channel, purchase_event, units, private_room)
    (announce - timedelta(days=60), "Work A", "AA Email Man", True, 2, 0),    # before the 45-day floor: outside
    (first_paid, "Work A", "AA Email Man", True, 5, 5),                        # opens the window
    (pr_open, "Work B", "AA Email Man", True, 4, 4),
    (announce, "Work A", "Paid Social", True, 8, 0),                           # an order of several units
    (announce + timedelta(days=2), "Work B", "Direct", True, 4, 0),
    (announce + timedelta(days=3), "Work A", "Untracked", False, 3, 0),        # no purchase event
    (announce + timedelta(days=4), "Work B", "Untracked", True, 2, 0),         # an event with no channel
    (announce + timedelta(days=5), "Work B", "Someone Else's Channel", True, 1, 0),   # unknown label: Untracked
    (launch + timedelta(days=1), "Work A", "AA Email Man", True, 6, 0),        # a winner paying in the grace
    (launch + timedelta(days=5), "Work B", "Direct", True, 7, 0),              # after the grace: outside
]
def write_feed(folder, rows):
    lines = ["release,product_title,order_date,channel,purchase_event,units_paid,units_private_room,prints_offered_paid,frames_paid"]
    for d, t, ch, ev, u, prm in rows:
        lines.append(f"{name},{t},{d.isoformat()},{ch},{'true' if ev else 'false'},{u},{prm},{u},0")
    (folder / "units_paid.csv").write_text("\n".join(lines) + "\n")

def orders_record(drafts, paid):
    prod = lambda paid: {"printsOffered": paid, "frames": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0,
                         "unitsPaid": paid, "drafts": drafts, "draftCustomers": None, "entryDrafts": 0.0,
                         "entrantDrafts": 0.0, "winnerDrafts": 0.0, "winnerDraftsLapsed": 0.0, "refunded": 0.0,
                         "fromDrafts": 0.0, "privateRoom": 0.0, "listPrice": 1000.0, "edition": None,
                         "lastOrder": None, "lastDraft": None}
    # the all-time figures, from the same pull as the units feed: they add
    # up to its units, including what was paid outside the window
    a = sum(u for _, t, _, _, u, _ in paid if t == "Work A")
    b = sum(u for _, t, _, _, u, _ in paid if t == "Work B")
    return {"products": {"Work A": prod(float(a)), "Work B": prod(float(b)), "Work C": prod(0.0)}, "draws": {},
            "drafts": 3 * drafts, "unitsPaid": float(a + b), "asOf": (launch + timedelta(days=30)).isoformat(),
            "campaignCode": None, "framing": {"prints": float(a + b), "frames": 0.0, "notOffered": 0.0,
                                              "entrantPrints": 0.0, "entrantFrames": 0.0}}

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())
build.load_orders_feed()
tmp = pathlib.Path(tempfile.mkdtemp())
real_units = build.UNITS_FILE

def run(today, feed_rows, drafts=2.0, direct_spread=False, at=None, both=False):
    """Build the synthetic page as main() does: check_snapshot runs on it
    (and, with both, on its Direct-spread view too)."""
    build.UNITS_FILE = tmp / "units_paid.csv"
    for f in tmp.iterdir():
        f.unlink()
    if feed_rows is not None:
        write_feed(tmp, feed_rows)
    build._UNITS_FEED = None
    build._ORDERS_FEED[name] = orders_record(drafts, feed_rows or [])
    at = frame(today) if at is None else at
    args = (copy.deepcopy(base), at, spend_frame(today), emails, content, curves, today,
            artist_posts, {}, None, panel, people)
    kw = dict(full_through=today, seen=1.0)
    snap = (build.with_direct_spread(build.build_release, *args, **kw) if both
            else build.build_release(*args, **kw, direct_spread=direct_spread))
    build.check_snapshot(snap)
    return snap, at

def folded_by_group(rows, a, b):
    """The feed's units in [a, b] per display group, after the Untracked fold
    the page applies (the fold of units reads only the units rows)."""
    f = pd.DataFrame([{"channel": ch, "event_date": d, "Total_Product_Units": float(u)}
                      for d, _, ch, _, u, _ in rows if a <= d <= b])
    f["channel"] = f["channel"].where(f["channel"].isin(list(build.GROUP_OF) + ["Untracked"]), "Untracked")
    f = build.redistribute_untracked(f)
    return f.assign(group=f["channel"].map(build.GROUP_OF)).groupby("group")["Total_Product_Units"].sum().to_dict()

def paid_between(rows, a, b):
    return sum(u for d, _, _, _, u, _ in rows if a <= d <= b)

try:
    # 1. a live release: the units are the orders', over the window the first
    #    paid order opened, whatever the funnel counted; an order paid after
    #    the as-of day (the orders pull ahead of the funnel) waits for the
    #    next build and is not "after the window"
    today = announce + timedelta(days=8)
    live = [r for r in FEED if r[0] <= today] + [(today + timedelta(days=1), "Work A", "Direct", True, 3, 0)]
    S, at = run(today, live, both=True)
    sw, st = S["salesWindow"], S["sellthrough"]
    want = paid_between(live, first_paid, today)
    check(S["unitsSource"] == "orders", f"the page counts the orders' units: {S['unitsSource']}")
    check(sw["start"] == first_paid.isoformat() and sw["firstPaid"] == first_paid.isoformat(),
          f"the first paid order opens the window: {sw}")
    check(sw["end"] == today.isoformat() and not sw["closed"], f"a live window runs to the as-of day: {sw}")
    check(close(st["sold"], want), f"the sell-through's paid units are the orders' in the window: {st['sold']} vs {want}")
    check(close(st["unitsPaidOrders"], want), f"and so are the products' units added up: {st['unitsPaidOrders']} vs {want}")
    check(st["unitsOutsideWindow"] == {"before": 2.0, "after": 0.0, "pending": 3.0},
          f"before the floor is outside, after the as-of day is pending: {st['unitsOutsideWindow']}")
    funnel_units = float(at[(at['event_date'] >= first_paid) & (at['event_date'] <= today)]["Total_Product_Units"].sum())
    check(abs(funnel_units - want) > 5, f"the funnel's own units differ, so the test means something: {funnel_units:.1f} vs {want}")
    check(close(S["hero"]["now"], st["sold"] + st["drafts"] + st["soldPredicted"], 1.0),
          f"the hero is the sell-through's count: {S['hero']['now']} vs {st['sold']} + {st['drafts']} + {st['soldPredicted']}")
    check(close(sum(c["now"] for c in S["channels"]), S["hero"]["now"], 1.5), "the channels add up to the hero")
    trail = sum(next(r["actual"] for r in reversed(c["daily"]) if r["actual"] is not None) for c in S["channels"])
    check(close(trail, S["hero"]["now"], 1.5), f"the trajectory ends at the hero: {trail} vs {S['hero']['now']}")
    v = S["variants"]["direct_spread"]
    check(close((v.get("sellthrough") or st)["sold"], want), "the Direct view counts the same units paid")
    ne = S["untracked"]["noEvent"]
    check(ne["count"] == 3.0 and ne["total"] == want and ne["high"] is False,
          f"the paid units with no purchase event, under the warning: {ne}")
    # the windowed record the sell-through and framing cards read (the
    # synthetic release names no draws, so the card does not carry it)
    ow = build.orders_in_window(name, build.units_rows(name), first_paid, today, False, "orders")
    check(set(ow["products"]) == {"Work A", "Work B", "Work C"} and ow["products"]["Work C"]["unitsPaid"] == 0.0,
          f"every title stays, at nothing paid in the window: {sorted(ow['products'])}")
    check(close(ow["unitsPaid"], want) and ow["products"]["Work A"]["drafts"] == 2.0 and ow["windowed"],
          f"the record's paid units are the window's and a live page keeps its drafts: {ow['unitsPaid']}")
    check(close(ow["framing"]["prints"], want), f"the framing's prints are the window's: {ow['framing']['prints']}")
    oc = build.orders_in_window(name, build.units_rows(name), first_paid, today, True, "orders")
    check(all(p["drafts"] == 0.0 for p in oc["products"].values()) and oc["drafts"] == 0.0,
          "a shut window keeps no drafts")
    print(f"live: {want} units paid from {first_paid} (funnel said {funnel_units:.0f}), hero {S['hero']['now']}")

    # 2. the no-purchase-event warning fires when it should: 6 of 30 units
    noisy = [r for r in live if r[0] <= today] + [(announce + timedelta(days=6), "Work A", "Untracked", False, 3, 0)]
    N, _ = run(today, noisy)
    ne = N["untracked"]["noEvent"]
    check(ne["count"] == 6.0 and ne["high"] is True, f"six units of thirty with no purchase event warn: {ne}")

    # 3. a closed window (two days past the close): the grace-day payment
    #    counts, the later one does not, drafts and entries in hand no longer
    #    count, and every channel reads its own units paid
    shut = launch + timedelta(days=5)
    C, _ = run(shut, FEED, both=True)
    sw, st = C["salesWindow"], C["sellthrough"]
    grace = launch + timedelta(days=2)
    want = paid_between(FEED, first_paid, grace)
    check(sw["closed"] and sw["end"] == grace.isoformat(), f"the window shut at the close plus two days: {sw}")
    check(close(st["sold"], want) and close(st["unitsPaidOrders"], want), f"paid in the window, grace included: {st['sold']} vs {want}")
    check(st["unitsOutsideWindow"] == {"before": 2.0, "after": 7.0, "pending": 0.0}, f"the later payment is outside: {st['unitsOutsideWindow']}")
    check(st["drafts"] == 0 and st["soldPredicted"] == 0, f"nothing pending counts once the window has shut: {st['drafts']}, {st['soldPredicted']}")
    check(close(C["hero"]["now"], st["sold"], 0.51), f"the hero is the units paid: {C['hero']['now']} vs {st['sold']}")
    exp = folded_by_group(FEED, first_paid, grace)
    for c in C["channels"]:
        check(close(c["now"], exp.get(c["key"], 0.0), 0.15), f"{c['key']} reads its own units paid: {c['now']} vs {exp.get(c['key'], 0.0):.1f}")
    check(close(C["paid"]["unitsToDate"], exp.get("paid", 0.0), 0.15), f"the paid card reads paid's units: {C['paid']['unitsToDate']}")
    print(f"closed: {want} units paid in the window, hero {C['hero']['now']}, by group "
          f"{ {c['key']: c['now'] for c in C['channels']} }, outside {st['unitsOutsideWindow']}")

    # 4. no feed: the funnel's units, said so; after the close, the funnel's
    #    page keeps the same rule: no drafts, no entries in hand
    F, at = run(today, None)
    check(F["unitsSource"] == "funnel" and F["salesWindow"]["start"] == min(pr_open, announce).isoformat(),
          f"without the feed the page reads the funnel's units from the private room: {F['unitsSource']} {F['salesWindow']}")
    check("unitsOutsideWindow" not in F["sellthrough"], "and has no outside-window count")
    G, _ = run(shut, None)
    gst = G["sellthrough"]
    check(gst["drafts"] == 0 and gst["soldPredicted"] == 0 and close(G["hero"]["now"], gst["sold"], 0.51),
          f"a shut page on the funnel's units counts what was paid only: {gst['sold']} + {gst['drafts']}, hero {G['hero']['now']}")

    # 5. the funnel has no rows for the release yet and every unit paid has no
    #    purchase event: the fold has nothing to spread over, the units stay
    pr_only = [(pr_open, "Work A", "Untracked", False, 5, 5)]
    E, _ = run(pr_open + timedelta(days=2), pr_only, at=frame(pr_open + timedelta(days=2)).iloc[0:0], both=True)
    check(close(E["sellthrough"]["sold"], 5.0) and close(sum(c["now"] for c in E["channels"]), E["hero"]["now"], 1.0)
          and E["hero"]["now"] >= 5.0 - 0.5, f"units with nowhere to go still count: sold {E['sellthrough']['sold']}, hero {E['hero']['now']}")

    # 6. every row on Direct and the Direct switch on: nothing to spread
    #    over, and the switch's view counts the same units
    direct_only = [(announce + timedelta(days=1), "Work B", "Direct", True, 3, 0)]
    X, _ = run(today, direct_only, at=frame(today, channels=[("Direct", 200, 0.8)]), both=True)
    xv = X["variants"].get("direct_spread") or {}
    check(close(X["sellthrough"]["sold"], 3.0) and close((xv.get("sellthrough") or X["sellthrough"])["sold"], 3.0)
          and close(sum(c["now"] for c in (xv.get("channels") or X["channels"])), (xv.get("hero") or X["hero"])["now"], 1.0),
          "a Direct-only window counts its units with the switch on")

    # 7. drafts out, nothing paid and no entries yet: the hero still counts
    #    the drafts, on the channels
    Z, _ = run(announce + timedelta(days=1), None, drafts=2.0, at=frame(announce + timedelta(days=1), entries=False))
    zst = Z["sellthrough"]
    check(zst["drafts"] > 0 and close(Z["hero"]["now"], zst["sold"] + zst["drafts"] + zst["soldPredicted"], 1.0)
          and close(sum(c["now"] for c in Z["channels"]), Z["hero"]["now"], 1.0),
          f"drafts with nothing paid reach the hero and the channels: {zst['drafts']}, hero {Z['hero']['now']}")

    # 8. every unit on a channel with nothing to spread over still counts
    lone = pd.DataFrame([{"channel": "Untracked", "event_date": announce, "simple_release_name": name,
                          "Sessions_Total": 10.0, "Total_Product_Units": 4.0},
                         {"channel": "Direct", "event_date": announce, "simple_release_name": name,
                          "Sessions_Total": 30.0, "Total_Product_Units": 0.0}])
    folded = build.keep_units(build.redistribute_untracked(lone), 4.0, lone)
    check(close(float(folded["Total_Product_Units"].sum()), 4.0, 1e-6), f"units kept when nothing tracked sold: {folded.to_dict('records')}")
    empty = build.keep_units(build.redistribute_untracked(lone.iloc[:1]), 4.0, lone.iloc[:1])
    check(close(float(empty["Total_Product_Units"].sum()), 4.0, 1e-6) and set(empty["channel"]) == {"Other"},
          f"and when the fold leaves nothing, on Other: {empty.to_dict('records')}")

    # 9. the units file out of step with the orders file (a deploy's copy
    #    beside a fresh one): that release reads the funnel's units
    build.UNITS_FILE = tmp / "units_paid.csv"
    write_feed(tmp, live)
    build._UNITS_FEED = None
    build._ORDERS_FEED[name] = orders_record(2.0, live[:-2])
    check(build.units_rows(name) is None and name in build.UNITS_FEED_INFO.get("outOfStep", []),
          f"a release whose two files disagree falls back: {build.UNITS_FEED_INFO.get('outOfStep')}")
    # 10. a catalogue page (no campaign clock) whose release has no row in
    #     the orders feed, with a draw in the event feed that counted
    #     purchases: its 90 days are all in the orders feed, so it sold
    #     nothing in them, on every card, and the draw's own count does not
    #     stand in for sales
    import numpy as np
    old, other = "Synthetic Old Artist · Old Work · 2024 Q1", "Synthetic Other · Work · 2026 Q3"
    cat_day = date(2026, 9, 20)
    crow, d = [], cat_day - timedelta(days=200)
    while d <= cat_day:
        for ch in ("Direct", "AA Email Man"):
            crow.append({"channel": ch, "event_date": d, "simple_release_name": old, "campaign_stage": None,
                         "Sessions_Total": 5.0, "Total_Product_Units": 1.0 if (d == cat_day - timedelta(days=10) and ch == "Direct") else 0.0,
                         "Product_Units_Private_Room": 0.0, "Draw_Entries_Total_Units_No_Conv": 0.0, "Draw_Entries_Eligible_Units": 0.0,
                         "days_since_announcement": np.nan, "days_until_launch": np.nan,
                         "pct_days_since_announcement": np.nan, "pct_days_until_launch": np.nan})
        d += timedelta(days=1)
    cat = pd.DataFrame(crow)
    crec = build.discover_releases(cat, cat_day, set())[0]
    crec["campaign_name"] = None
    (tmp / "units_paid.csv").write_text(
        "release,product_title,order_date,channel,purchase_event,units_paid,units_private_room,prints_offered_paid,frames_paid\n"
        f"{other},W,{(cat_day - timedelta(days=3)).isoformat()},Direct,true,2,0,2,0\n")
    build.UNITS_FILE = tmp / "units_paid.csv"
    build._UNITS_FEED = None
    build._ORDERS_FEED[other] = {"products": {"W": {"unitsPaid": 2.0, "drafts": 0.0}}, "draws": {}, "drafts": 0.0,
                                 "unitsPaid": 2.0, "asOf": None, "campaignCode": None,
                                 "framing": {"prints": 2.0, "frames": 0.0, "notOffered": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0}}
    build.load_products_feed()
    build._PRODUCTS_FEED[old] = {
        "draws": [{"id": "d1", "first": "2024-01-10", "last": "2024-01-20", "entrants": 40, "eligible": 38, "winners": 12,
                   "sold": 12, "open": 0, "wonUnpaid": 0, "purchaseUnits": 12.0}],
        "entrants": 40, "eligible": 38, "allocated": True, "patterns": []}
    no_spend = pd.DataFrame(columns=["campaign_name", "spend_date", "spend", "impressions", "reach", "link_clicks"])
    K = build.with_direct_spread(build.build_actuals, crec, cat, no_spend, emails, content, cat_day)
    try:
        build.check_snapshot(K)
        ok = True
    except AssertionError as e:
        ok = False
        check(False, f"the catalogue page passes the build's checks: {e}")
    kst = K["sellthrough"]
    check(ok and K["unitsSource"] == "orders" and kst["sold"] == 0 and K["hero"]["now"] == 0
          and all(p["sold"] == 0 for p in kst.get("products") or []),
          f"a catalogue page with no orders row sold nothing: {K['unitsSource']} sold {kst['sold']} hero {K['hero']['now']}")
    build._ORDERS_FEED.pop(other, None)
    build._PRODUCTS_FEED.pop(old, None)
finally:
    build.UNITS_FILE = real_units
    build._UNITS_FEED = None
    build._ORDERS_FEED.pop(name, None)
    shutil.rmtree(tmp, ignore_errors=True)

print(f"{failed} failure(s)" if failed else "ok: units from the orders feed")
sys.exit(1 if failed else 0)
