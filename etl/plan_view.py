"""The plan-based view of a live draw launch (docs/PLAN_MODEL.md).

The page's default reading puts a launch on the campaign clock: by today it
should be so far along, and the rest follows the shape past launches took.
This module reads the same launch off its comms plan instead, so the page's
targets relate to what goes out: every email and post is given what it should
bring (etl/plan_model.py's price list), each day's plan is the pieces felt on
it plus what an ordinary day brings with nothing going out (the baseline), and
what is still to come is the plan's remaining pieces at how the launch's
channels are responding. The build lays the result under `variants.plan`
(etl/build.py with_direct_spread), and the dashboard's switch shows it in
place of the clock's page; the clock's page stays the default.

Three steps, each launch:

  override   the plan's path for each channel group outside paid: what the
             plan as set expected by each day and by today, how the channel
             is running against it (its pull), and what is still to come.
             The build reads it where it would read the clock's curve, so
             every card on the page moves to the plan together, and paid
             (which keeps its own model) is sized against the plan's
             remaining demand.
  finish     the plan card (a row per phase, each with its emails and posts:
             what the plan expected, what it brought, what it should still
             bring), the baseline by channel, and the suggested actions
             valued by the same price list.
  credit     what came in is credited to the day a person entered or bought,
             not the day a draw's orders were booked: a draw books its orders
             in batches days after the entries, and read on those days they
             would land on days with nothing going out.

A launch qualifies when it is a draw in its window with a campaign code (its
own, or the Notion campaign's found by artist and launch day), a plan on file
and at least one email sent or planned. A launch that sells lines of work is
read on its combined page; each line's own page keeps the clock. Anything else
keeps the clock's page alone, and override() says why. Only pandas and numpy,
as the build needs.
"""
from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd

import plan_changes
import plan_model as P

PHASES = ["Early access", "Announce", "Sustain", "Last chance"]
BASELINE, PAID = "Baseline", "Paid"
# the page's channel groups outside paid, and the families of piece that act on each
FAMILIES = {"aa_email": P.EMAIL_COLS,
            "aa_social": ["pl_aa_post", "pl_aa_story", "pl_aa_social_other"],
            "referral_artist": ["pl_artist_post", "pl_artist_story", "pl_artist_other"],
            "organic_search": [],
            "direct_other": ["pl_partner"]}
GROUP_WORD = {"aa_email": "Email", "aa_social": "Avant Arte social", "referral_artist": "Artist", "organic_search": "Search", "direct_other": "Other"}
GROUP_WHO = {"aa_email": "email", "aa_social": "aa", "referral_artist": "artist", "organic_search": "search", "direct_other": "other"}
KIND_PHASE = {"early_access": "Early access", "insiders": "Early access", "announce": "Announce", "sustain": "Sustain", "other": "Sustain", "last_chance": "Last chance"}
KIND_COL = {"early_access": "em_early_access", "insiders": "em_early_access", "announce": "em_announce", "sustain": "em_sustain", "last_chance": "em_last_chance", "other": "em_other"}

MIN_PLAN_ROWS = 3          # a plan is on file when it has this many emails and posts not dropped
MIN_SEEN = 10.0            # the page's units against the study's are read once the launch has this many of the study's
CONV_BAND = (0.7, 1.5)     # ... and held within this
MIN_EXPECTED = 5.0         # a channel's own pull is read once the plan expected this many units of it by today
PULL_BAND = (0.3, 2.0)     # how far a channel may run from its plan and still be read as running so
OWN_LAUNCHES = 3           # the artist's last launches a new plan is sized on
MIN_OWN = 2                # ... when the artist has at least this many
MIN_BASKET = 3             # else the basket's launches, when this many have a size on file
SHORT_TOLERANCE = 0.03     # landing within 3% of the target counts as on course (as etl/plan_changes.py)
SHOWN = 4                  # suggested actions shown before the rest fold under "more"
FULL_LIST_DAYS = 120       # the full list is the widest send of these last days
WIDE_SEND = 20000          # a send to at least this many is a wide one (its unsubscribes are read for the rate)
UNSUB_RATE = 0.004         # the unsubscribes a wide send costs, when the feed has too few wide sends to say
MID_LEAD_DAYS = 3          # a piece added mid-campaign goes this many days out
MIN_DAYS_LEFT = 3          # ... and is not offered with fewer days left than this
POST_BAND = (0.6, 1.4)     # the range on a post's value: the price list is rough

_CTX: dict | None = None


def context(reload: bool = False) -> dict | None:
    """What every launch's plan view reads, loaded once: the price list, the
    Notion plan and the HubSpot emails with their audiences. None when any is
    missing (a fresh checkout, a feed never pulled): no plan view is built and
    every page keeps the clock's alone."""
    global _CTX
    if _CTX is not None and not reload:
        return _CTX or None
    prices, comms, aud = P.load_prices(), P.load_comms(), P.load_audiences()
    ok = bool(prices) and not comms.empty and aud is not None and not aud.empty and "fade_email" in (prices or {}) and bool((prices or {}).get("split"))
    _CTX = {"prices": prices, "comms": comms, "aud": aud, "campaigns": P.load_campaigns()} if ok else {}
    return _CTX or None


# ---------------------------------------------------------------- small readings
def _ts(v):
    try:
        t = pd.Timestamp(str(v)[:10])
        return None if pd.isna(t) else t
    except (TypeError, ValueError):
        return None


def _day_word(d) -> str:
    d = pd.Timestamp(d)
    return f"{d.day} {d.strftime('%b')}"


def _people(n: float) -> str:
    return f"{round(n / 1000):,}k" if n >= WIDE_SEND else f"{int(round(n)):,}"


_KIND_WORDS = re.compile(r"(?i)\b(early|exclusive|priority)[\s/]*access\b|\bearly\b|\bexclusive\b|\bannouncement\b|\bannounce\b|\blast\s*chance\b|\bsustain\b"
                         r"|\bprivate\s*room\b|\((LE|TL|TLC)\)|\binsiders?\b|\bemail\b|\bclone\b|\bfor\b|\bto\b")


def audience_words(name: object) -> str:
    """The audience a send's name gives it, if any: what is left of the name
    after its date, code and kind ("... - Early Access (LE) (Artist & Editions)"
    is "Artist and Editions"; "... - Announcement (LE)" has none)."""
    s = str(name or "")
    tail = s.split(" - ", 1)[1] if " - " in s else ""
    tail = _KIND_WORDS.sub(" ", tail).replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[()\[\]/]", " ", tail)).strip(" -:,.")


def email_label(name: object, kind: str, delivered: float) -> str:
    words = audience_words(name)
    if words:
        return f"Email to {_people(delivered)} ({words})"
    return f"Email to {_people(delivered)} {'insiders' if kind == 'insiders' else 'people'}"


def phase_of(row, announce, days: int) -> str:
    """The phase a plan row sits in: the one Notion gives it, else by its day."""
    ph = str(row.get("phase") or "")
    for k, m in (("1", PHASES[0]), ("2", PHASES[1]), ("3", PHASES[2]), ("4", PHASES[3])):
        if ph.startswith(k):
            return m
    t = int((pd.Timestamp(row["date"]) - announce).days)
    return PHASES[0] if t < 0 else PHASES[1] if t <= 1 else PHASES[3] if t >= days - 2 else PHASES[2]


def start_level(prices: dict, artist: str, announce, members: list[str] | None = None) -> dict:
    """How big a quiet day is for a launch before it has results of its own, in
    the study's units: the artist's own last launches when there are enough,
    else the launches the page is benchmarked on, else every launch. The range
    is the weakest and strongest of those read (the middle half, off every launch)."""
    rows = [r for r in (prices.get("quiet") or []) if str(r.get("close") or "") < str(pd.Timestamp(announce).date()) and float(r.get("quiet") or 0) > 0]
    own = [float(r["quiet"]) for r in rows if r.get("artist") == artist][-OWN_LAUNCHES:]
    if len(own) >= MIN_OWN:
        return {"level": float(np.median(own)), "range": (min(own), max(own)), "basis": "artist", "n": len(own)}
    names = set(members or [])
    near = [float(r["quiet"]) for r in rows if r.get("name") in names]
    if len(near) >= MIN_BASKET:
        return {"level": float(np.median(near)), "range": (float(np.quantile(near, 0.25)), float(np.quantile(near, 0.75))), "basis": "basket", "n": len(near)}
    every = [float(r["quiet"]) for r in rows] or [1.0]
    return {"level": float(np.median(every)), "range": (float(np.quantile(every, 0.25)), float(np.quantile(every, 0.75))), "basis": "all", "n": len(every)}


def entry_days(at: pd.DataFrame, name: str, days: pd.DatetimeIndex, group_of: dict) -> dict:
    """A release's demand by the day a person entered or bought, for each of
    the page's channel groups: eligible entry units at the entry rate plus the
    private room's units, which is what the price list is fitted on."""
    out = {}
    if at is None or not len(at) or not name:
        return out
    g = at[at["simple_release_name"] == name]
    if not len(g):
        return out
    grp = g["channel"].astype(str).map(group_of)
    day = pd.to_datetime(g["event_date"]).dt.normalize()
    y = P.ENTRY_RATE * pd.to_numeric(g["Draw_Entries_Eligible_Units"], errors="coerce").fillna(0.0) + pd.to_numeric(g["Product_Units_Private_Room"], errors="coerce").fillna(0.0)
    tab = y.groupby([grp, day]).sum()
    for key in tab.index.get_level_values(0).unique():
        out[str(key)] = tab.loc[key].reindex(days).fillna(0.0).to_numpy(dtype=float)
    return out


# a draw launch's plan card: a row per phase, a plan row in the phase Notion gives it (else by its day), an email
# in the phase of its kind. A timed launch's signups have their own (etl/tl_plan.py SPEC)
DRAW = {"phases": PHASES, "row_phase": lambda r, ann, days: phase_of(r, ann, days), "send_phase": lambda s, ann, days: KIND_PHASE.get(s["kind"], PHASES[2]),
        "planned_email": lambda name, kind: kind != "after"}


# ---------------------------------------------------------------- the override: the plan's path, channel by channel
def override(page: dict, at: pd.DataFrame, group_of: dict, ctx: dict | None, spec: dict | None = None, entered: dict | None = None) -> dict | None:
    """The plan's path for one launch. `page` is the launch's page with Direct
    shared over the other channels (the dashboard's default view), which is
    the view the plan is read in. Returns {"groups": what the build reads per
    channel group, "meta": the plan's level and how the launch runs against
    it, "work": what finish() needs to lay the plan card out}; None for a page
    the view is not for (a closed launch, one line's own page, and a timed
    launch unless etl/tl_plan.py asks with its own `spec`); and {"skip": why}
    for a live launch that could have had one. `entered(days)` stands in for
    the funnel's reading of what came in by day and channel (a timed launch's
    signups, from its own feed)."""
    if not ctx or not isinstance(page, dict):
        return None
    if (page.get("type") == "TL" and spec is None) or page.get("upcoming") or page.get("catalogue") or page.get("complete") or page.get("line"):
        return None
    spec = spec or DRAW
    phases = spec["phases"]
    pr = ctx["prices"]
    ann, close, today = _ts(page.get("windowStart")), _ts(page.get("windowEnd")), _ts(page.get("asOf"))
    code, name = page.get("campaignCode"), page.get("releaseName")
    target = float(((page.get("hero") or {}).get("target")) or 0.0)
    chan = {c["key"]: c for c in page.get("channels") or []}
    groups = [g for g in FAMILIES if g in chan and g in (pr.get("split") or {})]
    if ann is None or close is None or today is None or close <= ann or today > close:
        return None
    if target <= 0:
        return {"skip": "no targets set"}
    if len(groups) < 3:
        return {"skip": "too few channels on the page"}
    L = int((close - ann).days)
    start = ann - pd.Timedelta(days=P.LEAD_DAYS)
    if today < start:
        return None
    # the Notion campaign the plan is filed under: the page's own code when the plan has rows under it in the
    # launch's days, else the campaign that answers to the artist by its code and launch day, else by its name and
    # the days it ran (plan_model.plan_campaign): a launch the funnel could not give a code still has its plan in
    # Notion, a page's guessed code can be the artist's last launch's, and a Notion campaign can have no code
    own = code
    code, how = P.plan_campaign(page.get("artist"), start, close, ctx["comms"], ctx.get("campaigns"), own=own)
    if not code:
        return {"skip": (f"no plan on file in Notion under {own}, and " if own else "no campaign code, and ") + how}
    coef, rel = pr["clicks"]["coef"], pr.get("reliability") or P.DEFAULT_RELIABILITY
    frac = float(page.get("asOfFraction") or 1.0)
    comms, aud = ctx["comms"], ctx["aud"]

    plan = comms[(comms["campaign_code"] == code) & (comms["date"] >= start) & (comms["date"] <= close)].copy()
    # one launch tagged two ways (the plan under Notion's code, the sends under the page's own) keeps both's emails;
    # one with no code in its emails' names has them found by the plan's days and the artist's name
    sends = P.launch_sends(aud, [code, own], start, close, artist=page.get("artist"), plan=plan)
    plan = plan[plan["family"].isin(P.POST_FAMILIES + ["email"])]
    live = plan[~plan["status"].isin(P.DROPPED)]
    emails_planned = live[(live["family"] == "email") & (live["date"] >= today)]
    if len(live) < MIN_PLAN_ROWS:
        return {"skip": f"no plan on file in Notion under {code}"}
    if sends.empty and emails_planned.empty:
        return {"skip": f"no email sent or planned under {code}"}
    plan["moment"] = [spec["row_phase"](r, ann, L) for _, r in plan.iterrows()]
    # the emails still to come: the plan's email rows from today on that no send has answered yet, each at the
    # usual audience for its kind (only HubSpot knows a send's audience, and only once it is set)
    usual = pr.get("usual_audience") or {}
    sent_on = {(pd.Timestamp(d), k) for d, k in zip(sends["day"], sends["kind"])} if len(sends) else set()
    planned = []
    for _, r in emails_planned.iterrows():
        kind = P.email_kind("x - " + str(r["name"]))
        if not spec["planned_email"](str(r["name"]), kind) or (pd.Timestamp(r["date"]), kind) in sent_on:
            continue
        planned.append({"day": pd.Timestamp(r["date"]), "kind": kind, "delivered": float(usual.get(kind) or usual.get("other") or 5000.0), "name": str(r["name"]), "planned": True})
    sent = [{"day": pd.Timestamp(s["day"]), "kind": s["kind"], "delivered": float(s["delivered"]), "name": str(s["name"]), "clicked": float(s["clicked"]), "planned": False}
            for _, s in sends.iterrows()]
    all_sends = pd.DataFrame(sent + planned, columns=["day", "kind", "delivered", "name", "clicked", "planned"])
    all_sends["moment"] = [spec["send_phase"](s, ann, L) for _, s in all_sends.iterrows()] if len(all_sends) else []
    posts = plan[plan["family"].isin(P.POST_FAMILIES)]
    piece_days = list(posts["date"]) + list(all_sends["day"])
    first = min(piece_days) if piece_days else ann

    ref = P.launch_days(ann, close, None, None, coef)
    t = ref["t"].to_numpy()
    days = pd.DatetimeIndex(ref["date"])
    iso = [d.strftime("%Y-%m-%d") for d in days]
    i_now = min(max(int((today - days[0]).days), 0), len(days) - 1)
    base = P.base_values(ref, pr)
    split = {g: float(pr["split"][g]) for g in groups}
    norm = sum(split.values()) or 1.0
    split = {g: v / norm for g, v in split.items()}

    def lay(sm, pm, at_start: bool) -> pd.DataFrame:
        """The launch's days with these sends and plan rows on them: as the plan was set (every row written by
        the day the first piece went out, each as planned), or as it stands today."""
        if at_start:
            rows = None
            if pm is not None and len(pm):
                rows = pm[pd.to_datetime(pm["created"], errors="coerce") <= first].copy()
                rows["status"] = "Scheduled"
            return P.launch_days(ann, close, sm, rows, coef, as_of=first - pd.Timedelta(days=1), reliability=rel)
        return P.launch_days(ann, close, sm, pm, coef, as_of=today, reliability=rel)

    def values(sm, pm, at_start: bool) -> dict:
        D = lay(sm, pm, at_start)
        return {g: P.piece_values(D, pr, FAMILIES[g]) for g in groups}

    val0, val1 = {}, {}
    for m in phases:
        pm, sm = posts[posts["moment"] == m], all_sends[all_sends["moment"] == m]
        val0[m], val1[m] = values(sm, pm, True), values(sm, pm, False)
    val0[BASELINE] = {g: split[g] * base for g in groups}
    val1[BASELINE] = val0[BASELINE]
    rows = phases + [BASELINE]

    # what has come in, by channel and by the day a person entered or bought, each channel scaled to the page's own
    # count for it so the plan card adds up to every other card; a channel the entry feed has nothing for keeps
    # the page's own days
    now = {g: float(chan[g].get("now") or 0.0) for g in groups}
    now_all = sum(now.values())
    dates = [r["date"] for r in (chan[groups[0]].get("daily") or [])]
    entered = entered(days) if callable(entered) else entry_days(at, name, days, group_of)
    seen_study = float(sum(entered[g][: i_now + 1].sum() for g in groups if g in entered))
    inc = {}
    for g in groups:
        e = entered.get(g)
        e = e.copy() if e is not None else np.zeros(len(days))
        e[i_now + 1:] = 0.0
        if e.sum() > 0:
            inc[g] = e * (now[g] / e.sum())
            continue
        x, prev = np.zeros(len(days)), 0.0
        for r in chan[g].get("daily") or []:
            if r.get("actual") is None:
                break
            d = _ts(r["date"])
            if d is not None:
                x[min(max(int((d - days[0]).days), 0), len(days) - 1)] += float(r["actual"]) - prev
            prev = float(r["actual"])
        inc[g] = x

    lv = start_level(pr, str(page.get("artist") or ""), ann, [m.get("name") for m in ((page.get("benchmark") or {}).get("members") or []) if isinstance(m, dict)])
    conv = float(np.clip(now_all / seen_study, *CONV_BAND)) if seen_study >= MIN_SEEN else 1.0
    level = lv["level"] * conv

    def total(vals: dict, g: str) -> np.ndarray:
        return sum(vals[m][g] for m in rows)

    exp = {}
    for g in groups:
        cum = level * np.cumsum(total(val0, g))
        exp[g] = float((cum[i_now - 1] if i_now > 0 else 0.0) + frac * (cum[i_now] - (cum[i_now - 1] if i_now > 0 else 0.0)))
    exp_all = sum(exp.values())
    pull_all = float(np.clip(now_all / exp_all, *PULL_BAND)) if exp_all >= MIN_EXPECTED else 1.0
    pull, out = {}, {}
    for g in groups:
        own = (now[g] / exp[g]) if exp[g] >= MIN_EXPECTED else pull_all
        pull[g] = float(np.clip(0.5 * own + 0.5 * pull_all, *PULL_BAND))
        cum = level * np.cumsum(total(val0, g))
        rem = total(val1, g).copy()
        rem[:i_now] = 0.0
        rem[i_now] *= (1.0 - frac)
        fut = pull[g] * level * float(rem.sum())
        share = np.cumsum(rem) / rem.sum() if rem.sum() > 0 else np.ones(len(rem))

        def at_day(arr, d):
            ts = _ts(d)
            return float(arr[min(max(int((ts - days[0]).days), 0), len(arr) - 1)]) if ts is not None else float(arr[-1])
        out[g] = {"plan": {d: round(at_day(cum, d), 2) for d in dates}, "exp": round(exp[g], 2), "fut": round(fut, 2), "pull": round(pull[g], 3),
                  "plan_total": round(float(cum[-1]), 2), "share": {d: round(at_day(share, d), 4) for d in dates if d >= str(today.date())}}
    plan_total = sum(v["plan_total"] for v in out.values())
    meta = {"code": code, "level": level, "levelStudy": lv["level"], "levelBasis": lv["basis"], "levelN": lv["n"], "conv": conv, "pullAll": pull_all,
            "organicPlan": plan_total, "organicRange": [plan_total * lv["range"][0] / lv["level"], plan_total * lv["range"][1] / lv["level"]] if lv["level"] > 0 else [plan_total, plan_total],
            "organicToCome": sum(v["fut"] for v in out.values()), "firstPiece": str(pd.Timestamp(first).date())}
    work = {"pr": pr, "coef": coef, "rel": rel, "ann": ann, "close": close, "today": today, "frac": frac, "L": L, "days": days, "iso": iso, "i_now": i_now, "t": t,
            "groups": groups, "split": split, "base": base, "val0": val0, "val1": val1, "rows": rows, "inc": inc, "level": level, "pull": pull, "pull_all": pull_all,
            "sends": all_sends, "posts": posts, "plan": plan, "first": first, "lay": lay, "aud": aud, "target": target, "level_range": lv["range"], "level_study": lv["level"],
            "phases": phases}
    return {"groups": out, "meta": meta, "work": work}


# ---------------------------------------------------------------- the plan card
def _share_out(w: dict, weight) -> float:
    """What came in, by channel and by the day it was entered, shared by `weight(g, i)` over everything the plan
    puts on that channel that day."""
    got = 0.0
    for g in w["groups"]:
        x = w["inc"][g]
        for i in np.nonzero(x[: w["i_now"] + 1])[0]:
            tot = sum(w["val1"][m][g][i] for m in w["rows"])
            if tot > 0:
                got += float(x[i]) * float(weight(g, int(i))) / float(tot)
    return got


def _remaining(w: dict, vals: dict) -> float:
    rem = 0.0
    for g in w["groups"]:
        x = vals[g].copy()
        x[: w["i_now"]] = 0.0
        x[w["i_now"]] *= (1.0 - w["frac"])
        rem += w["pull"][g] * w["level"] * float(x.sum())
    return rem


def _post_groups(day_posts: list[dict]) -> list[tuple[str, list[dict], str]]:
    """A day's posts as the lines the card shows: the artist's, Avant Arte's and a partner's, each one line,
    named for what is in it and how many, and marked when every post in it was dropped."""
    def named(one: str, many: str, g: list[dict]) -> str:
        word = one if len(g) == 1 else f"{many} ({len(g)})"
        return word + (" (dropped)" if all(p.get("dropped") for p in g) else "")
    if day_posts and all(str(p["name"]).strip().lower() == "coming soon" for p in day_posts):
        return [(named("Coming soon story", "Coming soon stories", day_posts), day_posts, "aa")]
    ar = [p for p in day_posts if p["family"].startswith("artist")]
    aa = [p for p in day_posts if p["family"].startswith("aa_")]
    pa = [p for p in day_posts if p["family"] == "partner"]
    out = []
    if ar:
        fams = {p["family"] for p in ar}
        word = ("Artist's own email" if fams == {"artist_other"} else "Artist post and story" if fams == {"artist_post", "artist_story"} and len(ar) == 2
                else "Artist post" if fams == {"artist_post"} and len(ar) == 1 else "Artist story" if fams == {"artist_story"} and len(ar) == 1 else None)
        out.append((word + (" (dropped)" if all(p.get("dropped") for p in ar) else "") if word else named("Artist post", "Artist posts and stories", ar), ar, "artist"))
    if aa:
        posts = [p for p in aa if p["family"] == "aa_post"]
        many = "Avant Arte posts" if len(posts) == len(aa) else "Avant Arte stories" if not posts else "Avant Arte posts and stories"
        out.append((named("Avant Arte post" if posts else "Avant Arte story", many, aa), aa, "aa"))
    if pa:
        out.append((named("Partner post", "Partner posts", pa), pa, "other"))
    return out


def card_rows(w: dict) -> list[dict]:
    """A row per phase and one for the baseline: what the plan as set expected, what has come in, what should
    still come, and the pieces inside (an email a line, a day's posts a line per sender)."""
    level, groups = w["level"], w["groups"]

    def figures(v0: dict, v1: dict) -> dict:
        return {"expected": level * sum(float(v0[g].sum()) for g in groups),
                "in": _share_out(w, lambda g, i: v1[g][i]), "toCome": _remaining(w, v1)}

    def one(sm, pm) -> tuple[dict, dict]:
        return ({g: P.piece_values(w["lay"](sm, pm, True), w["pr"], FAMILIES[g]) for g in groups},
                {g: P.piece_values(w["lay"](sm, pm, False), w["pr"], FAMILIES[g]) for g in groups})

    rows = []
    for m in w.get("phases") or PHASES:
        row = {"moment": m, **figures(w["val0"][m], w["val1"][m])}
        sm, pm = w["sends"][w["sends"]["moment"] == m], w["posts"][w["posts"]["moment"] == m]
        lines, emails = [], []
        for _, s in sm.iterrows():
            v0, v1 = one(pd.DataFrame([s.to_dict()]), None)
            emails.append({"s": s, **figures(v0, v1)})
        # the emails that went out share what email brought in the phase by their own clicks: emails sent on
        # the same day are told apart by what each did, not by what each was expected to do
        went = [e for e in emails if not e["s"]["planned"]]
        clicks, came = sum(float(e["s"]["clicked"] or 0) for e in went), sum(e["in"] for e in went)
        for e in emails:
            s = e["s"]
            if s["planned"]:
                lines.append({"when": _day_word(s["day"]), "name": "Email, audience not set", "who": "email", "expected": e["expected"], "in": 0.0, "toCome": e["toCome"],
                              "_o": (s["day"], 0, -e["expected"])})
            else:
                lines.append({"when": _day_word(s["day"]), "name": email_label(s["name"], s["kind"], float(s["delivered"])), "who": "email", "expected": e["expected"],
                              "in": came * float(s["clicked"] or 0) / clicks if clicks > 0 else e["in"], "toCome": e["toCome"], "_o": (s["day"], 0, -e["expected"])})
        ps = []
        for _, r in pm.iterrows():
            v0, v1 = one(None, pd.DataFrame([r.to_dict()]))
            ps.append({"date": pd.Timestamp(r["date"]), "family": r["family"], "name": r["name"], "dropped": P.plan_state(r["status"], r["date"], w["today"]) == "dropped", **figures(v0, v1)})
        for d in sorted({p["date"] for p in ps}):
            for word, g, who in _post_groups([p for p in ps if p["date"] == d]):
                tot = {k: sum(p[k] for p in g) for k in ("expected", "in", "toCome")}
                if tot["expected"] < 0.05 and tot["in"] < 0.05 and tot["toCome"] < 0.05:
                    continue      # a piece the price list gives nothing, and nothing came of: no line
                lines.append({"when": _day_word(d), "name": word, "who": who, **tot, "_o": (d, 1, -tot["expected"])})
        lines.sort(key=lambda x: x["_o"])
        row["pieces"] = [{k: v for k, v in x.items() if k != "_o"} for x in lines]
        rows.append(row)
    base = {"moment": BASELINE, "note": "What an ordinary day brings with nothing going out, by channel", **figures(w["val0"][BASELINE], w["val1"][BASELINE]), "pieces": []}
    for g in groups:
        x = w["val1"][BASELINE][g].copy()
        x[: w["i_now"]] = 0.0
        x[w["i_now"]] *= (1.0 - w["frac"])
        base["pieces"].append({"when": "", "name": GROUP_WORD[g], "who": GROUP_WHO[g], "expected": level * float(w["val0"][BASELINE][g].sum()),
                               "in": _share_out(w, lambda gg, i, g=g: w["val1"][BASELINE][gg][i] if gg == g else 0.0), "toCome": w["pull"][g] * level * float(x.sum())})
    rows.append(base)
    return rows


# ---------------------------------------------------------------- the suggested actions, valued by the price list
def _whole(u: dict) -> dict | None:
    lo, hi = int(round(u["low"])), int(round(u["high"]))
    return {"low": min(lo, hi), "high": hi} if hi >= 1 else None


def changes(w: dict, page: dict) -> list[dict]:
    """What could be added to or changed in the plan from here, each with what it should bring: an email still
    to come sent wider, a sustain email, a post from the artist, Avant Arte or a partner, and the paid budget.
    A piece's value is the price list's, at this launch's level and at how its channel is responding."""
    pr, coef, ann, today, L = w["pr"], w["coef"], w["ann"], w["today"], w["L"]
    level, pull, pull_all = w["level"], w["pull"], w["pull_all"]
    days_left = int((w["close"] - today).days)
    pe, ps, pa = pull.get("aa_email", pull_all), pull.get("aa_social", pull_all), pull.get("referral_artist", pull_all)
    lo_m, hi_m = [float(np.exp(x)) for x in pr["clicks"]["spread"]]
    aud = w["aud"]
    recent = aud[aud["went"] & (aud["day"] >= today - pd.Timedelta(days=FULL_LIST_DAYS)) & (aud["day"] <= today)] if len(aud) else aud
    full = float(recent["delivered"].max()) if len(recent) else 0.0
    wide = recent[recent["delivered"] >= WIDE_SEND] if len(recent) else recent
    unsub = float((wide["unsubscribed"] / wide["delivered"]).median()) if len(wide) >= 3 else UNSUB_RATE
    usual = pr.get("usual_audience") or {}
    out = []

    def email_units(kind: str, n: float, t: int) -> float:
        return P.action_value(KIND_COL.get(kind, "em_other"), P.expected_clicks(kind, n, t, L, coef) / P.CLICKS_REF, pr)

    def clicks_at(kind: str, n: float, t: int) -> int:
        return int(round(P.expected_clicks(kind, n, t, L, coef, math.log(max(pe, 1e-6)))))

    def unsubs(n: float) -> str:
        return f"{round(n * unsub, -1):,.0f}"

    sends = w["sends"]
    to_come = sends[sends["planned"]] if len(sends) else sends
    if full >= WIDE_SEND:
        for _, s in to_come.iterrows():
            t, n0, kind = int((s["day"] - ann).days), float(s["delivered"]), s["kind"]
            title = {"last_chance": "Last chance email", "sustain": "Sustain email", "announce": "Announce email", "early_access": "Early access email"}.get(kind, "Email")
            q0 = email_units(kind, n0, t)
            mid = round(min(max(n0 * 3, 10000), full / 2), -3)
            for n, label in ((full, "Full list"), (mid, f"{int(mid):,}")):
                if n <= n0 * 1.5:
                    continue
                u = pe * level * (email_units(kind, n, t) - q0)
                out.append({"key": f"email.{kind}.{str(s['day'].date())}.{int(n)}", "kind": "change", "title": title, "from": f"{int(round(n0, -2)):,}", "to": label, "channel": "Email",
                            "date": str(s["day"].date()), "people": int(round(n)), "units": {"low": u * lo_m, "high": u * hi_m},
                            "reason": f"No audience is set yet, so the usual {int(round(n0, -2)):,} people are assumed. To {'the full list' if label == 'Full list' else label + ' people'} "
                                      f"it should bring about {clicks_at(kind, n, t):,} clicks, and about {unsubs(n)} unsubscribes."})
    t_mid = min(int((today - ann).days) + MID_LEAD_DAYS, L - 4)
    if days_left >= MIN_DAYS_LEFT and t_mid > int((today - ann).days):
        mid_day = ann + pd.Timedelta(days=t_mid)
        has_mid = len(to_come) and bool(((to_come["day"] > today) & (to_come["day"] <= w["close"] - pd.Timedelta(days=3))).any())
        if not has_mid and full >= WIDE_SEND:
            small = round(float(usual.get("sustain") or 10000.0), -3)
            for n, label in ((full, "Sustain email to the full list"), (small, f"Sustain email to {int(small):,}")):
                if n <= 0 or (label.endswith("full list") is False and small >= full / 2):
                    continue
                u = pe * level * email_units("sustain", n, t_mid)
                out.append({"key": f"email.sustain.add.{int(n)}", "kind": "add", "title": label, "note": "Not in the plan", "channel": "Email", "date": str(mid_day.date()),
                            "people": int(round(n)), "units": {"low": u * lo_m, "high": u * hi_m},
                            "reason": f"About {clicks_at('sustain', n, t_mid):,} clicks at how this launch's emails are running, and about {unsubs(n)} unsubscribes."})
        running = {"Artist": pa, "AA Social": ps, "Partner": pull_all}
        for col, label, chn in (("pl_artist_post", "Artist IG post", "Artist"), ("pl_aa_post", "AA IG post", "AA Social"), ("pl_partner", "Partner post", "Partner")):
            u = running[chn] * level * P.action_value(col, 1.0, pr)
            word = "more than" if running[chn] > 1.1 else "less than" if running[chn] < 0.9 else "about what"
            who = {"Artist": "The artist's channels are", "AA Social": "Avant Arte's posts are", "Partner": "The launch is"}[chn]
            out.append({"key": f"post.{col}", "kind": "add", "title": label, "note": "Not in the plan", "channel": chn, "date": str(mid_day.date()),
                        "units": {"low": u * POST_BAND[0], "high": u * POST_BAND[1]},
                        "reason": f"{who} bringing {word} the plan expected so far." + (" Partner posts are the least certain piece: few past launches ran one." if chn == "Partner" else "")})
    # the paid budget: the Spend levels card's own reading for tomorrow (etl/plan_changes.py paid_changes). One for
    # the campaign, which on this page is sized against what the plan's comms leave to do; on a launch that runs an
    # ad set per line of work, one per line off the line's own card, as the clock's page gives them
    per_line = w.get("line_pages") or {}
    by_line = bool(page.get("lines")) and bool(per_line)
    try:
        paid = plan_changes.paid_changes({"lines": page.get("lines"), "variants": {"lines": per_line}} if by_line else {"paid": page.get("paid")},
                                         today.date(), w["close"].date())
    except Exception:  # noqa: BLE001 - a paid block the card cannot read is no suggestion, never no page
        paid = []
    for c in paid:
        if not by_line:
            c["reason"] = f"The plan's comms should bring about {round(w['organic_to_come'])} more by the close. " + str(c.get("reason") or "")
        out.append(c)
    return out


# ---------------------------------------------------------------- finish: the plan-built page made whole
def finish(page: dict, ov: dict, line_pages: dict | None = None) -> None:
    """Lay the plan card, the suggested actions and the headline figures onto a page the build has just made
    on the plan's path (`ov` is override()'s answer for it). The page reads "as it stands": where the plan
    lands with nothing changed, paid held at today's spend; what a change would add is the suggested actions'.
    `line_pages` are the pages of the launch's lines of work where it sells more than one (the build's
    variants.lines): a launch that runs an ad set per line has its paid suggestions read off each line's own."""
    w = ov["work"]
    w["organic_to_come"] = ov["meta"]["organicToCome"]
    w["line_pages"] = line_pages or {}
    chan = {c["key"]: c for c in page.get("channels") or []}
    paid = page.get("paid") or {}
    target = float(((page.get("hero") or {}).get("target")) or w["target"])
    # the most the launch can sell: its edition, which is the target unless a lower sell-through is aimed for
    ceiling = max(float(((page.get("edition") or {}).get("total")) or 0.0), target)
    today_iso = str(w["today"].date())
    rows = card_rows(w)

    pc = chan.get("paid")
    if pc is not None:
        held = float(((paid.get("ifContinued") or {}).get("unitProjected")) or pc.get("proj") or 0.0)
        was, now_p = float(pc.get("proj") or 0.0), float(pc.get("now") or 0.0)
        if was - now_p > 1e-9 and abs(held - was) > 1e-9:
            for r in pc.get("daily") or []:
                if r.get("proj") is not None:
                    r["proj"] = round(now_p + (float(r["proj"]) - now_p) * (held - now_p) / (was - now_p), 2)
        pc["proj"] = round(held, 1)
        row = {"moment": PAID, "expected": float(pc.get("target") or 0.0), "in": now_p, "toCome": max(held - now_p, 0.0), "pieces": []}
        lvl = paid.get("levels") or {}
        if paid.get("spendToDate") is not None and lvl.get("today") is not None:
            row["pieces"] = [{"when": "", "name": f"€{round(float(paid['spendToDate'])):,} spent so far", "who": "paid", "expected": min(float(pc.get("exp") or 0.0), row["expected"]), "in": now_p, "toCome": 0.0},
                             {"when": "", "name": f"€{round(float(lvl['today'])):,} a day to the close", "who": "paid", "expected": max(row["expected"] - float(pc.get("exp") or 0.0), 0.0), "in": 0.0, "toCome": row["toCome"]}]
        rows.append(row)
    for r in rows:
        r["lands"] = r["in"] + r["toCome"]
        for k in ("expected", "in", "toCome", "lands"):
            r[k] = round(float(r[k]), 2)
        for x in r["pieces"]:
            for k in ("expected", "in", "toCome"):
                x[k] = round(float(x[k]), 2)
    tot = {k: sum(r[k] for r in rows) for k in ("expected", "in", "toCome", "lands")}
    started = tot["in"] > 0 or w["today"] >= pd.Timestamp(w["first"])
    demand = tot["lands"] if started else tot["expected"]      # where the plan lands: demand, which a strong plan takes past the edition
    lands = min(demand, ceiling)                                  # ... and what the page's other cards can count: the edition is the ceiling
    by_today = sum(float(c.get("exp") or 0.0) for c in page.get("channels") or [])
    hero = page.setdefault("hero", {})
    now_all = float(hero.get("now") or tot["in"])
    hero.update({"projected": round(lands), "expectedToday": round(by_today), "delta": round(now_all - by_today),
                 "statusPct": round(now_all / by_today - 1.0, 4) if by_today > 0 else 0.0, "ok": lands >= target * (1 - SHORT_TOLERANCE)})
    lo, hi = ov["meta"]["organicRange"]
    paid_plan = float((pc or {}).get("target") or 0.0)
    lvl = paid.get("levels") or {}
    basis = {"artist": f"the artist's last {ov['meta']['levelN']} launches", "basket": f"the {ov['meta']['levelN']} launches the page is benchmarked on", "all": "every past draw launch"}[ov["meta"]["levelBasis"]]
    page["method"] = "plan"
    page["plan"] = {"state": "live" if started else "start", "target": target, "expected": round(tot["expected"], 2), "in": round(tot["in"], 2), "toCome": round(tot["toCome"], 2),
                    "lands": round(demand, 2), "byToday": round(by_today, 2), "range": [round(lo + paid_plan, 1), round(hi + paid_plan, 1)],
                    "landsRecommended": (paid.get("atRecommended") or {}).get("sellThrough", {}).get("units"), "paidToday": lvl.get("today"), "paidRecommended": lvl.get("recommended"),
                    "rows": rows, "pull": round(ov["meta"]["pullAll"], 3), "level": round(ov["meta"]["level"], 3), "levelBasis": ov["meta"]["levelBasis"],
                    "notes": [f"What each piece is expected to bring is sized on {basis}.", "Still to come follows how each channel is responding so far.",
                              "What came in is credited to the day people entered or bought."]
                             + ([f"Paid is held at today's €{round(float(lvl['today'])):,} a day."] if lvl.get("today") is not None else [])}

    cf = page.get("closeForecast")
    if isinstance(cf, dict) and cf.get("units"):
        # the Sell-through at close card: the plan's landing as a share of the edition, as the clock's page reads it,
        # with the range of the build's own reading at today's paid moved with it. That reading (today's paid held)
        # is the card's default, so it is given the plan's figures too and the card agrees with the plan card
        sc = cf.get("scenarios") if isinstance(cf.get("scenarios"), dict) else {}
        held_sc = sc.get("current") if isinstance(sc.get("current"), dict) and sc["current"].get("units") else None
        src = held_sc or cf
        ed = float(cf.get("edition") or 0.0) or ceiling
        ratio = lands / max(float(src["units"]), 1e-9)
        lo = min(float(src.get("lo") or lands) * ratio, lands)
        hi = max(min(float(src.get("hi") or lands) * ratio, ed), lands)
        read = {"units": round(lands, 1), "pct": round(lands / ed, 4), "lo": round(lo, 1), "hi": round(hi, 1), "pctLo": round(lo / ed, 4), "pctHi": round(hi / ed, 4),
                "confidence": "medium", "confidenceWhy": "what is still to come is read from the plan's remaining pieces, each a range",
                "built": {**(cf.get("built") or {}), "organic": round(ov["meta"]["organicToCome"], 1), **({"paid": round(max(float(pc.get("proj") or 0) - float(pc.get("now") or 0), 0.0), 1)} if pc else {})}}
        if lvl.get("today") is not None:
            read["paid"] = {"daily": lvl["today"], "today": lvl["today"], "change": 0.0, "direction": "hold", "spendAtClose": (paid.get("ifContinued") or {}).get("spendProjectedTotal"),
                            "budget": paid.get("spendBudget"), "rule": "The forecast holds today's paid spend to the close, so it shows where the plan lands with nothing changed."}
        cf.update(read)
        if held_sc is not None:
            sc["current"] = {**held_sc, **read}
    wf = page.get("waterfall")
    if isinstance(wf, dict):
        steps = [{"key": "plan", "label": "The plan against the target", "value": round(tot["expected"] - target)}]
        steps += [{"key": r["moment"], "label": r["moment"], "value": round(r["lands"] - r["expected"])} for r in rows]
        steps[-1]["value"] += round(lands - target) - sum(s["value"] for s in steps)      # whole units that add up, the rounding left on the last row
        wf.update({"target": target, "projection": round(lands), "steps": steps, "closeScale": None})
        if isinstance(wf.get("today"), dict):
            wf["today"].update({"target": round(by_today), "actual": round(now_all)})

    found = [dict(c, units=_whole(c["units"]) if c.get("units") else None, lever=c.get("lever") or "plan") for c in (changes(w, page) if started else [])]
    found = [c for c in found if c["units"] or c.get("channel") == "Paid"]
    found.sort(key=lambda c: -(((c["units"]["low"] + c["units"]["high"]) / 2) if c["units"] else 0))
    plan = w["plan"]
    listed = plan[~plan["status"].isin(P.DROPPED)].sort_values("date")
    to_come = listed[listed["date"] >= w["today"]]
    word = {"email": "Email"}
    page["planChanges"] = {"asOf": today_iso, "daysLeft": int((w["close"] - w["today"]).days), "status": "short" if lands < target * (1 - SHORT_TOLERANCE) else "on_course",
                           "planVisible": True, "planDone": int(((listed["date"] < w["today"]) & listed["status"].isin(P.WENT)).sum()),
                           "planToCome": [{"date": str(r["date"].date()), "channel": word.get(r["family"], "Artist" if str(r["family"]).startswith("artist") else "Partner" if r["family"] == "partner" else "AA Social"),
                                           "title": f"{r['name']} · {r['channel']}"} for _, r in to_come.iterrows()],
                           "cohort": None, "changes": found[:SHOWN], "more": found[SHOWN:]}
