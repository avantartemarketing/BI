"""How well can a launch's cost per paid entry be told in advance? The standing
backtest behind the plan's cost curve (etl/paid_cost.py, docs/METHODOLOGY.md
step 5), printed from the live panel.

Every launch in the draw panel with a reading worth scoring (20 paid entries
and EUR 500 of spend) is left out in turn and its average price per paid
entry predicted from the others: by the panel's median (what the plan fell
back to before 9 November 2026), by the nearest eight launches by price and
demand (the basket's kind of answer), and by the curve at each slope on the
grid (each launch's price brought to the reference spend, the median read
back at the held-out launch's own spend). The build runs the same backtest
on every refresh (baskets.attach_paid_costs) and keeps the slope whose
neighbourhood misses least; this script shows the whole table, and the
readings behind it.

Run from the repo root: python3 etl/analysis/cost_backtest.py
"""
import json
import pathlib
import sys

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import baskets  # noqa: E402
import build  # noqa: E402

panel = baskets.attach_paid_costs(baskets.load_panel(), build.load_spend(), build.orders_campaign_codes(), terms=build.paid_terms(build.BENCH))
t = baskets.PAID_COST
print(build.paid_cost_summary(t))
print(json.dumps({k: v for k, v in t.items() if k != "backtest"}, indent=1))
est = (t.get("backtest") or {}).get("estimators") or {}
if est:
    print("\nleave-one-out, the average price per paid entry predicted for each launch from the others:")
    print(f"  {'estimator':14} {'typical miss':>12} {'within ±50%':>12} {'within x2':>10} {'bias':>7}")
    for name, s in est.items():
        print(f"  {name:14} {'x' + format(s['typical_miss'], '.2f'):>12} {format(100 * s['within_half'], '.0f') + '%':>12} "
              f"{format(100 * s['within_double'], '.0f') + '%':>10} {s['bias']:>+7.2f}")
    print(f"  kept: slope {t['slope']} ({t['slope_source']}); best estimator on the table: {t['backtest'].get('best')}")
cols = ["release_name", "paid_spend_campaign_eur", "paid_spend_eur", "paid_entries", "cost_per_paid_entry", "cost_per_entry_ref",
        "cost_per_paid_unit", "paid_entry_to_unit"]
costed = panel[panel["cost_per_paid_entry"] > 0][cols].sort_values("cost_per_entry_ref")
pd.set_option("display.width", 250)
print(f"\n{len(costed)} launches with a reading (the backtest scores those with 20+ entries and EUR 500+):")
print(costed.round(1).to_string(index=False))
