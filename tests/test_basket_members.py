#!/usr/bin/env python3
"""The Benchmark basket card's rows (README, What the dashboard shows): each
build names its basket's launches with the units they sold and their unit
price in euros, in the basket's order, with the name, artist, title and
quarter the sidebar shows; a name the panel lacks is left out and a figure
it lacks is None. On the draw panel (etl/baskets.py) and the TL panel
(etl/tl.py).
  python3 tests/test_basket_members.py
"""
from __future__ import annotations

import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd  # noqa: E402
import baskets  # noqa: E402
import tl  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


FIELDS = {"name", "artist", "title", "quarter", "units", "price"}


def figure_ok(v, positive=False):
    return v is None or (isinstance(v, float) and not math.isnan(v) and (v > 0 if positive else v >= 0))


# ---- the draw panel
panel = baskets.load_panel()
names = panel["release_name"].head(3).tolist()
rows = baskets.basket_members(panel, names + ["Nobody · Nothing · 2099 Q1"])
check([r["name"] for r in rows] == names, f"the basket's order is kept and an unknown name is left out ({[r['name'] for r in rows]})")
check(all(set(r) == FIELDS for r in rows), "each row carries the card's six fields")
check(all(figure_ok(r["units"]) and figure_ok(r["price"], positive=True) for r in rows), f"units and price are figures or None ({rows})")
check(all(r["artist"] and r["quarter"] for r in rows), "the artist and the quarter come from the panel")
priced = panel[pd.to_numeric(panel["unit_price_eur"], errors="coerce") > 0].iloc[0]
one = baskets.basket_members(panel, [priced["release_name"]])[0]
check(abs(one["price"] - float(priced["unit_price_eur"])) < 1e-6 and abs(one["units"] - float(priced["tot_total_product_units"])) < 1e-6,
      "the price is the panel's euro price and the units its product units")
check(baskets.basket_members(panel, []) == [] and baskets.basket_members(None, names) == [] and baskets.basket_members(panel, None) == [],
      "nothing to list without a basket or a panel")

# ---- the TL panel
if tl.PANEL.exists():
    tlp = pd.read_csv(tl.PANEL)
    tnames = tlp["release_name"].head(2).tolist()
    trows = tl.basket_members(tlp, tnames + ["Nobody · Nothing · 2099 Q1"])
    check([r["name"] for r in trows] == tnames and all(set(r) == FIELDS for r in trows), f"the TL rows keep the order and carry the fields ({[r['name'] for r in trows]})")
    first = tlp.iloc[0]
    exp_price = float(first["unit_price_eur"]) if pd.notna(first["unit_price_eur"]) and float(first["unit_price_eur"]) > 0 else None
    check(abs(trows[0]["units"] - float(first["units"])) < 1e-6 and ((trows[0]["price"] is None and exp_price is None) or abs(trows[0]["price"] - exp_price) < 1e-6),
          f"a TL row reads the window's units and the euro price ({trows[0]})")
    check(tl.basket_members(pd.DataFrame(), tnames) == [], "an empty TL panel lists nothing")
else:
    print("note: no TL panel on disk - the TL rows need the build")

print("basket members: ok" if not failed else f"basket members: {failed} failed")
sys.exit(1 if failed else 0)
