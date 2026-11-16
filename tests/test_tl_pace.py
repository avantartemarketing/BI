#!/usr/bin/env python3
"""The timed launch's signup pace is read on the campaign clock (docs/TL_SPEC.md 4).

A basket's pace is its launches' median share of pre-window signups at the
same share of each launch's own announce -> open span, as the LE pages read
theirs (docs/METHODOLOGY.md 5), not at the same number of days to the open:
launches announced six days out and three weeks out line up at their
announces. Until 16 November 2026 it was read by days to the open, and a
launch announced three weeks out against a basket announced six days out was
given a target of nothing for two weeks and more than half of it the day
after (Matt DesLauriers' Serac: 99 signups against 1 expected, +12275%).
This holds, on made-up launches:
  - a member's clock runs from its announce on file, or from the day its
    signups began where that is later;
  - members with different leads line up on the clock;
  - a basket under TL_PACE_MIN launches takes the panel's pace, and says so;
  - the pace never falls and ends on the whole.
  python3 tests/test_tl_pace.py
"""
from __future__ import annotations

import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import tl  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def near(a, b, tol=0.02):
    return abs(float(a) - float(b)) <= tol


def launch(lead: int, total: float = 200.0, first: float = 0.5, before: float = 0.0) -> dict:
    """A launch whose signups begin `lead` days before the open: `before` of
    them trickle in ahead of that, `first` arrive on the day and the rest come
    evenly up to the open. Counts and shares by day to the open (CURVE_DAYS)."""
    counts = []
    for d in tl.CURVE_DAYS:
        if d < -lead:
            counts.append(total * before * (d + tl.TL_CURVE_DAYS + 1) / max(tl.TL_CURVE_DAYS - lead, 1))
        else:
            counts.append(total * (before + first + (1 - before - first) * (d + lead) / lead))
    return {"signups": [c / total for c in counts], "signups_count": counts}


# ---- a member's clock
six = launch(6)
check(tl.pace_days(6, six["signups_count"]) == 6.0, "announced six days out: a six-day clock")
check(tl.pace_days(24, six["signups_count"]) == 6.0, "an announce on file 24 days out with signups from six days out: the clock starts with the signups")
check(tl.pace_days(None, six["signups_count"]) == 6.0, "no announce on file: the day the signups began")
check(tl.pace_days(None, [0.0] * len(tl.CURVE_DAYS)) == float(tl.TL_ASSUMED_PRE_DAYS), "no announce and no day of signups: the assumed lead")
trickle = launch(20, before=0.2)
check(tl.pace_days(20, trickle["signups_count"]) == 20.0, "a trickle ahead of the announce does not lengthen the clock")
check(tl.pace_days(3, launch(20)["signups_count"]) == 3.0, "signups ahead of the announce on file: the announce stands")

# ---- members with different leads line up
curves = {f"L{lead}": {**launch(lead), "lead": float(lead)} for lead in (5, 6, 7, 21, 30)}
names = list(curves)
pace = tl.pace_curve(curves, names, "signups")
check(len(pace) == len(tl.PACE_FRACS), "the pace is on the clock's grid")
check(near(tl.pace_at(pace, 0.0), 0.5), f"half the signups by the end of the announce day, whatever the lead (got {tl.pace_at(pace, 0.0):.3f})")
check(near(tl.pace_at(pace, 0.5), 0.75), f"three quarters half way to the open (got {tl.pace_at(pace, 0.5):.3f})")
check(near(tl.pace_at(pace, 1.0), 1.0, 1e-9), "the whole at the open")
check(tl.pace_at(pace, -0.3) < 0.02, "nothing to speak of ahead of the announce")
check(all(b >= a - 1e-9 for a, b in zip(pace, pace[1:])), "the pace never falls")
# read by days to the open, the same five say nothing 13 days out and the launch announced 19 days out stands at 0.5 and more
by_days = tl._median_curve(curves, names, "signups", len(tl.CURVE_DAYS))
check(by_days[tl.TL_CURVE_DAYS - 13] < 0.01 and tl.pace_at(pace, 6 / 19) > 0.6, "the days-to-open reading it replaces had not started; this one has")

# ---- a thin basket takes the panel's pace
panel = pd.DataFrame([{"release_name": n, "signups": 200.0, "sessions": 1000.0, "units": 100.0, "orders": 90.0, "pre_days": curves[n]["lead"],
                       "window_hours": 48.0, "early_access": False} for n in names])
full = tl.basket_profile(panel, curves, names)
check(full["pace_source"] == "basket" and full["pace_n"] == 5, "five launches shape their own pace")
check(full["pace_fracs"] == tl.PACE_FRACS and near(tl.pace_at(full["signup_curve"], 0.0), 0.5), "the profile carries the pace on the clock")
check(near(tl.pace_at(full["signup_curve_count"], 1.0), 200.0, 1e-6), "the count curve ends on the basket's signups")
thin = tl.basket_profile(panel, curves, ["L6"])
check(thin["pace_source"] == "panel" and thin["pace_n"] == 5, f"one launch does not: the panel's pace ({thin['pace_source']}, {thin['pace_n']})")
check(thin["signup_curve"] == full["signup_curve"], "the panel's pace is every launch's")
check(near(tl.pace_at(thin["signup_curve_count"], 1.0), thin["signups"], 1e-6), "and the count curve is the basket's signups on it")
three = tl.basket_profile(panel, curves, names[:3])
check(three["pace_source"] == "panel", f"under {tl.TL_PACE_MIN} launches: the panel's")

print(f"tl pace: {failed} failed" if failed else "tl pace: ok")
sys.exit(1 if failed else 0)
