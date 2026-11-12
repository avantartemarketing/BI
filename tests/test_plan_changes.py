#!/usr/bin/env python3
"""The Suggested actions card's rules, each held to a hand-built launch.

etl/plan_changes.py reads a live draw launch's page, the plan's rows and what
comparable launches sent, and proposes changes to the plan (docs/METHODOLOGY.md,
"Plan changes"). These cases hold it to: who gets a card at all, a launch on
course getting no changes, the last chance email going wide on a reach gap
with its size worked by hand, a plan that logs its emails and holds no last
chance one, an email already planned not being proposed again, the artist's
post that was planned and brought nobody, a thin record standing down, and
the sends read on a campaign's own clock, and the paid budget's change read
off the Spend levels card's own figures. Run:
  python3 tests/test_plan_changes.py
"""
from __future__ import annotations

import copy
import datetime as dt
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import plan_changes as P  # noqa: E402

D = dt.date
ANN, CLOSE = D(2026, 9, 1), D(2026, 9, 25)


def send(name, day, delivered, opened, clicked):
    return {"name": name, "date": day.isoformat() if isinstance(day, D) else day, "delivered": delivered, "opened": opened, "clicked": clicked}


def past(name, close, sends, units=None):
    """A closed launch's record, as launch_history builds it."""
    ann = close - dt.timedelta(days=24)
    rec = P.read_sends(sends, ann, close)
    rec.update(name=name, code=name, announce=ann, close=close,
               units_per_click=(units / rec["clicks"] if units and rec["clicks"] >= P.MIN_OWN_CLICKS else None))
    return rec


def wide_launch(name, close, lc_clicks):
    return past(name, close, [
        send("Announcement (LE)", close - dt.timedelta(days=22), 120000, 18000, 2400),
        send("Last chance (LE)", close - dt.timedelta(days=1), 110000, 12000, lc_clicks)])


def narrow_launch(name, close, lc_clicks):
    return past(name, close, [
        send("Announcement (LE)", close - dt.timedelta(days=22), 120000, 18000, 2400),
        send("Last chance (LE)", close - dt.timedelta(days=1), 9000, 3000, lc_clicks)])


def history():
    h = {}
    for i, clicks in enumerate((1400, 1900)):
        h[f"Wide {i}"] = wide_launch(f"Wide {i}", D(2026, 6, 1) + dt.timedelta(days=30 * i), clicks)
    for i, clicks in enumerate((300, 400, 500)):
        h[f"Narrow {i}"] = narrow_launch(f"Narrow {i}", D(2026, 3, 1) + dt.timedelta(days=20 * i), clicks)
    return h


def page(as_of=D(2026, 9, 23), projected=165.0, target=600.0):
    """A live draw launch two days from its close: one full-list email, a
    reach gap on AA Email, the artist's channels quiet."""
    return {
        "id": "x", "type": "LE", "releaseName": "Artist · Work · 2026 Q3", "campaignCode": "Artist_LE_26",
        "asOf": as_of.isoformat(), "windowStart": ANN.isoformat(), "windowEnd": CLOSE.isoformat(), "complete": False,
        "hero": {"target": target, "projected": projected, "now": 123.0},
        "benchmark": {"members": [{"name": n} for n in ("Wide 0", "Wide 1", "Narrow 0", "Narrow 1", "Narrow 2")], "channelsOff": []},
        "channels": [{"key": "aa_email", "now": 60.0, "bm": 200.0}, {"key": "referral_artist", "now": 0.0, "bm": 4.0}],
        "funnelByGroup": {
            "aa_email": {"sessions_actual": 3600.0, "sessions_expected": 8800.0, "conv_actual": 0.02, "conv_expected": 0.029,
                         "contrib_traffic": -150.0, "contrib_conversion": -34.0},
            "referral_artist": {"sessions_actual": 3.0, "sessions_expected": 80.0},
        },
        "email": {"sequence": [send("Early Access (LE)", D(2026, 8, 28), 5200, 1480, 480),
                               send("Announcement (LE)", D(2026, 9, 2), 133820, 15015, 1520)]},
    }


def keys(block):
    return [c["key"] for c in block["changes"] + block["more"]]


def test_who_gets_a_card() -> None:
    h = history()
    assert P.changes_for(dict(page(), type="TL"), h, []) is None
    assert P.changes_for(dict(page(), complete=True), h, []) is None
    assert P.changes_for(dict(page(), upcoming=True), h, []) is None
    assert P.changes_for(dict(page(), targeted=False), h, []) is None
    assert P.changes_for(dict(page(), benchmark=None), h, []) is None
    assert P.changes_for(dict(page(), line={"key": "prints"}), h, []) is None, "a line's page has no plan of its own"
    assert P.changes_for(page(as_of=D(2026, 9, 26)), h, []) is None, "after the close there is no plan left to change"
    assert P.changes_for(page(as_of=D(2026, 8, 30)), h, []) is None, "before the announce the page is not live"
    print("who gets a card: ok")


def test_on_course_is_left_alone() -> None:
    block = P.changes_for(page(projected=590.0), history(), [])
    assert block["status"] == "on_course" and block["changes"] == [] and block["cohort"] is None, block
    # within the tolerance of the target counts as on course; just outside it does not
    assert P.changes_for(page(projected=600.0 * (1 - P.SHORT_TOLERANCE)), history(), [])["status"] == "on_course"
    assert P.changes_for(page(projected=570.0), history(), [])["status"] == "short"
    print("on course: ok")


def test_last_chance_goes_wide_on_a_reach_gap() -> None:
    block = P.changes_for(page(), history(), [])
    assert block["status"] == "short" and block["daysLeft"] == 2 and block["cohort"] == {"n": 5, "kind": "similar"}
    assert keys(block) == ["email.last_chance.widen"], keys(block)
    c = block["changes"][0]
    assert (c["kind"], c["title"], c["to"], c["channel"], c["date"]) == ("change", "Last chance email", "Full list", "Email", "2026-09-24"), c
    assert c["lever"] == "le_email_lastchance_widen_audience"
    # the size by hand: the two wide closes brought 1,400 and 1,900 clicks, the
    # targeted ones a median 400; this launch has had 60 units off 2,000 clicks
    upc = 60.0 / 2000.0
    assert c["units"] == {"low": round((1400 - 400) * upc), "high": round((1900 - 400) * upc)}, c["units"]
    assert c["reason"] == "One full-list email so far, 89% unopened. 2 of 5 similar launches closed with a wide send.", c["reason"]
    # conversion the bigger gap: reach is not the problem, so the email is not widened on it
    conv = page()
    conv["funnelByGroup"]["aa_email"].update(contrib_traffic=-10.0, contrib_conversion=-90.0)
    assert "email.last_chance.widen" not in keys(P.changes_for(conv, history(), []))
    # a wide last chance email already sent: nothing left to widen
    sent = page()
    sent["email"]["sequence"].append(send("Last chance (LE)", D(2026, 9, 23), 120000, 14000, 1300))
    assert "email.last_chance.widen" not in keys(P.changes_for(sent, history(), []))
    # a targeted one sent: the rest of the list is the change, an addition, sized past what it brought
    part = page()
    part["email"]["sequence"].append(send("Last chance (LE)", D(2026, 9, 23), 9000, 3000, 500))
    c = P.changes_for(part, history(), [])["changes"][0]
    assert (c["kind"], c["title"], c["note"]) == ("add", "Last chance email to the rest of the list", "Sent to 9,000 so far"), c
    upc = 60.0 / 2500.0
    assert c["units"] == {"low": round((1400 - 500) * upc), "high": round((1900 - 500) * upc)}, c["units"]
    print("last chance goes wide: ok")


def plan(*rows):
    return [{"campaign_code": "Artist_LE_26", "release_name": "", "date": d.isoformat(), "channel": ch, "title": t} for d, ch, t in rows]


def test_the_plan_is_read() -> None:
    h = history()
    # a plan that logs its emails and holds none in the last two days: the standard reminder is missing
    rows = plan((D(2026, 9, 2), "email", "Announcement"), (D(2026, 9, 24), "brand", "Last chance story"))
    block = P.changes_for(page(), h, rows)
    assert block["planVisible"] and block["planDone"] == 1
    assert block["planToCome"] == [{"date": "2026-09-24", "channel": "AA Social", "title": "Last chance story"}], block["planToCome"]
    c = next(c for c in block["changes"] if c["key"] == "email.last_chance.add")
    assert (c["kind"], c["title"], c["note"], c["date"]) == ("add", "Last chance email", "Not in the plan", "2026-09-24"), c
    assert c["reason"] == "5 of 5 similar launches sent one in the last two days."
    assert "email.last_chance.widen" not in keys(block), "one change per email, the missing one first"
    # the same plan with the email in it: it is planned, so it is widened on its own day, not added
    rows = plan((D(2026, 9, 2), "email", "Announcement"), (D(2026, 9, 25), "email", "Last chance"))
    block = P.changes_for(page(), h, rows)
    c = block["changes"][0]
    assert (c["key"], c["kind"], c["date"]) == ("email.last_chance.widen", "change", "2026-09-25"), c
    # another release's rows are not this one's plan
    other = [dict(r, campaign_code="Other_LE_26") for r in rows]
    assert P.changes_for(page(), h, other)["planVisible"] is False
    # a release found by name where its rows carry no code
    named = [dict(r, campaign_code="", release_name="Artist · Work · 2026 Q3") for r in rows]
    assert P.changes_for(page(), h, named)["planVisible"] is True
    print("the plan is read: ok")


def test_artist() -> None:
    h = history()
    # a post planned three days ago and three visits from the artist's channels since
    rows = plan((D(2026, 9, 20), "artist", "Sustain grid post"), (D(2026, 9, 24), "email", "Last chance"))
    block = P.changes_for(page(), h, rows)
    c = next(c for c in block["changes"] if c["key"] == "artist.post.unseen")
    assert (c["kind"], c["title"], c["note"], c["channel"]) == ("add", "Artist post", "Planned 20 Sep, no visits seen", "Artist"), c
    assert c["units"] == {"low": 2, "high": 4}, c["units"]
    # nothing of the artist's in the plan for the last days, and their channels well short: the last chance story
    rows = plan((D(2026, 9, 2), "artist", "Announcement grid post"), (D(2026, 9, 24), "email", "Last chance"))
    block = P.changes_for(page(), h, rows)
    c = next(c for c in block["changes"] if c["key"] == "artist.last_chance.add")
    assert (c["title"], c["note"], c["date"]) == ("Artist last chance story", "Not in the plan", "2026-09-24"), c
    # one already planned: nothing to add
    rows.append(plan((D(2026, 9, 24), "artist", "Last chance story"))[0])
    assert not [k for k in keys(P.changes_for(page(), h, rows)) if k.startswith("artist.")]
    # an artist with no channels of their own is not asked for a post
    off = page()
    off["benchmark"]["channelsOff"] = ["referral_artist"]
    assert not [k for k in keys(P.changes_for(off, h, plan((D(2026, 9, 2), "artist", "x")))) if k.startswith("artist.")]
    # without the plan on file the artist's posts cannot be judged missing
    assert not [k for k in keys(P.changes_for(page(), h, [])) if k.startswith("artist.")]
    print("artist: ok")


def test_a_thin_record_stands_down() -> None:
    # one comparable launch closed wide, and no recent one besides: not enough to propose on
    h = history()
    del h["Wide 1"]
    assert "email.last_chance.widen" not in keys(P.changes_for(page(), h, []))
    # too few comparable launches with sends: the recent ones stand in, and say so
    few = page()
    few["benchmark"]["members"] = [{"name": "Wide 0"}]
    block = P.changes_for(few, history(), [])
    assert block["cohort"] == {"n": 5, "kind": "recent"}, block["cohort"]
    assert block["changes"][0]["reason"].endswith("2 of 5 recent launches closed with a wide send."), block["changes"][0]["reason"]
    # the recent launches narrowed to the draw panel's names
    assert P.changes_for(few, history(), [], pool={"Wide 0", "Narrow 0"})["cohort"] == {"n": 2, "kind": "recent"}
    # a launch is never its own comparison, nor is one that closed after it
    h = history()
    h["Artist · Work · 2026 Q3"] = wide_launch("self", D(2026, 5, 1), 5000)
    h["Later"] = wide_launch("Later", D(2026, 12, 1), 5000)
    assert P.changes_for(few, h, [])["cohort"]["n"] == 5
    print("a thin record stands down: ok")


def test_sends_on_the_clock() -> None:
    rec = P.read_sends([
        send("Early Access (LE)", D(2026, 8, 28), 5000, 1500, 500),
        send("Announcement (LE)", D(2026, 9, 2), 130000, 15000, 1500),
        send("Announcement (LE) Mop Up V2", D(2026, 9, 6), 40000, 6000, 700),
        send("Sustain (LE)", D(2026, 9, 12), 60000, 8000, 600),
        send("Last Chance 48 Hours (LE)", D(2026, 9, 23), 126000, 14000, 1400),
        send("Exclusive Access Miss Outs", D(2026, 9, 24), 90, 30, 3),
        send("Last Chance 24 Hours (LE)", D(2026, 9, 24), 7000, 1700, 320),
    ], ANN, CLOSE)
    assert rec["biggest"]["name"] == "Announcement (LE)" and rec["clicks"] == 5023
    assert [s["name"] for s in rec["last"]] == ["Last Chance 48 Hours (LE)", "Last Chance 24 Hours (LE)"], "an early-access send is no last chance email"
    assert rec["last_clicks"] == 1720 and rec["last_wide"] is True
    assert [s["name"] for s in rec["mid"]] == ["Announcement (LE) Mop Up V2", "Sustain (LE)"] and rec["mid_clicks"] == 1300
    assert [s["name"] for s in rec["resend"]] == ["Announcement (LE) Mop Up V2"]
    assert [s["name"] for s in rec["two_out"]] == ["Last Chance 48 Hours (LE)"]
    assert P.spread([5, 9]) == (5.0, 9.0) and P.spread([4]) is None and P.spread([1, 2, 3, 4, 5]) == (2.0, 4.0)
    print("sends on the clock: ok")


def levels(today, recommended, tomorrow=None, stop=None, marginal=None, days=5):
    """The Spend levels card's block: what each flat daily spend ends on."""
    return {"today": today, "recommended": recommended, "tomorrow": tomorrow, "stop": stop, "marginalToday": marginal, "daysLeft": days,
            "rows": [{"key": "none", "daily": 0.0, "unitsAtClose": 100.0}, {"key": "half", "daily": 1000.0, "unitsAtClose": 130.0},
                     {"key": "recommended", "daily": 2000.0, "unitsAtClose": 150.0}, {"key": "double", "daily": 4000.0, "unitsAtClose": 170.0}]}


def test_paid() -> None:
    day, close = D(2026, 9, 20), CLOSE
    # a raise: tomorrow's step toward the level, sized in the units the level adds by the close
    c = P.paid_change(levels(1000.0, 2000.0, 1500.0, marginal=1.6), day, close)
    assert (c["key"], c["kind"], c["title"], c["from"], c["to"], c["channel"], c["date"]) == \
        ("paid.budget.1500", "change", "Paid daily budget", "\u20ac1,000", "\u20ac1,500", "Paid", "2026-09-21"), c
    assert c["units"] == {"low": 20, "high": 20} and "saves" not in c, c
    assert c["reason"] == "The next euro returns 1.6 at today's \u20ac1,000. \u20ac2,000 a day is the level it is heading for.", c["reason"]
    # within five per cent of today's spend is a hold, and no change
    assert P.paid_change(levels(1000.0, 2000.0, 1040.0), day, close) is None
    # a cut: sized in the spend it saves to the close, the units it gives up said in the reason
    c = P.paid_change(levels(2000.0, 1000.0, 1500.0, marginal=0.7), day, close)
    assert (c["kind"], c["from"], c["to"], c["units"], c["saves"]) == ("change", "\u20ac2,000", "\u20ac1,500", None, 2500), c
    assert c["reason"] == ("The next euro returns 0.7 at today's \u20ac2,000, under the 1.0 it costs. "
                           "\u20ac1,000 a day is the level it is heading for. About 20 fewer units by the close."), c["reason"]
    # a stop is the one drop: the reason the Spend levels card gives, and what it saves
    c = P.paid_change(levels(900.0, 0.0, stop="supply", days=4), day, close)
    assert (c["key"], c["kind"], c["title"], c["note"], c["from"], c["saves"]) == ("paid.stop", "drop", "Paid spend", "Edition spoken for", "\u20ac900", 3600), c
    assert P.paid_change(levels(0.0, 0.0, stop="marginal"), day, close) is None, "nothing to stop when nothing is spent"
    # nothing spent and a level worth spending at: paid is added
    c = P.paid_change(levels(0.0, 800.0, 400.0), day, close)
    assert (c["key"], c["kind"], c["title"], c["to"]) == ("paid.budget.400", "add", "Paid spend", "\u20ac400 a day"), c
    # no reading, or the close itself: nothing
    assert P.paid_change(None, day, close) is None and P.paid_change(levels(1000.0, 2000.0, 1500.0), close, close) is None
    # a launch on course still takes its paid change; a short one takes it beside the email's, largest first
    on = page(projected=590.0, as_of=day)
    on["paid"] = {"levels": levels(2000.0, 1000.0, 1500.0, marginal=0.7)}
    block = P.changes_for(on, history(), [])
    assert block["status"] == "on_course" and keys(block) == ["paid.budget.1500"], block
    short = page(as_of=D(2026, 9, 23))
    short["paid"] = {"levels": levels(1000.0, 2000.0, 1500.0, marginal=1.6, days=2)}
    assert keys(P.changes_for(short, history(), [])) == ["email.last_chance.widen", "paid.budget.1500"]
    # an ad set per line of work: one change per line, off the line's own levels
    two = page(projected=590.0, as_of=day)
    two["lines"] = [{"key": "Prints", "name": "Prints"}, {"key": "toy-bricks", "name": "Toy bricks"}]
    two["variants"] = {"lines": {"Prints": {"paid": {"levels": levels(1000.0, 2000.0, 1500.0)}},
                                 "toy-bricks": {"paid": {"levels": levels(900.0, 0.0, stop="marginal")}}}}
    two["paid"] = {"levels": levels(1900.0, 2000.0, 3000.0)}
    got = P.changes_for(two, history(), [])["changes"]
    assert [(c["key"], c["title"]) for c in got] == [("paid.prints.budget.1500", "Paid daily budget \u00b7 Prints"),
                                                     ("paid.toy_bricks.stop", "Paid spend \u00b7 Toy bricks")], got
    print("paid: ok")


def test_attach() -> None:
    snap = page()
    P.attach(snap, None)
    assert "planChanges" not in snap, "a build with no context leaves the page alone"
    P.attach(snap, {"history": history(), "plan_rows": [], "pool": None})
    assert snap["planChanges"]["changes"][0]["key"] == "email.last_chance.widen"
    closed = dict(copy.deepcopy(snap), complete=True)
    P.attach(closed, {"history": history(), "plan_rows": [], "pool": None})
    assert "planChanges" not in closed, "a page the card does not apply to loses a stale one"
    # at most MAX_SHOWN on the card, the largest first, the rest folded
    assert len(snap["planChanges"]["changes"]) <= P.MAX_SHOWN
    print("attach: ok")


if __name__ == "__main__":
    test_who_gets_a_card()
    test_on_course_is_left_alone()
    test_last_chance_goes_wide_on_a_reach_gap()
    test_the_plan_is_read()
    test_artist()
    test_a_thin_record_stands_down()
    test_sends_on_the_clock()
    test_paid()
    test_attach()
