#!/usr/bin/env python3
"""The price of a paid unit comes from the basket (docs/DATA_MODEL.md 4 E, 4a.2).

Each panel launch gets a cost per paid unit - Meta's spend under its campaign
code inside its window over the paid units the funnel attributed - and a
basket prices its paid budget at the median over the members with a reading,
once three have one; the release's own figure comes first, the panel's
constant stands in last. The browser's model reads the same figure the same
way. Run:
  python3 tests/test_paid_cost.py
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import subprocess
import sys
import tempfile

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT / "tests"))
import baskets as B  # noqa: E402
import build  # noqa: E402

GROUPS = B.GROUPS


def panel():
    rows = []
    for name, start, end, units, paid in (
        ("A · One · 2026 Q1", "2026-01-10", "2026-02-01", 400, 20),   # spend inside the window: 1000 / 20
        ("B · Two · 2026 Q1", "2026-01-10", "2026-02-01", 300, 3),    # too few paid units
        ("C · Three · 2026 Q1", "2026-01-10", "2026-02-01", 200, 12),  # no campaign code
        ("D · Four · 2026 Q1", "2026-01-10", "2026-02-01", 250, 8),   # code with no spend on file
        ("E · Five · 2026 Q2", "2026-04-01", "2026-04-20", 350, 10),  # 900 / 10
        ("F · Six · 2026 Q2", "2026-04-01", "2026-04-20", 150, 25),   # 2500 / 25
    ):
        r = {"release_name": name, "artist": name.split(" · ")[0], "window_start": start, "window_end": end,
             "tot_total_product_units": units, "tot_sessions_total": units * 100, "tot_draw_entries_eligible_units": units * 1.2,
             "campaign_days": 22, "units_paid": paid, "units_per_buyer": 1.2, "private_room_share": 0.1}
        for g in GROUPS:
            r[f"unit_share_{g}"] = 0.2
            r[f"sess_share_{g}"] = 0.2
            r[f"conv_sess_entry_{g}"] = 0.01
        rows.append(r)
    return pd.DataFrame(rows)


def spend():
    d = dt.date
    return pd.DataFrame({
        "campaign_name": ["A_LE_26 · Enter draw", "A_LE_26 · Enter draw", "A_LE_26 · Awareness", "B_LE_26 · Enter draw",
                          "E_LE_26 · Enter draw", "F_LE_26", "F_LE_26", "Z_LE_26 · Enter draw"],
        "spend_date": [d(2026, 1, 12), d(2026, 1, 20), d(2025, 12, 20), d(2026, 1, 15),
                       d(2026, 4, 5), d(2026, 4, 2), d(2026, 4, 19), d(2026, 4, 2)],
        "spend": [600.0, 400.0, 999.0, 300.0, 900.0, 1500.0, 1000.0, 50.0],
    })


CODES = {"A · One · 2026 Q1": "A_LE_26", "B · Two · 2026 Q1": "B_LE_26", "D · Four · 2026 Q1": "D_LE_26",
         "E · Five · 2026 Q2": "E_LE_26", "F · Six · 2026 Q2": "F_LE_26"}


def test_attach() -> None:
    p = B.attach_paid_costs(panel(), spend(), CODES)
    by = p.set_index("release_name")
    assert by.loc["A · One · 2026 Q1", "paid_spend_eur"] == 1000.0     # December's awareness spend is outside the window
    assert by.loc["A · One · 2026 Q1", "cost_per_paid_unit"] == 50.0
    assert by.loc["B · Two · 2026 Q1", "paid_spend_eur"] == 300.0 and pd.isna(by.loc["B · Two · 2026 Q1", "cost_per_paid_unit"])
    assert pd.isna(by.loc["C · Three · 2026 Q1", "paid_spend_eur"]) and pd.isna(by.loc["C · Three · 2026 Q1", "cost_per_paid_unit"])
    assert pd.isna(by.loc["D · Four · 2026 Q1", "cost_per_paid_unit"])
    assert by.loc["E · Five · 2026 Q2", "cost_per_paid_unit"] == 90.0 and by.loc["F · Six · 2026 Q2", "cost_per_paid_unit"] == 100.0
    # without the feed or the codes the columns are there and empty
    assert B.attach_paid_costs(panel(), None, CODES)["cost_per_paid_unit"].isna().all()
    assert B.attach_paid_costs(panel(), spend(), {})["cost_per_paid_unit"].isna().all()
    # the picker's rows carry the reading
    rows = {r["release_name"]: r for r in B.candidate_rows(p)}
    assert rows["A · One · 2026 Q1"]["cost_per_paid_unit"] == 50.0 and rows["C · Three · 2026 Q1"]["cost_per_paid_unit"] is None
    print("attach: ok")


def test_profile_and_price() -> None:
    p = B.attach_paid_costs(panel(), spend(), CODES)
    three = B.basket_profile(p, ["A · One · 2026 Q1", "E · Five · 2026 Q2", "F · Six · 2026 Q2", "C · Three · 2026 Q1"])
    assert three["n_costed"] == 3 and three["cost_per_purchase"] == 90.0, (three["n_costed"], three["cost_per_purchase"])
    two = B.basket_profile(p, ["A · One · 2026 Q1", "E · Five · 2026 Q2", "B · Two · 2026 Q1"])
    assert two["n_costed"] == 2 and two["cost_per_purchase"] == 0.0        # under the member floor: no basket price
    plain = B.basket_profile(panel(), ["A · One · 2026 Q1"])                 # a panel without the columns
    assert plain["n_costed"] == 0 and plain["cost_per_purchase"] == 0.0
    # the price precedence, and where it came from
    median = build.BENCH["cost_per_purchase"]["Median"]
    assert build.cost_per_purchase_for({}, profile=three) == 90.0 and build.cost_per_purchase_source({}, profile=three) == "basket"
    assert build.cost_per_purchase_for({"cost_per_purchase": 210}, profile=three) == 210.0
    assert build.cost_per_purchase_source({"cost_per_purchase": 210}, profile=three) == "release"
    assert build.cost_per_purchase_for({}, profile=two) == median and build.cost_per_purchase_source({}, profile=two) == "panel"
    assert build.cost_per_purchase_for({}) == median and build.cost_per_purchase_for({"cpp_pick": "High"}) == build.BENCH["cost_per_purchase"]["High"]
    # channels off keeps the price on the profile
    assert B.apply_channels_off(three, ["aa_social"])["cost_per_purchase"] == 90.0
    print("profile and price: ok")


def test_js_agrees() -> None:
    from test_channels_off import live_cases
    cases = live_cases()[:6]
    payload = {"bench": {k: build.BENCH[k] for k in ("eligible_entry_to_order", "cost_per_purchase", "budget_sense_check_max_pct_of_launch_value")},
               "cases": []}
    expect = []
    for i, c in enumerate(cases):
        prof = dict(c["profile"], cost_per_purchase=[0.0, 123.0, 123.0][i % 3], n_costed=[0, 4, 4][i % 3])
        inp = {"edition_size": c["release"]["edition_size"], "unit_price": c["release"]["unit_price"],
               "cost_per_purchase": 210 if i % 3 == 2 else None, "units_per_buyer": 1.25}
        payload["cases"].append({"name": c["name"], "off": [], "profile": prof, "inp": inp})
        r = dict(c["release"], cost_per_purchase=inp["cost_per_purchase"], channels_off=[], units_per_buyer=1.25)
        t = build.benchmark_targets(r, B.apply_channels_off(prof, []))
        expect.append((c["name"], t["paid"]["cost_per_purchase"], t["paid"]["cost_per_purchase_source"], t["paid"]["budget"]))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "channels_off_parity.mjs"), "--cases", path], capture_output=True, text=True, check=True)
    got = {r["name"]: r["targets"] for r in json.loads(res.stdout)}
    sources = set()
    for name, cpp, source, budget in expect:
        jt = got[name]
        assert abs(jt["cost_per_purchase"] - cpp) < 1e-6 and jt["cost_per_purchase_source"] == source, (name, cpp, source, jt["cost_per_purchase"], jt["cost_per_purchase_source"])
        assert abs(jt["paid"]["budget"] - budget) < 1e-6 * max(1.0, budget), (name, budget, jt["paid"]["budget"])
        sources.add(source)
    assert sources == {"panel", "basket", "release"}, sources
    print(f"js agrees: ok over {len(expect)} cases")


if __name__ == "__main__":
    test_attach()
    test_profile_and_price()
    test_js_agrees()
