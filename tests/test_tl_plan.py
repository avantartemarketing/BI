#!/usr/bin/env python3
"""A timed launch's plan-based view, its own parts held to hand-built cases.

etl/tl_plan.py reads a timed launch gathering signups by its plan
(docs/PLAN_MODEL.md 6b): outside paid by plan_view's reading on the timed
launches' price list, and paid by the spend still to come. These cases hold
its own parts: the phase a piece sits in; which plan rows are emails still to
bring signups; how much dearer a launch's later paid signups are read; paid's
path at today's spend (the last full day's) and at the budget's pace, on the
launch's own cost and on the basket's; and the paid suggestion, which is the
Spend levels card's own reading where the page has a card (the card's two
figures, sized on what the budget left brings where the card's level lies past
it) and the budget's pace against the spend where it has none (a raise sized
in signups, a cut in the spend it saves, a hold as nothing, a start where
nothing is spent). The committed price list is checked for its shape. The page itself is built from
the timed launches' feeds, which a checkout does not carry: tests/test_tl_page.py
holds a built page where they are. Run:
  python3 tests/test_tl_plan.py
"""
from __future__ import annotations

import json
import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import plan_model as P  # noqa: E402
import tl_plan as T  # noqa: E402

TS = pd.Timestamp
ANN, OPEN = TS("2026-11-17"), TS("2026-12-09")       # 22 days from the announce to the sales open
PRICES = {"paid_up": {"0.2": {"x": 2.0, "n": 30}, "0.5": {"x": 1.8, "n": 30}, "0.8": {"x": 1.6, "n": 30}}}


def close_to(a, b, tol=1e-9):
    assert abs(a - b) <= tol, f"{a} != {b}"


def page(now=100.0, spent=1000.0, daily=(200.0, 300.0, 400.0), today="2026-11-28", frac=0.5, budget=5000.0, cost_plan=12.0):
    """A timed launch's page on `today` with these full days of spend behind it and half of today seen."""
    t = TS(today)
    rows = [{"date": str((t - pd.Timedelta(days=len(daily) - i)).date()), "spend": s, "partial": False} for i, s in enumerate(daily)]
    rows.append({"date": today, "spend": 50.0, "partial": True})
    return {"type": "TL", "tlState": "signups", "windowStart": str(ANN.date()), "salesOpen": "2026-12-09T17:00:00Z", "asOf": today, "asOfFraction": frac,
            "channels": [{"key": "aa_email", "now": 40.0}, {"key": "paid", "now": now}],
            "paid": {"spendPre": spent, "daily": rows, "budgetPre": budget, "costPlan": cost_plan, "targetSignups": 400.0}}


def test_phase():
    assert [T.phase(d, ANN, 22) for d in ("2026-11-11", "2026-11-17", "2026-11-18")] == ["Announce"] * 3      # the teasers before it are the announcement's
    assert [T.phase(d, ANN, 22) for d in ("2026-11-19", "2026-11-30", "2026-12-07")] == ["Sustain"] * 3
    assert [T.phase(d, ANN, 22) for d in ("2026-12-08", "2026-12-09")] == ["The open"] * 2
    assert T.SPEC["phases"] == T.PHASES and T.SPEC["row_phase"]({"date": "2026-12-08"}, ANN, 22) == "The open" and T.SPEC["send_phase"]({"day": TS("2026-11-18")}, ANN, 22) == "Announce"


def test_planned_email():
    kind = lambda n: P.email_kind("x - " + n)  # noqa: E731
    for name, want in (("Announcement (TL Non-flow)", True), ("Announcement (Re-send to exclusions)", True), ("Early access (TL Artist PP Non Flow)", True),
                       ("Now Live (TL Non-flow)", True), ("Signup Confirmation (TL Flow)", False), ("Welcome (TL FLow)", False), ("Deep dive (TL Flow - content led)", False),
                       ("Now Live (TL Flow)", False), ("Non-purchaser survey (TL Flow)", False), ("Survey 2+ collectors (PP TL Flow)", False)):
        assert T.planned_email(name, kind(name)) is want, name


def test_dearer():
    close_to(T.dearer(PRICES, 0.2), 2.0); close_to(T.dearer(PRICES, 0.5), 1.8); close_to(T.dearer(PRICES, 0.35), 1.9)
    close_to(T.dearer(PRICES, 0.0), 2.0); close_to(T.dearer(PRICES, 1.0), 1.6)        # held at the ends
    close_to(T.dearer({}, 0.5), 1.0)


def test_paid_path():
    p = T.paid_path(page(), PRICES, OPEN)
    left = 11 + 0.5                                   # 28 November, half seen, to the open's day
    close_to(p["daysLeft"], left); close_to(p["spendToday"], 400.0)       # the last full day's, as the Spend levels card reads it
    f = (11 + 0.5) / 22
    up = T.dearer(PRICES, f)
    assert p["costSource"] == "own"
    close_to(p["costSoFar"], 10.0); close_to(p["dearer"], up); close_to(p["costNext"], 10.0 * up)
    close_to(p["toCome"], 400.0 * left / (10.0 * up))
    close_to(p["budgetLeft"], 4000.0); close_to(p["budgetPace"], 4000.0 / left); close_to(p["toComeAtBudget"], 4000.0 / (10.0 * up))
    close_to(p["now"], 100.0); close_to(p["target"], 400.0)
    # too few paid signups to read the launch's own cost: the basket's, with no mark-up
    q = T.paid_path(page(now=20.0, spent=260.0), PRICES, OPEN)
    assert q["costSource"] == "basket" and q["dearer"] is None
    close_to(q["costNext"], 12.0); close_to(q["toCome"], 400.0 * left / 12.0)
    # spend stopped: the last full day carries none, so nothing is held to the open
    r = T.paid_path(page(daily=(200.0, 300.0, 0.0)), PRICES, OPEN)
    close_to(r["spendToday"], 0.0); close_to(r["toCome"], 0.0)
    assert r["toComeAtBudget"] > 0
    # no budget on file: no pace
    n = T.paid_path(page(budget=None), PRICES, OPEN)
    assert n["budgetPace"] is None and n["toComeAtBudget"] is None and n["toCome"] > 0


def work(today="2026-12-08"):
    """What changes() reads, the day before the open: too late for a new email or post, so only paid speaks."""
    none = pd.DataFrame({"went": pd.Series(dtype=bool), "day": pd.Series(dtype="datetime64[ns]"), "delivered": pd.Series(dtype=float)})
    sends = pd.DataFrame({"planned": pd.Series(dtype=bool), "day": pd.Series(dtype="datetime64[ns]"), "kind": pd.Series(dtype=str), "delivered": pd.Series(dtype=float)})
    return {"pr": {"clicks": {"spread": [0.0, 0.0]}, "usual_audience": {}}, "coef": [], "ann": ANN, "today": TS(today), "L": 22, "level": 1.0, "pull": {}, "pull_all": 1.0,
            "close": OPEN, "aud": none, "sends": sends}


def test_paid_suggestion():
    base = {"spendToday": 300.0, "daysLeft": 1.5, "costSoFar": 10.0, "costNext": 18.0, "costSource": "own", "budget": 5000.0, "budgetLeft": 3000.0}
    up = T.changes(work(), {}, {**base, "budgetPace": 2000.0, "toCome": 25.0, "toComeAtBudget": 166.7})
    assert len(up) == 1 and up[0]["kind"] == "change" and up[0]["title"] == "Paid daily budget" and up[0]["channel"] == "Paid"
    assert up[0]["from"] == "€300" and up[0]["to"] == "€2,000" and up[0]["date"] == "2026-12-09" and up[0]["key"] == "paid.budget.2000"
    close_to(up[0]["units"]["low"], 141.7, 1e-6)
    assert "€3,000 of the €5,000 budget is left" in up[0]["reason"] and "read at €18" in up[0]["reason"] and "may cost more per signup" in up[0]["reason"]
    hold = T.changes(work(), {}, {**base, "budgetPace": 320.0, "toCome": 25.0, "toComeAtBudget": 26.7})
    assert hold == []                                                           # within a tenth of today's spend
    cut = T.changes(work(), {}, {**base, "budgetPace": 100.0, "toCome": 25.0, "toComeAtBudget": 8.3})
    assert cut[0]["units"] is None and cut[0]["saves"] == 300 and "runs out before the open" in cut[0]["reason"]
    start = T.changes(work(), {}, {**base, "spendToday": 0.0, "budgetPace": 2000.0, "toCome": 0.0, "toComeAtBudget": 166.7, "costSource": "basket", "costNext": 12.0})
    assert start[0]["kind"] == "add" and start[0]["title"] == "Paid spend" and start[0]["to"] == "€2,000 a day" and "Nothing is being spent" in start[0]["reason"]
    assert T.changes(work(), {}, {**base, "budgetPace": None, "toCome": 25.0, "toComeAtBudget": None}) == []


def card(today=2289.0, tomorrow=2976.0, level=12016.0, pace=5412.0, left=64942.0, at_today=2300.0, at_level=6165.0, at_pace=3747.0, marginal=2.36, stop=None, days=12):
    """A Spend levels block as etl/tl.py spend_levels writes it (Marina Abramović's on 27 November 2026, rounded)."""
    lv = {"unit": "signup", "today": today, "recommended": level, "stop": stop, "marginalToday": marginal, "daysLeft": days,
          "rows": [{"key": "none", "daily": 0.0, "unitsAtClose": 689.0}, {"key": "recommended", "daily": level, "unitsAtClose": at_level}]}
    if not stop:
        lv.update({"tomorrow": tomorrow, "unitsAtRecommended": at_level, "signupsAtToday": at_today, "budgetLeft": left, "budgetPace": pace, "signupsAtBudget": at_pace})
    return lv


def test_paid_suggestion_is_the_cards():
    """On a page with a Spend levels card the row is that card's own two figures, whatever the budget's pace is."""
    plan = {"spendToday": 2289.0, "daysLeft": 11.5, "costSoFar": 11.7, "costNext": 21.4, "costSource": "own", "budget": 72746.0, "budgetLeft": 64942.0,
            "budgetPace": 5603.0, "toCome": 1233.0, "toComeAtBudget": 3026.0}
    wk = work()                                       # the day before the open, so only paid speaks
    got = T.changes(wk, {"paid": {"levels": card()}}, plan)
    assert len(got) == 1, got
    c = got[0]
    assert (c["kind"], c["title"], c["from"], c["to"], c["channel"], c["date"], c["key"], c["lever"]) == \
        ("change", "Paid daily budget", "€2,289", "€2,976", "Paid", "2026-12-09", "paid.budget.2976", "tl_paid_spend_levels"), c
    # the card's level lies past the budget's pace, so the size is what the budget left brings, off the card's own curve
    close_to(c["units"]["low"], 3747.0 - 2300.0); close_to(c["units"]["high"], 3747.0 - 2300.0)
    assert c["reason"] == ("The next euro returns 2.4 at €2,289 a day. It is heading for €12,016 a day. "
                           "The €64,942 left of the budget covers €5,412 a day to the open, and the estimate is what that brings."), c["reason"]
    assert T.recommended(card(), plan) == (5412.0, 3747.0 - 2300.0)
    # a level inside the budget's pace is sized at the level, and says it is inside the budget
    inside = card(level=4000.0, at_level=3200.0)
    c = T.changes(wk, {"paid": {"levels": inside}}, plan)[0]
    close_to(c["units"]["low"], 900.0)
    assert c["reason"].endswith("It is heading for €4,000 a day. The €64,942 left of the budget covers €5,412 a day to the open, so that is inside the budget."), c["reason"]
    assert T.recommended(inside, plan) == (4000.0, 900.0)
    # more being spent already than the budget covers: the card's step stands, with no size to promise
    over = card(today=6000.0, tomorrow=7800.0, at_today=3900.0)
    c = T.changes(wk, {"paid": {"levels": over}}, plan)[0]
    assert (c["from"], c["to"], c["units"]) == ("€6,000", "€7,800", None) and c["reason"].endswith("less than is being spent."), c
    # the card holds: no row, though the budget's pace is far from the spend (the row this replaced said €1,376 to €5,603)
    assert T.changes(wk, {"paid": {"levels": card(tomorrow=2289.0)}}, plan) == []
    # no budget on file: the card's reading as it is
    c = T.changes(wk, {"paid": {"levels": card(pace=None, left=None, at_pace=None)}}, plan)[0]
    close_to(c["units"]["low"], 6165.0 - 2300.0)
    assert c["reason"] == "The next euro returns 2.4 at €2,289 a day. It is heading for €12,016 a day.", c["reason"]
    # a cut is the card's alone, in the spend it saves and the signups it gives up
    cut = card(today=4000.0, tomorrow=2800.0, level=1500.0, at_today=3000.0, at_level=1900.0, marginal=0.6)
    c = T.changes(wk, {"paid": {"levels": cut}}, plan)[0]
    assert (c["from"], c["to"], c["units"], c["saves"]) == ("€4,000", "€2,800", None, 14400), c
    assert c["reason"].endswith("About 1100 fewer signups by the open."), c["reason"]
    # a stop is the card's stop, and what the plan counted on from paid goes with it
    stop = card(level=0.0, stop="marginal")
    c = T.changes(wk, {"paid": {"levels": stop}}, plan)[0]
    assert (c["kind"], c["title"], c["note"], c["from"], c["saves"]) == ("drop", "Paid spend", "Next euro under 1.0", "€2,289", 2289 * 12), c
    assert T.recommended(stop, plan) == (0.0, -1233.0)
    # a page with no card: the budget's own pace at the plan's cost of a signup
    assert T.recommended({}, plan) == (5603.0, 3026.0 - 1233.0) and T.recommended({}, {"toCome": 5.0}) == (None, None)


def test_spend_day():
    pg = page(today="2026-11-28")
    assert T.spend_day(pg) == "yesterday's"
    pg["paid"]["daily"] = [r for r in pg["paid"]["daily"] if r["date"] != "2026-11-27"]        # the feed a day behind
    assert T.spend_day(pg) == "the last full day's" and T.spend_day({}) == "the last full day's"


def test_committed_prices():
    pr = json.loads((ROOT / "etl" / "tl_plan_prices.json").read_text())
    assert set(pr["weights"]) == set(P.VALUE_COLS) and all(v >= 0 for v in pr["weights"].values())
    assert all(pr["weights"][c] == 0.0 for c in pr["unpriced"])                 # a piece the history hardly shows has no price
    assert pr["weights"]["em_announce"] > 0 and abs(sum(pr["split"].values()) - 1.0) < 1e-3
    assert set(pr["split"]) == {"aa_email", "aa_social", "referral_artist", "organic_search", "direct_other"}
    assert pr["launches"] >= 30 and len(pr["quiet"]) == pr["launches"] and all(r["quiet"] > 0 for r in pr["quiet"])
    assert len(pr["paid_up"]) >= 5 and all(1.0 < v["x"] < 4.0 for v in pr["paid_up"].values())      # later signups cost more, on every reading
    assert "coef" in pr["clicks"] and "spread" in pr["clicks"] and "announce" in pr["usual_audience"]


if __name__ == "__main__":
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            n += 1
            print(f"ok {name}")
    print(f"{n} tests passed")
