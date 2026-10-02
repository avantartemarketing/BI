#!/usr/bin/env python3
"""Build the per-release dashboard snapshots (data/app/…) from the source feeds.

Implements docs/DATA_MODEL.md exactly:
  §3 LE target model (unit splits -> channel targets -> entries -> sessions -> budget)
  §5 across-time target curves (pooled pdsa trajectories from the daily funnel export)
  §6 actuals (fan-out-safe aggregation, untracked redistribution, projected sell-through)
  §7 paid in-flight model (adjusted CPE, party ROI, budget-to-sell-out, recommendation + cap)
  §8 email/social funnel rungs
  §9 module map (hero, trajectory, channels, funnel contributions, waterfall)

and docs/BENCHMARK_SPEC.md §4-§5: every targeted release is benchmarked
against a basket of comparable launches - the saved one, or the one its own
shape puts it in - and the target is the basket's medians lifted by one even
uplift K. The snapshot carries the benchmark alongside the target so every
card can draw both. The quartile-lever model that stood in when a release had
no basket was retired on 2026-09-23 (docs/DATA_MODEL.md §3); a release that
cannot be benchmarked shows its actuals.

Inputs:
  sources/across_time.csv           daily funnel export (channel x day x release + campaign clock)
  data/spend_daily.csv              Meta spend by campaign x day (etl/extract_spend.py)
  data/content_posts.csv            Emplifi posts by campaign (etl/extract_content.py)
  data/notion_posts.csv             posts by release, date and channel (server/notion.js)
  sources/all_sent_emails.csv       email sends - written by the HubSpot pull (server/hubspot.js); the checked-in file is its last pull
  data/orders_by_product.csv       per release x Shopify product: units paid, awaiting payment (draft orders),
                                   list price - aggregates from Order_Line_Concept (server/bigquery.js)
  data/draw_products.csv           the product each draw's winners bought, or its entrants hold
                                   pre-authorisation drafts for until it has winners (server/bigquery.js)
  sources/draw_*.csv                draw entry exports (PII is stripped here; never committed)
  etl/release_inputs.json           hand-entered launch inputs per release
  etl/benchmarks.json               frozen benchmark values (docs §4)
  data/release_clusters.csv         the draw panel the baskets are cut from (etl/baskets.py)

Outputs:
  data/app/index.json               sidebar index (all releases + status)
  data/app/curves.json              pooled trajectory curves
  data/app/releases/<id>.json       one snapshot document per release (what the UI reads)
"""
from __future__ import annotations

import csv
import json
import math
import collections
import os
import time
import pathlib
import re
import types
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None

import numpy as np
import pandas as pd

# The basket half of the benchmark (BENCHMARK_SPEC §3): which past launches a
# release is measured against and what their medians are. It is imported rather
# than reimplemented because the picker API answers from the same module, and a
# second copy of the medians here would be a benchmark that moves when nobody
# changed anything. build.py is only ever run as a script (server/sheets.js
# execs it), so etl/ is on the path.
import baskets
import pricing
import tl   # timed launches: the release model, the panel and the pages (docs/TL_SPEC.md)
# The per-product sell-through rule (docs §6.3): the entries in hand allocated
# across the products the way the allocator would place them. The same rule
# lives in shared/sellThrough.mjs for the server and the web app, and
# tests/test_sellthrough.py holds the two to the unit.
from sellthrough import attach_orders, products_from_draws, sell_through_products

ROOT = pathlib.Path(__file__).resolve().parent.parent
# the pulled feeds live in the repo's sources/ (gitignored) unless SOURCES_PATH
# puts them on a disk that survives a deploy (README, "Keeping state across
# deploys"); a file that is also checked in (the HubSpot sends) is read from
# the repo when the disk has no copy yet
REPO_SOURCES = ROOT / "sources"
SOURCES = pathlib.Path(os.environ.get("SOURCES_PATH") or REPO_SOURCES)
DATA = ROOT / "data"
# The build's output: the pages, the index, the inputs document, the caches.
# APP_DATA_PATH relocates it (a persistent disk on Render, README "Render's
# disk resets"), so the pages of the last run serve straight after a deploy;
# the repo's data/app is the seed the server copies in when the disk is empty.
APP = pathlib.Path(os.environ.get("APP_DATA_PATH") or (DATA / "app"))


def source_file(name: str) -> pathlib.Path:
    """A feed file by name: the SOURCES copy, else the checked-in one."""
    p = SOURCES / name
    return p if p.exists() or SOURCES == REPO_SOURCES else REPO_SOURCES / name
# actuals-only pages for every release the funnel data mentions but nobody has
# set targets for. Regenerated on every refresh and not committed (the
# targeted ones under APP/releases are - they are the boot-time fallback).
DERIVED = APP / "derived"
PR_LEAD_DAYS = 14        # default private-room lead before announce for a derived release
PAID_START_DAYS = 1      # paid starts the day after the announce: its plan and daily rate run from there to the close (docs 7)
UPCOMING_DAYS = 120      # an Airtable launch this far ahead is listed before the funnel sees it (§1.7)
UPCOMING_UNTYPED_DAYS = 60   # ... but one Airtable has not typed as a draw only this far ahead
UPCOMING_TYPES = {"Draw", ""}   # the LE draw path; blank is a project Airtable has not typed yet
UPCOMING_NOT_DRAW = {"OG", "NFT", "TL", "TLC"}   # originals, NFTs, timed editions: an untyped launch mostly of these is no draw
ADOPT_ACTIVITY_SHARE = 0.5   # a funnel release adopted by name has at least this share of its entries and units in the page's window (§1.7)
ADOPT_MOVED_SHARE = 0.1      # ... and a page whose own name still has rows adopts it only when those hold under this share of the twin's
ASSUMED_CAMPAIGN_DAYS = 24      # announce to close, when Airtable has no announce date yet
CATALOGUE_DAYS = 90      # window shown for a release with no campaign clock

BENCH = json.loads((ROOT / "etl" / "benchmarks.json").read_text())
INPUTS = json.loads((ROOT / "etl" / "release_inputs.json").read_text())

# Target inputs saved from the dashboard's Target setting tab live in their
# own file (the server writes it; SAVED_INPUTS_PATH relocates it, e.g. onto a
# persistent disk so saves survive a deploy). When the live refresh reruns
# this ETL in-process, those edits win over the repo defaults.
#
# They live apart from data/app/inputs.json on purpose: that file is this
# build's own output, and reading it back as an edit meant a repo default
# could never change once a release had been built (a paid-share overwrite
# added for Warhol was silently ignored that way).
_saved_inputs = pathlib.Path(os.environ.get("SAVED_INPUTS_PATH") or (DATA / "inputs.saved.json"))
if _saved_inputs.exists():
    try:
        _saved = {k: v for k, v in json.loads(_saved_inputs.read_text()).get("releases", {}).items()
                  if isinstance(v, dict)}
        INPUTS["releases"] = [_saved.get(r["id"], r) for r in INPUTS["releases"]]
        # releases set up from the dashboard (not in the repo defaults) - without
        # this they would vanish on the next rebuild
        _known = {r["id"] for r in INPUTS["releases"]}
        INPUTS["releases"] += [v for k, v in _saved.items() if k not in _known]
    except (ValueError, KeyError) as e:
        print(f"warning: ignoring saved inputs overlay: {e}")

# the twelve organic channels of the funnel export (docs §1.3), in the order
# the target table prints them
ORGANIC_CHANNELS = [
    "AA Email Auto", "AA Email Man", "AA Meta", "AA Other", "AA X", "Direct",
    "Organic Search", "Other", "Referral Artist", "Referral Meta", "Referral Other", "Referral X",
]
INPUTS_CODES = [r["campaign_code"] for r in INPUTS["releases"] if r.get("campaign_code")]

# Display grouping (docs §1.3). AA Other goes to search/direct/other (the sheet dropped it).
DISPLAY_GROUPS = {
    "aa_email": {"name": "AA Email", "channels": ["AA Email Auto", "AA Email Man"]},
    "aa_social": {"name": "AA Meta", "channels": ["AA Meta", "AA X"]},
    "referral_artist": {"name": "Artist", "channels": ["Referral Artist"]},
    "search_direct_other": {
        "name": "Direct etc.",
        "channels": ["Direct", "Organic Search", "Other", "AA Other",
                     "Referral Meta", "Referral Other", "Referral X"],
    },
    "paid": {"name": "Paid", "channels": ["Paid Social", "Paid Search"]},
}
GROUP_OF = {c: g for g, spec in DISPLAY_GROUPS.items() for c in spec["channels"]}

CURVE_GRID = [round(-0.6 + 0.05 * i, 2) for i in range(int((1.15 + 0.6) / 0.05) + 1)]


# ---------------------------------------------------------------- loading

# The daily funnel export has 34 columns; the build reads these 13 by name.
# Loading only them, with the three labels as categories for the parse and the
# fan-out groupby, keeps a multi-year BigQuery pull inside the 512 MB Render
# instance: the full frame costs ~0.6 MB per 1k rows, this ~0.15. A column has
# to be added here before it can be used below - a typo in a name fails loudly.
FUNNEL_LABELS = ["AA_session_custom_channel_group_split_touch", "simple_release_name", "campaign_stage"]
FUNNEL_COLS = FUNNEL_LABELS + [
    "event_date", "Sessions_Total", "Total_Product_Units", "Product_Units_Private_Room",
    "Draw_Entries_Total_Units_No_Conv", "Draw_Entries_Eligible_Units",
    "days_since_announcement", "days_until_launch",
    "pct_days_since_announcement", "pct_days_until_launch",
]


# The build reads the export rebuilt from the event-level feeds by
# etl/aggregate_events.py (same columns, same grain; docs/DATA_MODEL.md #2.3).
# FUNNEL_SOURCE=export reads the upstream export itself instead. A rebuilt
# file that is missing, or older than the export by more than a day (the
# aggregation has been failing), is not used: the build falls back to the
# export and says so, rather than serving a frozen copy while the export
# keeps moving.
def funnel_file() -> pathlib.Path:
    export = source_file("across_time.csv")
    if os.environ.get("FUNNEL_SOURCE") == "export":
        return export
    rebuilt = source_file("across_time.rebuilt.csv")
    if not rebuilt.exists():
        print("funnel: across_time.rebuilt.csv is missing (run etl/aggregate_events.py) - reading the export")
        return export
    if export.exists() and rebuilt.stat().st_mtime < export.stat().st_mtime - 86400:
        print("funnel: across_time.rebuilt.csv is more than a day older than the export - reading the export")
        return export
    return rebuilt


FUNNEL_FILE = funnel_file()


def load_across_time() -> pd.DataFrame:
    """The funnel frame, parsed once per export. The parse and the fan-out
    groupby are the single-release build's largest fixed cost, so the frame
    is kept beside the app data keyed on the export's size and mtime, and a
    build that finds the same export reads it back instead of parsing."""
    cache, meta = APP / "funnel.cache.pkl", APP / "funnel.cache.json"
    key = None
    try:
        st = FUNNEL_FILE.stat()
        key = {"path": str(FUNNEL_FILE), "mtime_ns": st.st_mtime_ns, "size": st.st_size, "cols": FUNNEL_COLS, "v": 1}
        if cache.exists() and meta.exists() and json.loads(meta.read_text()) == key:
            df = pd.read_pickle(cache)
            print(f"funnel: {len(df)} rows from the cached parse of {FUNNEL_FILE.name}")
            return df
    except (OSError, ValueError):
        key = None
    df = _parse_across_time()
    if key is not None:
        try:
            APP.mkdir(parents=True, exist_ok=True)
            df.to_pickle(cache)
            meta.write_text(json.dumps(key))
        except OSError:
            pass
    return df


def _parse_across_time() -> pd.DataFrame:
    df = pd.read_csv(FUNNEL_FILE, usecols=lambda c: c in FUNNEL_COLS,
                     dtype={c: "category" for c in FUNNEL_LABELS})
    missing = [c for c in FUNNEL_COLS if c not in df.columns]
    if missing:
        raise SystemExit(f"across_time.csv is missing columns the build needs: {missing}")
    df = df.rename(columns={"AA_session_custom_channel_group_split_touch": "channel"})
    df["event_date"] = pd.to_datetime(df["event_date"], format="%d/%m/%Y").dt.date
    # normalise channel case (feed says 'untracked'); the label is categorical
    # here, so the target value must exist as a category before assignment
    if "Untracked" not in df["channel"].cat.categories:
        df["channel"] = df["channel"].cat.add_categories(["Untracked"])
    df.loc[df["channel"].str.lower() == "untracked", "channel"] = "Untracked"
    df = df[df["simple_release_name"].notna()]
    keys = ["channel", "event_date", "simple_release_name"]
    clock = ["days_since_announcement", "days_until_launch",
             "pct_days_since_announcement", "pct_days_until_launch"]
    metric_cols = [c for c in df.select_dtypes(include="number").columns
                   if c not in clock and c not in keys]
    # fan-out pairs (two campaign-date sub-records) -> SUM the metrics and keep
    # the clock of the busier sub-record (docs §6.1). "First" used to mean first
    # in the file, which depends on the order the pull wrote the rows and so
    # differed between the export and the rebuilt file; the busier record is
    # the same choice whichever file the rows came from.
    df = df.sort_values(["channel", "event_date", "simple_release_name", "Sessions_Total", "pct_days_since_announcement"],
                        ascending=[True, True, True, False, True], kind="stable")
    agg = {c: "sum" for c in metric_cols}
    for c in ["campaign_stage"] + clock:
        agg[c] = "first"
    df = (df.groupby(["channel", "event_date", "simple_release_name"], as_index=False, observed=True, sort=False)
            .agg(agg))
    # back to plain labels: the rest of the build compares, maps and assigns
    # them freely, and categorical semantics (unobserved groups, new-value
    # assignment) are a trap there. The parse-and-groupby peak is what mattered.
    for c in ["channel", "simple_release_name", "campaign_stage"]:
        df[c] = df[c].astype(object)
    return df


# Meta bills the ad account in euros and the page runs in euros
# (pricing.PAGE_CURRENCY), so the spend passes through as it is. The
# conversion stays for a feed in another currency: it would be converted
# once, here, at the fixed table the product prices use (pricing.RATES_TO_EUR),
# and the paid block says which currency the spend came in.
SPEND_CURRENCY = "EUR"


def spend_rate() -> float:
    return float(pricing.RATES_TO_EUR.get(SPEND_CURRENCY, 1.0))


def convert_spend(df: pd.DataFrame) -> pd.DataFrame:
    """The spend column in the page's currency."""
    rate = spend_rate()
    if rate != 1.0 and "spend" in df.columns:
        df = df.copy()
        df["spend"] = df["spend"].astype(float) * rate
    return df


def load_spend() -> pd.DataFrame:
    df = pd.read_csv(DATA / "spend_daily.csv")
    df["spend_date"] = pd.to_datetime(df["spend_date"]).dt.date
    return convert_spend(df)


def load_emails() -> pd.DataFrame:
    # the HubSpot pull writes this file on every refresh; run without it if absent
    if not source_file("all_sent_emails.csv").exists():
        print("warning: sources/all_sent_emails.csv missing - email panels will be empty")
        return pd.DataFrame({
            "name": pd.Series(dtype=str), "sent_at": pd.Series(dtype="datetime64[ns]"),
            "campaign": pd.Series(dtype=str), "delivered": pd.Series(dtype=float),
            "opened": pd.Series(dtype=float), "clicked": pd.Series(dtype=float),
            "unsubscribed": pd.Series(dtype=float), "email_type": pd.Series(dtype=str),
        })
    df = pd.read_csv(source_file("all_sent_emails.csv"))
    df = df.rename(columns={
        "Email Name": "name", "Send Date (Your time zone)": "sent_at",
        "Campaign": "campaign", "Delivered": "delivered", "Opened": "opened",
        "Clicked": "clicked", "Unsubscribed": "unsubscribed"})
    df["sent_at"] = pd.to_datetime(df["sent_at"])
    def email_type(n):
        for t in ("GEN", "CUS", "INS", "TRNS", "AUT", "FREQ", "TEST"):
            if f"_{t}_" in n or n.startswith(f"{t}_"):
                return t
        return "OTHER"
    df["email_type"] = df["name"].map(email_type)
    return df


def load_people() -> pd.DataFrame:
    """Distinct entrants and buyers per release (etl/aggregate_events.py).

    Counted once for the whole release from the event feed, so it is the only
    honest buyer count there is: the daily export counts a customer once per
    channel-day, which double-counts anyone who bought across two of them and,
    on the releases the channel feed does not fully reach, undercounts badly.
    """
    p = APP / "release_people.csv"
    if not p.exists():
        return pd.DataFrame({"release_name": pd.Series(dtype=str),
                             "buyers": pd.Series(dtype=float), "units": pd.Series(dtype=float)})
    df = pd.read_csv(p, usecols=lambda c: c in ("release_name", "buyers", "units",
                                                "products", "products_known", "draws"))
    df["release_name"] = df["release_name"].astype(str)
    if "products_known" in df.columns:
        df["products_known"] = df["products_known"].astype(str).str.lower().isin(("true", "1"))
    df["product_count"] = product_count_of(df)
    return df


def product_count_of(df: pd.DataFrame) -> pd.Series:
    """How many products a release offered, from the two signals there are.

    The multiset cap is authoritative but only recorded from 2025-08-28. The
    number of distinct draws reaches back to September 2023 and agrees with it
    exactly wherever both exist and the draw count is one or two - 38 cases out
    of 38 - because a release runs a draw per product. Above two it over-counts:
    re-runs and waves put one 3-product release on 24 draws, and it is right
    only half the time there, so 3+ draws are taken as "multi-product, count
    unknown" and left out rather than guessed at.

    Together they reach 115 of the 357 releases in the feed against 51 for the
    cap alone, and the fitted slope barely moves - 0.178 against 0.182 - which
    is the strongest evidence the curve is real and not an artefact of a small
    sample.

    No release type is excluded and none should be: how many pieces a buyer
    takes has nothing to do with whether the release was an LE or a TL, and
    both are in here. What decides membership is the MECHANIC, and only because
    both product-count signals live in draw-entry events. Of the 357 releases,
    155 ran a draw, 171 were public, 22 enquiry and 9 pre-order.

    A public launch cannot be counted at all, and one candidate is worth naming
    so nobody spends the afternoon on it twice: `order_products` is identical
    to `order_pieces` in all 26,948 purchase rows on file. It counts pieces, not
    distinct products, so the tidy monotonic relationship between its per-release
    maximum and units per buyer is circular - both sides are measuring how many
    pieces people bought.
    """
    known = df.get("products_known")
    recorded = pd.to_numeric(df.get("products"), errors="coerce")
    if known is not None:
        recorded = recorded.where(known.astype(bool))
    draws = pd.to_numeric(df.get("draws"), errors="coerce")
    return recorded.fillna(draws.where(draws.isin([1, 2])))


def email_feed_through(emails: pd.DataFrame):
    """The last send in the email file, whatever release it belongs to.

    A campaign that began after this date has no sends to find, and the card
    has to say so: "no sends have joined this release" reads as "we sent
    nothing", which is a marketing problem, while a feed that stops before the
    campaign starts is an ingestion problem. The two look identical on the page
    without this, which is how a HubSpot pull that quietly stopped writing went
    unnoticed for a month.
    """
    if emails is None or emails.empty:
        return None
    last = emails["sent_at"].max()
    return None if pd.isna(last) else last.date().isoformat()


def load_content() -> pd.DataFrame:
    df = pd.read_csv(DATA / "content_posts.csv")
    df["Date"] = pd.to_datetime(df["Date"])
    return df


def load_artist_posts() -> pd.DataFrame:
    """Posts by release, date and channel, from the Notion log.

    server/notion.js writes this during the live refresh; optional until a
    NOTION_TOKEN is configured. `channel` buckets the database's Channel column
    to brand (Avant Arte's own accounts), artist, partner or other. The file
    was artist_posts.csv without that column, so one of those is read as all
    artist - a box that has not refreshed since the rename keeps working off
    the file it already has.
    """
    empty = pd.DataFrame({"campaign_code": pd.Series(dtype=str),
                          "date": pd.Series(dtype="object"),
                          "channel": pd.Series(dtype=str),
                          "posts": pd.Series(dtype=float)})
    p = DATA / "notion_posts.csv"
    legacy = not p.exists()
    if legacy:
        p = DATA / "artist_posts.csv"
    if not p.exists():
        return empty
    df = pd.read_csv(p)
    if df.empty:
        return empty
    if "channel" not in df.columns:
        df["channel"] = "artist"
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def social_block(content: pd.DataFrame, ap: pd.DataFrame, code, start, end) -> dict:
    """AA Meta and artist post counts for one release's window.

    Two sources, and the live one wins. Notion is queried every refresh; the
    Emplifi export is a file somebody last regenerated by hand, so wherever the
    Notion log was being kept it is the better answer and wherever it was not
    the export is all there is. Deciding per release rather than globally keeps
    the campaigns that ran before the log existed on the numbers they have.

    Notion records a row per post and nothing else - no post/story split, no
    impressions or engagements. The rung sums posts and stories, so a Notion
    count goes to posts with stories at zero; impressions and engagements stay
    on the export, and nothing reads them today.

    The export stops wherever it was last regenerated, so a count from it
    says how far it reaches: `postsThrough` is the last day in the file,
    `postsEndsFirst` that it stops before this window starts (the count is
    unknown, not zero) and `postsPartial` that it stops inside the window
    (the count runs to postsThrough only). The Notion log is read live, so a
    count from it carries none of these.
    """
    ct = content.iloc[0:0]
    if code:
        ct = content[(content["campaign_code"] == code)
                     & (content["Date"].dt.date >= start)
                     & (content["Date"].dt.date <= end)]
    posts = ct[ct["Content type"].isin(["post", "collaboration", "reply", "shared"])] if len(ct) else ct
    out = {
        "posts": int(len(posts)),
        "stories": int((ct["Content type"] == "story").sum()) if len(ct) else 0,
        "impressions": int(pd.to_numeric(ct["Total impressions"], errors="coerce").fillna(0).sum()) if len(ct) else 0,
        "engagements": int(pd.to_numeric(ct["Engagements"], errors="coerce").fillna(0).sum()) if len(ct) else 0,
        "postsSource": "emplifi",
    }
    if notion_covers(ap, start, end):
        out["posts"] = posts_in(ap, code, "brand", start, end) if code else 0
        out["stories"] = 0
        out["postsSource"] = "notion"
    # how far the export reaches, so a window it stops short of reads as
    # unknown rather than as a real zero; any fault reading it leaves no date
    out["postsThrough"], out["postsEndsFirst"], out["postsPartial"] = None, False, False
    if out["postsSource"] == "emplifi":
        try:
            last = content["Date"].max() if len(content) and "Date" in content.columns else None
            if last is not None and not pd.isna(last):
                through = pd.Timestamp(last).date()
                s0, s1 = pd.Timestamp(start).date(), pd.Timestamp(end).date()
                out["postsThrough"] = through.isoformat()
                out["postsEndsFirst"] = bool(through < s0)
                out["postsPartial"] = bool(s0 <= through < s1)
        except (TypeError, ValueError, AttributeError):
            out["postsThrough"], out["postsEndsFirst"], out["postsPartial"] = None, False, False
    # the artist's own account, always the Notion log - there is no other source
    out["artistPosts"] = None if (ap is None or ap.empty) else (
        posts_in(ap, code, "artist", start, end) if code else 0)
    out["artistPostsTarget"] = None
    return out


def posts_in(ap: pd.DataFrame, code: str, channel: str, start, end) -> int:
    """Posts on one channel for one release between two dates, inclusive."""
    if ap is None or ap.empty:
        return 0
    m = ((ap["campaign_code"] == code) & (ap["channel"] == channel)
         & (ap["date"] >= start) & (ap["date"] <= end))
    return int(ap.loc[m, "posts"].sum())


def notion_covers(ap: pd.DataFrame, start, end) -> bool:
    """Was the Notion log being kept during this window?

    A release with no Notion rows is either one nobody posted for or one that
    ran before the team logged anything, and the two need opposite answers: the
    first is a real zero, the second has to fall back to the Emplifi export.
    Any row at all in the window, for any release and any channel, says the log
    was live - the same test the email feed makes with feedThrough.
    """
    if ap is None or ap.empty:
        return False
    return bool(((ap["date"] >= start) & (ap["date"] <= end)).any())


# clock columns are per-row facts, not volumes - never redistribute them
_CLOCK_COLS = {"days_since_announcement", "days_until_launch",
               "pct_days_since_announcement", "pct_days_until_launch"}


def redistribute_channel(df: pd.DataFrame, channel: str) -> pd.DataFrame:
    """Spread one channel pro-rata over the others, day by day (docs §1.3).

    Untracked carries real demand - up to a quarter of a release's units - and
    no display group claims it, so leaving it in place drops it from every
    channel rollup while the release-level sums still count it. That mismatch
    is what let hero.now print below sellthrough.sold, which is arithmetically
    impossible for secured units. Folding it in here, before anything reads the
    frame, keeps both paths on one basis. The same rule reads Direct as a
    source for the other channels when the dashboard's Direct switch is on:
    every metric of the channel lands on the others in proportion to what
    they did that day.

    Shares come from the same day's mix of the other channels. A day carrying
    the channel's volume with nothing else to spread it over would lose that
    volume, so it is pooled and shared out on the release's overall mix instead.
    """
    unt = df[df["channel"] == channel]
    tracked = df[df["channel"] != channel].copy()
    if unt.empty or tracked.empty:
        return tracked
    cols = [c for c in df.select_dtypes(include="number").columns if c not in _CLOCK_COLS]
    for m in cols:
        u_by_day = unt.groupby("event_date")[m].sum()
        if float(u_by_day.abs().sum()) == 0:
            continue
        t_by_day = tracked.groupby("event_date")[m].sum()
        vals = tracked[m].to_numpy(dtype=float)
        rows_u = tracked["event_date"].map(u_by_day).fillna(0.0).to_numpy(dtype=float)
        rows_t = tracked["event_date"].map(t_by_day).fillna(0.0).to_numpy(dtype=float)
        add = np.where(rows_t > 0, rows_u * vals / np.where(rows_t > 0, rows_t, 1.0), 0.0)
        orphan = float(u_by_day[t_by_day.reindex(u_by_day.index).fillna(0.0) <= 0].sum())
        rel_total = float(vals.sum())
        if orphan and rel_total > 0:
            add = add + orphan * vals / rel_total
        tracked[m] = vals + add
    return tracked


def redistribute_untracked(df: pd.DataFrame) -> pd.DataFrame:
    """The Untracked fold (docs §1.3): redistribute_channel on Untracked."""
    return redistribute_channel(df, "Untracked")


# ---- Direct as a source (docs §1.3): the dashboard's Direct switch ----------
DIRECT_METRICS = {"sessions": "Sessions_Total", "entries": "Draw_Entries_Eligible_Units", "units": "Total_Product_Units"}


def channel_share(frame: pd.DataFrame, channel: str, within_group: bool = False) -> dict:
    """A channel's share of each metric: of the whole frame, or of its own
    display group. {metric: share or None when there is nothing to share}."""
    if "channel" not in frame.columns:
        return {k: None for k in DIRECT_METRICS}
    sub = frame[frame["channel"] == channel]
    base = frame[frame["channel"].map(GROUP_OF) == GROUP_OF.get(channel)] if within_group else frame
    out = {}
    for key, col in DIRECT_METRICS.items():
        total = float(base[col].sum()) if col in base.columns else 0.0
        part = float(sub[col].sum()) if col in sub.columns else 0.0
        out[key] = round(part / total, 4) if total > 0 else None
    return out


def direct_share_norm(at: pd.DataFrame, panel: pd.DataFrame | None, as_of: date) -> dict | None:
    """What share of the Search/direct/other group Direct normally is: the
    median over the draw panel's launches closed in the last RECENT_MONTHS,
    each over its own window (the cohort untracked_norms reads). The Direct
    switch reads the benchmark's channel split with this much of the group
    spread over the other channels, the same rule the actuals get.

    The split it is applied to is the panel's, so the share is the panel's
    too wherever the panel carries it (direct_in_group_<metric>, written by
    etl/analysis/release_clusters.py from the same pull as the split): read
    off today's feed instead, a re-attribution upstream moves the share and
    not the split, and the Direct view mixes two attributions - on 24 Sep
    2026 Direct's share of the group's units fell from 0.73 to 0.33 in one
    refresh while the panel's split stayed on 10 Sep's. A panel written
    before the columns existed falls back to today's feed over the same
    windows. `source` says which was read: "panel" or "feed"."""
    if panel is None or not len(panel) or "window_end" not in panel.columns:
        return None
    ends = pd.to_datetime(panel["window_end"], errors="coerce")
    cutoff = pd.Timestamp(as_of) - pd.DateOffset(months=baskets.RECENT_MONTHS)
    recent = panel[ends >= cutoff]
    use_recent = len(recent) >= UNTRACKED_NORM_MIN
    pool = recent if use_recent else panel
    cols = {k: f"direct_in_group_{k}" for k in DIRECT_METRICS}
    if all(c in pool.columns for c in cols.values()) and pool[list(cols.values())].notna().any().all():
        out: dict = {"recentMonths": baskets.RECENT_MONTHS if use_recent else None, "source": "panel"}
        ns = []
        for k, c in cols.items():
            ser = pd.to_numeric(pool[c], errors="coerce").dropna()
            out[k] = round(float(ser.median()), 4) if len(ser) else None
            ns.append(len(ser))
        out["n"] = max(ns)
        return out
    shares: dict[str, list[float]] = {k: [] for k in DIRECT_METRICS}
    for r in pool.to_dict("records"):
        ws = pd.to_datetime(r.get("window_start"), errors="coerce")
        we = pd.to_datetime(r.get("window_end"), errors="coerce")
        if pd.isna(ws) or pd.isna(we):
            continue
        sub = at[(at["simple_release_name"] == r["release_name"])
                 & (at["event_date"] >= ws.date()) & (at["event_date"] <= we.date())]
        if sub.empty:
            continue
        for k, v in channel_share(sub, "Direct", within_group=True).items():
            if v is not None:
                shares[k].append(v)
    out: dict = {"recentMonths": baskets.RECENT_MONTHS if use_recent else None, "source": "feed"}
    for k, xs in shares.items():
        ser = pd.Series(xs, dtype=float)
        out[k] = round(float(ser.median()), 4) if len(ser) else None
    out["n"] = max(len(xs) for xs in shares.values()) if shares else 0
    return out


def spread_profile(profile: dict, norm: dict | None) -> dict:
    """The basket's medians read with Direct spread: Direct's share of the
    Search/direct/other group (the panel's median, direct_share_norm) leaves
    the group and lands on every group in proportion to what remains, units
    and sessions alike. The headline medians do not move, so K does not
    either; conversion stays at the benchmark like every other rate.

    Nor does the money. Paid takes its share of Direct's units, so the same
    spend buys more of them: the cost of a paid unit is rescaled by the paid
    group's change (`cost_scale`, channel units over spread units), and paid
    units x cost x K - the paid budget, and the benchmark's - is the Channel
    view's to the cent. The basket's own figure is rescaled here; a figure the
    release typed, or the panel constant, takes the same scale where it is
    picked (cost_per_purchase_for). A display switch never moves a budget."""
    if not norm:
        return profile
    out = dict(profile)
    paid_before = float((profile.get("units_by_group") or {}).get("paid") or 0.0)
    for key, metric in (("units_by_group", "units"), ("sessions_by_group", "sessions")):
        share = norm.get(metric)
        grp = {g: float(v or 0.0) for g, v in (out.get(key) or {}).items()}
        if share is None or not grp:
            continue
        d = grp.get("search_direct_other", 0.0) * float(share)
        if d <= 0:
            continue
        grp["search_direct_other"] -= d
        tot = sum(grp.values())
        if tot > 0:
            grp = {g: v + d * v / tot for g, v in grp.items()}
        else:
            grp["search_direct_other"] += d
        out[key] = {g: round(v, 6) for g, v in grp.items()}
        total = float(out.get(metric) or 0.0)
        if total > 0:
            out["share_units" if metric == "units" else "share_sessions"] = {g: round(v / total, 6) for g, v in out[key].items()}
    paid_after = float((out.get("units_by_group") or {}).get("paid") or 0.0)
    if paid_before > 0 and paid_after > 0:
        out["cost_scale"] = paid_before / paid_after
        cpp = float(profile.get("cost_per_purchase") or 0.0)
        if cpp > 0:
            out["cost_per_purchase"] = cpp * out["cost_scale"]
    out["direct_spread"] = norm
    return out


def with_direct_spread(build, *args, **kwargs) -> dict:
    """A page built both ways: as the funnel attributes it, and with Direct
    spread over the other channels (docs §1.3). The blocks that differ ride
    under `variants.direct_spread`, and the dashboard's Direct switch lays
    them over the page without another build."""
    snap = build(*args, **kwargs)
    alt = build(*args, **kwargs, direct_spread=True)
    snap["variants"] = {"direct_spread": {k: v for k, v in alt.items() if k != "variants" and v != snap.get(k)}}
    return snap


# ---- untracked share (docs §1.3): how much of a release has no channel -----
UNTRACKED_METRICS = {"entries": "Draw_Entries_Eligible_Units", "units": "Total_Product_Units"}
UNTRACKED_MIN_COUNT = 5        # below this a high share is a handful of rows, not a tracking fault
UNTRACKED_HIGH_MULTIPLE = 2.0  # "much higher than normal": over twice the median, and past the 90th percentile
UNTRACKED_NORM_MIN = 8         # fewer recent launches than this and the norm reads the whole panel


def untracked_shares(frame: pd.DataFrame) -> dict:
    """Each metric's untracked share of a frame that still carries the
    Untracked channel: {metric: {share, count, total}}. Sessions always carry
    a channel in the feed, so only entries and units are read."""
    unt = frame[frame["channel"] == "Untracked"] if "channel" in frame.columns else frame.iloc[0:0]
    out = {}
    for key, col in UNTRACKED_METRICS.items():
        total = float(frame[col].sum()) if col in frame.columns else 0.0
        count = float(unt[col].sum()) if col in unt.columns else 0.0
        out[key] = {"share": (count / total) if total > 0 else None, "count": count, "total": total}
    return out


def untracked_norms(at: pd.DataFrame, panel: pd.DataFrame | None, as_of: date) -> dict | None:
    """What an untracked share normally is: the median and 90th percentile
    over the draw panel's launches closed in the last RECENT_MONTHS, each
    read over its own window. Tracking has tightened - older launches ran
    ten to fifty per cent untracked, recent ones three - so the bar is set by
    recent launches, and by the whole panel only when fewer than
    UNTRACKED_NORM_MIN are that recent."""
    if panel is None or not len(panel) or "window_end" not in panel.columns:
        return None
    ends = pd.to_datetime(panel["window_end"], errors="coerce")
    cutoff = pd.Timestamp(as_of) - pd.DateOffset(months=baskets.RECENT_MONTHS)
    recent = panel[ends >= cutoff]
    use_recent = len(recent) >= UNTRACKED_NORM_MIN
    pool = recent if use_recent else panel
    shares: dict[str, list[float]] = {k: [] for k in UNTRACKED_METRICS}
    for r in pool.to_dict("records"):
        ws = pd.to_datetime(r.get("window_start"), errors="coerce")
        we = pd.to_datetime(r.get("window_end"), errors="coerce")
        if pd.isna(ws) or pd.isna(we):
            continue
        sub = at[(at["simple_release_name"] == r["release_name"])
                 & (at["event_date"] >= ws.date()) & (at["event_date"] <= we.date())]
        if sub.empty:
            continue
        for k, v in untracked_shares(sub).items():
            if v["share"] is not None:
                shares[k].append(v["share"])
    out: dict = {"recentMonths": baskets.RECENT_MONTHS if use_recent else None}
    for k, xs in shares.items():
        ser = pd.Series(xs, dtype=float)
        out[k] = {"median": round(float(ser.median()), 4) if len(ser) else None,
                  "p90": round(float(ser.quantile(0.9)), 4) if len(ser) else None, "n": int(len(ser))}
    return out


def untracked_block(win: pd.DataFrame, norms: dict | None) -> dict:
    """The snapshot's `untracked` block: this release's untracked share of
    entries and of units over its window, what is normal, and `high` - the
    metrics whose share is much higher than normal: over twice the median and
    past the 90th percentile, on at least UNTRACKED_MIN_COUNT rows so a
    handful cannot trip it. The Target setting tab warns on it: the
    redistribution above is a proportion, and the more it has to move, the
    less the channel picture can be trusted (docs §1.3)."""
    shares = untracked_shares(win)
    high = []
    for k, v in shares.items():
        n = (norms or {}).get(k) or {}
        med, p90 = n.get("median"), n.get("p90")
        if v["share"] is None or med is None or p90 is None or v["count"] < UNTRACKED_MIN_COUNT:
            continue
        if v["share"] > max(p90, UNTRACKED_HIGH_MULTIPLE * med):
            high.append(k)
    return {
        **{k: {"share": round(v["share"], 4) if v["share"] is not None else None,
               "count": round(v["count"], 1), "total": round(v["total"], 1)} for k, v in shares.items()},
        "normal": norms,
        "high": high,
    }

POSTING_TIERS = ("Low", "Medium", "High")


def referral_artist_tier(release: dict) -> str:
    """How much the artist is expected to post: the tier the artist-posts
    benchmark pools completed campaigns by. N/A for an artist with no channels
    of their own (§4.3), else the release's artist_posting_tier, Medium by
    default. Inputs saved before the tier had a field of its own carried it as
    the Referral Artist row of the retired channel-quality grid, so that
    spelling is still read."""
    if "referral_artist" in baskets.channels_off_of(release):
        return "N/A"
    tier = release.get("artist_posting_tier")
    if tier in POSTING_TIERS:
        return tier
    legacy = (release.get("channel_quality_overrides") or {}).get("Referral Artist")
    return legacy if legacy in POSTING_TIERS else "Medium"


def artist_posts_benchmarks(ap: pd.DataFrame, as_of: date) -> dict:
    """Referral-artist tier -> expected posts per campaign, the same quartile
    approach as the other channels: pool completed campaigns in the same
    Referral Artist tier and take the median post count (all-tier median while
    per-tier history is thin, None until >= 2 completed campaigns have data)."""
    if ap.empty:
        return {}
    by_tier, totals = defaultdict(list), []
    for r in INPUTS["releases"]:
        end = date.fromisoformat(r["launch_end"])
        if end >= as_of:
            continue
        tier = referral_artist_tier(r)
        if tier == "N/A":
            continue
        start = date.fromisoformat(r["private_room_open"])
        n = float(posts_in(ap, r["campaign_code"], "artist", start, end))
        by_tier[tier].append(n)
        totals.append(n)
    out = {}
    for tier, xs in by_tier.items():
        if len(xs) >= 2:
            out[tier] = float(pd.Series(xs).median())
    if len(totals) >= 2:
        out["_all"] = float(pd.Series(totals).median())
    return out


# ---------------------------------------------------------------- target model (docs §3)

def cost_per_purchase_for(release: dict, b: dict = BENCH, profile: dict | None = None) -> float:
    """What a paid unit costs to buy, the price the paid budget is set at:
    the release's own figure (cost_per_purchase on the Target setting tab),
    else the basket's median cost per paid unit (its launches' Meta spend
    over their paid units, baskets.attach_paid_costs; on the profile as
    cost_per_purchase, 0 when too few members have a reading), else the
    panel's constant. A release saved while the figure was still a quartile
    pick (cpp_pick, retired) is read at that quartile. On a profile read with
    Direct spread the release's figure and the constant take the profile's
    cost_scale, as the basket's figure already has (spread_profile), so the
    budget is the same whichever way Direct is read."""
    scale = float((profile or {}).get("cost_scale") or 1.0)
    own = release.get("cost_per_purchase")
    if own not in (None, "") and float(own) > 0:
        return float(own) * scale
    basket = float((profile or {}).get("cost_per_purchase") or 0)
    if basket > 0:
        return basket
    pick = release.get("cpp_pick")
    table = b["cost_per_purchase"]
    return float(table[pick] if pick in table else table["Median"]) * scale


def cost_per_purchase_source(release: dict, b: dict = BENCH, profile: dict | None = None) -> str:
    """Where cost_per_purchase_for's figure came from: release, basket or panel."""
    own = release.get("cost_per_purchase")
    if own not in (None, "") and float(own) > 0:
        return "release"
    return "basket" if float((profile or {}).get("cost_per_purchase") or 0) > 0 else "panel"


def _group_channel_split(group: str) -> dict[str, float]:
    """Each raw channel's share of its own display group, from the order_split
    medians (BENCHMARK_SPEC §4).

    The basket knows what a display group sells, not what the channels inside
    it sell - the panel is grouped, because that is the grain the funnel export
    is trustworthy at. The order_split medians are the only per-channel prior on
    file, and renormalising them inside the group leaves the group's own total
    exactly where the profile put it however the shares move.
    """
    chans = [c for c in DISPLAY_GROUPS[group]["channels"] if c in ORGANIC_CHANNELS]
    weights = {c: float(BENCH["order_split"].get(c, {}).get("Medium", 0.0)) for c in chans}
    total = sum(weights.values())
    if total <= 0:
        return {c: 1.0 / len(chans) for c in chans} if chans else {}
    return {c: w / total for c, w in weights.items()}


# ---- units per buyer (BENCHMARK_SPEC §4.2) ---------------------------------

# The draw records how many products it offered only from this date. Before it,
# every launch reads as a single product whatever it actually was: of the 62
# launches that closed earlier, 16 are named "Multiple" and not one of them
# registers more than one. So the rate curve is fitted on the launches after it
# and the earlier ones are left out rather than averaged in, which would drag
# the single-product rate up and flatten the lift the curve is trying to measure.
PRODUCTS_KNOWN_FROM = "2025-08-28"
UNITS_PER_BUYER_FALLBACK = 0.1838   # the fitted slope, for a panel too thin to fit


UPB_MIN_BUYERS = 10   # a rate over fewer buyers than this is noise, not a rate


def units_per_buyer_curve(people) -> float:
    """The slope of units per buyer against the log of the product count.

    Fitted over EVERY release whose product count is recorded, not just the
    draw panel: how many pieces a buyer takes when a release offers several is
    not a property of the draw mechanic, so restricting it to draw launches
    only threw away a fifth of the evidence for nothing.

    The base is as wide as it can be and it is still not wide. The draw only
    records how many products it offered from 2025-08-28, which is 54 of the
    357 releases in the feed. The count cannot be recovered for the rest: the
    obvious proxy, how many distinct products an order contained, is exact only
    three times in five against the counts we do know and correlates at 0.26,
    because it measures what a buyer took rather than what was on offer. The
    older launches still corroborate the direction - the ones the naming
    convention calls a Multiple run 1.08 units per buyer against 1.02 for the
    rest - but they cannot sharpen the slope without a count.

    One monotonic curve rather than a median per count: twelve launches at two
    products, six at three, three at four and one each at five and six means a
    per-count median moves under any one of them and says nothing about eight.
    1 + a x ln(products), least squares through the origin, so a single product
    is exactly one piece per buyer by definition rather than by fit.
    """
    if people is None or not len(people) or "products_known" not in people.columns:
        return UNITS_PER_BUYER_FALLBACK
    df = people[people["product_count"].notna() & (people["product_count"] >= 1)
                & people["buyers"].notna() & (people["buyers"] >= UPB_MIN_BUYERS)
                & people["units"].notna() & (people["units"] > 0)]
    if len(df) < 8:
        return UNITS_PER_BUYER_FALLBACK
    x = np.log(df["product_count"].to_numpy(dtype=float))
    y = (df["units"].to_numpy(dtype=float) / df["buyers"].to_numpy(dtype=float)) - 1.0
    denom = float((x * x).sum())
    if denom <= 0:
        return UNITS_PER_BUYER_FALLBACK
    return float((x * y).sum() / denom)


def units_per_buyer_for(release: dict, profile: dict | None, slope: float) -> tuple[float, str]:
    """The rate this release plans on, and where it came from.

    In order: what someone typed for this release, then the curve at its own
    product count, then the basket's own median, then one. The typed value is
    first because the curve is fitted on a handful of multi-product launches
    and the lead running the release knows things it does not.
    """
    typed = release.get("units_per_buyer")
    if typed not in (None, "") and float(typed) > 0:
        return float(typed), "typed"
    # the release's own product list, which the lead already curates for the
    # sell-through card, is a better count than anything derived from the feed
    n = release.get("product_count")
    if n in (None, ""):
        sized = [x for x in (release.get("economics_products") or []) if isinstance(x, dict) and x.get("edition")]
        if sized:
            n = len(sized)
        elif isinstance(release.get("products"), list):
            n = len(release["products"])
    if n not in (None, "") and float(n) >= 1:
        return max(1.0, 1.0 + slope * math.log(float(n))), "products"
    if profile and profile.get("units_per_buyer", 0) > 0:
        return float(profile["units_per_buyer"]), "basket"
    return 1.0, "default"


def stretch_weights(release: dict, profile: dict) -> dict[str, float]:
    """Where the stretch comes from (BENCHMARK_SPEC §4.4): the share of the gap
    between the target and the basket's median each group is asked for. The
    release's `stretch_from` when typed on the Target setting tab - a share
    per group, read over the groups in plan that have a benchmark to lift and
    renormalised - else the basket's own unit shares, which is the even
    uplift: every group lifted by the same K. A group set aside
    (channels_off, benchmark 0) takes none, and a share typed on one falls
    to the others."""
    bm = {g: float((profile.get("units_by_group") or {}).get(g) or 0.0) for g in baskets.GROUPS}
    total = sum(v for v in bm.values() if v > 0)
    even = {g: (bm[g] / total if total > 0 and bm[g] > 0 else 0.0) for g in baskets.GROUPS}
    raw = release.get("stretch_from")
    if not isinstance(raw, dict):
        return even
    w = {}
    for g in baskets.GROUPS:
        try:
            v = float(raw.get(g) or 0.0)
        except (TypeError, ValueError):
            v = 0.0
        w[g] = max(v, 0.0) if bm[g] > 0 else 0.0
    s = sum(w.values())
    return {g: w[g] / s for g in baskets.GROUPS} if s > 0 else even


def stretch_typed(release: dict, profile: dict) -> bool:
    """Whether the release placed its stretch (a share on a group that has a
    benchmark to lift), as against the even uplift the weights fall to."""
    raw = release.get("stretch_from")
    if not isinstance(raw, dict):
        return False
    bm = profile.get("units_by_group") or {}
    return any(float(bm.get(g) or 0.0) > 0 and float(raw.get(g) or 0.0) > 0 for g in baskets.GROUPS)


def allocate_stretch(bm_units: dict, size: float, weights: dict) -> dict[str, float]:
    """Each group's target units: its benchmark plus its share of the stretch,
    the edition less the basket's median, negative when the basket reached
    more than the edition. A cut a group cannot carry - more than its
    benchmark - stops at zero and the rest falls on the other groups by their
    shares, so the groups always sum to the edition."""
    units = {g: float(bm_units.get(g) or 0.0) for g in baskets.GROUPS}
    w = {g: max(float(weights.get(g) or 0.0), 0.0) for g in baskets.GROUPS}
    for _ in range(len(baskets.GROUPS) + 1):
        gap = size - sum(units.values())
        tot = sum(w.values())
        if abs(gap) < 1e-9 or tot <= 0:
            break
        out = {g: units[g] + gap * w[g] / tot for g in units}
        short = [g for g in out if out[g] < -1e-9]
        if not short:
            units = out
            break
        for g in short:
            units[g] = 0.0
            w[g] = 0.0
    return units


def benchmark_targets(release: dict, profile: dict, upb_slope: float = UNITS_PER_BUYER_FALLBACK) -> dict:
    """Targets from a basket's medians (BENCHMARK_SPEC §4).

    One even uplift K = edition / median units carries every volume - sessions,
    entries, units, spend - in every channel and on every day. Conversion rates
    are held at the benchmark: a target that quietly assumes the site converts
    better than it ever has is a target nobody can act on, so the uplift is
    asked of traffic and spend only. Where the stretch comes from is a choice
    (§4.4): by default each group takes its share of the gap to the edition
    in proportion to its benchmark, which is every group lifted by the same
    K; the Target setting tab can place it instead (most of it on paid, say),
    and then each group carries its own uplift, its sessions and entries with
    it, and the paid budget follows the paid units.

    Organic units are not split into a draw half and a private-room half any
    more: every organic unit goes through its group's channel split and is
    asked for as an entry at the eligible-entry rate, which is how the LE
    workbook has set its targets since September 2026. The private room is
    still measured (the panel's private_room_share, the orders feed's
    private-room units) - it is just not a target of its own.

    Everything downstream - group_targets, the channel loop, the paid model,
    the web's target rail - reads this dict by name (docs/DATA_MODEL.md §4a.3).
    """
    b = BENCH
    size = float(release["edition_size"])
    k = size / profile["units"]   # the stretch as one multiple: the even uplift
    e2o = entry_rate(release)     # the release's own entry -> order rate, else the panel's
    # where the stretch comes from (§4.4): each group's target is its benchmark
    # plus its share of the gap to the edition, its sessions at its own uplift
    weights = stretch_weights(release, profile)
    units = allocate_stretch(profile["units_by_group"], size, weights)
    kg = {g: (units[g] / profile["units_by_group"][g]) if profile["units_by_group"][g] > 0 else 0.0 for g in baskets.GROUPS}
    sessions = {g: profile["sessions_by_group"][g] * kg[g] for g in baskets.GROUPS}

    paid_units = units["paid"]
    organic_units = size - paid_units

    # How many people the edition needs, not how many pieces. On a multi-product
    # release the median buyer takes more than one, so a 1,200-unit target is
    # not 1,200 people: assuming it is overstates the audience the campaign has
    # to reach by the whole multi-buy rate. The rate is held at the benchmark
    # like every other rate, so the uplift is asked entirely of finding more
    # buyers, never of persuading each to take more (§4.2).
    upb, upb_source = units_per_buyer_for(release, profile, upb_slope)
    buyers = {g: units[g] / upb for g in baskets.GROUPS}

    per_channel = {}
    for g in DISPLAY_GROUPS:
        if g == "paid":
            continue
        conv = profile["conv"][g]
        for c, share in _group_channel_split(g).items():
            purchases = units[g] * share
            per_channel[c] = {
                # "benchmark" rather than a quartile: no lever was picked here
                "quality": "benchmark",
                # the channel's share of all organic units
                "order_split": (purchases / organic_units) if organic_units else share,
                "purchases": purchases,
                "eligible_entries": purchases / e2o,
                "sessions": sessions[g] * share,
                "session_to_entry": conv,
            }

    cpp = cost_per_purchase_for(release, b, profile)
    budget = paid_units * cpp        # the paid units, wherever the stretch was placed
    launch_value = size * release["unit_price"]
    organic_sessions = sum(pc["sessions"] for pc in per_channel.values())

    out = {
        "edition_size": release["edition_size"],
        "paid_pct": (paid_units / size) if size else 0.0, "paid_units": paid_units,
        "organic_units": organic_units,
        "per_channel": per_channel,
        "paid": {
            "units": paid_units, "eligible_entries": paid_units / e2o,
            "sessions": sessions["paid"], "session_to_entry": profile["conv"]["paid"],
            "cost_per_purchase": cpp, "cost_per_purchase_source": cost_per_purchase_source(release, b, profile), "budget": budget,
            "budget_pct_of_launch_value": budget / launch_value if launch_value else None,
            "sense_check_breached": (budget / launch_value) > b["budget_sense_check_max_pct_of_launch_value"] if launch_value else False,
        },
        "launch_value": launch_value,
        "units_per_buyer": upb, "units_per_buyer_source": upb_source,
        "buyers": size / upb, "buyers_by_group": buyers,
        "organic_sessions": organic_sessions,
        # the basket's own session total at the uplift: the email median is
        # measured on launches that ran a private room, so those sessions are
        # already inside it
        "total_sessions": organic_sessions + sessions["paid"],
        # entries carry the same uplift as the units they convert from (§4):
        # every unit of the edition is asked for as an entry that converts at
        # e2o, so the whole edition divided by that rate
        "entries_target": sum(pc["eligible_entries"] for pc in per_channel.values()) + paid_units / e2o,
        "entry_rate": e2o,
        "buffer": b["target_buffer"],
        # the uplift as one multiple, each group's own, and where the stretch
        # was placed (§4.4): the basket's shares unless the tab typed some
        "k": k, "k_by_group": kg, "stretch_from": weights,
        "stretch_typed": stretch_typed(release, profile),
        "stretch_units": size - profile["units"],
    }
    # the partition the whole page rests on: what the five groups are asked to
    # sell is the edition, no more and no less (§4)
    rolled = sum(g["units"] for g in group_targets(out).values())
    assert abs(rolled - size) <= 0.5, (
        f"benchmark group targets sum to {rolled:.2f}, edition size is {size:.0f}")
    return out


def frame_terms(release: dict, b: dict = BENCH) -> tuple[float, float | None]:
    """The framing uplift's two terms for one release or product: the share of
    buyers expected to take a frame, its own figure else the benchmark default
    (benchmarks.json frame_conversion), and AA's profit per frame, its own
    figure only. There is no default profit per frame: every framed product
    carries its own (Airtable's Framing profit per unit, or typed on the
    Target setting tab), so a product without one adds no uplift and the tab
    shows the cell empty rather than a constant (the workbook's €94, retired
    on 26 September 2026). The profit is None when there is none."""
    conv = release.get("frame_conversion")
    profit = release.get("frame_profit_per_unit")
    conv = float(b["frame_conversion"]) if conv is None or conv == "" else float(conv)
    profit = None if profit is None or profit == "" else max(float(profit), 0.0)
    return min(max(conv, 0.0), 1.0), profit


def cannibalisation_for(release: dict, b: dict = BENCH) -> float:
    """The share of paid entries that would have come anyway (docs 7): the
    release's own figure from the Target setting tab, else the LE standard
    in the benchmarks. The ROI and the budget floor read profit net of it."""
    v = release.get("cannibalisation")
    try:
        v = float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        v = None
    return min(max(v, 0.0), 0.95) if v is not None else float(b["cannibalisation"])


def aa_profit_per_unit(release: dict, b: dict = BENCH) -> float:
    """AA's profit per unit sold: the group profit spread over the edition,
    plus the framing uplift (take-up x profit per frame) when framing is
    offered. The figure every paid ROI on the page divides by (docs §7)."""
    if release.get("aa_ppu_resolved") is not None:
        # resolved per product (resolve_release): each product's profit and
        # framing uplift, weighted by its target units
        return float(release["aa_ppu_resolved"])
    size = float(release.get("edition_size") or 0)
    base = (float(release.get("aa_group_profit") or 0) / size) if size else 0.0
    if release.get("framing_available") is False:
        return base
    conv, profit = frame_terms(release, b)
    return base + conv * (profit or 0.0)


def compute_targets(release: dict, profile: dict | None, upb_slope: float = UNITS_PER_BUYER_FALLBACK) -> dict | None:
    """The release's targets from its basket (BENCHMARK_SPEC §4), or None when
    there is no basket to read: no draw panel on file, or a basket whose
    channels in plan sold nothing in the median launch, so there is no K to
    compute. The quartile-lever model that used to stand in here was retired
    on 2026-09-23 (docs/DATA_MODEL.md §3): a release without a benchmark shows
    its actuals, it is not given a target from a different model."""
    if profile and profile.get("units"):
        return benchmark_targets(release, profile, upb_slope)
    return None


def group_targets(targets: dict) -> dict:
    """Roll per-channel targets up to display groups.

    `units` is the secured-units target: organic purchases per channel, and
    paid units for the paid group. Group unit targets sum exactly to the
    edition size (sellout).
    """
    out = {}
    for g, spec in DISPLAY_GROUPS.items():
        if g == "paid":
            out[g] = {"entries": targets["paid"]["eligible_entries"],
                      "purchases": targets["paid"]["units"],
                      "units": float(targets["paid"]["units"]),
                      "sessions": targets["paid"]["sessions"]}
        else:
            chans = [c for c in spec["channels"] if c in targets["per_channel"]]
            purchases = sum(targets["per_channel"][c]["purchases"] for c in chans)
            out[g] = {
                "entries": sum(targets["per_channel"][c]["eligible_entries"] for c in chans),
                "purchases": purchases,
                "units": purchases,
                "sessions": sum(targets["per_channel"][c]["sessions"] for c in chans),
            }
    return out


# ---------------------------------------------------------------- curves (docs §5)

CLEAN_EXCLUDE_STAGES = {"Missing campaign dates", "Outside campaign window"}

# The curve a group's unit plan is read off (docs §5.3): its plan line, its
# expected-by-today and the shape of its forward path. The page counts secured
# units, which take a draw entry the day it is made, while Total_Product_Units
# books the draw's winners on the close day. Read as demand, that booking put
# about a quarter of the email and social targets on the last day, so the
# projection counted on a close-day jump the entries never make. The entries
# curve times units the way the actual does. Paid reads its even daily plan.
UNIT_PLAN_CURVE = "entries"


def poisson_fit(y, X, offset=None, iters: int = 100):
    """Poisson regression, log E[y] = X b + offset, by iteratively reweighted
    least squares. Returns (b, cov) with the quasi-Poisson covariance - the
    inverse information scaled by the Pearson dispersion, floored at 1, so a
    series noisier than Poisson gets the wider intervals it has earned - or
    None when the design cannot identify every column or the fit fails. The
    panel priors (etl/analysis/cpe_elasticity.py) and each campaign's own cost
    terms (campaign_cost_terms) are fitted with it."""
    y = np.asarray(y, dtype=float)
    X = np.asarray(X, dtype=float)
    off = np.zeros(len(y)) if offset is None else np.asarray(offset, dtype=float)
    n, k = X.shape
    if n <= k or float(y.sum()) <= 0 or np.linalg.matrix_rank(X) < k:
        return None
    mu = np.maximum(y, 0.5)
    eta = np.log(mu)
    beta = np.zeros(k)
    for _ in range(iters):
        z = eta - off + (y - mu) / mu
        xtw = X.T * mu
        try:
            new = np.linalg.solve(xtw @ X, xtw @ z)
        except np.linalg.LinAlgError:
            return None
        eta = np.clip(X @ new + off, -30.0, 30.0)
        mu = np.exp(eta)
        done = float(np.max(np.abs(new - beta))) < 1e-10
        beta = new
        if done:
            break
    try:
        inv = np.linalg.inv((X.T * mu) @ X)
    except np.linalg.LinAlgError:
        return None
    phi = max(float(np.sum((y - mu) ** 2 / mu)) / max(n - k, 1), 1.0)
    return beta, inv * phi


def campaign_cost_terms(paid_daily: list[dict], b: dict = BENCH, spent_before: float = 0.0,
                        close: date | None = None) -> dict:
    """How this campaign's cost per entry has responded to the day's budget
    and to its own spend so far, shrunk to the panel's priors (docs §7).

    Fits the campaign's paid entries day by day as Poisson with
        log E[entries_d] = a + (1 - eps) x log(spend_d) - w x log(1 + C_d / K)
    on its days with spend, C_d being what it had spent before day d (the
    clock counts every day, and spent_before the spend ahead of the window)
    and K the panel's scale: the regression the priors come from
    (etl/analysis/cpe_elasticity.py). eps is how much dearer a bigger day
    makes an entry; w is the wear-out, each doubling of the spend so far
    making the next entry 2^w times dearer. Each estimate is combined with
    its prior by precision: a campaign with a tight estimate keeps it, a
    noisy one leans on the panel, and below cpe_fit_min_days of history the
    priors are used as they are. The two are shrunk together, through their
    joint covariance: a campaign that ramps its budget as it goes cannot tell
    a bigger day from more spend so far (Warhol's own days put the two at
    -0.8 correlation), and the pair then moves towards the panel along the
    line its data cannot pin down, not each on its own. A campaign whose
    daily budget never moved cannot tell its elasticity from its level, so
    it keeps the prior elasticity and fits its wear-out alone. The draw's
    last days (`close`, the close's date) are fitted with the close's lift
    held at the panel's (cpe_close_lift), so a campaign's own cheap final
    days are read as the deadline's rush, not as its spend wearing off.

    Returns the values used (elasticity, wear-out, K) and how they were
    reached (own estimates, standard errors, days), all JSON-ready."""
    prior_eps = float(b.get("cpe_spend_elasticity", 0.0) or 0.0)
    prior_eps_sd = float(b.get("cpe_spend_elasticity_sd", 0.0) or 0.0)
    prior_w = float(b.get("cpe_wearout", 0.0) or 0.0)
    prior_w_sd = float(b.get("cpe_wearout_sd", 0.0) or 0.0)
    k = float(b.get("cpe_wearout_k", 1000.0) or 1000.0)
    out = {"elasticity": prior_eps, "wearout": prior_w, "wearoutK": k,
           "elasticityPrior": prior_eps, "wearoutPrior": prior_w, "elasticityOwn": None, "elasticitySe": None,
           "wearoutOwn": None, "wearoutSe": None, "ownCorrelation": None, "fitDays": 0}
    lift = [float(v) for v in (b.get("cpe_close_lift") or [])]
    rows, spent = [], float(spent_before or 0.0)
    for x in sorted(paid_daily or [], key=lambda r: r["date"]):
        if x.get("partial"):          # the part day is not a day's worth of anything
            continue
        s = float(x.get("spend") or 0.0)
        to_close = (close - date.fromisoformat(x["date"])).days if close else None
        if s > 20 and (to_close is None or to_close >= 0):
            rows.append((s, float(x.get("entries") or 0.0), spent,
                         math.log(lift[to_close]) if to_close is not None and to_close < len(lift) else 0.0))
        spent += s
    if len(rows) < int(b.get("cpe_fit_min_days", 8) or 8):
        return out
    y = np.array([r[1] for r in rows])
    ls = np.log([r[0] for r in rows])
    clock = np.log1p(np.array([r[2] for r in rows]) / k)
    one = np.ones(len(rows))
    rush = np.array([r[3] for r in rows])                # the close's lift, in logs, 0 before it
    fit = poisson_fit(y, np.column_stack([one, ls, clock]), offset=rush) if float(np.std(ls)) > 1e-6 else None
    prior = np.array([prior_eps, prior_w])
    # the prior's spread; a zero width holds that term at the prior
    prior_var = np.array([max(prior_eps_sd, 1e-6) ** 2, max(prior_w_sd, 1e-6) ** 2])
    if fit is not None:
        beta, cov = fit
        own = np.array([1.0 - float(beta[1]), -float(beta[2])])     # (eps, w) from the log-rate slopes
        v = cov[1:, 1:]                                              # cov(1 - b1, -b2) = cov(b1, b2)
        se = np.sqrt(np.clip(np.diag(v), 0.0, None))
        out.update({"elasticityOwn": round(float(own[0]), 4), "elasticitySe": round(float(se[0]), 4),
                    "wearoutOwn": round(float(own[1]), 4), "wearoutSe": round(float(se[1]), 4),
                    "ownCorrelation": round(float(v[0, 1] / (se[0] * se[1])), 3) if se.all() else None,
                    "fitDays": len(rows)})
        try:
            vi, pi = np.linalg.inv(v), np.diag(1 / prior_var)
            eps, wear = np.linalg.solve(vi + pi, vi @ own + pi @ prior)
        except np.linalg.LinAlgError:
            eps, wear = prior
    else:
        # a flat budget: the day's level is the prior's, the wear-out the campaign's own
        fit = poisson_fit(y, np.column_stack([one, clock]), offset=(1.0 - prior_eps) * ls + rush)
        if fit is None:
            return out
        beta, cov = fit
        w_own, w_se = -float(beta[1]), float(np.sqrt(max(cov[1, 1], 0.0)))
        out.update({"wearoutOwn": round(w_own, 4), "wearoutSe": round(w_se, 4), "fitDays": len(rows)})
        eps = prior_eps
        wear = ((w_own / w_se ** 2 + prior_w / prior_var[1]) / (1 / w_se ** 2 + 1 / prior_var[1])
                if w_se > 0 and np.isfinite(w_se) else prior_w)
    eps = min(max(float(eps), 0.0), 0.9)
    wear = min(max(float(wear), 0.0), 0.9)
    # together they stay under 1, so more spend always buys more entries
    wear = min(wear, max(0.95 - eps, 0.0))
    out["elasticity"], out["wearout"] = round(float(eps), 4), round(float(wear), 4)
    return out


class CostPath:
    """The forward price of a converting entry (docs §7): one path for the
    paid projection, the Paid ROI chart and the budget recommendation.

    The anchor is the trailing window's price (cpe_now, per converting unit),
    paid at the window's daily spend (spend_ref) and at the window's place on
    the campaign's spend so far (clock_ref, its spend-weighted spend so far).
    On a future day at a flat daily spend s the price is
        cpe_now x (s / spend_ref)^eps x ((K + C) / (K + clock_ref))^wear
    with C what the campaign will have spent before that day. The budget
    moves the price once, through the elasticity, and again as it adds up,
    through the wear-out: a bigger budget wears the audience out faster. The
    first future day is the day after the last full day (the part day, when
    there is one), and each day adds a full day's spend to the clock.

    The draw's last days buy more: lift[k] is how many times the entries a
    euro buys k days before the close (the last future day is the close), so
    their price is divided by it. A window that itself fell in those days
    paid a price the rush had cut, anchor_lift (its spend-weighted lift), so
    the price underneath is the window's times anchor_lift."""

    def __init__(self, cpe_now: float, spend_ref: float | None, clock_ref: float, spent: float,
                 n_days: int, eps: float, wear: float, k: float,
                 lift: tuple | list = (), anchor_lift: float = 1.0):
        self.cpe_now, self.spend_ref, self.clock_ref, self.spent = cpe_now, spend_ref, clock_ref, spent
        self.n, self.eps, self.wear, self.k = max(int(n_days), 0), eps, wear, k
        self.lift, self.anchor_lift = [float(v) for v in (lift or [])], float(anchor_lift or 1.0)

    def multipliers(self, s: float, lifted: bool = True) -> list[float]:
        """The price on each future day over the anchor's, at a flat daily
        spend s; with lifted=False, the price underneath the close's lift."""
        lvl = (s / self.spend_ref) ** self.eps if (self.eps and self.spend_ref and s > 0) else 1.0
        base = self.k + self.clock_ref
        out = []
        for i in range(self.n):
            m = lvl * ((self.k + self.spent + s * i) / base) ** self.wear * self.anchor_lift
            to_close = self.n - 1 - i
            if lifted and to_close < len(self.lift):
                m /= self.lift[to_close]
            out.append(m)
        return out

    def cpe_close(self, s: float) -> float:
        """The price of a converting entry at the close before the close's
        lift, at a flat daily spend s: the path's worst day, where the ROI
        floor is read."""
        m = self.multipliers(s, lifted=False)
        return self.cpe_now * (m[-1] if m else self.anchor_lift)

    def units(self, s: float) -> float:
        """Converting units a flat daily spend s buys from the first future day
        to the close, the close's lift included."""
        return sum(s / (self.cpe_now * m) for m in self.multipliers(s)) if s > 0 else 0.0

    @staticmethod
    def _solve(f, target: float, lo: float = 1.0, hi: float = 1e9, iters: int = 80) -> float:
        """The daily spend at which an increasing f(spend) reaches target, by
        bisection on the log of spend: 0 when even lo is past it, inf when hi
        falls short."""
        if f(lo) >= target:
            return 0.0
        if f(hi) < target:
            return math.inf
        a, z = math.log(lo), math.log(hi)
        for _ in range(iters):
            mid = (a + z) / 2
            if f(math.exp(mid)) < target:
                a = mid
            else:
                z = mid
        return math.exp(z)

    def spend_for_units(self, units: float) -> float:
        """The flat daily spend that buys `units` converting units by the close."""
        return self._solve(self.units, units)

    def spend_for_cpe_close(self, cpe: float) -> float:
        """The flat daily spend at which the last day's price reaches `cpe`."""
        return self._solve(self.cpe_close, cpe)


def pdsa_for(release: dict, d: date) -> float:
    a = date.fromisoformat(release["announce_date"])
    e = date.fromisoformat(release["launch_end"])
    L = (e - a).days
    return (d - a).days / L if L else 0.0


def observation_clock(newest: date, now: datetime | None = None) -> tuple[date, date, float]:
    """The feed's newest day, the last full day, and the share of the newest day seen.

    While the feed is live its newest day is the current calendar day, and
    that day is only part-observed: sessions, entries and orders keep landing
    until midnight. The page shows the day so far - the actuals run through it -
    but anything that treats a day as a whole observation (the paid pacing
    rules, the run rates, whether a campaign is complete) stops at the last
    full day, and the references "by today" are read at the share of today
    seen, so a morning reading is not behind for hours that have not happened.
    A newest day already in the past is a full day. The clock is London's, the
    business's own; `now` is injectable for tests."""
    if now is None:
        try:
            now = datetime.now(ZoneInfo("Europe/London")) if ZoneInfo else datetime.now(timezone.utc)
        except Exception:  # no tz database on the box
            now = datetime.now(timezone.utc)
    today = now.date()
    if newest < today:
        return newest, newest, 1.0
    seen = round((now.hour * 60 + now.minute) / 1440, 4)
    return today, today - timedelta(days=1), seen


EMAIL_REF_MONTHS = 24   # rate references: draw launches that closed within this span

# Every launch on file, configured and discovered, with its artist and dates,
# noted once a run by main() (note_launches), so an email window never reaches
# back into an earlier launch by the same artist (email_window_start).
LAUNCHES: list[dict] = []


def _artist_key(release_name: str | None) -> str:
    return str(release_name or "").split(" · ")[0].strip().casefold()


def note_launches(releases) -> None:
    """Record every launch's name, artist and close for email_window_start."""
    out = []
    for r in releases or []:
        name = (r or {}).get("release_name")
        try:
            end = date.fromisoformat(str(r.get("launch_end"))[:10]) if name and r.get("launch_end") else None
        except ValueError:
            end = None
        if end is not None:
            out.append({"name": name, "artist": _artist_key(name), "close": end})
    LAUNCHES[:] = out


def email_window_start(release: dict, start: date, launches: list[dict] | None = None) -> date:
    """Where a release's email window opens: `start` (its private room or its
    announce), or the day after an earlier launch by the same artist closed,
    when that is later. Sends join a release by campaign code alone, and an
    artist's launches can carry one code between them: Zeng Fanzhi's July
    Rainbow sends were tagged with the LE's code and fell inside a window
    opened a month before the LE's announce, so the LE counted them as its
    own. An earlier launch is one that closed before this one's announce, so
    the window never starts after it."""
    name = (release or {}).get("release_name")
    artist = _artist_key(name)
    try:
        ann = date.fromisoformat(str(release.get("announce_date"))[:10])
    except (AttributeError, TypeError, ValueError):
        return start
    if not artist:
        return start
    for w in (LAUNCHES if launches is None else launches):
        if w["name"] != name and w["artist"] == artist and w["close"] < ann:
            start = max(start, w["close"] + timedelta(days=1))
    return start


def email_delivered_benchmark(emails: pd.DataFrame, as_of: date, discovered: list[dict] = (),
                              spend: pd.DataFrame | None = None,
                              at: pd.DataFrame | None = None) -> dict | None:
    """Email references from the sends on file (HubSpot on the live site).

    Delivered-emails median total among completed configured campaigns, plus
    the pooled cumulative delivery-timing curve on the standard pdsa grid
    (email volume is send-driven and spiky - a pro-rata line would misread
    early campaigns). Totals scale with the release, so this cohort stays the
    configured (targeted) releases. It is the fallback delivered target: the
    build's first choice is the sends the release's own sessions plan implies
    at the cohort's rates (see build_release).

    Open-rate, click-rate and sessions-per-click references: the median of
    each completed draw launch's pooled rate (opened, or clicked, over
    delivered across its launch-window sends; AA Email sessions over those
    clicks). Rates do not scale with the release, so this cohort adds every
    discovered release whose Meta campaign is a draw and whose dates are
    complete, closed within EMAIL_REF_MONTHS. Sessions per click is the one
    that used to be derived, as the plan's sessions over a click volume built
    from the cohort's median send, which made it a residual rather than a
    reference and let it carry whatever a small-list release lost on sends.

    Each part is None until >= 2 launches qualify; the whole is None when
    neither does. Every launch's own row rides on the result (rows), so a
    release is read against the cohort without itself and without the
    launches that closed after it (email_bench_for), and each launch's sends
    are read from where its email window opens (email_window_start)."""
    if emails.empty:
        return None

    def email_sessions(name, start, end):
        # the release's AA Email sessions over the same window as its sends
        if at is None:
            return None
        sub = at[(at["simple_release_name"] == name)
                 & (at["event_date"] >= start) & (at["event_date"] <= end)]
        sub = sub[sub["channel"].map(GROUP_OF) == "aa_email"]
        return float(sub["Sessions_Total"].sum())

    def window_sends(code, start, end):
        sub = emails[(emails["campaign"] == code)
                     & (emails["sent_at"].dt.date >= start)
                     & (emails["sent_at"].dt.date <= end)]
        core = sub[sub["email_type"].isin(["GEN", "CUS", "INS"])]
        if core.empty and not sub.empty:
            core = sub[~sub["email_type"].isin(["TRNS", "AUT", "FREQ", "TEST"])]
        return core if float(core["delivered"].sum()) >= 100 else None

    def rate_row(rid, end, core, sessions=None):
        total = float(core["delivered"].sum())
        opened, clicked = float(core["opened"].sum()), float(core["clicked"].sum())
        spc = sessions / clicked if sessions and clicked > 0 else None
        return (rid, end, opened / total, clicked / total, clicked / opened if opened > 0 else None, spc)

    # one row per launch with sends on file: the configured ones give a total
    # and a delivery curve, and a rate row when they closed within the span;
    # the discovered draw launches a rate row
    rows, seen = [], set()
    recent = as_of - timedelta(days=EMAIL_REF_MONTHS * 30)
    for r in INPUTS["releases"]:
        seen.add(r["campaign_code"])
        end = date.fromisoformat(r["launch_end"])
        if end >= as_of:
            continue
        ann = date.fromisoformat(r["announce_date"])
        start = email_window_start(r, date.fromisoformat(r["private_room_open"]))
        core = window_sends(r["campaign_code"], start, end)
        if core is None:
            continue
        total = float(core["delivered"].sum())
        L = max((end - ann).days, 1)
        c = core.assign(pdsa=[(d.date() - ann).days / L for d in core["sent_at"]]).sort_values("pdsa")
        cum = c["delivered"].cumsum() / total
        row = []
        for t in CURVE_GRID:
            sel = cum[c["pdsa"] <= t]
            row.append(float(sel.iloc[-1]) if len(sel) else 0.0)
        rows.append({"id": r["id"], "name": r.get("release_name"), "code": r["campaign_code"], "end": end,
                     "total": total, "shares": row,
                     "rate": rate_row(r["id"], end, core, email_sessions(r["release_name"], start, end))
                     if end >= recent else None})
    for r in discovered:
        code = r.get("campaign_code")
        if not code or code in seen or not r.get("announce_date") or not r.get("launch_end"):
            continue
        end = date.fromisoformat(r["launch_end"])
        if end >= as_of or end < recent:
            continue
        camp = match_campaign(code, spend) if spend is not None else None
        if not camp or not camp.lower().endswith("draw"):
            continue
        ann = date.fromisoformat(r["announce_date"])
        start = email_window_start(r, ann - timedelta(days=PR_LEAD_DAYS))
        core = window_sends(code, start, end)
        if core is not None:
            rows.append({"id": r["id"], "name": r.get("release_name"), "code": code, "end": end,
                         "total": None, "shares": None,
                         "rate": rate_row(r["id"], end, core, email_sessions(r["release_name"], start, end))})
    return email_medians(rows)


def email_medians(rows: list[dict]) -> dict | None:
    """The email references from the launches' rows (email_delivered_benchmark):
    the median delivered total and the pooled delivery-timing curve over the
    configured launches, and the median open, click, clicks-per-open and
    sessions-per-click rates over the rate cohort. Each part is None until two
    launches qualify; the whole is None when neither does."""
    shares = [r["shares"] for r in rows if r.get("total") is not None]
    totals = [r["total"] for r in rows if r.get("total") is not None]
    rates = [r["rate"] for r in rows if r.get("rate") is not None]
    out = {"total": None, "curve": None, "open_rate": None, "click_rate": None, "ctor_rate": None,
           "spc_rate": None, "cohort": None, "rows": rows}
    if len(totals) >= 2:
        med = pd.DataFrame(shares).median().tolist()
        for i in range(1, len(med)):
            med[i] = max(med[i], med[i - 1])
        top = med[-1] or 1.0
        out["total"] = float(pd.Series(totals).median())
        out["curve"] = [round(min(v / top, 1.0), 4) for v in med]
    if len(rates) >= 2:
        rates.sort(key=lambda x: x[1], reverse=True)
        out["open_rate"] = float(pd.Series([x[2] for x in rates]).median())
        out["click_rate"] = float(pd.Series([x[3] for x in rates]).median())
        ctors = [x[4] for x in rates if x[4] is not None]   # clicks per opened email
        out["ctor_rate"] = float(pd.Series(ctors).median()) if len(ctors) >= 2 else None
        spcs = [x[5] for x in rates if x[5] is not None]    # AA Email sessions per click
        out["spc_rate"] = float(pd.Series(spcs).median()) if len(spcs) >= 2 else None
        out["cohort"] = {"n": len(rates), "releases": [x[0] for x in rates],
                         "from": rates[-1][1].isoformat(), "to": rates[0][1].isoformat()}
    return out if (out["total"] is not None or out["open_rate"] is not None) else None


def email_bench_for(bench: dict | None, release: dict | None) -> dict | None:
    """The email references one release is read against (docs 8): the run's
    cohort without the release's own sends and without the launches that
    closed after it, so a closed release is never graded against itself or
    against launches that had not closed when it did. A live release's cohort
    is the run's own (every launch in it closed before today). A launch is
    left out by id, by name and by campaign code: a configured release's
    discovered twin carries another id and the same code."""
    if not bench or not release or not bench.get("rows"):
        return bench
    rid, name, code = release.get("id"), release.get("release_name"), release.get("campaign_code")
    try:
        end = date.fromisoformat(str(release.get("launch_end"))[:10])
    except (TypeError, ValueError):
        end = None

    def own_or_later(r: dict) -> bool:
        return bool(r["id"] == rid or (name and r.get("name") == name) or (code and r.get("code") == code)
                    or (end is not None and r["end"] > end))
    keep = [r for r in bench["rows"] if not own_or_later(r)]
    return bench if len(keep) == len(bench["rows"]) else email_medians(keep)


def email_refs(bench: dict | None) -> dict:
    """The email rate references as the UI reads them (percent) plus the
    cohort behind them; the UI falls back to fixed defaults on None."""
    if not bench or bench.get("open_rate") is None:
        return {"emailOpenRateRef": None, "emailClickRateRef": None, "emailClickToOpenRef": None,
                "emailSessionsPerClickRef": None, "emailRefCohort": None}
    return {"emailOpenRateRef": round(bench["open_rate"] * 100, 1),
            "emailClickRateRef": round(bench["click_rate"] * 100, 1),
            "emailClickToOpenRef": round(bench["ctor_rate"] * 100, 1) if bench.get("ctor_rate") is not None else None,
            "emailSessionsPerClickRef": round(bench["spc_rate"], 3) if bench.get("spc_rate") is not None else None,
            "emailRefCohort": bench["cohort"]}

def build_curves(at: pd.DataFrame, members: list[str] | None = None) -> dict:
    # `members` narrows the panel to one basket's launches (BENCHMARK_SPEC
    # §4.1), so a release is paced like the launches it is benchmarked against
    # rather than like the whole history. The export edge test below asks
    # whether a release's first day is the day the export itself starts - a
    # fact about the export, not about the basket - so that date is read before
    # the filter narrows the frame.
    first_export_date = at["event_date"].min()
    if members is not None:
        at = at[at["simple_release_name"].isin([str(m) for m in members])]
    df = at[~at["campaign_stage"].isin(CLEAN_EXCLUDE_STAGES)].copy()
    df = df[df["pct_days_since_announcement"].notna()]

    # per release x day totals (all channels) and per display group
    df["group"] = df["channel"].map(GROUP_OF)
    metrics = {"sessions": "Sessions_Total",
               "entries": "Draw_Entries_Eligible_Units",
               "units": "Total_Product_Units"}

    day = (df.groupby(["simple_release_name", "event_date"], as_index=False)
             .agg(pdsa=("pct_days_since_announcement", "first"),
                  **{k: (v, "sum") for k, v in metrics.items()}))

    # clean completed releases: window start captured, launch passed, not cut by export edge
    rel_stats = day.groupby("simple_release_name").agg(
        pdsa_min=("pdsa", "min"), pdsa_max=("pdsa", "max"),
        d_min=("event_date", "min"), entries=("entries", "sum"))
    clean = rel_stats[(rel_stats.pdsa_min <= 0) & (rel_stats.pdsa_max >= 1.0)
                      & (rel_stats.d_min > first_export_date) & (rel_stats.entries >= 20)].index

    def curve_from(frame: pd.DataFrame, value_col: str, releases) -> list[float] | None:
        shares = []
        for r in releases:
            sub = frame[frame["simple_release_name"] == r].sort_values("pdsa")
            total = sub[value_col].sum()
            if total < 10:
                continue
            cum = sub[value_col].cumsum() / total
            row = []
            for t in CURVE_GRID:
                sel = cum[sub["pdsa"] <= t]
                row.append(float(sel.iloc[-1]) if len(sel) else 0.0)
            shares.append(row)
        if len(shares) < 4:
            return None
        arr = pd.DataFrame(shares)
        med = arr.median().tolist()
        # enforce monotone, end at 1
        for i in range(1, len(med)):
            med[i] = max(med[i], med[i - 1])
        top = med[-1] or 1.0
        return [round(min(v / top, 1.0), 4) for v in med]

    curves = {"grid": CURVE_GRID, "n_releases": int(len(clean)), "all": {}, "groups": {}}
    for m in metrics:
        curves["all"][m] = curve_from(day, m, clean)

    gday = (df.groupby(["simple_release_name", "group", "event_date"], as_index=False)
              .agg(pdsa=("pct_days_since_announcement", "first"),
                   **{k: (v, "sum") for k, v in metrics.items()}))
    for g in DISPLAY_GROUPS:
        sub = gday[gday["group"] == g]
        curves["groups"][g] = {}
        for m in metrics:
            c = curve_from(sub, m, clean)
            curves["groups"][g][m] = c  # may be None -> UI/build falls back to all
    # The units series stay as measured, draw winners on the close day, and
    # no plan is read off them: the groups' unit plans read the entries series
    # (UNIT_PLAN_CURVE) and paid its even daily plan.
    return curves


def curve_value(curves: dict, group: str | None, metric: str, pdsa: float) -> float:
    series = None
    if group:
        series = curves["groups"].get(group, {}).get(metric)
    if series is None:
        series = curves["all"][metric]
    grid = curves["grid"]
    if pdsa <= grid[0]:
        return 0.0
    if pdsa >= grid[-1]:
        return 1.0
    for i in range(1, len(grid)):
        if pdsa <= grid[i]:
            w = (pdsa - grid[i - 1]) / (grid[i] - grid[i - 1])
            return series[i - 1] + w * (series[i] - series[i - 1])
    return 1.0


# One curve panel per basket for the life of the run. Rebuilding it costs a
# full pass over the funnel frame, and most releases sit in the same handful of
# clusters, so the same panel would otherwise be rebuilt a dozen times. The
# members are part of the key as well as the id because a bespoke basket
# carries the same id whatever is in it (BENCHMARK_SPEC §6).
_BASKET_CURVES: dict[tuple, dict] = {}


def basket_curves(at: pd.DataFrame, basket: dict, pooled: dict) -> dict:
    """The pace curves for one basket (BENCHMARK_SPEC §4.1), cached per run.

    A series the basket cannot answer - fewer than four of its members ran far
    enough to shape that metric - comes back None and falls back to the pooled
    curve here. curve_value cannot do it: from inside it, a missing group curve
    and a missing panel look the same.
    """
    key = (basket["id"], tuple(basket["members"]))
    curves = _BASKET_CURVES.get(key)
    if curves is None:
        curves = build_curves(at, basket["members"])
        for m, series in curves["all"].items():
            if series is None:
                curves["all"][m] = pooled["all"][m]
        for g, by_metric in curves["groups"].items():
            for m, series in by_metric.items():
                if series is None:
                    by_metric[m] = pooled["groups"].get(g, {}).get(m)
        _BASKET_CURVES[key] = curves
    return curves


# ---------------------------------------------------------------- draws (docs §2)

def load_draw(release: dict) -> dict | None:
    fname = release.get("draw_entries_file")
    if not fname or not source_file(fname).exists():
        return None
    products = [p["name"] for p in draw_products_typed(release) if p.get("name")]
    per_product = defaultdict(int)
    tiers = defaultdict(int)
    total = eligible = framed = preorder = wanted_units = surplus = 0
    with source_file(fname).open() as f:
        for row in csv.DictReader(f):
            total += 1
            ok = not (row.get("Exclusion") or row.get("Removal") or row.get("Processing Error"))
            if not ok:
                continue
            eligible += 1
            tiers[row.get("Tier") or "N/A"] += 1
            if row.get("Framed") == "Yes":
                framed += 1
            if row.get("PreOrder") == "Yes":
                preorder += 1
            entered = [p for p in products if p in (row.get("Remaining Eligible Entries") or "")]
            for p in entered:
                per_product[p] += 1
            mq = row.get("MaxQuantity")
            cap = len(entered) if mq in (None, "", "N/A") else min(int(mq), len(entered))
            wanted_units += cap
            surplus += max(len(entered) - cap, 0)
    return {
        "entrants": total, "eligible": eligible,
        "tier_mix": dict(tiers),
        "framed_share": round(framed / eligible, 4) if eligible else None,
        "preorder_share": round(preorder / eligible, 4) if eligible else None,
        "units_demanded": wanted_units,
        "surplus_entries": surplus,
        "per_product": [{"name": p, "entries": per_product.get(p, 0)} for p in products],
    }


# ---------------------------------------------------------------- sell-through per product (docs §6.3)

_PRODUCTS_FEED: dict | None = None


def load_products_feed() -> dict:
    """Per release, the draws and entry patterns etl/aggregate_events.py wrote
    (data/app/release_products.json; counts only). Missing on a checkout that
    has never run the events aggregation, in which case every release keeps
    the release-level sell-through and the card says so."""
    global _PRODUCTS_FEED
    if _PRODUCTS_FEED is None:
        path = APP / "release_products.json"
        try:
            _PRODUCTS_FEED = json.loads(path.read_text()) if path.exists() else {}
        except ValueError as e:
            print(f"warning: ignoring {path.name}: {e}")
            _PRODUCTS_FEED = {}
    return _PRODUCTS_FEED


_ORDERS_FEED: dict | None = None
_PRODUCT_EDITIONS = None
_ARTIST_STOP = {"the", "estate", "foundation", "studio", "of", "and"}
# a work the orders feed tells apart from another of the same title by the
# work its SKUs name (server/bigquery.js product_names): 'Problem Painting
# (FISCH-PROB2)'
_WORK_SUFFIX = re.compile(r"^(.+) \(([^()-]+-[^()-]+)\)$")


def _artist_tokens(name) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", str(name).lower()) if t and t not in _ARTIST_STOP}


def product_editions():
    """Edition size per product from the Airtable pricing rows
    (data/release_pricing.csv, one row per product): a lookup by release name
    and Shopify product title. The title must match; among rows that share a
    title the release's year and then its artist decide, so a reissued title
    finds its own row, and a title that stays ambiguous gets no edition. A
    work the orders feed names with its work code after a title it shares
    with another work reads that title's rows."""
    global _PRODUCT_EDITIONS
    if _PRODUCT_EDITIONS is not None:
        return _PRODUCT_EDITIONS
    by_title: dict[str, list] = {}
    path = DATA / "release_pricing.csv"
    if path.exists():
        try:
            pr = pd.read_csv(path, dtype=str).fillna("")
            for r in pr.itertuples(index=False):
                try:
                    ed = float(r.edition_size)
                except (TypeError, ValueError):
                    continue
                if ed <= 0:
                    continue
                year = (str(r.launch_date) or str(r.quarter) or "")[:4]
                by_title.setdefault(_norm(r.title), []).append((ed, year, _artist_tokens(r.artist)))
        except Exception as e:  # noqa: BLE001 - a broken pricing file must not stop the build
            print(f"warning: ignoring {path.name} for product editions: {e}")

    def lookup(release_name: str, product_title: str):
        cands = by_title.get(_norm(product_title)) or []
        if not cands:
            # one of two works that share a title: Airtable's rows of that
            # title, one per work, give its edition where they agree
            m = _WORK_SUFFIX.match(str(product_title))
            cands = (by_title.get(_norm(m.group(1))) or []) if m else []
        if not cands:
            return None
        parts = [x.strip() for x in str(release_name).split("·")]
        year = parts[-1][:4] if len(parts) >= 3 else ""
        artist = _artist_tokens(parts[0]) if parts else set()
        if len(cands) > 1 and year:
            cands = [c for c in cands if c[1] == year] or cands
        if len(cands) > 1 and artist:
            cands = [c for c in cands if c[2] & artist] or cands
        return int(round(cands[0][0])) if len({c[0] for c in cands}) == 1 else None
    _PRODUCT_EDITIONS = lookup
    return lookup


def load_orders_feed() -> dict:
    """Per release, the orders feed server/bigquery.js writes from
    Order_Line_Concept (data/orders_by_product.csv and data/draw_products.csv;
    aggregates only, docs #2.4): products keyed by Shopify title with units
    paid, orders awaiting payment (drafts: an advisor's draft orders and
    pending orders, not the draw's own pre-authorisation drafts, which are
    kept apart as entryDrafts), the list price and the Airtable edition
    where the title matches; the product each draw's winners bought, or its
    entrants hold pre-authorisation drafts for until it has winners;
    and the release's totals with the last order or draft day as `asOf`."""
    global _ORDERS_FEED
    if _ORDERS_FEED is not None:
        return _ORDERS_FEED
    feed: dict = {}
    p1, p2 = DATA / "orders_by_product.csv", DATA / "draw_products.csv"

    def num(v) -> float:
        try:
            return float(v) if str(v).strip() not in ("", "nan") else 0.0
        except (TypeError, ValueError):
            return 0.0
    if p1.exists():
        try:
            df = pd.read_csv(p1, dtype=str).fillna("")
        except Exception as e:  # noqa: BLE001
            print(f"warning: ignoring {p1.name}: {e}")
            df = None
        if df is not None:
            editions = product_editions()
            for r in df.itertuples(index=False):
                rel = feed.setdefault(r.release, {"products": {}, "draws": {}, "drafts": 0.0, "unitsPaid": 0.0, "asOf": None,
                                                  "campaignCode": None,
                                                  "framing": {"prints": 0.0, "frames": 0.0, "notOffered": 0.0,
                                                              "entrantPrints": 0.0, "entrantFrames": 0.0}})
                if not rel["campaignCode"] and str(getattr(r, "campaign_code", "") or "").strip():
                    rel["campaignCode"] = str(r.campaign_code).strip()
                paid, drafts = num(r.units_paid), num(r.units_draft_pending)
                price = num(r.list_price_eur)
                # framing (docs 6.4): the paid prints a frame was on offer for
                # and the frames bought with them, the same on the app's entry
                # drafts, and on the orders awaiting payment (the drafts the
                # sell-through counts); a feed pulled before the columns
                # existed reads as no framing, and the card stays off the page,
                # and one pulled before the drafts' pair reads them as None,
                # so the forecast takes the buyers' rate for them instead
                offered, frames = num(getattr(r, "prints_offered_paid", "")), num(getattr(r, "frames_paid", ""))
                e_prints, e_frames = num(getattr(r, "prints_offered_entry_drafts", "")), num(getattr(r, "frames_entry_drafts", ""))
                has_draft_frames = "prints_offered_awaiting" in df.columns
                d_prints = num(getattr(r, "prints_offered_awaiting", "")) if has_draft_frames else None
                d_frames = num(getattr(r, "frames_awaiting", "")) if has_draft_frames else None
                rel["products"][r.product_title] = {
                    "printsOffered": offered, "frames": frames, "entrantPrints": e_prints, "entrantFrames": e_frames,
                    "draftPrints": d_prints, "draftFrames": d_frames,
                    "unitsPaid": paid, "drafts": drafts,
                    "draftCustomers": num(getattr(r, "draft_customers", "")) if str(getattr(r, "draft_customers", "")).strip() else None,
                    "entryDrafts": num(getattr(r, "units_entry_drafts", 0)),
                    "entrantDrafts": num(getattr(r, "units_entrant_drafts", 0)),
                    "winnerDrafts": num(getattr(r, "units_winner_drafts", 0)),
                    "winnerDraftsLapsed": num(getattr(r, "units_winner_drafts_lapsed", 0)),
                    "refunded": num(r.units_refunded),
                    "fromDrafts": num(r.units_from_drafts), "privateRoom": num(r.units_private_room),
                    "listPrice": price if price > 0 else None, "edition": editions(r.release, r.product_title),
                    "lastOrder": r.last_order or None, "lastDraft": r.last_draft or None,
                }
                rel["drafts"] += drafts
                rel["unitsPaid"] += paid
                fr = rel["framing"]
                fr["prints"] += offered
                fr["frames"] += frames
                fr["notOffered"] += max(paid - offered, 0.0)
                fr["entrantPrints"] += e_prints
                fr["entrantFrames"] += e_frames
                for d in (r.last_order, r.last_draft):
                    if d and (rel["asOf"] is None or d > rel["asOf"]):
                        rel["asOf"] = d
            # the query names each Shopify product once (server/bigquery.js
            # product_names); one under two titles is a file pulled before
            # that, whose renamed works are split across rows until the next pull
            names: dict = {}
            for r in df.itertuples(index=False):
                for pid in str(getattr(r, "product_ids", "") or "").split("|"):
                    if pid.strip():
                        names.setdefault((r.release, pid.strip()), set()).add(r.product_title)
            split = sorted({rel for (rel, _), ts in names.items() if len(ts) > 1})
            if split:
                print(f"warning: {p1.name} names one Shopify product with two titles in {len(split)} release(s), "
                      f"splitting a work across rows until the next pull: {', '.join(split[:5])}{' ...' if len(split) > 5 else ''}")
    if feed and p2.exists():
        try:
            dm = pd.read_csv(p2, dtype=str).fillna("")
            for r in dm.itertuples(index=False):
                rel = feed.get(r.release)
                if rel is not None and r.product_title in rel["products"]:
                    rel["draws"][r.draw_id] = r.product_title
        except Exception as e:  # noqa: BLE001
            print(f"warning: ignoring {p2.name}: {e}")
    _ORDERS_FEED = feed
    return feed


CLAIMS_WINDOW_HOURS = 6     # a draw's claims above its lowest count over this long are still landing
CLAIMS_HISTORY_HOURS = 24   # how long the pulls' claim counts are kept
CLAIMS_SAME_PULL_SECONDS = 600   # the claims file and the orders file must come from one pull


_DRAW_CLAIMS: dict | None = None


def draw_claims() -> dict:
    """load_draw_claims once per build: it keeps the history as it reads."""
    global _DRAW_CLAIMS
    if _DRAW_CLAIMS is None:
        _DRAW_CLAIMS = load_draw_claims()
    return _DRAW_CLAIMS


def load_draw_claims(now: float | None = None) -> dict:
    """{draw id: claims still landing} (docs/DATA_MODEL.md 6.3). The pull
    writes, per draw, the winners who still hold an open pre-authorisation
    draft on the draw's product and have no paid order for it
    (data/draw_claims.csv, server/bigquery.js drawClaimsSql). During a claim
    round those are the claims the order table has not caught up with yet;
    outside one a few stale drafts sit there for days. So each pull's counts
    are kept for a day (SOURCES/draw_claims_history.json, on the persistent
    disk with the other feeds) and a draw's claims are still landing only by
    how far its count stands above its lowest over the last six hours: a round
    shows as the rise, the stale ones as the floor. A first pull has no floor
    to compare with and counts none. A claims file from another pull than the
    orders file is not read: it would count a sale twice."""
    path, orders = DATA / "draw_claims.csv", DATA / "orders_by_product.csv"
    if not path.exists():
        return {}
    at = path.stat().st_mtime
    if orders.exists() and abs(at - orders.stat().st_mtime) > CLAIMS_SAME_PULL_SECONDS:
        return {}
    counts: dict = {}
    try:
        with path.open(newline="") as fh:
            for r in csv.DictReader(fh):
                try:
                    counts[str(r["draw_id"])] = counts.get(str(r["draw_id"]), 0) + int(float(r.get("claims") or 0))
                except (KeyError, TypeError, ValueError):
                    continue
    except OSError:
        return {}
    hist_path = SOURCES / "draw_claims_history.json"
    try:
        pulls = json.loads(hist_path.read_text()).get("pulls", []) if hist_path.exists() else []
    except (OSError, ValueError):
        pulls = []
    now = at if now is None else now
    pulls = [q for q in pulls if isinstance(q, dict) and isinstance(q.get("at"), (int, float))
             and 0 <= at - q["at"] <= CLAIMS_HISTORY_HOURS * 3600 and q["at"] != at]
    pulls.append({"at": at, "claims": counts})
    pulls.sort(key=lambda q: q["at"])
    try:
        SOURCES.mkdir(parents=True, exist_ok=True)
        tmp = hist_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"pulls": pulls}))
        tmp.replace(hist_path)
    except OSError as e:
        print(f"warning: could not keep the claims history: {e}")
    window = [q for q in pulls if at - q["at"] <= CLAIMS_WINDOW_HOURS * 3600]
    out = {}
    for d, n in counts.items():
        floor = min(int((q.get("claims") or {}).get(d, 0)) for q in window)
        if n - floor > 0:
            out[d] = n - floor
    return out


def orders_campaign_codes() -> dict:
    """Release name -> campaign code, from the orders feed (the code Meta's
    campaign names start with), for the panel's cost per paid unit."""
    return {name: f["campaignCode"] for name, f in load_orders_feed().items() if f.get("campaignCode")}


# ---------------------------------------------------------------- units paid, by day and channel

# The units a page counts come from the orders table, not the funnel's
# purchase events (docs 6.3): every paid order line, counted the way the
# orders feed counts it, on its CET order day and the channel of its own
# purchase event (server/bigquery.js unitsPaidSql). The funnel keeps
# sessions and entries; for units it would miss orders of several units,
# count test and refunded orders, and cut a different window than the
# sell-through, which is how the two cards used to disagree.
ORDERS_SINCE = date.fromisoformat(os.environ.get("BQ_SINCE") or "2025-01-01")   # server/bigquery.js SINCE
EARLY_SALES_DAYS = 45   # a first sale opens the window, but never earlier than this before the announce
UNITS_GRACE_DAYS = 2    # sales count to two days after the close, on both cards, and not after
DRAW_END_MAX_DAYS = 21  # a draw that ran past the clock's close moves the close this far at most (sales_close)
LATE_WARN_DAYS = 14     # units paid in these days after the window shut ...
LATE_WARN_UNITS = 10    # ... at least this many ...
LATE_WARN_SHARE = 0.10  # ... and this share of them with the window's own: the build warns the close may be early
NO_EVENT_WARN_SHARE = 0.05   # paid units the funnel has no purchase event for: warn above this share...
NO_EVENT_WARN_MIN = 5        # ... on at least this many units
# beside the other two orders files, from the same pull (server/bigquery.js
# writes the three together): a deploy resets all three to one committed copy
UNITS_FILE = DATA / "units_paid.csv"
_UNITS_FEED: dict | None = None
UNITS_FEED_INFO: dict = {}
_UNITS_COLS = ["product_title", "event_date", "channel", "purchase_event", "units", "private_room", "prints_offered", "frames"]


def load_units_feed() -> dict | None:
    """data/units_paid.csv, per release: a frame of units paid per product
    x CET order day x channel, with purchase_event False where the funnel has
    no purchase event for the order (its channel is then Untracked). None when
    the file is missing or unreadable: every page then reads the funnel's
    units, as before the feed existed, and says so (unitsSource 'funnel') -
    an absent feed is never read as no sales.

    The file and data/orders_by_product.csv come from one query's paid lines,
    so a release's units add up to its units paid there. Where they do not,
    the two files are from different pulls (a deploy's committed copy beside
    a fresh one, a pull that failed half way), and pairing them would count a
    draft paid in between twice or a new release as selling nothing: that
    release is left out of the feed and its page reads the funnel's units
    until the next pull puts the two back in step (UNITS_FEED_INFO names it)."""
    global _UNITS_FEED
    if _UNITS_FEED is not None:
        return _UNITS_FEED or None
    feed: dict = {}
    p = UNITS_FILE
    UNITS_FEED_INFO.clear()
    UNITS_FEED_INFO["path"] = str(p)
    if p.exists():
        try:
            df = pd.read_csv(p, dtype={"release": str, "product_title": str, "channel": str, "purchase_event": str})
            df = df[df["release"].notna() & df["order_date"].notna()].copy()
            df["event_date"] = pd.to_datetime(df["order_date"]).dt.date
            ch = df["channel"].fillna("").astype(str).str.strip()
            ch = ch.where(ch.str.lower() != "untracked", "Untracked").replace("", "Untracked")
            unknown = ~ch.isin(list(GROUP_OF) + ["Untracked"])
            UNITS_FEED_INFO["unknownChannels"] = sorted(set(ch[unknown]))
            df["channel"] = ch.where(~unknown, "Untracked")
            df["purchase_event"] = df["purchase_event"].fillna("").astype(str).str.lower().isin(["true", "1"])
            for src, dst in (("units_paid", "units"), ("units_private_room", "private_room"),
                             ("prints_offered_paid", "prints_offered"), ("frames_paid", "frames")):
                df[dst] = pd.to_numeric(df[src], errors="coerce").fillna(0.0) if src in df.columns else 0.0
            df["product_title"] = df["product_title"].fillna("").astype(str)
            feed = {name: g[_UNITS_COLS].reset_index(drop=True) for name, g in df.groupby("release")}
            orders = load_orders_feed()
            apart = sorted(n for n, g in feed.items()
                           if abs(float(g["units"].sum()) - float((orders.get(n) or {}).get("unitsPaid") or 0.0)) > 0.5)
            apart += sorted(n for n, o in orders.items() if n not in feed and float(o.get("unitsPaid") or 0.0) > 0.5)
            for n in apart:
                feed.pop(n, None)
            UNITS_FEED_INFO["outOfStep"] = apart
            UNITS_FEED_INFO.update(rows=int(len(df)), releases=len(feed),
                                   first=str(df["event_date"].min()) if len(df) else None,
                                   last=str(df["event_date"].max()) if len(df) else None,
                                   units=float(df["units"].sum()),
                                   noEvent=float(df.loc[~df["purchase_event"], "units"].sum()),
                                   pulled=datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(timespec="minutes"))
        except Exception as e:  # noqa: BLE001
            print(f"warning: ignoring {p.name}: {e} - pages read the funnel's units")
            feed = {}
    _UNITS_FEED = feed
    return feed or None


def units_rows(name: str) -> pd.DataFrame | None:
    """The release's rows in the units feed; an empty frame for a release the
    orders feed knows (by its products or drafts) with nothing paid, which is
    a real zero; None when neither feed knows it, the two files disagree on
    it (load_units_feed) or there is no feed, and the page reads the funnel's
    units."""
    feed = load_units_feed()
    if feed is None:
        return None
    if name in feed:
        return feed[name]
    if name in (UNITS_FEED_INFO.get("outOfStep") or []):
        return None
    o = load_orders_feed().get(name)
    return pd.DataFrame(columns=_UNITS_COLS) if o is not None and not float(o.get("unitsPaid") or 0.0) > 0.5 else None


def sales_window(rows: pd.DataFrame | None, campaign_start: date, announce: date | None,
                 launch_end: date, as_of: date) -> tuple[date, date, date | None]:
    """[start, end] the page counts sales over, the same days on every card
    (docs 6.3): from the campaign start (the private room, else the announce)
    or the release's first paid order, whichever is earlier - but never more
    than EARLY_SALES_DAYS before the announce - to two days after the close,
    or the as-of day. A release with no announce (a catalogue page) keeps its
    rolling window. Returns (start, end, the first paid day inside the floor)."""
    end = min(as_of, launch_end + timedelta(days=UNITS_GRACE_DAYS))
    first = None
    if rows is not None and len(rows) and announce is not None:
        floor = announce - timedelta(days=EARLY_SALES_DAYS)
        paid = rows[(rows["units"] > 0) & (rows["event_date"] >= floor) & (rows["event_date"] <= end)]
        first = min(paid["event_date"]) if len(paid) else None
    start = min(campaign_start, first) if first is not None else campaign_start
    return start, end, first


def draw_end(name: str) -> date | None:
    """The day the release's draw ended: the last entry day over its draws in
    the events aggregate (release_products.json draws[].last), which is the
    allocation day on the launches checked. None when the feed has no draw
    for the release or no day it can read."""
    feed = load_products_feed().get(name)
    draws = feed.get("draws") if isinstance(feed, dict) else None
    days = []
    for d in draws if isinstance(draws, list) else []:
        try:
            days.append(date.fromisoformat(str(d.get("last"))[:10]))
        except (AttributeError, TypeError, ValueError):
            continue
    return max(days) if days else None


def sales_close(name: str, launch_end: date) -> tuple[date, date | None]:
    """The close the sales window counts to (docs 6.3): the later of the
    clock's close and the day the release's draw ended (draw_end). The
    winners are drawn and pay when the draw ends, and a clock that closed
    before it (Jaume Plensa's UTOPIA: close 29 July, draw to 5 August, 155
    of 218 units paid after) dropped their payments from every card. A draw
    end more than DRAW_END_MAX_DAYS past the clock's close moves it that far
    and no further. Returns (the close, the draw's last entry day when it
    moved the close, else None); a release whose draw ended by the clock's
    close keeps it, as does one the feed has no draw for."""
    end = draw_end(name)
    if end is None or end <= launch_end:
        return launch_end, None
    return min(end, launch_end + timedelta(days=DRAW_END_MAX_DAYS)), end


def late_paid_warning(rid: str, rows: pd.DataFrame | None, shut: date, info: dict) -> str | None:
    """A build warning when many units were paid just after the sales window
    shut: at least LATE_WARN_UNITS in the LATE_WARN_DAYS after `shut`, and at
    least LATE_WARN_SHARE of those with the window's own. A draw that ran
    past the recorded close has its winners pay there, so the close is the
    first thing to check (docs 6.3). Printed and returned; None otherwise."""
    if info.get("source") != "orders" or rows is None or not len(rows):
        return None
    try:
        late = float(rows.loc[(rows["event_date"] > shut) & (rows["event_date"] <= shut + timedelta(days=LATE_WARN_DAYS)),
                              "units"].sum())
    except (KeyError, TypeError, ValueError):
        return None     # a warning, never a stop
    counted = float(info.get("total") or 0.0)
    if late < LATE_WARN_UNITS or late < LATE_WARN_SHARE * (late + counted):
        return None
    msg = (f"warning: {rid}: {late:.0f} units paid in the {LATE_WARN_DAYS} days after its sales window shut on "
           f"{shut} ({late / (late + counted):.0%} of them with the {counted:.0f} it counted) - check its close")
    print(msg)
    return msg


def swap_units(win: pd.DataFrame, name: str, rows: pd.DataFrame | None,
               start: date, end: date, shut: date) -> tuple[pd.DataFrame, dict]:
    """The window's units from the orders table in place of the funnel's
    (docs 6.3): the funnel rows keep their sessions and entries with their
    units zeroed, and each channel x day of paid units is added as a row of
    its own, so the Untracked fold, the Direct spread and the close fold all
    run on it unchanged. Returns the frame and what it counted: the source,
    the total, the units with no purchase event, and the paid units outside
    the window: before it opened, after it shut (`shut`, two days after the
    close), and, while it is open, paid after the as-of day (the orders pull
    ran ahead of the funnel, or a CET day began before London's), which
    count on the next build (`pending`). The funnel's units stand
    when the orders feed does not cover the window: no feed, a release it
    does not know, or a window opening before the feed's first day."""
    info = {"source": "funnel", "total": float(win["Total_Product_Units"].sum()),
            "noEvent": None, "before": None, "after": None, "pending": None}
    if rows is None or start < ORDERS_SINCE:
        return win, info
    inside = rows[(rows["event_date"] >= start) & (rows["event_date"] <= end)]
    by = (inside.groupby(["channel", "event_date"], as_index=False)
                .agg(Total_Product_Units=("units", "sum"), Product_Units_Private_Room=("private_room", "sum")))
    base = win.copy()
    base["Total_Product_Units"] = 0.0
    if "Product_Units_Private_Room" in base.columns:
        base["Product_Units_Private_Room"] = 0.0
    add = pd.DataFrame(index=range(len(by)), columns=base.columns)
    for c in base.columns:
        if c in _CLOCK_COLS:
            add[c] = np.nan
        elif pd.api.types.is_numeric_dtype(base[c]) and c != "event_date":
            add[c] = 0.0
    add["channel"] = by["channel"].to_numpy()
    add["event_date"] = by["event_date"].to_numpy()
    add["simple_release_name"] = name
    if "campaign_stage" in add.columns:
        add["campaign_stage"] = None
    if "group" in base.columns:
        add["group"] = add["channel"].map(GROUP_OF)
    add["Total_Product_Units"] = by["Total_Product_Units"].to_numpy(dtype=float)
    if "Product_Units_Private_Room" in add.columns:
        add["Product_Units_Private_Room"] = by["Product_Units_Private_Room"].to_numpy(dtype=float)
    out = pd.concat([base, add], ignore_index=True) if len(add) else base
    for c in out.columns:
        if c not in ("channel", "simple_release_name", "campaign_stage", "group", "event_date") and out[c].dtype == object:
            out[c] = pd.to_numeric(out[c], errors="coerce")
    total = float(inside["units"].sum())
    no_event = float(inside.loc[~inside["purchase_event"].astype(bool), "units"].sum())
    share = no_event / total if total > 0 else None
    info = {
        "source": "orders", "total": total,
        "noEvent": {"share": round(share, 4) if share is not None else None, "count": round(no_event, 1),
                    "total": round(total, 1),
                    "high": bool(share is not None and share > NO_EVENT_WARN_SHARE and no_event >= NO_EVENT_WARN_MIN)},
        "before": round(float(rows.loc[rows["event_date"] < start, "units"].sum()), 1),
        "after": round(float(rows.loc[rows["event_date"] > max(end, shut), "units"].sum()), 1),
        "pending": round(float(rows.loc[(rows["event_date"] > end) & (rows["event_date"] <= shut), "units"].sum()), 1),
    }
    return out, info


def keep_units(win: pd.DataFrame, total: float, pre: pd.DataFrame | None = None) -> pd.DataFrame:
    """The Untracked fold and the Direct spread move units between channels
    and never lose them - except on a window where every unit is on the
    channel being spread, which has nothing to spread over. Any units that
    went missing that way go back on the window's sessions (or evenly), so
    the channels still add up to the units paid. When the fold left nothing
    at all (every row was Untracked, or Direct with the switch on), the
    window's rows from before it (`pre`) come back as they were, Untracked
    as Other: its units have no channel, and Other is where the page counts
    what has none."""
    got = float(win["Total_Product_Units"].sum())
    lost = total - got
    if abs(lost) < 1e-6:
        return win
    if win.empty:
        if pre is None or pre.empty:
            return win
        back = pre.copy()
        back["channel"] = back["channel"].where(back["channel"].isin(list(GROUP_OF)), "Other")
        if "group" in back.columns:
            back["group"] = back["channel"].map(GROUP_OF)
        return back
    w = win["Sessions_Total"].clip(lower=0).fillna(0.0).to_numpy(dtype=float) if "Sessions_Total" in win.columns else np.zeros(len(win))
    if w.sum() <= 0:
        w = np.ones(len(win))
    win = win.copy()
    win["Total_Product_Units"] = win["Total_Product_Units"].to_numpy(dtype=float) + lost * w / w.sum()
    return win


def _no_draft_frames(p: dict) -> dict:
    """A shut window's drafts count for nothing, and so do the prints and
    frames on them (docs 6.4); a feed pulled before those columns keeps its
    None, which the framing forecast reads as not known."""
    return {k: 0.0 for k in ("draftPrints", "draftFrames") if p.get(k) is not None}


def _drafts_before(p: dict, since: date | None) -> bool:
    """Every draft on the product was raised before `since`: its last draft
    day (the orders feed's latest draft line) is earlier. A product with no
    draft day on file keeps its drafts."""
    if since is None:
        return False
    try:
        return date.fromisoformat(str(p.get("lastDraft") or "")[:10]) < since
    except ValueError:
        return False


def orders_in_window(name: str, rows: pd.DataFrame | None, start: date, end: date, closed: bool,
                     source: str, drafts_since: date | None = None) -> dict | None:
    """The orders feed as the sell-through and framing cards read it, cut to
    the window the page counts: each product's paid units, prints and frames
    summed over [start, end] from the units feed, every title kept (a title
    names its draw even at nothing paid), marked `windowed` so a draw the
    feed does not name takes no sales from anywhere else (attach_orders).
    Once the window has closed, drafts and entry drafts no longer count:
    whatever they become is paid after the close. The all-time record when
    the page reads the funnel's units, less its drafts once the window has
    closed, the same rule. `drafts_since` (a catalogue page's first day)
    drops the drafts of a product whose every draft was raised before it:
    a draft left unpaid for months is not a sale in waiting in the last 90
    days (the feed dates a product's latest draft, not each one)."""
    of = load_orders_feed().get(name)
    if source != "orders" or rows is None:
        if not of or not (closed or any(_drafts_before(p, drafts_since) for p in of["products"].values())):
            return of
        shut = {"drafts": 0.0, "winnerDrafts": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0}
        products = {t: ({**p, **shut, **_no_draft_frames(p)} if closed or _drafts_before(p, drafts_since) else p)
                    for t, p in of["products"].items()}
        return {**of, "products": products, "drafts": sum(float(p.get("drafts") or 0.0) for p in products.values()),
                "framing": {**(of.get("framing") or {}),
                            "entrantPrints": sum(float(p.get("entrantPrints") or 0.0) for p in products.values()),
                            "entrantFrames": sum(float(p.get("entrantFrames") or 0.0) for p in products.values())}}
    inside = rows[(rows["event_date"] >= start) & (rows["event_date"] <= end)]
    per = inside.groupby("product_title").agg(units=("units", "sum"), private_room=("private_room", "sum"),
                                               prints=("prints_offered", "sum"), frames=("frames", "sum"))
    base = of or {"products": {}, "draws": {}, "drafts": 0.0, "unitsPaid": 0.0, "asOf": None, "campaignCode": None,
                  "framing": {"prints": 0.0, "frames": 0.0, "notOffered": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0}}
    out = {**base, "products": {}, "drafts": 0.0, "unitsPaid": 0.0, "windowed": True,
           "framing": {"prints": 0.0, "frames": 0.0, "notOffered": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0}}
    titles = list(base["products"]) + [t for t in per.index if t not in base["products"]]
    for t in titles:
        p = dict(base["products"].get(t) or {"drafts": 0.0, "draftCustomers": None, "entryDrafts": 0.0, "entrantDrafts": 0.0,
                                             "winnerDrafts": 0.0, "winnerDraftsLapsed": 0.0, "refunded": 0.0, "fromDrafts": 0.0,
                                             "listPrice": None, "edition": product_editions()(name, t),
                                             "lastOrder": None, "lastDraft": None, "entrantPrints": 0.0, "entrantFrames": 0.0})
        r = per.loc[t] if t in per.index else None
        paid = float(r["units"]) if r is not None else 0.0
        p.update(unitsPaid=paid, privateRoom=float(r["private_room"]) if r is not None else 0.0,
                 printsOffered=float(r["prints"]) if r is not None else 0.0,
                 frames=float(r["frames"]) if r is not None else 0.0)
        if closed or _drafts_before(p, drafts_since):
            p.update(drafts=0.0, winnerDrafts=0.0, entrantPrints=0.0, entrantFrames=0.0, **_no_draft_frames(p))
        out["products"][t] = p
        out["unitsPaid"] += paid
        out["drafts"] += float(p.get("drafts") or 0.0)
        fr = out["framing"]
        fr["prints"] += p["printsOffered"]
        fr["frames"] += p["frames"]
        fr["notOffered"] += max(paid - p["printsOffered"], 0.0)
        fr["entrantPrints"] += float(p.get("entrantPrints") or 0.0)
        fr["entrantFrames"] += float(p.get("entrantFrames") or 0.0)
    out["draws"] = {d: t for d, t in (base.get("draws") or {}).items() if t in out["products"]}
    if base.get("asOf"):
        out["asOf"] = min(base["asOf"], end.isoformat())
    return out


def entry_rate(release: dict) -> float:
    """The entry -> order rate of the release: its own (Target setting) when
    one is typed, else the panel's 0.8. One rate runs through the page: the
    sell-through prediction, the secured-units currency, the paid model's
    converting entries and the targets' eligible entries all read it."""
    v = release.get("entry_conversion_rate")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return BENCH["eligible_entry_to_order"]
    return v if 0 < v <= 1 else BENCH["eligible_entry_to_order"]


def preorder_rate(release: dict) -> float:
    """The rate a PRE-ORDER entry converts at: the card is already
    authorised, so it is charged at the draw rather than invoiced, and the
    panel puts it at 0.95 against 0.8 for a plain entry. The release's own
    (Target setting) wins when one is typed, and a product can override it
    again where its draw has already been run."""
    v = release.get("preorder_conversion_rate")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return BENCH.get("preorder_entry_to_order", 0.95)
    return v if 0 < v <= 1 else BENCH.get("preorder_entry_to_order", 0.95)


FRAMING_MIN_PRINTS = 30   # a launch's frames-per-print rate is a benchmark reading from this many prints on offer
FRAMING_MIN_MEMBERS = 3   # and the basket's median needs this many such launches


def framing_benchmark(basket: dict | None, feed: dict | None = None) -> dict | None:
    """The basket's frames per print: the median over its members' own rates
    in the orders feed (docs/DATA_MODEL.md 6.4), each member read from at
    least FRAMING_MIN_PRINTS prints a frame was on offer for, so a launch
    that sold a handful of prints does not set the reference. None without a
    basket, or with fewer than FRAMING_MIN_MEMBERS members the feed can rate:
    the feed starts at BQ_SINCE, and a basket of older launches has nothing
    to read."""
    members = list((basket or {}).get("members") or [])
    if not members:
        return None
    feed = load_orders_feed() if feed is None else feed
    rates = []
    for m in members:
        f = (feed.get(m) or {}).get("framing") or {}
        if float(f.get("prints") or 0) >= FRAMING_MIN_PRINTS:
            rates.append(float(f["frames"]) / float(f["prints"]))
    if len(rates) < FRAMING_MIN_MEMBERS:
        return None
    return {"rate": round(float(np.median(rates)), 4), "n": len(rates), "of": len(members)}


def framing_block(release: dict, of: dict | None, basket: dict | None, b: dict = BENCH,
                  st: dict | None = None) -> dict | None:
    """The Framing card's figures (docs/DATA_MODEL.md 6.4): frames per print,
    on the prints a frame was on offer for. Buyers: the paid prints and the
    frames bought with them, a frame per print at most (the feed caps an
    order's frames at its prints). Entrants: the same on the app's
    pre-authorisation drafts, the frames the people still in the draw have
    asked for, which is what allocation will bring. The forecast: the two
    together on the units the sell-through counts (framing_forecast), the
    card's headline and the Slack table's figure. Against the plan's rate
    (frame_terms: the release's own frame_conversion, else the benchmark
    default) and the basket's median. Per work, for the hover, with the
    works a frame was never on offer for named apart so their absence from
    the rate is explained. None when nothing has been offered a frame, and
    the card stays off the page."""
    f = (of or {}).get("framing") or {}
    prints, frames = float(f.get("prints") or 0), float(f.get("frames") or 0)
    e_prints, e_frames = float(f.get("entrantPrints") or 0), float(f.get("entrantFrames") or 0)
    if prints <= 0 and e_prints <= 0:
        return None
    conv, _profit = frame_terms(release, b)
    products = (of or {}).get("products") or {}
    works = []
    for title, p in products.items():
        po = float(p.get("printsOffered") or 0)
        if po > 0:
            fr = float(p.get("frames") or 0)
            works.append({"name": title, "prints": int(round(po)), "frames": round(fr, 1), "rate": round(fr / po, 4)})
    works.sort(key=lambda w: (-w["rate"], w["name"]))
    not_offered = sorted(t for t, p in products.items()
                         if float(p.get("unitsPaid") or 0) > 0 and float(p.get("printsOffered") or 0) <= 0)
    return {
        "prints": int(round(prints)), "frames": round(frames, 1),
        "rate": round(frames / prints, 4) if prints > 0 else None,
        "entrants": ({"prints": int(round(e_prints)), "frames": round(e_frames, 1), "rate": round(e_frames / e_prints, 4)}
                     if e_prints > 0 else None),
        "plan": None if release.get("framing_available") is False else round(conv, 4),
        "benchmark": framing_benchmark(basket),
        "works": works,
        "notOffered": {"units": int(round(float(f.get("notOffered") or 0))), "works": not_offered},
        "forecast": framing_forecast(of, st),
        "asOf": (of or {}).get("asOf"),
    }


def _by_name(name: str, names) -> str | None:
    """The one of `names` for a product's name: the same name (case aside),
    else the one name that starts the other where both are four characters or
    more (the draw feed's short titles against the orders feed's long ones);
    None when none or several. server/slack.js matches targets the same way."""
    n = str(name or "").lower()
    exact = [x for x in names if str(x).lower() == n]
    if exact:
        return exact[0] if len(exact) == 1 else None
    if len(n) < 4:
        return None
    near = [x for x in names if len(str(x)) >= 4 and (str(x).lower().startswith(n) or n.startswith(str(x).lower()))]
    return near[0] if len(near) == 1 else None


def framing_forecast(of: dict | None, st: dict | None) -> dict | None:
    """Frames per print on the units the sell-through counts (docs 6.4), so
    the Framing card's headline and the Slack table's framing columns sit on
    the same units as the sell-through beside them: the paid prints and the
    frames bought with them; the drafts awaiting payment and the frames on
    them (a feed without those columns: at the work's buyers' rate); and the
    draw's forecast conversions - at close the entries still to come as well
    - at the rate the entrants ask for on their pre-authorisations, the
    work's own, else the release's. Only the prints a frame is on offer for
    count: the paid and the drafts' own flags, and for the forecast the share
    of the work's pre-authorised prints on offer (else of its paid ones). Per
    sell-through row, through the draw's pairing with the orders feed's
    product (the pairing the sold column follows), else by name; a work
    paired with several rows shares its paid prints by their sold units. A
    row neither can place takes the release's shares and rates. The units of
    the rows left over (no frame on offer) are counted apart, for the card's
    key. Without product rows the release is read as one. Today and at close,
    the page's two horizons, each with its parts (paid, drafts, draw, and at
    close future: prints and frames apiece) for the explainer's working.
    None without the sell-through."""
    if not st or not of:
        return None
    feed = of.get("products") or {}
    f = of.get("framing") or {}
    pairs = of.get("draws") or {}

    def num(v) -> float:
        try:
            return float(v) if v is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    def ratio(a, b):
        return a / b if b and b > 0 else None

    def first(*xs):
        return next((x for x in xs if x is not None), None)

    def clamp(x):
        return min(max(x, 0.0), 1.0)

    rel_draft_p = sum(num(p.get("draftPrints")) for p in feed.values()) if any(p.get("draftPrints") is not None for p in feed.values()) else None
    rel_draft_f = sum(num(p.get("draftFrames")) for p in feed.values())
    rel_drafts = sum(num(p.get("drafts")) for p in feed.values())
    rel_entry = sum(num(p.get("entryDrafts")) for p in feed.values())
    rel_paid = sum(num(p.get("unitsPaid")) for p in feed.values())
    rel = {
        "buy": ratio(num(f.get("frames")), num(f.get("prints"))),
        "ent": ratio(num(f.get("entrantFrames")), num(f.get("entrantPrints"))),
        "draft": ratio(rel_draft_f, rel_draft_p) if rel_draft_p is not None else None,
        "qPaid": ratio(num(f.get("prints")), rel_paid),
        "qPred": first(ratio(num(f.get("entrantPrints")), rel_entry), ratio(num(f.get("prints")), rel_paid)),
        "qDraft": ratio(rel_draft_p, rel_drafts) if rel_draft_p is not None else None,
    }

    def terms(p: dict | None) -> dict:
        """a work's shares on offer and its rates; the release's where the
        work cannot say (no row of the feed, or nothing of that kind yet)"""
        if p is None:
            q_paid, q_pred = first(rel["qPaid"], rel["qPred"], 0.0), first(rel["qPred"], rel["qPaid"], 0.0)
            q_draft = first(rel["qDraft"], q_pred)
            return {"qPaid": clamp(q_paid), "qPred": clamp(q_pred), "qDraft": clamp(q_draft),
                    "buy": first(rel["buy"], rel["ent"]), "draft": first(rel["draft"], rel["buy"], rel["ent"]),
                    "pred": first(rel["ent"], rel["buy"])}
        po, paid = num(p.get("printsOffered")), num(p.get("unitsPaid"))
        ep, ed = num(p.get("entrantPrints")), num(p.get("entryDrafts"))
        dp = p.get("draftPrints")
        buy, ent = ratio(num(p.get("frames")), po), ratio(num(p.get("entrantFrames")), ep)
        draft = ratio(num(p.get("draftFrames")), num(dp)) if dp is not None else None
        offered = po > 0 or ep > 0 or num(dp) > 0
        q_pred = first(ratio(ep, ed), ratio(po, paid), 1.0 if offered else 0.0)
        q_draft = first(ratio(num(dp), num(p.get("drafts"))) if dp is not None else None, q_pred)
        return {"qPaid": clamp(first(ratio(po, paid), q_pred)), "qPred": clamp(q_pred), "qDraft": clamp(q_draft),
                "buy": first(buy, rel["buy"], ent, rel["ent"]),
                "draft": first(draft, buy, rel["draft"], rel["buy"], ent, rel["ent"]),
                "pred": first(ent, rel["ent"], buy, rel["buy"])}

    def part(units, q, rate):
        """prints on offer and their frames for `units` of one kind"""
        prints = max(num(units), 0.0) * q
        return prints, prints * (rate or 0.0)

    rows = st.get("products") or []
    out_rows, totals = [], {"today": [0.0, 0.0, 0.0], "close": [0.0, 0.0, 0.0]}   # prints, frames, units
    # the same totals by kind of unit, so the explainer can show the working:
    # paid (with the sales no work is named for), drafts, the draw's forecast
    # wins, and at close the entries still to come
    kinds = {"today": ("paid", "drafts", "draw"), "close": ("paid", "drafts", "draw", "future")}
    parts = {h: {k: [0.0, 0.0] for k in ks} for h, ks in kinds.items()}

    def add(h, prints, frames, units):
        t = totals[h]
        t[0] += prints
        t[1] += frames
        t[2] += units

    def add_parts(**by_kind):
        for h, ks in kinds.items():
            for k in ks:
                parts[h][k][0] += by_kind[k][0]
                parts[h][k][1] += by_kind[k][1]

    if rows:
        titles = []
        for r in rows:
            title = next((pairs[d] for d in [r.get("key"), *(r.get("draws") or [])] if d in pairs and pairs[d] in feed), None)
            titles.append(title if title is not None else _by_name(r.get("name"), list(feed)))
        sold_by_title: dict = {}
        for r, t in zip(rows, titles):
            if t is not None:
                sold_by_title[t] = sold_by_title.get(t, 0.0) + num(r.get("sold"))
        rows_by_title = {t: titles.count(t) for t in set(titles) if t is not None}
        for r, t in zip(rows, titles):
            p = feed.get(t) if t is not None else None
            k = terms(p)
            if p is not None:
                share = ratio(num(r.get("sold")), sold_by_title[t]) if sold_by_title[t] > 0 else 1.0 / rows_by_title[t]
                paid = (num(p.get("printsOffered")) * share, num(p.get("frames")) * share)
            else:
                paid = part(r.get("sold"), k["qPaid"], k["buy"])
            assumed = part(r.get("soldAssumed"), k["qPaid"], k["buy"])
            drafts = part(r.get("drafts"), k["qDraft"], k["draft"])
            pred = part(r.get("shown"), k["qPred"], k["pred"])
            future = part(r.get("futurePredicted"), k["qPred"], k["pred"])
            units_today = num(r.get("sold")) + num(r.get("soldAssumed")) + num(r.get("drafts")) + num(r.get("shown"))
            today = [paid[0] + assumed[0] + drafts[0] + pred[0], paid[1] + assumed[1] + drafts[1] + pred[1]]
            close = [today[0] + future[0], today[1] + future[1]]
            add("today", *today, units_today)
            add("close", *close, units_today + num(r.get("futurePredicted")))
            add_parts(paid=(paid[0] + assumed[0], paid[1] + assumed[1]), drafts=drafts, draw=pred, future=future)
            if close[0] > 0:
                out_rows.append({"key": r.get("key"), "name": r.get("name"),
                                 "today": {"prints": round(today[0], 1), "frames": round(today[1], 1),
                                           "rate": round(today[1] / today[0], 4) if today[0] > 0 else None},
                                 "close": {"prints": round(close[0], 1), "frames": round(close[1], 1),
                                           "rate": round(close[1] / close[0], 4) if close[0] > 0 else None}})
    else:
        k = terms(None)
        paid = (num(f.get("prints")), num(f.get("frames")))
        unpaid_paid = part(max(num(st.get("sold")) - rel_paid, 0.0), k["qPaid"], k["buy"])   # sold the orders do not carry
        drafts = part(st.get("drafts"), k["qDraft"], k["draft"])
        pred = part(st.get("soldPredicted"), k["qPred"], k["pred"])
        future = part(st.get("futureEntriesPredicted"), k["qPred"], k["pred"])
        units_today = num(st.get("sold")) + num(st.get("drafts")) + num(st.get("soldPredicted"))
        today = [paid[0] + unpaid_paid[0] + drafts[0] + pred[0], paid[1] + unpaid_paid[1] + drafts[1] + pred[1]]
        add("today", *today, units_today)
        add("close", today[0] + future[0], today[1] + future[1], units_today + num(st.get("futureEntriesPredicted")))
        add_parts(paid=(paid[0] + unpaid_paid[0], paid[1] + unpaid_paid[1]), drafts=drafts, draw=pred, future=future)

    def horizon(h):
        prints, frames, units = totals[h]
        return {"prints": round(prints, 1), "frames": round(frames, 1),
                "rate": round(frames / prints, 4) if prints > 0 else None,
                "notOffered": round(max(units - prints, 0.0), 1),
                "parts": {k: {"prints": round(p, 1), "frames": round(f, 1)} for k, (p, f) in parts[h].items()}}
    return {"today": horizon("today"), "close": horizon("close"), "products": out_rows}


def edition_total(release: dict):
    """The physical edition: `edition_total` when the target (`edition_size`)
    is only part of it (Warhol: a 2,440 target on a 6,100 edition), else the
    target itself. Caps, room and sell-through read against this; the targets
    and the benchmark uplift read against edition_size."""
    size = release.get("edition_size")
    if size is None:
        return None
    try:
        total = float(release.get("edition_total") or 0)
    except (TypeError, ValueError):
        total = 0.0
    if total > float(size):
        return int(total) if total.is_integer() else total
    return size


def entries_in_hand(patterns: list, draws: list, since: date) -> list:
    """The entry patterns less the draws that ended before `since` (docs
    6.3). A catalogue page counts its last 90 days, and a draw whose last
    entry came before them was allocated long ago: its losers are not in
    hand, nor are its unpaid wins. Their ids leave every list of every
    pattern (a purchase through one stays in the buyer's `bought`, their own
    history), and a pattern left with no draw goes, so a page whose draws
    all ended earlier reads no patterns, as a closed page does. A draw with
    no readable last day stays."""
    stale = set()
    for d in draws or []:
        try:
            if date.fromisoformat(str(d.get("last"))[:10]) < since:
                stale.add(str(d.get("id")))
        except (AttributeError, TypeError, ValueError):
            continue
    if not stale:
        return patterns
    out = []
    for p in patterns:
        q = {**p, **{k: [x for x in (p.get(k) or []) if str(x) not in stale] for k in ("open", "won", "sold", "pre")}}
        if q["open"] or q["won"] or q["sold"]:
            out.append(q)
    return out


def sellthrough_block(release: dict, name: str, units_sold: float, unconverted: float, inventory_left,
                      future_entries: float = 0.0, expected_today=None, bm_today=None, bm_close=None,
                      orders=..., closed: bool = False, entries_since: date | None = None) -> dict:
    """The snapshot's `sellthrough`: the release-level prediction as before,
    and - where the event feed has the release's draws - the per-product
    block: products from the draws and what was typed for them, the entries
    in hand allocated by the max-quantity rule, sold units the feed can
    attribute, and the shares. With products the headline figures
    (soldPredicted, futureEntriesPredicted, pct) are the per-product
    calculation summed, so the card's rows and its headline are one sum.

    `orders` is the orders record the page reads (orders_in_window: cut to
    the days the page counts), the all-time record when left out. `closed`
    says the window has shut (two days past the close): nothing in hand and
    nothing still to come counts any more, only what was paid in it.
    `entries_since` (a catalogue page's first day) leaves out the entries of
    draws that ended before it (entries_in_hand)."""
    if closed:
        unconverted, future_entries = 0.0, 0.0
    rate = entry_rate(release)
    pre_rate = preorder_rate(release)
    edition = edition_total(release)   # the whole edition: room and shares read against it
    sold_predicted = unconverted * rate
    # inHandUnits is the entries in hand before the rate, so the prediction can
    # be re-read at another rate without the funnel
    st: dict = {"edition": edition, "sold": round(units_sold, 0), "conversion": rate,
                "preorderConversion": pre_rate, "inHandUnits": round(unconverted, 1)}
    feed = load_products_feed().get(name)
    of = load_orders_feed().get(name) if orders is ... else orders
    if of:
        # what the orders say for the whole release, draws or no draws: the
        # draft orders awaiting payment, the units paid, and the day they run to
        st["drafts"] = round(of["drafts"], 1)
        st["unitsPaidOrders"] = round(of["unitsPaid"], 1)
        st["ordersAsOf"] = of["asOf"]
    if edition:
        # drafts take their room before the prediction does, as per product
        room = max(inventory_left - float(st.get("drafts") or 0), 0)
        st["soldPredicted"] = round(min(sold_predicted, room), 1)
        st["futureEntriesPredicted"] = round(min(future_entries, max(room - sold_predicted, 0)), 1)
    else:
        st["soldPredicted"] = round(sold_predicted, 1)
        st["futureEntriesPredicted"] = None
    close_headline(st)
    if bm_close is not None:
        st["benchmarkUnits"] = round(bm_close, 1)
    if not feed or not feed.get("draws"):
        st["incomplete"] = ["products"]
        return st
    # a draw the orders feed pairs with a product is named by it unless a
    # name was typed against its draw id (products_from_draws, attach_orders)
    products, source = products_from_draws(feed["draws"], draw_products_typed(release), edition,
                                           (of or {}).get("draws"))
    if of:
        products, source = attach_orders(products, of["products"], of["draws"], source,
                                         orders_only=bool(of.get("windowed")))
    # claims a draw round has made that the order table has not caught up
    # with: counted on their product at the pre-order rate until the orders
    # land, so claiming pre-orders never reads as sell-through going down
    claims = draw_claims()
    for p in products:
        n = sum(claims.get(str(d), 0) for d in (p.get("draws") or []))
        if n > 0:
            p["claimsInFlight"] = n
    # once the window has shut, no entry is still in hand: only what was paid counts
    patterns = [] if closed else (feed.get("patterns") or [])
    if patterns and entries_since is not None:
        patterns = entries_in_hand(patterns, feed["draws"], entries_since)
    pp = sell_through_products(products, patterns, rate=rate, edition=edition,
                               sold_total=units_sold, future_units=future_entries, expected_today=expected_today,
                               benchmark_today=bm_today, benchmark_close=bm_close, preorder_rate=pre_rate)
    st.update({k: pp[k] for k in ("products", "attributedSold", "unattributedSold", "allocation", "measure",
                                  "editionSum", "editionMismatch")})
    st["soldSource"] = source
    st["allocationStarted"] = bool(feed.get("allocated"))
    st["claimsInFlight"] = sum(int(p.get("claimsInFlight") or 0) for p in products)
    if of and pp.get("drafts") is not None:
        st["drafts"] = pp["drafts"]   # the products' drafts, counted per collector and capped at their room
    # what the card is still waiting on, so it can say so: sales by product
    # (until every draw is named by the orders feed, the sales the draw cannot
    # name are split by edition size) and draft orders. The card stamps itself
    # "Incomplete data" while this list is not empty.
    st["incomplete"] = ([] if source in ("purchases", "orders") else ["sales by product"]) + \
        (["draft orders"] if any(p.get("drafts") is None for p in products) else [])
    # the draws, patterns and orders ride along so the rule can be re-run
    # without the feeds (shared/sellThrough.mjs, tests/sellthrough_parity.mjs)
    st["draws"] = feed["draws"]
    st["patterns"] = patterns
    if of:
        st["ordersByProduct"] = of["products"]
        st["drawProducts"] = of["draws"]
    # Paid is what the rows add up to: the page's units sold, or the products'
    # own paid units where those are more (a page on the funnel's units whose
    # products read the orders feed). One figure, so the card's Paid key, its
    # close percentage and the hero cannot part (docs 6.3)
    st["sold"] = round(max(float(units_sold), float(pp.get("attributedSold") or 0)), 0)
    if edition:
        st["soldPredicted"] = pp["soldPredicted"]
        st["futureEntriesPredicted"] = pp["futureEntriesPredicted"]
    else:
        st["soldPredicted"] = pp["soldPredicted"]
    close_headline(st)
    return st


def close_headline(st: dict) -> None:
    """The sell-through's percentage of the edition at close, from the very
    parts the hero adds up (spoken_for plus the units still to come, docs
    6.3½): the card's headline and the hero's projection are one sum, capped
    at the edition alike. None without an edition."""
    ed = st.get("edition")
    if not ed:
        st["pct"] = None
        return
    parts = spoken_for(st) + float(st.get("futureEntriesPredicted") or 0)
    st["pct"] = round(min(parts / float(ed), 1.0), 4)


def spoken_for(st: dict) -> float:
    """The sell-through's own count of what is spoken for today (docs 6.3):
    units paid, the drafts raised and not yet paid, and the winners the
    entries in hand imply at the release's entry rate - the figure its card
    prints, and the one the hero adopts."""
    return (float(st.get("sold") or 0) + float(st.get("drafts") or 0) + float(st.get("soldPredicted") or 0))


def adopt_sellthrough(st: dict, channels_out: list, funnel_by_group: dict, hero_now: float, hero_proj: float,
                      complete: bool, upb_plan: float = 1.0, upb_actual: float = 1.0) -> tuple[float, float]:
    """The hero adopts the sell-through's count (docs 6.3½) and the funnel's
    channels are scaled to it, so the channels, the trajectory, the funnel
    and the waterfalls still sum to the hero.

    Each paid unit is already on its own order's channel (swap_units), and
    the funnel puts entries on channels; drafts and the per-product
    allocation have no channel of their own, so the difference between the
    sell-through's count and the channels' secured units is spread over the
    channels in proportion to their secured units (one factor f on every
    actual). Once the window has shut the count is the units paid alone and
    the build has already taken the entries off every channel, so f is 1
    and each channel reads its own units paid; a count of nothing takes
    every channel to nothing rather than leaving the funnel's figure
    standing. The units still to come keep the
    funnel's shape and are capped at the room left, as the sell-through
    caps them (one factor g on every remaining projection). The funnel
    decomposition is re-priced by the same factor, so each group's traffic
    and conversion steps still sum to its now minus its expected.
    With nothing on the channels to scale (no units paid and no entries
    yet, but drafts out or the draw's patterns counted), the count is added
    instead, on the channels' sessions to date, or on Search / direct /
    other when there are none.
    Returns the hero's (now, projected) before the sellout cap."""
    sell_today = spoken_for(st)
    future_funnel = max(hero_proj - hero_now, 0.0)
    fut = st.get("futureEntriesPredicted")
    future_all = 0.0 if complete else (float(fut) if fut is not None else future_funnel)
    g = (future_all / future_funnel) if future_funnel > 0 else 0.0
    ratio = (upb_plan / upb_actual) if upb_actual else 1.0
    if not (hero_now > 0):
        if not channels_out:
            return sell_today, sell_today + future_all
        sess = {c.get("key"): float((funnel_by_group.get(c.get("key")) or {}).get("sessions_actual") or 0.0)
                for c in channels_out}
        if sum(sess.values()) <= 0:
            sess = {k: (1.0 if k == "search_direct_other" else 0.0) for k in sess}
            if sum(sess.values()) <= 0:
                sess = {k: 1.0 for k in sess}
        tot = sum(sess.values())
        for c in channels_out:
            now0 = float(c.get("now") or 0)
            proj0 = float(c["proj"]) if c.get("proj") is not None else now0
            now1 = now0 + sell_today * sess[c.get("key")] / tot
            delta = now1 - now0
            acts = [r for r in (c.get("daily") or []) if r.get("actual") is not None]
            if acts:
                acts[-1]["actual"] = round(acts[-1]["actual"] + delta, 2)
            for r in c.get("daily") or []:
                if r.get("proj") is not None:
                    r["proj"] = round(now1 + max(r["proj"] - now0, 0.0) * g, 2)
            if delta > 0.05:
                c.setdefault("parts", []).append({"name": "Not yet paid", "value": round(delta, 1)})
            c["now"] = round(now1, 1)
            if c.get("proj") is not None:
                c["proj"] = round(now1 + max(proj0 - now0, 0.0) * g, 1)
            fb = funnel_by_group.get(c.get("key"))
            if fb:
                s_act = float(fb.get("sessions_actual") or 0.0)
                if fb.get("conv_actual") is not None:
                    fb["conv_actual"] = (now1 / s_act) if s_act else 0.0
                if fb.get("bps_actual") is not None:
                    fb["bps_actual"] = (fb["conv_actual"] / upb_actual) if upb_actual else 0.0
                for k, add in (("contrib_conversion", delta), ("contrib_buyers", delta * ratio),
                               ("contrib_conversion_bm", delta), ("contrib_buyers_bm", delta * ratio)):
                    if fb.get(k) is not None:
                        fb[k] = round(fb[k] + add, 1)
                for k in ("contrib_per_buyer", "contrib_per_buyer_bm"):
                    if fb.get(k) is not None:
                        fb[k] = round(now1 * (1.0 - ratio), 1)
        return sell_today, sell_today + future_all
    f = sell_today / hero_now
    for c in channels_out:
        now0 = float(c.get("now") or 0)
        proj0 = float(c["proj"]) if c.get("proj") is not None else now0
        now1 = now0 * f
        proj1 = now1 + max(proj0 - now0, 0.0) * g
        for r in c.get("daily") or []:
            if r.get("actual") is not None:
                r["actual"] = round(r["actual"] * f, 2)
            if r.get("proj") is not None:
                r["proj"] = round(now1 + max(r["proj"] - now0, 0.0) * g, 2)
        for p in c.get("parts") or []:
            p["value"] = round(p["value"] * f, 1)
        c["now"] = round(now1, 1)
        if c.get("proj") is not None:
            c["proj"] = round(proj1, 1)
        fb = funnel_by_group.get(c.get("key"))
        if fb:
            for k in ("conv_actual", "bps_actual"):
                if fb.get(k) is not None:
                    fb[k] = fb[k] * f
            for k, add in (("contrib_conversion", (f - 1) * now0), ("contrib_buyers", (f - 1) * now0 * ratio),
                           ("contrib_conversion_bm", (f - 1) * now0), ("contrib_buyers_bm", (f - 1) * now0 * ratio)):
                if fb.get(k) is not None:
                    fb[k] = round(fb[k] + add, 1)
            for k in ("contrib_per_buyer", "contrib_per_buyer_bm"):
                if fb.get(k) is not None:
                    fb[k] = round(fb[k] * f, 1)
    return sell_today, sell_today + future_all


# ---------------------------------------------------------------- per-release snapshot

def daterange(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def whole(x: float) -> float:
    """A benchmark in whole units as the page rounds it: from the one-decimal
    figure the snapshot publishes (benchmark.units), a half away from zero, as
    fmt does in the browser. Python's round() takes a half to the even number
    (132.5 -> 132) and reads a float's own noise (217.49999... -> 217), which
    put a benchmark of 132 on the hero beside a median of 133 in its working."""
    v = round(float(x), 1)
    w = float(math.floor(abs(v) + 0.5))
    return -w if v < 0 and w else w


# The at-close waterfall scales the walk to date by the close gap over the
# to-date gap (docs §9). Below this to-date gap the ratio is rounding, not a
# reading, and above this factor the walk to date is too small a base to
# scale: either way the rest of the gap is shared out by size instead.
WF_CLOSE_MIN_GAP = 0.5
WF_CLOSE_SCALE_MAX = 3.0


def close_walk(raw: list[float], gap_today: float, gap_close: float) -> tuple[list[float], float | None]:
    """The waterfall's contributors at close from the same contributors to
    date (docs §9), for a release still live: each scaled by one factor, the
    close gap over the to-date gap (both unrounded: the contributors of each
    group add up to its actual less its reference by construction), so they
    keep their proportions and add up to the projection's gap.

    A factor off a to-date gap under WF_CLOSE_MIN_GAP is a ratio of rounding
    (a release sitting on its pace drew bars of a billion units), and one that
    is negative or above WF_CLOSE_SCALE_MAX flips every contributor's sign or
    blows offsetting ones up. There the part of the close gap still to come
    is shared over the contributors in proportion to their size to date:
    where they all point the same way that is the same walk as the factor's.
    Returns the unrounded values and the factor, None when shared out."""
    raw = [float(v) for v in raw]
    if abs(gap_today) >= WF_CLOSE_MIN_GAP:
        scale = gap_close / gap_today
        if 0.0 <= scale <= WF_CLOSE_SCALE_MAX:
            return [v * scale for v in raw], scale
    size = sum(abs(v) for v in raw)
    if size <= 0:
        return raw, None          # nothing to date to share it by: the walk's rounding step places it
    rest = gap_close - sum(raw)
    return [v + rest * abs(v) / size for v in raw], None


WF_STEPS = [("organic_traffic", "Organic traffic"), ("organic_conversion", "Organic conversion"),
            ("paid_spend", "Paid spend"), ("paid_efficiency", "Paid efficiency")]


def settle_steps(vals: list[float], gap: float) -> list[dict]:
    """The waterfall's four steps in whole units, adding up exactly to the gap
    the card prints (the rounded pair, not the raw difference: rounding each
    end separately can move it by a unit), the rounding residual parked on the
    largest step."""
    steps = [{"key": k, "label": l, "value": round(v, 0)} for (k, l), v in zip(WF_STEPS, vals)]
    max(steps, key=lambda s: abs(s["value"]))["value"] += gap - sum(s["value"] for s in steps)
    return steps


def waterfall_walks(raw: list[float], gap_today: float, gap_close: float,
                    shown_today: float, shown_close: float, complete: bool) -> tuple[list[dict], list[dict], float | None]:
    """One reference's walks (docs §9): the contributors to date (`raw`, whose
    unrounded total is `gap_today`) as steps adding up to `shown_today`, and
    the same at close adding up to `shown_close`. A closed release has nothing
    left to project (its projection is its actual, its reference by today its
    reference), so its walk at close is its walk to date, copied: rescaling
    it by the ratio of two equal gaps made of rounded parts moved bars by a
    unit between the horizons, and on a release that closed on target divided
    rounding by rounding (steps of a billion units). A live release's walk is
    scaled to its projection (close_walk). Returns (today, close, factor), the
    factor None when copied or shared out."""
    today = settle_steps(raw, shown_today)
    if complete:
        return today, settle_steps([s["value"] for s in today], shown_close), None
    vals, scale = close_walk(raw, gap_today, gap_close)
    return today, settle_steps(vals, shown_close), scale


# ---------------------------------------------------------------- every release

_QUARTER_RE = re.compile(r"^(\d{4}) Q([1-4])$")
_CODE_RE = re.compile(r"^([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d{2})$")


ID_MAX_CHARS = 120   # an id names the page's file (data/app/derived/<id>.json) and a file name holds 255 bytes


def slugify(name: str) -> str:
    """Release name -> id the server will accept ([a-z0-9_]), at most
    ID_MAX_CHARS long, cut at a word. The id names the page's file, and a
    name long enough to overrun a file name (an upcoming launch titled with
    its dozen works) stopped the whole build with "File name too long" rather
    than that one page, so every refresh failed and the header read stale."""
    slug = re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", name.lower())).strip("_")
    if len(slug) > ID_MAX_CHARS:
        head = slug[:ID_MAX_CHARS]
        slug = head.rsplit("_", 1)[0] if "_" in head else head
    return slug.strip("_")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def known_codes(emails: pd.DataFrame, content: pd.DataFrame, artist_posts: pd.DataFrame | None) -> set[str]:
    """Campaign codes the other feeds use (AntonyMic_LE_26, CindySher_TL_25...)."""
    out = set(INPUTS_CODES)
    for col, frame in (("campaign", emails), ("campaign_code", content), ("campaign_code", artist_posts)):
        if frame is not None and col in frame.columns:
            out.update(str(v) for v in frame[col].dropna().unique())
    return {c for c in out if _CODE_RE.match(c)}


def code_activity(spend: pd.DataFrame | None, emails: pd.DataFrame | None) -> dict[str, tuple[date, date]]:
    """When each campaign code was active: the first and last day it spent on
    Meta or sent an email. A launch the funnel has not seen yet is matched to
    a code by this, not by the artist's name alone: an artist's earlier code
    is still on file, and only the code moving in the launch's own window
    can be the launch's."""
    lo: dict[str, date] = {}
    hi: dict[str, date] = {}

    def take(code: str, day) -> None:
        if not _CODE_RE.match(code) or pd.isna(day):
            return
        d = pd.Timestamp(day).date()
        lo[code] = min(lo.get(code, d), d)
        hi[code] = max(hi.get(code, d), d)

    if spend is not None and {"campaign_name", "spend_date"} <= set(spend.columns):
        # the days it spent: the Meta export keeps sending a campaign's rows,
        # at zero, for about four weeks after it stops
        spent = spend[pd.to_numeric(spend["spend"], errors="coerce") > 0] if "spend" in spend.columns else spend
        for name, day in zip(spent["campaign_name"], spent["spend_date"]):
            if isinstance(name, str):
                take(name.split(" · ")[0].strip(), day)
    if emails is not None and {"campaign", "sent_at"} <= set(emails.columns):
        for code, day in zip(emails["campaign"], emails["sent_at"]):
            if isinstance(code, str):
                take(code.strip(), day)
    return {c: (lo[c], hi[c]) for c in lo}


def guess_code(artist: str, title: str, year: int, codes: set[str], siblings: int = 1) -> str | None:
    """Best guess at the campaign code for a release nobody has configured, from
    the codes the email / content feeds already use. The code's first segment
    is a truncated artist name (AntonyMic, CindySher, Albers), the last is the
    two-digit year. Ambiguous -> None rather than a wrong match: a wrong code
    silently attributes another campaign's emails.

    The middle segment is NOT a release type. It is whatever the person who
    tagged the feed typed (LE, TL, PE, Print, Timed, Limited, a work's name),
    and it is wrong often enough to matter: the content feed tags Andy
    Warhol's 2026 LE as AndyWarhol_TL_26. Every release in this export is an
    LE by construction of the export; the type comes from there."""
    a, t, yy = _norm(artist), _norm(title), f"{year % 100:02d}"
    cands = []
    for c in codes:
        m = _CODE_RE.match(c)
        stub, mid, y = m.group(1).lower(), m.group(2), m.group(3)
        if y != yy or len(stub) < 4:
            continue
        if not (a.startswith(stub) or (len(stub) >= 5 and stub in a)):
            continue
        cands.append((c, mid))
    if not cands:
        return None
    # a code whose middle names the work wins (AiWeiwei_SelfPortrait_26 for
    # "Ai Weiwei · Self Portrait · 2026 Q2")
    named = [c for c, mid in cands if len(_norm(mid)) >= 4 and _norm(mid) in t]
    if len(named) == 1:
        return named[0]
    # one code, one release from this artist that year: they are the same thing.
    # With two releases in the year a lone code could belong to either.
    if len(cands) == 1 and siblings == 1:
        return cands[0][0]
    les = [c for c, mid in cands if mid.upper() == "LE"]
    if len(les) == 1 and t == "multiple":
        return les[0]
    return None


def orders_codes() -> dict[str, list[str]]:
    """Release name -> the campaign codes its rows carry in the orders feed
    (data/orders_by_product.csv campaign_code: the campaign its own order
    lines were sold under), each once. Empty without the file."""
    p = DATA / "orders_by_product.csv"
    if not p.exists():
        return {}
    try:
        df = pd.read_csv(p, usecols=["release", "campaign_code"], dtype=str).fillna("")
    except (OSError, ValueError) as e:
        print(f"warning: ignoring {p.name} for campaign codes: {e}")
        return {}
    out: dict[str, list[str]] = {}
    for rel, code in zip(df["release"], df["campaign_code"].str.strip()):
        if rel and code and code not in out.setdefault(rel, []):
            out[rel].append(code)
    return out


def source_campaign_codes(records: list[dict], codes: set[str], launch_frame: pd.DataFrame | None,
                          spend: pd.DataFrame | None, orders: dict[str, list[str]] | None = None) -> list[tuple]:
    """Each funnel release's campaign code from its own feeds, before the
    guess (docs 11b): the code the orders feed gives it, else the release
    code of the Airtable launch it matched, taken when exactly one code the
    feeds use (the sends, the posts, the release inputs, Meta's campaign
    names) is that code - in the feed's spelling, so Kai_Content_24 on the
    orders joins the sends tagged KAI_CONTENT_24. guess_code rejects a code
    whose year is the planning year (JeffKoons_LE_25 on a 2026 Q1 launch), a
    short stub (LY_LE_26) or one not in the artist's name (PietParra), so
    30-odd pages had no code while their orders named it.

    A code the orders feed gives several releases, or an Airtable launch
    several releases matched, is a group show's (the eight Amphora releases
    under Multiple_Amphorae_24) and nobody's: its sends and spend would count
    on every page. So is a code a configured release carries. A guess that
    names another code than the sourced one is kept and said: one release can
    be tagged two ways (Eddie Martinez's Scaffold, EDDIE_SCAFFOLD_24 on its
    sends and EddieMart_Scaffold_24 on its orders and Meta), and the guess is
    the one joining sends today. Sets campaign_code and code_source
    ('orders', 'airtable', 'guess' or None) on every record; returns
    (id, code, source) for each code it set."""
    orders = orders_codes() if orders is None else orders
    feed = {c for c in codes if _CODE_RE.match(str(c))}
    if spend is not None and "campaign_name" in spend.columns:
        feed |= {p for p in (str(n).split(" · ")[0].strip() for n in spend["campaign_name"].dropna()) if _CODE_RE.match(p)}
    spelt: dict[str, set] = {}
    for c in feed:
        spelt.setdefault(_norm(c), set()).add(c)

    def in_feeds(cand: str) -> str | None:
        if cand in feed:
            return cand
        got = spelt.get(_norm(cand)) or set()
        return next(iter(got)) if len(got) == 1 else None

    # the Airtable launch each release matched (etl/pricing.py), by its release code
    at: dict[str, list[str]] = {}
    if launch_frame is not None and len(launch_frame) and records:
        try:
            frame = _frame_of_releases(records)
            for n, c in zip(frame["release_name"], pricing.match(frame, launch_frame)["airtable_release"]):
                if isinstance(c, str) and c.strip():
                    at[n] = [x.strip() for x in c.split("+") if x.strip()]
        except Exception as e:  # noqa: BLE001 - the orders' codes still stand; the refresh must not stop here
            print(f"warning: campaign codes: the Airtable launches could not be matched ({e})")
    users = {"orders": collections.Counter(_norm(c) for cs in orders.values() for c in set(cs)),
             "airtable": collections.Counter(_norm(c) for cs in at.values() for c in set(cs))}
    configured = {_norm(r["campaign_code"]): r["release_name"] for r in INPUTS["releases"] if r.get("campaign_code")}

    def pick(name: str, cands: list[str]) -> str | None:
        # a group show's code, whichever feed proposes it: shared on the
        # orders, or a launch several releases matched
        if any(users["orders"][_norm(c)] > 1 or users["airtable"][_norm(c)] > 1 for c in cands):
            return None
        hits = {f for f in (in_feeds(c) for c in cands) if f}
        if len(hits) != 1:
            return None
        code = hits.pop()
        return code if configured.get(_norm(code), name) == name else None

    set_codes = []
    for r in records:
        name, guess = r["release_name"], r.get("campaign_code")
        code = src = None
        if len(orders.get(name) or []) == 1:
            code, src = pick(name, orders[name]), "orders"
        if code is None and at.get(name):
            code, src = pick(name, at[name]), "airtable"
        if code is None:
            r["code_source"] = "guess" if guess else None
            continue
        if guess and _norm(guess) != _norm(code):
            print(f"{r['id']}: campaign code {guess} (guessed) kept - the {src} feed gives {code}; type the one it runs under")
            r["code_source"] = "guess"
            continue
        r["campaign_code"], r["code_source"] = guess or code, src   # a guess spelt the feed's way keeps its spelling
        if not guess:
            set_codes.append((r["id"], code, src))
    return set_codes


def unclaimed_draw_campaigns(spend: pd.DataFrame | None, records: list[dict],
                             orders: dict[str, list[str]] | None = None) -> list[str]:
    """A build warning for each Meta draw campaign ("<code> · Enter draw",
    "<code> · Draw ...") whose code the orders feed gives exactly one release
    on file, when no page claims it: a configured release's campaigns, or a
    discovered page's matched campaign. Its spend is then on no page (EUR
    148k of it on 24 September 2026, before codes came from the orders
    feed). Printed and returned."""
    if spend is None or spend.empty or not {"campaign_name", "spend"} <= set(spend.columns):
        return []
    orders = orders_codes() if orders is None else orders
    by_code: dict[str, set] = {}
    for rel, cs in orders.items():
        for c in cs:
            by_code.setdefault(c, set()).add(rel)
    on_file = {r["release_name"] for r in records} | {r["release_name"] for r in INPUTS["releases"]}
    claimed = {r.get("campaign_name") for r in records} | {r.get("campaign_name") for r in INPUTS["releases"]}
    for r in INPUTS["releases"]:
        claimed.update(r.get("campaign_names") or [])
    out = []
    for camp, total in spend.groupby("campaign_name")["spend"].sum().items():
        parts = str(camp).split(" · ", 1)
        rel = by_code.get(parts[0].strip()) or set()
        if len(parts) < 2 or "draw" not in parts[1].lower() or len(rel) != 1 or camp in claimed:
            continue
        (release,) = rel
        if release in on_file:
            out.append(f"warning: Meta draw campaign {camp!r} (EUR {float(total):,.0f}) is the orders feed's code "
                       f"for {release!r} alone, and no page claims it")
            print(out[-1])
    return out


# ---------------------------------------------------------------- release inputs (docs §1.6)

# the release-level economics as they were typed before the model went per
# product (edition, price, profits, framing): read as the fallback for a
# release that still carries them, under legacy_economics or at the top level
# of inputs saved before the block existed
LEGACY_KEYS = ("edition_size", "edition_total", "unit_price", "artist_profit", "aa_group_profit",
               "artist_profit_share", "framing_available", "frame_conversion", "frame_profit_per_unit",
               "aa_budget_share")
# a product's figures, typed on the Target setting tab over what Airtable holds
PRODUCT_KEYS = ("units_target", "edition", "target_sellthrough", "unit_price", "currency", "artist_profit_per_unit",
                "aa_profit_per_unit", "aa_revenue_share", "aa_profit_share", "framing_available",
                "frame_conversion", "frame_profit_per_unit")


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def notion_dates_for(notion: dict | None, code: str | None, release_name: str | None) -> dict:
    """The Notion log's dates for a release: by its campaign code, else by its
    name - an upcoming launch has a page and a log before it has a code."""
    n = notion or {}
    by_code = n.get(str(code)) if code else None
    by_name = n.get("name:" + str(release_name)) if release_name else None
    return dict(by_code or by_name or {})


def load_notion_campaigns() -> dict:
    """Campaign dates from the Notion log (server/notion.js writes
    data/notion_campaigns.csv on every refresh): per campaign code, the day
    of the early-access email (the private room opening), the announce and
    the launch. Empty until a NOTION_TOKEN is configured."""
    p = DATA / "notion_campaigns.csv"
    if not p.exists():
        return {}
    try:
        df = pd.read_csv(p, dtype=str).fillna("")
    except Exception as e:  # noqa: BLE001 - a broken feed must not stop the build
        print(f"warning: ignoring {p.name}: {e}")
        return {}
    out = {}
    for r in df.to_dict("records"):
        code = str(r.get("campaign_code") or "").strip()
        name = str(r.get("release_name") or "").strip()
        vals = {k: (str(r.get(k) or "")[:10] or None) for k in ("private_room_open", "announce_date", "launch_end")}
        # keyed by the campaign code and by the release name, so a launch
        # without a code yet (notion_dates_for) is still found
        if code:
            out[code] = vals
        if name:
            out["name:" + name] = vals
    return out


def match_campaigns(code: str | None, spend: pd.DataFrame) -> list[str]:
    """Every Meta campaign in the spend feed named for a code, the draw
    campaign first (the one match_campaign picks), then the rest by spend."""
    if not code:
        return []
    first = match_campaign(code, spend)
    by = spend.groupby("campaign_name")["spend"].sum()
    names = [n for n in by.index if str(n).startswith(f"{code} · ")]
    names.sort(key=lambda n: (n != first, -float(by[n])))
    return names


def _merge_products(airtable: list[dict], typed: list) -> list[dict]:
    """Airtable's products with the typed figures laid over them, matched by
    Airtable id, then by name; a typed product Airtable has no record for is
    kept as a product of its own. Draw-keyed entries (the sell-through card's
    names and rates, keyed by a draw id) are not products here."""
    out = [dict(p, source="airtable", typed={}) for p in airtable]
    by_id = {p["airtable_id"]: p for p in out if p.get("airtable_id")}
    by_name = {_norm(p["name"]): p for p in out if p.get("name")}
    for t in typed or []:
        if not isinstance(t, dict) or not (t.get("airtable_id") or t.get("manual")):
            continue     # a draw's name or rate (the sell-through card's), not a product here
        keys = {k: t[k] for k in PRODUCT_KEYS if k in t and t[k] not in (None, "")}
        if t.get("name"):
            keys["name"] = str(t["name"]).strip()
        target = by_id.get(str(t.get("airtable_id") or "")) if t.get("airtable_id") else None
        if target is None and t.get("manual"):
            target = by_name.get(_norm(t.get("name") or ""))
        if target is None:
            if t.get("airtable_id") and not t.get("manual"):
                continue     # typed against a record Airtable no longer lists for this release
            target = {"airtable_id": None, "name": keys.get("name") or "Product", "source": "typed", "typed": {}}
            out.append(target)
            if keys.get("name"):
                by_name[_norm(keys["name"])] = target
        # the tick (docs 1.6): unticked on the tab, the work stays on the grid
        # with its typed figures and counts nothing
        if t.get("excluded") is True:
            target["excluded"] = True
        target["typed"].update(keys)
    return out


def draw_products_typed(release: dict) -> list:
    """The typed product entries the sell-through card reads - a draw's name,
    edition and pre-order rate, keyed by its draw id - without the economics
    products (Airtable-matched or added by hand) that live in the same list."""
    typed = release.get("products") if isinstance(release.get("products"), list) else []
    return [t for t in typed if isinstance(t, dict) and not t.get("airtable_id") and not t.get("manual")]


def _effective_product(p: dict, b: dict) -> dict:
    """One product's figures in force: typed over Airtable over the defaults,
    with where each came from."""
    typed = p.get("typed") or {}
    src: dict = {}

    def pick(key, at_key=None, default=None, kind="default"):
        if key in typed:
            src[key] = "typed"
            return typed[key]
        v = p.get(at_key or key)
        if v not in (None, ""):
            src[key] = "airtable"
            return v
        src[key] = kind if default is not None else None
        return default

    e: dict = {"airtable_id": p.get("airtable_id"), "name": typed.get("name") or p.get("name") or "Product",
               "project_code": p.get("project_code"), "excluded": bool(p.get("excluded")),
               # the day this work's draw closes (Airtable): one launch's works can
               # close on different days, and the page runs to the last (§1.6)
               "launch_date": str(p.get("launch_date"))[:10] if p.get("launch_date") else None}
    edition = _num(pick("edition"))
    e["edition"] = int(round(edition)) if edition and edition > 0 else None
    share = _num(pick("target_sellthrough", default=1.0, kind="default"))
    e["target_sellthrough"] = min(max(share, 0.0), 1.0) if share is not None else 1.0
    e["target_units"] = int(round(e["edition"] * e["target_sellthrough"])) if e["edition"] else 0
    # Airtable's units target for the work, typed over on a timed launch's tab
    # (docs/TL_SPEC.md §7; shared/economics.mjs effectiveProduct)
    ut = _num(pick("units_target"))
    e["units_target"] = ut if ut and ut > 0 else None
    price = _num(pick("unit_price"))
    e["unit_price"] = price if price and price > 0 else None
    e["currency"] = str(pick("currency", default=pricing.PAGE_CURRENCY) or pricing.PAGE_CURRENCY).upper()
    rate = pricing.RATES_TO_EUR.get(e["currency"], 1.0)
    e["unit_price_eur"] = round(e["unit_price"] * rate, 2) if e["unit_price"] else None
    e["artist_profit_per_unit"] = _num(pick("artist_profit_per_unit"))
    e["aa_profit_per_unit"] = _num(pick("aa_profit_per_unit"))
    e["aa_revenue_share"] = _num(pick("aa_revenue_share"))
    e["aa_profit_share"] = _num(pick("aa_profit_share"))
    # a frame is on offer unless Airtable or the tab says not; with nothing
    # said, a sculpture edition has none (etl/pricing.py framing_default)
    fa = pick("framing_available", default=p.get("framing_default") is not False)
    e["framing_available"] = fa is not False
    conv, profit = frame_terms({"frame_conversion": pick("frame_conversion"), "frame_profit_per_unit": pick("frame_profit_per_unit")}, b)
    e["frame_conversion"], e["frame_profit_per_unit"] = conv, profit
    e["frame_uplift_per_unit"] = round(conv * profit, 2) if e["framing_available"] and profit is not None else 0.0
    # who funds the ads: on a profit-share deal Avant Arte carries its share of
    # the profit; on a revenue-share (royalty) deal the artist is paid on
    # revenue whatever the ads cost, so Avant Arte carries them all
    if e["aa_profit_share"] is not None:
        e["aa_budget_share"], e["deal"] = min(max(e["aa_profit_share"], 0.0), 1.0), "profit share"
    elif e["aa_revenue_share"] is not None:
        e["aa_budget_share"], e["deal"] = 1.0, "revenue share"
    else:
        e["aa_budget_share"], e["deal"] = None, None
    e["sources"] = src
    return e


def legacy_budget_share(artist_profit_share) -> tuple[float, bool]:
    """Avant Arte's share of the paid spend on a release carrying
    release-level figures (docs 7), and whether it is assumed. The ads are
    divided as the profit is: on a profit split each side carries its share
    of the profit (the artist on 70% carries 70% of the spend, Avant Arte
    30%); on a commission or revenue-share deal the artist takes no profit
    share and Avant Arte carries them all. With nothing typed, half, said to
    be assumed (shared/economics.mjs releaseEconomics is the same rule)."""
    aps = _num(artist_profit_share)
    if aps is None:
        return 0.5, True
    if aps <= 0:
        return 1.0, False
    return round(min(max(1.0 - aps, 0.0), 1.0), 4), False


def product_closes(products: list[dict]) -> list[dict]:
    """The works' own close dates (docs §1.6): one launch's works can close on
    different days, and the page runs to the last while the sell-through
    counts each work at its own draw. One entry per date, earliest first,
    with the works on it; sized products only, a bundle carrying no draw of
    its own."""
    by_close: dict[str, list[str]] = {}
    for p in products or []:
        if p.get("edition") and p.get("launch_date"):
            by_close.setdefault(str(p["launch_date"])[:10], []).append(p.get("name") or "")
    return [{"date": d, "works": len(n), "names": n} for d, n in sorted(by_close.items())]


def resolve_release(release: dict, spend: pd.DataFrame | None = None, notion: dict | None = None) -> dict:
    """The release's inputs in force, from where each comes (docs §1.6):

    - products: Airtable's records for the launch (etl/pricing.py
      release_products) with the figures typed on the Target setting tab laid
      over them, less the works unticked there (kept as excluded_products);
      the targets, launch value, profits per unit, framing and the
      paid-budget split follow from them, weighted by each product's target
      units. A release still carrying release-level figures (legacy_economics,
      or the top-level keys of inputs saved before the model went per
      product) keeps them for its totals until they are cleared.
    - dates: the Notion log first (the early-access email opens the private
      room; the announce; the launch), then what was typed, then the funnel's
      campaign clock, then Airtable's planned dates.
    - the marketing lead: Airtable, else what was typed.
    - the Meta campaigns: the list saved, else the draw campaign named for
      the code; the code itself is what was saved, else the campaigns' prefix.
    Returns a new dict; the input is not changed."""
    b = BENCH
    r = dict(release)
    sources: dict = {}
    legacy = r.get("legacy_economics")
    if legacy is None and any(k in r and r[k] not in (None, "") for k in LEGACY_KEYS):
        legacy = {k: r[k] for k in LEGACY_KEYS if k in r}
    at = pricing.release_products(r)
    typed = r.get("products") if isinstance(r.get("products"), list) else []
    merged = [_effective_product(p, b) for p in _merge_products(at["products"], typed)]
    # a work unticked on the tab (docs 1.6) stays on the grid and counts
    # nothing here: not in the edition, the targets, the closes or the page
    products = [p for p in merged if not p.get("excluded")]
    r["economics_products"] = products
    r["excluded_products"] = [p for p in merged if p.get("excluded")]
    r["airtable_match"] = {"how": at["match"], "note": at["note"]}

    sized = [p for p in products if p["edition"]]
    targets = sum(p["target_units"] for p in sized)
    if legacy and _num(legacy.get("edition_size")):
        # the release-level figures as typed: the totals stay theirs, the
        # products are read for what Airtable says beside them
        for k in LEGACY_KEYS:
            r[k] = legacy.get(k)
        if r.get("aa_budget_share") is None:
            # the ads divide as the profit does: AA's share of the profit, all
            # of it when the artist takes none (legacy_budget_share)
            r["aa_budget_share"], r["aa_budget_share_assumed"] = legacy_budget_share(r.get("artist_profit_share"))
        else:
            r["aa_budget_share_assumed"] = False
        r["legacy_economics"] = {k: legacy[k] for k in LEGACY_KEYS if k in legacy}
        r["economics_mode"] = "release"
        r["launch_value"] = round(float(r["edition_size"]) * float(r.get("unit_price") or 0), 2)
        sources["economics"] = "typed release-level figures"
    elif sized and targets > 0:
        r["economics_mode"] = "products"
        r["edition_total"] = sum(p["edition"] for p in sized)
        r["edition_size"] = targets
        priced = [p for p in sized if p["unit_price_eur"]]
        value = sum(p["target_units"] * p["unit_price_eur"] for p in priced)
        r["unit_price"] = round(value / sum(p["target_units"] for p in priced), 2) if priced and sum(p["target_units"] for p in priced) else None
        r["currency"] = pricing.PAGE_CURRENCY
        r["launch_value"] = round(value, 2)
        r["launch_currencies"] = sorted({p["currency"] for p in priced})

        def weighted(key, of=None):
            rows = [p for p in (of or sized) if p.get(key) is not None and p["target_units"] > 0]
            tot = sum(p["target_units"] for p in rows)
            return (sum(p["target_units"] * p[key] for p in rows) / tot) if tot else None
        ppu_artist = weighted("artist_profit_per_unit")
        ppu_aa = weighted("aa_profit_per_unit")
        r["artist_profit"] = round(ppu_artist * targets, 2) if ppu_artist is not None else 0.0
        r["aa_group_profit"] = round(ppu_aa * targets, 2) if ppu_aa is not None else 0.0
        framed = [p for p in sized if p["framing_available"]]
        r["framing_available"] = bool(framed)
        r["frame_conversion"] = weighted("frame_conversion", framed) if framed else None
        r["frame_profit_per_unit"] = weighted("frame_profit_per_unit", framed) if framed else None
        # the framing uplift over every target unit: the products that frame,
        # each at its own take-up and profit, spread over the whole target
        uplift = sum(p["target_units"] * p["frame_uplift_per_unit"] for p in framed) / targets
        r["frame_uplift_per_unit"] = round(uplift, 4)
        r["aa_ppu_resolved"] = round((ppu_aa or 0.0) + uplift, 4)
        share = weighted("aa_budget_share")
        r["aa_budget_share"] = share if share is not None else 0.5
        # no product records its deal: half, and the page says it is assumed
        r["aa_budget_share_assumed"] = share is None
        r["artist_profit_share"] = round(1.0 - r["aa_budget_share"], 4)
        r["deal"] = sorted({p["deal"] for p in sized if p["deal"]})
        r["legacy_economics"] = None
        sources["economics"] = "products"
    else:
        r["economics_mode"] = "none"
        sources["economics"] = None

    # dates: the Notion log, then what was typed, then the funnel's campaign
    # clock (measured: exact for the announce), then Airtable's planned dates
    code = r.get("campaign_code") or None
    nd = notion_dates_for(notion, code, r.get("release_name"))
    clock = r.get("clock_dates") or {}
    for key, at_key in (("private_room_open", "private_room_date"), ("announce_date", "announce_date"), ("launch_end", "launch_date")):
        for src_name, v in (("notion", nd.get(key)), ("typed", r.get(key)), ("clock", clock.get(key)), ("airtable", at.get(at_key))):
            if v:
                r[key], sources[key] = str(v)[:10], src_name
                break
        else:
            r[key], sources[key] = None, None
    if not r.get("private_room_open") and r.get("announce_date"):
        r["private_room_open"] = (date.fromisoformat(r["announce_date"]) - timedelta(days=PR_LEAD_DAYS)).isoformat()
        sources["private_room_open"] = "default"
    # the works' own closes (docs §1.6): one launch's works can close on
    # different days, and the page runs to the last while the sell-through
    # counts each work at its own draw. Each close with the works on it.
    r["closes"] = product_closes(sized)
    r["staggered"] = len(r["closes"]) > 1
    # a date that moved after it was typed, or that Airtable and the funnel's
    # clock disagree on: said beside the date in force, never silently
    # overridden (the tab offers the other reading with one click)
    drift = {}
    for key, at_key in (("announce_date", "announce_date"), ("launch_end", "launch_date")):
        here = r.get(key)
        if not here:
            continue
        others = {}
        for name, v in (("airtable", at.get(at_key)), ("clock", clock.get(key))):
            v = str(v)[:10] if v else None
            if v and v != here and name != sources.get(key):
                others[name] = v
        if others:
            drift[key] = {"inForce": here, "source": sources.get(key), **others}
    r["date_drift"] = drift
    if at.get("marketing_lead"):
        r["marketing_lead"], sources["marketing_lead"] = at["marketing_lead"], "airtable"
    else:
        r["marketing_lead"] = r.get("marketing_lead") or None
        sources["marketing_lead"] = "typed" if r["marketing_lead"] else None

    # the Meta campaigns: the list saved, else the draw campaign for the code
    names = [str(n).strip() for n in (r.get("campaign_names") or []) if str(n).strip()]
    if not names and r.get("campaign_name"):
        names = [str(r["campaign_name"]).strip()]
    if not names and spend is not None and len(spend) and code:
        first = match_campaign(code, spend)
        names = [first] if first else []
        sources["campaigns"] = "matched"
    else:
        sources["campaigns"] = "saved" if names else None
    r["campaign_names"] = names
    r["campaign_name"] = names[0] if names else None
    if not code and names:
        r["campaign_code"] = names[0].split(" · ")[0].strip() or None
        sources["campaign_code"] = "campaigns"
    else:
        sources["campaign_code"] = "typed" if code else None
    r["input_sources"] = sources
    return r


def resolve_inputs(discovered: list[dict], spend: pd.DataFrame | None, notion: dict | None) -> None:
    """INPUTS["releases"] resolved in place (resolve_release), each configured
    release first given the funnel's campaign clock for its name, so the
    build, the artist-posts benchmark and the single-release path all read
    one set of inputs. The discovered records get their clock the same way,
    for the sourced block of inputs.json."""
    clocks = {}
    for rec in discovered:
        ann = rec.get("announce_date")
        rec["clock_dates"] = {
            "announce_date": ann, "launch_end": rec.get("launch_end"),
            "private_room_open": (date.fromisoformat(ann) - timedelta(days=PR_LEAD_DAYS)).isoformat() if ann else None,
        }
        clocks[rec["release_name"]] = rec["clock_dates"]
    resolved = []
    for r in INPUTS["releases"]:
        rr = resolve_release(dict(r, clock_dates=clocks.get(r["release_name"])), spend, notion)
        src = rr.get("input_sources") or {}
        n = len([p for p in rr.get("economics_products") or [] if p.get("edition")])
        off = len(rr.get("excluded_products") or [])
        print(f"{rr['id']}: inputs - economics from {src.get('economics') or 'nothing'} ({n} sized products"
              f"{f', {off} unticked' if off else ''}, "
              f"target {rr.get('edition_size')} of {rr.get('edition_total')}), dates "
              f"{src.get('private_room_open')}/{src.get('announce_date')}/{src.get('launch_end')}, "
              f"lead {src.get('marketing_lead') or '-'}, campaigns {len(rr.get('campaign_names') or [])} ({src.get('campaigns') or '-'})")
        resolved.append(rr)
    INPUTS["releases"] = resolved


def sourced_inputs(rec: dict, spend: pd.DataFrame | None, notion: dict | None) -> dict:
    """What the feeds hold for a release, for the Target setting tab to show
    beside what is typed: the Airtable products and dates, the Notion dates,
    the marketing lead and the Meta campaigns named for the code."""
    at = pricing.release_products(rec)
    code = rec.get("campaign_code")
    nd = notion_dates_for(notion, code, rec.get("release_name"))
    # the product fields the tab reads (shared/economics.mjs PRODUCT_KEYS and
    # the identity); the record's other columns stay in the pricing file
    keep = ("airtable_id", "name", "project_code", "edition", "target_sellthrough", "unit_price", "currency",
            "artist_profit_per_unit", "aa_profit_per_unit", "aa_revenue_share", "aa_profit_share",
            "framing_available", "framing_default", "frame_conversion", "frame_profit_per_unit",
            "launch_date")
    products = [{k: p.get(k) for k in keep} for p in at["products"]]
    return {
        "airtable": {"match": at["match"], "note": at["note"], "products": products,
                     "announce_date": at["announce_date"], "launch_end": at["launch_date"],
                     "private_room_open": at["private_room_date"], "marketing_lead": at["marketing_lead"],
                     # the works' own closes, for a launch whose works close on different days
                     "closes": product_closes(at["products"])},
        "notion": {k: nd.get(k) for k in ("private_room_open", "announce_date", "launch_end")},
        "clock": {k: rec.get("clock_dates", {}).get(k) if rec.get("clock_dates") else None
                  for k in ("private_room_open", "announce_date", "launch_end")},
        "campaigns": match_campaigns(code, spend) if spend is not None and len(spend) else [],
    }


def match_campaign(code: str | None, spend: pd.DataFrame) -> str | None:
    """The Meta campaign for a code. The spend feed names campaigns
    "<code> · Enter draw" (the draw campaign), "<code> · Purchases",
    "<code> · Sign-ups"; the configured releases all point at Enter draw. Take
    that when it exists, otherwise the only campaign under the code, otherwise
    nothing - never a guess between two."""
    if not code or spend is None or spend.empty:
        return None
    names = [n for n in spend["campaign_name"].dropna().unique() if str(n).startswith(f"{code} · ")]
    draw = f"{code} · Enter draw"
    if draw in names:
        return draw
    return names[0] if len(names) == 1 else None


def meta_campaigns(spend: pd.DataFrame) -> list[dict]:
    """Every Meta campaign in the spend feed with its spend and the last day it
    spent, most recently active first, for the Target setting tab's matcher.
    The last day is the last with spend above zero: the export keeps sending
    a campaign's rows, at zero, for about four weeks after it stops. A
    campaign that never spent has no last day and lists at the end."""
    spent = spend[pd.to_numeric(spend["spend"], errors="coerce") > 0]
    last = spent.groupby("campaign_name")["spend_date"].max()
    camp = spend.groupby("campaign_name").agg(spend=("spend", "sum")).reset_index()
    camp["last"] = camp["campaign_name"].map(last)
    camp["_day"] = pd.to_datetime(camp["last"], errors="coerce")
    camp = camp.sort_values(["_day", "spend"], ascending=False, na_position="last")
    return [{"name": r.campaign_name, "spend": round(float(r.spend), 2),
             "last": r.last.isoformat() if pd.notna(r.last) else None}
            for r in camp.itertuples()]


def discover_releases(at: pd.DataFrame, as_of: date, codes: set[str]) -> list[dict]:
    """One record per simple_release_name in the funnel data.

    Dates come from the campaign clock the export carries (docs §1.5): announce
    = event_date - days_since_announcement, close = event_date +
    days_until_launch, taken from rows on the non-negative side of each so the
    truncation toward zero cannot shift them by a day. A release without the
    clock is catalogue: a work still drawing traffic, with no campaign window
    to measure against. Clock dates that make no sense (close before
    announce, or a window outside 3..90 days) are dropped with a note rather
    than trusted - the placeholder announce of docs 1.5 does that where the
    release had too few entrants for aggregate_events to infer a clock, and
    on every one of its releases when FUNNEL_SOURCE=export."""
    out = []
    g = at.groupby("simple_release_name")
    stats = g.agg(first=("event_date", "min"), last=("event_date", "max"),
                  sessions=("Sessions_Total", "sum"), entries=("Draw_Entries_Eligible_Units", "sum"),
                  units=("Total_Product_Units", "sum"))
    clocked = at[at["days_since_announcement"].notna() & at["days_until_launch"].notna()].copy()
    clocked["ts"] = pd.to_datetime(clocked["event_date"])
    mode = lambda s: s.mode().iloc[0] if len(s) else None
    # Each clock is exact on its non-negative side and truncated toward zero on
    # the other, so anchor on rows from the exact side. A release seen only
    # before its announce (early access) or only after its close has one side
    # missing; the pct column is dsa / campaign length, which gives the length
    # exactly and lets the missing date be reconstructed from the anchored one.
    ann_rows = clocked[clocked["days_since_announcement"] >= 0]
    ann_rows = ann_rows.assign(d=ann_rows["ts"] - pd.to_timedelta(ann_rows["days_since_announcement"], unit="D"))
    la_rows = clocked[clocked["days_until_launch"] >= 0]
    la_rows = la_rows.assign(d=la_rows["ts"] + pd.to_timedelta(la_rows["days_until_launch"], unit="D"))
    ann = ann_rows.groupby("simple_release_name")["d"].agg(mode)
    lau = la_rows.groupby("simple_release_name")["d"].agg(mode)
    ratio = clocked[clocked["pct_days_since_announcement"].notna() & (clocked["pct_days_since_announcement"] != 0)]
    ratio = ratio.assign(L=(ratio["days_since_announcement"] / ratio["pct_days_since_announcement"]).round())
    length = ratio.groupby("simple_release_name")["L"].agg(mode)
    # releases per artist-year, for the code guess
    def artist_year(n):
        ps = [p.strip() for p in str(n).split(" · ")]
        qm = _QUARTER_RE.match(ps[-1]) if len(ps) >= 2 else None
        return (_norm(ps[0]), int(qm.group(1)) if qm else None)
    siblings = collections.Counter(artist_year(n) for n in stats.index)
    seen_ids: dict[str, int] = {}
    for name, st in stats.iterrows():
        parts = [p.strip() for p in str(name).split(" · ")]
        qm = _QUARTER_RE.match(parts[-1]) if len(parts) >= 2 else None
        artist = parts[0]
        title = " · ".join(parts[1:-1]) if qm and len(parts) >= 3 else (" · ".join(parts[1:]) or "")
        quarter = parts[-1] if qm else None
        year = int(qm.group(1)) if qm else int(st["first"].year)
        announce = ann.get(name); launch = lau.get(name)
        Lpd = length.get(name)
        Lpd = int(Lpd) if Lpd is not None and not pd.isna(Lpd) and 1 <= Lpd <= 400 else None
        # Checked against the eight hand-entered releases: announce from the
        # non-negative dsa rows is exact in every case and so is the length
        # from the pct column, while the countdown-derived close runs a day
        # early for some. So the close is announce + length whenever announce
        # is anchored; the countdown only anchors a release seen before its
        # announce, where the reconstruction can be a day out.
        if announce is not None and Lpd:
            launch = pd.Timestamp(announce) + pd.Timedelta(days=Lpd)
        elif announce is None and launch is not None and Lpd:
            announce = pd.Timestamp(launch) - pd.Timedelta(days=Lpd)      # seen only pre-announce
        note = None
        if announce is not None and launch is not None:
            announce, launch = pd.Timestamp(announce).date(), pd.Timestamp(launch).date()
            L = (launch - announce).days
            if not (3 <= L <= 90):
                note = f"campaign clock gives {announce}..{launch} ({L} days) - not usable"
                announce = launch = None
        elif announce is not None or launch is not None:
            note = "campaign clock present but incomplete"
            announce = launch = None
        elif name in clocked["simple_release_name"].values:
            note = "campaign clock present but unreadable"
        code = guess_code(artist, title, year, codes, siblings[(_norm(artist), year if qm else None)])
        rid = slugify(str(name)) or "release"
        if rid in seen_ids:
            seen_ids[rid] += 1; rid = f"{rid}_{seen_ids[rid]}"
        else:
            seen_ids[rid] = 1
        out.append({
            "id": rid, "release_name": str(name), "artist": artist, "title": title, "quarter": quarter,
            "type": "LE", "campaign_code": code,   # the LE export: everything in it is an LE
            "code_source": "guess" if code else None,   # the orders feed or Airtable, once source_campaign_codes has run
            "announce_date": announce.isoformat() if announce else None,
            "launch_end": launch.isoformat() if launch else None,
            "dates_note": note,
            "first_seen": st["first"].isoformat(), "last_seen": st["last"].isoformat(),
            "sessions": float(st["sessions"]), "entries": float(st["entries"]), "units": float(st["units"]),
        })
    # The quarter is the name's, and the name is the funnel export's own and
    # the join key, so it stands; where the campaign closes in another
    # quarter the build says so, for the name to be corrected upstream
    for r in out:
        closes = pricing.quarter_of(pd.Timestamp(r["launch_end"])) if r["quarter"] and r["launch_end"] else ""
        if closes and closes != r["quarter"]:
            said = f"the name says {r['quarter']}, but the campaign closes {r['launch_end']} ({closes})"
            r["dates_note"] = r["dates_note"] or said
            print(f"{r['release_name']}: {said} - the name comes from the funnel export; correct it there")
    return out


# ---------------------------------------------------------------- upcoming launches (docs §1.7)

def _frame_of_releases(records: list[dict]) -> pd.DataFrame:
    """Releases on file as the frame etl/pricing.py matches Airtable launches to."""
    rows = []
    for r in records:
        parts = [p.strip() for p in str(r["release_name"]).split(" · ")]
        qm = _QUARTER_RE.match(parts[-1]) if len(parts) >= 2 else None
        rows.append({
            "release_name": r["release_name"],
            "artist": r.get("artist") or parts[0],
            "title": r["title"] if r.get("title") is not None else (" · ".join(parts[1:-1]) if qm and len(parts) >= 3 else " · ".join(parts[1:])),
            "quarter": r.get("quarter") or (parts[-1] if qm else ""),
            "announce": r.get("announce_date"), "close": r.get("launch_end"), "panel": "",
        })
    return pd.DataFrame(rows, columns=["release_name", "artist", "title", "quarter", "announce", "close", "panel"])


def airtable_ids_on_file(records: list[dict], launch_frame: pd.DataFrame | None) -> dict[str, set[str]]:
    """release_name -> the Airtable record ids of the launch it matched, for
    every release the matcher (etl/pricing.py match) could place."""
    if not records or launch_frame is None or not len(launch_frame):
        return {}
    frame = _frame_of_releases(records)
    res = pricing.match(frame, launch_frame)
    out: dict[str, set[str]] = {}
    for name, ids in zip(frame["release_name"], res["airtable_ids"]):
        if isinstance(ids, str) and ids:
            out[name] = set(ids.split("|"))
    return out


def load_launches() -> pd.DataFrame | None:
    """Airtable's launches (etl/pricing.py), or None when the file is not there:
    a checkout without it loses the upcoming list, not the build."""
    try:
        return pricing.launches(pricing.load_pricing())
    except (OSError, ValueError, KeyError) as e:
        print(f"airtable: no launches ({e}) - no upcoming releases")
        return None


def funnel_spellings(existing: list[dict], on_file: dict[str, set[str]], launch_frame: pd.DataFrame) -> dict[str, str]:
    """Airtable's artist name -> the funnel's, where they differ: the releases
    on file the matcher placed on an artist's Airtable launches say how the
    funnel writes that artist ("Kukwon Woo" in Airtable is "Woo Kuk Won" in
    the funnel). The latest such release decides."""
    artist_of: dict[str, str] = {}
    for ids, artist in zip(launch_frame["airtable_ids"], launch_frame["artist"]):
        for i in str(ids or "").split("|"):
            if i:
                artist_of[i] = str(artist)
    latest: dict[str, tuple[tuple[str, str], str]] = {}
    for r in _frame_of_releases(existing).itertuples(index=False):
        when = tuple(v if isinstance(v, str) else "" for v in (r.quarter, r.close))
        for a in {artist_of[i] for i in on_file.get(r.release_name, ()) if i in artist_of}:
            if a not in latest or when >= latest[a][0]:
                latest[a] = (when, str(r.artist))
    return {a: spelt for a, (_, spelt) in latest.items() if spelt and spelt != a}


WORKS_TITLE_CHARS = 100   # a title made of a launch's works names the ones that fit in this, then counts the rest


def _works_title(titles: str, limit: int = WORKS_TITLE_CHARS) -> str:
    """A launch's works as a release title, "Barbed Wire / Mind Trip": each
    distinct title once, without Airtable's bracketed notes. A launch of a
    dozen works names the first that fit in `limit` characters and counts
    the rest ("Brillo Box / Green Landscape and 10 more"): the title is the
    page's name, and its id names a file."""
    names = [re.sub(r"\s*\[[^\]]*\]?", "", t).strip() for t in str(titles or "").split(" / ")]
    names = list(dict.fromkeys(n for n in names if n))
    if len(" / ".join(names)) <= limit:
        return " / ".join(names)
    kept = names[:1]
    for n in names[1:]:
        if len(" / ".join(kept + [n])) > limit:
            break
        kept.append(n)
    rest = len(names) - len(kept)
    return " / ".join(kept) + (f" and {rest} more" if rest else "")


def _mostly_not_draw(l) -> bool:
    """Whether most of a launch's records are originals, NFTs or timed
    editions (UPCOMING_NOT_DRAW): an originals show or a timed print, not a draw."""
    kinds = getattr(l, "edition_type_counts", None)
    off = sum(n for k, n in kinds.items() if k in UPCOMING_NOT_DRAW) if isinstance(kinds, dict) else 0
    return 2 * off > int(l.n_products)


def _one_launch_each(launches: list) -> list:
    """One artist's codes closing within MERGE_DAYS of each other are one
    launch, as the matcher merges them for a release on file (pricing._pick):
    Ai Weiwei's Lego prints and Lego Middle Fingers, two codes closing on 30
    November 2026, are one page, where they listed as "Ai Weiwei · Multiple"
    beside "Ai Weiwei · Lego Middle Finger 1 - Red / ... and 1 more". A
    launch mostly of originals, NFTs or timed editions stays apart from a
    draw (an originals show opening the day a print draw closes), as under
    one code. The merged launch has every code's records, the editions
    added, the value-weighted price (pricing._combine), the last close as
    its date and every close beside it, and the rest from the code with the
    most works."""
    groups: list[list] = []
    for l in launches:
        for g in groups:
            if (g[0].artist_key == l.artist_key and (l.launch_date - g[0].launch_date).days <= pricing.MERGE_DAYS
                    and _mostly_not_draw(g[0]) == _mostly_not_draw(l)):
                g.append(l)
                break
        else:
            groups.append([l])
    out = []
    for g in groups:
        if len(g) == 1:
            out.append(g[0])
            continue
        g = sorted(g, key=lambda m: (-int(m.n_products), str(m.airtable_release or "")))
        d = pricing._combine([pd.Series(vars(m)) for m in g])
        d["launch_date"] = max(m.launch_date for m in g)
        d["closes"] = sorted({c for m in g for c in (getattr(m, "closes", None) or [])})
        counts: dict[str, int] = {}
        for m in g:
            for k, n in (getattr(m, "edition_type_counts", None) or {}).items():
                counts[k] = counts.get(k, 0) + int(n)
        d["edition_type_counts"] = counts
        for col in ("announce_date", "private_room_date"):
            dates = [getattr(m, col) for m in g if not pd.isna(getattr(m, col, None))]
            d[col] = min(dates) if dates else pd.NaT
        d["title_keys"] = set().union(*[getattr(m, "title_keys", None) or set() for m in g])
        out.append(types.SimpleNamespace(**d))
    out.sort(key=lambda m: m.launch_date)
    return out


def upcoming_releases(launch_frame: pd.DataFrame | None, existing: list[dict], as_of: date,
                      activity: dict[str, tuple[date, date]] | None = None) -> list[dict]:
    """The launches Airtable knows and the funnel does not yet (§1.7), as the
    records build_upcoming reads: draws closing after today and within
    UPCOMING_DAYS, whose Airtable records no release on file matched. A
    launch with no type counts as a draw unless most of its records are
    originals, NFTs or timed editions (UPCOMING_NOT_DRAW). One artist's
    codes closing within MERGE_DAYS of each other are one launch
    (_one_launch_each), as the matcher reads them for a release on file.

    Named the way the funnel will name them - "Artist · Title · YYYY Qn", the
    title "Multiple" when the launch has several works, the artist spelt as
    the funnel spells it where a release on file already matched that
    Airtable artist (funnel_spellings) - so the page keeps its id when the
    funnel catches up; adopt_funnel_names covers a launch set up before the
    funnel named it differently. A second launch of the artist in the quarter
    takes its works as its title, then its close date, so no two pages share
    a name. The announce date is Airtable's, else assumed
    ASSUMED_CAMPAIGN_DAYS before the close and said so; one that has passed
    with no code moving for the launch on Meta or in the sends is said to
    be possibly out of date. The price is converted to euros, the page's
    currency, at the fixed table. The campaign code is guessed only among
    codes active in the launch's own window (`activity`, code_activity less
    the codes releases on file carry): before a campaign spends or sends
    there is nothing to guess from."""
    if launch_frame is None or not len(launch_frame):
        return []
    on_file = airtable_ids_on_file(existing, launch_frame)
    used: set[str] = set().union(*on_file.values()) if on_file else set()
    # a release set up from an upcoming page keeps the ids it was set up
    # from (§1.7): that launch is represented whatever the matcher makes of it
    used |= {i for r in existing if r.get("airtable_ids") for i in str(r["airtable_ids"]).split("|") if i}
    names = {r["release_name"] for r in existing}
    spelling = funnel_spellings(existing, on_file, launch_frame)
    horizon = as_of + timedelta(days=UPCOMING_DAYS)
    eligible = []
    for rec in launch_frame.sort_values("launch_date", kind="stable").to_dict("records"):
        l = types.SimpleNamespace(**rec)
        if pd.isna(l.launch_date):
            continue
        close = l.launch_date.date()
        if not (as_of < close <= horizon):
            continue
        ltype = str(l.launch_type or "")
        if ltype not in UPCOMING_TYPES:
            continue
        # a project two months out with no launch type is not a campaign yet
        if not ltype and close > as_of + timedelta(days=UPCOMING_UNTYPED_DAYS):
            continue
        # nor is one made mostly of originals, NFTs or timed editions: an
        # originals show or a timed print is not a draw
        if not ltype and _mostly_not_draw(l):
            continue
        if str(l.project_status or "").startswith("1.4"):   # pitching: nothing to plan yet
            continue
        ids = set(str(l.airtable_ids).split("|")) if l.airtable_ids else set()
        if ids & used:
            continue
        eligible.append(l)
    try:
        merged = _one_launch_each(eligible)
    except Exception as e:  # noqa: BLE001 - listed apart costs less than no list
        print(f"warning: one artist's codes could not be read as one launch ({e}) - listed apart")
        merged = eligible
    out, seen_ids, listed = [], {}, set()
    for l in merged:
        close = l.launch_date.date()
        artist = spelling.get(str(l.artist), str(l.artist))
        title = "Multiple" if int(l.n_products) > 1 else str(l.titles)
        quarter = pricing.quarter_of(l.launch_date)
        name = f"{artist} · {title} · {quarter}"
        # a release on file by this name that the matcher placed on no launch
        # may be this one under the name its page was set up with
        if name in names and not on_file.get(name):
            continue
        if name in names or name in listed:
            # the artist's other launch this quarter has the name: this one
            # takes its works as its title, and its close date if that is taken too
            works = _works_title(l.titles)
            for alt in ([works] if works and works != title else []) + [f"{works or title} (closes {close.day} {close:%b})"]:
                title, name = alt, f"{artist} · {alt} · {quarter}"
                if name not in names and name not in listed:
                    break
        listed.add(name)
        # a launch whose works close on different days (pricing.launches):
        # the page runs to the last, and says so
        closes = [str(d)[:10] for d in (getattr(l, "closes", None) or []) if d]
        staggered = ("the works close on different days, " + " and ".join(
            f"{date.fromisoformat(d).day} {date.fromisoformat(d):%b}" for d in closes) + "; the page runs to the last") if len(closes) > 1 else None
        assumed = pd.isna(l.announce_date) or l.announce_date.date() >= close
        announce = close - timedelta(days=ASSUMED_CAMPAIGN_DAYS) if assumed else l.announce_date.date()
        pr_open = l.private_room_date.date() if not pd.isna(l.private_room_date) else announce - timedelta(days=PR_LEAD_DAYS)
        # the codes moving in this launch's window, none of which a release on
        # file carries: a lone one for this artist cannot be an earlier
        # launch's, so the sibling rule guess_code applies to the funnel's
        # releases does not apply, and the page marks the code as guessed
        lo_w, hi_w = announce - timedelta(days=30), close + timedelta(days=2)
        moving = {c for c, (lo, hi) in (activity or {}).items() if hi >= lo_w and lo <= hi_w}
        spellings = list(dict.fromkeys([artist, str(l.artist)]))
        code = next((c for c in (guess_code(a, title, close.year, moving, 1) for a in spellings) if c), None)
        # the announce has passed and no code for the artist moves in the
        # window: no spend, no sends, and no funnel release has its records,
        # so Airtable's dates have most likely slipped
        stale = (activity is not None and not assumed and announce < as_of
                 and not any(guess_code(a, title, close.year, {c}, 1) for c in moving for a in spellings))
        rid = slugify(name) or "release"
        if rid in seen_ids:
            seen_ids[rid] += 1; rid = f"{rid}_{seen_ids[rid]}"
        else:
            seen_ids[rid] = 1
        price = float(l.unit_price) if pd.notna(l.unit_price) else None
        rate = pricing.RATES_TO_EUR.get(str(l.currency or "")) if price is not None else None
        out.append({
            "id": rid, "release_name": name, "artist": artist, "title": title, "quarter": quarter,
            "type": "LE", "campaign_code": code, "campaign_name": None,
            "announce_date": announce.isoformat(), "launch_end": close.isoformat(),
            "private_room_open": pr_open.isoformat(),
            "dates_assumed": bool(assumed),
            "dates_note": "; ".join(x for x in (
                ("announce date assumed: Airtable has none for it yet" if assumed else
                 f"Airtable's announce date, {announce.isoformat()}, has passed with no spend, sends or "
                 f"traffic for this launch, so its dates may be out of date" if stale else None),
                staggered) if x) or None,
            "closes": closes,
            "first_seen": None, "last_seen": None, "sessions": 0.0, "entries": 0.0, "units": 0.0,
            "source": "airtable",
            "edition_size": int(l.edition_size) if pd.notna(l.edition_size) and l.edition_size > 0 else None,
            "unit_price": int(round(price * rate)) if price is not None and rate else None,
            "unit_price_native": price, "currency_native": str(l.currency or ""),
            "airtable_release": str(l.airtable_release or ""), "airtable_ids": str(l.airtable_ids or ""),
            "titles": str(l.titles), "n_products": int(l.n_products),
            "launch_type": str(l.launch_type or ""), "project_status": str(l.project_status or ""),
        })
    return out


def _name_keys(rec: dict) -> tuple[str, str, str]:
    """(artist key, title key, quarter) of a release, from its own fields or
    its name: what the matcher compares, an estate's words folded."""
    f = _frame_of_releases([rec]).iloc[0]
    return pricing.artist_key(f["artist"]), pricing.norm(f["title"]), str(f["quarter"] or "")


def _window_of(c: dict) -> tuple[str, str]:
    """The window a configured release's funnel activity is read over (ISO
    dates, either blank for no bound): from the private room where the
    inputs open one, else the announce, to the close run on
    WINDOW_AFTER_DAYS for a close that moved."""
    lo, pr = str(c.get("announce_date") or "")[:10], str(c.get("private_room_open") or "")[:10]
    lo = min(lo, pr) if lo and pr else (lo or pr)
    hi = str(c.get("launch_end") or "")[:10]
    if hi:
        hi = (date.fromisoformat(hi) + timedelta(days=pricing.WINDOW_AFTER_DAYS)).isoformat()
    return lo, hi


def _activity(at: pd.DataFrame, name: str, lo: str, hi: str) -> tuple[float, float]:
    """A funnel release's draw entries and units in the window lo..hi (ISO
    dates, either blank for no bound), and in all."""
    rows = at[at["simple_release_name"] == name]
    if not len(rows):
        return 0.0, 0.0
    act = rows["Draw_Entries_Eligible_Units"].fillna(0).astype(float) + rows["Total_Product_Units"].fillna(0).astype(float)
    total = float(act.sum())
    if total <= 0:
        return 0.0, 0.0
    when = pd.to_datetime(rows["event_date"])
    mask = pd.Series(True, index=rows.index)
    if lo:
        mask &= when >= pd.Timestamp(lo)
    if hi:
        mask &= when <= pd.Timestamp(hi)
    return float(act[mask].sum()), total


def _same_words_elsewhere(ck: tuple[str, str, str], dk: tuple[str, str, str]) -> bool:
    """The same artist and title, in another quarter."""
    return bool(ck[1]) and ck[:2] == dk[:2] and bool(ck[2]) and bool(dk[2]) and ck[2] != dk[2]


def _rows_overlap(c: dict, d: dict) -> bool:
    """The funnel release's rows reach the configured release's window: its
    first day seen on or before the close in force, its last on or after
    the announce."""
    first, last = str(d.get("first_seen") or "")[:10], str(d.get("last_seen") or "")[:10]
    hi, lo = str(c.get("launch_end") or "")[:10], str(c.get("announce_date") or "")[:10]
    if hi and first and first > hi:
        return False
    if lo and last and last < lo:
        return False
    return True


def _missing_words(name: str, cands: list, twins: list, hits: list) -> str:
    """Why a page the funnel has no rows for was not given another name, for
    the build's log and the page's header."""
    said = f"The funnel has no rows under {name!r}."
    if cands:
        said += " In the same words in another quarter: " + ", ".join(
            f"{n!r}" + (f" ({share:.0%} of its entries and units in this page's window)" if share is not None else "")
            for n, share, _ in cands) + "."
        if len(twins) > 1:
            said += " Not adopted: more than one of them holds this window's entries."
        elif not twins:
            said += " Not adopted: their entries sit outside this page's window, so they are other launches."
    else:
        said += " Nothing in the funnel is in the same words in another quarter."
    if hits:
        said += " The matcher places its Airtable launch on " + ", ".join(repr(h) for h in hits) + \
            (", which is not the one name it would take." if len(hits) > 1 else ".")
    return said


def adopt_funnel_names(configured: list[dict], discovered: list[dict], launch_frame: pd.DataFrame | None,
                       at: pd.DataFrame | None = None) -> list[tuple[str, str, str]]:
    """A configured release the funnel does not mention, or mentions under a
    name that no longer holds its entries, takes the funnel's name for the
    same launch (§1.7), so the actuals attach to the targets instead of
    opening a second, untargeted page beside them. Two readings, the first
    that answers decides:

    - by name: a funnel release with the same artist and title in another
      quarter, its entries and units in the window that was set (`at`, the
      funnel data; ADOPT_ACTIVITY_SHARE over _window_of), is the release
      renamed upstream with its rows (Warhol's 2026 Q3 became 2026 Q4 when
      its colourways moved to 14 October, and its page stood empty). This
      needs no Airtable: the renamed release's clock can be unreadable, and
      its launch's quarter is its first close's, so the matcher can fail
      it. A page whose own name is still in the funnel is read the same
      way when its own rows hold under ADOPT_MOVED_SHARE of the twin's
      entries and units in the window: the rows moved and stray ones stayed
      behind. The test on entries is what keeps the artist's other
      launches in the same words from being taken: every past "Ai Weiwei ·
      Multiple" draws catalogue traffic to this day, so its rows overlap
      any window, but its entries sit in its own campaign;
    - by its launch, for a name the funnel lacks: the Airtable records the
      input carries when it was set up from an upcoming page, else the ones
      the matcher places it on (a page set up by hand). The funnel release
      matched to the same records has the name the input takes (a launch
      set up under a guessed name before the funnel named it after one
      work; the artist spelt another way); where several funnel releases
      sit on the launch, the one named like the input.

    The rename is written back to the saved inputs so it holds; the id, and
    so the page's address, does not change. A page the funnel has no rows
    for that neither reading names gets `funnel_note`, which says what was
    considered, for the build's log and the page's header."""
    funnel_names = {r["release_name"] for r in discovered}
    by_name = {r["release_name"]: r for r in discovered}
    keys = {n: _name_keys(r) for n, r in by_name.items()}
    taken = {c["release_name"] for c in configured}
    pending = [c for c in configured if c["release_name"] not in funnel_names]
    have_launches = launch_frame is not None and len(launch_frame) > 0 and bool(pending)
    on_file = airtable_ids_on_file(discovered, launch_frame) if have_launches else {}
    placed = airtable_ids_on_file([c for c in pending if not c.get("airtable_ids")], launch_frame) if have_launches else {}
    renamed, hows = [], {}
    for c in configured:
        name = c["release_name"]
        missing = name not in funnel_names
        if not missing and at is None:
            continue
        ck = _name_keys(c)
        lo, hi = _window_of(c)
        # the funnel releases in the same words in another quarter whose rows
        # reach this window, each with the share of its entries and units in it
        cands = []
        for n in keys:
            if n in taken or not _same_words_elsewhere(ck, keys[n]) or not _rows_overlap(c, by_name[n]):
                continue
            if at is None:
                cands.append((n, None, None))
            else:
                within, total = _activity(at, n, lo, hi)
                cands.append((n, within / total if total > 0 else 0.0, within))
        twins = [n for n, share, within in cands if share is None or (share >= ADOPT_ACTIVITY_SHARE and within > 0)]
        if at is not None and not (lo or hi):
            twins = []
        if not missing:
            # the name is in the funnel: the rows moved only if this name holds
            # (nearly) none of the window's entries and units while a twin does
            if not twins:
                continue
            own, _ = _activity(at, name, lo, hi)
            if own > ADOPT_MOVED_SHARE * max(w for n, _, w in cands if n in twins):
                continue
        new, how = (twins[0], "by its name") if len(twins) == 1 else (None, "")
        hits = []
        if new is None and missing:
            ids = set(str(c["airtable_ids"]).split("|")) if c.get("airtable_ids") else placed.get(name, set())
            hits = [n for n, s in on_file.items() if s & ids and n not in taken] if ids else []
            if len(hits) > 1:
                same = [n for n in hits if keys[n][:2] == ck[:2]]
                hits = same if len(same) == 1 else hits
            if len(hits) == 1:
                new, how = hits[0], "by its launch"
        if new is None:
            if missing:
                c["funnel_note"] = _missing_words(name, cands, twins, hits)
                print(f"{c['id']}: {c['funnel_note']}")
            continue
        c["release_name"] = new
        c["adopted_from"] = name
        c.pop("funnel_note", None)
        taken.add(new)
        renamed.append((c["id"], name, new))
        hows[c["id"]] = how + ("" if missing else " (its own name holds none of the window's entries)")
    if renamed and _saved_inputs.exists():
        try:
            doc = json.loads(_saved_inputs.read_text())
            rel = doc.get("releases") or {}
            for rid, old, new in renamed:
                if rid in rel:
                    rel[rid]["release_name"] = new
                    rel[rid]["adopted_from"] = old
            tmp = _saved_inputs.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(doc, indent=1))
            tmp.replace(_saved_inputs)
        except (OSError, ValueError) as e:
            print(f"warning: could not write the adopted names back to {_saved_inputs.name}: {e}")
    for rid, old, new in renamed:
        print(f"{rid}: the funnel now carries this launch as {new!r} (set up as {old!r}) - adopted {hows[rid]}")
    return renamed


def build_upcoming(rec: dict, as_of: date, email_bench: dict | None = None, full_through: date | None = None) -> dict:
    """The page for a launch Airtable knows and the funnel does not yet (§1.7):
    its dates, edition and price, and no actuals. Same top-level keys as
    build_actuals so the app has one contract. Setting targets promotes it to
    build_release, which draws the plan against an empty window until the
    funnel carries the release and its actuals attach."""
    announce = date.fromisoformat(rec["announce_date"])
    close = date.fromisoformat(rec["launch_end"])
    L = max((close - announce).days, 1)
    return {
        "id": rec["id"], "releaseName": rec["release_name"],
        "artist": rec["artist"], "title": rec["title"], "quarter": rec["quarter"], "type": "LE",
        "campaignCode": rec["campaign_code"], "campaignName": None, "marketingLead": None,
        "privateRoomOpen": rec["private_room_open"],
        "windowStart": rec["announce_date"], "windowEnd": rec["launch_end"],
        "campaignLengthDays": L, "day": max(min((as_of - announce).days, L), 0), "of": L,
        "asOf": as_of.isoformat(), "complete": False,
        "completeThrough": (full_through or as_of).isoformat(), "asOfFraction": 1.0,
        "targeted": False, "catalogue": False, "upcoming": True,
        "untracked": None,
        # the works' closes when they differ (§1.6), for the sidebar's row
        "closes": [{"date": d} for d in (rec.get("closes") or [])] if len(rec.get("closes") or []) > 1 else [],
        "derived": {
            "announce_date": rec["announce_date"], "launch_end": rec["launch_end"],
            "dates_source": "airtable", "dates_note": rec["dates_note"],
            # the announce is a stand-in (Airtable has none), not merely doubtful
            "dates_assumed": bool(rec.get("dates_assumed")),
            "campaign_code": rec["campaign_code"], "first_seen": None, "last_seen": None,
        },
        "airtable": {k: rec.get(k) for k in (
            "airtable_release", "airtable_ids", "titles", "n_products", "launch_type", "project_status",
            "edition_size", "unit_price", "unit_price_native", "currency_native", "private_room_open")},
        "economics": None, "currency": "units",
        "hero": {"now": 0, "expectedToday": None, "delta": None, "projected": None,
                 "target": None, "oversubscribedUnits": 0, "statusPct": None, "ok": None},
        "targets": None, "groupTargets": None, "channels": [], "funnelByGroup": {}, "paid": None,
        "email": None, "social": None, "sellthrough": None, "framing": None, "draw": None, "geo": None, "waterfall": None,
        "totals": {"sessions": 0, "units": 0, "entries": 0},
        "benchmarks": {"chargeDropOff": 1 - BENCH["eligible_entry_to_order"], "cannibalisation": BENCH["cannibalisation"],
                       "targetBuffer": BENCH["target_buffer"], **email_refs(email_bench)},
    }


def build_actuals(rec: dict, rat: pd.DataFrame, spend: pd.DataFrame, emails: pd.DataFrame,
                  content: pd.DataFrame, as_of: date, email_bench: dict | None = None,
                  artist_posts: pd.DataFrame | None = None,
                  full_through: date | None = None, seen: float = 1.0,
                  untracked_norms: dict | None = None, direct_spread: bool = False,
                  direct_norm: dict | None = None) -> dict:
    """Actuals-only snapshot for a release nobody has set targets for. Same
    shape as build_release's so the page code has one contract, with every
    target-derived field None and targeted: False - the page shows what
    happened without pretending to know what should have. Setting targets in
    the dashboard promotes the release to build_release on the next rebuild."""
    b = BENCH
    e2o = entry_rate(rec)
    name = rec["release_name"]
    full_through = full_through or as_of
    seen = 1.0 if full_through >= as_of else seen
    dated = rec["announce_date"] is not None
    dates_note = rec["dates_note"]
    if dated:
        announce = date.fromisoformat(rec["announce_date"])
        clock_end = date.fromisoformat(rec["launch_end"])
        # a draw that ran past the clock's close: its winners pay when it
        # ends, so the page closes with the draw - the sales window, the
        # spend and sends it counts, its length in the sidebar (docs 6.3)
        launch_end, drew_to = sales_close(name, clock_end)
        if drew_to is not None:
            moved = (f"the draw ran to {drew_to}, {(drew_to - clock_end).days} days past the campaign clock's "
                     f"close of {clock_end}: the page closes with it"
                     + (f" at {launch_end}, {DRAW_END_MAX_DAYS} days on, and no later" if launch_end < drew_to else ""))
            dates_note = "; ".join(x for x in (dates_note, moved) if x)
            if not direct_spread:
                print(f"{'warning: ' if launch_end < drew_to else ''}{rec['id']}: {moved}")
        window_start = announce - timedelta(days=PR_LEAD_DAYS)
        L = (launch_end - announce).days
        complete = full_through >= launch_end
        day_n = max(min((as_of - announce).days, L), 0)
    else:
        launch_end = as_of
        window_start = as_of - timedelta(days=CATALOGUE_DAYS)
        L = CATALOGUE_DAYS
        complete = False
        day_n = CATALOGUE_DAYS
    # the days the page counts sales over, on every card alike (docs 6.3):
    # opened by the first paid order when it came earlier, shut two days
    # after the close; the units in it are the orders table's
    urows = units_rows(name)
    if (urows is None and not dated and window_start >= ORDERS_SINCE and load_units_feed() is not None
            and name not in (UNITS_FEED_INFO.get("outOfStep") or [])):
        # a catalogue page's 90 days are all in the orders feed: a release
        # with no row there sold nothing in them, whatever the funnel's
        # purchase events counted (an order with no product line on it)
        urows = pd.DataFrame(columns=_UNITS_COLS)
    window_start, window_end, first_paid = sales_window(
        urows, window_start, date.fromisoformat(rec["announce_date"]) if dated else None, launch_end, as_of)
    closed = dated and as_of > launch_end + timedelta(days=UNITS_GRACE_DAYS)
    rat = rat.copy()
    rat["group"] = rat["channel"].map(GROUP_OF)
    win = rat[(rat["event_date"] >= window_start) & (rat["event_date"] <= window_end)]
    win, uinfo = swap_units(win, name, urows, window_start, window_end,
                            launch_end + timedelta(days=UNITS_GRACE_DAYS))
    if closed and not direct_spread:
        late_paid_warning(rec["id"], urows, window_end, uinfo)
    untracked = untracked_block(win, untracked_norms)
    untracked["noEvent"] = uinfo["noEvent"]
    pre = win
    win = redistribute_untracked(win)
    # Direct's share of the window as the funnel attributes it, read before
    # the Direct switch's spread (below) moves it: the switch's tooltip
    direct_share = channel_share(win, "Direct")
    if direct_spread:
        win = redistribute_channel(win, "Direct")
    if uinfo["source"] == "orders":
        win = keep_units(win, uinfo["total"], pre)
    # once the window has shut, nothing in hand counts (docs 6.3): the
    # entries left unconverted are the draw's losers, so every channel, day
    # and part reads its own units paid rather than a share weighted by them
    if closed:
        win = win.assign(Draw_Entries_Total_Units_No_Conv=0.0)
    # Orders from draw winners land in the two days after close. win keeps
    # them (that is what the grace is for) but the daily series ends at close,
    # so the hero, the channels and sell-through disagreed by exactly those
    # units - and "secured" could read below "sold". Fold them into the close
    # day: at close then includes what the close triggered.
    win = win.assign(event_date=win["event_date"].where(win["event_date"] <= launch_end, launch_end))
    by_group_day = (win.groupby(["group", "event_date"])
                    .agg(sessions=("Sessions_Total", "sum"),
                         entries_no_conv=("Draw_Entries_Total_Units_No_Conv", "sum"),
                         units=("Total_Product_Units", "sum"))
                    .reset_index())
    days = list(daterange(window_start, launch_end))
    channels_out, hero_now, funnel_by_group = [], 0.0, {}
    for g, spec in DISPLAY_GROUPS.items():
        sub = by_group_day[by_group_day["group"] == g].set_index("event_date")
        daily, cum_u, cum_nc, cum_s = [], 0.0, 0.0, 0.0
        for d in days:
            row = sub.loc[d] if d in sub.index else None
            cum_u += float(row["units"]) if row is not None else 0.0
            cum_nc += float(row["entries_no_conv"]) if row is not None else 0.0
            if d <= as_of:
                cum_s += float(row["sessions"]) if row is not None else 0.0
            daily.append({"date": d.isoformat(),
                          "actual": round(cum_u + e2o * cum_nc, 2) if d <= as_of else None,
                          "plan": None, "proj": None})
        now = next((r["actual"] for r in reversed(daily) if r["actual"] is not None), 0.0)
        # the funnel's actual side; nothing to decompose against without a plan
        funnel_by_group[g] = {
            "sessions_actual": round(cum_s, 1), "sessions_expected": None,
            "conv_actual": (now / cum_s) if cum_s else 0.0, "conv_expected": None,
            "contrib_traffic": None, "contrib_conversion": None,
        }
        parts = []
        for ch in spec["channels"]:
            sub_ch = win[win["channel"] == ch]
            if sub_ch.empty:
                continue
            v = (float(sub_ch["Total_Product_Units"].sum())
                 + e2o * float(sub_ch["Draw_Entries_Total_Units_No_Conv"].sum()))
            if v > 0.05:
                parts.append({"name": ch, "value": round(v, 1)})
        parts.sort(key=lambda x: -x["value"])
        channels_out.append({"key": g, "name": spec["name"], "now": round(now, 1),
                             "exp": None, "proj": None, "target": None, "parts": parts, "daily": daily})
        hero_now += now

    upto = win   # grace days already folded into the close day above
    units_sold = float(upto["Total_Product_Units"].sum())
    unconverted = float(upto["Draw_Entries_Total_Units_No_Conv"].sum())
    code = rec.get("campaign_code")
    # the sell-through's count, adopted by the hero as in build_release; no
    # edition here, so nothing is capped and nothing is projected. A
    # catalogue page counts its 90 days: no entry in hand from a draw that
    # ended before them, no draft raised before them (docs 6.3)
    since = None if dated else window_start
    of_win = orders_in_window(name, urows, window_start, window_end, closed, uinfo["source"], drafts_since=since)
    sellthrough = sellthrough_block({"edition_size": None, "entry_conversion_rate": rec.get("entry_conversion_rate")},
                                    rec["release_name"], units_sold, unconverted, None, orders=of_win, closed=closed,
                                    entries_since=since)
    if uinfo["source"] == "orders":
        sellthrough["unitsOutsideWindow"] = {"before": uinfo["before"], "after": uinfo["after"], "pending": uinfo["pending"]}
    hero_now, _ = adopt_sellthrough(sellthrough, channels_out, funnel_by_group, hero_now, hero_now, True)

    # ---- paid actuals: spend, entries, cost per entry. ROI and the budget
    # recommendation need the profit split, so they stay None.
    camp = rec.get("campaign_name")
    psp = spend[spend["campaign_name"] == camp] if camp else spend.iloc[0:0]
    psp = psp[(psp["spend_date"] >= window_start) & (psp["spend_date"] <= min(as_of, launch_end))]
    spend_day = psp.groupby("spend_date")["spend"].sum()
    paid_entries_day = (win[win["channel"] == "Paid Social"]
                        .groupby("event_date")["Draw_Entries_Eligible_Units"].sum())
    drop = round(1 - entry_rate(rec), 4)
    paid_daily, win3 = [], []
    cum_spend = cum_pentries = 0.0
    for d in days:
        if d > min(full_through, launch_end):
            break
        s_, e_ = float(spend_day.get(d, 0.0)), float(paid_entries_day.get(d, 0.0))
        cum_spend += s_; cum_pentries += e_
        win3 = (win3 + [(s_, e_)])[-3:]
        paid_daily.append({"date": d.isoformat(), "spend": round(s_, 2), "entries": e_, "roi": None, "roiArtist": None,
                           "roi1": None, "roiArtist1": None})
    s3, e3 = sum(x for x, _ in win3), sum(y for _, y in win3)
    l3d_raw = s3 / e3 if e3 > 0 else None
    l3d_cpe = l3d_raw / (1 - drop) if l3d_raw else None
    s1, e1 = win3[-1] if win3 else (0.0, 0.0)
    l1d_raw = s1 / e1 if e1 > 0 else None
    l1d_cpe = l1d_raw / (1 - drop) if l1d_raw else None
    cum_cpe = cum_spend / (cum_pentries * (1 - drop)) if cum_pentries else None
    # the part day so far: in the to-date figures, never in the rates
    part_spend = part_entries = 0.0
    if full_through < as_of <= launch_end:
        part_spend = float(spend_day.get(as_of, 0.0))
        part_entries = float(paid_entries_day.get(as_of, 0.0))
    past_spend = spend_day[spend_day.index <= full_through]
    current_daily = float(past_spend.get(full_through, past_spend.iloc[-1] if len(past_spend) else 0.0))
    # the part day so far, marked, at the end of the series (as build_release)
    if full_through < as_of <= launch_end:
        paid_daily.append({"date": as_of.isoformat(), "spend": round(part_spend, 2), "entries": part_entries,
                           "roi": None, "roiArtist": None, "roi1": None, "roiArtist1": None, "partial": True})
    paid_ch = next((c for c in channels_out if c["key"] == "paid"), None)
    paid_out = {
        "daily": paid_daily,
        "spendToDate": round(cum_spend + part_spend, 2), "entriesToDate": cum_pentries + part_entries,
        # the card's bars are drawn in units: the paid group's secured units,
        # its column on the channels card (units sold + 0.8 x unconverted
        # entries), published rather than left to the page to derive
        "unitsToDate": paid_ch["now"] if paid_ch else round((cum_pentries + part_entries) * (1 - drop), 1),
        "cumRoi": None, "l3dRoi": None, "l1dRoi": None,
        "l3dCpe": round(l3d_cpe, 2) if l3d_cpe else None,
        "l1dCpe": round(l1d_cpe, 2) if l1d_cpe else None,
        "cumCpe": round(cum_cpe, 2) if cum_cpe else None,
        "roiDeclineModel": {"start": None, "dailyFactor": None}, "roiTarget": None,
        "artist": None,
        "spendCurrency": SPEND_CURRENCY, "spendRate": spend_rate(),
        "budget": {"current": round(current_daily, 2), "recommended": None, "cap": None,
                   "finalDayRoi": None, "floor": None, "budgetToSellOut": None,
                   "entriesNeeded": None, "selloutGap": None, "organicFuture": None,
                   "daysLeft": max((launch_end - full_through).days, 0)},
        "unitTarget": None, "entriesProjected": None, "unitProjected": None,
        "spendBudget": None, "spendProjectedTotal": None,
        "profitPerUnitAA": None, "profitPerUnitArtist": None, "aaBudgetShare": None,
    }
    feed_through = email_feed_through(emails)
    em = emails.iloc[0:0]
    if code:
        # never reaching back into an earlier launch by the same artist
        em_all = emails[(emails["campaign"] == code)
                        & (emails["sent_at"].dt.date >= email_window_start(rec, window_start))
                        & (emails["sent_at"].dt.date <= min(as_of, launch_end))]
        em = em_all[em_all["email_type"].isin(["GEN", "CUS", "INS"])]
        if em.empty and not em_all.empty:
            em = em_all[~em_all["email_type"].isin(["TRNS", "AUT", "FREQ", "TEST"])]
    delivered = float(em["delivered"].sum()) if len(em) else 0.0
    email_out = {
        "sends": int(len(em)), "delivered": int(delivered),
        "opened": int(em["opened"].sum()) if len(em) else 0, "clicked": int(em["clicked"].sum()) if len(em) else 0,
        "openRate": round(float(em["opened"].sum()) / delivered, 4) if delivered else None,
        "clickRate": round(float(em["clicked"].sum()) / delivered, 4) if delivered else None,
        "sequence": [
            {"name": r["name"].split(" - ", 1)[-1], "date": r["sent_at"].date().isoformat(),
             "delivered": int(r["delivered"]), "opened": int(r["opened"]), "clicked": int(r["clicked"])}
            for _, r in em.sort_values("sent_at").iterrows()
        ] if len(em) else [],
        "deliveredTarget": None,
        "feedThrough": feed_through,
    }
    social_out = social_block(content, artist_posts, code, window_start, min(as_of, launch_end))
    return {
        "id": rec["id"], "releaseName": name,
        "artist": rec["artist"], "title": rec["title"], "quarter": rec["quarter"],
        "type": rec["type"],
        "campaignCode": code, "campaignName": camp, "marketingLead": None, "privateRoomOpen": None,
        "windowStart": rec["announce_date"] if dated else window_start.isoformat(),
        "windowEnd": launch_end.isoformat() if dated else None,
        "campaignLengthDays": L if dated else None, "day": day_n, "of": L,
        "asOf": as_of.isoformat(), "complete": complete,
        # where the units came from and the days they were counted over, the
        # same on every card (docs 6.3)
        "unitsSource": uinfo["source"],
        "salesWindow": {"start": window_start.isoformat(), "end": window_end.isoformat(), "closed": closed,
                        "firstPaid": first_paid.isoformat() if first_paid else None},
        "completeThrough": full_through.isoformat(),
        "asOfFraction": 1.0 if (complete or as_of > launch_end) else round(seen, 4),
        "targeted": False, "catalogue": not dated,
        "untracked": untracked,
        # Direct's share of the window (sessions, entries, units) as the
        # funnel attributes it, for the dashboard's Direct switch
        "directShare": direct_share,
        "derived": {
            "announce_date": rec["announce_date"], "launch_end": launch_end.isoformat() if dated else rec["launch_end"],
            "dates_source": "campaign clock" if dated else None, "dates_note": dates_note,
            "campaign_code": code, "campaign_code_source": rec.get("code_source") if code else None,
            "first_seen": rec["first_seen"], "last_seen": rec["last_seen"],
        },
        "economics": None, "currency": "units",
        "hero": {"now": round(hero_now, 0), "expectedToday": None, "delta": None, "projected": None,
                 "target": None, "oversubscribedUnits": 0, "statusPct": None, "ok": None},
        "targets": None, "groupTargets": None,
        "channels": channels_out,
        "funnelByGroup": funnel_by_group, "paid": paid_out,
        "email": email_out, "social": social_out,
        "sellthrough": sellthrough,
        "framing": framing_block(rec, of_win, None, b, st=sellthrough),
        "draw": None, "geo": None, "waterfall": None,
        "totals": {"sessions": round(float(upto["Sessions_Total"].sum())), "units": round(units_sold),
                   "entries": round(float(upto["Draw_Entries_Eligible_Units"].sum()))},
        "benchmarks": {"chargeDropOff": 1 - e2o, "cannibalisation": b["cannibalisation"], "targetBuffer": b["target_buffer"],
                       **email_refs(email_bench_for(email_bench, rec))},
    }


def actuals_rec(release: dict, rat: pd.DataFrame) -> dict:
    """A configured release as the record build_actuals reads - the shape
    discover_releases writes - for the release that has inputs but no basket
    to be targeted from."""
    parts = [p.strip() for p in str(release["release_name"]).split(" · ")]
    qm = _QUARTER_RE.match(parts[-1]) if len(parts) >= 2 else None
    dates = rat["event_date"] if len(rat) else None
    return {
        "id": release["id"], "release_name": release["release_name"],
        "artist": parts[0],
        "title": " · ".join(parts[1:-1]) if qm and len(parts) >= 3 else (" · ".join(parts[1:]) or ""),
        "quarter": parts[-1] if qm else None,
        "type": release.get("type", "LE"),
        "campaign_code": release.get("campaign_code"), "campaign_name": release.get("campaign_name"),
        "code_source": "typed" if release.get("campaign_code") else None,
        "announce_date": release["announce_date"], "launch_end": release["launch_end"],
        "dates_note": None,
        "first_seen": (dates.min() if dates is not None else date.fromisoformat(release["announce_date"])).isoformat(),
        "last_seen": (dates.max() if dates is not None else date.fromisoformat(release["launch_end"])).isoformat(),
    }


def build_release(release: dict, at: pd.DataFrame, spend: pd.DataFrame,
                  emails: pd.DataFrame, content: pd.DataFrame, curves: dict,
                  as_of: date, artist_posts: pd.DataFrame | None = None,
                  posts_bench: dict | None = None,
                  email_bench: dict | None = None,
                  panel: pd.DataFrame | None = None,
                  people: pd.DataFrame | None = None,
                  full_through: date | None = None, seen: float = 1.0,
                  untracked_norms: dict | None = None, direct_spread: bool = False,
                  direct_norm: dict | None = None) -> dict:
    b = BENCH
    # a release handed in unresolved (a test, a script) is resolved here the way
    # main() resolves every configured release: its products, dates and
    # campaigns from the feeds and the typed inputs (resolve_release)
    if "economics_mode" not in release:
        release = resolve_release(release, spend, load_notion_campaigns())
    # one fit per build, over every release whose product count is recorded (§4.2)
    upb_slope = units_per_buyer_curve(people)
    name = release["release_name"]
    announce = date.fromisoformat(release["announce_date"])
    launch_end = date.fromisoformat(release["launch_end"])
    pr_open = date.fromisoformat(release["private_room_open"])
    L = (launch_end - announce).days

    # ---- the benchmark (BENCHMARK_SPEC §3-§5). A release with no saved
    # basket is compared against the basket its own shape puts it in
    # (baskets.suggest_basket), so a launch is measured against comparable
    # launches from the day it is discovered and nobody has to pick anything
    # first. There is no other model: without a basket to read, the release
    # keeps its actuals-only page (docs/DATA_MODEL.md §3).
    basket = profile = unspread = None
    if panel is not None and len(panel):
        basket = baskets.resolve_basket(release.get("benchmark_basket"), panel, release, as_of)
        # the channels this release will not run leave the basket's medians
        # before anything reads them: K, the per-group targets, every
        # benchmark mark on the page (BENCHMARK_SPEC §4.3)
        off = baskets.channels_off_of(release)
        basket["profile"] = baskets.apply_channels_off(basket["profile"], off)
        # as the funnel attributes it, before the Direct switch's spread: the
        # email plan's sends are read on these sessions (email block below)
        unspread = basket["profile"]
        if direct_spread:
            # the benchmark's channel split read the same way as the actuals
            basket["profile"] = spread_profile(basket["profile"], direct_norm)
        if basket["profile"]["units"] <= 0:
            print(f"{release['id']}: basket {basket['id']} has no median units on the channels in plan")
            basket = None
        else:
            # Every release gets a benchmark, including one bigger than
            # anything on record. The basket is the launches nearest this
            # edition however far away they are, so an unprecedented edition is
            # benchmarked against the biggest launches there have been and the
            # uplift states how far past them it is being asked to go. That is
            # a number someone can argue with; an empty panel is not.
            # scaleMismatch (the median more than SCALE_MISMATCH_FACTOR from
            # the edition) is only logged here: the snapshot's basket block
            # does not carry it, and the picker says "Nothing on file is this
            # size" from the reach of the members instead.
            profile = basket["profile"]
            if off:
                print(f"{release['id']}: not in plan: {', '.join(off)} - benchmarked on the basket's other "
                      f"channels ({profile['units']:.0f} of {profile['units_all']:.0f} median units)")
            if basket.get("scaleMismatch"):
                print(f"{release['id']}: edition {release['edition_size']:.0f} is far outside the "
                      f"panel - benchmarked against {basket['id']} (n={basket['n']}, "
                      f"medians {basket['profile']['units']:.0f})")
    if profile is None:
        print(f"{release['id']}: no benchmark basket - the page shows actuals only")
        rat = at[at["simple_release_name"] == name]
        return build_actuals(actuals_rec(release, rat), rat, spend, emails, content, as_of,
                             email_bench, artist_posts, full_through=full_through, seen=seen,
                             untracked_norms=untracked_norms, direct_spread=direct_spread)
    # every targeted release is benchmarked; the flag survives as the guard on
    # the benchmark block below
    bench = True
    # The draw records how many products it offered, so a release with no
    # curated product list still gets its count rather than falling through to
    # the basket median. Only where the count is trustworthy: before 2025-08-28
    # the field reads 1 for every launch whatever it offered (§4.2).
    if not release.get("product_count") and not isinstance(release.get("products"), list):
        _pr = people[people["release_name"] == name] if people is not None and len(people) else None
        if _pr is not None and len(_pr):
            _n = _pr.iloc[0].get("product_count")
            if _n is not None and not pd.isna(_n) and float(_n) >= 1:
                release = {**release, "product_count": float(_n)}
    targets = compute_targets(release, profile, upb_slope)
    # what the plan assumes each buyer takes, and what they have actually taken
    # so far. The actual is the release's own distinct buyer count, which is the
    # only one that is not double-counted across channels and days; with no row
    # for the release the two are equal and the units-per-buyer step is zero,
    # which is the old two-factor behaviour exactly.
    upb_plan = targets.get("units_per_buyer") or 1.0
    _prow = people[people["release_name"] == name] if people is not None and len(people) else None
    upb_actual = upb_plan
    if _prow is not None and len(_prow):
        _b = float(_prow.iloc[0].get("buyers") or 0.0)
        _u = float(_prow.iloc[0].get("units") or 0.0)
        if _b > 0 and _u > 0:
            upb_actual = _u / _b
    gtargets = group_targets(targets)
    # K, and the basket's own pace. Both plans are drawn off the same curve so
    # target and benchmark stay in exactly the K ratio on every day (§4.1) -
    # which is what makes an even uplift legible on the trajectory.
    k = (float(release["edition_size"]) / profile["units"]) if bench else 1.0
    # each group's own uplift: K for every group unless the stretch was placed
    # on the Target setting tab (benchmark_targets, §4.4)
    kg = dict((targets or {}).get("k_by_group") or {}) if bench else {}
    bm_units = profile["units_by_group"] if bench else {}
    bm_sessions = profile["sessions_by_group"] if bench else {}
    rcurves = basket_curves(at, basket, curves) if bench else curves

    rat = at[at["simple_release_name"] == name].copy()
    rat["group"] = rat["channel"].map(GROUP_OF)
    # the days the page counts sales over, on every card alike (docs 6.3): the
    # private room or the announce, or the first paid order when it came
    # earlier, to two days after the close; the units in it are the orders
    # table's, each on its own purchase event's channel
    urows = units_rows(name)
    # a draw that ran past the typed close has its winners pay when it ends:
    # the window counts to the draw's end (sales_close), folded into the
    # close day below, while the plan keeps the typed dates
    sales_end, drew_to = sales_close(name, launch_end)
    if drew_to is not None and not direct_spread:
        print(f"{release['id']}: the draw ran to {drew_to}, past the close of {launch_end}: "
              f"sales count to {sales_end} plus the grace")
    window_start, window_end, first_paid = sales_window(urows, min(pr_open, announce), announce, sales_end, as_of)
    closed = as_of > sales_end + timedelta(days=UNITS_GRACE_DAYS)
    win = rat[(rat["event_date"] >= window_start) & (rat["event_date"] <= window_end)]
    win, uinfo = swap_units(win, name, urows, window_start, window_end,
                            sales_end + timedelta(days=UNITS_GRACE_DAYS))
    if closed and not direct_spread:
        late_paid_warning(release["id"], urows, window_end, uinfo)
    # how much of the window has no channel, read before the fold below hides it
    untracked = untracked_block(win, untracked_norms)
    untracked["noEvent"] = uinfo["noEvent"]
    pre = win
    # Fold Untracked into the tracked channels ONCE, here, so the group rollups
    # below and the release-level sums further down agree (docs §1.3).
    win = redistribute_untracked(win)
    # Direct's share of the window as the funnel attributes it, read before
    # the Direct switch's spread (below) moves it: the switch's tooltip
    direct_share = channel_share(win, "Direct")
    if direct_spread:
        win = redistribute_channel(win, "Direct")
    if uinfo["source"] == "orders":
        win = keep_units(win, uinfo["total"], pre)
    # once the window has shut, nothing in hand counts (docs 6.3): the
    # entries left unconverted are the draw's losers, so every channel, day
    # and part reads its own units paid rather than a share weighted by them
    if closed:
        win = win.assign(Draw_Entries_Total_Units_No_Conv=0.0)
    of_win = orders_in_window(name, urows, window_start, window_end, closed, uinfo["source"])
    # Orders from draw winners land in the two days after close. win keeps
    # them (that is what the grace is for) but the daily series ends at close,
    # so the hero, the channels and sell-through disagreed by exactly those
    # units - and "secured" could read below "sold". Fold them into the close
    # day: at close then includes what the close triggered.
    win = win.assign(event_date=win["event_date"].where(win["event_date"] <= launch_end, launch_end))

    # daily series per display group: actual cumulative entries + plan
    days = list(daterange(window_start, launch_end))
    # the last full day, and the share of the newest day seen: the part day is
    # in the actuals, the rules read full days, the references sit at the share
    full_through = full_through or as_of
    seen = 1.0 if full_through >= as_of else seen
    complete = full_through >= launch_end
    # where today sits on the campaign clock, at the share of it seen
    pdsa_today = pdsa_for(release, min(as_of, launch_end))
    if as_of <= launch_end and L > 0:
        pdsa_today = max(pdsa_today - (1 - seen) / L, 0.0)

    by_group_day = (win.groupby(["group", "event_date"])
                    .agg(sessions=("Sessions_Total", "sum"),
                         entries=("Draw_Entries_Eligible_Units", "sum"),
                         entries_no_conv=("Draw_Entries_Total_Units_No_Conv", "sum"),
                         units=("Total_Product_Units", "sum"))
                    .reset_index())

    # ---- paid actuals + forward model, computed first: the paid channel's projection
    # is projected spend ÷ projected cost-per-entry, not a trajectory curve (docs §5.4)
    camp = release.get("campaign_name")
    camps = [c for c in (release.get("campaign_names") or ([camp] if camp else [])) if c]
    psp = spend[spend["campaign_name"].isin(camps)] if camps else spend.iloc[0:0]
    psp = psp[(psp["spend_date"] >= window_start) & (psp["spend_date"] <= min(as_of, launch_end))]
    paid_entries_day = (win[win["channel"] == "Paid Social"]
                        .groupby("event_date")["Draw_Entries_Eligible_Units"].sum())
    spend_day = psp.groupby("spend_date")["spend"].sum()
    # a converting entry is one that becomes an order: the release's own
    # entry -> order rate (Target setting), else the panel's, the same rate
    # the secured units and the targets' eligible entries are read at
    drop, cann = round(1 - entry_rate(release), 4), cannibalisation_for(release, b)
    ppu_aa = aa_profit_per_unit(release, b)
    frame_conv, frame_profit = frame_terms(release, b)
    ppu_artist = (release["artist_profit"] / release["edition_size"]) if release["edition_size"] else 0
    # Who funds the ads: as the profit divides (resolve_release). Each
    # product's deal - its profit share, or all of it on a revenue share -
    # else the release's typed share or its profit split (legacy_budget_share,
    # e.g. Glenn Ligon's 100% AA); half, flagged as assumed, when nothing says.
    aa_budget_share = release.get("aa_budget_share")
    budget_assumed = bool(release.get("aa_budget_share_assumed"))
    if aa_budget_share is None:
        aa_budget_share, budget_assumed = legacy_budget_share(release.get("artist_profit_share"))
    artist_budget_share = max(0.0, 1.0 - float(aa_budget_share))

    def party_roi(ppu: float, share: float, adj_cpe: float | None) -> float | None:
        """ROI_party (docs 7): a party's profit on a converting entry, net of
        cannibalisation, over what that entry cost the party. None when the
        cost is unknown or the party carries none of the spend (the artist on
        a revenue-share deal), so there is no ROI to read."""
        if not adj_cpe or share <= 0:
            return None
        return (1 - cann) * ppu / (adj_cpe * share)

    # daily 'roi' is the trailing-3-CALENDAR-day rolling ROI: a window with
    # spend but no entries is a genuine 0, a window with no spend is null.
    # AA's reading is 'roi', the artist's 'roiArtist': the same days, the
    # artist's profit per unit over the artist's share of the spend. 'roi1'
    # and 'roiArtist1' are the day's own reading on the same rule (the card's
    # 1d switch): one day's spend over that day's entries.
    paid_daily = []
    cum_spend = cum_pentries = 0.0
    win3: list[tuple[float, float]] = []
    # the clock the cost path runs on (docs §7): what the release's campaigns
    # had spent before each day, any spend ahead of the window included
    spent_before_window = float(spend[spend["campaign_name"].isin(camps)
                                      & (spend["spend_date"] < window_start)]["spend"].sum()) if camps else 0.0
    # the close's lift as fitted: the window's price is read underneath it
    # and the campaign's own terms are fitted with it held (campaign_cost_terms).
    # The path lifts its own last days by it with cpe_close_lift_applied on,
    # the rush being the final days' own paid sign-ups entering at once (docs
    # §7); off, the path runs on the curve alone and the fit keeps the lift
    close_lift = [float(v) for v in (b.get("cpe_close_lift") or [])]
    path_lift = close_lift if b.get("cpe_close_lift_applied") else []
    # the window's days: (spend, spent before the day, the close's lift on the day)
    clock3: list[tuple[float, float, float]] = []
    for d in days:
        if d > min(full_through, launch_end):
            break
        s = float(spend_day.get(d, 0.0))
        e = float(paid_entries_day.get(d, 0.0))
        to_close = (launch_end - d).days
        clock3.append((s, spent_before_window + cum_spend,
                       close_lift[to_close] if 0 <= to_close < len(close_lift) else 1.0))
        cum_spend += s; cum_pentries += e
        win3.append((s, e))
        if len(win3) > 3:
            win3.pop(0)
            clock3.pop(0)
        s3 = sum(x for x, _ in win3); e3 = sum(y for _, y in win3)
        adj3 = (s3 / (e3 * (1 - drop))) if s3 > 0 and e3 > 0 else None
        roi3 = None if s3 <= 0 else 0.0 if e3 <= 0 else party_roi(ppu_aa, aa_budget_share, adj3)
        roi3_artist = (None if s3 <= 0 or artist_budget_share <= 0 else 0.0 if e3 <= 0
                       else party_roi(ppu_artist, artist_budget_share, adj3))
        adj1 = (s / (e * (1 - drop))) if s > 0 and e > 0 else None
        roi1 = None if s <= 0 else 0.0 if e <= 0 else party_roi(ppu_aa, aa_budget_share, adj1)
        roi1_artist = (None if s <= 0 or artist_budget_share <= 0 else 0.0 if e <= 0
                       else party_roi(ppu_artist, artist_budget_share, adj1))
        paid_daily.append({"date": d.isoformat(), "spend": round(s, 2), "entries": e,
                           "roi": round(roi3, 3) if roi3 is not None else None,
                           "roiArtist": round(roi3_artist, 3) if roi3_artist is not None else None,
                           "roi1": round(roi1, 3) if roi1 is not None else None,
                           "roiArtist1": round(roi1_artist, 3) if roi1_artist is not None else None})
    # the part day so far: in the to-date figures, never in the rules
    part_spend = part_entries = 0.0
    if full_through < as_of <= launch_end:
        part_spend = float(spend_day.get(as_of, 0.0))
        part_entries = float(paid_entries_day.get(as_of, 0.0))
    # trailing 3-calendar-day CPE (adjusted = per expected-converting unit);
    # CPE stays unknown when the window bought no entries - the ROI reads 0
    s3 = sum(x for x, _ in win3); e3 = sum(y for _, y in win3)
    l3d_raw_cpe = s3 / e3 if e3 > 0 else None
    l3d_cpe = l3d_raw_cpe / (1 - drop) if l3d_raw_cpe else None
    cum_adj_cpe = cum_spend / (cum_pentries * (1 - drop)) if cum_pentries else None
    cum_roi = party_roi(ppu_aa, aa_budget_share, cum_adj_cpe)
    l3d_roi = party_roi(ppu_aa, aa_budget_share, l3d_cpe) if l3d_cpe else (0.0 if s3 > 0 else None)
    # the artist's reading of the same days: None throughout when the artist
    # carries none of the spend
    cum_roi_artist = party_roi(ppu_artist, artist_budget_share, cum_adj_cpe)
    l3d_roi_artist = (party_roi(ppu_artist, artist_budget_share, l3d_cpe) if l3d_cpe
                      else (0.0 if s3 > 0 and artist_budget_share > 0 else None))
    # the last full day alone (the card's 1d switch): the same working on one
    # day's spend and entries, the quickest read and the noisiest; unknown
    # when that day bought no entries, nothing when it spent nothing
    s1, e1 = win3[-1] if win3 else (0.0, 0.0)
    l1d_raw_cpe = s1 / e1 if e1 > 0 else None
    l1d_cpe = l1d_raw_cpe / (1 - drop) if l1d_raw_cpe else None
    l1d_roi = party_roi(ppu_aa, aa_budget_share, l1d_cpe) if l1d_cpe else (0.0 if s1 > 0 else None)
    l1d_roi_artist = (party_roi(ppu_artist, artist_budget_share, l1d_cpe) if l1d_cpe
                      else (0.0 if s1 > 0 and artist_budget_share > 0 else None))

    # ---- one forward cost path (docs §7), read by the paid projection, the
    # ROI chart and the recommendation alike. Cost per entry rises with the
    # campaign's spend so far - each doubling of what it has spent makes the
    # next entry 2^w times dearer - and, a little, with the day's budget. The
    # fixed drift a day it replaces fitted the panel worse (47 campaigns,
    # etl/analysis/cpe_elasticity.py) and could not say that a bigger budget
    # wears the audience out faster. The campaign's own curve, shrunk to the
    # panel's priors where it has the days for one (campaign_cost_terms).
    cost_terms = campaign_cost_terms(paid_daily, b, spent_before=spent_before_window, close=launch_end)
    eps, wear, wear_k = cost_terms["elasticity"], cost_terms["wearout"], cost_terms["wearoutK"]
    spent_so_far = spent_before_window + cum_spend        # through the last full day
    # the anchor: the window's price, paid at its daily spend and at its
    # spend-weighted place on the clock
    w_spend = sum(x for x, _, _ in clock3)
    spend_ref = w_spend / max(sum(1 for x, _, _ in clock3 if x > 0), 1) if w_spend > 0 else None
    clock_ref = sum(x * c for x, c, _ in clock3) / w_spend if w_spend > 0 else spent_so_far
    # a window in the draw's last days paid a price the rush had cut
    anchor_lift = sum(x * lf for x, _, lf in clock3) / w_spend if w_spend > 0 else 1.0
    future_days = list(daterange(full_through + timedelta(days=1), launch_end))
    cost = (CostPath(l3d_cpe, spend_ref, clock_ref, spent_so_far, len(future_days), eps, wear, wear_k,
                     lift=path_lift, anchor_lift=anchor_lift)
            if l3d_cpe else None)
    forecast_cpe = l3d_cpe                                # the window's price (per converting unit)

    units_sold = float(win["Total_Product_Units"].sum())
    entries_banked = float(win["Draw_Entries_Total_Units_No_Conv"].sum())
    inventory_left = max(edition_total(release) - units_sold, 0)
    # Sell-out sizing: paid only tops up the gap ORGANIC is not on course to
    # fill. Net off what is already secured (banked entries count at 0.8) plus
    # the same shape-following organic projection the channel loop below runs
    # (docs §5.4), then price only the residual entries.
    # what is spoken for today by the sell-through's own count (docs 6.3):
    # units paid, drafts raised and the winners the entries in hand imply -
    # the figure the hero adopts once the channels are built, so paid is
    # sized against the same count the page prints
    secured_now = spoken_for(sellthrough_block(release, name, units_sold, entries_banked, inventory_left,
                                               orders=of_win, closed=closed))
    organic_future = 0.0
    if not complete:
        pdsa_now = pdsa_today
        obs = by_group_day[by_group_day["event_date"] <= min(as_of, launch_end)]
        for og in DISPLAY_GROUPS:
            if og == "paid":
                continue
            sub_g = obs[obs["group"] == og]
            now_g = (float(sub_g["units"].sum())
                     + entry_rate(release) * float(sub_g["entries_no_conv"].sum()))
            tgt_g = gtargets[og]["units"]
            w_g = curve_value(rcurves, og, UNIT_PLAN_CURVE, pdsa_now)   # the channel loop's w
            r_perf = min(max((now_g / (tgt_g * w_g)) if tgt_g * w_g > 0 else 1.0, 0.25), 2.5)
            organic_future += tgt_g * (1 - w_g) * (1 + w_g * (r_perf - 1))
    sellout_gap = max(release["edition_size"] - secured_now - organic_future, 0.0)
    entries_needed = sellout_gap / (1 - drop)      # every unit is asked for as an entry at the rate
    days_left = max((launch_end - full_through).days, 0)
    past_spend = spend_day[spend_day.index <= full_through]
    current_daily = float(past_spend.get(full_through, past_spend.iloc[-1] if len(past_spend) else 0.0))

    # ---- the recommendation (docs §7).
    # Price: the entries a recommendation asks for are priced on the cost path
    # at the spend it recommends - dearer for the bigger day (the elasticity)
    # and for the faster climb in spend so far (the wear-out) - the path the
    # ROI chart draws at today's spend. Units: sellout_gap is units, the price
    # is euros per converting unit (raw CPE / (1 - drop-off)).
    rules = b["spend_rules"]
    s0 = current_daily if current_daily > 0 else 0.0
    # at close at today's spend: where the chart's line ends
    cpe_end = cost.cpe_close(s0) if cost else None
    # the plan's daily rate: the paid budget over the days paid runs, the day
    # after the announce to the close (PAID_START_DAYS)
    plan_rate = (targets["paid"]["budget"] / max(L - PAID_START_DAYS, 1)) if L else 0.0
    cpe_max = (1 - cann) * ppu_aa / (b["roi_floor"] * aa_budget_share)   # price at the ROI floor

    supply_spend = roi_spend = None
    if cost and days_left:
        # the flat daily spend that buys the gap by the close, on the path
        supply_spend = 0.0 if sellout_gap <= 0 else cost.spend_for_units(sellout_gap)
        # the ROI floor is a floor on ROI AT CLOSE, on the same path - the
        # point the chart's dotted line ends on at today's spend
        roi_spend = cost.spend_for_cpe_close(cpe_max)

    # the workbook's pacing rules, transcribed into the benchmarks but never
    # applied until now: cumulative ROI below 0.9 -> decrease, above 1.3 ->
    # increase, between -> hold; daily change capped at 30%; changes under 10%
    # ignored; the trailing 3-day ROI below target on each of the last 3 full
    # days forces a decrease.
    band = "hold"
    if cum_roi is not None:
        if cum_roi < rules["decrease_below_cum_roi"]:
            band = "decrease"
        elif cum_roi > rules["increase_above_cum_roi"]:
            band = "increase"
    recent = [x["roi"] for x in paid_daily[-rules["forced_decrease_after_days_below_target"]:]]
    forced = (len(recent) == rules["forced_decrease_after_days_below_target"]
              and all(r is not None and r < b["target_roi_aa"] for r in recent))
    # the LE template's own zero-conversion rules: a day that spent and bought
    # no entries cuts 30%; three in a row pause the campaign
    zero_days = 0
    for x in reversed(paid_daily):
        if x["spend"] > 0 and x["entries"] <= 0:
            zero_days += 1
        else:
            break
    zero_pause = zero_days >= rules.get("zero_conversion_days_to_pause", 3)
    zero_cut = zero_days >= 1 and not zero_pause

    recommended, cap, paced = None, None, False
    if supply_spend is not None and days_left:
        unconstrained = min(supply_spend, roi_spend)
        base = "supply" if supply_spend <= roi_spend else "roi_floor"
        # nothing needed: the edition is secured without paid, so it stops. A
        # floor no spend can meet (the cost path's price at the close is past
        # it however small the day) is a cut like any other, held to 30% a
        # day by the pacing rule below, unless nothing is running to cut
        if unconstrained <= 0 and (base == "supply" or s0 <= 0):
            recommended, cap = 0.0, base
        elif zero_pause and s0 > 0:
            recommended, cap = 0.0, "zero_conversion_pause"
        elif zero_cut and s0 > 0:
            recommended = min(unconstrained, s0 * (1 - rules.get("zero_conversion_decrease", 0.3)))
            if recommended <= 0:                    # a floor no spend meets: still a paced cut
                recommended, paced = s0 * (1 - rules["max_daily_change"]), True
            cap = "zero_conversion"
        elif s0 <= 0:
            recommended = min(unconstrained, plan_rate) if plan_rate else unconstrained
            cap = "plan_rate" if recommended < unconstrained else base   # first day: the plan's daily rate
        else:
            lo, hi = s0 * (1 - rules["max_daily_change"]), s0 * (1 + rules["max_daily_change"])
            if forced or band == "decrease":
                ceiling, band_cap = lo, ("forced_decrease" if forced else "roi_band_decrease")
            elif band == "hold":
                ceiling, band_cap = s0, "roi_band_hold"
            else:
                ceiling, band_cap = hi, "pacing"
            recommended = min(unconstrained, ceiling)
            cap = base if recommended == unconstrained else band_cap
            if recommended < lo:                    # a cut is still limited to 30% a day
                recommended, paced = lo, True
            if abs(recommended - s0) < rules["ignore_change_below"] * s0:
                recommended, cap = s0, "hold_small_change"
    cpe_rec = cost.cpe_close(recommended) if (cost and recommended) else None
    final_day_roi = party_roi(ppu_aa, aa_budget_share, cpe_rec)
    final_day_roi_artist = party_roi(ppu_artist, artist_budget_share, cpe_rec)
    # the chart's line: ROI at today's spend along the cost path, each party
    # on the same path (a window that bought nothing reads 0 all the way)
    path_now = cost.multipliers(s0) if cost else [1.0] * len(future_days)
    roi_path = ([{"date": d.isoformat(), "roi": round(l3d_roi / f, 3)} for d, f in zip(future_days, path_now)]
                if l3d_roi is not None and not complete else [])
    roi_path_artist = ([{"date": d.isoformat(), "roi": round(l3d_roi_artist / f, 3)} for d, f in zip(future_days, path_now)]
                       if l3d_roi_artist is not None and not complete else [])
    # the rise to the close underneath the close's lift: the worst day, where
    # the floor is read (cpeAtClose), and the fallback factor's fall
    wear_end = cost.multipliers(s0, lifted=False)[-1] if (cost and future_days) else 1.0
    # the path's average fall a day, for a reader that draws the line from a factor
    daily_factor = round((1 / wear_end) ** (1 / len(path_now)), 4) if path_now else 1.0

    # forward path: projected spend ÷ projected cost-per-entry per future day.
    # Projections describe the CURRENT trajectory (spend run-rate as-is); the
    # recommended budget is the intervention shown alongside, not the projection.
    # The price follows the cost path at that spend, the path above.
    planned_spend = current_daily if current_daily > 0 else (
        recommended if (days_left and recommended) else 0.0)
    paid_future = {}          # date -> cumulative projected entries beyond today
    future_cum = 0.0
    path_plan = cost.multipliers(planned_spend) if (cost and planned_spend) else []
    if not complete:
        prev_curve = curve_value(rcurves, "paid", "entries", pdsa_today)
        for i, d in enumerate(future_days):
            # the part day counts for what is left of it
            share = (1 - seen) if (d == as_of and as_of > full_through) else 1.0
            if l3d_raw_cpe and planned_spend and path_plan:
                future_cum += share * planned_spend / (l3d_raw_cpe * path_plan[i])
            else:
                # no spend history yet: fall back to the paid target trajectory
                cv = curve_value(rcurves, "paid", "entries", pdsa_for(release, d))
                future_cum += gtargets["paid"]["entries"] * max(cv - prev_curve, 0.0)
                prev_curve = cv
            paid_future[d] = future_cum
    # the days still to run at the run rate, on the entries' own clock: each
    # full day after the last one seen, today's for what is left of it. The
    # spend at close is the spend to date (today so far included) plus the
    # run rate over these, as the units beside it are
    rest_days = sum(((1 - seen) if (d == as_of and as_of > full_through) else 1.0)
                    for d in daterange(full_through + timedelta(days=1), launch_end))

    channels_out = []
    hero_now = hero_exp = hero_target = hero_proj = 0.0
    hero_bm = hero_bm_today = 0.0        # benchmark at close, benchmark by today
    funnel_by_group = {}
    email_sess = {}                      # AA Email's sessions by today, plan and basket, unrounded
    e2o = entry_rate(release)
    # Paid follows spend, and spend is planned evenly over the days paid runs:
    # from the day after the announce (PAID_START_DAYS) to the close. So the
    # paid plan by any day is the even share of the target over those days -
    # not the panel's historic paid shape, which starts near zero and told the
    # channel card there was nothing to expect on days when the paid card,
    # reading the even plan, showed the units bought. One plan, three cards.
    def paid_pace(frac: float) -> float:
        days = float(frac) * L - PAID_START_DAYS
        return min(max(days / max(L - PAID_START_DAYS, 1), 0.0), 1.0)
    for g, spec in DISPLAY_GROUPS.items():
        sub = by_group_day[by_group_day["group"] == g].set_index("event_date")
        # SECURED UNITS - the unified page currency (docs §6.4):
        #   secured = units sold (all routes) + 0.8 x eligible entry units not yet
        #   converted. Group unit targets sum to the edition size (sellout).
        tgt = gtargets[g]["units"]
        sess_tgt = gtargets[g]["sessions"]
        bm_tgt = bm_units.get(g, 0.0)      # this group's benchmark at close
        daily = []
        cum_u = cum_nc = cum_s = 0.0
        for d in days:
            row = sub.loc[d] if d in sub.index else None
            cum_u += float(row["units"]) if row is not None else 0.0
            cum_nc += float(row["entries_no_conv"]) if row is not None else 0.0
            cum_s += float(row["sessions"]) if row is not None else 0.0
            p = pdsa_for(release, d)
            # paid: the even share of its days; the rest: the entry-timed curve
            cv = paid_pace(p) if g == "paid" else curve_value(rcurves, g, UNIT_PLAN_CURVE, p)
            # in benchmark mode the plan IS the benchmark lifted by the
            # group's uplift, taken off the one curve, so the two lines the
            # trajectory draws are in that ratio on every day rather than
            # only in total (§4.1)
            bm_day = bm_tgt * cv
            plan = bm_day * kg.get(g, k) if bench else tgt * cv
            row_out = {"date": d.isoformat(),
                       "actual": round(cum_u + e2o * cum_nc, 2) if d <= as_of else None,
                       "plan": round(plan, 2), "proj": None}
            if bench:
                row_out["bm"] = round(bm_day, 2)
            daily.append(row_out)
        # the share of the campaign observed: per the group's historic
        # entry-timed shape (UNIT_PLAN_CURVE), and for paid the even daily
        # budget's share (see paid_pace above)
        w = paid_pace(pdsa_today) if g == "paid" else curve_value(rcurves, g, UNIT_PLAN_CURVE, pdsa_today)
        bm_exp = bm_tgt * w                                # benchmark pace by today
        exp = bm_exp * kg.get(g, k) if bench else tgt * w
        sess_w = paid_pace(pdsa_today) if g == "paid" else curve_value(rcurves, g, "sessions", pdsa_today)
        sess_exp = sess_tgt * sess_w
        now = next((r["actual"] for r in reversed(daily) if r["actual"] is not None), 0.0)
        # Forward projection (docs §5.4): the remaining volume follows this channel's
        # HISTORIC entry-timed shape curve; its level scales with demonstrated performance
        # (actual/expected), trusted in proportion to how much of the campaign the
        # curve says we have observed. Paid instead projects spend ÷ efficiency
        # (future entries convert to units at 0.8).
        if complete:
            proj = now
        elif g == "paid":
            proj = now + future_cum * e2o
            for d, cum_f in paid_future.items():
                i = (d - window_start).days
                if 0 <= i < len(daily):
                    daily[i]["proj"] = round(now + cum_f * e2o, 2)
        else:
            r_perf = min(max((now / exp) if exp > 0 else 1.0, 0.25), 2.5)
            r_shrunk = 1 + w * (r_perf - 1)
            proj = now + tgt * (1 - w) * r_shrunk
            for d in daterange(full_through + timedelta(days=1), launch_end):
                i = (d - window_start).days
                cv = curve_value(rcurves, g, UNIT_PLAN_CURVE, pdsa_for(release, d))
                frac = (cv - w) / (1 - w) if w < 1 else 1.0
                if 0 <= i < len(daily):
                    daily[i]["proj"] = round(now + (proj - now) * max(min(frac, 1.0), 0.0), 2)
        # Three-factor decomposition: units = sessions x buyers-per-session x
        # units-per-buyer, repriced one factor at a time, so the three steps
        # still sum exactly to the gap (docs §9, BENCHMARK_SPEC §4.2). The old
        # single conversion step conflated "more people bought" with "people
        # bought more", which on a multi-product release are different problems
        # with different fixes, so it is split in two. Their sum is the old
        # step, to the last unit, which is what keeps every roll-up below
        # unchanged.
        conv_exp = (exp / sess_exp) if sess_exp else 0.0
        conv_act = (now / cum_s) if cum_s else 0.0
        traffic = (cum_s - sess_exp) * conv_exp
        conversion = (conv_act - conv_exp) * cum_s
        # the multi-buy rate is measured for the release, not per channel: the
        # only trustworthy buyer count is the release's own distinct one
        ratio = (upb_plan / upb_actual) if upb_actual else 1.0
        buyer_conv = cum_s * (conv_act * ratio - conv_exp)
        per_buyer = now * (1.0 - ratio)
        funnel_by_group[g] = {
            "sessions_actual": round(cum_s, 1), "sessions_expected": round(sess_exp, 1),
            "conv_actual": conv_act, "conv_expected": conv_exp,
            "contrib_traffic": round(traffic, 1), "contrib_conversion": round(conversion, 1),
            # buyers per session, the half of conversion a campaign can act on
            "bps_actual": (conv_act / upb_actual) if upb_actual else 0.0,
            "bps_expected": (conv_exp / upb_plan) if upb_plan else 0.0,
            "contrib_buyers": round(buyer_conv, 1), "contrib_per_buyer": round(per_buyer, 1),
        }
        if g == "aa_email":
            email_sess = {"plan": sess_exp, "bm": bm_sessions.get(g, 0.0) * sess_w if bench else None}
        if bench:
            # The funnel cards are always Today (§2), so the benchmark they sit
            # against is the benchmark pace by today - the same point the target
            # is read at, which keeps the rung's ring at exactly x K. The rate
            # is the basket's own conversion, held (§1).
            funnel_by_group[g]["sessions_benchmark"] = round(bm_sessions.get(g, 0.0) * sess_w, 1)
            # conv_actual and conv_expected on this card are SECURED UNITS per
            # session; the panel's conv_sess_entry is eligible ENTRIES per
            # session, a different and larger quantity. Reading one against the
            # other turned "on plan" into a red rung, so the benchmark is taken
            # in the card's own currency: the basket's median units over its
            # median sessions, for this group.
            bm_s = bm_sessions.get(g, 0.0)
            funnel_by_group[g]["conv_benchmark"] = (bm_units.get(g, 0.0) / bm_s) if bm_s else 0.0
            # The same three factors against the basket instead of the target:
            # the walk the waterfalls take once the stretch has been set aside
            # (BENCHMARK_SPEC 9). The basket's sessions by today and the units
            # per session its pace implies, repriced one factor at a time, so
            # the steps sum to now - bm_exp exactly as the target's sum to
            # now - exp. The multi-buy rate is a rate, so it is the same on
            # both sides.
            sess_bm = bm_sessions.get(g, 0.0) * sess_w
            conv_bmx = (bm_exp / sess_bm) if sess_bm else 0.0
            funnel_by_group[g].update({
                "conv_benchmark_today": conv_bmx,
                "contrib_traffic_bm": round((cum_s - sess_bm) * conv_bmx, 1),
                "contrib_conversion_bm": round((conv_act - conv_bmx) * cum_s, 1),
                "contrib_buyers_bm": round(cum_s * (conv_act * ratio - conv_bmx), 1),
                "contrib_per_buyer_bm": round(per_buyer, 1),
            })
        # what a grouped column is made of, secured units to date, biggest first
        parts = []
        for ch in spec["channels"]:
            sub_ch = win[win["channel"] == ch]
            if sub_ch.empty:
                continue
            v = (float(sub_ch["Total_Product_Units"].sum())
                 + e2o * float(sub_ch["Draw_Entries_Total_Units_No_Conv"].sum()))
            if v > 0.05:
                parts.append({"name": ch, "value": round(v, 1)})
        parts.sort(key=lambda x: -x["value"])
        channel = {
            "key": g, "name": spec["name"],
            "now": round(now, 1), "exp": round(exp, 1),
            "proj": round(proj, 1), "target": round(tgt, 1),
            "parts": parts,
            "daily": daily,
        }
        if bench:
            channel["bm"] = round(bm_tgt, 1)
            channel["bmExp"] = round(bm_exp, 1)
        channels_out.append(channel)
        hero_now += now; hero_exp += exp; hero_target += tgt; hero_proj += proj
        hero_bm += bm_tgt; hero_bm_today += bm_exp

    # ---- sell-through: the release-level prediction, and per product where
    # the event feed has the draws (docs §6.3, sellthrough_block)
    unconverted = float(win["Draw_Entries_Total_Units_No_Conv"].sum())
    # units still to come = the shaped secured-units projection beyond today (docs §5.4/§6.4)
    future_entries = 0.0 if complete else max(hero_proj - hero_now, 0.0)
    sellthrough = sellthrough_block(release, name, units_sold, unconverted, inventory_left, future_entries,
                                    expected_today=hero_exp, bm_today=hero_bm_today if bench else None,
                                    bm_close=hero_bm if bench else None, orders=of_win, closed=closed)
    if uinfo["source"] == "orders":
        sellthrough["unitsOutsideWindow"] = {"before": uinfo["before"], "after": uinfo["after"], "pending": uinfo["pending"]}
    # the hero adopts the sell-through's count (docs 6.3½): what the orders
    # and draw feeds say is spoken for - units paid, drafts raised, the
    # winners the entries in hand imply by the per-product rule - and the
    # funnel's channels are scaled to it in proportion, so they still sum to
    # the hero and every card reads one figure
    hero_now, hero_proj = adopt_sellthrough(sellthrough, channels_out, funnel_by_group, hero_now, hero_proj,
                                            complete, upb_plan, upb_actual)

    # ---- paid block output (docs §7; inputs computed above, before the channel loop)
    # the part day so far rides at the end of the series, marked, so the ROI
    # chart's bars sum to the spend to date the paid card reads; the rules,
    # the cost fit and the rolling ROI above read the full days only
    if full_through < as_of <= launch_end:
        paid_daily.append({"date": as_of.isoformat(), "spend": round(part_spend, 2), "entries": part_entries,
                           "roi": None, "roiArtist": None, "roi1": None, "roiArtist1": None, "partial": True})
    # the paid group's own column on the channels card: secured units (units
    # sold + 0.8 x unconverted entries, every paid channel), so the paid card's
    # units bar and that column cannot disagree
    paid_ch = next((c for c in channels_out if c["key"] == "paid"), None)
    paid_out = {
        "daily": paid_daily,
        "spendToDate": round(cum_spend + part_spend, 2),
        "entriesToDate": cum_pentries + part_entries,
        # secured units to date, the same currency as unitTarget, unitProjected
        # and benchmarkUnits: the channels card's paid figure, not the paid
        # entries one drop-off later, which counted a sale as 0.8 of a unit
        "unitsToDate": paid_ch["now"] if paid_ch else round((cum_pentries + part_entries) * (1 - drop), 1),
        "cumRoi": round(cum_roi, 3) if cum_roi else None,
        "l3dRoi": round(l3d_roi, 3) if l3d_roi is not None else None,
        "l3dCpe": round(l3d_cpe, 2) if l3d_cpe else None,
        "l1dRoi": round(l1d_roi, 3) if l1d_roi is not None else None,
        "l1dCpe": round(l1d_cpe, 2) if l1d_cpe else None,
        "cumCpe": round(cum_adj_cpe, 2) if cum_adj_cpe else None,
        "roiDeclineModel": {"start": round(l3d_roi, 3) if l3d_roi is not None else None,
                            "dailyFactor": daily_factor},
        "roiPath": roi_path,
        "roiTarget": b["target_roi_aa"],
        "budget": {
            "current": round(current_daily, 2),
            "recommended": round(recommended, 2) if recommended is not None and recommended != math.inf else None,
            "cap": cap, "finalDayRoi": round(final_day_roi, 3) if final_day_roi else None,
            "floor": b["roi_floor"],
            "budgetToSellOut": round(supply_spend * days_left, 2) if supply_spend not in (None, math.inf) else None,
            "supplySpend": round(supply_spend, 2) if supply_spend not in (None, math.inf) else None,
            "roiSpend": round(roi_spend, 2) if roi_spend not in (None, math.inf) else None,
            "cpeAtRecommended": round(cpe_rec, 2) if cpe_rec else None,
            "cpeNow": round(forecast_cpe, 2) if forecast_cpe else None,
            "cpeAtClose": round(cpe_end, 2) if cpe_end else None,
            # the price at close over the window's, at today's spend
            "wearToClose": round(wear_end, 3),
            "paced": paced,
            # the cost curve in force and where it came from (campaign_cost_terms)
            "elasticity": eps,
            "wearout": wear,
            "wearoutK": wear_k,
            "spentSoFar": round(spent_so_far, 2),
            # the anchor: the daily spend and the spend so far the window's
            # price was paid at, so the path can be rebuilt from the block
            "spendAtWindow": round(spend_ref, 2) if spend_ref else None,
            "spentAtWindow": round(clock_ref, 2),
            # the lift the path puts on its last days ([] with
            # cpe_close_lift_applied off) and the one taken out of the window's
            # price
            "closeLift": path_lift,
            "liftAtWindow": round(anchor_lift, 4),
            "costTerms": cost_terms,
            "band": band, "forcedDecrease": forced, "zeroConversionDays": zero_days,
            "cumRoi": round(cum_roi, 3) if cum_roi else None,
            "entriesNeeded": round(entries_needed, 1),
            "selloutGap": round(sellout_gap, 1),
            "organicFuture": round(organic_future, 1),
            "daysLeft": days_left,
        },
        "unitTarget": targets["paid"]["units"],
        # the entries in hand, today's so far included, and those still to come
        # (future_cum counts only the rest of today), so the projection at close
        # cannot read below the entries already in
        "entriesProjected": round(cum_pentries + part_entries + future_cum, 1),
        "unitProjected": paid_ch["proj"] if paid_ch else round((cum_pentries + part_entries + future_cum) * (1 - drop), 1),
        "spendBudget": round(targets["paid"]["budget"], 2),
        "spendProjectedTotal": round(cum_spend + part_spend + (planned_spend or 0) * rest_days, 2),
        "profitPerUnitAA": round(ppu_aa, 2),
        "profitPerUnitArtist": round(ppu_artist, 2),
        "aaBudgetShare": aa_budget_share,
        # no deal recorded anywhere: the half is an assumption, and the card says so
        "aaBudgetShareAssumed": budget_assumed,
        # the terms every ROI above is read with, so the card can show its working
        "cannibalisation": cann,
        "dropOff": drop,
        # paid runs from this many days after the announce to the close: the
        # plan by today and the daily rate are read over those days (docs 7)
        "paidStartDays": PAID_START_DAYS,
        "paidDays": max(L - PAID_START_DAYS, 1),
        # the spend feed's currency and the fixed rate it was converted at
        "spendCurrency": SPEND_CURRENCY,
        "spendRate": spend_rate(),
        # the artist's ROI (docs 7): the same days and the same forward path,
        # with the artist's profit per unit and share of the spend. Every
        # figure is None on a deal where the artist carries no spend.
        "artist": {
            "cumRoi": round(cum_roi_artist, 3) if cum_roi_artist else None,
            "l3dRoi": round(l3d_roi_artist, 3) if l3d_roi_artist is not None else None,
            "l1dRoi": round(l1d_roi_artist, 3) if l1d_roi_artist is not None else None,
            "roiDeclineModel": {"start": round(l3d_roi_artist, 3) if l3d_roi_artist is not None else None,
                                "dailyFactor": daily_factor},
            "roiPath": roi_path_artist,
            "finalDayRoi": round(final_day_roi_artist, 3) if final_day_roi_artist else None,
            "profitPerUnit": round(ppu_artist, 2),
            "budgetShare": round(artist_budget_share, 4),
        },
    }
    if bench:
        # what the basket typically buys, and what it typically costs to buy -
        # both unscaled, so the card can say what the uplift is asking for on
        # top (§5). The target's own budget stays targets["paid"]["budget"].
        paid_out["benchmarkUnits"] = round(bm_units["paid"], 1)
        paid_out["benchmarkBudget"] = round(bm_units["paid"] * targets["paid"]["cost_per_purchase"], 2)

    # ---- email funnel (docs §8): launch-window customer sends for this campaign,
    # from where the window opens or, when later, the day after an earlier
    # launch by the same artist closed (email_window_start)
    feed_through = email_feed_through(emails)
    email_start = email_window_start(release, window_start)
    em_all = emails[(emails["campaign"] == release["campaign_code"])
                    & (emails["sent_at"].dt.date >= email_start)
                    & (emails["sent_at"].dt.date <= min(as_of, launch_end))]
    em = em_all[em_all["email_type"].isin(["GEN", "CUS", "INS"])]
    if em.empty and not em_all.empty:
        # source without the Klaviyo name convention (e.g. HubSpot) - keep all
        # campaign-matched sends except operational types
        em = em_all[~em_all["email_type"].isin(["TRNS", "AUT", "FREQ", "TEST"])]
    email_out = {
        "sends": int(len(em)),
        "delivered": int(em["delivered"].sum()),
        "opened": int(em["opened"].sum()),
        "clicked": int(em["clicked"].sum()),
        "openRate": round(em["opened"].sum() / em["delivered"].sum(), 4) if em["delivered"].sum() else None,
        "clickRate": round(em["clicked"].sum() / em["delivered"].sum(), 4) if em["delivered"].sum() else None,
        "sequence": [
            {"name": r["name"].split(" - ", 1)[-1], "date": r["sent_at"].date().isoformat(),
             "delivered": int(r["delivered"]), "opened": int(r["opened"]), "clicked": int(r["clicked"])}
            for _, r in em.sort_values("sent_at").iterrows()
        ],
        "feedThrough": feed_through,
    }
    # Expected delivered by today: the sends the AA Email sessions plan implies
    # at the cohort's rates - expected sessions over open rate x clicks per open
    # x sessions per click - so the chain's expected side multiplies out to the
    # plan's sessions, and a release sending to a small list is judged against a
    # volume that fits it rather than the cohort's median send (which used to
    # be the target, and left sessions per click carrying whatever the sends
    # lost). Until two launches give a sessions-per-click median, the median
    # delivered total on the pooled delivery-timing curve stands in.
    # The rates are the cohort's without this release's own sends and without
    # the launches that closed after it (email_bench_for).
    email_bench = email_bench_for(email_bench, release)
    # The sends are read on AA Email's sessions as the funnel attributes them.
    # The Direct switch spreads Direct's share of the basket onto AA Email as
    # well; that is traffic Direct brought, not sends, so it leaves the sends
    # the plan asks for alone and lands in sessions per click, whose
    # reference carries the same share (email_refs_out below).
    spread_f = 1.0
    if direct_spread and unspread:
        _raw = float((unspread.get("sessions_by_group") or {}).get("aa_email") or 0.0)
        _now = float((profile.get("sessions_by_group") or {}).get("aa_email") or 0.0)
        if _raw > 0 and _now > 0:
            spread_f = _now / _raw
    email_out["deliveredTarget"] = None
    sess_plan = round(email_sess["plan"] / spread_f, 1) if email_sess.get("plan") is not None else None
    rate_chain = (email_bench["open_rate"] * email_bench["ctor_rate"] * email_bench["spc_rate"]
                  if email_bench and all(email_bench.get(k) for k in ("open_rate", "ctor_rate", "spc_rate"))
                  else None)
    if rate_chain and sess_plan:
        email_out["deliveredTarget"] = round(sess_plan / rate_chain, 1)
    elif email_bench and email_bench["total"] is not None:
        p = pdsa_today
        grid, cur = CURVE_GRID, email_bench["curve"]
        if p <= grid[0]:
            w = 0.0
        elif p >= grid[-1]:
            w = 1.0
        else:
            w = 1.0
            for i in range(1, len(grid)):
                if p <= grid[i]:
                    f = (p - grid[i - 1]) / (grid[i] - grid[i - 1])
                    w = cur[i - 1] + f * (cur[i] - cur[i - 1])
                    break
        email_out["deliveredTarget"] = round(email_bench["total"] * w, 1)
    # The same sends at the basket's pace: the benchmark's AA Email sessions by
    # today over the same rates - the delivered rung's tick, and the reference
    # the waterfall's walk from the benchmark reads. The cohort's median send on
    # the curve carries no uplift, so where it is the target it is this too.
    email_out["deliveredBenchmark"] = None
    sess_bm_plan = round(email_sess["bm"] / spread_f, 1) if email_sess.get("bm") is not None else None
    if rate_chain and sess_bm_plan:
        email_out["deliveredBenchmark"] = round(sess_bm_plan / rate_chain, 1)
    elif email_out["deliveredTarget"] is not None and not rate_chain:
        email_out["deliveredBenchmark"] = email_out["deliveredTarget"]
    email_refs_out = email_refs(email_bench)
    if spread_f != 1.0 and email_bench and email_bench.get("spc_rate") is not None:
        # with Direct spread, the sessions-per-click reference on the spread's
        # basis, so the chain still multiplies out to the plan's sessions and
        # the rung reads a spread actual against a spread reference
        email_refs_out["emailSessionsPerClickRef"] = round(email_bench["spc_rate"] * spread_f, 3)

    # ---- social content
    ct = content[(content["campaign_code"] == release["campaign_code"])
                 & (content["Date"].dt.date >= window_start)
                 & (content["Date"].dt.date <= min(as_of, launch_end))]
    posts = ct[ct["Content type"].isin(["post", "collaboration", "reply", "shared"])]
    social_out = social_block(content, artist_posts, release["campaign_code"],
                              window_start, min(as_of, launch_end))
    # the artist tier benchmark, None until two completed campaigns have data
    tier = referral_artist_tier(release)
    pb = posts_bench or {}
    social_out["artistPostsTarget"] = None if tier == "N/A" else pb.get(tier, pb.get("_all"))

    # ---- waterfall (docs §9): contributors to projection - target, in secured units
    organic_groups = [g for g in DISPLAY_GROUPS if g != "paid"]
    wf_traffic = sum(funnel_by_group[g]["contrib_traffic"] for g in organic_groups)
    wf_conv = sum(funnel_by_group[g]["contrib_conversion"] for g in organic_groups)
    # paid's plan by today is the even share of its days (paid_pace), the share
    # the paid card, the channels card and the funnel rung read - not the
    # panel's historic paid shape, which put this step on a different plan.
    # That plan is read at the share of today seen, so the spend set against
    # it is the spend to date, today so far included (paid.spendToDate): the
    # full days alone moved the part day's spend into Paid efficiency
    spend_to_date = cum_spend + part_spend
    spend_planned_to_date = targets["paid"]["budget"] * paid_pace(pdsa_today)
    wf_paid_spend = ((spend_to_date - spend_planned_to_date) / targets["paid"]["cost_per_purchase"]
                     ) if targets["paid"]["cost_per_purchase"] else 0.0
    paid_gap = funnel_by_group["paid"]["contrib_traffic"] + funnel_by_group["paid"]["contrib_conversion"]
    wf_paid_eff = paid_gap - wf_paid_spend
    # the projection and the actual the card prints are the hero's, capped at
    # the whole edition; demand beyond it is the last step of every walk, so
    # the steps still close on the figure printed (docs 6.3½)
    total = float(edition_total(release))
    proj_shown, now_shown = round(min(hero_proj, total), 0), round(min(hero_now, total), 0)
    over_close, over_today = round(hero_proj, 0) - proj_shown, round(hero_now, 0) - now_shown
    def beyond(over: float) -> list[dict]:
        return [{"key": "oversubscribed", "label": "Beyond sellout", "value": -over}] if over > 0 else []
    # The four contributors measured to date and left unscaled are the Today
    # horizon (§2), where the question is why the launch is where it is, not
    # where it will end. The gaps are already actual minus target today by
    # construction (traffic + conversion per group is exactly that group's now
    # minus its expected), so they need no blend factor; at close they are
    # copied on a closed release and scaled on a live one (waterfall_walks).
    actual_today, target_today = now_shown, round(hero_exp, 0)
    today_steps, close_steps, scale = waterfall_walks(
        [wf_traffic, wf_conv, wf_paid_spend, wf_paid_eff], hero_now - hero_exp, hero_proj - hero_target,
        round(hero_now, 0) - target_today, round(hero_proj, 0) - round(hero_target, 0), complete)
    waterfall = {
        "target": round(hero_target, 0), "projection": proj_shown,
        "steps": close_steps + beyond(over_close),
        # the factor the close steps are the steps to date times; None when
        # they are copied (a closed release) or the rest of the gap is shared
        # out by size (close_walk)
        "closeScale": round(scale, 4) if scale is not None else None,
    }
    if bench:
        today_steps += beyond(over_today)
        # the benchmark in whole units as the page rounds benchmark.units, the
        # stretch the difference of the two figures printed
        bm_close, bm_today = whole(hero_bm), whole(hero_bm_today)
        waterfall["benchmark"] = bm_close
        waterfall["stretch"] = round(hero_target, 0) - bm_close
        waterfall["today"] = {
            "benchmark": bm_today,
            "stretch": target_today - bm_today,
            "target": target_today,
            "actual": actual_today,
            "steps": today_steps,
        }
        assert abs(sum(s["value"] for s in today_steps) - (actual_today - target_today)) < 0.5, (
            f"{release['id']}: today waterfall steps do not reconcile to actual - target")
        # The same four contributors against the basket: the waterfalls open at
        # the target, set the stretch aside, and walk from the benchmark, so
        # their steps read against the basket and sum to the outcome less the
        # benchmark (today) or the projection less the benchmark (at close),
        # closed the same way the target steps are.
        wf_traffic_bm = sum(funnel_by_group[g]["contrib_traffic_bm"] for g in organic_groups)
        wf_conv_bm = sum(funnel_by_group[g]["contrib_conversion_bm"] for g in organic_groups)
        bm_budget = bm_units["paid"] * targets["paid"]["cost_per_purchase"]
        spend_bm_to_date = bm_budget * paid_pace(pdsa_today)
        wf_paid_spend_bm = ((spend_to_date - spend_bm_to_date) / targets["paid"]["cost_per_purchase"]
                            ) if targets["paid"]["cost_per_purchase"] else 0.0
        paid_gap_bm = funnel_by_group["paid"]["contrib_traffic_bm"] + funnel_by_group["paid"]["contrib_conversion_bm"]
        wf_paid_eff_bm = paid_gap_bm - wf_paid_spend_bm
        today_bm, close_bm, scale_bm = waterfall_walks(
            [wf_traffic_bm, wf_conv_bm, wf_paid_spend_bm, wf_paid_eff_bm], hero_now - hero_bm_today, hero_proj - hero_bm,
            round(hero_now, 0) - bm_today, round(hero_proj, 0) - bm_close, complete)
        waterfall["stepsBm"] = close_bm + beyond(over_close)
        waterfall["closeScaleBm"] = round(scale_bm, 4) if scale_bm is not None else None
        today_bm += beyond(over_today)
        waterfall["today"]["stepsBm"] = today_bm
        assert abs(sum(s["value"] for s in today_bm) - (actual_today - bm_today)) < 0.5, (
            f"{release['id']}: today waterfall steps do not reconcile to actual - benchmark")

    draw = load_draw(release)

    day_n = max(min((as_of - announce).days, L), 0)
    edition = float(release["edition_size"])     # the target the plan runs on
    total = float(edition_total(release))         # the whole edition: caps and oversubscription
    status_pct = (min(hero_now, total) - hero_exp) / hero_exp if hero_exp else 0.0
    # the traffic the sidebar row reads (index_row), counted as the
    # actuals-only page counts it: sessions in the window, the last day seen
    in_window = rat[(rat["event_date"] >= window_start) & (rat["event_date"] <= window_end)]
    snap = {
        "id": release["id"],
        "releaseName": name,
        "artist": name.split(" · ")[0], "title": name.split(" · ")[1],
        "quarter": name_quarter(name),
        "type": "LE",
        "totals": {"sessions": round(float(in_window["Sessions_Total"].sum()))},
        "derived": {"last_seen": rat["event_date"].max().isoformat() if len(rat) else None},
        "campaignCode": release["campaign_code"], "campaignName": camp,
        "campaignNames": camps,
        "marketingLead": release.get("marketing_lead"),
        # where each input came from (docs §1.6): notion / typed / airtable /
        # clock for the dates, airtable or typed for the lead, products or
        # typed release-level figures for the economics
        "inputSources": release.get("input_sources") or {},
        # the works' own closes (§1.6) and a date Airtable or the funnel's
        # clock now puts elsewhere than the page runs on
        "closes": release.get("closes") or [],
        "dateDrift": release.get("date_drift") or {},
        # a page the funnel has no rows under (adopt_funnel_names): what was
        # considered and why it was not given another name, for the header
        "funnelNote": release.get("funnel_note"),
        "privateRoomOpen": release["private_room_open"],
        "windowStart": release["announce_date"], "windowEnd": release["launch_end"],
        "campaignLengthDays": L, "day": day_n, "of": L,
        "asOf": as_of.isoformat(), "complete": complete,
        # where the units came from and the days they were counted over, the
        # same on every card (docs 6.3)
        "unitsSource": uinfo["source"],
        "salesWindow": {"start": window_start.isoformat(), "end": window_end.isoformat(), "closed": closed,
                        "firstPaid": first_paid.isoformat() if first_paid else None},
        # the last full day, and the share of the as-of day seen (1 once the
        # window has closed): the page reads "so far today" off the second
        "completeThrough": full_through.isoformat(),
        "asOfFraction": 1.0 if (complete or as_of > launch_end) else round(seen, 4),
        "targetingMode": "benchmark",
        # the target the plan runs on and the whole edition; equal unless the
        # inputs give a total edition the target is only part of
        "edition": {"target": round(edition, 0), "total": round(total, 0)},
        "economics": {
            "unitPrice": release["unit_price"], "launchValue": targets["launch_value"],
            "artistProfitPerUnit": round(ppu_artist, 2), "aaProfitPerUnit": round(ppu_aa, 2),
            "artistProfitShare": release["artist_profit_share"],
            "aaBudgetShare": aa_budget_share,
            "aaBudgetShareAssumed": budget_assumed,
            # per product, the figures in force and where each came from
            # (resolve_release): "products" when the totals are theirs,
            # "release" while typed release-level figures still stand
            "mode": release.get("economics_mode"),
            "products": release.get("economics_products") or [],
            # the works unticked on the tab: on the grid, out of every figure
            "excludedProducts": [{"airtable_id": p.get("airtable_id"), "name": p.get("name"), "edition": p.get("edition")}
                                 for p in release.get("excluded_products") or []],
            "deal": release.get("deal") or [],
            "launchCurrencies": release.get("launch_currencies") or [],
            "airtableMatch": release.get("airtable_match"),
            # the framing uplift inside aaProfitPerUnit: the terms in force for
            # this release (its own inputs; the take-up else the benchmark
            # default, the profit per frame only its own, None without one)
            "framingAvailable": release.get("framing_available") is not False,
            "frameConversion": frame_conv, "frameProfitPerUnit": frame_profit,
            "frameUpliftPerUnit": (round(float(release["frame_uplift_per_unit"]), 2) if release.get("frame_uplift_per_unit") is not None
                                   else round(frame_conv * (frame_profit or 0.0), 2) if release.get("framing_available") is not False else 0.0),
        },
        "currency": "units",
        "hero": {
            "now": round(min(hero_now, total), 0), "expectedToday": round(hero_exp, 0),
            # the difference of the two figures as printed, so the card, the
            # trajectory's reading and this agree to the unit
            "delta": round(min(hero_now, total), 0) - round(hero_exp, 0),
            "projected": round(min(hero_proj, total), 0), "target": round(hero_target, 0),
            "oversubscribedUnits": round(max(max(hero_now, hero_proj) - total, 0), 0),
            "statusPct": round(status_pct, 4), "ok": status_pct >= -0.1,
        },
        "targets": targets, "groupTargets": gtargets,
        "channels": channels_out,
        "funnelByGroup": funnel_by_group,
        "paid": paid_out,
        # what the plan assumes each buyer takes and what they have taken so
        # far, so the funnel can split its conversion step in two (§4.2)
        "unitsPerBuyer": {"plan": round(upb_plan, 4), "actual": round(upb_actual, 4)},
        # the untracked share of the window against what is normal (§1.3)
        "untracked": untracked,
        # Direct's share of the window (sessions, entries, units) as the
        # funnel attributes it, for the dashboard's Direct switch
        "directShare": direct_share,
        "email": email_out,
        "social": social_out,
        "sellthrough": sellthrough,
        # frames per print, against the plan's rate and the basket's (§6.4)
        "framing": framing_block(release, of_win, basket, b, st=sellthrough),
        "draw": draw,
        "geo": None,  # country dim not in any feed yet (docs §12)
        "waterfall": waterfall,
        "benchmarks": {
            "chargeDropOff": round(1 - entry_rate(release), 4),
            "cannibalisation": b["cannibalisation"],
            "targetBuffer": b["target_buffer"],
            **email_refs_out,
        },
    }
    if bench:
        upb = targets.get("units_per_buyer") or 1.0
        # The reference the whole page is drawn against (§5). Every value here
        # is the basket's own median, unscaled - K is published next to them so
        # a card can say what the uplift is asking for rather than having to
        # work it out from two rounded numbers.
        snap["benchmark"] = {
            "basket": {"id": basket["id"], "kind": basket["kind"], "name": basket["name"],
                       "n": basket["n"], "thin": basket["thin"],
                       "suggestedId": basket["suggestedId"]},
            "units": round(profile["units"], 1),
            # units are demand (baskets.demand_columns): what the basket's
            # launches would have sold with enough supply; the sales beside
            # them, and how many members sold out with people left wanting
            "unitsSold": round(profile.get("units_sold", profile["units"]), 1),
            "nShort": int(profile.get("n_short") or 0),
            "unitsP25": round(profile["units_p25"], 1), "unitsP75": round(profile["units_p75"], 1),
            # the basket's unit prices in euros (median and middle half), from
            # Airtable via the panel - 0 when no member is priced (§3.2)
            "price": round(profile.get("price", 0.0), 1),
            "priceP25": round(profile.get("price_p25", 0.0), 1), "priceP75": round(profile.get("price_p75", 0.0), 1),
            "nPriced": int(profile.get("n_priced", 0)),
            "sessions": round(profile["sessions"], 1), "entries": round(profile["entries"], 1),
            "campaignDays": round(profile["campaign_days"], 1),
            "k": round(k, 4),
            # each group's own uplift and the share of the stretch it carries
            # (§4.4): K for every group unless the tab placed the stretch
            "kByGroup": {g: round(float(v), 4) for g, v in (targets.get("k_by_group") or {}).items()},
            "stretchFrom": {g: round(float(v), 4) for g, v in (targets.get("stretch_from") or {}).items()},
            "stretchTyped": bool(targets.get("stretch_typed")),
            "stretchUnits": round(edition - profile["units"], 1), "stretchPct": round(k - 1, 4),
            "unitsByGroup": {g: round(v, 1) for g, v in bm_units.items()},
            "sessionsByGroup": {g: round(v, 1) for g, v in bm_sessions.items()},
            "convByGroup": {g: round(v, 6) for g, v in profile["conv"].items()},
            # the channels set aside for this release and the basket's full
            # medians before they were (§4.3): what the page says was set
            # aside, and what the browser re-reads as the switches are flipped.
            # The Target setting tab rebuilds the targets from these, so they
            # carry the build's own precision, not the cards' tenth of a unit:
            # rounded, they put the tab's paid budget EUR 1-12 off the page's
            "channelsOff": list(profile.get("channels_off") or []),
            "unitsAll": round(profile.get("units_all", profile["units"]), 6),
            "unitsSoldAll": round(profile.get("units_sold_all", profile.get("units_sold", profile["units"])), 6),
            "sessionsAll": round(profile.get("sessions_all", profile["sessions"]), 6),
            "entriesAll": round(profile.get("entries_all", profile["entries"]), 6),
            "unitsP25All": round(profile.get("units_p25_all", profile["units_p25"]), 6),
            "unitsP75All": round(profile.get("units_p75_all", profile["units_p75"]), 6),
            "unitsByGroupAll": {g: round(v, 6) for g, v in (profile.get("units_by_group_all") or bm_units).items()},
            "sessionsByGroupAll": {g: round(v, 6) for g, v in (profile.get("sessions_by_group_all") or bm_sessions).items()},
            "convByGroupAll": {g: round(v, 6) for g, v in (profile.get("conv_all") or profile["conv"]).items()},
            "privateRoomShare": round(profile["private_room_share"], 4),
            "paidBudget": round(bm_units["paid"] * targets["paid"]["cost_per_purchase"], 2),
            # what a paid unit cost the basket's launches, and how many had a
            # reading (0 members: the panel constant prices the budget); the
            # tab prices the budget with it, so at the build's precision too
            "costPerPurchase": round(float(profile.get("cost_per_purchase") or 0), 6),
            "costPerPurchaseN": int(profile.get("n_costed") or 0),
            # the people behind the basket's units, at the rate the target
            # holds. The rate is held at the benchmark, so the whole uplift
            # falls on the buyer count and benchmark x K is the target (§4.2)
            "unitsPerBuyer": round(upb, 4),
            "buyers": round(profile["units"] / upb, 1) if upb else None,
        }
        # in whole units as the page rounds benchmark.units (whole), the
        # waterfall's figures; the stretch is the difference of the two printed
        snap["hero"]["benchmark"] = whole(hero_bm)
        snap["hero"]["benchmarkToday"] = whole(hero_bm_today)
        snap["hero"]["stretch"] = round(hero_target, 0) - whole(hero_bm)
        # secured vs what a comparable launch had by today. The sidebar's middle
        # state is exactly this sign, and the index carries it so the sidebar
        # does not have to guess the boundary from statusPct - 1/K moves with
        # the release, from +15% to -54% across the launches on file.
        snap["hero"]["benchmarkPct"] = (
            round((min(hero_now, edition) - hero_bm_today) / hero_bm_today, 4)
            if hero_bm_today else None)
    return snap


# ---------------------------------------------------------------- main

def product_name_warnings(sell: dict) -> list[str]:
    """Sell-through rows named for another draw's work (docs 6.3): a row whose
    name is, by _by_name, the title a draw outside the row sold, while the
    name is none of the titles its own draws sold. The row's figures follow
    its own draws, so the name sits on another work's units (the Mondrian
    names did, handed to the draws by position). Names are typed by a person
    and a short one can be another work's too, so this is a warning for the
    refresh log, never a failed build."""
    dp = sell.get("drawProducts") if isinstance(sell.get("drawProducts"), dict) else {}
    out = []
    for r in sell.get("products") or []:
        if not isinstance(r, dict) or not isinstance(r.get("name"), str) or re.match(r"^Draw \d+$", r["name"]):
            continue
        own = {str(d) for d in (r.get("draws") or [])}
        if not own:
            continue     # a product only the orders feed names, with no draw of its own
        mine = {str(dp[d]) for d in own if dp.get(d)}
        if any(_by_name(r["name"], [t]) is not None for t in mine):
            continue
        others = sorted({str(t) for d, t in dp.items() if t and str(d) not in own and str(t) not in mine})
        hit = _by_name(r["name"], others)
        if hit is not None:
            sold_by = sorted(str(d) for d, t in dp.items() if str(t) == hit)
            out.append(f"sell-through row {r['name']!r} (draw {', '.join(sorted(own))}) carries the name of "
                       f"{hit!r}, which draw {', '.join(sold_by)} sold")
    return out


def stale_build_warnings(snap: dict) -> list[str]:
    """What a page this ETL builds always carries (docs 6.3, 10a), checked
    softly: a targeted page says where its units came from and the days it
    counted (`unitsSource`, `salesWindow`), and once its sales window has shut
    nothing in hand still counts - no drafts, no draw winners predicted, no
    entries in hand or still to come, no entry patterns. A page that breaks
    one was built by an older ETL, as the committed fallback pages of 24 and
    25 September 2026 were, and its figures are not this build's. Warnings,
    not failures: a claim still landing (draw_claims) can put a predicted unit
    on a shut window, and a failure would stop the whole refresh. A page
    without `salesWindow` is taken as shut once its as-of day is past its
    close plus the grace, the rule the older builds missed."""
    out: list[str] = []
    if snap.get("targeted", True) and not snap.get("upcoming"):
        missing = [k for k in ("unitsSource", "salesWindow") if not snap.get(k)]
        if missing:
            out.append(f"no {' or '.join(missing)}: built by an ETL older than the orders sales window - "
                       f"its figures are not this build's; rebuild it")
    sw, sell = snap.get("salesWindow"), snap.get("sellthrough") or {}
    if isinstance(sw, dict):
        shut, end = bool(sw.get("closed")), sw.get("end")
    else:
        try:
            end = (date.fromisoformat(str(snap.get("windowEnd"))[:10]) + timedelta(days=UNITS_GRACE_DAYS)).isoformat()
            shut = str(snap.get("asOf") or "") > end
        except ValueError:
            shut, end = False, None
    if shut and sell:
        left = [f"{k} {sell[k]}" for k in ("drafts", "soldPredicted", "inHandUnits", "futureEntriesPredicted")
                if abs(_num(sell.get(k)) or 0.0) > 0.05]
        if sell.get("patterns"):
            left.append(f"{len(sell['patterns'])} entry patterns")
        if left:
            out.append(f"its sales window shut on {end} but the sell-through still counts {', '.join(left)}")
    return out


# what check_snapshot warned of: the soft checks, which never stop the build
SNAPSHOT_WARNINGS: list[str] = []


def check_snapshot(snap: dict, soft: bool = True) -> list[str]:
    """Cross-check a snapshot's own arithmetic before it is written.

    These are relationships that must hold by definition, so a breach means a
    code path disagrees with another one - the class of bug where two cards
    print different answers for the same quantity. Cheap to run, and it fails
    the build rather than shipping a number that cannot be true.

    The soft checks (stale_build_warnings) are printed and returned, never
    raised: the signs of a page built by an older ETL. `soft` is off for the
    Direct switch's view, which carries the same page's fields.
    """
    rid = snap.get("id", "?")
    # the soft checks, logged below with the rest and never raised, start
    # with the signs of a page an older ETL built
    try:
        warnings = stale_build_warnings(snap) if soft else []
    except Exception as e:  # noqa: BLE001 - a soft check never stops the build
        warnings = [f"the soft checks could not run ({e})"]
    hero, sell = snap.get("hero") or {}, snap.get("sellthrough") or {}
    now, sold = hero.get("now"), sell.get("sold")
    edition = (snap.get("sellthrough") or {}).get("edition")
    # hero.now is deliberately capped at the edition (demand beyond sellout is
    # reported as oversubscribedUnits, not bar overshoot), so every check below
    # only bites while the release is under that cap.
    capped = edition is not None and now is not None and now >= edition - 0.5
    problems = []
    # secured = units sold + 0.8 x unconverted entries, so it cannot be below sold
    if not capped and now is not None and sold is not None and now < sold - 0.5:
        problems.append(f"hero.now {now} < sellthrough.sold {sold} - secured units cannot be below units sold")
    # group targets are a partition of the edition
    gt = snap.get("groupTargets") or {}
    if gt:
        tot = sum((g or {}).get("units", 0) for g in gt.values())
        edition = (snap.get("targets") or {}).get("edition_size")
        if edition and abs(tot - edition) > 1.0:
            problems.append(f"group unit targets sum to {tot:.1f}, edition size is {edition}")
    # channel actuals should roll up to the hero
    ch = snap.get("channels") or []
    if ch and now is not None:
        roll = sum(c.get("now") or 0 for c in ch)
        if capped:
            if roll < (edition or 0) - 1.0:
                problems.append(f"hero.now is capped at the edition but channels only sum to {roll:.1f}")
        elif abs(roll - now) > 1.0:
            problems.append(f"channel actuals sum to {roll:.1f} but hero.now is {now}")
    # benchmark mode (BENCHMARK_SPEC §5): the benchmark is a partition of its
    # own headline, the target is that headline lifted by exactly K, and the
    # Today waterfall closes. All three are relationships the cards draw as
    # lines that must meet, so a breach is a visibly wrong page.
    bm = snap.get("benchmark")
    if bm:
        roll_bm = sum(c.get("bm") or 0 for c in ch)
        if abs(roll_bm - bm["units"]) > 1.0:
            problems.append(f"channel benchmarks sum to {roll_bm:.1f} but benchmark.units is {bm['units']}")
        # hero.benchmark is rounded to units before this multiply, so the
        # comparison carries up to half a unit times K of rounding on its own -
        # a fixed tolerance of one unit fails an honest snapshot as soon as the
        # uplift passes 2, and check_snapshot aborts the whole run, not just
        # this release. It is rounded from the tenth the page prints (whole),
        # which can sit 0.05 further off the median: 0.55 units times K.
        lifted = (hero.get("benchmark") or 0) * bm["k"]
        if abs(lifted - (hero.get("target") or 0)) > 0.55 * bm["k"] + 1.0:
            problems.append(f"hero.benchmark x k is {lifted:.1f} but hero.target is {hero.get('target')}")
        wf_today = (snap.get("waterfall") or {}).get("today") or {}
        steps = sum(s["value"] for s in wf_today.get("steps") or [])
        gap = (wf_today.get("actual") or 0) - (wf_today.get("target") or 0)
        if abs(steps - gap) > 0.5:
            problems.append(f"today waterfall steps sum to {steps:.1f}, actual - target is {gap:.1f}")
    # one count of units on every card (docs 6.3): the units the channels and
    # the hero were built from are the orders paid in the window, the same
    # units the sell-through's products add up to
    if snap.get("unitsSource") == "orders" and sold is not None and sell.get("unitsPaidOrders") is not None:
        if abs(float(sell["unitsPaidOrders"]) - float(sold)) > 0.51:
            problems.append(f"sellthrough.sold {sold} but the products' units paid in the window add to {sell['unitsPaidOrders']}")
    # the card's rows are its Paid: paid per product plus the share of what
    # no product is named for, on whichever units the page reads
    rows = sell.get("products") or []
    if rows and sold is not None:
        paid_rows = sum(float(r.get("sold") or 0) + float(r.get("soldAssumed") or 0) for r in rows)
        if abs(paid_rows - float(sold)) > 0.51 + 0.05 * len(rows):
            problems.append(f"the products' paid rows add to {paid_rows:.1f} but sellthrough.sold is {sold}")
        if float(sell.get("attributedSold") or 0) > float(sold) + 0.51:
            problems.append(f"attributedSold {sell.get('attributedSold')} is more than sellthrough.sold {sold}")
    # the card's close percentage and the hero's projection are the same
    # parts summed and capped at the edition (docs 6.3): the hero at 1,957
    # beside a card at 100% was two different paid figures
    ed_st = sell.get("edition")
    if ed_st and sell.get("pct") is not None:
        parts = (float(sell.get("sold") or 0) + float(sell.get("drafts") or 0)
                 + float(sell.get("soldPredicted") or 0) + float(sell.get("futureEntriesPredicted") or 0))
        at_close = min(parts, float(ed_st))
        if abs(float(sell["pct"]) * float(ed_st) - at_close) > 1.0:
            problems.append(f"sellthrough.pct {sell['pct']} of {ed_st} but its parts add to {parts:.1f}")
        if hero.get("projected") is not None and abs(float(hero["projected"]) - at_close) > 1.0:
            problems.append(f"hero.projected {hero['projected']} but the sell-through's count at close is {at_close:.1f}")
    # soft checks: figures that should agree, and what a person typed, which
    # can be wrong without any figure being impossible; logged
    # (SNAPSHOT_WARNINGS) and never stopping the build. The Direct switch's
    # view carries the page's own names, so they are read once
    if soft:
        try:
            warnings += product_name_warnings(sell)
        except Exception as e:  # noqa: BLE001 - a soft check never stops the build
            warnings.append(f"product names not checked: {e}")
    alt = (snap.get("variants") or {}).get("direct_spread")
    try:
        # the benchmark the hero prints is the basket's median as the page rounds it
        if bm and hero.get("benchmark") is not None and bm.get("units") is not None:
            if hero["benchmark"] != whole(bm["units"]):
                warnings.append(f"hero.benchmark {hero['benchmark']} but benchmark.units {bm['units']} prints as {whole(bm['units']):.0f}")
        # what is projected at close cannot be less than what is already in
        paid = snap.get("paid") or {}
        for proj_key, now_key, tol in (("entriesProjected", "entriesToDate", 0.05), ("spendProjectedTotal", "spendToDate", 0.01)):
            pv, nv = paid.get(proj_key), paid.get(now_key)
            if isinstance(pv, (int, float)) and isinstance(nv, (int, float)) and pv < nv - tol:
                warnings.append(f"paid.{proj_key} {pv} is below paid.{now_key} {nv}")
        # a closed release's walk at close is its walk to date
        wf = snap.get("waterfall") or {}
        if snap.get("complete") and wf.get("today"):
            for key in ("steps", "stepsBm"):
                close_v = [s.get("value") for s in wf.get(key) or []]
                today_v = [s.get("value") for s in wf["today"].get(key) or []]
                if close_v and today_v and close_v != today_v:
                    warnings.append(f"a closed release's waterfall {key} at close {close_v} differ from today's {today_v}")
        # the Direct switch moves attribution, not the sends the plan asks for
        if alt and isinstance(alt.get("email"), dict) and isinstance(snap.get("email"), dict):
            a, b_ = alt["email"].get("deliveredTarget"), snap["email"].get("deliveredTarget")
            if a is not None and b_ is not None and abs(a - b_) > 0.5:
                warnings.append(f"the Direct view's email.deliveredTarget {a} differs from the page's {b_}")
    except Exception as e:  # noqa: BLE001 - a soft check never stops the build
        warnings.append(f"the figures' soft checks could not run ({e})")
    for w in warnings:
        SNAPSHOT_WARNINGS.append(f"{rid}: {w}")
        print(f"check_snapshot warning: {rid}: {w}")
    # the Direct switch's view of the page holds to the same rules
    if alt:
        try:
            check_snapshot({**snap, **alt, "variants": None, "id": f"{rid} with Direct spread"}, soft=False)
        except AssertionError as e:
            problems.append(str(e))
    if problems:
        msg = f"{rid}: " + "; ".join(problems)
        if os.environ.get("CHECK_SNAPSHOT") == "warn":
            # a verification run lists every page's problem in one pass;
            # the refresh itself never runs this way
            CHECK_WARNINGS.append(msg)
            print(f"check_snapshot: {msg}")
            return warnings
        raise AssertionError(msg)
    return warnings


# problems check_snapshot found with CHECK_SNAPSHOT=warn (a verification run)
CHECK_WARNINGS: list[str] = []

# ---- the benchmark panel against the feed (docs/DATA_MODEL.md 6.3) -----------
# The panel (data/release_clusters.csv) is written by hand after a full pull;
# the pages are rebuilt from the feed every hour. These say when the two have
# come apart. Warnings for the refresh log only: the pages are right on their
# own terms, and the fix is a re-run of etl/analysis/release_clusters.py.
PANEL_DRIFT_TOL = 0.05   # a closed page's share of units per group against its own panel row
PANEL_WARNINGS: list[str] = []


def panel_drift(snap: dict, panel: pd.DataFrame | None) -> str | None:
    """A closed targeted page set against its own row in the panel: the page's
    share of units per display group (channels[].now, the Channel view) and
    the row's unit_share_<g>. Both count the same launch, so on one channel
    attribution they agree to a few points (0.025 at most on the five pages
    that have a row, on 24 Sep 2026 before the feed moved); further apart
    than PANEL_DRIFT_TOL on any group, the panel was read on an older
    attribution than the page, and every basket cut from it sets the
    per-channel targets on the older split. None when there is nothing to
    say; never raises."""
    try:
        if panel is None or not len(panel) or not snap.get("complete") or not snap.get("benchmark"):
            return None
        hit = panel[panel["release_name"] == snap.get("releaseName")]
        if not len(hit):
            return None
        row = hit.iloc[0]
        now = {c.get("key"): float(c.get("now") or 0.0) for c in (snap.get("channels") or [])}
        total = sum(now.get(g, 0.0) for g in baskets.GROUPS)
        if total <= 0:
            return None
        apart = []
        for g in baskets.GROUPS:
            share = pd.to_numeric(row.get(f"unit_share_{g}"), errors="coerce")
            if pd.isna(share):
                continue
            page = now.get(g, 0.0) / total
            if abs(page - float(share)) > PANEL_DRIFT_TOL:
                apart.append((abs(page - float(share)), g, page, float(share)))
        if not apart:
            return None
        apart.sort(reverse=True)
        return (f"panel: {snap.get('id')} has closed and its units split is up to {apart[0][0]:.2f} from its own panel row ("
                + ", ".join(f"{g} {p:.2f} on the page, {s:.2f} in the panel" for _, g, p, s in apart)
                + "): the panel's channel attribution is older than the feed's, so the baskets set per-channel targets "
                  "on the older split - re-run etl/analysis/release_clusters.py after a full pull")
    except Exception as e:  # noqa: BLE001 - a warning must never stop the refresh
        return f"panel: the drift check for {snap.get('id')} could not run ({e})"


def panel_unsettled(as_of: date) -> str | None:
    """The launches the panel still has in flight although they closed at
    least baskets.SETTLE_DAYS ago: a re-run would settle them, and until it
    does no basket can hold them (Dali and Glenn Ligon from September 2026).
    None when the panel owes nothing; never raises."""
    try:
        due = baskets.unsettled(as_of)
    except Exception as e:  # noqa: BLE001 - a warning must never stop the refresh
        return f"panel: the in-flight check could not run ({e})"
    if not due:
        return None
    return (f"panel: {len(due)} launch(es) closed {baskets.SETTLE_DAYS} or more days before {as_of} are still "
            f"'{baskets.IN_FLIGHT}' in data/release_clusters.csv, so no basket can hold them: "
            + ", ".join(f"{r['release_name']} (closed {r['close']})" for r in due)
            + " - re-run etl/analysis/release_clusters.py after a full pull")


def warn_panel(msg: str | None) -> None:
    """Print a panel warning and keep it for the run's summary."""
    if msg:
        PANEL_WARNINGS.append(msg)
        print(msg)


def funnel_coverage(at: pd.DataFrame, curves: dict) -> str:
    """One line for the refresh log: how much history the funnel export carries
    and how much of it can feed the across-time curves. The panel needs a
    release's announcement captured in the window (pdsa <= 0) and its launch
    passed (pdsa >= 1); a release without announcement dates upstream never
    qualifies however far back the export reaches."""
    dated = at[at["pct_days_since_announcement"].notna()]
    span = (dated.groupby("simple_release_name")["pct_days_since_announcement"]
                 .agg(["min", "max"]))
    complete = int(((span["min"] <= 0) & (span["max"] >= 1.0)).sum())
    return (f"funnel ({FUNNEL_FILE.name}) {at['event_date'].min()}..{at['event_date'].max()}: "
            f"{at['simple_release_name'].nunique()} releases seen, "
            f"{len(span)} with announcement dates, "
            f"{complete} complete announce-to-launch, "
            f"{curves['n_releases']} in the curve panel")


def units_coverage() -> str:
    """One line for the refresh log: what the units feed holds, and how much
    of it the funnel has no purchase event for. Says so when there is no feed
    and the pages read the funnel's units instead."""
    if load_units_feed() is None:
        return (f"units paid: no feed at {UNITS_FEED_INFO.get('path')} - every page reads the funnel's units "
                f"(unitsSource 'funnel') until the orders pull writes it")
    i = UNITS_FEED_INFO
    share = (i["noEvent"] / i["units"]) if i.get("units") else 0.0
    unknown = f"; unknown channels read as Untracked: {', '.join(i['unknownChannels'])}" if i.get("unknownChannels") else ""
    apart = i.get("outOfStep") or []
    step = (f"; {len(apart)} release(s) out of step with orders_by_product.csv read the funnel's units: "
            f"{', '.join(apart[:5])}{' ...' if len(apart) > 5 else ''}") if apart else ""
    return (f"units paid (units_paid.csv, pulled {i.get('pulled')}) {i.get('first')}..{i.get('last')}: "
            f"{i.get('releases')} releases, {i.get('units', 0):,.0f} units, {share:.1%} with no purchase event{unknown}{step}")


def name_quarter(name: str) -> str | None:
    """The quarter a release name ends in ("Artist · Title · 2026 Q3"), or None."""
    parts = [p.strip() for p in str(name).split(" · ")]
    return parts[-1] if len(parts) >= 2 and _QUARTER_RE.match(parts[-1]) else None


def index_row(snap: dict, status: str) -> dict:
    """One sidebar row. Shared so the whole build and a single-release rebuild
    cannot drift into describing the same release two different ways."""
    return {
        "id": snap["id"], "name": f"{snap['artist']} - {snap['title']}",
        "releaseName": snap["releaseName"], "artist": snap["artist"], "title": snap["title"],
        "quarter": snap.get("quarter") or name_quarter(snap["releaseName"]), "type": snap["type"],
        "status": status, "targeted": snap.get("targeted", True),
        "day": snap["day"], "of": snap["of"], "complete": snap["complete"],
        "windowEnd": snap.get("windowEnd"),
        # the works' close dates when they differ, so the row can say both
        "closes": [c["date"] for c in (snap.get("closes") or [])] if len(snap.get("closes") or []) > 1 else [],
        "dateDrift": bool(snap.get("dateDrift")),
        "statusPct": snap["hero"]["statusPct"], "ok": snap["hero"]["ok"],
        # actual vs the benchmark for today, so the sidebar can tell
        # "behind target but ahead of typical" from "behind typical"
        # without guessing at a threshold (docs/BENCHMARK_SPEC.md §7)
        "benchmarkPct": snap["hero"].get("benchmarkPct"),
        "lastSeen": (snap.get("derived") or {}).get("last_seen"),
        "sessions": (snap.get("totals") or {}).get("sessions"),
    }


def sort_index(index: list[dict]) -> list[dict]:
    """Live first by window end, then closed most-recent-first, then catalogue
    by traffic. The sidebar's order, in one place for both build paths."""
    live = [e for e in index if e["status"] == "live"]
    live.sort(key=lambda e: (e["windowEnd"] or "", -(e["sessions"] or 0)))
    upcoming = sorted([e for e in index if e["status"] == "upcoming"], key=lambda e: e["windowEnd"] or "")
    closed = sorted([e for e in index if e["status"] == "closed"],
                    key=lambda e: e["windowEnd"] or "", reverse=True)
    catalogue = sorted([e for e in index if e["status"] == "catalogue"],
                       key=lambda e: -(e["sessions"] or 0))
    return live + upcoming + closed + catalogue


def patch_index(snap: dict, as_of: date | None, status: str | None = None, row: dict | None = None) -> None:
    """Replace one release's row in the index written by the last full build.

    A save cannot add or remove releases, so every other row still stands; only
    this one's figures and its position can have moved. With no index on disk
    there is nothing to patch and the caller needs a full build, which is said
    rather than silently skipped."""
    path = APP / "index.json"
    if not path.exists():
        print("index: none on disk - run a full build to create it")
        return
    doc = json.loads(path.read_text())
    status = status or ("closed" if snap["complete"] else "live")
    row = row or index_row(snap, status)
    rows = [r for r in doc.get("releases", []) if r.get("id") != snap["id"]]
    rows.append(row)
    doc["releases"] = sort_index(rows)
    if as_of is not None:
        doc["asOf"] = as_of.isoformat()
    path.write_text(json.dumps(doc, indent=1))


def build_upcoming_pages() -> int:
    """The upcoming pages alone, from Airtable's launches and the releases on
    file, with no funnel export needed (§1.7). The server runs this at boot
    when the index lists an upcoming launch whose page is not on disk - a
    deploy without a persistent disk loses every page that is not in the
    repo - so those pages are back within seconds while the full refresh
    pulls the feeds. The index's own as-of is left as the last build set it;
    the pages count their days from today."""
    launch_frame = load_launches()
    if launch_frame is None or not len(launch_frame):
        print("upcoming: no Airtable launches on file - nothing to build")
        return 0
    as_of = date.today()
    existing: list[dict] = []
    try:
        doc = json.loads((APP / "inputs.json").read_text())
        # the releases the funnel had at the last build; the upcoming ones are
        # rebuilt here, so they are not "on file"
        existing = [r for r in (doc.get("discovered") or {}).values() if r.get("source") != "airtable"]
    except (OSError, ValueError):
        existing = []
    spend = load_spend() if (DATA / "spend_daily.csv").exists() else None
    emails = load_emails()
    in_use = {str(r.get("campaign_code")) for r in existing + INPUTS["releases"] if r.get("campaign_code")}
    activity = {c: w for c, w in code_activity(spend, emails).items() if c not in in_use}
    upcoming = upcoming_releases(launch_frame, existing + INPUTS["releases"], as_of, activity)
    DERIVED.mkdir(parents=True, exist_ok=True)
    n = 0
    for rec in upcoming:
        rec["campaign_name"] = match_campaign(rec["campaign_code"], spend) if (rec.get("campaign_code") and spend is not None) else None
        snap = build_upcoming(rec, as_of, None, as_of)
        check_snapshot(snap)
        write_page(DERIVED / f"{rec['id']}.json", snap)
        patch_index(snap, None, status="upcoming")
        n += 1
    # an upcoming row the list no longer holds (closed, taken up by the
    # funnel, renamed, or no longer read as a draw) leaves the index, which
    # otherwise keeps it without a page until the next full build
    path = APP / "index.json"
    if path.exists():
        try:
            doc = json.loads(path.read_text())
            ids = {rec["id"] for rec in upcoming}
            rows = doc.get("releases", [])
            # a timed launch's upcoming row stays: its page is the TL build's (etl/tl.py), not this list's
            kept = [r for r in rows if r.get("status") != "upcoming" or r.get("id") in ids or r.get("type") == "TL"]
            if len(kept) != len(rows):
                doc["releases"] = kept
                path.write_text(json.dumps(doc, indent=1))
                print(f"upcoming: {len(rows) - len(kept)} row(s) no longer upcoming left the index")
        except (OSError, ValueError) as e:
            print(f"upcoming: could not tidy the index ({e})")
    print(f"upcoming: wrote {n} page(s) from Airtable -> {DERIVED}")
    return n


def write_page(path: pathlib.Path, snap: dict) -> None:
    """A page to disk, stamped with when it was built: the header reads
    `builtAt` beside the data's last day, so a page's age is its own and not
    the refresh's."""
    snap["builtAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.write_text(json.dumps(snap, indent=1))


def guard_page(failures: list, rid: str, fn) -> bool:
    """Run one page's build. On any error the page is skipped, (id, error) is
    kept for the summary and False comes back, so one page's failure never
    stops the build; True when it built."""
    try:
        fn()
        return True
    except Exception as e:  # noqa: BLE001 - one page's failure never stops the build
        err = f"{type(e).__name__}: {str(e)[:300]}"
        failures.append((rid, err))
        print(f"page failed: {rid}: {err}")
        return False


def main(only: str | None = None):
    """Build every release, or just one.

    `only` is a release id. A dashboard save touches exactly one release, and
    rebuilding all 363 to answer it costs about eighteen seconds of which the
    saved release is a fraction: 354 actuals-only pages nobody asked for, the
    shared curve panel, and the pace curves of seven baskets belonging to other
    releases. The single-release path reuses the curve panel already on disk,
    builds the one snapshot, and patches its row into the index in place. The
    whole-catalogue artefacts - inputs.json, the reconciliation, the people and
    window exports - are left alone, because a save cannot change them.
    """
    t_start = time.perf_counter()
    marks: list[tuple[str, float]] = []
    last = [t_start]

    def mark(label: str) -> None:
        now = time.perf_counter()
        marks.append((label, now - last[0]))
        last[0] = now

    at = load_across_time()
    # the newest day in the feed is the as-of day, part-observed while it is
    # today; the rules and completeness read the last full day (observation_clock)
    as_of, full_through, seen = observation_clock(at["event_date"].max())
    print(f"clock: data through {as_of}" + (f", {seen:.0%} of the day seen; full days through {full_through}"
                                          if full_through < as_of else ", a full day"))
    spend = load_spend()
    emails = load_emails()
    people = load_people()
    content = load_content()
    artist_posts = load_artist_posts()
    # Every release the funnel data mentions. The configured ones (target
    # inputs on file) get the full build; the rest get an actuals-only page.
    discovered = discover_releases(at, as_of, known_codes(emails, content, artist_posts))
    # Airtable's launches: a release set up before the funnel saw it takes the
    # funnel's name once it appears, and the launches the funnel has not seen
    # yet are listed as upcoming so targets can be set before they open (§1.7).
    # Before the inputs are resolved, so an adopted name is the one resolved.
    mark("load")
    launch_frame = load_launches()
    try:
        adopted = adopt_funnel_names(INPUTS["releases"], discovered, launch_frame, at)
    except Exception as e:  # noqa: BLE001 - a page kept under its old name costs less than a lost refresh
        adopted = []
        print(f"warning: adopting the funnel's names failed ({e}) - every page keeps its name")
    # a name a page moved away from that the funnel still carries holds the
    # stray rows of that launch: no actuals-only page of its own
    moved_names = {old for _, old, _ in adopted if old in {r["release_name"] for r in discovered}}
    # each release's campaign code from its orders or its Airtable launch
    # before the guess discover_releases made (docs 11b), and before the
    # upcoming launches are guessed from the codes nobody carries
    try:
        got = source_campaign_codes(discovered, known_codes(emails, content, artist_posts), launch_frame, spend)
    except Exception as e:  # noqa: BLE001 - the guesses stand; the refresh goes on
        got = []
        print(f"warning: campaign codes from the orders and Airtable failed ({e}) - the guesses stand")
    if got:
        print(f"campaign codes: {len(got)} from the feeds where the guess found none - "
              + ", ".join(f"{rid} {code} ({src})" for rid, code, src in got[:12]) + (" ..." if len(got) > 12 else ""))
    upcoming: list[dict] = []
    if not only:
        # the codes an upcoming launch can be guessed from: those moving on Meta
        # or in the sends, less every code a release on file already carries.
        # A single-release build writes no upcoming page, so it skips this.
        in_use = {str(r.get("campaign_code")) for r in discovered + INPUTS["releases"] if r.get("campaign_code")}
        activity = {c: w for c, w in code_activity(spend, emails).items() if c not in in_use}
        upcoming = upcoming_releases(launch_frame, discovered + INPUTS["releases"], as_of, activity)
        for r in upcoming:
            r["campaign_name"] = match_campaign(r["campaign_code"], spend)
        if upcoming:
            print("upcoming from Airtable: " + ", ".join(f"{r['release_name']} (closes {r['launch_end']})" for r in upcoming))
    # the inputs in force for every configured release: Airtable's products,
    # the Notion dates, the typed figures, the funnel's clock (resolve_release)
    notion = load_notion_campaigns()
    raw_inputs = [dict(r) for r in INPUTS["releases"]]
    resolve_inputs(discovered, spend, notion)
    mark("inputs")
    posts_bench = artist_posts_benchmarks(artist_posts, as_of)
    # The draw panel, loaded once and passed down: every basket a release could
    # be benchmarked against is cut from it (BENCHMARK_SPEC §3). A panel that
    # is not there - a checkout without the clustering output - is not a reason
    # to fail the build; those releases get their actuals-only pages until it is.
    try:
        # each launch's cost per paid unit from the spend feed and the orders
        # feed's campaign codes, so a basket can price the paid budget
        panel = baskets.attach_paid_costs(baskets.load_panel(), spend, orders_campaign_codes())
        print(f"baskets: {len(panel)} draw launches in the panel")
    except (OSError, ValueError, KeyError) as e:
        panel = None
        print(f"baskets: no draw panel ({e}) - no release can be benchmarked, so none is targeted")
    if panel is not None:
        # what the panel's channel split was read from, and what reading it set aside
        try:
            basis = baskets.panel_basis()
            print(f"baskets: channel split as the feed attributed it through {basis['through'] or 'an unrecorded day'}"
                  + (f" ({basis['attribution']}; panel written {basis['built']})" if basis["attribution"] else ""))
            if baskets.GUARDED.get("units"):
                print(f"baskets: left out, units past {baskets.UNITS_MAX_MULTIPLE:g}x the edition or the orders feed: "
                      + "; ".join(baskets.GUARDED["units"]))
            if baskets.GUARDED.get("rates"):
                print(f"baskets: {len(baskets.GUARDED['rates'])} conversion rates emptied (under {baskets.RATE_MIN_SESSIONS} "
                      f"sessions, or over {baskets.RATE_MAX_PER_SESSION:g} entries or units per session): "
                      + "; ".join(baskets.GUARDED["rates"]))
            for note in baskets.GUARDED.get("skipped") or []:
                print(f"baskets: a panel guard could not run, the panel is read without it - {note}")
        except Exception as e:  # noqa: BLE001 - the log lines must never stop the refresh
            print(f"baskets: could not describe the panel ({e})")
        warn_panel(panel_unsettled(as_of))

    APP.mkdir(parents=True, exist_ok=True)
    (APP / "releases").mkdir(exist_ok=True)
    DERIVED.mkdir(exist_ok=True)

    # the shared curve panel is a function of the funnel export, not of any
    # release's inputs, so a single-release build reuses the one on disk
    curves_path = APP / "curves.json"
    if only and curves_path.exists():
        curves = json.loads(curves_path.read_text())
        print(f"curves: reused n={curves['n_releases']} from {curves_path.name}")
    else:
        curves = build_curves(at)
        curves_path.write_text(json.dumps(curves, indent=1))
        print(f"curves: n={curves['n_releases']} clean releases")

    # every launch's artist and close, for the email windows' same-artist clip
    note_launches(list(INPUTS["releases"]) + list(discovered))
    email_bench = email_delivered_benchmark(emails, as_of, discovered, spend, at)
    if email_bench and email_bench["open_rate"] is not None:
        c = email_bench["cohort"]
        ctor = f"{email_bench['ctor_rate'] * 100:.1f}%" if email_bench["ctor_rate"] is not None else "n/a"
        spc = f"{email_bench['spc_rate']:.2f}" if email_bench["spc_rate"] is not None else "n/a"
        deliv = f"{email_bench['total']:.0f}" if email_bench["total"] is not None else "none yet"
        print(f"email refs: open {email_bench['open_rate'] * 100:.1f}%, click {email_bench['click_rate'] * 100:.1f}% "
              f"of delivered, {ctor} of opens, {spc} sessions per click (median of {c['n']} draw launches "
              f"closed {c['from']}..{c['to']}); delivered median {deliv} (the fallback target)")
    else:
        print("email refs: none yet (fewer than 2 completed draw launches with sends on file) - UI defaults apply")
    by_name = {n: g for n, g in at.groupby("simple_release_name")}
    configured = {r["release_name"]: r for r in INPUTS["releases"]}
    # what an untracked share normally is, once, for every page's warning
    # (§1.3). A function of the export and the panel, not of any release's
    # inputs, so a single-release build reads the full build's figure back
    # while the export is the same day's.
    norms_path = APP / "untracked_norms.json"
    norms = direct_norm = None
    cached_ok = False
    if only and norms_path.exists():
        try:
            cached = json.loads(norms_path.read_text())
            if cached.get("asOf") == as_of.isoformat() and "direct" in cached:
                norms, direct_norm, cached_ok = cached.get("norms"), cached.get("direct"), True
        except (OSError, ValueError):
            cached_ok = False
    if not cached_ok:
        norms = untracked_norms(at, panel, as_of)
        # and what share of its group Direct normally is, for the Direct switch
        direct_norm = direct_share_norm(at, panel, as_of)
        try:
            norms_path.write_text(json.dumps({"asOf": as_of.isoformat(), "norms": norms, "direct": direct_norm}, indent=1))
        except OSError:
            pass
    if direct_norm and direct_norm.get("units") is not None:
        print(f"direct norm: {direct_norm['units']:.1%} of its group's units, {direct_norm['sessions']:.1%} of its sessions (n={direct_norm['n']}, "
              + ("read off the panel)" if direct_norm.get("source") == "panel" else "read off today's feed: the panel does not carry it yet)"))
    if norms:
        print("untracked norm: " + ", ".join(f"{k} median {v['median']:.1%} p90 {v['p90']:.1%} (n={v['n']})"
                                             for k, v in norms.items() if isinstance(v, dict) and v.get("median") is not None))
    mark("benchmarks")

    if only and tl.is_tl_id(only, {"inputs": INPUTS["releases"]}):
        # a timed launch's page: the TL model builds it and patches its row
        res = tl.build_all({"as_of": as_of, "now": datetime.now(timezone.utc), "seen": seen, "launch_frame": launch_frame,
                            "inputs": INPUTS["releases"], "spend": spend, "emails": emails, "only": only,
                            "configured_ids": {r["id"] for r in INPUTS["releases"]}})
        if res["failures"]:
            raise SystemExit(f"build: {only} failed - {res['failures'][0][1]}")
        if not res["rows"]:
            raise SystemExit(f"build: no timed launch with id {only!r}")
        snap = res["snaps"][only]
        patch_index(snap, as_of, row=res["rows"][0])
        # the inputs document's blocks for this release, so the tab reads what the page was built on
        try:
            doc = json.loads((APP / "inputs.json").read_text())
            doc.setdefault("discovered", {})[only] = res["discovered"][only]
            doc.setdefault("sourced", {})[only] = res["sourced"][only]
            (APP / "inputs.json").write_text(json.dumps(doc, indent=1))
        except (OSError, ValueError) as e:
            print(f"inputs.json: not updated for {only} ({e})")
        mark("release")
        print(f"{snap['id']}: {snap['tlState']} - {snap['tlLabel']}; signups {snap['hero']['now']:.0f} target {snap['hero']['target']}")
        print("timing: " + " | ".join(f"{label} {secs:.1f}s" for label, secs in marks) + f" | total {time.perf_counter() - t_start:.1f}s")
        print(f"wrote 1 release ({only}) -> {APP}")
        return
    if only:
        cfg = next((r for r in INPUTS["releases"] if r["id"] == only), None)
        if cfg is None:
            raise SystemExit(f"build: no configured release with id {only!r}")
        snap = with_direct_spread(build_release, cfg, at, spend, emails, content, curves, as_of,
                             artist_posts, posts_bench, email_bench, panel, people,
                                 full_through=full_through, seen=seen, untracked_norms=norms, direct_norm=direct_norm)
        check_snapshot(snap)
        warn_panel(panel_drift(snap, panel))
        write_page(APP / "releases" / f"{only}.json", snap)
        bmk = snap.get("benchmark")
        print(f"{snap['id']}: day {snap['day']}/{snap['of']} "
              f"now={snap['hero']['now']} exp={snap['hero']['expectedToday']} "
              f"target={snap['hero']['target']} proj={snap['hero']['projected']}"
              + (f" benchmark={bmk['units']} (x{bmk['k']}, {bmk['basket']['id']} n={bmk['basket']['n']})"
                 if bmk else ""))
        patch_index(snap, as_of)
        mark("release")
        print("timing: " + " | ".join(f"{label} {secs:.1f}s" for label, secs in marks)
              + f" | total {time.perf_counter() - t_start:.1f}s")
        print(f"wrote 1 release ({only}) -> {APP}")
        return

    index, written, n_full, n_actuals = [], set(), 0, 0
    def add(snap, status):
        index.append(index_row(snap, status))
    # One page's failure never stops the build (guard_page): the page is
    # skipped with its error kept for the summary line, it keeps its previous
    # file and its previous row in the index, and every other page is built
    # and indexed as usual. Before, a launch titled with a dozen works stopped
    # the build after every release page was written and before the index, so
    # every refresh failed for an evening (28 September 2026).
    failures: list[tuple[str, str]] = []
    try:
        prev_rows = {str(r.get("id")): r for r in json.loads((APP / "index.json").read_text()).get("releases", [])}
    except (OSError, ValueError):
        prev_rows = {}

    def keep_previous(rid: str) -> None:
        written.add(f"{rid}.json")
        if rid in prev_rows:
            index.append(prev_rows[rid])

    for rec in discovered:
        if rec["release_name"] in moved_names:
            continue
        cfg = configured.pop(rec["release_name"], None)
        if cfg:
            def build_targeted(cfg=cfg):
                snap = with_direct_spread(build_release, cfg, at, spend, emails, content, curves, as_of,
                                     artist_posts, posts_bench, email_bench, panel, people,
                                     full_through=full_through, seen=seen, untracked_norms=norms, direct_norm=direct_norm)
                check_snapshot(snap)
                warn_panel(panel_drift(snap, panel))
                write_page(APP / "releases" / f"{cfg['id']}.json", snap)
                add(snap, "closed" if snap["complete"] else "live")
                bmk = snap.get("benchmark")
                print(f"{snap['id']}: day {snap['day']}/{snap['of']} "
                      f"now={snap['hero']['now']} exp={snap['hero']['expectedToday']} "
                      f"target={snap['hero']['target']} proj={snap['hero']['projected']}"
                      + (f" benchmark={bmk['units']} (x{bmk['k']}, {bmk['basket']['id']} n={bmk['basket']['n']})"
                         if bmk else ""))
            if guard_page(failures, cfg["id"], build_targeted):
                n_full += 1
            else:
                keep_previous(cfg["id"])
        else:
            def build_derived(rec=rec):
                rec["campaign_name"] = match_campaign(rec["campaign_code"], spend)
                snap = with_direct_spread(build_actuals, rec, by_name[rec["release_name"]], spend, emails, content, as_of,
                                     email_bench, artist_posts, full_through=full_through, seen=seen,
                                     untracked_norms=norms, direct_norm=direct_norm)
                check_snapshot(snap)
                write_page(DERIVED / f"{rec['id']}.json", snap)
                written.add(f"{rec['id']}.json")
                add(snap, "catalogue" if snap["catalogue"] else ("closed" if snap["complete"] else "live"))
            if guard_page(failures, rec["id"], build_derived):
                n_actuals += 1
            else:
                keep_previous(rec["id"])
    # a draw campaign the orders tie to one release that no page claims
    try:
        unclaimed_draw_campaigns(spend, discovered)
    except Exception as e:  # noqa: BLE001 - a warning, never a stop
        print(f"warning: the unclaimed draw campaigns could not be listed ({e})")
    # the launches Airtable knows and the funnel does not yet: a page each,
    # with the dates, edition and price to set targets from (§1.7)
    n_upcoming = 0
    for rec in upcoming:
        def build_coming(rec=rec):
            snap = build_upcoming(rec, as_of, email_bench, full_through)
            check_snapshot(snap)
            write_page(DERIVED / f"{rec['id']}.json", snap)
            written.add(f"{rec['id']}.json")
            add(snap, "upcoming")
        if guard_page(failures, rec["id"], build_coming):
            n_upcoming += 1
        else:
            keep_previous(rec["id"])
    # configured releases the funnel data does not mention yet (announced, no
    # traffic) still get built, as before
    for cfg in configured.values():
        def build_configured(cfg=cfg):
            snap = with_direct_spread(build_release, cfg, at, spend, emails, content, curves, as_of,
                                 artist_posts, posts_bench, email_bench, panel, people,
                                     full_through=full_through, seen=seen, untracked_norms=norms, direct_norm=direct_norm)
            check_snapshot(snap)
            write_page(APP / "releases" / f"{cfg['id']}.json", snap)
            add(snap, "closed" if snap["complete"] else "live")
        if guard_page(failures, cfg["id"], build_configured):
            n_full += 1
        else:
            keep_previous(cfg["id"])
    # the timed launches (docs/TL_SPEC.md): their pages, their sidebar rows and
    # the TL panel, from the TL feeds' aggregation and Airtable's timed launches
    tl_out = {"rows": [], "discovered": {}, "sourced": {}, "written": set(), "failures": [], "note": "tl: not built"}
    try:
        tl_out = tl.build_all({"as_of": as_of, "now": datetime.now(timezone.utc), "seen": seen, "launch_frame": launch_frame,
                               "inputs": INPUTS["releases"], "spend": spend, "emails": emails,
                               "configured_ids": {r["id"] for r in INPUTS["releases"]}})
    except Exception as e:  # noqa: BLE001 - the TL pages never stop the LE build
        tl_out["note"] = f"tl: the timed launches could not be built ({type(e).__name__}: {e})"
    index.extend(tl_out["rows"])
    written |= set(tl_out["written"])
    failures.extend(tl_out["failures"])
    print(tl_out["note"])
    # a release that has left the data (or been promoted) must not linger
    for stale in DERIVED.glob("*.json"):
        if stale.name not in written:
            stale.unlink()

    index = sort_index(index)
    (APP / "index.json").write_text(json.dumps(
        {"asOf": as_of.isoformat(), "releases": index}, indent=1))
    # the draw panel as the picker's candidate rows (baskets.candidate_rows),
    # so the server serves a file rather than starting a python process per
    # open of the picker
    (APP / "basket_candidates.json").write_text(json.dumps(
        {"asOf": as_of.isoformat(), "rows": baskets.candidate_rows(panel)}, indent=1))

    # inputs document for the Target setting tab (server + web read this);
    # meta_campaigns feeds the Meta-campaign matcher (most recently active first);
    # discovered carries the derived defaults a release starts from when someone
    # sets targets for it in the dashboard
    camp = meta_campaigns(spend)
    (APP / "inputs.json").write_text(json.dumps({
        "benchmarks": BENCH,
        # the inputs as saved (the tab edits these), and beside them what the
        # feeds hold for each release - Airtable's products and dates, the
        # Notion dates, the campaigns named for the code (docs §1.6)
        "releases": {r["id"]: r for r in raw_inputs},
        "sourced": {
            **{r["id"]: sourced_inputs(r, spend, notion) for r in INPUTS["releases"]},
            **{r["id"]: sourced_inputs(r, spend, notion) for r in discovered
               if r["release_name"] not in {c["release_name"] for c in INPUTS["releases"]}},
            # an upcoming launch's Airtable products, so the Set up targets tab
            # starts from them before the funnel has a row (§1.7)
            **{r["id"]: sourced_inputs(r, spend, notion) for r in upcoming},
            # the timed launches: Airtable's products and the feed's dates (etl/tl.py sourced_for)
            **tl_out["sourced"],
        },
        "discovered": {
            r["id"]: {
                "release_name": r["release_name"], "artist": r["artist"], "title": r["title"],
                "type": r["type"], "campaign_code": r["campaign_code"],
                "code_source": r.get("code_source"),
                "campaign_name": r.get("campaign_name"),
                "announce_date": r["announce_date"], "launch_end": r["launch_end"],
                "private_room_open": r.get("private_room_open") or (
                    (date.fromisoformat(r["announce_date"]) - timedelta(days=PR_LEAD_DAYS)).isoformat()
                    if r["announce_date"] else None),
                "dates_note": r["dates_note"],
                # an upcoming launch brings Airtable's edition, price and
                # record ids, the defaults the Set up targets tab starts from
                **{k: r[k] for k in ("source", "airtable_release", "airtable_ids", "titles", "n_products",
                                     "launch_type", "project_status") if k in r},
            }
            for r in discovered + upcoming if r["release_name"] not in {c["release_name"] for c in INPUTS["releases"]}
        } | {rid: rec for rid, rec in tl_out["discovered"].items() if rid not in {c["id"] for c in INPUTS["releases"]}},
        "meta_campaigns": camp,
    }, indent=1))
    print(funnel_coverage(at, curves))
    print(units_coverage())
    if os.environ.get("CHECK_SNAPSHOT") == "warn":
        print(f"check_snapshot: {len(CHECK_WARNINGS)} page(s) with problems (warn mode: nothing stopped)")
    if PANEL_WARNINGS:
        print(f"panel: {len(PANEL_WARNINGS)} warning(s) above - the benchmark panel wants a re-run (README, 'Re-running the benchmark panel')")
    if SNAPSHOT_WARNINGS:
        print(f"check_snapshot: {len(SNAPSHOT_WARNINGS)} warning(s) from the soft checks (nothing stopped)")
    # the pages that did not build, on one line the refresh status reads
    # (server/sheets.js parseBuildSummary): the id and the error, the first
    # five in full
    if failures:
        print(f"pages failed: {len(failures)} - " + "; ".join(f"{rid}: {err}" for rid, err in failures[:5])
              + (f"; and {len(failures) - 5} more" if len(failures) > 5 else ""))
    print(f"wrote {n_full} targeted + {n_actuals} actuals-only + {n_upcoming} upcoming releases + {len(tl_out['rows'])} timed launches "
          f"({sum(1 for e in index if e['status'] == 'live')} live) -> {APP}")


if __name__ == "__main__":
    # --release <id> rebuilds one release and patches its index row; everything
    # else a save cannot change is left as the last full build wrote it
    args = sys.argv[1:]
    one = None
    if "--upcoming" in args:
        # the upcoming pages alone, from Airtable, no funnel export needed
        build_upcoming_pages()
        sys.exit(0)
    if "--release" in args:
        i = args.index("--release")
        if i + 1 >= len(args):
            raise SystemExit("build: --release needs a release id")
        one = args[i + 1]
    main(one)
