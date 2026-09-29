#!/usr/bin/env python3
"""The benchmark's units are demand, not sales (docs/DATA_MODEL.md 4a.2).

A comparable that sold out with people left wanting reads as the demand it
had - its units sold plus what the eligible entrants left without a unit,
and the entrants whose payment failed, would have bought at the entry rate -
not as the edition it happened to have. etl/baskets.py demand_columns writes
the figures on the panel, basket_profile reads its medians off them, the
channels-off read and the paid unit's price follow, and the JS mirror agrees.
python3 tests/test_demand_benchmark.py (needs pandas and node)"""
import json
import pathlib
import subprocess
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402

G = B.GROUPS
failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def close(a, b, tol=1e-6):
    a, b = float(a), float(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


RATE = B.entry_to_order_rate()
check(0 < RATE <= 1, f"the entry rate is read from benchmarks.json: {RATE}")


def frame() -> pd.DataFrame:
    """Two launches: A sold out short, with 100 units wanted by eligible
    entrants left without one and 20 by entrants whose payment failed; B did
    not sell out, and has no people-file row (NaN) and no entry shares."""
    a = {"release_name": "A · One · 2026 Q1", "tot_total_product_units": 200.0, "tot_draw_entries_total_units_no_conv": 100.0,
         "payment_failed_units": 20.0, "tot_sessions_total": 20000.0}
    a.update({f"unit_share_{g}": s for g, s in zip(G, (0.4, 0.1, 0.1, 0.2, 0.2))})
    a.update({f"ent_share_{g}": s for g, s in zip(G, (0.2, 0.1, 0.1, 0.2, 0.4))})
    a.update({f"sess_share_{g}": s for g, s in zip(G, (0.2, 0.1, 0.1, 0.2, 0.4))})
    b = {"release_name": "B · Two · 2026 Q1", "tot_total_product_units": 150.0, "tot_draw_entries_total_units_no_conv": 0.0,
         "payment_failed_units": float("nan"), "tot_sessions_total": 10000.0}
    b.update({f"unit_share_{g}": s for g, s in zip(G, (0.5, 0.0, 0.0, 0.3, 0.2))})
    b.update({f"ent_share_{g}": float("nan") for g in G})
    b.update({f"sess_share_{g}": s for g, s in zip(G, (0.3, 0.1, 0.1, 0.2, 0.3))})
    return pd.DataFrame([a, b])


# ---- the columns
d = B.demand_columns(frame()).set_index("release_name")
a, b = d.loc["A · One · 2026 Q1"], d.loc["B · Two · 2026 Q1"]
extra_a = RATE * 120.0
check(close(a["demand_units"], 200.0 + extra_a) and close(a["units_sold"], 200.0) and close(a["unmet_units"], 100.0) and close(a["payment_failed_units"], 20.0),
      f"A's demand is its sales plus the unmet and failed units at the rate: {a['demand_units']}")
check(bool(a["sold_short"]) and not bool(b["sold_short"]), "A sold out short, B did not")
check(close(b["demand_units"], 150.0) and close(b["payment_failed_units"], 0.0), f"a launch with nothing unmet and no people-file row reads its sales: {b['demand_units']}")
check(close(a["demand_paid"], 0.2 * 200.0 + 0.4 * extra_a), f"the unmet part lands where the entries came from: paid {a['demand_paid']}")
check(close(sum(a[f"demand_{g}"] for g in G), a["demand_units"]) and close(sum(a[f"demand_share_{g}"] for g in G), 1.0),
      "the groups' demand adds up to the launch's, the shares to one")
check(all(close(b[f"demand_share_{g}"], b[f"unit_share_{g}"]) for g in G), "without entry shares, and with nothing unmet, the shares are the unit shares")

# ---- the profile
panel = B.demand_columns(frame())
prof = B.basket_profile(panel, list(panel["release_name"]))
check(close(prof["units"], np.median([200.0 + extra_a, 150.0])) and close(prof["units_sold"], 175.0) and prof["n_short"] == 1,
      f"the profile's units are the median demand, with the sales and the short count beside them: {prof['units']} {prof['units_sold']} {prof['n_short']}")
check(close(sum(prof["units_by_group"].values()), prof["units"]), "the groups' benchmark units add back to the median demand")
plain = B.basket_profile(frame(), list(panel["release_name"]))
check(close(plain["units"], 175.0) and close(plain["units_sold"], 175.0) and plain["n_short"] == 0, "a frame without the columns reads its sales as its demand")

# ---- channels off keeps the sales in step with the demand
off = B.apply_channels_off(prof, ["paid"])
check(close(off["units_sold_all"], prof["units_sold"]) and close(off["units_sold"], prof["units_sold"] * off["units"] / prof["units"]),
      f"without paid the sales scale with the demand: {off['units_sold']} of {off['units_sold_all']}")
same = B.apply_channels_off(prof, [])
check(close(same["units_sold"], prof["units_sold"]), "with nothing off the sales are the profile's")

# ---- the paid unit's price is on the paid demand
priced_panel = panel.assign(window_start=pd.Timestamp("2026-01-01"), window_end=pd.Timestamp("2026-02-01"),
                            units_paid=[40.0, 30.0])
spend = pd.DataFrame([{"campaign_name": "AAA · Enter draw", "spend_date": pd.Timestamp("2026-01-10"), "spend": 10.0 * float(a["demand_paid"])},
                      {"campaign_name": "BBB · Enter draw", "spend_date": pd.Timestamp("2026-01-10"), "spend": 300.0}])
priced = B.attach_paid_costs(priced_panel, spend, {"A · One · 2026 Q1": "AAA", "B · Two · 2026 Q1": "BBB"}).set_index("release_name")
check(close(priced.loc["A · One · 2026 Q1", "cost_per_paid_unit"], 10.0), f"A's paid unit is priced on its paid demand: {priced.loc['A · One · 2026 Q1', 'cost_per_paid_unit']}")
check(close(priced.loc["B · Two · 2026 Q1", "cost_per_paid_unit"], 300.0 / (0.2 * 150.0)), "B's on its paid units sold, which are its demand")

# ---- the picker's rows carry the figures
rows = {r["release_name"]: r for r in B.candidate_rows(priced_panel.assign(artist="A", title="t", quarter="2026 Q1", campaign_days=20, cluster=0))}
ra = rows["A · One · 2026 Q1"]
check(close(ra["units"], 200.0) and close(ra["demand"], a["demand_units"]) and ra["sold_short"] is True and close(ra["payment_failed_units"], 20.0),
      f"the candidate row keeps the sales as units and carries the demand: {ra['units']} {ra['demand']} {ra['sold_short']}")
check(close(sum(ra["demand_shares"].values()), 1.0) and rows["B · Two · 2026 Q1"]["sold_short"] is False, "the demand shares ride along, sold_short is a plain bool")

# ---- the JS mirror reads the block back the same way
snap_bm = {"unitsAll": prof["units"], "unitsSoldAll": prof["units_sold"], "nShort": prof["n_short"], "sessionsAll": prof["sessions"],
           "entriesAll": prof["entries"], "unitsP25All": prof["units_p25"], "unitsP75All": prof["units_p75"],
           "unitsByGroupAll": prof["units_by_group"], "sessionsByGroupAll": prof["sessions_by_group"], "convByGroupAll": prof["conv"],
           "unitsPerBuyer": 1.0, "costPerPurchase": 0, "costPerPurchaseN": 0, "price": 0, "priceP25": 0, "priceP75": 0, "nPriced": 0, "campaignDays": 20}
js = subprocess.run(["node", "--input-type=module", "-e",
                     "import { profileOf, applyChannelsOff } from './shared/benchmarkModel.mjs';"
                     "const bm = JSON.parse(process.argv[1]); const p = profileOf(bm); const off = applyChannelsOff(p, ['paid']);"
                     "console.log(JSON.stringify({units: p.units, units_sold: p.units_sold, n_short: p.n_short, off_units: off.units, off_units_sold: off.units_sold, off_units_sold_all: off.units_sold_all}));",
                     json.dumps(snap_bm)], capture_output=True, text=True, cwd=ROOT)
check(js.returncode == 0, f"node ran: {js.stderr[-300:]}")
if js.returncode == 0:
    got = json.loads(js.stdout)
    check(close(got["units"], prof["units"]) and close(got["units_sold"], prof["units_sold"]) and got["n_short"] == prof["n_short"],
          f"profileOf reads demand, sales and the short count: {got}")
    check(close(got["off_units"], off["units"]) and close(got["off_units_sold"], off["units_sold"]) and close(got["off_units_sold_all"], off["units_sold_all"]),
          f"applyChannelsOff scales the sales the way Python does: {got}")
old_bm = {"unitsAll": 300.0, "units": 300.0, "unitsByGroupAll": prof["units_by_group"], "sessionsByGroupAll": prof["sessions_by_group"], "convByGroupAll": prof["conv"]}
js_old = subprocess.run(["node", "--input-type=module", "-e",
                         "import { profileOf } from './shared/benchmarkModel.mjs';"
                         "const p = profileOf(JSON.parse(process.argv[1])); console.log(JSON.stringify({units_sold: p.units_sold, n_short: p.n_short}));",
                         json.dumps(old_bm)], capture_output=True, text=True, cwd=ROOT)
check(js_old.returncode == 0 and close(json.loads(js_old.stdout)["units_sold"], 300.0) and json.loads(js_old.stdout)["n_short"] == 0,
      "a snapshot built before demand reads its units as its sales")

# ---- the live panel: We are the Revolution sold out with 668 eligible entrants
# left wanting 658 units and 112 entries excluded for a failed payment
live = B.load_panel()
watr = live[live["release_name"].str.contains("We are the Revolution", na=False)]
if len(watr):
    r = watr.iloc[0]
    check(close(r["demand_units"], r["tot_total_product_units"] + RATE * (r["unmet_units"] + r["payment_failed_units"])) and bool(r["sold_short"]),
          f"the live row: sold {r['tot_total_product_units']}, unmet {r['unmet_units']}, failed {r['payment_failed_units']}, demand {r['demand_units']}")
    check(r["demand_units"] > 1.4 * r["tot_total_product_units"], f"its demand ran well past its sales: {r['demand_units']:.0f} against {r['tot_total_product_units']:.0f}")
    print(f"We are the Revolution: sold {r['tot_total_product_units']:.0f}, unmet {r['unmet_units']:.0f}, payment failed {r['payment_failed_units']:.0f}, demand {r['demand_units']:.0f}")
check(close(live["demand_units"].min(), live.loc[live["demand_units"].idxmin(), "tot_total_product_units"]) or (live["demand_units"] >= live["tot_total_product_units"] - 1e-9).all(),
      "no launch's demand is below its sales")
check(all(close(live[[f"demand_share_{g}" for g in G]].sum(axis=1).iloc[i], 1.0) for i in range(len(live))), "every launch's demand shares sum to one")

print("ok: demand benchmark" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
