#!/usr/bin/env python3
"""The part-day clock (observation_clock, etl/build.py) end to end: build_release
and build_actuals on a synthetic funnel frame, so the split between the day so
far (actuals), the last full day (rules, completeness) and the share of today
seen (references) is pinned down without a funnel file.
python3 tests/test_partial_day.py (needs pandas)"""
import sys, json, pathlib, random
from datetime import date, datetime, timedelta, timezone
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

cfg = dict(next((r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"), build.INPUTS["releases"][0]))
cfg["campaign_name"] = "Synthetic · Enter draw"
cfg["campaign_names"] = [cfg["campaign_name"]]      # the list is what the build reads; the name is kept for the frames
announce, launch = date.fromisoformat(cfg["announce_date"]), date.fromisoformat(cfg["launch_end"])
pr_open = date.fromisoformat(cfg["private_room_open"])
L = (launch - announce).days
name = cfg["release_name"]
TODAY = announce + timedelta(days=22)   # a day inside the window, part-observed
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

def frame(through, part=1.0, rel=name, ann=announce, lau=launch, start=None):
    rows, rnd, d = [], random.Random(7), (start or min(pr_open, ann))
    LL = (lau - ann).days
    while d <= through:
        share = part if d == through else 1.0
        dsa, dul = (d - ann).days, (lau - d).days
        for ch, sess, ent in CH:
            s, e = sess * share * (1 + 0.1 * rnd.random()), ent * share
            rows.append({"channel": ch, "event_date": d, "simple_release_name": rel, "campaign_stage": "launch",
                         "Sessions_Total": s, "Total_Product_Units": e * 0.3, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": e * 0.7, "Draw_Entries_Eligible_Units": e,
                         "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(through, part=1.0):
    rows = []
    d = announce
    while d <= through:
        rows.append({"campaign_name": cfg["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 500.0 * (part if d == through else 1.0)})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())

def run(through, part, as_of, full_through=None, seen=1.0):
    at = frame(through, part)
    return build.build_release(cfg, at, spend_frame(through, part), emails, content, curves, as_of,
                               artist_posts, {}, None, panel, people, full_through=full_through, seen=seen)

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)

# the clock itself
tz = timezone(timedelta(hours=1))
check(build.observation_clock(TODAY, datetime(TODAY.year, TODAY.month, TODAY.day, 10, 30, tzinfo=tz)) == (TODAY, TODAY - timedelta(days=1), 0.4375), "clock: part day")
check(build.observation_clock(TODAY - timedelta(days=1), datetime(TODAY.year, TODAY.month, TODAY.day, 10, 30, tzinfo=tz)) == (TODAY - timedelta(days=1), TODAY - timedelta(days=1), 1.0), "clock: full day")
check(build.observation_clock(TODAY, datetime(TODAY.year, TODAY.month, TODAY.day, 0, 0, tzinfo=tz))[2] == 0.0, "clock: midnight")

A = run(TODAY, 0.4, TODAY, TODAY - timedelta(days=1), 0.4375)          # today, part-observed
B = run(TODAY - timedelta(days=1), 1.0, TODAY - timedelta(days=1))     # yesterday, the old reading
C = run(TODAY, 1.0, TODAY, TODAY, 1.0)                                 # today as a full day (tomorrow's reading)
for s in (A, B, C): build.check_snapshot(s)

check(A["asOf"] == TODAY.isoformat() and A["completeThrough"] == (TODAY - timedelta(days=1)).isoformat() and A["asOfFraction"] == 0.4375, f"A dates {A['asOf']} {A['completeThrough']} {A['asOfFraction']}")
check(B["asOf"] == (TODAY - timedelta(days=1)).isoformat() and B["completeThrough"] == (TODAY - timedelta(days=1)).isoformat() and B["asOfFraction"] == 1.0, "B dates")
check(A["day"] == 22 and B["day"] == 21 and not A["complete"], f"day in progress {A['day']} {B['day']}")
check(A["hero"]["now"] > B["hero"]["now"], f"the part day's units are in: {A['hero']['now']} vs {B['hero']['now']}")
check(B["hero"]["expectedToday"] < A["hero"]["expectedToday"] < C["hero"]["expectedToday"],
      f"target by today sits between yesterday's and the end of today: {B['hero']['expectedToday']} < {A['hero']['expectedToday']} < {C['hero']['expectedToday']}")
check(B["hero"]["benchmarkToday"] < A["hero"]["benchmarkToday"] < C["hero"]["benchmarkToday"], "benchmark by today between")
pd_ = A["paid"]
check(pd_["daily"][-1]["date"] == (TODAY - timedelta(days=1)).isoformat(), f"paid rules see full days only: {pd_['daily'][-1]['date']}")
check(abs(pd_["spendToDate"] - (B["paid"]["spendToDate"] + 200.0)) < 0.01, f"spend to date carries the part day: {pd_['spendToDate']} vs {B['paid']['spendToDate']}")
check(pd_["budget"]["current"] == 500.0, f"current daily is yesterday's full day: {pd_['budget']['current']}")
check(A["paid"]["budget"]["daysLeft"] == (launch - (TODAY - timedelta(days=1))).days, f"days left counts today: {A['paid']['budget']['daysLeft']}")
ch = {c["key"]: c for c in A["channels"]}
last_actual = [r for r in ch["aa_email"]["daily"] if r["actual"] is not None][-1]
check(last_actual["date"] == TODAY.isoformat(), f"trajectory actual runs through today: {last_actual['date']}")
today_row = next(r for r in ch["aa_email"]["daily"] if r["date"] == TODAY.isoformat())
check(today_row["proj"] is not None and today_row["proj"] >= today_row["actual"], f"today's row projects the rest of the day: {today_row}")
fb = A["funnelByGroup"]["aa_email"]
check(B["funnelByGroup"]["aa_email"]["sessions_expected"] < fb["sessions_expected"] < C["funnelByGroup"]["aa_email"]["sessions_expected"], "sessions expected by today between")
print(f"A: day {A['day']}/{A['of']} now={A['hero']['now']} exp={A['hero']['expectedToday']} bm={A['hero']['benchmarkToday']} "
      f"paid cur={pd_['budget']['current']} rec={pd_['budget']['recommended']} cap={pd_['budget']['cap']} l3d={pd_['l3dCpe']} spend={pd_['spendToDate']}")
print(f"B: day {B['day']}/{B['of']} now={B['hero']['now']} exp={B['hero']['expectedToday']} bm={B['hero']['benchmarkToday']} "
      f"paid cur={B['paid']['budget']['current']} rec={B['paid']['budget']['recommended']} cap={B['paid']['budget']['cap']} spend={B['paid']['spendToDate']}")
print(f"C: day {C['day']}/{C['of']} now={C['hero']['now']} exp={C['hero']['expectedToday']} bm={C['hero']['benchmarkToday']}")

# the actuals-only build on a discovered record
import inspect, re
rec = {k: None for k in set(re.findall(r'rec\["([a-z_]+)"\]', inspect.getsource(build.build_actuals)))}
rec.update({"id": "synthetic_le_26", "release_name": "Synthetic · Test · 2026 Q3", "artist": "Synthetic", "title": "Test", "type": "LE", "announce_date": announce.isoformat(),
       "launch_end": launch.isoformat(), "campaign_code": "Synthetic_LE_26", "campaign_name": None, "quarter": "2026 Q3"})
atD = frame(TODAY, 0.4, rel=rec["release_name"], ann=announce, lau=launch, start=announce)
D = build.build_actuals(rec, atD, spend_frame(TODAY, 0.4), emails, content, TODAY, None, full_through=TODAY - timedelta(days=1), seen=0.4375)
build.check_snapshot(D)
check(D["asOf"] == TODAY.isoformat() and D["completeThrough"] == (TODAY - timedelta(days=1)).isoformat() and D["asOfFraction"] == 0.4375 and D["day"] == 22, f"actuals dates {D['asOf']} {D['completeThrough']} {D['day']}")
check(D["paid"]["daily"][-1]["date"] == (TODAY - timedelta(days=1)).isoformat(), "actuals paid daily on full days")
print(f"D: day {D['day']}/{D['of']} now={D['hero']['now']} complete={D['complete']}")

# launch day, part-observed: not complete until the day is full
E = run(launch, 0.5, launch, launch - timedelta(days=1), 0.5)
check(not E["complete"] and E["day"] == L and E["asOfFraction"] == 0.5, f"launch day in progress: complete={E['complete']} day={E['day']}")
F = run(launch, 1.0, launch, launch, 1.0)
check(F["complete"] and F["asOfFraction"] == 1.0, "launch day full: complete")
print("FAILED" if failed else "ok: part-day clock", failed if failed else "")
sys.exit(1 if failed else 0)
