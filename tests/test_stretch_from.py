#!/usr/bin/env python3
"""Where the stretch comes from (BENCHMARK_SPEC 4.4): each channel group's
target is its benchmark plus its share of the gap to the edition - the
basket's own shares by default, which is every group lifted by the same K,
or the shares typed on the Target setting tab (most of it from paid, say),
when each group carries its own uplift, its sessions and entries with it,
and the paid budget follows the paid units. Python (etl/build.py
stretch_weights, allocate_stretch, benchmark_targets) and JS
(shared/benchmarkModel.mjs) agree, and a built page's plan lines, expected
by today and hero identity follow each group's own uplift.
python3 tests/test_stretch_from.py (needs pandas and node)"""
import copy
import json
import pathlib
import subprocess
import sys
from datetime import date, timedelta

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets  # noqa: E402
import build  # noqa: E402

G = baskets.GROUPS
failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def close(a, b, tol=1e-6):
    a, b = float(a), float(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


PROFILE = {
    "units": 400.0, "units_sold": 360.0, "n_short": 2, "sessions": 50000.0, "entries": 380.0, "units_p25": 300.0, "units_p75": 600.0,
    "units_by_group": {"aa_email": 150.0, "aa_social": 20.0, "referral_artist": 30.0, "search_direct_other": 100.0, "paid": 100.0},
    "sessions_by_group": {"aa_email": 5000.0, "aa_social": 2000.0, "referral_artist": 3000.0, "search_direct_other": 10000.0, "paid": 30000.0},
    "share_units": {"aa_email": 0.375, "aa_social": 0.05, "referral_artist": 0.075, "search_direct_other": 0.25, "paid": 0.25},
    "share_sessions": {"aa_email": 0.1, "aa_social": 0.04, "referral_artist": 0.06, "search_direct_other": 0.2, "paid": 0.6},
    "conv": {g: 0.01 for g in G}, "private_room_share": 0.2, "units_per_buyer": 1.0, "cost_per_purchase": 150.0, "n_costed": 4,
}
REL = {"edition_size": 600.0, "unit_price": 1000.0, "units_per_buyer": 1.0}

# ---- the weights: the basket's shares unless the tab placed the stretch
even = build.stretch_weights(REL, PROFILE)
check(all(close(even[g], PROFILE["units_by_group"][g] / 400.0) for g in G), f"blank: the basket's own shares: {even}")
check(not build.stretch_typed(REL, PROFILE), "blank is not a placed stretch")
w = build.stretch_weights(dict(REL, stretch_from={"paid": 80, "aa_email": 20}), PROFILE)
check(close(w["paid"], 0.8) and close(w["aa_email"], 0.2) and all(w[g] == 0.0 for g in ("aa_social", "referral_artist", "search_direct_other")),
      f"typed shares are read over the groups and renormalised: {w}")
check(build.stretch_typed(dict(REL, stretch_from={"paid": 80, "aa_email": 20}), PROFILE), "a share on a group with a benchmark is a placed stretch")
w1 = build.stretch_weights(dict(REL, stretch_from={"paid": 1}), PROFILE)
check(close(w1["paid"], 1.0) and sum(w1.values()) == 1.0, f"all from paid: {w1}")
noneb = dict(PROFILE, units_by_group=dict(PROFILE["units_by_group"], paid=0.0))
w0 = build.stretch_weights(dict(REL, stretch_from={"paid": 1}), noneb)
check(w0["paid"] == 0.0 and close(sum(w0.values()), 1.0) and close(w0["aa_email"], 150.0 / 300.0),
      f"a group with no benchmark to lift takes none, and the shares fall back to the basket's: {w0}")
check(not build.stretch_typed(dict(REL, stretch_from={"paid": 1}), noneb), "a share on a group without a benchmark is not a placed stretch")
wjunk = build.stretch_weights(dict(REL, stretch_from={"paid": "x", "aa_email": -3}), PROFILE)
check(wjunk == even, f"unreadable or negative shares fall back to the even uplift: {wjunk}")

# ---- the allocation: benchmark plus the share of the stretch, summing to the edition
u = build.allocate_stretch(PROFILE["units_by_group"], 600.0, w)
check(close(u["paid"], 100.0 + 0.8 * 200.0) and close(u["aa_email"], 150.0 + 0.2 * 200.0) and close(u["aa_social"], 20.0)
      and close(sum(u.values()), 600.0), f"80/20 on a 200-unit stretch: {u}")
ue = build.allocate_stretch(PROFILE["units_by_group"], 600.0, even)
check(all(close(ue[g], PROFILE["units_by_group"][g] * 1.5) for g in G), f"the even weights are the even uplift, x1.5 everywhere: {ue}")
# a cut bigger than a group can carry stops at zero and falls on the others
uc = build.allocate_stretch(PROFILE["units_by_group"], 300.0, {"aa_social": 0.5, "paid": 0.5})
check(close(uc["aa_social"], 0.0) and close(uc["paid"], 100.0 - 80.0) and close(sum(uc.values()), 300.0),
      f"a 100-unit cut, half on a 20-unit group: it gives its 20 and paid takes the other 80: {uc}")
uz = build.allocate_stretch(PROFILE["units_by_group"], 400.0, w)
check(all(close(uz[g], PROFILE["units_by_group"][g]) for g in G), "no stretch: the benchmark itself")

# ---- the targets: sessions and entries at each group's own uplift, the budget on the paid units
t_even = build.benchmark_targets(REL, PROFILE)
t_paid = build.benchmark_targets(dict(REL, stretch_from={"paid": 1}), PROFILE)
t_mix = build.benchmark_targets(dict(REL, stretch_from={"paid": 80, "aa_email": 20}), PROFILE)
ge, gp, gm = build.group_targets(t_even), build.group_targets(t_paid), build.group_targets(t_mix)
check(all(close(t_even["k_by_group"][g], 1.5) for g in G) and close(t_even["k"], 1.5) and not t_even["stretch_typed"],
      f"even: every group at K: {t_even['k_by_group']}")
check(close(gp["paid"]["units"], 300.0) and all(close(gp[g]["units"], PROFILE["units_by_group"][g]) for g in G if g != "paid"),
      f"all from paid: paid carries the whole stretch, the others stay at their benchmark: {[(g, gp[g]['units']) for g in G]}")
check(close(t_paid["k_by_group"]["paid"], 3.0) and all(close(t_paid["k_by_group"][g], 1.0) for g in G if g != "paid") and t_paid["stretch_typed"],
      f"and the uplifts say so: {t_paid['k_by_group']}")
check(close(gp["paid"]["sessions"], 30000.0 * 3.0) and close(gp["aa_email"]["sessions"], 5000.0),
      f"sessions follow each group's own uplift, conversion held: {gp['paid']['sessions']} {gp['aa_email']['sessions']}")
check(close(gp["paid"]["entries"], 300.0 / build.BENCH["eligible_entry_to_order"]) and close(gp["aa_email"]["entries"], 150.0 / build.BENCH["eligible_entry_to_order"]),
      "entries are the group's units at the entry rate")
check(close(t_paid["paid"]["budget"], 300.0 * 150.0) and close(t_even["paid"]["budget"], 150.0 * 150.0),
      f"the paid budget is the paid units at the price: {t_paid['paid']['budget']} vs even {t_even['paid']['budget']}")
check(close(t_paid["total_sessions"], 5000 + 2000 + 3000 + 10000 + 90000) and close(t_even["total_sessions"], 50000 * 1.5),
      f"total sessions add the groups up: {t_paid['total_sessions']} {t_even['total_sessions']}")
check(close(t_mix["k_by_group"]["paid"], 2.6) and close(t_mix["k_by_group"]["aa_email"], 190.0 / 150.0) and close(t_mix["k"], 1.5),
      f"80/20: paid x2.6, email x1.27, K still x1.5 in all: {t_mix['k_by_group']}")
for t, g_ in ((t_even, ge), (t_paid, gp), (t_mix, gm)):
    check(close(sum(x["units"] for x in g_.values()), 600.0), "the groups sum to the edition")
    check(close(t["entries_target"], 600.0 / build.BENCH["eligible_entry_to_order"]), "the entries target is the edition at the rate")
    check(close(t["stretch_units"], 200.0), "the stretch is the edition less the median")
# a group set aside takes no stretch even when a share was typed on it
off = baskets.apply_channels_off(PROFILE, ["paid"])
t_off = build.benchmark_targets(dict(REL, channels_off=["paid"], stretch_from={"paid": 70, "aa_email": 30}), off)
g_off = build.group_targets(t_off)
check(g_off["paid"]["units"] == 0.0 and close(g_off["aa_email"]["units"], 150.0 + 300.0) and close(sum(x["units"] for x in g_off.values()), 600.0),
      f"paid off: its share falls away and email carries the stretch: {[(g, g_off[g]['units']) for g in G]}")

# ---- JS agrees, figure by figure
payload = {"profile": PROFILE, "bench": {k: build.BENCH[k] for k in ("eligible_entry_to_order", "cost_per_purchase", "budget_sense_check_max_pct_of_launch_value")},
           "cases": [{"name": "even", "inp": dict(REL)}, {"name": "paid", "inp": dict(REL, stretch_from={"paid": 1})},
                     {"name": "mix", "inp": dict(REL, stretch_from={"paid": 80, "aa_email": 20})},
                     {"name": "cut", "inp": dict(REL, edition_size=300.0, stretch_from={"aa_social": 0.5, "paid": 0.5})}]}
js = subprocess.run(["node", "--input-type=module", "-e",
                     "import { benchmarkTargets, describeStretch } from './shared/benchmarkModel.mjs';"
                     "const p = JSON.parse(process.argv[1]);"
                     "const out = p.cases.map((c) => { const t = benchmarkTargets(p.profile, c.inp, p.bench);"
                     "  return { name: c.name, k: t.k, kg: t.k_by_group, w: t.stretch_from, typed: t.stretch_typed, units: t.units_by_group, sessions: t.sessions_by_group,"
                     "           paid_units: t.paid_units, budget: t.paid.budget, total_sessions: t.total_sessions, stretch_units: t.stretch_units }; });"
                     "out.push({ name: 'words', even: describeStretch({ stretchTyped: false }), placed: describeStretch({ stretchTyped: true, stretchFrom: { paid: 0.8, aa_email: 0.2 }, kByGroup: { paid: 2.6, aa_email: 1.2667 } }, { paid: 'Paid', aa_email: 'AA Email' }) });"
                     "console.log(JSON.stringify(out));", json.dumps(payload)], capture_output=True, text=True, cwd=ROOT)
check(js.returncode == 0, f"node ran: {js.stderr[-400:]}")
if js.returncode == 0:
    got = {r["name"]: r for r in json.loads(js.stdout)}
    for name, t, rel in (("even", t_even, REL), ("paid", t_paid, None), ("mix", t_mix, None)):
        j = got[name]
        g_ = build.group_targets(t)
        ok = close(j["k"], t["k"]) and j["typed"] == t["stretch_typed"] and close(j["paid_units"], t["paid_units"]) and close(j["budget"], t["paid"]["budget"]) \
            and close(j["total_sessions"], t["total_sessions"]) and close(j["stretch_units"], t["stretch_units"]) \
            and all(close(j["kg"][g], t["k_by_group"][g]) and close(j["w"][g], t["stretch_from"][g]) and close(j["units"][g], g_[g]["units"])
                    and close(j["sessions"][g], g_[g]["sessions"]) for g in G)
        check(ok, f"JS agrees on {name}: {j}")
    jc = got["cut"]
    check(close(jc["units"]["aa_social"], 0.0) and close(jc["units"]["paid"], 20.0) and close(sum(jc["units"].values()), 300.0), f"JS clamps the cut the same way: {jc['units']}")
    words = got["words"]
    check(words["even"] == "the same even uplift in every channel and on every day" and "Paid 80% (×2.60)" in words["placed"] and "AA Email 20% (×1.27)" in words["placed"],
          f"the cards' words: {words}")

# ---- a built page: every line follows its group's own uplift
base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["release_name"] = "Synthetic Artist · Stretch · 2026 Q3"
base["campaign_name"] = "SyntheticStretch · Enter draw"
base["campaign_names"] = [base["campaign_name"]]
base["stretch_from"] = {"paid": 1}
ann, lau = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
TODAY = ann + timedelta(days=(lau - ann).days // 2)
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8), ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6)]
rows, d = [], min(date.fromisoformat(base["private_room_open"]), ann)
LL = (lau - ann).days
while d <= TODAY:
    for ch, sess, ent in CH:
        rows.append({"channel": ch, "event_date": d, "simple_release_name": base["release_name"], "campaign_stage": "launch",
                     "Sessions_Total": float(sess), "Total_Product_Units": ent * 0.3, "Product_Units_Private_Room": 0.0,
                     "Draw_Entries_Total_Units_No_Conv": ent * 0.7, "Draw_Entries_Eligible_Units": ent,
                     "days_since_announcement": (d - ann).days, "days_until_launch": (lau - d).days,
                     "pct_days_since_announcement": (d - ann).days / LL, "pct_days_until_launch": (lau - d).days / LL})
    d += timedelta(days=1)
spend = pd.DataFrame([{"campaign_name": base["campaign_name"], "spend_date": ann + timedelta(days=i), "impressions": 1000, "reach": 800,
                       "link_clicks": 40, "spend": 500.0} for i in range((TODAY - ann).days + 1)])
build._BASKET_CURVES.clear()
snap = build.build_release(copy.deepcopy(base), pd.DataFrame(rows), spend, build.load_emails(), build.load_content(),
                           json.loads((ROOT / "data/app/curves.json").read_text()), TODAY, build.load_artist_posts(), {}, None,
                           baskets.load_panel(), build.load_people(), full_through=TODAY, seen=1.0)
build.check_snapshot(snap)
bm = snap["benchmark"]
check(bm["stretchTyped"] and close(bm["stretchFrom"]["paid"], 1.0) and all(bm["stretchFrom"][g] == 0.0 for g in G if g != "paid"),
      f"the block says the stretch is placed on paid: {bm['stretchFrom']}")
kg = bm["kByGroup"]
check(all(close(kg[g], 1.0, 1e-3) for g in G if g != "paid" and bm["unitsByGroup"][g] > 0) and kg["paid"] > 1.0 + 1e-6,
      f"the other groups keep their benchmark, paid carries the stretch: {kg}")
edition = snap["edition"]["target"]
check(close(sum(v["units"] for v in snap["groupTargets"].values()), edition, 1e-3), "the group targets still sum to the edition")
exp_sum = 0.0
for c in snap["channels"]:
    g = c["key"]
    kk = kg[g]
    for r in c["daily"]:
        check(abs(r["plan"] - r["bm"] * kk) <= 0.006 * kk + 0.02, f"{g} {r['date']}: plan {r['plan']} is not bm {r['bm']} x its uplift {kk}")
    check(abs(c["bmExp"] * kk - c["exp"]) <= 0.06 * kk + 0.06, f"{g}: bmExp {c['bmExp']} x {kk} is not exp {c['exp']}")
    exp_sum += c["bmExp"] * kk
check(abs(exp_sum - snap["hero"]["expectedToday"]) <= 1.0 + 0.01 * exp_sum, f"the hero's expected today is the groups' benchmarks at their own uplifts: {exp_sum:.1f} vs {snap['hero']['expectedToday']}")
paid_t = snap["groupTargets"]["paid"]["units"]
check(close(snap["targets"]["paid"]["budget"], paid_t * snap["targets"]["paid"]["cost_per_purchase"], 1e-6), "the paid budget is the paid units at the price")
print(f"built: K {bm['k']}, paid x{kg['paid']}, paid target {paid_t:.1f} of {edition:.0f}")

print("ok: where the stretch comes from" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
