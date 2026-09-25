#!/usr/bin/env python3
"""Claims still landing (docs/DATA_MODEL.md 6.3): the pull writes, per draw,
the winners who still hold an open pre-authorisation draft on the draw's
product and have no paid order for it; the build counts a draw's claims as
still landing only by how far they stand above their lowest over the last
six hours, so a claim round bridges the order table's lag and a stale draft
does not count for long. Run:
  python3 tests/test_draw_claims.py
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

HOUR = 3600
T0 = 1_790_000_000


def pull(data: pathlib.Path, at: float, claims: dict, orders_at: float | None = None) -> None:
    """One pull: the orders file and the claims file, stamped as written at `at`."""
    orders, path = data / "orders_by_product.csv", data / "draw_claims.csv"
    orders.write_text("release,product_title\n")
    lines = ["release,draw_id,product_title,claims,units"] + [f"R,{d},P {d},{n},{n}" for d, n in claims.items()]
    path.write_text("\n".join(lines) + "\n")
    os.utime(orders, (at if orders_at is None else orders_at,) * 2)
    os.utime(path, (at, at))


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        data, sources = pathlib.Path(tmp) / "data", pathlib.Path(tmp) / "sources"
        data.mkdir()
        keep = build.DATA, build.SOURCES
        build.DATA, build.SOURCES = data, sources
        try:
            assert build.load_draw_claims() == {}, "no claims file, no claims"
            # the first pull has no floor to compare with: two stale drafts count as none
            pull(data, T0, {"d1": 2})
            assert build.load_draw_claims() == {}, build.load_draw_claims()
            # an hour on, a claim round: eleven winners the order table has not caught up with
            pull(data, T0 + HOUR, {"d1": 13, "d2": 3})
            got = build.load_draw_claims()
            assert got == {"d1": 11, "d2": 3}, got
            # reading again in the same pull changes nothing (a rebuild on save)
            assert build.load_draw_claims() == got
            # the orders land: the drafts are gone, only the stale two remain
            pull(data, T0 + 2 * HOUR, {"d1": 2})
            assert build.load_draw_claims() == {}, build.load_draw_claims()
            # a failed claim leaves a draft open: it counts until it is part of the six-hour floor
            pull(data, T0 + 3 * HOUR, {"d1": 3})
            assert build.load_draw_claims() == {"d1": 1}
            pull(data, T0 + 8 * HOUR, {"d1": 3})
            assert build.load_draw_claims() == {"d1": 1}, "the floor still holds a pull with two"
            pull(data, T0 + 9 * HOUR + 1, {"d1": 3})
            assert build.load_draw_claims() == {}, "past six hours the three are the floor"
            # after a gap the lone pull has no floor but itself, and the history keeps a day, no more
            pull(data, T0 + 40 * HOUR, {"d1": 5})
            assert build.load_draw_claims() == {}, "a lone pull after a gap has no floor but itself"
            pulls = json.loads((sources / "draw_claims_history.json").read_text())["pulls"]
            assert all(T0 + 40 * HOUR - q["at"] <= 24 * HOUR for q in pulls), [q["at"] for q in pulls]
            # a claims file from another pull than the orders is not read: it would count a sale twice
            pull(data, T0 + 41 * HOUR, {"d1": 20}, orders_at=T0 + 41 * HOUR + 2 * HOUR)
            assert build.load_draw_claims() == {}, "claims and orders from different pulls"
        finally:
            build.DATA, build.SOURCES = keep
    print("ok: draw claims")


if __name__ == "__main__":
    main()
