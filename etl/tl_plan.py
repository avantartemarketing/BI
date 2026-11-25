"""A timed launch read by its plan: the signups to its sales open, piece by piece.

The plan-based view of a draw launch (etl/plan_view.py, docs/PLAN_MODEL.md 6) reads the page by the comms that go
out. A timed launch before its window is read the same way, with one difference that the launches closed so far
insist on (docs/PLAN_MODEL.md 8, etl/analysis/tl_plan_backtest.py): two thirds of a timed launch's signups are
bought, and what tells one launch from another is its paid budget, not its comms. So this view has two halves:

  outside paid   plan_view's own reading on the timed launches' price list (etl/tl_plan_prices.json): each email
                 and post priced in quiet days of signups, at the launch's level and at how each channel is
                 running, with the baseline beside them. A timed launch's phases are its own (PHASES): the
                 announcement, the days between, and the open.
  paid           the spend still to come at what a signup will cost. The spend is today's, held to the open (the
                 mean of the last SPEND_DAYS full days); the cost is the launch's own so far, marked up by how
                 much dearer a launch's later signups have been than its earlier ones at this point of its span
                 (`paid_up` on the price list: about x1.8), or the basket's cost a signup until the launch has
                 MIN_PAID_SEEN paid signups of its own. The clock reads paid as every other channel, by the share
                 of the span gone by, whatever is being spent.

override() gives etl/tl.py the path of each channel group for the page it builds a second time (le_blocks,
`plan_ov`); finish() lays the plan card, the headline and the suggested actions over that page. The page reads
"as it stands": where the plan lands with nothing changed. What the budget's own pace would bring is the first
suggested action. The window's hours stay on the clock: nothing is laid over a page once its sales have opened.
"""
from __future__ import annotations

import json
import math
import re

import numpy as np
import pandas as pd

import plan_model as P
import plan_view as V

PRICES_PATH = P.ROOT / "etl" / "tl_plan_prices.json"

PHASES = ["Announce", "Sustain", "The open"]
ANNOUNCE_DAYS = 1          # a piece up to this many days after the announce is the announcement's
OPEN_DAYS = 1              # ... and one this many days or fewer before the sales open is the open's
SPEND_DAYS = 3             # today's spend is the mean of these last full days with spend
MIN_PAID_SEEN = 30.0       # paid signups before the launch's own cost a signup is read
MIN_PAID_SPEND = 200.0     # ... and this much spent
HOLD = 0.1                 # a budget pace within this of today's spend is no suggestion
SHOWN = 4                  # suggested actions shown before the rest fold under "more"

_FLOW = re.compile(r"\bflow\b", re.I)
_NON_FLOW = re.compile(r"\bnon[\s-]?flow\b", re.I)


def phase(day, announce, days: int) -> str:
    t = int((pd.Timestamp(day) - announce).days)
    return PHASES[0] if t <= ANNOUNCE_DAYS else PHASES[2] if t >= days - OPEN_DAYS else PHASES[1]


def planned_email(name: str, kind: str) -> bool:
    """A plan row still to come that is an email to bring signups: not a flow's own email (it goes to the people
    already signed up), and not a survey or a thank you."""
    return kind != "after" and not (_FLOW.search(name) and not _NON_FLOW.search(name))


SPEC = {"phases": PHASES, "row_phase": lambda r, ann, days: phase(r["date"], ann, days), "send_phase": lambda s, ann, days: phase(s["day"], ann, days),
        "planned_email": planned_email}

_CTX: dict | None = None


def context(reload: bool = False) -> dict | None:
    """What every timed launch's plan view reads: the plan view's own feeds (the Notion plan, the HubSpot emails)
    with the timed launches' price list in place of the draw launches'. None when any is missing."""
    global _CTX
    if _CTX is not None and not reload:
        return _CTX or None
    base = V.context(reload)
    prices = None
    try:
        prices = json.loads(PRICES_PATH.read_text())
    except (OSError, ValueError):
        pass
    ok = bool(base) and bool(prices) and bool((prices or {}).get("split")) and "fade_email" in (prices or {})
    _CTX = {**base, "prices": prices} if ok else {}
    return _CTX or None


def _open_day(page: dict):
    return V._ts(str(page.get("salesOpen") or page.get("windowOpen") or "")[:10])


def override(page: dict, daily: pd.DataFrame | None, ctx: dict | None) -> dict | None:
    """The plan's path for a timed launch gathering signups: plan_view.override on the launch's own days (the
    announce to the sales open) and its own signups by day and channel. None for a page the view is not for;
    {"skip": why} for a launch gathering signups that could have had one."""
    if not ctx or not isinstance(page, dict) or page.get("type") != "TL" or page.get("tlState") != "signups":
        return None
    opn = _open_day(page)
    if opn is None:
        return None

    def entered(days) -> dict:
        out = {}
        if daily is None or not len(daily) or "group" not in daily.columns:
            return out
        f = daily[daily["day"].notna()]
        for g in V.FAMILIES:
            x = f[f["group"] == g].groupby("day")["signups"].sum()
            if len(x):
                x.index = pd.to_datetime(x.index)
                out[g] = x.reindex(days).fillna(0.0).to_numpy(dtype=float)
        return out

    ov = V.override({**page, "windowEnd": str(opn.date())}, None, {}, ctx, spec=SPEC, entered=entered)
    if ov and not ov.get("skip"):
        ov["paid"] = paid_path(page, ctx["prices"], opn)
    return ov


def dearer(prices: dict, f: float) -> float:
    """How much dearer a launch's signups after the point `f` of its span have been than those before it."""
    pts = sorted((float(k), float(v["x"])) for k, v in (prices.get("paid_up") or {}).items())
    if not pts:
        return 1.0
    return float(np.interp(min(max(f, pts[0][0]), pts[-1][0]), [p[0] for p in pts], [p[1] for p in pts]))


def paid_path(page: dict, prices: dict, opn) -> dict:
    """Paid's signups to the open at today's spend, and at the budget's pace (the module's note)."""
    paid = page.get("paid") or {}
    ann, today = V._ts(page.get("windowStart")), V._ts(page.get("asOf"))
    frac = float(page.get("asOfFraction") or 1.0)
    L = max(int((opn - ann).days), 1)
    left_days = max(float((opn - today).days) + (1.0 - frac), 0.0)        # the days still to come, the rest of today among them
    f = min(max(((today - ann).days + frac) / L, 0.0), 1.0)
    now = float(next((c.get("now") for c in page.get("channels") or [] if c.get("key") == "paid"), 0.0) or 0.0)
    spent = float(paid.get("spendPre") or 0.0)
    full = [float(r.get("spend") or 0.0) for r in paid.get("daily") or [] if not r.get("partial") and str(r.get("date")) < str(today.date())]
    recent = [x for x in full[-SPEND_DAYS:] if x > 0] if full and full[-1] > 0 else []
    spend_today = float(np.mean(recent)) if recent else 0.0
    plan_cost = float(paid.get("costPlan") or paid.get("bmCostPerSignup") or 0.0) or None
    own = now >= MIN_PAID_SEEN and spent >= MIN_PAID_SPEND
    up = dearer(prices, f)
    cost_next = (spent / now) * up if own else plan_cost
    budget = float(paid.get("budgetPre") or 0.0) or None
    left = max(budget - spent, 0.0) if budget else None
    pace = (left / left_days) if (left is not None and left_days > 0) else None

    def buys(spend: float) -> float:
        return (spend / cost_next) if cost_next and cost_next > 0 else 0.0

    return {"now": now, "spent": spent, "spendToday": spend_today, "daysLeft": left_days, "costSoFar": (spent / now) if now > 0 else None, "costNext": cost_next,
            "costSource": "own" if own else "basket", "dearer": up if own else None, "toCome": buys(spend_today * left_days),
            "budget": budget, "budgetLeft": left, "budgetPace": pace, "toComeAtBudget": buys(left) if left is not None else None,
            "target": float(paid.get("targetSignups") or 0.0) or None}


# ---------------------------------------------------------------- the suggested actions
def _money(v: float) -> str:
    return f"€{int(round(v)):,}"


def changes(w: dict, page: dict, paid: dict) -> list[dict]:
    """What could be changed from here, each with the signups it should bring by the open: the paid budget's own
    pace against today's spend, an email to the list or to fewer, and a post from the artist, Avant Arte or a
    partner. Emails say who they go to, so one to half the list or more is held to the list's load
    (etl/list_load.py) as a draw launch's is."""
    pr, coef, ann, today, L = w["pr"], w["coef"], w["ann"], w["today"], w["L"]
    level, pull, pull_all = w["level"], w["pull"], w["pull_all"]
    days_left = int((w["close"] - today).days)
    out = []
    # paid first: it is most of a timed launch's signups
    pace, spend_today = paid.get("budgetPace"), float(paid.get("spendToday") or 0.0)
    if pace is not None and paid.get("costNext") and days_left >= 1:
        more = float(paid["toComeAtBudget"] or 0.0) - float(paid["toCome"] or 0.0)
        tomorrow = str((today + pd.Timedelta(days=1)).date())
        cost = f"a signup is costing {_money(paid['costSoFar'])} so far and the rest are read at {_money(paid['costNext'])}" if paid["costSource"] == "own" \
            else f"a signup is read at the basket's {_money(paid['costNext'])} until this launch has its own"
        if spend_today <= 0 and pace > 0:
            out.append({"key": f"paid.budget.{int(round(pace))}", "kind": "add", "title": "Paid spend", "to": f"{_money(pace)} a day", "channel": "Paid", "date": tomorrow,
                        "units": {"low": more, "high": more}, "lever": "tl_paid_budget_pace",
                        "reason": f"Nothing is being spent. {_money(paid['budgetLeft'])} of the budget is left over {days_left} days; {cost}."})
        elif spend_today > 0 and abs(pace - spend_today) / spend_today >= HOLD:
            c = {"key": f"paid.budget.{int(round(pace))}", "kind": "change", "title": "Paid daily budget", "from": _money(spend_today), "to": _money(pace), "channel": "Paid",
                 "date": tomorrow, "lever": "tl_paid_budget_pace"}
            lead = f"{_money(paid['budgetLeft'])} of the {_money(paid['budget'])} budget is left over {days_left} days, which is {_money(pace)} a day against today's {_money(spend_today)}"
            if pace > spend_today:
                faster = " Spending this much faster may cost more a signup, so read this as the most it brings." if pace > 1.5 * spend_today else ""
                c.update(units={"low": more, "high": more}, reason=f"{lead}; {cost}.{faster}")
            else:
                c.update(units=None, saves=int(round((spend_today - pace) * paid["daysLeft"])), reason=f"{lead}: at today's spend the budget runs out before the open. About {int(round(-more))} fewer signups.")
            out.append(c)
    # the comms: valued by the price list at this launch's level and at how its channel is running
    pe, ps, pa = pull.get("aa_email", pull_all), pull.get("aa_social", pull_all), pull.get("referral_artist", pull_all)
    lo_m, hi_m = [float(np.exp(x)) for x in pr["clicks"]["spread"]]
    aud = w["aud"]
    recent = aud[aud["went"] & (aud["day"] >= today - pd.Timedelta(days=V.FULL_LIST_DAYS)) & (aud["day"] <= today)] if len(aud) else aud
    full = float(recent["delivered"].max()) if len(recent) else 0.0
    sends = w["sends"]
    planned = sends[sends["planned"]] if len(sends) else sends
    if full >= V.WIDE_SEND:
        for _, s in planned.iterrows():
            t, n0 = int((s["day"] - ann).days), float(s["delivered"])
            if s["kind"] != "announce" or full <= n0 * 1.5:
                continue      # an early access goes to the people it is for; an announcement can go wider
            u = pe * level * (P.action_value("em_announce", P.expected_clicks("announce", full, t, L, coef) / P.CLICKS_REF, pr)
                              - P.action_value("em_announce", P.expected_clicks("announce", n0, t, L, coef) / P.CLICKS_REF, pr))
            clicks = int(round(P.expected_clicks("announce", full, t, L, coef, math.log(max(pe, 1e-6)))))
            out.append({"key": f"email.announce.{str(s['day'].date())}.{int(full)}", "kind": "change", "title": "Announcement email", "from": f"{int(round(n0, -2)):,}", "to": "Full list",
                        "channel": "Email", "date": str(s["day"].date()), "people": int(round(full)), "units": {"low": u * lo_m, "high": u * hi_m}, "lever": "plan",
                        "reason": f"No audience is set yet, so the usual {int(round(n0, -2)):,} people are assumed. To the full list it should bring about {clicks:,} clicks, "
                                  "read as a first announcement is: people who have already had one will answer less."})
    t_mid = min(int((today - ann).days) + V.MID_LEAD_DAYS, L - 2)
    if days_left >= V.MIN_DAYS_LEFT and t_mid > int((today - ann).days):
        mid_day = ann + pd.Timedelta(days=t_mid)
        has_email = len(planned) and bool(((planned["day"] > today) & (planned["day"] <= w["close"] - pd.Timedelta(days=2))).any())
        if not has_email and full >= V.WIDE_SEND:
            small = round(float((pr.get("usual_audience") or {}).get("early_access") or 5000.0) * 3, -3) or 5000.0
            for n, label in ((full, "Second announcement to the full list"), (min(small, full / 4), f"Second announcement to {int(min(small, full / 4)):,}")):
                u = pe * level * P.action_value("em_announce", P.expected_clicks("announce", n, t_mid, L, coef) / P.CLICKS_REF, pr)
                clicks = int(round(P.expected_clicks("announce", n, t_mid, L, coef, math.log(max(pe, 1e-6)))))
                out.append({"key": f"email.announce.add.{int(n)}", "kind": "add", "title": label, "note": "Not in the plan", "channel": "Email", "date": str(mid_day.date()),
                            "people": int(round(n)), "units": {"low": u * lo_m, "high": u * hi_m}, "lever": "plan",
                            "reason": f"About {clicks:,} clicks at how this launch's emails are running. Read as a first announcement is: people who have already had one will answer less."})
        running = {"Artist": pa, "AA Social": ps, "Partner": pull_all}
        for col, label, chn in (("pl_artist_story", "Artist IG story", "Artist"), ("pl_artist_post", "Artist IG post", "Artist"), ("pl_aa_post", "AA IG post", "AA Social")):
            u = running[chn] * level * P.action_value(col, 1.0, pr)
            word = "more than" if running[chn] > 1.1 else "less than" if running[chn] < 0.9 else "about what"
            who = {"Artist": "The artist's channels are", "AA Social": "Avant Arte's posts are"}[chn]
            out.append({"key": f"post.{col}", "kind": "add", "title": label, "note": "Not in the plan", "channel": chn, "date": str(mid_day.date()),
                        "units": {"low": u * V.POST_BAND[0], "high": u * V.POST_BAND[1]}, "lever": "plan", "reason": f"{who} bringing {word} the plan expected so far."})
    return out


# ---------------------------------------------------------------- finish: the plan-built page made whole
def finish(page: dict, ov: dict) -> None:
    """Lay the plan card, the headline and the suggested actions onto a page etl/tl.py has just built on the
    plan's path (`ov` is override()'s answer for it)."""
    w, paid = ov["work"], ov["paid"]
    chan = {c["key"]: c for c in page.get("channels") or []}
    hero = page.setdefault("hero", {})
    target = float(hero.get("target") or w["target"])
    rows = V.card_rows(w)
    pc = chan.get("paid")
    if pc is not None:
        expected = float(pc.get("target") or paid.get("target") or 0.0)
        spend_word = f"{_money(paid['spendToday'])} a day to the open" if paid["spendToday"] > 0 else "Nothing being spent"
        note = (f"A signup is read at {_money(paid['costNext'])} from here: {_money(paid['costSoFar'])} so far, and a launch's later signups have cost about {paid['dearer']:.1f} times its earlier ones"
                if paid["costSource"] == "own" else f"A signup is read at the basket's {_money(paid['costNext'])} until this launch has its own" if paid.get("costNext") else "")
        rows.append({"moment": V.PAID, "expected": expected, "in": paid["now"], "toCome": paid["toCome"], "note": note,
                     "pieces": [{"when": "", "name": f"{_money(paid['spent'])} spent so far", "who": "paid", "expected": float(pc.get("exp") or 0.0), "in": paid["now"], "toCome": 0.0},
                                {"when": "", "name": spend_word, "who": "paid", "expected": max(expected - float(pc.get("exp") or 0.0), 0.0), "in": 0.0, "toCome": paid["toCome"]}]})
    for r in rows:
        if r["moment"] in PHASES:      # an email the price list gives nothing (a now-live email at the open's hour) and nothing came of is no line
            r["pieces"] = [x for x in r["pieces"] if max(x["expected"], x["in"], x["toCome"]) >= 0.05]
        r["lands"] = r["in"] + r["toCome"]
        for k in ("expected", "in", "toCome", "lands"):
            r[k] = round(float(r[k]), 2)
        for x in r["pieces"]:
            for k in ("expected", "in", "toCome"):
                x[k] = round(float(x[k]), 2)
    tot = {k: sum(r[k] for r in rows) for k in ("expected", "in", "toCome", "lands")}
    started = tot["in"] > 0 or w["today"] >= pd.Timestamp(w["first"])
    lands = tot["lands"] if started else tot["expected"]
    by_today = sum(float(c.get("exp") or 0.0) for c in page.get("channels") or [])
    now_all = float(hero.get("now") or tot["in"])
    hero.update({"projected": round(lands), "expectedToday": round(by_today), "delta": round(now_all - by_today),
                 "statusPct": round(now_all / by_today - 1.0, 4) if by_today > 0 else 0.0, "ok": lands >= target * (1 - V.SHORT_TOLERANCE)})
    lo, hi = ov["meta"]["organicRange"]
    paid_plan = float((pc or {}).get("target") or 0.0)
    basis = {"artist": f"the artist's last {ov['meta']['levelN']} timed launches", "basket": f"the {ov['meta']['levelN']} launches the page is benchmarked on",
             "all": "every past timed launch"}[ov["meta"]["levelBasis"]]
    page["method"] = "plan"
    page["plan"] = {"state": "live" if started else "start", "target": target, "expected": round(tot["expected"], 2), "in": round(tot["in"], 2), "toCome": round(tot["toCome"], 2),
                    "lands": round(lands, 2), "byToday": round(by_today, 2), "range": [round(lo + paid_plan, 1), round(hi + paid_plan, 1)],
                    "landsRecommended": round(lands - paid["toCome"] + paid["toComeAtBudget"], 1) if paid.get("toComeAtBudget") is not None else None,
                    "paidToday": round(paid["spendToday"], 2), "paidRecommended": round(paid["budgetPace"], 2) if paid.get("budgetPace") is not None else None,
                    "rows": rows, "pull": round(ov["meta"]["pullAll"], 3), "level": round(ov["meta"]["level"], 3), "levelBasis": ov["meta"]["levelBasis"],
                    "notes": [f"What each email and post is expected to bring is sized on {basis}.", "Still to come follows how each channel is responding so far.",
                              "Paid is read from the spend, not the calendar: today's spend held to the open, at what a signup will cost."]}
    found = [dict(c, units=V._whole(c["units"]) if c.get("units") else None) for c in (changes(w, page, paid) if started else [])]
    found = [c for c in found if c["units"] or c.get("channel") == "Paid"]
    found.sort(key=lambda c: -(((c["units"]["low"] + c["units"]["high"]) / 2) if c["units"] else 0))
    plan = w["plan"]
    listed = plan[~plan["status"].isin(P.DROPPED)].sort_values("date")
    to_come = listed[listed["date"] >= w["today"]]
    page["planChanges"] = {"asOf": str(w["today"].date()), "daysLeft": int((w["close"] - w["today"]).days), "status": "short" if lands < target * (1 - V.SHORT_TOLERANCE) else "on_course",
                           "planVisible": True, "planDone": int(((listed["date"] < w["today"]) & listed["status"].isin(P.WENT)).sum()),
                           "planToCome": [{"date": str(r["date"].date()), "channel": "Email" if r["family"] == "email" else "Artist" if str(r["family"]).startswith("artist") else "Partner" if r["family"] == "partner" else "AA Social",
                                           "title": f"{r['name']} · {r['channel']}"} for _, r in to_come.iterrows()],
                           "cohort": None, "changes": found[:SHOWN], "more": found[SHOWN:]}
    wf = page.get("waterfall")
    if isinstance(wf, dict):
        steps = [{"key": "plan", "label": "The plan against the target", "value": round(tot["expected"] - target)}]
        steps += [{"key": r["moment"], "label": r["moment"], "value": round(r["lands"] - r["expected"])} for r in rows]
        steps[-1]["value"] += round(lands - target) - sum(s["value"] for s in steps)
        wf.update({"target": target, "projection": round(lands), "steps": steps, "closeScale": None})
        if isinstance(wf.get("today"), dict):
            wf["today"].update({"target": round(by_today), "actual": round(now_all)})
