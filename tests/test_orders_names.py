#!/usr/bin/env python3
"""The orders feed's product names as the ETL reads them (docs/DATA_MODEL.md
2.4): the pull names each Shopify product once and tells two works that share
a title apart by the work their SKUs name (server/bigquery.js product_names,
pinned in tests/orders_sql.mjs), so each work is its own product with its own
Airtable edition, each draw finds its own work, and a file pulled before that
says so in the log.

Synthetic files only (the Urs Fischer case: two works called Problem Painting,
edition 100 each, one draw each): nothing under sources/, no real data.
  python3 tests/test_orders_names.py
"""
from __future__ import annotations

import contextlib
import csv
import io
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

REL = "Test Artist · Multiple · 2026 Q2"
COLS = ["release", "campaign_code", "product_title", "product_ids", "skus", "units_paid", "units_refunded",
        "units_draft_pending", "draft_customers", "units_entrant_drafts", "units_entry_drafts", "units_winner_drafts",
        "units_winner_drafts_lapsed", "units_from_drafts", "units_private_room", "list_price_eur", "first_order",
        "last_order", "last_draft", "prints_offered_paid", "frames_paid", "prints_offered_entry_drafts", "frames_entry_drafts",
        "prints_offered_awaiting", "frames_awaiting"]
failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def order_row(title, ids, skus, paid, drafts=0):
    r = dict.fromkeys(COLS, "")
    r.update({"release": REL, "campaign_code": "TestArtist_LE_26", "product_title": title, "product_ids": ids, "skus": skus,
              "units_paid": paid, "units_refunded": 0, "units_draft_pending": drafts, "units_from_drafts": 0,
              "units_private_room": 0, "list_price_eur": 800, "first_order": "2026-05-20", "last_order": "2026-06-20",
              "last_draft": "", "prints_offered_paid": 0, "frames_paid": 0})
    return r


def write(path, cols, rows):
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def feed_from(orders, draws):
    """load_orders_feed on these files, with an Airtable file holding the
    release's two records of one title, edition 100 each."""
    with tempfile.TemporaryDirectory() as d:
        data = pathlib.Path(d)
        write(data / "orders_by_product.csv", COLS, orders)
        write(data / "draw_products.csv", ["release", "draw_id", "product_title", "orders", "share"], draws)
        write(data / "release_pricing.csv", ["airtable_id", "artist", "title", "release", "edition_size", "launch_date", "quarter"],
              [{"airtable_id": "1", "artist": "Test Artist", "title": "Problem Painting", "release": "TestArtistLE26",
                "edition_size": "100", "launch_date": "2026-06-03", "quarter": "2026 Q2"},
               {"airtable_id": "2", "artist": "Test Artist", "title": "Problem Painting", "release": "TestArtistLE26",
                "edition_size": "100", "launch_date": "2026-06-03", "quarter": "2026 Q2"}])
        keep = build.DATA, build._ORDERS_FEED, build._PRODUCT_EDITIONS
        build.DATA, build._ORDERS_FEED, build._PRODUCT_EDITIONS = data, None, None
        log = io.StringIO()
        try:
            with contextlib.redirect_stdout(log):
                return build.load_orders_feed().get(REL), log.getvalue()
        finally:
            build.DATA, build._ORDERS_FEED, build._PRODUCT_EDITIONS = keep


DRAWS = {"draws": [{"id": "dA", "first": "2026-05-18", "last": "2026-06-25", "entrants": 51, "eligible": 51, "winners": 40,
                    "sold": 40, "open": 0, "wonUnpaid": 0, "purchaseUnits": 0.0},
                   {"id": "dB", "first": "2026-05-18", "last": "2026-06-25", "entrants": 45, "eligible": 45, "winners": 39,
                    "sold": 39, "open": 0, "wonUnpaid": 0, "purchaseUnits": 0.0}],
         "entrants": 96, "eligible": 96, "allocated": True, "patterns": []}


def rows_of(of):
    build._PRODUCTS_FEED = {REL: DRAWS}
    try:
        st = build.sellthrough_block({"edition_size": None}, REL, of["unitsPaid"], 0.0, None, orders=of, closed=True)
    finally:
        build._PRODUCTS_FEED = None
    return st


# 1. as the pull writes it now: one row per work, each draw on its own
of, log = feed_from(
    [order_row("Problem Painting (TESTA-PROB1)", "111", "TESTA-PROB1-PE-DRAW|TESTA-PROB1-PE-PRIVATE", 58),
     order_row("Problem Painting (TESTA-PROB2)", "222", "TESTA-PROB2-PE-DRAW|TESTA-PROB2-PE-PRIVATE", 53)],
    [{"release": REL, "draw_id": "dA", "product_title": "Problem Painting (TESTA-PROB1)", "orders": 53, "share": 0.9},
     {"release": REL, "draw_id": "dB", "product_title": "Problem Painting (TESTA-PROB2)", "orders": 52, "share": 0.9}])
check({t: p["edition"] for t, p in of["products"].items()} == {"Problem Painting (TESTA-PROB1)": 100, "Problem Painting (TESTA-PROB2)": 100},
      f"each work reads Airtable's edition for the title: {[(t, p['edition']) for t, p in of['products'].items()]}")
check(of["draws"] == {"dA": "Problem Painting (TESTA-PROB1)", "dB": "Problem Painting (TESTA-PROB2)"}, f"each draw finds its work: {of['draws']}")
check("two titles" not in log, f"no warning on a feed that names each product once: {log!r}")
st = rows_of(of)
got = [(p["name"], p["sold"], p["edition"]) for p in st["products"]]
check(got == [("Problem Painting (TESTA-PROB1)", 58.0, 100), ("Problem Painting (TESTA-PROB2)", 53.0, 100)], f"two works of 100: {got}")
check(st["soldSource"] == "orders" and st["incomplete"] == [], f"every draw named, nothing incomplete: {st['soldSource']} {st['incomplete']}")

# 2. as it was written before: both works under one title, both draws on it,
#    so one row read 111 of 100 beside a 'Draw 2' the orders could not name
#    (its winners' 39 here; nothing on a page cut to its window) - for contrast
of, _ = feed_from(
    [order_row("Problem Painting", "111|222", "TESTA-PROB1-PE-DRAW|TESTA-PROB2-PE-DRAW", 111)],
    [{"release": REL, "draw_id": "dA", "product_title": "Problem Painting", "orders": 53, "share": 0.9},
     {"release": REL, "draw_id": "dB", "product_title": "Problem Painting", "orders": 52, "share": 0.9}])
st = rows_of(of)
got = [(p["name"], p["sold"], p["edition"]) for p in st["products"]]
check(got == [("Problem Painting", 111.0, 100), ("Draw 2", 39.0, None)] and st["incomplete"] == ["sales by product", "draft orders"],
      f"the merged title, as the old feed read: {got} {st['incomplete']}")

# 3. a file pulled before products were named once: one product under two
#    titles is said in the log, and the build goes on
of, log = feed_from(
    [order_row("Something Forbidden (Blue)", "900", "TESTA-SFB24-PE-DRAW", 69),
     order_row("Something forbidden (Blue)", "900", "TESTA-SFB24-PE-PREORDER", 1)], [])
check(of is not None and len(of["products"]) == 2, "the old file still loads")
check("names one Shopify product with two titles in 1 release(s)" in log and REL in log, f"the split is logged: {log!r}")

print("ok: orders feed names" if not failed else f"{failed} failure(s)")
sys.exit(1 if failed else 0)
