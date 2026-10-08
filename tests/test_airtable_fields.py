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
res = {col: (name, reading) for name, col, reading in pa.resolve_optional(table(live))}
check(res["aa_profit_share"] == ("AA split", None), f"AA split stands in for the profit share: {res['aa_profit_share']}")
check(res["aa_revenue_share"] == ("Revenue Commission %", "complement"), f"the revenue commission is read as its complement: {res['aa_revenue_share']}")
check(res["aa_profit_per_unit"] == ("Profit per unit (excl paid ads)_marketing", None) and res["artist_profit_per_unit"] == ("Artist profit per unit (excl. paid ads)_marketing", None), "the marketing profit fields")
check(res["deal_type"] == ("Commission Type", None) and res["frame_conversion"] == ("Framing conversion", None), "the deal type and a field under its current name")
check(res["frame_profit_per_unit"] == ("Framing profit per unit", None), "a field under no name keeps its current one")
names, _, found, absent = pa.check_schema(table(live))
check(found.get("AA split") == "aa_profit_share" and found.get("Revenue Commission %") == "aa_revenue_share" and "AA split" in names, f"the aliases are requested: {sorted(found)}")
check("Framing profit per unit" in absent and "Target sell-through %" in absent and "AA profit share" not in absent, f"absent names the ones under no name: {absent}")
both = pa.resolve_optional(table(live + ["AA profit share"]))
check(dict((c, n) for n, c, _ in both)["aa_profit_share"] == "AA profit share", "the current name wins when the table has both")
os.environ["AIRTABLE_FIELD_AA_PROFIT_SHARE"] = "Our split"
try:
    res = {col: (name, reading) for name, col, reading in pa.resolve_optional(table(live + ["Our split"]))}
    check(res["aa_profit_share"] == ("Our split", None), f"an override is the one name tried: {res['aa_profit_share']}")
finally:
    os.environ.pop("AIRTABLE_FIELD_AA_PROFIT_SHARE", None)

# a money figure typed as text (the _marketing fields are text): its number, in euros
hits = [0]
check(pa.flatten("€450", "aa_profit_per_unit", hits) == 450.0 and pa.flatten("€1,250.50", "artist_profit_per_unit", hits) == 1250.5, "euros as text")
check(pa.flatten("450", "aa_profit_per_unit", hits) == 450.0 and pa.flatten(" 1,000 ", "aa_profit_per_unit", hits) == 1000.0, "a bare figure is euros")
check(pa.flatten("£100", "aa_profit_per_unit", hits) == 118.0 and pa.flatten("100 GBP", "aa_profit_per_unit", hits) == 118.0, "pounds at the pricing rate")
check(pa.flatten("tbc", "aa_profit_per_unit", hits) == "" and pa.flatten("", "aa_profit_per_unit", hits) == "", "no figure, nothing")
check(pa.flatten(450, "aa_profit_per_unit", hits) == 450 and hits[0] == 0, "a number stays a number")
# the reading applied in the pull: a 15% commission is an 85% share
check(pa.flatten(0.15, "aa_revenue_share", hits) == 0.15, "the percent itself is read as it comes")

# a column list unchanged by the rename: the CSV header is the columns, not the names
cols = [c for _, c in pa.FIELDS]
check("edition_size" in cols and cols.index("edition_size") == cols.index("unit_status") - 1, "the CSV column is edition_size, in its place")

print("FAILED" if failed else "ok: airtable field resolution", failed if failed else "")
sys.exit(1 if failed else 0)
