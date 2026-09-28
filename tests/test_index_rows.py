#!/usr/bin/env python3
"""The sidebar row of a targeted release (etl/build.py index_row) carries what
every other row does: the quarter from its name, its sessions in the window
and the last day it was seen. A targeted page built on a synthetic funnel
frame, and a snapshot that lacks the quarter falling back to its name's. And
a name whose quarter is not the one its campaign closes in (the funnel's
"Maurizio Cattelan · Multiple · 2027 Q1" closes 15 October 2026) keeps its
name and id, with a note that says so.
python3 tests/test_index_rows.py (needs pandas)"""
import sys, json, pathlib, random, copy
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["release_name"] = "Synthetic Artist · Synthetic Work · 2026 Q3"   # no draw or orders feed answers to this name
base["campaign_name"] = "Synthetic · Enter draw"
base["campaign_names"] = [base["campaign_name"]]
announce, launch = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
pr_open = date.fromisoformat(base["private_room_open"])
name = base["release_name"]
TODAY = announce + timedelta(days=12)
CH = [("AA Email Man", 300, 1.2), ("Direct", 200, 0.8), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)

def frame(through, start):
    rows, rnd, d = [], random.Random(7), start
    LL = (launch - announce).days
    while d <= through:
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in CH:
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": sess * (1 + 0.1 * rnd.random()), "Total_Product_Units": ent * 0.3,
                         "Product_Units_Private_Room": 0.0, "Draw_Entries_Total_Units_No_Conv": ent * 0.7,
                         "Draw_Entries_Eligible_Units": ent, "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(through):
    rows, d = [], announce
    while d <= through:
        rows.append({"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 500.0})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())

# traffic from a week before the private room: the days before the window are
# seen but not counted in its sessions
at = frame(TODAY, min(pr_open, announce) - timedelta(days=7))
snap = build.build_release(copy.deepcopy(base), at, spend_frame(TODAY), emails, content, curves, TODAY,
                           build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0)
build.check_snapshot(snap)
check(snap.get("targeted", True) is not False and snap.get("benchmark"), "a targeted page")
sw = snap["salesWindow"]
in_window = at[(at["event_date"] >= date.fromisoformat(sw["start"])) & (at["event_date"] <= date.fromisoformat(sw["end"]))]
check(snap.get("quarter") == "2026 Q3", f"the quarter from the name: {snap.get('quarter')}")
check(snap["totals"]["sessions"] == round(float(in_window["Sessions_Total"].sum())) and snap["totals"]["sessions"] < round(float(at["Sessions_Total"].sum())),
      f"sessions in the window: {snap['totals']} vs {in_window['Sessions_Total'].sum():.0f} of {at['Sessions_Total'].sum():.0f}")
check(snap["derived"]["last_seen"] == TODAY.isoformat(), f"last seen: {snap['derived']}")
row = build.index_row(snap, "live")
check(row["quarter"] == "2026 Q3" and row["sessions"] == snap["totals"]["sessions"] and row["lastSeen"] == TODAY.isoformat(),
      f"the sidebar row: quarter {row['quarter']}, sessions {row['sessions']}, last seen {row['lastSeen']}")

# a configured release the funnel does not mention yet: no traffic, nothing seen
quiet = build.build_release(copy.deepcopy(base), at.iloc[0:0], spend_frame(TODAY), emails, content, curves, TODAY,
                            build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0)
qrow = build.index_row(quiet, "live")
check(qrow["quarter"] == "2026 Q3" and qrow["sessions"] == 0 and qrow["lastSeen"] is None, f"no traffic yet: {qrow}")

# a snapshot without the key reads the quarter off its name, and a name without one has none
bare = {k: v for k, v in snap.items() if k != "quarter"}
check(build.index_row(bare, "live")["quarter"] == "2026 Q3", "the name's quarter when the snapshot has none")
check(build.name_quarter("Kaï · Content (Hand-finished) · 2024 Q2") == "2024 Q2" and build.name_quarter("Untitled") is None
      and build.name_quarter("Artist · Work") is None, "name_quarter")

# the funnel's clock for two launches announced 21 Sep and closing 15 Oct
# 2026, one named for the quarter it closes in and one a quarter-year off
ann, close = date(2026, 9, 21), date(2026, 10, 15)
crows = []
for rel in ("Synthetic Horse · Multiple · 2027 Q1", "Synthetic Print · Work · 2026 Q4"):
    for d in (ann + timedelta(days=i) for i in range(4)):
        dsa, dul = (d - ann).days, (close - d).days
        crows.append({"channel": "Direct", "event_date": d, "simple_release_name": rel, "campaign_stage": "launch",
                      "Sessions_Total": 10.0, "Total_Product_Units": 0.0, "Product_Units_Private_Room": 0.0,
                      "Draw_Entries_Total_Units_No_Conv": 0.0, "Draw_Entries_Eligible_Units": 0.0,
                      "days_since_announcement": dsa, "days_until_launch": dul,
                      "pct_days_since_announcement": dsa / 24, "pct_days_until_launch": dul / 24})
found = {r["release_name"]: r for r in build.discover_releases(pd.DataFrame(crows), ann + timedelta(days=3), set())}
horse, print_ = found["Synthetic Horse · Multiple · 2027 Q1"], found["Synthetic Print · Work · 2026 Q4"]
check(horse["launch_end"] == "2026-10-15" and horse["quarter"] == "2027 Q1" and horse["id"] == "synthetic_horse_multiple_2027_q1",
      f"the name, its quarter and the id stand: {horse['quarter']} {horse['id']}")
check(horse["dates_note"] == "the name says 2027 Q1, but the campaign closes 2026-10-15 (2026 Q4)", f"the note: {horse['dates_note']}")
check(print_["dates_note"] is None and print_["quarter"] == "2026 Q4", f"a name that agrees has no note: {print_['dates_note']}")
print(f"targeted row: quarter {row['quarter']}, sessions {row['sessions']}, last seen {row['lastSeen']}")
print("FAILED" if failed else "ok: index rows", failed if failed else "")
sys.exit(1 if failed else 0)
