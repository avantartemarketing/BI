#!/usr/bin/env python3
"""The Direct switch on a timed launch's page (docs/TL_SPEC.md §3b): the spread
keeps every step's totals and hands Direct's volume out pro rata over the other
tracked channels (a step with nothing else to take it keeps it in place on the
launch's mix; the untracked rows stay apart), the basket's costs are rescaled so
its budget does not move, the plan re-split by channel keeps its headline and
its budgets, and every live page carries the differing blocks under
variants.direct_spread with its totals, its plan, a paid signup's worth and the
sell-through forecast untouched.
  python3 tests/test_tl_direct_spread.py
"""
from __future__ import annotations

import pathlib
import sys
from datetime import date, datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import build as B  # noqa: E402
import tl  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def near(a, b, tol=1e-6):
    return a is not None and b is not None and abs(float(a) - float(b)) <= tol * max(abs(float(b)), 1.0)


# ---- the rule on a small daily frame
d0 = date(2026, 9, 1)
rows = []
for day, per in ((d0, {"AA Email Man": 100, "Paid Social": 300, "Direct": 40, "Organic Search": 60, "Untracked": 20}),
                 (date(2026, 9, 2), {"AA Email Man": 10, "Direct": 30}),          # Direct spread over one other channel
                 (date(2026, 9, 3), {"Direct": 20})):                              # nothing else that day: kept in place on the mix
    for ch, n in per.items():
        rows.append({"release": "R", "date": day.isoformat(), "channel": ch, "sessions": n * 10.0, "signups": float(n), "units": n * 0.3, "day": day})
f = pd.DataFrame(rows)
f["group"] = f["channel"].map(tl.GROUP_OF).fillna("untracked")
out = tl.spread_direct(f, ["day", "date"])
check("Direct" not in set(out["channel"]), "Direct leaves the frame")
for c in ("sessions", "signups", "units"):
    check(near(out[c].sum(), f[c].sum()), f"{c}: the launch's total is kept")
    a, b = out.groupby("day")[c].sum(), f.groupby("day")[c].sum()
    check(all(near(a.get(k, 0.0), b[k]) for k in b.index), f"{c}: every day's total is kept")
d1 = out[out["day"] == d0].set_index("channel")["signups"]
check(near(d1["Paid Social"], 300 + 40 * 300 / 460) and near(d1["AA Email Man"], 100 + 40 * 100 / 460) and near(d1["Organic Search"], 60 + 40 * 60 / 460),
      f"day 1 shares Direct out in proportion to that day's mix: {d1.to_dict()}")
check(near(d1["Untracked"], 20.0), "the untracked rows stay apart")
d2 = out[out["day"] == date(2026, 9, 2)].set_index("channel")["signups"]
check(near(d2["AA Email Man"], 40.0) and len(d2) == 1, f"day 2's Direct lands on the one other channel: {d2.to_dict()}")
d3 = out[out["day"] == date(2026, 9, 3)].set_index("channel")["signups"]
check(near(d3["Paid Social"], 20 * 300 / 470) and near(d3["AA Email Man"], 20 * 110 / 470) and near(d3["Organic Search"], 20 * 60 / 470),
      f"day 3's Direct, with nothing else that day, stays on its day split on the launch's mix: {d3.to_dict()}")
check(set(out["group"]) == {"aa_email", "paid", "search_direct_other", "untracked"}, "the groups follow the channels")
check(tl.spread_direct(f[f["channel"] != "Direct"], ["day", "date"]).equals(f[f["channel"] != "Direct"]), "a frame without Direct comes back as it is")
sh = tl.direct_share(f, ("signups", "sessions", "units"))
check(near(sh["signups"], 90 / 580, 1e-3) and near(sh["units"], 90 / 580, 1e-3), f"Direct's share of the frame's figures: {sh}")

# ---- the orders table's lines: an hour of one work in one status is the step
ts = pd.Timestamp("2026-06-30 14:00", tz="UTC")
orows = []
for h, title, status, per in ((ts, "A", "paid", {"AA Email Man": 4, "Direct": 2}), (ts, "A", "awaiting", {"Direct": 1}), (ts, "B", "paid", {"Paid Social": 6, "Direct": 3})):
    for ch, n in per.items():
        orows.append({"release": "R", "product_title": title, "hour": h.isoformat(), "channel": ch, "status": status, "units": float(n), "orders": float(n), "units_private": 0.0, "prints_offered": float(n), "frames": n / 2, "value": n * 100.0, "ts": h})
o = pd.DataFrame(orows)
o["group"] = o["channel"].map(tl.GROUP_OF).fillna("untracked")
so = tl.spread_direct(o, ["ts", "hour", "product_title", "status"])
check(near(so["units"].sum(), o["units"].sum()) and near(so["value"].sum(), o["value"].sum()), "the orders' totals are kept")
a_paid = so[(so["product_title"] == "A") & (so["status"] == "paid")].set_index("channel")["units"]
check(near(a_paid["AA Email Man"], 6.0) and len(a_paid) == 1, f"work A's paid Direct units land on the channel that bought A that hour: {a_paid.to_dict()}")
a_wait = so[(so["product_title"] == "A") & (so["status"] == "awaiting")]
check(near(a_wait["units"].sum(), 1.0) and set(a_wait["channel"]) <= {"AA Email Man", "Paid Social"}, "an awaiting line nobody else has keeps its status and work, on the launch's mix")
check(near(so.groupby("product_title")["units"].sum()["B"], 9.0), "work B keeps its units")

# ---- the basket's medians with the money held, and the plan re-split
base = {"signups_by_group": {g: 100.0 for g in tl.GROUPS}, "units_by_group": {g: 10.0 for g in tl.GROUPS},
        "cost_per_signup": 8.0, "cost_per_sale": 60.0, "n_cost_per_signup": 5, "n_cost_per_sale": 4}
spread = {"signups_by_group": {**{g: 110.0 for g in tl.GROUPS}, "search_direct_other": 60.0}, "units_by_group": {**{g: 12.0 for g in tl.GROUPS}, "search_direct_other": 2.0},
          "cost_per_signup": 7.0, "cost_per_sale": 50.0}
sp = tl.spread_profile(spread, base, {"signups": 0.4, "n": 10})
check(near(sp["cost_per_signup"], 8.0 * 100 / 110) and near(sp["cost_per_sale"], 60.0 * 10 / 12), f"the costs are the Channel view's rescaled by paid's change: {sp['cost_per_signup']}, {sp['cost_per_sale']}")
check(near(sp["signups_by_group"]["paid"] * sp["cost_per_signup"], 100.0 * 8.0), "the benchmark's budget does not move")
check(sp["direct_spread"] == {"signups": 0.4, "n": 10} and sp["n_cost_per_signup"] == 5, "the norm and the counts ride along")
prof = {"signups_by_group": {"aa_email": 300.0, "aa_social": 100.0, "referral_artist": 100.0, "search_direct_other": 100.0, "paid": 400.0},
        "conv": {g: 0.05 for g in tl.GROUPS}, "share_units": {g: 0.2 for g in tl.GROUPS}, "channels_off": []}
t = {"signup_target": 2000.0, "units_target": 500.0, "budget_pre": 8000.0, "budget_window": 6000.0, "cost_per_signup": 10.0, "cost_per_sale": 60.0,
     "signups_by_group": {}, "sessions_by_group": {}, "paid_signups": 800.0, "paid_units": 90.0, "benchmark": {"signups": 1000.0}}
rt = tl.respread_targets(t, {}, prof)
check(near(sum(rt["signups_by_group"].values()), 2000.0) and near(rt["signups_by_group"]["paid"], 800.0), f"the signup target is re-split on the basket: {rt['signups_by_group']}")
check(near(rt["paid_signups"] * rt["cost_per_signup"], 8000.0) and near(rt["paid_units"] * rt["cost_per_sale"], 6000.0), "the budgets do not move: the costs follow the paid figures")
check(rt["signup_target"] == 2000.0 and rt["units_target"] == 500.0 and near(rt["benchmark"]["budget_pre"], 400.0 * rt["cost_per_signup"]), "the plan's headline stays; the benchmark's budget is the basket's paid signups at the rescaled cost")
check(tl.respread_targets(None, {}, prof) is None, "no plan, nothing to re-split")

# ---- the live pages, both ways
if not tl.PANEL.exists():
    print("note: no TL aggregation on disk - the live checks need the build")
else:
    NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
    res = tl.build_all({"as_of": NOW.date(), "now": NOW, "seen": 1.0, "launch_frame": B.load_launches(), "inputs": B.INPUTS["releases"],
                        "spend": B.load_spend(), "emails": B.load_emails(), "content": B.load_content(), "artist_posts": B.load_artist_posts(), "write": False})
    for rid, err in res["failures"]:
        check(False, f"{rid} failed to build: {err}")
    snaps = res.get("snaps", {})
    check(len(snaps) > 10, f"the live build writes TL pages ({len(snaps)})")
    n_var = 0
    for rid, s in snaps.items():
        v = (s.get("variants") or {}).get("direct_spread")
        check(isinstance(v, dict), f"{rid}: built both ways")
        if not v:
            continue
        n_var += 1
        label = f"{rid} ({s['tlState']})"
        view = {**s, **v}
        check(set(s.get("directShare") or {}) == {"signups", "sessions", "units"}, f"{label}: Direct's share of the page's own figures for the switch's words ({s.get('directShare')})")
        check("sellForecast" not in v and "paidValue" not in v and "baskets" not in v and "products" not in v, f"{label}: the forecast, a paid signup's worth, the picker's baskets and the works do not move")
        for k in ("now", "target", "expectedToday", "projected"):
            check(near(view["hero"].get(k), s["hero"].get(k), 1e-3) if s["hero"].get(k) is not None else view["hero"].get(k) is None, f"{label}: the hero's {k} does not move ({s['hero'].get(k)} vs {view['hero'].get(k)})")
        check(near(sum(c["now"] for c in view["channels"]), view["hero"]["now"], 0.6 / max(view["hero"]["now"], 1) + 1e-6), f"{label}: the spread channels sum to the hero")
        base_by = {c["key"]: c["now"] for c in s["channels"]}
        view_by = {c["key"]: c["now"] for c in view["channels"]}
        share = (s["directShare"] or {}).get("units" if s["tlState"] in ("window", "settling", "closed") else "signups") or 0.0
        if share > 0.002:
            check(view_by["search_direct_other"] <= base_by["search_direct_other"] + 0.06, f"{label}: Direct etc. gives Direct up ({base_by['search_direct_other']} -> {view_by['search_direct_other']})")
            check(all(view_by[g] >= base_by[g] - 0.06 for g in tl.GROUPS if g != "search_direct_other"), f"{label}: the other groups take it ({base_by} -> {view_by})")
        if s.get("targets"):
            t0, t1 = s["targets"], view["targets"]
            for k in ("signup_target", "units_target", "budget_pre", "budget_window", "budget_total", "signup_order_rate", "purchases_per_order"):
                check((t0.get(k) is None and t1.get(k) is None) or near(t1.get(k), t0.get(k), 1e-6), f"{label}: the plan's {k} does not move ({t0.get(k)} vs {t1.get(k)})")
            check(near(sum(t1["signups_by_group"].values()), sum(t0["signups_by_group"].values()), 1e-3), f"{label}: the groups' targets still sum to the signup target")
            if t0.get("budget_pre") and t1.get("paid_signups"):
                check(near(t1["paid_signups"] * t1["cost_per_signup"], t0["budget_pre"], 1e-6), f"{label}: paid's cost is the budget over the signups it is given")
        p0, p1 = s["paid"], view["paid"]
        check((p0.get("spendBudget") is None and p1.get("spendBudget") is None) or near(p1["spendBudget"], p0["spendBudget"], 1e-6), f"{label}: the paid budget does not move")
        check(near(p1["spendToDate"], p0["spendToDate"], 1e-6), f"{label}: the spend does not move")
        if s["tlState"] in ("window", "settling", "closed") and s.get("sales") and view.get("sales"):
            check(near(view["sales"]["units"], s["sales"]["units"], 1e-6), f"{label}: the window's units do not move")
            check(near(sum(g["units"] for g in view["sales"]["byGroup"]) + view["sales"]["untracked"], s["sales"]["units"], 0.06), f"{label}: the spread groups and the untracked still sum to the units")
        bm = (view.get("benchmark") or {}).get("profile") or {}
        if view.get("benchmark"):   # a launch with no basket (the first on the panel) has no spread basket to name it
            check(isinstance(bm.get("direct_spread"), dict) and bm["direct_spread"].get("n", 0) > 0, f"{label}: the spread basket names Direct's typical share")
    check(n_var == len(snaps), f"every page is built both ways ({n_var} of {len(snaps)})")
    bisa = next((s for rid, s in snaps.items() if "bisa_butler" in rid), None)
    if bisa and bisa["tlState"] == "signups":
        v = bisa["variants"]["direct_spread"]
        check(v["channels"][4]["key"] == "paid" and v["channels"][4]["now"] > bisa["channels"][4]["now"], "Bisa Butler's paid signups take a share of Direct under the spread")
        check(v["targets"]["cost_per_signup"] < bisa["targets"]["cost_per_signup"], "and the plan's cost per signup falls to keep the budget")

print(("tl direct spread: ok" if not failed else f"tl direct spread: {failed} failed"))
sys.exit(1 if failed else 0)
