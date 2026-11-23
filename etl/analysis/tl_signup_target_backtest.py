"""The signup target's backtest (docs/TL_SPEC.md §7): does the sum ask for the
signups a launch of that size gathers?

Each completed timed launch closed since 2025 with 300 or more pre-window
signups and 100 or more units is taken off the panel and read as if it were
live today: the basket is the one the live rule picks for it now (the eight
nearest on units and price, recent first), and the sum is asked how many
signups the units it sold needed. That is set against the signups it
gathered, two ways: every unit asked of the signups (the sum until 23
November 2026), and the units less the basket's median share bought by
people who never signed up (the sum since). Printed for each: the median of
sum over gathered, the middle half, the typical miss either way and the share
within 25%; then the same on the launches closed in the last year or so and
on the bigger ones, and the launch by launch figures for those.

A second reading, --at-close, gives each launch the basket it could have had
at its own close (launches that closed later left out), which is the live
rule's reading of a closed page. Its baskets are older launches, which sold
more of their units without a signup and converted their signups more often
than launches do now, so both sums read lower there.

Reads the built panel and curves only (counts, no id). Run from the repo
root after a build: python3 etl/analysis/tl_signup_target_backtest.py [--at-close]
"""
import json
import pathlib
import sys
import warnings
from datetime import date

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
warnings.filterwarnings("ignore")
import tl  # noqa: E402

SINCE, RECENT, BIG = date(2025, 1, 1), date(2025, 7, 1), 600
MIN_SIGNUPS, MIN_UNITS = 300, 100


def main() -> None:
    at_close = "--at-close" in sys.argv
    panel = pd.read_csv(tl.PANEL)
    curves = json.loads(tl.CURVES.read_text()).get("curves", {})
    panel["close_d"] = pd.to_datetime(panel["close"], utc=True, errors="coerce").dt.date
    today = date.today()
    rows = []
    for r in panel.itertuples():
        if not (r.signups >= MIN_SIGNUPS and r.units >= MIN_UNITS and r.close_d and r.close_d >= SINCE):
            continue
        size = float(r.units_target) if r.units_target == r.units_target and r.units_target > 0 else float(r.units)
        if at_close:
            pool, name = panel, r.release_name
        else:   # off the panel and under another name: a launch in flight today
            pool, name = panel[panel["release_name"] != r.release_name], f"{r.release_name} (as live)"
        rb = tl.resolve_basket(None, pool, curves, {"release_name": name, "artist": r.artist, "units_target": size, "window_hours": r.window_hours}, today)
        basket = rb["basket"]
        t = tl.tl_targets(None, float(r.units), basket["profile"], None)
        if basket["n"] < 3 or not t or not t["signup_target"]:
            continue
        rows.append({"release": r.release_name, "close": r.close_d, "units": float(r.units), "signups": float(r.signups),
                     "every unit": float(r.units) / t["purchases_per_order"] / t["signup_order_rate"], "less non-signup": t["signup_target"],
                     "own rate": r.signup_order_rate, "basket rate": t["signup_order_rate"],
                     "own non-signup": tl.nonsu_share_of(r.units_su, r.units_nonsu), "basket non-signup": t["nonsignup_share"]})
    d = pd.DataFrame(rows)

    def report(dd: pd.DataFrame, label: str) -> None:
        print(f"\n{label}: {len(dd)} launches | signup -> order {dd['own rate'].median():.3f} against the basket's {dd['basket rate'].median():.3f}"
              f" | non-signup share {dd['own non-signup'].median():.2f} against the basket's {dd['basket non-signup'].median():.2f}")
        for c in ("every unit", "less non-signup"):
            ratio = dd[c] / dd["signups"]
            le = np.log(ratio)
            print(f"  {c:16s} sum over gathered, median {ratio.median():.2f} | middle half {ratio.quantile(.25):.2f} to {ratio.quantile(.75):.2f}"
                  f" | typical miss {np.exp(le.abs().median()) - 1:.0%} | within 25%: {(le.abs() < np.log(1.25)).mean():.0%}")

    print("baskets as each launch could have had at its close" if at_close else "baskets as the live rule picks them today")
    report(d, f"closed since {SINCE.year}")
    report(d[d["close"] >= RECENT], f"closed since {RECENT:%B %Y}")
    report(d[d["units"] >= BIG], f"{BIG} units or more")
    show = d[d["units"] >= BIG].sort_values("close").copy()
    for c in ("every unit", "less non-signup"):
        show[c] = show[c].round().astype(int)
    pd.set_option("display.width", 220)
    pd.set_option("display.max_colwidth", 46)
    print()
    print(show[["release", "units", "signups", "every unit", "less non-signup", "own rate", "basket rate"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
