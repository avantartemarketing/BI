"""Where completed launches landed around the projection at close, read at
each point of their campaigns: the range the Sell-through at close card
prints (27 October 2026).

Every configured LE release whose campaign has closed is built as the
dashboard would have built it on a set of days through its run (15, 30, 45,
60, 75 and 90% of the way from the announce to the close): the funnel and
the spend cut at that day, the units feed with them, the orders feed's
totals set aside (they are the final figures and would leak the answer), so
the page reads the funnel's units at every cut and at the close alike. Each
cut's projection of what was still to come, hero.projected less hero.now,
is read against what did come, the completed build's hero.now less the
cut's. The ratio's 10th and 90th percentiles by cut are the range: where 8
in 10 launches landed. Thin panel, so the percentiles are near the ends of
what was seen; the n is published with them.

Writes etl/projection_backtest.json, which etl/build.py reads
(projection_range). Run from the repo root after the feeds are in place:
    python3 etl/analysis/projection_backtest.py
"""
from __future__ import annotations

import json
import pathlib
import sys
import time
from datetime import date, timedelta

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import baskets  # noqa: E402
import build  # noqa: E402

CUTS = (0.15, 0.30, 0.45, 0.60, 0.75, 0.90)
MIN_STILL = 5.0       # a cut whose projection of what was still to come is under this says nothing
OUT = ROOT / "etl" / "projection_backtest.json"

t0 = time.perf_counter()
at = build.load_across_time()
as_of, full_through, seen = build.observation_clock(at["event_date"].max())
spend = build.load_spend()
emails = build.load_emails()
people = build.load_people()
content = build.load_content()
artist_posts = build.load_artist_posts()
discovered = build.discover_releases(at, as_of, build.known_codes(emails, content, artist_posts))
notion = build.load_notion_campaigns()
build.resolve_inputs(discovered, spend, notion)
posts_bench = build.artist_posts_benchmarks(artist_posts, as_of)
panel = baskets.attach_paid_costs(baskets.load_panel(), spend, build.orders_campaign_codes())
curves = json.loads((ROOT / "data/app/curves.json").read_text())
email_bench = build.email_delivered_benchmark(emails, as_of, discovered, spend, at)
in_funnel = set(at["simple_release_name"].unique())
print(f"loaded in {time.perf_counter() - t0:.0f}s; data through {as_of}")

# the orders feed's totals and the draws' counts (release_products.json)
# are the final figures: set aside, so every build reads the funnel's
# entries and the units feed as it stood, and the cuts and the close are
# counted the same way (the release-level sell-through, no per-work draws)
units_all = build.load_units_feed() or {}
build.load_orders_feed = lambda: {}
build._PRODUCTS_FEED = {}


def units_through(day: date) -> None:
    """The units feed as it stood on `day`."""
    build._UNITS_FEED = {n: g[g["event_date"] <= day].reset_index(drop=True) for n, g in units_all.items()} or {}


def run(cfg: dict, day: date, rows: pd.DataFrame) -> dict:
    units_through(day)
    return build.build_release(dict(cfg), rows[rows["event_date"] <= day], spend[spend["spend_date"] <= day],
                               emails, content, curves, day, artist_posts, posts_bench, email_bench, panel, people,
                               full_through=day, seen=1.0)


records = []
done = sorted(build.le_records(build.INPUTS["releases"]), key=lambda r: r["launch_end"])
for cfg in done:
    name = cfg["release_name"]
    end = date.fromisoformat(cfg["launch_end"])
    ann = date.fromisoformat(cfg["announce_date"])
    if end + timedelta(days=build.UNITS_GRACE_DAYS) >= as_of or name not in in_funnel:
        continue
    L = (end - ann).days
    if L < 7:
        continue
    rows = at[at["simple_release_name"] == name]
    try:
        final = run(cfg, end + timedelta(days=build.UNITS_GRACE_DAYS), rows)
    except Exception as e:  # noqa: BLE001 - one launch's failure is reported, not fatal
        print(f"{cfg['id']}: the completed build failed ({e})")
        continue
    final_now = float(final["hero"]["now"])
    for f in CUTS:
        day = ann + timedelta(days=int(round(f * L)))
        if day >= end:
            continue
        try:
            snap = run(cfg, day, rows)
        except Exception as e:  # noqa: BLE001
            print(f"{cfg['id']} at {f:.0%}: failed ({e})")
            continue
        now_c, proj_c = float(snap["hero"]["now"]), float(snap["hero"]["projected"])
        still = proj_c - now_c
        came = final_now - now_c
        records.append({"id": cfg["id"], "cut": f, "day": day.isoformat(), "now": now_c, "projected": proj_c,
                        "final": final_now, "still": still, "came": came,
                        "ratio": (came / still) if still >= MIN_STILL else None})
        print(f"{cfg['id']} at {f:.0%} (day {(day - ann).days} of {L}): now {now_c:.0f}, projected {proj_c:.0f}, final {final_now:.0f}"
              + (f", ratio {came / still:.2f}" if still >= MIN_STILL else ", too little still to come"))

df = pd.DataFrame(records)
out = {"cuts": [], "lo": [], "hi": [], "median": [], "n": [], "asOf": as_of.isoformat(),
       "releases": sorted(df["id"].unique().tolist()) if len(df) else [],
       "note": "the 10th and 90th percentiles of (what came) / (what the projection said was still to come), "
               "completed configured LE releases built as of each cut with the funnel's units"}
if len(df):
    for f in CUTS:
        g = df[(df["cut"] == f) & df["ratio"].notna()]
        if len(g) < 3:
            continue
        r = g["ratio"].values
        out["cuts"].append(f)
        out["lo"].append(round(float(np.percentile(r, 10)), 3))
        out["hi"].append(round(float(np.percentile(r, 90)), 3))
        out["median"].append(round(float(np.median(r)), 3))
        out["n"].append(int(len(g)))
print("\ncut   n   10th   median   90th")
for f, lo, md, hi, n in zip(out["cuts"], out["lo"], out["median"], out["hi"], out["n"]):
    print(f"{f:.2f}  {n:2d}   {lo:5.2f}   {md:5.2f}   {hi:5.2f}")
OUT.write_text(json.dumps(out, indent=1) + "\n")
print(f"\nwrote {OUT} ({len(df)} cuts on {df['id'].nunique() if len(df) else 0} releases) in {time.perf_counter() - t0:.0f}s")
