#!/usr/bin/env python3
"""Python and JS agree on the basket.

etl/baskets.py picks the basket when a release is built; shared/basketRule.mjs
picks it in the picker as someone types. They have to pick the same eight, in
the same order, at the same reach - over the real panel for every live
release, with the recency preference on and off, read on the day of the build
and on later days, and over the planned launches that only the picker sees:
an artist with history, a euro price, no price, no target, a target past
everything on file, a launch that has already closed. The live releases are
resolved the way the build resolves them (etl/build.py resolve_release: the
edition and price from legacy_economics or the products), and the basket API
(server/baskets.js resolveRelease) has to resolve them to the same figures.

A release that has closed is read at its own close: its basket is the same on
every later day and after a panel refresh brings launches that closed after
it, none of which it holds. Run:
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

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402
import build  # noqa: E402
import pricing as P  # noqa: E402

AS_OF = dt.date(2026, 9, 22)
LATER = [dt.date(2026, 10, 11), dt.date(2027, 5, 1)]   # days the as_of-anchored rule moved closed baskets on

panel = B.load_panel()
panel = panel[panel["panel"] == "draw"] if "panel" in panel.columns else panel
rows = B.candidate_rows(panel)
assert len(rows) > 20, "the draw panel is on file"

# the currency table is duplicated in the mirror: hold it to the python one
mjs = (ROOT / "shared" / "basketRule.mjs").read_text()
found = re.search(r"const RATES_TO_EUR = \{([^}]*)\}", mjs)
js_rates = {k.strip(): float(v) for k, v in (kv.split(":") for kv in found.group(1).split(","))}
assert js_rates == {k: float(v) for k, v in P.RATES_TO_EUR.items()}, (js_rates, P.RATES_TO_EUR)

# the sourced block the build writes beside the inputs: the funnel's clock and
# the Notion log's dates per release, read here the way the build reads them
sourced = json.loads((ROOT / "data" / "app" / "inputs.json").read_text()).get("sourced", {})


def resolved(r: dict) -> dict:
    src = sourced.get(r["id"]) or {}
    notion = {"name:" + r["release_name"]: src.get("notion") or {}}
    return build.resolve_release(dict(r, clock_dates=src.get("clock") or None), None, notion)


def case(name, rel, prefer_recent=True, as_of=AS_OF, extra=None):
    return {"name": name, "rel": rel, "prefer_recent": prefer_recent, "as_of": as_of, "extra": extra}


live = json.loads((ROOT / "etl" / "release_inputs.json").read_text())["releases"]
live_rel = {}
cases = []
for r in live:
    rr = resolved(r)
    rel = {"release_name": rr["release_name"], "edition_size": rr.get("edition_size"), "unit_price": rr.get("unit_price"),
           "currency": rr.get("currency") or "EUR", "artist": rr["release_name"].split("·")[0].strip(),
           "announce_date": rr.get("announce_date"), "private_room_open": rr.get("private_room_open"),
           "launch_end": rr.get("launch_end")}
    live_rel[r["id"]] = rel
    for pr in (True, False):
        cases.append(case(f"{rel['artist']} recent={pr}", rel, pr))
    for day in LATER:
        cases.append(case(f"{rel['artist']} at {day}", rel, True, day))
assert all(float(rel["edition_size"] or 0) > 0 for rel in live_rel.values()), \
    f"every live release has an edition once resolved: {[(k, v['edition_size']) for k, v in live_rel.items()]}"

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
    # closed and not on the panel: read at its launch_end, a month end, where
    # eighteen months back lands on a day February does not have
    case("closed off the panel, a month end", dict(somebody, release_name="Somebody · Closed · 2026 Q3", edition_size=300,
                                                   unit_price=900, announce_date="2026-08-01", launch_end="2026-08-31")),
    case("closed a year ago", dict(somebody, release_name="Somebody · Earlier · 2025 Q2", edition_size=300, unit_price=900,
                                   announce_date="2025-05-01", launch_end="2025-06-30")),
]

# a panel refresh after James Jean closed: a launch just like it, closed three
# weeks after it. James Jean, closed, must not take it; a launch still being
# planned, as near to it, does.
jj_name = live_rel["jamesjean_blossom_26"]["release_name"]
jj_end = pd.Timestamp(panel.loc[panel["release_name"] == jj_name, "window_end"].iloc[0])
extra = panel[panel["release_name"] == "Maurizio Cattelan · We are the Revolution · 2025 Q4"].copy()
assert len(extra) == 1, "the launch the added row is copied from is on the panel"
extra["release_name"] = "Added · Later Launch · 2026 Q3"
extra["artist"] = "Added"
extra["title"] = "Later Launch"
extra["window_start"] = jj_end - pd.Timedelta(days=40)
extra["window_end"] = jj_end + pd.Timedelta(days=21)
extra["tot_total_product_units"] = float(live_rel["jamesjean_blossom_26"]["edition_size"])
extra["unit_price_eur"] = float(live_rel["jamesjean_blossom_26"]["unit_price"])
refreshed = pd.concat([panel, extra], ignore_index=True)
refreshed_rows = B.candidate_rows(refreshed)
planned_like_jj = dict(somebody, release_name="Somebody · Like James Jean · 2026 Q4",
                       edition_size=live_rel["jamesjean_blossom_26"]["edition_size"],
                       unit_price=live_rel["jamesjean_blossom_26"]["unit_price"], launch_end="2026-12-15")
cases += [
    case("James Jean after a panel refresh", live_rel["jamesjean_blossom_26"], True, AS_OF, "refreshed"),
    case("James Jean after a panel refresh, later", live_rel["jamesjean_blossom_26"], True, LATER[1], "refreshed"),
    case("planned, after a panel refresh", planned_like_jj, True, AS_OF, "refreshed"),
]

py = []
for c in cases:
    rel = dict(c["rel"], prefer_recent=c["prefer_recent"])
    pn = refreshed if c["extra"] == "refreshed" else panel
    members, reach, on = B.similar_members(pn, rel, c["as_of"])
    py.append({"members": members, "reach": reach, "on": list(on), "own": B.own_members(pn, rel, c["as_of"])})

# eighteen months back from every day of four years, pandas' way
month_days = [d.date().isoformat() for d in pd.date_range("2025-01-01", "2028-12-31", freq="D")]
py_months = [(pd.Timestamp(d) - pd.DateOffset(months=B.RECENT_MONTHS)).date().isoformat() for d in month_days]

# the API's reading of each live release, and of each with its release-level
# figures cleared so the products carry the totals
to_resolve = [{"id": r["id"], "rec": r} for r in live] + \
             [{"id": r["id"], "rec": dict(r, legacy_economics=None)} for r in live]

js_cases = [{"name": c["name"], "preferRecent": c["prefer_recent"], "asOf": c["as_of"].isoformat(),
             **({"rows": refreshed_rows} if c["extra"] == "refreshed" else {}),
             "release": {
                 "name": c["rel"]["release_name"], "artist": c["rel"].get("artist"), "target": c["rel"].get("edition_size"),
                 "price": c["rel"].get("unit_price"), "currency": c["rel"].get("currency"),
                 "announce_date": c["rel"].get("announce_date"), "private_room_open": c["rel"].get("private_room_open"),
                 "launch_end": c["rel"].get("launch_end")}} for c in cases]
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
    json.dump({"asOf": AS_OF.isoformat(), "rows": rows, "cases": js_cases, "monthDays": month_days,
               "resolve": to_resolve}, f)
    cases_path = f.name
proc = subprocess.run(["node", str(ROOT / "tests" / "basket_parity.mjs"), "--cases", cases_path],
                      capture_output=True, text=True, cwd=ROOT)
if proc.returncode != 0 or not proc.stdout:
    print(f"could not run the JS side: {proc.stderr.strip()[:400]}")
    sys.exit(2)
out = json.loads(proc.stdout)
js = out["cases"]

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

bad_months = [(d, p, j) for d, p, j in zip(month_days, py_months, out["months"]) if p != j]
if bad_months:
    failed += 1
    print(f"PARITY the recent tier's cut-off on {len(bad_months)} day(s), e.g. {bad_months[:3]}")

for t, got in zip(to_resolve, out["resolved"]):
    want = resolved(t["rec"])
    problems = []
    if abs(float(want.get("edition_size") or 0) - float(got["edition_size"] or 0)) > 1e-9:
        problems.append(f"edition_size py {want.get('edition_size')} js {got['edition_size']}")
    if abs(float(want.get("unit_price") or 0) - float(got["unit_price"] or 0)) > 0.005:
        problems.append(f"unit_price py {want.get('unit_price')} js {got['unit_price']}")
    if (want.get("currency") or "EUR") != got["currency"]:
        problems.append(f"currency py {want.get('currency')} js {got['currency']}")
    for k in ("private_room_open", "announce_date", "launch_end"):
        if (want.get(k) or None) != got[k]:
            problems.append(f"{k} py {want.get(k)} js {got[k]}")
    if problems:
        failed += 1
        mode = "products" if t["rec"].get("legacy_economics") is None else "release-level"
        print(f"RESOLVE {t['id']} ({mode}): " + "; ".join(problems))

# and the cases mean something
by_name = {c["name"]: p for c, p in zip(cases, py)}
assert all(len(p["members"]) == B.SIMILAR_N for c, p in zip(cases, py) if c["rel"].get("edition_size")), "every targeted case fills the basket"
assert by_name["new Cattelan"]["own"] and by_name["new Cattelan"]["members"][0] == by_name["new Cattelan"]["own"][0], "the artist's own go first"
assert by_name["no target"]["members"] == [] and by_name["no price"]["on"] == ["size"], "no target is no basket; no price ranks on size"
assert by_name["past everything on file"]["reach"] > B.SCALE_MISMATCH_FACTOR, "a target past the panel reaches past the mismatch factor"
assert by_name["artist with history, far away"]["own"] == [], "an artist's launch beyond x3 is not 'own'"
assert sum(1 for t in to_resolve if t["rec"].get("legacy_economics") is None) == len(live), "the products-mode reading is exercised"

# a closed release is read at its own close: the same eight on every later day,
# and none of them closed after it
ends = dict(zip(panel["release_name"], pd.to_datetime(panel["window_end"], errors="coerce")))
closed = 0
for rid, rel in live_rel.items():
    close = ends.get(rel["release_name"])
    close = close if close is not None and pd.notna(close) else pd.Timestamp(rel["launch_end"])
    if not close < pd.Timestamp(AS_OF):
        continue
    closed += 1
    base = by_name[f"{rel['artist']} recent=True"]["members"]
    for day in LATER:
        assert by_name[f"{rel['artist']} at {day}"]["members"] == base, f"{rid}: its basket moved after it closed, by {day}"
    own = set(by_name[f"{rel['artist']} recent=True"]["own"])
    late = [m for m in base if m not in own and pd.notna(ends.get(m)) and ends[m] > close]
    assert not late, f"{rid} closed {close.date()} but holds launches that closed after it: {late}"
assert closed >= 5, f"the closed releases are exercised ({closed})"
assert by_name["James Jean after a panel refresh"]["members"] == by_name["James Jean recent=True"]["members"], \
    "a launch that closed after James Jean does not enter its basket on a panel refresh"
assert by_name["James Jean after a panel refresh, later"]["members"] == by_name["James Jean recent=True"]["members"]
assert "Added · Later Launch · 2026 Q3" in by_name["planned, after a panel refresh"]["members"], \
    "a launch still being planned takes the added launch"

print(f"ok: {len(cases)} cases, {len(month_days)} cut-off days and {len(to_resolve)} release readings, python and js agree"
      if not failed else f"{failed} case(s) disagree")
sys.exit(1 if failed else 0)
