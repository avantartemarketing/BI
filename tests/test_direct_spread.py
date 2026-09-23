#!/usr/bin/env python3
"""Direct spread over the other channels (docs 1.3): the redistribution keeps
every day's totals and hands Direct's volume out pro rata, the benchmark's
split is spread the same way without moving its medians, and a page built
both ways carries the differing blocks under variants.direct_spread with the
totals untouched.
python3 tests/test_direct_spread.py (needs pandas)"""
import sys, json, pathlib, random, copy
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)
def close(a, b, tol=1e-6):
    return a is not None and b is not None and abs(a - b) <= tol * max(abs(b), 1.0)

# ---- the redistribution on a small frame
d0 = date(2026, 9, 1)
rows = []
for day, per in ((d0, {"AA Email Man": 100, "Paid Social": 300, "Direct": 40, "Organic Search": 60}),
                 (d0 + timedelta(days=1), {"AA Email Man": 10, "Direct": 30}),          # Direct spread over one other channel
                 (d0 + timedelta(days=2), {"Direct": 20})):                              # nothing else that day: pooled
    for ch, ent in per.items():
        rows.append({"channel": ch, "event_date": day, "simple_release_name": "R", "campaign_stage": "launch",
                     "Sessions_Total": ent * 10.0, "Total_Product_Units": ent * 0.3, "Product_Units_Private_Room": 0.0,
                     "Draw_Entries_Total_Units_No_Conv": ent * 0.7, "Draw_Entries_Eligible_Units": float(ent),
                     "days_since_announcement": (day - d0).days, "days_until_launch": 10, "pct_days_since_announcement": 0.1, "pct_days_until_launch": 0.9})
df = pd.DataFrame(rows)
out = build.redistribute_channel(df, "Direct")
check("Direct" not in set(out["channel"]), "Direct leaves the frame")
for col in ("Sessions_Total", "Draw_Entries_Eligible_Units", "Total_Product_Units"):
    check(close(float(out[col].sum()), float(df[col].sum())), f"{col}: the release total is kept ({out[col].sum()} vs {df[col].sum()})")
day1 = out[out["event_date"] == d0].set_index("channel")["Draw_Entries_Eligible_Units"]
# day 1's Direct lands in proportion to that day's mix; day 3's, with nothing
# else that day, is pooled and shared on the release's mix (470 entries in all)
check(close(day1["Paid Social"], 300 + 40 * 300 / 460 + 20 * 300 / 470) and close(day1["AA Email Man"], 100 + 40 * 100 / 460 + 20 * 100 / 470)
      and close(day1["Organic Search"], 60 + 40 * 60 / 460 + 20 * 60 / 470), f"day 1 shares out Direct in proportion: {day1.to_dict()}")
day2 = out[out["event_date"] == d0 + timedelta(days=1)].set_index("channel")["Draw_Entries_Eligible_Units"]
check(close(day2["AA Email Man"], 40.0 + 20 * 10 / 470), f"day 2's Direct lands on the one other channel, plus day 3's pooled share: {day2.to_dict()}")
check(build.redistribute_untracked(df).equals(build.redistribute_channel(df, "Untracked")), "the untracked fold is the same rule")
sh = build.channel_share(df, "Direct")
check(close(sh["entries"], 90 / 560, 1e-3), f"Direct's share of the frame's entries: {sh}")
shg = build.channel_share(df, "Direct", within_group=True)
check(close(shg["entries"], 90 / 150, 1e-3), f"and of its own group: {shg}")

# ---- the benchmark's split, spread the same way
profile = {"units": 800.0, "sessions": 40000.0, "entries": 1000.0,
           "units_by_group": {"aa_email": 300.0, "aa_social": 50.0, "referral_artist": 30.0, "search_direct_other": 220.0, "paid": 200.0},
           "sessions_by_group": {"aa_email": 10000.0, "aa_social": 2000.0, "referral_artist": 500.0, "search_direct_other": 7500.0, "paid": 20000.0},
           "share_units": {}, "share_sessions": {}, "conv": {g: 0.03 for g in baskets.GROUPS}}
norm = {"units": 0.5, "sessions": 0.6, "entries": 0.55, "n": 20, "recentMonths": 18}
sp = build.spread_profile(profile, norm)
ug = sp["units_by_group"]
check(close(sum(ug.values()), 800.0), f"the median units do not move: {sum(ug.values())}")
rest = 800.0 - 110.0
check(close(ug["search_direct_other"], 110.0 + 110.0 * 110.0 / rest) and close(ug["paid"], 200.0 + 110.0 * 200.0 / rest), f"Direct's half of the group lands pro rata: {ug}")
check(close(sum(sp["sessions_by_group"].values()), 40000.0) and sp["conv"] == profile["conv"], "sessions kept, conversion held")
check(build.spread_profile(profile, None) is profile, "no norm, no change")

# ---- a page built both ways on the synthetic harness
base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["campaign_name"] = "Synthetic · Enter draw"; base["campaign_names"] = [base["campaign_name"]]
announce, launch = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
pr_open = date.fromisoformat(base["private_room_open"]); name = base["release_name"]
TODAY = announce + timedelta(days=12)
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]
rows, rnd, d = [], random.Random(7), min(pr_open, announce); LL = (launch - announce).days
while d <= TODAY:
    dsa, dul = (d - announce).days, (launch - d).days
    for ch, sess, ent in CH:
        s_, e_ = sess * (1 + 0.1 * rnd.random()), ent
        rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                     "Sessions_Total": s_, "Total_Product_Units": e_ * 0.3, "Product_Units_Private_Room": 0.0,
                     "Draw_Entries_Total_Units_No_Conv": e_ * 0.7, "Draw_Entries_Eligible_Units": e_,
                     "days_since_announcement": dsa, "days_until_launch": dul, "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
    d += timedelta(days=1)
at = pd.DataFrame(rows)
sp_rows, d = [], announce
while d <= TODAY:
    sp_rows.append({"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800, "link_clicks": 40, "spend": 500.0})
    d += timedelta(days=1)
spend = pd.DataFrame(sp_rows)
emails, content, people = build.load_emails(), build.load_content(), build.load_people()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())
# the panel's launches have no rows in this synthetic frame, so the norm the
# build would read is empty and the benchmark's split stays; a norm is set by
# hand so the targets' spread is exercised too
empty = build.direct_share_norm(at, panel, TODAY)
check(empty is not None and empty.get("units") is None, f"no panel rows, no norm: {empty}")
check(build.spread_profile(profile, empty) == profile or build.spread_profile(profile, empty)["units_by_group"] == profile["units_by_group"], "an empty norm leaves the split alone")
direct_norm = {"units": 0.5, "sessions": 0.5, "entries": 0.5, "n": 10, "recentMonths": 18}
snap = build.with_direct_spread(build.build_release, copy.deepcopy(base), at, spend, emails, content, curves, TODAY,
                                build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
build.check_snapshot(snap)
var = snap["variants"]["direct_spread"]
check("channels" in var and "funnelByGroup" in var and "paid" in var and "targets" in var and "groupTargets" in var,
      f"the differing blocks ride under the variant: {sorted(var)}")
check("hero" not in var or abs(var["hero"]["now"] - snap["hero"]["now"]) <= 1, f"the hero's secured units do not move: {var.get('hero', {}).get('now')} vs {snap['hero']['now']}")
check(all(k not in var for k in ("economics", "untracked", "directShare", "email", "social", "draw", "edition", "id")), "what Direct cannot touch is not in the variant")
sdo_t = var["groupTargets"]["search_direct_other"]["units"]
check(sdo_t < snap["groupTargets"]["search_direct_other"]["units"] and close(sum(g["units"] for g in var["groupTargets"].values()), sum(g["units"] for g in snap["groupTargets"].values()), 1e-6),
      f"the target split moves the same way and still adds up: {sdo_t} vs {snap['groupTargets']['search_direct_other']['units']}")
sdo = lambda chans: next(c for c in chans if c["key"] == "search_direct_other")
paid = lambda chans: next(c for c in chans if c["key"] == "paid")
check(sdo(var["channels"])["now"] < sdo(snap["channels"])["now"], f"Search/direct/other loses Direct: {sdo(var['channels'])['now']} < {sdo(snap['channels'])['now']}")
check(paid(var["channels"])["now"] > paid(snap["channels"])["now"], f"paid gains its share: {paid(var['channels'])['now']} > {paid(snap['channels'])['now']}")
check(var["paid"]["entriesToDate"] > snap["paid"]["entriesToDate"] and var["paid"]["cumRoi"] > snap["paid"]["cumRoi"], "paid ROI reads the entries it is given")
check(close(sum(c["now"] for c in var["channels"]), sum(c["now"] for c in snap["channels"]), 1e-3), "the channels still add up to the same secured units")
ds = snap["directShare"]
check(ds and 0 < ds["entries"] < 1 and 0 < ds["units"] < 1, f"Direct's share of the window is published: {ds}")
print(f"direct share of entries {ds['entries']:.1%}; sdo {sdo(snap['channels'])['now']:.0f} -> {sdo(var['channels'])['now']:.0f}, paid {paid(snap['channels'])['now']:.0f} -> {paid(var['channels'])['now']:.0f}; variant blocks {sorted(var)}")
print("FAILED" if failed else "ok: direct spread", failed if failed else "")
sys.exit(1 if failed else 0)
