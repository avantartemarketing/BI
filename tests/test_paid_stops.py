#!/usr/bin/env python3
"""The two stops on the paid projection (docs 5.4, 6 October 2026): the run
rate stops on the day the units it buys close the gap the organic channels
leave to the sellout, and before the first day the price of a converting
unit passes the ROI floor's; the flat run to the close is kept beside it
(ifContinued), and the same projection at the recommended spend carries the
sell-through at close the Slack update's paid line prints (atRecommended).
On the synthetic funnel frame of test_partial_day, with the edition and the
floor moved to make each stop bite.
python3 tests/test_paid_stops.py (needs pandas)"""
import sys, json, pathlib, random
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

cfg0 = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
cfg0["release_name"] = "Synthetic Artist · Synthetic Work · 2026 Q3"   # no draw or orders feed answers to this name
cfg0["campaign_name"] = "Synthetic · Enter draw"
cfg0["campaign_names"] = [cfg0["campaign_name"]]
announce, launch = date.fromisoformat(cfg0["announce_date"]), date.fromisoformat(cfg0["launch_end"])
pr_open = date.fromisoformat(cfg0["private_room_open"])
name = cfg0["release_name"]
TODAY = announce + timedelta(days=12)
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

def frame(through, part=1.0):
    rows, rnd, d = [], random.Random(7), min(pr_open, announce)
    LL = (launch - announce).days
    while d <= through:
        share = part if d == through else 1.0
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in CH:
            s, e = sess * share * (1 + 0.1 * rnd.random()), ent * share
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": s, "Total_Product_Units": e * 0.3, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": e * 0.7, "Draw_Entries_Eligible_Units": e,
                         "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(through, part=1.0, daily=500.0):
    rows, d = [], announce
    while d <= through:
        rows.append({"campaign_name": cfg0["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": daily * (part if d == through else 1.0)})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())

def run(cfg, through=TODAY, part=1.0, full_through=None, seen=1.0, daily=500.0):
    snap = build.build_release(cfg, frame(through, part), spend_frame(through, part, daily), emails, content, curves,
                               through, artist_posts, {}, None, panel, people,
                               full_through=full_through or through, seen=seen)
    build.check_snapshot(snap)
    return snap

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)
def close(a, b, tol=0.05): return a is not None and b is not None and abs(a - b) <= tol
def paid_row(snap): return next(c for c in snap["channels"] if c["key"] == "paid")
e2o = build.entry_rate(cfg0)
def with_bench(over, fn):
    """A build with benchmark terms moved (they are read live), put back after."""
    keep = {k: build.BENCH[k] for k in over}
    try:
        build.BENCH.update(over)
        return fn()
    finally:
        build.BENCH.update(keep)
def with_floor(floor, fn): return with_bench({"roi_floor": floor}, fn)
# the release resolved the way main() resolves it, so the edition can be moved
# for a case without the resolution putting the typed one back
cfg = build.resolve_release(dict(cfg0), spend_frame(TODAY), build.load_notion_campaigns())
first = (TODAY + timedelta(days=1)).isoformat()
days_left = (launch - TODAY).days

# ---- no stop: with the floor low the price never passes it and the gap is
# far from closed, so the run rate runs to the close and the flat run is the
# projection. (At the standard floor the fixture's ROI of about 1.06 puts the
# price past the floor four days out, the case tested further down.)
N = with_floor(0.5, lambda: run(cfg))
p, b = N["paid"], N["paid"]["budget"]
check(p["stops"] == {"sellout": None, "roiFloor": None, "day": None, "rule": None}, f"no stop with the floor low: {p['stops']}")
check(close(p["spendProjectedTotal"], p["spendToDate"] + b["current"] * days_left, 0.01)
      and p["ifContinued"]["spendProjectedTotal"] == p["spendProjectedTotal"],
      f"the run rate to the close, and the flat run is the projection: {p['spendProjectedTotal']} vs {p['ifContinued']}")
check(p["ifContinued"]["entriesProjected"] == p["entriesProjected"] and p["ifContinued"]["unitProjected"] == p["unitProjected"],
      f"the flat run's entries and units are the projection's: {p['ifContinued']} vs {p['entriesProjected']}, {p['unitProjected']}")
ar = p["atRecommended"]
check(ar is not None and ar["spend"] == b["recommended"] and ar["sellThrough"] is not None and 0 <= ar["sellThrough"]["pct"] <= 1,
      f"the projection at the recommended spend, with the sell-through at close: {ar}")
check((ar["unitProjected"] >= p["unitProjected"] - 0.05) == (b["recommended"] >= b["current"]),
      f"more spend, more units: {ar['unitProjected']} at {b['recommended']} vs {p['unitProjected']} at {b['current']}")
check((ar["sellThrough"]["units"] >= N["hero"]["projected"] - 0.5) == (b["recommended"] >= b["current"]),
      f"and a higher sell-through at close: {ar['sellThrough']} vs the hero's {N['hero']['projected']}")
check(ar["stops"]["day"] is None, f"at a paced-up recommendation nothing stops either: {ar['stops']} ({b['cap']})")
print(f"N: day {N['day']}/{N['of']} edition={N['edition']['target']} cur={b['current']} rec={b['recommended']} cap={b['cap']} gap={b['selloutGap']} "
      f"organic={b['organicFuture']} cpe now={b['cpeNow']} close={b['cpeAtClose']} spend={p['spendToDate']}->{p['spendProjectedTotal']} "
      f"units={p['unitsToDate']}->{p['unitProjected']} at rec={ar['sellThrough']}")

# ---- the sellout stop: an edition the run rate fills a few days before the
# close. The organic course moves with the edition (the targets do, and not
# in proportion), so the edition is found by secant steps on the gap paid is
# sized against (edition - secured - the organic course, read unclipped off
# the hero's count and the block), aiming at half of what the flat run buys
flat_units = p["ifContinued"]["unitProjected"] - p["unitsToDate"]
aim = flat_units / 2
def gap_raw(snap, E): return E - snap["hero"]["now"] - snap["paid"]["budget"]["organicFuture"]
E0 = float((N.get("edition") or {}).get("total") or N["edition"]["target"])   # the edition the gap read
pts = [(E0, gap_raw(N, E0))]
E1 = round(pts[0][0] - pts[0][1] + aim, 1)
S = None
for _ in range(5):
    cfgS = dict(cfg, edition_size=E1, edition_total=E1)   # the target the whole edition
    S = with_floor(0.5, lambda: run(cfgS))
    pts.append((E1, gap_raw(S, E1)))
    if 0.2 * flat_units < S["paid"]["budget"]["selloutGap"] < 0.8 * flat_units:
        break
    (Ea, ga), (Eb, gb) = pts[-2], pts[-1]
    E1 = round(Eb + (aim - gb) * (Ea - Eb) / (ga - gb), 1) if ga != gb else round(Eb - gb + aim, 1)
p, b = S["paid"], S["paid"]["budget"]
st = p["stops"]
print(f"S: edition={cfgS['edition_size']} gap={b['selloutGap']} organic={b['organicFuture']} stops={st} "
      f"spend={p['spendToDate']}->{p['spendProjectedTotal']} flat {p['ifContinued']['spendProjectedTotal']} "
      f"entries={p['entriesToDate']:.1f}->{p['entriesProjected']} flat {p['ifContinued']['entriesProjected']} hero proj={S['hero']['projected']} rec={b['recommended']} ({b['cap']})")
check(0 < b["selloutGap"] < flat_units, f"a gap the flat run would close: {b['selloutGap']} of {flat_units:.1f} units")
check(st["rule"] == "sellout" and st["sellout"] == st["day"] and st["roiFloor"] is None
      and TODAY < date.fromisoformat(st["day"]) < launch, f"the sellout stop, before the close: {st}")
check(close((p["entriesProjected"] - p["entriesToDate"]) * e2o, b["selloutGap"], 0.2),
      f"the units paid buys close the gap exactly: {(p['entriesProjected'] - p['entriesToDate']) * e2o:.2f} vs {b['selloutGap']}")
days_to_stop = (date.fromisoformat(st["day"]) - TODAY).days      # the stop day's spend is pro-rated
check(b["current"] * (days_to_stop - 1) < p["spendProjectedTotal"] - p["spendToDate"] <= b["current"] * days_to_stop + 0.01,
      f"the run rate to the stop, the stop day for the units still needed: {p['spendProjectedTotal'] - p['spendToDate']:.2f} over {days_to_stop} days at {b['current']}")
check(close(p["ifContinued"]["spendProjectedTotal"], p["spendToDate"] + b["current"] * days_left, 0.01)
      and p["ifContinued"]["entriesProjected"] > p["entriesProjected"] and p["ifContinued"]["unitProjected"] > p["unitProjected"],
      f"the flat run to the close beside it: {p['ifContinued']} vs {p['spendProjectedTotal']}, {p['entriesProjected']}")
check(close(S["hero"]["projected"], cfgS["edition_size"], 1.5), f"the projection at close is the sellout: {S['hero']['projected']} vs {cfgS['edition_size']}")
rows = [r for r in paid_row(S)["daily"] if r["proj"] is not None]
after = [r["proj"] for r in rows if r["date"] >= st["day"]]
check(len(after) >= 2 and max(after) - min(after) < 0.01 and all(r["proj"] <= after[0] + 0.01 for r in rows),
      f"the paid channel's path is flat after the stop: {[(r['date'], r['proj']) for r in rows][-4:]}")
check(b["cap"] == "supply" and b["recommended"] < b["current"], f"the recommendation cuts to the supply spend: {b['recommended']} ({b['cap']}) from {b['current']}")
ar = p["atRecommended"]
check(ar["stops"]["roiFloor"] is None and (ar["stops"]["day"] is None or ar["stops"]["day"] == launch.isoformat() or b["paced"]),
      f"at the recommended spend the sellout lands on the close or not at all (a paced cut earlier): {ar['stops']} paced={b['paced']}")
check(ar["sellThrough"]["pct"] <= 1 and close(ar["sellThrough"]["units"], S["hero"]["projected"], 1.5),
      f"and the sell-through at close is the sellout still: {ar['sellThrough']} vs {S['hero']['projected']}")
# ---- the gap is to the whole edition, never the target (9 October 2026):
# with the target at 80% of the same edition the organic course shrinks with
# it, and paid is still sized to the edition: the run rate stops where it
# fills the edition and the projection at close is the edition
cfgT = dict(cfgS, edition_size=round(E1 * 0.8), edition_total=E1)
T = with_floor(0.5, lambda: run(cfgT))
pt, bt = T["paid"], T["paid"]["budget"]
print(f"T: target={cfgT['edition_size']} of {cfgT['edition_total']} gap={bt['selloutGap']} organic={bt['organicFuture']} stops={pt['stops']} "
      f"hero proj={T['hero']['projected']} rec={bt['recommended']} ({bt['cap']})")
check(T["edition"]["target"] == cfgT["edition_size"] and close(float(T["edition"]["total"]), E1, 1), f"the target inside the edition: {T['edition']}")
check(close(bt["selloutGap"], gap_raw(T, E1), 1),
      f"the gap reads the whole edition: {bt['selloutGap']} vs {gap_raw(T, E1):.2f} (to the target it would be {gap_raw(T, cfgT['edition_size']):.2f})")
check(bt["selloutGap"] > gap_raw(T, cfgT["edition_size"]) + 1, "and not the target")
check(pt["stops"]["rule"] == "sellout" and close(T["hero"]["projected"], E1, 1.5),
      f"the run rate stops at the edition and the projection at close is the edition: {pt['stops']} {T['hero']['projected']} vs {E1}")
# the same on a part day: today counts for what is left of it, in the flat run
# and the stopped one alike
P = with_floor(0.5, lambda: run(cfgS, through=TODAY, part=0.4, full_through=TODAY - timedelta(days=1), seen=0.4375))
pp, pb = P["paid"], P["paid"]["budget"]
rest = (launch - (TODAY - timedelta(days=1))).days - 0.4375
check(close(pp["ifContinued"]["spendProjectedTotal"], pp["spendToDate"] + pb["current"] * rest, 0.01),
      f"part day: the flat run counts the rest of today: {pp['ifContinued']['spendProjectedTotal']} vs {pp['spendToDate'] + pb['current'] * rest:.2f}")
check(pp["stops"]["rule"] == "sellout" and pp["spendProjectedTotal"] < pp["ifContinued"]["spendProjectedTotal"]
      and pp["entriesProjected"] >= pp["entriesToDate"] - 0.05,
      f"part day: the stop, and the entries in hand kept: {pp['stops']} {pp['spendProjectedTotal']} < {pp['ifContinued']['spendProjectedTotal']}")

# ---- the ROI floor stop. A floor the price is already past stops paid now:
# nothing more is spent or bought, the recommendation is the paced cut
# (test_paid_roi), and the flat run stands beside it
F = with_floor(1000.0, lambda: run(cfg))
p, b = F["paid"], F["paid"]["budget"]
check(p["stops"]["rule"] == "roi_floor" and p["stops"]["roiFloor"] == first and p["stops"]["day"] == first and p["stops"]["sellout"] is None,
      f"a floor the price is past: paid stops now: {p['stops']}")
check(p["spendProjectedTotal"] == p["spendToDate"] and close(p["entriesProjected"], p["entriesToDate"], 0.05)
      and p["unitProjected"] == p["unitsToDate"], f"nothing more spent or bought: {p['spendProjectedTotal']} vs {p['spendToDate']}, {p['entriesProjected']} vs {p['entriesToDate']}")
check(p["ifContinued"]["spendProjectedTotal"] > p["spendToDate"] and p["ifContinued"]["unitProjected"] > p["unitProjected"],
      f"the flat run beside it: {p['ifContinued']}")
check(b["roiSpend"] == 0.0 and b["cap"] == "roi_floor" and b["paced"], f"the recommendation is the paced cut: {b['recommended']} ({b['cap']}, paced {b['paced']})")
check(p["atRecommended"]["stops"]["rule"] == "roi_floor" and p["atRecommended"]["spendProjectedTotal"] == p["spendToDate"],
      f"at the paced spend the floor still stops it now: {p['atRecommended']['stops']}")
print(f"F: cpe now={b['cpeNow']} floor's price {(1 - p['cannibalisation']) * p['profitPerUnitAA'] / (1000.0 * p['aaBudgetShare']):.2f} stops={p['stops']}")

# ---- a floor the price reaches part way to the close: the stop lands on the
# day the path's price (before the close's lift, where the floor is read)
# first passes it, the spend runs on the days before, and at the floor's own
# spend - the recommendation, unpaced when it is within 30% of today's - the
# price meets the floor on the close, so nothing stops before it. The floor is
# set from the cost path rebuilt off the block (docs 7), at a spend of 400
pN, bN = N["paid"], N["paid"]["budget"]
cost = build.CostPath(pN["l3dCpe"], bN["spendAtWindow"], bN["spentAtWindow"], bN["spentSoFar"], bN["daysLeft"],
                      bN["elasticity"], bN["wearout"], bN["wearoutK"], lift=bN["closeLift"], anchor_lift=bN["liftAtWindow"])
cpe_floor = cost.cpe_close(400.0)
floor_400 = (1 - pN["cannibalisation"]) * pN["profitPerUnitAA"] / (cpe_floor * pN["aaBudgetShare"])
# the target ROI is taken down so the forced-decrease rule (three days under
# it) does not cap the recommendation under the floor's spend
M = with_bench({"roi_floor": floor_400, "target_roi_aa": 0.0}, lambda: run(cfg))
p, b = M["paid"], M["paid"]["budget"]
d_stop = date.fromisoformat(p["stops"]["day"]) if p["stops"]["day"] else None
floor_path = cost.multipliers(b["current"], lifted=False)
i_cross = next((i for i, m in enumerate(floor_path) if pN["l3dCpe"] * m > cpe_floor), None)
want_day = TODAY + timedelta(days=1 + i_cross) if i_cross is not None else None
print(f"M: floor={floor_400:.3f} floor's price={cpe_floor:.2f} cpe now={b['cpeNow']} close={b['cpeAtClose']} stops={p['stops']} "
      f"want {want_day} spend={p['spendToDate']}->{p['spendProjectedTotal']} rec={b['recommended']} ({b['cap']}, paced {b['paced']}) roi spend={b['roiSpend']}")
check(p["stops"]["rule"] == "roi_floor" and d_stop is not None and TODAY + timedelta(days=1) < d_stop <= launch,
      f"a floor met part way: the stop on the day the price passes it: {p['stops']}")
check(want_day is not None and d_stop == want_day, f"the day the path rebuilt off the block passes the floor: {d_stop} vs {want_day}")
ran = (d_stop - TODAY).days - 1 if d_stop else 0
check(close(p["spendProjectedTotal"], p["spendToDate"] + b["current"] * ran, 0.01),
      f"the run rate over the {ran} days before it: {p['spendProjectedTotal']} vs {p['spendToDate'] + b['current'] * ran:.2f}")
check(b["cap"] == "roi_floor" and not b["paced"] and close(b["recommended"], 400.0, 2.0) and close(b["roiSpend"], 400.0, 2.0),
      f"the recommendation is the floor's spend, unpaced: {b['recommended']} ({b['cap']}, paced {b['paced']}, roi spend {b['roiSpend']})")
ar = p["atRecommended"]
check(ar["stops"]["day"] is None or ar["stops"]["day"] == launch.isoformat(),
      f"at the floor's spend the price meets the floor on the close, so nothing stops before it: {ar['stops']}")
check(ar["spendProjectedTotal"] > p["spendProjectedTotal"] and ar["unitProjected"] > p["unitProjected"],
      f"and the lower spend, run to the close, buys more than the higher one stopped: {ar['spendProjectedTotal']} / {ar['unitProjected']} vs {p['spendProjectedTotal']} / {p['unitProjected']}")

# ---- a complete campaign has no stops and no flat run to show
C = run(cfg, through=launch)
check(C["complete"] and C["paid"]["stops"]["day"] is None and C["paid"]["ifContinued"] is None and C["paid"]["atRecommended"] is None,
      f"complete: nothing to stop or run on: {C['paid']['stops']} {C['paid']['ifContinued']} {C['paid']['atRecommended']}")

print("FAILED" if failed else "ok: paid stops", failed if failed else "")
sys.exit(1 if failed else 0)
