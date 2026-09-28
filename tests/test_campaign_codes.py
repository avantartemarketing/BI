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
    # no Airtable pull on file: the orders alone
    alone = [rec(RIDLER), rec(KOONS)]
    with contextlib.redirect_stdout(io.StringIO()):
        build.source_campaign_codes(alone, set(CODES), None, SPEND, orders=ORDERS)
    check(alone[0]["campaign_code"] is None and alone[1]["campaign_code"] == "JeffKoons_LE_25",
          f"without the launches, only the orders: {alone}")

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
