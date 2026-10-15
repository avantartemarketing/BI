#!/usr/bin/env python3
"""The page funnel (etl/build.py, docs 2.6): the feed parsed to sides, the
four counts over a release's window, a rate read only over enough sessions,
a basket member's window cut at the same share of its campaign as today, the
benchmark as the members' median, and the block's shape with and without a
basket. Synthetic rows, no feed on disk.  python3 tests/test_page_funnel.py"""
import os, pathlib, sys
from datetime import date
import pandas as pd
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)

CH = "AA_session_custom_channel_group_split_touch"
def row(channel, day, release, rs, rps, ps, pes):
    return {CH: channel, "event_date": day, "simple_release_name": release, "release_sessions": rs,
            "release_product_sessions": rps, "product_sessions": ps, "product_entry_sessions": pes}

# ---- the feed parsed: dates DD/MM/YYYY as the writer puts them, paid and organic sides, Untracked out
raw = pd.DataFrame([
    row("Paid Social", "01/08/2026", "A · Work · 2026 Q3", 100, 10, 50, 2),
    row("Paid Search", "02/08/2026", "A · Work · 2026 Q3", 20, 4, 10, 1),
    row("AA Email Man", "01/08/2026", "A · Work · 2026 Q3", 40, 12, 80, 4),
    row("Direct", "02/08/2026", "A · Work · 2026 Q3", 10, 4, 20, 1),
    row("Untracked", "02/08/2026", "A · Work · 2026 Q3", 500, 1, 500, 1),
    row("Paid Social", "20/08/2026", "A · Work · 2026 Q3", 1000, 1, 1000, 1),   # outside the window below
    row("Paid Social", "05/06/2024", "B · Work · 2024 Q2", 200, 40, 100, 10),
    row("AA Meta", "05/06/2024", "B · Work · 2024 Q2", 100, 50, 100, 5),
    row("Paid Social", "01/09/2025", "C · Work · 2025 Q3", 100, 10, 100, 1),
    row("AA Meta", "01/09/2025", "C · Work · 2025 Q3", 100, 10, 100, 1),
    row("Paid Social", "20/09/2025", "C · Work · 2025 Q3", 100, 50, 100, 50),   # C's last chance, past the cut below
    row("AA Meta", "20/09/2025", "C · Work · 2025 Q3", 100, 50, 100, 50),
    row("Paid Social", "05/06/2024", "D · Work · 2024 Q2", 10, 9, 10, 9),          # too few sessions to read
    row("AA Meta", "05/06/2024", "D · Work · 2024 Q2", 10, 9, 10, 9),
])
pages = build.parse_pages(raw)
check(set(pages["by"]) == {"A · Work · 2026 Q3", "B · Work · 2024 Q2", "C · Work · 2025 Q3", "D · Work · 2024 Q2"}, "one frame per release")
check(pages["through"] == date(2026, 8, 20), f"the feed's newest day ({pages['through']})")
a = pages["by"]["A · Work · 2026 Q3"]
check(sorted(a["side"].unique()) == ["organic", "paid"] and len(a) == 5, "paid and organic sides, Untracked left out")
check(a["event_date"].min() == date(2026, 8, 1), "DD/MM/YYYY read as a date")

# ---- the counts over a window, both days in, the 20th out
c = build.page_funnel_counts(pages, "A · Work · 2026 Q3", date(2026, 7, 20), date(2026, 8, 10))
check(c["paid"] == {"release_sessions": 120, "release_product_sessions": 14, "product_sessions": 60, "product_entry_sessions": 3}, f"paid counts {c['paid']}")
check(c["organic"] == {"release_sessions": 50, "release_product_sessions": 16, "product_sessions": 100, "product_entry_sessions": 5}, f"organic counts {c['organic']}")
check(build.page_funnel_counts(pages, "nobody", date(2026, 7, 20), date(2026, 8, 10))["paid"]["release_sessions"] == 0, "a release the feed has no rows for counts zero")

# ---- a rate is read over enough sessions only
check(build.page_funnel_rate(14, 120) == 14 / 120, "a rate over enough sessions")
check(build.page_funnel_rate(9, 10) is None and build.page_funnel_rate(0, 0) is None, "none under the minimum")
check(build.PAGE_FUNNEL_MIN_SESSIONS == 30, "the minimum is thirty sessions")

# ---- a member's window by today: the same share of its campaign, or all of it once complete
m = pd.Series({"announce": pd.Timestamp("2025-09-01"), "close": pd.Timestamp("2025-09-21"),
               "window_start": pd.Timestamp("2025-08-20"), "window_end": pd.Timestamp("2025-09-23")})
check(build.page_funnel_member_window(m, 1.0) == (date(2025, 8, 20), date(2025, 9, 23)), "complete: the whole window")
check(build.page_funnel_member_window(m, 0.5) == (date(2025, 8, 20), date(2025, 9, 11)), "half way: to the day at half its campaign")
check(build.page_funnel_member_window(m, 0.0) == (date(2025, 8, 20), date(2025, 9, 1)), "the announce day at the start")
check(build.page_funnel_member_window(pd.Series({"announce": pd.NaT, "close": pd.NaT}), 0.5) is None, "no dates, no window")
nowin = pd.Series({"announce": pd.Timestamp("2025-09-01"), "close": pd.Timestamp("2025-09-21")})
check(build.page_funnel_member_window(nowin, 1.0) == (date(2025, 8, 18), date(2025, 9, 23)), "without window columns: the lead before the announce, the grace after the close")

# ---- the benchmark: the median over the members with enough sessions, by today
panel = pd.DataFrame([
    {"release_name": "B · Work · 2024 Q2", "announce": pd.Timestamp("2024-06-01"), "close": pd.Timestamp("2024-06-21"),
     "window_start": pd.Timestamp("2024-05-20"), "window_end": pd.Timestamp("2024-06-23")},
    {"release_name": "C · Work · 2025 Q3", "announce": pd.Timestamp("2025-09-01"), "close": pd.Timestamp("2025-09-21"),
     "window_start": pd.Timestamp("2025-08-20"), "window_end": pd.Timestamp("2025-09-23")},
    {"release_name": "D · Work · 2024 Q2", "announce": pd.Timestamp("2024-06-01"), "close": pd.Timestamp("2024-06-21"),
     "window_start": pd.Timestamp("2024-05-20"), "window_end": pd.Timestamp("2024-06-23")},
])
members = ["B · Work · 2024 Q2", "C · Work · 2025 Q3", "D · Work · 2024 Q2", "not in the panel"]
bm = build.page_funnel_benchmark(pages, panel, members, 1.0)
# complete: B paid 40/200 = 0.2, C paid (10+50)/200 = 0.3, D too thin -> median 0.25 over 2
check(abs(bm["paid"]["clickThrough"]["bm"] - 0.25) < 1e-9 and bm["paid"]["clickThrough"]["bmN"] == 2, f"paid click-through median over the readable members {bm['paid']['clickThrough']}")
check(abs(bm["organic"]["entry"]["bm"] - ((0.05 + 0.255) / 2)) < 1e-9, f"organic entry median {bm['organic']['entry']}")
half = build.page_funnel_benchmark(pages, panel, members, 0.5)
# half way: C's rows on the 20th fall past the cut (11 September), so its paid click-through reads 10/100
check(abs(half["paid"]["clickThrough"]["bm"] - ((0.2 + 0.1) / 2)) < 1e-9, f"by today the later days of a member are not counted {half['paid']['clickThrough']}")
check(build.page_funnel_benchmark(pages, None, members, 1.0)["paid"]["entry"] == {"bm": None, "bmN": 0}, "no panel, no benchmark")
check(build.page_funnel_benchmark(pages, panel, [], 1.0)["paid"]["entry"] == {"bm": None, "bmN": 0}, "no members, no benchmark")

# ---- the block
blk = build.page_funnel_block(pages, "A · Work · 2026 Q3", date(2026, 7, 20), date(2026, 8, 10), members, panel, 1.0)
check(blk["from"] == "2026-07-20" and blk["through"] == "2026-08-10" and blk["feedThrough"] == "2026-08-20", "the window and the feed's reach")
check(blk["bench"] is True and blk["basketN"] == 4 and blk["minSessions"] == 30, "the basket read")
ct = blk["paid"]["clickThrough"]
check(ct == {"sessions": 120, "through": 14, "rate": round(14 / 120, 6), "bm": 0.25, "bmN": 2}, f"paid click-through {ct}")
en = blk["organic"]["entry"]
check(en["sessions"] == 100 and en["through"] == 5 and en["rate"] == 0.05 and en["bmN"] == 2, f"organic entry {en}")
check(blk["organic"]["clickThrough"]["rate"] == round(16 / 50, 6), "organic click-through")
thin = build.page_funnel_block(pages, "D · Work · 2024 Q2", date(2024, 5, 20), date(2024, 6, 23))
check(thin["paid"]["entry"]["rate"] is None and thin["paid"]["entry"]["sessions"] == 10, "too few sessions: the count, no rate")
check(thin["bench"] is False and thin["paid"]["entry"]["bm"] is None and thin["basketN"] == 0, "without a basket: no benchmark")
check(build.page_funnel_block(None, "A · Work · 2026 Q3", date(2026, 7, 20), date(2026, 8, 10)) is None, "no feed, no block")
import json
json.dumps(blk)   # JSON-ready

if failed:
    sys.exit(f"{failed} check(s) failed")
print("page funnel: ok")
