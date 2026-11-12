"""Suggested actions: what to add to, or change in, a live launch's plan.

The card at the top of a live draw launch's Overview (docs/METHODOLOGY.md,
"Suggested actions"; the card was named Plan changes for its first hours, and
the module, the snapshot's `planChanges` and the route keep that name). It
reads three things the build already has and proposes at most a handful of
changes, each one a change to the plan as it stands:

  the page    the launch's own snapshot: where it is heading against its
              target, which of traffic and conversion is short on AA Email and
              on the artist's channels, and the emails sent so far;
  the plan    the rows the team logs in Notion (server/notion.js writes
              data/notion_plan.csv): what is still to come, by day and channel;
  the record  what comparable launches sent and what it brought, from the
              HubSpot sends on file (the basket's members, or every recent
              draw launch when too few of them have sends).

A change is one of three kinds: add (something the plan does not hold),
change (a planned item done differently) and drop. Nothing here writes to the
plan: a change is ticked or dismissed on the page and that is recorded by the
server (server/planChanges.js).

Sizes are rough and say so: clicks a send of that kind brought on comparable
launches (the quartiles) times the units this launch has had per email click.
A change with no record behind it carries no estimate rather than a guess.

The paid budget's change sits in the same list (paid_change): tomorrow's step
toward the level the Spend levels card recommends, read off that card's own
block (`paid.levels`) and never worked out a second time here. A raise is
sized in the units the level adds by the close, a cut or a stop in the spend
it saves. It stands whether or not the launch is short.

The rules follow the marketing team's lever playbook (the `lever` on each
change is the playbook's id) and its order of questions: is the launch short
at all, then where is the gap (reach or conversion), then which lever. Email,
the artist's channels and the paid budget so far.

Pure functions over plain values, so tests/test_plan_changes.py can hold each
rule to a hand-built case. build.py calls `attach` as a page is written and
never lets it fail the page.
"""
from __future__ import annotations

import re
import statistics
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------- constants
SHORT_TOLERANCE = 0.03     # projected within 3% of the target counts as on course
LAST_CHANCE_DAYS = 2       # a send this many days or fewer before the close is a last chance send
LAST_WEEK_DAYS = 7         # the last chance rules look this far ahead of the close
WIDE_SHARE = 0.5           # a send to at least this share of the campaign's biggest send went wide
MID_AFTER_ANNOUNCE = 3     # a mid-campaign send is at least this many days after the announce
MID_BEFORE_CLOSE = 3       # ... and at least this many before the close
MID_SHARE = 0.25           # ... and to at least this share of the biggest send
MIN_COHORT = 4             # fewer comparable launches with sends than this and the recent launches stand in
MIN_VALUES = 3             # fewer readings than this and a size is not given
MIN_BACKING = 2            # a change is proposed on at least this many launches having done it
MIN_RECENT_SHARE = 0.1     # ... and, read off the recent launches, on at least this share of them
LIST_BAND = (0.5, 2.0)     # a recent launch sizes a send when its biggest send was within this of the release's own
MIN_OWN_CLICKS = 300       # the launch's own units per click is read once it has this many clicks
MIN_OWN_UNITS = 3.0        # ... and this many units from email
RECENT_MONTHS = 24         # how far back the stand-in cohort reaches
RESEND_MIN_AGE, RESEND_MAX_AGE = 2, 10   # days since the biggest send for a re-send to be worth proposing
RESEND_MIN_DAYS_LEFT = 3
ARTIST_MIN_EXPECTED = 20   # the artist rules need at least this many expected sessions to judge by
MAX_SHOWN = 3              # changes shown before the rest fold under "more"
PAID_HOLD = 0.05           # tomorrow's paid budget within this of today's spend is a hold, and no change

_OPERATIONAL = {"TRNS", "AUT", "FREQ", "TEST"}
_EARLY = re.compile(r"early\s*access|exclusive\s*access|skip\s*the\s*draw|private\s*room", re.I)
_LAST = re.compile(r"last\s*chance|final\s*(call|day|hours)|hours?\s*(left|to\s*go)|closing", re.I)
_RESEND = re.compile(r"re-?send|mop\s*-?up|non-?openers?", re.I)


def _d(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def _f(v, default=0.0) -> float:
    try:
        x = float(v)
        return x if x == x else default
    except (TypeError, ValueError):
        return default


def quartiles(values) -> tuple[float, float, float] | None:
    """P25, median, P75, or None with fewer than MIN_VALUES readings."""
    vals = sorted(float(v) for v in values if v is not None)
    if len(vals) < MIN_VALUES:
        return None
    q = statistics.quantiles(vals, n=4, method="inclusive")
    return q[0], q[1], q[2]


def spread(values) -> tuple[float, float] | None:
    """The range a size is quoted over: the quartiles, the two readings
    themselves when there are only two, None with fewer."""
    vals = sorted(float(v) for v in values if v is not None)
    if len(vals) == 2:
        return vals[0], vals[1]
    q = quartiles(vals)
    return (q[0], q[2]) if q else None


# ---------------------------------------------------------------- the record
def marketing_sends(emails, code: str, start: date, end: date) -> list[dict]:
    """A campaign's customer sends in a window, as the email card counts them:
    the GEN/CUS/INS sends, or every send that is not operational when the
    names carry no such segment. `emails` is build.load_emails()'s frame."""
    if emails is None or not len(emails) or not code:
        return []
    sub = emails[(emails["campaign"] == code)
                 & (emails["sent_at"].dt.date >= start) & (emails["sent_at"].dt.date <= end)]
    core = sub[sub["email_type"].isin(["GEN", "CUS", "INS"])]
    if core.empty and not sub.empty:
        core = sub[~sub["email_type"].isin(list(_OPERATIONAL))]
    out = []
    for _, r in core.sort_values("sent_at").iterrows():
        out.append({"name": str(r["name"]).split(" - ", 1)[-1], "date": r["sent_at"].date(),
                    "delivered": _f(r["delivered"]), "opened": _f(r["opened"]), "clicked": _f(r["clicked"])})
    return out


def read_sends(sends: list[dict], announce: date, close: date) -> dict:
    """What a campaign's sends amount to, by where they fall on its clock."""
    sends = [dict(s, date=_d(s.get("date"))) for s in sends or [] if _d(s.get("date"))]
    biggest = max(sends, key=lambda s: s["delivered"], default=None)
    top = biggest["delivered"] if biggest else 0.0
    last = [s for s in sends if 0 <= (close - s["date"]).days <= LAST_CHANCE_DAYS and s["date"] > announce
            and not _EARLY.search(s["name"])]
    mid = [s for s in sends if (s["date"] - announce).days >= MID_AFTER_ANNOUNCE
           and (close - s["date"]).days >= MID_BEFORE_CLOSE
           and s["delivered"] >= MID_SHARE * top and not _EARLY.search(s["name"])]
    resend = [s for s in sends if _RESEND.search(s["name"]) and not _LAST.search(s["name"])]
    two_out = [s for s in sends if 2 <= (close - s["date"]).days <= 3 and (s["date"] - announce).days >= MID_AFTER_ANNOUNCE
               and not _EARLY.search(s["name"])]
    return {
        "sends": sends, "biggest": biggest,
        "clicks": sum(s["clicked"] for s in sends),
        "last": last, "last_clicks": sum(s["clicked"] for s in last),
        "last_wide": bool(top and any(s["delivered"] >= WIDE_SHARE * top for s in last)),
        "mid": mid, "mid_clicks": sum(s["clicked"] for s in mid),
        "resend": resend, "two_out": two_out, "two_out_clicks": sum(s["clicked"] for s in two_out),
    }


def launch_history(emails, launches: list[dict], email_units: dict | None = None) -> dict:
    """Every closed launch's sends read on its own clock, by release name.
    `launches`: {name, code, announce, close, start}; `email_units`: the units
    AA Email brought per release name (the draw panel's), for units per click."""
    out = {}
    for ln in launches or []:
        ann, close = _d(ln.get("announce")), _d(ln.get("close"))
        if not ln.get("name") or not ln.get("code") or not ann or not close or close <= ann:
            continue
        start = _d(ln.get("start")) or ann - timedelta(days=14)
        sends = marketing_sends(emails, ln["code"], start, close)
        if not sends:
            continue
        rec = read_sends(sends, ann, close)
        units = (email_units or {}).get(ln["name"])
        rec.update(name=ln["name"], code=ln["code"], announce=ann, close=close,
                   units_per_click=(_f(units) / rec["clicks"] if units is not None and rec["clicks"] >= MIN_OWN_CLICKS and _f(units) > 0 else None))
        out[ln["name"]] = rec
    return out


def cohort_for(history: dict, members: list[str], name: str, as_of: date, pool: set | None = None) -> dict:
    """The launches a release is read against: its basket's members with
    sends on file, or with too few of them every draw launch that closed in
    the last RECENT_MONTHS (`pool` narrows that to the draw panel's names)."""
    closed = {k: v for k, v in history.items() if k != name and v["close"] < as_of}
    since = as_of - timedelta(days=RECENT_MONTHS * 30)
    recent = [v for k, v in closed.items() if v["close"] >= since and (pool is None or k in pool)]
    rows = [closed[m] for m in members or [] if m in closed]
    if len(rows) >= MIN_COHORT:
        return {"rows": rows, "kind": "similar", "recent": recent}
    return {"rows": recent, "kind": "recent", "recent": recent}


def backing(cohort: dict, did, list_size: float = 0.0) -> dict:
    """Who did a thing, as the reason line says it: the comparable launches
    when at least MIN_BACKING of them did, else the recent launches. `ok` is
    whether that is enough of a record to propose the change on, and `sized`
    the rows a size is read from: the comparable launches that did it, which
    are of the release's own scale, else the recent ones whose biggest send
    was within LIST_BAND of the release's own (`list_size`), since the clicks
    a send brings follow the list it goes to."""
    hit = [r for r in cohort["rows"] if did(r)]
    kind, n = cohort["kind"], len(cohort["rows"])
    sized = hit if kind == "similar" and len(hit) >= MIN_BACKING else None
    if len(hit) < MIN_BACKING and kind != "recent":
        hit, kind, n = [r for r in cohort["recent"] if did(r)], "recent", len(cohort["recent"])
    if sized is None:
        lo, hi = LIST_BAND
        sized = [r for r in cohort["recent"] if did(r) and list_size > 0 and r.get("biggest")
                 and lo <= r["biggest"]["delivered"] / list_size <= hi]
    return {"hit": hit, "n": n, "kind": kind, "sized": sized,
            "ok": len(hit) >= MIN_BACKING and (kind != "recent" or len(hit) >= MIN_RECENT_SHARE * n),
            "words": f"{len(hit)} of {n} {kind} launches"}


# ---------------------------------------------------------------- the plan
def plan_for(plan_rows: list[dict], code: str | None, name: str | None) -> list[dict]:
    """A release's plan rows, oldest first: {date, channel, title}."""
    out = []
    for r in plan_rows or []:
        if not ((code and r.get("campaign_code") == code) or (name and r.get("release_name") == name)):
            continue
        d = _d(r.get("date"))
        if d:
            out.append({"date": d, "channel": str(r.get("channel") or "other"), "title": str(r.get("title") or "").strip()})
    return sorted(out, key=lambda r: (r["date"], r["channel"], r["title"]))


CHANNEL_WORD = {"email": "Email", "brand": "AA Social", "artist": "Artist", "partner": "Partner", "other": "Other"}


# ---------------------------------------------------------------- sizes
def _units(clicks_low: float | None, clicks_high: float | None, upc: float | None, room: float | None) -> dict | None:
    """A size in units from a range of clicks, capped by what the launch has
    left to sell against its target; None when there is nothing to go on."""
    if clicks_low is None or clicks_high is None or not upc:
        return None
    low, high = max(clicks_low, 0.0) * upc, max(clicks_high, 0.0) * upc
    if room is not None:
        low, high = min(low, room), min(high, room)
    low, high = int(round(low)), int(round(high))
    if high < 1:
        return None
    return {"low": min(low, high), "high": high}


def _pct(x: float) -> str:
    return f"{round(x * 100)}%"


# ---------------------------------------------------------------- paid
PAID_STOP = {
    "supply": ("Edition spoken for", "The edition is spoken for without paid, so a further entry buys nothing."),
    "marginal": ("Next euro under 1.0", "Even the smallest day's next euro returns less than it costs."),
    "zero_conversion_pause": ("No entries for 3 days", "Three days of spend have bought no entries."),
}


def _money(v: float) -> str:
    return f"\u20ac{int(round(v)):,}"


def _units_at(rows: list[dict], daily: float) -> float | None:
    """The units at the close at a flat daily spend, read between the Spend
    levels card's rows (none, half, recommended, double); held at the ends."""
    pts = sorted((_f(r.get("daily")), _f(r.get("unitsAtClose"))) for r in rows or []
                 if r.get("daily") is not None and r.get("unitsAtClose") is not None)
    if len(pts) < 2:
        return None
    if daily <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if daily <= x1:
            return y0 + (y1 - y0) * ((daily - x0) / (x1 - x0) if x1 > x0 else 0.0)
    return pts[-1][1]


def paid_change(levels: dict | None, as_of: date, close: date, line: dict | None = None) -> dict | None:
    """The paid budget's change for tomorrow, from the Spend levels card's own
    reading (`paid.levels`, docs 7): raise or cut the daily budget to
    tomorrow's step toward the recommended level, start it, or stop. Nothing
    when the step is within PAID_HOLD of today's spend. A raise is sized in
    the units it adds by the close at the level it is heading for; a cut or a
    stop in the spend it saves, with the units it gives up in the reason.
    `line` names the line of work on a release that runs an ad set per line."""
    lv = levels or {}
    if lv.get("recommended") is None or as_of >= close:
        return None
    today, level = _f(lv.get("today")), _f(lv.get("recommended"))
    step = _f(lv.get("tomorrow"), level) if lv.get("tomorrow") is not None else level
    days_left = max(int(_f(lv.get("daysLeft"), (close - as_of).days)), 0)
    tag = re.sub(r"[^a-z0-9]+", "_", str(line.get("key") or "").lower()).strip("_") if line else ""
    key = "paid." + (tag + "." if tag else "")
    what = (" \u00b7 " + str(line.get("name"))) if line and line.get("name") else ""
    base = {"channel": "Paid", "lever": "le_paid_sustain_monitor_scale", "date": (as_of + timedelta(days=1)).isoformat(), "units": None}
    marg = lv.get("marginalToday")
    if level <= 0:
        if today <= 0:
            return None
        word, why = PAID_STOP.get(lv.get("stop") or "marginal", PAID_STOP["marginal"])
        return dict(base, key=key + "stop", kind="drop", title="Paid spend" + what, note=word, **{"from": _money(today)},
                    saves=int(round(today * days_left)), reason=why)
    if today > 0 and abs(step - today) / today < PAID_HOLD:
        return None
    u_to, u_now = _units_at(lv.get("rows"), level), _units_at(lv.get("rows"), today)
    delta = (u_to - u_now) if u_to is not None and u_now is not None else None
    heading = f" {_money(level)} a day is the level it is heading for." if abs(level - step) >= 1 else ""
    if today <= 0:
        return dict(base, key=f"{key}budget.{int(round(step))}", kind="add", title="Paid spend" + what, to=f"{_money(step)} a day",
                    units=({"low": int(round(delta)), "high": int(round(delta))} if delta is not None and round(delta) >= 1 else None),
                    reason=f"Nothing is being spent, and the first euros return more than they cost.{heading}")
    change = dict(base, key=f"{key}budget.{int(round(step))}", kind="change", title="Paid daily budget" + what, to=_money(step), **{"from": _money(today)})
    lead = f"The next euro returns {_f(marg):.1f} at today's {_money(today)}" if marg is not None else f"Today's spend is {_money(today)} a day"
    if step > today:
        change["units"] = {"low": int(round(delta)), "high": int(round(delta))} if delta is not None and round(delta) >= 1 else None
        change["reason"] = f"{lead}.{heading}"
    else:
        change["saves"] = int(round((today - step) * days_left))
        lost = f" About {int(round(-delta))} fewer units by the close." if delta is not None and round(-delta) >= 1 else ""
        change["reason"] = f"{lead}, under the 1.0 it costs.{heading}{lost}"
    return change


def paid_changes(snap: dict, as_of: date, close: date) -> list[dict]:
    """The page's paid changes: one for the campaign, or one per line of work
    on a release that runs an ad set per line (each line's own Spend levels,
    under variants.lines)."""
    lines = snap.get("lines") or []
    per_line = (snap.get("variants") or {}).get("lines") or {}
    out = []
    if lines and per_line:
        for ln in lines:
            lv = ((per_line.get(ln.get("key")) or {}).get("paid") or {}).get("levels")
            c = paid_change(lv, as_of, close, ln)
            if c:
                out.append(c)
    else:
        c = paid_change((snap.get("paid") or {}).get("levels"), as_of, close)
        if c:
            out.append(c)
    return out


def _ranked(found: list[dict]) -> list[dict]:
    """Largest first: the changes sized in units, then those that save spend,
    then the ones with no estimate."""
    return sorted(found, key=lambda c: (-(c["units"]["high"] if c.get("units") else -1), -(c.get("saves") or 0), c["key"]))


# ---------------------------------------------------------------- the rules
def changes_for(snap: dict, history: dict, plan_rows: list[dict] | None, pool: set | None = None) -> dict | None:
    """The plan changes for one page, or None when the page is not a live,
    targeted draw launch (a closed launch has no plan left to change)."""
    if snap.get("type") == "TL" or snap.get("upcoming") or snap.get("catalogue") or snap.get("complete"):
        return None
    if snap.get("targeted") is False or not snap.get("benchmark") or snap.get("line"):
        return None
    as_of, ann, close = _d(snap.get("asOf")), _d(snap.get("windowStart")), _d(snap.get("windowEnd"))
    hero = snap.get("hero") or {}
    if not as_of or not ann or not close or not (ann <= as_of <= close) or not _f(hero.get("target")):
        return None
    days_left = (close - as_of).days
    day = (as_of - ann).days
    target, projected = _f(hero.get("target")), _f(hero.get("projected"))
    short = projected < target * (1 - SHORT_TOLERANCE)
    room = max(target - projected, 0.0)

    plan = plan_for(plan_rows, snap.get("campaignCode"), snap.get("releaseName"))
    plan_visible = bool(plan)
    emails_logged = any(r["channel"] == "email" for r in plan)
    to_come = [r for r in plan if r["date"] >= as_of]
    out = {
        "asOf": as_of.isoformat(), "daysLeft": days_left,
        "status": "short" if short else "on_course",
        "planVisible": plan_visible,
        "planDone": len([r for r in plan if r["date"] < as_of]),
        "planToCome": [{"date": r["date"].isoformat(), "channel": CHANNEL_WORD.get(r["channel"], "Other"), "title": r["title"]} for r in to_come],
        "cohort": None, "changes": [], "more": [],
    }
    # the paid budget's change stands whether or not the launch is short: a
    # euro that does not pay is cut on a launch that is on course too
    paid = paid_changes(snap, as_of, close)
    if not short:
        ranked = _ranked(paid)
        out["changes"], out["more"] = ranked[:MAX_SHOWN], ranked[MAX_SHOWN:]
        return out

    members = [m.get("name") if isinstance(m, dict) else m for m in ((snap.get("benchmark") or {}).get("members") or [])]
    cohort = cohort_for(history, members, snap.get("releaseName"), as_of, pool)
    rows = cohort["rows"]
    out["cohort"] = {"n": len(rows), "kind": cohort["kind"]}

    own = read_sends([dict(s) for s in ((snap.get("email") or {}).get("sequence") or [])], ann, close)
    channels = {c.get("key"): c for c in snap.get("channels") or []}
    email_units = _f((channels.get("aa_email") or {}).get("now"))
    upc = email_units / own["clicks"] if own["clicks"] >= MIN_OWN_CLICKS and email_units >= MIN_OWN_UNITS else None
    if upc is None:
        q = quartiles([r.get("units_per_click") for r in rows])
        upc = q[1] if q else None

    fe = (snap.get("funnelByGroup") or {}).get("aa_email") or {}
    traffic_gap = -min(_f(fe.get("contrib_traffic")), 0.0)
    conv_gap = -min(_f(fe.get("contrib_conversion")), 0.0)
    reach_short = _f(fe.get("sessions_actual")) < _f(fe.get("sessions_expected")) and traffic_gap >= conv_gap
    conv_short = conv_gap > traffic_gap and _f(fe.get("conv_actual")) < 0.9 * _f(fe.get("conv_expected"))

    def planned_email(first: date, last: date) -> dict | None:
        return next((r for r in to_come if r["channel"] == "email" and first <= r["date"] <= last), None)

    found: list[dict] = []
    biggest = own["biggest"]
    top = biggest["delivered"] if biggest else 0.0

    # ---- the last chance email (playbook: le_email_lastchance_reminder, le_email_lastchance_widen_audience)
    if 0 <= days_left <= LAST_WEEK_DAYS:
        lc_planned = planned_email(max(as_of, close - timedelta(days=LAST_CHANCE_DAYS)), close)
        sent_any = bool(own["last"])
        if emails_logged and not lc_planned and not sent_any and days_left <= 5:
            # the standard reminder is missing from a plan that does log its emails
            b = backing(cohort, lambda r: bool(r["last"]), top)
            q = spread([r["last_clicks"] for r in b["sized"]])
            found.append({
                "key": "email.last_chance.add", "kind": "add", "lever": "le_email_lastchance_reminder",
                "title": "Last chance email", "note": "Not in the plan", "channel": "Email",
                "date": (close - timedelta(days=1) if days_left >= 1 else close).isoformat(),
                "units": _units(q[0], q[1], upc, room) if q else None,
                "reason": f"{b['words']} sent one in the last two days.",
            })
        elif not own["last_wide"] and reach_short:
            # a reach gap, and the last chance email has not gone wide: send it to the full list
            b = backing(cohort, lambda r: r["last_wide"], top)
            if b["ok"]:
                qw = spread([r["last_clicks"] for r in b["sized"]])
                narrow = [r["last_clicks"] for r in (cohort["rows"] if cohort["kind"] == "similar" else b["sized"]) if r["last"] and not r["last_wide"]]
                base = own["last_clicks"] if sent_any else (statistics.median(narrow) if narrow else 0.0)
                big_opened = (biggest["opened"] / biggest["delivered"]) if biggest and biggest["delivered"] else None
                wide_sends = [s for s in own["sends"] if top and s["delivered"] >= WIDE_SHARE * top]
                lead = (f"{'One full-list email' if len(wide_sends) == 1 else f'{len(wide_sends)} full-list emails'} so far"
                        + (f", {_pct(1 - big_opened)} unopened" if big_opened is not None and len(wide_sends) == 1 else "") + ". ") if wide_sends else ""
                change = {
                    "key": "email.last_chance.widen", "lever": "le_email_lastchance_widen_audience", "channel": "Email",
                    "date": (lc_planned["date"] if lc_planned else close - timedelta(days=1) if days_left >= 1 else close).isoformat(),
                    "units": _units(qw[0] - base, qw[1] - base, upc, room) if qw else None,
                    "reason": f"{lead}{b['words']} closed with a wide send.",
                }
                if sent_any:
                    change.update(kind="add", title="Last chance email to the rest of the list",
                                  note=f"Sent to {int(round(max(s['delivered'] for s in own['last']))):,} so far")
                else:
                    change.update(kind="change", title="Last chance email", to="Full list")
                found.append(change)

    # ---- the 48-hour reminder (le_email_lastchance_reminder_48h): conversion is the gap, not reach
    if 2 <= days_left <= 5 and conv_short and not own["two_out"]:
        two_day = close - timedelta(days=2)
        if not planned_email(max(as_of, two_day - timedelta(days=1)), two_day):
            b = backing(cohort, lambda r: bool(r["two_out"]), top)
            q = spread([r["two_out_clicks"] for r in b["sized"]])
            if b["ok"]:
                found.append({
                    "key": "email.reminder_48h.add", "kind": "add", "lever": "le_email_lastchance_reminder_48h",
                    "title": "48-hour reminder email", "note": "Not in the plan" if emails_logged else "None sent so far",
                    "channel": "Email", "date": max(as_of, two_day).isoformat(),
                    "units": _units(q[0], q[1], upc, room) if q else None,
                    "reason": (f"Email visits enter at {_f(fe.get('conv_actual')):.1%} against {_f(fe.get('conv_expected')):.1%}. "
                               f"{b['words']} sent a reminder two days out."),
                })

    # ---- a re-send to non-openers (le_email_announce_resend_nonopeners)
    if biggest and days_left >= RESEND_MIN_DAYS_LEFT and biggest["delivered"] > 0:
        age = (as_of - biggest["date"]).days
        open_rate = biggest["opened"] / biggest["delivered"]
        q_open = quartiles([r["biggest"]["opened"] / r["biggest"]["delivered"] for r in rows
                            if r.get("biggest") and r["biggest"]["delivered"] > 0])
        later = [s for s in own["sends"] if s["date"] > biggest["date"]
                 and (_RESEND.search(s["name"]) or s["delivered"] >= WIDE_SHARE * top)]
        soon = planned_email(as_of, as_of + timedelta(days=3))
        if RESEND_MIN_AGE <= age <= RESEND_MAX_AGE and q_open and open_rate < q_open[0] and not later and not soon:
            rates = [s["clicked"] / s["delivered"] for r in history.values() for s in r["resend"] if s["delivered"] >= 1000]
            q = quartiles(rates) if len(rates) >= 5 else None
            unopened = biggest["delivered"] - biggest["opened"]
            found.append({
                "key": "email.announce.resend", "kind": "add", "lever": "le_email_announce_resend_nonopeners",
                "title": "Re-send to non-openers", "note": f"{_pct(open_rate)} opened, {_pct(q_open[1])} is usual",
                "channel": "Email", "date": (as_of + timedelta(days=1)).isoformat(),
                "units": _units(q[0] * unopened, q[2] * unopened, upc, room) if q else None,
                "reason": f"{int(round(unopened)):,} people have not opened the biggest send.",
            })

    # ---- a mid-campaign email (le_email_sustain_bundle for reach, le_email_sustain_deepdive for conversion)
    if days_left >= 5 and day >= 5 and not own["mid"]:
        if not planned_email(as_of, close - timedelta(days=MID_BEFORE_CLOSE)):
            b = backing(cohort, lambda r: bool(r["mid"]), top)
            q = spread([r["mid_clicks"] for r in b["sized"]])
            deep = conv_short
            if b["ok"]:
                found.append({
                    "key": "email.mid.add", "kind": "add",
                    "lever": "le_email_sustain_deepdive" if deep else "le_email_sustain_bundle",
                    "title": "Deep-dive email" if deep else "Bundle email to full list",
                    "note": "Not in the plan" if emails_logged else "None sent so far", "channel": "Email",
                    "date": min(as_of + timedelta(days=2), close - timedelta(days=MID_BEFORE_CLOSE)).isoformat(),
                    "units": _units(q[0], q[1], upc, room) if q else None,
                    "reason": (("Email visits are entering less often than planned. " if deep else "Email visits are behind plan. ")
                               + f"{b['words']} sent a mid-campaign email."),
                })

    # ---- the artist's channels (le_artist_lastchance_story, le_artist_sustain_additional_posts)
    fa = (snap.get("funnelByGroup") or {}).get("referral_artist") or {}
    artist_off = "referral_artist" in ((snap.get("benchmark") or {}).get("channelsOff") or [])
    expected, actual = _f(fa.get("sessions_expected")), _f(fa.get("sessions_actual"))
    if plan_visible and not artist_off and expected >= ARTIST_MIN_EXPECTED:
        ch = channels.get("referral_artist") or {}
        left = max(_f(ch.get("bm")) - _f(ch.get("now")), 0.0)
        size = ({"low": max(int(round(left * 0.5)), 1), "high": int(round(left))} if round(left) >= 1 else None)
        if size and room is not None:
            size = {"low": min(size["low"], int(round(room))), "high": min(size["high"], int(round(room)))} if round(room) >= 1 else None
        seen_lately = [r for r in plan if r["channel"] == "artist" and as_of - timedelta(days=7) <= r["date"] < as_of]
        coming = [r for r in to_come if r["channel"] == "artist"]
        if seen_lately and actual < max(5.0, 0.1 * expected):
            when = seen_lately[-1]["date"]
            found.append({
                "key": "artist.post.unseen", "kind": "add", "lever": "le_artist_sustain_additional_posts",
                "title": "Artist post", "note": f"Planned {when.day} {when.strftime('%b')}, no visits seen", "channel": "Artist",
                "date": min(as_of + timedelta(days=1), close).isoformat(), "units": size,
                "reason": f"{int(round(actual))} visits from the artist's channels so far, about {int(round(expected))} expected by now.",
            })
        elif days_left <= 3 and not coming and actual < 0.5 * expected:
            found.append({
                "key": "artist.last_chance.add", "kind": "add", "lever": "le_artist_lastchance_story",
                "title": "Artist last chance story", "note": "Not in the plan", "channel": "Artist",
                "date": (close - timedelta(days=1) if days_left >= 1 else close).isoformat(), "units": size,
                "reason": f"{int(round(actual))} visits from the artist's channels so far, about {int(round(expected))} expected by now.",
            })

    ranked = _ranked(paid + found)
    out["changes"], out["more"] = ranked[:MAX_SHOWN], ranked[MAX_SHOWN:]
    return out


# ---------------------------------------------------------------- the build's hook
def attach(snap: dict, ctx: dict | None) -> None:
    """Put `planChanges` on a page as it is written. `ctx` is what the build
    read once: {history, plan_rows, pool}. A page it does not apply to is left
    without the key, and so is every page of a build with no context."""
    if not ctx or not isinstance(snap, dict):
        return
    block = changes_for(snap, ctx.get("history") or {}, ctx.get("plan_rows") or [], ctx.get("pool"))
    if block is not None:
        snap["planChanges"] = block
    else:
        snap.pop("planChanges", None)
