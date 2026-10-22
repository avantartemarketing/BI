#!/usr/bin/env python3
"""The paid ROI's converting units (docs METHODOLOGY §7) on a synthetic feed.

conversion_parts (etl/aggregate_events.py) reads, per entrant, what they bought
once a claim has been tried (won - a pre-order given through the window, or
drawn on launch day - bought, or the release's launch day has passed) and the
units still waiting, pre-order or not; a release the feed carries no launch
day for settles a draw with a winner SETTLED_DAYS after its last entry.
converting_units_day (etl/build.py) prices the waiting units at the rates.
Made-up account ids, no real data.  python3 tests/test_paid_claims.py
"""
from __future__ import annotations

import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import aggregate_events as agg  # noqa: E402

REL = "Test Artist · Multiple · 2026 Q3"          # launch day 20 August
REL2 = "Other Artist · Multiple · 2026 Q3"        # no launch day on the feed
CH = agg.CH
LAUNCH = pd.Timestamp("2026-08-20")


def row(acct, draw, ch="Paid Social", winner=False, bought=False, pre=False, units=1.0, day="2026-08-01",
        name="draw entry intent", pieces=0.0, eligible=True, rel=REL):
    r = {CH: ch, "simple_release_name": rel, "aa_account_id": acct, "draw_id": draw, "event_date": pd.Timestamp(day),
         "event_name": name, "draw_entry_eligible": eligible, "winner": winner, "draw_with_purchase": bought,
         "pre_order": pre, "units_once": units, "order_pieces": pieces, "launch_date": LAUNCH if rel == REL else pd.NaT}
    for c in agg.CLOCK:
        r[c] = None
    return r


rows = [
    # draw dA: pre-orders given through the window, and entries waiting
    row("w1", "dA", winner=True, bought=True, pre=True),       # given and charged: 1
    row("w2", "dA", winner=True, pre=True),                    # given, never charged: 0
    row("l1", "dA"),                                           # a plain entry, waiting for launch day: 0.8
    # draw dB: one pre-order given so far
    row("p0", "dB", winner=True, bought=True, pre=True),       # given and charged: 1
    row("p1", "dB", pre=True),                                 # a pre-order not given yet: 0.95
    row("d1", "dB"),                                           # plain entry: 0.8
    row("d2", "dB", ch="Direct", units=2.0),                   # another channel, 2 units wanted, 1 open entry: 1 waiting
    # draw dD: no winner flagged at all, even after launch day (the flags lag
    # the draw), so its entry keeps waiting
    row("x1", "dD", day="2026-08-19"),                         # plain entry: 0.8
    # a release with no launch day on the feed: its draw dC has a winner and
    # took an entry on the feed's last day
    row("c1", "dC", winner=True, bought=True, day="2026-08-10", rel=REL2),   # 1
    row("c2", "dC", day="2026-08-14", rel=REL2),                             # waiting: 0.8
    row("c3", "dC", pre=True, day="2026-08-15", rel=REL2),                   # waiting, pre-order: 0.95
    # purchases
    row("w1", None, name="purchase", pieces=1.0, eligible=False),
    row("p0", None, name="purchase", pieces=1.0, eligible=False),
    row("c1", None, name="purchase", pieces=1.0, eligible=False, day="2026-08-10", rel=REL2),
]
ev = pd.DataFrame(rows)
de = ev[ev["event_name"] == "draw entry intent"]
pu = ev[ev["event_name"] == "purchase"]


def totals(as_of, rel=REL):
    parts = agg.conversion_parts(de, pu, as_of=as_of)
    assert len(parts) == 3, parts
    frame = parts[0]
    for p in parts[1:]:
        frame = frame.merge(p, on=agg.KEY, how="outer")
    frame = frame.fillna(0.0)
    return frame, frame[frame["simple_release_name"] == rel].groupby(CH)[agg.CONV_COLUMNS].sum()


fails = []


def check(label, got, want):
    if abs(float(got) - want) > 1e-9:
        fails.append(f"{label}: got {got}, want {want}")


# in the window (15 August): the given pre-orders count, everything else waits
frame, by = totals(pd.Timestamp("2026-08-15"))
check("paid claimed (w1 and p0 charged 1 each, w2 nothing)", by.loc["Paid Social", "Conv_Units_Claimed"], 2.0)
check("paid pending pre-order (p1)", by.loc["Paid Social", "Conv_Units_Pending_Preorder"], 1.0)
check("paid pending plain (l1, d1, x1)", by.loc["Paid Social", "Conv_Units_Pending_Draw"], 3.0)
check("direct pending capped at its open entries", by.loc["Direct", "Conv_Units_Pending_Draw"], 1.0)
# on launch day itself the draw is still to be held
_, on_day = totals(LAUNCH)
check("launch day: still waiting", on_day.loc["Paid Social", "Conv_Units_Pending_Draw"], 3.0)
# the day after launch day: the draw has been held, the open entries of dA
# and dB have lost; dD, with no winner flagged yet, keeps waiting
_, after = totals(LAUNCH + pd.Timedelta(days=1))
check("after launch day: losers count nothing", after.loc["Paid Social", "Conv_Units_Pending_Preorder"]
      + after.loc["Direct", "Conv_Units_Pending_Draw"], 0.0)
check("after launch day: a draw with no winner flagged yet waits", after.loc["Paid Social", "Conv_Units_Pending_Draw"], 1.0)
check("after launch day: the claims stand", after.loc["Paid Social", "Conv_Units_Claimed"], 2.0)
# no launch day on the feed: a draw with a winner settles a week after its last entry
_, other = totals(pd.Timestamp("2026-08-15"), rel=REL2)
check("no launch day, entries still coming: waiting", other.loc["Paid Social", "Conv_Units_Pending_Draw"]
      + other.loc["Paid Social", "Conv_Units_Pending_Preorder"], 0.8 / 0.8 + 1.0)
_, other_late = totals(pd.Timestamp("2026-09-15"), rel=REL2)
check("no launch day, quiet for a week: settled", other_late.loc["Paid Social", "Conv_Units_Pending_Draw"]
      + other_late.loc["Paid Social", "Conv_Units_Pending_Preorder"], 0.0)
check("no launch day, quiet for a week: the claim stands", other_late.loc["Paid Social", "Conv_Units_Claimed"], 1.0)
# the feed's last day stands in for as_of when none is given
_, dflt = totals(None)
check("as_of defaults to the feed's last day", (dflt - by).abs().to_numpy().sum(), 0.0)

# the build prices the waiting units at the release's rates
import build  # noqa: E402

win = frame[frame["simple_release_name"] == REL].rename(columns={CH: "channel"})
win["Draw_Entries_Eligible_Units"] = 1.0
conv = build.converting_units_day(win, "Paid Social", {})
check("paid converting units", conv.sum(), 2.0 + 0.95 + 3 * 0.8)
typed = build.converting_units_day(win, "Paid Social", {"entry_conversion_rate": 0.5, "preorder_conversion_rate": 0.9})
check("typed rates", typed.sum(), 2.0 + 0.9 + 3 * 0.5)
# without the claim columns (the upstream export): every entry at the entry rate
old = build.converting_units_day(win.drop(columns=agg.CONV_COLUMNS), "Paid Social", {})
check("export fallback", old.sum(), float(win[win["channel"] == "Paid Social"]["Draw_Entries_Eligible_Units"].sum()) * 0.8)

if fails:
    print("\n".join("FAIL " + f for f in fails))
    sys.exit(1)
print("paid claims: ok")
