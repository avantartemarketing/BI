#!/usr/bin/env python3
"""The untracked share, its norm and the warning rule (docs/DATA_MODEL.md 1.3).

A release whose untracked share of entries or units is much higher than the
panel's normal - over twice the median and past the 90th percentile, on at
least five rows - is flagged, and the Target setting tab warns on it. Run:
  python3 tests/test_untracked.py
"""
from __future__ import annotations

import datetime as dt
import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402


def frame(rows):
    return pd.DataFrame(rows, columns=["simple_release_name", "channel", "event_date",
                                       "Sessions_Total", "Draw_Entries_Eligible_Units", "Total_Product_Units"])


def day(n):
    return dt.date(2026, 6, 1) + dt.timedelta(days=n)


def test_shares_and_flag() -> None:
    win = frame([
        ("R", "AA Email Auto", day(1), 100, 40, 12),
        ("R", "Direct", day(1), 50, 20, 3),
        ("R", "Untracked", day(1), 0, 0, 5),      # 5 of 20 units, no entries
        ("R", "Untracked", day(2), 0, 2, 0),      # 2 of 62 entries
    ])
    shares = build.untracked_shares(win)
    assert shares["units"] == {"share": 0.25, "count": 5.0, "total": 20.0}
    assert abs(shares["entries"]["share"] - 2 / 62) < 1e-9
    norms = {"recentMonths": 18, "entries": {"median": 0.016, "p90": 0.043, "n": 60},
             "units": {"median": 0.032, "p90": 0.079, "n": 60}}
    block = build.untracked_block(win, norms)
    assert block["high"] == ["units"], block["high"]          # entries: only 2 rows, and 3% is under the bar
    assert block["units"]["share"] == 0.25 and block["normal"] is norms

    # a handful of rows cannot trip it: 4 untracked of 8 is 50%, and not flagged
    few = frame([("R", "Direct", day(1), 10, 4, 4), ("R", "Untracked", day(1), 0, 0, 4)])
    assert build.untracked_block(few, norms)["high"] == []
    # over the 90th percentile but not twice the median: not flagged; both: flagged
    mid = frame([("R", "Direct", day(1), 10, 0, 94), ("R", "Untracked", day(1), 0, 0, 6)])   # 6.0%: > 2x3.2%? 6.4% no
    assert build.untracked_block(mid, norms)["high"] == []
    hi = frame([("R", "Direct", day(1), 10, 0, 91), ("R", "Untracked", day(1), 0, 0, 9)])    # 9.0%: past both
    assert build.untracked_block(hi, norms)["high"] == ["units"]
    # no norm, no flag - the shares are still reported
    assert build.untracked_block(hi, None)["high"] == [] and build.untracked_block(hi, None)["units"]["share"] == 0.09
    # nothing in the window at all
    empty = build.untracked_block(frame([]), norms)
    assert empty["units"]["share"] is None and empty["high"] == []
    print("shares and flag: ok")


def test_norms() -> None:
    at = frame([
        ("A", "Direct", day(1), 10, 90, 45), ("A", "Untracked", day(1), 0, 10, 5),       # 10% entries, 10% units
        ("B", "Direct", day(1), 10, 96, 48), ("B", "Untracked", day(1), 0, 4, 2),        # 4%, 4%
        ("C", "Direct", day(1), 10, 100, 50),                                             # 0%, 0%
        ("D", "Direct", day(40), 10, 50, 50), ("D", "Untracked", day(40), 0, 50, 50),    # outside its window
    ])
    panel = pd.DataFrame([
        {"release_name": "A", "window_start": "2026-06-01", "window_end": "2026-06-10"},
        {"release_name": "B", "window_start": "2026-06-01", "window_end": "2026-06-10"},
        {"release_name": "C", "window_start": "2026-06-01", "window_end": "2026-06-10"},
        {"release_name": "D", "window_start": "2026-06-01", "window_end": "2026-06-10"},
        {"release_name": "E", "window_start": None, "window_end": None},                   # no window, skipped
    ])
    norms = build.untracked_norms(at, panel, dt.date(2026, 9, 22))
    # fewer than eight launches that recent, so the whole panel is the norm:
    # A, B and C; D has no rows inside its window and E has no window
    assert norms["recentMonths"] is None
    assert norms["units"]["n"] == 3 and norms["entries"]["n"] == 3
    assert abs(norms["units"]["median"] - 0.04) < 1e-9, norms["units"]
    assert norms["units"]["p90"] > norms["units"]["median"]
    assert build.untracked_norms(at, None, dt.date(2026, 9, 22)) is None
    print("norms: ok")


if __name__ == "__main__":
    test_shares_and_flag()
    test_norms()
