#!/usr/bin/env python3
"""The paid cost path on spend so far (docs 7): the campaign's own cost terms
are recovered from its days and shrunk to the panel's, the path prices a
bigger budget dearer both at once and as it adds up, the spends the
recommendation solves for land where they should, and the paid block
publishes one path for the ROI chart, the projection and the floor.
python3 tests/test_paid_wearout.py (needs pandas)"""
import sys, json, pathlib, copy, math
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import numpy as np
import pandas as pd
import build, baskets

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)

def close(a, b, tol=0.02):
    return a is not None and b is not None and abs(a - b) <= tol * max(abs(b), 1e-9)

B = build.BENCH
K = float(B["cpe_wearout_k"])

def days_of(spend, eps, wear, level=5.0, start=date(2026, 3, 1)):
    """Paid days whose entries follow the model exactly: level x s^(1-eps) x (1 + C/K)^-wear."""
    out, spent = [], 0.0
    for i, s in enumerate(spend):
        e = level * s ** (1 - eps) * (1 + spent / K) ** -wear
        out.append({"date": (start + timedelta(days=i)).isoformat(), "spend": float(s), "entries": float(e)})
        spent += s
    return out

# ---- the priors stand in until the campaign has the days
few = build.campaign_cost_terms(days_of([500] * 5, 0.1, 0.3))
check(few["fitDays"] == 0 and few["elasticity"] == B["cpe_spend_elasticity"] and few["wearout"] == B["cpe_wearout"],
      f"five days: the priors as they are: {few}")

# ---- a ramping campaign with plenty of entries: its own terms come back
ramp = [300 * 1.12 ** i for i in range(24)]
own = build.campaign_cost_terms(days_of(ramp, 0.12, 0.35, level=40.0))
check(own["fitDays"] == 24, f"every day with spend is fitted: {own['fitDays']}")
check(close(own["elasticityOwn"], 0.12, 0.25) and close(own["wearoutOwn"], 0.35, 0.1),
      f"the campaign's own terms are recovered: eps {own['elasticityOwn']} w {own['wearoutOwn']}")
check(own["ownCorrelation"] is not None and own["ownCorrelation"] < 0,
      f"a ramp ties a bigger day to more spend so far: correlation {own['ownCorrelation']}")
# a tight campaign keeps its own pair (shrunk together, the pair can move a
# touch past its own values along the line its data cannot pin down)
check(abs(own["wearout"] - own["wearoutOwn"]) < 0.02 and abs(own["elasticity"] - own["elasticityOwn"]) < 0.03,
      f"a precise campaign keeps its own terms: {own['elasticity']}/{own['wearout']} vs {own['elasticityOwn']}/{own['wearoutOwn']}")
# a thin one leans on the panel
thin = build.campaign_cost_terms(days_of(ramp[:9], 0.12, 0.8, level=0.6))
check(thin["fitDays"] == 9 and abs(thin["wearout"] - B["cpe_wearout"]) < abs(thin["wearoutOwn"] - B["cpe_wearout"]),
      f"a noisy campaign is pulled towards the panel: own {thin['wearoutOwn']} -> {thin['wearout']} (panel {B['cpe_wearout']})")

# ---- a flat budget cannot tell its elasticity from its level: the prior's, and its own wear-out
flat = build.campaign_cost_terms(days_of([800] * 14, 0.1, 0.4, level=40.0))
check(flat["elasticityOwn"] is None and flat["elasticity"] == B["cpe_spend_elasticity"],
      f"flat budget keeps the prior elasticity: {flat['elasticity']} (own {flat['elasticityOwn']})")
check(flat["wearoutOwn"] is not None and close(flat["wearoutOwn"], 0.4, 0.1), f"and fits its wear-out: {flat['wearoutOwn']}")

# ---- a campaign getting cheaper as it spends does not get a negative wear-out
cheap = build.campaign_cost_terms(days_of(ramp, 0.1, -0.5, level=40.0))
check(cheap["wearoutOwn"] < 0 and cheap["wearout"] >= 0, f"negative own wear-out is floored at 0: {cheap['wearoutOwn']} -> {cheap['wearout']}")

# ---- the path
eps, wear = 0.1, 0.25
p = build.CostPath(cpe_now=100.0, spend_ref=1000.0, clock_ref=20000.0, spent=20000.0, n_days=10, eps=eps, wear=wear, k=K)
m = p.multipliers(1000.0)
check(len(m) == 10 and close(m[0], 1.0, 1e-9), f"at the window's spend and place the first day is the window's price: {m[0]}")
check(all(b > a for a, b in zip(m, m[1:])), "the price rises every day as the spend adds up")
check(close(m[-1], ((K + 20000 + 9 * 1000) / (K + 20000)) ** wear, 1e-9), f"the last day is spend so far to the power w: {m[-1]}")
m2 = p.multipliers(2000.0)
check(close(m2[0], 2 ** eps, 1e-9), f"double the budget: the first day dearer by 2^eps only: {m2[0]}")
check(m2[-1] / m2[0] > m[-1] / m[0], "and it wears out faster: the rise to the close is steeper")
check(p.cpe_close(2000.0) > p.cpe_close(1000.0) > p.cpe_close(500.0), "the price at the close rises with the budget")
units_1k = p.units(1000.0)
check(close(units_1k, sum(1000.0 / (100.0 * x) for x in m), 1e-9), f"units are the spend over the path's prices: {units_1k}")
check(p.units(2000.0) > units_1k and p.units(2000.0) < 2 * units_1k, "twice the spend buys more, but less than twice as much")
target = 150.0
s = p.spend_for_units(target)
check(math.isfinite(s) and close(p.units(s), target, 1e-6), f"the sell-out spend buys exactly the gap: {s:.2f} -> {p.units(s):.4f}")
s_floor = p.spend_for_cpe_close(115.0)
check(math.isfinite(s_floor) and close(p.cpe_close(s_floor), 115.0, 1e-6), f"the floor spend ends the path on the floor price: {s_floor:.2f}")
check(p.spend_for_cpe_close(1.0) == 0.0, "a floor below even a euro a day's price: no spend")
check(p.spend_for_cpe_close(1e12) == math.inf, "a floor no spend reaches: no limit")
check(build.CostPath(100.0, None, 0.0, 0.0, 0, eps, wear, K).cpe_close(500.0) == 100.0, "no days left: the window's price")

# ---- the close's lift: the draw's last days buy more, the floor reads the price underneath
lift = [1.5, 1.4]
pl = build.CostPath(100.0, 1000.0, 20000.0, 20000.0, 10, eps, wear, K, lift=lift)
ml, mu_ = pl.multipliers(1000.0), pl.multipliers(1000.0, lifted=False)
check(close(ml[-1], m[-1] / 1.5, 1e-9) and close(ml[-2], m[-2] / 1.4, 1e-9) and ml[:-2] == m[:-2],
      "the close day's price is divided by lift[0], the day before's by lift[1], the rest untouched")
check(mu_ == m and close(pl.cpe_close(1000.0), p.cpe_close(1000.0), 1e-9), "the floor's price at the close is the one underneath the lift")
check(pl.units(1000.0) > p.units(1000.0), "the lift buys more units by the close")
# a window in the rush paid a price the rush cut: the price underneath is the window's times its lift
pa = build.CostPath(100.0, 1000.0, 20000.0, 20000.0, 1, eps, wear, K, lift=lift, anchor_lift=1.4)
check(close(pa.multipliers(1000.0)[0], 1.4 / 1.5, 1e-9) and close(pa.cpe_close(1000.0), 140.0, 1e-9),
      f"a window the day before the close, the close ahead: {pa.multipliers(1000.0)[0]:.4f}, underneath {pa.cpe_close(1000.0):.1f}")

# ---- the campaign's own last days are read as the close's rush, not as its wear-out
close_day = date(2026, 3, 1) + timedelta(days=len(ramp) - 1)
rushed = days_of(ramp, 0.12, 0.35, level=40.0)
for i, lf in ((len(ramp) - 1, B["cpe_close_lift"][0]), (len(ramp) - 2, B["cpe_close_lift"][1])):
    rushed[i]["entries"] *= lf
with_close = build.campaign_cost_terms(rushed, close=close_day)
without = build.campaign_cost_terms(rushed)
check(close(with_close["wearoutOwn"], 0.35, 0.05) and close(with_close["elasticityOwn"], 0.12, 0.25),
      f"with the close's date the campaign's own terms come back: eps {with_close['elasticityOwn']} w {with_close['wearoutOwn']}")
miss = lambda t: abs(t["elasticityOwn"] - 0.12) + abs(t["wearoutOwn"] - 0.35)
# on a ramp the rush lands on the biggest days: without the date it is read as
# a cheaper big day and, through the pair's tie, as more wear-out
check(miss(without) > miss(with_close) + 0.05,
      f"without it the rush skews them: eps {without['elasticityOwn']} w {without['wearoutOwn']}")

# ---- the paid block: one path for the chart, the projection and the floor
base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["release_name"] = "Synthetic Artist · Wear-out · 2026 Q3"
base["campaign_name"] = "SyntheticWear · Enter draw"
base["campaign_names"] = [base["campaign_name"]]
announce, launch = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
pr_open = date.fromisoformat(base["private_room_open"])
name = base["release_name"]
TODAY = announce + timedelta(days=14)
LL = (launch - announce).days
spend_by_day = {announce + timedelta(days=i): 400 * 1.15 ** i for i in range((TODAY - announce).days + 1)}

def frame(through):
    rows, d, spent = [], min(pr_open, announce), 0.0
    while d <= through:
        dsa, dul = (d - announce).days, (launch - d).days
        s = spend_by_day.get(d, 0.0)
        paid_e = 0.05 * s ** 0.9 * (1 + spent / K) ** -0.3 if s else 0.0
        spent += s
        for ch, sess, ent in (("AA Email Man", 300, 1.2), ("Direct", 200, 0.8), ("Paid Social", 250, paid_e)):
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": sess, "Total_Product_Units": ent * 0.3, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": ent * 0.7, "Draw_Entries_Eligible_Units": ent,
                         "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

spend_frame = pd.DataFrame([{"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                             "link_clicks": 40, "spend": s} for d, s in spend_by_day.items()]
                           # spend ahead of the window counts on the clock
                           + [{"campaign_name": base["campaign_name"], "spend_date": min(pr_open, announce) - timedelta(days=3),
                               "impressions": 0, "reach": 0, "link_clicks": 0, "spend": 5000.0}])
snap = build.build_release(copy.deepcopy(base), frame(TODAY), spend_frame, build.load_emails(), build.load_content(),
                           json.loads((ROOT / "data/app/curves.json").read_text()), TODAY, build.load_artist_posts(), {}, None,
                           baskets.load_panel(), build.load_people(), full_through=TODAY, seen=1.0)
build.check_snapshot(snap)
paid, bud = snap["paid"], snap["paid"]["budget"]
ct = bud["costTerms"]
check(ct["fitDays"] >= 8 and bud["wearout"] > 0, f"the synthetic campaign fits its own wear-out: {ct}")
check(close(bud["spentSoFar"], 5000.0 + sum(spend_by_day.values()), 1e-6), f"the clock counts the spend ahead of the window: {bud['spentSoFar']}")
path = [r["roi"] for r in paid["roiPath"]]
lifts = bud["closeLift"]
# the path lifts its last days only with the switch on (off, the fit still
# holds the lift and the path runs on the curve alone)
applied = B["cpe_close_lift"] if B.get("cpe_close_lift_applied") else []
check(lifts == applied and bud["liftAtWindow"] == 1.0,
      f"the block carries the lift the path applies ({applied}), none in the window: {lifts} {bud['liftAtWindow']}")
body = path[:-len(lifts)] if lifts else path
check(len(path) == bud["daysLeft"] and all(b < a for a, b in zip(body, body[1:])),
      "the ROI line falls every day at today's spend" + (" until the close's last days" if lifts else ", to the close"))
if lifts:
    check(path[-1] > path[-len(lifts) - 1], "and rises on them, the deadline's rush")
end_lift = lifts[0] if lifts else 1.0
check(close(path[-1], paid["l3dRoi"] * end_lift / bud["wearToClose"], 0.01),
      f"the line ends at the L3D over the path's rise (times the close day's lift when applied): {path[-1]} vs {paid['l3dRoi']} x {end_lift} / {bud['wearToClose']}")
check(close(bud["cpeAtClose"], bud["cpeNow"] * bud["wearToClose"], 0.01), "the price at close is the window's times the same rise")
if bud["recommended"] and bud["recommended"] > bud["current"] * 1.01:
    check(bud["cpeAtRecommended"] > bud["cpeAtClose"], "a bigger recommended budget ends the path dearer")
check(close(paid["roiDeclineModel"]["dailyFactor"], (1 / bud["wearToClose"]) ** (1 / bud["daysLeft"]), 0.001),
      "the fallback factor is the path's average fall a day")
check("driftPerDay" not in bud and "driftToClose" not in bud, "the drift a day is gone from the block")

print("ok: paid wear-out" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
