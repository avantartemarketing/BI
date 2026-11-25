#!/usr/bin/env python3
"""The Spend levels of a timed launch gathering signups (etl/tl.py spend_levels).

A draw launch's card says what to spend a day; a timed launch's page said what
paid returned and nothing of what to spend (25 November 2026). These cases hold
the timed launch's reading to: a level where the spend pays, the cautious one
and not the point estimate's; tomorrow's budget within the pacing rule's step
of today's; a profit that is surer at a small spend than a big one; the worth
of a signup counted among what is unsure; the budget's own pace marked and no
cap; and a stop where no spend pays. Run:
  python3 tests/test_tl_spend_levels.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build as B  # noqa: E402
import tl  # noqa: E402


def path(price=11.0, days=13, spent=4100.0, day=850.0):
    """The cost path of a launch a week in: a signup at `price` over the last three days at `day` a day."""
    return B.CostPath(price, day, spent - day, spent, days, 0.3, 0.2, 100.0)


def levels(**kw):
    args = dict(signups_window=230.0, gain=21.4, share=0.4, today=1110.0, biggest_day=1110.0, paid_now=424.0, budget_left=68000.0, target_signups=8034.0, value_log_sd=0.6, cannibalisation=0.1)
    p = kw.pop("path", None) or path()
    args.update(kw)
    return tl.spend_levels(B, p, args.pop("signups_window"), args.pop("gain"), args.pop("share"), args.pop("today"), **args)


def test_a_level_where_the_spend_pays():
    lv = levels()
    assert lv["unit"] == "signup" and lv["stop"] is None and lv["sellout"] is None and lv["edition"] is None
    assert lv["recommended"] > lv["today"], "a signup worth 21 that costs AA under 5 is worth buying more of"
    assert lv["recommended"] < lv["pointLevel"], "the level is the cautious peak, under the point estimate's"
    assert abs(lv["tomorrow"] - 1110.0 * 1.3) < 0.01, "tomorrow is today's moved by the pacing rule's step and no further"
    assert lv["daysLeft"] == 13 and abs(lv["spendToCome"] - lv["recommended"] * 13) < 0.1
    assert lv["unitsAtRecommended"] > lv["signupsAtToday"] > lv["signupsNow"] == 424.0
    assert lv["targetSignups"] == 8034.0


def test_the_curve_and_its_range():
    lv = levels()
    c = lv["curve"]
    assert len(c) == 41 and c[0]["daily"] == 0 and c[0]["median"] == 0 and c[0]["lossP"] == 0
    assert all(p["p10"] <= p["median"] <= p["p90"] for p in c)
    assert all(b["signups"] >= a["signups"] for a, b in zip(c, c[1:])), "a bigger day buys more signups"
    assert c[-1]["lossP"] >= c[5]["lossP"], "and is less sure of paying"
    assert c[-1]["daily"] >= lv["budgetPace"], "the curve reaches the budget's pace"


def test_the_worth_of_a_signup_is_among_what_is_unsure():
    sure, unsure = levels(value_log_sd=0.0), levels(value_log_sd=0.7)
    assert unsure["lossAtPoint"] > sure["lossAtPoint"]
    assert unsure["recommended"] <= sure["recommended"], "the less is known of what a signup is worth, the lower the cautious level"


def test_the_budgets_pace_is_a_mark_and_no_cap():
    lv = levels(budget_left=6500.0)
    assert abs(lv["budgetPace"] - 500.0) < 0.01 and lv["recommended"] > lv["budgetPace"]
    assert lv["signupsAtBudget"] < lv["unitsAtRecommended"]
    none = levels(budget_left=None)
    assert none["budgetPace"] is None and none["signupsAtBudget"] is None and none["recommended"] > 0


def test_a_stop_where_no_spend_pays():
    lv = levels(gain=0.5)
    assert lv["recommended"] == 0 and lv["stop"] == "marginal" and lv["curve"] == []
    assert [r["key"] for r in lv["rows"]] == ["none", "today"]
    assert tl.spend_levels(B, path(days=0), 230.0, 21.4, 0.4, 1110.0) is None, "nothing to read once the open is here"
    assert tl.spend_levels(B, path(), 230.0, 21.4, 0.4, 0.0) is None, "nor before paid has run a day"


def test_small_moves_are_held():
    # a level within a tenth of today's spend is no change
    lv = levels()
    held = levels(today=lv["recommended"] * 0.97)
    assert held["tomorrow"] == held["today"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} tests passed")
