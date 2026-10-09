#!/usr/bin/env python3
"""The Airtable pull's field resolution (etl/pull_airtable.py required_fields,
check_schema): a required field is taken under its current name, else a
former one (FORMER_NAMES), else the AIRTABLE_FIELD_<column> override, and a
table with none of them stops the pull naming every name tried. No network:
the table's schema is a dict here.  python3 tests/test_airtable_fields.py"""
import os, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pull_airtable as pa

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)

def table(names):
    """A schema of plain text fields, the price field typed as euros."""
    t = {n: {"type": "singleLineText"} for n in names}
    t[pa.PRICE_FIELD] = {"type": "currency", "options": {"symbol": "€"}}
    return t

current = [name for name, _ in pa.FIELDS]
os.environ.pop("AIRTABLE_FIELD_EDITION_SIZE", None)

# the table as it is now: every field under its current name
names, currency, found, absent = pa.check_schema(table(current))
check(names[:len(current)] == current and currency == "EUR", f"current names resolve to themselves: {names[:3]} {currency}")
check(dict((n, c) for n, c, _ in pa.required_fields(table(current)))["Units [Edition Size]"] == "edition_size", "the edition size under its current name")

# the table as it was: "Units" rather than "Units [Edition Size]"
former = [("Units" if n == "Units [Edition Size]" else n) for n in current]
names, _, _, _ = pa.check_schema(table(former))
by_name = {n: c for n, c, _ in pa.required_fields(table(former))}
check("Units" in names and "Units [Edition Size]" not in names and by_name.get("Units") == "edition_size",
      f"the former name is taken when the table has only that: {[n for n in names if 'Unit' in n]}")

# neither: the pull stops, naming both and the override
neither = [n for n in current if n != "Units [Edition Size]"] + ["Units [Produced]"]
try:
    pa.check_schema(table(neither))
    check(False, "a table with neither name should stop the pull")
except SystemExit as e:
    msg = str(e)
    check("'Units [Edition Size]'" in msg and "also tried 'Units'" in msg and "AIRTABLE_FIELD_EDITION_SIZE" in msg,
          f"the stop names every name tried and the override: {msg}")

# the override: the one name tried, whatever the table has
os.environ["AIRTABLE_FIELD_EDITION_SIZE"] = "Edition units"
try:
    with_override = [n for n in current if n != "Units [Edition Size]"] + ["Edition units", "Units"]
    by_name = {n: c for n, c, _ in pa.required_fields(table(with_override))}
    check(by_name.get("Edition units") == "edition_size" and "Units" not in by_name, f"the override wins over a former name: {[n for n in by_name if 'nit' in n]}")
    try:
        pa.check_schema(table(former))
        check(False, "an override the table lacks should stop the pull")
    except SystemExit as e:
        check("'Edition units'" in str(e) and "also tried" not in str(e), f"an override is the one name tried: {e}")
finally:
    os.environ.pop("AIRTABLE_FIELD_EDITION_SIZE", None)

# the optional fields under the names the table carries them by (OPTIONAL_ALIASES, 8 October
# 2026): the current name first, then the alias, the first the table has winning, with how the
# field is read; an override is the one name tried; a column under no name is absent
live = current + ["AA split", "Revenue Commission %", "Commission Type", "Profit per unit (excl paid ads)_marketing",
                  "Artist profit per unit (excl. paid ads)_marketing", "Framing conversion"]
res = {col: name for name, col in pa.resolve_optional(table(live))}
check(res["aa_profit_share"] == "AA split", f"AA split stands in for the profit share: {res['aa_profit_share']}")
check(res["artist_revenue_cut"] == "Revenue Commission %" and res["aa_revenue_share"] == "AA revenue share", f"the revenue commission is its own column, the AA revenue share its own field: {res['artist_revenue_cut']}, {res['aa_revenue_share']}")
check(res["aa_profit_per_unit"] == "Profit per unit (excl paid ads)_marketing" and res["artist_profit_per_unit"] == "Artist profit per unit (excl. paid ads)_marketing", "the marketing profit fields")
check(res["deal_type"] == "Commission Type" and res["frame_conversion"] == "Framing conversion", "the deal type and a field under its current name")
check(res["frame_profit_per_unit"] == "Framing profit per unit", "a field under no name keeps its current one")
res2 = {col: name for name, col in pa.resolve_optional(table(live + ["Blended frame margin"]))}
check(res2["frame_profit_per_unit"] == "Blended frame margin", f"the blended frame margin stands in for the frame profit: {res2['frame_profit_per_unit']}")
# the rollup reads 0 with no frame products linked: no figure
check(pa.flatten(0, "frame_profit_per_unit", [0]) == "" and pa.flatten(0.0, "frame_profit_per_unit", [0]) == "" and pa.flatten(85.5, "frame_profit_per_unit", [0]) == 85.5, "a zero frame margin is no figure")
check(pa.flatten(0, "aa_profit_share", [0]) == 0, "a zero elsewhere stays a zero")
names, _, found, absent = pa.check_schema(table(live))
check(found.get("AA split") == "aa_profit_share" and found.get("Revenue Commission %") == "artist_revenue_cut" and "AA split" in names, f"the aliases are requested: {sorted(found)}")
check("Framing profit per unit" in absent and "Target sell-through %" in absent and "AA revenue share" in absent and "AA profit share" not in absent, f"absent names the ones under no name: {absent}")
check("Framing profit per unit" not in pa.check_schema(table(live + ["Blended frame margin"]))[3], "found under its alias, the frame profit is not absent")
both = pa.resolve_optional(table(live + ["AA profit share"]))
check(dict((c, n) for n, c in both)["aa_profit_share"] == "AA profit share", "the current name wins when the table has both")
os.environ["AIRTABLE_FIELD_AA_PROFIT_SHARE"] = "Our split"
try:
    res = {col: name for name, col in pa.resolve_optional(table(live + ["Our split"]))}
    check(res["aa_profit_share"] == "Our split", f"an override is the one name tried: {res['aa_profit_share']}")
finally:
    os.environ.pop("AIRTABLE_FIELD_AA_PROFIT_SHARE", None)

# a money figure typed as text (the _marketing fields are text): its number, in euros
hits = [0]
check(pa.flatten("€450", "aa_profit_per_unit", hits) == 450.0 and pa.flatten("€1,250.50", "artist_profit_per_unit", hits) == 1250.5, "euros as text")
check(pa.flatten("450", "aa_profit_per_unit", hits) == 450.0 and pa.flatten(" 1,000 ", "aa_profit_per_unit", hits) == 1000.0, "a bare figure is euros")
check(pa.flatten("£100", "aa_profit_per_unit", hits) == 118.0 and pa.flatten("100 GBP", "aa_profit_per_unit", hits) == 118.0, "pounds at the pricing rate")
check(pa.flatten("tbc", "aa_profit_per_unit", hits) == "" and pa.flatten("", "aa_profit_per_unit", hits) == "", "no figure, nothing")
check(pa.flatten(450, "aa_profit_per_unit", hits) == 450 and hits[0] == 0, "a number stays a number")
# the commission is a percent like the shares: 15 typed as a whole number is 0.15
check(pa.flatten(0.15, "artist_revenue_cut", hits) == 0.15 and pa.flatten(15, "artist_revenue_cut", hits) == 0.15, "the cut as a fraction")

# a column list unchanged by the rename: the CSV header is the columns, not the names
cols = [c for _, c in pa.FIELDS]
check("edition_size" in cols and cols.index("edition_size") == cols.index("unit_status") - 1, "the CSV column is edition_size, in its place")

print("FAILED" if failed else "ok: airtable field resolution", failed if failed else "")
sys.exit(1 if failed else 0)
