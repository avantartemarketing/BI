#!/usr/bin/env python3
"""A timed launch's page adds up the way an LE page does.

etl/tl.py le_blocks writes the LE cards' blocks for every TL page (docs/TL_SPEC.md
§4, §5): the channels with their daily series, the funnel's two factors and their
contributions, the outcome waterfall, the hero and the paid pacing, in signups
before the window opens and in units inside it. This holds them to each other
over every TL page the live data builds, on the build's day and on a replay
inside Gregory Crewdson's 2026 window: the channels sum to the hero, each
group's contributions sum to its gap against the plan and against the basket,
the waterfall's steps sum to the gap the card prints, the series end on the
figure the hero prints, and the clock runs in days to the open and in hours
inside the window. Runs without BigQuery, on the aggregation on disk.
  python3 tests/test_tl_page.py
"""
from __future__ import annotations

import math
import pathlib
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build as B  # noqa: E402
import tl  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def near(a, b, tol):
    return a is not None and b is not None and abs(float(a) - float(b)) <= tol


def pages(now: datetime) -> dict:
    res = tl.build_all({"as_of": now.date(), "now": now, "seen": 1.0, "launch_frame": B.load_launches(), "inputs": B.INPUTS["releases"],
                        "spend": B.load_spend(), "emails": B.load_emails(), "content": B.load_content(), "artist_posts": B.load_artist_posts(), "write": False})
    for rid, err in res["failures"]:
        check(False, f"{rid} failed to build: {err}")
    return res.get("snaps", {})


def check_page(s: dict, label: str) -> None:
    st = s["tlState"]
    in_window = st in ("window", "settling", "closed")
    unit = "units" if in_window else "signups"
    hero, chans, fbg, wf, clock = s["hero"], s["channels"], s["funnelByGroup"], s.get("waterfall"), s["clock"]
    check(len(chans) == 5 and set(fbg) == set(tl.GROUPS), f"{label}: five channel groups and a funnel entry for each")
    # the clock: days from the announce to the open, hours from the sales open to the close
    check(clock["unit"] == ("hour" if in_window else "day") and s["of"] == clock["of"] and s["day"] == clock["day"], f"{label}: the clock is the state's ({clock})")
    check(0 <= s["day"] <= s["of"] >= 1, f"{label}: the day is inside the clock ({s['day']} of {s['of']})")
    if in_window and s.get("windowHours"):
        hours = (tl._ts(s["windowClose"]) - tl._ts(s["salesOpen"])).total_seconds() / 3600
        check(near(clock["of"], math.ceil(hours - 1e-9), 0), f"{label}: the window's hours on the clock ({clock['of']} vs {hours})")
    # the channels add up to the hero, the untracked share spread over them
    tot_now = sum(c["now"] for c in chans)
    check(near(tot_now, hero["now"], 0.6), f"{label}: channels sum to the hero's {unit} ({tot_now} vs {hero['now']})")
    # the channels' plan sums to the hero's where the basket gives the channels one
    if hero.get("expectedToday") is not None and all(c.get("exp") is not None for c in chans):
        check(near(sum(c["exp"] for c in chans), hero["expectedToday"], 0.6 + 0.0005 * hero["expectedToday"]), f"{label}: the channels' expected sum to the hero's")
    for c in chans:
        rows = c["daily"]
        check(len(rows) == s["of"] + 1, f"{label} {c['key']}: one row per step of the clock ({len(rows)} vs {s['of'] + 1})")
        last = [r for r in rows if r["actual"] is not None]
        check(bool(last) and near(last[-1]["actual"], c["now"], 0.06), f"{label} {c['key']}: the series ends on the channel's figure ({last[-1]['actual'] if last else None} vs {c['now']})")
        if c.get("exp") is not None:
            check(near(rows[-1]["plan"], c["target"], 0.06), f"{label} {c['key']}: the plan ends on the target")
        f = fbg[c["key"]]
        if c.get("exp") is not None:
            check(near(f["contrib_traffic"] + f["contrib_conversion"], c["now"] - c["exp"], 0.25), f"{label} {c['key']}: traffic + conversion = the gap to the plan")
        if c.get("bmExp") is not None:
            check(near(f["contrib_traffic_bm"] + f["contrib_conversion_bm"], c["now"] - c["bmExp"], 0.25), f"{label} {c['key']}: the same against the basket")
    if wf:
        t = wf["today"]
        check(near(sum(x["value"] for x in t["steps"]), t["actual"] - t["target"], 0.5), f"{label}: today's steps sum to actual - target")
        if "stepsBm" in t:
            check(near(sum(x["value"] for x in t["stepsBm"]), t["actual"] - t["benchmark"], 0.5), f"{label}: today's steps against the basket sum to actual - benchmark")
            check(near(t["target"] - t["stretch"], t["benchmark"], 0.5), f"{label}: the stretch is the target less the benchmark")
        check(near(sum(x["value"] for x in wf["steps"]), wf["projection"] - wf["target"], 0.5), f"{label}: the close steps sum to projection - target")
        check(near(t["actual"], hero["now"], 0.5) and near(t["target"], hero["expectedToday"], 0.5), f"{label}: the waterfall's levels are the hero's")
        if s["complete"]:
            check(near(wf["projection"], hero["now"], 0.5), f"{label}: a closed launch's projection is its actual")
    # the paid series: every row of the clock's days, the trailing cost where there is spend and a figure
    paid = s["paid"]
    # a launch not yet announced has no days to show
    check(isinstance(paid.get("daily"), list) and (paid["daily"] or st == "upcoming"), f"{label}: a paid series")
    check(paid["unit"] == ("sale" if in_window else "signup"), f"{label}: paid prices a {paid['unit']}")
    check(paid["spendToDate"] >= 0 and (paid["spendBudget"] is None or paid["spendBudget"] >= 0), f"{label}: paid figures are not negative")
    full = [r for r in paid["daily"] if not r["partial"]]
    for r in full:
        if r["cost1"] is not None:
            check(near(r["cost1"], r["spend"] / r["entries"], 1e-6), f"{label}: a day's cost is its spend over what it bought")
    if in_window and s.get("sellthrough"):
        stp = s["sellthrough"]
        check(stp["tl"] is True and all(r["sold"] >= 0 and r["drafts"] >= 0 for r in stp["products"]), f"{label}: the sell-through rows are the works' units")
        if stp["edition"]:
            check(near(stp["pct"], (hero["now"] + stp["futureEntriesPredicted"]) / stp["edition"], 2e-3), f"{label}: the sell-through's share is units plus still to come over the target")
    if not in_window:
        check(s.get("sellthrough") is None and s.get("framing") is None, f"{label}: no sales cards before the window")
    check(s["unitsPerBuyer"]["plan"] > 0 and s["unitsPerBuyer"]["actual"] > 0, f"{label}: pieces per buyer on both sides")
    # the email stages: the funnel's before the window (the sends against the TL
    # email cohort), aside inside it (the pre-window sends are not the window's traffic)
    em, bmk = s.get("email"), s.get("benchmarks") or {}
    if in_window:
        check(isinstance(em, dict) and em.get("funnelStages") is False and em.get("deliveredTarget") is None, f"{label}: the email stages step aside inside the window")
    elif em is not None:
        check(em.get("funnelStages") is True, f"{label}: the email stages are the funnel's before the window")
        refs = [bmk.get(k) for k in ("emailOpenRateRef", "emailClickToOpenRef", "emailSessionsPerClickRef")]
        f_em = fbg.get("aa_email") or {}
        if all(r is not None for r in refs) and f_em.get("sessions_expected") and em.get("deliveredTarget"):
            chain = refs[0] / 100 * refs[1] / 100 * refs[2]
            check(near(em["deliveredTarget"] * chain, f_em["sessions_expected"], max(0.02 * f_em["sessions_expected"], 1.0)),
                  f"{label}: the delivered target multiplies out to the plan's AA Email sessions ({em['deliveredTarget']} x {chain:.4f} vs {f_em['sessions_expected']})")
            if f_em.get("sessions_benchmark") and em.get("deliveredBenchmark"):
                check(near(em["deliveredBenchmark"] * chain, f_em["sessions_benchmark"], max(0.02 * f_em["sessions_benchmark"], 1.0)),
                      f"{label}: the delivered benchmark multiplies out to the basket's AA Email sessions")
    # the paid ROI: a paid signup's (or sale's) worth over what it cost AA, where the works give AA a profit per unit
    pd_ = s["paid"]
    check(isinstance(pd_.get("roiReadable"), bool) and pd_.get("roiTarget") and "aaBudgetShare" in pd_, f"{label}: the paid block carries the ROI reading")
    if pd_["roiReadable"]:
        share = pd_["aaBudgetShare"]
        if pd_.get("cumCost"):
            check(near(pd_["cumRoi"], pd_["value"] / (pd_["cumCost"] * share), 2e-3), f"{label}: ROI total = worth over cost x AA's share")
        for r in pd_["daily"]:
            if r.get("cost3"):
                check(near(r["roi"], pd_["value"] / (r["cost3"] * share), 2e-3), f"{label}: the day's ROI reads off its cost")
        check(near(pd_["costAtTargetRoi"], pd_["value"] / (share * pd_["roiTarget"]), 1e-3), f"{label}: the cost at the target ROI is the worth over the share and the target")
        # the LE's zeros: a day with spend and nothing bought reads 0, a day with no spend reads nothing
        for r in pd_["daily"]:
            if r.get("partial"):
                continue
            if r["spend"] <= 0:
                check(r["roi1"] is None, f"{label}: no spend on {r['date']}, no day ROI")
            elif r["entries"] <= 0:
                check(r["roi1"] == 0.0, f"{label}: spend and nothing bought on {r['date']} reads 0")
        art = pd_["artist"]
        check(set(art) >= {"cumRoi", "l3dRoi", "l1dRoi", "roiPath", "roiDeclineModel", "profitPerUnit", "budgetShare"}, f"{label}: the artist's reading carries the LE keys")
        if art.get("value") and art["budgetShare"] > 0 and pd_.get("cumCost"):
            check(near(art["cumRoi"], art["value"] / (pd_["cumCost"] * art["budgetShare"]), 2e-3), f"{label}: the artist's ROI total is their worth over the cost and their share")
    else:
        check(pd_.get("cumRoi") is None and all(r.get("roi") is None for r in pd_["daily"]), f"{label}: no ROI without AA's profit per unit")
    # the sell-through forecast by work (docs/TL_SPEC.md §4b): before the window only, its works adding up on both horizons
    fc = s.get("sellForecast")
    if in_window:
        check(fc is None, f"{label}: no forecast once the window has opened")
    elif fc is not None:
        check(fc["source"] in ("signup pages", "units target") and fc["beta"] == tl.FORECAST_BETA and fc["band"] == list(tl.FORECAST_BAND), f"{label}: the forecast names its source and settings")
        for hz in ("today", "open"):
            H = fc[hz]
            check(near(sum(w["units"] for w in H["works"]), H["units"], 0.5 + 0.05 * len(H["works"])), f"{label}: the works' forecasts add up to the release's ({hz})")
            check(near(sum(w["share"] for w in H["works"]), 1.0, 1e-3), f"{label}: the works' shares add to one ({hz})")
            for w in H["works"]:
                check(near(w["su"] + w["non"], w["units"], 0.15), f"{label}: {w['name']}: signup-led plus non-signup is the forecast ({hz})")
                check(w["lo"] <= w["units"] <= w["hi"], f"{label}: {w['name']}: the band holds the forecast ({hz})")
                if w["edition"]:
                    check(near(w["pct"], w["units"] / w["edition"], 2e-3), f"{label}: {w['name']}: sell-through is units over the edition")
            check(near(H["lo"], H["units"] * tl.FORECAST_BAND[0], 0.6) and near(H["hi"], H["units"] * tl.FORECAST_BAND[1], 0.6), f"{label}: the release's band ({hz})")
        check(fc["open"]["signups"] >= fc["today"]["signups"] - 1e-6, f"{label}: the open's signups are today's or more")
        if fc["source"] == "signup pages":
            check(fc["keyed"] >= tl.FORECAST_MIN_KEYED and all(w["keyed"] >= 0 for w in fc["today"]["works"]), f"{label}: a signup-page split rests on enough keyed signups")
    so = s.get("social")
    check(so is None or {"posts", "stories", "postsSource", "postsThrough", "artistPosts", "artistPostsTarget"} <= set(so), f"{label}: the social block carries the LE keys")
    bm = s.get("benchmark")
    if bm:
        check(set(bm.get("kByGroup") or {}) == set(tl.GROUPS) and bm.get("channelsOff") is not None, f"{label}: the benchmark block carries the LE keys")


if not tl.PANEL.exists():
    print("note: no TL aggregation on disk - run the build first")
    sys.exit(0)

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
live = pages(NOW)
check(len(live) > 10, f"the live build writes TL pages ({len(live)})")
states = {}
for rid, s in live.items():
    states[s["tlState"]] = states.get(s["tlState"], 0) + 1
    check_page(s, f"{rid} ({s['tlState']})")
    # the Direct switch's view (docs/TL_SPEC.md §3b): the same identities on the page with the variant laid over it
    v = (s.get("variants") or {}).get("direct_spread")
    check(isinstance(v, dict), f"{rid}: built both ways, the spread view under variants.direct_spread")
    if v:
        check_page({**s, **v}, f"{rid} ({s['tlState']}, Direct spread)")
check("signups" in states or "window" in states, f"a launch in flight on the build's day ({states})")

# the TL email cohort: the panel's launches' pre-window sends, with rates from two or more
import pandas as pd  # noqa: E402
cohort = tl.email_cohort(pd.read_csv(tl.PANEL), B.load_emails(), NOW.date())
check(cohort is not None and cohort.get("open_rate") is not None and cohort["cohort"]["n"] >= 2, "the email cohort has rate references")
if cohort and cohort.get("open_rate") is not None:
    check(0.03 < cohort["open_rate"] < 0.6 and 0.03 < cohort["ctor_rate"] < 0.6 and 0.3 < cohort["spc_rate"] < 5, f"the cohort's medians are rates a send can have ({cohort['open_rate']:.3f}, {cohort['ctor_rate']:.3f}, {cohort['spc_rate']:.2f})")
pre = [s for s in live.values() if s["tlState"] == "signups" and (s.get("email") or {}).get("delivered")]
check(all((s["email"].get("deliveredTarget") or 0) > 0 and (s["email"].get("deliveredBenchmark") or 0) > 0 for s in pre) and pre,
      "a live pre-window page with sends reads its email chain against the cohort")

# the product page -> work matcher (the pull's page titles are "Title by Artist")
works = [{"name": "Untitled (Dream House 1)", "airtable_id": "1"}, {"name": "Untitled (Dream House 5)", "airtable_id": "5"}, {"name": "Be Mine", "airtable_id": "9"}]
check(tl.work_for_page("Untitled [Dream House 5] by Gregory Crewdson", "/products/gregory-crewdson-untitled-dream-house-5", works)["airtable_id"] == "5", "a page title keys its work")
check(tl.work_for_page("", "/products/bisa-butler-be-mine", works)["airtable_id"] == "9", "the slug keys the work when the title is missing")
check(tl.work_for_page("Something Else by Somebody", "/products/somebody-something-else", works) is None, "a page no work fits keys nothing")
# the panel's forecast measures and the basket's medians are rates a launch can have
pnl = pd.read_csv(tl.PANEL)
check({"signup_order_rate_prod", "signup_order_rate_rel", "units_su", "units_nonsu", "ppo_su", "nonsu_units_paid", "signup_order_rate_prod_aa_email"} <= set(pnl.columns), "the panel carries the forecast's measures")
rp, rr = pnl["signup_order_rate_prod"].dropna(), pnl["signup_order_rate_rel"].dropna()
check(len(rp) >= 20 and 0.05 < rp.median() < 0.5 and len(rr) >= 20 and 0.02 < rr.median() < 0.4 and rp.median() > rr.median(), f"product signups convert more often than release ones ({rp.median():.3f} vs {rr.median():.3f})")
check((pnl["units_nonsu"] >= 0).all() and (pnl["units_su"] + pnl["units_nonsu"] <= pnl["units"] * 1.5 + 5).all(), "the window's two halves are within its units")
bisa_live = next((s for rid, s in live.items() if "bisa_butler" in rid), None)
if bisa_live and bisa_live["tlState"] == "signups":
    fc = bisa_live.get("sellForecast")
    check(fc is not None and fc["source"] == "signup pages" and len(fc["today"]["works"]) == 2, "Bisa Butler's two works are forecast from their signup pages")

# a launch whose works carry AA's profit, a frame profit and a deal reads an ROI (the figures typed on the tab)
bisa = next((s for rid, s in live.items() if "bisa_butler" in rid), None)
if bisa and bisa["tlState"] == "signups" and bisa["products"]:
    typed = [{"airtable_id": p["airtable_id"], "aa_profit_per_unit": 180, "artist_profit_per_unit": 120, "frame_profit_per_unit": 90, "aa_profit_share": 0.6}
             for p in bisa["products"] if p.get("airtable_id")]
    extra = {"id": bisa["id"], "release_name": bisa["releaseName"], "type": "TL", "products": typed}
    res = tl.build_all({"as_of": NOW.date(), "now": NOW, "seen": 1.0, "launch_frame": B.load_launches(), "inputs": [*B.INPUTS["releases"], extra],
                        "spend": B.load_spend(), "emails": B.load_emails(), "write": False, "only": bisa["id"]})
    b2 = res["snaps"].get(bisa["id"])
    check(b2 is not None and b2["paid"]["roiReadable"] and b2["paid"]["cumRoi"] > 0 and b2["paid"]["l3dRoi"] > 0, "AA profit on the works gives the paid card an ROI")
    if b2 and b2["paid"]["roiReadable"]:
        check_page(b2, f"{bisa['id']} (signups, with AA profit)")
        pv = b2["paidValue"]
        check(near(pv["aa_profit_per_unit"], 180, 1e-6) and near(pv["aa_budget_share"], 0.6, 1e-6) and not pv["aa_budget_share_assumed"], "the works' profit and deal reach the model")
        check(pv["frame_rate_source"] == "basket" and near(pv["frame_uplift_per_unit"], pv["frame_share"] * pv["frame_rate"] * 90, 1e-6), "the likely framing profit reads the basket's frames per print")
        check(pv["signup_order_rate_source"] == "basket_paid" and near(pv["signup_order_rate"], b2["benchmark"]["profile"]["signup_order_rate_by_group"]["paid"], 1e-9), "a paid signup converts at the basket's paid rate")
        check(near(b2["paid"]["value"], pv["value_per_signup"], 1e-9) and near(b2["paid"]["costAtTargetRoi"], pv["cost_per_signup_at_target_roi"], 1e-9), "the paid block reads the model's figures")
        path = b2["paid"]["roiPath"]
        check(len(path) > 0 and all(p["roi"] > 0 for p in path) and path[-1]["roi"] <= path[0]["roi"] + 1e-9 and path[-1]["date"] == b2["salesOpen"][:10],
              f"the forward path runs to the open at today's spend, the ROI easing as the spend adds up ({len(path)} days)")
        check(b2["paid"]["roiDeclineModel"]["start"] == b2["paid"]["l3dRoi"] and b2["paid"]["costTerms"]["wearout"] > 0, "the path starts on the line's last point, on the cost path's terms")
        art = b2["paid"]["artist"]
        check(art["budgetShare"] == 0.4 and (art["l3dRoi"] or 0) > 0 and len(art["roiPath"]) == len(path), "the artist's reading rides the same days and path")
        check(near(art["l3dRoi"], art["value"] / (b2["paid"]["l3dCost"] * 0.4), 2e-3) and near(art["value"], pv["artist_value_per_signup"], 1e-9),
              "the artist's ROI is their worth over the cost and their 40%")

# Gregory Crewdson's 2026 window, replayed at 20:00 UTC on 30 June: the hour clock and the sales cards
REPLAY = datetime(2026, 6, 30, 20, 0, tzinfo=timezone.utc)
replay = pages(REPLAY)
cw = next((s for rid, s in replay.items() if "crewdson_multiple_2026" in rid), None)
check(cw is not None and cw["tlState"] == "window", "the replay finds Crewdson's 2026 launch in its window")
if cw:
    check_page(cw, "crewdson replay (window)")
    check(cw["clock"]["unit"] == "hour" and cw["clock"]["of"] == 72 and 27 <= cw["day"] <= 28, f"the window runs 72 hours from the early access, hour {cw['day']} at the replay")
    check(cw["hero"]["now"] > cw["hero"]["expectedToday"] > 0 and cw["hero"]["projected"] > cw["hero"]["now"], "ahead of the pace, projected on")
    check(cw.get("sellthrough") and len(cw["sellthrough"]["products"]) >= 6 and cw.get("framing") and cw["framing"]["prints"] > 0, "the sell-through rows and the framing from the orders table")
    check(cw["unitsSource"] == "orders" and cw["paid"]["unit"] == "sale", "the window reads the orders table and prices a sale")

if failed:
    print(f"{failed} check(s) failed")
    sys.exit(1)
print(f"tl page: ok ({len(live)} live pages {states}, the Crewdson replay in its window)")
