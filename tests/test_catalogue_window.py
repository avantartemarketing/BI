#!/usr/bin/env python3
"""A catalogue page counts its own 90 days (docs 6.3).

A synthetic back-catalogue release shaped like George Condo's 2024 Q1: two
draws allocated in March 2024 whose losers are still "open" in the draw feed,
both editions sold out long before, no campaign clock, so the page reads the
last 90 days. The secured units must not count those losers (the page read
301 with nothing sold) nor a draft raised months before the window (Slawn,
LY and Takahiro Komuro read 1 with nothing sold); a draft raised inside the
window still counts, and so do the entries of a draw that is running now.
python3 tests/test_catalogue_window.py (needs pandas)"""
import contextlib, io, pathlib, shutil, sys, tempfile
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import numpy as np
import pandas as pd
import build

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)
near = lambda a, b, tol=0.51: a is not None and b is not None and abs(a - b) <= tol

NAME = "Synthetic Old Master · Multiple · 2024 Q1"
DAY = date(2026, 9, 20)
START = DAY - timedelta(days=build.CATALOGUE_DAYS)

def funnel():
    rows, d = [], DAY - timedelta(days=200)
    while d <= DAY:
        for ch in ("Direct", "AA Email Man"):
            rows.append({"channel": ch, "event_date": d, "simple_release_name": NAME, "campaign_stage": None,
                         "Sessions_Total": 2.0, "Total_Product_Units": 0.0, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": 0.0, "Draw_Entries_Eligible_Units": 0.0,
                         "days_since_announcement": np.nan, "days_until_launch": np.nan,
                         "pct_days_since_announcement": np.nan, "pct_days_until_launch": np.nan})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def product(paid, drafts, last_draft, edition=150):
    return {"printsOffered": paid, "frames": 0.0, "entrantPrints": 1.0, "entrantFrames": 0.0, "draftPrints": drafts,
            "draftFrames": 0.0, "unitsPaid": paid, "drafts": drafts, "draftCustomers": drafts, "entryDrafts": 0.0,
            "entrantDrafts": 0.0, "winnerDrafts": 0.0, "winnerDraftsLapsed": 0.0, "refunded": 0.0, "fromDrafts": 0.0,
            "privateRoom": 0.0, "listPrice": 5000.0, "edition": edition, "lastOrder": "2025-03-06",
            "lastDraft": last_draft}

def draw(did, first, last, open_):
    return {"id": did, "first": first, "last": last, "entrants": open_ + 150, "eligible": open_ + 150, "winners": 150,
            "sold": 150, "open": open_, "wonUnpaid": 0, "purchaseUnits": 0.0}

def pat(open_=(), won=(), sold=(), n=1, pre=()):
    return {"open": list(open_), "won": list(won), "sold": list(sold), "bought": len(sold), "max": 1,
            "pre": list(pre), "n": n}

tmp = pathlib.Path(tempfile.mkdtemp())
real_units = build.UNITS_FILE
build.load_orders_feed()
build.load_products_feed()
no_spend = pd.DataFrame(columns=["campaign_name", "spend_date", "spend", "impressions", "reach", "link_clicks"])
emails, content = build.load_emails(), build.load_content()

def install(draws, patterns, products):
    # everything paid in 2024-25, before the window: the release is in the
    # units feed (so the page reads the orders' units) with nothing in its 90 days
    lines = ["release,product_title,order_date,channel,purchase_event,units_paid,units_private_room,prints_offered_paid,frames_paid"]
    for t, p in products.items():
        if p["unitsPaid"]:
            lines.append(f"{NAME},{t},2024-03-22,Direct,true,{int(p['unitsPaid'])},0,{int(p['unitsPaid'])},0")
    (tmp / "units_paid.csv").write_text("\n".join(lines) + "\n")
    build.UNITS_FILE = tmp / "units_paid.csv"
    build._UNITS_FEED = None
    build._ORDERS_FEED[NAME] = {
        "products": products, "draws": {d["id"]: t for d, t in zip(draws, products)},
        "drafts": sum(p["drafts"] for p in products.values()), "unitsPaid": sum(p["unitsPaid"] for p in products.values()),
        "asOf": "2026-08-01", "campaignCode": None,
        "framing": {"prints": 300.0, "frames": 0.0, "notOffered": 0.0,
                    "entrantPrints": float(len(products)), "entrantFrames": 0.0}}
    build._PRODUCTS_FEED[NAME] = {"draws": draws, "entrants": 900, "eligible": 900, "allocated": True, "patterns": patterns}

def page(old_rule=False):
    rec = build.discover_releases(funnel(), DAY, set())[0]
    rec["campaign_name"] = None
    saved = build.entries_in_hand, build._drafts_before
    if old_rule:   # the rule before: every entry and draft on file counted
        build.entries_in_hand = lambda patterns, draws, since: patterns
        build._drafts_before = lambda p, since: False
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            snap = build.with_direct_spread(build.build_actuals, rec, funnel(), no_spend, emails, content, DAY)
            build.check_snapshot(snap)
    finally:
        build.entries_in_hand, build._drafts_before = saved
    return snap

try:
    # 1. George Condo's shape: two draws allocated in March 2024, 371 and 452
    #    losers still open, both editions sold out; one draft on Work A raised
    #    in March 2026 (before the window), two on Work B raised in August
    #    2026 (inside it)
    DRAWS = [draw("d1", "2024-02-15", "2024-03-20", 371), draw("d2", "2024-02-15", "2024-03-20", 452)]
    PATS = [pat(open_=["d1"], n=300), pat(open_=["d2"], n=400), pat(open_=["d1", "d2"], n=71),
            pat(sold=["d1"], n=150), pat(sold=["d2"], n=150)]
    PRODS = {"Work A": product(150.0, 1.0, "2026-03-04"), "Work B": product(150.0, 2.0, "2026-08-01")}
    install(DRAWS, PATS, PRODS)
    K, O = page(), page(old_rule=True)
    st, ost = K["sellthrough"], O["sellthrough"]
    check(K["catalogue"] and K["salesWindow"]["start"] == START.isoformat() and not K["salesWindow"]["closed"],
          f"a catalogue page over its 90 days: {K['salesWindow']}")
    check(st["sold"] == 0 and st["soldPredicted"] == 0 and st["patterns"] == [],
          f"no loser of a 2024 draw is in hand: sold {st['sold']}, predicted {st['soldPredicted']}, patterns {st['patterns']}")
    check(st["drafts"] == 2.0, f"the draft raised before the window is dropped, the two inside it stay: {st['drafts']}")
    check(near(K["hero"]["now"], 2.0), f"secured units, last 90 days: the in-window drafts alone: {K['hero']['now']}")
    oa = st["ordersByProduct"]["Work A"]
    check(oa["drafts"] == 0.0 and oa["draftPrints"] == 0.0 and oa["entrantPrints"] == 0.0
          and st["ordersByProduct"]["Work B"]["drafts"] == 2.0,
          f"the stale product's drafts, and the prints on them, are gone: {oa}")
    check(ost["soldPredicted"] > 250 and near(O["hero"]["now"], 3 + ost["soldPredicted"], 1.0),
          f"the rule before counted the 2024 losers and the old draft: {O['hero']['now']} = 3 + {ost['soldPredicted']}")
    print(f"old-draw catalogue page: secured {O['hero']['now']:.0f} -> {K['hero']['now']:.0f} "
          f"(draw winners {ost['soldPredicted']} -> {st['soldPredicted']}, drafts {ost['drafts']} -> {st['drafts']})")

    # 2. a catalogue page whose draw is running now (no clock yet): its
    #    entries are in hand and count, as before
    CUR = [draw("d3", (DAY - timedelta(days=20)).isoformat(), (DAY - timedelta(days=2)).isoformat(), 60)]
    install(CUR, [pat(open_=["d3"], n=60)], {"Work C": product(0.0, 0.0, None, edition=40)})
    C, CO = page(), page(old_rule=True)
    check(C["sellthrough"]["soldPredicted"] > 0 and C["sellthrough"]["patterns"] == CO["sellthrough"]["patterns"]
          and near(C["hero"]["now"], CO["hero"]["now"]),
          f"a draw inside the 90 days keeps its entries: {C['sellthrough']['soldPredicted']} vs {CO['sellthrough']['soldPredicted']}")

    # 3. the rules on their own
    pats = [pat(open_=["old", "new"], won=["old"], pre=["old", "new"], n=5), pat(open_=["old"], n=9),
            pat(sold=["old"], open_=["new"], n=2), pat(open_=["undated"], n=4)]
    draws = [{"id": "old", "last": "2024-01-10"}, {"id": "new", "last": "2026-09-01"}, {"id": "undated", "last": None}]
    got = build.entries_in_hand(pats, draws, START)
    check(got == [pat(open_=["new"], pre=["new"], n=5), {**pat(open_=["new"], n=2), "bought": 1}, pat(open_=["undated"], n=4)],
          f"a stale draw leaves every list (a purchase through it stays in bought), an emptied pattern goes, "
          f"an undated draw stays: {got}")
    check(build.entries_in_hand(pats[:1], [{"id": "old", "last": "2026-07-01"}], START) == pats[:1],
          "nothing stale, nothing changes")
    check(build._drafts_before({"lastDraft": "2026-03-04"}, START) and not build._drafts_before({"lastDraft": "2026-07-01"}, START)
          and not build._drafts_before({"lastDraft": None}, START) and not build._drafts_before({"lastDraft": "2026-03-04"}, None),
          "a draft is dropped only when its product's last draft is dated before the window")
    # the page on the funnel's units (no units feed): the same draft rule
    install(DRAWS, PATS, PRODS)
    fw = build.orders_in_window(NAME, None, START, DAY, False, "funnel", drafts_since=START)
    check(fw["drafts"] == 2.0 and fw["products"]["Work A"]["drafts"] == 0.0 and fw["framing"]["entrantPrints"] == 1.0,
          f"on the funnel's units too: {fw['drafts']}, {fw['framing']}")
    check(build.orders_in_window(NAME, None, START, DAY, False, "funnel") is build._ORDERS_FEED[NAME],
          "a dated page's record is untouched")
finally:
    build.UNITS_FILE = real_units
    build._UNITS_FEED = None
    build._ORDERS_FEED.pop(NAME, None)
    build._PRODUCTS_FEED.pop(NAME, None)
    shutil.rmtree(tmp, ignore_errors=True)

print(f"{failed} failure(s)" if failed else "ok: a catalogue page counts its 90 days")
sys.exit(1 if failed else 0)
