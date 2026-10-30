#!/usr/bin/env python3
"""Run signup_cohorts.sql against BigQuery and print the table.

The dashboard's own pull (server/bigquery.js) refuses any query that could
return an address, so an analysis runs through the bq CLI with its own SQL,
and that SQL aggregates inside BigQuery: only the group totals come back.

Credentials: BIGQUERY_SERVICE_ACCOUNT_JSON (the key file's contents, as the
app reads it), else whatever gcloud is already signed in as. Never a key in
the repo or in the output.

  python3 etl/analysis/signup_cohorts.py            # prints the table
  python3 etl/analysis/signup_cohorts.py --csv out.csv
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SQL = HERE / "signup_cohorts.sql"
PROJECT = os.environ.get("BQ_PROJECT", "avantarte-data-production")


def sign_in() -> None:
    key = os.environ.get("BIGQUERY_SERVICE_ACCOUNT_JSON") or os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not key:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        f.write(key)
        path = f.name
    try:
        subprocess.run(["gcloud", "auth", "activate-service-account", "--key-file", path, "--quiet"],
                       check=True, capture_output=True, text=True)
    finally:
        os.unlink(path)


def run(sql: str) -> list[dict]:
    out = subprocess.run(["bq", f"--project_id={PROJECT}", "query", "--use_legacy_sql=false", "--format=json",
                          "--max_rows=1000", sql], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr.strip()[-2000:])
    return json.loads(out.stdout or "[]")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="also write the rows here")
    args = ap.parse_args()
    sign_in()
    rows = run(SQL.read_text())
    if not rows:
        sys.exit("no rows")
    cols = list(rows[0].keys())
    widths = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    print("  ".join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "") if r.get(c) is not None else "all").ljust(widths[c]) for c in cols))
    if args.csv:
        import csv
        with open(args.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)


if __name__ == "__main__":
    main()
