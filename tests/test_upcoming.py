#!/usr/bin/env python3
"""Upcoming launches from Airtable (docs/DATA_MODEL.md 1.7).

A draw Airtable knows and the funnel report does not yet is listed as an
upcoming release, named the way the funnel will name it, with Airtable's
dates, edition and price as the defaults its targets start from; a launch a
release on file already represents is not; and a release set up before the
funnel saw it takes the funnel's name once it appears. Run:
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
    df["bundle"] = ~(df["edition_size"] > 0)
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
    assert horse["edition_size"] == 2000 and horse["unit_price"] == 1275 and horse["currency_native"] == "EUR"
    assert horse["airtable_ids"] == "2672|2671" and horse["airtable_release"] == "MaurizioCattHorseLE26"
    assert horse["campaign_code"] == "MaurizioCatt_HorseLE_26"   # the code moving in its window, not the artist's old one
    assert seth["campaign_code"] is None
    assert horse["source"] == "airtable" and horse["launch_type"] == ""
    # no announce date: assumed, and said; the private room date Airtable has is kept
    assert seth["announce_date"] == "2026-11-26" and "assumed" in seth["dates_note"]
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


if __name__ == "__main__":
    test_upcoming()
    test_page()
    test_adoption()
