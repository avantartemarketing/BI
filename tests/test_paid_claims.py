#!/usr/bin/env python3
"""The paid ROI's converting units (docs METHODOLOGY §7) on a synthetic feed.

conversion_parts (etl/aggregate_events.py) reads, per entrant, what they bought
once a claim has been tried (won, bought, or their draw has been run) and the
units still waiting on a draw, pre-order or not; converting_units_day
(etl/build.py) prices the waiting units at the rates. Made-up account ids, no
real data.  python3 tests/test_paid_claims.py
"""
from __future__ import annotations

import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import aggregate_events as agg  # noqa: E402

REL = "Test Artist · Multiple · 2026 Q3"
CH = agg.CH


def row(acct, draw, ch="Paid Social", winner=False, bought=False, pre=False, units=1.0, day="2026-08-01",
        name="draw entry intent", pieces=0.0, eligible=True):
    r = {CH: ch, "simple_release_name": REL, "aa_account_id": acct, "draw_id": draw, "event_date": pd.Timestamp(day),
         "event_name": name, "draw_entry_eligible": eligible, "winner": winner, "draw_with_purchase": bought,
         "pre_order": pre, "units_once": units, "order_pieces": pieces}
    for c in agg.CLOCK:
        r[c] = None
    return r


rows = [
    # draw dA has been run (w1 won): every entry in it has had its claim tried
    row("w1", "dA", winner=True, bought=True),                 # won and paid for 1
    row("w2", "dA", winner=True),                              # won, never paid: 0
    row("l1", "dA"),                                           # lost dA: 0
    # draw dB has not been run: pending at the rates
    row("p1", "dB", pre=True),                                 # pre-order: 0.95
    row("d1", "dB"),                                           # plain entry: 0.8
    row("d2", "dB", ch="Direct", units=2.0),                   # another channel, 2 units wanted, 1 open entry: 1 waiting
    # purchases
    row("w1", None, name="purchase", pieces=1.0, eligible=False),
]
ev = pd.DataFrame(rows)
de = ev[ev["event_name"] == "draw entry intent"]
pu = ev[ev["event_name"] == "purchase"]
parts = agg.conversion_parts(de, pu)
assert len(parts) == 3, parts
frame = parts[0]
for p in parts[1:]:
    frame = frame.merge(p, on=agg.KEY, how="outer")
frame = frame.fillna(0.0)
by = frame.groupby(CH)[agg.CONV_COLUMNS].sum()

fails = []


def check(label, got, want):
    if abs(float(got) - want) > 1e-9:
        fails.append(f"{label}: got {got}, want {want}")


check("paid claimed (w1 bought 1, w2 and l1 nothing)", by.loc["Paid Social", "Conv_Units_Claimed"], 1.0)
check("paid pending pre-order", by.loc["Paid Social", "Conv_Units_Pending_Preorder"], 1.0)
check("paid pending plain", by.loc["Paid Social", "Conv_Units_Pending_Draw"], 1.0)
check("direct pending capped at its open entries", by.loc["Direct", "Conv_Units_Pending_Draw"], 1.0)

# the build prices the waiting units at the release's rates
import build  # noqa: E402

win = frame.rename(columns={CH: "channel"})
win["Draw_Entries_Eligible_Units"] = 1.0
conv = build.converting_units_day(win, "Paid Social", {})
check("paid converting units", conv.sum(), 1.0 + 0.95 + 0.8)
typed = build.converting_units_day(win, "Paid Social", {"entry_conversion_rate": 0.5, "preorder_conversion_rate": 0.9})
check("typed rates", typed.sum(), 1.0 + 0.9 + 0.5)
# without the claim columns (the upstream export): every entry at the entry rate
old = build.converting_units_day(win.drop(columns=agg.CONV_COLUMNS), "Paid Social", {})
check("export fallback", old.sum(), float(win[win["channel"] == "Paid Social"]["Draw_Entries_Eligible_Units"].sum()) * 0.8)

if fails:
    print("\n".join("FAIL " + f for f in fails))
    sys.exit(1)
print("paid claims: ok")
