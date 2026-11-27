#!/usr/bin/env python3
"""Every launch day by day (etl/funnel_daily.py, docs 6.1a): the days inside a
launch's window and none outside it, the day of the campaign on every row, the
days after the close folded into it, the units from the orders where they
cover the launch, the page funnel's counts beside them, channels by their
group's name with Direct and Untracked apart, and the spread reading (Untracked
then Direct shared day by day, a day with nothing to share over pooled on the
release's mix, nothing lost). A timed launch keeps Untracked apart. Synthetic
rows, no feed on disk.  python3 tests/test_funnel_daily.py"""
import pathlib, sys, tempfile
from datetime import date
import pandas as pd
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import funnel_daily as fd

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)
near = lambda a, b: abs(float(a) - float(b)) < 0.011

GROUPS = {
    "aa_email": {"name": "AA Email", "channels": ["AA Email Auto", "AA Email Man"]},
    "aa_social": {"name": "AA Social", "channels": ["AA Meta", "AA X"]},
    "direct_other": {"name": "Other", "channels": ["Direct", "Other", "AA Other"]},
    "paid": {"name": "Paid", "channels": ["Paid Social", "Paid Search"]},
}
names = fd.channel_names(GROUPS)
check(names["AA Email Man"] == "AA Email" and names["AA Other"] == "Other", "a channel carries its group's name")
check(names["Direct"] == "Direct" and names["Untracked"] == "Untracked", "Direct and Untracked stay apart")

A, B = "A · Work · 2026 Q3", "B · Work · 2026 Q3"
def at_row(rel, day, ch, sessions, entrants=0, eligible=0, entries=0, units=0):
    return {"simple_release_name": rel, "event_date": day, "channel": ch, "Sessions_Total": sessions, "Draw_Entries": entrants,
            "Collectors_Eligible_Entries": eligible, "Draw_Entries_Eligible_Units": entries, "Total_Product_Units": units}
at = pd.DataFrame([
    at_row(A, date(2026, 7, 20), "Direct", 99),                       # before A's window: left out
    at_row(A, date(2026, 8, 1), "AA Email Man", 60, 6, 5, 6, 1),      # early access, three days before the announce
    at_row(A, date(2026, 8, 1), "AA Email Auto", 20, 0, 0, 0, 0),     # the same group: one row with the one above
    at_row(A, date(2026, 8, 4), "AA Email Man", 300, 30, 20, 24, 2),  # the announce
    at_row(A, date(2026, 8, 4), "Paid Social", 100, 4, 2, 2, 0),
    at_row(A, date(2026, 8, 4), "Direct", 100, 4, 4, 4, 1),
    at_row(A, date(2026, 8, 4), "Untracked", 0, 2, 2, 3, 5),
    at_row(A, date(2026, 8, 5), "Untracked", 0, 0, 0, 0, 4),          # a day with nothing but Untracked
    at_row(A, date(2026, 8, 14), "AA Meta", 10, 1, 1, 1, 0),          # the close
    at_row(A, date(2026, 8, 16), "AA Email Man", 0, 0, 0, 0, 9),      # two days after: the winners paying
    at_row(A, date(2026, 8, 30), "AA Email Man", 50, 0, 0, 0, 0),     # after A's window: left out
    at_row(B, date(2026, 9, 1), "Direct", 40, 0, 0, 0, 3),            # a release with nothing but Direct
    at_row("C · Catalogue · 2024 Q1", date(2026, 8, 4), "Direct", 7), # no window: no rows
])
windows = [
    {"release": A, "announce": date(2026, 8, 4), "close": date(2026, 8, 14), "start": date(2026, 7, 28), "end": date(2026, 8, 16), "orders": False},
    {"release": B, "announce": date(2026, 9, 1), "close": date(2026, 9, 11), "start": date(2026, 9, 1), "end": date(2026, 9, 13), "orders": False},
]
t = fd.le_table(at, windows, names)
check(list(t.columns) == fd.LE_COLUMNS, "the table's columns, in order")
check(set(t["release"]) == {A, B}, "a row only for a launch with a window")
a = t[t["release"] == A]
check(a["visits"].sum() == 590, f"the window's visits and none outside it ({a['visits'].sum()})")
check(set(a["of"]) == {10} and a["day"].min() == -3 and a["day"].max() == 10, f"the day of the campaign, from the announce ({sorted(set(a['day']))})")
ea = a[(a["day"] == -3) & (a["channel"] == "AA Email")]
check(len(ea) == 1 and ea["visits"].iloc[0] == 80 and ea["entrants"].iloc[0] == 6 and ea["eligible"].iloc[0] == 5, "a group's channels on one row, with its entrants and its eligible")
close = a[a["day"] == 10]
check(set(close["date"]) == {"2026-08-14"} and close[close["channel"] == "AA Email"]["units"].iloc[0] == 9, "the days after the close are folded into the close day")
check(a["units"].sum() == 22 and a["entries"].sum() == 40, "units and entries add up")
check(not len(a[(a[["visits", "entrants", "entries", "units"]].sum(axis=1) == 0)]), "no row with nothing on it")

# the spread reading: Untracked, then Direct, shared day by day; totals hold
for c in ("visits", "entries", "units"):
    check(near(a[c].sum(), a[f"{c}_spread"].sum()), f"{c}: the spread reading adds up to the same total ({a[c].sum()} vs {a[f'{c}_spread'].sum()})")
d0 = a[a["day"] == 0].set_index("channel")
check(d0.loc["Direct", "visits_spread"] == 0 and d0.loc["Untracked", "units_spread"] == 0, "the channels shared out read zero")
check(near(d0.loc["AA Email", "visits_spread"], 375) and near(d0.loc["Paid", "visits_spread"], 125), f"Direct's visits shared by the day's mix ({d0['visits_spread'].to_dict()})")
# that day's units: 2 on email, 1 on Direct, 5 untracked -> untracked over email and Direct (2:1), then Direct over
# email: the day's 8. The next day has nothing but 4 untracked units: they are pooled on the release's own mix of
# tracked units (13, of which this day's rows hold 3), so 12/13 of a unit more lands here, and none is lost
check(near(d0.loc["AA Email", "units_spread"], 8 + 12 / 13) and near(d0.loc["Paid", "units_spread"], 0), f"units through both folds ({d0['units_spread'].to_dict()})")
check(near(a["units_spread"].sum(), 22), "a day with nothing to share over is pooled, not lost")
b = t[t["release"] == B].set_index("channel")
check(near(b.loc["Direct", "visits_spread"], 40) and near(b.loc["Direct", "units_spread"], 3), "a release with nothing but Direct keeps it")

# units from the orders where they cover the launch: the funnel's own are set aside
orders = {A: pd.DataFrame([{"event_date": date(2026, 8, 4), "channel": "AA Email Man", "units": 7.0},
                           {"event_date": date(2026, 8, 15), "channel": "Untracked", "units": 2.0},
                           {"event_date": date(2026, 9, 20), "channel": "Direct", "units": 50.0}])}
w2 = [dict(windows[0], orders=True), windows[1]]
t2 = fd.le_table(at, w2, names, units=orders)
a2 = t2[t2["release"] == A]
check(a2["units"].sum() == 9, f"the orders' units inside the window, in place of the funnel's ({a2['units'].sum()})")
check(a2[(a2["day"] == 10) & (a2["channel"] == "Untracked")]["units"].iloc[0] == 2, "an order after the close on the close day")
check(t2[t2["release"] == B]["units"].sum() == 3, "a launch the orders do not cover keeps the funnel's")

# the page funnel's counts beside them
pages = {"by": {A: pd.DataFrame([
    {"event_date": date(2026, 8, 4), "channel": "AA Email Man", "side": "organic", "release_sessions": 200, "release_product_sessions": 50, "product_sessions": 120, "product_entry_sessions": 10},
    {"event_date": date(2026, 8, 4), "channel": "Paid Social", "side": "paid", "release_sessions": 90, "release_product_sessions": 9, "product_sessions": 20, "product_entry_sessions": 1},
    {"event_date": date(2026, 7, 1), "channel": "Direct", "side": "organic", "release_sessions": 500, "release_product_sessions": 5, "product_sessions": 5, "product_entry_sessions": 5},
])}}
t3 = fd.le_table(at, windows, names, pages=pages)
p = t3[(t3["release"] == A) & (t3["day"] == 0)].set_index("channel")
check(p.loc["AA Email", "release_page_visits"] == 200 and p.loc["AA Email", "went_to_product"] == 50 and p.loc["Paid", "entered_from_product"] == 1, "the page funnel's counts on the same rows")
check(t3[t3["release"] == A]["release_page_visits"].sum() == 290, "and none from outside the window")

check(len(fd.le_table(at, [], names)) == 0 and list(fd.le_table(at, [], names).columns) == fd.LE_COLUMNS, "no windows: the header alone")

# ---- a timed launch: the announce, the day sales open, Untracked kept apart
T = "T · Edition · 2026 Q4"
daily = pd.DataFrame([
    {"release": T, "date": date(2026, 10, 1), "channel": "AA Email Man", "sessions": 5, "signups": 1, "orders": 0, "units": 0},      # too early: left out
    {"release": T, "date": date(2026, 11, 2), "channel": "AA Email Man", "sessions": 100, "signups": 30, "orders": 0, "units": 0},   # the announce
    {"release": T, "date": date(2026, 11, 2), "channel": "Direct", "sessions": 50, "signups": 10, "orders": 0, "units": 0},
    {"release": T, "date": date(2026, 11, 2), "channel": "untracked", "sessions": 0, "signups": 8, "orders": 0, "units": 0},
    {"release": T, "date": date(2026, 11, 2), "channel": "Paid Social", "sessions": 100, "signups": 10, "orders": 0, "units": 0},
    {"release": T, "date": date(2026, 11, 12), "channel": "AA Email Man", "sessions": 400, "signups": 0, "orders": 20, "units": 31},  # the day sales open
])
tw = [{"release": T, "announce": date(2026, 11, 2), "open": date(2026, 11, 12), "start": date(2026, 10, 19), "end": date(2026, 11, 21)}]
tt = fd.tl_table(daily, tw, names)
check(list(tt.columns) == fd.TL_COLUMNS, "the timed table's columns, in order")
check(tt["visits"].sum() == 650 and tt["signups"].sum() == 58, "the kept days' visits and signups")
check(set(tt["of"]) == {10} and set(tt["day"]) == {0, 10} and set(tt["to_open"]) == {-10, 0}, "days from the announce, and to the day sales open")
s0 = tt[tt["day"] == 0].set_index("channel")
check(near(s0.loc["Untracked", "signups_spread"], 8) and s0.loc["Direct", "signups_spread"] == 0, "Untracked keeps its own, Direct is shared out")
check(near(s0.loc["AA Email", "signups_spread"], 37.5) and near(s0.loc["Paid", "signups_spread"], 12.5), f"Direct's signups over the tracked channels alone ({s0['signups_spread'].to_dict()})")
check(near(tt["signups_spread"].sum(), 58) and near(tt["visits_spread"].sum(), 650), "the timed table's spread reading adds up")

# ---- written whole, read back as it was
with tempfile.TemporaryDirectory() as tmp:
    out = pathlib.Path(tmp) / fd.LE_FILE
    fd.write(t, out)
    back = pd.read_csv(out)
    check(list(back.columns) == fd.LE_COLUMNS and len(back) == len(t), "the file reads back with every row")
    check(not (pathlib.Path(tmp) / "funnel_daily.tmp").exists(), "no half-written file left behind")
    check("60.0" not in out.read_text().split("\n")[1], "whole numbers are written whole")

if failed:
    sys.exit(f"{failed} check(s) failed")
print("funnel daily: ok")
