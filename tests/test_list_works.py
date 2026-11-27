#!/usr/bin/env python3
"""A launch's works by their Airtable names from its first day (docs 6.3):
list_works (etl/sellthrough.py) laid over what the sell-through's rule reads,
draw_works (etl/build.py) picking the works from Airtable's products, and
sellthrough_block with them, on made-up launches shaped like the ones the
rule was written for.  python3 tests/test_list_works.py (needs pandas)
"""
from __future__ import annotations

import copy
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402
from sellthrough import attach_orders, list_works, products_from_draws  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def rows(draws, typed, pairs, orders, works, skus=None, edition=None):
    """The rule's rows with the works laid over its inputs."""
    cfg, dp, by, unplaced = list_works(draws, typed, pairs, orders, works, skus)
    products, source = products_from_draws(draws, cfg, edition, dp)
    if by:
        products, source = attach_orders(products, by, dp, source)
    return products, source, unplaced


RED = {"name": "(RED)", "edition": 50, "sku": "HMIL1-REDDD-PE"}
STAR = {"name": "Star", "edition": 50, "sku": "HMIL1-STARR-PE"}
WORKS = [STAR, RED]   # the order Airtable made them in
SKUS = {"(RED)": ["HMIL1-REDDD-PE-PRIVATE", "HMIL1-REDDD-PE-PREORDER", "HMIL1-REDDD-PE-DRAW"], "Star": ["HMIL1-STARR-PE-PREORDER"]}
D1 = {"id": "draw_1", "first": "2026-11-25", "eligible": 1, "sold": 0}
D2 = {"id": "draw_2", "first": "2026-11-25", "eligible": 2, "sold": 0}


def named(products):
    return [(p["name"], p.get("edition"), p.get("sold"), p.get("drafts"), list(p.get("draws") or [])) for p in products]


# ---- 1. before a draw has an entry: the works are the rows, by name, with what has sold so far
orders = {"(RED)": {"unitsPaid": 4, "drafts": 0, "listPrice": 2500, "edition": 50}}
products, source, unplaced = rows([], [], {}, orders, WORKS, SKUS)
check(named(products) == [("(RED)", 50, 4, 0, []), ("Star", 50, 0, 0, [])] and source == "orders" and unplaced is None,
      f"a launch whose draws have not opened lists its works: {named(products)} {source}")
# and with no order line at all yet, under Airtable's names
products, source, _ = rows([], [], {}, None, WORKS)
check(named(products) == [("Star", 50, 0, 0, []), ("(RED)", 50, 0, 0, [])] and source == "orders",
      f"nothing sold and nothing drawn: the works in the order Airtable made them {named(products)}")
check(all(p["key"] == f"p:{p['name']}" and p["entrants"] == 0 for p in products), "rows of their own, with no draw yet")

# ---- 2. the feed's row is found by the SKU, whatever each side calls the work
shop = {"Toy Brick Left Hand (Blue)": {"unitsPaid": 66, "drafts": 1, "listPrice": 900, "edition": None}}
air = [{"name": "Toy Brick Middle Finger (Blue)", "edition": 750, "sku": "AWEI4-LEGOB-SE"}]
products, _, _ = rows([], [], {}, shop, air, {"Toy Brick Left Hand (Blue)": ["AWEI4-LEGOB-SE-PRIVATE", "AWEI4-LEGOB-SE-DRAW"]})
check(named(products) == [("Toy Brick Left Hand (Blue)", 750, 66, 1, [])],
      f"one row, under the shop's name, with Airtable's edition where the feed had none: {named(products)}")
# a SKU that only starts the same is another work's
products, _, _ = rows([], [], {}, {"Art is Life 10": {"unitsPaid": 3, "drafts": 0, "edition": 10}},
                      [{"name": "Art is Life", "edition": 100, "sku": "AWEI3-ARTL1-PE"}], {"Art is Life 10": ["AWEI3-ARTL10-PE-DRAW"]})
check([p["name"] for p in products] == ["Art is Life 10", "Art is Life"], f"ARTL1 is not ARTL10: {[p['name'] for p in products]}")
# with no SKU on either side the title finds it, case and spacing aside, and never a title that only starts the same
products, _, _ = rows([], [], {}, {"Star": {"unitsPaid": 2, "drafts": 0, "edition": None}, "Castles II": {"unitsPaid": 1, "drafts": 0, "edition": 40}},
                      [{"name": "STAR", "edition": 50}, {"name": "Castles  I", "edition": 30}])
check(named(products) == [("Star", 50, 2, 0, []), ("Castles II", 40, 1, 0, []), ("Castles  I", 30, 0, 0, [])],
      f"titles match whole: {named(products)}")
# an edition the feed already has stands
products, _, _ = rows([], [], {}, {"Star": {"unitsPaid": 2, "drafts": 0, "edition": 60}}, [STAR])
check(products[0]["edition"] == 60, "the feed's own edition is kept")

# ---- 3. one draw the feed has not paired, one work with no draw: that work is the draw's
orders = {"(RED)": {"unitsPaid": 4, "drafts": 0, "edition": 50}, "Star": {"unitsPaid": 0, "drafts": 1, "edition": 50}}
products, source, unplaced = rows([D1, D2], [], {"draw_2": "(RED)"}, orders, WORKS, SKUS)
check(named(products) == [("Star", 50, 0, 1, ["draw_1"]), ("(RED)", 50, 4, 0, ["draw_2"])] and source == "orders" and unplaced is None,
      f"the last draw takes the last work: {named(products)}")

# ---- 4. first entries the feed cannot place: the draws and their works share a row, nothing is guessed
products, source, unplaced = rows([D1, D2], [], {}, orders, WORKS, SKUS)
check(named(products) == [("Star / (RED)", 100, 4, 1, ["draw_1", "draw_2"])] and source == "orders",
      f"two draws, two works, no pairing yet: one row for both {named(products)}")
check(unplaced == {"draws": ["draw_1", "draw_2"], "works": ["Star", "(RED)"]}, f"and what was not placed is said: {unplaced}")
check(products[0]["entrants"] == 3 and products[0]["titles"] == ["Star / (RED)"], "the row carries both draws' entries")
# one draw has entries, two works have no draw: the draw is one of the two
products, _, unplaced = rows([D2], [], {}, orders, WORKS, SKUS)
check(named(products) == [("Star / (RED)", 100, 4, 1, ["draw_2"])] and unplaced == {"draws": ["draw_2"], "works": ["Star", "(RED)"]},
      f"one draw, two works: {named(products)}")
# a third work the feed has paired keeps its own row, and a stray title with sales its own too
three = {**orders, "Moon": {"unitsPaid": 7, "drafts": 0, "edition": 20}, "Poster": {"unitsPaid": 2, "drafts": 0, "edition": None}}
D3 = {"id": "draw_3", "first": "2026-11-26", "eligible": 9, "sold": 0}
products, _, unplaced = rows([D1, D2, D3], [], {"draw_3": "Moon"}, three, WORKS + [{"name": "Moon", "edition": 20}], SKUS)
check([p["name"] for p in products] == ["Star / (RED)", "Moon", "Poster"] and products[1]["draws"] == ["draw_3"],
      f"only what cannot be placed is shared: {[p['name'] for p in products]}")

# ---- 5. where Airtable's list cannot cover the draws, nothing is shared
products, source, unplaced = rows([D1, D2], [], {}, orders, [STAR], SKUS)
check([p["name"] for p in products] == ["Draw 1", "Draw 2"] and source == "winners" and unplaced is None,
      f"two unpaired draws and one listed work: the draws stay as they were {[p['name'] for p in products]}")
# a second draw for a work that already has one stays a draw of its own, as before
products, _, unplaced = rows([D1, D2], [], {"draw_1": "(RED)", "draw_2": "(RED)"}, {"(RED)": {"unitsPaid": 4, "drafts": 0, "edition": 50}}, [RED], SKUS)
check([p["name"] for p in products] == ["(RED)", "Draw 2"] and unplaced is None, f"a second draw for one work: {[p['name'] for p in products]}")

# ---- 6. a name typed against a draw is left alone, and keeps its work out of the shared row
typed = [{"key": "draw_1", "name": "Star"}]
cfg, dp, by, unplaced = list_works([D1, D2], typed, {}, orders, WORKS, SKUS)
check(dp == {"draw_2": "(RED)"} and unplaced is None and cfg == typed,
      f"the typed draw is Star's by the user's word, so the other draw is (RED)'s: {dp}")

# ---- 7. nothing listed, nothing changed; and the inputs are never written to
before = copy.deepcopy((typed, {"draw_2": "(RED)"}, orders))
cfg, dp, by, unplaced = list_works([D1, D2], typed, {"draw_2": "(RED)"}, orders, None)
check((cfg, dp, by, unplaced) == (typed, {"draw_2": "(RED)"}, orders, None), "no works: the rule reads what it always read")
list_works([D1, D2], typed, {}, orders, WORKS, SKUS)
check((typed, {"draw_2": "(RED)"}, orders) == before, "the feeds' own records are left as they were")

# ---- 8. draw_works: the works Airtable marks as sold by draw, in the order it made them
AT = [{"airtable_id": "1", "name": "(RED)", "edition": 50, "launch_type": "Draw", "project_code": "HARLANDMI-2963", "sku": "HMIL1-REDDD-PE"},
      {"airtable_id": "2", "name": "Star", "edition": 50, "launch_type": "Draw", "project_code": "HARLANDMI-2572", "sku": "HMIL1-STARR-PE"},
      {"airtable_id": "3", "name": "Oak plinth (base only)", "edition": 300, "launch_type": None, "project_code": "HARLANDMI-3355", "sku": None},
      {"airtable_id": "4", "name": "Timed print", "edition": 500, "launch_type": "Timed", "project_code": "HARLANDMI-3000"},
      {"airtable_id": "5", "name": "Unsized", "edition": None, "launch_type": "Draw", "project_code": "HARLANDMI-3001"}]
got = build.draw_works(AT)
check([w["name"] for w in got] == ["Star", "(RED)"] and got[0] == {"name": "Star", "edition": 50, "sku": "HMIL1-STARR-PE", "project_code": "HARLANDMI-2572"},
      f"draws with an edition only, by project code: {got}")
# the Target setting tab's reading stands: a typed name and edition, and a work unticked is not listed
eff = [{"airtable_id": "1", "name": "(RED)", "edition": 45, "excluded": False}, {"airtable_id": "2", "name": "Star", "edition": 50, "excluded": True}]
check(build.draw_works(AT, eff) == [{"name": "(RED)", "edition": 45, "sku": "HMIL1-REDDD-PE", "project_code": "HARLANDMI-2963"}],
      f"typed over Airtable, unticked left out: {build.draw_works(AT, eff)}")
check(build.draw_works([]) == [] and build.draw_works(None) == [], "no products, no works")

# ---- 9. the block: an open launch with no draw in the feed has its works as rows
NAME = "Test Artist · Multiple · 2026 Q4"
build._PRODUCTS_FEED = {}
build._ORDERS_FEED = {NAME: {"products": {"(RED)": {"unitsPaid": 4, "drafts": 0, "draftCustomers": 0, "listPrice": 2500, "edition": 50}},
                             "draws": {}, "skus": SKUS, "drafts": 0.0, "unitsPaid": 4.0, "asOf": "2026-11-24"}}
st = build.sellthrough_block({"edition_size": None, "draw_works": WORKS}, NAME, units_sold=4, unconverted=0, inventory_left=None)
check([(p["name"], p["edition"], p["sold"]) for p in st["products"]] == [("(RED)", 50, 4), ("Star", 50, 0)],
      f"the works are the rows: {[(p['name'], p['edition'], p['sold']) for p in st.get('products') or []]}")
check(st["incomplete"] == [] and st["soldSource"] == "orders" and st["draws"] == [] and "unplaced" not in st, f"and nothing is waited on: {st['incomplete']}")
check(st["ordersByProduct"]["Star"] == {"unitsPaid": 0.0, "drafts": 0.0, "listPrice": None, "edition": 50, "listed": True},
      "what the rule read rides on the snapshot")
check("listed" not in build._ORDERS_FEED[NAME]["products"]["(RED)"], "the feed's own record is not marked")
# closed, the page reads what happened: one row, as before
st = build.sellthrough_block({"edition_size": None, "draw_works": WORKS}, NAME, 4, 0, None, closed=True)
check("products" not in st and st["incomplete"] == ["products"], "a closed launch is not listed from Airtable")
# no works from Airtable: as before
st = build.sellthrough_block({"edition_size": None}, NAME, 4, 0, None)
check("products" not in st and st["incomplete"] == ["products"], "nothing listed without Airtable's works")
# no orders for the launch at all: the works still, at nothing sold
build._ORDERS_FEED = {}
st = build.sellthrough_block({"edition_size": None, "draw_works": WORKS}, NAME, 0, 0, None)
check([(p["name"], p["edition"], p["sold"]) for p in st["products"]] == [("Star", 50, 0), ("(RED)", 50, 0)] and st["incomplete"] == [],
      f"no order line yet: {[(p['name'], p['sold']) for p in st.get('products') or []]}")

# ---- 10. the block: first entries the feed cannot place share a row, and the card is told
build._PRODUCTS_FEED = {NAME: {
    "draws": [{"id": "draw_1", "first": "2026-11-25", "last": "2026-11-25", "entrants": 1, "eligible": 1, "winners": 0, "sold": 0, "open": 1, "wonUnpaid": 0, "purchaseUnits": 0.0},
              {"id": "draw_2", "first": "2026-11-25", "last": "2026-11-25", "entrants": 2, "eligible": 2, "winners": 0, "sold": 0, "open": 2, "wonUnpaid": 0, "purchaseUnits": 0.0}],
    "entrants": 2, "eligible": 2, "allocated": False,
    "patterns": [{"open": ["draw_1", "draw_2"], "won": [], "sold": [], "bought": 0, "max": 1, "n": 1},
                 {"open": ["draw_2"], "won": [], "sold": [], "bought": 0, "max": 1, "n": 1}]}}
build._ORDERS_FEED = {NAME: {"products": {"(RED)": {"unitsPaid": 4, "drafts": 0, "draftCustomers": 0, "listPrice": 2500, "edition": 50}},
                             "draws": {}, "skus": SKUS, "drafts": 0.0, "unitsPaid": 4.0, "asOf": "2026-11-25"}}
st = build.sellthrough_block({"edition_size": None, "draw_works": WORKS}, NAME, units_sold=4, unconverted=2, inventory_left=None)
row = st["products"][0]
check(len(st["products"]) == 1 and row["name"] == "Star / (RED)" and row["edition"] == 100 and row["sold"] == 4 and row["draws"] == ["draw_1", "draw_2"],
      f"one row for the two works: {[(p['name'], p['edition'], p['sold'], p['draws']) for p in st['products']]}")
check(st["incomplete"] == ["entries by work"] and st["unplaced"] == {"draws": ["draw_1", "draw_2"], "works": ["Star", "(RED)"]},
      f"and the card says what it is waiting on: {st['incomplete']}")
check(build.product_name_warnings(st) == [], f"no warning for the shared row: {build.product_name_warnings(st)}")
# the feed pairs one of them: each has its own row, and the stamp clears
build._ORDERS_FEED[NAME]["draws"] = {"draw_2": "(RED)"}
st = build.sellthrough_block({"edition_size": None, "draw_works": WORKS}, NAME, units_sold=4, unconverted=2, inventory_left=None)
check([(p["name"], p["draws"]) for p in st["products"]] == [("Star", ["draw_1"]), ("(RED)", ["draw_2"])] and st["incomplete"] == [] and "unplaced" not in st,
      f"paired, each work has its row: {[(p['name'], p['draws']) for p in st['products']]} {st['incomplete']}")
check(st["drawProducts"] == {"draw_2": "(RED)", "draw_1": "Star"}, f"the pairing the rows followed rides on the snapshot: {st['drawProducts']}")
# and with no works given the same launch reads as it did: the unpaired draw is Draw 1
st = build.sellthrough_block({"edition_size": None}, NAME, units_sold=4, unconverted=2, inventory_left=None)
check([p["name"] for p in st["products"]] == ["Draw 1", "(RED)"] and st["incomplete"] == ["sales by product", "draft orders"],
      f"without the list: {[p['name'] for p in st['products']]} {st['incomplete']}")

print("ok: list works" if not failed else f"{failed} failure(s)")
sys.exit(1 if failed else 0)
