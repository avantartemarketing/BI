#!/usr/bin/env python3
"""Python and JS agree on a timed launch's basket.

etl/tl.py picks the basket when a TL is built (similar_members, among the
launches of the same window length first - ready_baskets); shared/basketRule.mjs
picks it in the picker as someone types, over the rows etl/tl.py candidate_rows
writes, with the same-length filter BasketPicker.jsx applies. They have to pick
the same eight, in the same order: over the real TL panel for the live launches
(read on the build's day and on later days, with the recency preference on and
off), for every closed launch on the panel read at its own close, and for
launches being planned that only the picker sees - an artist with history, no
price, no target, a target past everything on file, a window length with too
few launches to cut by, a launch closed off the panel. Run:
  python3 tests/test_tl_basket_parity.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
from datetime import date

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import tl  # noqa: E402

if not tl.PANEL.exists() or not tl.CURVES.exists():
    print("note: no TL panel on disk - the parity check is skipped (run the build first)")
    sys.exit(0)
panel = pd.read_csv(tl.PANEL)
curves = json.loads(tl.CURVES.read_text()).get("curves", {})
rows = tl.candidate_rows(panel)
assert len(rows) > 20, "the TL panel is on file"

AS_OF = date(2026, 10, 2)
LATER = [date(2026, 12, 1), date(2027, 6, 1)]   # days the as_of-anchored rule moved closed baskets on
failed = 0


def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)


cases = []


def case(name, rel, prefer_recent=True, as_of=AS_OF):
    cases.append({"name": name, "rel": rel, "prefer_recent": prefer_recent, "as_of": as_of})


def num(v):
    v = tl._num(v)
    return v if v is not None and v > 0 else None


# the launches in flight, from their pages: read on the build's day and later
pages = sorted((ROOT / "data" / "app" / "derived").glob("*_tl.json"))
live = 0
for p in pages:
    s = json.loads(p.read_text())
    if s.get("type") != "TL" or s.get("tlState") not in ("upcoming", "signups", "window", "settling"):
        continue
    econ = s.get("economics") or {}
    rel = {"release_name": s["releaseName"], "artist": s.get("artist"), "units_target": num(econ.get("units_target")),
           "unit_price_eur": num(econ.get("unit_price_eur")), "window_hours": num(s.get("windowHours")),
           "announce_date": (s.get("windowStart") or "")[:10] or None, "launch_end": (s.get("windowClose") or "")[:10] or None}
    live += 1
    for pr in (True, False):
        case(f"{rel['artist']} recent={pr}", rel, pr)
    for day in LATER:
        case(f"{rel['artist']} at {day}", rel, True, day)
if not live:
    print("note: no TL in flight on disk - the live cases are skipped")

# every closed launch on the panel, read at its own close
for i, r in enumerate(panel.to_dict("records")):
    rel = {"release_name": str(r["release_name"]), "artist": str(r.get("artist") or ""), "units_target": num(r.get("units_target")) or num(r.get("units")),
           "unit_price_eur": num(r.get("unit_price_eur")), "window_hours": num(r.get("window_hours")),
           "announce_date": str(r.get("announce") or "")[:10] or None, "launch_end": str(r.get("close") or "")[:10] or None}
    case(f"closed {rel['release_name']}", rel)
    if i % 4 == 0:
        case(f"closed {rel['release_name']}, recency off", rel, False)
        case(f"closed {rel['release_name']} at {LATER[1]}", rel, True, LATER[1])

# launches being planned, which only the picker sees
hist = panel["artist"].astype(str).value_counts()
veteran = str(hist.index[0])
median_units = float(pd.to_numeric(panel["units"], errors="coerce").median())
median_price = float(pd.to_numeric(panel["unit_price_eur"], errors="coerce").dropna().median())
somebody = {"release_name": "Somebody · Piece · 2026 Q4", "artist": "Somebody", "announce_date": "2026-10-20", "launch_end": "2026-11-15"}
lengths = pd.to_numeric(panel["window_hours"], errors="coerce").value_counts()
thin_length = next((float(h) for h, n in lengths.items() if n < tl.TL_THIN), 36.0)
case("artist with history", {**somebody, "release_name": f"{veteran} · New · 2026 Q4", "artist": veteran, "units_target": median_units, "unit_price_eur": median_price, "window_hours": 48.0})
case("artist with history, recency off", {**somebody, "release_name": f"{veteran} · New · 2026 Q4", "artist": veteran, "units_target": median_units, "unit_price_eur": median_price, "window_hours": 48.0}, False)
case("artist with history, far away", {**somebody, "release_name": f"{veteran} · Tiny · 2026 Q4", "artist": veteran, "units_target": 12.0, "unit_price_eur": 400.0, "window_hours": 48.0})
case("euro price", {**somebody, "units_target": 300.0, "unit_price_eur": 900.0, "window_hours": 48.0})
case("no price", {**somebody, "units_target": 300.0, "unit_price_eur": None, "window_hours": 48.0})
case("no target", {**somebody, "units_target": None, "unit_price_eur": 900.0, "window_hours": 48.0})
case("past everything on file", {**somebody, "units_target": 20000.0, "unit_price_eur": 500.0, "window_hours": 48.0})
case("a thin window length", {**somebody, "units_target": 300.0, "unit_price_eur": 900.0, "window_hours": thin_length})
case("no window length", {**somebody, "units_target": 300.0, "unit_price_eur": 900.0, "window_hours": None})
case("a 24-hour launch", {**somebody, "units_target": 150.0, "unit_price_eur": 1200.0, "window_hours": 24.0})
# closed off the panel: read at its close, a month end, where eighteen months
# back lands on a day February does not have
case("closed off the panel, a month end", {**somebody, "release_name": "Somebody · Closed · 2026 Q3", "units_target": 300.0, "unit_price_eur": 900.0,
                                           "window_hours": 48.0, "announce_date": "2026-08-01", "launch_end": "2026-08-31"})
case("closed a year ago", {**somebody, "release_name": "Somebody · Earlier · 2025 Q2", "units_target": 300.0, "unit_price_eur": 900.0,
                           "window_hours": 48.0, "announce_date": "2025-05-01", "launch_end": "2025-06-30"})

py_out = []
for c in cases:
    ready = {b["id"]: b for b in tl.ready_baskets(panel, curves, {**c["rel"], "prefer_recent": c["prefer_recent"]}, c["as_of"])}
    sim = ready["similar_size"]
    py_out.append({"members": [str(m) for m in sim["members"]], "filtered": bool(c["rel"].get("window_hours")) and not sim.get("fallback")})

js_cases = [{"L": {"name": c["rel"]["release_name"], "artist": c["rel"].get("artist") or "", "target": c["rel"].get("units_target"), "price": c["rel"].get("unit_price_eur"),
                   "currency": "EUR", "announce_date": c["rel"].get("announce_date"), "private_room_open": None, "launch_end": c["rel"].get("launch_end")},
             "length_hours": c["rel"].get("window_hours"), "prefer_recent": c["prefer_recent"], "as_of": c["as_of"].isoformat()} for c in cases]
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
    json.dump(tl._json_safe({"rows": rows, "cases": js_cases}), f)
    path = f.name
res = subprocess.run(["node", str(ROOT / "tests" / "tl_basket_parity.mjs"), "--cases", path], capture_output=True, text=True, check=True)
js_out = json.loads(res.stdout)
for c, py, js in zip(cases, py_out, js_out):
    check(py["members"] == js["members"], f"{c['name']}: python {py['members']} js {js['members']}")
    check(py["filtered"] == js["filtered"], f"{c['name']}: the same-length filter python {py['filtered']} js {js['filtered']}")
# the rule's shape
by_name = {c["name"]: (py, js) for c, py, js in zip(cases, py_out, js_out)}
check(by_name["no target"][0]["members"] == [], "no target: no basket")
check(len(by_name["euro price"][0]["members"]) == tl.TL_SIMILAR_N, "a basket of eight when the panel has them")
check(by_name["a thin window length"][0]["filtered"] is False, "too few launches of the length to cut by: every length counts")
vet = by_name["artist with history"][0]["members"]
check(any(str(panel.set_index("release_name").loc[m, "artist"]) == veteran for m in vet[:1]) or not len(panel[panel["artist"] == veteran]),
      f"the artist's own earlier launches lead the basket ({veteran}: {vet[:2]})")

if failed:
    print(f"{failed} check(s) failed over {len(cases)} cases")
    sys.exit(1)
print(f"tl basket parity: ok ({len(cases)} cases, python and js agree)")
