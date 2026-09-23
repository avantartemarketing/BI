#!/usr/bin/env python3
"""A channel a release will not run leaves the benchmark, and JS agrees.

etl/baskets.py apply_channels_off reads a basket without the groups set aside
(BENCHMARK_SPEC 4.3) and etl/build.py benchmark_targets lifts what is left by
one even K. shared/benchmarkModel.mjs does the same for the Target setting
rail and the picker as the switches are flipped. This holds the Python to its
own arithmetic, then holds the JS to the Python, figure by figure, over the
live releases' baskets with every combination of switch that matters. Run:
  python3 tests/test_channels_off.py
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import baskets as B  # noqa: E402
import build  # noqa: E402

AS_OF = dt.date(2026, 9, 22)
GROUPS = B.GROUPS


def close(a, b, tol=1e-6):
    a, b = float(a), float(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def test_profile_without_a_channel() -> None:
    profile = {
        "units": 400.0, "sessions": 50000.0, "entries": 380.0, "units_p25": 300.0, "units_p75": 600.0,
        "units_by_group": {"aa_email": 150.0, "aa_social": 20.0, "referral_artist": 30.0, "search_direct_other": 100.0, "paid": 100.0},
        "sessions_by_group": {"aa_email": 5000.0, "aa_social": 2000.0, "referral_artist": 3000.0, "search_direct_other": 10000.0, "paid": 30000.0},
        "share_units": {"aa_email": 0.375, "aa_social": 0.05, "referral_artist": 0.075, "search_direct_other": 0.25, "paid": 0.25},
        "share_sessions": {"aa_email": 0.1, "aa_social": 0.04, "referral_artist": 0.06, "search_direct_other": 0.2, "paid": 0.6},
        "conv": {g: 0.01 for g in GROUPS}, "private_room_share": 0.2,
    }
    same = B.apply_channels_off(profile, [])
    assert same["units"] == 400.0 and same["units_all"] == 400.0 and same["channels_off"] == []
    assert same["units_by_group_all"] == profile["units_by_group"]

    off = B.apply_channels_off(profile, ["paid", "nonsense"])
    assert off["channels_off"] == ["paid"], off["channels_off"]
    assert close(off["units"], 300.0) and close(off["sessions"], 20000.0)
    assert close(off["entries"], 380.0 * 0.75) and close(off["units_p75"], 450.0)
    assert off["units_by_group"]["paid"] == 0.0 and off["sessions_by_group"]["paid"] == 0.0
    assert off["conv"]["paid"] == 0.0 and off["conv"]["aa_email"] == 0.01
    assert close(sum(off["share_units"].values()), 1.0) and off["share_units"]["paid"] == 0.0
    assert close(off["share_units"]["aa_email"], 0.5)
    assert off["units_all"] == 400.0 and off["units_by_group_all"]["paid"] == 100.0

    both = B.apply_channels_off(profile, ["referral_artist", "paid"])
    assert both["channels_off"] == ["referral_artist", "paid"]   # GROUPS order, whatever was typed
    assert close(both["units"], 270.0) and close(sum(both["units_by_group"].values()), 270.0)

    nothing = B.apply_channels_off(profile, list(GROUPS))
    assert nothing["units"] == 0.0 and all(v == 0.0 for v in nothing["share_units"].values())

    # the release input normalises the same way
    assert B.channels_off_of({"channels_off": ["paid", "paid", "x", "aa_social"]}) == ["aa_social", "paid"]
    assert B.channels_off_of({"channels_off": "paid"}) == ["paid"]
    assert B.channels_off_of({}) == [] and B.channels_off_of(None) == []
    print("profile without a channel: ok")


def live_cases():
    panel = B.load_panel()
    panel = panel[panel["panel"] == "draw"] if "panel" in panel.columns else panel
    cases = []
    for r in build.INPUTS["releases"]:
        if not r.get("edition_size") or not r.get("unit_price"):
            continue
        basket = B.resolve_basket(r.get("benchmark_basket"), panel, r, AS_OF)
        if basket["profile"]["units"] <= 0:
            continue
        for off in ([], ["paid"], ["referral_artist"], ["paid", "referral_artist"], ["aa_social", "paid"]):
            cases.append({"name": f"{r['id']} off={','.join(off) or '-'}", "release": r, "off": off, "profile": basket["profile"]})
    assert len(cases) >= 20, "the live releases are on file"
    return cases


def test_targets_without_a_channel() -> None:
    cases = live_cases()
    seen_paid_off = seen_artist_off = False
    for c in cases:
        r = dict(c["release"], channels_off=c["off"], units_per_buyer=1.25)
        prof = B.apply_channels_off(c["profile"], c["off"])
        t = build.benchmark_targets(r, prof)
        g = build.group_targets(t)
        size = float(r["edition_size"])
        assert close(sum(x["units"] for x in g.values()), size, 1e-6), c["name"]
        assert close(size / prof["units"], size / prof["units"])
        for grp in c["off"]:
            assert g[grp]["units"] == 0.0 and g[grp]["sessions"] == 0.0 and g[grp]["entries"] == 0.0, (c["name"], grp)
        if "paid" in c["off"]:
            seen_paid_off = True
            assert t["paid_units"] == 0.0 and t["paid"]["budget"] == 0.0 and t["paid_pct"] == 0.0
            assert t["paid"]["sense_check_breached"] is False
            # K is the target over what the other channels reach: larger than
            # with paid in, since the basket ran paid
            full = build.benchmark_targets(dict(r, channels_off=[]), B.apply_channels_off(c["profile"], []))
            if c["profile"]["units_by_group"]["paid"] > 0:
                assert size / prof["units"] > size / c["profile"]["units"], c["name"]
                assert t["total_sessions"] < full["total_sessions"]
        if "referral_artist" in c["off"]:
            seen_artist_off = True
            assert build.referral_artist_tier(r) == "N/A"
            assert t["per_channel"]["Referral Artist"]["purchases"] == 0.0
    assert seen_paid_off and seen_artist_off
    # there is no other model: without a basket there are no targets
    r = dict(cases[0]["release"], channels_off=["paid", "referral_artist"])
    assert build.compute_targets(r, None) is None
    assert build.compute_targets(r, {"units": 0.0}) is None
    # the private room is not split out of the organic target any more: the
    # groups' units are the whole edition and every unit is asked for as an entry
    r = dict(cases[0]["release"], units_per_buyer=1.25)
    t = build.benchmark_targets(r, B.apply_channels_off(cases[0]["profile"], []))
    assert "pr_units" not in t and "draw_units" not in t
    assert close(t["entries_target"], float(r["edition_size"]) / build.BENCH["eligible_entry_to_order"])
    assert close(sum(pc["purchases"] for pc in t["per_channel"].values()) + t["paid_units"], float(r["edition_size"]))
    # the price of a paid unit: the release's own figure, else the panel's median
    assert build.cost_per_purchase_for({}) == build.BENCH["cost_per_purchase"]["Median"]
    assert build.cost_per_purchase_for({"cost_per_purchase": 210}) == 210.0
    assert build.cost_per_purchase_for({"cpp_pick": "High"}) == build.BENCH["cost_per_purchase"]["High"]
    assert build.referral_artist_tier({"artist_posting_tier": "High"}) == "High"
    assert build.referral_artist_tier({"channel_quality_overrides": {"Referral Artist": "Low"}}) == "Low"
    assert build.referral_artist_tier({"channels_off": ["referral_artist"], "artist_posting_tier": "High"}) == "N/A"
    assert build.referral_artist_tier({}) == "Medium"
    print(f"targets without a channel: ok over {len(cases)} cases")


def test_js_agrees() -> None:
    cases = live_cases()
    payload = {
        "bench": {k: build.BENCH[k] for k in ("eligible_entry_to_order", "cost_per_purchase", "budget_sense_check_max_pct_of_launch_value")},
        "cases": [{
            "name": c["name"], "off": c["off"], "profile": c["profile"],
            "inp": {"edition_size": c["release"]["edition_size"], "unit_price": c["release"]["unit_price"],
                    "cost_per_purchase": c["release"].get("cost_per_purchase"), "units_per_buyer": 1.25},
        } for c in cases],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    res = subprocess.run(["node", str(ROOT / "tests" / "channels_off_parity.mjs"), "--cases", path],
                         capture_output=True, text=True, check=True)
    got = {r["name"]: r for r in json.loads(res.stdout)}
    bad = []
    for c in cases:
        js = got[c["name"]]
        r = dict(c["release"], channels_off=c["off"], units_per_buyer=1.25)
        prof = B.apply_channels_off(c["profile"], c["off"])
        t = build.benchmark_targets(r, prof)
        g = build.group_targets(t)
        checks = {"off": (prof["channels_off"], js["off"])}
        for key in ("units", "sessions", "entries", "units_p25", "units_p75", "units_all", "sessions_all", "entries_all"):
            checks[f"profile.{key}"] = (prof[key], js["profile"][key])
        for key in ("units_by_group", "sessions_by_group", "share_units", "share_sessions", "conv", "units_by_group_all"):
            for grp in GROUPS:
                checks[f"profile.{key}.{grp}"] = (prof[key][grp], js["profile"][key][grp])
        jt = js["targets"]
        checks["k"] = (float(r["edition_size"]) / prof["units"], jt["k"])
        for key in ("paid_units", "organic_units", "entries_target", "total_sessions", "buyers", "launch_value"):
            checks[key] = (t[key], jt[key])
        checks["paid.budget"] = (t["paid"]["budget"], jt["paid"]["budget"])
        checks["paid.pct"] = (t["paid"]["budget_pct_of_launch_value"] or 0.0, jt["paid"]["budget_pct_of_launch_value"] or 0.0)
        checks["paid.breached"] = (t["paid"]["sense_check_breached"], jt["paid"]["sense_check_breached"])
        for grp in GROUPS:
            checks[f"group.{grp}.units"] = (g[grp]["units"], jt["units_by_group"][grp])
            checks[f"group.{grp}.sessions"] = (g[grp]["sessions"], jt["sessions_by_group"][grp])
        checks["benchmark.entries"] = (prof["units"] / build.BENCH["eligible_entry_to_order"], jt["benchmark"]["entries"])
        checks["benchmark.paid_budget"] = (prof["units_by_group"]["paid"] * t["paid"]["cost_per_purchase"], jt["benchmark"]["paid_budget"])
        for key, (py, jsv) in checks.items():
            if isinstance(py, (list, bool)) or isinstance(jsv, (list, bool)):
                ok = py == jsv
            else:
                ok = close(py, jsv)
            if not ok:
                bad.append((c["name"], key, py, jsv))
    assert not bad, "\n".join(f"{n}: {k} python={p} js={j}" for n, k, p, j in bad[:12])
    print(f"js agrees: ok over {len(cases)} cases")


if __name__ == "__main__":
    test_profile_without_a_channel()
    test_targets_without_a_channel()
    test_js_agrees()
