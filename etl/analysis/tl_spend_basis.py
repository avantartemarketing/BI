"""Which reading of a timed launch's paid spend tells what it goes on to spend a day?

A timed launch's plan-based view (etl/tl_plan.py, docs/PLAN_MODEL.md 6b) holds "today's spend" to the sales open.
Until 27 November 2026 that was the mean of the last three full days with spend; the page's Spend levels card
(etl/tl.py spend_levels) reads the last full day's. The two differed on the same page (EUR 1,376 against EUR 2,289
on Marina Abramović's launch that day, the day after its budget was raised), so the suggested paid change did
not match the card. This asks, of the launches closed so far, which of the two was the nearer guide.

For every timed launch on the panel with a campaign code and six or more days of spend before its sales open,
and every day with three days of spend behind it and two or more whole days to come: the mean daily spend over
the days still to come, against the last full day's spend and against the mean of the last three days with
spend. The error is the absolute log of predicted over actual, so half and double are as wrong as each other.

Printed on the checkout's feeds (data/spend_daily.csv, data/app/tl_panel.csv), 27 November 2026: 39 launches,
556 readings. Median error 0.27 for the last full day and 0.34 for the mean of three; the last day nearer on 32
of the 39 launches. On the day after a jump of half or more over the two days before it (71 readings, the case
that showed the difference) what followed ran 1.07 times the last day and 1.59 times the mean of three: the mean
lags a raised budget by two days. After a drop of a third or more both read high (the spend went on falling),
the last day less so; on a steady day they agree. Run from the repo root:
    python3 etl/analysis/tl_spend_basis.py
"""
from __future__ import annotations

import math
import pathlib
import statistics as st

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIN_DAYS = 6          # days of spend before the open for a launch to be read
SEEN, AHEAD = 3, 2    # days of spend behind a reading, whole days still to come


def readings() -> tuple[list[dict], int]:
    """One row per launch and day read: the last full day's spend, the mean of the last three with spend, the mean
    of the two days before, and the mean daily spend over the days still to come before the sales open."""
    panel = pd.read_csv(ROOT / "data" / "app" / "tl_panel.csv")
    spend = pd.read_csv(ROOT / "data" / "spend_daily.csv")
    spend["day"] = pd.to_datetime(spend["spend_date"]).dt.tz_localize(None).dt.normalize()
    day = lambda v: pd.Timestamp(str(v)[:10])   # noqa: E731
    rows, used = [], 0
    for _, r in panel.iterrows():
        code = str(r.get("campaign_code") or "")
        if not code or code == "nan" or pd.isna(r.get("announce")) or pd.isna(r.get("sales_open")):
            continue
        ann, opn = day(r["announce"]), day(r["sales_open"])
        own = spend[spend["campaign_name"].str.startswith(code + " ") | (spend["campaign_name"] == code)]
        own = own[(own["day"] >= ann) & (own["day"] < opn)]
        if not len(own):
            continue
        sp = own.groupby("day")["spend"].sum().reindex(pd.date_range(ann, opn - pd.Timedelta(days=1))).fillna(0.0).to_numpy()
        if (sp > 0).sum() < MIN_DAYS:
            continue
        used += 1
        for t in range(SEEN - 1, len(sp) - AHEAD):
            three = [x for x in sp[t - SEEN + 1:t + 1] if x > 0]
            actual = float(sp[t + 1:].mean())
            if sp[t] <= 0 or not three or actual <= 0:
                continue
            before = sp[t - 2:t]
            rows.append({"launch": r["release_name"], "last": float(sp[t]), "three": float(np.mean(three)), "actual": actual,
                         "before": float(before.mean()) if (before > 0).any() else 0.0})
    return rows, used


def main() -> None:
    rows, used = readings()
    err = lambda pred, act: abs(math.log(pred / act))   # noqa: E731
    for r in rows:
        r["e_last"], r["e_three"] = err(r["last"], r["actual"]), err(r["three"], r["actual"])
    print(f"timed launches read: {used} | readings: {len(rows)}")
    print(f"median error  the last full day {st.median(r['e_last'] for r in rows):.3f} | the mean of three {st.median(r['e_three'] for r in rows):.3f}")
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(r["launch"], []).append(r)
    per = [(st.mean(x["e_last"] for x in v), st.mean(x["e_three"] for x in v)) for v in by.values()]
    print(f"by launch     the last full day nearer on {sum(1 for a, b in per if a < b)} of {len(per)}")
    cases = (("the day after a jump of half or more", lambda r: r["before"] > 0 and r["last"] >= 1.5 * r["before"]),
             ("the day after a drop of a third or more", lambda r: r["before"] > 0 and r["last"] <= r["before"] / 1.5),
             ("a steady day (within a fifth)", lambda r: r["before"] > 0 and 0.8 <= r["last"] / r["before"] <= 1.2))
    for label, pick in cases:
        g = [r for r in rows if pick(r)]
        if g:
            print(f"{label}: {len(g)} readings on {len({r['launch'] for r in g})} launches | median error {st.median(r['e_last'] for r in g):.3f} against {st.median(r['e_three'] for r in g):.3f}"
                  f" | what followed ran {st.median(r['actual'] / r['last'] for r in g):.2f} times the last day, {st.median(r['actual'] / r['three'] for r in g):.2f} times the mean of three")


if __name__ == "__main__":
    main()
