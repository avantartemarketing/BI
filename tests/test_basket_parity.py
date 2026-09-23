#!/usr/bin/env python3
"""Python and JS agree on the basket.

etl/baskets.py picks the basket when a release is built; shared/basketRule.mjs
picks it in the picker as someone types. They have to pick the same eight, in
the same order, at the same reach - over the real panel for every live
release, with the recency preference on and off, and over the planned
launches that only the picker sees: an artist with history, a euro price, no
price, no target, a target past everything on file. Run:
  python3 tests/test_basket_parity.py
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402
import pricing as P  # noqa: E402

AS_OF = dt.date(2026, 9, 22)

panel = B.load_panel()
panel = panel[panel["panel"] == "draw"] if "panel" in panel.columns else panel
rows = B.candidate_rows(panel)
assert len(rows) > 20, "the draw panel is on file"

# the currency table is duplicated in the mirror: hold it to the python one
mjs = (ROOT / "shared" / "basketRule.mjs").read_text()
found = re.search(r"const RATES_TO_EUR = \{([^}]*)\}", mjs)
js_rates = {k.strip(): float(v) for k, v in (kv.split(":") for kv in found.group(1).split(","))}
assert js_rates == {k: float(v) for k, v in P.RATES_TO_EUR.items()}, (js_rates, P.RATES_TO_EUR)


def case(name, rel, prefer_recent=True):
    return {"name": name, "rel": rel, "prefer_recent": prefer_recent}


cases = []
for r in json.loads((ROOT / "etl" / "release_inputs.json").read_text())["releases"]:
    rel = {"release_name": r["release_name"], "edition_size": r.get("edition_size"), "unit_price": r.get("unit_price"),
           "currency": r.get("currency") or "EUR", "artist": r["release_name"].split("·")[0].strip(),
           "announce_date": r.get("announce_date"), "private_room_open": r.get("private_room_open"),
           "launch_end": r.get("launch_end")}
    for pr in (True, False):
        cases.append(case(f"{rel['artist']} recent={pr}", rel, pr))

cattelan = {"release_name": "Maurizio Cattelan · Something New · 2026 Q4", "edition_size": 600, "unit_price": 1500,
            "currency": "EUR", "artist": "Maurizio Cattelan", "announce_date": "2026-10-01"}
somebody = {"release_name": "Somebody · Piece · 2026 Q4", "artist": "Somebody", "announce_date": "2026-10-01"}
cases += [
    case("new Cattelan", cattelan),
    case("new Cattelan, recency off", cattelan, False),
    case("euro price", dict(somebody, edition_size=150, unit_price=1800, currency="EUR")),
    case("no price", dict(somebody, edition_size=150, unit_price=None)),
    case("no target", dict(somebody, edition_size=None, unit_price=1000)),
    case("past everything on file", dict(somebody, edition_size=20000, unit_price=500)),
    case("artist with history, far away", dict(cattelan, release_name="Maurizio Cattelan · Tiny · 2026 Q4", edition_size=20, unit_price=400)),
]

py = []
for c in cases:
    rel = dict(c["rel"], prefer_recent=c["prefer_recent"])
    members, reach, on = B.similar_members(panel, rel, AS_OF)
    py.append({"members": members, "reach": reach, "on": list(on), "own": B.own_members(panel, rel, AS_OF)})

js_cases = [{"name": c["name"], "preferRecent": c["prefer_recent"], "release": {
    "name": c["rel"]["release_name"], "artist": c["rel"].get("artist"), "target": c["rel"].get("edition_size"),
    "price": c["rel"].get("unit_price"), "currency": c["rel"].get("currency"),
    "announce_date": c["rel"].get("announce_date"), "private_room_open": c["rel"].get("private_room_open"),
    "launch_end": c["rel"].get("launch_end")}} for c in cases]
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
    json.dump({"asOf": AS_OF.isoformat(), "rows": rows, "cases": js_cases}, f)
    cases_path = f.name
proc = subprocess.run(["node", str(ROOT / "tests" / "basket_parity.mjs"), "--cases", cases_path],
                      capture_output=True, text=True, cwd=ROOT)
if proc.returncode != 0 or not proc.stdout:
    print(f"could not run the JS side: {proc.stderr.strip()[:400]}")
    sys.exit(2)
js = json.loads(proc.stdout)

failed = 0
for c, a, b in zip(cases, py, js):
    problems = []
    if a["members"] != b["members"]:
        problems.append(f"members\n    py {a['members']}\n    js {b['members']}")
    ra, rb = a["reach"], b["reach"]
    if (ra is None) != (rb is None) or (ra is not None and abs(ra - rb) > 1e-9):
        problems.append(f"reach py {ra} js {rb}")
    if a["on"] != b["on"]:
        problems.append(f"on py {a['on']} js {b['on']}")
    if a["own"] != b["own"]:
        problems.append(f"own py {a['own']} js {b['own']}")
    if problems:
        failed += 1
        print(f"PARITY {c['name']}: " + "; ".join(problems))

# and the cases mean something
by_name = {c["name"]: p for c, p in zip(cases, py)}
assert all(len(p["members"]) == B.SIMILAR_N for c, p in zip(cases, py) if c["rel"].get("edition_size")), "every targeted case fills the basket"
assert len(by_name["new Cattelan"]["own"]) >= 1 and by_name["new Cattelan"]["members"][0] == by_name["new Cattelan"]["own"][0], "the artist's own go first"
assert by_name["no target"]["members"] == [] and by_name["no price"]["on"] == ["size"], "no target is no basket; no price ranks on size"
assert by_name["past everything on file"]["reach"] > B.SCALE_MISMATCH_FACTOR, "a target past the panel reaches past the mismatch factor"
assert by_name["artist with history, far away"]["own"] == [], "an artist's launch beyond x3 is not 'own'"

print(f"ok: {len(cases)} cases, python and js agree" if not failed else f"{failed} case(s) disagree")
sys.exit(1 if failed else 0)
