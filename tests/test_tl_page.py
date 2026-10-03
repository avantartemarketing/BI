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
