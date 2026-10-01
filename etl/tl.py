#!/usr/bin/env python3
"""Timed launches (TL): the release model, the panel, the targets and the page
snapshots (docs/TL_SPEC.md). Phase one: the signups state, the sidebar state
and a sales summary for the window and after it.

What a TL is here: a release the TL feed names (etl/aggregate_tl.py, from
TL_Funnel_Report_v2) or a launch Airtable types Timed that the feed has not
seen yet. The two are matched by etl/pricing.py's matcher held to the timed
launches alone, so an artist's draw in the same quarter never stands in.

The three states and their boundaries (spec §2) are worked out from Airtable's
launch date and window length, the feed's own launch timestamp and the sales:
  open    the typed open; else Airtable's launch date at its launch_time (a
          UTC instant whose time of day is the open: 18:00 Amsterdam for
          most launches); else the feed's launch_date, which runs an hour late
          in summer against Airtable and the sales bursts (measured on 1
          October 2026 over the 2025-26 launches: 16:00Z against 17:00Z in
          CEST, equal in CET), so an hour is taken off it in CEST; else 14:00
          Amsterdam time on the launch date
  close   open + the typed length; else Airtable's tl_length ("48 hours", "7
          days", "24 hours"); else tl_end_date at the open's time of day;
          else 48 hours, said to be assumed
  announce the typed date; else the latest announce date Airtable's records
          hold before the open (a stale earlier one sits beside the current
          one on Carrie Mae Weems' records); else the feed's announcement_date;
          else the first day with TL_ANNOUNCE_MIN signups within
          TL_ANNOUNCE_LEAD days of the open; else 24 days before the open,
          said to be assumed
  early access  the sales start about a day before the public open (the
          platform's "TL - Early access" stage, private-room orders): the
          first hour before the open, within 36 hours of it, that sold five
          pieces or more; for a launch still to open, the open less 24 hours,
          said to be expected
  settle  the close plus TL_SETTLE_DAYS: drafts are paid and cancellations
          land, then the figures are final
States: upcoming (before the announce), signups (announce to the sales open),
window (the sales open to the close), settling, closed.

Panel (spec §8): every completed launch in the feed with enough signups, with
its pre-window signups and sessions by channel group, its session -> signup
and signup -> order rates, its pieces per order, its window units by group,
its paid costs from the spend feed under its campaign code (the "Sign-ups"
campaigns before the open, the "Purchases" campaigns in the window), and two
pace curves: the cumulative share of pre-window signups by day to the open
and of window units by share of the window. Baskets are cut from it as the LE
baskets are, with the window length as the first filter.

Targets (spec §7):
    orders needed   = units target / purchases per order
    signup target   = orders needed / signup -> order rate
    group targets   = the basket's group benchmarks plus their share of the
                      stretch (stretch_from, else the basket's own shares)
    sessions needed = group signup target / session -> signup rate
    pre-window budget = paid signup target x cost per signup
    in-window budget  = paid share of units x units target x cost per sale
shared/tlModel.mjs mirrors the figures for the Target setting header and
tests/test_tl_model.py holds the two together.

The build calls build_all(ctx) from etl/build.py main(); `python3 etl/tl.py`
builds the TL pages alone, for development.
"""
from __future__ import annotations

import json
import math
import os
import pathlib
import re
import sys
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pricing  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
APP = pathlib.Path(os.environ.get("APP_DATA_PATH") or (DATA / "app"))
DERIVED = APP / "derived"
DAILY = APP / "tl_daily.csv"
HOURLY = APP / "tl_hourly.csv"
RELEASES = APP / "tl_releases.csv"
FEED = APP / "tl_feed.json"
PANEL = APP / "tl_panel.csv"
CURVES = APP / "tl_curves.json"
BENCH = json.loads((ROOT / "etl" / "benchmarks.json").read_text())

GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"]
# the display groups as etl/build.py DISPLAY_GROUPS has them (tests/test_tl_model.py holds the two together)
DISPLAY_GROUPS = {
    "aa_email": {"name": "AA Email", "channels": ["AA Email Auto", "AA Email Man"]},
    "aa_social": {"name": "AA Meta", "channels": ["AA Meta", "AA X"]},
    "referral_artist": {"name": "Artist", "channels": ["Referral Artist"]},
    "search_direct_other": {"name": "Direct etc.",
                            "channels": ["Direct", "Organic Search", "Other", "AA Other", "Referral Meta", "Referral Other", "Referral X"]},
    "paid": {"name": "Paid", "channels": ["Paid Social", "Paid Search"]},
}
GROUP_OF = {c: g for g, spec in DISPLAY_GROUPS.items() for c in spec["channels"]}
GROUP_NAMES = {g: spec["name"] for g, spec in DISPLAY_GROUPS.items()}

TL_SETTLE_DAYS = 7          # the close to the final figures (decision 24)
TL_ANNOUNCE_MIN = 10        # signups in a day that start the pre-window without an Airtable announce (decision 17)
TL_ANNOUNCE_LEAD = 45       # ... within this many days of the open
TL_ASSUMED_PRE_DAYS = 24    # announce to open when nothing says otherwise
TL_DEFAULT_HOURS = 48.0     # the window when Airtable has no length and no end date
TL_DEFAULT_OPEN_LOCAL = 14  # 14:00 Amsterdam time, the last reading of the opening hour (decision 16)
TL_EA_HOURS = 24            # the early access expected before a public open
TL_EA_MIN_PIECES = 5        # pieces in an hour before the open that say the early access has begun
TL_EA_WITHIN_HOURS = 36
TL_PANEL_MIN_SIGNUPS = 50   # a completed launch needs this many pre-window signups to be a comparable
TL_CURVE_DAYS = 45          # the signup pace curve runs from this many days before the open
TL_UNIT_CURVE_STEPS = 50    # the sales pace curve's steps across the window
TL_THIN = 6                 # a basket under this is thin, and the length filter falls back to every TL
TL_SIMILAR_N = 8
TL_UPCOMING_DAYS = 120      # a timed launch this far ahead in Airtable is listed before the feed sees it
TL_CANNIBALISATION = 0.1    # the TL panel's default (spec §7; the LE standard is 0.2)
TL_PAID_SPLIT_PRE = 0.7     # the paid budget's pre-window share when the basket has no reading (the workbook template)
PAID_COST_MIN_SIGNUPS = 20  # a cost per signup needs this many paid signups
PAID_COST_MIN_UNITS = 5     # a cost per sale this many paid units
PAID_COST_MIN_MEMBERS = 3   # a basket's median cost needs this many members with one
RATE_MIN_SIGNUPS = 30       # a group's signup -> order rate is read from this many signups
RATE_MIN_SESSIONS = 100     # a group's session -> signup rate from this many sessions
RATE_MAX_PER_SESSION = 0.5  # ... and over this it is not a rate the feed measured
RECENT_DAYS = 548           # a comparable that closed within this ranks first (18 months, as the LE baskets)
NEAR = 4.0                  # a comparable within this multiple on every axis is near
ID_MAX_CHARS = 120
CURVE_DAYS = list(range(-TL_CURVE_DAYS, 1))
CURVE_FRACS = [round(i / TL_UNIT_CURVE_STEPS, 2) for i in range(TL_UNIT_CURVE_STEPS + 1)]


# ---------------------------------------------------------------- small helpers

def slugify(name: str) -> str:
    """Release name -> id the server accepts ([a-z0-9_]), as etl/build.py slugify."""
    slug = re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", str(name).lower())).strip("_")
    if len(slug) > ID_MAX_CHARS:
        head = slug[:ID_MAX_CHARS]
        slug = head.rsplit("_", 1)[0] if "_" in head else head
    return slug.strip("_")


def tl_id(name: str) -> str:
    """A TL page's id: the name's slug with a TL suffix, since the LE feed and
    the TL feed each name releases "Artist · Title · YYYY Qn" and an artist can
    have one of each in a quarter (Ai Weiwei, 2026 Q4)."""
    return slugify(name) + "_tl"


def _clean(rec: dict) -> dict:
    """A frame's record with NaN read as None, so nothing unreadable reaches a page."""
    return {k: (None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v) for k, v in rec.items()}


def _json_safe(obj):
    """The snapshot with every NaN or infinity read as null: a page is JSON or it is nothing."""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (datetime, date, pd.Timestamp)):
        return _iso(obj)
    return obj


def _num(v, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(f) or math.isinf(f) else f


def _r(v, nd=1):
    f = _num(v)
    return None if f is None else round(f, nd)


def _iso(ts) -> str | None:
    if ts is None or (isinstance(ts, float) and math.isnan(ts)) or ts is pd.NaT:
        return None
    if isinstance(ts, pd.Timestamp):
        ts = ts.to_pydatetime()
    if isinstance(ts, datetime):
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(ts, date):
        return ts.isoformat()
    return str(ts)


def _ts(v) -> datetime | None:
    """A UTC datetime from an ISO string, a Timestamp or a datetime; None for nothing."""
    if v is None or v == "" or (isinstance(v, float) and math.isnan(v)) or v is pd.NaT:
        return None
    try:
        t = pd.Timestamp(v)
    except (ValueError, TypeError):
        return None
    if pd.isna(t):
        return None
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    return t.to_pydatetime()


def _day(v) -> date | None:
    t = _ts(v)
    return t.date() if t else None


def amsterdam_offset_hours(day: date) -> int:
    """Amsterdam's offset from UTC on `day`: 2 in summer time (the last Sunday
    of March to the last Sunday of October), else 1. Worked out here rather
    than from a tz database the box may not have."""
    def last_sunday(y: int, m: int) -> date:
        d = date(y, m + 1, 1) - timedelta(days=1) if m < 12 else date(y, 12, 31)
        return d - timedelta(days=(d.weekday() + 1) % 7)
    return 2 if last_sunday(day.year, 3) <= day < last_sunday(day.year, 10) else 1


def local_hour_utc(day: date, hour_local: int) -> datetime:
    """`hour_local` o'clock Amsterdam time on `day`, as a UTC datetime."""
    return datetime(day.year, day.month, day.day, hour_local, tzinfo=timezone.utc) - timedelta(hours=amsterdam_offset_hours(day))


def parse_length_hours(text) -> float | None:
    """"48 hours" -> 48, "7 days" -> 168, "24 hours" -> 24, "2 weeks" -> 336; None for anything else."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(hour|hr|day|week)s?\s*$", str(text or ""), re.I)
    if not m:
        return None
    n, unit = float(m.group(1)), m.group(2).lower()
    hours = n * {"hour": 1, "hr": 1, "day": 24, "week": 168}[unit]
    return hours if 1 <= hours <= 24 * 60 else None


def hours_words(h: float | None) -> str:
    if h is None:
        return ""
    if h % 24 == 0 and h >= 72:
        return f"{int(h // 24)} days"
    return f"{int(h) if float(h).is_integer() else h} hours"


# ---------------------------------------------------------------- the feeds' series

def load_series() -> dict | None:
    """The aggregation's three files, or None when it has not run."""
    if not (DAILY.exists() and RELEASES.exists()):
        return None
    daily = pd.read_csv(DAILY, low_memory=False)
    hourly = pd.read_csv(HOURLY, low_memory=False) if HOURLY.exists() else pd.DataFrame(columns=["release", "hour", "channel"])
    rel = pd.read_csv(RELEASES, low_memory=False)
    for f in (daily, hourly):
        f["group"] = f["channel"].map(GROUP_OF).fillna("untracked")
    daily["day"] = pd.to_datetime(daily["date"], errors="coerce").dt.date
    hourly["ts"] = pd.to_datetime(hourly["hour"], utc=True, errors="coerce")
    feed = {}
    try:
        feed = json.loads(FEED.read_text())
    except (OSError, ValueError):
        pass
    return {"daily": daily, "hourly": hourly, "releases": rel, "feed": feed,
            "by_release": {n: g for n, g in daily.groupby("release")},
            "hourly_by_release": {n: g for n, g in hourly.groupby("release")}}


def _rel_rows(series: dict, name: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    d = series["by_release"].get(name)
    h = series["hourly_by_release"].get(name)
    empty_d = series["daily"].iloc[0:0]
    empty_h = series["hourly"].iloc[0:0]
    return (d if d is not None else empty_d), (h if h is not None else empty_h)


# ---------------------------------------------------------------- dates and states

def _airtable_open(launch: dict | None) -> tuple[datetime | None, str]:
    """Airtable's open: the launch date at launch_time's time of day."""
    if not launch:
        return None, ""
    day = _day(launch.get("launch_date"))
    if day is None:
        return None, ""
    lt = _ts(launch.get("launch_time"))
    if lt is not None:
        return datetime(day.year, day.month, day.day, lt.hour, lt.minute, tzinfo=timezone.utc), "airtable"
    return None, ""


def open_from(launch: dict | None, feed_launch, typed=None) -> tuple[datetime | None, str, str]:
    """The window's open, where it came from (typed, airtable, feed, default)
    and a note. The feed's timestamp loses an hour in summer time (module
    docstring); a feed timestamp at midnight UTC is a date, not an hour."""
    t = _ts(typed)
    if t is not None:
        return t, "typed", ""
    at, src = _airtable_open(launch)
    if at is not None:
        return at, src, ""
    f = _ts(feed_launch)
    at_day = _day(launch.get("launch_date")) if launch else None
    if f is not None and (f.hour, f.minute) != (0, 0):
        # the feed's hour, less the hour it runs late in summer time; on
        # Airtable's launch date when Airtable has one (the spec's date; the
        # feed's own date can differ: Carrie Mae Weems' 2026 launch reads 25
        # November in the feed and 18 November in Airtable)
        late = timedelta(hours=1) if amsterdam_offset_hours(f.date()) == 2 else timedelta(0)
        hour = f - late
        if at_day is not None and at_day != f.date():
            opened = datetime(at_day.year, at_day.month, at_day.day, hour.hour, hour.minute, tzinfo=timezone.utc)
            return opened, "feed_hour", f"Airtable's launch date at the feed's launch hour; the feed dates the launch {f.date().isoformat()}"
        return hour, "feed", "the feed's launch time less the hour it runs late in summer time" if late else "the feed's launch time"
    day = at_day if at_day is not None else (f.date() if f is not None else None)
    if day is None:
        return None, "", ""
    return local_hour_utc(day, TL_DEFAULT_OPEN_LOCAL), "default", f"no opening time on file: {TL_DEFAULT_OPEN_LOCAL}:00 Amsterdam time assumed"


def length_from(launch: dict | None, open_dt: datetime | None, typed=None) -> tuple[float, str, str]:
    """The window's length in hours, its source and a note."""
    th = _num(typed)
    if th and th > 0:
        return float(th), "typed", ""
    if launch:
        h = parse_length_hours(launch.get("tl_length"))
        if h:
            return h, "airtable", ""
        end = _day(launch.get("tl_end_date"))
        if end and open_dt:
            hours = (datetime(end.year, end.month, end.day, open_dt.hour, open_dt.minute, tzinfo=timezone.utc) - open_dt).total_seconds() / 3600
            if 1 <= hours <= 24 * 60:
                return hours, "airtable_end", "from Airtable's end date"
    return TL_DEFAULT_HOURS, "default", f"no window length on file: {hours_words(TL_DEFAULT_HOURS)} assumed"


def airtable_announce(launch: dict | None, open_dt: datetime | None) -> date | None:
    """The latest announce date Airtable's records hold before the open: a
    stale earlier one can sit beside the current one."""
    if not launch:
        return None
    days = [d for d in (_day(x) for x in (launch.get("announce_dates") or [])) if d]
    if not days:
        d = _day(launch.get("announce_date"))
        days = [d] if d else []
    if open_dt:
        before = [d for d in days if d < open_dt.date()]
        days = before or days
    return max(days) if days else None


def infer_announce(daily: pd.DataFrame, open_dt: datetime) -> date | None:
    """The first day with TL_ANNOUNCE_MIN signups within TL_ANNOUNCE_LEAD days of the open."""
    if daily is None or not len(daily):
        return None
    by_day = daily.groupby("day")["signups"].sum()
    lo = open_dt.date() - timedelta(days=TL_ANNOUNCE_LEAD)
    hit = by_day[(by_day.index >= lo) & (by_day.index < open_dt.date()) & (by_day >= TL_ANNOUNCE_MIN)]
    return hit.index.min() if len(hit) else None


def early_access_from(hourly: pd.DataFrame, open_dt: datetime) -> datetime | None:
    """The first hour before the open, within TL_EA_WITHIN_HOURS of it, that sold TL_EA_MIN_PIECES pieces or more."""
    if hourly is None or not len(hourly):
        return None
    lo = open_dt - timedelta(hours=TL_EA_WITHIN_HOURS)
    win = hourly[(hourly["ts"] >= lo) & (hourly["ts"] < open_dt)]
    if not len(win):
        return None
    by_hour = win.groupby("ts")["units"].sum().sort_index()
    hit = by_hour[by_hour >= TL_EA_MIN_PIECES]
    return hit.index.min().to_pydatetime() if len(hit) else None


def tl_dates(launch: dict | None, feed_row: dict | None, inputs: dict | None, daily: pd.DataFrame, hourly: pd.DataFrame,
             now: datetime) -> dict:
    """Every date of a TL and where each came from (module docstring)."""
    inp = inputs or {}
    feed_launch = (feed_row or {}).get("feed_launch") or None
    open_dt, open_src, open_note = open_from(launch, feed_launch, inp.get("window_open"))
    hours, len_src, len_note = length_from(launch, open_dt, inp.get("window_hours"))
    close_dt = open_dt + timedelta(hours=hours) if open_dt else None
    notes = [n for n in (open_note, len_note) if n]
    # the announce
    ann_src, assumed = "", False
    ann = _day(inp.get("announce_date"))
    if ann:
        ann_src = "typed"
    if ann is None:
        ann = airtable_announce(launch, open_dt)
        ann_src = "airtable" if ann else ""
    if ann is None and (feed_row or {}).get("feed_announce"):
        ann = _day(feed_row["feed_announce"])
        ann_src = "feed" if ann else ""
    if ann is None and open_dt is not None:
        ann = infer_announce(daily, open_dt)
        if ann:
            ann_src = "signups"
            notes.append(f"no announce date on file: the pre-window starts on the first day with {TL_ANNOUNCE_MIN} or more signups ({ann.isoformat()})")
    if ann is None and open_dt is not None:
        ann = open_dt.date() - timedelta(days=TL_ASSUMED_PRE_DAYS)
        ann_src, assumed = "assumed", True
        notes.append(f"no announce date on file: {TL_ASSUMED_PRE_DAYS} days before the open assumed")
    if ann and open_dt and ann >= open_dt.date():
        notes.append(f"the announce date on file ({ann.isoformat()}) is not before the open; {TL_ASSUMED_PRE_DAYS} days before it assumed")
        ann = open_dt.date() - timedelta(days=TL_ASSUMED_PRE_DAYS)
        ann_src, assumed = "assumed", True
    # the early access: seen in the sales, else expected a day before the open
    ea, ea_assumed = None, False
    if open_dt is not None:
        ea = early_access_from(hourly, open_dt)
        if ea is None and now < open_dt:
            ea, ea_assumed = open_dt - timedelta(hours=TL_EA_HOURS), True
    sales_open = ea or open_dt
    settle = close_dt + timedelta(days=TL_SETTLE_DAYS) if close_dt else None
    airtable_open_dt, _ = _airtable_open(launch)
    feed_dt = _ts(feed_launch)
    return {
        "announce": ann, "announce_source": ann_src, "announce_assumed": assumed,
        "open": open_dt, "open_source": open_src, "hours": hours, "hours_source": len_src,
        "close": close_dt, "early_access": ea, "early_access_assumed": ea_assumed, "sales_open": sales_open,
        "settle": settle, "notes": notes,
        # the readings beside the one in force, for the drift notes on the tab
        "readings": {
            "announce": {"typed": _iso(_day(inp.get("announce_date"))), "airtable": _iso(airtable_announce(launch, open_dt)),
                         "feed": (feed_row or {}).get("feed_announce") or None},
            "open": {"typed": _iso(_ts(inp.get("window_open"))), "airtable": _iso(airtable_open_dt), "feed": _iso(feed_dt),
                     "feed_adjusted": _iso(feed_dt - timedelta(hours=1)) if feed_dt is not None and (feed_dt.hour, feed_dt.minute) != (0, 0)
                     and amsterdam_offset_hours(feed_dt.date()) == 2 else None},
            "hours": {"typed": _num(inp.get("window_hours")), "airtable": parse_length_hours((launch or {}).get("tl_length")),
                      "airtable_end": _iso(_day((launch or {}).get("tl_end_date")))},
        },
    }


def state_of(d: dict, now: datetime) -> str:
    if d.get("open") is None:
        return "upcoming"
    if d["announce"] and now.date() < d["announce"]:
        return "upcoming"
    if now < d["sales_open"]:
        return "signups"
    if now < d["close"]:
        return "window"
    if now < d["settle"]:
        return "settling"
    return "closed"


def tl_label(state: str, d: dict, now: datetime) -> str:
    """The sidebar's words for the state (spec §9)."""
    if state == "upcoming":
        if d.get("announce"):
            days = (d["announce"] - now.date()).days
            return f"announces in {days} d" if days > 0 else "announces today"
        return "upcoming"
    if state == "signups":
        hours = (d["sales_open"] - now).total_seconds() / 3600
        if hours < 36:
            return f"signups · opens in {max(int(round(hours)), 1)} h"
        return f"signups · opens in {int(round(hours / 24))} d"
    if state == "window":
        hours = (d["close"] - now).total_seconds() / 3600
        ea = d.get("early_access") and now < d["open"]
        return f"{'early access' if ea else 'window open'} · {max(int(math.ceil(hours)), 1)} h left"
    if state == "settling":
        return f"settling · {max((d['settle'] - now).days, 0)} d"
    return "closed"


# ---------------------------------------------------------------- Airtable's timed launches

def timed_launches(launch_frame: pd.DataFrame | None) -> pd.DataFrame:
    if launch_frame is None or not len(launch_frame):
        return pd.DataFrame()
    return launch_frame[launch_frame["launch_type"].astype(str).str.strip().str.lower() == "timed"].copy()


def _launch_dict(row) -> dict:
    out = {}
    for k, v in dict(row).items():
        if isinstance(v, (set, list, tuple, dict)):
            out[k] = list(v) if isinstance(v, (set, tuple)) else v
        elif isinstance(v, pd.Timestamp):
            out[k] = None if pd.isna(v) else v.isoformat()
        elif isinstance(v, float) and math.isnan(v):
            out[k] = None
        else:
            out[k] = v
    return out


def match_feed_to_airtable(releases: pd.DataFrame, timed: pd.DataFrame) -> dict[str, dict]:
    """release name -> the Airtable timed launch it matched (etl/pricing.py match)."""
    if not len(releases) or not len(timed):
        return {}
    frame = pd.DataFrame({
        "release_name": releases["release"].astype(str), "artist": releases["artist"].astype(str),
        "title": releases["title"].fillna("").astype(str), "quarter": releases["quarter"].fillna("").astype(str),
        # the window the matcher tests Airtable's launch date against: the feed's own open
        "announce": pd.to_datetime(releases["feed_announce"], errors="coerce"),
        "close": pd.to_datetime(releases["feed_launch"], errors="coerce").dt.tz_localize(None),
    })
    frame["announce"] = frame["announce"].fillna(frame["close"] - pd.Timedelta(days=TL_ASSUMED_PRE_DAYS))
    res = pricing.match(frame, timed)
    by_ids = {str(r["airtable_ids"]): r for _, r in timed.iterrows()}
    out = {}
    for name, ids, how in zip(frame["release_name"], res["airtable_ids"], res["price_match"]):
        if not isinstance(ids, str) or not ids or how == "none":
            continue
        # a merged match carries several launches' ids joined with |: take the launch holding the first
        first = ids.split("|")[0]
        hit = next((r for k, r in by_ids.items() if first in k.split("|")), None)
        if hit is not None:
            d = _launch_dict(hit)
            d["price_match"] = how
            out[name] = d
    return out


# ---------------------------------------------------------------- campaign codes

def code_activity(spend: pd.DataFrame | None, emails: pd.DataFrame | None) -> dict[str, tuple[date, date]]:
    """When each campaign code spent on Meta or sent an email: first and last day."""
    lo: dict[str, date] = {}
    hi: dict[str, date] = {}

    def take(code: str, day) -> None:
        d = _day(day)
        if not code or d is None:
            return
        lo[code] = min(lo.get(code, d), d)
        hi[code] = max(hi.get(code, d), d)

    if spend is not None and len(spend) and {"campaign_name", "spend_date"} <= set(spend.columns):
        spent = spend[pd.to_numeric(spend["spend"], errors="coerce") > 0] if "spend" in spend.columns else spend
        for name, day in zip(spent["campaign_name"], spent["spend_date"]):
            if isinstance(name, str):
                take(code_of(name), day)
    if emails is not None and len(emails) and {"campaign", "sent_at"} <= set(emails.columns):
        for code, day in zip(emails["campaign"], emails["sent_at"]):
            if isinstance(code, str):
                take(code.strip(), day)
    return {c: (lo[c], hi[c]) for c in lo}


def _compact(text: str) -> str:
    """Letters and digits only, accents folded ("Tomás Sánchez" -> "tomassanchez")."""
    return re.sub(r"[^a-z0-9]", "", pricing.norm(text))


def code_of(campaign_name: str) -> str:
    """The campaign code a Meta campaign name starts with: "<code> · Sign-ups",
    "<code>· Sign-ups" (a space missing), "<code> - Sign-ups"."""
    n = str(campaign_name or "")
    if "·" in n:
        return n.split("·")[0].strip()
    return re.split(r"\s-\s", n)[0].strip()


def guess_tl_code(artist: str, open_dt: datetime | None, activity: dict[str, tuple[date, date]], taken: set[str] = frozenset(),
                  titles: str | None = None, airtable_code: str | None = None, announce: date | None = None) -> str | None:
    """The campaign code of a timed launch, from the codes that spent on Meta
    or sent an email: one whose first segment and the artist's name (or
    Airtable's release code) start the same way - BisaButler_TL_26,
    GregoryCrewd_TL_26, HarmoniaR_Two_25 for Harmonia, TOMASTLE24 for Tomás
    Sánchez, PietParra_Dip_25 beside Airtable's PietParraDip25 - and that
    moved between 45 days before the open and a week after the close. Among
    several, one naming a word of the launch's titles wins (AiWeiwei_Guardian2_26
    for the Guardians over the artist's other codes), else the one whose
    activity began nearest the announce: a code's emails can run on for
    months after its launch, so its end says little."""
    if not artist or open_dt is None:
        return None
    keys = {k for k in (_compact(artist), _compact(airtable_code or "")) if len(k) >= 4}
    words = {w for w in re.findall(r"[a-z0-9]{4,}", pricing.norm(titles or "")) if w not in ("multiple", "untitled", "edition", "print", "prints")}
    ann = announce or (open_dt.date() - timedelta(days=TL_ASSUMED_PRE_DAYS))
    lo, hi = open_dt.date() - timedelta(days=TL_ANNOUNCE_LEAD), open_dt.date() + timedelta(days=7)
    best, best_rank = None, None
    for code, (a, b) in activity.items():
        if code in taken or b < lo or a > hi:
            continue
        seg = _compact(re.split(r"[_\s]", code)[0])
        seg = re.sub(r"(tle?|timed|le)?\d*$", "", seg) or seg
        if len(seg) < 4:
            continue
        if not any(k.startswith(seg) or (len(seg) >= 5 and seg.startswith(k)) for k in keys):
            continue
        titled = any(w in _compact(code) for w in words)
        rank = (0 if titled else 1, abs((a - ann).days))
        if best_rank is None or rank < best_rank:
            best, best_rank = code, rank
    return best


def code_spend(spend: pd.DataFrame | None, code: str | None, names: list[str] | None = None) -> pd.DataFrame:
    """The spend rows of a campaign code (every objective), or of the campaign names chosen."""
    if spend is None or not len(spend) or not (code or names):
        return pd.DataFrame(columns=["campaign_name", "spend_date", "spend"])
    sp = spend.copy()
    sp["code"] = sp["campaign_name"].astype(str).map(code_of)
    if names:
        sp = sp[sp["campaign_name"].isin(names)]
    else:
        sp = sp[sp["code"] == code]
    sp["day"] = pd.to_datetime(sp["spend_date"], errors="coerce").dt.date
    sp["spend"] = pd.to_numeric(sp["spend"], errors="coerce").fillna(0.0)
    return sp


# ---------------------------------------------------------------- per-release measures

def _pre_window(daily: pd.DataFrame, hourly: pd.DataFrame, sales_open: datetime, to: datetime | None = None) -> pd.DataFrame:
    """The daily rows before the sales open, with the open day's hours before it
    where the hourly file has them (else the whole day stays out)."""
    cut = to if to is not None and to < sales_open else sales_open
    before = daily[daily["day"] < cut.date()]
    same_day = hourly[(hourly["ts"].dt.date == cut.date()) & (hourly["ts"] < cut)] if len(hourly) else hourly
    cols = ["group", "channel", "sessions", "page_views", "signups", "signups_converted", "orders", "units"]
    frames = [f[[c for c in cols if c in f.columns]] for f in (before, same_day) if len(f)]
    return pd.concat(frames, ignore_index=True) if frames else daily.iloc[0:0]


def _window(hourly: pd.DataFrame, sales_open: datetime, until: datetime) -> pd.DataFrame:
    if not len(hourly):
        return hourly
    return hourly[(hourly["ts"] >= sales_open) & (hourly["ts"] < until)]


def _by_group(frame: pd.DataFrame, col: str) -> dict[str, float]:
    out = {g: 0.0 for g in GROUPS}
    out["untracked"] = 0.0
    if len(frame) and col in frame.columns:
        for g, v in frame.groupby("group")[col].sum().items():
            out[g if g in out else "untracked"] = out.get(g if g in out else "untracked", 0.0) + float(v)
    return out


def _shares(d: dict[str, float]) -> dict[str, float]:
    tot = sum(d.get(g, 0.0) for g in GROUPS)
    return {g: (d.get(g, 0.0) / tot if tot > 0 else 0.0) for g in GROUPS}


def signup_curve(daily: pd.DataFrame, hourly: pd.DataFrame, sales_open: datetime, total: float) -> tuple[list, list]:
    """Cumulative pre-window signups by day to the sales open (CURVE_DAYS): the
    count and its share of the pre-window total."""
    pre = _pre_window(daily, hourly, sales_open)
    if not len(pre):
        return [0.0] * len(CURVE_DAYS), [0.0] * len(CURVE_DAYS)
    by_day = daily.groupby("day")["signups"].sum()
    open_day = sales_open.date()
    counts = []
    for d in CURVE_DAYS:
        if d == 0:
            counts.append(float(pre["signups"].sum()))
        else:
            counts.append(float(by_day[by_day.index <= open_day + timedelta(days=d)].sum()))
    shares = [c / total if total > 0 else 0.0 for c in counts]
    return counts, shares


def units_curve(hourly: pd.DataFrame, sales_open: datetime, close: datetime, total: float) -> list[float]:
    """Cumulative window units by share of the window (CURVE_FRACS)."""
    if not len(hourly) or total <= 0:
        return [0.0] * len(CURVE_FRACS)
    win = _window(hourly, sales_open, close)
    span = (close - sales_open).total_seconds()
    out = []
    for f in CURVE_FRACS:
        until = sales_open + timedelta(seconds=span * f)
        out.append(float(win.loc[win["ts"] < until, "units"].sum()) / total)
    return out


# ---------------------------------------------------------------- the panel (spec §8)

def panel_frame(series: dict, timed: pd.DataFrame, spend: pd.DataFrame | None, emails: pd.DataFrame | None,
                as_of: date, now: datetime) -> tuple[pd.DataFrame, dict]:
    """Every completed TL as a comparable, with its measures; and the pace
    curves per member (CURVES). Counts only."""
    rel = series["releases"]
    matched = match_feed_to_airtable(rel, timed)
    activity = code_activity(spend, emails)
    rows, curves = [], {}
    taken_codes: set[str] = set()
    for r in map(_clean, rel.sort_values("feed_launch").to_dict("records")):
        name = str(r["release"])
        if "test" in name.lower() or not r.get("feed_launch"):
            continue
        daily, hourly = _rel_rows(series, name)
        launch = matched.get(name)
        d = tl_dates(launch, r, None, daily, hourly, now)
        if d["open"] is None or d["settle"] is None or d["settle"] > now:
            continue   # still in flight or unsettled: not a comparable yet
        pre = _pre_window(daily, hourly, d["sales_open"])
        signups = float(pre["signups"].sum()) if len(pre) else 0.0
        if signups < TL_PANEL_MIN_SIGNUPS:
            continue
        win = _window(hourly, d["sales_open"], d["close"])
        settled = _window(hourly, d["sales_open"], d["settle"])
        units = float(settled["units"].sum()) if len(settled) else float(r.get("units") or 0)
        orders = float(settled["orders"].sum()) if len(settled) else float(r.get("orders") or 0)
        sg, ug = _by_group(pre, "signups"), _by_group(settled, "units")
        sess = _by_group(pre, "sessions")
        conv_g = _by_group(pre, "signups_converted")
        ss, us, sess_s = _shares(sg), _shares(ug), _shares(sess)
        # a group's session -> signup rate needs sessions to read it from, and
        # the feed names the release on fewer sessions than signups for some
        # launches, so a rate past RATE_MAX_PER_SESSION is unread, not a rate
        conv = {g: (sg[g] / sess[g] if sess[g] >= RATE_MIN_SESSIONS and sg[g] > 0 and sg[g] / sess[g] <= RATE_MAX_PER_SESSION else float("nan")) for g in GROUPS}
        s2o_g = {g: (conv_g[g] / sg[g] if sg[g] >= RATE_MIN_SIGNUPS else float("nan")) for g in GROUPS}
        converted = float(pre["signups_converted"].sum()) if len(pre) and "signups_converted" in pre.columns else float("nan")
        untracked_share = sg.get("untracked", 0.0) / signups if signups > 0 else 0.0
        code = guess_tl_code(str(r["artist"]), d["open"], activity, taken_codes, titles=f"{(launch or {}).get('titles') or ''} {r.get('title') or ''}",
                             airtable_code=(launch or {}).get("airtable_release"), announce=d["announce"])
        if code:
            taken_codes.add(code)
        sp = code_spend(spend, code)
        spend_pre = float(sp.loc[sp["day"] < d["sales_open"].date(), "spend"].sum()) if len(sp) else 0.0
        spend_win = float(sp.loc[(sp["day"] >= d["sales_open"].date()) & (sp["day"] <= d["close"].date()), "spend"].sum()) if len(sp) else 0.0
        # what the spend bought, with the untracked signups folded in at the
        # tracked paid share (as the LE panel folds its untracked units): a
        # launch whose signups mostly carry no channel still priced its paid ones
        paid_signups = ss["paid"] * signups
        paid_units = us["paid"] * float(settled["units"].sum()) if len(settled) else 0.0
        cps = spend_pre / paid_signups if spend_pre > 0 and paid_signups >= PAID_COST_MIN_SIGNUPS else float("nan")
        cpu = spend_win / paid_units if spend_win > 0 and paid_units >= PAID_COST_MIN_UNITS else float("nan")
        pre_days = (d["sales_open"].date() - d["announce"]).days if d["announce"] else None
        counts, shares = signup_curve(daily, hourly, d["sales_open"], signups)
        curves[name] = {"signups": shares, "signups_count": counts,
                        "units": units_curve(hourly, d["sales_open"], d["close"], float(win["units"].sum()) if len(win) else 0.0)}
        row = {
            "release_name": name, "artist": r["artist"], "title": r["title"], "quarter": r["quarter"],
            "airtable_release": (launch or {}).get("airtable_release"), "campaign_code": code,
            "announce": _iso(d["announce"]), "open": _iso(d["open"]), "sales_open": _iso(d["sales_open"]), "close": _iso(d["close"]),
            "window_hours": d["hours"], "early_access": d["early_access"] is not None, "pre_days": pre_days,
            "announce_source": d["announce_source"], "open_source": d["open_source"],
            "signups": signups, "signups_unique": _num(r.get("signups_unique_pre")), "sessions": float(pre["sessions"].sum()) if len(pre) else 0.0,
            "signup_order_rate": (converted / signups) if signups > 0 and not math.isnan(converted) else float("nan"),
            "units": units, "orders": orders, "purchases_per_order": (units / orders) if orders > 0 else float("nan"),
            "units_window": float(win["units"].sum()) if len(win) else 0.0,
            "units_private": float(settled["units_private"].sum()) if len(settled) and "units_private" in settled.columns else 0.0,
            "buyers_unique": _num(r.get("buyers_unique")), "buyers_multiple": _num(r.get("buyers_multiple")),
            "multiple_share": (float(r["buyers_multiple"]) / float(r["buyers_unique"])) if _num(r.get("buyers_unique")) else float("nan"),
            "spend_pre": spend_pre, "spend_window": spend_win, "cost_per_signup": cps, "cost_per_sale": cpu,
            "paid_share_signups": ss["paid"], "paid_share_units": us["paid"], "untracked_share": untracked_share,
            "units_target": _num((launch or {}).get("units_target")), "edition_size": _num((launch or {}).get("edition_size")),
            "unit_price_eur": _num((launch or {}).get("unit_price_eur")), "launch_value_eur": _num((launch or {}).get("launch_value_eur")),
        }
        for g in GROUPS:
            row[f"signups_{g}"] = sg[g]; row[f"sess_share_{g}"] = sess_s[g]; row[f"signup_share_{g}"] = ss[g]
            row[f"unit_share_{g}"] = us[g]; row[f"conv_sess_signup_{g}"] = conv[g]; row[f"sessions_{g}"] = sess[g]
            row[f"signup_order_rate_{g}"] = s2o_g[g]
        rows.append(row)
    panel = pd.DataFrame(rows)
    if len(panel):
        panel = panel.sort_values("open").reset_index(drop=True)
    return panel, curves


def _median(rows: pd.DataFrame, col: str, positive: bool = False) -> float:
    if col not in rows.columns or not len(rows):
        return 0.0
    vals = pd.to_numeric(rows[col], errors="coerce").dropna()
    if positive:
        vals = vals[vals > 0]
    return float(vals.median()) if len(vals) else 0.0


def _median_shares(rows: pd.DataFrame, prefix: str) -> dict[str, float]:
    raw = {g: _median(rows, f"{prefix}{g}") for g in GROUPS}
    tot = sum(raw.values())
    return {g: (raw[g] / tot if tot > 0 else 0.0) for g in GROUPS}


def _median_curve(curves: dict, members: list[str], key: str, n: int) -> list[float]:
    arr = [curves[m][key] for m in members if m in curves and len(curves[m].get(key) or []) == n]
    if not arr:
        return [0.0] * n
    return [float(v) for v in np.median(np.array(arr, dtype=float), axis=0)]


def basket_profile(panel: pd.DataFrame, curves: dict, members: list[str]) -> dict:
    """The medians for one TL basket (spec §8). JSON-ready."""
    wanted = [str(m) for m in (members or [])]
    rows = panel[panel["release_name"].isin(wanted)] if len(panel) and wanted else panel.iloc[0:0]
    used = rows["release_name"].tolist()
    signups = _median(rows, "signups")
    sessions = _median(rows, "sessions")
    units = _median(rows, "units")
    ss, sess_s, us = _median_shares(rows, "signup_share_"), _median_shares(rows, "sess_share_"), _median_shares(rows, "unit_share_")
    n_cps = int((pd.to_numeric(rows.get("cost_per_signup"), errors="coerce") > 0).sum()) if len(rows) else 0
    n_cpu = int((pd.to_numeric(rows.get("cost_per_sale"), errors="coerce") > 0).sum()) if len(rows) else 0
    return {
        "n": len(used), "members": used,
        "signups": signups, "signups_p25": float(pd.to_numeric(rows["signups"], errors="coerce").quantile(0.25)) if len(rows) else 0.0,
        "signups_p75": float(pd.to_numeric(rows["signups"], errors="coerce").quantile(0.75)) if len(rows) else 0.0,
        "sessions": sessions, "units": units, "orders": _median(rows, "orders"),
        "units_target": _median(rows, "units_target", positive=True), "price": _median(rows, "unit_price_eur", positive=True),
        "window_hours": _median(rows, "window_hours", positive=True), "pre_days": _median(rows, "pre_days", positive=True),
        "early_access_share": float(rows["early_access"].astype(bool).mean()) if len(rows) else 0.0,
        "signup_order_rate": _median(rows, "signup_order_rate", positive=True),
        "purchases_per_order": _median(rows, "purchases_per_order", positive=True),
        "multiple_share": _median(rows, "multiple_share"),
        "share_signups": ss, "share_sessions": sess_s, "share_units": us,
        "signups_by_group": {g: ss[g] * signups for g in GROUPS},
        "sessions_by_group": {g: sess_s[g] * sessions for g in GROUPS},
        "units_by_group": {g: us[g] * units for g in GROUPS},
        "conv": {g: _median(rows, f"conv_sess_signup_{g}", positive=True) for g in GROUPS},
        # each group's signup -> order rate: a paid signup converts at a fraction of an email one
        "signup_order_rate_by_group": {g: _median(rows, f"signup_order_rate_{g}", positive=True) for g in GROUPS},
        "paid_share_signups": ss["paid"], "paid_share_units": us["paid"],
        "untracked_share": _median(rows, "untracked_share"),
        "cost_per_signup": _median(rows, "cost_per_signup", positive=True) if n_cps >= PAID_COST_MIN_MEMBERS else 0.0,
        "cost_per_sale": _median(rows, "cost_per_sale", positive=True) if n_cpu >= PAID_COST_MIN_MEMBERS else 0.0,
        "n_cost_per_signup": n_cps, "n_cost_per_sale": n_cpu,
        "spend_pre": _median(rows, "spend_pre", positive=True), "spend_window": _median(rows, "spend_window", positive=True),
        "curve_days": CURVE_DAYS, "signup_curve": _median_curve(curves, used, "signups", len(CURVE_DAYS)),
        "signup_curve_count": _median_curve(curves, used, "signups_count", len(CURVE_DAYS)),
        "curve_fracs": CURVE_FRACS, "unit_curve": _median_curve(curves, used, "units", len(CURVE_FRACS)),
    }


def channels_off_of(inputs: dict | None) -> list[str]:
    raw = (inputs or {}).get("channels_off") or []
    if isinstance(raw, str):
        raw = [raw]
    wanted = {str(g).strip() for g in raw}
    return [g for g in GROUPS if g in wanted]


def apply_channels_off(profile: dict, off: list[str]) -> dict:
    """The basket read without the groups set aside: their medians to zero,
    the headlines to what the rest add up to, the shares renormalised."""
    out = dict(profile)
    out["channels_off"] = list(off)
    out["signups_all"], out["sessions_all"], out["units_all"] = profile["signups"], profile["sessions"], profile["units"]
    out["signups_by_group_all"] = dict(profile["signups_by_group"])
    out["sessions_by_group_all"] = dict(profile["sessions_by_group"])
    out["units_by_group_all"] = dict(profile["units_by_group"])
    out["conv_all"] = dict(profile["conv"])
    out["signup_order_rate_by_group_all"] = dict(profile.get("signup_order_rate_by_group") or {})
    if not off:
        return out
    keep = [g for g in GROUPS if g not in off]
    for key, tot_key in (("signups_by_group", "signups"), ("sessions_by_group", "sessions"), ("units_by_group", "units")):
        full = profile[key]
        out[key] = {g: (full[g] if g in keep else 0.0) for g in GROUPS}
        out[tot_key] = sum(out[key][g] for g in keep)
    for key in ("share_signups", "share_sessions", "share_units"):
        raw = {g: (profile[key][g] if g in keep else 0.0) for g in GROUPS}
        tot = sum(raw.values())
        out[key] = {g: (raw[g] / tot if tot > 0 else 0.0) for g in GROUPS}
    out["conv"] = {g: (profile["conv"][g] if g in keep else 0.0) for g in GROUPS}
    out["signup_order_rate_by_group"] = {g: (profile.get("signup_order_rate_by_group", {}).get(g, 0.0) if g in keep else 0.0) for g in GROUPS}
    out["paid_share_signups"] = out["share_signups"]["paid"]
    out["paid_share_units"] = out["share_units"]["paid"]
    return out


# ---------------------------------------------------------------- baskets

def _ready(bid: str, name: str, desc: str, members: list[str], panel: pd.DataFrame, curves: dict, **extra) -> dict:
    out = {"id": bid, "kind": "ready", "name": name, "desc": desc, "members": members, "n": len(members),
           "disabled": len(members) < 1, "thin": 0 < len(members) < TL_THIN, "profile": basket_profile(panel, curves, members)}
    out.update(extra)
    return out


def similar_members(pool: pd.DataFrame, units_target: float | None, price: float | None, n: int = TL_SIMILAR_N,
                    as_of: date | None = None) -> list[str]:
    """The n launches nearest this one on units target and price: the larger
    of the two multiples, each taken above 1 whichever side it falls. Among
    the near ones (within NEAR on both) a launch that closed in the last 18
    months ranks first, as the LE baskets prefer recent comparables."""
    if not len(pool):
        return []
    size = units_target if units_target and units_target > 0 else None
    units = pd.to_numeric(pool["units_target"], errors="coerce").fillna(pd.to_numeric(pool["units"], errors="coerce")).to_numpy(dtype=float)
    prices = pd.to_numeric(pool["unit_price_eur"], errors="coerce").to_numpy(dtype=float)

    def mult(vals, ref):
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.maximum(vals / ref, ref / vals)
        return np.where((vals > 0) & np.isfinite(r), r, np.inf)

    d = mult(units, size) if size else np.ones(len(pool))
    if price and price > 0 and np.isfinite(prices).any():
        dp = mult(prices, price)
        d = np.maximum(d, np.where(np.isfinite(dp), dp, 1.0))
    closes = pd.to_datetime(pool["close"], utc=True, errors="coerce").dt.date.to_numpy()
    cutoff = (as_of or date.today()) - timedelta(days=RECENT_DAYS)
    recent = np.array([c is not None and not pd.isna(c) and c >= cutoff for c in closes])
    rank = [((0 if (d[i] <= NEAR and recent[i]) else 1 if d[i] <= NEAR else 2), d[i]) for i in range(len(pool))]
    order = sorted(range(len(pool)), key=lambda i: rank[i])
    names = pool["release_name"].to_numpy()
    return [str(names[i]) for i in order[:n] if np.isfinite(d[i])]


def ready_baskets(panel: pd.DataFrame, curves: dict, release: dict, as_of: date) -> list[dict]:
    """The ready-made TL baskets for a release (spec §8), in picker order:
    launches of the same window length (falling back to every TL when thin),
    the nearest by target and price, the last twelve months, the artist's own,
    every completed TL."""
    own = str(release.get("release_name") or "")
    open_dt = _ts(release.get("window_open"))
    pool = panel[panel["release_name"] != own] if len(panel) else panel
    if open_dt is not None and len(pool):
        pool = pool[pd.to_datetime(pool["close"], utc=True, errors="coerce") < open_dt]
    hours = _num(release.get("window_hours"))
    out = []
    same_len = pool[np.isclose(pd.to_numeric(pool["window_hours"], errors="coerce").fillna(-1), hours or -2)] if len(pool) else pool
    fell_back = hours is not None and len(same_len) < TL_THIN
    pool_len = pool if fell_back or hours is None else same_len
    members = similar_members(pool_len, _num(release.get("units_target")), _num(release.get("unit_price_eur")), as_of=as_of)
    desc = (f"The {len(members)} completed timed launches nearest this one on units target and price"
            + (f", among the {hours_words(hours)} launches" if hours and not fell_back else "")
            + (f"; fewer than {TL_THIN} {hours_words(hours)} launches on file, so every length counts" if fell_back else "") + ".")
    out.append(_ready("similar_size", "Similar size and shape", desc, members, panel, curves, fallback=fell_back,
                      matchedOn=["target", "price"] if _num(release.get("unit_price_eur")) else ["target"]))
    if hours:
        out.append(_ready("same_length", f"{hours_words(hours).capitalize()} launches",
                          f"Every completed {hours_words(hours)} timed launch on file.", same_len["release_name"].tolist(), panel, curves))
    cutoff = as_of - timedelta(days=365)
    closes = pd.to_datetime(pool["close"], utc=True, errors="coerce").dt.date if len(pool) else pd.Series(dtype=object)
    recent = pool[(closes >= cutoff)] if len(pool) else pool
    out.append(_ready("all_12m", "Last 12 months", "Every timed launch completed in the last twelve months.", recent["release_name"].tolist(), panel, curves))
    artist = str(release.get("artist") or "").strip().casefold()
    same = pool[pool["artist"].astype(str).str.strip().str.casefold() == artist] if artist and len(pool) else pool.iloc[0:0]
    out.append(_ready("same_artist", "Same artist, earlier launches", f"{release.get('artist') or 'This artist'}'s previous timed launches on file.",
                      same["release_name"].tolist(), panel, curves))
    out.append(_ready("all_tl", "All timed launches", "Every completed timed launch on file.", pool["release_name"].tolist(), panel, curves))
    return out


def resolve_basket(spec: dict | None, panel: pd.DataFrame, curves: dict, release: dict, as_of: date) -> dict:
    """The basket a TL is benchmarked against: its saved spec where it can be
    honoured, else the suggestion (similar_size), and the list to pick from."""
    ready = ready_baskets(panel, curves, release, as_of)
    by_id = {b["id"]: b for b in ready}
    suggested = "similar_size" if by_id.get("similar_size", {}).get("n") else next((b["id"] for b in ready if b["n"]), "all_tl")
    chosen = None
    if isinstance(spec, dict):
        kind = str(spec.get("kind") or "ready")
        if kind == "bespoke":
            known = set(panel["release_name"].astype(str)) if len(panel) else set()
            members = [str(m) for m in (spec.get("members") or []) if str(m) in known and str(m) != release.get("release_name")]
            if members:
                chosen = {"id": str(spec.get("id") or "bespoke"), "kind": "bespoke", "name": str(spec.get("name") or "Bespoke basket"),
                          "desc": "The launches picked by hand.", "members": members, "n": len(members), "thin": len(members) < TL_THIN,
                          "profile": basket_profile(panel, curves, members)}
        else:
            hit = by_id.get(str(spec.get("id") or ""))
            if hit and hit["n"]:
                chosen = hit
    fallback = chosen is None
    if chosen is None:
        chosen = by_id.get(suggested) or ready[-1]
    return {"basket": chosen, "suggested": suggested, "fell_back": fallback and isinstance(spec, dict), "ready": ready}


# ---------------------------------------------------------------- targets (spec §7)

def allocate_stretch(bm_by_group: dict, size: float, weights: dict) -> dict:
    """Each group's target: its benchmark plus its share of the gap to `size`."""
    total = sum(bm_by_group.get(g, 0.0) for g in GROUPS)
    gap = size - total
    return {g: max(bm_by_group.get(g, 0.0) + weights.get(g, 0.0) * gap, 0.0) for g in GROUPS}


def stretch_weights(inputs: dict | None, bm_by_group: dict) -> dict:
    """stretch_from over the groups with a benchmark to lift, renormalised; else the basket's own shares."""
    total = sum(v for v in bm_by_group.values() if v > 0)
    even = {g: (bm_by_group[g] / total if total > 0 and bm_by_group[g] > 0 else 0.0) for g in GROUPS}
    raw = (inputs or {}).get("stretch_from")
    if not isinstance(raw, dict):
        return even
    w = {g: (max(_num(raw.get(g), 0.0) or 0.0, 0.0) if bm_by_group.get(g, 0.0) > 0 else 0.0) for g in GROUPS}
    s = sum(w.values())
    return {g: w[g] / s for g in GROUPS} if s > 0 else even


def tl_targets(inputs: dict | None, airtable_units_target: float | None, profile: dict, launch_value: float | None = None) -> dict | None:
    """The TL target model (module docstring). `profile` is the basket read
    with the channels off applied. None without a units target."""
    inp = inputs or {}
    units = _num(inp.get("units_target")) or airtable_units_target
    if not units or units <= 0:
        return None
    ppo_typed = _num(inp.get("purchases_per_order"))
    ppo = ppo_typed if ppo_typed and ppo_typed > 0 else (profile.get("purchases_per_order") or 1.0)
    s2o_typed = _num(inp.get("signup_order_rate"))
    # the rate the plan's mix of signups converts at: each group's own rate
    # weighted by the basket's share of signups from it (a paid signup converts
    # at a fraction of an email one, so a paid-led plan needs more signups per
    # order); the basket's overall median where a group has no rate
    by_g = profile.get("signup_order_rate_by_group") or {}
    shares = profile.get("share_signups") or {}
    rated = {g: shares.get(g, 0.0) for g in GROUPS if by_g.get(g, 0) > 0 and shares.get(g, 0) > 0}
    blended = (sum(shares[g] * by_g[g] for g in rated) / sum(rated.values())) if rated and sum(rated.values()) > 0 else 0.0
    s2o_src = "release" if s2o_typed and 0 < s2o_typed <= 1 else ("basket_mix" if blended > 0 else ("basket" if profile.get("signup_order_rate") else "none"))
    s2o = s2o_typed if s2o_typed and 0 < s2o_typed <= 1 else (blended or profile.get("signup_order_rate") or 0.0)
    orders = units / ppo
    signup_target = orders / s2o if s2o > 0 else None
    bm_signups = float(profile.get("signups") or 0.0)
    bm_by_group = {g: float(profile["signups_by_group"].get(g, 0.0)) for g in GROUPS}
    weights = stretch_weights(inp, bm_by_group)
    groups = allocate_stretch(bm_by_group, signup_target, weights) if signup_target else {g: 0.0 for g in GROUPS}
    k = signup_target / bm_signups if signup_target and bm_signups > 0 else None
    conv = profile.get("conv") or {}
    sessions = {g: (groups[g] / conv[g] if conv.get(g, 0) > 0 else None) for g in GROUPS}
    cps_typed = _num(inp.get("cost_per_signup"))
    cps = cps_typed if cps_typed and cps_typed > 0 else float(profile.get("cost_per_signup") or 0.0)
    cps_src = "release" if cps_typed and cps_typed > 0 else ("basket" if profile.get("cost_per_signup") else "none")
    cpu_typed = _num(inp.get("cost_per_purchase"))
    cpu = cpu_typed if cpu_typed and cpu_typed > 0 else float(profile.get("cost_per_sale") or 0.0)
    cpu_src = "release" if cpu_typed and cpu_typed > 0 else ("basket" if profile.get("cost_per_sale") else "none")
    paid_units = float(profile.get("share_units", {}).get("paid", 0.0)) * units
    # paid set aside: no paid signups, no paid units, no budget at all
    paid_off = "paid" in (profile.get("channels_off") or [])
    budget_pre = groups["paid"] * cps if cps > 0 and not paid_off else None
    budget_win = paid_units * cpu if cpu > 0 and not paid_off else None
    total_budget = (budget_pre or 0.0) + (budget_win or 0.0)
    any_budget = budget_pre is not None or budget_win is not None
    max_pct = float(BENCH.get("budget_sense_check_max_pct_of_launch_value") or 0.06)
    return {
        "units_target": units, "units_target_source": "release" if _num(inp.get("units_target")) else "airtable",
        "purchases_per_order": ppo, "purchases_per_order_source": "release" if ppo_typed else ("basket" if profile.get("purchases_per_order") else "default"),
        "signup_order_rate": s2o, "signup_order_rate_source": s2o_src, "signup_order_rate_by_group": {g: by_g.get(g, 0.0) for g in GROUPS},
        "signup_order_rate_median": profile.get("signup_order_rate") or 0.0,
        "orders_needed": orders, "signup_target": signup_target,
        "k": k, "stretch_from": weights, "stretch_typed": isinstance(inp.get("stretch_from"), dict) and any((_num(v) or 0) > 0 for v in inp["stretch_from"].values()),
        "signups_by_group": groups, "sessions_by_group": sessions,
        "sessions_needed": sum(v for v in sessions.values() if v) if any(sessions.values()) else None,
        "paid_signups": groups["paid"], "paid_units": paid_units,
        "cost_per_signup": cps if cps > 0 else None, "cost_per_signup_source": cps_src,
        "cost_per_sale": cpu if cpu > 0 else None, "cost_per_sale_source": cpu_src,
        "budget_pre": budget_pre, "budget_window": budget_win, "budget_total": total_budget if any_budget else None,
        "budget_pct_of_launch_value": (total_budget / launch_value) if launch_value and any_budget else None,
        "sense_check_breached": bool(launch_value and any_budget and total_budget / launch_value > max_pct),
        "cannibalisation": _num(inp.get("cannibalisation")) if _num(inp.get("cannibalisation")) is not None else TL_CANNIBALISATION,
        "benchmark": {"signups": bm_signups, "signups_by_group": bm_by_group, "sessions": float(profile.get("sessions") or 0.0),
                      "units": float(profile.get("units") or 0.0), "paid_signups": bm_by_group["paid"],
                      "budget_pre": bm_by_group["paid"] * cps if cps > 0 else None},
    }


# ---------------------------------------------------------------- the TL releases

def tl_releases(series: dict | None, launch_frame: pd.DataFrame | None, inputs: list[dict], as_of: date, now: datetime,
                spend: pd.DataFrame | None = None, emails: pd.DataFrame | None = None) -> list[dict]:
    """Every TL the dashboard lists: the feed's releases (matched to Airtable's
    timed launches) and the timed launches Airtable knows and the feed does
    not yet, within TL_UPCOMING_DAYS. Each record carries its name, id, the
    Airtable launch, the feed's row, the saved inputs and its dates."""
    timed = timed_launches(launch_frame)
    rel = series["releases"] if series else pd.DataFrame(columns=["release"])
    matched = match_feed_to_airtable(rel, timed) if len(rel) else {}
    saved = {r["release_name"]: r for r in inputs if r.get("release_name")}
    saved_ids = {r["id"]: r for r in inputs if r.get("id")}
    activity = code_activity(spend, emails)
    out, used_ids, taken_codes = [], set(), set()
    for r in (map(_clean, rel.sort_values("feed_launch").to_dict("records")) if len(rel) else []):
        name = str(r["release"])
        if "test" in name.lower():
            continue
        if not r.get("feed_launch") and float(r.get("signups") or 0) < TL_PANEL_MIN_SIGNUPS:
            continue
        launch = matched.get(name)
        inp = saved.get(name)
        rid = (inp or {}).get("id") or tl_id(name)
        daily, hourly = _rel_rows(series, name)
        d = tl_dates(launch, r, inp, daily, hourly, now)
        if d["open"] is None:
            continue
        code = (inp or {}).get("campaign_code") or guess_tl_code(str(r["artist"]), d["open"], activity, taken_codes,
                                                                  titles=f"{(launch or {}).get('titles') or ''} {r.get('title') or ''}",
                                                                  airtable_code=(launch or {}).get("airtable_release"), announce=d["announce"])
        if code:
            taken_codes.add(code)
        out.append({"id": rid, "release_name": name, "artist": str(r["artist"]), "title": str(r.get("title") or ""), "quarter": str(r.get("quarter") or ""),
                    "type": "TL", "source": "feed", "launch": launch, "feed": r, "inputs": inp, "dates": d, "campaign_code": code,
                    "code_source": "release" if (inp or {}).get("campaign_code") else ("guessed" if code else None)})
        used_ids.add(rid)
        if launch:
            used_ids |= set(str(launch.get("airtable_ids") or "").split("|"))
    # Airtable's timed launches the feed has not named yet
    horizon = as_of + timedelta(days=TL_UPCOMING_DAYS)
    listed = {o["release_name"] for o in out}
    for _, l in (timed.iterrows() if len(timed) else []):
        launch = _launch_dict(l)
        ids = set(str(launch.get("airtable_ids") or "").split("|")) - {""}
        if ids & used_ids:
            continue
        day = _day(launch.get("launch_date"))
        if day is None or not (as_of <= day <= horizon):
            continue
        if str(launch.get("project_status") or "").startswith("1.4"):
            continue
        title = "Multiple" if int(launch.get("n_products") or 1) > 1 else str(launch.get("titles") or "")
        quarter = pricing.quarter_of(pd.Timestamp(day))
        name = f"{launch['artist']} · {title} · {quarter}"
        if name in listed:
            continue
        inp = saved.get(name) or next((v for v in saved_ids.values() if ids & set(str(v.get("airtable_ids") or "").split("|"))), None)
        rid = (inp or {}).get("id") or tl_id(name)
        d = tl_dates(launch, None, inp, series["daily"].iloc[0:0] if series else pd.DataFrame(), series["hourly"].iloc[0:0] if series else pd.DataFrame(), now)
        code = (inp or {}).get("campaign_code") or guess_tl_code(str(launch["artist"]), d["open"], activity, taken_codes, titles=launch.get("titles"),
                                                                  airtable_code=launch.get("airtable_release"), announce=d["announce"])
        if code:
            taken_codes.add(code)
        out.append({"id": rid, "release_name": name, "artist": str(launch["artist"]), "title": title, "quarter": quarter, "type": "TL",
                    "source": "airtable", "launch": launch, "feed": None, "inputs": inp, "dates": d, "campaign_code": code,
                    "code_source": "release" if (inp or {}).get("campaign_code") else ("guessed" if code else None)})
        listed.add(name)
    return out


# ---------------------------------------------------------------- the page

def _products(rec: dict) -> tuple[list[dict], dict]:
    """Airtable's products for the TL's launch, as the Target setting tab reads
    them (etl/pricing.py release_products held to the timed launches), and the
    economics with the typed products applied: the units target summed over the
    ticked works, the edition sizes, the value-weighted price."""
    launch = rec.get("launch")
    products: list[dict] = []
    at = {"match": "none", "note": "", "products": []}
    if launch is not None:
        try:
            frame = pd.DataFrame([launch])
            for c in ("launch_date", "first_launch_date", "announce_date", "private_room_date", "tl_end_date"):
                if c in frame.columns:
                    frame[c] = pd.to_datetime(frame[c], errors="coerce")
            if "title_keys" in frame.columns:
                frame["title_keys"] = frame["title_keys"].map(lambda v: set(v) if isinstance(v, (list, set, tuple)) else set())
            at = pricing.release_products({"release_name": rec["release_name"], "artist": rec["artist"], "title": rec["title"], "quarter": rec["quarter"],
                                           "announce_date": _iso(rec["dates"]["announce"]), "launch_end": _iso(rec["dates"]["close"].date()) if rec["dates"]["close"] else None},
                                          launch_frame=frame)
            products = at["products"]
        except Exception as e:  # noqa: BLE001 - the page stands without the products grid
            at = {"match": "none", "note": f"products could not be read ({e})", "products": []}
    typed = {str(p.get("airtable_id")): p for p in ((rec.get("inputs") or {}).get("products") or []) if p.get("airtable_id")}
    manual = [p for p in ((rec.get("inputs") or {}).get("products") or []) if p.get("manual")]
    rows = []
    for p in products:
        t = typed.get(str(p.get("airtable_id")), {})
        edition = _num(t.get("edition")) or _num(p.get("edition"))
        rows.append({"airtable_id": p.get("airtable_id"), "name": p.get("name"), "edition": edition,
                     "units_target": _num(t.get("units_target")) if _num(t.get("units_target")) is not None else _num(p.get("units_target")),
                     "unit_price": _num(t.get("unit_price")) if _num(t.get("unit_price")) is not None else _num(p.get("unit_price")),
                     "currency": t.get("currency") or p.get("currency") or "EUR", "framing_available": p.get("framing_available"),
                     "excluded": bool(t.get("excluded")), "typed": {k: t.get(k) for k in ("edition", "units_target", "unit_price") if t.get(k) is not None}})
    for m in manual:
        rows.append({"airtable_id": None, "manual": True, "name": m.get("name"), "edition": _num(m.get("edition")), "units_target": _num(m.get("units_target")),
                     "unit_price": _num(m.get("unit_price")), "currency": m.get("currency") or "EUR", "framing_available": None,
                     "excluded": bool(m.get("excluded")), "typed": {}})
    live = [p for p in rows if not p["excluded"]]
    targets = [p["units_target"] for p in live if p["units_target"]]
    units_target = sum(targets) if targets else None
    edition = sum(p["edition"] for p in live if p["edition"]) or None
    priced = [(p["units_target"] or p["edition"] or 0, p["unit_price"] * pricing.RATES_TO_EUR.get(p["currency"], 1.0)) for p in live if p["unit_price"]]
    w = sum(u for u, _ in priced)
    price = (sum(u * pr for u, pr in priced) / w) if w > 0 else (float(np.mean([pr for _, pr in priced])) if priced else None)
    econ = {"units_target": units_target, "edition_size": edition, "unit_price_eur": price,
            "launch_value_eur": (units_target or edition or 0) * price if price else None, "n_products": len(live), "n_excluded": len(rows) - len(live)}
    return rows, {"match": at.get("match"), "note": at.get("note"), "economics": econ}


def _email_card(emails: pd.DataFrame | None, code: str | None, d: dict, daily: pd.DataFrame, as_of: date) -> dict | None:
    """The pre-window sends under the campaign code, the marketing sends (GEN,
    CUS, INS, else anything not transactional or automated, as the LE email
    card reads them) with the AA Email signups on each send's day; the
    automated flow (signup confirmations, welcomes) counted apart."""
    if emails is None or not len(emails) or not code:
        return None
    em = emails[emails["campaign"].astype(str).str.strip() == code].copy() if "campaign" in emails.columns else emails.iloc[0:0]
    if not len(em):
        return {"code": code, "sends": [], "automated": 0, "totals": None}
    em["day"] = pd.to_datetime(em["sent_at"], errors="coerce").dt.date
    lo = (d["announce"] - timedelta(days=7)) if d["announce"] else None
    hi = d["sales_open"].date() if d["sales_open"] else as_of
    em = em[em["day"].notna() & ((em["day"] >= lo) if lo else True) & (em["day"] <= hi)]
    types = em["email_type"] if "email_type" in em.columns else pd.Series("", index=em.index)
    core = em[types.isin(["GEN", "CUS", "INS"])]
    if not len(core):
        core = em[~types.isin(["TRNS", "AUT", "FREQ", "TEST"])]
    automated = int(len(em) - len(core))
    email_daily = daily[daily["group"] == "aa_email"].groupby("day")["signups"].sum() if len(daily) else pd.Series(dtype=float)
    sends = []
    for r in core.sort_values("sent_at").itertuples(index=False):
        sends.append({"name": str(r.name), "date": r.day.isoformat(), "delivered": _num(r.delivered), "opened": _num(r.opened), "clicked": _num(r.clicked),
                      "signups": float(email_daily.get(r.day, 0.0)), "type": getattr(r, "email_type", None)})
    in_window = email_daily[(email_daily.index >= (lo or (email_daily.index.min() if len(email_daily) else hi))) & (email_daily.index <= hi)] if len(email_daily) else email_daily
    tot = {"sends": len(sends), "delivered": sum(s["delivered"] or 0 for s in sends), "opened": sum(s["opened"] or 0 for s in sends),
           "clicked": sum(s["clicked"] or 0 for s in sends), "signups": float(in_window.sum()) if len(in_window) else 0.0}
    return {"code": code, "sends": sends, "automated": automated, "totals": tot}


def build_tl(rec: dict, series: dict | None, panel: pd.DataFrame, curves: dict, spend: pd.DataFrame | None, emails: pd.DataFrame | None,
             as_of: date, now: datetime, seen: float = 1.0) -> dict:
    """The page snapshot of one TL (module docstring)."""
    d = rec["dates"]
    inp = rec.get("inputs") or {}
    state = state_of(d, now)
    name = rec["release_name"]
    daily, hourly = _rel_rows(series, name) if series else (pd.DataFrame(), pd.DataFrame())
    products, prod_info = _products(rec)
    econ = prod_info["economics"]
    airtable_units = econ["units_target"] if econ["units_target"] else _num((rec.get("launch") or {}).get("units_target"))
    price = econ["unit_price_eur"] or _num((rec.get("launch") or {}).get("unit_price_eur"))
    release_for_basket = {"release_name": name, "artist": rec["artist"], "window_open": _iso(d["open"]), "window_hours": d["hours"],
                          "units_target": _num(inp.get("units_target")) or airtable_units, "unit_price_eur": price}
    rb = resolve_basket(inp.get("benchmark_basket"), panel, curves, release_for_basket, as_of)
    basket = rb["basket"]
    off = channels_off_of(inp)
    profile = apply_channels_off(basket["profile"], off)
    launch_value = (release_for_basket["units_target"] or 0) * price if price and release_for_basket["units_target"] else None
    targets = tl_targets(inp, airtable_units, profile, launch_value)
    targeted = targets is not None and targets.get("signup_target") is not None

    # ---- signups: the headline, by day and by group
    pre_to = d["sales_open"]
    pre = _pre_window(daily, hourly, pre_to) if len(daily) else daily
    signups_total = float(daily["signups"].sum()) if len(daily) else 0.0
    signups_pre = float(pre["signups"].sum()) if len(pre) else 0.0
    feed_row = rec.get("feed") or {}
    by_day = daily.groupby("day")["signups"].sum() if len(daily) else pd.Series(dtype=float)
    sess_by_day = daily.groupby("day")["sessions"].sum() if len(daily) else pd.Series(dtype=float)
    open_day = d["sales_open"].date()
    curve_share = profile.get("signup_curve") or [0.0] * len(CURVE_DAYS)
    curve_count = profile.get("signup_curve_count") or [0.0] * len(CURVE_DAYS)

    def share_at(day_to_open: int) -> float:
        i = day_to_open + TL_CURVE_DAYS
        if i < 0:
            return 0.0
        return float(curve_share[min(i, len(curve_share) - 1)])

    def bm_at(day_to_open: int) -> float:
        i = day_to_open + TL_CURVE_DAYS
        if i < 0:
            return 0.0
        return float(curve_count[min(i, len(curve_count) - 1)])

    target = targets["signup_target"] if targeted else None
    pre_announce = float(by_day[by_day.index < d["announce"]].sum()) if d["announce"] and len(by_day) else 0.0
    days = []
    if d["announce"]:
        day = d["announce"]
        last = min(open_day, as_of) if state == "signups" or state == "upcoming" else open_day
        while day <= last:
            dto = (day - open_day).days
            cum = float(by_day[by_day.index <= day].sum()) if len(by_day) else 0.0
            days.append({"date": day.isoformat(), "dayToOpen": dto, "actual": cum if day <= as_of else None,
                         "plan": (target * share_at(dto)) if target else None, "bm": bm_at(dto) if basket["n"] else None,
                         "sessions": float(sess_by_day.get(day, 0.0)), "signups": float(by_day.get(day, 0.0))})
            day += timedelta(days=1)
    dto_today = (min(as_of, open_day) - open_day).days
    frac = seen if as_of < open_day else 1.0
    share_today = share_at(dto_today - 1) + frac * (share_at(dto_today) - share_at(dto_today - 1)) if dto_today <= 0 else 1.0
    bm_today = bm_at(dto_today - 1) + frac * (bm_at(dto_today) - bm_at(dto_today - 1)) if dto_today <= 0 else bm_at(0)
    now_signups = signups_total if state in ("upcoming", "signups") else signups_pre
    expected = target * share_today if target else None
    projected = (now_signups / share_today) if share_today >= 0.05 and state in ("upcoming", "signups") else (now_signups if target else None)
    status_pct = ((now_signups - expected) / expected) if expected else None
    bm_pct = ((now_signups - bm_today) / bm_today) if bm_today and basket["n"] else None
    sg = _by_group(pre if state not in ("upcoming", "signups") else daily, "signups")
    sess_g = _by_group(pre if state not in ("upcoming", "signups") else daily, "sessions")
    groups = []
    for g in GROUPS:
        tg = targets["signups_by_group"][g] if targeted else None
        bm_g = profile["signups_by_group"].get(g, 0.0) if basket["n"] else None
        groups.append({"key": g, "name": GROUP_NAMES[g], "off": g in off, "now": sg[g], "sessions": sess_g[g],
                       "rate": (sg[g] / sess_g[g]) if sess_g[g] > 0 else None,
                       "target": tg, "exp": (tg * share_today) if tg is not None else None,
                       "bm": bm_g, "bmExp": (bm_g * share_today) if bm_g is not None else None,
                       "bmSessions": profile["sessions_by_group"].get(g) if basket["n"] else None, "bmRate": profile["conv"].get(g) if basket["n"] else None,
                       "sessionsNeeded": targets["sessions_by_group"][g] if targeted else None})
    untracked = {"signups": sg.get("untracked", 0.0), "sessions": sess_g.get("untracked", 0.0)}

    # ---- paid: the signups it buys before the window
    code = rec.get("campaign_code")
    names = inp.get("campaign_names") or None
    sp = code_spend(spend, code, names)
    spend_pre = float(sp.loc[sp["day"] < open_day, "spend"].sum()) if len(sp) else 0.0
    spend_win = float(sp.loc[(sp["day"] >= open_day) & (sp["day"] <= d["close"].date()), "spend"].sum()) if len(sp) else 0.0
    campaigns = [{"name": n, "spend": float(g["spend"].sum()), "first": _iso(g["day"].min()), "last": _iso(g.loc[g["spend"] > 0, "day"].max()) if (g["spend"] > 0).any() else None}
                 for n, g in sp.groupby("campaign_name")] if len(sp) else []
    paid_signups = sg["paid"]
    tracked = sum(sg[g] for g in GROUPS)
    # the cost per signup prices the untracked signups in at the tracked paid
    # share, as the panel does, so the live figure and the basket's agree
    paid_folded = (paid_signups / tracked * now_signups) if tracked > 0 else paid_signups
    cps_actual = spend_pre / paid_folded if paid_folded >= PAID_COST_MIN_SIGNUPS and spend_pre > 0 else None
    paid = {"code": code, "codeSource": rec.get("code_source"), "campaigns": campaigns,
            "spendPre": spend_pre, "spendWindow": spend_win, "signups": paid_signups, "signupsFolded": paid_folded, "costPerSignup": cps_actual,
            "bmCostPerSignup": profile.get("cost_per_signup") or None, "bmCostPerSale": profile.get("cost_per_sale") or None,
            "budgetPre": targets["budget_pre"] if targeted else None, "budgetWindow": targets["budget_window"] if targeted else None,
            "leftPre": (targets["budget_pre"] - spend_pre) if targeted and targets.get("budget_pre") else None,
            "targetSignups": targets["paid_signups"] if targeted else None, "expSignups": (targets["paid_signups"] * share_today) if targeted else None,
            "bmShareSignups": profile.get("paid_share_signups"), "shareSignups": (paid_signups / now_signups) if now_signups > 0 else None,
            "paidDaily": [{"date": day.isoformat(), "spend": float(v)} for day, v in sp.groupby("day")["spend"].sum().items()] if len(sp) else []}

    # ---- sales: the window's units from the feed's purchase events (phase one)
    sales = None
    if state in ("window", "settling", "closed") and len(hourly):
        until = min(now, d["settle"])
        win = _window(hourly, d["sales_open"], until)
        units = float(win["units"].sum()); orders = float(win["orders"].sum())
        ug = _by_group(win, "units")
        unit_curve = profile.get("unit_curve") or [0.0] * len(CURVE_FRACS)
        span = (d["close"] - d["sales_open"]).total_seconds()
        hours = []
        h = d["sales_open"]
        by_hour = win.groupby("ts")["units"].sum()
        cum = 0.0
        while h < d["close"] and h <= until + timedelta(hours=1):
            cum += float(by_hour.get(pd.Timestamp(h), 0.0))
            f = min((h + timedelta(hours=1) - d["sales_open"]).total_seconds() / span, 1.0) if span > 0 else 1.0
            i = min(int(round(f * TL_UNIT_CURVE_STEPS)), TL_UNIT_CURVE_STEPS)
            hours.append({"hour": _iso(h), "sinceOpen": round((h - d["sales_open"]).total_seconds() / 3600, 1), "units": float(by_hour.get(pd.Timestamp(h), 0.0)),
                          "cum": cum, "plan": (release_for_basket["units_target"] * unit_curve[i]) if release_for_basket["units_target"] else None,
                          "bm": (profile["units"] * unit_curve[i]) if basket["n"] else None})
            h += timedelta(hours=1)
        f_now = min(max((until - d["sales_open"]).total_seconds() / span, 0.0), 1.0) if span > 0 else 1.0
        i_now = min(int(round(f_now * TL_UNIT_CURVE_STEPS)), TL_UNIT_CURVE_STEPS)
        exp_units = (release_for_basket["units_target"] * unit_curve[i_now]) if release_for_basket["units_target"] else None
        sales = {"units": units, "orders": orders, "piecesPerOrder": (units / orders) if orders else None, "unitsTarget": release_for_basket["units_target"],
                 "expectedNow": exp_units, "bmNow": (profile["units"] * unit_curve[i_now]) if basket["n"] else None, "bmUnits": profile["units"] if basket["n"] else None,
                 "statusPct": ((units - exp_units) / exp_units) if exp_units else None, "byHour": hours,
                 "byGroup": [{"key": g, "name": GROUP_NAMES[g], "units": ug[g], "target": (release_for_basket["units_target"] * profile["share_units"][g]) if release_for_basket["units_target"] else None,
                              "bm": profile["units_by_group"][g] if basket["n"] else None} for g in GROUPS],
                 "untracked": ug.get("untracked", 0.0), "private": float(win["units_private"].sum()) if "units_private" in win.columns else None,
                 "cancelled": float(win["units_cancelled"].sum()) if "units_cancelled" in win.columns else None,
                 "spend": spend_win, "paidUnits": ug["paid"], "costPerSale": (spend_win / ug["paid"]) if ug["paid"] >= PAID_COST_MIN_UNITS and spend_win > 0 else None,
                 "note": "units are the feed's purchase events, pieces on orders not cancelled; the orders table's paid and awaiting lines come with the window build"}

    announce = d["announce"]
    close_day = d["close"].date()
    length_days = max((close_day - announce).days, 1) if announce else None
    day_no = max(min((as_of - announce).days, length_days), 0) if announce else 0
    hours_left = (d["close"] - now).total_seconds() / 3600 if state == "window" else None
    data_to = (series or {}).get("feed", {}).get("dataTo") if series else None
    launch = rec.get("launch") or {}
    reasons = list(d["notes"])
    if rb["fell_back"]:
        reasons.append("the saved basket could not be used; the suggested one stands")
    snap = {
        "id": rec["id"], "releaseName": name, "artist": rec["artist"], "title": rec["title"], "quarter": rec["quarter"], "type": "TL",
        "tlState": state, "tlLabel": tl_label(state, d, now), "tlSource": rec.get("source"),
        "campaignCode": code, "campaignNames": names or ([f"{code} · Sign-ups"] if code else []), "marketingLead": inp.get("marketing_lead"),
        "windowStart": _iso(announce), "windowEnd": _iso(close_day), "windowOpen": _iso(d["open"]), "windowClose": _iso(d["close"]),
        "salesOpen": _iso(d["sales_open"]), "earlyAccessOpen": _iso(d["early_access"]), "earlyAccessAssumed": d["early_access_assumed"],
        "settleEnd": _iso(d["settle"]), "windowHours": d["hours"], "hoursLeft": round(hours_left, 1) if hours_left is not None else None,
        "campaignLengthDays": length_days, "day": day_no, "of": length_days or 1,
        "asOf": as_of.isoformat(), "asOfFraction": seen, "dataTo": data_to, "builtAt": _iso(now), "completeThrough": as_of.isoformat(),
        "complete": state == "closed", "targeted": targeted, "upcoming": state == "upcoming" and rec.get("source") == "airtable", "catalogue": False,
        "dateDrift": False,
        "derived": {"announce_date": _iso(announce), "launch_end": _iso(close_day), "window_open": _iso(d["open"]), "window_hours": d["hours"],
                    "dates_source": {"announce": d["announce_source"], "open": d["open_source"], "hours": d["hours_source"]},
                    "dates_note": "; ".join(reasons) or None, "dates_assumed": d["announce_assumed"] or d["open_source"] == "default" or d["hours_source"] == "default",
                    "readings": d["readings"], "campaign_code": code, "code_source": rec.get("code_source"),
                    "first_seen": feed_row.get("first_seen"), "last_seen": feed_row.get("last_seen")},
        "airtable": {k: launch.get(k) for k in ("airtable_release", "airtable_ids", "titles", "n_products", "launch_type", "project_status", "edition_size",
                                                "unit_price", "unit_price_eur", "currency", "launch_value_eur", "units_target", "launch_time", "tl_length",
                                                "tl_end_date", "announce_dates", "price_match")} if launch else None,
        "products": products, "productsNote": prod_info["note"], "economics": econ,
        "hero": {"now": now_signups, "unique": _num(feed_row.get("signups_unique")), "expectedToday": expected, "delta": (now_signups - expected) if expected is not None else None,
                 "projected": projected, "target": target, "statusPct": status_pct, "ok": (status_pct >= 0) if status_pct is not None else None,
                 "benchmark": (profile["signups"] if basket["n"] else None), "benchmarkToday": bm_today if basket["n"] else None, "benchmarkPct": bm_pct,
                 "daysToOpen": -dto_today, "shareToday": share_today, "preAnnounce": pre_announce},
        "targets": targets,
        "benchmark": {"basket": {k: basket.get(k) for k in ("id", "kind", "name", "desc", "n", "members", "thin", "fallback")},
                      "suggested": rb["suggested"], "channelsOff": off, "k": targets["k"] if targeted else None,
                      "profile": profile} if basket["n"] else None,
        "baskets": [{**{k: b.get(k) for k in ("id", "kind", "name", "desc", "n", "members", "thin", "fallback", "disabled")},
                     "profile": {k: v for k, v in b["profile"].items() if k not in ("signup_curve", "signup_curve_count", "unit_curve", "curve_days", "curve_fracs")}}
                    for b in rb["ready"]],
        "signups": {"total": signups_total, "preWindow": signups_pre, "unique": _num(feed_row.get("signups_unique")), "preAnnounce": pre_announce,
                    "byDay": days, "byGroup": groups, "untracked": untracked, "converted": _num(feed_row.get("signups_converted"))},
        "channels": groups,
        "email": _email_card(emails, code, d, daily, as_of),
        "paid": paid,
        "sales": sales,
        "totals": {"sessions": float(daily["sessions"].sum()) if len(daily) else 0.0, "signups": signups_total,
                   "units": float(daily["units"].sum()) if len(daily) else 0.0},
        "benchmarks": {"cannibalisation": TL_CANNIBALISATION, "paidSplitPre": TL_PAID_SPLIT_PRE, "settleDays": TL_SETTLE_DAYS,
                       "budgetSenseCheckMaxPct": float(BENCH.get("budget_sense_check_max_pct_of_launch_value") or 0.06)},
    }
    return snap


def index_row(snap: dict) -> dict:
    """The sidebar row of a TL, the LE row's keys plus the state."""
    st = snap["tlState"]
    status = "upcoming" if st == "upcoming" else ("closed" if st == "closed" else "live")
    hero = snap.get("hero") or {}
    sales = snap.get("sales") or {}
    pct = sales.get("statusPct") if st in ("window", "settling", "closed") and sales else hero.get("statusPct")
    return {
        "id": snap["id"], "name": f"{snap['artist']} - {snap['title']}", "releaseName": snap["releaseName"], "artist": snap["artist"],
        "title": snap["title"], "quarter": snap["quarter"], "type": "TL", "status": status, "targeted": snap.get("targeted", False),
        "day": snap["day"], "of": snap["of"], "complete": snap["complete"], "windowEnd": snap.get("windowEnd"), "closes": [],
        "dateDrift": False, "statusPct": pct, "ok": (pct >= 0) if pct is not None else None, "benchmarkPct": hero.get("benchmarkPct"),
        "lastSeen": (snap.get("derived") or {}).get("last_seen"), "sessions": (snap.get("totals") or {}).get("sessions"),
        "tlState": st, "tlLabel": snap.get("tlLabel"), "windowStart": snap.get("windowStart"), "windowOpen": snap.get("windowOpen"), "windowClose": snap.get("windowClose"),
        "hoursLeft": snap.get("hoursLeft"), "salesOpen": snap.get("salesOpen"),
    }


def sourced_for(rec: dict, snap: dict, spend: pd.DataFrame | None) -> dict:
    """The inputs document's `sourced` block for a TL: what the feeds hold beside what is typed."""
    d = rec["dates"]
    campaigns = []
    if spend is not None and len(spend) and rec.get("campaign_code"):
        names = [n for n in spend["campaign_name"].dropna().unique() if str(n).startswith(f"{rec['campaign_code']} · ")]
        campaigns = sorted(str(n) for n in names)
    return {
        "airtable": {"match": "none" if not rec.get("launch") else (rec["launch"].get("price_match") or "artist+window"), "note": snap.get("productsNote") or "",
                     "products": snap.get("products") or [], "announce_date": d["readings"]["announce"]["airtable"],
                     "launch_end": _iso(d["close"].date()) if d["close"] else None, "window_open": d["readings"]["open"]["airtable"],
                     "window_hours": d["readings"]["hours"]["airtable"], "units_target": (rec.get("launch") or {}).get("units_target"),
                     "private_room_open": None, "marketing_lead": None, "closes": []},
        "feed": {"announce_date": d["readings"]["announce"]["feed"], "window_open": d["readings"]["open"]["feed"],
                 "window_open_adjusted": d["readings"]["open"]["feed_adjusted"]},
        "notion": {}, "clock": {}, "campaigns": campaigns, "tl": True,
    }


def discovered_for(rec: dict, snap: dict) -> dict:
    """The inputs document's `discovered` block for a TL: the defaults a first save starts from."""
    launch = rec.get("launch") or {}
    d = rec["dates"]
    return {
        "release_name": rec["release_name"], "artist": rec["artist"], "title": rec["title"], "type": "TL", "campaign_code": rec.get("campaign_code") or "",
        "code_source": rec.get("code_source"), "campaign_name": (f"{rec['campaign_code']} · Sign-ups" if rec.get("campaign_code") else None),
        "announce_date": _iso(d["announce"]), "launch_end": _iso(d["close"].date()) if d["close"] else None, "window_open": _iso(d["open"]),
        "window_hours": d["hours"], "private_room_open": None, "dates_note": (snap.get("derived") or {}).get("dates_note"),
        "source": rec.get("source"), "airtable_release": launch.get("airtable_release"), "airtable_ids": launch.get("airtable_ids"),
        "titles": launch.get("titles"), "n_products": launch.get("n_products"), "launch_type": "Timed", "project_status": launch.get("project_status"),
        "units_target": launch.get("units_target"), "tl_state": snap.get("tlState"),
    }


# ---------------------------------------------------------------- the build's entry point

def build_all(ctx: dict) -> dict:
    """Builds every TL page and the TL panel. `ctx`: as_of (date), now
    (datetime, UTC), seen (share of the as-of day seen), launch_frame
    (etl/pricing.py launches), inputs (the releases on file), spend, emails,
    write (bool), only (a release id, for the single-release build),
    configured_ids (ids with saved inputs: their pages go to APP/releases).
    Returns {rows, discovered, sourced, written, failures, note}."""
    as_of: date = ctx["as_of"]
    now: datetime = ctx.get("now") or datetime.now(timezone.utc)
    seen = float(ctx.get("seen", 1.0))
    series = load_series()
    out = {"rows": [], "discovered": {}, "sourced": {}, "written": set(), "failures": [], "note": "", "panel_n": 0}
    timed = timed_launches(ctx.get("launch_frame"))
    if series is None and not len(timed):
        out["note"] = "tl: no TL feed aggregation and no timed launches in Airtable - no TL pages"
        return out
    spend, emails = ctx.get("spend"), ctx.get("emails")
    if series is not None:
        panel, curves = panel_frame(series, timed, spend, emails, as_of, now)
    else:
        panel, curves = pd.DataFrame(), {}
    out["panel_n"] = len(panel)
    if ctx.get("write", True):
        APP.mkdir(parents=True, exist_ok=True)
        tmp = PANEL.with_suffix(".tmp"); panel.to_csv(tmp, index=False); tmp.replace(PANEL)
        tmp = CURVES.with_suffix(".tmp"); tmp.write_text(json.dumps(_json_safe({"asOf": as_of.isoformat(), "curves": curves}), separators=(",", ":"))); tmp.replace(CURVES)
    recs = tl_releases(series or {"releases": pd.DataFrame(columns=["release"]), "daily": pd.DataFrame(), "hourly": pd.DataFrame(), "by_release": {}, "hourly_by_release": {}},
                       ctx.get("launch_frame"), ctx.get("inputs") or [], as_of, now, spend, emails)
    only = ctx.get("only")
    configured = set(ctx.get("configured_ids") or [])
    for rec in recs:
        if only and rec["id"] != only:
            continue
        try:
            snap = build_tl(rec, series, panel, curves, spend, emails, as_of, now, seen)
        except Exception as e:  # noqa: BLE001 - one page's failure never stops the build
            out["failures"].append((rec["id"], f"{type(e).__name__}: {e}"))
            continue
        where = (APP / "releases" if rec["id"] in configured or rec.get("inputs") else DERIVED) / f"{rec['id']}.json"
        if ctx.get("write", True):
            where.parent.mkdir(parents=True, exist_ok=True)
            tmp = where.with_suffix(".tmp"); tmp.write_text(json.dumps(_json_safe(snap), indent=1, allow_nan=False)); tmp.replace(where)
            if where.parent == APP / "releases":
                # a page promoted by a save leaves no stale derived copy behind
                stale = DERIVED / f"{rec['id']}.json"
                if stale.exists():
                    stale.unlink()
        out["written"].add(f"{rec['id']}.json")
        out["rows"].append(_json_safe(index_row(snap)))
        out["discovered"][rec["id"]] = _json_safe(discovered_for(rec, snap))
        out["sourced"][rec["id"]] = _json_safe(sourced_for(rec, snap, spend))
        out.setdefault("snaps", {})[rec["id"]] = _json_safe(snap)
    states = {}
    for r in out["rows"]:
        states[r["tlState"]] = states.get(r["tlState"], 0) + 1
    out["note"] = (f"tl: {len(out['rows'])} timed launches ({', '.join(f'{v} {k}' for k, v in sorted(states.items()))}), "
                   f"panel {len(panel)} completed launches" + (f", {len(out['failures'])} failed" if out["failures"] else ""))
    return out


def is_tl_id(rid: str, ctx: dict) -> bool:
    """Whether a release id names a TL page: a saved record typed TL, or a page the last build listed as one."""
    for r in ctx.get("inputs") or []:
        if r.get("id") == rid:
            return str(r.get("type") or "").upper() == "TL" or bool(r.get("tl"))
    try:
        doc = json.loads((APP / "index.json").read_text())
        return any(r.get("id") == rid and r.get("type") == "TL" for r in doc.get("releases", []))
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    # development: the TL pages alone, from the aggregation on disk and Airtable
    import build as B  # noqa: E402
    as_of_arg = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--as-of=")), None)
    as_of = date.fromisoformat(as_of_arg) if as_of_arg else date.today()
    res = build_all({"as_of": as_of, "now": datetime.now(timezone.utc), "seen": 1.0, "launch_frame": B.load_launches(),
                     "inputs": B.INPUTS["releases"], "spend": B.load_spend(), "emails": B.load_emails(), "write": "--write" in sys.argv})
    print(res["note"])
    for row in res["rows"]:
        print(f"  {row['releaseName'][:48]:48s} {row['tlState']:9s} {row['tlLabel']:28s} pct={row['statusPct']}")
    for rid, err in res["failures"]:
        print(f"  FAILED {rid}: {err}")
