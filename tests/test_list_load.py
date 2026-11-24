#!/usr/bin/env python3
"""The list's load, each rule held to a hand-built case.

etl/list_load.py holds the Suggested actions card's emails to what the list
has had (docs/METHODOLOGY.md, "The list's load"). These cases hold it to:
which planned emails are read as general sends, one a launch a week; a week's
count of general sends, gone and planned; the four-week load and the state it
puts a week in; a launch's stake; and the rule itself over several launches'
suggestions at once: a normal week takes a general send from any launch that
is short, up to the cap; a busy one from the launch with the most at stake
alone; a very busy one from none; a week at the cap from none, whatever the
load; a launch on course is offered none; an email to fewer than half the list
is never touched; and a page settled twice reads as it did the first time.
Run:
  python3 tests/test_list_load.py
"""
from __future__ import annotations

import copy
import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import list_load as LL  # noqa: E402
import plan_model as P  # noqa: E402

T = pd.Timestamp
TODAY = T("2026-11-16")          # a Monday
LIST = 100000.0


def send(day, delivered, name="x_GEN_Artist_LE_26 - Announcement (LE)", code="Artist_LE_26"):
    return {"name": name, "day": T(day), "delivered": float(delivered), "went": True, "type": P.email_type(name), "kind": P.email_kind(name),
            "code": code, "campaign": code}


def audiences(rows):
    return pd.DataFrame(rows, columns=["name", "day", "delivered", "went", "type", "kind", "code", "campaign"])


def comms(rows):
    cols = ["campaign_code", "release", "date", "channel", "family", "status", "name"]
    df = pd.DataFrame([dict(zip(cols, r)) for r in rows], columns=cols)
    df["date"] = pd.to_datetime(df["date"])
    return df


def plan_row(code, release, day, name, status="Not specced", family="email"):
    return (code, release, day, "AA Email", family, status, name)


def weeks_of(per_week: dict) -> pd.DataFrame:
    """A history with the given emails a person in each week (by its Monday), each as one whole-list send and
    the rest in sends too small to be general."""
    rows = []
    for monday, pp in per_week.items():
        whole, part = int(pp), pp - int(pp)
        for i in range(whole):
            rows.append(send(T(monday) + pd.Timedelta(days=i), LIST, code=f"Past{i}_LE_26"))
        if part > 0:
            rows.append(send(T(monday) + pd.Timedelta(days=4), LIST * part * 0.999 if part < 0.5 else LIST * 0.4, name="x_CUS_Artist_LE_26 - Sustain (LE)"))
            if part >= 0.5:
                rows.append(send(T(monday) + pd.Timedelta(days=5), LIST * (part - 0.4), name="x_CUS_Artist_LE_26 - Sustain (LE)"))
    return audiences(rows)


def page(artist, target, projected, changes, price=1000.0, plan_changes=None, plan_status=None, plan_projected=None):
    status = "on_course" if projected >= target * 0.97 else "short"
    p = {"artist": artist, "hero": {"target": target, "projected": projected, "ok": projected >= target * 0.97}, "economics": {"unitPrice": price},
         "planChanges": {"status": status, "changes": copy.deepcopy(changes[:3]), "more": copy.deepcopy(changes[3:])}}
    if plan_changes is not None:
        p["variants"] = {"plan": {"planChanges": {"status": plan_status or status, "changes": copy.deepcopy(plan_changes[:4]), "more": copy.deepcopy(plan_changes[4:])}}}
        if plan_projected is not None:
            p["variants"]["plan"]["hero"] = {"target": target, "projected": plan_projected, "ok": plan_projected >= target * 0.97}
    return p


def email(key, day, units, people=None, reach=None, title="Sustain email"):
    c = {"key": key, "kind": "add", "title": title, "channel": "Email", "date": day, "units": {"low": units, "high": units}}
    if people is not None:
        c["people"] = people
    if reach:
        c["reach"] = reach
    return c


POST = {"key": "post.artist", "kind": "add", "title": "Artist IG post", "channel": "Artist", "date": "2026-11-19", "units": {"low": 5, "high": 9}}


def ctx_with(prev3, planned_this=0, planned_next=0):
    """A reading as of TODAY with the three weeks before at `prev3` emails a person, and so many general sends
    planned this week and next."""
    hist = weeks_of({"2026-10-26": prev3[0], "2026-11-02": prev3[1], "2026-11-09": prev3[2]})
    rows = [plan_row(f"This{i}_LE_26", f"Artist {i} - Work", "2026-11-18", "Announcement (LE)") for i in range(planned_this)]
    rows += [plan_row(f"Next{i}_LE_26", f"Other {i} - Work", "2026-11-24", "Announcement (LE)") for i in range(planned_next)]
    return LL.read(hist, comms(rows), TODAY)


def keys(block, part):
    return [c["key"] for c in block.get(part) or []]


def test_week_and_words():
    assert LL.week_of("2026-11-16") == T("2026-11-16") and LL.week_of("2026-11-22") == T("2026-11-16") and LL.week_of("2026-11-23") == T("2026-11-23")
    assert [LL.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21)] == ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st"]
    assert LL.state_of(2.0) == "normal" and LL.state_of(2.01) == "busy" and LL.state_of(2.5) == "busy" and LL.state_of(2.51) == "very_busy"


def test_planned_general():
    none = audiences([])
    c = comms([
        plan_row("A_LE_26", "Ada Artist - Work", "2026-11-17", "Announcement (LE)"),
        plan_row("A_LE_26", "Ada Artist - Work", "2026-11-19", "Announcement (LE) re-send"),          # the same launch, the same week: one
        plan_row("A_LE_26", "Ada Artist - Work", "2026-11-18", "Early/Exclusive access (LE)"),
        plan_row("A_LE_26", "Ada Artist - Work", "2026-11-20", "Sustain (LE)"),
        plan_row("A_LE_26", "Ada Artist - Work", "2026-11-21", "Last chance (LE)"),
        plan_row("B_TL_26", "Bo Maker | Print", "2026-11-18", "Now Live (TL Non-flow)"),
        plan_row("B_TL_26", "Bo Maker | Print", "2026-11-18", "Now Live (TL Flow)"),
        plan_row("B_TL_26", "Bo Maker | Print", "2026-11-18", "Early access (TL Artist PP Non Flow)"),
        plan_row("B_TL_26", "Bo Maker | Print", "2026-11-19", "Non-purchaser survey (TL Flow)"),
        plan_row("C_TL_26", "Cy Painter - Hat", "2026-11-19", "Announcement (TL Flow)"),
        plan_row("D_LE_26", "Di Sculptor - Cast", "2026-11-19", "Announcement (LE)", status="Cancelled"),
        plan_row("E_LE_26", "Ed Printer - Sheet", "2026-11-19", "Announcement", family="partner"),
        plan_row("F_LE_26", "Flo Weaver - Rug", "2026-11-10", "Announcement (LE)"),                    # before today: HubSpot's to say
        plan_row("A_LE_26", "Ada Artist - Work", "2026-11-24", "Announcement (LE) 2"),                 # the week after: counted again
    ])
    got = LL.planned_general(c, none, TODAY)
    assert list(zip(got["campaign_code"], got["date"].dt.strftime("%m-%d"), got["label"])) == [
        ("A_LE_26", "11-17", "Ada Artist announcement"), ("B_TL_26", "11-18", "Bo Maker now live email"), ("A_LE_26", "11-24", "Ada Artist announcement")], got
    # a row dated today stops counting once an email of its launch has gone today
    today_row = comms([plan_row("A_LE_26", "Ada Artist - Work", "2026-11-16", "Announcement (LE)")])
    assert len(LL.planned_general(today_row, none, TODAY)) == 1
    gone = audiences([send("2026-11-16", LIST, name="161126_GEN_A_LE_26 - Announcement (LE)", code="A_LE_26")])
    assert len(LL.planned_general(today_row, gone, TODAY)) == 0
    assert len(LL.planned_general(comms([]), none, TODAY)) == 0


def test_read():
    hist = audiences([
        send("2026-07-30", LIST),                                              # the list: the widest send of the last 120 days
        send("2026-10-27", LIST), send("2026-10-29", 30000, name="x_CUS_A_LE_26 - Sustain (LE)"),
        send("2026-11-03", 60000), send("2026-11-05", 49999, name="x_CUS_A_LE_26 - Sustain (LE)"),
        send("2026-11-10", LIST), send("2026-11-11", LIST), send("2026-11-12", 500, name="x_TRNS_A_LE_26 - Dispatch"),
        send("2026-11-16", LIST, name="161126_GEN_Gone_LE_26 - Announcement (LE)", code="Gone_LE_26"),
        send("2026-11-18", LIST),                                              # after today: not yet known
    ])
    plan = comms([plan_row("Next_LE_26", "Nia Next - Work", "2026-11-19", "Announcement (LE)"),
                  plan_row("Far_LE_26", "Fay Far - Work", "2026-11-25", "Announcement (LE)"),
                  plan_row("Far2_LE_26", "Fox Far - Work", "2026-11-26", "Announcement (LE)")])
    ctx = LL.read(hist, plan, TODAY)
    assert ctx["size"] == LIST and ctx["this"] == T("2026-11-16")
    w = ctx["weeks"]
    assert (w[T("2026-10-26")]["sent"], w[T("2026-11-02")]["sent"], w[T("2026-11-09")]["sent"]) == (1, 1, 2)      # 60,000 is general, 49,999 is not, the dispatch note is no marketing
    assert abs(w[T("2026-10-26")]["pp"] - 1.3) < 1e-9 and abs(w[T("2026-11-02")]["pp"] - 1.09999) < 1e-9 and abs(w[T("2026-11-09")]["pp"] - 2.0) < 1e-9
    this = w[T("2026-11-16")]
    assert (this["sent"], this["planned"]) == (1, 1) and this["names"] == ["Gone announcement (Mon)", "Nia Next announcement (Thu)"], this
    base = ctx["base"]
    assert abs(this["pp"] - (1.0 + LL.PLANNED_SHARE + base * 6 / 7)) < 1e-9
    assert abs(this["load"] - (1.3 + 1.09999 + 2.0 + this["pp"]) / 4) < 1e-9 and this["state"] == LL.state_of(this["load"])
    nxt = w[T("2026-11-23")]
    assert (nxt["sent"], nxt["planned"]) == (0, 2) and abs(nxt["pp"] - (2 * LL.PLANNED_SHARE + base)) < 1e-9
    assert w[T("2026-10-26")]["load"] is None                                  # a week with fewer than four behind it has no load
    s = LL.summary(ctx)
    assert s["week"]["general"] == 2 and s["next"]["general"] == 2 and s["cap"] == LL.CAP and s["week"]["state"] == this["state"]
    # no list to speak of: nothing is read
    assert LL.read(audiences([send("2026-11-10", 5000)]), plan, TODAY) is None
    assert LL.read(audiences([]), plan, TODAY) is None


def test_stake_and_reach():
    assert LL.stake_of({"hero": {"target": 500, "projected": 300, "ok": False}, "economics": {"unitPrice": 2000}}) == 400000
    assert LL.stake_of({"hero": {"target": 500, "projected": 490, "ok": False}, "economics": {"unitPrice": 2000}}) == 0      # within 3% is on course
    assert LL.stake_of({"hero": {"target": 500, "projected": 300, "ok": True}, "economics": {"unitPrice": 2000}}) == 0
    assert LL.stake_of({"hero": {"target": 500, "projected": 300}, "benchmark": {"price": 100}}) == 20000
    assert LL.stake_of({}) == 0
    # the larger of the two readings: on course by the clock, short by the plan
    assert LL.stake_of({"hero": {"target": 500, "projected": 500, "ok": True}, "variants": {"plan": {"hero": {"target": 500, "projected": 420, "ok": False}}}, "economics": {"unitPrice": 10}}) == 800
    assert LL.is_general(email("a", "2026-11-19", 5, people=50000), LIST) and not LL.is_general(email("a", "2026-11-19", 5, people=49999), LIST)
    assert LL.is_general(email("a", "2026-11-19", 5, reach="list"), LIST)
    assert not LL.is_general(email("a", "2026-11-19", 5), LIST)                 # an email of unknown reach is not held to the rule
    assert not LL.is_general(dict(POST, people=LIST), LIST)                     # nor is anything that is not an email


def test_normal_week():
    ctx = ctx_with((1.0, 1.0, 1.0), planned_this=1)
    assert ctx["weeks"][ctx["this"]]["state"] == "normal"
    big = page("Ada", 1000, 400, [email("e.full", "2026-11-19", 50, reach="list"), email("e.small", "2026-11-19", 8, people=20000), POST])
    mid = page("Bo", 300, 200, [email("e.full", "2026-11-19", 30, people=LIST)])
    small = page("Cy", 100, 60, [email("e.full", "2026-11-19", 20, people=LIST)], price=100.0)
    done = page("Di", 100, 100, [email("e.full", "2026-11-19", 20, people=LIST), POST])
    held = LL.settle([small, done, big, mid], ctx)
    # one planned, a cap of three: the two launches with the most at stake take the two left, in that order
    assert big["planChanges"]["changes"][0]["general"] == {"nth": 2, "cap": 3, "week": "2026-11-16"}
    assert mid["planChanges"]["changes"][0]["general"]["nth"] == 3
    assert keys(big["planChanges"], "changes") == ["e.full", "e.small", "post.artist"] and not big["planChanges"]["held"]
    assert keys(small["planChanges"], "held") == ["e.full"] and small["planChanges"]["held"][0]["heldBy"] == "load"
    assert "Ada has more at stake that week" in small["planChanges"]["held"][0]["held"]
    assert keys(done["planChanges"], "held") == ["e.full"] and done["planChanges"]["held"][0]["heldBy"] == "course" and keys(done["planChanges"], "changes") == ["post.artist"]
    assert held == 2 and big["planChanges"]["list"]["week"]["general"] == 1


def test_busy_week():
    ctx = ctx_with((2.2, 2.6, 2.6), planned_this=1)
    assert ctx["weeks"][ctx["this"]]["state"] == "busy"
    big = page("Ada", 1000, 400, [email("e.full", "2026-11-19", 50, reach="list"), POST],
               plan_changes=[email("p.full", "2026-11-19", 40, people=LIST), email("p.second", "2026-11-20", 10, people=LIST), email("p.small", "2026-11-19", 6, people=20000)])
    mid = page("Bo", 300, 200, [email("e.full", "2026-11-19", 30, people=LIST)])
    LL.settle([mid, big], ctx)
    # only the launch with the most at stake, and one general send a week for it, on each of its two cards
    assert big["planChanges"]["changes"][0]["general"]["nth"] == 2
    pv = big["variants"]["plan"]["planChanges"]
    assert keys(pv, "changes") == ["p.full", "p.small"] and pv["changes"][0]["general"]["nth"] == 2
    assert keys(pv, "held") == ["p.second"] and pv["held"][0]["heldBy"] == "launch"
    assert keys(mid["planChanges"], "held") == ["e.full"] and "The list is busy" in mid["planChanges"]["held"][0]["held"] and "Ada has more at stake" in mid["planChanges"]["held"][0]["held"]


def test_two_readings():
    """A launch on course by the clock and short by its plan: the plan's card may be sent to the list, the
    clock's is offered nothing; and the other way round."""
    ctx = ctx_with((1.0, 1.0, 1.0), planned_this=0)
    one = page("Ada", 500, 500, [email("e.full", "2026-11-19", 20, reach="list")], plan_changes=[email("p.full", "2026-11-19", 30, people=LIST)],
               plan_status="short", plan_projected=400)
    LL.settle([one], ctx)
    assert keys(one["planChanges"], "held") == ["e.full"] and one["planChanges"]["held"][0]["heldBy"] == "course"
    pv = one["variants"]["plan"]["planChanges"]
    assert keys(pv, "changes") == ["p.full"] and pv["changes"][0]["general"]["nth"] == 1 and not pv["held"]
    two = page("Bo", 500, 400, [email("e.full", "2026-11-19", 20, reach="list")], plan_changes=[email("p.full", "2026-11-19", 30, people=LIST)],
               plan_status="on_course", plan_projected=500)
    LL.settle([two], ctx)
    assert two["planChanges"]["changes"][0]["general"]["nth"] == 1
    assert keys(two["variants"]["plan"]["planChanges"], "held") == ["p.full"] and two["variants"]["plan"]["planChanges"]["held"][0]["held"] == "The launch is on course without it."


def test_very_busy_and_cap():
    ctx = ctx_with((3.2, 3.2, 3.2), planned_this=1)
    assert ctx["weeks"][ctx["this"]]["state"] == "very_busy"
    big = page("Ada", 1000, 400, [email("e.full", "2026-11-19", 50, reach="list"), email("e.small", "2026-11-19", 8, people=20000)])
    LL.settle([big], ctx)
    assert keys(big["planChanges"], "held") == ["e.full"] and big["planChanges"]["held"][0]["heldBy"] == "load" and "very busy" in big["planChanges"]["held"][0]["held"]
    assert keys(big["planChanges"], "changes") == ["e.small"]
    # a quiet list, and a week whose plan already holds the cap: none, whatever the load
    ctx = ctx_with((0.5, 0.5, 0.5), planned_this=3)
    assert ctx["weeks"][ctx["this"]]["state"] in ("normal", "busy")
    big = page("Ada", 1000, 400, [email("e.full", "2026-11-19", 50, reach="list"), email("e.later", "2026-11-25", 30, reach="list")])
    LL.settle([big], ctx)
    b = big["planChanges"]
    assert keys(b, "held") == ["e.full"] and b["held"][0]["heldBy"] == "cap" and b["held"][0]["held"] == "That week already holds 3 general sends. The cap is 3."
    assert keys(b, "changes") == ["e.later"] and b["changes"][0]["general"] == {"nth": 1, "cap": 3, "week": "2026-11-23"}      # the week after has room, and is judged on its own


def test_settled_twice_and_without_a_list():
    ctx = ctx_with((2.2, 2.6, 2.6), planned_this=1)
    rows = [email("e.a", "2026-11-19", 50, reach="list"), email("e.b", "2026-11-19", 40, people=20000), POST, email("e.c", "2026-11-20", 3, people=LIST), email("e.d", "2026-11-19", 2, people=9000)]
    one = page("Ada", 1000, 400, rows)
    LL.settle([one], ctx)
    first = copy.deepcopy(one["planChanges"])
    assert keys(first, "changes") == ["e.a", "e.b", "post.artist"] and keys(first, "more") == ["e.d"] and keys(first, "held") == ["e.c"]
    LL.settle([one], ctx)
    assert one["planChanges"] == first
    # the same page read by a build with no list on file goes back to what the build suggested, in its order
    LL.settle([one], None)
    b = one["planChanges"]
    assert keys(b, "changes") == ["e.a", "e.b", "post.artist"] and keys(b, "more") == ["e.c", "e.d"] and b["held"] == [] and "list" not in b
    assert all("general" not in c and "held" not in c for c in b["changes"] + b["more"])
    # a page with no suggestions, and no pages at all
    assert LL.settle([{"artist": "None"}], ctx) == 0 and LL.settle([], ctx) == 0


def test_one_row_for_one_email():
    """An email the build offers at two audiences is one row: the larger the rule leaves standing, the other
    inside it; where the larger is held the smaller stands alone; and a page settled again reads the same."""
    full = dict(email("e.lc.full", "2026-11-19", 6, people=LIST), same="e.lc")
    mid = dict(email("e.lc.mid", "2026-11-19", 1, people=20000), same="e.lc")
    other = dict(email("e.an.mid", "2026-11-20", 2, people=30000), same="e.an")          # the only one of its email left: a row as it was
    ctx = ctx_with((1.0, 1.0, 1.0), planned_this=0)
    one = page("Ada", 1000, 400, [full, POST, mid, other])
    LL.settle([one], ctx)
    b = one["planChanges"]
    assert keys(b, "changes") == ["e.lc.full", "post.artist", "e.an.mid"] and b["more"] == []
    assert [a["key"] for a in b["changes"][0]["alts"]] == ["e.lc.mid"] and b["changes"][0]["general"]["nth"] == 1
    assert "alts" not in b["changes"][2]
    first = copy.deepcopy(b)
    LL.settle([one], ctx)
    assert one["planChanges"] == first
    # a very busy list holds the general send: the smaller stands, with nothing inside it
    two = page("Ada", 1000, 400, [full, POST, mid])
    LL.settle([two], ctx_with((3.2, 3.2, 3.2), planned_this=1))
    b = two["planChanges"]
    assert keys(b, "changes") == ["post.artist", "e.lc.mid"] and keys(b, "held") == ["e.lc.full"] and "alts" not in b["changes"][1]
    # and the same page read later on a quiet list is one row again, the held one back in it
    LL.settle([two], ctx)
    b = two["planChanges"]
    assert keys(b, "changes") == ["e.lc.full", "post.artist"] and [a["key"] for a in b["changes"][0]["alts"]] == ["e.lc.mid"] and b["held"] == []
    # with no list on file the two are one row all the same
    three = page("Ada", 1000, 400, [full, POST, mid])
    LL.settle([three], None)
    b = three["planChanges"]
    assert keys(b, "changes") == ["e.lc.full", "post.artist"] and [a["key"] for a in b["changes"][0]["alts"]] == ["e.lc.mid"] and "list" not in b


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("list load: all cases hold")
