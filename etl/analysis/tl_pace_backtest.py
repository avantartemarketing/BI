"""The signup pace's backtest: which clock the basket's pace is read on
(docs/TL_SPEC.md 4, the pace).

Each completed timed launch on the panel is read as if it were live, on its
own clock from its announce on file to its sales open, at each tenth of that
span. The pace a basket would have given it there is compared with the share
of its pre-window signups it had in fact taken, on three clocks:

  days     the basket's median share at the same number of days to the open
           (the rule until 16 November 2026)
  file     the basket's median share at the same share of each member's own
           announce -> open span, the announce as it is on file (the LE
           pages' clock, docs/METHODOLOGY.md 5)
  started  the same, a member's span starting on the later of its announce on
           file and the day its signups began (the first day with
           TL_ANNOUNCE_MIN or more, decision 17's rule): an announce on file
           weeks before any signup arrived does not stretch the clock. This
           is the build's rule (etl/tl.py pace_days, pace_curve)

against two baskets a launch could have had: every other launch on the panel,
and the eight nearest on pre-window signups among them. Printed: the mean and
median absolute gap between the pace and the launch's own share, over all the
readings and by how the launch's own lead compares with its basket's, and how
often the pace had not started (under 5%) where the launch had taken a fifth
or more of its signups: the reading that printed +12275% on a page.

Reads the built panel and curves (data/app/tl_panel.csv, tl_curves.json).
Aggregates only. Run from the repo root after a build:
python3 etl/analysis/tl_pace_backtest.py
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import tl  # noqa: E402

FRACS = [round(0.1 * i, 1) for i in range(1, 10)]
NEAREST = 8


def share_at(curve: list, dto: float) -> float:
    """A member's cumulative share at `dto` days to its open (negative before it), read between the days."""
    x = min(max(dto + tl.TL_CURVE_DAYS, 0.0), float(len(curve) - 1))
    i = int(np.floor(x))
    j = min(i + 1, len(curve) - 1)
    return float(curve[i]) + (float(curve[j]) - float(curve[i])) * (x - i)


def main():
    panel = pd.read_csv(tl.PANEL)
    curves = json.loads(tl.CURVES.read_text())["curves"]
    rows = []
    for r in panel.to_dict("records"):
        c = curves.get(r["release_name"])
        lead = tl._num(r.get("pre_days"))
        if not c or not lead or lead < 2:
            continue
        lead = min(lead, tl.TL_CURVE_DAYS)
        started = tl.pace_days(lead, c["signups_count"])   # the clock the build reads the member on
        rows.append({"name": r["release_name"], "signups": float(r["signups"]), "lead": float(lead), "started": started,
                     "curve": c["signups"]})
    print(f"{len(rows)} completed launches with an announce on file and a pace curve")
    late = [x for x in rows if x["started"] < x["lead"] - 2]
    print(f"{len(late)} of them took no signups to speak of until 3 or more days after the announce on file "
          f"(median lead on file {np.median([x['lead'] for x in late]):.0f} days, signups from {np.median([x['started'] for x in late]):.0f} days out)")

    def basket(own, kind):
        others = [x for x in rows if x["name"] != own["name"]]
        if kind == "all":
            return others
        return sorted(others, key=lambda x: abs(np.log(x["signups"] / own["signups"])))[:NEAREST]

    out = []
    for kind in ("all", "nearest"):
        for own in rows:
            members = basket(own, kind)
            m_lead = float(np.median([m["lead"] for m in members]))
            for f in FRACS:
                dto = -own["lead"] * (1 - f)
                actual = share_at(own["curve"], dto)
                pace = {
                    "days": float(np.median([share_at(m["curve"], dto) for m in members])),
                    "file": float(np.median([share_at(m["curve"], -m["lead"] * (1 - f)) for m in members])),
                    "started": float(np.median([share_at(m["curve"], -m["started"] * (1 - f)) for m in members])),
                }
                for clock, p in pace.items():
                    out.append({"basket": kind, "clock": clock, "f": f, "gap": abs(p - actual), "signed": p - actual, "actual": actual, "pace": p,
                                "lead": "longer than the basket's" if own["lead"] > m_lead * 1.25 else ("shorter" if own["lead"] < m_lead * 0.8 else "about the basket's")})
    df = pd.DataFrame(out)
    pd.set_option("display.width", 200)
    print("\nabsolute gap between the pace and the launch's own share (0 = the pace called it exactly)")
    print(df.groupby(["basket", "clock"])["gap"].agg(["mean", "median"]).round(3).to_string())
    print("\nmean gap by the launch's lead against its basket's")
    print(df.groupby(["basket", "lead", "clock"])["gap"].mean().round(3).unstack("clock").to_string())
    print("\nmean signed gap (pace minus actual: below 0 the pace runs behind the launch)")
    print(df.groupby(["basket", "lead", "clock"])["signed"].mean().round(3).unstack("clock").to_string())
    blind = df[df["actual"] >= 0.2].assign(blind=lambda d: d["pace"] < 0.05)
    print("\nshare of readings where the launch had a fifth of its signups and the pace had not started (under 5%)")
    print(blind.groupby(["basket", "clock"])["blind"].mean().round(3).to_string())


if __name__ == "__main__":
    main()
