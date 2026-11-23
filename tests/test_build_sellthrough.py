#!/usr/bin/env python3
"""sellthrough_block (etl/build.py) with and without the products feed.

Imports the build module (which loads the repo's inputs and benchmarks) and
runs the block on made-up numbers, with the products feed swapped for a
synthetic one, so the snapshot shape the card reads is pinned down without a
funnel file.  python3 tests/test_build_sellthrough.py
"""
from __future__ import annotations

import contextlib
import io
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


NAME = "Test Artist · Multiple · 2026 Q3"
release = {"id": "test_le_26", "release_name": NAME, "edition_size": 300,
           "products": [{"key": "d1", "name": "Red", "edition": 100}, {"key": "d2", "name": "Blue", "edition": 200}]}

# 1. no feed: the release-level block as before, plus the rate
build._PRODUCTS_FEED = {}
st = build.sellthrough_block(release, NAME, units_sold=40, unconverted=100, inventory_left=260, future_entries=30,
                             expected_today=120, bm_today=90, bm_close=250)
check(st["conversion"] == 0.8, f"rate {st['conversion']}")
check(st["soldPredicted"] == 80.0 and st["futureEntriesPredicted"] == 30.0, f"release-level figures {st}")
check(abs(st["pct"] - 0.5) < 1e-9 and st["benchmarkUnits"] == 250.0, f"pct/benchmark {st}")
check("products" not in st and st["inHandUnits"] == 100.0, "no products without the feed")

# 2. with the feed: two draws, one flexible pattern
build._PRODUCTS_FEED = {NAME: {
    "draws": [{"id": "d1", "first": "2026-08-01", "last": "2026-08-20", "entrants": 60, "eligible": 58, "winners": 0,
               "sold": 0, "open": 58, "wonUnpaid": 0, "purchaseUnits": 0.0},
              {"id": "d2", "first": "2026-08-01", "last": "2026-08-20", "entrants": 30, "eligible": 30, "winners": 0,
               "sold": 0, "open": 30, "wonUnpaid": 0, "purchaseUnits": 0.0}],
    "entrants": 80, "eligible": 78, "allocated": False,
    "patterns": [{"open": ["d1"], "won": [], "sold": [], "bought": 0, "max": 1, "n": 48},
                 {"open": ["d2"], "won": [], "sold": [], "bought": 0, "max": 1, "n": 20},
                 {"open": ["d1", "d2"], "won": [], "sold": [], "bought": 0, "max": 1, "n": 10}],
}}
st = build.sellthrough_block(release, NAME, units_sold=40, unconverted=100, inventory_left=260, future_entries=30,
                             expected_today=120, bm_today=90, bm_close=250)
names = [p["name"] for p in st["products"]]
check(names == ["Red", "Blue"], f"products {names}")
red, blue = st["products"]
check(red["edition"] == 100 and blue["edition"] == 200, "editions from the inputs")
# Red is fuller (48 x 0.8 / 100) than Blue (20 x 0.8 / 200): the 10 flexible entrants go to Blue
check(red["allocated"] == 48 and blue["allocated"] == 30, f"allocation {red['allocated']}, {blue['allocated']}")
check(st["unattributedSold"] == 40.0 and st["attributedSold"] == 0, "nothing attributed by the feed, all 40 sold at release level")
check(red["expectedToday"] == 40.0 and blue["benchmarkToday"] == 60.0 and blue["benchmarkClose"] == round(200 * 250 / 300, 1),
      f"references at the release's pace {red['expectedToday']}, {blue['benchmarkToday']}, {blue['benchmarkClose']}")
check(st["soldPredicted"] == round(78 * 0.8, 1), f"headline is the per-product sum {st['soldPredicted']}")
check(st["allocation"]["flexibleEntrants"] == 10 and st["allocation"]["surplusEntries"] == 10, f"allocation stats {st['allocation']}")
check(st["editionSum"] == 300 and st["editionMismatch"] is False, "editions add up to the release")
check(len(st["patterns"]) == 3 and len(st["draws"]) == 2, "draws and patterns ride on the snapshot")

# 3. the typed rate wins, and a bad one falls back
st = build.sellthrough_block({**release, "entry_conversion_rate": 0.7}, NAME, 40, 100, 260, 30)
check(st["conversion"] == 0.7 and st["soldPredicted"] == round(78 * 0.7, 1), f"typed rate {st['conversion']} {st['soldPredicted']}")
st = build.sellthrough_block({**release, "entry_conversion_rate": "x"}, NAME, 40, 100, 260, 30)
check(st["conversion"] == 0.8, "a bad rate falls back to the panel's")

# 4. actuals-only: no edition, units mode, one product takes no edition either
st = build.sellthrough_block({"edition_size": None}, NAME, 40, 100, None)
check(st["pct"] is None and st["measure"] == "units" and st["products"][0]["edition"] is None, f"actuals-only {st['measure']}")

# 5. legacy typed products without keys map to the draws in order, and a
#    release whose draws are unnamed gets Draw 1, Draw 2
st = build.sellthrough_block({"edition_size": 300, "products": [{"name": "First", "edition": None}]}, NAME, 0, 0, 300)
check([p["name"] for p in st["products"]] == ["First", "Draw 2"], f"legacy names {[p['name'] for p in st['products']]}")
# 6. the orders feed names both draws: sold and drafts come from it, the stamp clears
build._ORDERS_FEED = {NAME: {
    "products": {"Red print": {"unitsPaid": 41, "drafts": 6, "draftCustomers": 6, "listPrice": 500, "edition": 100},
                 "Blue print": {"unitsPaid": 22, "drafts": 2, "draftCustomers": 2, "listPrice": 500, "edition": 200}},
    "draws": {"d1": "Red print", "d2": "Blue print"}, "drafts": 8.0, "unitsPaid": 63.0, "asOf": "2026-08-20",
}}
st = build.sellthrough_block(release, NAME, units_sold=40, unconverted=100, inventory_left=260, future_entries=30,
                             expected_today=120, bm_today=90, bm_close=250)
red, blue = st["products"]
check([p["name"] for p in st["products"]] == ["Red", "Blue"], "typed names stay")
check(red["sold"] == 41 and blue["sold"] == 22 and red["drafts"] == 6 and blue["drafts"] == 2, f"orders attached {red['sold']} {blue['drafts']}")
check(st["soldSource"] == "orders" and st["incomplete"] == [], f"stamp clears {st['soldSource']} {st['incomplete']}")
check(st["drafts"] == 8.0 and st["unitsPaidOrders"] == 63.0 and st["ordersAsOf"] == "2026-08-20", f"release-level orders {st['drafts']}")
check(st["attributedSold"] == 63 and st["unattributedSold"] == 0, f"the orders exceed the funnel's 40: nothing unattributed {st['unattributedSold']}")
check(st["ordersByProduct"]["Red print"]["unitsPaid"] == 41 and st["drawProducts"]["d2"] == "Blue print", "the feed rides on the snapshot")
# the card's Paid is what its rows add up to (63, not the funnel's 40), so
# the close headline and the hero's projection are one sum
check(st["sold"] == 63, f"Paid is the rows' paid units: {st['sold']}")
parts = build.spoken_for(st) + st["futureEntriesPredicted"]
check(abs(st["pct"] * 300 - min(parts, 300)) < 0.5, f"the close headline is the hero's sum: {st['pct']} x 300 vs {parts}")
# 6b. the Cattelan screenshot: the rows over their editions at close, and a
#     hero that stopped 23 short of the card's 100% because it added the
#     funnel's paid units to a room worked out from the orders'
st = build.sellthrough_block(release, NAME, units_sold=40, unconverted=100, inventory_left=260, future_entries=5000)
parts = build.spoken_for(st) + st["futureEntriesPredicted"]
check(st["pct"] == 1.0 and abs(parts - 300) < 0.5, f"at close both read the whole edition: pct {st['pct']}, parts {parts}")
snap = {"id": "t", "hero": {"now": round(build.spoken_for(st)), "projected": round(min(parts, 300))}, "sellthrough": st}
try:
    build.check_snapshot(snap)
except AssertionError as e:
    check(False, f"check_snapshot on the agreeing pair: {e}")
try:
    build.check_snapshot({**snap, "hero": {**snap["hero"], "projected": 277}})
    check(False, "check_snapshot lets a hero 23 short of the card's close through")
except AssertionError:
    pass

# 7. one draw unnamed: the stamp stays for sales by product and drafts
build._ORDERS_FEED[NAME]["draws"] = {"d1": "Red print"}
st = build.sellthrough_block(release, NAME, units_sold=40, unconverted=100, inventory_left=260, future_entries=30)
check(st["soldSource"] == "winners" and st["incomplete"] == ["sales by product", "draft orders"], f"partial feed {st['incomplete']}")
check(st["products"][0]["sold"] == 41 and st["products"][1]["drafts"] is None, "the named draw has its orders, the other does not")
build._ORDERS_FEED = {}

# 7b. names typed with no draw id, on draws the orders feed pairs with the
#     other way round (the Mondrian and James Jean inputs): position would
#     put "Red" on the draw that sold the blue print; each draw takes the
#     title its winners bought instead, and one typed against its draw id stands
build._ORDERS_FEED = {NAME: {
    "products": {"Red print": {"unitsPaid": 41, "drafts": 0, "listPrice": 500, "edition": 100},
                 "Blue print": {"unitsPaid": 22, "drafts": 0, "listPrice": 500, "edition": 200}},
    "draws": {"d1": "Blue print", "d2": "Red print"}, "drafts": 0.0, "unitsPaid": 63.0, "asOf": "2026-08-20",
}}
keyless = {"edition_size": 300, "products": [{"name": "Red", "edition": None}, {"name": "Blue", "edition": None}]}
st = build.sellthrough_block(keyless, NAME, 40, 100, 260, 30)
check([(p["name"], p["sold"]) for p in st["products"]] == [("Blue print", 22), ("Red print", 41)],
      f"keyless names never stand over the draws' products: {[(p['name'], p['sold']) for p in st['products']]}")
st = build.sellthrough_block({**keyless, "products": [{"key": "d2", "name": "Red"}, {"key": "d1", "name": "Blue"}]}, NAME, 40, 100, 260, 30)
check([(p["name"], p["sold"]) for p in st["products"]] == [("Blue", 22), ("Red", 41)],
      f"names typed against the draw ids stand: {[(p['name'], p['sold']) for p in st['products']]}")
check(build.product_name_warnings(st) == [], "the right names raise no warning")
build._ORDERS_FEED = {}

# 7c. the soft check: a row named for the work another draw sold is a warning
#     in the refresh log (the Mondrian rotation), never a failed build, and
#     short names, re-runs, unnamed draws and numbered works raise none
T1, T2, T3 = ("Tableau No.1 with Red, Blue, Yellow, Black, and Gray", "Composition with Red, Yellow, Black, Blue, and Gray",
              "Composition with Large Red Plane, Yellow, Black, Gray, and Blue")
pairs = {"a": T1, "b": T2, "c": T3}
rotated = {"products": [{"key": "a", "name": "Composition with Red, Yellow", "draws": ["a"]},
                        {"key": "b", "name": "Composition with Large Red Plane", "draws": ["b"]},
                        {"key": "c", "name": "Tableau no.1", "draws": ["c"]}], "drawProducts": pairs}
w = build.product_name_warnings(rotated)
check(len(w) == 3 and "'Tableau no.1' (draw c)" in w[2] and "which draw a sold" in w[2], f"the rotation is flagged: {w}")
right = {"products": [{"key": "a", "name": "Tableau no.1", "draws": ["a"]},
                      {"key": "b", "name": "Composition with Red, Yellow", "draws": ["b"]},
                      {"key": "c", "name": T3, "draws": ["c"]}], "drawProducts": pairs}
check(build.product_name_warnings(right) == [], "short names and titles on their own draws are fine")
quiet = [
    {"products": [{"name": "Castles I", "draws": ["a"]}, {"name": "Castles II", "draws": ["b"]}],
     "drawProducts": {"a": "Castles I", "b": "Castles II"}},                       # numbered works start each other
    {"products": [{"name": "Problem Painting", "draws": ["a"]}, {"name": "Draw 2", "draws": ["b"]}],
     "drawProducts": {"a": "Problem Painting", "b": "Problem Painting"}},          # a re-run, or a title taken
    {"products": [{"key": "p:Poster", "name": "Poster", "draws": []}], "drawProducts": {"a": "Poster print"}},
    {"products": [None, {"name": 5, "draws": ["a"]}, {"name": "Red"}], "drawProducts": None},
    {},
]
check(all(build.product_name_warnings(s) == [] for s in quiet), f"no warning on good data: {[build.product_name_warnings(s) for s in quiet]}")
log = io.StringIO()
try:
    with contextlib.redirect_stdout(log):
        build.check_snapshot({"id": "rotated", "hero": {}, "sellthrough": rotated})
except AssertionError as e:
    check(False, f"a naming warning stopped the build: {e}")
check(log.getvalue().count("check_snapshot warning: rotated: sell-through row") == 3, f"the warnings reach the log: {log.getvalue()!r}")

# 8. a target that is only part of the edition: the block reads the whole edition
st = build.sellthrough_block({**release, "edition_total": 900}, NAME, units_sold=40, unconverted=100, inventory_left=860, future_entries=30)
check(st["edition"] == 900, f"the whole edition on the block: {st['edition']}")
check(build.edition_total(release) == 300 and build.edition_total({**release, "edition_total": 200}) == 300, "no total, or one below the target, means the target")
check(build.edition_total({"edition_size": None}) is None, "no edition size, no total")

# 9. no draw in the event feed (a release selling in the private room before
#    its draw opens, the Pejac page of 23 November 2026): the rows are the
#    works the orders feed names, on its own paid units and drafts
build._PRODUCTS_FEED = {}
build._ORDERS_FEED = {NAME: {
    "products": {"Wire": {"unitsPaid": 2, "drafts": 0, "listPrice": 2800, "edition": 80},
                 "Wire [Special]": {"unitsPaid": 7, "drafts": 1, "listPrice": 3700, "edition": 20},
                 "Trip": {"unitsPaid": 4, "drafts": 0, "listPrice": 1800, "edition": 80},
                 "Trip [Special]": {"unitsPaid": 8, "drafts": 1, "listPrice": 3000, "edition": 20},
                 "Poster": {"unitsPaid": 0, "drafts": 0, "listPrice": 20, "edition": 500}},
    "draws": {}, "drafts": 2.0, "unitsPaid": 21.0, "asOf": "2026-11-21",
}}
pre = {"edition_size": 200}
st = build.sellthrough_block(pre, NAME, units_sold=21, unconverted=0, inventory_left=179, future_entries=100)
got = [(p["name"], p["sold"], p["drafts"], p["edition"]) for p in st.get("products") or []]
check(got == [("Wire", 2, 0, 80), ("Wire [Special]", 7, 1, 20), ("Trip", 4, 0, 80), ("Trip [Special]", 8, 1, 20)],
      f"a row per work the orders name, none for a work with nothing sold: {got}")
check(st["incomplete"] == [] and st["soldSource"] == "orders" and st["draws"] == [] and st["patterns"] == [],
      f"nothing is missing: {st.get('incomplete')}, {st.get('soldSource')}")
check(st["sold"] == 21 and st["drafts"] == 2 and st["soldPredicted"] == 0 and st["editionMismatch"] is False,
      f"the headline is the rows' sum: {st['sold']}, {st['drafts']}, {st['soldPredicted']}")
check(abs(sum(p["futurePredicted"] for p in st["products"]) - 100) < 0.2 and abs(st["pct"] - 123 / 200) < 1e-3,
      f"the units still to come are spread over the works: {[p['futurePredicted'] for p in st['products']]}, pct {st['pct']}")
check(all(p["futurePredicted"] <= p["edition"] - p["sold"] - p["drafts"] + 0.05 for p in st["products"]), "each held to its room")
# entries in hand but no draws to place them on (the event feed behind the
# funnel's): one row and the stamp, as before
st = build.sellthrough_block(pre, NAME, units_sold=21, unconverted=50, inventory_left=179, future_entries=100)
check("products" not in st and st["incomplete"] == ["products"] and st["soldPredicted"] == 40.0, f"entries in hand keep the release one row: {st}")
# nothing sold or drafted on any work yet: one row
build._ORDERS_FEED[NAME]["products"] = {"Poster": {"unitsPaid": 0, "drafts": 0, "listPrice": 20, "edition": 500}}
st = build.sellthrough_block(pre, NAME, units_sold=0, unconverted=0, inventory_left=200, future_entries=100)
check("products" not in st and st["incomplete"] == ["products"], "no work with a sale, no rows")
build._ORDERS_FEED = {}

# 10. the edition of a work Shopify names by its bare title and Airtable by a
#     bracketed variant: the variant the release's other titles leave over
import csv  # noqa: E402
import tempfile  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    data = pathlib.Path(d)
    with open(data / "release_pricing.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["airtable_id", "artist", "title", "release", "edition_size", "launch_date", "quarter"])
        w.writeheader()
        for i, (title, ed) in enumerate([("Barbed Wire [Special Print Edition]", 20), ("Barbed Wire [Standard Print Edition]", 80),
                                         ("Mind Trip [Red]", 30), ("Mind Trip [Blue]", 40), ("Mind Trip [Green]", 50)]):
            w.writerow({"airtable_id": i, "artist": "Test Artist", "title": title, "release": "TestLE26", "edition_size": ed,
                        "launch_date": "2026-12-18", "quarter": "2026 Q4"})
    keep = build.DATA, build._PRODUCT_EDITIONS
    build.DATA, build._PRODUCT_EDITIONS = data, None
    try:
        ed = build.product_editions()
        REL4 = "Test Artist · Multiple · 2026 Q4"
        sib = ["BARBED WIRE", "BARBED WIRE [Special Print Edition]", "MIND TRIP", "MIND TRIP [Red]"]
        check(ed(REL4, "BARBED WIRE [Special Print Edition]", sib) == 20, "a title Airtable has reads its own row")
        check(ed(REL4, "BARBED WIRE", sib) == 80, f"the bare title reads the variant left over: {ed(REL4, 'BARBED WIRE', sib)}")
        check(ed(REL4, "BARBED WIRE") is None, "two variants and no sibling to tell them apart: no edition")
        check(ed(REL4, "MIND TRIP", sib) is None, "two variants left over: no edition")
        check(ed(REL4, "Something Else", sib) is None, "no row, no edition")
    finally:
        build.DATA, build._PRODUCT_EDITIONS = keep

print("ok: build sell-through block" if not failed else f"{failed} failure(s)")
sys.exit(1 if failed else 0)
