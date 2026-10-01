#!/usr/bin/env python3
"""The timed-launch model (etl/tl.py, docs/TL_SPEC.md): the dates worked back
from Airtable, the feed and the sales; the states and their words; the
targets, with the JS mirror (shared/tlModel.mjs) agreeing to the figure over
the baskets the live panel gives when it is on disk; the campaign code guess;
the window-length filter on the baskets. Runs without BigQuery: the series
are made up where they are needed.
  python3 tests/test_tl_model.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402
import tl  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def close(a, b, tol=1e-6):
    if a is None or b is None:
        return a is None and b is None
    a, b = float(a), float(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


UTC = timezone.utc
NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
EMPTY = pd.DataFrame({"day": pd.Series(dtype=object), "signups": pd.Series(dtype=float), "group": pd.Series(dtype=str)})
EMPTY_H = pd.DataFrame({"ts": pd.Series(dtype="datetime64[ns, UTC]"), "units": pd.Series(dtype=float), "group": pd.Series(dtype=str)})

# ---- the channel groups are the build's
check(tl.GROUP_OF == build.GROUP_OF and tl.GROUPS == build.baskets.GROUPS if hasattr(build, "baskets") else tl.GROUP_OF == build.GROUP_OF,
      "the TL module's channel groups are the build's")

# ---- the opening hour: Airtable's launch time, else the feed's less the summer hour, else 14:00 Amsterdam
bisa = {"launch_date": "2026-10-13", "launch_time": None, "tl_length": "48 hours", "tl_end_date": "2026-10-15", "announce_dates": ["2026-09-15"]}
o, src, _ = tl.open_from(bisa, "2026-10-13T17:00:00Z")
check(o == datetime(2026, 10, 13, 16, 0, tzinfo=UTC) and src == "feed", f"Bisa Butler: the feed's 17:00Z less the summer hour is 16:00Z, 18:00 Amsterdam ({o}, {src})")
crewdson = {"launch_date": "2026-06-30", "launch_time": "2026-06-30T16:00:00.000Z", "tl_length": "48 hours"}
o, src, _ = tl.open_from(crewdson, "2026-06-30T17:00:00Z")
check(o == datetime(2026, 6, 30, 16, 0, tzinfo=UTC) and src == "airtable", f"Crewdson: Airtable's launch time wins over the feed ({o}, {src})")
o, src, _ = tl.open_from({"launch_date": "2026-02-10", "launch_time": "2026-02-10T17:00:00.000Z"}, "2026-02-10T17:00:00Z")
check(o == datetime(2026, 2, 10, 17, 0, tzinfo=UTC), "in winter the two readings agree")
o, src, _ = tl.open_from({"launch_date": "2026-01-28"}, "2026-01-28T00:00:00Z")
check(o == datetime(2026, 1, 28, 13, 0, tzinfo=UTC) and src == "default", f"a midnight feed timestamp is a date: 14:00 Amsterdam (CET) is 13:00Z ({o})")
o, src, _ = tl.open_from({"launch_date": "2026-07-01"}, None)
check(o == datetime(2026, 7, 1, 12, 0, tzinfo=UTC) and src == "default", f"14:00 Amsterdam in summer is 12:00Z ({o})")
o, src, note = tl.open_from({"launch_date": "2026-11-18"}, "2026-11-25T17:00:00Z")
check(o == datetime(2026, 11, 18, 17, 0, tzinfo=UTC) and src == "feed_hour" and "25" in note, f"Carrie Mae Weems: Airtable's 18 November at the feed's hour, not the feed's 25 November ({o}, {src})")
check(tl.hours_words(48) == "48 hours" and tl.hours_words(168) == "7 days" and tl.hours_words(24) == "24 hours", "the window's length in the spec's words")
o, src, _ = tl.open_from(bisa, "2026-10-13T17:00:00Z", typed="2026-10-13T15:30:00Z")
check(o == datetime(2026, 10, 13, 15, 30, tzinfo=UTC) and src == "typed", "a typed open wins")
check(tl.amsterdam_offset_hours(date(2026, 10, 25)) == 1 and tl.amsterdam_offset_hours(date(2026, 10, 24)) == 2, "summer time ends on the last Sunday of October")
check(tl.amsterdam_offset_hours(date(2026, 3, 29)) == 2 and tl.amsterdam_offset_hours(date(2026, 3, 28)) == 1, "and begins on the last Sunday of March")

# ---- the window length
check(tl.parse_length_hours("48 hours") == 48 and tl.parse_length_hours("7 days") == 168 and tl.parse_length_hours("24 hours") == 24, "Airtable's lengths in words")
check(tl.parse_length_hours("1,337") is None and tl.parse_length_hours(None) is None, "nonsense is no length")
h, src, _ = tl.length_from({"tl_length": None, "tl_end_date": "2026-10-15"}, datetime(2026, 10, 13, 16, 0, tzinfo=UTC))
check(h == 48 and src == "airtable_end", f"the end date gives the length when the words are missing ({h}, {src})")
h, src, note = tl.length_from({}, datetime(2026, 11, 18, 17, 0, tzinfo=UTC))
check(h == 48 and src == "default" and "assumed" in note, "48 hours assumed when Airtable has nothing")

# ---- the announce: the latest Airtable date before the open (a stale earlier one sits beside it)
carrie = {"launch_date": "2026-11-18", "announce_dates": ["2026-08-03", "2026-10-26"], "announce_date": "2026-08-03"}
check(tl.airtable_announce(carrie, datetime(2026, 11, 18, 17, 0, tzinfo=UTC)) == date(2026, 10, 26), "Carrie Mae Weems: 26 October, not the stale 3 August")

# ---- dates and states end to end
d = tl.tl_dates(bisa, {"feed_launch": "2026-10-13T17:00:00Z", "feed_announce": "2026-09-15"}, None, EMPTY, EMPTY_H, NOW)
check(d["announce"] == date(2026, 9, 15) and d["announce_source"] == "airtable", f"the announce from Airtable ({d['announce']}, {d['announce_source']})")
check(d["open"] == datetime(2026, 10, 13, 16, 0, tzinfo=UTC) and d["close"] == datetime(2026, 10, 15, 16, 0, tzinfo=UTC), "open and close")
check(d["early_access"] == datetime(2026, 10, 12, 16, 0, tzinfo=UTC) and d["early_access_assumed"], "an early access is expected a day before a launch still to open")
check(d["settle"] == datetime(2026, 10, 22, 16, 0, tzinfo=UTC), "settled seven days after the close")
check(tl.state_of(d, NOW) == "signups" and tl.tl_label("signups", d, NOW) == "signups · opens in 11 d", f"state and words ({tl.tl_label('signups', d, NOW)})")
check(tl.state_of(d, datetime(2026, 9, 10, tzinfo=UTC)) == "upcoming", "before the announce: upcoming")
check(tl.state_of(d, datetime(2026, 10, 12, 18, 0, tzinfo=UTC)) == "window", "in the early access: the window is open")
check(tl.tl_label("window", d, datetime(2026, 10, 12, 18, 0, tzinfo=UTC)) == "early access · 70 h left", f"the early access says so ({tl.tl_label('window', d, datetime(2026, 10, 12, 18, 0, tzinfo=UTC))})")
check(tl.tl_label("window", d, datetime(2026, 10, 14, 12, 30, tzinfo=UTC)) == "window open · 28 h left", "the hours left to the close")
check(tl.state_of(d, datetime(2026, 10, 16, tzinfo=UTC)) == "settling" and tl.state_of(d, datetime(2026, 10, 23, tzinfo=UTC)) == "closed", "settling, then closed")
# no announce anywhere: the first day with ten signups within 45 days of the open
daily = pd.DataFrame({"day": [date(2026, 8, 6), date(2026, 9, 9), date(2026, 9, 10)], "signups": [25.0, 40.0, 49.0], "group": ["paid"] * 3})
d2 = tl.tl_dates({"launch_date": "2026-10-13"}, {"feed_launch": "2026-10-13T17:00:00Z"}, None, daily, EMPTY_H, NOW)
check(d2["announce"] == date(2026, 9, 9) and d2["announce_source"] == "signups", f"the pre-window starts when the first few signups land, inside 45 days ({d2['announce']})")
# the early access read off the sales
hourly = pd.DataFrame({"ts": pd.to_datetime(["2026-06-29T15:00:00Z", "2026-06-29T16:00:00Z", "2026-06-30T16:00:00Z"], utc=True), "units": [1.0, 251.0, 402.0], "group": ["paid"] * 3})
d3 = tl.tl_dates(crewdson, {"feed_launch": "2026-06-30T17:00:00Z"}, None, EMPTY, hourly, NOW)
check(d3["early_access"] == datetime(2026, 6, 29, 16, 0, tzinfo=UTC) and not d3["early_access_assumed"], f"Crewdson's early access began at 16:00Z the day before ({d3['early_access']})")
check(d3["sales_open"] == d3["early_access"], "the sales window opens with the early access")

# ---- the campaign code
activity = {"BisaButler_TL_26": (date(2026, 9, 16), date(2026, 9, 24)), "AiWeiwei_SelfPortrait_26": (date(2026, 1, 6), date(2026, 5, 6)),
            "AiWeiwei_Guardian2_26": (date(2026, 5, 11), date(2026, 9, 16)), "HarmoniaR_Two_25": (date(2025, 10, 3), date(2026, 2, 12)),
            "TOMASTLE24": (date(2024, 1, 10), date(2024, 1, 22)), "PietParra_Dip_25": (date(2025, 7, 8), date(2025, 9, 10)), "ZengFanzhi_TL_26": (date(2026, 7, 1), date(2026, 7, 22))}
check(tl.guess_tl_code("Bisa Butler", datetime(2026, 10, 13, 16, tzinfo=UTC), activity) == "BisaButler_TL_26", "Bisa Butler's code")
check(tl.guess_tl_code("Ai Weiwei", datetime(2026, 6, 2, 13, tzinfo=UTC), activity, titles="Guardian (Blue) / Guardian (Green)", announce=date(2026, 5, 12)) == "AiWeiwei_Guardian2_26",
      "the Guardians take the code naming them, not the artist's earlier one")
check(tl.guess_tl_code("Harmonia", datetime(2025, 10, 29, 17, tzinfo=UTC), activity) == "HarmoniaR_Two_25", "a code longer than the artist's name still matches")
check(tl.guess_tl_code("Tomás Sánchez", datetime(2024, 1, 17, 16, tzinfo=UTC), activity) == "TOMASTLE24", "accents and the TL suffix fold away")
check(tl.guess_tl_code("Parra", datetime(2025, 7, 29, 14, tzinfo=UTC), activity, airtable_code="PietParraDip25") == "PietParra_Dip_25", "Airtable's release code opens the match")
check(tl.guess_tl_code("Zeng Fanzhi", datetime(2026, 10, 13, 16, tzinfo=UTC), activity) is None, "a code that did not move in the window is not the launch's")
check(tl.code_of("CindySher_TL_25· Sign-ups") == "CindySher_TL_25" and tl.code_of("AiWeiwei_Snake_25 - Sign-ups") == "AiWeiwei_Snake_25" and tl.code_of("MarinaAbr-1502 · Purchases") == "MarinaAbr-1502",
      "the code is read off a campaign name whatever the separator")

# ---- the targets, Python against JS, over made-up and live baskets
PROFILE = {
    "n": 8, "signups": 1282.0, "sessions": 25782.0, "units": 339.0, "orders": 272.0,
    "signup_order_rate": 0.103, "purchases_per_order": 1.182, "cost_per_signup": 9.809, "cost_per_sale": 25.585,
    "share_signups": {"aa_email": 0.176, "aa_social": 0.053, "referral_artist": 0.029, "search_direct_other": 0.085, "paid": 0.657},
    "share_sessions": {"aa_email": 0.2, "aa_social": 0.05, "referral_artist": 0.05, "search_direct_other": 0.3, "paid": 0.4},
    "share_units": {"aa_email": 0.3, "aa_social": 0.08, "referral_artist": 0.1, "search_direct_other": 0.295, "paid": 0.225},
    "conv": {"aa_email": 0.05, "aa_social": 0.03, "referral_artist": 0.02, "search_direct_other": 0.01, "paid": 0.08},
    "signup_order_rate_by_group": {"aa_email": 0.215, "aa_social": 0.148, "referral_artist": 0.172, "search_direct_other": 0.216, "paid": 0.064},
}
for key in ("signups", "sessions", "units"):
    PROFILE[f"{key}_by_group"] = {g: PROFILE[f"share_{key}"][g] * PROFILE[key] for g in tl.GROUPS}
cases = [
    {"name": "Airtable's target, the basket's rates", "inputs": {}, "airtable_units": 400.0, "launch_value": 300000.0},
    {"name": "typed over", "inputs": {"units_target": 500, "purchases_per_order": 1.1, "signup_order_rate": 0.09, "cost_per_signup": 5, "cost_per_purchase": 30}, "airtable_units": 400.0, "launch_value": 375000.0},
    {"name": "paid off, stretch on email", "inputs": {"channels_off": ["paid"], "stretch_from": {"aa_email": 1}}, "airtable_units": 400.0, "launch_value": 300000.0},
    {"name": "no target", "inputs": {}, "airtable_units": None, "launch_value": None},
]
# the live panel's baskets, when the build has written one
panel_path = tl.PANEL
if panel_path.exists() and tl.CURVES.exists():
    panel = pd.read_csv(panel_path)
    curves = json.loads(tl.CURVES.read_text()).get("curves", {})
    rel = {"release_name": "Bisa Butler · Multiple · 2026 Q4", "artist": "Bisa Butler", "window_open": "2026-10-13T16:00:00Z", "window_hours": 48.0, "units_target": 400.0, "unit_price_eur": 750.0}
    for b in tl.ready_baskets(panel, curves, rel, date(2026, 10, 1)):
        if b["n"]:
            prof = {k: v for k, v in b["profile"].items() if k not in ("signup_curve", "signup_curve_count", "unit_curve", "curve_days", "curve_fracs")}
            cases.append({"name": f"live basket {b['id']}", "inputs": {"stretch_from": {"paid": 0.6, "aa_email": 0.4}}, "airtable_units": 400.0, "launch_value": 300000.0, "profile": prof})
            cases.append({"name": f"live basket {b['id']}, artist off", "inputs": {"channels_off": ["referral_artist"]}, "airtable_units": 400.0, "launch_value": 300000.0, "profile": prof})
    # a 48-hour launch is measured against 48-hour launches first
    ready = {b["id"]: b for b in tl.ready_baskets(panel, curves, rel, date(2026, 10, 1))}
    same = ready.get("same_length")
    if same and same["n"] >= tl.TL_THIN:
        hours = panel.set_index("release_name").loc[ready["similar_size"]["members"], "window_hours"]
        check((hours == 48).all() and not ready["similar_size"].get("fallback"), "the similar basket is cut from the 48-hour launches when there are enough")
    seven = tl.ready_baskets(panel, curves, {**rel, "window_hours": 168.0}, date(2026, 10, 1))
    sim7 = next(b for b in seven if b["id"] == "similar_size")
    pool7 = panel[(panel["window_hours"] == 168) & (pd.to_datetime(panel["close"], utc=True) < pd.Timestamp("2026-10-13T16:00:00Z"))]
    check(sim7.get("fallback") == (len(pool7) < tl.TL_THIN), "the fallback to every length is said when the length is thin")
    check(all(pd.to_datetime(panel.set_index("release_name").loc[m, "close"], utc=True) < pd.Timestamp("2026-10-13T16:00:00Z") for m in ready["all_tl"]["members"]),
          "only launches closed before this one's open are comparables")
else:
    print("note: no TL panel on disk - the live-basket cases are skipped (run the build first)")

py_out = []
for c in cases:
    prof = c.get("profile", PROFILE)
    read = tl.apply_channels_off(prof, tl.channels_off_of(c["inputs"]))
    py_out.append(tl.tl_targets(c["inputs"], c["airtable_units"], read, c["launch_value"]))
# the maths the spec writes down
t0 = py_out[0]
check(close(t0["orders_needed"], 400 / PROFILE["purchases_per_order"]), "orders needed = units / pieces per order")
mix = sum(PROFILE["share_signups"][g] * PROFILE["signup_order_rate_by_group"][g] for g in tl.GROUPS)
check(close(t0["signup_order_rate"], mix) and t0["signup_order_rate_source"] == "basket_mix", f"the rate is the basket's rates at its mix ({t0['signup_order_rate']:.4f} vs {mix:.4f})")
check(close(t0["signup_target"], t0["orders_needed"] / mix), "signup target = orders / rate")
check(close(sum(t0["signups_by_group"].values()), t0["signup_target"]), "the group targets partition the signup target")
check(close(t0["budget_pre"], t0["signups_by_group"]["paid"] * PROFILE["cost_per_signup"]), "pre-window budget = paid signups x cost per signup")
check(close(t0["budget_window"], PROFILE["share_units"]["paid"] * 400 * PROFILE["cost_per_sale"]), "window budget = paid share of units x units x cost per sale")
t1 = py_out[1]
check(close(t1["signup_target"], 500 / 1.1 / 0.09) and t1["signup_order_rate_source"] == "release", "typed figures win")
t2 = py_out[2]
check(t2["signups_by_group"]["paid"] == 0 and t2["budget_pre"] is None and close(sum(t2["signups_by_group"].values()), t2["signup_target"]), "paid off: no paid target, no budget, the rest carry the target")
check(close(t2["signups_by_group"]["aa_email"] - PROFILE["signups_by_group"]["aa_email"], t2["signup_target"] - sum(v for g, v in PROFILE["signups_by_group"].items() if g != "paid")),
      "the whole stretch lands on email when placed there")
check(py_out[3] is None, "no units target: no targets")

# JS parity
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
    json.dump({"bench": build.BENCH, "cases": [{**{k: v for k, v in c.items() if k != "profile"}, "profile": c.get("profile", PROFILE)} for c in cases]}, f)
    path = f.name
res = subprocess.run(["node", str(ROOT / "tests" / "tl_model_parity.mjs"), "--cases", path], capture_output=True, text=True, check=True)
js_out = json.loads(res.stdout)
KEYS = ["units_target", "purchases_per_order", "signup_order_rate", "orders_needed", "signup_target", "k", "paid_signups", "paid_units",
        "cost_per_signup", "cost_per_sale", "budget_pre", "budget_window", "budget_total", "budget_pct_of_launch_value", "sessions_needed"]
for c, py, js in zip(cases, py_out, js_out):
    if py is None or js is None:
        check(py is None and js is None, f"{c['name']}: both sides have no targets")
        continue
    for k in KEYS:
        check(close(py.get(k), js.get(k)), f"{c['name']}: {k} python {py.get(k)} js {js.get(k)}")
    for g in tl.GROUPS:
        check(close(py["signups_by_group"][g], js["signups_by_group"][g]), f"{c['name']}: {g} signup target python {py['signups_by_group'][g]} js {js['signups_by_group'][g]}")
        check(close(py["sessions_by_group"][g], js["sessions_by_group"][g]), f"{c['name']}: {g} sessions python {py['sessions_by_group'][g]} js {js['sessions_by_group'][g]}")
    check(py["signup_order_rate_source"] == js["signup_order_rate_source"] and py["sense_check_breached"] == js["sense_check_breached"], f"{c['name']}: the sources and the sense check agree")

# ---- the window from the orders table: paid plus awaiting, the rest apart, by hour and product
hourly = pd.DataFrame([
    # before the sales open: not the window's
    {"release": "R", "product_title": "Red", "hour": "2026-06-29T12:00:00Z", "channel": "Direct", "status": "paid", "units": 3, "orders": 3, "units_private": 0, "prints_offered": 3, "frames": 1, "value": 1500},
    # the early access and the window
    {"release": "R", "product_title": "Red", "hour": "2026-06-29T16:00:00Z", "channel": "AA Email Man", "status": "paid", "units": 10, "orders": 8, "units_private": 10, "prints_offered": 10, "frames": 4, "value": 5000},
    {"release": "R", "product_title": "Blue", "hour": "2026-06-30T16:00:00Z", "channel": "Paid Social", "status": "paid", "units": 20, "orders": 15, "units_private": 0, "prints_offered": 20, "frames": 5, "value": 10000},
    {"release": "R", "product_title": "Blue", "hour": "2026-06-30T17:00:00Z", "channel": "untracked", "status": "awaiting", "units": 2, "orders": 2, "units_private": 0, "prints_offered": 2, "frames": 1, "value": 1000},
    {"release": "R", "product_title": "Red", "hour": "2026-06-30T18:00:00Z", "channel": "Direct", "status": "cancelled", "units": 4, "orders": 4, "units_private": 0, "prints_offered": 4, "frames": 0, "value": 2000},
    {"release": "R", "product_title": "Red", "hour": "2026-06-30T19:00:00Z", "channel": "Direct", "status": "refunded", "units": 1, "orders": 1, "units_private": 0, "prints_offered": 1, "frames": 0, "value": 500},
    # after `until`: not yet
    {"release": "R", "product_title": "Red", "hour": "2026-07-01T10:00:00Z", "channel": "Direct", "status": "paid", "units": 7, "orders": 7, "units_private": 0, "prints_offered": 7, "frames": 2, "value": 3500},
])
hourly["ts"] = pd.to_datetime(hourly["hour"], utc=True)
hourly["group"] = hourly["channel"].map(tl.GROUP_OF).fillna("untracked")
o = tl.window_from_orders(hourly, datetime(2026, 6, 29, 16, tzinfo=UTC), datetime(2026, 6, 30, 20, tzinfo=UTC))
check(o["units"] == 32 and o["units_paid"] == 30 and o["awaiting_units"] == 2 and o["awaiting_value"] == 1000, f"units are paid plus awaiting from the sales open to now ({o['units']}, {o['units_paid']}, {o['awaiting_units']})")
check(o["cancelled"] == 5 and o["private"] == 10 and o["orders"] == 25, f"cancelled and refunded apart, the private room and the orders counted ({o['cancelled']}, {o['private']}, {o['orders']})")
check(o["prints_offered_paid"] == 30 and o["frames_paid"] == 9 and o["prints_offered_awaiting"] == 2 and o["frames_awaiting"] == 1, "frames per print on the paid and the awaiting lines")
check(o["by_group"]["aa_email"] == 10 and o["by_group"]["paid"] == 20 and o["by_group"]["untracked"] == 2, f"by channel group, the untracked apart ({o['by_group']})")
prods = tl._sales_products(o["live"], [{"name": "Red", "airtable_id": "1", "units_target": 100.0, "edition": 150.0, "excluded": False, "framing_available": True, "frame_conversion": 0.4},
                                         {"name": "Blue", "airtable_id": "2", "units_target": 300.0, "edition": 300.0, "excluded": False, "framing_available": True, "frame_conversion": 0.2},
                                         {"name": "Green", "airtable_id": "3", "units_target": 50.0, "edition": 50.0, "excluded": False, "framing_available": False, "frame_conversion": None}], 450.0)
by = {r["name"]: r for r in prods}
check(by["Blue"]["units"] == 22 and by["Blue"]["awaiting"] == 2 and by["Blue"]["target"] == 300 and by["Red"]["units"] == 10 and by["Green"]["units"] == 0, "one row per work, matched to Airtable's by name, a work with no line yet at zero")
check(close(tl._plan_frame_rate([{"name": "Red", "units_target": 100.0, "edition": 150.0, "excluded": False, "framing_available": True, "frame_conversion": 0.4},
                                 {"name": "Blue", "units_target": 300.0, "edition": 300.0, "excluded": False, "framing_available": True, "frame_conversion": 0.2},
                                 {"name": "Green", "units_target": 50.0, "excluded": False, "framing_available": False, "frame_conversion": None}]), (100 * 0.4 + 300 * 0.2) / 400),
      "the framing plan is Airtable's take-up weighted over the works that frame")

# ---- ids: a TL never shares a page id with an LE of the same name
check(tl.tl_id("Ai Weiwei · Multiple · 2026 Q4") == "ai_weiwei_multiple_2026_q4_tl", "the TL suffix on the id")

if failed:
    print(f"{failed} check(s) failed")
    sys.exit(1)
print(f"tl model: ok ({len(cases)} target cases, python and js agree)")
