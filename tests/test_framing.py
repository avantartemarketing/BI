#!/usr/bin/env python3
"""Frames per print for the Framing card (docs/DATA_MODEL.md 6.4).

The orders feed carries, per release and product, the paid prints a frame
was on offer for and the frames bought with them, and the same on the app's
entry drafts and on the orders awaiting payment; the block reads them as a
rate against the plan's and the basket's, per work for the hover, with the
prints that had no framing option named apart, and as a forecast on the
units the sell-through counts (paid, drafts, the draw's forecast
conversions, at close the entries still to come). Run:
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
        "last_order", "last_draft", "frame_price_eur", "prints_offered_paid", "frames_paid", "prints_offered_entry_drafts", "frames_entry_drafts",
        "prints_offered_awaiting", "frames_awaiting"]
REL = "Andy Warhol Estate · Multiple · 2026 Q3"


def row(title, paid, offered, frames, e_prints=0, e_frames=0, last_order="2026-09-22",
        drafts=0, d_prints=0, d_frames=0, entry_units=None):
    r = dict.fromkeys(COLS, "")
    r.update({"release": REL, "campaign_code": "Warhol_LE_26", "product_title": title, "units_paid": paid, "units_refunded": 0,
              "units_draft_pending": drafts, "units_entry_drafts": e_prints if entry_units is None else entry_units,
              "units_from_drafts": 0, "units_private_room": 0,
              "list_price_eur": 500, "first_order": "2026-09-01", "last_order": last_order, "last_draft": "2026-09-23",
              "prints_offered_paid": offered, "frames_paid": frames, "prints_offered_entry_drafts": e_prints,
              "frames_entry_drafts": e_frames, "prints_offered_awaiting": d_prints, "frames_awaiting": d_frames})
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


def test_default() -> None:
    """The assumed take-up (framing_default): the share of paid prints that took a
    frame over the works that first sold in the last twelve months, every launch
    together, pooled over prints; None, the constant standing, while the feed is
    thin; and set_framing_default puts it in both builds' benchmarks."""
    import datetime as dt
    as_of = dt.date(2026, 10, 10)
    big = []
    # six recent launches of 200 prints at 50%, one old launch of 2,000 prints at 10% that must not count,
    # one recent launch with its first order a day outside the window
    for i in range(6):
        r = row(f"Recent {i}", 200, 200, 100, last_order="2026-09-01")
        r.update({"release": f"Artist {i} · Multiple · 2026 Q3", "first_order": f"2026-0{i + 1}-15"})
        big.append(r)
    old_r = row("Old", 2000, 2000, 200, last_order="2025-09-01"); old_r.update({"release": "Old Artist · Multiple · 2025 Q3", "first_order": "2025-06-01"}); big.append(old_r)
    edge = row("Edge", 400, 400, 0, last_order="2025-10-20"); edge.update({"release": "Edge Artist · Multiple · 2025 Q4", "first_order": "2025-10-09"}); big.append(edge)
    feed = load(big)
    fd = build.framing_default(as_of, feed)
    assert fd is not None and fd["launches"] == 6 and fd["prints"] == 1200 and fd["frames"] == 600 and fd["rate"] == 0.5, fd
    assert fd["since"] == "2025-10-10" and fd["works"] == 6, fd
    # the day the window opens counts; the day before does not
    edge2 = dict(edge, first_order="2025-10-10"); feed2 = load(big[:-1] + [edge2])
    fd2 = build.framing_default(as_of, feed2)
    assert fd2["launches"] == 7 and fd2["prints"] == 1600 and abs(fd2["rate"] - 600 / 1600) < 1e-9, fd2
    # pooled over prints: a big launch weighs as its buyers did
    huge = row("Huge", 3000, 3000, 300, last_order="2026-09-01"); huge.update({"release": "Huge Artist · Multiple · 2026 Q3", "first_order": "2026-08-01"})
    fd3 = build.framing_default(as_of, load(big + [huge]))
    assert abs(fd3["rate"] - round(900 / 4200, 4)) < 1e-9, fd3
    # thin: too few prints, or too few launches, and the constant stands
    assert build.framing_default(as_of, load(big[:4])) is None, "four launches of 200 prints are too few prints"
    few = [dict(r, prints_offered_paid=600, frames_paid=300, units_paid=600) for r in big[:4]]
    assert build.framing_default(as_of, load(few)) is None, "2,400 prints over four launches are too few launches"
    assert build.framing_default(as_of, {}) is None
    # no frame prices on file: the four bands are there, none with a rate
    assert [(x["lo"], x["hi"]) for x in fd["bands"]] == list(build.pricing.FRAMING_BANDS) and all(x["rate"] is None and x["prints"] == 0 for x in fd["bands"]), fd["bands"]
    # by the frame's price against the print's (list price 500): two launches of
    # 200 prints in each band but the 35-50% one, which has one, too few prints
    # for a rate of its own; a launch with no frame price counts overall only
    spec = [("Cheap A", 50, 120), ("Cheap B", 60, 120),       # under 20%: 60%
            ("Mid A", 100, 100), ("Mid B", 150, 100),         # 20-35% (100 is exactly 20%, and in): 50%
            ("Thin", 200, 60),                                # 35-50%: 200 prints, too few
            ("Dear A", 250, 60), ("Dear B", 300, 60),         # 50% and over (250 is exactly 50%, and in): 30%
            ("Unpriced", "", 100)]                            # no frame price: overall only
    banded = []
    for nm, fp, frames in spec:
        r = row(nm, 200, 200, frames, last_order="2026-09-01")
        r.update({"release": f"{nm} Artist · Multiple · 2026 Q3", "first_order": "2026-06-15", "frame_price_eur": fp})
        banded.append(r)
    fb = build.framing_default(as_of, load(banded))
    assert fb["launches"] == 8 and fb["prints"] == 1600 and fb["frames"] == 720 and fb["rate"] == 0.45, fb
    assert [x["rate"] for x in fb["bands"]] == [0.6, 0.5, None, 0.3], fb["bands"]
    assert [x["prints"] for x in fb["bands"]] == [400, 400, 200, 400] and [x["launches"] for x in fb["bands"]] == [2, 2, 1, 2], fb["bands"]
    # set into both builds' benchmarks, and the constant restored where the feed is thin
    import tl
    keep = build.BENCH["frame_conversion"], tl.BENCH["frame_conversion"]
    try:
        got = build.set_framing_default(as_of, feed)
        assert got["rate"] == 0.5 and build.BENCH["frame_conversion"] == 0.5 and tl.BENCH["frame_conversion"] == 0.5
        assert build.BENCH["frame_conversion_source"]["kind"] == "last_12_months" and tl.BENCH["frame_conversion_source"]["launches"] == 6
        conv, _ = build.frame_terms({"frame_conversion": None, "frame_profit_per_unit": 80}, build.BENCH)
        assert conv == 0.5, "frame_terms reads the rate set"
        assert build.frame_terms({"frame_conversion": None}, build.BENCH, ratio=0.1)[0] == 0.5, "no band has a rate: the overall rate for any ratio"
        # the rate a work is read at: its band's, the overall one where the band is thin or the frame price unknown
        build.set_framing_default(as_of, load(banded))
        assert build.BENCH["frame_conversion"] == 0.45 and [x["rate"] for x in tl.BENCH["frame_conversion_bands"]] == [0.6, 0.5, None, 0.3]
        assert build.BENCH["frame_conversion_source"]["prints"] == 1600 and "bands" not in build.BENCH["frame_conversion_source"]
        for ratio, want in {None: 0.45, 0.1: 0.6, 0.2: 0.5, 0.3499: 0.5, 0.35: 0.45, 0.5: 0.3, 2.0: 0.3, -1: 0.45}.items():
            conv, _ = build.frame_terms({"frame_conversion": None}, build.BENCH, ratio=ratio)
            assert conv == want, (ratio, conv, want)
        assert build.frame_terms({"frame_conversion": 0.7}, build.BENCH, ratio=0.1)[0] == 0.7, "a work's own figure over its band's"
        rate, band = build.pricing.frame_band_rate(0.4, build.BENCH)
        assert rate == 0.45 and band["lo"] == 0.35, "a thin band reads the overall rate, and says which band it is"
        assert build.pricing.frame_band_rate("x", build.BENCH) == (0.45, None)
        build.BENCH["frame_conversion"] = tl.BENCH["frame_conversion"] = 0.35
        assert build.set_framing_default(as_of, {}) is None and build.BENCH["frame_conversion"] == 0.35
        assert build.BENCH["frame_conversion_source"] == {"kind": "constant", "rate": 0.35} and tl.BENCH["frame_conversion_bands"] == []
        assert build.frame_terms({"frame_conversion": None}, build.BENCH, ratio=0.1)[0] == 0.35, "thin feed: the constant for any ratio"
    finally:
        build.BENCH["frame_conversion"], tl.BENCH["frame_conversion"] = keep
        for bb in (build.BENCH, tl.BENCH):
            bb.pop("frame_conversion_source", None); bb.pop("frame_conversion_bands", None)
    print("framing default: ok")


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
    assert p["draftPrints"] == 0.0 and p["draftFrames"] == 0.0
    # a feed pulled before the drafts' pair reads them as unknown, not as none
    older = load([row("Brillo Box Collectable (White Portrait)", 169, 169, 98, drafts=4)], cols=[c for c in COLS if c not in ("prints_offered_awaiting", "frames_awaiting")])
    wp = older[REL]["products"]["Brillo Box Collectable (White Portrait)"]
    assert wp["draftPrints"] is None and wp["draftFrames"] is None and wp["drafts"] == 4.0, wp
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


def close_to(a, b, tol=0.051):
    return a is not None and b is not None and abs(a - b) <= tol


def forecast_feed(cols=COLS):
    """Two works with a frame on offer and one without, as the Warhol release
    is: White Portrait paid 100 prints with 50 frames, 4 drafts with 3 frames,
    40 pre-authorised prints asking for 30 frames; Green Landscape paid 50
    with 40 frames and nothing pre-authorised; the Lifesize, 20 paid and 10
    pre-authorised, no frame on offer."""
    of = load([
        row("White Portrait", 100, 100, 50, e_prints=40, e_frames=30, drafts=4, d_prints=4, d_frames=3),
        row("Green Landscape", 50, 50, 40),
        row("Lifesize", 20, 0, 0, entry_units=10, drafts=2),
    ], cols=cols)[REL]
    of["draws"] = {"dW": "White Portrait", "dG": "Green Landscape", "dL": "Lifesize"}
    return of


def sell_rows(**extra):
    """The sell-through's rows for the three works, keyed by draw id; the
    Green Landscape row's name differs from the orders feed's title, so only
    the pairing places it."""
    return {"products": [
        {"key": "dW", "draws": ["dW"], "name": "Brillo (White Portrait)", "sold": 100, "soldAssumed": 0, "drafts": 4, "shown": 20, "futurePredicted": 10},
        {"key": "dG", "draws": ["dG"], "name": "Vert", "sold": 50, "soldAssumed": 0, "drafts": 0, "shown": 10, "futurePredicted": 0},
        {"key": "dL", "draws": ["dL"], "name": "Lifesize", "sold": 20, "soldAssumed": 0, "drafts": 2, "shown": 5, "futurePredicted": 1},
    ], **extra}


def test_forecast() -> None:
    of = forecast_feed()
    fc = build.framing_forecast(of, sell_rows())
    # White Portrait: paid 100 at 50 frames, drafts 4 at their own 3 of 4,
    # 20 forecast wins at the entrants' 30 of 40 (0.75); at close 10 more at 0.75
    w = next(r for r in fc["products"] if r["key"] == "dW")
    assert w["today"]["prints"] == 124.0 and w["today"]["frames"] == 68.0, w
    assert w["close"]["prints"] == 134.0 and w["close"]["frames"] == 75.5, w
    # Green Landscape: nothing pre-authorised, so its wins take the release's
    # entrants' rate (30 of 40, the only work with any), placed by the pairing
    g = next(r for r in fc["products"] if r["key"] == "dG")
    assert g["name"] == "Vert" and g["today"]["prints"] == 60.0 and g["today"]["frames"] == 47.5, g
    # the Lifesize has no frame on offer: no row, its units counted apart
    assert [r["key"] for r in fc["products"]] == ["dW", "dG"]
    assert {k: v for k, v in fc["today"].items() if k != "parts"} == {
        "prints": 184.0, "frames": 115.5, "rate": round(115.5 / 184, 4), "notOffered": 27.0}, fc["today"]
    # the parts the explainer shows add up to the totals, at both horizons
    for h, kinds in (("today", ["paid", "drafts", "draw"]), ("close", ["paid", "drafts", "draw", "future"])):
        pt = fc[h]["parts"]
        assert sorted(pt) == sorted(kinds), pt
        assert close_to(sum(v["prints"] for v in pt.values()), fc[h]["prints"]), (h, pt)
        assert close_to(sum(v["frames"] for v in pt.values()), fc[h]["frames"]), (h, pt)
    # White Portrait's 4 drafts at 3 of 4 are the only drafts on offer
    assert fc["today"]["parts"]["drafts"]["frames"] == 3.0 and fc["close"]["parts"]["future"]["prints"] == 10.0, fc
    assert fc["close"]["prints"] == 194.0 and fc["close"]["frames"] == 123.0 and fc["close"]["notOffered"] == 28.0, fc["close"]
    # the forecast sits between the buyers' rate and the entrants' when the
    # entrants ask for more
    buyers, entrants = 90 / 150, 30 / 40
    assert buyers < fc["today"]["rate"] < entrants, (buyers, fc["today"]["rate"], entrants)

    # a feed without the drafts' pair: the drafts take the work's buyers' rate
    older = forecast_feed(cols=[c for c in COLS if c not in ("prints_offered_awaiting", "frames_awaiting")])
    wo = next(r for r in build.framing_forecast(older, sell_rows())["products"] if r["key"] == "dW")
    assert wo["today"]["frames"] == 50 + 4 * 0.5 + 20 * 0.75, wo

    # a row the pairing cannot place is found by name, the short title starting the long one
    unpaired = dict(of, draws={})
    rows = sell_rows()
    rows["products"][0]["name"] = "White Port"
    fu = build.framing_forecast(unpaired, rows)
    assert next(r for r in fu["products"] if r["key"] == "dW")["today"]["frames"] == 68.0
    # and one neither places takes the release's shares and rates: Vert,
    # unpaired and named like no work, is estimated on the release's paid
    # share on offer (150 of 170) and its pre-authorised share (40 of 50)
    ge = next(r for r in fu["products"] if r["key"] == "dG")
    assert close_to(ge["today"]["prints"], 50 * 150 / 170 + 10 * 40 / 50), ge

    # two rows on one work share its paid prints by their sold units
    two = sell_rows()
    two["products"].append({"key": "dW2", "draws": ["dW2"], "name": "White Portrait II", "sold": 100, "soldAssumed": 0,
                            "drafts": 0, "shown": 0, "futurePredicted": 0})
    of2 = dict(of, draws={**of["draws"], "dW2": "White Portrait"})
    f2 = build.framing_forecast(of2, two)
    paid_w = [r["today"]["prints"] for r in f2["products"] if r["key"] in ("dW", "dW2")]
    assert paid_w == [50 + 4 + 20, 50.0], paid_w

    # without product rows the release is one: paid 150 at 90, drafts 6 of
    # which 4 on offer at 3 of 4, 35 forecast wins with 40 of 50 pre-authorised
    # prints on offer, at the entrants' 0.75
    flat = build.framing_forecast(of, {"sold": 170, "drafts": 6, "soldPredicted": 35, "futureEntriesPredicted": 11})
    assert close_to(flat["today"]["prints"], 150 + 4 + 35 * 0.8) and close_to(flat["today"]["frames"], 90 + 3 + 35 * 0.8 * 0.75), flat
    assert close_to(flat["today"]["notOffered"], 170 + 6 + 35 - flat["today"]["prints"]), flat
    assert close_to(flat["close"]["prints"], flat["today"]["prints"] + 11 * 0.8), flat
    assert build.framing_forecast(of, None) is None and build.framing_forecast(None, sell_rows()) is None

    # the block carries it, and a block without the sell-through carries none
    assert build.framing_block({}, of, None, st=sell_rows())["forecast"]["today"] == fc["today"]
    assert build.framing_block({}, of, None)["forecast"] is None
    print("forecast: ok")


if __name__ == "__main__":
    test_feed()
    test_default()
    test_block()
    test_forecast()
