#!/usr/bin/env python3
"""Does the edition's price predict what the benchmark reads?

The benchmark is the median of a basket of comparable launches
(docs/BENCHMARK_SPEC.md §3), and the default basket matches on edition size
and shape. With every draw launch's unit price on the panel (etl/pricing.py,
from Airtable), the question is whether "comparable" should mean comparable
in price too. This script answers it with numbers, four ways, on the dated
draw launches:

  1. Correlations of log price with each metric the benchmark reads: the
     session-to-entry conversion per channel group (conv_sess_entry_*),
     entries and units per session, oversubscription, and the paid cost per
     eligible entry where the spend feed reaches the launch.
  2. A regression of each (log) metric on log price and log units sold,
     because price and size are not independent - big editions are cheap -
     and the size band is already in the ladder. What matters is what price
     adds once size is known: the partial slope, its p-value and the gain in
     R-squared.
  3. Bands: does cutting the panel into price tertiles separate the metrics
     better than cutting it into size tertiles (eta-squared, the share of
     variance between bands)?
  4. The operational test: leave-one-out benchmark error. Every launch is
     benchmarked against the basket the ladder would give it without itself,
     with and without the price band, and the error is |log actual - log
     benchmark| per metric. A band that is a better comparable gives a
     smaller error, whatever the correlations say.

Prints everything; the verdict at the end is what docs/BENCHMARK_SPEC.md
§3.1 records and what SIMILAR_USE_PRICE in etl/baskets.py is set from.

Run from the repo root:
  python3 etl/analysis/price_probe.py
"""
from __future__ import annotations

import json
import pathlib
import sys
import warnings

import numpy as np
import pandas as pd
from scipy import stats

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402

SPEND_PATH = ROOT / "data" / "spend_daily.csv"
INPUTS_PATH = ROOT / "data" / "app" / "inputs.json"
MIN_SPEND = 100.0        # less than this inside the window is a test, not a paid campaign
MIN_PAID_ENTRIES = 5     # a cost per entry over fewer entries than this is noise
GROUPS = B.GROUPS

METRICS = {
    "entries per session": "entries_per_session",
    "units per session": "units_per_session",
    "oversubscription": "oversubscription",
    **{f"conv sess>entry {g}": f"conv_sess_entry_{g}" for g in GROUPS},
    "paid cost per entry": "cost_per_entry",
}
PREDICTORS = {"log price": "log_price", "log units sold": "log_units", "log edition size": "log_edition",
              "log launch value": "log_value"}

# the ladders compared in the leave-one-out test: (use price, rungs), each
# rung a (shape, price) pair on top of the size band that is on every rung
LADDERS = {
    "size+shape (the ladder before this change)": (False, ((True, False), (False, False))),
    "size+price+shape, price given up before shape": (True, ((True, True), (False, True), (True, False), (False, False))),
    "size+price+shape, shape given up before price": (True, ((True, True), (True, False), (False, True), (False, False))),
    "size+price, no shape": (True, ((False, True), (False, False))),
}


# ---------------------------------------------------------------- spend

def spend_in_window(panel: pd.DataFrame) -> pd.Series:
    """Meta spend inside each launch's window, from the campaigns the
    dashboard already links to the release plus any campaign whose code is
    the release's Airtable code. NaN where no campaign is linked."""
    try:
        spend = pd.read_csv(SPEND_PATH)
    except OSError:
        return pd.Series(float("nan"), index=panel.index)
    spend["spend_date"] = pd.to_datetime(spend["spend_date"], errors="coerce")
    spend["code"] = spend["campaign_name"].astype(str).str.split(" · ").str[0].str.strip().str.casefold()
    linked: dict[str, set[str]] = {}
    try:
        doc = json.loads(INPUTS_PATH.read_text())
        for rec in list((doc.get("releases") or {}).values()) + list((doc.get("discovered") or {}).values()):
            if rec.get("campaign_name"):
                linked.setdefault(str(rec.get("release_name")), set()).add(str(rec["campaign_name"]))
    except (OSError, ValueError):
        pass
    out = []
    for _, r in panel.iterrows():
        names = set(linked.get(r["release_name"], set()))
        codes = {c.strip().casefold() for c in str(r.get("airtable_release") or "").split("+") if c.strip()}
        if codes:
            names |= set(spend.loc[spend["code"].isin(codes), "campaign_name"].unique())
        if not names or pd.isna(r.get("window_start")) or pd.isna(r.get("window_end")):
            out.append(float("nan"))
            continue
        rows = spend[spend["campaign_name"].isin(names) & (spend["spend_date"] >= r["window_start"])
                     & (spend["spend_date"] <= r["window_end"])]
        out.append(float(rows["spend"].sum()) if len(rows) else float("nan"))
    return pd.Series(out, index=panel.index)


# ---------------------------------------------------------------- frame

def frame() -> pd.DataFrame:
    panel = B.load_panel().copy()
    d = panel[panel["announce"].notna() & (panel["unit_price_gbp"] > 0)].copy()
    d["spend"] = spend_in_window(d)
    paid_entries = pd.to_numeric(d["entries_paid"], errors="coerce")
    ok = (d["spend"] >= MIN_SPEND) & (paid_entries >= MIN_PAID_ENTRIES)
    d["cost_per_entry"] = (d["spend"] / paid_entries).where(ok)
    d["log_price"] = np.log(d["unit_price_gbp"])
    d["log_units"] = np.log(d["tot_total_product_units"].clip(lower=1))
    d["log_edition"] = np.log(d["edition_size"].where(d["edition_size"] > 0))
    d["log_value"] = np.log(d["launch_value_gbp"].where(d["launch_value_gbp"] > 0))
    for col in METRICS.values():
        v = pd.to_numeric(d[col], errors="coerce")
        d["log_" + col] = np.log(v.where(v > 0))
    return d


def ols(y: np.ndarray, X: np.ndarray) -> dict:
    """Plain least squares with an intercept: coefficients, standard errors,
    t p-values and R-squared."""
    n = len(y)
    A = np.column_stack([np.ones(n), X])
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ beta
    dof = n - A.shape[1]
    sigma2 = float(resid @ resid) / dof if dof > 0 else float("nan")
    cov = sigma2 * np.linalg.pinv(A.T @ A)
    se = np.sqrt(np.diag(cov))
    t = beta / se
    p = 2 * stats.t.sf(np.abs(t), dof) if dof > 0 else np.full_like(t, float("nan"))
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - float(resid @ resid) / ss_tot if ss_tot > 0 else float("nan")
    return {"beta": beta, "se": se, "p": p, "r2": r2, "n": n}


def eta_squared(y: np.ndarray, bands: np.ndarray) -> tuple[float, float]:
    """Share of variance between bands, and the one-way ANOVA p-value."""
    groups = [y[bands == b] for b in np.unique(bands)]
    grand = y.mean()
    between = sum(len(g) * (g.mean() - grand) ** 2 for g in groups)
    total = float(((y - grand) ** 2).sum())
    p = stats.f_oneway(*groups).pvalue if all(len(g) > 1 for g in groups) else float("nan")
    return (between / total if total > 0 else float("nan")), float(p)


# ---------------------------------------------------------------- the four tests

def correlations(d: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for label, col in METRICS.items():
        y = d["log_" + col]
        row = {"metric": label, "n": int(y.notna().sum())}
        for plabel, pcol in PREDICTORS.items():
            both = d[[pcol]].assign(y=y).dropna()
            if len(both) < 8:
                row[f"rho {plabel}"] = float("nan"); row[f"p {plabel}"] = float("nan")
                continue
            rho, p = stats.spearmanr(both[pcol], both["y"])
            row[f"rho {plabel}"] = float(rho); row[f"p {plabel}"] = float(p)
        rows.append(row)
    return pd.DataFrame(rows).set_index("metric")


def regressions(d: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for label, col in METRICS.items():
        both = d[["log_price", "log_units", "log_" + col]].dropna()
        if len(both) < 10:
            continue
        y = both["log_" + col].to_numpy()
        size_only = ols(y, both[["log_units"]].to_numpy())
        price_only = ols(y, both[["log_price"]].to_numpy())
        joint = ols(y, both[["log_price", "log_units"]].to_numpy())
        rows.append({
            "metric": label, "n": len(both),
            "price elasticity": joint["beta"][1], "se": joint["se"][1], "p price | size": joint["p"][1],
            "size elasticity": joint["beta"][2], "p size | price": joint["p"][2],
            "R2 size": size_only["r2"], "R2 price": price_only["r2"], "R2 both": joint["r2"],
            "dR2 from price": joint["r2"] - size_only["r2"],
        })
    return pd.DataFrame(rows).set_index("metric")


def bands(d: pd.DataFrame) -> pd.DataFrame:
    rows = []
    cuts = {"price tertiles": pd.qcut(d["log_price"], 3, labels=["low", "mid", "high"]),
            "size tertiles": pd.qcut(d["log_units"], 3, labels=["small", "mid", "large"])}
    for label, col in METRICS.items():
        y = d["log_" + col]
        row = {"metric": label}
        for blabel, cut in cuts.items():
            both = pd.DataFrame({"y": y, "b": cut}).dropna()
            if both["b"].nunique() < 2 or len(both) < 10:
                row[f"eta2 {blabel}"] = float("nan"); row[f"p {blabel}"] = float("nan")
                continue
            e2, p = eta_squared(both["y"].to_numpy(), both["b"].astype(str).to_numpy())
            row[f"eta2 {blabel}"] = e2; row[f"p {blabel}"] = p
            med = np.exp(both.groupby("b", observed=True)["y"].median())
            row[f"medians {blabel}"] = " / ".join(f"{v:.3g}" for v in med.values)
        rows.append(row)
    return pd.DataFrame(rows).set_index("metric")


def loo_errors(panel: pd.DataFrame, d: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Per ladder, the leave-one-out error of the benchmark for each metric.
    The benchmark for a launch is what the ladder would give it today with
    itself dropped (similar_members never includes the release), so this is
    exactly the number the dashboard would print for it."""
    keep_use, keep_rungs = B.SIMILAR_USE_PRICE, B.SIMILAR_RUNGS
    errors, rungs, sizes = {}, {}, {}
    per_release: dict[str, dict[str, pd.Series]] = {}
    try:
        for name, (use_price, ladder) in LADDERS.items():
            B.SIMILAR_USE_PRICE, B.SIMILAR_RUNGS = use_price, ladder
            errs = {m: [] for m in METRICS if m != "paid cost per entry"}
            on_count: dict[str, int] = {}
            ns = []
            rows_err = []
            for _, r in d.iterrows():
                rel = {"release_name": r["release_name"], "edition_size": float(r["tot_total_product_units"])}
                members, factor, on = B.similar_members(panel, rel)
                on_count[" + ".join(on) + (f" x{factor:g}" if factor else "")] = on_count.get(" + ".join(on) + (f" x{factor:g}" if factor else ""), 0) + 1
                prof = B.basket_profile(panel, members)
                ns.append(prof["n"])
                bench = {
                    "entries per session": prof["entries"] / prof["sessions"] if prof["sessions"] > 0 else 0.0,
                    "units per session": prof["units"] / prof["sessions"] if prof["sessions"] > 0 else 0.0,
                    "oversubscription": prof["entries"] / prof["units"] if prof["units"] > 0 else 0.0,
                    **{f"conv sess>entry {g}": prof["conv"][g] for g in GROUPS},
                }
                row = {"release_name": r["release_name"]}
                for m, col in METRICS.items():
                    if m == "paid cost per entry":
                        continue
                    actual = float(r[col]) if pd.notna(r[col]) else 0.0
                    e = abs(np.log(actual) - np.log(bench[m])) if actual > 0 and bench[m] > 0 else float("nan")
                    errs[m].append(e)
                    row[m] = e
                rows_err.append(row)
            errors[name] = {m: (float(np.nanmean(v)), float(np.nanmedian(v)), int(np.sum(~np.isnan(v)))) for m, v in errs.items()}
            rungs[name] = on_count
            sizes[name] = (float(np.median(ns)), float(np.mean(ns)))
            per_release[name] = pd.DataFrame(rows_err).set_index("release_name")
    finally:
        B.SIMILAR_USE_PRICE, B.SIMILAR_RUNGS = keep_use, keep_rungs
    tab = pd.DataFrame({name: {f"{m} mean": v[0] for m, v in e.items()} | {f"{m} median": v[1] for m, v in e.items()}
                        for name, e in errors.items()})
    tab.loc["basket size (median, mean)"] = [f"{sizes[n][0]:.0f}, {sizes[n][1]:.1f}" for n in tab.columns]
    rung_tab = pd.DataFrame(rungs).fillna(0).astype(int)
    base = next(iter(LADDERS))
    paired = []
    for name in LADDERS:
        if name == base:
            continue
        for m in errors[name]:
            a, b = per_release[base][m], per_release[name][m]
            both = pd.DataFrame({"a": a, "b": b}).dropna()
            diff = both["b"] - both["a"]
            better = int((diff < -1e-9).sum()); worse = int((diff > 1e-9).sum())
            try:
                p = float(stats.wilcoxon(both["b"], both["a"]).pvalue) if (diff != 0).sum() >= 6 else float("nan")
            except ValueError:
                p = float("nan")
            paired.append({"ladder": name, "metric": m, "n": len(both), "better": better, "worse": worse,
                           "same": int(len(both) - better - worse), "mean change": float(diff.mean()), "wilcoxon p": p})
    return tab, rung_tab, pd.DataFrame(paired)


# ---------------------------------------------------------------- main

def main() -> None:
    warnings.filterwarnings("ignore")
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40); pd.set_option("display.max_rows", 200)
    panel = B.load_panel()
    d = frame()
    print(f"draw panel: {len(panel)} launches, {len(d)} dated and priced; unit price (GBP) quartiles "
          f"{d['unit_price_gbp'].quantile([0.25, 0.5, 0.75]).round(0).tolist()}, range "
          f"{d['unit_price_gbp'].min():.0f}-{d['unit_price_gbp'].max():.0f}; units sold quartiles "
          f"{d['tot_total_product_units'].quantile([0.25, 0.5, 0.75]).round(0).tolist()}")
    print(f"spend linked inside the window for {d['spend'].notna().sum()} launches, "
          f"{d['cost_per_entry'].notna().sum()} with a usable paid cost per entry (spend >= {MIN_SPEND:.0f}, "
          f"paid entries >= {MIN_PAID_ENTRIES})")
    rho, p = stats.spearmanr(d["log_price"], d["log_units"])
    print(f"price against size: Spearman rho {rho:.2f} (p {p:.2g}) between log price and log units sold - "
          f"{'big editions are cheap' if rho < -0.3 else 'price and size are loosely related'}")
    rho2, p2 = stats.spearmanr(d[["log_price", "log_edition"]].dropna()["log_price"], d[["log_price", "log_edition"]].dropna()["log_edition"])
    print(f"                    rho {rho2:.2f} (p {p2:.2g}) against Airtable's edition size")

    print("\n== 1. Spearman correlations of each metric (log) with the predictors; n per metric ==")
    c = correlations(d)
    print(c.round(3).to_string())

    print("\n== 2. log metric ~ log price + log units sold: what price adds once size is known ==")
    r = regressions(d)
    print(r.round(3).to_string())

    print("\n== 3. bands: variance between price tertiles against between size tertiles (eta2), with the "
          "band medians low/mid/high (price) and small/mid/large (size) ==")
    bt = bands(d)
    print(bt.round(3).to_string())

    print("\n== 4. leave-one-out benchmark error, |log actual - log benchmark|, by ladder ==")
    tab, rung_tab, paired = loo_errors(panel, d)
    print(tab.to_string())
    print("\nwhich rung answered, by ladder:")
    print(rung_tab.to_string())
    print("\npaired against the ladder before this change: launches whose benchmark got closer / further, "
          "mean change in the error (negative is better), Wilcoxon p:")
    print(paired.round(3).to_string(index=False))

    # ---- verdict
    conv = [m for m in r.index if m.startswith("conv") or m in ("entries per session", "units per session", "oversubscription")]
    sig = r.loc[conv]
    n_sig = int((sig["p price | size"] < 0.05).sum())
    gain = float(sig["dR2 from price"].mean())
    base = next(iter(LADDERS))
    best = paired.groupby("ladder")["mean change"].mean().sort_values()
    print("\n== verdict ==")
    print(f"price is significant once size is known (p < 0.05) for {n_sig} of {len(sig)} benchmarked metrics; "
          f"mean gain in R2 from adding price to size: {gain:.3f}")
    print("mean change in leave-one-out error against the current ladder, averaged over the metrics:")
    for name, v in best.items():
        print(f"  {v:+.3f}  {name}")
    helps = (best.iloc[0] < -0.01) and n_sig >= max(2, len(sig) // 3)
    print(f"\n{'PRICE MATTERS' if helps else 'PRICE DOES NOT HELP THE BASKET'}: "
          + ("the price band makes the benchmark closer to what launches reach, and price predicts the metrics beyond size."
             if helps else
             "whatever price correlates with on its own, the band does not bring the benchmark closer once size is matched."))


if __name__ == "__main__":
    main()
