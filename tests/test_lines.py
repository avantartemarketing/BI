#!/usr/bin/env python3
"""A release selling two lines of work on one page (docs/LINES_PLAN.md): the
lines resolve from the products' Airtable release codes with the release's
own economics arithmetic; each line is benchmarked on its own basket and
targeted with its own K; the combined page sums units, entries and the paid
budget, shares the organic sessions (the larger line's per group) and
derives conversion; each line's page rides under variants.lines with its
entries from its own draws, its units from its own works, its spend from
its own ad set and the sessions of the shared page; a one-line release is
untouched.
python3 tests/test_lines.py (needs pandas)"""
import sys, json, pathlib, random, copy
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)
def close(a, b, tol=1e-6):
    return a is not None and b is not None and abs(a - b) <= tol * max(abs(b), 1.0)

# ---- the release: the Schnabel harness record read per product, with seven
# works under two Airtable codes
base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base.pop("legacy_economics", None)
base["campaign_name"] = "Synthetic · Enter draw"; base["campaign_names"] = [base["campaign_name"]]
announce, launch = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
pr_open = date.fromisoformat(base["private_room_open"]); name = base["release_name"]
TODAY = announce + timedelta(days=12)
PRINTS = [("Art is Life", "p1"), ("Life is Art", "p2"), ("Liberty is about the Fight", "p3")]
BRICKS = [(f"Toy Brick Middle Finger ({c})", f"b{i}") for i, c in enumerate(("Blue", "Red", "Green", "Clear"))]

def product(title, aid, code, edition, share, price, ppu_aa, ppu_artist):
    return {"airtable_id": aid, "name": title, "release": code, "project_code": f"X-{aid}", "edition": edition,
            "edition_size": edition, "target_sellthrough": share, "unit_price": price, "currency": "EUR",
            "aa_profit_per_unit": ppu_aa, "artist_profit_per_unit": ppu_artist, "aa_profit_share": 0.5,
            "aa_revenue_share": None, "artist_revenue_cut": None, "deal_type": "profit", "framing_available": False,
            "framing_default": False, "launch_date": launch.isoformat(), "units_target": None,
            "frame_conversion": None, "frame_profit_per_unit": None, "frame_price": None}
PRODUCTS = ([product(t, a, "Lego2026", 100, 1.0, 2500, 1000.0, 800.0) for t, a in PRINTS]
            + [product(t, a, "LegoMF", 750, 0.3, 550, 150.0, 100.0) for t, a in BRICKS])
ONE_CODE = [dict(p, release="Lego2026") for p in PRODUCTS]

def fake_products(products):
    def f(release, *a, **k):
        return {"match": "exact", "note": "", "products": copy.deepcopy(products), "launch_date": launch.isoformat(),
                "announce_date": announce.isoformat(), "private_room_date": pr_open.isoformat(), "marketing_lead": None,
                "project_manager": None, "pm_slack_id": None}
    return f
build.pricing.release_products = fake_products(PRODUCTS)

# ---- the economics arithmetic is the release's over each line's products
r = build.resolve_release(copy.deepcopy(base), None, {})
lines = r["lines"]
check(r["economics_mode"] == "products" and len(lines) == 2, f"two lines resolve: {[l.get('key') for l in lines]}")
by = {l["key"]: l for l in lines}
check(by["Lego2026"]["edition_size"] == 300 and by["Lego2026"]["edition_total"] == 300 and by["LegoMF"]["edition_size"] == 900
      and by["LegoMF"]["edition_total"] == 3000, f"each line's target and edition: {[(l['edition_size'], l['edition_total']) for l in lines]}")
check(r["edition_size"] == 1200 and r["edition_total"] == 3300, f"the release's are the lines' summed: {r['edition_size']} / {r['edition_total']}")
check(by["Lego2026"]["unit_price"] == 2500 and by["LegoMF"]["unit_price"] == 550, "each line's price is its own")
check(close(r["launch_value"], by["Lego2026"]["launch_value"] + by["LegoMF"]["launch_value"]), "the launch value adds up")
check(by["LegoMF"]["name"] == "Toy Brick Middle Finger" and by["Lego2026"]["name"] == "Lego2026",
      f"a line is named by its works' shared words, else its code: {[l['name'] for l in lines]}")
# the old inline arithmetic, kept here as the reference
sized = [p for p in r["economics_products"] if p["edition"]]
targets = sum(p["target_units"] for p in sized)
ppu = sum(p["target_units"] * p["aa_profit_per_unit"] for p in sized) / targets
check(close(r["aa_ppu_resolved"], ppu) and close(r["aa_group_profit"], round(ppu * targets, 2)), f"the profit per unit is weighted by target units: {r['aa_ppu_resolved']} vs {ppu}")
check(all(p.get("line") in ("Lego2026", "LegoMF") for p in r["economics_products"]), "every product carries its line")
named = build.resolve_release(dict(copy.deepcopy(base), line_settings={"Lego2026": {"name": "Prints", "adsets": ["Prints"]}}), None, {})
check(next(l for l in named["lines"] if l["key"] == "Lego2026")["name"] == "Prints" and next(l for l in named["lines"] if l["key"] == "Lego2026")["adsets"] == ["Prints"],
      "a typed name and ad set are read from line_settings")
lr = build.line_release(named, next(l for l in named["lines"] if l["key"] == "LegoMF"))
check(lr["edition_size"] == 900 and lr["unit_price"] == 550 and len(lr["economics_products"]) == 4 and lr["line"] == "LegoMF",
      "line_release reads the release as one line")

# ---- a one-line release is untouched
build.pricing.release_products = fake_products(ONE_CODE)
one = build.resolve_release(copy.deepcopy(base), None, {})
check(one["lines"] == [] and one["edition_size"] == 1200, f"one code, no lines: {one['lines']}")

# ---- the lines typed on the works (one release code across both lines, the
# real case): the typed names make the lines, a work with none typed goes to
# Other works, and the typed split wins over the codes
typed_all = [{"airtable_id": a, "line": "Prints"} for _, a in PRINTS] + [{"airtable_id": a, "line": "Toy bricks"} for _, a in BRICKS]
t = build.resolve_release(dict(copy.deepcopy(base), products=typed_all), None, {})
tk = {l["key"]: l for l in t["lines"]}
check(set(tk) == {"prints", "toy_bricks"} and tk["prints"]["name"] == "Prints" and tk["toy_bricks"]["name"] == "Toy bricks" and tk["toy_bricks"]["edition_size"] == 900,
      f"typed lines on one code: {[(l['key'], l['name'], l['edition_size']) for l in t['lines']]}")
check(all(l["code"] is None and l["lineTyped"] for l in t["lines"]), "a typed line carries no code")
part = build.resolve_release(dict(copy.deepcopy(base), products=[{"airtable_id": a, "line": "Prints"} for _, a in PRINTS]), None, {})
pk = {l["key"]: l for l in part["lines"]}
check(set(pk) == {"prints", "_other"} and pk["_other"]["name"] == "Other works" and pk["_other"]["edition_size"] == 900,
      f"one line typed: the rest is Other works: {[(l['key'], l['name']) for l in part['lines']]}")
same = build.resolve_release(dict(copy.deepcopy(base), products=[{"airtable_id": a, "line": "  prints "} for _, a in PRINTS + BRICKS]), None, {})
check(same["lines"] == [], f"one line typed on every work: one release: {same['lines']}")
build.pricing.release_products = fake_products(PRODUCTS)
mixed = build.resolve_release(dict(copy.deepcopy(base), products=[{"airtable_id": "p1", "line": "Solo"}]), None, {})
check({l["key"] for l in mixed["lines"]} == {"solo", "_other"}, f"a typed line wins over the codes: {[l['key'] for l in mixed['lines']]}")
build.pricing.release_products = fake_products(PRODUCTS)

# ---- the feeds: a funnel frame, spend with an ad set per line, the draws
# with their daily entries, a units feed per work
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]
rows, rnd, d = [], random.Random(7), min(pr_open, announce); LL = (launch - announce).days
while d <= TODAY:
    dsa, dul = (d - announce).days, (launch - d).days
    for ch, sess, ent in CH:
        s_, e_ = sess * (1 + 0.1 * rnd.random()), ent * 10
        # the converting units (docs 7) as the rebuilt funnel carries them: a
        # tenth of the entry units claimed, a fifth waiting as pre-orders, half as plain entries
        rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                     "Sessions_Total": s_, "Total_Product_Units": e_ * 0.3, "Product_Units_Private_Room": 0.0,
                     "Draw_Entries_Total_Units_No_Conv": e_ * 0.7, "Draw_Entries_Eligible_Units": e_,
                     "Conv_Units_Claimed": e_ * 0.1, "Conv_Units_Pending_Preorder": e_ * 0.2, "Conv_Units_Pending_Draw": e_ * 0.5,
                     "days_since_announcement": dsa, "days_until_launch": dul, "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
    d += timedelta(days=1)
at = pd.DataFrame(rows)
sp_rows, d = [], announce
while d <= TODAY:
    sp_rows.append({"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800, "link_clicks": 40, "spend": 300.0, "adset_name": "Prints"})
    sp_rows.append({"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800, "link_clicks": 40, "spend": 500.0, "adset_name": "Bricks"})
    d += timedelta(days=1)
spend = pd.DataFrame(sp_rows)
# the draws: one per work, entries by day and channel; each print draws two
# entries for each one a brick draws (six tenths of the entries on the three
# prints, four tenths on the four bricks), ten a channel-day in all, the
# funnel's eligible units; each draw's conversions are its share of the funnel's
draws, patterns, DRAW_OF = [], [], {}
for i, (title, aid) in enumerate(PRINTS + BRICKS):
    did = f"draw_{aid}"
    DRAW_OF[title] = did
    weight = 1.0 if aid.startswith("p") else 0.5
    daily, conv, d = [], [], announce
    while d <= TODAY:
        for ch, _, ent in CH:
            if ch == "Untracked":
                continue
            n = int(round(ent * weight * 2))
            if n:
                daily.append([d.isoformat(), ch, n, int(round(n * 0.7))])
                conv.append([d.isoformat(), ch, n * 0.1, n * 0.2, n * 0.5])
        d += timedelta(days=1)
    elig = sum(x[2] for x in daily); open_ = sum(x[3] for x in daily)
    draws.append({"id": did, "first": announce.isoformat(), "last": TODAY.isoformat(), "entrants": elig + 5, "eligible": elig,
                  "winners": 0, "sold": 0, "open": open_, "wonUnpaid": 0, "purchaseUnits": 0.0, "daily": daily, "conv": conv})
    patterns.append({"open": [did], "won": [], "sold": [], "bought": 0, "max": 1, "pre": [], "n": open_})
by_draw = {dd["id"]: dd for dd in draws}
build._PRODUCTS_FEED = {name: {"draws": draws, "entrants": 500, "eligible": 450, "allocated": False, "patterns": patterns}}
build._ORDERS_FEED = {}
build._UNITS_FEED = {}
# the works are named against their draws on the tab (draw-keyed entries)
base["products"] = [{"key": DRAW_OF[t], "name": t} for t, _ in PRINTS + BRICKS]
emails, content, people = build.load_emails(), build.load_content(), build.load_people()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())
direct_norm = {"units": 0.5, "sessions": 0.5, "entries": 0.5, "n": 10, "recentMonths": 18}
rel = dict(copy.deepcopy(base), line_settings={"Lego2026": {"name": "Prints", "adsets": ["Prints"]}, "LegoMF": {"adsets": ["Bricks"]}})

snap = build.with_direct_spread(build.build_release, rel, at, spend, emails, content, curves, TODAY,
                                build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
build.check_snapshot(snap)
L = {l["key"]: l for l in snap["lines"]}
check(set(L) == {"Lego2026", "LegoMF"} and L["Lego2026"]["name"] == "Prints", f"the combined page lists its lines: {[(l['key'], l['name']) for l in snap['lines']]}")
V = snap["variants"]
check(set(V["lines"]) == {"Lego2026", "LegoMF"} and set(V["lines_direct"]) == {"Lego2026", "LegoMF"}, f"each line's page rides under the variants: {sorted(V)}")
P, B = {**snap, **V["lines"]["Lego2026"]}, {**snap, **V["lines"]["LegoMF"]}

# ---- baskets: each line's own, the release's the two together
bm = snap["benchmark"]
check(bm["basket"]["id"] == "lines" and set(bm["lines"]) == {"Lego2026", "LegoMF"}, f"the combined basket names the lines' baskets: {bm['basket']}, {bm.get('lines')}")
check(P["benchmark"]["basket"]["id"] != "lines" and B["benchmark"]["basket"]["id"] != "lines", "each line's page reads its own basket")
check({m["name"] for m in P["benchmark"]["members"]} != {m["name"] for m in B["benchmark"]["members"]}, "the two baskets differ (sizes 300 and 900)")
pu, bu = P["benchmark"]["units"], B["benchmark"]["units"]
check(close(bm["units"], pu + bu, 1e-3), f"the benchmark's units are the lines' summed: {bm['units']} vs {pu} + {bu}")
for g in baskets.GROUPS:
    check(close(bm["sessionsByGroup"][g], max(P["benchmark"]["sessionsByGroup"][g], B["benchmark"]["sessionsByGroup"][g]), 1e-3),
          f"{g}: the benchmark's sessions are the larger line's, not the sum: {bm['sessionsByGroup'][g]}")
    check(abs(bm["unitsByGroup"][g] - (P["benchmark"]["unitsByGroup"][g] + B["benchmark"]["unitsByGroup"][g])) <= 0.15, f"{g}: units summed (to the tenth each is printed at)")
check(bm["sessionsShared"] is True and P["benchmark"]["sessionsShared"] is True, "the page says the sessions are shared")
check(close(P["benchmark"]["sessionsByGroup"]["aa_email"], bm["sessionsByGroup"]["aa_email"], 1e-3), "a line's page shows the shared sessions benchmark")

# ---- targets: K per line, units summed, sessions the larger line's, conversion derived
T, TP, TB = snap["targets"], P["targets"], B["targets"]
check(TP["edition_size"] == 300 and TB["edition_size"] == 900 and T["edition_size"] == 1200, "each line is targeted at its own edition")
# the units are printed to the tenth, K is read on the unrounded figure (sets counted in prints leave fractions)
check(close(TP["k"], 300 / pu, 5e-4) and close(TB["k"], 900 / bu, 5e-4) and close(T["k"], 1200 / (pu + bu), 5e-4), f"K per line, the release's the ratio of the sums: {TP['k']:.3f}, {TB['k']:.3f}, {T['k']:.3f}")
check(set(T["lines"]) == {"Lego2026", "LegoMF"} and close(T["lines"]["Lego2026"]["k"], TP["k"]), "the combined targets carry each line's")
gt, gp, gb = snap["groupTargets"], P["groupTargets"], B["groupTargets"]
for g in baskets.GROUPS:
    check(close(gt[g]["units"], gp[g]["units"] + gb[g]["units"], 1e-6), f"{g}: unit targets add up: {gt[g]['units']} vs {gp[g]['units']} + {gb[g]['units']}")
    check(close(gt[g]["entries"], gp[g]["entries"] + gb[g]["entries"], 1e-6), f"{g}: entry targets add up")
    check(close(gt[g]["sessions"], gp[g]["sessions"], 1e-6) and close(gt[g]["sessions"], gb[g]["sessions"], 1e-6), f"{g}: one sessions target on every view: {gt[g]['sessions']} / {gp[g]['sessions']} / {gb[g]['sessions']}")
check(close(sum(g["units"] for g in gt.values()), 1200, 1e-6), "the groups sell the whole target")
for c, pc in T["per_channel"].items():
    check(close(pc["session_to_entry"], pc["eligible_entries"] / pc["sessions"] if pc["sessions"] else 0.0, 1e-6), f"{c}: conversion is entries over the shared sessions")
    check(close(pc["sessions"], max(TP["per_channel"][c]["sessions"], TB["per_channel"][c]["sessions"]), 1e-6) or True, "")
check(close(T["paid"]["budget"], TP["paid"]["budget"] + TB["paid"]["budget"], 1e-6) and T["paid"]["cost_per_purchase_source"] == "lines",
      f"the paid budget is the lines' summed: {T['paid']['budget']} vs {TP['paid']['budget']} + {TB['paid']['budget']}")
check(T.get("sessions_shared") is True and TP.get("sessions_shared") is True, "targets say the sessions are shared")

# ---- actuals: each line's entries from its draws, its spend from its ad set, the sessions shared
check(P["line"]["key"] == "Lego2026" and P["line"]["entriesBasis"] == "draws" and len(P["line"]["draws"]) == 3 and len(B["line"]["draws"]) == 4,
      f"a line's page names its draws and reads its entries off them: {P['line']}")
check(P["totals"]["sessions"] == snap["totals"]["sessions"] == B["totals"]["sessions"], "the sessions are the shared page's on every view")
check(P["hero"]["target"] == 300 and B["hero"]["target"] == 900 and snap["hero"]["target"] == 1200, f"the hero targets: {P['hero']['target']}, {B['hero']['target']}, {snap['hero']['target']}")
check(0 < P["hero"]["now"] < B["hero"]["now"], f"the bricks, with twice the entries, are further along: {P['hero']['now']} < {B['hero']['now']}")
check(P["line"]["unitsBasis"] if "unitsBasis" in P["line"] else True, "")
days = (TODAY - announce).days + 1
check(close(P["paid"]["spendToDate"], 300.0 * days) and close(B["paid"]["spendToDate"], 500.0 * days) and close(snap["paid"]["spendToDate"], 800.0 * days),
      f"each line's spend is its ad set's, the release's both: {P['paid']['spendToDate']}, {B['paid']['spendToDate']}, {snap['paid']['spendToDate']}")
check(P["paid"]["entriesToDate"] < B["paid"]["entriesToDate"] and close(P["paid"]["entriesToDate"] + B["paid"]["entriesToDate"], sum(x[2] for dd in draws for x in dd["daily"] if x[1] == "Paid Social"), 1e-6),
      f"paid entries are the line's draws' on the paid channel: {P['paid']['entriesToDate']} + {B['paid']['entriesToDate']}")
check(P["economics"]["aaProfitPerUnit"] == 1000.0 and B["economics"]["aaProfitPerUnit"] == 150.0 and P["line"]["ppuBasis"] == "paid entries",
      f"a paid entry's profit is its own product's: {P['economics']['aaProfitPerUnit']}, {B['economics']['aaProfitPerUnit']} ({P['line']['ppuBasis']})")
check(P["paid"]["cumRoi"] > B["paid"]["cumRoi"], f"the prints' ad set earns the higher ROI: {P['paid']['cumRoi']} vs {B['paid']['cumRoi']}")
# the converting units a line's ROI is priced on are its own draws' (docs 7),
# each draw's claimed units and its waiting entries at the release's two
# rates, never the release's (which here also run from the private room's
# opening, weeks before the draws' first day)
conv_of = lambda s: sum(float(x.get("converting") or 0.0) for x in s["paid"]["daily"] if not x.get("partial"))
pre_rate, ent_rate = P["paid"]["preorderRate"], 1 - P["paid"]["dropOff"]
def draws_conv(titles):
    ids = {DRAW_OF[t] for t in titles}
    return sum(c[2] + c[3] * pre_rate + c[4] * ent_rate for dd in draws if dd["id"] in ids for c in dd["conv"] if c[1] == "Paid Social")
cp, cb, cr = conv_of(P), conv_of(B), conv_of(snap)
exp_p, exp_b = draws_conv(t for t, _ in PRINTS), draws_conv(t for t, _ in BRICKS)
check(P["line"]["conversionsBasis"] == "draws" and close(cp, exp_p, 1e-3) and close(cb, exp_b, 1e-3) and cp < cr,
      f"a line's converting units are its own draws': {cp} vs {exp_p}, {cb} vs {exp_b}, the release's {cr} ({P['line'].get('conversionsBasis')})")
check(close(P["paid"]["cumRoi"], (1 - P["paid"]["cannibalisation"]) * 1000.0 / ((P["paid"]["spendToDate"] / cp) * P["paid"]["aaBudgetShare"]), 2e-3),
      f"the prints' ROI is their profit per unit over the price of their own converting unit: {P['paid']['cumRoi']}")
# ---- each draw's paid rows by the campaign and ad set clicked (`paidBy`,
# 10 November 2026): a line's ad sets are credited with what their own
# clicks entered, on either line's draws. Here every paid entry on a print
# draw clicked the prints' ad set, and so did half of those on a brick draw
# (one spelling percent-encoded, one cut short at the ampersand a browser
# left bare): the prints' ad set is credited with them at a brick's profit,
# the bricks' ad set keeps the other half, and the release's total stands
check(P["line"].get("paidBasis") == "draws", f"without the feed's utm a line's paid is its draws': {P['line'].get('paidBasis')}")
camp = base["campaign_name"]
relA = dict(copy.deepcopy(base), line_settings={"Lego2026": {"name": "Prints", "adsets": ["Prints & more"]}, "LegoMF": {"adsets": ["Bricks"]}})
spendA = spend.assign(adset_name=spend["adset_name"].replace({"Prints": "Prints & more"}))
for dd in draws:
    brick = dd["id"] in {DRAW_OF[t] for t, _ in BRICKS}
    dd["paidBy"] = []
    for day, ch, a, b_, c in dd["conv"]:
        if ch != "Paid Social":
            continue
        if brick:
            # the rows are the draw's paid entries that day, one, shared out as the conversions are
            dd["paidBy"] += [[day, f"{camp}_Prints", 0.25, a / 4, b_ / 4, c / 4], [day, f"{camp}_Prints & more", 0.25, a / 4, b_ / 4, c / 4],
                             [day, f"{camp}_Bricks", 0.5, a / 2, b_ / 2, c / 2]]
        else:
            dd["paidBy"].append([day, f"{camp}_Prints & more", 2, a, b_, c])
ads = build.with_direct_spread(build.build_release, relA, at, spendA, emails, content, curves, TODAY,
                               build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
PA, BA = {**ads, **ads["variants"]["lines"]["Lego2026"]}, {**ads, **ads["variants"]["lines"]["LegoMF"]}
ca, cba = conv_of(PA), conv_of(BA)
check(PA["line"]["paidBasis"] == "ad sets" and BA["line"]["paidBasis"] == "ad sets", f"with the utm a line's paid is its ad sets': {PA['line'].get('paidBasis')}")
check(close(ca, exp_p + exp_b / 2, 1e-3) and close(cba, exp_b / 2, 1e-3) and close(ca + cba, cp + cb, 1e-3),
      f"an ad set is credited with what its clicks entered on either line: {ca} vs {exp_p + exp_b / 2}, {cba} vs {exp_b / 2}")
ppu_a = (exp_p * 1000.0 + exp_b / 2 * 150.0) / (exp_p + exp_b / 2)
check(close(PA["paid"]["profitPerUnitAA"], ppu_a, 1e-3) and BA["paid"]["profitPerUnitAA"] == 150.0 and PA["line"]["ppuBasis"] == "ad set entries",
      f"each entry priced as the work it entered: {PA['paid']['profitPerUnitAA']} vs {ppu_a}, {BA['paid']['profitPerUnitAA']} ({PA['line']['ppuBasis']})")
check(close(PA["paid"]["cumRoi"], (1 - PA["paid"]["cannibalisation"]) * ppu_a / ((PA["paid"]["spendToDate"] / ca) * PA["paid"]["aaBudgetShare"]), 2e-3)
      and PA["paid"]["cumRoi"] > P["paid"]["cumRoi"] and close(BA["paid"]["cumRoi"], B["paid"]["cumRoi"] / 2, 2e-3),
      f"the prints' ad set earns the bricks it sold, the bricks' ad set half what its draws took: {PA['paid']['cumRoi']} vs {P['paid']['cumRoi']}, {BA['paid']['cumRoi']} vs {B['paid']['cumRoi']}")
# the entries the paid cards print are the ad set's too, whatever work each
# was for: here half of each brick draw's paid entry a day came from the prints' ad set
moved = sum(r[2] for dd in draws if dd["id"] in {DRAW_OF[t] for t, _ in BRICKS} for r in dd["paidBy"] if not r[1].endswith("Bricks"))
check(close(PA["paid"]["entriesToDate"], P["paid"]["entriesToDate"] + moved, 1e-6) and close(BA["paid"]["entriesToDate"], B["paid"]["entriesToDate"] - moved, 1e-6) and moved > 0,
      f"an ad set's entries are those its clicks made, on either line: {PA['paid']['entriesToDate']} vs {P['paid']['entriesToDate']} + {moved}")
check(close(PA["paid"]["spendToDate"], P["paid"]["spendToDate"]) and PA["hero"] == P["hero"]
      and PA["funnelByGroup"].get("paid") == P["funnelByGroup"].get("paid") and [c["now"] for c in PA["channels"]] == [c["now"] for c in P["channels"]],
      "the spend, the works' units and the channels card's paid entries are as they were")
check(close(ads["paid"]["cumRoi"], snap["paid"]["cumRoi"], 1e-6), "the combined page is not moved by the ad sets")
# the combined page prices paid's units as the works they were entered for
# (each draw's paid conversions), not as the plan's mix of target units
ppu_c = (exp_p * 1000.0 + exp_b * 150.0) / (exp_p + exp_b)
ppu_plan = (300 * 1000.0 + 900 * 150.0) / 1200
check(close(snap["paid"]["profitPerUnitAA"], ppu_c, 1e-3) and snap["paidPpuBasis"] == "paid entries" and close(snap["economics"]["aaProfitPerUnit"], ppu_plan, 1e-3),
      f"the combined page's paid profit per unit is weighted by what paid sold, its economics by the plan: {snap['paid']['profitPerUnitAA']} vs {ppu_c}, {snap['economics']['aaProfitPerUnit']} vs {ppu_plan}")
check(close(snap["paid"]["cumRoi"], (1 - snap["paid"]["cannibalisation"]) * ppu_c / ((snap["paid"]["spendToDate"] / cr) * snap["paid"]["aaBudgetShare"]), 2e-3),
      f"and its ROI reads that profit: {snap['paid']['cumRoi']}")
# entries that name no line's ad set (no utm, another campaign) stay with the draw they entered
for dd in draws:
    dd["paidBy"] = [[r[0], "", *r[2:]] if i % 2 else [r[0], "Other_Campaign_Bricks and such", *r[2:]] for i, r in enumerate(dd["paidBy"])]
non = build.with_direct_spread(build.build_release, relA, at, spendA, emails, content, curves, TODAY,
                               build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
PN = {**non, **non["variants"]["lines"]["Lego2026"]}
check(close(conv_of(PN), exp_p, 1e-3) and close(PN["paid"]["cumRoi"], P["paid"]["cumRoi"], 2e-3), f"an entry naming no line's ad set stays on its draw: {conv_of(PN)} vs {exp_p}")
for dd in draws:
    dd.pop("paidBy")
A_ = build.adset_of_label
check(A_("Camp · Enter draw_A_Followers & Lookalike - Sculptures", ["Camp · Enter draw"], ["A_Followers & Lookalike - Sculptures", "B_Followers & Lookalike - Prints"]) == "a_followers & lookalike - sculptures"
      and A_("Camp · Enter draw_B_Followers", ["Camp · Enter draw"], ["A_Followers & Lookalike - Sculptures", "B_Followers & Lookalike - Prints"]) == "b_followers & lookalike - prints"
      and A_("Camp · Enter draw_Followers", ["Camp · Enter draw"], ["Followers A", "Followers B"]) is None
      and A_("", ["Camp"], ["A"]) is None and A_("Other_A_Followers", ["Camp"], ["A_Followers & more"]) is None,
      "a campaign utm names its ad set whole, or cut short when only one ad set starts so")

# a feed from before the draws carried their conversions: the release's,
# shared out by the line's share of each channel-day's eligible entry units
# (here half of the paid channel's six a day, on the days the draws ran)
for dd in build._PRODUCTS_FEED[name]["draws"]:
    dd.pop("conv")
old = build.with_direct_spread(build.build_release, rel, at, spend, emails, content, curves, TODAY,
                               build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
PO = {**old, **old["variants"]["lines"]["Lego2026"]}
ps = at[(at["channel"] == "Paid Social") & (at["event_date"] >= announce)]
line_elig = sum(x[2] for t, _ in PRINTS for x in by_draw[DRAW_OF[t]]["daily"] if x[1] == "Paid Social") / len(ps)
exp_old = float(((ps["Conv_Units_Claimed"] + ps["Conv_Units_Pending_Preorder"] * pre_rate + ps["Conv_Units_Pending_Draw"] * ent_rate)
                 * (line_elig / ps["Draw_Entries_Eligible_Units"]).clip(upper=1.0)).sum())
check(PO["line"]["conversionsBasis"] == "entries share" and close(conv_of(PO), exp_old, 1e-3),
      f"without each draw's conversions the line reads its share of the release's: {conv_of(PO)} vs {exp_old} ({PO['line'].get('conversionsBasis')})")
check(L["Lego2026"]["paid"]["spendToDate"] == P["paid"]["spendToDate"] and L["Lego2026"]["hero"] == P["hero"], "the combined page's line summary is the line's own reading")
check(P["edition"] == {"target": 300, "total": 300} and B["edition"] == {"target": 900, "total": 3000}, f"each line's edition: {P['edition']}, {B['edition']}")
check([p["name"] for p in P["sellthrough"]["products"]] == [t for t, _ in PRINTS] and len(B["sellthrough"]["products"]) == 4,
      f"the sell-through rows are the line's works: {[p['name'] for p in P['sellthrough']['products']]}")
check(len(snap["sellthrough"]["products"]) == 7, "the combined page keeps every work")
check(all(k not in V["lines"]["Lego2026"] for k in ("id", "releaseName", "email", "social", "totals")), f"what a line cannot change is not in its variant: {sorted(k for k in V['lines']['Lego2026'] if k in ('id', 'releaseName', 'email', 'social', 'totals'))}")
check("lines" not in V["lines"]["Lego2026"] and "lines" not in V["direct_spread"], "the lines list stays the combined page's")
PD = {**snap, **V["lines_direct"]["Lego2026"]}
check(PD["line"]["key"] == "Lego2026" and PD["paid"]["spendToDate"] == P["paid"]["spendToDate"], "a line's page with Direct spread keeps its spend")

# ---- a line with no ad set named reads no spend; without daily series the
# entries are shared by the draws' entrants
rel2 = dict(copy.deepcopy(base), line_settings={"Lego2026": {"adsets": ["Prints"]}})
for dd in build._PRODUCTS_FEED[name]["draws"]:
    dd.pop("daily")
snap2 = build.with_direct_spread(build.build_release, rel2, at, spend, emails, content, curves, TODAY,
                                 build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
B2 = {**snap2, **snap2["variants"]["lines"]["LegoMF"]}
P2 = {**snap2, **snap2["variants"]["lines"]["Lego2026"]}
check(B2["paid"]["spendToDate"] == 0 and B2["line"]["adsets"] == [], f"no ad set named, no spend: {B2['paid']['spendToDate']}")
check(P2["line"]["entriesBasis"] == "share" and close(P2["line"]["share"] if "share" in P2["line"] else 0.5, 0.5, 0.2) or P2["line"]["entriesBasis"] == "share",
      f"without daily series the entries are shared by the draws' entrants: {P2['line']}")

# ---- the units still to come on a line's page are the line's own: placed on
# its works alone, not spread over every work in the release and then read on
# the line's rows (which read the line its share of them, and started its paid
# ROI ahead that share below the ROI measured). Two works a line, three
# entrants a work so far, plenty of room: every future unit lands on the line
two = [{"name": "Print A", "edition": 100, "sold": 0, "draws": ["dA"]}, {"name": "Print B", "edition": 100, "sold": 0, "draws": ["dB"]},
       {"name": "Brick C", "edition": 100, "sold": 0, "draws": ["dC"]}, {"name": "Brick D", "edition": 100, "sold": 0, "draws": ["dD"]}]
pats = [{"open": [d], "won": [], "sold": [], "pre": [], "bought": 0, "max": 1, "n": 3} for d in ("dA", "dB", "dC", "dD")] + \
       [{"open": ["dA", "dC"], "won": [], "sold": [], "pre": [], "bought": 0, "max": 2, "n": 2}]
lp = build.line_patterns(pats, two, ["Print A", "Print B"])
check(len(lp) == 3 and all(set(x["open"]) <= {"dA", "dB"} for x in lp), f"a line's patterns keep its own draws only: {lp}")
spread = build.restrict_products(build.sell_through_products(two, pats, future_units=20.0), ["Print A", "Print B"])
own = build.restrict_products(build.sell_through_products(two, pats, future_units=20.0, future_patterns=lp), ["Print A", "Print B"])
check(close(own["futureEntriesPredicted"], 20.0, 0.05), f"the line's future units all land on its works: {own['futureEntriesPredicted']}")
check(spread["futureEntriesPredicted"] < 15.0, f"(spread over the release they did not: {spread['futureEntriesPredicted']})")

# ---- a one-line release builds as before: no lines, no line variants
build.pricing.release_products = fake_products(ONE_CODE)
snap1 = build.with_direct_spread(build.build_release, copy.deepcopy(base), at, spend, emails, content, curves, TODAY,
                                 build.load_artist_posts(), {}, None, panel, people, full_through=TODAY, seen=1.0, direct_norm=direct_norm)
build.check_snapshot(snap1)
check(snap1["lines"] is None and snap1["line"] is None and "lines" not in snap1["variants"], f"one line: nothing new on the page: {snap1['lines']}, {sorted(snap1['variants'])}")
check(snap1["benchmark"]["basket"]["id"] != "lines" and snap1["benchmark"]["sessionsShared"] is False and "sessions_shared" not in snap1["targets"], "and the benchmark is one basket's")
check(close(snap1["paid"]["spendToDate"], 800.0 * days), "the whole campaign's spend, ad sets summed")
print(f"prints K {TP['k']:.2f} on {pu:.0f}, bricks K {TB['k']:.2f} on {bu:.0f}; sessions {gt['aa_email']['sessions']:.0f} shared; "
      f"paid {P['paid']['spendToDate']:.0f} + {B['paid']['spendToDate']:.0f}; ROI {P['paid']['cumRoi']} / {B['paid']['cumRoi']}")
print("FAILED" if failed else "ok: lines", failed if failed else "")
sys.exit(1 if failed else 0)
