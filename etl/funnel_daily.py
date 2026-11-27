"""Every launch day by day, for the Agent and the connector.

The panels (data/release_clusters.csv, data/app/tl_panel.csv) hold a past
launch as whole-campaign totals, so a question such as "how many visits did
York have by day 2" had no answer: the Agent could give a past launch's
entries and units by day and not its visits (27 November 2026). These two
tables are the launches' own days, with the day of the campaign on every row,
so a live launch can be set against an earlier one at the same point:

  data/app/funnel_daily.csv      a draw launch (LE): release x day x channel
  data/app/tl_funnel_daily.csv   a timed launch (TL): release x day x channel

Counts only, from the feeds the pages are built from (the funnel export as
rebuilt by etl/aggregate_events.py, the page funnel's sessions, the units paid
in the orders, the TL aggregation), over each launch's own window and nothing
outside it, so a table stays a few megabytes: the server parses it in a small
heap (server/agent/tools.js).

Channels are the six groups the cards show, with Direct and Untracked apart,
as the feed attributes them. Beside each count is its `_spread` reading:
Untracked shared over the other channels and then Direct over the rest, day by
day, in proportion to what each did that day, which is how a page shows its
channels by default (etl/build.py redistribute_channel; the same rule, for
every launch at once). A timed launch's page spreads Direct and keeps what is
Untracked apart, and its table does the same. The two readings add up to the
same totals.

build.py writes both in the full build, behind a guard: a failure here costs
the tables and never a page. Nothing here reads an identifier.
"""
from __future__ import annotations

import pathlib

import numpy as np
import pandas as pd

LE_FILE = "funnel_daily.csv"
TL_FILE = "tl_funnel_daily.csv"
DIRECT, UNTRACKED, OTHER = "Direct", "Untracked", "Other"

LE_COLUMNS = ["release", "date", "day", "of", "channel",
              "visits", "entrants", "eligible", "entries", "units",
              "visits_spread", "entries_spread", "units_spread",
              "release_page_visits", "went_to_product", "product_page_visits", "entered_from_product"]
TL_COLUMNS = ["release", "date", "day", "of", "to_open", "channel",
              "visits", "signups", "orders", "units",
              "visits_spread", "signups_spread", "units_spread"]


def channel_names(display_groups: dict) -> dict[str, str]:
    """A raw channel -> the name its row carries: its group's name as the cards
    print it (build.py DISPLAY_GROUPS), with Direct and Untracked kept apart."""
    names = {c: spec["name"] for spec in display_groups.values() for c in spec["channels"]}
    names[DIRECT] = DIRECT
    names[UNTRACKED] = UNTRACKED
    return names


def _named(raw: pd.Series, names: dict[str, str]) -> pd.Series:
    """The table's channel for each raw one; a channel no group claims is Other."""
    s = raw.fillna("").astype(str).str.strip()
    s = s.where(s.str.lower() != "untracked", UNTRACKED).replace("", UNTRACKED)
    return s.map(names).fillna(OTHER)


def spread(df: pd.DataFrame, channel: str, cols: list[str], apart: tuple[str, ...] = ()) -> pd.DataFrame:
    """`cols` with one channel's volume shared over the other channels of the
    same release and day, in proportion to what each did that day. A day that
    carries the channel's volume with nothing else to share it over is pooled
    and shared on the release's own mix; a release with nothing but that
    channel keeps the volume where it is, so nothing is lost. The channel's own
    rows read zero. A channel named in `apart` takes no share and keeps its
    own. build.py's redistribute_channel, for every release at once."""
    out = df.copy()
    if out.empty:
        return out
    aside = out["channel"].isin(list(apart)).to_numpy()
    day_key = out.groupby(["release", "date"], sort=False).ngroup().to_numpy()
    rel_key = out.groupby("release", sort=False).ngroup().to_numpy()
    n_day, n_rel = int(day_key.max()) + 1, int(rel_key.max()) + 1
    day_rel = np.zeros(n_day, dtype=int)
    day_rel[day_key] = rel_key
    own = (out["channel"] == channel).to_numpy()
    for c in cols:
        vals = out[c].to_numpy(dtype=float)
        part = np.where(own, vals, 0.0)
        rest = np.where(own | aside, 0.0, vals)
        part_day = np.bincount(day_key, weights=part, minlength=n_day)
        rest_day = np.bincount(day_key, weights=rest, minlength=n_day)
        rest_rel = np.bincount(rel_key, weights=rest, minlength=n_rel)
        with np.errstate(divide="ignore", invalid="ignore"):
            add = np.where(rest_day[day_key] > 0, part_day[day_key] * rest / rest_day[day_key], 0.0)
            orphan_rel = np.bincount(day_rel, weights=np.where(rest_day > 0, 0.0, part_day), minlength=n_rel)
            add = add + np.where(rest_rel[rel_key] > 0, orphan_rel[rel_key] * rest / rest_rel[rel_key], 0.0)
        alone = own & (rest_rel[rel_key] <= 0)
        out[c] = np.where(alone | aside, vals, rest + add)
    return out


def _with_spread(g: pd.DataFrame, cols: list[str], untracked: bool = True) -> pd.DataFrame:
    """The `_spread` reading beside each of `cols`: Untracked over every other
    channel, then Direct over the rest (the order a draw launch's page folds
    them in). A timed launch's page keeps what is Untracked apart and spreads
    Direct alone (`untracked` False), and so does its table."""
    s = spread(spread(g, UNTRACKED, cols), DIRECT, cols) if untracked else spread(g, DIRECT, cols, apart=(UNTRACKED,))
    for c in cols:
        g[f"{c}_spread"] = s[c].to_numpy()
    return g


def _tidy(g: pd.DataFrame, whole: list[str], parts: list[str], columns: list[str]) -> pd.DataFrame:
    """Rows with nothing on them dropped, the counts as whole numbers where
    they are whole, the shared readings to two places, in a fixed order."""
    for c in columns:
        if c not in g.columns:
            g[c] = 0.0
    keep = (g[whole + parts].abs().sum(axis=1) > 1e-9)
    g = g[keep].copy()
    for c in whole:
        v = g[c].astype(float).round(2)
        g[c] = v.map(lambda x: int(x) if float(x).is_integer() else x)
    for c in parts:
        v = g[c].astype(float).round(2)
        g[c] = v.map(lambda x: int(x) if float(x).is_integer() else x)
    g["day"] = g["day"].astype(int)
    g["of"] = g["of"].astype(int)
    return g.sort_values(["release", "date", "channel"], kind="stable")[columns].reset_index(drop=True)


def le_table(at: pd.DataFrame, windows: list[dict], names: dict[str, str],
             units: dict[str, pd.DataFrame] | None = None, pages: dict | None = None) -> pd.DataFrame:
    """The draw launches' days.

    `at` is the funnel frame as build.py reads it (channel x event_date x
    simple_release_name, dates as dates). `windows` is one dict per launch with
    a campaign clock: release, announce, close, start, end (dates; the days the
    page counts, from the private room or the announce to two days after the
    sales close) and orders (the launch's units come from the orders feed).
    `units` is that feed per release (event_date, channel, units); `pages` the
    page funnel's feed as build.py parses it ({"by": {release: frame}}).

    A day after the close is folded into the close day, as the page folds the
    winners' payments, so a launch's total by its last day is the page's. `day`
    counts from the announce (0 on the day itself, negative in early access)
    and `of` is the announce to the close in days."""
    if at is None or not len(at) or not windows:
        return pd.DataFrame(columns=LE_COLUMNS)
    w = pd.DataFrame(windows)[["release", "announce", "close", "start", "end", "orders"]].drop_duplicates("release")
    # the people behind the entries, where the feed carries them: everyone who entered, and those whose entry stands
    people = [c for c in ("Draw_Entries", "Collectors_Eligible_Entries") if c in at.columns]
    cols = ["simple_release_name", "event_date", "channel", "Sessions_Total", "Draw_Entries_Eligible_Units", "Total_Product_Units"]
    f = at[cols + people].merge(w, left_on="simple_release_name", right_on="release", how="inner")
    f = f[(f["event_date"] >= f["start"]) & (f["event_date"] <= f["end"])]
    base = pd.DataFrame({
        "release": f["release"].to_numpy(), "date": f["event_date"].to_numpy(), "raw": f["channel"].to_numpy(),
        "visits": f["Sessions_Total"].fillna(0.0).to_numpy(dtype=float),
        "entrants": f["Draw_Entries"].fillna(0.0).to_numpy(dtype=float) if "Draw_Entries" in people else 0.0,
        "eligible": f["Collectors_Eligible_Entries"].fillna(0.0).to_numpy(dtype=float) if "Collectors_Eligible_Entries" in people else 0.0,
        "entries": f["Draw_Entries_Eligible_Units"].fillna(0.0).to_numpy(dtype=float),
        # the funnel's own purchases stand only where the orders do not cover the launch
        "units": np.where(f["orders"].to_numpy(dtype=bool), 0.0, f["Total_Product_Units"].fillna(0.0).to_numpy(dtype=float)),
    })
    frames = [base]
    by_name = w.set_index("release")
    for name, rows in (units or {}).items():
        if name not in by_name.index or not bool(by_name.at[name, "orders"]) or rows is None or not len(rows):
            continue
        start, end = by_name.at[name, "start"], by_name.at[name, "end"]
        r = rows[(rows["event_date"] >= start) & (rows["event_date"] <= end)]
        if len(r):
            frames.append(pd.DataFrame({"release": name, "date": r["event_date"].to_numpy(), "raw": r["channel"].to_numpy(),
                                        "visits": 0.0, "entrants": 0.0, "eligible": 0.0, "entries": 0.0, "units": r["units"].to_numpy(dtype=float)}))
    page_cols = ["release_page_visits", "went_to_product", "product_page_visits", "entered_from_product"]
    feed_cols = ["release_sessions", "release_product_sessions", "product_sessions", "product_entry_sessions"]
    for name, rows in ((pages or {}).get("by") or {}).items():
        if name not in by_name.index or rows is None or not len(rows):
            continue
        start, end = by_name.at[name, "start"], by_name.at[name, "end"]
        r = rows[(rows["event_date"] >= start) & (rows["event_date"] <= end)]
        if len(r):
            add = pd.DataFrame({"release": name, "date": r["event_date"].to_numpy(), "raw": r["channel"].to_numpy(),
                                "visits": 0.0, "entrants": 0.0, "eligible": 0.0, "entries": 0.0, "units": 0.0})
            for dst, src in zip(page_cols, feed_cols):
                add[dst] = r[src].to_numpy(dtype=float)
            frames.append(add)
    df = pd.concat(frames, ignore_index=True)
    for c in page_cols:
        if c not in df.columns:
            df[c] = 0.0
        df[c] = df[c].fillna(0.0)
    df = df.merge(w[["release", "announce", "close"]], on="release", how="left")
    df["date"] = df["date"].where(df["date"] <= df["close"], df["close"])
    df["channel"] = _named(df["raw"], names)
    counts = ["visits", "entrants", "eligible", "entries", "units"]
    g = (df.groupby(["release", "date", "channel"], as_index=False, sort=False)
           .agg({**{c: "sum" for c in counts + page_cols}, "announce": "first", "close": "first"}))
    g = _with_spread(g, ["visits", "entries", "units"])
    day = (pd.to_datetime(g["date"]) - pd.to_datetime(g["announce"])).dt.days
    g["day"] = day
    g["of"] = (pd.to_datetime(g["close"]) - pd.to_datetime(g["announce"])).dt.days
    g["date"] = pd.to_datetime(g["date"]).dt.strftime("%Y-%m-%d")
    return _tidy(g, counts + page_cols, ["visits_spread", "entries_spread", "units_spread"], LE_COLUMNS)


def tl_table(daily: pd.DataFrame, windows: list[dict], names: dict[str, str]) -> pd.DataFrame:
    """The timed launches' days.

    `daily` is the TL aggregation (data/app/tl_daily.csv: release, date,
    channel, sessions, signups, orders, units). `windows` is one dict per timed
    launch: release, announce, open (the day sales open) and start, end (the
    days kept: from two weeks before the announce to the end of settling).
    `day` counts from the announce, `to_open` from the day sales open (negative
    before it, the days still to go) and `of` is the announce to that day."""
    if daily is None or not len(daily) or not windows:
        return pd.DataFrame(columns=TL_COLUMNS)
    w = pd.DataFrame(windows)[["release", "announce", "open", "start", "end"]].drop_duplicates("release")
    f = daily.merge(w, on="release", how="inner")
    f = f[(f["date"] >= f["start"]) & (f["date"] <= f["end"])].copy()
    if not len(f):
        return pd.DataFrame(columns=TL_COLUMNS)
    f["channel"] = _named(f["channel"], names)
    counts = ["visits", "signups", "orders", "units"]
    f = f.rename(columns={"sessions": "visits"})
    for c in counts:
        f[c] = pd.to_numeric(f[c], errors="coerce").fillna(0.0)
    g = (f.groupby(["release", "date", "channel"], as_index=False, sort=False)
          .agg({**{c: "sum" for c in counts}, "announce": "first", "open": "first"}))
    g = _with_spread(g, ["visits", "signups", "units"], untracked=False)
    g["day"] = (pd.to_datetime(g["date"]) - pd.to_datetime(g["announce"])).dt.days
    g["to_open"] = (pd.to_datetime(g["date"]) - pd.to_datetime(g["open"])).dt.days.astype(int)
    g["of"] = (pd.to_datetime(g["open"]) - pd.to_datetime(g["announce"])).dt.days
    g["date"] = pd.to_datetime(g["date"]).dt.strftime("%Y-%m-%d")
    return _tidy(g, counts, ["visits_spread", "signups_spread", "units_spread"], TL_COLUMNS)


def write(df: pd.DataFrame, path: pathlib.Path) -> None:
    """The table as a CSV, swapped in whole so a reader never sees half of it."""
    tmp = path.with_suffix(".tmp")
    df.to_csv(tmp, index=False)
    tmp.replace(path)
