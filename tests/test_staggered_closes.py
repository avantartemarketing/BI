#!/usr/bin/env python3
"""A launch whose works close on different days, and a date that moved
(docs/DATA_MODEL.md 1.6, 1.7).

The build runs a release to its last close and carries each work's own
(product_closes, snapshot `closes`, the sidebar's row), says beside a date
in force what Airtable or the funnel's clock now puts elsewhere
(date_drift, snapshot `dateDrift`), and lists a staggered launch Airtable
knows once, with a note, rather than as two pages.
python3 tests/test_staggered_closes.py (needs pandas)"""
import pathlib
import sys
from datetime import date

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402
import pricing  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


def product(pid, name, edition, close, price=750.0):
    return {"airtable_id": str(pid), "project_code": f"X-{pid}", "title": name, "name": name, "release": "StaggerTL26", "currency": "EUR",
            "framing": None, "launch_type": "Draw", "edition_type": "PE", "product_type": "Standard print", "price_status": "Confirmed",
            "launch_date": close, "announce_date": "2026-02-15", "private_room_date": None, "marketing_lead": None,
            "edition_size": float(edition), "units_target": None, "unit_price": price, "target_sellthrough": None,
            "expected_sellthrough": None, "artist_profit_per_unit": 100.0, "aa_profit_per_unit": 120.0, "aa_revenue_share": None,
            "aa_profit_share": 0.5, "frame_conversion": None, "frame_profit_per_unit": None, "edition": int(edition),
            "framing_available": True, "framing_default": True}


PRODUCTS = [product(11, "Box (Lifesize)", 100, "2026-03-10", 2500.0), product(12, "Box (Green)", 1000, "2026-03-24"),
            product(13, "Box (White)", 1000, "2026-03-24")]
BUNDLE = dict(product(15, "Box [Set of 2]", 0, "2026-03-24"), edition=None, edition_size=None)

# ---- the works' closes
closes = build.product_closes(PRODUCTS + [BUNDLE])
check([c["date"] for c in closes] == ["2026-03-10", "2026-03-24"], f"one entry per close, earliest first: {closes}")
check(closes[0]["works"] == 1 and closes[0]["names"] == ["Box (Lifesize)"] and closes[1]["works"] == 2, f"each with its works, the bundle counted on none: {closes}")
check(build.product_closes([]) == [] and build.product_closes([BUNDLE]) == [], "no sized work, no close")

# ---- the resolved release: runs to the last close, carries the works' own, says what moved
AT = {"match": "artist+window", "note": "", "products": PRODUCTS, "launch_date": "2026-03-24", "announce_date": "2026-02-15",
      "private_room_date": None, "marketing_lead": None}
real = build.pricing.release_products
build.pricing.release_products = lambda release, pricing_path=None: dict(AT)
try:
    base = {"id": "stagger_le_26", "release_name": "Stagger Maker · Multiple · 2026 Q1", "type": "LE", "campaign_code": "StaggerTL26",
            "campaign_names": ["StaggerTL26 · Enter draw"], "products": [], "legacy_economics": None}
    typed = build.resolve_release(dict(base, announce_date="2026-02-15", launch_end="2026-03-10"))
    check(typed["launch_end"] == "2026-03-10" and typed["input_sources"]["launch_end"] == "typed", "a typed close stands")
    check([c["date"] for c in typed["closes"]] == ["2026-03-10", "2026-03-24"] and typed["staggered"], f"the works' closes ride along: {typed['closes']}")
    d = typed["date_drift"]
    check(d.get("launch_end", {}).get("airtable") == "2026-03-24" and d["launch_end"]["inForce"] == "2026-03-10" and d["launch_end"]["source"] == "typed",
          f"Airtable's later close is said beside the typed one: {d}")
    check("clock" not in d.get("launch_end", {}) and "announce_date" not in d, f"nothing else moved: {d}")
    check(typed["edition_size"] == 2100 and typed["edition_total"] == 2100, f"every work is the release's: {typed['edition_size']}")
    # the funnel's clock says the same as the typed date: no drift from it; Airtable still differs
    clocked = build.resolve_release(dict(base, launch_end="2026-03-10", clock_dates={"announce_date": "2026-02-15", "launch_end": "2026-03-10", "private_room_open": "2026-02-01"}))
    cd = clocked["date_drift"].get("launch_end", {})
    check(cd.get("airtable") == "2026-03-24" and "clock" not in cd and cd.get("inForce") == "2026-03-10",
          f"a date the clock and the typing agree on drifts from Airtable alone: {clocked['date_drift']}")
    # nothing typed: Airtable's last close is the close in force, and nothing drifts
    free = build.resolve_release(dict(base))
    check(free["launch_end"] == "2026-03-24" and free["input_sources"]["launch_end"] == "airtable" and free["date_drift"] == {},
          f"without a typed date the page runs to the last close: {free['launch_end']} {free['date_drift']}")
    # typed to the last close: Airtable agrees, the clock (still on the first) is said
    moved = build.resolve_release(dict(base, launch_end="2026-03-24", clock_dates={"announce_date": "2026-02-15", "launch_end": "2026-03-10", "private_room_open": None}))
    check(moved["date_drift"]["launch_end"] == {"inForce": "2026-03-24", "source": "typed", "clock": "2026-03-10"}, f"the clock's older close is said: {moved['date_drift']}")
finally:
    build.pricing.release_products = real

# ---- the sidebar's row names both closes and a moved date
snap = {"id": "x", "artist": "Stagger Maker", "title": "Multiple", "releaseName": "Stagger Maker · Multiple · 2026 Q1", "type": "LE",
        "day": 10, "of": 37, "complete": False, "windowEnd": "2026-03-24", "hero": {"statusPct": 0.1, "ok": True, "benchmarkPct": 0.2},
        "closes": typed["closes"], "dateDrift": typed["date_drift"]}
row = build.index_row(snap, "live")
check(row["closes"] == ["2026-03-10", "2026-03-24"] and row["dateDrift"] is True, f"the row carries the closes and the drift: {row}")
one = build.index_row(dict(snap, closes=[{"date": "2026-03-24", "works": 3, "names": []}], dateDrift={}), "live")
check(one["closes"] == [] and one["dateDrift"] is False, "one close: nothing to name")

# ---- an upcoming staggered launch is listed once, dated by its last close, with a note
recs = pd.DataFrame([
    dict(airtable_id=11, artist="Stagger Maker", title="Box (Lifesize)", release="StaggerTL26", unit_price=2500.0, edition_size=100, launch_date="2026-10-14"),
    dict(airtable_id=12, artist="Stagger Maker", title="Box (Green)", release="StaggerTL26", unit_price=750.0, edition_size=1000, launch_date="2026-10-28"),
])
recs["currency"] = "EUR"
for c, v in (("launch_type", "Draw"), ("edition_type", "PE"), ("product_type", "Standard print"), ("price_status", "Confirmed"), ("project_status", "3.5. Pre-Launch")):
    recs[c] = v
recs["announce_date"] = pd.NaT
recs["private_room_date"] = pd.NaT
recs["launch_date"] = pd.to_datetime(recs["launch_date"])
recs["artist_key"] = recs["artist"].map(pricing.artist_key)
recs["title_key"] = recs["title"].map(pricing.norm)
recs["bundle"] = recs["title"].fillna("").str.contains(pricing.BUNDLE_RE) | ~(recs["edition_size"] > 0)
lf = pricing.launches(recs)
check(len(lf) == 1 and lf.iloc[0]["closes"] == ["2026-10-14", "2026-10-28"], f"one launch: {lf[['launch_date', 'closes']]}")
up = build.upcoming_releases(lf, [], date(2026, 9, 30), activity={})
check(len(up) == 1 and up[0]["launch_end"] == "2026-10-28" and up[0]["closes"] == ["2026-10-14", "2026-10-28"],
      f"listed once, to the last close: {[(u['release_name'], u['launch_end'], u.get('closes')) for u in up]}")
check("the works close on different days, 14 Oct and 28 Oct; the page runs to the last" in (up[0]["dates_note"] or ""), f"and says so: {up[0]['dates_note']}")
check(up[0]["edition_size"] == 1100 and up[0]["quarter"] == "2026 Q4", f"every work counted, the first close's quarter: {up[0]['edition_size']} {up[0]['quarter']}")
page = build.build_upcoming(up[0], date(2026, 9, 30))
check([c["date"] for c in page["closes"]] == ["2026-10-14", "2026-10-28"], "the upcoming page carries both closes for its row")

print("ok: staggered closes and moved dates" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
