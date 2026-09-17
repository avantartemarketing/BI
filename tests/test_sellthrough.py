#!/usr/bin/env python3
"""The per-product sell-through rule, Python side, and its parity with the JS.

Runs every fixture through etl/sellthrough.py, checks the expectations, then
runs the JS side (node tests/sellthrough_parity.mjs --json) and compares the
two outputs field by field.  python3 tests/test_sellthrough.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
from sellthrough import sell_through_products  # noqa: E402

fixtures = json.loads((ROOT / "tests" / "sellthrough_fixtures.json").read_text())


def norm(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 6)
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


failed = 0
py_results = []
for c in fixtures["cases"]:
    out = sell_through_products(c["products"], c["patterns"], rate=c["rate"], edition=c["edition"],
                                sold_total=c["soldTotal"], future_units=c["futureUnits"])
    py_results.append(out)
    got = {
        "allocated": [p["allocated"] for p in out["products"]],
        "shown": [p["shown"] for p in out["products"]],
        "oversubscribed": [p["oversubscribed"] for p in out["products"]],
        "soldAssumed": [p["soldAssumed"] for p in out["products"]],
        "room": [p["room"] for p in out["products"]],
        "flexibleEntrants": out["allocation"]["flexibleEntrants"],
        "surplusEntries": out["allocation"]["surplusEntries"],
        "unattributedSold": out["unattributedSold"],
        "measure": out["measure"],
    }
    for k, want in c["expect"].items():
        # whole numbers come out as floats here and as ints in JS; the check is on value
        if norm(got[k]) != norm(want):
            failed += 1
            print(f"FAIL {c['name']}: {k} = {got[k]}, expected {want}")

# parity with the JS reference
proc = subprocess.run(["node", str(ROOT / "tests" / "sellthrough_parity.mjs"), "--json"],
                      capture_output=True, text=True, cwd=ROOT)
if proc.returncode not in (0, 1) or not proc.stdout:
    print(f"could not run the JS side: {proc.stderr.strip()[:400]}")
    sys.exit(2)
js_results = json.loads(proc.stdout)


for c, py, js in zip(fixtures["cases"], py_results, js_results):
    a, b = norm(py), norm(js["out"])
    if a != b:
        failed += 1
        for k in sorted(set(a) | set(b)):
            if a.get(k) != b.get(k):
                print(f"PARITY {c['name']}: {k}\n  py {json.dumps(a.get(k))}\n  js {json.dumps(b.get(k))}")
print("ok: %d cases, python and js agree" % len(fixtures["cases"]) if not failed else f"{failed} failure(s)")
sys.exit(1 if failed else 0)
