#!/usr/bin/env python3
"""The sellout cap, the release's entry -> order rate and the hero adopting the
sell-through's count (docs 6.3½), on a synthetic funnel frame: the hero, the
waterfall and the channels print one figure, capped at the whole edition with
the surplus carried as a Beyond sellout step, and one rate runs through the
paid model, the secured units and the targets.
python3 tests/test_sellout_cap.py (needs pandas)"""
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
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

def frame(through, boost=1.0):
    rows, rnd, d = [], random.Random(7), min(pr_open, announce)
    LL = (launch - announce).days
    while d <= through:
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in CH:
            s, e = sess * (1 + 0.1 * rnd.random()), ent * boost
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": s, "Total_Product_Units": e * 0.3, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": e * 0.7, "Draw_Entries_Eligible_Units": e,
                         "days_since_announcement": dsa, "days_until_launch": dul,
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
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())

def run(cfg, boost=1.0):
    at = frame(TODAY, boost)
    snap = build.build_release(cfg, at, spend_frame(TODAY), emails, content, curves, TODAY,
                               artist_posts, {}, None, panel, people, full_through=TODAY, seen=1.0)
    build.check_snapshot(snap)
    return snap, at

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)
close = lambda a, b, tol=1.0: a is not None and b is not None and abs(a - b) <= tol
def secured(at, rate):
    w = at[at["event_date"] <= TODAY]
    return float(w["Total_Product_Units"].sum()) + rate * float(w["Draw_Entries_Total_Units_No_Conv"].sum())

# 1. inside the edition: no cap, and with no draw or orders feed the hero is the
#    funnel's secured units at the panel's rate, the channels summing to it
rate = build.BENCH["eligible_entry_to_order"]
S, at = run(base)
check(close(S["hero"]["now"], secured(at, rate), 2), f"hero is the secured units at the rate: {S['hero']['now']} vs {secured(at, rate):.1f}")
check(close(sum(c["now"] for c in S["channels"]), S["hero"]["now"], 1.5), "the channels sum to the hero")
check(S["hero"]["oversubscribedUnits"] == 0 and not any(s["key"] == "oversubscribed" for s in S["waterfall"]["steps"]), "no Beyond sellout step inside the edition")
check(S["waterfall"]["projection"] == S["hero"]["projected"], f"the waterfall's projection is the hero's: {S['waterfall']['projection']} vs {S['hero']['projected']}")
wt = S["waterfall"].get("today") or {}
check(wt.get("actual") == S["hero"]["now"], f"the waterfall's actual is the hero's: {wt.get('actual')} vs {S['hero']['now']}")
check(S["paid"]["dropOff"] == round(1 - rate, 4) and S["benchmarks"]["chargeDropOff"] == round(1 - rate, 4), "the drop-off is one minus the rate")
check(close(S["targets"]["entries_target"], S["targets"]["edition_size"] / rate, 0.5) and S["targets"]["entry_rate"] == rate, "the entries target is asked at the rate")
check(S["sellthrough"]["conversion"] == rate, "the sell-through converts at the same rate")
print(f"inside the edition: hero {S['hero']['now']} of {S['edition']['total']}, projected {S['hero']['projected']}")

# 2. the release's own rate runs through the page
cfg = copy.deepcopy(base); cfg["entry_conversion_rate"] = 0.7
R, at = run(cfg)
check(close(R["hero"]["now"], secured(at, 0.7), 2), f"the hero reads entries at the release's rate: {R['hero']['now']} vs {secured(at, 0.7):.1f}")
check(R["paid"]["dropOff"] == 0.3 and R["sellthrough"]["conversion"] == 0.7 and R["benchmarks"]["chargeDropOff"] == 0.3, "paid, sell-through and the card's fallback all read 0.7")
check(close(R["targets"]["entries_target"], R["targets"]["edition_size"] / 0.7, 0.5) and R["targets"]["entry_rate"] == 0.7, "the entries target is asked at 0.7")
check(close(R["paid"]["l3dCpe"] / S["paid"]["l3dCpe"], 0.8 / 0.7, 0.01), f"the cost per converting entry is priced at the rate: {R['paid']['l3dCpe']} vs {S['paid']['l3dCpe']}")
check(close(R["paid"]["l3dRoi"], (1 - R["paid"]["cannibalisation"]) * R["paid"]["profitPerUnitAA"] / (R["paid"]["l3dCpe"] * R["paid"]["aaBudgetShare"]), 0.01), "the ROI working holds at the release's rate")
print(f"rate 0.7: hero {R['hero']['now']}, entries target {R['targets']['entries_target']:.0f}, L3D CPE {R['paid']['l3dCpe']} (0.8: {S['paid']['l3dCpe']})")

# 3. demand past the whole edition: the hero, the waterfall's actual and
#    projection are capped, every walk carries a Beyond sellout step and still
#    closes, the channels keep the demand
O, at = run(base, boost=12.0)
total = O["edition"]["total"]
demand = sum(c["now"] for c in O["channels"])
check(demand > total + 1, f"the synthetic demand runs past the edition: {demand:.0f} vs {total}")
check(O["hero"]["now"] == total and O["hero"]["projected"] == total and O["hero"]["oversubscribedUnits"] > 0, f"the hero caps at the edition: {O['hero']}")
wf = O["waterfall"]; wt = wf.get("today") or {}
check(wf["projection"] == O["hero"]["projected"] and wt.get("actual") == O["hero"]["now"], "the waterfall prints the hero's capped figures")
walks = [("steps", wf["steps"], wf["projection"] - wf["target"]),
         ("today.steps", wt.get("steps") or [], (wt.get("actual") or 0) - (wt.get("target") or 0))]
if "stepsBm" in wf:
    walks += [("stepsBm", wf["stepsBm"], wf["projection"] - wf["benchmark"]),
              ("today.stepsBm", wt.get("stepsBm") or [], (wt.get("actual") or 0) - (wt.get("benchmark") or 0))]
for key, steps, gap in walks:
    over = next((s for s in steps if s["key"] == "oversubscribed"), None)
    check(over is not None and over["value"] < 0 and steps[-1] is over, f"{key}: the Beyond sellout step is last: {steps}")
    check(abs(sum(s["value"] for s in steps) - gap) < 0.5, f"{key}: the steps close on the capped figure: {sum(s['value'] for s in steps)} vs {gap}")
check(close(-next(s["value"] for s in wt["steps"] if s["key"] == "oversubscribed"), demand - total, 1.5), "the step is the demand the edition cannot hold")
print(f"oversubscribed: demand {demand:.0f} of {total}, hero {O['hero']['now']} +{O['hero']['oversubscribedUnits']}")

# 4. the adoption itself: the channels scale to the sell-through's count, the
#    remaining projection to the room, and the funnel steps still reconcile
st = {"sold": 100.0, "drafts": 10.0, "soldPredicted": 50.0, "futureEntriesPredicted": 30.0}
chans = [
    {"key": "a", "now": 80.0, "proj": 120.0, "exp": 70.0, "parts": [{"name": "x", "value": 50.0}, {"name": "y", "value": 30.0}],
     "daily": [{"actual": 40.0, "proj": None}, {"actual": 80.0, "proj": 80.0}, {"actual": None, "proj": 100.0}, {"actual": None, "proj": 120.0}]},
    {"key": "b", "now": 60.0, "proj": 90.0, "exp": 50.0, "parts": [],
     "daily": [{"actual": 30.0, "proj": None}, {"actual": 60.0, "proj": 60.0}, {"actual": None, "proj": 75.0}, {"actual": None, "proj": 90.0}]},
]
fbg = {"a": {"conv_actual": 0.08, "bps_actual": 0.064, "contrib_traffic": 4.0, "contrib_conversion": 6.0, "contrib_buyers": 5.0, "contrib_per_buyer": 1.0},
       "b": {"conv_actual": 0.06, "bps_actual": 0.05, "contrib_traffic": 3.0, "contrib_conversion": 7.0, "contrib_buyers": 6.0, "contrib_per_buyer": 1.0}}
now_, proj_ = build.adopt_sellthrough(st, chans, fbg, 140.0, 210.0, False, 1.25, 1.25)
check(close(now_, 160, 0.01) and close(proj_, 190, 0.01), f"the hero adopts sold + drafts + winners, and the room-capped future: {now_} {proj_}")
check(close(sum(c["now"] for c in chans), 160, 0.2) and close(sum(c["proj"] for c in chans), 190, 0.2), f"the channels sum to it: {[c['now'] for c in chans]} {[c['proj'] for c in chans]}")
for c in chans:
    fb = fbg[c["key"]]
    check(close(fb["contrib_traffic"] + fb["contrib_conversion"], c["now"] - c["exp"], 0.2), f"{c['key']}: traffic + conversion still sum to now - expected")
    check(c["daily"][1]["actual"] == c["now"] or close(c["daily"][1]["actual"], c["now"], 0.05), f"{c['key']}: the last actual is the channel's now")
    check(c["daily"][-1]["proj"] is not None and close(c["daily"][-1]["proj"], c["proj"], 0.05), f"{c['key']}: the last projection is the channel's")
check(close(chans[0]["parts"][0]["value"], 50 * 160 / 140, 0.1), "the parts scale with the channel")
check(close(fbg["a"]["conv_actual"], 0.08 * 160 / 140, 1e-6), "conversion per session scales with the units")
check(build.adopt_sellthrough({"sold": 0, "drafts": 0, "soldPredicted": 0}, [], {}, 0.0, 0.0, False) == (0.0, 0.0), "nothing to adopt on an empty release")
print("FAILED" if failed else "ok: sellout cap, entry rate, adoption", failed if failed else "")
