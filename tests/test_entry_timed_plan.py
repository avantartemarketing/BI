#!/usr/bin/env python3
"""Every curve-planned group's unit plan runs on the entry-timed curve (docs
§5.3, etl/build.py UNIT_PLAN_CURVE): the organic groups' plan line, their
expected-by-today and their forward path are timed by draw entries, the way
the secured-units actual counts them, not by Total_Product_Units, which books
the draw's winners on the close day. Read as demand, that booking put about a
quarter of the email and social targets on the last day and the projection
counted on it.

build_release runs on a synthetic funnel, first against a synthetic curve
panel whose units book a cliff at the close (a units-timed plan fails every
check below), then against the committed data/app/curves.json, on two
campaign clocks and two as-of days. Paid is left out: its plan is the even
daily budget, not a curve.
python3 tests/test_entry_timed_plan.py (needs pandas)"""
import sys, json, pathlib, random
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

TOL = 0.01          # a close-day plan step may exceed the entries curve's step by one point of the target
ORGANIC = [g for g in build.DISPLAY_GROUPS if g != "paid"]

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)

# ---- a curve panel whose units book the draw's winners on the close day
GROUP_CH = {"aa_email": "AA Email Man", "aa_social": "AA Meta", "referral_artist": "Referral Artist",
            "search_direct_other": "Direct", "paid": "Paid Social"}

def panel_frame(n=6):
    rows = []
    def row(rel, ch, d, dsa, LL, sess, units, entries):
        rows.append({"channel": ch, "event_date": d, "simple_release_name": rel, "campaign_stage": "Sustain 1",
                     "Sessions_Total": sess, "Total_Product_Units": units, "Product_Units_Private_Room": 0.0,
                     "Draw_Entries_Total_Units_No_Conv": 0.0, "Draw_Entries_Eligible_Units": entries,
                     "days_since_announcement": dsa, "days_until_launch": LL - dsa,
                     "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": (LL - dsa) / LL})
    start = date(2025, 1, 1)
    # the export's first day belongs to no panel release, so none is cut by the export's edge
    row("Export Edge", "Direct", start - timedelta(days=30), 0, 20, 1.0, 0.0, 0.0)
    for i in range(n):
        ann, LL, rel = start + timedelta(days=45 * i), 20 + 2 * i, f"Panel Release {i}"
        d = ann - timedelta(days=3)
        while d <= ann + timedelta(days=LL + 1):
            dsa = (d - ann).days
            live = 0 <= dsa <= LL
            for g, ch in GROUP_CH.items():
                # entries: the announce burst, an even run and a small last-day push
                e = 0.0 if not live else 30.0 if dsa == 0 else 6.0 if dsa == LL else 4.0
                # units: a few sales along the way, then the draw's winners booked at the close
                u = 0.0 if not live else 80.0 if dsa == LL else 1.0
                row(rel, ch, d, dsa, LL, 50.0 if live else 5.0, u, e)
            d += timedelta(days=1)
    return pd.DataFrame(rows)

synthetic = build.build_curves(panel_frame())
check(synthetic["n_releases"] == 6, f"the synthetic panel is clean: n={synthetic['n_releases']}")
# the units series stay as measured, paid's included: no plan is read off them
for g in build.DISPLAY_GROUPS:
    u, e = synthetic["groups"][g]["units"], synthetic["groups"][g]["entries"]
    i1 = synthetic["grid"].index(1.0)
    check(u is not None and e is not None, f"{g}: the synthetic panel shapes both curves")
    if u and e:
        check(u[i1] - u[i1 - 1] > 0.5 and e[i1] - e[i1 - 1] < 0.2,
              f"{g}: the units curve books the cliff, the entries curve does not: {u[i1] - u[i1 - 1]:.3f} vs {e[i1] - e[i1 - 1]:.3f}")
committed = json.loads((ROOT / "data/app/curves.json").read_text())

# ---- the release: Julian Schnabel's inputs under a name no feed answers to
base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["release_name"] = "Synthetic Artist · Synthetic Work · 2026 Q3"
base["campaign_name"] = "Synthetic · Enter draw"
base["campaign_names"] = [base["campaign_name"]]
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

def frame(cfg, through, part=1.0):
    ann, lau = date.fromisoformat(cfg["announce_date"]), date.fromisoformat(cfg["launch_end"])
    d, LL, rows, rnd = min(date.fromisoformat(cfg["private_room_open"]), ann), (lau - ann).days, [], random.Random(7)
    while d <= through:
        share = part if d == through else 1.0
        dsa, dul = (d - ann).days, (lau - d).days
        for ch, sess, ent in CH:
            s, e = sess * share * (1 + 0.1 * rnd.random()), ent * share
            rows.append({"channel": ch, "event_date": d, "simple_release_name": cfg["release_name"],
                         "campaign_stage": "launch", "Sessions_Total": s, "Total_Product_Units": e * 0.3,
                         "Product_Units_Private_Room": 0.0, "Draw_Entries_Total_Units_No_Conv": e * 0.7,
                         "Draw_Entries_Eligible_Units": e, "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(cfg, through, part=1.0):
    rows, d = [], date.fromisoformat(cfg["announce_date"])
    while d <= through:
        rows.append({"campaign_name": cfg["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 500.0 * (part if d == through else 1.0)})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()

def run(cfg, curves, today, part):
    # the basket's own curves come back empty on a synthetic funnel and fall
    # back to the pooled panel handed in; the cache would keep the last one
    build._BASKET_CURVES.clear()
    full = today if part >= 1.0 else today - timedelta(days=1)
    snap = build.build_release(cfg, frame(cfg, today, part), spend_frame(cfg, today, part), emails, content, curves,
                               today, artist_posts, {}, None, panel, people, full_through=full, seen=part)
    build.check_snapshot(snap)
    return snap

def verify(tag, snap, curves):
    ann, lau = date.fromisoformat(snap["windowStart"]), date.fromisoformat(snap["windowEnd"])
    L = (lau - ann).days
    pdsa = lambda d: (d - ann).days / L
    ent = lambda g, p: build.curve_value(curves, g, "entries", p)
    as_of, seen = date.fromisoformat(snap["asOf"]), float(snap["asOfFraction"])
    p_today = max(pdsa(min(as_of, lau)) - (1 - seen) / L, 0.0) if as_of <= lau else pdsa(lau)
    K = float(snap["benchmark"]["k"])
    last, prev = lau.isoformat(), (lau - timedelta(days=1)).isoformat()
    for c in snap["channels"]:
        g, T, bm = c["key"], float(c["target"]), float(c.get("bm") or 0)
        rows = {r["date"]: r for r in c["daily"]}
        # the benchmark x K identity holds on every day, paid included
        for r in c["daily"]:
            check(abs(r["plan"] - r["bm"] * K) <= 0.006 * K + 0.01, f"{tag} {g} {r['date']}: plan {r['plan']} is not bm {r['bm']} x K {K}")
        check(abs(float(c["bmExp"]) * K - float(c["exp"])) <= 0.06 * K + 0.06, f"{tag} {g}: bmExp {c['bmExp']} x K {K} is not exp {c['exp']}")
        # a target under a unit has no close-day step to read: the plan is
        # printed to a hundredth, and a basket whose median artist-referral
        # share is a few hundredths of a percent gives one
        if g == "paid" or T < 1:
            continue
        # the plan is the entries curve on every day, not the units curve
        for r in c["daily"]:
            want = bm * ent(g, pdsa(date.fromisoformat(r["date"])))
            check(abs(r["bm"] - want) <= 0.06, f"{tag} {g} {r['date']}: plan's benchmark {r['bm']} is not bm x entries curve {want:.2f}")
        # no group's close-day plan step exceeds its entries curve's step over the same day
        step = (rows[last]["plan"] - rows[prev]["plan"]) / T
        ent_step = ent(g, 1.0) - ent(g, pdsa(lau - timedelta(days=1)))
        check(step <= ent_step + TOL, f"{tag} {g}: close-day plan step {step:.3f} of target exceeds the entries curve's {ent_step:.3f}")
        # expected by today reads the same curve at today's share of the clock
        w = ent(g, p_today)
        check(abs(float(c["exp"]) - T * w) <= 0.06 + 0.06 * w * K, f"{tag} {g}: exp {c['exp']} is not target {T} x entries curve {w:.4f}")
        # the path to the close follows the entries curve from today's share
        if not snap["complete"] and w < 1:
            now, proj = float(c["now"]), float(c["proj"])
            p_step = (rows[last]["proj"] - rows[prev]["proj"]) if rows[prev]["proj"] is not None else None
            want_step = (proj - now) * (ent(g, 1.0) - max(ent(g, pdsa(lau - timedelta(days=1))), w)) / (1 - w)
            # (the channel's now and proj are rounded to 0.1 before the hero's
            # count is adopted, the path to 0.01, so the two ends can part by 0.1)
            check(abs(rows[last]["proj"] - proj) <= 0.15, f"{tag} {g}: the path ends on the projection {rows[last]['proj']} vs {proj}")
            check(p_step is None or abs(p_step - want_step) <= 0.12,
                  f"{tag} {g}: the path's close-day step {p_step} is not the entries curve's share of what is to come {want_step:.2f}")
    h = snap["hero"]
    check(abs(float(h["benchmarkToday"]) * K - float(h["expectedToday"])) <= 0.5 * K + 1.0,
          f"{tag}: hero.benchmarkToday {h['benchmarkToday']} x K {K} is not hero.expectedToday {h['expectedToday']}")
    # the paid card nets off the same organic projection the channels draw
    if not snap["complete"]:
        org = sum(float(c["proj"]) - float(c["now"]) for c in snap["channels"] if c["key"] != "paid")
        of = snap["paid"]["budget"]["organicFuture"]
        check(of is not None and abs(float(of) - org) <= 0.5, f"{tag}: paid's organic still to come {of} is not the channels' {org:.1f}")

short = dict(base)
short["launch_end"] = (date.fromisoformat(base["announce_date"]) + timedelta(days=10)).isoformat()
for label, curves in (("synthetic panel", synthetic), ("committed curves", committed)):
    for cfg, name in ((base, "24-day"), (short, "10-day")):
        ann, lau = date.fromisoformat(cfg["announce_date"]), date.fromisoformat(cfg["launch_end"])
        L = (lau - ann).days
        for today, part in ((ann + timedelta(days=L // 2), 1.0), (lau - timedelta(days=1), 0.4)):
            snap = run(cfg, curves, today, part)
            verify(f"[{label}, {name}, as of {today} x{part}]", snap, curves)

# the check has teeth: the units curve's own close-day step, which the plan
# used to read, breaks it - on every group of the synthetic panel and on the
# email and social groups of the committed one
for label, curves, groups in (("synthetic panel", synthetic, ORGANIC), ("committed curves", committed, ["aa_email", "aa_social"])):
    for g in groups:
        for L in (24, 10):
            p_prev = 1 - 1 / L
            u_step = build.curve_value(curves, g, "units", 1.0) - build.curve_value(curves, g, "units", p_prev)
            e_step = build.curve_value(curves, g, "entries", 1.0) - build.curve_value(curves, g, "entries", p_prev)
            check(u_step > e_step + TOL, f"[{label}] {g}, {L}-day clock: a units-timed plan would pass ({u_step:.3f} vs {e_step:.3f})")

print("FAILED" if failed else "ok: the unit plan is entry-timed", failed if failed else "")
sys.exit(1 if failed else 0)
