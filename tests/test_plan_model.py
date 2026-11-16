#!/usr/bin/env python3
"""The plan model's parts, each held to a hand-built case.

etl/plan_model.py prices a launch's comms plan against a usual one
(docs/PLAN_MODEL.md). These cases hold it to: a send's kind and code read off
its name; what became of a plan row on a given day; how often a family's
planned rows go out; a send's expected clicks rising with its audience and
falling in rate, and a launch's own record lifting its next send; a launch's
days carrying each email under its kind and each post under its family, a
planned post at its reliability and a dropped one not at all; a day's value
with the fade and the deadline worked by hand; and the forecast: a usual plan
reads exactly as the clock, a lighter one below it, never past its limits.
The committed price list is checked for its shape. Run:
  python3 tests/test_plan_model.py
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import plan_model as P  # noqa: E402

T = pd.Timestamp
ANN, CLOSE = T("2026-09-01"), T("2026-09-25")     # 24 days from announce to close
# a click model small enough to work by hand: 5% at 3,000 people (exp(-3)), the rate falling with size
COEF = np.zeros(len(P.CLICK_NAMES)); COEF[0] = -3.0; COEF[1] = -0.3
PRICES = {"weights": {"em_announce": 2.0, "em_last_chance": 1.0, "pl_aa_post": 3.0, "pl_artist_post": 6.0},
          "fade_email": [0.5, 0.25], "fade_posts": [0.5], "close_day": 4.0, "day_before": 2.0, "pre": 0.1,
          "usual": {"stage": [0.25, 0.5, 0.75], "ratio": [0.6, 0.3, 0.15]}, "gamma": 0.5}


def close_to(a, b, tol=1e-9):
    assert abs(a - b) <= tol, f"{a} != {b}"


def test_names():
    assert P.email_type("210926_GEN_MaurizioCatt_HorseLE_26 - Announcement (LE)") == "GEN"
    assert P.email_type("170926_TRNS_Parra_LE_26 - Signed (framed)") == "TRNS"
    assert P.email_type("Test Webinar 2") == "OTHER"
    assert P.email_kind("210926_GEN_MaurizioCatt_HorseLE_26 - Announcement (LE)") == "announce"
    assert P.email_kind("180926_CUS_MaurizioCatt_HorseLE_26 - Early Access (LE) (Artist & Editions)") == "early_access"
    assert P.email_kind("201025_INS_AiWeiwei_LE_25- Early Access for Insiders") == "insiders"
    assert P.email_kind("230926_CUS_AiWeiwei_Button_26 - Last Chance (LE) (Expanded Audience)") == "last_chance"
    assert P.email_kind("220926_CUS_RobertLongo_LE_26 - Sustain (Eric Purchasers)") == "sustain"
    assert P.email_kind("011026_CUS_X_LE_26 - First-time purchaser survey") == "after"       # sells nothing: left out
    assert P.email_kind("011026_CUS_X_LE_26 - Treasure hunt") == "other"
    assert P.code_of("MaurizioCatt_HorseLE_26", "anything") == "MaurizioCatt_HorseLE_26"
    assert P.code_of("", "230926_CUS_AiWeiwei_Button_26 - Last Chance (LE)") == "AiWeiwei_Button_26"
    assert P.code_of("FREQ bundle", "a newsletter") is None


def test_plan_state():
    today = T("2026-09-10")
    assert P.plan_state("Live", "2026-09-05", today) == "done"
    assert P.plan_state("Scheduled", "2026-09-05", today) == "done"            # scheduled and its day gone by: it went
    assert P.plan_state("Scheduled", "2026-09-12", today) == "planned"
    assert P.plan_state("Needs: Assets", "2026-09-12", today) == "planned"     # still being made is still planned
    assert P.plan_state("Needs: Assets", "2026-09-05", today) == "dropped"     # its day passed and it never got there
    assert P.plan_state("Not posted", "2026-09-05", today) == "dropped"
    assert P.plan_state("Cancelled", "2026-09-20", today) == "dropped"
    assert P.plan_state("Not specced", "2026-09-05", today) == "blank"         # a template row nobody filled in
    assert P.plan_state("Not specced", "2026-09-20", today) == "planned"


def test_reliability():
    rows = ([{"family": "artist_post", "status": "Live", "date": T("2026-01-10")}] * 30
            + [{"family": "artist_post", "status": "Not posted", "date": T("2026-01-10")}] * 10
            + [{"family": "aa_post", "status": "Scheduled", "date": T("2026-01-10")}] * 40
            + [{"family": "artist_post", "status": "Scheduled", "date": T("2026-12-10")}] * 50     # still to come: says nothing yet
            + [{"family": "partner", "status": "Live", "date": T("2026-01-10")}] * 3)              # too few to read
    rel = P.plan_reliability(pd.DataFrame(rows), T("2026-06-01"))
    close_to(rel["artist_post"], 0.75)
    close_to(rel["aa_post"], 1.0)
    close_to(rel["partner"], P.DEFAULT_RELIABILITY["partner"])


def test_clicks():
    base = P.expected_clicks("early_access", np.exp(8.0), 0, 24, COEF)          # the reference size: exp(8) people at exp(-3)
    close_to(base, np.exp(8.0) * np.exp(-3.0), 1e-6)
    wide = P.expected_clicks("early_access", np.exp(10.0), 0, 24, COEF)
    assert wide > base                                                          # more people, more clicks
    assert wide / np.exp(10.0) < base / np.exp(8.0)                             # at a lower rate each
    close_to(wide, np.exp(10.0) * np.exp(-3.0 - 0.3 * 2.0), 1e-6)
    # a launch whose two earlier sends ran 50% over lifts its next one, shrunk by one send's weight
    pull = P.launch_pull([np.log(1.5), np.log(1.5)])
    close_to(pull, 2 * np.log(1.5) / 3)
    close_to(P.expected_clicks("early_access", np.exp(8.0), 0, 24, COEF, pull), base * np.exp(pull), 1e-6)
    assert P.launch_pull([]) == 0.0 and P.launch_pull([None, float("nan")]) == 0.0
    lo, hi = P.click_range(200.0, [np.log(0.5), np.log(1.5)])
    close_to(lo, 100.0, 1e-6); close_to(hi, 300.0, 1e-6)
    # the phases: before the announce, the announce and the day after, the last two days, between
    names = P.CLICK_NAMES
    f = lambda t: dict(zip(names, P.click_features("announce", 3000, t, 24)))
    assert f(-3)["phase_announce"] == f(-3)["phase_middle"] == f(-3)["phase_close"] == 0.0
    assert f(1)["phase_announce"] == 1.0 and f(10)["phase_middle"] == 1.0 and f(23)["phase_close"] == 1.0
    assert f(0)["announce"] == 1.0 and f(0)["announce_x_size"] == f(0)["size"]


def sends_frame(rows):
    return pd.DataFrame([{"day": T(d), "kind": k, "delivered": n} for d, k, n in rows])


def plan_frame(rows):
    return pd.DataFrame([{"date": T(d), "family": f, "status": s} for d, f, s in rows])


def test_launch_days():
    sends = sends_frame([("2026-08-28", "early_access", np.exp(8.0)), ("2026-08-28", "insiders", np.exp(8.0)),
                         ("2026-09-01", "announce", np.exp(8.0)), ("2026-09-24", "last_chance", np.exp(8.0)),
                         ("2026-10-02", "announce", 5000), ("2026-09-03", "after", 5000)])
    plan = plan_frame([("2026-09-01", "aa_post", "Live"), ("2026-09-01", "aa_post", "Scheduled"), ("2026-09-02", "artist_post", "Not posted"),
                       ("2026-09-20", "artist_post", "Scheduled"), ("2026-09-20", "sms", "Live"), ("2026-09-21", "aa_story", "Cancelled")])
    days = P.launch_days(ANN, CLOSE, sends, plan, COEF)
    assert len(days) == P.LEAD_DAYS + 24 + 1 and days["t"].iloc[0] == -P.LEAD_DAYS and days["t"].iloc[-1] == 24
    at = lambda d: days[days["date"] == T(d)].iloc[0]
    per = np.exp(8.0) * np.exp(-3.0) / P.CLICKS_REF
    close_to(at("2026-08-28")["em_early_access"], 2 * per, 1e-6)        # the Insiders' early access is early access
    close_to(at("2026-09-01")["em_announce"], per, 1e-6)
    close_to(at("2026-09-24")["em_last_chance"], per, 1e-6)
    close_to(days[P.EMAIL_COLS].to_numpy().sum(), 4 * per, 1e-6)        # the send after the close and the survey are not in it
    assert at("2026-09-01")["pl_aa_post"] == 2.0                        # Live and Scheduled both went
    assert at("2026-09-02")["pl_artist_post"] == 0.0                    # not posted
    assert at("2026-09-20")["pl_artist_post"] == 1.0                    # read as finished: it went
    assert "pl_sms" not in days.columns                                 # held by the plan, not priced
    # the same plan read on 10 September: the artist's post is still to come, at its reliability
    live = P.launch_days(ANN, CLOSE, sends, plan, COEF, as_of=T("2026-09-10"), reliability={"artist_post": 0.7})
    close_to(live[live["date"] == T("2026-09-20")].iloc[0]["pl_artist_post"], 0.7)
    assert live[live["date"] == T("2026-09-01")].iloc[0]["pl_aa_post"] == 2.0
    assert live[P.POST_COLS].to_numpy().sum() == 2.7


def test_day_values():
    plan = plan_frame([("2026-09-01", "aa_post", "Live"), ("2026-09-24", "artist_post", "Live")])
    days = P.launch_days(ANN, CLOSE, None, plan, COEF)
    v = dict(zip(days["t"], P.day_values(days, PRICES)))
    close_to(v[-1], 0.1)                      # a day before the announce
    close_to(v[0], 1.0 + 3.0)                 # the announce: the baseline and the post
    close_to(v[1], 1.0 + 3.0 * 0.5)           # the post fading: felt the next day
    close_to(v[2], 1.0)                       # and no longer the day after that
    close_to(v[23], 1.0 + 6.0 + 2.0)          # the day before the close: the artist's post and the deadline
    close_to(v[24], 1.0 + 6.0 * 0.5 + 4.0)    # the close: the post fading and the deadline
    close_to(P.action_value("pl_aa_post", 1.0, PRICES), 3.0 * 1.5)
    close_to(P.action_value("em_announce", 2.5, PRICES), 2.0 * 2.5 * 1.75)
    assert P.action_value("pl_artist_story", 1.0, PRICES) == 0.0      # a family the list gives no weight
    # an email is felt for longer than a post: its own fade, over its own days
    sends = sends_frame([("2026-09-01", "announce", np.exp(8.0))])
    e = P.launch_days(ANN, CLOSE, sends, None, COEF)
    amount = float(e.loc[e["t"] == 0, "em_announce"].iloc[0])
    ev = dict(zip(e["t"], P.day_values(e, PRICES)))
    close_to(ev[0], 1.0 + 2.0 * amount); close_to(ev[1], 1.0 + 2.0 * amount * 0.5); close_to(ev[2], 1.0 + 2.0 * amount * 0.25); close_to(ev[3], 1.0)
    close_to(P.piece_values(e, PRICES, ["em_announce"])[P.LEAD_DAYS], 2.0 * amount)
    close_to(P.base_values(e, PRICES)[P.LEAD_DAYS], 1.0)
    # a price list written with one fade for every piece still reads
    old = {**{k: v for k, v in PRICES.items() if not k.startswith("fade_")}, "fade": [0.5, 0.25]}
    assert P.fade_of("em_announce", old) == [0.5, 0.25] and P.fade_of("pl_aa_post", old) == [0.5, 0.25]
    close_to(P.action_value("pl_aa_post", 1.0, old), 3.0 * 1.75)


def test_forecast():
    v, t = np.array([1.0, 4.0, 2.0, 1.0, 1.0, 3.0]), np.array([-1, 0, 1, 2, 3, 4])
    close_to(P.remaining_ratio(v, t, 1), 5.0 / 7.0)
    assert P.remaining_ratio(np.zeros(3), np.array([0, 1, 2]), 1) is None
    close_to(P.usual_ratio(PRICES, 0.5), 0.3)
    close_to(P.usual_ratio(PRICES, 0.625), 0.225)                      # read between the grid's points
    assert P.usual_ratio({"usual": {"stage": [0.5], "ratio": [0.3]}}, 0.5) is None
    # 180 in, the clock says 120 more. A usual plan left reads exactly as the clock does
    same = P.anchored(180.0, 120.0, 0.3, 0.3, 0.5)
    close_to(same["forecast"], 300.0); close_to(same["scale"], 1.0); close_to(same["against_usual"], 1.0)
    # a plan left worth a quarter less than usual, at half strength: 120 x 0.75^0.5
    light = P.anchored(180.0, 120.0, 0.225, 0.3, 0.5)
    close_to(light["forecast"], 180.0 + 120.0 * 0.75 ** 0.5); close_to(light["against_usual"], 0.75)
    assert light["forecast"] < 300.0 < P.anchored(180.0, 120.0, 0.45, 0.3, 0.5)["forecast"]
    close_to(P.anchored(180.0, 120.0, 0.225, 0.3, 0.0)["forecast"], 300.0)        # no strength: the clock as it is
    close_to(P.anchored(180.0, 120.0, 0.225, 0.3, 1.0)["forecast"], 180.0 + 120.0 * 0.75)
    close_to(P.anchored(180.0, 120.0, 30.0, 0.3, 1.0)["scale"], 2.5)              # a plan read as a hundred times the usual is mis-read
    close_to(P.anchored(180.0, 120.0, 0.0003, 0.3, 1.0)["scale"], 0.4)
    close_to(P.anchored(180.0, 120.0, None, 0.3, 0.5)["forecast"], 300.0)         # nothing to read: the clock's
    close_to(P.anchored(180.0, -20.0, 0.3, 0.3, 0.5)["forecast"], 180.0)          # the clock never takes units back


def test_match_codes():
    launches = pd.DataFrame([
        {"release_name": "Kukwon Woo · Multiple · 2026 Q4", "artist": "Kukwon Woo", "campaign_code": None, "launch_end": "2026-11-13"},
        {"release_name": "Ai Weiwei · Multiple · 2026 Q4", "artist": "Ai Weiwei", "campaign_code": None, "launch_end": "2026-11-30"},
        {"release_name": "Parra · Multiple · 2026 Q3", "artist": "Parra", "campaign_code": "Parra_LE_26", "launch_end": "2026-08-21"},
        {"release_name": "Nobody · Work · 2026 Q1", "artist": "Nobody", "campaign_code": None, "launch_end": None},
    ])
    campaigns = pd.DataFrame([
        {"campaign_code": "KukwonWoo_LE_26", "launch": T("2026-11-14")},      # a day out: the same launch
        {"campaign_code": "AiWeiwei_Lego_26", "launch": T("2026-11-30")}, {"campaign_code": "AiWeiwei_Button_26", "launch": T("2026-11-28")},
        {"campaign_code": "Parra_Repeat_26", "launch": T("2026-08-21")},
    ])
    out = P.match_campaign_codes(launches, campaigns).set_index("artist")
    assert out.at["Kukwon Woo", "campaign_code"] == "KukwonWoo_LE_26" and out.at["Kukwon Woo", "code_from"] == "notion"
    assert pd.isna(out.at["Ai Weiwei", "campaign_code"])                     # two campaigns answer: no answer
    assert out.at["Parra", "campaign_code"] == "Parra_LE_26" and out.at["Parra", "code_from"] == "feeds"
    assert pd.isna(out.at["Nobody", "campaign_code"])
    none = P.match_campaign_codes(launches, campaigns.iloc[0:0])
    assert pd.isna(none.set_index("artist").at["Kukwon Woo", "campaign_code"])


def test_committed_prices():
    prices = P.load_prices()
    assert prices, "etl/plan_prices.json is missing: python3 etl/analysis/plan_backtest.py writes it"
    assert set(P.VALUE_COLS) <= set(prices["weights"]) and all(w >= 0 for w in prices["weights"].values())
    fe, fp = prices["fade_email"], prices["fade_posts"]
    assert len(fe) == P.EMAIL_FADE_DAYS and len(fp) == P.POST_FADE_DAYS and all(0 <= x <= 1 for x in fe + fp) and fe[-1] <= fe[0]
    assert abs(sum(prices["split"].values()) - 1.0) < 0.01 and all(v >= 0 for v in prices["split"].values())    # a quiet day over the page's channels
    assert len(prices["quiet"]) >= 30 and all(r["quiet"] > 0 and r["artist"] for r in prices["quiet"])          # each launch's own level
    assert prices["usual_audience"].get("announce", 0) > prices["usual_audience"].get("last_chance", 0) > 0
    assert 0.0 <= prices["gamma"] <= 1.0
    assert len(prices["clicks"]["coef"]) == len(P.CLICK_NAMES) and prices["clicks"]["names"] == P.CLICK_NAMES
    lo, hi = prices["clicks"]["spread"]
    assert lo < 0 < hi
    u = prices["usual"]
    assert len(u["stage"]) == len(u["ratio"]) >= 10 and u["ratio"][0] > u["ratio"][-1] > 0       # less of a plan is left as it runs
    assert prices["launches"] >= 30
    # the list prices a real day: an announce email to the full list and a post, on a 24-day launch
    sends = sends_frame([("2026-09-01", "announce", 130000)])
    plan = plan_frame([("2026-09-01", "aa_post", "Live")])
    days = P.launch_days(ANN, CLOSE, sends, plan, prices["clicks"]["coef"])
    v = P.day_values(days, prices)
    assert v[P.LEAD_DAYS] > v[P.LEAD_DAYS + 5] >= 1.0 and np.isfinite(v).all()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} tests passed")
