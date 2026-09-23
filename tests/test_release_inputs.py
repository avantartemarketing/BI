#!/usr/bin/env python3
"""A release's inputs from where they come (docs §1.6): Airtable's products
with the typed figures over them, the totals that follow, the dates by
source, and the JS mirror agreeing with the Python.  Run:
  python3 tests/test_release_inputs.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402
import pricing  # noqa: E402


def close(a, b, tol=1e-6):
    a, b = float(a), float(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


AT = [   # what etl/pricing.py release_products hands back for one launch
    {"airtable_id": "11", "name": "Red", "project_code": "TEST-11", "edition": 100, "edition_size": 100.0, "units_target": 40.0,
     "target_sellthrough": 0.4, "unit_price": 1000.0, "currency": "EUR", "artist_profit_per_unit": 300.0,
     "aa_profit_per_unit": 400.0, "aa_revenue_share": None, "aa_profit_share": 0.5, "frame_conversion": 0.5,
     "frame_profit_per_unit": 100.0, "framing": "Framed on order", "framing_available": True,
     "launch_date": "2026-09-30", "announce_date": "2026-09-02", "private_room_date": None, "marketing_lead": "Clare"},
    {"airtable_id": "12", "name": "Blue", "project_code": "TEST-12", "edition": 50, "edition_size": 50.0, "units_target": None,
     "target_sellthrough": None, "unit_price": 2000.0, "currency": "EUR", "artist_profit_per_unit": None,
     "aa_profit_per_unit": None, "aa_revenue_share": 0.3, "aa_profit_share": None, "frame_conversion": None,
     "frame_profit_per_unit": None, "framing": "No framing option", "framing_available": False,
     "launch_date": "2026-09-30", "announce_date": "2026-09-03", "private_room_date": "2026-08-20", "marketing_lead": "Clare"},
]


def test_products_and_totals() -> None:
    b = build.BENCH
    at = {"match": "exact", "note": "", "products": [dict(p) for p in AT], "launch_date": "2026-09-30",
          "announce_date": "2026-09-02", "private_room_date": "2026-08-20", "marketing_lead": "Clare"}
    keep = pricing.release_products
    pricing.release_products = lambda r, pricing_path=None: at
    try:
        base = {"id": "t", "release_name": "Test Artist · Multiple · 2026 Q3", "campaign_code": "TestArtist_LE_26",
                "announce_date": "2026-09-01", "launch_end": "2026-09-28"}
        r = build.resolve_release(dict(base), None, {})
        assert r["economics_mode"] == "products", r["economics_mode"]
        red, blue = r["economics_products"]
        # Airtable's figures in force, the target as units target over edition
        assert red["target_units"] == 40 and blue["target_units"] == 50 and r["edition_size"] == 90 and r["edition_total"] == 150
        assert close(red["unit_price_gbp"], 850.0) and close(blue["unit_price_gbp"], 1700.0)
        assert close(r["launch_value"], 40 * 850 + 50 * 1700) and r["launch_currencies"] == ["EUR"]
        # the artist's profit per unit: weighted over the products that have one
        assert close(r["artist_profit"] / r["edition_size"], 300.0)
        # the deal: Red a profit share (AA carries 50% of the ads), Blue a
        # revenue share (AA carries them all), weighted by target units
        assert red["deal"] == "profit share" and blue["deal"] == "revenue share"
        assert close(r["aa_budget_share"], (40 * 0.5 + 50 * 1.0) / 90) and r["deal"] == ["profit share", "revenue share"]
        # framing: Red frames at its own terms, Blue does not; the uplift is
        # spread over every target unit
        assert red["frame_uplift_per_unit"] == 50.0 and blue["frame_uplift_per_unit"] == 0.0
        assert close(r["frame_uplift_per_unit"], 40 * 50 / 90)
        assert close(build.aa_profit_per_unit(r), 400.0 + 40 * 50 / 90)
        # dates: typed over Airtable, the private room from Airtable where nothing was typed
        assert r["announce_date"] == "2026-09-01" and r["input_sources"]["announce_date"] == "typed"
        assert r["private_room_open"] == "2026-08-20" and r["input_sources"]["private_room_open"] == "airtable"
        assert r["marketing_lead"] == "Clare" and r["input_sources"]["marketing_lead"] == "airtable"

        # Notion first, then typed, then the funnel's clock, then Airtable
        n = {"TestArtist_LE_26": {"private_room_open": "2026-08-25", "announce_date": None, "launch_end": None}}
        r2 = build.resolve_release(dict(base, clock_dates={"announce_date": "2026-09-04", "launch_end": "2026-09-29", "private_room_open": None}), None, n)
        assert r2["private_room_open"] == "2026-08-25" and r2["input_sources"]["private_room_open"] == "notion"
        assert r2["announce_date"] == "2026-09-01" and r2["input_sources"]["announce_date"] == "typed"
        r3 = build.resolve_release({k: v for k, v in base.items() if k not in ("announce_date", "launch_end")}
                                   | {"clock_dates": {"announce_date": "2026-09-04", "launch_end": "2026-09-29", "private_room_open": None}}, None, {})
        assert r3["announce_date"] == "2026-09-04" and r3["input_sources"]["announce_date"] == "clock"

        # typed figures over Airtable's, a product added by hand, a draw entry left alone
        typed = [{"airtable_id": "11", "target_sellthrough": 0.5, "aa_profit_share": 0.6},
                 {"manual": True, "name": "Print set", "edition": 20, "unit_price": 500, "currency": "GBP"},
                 {"key": "draw_1", "name": "Red draw", "edition": None, "preorderRate": 0.9}]
        r4 = build.resolve_release(dict(base, products=typed), None, {})
        by = {p["name"]: p for p in r4["economics_products"]}
        assert set(by) == {"Red", "Blue", "Print set"}, set(by)
        assert by["Red"]["target_units"] == 50 and by["Red"]["sources"]["target_sellthrough"] == "typed"
        assert by["Red"]["aa_budget_share"] == 0.6 and by["Print set"]["unit_price_gbp"] == 500.0
        assert r4["edition_size"] == 120 and r4["edition_total"] == 170
        assert build.draw_products_typed(r4) == [typed[2]]

        # the release-level figures a release still carries stand in for its totals
        r5 = build.resolve_release(dict(base, legacy_economics={"edition_size": 200, "edition_total": 300, "unit_price": 900,
                                                               "artist_profit": 20000, "aa_group_profit": 40000, "artist_profit_share": 0}), None, {})
        assert r5["economics_mode"] == "release" and r5["edition_size"] == 200 and r5["edition_total"] == 300
        assert r5["aa_budget_share"] == 1.0 and close(build.aa_profit_per_unit(r5), 200.0 + 0.35 * 94)
        assert len(r5["economics_products"]) == 2, "the products are still read beside the legacy totals"
        # ... and the old top-level shape reads the same way
        r6 = build.resolve_release(dict(base, edition_size=200, unit_price=900, artist_profit=20000, aa_group_profit=40000, artist_profit_share=0.5), None, {})
        assert r6["economics_mode"] == "release" and r6["aa_budget_share"] == 0.5 and r6["legacy_economics"]["edition_size"] == 200

        # nothing sized anywhere: no economics, no target
        pricing.release_products = lambda r, pricing_path=None: {"match": "none", "note": "artist not in the Airtable pull", "products": [],
                                                                  "launch_date": None, "announce_date": None, "private_room_date": None, "marketing_lead": None}
        r7 = build.resolve_release(dict(base), None, {})
        assert r7["economics_mode"] == "none" and r7.get("edition_size") is None
        # campaigns: the list saved, else the draw campaign for the code
        spend = pd.DataFrame({"campaign_name": ["TestArtist_LE_26 · Enter draw", "TestArtist_LE_26 · Purchases", "Other · Enter draw"],
                              "spend_date": pd.to_datetime(["2026-09-01"] * 3).date, "spend": [10.0, 5.0, 1.0]})
        r8 = build.resolve_release(dict(base), spend, {})
        assert r8["campaign_names"] == ["TestArtist_LE_26 · Enter draw"] and r8["input_sources"]["campaigns"] == "matched"
        assert build.match_campaigns("TestArtist_LE_26", spend) == ["TestArtist_LE_26 · Enter draw", "TestArtist_LE_26 · Purchases"]
        r9 = build.resolve_release(dict(base, campaign_names=["TestArtist_LE_26 · Purchases"]), spend, {})
        assert r9["campaign_name"] == "TestArtist_LE_26 · Purchases" and r9["input_sources"]["campaigns"] == "saved"
        r10 = build.resolve_release({k: v for k, v in base.items() if k != "campaign_code"} | {"campaign_names": ["Nobody_LE_27 · Enter draw"]}, spend, {})
        assert r10["campaign_code"] == "Nobody_LE_27" and r10["input_sources"]["campaign_code"] == "campaigns"
    finally:
        pricing.release_products = keep
    print("products and totals: ok")


def test_airtable_products_join() -> None:
    """release_products on a small pricing file: the launch's sized records
    become products, bundles do not, and the dates and lead ride along."""
    rows = [
        {"airtable_id": 1, "project_code": "P-1", "artist": "Test Artist", "title": "Red", "release": "TestArtistLE26", "unit_price": 1000,
         "currency": "EUR", "edition_size": 100, "units_target": 40, "launch_type": "Draw", "edition_type": "PE", "launch_date": "2026-09-30",
         "announce_date": "2026-09-02", "private_room_date": "", "quarter": "2026-Q3", "framing": "Framed on order", "target_sellthrough": "",
         "expected_sellthrough": "", "artist_profit_per_unit": 300, "aa_profit_per_unit": "", "aa_revenue_share": "", "aa_profit_share": 0.5,
         "frame_conversion": "", "frame_profit_per_unit": "", "marketing_lead": "Clare", "price_status": "Confirmed", "product_type": "Print"},
        {"airtable_id": 2, "project_code": "P-2", "artist": "Test Artist", "title": "Red [Set of 2]", "release": "TestArtistLE26", "unit_price": 1900,
         "currency": "EUR", "edition_size": "", "units_target": "", "launch_type": "Draw", "edition_type": "PE", "launch_date": "2026-09-30",
         "announce_date": "", "private_room_date": "", "quarter": "2026-Q3", "framing": "", "target_sellthrough": "", "expected_sellthrough": "",
         "artist_profit_per_unit": "", "aa_profit_per_unit": "", "aa_revenue_share": "", "aa_profit_share": "", "frame_conversion": "",
         "frame_profit_per_unit": "", "marketing_lead": "", "price_status": "", "product_type": "Bundle"},
        {"airtable_id": 3, "project_code": "P-3", "artist": "Other Artist", "title": "Green", "release": "OtherLE26", "unit_price": 500,
         "currency": "EUR", "edition_size": 10, "units_target": "", "launch_type": "Draw", "edition_type": "PE", "launch_date": "2026-09-30",
         "announce_date": "", "private_room_date": "", "quarter": "2026-Q3", "framing": "", "target_sellthrough": "", "expected_sellthrough": "",
         "artist_profit_per_unit": "", "aa_profit_per_unit": "", "aa_revenue_share": "", "aa_profit_share": "", "frame_conversion": "",
         "frame_profit_per_unit": "", "marketing_lead": "", "price_status": "", "product_type": "Print"},
    ]
    with tempfile.TemporaryDirectory() as d:
        path = pathlib.Path(d) / "pricing.csv"
        pd.DataFrame(rows).to_csv(path, index=False)
        got = pricing.release_products({"release_name": "Test Artist · Multiple · 2026 Q3", "announce_date": "2026-09-01", "launch_end": "2026-09-28"}, path)
        assert got["match"] == "artist+window", got
        assert [p["name"] for p in got["products"]] == ["Red"], got["products"]
        p = got["products"][0]
        assert p["edition"] == 100 and p["target_sellthrough"] == 0.4 and p["unit_price"] == 1000.0 and p["currency"] == "EUR"
        assert p["artist_profit_per_unit"] == 300.0 and p["aa_profit_share"] == 0.5 and p["framing_available"] is True
        assert got["announce_date"] == "2026-09-02" and got["launch_date"] == "2026-09-30" and got["marketing_lead"] == "Clare"
        none = pricing.release_products({"release_name": "Nobody · Thing · 2026 Q3", "announce_date": "2026-09-01", "launch_end": "2026-09-28"}, path)
        assert none["match"] == "none" and none["products"] == []
    print("airtable products join: ok")


def test_js_agrees() -> None:
    b = build.BENCH
    cases = [
        {"name": "airtable only", "airtable": AT, "typed": [], "legacy": None},
        {"name": "typed over airtable, manual product", "airtable": AT,
         "typed": [{"airtable_id": "11", "target_sellthrough": 0.5, "aa_profit_share": 0.6, "frame_conversion": 0.2},
                   {"manual": True, "name": "Print set", "edition": 20, "unit_price": 500, "currency": "GBP", "aa_revenue_share": 0.3},
                   {"key": "draw_1", "name": "Red draw", "edition": None, "preorderRate": 0.9}], "legacy": None},
        {"name": "legacy totals", "airtable": AT, "typed": [],
         "legacy": {"edition_size": 200, "edition_total": 300, "unit_price": 900, "artist_profit": 20000, "aa_group_profit": 40000, "artist_profit_share": 0}},
        {"name": "nothing sized", "airtable": [], "typed": [{"manual": True, "name": "x", "unit_price": 10}], "legacy": None},
    ]
    payload = {"bench": {k: b[k] for k in ("frame_conversion", "frame_profit_per_unit")}, "cases": cases}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "release_inputs_parity.mjs"), "--cases", path], capture_output=True, text=True, check=True)
    got = {r["name"]: r for r in json.loads(res.stdout)}
    bad = []
    keep = pricing.release_products
    current = {"products": []}
    pricing.release_products = lambda r, pricing_path=None: {"match": "exact" if current["products"] else "none", "note": "", "products": current["products"],
                                                              "launch_date": None, "announce_date": None, "private_room_date": None, "marketing_lead": None}
    for c in cases:
        current["products"] = [dict(p) for p in c["airtable"]]
        py_products = [build._effective_product(p, b) for p in build._merge_products(c["airtable"], c["typed"])]
        js = got[c["name"]]
        assert [p["name"] for p in py_products] == [p["name"] for p in js["products"]], (c["name"], [p["name"] for p in js["products"]])
        for pp, jp in zip(py_products, js["products"]):
            for key in ("edition", "target_sellthrough", "target_units", "unit_price", "unit_price_gbp", "artist_profit_per_unit",
                        "aa_profit_per_unit", "aa_revenue_share", "aa_profit_share", "frame_conversion", "frame_profit_per_unit",
                        "frame_uplift_per_unit", "aa_budget_share"):
                a, bb = pp.get(key), jp.get(key)
                ok = (a is None and bb is None) or (a is not None and bb is not None and close(a, bb))
                if not ok:
                    bad.append((c["name"], pp["name"], key, a, bb))
            if pp["deal"] != jp["deal"] or pp["framing_available"] != jp["framing_available"] or pp["sources"] != jp["sources"]:
                bad.append((c["name"], pp["name"], "deal/framing/sources", (pp["deal"], pp["framing_available"], pp["sources"]), (jp["deal"], jp["framing_available"], jp["sources"])))
        r = build.resolve_release({"id": "t", "release_name": "Test Artist · Multiple · 2026 Q3", "products": c["typed"],
                                   "legacy_economics": c["legacy"], "announce_date": "2026-09-01", "launch_end": "2026-09-28"}, None, {})
        je = js["economics"]
        if r["economics_mode"] != je["mode"]:
            bad.append((c["name"], "-", "mode", r["economics_mode"], je["mode"]))
        if r["economics_mode"] != "none":
            for key, py in (("edition_size", r["edition_size"]), ("edition_total", r.get("edition_total") or r["edition_size"]),
                            ("launch_value", r["launch_value"]), ("ppu_artist", (r["artist_profit"] or 0) / r["edition_size"]),
                            ("ppu_aa", build.aa_profit_per_unit(r)), ("aa_budget_share", r["aa_budget_share"])):
                if not close(py, je[key]):
                    bad.append((c["name"], "-", key, py, je[key]))
    pricing.release_products = keep
    assert not bad, "\n".join(str(x) for x in bad[:12])
    print(f"js agrees: ok over {len(cases)} cases")


if __name__ == "__main__":
    # the resolver must not read the real Airtable pull in the first test: it is patched there
    test_products_and_totals()
    test_airtable_products_join()
    test_js_agrees()
