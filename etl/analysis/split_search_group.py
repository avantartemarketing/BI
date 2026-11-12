#!/usr/bin/env python3
"""One-off, 12 November 2026: the panel's Search / direct / other group read
as two - Organic Search, and Other (Direct and the organic channels without a
group of their own).

The panel on file (data/release_clusters.csv) carries each launch's sessions,
eligible entries and units for the old group as it was read when the panel was
built. This splits those figures, launch by launch and metric by metric, by
Organic Search's share of the old group's channels over the launch's own
window on the funnel export on file. Nothing else on the panel moves: the
windows, the clusters, the other four groups and each launch's old-group total
are exactly as they were, so the two new groups add up to the old one on every
row. A launch with nothing on those channels in today's export keeps its whole
figure on Other.

The split is read on today's attribution and applied to figures read on the
panel's, which is older (the panel was last rebuilt before the export was
re-attributed on 24 September 2026). A full re-run of release_clusters.py reads
everything on one attribution and replaces this.

Run from the repo root after a full pull reaching back to 2023:
  BQ_SINCE=2023-01-01 node server/bigquery.js --write --full && python3 etl/analysis/split_search_group.py
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT / "etl" / "analysis"))
import baskets as B  # noqa: E402
from build import DISPLAY_GROUPS  # noqa: E402
import release_clusters as RC  # noqa: E402

OLD = B.LEGACY_GROUP
SEARCH, REST = B.LEGACY_PARTS
OLD_CHANNELS = DISPLAY_GROUPS[SEARCH]["channels"] + DISPLAY_GROUPS[REST]["channels"]
METRICS = [("Sessions_Total", "sessions", "sess"), ("Draw_Entries_Eligible_Units", "entries", "ent"),
           ("Total_Product_Units", "units", "unit")]
PREFIXES = ["sess_share_", "ent_share_", "unit_share_", "conv_sess_entry_", "conv_sess_unit_", "sessions_", "entries_", "units_"]


def main() -> None:
    panel = pd.read_csv(RC.OUT_CSV, low_memory=False)
    if f"sessions_{OLD}" not in panel.columns:
        print("the panel on file is already split")
        return
    df = RC.load_daily()
    df = df[df["channel"].isin(OLD_CHANNELS)]
    new = {f"{p}{g}": np.full(len(panel), np.nan) for p in PREFIXES for g in (SEARCH, REST)}
    done = empty = 0
    for i, r in panel.iterrows():
        if pd.isna(r.get("window_start")) or pd.isna(r.get(f"sessions_{OLD}")):
            continue
        x = df[(df["simple_release_name"] == r["release_name"])
               & (df["event_date"] >= pd.Timestamp(r["window_start"])) & (df["event_date"] <= pd.Timestamp(r["window_end"]))]
        part = {}
        for metric, key, share in METRICS:
            whole = float(x[metric].sum())
            p = float(x.loc[x["channel"].isin(DISPLAY_GROUPS[SEARCH]["channels"]), metric].sum() / whole) if whole > 0 else 0.0
            empty += whole <= 0 and float(r.get(f"{key}_{OLD}") or 0.0) > 0
            for g, f in ((SEARCH, p), (REST, 1.0 - p)):
                part[(key, g)] = float(r[f"{key}_{OLD}"]) * f if pd.notna(r[f"{key}_{OLD}"]) else np.nan
                new[f"{key}_{g}"][i] = part[(key, g)]
                new[f"{share}_share_{g}"][i] = float(r[f"{share}_share_{OLD}"]) * f if pd.notna(r[f"{share}_share_{OLD}"]) else np.nan
        # a group's conversion is a rate only where release_clusters.campaign_features would read one
        for g in (SEARCH, REST):
            s, e, u = part[("sessions", g)], part[("entries", g)], part[("units", g)]
            ok = s >= B.RATE_MIN_SESSIONS and e <= B.RATE_MAX_PER_SESSION * s and u <= B.RATE_MAX_PER_SESSION * s
            new[f"conv_sess_entry_{g}"][i] = e / s if ok else np.nan
            new[f"conv_sess_unit_{g}"][i] = u / s if ok else np.nan
        done += 1
    cols = []
    for c in panel.columns:
        if c.endswith(f"_{OLD}") and c[: -len(OLD)] in PREFIXES:
            cols += [(f"{c[: -len(OLD)]}{g}", new[f"{c[: -len(OLD)]}{g}"]) for g in (SEARCH, REST)]
        else:
            cols.append((c, panel[c]))
    out = pd.DataFrame(dict(cols))
    out.to_csv(RC.OUT_CSV, index=False)
    print(f"wrote {RC.OUT_CSV}: {done} launches split, {empty} figures with nothing on those channels in the export (kept on Other)")


if __name__ == "__main__":
    main()
