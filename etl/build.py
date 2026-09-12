#!/usr/bin/env python3
"""Build the per-release dashboard snapshots (data/app/…) from the source feeds.

Implements docs/DATA_MODEL.md exactly:
  §3 LE target model (unit splits -> channel targets -> entries -> sessions -> budget)
  §5 across-time target curves (pooled pdsa trajectories from the daily funnel export)
  §6 actuals (fan-out-safe aggregation, untracked redistribution, projected sell-through)
  §7 paid in-flight model (adjusted CPE, party ROI, budget-to-sell-out, recommendation + cap)
  §8 email/social funnel rungs
  §9 module map (hero, trajectory, channels, funnel contributions, waterfall)

and docs/BENCHMARK_SPEC.md §4-§5 for a release benchmarked against a basket of
comparable launches: the target is then the basket's medians lifted by one even
uplift K rather than a stack of quartile picks, and the snapshot carries the
benchmark alongside the target so every card can draw both. That path only
opens when the release's inputs name a benchmark_basket; without one the
quartile levers run exactly as they always have and no benchmark is written
(docs/BENCHMARK_SPEC.md §4, "targeting_mode").

Inputs:
  sources/across_time.csv           daily funnel export (channel x day x release + campaign clock)
  data/spend_daily.csv              Meta spend by campaign x day (etl/extract_spend.py)
  data/content_posts.csv            Emplifi posts by campaign (etl/extract_content.py)
  sources/all_sent_emails.csv       Klaviyo sends
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
import pathlib
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

# The basket half of the benchmark (BENCHMARK_SPEC §3): which past launches a
# release is measured against and what their medians are. It is imported rather
# than reimplemented because the picker API answers from the same module, and a
# second copy of the medians here would be a benchmark that moves when nobody
# changed anything. build.py is only ever run as a script (server/sheets.js
# execs it), so etl/ is on the path.
import baskets

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources"
DATA = ROOT / "data"
APP = DATA / "app"
# actuals-only pages for every release the funnel data mentions but nobody has
# set targets for. Regenerated on every refresh and not committed (the
# targeted ones under APP/releases are - they are the boot-time fallback).
DERIVED = APP / "derived"
PR_LEAD_DAYS = 14        # default private-room lead before announce for a derived release
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

ORGANIC_CHANNELS = list(INPUTS["channel_quality_default"].keys())
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
    export = SOURCES / "across_time.csv"
    if os.environ.get("FUNNEL_SOURCE") == "export":
        return export
    rebuilt = SOURCES / "across_time.rebuilt.csv"
    if not rebuilt.exists():
        print("funnel: across_time.rebuilt.csv is missing (run etl/aggregate_events.py) - reading the export")
        return export
    if export.exists() and rebuilt.stat().st_mtime < export.stat().st_mtime - 86400:
        print("funnel: across_time.rebuilt.csv is more than a day older than the export - reading the export")
        return export
    return rebuilt


FUNNEL_FILE = funnel_file()


def load_across_time() -> pd.DataFrame:
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


def load_spend() -> pd.DataFrame:
    df = pd.read_csv(DATA / "spend_daily.csv")
    df["spend_date"] = pd.to_datetime(df["spend_date"]).dt.date
    return df


def load_emails() -> pd.DataFrame:
    # Klaviyo aggregates are not in the live sheet; run without them if absent
    if not (SOURCES / "all_sent_emails.csv").exists():
        print("warning: sources/all_sent_emails.csv missing - email panels will be empty")
        return pd.DataFrame({
            "name": pd.Series(dtype=str), "sent_at": pd.Series(dtype="datetime64[ns]"),
            "campaign": pd.Series(dtype=str), "delivered": pd.Series(dtype=float),
            "opened": pd.Series(dtype=float), "clicked": pd.Series(dtype=float),
            "unsubscribed": pd.Series(dtype=float), "email_type": pd.Series(dtype=str),
        })
    df = pd.read_csv(SOURCES / "all_sent_emails.csv")
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
    # Artist-account posts from the Notion log (server/notion.js writes this
    # during the live refresh); optional until a NOTION_TOKEN is configured
    p = DATA / "artist_posts.csv"
    if not p.exists():
        return pd.DataFrame({"campaign_code": pd.Series(dtype=str),
                             "date": pd.Series(dtype="object"),
                             "posts": pd.Series(dtype=float)})
    df = pd.read_csv(p)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


# clock columns are per-row facts, not volumes - never redistribute them
_CLOCK_COLS = {"days_since_announcement", "days_until_launch",
               "pct_days_since_announcement", "pct_days_until_launch"}


def redistribute_untracked(df: pd.DataFrame) -> pd.DataFrame:
    """Spread the Untracked channel pro-rata over the tracked ones (docs §1.3).

    Untracked carries real demand - up to a quarter of a release's units - and
    no display group claims it, so leaving it in place drops it from every
    channel rollup while the release-level sums still count it. That mismatch
    is what let hero.now print below sellthrough.sold, which is arithmetically
    impossible for secured units. Folding it in here, before anything reads the
    frame, keeps both paths on one basis.

    Shares come from the same day's tracked mix. A day carrying untracked
    volume with nothing tracked to spread it over would lose that volume, so
    it is pooled and shared out on the release's overall mix instead.
    """
    unt = df[df["channel"] == "Untracked"]
    tracked = df[df["channel"] != "Untracked"].copy()
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


def referral_artist_tier(release: dict) -> str:
    default = INPUTS["channel_quality_default"].get("Referral Artist", "Medium")
    return (release.get("channel_quality_overrides") or {}).get("Referral Artist", default)


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
        n = float(ap[(ap["campaign_code"] == r["campaign_code"])
                     & (ap["date"] >= start) & (ap["date"] <= end)]["posts"].sum())
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

def quality_for(release: dict, channel: str) -> str:
    return release.get("channel_quality_overrides", {}).get(
        channel, INPUTS["channel_quality_default"][channel])


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
    if n in (None, "") and isinstance(release.get("products"), list):
        n = len(release["products"])
    if n not in (None, "") and float(n) >= 1:
        return max(1.0, 1.0 + slope * math.log(float(n))), "products"
    if profile and profile.get("units_per_buyer", 0) > 0:
        return float(profile["units_per_buyer"]), "basket"
    return 1.0, "default"


def benchmark_targets(release: dict, profile: dict, upb_slope: float = UNITS_PER_BUYER_FALLBACK) -> dict:
    """Targets from a basket's medians (BENCHMARK_SPEC §4).

    One even uplift K = edition / median units carries every volume - sessions,
    entries, units, spend - in every channel and on every day. Conversion rates
    are held at the benchmark: a target that quietly assumes the site converts
    better than it ever has is a target nobody can act on, so the uplift is
    asked of traffic and spend only.

    The return carries exactly the lever model's top-level keys. Everything
    downstream - group_targets, the channel loop, the paid model, the web's
    target rail - reads this dict by name, and the benchmark is a different way
    of arriving at the same quantities, not a different set of them.
    """
    b = BENCH
    size = float(release["edition_size"])
    k = size / profile["units"]
    e2o = b["eligible_entry_to_order"]
    units = {g: profile["units_by_group"][g] * k for g in baskets.GROUPS}
    sessions = {g: profile["sessions_by_group"][g] * k for g in baskets.GROUPS}

    paid_units = units["paid"]
    organic_units = size - paid_units
    pr_units = units["aa_email"] * profile["private_room_share"]
    draw_units = organic_units - pr_units

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
        # private-room units ride with AA Email by the workbook's convention
        # (group_targets adds them back), so only the draw half of the email
        # group is what its channels split between them
        g_units = units[g] - (pr_units if g == "aa_email" else 0.0)
        conv = profile["conv"][g]
        for c, share in _group_channel_split(g).items():
            purchases = g_units * share
            per_channel[c] = {
                # "benchmark" rather than a quartile: no lever was picked here
                "quality": "benchmark",
                # kept as the share of all draw units, the meaning the lever
                # model gives this key, so the target table reads the same
                "order_split": (purchases / draw_units) if draw_units else share,
                "purchases": purchases,
                "eligible_entries": purchases / e2o,
                "sessions": sessions[g] * share,
                "session_to_entry": conv,
            }

    cpp = b["cost_per_purchase"][release["cpp_pick"]]
    budget = profile["units_by_group"]["paid"] * cpp * k
    launch_value = size * release["unit_price"]
    organic_sessions_draw = sum(pc["sessions"] for pc in per_channel.values())

    out = {
        "edition_size": release["edition_size"],
        "paid_pct": (paid_units / size) if size else 0.0, "paid_units": paid_units,
        "organic_units": organic_units,
        "pr_other_pct": (pr_units / organic_units) if organic_units else 0.0,
        "pr_units": pr_units, "draw_units": draw_units,
        "per_channel": per_channel,
        "pr_sessions": pr_units / b["email_session_to_purchase"],
        "paid": {
            "units": paid_units, "eligible_entries": paid_units / e2o,
            "sessions": sessions["paid"], "session_to_entry": profile["conv"]["paid"],
            "cost_per_purchase": cpp, "budget": budget,
            "budget_pct_of_launch_value": budget / launch_value if launch_value else None,
            "sense_check_breached": (budget / launch_value) > b["budget_sense_check_max_pct_of_launch_value"] if launch_value else False,
        },
        "launch_value": launch_value,
        "units_per_buyer": upb, "units_per_buyer_source": upb_source,
        "buyers": size / upb, "buyers_by_group": buyers,
        "organic_sessions_draw": organic_sessions_draw,
        # the basket's own session total at the uplift. Private-room sessions
        # are not added on top as the lever model does: the email median is
        # measured on launches that ran a private room, so those sessions are
        # already inside it and counting them twice would inflate the only
        # number on the page that claims to be all the traffic.
        "total_sessions": organic_sessions_draw + sessions["paid"],
        # entries carry the same uplift as the units they convert from (§4):
        # every secured unit is an entry that converted at e2o, private-room
        # units included, so the whole edition divided by that rate
        "entries_target": sum(pc["eligible_entries"] for pc in per_channel.values()) + paid_units / e2o,
        "buffer": b["target_buffer"],
    }
    # the partition the whole page rests on: what the five groups are asked to
    # sell is the edition, no more and no less (§4)
    rolled = sum(g["units"] for g in group_targets(out).values())
    assert abs(rolled - size) <= 0.5, (
        f"benchmark group targets sum to {rolled:.2f}, edition size is {size:.0f}")
    return out


def compute_targets(release: dict, profile: dict | None = None, upb_slope: float = UNITS_PER_BUYER_FALLBACK) -> dict:
    # Benchmark mode (BENCHMARK_SPEC §4) when the release has a basket profile.
    # A basket whose median units are zero says nothing about what to aim for -
    # there is no K to compute - so it falls through to the levers rather than
    # failing the build.
    if profile and profile.get("units"):
        return benchmark_targets(release, profile, upb_slope)
    b = BENCH
    size = release["edition_size"]
    _lever_upb, _lever_upb_src = units_per_buyer_for(release, None, upb_slope)
    paid_pct = b["paid_share_of_units"][
        {"Small": "Low", "Medium": "Medium", "Large": "High",
         "Low": "Low", "High": "High"}[release["paid_channel_size"]]]
    # the workbook's "Paid (% Total)" overwrite: the team sets the paid share
    # directly when the quartile pick is not the plan (Warhol: 66% paid)
    if release.get("paid_share_override") is not None:
        paid_pct = float(release["paid_share_override"])
    paid_units = round(size * paid_pct)
    organic_units = size - paid_units
    pr_pct = b["pv_other_share_of_units"][release["reference_point"]]
    pr_units = organic_units * pr_pct
    draw_units = organic_units - pr_units

    shares = {}
    for c in ORGANIC_CHANNELS:
        q = quality_for(release, c)
        shares[c] = 0.0 if q == "N/A" else b["order_split"][c][q]
    total_share = sum(shares.values())
    split = {c: (s / total_share if total_share else 0.0) for c, s in shares.items()}

    e2o = b["eligible_entry_to_order"]
    per_channel = {}
    for c in ORGANIC_CHANNELS:
        q = quality_for(release, c)
        purchases = draw_units * split[c]
        entries = purchases / e2o
        conv = b["session_to_eligible_entry"][c][q] if q != "N/A" else 0.0
        sessions = entries / conv if conv else 0.0
        per_channel[c] = {
            "quality": q, "order_split": split[c], "purchases": purchases,
            "eligible_entries": entries, "sessions": sessions, "session_to_entry": conv,
        }

    pr_sessions = pr_units / b["email_session_to_purchase"]

    paid_conv = b["paid_session_to_eligible_entry"][release["paid_conv_quality"]]
    paid_entries = paid_units / e2o
    paid_sessions = paid_entries / paid_conv
    cpp = b["cost_per_purchase"][release["cpp_pick"]]
    budget = cpp * paid_units
    launch_value = size * release["unit_price"]

    return {
        "edition_size": size,
        "paid_pct": paid_pct, "paid_units": paid_units,
        "organic_units": organic_units,
        "pr_other_pct": pr_pct, "pr_units": pr_units, "draw_units": draw_units,
        "per_channel": per_channel,
        "pr_sessions": pr_sessions,
        "paid": {
            "units": paid_units, "eligible_entries": paid_entries,
            "sessions": paid_sessions, "session_to_entry": paid_conv,
            "cost_per_purchase": cpp, "budget": budget,
            "budget_pct_of_launch_value": budget / launch_value if launch_value else None,
            "sense_check_breached": (budget / launch_value) > b["budget_sense_check_max_pct_of_launch_value"] if launch_value else False,
        },
        "launch_value": launch_value,
        # the lever arm has no basket to read a rate off, so it takes the curve
        # at the release's own product count, or one piece per buyer (§4.2)
        "units_per_buyer": _lever_upb, "units_per_buyer_source": _lever_upb_src,
        "buyers": float(release["edition_size"]) / _lever_upb,
        "organic_sessions_draw": sum(pc["sessions"] for pc in per_channel.values()),
        "total_sessions": sum(pc["sessions"] for pc in per_channel.values()) + pr_sessions + paid_sessions,
        # the eligible-entry target the rail prints; the JS model has always
        # returned it, so a snapshot without it leaves that row reading zero
        "entries_target": sum(pc["eligible_entries"] for pc in per_channel.values()) + paid_entries,
        "buffer": b["target_buffer"],
    }


def group_targets(targets: dict) -> dict:
    """Roll per-channel targets up to display groups.

    `units` is the secured-units target (draw/pre-order purchases per channel;
    private-room units ride with AA Email per the workbook convention - the
    template models all PR purchases through the email channel; paid = paid
    units). Group unit targets sum exactly to the edition size (sellout).
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
                "units": purchases + (targets["pr_units"] if g == "aa_email" else 0.0),
                "sessions": sum(targets["per_channel"][c]["sessions"] for c in chans),
            }
    return out


# ---------------------------------------------------------------- curves (docs §5)

CLEAN_EXCLUDE_STAGES = {"Missing campaign dates", "Outside campaign window"}


def pdsa_for(release: dict, d: date) -> float:
    a = date.fromisoformat(release["announce_date"])
    e = date.fromisoformat(release["launch_end"])
    L = (e - a).days
    return (d - a).days / L if L else 0.0


EMAIL_REF_MONTHS = 24   # rate references: draw launches that closed within this span


def email_delivered_benchmark(emails: pd.DataFrame, as_of: date, discovered: list[dict] = (),
                              spend: pd.DataFrame | None = None) -> dict | None:
    """Email references from the sends on file (HubSpot on the live site).

    Delivered-emails target: median total among completed configured
    campaigns, plus the pooled cumulative delivery-timing curve on the
    standard pdsa grid (email volume is send-driven and spiky - a pro-rata
    line would misread early campaigns). Totals scale with the release, so
    this cohort stays the configured (targeted) releases.

    Open-rate and click-rate references: the median of each completed draw
    launch's pooled rate (opened, or clicked, over delivered across its
    launch-window sends). Rates do not scale with the release, so this cohort
    adds every discovered release whose Meta campaign is a draw and whose
    dates are complete, closed within EMAIL_REF_MONTHS.

    Each part is None until >= 2 launches qualify; the whole is None when
    neither does."""
    if emails.empty:
        return None

    def window_sends(code, start, end):
        sub = emails[(emails["campaign"] == code)
                     & (emails["sent_at"].dt.date >= start)
                     & (emails["sent_at"].dt.date <= end)]
        core = sub[sub["email_type"].isin(["GEN", "CUS", "INS"])]
        if core.empty and not sub.empty:
            core = sub[~sub["email_type"].isin(["TRNS", "AUT", "FREQ", "TEST"])]
        return core if float(core["delivered"].sum()) >= 100 else None

    def rate_row(rid, end, core):
        total = float(core["delivered"].sum())
        opened, clicked = float(core["opened"].sum()), float(core["clicked"].sum())
        return (rid, end, opened / total, clicked / total, clicked / opened if opened > 0 else None)

    shares, totals, rates, seen = [], [], [], set()
    recent = as_of - timedelta(days=EMAIL_REF_MONTHS * 30)
    for r in INPUTS["releases"]:
        seen.add(r["campaign_code"])
        end = date.fromisoformat(r["launch_end"])
        if end >= as_of:
            continue
        ann = date.fromisoformat(r["announce_date"])
        core = window_sends(r["campaign_code"], date.fromisoformat(r["private_room_open"]), end)
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
        shares.append(row)
        totals.append(total)
        if end >= recent:
            rates.append(rate_row(r["id"], end, core))
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
        core = window_sends(code, ann - timedelta(days=PR_LEAD_DAYS), end)
        if core is not None:
            rates.append(rate_row(r["id"], end, core))

    out = {"total": None, "curve": None, "open_rate": None, "click_rate": None, "ctor_rate": None, "cohort": None}
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
        out["cohort"] = {"n": len(rates), "releases": [x[0] for x in rates],
                         "from": rates[-1][1].isoformat(), "to": rates[0][1].isoformat()}
    return out if (out["total"] is not None or out["open_rate"] is not None) else None


def email_refs(bench: dict | None) -> dict:
    """The email rate references as the UI reads them (percent) plus the
    cohort behind them; the UI falls back to fixed defaults on None."""
    if not bench or bench.get("open_rate") is None:
        return {"emailOpenRateRef": None, "emailClickRateRef": None, "emailClickToOpenRef": None,
                "emailRefCohort": None}
    return {"emailOpenRateRef": round(bench["open_rate"] * 100, 1),
            "emailClickRateRef": round(bench["click_rate"] * 100, 1),
            "emailClickToOpenRef": round(bench["ctor_rate"] * 100, 1) if bench.get("ctor_rate") is not None else None,
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
    # Paid units book on the draw-close date (winners are allocated then), so a
    # units-shaped paid plan cliffs ~46 pts on the final day while the plotted
    # actual (secured units) accrues entry-timed. Plan paid units on the entries
    # shape instead - demand timing, not allocation bookkeeping (docs §5.3).
    if curves["groups"].get("paid", {}).get("entries"):
        curves["groups"]["paid"]["units"] = curves["groups"]["paid"]["entries"]
    # p25/p75 band for the all-entries curve (status guardrails)
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
    if not fname or not (SOURCES / fname).exists():
        return None
    products = [p["name"] for p in release.get("products", [])]
    per_product = defaultdict(int)
    tiers = defaultdict(int)
    total = eligible = framed = preorder = wanted_units = surplus = 0
    with (SOURCES / fname).open() as f:
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


# ---------------------------------------------------------------- per-release snapshot

def daterange(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


# ---------------------------------------------------------------- every release

_QUARTER_RE = re.compile(r"^(\d{4}) Q([1-4])$")
_CODE_RE = re.compile(r"^([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d{2})$")


def slugify(name: str) -> str:
    """Release name -> id the server will accept ([a-z0-9_])."""
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", name.lower())).strip("_")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def known_codes(emails: pd.DataFrame, content: pd.DataFrame, artist_posts: pd.DataFrame | None) -> set[str]:
    """Campaign codes the other feeds use (AntonyMic_LE_26, CindySher_TL_25...)."""
    out = set(INPUTS_CODES)
    for col, frame in (("campaign", emails), ("campaign_code", content), ("campaign_code", artist_posts)):
        if frame is not None and col in frame.columns:
            out.update(str(v) for v in frame[col].dropna().unique())
    return {c for c in out if _CODE_RE.match(c)}


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


def discover_releases(at: pd.DataFrame, as_of: date, codes: set[str]) -> list[dict]:
    """One record per simple_release_name in the funnel data.

    Dates come from the campaign clock the export carries (docs §1.5): announce
    = event_date - days_since_announcement, close = event_date +
    days_until_launch, taken from rows on the non-negative side of each so the
    truncation toward zero cannot shift them by a day. A release without the
    clock is catalogue: a work still drawing traffic, with no campaign window
    to measure against. Clock dates that make no sense (close before
    announce, or a window outside 3..90 days) are dropped with a note rather
    than trusted - two upstream rows do that today."""
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
            "announce_date": announce.isoformat() if announce else None,
            "launch_end": launch.isoformat() if launch else None,
            "dates_note": note,
            "first_seen": st["first"].isoformat(), "last_seen": st["last"].isoformat(),
            "sessions": float(st["sessions"]), "entries": float(st["entries"]), "units": float(st["units"]),
        })
    return out


def build_actuals(rec: dict, rat: pd.DataFrame, spend: pd.DataFrame, emails: pd.DataFrame,
                  content: pd.DataFrame, as_of: date, email_bench: dict | None = None) -> dict:
    """Actuals-only snapshot for a release nobody has set targets for. Same
    shape as build_release's so the page code has one contract, with every
    target-derived field None and targeted: False - the page shows what
    happened without pretending to know what should have. Setting targets in
    the dashboard promotes the release to build_release on the next rebuild."""
    b = BENCH
    e2o = b["eligible_entry_to_order"]
    name = rec["release_name"]
    dated = rec["announce_date"] is not None
    if dated:
        announce = date.fromisoformat(rec["announce_date"])
        launch_end = date.fromisoformat(rec["launch_end"])
        window_start = announce - timedelta(days=PR_LEAD_DAYS)
        L = (launch_end - announce).days
        complete = as_of >= launch_end
        day_n = max(min((as_of - announce).days, L), 0)
    else:
        launch_end = as_of
        window_start = as_of - timedelta(days=CATALOGUE_DAYS)
        L = CATALOGUE_DAYS
        complete = False
        day_n = CATALOGUE_DAYS
    rat = rat.copy()
    rat["group"] = rat["channel"].map(GROUP_OF)
    win = rat[(rat["event_date"] >= window_start) & (rat["event_date"] <= min(as_of, launch_end + timedelta(days=2)))]
    win = redistribute_untracked(win)
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

    # ---- paid actuals: spend, entries, cost per entry. ROI and the budget
    # recommendation need the profit split, so they stay None.
    camp = rec.get("campaign_name")
    psp = spend[spend["campaign_name"] == camp] if camp else spend.iloc[0:0]
    psp = psp[(psp["spend_date"] >= window_start) & (psp["spend_date"] <= min(as_of, launch_end))]
    spend_day = psp.groupby("spend_date")["spend"].sum()
    paid_entries_day = (win[win["channel"] == "Paid Social"]
                        .groupby("event_date")["Draw_Entries_Eligible_Units"].sum())
    drop = b["paid_drop_off"]
    paid_daily, win3 = [], []
    cum_spend = cum_pentries = 0.0
    for d in days:
        if d > min(as_of, launch_end):
            break
        s_, e_ = float(spend_day.get(d, 0.0)), float(paid_entries_day.get(d, 0.0))
        cum_spend += s_; cum_pentries += e_
        win3 = (win3 + [(s_, e_)])[-3:]
        paid_daily.append({"date": d.isoformat(), "spend": round(s_, 2), "entries": e_, "roi": None})
    s3, e3 = sum(x for x, _ in win3), sum(y for _, y in win3)
    l3d_raw = s3 / e3 if e3 > 0 else None
    l3d_cpe = l3d_raw / (1 - drop) if l3d_raw else None
    cum_cpe = cum_spend / (cum_pentries * (1 - drop)) if cum_pentries else None
    current_daily = float(spend_day.get(as_of, spend_day.iloc[-1] if len(spend_day) else 0.0))
    paid_out = {
        "daily": paid_daily,
        "spendToDate": round(cum_spend, 2), "entriesToDate": cum_pentries,
        # paid entries are draw entries; only (1 - drop_off) of them convert to
        # an order. The card's bars are drawn in units, so the units figure is
        # published rather than left to the page to derive.
        "unitsToDate": round(cum_pentries * (1 - drop), 1),
        "cumRoi": None, "l3dRoi": None,
        "l3dCpe": round(l3d_cpe, 2) if l3d_cpe else None,
        "cumCpe": round(cum_cpe, 2) if cum_cpe else None,
        "roiDeclineModel": {"start": None, "dailyFactor": None}, "roiTarget": None,
        "budget": {"current": round(current_daily, 2), "recommended": None, "cap": None,
                   "finalDayRoi": None, "floor": None, "budgetToSellOut": None,
                   "entriesNeeded": None, "selloutGap": None, "organicFuture": None,
                   "daysLeft": max((launch_end - as_of).days, 0)},
        "unitTarget": None, "entriesProjected": None, "unitProjected": None,
        "spendBudget": None, "spendProjectedTotal": None,
        "profitPerUnitAA": None, "profitPerUnitArtist": None, "aaBudgetShare": None,
    }
    feed_through = email_feed_through(emails)
    em = emails.iloc[0:0]
    if code:
        em_all = emails[(emails["campaign"] == code)
                        & (emails["sent_at"].dt.date >= window_start)
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
    ct = content.iloc[0:0]
    if code:
        ct = content[(content["campaign_code"] == code)
                     & (content["Date"].dt.date >= window_start)
                     & (content["Date"].dt.date <= min(as_of, launch_end))]
    posts = ct[ct["Content type"].isin(["post", "collaboration", "reply", "shared"])] if len(ct) else ct
    social_out = {
        "posts": int(len(posts)), "stories": int((ct["Content type"] == "story").sum()) if len(ct) else 0,
        "impressions": int(pd.to_numeric(ct["Total impressions"], errors="coerce").fillna(0).sum()) if len(ct) else 0,
        "engagements": int(pd.to_numeric(ct["Engagements"], errors="coerce").fillna(0).sum()) if len(ct) else 0,
        "artistPosts": None, "artistPostsTarget": None,
    }
    return {
        "id": rec["id"], "releaseName": name,
        "artist": rec["artist"], "title": rec["title"], "quarter": rec["quarter"],
        "type": rec["type"],
        "campaignCode": code, "campaignName": camp, "marketingLead": None, "privateRoomOpen": None,
        "windowStart": rec["announce_date"] if dated else window_start.isoformat(),
        "windowEnd": rec["launch_end"] if dated else None,
        "campaignLengthDays": L if dated else None, "day": day_n, "of": L,
        "asOf": as_of.isoformat(), "complete": complete,
        "targeted": False, "catalogue": not dated,
        "derived": {
            "announce_date": rec["announce_date"], "launch_end": rec["launch_end"],
            "dates_source": "campaign clock" if dated else None, "dates_note": rec["dates_note"],
            "campaign_code": code, "first_seen": rec["first_seen"], "last_seen": rec["last_seen"],
        },
        "economics": None, "currency": "units",
        "hero": {"now": round(hero_now, 0), "expectedToday": None, "delta": None, "projected": None,
                 "target": None, "oversubscribedUnits": 0, "statusPct": None, "ok": None},
        "targets": None, "groupTargets": None,
        "channels": channels_out,
        "funnelByGroup": funnel_by_group, "paid": paid_out,
        "email": email_out, "social": social_out,
        "sellthrough": {"edition": None, "sold": round(units_sold, 0),
                        "soldPredicted": round(unconverted * e2o, 1), "futureEntriesPredicted": None, "pct": None},
        "draw": None, "geo": None, "waterfall": None,
        "totals": {"sessions": round(float(upto["Sessions_Total"].sum())), "units": round(units_sold),
                   "entries": round(float(upto["Draw_Entries_Eligible_Units"].sum()))},
        "benchmarks": {"chargeDropOff": 1 - e2o, "cannibalisation": b["cannibalisation"], "targetBuffer": b["target_buffer"],
                       **email_refs(email_bench)},
    }


def build_release(release: dict, at: pd.DataFrame, spend: pd.DataFrame,
                  emails: pd.DataFrame, content: pd.DataFrame, curves: dict,
                  as_of: date, artist_posts: pd.DataFrame | None = None,
                  posts_bench: dict | None = None,
                  email_bench: dict | None = None,
                  panel: pd.DataFrame | None = None,
                  people: pd.DataFrame | None = None) -> dict:
    b = BENCH
    # one fit per build, over every release whose product count is recorded (§4.2)
    upb_slope = units_per_buyer_curve(people)
    name = release["release_name"]
    announce = date.fromisoformat(release["announce_date"])
    launch_end = date.fromisoformat(release["launch_end"])
    pr_open = date.fromisoformat(release["private_room_open"])
    L = (launch_end - announce).days

    # ---- benchmark or levers (BENCHMARK_SPEC §3-§5). Benchmarking is the
    # default: a release with no saved basket is compared against the basket
    # its own shape puts it in (baskets.suggest_basket), so a launch is
    # measured against comparable launches from the day it is discovered and
    # nobody has to pick anything first. The quartile levers survive as the
    # explicit opt-out - stretch_mode "levers" - for the release whose target
    # is not an even uplift on what similar launches do.
    basket = profile = None
    if release.get("stretch_mode") != "levers" and panel is not None and len(panel):
        basket = baskets.resolve_basket(release.get("benchmark_basket"), panel, release, as_of)
        if basket["profile"]["units"] <= 0:
            print(f"{release['id']}: basket {basket['id']} has no median units - staying on the levers")
            basket = None
        else:
            # Every release gets a benchmark, including one bigger than
            # anything on record. The basket search falls back to the launches
            # nearest this edition in size rather than giving up, so an
            # unprecedented edition is benchmarked against the biggest launches
            # there have been and the uplift states how far past them it is
            # being asked to go. That is a number someone can argue with; an
            # empty panel is not. scaleMismatch is still published so the card
            # can say the basket is nowhere near this edition's size.
            profile = basket["profile"]
            if basket.get("scaleMismatch"):
                print(f"{release['id']}: edition {release['edition_size']:.0f} is far outside the "
                      f"panel - benchmarked against {basket['id']} (n={basket['n']}, "
                      f"medians {basket['profile']['units']:.0f})")
    bench = profile is not None
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
    bm_units = profile["units_by_group"] if bench else {}
    bm_sessions = profile["sessions_by_group"] if bench else {}
    rcurves = basket_curves(at, basket, curves) if bench else curves

    rat = at[at["simple_release_name"] == name].copy()
    rat["group"] = rat["channel"].map(GROUP_OF)
    window_start = min(pr_open, announce)
    win = rat[(rat["event_date"] >= window_start) & (rat["event_date"] <= min(as_of, launch_end + timedelta(days=2)))]
    # Fold Untracked into the tracked channels ONCE, here, so the group rollups
    # below and the release-level sums further down agree (docs §1.3).
    win = redistribute_untracked(win)
    # Orders from draw winners land in the two days after close. win keeps
    # them (that is what the grace is for) but the daily series ends at close,
    # so the hero, the channels and sell-through disagreed by exactly those
    # units - and "secured" could read below "sold". Fold them into the close
    # day: at close then includes what the close triggered.
    win = win.assign(event_date=win["event_date"].where(win["event_date"] <= launch_end, launch_end))

    # daily series per display group: actual cumulative entries + plan
    days = list(daterange(window_start, launch_end))
    day_idx = min((as_of - announce).days, (launch_end - announce).days)
    complete = as_of >= launch_end

    by_group_day = (win.groupby(["group", "event_date"])
                    .agg(sessions=("Sessions_Total", "sum"),
                         entries=("Draw_Entries_Eligible_Units", "sum"),
                         entries_no_conv=("Draw_Entries_Total_Units_No_Conv", "sum"),
                         units=("Total_Product_Units", "sum"),
                         pr_units=("Product_Units_Private_Room", "sum"))
                    .reset_index())

    # ---- paid actuals + forward model, computed first: the paid channel's projection
    # is projected spend ÷ projected cost-per-entry, not a trajectory curve (docs §5.4)
    camp = release.get("campaign_name")
    psp = spend[spend["campaign_name"] == camp] if camp else spend.iloc[0:0]
    psp = psp[(psp["spend_date"] >= window_start) & (psp["spend_date"] <= min(as_of, launch_end))]
    paid_entries_day = (win[win["channel"] == "Paid Social"]
                        .groupby("event_date")["Draw_Entries_Eligible_Units"].sum())
    spend_day = psp.groupby("spend_date")["spend"].sum()
    drop, cann = b["paid_drop_off"], b["cannibalisation"]
    ppu_aa = release["aa_group_profit"] / release["edition_size"] + (
        b["frame_conversion"] * b["frame_profit_per_unit"] if release["framing_available"] else 0)
    ppu_artist = (release["artist_profit"] / release["edition_size"]) if release["edition_size"] else 0
    # Who funds the ads. Explicit per-release override (the workbook's "AA budget
    # share (%)" row - e.g. Glenn Ligon 100% AA); default: commission/rev-share
    # deals (artist profit share 0) are AA-funded, otherwise split 50/50.
    aa_budget_share = release.get("aa_budget_share")
    if aa_budget_share is None:
        aa_budget_share = 1.0 if release["artist_profit_share"] == 0 else 0.5

    # daily 'roi' is the trailing-3-CALENDAR-day rolling ROI: a window with
    # spend but no entries is a genuine 0, a window with no spend is null
    paid_daily = []
    cum_spend = cum_pentries = 0.0
    win3: list[tuple[float, float]] = []
    for d in days:
        if d > min(as_of, launch_end):
            break
        s = float(spend_day.get(d, 0.0))
        e = float(paid_entries_day.get(d, 0.0))
        cum_spend += s; cum_pentries += e
        win3.append((s, e))
        if len(win3) > 3:
            win3.pop(0)
        s3 = sum(x for x, _ in win3); e3 = sum(y for _, y in win3)
        if s3 <= 0:
            roi3 = None
        elif e3 <= 0:
            roi3 = 0.0
        else:
            roi3 = (1 - cann) * ppu_aa / ((s3 / (e3 * (1 - drop))) * aa_budget_share)
        paid_daily.append({"date": d.isoformat(), "spend": round(s, 2), "entries": e,
                           "roi": round(roi3, 3) if roi3 is not None else None})
    # trailing 3-calendar-day CPE (adjusted = per expected-converting unit);
    # CPE stays unknown when the window bought no entries - the ROI reads 0
    s3 = sum(x for x, _ in win3); e3 = sum(y for _, y in win3)
    l3d_raw_cpe = s3 / e3 if e3 > 0 else None
    l3d_cpe = l3d_raw_cpe / (1 - drop) if l3d_raw_cpe else None
    cum_adj_cpe = cum_spend / (cum_pentries * (1 - drop)) if cum_pentries else None
    cum_roi = ((1 - cann) * ppu_aa / (cum_adj_cpe * aa_budget_share)) if cum_adj_cpe else None
    l3d_roi = ((1 - cann) * ppu_aa / (l3d_cpe * aa_budget_share)) if l3d_cpe \
        else (0.0 if s3 > 0 else None)

    # ---- one forward cost path, shared by the ROI chart and the recommendation.
    # Cost per entry drifts by the LE spend rules' daily tiers (5/7/10% a day
    # by third of the window), compounded day by day from today. The workbook's
    # flat "forecast CPE = L3D x 1.5" described the same future for the budget;
    # using one for the chart and the other for the decision put them on
    # different paths, and the floor could pass while the line went under 1.
    tiers = b["spend_rules"]["cpe_daily_drift_by_third"]
    drift_path = []                     # (day, cumulative drift factor) per future day
    _cum = 1.0
    for d in daterange(as_of + timedelta(days=1), launch_end):
        _t3 = min(int(max(pdsa_for(release, d), 0) * 3), 2)
        _cum *= (1 + tiers[_t3])
        drift_path.append((d, _cum))
    drift_end = drift_path[-1][1] if drift_path else 1.0
    inv_drift_sum = sum(1 / f for _, f in drift_path)     # entries per £ over the window, relative to today
    forecast_cpe = l3d_cpe                                # today's price (per converting unit), the anchor
    cpe_end = l3d_cpe * drift_end if l3d_cpe else None    # at close, at today's spend

    units_sold = float(win["Total_Product_Units"].sum())
    entries_banked = float(win["Draw_Entries_Total_Units_No_Conv"].sum())
    inventory_left = max(release["edition_size"] - units_sold, 0)
    # Sell-out sizing: paid only tops up the gap ORGANIC is not on course to
    # fill. Net off what is already secured (banked entries count at 0.8) plus
    # the same shape-following organic projection the channel loop below runs
    # (docs §5.4), then price only the residual entries.
    secured_now = units_sold + b["eligible_entry_to_order"] * entries_banked
    organic_future = 0.0
    if not complete:
        pdsa_now = pdsa_for(release, min(as_of, launch_end))
        obs = by_group_day[by_group_day["event_date"] <= min(as_of, launch_end)]
        for og in DISPLAY_GROUPS:
            if og == "paid":
                continue
            sub_g = obs[obs["group"] == og]
            now_g = (float(sub_g["units"].sum())
                     + b["eligible_entry_to_order"] * float(sub_g["entries_no_conv"].sum()))
            tgt_g = gtargets[og]["units"]
            w_g = curve_value(rcurves, og, "units", pdsa_now)
            r_perf = min(max((now_g / (tgt_g * w_g)) if tgt_g * w_g > 0 else 1.0, 0.25), 2.5)
            organic_future += tgt_g * (1 - w_g) * (1 + w_g * (r_perf - 1))
    sellout_gap = max(release["edition_size"] - secured_now - organic_future, 0.0)
    entries_needed = sellout_gap * (1 + drop)
    days_left = max((launch_end - as_of).days, 0)
    current_daily = float(spend_day.get(as_of, spend_day.iloc[-1] if len(spend_day) else 0.0))

    # ---- the recommendation (docs §7).
    # Price: cost per entry is not flat in spend. Within a campaign it rises as
    # spend^eps (eps measured on our own campaigns, benchmarks
    # cpe_spend_elasticity; etl/analysis/cpe_elasticity.py), so the entries a
    # recommendation asks for are priced at the CPE that spend level implies,
    # anchored on today's price at today's spend, and drifting along the same
    # path the ROI chart draws. Units: sellout_gap is units, the price is £
    # per converting unit (raw CPE / (1 - drop-off)).
    rules = b["spend_rules"]
    eps = float(b.get("cpe_spend_elasticity", 0.0) or 0.0)
    s0 = current_daily if current_daily > 0 else 0.0
    plan_rate = (targets["paid"]["budget"] / L) if L else 0.0
    cpe_max = (1 - cann) * ppu_aa / (b["roi_floor"] * aa_budget_share)   # price at the ROI floor

    def cpe_at(spend, drift=1.0):
        """Cost per converting unit at a daily spend level, after `drift`."""
        if not forecast_cpe:
            return None
        if eps <= 0 or s0 <= 0 or spend <= 0:
            return forecast_cpe * drift
        return forecast_cpe * (spend / s0) ** eps * drift

    supply_spend = roi_spend = None
    if forecast_cpe and days_left and inv_drift_sum > 0:
        if sellout_gap <= 0:
            supply_spend = 0.0
        elif eps > 0 and s0 > 0:
            # sum_t s / (cpe(s) * D_t) = gap  ->  s^(1-eps) = gap * cpe0 / (s0^eps * sum_t 1/D_t)
            supply_spend = (sellout_gap * forecast_cpe / (s0 ** eps * inv_drift_sum)) ** (1 / (1 - eps))
        else:
            supply_spend = sellout_gap * forecast_cpe / inv_drift_sum
        # the ROI floor is a floor on ROI AT CLOSE, on the drifted path - the
        # same point the chart's dashed line ends on
        if eps > 0 and s0 > 0:
            roi_spend = s0 * (cpe_max / cpe_end) ** (1 / eps)
        else:
            roi_spend = math.inf if cpe_end <= cpe_max else 0.0

    # the workbook's pacing rules, transcribed into the benchmarks but never
    # applied until now: cumulative ROI below 0.9 -> decrease, above 1.3 ->
    # increase, between -> hold; daily change capped at 30%; changes under 10%
    # ignored; 3 days of forecast ROI below target force a decrease.
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
        if unconstrained <= 0:
            recommended, cap = 0.0, base            # nothing needed, or the floor says stop
        elif zero_pause and s0 > 0:
            recommended, cap = 0.0, "zero_conversion_pause"
        elif zero_cut and s0 > 0:
            recommended = min(unconstrained, s0 * (1 - rules.get("zero_conversion_decrease", 0.3)))
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
    cpe_rec = cpe_at(recommended, drift_end) if recommended else None
    final_day_roi = ((1 - cann) * ppu_aa / (cpe_rec * aa_budget_share)) if cpe_rec else None
    # the chart's line: ROI at today's spend along the drift path
    roi_path = ([{"date": d.isoformat(), "roi": round(l3d_roi / f, 3)} for d, f in drift_path]
                if l3d_roi is not None and not complete else [])

    drift = b["spend_rules"]["cpe_daily_drift_by_third"]
    third = min(int(max(pdsa_for(release, as_of), 0) * 3), 2)
    daily_factor = round(1 / (1 + drift[third]), 4)

    # forward path: projected spend ÷ projected cost-per-entry per future day.
    # Projections describe the CURRENT trajectory (spend run-rate as-is); the
    # recommended budget is the intervention shown alongside, not the projection.
    # Efficiency decays by the launch-window-third drift tiers (5%/7%/10% per day).
    planned_spend = current_daily if current_daily > 0 else (
        recommended if (days_left and recommended) else 0.0)
    paid_future = {}          # date -> cumulative projected entries beyond today
    future_cum = 0.0
    cpe_fwd = l3d_raw_cpe
    if not complete:
        prev_curve = curve_value(rcurves, "paid", "entries", pdsa_for(release, as_of))
        for d in daterange(as_of + timedelta(days=1), launch_end):
            if cpe_fwd and planned_spend:
                t3 = min(int(max(pdsa_for(release, d), 0) * 3), 2)
                cpe_fwd = cpe_fwd * (1 + drift[t3])
                future_cum += planned_spend / cpe_fwd
            else:
                # no spend history yet: fall back to the paid target trajectory
                cv = curve_value(rcurves, "paid", "entries", pdsa_for(release, d))
                future_cum += gtargets["paid"]["entries"] * max(cv - prev_curve, 0.0)
                prev_curve = cv
            paid_future[d] = future_cum

    channels_out = []
    hero_now = hero_exp = hero_target = hero_proj = 0.0
    hero_bm = hero_bm_today = 0.0        # benchmark at close, benchmark by today
    funnel_by_group = {}
    e2o = b["eligible_entry_to_order"]
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
            cv = curve_value(rcurves, g, "units", p)
            # in benchmark mode the plan IS the benchmark lifted by K, taken
            # off the one curve, so the two lines the trajectory draws are in
            # the K ratio on every day rather than only in total (§4.1)
            bm_day = bm_tgt * cv
            plan = bm_day * k if bench else tgt * cv
            row_out = {"date": d.isoformat(),
                       "actual": round(cum_u + e2o * cum_nc, 2) if d <= as_of else None,
                       "plan": round(plan, 2), "proj": None}
            if bench:
                row_out["bm"] = round(bm_day, 2)
            daily.append(row_out)
        pdsa_today = pdsa_for(release, min(as_of, launch_end))
        w = curve_value(rcurves, g, "units", pdsa_today)   # share of campaign observed, per historic shape
        bm_exp = bm_tgt * w                                # benchmark pace by today
        exp = bm_exp * k if bench else tgt * w
        sess_w = curve_value(rcurves, g, "sessions", pdsa_today)
        sess_exp = sess_tgt * sess_w
        now = next((r["actual"] for r in reversed(daily) if r["actual"] is not None), 0.0)
        # Forward projection (docs §5.4): the remaining volume follows this channel's
        # HISTORIC shape curve; its level scales with demonstrated performance
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
            for d in daterange(as_of + timedelta(days=1), launch_end):
                i = (d - window_start).days
                cv = curve_value(rcurves, g, "units", pdsa_for(release, d))
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

    # ---- paid block output (docs §7; inputs computed above, before the channel loop)
    paid_out = {
        "daily": paid_daily,
        "spendToDate": round(cum_spend, 2),
        "entriesToDate": cum_pentries,
        # secured units to date, the same currency as unitTarget, unitProjected
        # and benchmarkUnits - paid entries are one drop-off short of an order
        "unitsToDate": round(cum_pentries * (1 - drop), 1),
        "cumRoi": round(cum_roi, 3) if cum_roi else None,
        "l3dRoi": round(l3d_roi, 3) if l3d_roi is not None else None,
        "l3dCpe": round(l3d_cpe, 2) if l3d_cpe else None,
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
            "driftToClose": round(drift_end, 3),
            "paced": paced,
            "elasticity": eps,
            "band": band, "forcedDecrease": forced, "zeroConversionDays": zero_days,
            "cumRoi": round(cum_roi, 3) if cum_roi else None,
            "entriesNeeded": round(entries_needed, 1),
            "selloutGap": round(sellout_gap, 1),
            "organicFuture": round(organic_future, 1),
            "daysLeft": days_left,
        },
        "unitTarget": targets["paid"]["units"],
        "entriesProjected": round(cum_pentries + future_cum, 1),
        "unitProjected": round((cum_pentries + future_cum) * (1 - drop), 1),
        "spendBudget": round(targets["paid"]["budget"], 2),
        "spendProjectedTotal": round(cum_spend + (planned_spend or 0) * days_left, 2),
        "profitPerUnitAA": round(ppu_aa, 2),
        "profitPerUnitArtist": round(ppu_artist, 2),
        "aaBudgetShare": aa_budget_share,
    }
    if bench:
        # what the basket typically buys, and what it typically costs to buy -
        # both unscaled, so the card can say what the uplift is asking for on
        # top (§5). The target's own budget stays targets["paid"]["budget"].
        paid_out["benchmarkUnits"] = round(bm_units["paid"], 1)
        paid_out["benchmarkBudget"] = round(bm_units["paid"] * targets["paid"]["cost_per_purchase"], 2)

    # ---- email funnel (docs §8): launch-window customer sends for this campaign
    feed_through = email_feed_through(emails)
    em_all = emails[(emails["campaign"] == release["campaign_code"])
                    & (emails["sent_at"].dt.date >= window_start)
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
    # expected delivered by today: cohort median total x pooled delivery-timing curve
    email_out["deliveredTarget"] = None
    if email_bench and email_bench["total"] is not None:
        p = pdsa_for(release, min(as_of, launch_end))
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

    # ---- social content
    ct = content[(content["campaign_code"] == release["campaign_code"])
                 & (content["Date"].dt.date >= window_start)
                 & (content["Date"].dt.date <= min(as_of, launch_end))]
    posts = ct[ct["Content type"].isin(["post", "collaboration", "reply", "shared"])]
    social_out = {
        "posts": int(len(posts)), "stories": int((ct["Content type"] == "story").sum()),
        "impressions": int(pd.to_numeric(ct["Total impressions"], errors="coerce").fillna(0).sum()),
        "engagements": int(pd.to_numeric(ct["Engagements"], errors="coerce").fillna(0).sum()),
    }
    # artist-account posts (Notion log) + tier benchmark, None until the feed exists
    tier = referral_artist_tier(release)
    if artist_posts is None or artist_posts.empty:
        social_out["artistPosts"] = None
    else:
        apw = artist_posts[(artist_posts["campaign_code"] == release["campaign_code"])
                           & (artist_posts["date"] >= window_start)
                           & (artist_posts["date"] <= min(as_of, launch_end))]
        social_out["artistPosts"] = int(apw["posts"].sum())
    pb = posts_bench or {}
    social_out["artistPostsTarget"] = None if tier == "N/A" else pb.get(tier, pb.get("_all"))

    # ---- sell-through (release level; per-product editions not in feeds yet)
    unconverted = float(win["Draw_Entries_Total_Units_No_Conv"].sum())
    sold_predicted = unconverted * b["eligible_entry_to_order"]
    pdsa_today = pdsa_for(release, min(as_of, launch_end))
    # units still to come = the shaped secured-units projection beyond today (docs §5.4/§6.4)
    future_entries = 0.0 if complete else max(hero_proj - hero_now, 0.0)
    sellthrough = {
        "edition": release["edition_size"],
        "sold": round(units_sold, 0),
        "soldPredicted": round(min(sold_predicted, inventory_left), 1),
        "futureEntriesPredicted": round(min(future_entries, max(inventory_left - sold_predicted, 0)), 1),
    }
    sellthrough["pct"] = round(min((sellthrough["sold"] + sellthrough["soldPredicted"]
                                    + sellthrough["futureEntriesPredicted"]) / release["edition_size"], 1.0), 4)
    if bench:
        sellthrough["benchmarkUnits"] = round(hero_bm, 1)

    # ---- waterfall (docs §9): contributors to projection - target, in secured units
    organic_groups = [g for g in DISPLAY_GROUPS if g != "paid"]
    wf_traffic = sum(funnel_by_group[g]["contrib_traffic"] for g in organic_groups)
    wf_conv = sum(funnel_by_group[g]["contrib_conversion"] for g in organic_groups)
    spend_planned_to_date = targets["paid"]["budget"] * curve_value(rcurves, "paid", "units", pdsa_today)
    wf_paid_spend = ((cum_spend - spend_planned_to_date) / targets["paid"]["cost_per_purchase"]
                     ) if targets["paid"]["cost_per_purchase"] else 0.0
    paid_gap = funnel_by_group["paid"]["contrib_traffic"] + funnel_by_group["paid"]["contrib_conversion"]
    wf_paid_eff = paid_gap - wf_paid_spend
    # scale contributor gaps (to-date) to close: same blend factor as projections
    scale = ((hero_proj - hero_target) / (wf_traffic + wf_conv + wf_paid_spend + wf_paid_eff)
             if (wf_traffic + wf_conv + wf_paid_spend + wf_paid_eff) else 0.0)
    waterfall = {
        "target": round(hero_target, 0), "projection": round(hero_proj, 0),
        "steps": [
            {"key": "organic_traffic", "label": "Organic traffic", "value": round(wf_traffic * scale, 0)},
            {"key": "organic_conversion", "label": "Organic conversion", "value": round(wf_conv * scale, 0)},
            {"key": "paid_spend", "label": "Paid spend", "value": round(wf_paid_spend * scale, 0)},
            {"key": "paid_efficiency", "label": "Paid efficiency", "value": round(wf_paid_eff * scale, 0)},
        ],
    }
    # force exact reconciliation (rounding residual goes to the largest step)
    resid = round(hero_proj - hero_target, 0) - sum(s["value"] for s in waterfall["steps"])
    if waterfall["steps"]:
        biggest = max(waterfall["steps"], key=lambda s: abs(s["value"]))
        biggest["value"] += resid
    if bench:
        # The same four contributors, measured to date and left unscaled: this
        # is the Today horizon (§2), where the question is why the launch is
        # where it is, not where it will end. The gaps are already actual minus
        # target today by construction (traffic + conversion per group is
        # exactly that group's now minus its expected), so they need no blend
        # factor - only the same rounding reconciliation the close steps get.
        today_steps = [
            {"key": "organic_traffic", "label": "Organic traffic", "value": round(wf_traffic, 0)},
            {"key": "organic_conversion", "label": "Organic conversion", "value": round(wf_conv, 0)},
            {"key": "paid_spend", "label": "Paid spend", "value": round(wf_paid_spend, 0)},
            {"key": "paid_efficiency", "label": "Paid efficiency", "value": round(wf_paid_eff, 0)},
        ]
        # the gap the bars have to span is the one the card prints, so the
        # residual is measured against the rounded pair rather than the raw
        # difference - rounding each end separately can move it by a unit
        actual_today, target_today = round(hero_now, 0), round(hero_exp, 0)
        resid_today = (actual_today - target_today) - sum(s["value"] for s in today_steps)
        max(today_steps, key=lambda s: abs(s["value"]))["value"] += resid_today
        waterfall["benchmark"] = round(hero_bm, 0)
        waterfall["stretch"] = round(hero_target - hero_bm, 0)
        waterfall["today"] = {
            "benchmark": round(hero_bm_today, 0),
            "stretch": round(hero_exp - hero_bm_today, 0),
            "target": target_today,
            "actual": actual_today,
            "steps": today_steps,
        }
        assert abs(sum(s["value"] for s in today_steps) - (actual_today - target_today)) < 0.5, (
            f"{release['id']}: today waterfall steps do not reconcile to actual - target")

    draw = load_draw(release)

    day_n = max(min((as_of - announce).days, L), 0)
    edition = float(release["edition_size"])
    status_pct = (min(hero_now, edition) - hero_exp) / hero_exp if hero_exp else 0.0
    snap = {
        "id": release["id"],
        "releaseName": name,
        "artist": name.split(" · ")[0], "title": name.split(" · ")[1],
        "type": "LE",
        "campaignCode": release["campaign_code"], "campaignName": camp,
        "marketingLead": release["marketing_lead"],
        "privateRoomOpen": release["private_room_open"],
        "windowStart": release["announce_date"], "windowEnd": release["launch_end"],
        "campaignLengthDays": L, "day": day_n, "of": L,
        "asOf": as_of.isoformat(), "complete": complete,
        "targetingMode": "benchmark" if bench else "levers",
        "economics": {
            "unitPrice": release["unit_price"], "launchValue": targets["launch_value"],
            "artistProfitPerUnit": round(ppu_artist, 2), "aaProfitPerUnit": round(ppu_aa, 2),
            "artistProfitShare": release["artist_profit_share"],
        },
        "currency": "units",
        "hero": {
            "now": round(min(hero_now, edition), 0), "expectedToday": round(hero_exp, 0),
            "delta": round(min(hero_now, edition) - hero_exp, 0),
            "projected": round(min(hero_proj, edition), 0), "target": round(hero_target, 0),
            "oversubscribedUnits": round(max(max(hero_now, hero_proj) - edition, 0), 0),
            "statusPct": round(status_pct, 4), "ok": status_pct >= -0.1,
        },
        "targets": targets, "groupTargets": gtargets,
        "channels": channels_out,
        "funnelByGroup": funnel_by_group,
        "paid": paid_out,
        # what the plan assumes each buyer takes and what they have taken so
        # far, so the funnel can split its conversion step in two (§4.2)
        "unitsPerBuyer": {"plan": round(upb_plan, 4), "actual": round(upb_actual, 4)},
        "email": email_out,
        "social": social_out,
        "sellthrough": sellthrough,
        "draw": draw,
        "geo": None,  # country dim not in any feed yet (docs §12)
        "waterfall": waterfall,
        "benchmarks": {
            "chargeDropOff": 1 - b["eligible_entry_to_order"],
            "cannibalisation": b["cannibalisation"],
            "targetBuffer": b["target_buffer"],
            **email_refs(email_bench),
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
            "unitsP25": round(profile["units_p25"], 1), "unitsP75": round(profile["units_p75"], 1),
            "sessions": round(profile["sessions"], 1), "entries": round(profile["entries"], 1),
            "campaignDays": round(profile["campaign_days"], 1),
            "k": round(k, 4),
            "stretchUnits": round(edition - profile["units"], 1), "stretchPct": round(k - 1, 4),
            "unitsByGroup": {g: round(v, 1) for g, v in bm_units.items()},
            "sessionsByGroup": {g: round(v, 1) for g, v in bm_sessions.items()},
            "convByGroup": {g: round(v, 6) for g, v in profile["conv"].items()},
            "paidBudget": round(bm_units["paid"] * targets["paid"]["cost_per_purchase"], 2),
            # the people behind the basket's units, at the rate the target
            # holds. The rate is held at the benchmark, so the whole uplift
            # falls on the buyer count and benchmark x K is the target (§4.2)
            "unitsPerBuyer": round(upb, 4),
            "buyers": round(profile["units"] / upb, 1) if upb else None,
        }
        snap["hero"]["benchmark"] = round(hero_bm, 0)
        snap["hero"]["benchmarkToday"] = round(hero_bm_today, 0)
        snap["hero"]["stretch"] = round(hero_target - hero_bm, 0)
        # secured vs what a comparable launch had by today. The sidebar's middle
        # state is exactly this sign, and the index carries it so the sidebar
        # does not have to guess the boundary from statusPct - 1/K moves with
        # the release, from +15% to -54% across the launches on file.
        snap["hero"]["benchmarkPct"] = (
            round((min(hero_now, edition) - hero_bm_today) / hero_bm_today, 4)
            if hero_bm_today else None)
    return snap


# ---------------------------------------------------------------- main

def check_snapshot(snap: dict) -> None:
    """Cross-check a snapshot's own arithmetic before it is written.

    These are relationships that must hold by definition, so a breach means a
    code path disagrees with another one - the class of bug where two cards
    print different answers for the same quantity. Cheap to run, and it fails
    the build rather than shipping a number that cannot be true.
    """
    rid = snap.get("id", "?")
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
        # this release.
        lifted = (hero.get("benchmark") or 0) * bm["k"]
        if abs(lifted - (hero.get("target") or 0)) > 0.5 * bm["k"] + 1.0:
            problems.append(f"hero.benchmark x k is {lifted:.1f} but hero.target is {hero.get('target')}")
        wf_today = (snap.get("waterfall") or {}).get("today") or {}
        steps = sum(s["value"] for s in wf_today.get("steps") or [])
        gap = (wf_today.get("actual") or 0) - (wf_today.get("target") or 0)
        if abs(steps - gap) > 0.5:
            problems.append(f"today waterfall steps sum to {steps:.1f}, actual - target is {gap:.1f}")
    if problems:
        raise AssertionError(f"{rid}: " + "; ".join(problems))


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


def index_row(snap: dict, status: str) -> dict:
    """One sidebar row. Shared so the whole build and a single-release rebuild
    cannot drift into describing the same release two different ways."""
    return {
        "id": snap["id"], "name": f"{snap['artist']} - {snap['title']}",
        "releaseName": snap["releaseName"], "artist": snap["artist"], "title": snap["title"],
        "quarter": snap.get("quarter"), "type": snap["type"],
        "status": status, "targeted": snap.get("targeted", True),
        "day": snap["day"], "of": snap["of"], "complete": snap["complete"],
        "windowEnd": snap.get("windowEnd"),
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
    closed = sorted([e for e in index if e["status"] == "closed"],
                    key=lambda e: e["windowEnd"] or "", reverse=True)
    catalogue = sorted([e for e in index if e["status"] == "catalogue"],
                       key=lambda e: -(e["sessions"] or 0))
    return live + closed + catalogue


def patch_index(snap: dict, as_of: date) -> None:
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
    status = "closed" if snap["complete"] else "live"
    row = index_row(snap, status)
    rows = [r for r in doc.get("releases", []) if r.get("id") != snap["id"]]
    rows.append(row)
    doc["releases"] = sort_index(rows)
    doc["asOf"] = as_of.isoformat()
    path.write_text(json.dumps(doc, indent=1))


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
    at = load_across_time()
    as_of = at["event_date"].max() - timedelta(days=1)  # last full day (export cut mid-day)
    spend = load_spend()
    emails = load_emails()
    people = load_people()
    content = load_content()
    artist_posts = load_artist_posts()
    posts_bench = artist_posts_benchmarks(artist_posts, as_of)
    # The draw panel, loaded once and passed down: every basket a release could
    # be benchmarked against is cut from it (BENCHMARK_SPEC §3). A panel that
    # is not there - a checkout without the clustering output - is not a reason
    # to fail the build; those releases simply stay on the levers.
    try:
        panel = baskets.load_panel()
        print(f"baskets: {len(panel)} draw launches in the panel")
    except (OSError, ValueError, KeyError) as e:
        panel = None
        print(f"baskets: no draw panel ({e}) - every release stays on the lever model")

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

    # Every release the funnel data mentions. The configured ones (target
    # inputs on file) get the full build; the rest get an actuals-only page.
    discovered = discover_releases(at, as_of, known_codes(emails, content, artist_posts))
    email_bench = email_delivered_benchmark(emails, as_of, discovered, spend)
    if email_bench and email_bench["open_rate"] is not None:
        c = email_bench["cohort"]
        ctor = f"{email_bench['ctor_rate'] * 100:.1f}%" if email_bench["ctor_rate"] is not None else "n/a"
        deliv = f"{email_bench['total']:.0f}" if email_bench["total"] is not None else "none yet"
        print(f"email refs: open {email_bench['open_rate'] * 100:.1f}%, click {email_bench['click_rate'] * 100:.1f}% "
              f"of delivered, {ctor} of opens (median of {c['n']} draw launches closed {c['from']}..{c['to']}); "
              f"delivered median {deliv}")
    else:
        print("email refs: none yet (fewer than 2 completed draw launches with sends on file) - UI defaults apply")
    by_name = {n: g for n, g in at.groupby("simple_release_name")}
    configured = {r["release_name"]: r for r in INPUTS["releases"]}

    if only:
        cfg = next((r for r in INPUTS["releases"] if r["id"] == only), None)
        if cfg is None:
            raise SystemExit(f"build: no configured release with id {only!r}")
        snap = build_release(cfg, at, spend, emails, content, curves, as_of,
                             artist_posts, posts_bench, email_bench, panel, people)
        check_snapshot(snap)
        (APP / "releases" / f"{only}.json").write_text(json.dumps(snap, indent=1))
        bmk = snap.get("benchmark")
        print(f"{snap['id']}: day {snap['day']}/{snap['of']} "
              f"now={snap['hero']['now']} exp={snap['hero']['expectedToday']} "
              f"target={snap['hero']['target']} proj={snap['hero']['projected']}"
              + (f" benchmark={bmk['units']} (x{bmk['k']}, {bmk['basket']['id']} n={bmk['basket']['n']})"
                 if bmk else ""))
        patch_index(snap, as_of)
        print(f"wrote 1 release ({only}) -> {APP}")
        return

    index, written, n_full, n_actuals = [], set(), 0, 0
    def add(snap, status):
        index.append(index_row(snap, status))

    for rec in discovered:
        cfg = configured.pop(rec["release_name"], None)
        if cfg:
            snap = build_release(cfg, at, spend, emails, content, curves, as_of,
                                 artist_posts, posts_bench, email_bench, panel, people)
            check_snapshot(snap)
            (APP / "releases" / f"{cfg['id']}.json").write_text(json.dumps(snap, indent=1))
            add(snap, "closed" if snap["complete"] else "live")
            n_full += 1
            bmk = snap.get("benchmark")
            print(f"{snap['id']}: day {snap['day']}/{snap['of']} "
                  f"now={snap['hero']['now']} exp={snap['hero']['expectedToday']} "
                  f"target={snap['hero']['target']} proj={snap['hero']['projected']}"
                  + (f" benchmark={bmk['units']} (x{bmk['k']}, {bmk['basket']['id']} n={bmk['basket']['n']})"
                     if bmk else ""))
        else:
            rec["campaign_name"] = match_campaign(rec["campaign_code"], spend)
            snap = build_actuals(rec, by_name[rec["release_name"]], spend, emails, content, as_of, email_bench)
            check_snapshot(snap)
            (DERIVED / f"{rec['id']}.json").write_text(json.dumps(snap, indent=1))
            written.add(f"{rec['id']}.json")
            add(snap, "catalogue" if snap["catalogue"] else ("closed" if snap["complete"] else "live"))
            n_actuals += 1
    # configured releases the funnel data does not mention yet (announced, no
    # traffic) still get built, as before
    for cfg in configured.values():
        snap = build_release(cfg, at, spend, emails, content, curves, as_of,
                             artist_posts, posts_bench, email_bench, panel, people)
        check_snapshot(snap)
        (APP / "releases" / f"{cfg['id']}.json").write_text(json.dumps(snap, indent=1))
        add(snap, "closed" if snap["complete"] else "live")
        n_full += 1
    # a release that has left the data (or been promoted) must not linger
    for stale in DERIVED.glob("*.json"):
        if stale.name not in written:
            stale.unlink()

    index = sort_index(index)
    (APP / "index.json").write_text(json.dumps(
        {"asOf": as_of.isoformat(), "releases": index}, indent=1))

    # inputs document for the Target setting tab (server + web read this);
    # meta_campaigns feeds the Meta-campaign matcher (most recently active first);
    # discovered carries the derived defaults a release starts from when someone
    # sets targets for it in the dashboard
    camp = (spend.groupby("campaign_name")
                 .agg(spend=("spend", "sum"), last=("spend_date", "max"))
                 .reset_index()
                 .sort_values(["last", "spend"], ascending=False))
    (APP / "inputs.json").write_text(json.dumps({
        "benchmarks": BENCH,
        "channel_quality_default": INPUTS["channel_quality_default"],
        "releases": {r["id"]: r for r in INPUTS["releases"]},
        "discovered": {
            r["id"]: {
                "release_name": r["release_name"], "artist": r["artist"], "title": r["title"],
                "type": r["type"], "campaign_code": r["campaign_code"],
                "campaign_name": r.get("campaign_name"),
                "announce_date": r["announce_date"], "launch_end": r["launch_end"],
                "private_room_open": ((date.fromisoformat(r["announce_date"]) - timedelta(days=PR_LEAD_DAYS)).isoformat()
                                      if r["announce_date"] else None),
                "dates_note": r["dates_note"],
            }
            for r in discovered if r["release_name"] not in {c["release_name"] for c in INPUTS["releases"]}
        },
        "meta_campaigns": [
            {"name": r.campaign_name, "spend": round(float(r.spend), 2), "last": r.last.isoformat()}
            for r in camp.itertuples()
        ],
    }, indent=1))
    print(funnel_coverage(at, curves))
    print(f"wrote {n_full} targeted + {n_actuals} actuals-only releases "
          f"({sum(1 for e in index if e['status'] == 'live')} live) -> {APP}")


if __name__ == "__main__":
    # --release <id> rebuilds one release and patches its index row; everything
    # else a save cannot change is left as the last full build wrote it
    args = sys.argv[1:]
    one = None
    if "--release" in args:
        i = args.index("--release")
        if i + 1 >= len(args):
            raise SystemExit("build: --release needs a release id")
        one = args[i + 1]
    main(one)
