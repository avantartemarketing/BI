#!/usr/bin/env python3
"""Frames per print for the Framing card (docs/DATA_MODEL.md 6.4).

The orders feed carries, per release and product, the paid prints a frame
was on offer for and the frames bought with them, and the same on the app's
entry drafts; the block reads them as a rate against the plan's and the
basket's, per work for the hover, with the prints that had no framing
option named apart. Run:
  python3 tests/test_framing.py
"""
from __future__ import annotations

import csv
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

COLS = ["release", "campaign_code", "product_title", "product_ids", "skus", "units_paid", "units_refunded",
        "units_draft_pending", "draft_customers", "units_entrant_drafts", "units_entry_drafts", "units_winner_drafts",
        "units_winner_drafts_lapsed", "units_from_drafts", "units_private_room", "list_price_eur", "first_order",
        "last_order", "last_draft", "prints_offered_paid", "frames_paid", "prints_offered_entry_drafts", "frames_entry_drafts"]
REL = "Andy Warhol Estate · Multiple · 2026 Q3"


def row(title, paid, offered, frames, e_prints=0, e_frames=0, last_order="2026-09-22"):
    r = dict.fromkeys(COLS, "")
    r.update({"release": REL, "campaign_code": "Warhol_LE_26", "product_title": title, "units_paid": paid, "units_refunded": 0,
              "units_draft_pending": 0, "units_entry_drafts": e_prints, "units_from_drafts": 0, "units_private_room": 0,
              "list_price_eur": 500, "first_order": "2026-09-01", "last_order": last_order, "last_draft": "2026-09-23",
              "prints_offered_paid": offered, "frames_paid": frames, "prints_offered_entry_drafts": e_prints,
              "frames_entry_drafts": e_frames})
    return r


def load(rows, cols=COLS):
    """The feed as load_orders_feed reads it from a CSV with these columns."""
    with tempfile.TemporaryDirectory() as d:
        path = pathlib.Path(d) / "orders_by_product.csv"
        with path.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
        keep = build.DATA, build._ORDERS_FEED
        build.DATA, build._ORDERS_FEED = pathlib.Path(d), None
        try:
            return build.load_orders_feed()
        finally:
            build.DATA, build._ORDERS_FEED = keep


def test_feed() -> None:
    feed = load([
        row("Brillo Box Collectable (White Portrait)", 169, 169, 98, e_prints=120, e_frames=90),
        row("Brillo Box Collectable (Green Landscape)", 45, 45, 37.5),
        row("Lifesize Brillo Box", 78, 0, 0),
    ])
    f = feed[REL]["framing"]
    assert f == {"prints": 214.0, "frames": 135.5, "notOffered": 78.0, "entrantPrints": 120.0, "entrantFrames": 90.0}, f
    p = feed[REL]["products"]["Brillo Box Collectable (Green Landscape)"]
    assert p["printsOffered"] == 45.0 and p["frames"] == 37.5 and p["entrantPrints"] == 0.0 and p["unitsPaid"] == 45.0
    # a feed pulled before the columns existed reads as no framing at all
    old = load([row("Brillo Box Collectable (White Portrait)", 169, 169, 98)], cols=COLS[:19])
    assert old[REL]["framing"] == {"prints": 0.0, "frames": 0.0, "notOffered": 169.0, "entrantPrints": 0.0, "entrantFrames": 0.0}
    assert build.framing_block({}, old[REL], None) is None
    assert build.framing_block({}, None, None) is None
    print("feed: ok")


def basket(members):
    return {"id": "b", "members": members}


def panel_feed():
    """Members' feeds: three with enough prints to rate, one too few."""
    def rel(prints, frames):
        return {"products": {}, "framing": {"prints": prints, "frames": frames, "notOffered": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0}}
    return {"A": rel(100, 60), "B": rel(40, 10), "C": rel(30, 18), "D": rel(10, 9)}


def test_block() -> None:
    feed = load([
        row("Brillo Box Collectable (White Portrait)", 169, 169, 98, e_prints=120, e_frames=90),
        row("Brillo Box Collectable (Green Landscape)", 45, 45, 37.5),
        row("Lifesize Brillo Box", 78, 0, 0),
    ])
    of = feed[REL]
    keep = build._ORDERS_FEED
    build._ORDERS_FEED = panel_feed()
    try:
        blk = build.framing_block({"frame_conversion": 0.5}, of, basket(["A", "B", "C", "D"]))
    finally:
        build._ORDERS_FEED = keep
    assert blk["prints"] == 214 and blk["frames"] == 135.5 and abs(blk["rate"] - 135.5 / 214) < 1e-4, blk
    assert blk["entrants"] == {"prints": 120, "frames": 90.0, "rate": 0.75}
    assert blk["plan"] == 0.5
    # the basket's median over the members the feed can rate: D is under the floor
    assert blk["benchmark"] == {"rate": 0.6, "n": 3, "of": 4}, blk["benchmark"]
    assert [w["name"] for w in blk["works"]] == ["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (White Portrait)"]
    assert blk["works"][0] == {"name": "Brillo Box Collectable (Green Landscape)", "prints": 45, "frames": 37.5, "rate": 0.8333}
    assert blk["notOffered"] == {"units": 78, "works": ["Lifesize Brillo Box"]}
    assert blk["asOf"] == "2026-09-23"
    # the plan's default when nothing is typed; none at all when framing is not offered
    assert build.framing_block({}, of, None)["plan"] == build.BENCH["frame_conversion"]
    assert build.framing_block({"framing_available": False}, of, None)["plan"] is None
    # no benchmark without a basket, or with too few members to rate
    assert build.framing_block({}, of, None)["benchmark"] is None
    assert build.framing_benchmark(basket(["A", "B", "D"]), panel_feed()) is None
    assert build.framing_benchmark(basket([]), panel_feed()) is None
    # entrants only: the draw has not sold yet, the card still has something to say
    only = load([row("Print", 0, 0, 0, e_prints=50, e_frames=20)])[REL]
    blk = build.framing_block({}, only, None)
    assert blk["rate"] is None and blk["prints"] == 0 and blk["entrants"]["rate"] == 0.4 and blk["works"] == []
    print("block: ok")


if __name__ == "__main__":
    test_feed()
    test_block()
