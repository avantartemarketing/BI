#!/usr/bin/env python3
"""The price of a paid entry comes from the basket, on a curve (docs/METHODOLOGY.md
step 5, docs/DATA_MODEL.md 4 E, 4a.2; 9 November 2026).

Each panel launch gets what it paid for its paid entries and units - Meta's
spend under its campaign code from its window's start to the close, a code
several launches share split between them by their paid entries, over its
tracked paid entries and over its paid units with Untracked folded in - and
its price brought to the reference spend on the curve. A basket prices its
paid budget at the median of those reference prices over the members with a
reading, once three have one, the budget being the spend that buys the
entries on the curve; the release's own figure comes first, the panel's
terms stand in last. The curve's slope comes from a leave-one-out backtest.
The browser's model reads the same figures the same way. Run:
  python3 tests/test_paid_cost.py
"""
from __future__ import annotations

import datetime as dt
import json
import math
import pathlib
import random
import subprocess
import sys
import tempfile

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT / "tests"))
import baskets as B  # noqa: E402
import build  # noqa: E402
import paid_cost as PC  # noqa: E402

GROUPS = B.GROUPS
TERMS = {"k": 100.0, "reference_spend": 10000.0, "slope_bounds": [0.2, 0.7]}


def close(a, b, tol=1e-6):
    a, b = float(a), float(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def panel():
    rows = []
    # paid: the tracked paid units; folded: with the launch's Untracked units
    # shared in (unit_share_paid x all units), the count the cost is over;
    # entries: the tracked paid entries
    for name, start, close_, end, units, paid, folded, entries in (
        ("A · One · 2026 Q1", "2026-01-10", "2026-01-29", "2026-02-01", 400, 19, 20, 25),   # 1000 to the close / 20 folded, / 25 entries
        ("B · Two · 2026 Q1", "2026-01-10", "2026-01-29", "2026-02-01", 300, 3, 3, 4),      # too few paid units and entries
        ("C · Three · 2026 Q1", "2026-01-10", "2026-01-29", "2026-02-01", 200, 12, 12, 15),  # no campaign code
        ("D · Four · 2026 Q1", "2026-01-10", "2026-01-29", "2026-02-01", 250, 8, 8, 9),     # code with no spend on file
        ("E · Five · 2026 Q2", "2026-04-01", "2026-04-17", "2026-04-20", 350, 10, 10, 12),  # 900 / 10, / 12 entries
        ("F · Six · 2026 Q2", "2026-04-01", "2026-04-17", "2026-04-20", 150, 25, 25, 20),   # 2500 / 25, / 20 entries
        ("G · Seven · 2026 Q2", "2026-05-01", "2026-05-20", "2026-05-23", 300, 20, 20, 30),  # shares GH_LE_26's 3000 with H: 3/4 of it
        ("H · Eight · 2026 Q2", "2026-05-01", "2026-05-20", "2026-05-23", 100, 8, 8, 10),    # ... and 1/4
    ):
        r = {"release_name": name, "artist": name.split(" · ")[0], "window_start": start, "close": close_, "window_end": end,
             "tot_total_product_units": units, "tot_sessions_total": units * 100, "tot_draw_entries_eligible_units": units * 1.2,
             "campaign_days": 22, "units_paid": paid, "entries_paid": entries, "units_per_buyer": 1.2, "private_room_share": 0.1,
             "unit_price_eur": 1000.0}
        for g in GROUPS:
            r[f"unit_share_{g}"] = 0.2
            r[f"sess_share_{g}"] = 0.2
            r[f"conv_sess_entry_{g}"] = 0.01
        r["unit_share_paid"] = folded / units
        rows.append(r)
    return pd.DataFrame(rows)


def spend():
    d = dt.date
    return pd.DataFrame({
        "campaign_name": ["A_LE_26 · Enter draw", "A_LE_26 · Enter draw", "A_LE_26 · Awareness", "A_LE_26 · Enter draw",
                          "B_LE_26 · Enter draw", "E_LE_26 · Enter draw", "F_LE_26", "F_LE_26", "Z_LE_26 · Enter draw",
                          "GH_LE_26 · Enter draw", "GH_LE_26 · Enter draw"],
        "spend_date": [d(2026, 1, 12), d(2026, 1, 20), d(2025, 12, 20), d(2026, 1, 31),
                       d(2026, 1, 15), d(2026, 4, 5), d(2026, 4, 2), d(2026, 4, 16), d(2026, 4, 2),
                       d(2026, 5, 3), d(2026, 5, 15)],
        "spend": [600.0, 400.0, 999.0, 700.0, 300.0, 900.0, 1500.0, 1000.0, 50.0, 2000.0, 1000.0],
    })


CODES = {"A · One · 2026 Q1": "A_LE_26", "B · Two · 2026 Q1": "B_LE_26", "D · Four · 2026 Q1": "D_LE_26",
         "E · Five · 2026 Q2": "E_LE_26", "F · Six · 2026 Q2": "F_LE_26",
         "G · Seven · 2026 Q2": "GH_LE_26", "H · Eight · 2026 Q2": "GH_LE_26"}


def costed_panel():
    return B.attach_paid_costs(panel(), spend(), CODES, slope=0.5, terms=TERMS)


def test_attach() -> None:
    p = costed_panel()
    by = p.set_index("release_name")
    # December's awareness spend is before the window, and the 700 on 31
    # January after the close: the page never counts spend past its close
    assert by.loc["A · One · 2026 Q1", "paid_spend_eur"] == 1000.0
    # over the 20 paid units with Untracked folded in, not the 19 tracked
    assert by.loc["A · One · 2026 Q1", "cost_per_paid_unit"] == 50.0
    # and over the 25 tracked paid entries; the units over the entries is the rate
    assert by.loc["A · One · 2026 Q1", "paid_entries"] == 25.0 and by.loc["A · One · 2026 Q1", "cost_per_paid_entry"] == 40.0
    assert close(by.loc["A · One · 2026 Q1", "paid_entry_to_unit"], 0.8)
    # the price at the reference spend on the curve, at the slope given
    assert close(by.loc["A · One · 2026 Q1", "cost_per_entry_ref"], PC.reference_price(40.0, 1000.0, 0.5, 100.0, 10000.0))
    assert by.loc["A · One · 2026 Q1", "cost_per_entry_ref"] > 40.0   # a small spend pays under the reference
    # a row without a close keeps its window's end
    no_close = B.attach_paid_costs(panel().drop(columns=["close"]), spend(), CODES, slope=0.5, terms=TERMS).set_index("release_name")
    assert no_close.loc["A · One · 2026 Q1", "paid_spend_eur"] == 1700.0 and no_close.loc["A · One · 2026 Q1", "cost_per_paid_unit"] == 85.0
    # and one without the shares divides by its tracked paid units, as before
    unfolded = B.attach_paid_costs(panel().drop(columns=["unit_share_paid"]), spend(), CODES, slope=0.5, terms=TERMS).set_index("release_name")
    assert abs(unfolded.loc["A · One · 2026 Q1", "cost_per_paid_unit"] - 1000.0 / 19) < 1e-9
    # too few paid units and entries: spend on file, no reading
    assert by.loc["B · Two · 2026 Q1", "paid_spend_eur"] == 300.0 and pd.isna(by.loc["B · Two · 2026 Q1", "cost_per_paid_unit"])
    assert pd.isna(by.loc["B · Two · 2026 Q1", "cost_per_paid_entry"]) and pd.isna(by.loc["B · Two · 2026 Q1", "cost_per_entry_ref"])
    assert pd.isna(by.loc["C · Three · 2026 Q1", "paid_spend_eur"]) and pd.isna(by.loc["C · Three · 2026 Q1", "cost_per_paid_unit"])
    assert pd.isna(by.loc["D · Four · 2026 Q1", "cost_per_paid_unit"])
    assert by.loc["E · Five · 2026 Q2", "cost_per_paid_unit"] == 90.0 and by.loc["F · Six · 2026 Q2", "cost_per_paid_unit"] == 100.0
    assert by.loc["E · Five · 2026 Q2", "cost_per_paid_entry"] == 75.0 and by.loc["F · Six · 2026 Q2", "cost_per_paid_entry"] == 125.0
    # a code two launches share: the campaign's 3000 is split by their paid
    # entries (30 and 10), the whole 3000 standing as each one's place on the
    # curve, so the two read one price per entry
    assert by.loc["G · Seven · 2026 Q2", "paid_spend_campaign_eur"] == 3000.0 == by.loc["H · Eight · 2026 Q2", "paid_spend_campaign_eur"]
    assert close(by.loc["G · Seven · 2026 Q2", "paid_spend_eur"], 2250.0) and close(by.loc["H · Eight · 2026 Q2", "paid_spend_eur"], 750.0)
    assert close(by.loc["G · Seven · 2026 Q2", "cost_per_paid_entry"], 75.0) and close(by.loc["H · Eight · 2026 Q2", "cost_per_paid_entry"], 75.0)
    assert close(by.loc["G · Seven · 2026 Q2", "cost_per_entry_ref"], by.loc["H · Eight · 2026 Q2", "cost_per_entry_ref"])
    assert close(by.loc["G · Seven · 2026 Q2", "cost_per_paid_unit"], 2250.0 / 20) and close(by.loc["H · Eight · 2026 Q2", "cost_per_paid_unit"], 750.0 / 8)
    # ... and equal shares when neither has an entry
    blank = panel()
    blank.loc[blank.release_name.isin(["G · Seven · 2026 Q2", "H · Eight · 2026 Q2"]), "entries_paid"] = 0
    eq = B.attach_paid_costs(blank, spend(), CODES, slope=0.5, terms=TERMS).set_index("release_name")
    assert close(eq.loc["G · Seven · 2026 Q2", "paid_spend_eur"], 1500.0) and close(eq.loc["H · Eight · 2026 Q2", "paid_spend_eur"], 1500.0)
    # a panel without the entries column prices units as before, entries not at all
    no_entries = B.attach_paid_costs(panel().drop(columns=["entries_paid"]), spend(), CODES, slope=0.5, terms=TERMS).set_index("release_name")
    assert no_entries.loc["A · One · 2026 Q1", "cost_per_paid_unit"] == 50.0 and no_entries["cost_per_paid_entry"].isna().all()
    # without the feed or the codes the columns are there and empty, and the
    # panel's terms price nothing
    for c in B.PAID_COST_COLUMNS:
        assert B.attach_paid_costs(panel(), None, CODES, terms=TERMS)[c].isna().all()
        assert B.attach_paid_costs(panel(), spend(), {}, terms=TERMS)[c].isna().all()
    assert B.PAID_COST["reference_price"] == 0.0 and B.PAID_COST["slope"] == 0.2
    # the picker's rows carry the readings
    rows = {r["release_name"]: r for r in B.candidate_rows(costed_panel())}
    assert rows["A · One · 2026 Q1"]["cost_per_paid_unit"] == 50.0 and rows["C · Three · 2026 Q1"]["cost_per_paid_unit"] is None
    assert rows["A · One · 2026 Q1"]["cost_per_paid_entry"] == 40.0 and rows["A · One · 2026 Q1"]["paid_spend"] == 1000.0
    assert rows["A · One · 2026 Q1"]["cost_per_entry_ref"] > 0 and rows["C · Three · 2026 Q1"]["cost_per_entry_ref"] is None
    print("attach: ok")


def test_curve() -> None:
    ref, w, k, s = 150.0, 0.5, 100.0, 10000.0
    # at the reference spend the average price is the reference price
    assert close(PC.average_price(s, ref, w, k, s), ref)
    # it rises with the spend, and the last entry costs more than the average
    assert PC.average_price(2 * s, ref, w, k, s) > ref > PC.average_price(s / 2, ref, w, k, s)
    assert PC.marginal_price(s, ref, w, k, s) > ref
    assert close(PC.marginal_price(s, ref, w, k, s), ref * (k + s) / (k + s - w * s))
    # the budget for the entries a spend buys is that spend: the inverse holds
    for spend_ in (100.0, 2500.0, 10000.0, 80000.0):
        e = PC.entries_for_spend(spend_, ref, w, k, s)
        assert close(PC.spend_for_entries(e, ref, w, k, s), spend_, 1e-7), spend_
    # buying twice the entries costs more than twice: the budget is convex
    assert PC.spend_for_entries(200, ref, w, k, s) > 2 * PC.spend_for_entries(100, ref, w, k, s)
    # a launch's price brought to the reference spend reads back as its own
    assert close(PC.average_price(30000.0, PC.reference_price(240.0, 30000.0, w, k, s), w, k, s), 240.0)
    # nothing to buy, nothing to pay
    assert PC.spend_for_entries(0, ref, w, k, s) == 0.0 and PC.entries_for_spend(0, ref, w, k, s) == 0.0
    assert PC.spend_for_entries(50, 0.0, w, k, s) == 0.0
    print("curve: ok")


def test_backtest() -> None:
    # launches on a curve of slope 0.45 from a reference price of 120, each
    # a little off it: the backtest finds the slope and prefers the curve
    rnd = random.Random(7)
    rows = []
    for i in range(16):
        spend_ = 600.0 * (1.35 ** i)
        cpe = PC.average_price(spend_, 120.0, 0.45, 100.0, 10000.0) * math.exp(rnd.gauss(0.0, 0.15))
        rows.append({"release": f"L{i}", "cpe": cpe, "spend": spend_, "entries": 30 + 10 * i,
                     "price": 500.0 + 100.0 * (i % 5), "demand": 100.0 + 20.0 * i, "entry_to_unit": 0.9 + 0.02 * (i % 4)})
    bt = PC.backtest(rows, 100.0, 10000.0)
    assert bt["n"] == 16 and abs(bt["slope"] - 0.45) <= 0.1, bt["slope"]
    est = bt["estimators"]
    assert est[f"curve_{bt['slope']:.2f}"]["median_abs_log"] < est["panel_median"]["median_abs_log"]
    assert bt["best"].startswith("curve_"), bt["best"]
    assert 0 < bt["range_low"] < 1 < bt["range_high"] and bt["spread"] > 0
    # the terms: the slope held to the bounds, the reference price near 120
    t = PC.panel_terms(rows, None, 100.0, 10000.0, (0.2, 0.7))
    assert t["slope"] == bt["slope"] and t["slope_source"] == "backtest" and abs(t["reference_price"] - 120.0) < 25.0, t
    assert 0.9 <= t["entry_to_unit"] <= 0.96 and t["n"] == 16
    held = PC.panel_terms(rows, None, 100.0, 10000.0, (0.2, 0.3))
    assert held["slope"] <= 0.3 and held["slope_source"] == "backtest"
    given = PC.panel_terms(rows, 0.6, 100.0, 10000.0, (0.2, 0.7))
    assert given["slope"] == 0.6 and given["slope_source"] == "given" and given["backtest"]["estimators"] == {}
    # too few launches with a reading worth scoring: no slope from the data, no price
    thin = PC.panel_terms(rows[:5], None, 100.0, 10000.0, (0.2, 0.7))
    assert thin["slope"] == 0.2 and thin["slope_source"] == "floor" and thin["reference_price"] == 0.0
    # the fixture's panel is too thin to backtest, so attach_paid_costs with no
    # slope given keeps the floor; the live panel is scored on every build
    B.attach_paid_costs(panel(), spend(), CODES, terms=TERMS)
    assert B.PAID_COST["slope"] == 0.2 and B.PAID_COST["slope_source"] == "floor"
    print(f"backtest: ok (slope {bt['slope']}, curve x{est[f'curve_{bt['slope']:.2f}']['typical_miss']} against median x{est['panel_median']['typical_miss']})")


def test_profile_and_price() -> None:
    p = costed_panel()
    three = B.basket_profile(p, ["A · One · 2026 Q1", "E · Five · 2026 Q2", "F · Six · 2026 Q2", "C · Three · 2026 Q1"])
    assert three["n_costed"] == 3 and three["cost_per_purchase"] == 90.0, (three["n_costed"], three["cost_per_purchase"])
    assert three["n_costed_entries"] == 3 and three["cost_per_entry"] == 75.0
    by = p.set_index("release_name")
    refs = sorted(by.loc[n, "cost_per_entry_ref"] for n in ("A · One · 2026 Q1", "E · Five · 2026 Q2", "F · Six · 2026 Q2"))
    assert close(three["cost_per_entry_ref"], refs[1]) and close(three["paid_entry_to_unit"], 10.0 / 12.0)
    two = B.basket_profile(p, ["A · One · 2026 Q1", "E · Five · 2026 Q2", "B · Two · 2026 Q1"])
    assert two["n_costed"] == 2 and two["cost_per_purchase"] == 0.0        # under the member floor: no basket price
    assert two["n_costed_entries"] == 2 and two["cost_per_entry_ref"] == 0.0 and two["paid_entry_to_unit"] == 0.0
    plain = B.basket_profile(panel(), ["A · One · 2026 Q1"])                 # a panel without the columns
    assert plain["n_costed"] == 0 and plain["cost_per_purchase"] == 0.0 and plain["cost_per_entry_ref"] == 0.0
    # the flat price per unit, as it was, and where the price came from
    median = build.BENCH["cost_per_purchase"]["Median"]
    assert build.cost_per_purchase_for({}, profile=three) == 90.0 and build.cost_per_purchase_source({}, profile=three) == "basket"
    assert build.cost_per_purchase_for({"cost_per_purchase": 210}, profile=three) == 210.0
    assert build.cost_per_purchase_source({"cost_per_purchase": 210}, profile=three) == "release"
    assert build.cost_per_purchase_source({"cost_per_entry": 90}, profile=two) == "release"
    assert build.cost_per_purchase_for({}, profile=two) == median and build.cost_per_purchase_source({}, profile=two) == "panel"
    assert build.cost_per_purchase_for({}) == median and build.cost_per_purchase_for({"cpp_pick": "High"}) == build.BENCH["cost_per_purchase"]["High"]
    # channels off keeps the prices on the profile
    off = B.apply_channels_off(three, ["aa_social"])
    assert off["cost_per_purchase"] == 90.0 and off["cost_per_entry_ref"] == three["cost_per_entry_ref"]
    print("profile and price: ok")


def test_pricing() -> None:
    p = costed_panel()
    three = B.basket_profile(p, ["A · One · 2026 Q1", "E · Five · 2026 Q2", "F · Six · 2026 Q2"])
    bench = dict(build.BENCH)
    bench.pop("paid_cost", None)
    curve = dict(bench, paid_cost={"slope": 0.5, "k": 100.0, "reference_spend": 10000.0, "reference_price": 150.0, "entry_to_unit": 1.1})
    units, e2o = 60.0, 0.8
    e2u = three["paid_entry_to_unit"]
    # the basket's curve: the entries at its rate, the budget the spend that buys them
    pr = build.paid_pricing({}, bench, three, units, e2o)
    assert pr["cost_source"] == "basket" and pr["cost_basis"] == "curve" and pr["cost_slope"] == 0.5
    assert close(pr["entries"], units / e2u) and close(pr["entry_to_unit"], e2u)
    assert close(pr["budget"], PC.spend_for_entries(units / e2u, three["cost_per_entry_ref"], 0.5, 100.0, 10000.0))
    assert close(pr["cost_per_purchase"], pr["budget"] / units) and close(pr["cost_per_entry"], pr["budget"] / pr["entries"])
    assert pr["marginal_cost_per_entry"] > pr["cost_per_entry"] and close(pr["cost_per_entry_ref"], three["cost_per_entry_ref"])
    # convex: twice the units, more than twice the budget
    assert build.paid_pricing({}, bench, three, 2 * units, e2o)["budget"] > 2 * pr["budget"]
    # a typed cost per unit, then a typed cost per entry, come first and price flat
    own = build.paid_pricing({"cost_per_purchase": 210}, bench, three, units, e2o)
    assert own["cost_source"] == "release" and own["cost_basis"] == "unit" and close(own["budget"], units * 210) and own["cost_per_purchase"] == 210.0
    assert close(own["cost_per_entry"], 210 * e2u) and own["cost_slope"] is None and own["cost_per_entry_ref"] is None
    own_e = build.paid_pricing({"cost_per_entry": 100}, bench, three, units, e2o)
    assert own_e["cost_source"] == "release" and own_e["cost_basis"] == "entry" and close(own_e["budget"], units / e2u * 100)
    assert close(own_e["cost_per_entry"], 100.0) and close(own_e["cost_per_purchase"], 100.0 / e2u)
    both = build.paid_pricing({"cost_per_purchase": 210, "cost_per_entry": 100}, bench, three, units, e2o)
    assert both["cost_basis"] == "unit" and close(both["budget"], units * 210)
    # a basket costed per unit only (an older snapshot) prices flat at it
    unit_only = {k: v for k, v in three.items() if k not in ("cost_per_entry_ref", "cost_per_entry", "paid_entry_to_unit", "n_costed_entries")}
    flat = build.paid_pricing({}, curve, unit_only, units, e2o)
    assert flat["cost_source"] == "basket" and flat["cost_basis"] == "unit" and close(flat["budget"], units * 90.0)
    assert close(flat["entries"], units / 1.1)   # the panel's rate, the basket having none
    # the panel's curve, then the constant per unit while the panel is thin
    two = B.basket_profile(p, ["A · One · 2026 Q1", "B · Two · 2026 Q1"])
    pan = build.paid_pricing({}, curve, two, units, e2o)
    assert pan["cost_source"] == "panel" and pan["cost_basis"] == "curve"
    assert close(pan["budget"], PC.spend_for_entries(units / 1.1, 150.0, 0.5, 100.0, 10000.0))
    const = build.paid_pricing({}, bench, two, units, e2o)
    assert const["cost_source"] == "panel" and const["cost_basis"] == "unit" and close(const["budget"], units * build.BENCH["cost_per_purchase"]["Median"])
    assert close(const["entries"], units / e2o)   # no rate anywhere: the entry rate the page runs on
    assert build.paid_pricing({"cpp_pick": "High"}, bench, None, units, e2o)["cost_per_purchase"] == build.BENCH["cost_per_purchase"]["High"]
    # nothing to buy: no budget, the price still stated
    none = build.paid_pricing({}, curve, three, 0.0, e2o)
    assert none["budget"] == 0.0 and none["entries"] == 0.0 and none["cost_per_purchase"] > 0 and none["cost_per_entry"] > 0
    # the Direct switch never moves the money: the basket's prices take the
    # paid group's scale (spread_profile), the entries the units', and the
    # curve reads entries x reference price (test_direct_spread holds the
    # flat case)
    norm = {"units": 0.5, "sessions": 0.6, "entries": 0.55, "n": 20, "recentMonths": 18}
    base = dict(three, units=800.0, sessions=40000.0, entries=700.0,
                units_by_group={"aa_email": 300.0, "aa_social": 50.0, "referral_artist": 30.0, "organic_search": 0.0, "direct_other": 220.0, "paid": 200.0},
                sessions_by_group={"aa_email": 10000.0, "aa_social": 2000.0, "referral_artist": 500.0, "organic_search": 0.0, "direct_other": 7500.0, "paid": 20000.0},
                share_units={}, share_sessions={})
    rel = {"edition_size": 1600.0, "unit_price": 1000.0, "units_per_buyer": 1.0}
    for name, r, prof in (("the basket's curve", rel, base), ("a typed cost per entry", dict(rel, cost_per_entry=120), base),
                          ("the panel's curve", rel, dict(base, cost_per_entry_ref=0.0, n_costed_entries=0, cost_per_purchase=0.0, n_costed=0))):
        b = curve if "panel" in name else bench
        t0 = build.benchmark_targets(r, prof) if b is bench else None
        sp = build.spread_profile(prof, norm)
        p0 = build.paid_pricing(r, b, prof, 200.0, 0.8)
        p1 = build.paid_pricing(r, b, sp, 200.0 / sp["cost_scale"], 0.8)   # the paid units after the spread
        assert close(p1["budget"], p0["budget"]) and p1["cost_source"] == p0["cost_source"], (name, p0["budget"], p1["budget"])
        if t0 is not None:
            t1 = build.benchmark_targets(r, sp)
            assert close(t1["paid"]["budget"], t0["paid"]["budget"]) and t1["paid"]["units"] > t0["paid"]["units"], name
    # the targets carry the pricing, and the budget is the units at the average price
    t = build.benchmark_targets(dict(rel, units_per_buyer=1.25), B.apply_channels_off(base, []))
    assert t["paid"]["cost_source"] == "basket" and t["paid"]["cost_basis"] == "curve"
    assert close(t["paid"]["budget"], t["paid"]["units"] * t["paid"]["cost_per_purchase"])
    assert close(t["paid"]["budget"], PC.spend_for_entries(t["paid"]["entries"], base["cost_per_entry_ref"], 0.5, 100.0, 10000.0))
    # the summary line the build logs
    line = build.paid_cost_summary(dict(curve["paid_cost"], n=27, slope_source="backtest",
                                        backtest={"estimators": {"curve_0.50": {"typical_miss": 1.39, "within_half": 0.52},
                                                                 "panel_median": {"typical_miss": 1.53, "within_half": 0.48}}}))
    assert "EUR 150 an entry" in line and "x1.39" in line and "52% within half" in line, line
    assert "too thin" in build.paid_cost_summary({"n": 3, "reference_price": 0.0})
    print("pricing: ok")


def test_js_agrees() -> None:
    from test_channels_off import live_cases
    cases = live_cases()[:9]
    terms = {"slope": 0.5, "k": 100.0, "reference_spend": 10000.0, "reference_price": 150.0, "entry_to_unit": 1.1}
    bench = dict(build.BENCH, paid_cost=terms)
    payload = {"bench": {k: bench[k] for k in ("eligible_entry_to_order", "cost_per_purchase", "budget_sense_check_max_pct_of_launch_value",
                                               "paid_cost", "cpe_wearout_k", "paid_cost_reference_spend", "paid_cost_slope_bounds")},
               "cases": []}
    expect = []
    for i, c in enumerate(cases):
        # the price's source turn by turn: the basket's curve, the panel's
        # curve, a typed cost per unit, a typed cost per entry, a basket costed
        # per unit only, and the lot read with Direct spread
        prof = dict(c["profile"], cost_per_entry_ref=[123.0, 0.0, 123.0, 123.0, 0.0][i % 5], paid_entry_to_unit=[0.9, 0.0, 0.9, 0.9, 0.0][i % 5],
                    n_costed_entries=[4, 0, 4, 4, 0][i % 5], cost_per_purchase=[140.0, 0.0, 140.0, 140.0, 140.0][i % 5], n_costed=[4, 0, 4, 4, 4][i % 5])
        if i >= 5:
            # read with Direct spread: the scale the paid units took (build.spread_profile)
            prof["cost_scale"] = 0.9
        inp = {"edition_size": c["release"]["edition_size"], "unit_price": c["release"]["unit_price"],
               "cost_per_purchase": 210 if i % 5 == 2 else None, "cost_per_entry": 95 if i % 5 == 3 else None, "units_per_buyer": 1.25}
        payload["cases"].append({"name": c["name"], "off": [], "profile": prof, "inp": inp})
        r = dict(c["release"], cost_per_purchase=inp["cost_per_purchase"], cost_per_entry=inp["cost_per_entry"], channels_off=[], units_per_buyer=1.25)
        # the Python side with the same bench
        bench_was = dict(build.BENCH)
        build.BENCH.clear(); build.BENCH.update(bench)
        try:
            t = build.benchmark_targets(r, B.apply_channels_off(prof, []))
        finally:
            build.BENCH.clear(); build.BENCH.update(bench_was)
        expect.append((c["name"], t["paid"]))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "channels_off_parity.mjs"), "--cases", path], capture_output=True, text=True, check=True)
    got = {r["name"]: r["targets"] for r in json.loads(res.stdout)}
    sources, bases = set(), set()
    for name, paid in expect:
        jt = got[name]
        jp = jt["paid"]
        for key in ("budget", "entries", "entry_to_unit", "cost_per_purchase", "cost_per_entry", "marginal_cost_per_entry"):
            assert close(jp[key], paid[key]), (name, key, paid[key], jp[key])
        for key in ("cost_source", "cost_basis", "cost_per_purchase_source"):
            assert jp[key] == paid[key], (name, key, paid[key], jp[key])
        assert (jp["cost_per_entry_ref"] is None) == (paid["cost_per_entry_ref"] is None)
        assert jt["cost_per_purchase_source"] == paid["cost_source"] and close(jt["cost_per_purchase"], paid["cost_per_purchase"])
        sources.add(paid["cost_source"]); bases.add(paid["cost_basis"])
    assert sources == {"panel", "basket", "release"} and bases == {"curve", "unit", "entry"}, (sources, bases)
    print(f"js agrees: ok over {len(expect)} cases")


if __name__ == "__main__":
    test_attach()
    test_curve()
    test_backtest()
    test_profile_and_price()
    test_pricing()
    test_js_agrees()
