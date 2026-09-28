#!/usr/bin/env python3
"""The benchmark panel is read with guards and checked against the pages.

data/release_clusters.csv is written by hand, after a full pull, by
etl/analysis/release_clusters.py; the pages are rebuilt every hour. So:

  * a per-channel conversion that cannot be a rate (under 100 sessions, or
    more than a quarter of an entry or unit per session) is emptied where the
    panel is read and where it is written (Albers 2026 Q2: 44 AA Social
    entries on 57 sessions);
  * a launch whose units run past 1.5x its edition or the orders feed is left
    out (two 2023-24 draws the funnel counts twice);
  * the script records Direct's share of its own group, the attribution it
    read and the day it ran, and the build reads the Direct norm from there;
  * the build warns, never stops, when a closed page's units split has moved
    more than 0.05 from its own panel row, and when a launch the panel still
    has in flight closed a settle period ago.

Run:
  python3 tests/test_panel_guards.py
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import pathlib
import sys
import tempfile

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402
import build  # noqa: E402

spec = importlib.util.spec_from_file_location("release_clusters", ROOT / "etl" / "analysis" / "release_clusters.py")
RC = importlib.util.module_from_spec(spec)
spec.loader.exec_module(RC)

GROUPS = B.GROUPS


def rates_frame() -> pd.DataFrame:
    rows = []
    for name, s, e, u in (("Fine · A · 2026 Q1", 2000, 60, 30),       # 3% a session: a rate
                          ("Albers-like · B · 2026 Q2", 57, 44, 24),   # thin, and 77% a session
                          ("Thin · C · 2026 Q2", 80, 2, 1),            # under the session floor
                          ("Booked elsewhere · D · 2026 Q2", 400, 150, 20)):  # 150 entries on 400 sessions
        r = {"release_name": name}
        for g in GROUPS:
            r.update({f"sessions_{g}": 1000.0, f"entries_{g}": 30.0, f"units_{g}": 10.0,
                      f"conv_sess_entry_{g}": 0.03, f"conv_sess_unit_{g}": 0.01})
        r.update({"sessions_aa_social": float(s), "entries_aa_social": float(e), "units_aa_social": float(u),
                  "conv_sess_entry_aa_social": e / s, "conv_sess_unit_aa_social": u / s})
        rows.append(r)
    return pd.DataFrame(rows)


def test_rates() -> None:
    f = rates_frame()
    bad = B.implausible_rates(f)
    assert bad["aa_social"].tolist() == [False, True, True, True], bad["aa_social"].tolist()
    assert not any(bad[g].any() for g in GROUPS if g != "aa_social")
    out, notes = B.guard_rates(f)
    assert out["conv_sess_entry_aa_social"].isna().tolist() == [False, True, True, True]
    assert out["conv_sess_unit_aa_social"].isna().tolist() == [False, True, True, True]
    assert out.loc[0, "conv_sess_entry_aa_social"] == 0.03 and out["conv_sess_entry_aa_email"].eq(0.03).all()
    assert any(n.startswith("Albers-like · B · 2026 Q2: aa_social 44 entries on 57 sessions") for n in notes), notes
    assert len(notes) == 3 and f["conv_sess_entry_aa_social"].notna().all(), "the input is left alone"
    # the median a basket takes skips the emptied rate as missing history
    prof = B.basket_profile(out.assign(tot_total_product_units=100.0, tot_sessions_total=5000.0),
                            ["Fine · A · 2026 Q1", "Albers-like · B · 2026 Q2"])
    assert abs(prof["conv"]["aa_social"] - 0.03) < 1e-12, prof["conv"]
    print("rates: ok")


def test_units() -> None:
    f = pd.DataFrame({"release_name": ["doubled", "over the edition", "fine", "no edition", "feed does not know"],
                      "tot_total_product_units": [196.0, 160.0, 98.0, 500.0, 300.0],
                      "edition_size": [np.nan, 100.0, 100.0, np.nan, 250.0]})
    orders = pd.Series([98.0, 150.0, 98.0, np.nan, np.nan])
    assert B.units_out_of_line(f, orders).tolist() == [True, True, False, False, False]
    assert B.units_out_of_line(f).tolist() == [False, True, False, False, False], "no feed: the edition alone"
    # nothing sold in the window says the windows disagree, not that the count doubled
    assert not B.units_out_of_line(f.iloc[[2]], pd.Series([0.0], index=[2])).any()
    # the orders feed over each row's own window
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "units_paid.csv"
        pd.DataFrame({"release": ["R", "R", "R"], "order_date": ["2024-04-01", "2024-04-20", "2024-07-01"],
                      "units_paid": [40, 41, 9]}).to_csv(p, index=False)
        w = pd.DataFrame({"release_name": ["R", "S"], "window_start": pd.to_datetime(["2024-03-30", "2024-03-30"]),
                          "window_end": pd.to_datetime(["2024-06-01", "2024-06-01"])})
        got = B.orders_in_window(w, p)
        assert got.iloc[0] == 81.0 and pd.isna(got.iloc[1]), got.tolist()
        assert B.orders_in_window(w, pathlib.Path(d) / "missing.csv") is None
    print("units: ok")


def test_committed_panel() -> None:
    """The committed panel, read with the guards: the two launches the funnel
    counts twice are out, Albers' AA Social rate is empty, nothing else is."""
    raw = pd.read_csv(B.PANEL_PATH, low_memory=False)
    raw = raw[raw["panel"] == "draw"]
    panel = B.load_panel()
    names = set(panel["release_name"])
    assert "Johnson Tsang · Open the Right Mind · 2023 Q4" not in names and "Kaï · Content · 2024 Q2" not in names
    assert set(B.GUARDED["units"]) == {"Johnson Tsang · Open the Right Mind · 2023 Q4", "Kaï · Content · 2024 Q2"}, B.GUARDED
    assert len(panel) == len(raw) - 2
    albers = panel[panel["release_name"] == "Anni and Josef Albers · Multiple · 2026 Q2"].iloc[0]
    assert pd.isna(albers["conv_sess_entry_aa_social"]) and albers["conv_sess_entry_aa_email"] > 0
    # the picker's rows carry the same: the rate is null, the launch is there
    rows = {r["release_name"]: r for r in B.candidate_rows(panel)}
    assert rows["Anni and Josef Albers · Multiple · 2026 Q2"]["convs"]["aa_social"] is None
    assert "Kaï · Content · 2024 Q2" not in rows
    assert all(v is None or v <= B.RATE_MAX_PER_SESSION for r in rows.values() for v in r["convs"].values())
    print(f"committed panel: ok ({len(panel)} launches, {len(B.GUARDED['rates'])} rates emptied)")


def test_unsettled_and_basis() -> None:
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "panel.csv"
        pd.DataFrame({"release_name": ["Closed long ago", "Closed last week", "Still open", "Settled"],
                      "exclude_reason": [B.IN_FLIGHT, B.IN_FLIGHT, B.IN_FLIGHT, None],
                      "close": ["2026-09-09", "2026-09-17", "2026-09-25", "2026-08-01"],
                      "attribution_basis": ["funnel, split touch"] * 4, "attribution_through": ["2026-09-10"] * 4,
                      "panel_built": ["2026-09-11"] * 4}).to_csv(p, index=False)
        due = B.unsettled(dt.date(2026, 9, 24), p)
        assert [r["release_name"] for r in due] == ["Closed long ago", "Closed last week"], due
        assert B.unsettled(dt.date(2026, 9, 23), p)[-1]["release_name"] == "Closed long ago"
        assert B.panel_basis(p) == {"attribution": "funnel, split touch", "through": "2026-09-10", "built": "2026-09-11"}
        assert B.unsettled(dt.date(2026, 9, 24), pathlib.Path(d) / "missing.csv") == []
    # the committed panel records none of it yet: the baskets file's day stands in
    basis = B.panel_basis()
    assert basis["through"] and (basis["attribution"] is None) == ("attribution_basis" not in pd.read_csv(B.PANEL_PATH, nrows=1).columns)
    msg = build.panel_unsettled(dt.date(2026, 9, 24))
    due = B.unsettled(dt.date(2026, 9, 24))
    assert (msg is None) == (not due) and all(r["release_name"] in msg for r in due)
    print(f"unsettled and basis: ok ({len(due)} owed on the committed panel at 2026-09-24)")


def daily(name: str = "T · Test · 2026 Q2") -> tuple[pd.DataFrame, pd.Series]:
    """One launch's daily funnel, all of it on one day inside the window."""
    day = pd.Timestamp("2026-04-15")
    per = {  # channel: sessions, eligible entry units, units
        "AA Email Man": (1000, 50, 20), "AA Meta": (57, 44, 24), "Referral Artist": (400, 150, 20),
        "Direct": (600, 30, 12), "Organic Search": (200, 10, 8), "Paid Social": (2000, 60, 30), "Untracked": (0, 5, 5)}
    rows = []
    for ch, (s, e, u) in per.items():
        r = {m: 0.0 for m in RC.METRICS}
        r.update({"channel": ch, "event_date": day, "simple_release_name": name, "campaign_stage": "launch",
                  "Sessions_Total": float(s), "Draw_Entries_Eligible_Units": float(e), "Draw_Entries": float(e),
                  "Total_Product_Units": float(u), "Product_Units_Draw": float(u), "Page_Views_Total": 2.0 * s})
        rows.append(r)
    df = pd.DataFrame(rows)
    df["group"] = df["channel"].map(RC.GROUP_OF)
    df["entries_all"] = df["Draw_Entries"] + df["Preorder_App"]
    w = pd.Series({"release_name": name, "announce": dt.date(2026, 4, 10), "close": dt.date(2026, 4, 20),
                   "alloc_day": dt.date(2026, 4, 20)})
    return df, w


def test_panel_script() -> None:
    df, w = daily()
    f = RC.campaign_features(df, w)
    assert abs(f["conv_sess_entry_aa_email"] - 0.05) < 1e-12 and abs(f["conv_sess_entry_paid"] - 0.03) < 1e-12
    assert np.isnan(f["conv_sess_entry_aa_social"]) and np.isnan(f["conv_sess_unit_aa_social"]), "57 sessions, 44 entries"
    assert np.isnan(f["conv_sess_entry_referral_artist"]), "150 entries on 400 sessions"
    assert abs(f["conv_sess_entry_search_direct_other"] - 40 / 800) < 1e-12
    assert "aa_social 44 entries, 24 units on 57 sessions" in f["rates_dropped"] and "referral_artist" in f["rates_dropped"]
    # Direct's share of its own group, per metric, from the same pull as the split
    assert abs(f["direct_in_group_sessions"] - 0.75) < 1e-12 and abs(f["direct_in_group_entries"] - 0.75) < 1e-12
    assert abs(f["direct_in_group_units"] - 0.6) < 1e-12
    # the units check leaves a doubled launch out of both panels, with the reason
    panel = pd.DataFrame({"release_name": ["doubled", "fine", "trace"], "panel": ["draw", "draw", None],
                          "exclude_reason": [None, None, "fewer than 10 entries and 10 units"],
                          "tot_total_product_units": [196.0, 98.0, 3.0],
                          "window_start": pd.to_datetime(["2023-08-11"] * 3), "window_end": pd.to_datetime(["2023-10-28"] * 3)})
    real_pricing, real_orders = RC.attach_pricing, B.orders_in_window
    try:
        RC.attach_pricing = lambda p: p.assign(edition_size=100.0)
        B.orders_in_window = lambda p, path=None: pd.Series(98.0, index=p.index)
        out = RC.flag_units(panel)
    finally:
        RC.attach_pricing, B.orders_in_window = real_pricing, real_orders
    assert pd.isna(out.loc[0, "panel"]) and out.loc[1, "panel"] == "draw" and out.loc[0, "exclude_reason"] == RC.UNITS_REASON
    assert out.loc[2, "exclude_reason"] == "fewer than 10 entries and 10 units"
    print("panel script: ok")


def test_direct_norm_from_panel() -> None:
    at = pd.DataFrame(columns=["simple_release_name", "event_date", "channel"])
    pool = pd.DataFrame({"release_name": [f"L{i}" for i in range(9)], "window_start": [pd.Timestamp("2026-06-01")] * 9,
                         "window_end": [pd.Timestamp("2026-07-01")] * 9,
                         "direct_in_group_sessions": [0.64] * 9, "direct_in_group_entries": [0.7] * 9,
                         "direct_in_group_units": [0.72, np.nan, 0.74] * 3})
    n = build.direct_share_norm(at, pool, dt.date(2026, 9, 24))
    assert n["source"] == "panel" and n["units"] == 0.73 and n["sessions"] == 0.64 and n["recentMonths"] == B.RECENT_MONTHS, n
    n = build.direct_share_norm(at, pool.assign(direct_in_group_units=np.nan), dt.date(2026, 9, 24))
    assert n["source"] == "feed", "a column the panel has but never filled is not a reading"
    print("direct norm: ok")


def test_drift_warnings() -> None:
    panel = pd.DataFrame([{"release_name": "Z · Multiple · 2026 Q3", **{f"unit_share_{g}": v for g, v in
                           zip(GROUPS, (0.475, 0.0, 0.0, 0.288, 0.237))}}])

    def page(now, complete=True):
        return {"id": "z_le_26", "releaseName": "Z · Multiple · 2026 Q3", "complete": complete, "benchmark": {"units": 115},
                "channels": [{"key": g, "now": v} for g, v in zip(GROUPS, now)]}
    moved = page((10.3, 0.0, 0.0, 39.5, 15.1))            # Zeng Fanzhi's page after the 24 Sep re-attribution
    msg = build.panel_drift(moved, panel)
    assert msg and msg.startswith("panel: z_le_26") and "aa_email 0.16 on the page" in msg and "up to 0.32" in msg, msg
    assert build.panel_drift(page((29.0, 0.0, 0.0, 17.6, 14.5)), panel) is None, "within 0.05 on every group"
    assert build.panel_drift(page((10.3, 0.0, 0.0, 39.5, 15.1), complete=False), panel) is None, "a live page is still moving"
    assert build.panel_drift({**moved, "releaseName": "Not in the panel"}, panel) is None
    assert build.panel_drift(moved, None) is None
    broken = build.panel_drift({**moved, "channels": [{"key": "aa_email", "now": "n/a"}]}, panel)
    assert broken and "could not run" in broken, "a bad page is a warning, never an exception"
    n0 = len(build.PANEL_WARNINGS)
    build.warn_panel(msg)
    build.warn_panel(None)
    assert len(build.PANEL_WARNINGS) == n0 + 1
    print("drift warnings: ok")


if __name__ == "__main__":
    test_rates()
    test_units()
    test_committed_panel()
    test_unsettled_and_basis()
    test_panel_script()
    test_direct_norm_from_panel()
    test_drift_warnings()
