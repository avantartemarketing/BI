#!/usr/bin/env python3
"""A placeholder announce later than the release's own close (docs 1.5, 11).

Airtable's Announce Date was bulk-filled with 2025-04-17 on 41 launches of
2023-24 and reaches the funnel's clock: the release's clock then reads
2025-04-17..2024-06-17, which discover_releases rejects, so a closed 2024
draw became a catalogue page, and every buyer of the release counted as
"returning" in release_people.csv. etl/aggregate_events.py must treat such an
announce as absent: infer_windows infers the announce (keeping an upstream
close that sits by the draw's own end), fill_clock writes the inferred clock,
and people_file starts the campaign at its first event. A proper upstream
clock, and a release with too few entrants to infer from, are handled as
before. Synthetic frames, made-up account ids.
python3 tests/test_clock_windows.py (needs pandas)"""
import pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import aggregate_events as agg

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)
T = pd.Timestamp
PH = T("2025-04-17")   # the placeholder

def days(a, b):
    return list(pd.date_range(a, b, freq="D"))

def clock_rows(name, announce, close, span, entrants, draw_units):
    """The rebuilt export's rows for one release: its upstream clock on every
    row (announce and close as the feed carries them) and the counts, with
    the page busy (50 sessions) while its draw takes entries and quiet (5)
    otherwise."""
    L = (close - announce).days
    rows = []
    for d in span:
        dsa, dul = (d - announce).days, (close - d).days
        rows.append({"simple_release_name": name, "event_date": d, "campaign_stage": "Sustain 1",
                     "Sessions_Total": 50.0 if entrants.get(d, 0) else 5.0,
                     "Draw_Entries": float(entrants.get(d, 0)), "Preorder_App": 0.0,
                     "Product_Units_Draw": float(draw_units.get(d, 0)),
                     "days_since_announcement": float(dsa), "days_until_launch": float(dul),
                     "pct_days_since_announcement": dsa / L, "pct_days_until_launch": dul / L})
    return rows

P, Q, N = "Placeholder Artist · Old Draw · 2024 Q2", "Placeholder Few · Tiny · 2024 Q1", "Normal Artist · Proper · 2026 Q1"
E = "Early Artist · Opens Late · 2026 Q2"
C = T("2024-06-17")
rows = []
# the 2024 draw (entries 25 May - 17 June, allocated on the 18th), and its
# page's catalogue traffic in May 2025, where the placeholder clock reads dsa >= 0
rows += clock_rows(P, PH, C, days("2024-05-10", "2024-07-05") + days("2025-05-01", "2025-05-10"),
                   {d: 5 for d in days("2024-05-25", "2024-06-17")}, {T("2024-06-18"): 40, T("2024-06-19"): 1})
# three entrants: too few to infer a clock from
rows += clock_rows(Q, PH, T("2024-03-01"), days("2024-02-20", "2024-03-05") + days("2025-05-01", "2025-05-03"),
                   {T("2024-02-25"): 1, T("2024-02-26"): 1, T("2024-02-27"): 1}, {})
# a proper upstream clock, 1..25 March 2026
rows += clock_rows(N, T("2026-03-01"), T("2026-03-25"), days("2026-02-20", "2026-04-05"),
                   {d: 8 for d in days("2026-03-01", "2026-03-25")}, {T("2026-03-26"): 60})
# announced three days ago, its early-access entries three days before
# that, the draw not open yet: a real announce the entries must not judge
rows += clock_rows(E, T("2026-04-02"), T("2026-04-25"), days("2026-03-15", "2026-04-05"),
                   {d: 6 for d in days("2026-03-28", "2026-03-30")}, {})
out = pd.DataFrame(rows)
as_of = out["event_date"].max()

w = agg.infer_windows(out, as_of).set_index("release_name")
p, q, n = w.loc[P], w.loc[Q], w.loc[N]
check(p["announce"] == T("2024-05-25") and p["announce_rule"] == "draw opens",
      f"the placeholder announce is inferred from the draw opening: {p['announce']} ({p['announce_rule']})")
check(p["close"] == C and p["close_rule"] == "upstream" and p["source"] == "mixed" and p["campaign_days"] == 23,
      f"the upstream close by the draw's end stays: {p['close']} ({p['close_rule']}, {p['source']}, {p['campaign_days']} days)")
check(pd.isna(q["announce"]) and pd.isna(q["close"]) and q["source"] == "none",
      f"too few entrants: no clock, and no placeholder left standing: {q.to_dict()}")
check(n["announce"] == T("2026-03-01") and n["close"] == T("2026-03-25") and n["source"] == "upstream",
      f"a proper upstream clock is kept: {n.to_dict()}")
e = w.loc[E]
check(e["announce"] == T("2026-04-02") and e["close"] == T("2026-04-25") and e["source"] == "upstream",
      f"an announce a few days after the early-access entries, the draw not open yet, is kept: {e.to_dict()}")

# the rule before: the placeholder kept, no usable window
real = agg.placeholder_announce
agg.placeholder_announce = lambda *args: False
try:
    old = agg.infer_windows(out, as_of).set_index("release_name")
finally:
    agg.placeholder_announce = real
check(old.loc[P, "announce"] == PH and pd.isna(old.loc[P, "close"]) and old.loc[P, "source"] == "upstream"
      and old.loc[Q, "announce"] == PH, f"before, a lone 2025-04-17 announce: {old.loc[[P, Q], ['announce', 'close', 'source']]}")
check(old.loc[N].equals(n) and old.loc[E].equals(e), "and the proper clocks were the same")

# an upstream close far from the draw's end is not kept: the close is inferred
far = out.copy()
far.loc[far["simple_release_name"] == P, "days_until_launch"] += 20   # a clock close 20 days after the last entry
far.loc[far["simple_release_name"] == P, "pct_days_since_announcement"] = (
    far["days_since_announcement"] / ((C + pd.Timedelta(days=20)) - PH).days)
wf = agg.infer_windows(far, as_of).set_index("release_name").loc[P]
check(wf["close"] == T("2024-06-18") and wf["close_rule"] == "allocation day" and wf["source"] == "inferred",
      f"a close 20 days off the draw is inferred from the allocation: {wf['close']} ({wf['close_rule']}, {wf['source']})")

# the rules on their own
pa, NOW = agg.placeholder_announce, T("2026-09-28")
check(pa(PH, C, T("2024-06-17")) and pa(PH, None, T("2024-06-17"), NOW) and pa(PH, C, None)
      and pa(T("2026-03-25"), T("2026-03-25"), None),
      "on or after the close, or long after the last entry once it has passed: a placeholder")
check(not pa(T("2026-03-01"), T("2026-03-25"), T("2026-03-25")) and not pa(pd.NaT, C, C) and not pa(PH, None, None),
      "a real announce, none at all, or nothing to test it against: kept")
check(not pa(T("2026-10-01"), T("2026-10-20"), T("2026-09-10"), NOW) and not pa(T("2026-10-01"), None, T("2026-09-10"), NOW),
      "an announce still to come, after early-access entries: kept")
check(not pa(T("2026-09-26"), None, T("2026-09-21"), NOW) and not pa(PH, None, T("2024-06-17")),
      "an announce a few days after the last entry, or with no as-of day to judge by: kept")

# fill_clock writes the inferred clock over the placeholder's
filled = agg.fill_clock(out.copy(), agg.infer_windows(out, as_of))
fp = filled[filled["simple_release_name"] == P].set_index("event_date")
check((fp["clock_source"] == "inferred").all() and fp.loc[T("2024-05-25"), "days_since_announcement"] == 0
      and fp.loc[C, "days_until_launch"] == 0 and fp.loc[C, "campaign_stage"] == "Last chance",
      "the placeholder release's rows carry the inferred clock")
fn = filled[filled["simple_release_name"] == N]
check((fn["clock_source"] == "upstream").all(), "the upstream-clocked release keeps its own")

# people_file: the campaign starts at the first event, not at the placeholder
def ev_row(name, day, kind, acct, ann, close=None, pieces=0.0, draw="d1"):
    return {"event_name": kind, "simple_release_name": name, "event_date": T(day), "aa_account_id": acct,
            "announcement_date": ann, "draw_entry_eligible": kind == "draw entry intent", "winner": False,
            "order_pieces": pieces, "draw_id": draw, "draw_entry_multiset_preference_max_quantity": 1,
            "days_until_launch": float((T(close) - T(day)).days) if close else float("nan")}
OLD, Z, EA = "Earlier Artist · First · 2023 Q4", "Placeholder Shop · Buy Now · 2024 Q1", "Early Access · Soon · 2026 Q4"
ev = pd.DataFrame(
    [ev_row(OLD, "2023-11-01", "purchase", "a1", "2023-10-20", pieces=1.0)]
    + [ev_row(P, f"2024-05-{d}", "draw entry intent", f"a{i}", "2025-04-17", close="2024-06-17")
       for i in range(1, 6) for d in (25, 26)]
    + [ev_row(P, "2024-06-18", "purchase", a, "2025-04-17", pieces=1.0) for a in ("a1", "a2")]
    # no draw at all: only its close says the placeholder is not its campaign's
    + [ev_row(Z, "2024-02-10", "purchase", "b1", "2025-04-17", close="2024-02-12", pieces=1.0, draw=None)]
    # in its early access: entries before an announce still to come
    + [ev_row(EA, "2026-09-20", "draw entry intent", "c1", "2026-10-01", close="2026-10-20")])
ppl = agg.people_file(ev).set_index("release_name")
check(ppl.loc[EA, "campaign_start"] == "2026-10-01", f"an announce still to come stays the start: {ppl.loc[EA, 'campaign_start']}")
check(ppl.loc[P, "campaign_start"] == "2024-05-25" and ppl.loc[P, "share_buyers_returning"] == 0.5,
      f"from its first entry: one of its two buyers bought before: {ppl.loc[P, ['campaign_start', 'share_buyers_returning']].to_dict()}")
check(ppl.loc[Z, "campaign_start"] == "2024-02-10" and ppl.loc[Z, "share_buyers_returning"] == 0.0,
      f"a release with no entries, by its close: {ppl.loc[Z, ['campaign_start', 'share_buyers_returning']].to_dict()}")
check(ppl.loc[OLD, "campaign_start"] == "2023-10-20", "a real announcement stays the start")
agg.placeholder_announce = lambda *args: False
try:
    before = agg.people_file(ev).set_index("release_name")
finally:
    agg.placeholder_announce = real
check(before.loc[P, "campaign_start"] == "2025-04-17" and before.loc[P, "share_buyers_returning"] == 1.0
      and before.loc[Z, "share_buyers_returning"] == 1.0,
      f"before, every buyer was returning: {before.loc[[P, Z], 'share_buyers_returning'].to_dict()}")

print(f"{failed} failure(s)" if failed else "ok: a placeholder announce is treated as absent")
sys.exit(1 if failed else 0)
