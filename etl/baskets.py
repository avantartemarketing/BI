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

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PANEL_PATH = DATA / "release_clusters.csv"
BASKETS_PATH = DATA / "release_cluster_baskets.json"
SAVED_PATH = DATA / "app" / "baskets.json"

# The five display groups (docs/DATA_MODEL.md §1.3). Order matters: it is the
# order the profile dicts and the per-channel table are written in.
GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"]

READY_WINDOW_DAYS = 365   # "last 12 months" for the all_12m basket
MIN_MEMBERS = 3           # below this a basket cannot be used at all (§3.2)
THIN_MEMBERS = 10         # below this it is usable but flagged as thin

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
SIMILAR_FACTORS = (2.0, 2.5, 3.0, 4.0)
SIMILAR_MIN = 8           # a band narrower than this is too few to median over
SCALE_MISMATCH_FACTOR = 4.0   # beyond this the basket is not a comparable at all

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
]
_GROUP_NUMERIC = ["unit_share_", "sess_share_", "ent_share_", "conv_sess_entry_",
                  "conv_sess_unit_", "sessions_", "entries_", "units_"]
_DATE_COLS = ["window_start", "window_end", "announce", "close", "first_seen", "last_seen"]

_panel_cache: pd.DataFrame | None = None
_names_cache: dict[int, str] | None = None


# ---------------------------------------------------------------- the panel

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
    return {
        "n": len(used),
        "members": used,
        "units": units,
        "units_p25": _quantile(rows, "tot_total_product_units", 0.25),
        "units_p75": _quantile(rows, "tot_total_product_units", 0.75),
        "sessions": sessions,
        "entries": _median(rows, "tot_draw_entries_eligible_units"),
        "campaign_days": _median(rows, "campaign_days"),
        "private_room_share": _median(rows, "private_room_share"),
        "share_units": share_units,
        "share_sessions": share_sessions,
        "conv": {g: _median(rows, f"conv_sess_entry_{g}", positive=True) for g in GROUPS},
        "units_by_group": {g: _num(share_units[g] * units) for g in GROUPS},
        "sessions_by_group": {g: _num(share_sessions[g] * sessions) for g in GROUPS},
    }


# ---------------------------------------------------------------- ready-made baskets

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


def similar_members(panel: pd.DataFrame, release: dict | None) -> tuple[list[str], float | None]:
    """Launches of comparable size, preferring comparable shape too.

    Every release gets a basket. The search runs from strictest to loosest and
    stops at the first rung that answers:

      1. the shape cluster intersected with a size band, widening the band;
      2. the size band alone, widening;
      3. the size band alone at a count that is thin but medianable;
      4. failing all of that, simply the launches nearest this edition in size.

    Rung 4 is what an unprecedented edition gets. A 2,440-unit launch when the
    biggest draw ever run was 987 has no true comparable, and the honest
    benchmark is the largest launches on file with a multiplier of about three
    printed next to them: "three times the biggest thing we have ever done" is
    a plan someone can argue with. An empty panel is the only case with no
    basket, and then there is nothing to median over at all.

    The second return value is the band factor that found the members, or None
    when rung 4 answered - the caller uses it to describe the basket, and
    "nearest by size" is a different sentence from "within a factor of 3".
    """
    own = _own_name(release)
    pool = panel[panel["release_name"] != own] if own else panel
    size = _num((release or {}).get("edition_size"))
    if size <= 0 or not len(pool):
        return [], None
    units = pool["tot_total_product_units"].map(_num)
    row = _panel_row(panel, release)
    cid = _cluster_id(row.get("cluster")) if row is not None else None
    if cid is None:
        cid = _cluster_id((release or {}).get("nearest_cluster"))
    clusters = _cluster_series(pool)
    # the shape constraint is dropped before the scale one: every headline
    # figure on the page is a volume, so scale is the harder constraint and the
    # last to give up
    for shape_first in (True, False):
        if shape_first and cid is None:
            continue
        for f in SIMILAR_FACTORS:
            band = (units >= size / f) & (units <= size * f)
            sel = pool[band & (clusters == cid)] if shape_first else pool[band]
            if len(sel) >= SIMILAR_MIN:
                return sel["release_name"].tolist(), f
    # Rung 3: no band reaches eight, so take the widest one if it is medianable
    # at all. The widest, not the first that clears the minimum - once the band
    # cannot be tight enough to be a real comparable there is nothing to be won
    # by keeping it narrow, and a median over three launches moves under any
    # one of them.
    f = SIMILAR_FACTORS[-1]
    widest = pool[(units >= size / f) & (units <= size * f)]
    if len(widest) >= MIN_MEMBERS:
        return widest["release_name"].tolist(), f
    # nearest by size, in log space so a half and a double are the same distance
    near = pool.assign(_d=(np.log(units.clip(lower=1)) - math.log(max(size, 1))).abs())
    near = near.nsmallest(min(THIN_MEMBERS, len(near)), "_d")
    return near["release_name"].tolist(), None


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

    members, factor = similar_members(panel, release)
    size = _num((release or {}).get("edition_size"))
    if factor is not None:
        desc = (f"Launches within a factor of {factor:g} on units of this edition's "
                f"{size:,.0f}, of the same shape where there are enough of them.")
    elif members:
        desc = (f"No launch on file is close to this edition's {size:,.0f} units, so this is "
                f"simply the {len(members)} nearest to it by size - the benchmark is what the "
                f"biggest launches on record reached, and the uplift says how far past them "
                f"this edition is being asked to go.")
    else:
        desc = "No launch on file to compare this edition against."
    out.append(_ready("similar_size", SIMILAR_NAME, desc, members, panel))

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
    members, _factor = similar_members(panel, release)
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
