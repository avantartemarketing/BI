#!/usr/bin/env python3
"""The Airtable pricing join (etl/pricing.py) and the price band in the basket
ladder (etl/baskets.py), on made-up frames.

No real data: a handful of invented artists, titles and prices, built in
memory. Checks the rules the module docstrings promise - a bundle does not
price a launch, a group show is one launch per artist, an exact title beats
the window, a misspelt artist matches with a printed score and a far-off one
does not, and the price band widens like the size band and steps aside when
the release has no price.  python3 tests/test_pricing.py
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402
import pricing as P  # noqa: E402


def airtable_rows() -> pd.DataFrame:
    """A dozen invented product records the way pull_airtable.py writes them."""
    rows = [
        # one launch, two colourways and a bundle of both (the bundle must not count)
        dict(airtable_id=1, artist="Test Artist", title="Sunrise (Red)", release="TestSun26", unit_price=500, edition_size=100, launch_date="2026-05-28"),
        dict(airtable_id=2, artist="Test Artist", title="Sunrise (Blue)", release="TestSun26", unit_price=700, edition_size=50, launch_date="2026-05-28"),
        dict(airtable_id=3, artist="Test Artist", title="Sunrise (Red) & Sunrise (Blue) [Set of 2]", release="TestSun26", unit_price=1200, edition_size=None, launch_date="2026-05-28"),
        # the same artist a year earlier under another code, same title as the panel's later one
        dict(airtable_id=4, artist="Test Artist", title="Sunrise (Red)", release="TestSun25", unit_price=400, edition_size=80, launch_date="2025-05-20"),
        # a group show: one code, three artists
        dict(airtable_id=5, artist="Alpha Person", title="Vase", release="GroupShow25", unit_price=6000, edition_size=30, launch_date="2025-01-28"),
        dict(airtable_id=6, artist="Beta Person", title="Bowl", release="GroupShow25", unit_price=6000, edition_size=30, launch_date="2025-01-28"),
        dict(airtable_id=7, artist="Gamma Person", title="Plate", release="GroupShow25", unit_price=5000, edition_size=30, launch_date="2025-01-28"),
        # an artist whose name is written in another order on the panel
        dict(airtable_id=8, artist="Kim Sowon", title="Wave", release="SowonKim24", unit_price=1500, edition_size=50, launch_date="2024-11-19"),
        # an estate, named with the foundation on this side
        dict(airtable_id=9, artist="The Someone Foundation", title="Box", release="SomeoneTL26", unit_price=750, edition_size=1000, launch_date="2026-09-30"),
        # a record with no code at all
        dict(airtable_id=10, artist="Solo Maker", title="Loop", release=None, unit_price=900, edition_size=40, launch_date="2024-03-03"),
    ]
    df = pd.DataFrame(rows)
    df["currency"] = np.where(df["unit_price"].notna(), "EUR", "")
    for c in ("launch_type", "edition_type", "product_type", "price_status"):
        df[c] = "Draw" if c == "launch_type" else ("PE" if c == "edition_type" else ("Standard print" if c == "product_type" else "Confirmed"))
    return df


def panel_rows() -> pd.DataFrame:
    return pd.DataFrame([
        dict(release_name="Test Artist · Multiple · 2026 Q2", artist="Test Artist", title="Multiple", quarter="2026 Q2",
             announce="2026-04-30", close="2026-05-28", panel="draw"),
        dict(release_name="Test Artist · Sunrise (Red) · 2025 Q2", artist="Test Artist", title="Sunrise (Red)", quarter="2025 Q2",
             announce="2025-04-25", close="2025-05-20", panel="draw"),
        dict(release_name="Beta Person · Multiple · 2025 Q1", artist="Beta Person", title="Multiple", quarter="2025 Q1",
             announce="2024-12-10", close="2025-01-28", panel="draw"),
        dict(release_name="Sowon Kim · Multiple · 2024 Q4", artist="Sowon Kim", title="Multiple", quarter="2024 Q4",
             announce="2024-10-24", close="2024-11-19", panel="draw"),
        dict(release_name="Someone Estate · Multiple · 2026 Q3", artist="Someone Estate", title="Multiple", quarter="2026 Q3",
             announce="2026-09-02", close="2026-09-30", panel=None),
        dict(release_name="Solo Maker · Loop · 2024 Q1", artist="Solo Maker", title="Loop", quarter="2024 Q1",
             announce=None, close=None, panel=None),
        dict(release_name="Nobody Here · Thing · 2024 Q1", artist="Nobody Here", title="Thing", quarter="2024 Q1",
             announce="2024-02-01", close="2024-02-22", panel="draw"),
        dict(release_name="Test Artist · Sunrise (Red) · 2023 Q1", artist="Test Artist", title="Sunrise (Red)", quarter="2023 Q1",
             announce="2023-01-05", close="2023-01-26", panel="draw"),
    ])


def test_launches_and_match() -> None:
    recs = airtable_rows()
    recs["launch_date"] = pd.to_datetime(recs["launch_date"])
    recs["artist_key"] = recs["artist"].map(P.artist_key)
    recs["title_key"] = recs["title"].map(P.norm)
    recs["bundle"] = recs["title"].fillna("").str.contains(P.BUNDLE_RE) | ~(recs["edition_size"] > 0)
    lf = P.launches(recs)
    # the group show is one launch per artist, not one launch
    assert (lf["airtable_release"] == "GroupShow25").sum() == 3, lf[["airtable_release", "artist"]]
    sun = lf[lf["airtable_release"] == "TestSun26"].iloc[0]
    # the bundle is left out: 150 units, value 500*100 + 700*50
    assert sun["edition_size"] == 150 and sun["launch_value"] == 85000, sun
    assert abs(sun["unit_price"] - 85000 / 150) < 1e-9 and sun["n_products"] == 3 and sun["n_bundles"] == 1
    assert abs(sun["unit_price_gbp"] - sun["unit_price"] * P.RATES_TO_GBP["EUR"]) < 1e-9

    res = P.match(panel_rows(), lf)
    got = dict(zip(panel_rows()["release_name"], res["price_match"]))
    # "Multiple" in the window -> the artist's launch on the close date, not the year-earlier one
    assert got["Test Artist · Multiple · 2026 Q2"] == "artist+window"
    assert res.iloc[0]["airtable_release"] == "TestSun26" and res.iloc[0]["price_match_days"] == 0
    # the year-earlier code is outside the window, so it is not even a candidate to lose; the note lists the titles matched
    assert res.iloc[0]["price_note"].startswith("titles: Sunrise (Red)"), res.iloc[0]["price_note"]
    # exact title with two candidates a year apart: the one in the window
    assert got["Test Artist · Sunrise (Red) · 2025 Q2"] == "exact" and res.iloc[1]["airtable_release"] == "TestSun25"
    # a group-show artist finds her own record under the shared code
    assert got["Beta Person · Multiple · 2025 Q1"] == "artist+window" and res.iloc[2]["unit_price"] == 6000
    # the name in the other order matches, with the similarity printed
    assert got["Sowon Kim · Multiple · 2024 Q4"] == "fuzzy+window" and res.iloc[3]["price_match_score"] == 1.0
    assert "similarity 1.00" in res.iloc[3]["price_note"]
    # estate against foundation is the same artist
    assert got["Someone Estate · Multiple · 2026 Q3"] == "artist+window" and res.iloc[4]["edition_size"] == 1000
    # no window: the quarter in the name, and a record without a code still forms a launch
    assert got["Solo Maker · Loop · 2024 Q1"] == "exact" and res.iloc[5]["unit_price"] == 900
    # nobody by that name: unmatched, and it says so
    assert got["Nobody Here · Thing · 2024 Q1"] == "none" and "not in the Airtable pull" in res.iloc[6]["price_note"]
    # the title exists but only in other years: unmatched with the dates, never another work
    assert got["Test Artist · Sunrise (Red) · 2023 Q1"] == "none", res.iloc[7]["price_note"]
    assert "exact title found but launched" in res.iloc[7]["price_note"]
    assert set(P.PRICE_COLS) <= set(res.columns)


def synthetic_panel(n: int = 40, seed: int = 7) -> pd.DataFrame:
    """A draw panel where price and size are independent, so the price band
    has something to narrow."""
    rng = np.random.default_rng(seed)
    units = np.exp(rng.uniform(np.log(20), np.log(800), n))
    price = np.exp(rng.uniform(np.log(300), np.log(6000), n))
    df = pd.DataFrame({
        "release_name": [f"Artist {i} · Work · 2025 Q{1 + i % 4}" for i in range(n)],
        "artist": [f"Artist {i}" for i in range(n)],
        "panel": "draw", "cluster": [i % 2 for i in range(n)],
        "tot_total_product_units": units.round(), "tot_sessions_total": units * 100,
        "tot_draw_entries_eligible_units": units * 1.2, "campaign_days": 25.0, "private_room_share": 0.2,
        "unit_price_gbp": price.round(), "edition_size": units.round(),
        "window_end": pd.Timestamp("2025-06-01"), "window_start": pd.Timestamp("2025-05-01"),
    })
    for g in B.GROUPS:
        df[f"unit_share_{g}"] = 0.2; df[f"sess_share_{g}"] = 0.2; df[f"conv_sess_entry_{g}"] = 0.01
    return df


def test_price_band() -> None:
    panel = synthetic_panel()
    keep = (B.SIMILAR_USE_PRICE, B.SIMILAR_RUNGS)
    try:
        B.SIMILAR_USE_PRICE = True
        rel = {"release_name": "new", "edition_size": 150, "unit_price": 1500}
        members, factor, on = B.similar_members(panel, rel)
        assert len(members) >= B.SIMILAR_MIN and "price" in on and "size" in on, (len(members), factor, on)
        rows = panel[panel["release_name"].isin(members)]
        # every member sits inside both bands at the factor that answered
        assert ((rows["tot_total_product_units"] >= 150 / factor) & (rows["tot_total_product_units"] <= 150 * factor)).all()
        assert ((rows["unit_price_gbp"] >= 1500 / factor) & (rows["unit_price_gbp"] <= 1500 * factor)).all()
        # without a price the band steps aside and the old ladder answers
        m2, f2, on2 = B.similar_members(panel, {"release_name": "new", "edition_size": 150})
        assert "price" not in on2 and len(m2) >= len(members), (on2, len(m2), len(members))
        B.SIMILAR_USE_PRICE = False
        m3, f3, on3 = B.similar_members(panel, rel)
        assert m3 == m2 and on3 == on2
        # a price typed in euros converts before the band is drawn
        B.SIMILAR_USE_PRICE = True
        m4, _f4, _on4 = B.similar_members(panel, {"release_name": "new", "edition_size": 150, "unit_price": 1500 / P.RATES_TO_GBP["EUR"], "currency": "EUR"})
        assert m4 == members
        # the profile carries the price range over the priced members only
        prof = B.basket_profile(panel.assign(unit_price_gbp=panel["unit_price_gbp"].where(panel.index % 5 != 0)), members)
        assert prof["n_priced"] < prof["n"] and prof["price_p25"] <= prof["price"] <= prof["price_p75"]
        # the sentence under the basket names both bands
        desc = B.similar_desc(members, factor, on, 150, 1500)
        assert "unit price of £1,500" in desc and f"factor of {factor:g}" in desc
    finally:
        B.SIMILAR_USE_PRICE, B.SIMILAR_RUNGS = keep


if __name__ == "__main__":
    test_launches_and_match()
    test_price_band()
    print("ok: pricing join and price band")
