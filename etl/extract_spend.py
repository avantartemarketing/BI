#!/usr/bin/env python3
"""Extract the meta_ads_insights_Extract sheet (campaign x day spend) from the
LAUNCH PERFORMANCE OVERVIEW workbook into data/spend_daily.csv.

The workbook is a snapshot; in production this comes straight from BigQuery
`AA_company_tables.meta_ads_insights_export`. campaign_id is float-mangled in the
sheet, so we keep campaign_name as the only key (see docs/DATA_MODEL.md §11).
"""
import csv
import pathlib

import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "sources" / "launch_performance_overview.xlsx"
OUT = ROOT / "data" / "spend_daily.csv"


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb["meta_ads_insights_Extract"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = ws.iter_rows(values_only=True)
    header = next(rows)  # account, campaign_id, campaign_name, spend_date, impressions, reachs, link_clicks, spend
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["campaign_name", "spend_date", "impressions", "reach", "link_clicks", "spend"])
        n = 0
        for r in rows:
            if r is None or r[2] is None or r[3] is None:
                continue
            date = r[3]
            date = date.date().isoformat() if hasattr(date, "date") else str(date)[:10]
            w.writerow([r[2], date, r[4] or 0, r[5] or 0, r[6] or 0, r[7] or 0])
            n += 1
    print(f"wrote {n} rows -> {OUT}")
    wb.close()


if __name__ == "__main__":
    main()
