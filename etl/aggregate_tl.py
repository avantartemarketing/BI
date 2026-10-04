#!/usr/bin/env python3
"""Aggregate the timed-launch feeds into the counts the TL pages and the TL
panel read (docs/TL_SPEC.md §3, §8).

Inputs, both written by server/bigquery.js (the TL feeds section):
  sources/tl_events.csv     signup and purchase events with a pseudonymous
                            account id and no address, all time
  sources/tl_browsing.csv   sessions and page views per channel x day x release,
                            counted inside BigQuery, and by the hour from two
                            days before a launch's window opens to nine after

Outputs, counts only (no identifier leaves this script; the account id is
used here to count distinct people and buyers of several pieces, then dropped):
  data/app/tl_daily.csv     per release x day x channel: sessions, page views,
                            signups (and how many of them later converted, how
                            many were a release subscription against a product
                            one, and the product ones with their conversions
                            apart), orders, units (pieces, cancelled orders
                            out), the units on orders placed by a signup,
                            private-room units
  data/app/tl_hourly.csv    the same per release x hour (UTC) x channel inside
                            the band the browsing feed keeps the hour for: what
                            the in-window state reads
  data/app/tl_releases.csv  one row per release: the feed's own launch timestamp
                            and announce date, first and last day seen, the
                            totals, distinct signups and buyers, buyers of more
                            than one piece, the newest event's timestamp
  data/app/tl_feed.json     when this ran and how far the feeds reach

The feed's launch_date is the platform's own public open and runs an hour
late in summer (etl/tl.py works the real open out from Airtable, the feed and
the sales); this script keeps it as the feed gave it. Signups are every
signup event the feed tags to the release (decision 6 of the spec); units are
order_pieces on purchase events with cancelled_order 0.

Run from the repo root: python3 etl/aggregate_tl.py  (the refresh runs it after aggregate_events.py)
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys
from datetime import datetime, timezone

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = pathlib.Path(os.environ.get("SOURCES_PATH") or (ROOT / "sources"))
EVENTS = SOURCES / "tl_events.csv"
BROWSING = SOURCES / "tl_browsing.csv"
APP = pathlib.Path(os.environ.get("APP_DATA_PATH") or (ROOT / "data" / "app"))
DAILY = APP / "tl_daily.csv"
HOURLY = APP / "tl_hourly.csv"
RELEASES = APP / "tl_releases.csv"
FEED = APP / "tl_feed.json"

CH = "AA_session_custom_channel_group_split_touch"
REL = "simple_release_name"
EVENT_COLS = ["event_timestamp", "event_date", "event_name", "aa_account_id", REL, "launch_date", "announcement_date",
              "aa_subscription_type", "converted_signup", "pre_post_launch_signup", "pre_post_launch_purchase",
              "order_type", "pr_order", "cancelled_order", "order_pieces", "purchase_with_signup", CH]
METRICS = ["sessions", "page_views", "signups", "signups_converted", "signups_release", "signups_with_order",
           "signups_product", "signups_product_converted", "units_with_signup",
           "orders", "units", "units_private", "orders_cancelled", "units_cancelled"]
NAME_RE = re.compile(r"^(?P<artist>.+?) · (?P<title>.+) · (?P<quarter>\d{4} Q[1-4])$")


def channel(s: pd.Series) -> pd.Series:
    """The split-touch channel as the LE pages spell it: the feed's lower-case
    'untracked' is 'Untracked', an empty one is Untracked too."""
    out = s.fillna("").astype(str).str.strip()
    return out.where(~out.str.lower().isin(["", "untracked", "(none)", "none"]), "Untracked")


def flag(s: pd.Series) -> pd.Series:
    """1/0, true/false, blank: a boolean."""
    return s.map(lambda v: str(v).strip().lower() in ("1", "1.0", "true")).astype(bool)


def split_name(name: str) -> tuple[str, str, str]:
    m = NAME_RE.match(str(name))
    if not m:
        parts = [p.strip() for p in str(name).split(" · ")]
        return parts[0], " · ".join(parts[1:]) or "", ""
    return m.group("artist"), m.group("title"), m.group("quarter")


def load_events() -> pd.DataFrame:
    ev = pd.read_csv(EVENTS, usecols=lambda c: c in EVENT_COLS, low_memory=False)
    ev = ev[ev[REL].notna() & (ev[REL].astype(str).str.strip() != "")].copy()
    ev["ts"] = pd.to_datetime(ev["event_timestamp"], utc=True, errors="coerce")
    ev = ev[ev["ts"].notna()]
    ev["date"] = ev["ts"].dt.strftime("%Y-%m-%d")
    ev["hour"] = ev["ts"].dt.floor("h").dt.strftime("%Y-%m-%dT%H:00:00Z")
    ev["channel"] = channel(ev[CH])
    ev["signup"] = ev["event_name"] == "signup"
    ev["purchase"] = ev["event_name"] == "purchase"
    ev["converted"] = ev["signup"] & flag(ev["converted_signup"])
    ev["release_sub"] = ev["signup"] & (ev["aa_subscription_type"].astype(str).str.strip().str.lower() == "release")
    # a product subscription (a work's own notify-me) against a release one: the
    # two convert at different rates, so the forecast reads them apart (docs §4b)
    ev["product_sub"] = ev["signup"] & (ev["aa_subscription_type"].astype(str).str.strip().str.lower() == "product")
    ev["cancelled"] = ev["purchase"] & flag(ev["cancelled_order"])
    ev["pieces"] = pd.to_numeric(ev["order_pieces"], errors="coerce").fillna(0.0)
    ev["private"] = ev["purchase"] & flag(ev["pr_order"])
    ev["with_signup"] = ev["purchase"] & flag(ev["purchase_with_signup"])
    ev["launch_ts"] = pd.to_datetime(ev["launch_date"], utc=True, errors="coerce")
    return ev


def metric_frame(ev: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    """The event metrics summed over `keys`."""
    live = ev["purchase"] & ~ev["cancelled"]
    f = pd.DataFrame({
        **{k: ev[k] for k in keys},
        "signups": ev["signup"].astype(int),
        "signups_converted": ev["converted"].astype(int),
        "signups_release": ev["release_sub"].astype(int),
        "signups_with_order": ev["with_signup"].astype(int),
        "signups_product": ev["product_sub"].astype(int),
        "signups_product_converted": (ev["product_sub"] & ev["converted"]).astype(int),
        "orders": live.astype(int),
        "units": ev["pieces"].where(live, 0.0),
        # the pieces on orders placed by someone who had signed up: the signup-led
        # half of a window's units, the rest being buyers who never signed up
        "units_with_signup": ev["pieces"].where(live & ev["with_signup"], 0.0),
        "units_private": ev["pieces"].where(live & ev["private"], 0.0),
        "orders_cancelled": ev["cancelled"].astype(int),
        "units_cancelled": ev["pieces"].where(ev["cancelled"], 0.0),
    })
    return f.groupby(keys, as_index=False).sum()


def load_browsing() -> pd.DataFrame:
    br = pd.read_csv(BROWSING, low_memory=False, usecols=[CH, "event_date", REL, "event_hour", "Sessions_Total", "Page_Views_Total"])
    br = br[br[REL].notna() & (br[REL].astype(str).str.strip() != "")].copy()
    br["date"] = pd.to_datetime(br["event_date"], format="%d/%m/%Y", errors="coerce").dt.strftime("%Y-%m-%d")
    br = br[br["date"].notna()]
    br["channel"] = channel(br[CH])
    br["hour"] = br["event_hour"].where(br["event_hour"].notna() & (br["event_hour"].astype(str) != ""), None)
    br = br.rename(columns={"Sessions_Total": "sessions", "Page_Views_Total": "page_views"})
    br["sessions"] = pd.to_numeric(br["sessions"], errors="coerce").fillna(0).astype(int)
    br["page_views"] = pd.to_numeric(br["page_views"], errors="coerce").fillna(0).astype(int)
    return br[[REL, "date", "hour", "channel", "sessions", "page_views"]].rename(columns={REL: "release"})


def daily(ev: pd.DataFrame, br: pd.DataFrame) -> pd.DataFrame:
    e = metric_frame(ev.rename(columns={REL: "release"}), ["release", "date", "channel"])
    b = br.groupby(["release", "date", "channel"], as_index=False)[["sessions", "page_views"]].sum()
    out = b.merge(e, on=["release", "date", "channel"], how="outer")
    for c in METRICS:
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0)
    return out.sort_values(["release", "date", "channel"]).reset_index(drop=True)


def hourly(ev: pd.DataFrame, br: pd.DataFrame) -> pd.DataFrame:
    """Inside the band the browsing feed keeps the hour for (two days before
    the feed's launch to nine after), events and sessions by hour."""
    band = ev[ev["launch_ts"].notna()]
    band = band[(band["ts"] >= band["launch_ts"] - pd.Timedelta(days=2)) & (band["ts"] < band["launch_ts"] + pd.Timedelta(days=9))]
    e = metric_frame(band.rename(columns={REL: "release"}), ["release", "hour", "channel"])
    b = br[br["hour"].notna()].groupby(["release", "hour", "channel"], as_index=False)[["sessions", "page_views"]].sum()
    out = b.merge(e, on=["release", "hour", "channel"], how="outer")
    for c in METRICS:
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0)
    return out.sort_values(["release", "hour", "channel"]).reset_index(drop=True)


def releases(ev: pd.DataFrame, br: pd.DataFrame) -> pd.DataFrame:
    rows = []
    seen = br.groupby("release").agg(first_seen=("date", "min"), last_seen=("date", "max"), sessions=("sessions", "sum"))
    for name, g in ev.groupby(REL):
        artist, title, quarter = split_name(name)
        s = g[g["signup"]]
        p = g[g["purchase"] & ~g["cancelled"]]
        launch = g["launch_ts"].dropna()
        launch_ts = launch.mode().iloc[0] if len(launch) else pd.NaT
        ann = g["announcement_date"].dropna().astype(str)
        ann = ann[ann != ""]
        pre = s[s["ts"] < launch_ts] if pd.notna(launch_ts) else s
        ids = s["aa_account_id"].dropna().astype(str)
        ids = ids[ids != ""]
        pre_ids = pre["aa_account_id"].dropna().astype(str)
        buyers = p[p["aa_account_id"].notna() & (p["aa_account_id"].astype(str) != "")]
        per_buyer = buyers.groupby("aa_account_id")["pieces"].sum() if len(buyers) else pd.Series(dtype=float)
        se = seen.loc[name] if name in seen.index else None
        dates = pd.concat([g["date"], br.loc[br["release"] == name, "date"]]) if name in seen.index else g["date"]
        rows.append({
            "release": name, "artist": artist, "title": title, "quarter": quarter,
            "feed_launch": launch_ts.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(launch_ts) else "",
            "feed_announce": ann.mode().iloc[0][:10] if len(ann) else "",
            "first_seen": dates.min(), "last_seen": dates.max(),
            "sessions": int(se["sessions"]) if se is not None else 0,
            "signups": int(len(s)), "signups_unique": int(ids.nunique()),
            "signups_pre": int(len(pre)), "signups_unique_pre": int(pre_ids[pre_ids != ""].nunique()),
            "signups_converted": int(s["converted"].sum()),
            "orders": int(len(p)), "units": float(p["pieces"].sum()), "units_private": float(p.loc[p["private"], "pieces"].sum()),
            "orders_with_signup": int(p["with_signup"].sum()),
            "buyers_unique": int(per_buyer.index.nunique()), "buyers_multiple": int((per_buyer > 1).sum()),
            "orders_cancelled": int((g["purchase"] & g["cancelled"]).sum()),
            "units_cancelled": float(g.loc[g["purchase"] & g["cancelled"], "pieces"].sum()),
            "newest_event": g["ts"].max().strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
    # a release the browsing feed knows and the events feed does not (no signup yet): listed with its sessions
    named = {r["release"] for r in rows}
    for name, se in seen.iterrows():
        if name in named:
            continue
        artist, title, quarter = split_name(name)
        rows.append({"release": name, "artist": artist, "title": title, "quarter": quarter, "feed_launch": "", "feed_announce": "",
                     "first_seen": se["first_seen"], "last_seen": se["last_seen"], "sessions": int(se["sessions"]),
                     "signups": 0, "signups_unique": 0, "signups_pre": 0, "signups_unique_pre": 0, "signups_converted": 0,
                     "orders": 0, "units": 0.0, "units_private": 0.0, "orders_with_signup": 0, "buyers_unique": 0, "buyers_multiple": 0,
                     "orders_cancelled": 0, "units_cancelled": 0.0, "newest_event": ""})
    return pd.DataFrame(rows).sort_values(["feed_launch", "release"]).reset_index(drop=True)


def write(frame: pd.DataFrame, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    frame.to_csv(tmp, index=False)
    tmp.replace(path)


def main() -> int:
    missing = [p.name for p in (EVENTS, BROWSING) if not p.exists()]
    if missing:
        print(f"aggregate_tl: nothing to do - missing {', '.join(missing)} (run node server/bigquery.js --write --tl)")
        return 0
    ev = load_events()
    br = load_browsing()
    d = daily(ev, br)
    h = hourly(ev, br)
    r = releases(ev, br)
    # the account id's work is done: nothing below carries it
    del ev
    write(d, DAILY)
    write(h, HOURLY)
    write(r, RELEASES)
    newest = r["newest_event"].replace("", pd.NA).dropna().max() if len(r) else None
    feed = {"written": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "dataTo": newest, "lastDay": str(max(d["date"].max(), br["date"].max())) if len(d) else None,
            "releases": int(len(r)), "dailyRows": int(len(d)), "hourlyRows": int(len(h))}
    FEED.parent.mkdir(parents=True, exist_ok=True)
    tmp = FEED.with_suffix(".tmp"); tmp.write_text(json.dumps(feed, indent=1)); tmp.replace(FEED)
    print(f"aggregate_tl: {len(r)} releases, {len(d)} channel-day rows -> {DAILY.name}, {len(h)} channel-hour rows -> {HOURLY.name}, "
          f"data to {newest} -> {RELEASES.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
