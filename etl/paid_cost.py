#!/usr/bin/env python3
"""What a paid entry costs, as the plan prices it (docs/METHODOLOGY.md step 5,
docs/DATA_MODEL.md 4 E; 9 November 2026).

Across the panel's launches the average price of a paid entry rises with how
much the launch spent in all: a launch that spent twice as much paid about
half as much again per entry, a power law, and most of the spread between
launches is in that, not in Meta's auction price (the CPM barely moves). The
plan therefore carries a curve, not a constant:

    average price(S) = ref x ((K + S) / (K + S_ref)) ** slope

`ref` is the price of an entry at the reference spend S_ref (a typical
campaign, etl/benchmarks.json paid_cost_reference_spend), `slope` how fast
the price rises with the spend, K the wear-out's scale (cpe_wearout_k),
there so the curve stays finite at nothing spent. The entries a spend buys
are S / average(S); the budget for a number of entries is the spend that
buys them (spend_for_entries, by bisection: the function is monotone); the
price of the last entry bought is the derivative, average x (K + S) /
(K + S - slope x S).

The slope is chosen by a leave-one-out backtest over the costed panel
(`backtest`): each launch's price is predicted from the others at every
slope on a grid, and the slope whose predictions miss least is kept, between
the within-campaign wear-out (0.20, cpe_wearout, the causal floor: what a
campaign's own days show) and the cross-section's own reading (0.70). The
same backtest scores the panel's median and a basket-like nearest eight, so
every rebuild says whether the curve still earns its place; the build logs
it and the snapshot carries it. shared/paidCost.mjs mirrors the maths, and
tests/test_paid_cost.py holds the two together.
"""
from __future__ import annotations

import math

K_DEFAULT = 100.0               # etl/benchmarks.json cpe_wearout_k
REFERENCE_SPEND = 10000.0       # etl/benchmarks.json paid_cost_reference_spend
SLOPE_GRID = tuple(round(0.20 + 0.05 * i, 2) for i in range(11))   # 0.20 .. 0.70
BACKTEST_MIN_ENTRIES = 20       # a launch joins the backtest with this many paid entries ...
BACKTEST_MIN_SPEND = 500.0      # ... and this much spend: a price read from less is mostly noise
BACKTEST_MIN_ROWS = 8           # under this the backtest says nothing and the slope stays at the floor
NEAREST = 8                     # the basket-like estimator: the nearest launches by price and demand


def average_price(spend: float, ref: float, slope: float, k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND) -> float:
    """The average price of an entry over a campaign that spends `spend` in all."""
    if ref <= 0:
        return 0.0
    return ref * ((k + max(spend, 0.0)) / (k + s_ref)) ** slope


def entries_for_spend(spend: float, ref: float, slope: float, k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND) -> float:
    """The entries a spend buys: the spend over the average price it pays."""
    if spend <= 0 or ref <= 0:
        return 0.0
    return spend / average_price(spend, ref, slope, k, s_ref)


def marginal_price(spend: float, ref: float, slope: float, k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND) -> float:
    """The price of the last entry a spend buys (d spend / d entries): the
    average times (K + S) / (K + S - slope x S), which is the average over
    (1 - slope) once the spend is well past K."""
    a = average_price(spend, ref, slope, k, s_ref)
    s = max(spend, 0.0)
    denom = k + s - slope * s
    return a * (k + s) / denom if denom > 0 else a


def spend_for_entries(entries: float, ref: float, slope: float, k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND) -> float:
    """The spend that buys `entries` at the curve: the inverse of
    entries_for_spend, by bisection (shared/paidCost.mjs runs the same steps
    so the two sides agree to the cent)."""
    if entries <= 0 or ref <= 0:
        return 0.0
    hi = max(entries * ref, 1.0)
    for _ in range(200):
        if entries_for_spend(hi, ref, slope, k, s_ref) >= entries:
            break
        hi *= 2.0
    lo = 0.0
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if entries_for_spend(mid, ref, slope, k, s_ref) < entries:
            lo = mid
        else:
            hi = mid
        if hi - lo <= 1e-9 * max(hi, 1.0):
            break
    return 0.5 * (lo + hi)


def reference_price(avg_price: float, spend: float, slope: float, k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND) -> float:
    """A launch's average price brought to the reference spend: what it would
    have paid per entry had it spent S_ref, on the curve."""
    if avg_price <= 0:
        return 0.0
    return avg_price / (((k + max(spend, 0.0)) / (k + s_ref)) ** slope)


# ---------------------------------------------------------------- the backtest

def _median(xs: list[float]) -> float:
    v = sorted(float(x) for x in xs if x is not None and math.isfinite(float(x)))
    if not v:
        return 0.0
    n = len(v)
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


def _quantile(xs: list[float], q: float) -> float:
    v = sorted(xs)
    if not v:
        return 0.0
    pos = (len(v) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return v[lo] if lo == hi else v[lo] + (v[hi] - v[lo]) * (pos - lo)


def _summary(errs: list[float]) -> dict:
    """How a set of leave-one-out misses reads: errs are log(predicted) -
    log(actual). typical_miss is the median miss as a factor either way;
    within_half the share of launches predicted within +/-50%, within_double
    within a factor of two; bias the median signed miss (positive: the
    estimator runs high)."""
    a = [abs(e) for e in errs]
    m = _median(a)
    return {
        "n": len(errs),
        "median_abs_log": round(m, 4),
        "typical_miss": round(math.exp(m), 3),
        "within_half": round(sum(1 for e in a if e < math.log(1.5)) / len(errs), 3) if errs else 0.0,
        "within_double": round(sum(1 for e in a if e < math.log(2.0)) / len(errs), 3) if errs else 0.0,
        "bias": round(_median(errs), 4),
    }


def backtest(rows: list[dict], k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND,
             grid: tuple = SLOPE_GRID, min_entries: float = BACKTEST_MIN_ENTRIES,
             min_spend: float = BACKTEST_MIN_SPEND) -> dict:
    """Leave one launch out, predict its average price per paid entry from the
    others, and score each estimator over the launches with a reading worth
    scoring (min_entries paid entries and min_spend of spend). Rows carry
    `cpe` (the average price paid), `spend` (the campaign's, to the close),
    `entries`, `price` (the unit price) and `demand` (units of demand).

    Estimators: the panel's median price (what the plan fell back to), the
    nearest NEAREST launches by price and demand (the basket's kind of
    answer), and the curve at each slope on the grid, each launch's price
    brought to the reference spend and the median of those read back at the
    held-out launch's own spend. The slope kept is the one that misses
    least (the lower on a tie); range_low and range_high are the middle half
    of actual over predicted for it, the width the tab quotes."""
    use = [r for r in rows
           if float(r.get("cpe") or 0) > 0 and float(r.get("spend") or 0) >= min_spend
           and float(r.get("entries") or 0) >= min_entries]
    out = {"n": len(use), "k": k, "reference_spend": s_ref, "grid": list(grid), "estimators": {},
           "slope": None, "range_low": None, "range_high": None, "spread": None}
    if len(use) < BACKTEST_MIN_ROWS:
        return out
    logs = [math.log(float(r["cpe"])) for r in use]

    def loo(predict) -> list[float]:
        errs = []
        for i, te in enumerate(use):
            others = use[:i] + use[i + 1:]
            errs.append(math.log(predict(others, te)) - logs[i])
        return errs

    def by_median(others, _te):
        return _median([float(r["cpe"]) for r in others])

    def by_nearest(others, te):
        lp, ld = math.log(max(float(te.get("price") or 0), 1.0)), math.log(max(float(te.get("demand") or 0), 1.0))
        ranked = sorted(others, key=lambda r: math.hypot(math.log(max(float(r.get("price") or 0), 1.0)) - lp,
                                                         math.log(max(float(r.get("demand") or 0), 1.0)) - ld))
        return _median([float(r["cpe"]) for r in ranked[:NEAREST]])

    def by_curve(slope):
        def predict(others, te):
            ref = _median([reference_price(float(r["cpe"]), float(r["spend"]), slope, k, s_ref) for r in others])
            return average_price(float(te["spend"]), ref, slope, k, s_ref)
        return predict

    errs = {"panel_median": loo(by_median), "nearest": loo(by_nearest)}
    for w in grid:
        errs[f"curve_{w:.2f}"] = loo(by_curve(w))
    out["estimators"] = {name: _summary(e) for name, e in errs.items()}
    # the slope whose neighbourhood on the grid misses least (its own score
    # averaged with its neighbours'), the lower on a tie: with a few dozen
    # launches the profile is bumpy, and a single point's dip would move the
    # slope a step each time a launch settles into the panel
    miss = {w: out["estimators"][f"curve_{w:.2f}"]["median_abs_log"] for w in grid}

    def smoothed(i: int) -> float:
        near = [miss[grid[j]] for j in (i - 1, i, i + 1) if 0 <= j < len(grid)]
        return sum(near) / len(near)

    best = grid[min(range(len(grid)), key=lambda i: (round(smoothed(i), 6), grid[i]))]
    out["slope"] = float(best)
    e = errs[f"curve_{best:.2f}"]
    # actual over predicted = exp(-err): the middle half of what the launches did against the curve
    out["range_low"] = round(math.exp(-_quantile(e, 0.75)), 3)
    out["range_high"] = round(math.exp(-_quantile(e, 0.25)), 3)
    mean = sum(e) / len(e)
    out["spread"] = round(math.sqrt(sum((x - mean) ** 2 for x in e) / max(len(e) - 1, 1)), 4)
    out["best"] = min(out["estimators"], key=lambda n: (out["estimators"][n]["median_abs_log"], n))
    return out


def panel_terms(rows: list[dict], slope: float | None = None, k: float = K_DEFAULT, s_ref: float = REFERENCE_SPEND,
                bounds: tuple = (SLOPE_GRID[0], SLOPE_GRID[-1])) -> dict:
    """The panel's terms for a release with no basket reading: the slope (the
    backtest's, or the one given, held to `bounds`), the reference price
    (the median of the backtest's launches brought to the reference spend)
    and the paid entry to unit rate (their median), with the backtest's
    results beside them. A panel too thin to backtest keeps the floor slope
    and prices nothing (reference_price 0): the constant per unit then
    stands in (build.paid_pricing)."""
    grid = tuple(w for w in SLOPE_GRID if bounds[0] - 1e-9 <= w <= bounds[1] + 1e-9) or SLOPE_GRID
    bt = backtest(rows, k, s_ref, grid) if slope is None else {"n": 0, "estimators": {}, "slope": None,
                                                                 "range_low": None, "range_high": None, "spread": None}
    w = float(slope) if slope is not None else (bt["slope"] if bt["slope"] is not None else grid[0])
    w = min(max(w, grid[0]), grid[-1])
    use = [r for r in rows
           if float(r.get("cpe") or 0) > 0 and float(r.get("spend") or 0) >= BACKTEST_MIN_SPEND
           and float(r.get("entries") or 0) >= BACKTEST_MIN_ENTRIES]
    refs = [reference_price(float(r["cpe"]), float(r["spend"]), w, k, s_ref) for r in use]
    e2u = [float(r.get("entry_to_unit") or 0) for r in use if float(r.get("entry_to_unit") or 0) > 0]
    return {
        "slope": round(w, 4), "k": float(k), "reference_spend": float(s_ref),
        "reference_price": round(_median(refs), 4) if len(use) >= BACKTEST_MIN_ROWS else 0.0,
        "entry_to_unit": round(_median(e2u), 4) if len(e2u) >= BACKTEST_MIN_ROWS else 0.0,
        "n": len(use),
        "range_low": bt.get("range_low"), "range_high": bt.get("range_high"), "spread": bt.get("spread"),
        "backtest": {kk: bt[kk] for kk in ("n", "estimators", "slope", "best") if kk in bt},
        "slope_source": "given" if slope is not None else ("backtest" if bt.get("slope") is not None else "floor"),
    }
