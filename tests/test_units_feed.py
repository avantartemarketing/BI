#!/usr/bin/env python3
"""Units from the orders table (docs 6.3): one count of units on every card.

A synthetic release is built with a funnel frame whose units deliberately
disagree with an injected units feed (sources/units_paid.csv, as
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

def frame(through):
    rows, rnd, d = [], random.Random(3), min(pr_open, announce) - timedelta(days=10)
    LL = (launch - announce).days
    while d <= through:
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in CH:
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
    return pd.DataFrame(rows)

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

def orders_record(drafts):
    prod = lambda paid: {"printsOffered": paid, "frames": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0,
                         "unitsPaid": paid, "drafts": drafts, "draftCustomers": None, "entryDrafts": 0.0,
                         "entrantDrafts": 0.0, "winnerDrafts": 0.0, "winnerDraftsLapsed": 0.0, "refunded": 0.0,
                         "fromDrafts": 0.0, "privateRoom": 0.0, "listPrice": 1000.0, "edition": None,
                         "lastOrder": None, "lastDraft": None}
    # the all-time figures: they include what was paid after the window
    return {"products": {"Work A": prod(24.0), "Work B": prod(18.0), "Work C": prod(0.0)}, "draws": {},
            "drafts": 3 * drafts, "unitsPaid": 42.0, "asOf": (launch + timedelta(days=30)).isoformat(),
            "campaignCode": None, "framing": {"prints": 42.0, "frames": 0.0, "notOffered": 0.0,
                                              "entrantPrints": 0.0, "entrantFrames": 0.0}}

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())
build.load_orders_feed()
tmp = pathlib.Path(tempfile.mkdtemp())
real_sources = build.SOURCES

def run(today, feed_rows, drafts=2.0, direct_spread=False):
    build.SOURCES = tmp
    for f in tmp.iterdir():
        f.unlink()
    if feed_rows is not None:
        write_feed(tmp, feed_rows)
    build._UNITS_FEED = None
    build._ORDERS_FEED[name] = orders_record(drafts)
    at = frame(today)
    snap = build.build_release(copy.deepcopy(base), at, spend_frame(today), emails, content, curves, today,
                               artist_posts, {}, None, panel, people, full_through=today, seen=1.0,
                               direct_spread=direct_spread)
    build.check_snapshot(snap)
    return snap, at

def paid_between(rows, a, b):
    return sum(u for d, _, _, _, u, _ in rows if a <= d <= b)

try:
    # 1. a live release: the units are the orders', over the window the first
    #    paid order opened, whatever the funnel counted
    today = announce + timedelta(days=8)
    live = [r for r in FEED if r[0] <= today]
    S, at = run(today, live)
    sw, st = S["salesWindow"], S["sellthrough"]
    want = paid_between(live, first_paid, today)
    check(S["unitsSource"] == "orders", f"the page counts the orders' units: {S['unitsSource']}")
    check(sw["start"] == first_paid.isoformat() and sw["firstPaid"] == first_paid.isoformat(),
          f"the first paid order opens the window: {sw}")
    check(sw["end"] == today.isoformat() and not sw["closed"], f"a live window runs to the as-of day: {sw}")
    check(close(st["sold"], want), f"the sell-through's paid units are the orders' in the window: {st['sold']} vs {want}")
    check(close(st["unitsPaidOrders"], want), f"and so are the products' units added up: {st['unitsPaidOrders']} vs {want}")
    check(st["unitsOutsideWindow"] == {"before": 2.0, "after": 0.0}, f"the order before the floor is outside: {st['unitsOutsideWindow']}")
    funnel_units = float(at[(at['event_date'] >= first_paid) & (at['event_date'] <= today)]["Total_Product_Units"].sum())
    check(abs(funnel_units - want) > 5, f"the funnel's own units differ, so the test means something: {funnel_units:.1f} vs {want}")
    check(close(S["hero"]["now"], st["sold"] + st["drafts"] + st["soldPredicted"], 1.0),
          f"the hero is the sell-through's count: {S['hero']['now']} vs {st['sold']} + {st['drafts']} + {st['soldPredicted']}")
    check(close(sum(c["now"] for c in S["channels"]), S["hero"]["now"], 1.5), "the channels add up to the hero")
    ne = S["untracked"]["noEvent"]
    check(ne["count"] == 3.0 and ne["total"] == want and ne["high"] is (3 / want > 0.05 and 3 >= 5),
          f"the paid units with no purchase event: {ne}")
    # the windowed record the sell-through and framing cards read (the
    # synthetic release names no draws, so the card does not carry it)
    ow = build.orders_in_window(name, build.units_rows(name), first_paid, today, False, "orders")
    check(set(ow["products"]) == {"Work A", "Work B", "Work C"} and ow["products"]["Work C"]["unitsPaid"] == 0.0,
          f"every title stays, at nothing paid in the window: {sorted(ow['products'])}")
    check(close(ow["unitsPaid"], want) and ow["products"]["Work A"]["drafts"] == 2.0,
          f"the record's paid units are the window's and a live page keeps its drafts: {ow['unitsPaid']}")
    oc = build.orders_in_window(name, build.units_rows(name), first_paid, today, True, "orders")
    check(all(p["drafts"] == 0.0 for p in oc["products"].values()) and oc["drafts"] == 0.0,
          "a shut window keeps no drafts")
    print(f"live: {want} units paid from {first_paid} (funnel said {funnel_units:.0f}), hero {S['hero']['now']}")

    # 2. the Direct switch moves units between channels and loses none
    D, _ = run(today, live, direct_spread=True)
    check(close(D["sellthrough"]["sold"], want) and close(sum(c["now"] for c in D["channels"]), D["hero"]["now"], 1.5),
          "with Direct spread the count and the roll-up hold")

    # 3. a closed window (two days past the close): the grace-day payment
    #    counts, the later one does not, and drafts and entries in hand no longer count
    shut = launch + timedelta(days=5)
    C, _ = run(shut, FEED)
    sw, st = C["salesWindow"], C["sellthrough"]
    want = paid_between(FEED, first_paid, launch + timedelta(days=2))
    check(sw["closed"] and sw["end"] == (launch + timedelta(days=2)).isoformat(), f"the window shut at the close plus two days: {sw}")
    check(close(st["sold"], want) and close(st["unitsPaidOrders"], want), f"paid in the window, grace included: {st['sold']} vs {want}")
    check(st["unitsOutsideWindow"] == {"before": 2.0, "after": 7.0}, f"the later payment is outside: {st['unitsOutsideWindow']}")
    check(st["drafts"] == 0 and st["soldPredicted"] == 0, f"nothing pending counts once the window has shut: {st['drafts']}, {st['soldPredicted']}")
    check(close(C["hero"]["now"], st["sold"], 0.51), f"the hero is the units paid: {C['hero']['now']} vs {st['sold']}")
    check(close(sum(c["now"] for c in C["channels"]), C["hero"]["now"], 1.5), "the channels add up to the units paid")
    print(f"closed: {want} units paid in the window, hero {C['hero']['now']}, outside {st['unitsOutsideWindow']}")

    # 4. no feed: the funnel's units, said so
    F, at = run(today, None)
    check(F["unitsSource"] == "funnel" and F["salesWindow"]["start"] == min(pr_open, announce).isoformat(),
          f"without the feed the page reads the funnel's units from the private room: {F['unitsSource']} {F['salesWindow']}")
    check("unitsOutsideWindow" not in F["sellthrough"], "and has no outside-window count")

    # 5. every unit on a channel with nothing to spread over still counts
    lone = pd.DataFrame([{"channel": "Untracked", "event_date": announce, "simple_release_name": name,
                          "Sessions_Total": 10.0, "Total_Product_Units": 4.0},
                         {"channel": "Direct", "event_date": announce, "simple_release_name": name,
                          "Sessions_Total": 30.0, "Total_Product_Units": 0.0}])
    folded = build.keep_units(build.redistribute_untracked(lone), 4.0)
    check(close(float(folded["Total_Product_Units"].sum()), 4.0, 1e-6), f"units kept when nothing tracked sold: {folded.to_dict('records')}")
finally:
    build.SOURCES = real_sources
    build._UNITS_FEED = None
    build._ORDERS_FEED.pop(name, None)
    shutil.rmtree(tmp, ignore_errors=True)

print(f"{failed} failure(s)" if failed else "ok: units from the orders feed")
sys.exit(1 if failed else 0)
