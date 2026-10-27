#!/usr/bin/env python3
"""The paid projection and its two stops (docs 5.4, 6 October 2026; docs 7,
27 October 2026). The projection runs at the recommended spend: today's run
rate stepping by at most 30% a day to the level where the next euro returns
what it costs, capped at the spend that sells out (budget.schedule), and the
same run carries the sell-through at close the Slack update's paid line
prints (atRecommended). At that spend the two stops - the day the units
placed, the organic course and paid's entries together, fill the room (day
by day since 11 October 2026), and the first day the price of a converting
unit passes the ROI floor's - land on the close or not at all, so they show
on the run rate held flat to the close, kept beside the projection with its
own stops and sell-through at close (ifContinued). On the synthetic funnel
frame of test_partial_day, with the edition and the floor moved to make each
stop bite.
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
def last_actual(ch): return [r["actual"] for r in ch["daily"] if r["actual"] is not None][-1]   # the path's start, to the 2 dp the rows carry
def spends(snap): return [s["spend"] for s in snap["paid"]["budget"]["schedule"]]
def cost_of(snap):
    """The cost path rebuilt off the block (docs 7)."""
    p_, b_ = snap["paid"], snap["paid"]["budget"]
    return build.CostPath(p_["l3dCpe"], b_["spendAtWindow"], b_["spentAtWindow"], b_["spentSoFar"], b_["daysLeft"],
                          b_["elasticity"], b_["wearout"], b_["wearoutK"], lift=b_["closeLift"], anchor_lift=b_["liftAtWindow"])
NO_STOP = {"sellout": None, "roiFloor": None, "day": None, "rule": None}
MAX_STEP = build.BENCH["spend_rules"]["max_daily_change"]
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
# far from closed, so nothing stops the run rate or the schedule. The fixture's
# next euro at 500 a day returns less than it costs (a marginal ROI of about
# 0.7), so the level is below today's spend and the recommendation is the
# paced cut toward it (27 October 2026); the floor's spend is published for
# the card's working but no longer sets the level. (At the standard floor the
# fixture's ROI of about 1.06 puts the run rate's price past the floor four
# days out, the case tested further down.)
N = with_floor(0.5, lambda: run(cfg))
p, b = N["paid"], N["paid"]["budget"]
ic, ar = p["ifContinued"], p["atRecommended"]
check(p["stops"] == NO_STOP and ic["stops"] == NO_STOP, f"no stop with the floor low, at the schedule or the run rate: {p['stops']} {ic['stops']}")
check(b["marginalToday"] is not None and b["marginalToday"] < 1 and b["profitSpend"] is not None and 0 < b["profitSpend"] < b["current"],
      f"the next euro at today's spend returns less than it costs, so the level is below it: marginal {b['marginalToday']}, level {b['profitSpend']} vs {b['current']}")
check(b["cap"] == "marginal" and b["target"] == b["profitSpend"] and b["supplySpend"] > b["profitSpend"],
      f"the level is where the next euro returns what it costs, under the sellout's: {b['target']} ({b['cap']}) supply {b['supplySpend']}")
check(b["paced"] and close(b["recommended"], b["current"] * (1 - MAX_STEP), 0.01) and b["recommended"] > b["target"],
      f"the recommendation is the paced cut toward it: {b['recommended']} from {b['current']} toward {b['target']}")
check(b["roiSpend"] is not None and b["roiSpend"] > b["recommended"] and b["band"] in ("increase", "hold", "decrease"),
      f"the floor's spend and the band are published for the working, setting nothing: roi spend {b['roiSpend']}, band {b['band']}")
sch, sp = b["schedule"], spends(N)
check(len(sch) == days_left and sch[0]["date"] == first and sp[0] == b["recommended"],
      f"the schedule runs from the day after the last full day, at the recommendation: {sch[:2]} of {len(sch)}")
check(all(y <= x and y >= x * (1 - MAX_STEP) - 0.01 for x, y in zip(sp, sp[1:])) and sp[-1] == b["target"] and sp.count(b["target"]) >= 2,
      f"and steps down by at most 30% a day to the level, then holds it: {sp}")
check(close(p["spendProjectedTotal"], p["spendToDate"] + sum(sp), 0.1),
      f"the projection runs at the schedule: {p['spendProjectedTotal']} vs {p['spendToDate']} + {sum(sp):.2f}")
check(ar is not None and ar["spend"] == max(sp) and ar["spendProjectedTotal"] == p["spendProjectedTotal"] and ar["entriesProjected"] == p["entriesProjected"]
      and ar["unitProjected"] == p["unitProjected"] and ar["stops"] == p["stops"],
      f"the projection at the recommended spend is the same run: {ar} vs {p['spendProjectedTotal']}, {p['entriesProjected']}, {p['unitProjected']}")
check(ar["sellThrough"] is not None and 0 <= ar["sellThrough"]["pct"] <= 1 and close(ar["sellThrough"]["units"], N["hero"]["projected"], 1.0),
      f"with the sell-through at close, the hero's projection: {ar['sellThrough']} vs {N['hero']['projected']}")
check(ic["spend"] == b["current"] and close(ic["spendProjectedTotal"], p["spendToDate"] + b["current"] * days_left, 0.01),
      f"the run rate held flat to the close beside it: {ic} vs {p['spendToDate'] + b['current'] * days_left:.2f}")
check((p["unitProjected"] < ic["unitProjected"]) == (b["recommended"] < b["current"]) and ic["unitProjected"] > p["unitProjected"] + 1,
      f"more spend, more units: {ic['unitProjected']} at {b['current']} vs {p['unitProjected']} at the schedule")
check((ar["sellThrough"]["units"] < ic["sellThrough"]["units"]) == (b["recommended"] < b["current"]) and ic["sellThrough"]["units"] > ar["sellThrough"]["units"] + 1,
      f"and a higher sell-through at close: {ic['sellThrough']} at {b['current']} vs {ar['sellThrough']} at the schedule")
# the ROI line ahead runs at the schedule too: with no work filling, each
# point is the L3D over the schedule's price on the cost path rebuilt off the
# block, which falls as the days shrink
cost = cost_of(N)
ms = cost.multipliers_sched(sp)
check(len(p["roiPath"]) == days_left and all(close(r["roi"], p["l3dRoi"] / m, 0.01) for r, m in zip(p["roiPath"], ms))
      and p["roiPath"][-1]["roi"] > p["roiPath"][0]["roi"] > p["l3dRoi"] * 0.9,
      f"the ROI line ahead at the schedule, the cut pricing the days cheaper: {p['roiPath'][:2]}..{p['roiPath'][-1]} vs l3d {p['l3dRoi']} over {[round(m, 3) for m in ms[:2]]}")
print(f"N: day {N['day']}/{N['of']} edition={N['edition']['target']} cur={b['current']} rec={b['recommended']} level={b['target']} cap={b['cap']} "
      f"marginal={b['marginalToday']} gap={b['selloutGap']} organic={b['organicFuture']} cpe now={b['cpeNow']} close={b['cpeAtClose']} "
      f"spend={p['spendToDate']}->{p['spendProjectedTotal']} flat {ic['spendProjectedTotal']} units={p['unitsToDate']}->{p['unitProjected']} "
      f"flat {ic['unitProjected']} sell-through {ar['sellThrough']} flat {ic['sellThrough']}")

# ---- the sellout stop: an edition the run rate fills a few days before the
# close, the organic channels and paid landing together (11 October 2026).
# The stop is the flat run's (ifContinued) since 27 October 2026: at the
# recommended spend, which stops paid outright once the organic course alone
# sells out, nothing stops. The organic course moves with the edition (the
# targets do, and not in proportion), so the edition is found by fixed-point
# steps on the course by the day aimed at: what is secured now, the organic
# channels' futures along their curves (the shape read off their paths, which
# the hero's adoption scales but never reshapes) and paid's flat run by that
# day. The paid channel's path in N runs at N's schedule, so its days are
# rescaled to the run rate on the cost path rebuilt off the block: a day's
# entries go as its spend over its price
flat_units = ic["unitProjected"] - p["unitsToDate"]
m_flat = cost.multipliers(b["current"])
rescale = [(b["current"] / mf) / (s / m) for s, m, mf in zip(sp, ms, m_flat)]
def paid_flat(flat):
    """Paid's units by day at the run rate, read off `flat`'s path at its schedule."""
    pc = paid_row(flat)
    rows = [r for r in pc["daily"] if r["proj"] is not None]
    out, cum, prev = {}, 0.0, last_actual(pc)
    for r, k in zip(rows, rescale):
        cum += (r["proj"] - prev) * k
        prev = r["proj"]
        out[r["date"]] = cum
    return out
flat_N = paid_flat(N)
check(len(flat_N) == days_left and close(flat_N[launch.isoformat()], flat_units, 0.1),
      f"paid's path rescaled to the run rate lands on the flat run's units: {flat_N[launch.isoformat()]:.2f} vs {flat_units:.2f}")
def gap_raw(snap, E): return E - snap["hero"]["now"] - snap["paid"]["budget"]["organicFuture"]
def course(snap, d, flat):
    """The hero's course by day d at the run rate, unscaled, paid's flat run read off `flat`."""
    def at(c, iso):
        r = [r for r in c["daily"] if r["date"] <= iso][-1]
        return r["proj"] if r["proj"] is not None else r["actual"]
    org = [c for c in snap["channels"] if c["key"] != "paid"]
    now_o, end_o = sum(c["now"] for c in org), sum(at(c, launch.isoformat()) for c in org)
    share = (sum(at(c, d.isoformat()) for c in org) - now_o) / (end_o - now_o) if end_o > now_o else 1.0
    paid_by = paid_flat(flat)
    return snap["hero"]["now"] + snap["paid"]["budget"]["organicFuture"] * share + max([v for k, v in paid_by.items() if k <= d.isoformat()], default=0.0)
d_aim = TODAY + timedelta(days=7)        # the day the room should run out
E1 = round(course(N, d_aim, N), 1)
S = None
for _ in range(6):
    cfgS = dict(cfg, edition_size=E1, edition_total=E1)   # the target the whole edition
    S = with_floor(0.5, lambda: run(cfgS))
    E2 = round(course(S, d_aim, N), 1)
    if abs(E2 - E1) < 0.3:
        break
    E1 = E2
p, b = S["paid"], S["paid"]["budget"]
ic, ar = p["ifContinued"], p["atRecommended"]
st = ic["stops"]
print(f"S: edition={cfgS['edition_size']} gap={b['selloutGap']} organic={b['organicFuture']} flat stops={st} schedule stops={p['stops']} "
      f"spend={p['spendToDate']}->{p['spendProjectedTotal']} flat {ic['spendProjectedTotal']} "
      f"entries={p['entriesToDate']:.1f}->{p['entriesProjected']} flat {ic['entriesProjected']} hero proj={S['hero']['projected']} "
      f"flat sell-through {ic['sellThrough']} rec={b['recommended']} ({b['cap']})")
check(b["selloutGap"] <= 0.2 and b["organicFuture"] > E1 - S["hero"]["now"] - 0.5,
      f"the organic course alone covers the room by the close, so the gap reads 0 and paid only brings the sellout forward: "
      f"gap {b['selloutGap']}, organic {b['organicFuture']} for a room of {E1 - S['hero']['now']:.1f}")
check(st["rule"] == "sellout" and st["sellout"] == st["day"] and st["roiFloor"] is None
      and TODAY < date.fromisoformat(st["day"]) < launch, f"the run rate's sellout stop, before the close: {st}")
d_stop = date.fromisoformat(st["day"])
check(abs((d_stop - d_aim).days) <= 1, f"on the day the course reaches the edition: {st['day']} vs {d_aim}")
check(course(S, d_stop - timedelta(days=1), N) < E1 + 0.5 and course(S, d_stop, N) >= E1 - 1.0,
      f"the room runs out on that day and not the day before: {course(S, d_stop - timedelta(days=1), N):.1f}, {course(S, d_stop, N):.1f} vs {E1}")
check(close(ic["spendProjectedTotal"], p["spendToDate"] + b["current"] * days_left, 0.01)
      and ic["entriesProjected"] > p["entriesProjected"] + 1 and ic["unitProjected"] > p["unitProjected"] + 1,
      f"the flat run to the close, buying what the projection does not: {ic} vs {p['spendProjectedTotal']}, {p['entriesProjected']}")
check(ic["sellThrough"]["pct"] <= 1 and close(ic["sellThrough"]["units"], cfgS["edition_size"], 1.5),
      f"and reaching the sellout, earlier: {ic['sellThrough']} vs {cfgS['edition_size']}")
check(b["cap"] == "supply" and b["recommended"] == 0.0 and b["target"] == 0.0 and all(s == 0.0 for s in spends(S)),
      f"the recommendation stops paid, the organic course selling out without it, and the schedule is nothing: {b['recommended']} ({b['cap']}) from {b['current']}, {spends(S)[:3]}")
check(p["stops"] == NO_STOP and p["spendProjectedTotal"] == p["spendToDate"] and close(p["entriesProjected"], p["entriesToDate"], 0.05)
      and p["unitProjected"] == p["unitsToDate"],
      f"so the projection spends and buys nothing more, and nothing stops it: {p['stops']} {p['spendProjectedTotal']} vs {p['spendToDate']}, {p['entriesProjected']} vs {p['entriesToDate']}")
check(close(S["hero"]["projected"], cfgS["edition_size"], 1.5), f"the projection at close is the sellout: {S['hero']['projected']} vs {cfgS['edition_size']}")
rows = [r for r in paid_row(S)["daily"] if r["proj"] is not None]
projs = [r["proj"] for r in rows]
# (the hero's adoption of the sell-through's count scales the channels'
# paths by a hair, so the path is read against itself, not the last actual)
check(len(rows) == days_left and max(projs) - min(projs) < 0.01 and abs(projs[0] - last_actual(paid_row(S))) < 0.01 * last_actual(paid_row(S)),
      f"the paid channel's path is flat from the first day: {[(r['date'], r['proj']) for r in rows][:2]}..{rows[-1]['proj']} vs {last_actual(paid_row(S))}")
check(ar["stops"] == NO_STOP and ar["spendProjectedTotal"] == p["spendProjectedTotal"],
      f"at the recommended spend nothing stops, the run being the projection: {ar['stops']} {ar['spendProjectedTotal']}")
check(ar["sellThrough"]["pct"] <= 1 and close(ar["sellThrough"]["units"], S["hero"]["projected"], 1.5),
      f"and the sell-through at close is the sellout still: {ar['sellThrough']} vs {S['hero']['projected']}")
# ---- the gap is to the whole edition, never the target (9 October 2026):
# with the target at 80% of the same edition the organic course shrinks with
# it, and paid is still sized to the edition: the run rate stops where it
# fills the edition and the projection at close is the edition
cfgT = dict(cfgS, edition_size=round(E1 * 0.8), edition_total=E1)
T = with_floor(0.5, lambda: run(cfgT))
pt, bt = T["paid"], T["paid"]["budget"]
print(f"T: target={cfgT['edition_size']} of {cfgT['edition_total']} gap={bt['selloutGap']} organic={bt['organicFuture']} flat stops={pt['ifContinued']['stops']} "
      f"hero proj={T['hero']['projected']} rec={bt['recommended']} ({bt['cap']})")
check(T["edition"]["target"] == cfgT["edition_size"] and close(float(T["edition"]["total"]), E1, 1), f"the target inside the edition: {T['edition']}")
check(close(bt["selloutGap"], max(gap_raw(T, E1), 0.0), 1),
      f"the gap reads the whole edition: {bt['selloutGap']} vs {gap_raw(T, E1):.2f} (to the target it would be {gap_raw(T, cfgT['edition_size']):.2f})")
check(T["hero"]["projected"] > cfgT["edition_size"] + 1, f"and the projection runs past the target: {T['hero']['projected']} vs {cfgT['edition_size']}")
check(pt["ifContinued"]["stops"]["rule"] == "sellout" and close(T["hero"]["projected"], E1, 1.5),
      f"the run rate stops at the edition and the projection at close is the edition: {pt['ifContinued']['stops']} {T['hero']['projected']} vs {E1}")
# ---- a work spoken for turns paid entries away (10 October 2026): a per-work
# feed whose entrants mostly want a work already full. The entrants paid
# brings look like them, so only the share for the other work buys a unit:
# the yield reads that share, the entries needed close the gap over it, the
# ROI line ahead falls by it, and the schedule's run wastes the rest
nameY = cfg0["release_name"]
E1i = int(round(E1))
feedY = {"draws": [{"id": "dA", "first": announce.isoformat(), "last": None, "entrants": 100, "eligible": 100, "winners": 0, "sold": 0, "open": 100, "wonUnpaid": 0, "purchaseUnits": 0.0},
                   {"id": "dB", "first": announce.isoformat(), "last": None, "entrants": 40, "eligible": 40, "winners": 0, "sold": 0, "open": 40, "wonUnpaid": 0, "purchaseUnits": 0.0}],
         "entrants": 140, "eligible": 140, "allocated": False,
         "patterns": [{"open": ["dA"], "won": [], "sold": [], "max": 1, "n": 100}, {"open": ["dB"], "won": [], "sold": [], "max": 1, "n": 40}]}
cfgY = dict(cfgS, products=list(cfgS.get("products") or []) + [{"key": "dA", "name": "Work A", "edition": 30}, {"key": "dB", "name": "Work B", "edition": E1i - 30}])
keep_feed = build._PRODUCTS_FEED
build._PRODUCTS_FEED = {nameY: feedY}
try:
    Y = with_floor(0.2, lambda: run(cfgY))
finally:
    build._PRODUCTS_FEED = keep_feed
py, by = Y["paid"], Y["paid"]["budget"]
print(f"Y: yield now={by['yieldNow']} at close={by['yieldAtClose']} full={by['fullWorks']} gap={by['selloutGap']} entries needed={by['entriesNeeded']} "
      f"rec={by['recommended']} ({by['cap']}) stops={py['stops']} wasted={by['wastedEntries']} roi ahead={py['roiPath'][:1]} l3d={py['l3dRoi']}")
check([w["name"] for w in by["fullWorks"]] == ["Work A"] and by["fullWorks"][0]["date"] is None,
      f"the full work is named, full already: {by['fullWorks']}")
check(0.15 < (by["yieldNow"] or 0) < 0.45, f"two entrants in seven want the work with room: yield {by['yieldNow']}")
check(by["entriesNeeded"] is not None and 2 * by["selloutGap"] / e2o < by["entriesNeeded"] < by["selloutGap"] / (e2o * 0.15),
      f"the entries needed close the gap over that share, well over the gap at the rate: {by['entriesNeeded']} vs {by['selloutGap'] / e2o:.1f}")
check(bool(py["roiPath"]) and py["l3dRoi"] is not None and py["roiPath"][0]["roi"] < 0.6 * py["l3dRoi"],
      f"the ROI line ahead falls by the share: {py['roiPath'][:1]} vs {py['l3dRoi']}")
check((by["wastedEntries"] or 0) > 0, f"the schedule's entries for the full work buy nothing: {by['wastedEntries']}")
# ---- a work with room today that fills part way (11 October 2026): the
# entrants placed day by day, the organic course along its curves and paid's
# entries on top, fill Work A on a day before the close. Until then every
# entry converts and the ROI line ahead is the cost path's alone, at the
# schedule (27 October 2026: here a paced rise, which prices the days dearer,
# so the line falls along it); from that day only the share for Work B does
# (two entrants in three), so the line steps down there, the point names the
# work, and the card dates it
feedZ = {"draws": [{"id": "dA", "first": announce.isoformat(), "last": None, "entrants": 20, "eligible": 20, "winners": 0, "sold": 0, "open": 20, "wonUnpaid": 0, "purchaseUnits": 0.0},
                   {"id": "dB", "first": announce.isoformat(), "last": None, "entrants": 40, "eligible": 40, "winners": 0, "sold": 0, "open": 40, "wonUnpaid": 0, "purchaseUnits": 0.0}],
         "entrants": 60, "eligible": 60, "allocated": False,
         "patterns": [{"open": ["dA"], "won": [], "sold": [], "max": 1, "n": 20}, {"open": ["dB"], "won": [], "sold": [], "max": 1, "n": 40}]}
build._PRODUCTS_FEED = {nameY: feedZ}
try:
    Z = with_floor(0.2, lambda: run(cfgY))
finally:
    build._PRODUCTS_FEED = keep_feed
pz, bz = Z["paid"], Z["paid"]["budget"]
zpath = pz["roiPath"]
k = next((i for i, r in enumerate(zpath) if r.get("full")), None)
# the share of each day's entries the line carries: its ROI over the cost
# path's at the schedule, rebuilt off the block
zm = cost_of(Z).multipliers_sched(spends(Z))
zshare = [r["roi"] * m / pz["l3dRoi"] for r, m in zip(zpath, zm)] if pz["l3dRoi"] else []
print(f"Z: yield now={bz['yieldNow']} at close={bz['yieldAtClose']} full={bz['fullWorks']} stops={pz['stops']} wasted={bz['wastedEntries']} "
      f"rec={bz['recommended']} ({bz['cap']}) step at {k}: {zpath[k - 1:k + 2] if k else None} l3d={pz['l3dRoi']} shares={[round(x, 3) for x in zshare]}")
check(bz["yieldNow"] is not None and bz["yieldNow"] >= 0.999, f"every entry converts today: yield {bz['yieldNow']}")
check(len(bz["fullWorks"]) == 1 and bz["fullWorks"][0]["name"] == "Work A" and bz["fullWorks"][0]["date"] is not None
      and TODAY < date.fromisoformat(bz["fullWorks"][0]["date"]) < launch, f"Work A fills on a day before the close: {bz['fullWorks']}")
check(k is not None and 1 <= k < len(zpath) - 1 and zpath[k]["full"] == ["Work A"] and zpath[k]["date"] == bz["fullWorks"][0]["date"],
      f"the line's point on that day names the work: {k} {zpath[k] if k is not None else None} vs {bz['fullWorks']}")
if k is not None and 1 <= k < len(zpath) - 1:
    before, on, after = zpath[k - 1]["roi"], zpath[k]["roi"], zpath[k + 1]["roi"]
    check(all(abs(x - 1.0) < 0.01 for x in zshare[:k]), f"the line ahead is the cost path's alone until that day: {[round(x, 3) for x in zshare[:k]]}")
    check(after < on <= before and after < 0.75 * before and zshare[k + 1] < zshare[k] < zshare[k - 1],
          f"and steps down on it: {before} -> {on} -> {after}, carrying {[round(x, 3) for x in zshare[k - 1:k + 2]]} of the entries")
    check(0.55 < (bz["yieldAtClose"] or 0) < 0.8 and all(abs(x - bz["yieldAtClose"]) < 0.02 for x in zshare[k + 1:]),
          f"to Work B's share of the entrants: {bz['yieldAtClose']} vs {[round(x, 3) for x in zshare[k + 1:]]}")
check((bz["wastedEntries"] or 0) > 0, f"the entries for Work A after it fills buy nothing: {bz['wastedEntries']}")
# the same on a part day: today counts for what is left of it, in the flat run
# and the schedule alike, whose first entry is the rest of today at the run rate
P = with_floor(0.5, lambda: run(cfgS, through=TODAY, part=0.4, full_through=TODAY - timedelta(days=1), seen=0.4375))
pp, pb = P["paid"], P["paid"]["budget"]
rest = (launch - (TODAY - timedelta(days=1))).days - 0.4375
check(close(pp["ifContinued"]["spendProjectedTotal"], pp["spendToDate"] + pb["current"] * rest, 0.01),
      f"part day: the flat run counts the rest of today: {pp['ifContinued']['spendProjectedTotal']} vs {pp['spendToDate'] + pb['current'] * rest:.2f}")
check(pp["ifContinued"]["stops"]["rule"] == "sellout" and TODAY < date.fromisoformat(pp["ifContinued"]["stops"]["day"]) < launch
      and pp["entriesProjected"] >= pp["entriesToDate"] - 0.05,
      f"part day: the run rate's stop, and the entries in hand kept: {pp['ifContinued']['stops']} {pp['entriesProjected']} vs {pp['entriesToDate']}")
check(pb["schedule"][0] == {"date": TODAY.isoformat(), "spend": pb["current"]} and pb["recommended"] == 0.0 and all(s == 0.0 for s in spends(P)[1:])
      and close(pp["spendProjectedTotal"], pp["spendToDate"] + pb["current"] * (1 - 0.4375), 0.01),
      f"part day: the schedule opens with the rest of today at the run rate, then the recommendation: {pb['schedule'][:2]} {pp['spendProjectedTotal']} vs {pp['spendToDate'] + pb['current'] * (1 - 0.4375):.2f}")

# ---- the ROI floor stop (27 October 2026). A floor the price is already past
# stops the run rate now, on the flat run: nothing more is bought on it, and
# its sell-through at close reads that. The floor no longer sets the
# recommendation: the fixture's next euro does not pay, so the recommendation
# is the paced cut of N, the floor's spend (0, no day meets it) published for
# the working only. The projection is the schedule's run, the one the Slack
# update reads
F = with_floor(1000.0, lambda: run(cfg))
p, b = F["paid"], F["paid"]["budget"]
ic, ar = p["ifContinued"], p["atRecommended"]
bN, icN = N["paid"]["budget"], N["paid"]["ifContinued"]
check(ic["stops"]["rule"] == "roi_floor" and ic["stops"]["roiFloor"] == first and ic["stops"]["day"] == first and ic["stops"]["sellout"] is None,
      f"a floor the price is past: the run rate stops now: {ic['stops']}")
check(ic["spendProjectedTotal"] == icN["spendProjectedTotal"] and ic["sellThrough"]["units"] < icN["sellThrough"]["units"] - 1
      and close(ic["sellThrough"]["units"], F["hero"]["now"] + bN["organicFuture"], 2.0),
      f"the flat run's sell-through at close buys nothing more, the organic course alone: {ic['sellThrough']} vs {icN['sellThrough']}, now {F['hero']['now']} + organic {bN['organicFuture']}")
check(b["roiSpend"] == 0.0 and b["cap"] == "marginal" and b["paced"] and b["recommended"] == bN["recommended"] and b["target"] == bN["target"]
      and spends(F) == spends(N) and b["marginalToday"] == bN["marginalToday"],
      f"the floor no longer sets the level: the paced cut of N, the floor's spend for the working: {b['recommended']} ({b['cap']}, paced {b['paced']}, roi spend {b['roiSpend']}) vs N {bN['recommended']} ({bN['cap']})")
check(ar["spendProjectedTotal"] == p["spendProjectedTotal"] and ar["stops"] == p["stops"] and ar["unitProjected"] == p["unitProjected"]
      and p["spendProjectedTotal"] <= p["spendToDate"] + sum(spends(F)) + 0.01,
      f"the projection is the schedule's run: {ar['stops']} {ar['spendProjectedTotal']} vs {p['stops']} {p['spendProjectedTotal']}")
print(f"F: cpe now={b['cpeNow']} floor's price {(1 - p['cannibalisation']) * p['profitPerUnitAA'] / (1000.0 * p['aaBudgetShare']):.2f} "
      f"flat stops={ic['stops']} schedule stops={p['stops']} spend={p['spendToDate']}->{p['spendProjectedTotal']} rec={b['recommended']} ({b['cap']})")

# ---- a floor the price reaches part way to the close: the run rate's stop
# lands on the day the path's price (before the close's lift, where the floor
# is read) first passes it, on the flat run, the floor set from the cost path
# rebuilt off the block (docs 7) at a spend of 400. The floor no longer sets
# the recommendation (27 October 2026): the level is where the next euro
# returns what it costs, the paced cut of N again, and at the schedule's
# smaller days the price stays under the floor's all the way, so nothing
# stops the projection, which runs to the close
pN = N["paid"]
cpe_floor = cost.cpe_close(400.0)
floor_400 = (1 - pN["cannibalisation"]) * pN["profitPerUnitAA"] / (cpe_floor * pN["aaBudgetShare"])
M = with_floor(floor_400, lambda: run(cfg))
p, b = M["paid"], M["paid"]["budget"]
ic, ar = p["ifContinued"], p["atRecommended"]
d_stop = date.fromisoformat(ic["stops"]["day"]) if ic["stops"]["day"] else None
floor_path = cost.multipliers(b["current"], lifted=False)
i_cross = next((i for i, m in enumerate(floor_path) if pN["l3dCpe"] * m > cpe_floor), None)
want_day = TODAY + timedelta(days=1 + i_cross) if i_cross is not None else None
sched_floor = cost.multipliers_sched(spends(M), lifted=False)
print(f"M: floor={floor_400:.3f} floor's price={cpe_floor:.2f} cpe now={b['cpeNow']} close={b['cpeAtClose']} flat stops={ic['stops']} "
      f"want {want_day} schedule stops={p['stops']} spend={p['spendToDate']}->{p['spendProjectedTotal']} flat {ic['spendProjectedTotal']} "
      f"rec={b['recommended']} ({b['cap']}, paced {b['paced']}) roi spend={b['roiSpend']} sell-through {ar['sellThrough']} flat {ic['sellThrough']}")
check(ic["stops"]["rule"] == "roi_floor" and d_stop is not None and TODAY + timedelta(days=1) < d_stop <= launch,
      f"a floor met part way: the run rate's stop on the day the price passes it: {ic['stops']}")
check(want_day is not None and d_stop == want_day, f"the day the path rebuilt off the block passes the floor: {d_stop} vs {want_day}")
check(b["cap"] == "marginal" and b["paced"] and b["recommended"] == bN["recommended"] and b["target"] == bN["target"] and close(b["roiSpend"], 400.0, 2.0),
      f"the floor no longer sets the recommendation, the paced cut of N; the floor's spend is published for the working: "
      f"{b['recommended']} ({b['cap']}, paced {b['paced']}, roi spend {b['roiSpend']}) vs N {bN['recommended']}")
check(all(pN["l3dCpe"] * m <= cpe_floor for m in sched_floor) and p["stops"] == NO_STOP and ar["stops"] == NO_STOP
      and close(p["spendProjectedTotal"], p["spendToDate"] + sum(spends(M)), 0.1),
      f"at the schedule's smaller days the price stays under the floor's, so nothing stops the projection, run to the close: "
      f"{[round(pN['l3dCpe'] * m) for m in sched_floor]} vs {cpe_floor:.0f}, {p['stops']}, {p['spendProjectedTotal']}")
check(ar["sellThrough"]["units"] > ic["sellThrough"]["units"] + 0.5 and ic["sellThrough"]["units"] < icN["sellThrough"]["units"] - 0.5,
      f"and the cut, run to the close, takes the release further than the run rate stopped at the floor: {ar['sellThrough']} vs {ic['sellThrough']} (unstopped {icN['sellThrough']})")

# ---- paid switched off today (13 October 2026): nothing spent on this
# campaign so far today while another campaign in the feed has spent, well
# into the day: the run rate still reads the last day paid ran, and the page
# says paid is off today. With no other campaign spending today the feed may
# simply not have the day yet, so nothing is said
sf_off = pd.concat([spend_frame(TODAY, part=0.0),
                    pd.DataFrame([{"campaign_name": "Other · Enter draw", "spend_date": TODAY, "impressions": 100, "reach": 80, "link_clicks": 4, "spend": 120.0}])],
                   ignore_index=True)
O = build.build_release(cfg, frame(TODAY, 0.4), sf_off, emails, content, curves, TODAY, artist_posts, {}, None, panel, people,
                        full_through=TODAY - timedelta(days=1), seen=0.4375)
build.check_snapshot(O)
bo = O["paid"]["budget"]
check(bo["offToday"] is True and bo["spendToday"] == 0.0 and bo["current"] == 500.0,
      f"paid off today: the run rate is the last day it ran, today reads nothing: {bo['offToday']} {bo['spendToday']} {bo['current']}")
Q = build.build_release(cfg, frame(TODAY, 0.4), spend_frame(TODAY, part=0.0), emails, content, curves, TODAY, artist_posts, {}, None, panel, people,
                        full_through=TODAY - timedelta(days=1), seen=0.4375)
check(Q["paid"]["budget"]["offToday"] is False, f"no other campaign spending today: nothing is said: {Q['paid']['budget']['offToday']}")
check(P["paid"]["budget"]["offToday"] is False and P["paid"]["budget"]["spendToday"] == 200.0, f"a part day with spend is not off: {P['paid']['budget']['offToday']} {P['paid']['budget']['spendToday']}")

# ---- a complete campaign has no stops and no flat run to show
C = run(cfg, through=launch)
check(C["complete"] and C["paid"]["stops"]["day"] is None and C["paid"]["ifContinued"] is None and C["paid"]["atRecommended"] is None,
      f"complete: nothing to stop or run on: {C['paid']['stops']} {C['paid']['ifContinued']} {C['paid']['atRecommended']}")

print("FAILED" if failed else "ok: paid stops", failed if failed else "")
sys.exit(1 if failed else 0)
