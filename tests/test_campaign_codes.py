#!/usr/bin/env python3
"""Campaign codes from the release's own feeds before the guess (docs 11b).

guess_code rejects the real code in several ways (the planning year,
JeffKoons_LE_25 on a 2026 Q1 launch; a short stub, LY_LE_26; a stub that is
not the artist's name, PietParra), which left 30-odd pages without sends,
posts or Meta spend while their orders named the code. source_campaign_codes
takes the orders feed's code, else the matched Airtable launch's, when
exactly one code the feeds use is that code; keeps a group show's shared code
off every page; and says where each code came from. unclaimed_draw_campaigns
warns of a draw campaign the orders tie to one release that no page claims.

A code is typed, and not every one is shaped Artist_Middle_26 (16 November
2026: FerrariSh_LE_Repeat26, AiWeiwei_Lego_2026). The orders' code is taken
whatever its shape when the feeds use it (feed_codes); a guess that is the
artist's earlier launch's code is dropped; and a configured release saved
under such a guess, or under nothing, is built under its orders' code
(settle_configured_codes) with the saved file left as it is.
Synthetic feeds; the Airtable match is stubbed (etl/pricing.py has its own
tests). python3 tests/test_campaign_codes.py (needs pandas)"""
import contextlib, copy, io, pathlib, sys
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

def rec(name, code=None, announce="2026-02-20", close="2026-03-15"):
    parts = name.split(" · ")
    return {"id": build.slugify(name), "release_name": name, "artist": parts[0], "title": " · ".join(parts[1:-1]),
            "quarter": parts[-1], "type": "LE", "campaign_code": code, "code_source": "guess" if code else None,
            "announce_date": announce, "launch_end": close}

KOONS = "Jeff Koons · Multiple · 2026 Q1"
KAI = "Kaï · Content · 2024 Q2"
RIDLER = "Anna Ridler · Price per Stem · 2025 Q1"
AMPH = ["Adam Pendleton · Multiple · 2025 Q1", "Jenny Holzer · Multiple · 2025 Q1", "Josh Smith · Multiple · 2025 Q1"]
CONDO = "George Condo · Fashion Model · 2025 Q1"
EDDIE = "Eddie Martinez · Scaffold · 2024 Q2"
LONE = "Lone Artist · Unsent · 2026 Q1"
TWO = "Twin Artist · Two Codes · 2026 Q1"
TYPED = "Glenn Ligon · Other Work · 2026 Q3"   # GlennLigon_LE_26 is the configured Glenn Ligon · Multiple · 2026 Q3's
CASE = "Case Artist · Cases · 2026 Q1"

ORDERS = {KOONS: ["JeffKoons_LE_25"], KAI: ["Kai_Content_24"], **{a: ["Multiple_Amphorae_24"] for a in AMPH},
          CONDO: ["GeorgeCondo_Model_25"], EDDIE: ["EddieMart_Scaffold_24"], LONE: ["LoneArt_LE_26"],
          TWO: ["TwinArt_LE_26", "TwinArt_PE_26"], TYPED: ["GlennLigon_LE_26"], CASE: ["CaseArt_LE_26"]}
AIRTABLE = {KOONS: "JeffKoonsLE25", KAI: "KaiContent24", RIDLER: "AnnaRidlePriceStem24",
            **{a: "MultipleAmphorae24" for a in AMPH}, TWO: "TwinArtPE26", LONE: "LoneArtLE26"}
# the codes the sends, posts and release inputs use, and Meta's campaign names
CODES = {"JeffKoons_LE_25", "KAI_CONTENT_24", "AnnaRidle_PriceStem_24", "Multiple_Amphorae_24", "GeorgeCondo_Model_25",
         "EDDIE_SCAFFOLD_24", "TwinArt_PE_26", "CASEART_LE_26", "Caseart_LE_26"}
SPEND = pd.DataFrame({"campaign_name": ["EddieMart_Scaffold_24 · Purchases", "GlennLigon_LE_26 · Enter draw",
                                        "JeffKoons_LE_25 · Enter draw"],
                      "spend_date": [date(2024, 6, 1), date(2026, 8, 20), date(2026, 3, 1)], "spend": [100.0, 200.0, 300.0]})

real_match = build.pricing.match
build.pricing.match = lambda frame, lf: pd.DataFrame(
    {"airtable_release": [AIRTABLE.get(n, np.nan) for n in frame["release_name"]]}, index=frame.index)
try:
    recs = [rec(KOONS), rec(KAI), rec(RIDLER), *[rec(a) for a in AMPH], rec(CONDO, "GeorgeCondo_Model_25"),
            rec(EDDIE, "EDDIE_SCAFFOLD_24"), rec(LONE), rec(TWO), rec(TYPED), rec(CASE)]
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        got = build.source_campaign_codes(recs, set(CODES), pd.DataFrame({"x": [1]}), SPEND, orders=ORDERS)
    by = {r["release_name"]: r for r in recs}
    check(by[KOONS]["campaign_code"] == "JeffKoons_LE_25" and by[KOONS]["code_source"] == "orders",
          f"the orders' code, which the guess rejects on its year: {by[KOONS]}")
    check(build.guess_code("Jeff Koons", "Multiple", 2026, set(CODES)) is None, "the guess alone finds nothing")
    check(by[KAI]["campaign_code"] == "KAI_CONTENT_24" and by[KAI]["code_source"] == "orders",
          f"in the spelling the sends use: {by[KAI]}")
    check(by[RIDLER]["campaign_code"] == "AnnaRidle_PriceStem_24" and by[RIDLER]["code_source"] == "airtable",
          f"no orders code: the matched Airtable launch's: {by[RIDLER]}")
    check(all(by[a]["campaign_code"] is None and by[a]["code_source"] is None for a in AMPH),
          f"a group show's code is nobody's: {[by[a]['campaign_code'] for a in AMPH]}")
    check(by[CONDO]["campaign_code"] == "GeorgeCondo_Model_25" and by[CONDO]["code_source"] == "orders",
          f"a guess the orders confirm is marked so: {by[CONDO]}")
    check(by[EDDIE]["campaign_code"] == "EDDIE_SCAFFOLD_24" and by[EDDIE]["code_source"] == "guess"
          and "EDDIE_SCAFFOLD_24 (guessed) kept - the orders feed gives EddieMart_Scaffold_24" in out.getvalue(),
          f"a guess naming another code stays, and the build says so: {by[EDDIE]} {out.getvalue()!r}")
    check(by[LONE]["campaign_code"] is None, f"a code no feed uses joins nothing and is not taken: {by[LONE]}")
    check(by[TWO]["campaign_code"] == "TwinArt_PE_26" and by[TWO]["code_source"] == "airtable",
          f"two codes on the orders: Airtable decides: {by[TWO]}")
    check(by[TYPED]["campaign_code"] is None, f"a code a configured release carries is its alone: {by[TYPED]}")
    check(by[CASE]["campaign_code"] is None, f"two spellings of the code and neither the orders': no pick: {by[CASE]}")
    check(sorted(got) == sorted([(build.slugify(KOONS), "JeffKoons_LE_25", "orders"),
                                 (build.slugify(KAI), "KAI_CONTENT_24", "orders"),
                                 (build.slugify(RIDLER), "AnnaRidle_PriceStem_24", "airtable"),
                                 (build.slugify(TWO), "TwinArt_PE_26", "airtable")]),
          f"the codes it set, with their sources: {got}")
    # an exact spelling among several wins
    exact = [rec(CASE)]
    with contextlib.redirect_stdout(io.StringIO()):
        build.source_campaign_codes(exact, set(CODES) | {"CaseArt_LE_26"}, None, None, orders=ORDERS)
    check(exact[0]["campaign_code"] == "CaseArt_LE_26", f"the orders' own spelling, when a feed uses it: {exact[0]}")
    # a group show with one member in the funnel: its Airtable launch
    # proposes the group's code, which the orders give three releases
    solo = [rec(AMPH[0])]
    with contextlib.redirect_stdout(io.StringIO()):
        build.source_campaign_codes(solo, set(CODES), pd.DataFrame({"x": [1]}), SPEND,
                                    orders={a: ["Multiple_Amphorae_24"] for a in AMPH} | {AMPH[0]: []})
    check(solo[0]["campaign_code"] is None, f"a code the orders share is nobody's, whichever feed proposes it: {solo[0]}")
    # no Airtable pull on file: the orders alone
    alone = [rec(RIDLER), rec(KOONS)]
    with contextlib.redirect_stdout(io.StringIO()):
        build.source_campaign_codes(alone, set(CODES), None, SPEND, orders=ORDERS)
    check(alone[0]["campaign_code"] is None and alone[1]["campaign_code"] == "JeffKoons_LE_25",
          f"without the launches, only the orders: {alone}")

    # ---- a code of another shape, and a guess that is the artist's earlier launch's (16 November 2026)
    FERRARI, RED = "Ferrari Sheppard · Multiple · 2026 Q4", "Ferrari Sheppard · Put Some Red On It · 2026 Q1"
    LEGO = "Ai Weiwei · Multiple · 2026 Q4"
    PAIR_A, PAIR_B = "Pair Artist · One · 2026 Q4", "Pair Artist · Two · 2026 Q4"
    GONE_OLD, GONE_NEW = "Gone Artist · Old · 2026 Q1", "Gone Artist · New · 2026 Q4"
    orders2 = {FERRARI: ["FerrariSh_LE_Repeat26"], RED: ["FerrariSh_LE_26"], LEGO: ["AiWeiwei_Lego_2026"], PAIR_A: ["PairArt_LE_26"],
               GONE_OLD: ["GoneArt_LE_26"]}
    emails2 = pd.DataFrame({"campaign": ["FerrariSh_LE_Repeat26", "FerrariSh_LE_26", "AiWeiwei_Lego_2026", "FREQ_LE_Bundle", None]})
    content2 = pd.DataFrame({"campaign_code": ["FerrariSh_LE_26", "PairArt_LE_26"]})
    spend2 = pd.DataFrame({"campaign_name": ["FerrariSh_LE_Repeat26 · Enter draw", "FerrariSh_LE_26 · Enter draw", "AiWeiwei_Lego_2026 · Enter draw",
                                             "Ai Weiwei - TEST", "GoneArt_LE_26 · Enter draw"],
                           "spend_date": [date(2026, 11, 12), date(2026, 1, 12), date(2026, 11, 1), date(2025, 11, 11), date(2026, 1, 20)],
                           "spend": [343.0, 8336.0, 41768.0, 4.0, 900.0]})
    raw = build.feed_codes(emails2, content2, None, spend2)
    check(raw == {"FerrariSh_LE_Repeat26", "FerrariSh_LE_26", "AiWeiwei_Lego_2026", "FREQ_LE_Bundle", "PairArt_LE_26", "GoneArt_LE_26"},
          f"every code the feeds carry, whatever its shape: {sorted(raw)}")
    known2 = build.known_codes(emails2, content2, None)
    check("FerrariSh_LE_Repeat26" not in known2 and "AiWeiwei_Lego_2026" not in known2 and "FerrariSh_LE_26" in known2,
          f"the guess still reads only the codes shaped Artist_Middle_26: {sorted(known2)}")

    def recs2():
        return [rec(FERRARI, "FerrariSh_LE_26", "2026-11-10", "2026-12-09"), rec(RED, "FerrariSh_LE_26", "2026-01-08", "2026-01-29"),
                rec(LEGO, None, "2026-10-29", "2026-11-30"), rec(PAIR_A, "PairArt_LE_26", "2026-11-01", "2026-11-25"),
                rec(PAIR_B, "PairArt_LE_26", "2026-11-01", "2026-11-25"), rec(GONE_OLD, "GoneArt_LE_26", "2026-01-10", "2026-02-01"),
                rec(GONE_NEW, "GoneArt_LE_26", "2026-10-01", "2026-10-20")]
    rs, out2 = recs2(), io.StringIO()
    build.CODE_MOVES.clear()
    with contextlib.redirect_stdout(out2):
        got2 = build.source_campaign_codes(rs, known2, None, spend2, orders=orders2, raw=raw)
    by2 = {r["release_name"]: r for r in rs}
    check(by2[FERRARI]["campaign_code"] == "FerrariSh_LE_Repeat26" and by2[FERRARI]["code_source"] == "orders"
          and "FerrariSh_LE_26 (guessed) dropped" in out2.getvalue(),
          f"a guess that is the artist's January launch's gives way to the orders' code, whatever its shape: {by2[FERRARI]} {out2.getvalue()!r}")
    check(by2[RED]["campaign_code"] == "FerrariSh_LE_26" and by2[RED]["code_source"] == "orders", f"and January's launch keeps its own: {by2[RED]}")
    check(by2[LEGO]["campaign_code"] == "AiWeiwei_Lego_2026" and by2[LEGO]["code_source"] == "orders", f"a code with its year in full: {by2[LEGO]}")
    check(by2[PAIR_B]["campaign_code"] == "PairArt_LE_26" and by2[PAIR_B]["code_source"] == "guess",
          f"a guess shared with a launch open at the same time is left alone: {by2[PAIR_B]}")
    check(by2[GONE_NEW]["campaign_code"] is None and by2[GONE_NEW]["code_source"] is None and by2[GONE_OLD]["campaign_code"] == "GoneArt_LE_26",
          f"an earlier launch's code with no orders of this launch's own: no code rather than a wrong one: {by2[GONE_NEW]}")
    check((build.slugify(FERRARI), "FerrariSh_LE_Repeat26", "orders") in got2 and (build.slugify(LEGO), "AiWeiwei_Lego_2026", "orders") in got2,
          f"both are reported as set: {got2}")
    check(sorted((rid, old, new) for rid, old, new, _ in build.CODE_MOVES) == sorted([(build.slugify(FERRARI), "FerrariSh_LE_26", "FerrariSh_LE_Repeat26"),
                                                                                       (build.slugify(GONE_NEW), "GoneArt_LE_26", None)]),
          f"the pages moved off a guess are kept for the build's closing line: {build.CODE_MOVES}")
    # the launch a guess belongs to has no close on file (no campaign clock): the quarters in the two names decide
    HORSE, WINDOW = "Maurizio Cattelan · Multiple · 2026 Q4", "Maurizio Cattelan · Window · 2026 Q1"
    orders_q = {HORSE: ["MaurizioCatt_HorseLE_26"], WINDOW: ["MaurizioC_LE_26"]}
    for other_close, same_quarter, want in ((None, False, "MaurizioCatt_HorseLE_26"), (None, True, "MaurizioC_LE_26"), ("2026-10-20", False, "MaurizioC_LE_26")):
        horse = rec(HORSE if not same_quarter else HORSE.replace("Q4", "Q1"), "MaurizioC_LE_26", "2026-09-21", "2026-10-15")
        window = rec(WINDOW, "MaurizioC_LE_26", None, other_close)
        with contextlib.redirect_stdout(io.StringIO()):
            build.source_campaign_codes([horse, window], {"MaurizioC_LE_26", "MaurizioCatt_HorseLE_26"}, None, None,
                                        orders={horse["release_name"]: orders_q[HORSE], WINDOW: orders_q[WINDOW]})
        check(horse["campaign_code"] == want, f"no close on file for the other launch (close {other_close}, same quarter {same_quarter}): {horse['campaign_code']} != {want}")
    # read by shape alone (no raw codes passed), the orders' code is not found: the earlier launch's guess still goes
    rs = recs2()
    with contextlib.redirect_stdout(io.StringIO()):
        build.source_campaign_codes(rs, known2, None, spend2, orders=orders2)
    by2 = {r["release_name"]: r for r in rs}
    check(by2[FERRARI]["campaign_code"] is None and by2[LEGO]["campaign_code"] is None, f"by shape alone neither is found: {by2[FERRARI]}, {by2[LEGO]}")

    # ---- a configured release saved under a code that cannot be its own
    TICK, HAND, SHARED = "Tick Artist · Work · 2026 Q4", "Hand Artist · Work · 2026 Q4", "Shared Artist · Work · 2026 Q4"
    orders3 = {**orders2, EDDIE: ["EddieMart_Scaffold_24"], TICK: ["TickArt_LE_26"], HAND: ["HandArt_LE_Repeat26"], "Hand Artist · Old · 2026 Q1": ["HandArt_LE_26"],
               SHARED: ["SharedArt_LE_26"]}
    raw3 = raw | {"EDDIE_SCAFFOLD_24", "TickArt_LE_26", "HandArt_LE_Repeat26", "HandArt_LE_26", "SharedArt_LE_26"}

    def saved(i, name, code, names, announce="2026-11-10", close="2026-12-09", **more):
        return {"id": i, "release_name": name, "campaign_code": code, "campaign_names": list(names), "announce_date": announce, "launch_end": close, **more}
    conf = [saved("ferrari", FERRARI, "FerrariSh_LE_26", ["FerrariSh_LE_26 · Enter draw"]),
            saved("red", RED, "FerrariSh_LE_26", ["FerrariSh_LE_26 · Enter draw"], "2026-01-08", "2026-01-29"),
            saved("lego", LEGO, "", [], "2026-10-29", "2026-11-30"),
            saved("eddie", EDDIE, "EDDIE_SCAFFOLD_24", [], "2024-05-01", "2024-05-20"),
            saved("pairb", PAIR_B, "PairArt_LE_26", [], "2026-11-01", "2026-11-25"),
            saved("tick", TICK, "", ["TickArt_LE_26 · Enter draw"]),
            saved("hand", HAND, "HandArt_LE_26", ["HandArt_LE_Repeat26 · Enter draw", "HandArt_LE_26 · Enter draw"]),
            saved("shared", SHARED, "", []), saved("holder", "Holder Artist · Work · 2026 Q4", "SharedArt_LE_26", []),
            saved("timed", "Timed Artist · Work · 2026 Q4", "", [], type="TL")]
    disc3 = [rec(RED, "FerrariSh_LE_26", "2026-01-08", "2026-01-29"), rec("Hand Artist · Old · 2026 Q1", "HandArt_LE_26", "2026-01-05", "2026-01-25"),
             rec(PAIR_A, "PairArt_LE_26", "2026-11-01", "2026-11-25")]
    before = copy.deepcopy(conf)
    out3 = io.StringIO()
    with contextlib.redirect_stdout(out3):
        moved = build.settle_configured_codes(conf, disc3, raw3, orders=orders3)
    c3 = {r["id"]: r for r in conf}
    check(c3["ferrari"]["campaign_code"] == "FerrariSh_LE_Repeat26" and c3["ferrari"]["campaign_names"] == [] and c3["ferrari"]["code_moved"] == {"from": "FerrariSh_LE_26", "to": "FerrariSh_LE_Repeat26"},
          f"saved under the artist's January code: built under its orders' code, the January campaign unticked: {c3['ferrari']}")
    check(c3["lego"]["campaign_code"] == "AiWeiwei_Lego_2026" and c3["lego"]["code_moved"]["from"] is None, f"nothing saved: the orders' code: {c3['lego']}")
    check(c3["hand"]["campaign_code"] == "HandArt_LE_Repeat26" and c3["hand"]["campaign_names"] == ["HandArt_LE_Repeat26 · Enter draw"],
          f"a campaign ticked by hand for the right code stays ticked: {c3['hand']}")
    same = {i: before[k] for k, i in enumerate(r["id"] for r in before)}
    check(all(c3[i] == same[i] for i in ("red", "eddie", "pairb", "tick", "shared", "holder", "timed")),
          f"left alone: its own code, a code typed to join the sends, one with no orders of its own, a ticked campaign that already reads the "
          f"orders' code, a code another configured release carries, a timed launch: {[i for i in same if i not in ('ferrari', 'lego', 'hand') and c3[i] != same[i]]}")
    check(sorted(moved) == sorted([("ferrari", "FerrariSh_LE_26", "FerrariSh_LE_Repeat26"), ("lego", None, "AiWeiwei_Lego_2026"), ("hand", "HandArt_LE_26", "HandArt_LE_Repeat26")])
          and "in place of the saved FerrariSh_LE_26" in out3.getvalue() and "(none was saved)" in out3.getvalue(), f"and it says so: {moved} {out3.getvalue()!r}")
    # the release as resolved: the draw campaign named for the code in force, and where the code came from
    real_products = build.pricing.release_products
    build.pricing.release_products = lambda r, *a, **k: {"match": None, "note": "", "products": [], "launch_date": None, "announce_date": None,
                                                         "private_room_date": None, "marketing_lead": None, "project_manager": None, "pm_slack_id": None}
    try:
        res = build.resolve_release(dict(c3["ferrari"]), spend2, {})
        check(res["campaign_code"] == "FerrariSh_LE_Repeat26" and res["campaign_names"] == ["FerrariSh_LE_Repeat26 · Enter draw"]
              and res["input_sources"]["campaign_code"] == "orders" and res["input_sources"]["campaigns"] == "matched",
              f"resolved: its own draw campaign, the code marked as the orders': {res['campaign_code']}, {res['campaign_names']}, {res['input_sources']}")
        res_red = build.resolve_release(dict(c3["red"]), spend2, {})
        check(res_red["campaign_names"] == ["FerrariSh_LE_26 · Enter draw"] and res_red["input_sources"]["campaign_code"] == "typed", f"the launch whose code it is reads as before: {res_red['input_sources']}")
    finally:
        build.pricing.release_products = real_products

    # the unclaimed draw campaigns
    spend = pd.DataFrame({"campaign_name": ["JeffKoons_LE_25 · Enter draw", "LoneArt_LE_26 · Enter draw",
                                            "Multiple_Amphorae_24 · Draw", "Ghost_LE_26 · Enter draw",
                                            "KaiArt_LE_24 · Purchases", "GlennLigon_LE_26 · Enter draw"],
                          "spend_date": [date(2026, 3, 1)] * 6, "spend": [71089.83, 500.0, 18660.0, 7637.95, 50.0, 900.0]})
    orders = {**ORDERS, "Ghost · Not On File · 2025 Q4": ["Ghost_LE_26"], KAI: ["KaiArt_LE_24"]}
    pages = copy.deepcopy(recs)
    for r in pages:
        r["campaign_name"] = None
    with contextlib.redirect_stdout(io.StringIO()):
        w = build.unclaimed_draw_campaigns(spend, pages, orders=orders)
    check(len(w) == 2 and "'JeffKoons_LE_25 · Enter draw' (EUR 71,090) is the orders feed's code for 'Jeff Koons · Multiple · 2026 Q1'" in w[0]
          and "LoneArt_LE_26" in w[1],
          f"a draw campaign tied to one release on file and claimed by no page warns; a group show's, a release "
          f"with no page, a purchases campaign and a configured release's do not: {w}")
    by = {r["release_name"]: r for r in pages}
    by[KOONS]["campaign_name"] = build.match_campaign(by[KOONS]["campaign_code"], spend)
    with contextlib.redirect_stdout(io.StringIO()):
        w = build.unclaimed_draw_campaigns(spend, pages, orders=orders)
    check(by[KOONS]["campaign_name"] == "JeffKoons_LE_25 · Enter draw" and len(w) == 1 and "LoneArt" in w[0],
          f"once the page reads it, it is claimed: {w}")
    check(build.unclaimed_draw_campaigns(None, pages) == [], "no spend feed, no warning")

    # the page says where its code came from
    DAY = date(2026, 3, 20)
    frame = pd.DataFrame([{"channel": "Direct", "event_date": DAY - timedelta(days=i), "simple_release_name": KOONS,
                           "campaign_stage": None, "Sessions_Total": 10.0, "Total_Product_Units": 0.0,
                           "Product_Units_Private_Room": 0.0, "Draw_Entries_Total_Units_No_Conv": 0.0,
                           "Draw_Entries_Eligible_Units": 0.0} for i in range(40)])
    r = {**by[KOONS], "dates_note": None, "first_seen": "2026-02-10", "last_seen": DAY.isoformat()}
    with contextlib.redirect_stdout(io.StringIO()):
        snap = build.build_actuals(r, frame, spend, build.load_emails(), build.load_content(), DAY)
    check(snap["derived"]["campaign_code"] == "JeffKoons_LE_25" and snap["derived"]["campaign_code_source"] == "orders"
          and snap["campaignName"] == "JeffKoons_LE_25 · Enter draw",
          f"the snapshot carries the code's source: {snap['derived']}")
    rows = build.discover_releases(frame.assign(days_since_announcement=np.nan, days_until_launch=np.nan,
                                                pct_days_since_announcement=np.nan, pct_days_until_launch=np.nan),
                                   DAY, {"JeffKoons_LE_26"})
    check(rows[0]["campaign_code"] == "JeffKoons_LE_26" and rows[0]["code_source"] == "guess",
          f"a guess is marked as one: {rows[0]['campaign_code']} {rows[0]['code_source']}")
finally:
    build.pricing.match = real_match

print(f"{failed} failure(s)" if failed else "ok: campaign codes from the feeds")
sys.exit(1 if failed else 0)
