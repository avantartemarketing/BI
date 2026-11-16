#!/usr/bin/env python3
"""The plan-based view of a launch, held to a hand-built case.

etl/plan_view.py reads a live draw launch off its comms plan instead of the
campaign clock (docs/PLAN_MODEL.md). These cases hold it to: the audience a
send's name gives it; the phase a plan row sits in; the level a new plan is
sized on (the artist's own launches, else the basket's, else every launch's);
which launches qualify; and one launch worked through: the plan's path per
channel, the card's rows adding up to the page's own counts and each row's
pieces to the row, an email the price list values above a post, what is still
to come scaled by how the launch is running, and above all the credit: units
a draw booked days after the entries are credited to the day people entered,
so they land on the announce and not on the baseline. Run:
  python3 tests/test_plan_view.py
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import plan_model as P  # noqa: E402
import plan_view as V  # noqa: E402

T = pd.Timestamp
ANN, CLOSE, TODAY = T("2026-09-01"), T("2026-09-25"), T("2026-09-08")
CODE, NAME = "TestArtist_LE_26", "Test Artist · A Work · 2026 Q3"
COEF = np.zeros(len(P.CLICK_NAMES)); COEF[0] = -3.0; COEF[1] = -0.3
PRICES = {"weights": {"em_announce": 2.0, "em_last_chance": 1.0, "em_sustain": 1.0, "pl_aa_post": 3.0, "pl_artist_post": 6.0, "pl_partner": 4.0},
          "fade_email": [0.5, 0.25], "fade_posts": [0.5], "close_day": 1.0, "day_before": 0.5, "pre": 0.1,
          "clicks": {"coef": list(COEF), "spread": [-0.4, 0.4]}, "reliability": {"artist_post": 0.5},
          "split": {"aa_email": 0.4, "aa_social": 0.2, "referral_artist": 0.1, "organic_search": 0.2, "direct_other": 0.1},
          "usual_audience": {"last_chance": 5000.0, "sustain": 10000.0},
          "quiet": [{"name": "Test Artist · One · 2025 Q1", "artist": "Test Artist", "close": "2025-02-01", "quiet": 1.0, "demand": 50.0},
                    {"name": "Test Artist · Two · 2025 Q3", "artist": "Test Artist", "close": "2025-08-01", "quiet": 3.0, "demand": 150.0},
                    {"name": "Test Artist · Three · 2026 Q1", "artist": "Test Artist", "close": "2026-02-01", "quiet": 2.0, "demand": 100.0},
                    {"name": "Other · X · 2026 Q1", "artist": "Other", "close": "2026-03-01", "quiet": 0.5, "demand": 30.0},
                    {"name": "Other · Y · 2026 Q2", "artist": "Other", "close": "2026-05-01", "quiet": 0.7, "demand": 30.0},
                    {"name": "Other · Z · 2026 Q2", "artist": "Other", "close": "2026-06-01", "quiet": 0.9, "demand": 30.0}]}
GROUP_OF = {"AA Email Man": "aa_email", "AA Meta": "aa_social", "Referral Artist": "referral_artist", "Organic Search": "organic_search", "Direct": "direct_other", "Paid Social": "paid"}


def close_to(a, b, tol=1e-6):
    assert abs(a - b) <= tol, f"{a} != {b}"


def comms():
    rows = [("2026-09-01", "aa_post", "2-Announce", "Live", "Announcement", "IG Main · Post"),
            ("2026-09-01", "artist_post", "2-Announce", "Live", "Announcement", "Artist IG · Post"),
            ("2026-09-15", "artist_post", "3-Sustain", "Content ready", "Sustain", "Artist IG · Post"),
            ("2026-09-24", "email", "4-Launch", "Not specced", "Last chance (LE)", "AA Email"),
            ("2026-09-10", "aa_post", "3-Sustain", "Cancelled", "Dropped post", "IG Main · Post")]
    return pd.DataFrame([{"campaign_code": CODE, "date": T(d), "family": f, "phase": ph, "status": s, "name": n, "channel": c, "created": "2026-08-01", "edited": "2026-08-01"}
                         for d, f, ph, s, n, c in rows])


def audiences():
    rows = [("010926_GEN_TestArtist_LE_26 - Announcement (LE)", "2026-09-01", 100000, 1000, 300),
            ("010926_CUS_TestArtist_LE_26 - Announcement (LE) (Past Purchasers)", "2026-09-01", 1000, 3000, 2)]
    df = pd.DataFrame([{"name": n, "day": T(d), "ts": T(d) + pd.Timedelta(hours=14), "delivered": float(dl), "clicked": float(cl), "unsubscribed": float(u),
                        "code": CODE, "type": P.email_type(n), "kind": P.email_kind(n), "went": True} for n, d, dl, cl, u in rows])
    return df


def funnel():
    """People enter on the announce day and the day after; a few come on a quiet day through search."""
    rows = [("2026-09-01", "AA Email Man", 50.0, 0.0), ("2026-09-02", "AA Email Man", 10.0, 0.0), ("2026-09-01", "AA Meta", 10.0, 0.0),
            ("2026-09-01", "Referral Artist", 0.0, 6.0), ("2026-09-06", "Organic Search", 5.0, 0.0), ("2026-09-03", "Paid Social", 5.0, 0.0)]
    return pd.DataFrame([{"simple_release_name": NAME, "channel": c, "event_date": T(d).date(), "Draw_Entries_Eligible_Units": e, "Product_Units_Private_Room": pr} for d, c, e, pr in rows])


def page(**over):
    """The launch's page as the build hands it over: every channel's count to date, with the email units booked
    in one batch on 5 September (the draw was run that day), four days after people entered."""
    days = [str(d.date()) for d in pd.date_range(ANN, CLOSE)]

    def daily(by_day: dict) -> list[dict]:
        out, cum = [], 0.0
        for d in days:
            cum += by_day.get(d, 0.0)
            out.append({"date": d, "actual": round(cum, 2) if T(d) <= TODAY else None, "plan": 0.0, "proj": None})
        return out
    ch = [("aa_email", {"2026-09-05": 48.0}), ("aa_social", {"2026-09-05": 8.0}), ("referral_artist", {"2026-09-01": 6.0}), ("organic_search", {"2026-09-06": 4.0}),
          ("direct_other", {}), ("paid", {"2026-09-03": 4.0})]
    p = {"id": "test_le_26", "type": "LE", "artist": "Test Artist", "releaseName": NAME, "campaignCode": CODE, "windowStart": str(ANN.date()), "windowEnd": str(CLOSE.date()),
         "asOf": str(TODAY.date()), "asOfFraction": 1.0, "day": 7, "of": 24, "hero": {"target": 200.0, "now": 70.0},
         "channels": [{"key": k, "name": k, "now": sum(v.values()), "exp": 0.0, "proj": sum(v.values()), "target": 30.0, "daily": daily(v)} for k, v in ch]}
    p.update(over)
    return p


def ctx():
    return {"prices": PRICES, "comms": comms(), "aud": audiences()}


def test_audience_words():
    assert V.audience_words("180926_CUS_X_LE_26 - Early Access (LE) (Artist & Editions)") == "Artist and Editions"
    assert V.audience_words("051126_CUS_X_LE_26 - Early Access (LE) for past purchasers") == "past purchasers"
    assert V.audience_words("091126_GEN_X_LE_26 - Announcement (LE)") == ""
    assert V.audience_words("230926_CUS_X_LE_26 - Last Chance (LE) (Expanded Audience)") == "Expanded Audience"
    assert V.email_label("091126_GEN_X_LE_26 - Announcement (LE)", "announce", 150416) == "Email to 150k people"
    assert V.email_label("051126_CUS_X_LE_26 - Early Access (LE) for past purchasers", "early_access", 973) == "Email to 973 (past purchasers)"
    assert V.email_label("201025_INS_X_LE_25- Early Access for Insiders", "insiders", 164) == "Email to 164 insiders"


def test_phase():
    assert V.phase_of({"phase": "1-Priority access", "date": T("2026-09-20")}, ANN, 24) == "Early access"      # Notion's own phase wins
    assert V.phase_of({"phase": "", "date": T("2026-08-28")}, ANN, 24) == "Early access"
    assert V.phase_of({"phase": "", "date": T("2026-09-02")}, ANN, 24) == "Announce"
    assert V.phase_of({"phase": "", "date": T("2026-09-12")}, ANN, 24) == "Sustain"
    assert V.phase_of({"phase": "", "date": T("2026-09-24")}, ANN, 24) == "Last chance"


def test_start_level():
    own = V.start_level(PRICES, "Test Artist", ANN)
    assert own["basis"] == "artist" and own["n"] == 3
    close_to(own["level"], 2.0); assert own["range"] == (1.0, 3.0)
    # an artist with no launches of their own: the basket's launches, when enough have a size on file
    near = V.start_level(PRICES, "New Artist", ANN, ["Other · X · 2026 Q1", "Other · Y · 2026 Q2", "Other · Z · 2026 Q2"])
    assert near["basis"] == "basket"; close_to(near["level"], 0.7)
    every = V.start_level(PRICES, "New Artist", ANN, ["Other · X · 2026 Q1"])
    assert every["basis"] == "all" and every["n"] == 6
    # only launches that closed before this one announced are read
    assert V.start_level(PRICES, "Test Artist", T("2025-09-01"))["n"] == 2


def test_qualifies():
    c, at = ctx(), funnel()
    assert V.override(page(), at, GROUP_OF, c) is not None
    assert V.override(page(), at, GROUP_OF, None) is None                              # no feeds: no plan view
    assert V.override(page(type="TL"), at, GROUP_OF, c) is None
    assert V.override(page(complete=True), at, GROUP_OF, c) is None
    assert V.override(page(campaignCode=None), at, GROUP_OF, c) is None
    assert V.override(page(campaignCode="Nobody_LE_26"), at, GROUP_OF, c) is None      # no plan on file under the code
    assert V.override(page(line="prints"), at, GROUP_OF, c) is None


def test_launch():
    c, at, pg = ctx(), funnel(), page()
    ov = V.override(pg, at, GROUP_OF, c)
    g, meta = ov["groups"], ov["meta"]
    assert set(g) == set(PRICES["split"]) and "paid" not in g                          # paid keeps its own model
    assert meta["levelBasis"] == "artist"
    for k, v in g.items():
        path = [v["plan"][d] for d in sorted(v["plan"])]
        assert all(b >= a - 1e-9 for a, b in zip(path, path[1:])), k                   # a plan's path never falls
        close_to(path[-1], v["plan_total"], 0.01)
        assert 0 <= v["exp"] <= v["plan_total"] + 1e-6 and v["fut"] >= 0
        share = [v["share"][d] for d in sorted(v["share"])]
        assert all(0 <= s <= 1 + 1e-9 for s in share) and (not share or abs(share[-1] - 1.0) < 1e-6)
    # the email channel's plan is the two announce sends and its share of the baseline; search has no pieces, the baseline alone
    assert g["aa_email"]["plan_total"] > g["organic_search"]["plan_total"] > 0
    V.finish(pg, ov)
    plan = pg["plan"]
    rows = {r["moment"]: r for r in plan["rows"]}
    assert list(rows) == ["Early access", "Announce", "Sustain", "Last chance", "Baseline", "Paid"] and pg["method"] == "plan"
    organic = [r for m, r in rows.items() if m != "Paid"]
    close_to(sum(r["in"] for r in organic), 66.0, 0.05)                                # what the page counts outside paid, to the unit
    close_to(sum(r["expected"] for r in organic), sum(v["plan_total"] for v in g.values()), 0.1)
    close_to(sum(r["toCome"] for r in organic), sum(v["fut"] for v in g.values()), 0.1)
    for r in plan["rows"]:
        if r["pieces"]:
            for k in ("expected", "in", "toCome"):
                close_to(sum(x[k] for x in r["pieces"]), r[k], 0.06)                   # a row's pieces add up to the row
    # the credit: the draw booked 48 email units on 5 September, a day with nothing going out, but people entered on
    # the announce and the day after. Read by the day they entered, they are the announce's and not the baseline's.
    assert rows["Announce"]["in"] > 55 and rows["Baseline"]["in"] < 10
    names = [x["name"] for x in rows["Announce"]["pieces"]]
    assert names[:2] == ["Email to 100k people", "Email to 1,000 (Past Purchasers)"] and "Artist post" in names and "Avant Arte post" in names
    wide, narrow = rows["Announce"]["pieces"][0], rows["Announce"]["pieces"][1]
    assert wide["expected"] > narrow["expected"]                                       # the plan expects more of the wider send
    close_to(narrow["in"] / wide["in"], 3.0, 0.01)                                     # ... and what came is split by the clicks each got
    # still to come: the sustain post at how often such a post goes out, and the last chance email at the usual audience
    sus = {x["name"]: x for x in rows["Sustain"]["pieces"]}
    assert sus["Artist post"]["toCome"] > 0 and rows["Sustain"]["in"] == 0
    close_to(sus["Artist post"]["toCome"], ov["work"]["pull"]["referral_artist"] * ov["work"]["level"] * 6.0 * 1.5 * 0.5, 0.01)   # its price, at its odds of going out, at how the channel runs
    assert rows["Last chance"]["pieces"][0]["name"] == "Email, audience not set" and rows["Last chance"]["toCome"] > 0
    # a post the plan as set had and that was then cancelled keeps its plan and lands at nothing, and says so
    gone = sus["Avant Arte post (dropped)"]
    assert gone["expected"] > 0 and gone["in"] == 0 and gone["toCome"] == 0
    # the page's headline figures follow the plan
    close_to(plan["lands"], sum(r["lands"] for r in plan["rows"]), 0.05)
    assert pg["hero"]["projected"] == round(min(plan["lands"], 200.0)) and plan["state"] == "live"
    # the suggested actions: the email still to come sent wider, a sustain email, and posts, each with a range in whole units
    pc = pg["planChanges"]
    found = pc["changes"] + pc["more"]
    titles = {(c["kind"], c["title"]) for c in found}
    assert ("change", "Last chance email") in titles and ("add", "Sustain email to the full list") in titles and ("add", "Artist IG post") in titles
    assert all(c["units"] is None or (c["units"]["low"] <= c["units"]["high"] and c["units"]["high"] >= 1) for c in found)
    assert pc["planVisible"] and pc["planDone"] == 2 and len(pc["planToCome"]) == 2 and pc["status"] in ("short", "on_course")


def test_before_anything():
    """Before the first piece goes out the page is the plan alone: nothing in, and it lands where the plan says."""
    c, at = ctx(), funnel().iloc[0:0]
    pg = page(asOf="2026-08-25")
    for ch in pg["channels"]:
        ch["now"] = 0.0
        for r in ch["daily"]:
            r["actual"] = None
    pg["hero"]["now"] = 0.0
    ov = V.override(pg, at, GROUP_OF, c)
    assert ov is not None
    V.finish(pg, ov)
    plan = pg["plan"]
    assert plan["state"] == "start" and plan["in"] == 0
    close_to(plan["lands"], plan["expected"], 0.01)
    assert pg["planChanges"]["changes"] == [] and plan["range"][0] <= plan["expected"] <= plan["range"][1]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} tests passed")
