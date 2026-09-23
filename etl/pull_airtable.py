#!/usr/bin/env python3
"""Pull edition pricing for every release from Airtable (the Pipeline table).

Why: the benchmark baskets (docs/BENCHMARK_SPEC.md §3) match past launches on
edition size and shape. Whether price should be part of "comparable" is a
question the funnel export cannot answer - it carries no price and no edition
size for the launches it records - and the targets workbook only prices the
handful of releases with targets set. The Pipeline table in Airtable is where
every edition's retail price, size and launch type live, so it is pulled here,
once per release, into data/release_pricing.csv. The panel builder
(etl/analysis/release_clusters.py) joins that file onto the panel, and
etl/baskets.py reads the price off the panel.

What it pulls, and what it refuses to
  The fields named in FIELDS below: the release's identity (artist, title,
  project code), its price and price status, its edition size, its launch and
  edition type, its launch dates and its medium. Then the OPTIONAL_FIELDS: the
  per-product target economics the dashboard's Target setting tab reads
  (target sell-through, the artist's and Avant Arte's profit per unit, the
  deal's revenue or profit share, the framing assumptions) and the marketing
  lead. Those are pulled when the table has them and left blank when it does
  not, so the pull works while the fields are still being added; a field
  under another name is pointed at with AIRTABLE_FIELD_<column> in the
  environment (AIRTABLE_FIELD_MARKETING_LEAD="Marketing owner").

  The table has four hundred fields, and many of the others are about people:
  collaborators, modifiers, Slack ids, and lookups of the artist's ethnicity
  and gender. None of that is needed, so none of it is requested, and the
  guard in `check_schema` refuses to run if a wanted field turns out to hold
  a person (a collaborator, email, phone, or lookup of one) - a field can be
  retyped in Airtable without anyone here noticing. The one exception is the
  marketing lead, a colleague's name the dashboard shows beside the release:
  from a collaborator field only the display name is taken, never the email,
  and an email- or phone-typed field is still refused. Cell values are
  scanned for anything email- or phone-shaped and blanked if found.

Credentials come from the environment only (AIRTABLE_TOKEN, a read-only
personal access token; AIRTABLE_BASE_ID; AIRTABLE_TABLE). They are never
printed and never written.

Usage, from the repo root:
  python3 etl/pull_airtable.py --list-fields     names and types only, nothing pulled
  python3 etl/pull_airtable.py                   pull, write data/release_pricing.csv
  python3 etl/pull_airtable.py --out other.csv   pull to somewhere else (a dry run)
  python3 etl/pull_airtable.py --all             keep every record, not only launches
"""
from __future__ import annotations

import argparse
import csv
import os
import pathlib
import re
import sys
import time
from datetime import date, datetime, timedelta

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "data" / "release_pricing.csv"
API = "https://api.airtable.com/v0"
PAGE_SIZE = 100
# Airtable allows 5 requests a second per base; a pause between pages keeps a
# full pull well under that without needing the retry
PAGE_PAUSE_S = 0.25
RETRY_429_S = 30
TIMEOUT_S = 60

# Airtable field -> CSV column. The order here is the column order in the CSV.
# Every field is about the edition, not a person; see the module docstring.
FIELDS: list[tuple[str, str]] = [
    # identity
    ("ID", "airtable_id"),
    ("Project Code", "project_code"),
    ("Artist name (string)", "artist"),
    ("Title", "title"),
    ("Title status", "title_status"),
    ("Release", "release"),
    # price
    ("Total Unit Price (Retail)", "unit_price"),
    ("Price status", "price_status"),
    ("Price bucket", "price_bucket"),
    ("Max revenue - fully sold out", "max_revenue"),
    # edition size
    ("Units", "edition_size"),
    ("Unit status", "unit_status"),
    ("Units target", "units_target"),
    ("Max edition order quantity", "max_order_qty"),
    # launch and edition type
    ("Type", "edition_type"),
    ("Launch type", "launch_type"),
    ("BU", "business_unit"),
    ("Product type", "product_type"),
    ("Made to Order", "made_to_order"),
    ("TL length", "tl_length"),
    ("Project status", "project_status"),
    ("Product Variants", "product_variants"),
    ("Campaign Type", "campaign_type"),
    ("Sales approach", "sales_approach"),
    # dates
    ("Launch date", "launch_date"),
    ("Time of launch", "launch_time"),
    ("Announce Date", "announce_date"),
    ("Private room go live date", "private_room_date"),
    ("TL end date", "tl_end_date"),
    ("Launch date status", "launch_date_status"),
    ("YYYY-QQ", "quarter"),
    ("Preorder window?", "preorder_window"),
    # medium
    ("Description (medium line)", "medium"),
    ("Medium line status", "medium_status"),
    ("Dimensions (H × W × D)", "dimensions"),
    ("Signed/Numbered/Dated", "signed_numbered_dated"),
    ("Edition signature type", "signature_type"),
    ("Hand-finished?", "hand_finished"),
    ("Framing requirements", "framing"),
    # artist context (business tiers, not people)
    ("Artist tier", "artist_tier"),
    ("Artist genre bucket", "artist_genre"),
    ("New / Repeat", "new_or_repeat"),
    ("Expected sell-through %", "expected_sellthrough"),
]
# Airtable field -> CSV column, pulled only when the table has the field (a
# missing one leaves its column blank and is named in the pull's report). The
# per-product economics the Target setting tab reads, and the marketing lead.
OPTIONAL_FIELDS: list[tuple[str, str]] = [
    ("Target sell-through %", "target_sellthrough"),
    ("Artist profit per unit", "artist_profit_per_unit"),
    ("AA profit per unit", "aa_profit_per_unit"),
    ("AA revenue share", "aa_revenue_share"),
    ("AA profit share", "aa_profit_share"),
    ("Framing conversion", "frame_conversion"),
    ("Framing profit per unit", "frame_profit_per_unit"),
    ("Marketing lead", "marketing_lead"),
]
LEAD_COL = "marketing_lead"
# a percentage field arrives as 0.4 or, typed as a number, as 40: read either
PERCENT_COLS = {"target_sellthrough", "aa_revenue_share", "aa_profit_share", "frame_conversion"}
PRICE_FIELD = "Total Unit Price (Retail)"
DATE_COLS = {"launch_date", "announce_date", "private_room_date", "tl_end_date"}
# the columns the join in release_clusters.py needs; a pull missing one of these
# has not worked, whatever the API said
REQUIRED_COLS = {"artist", "title", "unit_price", "edition_size", "launch_date"}

# A wanted field that turns out to be one of these holds a person, and the pull
# stops rather than fetching it.
PERSON_TYPES = {"singleCollaborator", "multipleCollaborators", "createdBy", "lastModifiedBy",
                "email", "phoneNumber", "multipleAttachments"}
PERSON_NAME = re.compile(r"(e-?mail|phone|mobile|address|slack|collaborator|modifier|modified by|"
                         r"ethnicity|gender|\bpm\b|\barm\b|lead\b|manager)", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# a run of digits with the separators a phone number uses; "dated 2023 (1-50)"
# has the shape but not the digits, so a hit also needs nine of them
PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)")
PHONE_MIN_DIGITS = 9
CURRENCY_OF_SYMBOL = {"€": "EUR", "£": "GBP", "$": "USD"}

# The CSV is the launch list, not the pitch pipeline: a record is kept when it
# has a launch date that is in the past, or coming within this many days. A
# pitch with a placeholder date two years out is not a release yet, and a
# committed file of everything being pitched would say more about the
# business's plans than a pricing panel needs to.
UPCOMING_DAYS = 120


def credentials() -> tuple[str, str, str]:
    tok = os.environ.get("AIRTABLE_TOKEN", "").strip()
    base = re.sub(r"[^A-Za-z0-9]", "", os.environ.get("AIRTABLE_BASE_ID", ""))
    table = os.environ.get("AIRTABLE_TABLE", "").strip()
    if not (tok and base and table):
        sys.exit("AIRTABLE_TOKEN, AIRTABLE_BASE_ID and AIRTABLE_TABLE must be set")
    return tok, base, table


def get(url: str, tok: str, params: dict | None = None) -> dict:
    """One GET with the bearer token, retried once on the rate limit."""
    for attempt in (1, 2):
        r = requests.get(url, headers={"Authorization": f"Bearer {tok}"}, params=params, timeout=TIMEOUT_S)
        if r.status_code == 429 and attempt == 1:
            time.sleep(RETRY_429_S)
            continue
        if not r.ok:
            # the body can echo the request, so only the status and the error code go to the terminal
            code = (r.json().get("error") or {}).get("type", "") if r.headers.get("content-type", "").startswith("application/json") else ""
            sys.exit(f"Airtable {r.status_code} {code} on {url.split('/v0/')[-1].split('/')[0][:3]}...")
        return r.json()
    raise RuntimeError("unreachable")


def schema(tok: str, base: str, table: str) -> dict:
    """The table's field list from the metadata API: {name: field}."""
    doc = get(f"{API}/meta/bases/{base}/tables", tok)
    hit = next((t for t in doc.get("tables", []) if t.get("id") == table or t.get("name") == table), None)
    if hit is None:
        sys.exit(f"table {table!r} not found in the base")
    return {f["name"]: f for f in hit.get("fields", [])}


def field_kind(field: dict) -> str:
    """The type a value will come back as: a lookup's result type, else its own."""
    opts = field.get("options") or {}
    if field.get("type") in ("multipleLookupValues", "rollup", "formula", "lookup"):
        return str((opts.get("result") or {}).get("type") or field["type"])
    return str(field.get("type"))


def optional_fields() -> list[tuple[str, str]]:
    """OPTIONAL_FIELDS with any name overridden from the environment."""
    out = []
    for name, col in OPTIONAL_FIELDS:
        override = os.environ.get(f"AIRTABLE_FIELD_{col.upper()}", "").strip()
        out.append((override or name, col))
    return out


def check_schema(fields: dict) -> tuple[list[str], str, dict[str, str], list[str]]:
    """Every wanted field must exist and must not hold a person. Returns the
    field names to request, the price field's currency code, the optional
    fields found (name -> column) and the optional ones the table lacks."""
    missing = [name for name, _ in FIELDS if name not in fields]
    if missing:
        sys.exit("fields not in the table: " + ", ".join(repr(m) for m in missing))
    bad = []
    for name, _ in FIELDS:
        kind = field_kind(fields[name])
        if kind in PERSON_TYPES or fields[name].get("type") in PERSON_TYPES:
            bad.append(f"{name!r} ({kind})")
    found: dict[str, str] = {}
    absent: list[str] = []
    for name, col in optional_fields():
        if name not in fields:
            absent.append(name)
            continue
        kind = field_kind(fields[name])
        ftype = fields[name].get("type")
        if col == LEAD_COL:
            # a colleague's name, never an address: a collaborator field is
            # read for its display name only, an email or phone field is refused
            if kind in ("email", "phoneNumber") or ftype in ("email", "phoneNumber", "multipleAttachments"):
                bad.append(f"{name!r} ({kind})")
                continue
        elif kind in PERSON_TYPES or ftype in PERSON_TYPES:
            bad.append(f"{name!r} ({kind})")
            continue
        found[name] = col
    if bad:
        sys.exit("refusing to pull fields that hold a person: " + ", ".join(bad))
    symbol = ((fields[PRICE_FIELD].get("options") or {}).get("symbol") or "").strip()
    currency = CURRENCY_OF_SYMBOL.get(symbol)
    if not currency:
        sys.exit(f"the price field's currency symbol {symbol!r} is not one this pull knows")
    return [name for name, _ in FIELDS] + list(found), currency, found, absent


def list_fields(fields: dict) -> None:
    """Names and types of every field in the table - nothing else. The
    wanted ones are marked, and the ones the guard would refuse are flagged."""
    print(f"{len(fields)} fields")
    wanted = {name for name, _ in FIELDS} | {name for name, _ in optional_fields()}
    for name, f in fields.items():
        kind = field_kind(f)
        flags = []
        if name in wanted:
            flags.append("pulled")
        if kind in PERSON_TYPES or f.get("type") in PERSON_TYPES or PERSON_NAME.search(name):
            flags.append("person-shaped, never pulled")
        print(f"  {name!r}: {f.get('type')}" + (f" -> {kind}" if kind != f.get('type') else "")
              + (f"   [{'; '.join(flags)}]" if flags else ""))


def records(tok: str, base: str, table: str, names: list[str]):
    """Every record, paginated with the offset the API hands back."""
    params: dict = {"pageSize": PAGE_SIZE, "fields[]": names}
    url = f"{API}/{base}/{requests.utils.quote(table, safe='')}"
    offset = None
    while True:
        if offset:
            params["offset"] = offset
        doc = get(url, tok, params)
        for rec in doc.get("records", []):
            yield rec
        offset = doc.get("offset")
        if not offset:
            return
        time.sleep(PAGE_PAUSE_S)


def scrub(text: str, hits: list[int]) -> str:
    """Blank anything email- or phone-shaped. A medium line does not hold a
    phone number, so a hit is a field being used for something it should not
    be, and the count is reported rather than the value."""
    if EMAIL_RE.search(text):
        hits[0] += 1
        return ""
    for m in PHONE_RE.finditer(text):
        if sum(ch.isdigit() for ch in m.group(0)) >= PHONE_MIN_DIGITS:
            hits[0] += 1
            return ""
    return text


def flatten(value, col: str, hits: list[int]) -> object:
    """One CSV cell from one Airtable value."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if col in PERCENT_COLS and value > 1:
            # a percentage typed as a whole number (40 for 40%): a fraction everywhere here
            value = value / 100
        # a percent comes back as 0.7000000000000001; six places is more than any field carries
        return round(value, 6) if isinstance(value, float) else value
    if isinstance(value, list):
        parts = [flatten(v, col, hits) for v in value]
        parts = [str(p) for p in parts if p not in ("", None)]
        return " | ".join(dict.fromkeys(parts))
    if isinstance(value, dict):
        # attachments and collaborators come back as objects; neither is wanted,
        # except the marketing lead's display name (never the email beside it)
        if col == LEAD_COL:
            return scrub(re.sub(r"\s+", " ", str(value.get("name") or "")).strip(), hits)
        return ""
    text = str(value)
    if col in DATE_COLS or col == "launch_time":
        # dateTime fields arrive as ISO timestamps in UTC; a date column keeps the day
        if col != "launch_time" and "T" in text:
            text = text.split("T")[0]
        return text
    # rich text arrives as markdown: links to shared drives are not part of a
    # medium line, and neither is the markup around them
    text = re.sub(r"<?https?://\S+>?", "", text)
    text = re.sub(r"[*_`#>]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return scrub(text, hits)


def keep(row: dict, today: date, everything: bool) -> bool:
    if everything:
        return True
    if not (str(row.get("artist") or "").strip() and str(row.get("title") or "").strip()):
        return False
    try:
        launch = date.fromisoformat(str(row.get("launch_date") or "")[:10])
    except ValueError:
        return False
    return launch <= today + timedelta(days=UPCOMING_DAYS)


def pull(tok: str, base: str, table: str, fields: dict, out: pathlib.Path, everything: bool) -> None:
    names, currency, found, absent = check_schema(fields)
    by_name = {**dict(FIELDS), **found}
    cols = [col for _, col in FIELDS]
    cols.insert(cols.index("unit_price") + 1, "currency")
    # the optional columns are always in the file, blank where the table has
    # no such field yet, so a reader can rely on the header
    cols += [col for _, col in OPTIONAL_FIELDS]
    hits = [0]
    rows, seen, dropped = [], 0, 0
    today = date.today()
    for rec in records(tok, base, table, names):
        seen += 1
        f = rec.get("fields", {})
        row = {col: "" for col in cols}
        row.update({by_name[name]: flatten(f.get(name), by_name[name], hits) for name in names})
        row["currency"] = currency if row.get("unit_price") not in ("", None) else ""
        if keep(row, today, everything):
            rows.append(row)
        else:
            dropped += 1
    rows.sort(key=lambda r: (str(r.get("launch_date") or ""), str(r.get("artist") or ""), str(r.get("title") or "")))
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    priced = sum(1 for r in rows if r.get("unit_price") not in ("", None))
    sized = sum(1 for r in rows if r.get("edition_size") not in ("", None))
    dated = sum(1 for r in rows if r.get("launch_date"))
    past = sum(1 for r in rows if r.get("launch_date") and str(r["launch_date"])[:10] <= today.isoformat())
    if everything:
        print(f"{seen} records in the table, all kept: {past} launched, {dated - past} with a launch date "
              f"still to come, {len(rows) - dated} without one")
    else:
        print(f"{seen} records in the table; kept {len(rows)} ({past} launched, {len(rows) - past} launching within "
              f"{UPCOMING_DAYS} days), dropped {dropped} without an artist, a title and such a launch date")
    print(f"of the kept rows: {priced} priced ({currency}), {sized} with an edition size, {dated} with a launch date")
    if found:
        filled = {col: sum(1 for r in rows if r.get(col) not in ("", None)) for col in found.values()}
        print("target fields pulled: " + ", ".join(f"{name!r} -> {col} ({filled[col]} filled)" for name, col in found.items()))
    if absent:
        print("target fields not in the table yet (columns left blank): " + ", ".join(repr(a) for a in absent)
              + " - name a field that holds one with AIRTABLE_FIELD_<column>")
    if hits[0]:
        print(f"blanked {hits[0]} cells that held something email- or phone-shaped")
    print(f"wrote {out} ({len(cols)} columns)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--list-fields", action="store_true", help="print field names and types, pull nothing")
    ap.add_argument("--out", type=pathlib.Path, default=OUT_PATH, help=f"where to write (default {OUT_PATH.relative_to(ROOT)})")
    ap.add_argument("--all", action="store_true", help="keep every record, not only launched and imminent ones")
    args = ap.parse_args()
    tok, base, table = credentials()
    fields = schema(tok, base, table)
    if args.list_fields:
        list_fields(fields)
        return
    pull(tok, base, table, fields, args.out, args.all)


if __name__ == "__main__":
    main()
