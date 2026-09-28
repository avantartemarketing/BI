#!/usr/bin/env python3
"""The waterfall at close (docs §9). A closed release's walk at close is its
walk to date; a live release's is its walk to date scaled by the close gap
over the to-date gap, and where that ratio is rounding (a to-date gap under
half a unit), or would flip or blow the bars up, the rest of the gap is
shared out over the contributors by size instead. Pinned on the figures that
went wrong: Parra closed on target and its walk at close held steps of a
billion units; Glenn Ligon's and Abdulnasser's closed walks moved a unit
between bars when the page switched from Today to At close.
python3 tests/test_waterfall_close.py (needs pandas)"""
import sys, json, pathlib, random
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)
vals = lambda steps: [s["value"] for s in steps]

# ---- close_walk: scaled, or shared out by size
v, f = build.close_walk([-425.0, -284.0, 1030.0, -1093.0], -772.0, -991.0)
check(f is not None and abs(f - 991 / 772) < 1e-12 and abs(sum(v) - (-991.0)) < 1e-9,
      f"a live walk is scaled by the close gap over the to-date gap: {f} {v}")
v, f = build.close_walk([10.0, -4.0, 0.0, 0.0], -6.0 + 12.0, 30.0)          # gap 6 -> 30: x5 is past the cap
check(f is None and abs(sum(v) - 30.0) < 1e-9 and v[0] > 10.0 and v[1] > -4.0,
      f"a factor above the cap shares the rest out by size: {f} {v}")
v, f = build.close_walk([-15.0, 5.0, 0.0, 0.0], -10.0, 20.0)                # behind today, ahead at close
check(f is None and abs(sum(v) - 20.0) < 1e-9 and all(x > 0 for x in v[:2]),
      f"a negative factor does not flip every contributor's sign: {v}")
v, f = build.close_walk([-2.0, -1.0, 0.0, 0.0], -3.0, -18.0)                # all one way: x6 shared = scaled
check(f is None and all(abs(a - b) < 1e-9 for a, b in zip(v, [-12.0, -6.0, 0.0, 0.0])),
      f"contributors pointing one way share the rest as the factor would: {v}")
v, f = build.close_walk([0.0, 0.0, 0.0, 0.0], 0.0, 12.0)
check(f is None and v == [0.0, 0.0, 0.0, 0.0], "nothing to date: nothing to share it by (the rounding step places it)")

# ---- Parra (25 Sep, Direct view): closed on target, 300 of 300. The to-date
# contributors, each published to a tenth, add up to float noise, and the old
# factor divided the projection's own noise by it.
parra = [18.3, -14.4, -67.2, 63.3]
old_scale = 1.4e-6 / sum(parra)
check(abs(old_scale) > 1e6, f"the old factor on Parra's figures: {old_scale:.3g}")
today, close, f = build.waterfall_walks(parra, -7.1e-15, 1.4e-6, 0.0, 0.0, complete=True)
check(vals(close) == vals(today) and f is None and max(abs(x) for x in vals(close)) < 100,
      f"Parra at close is its walk to date: {vals(close)} vs {vals(today)}")
today, close, f = build.waterfall_walks(parra, -7.1e-15, 1.4e-6, 0.0, 0.0, complete=False)
check(f is None and sum(vals(close)) == 0 and max(abs(x) for x in vals(close)) <= max(abs(x) for x in vals(today)) + 1,
      f"a live release on its pace: no billions, the steps still add up: {vals(close)}")

# ---- Glenn Ligon (base view): closed on target, 150 of 150 (151 before the
# sellout cap). The rounded contributors add to 1.1 against a gap of 1, so the
# old factor x0.909 moved every bar by a unit or more between the horizons.
glenn = [-43.8, 64.2, -10.1, -9.2]
old = [round(x * 1.0 / sum(glenn)) for x in glenn]
today, close, f = build.waterfall_walks(glenn, 1.0, 1.0, 1.0, 1.0, complete=True)
check(vals(today) == [-44, 64, -10, -9] and vals(close) == vals(today) and old != vals(today),
      f"Glenn Ligon at close is its walk to date: {vals(close)} (the old factor gave {old})")
# Abdulnasser's basket walk: a contributor on x.5 exactly rounds one way to
# date and the other at a factor a hair under 1
abdul = [-19.5, -6.0, 24.6, -18.8]
today, close, f = build.waterfall_walks(abdul, -19.7, -19.7, -20.0, -20.0, complete=True)
check(vals(close) == vals(today), f"Abdulnasser at close is its walk to date: {vals(close)} vs {vals(today)}")

# ---- whole units as the page prints them
for x, want in ((132.5, 133.0), (217.49999999999997, 218.0), (475.4999994, 476.0), (132.44, 132.0),
                (0.0, 0.0), (-17.5, -18.0), (805.5000000000002, 806.0)):
    check(build.whole(x) == want and str(build.whole(x)) != "-0.0", f"whole({x}) = {build.whole(x)}, want {want}")

# ---- end to end: a closed and a live release on the synthetic harness
cfg = dict(next((r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"), build.INPUTS["releases"][0]))
cfg["release_name"] = "Synthetic Artist · Synthetic Work · 2026 Q3"
cfg["campaign_name"] = "Synthetic · Enter draw"
cfg["campaign_names"] = [cfg["campaign_name"]]
announce, launch = date.fromisoformat(cfg["announce_date"]), date.fromisoformat(cfg["launch_end"])
pr_open = date.fromisoformat(cfg["private_room_open"])
name = cfg["release_name"]
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]
L = (launch - announce).days

def frame(through, part=1.0):
    rows, rnd, d = [], random.Random(7), min(pr_open, announce)
    while d <= through:
        share = part if d == through else 1.0
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in CH:
            s, e = sess * share * (1 + 0.1 * rnd.random()), ent * share
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": s, "Total_Product_Units": e * 0.3, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": e * 0.7, "Draw_Entries_Eligible_Units": e,
                         "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / L, "pct_days_until_launch": dul / L})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(through, part=1.0):
    rows, d = [], announce
    while d <= through:
        rows.append({"campaign_name": cfg["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 500.0 * (part if d == through else 1.0)})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts, panel = build.load_artist_posts(), baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())

def run(through, part, as_of, full_through, seen):
    return build.build_release(dict(cfg), frame(through, part), spend_frame(through, part), emails, content, curves, as_of,
                               artist_posts, {}, None, panel, people, full_through=full_through, seen=seen)

before = len(build.SNAPSHOT_WARNINGS)
for label, s in (("closed", run(launch, 1.0, launch, launch, 1.0)),
                 ("live", run(announce + timedelta(days=15), 0.5, announce + timedelta(days=15), announce + timedelta(days=14), 0.5))):
    build.check_snapshot(s)
    wf, h, bm = s["waterfall"], s["hero"], s["benchmark"]
    gap = wf["projection"] - wf["target"]
    check(sum(vals(wf["steps"])) == gap and sum(vals(wf["stepsBm"])) == wf["projection"] - wf["benchmark"],
          f"{label}: the steps at close add up to the gaps printed: {vals(wf['steps'])} {vals(wf['stepsBm'])}")
    if s["complete"]:
        check(vals(wf["steps"]) == vals(wf["today"]["steps"]) and vals(wf["stepsBm"]) == vals(wf["today"]["stepsBm"])
              and wf["closeScale"] is None and wf["closeScaleBm"] is None,
              f"{label}: at close is today's walk: {vals(wf['steps'])} vs {vals(wf['today']['steps'])}")
    else:
        for k in ("closeScale", "closeScaleBm"):
            check(wf[k] is None or 0 <= wf[k] <= build.WF_CLOSE_SCALE_MAX, f"{label}: {k} {wf[k]}")
    # scaled by at most the cap, or shared out: a bar at close is never more
    # than the cap times the largest bar to date, plus the gap still to come
    for key, ref in (("steps", wf["target"]), ("stepsBm", wf["benchmark"])):
        most = max(abs(x) for x in vals(wf["today"][key]))
        check(all(abs(x) <= build.WF_CLOSE_SCALE_MAX * most + abs(wf["projection"] - ref) + 1 for x in vals(wf[key])),
              f"{label}: {key} at close stay the size of the walk to date: {vals(wf[key])}")
    check(h["benchmark"] == build.whole(bm["units"]) == wf["benchmark"] and h["benchmark"] + h["stretch"] == h["target"]
          and wf["today"]["benchmark"] + wf["today"]["stretch"] == wf["today"]["target"],
          f"{label}: one benchmark, rounded as the page prints it, and the stretch between it and the target: "
          f"{h['benchmark']} {bm['units']} {wf['benchmark']} {h['stretch']} {h['target']}")
    print(f"{label}: steps {vals(wf['steps'])} today {vals(wf['today']['steps'])} x{wf['closeScale']}; "
          f"bm {vals(wf['stepsBm'])} today {vals(wf['today']['stepsBm'])} x{wf['closeScaleBm']}")
check(len(build.SNAPSHOT_WARNINGS) == before, f"no soft rule fires on an honest build: {build.SNAPSHOT_WARNINGS[before:]}")

# ---- the soft rules warn, they never stop the refresh
# (a page this ETL built: it says where its units came from and the days it
# counted, so the stale-build warning stays out of it)
snap = {"id": "t", "complete": True, "hero": {"now": 106, "benchmark": 132.0, "target": 150},
        "unitsSource": "orders", "salesWindow": {"start": "2026-08-01", "end": "2026-09-03", "closed": True, "firstPaid": None},
        "channels": [{"now": 106, "bm": 132.5}], "benchmark": {"units": 132.5, "k": 1.13},
        "paid": {"entriesProjected": 39.7, "entriesToDate": 42.0, "spendProjectedTotal": 10.0, "spendToDate": 12.0},
        "waterfall": {"steps": [{"value": -40}], "stepsBm": [],
                      "today": {"steps": [{"value": -44}], "stepsBm": [], "actual": 106, "target": 150}}}
n0 = len(build.SNAPSHOT_WARNINGS)
build.check_snapshot(snap)
got = build.SNAPSHOT_WARNINGS[n0:]
check(len(got) == 4 and any("hero.benchmark" in w for w in got) and any("entriesProjected" in w for w in got)
      and any("spendProjectedTotal" in w for w in got) and any("waterfall steps" in w for w in got),
      f"the soft rules: {got}")
print("FAILED" if failed else "ok: waterfall at close", failed if failed else "")
sys.exit(1 if failed else 0)
