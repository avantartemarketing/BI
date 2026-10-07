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

# a column list unchanged by the rename: the CSV header is the columns, not the names
cols = [c for _, c in pa.FIELDS]
check("edition_size" in cols and cols.index("edition_size") == cols.index("unit_status") - 1, "the CSV column is edition_size, in its place")

print("FAILED" if failed else "ok: airtable field resolution", failed if failed else "")
sys.exit(1 if failed else 0)
