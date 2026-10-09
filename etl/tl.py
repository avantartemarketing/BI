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
CANDIDATES = APP / "tl_basket_candidates.json"   # the panel as the picker's rows (candidate_rows)
# the windows hour by hour from the orders table and the buyers (server/bigquery.js tlUnitsSql, tlBuyersSql)
TL_UNITS = DATA / "tl_units_hourly.csv"
TL_SIGNUP_PRODUCTS = DATA / "tl_signups_by_product.csv"   # signups by the work they were for (server/bigquery.js tlSignupProductsSql)
TL_BUYERS = DATA / "tl_buyers.csv"
LIVE_STATUS = ("paid", "awaiting")      # the lines a window's units count: paid plus awaiting payment (decision 10)
OUT_STATUS = ("cancelled", "refunded")
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
OWN_MAX = 3.0               # the artist's own earlier launches lead the basket when within this on both axes
TL_UPCOMING_DAYS = 120      # a timed launch this far ahead in Airtable is listed before the feed sees it
TL_CANNIBALISATION = 0.1    # the TL panel's default (spec §7; the LE standard is 0.2)
TL_PAID_SPLIT_PRE = 0.7     # the paid budget's pre-window share when the basket has no reading (the workbook template)
PAID_COST_MIN_SIGNUPS = 20  # a cost per signup needs this many paid signups
PAID_COST_MIN_UNITS = 5     # a cost per sale this many paid units
PAID_COST_MIN_MEMBERS = 3   # a basket's median cost needs this many members with one
RATE_MIN_SIGNUPS = 30       # a group's signup -> order rate is read from this many signups
RATE_MIN_SESSIONS = 100     # a group's session -> signup rate from this many sessions
RATE_MAX_PER_SESSION = 0.5  # ... and over this it is not a rate the feed measured
RATE_MAX_UNITS_PER_SESSION = 1.0
EMAIL_COHORT_MIN_DELIVERED = 100   # a launch's pre-window sends join the email cohort from this many delivered
# the sell-through forecast (docs/TL_SPEC.md §4b): how far the non-signup half
# follows the signup window (the within-basket slope on the 66 completed
# launches with a plan size, read at their open against the basket that size
# gave them, two launches whose campaigns brought low-quality signups set
# aside from the fit: 0.25), the clip on that performance ratio, the keyed
# signups a work split needs before the units-target split gives way, and
# where those launches landed around their forecast (actual over forecast,
# the middle half)
FORECAST_BETA = 0.2
FORECAST_PERF_CLIP = (0.5, 2.0)
FORECAST_MIN_KEYED = 20
FORECAST_BAND = (0.63, 1.62)  # a funnel rate over this (units, or signups, per session) is unread: its gap reads as conversion
RECENT_MONTHS = 18          # a comparable that closed within this many months ranks first (the LE baskets' RECENT_MONTHS)
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


def load_orders() -> dict:
    """The orders table's reading of the windows: the hourly lines per release
    and the buyers per release, or empty frames when the pull has not written them."""
    out = {"hourly": pd.DataFrame(columns=["release", "product_title", "hour", "channel", "status", "units", "orders", "units_private", "prints_offered", "frames", "value"]),
           "buyers": pd.DataFrame(columns=["release", "buyers", "buyers_multiple", "pieces"]), "by_release": {}, "buyers_by_release": {}}
    if TL_UNITS.exists():
        h = pd.read_csv(TL_UNITS, low_memory=False)
        h["ts"] = pd.to_datetime(h["hour"], utc=True, errors="coerce")
        h["group"] = h["channel"].map(GROUP_OF).fillna("untracked")
        for c in ("units", "orders", "units_private", "prints_offered", "frames", "value"):
            h[c] = pd.to_numeric(h[c], errors="coerce").fillna(0.0)
        out["hourly"] = h
        out["by_release"] = {n: g for n, g in h.groupby("release")}
    if TL_BUYERS.exists():
        b = pd.read_csv(TL_BUYERS, low_memory=False)
        out["buyers"] = b
        out["buyers_by_release"] = {str(r["release"]): r for r in b.to_dict("records")}
    return out


def load_signup_products() -> dict[str, pd.DataFrame]:
    """The signups by the work they were for, per release: the pull's counts
    (release x day x pre/post flag x channel x subscription type x product
    page), with the channel group, the day and the two flags read. Empty when
    the pull has not written the file."""
    if not TL_SIGNUP_PRODUCTS.exists():
        return {}
    f = pd.read_csv(TL_SIGNUP_PRODUCTS, low_memory=False, dtype={"page_path": str, "page_title": str, "stage": str, "sub_type": str, "channel": str})
    if not len(f):
        return {}
    f["group"] = f["channel"].fillna("").replace("", "Untracked").map(GROUP_OF).fillna("untracked")
    f["day"] = pd.to_datetime(f["date"], errors="coerce").dt.date
    f["is_prod"] = f["sub_type"].fillna("").astype(str).str.strip().str.lower().eq("product")
    f["pre"] = f["stage"].fillna("").astype(str).str.strip().str.lower().eq("pre-launch")
    f["has_page"] = f["page_path"].fillna("").astype(str).str.strip().ne("")
    for c in ("signups", "converted"):
        f[c] = pd.to_numeric(f[c], errors="coerce").fillna(0.0)
    return {n: g for n, g in f.groupby("release")}


def work_for_page(page_title: str | None, page_path: str | None, works: list[dict]) -> dict | None:
    """The work a product page is for: the page title's own part (before the
    ' by Artist' the shop appends) against the works' names, equal or one
    inside the other; else the slug's words, when they cover most of a name.
    None when no work fits, and those signups are spread over the works."""
    title = str(page_title or "").split(" | ")[0]
    title = re.sub(r"\s+by\s+[^|]+$", "", title, flags=re.IGNORECASE)
    key = pricing.norm(title)
    if key:
        for w in works:
            wk = pricing.norm(str(w.get("name") or ""))
            if wk and (wk == key or key in wk or wk in key):
                return w
    slug = set(pricing.norm(str(page_path or "").replace("/products/", "").replace("-", " ")).split())
    best, score = None, 0.0
    for w in works:
        toks = set(pricing.norm(str(w.get("name") or "")).split())
        if not toks:
            continue
        sc = len(toks & slug) / len(toks)
        if sc > score:
            best, score = w, sc
    return best if score >= 0.6 else None


def _orders_rows(orders: dict | None, name: str) -> pd.DataFrame | None:
    if not orders:
        return None
    g = orders["by_release"].get(name)
    return g if g is not None and len(g) else None


def window_from_orders(rows: pd.DataFrame, sales_open: datetime, until: datetime) -> dict:
    """What the orders table says of a window: the lines made from the sales
    open to `until`, units paid plus awaiting, the rest counted apart."""
    win = rows[(rows["ts"] >= sales_open) & (rows["ts"] < until)]
    live = win[win["status"].isin(LIVE_STATUS)]
    paid = win[win["status"] == "paid"]
    awaiting = win[win["status"] == "awaiting"]
    out_ = win[win["status"].isin(OUT_STATUS)]
    return {
        "win": win, "live": live, "paid": paid, "awaiting": awaiting,
        "units": float(live["units"].sum()), "units_paid": float(paid["units"].sum()),
        "awaiting_units": float(awaiting["units"].sum()), "awaiting_value": float(awaiting["value"].sum()), "awaiting_orders": float(awaiting["orders"].sum()),
        "orders": float(live["orders"].sum()), "cancelled": float(out_["units"].sum()),
        "private": float(live["units_private"].sum()),
        "prints_offered_paid": float(paid["prints_offered"].sum()), "frames_paid": float(paid["frames"].sum()),
        "prints_offered_awaiting": float(awaiting["prints_offered"].sum()), "frames_awaiting": float(awaiting["frames"].sum()),
        "by_group": _by_group(live, "units"),
    }


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
    cols = ["group", "channel", "sessions", "page_views", "signups", "signups_converted", "signups_product", "signups_product_converted",
            "signups_with_order", "units_with_signup", "orders", "units"]
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


# ---------------------------------------------------------------- Direct as a source (spec §3b)

DIRECT_CHANNEL = "Direct"
# the columns of the TL frames that are not measures: the keys of a row and its labels
_NON_METRIC = {"release", "channel", "group", "date", "day", "hour", "ts", "status", "product_title",
               "stage", "sub_type", "page_path", "page_title", "pre", "is_prod", "has_page"}


def _metric_cols(frame: pd.DataFrame, keys: list[str]) -> list[str]:
    return [c for c in frame.columns if c not in keys and c not in _NON_METRIC
            and pd.api.types.is_numeric_dtype(frame[c]) and not pd.api.types.is_bool_dtype(frame[c])]


def spread_direct(frame: pd.DataFrame, steps: list[str], release_col: str = "release") -> pd.DataFrame:
    """The frame with its Direct rows shared out over the other tracked channels
    in proportion to what each did in the same step: the LE build's rule
    (build.redistribute_channel, docs/METHODOLOGY.md §1.3) on the TL frames
    (docs/TL_SPEC.md §3b). A step is whatever `steps` names - a day, an hour,
    an hour of one work in one order status - and every measure moves alike. A
    step with nothing else to spread it over keeps its volume in place, split
    over the channels on the release's overall mix of that measure (else of its
    rows), so a series keeps its shape. The untracked rows stay apart, as the TL
    cards hold them, and a frame with no Direct rows, or nothing to spread them
    over, comes back as it is. Totals by step are kept to the figure."""
    if not len(frame) or "channel" not in frame.columns:
        return frame
    is_direct = frame["channel"].eq(DIRECT_CHANNEL)
    if not is_direct.any():
        return frame
    groups = frame["channel"].map(GROUP_OF).fillna("untracked")
    recv_mask = ~is_direct & groups.ne("untracked")
    if not recv_mask.any():
        return frame
    rel = [release_col] if release_col in frame.columns and release_col not in steps else []
    keys = rel + list(steps)
    metrics = _metric_cols(frame, keys)
    extra = [c for c in frame.columns if c not in keys and c not in metrics and c not in ("channel", "group")]
    direct, recv, rest = frame[is_direct], frame[recv_mask], frame[~is_direct & ~recv_mask]
    d = direct.melt(id_vars=keys, value_vars=metrics, var_name="_m", value_name="_v")
    d = d[d["_v"].notna() & d["_v"].ne(0)]
    r = recv.melt(id_vars=keys + ["channel"], value_vars=metrics, var_name="_m", value_name="_v")
    r = r[r["_v"] > 0]
    # the receivers' mix of each measure in the step
    w = r.groupby(keys + ["_m", "channel"], dropna=False, as_index=False)["_v"].sum()
    tot = w.groupby(keys + ["_m"], dropna=False, as_index=False)["_v"].sum().rename(columns={"_v": "_t"})
    w = w.merge(tot, on=keys + ["_m"])
    w["_w"] = w["_v"] / w["_t"]
    got = d.merge(w[keys + ["_m", "channel", "_w"]], on=keys + ["_m"], how="left")
    orphan = got[got["channel"].isna()].drop(columns=["channel", "_w"])
    got = got[got["channel"].notna()].copy()
    got["_v"] = got["_v"] * got["_w"]
    parts = [got[keys + ["channel", "_m", "_v"]]]
    if len(orphan):
        # nothing else in the step: the release's overall mix of the measure, else of its rows
        mix = r.groupby(rel + ["_m", "channel"], dropna=False, as_index=False)["_v"].sum()
        have = recv.groupby(rel + ["channel"], dropna=False, as_index=False).size().rename(columns={"size": "_v"})
        even = pd.concat([have.assign(_m=m) for m in metrics], ignore_index=True)
        seen = set(map(tuple, mix[rel + ["_m"]].astype(object).itertuples(index=False, name=None)))
        even = even[[tuple(x) not in seen for x in even[rel + ["_m"]].astype(object).itertuples(index=False, name=None)]]
        mix = pd.concat([mix, even], ignore_index=True)
        mt = mix.groupby(rel + ["_m"], dropna=False, as_index=False)["_v"].sum().rename(columns={"_v": "_t"})
        mix = mix.merge(mt, on=rel + ["_m"])
        mix["_w"] = mix["_v"] / mix["_t"]
        o = orphan.merge(mix[rel + ["_m", "channel", "_w"]], on=rel + ["_m"], how="inner")
        o["_v"] = o["_v"] * o["_w"]
        parts.append(o[keys + ["channel", "_m", "_v"]])
    moved = pd.concat(parts, ignore_index=True)
    wide = moved.groupby(keys + ["channel", "_m"], dropna=False)["_v"].sum().unstack("_m").reset_index()
    for m in metrics:
        if m not in wide.columns:
            wide[m] = 0.0
    out = pd.concat([recv, rest, wide], ignore_index=True)
    agg = {**{m: "sum" for m in metrics}, **{c: "first" for c in extra}}
    out = out.groupby(keys + ["channel"], dropna=False, as_index=False).agg(agg)
    out["group"] = out["channel"].map(GROUP_OF).fillna("untracked")
    order = [c for c in frame.columns if c in out.columns] + [c for c in out.columns if c not in frame.columns]
    return out[order]


def direct_share(frame: pd.DataFrame | None, cols: tuple = ("signups", "sessions", "units")) -> dict:
    """Direct's share of a frame's figures as the feed attributes them: the
    switch's words. {col: share, or None with nothing to share}."""
    out = {}
    for c in cols:
        if frame is None or not len(frame) or c not in frame.columns or "channel" not in frame.columns:
            out[c] = None
            continue
        tot = float(frame[c].sum())
        part = float(frame.loc[frame["channel"].eq(DIRECT_CHANNEL), c].sum())
        out[c] = round(part / tot, 4) if tot > 0 else None
    return out


def direct_spread_data(series: dict | None, orders: dict | None, signup_products: dict | None) -> dict | None:
    """Every TL frame read with Direct spread (spread_direct): the series by day
    and by hour, the orders table's lines by hour, work and status, and the
    signups by work by day and page, in the shapes load_series, load_orders and
    load_signup_products give them. None without the series."""
    if series is None:
        return None
    daily = spread_direct(series["daily"], ["day", "date"])
    hourly = spread_direct(series["hourly"], ["ts", "hour"]) if len(series["hourly"]) else series["hourly"]
    out_series = {**series, "daily": daily, "hourly": hourly,
                  "by_release": {n: g for n, g in daily.groupby("release")} if len(daily) else {},
                  "hourly_by_release": {n: g for n, g in hourly.groupby("release")} if len(hourly) else {}}
    out_orders = None
    if orders is not None:
        h = orders["hourly"]
        h2 = spread_direct(h, ["ts", "hour", "product_title", "status"]) if len(h) else h
        out_orders = {**orders, "hourly": h2, "by_release": {n: g for n, g in h2.groupby("release")} if len(h2) else {}}
    sp = {}
    if signup_products:
        f = pd.concat(list(signup_products.values()), ignore_index=True)
        f2 = spread_direct(f, ["day", "date", "stage", "sub_type", "page_path", "page_title", "pre", "is_prod", "has_page"])
        sp = {n: g for n, g in f2.groupby("release")}
    return {"series": out_series, "orders": out_orders, "signup_products": sp}


def direct_norm(series: dict | None, panel: pd.DataFrame) -> dict | None:
    """What Direct normally is of the Search/direct/other group on a timed
    launch: the panel launches' median share of the group's pre-window signups
    and sessions, and of its window units at the settle (the LE build's
    direct_share_norm, read off the TL series). Words for the switch; the
    basket itself is read off the panel built with the spread."""
    if series is None or not len(panel):
        return None
    shares: dict[str, list[float]] = {"signups": [], "sessions": [], "units": []}
    for r in panel.to_dict("records"):
        daily, hourly = _rel_rows(series, str(r["release_name"]))
        so, cl = _ts(r.get("sales_open")), _ts(r.get("close"))
        if so is None or cl is None or not len(daily):
            continue
        pre = _pre_window(daily, hourly, so)
        settled = _window(hourly, so, cl + timedelta(days=TL_SETTLE_DAYS)) if len(hourly) else hourly
        for frame, cols in ((pre, ("signups", "sessions")), (settled, ("units",))):
            if not len(frame):
                continue
            grp = frame[frame["group"].eq("search_direct_other")]
            for c in cols:
                tot = float(grp[c].sum()) if c in grp.columns else 0.0
                if tot > 0:
                    shares[c].append(float(grp.loc[grp["channel"].eq(DIRECT_CHANNEL), c].sum()) / tot)
    out: dict = {k: (round(float(np.median(v)), 4) if v else None) for k, v in shares.items()}
    out["n"] = max((len(v) for v in shares.values()), default=0)
    return out


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
                as_of: date, now: datetime, orders_data: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """Every completed TL as a comparable, with its measures; and the pace
    curves per member (CURVES). Counts only. Where the orders table has the
    launch's lines, its window units (paid plus awaiting at the settle), frames
    per print and buyers of several pieces are read from it; else from the feed."""
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
        # the orders table's reading where it has the launch: units at the
        # settle, frames per print, the buyers of several pieces
        o_rows = _orders_rows(orders_data, name)
        frames_per_print = float("nan")
        multiple_share = (float(r["buyers_multiple"]) / float(r["buyers_unique"])) if _num(r.get("buyers_unique")) else float("nan")
        units_source = "feed"
        if o_rows is not None:
            o = window_from_orders(o_rows, d["sales_open"], d["settle"])
            if o["units"] > 0:
                units, ug, units_source = o["units"], o["by_group"], "orders"
                if o["prints_offered_paid"] >= 20:
                    frames_per_print = o["frames_paid"] / o["prints_offered_paid"]
            b = (orders_data or {}).get("buyers_by_release", {}).get(name)
            if b is not None and _num(b.get("buyers")) and float(b["buyers"]) >= 20:
                multiple_share = float(b["buyers_multiple"]) / float(b["buyers"])
        sess = _by_group(pre, "sessions")
        # the window's own funnel: its sessions by group and the units they
        # converted to, held as the benchmark the window-state funnel reads
        sess_win = _by_group(win, "sessions")
        conv_win = {g: (ug[g] / sess_win[g] if sess_win[g] >= RATE_MIN_SESSIONS and ug[g] > 0 else float("nan")) for g in GROUPS}
        conv_g = _by_group(pre, "signups_converted")
        # the two kinds of signup and their conversions (docs §4b): a work's own
        # notify-me (product) against a release subscription
        sg_prod, conv_prod = _by_group(pre, "signups_product"), _by_group(pre, "signups_product_converted")
        sg_rel = {g: sg[g] - sg_prod[g] for g in sg}
        conv_rel = {g: conv_g[g] - conv_prod[g] for g in sg}
        # the window's units split by whether the buyer had signed up, from the
        # feed's purchases (the flag is theirs), and the pieces a signup-led order took
        su_units_g = _by_group(settled, "units_with_signup")
        feed_units_g = _by_group(settled, "units")
        nonsu_g = {g: max(feed_units_g[g] - su_units_g[g], 0.0) for g in feed_units_g}
        su_orders = float(settled["signups_with_order"].sum()) if len(settled) and "signups_with_order" in settled.columns else 0.0
        su_units = float(settled["units_with_signup"].sum()) if len(settled) and "units_with_signup" in settled.columns else 0.0
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
            "multiple_share": multiple_share, "frames_per_print": frames_per_print, "units_source": units_source,
            "spend_pre": spend_pre, "spend_window": spend_win, "cost_per_signup": cps, "cost_per_sale": cpu,
            "paid_share_signups": ss["paid"], "paid_share_units": us["paid"], "untracked_share": untracked_share,
            "units_target": _num((launch or {}).get("units_target")), "edition_size": _num((launch or {}).get("edition_size")),
            "unit_price_eur": _num((launch or {}).get("unit_price_eur")), "launch_value_eur": _num((launch or {}).get("launch_value_eur")),
            # the forecast's measures (docs §4b): the product signups' share, each kind's
            # signup -> order rate, the signup-led and non-signup units of the window
            "signups_prod_share": (sum(sg_prod[g] for g in GROUPS) / signups) if signups > 0 else float("nan"),
            "signup_order_rate_prod": (sum(conv_prod[g] for g in GROUPS) / sum(sg_prod[g] for g in GROUPS)) if sum(sg_prod[g] for g in GROUPS) >= RATE_MIN_SIGNUPS else float("nan"),
            "signup_order_rate_rel": (sum(conv_rel[g] for g in GROUPS) / sum(sg_rel[g] for g in GROUPS)) if sum(sg_rel[g] for g in GROUPS) >= RATE_MIN_SIGNUPS else float("nan"),
            "units_su": su_units, "units_nonsu": max(float(settled["units"].sum()) - su_units, 0.0) if len(settled) else 0.0,
            "ppo_su": (su_units / su_orders) if su_orders >= 5 else float("nan"),
        }
        for g in GROUPS:
            row[f"signup_order_rate_prod_{g}"] = (conv_prod[g] / sg_prod[g]) if sg_prod[g] >= RATE_MIN_SIGNUPS else float("nan")
            row[f"signup_order_rate_rel_{g}"] = (conv_rel[g] / sg_rel[g]) if sg_rel[g] >= RATE_MIN_SIGNUPS else float("nan")
            row[f"nonsu_units_{g}"] = nonsu_g[g]
        row["nonsu_units_untracked"] = nonsu_g.get("untracked", 0.0)
        for g in GROUPS:
            row[f"signups_{g}"] = sg[g]; row[f"sess_share_{g}"] = sess_s[g]; row[f"signup_share_{g}"] = ss[g]
            row[f"unit_share_{g}"] = us[g]; row[f"conv_sess_signup_{g}"] = conv[g]; row[f"sessions_{g}"] = sess[g]
            row[f"signup_order_rate_{g}"] = s2o_g[g]
            row[f"sess_win_{g}"] = sess_win[g]; row[f"conv_win_{g}"] = conv_win[g]
        row["sessions_window"] = float(win["sessions"].sum()) if len(win) else 0.0
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


def mix_fallbacks(ss: dict, sess_s: dict, us: dict) -> tuple[dict, dict, dict]:
    """A basket whose launches carry no channel on a measure - the earliest
    feed named none on their units, or on their signups - takes another
    measure's mix for it (the signups' for the units, the units' for the
    signups, the sessions' next) and an even split when it has none, so a
    page's channel figures still add up to its headline and the waterfall's
    walks hold (tests/walks.mjs; mirror of shared/tlModel.mjs mixFallbacks).
    Touches the earliest closed launches only."""
    def pick(own, *alts):
        if sum(own.values()) > 0:
            return own
        for a in alts:
            if sum(a.values()) > 0:
                return dict(a)
        return {g: 1.0 / len(GROUPS) for g in GROUPS}
    return pick(ss, us, sess_s), pick(sess_s, ss, us), pick(us, ss, sess_s)


def basket_profile(panel: pd.DataFrame, curves: dict, members: list[str]) -> dict:
    """The medians for one TL basket (spec §8). JSON-ready."""
    wanted = [str(m) for m in (members or [])]
    rows = panel[panel["release_name"].isin(wanted)] if len(panel) and wanted else panel.iloc[0:0]
    used = rows["release_name"].tolist()
    signups = _median(rows, "signups")
    sessions = _median(rows, "sessions")
    units = _median(rows, "units")
    ss, sess_s, us = _median_shares(rows, "signup_share_"), _median_shares(rows, "sess_share_"), _median_shares(rows, "unit_share_")
    ss, sess_s, us = mix_fallbacks(ss, sess_s, us)
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
        "frames_per_print": _median(rows, "frames_per_print", positive=True),
        "share_signups": ss, "share_sessions": sess_s, "share_units": us,
        "signups_by_group": {g: ss[g] * signups for g in GROUPS},
        "sessions_by_group": {g: sess_s[g] * sessions for g in GROUPS},
        "units_by_group": {g: us[g] * units for g in GROUPS},
        "conv": {g: _median(rows, f"conv_sess_signup_{g}", positive=True) for g in GROUPS},
        # the window's funnel: sessions by group inside the window and the rate they bought at
        "sessions_window": _median(rows, "sessions_window"),
        "sessions_window_by_group": {g: _median(rows, f"sess_win_{g}") for g in GROUPS},
        "conv_window": {g: _median(rows, f"conv_win_{g}", positive=True) for g in GROUPS},
        # each group's signup -> order rate: a paid signup converts at a fraction of an email one
        "signup_order_rate_by_group": {g: _median(rows, f"signup_order_rate_{g}", positive=True) for g in GROUPS},
        # the forecast's medians (docs §4b): each kind of signup's rate by group and
        # over the launch, the window's non-signup units by group, the pieces a
        # signup-led order took, the product signups' share of a launch's signups
        "signup_order_rate_prod_by_group": {g: _median(rows, f"signup_order_rate_prod_{g}", positive=True) for g in GROUPS},
        "signup_order_rate_rel_by_group": {g: _median(rows, f"signup_order_rate_rel_{g}", positive=True) for g in GROUPS},
        "signup_order_rate_prod": _median(rows, "signup_order_rate_prod", positive=True),
        "signup_order_rate_rel": _median(rows, "signup_order_rate_rel", positive=True),
        "nonsu_units_by_group": {g: _median(rows, f"nonsu_units_{g}") for g in GROUPS},
        "nonsu_units_untracked": _median(rows, "nonsu_units_untracked"),
        "nonsu_units": _median(rows, "units_nonsu"),
        "ppo_su": _median(rows, "ppo_su", positive=True),
        "signups_prod_share": _median(rows, "signups_prod_share"),
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


def basket_members(panel: pd.DataFrame | None, names: list[str] | None) -> list[dict]:
    """The basket's launches with the two figures the Benchmark basket card
    shows (the LE build's baskets.basket_members on the TL panel): the units
    the window sold and the unit price in euros, in the basket's order, with
    the name, artist, title and quarter the sidebar shows."""
    if panel is None or not len(panel) or not names or "release_name" not in panel.columns:
        return []
    by = panel.drop_duplicates("release_name").set_index("release_name")
    out = []
    for n in names:
        n = str(n)
        if n not in by.index:
            continue
        r = by.loc[n]
        price = _num(r.get("unit_price_eur"))
        out.append({"name": n, "artist": str(r.get("artist") or ""), "title": str(r.get("title") or ""), "quarter": str(r.get("quarter") or ""),
                    "units": _num(r.get("units")), "price": price if price and price > 0 else None})
    return out


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
    out["conv_window_all"] = dict(profile.get("conv_window") or {})
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
    out["conv_window"] = {g: ((profile.get("conv_window") or {}).get(g, 0.0) if g in keep else 0.0) for g in GROUPS}
    swg = profile.get("sessions_window_by_group") or {}
    out["sessions_window_by_group"] = {g: (swg.get(g, 0.0) if g in keep else 0.0) for g in GROUPS}
    out["sessions_window"] = sum(out["sessions_window_by_group"].values())
    for key in ("signup_order_rate_prod_by_group", "signup_order_rate_rel_by_group", "nonsu_units_by_group"):
        src = profile.get(key) or {}
        out[key] = {g: (src.get(g, 0.0) if g in keep else 0.0) for g in GROUPS}
    out["nonsu_units"] = sum(out["nonsu_units_by_group"].values()) + float(profile.get("nonsu_units_untracked") or 0.0)
    return out


# ---------------------------------------------------------------- baskets

def _ready(bid: str, name: str, desc: str, members: list[str], panel: pd.DataFrame, curves: dict, **extra) -> dict:
    out = {"id": bid, "kind": "ready", "name": name, "desc": desc, "members": members, "n": len(members),
           "disabled": len(members) < 1, "thin": 0 < len(members) < TL_THIN, "profile": basket_profile(panel, curves, members)}
    out.update(extra)
    return out


def _tl_panel_row(panel: pd.DataFrame, release: dict | None) -> pd.Series | None:
    name = str((release or {}).get("release_name") or "").strip()
    if not name or panel is None or not len(panel):
        return None
    hit = panel[panel["release_name"].astype(str) == name]
    return hit.iloc[0] if len(hit) else None


def _tl_release_end(panel: pd.DataFrame, release: dict | None) -> date | None:
    """The day this launch's window closes: its panel row's close when it has
    one, else its launch_end (shared/basketRule.mjs releaseEnd)."""
    row = _tl_panel_row(panel, release)
    if row is not None:
        c = _day(row.get("close"))
        if c:
            return c
    return _day((release or {}).get("launch_end"))


def _tl_release_start(panel: pd.DataFrame, release: dict | None, as_of: date) -> date:
    """The day this launch's pre-window starts, the cut-off for the artist's
    earlier launches: its panel row's announce, else its announce date, else
    its close, else the day it is read on (basketRule.mjs releaseStart)."""
    row = _tl_panel_row(panel, release)
    if row is not None:
        a = _day(row.get("announce"))
        if a:
            return a
    for key in ("announce_date", "launch_end"):
        got = _day((release or {}).get(key))
        if got:
            return got
    return as_of


def _tl_release_artist(panel: pd.DataFrame, release: dict | None) -> str:
    row = _tl_panel_row(panel, release)
    if row is not None and str(row.get("artist") or "").strip():
        return str(row["artist"]).strip()
    named = str((release or {}).get("artist") or "").strip()
    if named:
        return named
    return str((release or {}).get("release_name") or "").split(" · ")[0].strip()


def _tl_release_price(panel: pd.DataFrame, release: dict | None) -> float:
    """This launch's unit price in euros: the panel's for a launch it already
    prices, else the release's own (basketRule.mjs releasePrice)."""
    row = _tl_panel_row(panel, release)
    if row is not None and (_num(row.get("unit_price_eur")) or 0) > 0:
        return float(row["unit_price_eur"])
    return float(_num((release or {}).get("unit_price_eur")) or 0.0)


def _tl_distances(pool: pd.DataFrame, size: float, price: float) -> np.ndarray:
    """How far every launch in the pool is from this one: the larger of its
    units multiple (the units its window sold against this launch's target)
    and its price multiple, each taken above 1 whichever side it falls; a
    launch without a price is ranked on units alone (basketRule.mjs distances)."""
    units = pd.to_numeric(pool["units"], errors="coerce").to_numpy(dtype=float)
    prices = (pd.to_numeric(pool["unit_price_eur"], errors="coerce").to_numpy(dtype=float) if "unit_price_eur" in pool.columns
              else np.full(len(pool), np.nan))

    def mult(vals, ref):
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.maximum(vals / ref, ref / vals)
        return np.where((vals > 0) & np.isfinite(r), r, np.inf)

    d = mult(units, size)
    if price > 0 and len(pool):
        dp = mult(prices, price)
        d = np.maximum(d, np.where(np.isfinite(dp), dp, 1.0))
    return d


def _tl_closes(pool: pd.DataFrame) -> list:
    """Each launch's close as a day, None where it has none."""
    return [_day(v) for v in pool["close"].tolist()] if len(pool) else []


def own_members(pool: pd.DataFrame, release: dict, as_of: date, panel: pd.DataFrame | None = None) -> list[str]:
    """The artist's own earlier launches that lead the basket: the same
    artist, closed before this launch's pre-window started, within OWN_MAX on
    both axes; nearest first, then by name (basketRule.mjs ownMembers)."""
    panel = pool if panel is None else panel
    own = str(release.get("release_name") or "")
    pool = pool[pool["release_name"].astype(str) != own] if len(pool) else pool
    size = _num(release.get("units_target")) or 0.0
    if size <= 0 or not len(pool):
        return []
    artist = _tl_release_artist(panel, release).casefold()
    if not artist:
        return []
    start = _tl_release_start(panel, release, as_of)
    d = _tl_distances(pool, size, _tl_release_price(panel, release))
    names = pool["release_name"].astype(str).to_numpy()
    artists = pool["artist"].astype(str).str.strip().str.casefold().to_numpy()
    closes = _tl_closes(pool)
    idx = [i for i in range(len(pool))
           if artists[i] == artist and closes[i] is not None and closes[i] < start and np.isfinite(d[i]) and d[i] <= OWN_MAX]
    idx.sort(key=lambda i: (d[i], names[i]))
    return [names[i] for i in idx]


def similar_members(pool: pd.DataFrame, release: dict, as_of: date, panel: pd.DataFrame | None = None) -> list[str]:
    """The TL_SIMILAR_N launches nearest this one, the rule shared with the
    picker (shared/basketRule.mjs similarMembers, run over candidate_rows;
    tests/test_tl_basket_parity.py holds the two to the same members in the
    same order): the artist's own earlier launches first, then the rest by the
    larger of the units multiple and the price multiple. With prefer_recent (on
    unless the release says otherwise) a comparable that closed in the last
    RECENT_MONTHS ranks before an older one, and a launch beyond NEAR on either
    axis comes last. A launch that has closed is read at its own close: recent
    is the RECENT_MONTHS before it, and a launch that closed after it is left
    out, so its basket stops moving once it closes. `pool` is the launches to
    pick from (the same window length first, ready_baskets); `panel` the whole
    panel, where this launch's own row may be."""
    panel = pool if panel is None else panel
    own = str(release.get("release_name") or "")
    pool = pool[pool["release_name"].astype(str) != own] if len(pool) else pool
    size = _num(release.get("units_target")) or 0.0
    if size <= 0 or not len(pool):
        return []
    end = _tl_release_end(panel, release)
    closed = end is not None and end < as_of
    ref = end if closed else as_of
    d = _tl_distances(pool, size, _tl_release_price(panel, release))
    names = pool["release_name"].astype(str).to_numpy()
    closes = _tl_closes(pool)
    first = own_members(pool, release, as_of, panel)
    taken = set(first)
    rest = [i for i in range(len(pool))
            if names[i] not in taken and np.isfinite(d[i]) and not (closed and closes[i] is not None and closes[i] > ref)]
    if release.get("prefer_recent") is not False and rest:
        cutoff = (pd.Timestamp(ref) - pd.DateOffset(months=RECENT_MONTHS)).date()

        def tier(i):
            if d[i] > NEAR:
                return 2
            return 0 if (closes[i] is not None and closes[i] >= cutoff) else 1
        rest.sort(key=lambda i: (tier(i), d[i], names[i]))
    else:
        rest.sort(key=lambda i: (d[i], names[i]))
    return (first + [names[i] for i in rest])[:TL_SIMILAR_N]


def candidate_rows(panel: pd.DataFrame) -> list[dict]:
    """The TL panel as the picker's candidate rows (shared/basketRule.mjs ranks
    over these; etl/baskets.py candidate_rows is the LE shape): each launch's
    window units, price, sessions, channel shares and rates, dates and window
    length. JSON-ready, counts only."""
    rows = []
    if not len(panel):
        return rows
    for r in panel.sort_values("close", ascending=False, na_position="last").to_dict("records"):
        r = _clean(r)
        rows.append({
            "release_name": str(r.get("release_name") or ""), "artist": str(r.get("artist") or ""), "title": str(r.get("title") or ""),
            "quarter": str(r.get("quarter") or ""),
            "window_start": (r.get("announce") or "")[:10] or None, "window_end": (r.get("close") or "")[:10] or None,
            "campaign_days": _num(r.get("pre_days")), "window_hours": _num(r.get("window_hours")),
            "units": _num(r.get("units")) or 0.0, "demand": _num(r.get("units")) or 0.0, "sold_short": False,
            "unmet_units": 0.0, "payment_failed_units": 0.0,
            "demand_shares": {g: _num(r.get(f"unit_share_{g}")) or 0.0 for g in GROUPS},
            "unit_shares": {g: _num(r.get(f"unit_share_{g}")) or 0.0 for g in GROUPS},
            "sess_shares": {g: _num(r.get(f"sess_share_{g}")) or 0.0 for g in GROUPS},
            "convs": {g: _num(r.get(f"conv_sess_signup_{g}")) for g in GROUPS},
            # each group's share of the pre-window signups and its signup -> order
            # rate, for the tab's live reading of a basket picked by hand
            "signup_shares": {g: _num(r.get(f"signup_share_{g}")) or 0.0 for g in GROUPS},
            "s2o": {g: _num(r.get(f"signup_order_rate_{g}")) for g in GROUPS},
            "sessions": _num(r.get("sessions")) or 0.0, "paid_share": _num(r.get("sess_share_paid")) or 0.0,
            "signups": _num(r.get("signups")) or 0.0, "entries": _num(r.get("signups")) or 0.0,
            "signup_order_rate": _num(r.get("signup_order_rate")), "units_per_buyer": _num(r.get("purchases_per_order")) or 0.0,
            "cost_per_paid_unit": _num(r.get("cost_per_sale")), "cost_per_signup": _num(r.get("cost_per_signup")),
            "price": _num(r.get("unit_price_eur")) or 0.0, "edition_size": _num(r.get("edition_size")) or 0.0,
            "units_target": _num(r.get("units_target")), "early_access": bool(r.get("early_access")),
            "cluster": None, "cluster_name": "",
        })
    return rows


def ready_baskets(panel: pd.DataFrame, curves: dict, release: dict, as_of: date) -> list[dict]:
    """The ready-made TL baskets for a release (spec §8), in picker order: the
    nearest by units sold and price among the launches of the same window
    length (every length when fewer than TL_THIN of them are on file, counted
    as the picker counts them), the launches of the same length, the last
    twelve months, the artist's own, every completed TL. Read on `as_of`, and a
    launch that has closed at its close: the launches that closed after it are
    left out of every basket (similar_members)."""
    own = str(release.get("release_name") or "")
    pool = panel[panel["release_name"].astype(str) != own] if len(panel) else panel
    end = _tl_release_end(panel, release)
    closed = end is not None and end < as_of
    ref = end if closed else as_of
    hours = _num(release.get("window_hours"))
    out = []
    length_mask = np.isclose(pd.to_numeric(pool["window_hours"], errors="coerce").fillna(-1).to_numpy(dtype=float), hours or -2) if len(pool) else np.zeros(0, dtype=bool)
    same_len = pool[length_mask] if len(pool) else pool
    fell_back = hours is not None and len(same_len) < TL_THIN
    pool_len = pool if fell_back or hours is None else same_len
    members = similar_members(pool_len, release, as_of, panel=panel)
    desc = (f"The {len(members)} completed timed launches nearest this one on units sold and price"
            + (f", among the {hours_words(hours)} launches" if hours and not fell_back else "")
            + (f"; fewer than {TL_THIN} {hours_words(hours)} launches on file, so every length counts" if fell_back else "") + ".")
    out.append(_ready("similar_size", "Similar size and shape", desc, members, panel, curves, fallback=fell_back,
                      matchedOn=["target", "price"] if _tl_release_price(panel, release) > 0 else ["target"]))
    # the other baskets, read at the same clock
    closes = _tl_closes(pool)
    keep = np.array([not (closed and c is not None and c > ref) for c in closes], dtype=bool) if len(pool) else np.zeros(0, dtype=bool)
    pool_ref = pool[keep] if len(pool) else pool
    closes_ref = [c for c, k in zip(closes, keep) if k]
    if hours:
        out.append(_ready("same_length", f"{hours_words(hours).capitalize()} launches",
                          f"Every completed {hours_words(hours)} timed launch on file.", pool[length_mask & keep]["release_name"].tolist() if len(pool) else [], panel, curves))
    cutoff = ref - timedelta(days=365)
    recent = pool_ref[[c is not None and c >= cutoff for c in closes_ref]] if len(pool_ref) else pool_ref
    out.append(_ready("all_12m", "Last 12 months", "Every timed launch completed in the last twelve months.", recent["release_name"].tolist(), panel, curves))
    artist = _tl_release_artist(panel, release).casefold()
    start = _tl_release_start(panel, release, as_of)
    if artist and len(pool_ref):
        same_artist = pool_ref["artist"].astype(str).str.strip().str.casefold().to_numpy() == artist
        earlier = np.array([c is not None and c < start for c in closes_ref], dtype=bool)
        same = pool_ref[same_artist & earlier]
    else:
        same = pool_ref.iloc[0:0]
    out.append(_ready("same_artist", "Same artist, earlier launches", f"{release.get('artist') or 'This artist'}'s previous timed launches on file.",
                      same["release_name"].tolist(), panel, curves))
    out.append(_ready("all_tl", "All timed launches", "Every completed timed launch on file.", pool_ref["release_name"].tolist(), panel, curves))
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


def spread_profile(spread: dict, base: dict, norm: dict | None) -> dict:
    """The basket's medians on the Direct switch's basis (docs §3b): the
    profile read off the panel built with Direct spread (basket_profile), so
    every by-channel median, rates included, is on the basis the page is on,
    with the money held - paid takes its share of Direct's signups and units,
    so the same spend buys more of them, and the cost of a paid signup, and of
    a paid sale, is the Channel view's rescaled by the paid group's change
    (the LE build's spread_profile rule): the benchmark's budget is the same
    either way."""
    out = dict(spread)
    for key, cost in (("signups_by_group", "cost_per_signup"), ("units_by_group", "cost_per_sale")):
        before = float((base.get(key) or {}).get("paid") or 0.0)
        after = float((spread.get(key) or {}).get("paid") or 0.0)
        c = float(base.get(cost) or 0.0)
        out[cost] = (c * before / after) if (c > 0 and before > 0 and after > 0) else c
        out[f"n_{cost}"] = base.get(f"n_{cost}")
    out["direct_spread"] = norm or {}
    return out


def respread_targets(targets: dict | None, inputs: dict | None, profile: dict) -> dict | None:
    """The plan re-split by channel on the spread basket (docs §3b). The signup
    target, the units target, the rates and the budgets are the plan's and do
    not move with a display switch; each group's share of them follows the
    basket read with Direct spread (the stretch placed as the inputs say), the
    sessions needed follow the spread rates, and the cost of a paid signup, and
    of a paid sale, is the budget over the paid signups, and units, this view
    gives paid - so paid reads the signups it is given at a cost rescaled to them."""
    if targets is None:
        return None
    out = dict(targets)
    bm_by = {g: float(profile["signups_by_group"].get(g, 0.0)) for g in GROUPS}
    target = targets.get("signup_target")
    weights = stretch_weights(inputs, bm_by)
    groups = allocate_stretch(bm_by, target, weights) if target else {g: 0.0 for g in GROUPS}
    conv = profile.get("conv") or {}
    sessions = {g: (groups[g] / conv[g] if conv.get(g, 0) > 0 else None) for g in GROUPS}
    paid_units = float((profile.get("share_units") or {}).get("paid", 0.0)) * float(targets["units_target"])
    paid_off = "paid" in (profile.get("channels_off") or [])
    cps = (targets["budget_pre"] / groups["paid"]) if (targets.get("budget_pre") and groups["paid"] > 0 and not paid_off) else targets.get("cost_per_signup")
    cpu = (targets["budget_window"] / paid_units) if (targets.get("budget_window") and paid_units > 0 and not paid_off) else targets.get("cost_per_sale")
    out.update({"signups_by_group": groups, "sessions_by_group": sessions, "stretch_from": weights,
                "sessions_needed": sum(v for v in sessions.values() if v) if any(sessions.values()) else None,
                "paid_signups": groups["paid"], "paid_units": paid_units,
                "cost_per_signup": cps, "cost_per_sale": cpu,
                "benchmark": {**targets["benchmark"], "signups_by_group": bm_by, "paid_signups": bm_by["paid"],
                              "budget_pre": (bm_by["paid"] * cps) if cps else None}})
    return out


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

        def over(key, t=t, p=p):   # typed over Airtable, None where neither has a figure
            v = _num(t.get(key))
            return v if v is not None else _num(p.get(key))
        # a frame is on offer unless Airtable or the tab says not; with nothing
        # said, a sculpture edition has none (etl/pricing.py framing_default)
        fa = t.get("framing_available")
        framing = bool(fa) if fa is not None else (bool(p.get("framing_available")) if p.get("framing_available") is not None else p.get("framing_default") is not False)
        rows.append({"airtable_id": p.get("airtable_id"), "name": p.get("name"), "edition": edition,
                     "units_target": over("units_target"), "unit_price": over("unit_price"),
                     "currency": t.get("currency") or p.get("currency") or "EUR", "framing_available": framing,
                     "frame_conversion": over("frame_conversion"), "frame_profit_per_unit": over("frame_profit_per_unit"),
                     "artist_profit_per_unit": over("artist_profit_per_unit"), "aa_profit_per_unit": over("aa_profit_per_unit"),
                     "aa_revenue_share": over("aa_revenue_share"), "aa_profit_share": over("aa_profit_share"), "artist_revenue_cut": over("artist_revenue_cut"),
                     "excluded": bool(t.get("excluded")), "typed": {k: t.get(k) for k in PRODUCT_TYPED_KEYS if t.get(k) is not None}})
    for m in manual:
        rows.append({"airtable_id": None, "manual": True, "name": m.get("name"), "edition": _num(m.get("edition")), "units_target": _num(m.get("units_target")),
                     "unit_price": _num(m.get("unit_price")), "currency": m.get("currency") or "EUR",
                     "framing_available": bool(m["framing_available"]) if m.get("framing_available") is not None else True,
                     "frame_conversion": _num(m.get("frame_conversion")), "frame_profit_per_unit": _num(m.get("frame_profit_per_unit")),
                     "artist_profit_per_unit": _num(m.get("artist_profit_per_unit")), "aa_profit_per_unit": _num(m.get("aa_profit_per_unit")),
                     "aa_revenue_share": _num(m.get("aa_revenue_share")), "aa_profit_share": _num(m.get("aa_profit_share")), "artist_revenue_cut": _num(m.get("artist_revenue_cut")),
                     "excluded": bool(m.get("excluded")), "typed": {}})
    live = [p for p in rows if not p["excluded"]]
    targets = [p["units_target"] for p in live if p["units_target"]]
    units_target = sum(targets) if targets else None
    edition = sum(p["edition"] for p in live if p["edition"]) or None
    priced = [(p["units_target"] or p["edition"] or 0, p["unit_price"] * pricing.RATES_TO_EUR.get(p["currency"], 1.0)) for p in live if p["unit_price"]]
    w = sum(u for u, _ in priced)
    price = (sum(u * pr for u, pr in priced) / w) if w > 0 else (float(np.mean([pr for _, pr in priced])) if priced else None)
    econ = {"units_target": units_target, "edition_size": edition, "unit_price_eur": price,
            "launch_value_eur": (units_target or edition or 0) * price if price else None, "n_products": len(live), "n_excluded": len(rows) - len(live),
            **tl_economics(rows)}
    return rows, {"match": at.get("match"), "note": at.get("note"), "economics": econ, "marketing_lead": at.get("marketing_lead") or None}


def _sends_between(em: pd.DataFrame, lo: date | None, hi: date) -> tuple[pd.DataFrame, pd.DataFrame]:
    """One code's sends between two days inclusive (a `day` column added), and
    the marketing ones among them: GEN, CUS and INS, else anything not
    transactional or automated, as the LE email card reads them. The email card
    and the email cohort both count through here, so a page's sends and the
    references they are read against are the same kind of send."""
    em = em.copy()
    em["day"] = pd.to_datetime(em["sent_at"], errors="coerce").dt.date
    em = em[em["day"].notna() & ((em["day"] >= lo) if lo else True) & (em["day"] <= hi)]
    types = em["email_type"] if "email_type" in em.columns else pd.Series("", index=em.index)
    core = em[types.isin(["GEN", "CUS", "INS"])]
    if not len(core):
        core = em[~types.isin(["TRNS", "AUT", "FREQ", "TEST"])]
    return em, core


def email_cohort(panel: pd.DataFrame, emails: pd.DataFrame | None, as_of: date) -> dict | None:
    """The email references a TL page's funnel reads its sends against: the
    LE's email_delivered_benchmark on the TL panel. One row per panel launch
    whose code has marketing sends in its pre-window (the announce less seven
    days to the sales open, the sends _email_card counts) delivering at least
    EMAIL_COHORT_MIN_DELIVERED: the delivered total on the pre-window
    delivery-timing curve (build.CURVE_GRID, the pre-window as the unit) and,
    for a launch that closed within build.EMAIL_REF_MONTHS, its open, click and
    clicks-per-open rates and its pre-window AA Email sessions per click. The
    medians are build.email_medians'; a page reads them without its own row and
    without the launches that closed after it (build.email_bench_for), so a
    closed launch is never graded against itself. None until two launches
    qualify."""
    import build as B  # noqa: E402 - lazily: build imports this module
    if emails is None or not len(emails) or panel is None or not len(panel) or "campaign" not in emails.columns:
        return None
    recent = as_of - timedelta(days=B.EMAIL_REF_MONTHS * 30)
    codes = emails["campaign"].astype(str).str.strip()
    rows = []
    for r in panel.to_dict("records"):
        code = r.get("campaign_code")
        announce, sales_open, close = _day(r.get("announce")), _day(r.get("sales_open")), _day(r.get("close"))
        if not isinstance(code, str) or not code or announce is None or sales_open is None:
            continue
        em = emails[codes == code]
        if not len(em):
            continue
        _, core = _sends_between(em, announce - timedelta(days=7), sales_open)
        total = float(pd.to_numeric(core["delivered"], errors="coerce").fillna(0).sum()) if len(core) else 0.0
        if total < EMAIL_COHORT_MIN_DELIVERED:
            continue
        opened = float(pd.to_numeric(core["opened"], errors="coerce").fillna(0).sum())
        clicked = float(pd.to_numeric(core["clicked"], errors="coerce").fillna(0).sum())
        span = max((sales_open - announce).days, 1)
        c = core.assign(pdsa=[(day - announce).days / span for day in core["day"]]).sort_values("pdsa")
        cum = pd.to_numeric(c["delivered"], errors="coerce").fillna(0).cumsum() / total
        shares = []
        for t in B.CURVE_GRID:
            sel = cum[c["pdsa"] <= t]
            shares.append(float(sel.iloc[-1]) if len(sel) else 0.0)
        sessions = _num(r.get("sessions_aa_email")) or 0.0
        end = close or sales_open
        rate = None
        if end >= recent:
            rate = (r["release_name"], end, opened / total, clicked / total, (clicked / opened) if opened > 0 else None,
                    (sessions / clicked) if sessions > 0 and clicked > 0 else None)
        rows.append({"id": r["release_name"], "name": r["release_name"], "code": code, "end": end, "total": total, "shares": shares, "rate": rate})
    return B.email_medians(rows) if rows else None


def _email_card(emails: pd.DataFrame | None, code: str | None, d: dict, daily: pd.DataFrame, as_of: date) -> dict | None:
    """The pre-window sends under the campaign code, the marketing sends (GEN,
    CUS, INS, else anything not transactional or automated, as the LE email
    card reads them) with the AA Email signups on each send's day; the
    automated flow (signup confirmations, welcomes) counted apart."""
    if emails is None or not len(emails) or not code:
        return None
    em = emails[emails["campaign"].astype(str).str.strip() == code] if "campaign" in emails.columns else emails.iloc[0:0]
    # the last send anywhere in the file: a feed that stops before the launch is an ingestion gap, not silence
    feed_through = _iso(_day(pd.to_datetime(emails["sent_at"], errors="coerce").max())) if "sent_at" in emails.columns else None
    if not len(em):
        return {"code": code, "sends": 0, "sequence": [], "automated": 0, "totals": None, "delivered": 0, "opened": 0, "clicked": 0, "feedThrough": feed_through}
    lo = (d["announce"] - timedelta(days=7)) if d["announce"] else None
    hi = d["sales_open"].date() if d["sales_open"] else as_of
    em, core = _sends_between(em, lo, hi)
    automated = int(len(em) - len(core))
    email_daily = daily[daily["group"] == "aa_email"].groupby("day")["signups"].sum() if len(daily) else pd.Series(dtype=float)
    sends = []
    for r in core.sort_values("sent_at").itertuples(index=False):
        sends.append({"name": str(r.name), "date": r.day.isoformat(), "delivered": _num(r.delivered), "opened": _num(r.opened), "clicked": _num(r.clicked),
                      "signups": float(email_daily.get(r.day, 0.0)), "type": getattr(r, "email_type", None)})
    in_window = email_daily[(email_daily.index >= (lo or (email_daily.index.min() if len(email_daily) else hi))) & (email_daily.index <= hi)] if len(email_daily) else email_daily
    tot = {"sends": len(sends), "delivered": sum(s["delivered"] or 0 for s in sends), "opened": sum(s["opened"] or 0 for s in sends),
           "clicked": sum(s["clicked"] or 0 for s in sends), "signups": float(in_window.sum()) if len(in_window) else 0.0}
    # the LE email card's keys (the funnel's email rungs read them) beside the TL's own sequence
    return {"code": code, "sends": len(sends), "sequence": sends, "automated": automated, "totals": tot,
            "delivered": tot["delivered"], "opened": tot["opened"], "clicked": tot["clicked"],
            "openRate": (tot["opened"] / tot["delivered"]) if tot["delivered"] else None,
            "clickRate": (tot["clicked"] / tot["delivered"]) if tot["delivered"] else None, "feedThrough": feed_through}


PRODUCT_TYPED_KEYS = ("edition", "units_target", "unit_price", "artist_profit_per_unit", "aa_profit_per_unit", "aa_revenue_share", "aa_profit_share",
                      "artist_revenue_cut", "frame_conversion", "frame_profit_per_unit")


def tl_economics(rows: list[dict]) -> dict:
    """The works' profit and framing figures as one release (shared/tlModel.mjs
    tlEconomics, the same to the figure): over the ticked works, each weighted
    by its units target, else its edition, else evenly. AA's and the artist's
    profit per unit over the works with a figure (None when none has one); the
    share of the units on works that frame, those works' own frame take-up and
    AA's profit per frame (a framed work without a profit figure counts no
    framing profit, as the LE reads it; None when no framed work has one); who
    funds the ads from each work's deal (a profit share is AA's share of the
    ads, a revenue share all of them), None when no work records a deal."""
    live = [r for r in rows if not r.get("excluded")]

    def w(r):
        return _num(r.get("units_target")) or _num(r.get("edition")) or 1.0

    def weighted(key, of):
        use = [r for r in of if _num(r.get(key)) is not None]
        tot = sum(w(r) for r in use)
        return (sum(w(r) * float(r[key]) for r in use) / tot) if tot > 0 else None

    def deal_share(r):
        ps, rs = _num(r.get("aa_profit_share")), _num(r.get("aa_revenue_share"))
        return min(max(ps, 0.0), 1.0) if ps is not None else (1.0 if rs is not None else None)
    framed = [r for r in live if r.get("framing_available") is not False]
    framed_w = sum(w(r) for r in framed)
    framed_with = [r for r in framed if _num(r.get("frame_profit_per_unit")) is not None]
    total = sum(w(r) for r in live)
    dealt = [r for r in live if deal_share(r) is not None]
    dealt_w = sum(w(r) for r in dealt)
    return {"aa_profit_per_unit": weighted("aa_profit_per_unit", live), "artist_profit_per_unit": weighted("artist_profit_per_unit", live),
            "frame_share": (framed_w / total) if total > 0 else 0.0,
            "frame_conversion": weighted("frame_conversion", framed),
            "frame_profit_per_unit": (sum(w(r) * (_num(r.get("frame_profit_per_unit")) or 0.0) for r in framed) / framed_w) if (framed_with and framed_w > 0) else None,
            "aa_budget_share": (sum(w(r) * deal_share(r) for r in dealt) / dealt_w) if dealt_w > 0 else None,
            "aa_budget_share_assumed": not dealt,
            "deal": sorted({"profit share" if _num(r.get("aa_profit_share")) is not None else "revenue share" for r in dealt})}


def tl_paid_value(inputs: dict | None, profile: dict | None, targets: dict | None, econ: dict | None, b: dict | None = None) -> dict:
    """What a paid signup, and a paid sale, is worth to Avant Arte, and the
    cost it can pay for one at the target ROI (docs/TL_SPEC.md §7;
    shared/tlModel.mjs tlPaidValue, the same to the figure). A unit sold is
    worth AA's profit on it plus the likely framing profit: the share of units
    on works that frame x the frame take-up (the works' own figure, else the
    basket's frames per print, else the default) x AA's profit per frame. Net
    of cannibalisation that is a paid sale's value; a paid signup is worth that
    x pieces per order x the share of paid signups that go on to order (the
    typed signup -> order rate, else the basket's paid rate, else its blended
    rate). The ads divide as the profit does (AA's budget share from the
    works' deals; half, assumed, when none records one), so the cost AA can pay
    at a given ROI is the value over the share and the ROI. Unreadable without
    AA's profit per unit (Airtable's, or typed on the Target setting tab)."""
    b = b or BENCH
    inp, profile, targets, econ = inputs or {}, profile or {}, targets or {}, econ or {}
    ppu = _num(econ.get("aa_profit_per_unit"))
    frame_profit = _num(econ.get("frame_profit_per_unit"))
    frame_share = _num(econ.get("frame_share")) or 0.0
    own = _num(econ.get("frame_conversion"))
    basket_rate = _num(profile.get("frames_per_print"))
    if own is not None:
        frame_rate, frame_src = min(max(own, 0.0), 1.0), "release"
    elif basket_rate and basket_rate > 0:
        frame_rate, frame_src = basket_rate, "basket"
    else:
        frame_rate, frame_src = float(b.get("frame_conversion") or 0.0), "default"
    frame_uplift = frame_share * frame_rate * (frame_profit or 0.0)
    readable = ppu is not None
    value_unit = (ppu or 0.0) + frame_uplift
    cann = _num(targets.get("cannibalisation"))
    if cann is None:
        cann = _num(inp.get("cannibalisation"))
        cann = TL_CANNIBALISATION if cann is None else cann
    value_sale = value_unit * (1.0 - cann)
    s2o_typed = _num(inp.get("signup_order_rate"))
    paid_rate = _num((profile.get("signup_order_rate_by_group") or {}).get("paid"))
    blended = _num(targets.get("signup_order_rate"))
    if s2o_typed and 0 < s2o_typed <= 1:
        s2o, s2o_src = s2o_typed, "release"
    elif paid_rate and paid_rate > 0:
        s2o, s2o_src = paid_rate, "basket_paid"
    elif blended and blended > 0:
        s2o, s2o_src = blended, "basket"
    else:
        s2o, s2o_src = None, "none"
    ppo = _num(targets.get("purchases_per_order")) or _num(profile.get("purchases_per_order")) or 1.0
    value_signup = (s2o * ppo * value_sale) if s2o else None
    share = _num(econ.get("aa_budget_share"))
    assumed = share is None
    share = 0.5 if share is None else share
    roi_target = float(b.get("target_roi_aa") or 1.1)
    # the artist's reading of the same signups: their profit per unit (the
    # framing profit is AA's alone) over their share of the spend
    ppu_artist = _num(econ.get("artist_profit_per_unit"))
    a_share = round(1.0 - share, 4)
    a_sale = (ppu_artist * (1.0 - cann)) if ppu_artist is not None else None
    a_signup = (s2o * ppo * a_sale) if (s2o and a_sale is not None) else None

    def cost_at(value, roi):
        return (value / (share * roi)) if (readable and value and value > 0 and share > 0 and roi > 0) else None
    return {"readable": readable, "aa_profit_per_unit": ppu, "frame_share": frame_share, "frame_rate": frame_rate, "frame_rate_source": frame_src,
            "artist_profit_per_unit": ppu_artist, "artist_budget_share": a_share, "artist_value_per_sale": a_sale, "artist_value_per_signup": a_signup,
            "frame_profit_per_unit": frame_profit, "frame_uplift_per_unit": frame_uplift, "value_per_unit": value_unit if readable else None,
            "cannibalisation": cann, "value_per_sale": value_sale if readable else None,
            "signup_order_rate": s2o, "signup_order_rate_source": s2o_src, "purchases_per_order": ppo,
            "value_per_signup": value_signup if readable else None,
            "aa_budget_share": share, "aa_budget_share_assumed": assumed, "roi_target": roi_target,
            "break_even_cost_per_signup": cost_at(value_signup, 1.0), "cost_per_signup_at_target_roi": cost_at(value_signup, roi_target),
            "break_even_cost_per_sale": cost_at(value_sale, 1.0), "cost_per_sale_at_target_roi": cost_at(value_sale, roi_target)}


def _plan_frame_rate(products: list[dict]) -> float | None:
    """Airtable's framing take-up, weighted over the ticked works that frame."""
    rows = [(p.get("units_target") or p.get("edition") or 1.0, p["frame_conversion"]) for p in products
            if not p.get("excluded") and p.get("framing_available") is not False and _num(p.get("frame_conversion")) is not None]
    w = sum(u for u, _ in rows)
    return (sum(u * r for u, r in rows) / w) if w > 0 else None


def _sales_products(live: pd.DataFrame, products: list[dict], units_target: float | None) -> list[dict]:
    """One row per work from the orders table's lines, matched to Airtable's
    works by name, with its target (typed over Airtable's) and edition."""
    by_name = {pricing.norm(p.get("name") or ""): p for p in products}
    out = []
    for title, g in live.groupby("product_title"):
        p = by_name.get(pricing.norm(title))
        out.append({"name": str(title), "airtable_id": (p or {}).get("airtable_id"), "excluded": bool((p or {}).get("excluded")),
                    "units": float(g["units"].sum()), "awaiting": float(g.loc[g["status"] == "awaiting", "units"].sum()),
                    "orders": float(g["orders"].sum()), "target": (p or {}).get("units_target"), "edition": (p or {}).get("edition"),
                    "share": (float(g["units"].sum()) / units_target) if units_target else None})
    # a ticked work with no line yet still has its row
    seen = {pricing.norm(r["name"]) for r in out}
    for p in products:
        if not p.get("excluded") and pricing.norm(p.get("name") or "") not in seen:
            out.append({"name": p.get("name"), "airtable_id": p.get("airtable_id"), "excluded": False, "units": 0.0, "awaiting": 0.0, "orders": 0.0,
                        "target": p.get("units_target"), "edition": p.get("edition"), "share": 0.0 if units_target else None})
    return sorted(out, key=lambda r: -r["units"])


def data_to_hint(orders: dict | None) -> str | None:
    """How far the orders table's reading runs: the newest hour in the file."""
    try:
        h = orders["hourly"]["ts"].max() if orders and len(orders.get("hourly", [])) else None
        return _iso(h) if h is not None and not pd.isna(h) else None
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- the LE cards' blocks (spec §4, §5)
#
# The TL page is the LE page's cards in TL words (docs/TL_SPEC.md §4, §5), so
# the snapshot carries the blocks those cards read - the channels with their
# daily series and projections, the funnel's two factors and their
# contributions, the outcome waterfall, the hero, the paid pacing, the
# sell-through rows and the framing - in the state's own unit: signups by day
# from the announce to the open, units by hour from the sales open to the
# close. The arithmetic is the LE build's (etl/build.py: the one-at-a-time
# repricing of the funnel's factors, the forward rule, waterfall_walks), with
# the pre-window's signup pace curve or the window's unit curve as the plan's
# shape, and the untracked share spread over the tracked groups in proportion
# so the cards add up to the headline as the LE cards do.

def _spread(by_group: dict) -> dict[str, float]:
    """The groups' figures with the untracked share spread over them in proportion."""
    unt = float(by_group.get("untracked", 0.0) or 0.0)
    tracked = sum(float(by_group.get(g, 0.0) or 0.0) for g in GROUPS)
    if unt <= 0:
        return {g: float(by_group.get(g, 0.0) or 0.0) for g in GROUPS}
    if tracked <= 0:
        return {g: unt / len(GROUPS) for g in GROUPS}
    return {g: float(by_group.get(g, 0.0) or 0.0) * (1 + unt / tracked) for g in GROUPS}


def _cum_by_group(frame: pd.DataFrame | None, key: str, col: str, steps: list) -> list[dict[str, float]]:
    """Cumulative `col` by group at each step (the frame's `key` values up to
    and including the step), the untracked share spread over the groups."""
    zero = {g: 0.0 for g in GROUPS}
    if frame is None or not len(frame) or col not in frame.columns or "group" not in frame.columns:
        return [dict(zero) for _ in steps]
    piv = frame.groupby([key, "group"])[col].sum().unstack(fill_value=0.0).sort_index().cumsum()
    idx, cols = list(piv.index), list(piv.columns)
    out, j, run = [], 0, {c: 0.0 for c in cols}
    for s in steps:
        while j < len(idx) and idx[j] <= s:
            run = {c: float(piv.iloc[j][c]) for c in cols}
            j += 1
        by = {g: run.get(g, 0.0) for g in GROUPS}
        by["untracked"] = sum(v for c, v in run.items() if c not in GROUPS)
        out.append(_spread(by))
    return out


def _parts(frame: pd.DataFrame | None, col: str) -> list[dict]:
    """What a group's figure is made of, by channel, biggest first."""
    if frame is None or not len(frame) or col not in frame.columns or "channel" not in frame.columns:
        return []
    out = [{"name": str(ch), "value": round(float(v), 1)} for ch, v in frame.groupby("channel")[col].sum().items()
           if float(v) > 0.05 and str(ch).strip().lower() != "untracked"]
    return sorted(out, key=lambda x: -x["value"])


def _project(now: float, exp, tg, w: float, complete: bool) -> float:
    """The LE build's forward rule: the plan's remaining volume at this
    channel's demonstrated performance, trusted in proportion to how much of
    the pace has been seen; without a target, the pace alone."""
    if complete:
        return now
    if tg is None or tg <= 0:
        return (now / w) if w >= 0.05 else now
    r_perf = min(max((now / exp) if exp and exp > 0 else 1.0, 0.25), 2.5)
    return now + tg * (1 - w) * (1 + w * (r_perf - 1))


def _curve_at(curve: list, f: float) -> float:
    """The unit curve's cumulative share at a share `f` of the window, read between its steps."""
    if not curve:
        return min(max(f, 0.0), 1.0)
    pos = min(max(f, 0.0), 1.0) * (len(curve) - 1)
    i = int(math.floor(pos))
    j = min(i + 1, len(curve) - 1)
    return float(curve[i]) + (float(curve[j]) - float(curve[i])) * (pos - i)


def sell_forecast(cx: dict, channels: list[dict], profile: dict, targets: dict | None, products: list[dict], sp: pd.DataFrame | None) -> dict | None:
    """The sell-through forecast by work for a timed launch before its window
    opens (docs/TL_SPEC.md §4b), on two horizons: today's signups, and the
    signups projected to the open (each channel's projection on the page).

    Signup-led units: each channel's signups, product subscriptions and
    release ones apart, at the basket's signup -> order rate for that channel
    and kind (the typed rate over both when one is typed), times the pieces a
    signup-led order takes. A product signup is keyed to its work by the
    product page of its session (the pull); the keyed shares split the
    release signups and the unkeyed product ones pro rata. Non-signup units:
    the basket's median window units from buyers who never signed up, by
    channel, scaled by clip(signups over the basket's, 0.5 to 2) ** FORECAST_BETA,
    and spread over the works by the same shares. Under FORECAST_MIN_KEYED
    keyed signups the works split by their units target, else edition. The
    band is where completed launches landed around their forecast
    (FORECAST_BAND). None without works or a units target."""
    works = [p for p in products if not p.get("excluded")]
    units_target = (targets or {}).get("units_target") or _num((cx.get("econ") or {}).get("units_target"))
    if not works:
        if not units_target:
            return None
        works = [{"airtable_id": None, "name": cx.get("snap", {}).get("title") or "Release", "edition": None, "units_target": units_target}]
    d, now = cx["d"], cx["now"]
    pre = _pre_window(cx["daily"], cx["hourly"], d["sales_open"], now)
    su_g = _spread(_by_group(pre, "signups"))
    prod_g = _spread(_by_group(pre, "signups_product"))
    prod_g = {g: min(prod_g.get(g, 0.0), su_g.get(g, 0.0)) for g in GROUPS}
    rel_g = {g: max(su_g.get(g, 0.0) - prod_g[g], 0.0) for g in GROUPS}
    ch = {c["key"]: c for c in channels}
    # the keyed product signups per work and channel, from the pull's pre-window rows to date
    keyed = {id(w): {g: 0.0 for g in GROUPS} for w in works}
    keyed_total, unmatched = 0.0, 0.0
    if sp is not None and len(sp):
        rows = sp[sp["pre"] & sp["is_prod"] & sp["has_page"] & (sp["day"] <= cx["as_of"])]
        for r in rows.itertuples(index=False):
            w = work_for_page(r.page_title, r.page_path, works)
            if w is None:
                unmatched += float(r.signups)
                continue
            g = r.group if r.group in GROUPS else None
            n = float(r.signups)
            if g is None:   # untracked keyed signups: spread over the channels as the signups are
                tot = sum(su_g.values()) or 1.0
                for gg in GROUPS:
                    keyed[id(w)][gg] += n * su_g[gg] / tot
            else:
                keyed[id(w)][g] += n
            keyed_total += n
    unkeyed_g = {g: max(prod_g[g] - sum(keyed[id(w)][g] for w in works), 0.0) for g in GROUPS}
    # the works' shares: the keyed signups', else the units target's (else the edition's)
    if keyed_total >= FORECAST_MIN_KEYED:
        shares = {id(w): sum(keyed[id(w)].values()) / keyed_total for w in works}
        source = "signup pages"
    else:
        key_of = lambda w: _num(w.get("units_target")) or _num(w.get("edition")) or 0.0
        tot = sum(key_of(w) for w in works)
        shares = {id(w): (key_of(w) / tot if tot > 0 else 1.0 / len(works)) for w in works}
        source = "units target"
    # the rates: the basket's by channel and kind, the typed rate over both when one is typed
    typed_rate = (targets or {}).get("signup_order_rate") if (targets or {}).get("signup_order_rate_source") == "release" else None
    def rate(kind, g):
        if typed_rate:
            return float(typed_rate)
        by_g = profile.get(f"signup_order_rate_{kind}_by_group") or {}
        v = by_g.get(g) or profile.get(f"signup_order_rate_{kind}") or (profile.get("signup_order_rate_by_group") or {}).get(g) or profile.get("signup_order_rate") or 0.0
        return float(v)
    r_prod, r_rel = {g: rate("prod", g) for g in GROUPS}, {g: rate("rel", g) for g in GROUPS}
    ppo_typed = (targets or {}).get("purchases_per_order") if (targets or {}).get("purchases_per_order_source") == "release" else None
    ppo = float(ppo_typed or profile.get("ppo_su") or profile.get("purchases_per_order") or 1.0)
    ppo_src = "release" if ppo_typed else ("basket" if profile.get("ppo_su") else ("basket orders" if profile.get("purchases_per_order") else "default"))
    bm_non = profile.get("nonsu_units_by_group") or {}
    bm_non_untracked = float(profile.get("nonsu_units_untracked") or 0.0)
    lo_c, hi_c = FORECAST_PERF_CLIP

    def horizon(key):
        # the scale from today's signups to the horizon's, per channel, and the
        # performance against the basket the non-signup half reads
        out_g, perf_g, scale_g = {}, {}, {}
        for g in GROUPS:
            c = ch.get(g) or {}
            now_g = float(c.get("now") or su_g[g])
            tgt = float(c.get("proj") or now_g) if key == "open" else now_g
            scale_g[g] = (tgt / now_g) if now_g > 0 else 1.0
            bm = c.get("bm") if key == "open" else c.get("bmExp")
            perf_g[g] = (tgt / float(bm)) if bm and float(bm) > 0 else 1.0
            out_g[g] = float(bm_non.get(g) or 0.0) * (min(max(perf_g[g], lo_c), hi_c) ** FORECAST_BETA)
        tot_bm = sum(float((ch.get(g) or {}).get("bm" if key == "open" else "bmExp") or 0.0) for g in GROUPS)
        perf_all = (sum(float((ch.get(g) or {}).get("proj" if key == "open" else "now") or 0.0) for g in GROUPS) / tot_bm) if tot_bm > 0 else 1.0
        non_untracked = bm_non_untracked * (min(max(perf_all, lo_c), hi_c) ** FORECAST_BETA)
        non_total = sum(out_g.values()) + non_untracked
        works_out = []
        for w in works:
            sh = shares[id(w)]
            su = sum(scale_g[g] * (keyed[id(w)][g] * r_prod[g] + sh * (unkeyed_g[g] * r_prod[g] + rel_g[g] * r_rel[g])) for g in GROUPS) * ppo
            non = sh * non_total
            units = su + non
            edition, target = _num(w.get("edition")), _num(w.get("units_target"))
            works_out.append({"key": str(w.get("airtable_id") or slugify(str(w.get("name") or "work"))), "name": w.get("name"), "edition": edition, "target": target,
                              "keyed": round(sum(keyed[id(w)].values()), 1), "share": round(sh, 4),
                              "su": round(su, 1), "non": round(non, 1), "units": round(units, 1),
                              "lo": round(units * FORECAST_BAND[0], 1), "hi": round(units * FORECAST_BAND[1], 1),
                              "pct": (units / edition) if edition else None, "pctTarget": (units / target) if target else None})
        su_t, non_t = sum(x["su"] for x in works_out), sum(x["non"] for x in works_out)
        ed_t = sum(x["edition"] for x in works_out if x["edition"]) or None
        tg_t = sum(x["target"] for x in works_out if x["target"]) or None
        return {"works": works_out, "signups": round(sum(float((ch.get(g) or {}).get("proj" if key == "open" else "now") or 0.0) for g in GROUPS), 1),
                "su": round(su_t, 1), "non": round(non_t, 1), "units": round(su_t + non_t, 1),
                "lo": round((su_t + non_t) * FORECAST_BAND[0], 1), "hi": round((su_t + non_t) * FORECAST_BAND[1], 1),
                "edition": ed_t, "target": tg_t, "pct": ((su_t + non_t) / ed_t) if ed_t else None, "pctTarget": ((su_t + non_t) / tg_t) if tg_t else None,
                "nonByGroup": {g: round(v, 1) for g, v in out_g.items()}, "nonUntracked": round(non_untracked, 1),
                "perfByGroup": {g: round(v, 3) for g, v in perf_g.items()}, "perfAll": round(perf_all, 3)}
    today, at_open = horizon("today"), horizon("open")
    prod_total = sum(prod_g.values())
    return {"tl": True, "source": source, "keyed": round(keyed_total, 1), "keyedShare": (keyed_total / prod_total) if prod_total > 0 else None,
            "unmatched": round(unmatched, 1), "unkeyedProduct": round(sum(unkeyed_g.values()), 1), "releaseSignups": round(sum(rel_g.values()), 1),
            "productSignups": round(prod_total, 1),
            "rates": {"prod": {g: round(v, 4) for g, v in r_prod.items()}, "rel": {g: round(v, 4) for g, v in r_rel.items()},
                      "source": "release" if typed_rate else "basket"},
            "ppo": round(ppo, 4), "ppoSource": ppo_src, "beta": FORECAST_BETA, "perfClip": list(FORECAST_PERF_CLIP), "band": list(FORECAST_BAND),
            "nonsuBm": {**{g: round(float(bm_non.get(g) or 0.0), 1) for g in GROUPS}, "untracked": round(bm_non_untracked, 1)},
            "basketN": profile.get("n"), "minKeyed": FORECAST_MIN_KEYED,
            "today": today, "open": at_open}


def le_blocks(cx: dict) -> dict:
    """The LE cards' blocks for one TL page (the section note above): what
    build_tl lays over the snapshot. `cx` carries the state and dates, the
    series, the basket's profile (channels off applied), the targets, the paid
    spend and, inside the window, the orders table's reading."""
    import build as B  # noqa: E402 - lazily: build imports this module
    state, d, profile, targets, off = cx["state"], cx["d"], cx["profile"], cx["targets"], cx["off"]
    snap = cx["snap"]
    has_bm = bool(cx["basket_n"])
    targeted = targets is not None
    as_of, now, seen = cx["as_of"], cx["now"], cx["seen"]
    in_window = state in ("window", "settling", "closed")
    complete = state in ("settling", "closed")
    econ = cx.get("econ") or {}
    win = cx.get("win") or {}
    units_target = win.get("units_target") or (targets or {}).get("units_target") or _num(econ.get("units_target"))
    edition_total = _num(econ.get("edition_size"))
    k_all = (targets or {}).get("k")
    sales = cx.get("sales") or {}

    if not in_window:
        # ---- the pre-window: signups by day from the announce to the open
        open_day = d["sales_open"].date()
        announce = d["announce"] or (open_day - timedelta(days=TL_ASSUMED_PRE_DAYS))
        of_n = max((open_day - announce).days, 1)
        steps = [announce + timedelta(days=i) for i in range(of_n + 1)]
        labels = [s.isoformat() for s in steps]
        curve = profile.get("signup_curve") or []

        def share_at(dto: int) -> float:
            i = dto + TL_CURVE_DAYS
            if i < 0:
                return 0.0
            if not curve:
                return 1.0
            return float(curve[min(i, len(curve) - 1)])

        pace = [share_at((s - open_day).days) for s in steps]
        live = as_of < open_day
        day_no = max(min((as_of - announce).days, of_n), 0) if live else of_n
        frac_day = seen if live else 1.0
        dto = (min(as_of, open_day) - open_day).days
        pace_now = (share_at(dto - 1) + frac_day * (share_at(dto) - share_at(dto - 1))) if live else 1.0
        seen_steps = [i <= day_no for i in range(len(steps))]
        frame = cx["daily"]
        cum_by_g = _cum_by_group(frame, "day", "signups", steps)
        sess_by_g = _cum_by_group(frame, "day", "sessions", steps)
        tg_by = (targets or {}).get("signups_by_group") or {}
        bm_by = profile.get("signups_by_group") or {}
        conv_held = profile.get("conv") or {}
        bm_sess_by = profile.get("sessions_by_group") or {}
        bm_total = float(profile.get("signups") or 0.0)
        hero_target = (targets or {}).get("signup_target")
        spend_to_date, budget, cost = cx["spend_pre"], (targets or {}).get("budget_pre"), (targets or {}).get("cost_per_signup")
        cost_src = (targets or {}).get("cost_per_signup_source")
        frac_even = max(min((day_no - (1 - frac_day)) / of_n, 1.0), 0.0) if live else 1.0
        measure_col, step_unit, clock_start = "signups", "day", announce.isoformat()
        cap_total, edition = None, None
        day_steps = [s for s in steps if s <= (as_of if live else open_day)]
        clock_complete = not live
    else:
        # ---- the window: units by hour from the sales open to the close
        start, close = d["sales_open"], d["close"]
        until = win.get("until") or min(now, d["settle"])
        of_n = max(int(math.ceil((close - start).total_seconds() / 3600 - 1e-9)), 1)
        steps = [pd.Timestamp(start + timedelta(hours=i)) for i in range(of_n + 1)]
        labels = [_iso(s) for s in steps]
        curve = profile.get("unit_curve") or []
        pace = [_curve_at(curve, i / of_n) for i in range(of_n + 1)]
        h_now = min(max((until - start).total_seconds() / 3600, 0.0), float(of_n))
        day_no = of_n if complete else int(math.floor(h_now))
        frac_day = 1.0 if complete or h_now >= of_n else (h_now - math.floor(h_now))
        pace_now = 1.0 if complete else _curve_at(curve, h_now / of_n)
        seen_steps = [i == 0 or steps[i] <= pd.Timestamp(until) for i in range(len(steps))]
        o = win.get("o")
        hourly = cx["hourly"]
        sess_frame = _window(hourly, start, min(until, close)) if len(hourly) else hourly
        frame = o["live"] if o is not None else (_window(hourly, start, until) if len(hourly) else hourly)
        # the close step takes everything to `until`: the window's units are
        # its lines paid or awaiting by the settle, as the panel counts them
        cum_steps = steps[:-1] + [max(steps[-1], pd.Timestamp(until))]
        cum_by_g = _cum_by_group(frame, "ts", "units", cum_steps)
        sess_by_g = _cum_by_group(sess_frame, "ts", "sessions", steps)
        # the channels' targets split the units target by the basket's unit mix;
        # a basket with no unit mix on file leaves the channels without one
        shares = profile.get("share_units") or {}
        tg_by = {g: units_target * float(shares.get(g, 0.0)) for g in GROUPS} if (units_target and has_bm and sum(float(shares.get(g, 0.0)) for g in GROUPS) > 0) else {}
        bm_by = profile.get("units_by_group") or {}
        conv_held = profile.get("conv_window") or {}
        bm_sess_by = profile.get("sessions_window_by_group") or {}
        bm_total = float(profile.get("units") or 0.0)
        hero_target = units_target
        k_all = (units_target / bm_total) if (units_target and bm_total > 0) else None
        spend_to_date, budget, cost = cx["spend_win"], (targets or {}).get("budget_window"), (targets or {}).get("cost_per_sale")
        cost_src = (targets or {}).get("cost_per_sale_source")
        frac_even = 1.0 if complete else h_now / of_n
        measure_col, step_unit, clock_start = "units", "hour", _iso(start)
        # no cap at Airtable's edition: a timed launch's edition is not a ceiling
        # on its units (a 2023 launch sold 456 against an edition of 412), and
        # the chips carry the edition beside the target
        cap_total, edition = None, None
        d0, d1 = start.date(), (until if not complete else close).date()
        day_steps = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]
        clock_complete = complete

    # ---- each channel group: its series, its two funnel factors, its column
    kg = {}
    for g in GROUPS:
        tg, bm = tg_by.get(g), bm_by.get(g)
        kg[g] = (tg / bm) if (tg is not None and bm and bm > 0) else (k_all or 1.0)
    w = pace_now
    channels, fbg = [], {}
    tot = {"now": 0.0, "exp": 0.0, "tg": 0.0, "proj": 0.0, "bm": 0.0, "bm_exp": 0.0}
    now_idx = day_no
    for g in GROUPS:
        cum = [c[g] for c in cum_by_g]
        now_g = cum[now_idx]
        sess_g = sess_by_g[now_idx][g]
        tg = tg_by.get(g) if targeted else None
        bm = bm_by.get(g) if has_bm else None
        exp = (tg * w) if tg is not None else None
        bm_exp = (bm * w) if bm is not None else None
        proj = _project(now_g, exp, tg, w, clock_complete)
        daily = []
        for i in range(len(steps)):
            row = {"date": labels[i], "actual": round(cum[i], 2) if seen_steps[i] else None,
                   "plan": round(tg * pace[i], 2) if tg is not None else None, "proj": None}
            if bm is not None:
                row["bm"] = round(bm * pace[i], 2)
            if i > now_idx and not clock_complete:
                frac = ((pace[i] - w) / (1 - w)) if w < 1 else 1.0
                row["proj"] = round(now_g + (proj - now_g) * max(min(frac, 1.0), 0.0), 2)
            daily.append(row)
        # the two factors, sessions and the rate they convert at (held at the
        # basket's), repriced one at a time so the steps sum to the gap
        conv_act = (now_g / sess_g) if sess_g > 0 else 0.0
        held = float(conv_held.get(g) or 0.0)
        bm_sess = float(bm_sess_by.get(g) or 0.0)
        sess_exp = (exp / held) if (exp and held > 0) else ((bm_sess * w * kg[g]) if (exp and bm_sess > 0) else 0.0)
        conv_exp = (exp / sess_exp) if (exp and sess_exp > 0) else 0.0
        if conv_exp > RATE_MAX_UNITS_PER_SESSION:   # not a rate the feed measured: the whole gap reads as conversion
            sess_exp, conv_exp = 0.0, 0.0
        traffic = (sess_g - sess_exp) * conv_exp if sess_exp > 0 else 0.0
        conversion = (now_g - (exp or 0.0)) - traffic
        f = {"sessions_actual": round(sess_g, 1), "sessions_expected": round(sess_exp, 1) if exp is not None else None,
             "conv_actual": conv_act, "conv_expected": conv_exp if exp is not None else None,
             "contrib_traffic": round(traffic, 1), "contrib_conversion": round(conversion, 1),
             "bps_actual": conv_act, "bps_expected": conv_exp if exp is not None else None,
             "contrib_buyers": round(conversion, 1), "contrib_per_buyer": 0.0}
        if has_bm:
            sess_bm = bm_sess * w
            conv_bmx = (bm_exp / sess_bm) if (bm_exp and sess_bm > 0) else 0.0
            if conv_bmx > RATE_MAX_UNITS_PER_SESSION:
                sess_bm, conv_bmx = 0.0, 0.0
            traffic_bm = (sess_g - sess_bm) * conv_bmx if sess_bm > 0 else 0.0
            conversion_bm = (now_g - (bm_exp or 0.0)) - traffic_bm
            f.update({"sessions_benchmark": round(sess_bm, 1), "conv_benchmark": held if held > 0 else conv_bmx, "conv_benchmark_today": conv_bmx,
                      "contrib_traffic_bm": round(traffic_bm, 1), "contrib_conversion_bm": round(conversion_bm, 1),
                      "contrib_buyers_bm": round(conversion_bm, 1), "contrib_per_buyer_bm": 0.0})
        fbg[g] = f
        sub = frame[frame["group"] == g] if (frame is not None and len(frame) and "group" in frame.columns) else None
        ch = {"key": g, "name": GROUP_NAMES[g], "now": round(now_g, 1), "exp": round(exp, 1) if exp is not None else None,
              "proj": round(proj, 1), "target": round(tg, 1) if tg is not None else None,
              "parts": _parts(sub, measure_col), "daily": daily, "off": g in off,
              "sessions": round(sess_g, 1), "rate": conv_act if sess_g > 0 else None,
              "bmSessions": bm_sess if has_bm else None, "bmRate": held if (has_bm and held > 0) else None,
              "sessionsNeeded": ((targets or {}).get("sessions_by_group") or {}).get(g) if (targeted and not in_window) else None}
        if bm is not None:
            ch["bm"], ch["bmExp"] = round(bm, 1), round(bm_exp, 1)
        channels.append(ch)
        tot["now"] += now_g
        tot["proj"] += proj
        if exp is not None:
            tot["exp"] += exp
            tot["tg"] += tg
        if bm is not None:
            tot["bm"] += bm
            tot["bm_exp"] += bm_exp

    # ---- the hero: the groups summed, capped at the edition inside the window
    hero_now, hero_proj = tot["now"], tot["proj"]
    hero_tg = float(hero_target) if hero_target else (tot["tg"] if targeted and tot["tg"] > 0 else None)
    hero_exp = (hero_tg * w) if hero_tg else None
    hero_now_c = min(hero_now, cap_total) if cap_total else hero_now
    hero_proj_c = min(hero_proj, cap_total) if cap_total else hero_proj
    hero_bm = bm_total if has_bm else None
    hero_bm_today = tot["bm_exp"] if has_bm else None
    status = ((hero_now_c - hero_exp) / hero_exp) if hero_exp else None
    hero = {"now": round(hero_now_c, 0), "expectedToday": round(hero_exp, 0) if hero_exp is not None else None,
            "delta": (round(hero_now_c, 0) - round(hero_exp, 0)) if hero_exp is not None else None,
            "projected": round(hero_proj_c, 0), "target": round(hero_tg, 0) if hero_tg else None,
            "oversubscribedUnits": round(max(max(hero_now, hero_proj) - cap_total, 0.0), 0) if cap_total else 0.0,
            "statusPct": status, "ok": (status >= -0.1) if status is not None else None}
    if has_bm:
        hero["benchmark"] = B.whole(hero_bm)
        hero["benchmarkToday"] = B.whole(hero_bm_today)
        hero["stretch"] = (round(hero_tg, 0) - B.whole(hero_bm)) if hero_tg else None

    # ---- the outcome waterfall: organic traffic and conversion, paid spend and efficiency (docs §9)
    waterfall = None
    if targeted and hero_tg and hero_exp is not None:
        organic = [g for g in GROUPS if g != "paid"]
        wf_traffic = sum(fbg[g]["contrib_traffic"] for g in organic)
        wf_conv = sum(fbg[g]["contrib_conversion"] for g in organic)
        spend_planned = float(budget or 0.0) * frac_even
        wf_spend = ((spend_to_date - spend_planned) / cost) if cost else 0.0
        paid_gap = fbg["paid"]["contrib_traffic"] + fbg["paid"]["contrib_conversion"]
        now_shown, proj_shown = round(hero_now_c, 0), round(hero_proj_c, 0)
        over_today, over_close = round(hero_now, 0) - now_shown, round(hero_proj, 0) - proj_shown

        def beyond(over: float) -> list[dict]:
            return [{"key": "oversubscribed", "label": "Beyond sellout", "value": -over}] if over > 0 else []

        target_today = round(hero_exp, 0)
        today_steps, close_steps, scale = B.waterfall_walks([wf_traffic, wf_conv, wf_spend, paid_gap - wf_spend], hero_now - hero_exp, hero_proj - hero_tg,
                                                            round(hero_now, 0) - target_today, round(hero_proj, 0) - round(hero_tg, 0), clock_complete)
        waterfall = {"target": round(hero_tg, 0), "projection": proj_shown, "steps": close_steps + beyond(over_close),
                     "closeScale": round(scale, 4) if scale is not None else None,
                     "today": {"target": target_today, "actual": now_shown, "steps": today_steps + beyond(over_today)}}
        if has_bm:
            wf_traffic_bm = sum(fbg[g]["contrib_traffic_bm"] for g in organic)
            wf_conv_bm = sum(fbg[g]["contrib_conversion_bm"] for g in organic)
            bm_budget = float(bm_by.get("paid") or 0.0) * cost if cost else 0.0
            wf_spend_bm = ((spend_to_date - bm_budget * frac_even) / cost) if cost else 0.0
            paid_gap_bm = fbg["paid"]["contrib_traffic_bm"] + fbg["paid"]["contrib_conversion_bm"]
            bm_close, bm_today = B.whole(hero_bm), B.whole(hero_bm_today)
            today_bm, close_bm, scale_bm = B.waterfall_walks([wf_traffic_bm, wf_conv_bm, wf_spend_bm, paid_gap_bm - wf_spend_bm], hero_now - hero_bm_today, hero_proj - hero_bm,
                                                             round(hero_now, 0) - bm_today, round(hero_proj, 0) - bm_close, clock_complete)
            waterfall.update({"benchmark": bm_close, "stretch": round(hero_tg, 0) - bm_close, "stepsBm": close_bm + beyond(over_close),
                              "closeScaleBm": round(scale_bm, 4) if scale_bm is not None else None})
            waterfall["today"].update({"benchmark": bm_today, "stretch": target_today - bm_today, "stepsBm": today_bm + beyond(over_today)})

    # ---- paid: the pacing figures the paid cards read, and the daily cost series
    sp = cx.get("sp")
    paid_now = next((c["now"] for c in channels if c["key"] == "paid"), 0.0)
    by_day_spend = sp.groupby("day")["spend"].sum() if sp is not None and len(sp) else pd.Series(dtype=float)
    if frame is not None and len(frame) and "group" in frame.columns:
        pf = frame[frame["group"] == "paid"]
        key_day = pf["day"] if "day" in pf.columns else pf["ts"].dt.date
        paid_by_day = pf.groupby(key_day)[measure_col].sum() if len(pf) else pd.Series(dtype=float)
    else:
        paid_by_day = pd.Series(dtype=float)
    rows = []
    for day in day_steps:
        # the day in progress is no full day: the as-of day while it is today, or the share of it the feed has seen
        rows.append({"date": day.isoformat(), "spend": round(float(by_day_spend.get(day, 0.0)), 2), "entries": round(float(paid_by_day.get(day, 0.0)), 1),
                     "partial": bool(day == as_of and not clock_complete and (frac_day < 1 or as_of >= now.date()))})
    full = [r for r in rows if not r["partial"]]
    # the ROI reading (tl_paid_value): what a paid signup, or a paid sale, is
    # worth to AA over what it cost AA, the cost at AA's share of the spend;
    # the artist's reading of the same days at their profit and their share.
    # The LE paid block's keys and its zeros: a window with spend but nothing
    # bought reads 0, a window with no spend reads nothing.
    pv = cx.get("paid_value") or {}
    value = pv.get("value_per_sale") if in_window else pv.get("value_per_signup")
    share = float(pv.get("aa_budget_share") or 0.5)
    roi_ok = bool(pv.get("readable")) and value is not None and value > 0 and share > 0
    a_value = pv.get("artist_value_per_sale") if in_window else pv.get("artist_value_per_signup")
    a_share = float(pv.get("artist_budget_share") or 0.0)
    a_ok = roi_ok and a_value is not None and a_value > 0 and a_share > 0

    def roi_at(worth, part, s, e):
        if not roi_ok or worth is None or worth <= 0 or part <= 0 or s <= 0:
            return None
        return 0.0 if e <= 0 else round(worth / ((s / e) * part), 3)
    for i, r in enumerate(full):
        last3 = full[max(0, i - 2):i + 1]
        s3, e3 = sum(x["spend"] for x in last3), sum(x["entries"] for x in last3)
        r["cost3"] = (s3 / e3) if (s3 > 0 and e3 > 0) else None
        r["cost1"] = (r["spend"] / r["entries"]) if (r["spend"] > 0 and r["entries"] > 0) else None
        r["roi"], r["roi1"] = roi_at(value, share, s3, e3), roi_at(value, share, r["spend"], r["entries"])
        r["roiArtist"] = roi_at(a_value, a_share, s3, e3) if a_ok else None
        r["roiArtist1"] = roi_at(a_value, a_share, r["spend"], r["entries"]) if a_ok else None
    for r in rows:
        for k in ("cost3", "cost1", "roi", "roi1", "roiArtist", "roiArtist1"):
            r.setdefault(k, None)
    tot_spend, tot_got = sum(r["spend"] for r in rows), sum(r["entries"] for r in rows)
    last_full = next((r for r in reversed(full) if r["spend"] > 0), None)
    cum_cost = (tot_spend / tot_got) if (tot_spend > 0 and tot_got > 0) else None
    l3d_cost, l1d_cost = (last_full["cost3"] if last_full else None), (last_full["cost1"] if last_full else None)
    cum_roi = roi_at(value, share, tot_spend, tot_got)
    cum_roi_a = roi_at(a_value, a_share, tot_spend, tot_got) if a_ok else None
    # the forward path: the LE's cost path (docs §7) on the panel's priors, or
    # the campaign's own fit once it has the days - the trailing price rising
    # with the spend so far and the day's budget, read at today's spend over
    # the days left to the open or the close; the ROI line's dotted end
    roi_path, roi_path_a, decline, terms = [], [], {"start": None, "dailyFactor": None}, None
    if roi_ok and last_full and last_full.get("cost3") and last_full.get("roi") is not None and not clock_complete:
        terms = B.campaign_cost_terms(rows, BENCH)
        before = [sum(x["spend"] for x in full[:j]) for j in range(len(full))]
        clock3 = [(full[j]["spend"], before[j]) for j in range(max(0, len(full) - 3), len(full))]
        spent_so_far = sum(r["spend"] for r in full)
        w_spend = sum(sp for sp, _ in clock3)
        spend_ref = (w_spend / max(sum(1 for sp, _ in clock3 if sp > 0), 1)) if w_spend > 0 else None
        clock_ref = (sum(sp * c for sp, c in clock3) / w_spend) if w_spend > 0 else spent_so_far
        last_day = date.fromisoformat(full[-1]["date"])
        end_day = d["close"].date() if in_window else d["sales_open"].date()
        future = [last_day + timedelta(days=i) for i in range(1, (end_day - last_day).days + 1)]
        s0 = full[-1]["spend"] if full[-1]["spend"] > 0 else last_full["spend"]
        if future and s0 > 0:
            mult = B.CostPath(last_full["cost3"], spend_ref, clock_ref, spent_so_far, len(future),
                              terms["elasticity"], terms["wearout"], terms["wearoutK"]).multipliers(s0)
            roi_path = [{"date": fd.isoformat(), "roi": round(last_full["roi"] / f, 3)} for fd, f in zip(future, mult)]
            decline = {"start": last_full["roi"], "dailyFactor": round((1 / mult[-1]) ** (1 / len(mult)), 4) if mult and mult[-1] > 0 else None}
            if a_ok and last_full.get("roiArtist") is not None:
                roi_path_a = [{"date": fd.isoformat(), "roi": round(last_full["roiArtist"] / f, 3)} for fd, f in zip(future, mult)]
    paid_extra = {"spendToDate": round(float(spend_to_date), 2), "spendBudget": budget, "paidStartDays": 0, "unitsToDate": paid_now,
                  "benchmarkBudget": (float(bm_by.get("paid") or 0.0) * cost) if (has_bm and cost) else None,
                  "unit": "signup" if not in_window else "sale", "costPlan": cost, "costPlanSource": cost_src,
                  "costBm": profile.get("cost_per_signup" if not in_window else "cost_per_sale") or None,
                  "daily": rows, "cumCost": cum_cost, "l3dCost": l3d_cost, "l1dCost": l1d_cost,
                  "roiReadable": roi_ok, "roiTarget": pv.get("roi_target"), "cumRoi": cum_roi,
                  "l3dRoi": last_full["roi"] if last_full else None, "l1dRoi": last_full["roi1"] if last_full else None,
                  "roiPath": roi_path, "roiDeclineModel": decline,
                  "costTerms": {k: terms.get(k) for k in ("elasticity", "wearout", "wearoutK", "fitDays")} if terms else None,
                  "value": value if roi_ok else None, "valuePerUnit": pv.get("value_per_unit"), "profitPerUnitAA": pv.get("aa_profit_per_unit"),
                  "frameUpliftPerUnit": pv.get("frame_uplift_per_unit"), "frameRate": pv.get("frame_rate"), "frameRateSource": pv.get("frame_rate_source"),
                  "frameProfit": pv.get("frame_profit_per_unit"), "frameShare": pv.get("frame_share"),
                  "signupOrderRate": pv.get("signup_order_rate"), "signupOrderRateSource": pv.get("signup_order_rate_source"),
                  "piecesPerOrder": pv.get("purchases_per_order"), "cannibalisation": pv.get("cannibalisation"),
                  "aaBudgetShare": share, "aaBudgetShareAssumed": bool(pv.get("aa_budget_share_assumed", True)),
                  "breakEvenCost": pv.get("break_even_cost_per_sale" if in_window else "break_even_cost_per_signup"),
                  "costAtTargetRoi": pv.get("cost_per_sale_at_target_roi" if in_window else "cost_per_signup_at_target_roi"),
                  # the artist's reading of the same days (the LE block's keys): their
                  # profit per unit over their share of the spend; None throughout on a
                  # deal where the artist carries none of it
                  "artist": {"cumRoi": cum_roi_a, "l3dRoi": last_full["roiArtist"] if (last_full and a_ok) else None,
                             "l1dRoi": last_full["roiArtist1"] if (last_full and a_ok) else None,
                             "roiDeclineModel": {"start": last_full["roiArtist"] if (last_full and a_ok) else None, "dailyFactor": decline["dailyFactor"]},
                             "roiPath": roi_path_a, "finalDayRoi": None,
                             "profitPerUnit": pv.get("artist_profit_per_unit"), "budgetShare": a_share, "value": a_value if a_ok else None}}

    # ---- inside the window: the sell-through rows, the framing and the pieces per buyer
    sellthrough = framing = None
    upb = {"plan": 1.0, "actual": 1.0}
    if in_window and sales:
        src = sales.get("source")
        future_total = max(hero_proj_c - hero_now_c, 0.0) if not clock_complete else 0.0
        rows_p = [r for r in (sales.get("products") or []) if not r.get("excluded")]
        units_sum = sum(float(r["units"]) for r in rows_p)
        st_rows = []
        for r in rows_p:
            room = _num(r.get("target")) or _num(r.get("edition"))
            units_r, awaiting_r = float(r["units"]), float(r.get("awaiting") or 0.0)
            share = (units_r / units_sum) if units_sum > 0 else ((room / units_target) if (units_target and room) else 0.0)
            fut = future_total * share
            st_rows.append({"key": str(r.get("airtable_id") or slugify(str(r["name"]))), "name": str(r["name"]), "draws": [], "edition": room,
                            "sold": units_r - awaiting_r, "soldAssumed": 0.0, "drafts": awaiting_r, "shown": 0.0, "futurePredicted": round(fut, 1),
                            "room": max(room - units_r, 0.0) if room else None, "oversubscribed": 0.0, "allocated": None, "inHand": None,
                            "entrants": None, "flexible": 0, "orders": float(r.get("orders") or 0.0),
                            "pct": (units_r / room) if room else None, "pctClose": ((units_r + fut) / room) if room else None})
        awaiting = (sales.get("awaiting") or {}).get("units") if src == "orders" else None
        sellthrough = {"tl": True, "edition": units_target, "editionWord": "units target",
                       "sold": float(sales.get("unitsPaid")) if sales.get("unitsPaid") is not None else float(sales.get("units") or 0.0),
                       "drafts": awaiting, "soldPredicted": 0.0, "futureEntriesPredicted": round(future_total, 1),
                       "pct": ((hero_now_c + future_total) / units_target) if units_target else None,
                       "conversion": 1.0, "preorderConversion": 1.0, "products": st_rows, "incomplete": [] if src == "orders" else ["orders table"],
                       "patterns": [], "draws": [], "measure": "units", "editionMismatch": False, "allocationStarted": False, "claimsInFlight": 0,
                       "orders": sales.get("orders"), "piecesPerOrder": sales.get("piecesPerOrder"), "cancelled": sales.get("cancelled"),
                       "private": sales.get("private"), "source": src, "note": sales.get("note"), "feedUnits": sales.get("feedUnits")}
        fr = sales.get("framing")
        o = win.get("o")
        if fr and o is not None:
            works = []
            for title, g in o["paid"].groupby("product_title"):
                p_off, f_n = float(g["prints_offered"].sum()), float(g["frames"].sum())
                if p_off > 0:
                    works.append({"name": str(title), "prints": p_off, "frames": f_n, "rate": f_n / p_off})
            not_offered = [p for p in (cx.get("products") or []) if not p.get("excluded") and p.get("framing_available") is False]
            by_title = {pricing.norm(str(t)): float(v) for t, v in o["live"].groupby("product_title")["units"].sum().items()} if len(o["live"]) else {}
            rate = (fr["framesPaid"] / fr["printsOfferedPaid"]) if fr.get("printsOfferedPaid") else None
            ent = ({"prints": fr["printsOfferedAwaiting"], "frames": fr["framesAwaiting"], "rate": fr["framesAwaiting"] / fr["printsOfferedAwaiting"]}
                   if fr.get("printsOfferedAwaiting") else None)
            framing = {"tl": True, "prints": fr.get("printsOfferedPaid", 0.0), "frames": fr.get("framesPaid", 0.0), "rate": rate,
                       "entrants": ent, "entrantsLabel": "Awaiting payment", "entrantsSub": "orders not yet paid",
                       "plan": fr.get("planRate"), "benchmark": {"rate": fr["bmRate"], "n": profile.get("n"), "of": profile.get("n")} if fr.get("bmRate") else None,
                       "works": sorted(works, key=lambda x: -x["prints"]),
                       "notOffered": {"units": sum(by_title.get(pricing.norm(str(p.get("name") or "")), 0.0) for p in not_offered),
                                      "works": [str(p.get("name")) for p in not_offered]},
                       "asOf": as_of.isoformat(), "forecast": None}
        plan_upb = _num((targets or {}).get("purchases_per_order")) or _num(profile.get("purchases_per_order")) or 1.0
        act_upb = _num(sales.get("piecesPerOrder")) or plan_upb
        upb = {"plan": round(plan_upb, 4), "actual": round(act_upb, 4)}

    # ---- the benchmark block's LE keys, the clock, the words the cards need
    bench = dict(snap.get("benchmark") or {})
    if has_bm:
        bench.update({"k": k_all, "kByGroup": kg, "stretchFrom": (targets or {}).get("stretch_from"), "stretchTyped": bool((targets or {}).get("stretch_typed")),
                      "channelsOff": list(off), "convByGroup": {g: float(conv_held.get(g) or 0.0) for g in GROUPS},
                      "sessionsByGroup": {g: float(bm_sess_by.get(g) or 0.0) for g in GROUPS}, "sessions": sum(float(bm_sess_by.get(g) or 0.0) for g in GROUPS),
                      ("unitsByGroup" if in_window else "signupsByGroup"): {g: float(bm_by.get(g) or 0.0) for g in GROUPS},
                      ("units" if in_window else "signups"): bm_total, "n": profile.get("n"), "price": profile.get("price")})
    code, names = cx.get("code"), cx.get("names") or []

    # ---- the email stages' references (the LE build's, on the TL email cohort)
    # The card's sends are the pre-window sends, so the stages are the funnel's
    # while the funnel reads the pre-window; inside the window the sessions are
    # the window's and the sends do not explain them, so the stages step aside
    # and AA Email reads as sessions and conversion like the other groups.
    # The delivered target is the sends the plan's expected AA Email sessions by
    # today imply at the cohort's open rate, clicks per open and sessions per
    # click, the benchmark the same for the basket's sessions; until two
    # launches give a sessions-per-click median, the cohort's median send on
    # its delivery curve at today's point in the pre-window stands in.
    eb = B.email_bench_for(cx.get("email_bench"), cx.get("release")) if cx.get("email_bench") else None
    email = dict(snap["email"]) if isinstance(snap.get("email"), dict) else None
    if email is None and in_window:
        # no sends on file, but the card still has to know the stages are not the window's
        email = {"code": code, "sends": 0, "sequence": [], "automated": 0, "totals": None, "delivered": 0, "opened": 0, "clicked": 0, "feedThrough": None}
    if email is not None:
        email["deliveredTarget"], email["deliveredBenchmark"], email["funnelStages"] = None, None, not in_window
        if not in_window:
            f_em = fbg.get("aa_email") or {}
            chain = (eb["open_rate"] * eb["ctor_rate"] * eb["spc_rate"]) if eb and all(eb.get(k) for k in ("open_rate", "ctor_rate", "spc_rate")) else None
            sess_plan, sess_bm = f_em.get("sessions_expected"), f_em.get("sessions_benchmark")
            if chain and sess_plan:
                email["deliveredTarget"] = round(sess_plan / chain, 1)
            elif eb and eb.get("total") is not None:
                email["deliveredTarget"] = round(eb["total"] * float(np.interp(frac_even, B.CURVE_GRID, eb["curve"])), 1)
            if chain and sess_bm:
                email["deliveredBenchmark"] = round(sess_bm / chain, 1)
            elif email["deliveredTarget"] is not None and not chain:
                email["deliveredBenchmark"] = email["deliveredTarget"]
    benchmarks = {**(snap.get("benchmarks") or {}), **B.email_refs(eb)}

    # ---- the post counts (the LE's social block over this state's span)
    content, artist_posts = cx.get("content"), cx.get("artist_posts")
    social = None
    if content is not None:
        span = (announce, min(as_of, open_day)) if not in_window else (day_steps[0], day_steps[-1])
        social = B.social_block(content, artist_posts, code, span[0], span[1])

    # the forecast by work: from the announce to the open (an unannounced launch has no signups to read)
    forecast = None
    if state == "signups":
        forecast = sell_forecast(cx, channels, profile, targets, cx.get("products") or [], cx.get("signup_products"))
    out = {"hero": {**(snap.get("hero") or {}), **hero}, "channels": channels, "funnelByGroup": fbg, "waterfall": waterfall,
           "email": email, "benchmarks": benchmarks, "sellForecast": forecast,
           "paid": {**(snap.get("paid") or {}), **paid_extra}, "edition": edition,
           "clock": {"unit": step_unit, "start": clock_start, "of": of_n, "day": day_no, "complete": clock_complete},
           "of": of_n, "day": day_no, "asOfFraction": frac_day, "complete": complete, "unitsPerBuyer": upb,
           "sellthrough": sellthrough, "framing": framing, "unitsSource": "orders" if (in_window and win.get("o") is not None) else "funnel",
           "campaignName": names[0] if names else (f"{code} · Sign-ups" if code else None), "social": social}
    if bench:
        out["benchmark"] = bench
    if targeted:
        out["targets"] = {**targets, "paid": {"cost_per_purchase": cost, "cost_per_purchase_source": cost_src, "budget": budget}}
    return out



def notion_entry(notion: dict | None, code: str | None, name: str | None) -> dict:
    """The Notion log's entry for a launch (etl/build.py load_notion_campaigns):
    by its campaign code, else by its name, as the LE build's notion_dates_for
    reads it - a launch has a page and a log before it has a code."""
    n = notion or {}
    return dict((n.get(str(code)) if code else None) or (n.get("name:" + str(name)) if name else None) or {})


def resolve_lead(inp: dict, airtable_lead: str | None, notion: dict | None, code: str | None, name: str | None) -> tuple[str | None, str | None]:
    """The marketing lead in force and where it came from, as the LE build
    reads it (resolve_release): the Notion log, where the team records it,
    else Airtable's field on the launch's records, else what was typed."""
    for src, v in (("notion", notion_entry(notion, code, name).get("marketing_lead")), ("airtable", airtable_lead), ("typed", inp.get("marketing_lead"))):
        if v and str(v).strip():
            return str(v).strip(), src
    return None, None


def build_tl(rec: dict, series: dict | None, panel: pd.DataFrame, curves: dict, spend: pd.DataFrame | None, emails: pd.DataFrame | None,
             as_of: date, now: datetime, seen: float = 1.0, orders_data: dict | None = None, email_bench: dict | None = None,
             content: pd.DataFrame | None = None, artist_posts: pd.DataFrame | None = None, signup_products: pd.DataFrame | None = None,
             direct: dict | None = None, notion: dict | None = None) -> dict:
    """The page snapshot of one TL (module docstring). `email_bench` is the
    run's email cohort (email_cohort), `content` the Emplifi post export and
    `artist_posts` the Notion post log, for the funnel's email and post rows;
    `notion` the log's campaign entries (the marketing lead, resolve_lead).
    `direct` builds the Direct switch's view (docs §3b): `series`,
    `orders_data` and `signup_products` are then the frames read with Direct
    spread (direct_spread_data), `direct["panel"]` the panel built from them,
    and the plan's headline and budgets stay, re-split by channel."""
    d = rec["dates"]
    inp = rec.get("inputs") or {}
    state = state_of(d, now)
    name = rec["release_name"]
    daily, hourly = _rel_rows(series, name) if series else (pd.DataFrame(), pd.DataFrame())
    products, prod_info = _products(rec)
    econ = prod_info["economics"]
    lead, lead_src = resolve_lead(inp, prod_info.get("marketing_lead"), notion, rec.get("campaign_code"), name)
    airtable_units = econ["units_target"] if econ["units_target"] else _num((rec.get("launch") or {}).get("units_target"))
    price = econ["unit_price_eur"] or _num((rec.get("launch") or {}).get("unit_price_eur"))
    release_for_basket = {"release_name": name, "artist": rec["artist"], "window_open": _iso(d["open"]), "window_hours": d["hours"],
                          "announce_date": _iso(d["announce"]), "launch_end": _iso(d["close"].date()) if d["close"] else None,
                          "units_target": _num(inp.get("units_target")) or airtable_units, "unit_price_eur": price,
                          "prefer_recent": inp.get("prefer_recent") is not False}
    rb = resolve_basket(inp.get("benchmark_basket"), panel, curves, release_for_basket, as_of)
    basket = rb["basket"]
    off = channels_off_of(inp)
    profile = apply_channels_off(basket["profile"], off)
    launch_value = (release_for_basket["units_target"] or 0) * price if price and release_for_basket["units_target"] else None
    targets = tl_targets(inp, airtable_units, profile, launch_value)
    # a paid signup's worth is the plan's, read on the basket as the feed attributes it, whichever view the page is on
    paid_value = tl_paid_value(inp, profile, targets, econ)
    if direct:
        # the Direct switch's view (docs §3b): the frames carry Direct spread over the other channels, the
        # basket is read off the panel built the same way, and the plan is re-split on it with its budgets held
        profile = apply_channels_off(spread_profile(basket_profile(direct["panel"], curves, basket["members"]), basket["profile"], direct.get("norm")), off)
        targets = respread_targets(targets, inp, profile)
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
    # Direct's share of the page's own figures as the feed attributes them, before the switch's spread moves it: the switch's words
    dshare = None if direct else direct_share(pre if state not in ("upcoming", "signups") else daily, ("signups", "sessions"))

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

    # ---- sales: the window's units, from the orders table (paid plus awaiting,
    # by the hour, channel and product, with the frames and the buyers) where
    # it has the launch's lines, else from the feed's purchase events
    sales = None
    win_cx = None
    if state in ("window", "settling", "closed"):
        until = min(now, d["settle"])
        span = (d["close"] - d["sales_open"]).total_seconds()
        unit_curve = profile.get("unit_curve") or [0.0] * len(CURVE_FRACS)
        units_target = release_for_basket["units_target"]
        feed_win = _window(hourly, d["sales_open"], until) if len(hourly) else hourly
        feed_units = float(feed_win["units"].sum()) if len(feed_win) else 0.0
        feed_orders = float(feed_win["orders"].sum()) if len(feed_win) else 0.0
        o_rows = _orders_rows(orders_data, name)
        o = window_from_orders(o_rows, d["sales_open"], until) if o_rows is not None else None
        use_orders = o is not None and o["units"] > 0
        win_cx = {"until": until, "o": o if use_orders else None, "units_target": units_target}
        if use_orders:
            live = o["live"]
            by_hour = live.groupby("ts")["units"].sum()
            ug = o["by_group"]
            units, orders_n = o["units"], (feed_orders if feed_orders > 0 else o["orders"])
        else:
            by_hour = feed_win.groupby("ts")["units"].sum() if len(feed_win) else pd.Series(dtype=float)
            ug = _by_group(feed_win, "units")
            units, orders_n = feed_units, feed_orders
        if use_orders or len(hourly):
            hours = []
            h, cum = d["sales_open"], 0.0
            while h < d["close"] and h <= until + timedelta(hours=1):
                cum += float(by_hour.get(pd.Timestamp(h), 0.0))
                f = min((h + timedelta(hours=1) - d["sales_open"]).total_seconds() / span, 1.0) if span > 0 else 1.0
                i = min(int(round(f * TL_UNIT_CURVE_STEPS)), TL_UNIT_CURVE_STEPS)
                hours.append({"hour": _iso(h), "sinceOpen": round((h - d["sales_open"]).total_seconds() / 3600, 1), "units": float(by_hour.get(pd.Timestamp(h), 0.0)),
                              "cum": cum, "plan": (units_target * unit_curve[i]) if units_target else None,
                              "bm": (profile["units"] * unit_curve[i]) if basket["n"] else None})
                h += timedelta(hours=1)
            f_now = min(max((until - d["sales_open"]).total_seconds() / span, 0.0), 1.0) if span > 0 else 1.0
            i_now = min(int(round(f_now * TL_UNIT_CURVE_STEPS)), TL_UNIT_CURVE_STEPS)
            exp_units = (units_target * unit_curve[i_now]) if units_target else None
            paid_units = ug.get("paid", 0.0)
            sales = {"source": "orders" if use_orders else "feed", "units": units, "orders": orders_n, "piecesPerOrder": (units / orders_n) if orders_n else None,
                     "unitsTarget": units_target, "expectedNow": exp_units, "bmNow": (profile["units"] * unit_curve[i_now]) if basket["n"] else None,
                     "bmUnits": profile["units"] if basket["n"] else None, "statusPct": ((units - exp_units) / exp_units) if exp_units else None,
                     "byHour": hours,
                     "byGroup": [{"key": g, "name": GROUP_NAMES[g], "units": ug.get(g, 0.0), "target": (units_target * profile["share_units"][g]) if units_target else None,
                                  "bm": profile["units_by_group"][g] if basket["n"] else None} for g in GROUPS],
                     "untracked": ug.get("untracked", 0.0), "feedUnits": feed_units,
                     "spend": spend_win, "paidUnits": paid_units, "costPerSale": (spend_win / paid_units) if paid_units >= PAID_COST_MIN_UNITS and spend_win > 0 else None,
                     "dataTo": data_to_hint(orders_data) if use_orders else None}
            if use_orders:
                sales.update({
                    "unitsPaid": o["units_paid"], "private": o["private"], "cancelled": o["cancelled"],
                    "awaiting": {"units": o["awaiting_units"], "orders": o["awaiting_orders"], "value": o["awaiting_value"]},
                    "framing": {"printsOfferedPaid": o["prints_offered_paid"], "framesPaid": o["frames_paid"],
                                "printsOfferedAwaiting": o["prints_offered_awaiting"], "framesAwaiting": o["frames_awaiting"],
                                "bmRate": profile.get("frames_per_print") or None, "planRate": _plan_frame_rate(products)} if o["prints_offered_paid"] + o["prints_offered_awaiting"] > 0 else None,
                    "products": _sales_products(live, products, units_target),
                    "note": "units are the orders table's paid lines plus the orders awaiting payment (drafts and pending), by pieces, made from the sales open; "
                            "each order on the channel of its purchase event in the TL feed",
                })
                b = (orders_data or {}).get("buyers_by_release", {}).get(name)
                if b is not None and _num(b.get("buyers")):
                    sales["multiples"] = {"buyers": float(b["buyers"]), "multiple": float(b["buyers_multiple"]), "piecesPerBuyer": (float(b["pieces"]) / float(b["buyers"])) if float(b["buyers"]) else None,
                                          "bmShare": profile.get("multiple_share") or None}
            else:
                sales.update({"private": float(feed_win["units_private"].sum()) if "units_private" in feed_win.columns and len(feed_win) else None,
                              "cancelled": float(feed_win["units_cancelled"].sum()) if "units_cancelled" in feed_win.columns and len(feed_win) else None,
                              "note": "units are the feed's purchase events, pieces on orders not cancelled; the orders table has no lines for this launch yet"})

    if dshare is not None:
        dshare["units"] = None
        if win_cx is not None and len(hourly):
            w_feed = _window(hourly, d["sales_open"], win_cx["until"])
            w_units = win_cx["o"]["live"] if win_cx["o"] is not None else w_feed
            dshare["units"] = direct_share(w_units, ("units",))["units"]
            dshare["sessions"] = direct_share(w_feed, ("sessions",))["sessions"]

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
        "campaignCode": code, "campaignNames": names or ([f"{code} · Sign-ups"] if code else []), "marketingLead": lead,
        # where the lead came from (notion / airtable / typed), as the LE page says it (docs 1.6)
        "inputSources": {"marketing_lead": lead_src},
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
        "airtable": {**{k: launch.get(k) for k in ("airtable_release", "airtable_ids", "titles", "n_products", "launch_type", "project_status", "edition_size",
                                                   "unit_price", "unit_price_eur", "currency", "launch_value_eur", "units_target", "launch_time", "tl_length",
                                                   "tl_end_date", "announce_dates", "price_match")},
                     "marketing_lead": prod_info.get("marketing_lead")} if launch else None,
        "products": products, "productsNote": prod_info["note"], "economics": econ, "paidValue": paid_value,
        "directShare": dshare,
        "hero": {"now": now_signups, "unique": _num(feed_row.get("signups_unique")), "expectedToday": expected, "delta": (now_signups - expected) if expected is not None else None,
                 "projected": projected, "target": target, "statusPct": status_pct, "ok": (status_pct >= 0) if status_pct is not None else None,
                 "benchmark": (profile["signups"] if basket["n"] else None), "benchmarkToday": bm_today if basket["n"] else None, "benchmarkPct": bm_pct,
                 "daysToOpen": -dto_today, "shareToday": share_today, "preAnnounce": pre_announce},
        "targets": targets,
        "benchmark": {"basket": {k: basket.get(k) for k in ("id", "kind", "name", "desc", "n", "members", "thin", "fallback")},
                      "members": basket_members(panel, basket.get("members")),
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
    snap.update(le_blocks({"state": state, "d": d, "as_of": as_of, "now": now, "seen": seen, "daily": daily, "hourly": hourly,
                           "profile": profile, "basket_n": basket["n"], "targets": targets if targeted else None, "off": off,
                           "spend_pre": spend_pre, "spend_win": spend_win, "sp": sp, "sales": sales, "win": win_cx,
                           "products": products, "econ": econ, "snap": snap, "code": code, "names": names,
                           "email_bench": email_bench, "content": content, "artist_posts": artist_posts, "paid_value": paid_value,
                           "signup_products": signup_products,
                           "release": {"id": rec["id"], "release_name": name, "campaign_code": code, "launch_end": release_for_basket["launch_end"]}}))
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


def sourced_for(rec: dict, snap: dict, spend: pd.DataFrame | None, notion: dict | None = None) -> dict:
    """The inputs document's `sourced` block for a TL: what the feeds hold
    beside what is typed - Airtable's products, dates, units target and
    marketing lead, the feed's dates, the Notion log's marketing lead."""
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
                     "private_room_open": None, "marketing_lead": (snap.get("airtable") or {}).get("marketing_lead"), "closes": []},
        "feed": {"announce_date": d["readings"]["announce"]["feed"], "window_open": d["readings"]["open"]["feed"],
                 "window_open_adjusted": d["readings"]["open"]["feed_adjusted"]},
        "notion": {"marketing_lead": notion_entry(notion, rec.get("campaign_code"), rec.get("release_name")).get("marketing_lead")},
        "clock": {}, "campaigns": campaigns, "tl": True,
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
    notion (the Notion log's campaign entries, etl/build.py
    load_notion_campaigns: the marketing lead), write (bool), only (a release
    id, for the single-release build), configured_ids (ids with saved inputs:
    their pages go to APP/releases).
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
    notion = ctx.get("notion") or {}
    orders_data = ctx["orders"] if "orders" in ctx else load_orders()
    if series is not None:
        panel, curves = panel_frame(series, timed, spend, emails, as_of, now, orders_data)
    else:
        panel, curves = pd.DataFrame(), {}
    out["panel_n"] = len(panel)
    # the email references every page's funnel reads its sends against (own and later launches set aside per page)
    email_bench = email_cohort(panel, emails, as_of)
    content, artist_posts = ctx.get("content"), ctx.get("artist_posts")
    signup_products = ctx["signup_products"] if "signup_products" in ctx else load_signup_products()
    # the Direct switch's view (docs §3b): every frame read with Direct spread over the other
    # channels, and the panel built from them, so a page is built both ways below
    spread = direct_spread_data(series, orders_data, signup_products) if ctx.get("direct_spread", True) else None
    direct_cx = None
    if spread is not None:
        panel_spread, _ = panel_frame(spread["series"], timed, spend, emails, as_of, now, spread["orders"])
        direct_cx = {"panel": panel_spread, "norm": direct_norm(series, panel)}
    if ctx.get("write", True):
        APP.mkdir(parents=True, exist_ok=True)
        tmp = PANEL.with_suffix(".tmp"); panel.to_csv(tmp, index=False); tmp.replace(PANEL)
        tmp = CURVES.with_suffix(".tmp"); tmp.write_text(json.dumps(_json_safe({"asOf": as_of.isoformat(), "curves": curves}), separators=(",", ":"))); tmp.replace(CURVES)
        tmp = CANDIDATES.with_suffix(".tmp"); tmp.write_text(json.dumps(_json_safe({"asOf": as_of.isoformat(), "rows": candidate_rows(panel)}), indent=1)); tmp.replace(CANDIDATES)
    recs = tl_releases(series or {"releases": pd.DataFrame(columns=["release"]), "daily": pd.DataFrame(), "hourly": pd.DataFrame(), "by_release": {}, "hourly_by_release": {}},
                       ctx.get("launch_frame"), ctx.get("inputs") or [], as_of, now, spend, emails)
    only = ctx.get("only")
    configured = set(ctx.get("configured_ids") or [])
    for rec in recs:
        if only and rec["id"] != only:
            continue
        try:
            snap = build_tl(rec, series, panel, curves, spend, emails, as_of, now, seen, orders_data,
                            email_bench=email_bench, content=content, artist_posts=artist_posts,
                            signup_products=signup_products.get(rec["release_name"]), notion=notion)
        except Exception as e:  # noqa: BLE001 - one page's failure never stops the build
            out["failures"].append((rec["id"], f"{type(e).__name__}: {e}"))
            continue
        if direct_cx is not None:
            # built both ways: the blocks that differ with Direct spread ride under variants.direct_spread
            # and the dashboard's Direct switch lays them over the page (the LE build's with_direct_spread)
            try:
                alt = build_tl(rec, spread["series"], panel, curves, spend, emails, as_of, now, seen, spread["orders"],
                               email_bench=email_bench, content=content, artist_posts=artist_posts,
                               signup_products=spread["signup_products"].get(rec["release_name"]), direct=direct_cx, notion=notion)
                # the sell-through forecast is the one exception: its rates by channel and kind are measured on the
                # feed's attribution of signups, so it reads that whichever view the page is on (docs §3b)
                snap["variants"] = {"direct_spread": {k: v for k, v in alt.items()
                                                      if k not in ("variants", "directShare", "sellForecast") and _json_safe(v) != _json_safe(snap.get(k))}}
            except Exception as e:  # noqa: BLE001 - the page stands without its spread view
                out["failures"].append((f"{rec['id']} (Direct spread)", f"{type(e).__name__}: {e}"))
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
        out["sourced"][rec["id"]] = _json_safe(sourced_for(rec, snap, spend, notion))
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
    now_arg = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--now=")), None)
    # --now=2026-06-30T20:00:00Z replays a completed launch as it stood at that moment (its window, its settling)
    now = _ts(now_arg) or datetime.now(timezone.utc)
    as_of = date.fromisoformat(as_of_arg) if as_of_arg else now.date()
    res = build_all({"as_of": as_of, "now": now, "seen": 1.0, "launch_frame": B.load_launches(),
                     "inputs": B.INPUTS["releases"], "spend": B.load_spend(), "emails": B.load_emails(),
                     "content": B.load_content(), "artist_posts": B.load_artist_posts(), "notion": B.load_notion_campaigns(),
                     "write": "--write" in sys.argv})
    print(res["note"])
    for row in res["rows"]:
        print(f"  {row['releaseName'][:48]:48s} {row['tlState']:9s} {row['tlLabel']:28s} pct={row['statusPct']}")
    for rid, err in res["failures"]:
        print(f"  FAILED {rid}: {err}")
