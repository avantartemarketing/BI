#!/usr/bin/env python3
"""attach_orders (etl/sellthrough.py) on the fixtures, and its parity with
the JS side (tests/attach_orders.mjs --json).  python3 tests/test_attach_orders.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
from sellthrough import attach_orders  # noqa: E402

fixtures = json.loads((ROOT / "tests" / "attach_orders_fixtures.json").read_text())


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
py = []
for c in fixtures["cases"]:
    products, source = attach_orders(c["products"], c["orders"], c["drawProducts"], c["source"],
                                     orders_only=bool(c.get("ordersOnly")))
    py.append({"products": products, "source": source})
    got = {"names": [p["name"] for p in products], "sold": [p["sold"] for p in products],
           "drafts": [p["drafts"] for p in products], "editions": [p["edition"] for p in products], "source": source}
    for k, want in c["expect"].items():
        if norm(got[k]) != norm(want):
            failed += 1
            print(f"FAIL {c['name']}: {k} = {got[k]}, expected {want}")

proc = subprocess.run(["node", str(ROOT / "tests" / "attach_orders.mjs"), "--json"], capture_output=True, text=True, cwd=ROOT)
if proc.returncode not in (0, 1) or not proc.stdout:
    print(f"could not run the JS side: {proc.stderr.strip()[:400]}")
    sys.exit(2)
for c, a, b in zip(fixtures["cases"], py, json.loads(proc.stdout)):
    if norm(a) != norm(b["out"]):
        failed += 1
        print(f"PARITY {c['name']}: python {json.dumps(norm(a))[:300]} vs js {json.dumps(norm(b['out']))[:300]}")
print("ok: attach orders, both sides agree" if not failed else f"{failed} failure(s)")
sys.exit(1 if failed else 0)
