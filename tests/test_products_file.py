#!/usr/bin/env python3
"""products_file (etl/aggregate_events.py) on a synthetic event feed.

Builds a small events frame in memory - made-up account ids, three draws for
one release and one draw for another - and checks the per-draw counts and the
entry patterns come out as the definitions say. No real data, no file under
sources/.  python3 tests/test_products_file.py
"""
from __future__ import annotations

import json
import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import aggregate_events as agg  # noqa: E402
from sellthrough import products_from_draws, sell_through_products  # noqa: E402

REL = "Test Artist · Multiple · 2026 Q3"
ONE = "Solo Artist · Single · 2026 Q3"


def row(acct, draw, rel=REL, eligible=True, winner=False, bought=False, mq=None, day="2026-08-01", name="draw entry intent", pieces=0, pre=False):
    return {"simple_release_name": rel, "aa_account_id": acct, "draw_id": draw, "event_date": pd.Timestamp(day),
            "event_name": name, "draw_entry_eligible": eligible, "winner": winner, "draw_with_purchase": bought,
            "pre_order": pre, "draw_entry_multiset_preference_max_quantity": mq, "order_pieces": pieces}


rows = []
# 20 entrants who only entered A, max 1; 4 of them entered as a pre-order,
# so their card is already authorised and they convert at their own rate
rows += [row(f"a{i}", "dA", mq=1, pre=i < 4) for i in range(20)]
# 8 entrants in all three draws wanting 1: flexible
rows += [row(f"f{i}", d, mq=1, day="2026-08-03") for i in range(8) for d in ("dA", "dB", "dC")]
# 3 entrants in A and B wanting 2: not flexible (appetite covers both)
rows += [row(f"t{i}", d, mq=2) for i in range(3) for d in ("dA", "dB")]
# 2 entrants in B, no cap recorded
rows += [row(f"u{i}", "dB", mq=None) for i in range(2)]
# an ineligible entry on C
rows += [row("x0", "dC", eligible=False, mq=1)]
# 2 winners on C who paid, 1 winner on C unpaid, 1 loser on A who bought elsewhere
rows += [row(f"w{i}", "dC", winner=True, bought=True, mq=1, day="2026-08-10") for i in range(2)]
rows += [row("w9", "dC", winner=True, bought=False, mq=1)]
rows += [row("l0", "dA", winner=False, bought=True, mq=1)]
# a duplicate row for the same entrant and draw (an edit) must fold, not double count
rows += [row("a0", "dA", mq=1, day="2026-08-02")]
# a purchase row carrying a draw id (the feed may or may not do this)
rows += [row("w0", "dC", name="purchase", pieces=1, day="2026-08-11")]
# the second release: one draw, everyone wants 1
rows += [row(f"s{i}", "dS", rel=ONE, mq=1) for i in range(5)]
ev = pd.DataFrame(rows)

out = agg.products_file(ev)
json.dumps(out)   # must serialise
r = out[REL]
by = {d["id"]: d for d in r["draws"]}
failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


check(sorted(by) == ["dA", "dB", "dC"], f"three draws, got {sorted(by)}")
check(by["dA"]["entrants"] == 20 + 8 + 3 + 1, f"dA entrants {by['dA']['entrants']}")
check(by["dA"]["open"] == 20 + 8 + 3, f"dA open {by['dA']['open']} (the loser who bought is out of the pool)")
check(by["dC"]["winners"] == 3 and by["dC"]["sold"] == 2 and by["dC"]["wonUnpaid"] == 1, f"dC winner split {by['dC']}")
check(by["dC"]["eligible"] == 8 + 3, f"dC eligible {by['dC']['eligible']}")
check(by["dC"]["purchaseUnits"] == 1.0, f"dC purchaseUnits {by['dC']['purchaseUnits']}")
check(r["entrants"] == 20 + 8 + 3 + 2 + 1 + 3 + 1, f"entrants {r['entrants']}")
check(r["allocated"] is True, "allocation has started (winners exist)")
pats = {(tuple(p["open"]), tuple(p["won"]), tuple(p["sold"]), p["bought"], p["max"], tuple(p.get("pre") or ())): p["n"] for p in r["patterns"]}
check(pats.get((("dA",), (), (), 0, 1, ())) == 16, f"16 plain A-only entrants, got {pats}")
check(pats.get((("dA",), (), (), 0, 1, ("dA",))) == 4, "4 of them entered A as a pre-order")
check(pats.get((("dA", "dB", "dC"), (), (), 0, 1, ())) == 8, "8 flexible entrants across all three")
check(pats.get((("dA", "dB"), (), (), 0, 2, ())) == 3, "3 two-product entrants wanting two")
check(pats.get((("dB",), (), (), 0, None, ())) == 2, "2 uncapped entrants on B")
check(pats.get(((), (), ("dC",), 1, 1, ())) == 2, "2 paid winners on C")
check(pats.get(((), ("dC",), (), 0, 1, ())) == 1, "1 unpaid winner on C")
check(((), (), (), 1, 1) not in pats, "an entrant with nothing in hand and nothing sold is not a pattern")
check(sum(p["n"] for p in r["patterns"]) == 20 + 8 + 3 + 2 + 2 + 1, f"pattern entrants {sum(p['n'] for p in r['patterns'])}")
check(out[ONE]["draws"][0]["id"] == "dS" and out[ONE]["draws"][0]["open"] == 5, "the single-draw release")

# and through the model: the products from the draws, then the allocation
products, source = products_from_draws(r["draws"], [{"key": "dA", "name": "Alpha", "edition": 30},
                                                    {"key": "dB", "name": "Beta", "edition": 30},
                                                    {"key": "dC", "name": "Gamma", "edition": 30}], 90)
check(source == "purchases", f"sold source {source} (a tagged purchase exists)")
st = sell_through_products(products, r["patterns"], rate=0.8, edition=90, sold_total=4)
alloc = {p["name"]: p["allocated"] for p in st["products"]}
# A has 20 + 3 fixed; B has 3 fixed + 2 uncapped; C has 1 pinned and 1 sold. The 8 flexible
# units level B and C off (fill = sold + 0.8 x counted, over 30) and never reach A
# C's pinned win spends its winner's appetite but counts no units, so C is the emptier product and
# takes 6 of the 8 flexible units, B the other 2
check(alloc == {"Alpha": 23, "Beta": 5 + 2, "Gamma": 0 + 6}, f"allocation {alloc}")
check(st["unattributedSold"] == 4 - 1, f"unattributed {st['unattributedSold']}")
single, _ = products_from_draws(out[ONE]["draws"], [], 50)
check(single[0]["edition"] == 50 and single[0]["name"] == "Draw 1", f"single product defaults {single}")
print("ok: products file" if not failed else f"{failed} failure(s)")
sys.exit(1 if failed else 0)
