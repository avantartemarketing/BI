#!/usr/bin/env python3
"""The paid ROI's converting units (docs METHODOLOGY §7) on a synthetic feed.

conversion_parts (etl/aggregate_events.py) reads, per entrant, what they bought
once a claim has been tried (won, bought, or their draw is settled: it has a
winner and has taken no entries for SETTLED_DAYS) and the units still waiting
on a draw, pre-order or not; a draw with winners that is still taking entries
is being run as they come in, so its open entries wait. converting_units_day
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
TODAY = pd.Timestamp("2026-08-15")


def row(acct, draw, ch="Paid Social", winner=False, bought=False, pre=False, units=1.0, day="2026-08-01",
        name="draw entry intent", pieces=0.0, eligible=True):
    r = {CH: ch, "simple_release_name": REL, "aa_account_id": acct, "draw_id": draw, "event_date": pd.Timestamp(day),
         "event_name": name, "draw_entry_eligible": eligible, "winner": winner, "draw_with_purchase": bought,
         "pre_order": pre, "units_once": units, "order_pieces": pieces}
    for c in agg.CLOCK:
        r[c] = None
    return r


rows = [
    # draw dA is settled: it has winners and its last entry is two weeks old
    row("w1", "dA", winner=True, bought=True),                 # won and paid for 1
    row("w2", "dA", winner=True),                              # won, never paid: 0
    row("l1", "dA"),                                           # lost dA: 0
    # draw dB has no winner yet: pending at the rates
    row("p1", "dB", pre=True),                                 # pre-order: 0.95
    row("d1", "dB"),                                           # plain entry: 0.8
    row("d2", "dB", ch="Direct", units=2.0),                   # another channel, 2 units wanted, 1 open entry: 1 waiting
    # draw dC has winners and is still taking entries (one today): it is being
    # run as the entries come in, so an entry not drawn yet waits
    row("c1", "dC", winner=True, bought=True, day="2026-08-10"),   # drawn and paid for 1
    row("c2", "dC", day="2026-08-14"),                         # not drawn yet: 0.8
    row("c3", "dC", pre=True, day="2026-08-15"),               # not drawn yet, pre-order: 0.95
    # purchases
    row("w1", None, name="purchase", pieces=1.0, eligible=False),
    row("c1", None, name="purchase", pieces=1.0, eligible=False, day="2026-08-10"),
]
ev = pd.DataFrame(rows)
de = ev[ev["event_name"] == "draw entry intent"]
pu = ev[ev["event_name"] == "purchase"]


def parts_frame(as_of):
    parts = agg.conversion_parts(de, pu, as_of=as_of)
    assert len(parts) == 3, parts
    frame = parts[0]
    for p in parts[1:]:
        frame = frame.merge(p, on=agg.KEY, how="outer")
    return frame.fillna(0.0)


frame = parts_frame(TODAY)
by = frame.groupby(CH)[agg.CONV_COLUMNS].sum()

fails = []


def check(label, got, want):
    if abs(float(got) - want) > 1e-9:
        fails.append(f"{label}: got {got}, want {want}")


check("paid claimed (w1 and c1 bought 1 each, w2 and l1 nothing)", by.loc["Paid Social", "Conv_Units_Claimed"], 2.0)
check("paid pending pre-order (p1, c3)", by.loc["Paid Social", "Conv_Units_Pending_Preorder"], 2.0)
check("paid pending plain (d1, c2)", by.loc["Paid Social", "Conv_Units_Pending_Draw"], 2.0)
check("direct pending capped at its open entries", by.loc["Direct", "Conv_Units_Pending_Draw"], 1.0)
# the feed's last day stands in for as_of when none is given
same = parts_frame(None).groupby(CH)[agg.CONV_COLUMNS].sum()
check("as_of defaults to the feed's last day", (same - by).abs().to_numpy().sum(), 0.0)
# four days after dA's last entry it is not settled yet: l1 waits, w2 is a
# winner either way (nothing, it never paid)
early = parts_frame(pd.Timestamp("2026-08-05")).groupby(CH)[agg.CONV_COLUMNS].sum()
check("an unsettled draw's loser still waits", early.loc["Paid Social", "Conv_Units_Pending_Draw"], 3.0)
check("an unsettled draw's claims are unchanged", early.loc["Paid Social", "Conv_Units_Claimed"], 2.0)
# a month on, dC has stopped taking entries: its undrawn entries have lost
late = parts_frame(pd.Timestamp("2026-09-15")).groupby(CH)[agg.CONV_COLUMNS].sum()
check("a draw that stopped taking entries settles its losers", late.loc["Paid Social", "Conv_Units_Pending_Draw"], 1.0)
check("a settled draw's pre-orders are losers too", late.loc["Paid Social", "Conv_Units_Pending_Preorder"], 1.0)

# the build prices the waiting units at the release's rates
import build  # noqa: E402

win = frame.rename(columns={CH: "channel"})
win["Draw_Entries_Eligible_Units"] = 1.0
conv = build.converting_units_day(win, "Paid Social", {})
check("paid converting units", conv.sum(), 2.0 + 2 * 0.95 + 2 * 0.8)
typed = build.converting_units_day(win, "Paid Social", {"entry_conversion_rate": 0.5, "preorder_conversion_rate": 0.9})
check("typed rates", typed.sum(), 2.0 + 2 * 0.9 + 2 * 0.5)
# without the claim columns (the upstream export): every entry at the entry rate
old = build.converting_units_day(win.drop(columns=agg.CONV_COLUMNS), "Paid Social", {})
check("export fallback", old.sum(), float(win[win["channel"] == "Paid Social"]["Draw_Entries_Eligible_Units"].sum()) * 0.8)

if fails:
    print("\n".join("FAIL " + f for f in fails))
    sys.exit(1)
print("paid claims: ok")
