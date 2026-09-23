#!/usr/bin/env python3
"""Baskets of comparable launches and the medians the benchmark is read from.

Implements docs/BENCHMARK_SPEC.md §3. The benchmark is "what launches like this
one typically reach": the median of a matched basket, per metric and per
channel. This module owns the basket half of that sentence - which past
launches count as comparable, and what their medians are. §4 (the target
maths) and the snapshot writing live in etl/build.py.

Why a module of its own: the panel and the profile are needed in three places
that must agree exactly - the ETL that writes the snapshot, the basket picker
API (spec §6) and the re-run a saved basket triggers. A disagreement there
shows up as a benchmark line that moves when nobody changed anything, so the
medians are computed once, here, and nowhere else.

Two rules carry most of the weight:

  * A release is never a member of its own benchmark (§3.1). Leaving it in
    lets a launch grade itself, and on a small cluster it drags the median
    towards its own result.
  * Per-channel benchmarks are median share x median total, never the median
    of the per-channel column (§3.2). The per-channel medians of a basket do
    not sum to its median total - each channel peaks on a different launch -
    so taking them directly would leave the five channel benchmarks summing to
    something other than the headline the card prints above them.

Inputs are the two files the clustering analysis writes
(etl/analysis/release_clusters.py): data/release_clusters.csv, one row per
release with its window, features and cluster, and
data/release_cluster_baskets.json for the cluster names. Custom baskets saved
from the picker live in data/app/baskets.json.

Pure and dependency-light on purpose: pandas and the standard library only, no
imports from build.py, so the API's node shim can call it without pulling the
whole ETL into memory.
"""
from __future__ import annotations

import json
import math
import numpy as np
import pathlib
import re
from datetime import date

import pandas as pd

# The fixed rates the panel's unit_price_gbp was converted at. The API shim
# imports this module as etl.baskets from the repo root, the ETL as baskets
# from inside etl/, so both spellings of the neighbour are tried.
try:
    from pricing import RATES_TO_GBP
except ImportError:  # pragma: no cover - the shim's import path
    from etl.pricing import RATES_TO_GBP

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PANEL_PATH = DATA / "release_clusters.csv"
BASKETS_PATH = DATA / "release_cluster_baskets.json"
SAVED_PATH = DATA / "app" / "baskets.json"
# Distinct buyers and the draw's product count, written per release by
# etl/aggregate_events.py. The panel counts units, not people, and units per
# buyer is the difference between them: on a multi-product release the median
# buyer takes more than one piece, so a target in units needs fewer people than
# it has units (BENCHMARK_SPEC §4.2).
PEOPLE_PATH = DATA / "app" / "release_people.csv"

# The five display groups (docs/DATA_MODEL.md §1.3). Order matters: it is the
# order the profile dicts and the per-channel table are written in.
GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"]

READY_WINDOW_DAYS = 365   # "last 12 months" for the all_12m basket
MIN_MEMBERS = 3           # below this a basket cannot be used at all (§3.2)
# Below this a basket is usable but flagged as thin. It was ten, which the
# rule now never reaches: the measure is how far the median moves when one
# member is dropped, and over the draw panel that is 2.8% at eight, 3.3% at
# six and 4.8% at four. Six is where it starts to climb, so six is the flag.
THIN_MEMBERS = 6

# Cluster names come from the panel's own cluster_name column so the picker and
# the analysis write-up never drift apart. Cluster 2's analysis name carries the
# defining feature ("with a private room"); that reads as a qualifier in a radio
# card next to the description, so it is trimmed for display only.
CLUSTER_NAME_TRIM = " with a private room"
DEFAULT_CLUSTER_NAMES = {
    0: "Paid-led headline launches",
    1: "Paid-supported small editions",
    2: "Email-led collector launches",
    3: "Artist-audience draws",
}
DESCS = {
    "cluster_0": "Big editions carried by paid social, email second.",
    "cluster_1": "Small runs where paid still leads the traffic.",
    "cluster_2": "No paid: the list and the private room do the work.",
    "cluster_3": "Small and short, sold to the artist's own following.",
    "all_12m": "Everything that closed in the last year, all shapes.",
}
ALL_12M_NAME = "All draw launches, last 12 months"
SAME_ARTIST_NAME = "Same artist, earlier launches"
SIMILAR_NAME = "Similar size and shape"

# The clusters are shapes, not sizes: cluster 0 runs from 15 units to 987 with a
# median of 214, so benchmarking a 900-unit edition against it compares a launch
# to launches an order of magnitude smaller and calls the difference a stretch.
# The default basket therefore intersects the shape cluster with a band around
# the edition size, widening the band only as far as it must to find enough
# launches to take a median over, and dropping the shape constraint before it
# gives up on scale. Scale is the harder constraint because every headline
# number on the page is a volume.
# The basket is the SIMILAR_N launches nearest this one, and nothing else. A
# widening band picked a set whose size nobody chose - Warhol got six, Zeng
# Fanzhi twenty-three - and leave-one-out over the 106 priced draw launches
# says the size is what matters and smaller is better: the band rule predicts
# units to a median error of x1.31 (72% within 1.5x), the eight nearest to
# x1.21 (83%), and it degrades steadily from there - twelve x1.23, twenty
# x1.24, forty-five x1.32, worse than the rule it replaced. A paired bootstrap
# puts eight ahead of twelve in 96% of resamples and ahead of forty-five in
# all of them.
#
# It cannot separate four, six, eight and ten, so the count is settled on
# steadiness instead: dropping one member moves the median 4.8% at four, 3.3%
# at six, 2.8% at eight and 2.2% at twelve. Eight is where accuracy has
# stopped improving and steadiness is still cheap, which matters because the
# picker's whole interaction is ticking members in and out.
SIMILAR_N = 8
SCALE_MISMATCH_FACTOR = 4.0   # beyond this the basket is not a comparable at all

# The artist's own earlier launches go into the basket first - there is no
# better comparable than the same artist's last draw - unless one of them is
# further than OWN_MAX away on either axis, when it is a different kind of
# launch and takes its chances with everything else.
OWN_MAX = 3.0
# "Prefer recent" (release input prefer_recent, on by default) ranks launches
# closed in the last RECENT_MONTHS ahead of older ones, but only among those
# within NEAR on both axes: the market moves, so between two comparables the
# newer one is the better witness, but recency never reaches past what is
# comparable at all to pull in a launch for being new.
NEAR = 4.0
RECENT_MONTHS = 18

# Distance is on two axes, units and unit price (etl/pricing.py,
# unit_price_gbp), and a launch is only as near as its worse one: matched on
# size at four times the price is not a comparable, and a single figure taken
# over both axes says so without saying which. Size carries the units
# benchmark, price carries the conversion benchmarks - the sessions and
# entries targets are the units target over the basket's conversion rates, and
# those move with price more than with anything else on file
# (etl/analysis/price_probe.py, docs/BENCHMARK_SPEC.md 3.1). With
# SIMILAR_USE_PRICE off the price range is still profiled and shown in the
# picker, it just does not decide membership.
#
# The shape cluster used to be the first constraint, intersected with the
# bands. It is gone from selection: at the same basket size it moved the units
# benchmark for two of nine live releases and left seven untouched, which is
# what the leave-one-out says too - swapping members inside a size band barely
# moves a median. It still names the basket and still fills the picker.
SIMILAR_USE_PRICE = True

# The planned paid share of units by paid_channel_size, mirroring the quartiles
# in etl/benchmarks.json (paid_share_of_units: Low / Medium / High). It is only
# ever a tie-break between two clusters that sit the same distance from the
# edition size in log space (§3.3), so a small drift from the frozen benchmark
# file cannot change a benchmark - and copying it keeps this module free of the
# ETL's own inputs.
PAID_PLAN = {"Low": 0.078, "Small": 0.078, "Medium": 0.246, "High": 0.365, "Large": 0.365}
PAID_PLAN_DEFAULT = 0.246

# Columns the profile reads. Everything numeric is coerced on load because the
# panel is written by an analysis script, not a schema: a column that is empty
# for the legacy rows comes back as object dtype and a median over it silently
# becomes NaN.
_BASE_NUMERIC = [
    "tot_total_product_units", "tot_sessions_total", "tot_draw_entries_eligible_units",
    "tot_draw_entries_total_units", "campaign_days", "private_room_share", "oversubscription",
    "cluster", "cluster_k2", "nearest_cluster", "dist_to_centroid", "year",
    # edition pricing, joined from Airtable by etl/pricing.py (docs/DATA_MODEL.md)
    "unit_price", "unit_price_gbp", "edition_size", "launch_value", "launch_value_gbp",
    "n_products", "price_min", "price_max", "price_match_score", "price_match_days",
]
_GROUP_NUMERIC = ["unit_share_", "sess_share_", "ent_share_", "conv_sess_entry_",
                  "conv_sess_unit_", "sessions_", "entries_", "units_"]
_DATE_COLS = ["window_start", "window_end", "announce", "close", "first_seen", "last_seen"]

_panel_cache: pd.DataFrame | None = None
_names_cache: dict[int, str] | None = None


# ---------------------------------------------------------------- the panel

def _join_people(df: pd.DataFrame) -> pd.DataFrame:
    """Add distinct buyers, the product count and units per buyer.

    The people file is written from the event feed, so it counts a buyer once
    for the whole release rather than once per channel-day. Missing rows leave
    NaN: a median skips them, which is the right answer for a launch the event
    feed does not reach back to.
    """
    for col in ("buyers", "products", "products_known", "units_per_buyer", "purchased_units"):
        if col in df.columns:
            df = df.drop(columns=[col])
    try:
        ppl = pd.read_csv(PEOPLE_PATH,
                          usecols=lambda c: c in ("release_name", "buyers", "units",
                                                  "products", "products_known", "draws"))
        ppl = ppl.rename(columns={"units": "purchased_units"})
    except (OSError, ValueError):
        df["buyers"] = float("nan")
        df["products"] = float("nan")
        df["products_known"] = False
        df["units_per_buyer"] = float("nan")
        return df
    ppl["release_name"] = ppl["release_name"].astype(str)
    ppl["products_known"] = ppl["products_known"].astype(str).str.lower().isin(("true", "1"))
    df = df.merge(ppl, on="release_name", how="left")
    buyers = pd.to_numeric(df["buyers"], errors="coerce")
    # both sides of the rate come from the event feed: purchased pieces over the
    # people who purchased them. Dividing the funnel export's units by the event
    # feed's buyers would mix two counts of the same thing - the export's units
    # include unconverted entries at the eligible rate, which have no buyer yet -
    # and the rate is read against itself all over the page.
    units = pd.to_numeric(df["purchased_units"], errors="coerce")
    df["buyers"] = buyers
    df["units_per_buyer"] = (units / buyers.where(buyers > 0))
    df["products"] = pd.to_numeric(df["products"], errors="coerce")
    df["products_known"] = df["products_known"].fillna(False).astype(bool)
    return df


def load_panel() -> pd.DataFrame:
    """The draw panel: the 108 launches that ran the draw mechanic.

    Cached for the life of the process - the ETL profiles a dozen baskets per
    release and the API answers the picker from the same frame. Callers treat
    it as read-only.
    """
    global _panel_cache
    if _panel_cache is not None:
        return _panel_cache
    df = pd.read_csv(PANEL_PATH, low_memory=False)
    df = df[df["panel"].astype(str).str.strip() == "draw"].copy()
    for col in _BASE_NUMERIC + [p + g for p in _GROUP_NUMERIC for g in GROUPS]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in _DATE_COLS:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    df["release_name"] = df["release_name"].astype(str)
    df = _join_people(df)
    df["artist"] = df["artist"].astype(str)
    _panel_cache = df.reset_index(drop=True)
    return _panel_cache


def _num(value: object) -> float:
    """A plain float, never NaN, never a numpy scalar.

    The profile is written straight into the snapshot, so json.dump has to
    accept it exactly as it comes back - a numpy float64 raises and a NaN
    produces invalid JSON that the browser then refuses to parse.
    """
    try:
        out = float(value)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if math.isnan(out) or math.isinf(out) else out


def _num_or_none(value: object) -> float | None:
    """A number, or None where there is none: for fields whose absence means
    "no history" rather than "nothing" (a conversion rate, §3.2)."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or math.isinf(v) else v


def _median(rows: pd.DataFrame, col: str, positive: bool = False) -> float:
    """Median of one column over the basket, 0.0 when nothing qualifies.

    `positive` drops zeros as well as NaN: a conversion rate of zero means the
    channel had no entries that launch, which is missing history rather than a
    rate of nothing, and including it halves the benchmark for any channel that
    only some launches run.
    """
    if col not in rows.columns or not len(rows):
        return 0.0
    vals = pd.to_numeric(rows[col], errors="coerce").dropna()
    if positive:
        vals = vals[vals > 0]
    return _num(vals.median()) if len(vals) else 0.0


def _quantile(rows: pd.DataFrame, col: str, q: float) -> float:
    if col not in rows.columns or not len(rows):
        return 0.0
    vals = pd.to_numeric(rows[col], errors="coerce").dropna()
    return _num(vals.quantile(q)) if len(vals) else 0.0


def _shares(rows: pd.DataFrame, prefix: str) -> dict[str, float]:
    """Median share per group, renormalised to sum to 1.

    Each group's median is taken over a different subset of launches, so the
    five rarely sum to 1 on their own. Renormalising is what makes
    `share[g] * total` sum back to the headline median (§3.2).
    """
    raw = {g: _median(rows, f"{prefix}{g}") for g in GROUPS}
    total = sum(raw.values())
    if total <= 0:
        return {g: 0.0 for g in GROUPS}
    return {g: _num(raw[g] / total) for g in GROUPS}


def basket_profile(panel: pd.DataFrame, members: list[str]) -> dict:
    """The medians for one basket (§3.2). Every value is JSON-ready."""
    wanted = [str(m) for m in (members or [])]
    rows = panel[panel["release_name"].isin(wanted)] if len(panel) and wanted else panel.iloc[0:0]
    used = [str(n) for n in rows["release_name"].tolist()] if len(rows) else []

    units = _median(rows, "tot_total_product_units")
    sessions = _median(rows, "tot_sessions_total")
    share_units = _shares(rows, "unit_share_")
    share_sessions = _shares(rows, "sess_share_")
    # the basket's unit prices in sterling, from Airtable via the panel; a
    # member without one is skipped, and n_priced says how many had one
    priced = pd.to_numeric(rows.get("unit_price_gbp"), errors="coerce") if "unit_price_gbp" in rows.columns else pd.Series(dtype=float)
    priced = priced[priced > 0]
    return {
        "n": len(used),
        "members": used,
        "units": units,
        "units_p25": _quantile(rows, "tot_total_product_units", 0.25),
        "units_p75": _quantile(rows, "tot_total_product_units", 0.75),
        "price": _num(priced.median()) if len(priced) else 0.0,
        "price_p25": _num(priced.quantile(0.25)) if len(priced) else 0.0,
        "price_p75": _num(priced.quantile(0.75)) if len(priced) else 0.0,
        "n_priced": int(len(priced)),
        "edition_size": _median(rows, "edition_size", positive=True),
        "sessions": sessions,
        "entries": _median(rows, "tot_draw_entries_eligible_units"),
        "campaign_days": _median(rows, "campaign_days"),
        "private_room_share": _median(rows, "private_room_share"),
        "share_units": share_units,
        "share_sessions": share_sessions,
        "conv": {g: _median(rows, f"conv_sess_entry_{g}", positive=True) for g in GROUPS},
        # what the basket's own buyers took each, and how many products its
        # launches offered - both only over the members that have the figures
        "units_per_buyer": _median(rows, "units_per_buyer", positive=True),
        "products": _median(rows[rows.get("products_known", False) == True], "products", positive=True)
        if "products_known" in rows.columns else 0.0,
        "units_by_group": {g: _num(share_units[g] * units) for g in GROUPS},
        "sessions_by_group": {g: _num(share_sessions[g] * sessions) for g in GROUPS},
    }


# ---------------------------------------------------------------- channels not in plan (§4.3)

def channels_off_of(release: dict | None) -> list[str]:
    """The display groups this release will not run - "not running paid", "the
    artist has no channels of their own" - as the release inputs give them,
    kept to the known groups, deduplicated and in GROUPS order so two spellings
    of the same choice are the same choice everywhere."""
    raw = (release or {}).get("channels_off") or []
    if isinstance(raw, str):
        raw = [raw]
    wanted = {str(g).strip() for g in raw}
    return [g for g in GROUPS if g in wanted]


def apply_channels_off(profile: dict, off: list[str]) -> dict:
    """The basket read without the channels this release will not run (§4.3).

    A launch that will not run paid is not behind by the paid units the basket
    typically buys, so those leave the benchmark: the group's median units and
    sessions go to zero, the headline medians drop to what the remaining
    groups add up to, entries fall by the same share, and the group's
    conversion is zero rather than a rate for a channel that will not exist.
    The uplift K is then the target over the remaining median - the honest
    statement of what the channels in plan have to do.

    The basket's full medians ride along as the *_all fields so the page can
    show what was set aside and the browser can re-read the same basket as
    switches are flipped without another build. With nothing off the profile
    comes back unchanged apart from those fields. shared/benchmarkModel.mjs
    mirrors this to the figure and tests/test_channels_off.py holds them to it.
    """
    off = [g for g in GROUPS if g in set(off or [])]
    units_all = dict(profile.get("units_by_group") or {g: 0.0 for g in GROUPS})
    sess_all = dict(profile.get("sessions_by_group") or {g: 0.0 for g in GROUPS})
    out = dict(profile)
    out["channels_off"] = off
    out["units_all"] = _num(profile.get("units"))
    out["sessions_all"] = _num(profile.get("sessions"))
    out["entries_all"] = _num(profile.get("entries"))
    out["units_by_group_all"] = {g: _num(units_all.get(g)) for g in GROUPS}
    out["sessions_by_group_all"] = {g: _num(sess_all.get(g)) for g in GROUPS}
    out["units_p25_all"] = _num(profile.get("units_p25"))
    out["units_p75_all"] = _num(profile.get("units_p75"))
    out["conv_all"] = {g: _num((profile.get("conv") or {}).get(g)) for g in GROUPS}
    if not off:
        return out
    keep = [g for g in GROUPS if g not in off]
    units = sum(_num(units_all.get(g)) for g in keep)
    sessions = sum(_num(sess_all.get(g)) for g in keep)
    ratio = (units / out["units_all"]) if out["units_all"] > 0 else 0.0
    out["units"] = _num(units)
    out["sessions"] = _num(sessions)
    out["entries"] = _num(out["entries_all"] * ratio)
    # the middle half scales with the median: it describes the same launches
    # read on the same channels
    out["units_p25"] = _num(_num(profile.get("units_p25")) * ratio)
    out["units_p75"] = _num(_num(profile.get("units_p75")) * ratio)
    out["units_by_group"] = {g: (_num(units_all.get(g)) if g in keep else 0.0) for g in GROUPS}
    out["sessions_by_group"] = {g: (_num(sess_all.get(g)) if g in keep else 0.0) for g in GROUPS}
    for key, total in (("share_units", units), ("share_sessions", sessions)):
        src = profile.get(key) or {}
        # shares over the groups in plan, renormalised so share x total still
        # adds back to the headline median (§3.2); zero for a group set aside
        raw = {g: (_num(src.get(g)) if g in keep else 0.0) for g in GROUPS}
        tot = sum(raw.values())
        out[key] = {g: (_num(raw[g] / tot) if tot > 0 else 0.0) for g in GROUPS}
    conv = profile.get("conv") or {}
    out["conv"] = {g: (_num(conv.get(g)) if g in keep else 0.0) for g in GROUPS}
    return out


# ---------------------------------------------------------------- ready-made baskets

def _txt(v) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    return str(v)


def _day(v) -> str:
    ts = pd.to_datetime(v, errors="coerce")
    return "" if pd.isna(ts) else pd.Timestamp(ts).strftime("%Y-%m-%d")


def candidate_rows(panel: pd.DataFrame) -> list[dict]:
    """The draw panel as the picker's candidate rows, newest close first: each
    launch's units, sessions, paid share, unit price in sterling, edition size,
    dates and cluster. Every value is JSON-ready.

    One function so the API shim and the build agree to the field: the build
    writes these rows to data/app/basket_candidates.json on every run, and the
    server serves that file rather than starting a python process for each
    open of the picker. shared/basketRule.mjs ranks over exactly these rows.
    """
    names = _cluster_names(panel)
    rows = []
    if not len(panel):
        return rows
    for r in panel.sort_values("window_end", ascending=False, na_position="last").to_dict("records"):
        cid = _cluster_id(r.get("cluster"))
        rows.append({
            "release_name": _txt(r.get("release_name")),
            "artist": _txt(r.get("artist")),
            "title": _txt(r.get("title")),
            "quarter": _txt(r.get("quarter")),
            "window_start": _day(r.get("window_start")),
            "window_end": _day(r.get("window_end")),
            "campaign_days": _num(r.get("campaign_days")),
            "units": _num(r.get("tot_total_product_units")),
            "sessions": _num(r.get("tot_sessions_total")),
            "paid_share": _num(r.get("sess_share_paid")),
            # each group's share of the launch's units and sessions: what the
            # picker needs to read the basket without a channel (§4.3)
            "unit_shares": {g: _num(r.get(f"unit_share_{g}")) for g in GROUPS},
            "sess_shares": {g: _num(r.get(f"sess_share_{g}")) for g in GROUPS},
            # a conversion the launch has no history for is null, not zero, so
            # the picker's median drops it the way _median(positive=True) does
            "convs": {g: _num_or_none(r.get(f"conv_sess_entry_{g}")) for g in GROUPS},
            "entries": _num(r.get("tot_draw_entries_eligible_units")),
            "units_per_buyer": _num(r.get("units_per_buyer")),
            "private_room_share": _num(r.get("private_room_share")),
            # the edition's unit price in sterling and its size, from Airtable
            # via the panel (etl/pricing.py); 0 where Airtable has no match
            "price": _num(r.get("unit_price_gbp")),
            "edition_size": _num(r.get("edition_size")),
            "cluster": cid,
            "cluster_name": names.get(cid, "") if cid is not None else "",
        })
    return rows


def _cluster_series(frame: pd.DataFrame) -> pd.Series:
    """The cluster column as numbers.

    It arrives as a float-like string ("0.0") whenever the CSV is read without
    the coercion load_panel() does - the API shim and ad-hoc scripts both do
    that - so it is coerced again at use rather than trusted.
    """
    if "cluster" not in frame.columns:
        return pd.Series([float("nan")] * len(frame), index=frame.index)
    return pd.to_numeric(frame["cluster"], errors="coerce")


def _cluster_id(value: object) -> int | None:
    """0, "0", "0.0" and 0.0 are all cluster 0. Anything else is no cluster."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(out) or math.isinf(out) or out < 0:
        return None
    return int(round(out))


def _cluster_names(panel: pd.DataFrame) -> dict[int, str]:
    """Display names per cluster, from the panel, then the baskets file, then
    the spec's table - so a rebuild that renames a cluster carries through."""
    global _names_cache
    if _names_cache is not None:
        return _names_cache
    names = dict(DEFAULT_CLUSTER_NAMES)
    try:
        doc = json.loads(BASKETS_PATH.read_text())
        for row in doc.get("clusters", []):
            cid, name = _cluster_id(row.get("id")), str(row.get("name") or "").strip()
            if cid is not None and name:
                names[cid] = name
    except (OSError, ValueError, AttributeError):
        pass
    if "cluster_name" in panel.columns:
        cid = _cluster_series(panel)
        for c in sorted({v for v in cid.dropna().tolist()}):
            got = panel.loc[cid == c, "cluster_name"].dropna()
            if len(got):
                names[int(c)] = str(got.iloc[0]).strip()
    _names_cache = {c: n.replace(CLUSTER_NAME_TRIM, "") for c, n in names.items()}
    return _names_cache


def _own_name(release: dict | None) -> str:
    return str((release or {}).get("release_name") or "").strip()


def _panel_row(panel: pd.DataFrame, release: dict | None) -> pd.Series | None:
    name = _own_name(release)
    if not name or not len(panel):
        return None
    hit = panel[panel["release_name"] == name]
    return hit.iloc[0] if len(hit) else None


def _artist_of(panel: pd.DataFrame, release: dict | None) -> str:
    """The release's artist. Panel first, then the release name's own first
    part - launches are named "Artist · Title · 2026 Q3" throughout."""
    row = _panel_row(panel, release)
    if row is not None and str(row.get("artist") or "").strip():
        return str(row["artist"]).strip()
    named = str((release or {}).get("artist") or "").strip()
    if named:
        return named
    name = _own_name(release)
    return name.split(" · ")[0].strip() if name else ""


def _release_start(panel: pd.DataFrame, release: dict | None, as_of: date) -> pd.Timestamp:
    """When this launch's own window opens - the cut-off for "earlier" launches
    by the same artist. A release being planned is not in the panel yet, so its
    announce date (or the private room opening, which comes first) stands in."""
    row = _panel_row(panel, release)
    if row is not None and pd.notna(row.get("window_start")):
        return pd.Timestamp(row["window_start"])
    for key in ("private_room_open", "announce_date", "launch_end"):
        got = pd.to_datetime((release or {}).get(key), errors="coerce")
        if pd.notna(got):
            return pd.Timestamp(got)
    return pd.Timestamp(as_of)


def _release_price(panel: pd.DataFrame, release: dict | None) -> float:
    """This release's unit price in sterling, or 0.0 when it has none.

    A release in the panel carries Airtable's value-weighted price already
    converted. One being planned has the price typed into the target form,
    in the currency the form says (sterling unless the record carries a
    currency), converted at the same fixed table as the panel so the band is
    drawn in one currency."""
    row = _panel_row(panel, release)
    if row is not None and _num(row.get("unit_price_gbp")) > 0:
        return _num(row["unit_price_gbp"])
    price = _num((release or {}).get("unit_price"))
    if price <= 0:
        return 0.0
    return price * RATES_TO_GBP.get(str((release or {}).get("currency") or "GBP").upper(), 1.0)


def _ready(bid: str, name: str, desc: str, members: list[str], panel: pd.DataFrame) -> dict:
    return {
        "id": bid,
        "kind": "ready",
        "name": name,
        "desc": desc,
        "members": members,
        "n": len(members),
        "disabled": len(members) < MIN_MEMBERS,
        "profile": basket_profile(panel, members),
    }


def _distances(pool: pd.DataFrame, release: dict | None, panel: pd.DataFrame) -> tuple[np.ndarray, tuple[str, ...]]:
    """How far every launch in the pool is from this one: the larger of its
    units multiple and its price multiple, each taken above 1 whichever side
    it falls, so a launch is only as near as its worse axis. A launch Airtable
    could not price is ranked on units alone rather than dropped over a
    missing field. Returns the distances and the axes that set them."""
    size = _num((release or {}).get("edition_size"))
    units = pool["tot_total_product_units"].map(_num).astype(float).to_numpy()
    price = _release_price(panel, release)
    prices = (pd.to_numeric(pool["unit_price_gbp"], errors="coerce").to_numpy()
              if "unit_price_gbp" in pool.columns else np.full(len(pool), np.nan))
    use_price = bool(SIMILAR_USE_PRICE and price > 0 and np.isfinite(prices).any())

    def mult(vals, ref):
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.maximum(vals / ref, ref / vals)
        return np.where((vals > 0) & np.isfinite(r), r, np.inf)

    d = mult(units, size)
    if use_price:
        dp = mult(prices, price)
        d = np.maximum(d, np.where(np.isfinite(dp), dp, 1.0))
    return d, (("size", "price") if use_price else ("size",))


def own_members(panel: pd.DataFrame, release: dict | None, as_of: date | None = None) -> list[str]:
    """The artist's own earlier launches that belong in the basket: same
    artist, closed before this launch opened, and within OWN_MAX on both
    axes. Nearest first. Empty for an artist with no history on file."""
    own_name = _own_name(release)
    pool = panel[panel["release_name"] != own_name] if own_name else panel
    if not len(pool) or "artist" not in pool.columns or _num((release or {}).get("edition_size")) <= 0:
        return []
    artist = _artist_of(panel, release)
    if not artist:
        return []
    start = _release_start(panel, release, as_of or date.today())
    ends = pd.to_datetime(pool["window_end"], errors="coerce")
    same = pool["artist"].astype(str).str.strip().str.casefold() == artist.casefold()
    earlier = same.to_numpy() & (ends < start).to_numpy()
    d, _on = _distances(pool, release, panel)
    names = pool["release_name"].astype(str).to_numpy()
    idx = np.where(earlier & (d <= OWN_MAX))[0]
    # nearest first, then by name: a total order, so two launches at the same
    # distance come out the same way whichever order the panel is read in -
    # the JS mirror sorts identically, and the parity test holds them to it
    idx = idx[np.lexsort((names[idx], d[idx]))]
    return names[idx].tolist()


def similar_members(panel: pd.DataFrame, release: dict | None, as_of: date | None = None) -> tuple[list[str], float | None, tuple[str, ...]]:
    """The SIMILAR_N launches nearest this one on units and unit price.

    The artist's own earlier launches go in first (own_members), then the
    nearest of everything else fills the basket. With prefer_recent on - the
    default - launches closed in the last RECENT_MONTHS rank ahead of older
    ones among those within NEAR on both axes; recency never reaches past NEAR.

    Distance is the figure the picker shows in its two columns, so the basket
    is simply the top of the list the picker is already ordered by. A release
    with no price is ranked on units alone; one with no edition size has no
    basket, there being nothing to be near to. A panel shorter than SIMILAR_N
    gives what it has.

    Returns the members, the reach - how far the furthest member is - and the
    axes that ranked them, ("size",) or ("size", "price").
    """
    own_name = _own_name(release)
    pool = panel[panel["release_name"] != own_name] if own_name else panel
    size = _num((release or {}).get("edition_size"))
    if size <= 0 or not len(pool):
        return [], None, ()
    as_of = as_of or date.today()
    d, on = _distances(pool, release, panel)
    names = pool["release_name"].to_numpy()

    first = own_members(panel, release, as_of)
    taken = set(first)
    rest = np.array([i for i in range(len(pool)) if names[i] not in taken and np.isfinite(d[i])], dtype=int)

    prefer_recent = (release or {}).get("prefer_recent")
    prefer_recent = True if prefer_recent is None else bool(prefer_recent)
    if prefer_recent and len(rest):
        ends = pd.to_datetime(pool["window_end"], errors="coerce").to_numpy()
        cutoff = np.datetime64(pd.Timestamp(as_of) - pd.DateOffset(months=RECENT_MONTHS))
        recent = ends >= cutoff
        # three tiers, distance within each: comparable and recent, comparable
        # and older, then everything beyond NEAR
        tier = np.where(d[rest] <= NEAR, np.where(recent[rest], 0, 1), 2)
        rest = rest[np.lexsort((names[rest].astype(str), d[rest], tier))]
    else:
        rest = rest[np.lexsort((names[rest].astype(str), d[rest]))]

    members = first + names[rest].tolist()
    members = members[:SIMILAR_N]
    if not members:
        return [], None, ()
    by_name = {names[i]: d[i] for i in range(len(pool))}
    reach = float(max(by_name[m] for m in members))
    return members, reach, on

def similar_desc(members: list[str], reach: float | None, on: tuple[str, ...], size: float, price: float,
                 own: int = 0, artist: str = "") -> str:
    """The sentence under the basket in the picker.

    The count is fixed, so what the sentence has to carry is how close the
    eight turned out to be. Within about twice this edition is a basket of
    comparables; four times it and the benchmark is "the nearest things we
    have run", which is a different claim and should read like one.
    """
    if not members:
        return "No launch on file to compare this edition against."
    axes = f"units of this edition's {size:,.0f}"
    if "price" in on:
        axes += f" and on its unit price of £{price:,.0f}"
    near = f"The {len(members)} launches nearest on {axes}"
    if own and artist:
        near += f", starting with {artist}'s own {own}"
    if reach is None:
        return near + "."
    if reach > SCALE_MISMATCH_FACTOR:
        return (f"{near}. Nothing on file is close to it: the furthest of the eight is "
                f"x{reach:,.1f} away, so the benchmark is what the nearest launches on record "
                f"reached and the uplift says how far past them this edition is being asked to go.")
    return f"{near} - all within x{reach:,.1f} of it."


def ready_baskets(panel: pd.DataFrame, as_of: date, release: dict | None = None) -> list[dict]:
    """The ready-made baskets for this release (§3.1), in picker order.

    `release` is optional so the picker can be listed without one; when it is
    given, its own launch is dropped from every basket and same_artist and
    similar_size become answerable at all.
    """
    own = _own_name(release)
    pool = panel[panel["release_name"] != own] if own else panel
    names = _cluster_names(panel)
    cid = _cluster_series(pool)
    out = []

    members, reach, on = similar_members(panel, release, as_of)
    size = _num((release or {}).get("edition_size"))
    own = [m for m in own_members(panel, release, as_of) if m in members]
    desc = similar_desc(members, reach, on, size, _release_price(panel, release),
                        len(own), _artist_of(panel, release).split(" ")[-1] if own else "")
    similar = _ready("similar_size", SIMILAR_NAME, desc, members, panel)
    similar["matchedOn"] = list(on)
    # how far the furthest member is, not a band the search stopped at
    similar["reach"] = reach
    # the members that are the artist's own, so the picker can mark them
    similar["own"] = own
    out.append(similar)

    for c in range(4):
        rows = pool[cid == c]
        out.append(_ready(f"cluster_{c}", names.get(c, DEFAULT_CLUSTER_NAMES.get(c, f"Cluster {c}")),
                          DESCS[f"cluster_{c}"], rows["release_name"].tolist(), panel))

    cutoff = pd.Timestamp(as_of) - pd.Timedelta(days=READY_WINDOW_DAYS)
    ends = pd.to_datetime(pool["window_end"], errors="coerce") if "window_end" in pool.columns else None
    recent = pool[(ends >= cutoff) & (ends <= pd.Timestamp(as_of))] if ends is not None else pool.iloc[0:0]
    out.append(_ready("all_12m", ALL_12M_NAME, DESCS["all_12m"], recent["release_name"].tolist(), panel))

    artist = _artist_of(panel, release)
    start = _release_start(panel, release, as_of)
    if artist and ends is not None and "artist" in pool.columns:
        same = pool[(pool["artist"].astype(str).str.strip().str.casefold() == artist.casefold())
                    & (ends < start)]
        members = same["release_name"].tolist()
    else:
        members = []
    out.append(_ready("same_artist", SAME_ARTIST_NAME,
                      f"{artist or 'This artist'}'s previous draws on file.", members, panel))
    return out


# ---------------------------------------------------------------- suggestion (§3.3)

def _paid_plan(release: dict | None) -> float:
    r = release or {}
    if r.get("paid_share_override") is not None:
        return _num(r["paid_share_override"])
    return PAID_PLAN.get(str(r.get("paid_channel_size") or "").strip(), PAID_PLAN_DEFAULT)


def suggest_basket(panel: pd.DataFrame, release: dict) -> str:
    """The ready-made basket id that matches this release (§3.3).

    Comparable size comes first: every headline number on the page is a volume,
    so a basket that matches the shape but not the scale would call an order of
    magnitude of edition size a stretch. Only when no size band can be filled
    do we fall back to the shape cluster alone - a launch that has already run
    knows its own, and a launch being planned is placed by distance in log
    space, because the panel runs from 15 units to 987 and a linear gap would
    put everything small in the same basket.
    """
    own = _own_name(release)
    pool = panel[panel["release_name"] != own] if own else panel
    members, _reach, _on = similar_members(panel, release)  # as_of: today, as the picker's
    if len(members) >= MIN_MEMBERS:
        return "similar_size"
    row = _panel_row(panel, release)
    if row is not None:
        for key in ("cluster", "nearest_cluster"):
            cid = _cluster_id(row.get(key))
            if cid is not None:
                return f"cluster_{cid}"
    cid = _cluster_id((release or {}).get("nearest_cluster"))
    if cid is not None:
        return f"cluster_{cid}"

    size = _num((release or {}).get("edition_size"))
    plan = _paid_plan(release)
    clusters = _cluster_series(pool)
    best, best_key = "cluster_0", None
    for c in range(4):
        rows = pool[clusters == c]
        units = _median(rows, "tot_total_product_units")
        if not len(rows) or units <= 0:
            continue
        gap = abs(math.log(max(size, 1.0)) - math.log(units))
        # rounded so only a genuine tie falls through to the paid plan
        key = (round(gap, 6), abs(_median(rows, "sess_share_paid") - plan))
        if best_key is None or key < best_key:
            best, best_key = f"cluster_{c}", key
    return best


# ---------------------------------------------------------------- saved and resolved

def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).strip().casefold()).strip("_")


def saved_baskets(path: pathlib.Path | str | None = None) -> list[dict]:
    """Custom baskets saved from the picker (spec §6). Missing file is normal -
    nobody has saved one yet - and a malformed one must not stop a build."""
    p = pathlib.Path(path) if path else SAVED_PATH
    if not p.exists():
        return []
    try:
        doc = json.loads(p.read_text())
    except (OSError, ValueError):
        return []
    rows = doc.get("baskets", []) if isinstance(doc, dict) else doc
    out = []
    for i, row in enumerate(rows or []):
        if not isinstance(row, dict):
            continue
        members = [str(m).strip() for m in (row.get("members") or []) if str(m).strip()]
        name = str(row.get("name") or "Saved basket").strip()
        out.append({
            "id": str(row.get("id") or _slug(name) or f"saved_{i}"),
            "kind": "saved",
            "name": name,
            "desc": str(row.get("desc") or "Saved basket."),
            "members": members,
            "n": len(members),
            "created": row.get("created"),
        })
    return out


def _known_members(panel: pd.DataFrame, members: object, own: str) -> list[str]:
    """Only launches that are actually in the panel, never this one, no
    duplicates, in the order they were given."""
    if not isinstance(members, (list, tuple)):
        return []
    pool = set(panel["release_name"].tolist()) if len(panel) else set()
    out, seen = [], set()
    for m in members:
        name = str(m).strip()
        if name and name != own and name in pool and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _resolved(basket: dict, suggested: str, panel: pd.DataFrame, bid: str | None = None,
              release: dict | None = None) -> dict:
    profile = basket.get("profile") or basket_profile(panel, basket.get("members") or [])
    # A basket an order of magnitude away from the edition is not a comparable,
    # and an uplift computed off one is a statement about scale rather than a
    # plan. Flagged here rather than silently used, so the build can decide.
    size = _num((release or {}).get("edition_size"))
    units = profile.get("units") or 0.0
    mismatch = bool(size > 0 and units > 0
                    and max(size / units, units / size) > SCALE_MISMATCH_FACTOR)
    return {
        "id": bid or basket["id"],
        "kind": basket.get("kind", "ready"),
        "name": basket.get("name", ""),
        "n": profile["n"],
        "thin": profile["n"] < THIN_MEMBERS,
        "scaleMismatch": mismatch,
        "members": profile["members"],
        "profile": profile,
        "suggestedId": suggested,
    }


def resolve_basket(spec: dict | None, panel: pd.DataFrame, release: dict, as_of: date) -> dict:
    """The basket a release is benchmarked against, from its saved
    `benchmark_basket` spec (§6) or, failing that, the suggestion.

    Anything that cannot be honoured falls back to the suggested basket rather
    than failing the build: the spec is validated at the API where a bad one is
    a 400, so by the time it reaches here an unresolvable id means the panel
    was rebuilt underneath it - a rebuilt panel must not take the dashboard
    down. The returned id is the suggested one whenever that happens, so the
    card shows what was actually used.
    """
    ready = {b["id"]: b for b in ready_baskets(panel, as_of, release)}
    suggested = suggest_basket(panel, release)
    if suggested not in ready:
        suggested = "cluster_0" if "cluster_0" in ready else next(iter(ready))
    fallback = ready[suggested]

    if not isinstance(spec, dict):
        return _resolved(fallback, suggested, panel, release=release)

    own = _own_name(release)
    kind = str(spec.get("kind") or "ready").strip()
    spec_id = str(spec.get("id") or "").strip()
    chosen: dict | None = None
    if kind == "bespoke":
        members = _known_members(panel, spec.get("members"), own)
        chosen = {"id": spec_id or "bespoke", "kind": "bespoke",
                  "name": str(spec.get("name") or "Bespoke basket"), "members": members}
    elif kind == "saved":
        hit = next((b for b in saved_baskets() if b["id"] == spec_id), None)
        if hit is not None:
            chosen = {**hit, "members": _known_members(panel, hit["members"], own)}
    else:
        hit = ready.get(spec_id)
        if hit is not None:
            chosen = hit

    if chosen is None or len(chosen.get("members") or []) < MIN_MEMBERS:
        return _resolved(fallback, suggested, panel, release=release)
    return _resolved(chosen, suggested, panel, release=release)
