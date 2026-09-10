#!/usr/bin/env python3
"""Baskets of comparable releases: natural clusters across the LE history.

Why: a new artist, or a kind of collaboration we have not run before, has no
previous campaign to plan against. The target model plans every channel and
funnel stage from quartiles of one pooled panel (docs/METHODOLOGY.md #3). If
the history falls into a few recognisable kinds of release, the quartiles of
the right basket are a better prior than the quartiles of everything.

What it does
  1. Rebuilds one row per release from the daily funnel export
     (sources/across_time.csv, the BigQuery pull) over the release's own
     campaign window. The upstream campaign clock exists for 2026 launches
     only, so for the rest the window is inferred from the funnel itself:
     announce = first run of draw-entry days (draws open at announcement),
     close = the day the draw units are allocated. Both rules are checked
     against the 32 clocked releases below (announce within 2 days on 31,
     close exact on 24 of 27; the three misses are draws that ran past the
     clock's close).
  2. Features in four blocks - scale, channel mix of sessions, demand and
     conversion (oversubscription, private-room share, entries and units
     per session), timing shape (campaign length, early-access share,
     announcement burst, last-chance cliff, half-point) - z-scored and
     block-weighted so no block dominates the distance.
  3. Tests how many clusters the data supports: k-means silhouette and
     Calinski-Harabasz, the gap statistic against a uniform reference, GMM
     BIC, bootstrap stability (per-cluster Jaccard, Hennig 2007), Ward
     agreement, and a column-permutation null for the silhouette.
  4. Profiles the chosen clusters, names them, lists example releases, and
     asks whether repeat artists stay in one cluster (permutation test).
  5. Writes the baskets: per cluster, quartiles of every channel share and
     conversion and every campaign-stage share, the numbers the target model
     would draw from.

Releases that ran before the draw mechanic (everything up to 2023 Q3, a few
into 2024) sold buy-now: no entries, so no oversubscription or entry
conversion. They are profiled as their own legacy basket and placed against
the draw clusters on the features they share, not clustered with them.

Outputs
  data/release_clusters.csv        one row per release: window, features, cluster
  data/release_cluster_baskets.json per-cluster quartiles by channel and stage
  stdout                           the analysis, recorded in docs/RELEASE_CLUSTERS.md

Run from the repo root after a BigQuery pull:
  node server/bigquery.js --write --full && python3 etl/analysis/release_clusters.py
"""
from __future__ import annotations

import json
import pathlib
import sys
import warnings
from datetime import date, timedelta

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
from build import DISPLAY_GROUPS, GROUP_OF, discover_releases  # noqa: E402

SRC = ROOT / "sources" / "across_time.csv"
OUT_CSV = ROOT / "data" / "release_clusters.csv"
OUT_JSON = ROOT / "data" / "release_cluster_baskets.json"

EA_LEAD_DAYS = 45        # early access reaches at most this far before announce (checked: 44 sessions beyond it in the clocked panel)
ALLOC_TAIL_DAYS = 3      # units allocated within this many days after the draw closes still belong to it
MIN_ENTRIES = 10         # eligible entry units inside the window: a draw with fewer is not a draw campaign
MIN_UNITS = 10           # units sold inside the window (draw and legacy alike)
MIN_SESSIONS = 300       # a legacy launch with fewer sessions in its window is catalogue trickle, not a launch
MIN_GROUP_SESSIONS = 30  # a channel group with fewer sessions gets no conversion rate (a 1-in-3 is not a rate)
FIRST_QUARTER = "2023 Q1"  # releases named for an earlier quarter launched before the export
SETTLE_DAYS = 7          # a close this close to the export edge is not settled
SEED = 20260910

METRICS = ["Page_Views_Total", "Sessions_Total", "Draw_Entries", "Preorder_App", "Draw_Entry_Eligible",
           "Unique_Customers", "Customer_Private_Room", "Draw_Entry_Eligible_No_Conv", "Total_Product_Units",
           "Product_Units_Draw", "Product_Units_Preorder_App", "Product_Units_Private_Room",
           "Product_Units_Presale_Offered", "Product_Units_Other", "Draw_Entries_Total_Units",
           "Draw_Entries_Total_Units_No_Conv", "Draw_Entries_Eligible_Units"]
CLOCK = ["days_since_announcement", "days_until_launch", "pct_days_since_announcement", "pct_days_until_launch"]
LABELS = ["AA_session_custom_channel_group_split_touch", "simple_release_name", "campaign_stage"]
GROUPS = list(DISPLAY_GROUPS)   # aa_email, aa_social, referral_artist, search_direct_other, paid


# ---------------------------------------------------------------- load

def load_daily() -> pd.DataFrame:
    df = pd.read_csv(SRC, usecols=lambda c: c in LABELS + ["event_date"] + METRICS + CLOCK,
                     dtype={c: "category" for c in LABELS})
    df = df.rename(columns={"AA_session_custom_channel_group_split_touch": "channel"})
    df["event_date"] = pd.to_datetime(df["event_date"], format="%d/%m/%Y")
    df = df[df["simple_release_name"].notna()]
    if "Untracked" not in df["channel"].cat.categories:
        df["channel"] = df["channel"].cat.add_categories(["Untracked"])
    df.loc[df["channel"].str.lower() == "untracked", "channel"] = "Untracked"
    agg = {c: "sum" for c in METRICS}
    agg.update({c: "first" for c in CLOCK + ["campaign_stage"]})
    # fan-out pairs (two campaign-date sub-records) sum - docs #6.1
    df = (df.groupby(["channel", "event_date", "simple_release_name"], as_index=False, observed=True).agg(agg))
    for c in ["channel", "simple_release_name", "campaign_stage"]:
        df[c] = df[c].astype(object)
    df["group"] = df["channel"].map(GROUP_OF)          # Untracked -> NaN, excluded from mix denominators
    df["entries_all"] = df["Draw_Entries"] + df["Preorder_App"]
    return df


# ---------------------------------------------------------------- campaign windows

def infer_window(d: pd.DataFrame) -> dict:
    """Announce and close from the funnel of one release (daily frame, any order).

    announce: first day of a run of two or more consecutive days with entries,
              or a day with three or more - a stray single entry days before
              the announcement is not the announcement.
    close:    the day with the most draw units booked (allocation), else the
              last day with entries."""
    d = d.sort_values("event_date")
    e = d[d["entries_all"] > 0]
    dates, counts = e["event_date"].tolist(), e["entries_all"].tolist()
    announce = None
    for i, (dt, c) in enumerate(zip(dates, counts)):
        if c >= 3 or (i + 1 < len(dates) and (dates[i + 1] - dt).days == 1):
            announce = dt
            break
    alloc = d.loc[d["Product_Units_Draw"].idxmax(), "event_date"] if d["Product_Units_Draw"].max() > 0 else None
    last_entry = dates[-1] if dates else None
    close = alloc if alloc is not None else last_entry
    return {"announce": announce, "close": close, "alloc": alloc, "last_entry": last_entry}


def release_windows(df: pd.DataFrame, as_of: date) -> pd.DataFrame:
    """One row per release: the campaign window, from the upstream clock where
    the export carries it (2026 launches), otherwise inferred from the funnel."""
    day = (df.groupby(["simple_release_name", "event_date"], as_index=False)
             [["Sessions_Total", "entries_all", "Product_Units_Draw", "Total_Product_Units"]].sum())
    clock = {r["release_name"]: r for r in discover_releases(df, as_of, set())}
    rows = []
    for name, d in day.groupby("simple_release_name"):
        c = clock.get(name, {})
        inf = infer_window(d)
        parts = str(name).split(" · ")
        yq = parts[-1] if len(parts) >= 2 else None
        row = {"release_name": name, "artist": parts[0], "title": " · ".join(parts[1:-1]) if len(parts) >= 3 else "",
               "quarter": yq, "year": int(yq[:4]) if yq and yq[:4].isdigit() else None,
               "first_seen": d["event_date"].min().date(), "last_seen": d["event_date"].max().date(),
               "sessions_life": float(d["Sessions_Total"].sum()), "units_life": float(d["Total_Product_Units"].sum()),
               "entries_life": float(d["entries_all"].sum()),
               "announce_inferred": inf["announce"].date() if inf["announce"] is not None else None,
               "close_inferred": inf["close"].date() if inf["close"] is not None else None,
               "alloc_day": inf["alloc"].date() if inf["alloc"] is not None else None}
        if c.get("announce_date") and c.get("launch_end"):
            row.update(announce=date.fromisoformat(c["announce_date"]), close=date.fromisoformat(c["launch_end"]),
                       dates_source="clock")
        else:
            row.update(announce=row["announce_inferred"], close=row["close_inferred"], dates_source="inferred")
        rows.append(row)
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- features

def stage_of(pdsa: pd.Series) -> pd.Series:
    out = pd.Series("outside", index=pdsa.index)
    out[pdsa < 0] = "early_access"
    out[(pdsa >= 0) & (pdsa < 1 / 3)] = "sustain_1"
    out[(pdsa >= 1 / 3) & (pdsa < 2 / 3)] = "sustain_2"
    out[(pdsa >= 2 / 3) & (pdsa < 1)] = "sustain_3"
    out[pdsa >= 1] = "last_chance"
    return out


def campaign_features(df: pd.DataFrame, w: pd.Series) -> dict:
    """Totals, mix, conversion and timing of one release over its window."""
    A, C = pd.Timestamp(w["announce"]), pd.Timestamp(w["close"])
    L = (C - A).days
    start = A - pd.Timedelta(days=EA_LEAD_DAYS)
    end = max(C, pd.Timestamp(w["alloc_day"]) if w["alloc_day"] else C) + pd.Timedelta(days=ALLOC_TAIL_DAYS)
    x = df[(df["simple_release_name"] == w["release_name"]) & (df["event_date"] >= start) & (df["event_date"] <= end)].copy()
    x["pdsa"] = (x["event_date"] - A).dt.days / L
    tot = x[METRICS].sum()
    f = {"window_start": start.date(), "window_end": end.date(), "campaign_days": L}
    f.update({f"tot_{k.lower()}": float(v) for k, v in tot.items()})
    f["entries_all"] = float(x["entries_all"].sum())
    sessions, units, eu = tot["Sessions_Total"], tot["Total_Product_Units"], tot["Draw_Entries_Eligible_Units"]
    # channel mix of sessions / entries / units, untracked left out of the denominator
    tracked = x[x["group"].notna()]
    for metric, key in [("Sessions_Total", "sess"), ("Draw_Entries_Eligible_Units", "ent"), ("Total_Product_Units", "unit")]:
        g = tracked.groupby("group")[metric].sum()
        denom = g.sum()
        for grp in GROUPS:
            f[f"{key}_share_{grp}"] = float(g.get(grp, 0) / denom) if denom else np.nan
    # per group conversion (unadjusted denominators, the benchmark convention)
    gs = tracked.groupby("group")[["Sessions_Total", "Draw_Entries_Eligible_Units", "Total_Product_Units", "Product_Units_Draw"]].sum()
    for grp in GROUPS:
        s = gs["Sessions_Total"].get(grp, 0); e = gs["Draw_Entries_Eligible_Units"].get(grp, 0)
        u = gs["Total_Product_Units"].get(grp, 0)
        f[f"conv_sess_entry_{grp}"] = float(e / s) if s >= MIN_GROUP_SESSIONS else np.nan
        f[f"conv_sess_unit_{grp}"] = float(u / s) if s >= MIN_GROUP_SESSIONS else np.nan
        f[f"sessions_{grp}"] = float(s); f[f"entries_{grp}"] = float(e); f[f"units_{grp}"] = float(u)
    # raw channel session shares (for the baskets)
    ch = tracked.groupby("channel")["Sessions_Total"].sum(); chd = ch.sum()
    for c in sorted(GROUP_OF):
        f[f"chan_share_{c}"] = float(ch.get(c, 0) / chd) if chd else np.nan
    f["untracked_share"] = float(x.loc[x["group"].isna(), "Sessions_Total"].sum() / sessions) if sessions else np.nan
    # demand and conversion
    f["oversubscription"] = float(eu / units) if units else np.nan            # eligible entry units per unit sold (the dashboard's definition)
    f["oversub_draw"] = float(eu / tot["Product_Units_Draw"]) if tot["Product_Units_Draw"] else np.nan
    f["private_room_share"] = float(tot["Product_Units_Private_Room"] / units) if units else np.nan
    f["preorder_share"] = float(tot["Product_Units_Preorder_App"] / units) if units else np.nan
    f["draw_route_share"] = float(tot["Product_Units_Draw"] / units) if units else np.nan
    f["other_route_share"] = float((tot["Product_Units_Other"] + tot["Product_Units_Presale_Offered"]) / units) if units else np.nan
    f["entries_per_session"] = float(eu / sessions) if sessions else np.nan
    f["units_per_session"] = float(units / sessions) if sessions else np.nan
    f["entry_to_unit"] = float(tot["Product_Units_Draw"] / eu) if eu else np.nan
    f["pageviews_per_session"] = float(tot["Page_Views_Total"] / sessions) if sessions else np.nan
    # timing shape on the campaign clock
    day = x.groupby("event_date")[["Sessions_Total", "Draw_Entries_Eligible_Units", "Total_Product_Units"]].sum().sort_index()
    pdsa = pd.Series((day.index - A).days / L, index=day.index)
    camp = day[(pdsa >= 0) & (pdsa <= 1)]
    cs = camp["Sessions_Total"].sum(); ce = camp["Draw_Entries_Eligible_Units"].sum()
    f["ea_share_sessions"] = float(day.loc[pdsa < 0, "Sessions_Total"].sum() / sessions) if sessions else np.nan
    f["ea_share_units"] = float(day.loc[pdsa < 0, "Total_Product_Units"].sum() / units) if units else np.nan
    f["burst_share"] = float(camp.loc[pdsa[camp.index] < 0.1, "Sessions_Total"].sum() / cs) if cs else np.nan
    f["cliff_share"] = float(camp.loc[pdsa[camp.index] >= 0.9, "Sessions_Total"].sum() / cs) if cs else np.nan
    f["entries_burst_share"] = float(camp.loc[pdsa[camp.index] < 0.1, "Draw_Entries_Eligible_Units"].sum() / ce) if ce else np.nan
    f["entries_cliff_share"] = float(camp.loc[pdsa[camp.index] >= 0.9, "Draw_Entries_Eligible_Units"].sum() / ce) if ce else np.nan
    f["peak_day_share"] = float(camp["Sessions_Total"].max() / cs) if cs else np.nan
    cum = camp["Sessions_Total"].cumsum() / cs if cs else None
    f["half_point"] = float(pdsa[cum[cum >= 0.5].index[0]]) if cs else np.nan
    ecum = camp["Draw_Entries_Eligible_Units"].cumsum() / ce if ce else None
    f["entries_half_point"] = float(pdsa[ecum[ecum >= 0.5].index[0]]) if ce else np.nan
    st = stage_of(pdsa)
    for metric, key in [("Sessions_Total", "sess"), ("Draw_Entries_Eligible_Units", "ent"), ("Total_Product_Units", "unit")]:
        tt = day[metric].sum()
        for s in ["early_access", "sustain_1", "sustain_2", "sustain_3", "last_chance", "outside"]:
            f[f"stage_{key}_{s}"] = float(day.loc[st == s, metric].sum() / tt) if tt else np.nan
    f["campaign_sessions"] = float(cs)
    return f


def build_panel(df: pd.DataFrame, as_of: date) -> pd.DataFrame:
    win = release_windows(df, as_of)
    rows = []
    for _, w in win.iterrows():
        r = w.to_dict()
        draw = w["entries_life"] >= MIN_ENTRIES
        r["mechanic"] = "draw" if draw else ("no_draw" if w["units_life"] >= MIN_UNITS else "trace")
        r["panel"] = None; r["exclude_reason"] = None
        if r["mechanic"] == "trace":
            r["exclude_reason"] = f"fewer than {MIN_ENTRIES} entries and {MIN_UNITS} units"
            rows.append(r); continue
        if (r["quarter"] or "") < FIRST_QUARTER:
            r["exclude_reason"] = "launched before the export (catalogue traffic only)"; rows.append(r); continue
        if not draw:
            # no draw: the window is the launch day (most non-private-room units) and three weeks of sell-through
            d = df[df["simple_release_name"] == w["release_name"]]
            day = d.groupby("event_date")[["Total_Product_Units", "Product_Units_Private_Room"]].sum()
            npr = day["Total_Product_Units"] - day["Product_Units_Private_Room"]
            if npr.max() <= 0:
                r["exclude_reason"] = "no public sales day"; rows.append(r); continue
            launch = npr.idxmax()
            r["announce"], r["close"], r["dates_source"] = launch.date(), (launch + pd.Timedelta(days=21)).date(), "launch_day+21"
            r["alloc_day"] = None
        if r["announce"] is None or r["close"] is None:
            r["exclude_reason"] = "no campaign window"; rows.append(r); continue
        L = (pd.Timestamp(r["close"]) - pd.Timestamp(r["announce"])).days
        if not (3 <= L <= 90):
            r["exclude_reason"] = f"window {L} days"; rows.append(r); continue
        if pd.Timestamp(r["close"]) > pd.Timestamp(as_of) - pd.Timedelta(days=SETTLE_DAYS):
            r["exclude_reason"] = "in flight / not settled"; rows.append(r); continue
        if pd.Timestamp(r["announce"]) - pd.Timedelta(days=EA_LEAD_DAYS) < pd.Timestamp(df["event_date"].min()):
            r["exclude_reason"] = "window starts before the export"; rows.append(r); continue
        r.update(campaign_features(df, pd.Series(r)))
        if r["tot_total_product_units"] < MIN_UNITS:
            r["exclude_reason"] = f"under {MIN_UNITS} units in the window"; rows.append(r); continue
        if draw and r["tot_draw_entries_eligible_units"] < MIN_ENTRIES:
            r["exclude_reason"] = f"under {MIN_ENTRIES} eligible entry units in the window"; rows.append(r); continue
        if not draw and r["tot_sessions_total"] < MIN_SESSIONS:
            r["exclude_reason"] = f"under {MIN_SESSIONS} sessions in the window"; rows.append(r); continue
        r["panel"] = "draw" if draw else "legacy"
        rows.append(r)
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- clustering

FEATURE_BLOCKS = {
    "scale": ["log_sessions", "log_units", "log_entries"],
    "mix": ["sess_share_aa_email", "sess_share_aa_social", "sess_share_referral_artist",
            "sess_share_search_direct_other", "sess_share_paid"],
    "demand": ["log_oversub", "private_room_share", "log_entries_per_session", "log_units_per_session"],
    "timing": ["campaign_days", "ea_share_sessions", "burst_share", "cliff_share", "half_point"],
}
FEATURES = [f for fs in FEATURE_BLOCKS.values() for f in fs]
K_RANGE = range(2, 9)
N_BOOT = 200
N_PERM = 200
N_GAP_REF = 100
WINSOR = 0.02


def derived(panel: pd.DataFrame) -> pd.DataFrame:
    p = panel.copy()
    p["log_sessions"] = np.log(p["tot_sessions_total"])
    p["log_units"] = np.log(p["tot_total_product_units"])
    p["log_entries"] = np.log(p["tot_draw_entries_eligible_units"].clip(lower=1))
    p["log_oversub"] = np.log(p["oversubscription"].clip(lower=0.05))
    p["log_entries_per_session"] = np.log(p["entries_per_session"].clip(lower=1e-4))
    p["log_units_per_session"] = np.log(p["units_per_session"].clip(lower=1e-4))
    return p


class Scaler:
    """Winsorise, z-score, then weight each block by 1/sqrt(its size) so the
    four blocks carry equal total variance in the distance."""

    def __init__(self, frame: pd.DataFrame, blocks: dict[str, list[str]]):
        self.blocks = blocks
        self.cols = [f for fs in blocks.values() for f in fs]
        self.lo = frame[self.cols].quantile(WINSOR)
        self.hi = frame[self.cols].quantile(1 - WINSOR)
        w = frame[self.cols].clip(self.lo, self.hi, axis=1)
        self.mu, self.sd = w.mean(), w.std(ddof=0).replace(0, 1)
        self.weight = pd.Series({f: 1 / np.sqrt(len(fs)) for fs in blocks.values() for f in fs})

    def transform(self, frame: pd.DataFrame) -> np.ndarray:
        z = (frame[self.cols].clip(self.lo, self.hi, axis=1) - self.mu) / self.sd
        return (z * self.weight).to_numpy()


def kmeans(X: np.ndarray, k: int, seed: int = SEED, n_init: int = 50):
    from sklearn.cluster import KMeans
    return KMeans(n_clusters=k, n_init=n_init, random_state=seed).fit(X)


def within_ss(X: np.ndarray, labels: np.ndarray) -> float:
    return float(sum(((X[labels == c] - X[labels == c].mean(0)) ** 2).sum() for c in np.unique(labels)))


def gap_statistic(X: np.ndarray, ks, rng: np.random.Generator) -> pd.DataFrame:
    """Tibshirani, Walther & Hastie (2001): log W_k against uniform draws in the
    bounding box of the PCA-rotated data."""
    from sklearn.decomposition import PCA
    pca = PCA().fit(X)
    Xr = pca.transform(X)
    lo, hi = Xr.min(0), Xr.max(0)
    rows = {}
    logw = {k: np.log(within_ss(X, kmeans(X, k, n_init=10).labels_) if k > 1 else within_ss(X, np.zeros(len(X), int))) for k in ks}
    ref = {k: [] for k in ks}
    for _ in range(N_GAP_REF):
        Z = pca.inverse_transform(rng.uniform(lo, hi, size=Xr.shape))
        for k in ks:
            lab = kmeans(Z, k, seed=int(rng.integers(1 << 30)), n_init=5).labels_ if k > 1 else np.zeros(len(Z), int)
            ref[k].append(np.log(within_ss(Z, lab)))
    for k in ks:
        r = np.array(ref[k])
        rows[k] = {"gap": float(r.mean() - logw[k]), "gap_se": float(r.std(ddof=0) * np.sqrt(1 + 1 / N_GAP_REF))}
    return pd.DataFrame(rows).T


def bootstrap_stability(X: np.ndarray, k: int, ref_labels: np.ndarray, rng: np.random.Generator) -> dict:
    """Hennig (2007): per reference cluster, the mean over bootstrap resamples of
    the best Jaccard match with a cluster found on the resample. > 0.75 stable,
    0.6-0.75 a pattern, < 0.5 dissolved. Also the adjusted Rand index between
    the reference partition and the resample partition on the resampled items."""
    from sklearn.metrics import adjusted_rand_score
    n = len(X)
    jac = {c: [] for c in np.unique(ref_labels)}
    aris = []
    for _ in range(N_BOOT):
        idx = np.unique(rng.integers(0, n, n))
        lab = kmeans(X[idx], k, seed=int(rng.integers(1 << 30)), n_init=10).labels_
        aris.append(adjusted_rand_score(ref_labels[idx], lab))
        for c in jac:
            a = set(np.where(ref_labels[idx] == c)[0])
            if not a:
                continue
            best = max(len(a & set(np.where(lab == c2)[0])) / len(a | set(np.where(lab == c2)[0])) for c2 in np.unique(lab))
            jac[c].append(best)
    per = {c: float(np.mean(v)) for c, v in jac.items()}
    return {"jaccard_mean": float(np.mean(list(per.values()))), "jaccard_min": float(min(per.values())),
            "ari_boot": float(np.mean(aris)), "per_cluster": per}


def permutation_null(X: np.ndarray, ks, rng: np.random.Generator) -> pd.DataFrame:
    """Silhouette of k-means on data with every column independently permuted:
    the same marginals with no joint structure."""
    from sklearn.metrics import silhouette_score
    out = {k: [] for k in ks}
    for _ in range(N_PERM):
        Z = np.column_stack([rng.permutation(X[:, j]) for j in range(X.shape[1])])
        for k in ks:
            out[k].append(silhouette_score(Z, kmeans(Z, k, seed=int(rng.integers(1 << 30)), n_init=5).labels_))
    return pd.DataFrame({k: {"null_sil_mean": float(np.mean(v)), "null_sil_p95": float(np.quantile(v, 0.95)),
                             "_null": v} for k, v in out.items()}).T


def diagnostics(X: np.ndarray, ks=K_RANGE, seed: int = SEED) -> tuple[pd.DataFrame, dict]:
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import pdist
    from scipy.cluster.hierarchy import cophenet
    from sklearn.metrics import adjusted_rand_score, calinski_harabasz_score, davies_bouldin_score, silhouette_score
    from sklearn.mixture import GaussianMixture
    rng = np.random.default_rng(seed)
    ks = list(ks)
    fits = {k: kmeans(X, k) for k in ks}
    Z = linkage(X, "ward")
    coph = float(np.corrcoef(cophenet(Z), pdist(X))[0, 1])
    rows = {}
    for k in ks:
        lab = fits[k].labels_
        ward = fcluster(Z, k, "maxclust")
        gm = GaussianMixture(k, covariance_type="diag", n_init=5, random_state=seed).fit(X)
        stab = bootstrap_stability(X, k, lab, rng)
        rows[k] = {"silhouette": silhouette_score(X, lab), "calinski_harabasz": calinski_harabasz_score(X, lab),
                   "davies_bouldin": davies_bouldin_score(X, lab), "bic_diag": gm.bic(X),
                   "ari_ward": adjusted_rand_score(lab, ward), "smallest_cluster": int(np.bincount(lab).min()),
                   **{k2: v for k2, v in stab.items() if k2 != "per_cluster"}}
    d = pd.DataFrame(rows).T
    gap = gap_statistic(X, [1] + ks, rng)
    d["gap"] = gap.loc[ks, "gap"]; d["gap_se"] = gap.loc[ks, "gap_se"]
    d.attrs["gap1"] = float(gap.loc[1, "gap"])
    perm = permutation_null(X, ks, rng)
    d["null_sil_mean"] = perm["null_sil_mean"].astype(float); d["null_sil_p95"] = perm["null_sil_p95"].astype(float)
    d["sil_p"] = [float((np.array(perm.loc[k, "_null"]) >= d.loc[k, "silhouette"]).mean()) for k in ks]
    d["bic_gmm_k1"] = GaussianMixture(1, covariance_type="diag", random_state=seed).fit(X).bic(X)
    d.attrs["cophenetic"] = coph
    return d, fits


def gap_choice(d: pd.DataFrame) -> int | None:
    """Smallest k with gap(k) >= gap(k+1) - se(k+1), the 1-SE rule; k=1 counts."""
    ks = list(d.index)
    gaps = {1: d.attrs["gap1"], **{k: d.loc[k, "gap"] for k in ks}}
    ses = {k: d.loc[k, "gap_se"] for k in ks}
    for k in [1] + ks[:-1]:
        if gaps[k] >= gaps[k + 1] - ses[k + 1]:
            return k
    return ks[-1]


# ---------------------------------------------------------------- profiles

PROFILE_COLS = ["tot_sessions_total", "tot_total_product_units", "tot_draw_entries_eligible_units", "oversubscription",
                "private_room_share", "preorder_share", "sess_share_aa_email", "sess_share_aa_social",
                "sess_share_referral_artist", "sess_share_search_direct_other", "sess_share_paid",
                "entries_per_session", "units_per_session", "entry_to_unit", "campaign_days", "ea_share_sessions",
                "burst_share", "cliff_share", "half_point", "peak_day_share"]
BASKET_COLS = PROFILE_COLS + ["tot_page_views_total", "tot_unique_customers", "ea_share_units", "entries_burst_share",
                              "entries_cliff_share", "entries_half_point", "pageviews_per_session", "draw_route_share",
                              "other_route_share", "oversub_draw"] + \
    [f"{k}_share_{g}" for k in ["sess", "ent", "unit"] for g in GROUPS] + \
    [f"conv_sess_entry_{g}" for g in GROUPS] + [f"conv_sess_unit_{g}" for g in GROUPS] + \
    [f"stage_{k}_{s}" for k in ["sess", "ent", "unit"] for s in ["early_access", "sustain_1", "sustain_2", "sustain_3", "last_chance", "outside"]]
BASKET_COLS = list(dict.fromkeys(BASKET_COLS))


def quartiles(frame: pd.DataFrame, cols) -> pd.DataFrame:
    q = frame[cols].quantile([0.25, 0.5, 0.75]).T
    q.columns = ["p25", "p50", "p75"]
    q["n"] = frame[cols].notna().sum()
    return q


def examples(sub: pd.DataFrame, Xs: np.ndarray, centre: np.ndarray, n: int = 3) -> dict:
    dist = np.linalg.norm(Xs - centre, axis=1)
    order = np.argsort(dist)
    return {"typical": sub.iloc[order[:n]]["release_name"].tolist(),
            "largest": sub.sort_values("tot_total_product_units", ascending=False)["release_name"].head(n).tolist()}


def repeat_artists(sub: pd.DataFrame, labels: np.ndarray, rng: np.random.Generator, n_perm: int = 10000) -> dict:
    s = sub.assign(cluster=labels)
    multi = s.groupby("artist").filter(lambda g: len(g) >= 2)
    def same_pairs(lab: pd.Series) -> tuple[int, int]:
        same = tot = 0
        for _, g in multi.assign(cluster=lab.values).groupby("artist"):
            v = g["cluster"].to_numpy()
            for i in range(len(v)):
                for j in range(i + 1, len(v)):
                    tot += 1; same += int(v[i] == v[j])
        return same, tot
    same, tot = same_pairs(multi["cluster"])
    null = []
    for _ in range(n_perm):
        perm = pd.Series(rng.permutation(s["cluster"].to_numpy()), index=s.index)
        null.append(same_pairs(perm.loc[multi.index])[0])
    null = np.array(null)
    per_artist = (multi.groupby("artist")["cluster"]
                  .agg(n="size", clusters=lambda c: sorted(set(int(x) for x in c)))
                  .assign(one_cluster=lambda f: f["clusters"].map(len) == 1)
                  .sort_values("n", ascending=False))
    return {"artists": int(multi["artist"].nunique()), "releases": int(len(multi)), "pairs": tot, "same": same,
            "share_same": same / tot if tot else np.nan, "null_mean": float(null.mean() / tot) if tot else np.nan,
            "p_value": float((null >= same).mean()), "per_artist": per_artist,
            "artists_one_cluster": int(per_artist["one_cluster"].sum())}


# ---------------------------------------------------------------- report

PCT = {c for c in BASKET_COLS if "share" in c or c.startswith("stage_") or c.startswith("conv_") or c in
       {"entries_per_session", "units_per_session", "entry_to_unit", "half_point", "entries_half_point"}}

# Names follow the ordering order_labels() imposes (paid share, then size), so
# they are stable across re-runs as long as the four kinds keep those ranks.
NAMES_K4 = ["Paid-led headline launches", "Paid-supported small editions",
            "Email-led collector launches with a private room", "Artist-audience draws"]
NAMES_K2 = ["Paid-led", "Organic"]


def order_labels(draw: pd.DataFrame, labels: np.ndarray) -> np.ndarray:
    """k-means labels are arbitrary; number clusters by paid share (paid-led first) then by size."""
    s = draw.assign(c=labels).groupby("c").agg(paid=("sess_share_paid", "median"), units=("tot_total_product_units", "median"))
    s["paid_led"] = (s["paid"] > 0.2).astype(int)
    order = s.sort_values(["paid_led", "units"], ascending=[False, False]).index.tolist()
    return np.array([order.index(c) for c in labels])


def num(v: float, col: str) -> str:
    if pd.isna(v):
        return "-"
    if col in PCT:
        return f"{v:.1%}"
    return f"{v:,.0f}" if abs(v) >= 100 else (f"{v:.1f}" if abs(v) >= 10 else f"{v:.2f}")


def profile_table(sub: pd.DataFrame, labels: np.ndarray, names: list[str], cols=PROFILE_COLS) -> pd.DataFrame:
    s = sub.assign(cluster=labels)
    med = s.groupby("cluster")[cols].median().T
    med.columns = [f"{c} {names[c]}" for c in med.columns]
    med["all"] = s[cols].median()
    return med


def artist_consistency(sub: pd.DataFrame, rng: np.random.Generator, n_perm: int = 5000) -> pd.DataFrame:
    """Which features does a repeat artist carry from one release to the next?
    Intraclass correlation (1 - within-artist / total variance) over the artists
    with two or more releases, with a permutation p-value."""
    multi = sub.groupby("artist").filter(lambda g: len(g) >= 2)
    z = (multi[FEATURES] - multi[FEATURES].mean()) / multi[FEATURES].std(ddof=0)
    def icc(frame: pd.DataFrame, artists: pd.Series) -> pd.Series:
        within = frame.groupby(artists.values).var(ddof=0).mul(frame.groupby(artists.values).size(), axis=0).sum() / len(frame)
        return 1 - within / frame.var(ddof=0)
    obs = icc(z, multi["artist"])
    null = np.array([icc(z, pd.Series(rng.permutation(multi["artist"].to_numpy()))).to_numpy() for _ in range(n_perm)])
    out = pd.DataFrame({"icc": obs, "null_mean": null.mean(0), "p": (null >= obs.to_numpy()).mean(0)})
    return out.sort_values("icc", ascending=False)


ENTRY_COLS = [c for c in BASKET_COLS if "ent" in c.split("_") or c.startswith("ent_") or c.startswith("conv_sess_entry")
              or "entries" in c or c in {"oversubscription", "oversub_draw", "entry_to_unit", "tot_draw_entries_eligible_units",
                                          "tot_draw_entry_eligible", "tot_draw_entry_eligible_no_conv", "tot_draw_entries_total_units",
                                          "tot_draw_entries_total_units_no_conv", "tot_preorder_app"}]


def basket(sub: pd.DataFrame, Xs: np.ndarray | None = None, centre: np.ndarray | None = None, draw: bool = True) -> dict:
    # a basket without draws has no entry stage: the few stray entries on legacy launches are not a rate
    q = quartiles(sub, [c for c in BASKET_COLS if c in sub and (draw or c not in ENTRY_COLS)])
    chan = quartiles(sub, [f"chan_share_{c}" for c in sorted(GROUP_OF)])
    out = {"n": int(len(sub)), "members": sub.sort_values("announce")["release_name"].tolist(),
           "years": {int(k): int(v) for k, v in sub["year"].value_counts().sort_index().items()},
           "quartiles": {k: {kk: (None if pd.isna(vv) else float(vv)) for kk, vv in row.items()} for k, row in q.iterrows()},
           "channel_session_share": {k.replace("chan_share_", ""): {kk: (None if pd.isna(vv) else float(vv)) for kk, vv in row.items()}
                                     for k, row in chan.iterrows()}}
    if Xs is not None:
        out.update(examples(sub, Xs, centre))
    return out


def main() -> None:
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 80); pd.set_option("display.max_rows", 500)
    warnings.filterwarnings("ignore")
    df = load_daily()
    as_of = df["event_date"].max().date()
    panel = derived(build_panel(df, as_of))
    draw = panel[panel["panel"] == "draw"].reset_index(drop=True)
    legacy = panel[panel["panel"] == "legacy"].reset_index(drop=True)
    print(f"export {df['event_date'].min().date()} .. {as_of}: {panel['release_name'].nunique()} releases; "
          f"draw panel {len(draw)} ({(draw.dates_source == 'clock').sum()} with the upstream clock, "
          f"{(draw.dates_source == 'inferred').sum()} inferred), legacy no-draw {len(legacy)}")
    print("excluded:", panel["exclude_reason"].value_counts().to_dict())

    scaler = Scaler(draw, FEATURE_BLOCKS)
    X = scaler.transform(draw)
    print(f"\nfeatures: {len(FEATURES)} in {len(FEATURE_BLOCKS)} blocks, {len(draw)} releases")

    # ---- how many clusters
    print("\n== how many clusters does the draw panel support ==")
    d, fits = diagnostics(X)
    show = d[["silhouette", "null_sil_p95", "sil_p", "calinski_harabasz", "davies_bouldin", "gap", "gap_se",
              "bic_diag", "jaccard_mean", "jaccard_min", "ari_boot", "ari_ward", "smallest_cluster"]].copy()
    show.index.name = "k"
    print(show.round(3).to_string())
    kg = gap_choice(d)
    print(f"gap(1) = {d.attrs['gap1']:.3f}; 1-SE rule picks k = {kg}; GMM diag BIC at k=1 = {d['bic_gmm_k1'].iloc[0]:.1f} "
          f"(lower is better); Ward cophenetic correlation {d.attrs['cophenetic']:.2f}")

    # ---- sensitivity: which blocks carry the structure
    print("\n== sensitivity: silhouette / stability by k with blocks removed, and per block alone ==")
    from sklearn.metrics import adjusted_rand_score, silhouette_score
    for g in GROUPS[:-1]:
        draw[f"org_share_{g}"] = draw[f"sess_share_{g}"] / (1 - draw["sess_share_paid"]).clip(lower=1e-6)
    variants = {"all blocks": FEATURE_BLOCKS}
    for b in FEATURE_BLOCKS:
        variants[f"without {b}"] = {k: v for k, v in FEATURE_BLOCKS.items() if k != b}
        variants[f"{b} only"] = {b: FEATURE_BLOCKS[b]}
    variants["organic mix (paid share dropped)"] = {**FEATURE_BLOCKS, "mix": [f"org_share_{g}" for g in GROUPS[:-1]]}
    sens = {}
    rng = np.random.default_rng(SEED + 1)
    for name, blocks in variants.items():
        Xv = Scaler(draw, blocks).transform(draw)
        row = {}
        for k in [2, 3, 4, 5]:
            lab = kmeans(Xv, k).labels_
            st = bootstrap_stability(Xv, k, lab, rng)
            row[f"sil k={k}"] = silhouette_score(Xv, lab)
            row[f"jac k={k}"] = st["jaccard_mean"]
            row[f"ari vs main k={k}"] = adjusted_rand_score(lab, fits[k].labels_)
        sens[name] = row
    sens = pd.DataFrame(sens).T
    print(sens.round(2).to_string())

    # ---- the two solutions worth reading: the robust split (gap 1-SE, stability) and the finer one (BIC, stability)
    rng = np.random.default_rng(SEED + 2)
    lab2 = order_labels(draw, fits[2].labels_)
    lab4 = order_labels(draw, fits[4].labels_)
    print("\n== k=2 against k=4 (rows k=2, columns k=4) ==")
    print(pd.crosstab(lab2, lab4).to_string())
    repeat = {}
    for K, lab, names in [(2, lab2, NAMES_K2), (4, lab4, NAMES_K4)]:
        print(f"\n== profile at k={K}: medians by cluster ==")
        prof = profile_table(draw, lab, names)
        prof.index = [c + (" %" if c in PCT else "") for c in prof.index]
        print(prof.map(lambda v: f"{v:.3g}").to_string())
        s = draw.assign(cluster=lab)
        print("\nreleases by year and cluster:"); print(pd.crosstab(s["year"], s["cluster"]).to_string())
        print("dates source by cluster:"); print(pd.crosstab(s["dates_source"], s["cluster"]).to_string())
        ra = repeat_artists(draw, lab, rng)
        repeat[K] = ra
        print(f"\nrepeat artists at k={K}: {ra['artists']} artists with 2+ releases ({ra['releases']} releases, {ra['pairs']} pairs); "
              f"{ra['same']} pairs in the same cluster = {ra['share_same']:.0%} vs {ra['null_mean']:.0%} expected by chance "
              f"(permutation p = {ra['p_value']:.3f}); {ra['artists_one_cluster']} of {ra['artists']} artists stay in one cluster")
        print(ra["per_artist"].to_string())
    ac = artist_consistency(draw, rng)
    print(f"\n== what a repeat artist carries over: intraclass correlation by feature "
          f"({repeat[4]['artists']} artists with 2+ releases, {repeat[4]['releases']} releases) ==")
    print(ac.round(3).to_string())

    print("\n== members at k=4 ==")
    dist = np.linalg.norm(X - fits[4].cluster_centers_[fits[4].labels_], axis=1)
    s = draw.assign(cluster=lab4, dist=dist)
    cols = ["release_name", "dates_source", "announce", "campaign_days", "tot_sessions_total", "tot_total_product_units",
            "tot_draw_entries_eligible_units", "oversubscription", "private_room_share", "sess_share_paid", "sess_share_aa_email",
            "sess_share_referral_artist", "entries_per_session", "ea_share_sessions", "burst_share", "cliff_share", "dist"]
    for c in sorted(s["cluster"].unique()):
        sub = s[s["cluster"] == c].sort_values("dist")
        print(f"\n-- {c}: {NAMES_K4[c]} ({len(sub)}) --")
        print(sub[cols].to_string(index=False, float_format=lambda v: f"{v:.3g}"))

    # ---- legacy no-draw launches placed against the draw clusters on the features they share
    shared = {"scale": ["log_sessions", "log_units"], "mix": FEATURE_BLOCKS["mix"], "demand": ["private_room_share", "log_units_per_session"]}
    sc2 = Scaler(draw, shared)
    Xd, Xl = sc2.transform(draw), sc2.transform(legacy)
    cents = np.vstack([Xd[lab4 == c].mean(0) for c in range(4)])
    legacy["nearest_cluster"] = np.argmin(((Xl[:, None, :] - cents[None]) ** 2).sum(-1), axis=1)
    legacy["nearest_cluster_name"] = legacy["nearest_cluster"].map(dict(enumerate(NAMES_K4)))
    print("\n== legacy no-draw launches (2023 Q1 - 2025 Q2) placed by nearest k=4 centroid on scale, mix and private-room share ==")
    print(legacy["nearest_cluster_name"].value_counts().to_string())
    print(legacy[PROFILE_COLS].median().rename("legacy median").to_frame().T.map(lambda v: f"{v:.3g}").to_string())

    # ---- baskets
    print("\n== baskets: median (p25-p75) by cluster ==")
    s = draw.assign(cluster=lab4)
    rows = []
    for col in BASKET_COLS:
        row = {"metric": col}
        for c in range(4):
            q = s.loc[s["cluster"] == c, col].quantile([0.25, 0.5, 0.75])
            row[NAMES_K4[c]] = " ".join([num(q[0.5], col), f"({num(q[0.25], col)}-{num(q[0.75], col)})"])
        rows.append(row)
    print(pd.DataFrame(rows).set_index("metric").to_string())

    # ---- outputs
    out = draw.assign(cluster=lab4, cluster_name=[NAMES_K4[c] for c in lab4], cluster_k2=lab2,
                      cluster_k2_name=[NAMES_K2[c] for c in lab2], dist_to_centroid=dist)
    out = pd.concat([out, legacy.assign(cluster_name=None, cluster_k2_name=None),
                     panel[panel["panel"].isna()]], ignore_index=True)
    keep = [c for c in out.columns if not c.startswith("org_share_")]
    out[keep].sort_values(["panel", "cluster", "announce"]).to_csv(OUT_CSV, index=False)
    baskets = {"as_of": as_of.isoformat(), "export_from": df["event_date"].min().date().isoformat(),
               "panel": {"draw": int(len(draw)), "legacy": int(len(legacy)), "clock": int((draw.dates_source == "clock").sum())},
               "features": FEATURE_BLOCKS, "k_chosen": 4, "k_robust": 2,
               "diagnostics": {int(k): {c: (None if pd.isna(v) else float(v)) for c, v in row.items()} for k, row in show.iterrows()},
               "sensitivity": {k: {c: float(v) for c, v in row.items()} for k, row in sens.iterrows()},
               "repeat_artists": {int(K): {k: v for k, v in ra.items() if k != "per_artist"} for K, ra in repeat.items()},
               "artist_consistency": {k: {c: float(v) for c, v in row.items()} for k, row in ac.iterrows()},
               "clusters": [{"id": c, "name": NAMES_K4[c], "k2": NAMES_K2[0 if c < 2 else 1],
                             **basket(s[s["cluster"] == c], X[lab4 == c], fits[4].cluster_centers_[fits[4].labels_[np.where(lab4 == c)[0][0]]])}
                            for c in range(4)],
               "legacy": {"name": "Buy-now launches before the draw mechanic", **basket(legacy, draw=False),
                          "nearest_cluster": {NAMES_K4[int(k)]: int(v) for k, v in legacy["nearest_cluster"].value_counts().items()}}}
    OUT_JSON.write_text(json.dumps(baskets, indent=1, default=str))
    print(f"\nwrote {OUT_CSV} ({len(out)} rows) and {OUT_JSON}")


if __name__ == "__main__":
    main()
