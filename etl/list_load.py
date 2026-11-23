"""The list's load: how much email the list is getting, and what that leaves room for.

The Suggested actions card proposes emails launch by launch, and on its own page an email to the whole list
always looks like the biggest win: the page counts what the email brings and nothing of what the list has
already had. Nothing in the email history prices that cost (a busy week shows in no send's clicks; the
response of the list has halved in two years, and the list has more than doubled, and the two cannot be told
apart), so it is held here as a rule the team sets, not a figure the model works out:

  a general send   an email to half the list or more (GENERAL_SHARE)
  the load         emails a person a week over four weeks: the week a suggestion falls in and the three before
                   it. What has gone is HubSpot's count of deliveries; what is still to come is the Notion
                   plan's, every launch's, read as described under planned_general
  the scale        normal up to NORMAL_TO, busy up to BUSY_TO, very busy past it. A normal week takes a general
                   send from any launch that is short; a busy one from the launch with the most at stake that
                   week alone (units short of the target times the price of a unit); a very busy one from none
  the cap          CAP general sends in a week, gone and planned together, whatever the scale says

settle() lays that over every live launch's suggestions at once, since the ranking is across launches. A
general send it lets through says which of the week's it would be; one it does not is moved to the card's
`held` list with the reason in a line, where the reader can still see what it was worth. A launch that is on
course is offered no general send. Emails to fewer than half the list are left exactly as they were.

The four figures are the team's to change (CAP, NORMAL_TO, BUSY_TO, GENERAL_SHARE). Pure functions over the
two feeds and the pages' own blocks, so tests/test_list_load.py holds each rule to a hand-built case.
"""
from __future__ import annotations

import re

import pandas as pd

import plan_model as P

# ---------------------------------------------------------------- the rule
CAP = 3                    # general sends in a week, gone and planned together
NORMAL_TO = 2.0            # emails a person a week over four weeks: up to this the list is at its usual load
BUSY_TO = 2.5              # ... up to this it is busy, and past it very busy
GENERAL_SHARE = 0.5        # an email to this share of the list or more is a general send
# ---------------------------------------------------------------- the reading
FULL_LIST_DAYS = 120       # the list is the widest send of these last days (as etl/plan_view.py)
MIN_LIST = 20000           # under this there is no list to speak of, and the card is left as it was
PLANNED_SHARE = 0.7        # a planned general send counts as this much email a person: three in four of the plan's went as one
                           # (several launches often share a bundle), to nearly the whole list
BASE_WEEKS = 12            # the email a week brings beside its general sends is the median of these last weeks
BASE_DEFAULT = 0.3         # ... or this much a person, with too little history to say
LOAD_WEEKS = 4
WEEKS_AHEAD = 8            # how far past today a suggestion's week is read

_NOT_MARKETING = {"TRNS", "AUT", "TEST"}
_FLOW = re.compile(r"\bflow\b", re.I)
_NON_FLOW = re.compile(r"\bnon[\s-]?flow\b", re.I)
_NOW_LIVE = re.compile(r"\bnow\s*live\b", re.I)
_DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def week_of(d) -> pd.Timestamp:
    """The Monday of a day's week."""
    d = pd.Timestamp(d).normalize()
    return d - pd.Timedelta(days=int(d.weekday()))


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def marketing(aud: pd.DataFrame) -> pd.DataFrame:
    """The emails that went to customers as marketing: not the operational ones, and not a test's handful."""
    if aud is None or not len(aud):
        return pd.DataFrame(columns=["name", "day", "delivered", "type", "kind", "code", "campaign"])
    return aud[aud["went"] & (aud["delivered"] >= P.MIN_DELIVERED) & ~aud["type"].isin(list(_NOT_MARKETING))]


def list_size(sent: pd.DataFrame, today) -> float:
    """The list: the widest marketing send of the FULL_LIST_DAYS to today."""
    today = pd.Timestamp(today).normalize()
    w = sent[(sent["day"] <= today) & (sent["day"] >= today - pd.Timedelta(days=FULL_LIST_DAYS))] if len(sent) else sent
    return float(w["delivered"].max()) if len(w) else 0.0


def send_label(release: object, name: object) -> str:
    """A planned send as the card names it: the artist and what the email is."""
    who = P.campaign_artist(release) or str(release or "").strip() or "A launch"
    n = str(name or "")
    return f"{who} {'now live email' if _NOW_LIVE.search(n) else 'announcement' if P.email_kind('x - ' + n) == 'announce' else 'email'}"


def planned_general(comms: pd.DataFrame, sent: pd.DataFrame, today) -> pd.DataFrame:
    """The general sends still to come, off every launch's plan in Notion: {date, campaign_code, label}.

    The plan names an email and not who it goes to, so this is a reading by kind: a launch's announcement and
    a timed launch's email to the people outside its flow ("Non-flow") go to the list; an early access, a
    sustain, a last chance, a flow's own email and a survey do not. One a launch a week: no launch has sent the
    list two in a week. A row dated today counts until an email of its launch has gone today. What has gone is
    never read here: its audience is HubSpot's to say. Read against what went, the plan runs about a quarter
    high (launches that share a bundle each plan their own announcement), which PLANNED_SHARE allows for in
    the load; the count is the plan's own, and the card names the sends so a reader can see a pair that will
    go as one."""
    out = pd.DataFrame(columns=["date", "campaign_code", "label"])
    if comms is None or not len(comms):
        return out
    today = pd.Timestamp(today).normalize()
    c = comms[(comms["family"] == "email") & ~comms["status"].isin(list(P.DROPPED)) & (comms["date"] >= today)]
    rows, seen = [], set()
    gone_today = sent[sent["day"] == today] if len(sent) else sent
    for _, r in c.sort_values("date").iterrows():
        name, code = str(r["name"]), str(r["campaign_code"])
        kind = P.email_kind("x - " + name)
        general = kind == "announce" or (kind == "other" and bool(_NON_FLOW.search(name)))
        if kind == "announce" and _FLOW.search(name) and not _NON_FLOW.search(name):
            general = False          # a flow's own announcement goes to the people signed up to it
        if not general or (code, week_of(r["date"])) in seen:
            continue
        if r["date"] == today and len(gone_today) and bool(P.carries_code(gone_today, code).any()):
            continue
        seen.add((code, week_of(r["date"])))
        rows.append({"date": r["date"], "campaign_code": code, "label": send_label(r.get("release"), name)})
    return pd.DataFrame(rows, columns=["date", "campaign_code", "label"])


def state_of(load: float) -> str:
    return "normal" if load <= NORMAL_TO + 1e-9 else "busy" if load <= BUSY_TO + 1e-9 else "very_busy"


def read(aud: pd.DataFrame, comms: pd.DataFrame, today) -> dict | None:
    """The list's weeks around today: what each has had and what its plan still holds, the four-week load of
    each week from this one on, and the state that load puts it in. None with no list on file."""
    today = pd.Timestamp(today).normalize()
    sent = marketing(aud)
    sent = sent[sent["day"] <= today] if len(sent) else sent
    size = list_size(sent, today)
    if size < MIN_LIST:
        return None
    this = week_of(today)
    plan = planned_general(comms, sent, today)
    artists = {str(c): P.campaign_artist(r) for c, r in zip(comms["campaign_code"], comms["release"])} if comms is not None and len(comms) else {}
    # what a week brings beside its general sends, where the plan cannot say who an email goes to
    past = [this - pd.Timedelta(weeks=k) for k in range(1, BASE_WEEKS + 1)]
    beside = []
    for w in past:
        s = sent[(sent["day"] >= w) & (sent["day"] < w + pd.Timedelta(days=7))]
        if len(s):
            beside.append(float(s.loc[s["delivered"] < GENERAL_SHARE * size, "delivered"].sum()) / size)
    base = float(pd.Series(beside).median()) if len(beside) >= 4 else BASE_DEFAULT
    weeks = {}
    for k in range(-(LOAD_WEEKS - 1), WEEKS_AHEAD + 1):
        w = this + pd.Timedelta(weeks=k)
        end = w + pd.Timedelta(days=6)
        s = sent[(sent["day"] >= w) & (sent["day"] <= end)] if len(sent) else sent
        gen = s[s["delivered"] >= GENERAL_SHARE * size] if len(s) else s
        pl = plan[(plan["date"] >= w) & (plan["date"] <= end)]
        left = min(max(int((end - today).days), 0), 7)          # the days of the week still to come
        weeks[w] = {
            "start": w, "sent": int(len(gen)), "planned": int(len(pl)),
            "names": [f"{_sent_label(n, artists.get(str(c)))} ({_DAY[d.weekday()]})" for n, c, d in zip(gen["name"], gen["code"], gen["day"])]
                     + [f"{lab} ({_DAY[d.weekday()]})" for lab, d in zip(pl["label"], pl["date"])],
            "pp": (float(s["delivered"].sum()) / size if len(s) else 0.0) + len(pl) * PLANNED_SHARE + base * left / 7.0,
        }
    for w, row in weeks.items():
        back = [weeks[w - pd.Timedelta(weeks=k)]["pp"] for k in range(LOAD_WEEKS) if (w - pd.Timedelta(weeks=k)) in weeks]
        row["load"] = sum(back) / len(back) if len(back) == LOAD_WEEKS else None
        row["state"] = state_of(row["load"]) if row["load"] is not None else None
    return {"today": today, "size": size, "this": this, "weeks": weeks, "base": base}


def _sent_label(name: object, artist: str | None = None) -> str:
    """A sent email as the card names it: the artist (the plan's spelling where its campaign is in the plan,
    else the segment of the email's own name) and what the email is."""
    n = str(name or "")
    what = n.split(" - ", 1)[1] if " - " in n else "email"
    if re.search(r"bundle", n, re.I):
        return "Bundle: " + re.sub(r"\s*\([^)]*\)", "", what).strip()
    m = re.match(r"^\d{6}_(?:[A-Z]+_)?([A-Za-z][A-Za-z\-]*)", n)
    who = artist or (re.sub(r"(?<=[a-z])(?=[A-Z])", " ", m.group(1)) if m else "An")
    what = re.sub(r"\s*\([^)]*\)", "", what).strip().lower() or "email"
    return f"{who} {what}"


def week_row(ctx: dict, day) -> dict | None:
    return (ctx or {}).get("weeks", {}).get(week_of(day))


# ---------------------------------------------------------------- the suggestions
def people_of(change: dict, size: float) -> float | None:
    """How many people a suggested email goes to: what the suggestion says (`people`), the whole list for one
    it says goes to the list, else unknown, and an email of unknown reach is not held to the rule."""
    if change.get("channel") != "Email":
        return None
    if change.get("people") is not None:
        try:
            return float(change["people"])
        except (TypeError, ValueError):
            return None
    return size if change.get("reach") == "list" else None


def is_general(change: dict, size: float) -> bool:
    n = people_of(change, size)
    return n is not None and size > 0 and n >= GENERAL_SHARE * size


def _short(hero: dict | None) -> float:
    """The units a page is heading to fall short of its target by; nothing within 3% of it (on course)."""
    hero = hero or {}
    try:
        target, projected = float(hero.get("target") or 0.0), float(hero.get("projected") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if not target or hero.get("ok") or projected >= target * (1 - 0.03):
        return 0.0
    return max(target - projected, 0.0)


def stake_of(page: dict) -> float:
    """What a launch has at stake: the units it is heading to fall short of its target by, at the price of a
    unit. The larger of its two readings, the clock's and the plan's; nothing on a launch on course by both."""
    short = max(_short(page.get("hero")), _short(((page.get("variants") or {}).get("plan") or {}).get("hero")))
    price = (page.get("economics") or {}).get("unitPrice") or (page.get("benchmark") or {}).get("price") or 1.0
    try:
        return short * float(price)
    except (TypeError, ValueError):
        return short


def _blocks(page: dict, shown=(3, 4)) -> list[tuple[dict, int]]:
    """A page's suggestion blocks, each with how many of its rows the card shows before the fold: its own
    (the clock's) and its plan-based view's."""
    out = []
    if isinstance(page.get("planChanges"), dict):
        out.append((page["planChanges"], shown[1] if page.get("method") == "plan" else shown[0]))
    pv = ((page.get("variants") or {}).get("plan") or {}).get("planChanges")
    if isinstance(pv, dict):
        out.append((pv, shown[1]))
    return out


def _value(c: dict) -> float:
    u = c.get("units") or {}
    return (float(u.get("low") or 0) + float(u.get("high") or 0)) / 2.0


def summary(ctx: dict) -> dict:
    """The list as the card's strip reads it: this week, and the week after."""
    def one(w):
        row = ctx["weeks"].get(w) or {}
        return {"start": str(w.date()), "general": int(row.get("sent", 0)) + int(row.get("planned", 0)), "sent": int(row.get("sent", 0)),
                "planned": int(row.get("planned", 0)), "names": list(row.get("names") or []),
                "load": round(float(row["load"]), 2) if row.get("load") is not None else None, "state": row.get("state")}
    this = ctx["this"]
    return {"asOf": str(ctx["today"].date()), "size": int(round(ctx["size"])), "cap": CAP, "normalTo": NORMAL_TO, "busyTo": BUSY_TO,
            "week": one(this), "next": one(this + pd.Timedelta(weeks=1))}


def settle(pages: list[dict], ctx: dict | None, shown=(3, 4)) -> int:
    """Lay the rule over every live launch's suggestions; how many were held comes back. `pages` are the built
    pages of the launches in flight (each changed in place); `ctx` is read()'s answer; `shown` is how many rows
    the card shows before its fold, on the clock's page and on the plan's. A block keeps the order the build
    ranked it in (`order`), so a page settled before is settled again from what the build suggested. With no
    list on file the pages are left as the build made them."""
    live = [(p, _blocks(p, shown)) for p in pages or []]
    live = [(p, bs) for p, bs in live if bs]
    for _, bs in live:
        for b, _n in bs:
            every = (b.get("changes") or []) + (b.get("more") or []) + (b.get("held") or [])
            b["order"] = b.get("order") or [c.get("key") for c in every]
            rank = {k: i for i, k in enumerate(b["order"])}
            every.sort(key=lambda c: rank.get(c.get("key"), len(rank)))
            for c in every:
                for k in ("general", "held", "heldBy"):
                    c.pop(k, None)
            b["changes"], b["more"], b["held"] = every, [], []
            b.pop("list", None)
    held = 0
    if ctx and live:
        size = ctx["size"]
        stakes = {id(p): stake_of(p) for p, _ in live}
        who = {id(p): str(p.get("artist") or "another launch") for p, _ in live}
        # every general send suggested, by the week it falls in
        asks: dict = {}
        for p, bs in live:
            for b, _n in bs:
                for c in b["changes"]:
                    if is_general(c, size) and c.get("date"):
                        asks.setdefault(week_of(c["date"]), {}).setdefault(id(p), []).append((b, c))
        for w in sorted(asks):
            row = ctx["weeks"].get(w)
            if row is None or row.get("state") is None:
                continue                                  # past the weeks read: the suggestion stands as it was
            had = int(row["sent"]) + int(row["planned"])
            room = max(CAP - had, 0)
            allow = {"normal": room, "busy": min(room, 1), "very_busy": 0}[row["state"]]
            order = sorted(asks[w], key=lambda k: -stakes[k])
            top = who[order[0]] if order and stakes[order[0]] > 0 else None
            load = f"{row['load']:.1f} emails a person a week over four weeks"
            taken = had
            for k in order:
                blocks = list({id(b): b for b, _ in asks[w][k]}.values())
                short = [b for b in blocks if b.get("status") != "on_course"]      # a card that reads on course is offered none
                got = stakes[k] > 0 and allow > 0 and bool(short)
                if got:
                    allow -= 1
                    taken += 1
                for b in blocks:
                    mine = sorted([c for bb, c in asks[w][k] if bb is b], key=lambda c: -_value(c))
                    on_course = stakes[k] <= 0 or b.get("status") == "on_course"
                    for i, c in enumerate(mine):
                        if got and i == 0 and not on_course:
                            c["general"] = {"nth": taken, "cap": CAP, "week": str(w.date())}
                            continue
                        if on_course:
                            why = "The launch is on course without it."
                        elif got:
                            why = "One general send a week for a launch."
                        elif room <= 0:
                            why = f"That week already holds {had} general sends. The cap is {CAP}."
                        elif row["state"] == "very_busy":
                            why = f"The list is very busy: {load}."
                        elif row["state"] == "busy":
                            why = (f"The list is busy ({load}), and {top} has more at stake that week." if top and top != who[k]
                                   else f"The list is busy: {load}.")
                        else:
                            why = (f"{top} has more at stake that week, and takes its last general send." if top and top != who[k]
                                   else f"That week holds {CAP} general sends with the ones suggested.")
                        c["held"] = why
                        c["heldBy"] = "course" if on_course else "launch" if got else "cap" if room <= 0 else "load"
                        held += 1
    brief = summary(ctx) if ctx else None
    for _, bs in live:
        for b, n in bs:
            b["held"] = [c for c in b["changes"] if c.get("held")]
            keep = [c for c in b["changes"] if not c.get("held")]
            b["changes"], b["more"] = keep[:n], keep[n:]
            if brief:
                b["list"] = brief
            if not ctx:
                b.pop("order", None)
    return held
