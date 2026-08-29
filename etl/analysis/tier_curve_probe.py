#!/usr/bin/env python3
"""Probe: should the across-time curves be cohorted by channel tier?

The dashboard plans a channel's LEVEL from its quality pick (a quartile of the
historical share panel) but its SHAPE from one pooled median curve that is
tier-blind (docs/METHODOLOGY.md §5). This asks whether that is a safe
simplification or a missed signal.

Method
  1. Take the same clean panel build_curves() uses (fully observed window,
     >= 20 entries, not clipped by the export edge).
  2. Split it in half by each group's REALISED share, high vs low.
  3. Build a median curve per cohort and measure the mean absolute gap.
  4. Control for campaign-level timing by differencing each group's curve
     against that release's own all-channel curve - otherwise a release that
     simply ran early reads as a tier effect in every one of its groups.
  5. Permutation-test the gap (does a RANDOM split separate them this far?)
     and correct the family of tests with Benjamini-Hochberg FDR.

Cohorting uses realised share rather than the planner's ex-ante pick because
only 4 of the 15 clean releases have ever been through the Target setting tab.
That is consistent with how the benchmarks are defined - they are themselves
quartiles of realised shares - but it is a proxy: it asks "do releases that
ENDED UP high-share also time differently", not "does the pick predict timing".

Re-run this as the panel grows; the recommendation as of the 15-release panel
is in docs/DATA_MODEL.md §5.

Run: python3 etl/analysis/tier_curve_probe.py
"""
from __future__ import annotations

import pathlib
import random
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "etl"))
from build import (CURVE_GRID, CLEAN_EXCLUDE_STAGES, DISPLAY_GROUPS,  # noqa: E402
                   GROUP_OF, load_across_time)

MIN_UNITS_PER_RELEASE_GROUP = 10   # same guard build.py's curve_from uses
MIN_RELEASES_TO_SPLIT = 8          # 4 per cohort, curve_from's floor
N_PERMUTATIONS = 4000
FDR_Q = 0.05
SEED = 20260829
METRICS = {"units": "Total_Product_Units",
           "entries": "Draw_Entries_Eligible_Units",
           "sessions": "Sessions_Total"}


def clean_panel(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """The same 'clean, completed, fully observed' filter build_curves uses."""
    first_export = df["event_date"].min()
    d = df[~df["campaign_stage"].isin(CLEAN_EXCLUDE_STAGES)].copy()
    d = d[d["pct_days_since_announcement"].notna()]
    d["group"] = d["channel"].map(GROUP_OF)
    day = (d.groupby(["simple_release_name", "event_date"], as_index=False)
             .agg(pdsa=("pct_days_since_announcement", "first"),
                  **{k: (v, "sum") for k, v in METRICS.items()}))
    st = day.groupby("simple_release_name").agg(
        pdsa_min=("pdsa", "min"), pdsa_max=("pdsa", "max"),
        d_min=("event_date", "min"), entries=("entries", "sum"))
    clean = st[(st.pdsa_min <= 0) & (st.pdsa_max >= 1.0)
               & (st.d_min > first_export) & (st.entries >= 20)].index.tolist()
    return d, clean


def release_curve(sub: pd.DataFrame, col: str) -> list[float] | None:
    """One release's cumulative share of its own final total, on the pdsa grid."""
    total = sub[col].sum()
    if total < MIN_UNITS_PER_RELEASE_GROUP:
        return None
    s = sub.sort_values("pdsa")
    cum = s[col].cumsum() / total
    return [float(cum[s["pdsa"] <= t].iloc[-1]) if (s["pdsa"] <= t).any() else 0.0
            for t in CURVE_GRID]


def median_curve(rows: list[list[float]]) -> list[float]:
    """Pooled median, monotone and ending at 1 - exactly as build.py does."""
    med = pd.DataFrame(rows).median().tolist()
    for i in range(1, len(med)):
        med[i] = max(med[i], med[i - 1])
    top = med[-1] or 1.0
    return [min(v / top, 1.0) for v in med]


def gap_stat(a: list[float], b: list[float]) -> float:
    """Mean absolute gap between two curves over the in-campaign grid (0..1)."""
    idx = [i for i, t in enumerate(CURVE_GRID) if 0.0 <= t <= 1.0]
    return sum(abs(a[i] - b[i]) for i in idx) / len(idx)


def at(curve: list[float], p: float) -> float:
    """Interpolate a curve at one pdsa point."""
    for i in range(1, len(CURVE_GRID)):
        if p <= CURVE_GRID[i]:
            w = (p - CURVE_GRID[i - 1]) / (CURVE_GRID[i] - CURVE_GRID[i - 1])
            return curve[i - 1] + w * (curve[i] - curve[i - 1])
    return 1.0


def permutation_p(series: list[list[float]], n_hi: int, observed: float,
                  combine) -> float:
    """How often does a RANDOM split of the same releases separate them this far?"""
    rng = random.Random(SEED)
    idx = list(range(len(series)))
    hits = 0
    for _ in range(N_PERMUTATIONS):
        rng.shuffle(idx)
        a = combine([series[i] for i in idx[:n_hi]])
        b = combine([series[i] for i in idx[n_hi:]])
        if gap_stat(a, b) >= observed:
            hits += 1
    return (hits + 1) / (N_PERMUTATIONS + 1)


def collect(d: pd.DataFrame, clean: list[str]) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    w = d[d["simple_release_name"].isin(clean)]
    gday = (w.groupby(["simple_release_name", "group", "event_date"], as_index=False)
             .agg(pdsa=("pct_days_since_announcement", "first"),
                  **{k: (v, "sum") for k, v in METRICS.items()}))
    rday = (w.groupby(["simple_release_name", "event_date"], as_index=False)
             .agg(pdsa=("pct_days_since_announcement", "first"),
                  **{k: (v, "sum") for k, v in METRICS.items()}))
    totals = (w.groupby("simple_release_name")[list(METRICS.values())].sum()
                .rename(columns={v: k for k, v in METRICS.items()}))
    return gday, rday, totals


def main() -> None:
    d, clean = clean_panel(load_across_time())
    gday, rday, totals = collect(d, clean)
    plain = lambda rs: pd.DataFrame(rs).median().tolist()
    print(f"clean panel: {len(clean)} releases\n")

    tested, skipped = [], []
    for metric in METRICS:
        for g in DISPLAY_GROUPS:
            rows = []
            for r in clean:
                sub = gday[(gday["simple_release_name"] == r) & (gday["group"] == g)]
                c = release_curve(sub, metric)
                if c is None:
                    continue
                base = release_curve(rday[rday["simple_release_name"] == r], metric)
                denom = float(totals.loc[r, metric]) or 1.0
                rows.append({"share": float(sub[metric].sum()) / denom, "curve": c,
                             "rel": [x - y for x, y in zip(c, base)]})
            if len(rows) < MIN_RELEASES_TO_SPLIT:
                skipped.append((metric, g, len(rows)))
                continue
            rows.sort(key=lambda x: x["share"], reverse=True)
            n_hi = len(rows) // 2
            raw = gap_stat(median_curve([r["curve"] for r in rows[:n_hi]]),
                           median_curve([r["curve"] for r in rows[n_hi:]]))
            rel = gap_stat(plain([r["rel"] for r in rows[:n_hi]]),
                           plain([r["rel"] for r in rows[n_hi:]]))
            p = permutation_p([r["rel"] for r in rows], n_hi, rel, plain)
            tested.append({"metric": metric, "group": g, "n": len(rows),
                           "raw": raw, "gap": rel, "p": p})

    tested.sort(key=lambda r: r["p"])
    m = len(tested)
    cut = -1
    for i, r in enumerate(tested):
        if r["p"] <= (i + 1) / m * FDR_Q:
            cut = i
    print(f"cohort split by realised share, campaign-timing controlled")
    print(f"{m} tests, Benjamini-Hochberg FDR at {FDR_Q:.0%}\n")
    print(f"{'metric':>9} {'group':>21} {'n':>3} {'raw gap':>8} {'ctrl gap':>9} "
          f"{'p':>8} {'BH crit':>8}  verdict")
    for i, r in enumerate(tested):
        bh = (i + 1) / m * FDR_Q
        print(f"{r['metric']:>9} {r['group']:>21} {r['n']:>3} {r['raw']*100:7.1f} "
              f"{r['gap']*100:8.1f} {r['p']:8.4f} {bh:8.4f}  "
              f"{'SURVIVES' if i <= cut else '-'}")
    for metric, g, n in skipped:
        print(f"{metric:>9} {g:>21} {n:>3}   (too few releases carry this group - not tested)")

    print()
    if cut < 0:
        print("VERDICT: nothing survives correction - keep the pooled, tier-blind curves.")
        best = tested[0]
        print(f"         closest call: {best['group']}/{best['metric']} "
              f"(p={best['p']:.4f}, needs <= {1/m*FDR_Q:.4f})")
    else:
        print(f"VERDICT: {cut+1} split(s) survive - worth cohorting those curves.")


if __name__ == "__main__":
    main()
