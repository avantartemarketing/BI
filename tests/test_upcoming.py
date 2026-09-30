#!/usr/bin/env python3
"""Upcoming launches from Airtable (docs/DATA_MODEL.md 1.7).

A draw Airtable knows and the funnel report does not yet is listed as an
upcoming release, named the way the funnel will name it, with Airtable's
dates, edition and price as the defaults its targets start from; a launch a
release on file already represents is not; and a release set up before the
funnel saw it takes the funnel's name once it appears. The Airtable cases at
the end are the records of data/release_pricing.csv (pulled 25 Sep 2026) for
the launches the sweep found listed wrongly: an originals show, a timed print
with a pitching NFT, a second launch in one quarter, an artist the funnel
spells another way and a launch whose announce passed with nothing moving.
Run:
  python3 tests/test_upcoming.py
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import sys
import tempfile

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402
import pricing  # noqa: E402

AS_OF = dt.date(2026, 9, 23)


def records(rows):
    """Airtable product records as etl/pricing.py load_pricing prepares them."""
    df = pd.DataFrame(rows, columns=["airtable_id", "artist", "title", "release", "launch_date", "announce_date",
                                     "private_room_date", "unit_price", "currency", "edition_size", "launch_type",
                                     "edition_type", "product_type", "price_status", "project_status"])
    df["launch_date"] = pd.to_datetime(df["launch_date"])
    df["artist_key"] = df["artist"].map(pricing.artist_key)
    df["title_key"] = df["title"].map(pricing.norm)
    df["bundle"] = df["title"].fillna("").str.contains(pricing.BUNDLE_RE) | ~(df["edition_size"] > 0)
    return df


def launch_frame():
    return pricing.launches(records([
        # the horse project: two works, no launch type yet, announced, 22 days to close
        (2672, "Maurizio Cattelan", "Not Afraid of Love", "MaurizioCattHorseLE26", "2026-10-15", "2026-09-21", None, 1500, "EUR", 1000, "", "SE", "3D", "Confirmed", "3.5. Pre-Launch"),
        (2671, "Maurizio Cattelan", "Novecento", "MaurizioCattHorseLE26", "2026-10-15", None, None, 1500, "EUR", 1000, "", "SE", "3D", "Confirmed", "3.5. Pre-Launch"),
        # a draw the funnel already carries under its exact title
        (3001, "Loie Hollowell", "Mother's Milk", "LoieHollowellLE26", "2026-10-26", "2026-10-05", None, 2500, "EUR", 75, "Draw", "PE", "Print", "Confirmed", "3.5. Pre-Launch"),
        # a timed launch: not the draw path
        (3002, "Bisa Butler", "Be Mine", "BisaButlerTL26", "2026-10-13", "2026-09-15", None, 750, "EUR", 300, "Timed", "PE", "Print", "Confirmed", "3.5. Pre-Launch"),
        # pitching: nothing to plan yet
        (3003, "William Mapan", "V&A fundraiser", "WilliamMapanLE26", "2026-11-24", None, None, 400, "EUR", 100, "Draw", "PE", "Print", "Confirmed", "1.4. Pitching"),
        # untyped and three months out: not a campaign yet; a draw that far out is
        (3004, "Mark Tansey", "Mont Sainte-Victoire", "MarkTanseyLE26", "2026-12-20", None, None, 900, "EUR", 150, "", "PE", "Print", "Confirmed", "03. Proofing"),
        (3005, "Seth Armstrong", "Micheltorena", "SethArmstrongLE26", "2026-12-20", None, "2026-11-10", 700, "EUR", 120, "Draw", "PE", "Print", "Confirmed", "03. Proofing"),
        # beyond the horizon, and already closed
        (3006, "Cleon Peterson", "Sculpture 2027", "CleonPetLE27", "2027-02-19", None, None, 600, "EUR", 200, "Draw", "SE", "3D", "Confirmed", "03. Proofing"),
        (3007, "Parra", "Multiple", "PietParraLE26", "2026-09-20", "2026-08-30", None, 500, "EUR", 300, "Draw", "PE", "Print", "Confirmed", "09. Fully completed"),
    ]))


EXISTING = [
    {"release_name": "Loie Hollowell · Mother's Milk · 2026 Q4", "artist": "Loie Hollowell", "title": "Mother's Milk",
     "quarter": "2026 Q4", "announce_date": "2026-10-05", "launch_end": "2026-10-26", "campaign_code": "LoieHollo_LE_26"},
    # the artist's earlier launch does not stand for the new one
    {"release_name": "Maurizio Cattelan · La Nona Ora · 2026 Q2", "artist": "Maurizio Cattelan", "title": "La Nona Ora",
     "quarter": "2026 Q2", "announce_date": "2026-04-02", "launch_end": "2026-04-23", "campaign_code": "Maurizio_NonaOra_26"},
]


def test_upcoming() -> None:
    lf = launch_frame()
    # what the feeds are doing: the horse campaign spending now, the Window
    # campaign long finished, Seth's not started
    activity = {"MaurizioCatt_HorseLE_26": (dt.date(2026, 9, 22), dt.date(2026, 9, 23)),
                "MaurizioC_LE_26": (dt.date(2026, 1, 22), dt.date(2026, 5, 18)),
                "LoieHollo_LE_26": (dt.date(2026, 10, 1), dt.date(2026, 10, 2))}
    up = build.upcoming_releases(lf, EXISTING, AS_OF, activity)
    names = [r["release_name"] for r in up]
    assert names == ["Maurizio Cattelan · Multiple · 2026 Q4", "Seth Armstrong · Micheltorena · 2026 Q4"], names
    horse, seth = up
    assert horse["id"] == "maurizio_cattelan_multiple_2026_q4" and horse["title"] == "Multiple" and horse["quarter"] == "2026 Q4"
    assert horse["announce_date"] == "2026-09-21" and horse["launch_end"] == "2026-10-15" and horse["dates_note"] is None
    assert horse["private_room_open"] == "2026-09-07"        # announce less the default lead
    assert horse["edition_size"] == 2000 and horse["unit_price"] == 1500 and horse["currency_native"] == "EUR"
    assert horse["airtable_ids"] == "2672|2671" and horse["airtable_release"] == "MaurizioCattHorseLE26"
    assert horse["campaign_code"] == "MaurizioCatt_HorseLE_26"   # the code moving in its window, not the artist's old one
    assert seth["campaign_code"] is None
    assert horse["source"] == "airtable" and horse["launch_type"] == ""
    # no announce date: assumed, and said; the private room date Airtable has is kept
    assert seth["announce_date"] == "2026-11-26" and "assumed" in seth["dates_note"]
    assert seth["dates_assumed"] is True and horse["dates_assumed"] is False
    assert seth["private_room_open"] == "2026-11-10"
    # nothing to list without the file
    assert build.upcoming_releases(None, EXISTING, AS_OF, activity) == []
    # only a code moving in the launch's window: the artist's old code alone gives nothing
    old_only = {k: v for k, v in activity.items() if k != "MaurizioCatt_HorseLE_26"}
    assert build.upcoming_releases(lf, EXISTING, AS_OF, old_only)[0]["campaign_code"] is None
    # when each code was active, from Meta's campaign names and the sends
    spend = pd.DataFrame({"campaign_name": ["MaurizioCatt_HorseLE_26 · Enter draw", "MaurizioCatt_HorseLE_26 · Enter draw", "not a code", None],
                          "spend_date": [dt.date(2026, 9, 22), dt.date(2026, 9, 23), dt.date(2026, 9, 1), dt.date(2026, 9, 1)]})
    emails = pd.DataFrame({"campaign": ["MaurizioC_LE_26", "MaurizioC_LE_26", None],
                           "sent_at": pd.to_datetime(["2026-01-22", "2026-05-18", "2026-06-01"])})
    act = build.code_activity(spend, emails)
    assert act == {"MaurizioCatt_HorseLE_26": (dt.date(2026, 9, 22), dt.date(2026, 9, 23)),
                   "MaurizioC_LE_26": (dt.date(2026, 1, 22), dt.date(2026, 5, 18))}, act
    assert build.code_activity(None, None) == {}
    print("upcoming: ok")


def test_page() -> None:
    lf = launch_frame()
    rec = build.upcoming_releases(lf, EXISTING, AS_OF, {})[0]
    snap = build.build_upcoming(rec, AS_OF, None, AS_OF)
    build.check_snapshot(snap)
    assert snap["upcoming"] is True and snap["targeted"] is False and snap["catalogue"] is False
    assert snap["windowStart"] == "2026-09-21" and snap["windowEnd"] == "2026-10-15" and snap["of"] == 24 and snap["day"] == 2
    assert snap["airtable"]["edition_size"] == 2000 and snap["airtable"]["titles"] == "Not Afraid of Love / Novecento"
    assert snap["hero"]["now"] == 0 and snap["channels"] == [] and snap["totals"]["sessions"] == 0
    row = build.index_row(snap, "upcoming")
    assert row["status"] == "upcoming" and row["windowEnd"] == "2026-10-15" and row["targeted"] is False
    order = build.sort_index([
        {"status": "closed", "windowEnd": "2026-09-01", "sessions": 1},
        {"status": "upcoming", "windowEnd": "2026-11-01", "sessions": 0},
        {"status": "live", "windowEnd": "2026-09-30", "sessions": 5},
        {"status": "upcoming", "windowEnd": "2026-10-15", "sessions": 0},
    ])
    assert [e["status"] for e in order] == ["live", "upcoming", "upcoming", "closed"]
    assert order[1]["windowEnd"] == "2026-10-15"
    print("page: ok")


def test_adoption() -> None:
    lf = launch_frame()
    # set up as the guessed name, with the Airtable ids; the funnel then names it after one work
    configured = [{"id": "maurizio_cattelan_multiple_2026_q4", "release_name": "Maurizio Cattelan · Multiple · 2026 Q4",
                   "airtable_ids": "2672|2671", "announce_date": "2026-09-21", "launch_end": "2026-10-15"}]
    discovered = [{"release_name": "Maurizio Cattelan · Not Afraid of Love · 2026 Q4", "artist": "Maurizio Cattelan",
                   "title": "Not Afraid of Love", "quarter": "2026 Q4", "announce_date": "2026-09-21", "launch_end": "2026-10-15"}]
    with tempfile.TemporaryDirectory() as d:
        saved = pathlib.Path(d) / "inputs.saved.json"
        saved.write_text(json.dumps({"releases": {"maurizio_cattelan_multiple_2026_q4": dict(configured[0])}}))
        keep = build._saved_inputs
        build._saved_inputs = saved
        try:
            renamed = build.adopt_funnel_names(configured, discovered, lf)
        finally:
            build._saved_inputs = keep
        assert renamed == [("maurizio_cattelan_multiple_2026_q4", "Maurizio Cattelan · Multiple · 2026 Q4",
                            "Maurizio Cattelan · Not Afraid of Love · 2026 Q4")], renamed
        assert configured[0]["release_name"] == "Maurizio Cattelan · Not Afraid of Love · 2026 Q4"
        assert configured[0]["adopted_from"] == "Maurizio Cattelan · Multiple · 2026 Q4"
        on_disk = json.loads(saved.read_text())["releases"]["maurizio_cattelan_multiple_2026_q4"]
        assert on_disk["release_name"] == "Maurizio Cattelan · Not Afraid of Love · 2026 Q4"
    # already in the funnel under its own name: nothing to adopt
    assert build.adopt_funnel_names(configured, discovered, lf) == []
    # no Airtable ids on the input: nothing to match by
    assert build.adopt_funnel_names([{"id": "x", "release_name": "Some · Thing · 2026 Q4"}], discovered, lf) == []
    # once adopted, the launch is represented and is not listed as upcoming again
    assert build.upcoming_releases(lf, EXISTING + configured + discovered, AS_OF, {}) == [
        r for r in build.upcoming_releases(lf, EXISTING + configured + discovered, AS_OF, {}) if r["artist"] != "Maurizio Cattelan"]
    print("adoption: ok")


# ---- the Airtable cases (data/release_pricing.csv rows, as pulled on 25 Sep 2026)

PEJAC_SHOW = (   # PejacLE26 on 13 Nov: 22 originals and the postcards, no launch type
    [(i, "Pejac", f"SELF DEFENCE [OG - Painting {k}/6]", 25000, 1, "OG") for i, k in ((3073, 1), (3071, 2), (3074, 3), (3072, 4), (3076, 5), (3075, 6))]
    + [(3077, "Pejac", "FOUR SEASONS [OG Sculpture - 4 units]", 16500, 4, "OG")]
    + [(i, "Pejac", f"LARGE FORMAT PAINTINGS [OG painting - {k}/5]", 65000, 1, "OG") for i, k in ((3078, 1), (3080, 2), (3082, 3), (3079, 4), (3081, 5))]
    + [(i, "Pejac", f"MID-FORMAT PAINTINGS [OG Painting {k}/8]", 30000, 1, "OG")
       for i, k in ((3088, 1), (3087, 2), (3085, 3), (3084, 4), (3090, 5), (3083, 6), (3086, 7), (3089, 8))]
    + [(3092, "Pejac", "Sandbags with Sandcastle [Installation 1]", 0, 1, "OG"),
       (3091, "Pejac", "Starry Night with Cartridges [Installation 2]", 0, 1, "OG"),
       (3113, "Pejac", "POSTCARDS [Details & Pricing TBC]", 0, 500, "PE")])
PEJAC_PRINTS = [   # PejacLE26 on 18 Dec: the print draw, two works in two sizes
    (2606, "Pejac", "Barbed Wire [Special Print Edition]", "PejacLE26", "2026-12-18", None, None, 3500, "EUR", 20, "", "PE", "Silkscreen print", None, "1.5. Agreed to edition"),
    (3094, "Pejac", "Barbed Wire [Standard Print Edition]", "PejacLE26", "2026-12-18", None, None, 2800, "EUR", 80, "", "PE", "Silkscreen print", None, "1.5. Agreed to edition"),
    (2807, "Pejac", "Mind Trip [Special Print Edition]", "PejacLE26", "2026-12-18", "2026-11-23", None, 2500, "EUR", 20, "", "PE", "Unique work", None, "1.5. Agreed to edition"),
    (3093, "Pejac", "Mind Trip [Standard Print Edition]", "PejacLE26", "2026-12-18", None, None, 1800, "EUR", 80, "", "PE", "Silkscreen print", None, "1.5. Agreed to edition"),
]
AIRTABLE = [
    # Matt Deslauriers and William Mapan: a 48-hour timed print with a digital-only NFT still at pitching
    (3059, "Matt Deslauriers", "V&A fundraiser [Digital only]", "MattDeslaH225", "2026-11-24", "2026-09-23", None, 250, "EUR", 500, "", "NFT", "NFT", "Pricing Target", "1.4. Pitching"),
    (1818, "Matt Deslauriers", "V&A fundraiser print", "MattDeslaH225", "2026-11-24", "2026-11-04", None, 650, "EUR", 150, "", "TL", "Digital print", "Pricing Target", "03. Proofing"),
    (3058, "William Mapan", "V&A fundraiser [Digital only]", "WilliamMapanLE26", "2026-11-24", None, None, 250, "EUR", 500, "", "NFT", "NFT", "Pricing Target", "1.4. Pitching"),
    (2194, "William Mapan", "V&A fundraiser print", "WilliamMapanLE26", "2026-11-24", "2026-11-04", None, 650, "EUR", 150, "", "TL", "Digital print", "Pricing Target", "1.5. Agreed to edition"),
    # Marina Abramović: timed editions, no launch type
    (2943, "Marina Abramović", "Energy Hat (Red) - 2026", "MarinaAbramTL26", "2026-12-10", None, None, 700, "EUR", 800, "", "TL", "Digital print", "Initial estimate", "03. Proofing"),
    (3239, "Marina Abramović", "Energy Hat (Yellow) - 2026", "MarinaAbramTL26", "2026-12-10", None, None, 700, "EUR", 800, "", "TL", "Digital print", "Initial estimate", "03. Proofing"),
    # David Wojnarowicz: a draw whose two records disagree on the announce, both passed
    (2896, "David Wojnarowicz Estate", "History Keeps Me Awake at Night", "DavidWojnLE26", "2026-10-08", "2026-09-17", None, 600, "EUR", 150, "Draw", "PE", "Hybrid print", "Confirmed", "03. Proofing"),
    (3069, "David Wojnarowicz Estate", "Inside This House", "DavidWojnLE26", "2026-10-08", "2026-09-08", None, 600, "EUR", 150, "Draw", "PE", "Hybrid print", "Confirmed", "03. Proofing"),
    # Kukwon Woo: the October draw and the two earlier launches the funnel names "Woo Kuk Won"
    (2617, "Kukwon Woo", "The Princess (Cinderella)", "KukwonWooLE26", "2026-10-29", "2026-10-01", None, 1500, "EUR", 50, "", "PE", "Digital print", "Confirmed", "03. Proofing"),
    (2954, "Kukwon Woo", "The Princess (Belle)", "KukwonWooLE26", "2026-10-29", "2026-10-01", None, 1500, "EUR", 50, "", "PE", "Digital print", "Confirmed", "03. Proofing"),
    (2276, "Kukwon Woo", "Waterfall (Kirifuri)", "KukwonWooRep25", "2025-09-30", "2025-09-02", None, 1500, "EUR", 50, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (2449, "Kukwon Woo", "Waterfall (Ono)", "KukwonWooRep25", "2025-09-30", None, None, 1500, "EUR", 50, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (2450, "Kukwon Woo", "Waterfall (Amida)", "KukwonWooRep25", "2025-09-30", None, None, 1500, "EUR", 50, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (2451, "Kukwon Woo", "Waterfall (Rōben)", "KukwonWooRep25", "2025-09-30", None, None, 1500, "EUR", 50, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (2514, "Kukwon Woo", "Waterfall (Ono) & Waterfall (Rōben)", "KukwonWooRep25", "2025-09-30", None, None, 3000, "EUR", 0, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (2515, "Kukwon Woo", "Waterfall (Kirifuri) & Waterfall (Amida)", "KukwonWooRep25", "2025-09-30", None, None, 3000, "EUR", 0, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (2516, "Kukwon Woo", "Waterfall (Kirifuri), Waterfall (Amida), Waterfall (Ono), Waterfall (Rōben)", "KukwonWooRep25", "2025-09-30", None, None, 6000, "EUR", 0, "Draw", "PE", "Hybrid print", "Confirmed", "09. Fully completed"),
    (1882, "Kukwon Woo", "Valley of the Shadow of Death", "WookukwoPairLE24", "2024-11-19", None, None, 1500, "EUR", 50, "Draw", "PE", "Digital print", "Confirmed", "09. Fully completed"),
    (2100, "Kukwon Woo", "Breakfast on the Beach", "WookukwoPairLE24", "2024-11-19", None, None, 1500, "EUR", 50, "Draw", "PE", "Digital print", "Confirmed", "09. Fully completed"),
    (2259, "Kukwon Woo", "Valley of the Shadow of Death & Breakfast on the Beach [Diptych]", "WookukwoPairLE24", "2024-11-19", None, None, 3000, "EUR", 0, "Draw", "PE", "Digital print", "Confirmed", "09. Fully completed"),
    # Seth Armstrong: a typed draw announced ahead, the control
    (2909, "Seth Armstrong", "Micheltorena", "SethArmstrongLE26", "2026-12-03", "2026-11-11", None, 900, "EUR", 100, "Draw", "PE", "Digital print", "Confirmed", "03. Proofing"),
] + [(i, a, t, "PejacLE26", "2026-11-13", None, None, p, "EUR", s, "", e, "Digital print" if e == "PE" else None, None, "1.5. Agreed to edition")
     for i, a, t, p, s, e in PEJAC_SHOW] + PEJAC_PRINTS

# the funnel's releases for Kukwon Woo, as inputs.json has them
WOO_ON_FILE = [
    {"release_name": "Woo Kuk Won · Multiple · 2024 Q4", "artist": "Woo Kuk Won", "title": "Multiple", "quarter": "2024 Q4",
     "announce_date": "2024-10-24", "launch_end": "2024-11-19", "campaign_code": "Wookukwo_PairLE_24"},
    {"release_name": "Woo Kuk Won · Multiple · 2025 Q3", "artist": "Woo Kuk Won", "title": "Multiple", "quarter": "2025 Q3",
     "announce_date": "2025-09-02", "launch_end": "2025-09-30", "campaign_code": None},
]


def airtable_frame(rows=None):
    return pricing.launches(records(rows if rows is not None else AIRTABLE))


def test_not_a_draw() -> None:
    """An untyped launch made mostly of originals, NFTs or timed editions is
    not listed as a draw; a launch half at pitching is at pitching."""
    lf = airtable_frame()
    by = {r.airtable_release + "@" + r.launch_date.date().isoformat(): r for r in lf.itertuples()}
    matt = by["MattDeslaH225@2026-11-24"]
    assert matt.edition_type_counts == {"NFT": 1, "TL": 1}, matt.edition_type_counts
    # one record pitching and one proofing: a tie, which goes to the less
    # advanced stage (by name "03. Proofing" came first and hid the pitching)
    assert matt.project_status == "1.4. Pitching", matt.project_status
    assert pricing._status_mode(pd.Series(["03. Proofing", "03. Proofing", "1.4. Pitching"])) == "03. Proofing"
    assert pricing._status_mode(pd.Series(["04. In production", "3.5. Pre-Launch"])) == "3.5. Pre-Launch"
    assert pricing._status_mode(pd.Series([None, ""])) == ""
    show = by["PejacLE26@2026-11-13"]
    assert show.n_products == 23 and show.edition_type_counts == {"OG": 22, "PE": 1}, show.edition_type_counts
    for day in (dt.date(2026, 9, 25), dt.date(2026, 10, 19)):
        up = {r["release_name"]: r for r in build.upcoming_releases(lf, [], day, {})}
        assert not any(a in n for n in up for a in ("Deslauriers", "Mapan", "Abramovi")), sorted(up)
    up = build.upcoming_releases(lf, [], dt.date(2026, 10, 19), {})
    pejac = [r for r in up if r["artist"] == "Pejac"]
    # the originals show is not listed; the print draw is, under the plain
    # name, its edition the four prints and its price their value over them
    assert [r["release_name"] for r in pejac] == ["Pejac · Multiple · 2026 Q4"], pejac
    p = pejac[0]
    assert p["id"] == "pejac_multiple_2026_q4" and p["launch_end"] == "2026-12-18" and p["announce_date"] == "2026-11-23"
    assert p["edition_size"] == 200 and p["unit_price"] == 2440 and p["n_products"] == 4, p
    # the timed print on its own, pitching NFT aside, is still no draw
    alone = airtable_frame([r for r in AIRTABLE if r[0] == 1818])
    assert build.upcoming_releases(alone, [], dt.date(2026, 9, 25), {}) == []
    # and a typed draw is Airtable's word: the same show typed Draw is listed
    typed = airtable_frame([r[:10] + ("Draw",) + r[11:] if r[3] == "PejacLE26" and r[4] == "2026-11-13" else r for r in AIRTABLE])
    assert any(r["launch_end"] == "2026-11-13" for r in build.upcoming_releases(typed, [], dt.date(2026, 10, 19), {}))
    print("not a draw: ok")


def test_second_launch_in_a_quarter() -> None:
    """Two launches of one artist in one quarter get two names and two ids."""
    # were the originals show typed a draw, both Pejac launches would list
    typed = airtable_frame([r[:10] + ("Draw",) + r[11:] if r[3] == "PejacLE26" and r[4] == "2026-11-13" else r for r in AIRTABLE])
    pejac = [r for r in build.upcoming_releases(typed, [], dt.date(2026, 10, 19), {}) if r["artist"] == "Pejac"]
    assert [(r["id"], r["release_name"]) for r in pejac] == [
        ("pejac_multiple_2026_q4", "Pejac · Multiple · 2026 Q4"),
        ("pejac_barbed_wire_mind_trip_2026_q4", "Pejac · Barbed Wire / Mind Trip · 2026 Q4")], pejac
    assert pejac[1]["title"] == "Barbed Wire / Mind Trip"
    # the funnel carries the show as "Pejac · Multiple · 2026 Q4": the print
    # draw is not lost under a name that is taken, it takes its works' name
    show = [{"release_name": "Pejac · Multiple · 2026 Q4", "artist": "Pejac", "title": "Multiple", "quarter": "2026 Q4",
             "announce_date": "2026-10-20", "launch_end": "2026-11-13"}]
    later = [r for r in build.upcoming_releases(typed, show, dt.date(2026, 10, 19), {}) if r["artist"] == "Pejac"]
    assert [r["release_name"] for r in later] == ["Pejac · Barbed Wire / Mind Trip · 2026 Q4"], later
    # the same works launched twice in the quarter: the close date tells them apart
    again = [(i + 10000, a, t, "PejacLE26b", "2026-12-21", ad, pd_, p, c, s, lt, e, pt, ps, st)
             for i, a, t, _, _, ad, pd_, p, c, s, lt, e, pt, ps, st in PEJAC_PRINTS]
    twice = [r for r in build.upcoming_releases(airtable_frame(PEJAC_PRINTS + again), [], dt.date(2026, 10, 22), {})]
    assert [r["release_name"] for r in twice] == ["Pejac · Multiple · 2026 Q4",
                                                   "Pejac · Barbed Wire / Mind Trip · 2026 Q4"], twice
    thrice = [(i + 20000, a, t, "PejacLE26c", "2026-12-23", ad, pd_, p, c, s, lt, e, pt, ps, st)
              for i, a, t, _, _, ad, pd_, p, c, s, lt, e, pt, ps, st in PEJAC_PRINTS]
    three = build.upcoming_releases(airtable_frame(PEJAC_PRINTS + again + thrice), [], dt.date(2026, 10, 24), {})
    assert [r["release_name"] for r in three][-1] == "Pejac · Barbed Wire / Mind Trip (closes 23 Dec) · 2026 Q4", three
    assert len({r["id"] for r in three}) == 3 and len({r["release_name"] for r in three}) == 3
    print("second launch in a quarter: ok")


def test_many_works() -> None:
    """A second launch in the quarter titled with its works stays a name a
    page can carry: a dozen works name the first that fit and count the
    rest, and the id, which names the page's file, is capped. One such
    launch (twelve Brillo Boxes, 28 Sep 2026) made an id of 355 characters,
    and writing its page failed the whole build with "File name too long"
    on every refresh, so the header read "Sources stale" all evening."""
    works = [f"Brillo Box Collectable ({colour} {kind}) [Standard Print Edition]"
             for kind in ("Landscape", "Portrait", "Still Life", "Abstract")
             for colour in ("Green", "Yellow", "Pink")]
    rows = [(4000 + i, "Andy Warhol", w, "AndyWarholBrilloLE26", "2026-10-14", "2026-09-20", None, 1200, "EUR", 100,
             "Draw", "PE", "Print", "Confirmed", "3.5. Pre-Launch") for i, w in enumerate(works)]
    # the artist's other draw this quarter has the plain name
    rows += [(4100, "Andy Warhol", "Flowers", "AndyWarholFlowersLE26", "2026-10-08", "2026-09-15", None, 900, "EUR", 150,
              "Draw", "PE", "Print", "Confirmed", "3.5. Pre-Launch"),
             (4101, "Andy Warhol", "Cow", "AndyWarholFlowersLE26", "2026-10-08", "2026-09-15", None, 900, "EUR", 150,
              "Draw", "PE", "Print", "Confirmed", "3.5. Pre-Launch")]
    day = dt.date(2026, 9, 28)
    ups = [r for r in build.upcoming_releases(airtable_frame(rows), [], day, {}) if r["artist"] == "Andy Warhol"]
    assert [r["title"] for r in ups][:1] == ["Multiple"], ups
    brillo = ups[1]
    assert brillo["title"] == ("Brillo Box Collectable (Green Landscape) / Brillo Box Collectable (Yellow Landscape) "
                               "and 10 more"), brillo["title"]
    assert brillo["release_name"] == f"Andy Warhol · {brillo['title']} · 2026 Q4"
    assert len(brillo["id"]) <= build.ID_MAX_CHARS and brillo["id"].startswith("andy_warhol_brillo_box_collectable_green_landscape"), brillo["id"]
    # its page builds, and its file name fits
    snap = build.build_upcoming(brillo, day, None, day)
    build.check_snapshot(snap)
    with tempfile.TemporaryDirectory() as tmp:
        (pathlib.Path(tmp) / f"{brillo['id']}.json").write_text(json.dumps(snap))
    # a title within the bound is left alone; the whole works list of a long
    # launch would have made an id no file name holds
    assert build._works_title("Barbed Wire [Special] / Barbed Wire [Standard] / Mind Trip") == "Barbed Wire / Mind Trip"
    assert len(build.slugify(" · ".join(["Andy Warhol", " / ".join(works), "2026 Q4"]))) <= build.ID_MAX_CHARS
    # the id is capped whatever the name, cut at a word and never ending in "_"
    sid = build.slugify(" · ".join(["Some Artist"] + [f"Work number {i} of the series" for i in range(40)]))
    assert len(sid) <= build.ID_MAX_CHARS and not sid.endswith("_") and sid.startswith("some_artist_work_number_0"), sid
    assert build.slugify("Pejac · Barbed Wire / Mind Trip · 2026 Q4") == "pejac_barbed_wire_mind_trip_2026_q4"
    print("many works: ok")


def test_funnel_spelling() -> None:
    """The funnel's spelling of an artist the matcher already links, so the
    upcoming page keeps its id when the funnel carries the launch."""
    lf = airtable_frame()
    day = dt.date(2026, 9, 24)
    woo = [r for r in build.upcoming_releases(lf, WOO_ON_FILE, day, {}) if "Woo" in r["artist"]]
    assert [(r["id"], r["release_name"], r["artist"]) for r in woo] == [
        ("woo_kuk_won_multiple_2026_q4", "Woo Kuk Won · Multiple · 2026 Q4", "Woo Kuk Won")], woo
    assert woo[0]["airtable_ids"] == "2617|2954"
    assert build.funnel_spellings(WOO_ON_FILE, build.airtable_ids_on_file(WOO_ON_FILE, lf), lf) == {"Kukwon Woo": "Woo Kuk Won"}
    # nothing on file for the artist: Airtable's own spelling
    alone = [r for r in build.upcoming_releases(lf, [], day, {}) if "Woo" in r["artist"]]
    assert [r["id"] for r in alone] == ["kukwon_woo_multiple_2026_q4"], alone
    # the code is guessed on the funnel's spelling, as the feeds tag it
    moving = {"Wookukwo_LE_26": (dt.date(2026, 9, 28), dt.date(2026, 9, 30))}
    assert [r["campaign_code"] for r in build.upcoming_releases(lf, WOO_ON_FILE, day, moving) if "Woo" in r["artist"]] == ["Wookukwo_LE_26"]
    # when the funnel carries it, under the name the page already has, it is no longer upcoming and the id is the same
    funnel = {"release_name": "Woo Kuk Won · Multiple · 2026 Q4", "artist": "Woo Kuk Won", "title": "Multiple", "quarter": "2026 Q4",
              "announce_date": "2026-10-01", "launch_end": "2026-10-29"}
    assert not [r for r in build.upcoming_releases(lf, WOO_ON_FILE + [funnel], dt.date(2026, 10, 2), {}) if "Woo" in r["artist"]]
    assert build.slugify(funnel["release_name"]) == woo[0]["id"]
    print("funnel spelling: ok")


def test_stale_dates() -> None:
    """An announce that has passed with nothing moving is flagged, not shown
    as a launch in the middle of its window."""
    lf = airtable_frame()
    day = dt.date(2026, 9, 24)
    wojn = next(r for r in build.upcoming_releases(lf, [], day, {}) if r["artist"] == "David Wojnarowicz Estate")
    # the earlier of the two records' dates, and a note that it has slipped
    assert wojn["announce_date"] == "2026-09-08" and wojn["launch_end"] == "2026-10-08"
    assert wojn["dates_note"] and "has passed with no spend, sends or traffic" in wojn["dates_note"], wojn["dates_note"]
    snap = build.build_upcoming(wojn, day, None, day)
    build.check_snapshot(snap)
    assert snap["derived"]["dates_note"] == wojn["dates_note"] and snap["day"] == 16 and snap["of"] == 30
    # a doubtful date is not a stand-in: the card marks only the latter "(assumed)"
    assert wojn["dates_assumed"] is False and snap["derived"]["dates_assumed"] is False
    # a code for the artist moving in the window: the launch is under way, no note
    moving = {"DavidWojn_LE_26": (dt.date(2026, 9, 8), dt.date(2026, 9, 23))}
    live = next(r for r in build.upcoming_releases(lf, [], day, moving) if r["artist"] == "David Wojnarowicz Estate")
    assert live["dates_note"] is None and live["campaign_code"] == "DavidWojn_LE_26", live
    # another artist's code moving is not this launch's activity
    other = {"MaurizioCatt_HorseLE_26": (dt.date(2026, 9, 22), dt.date(2026, 9, 23))}
    assert next(r for r in build.upcoming_releases(lf, [], day, other) if r["artist"] == "David Wojnarowicz Estate")["dates_note"]
    # no feeds to read: nothing to say
    assert next(r for r in build.upcoming_releases(lf, [], day, None) if r["artist"] == "David Wojnarowicz Estate")["dates_note"] is None
    # an announce still ahead is not flagged
    seth = next(r for r in build.upcoming_releases(lf, [], day, {}) if r["artist"] == "Seth Armstrong")
    assert seth["announce_date"] == "2026-11-11" and seth["dates_note"] is None
    print("stale dates: ok")


def test_dates_from_editions() -> None:
    """The launch's announce is its editions' own, as the Set up targets tab
    reads it (pricing.release_products), so the two cannot disagree."""
    # the 2025 Waterfall launch, with an announce put on one of its sets
    # (2516, the four together): the editions' own date stands
    rows = [r[:5] + ("2025-08-20",) + r[6:] if r[0] == 2516 else r for r in AIRTABLE if r[3] == "KukwonWooRep25"]
    lf = airtable_frame(rows)
    assert len(lf) == 1 and lf.iloc[0]["announce_date"] == pd.Timestamp("2025-09-02"), lf.iloc[0]["announce_date"]
    assert lf.iloc[0]["edition_size"] == 200 and lf.iloc[0]["n_bundles"] == 3
    with tempfile.TemporaryDirectory() as d:
        path = pathlib.Path(d) / "pricing.csv"
        frame = records(rows).drop(columns=["artist_key", "title_key", "bundle"])
        frame.to_csv(path, index=False)
        got = pricing.release_products({"release_name": "Woo Kuk Won · Multiple · 2025 Q3", "announce_date": "2025-09-02",
                                        "launch_end": "2025-09-30"}, path)
        assert got["announce_date"] == "2025-09-02" and len(got["products"]) == 4, got
        assert pricing.launches(pricing.load_pricing(path)).iloc[0]["announce_date"] == pd.Timestamp(got["announce_date"])
    # a launch with no sized record still has Airtable's dates
    sets = airtable_frame([r for r in rows if r[0] == 2516])
    assert sets.iloc[0]["announce_date"] == pd.Timestamp("2025-08-20")
    print("dates from editions: ok")


def test_spend_days() -> None:
    """A campaign's activity is its days with spend: the Meta export's zero
    rows after it stops do not keep it moving."""
    days = [dt.date(2026, 9, 1) + dt.timedelta(days=i) for i in range(24)]
    # SalvadorDali_LE_26 spent to its 11 Sep close, then 13 zero rows; Warhol still spending; a campaign that never spent
    spend = pd.DataFrame(
        [{"campaign_name": "SalvadorDali_LE_26 · Enter draw", "spend_date": d, "spend": 500.0 if d <= dt.date(2026, 9, 11) else 0.0} for d in days]
        + [{"campaign_name": "AndyWarhol_TL_26 · Enter draw", "spend_date": d, "spend": 300.0 if d >= dt.date(2026, 9, 20) else 0.0} for d in days]
        + [{"campaign_name": "Facebook_Test_2022", "spend_date": d, "spend": 0.0} for d in days[:5]])
    act = build.code_activity(spend, None)
    assert act["SalvadorDali_LE_26"] == (dt.date(2026, 9, 1), dt.date(2026, 9, 11)), act
    assert act["AndyWarhol_TL_26"] == (dt.date(2026, 9, 20), dt.date(2026, 9, 24)), act
    camps = build.meta_campaigns(spend)
    assert [c["name"] for c in camps] == ["AndyWarhol_TL_26 · Enter draw", "SalvadorDali_LE_26 · Enter draw", "Facebook_Test_2022"], camps
    assert camps[0]["last"] == "2026-09-24" and camps[1]["last"] == "2026-09-11" and camps[1]["spend"] == 5500.0
    assert camps[2]["last"] is None and camps[2]["spend"] == 0.0
    json.dumps(camps)   # written to inputs.json as it is
    print("spend days: ok")


def test_adoption_by_match() -> None:
    """A page set up by hand carries no Airtable ids; the matcher places it
    on its launch. When the funnel renames the release (its close moved into
    the next quarter and every row moved with it), the page adopts the new
    name by that launch, rather than standing empty beside a second page."""
    lf = pricing.launches(records([
        # Warhol's works under one code: the Lifesize on 30 Sep, the colourways on 14 Oct
        (3232, "The Andy Warhol Foundation", "Brillo Box Collectable (Lifesize)", "AndyWarholTL26", "2026-09-30", None, None, 2500, "EUR", 100, "Draw", "PE", "Silkscreen print", "Confirmed", "03. Proofing"),
        (3066, "The Andy Warhol Foundation", "Brillo Box Collectable (Green Landscape)", "AndyWarholTL26", "2026-10-14", "2026-09-02", None, 750, "EUR", 1000, "Draw", "PE", "Silkscreen print", "Confirmed", "3.5. Pre-Launch"),
        (3063, "The Andy Warhol Foundation", "Brillo Box Collectable (Green Portrait)", "AndyWarholTL26", "2026-10-14", "2026-09-02", None, 750, "EUR", 1000, "Draw", "PE", "Silkscreen print", "Confirmed", "3.5. Pre-Launch"),
        # the same artist's earlier launch, which must not stand for it
        (2000, "The Andy Warhol Foundation", "Flowers", "AndyWarholLE25", "2025-11-20", None, None, 900, "EUR", 300, "Draw", "PE", "Silkscreen print", "Confirmed", "09. Fully completed"),
    ]))
    assert len(lf[lf["airtable_release"] == "AndyWarholTL26"]) == 1, "one staggered launch"
    configured = [{"id": "warhol_le_26", "release_name": "Andy Warhol Estate · Multiple · 2026 Q3", "artist": "Andy Warhol Estate", "title": "Multiple",
                   "quarter": "2026 Q3", "announce_date": "2026-09-03", "launch_end": "2026-09-30"}]
    discovered = [{"release_name": "Andy Warhol Estate · Multiple · 2026 Q4", "artist": "Andy Warhol Estate", "title": "Multiple", "quarter": "2026 Q4",
                   "announce_date": "2026-09-03", "launch_end": "2026-09-30"},
                  {"release_name": "Andy Warhol Estate · Flowers · 2025 Q4", "artist": "Andy Warhol Estate", "title": "Flowers", "quarter": "2025 Q4",
                   "announce_date": "2025-10-28", "launch_end": "2025-11-20"}]
    with tempfile.TemporaryDirectory() as d:
        saved = pathlib.Path(d) / "inputs.saved.json"
        saved.write_text(json.dumps({"releases": {"warhol_le_26": dict(configured[0])}}))
        keep = build._saved_inputs
        build._saved_inputs = saved
        try:
            renamed = build.adopt_funnel_names(configured, discovered, lf)
        finally:
            build._saved_inputs = keep
        assert renamed == [("warhol_le_26", "Andy Warhol Estate · Multiple · 2026 Q3", "Andy Warhol Estate · Multiple · 2026 Q4")], renamed
        assert configured[0]["release_name"] == "Andy Warhol Estate · Multiple · 2026 Q4" and configured[0]["adopted_from"] == "Andy Warhol Estate · Multiple · 2026 Q3"
        assert json.loads(saved.read_text())["releases"]["warhol_le_26"]["release_name"] == "Andy Warhol Estate · Multiple · 2026 Q4"
    # a release the matcher cannot place is left alone; one the funnel still names is not pending
    assert build.adopt_funnel_names([{"id": "y", "release_name": "Nobody Here · Thing · 2026 Q4", "announce_date": "2026-09-03", "launch_end": "2026-09-30"}], discovered, lf) == []
    assert build.adopt_funnel_names(configured, discovered, lf) == []
    print("adoption by match: ok")


if __name__ == "__main__":
    test_upcoming()
    test_page()
    test_adoption()
    test_adoption_by_match()
    test_not_a_draw()
    test_second_launch_in_a_quarter()
    test_many_works()
    test_funnel_spelling()
    test_stale_dates()
    test_dates_from_editions()
    test_spend_days()
