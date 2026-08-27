#!/usr/bin/env python3
"""Extract the useful slice of the Emplifi content export (All editions content.xlsx)
into data/content_posts.csv: one row per post/story with campaign code parsed from Labels.

Only the ~25 populated columns matter (see docs/DATA_MODEL.md §8); the campaign code is
found by stripping generic label tokens.
"""
import csv
import pathlib

import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "sources" / "all_editions_content.xlsx"
OUT = ROOT / "data" / "content_posts.csv"

GENERIC_TOKENS = {
    "Edition", "Reel", "Make-Ready", "Inspiration", "Q4 NT Avg Interactions OKR",
}

KEEP = [
    "Date", "Profile name", "Profile followers", "Platform", "Content type", "Media type",
    "Labels", "Total impressions", "Total reach", "Engagements", "Total likes",
    "Total comments", "Total shares", "Saves", "Media views", "Exits", "Taps forward",
    "Taps back", "Completion rate", "Video view count", "Content ID",
]


def campaign_from_labels(labels: str) -> str:
    if not labels:
        return ""
    tokens = [t.strip() for t in str(labels).split(";") if t.strip()]
    # A campaign code looks like Word_Word_NN (underscored); free-text artist tags don't.
    coded = [t for t in tokens if t not in GENERIC_TOKENS and "_" in t]
    return coded[0] if coded else ""


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb["Content"]
    rows = ws.iter_rows(values_only=True)
    header = list(next(rows))
    idx = {h: i for i, h in enumerate(header)}
    missing = [k for k in KEEP if k not in idx]
    if missing:
        raise SystemExit(f"missing expected columns: {missing}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["campaign_code"] + KEEP)
        n = 0
        for r in rows:
            if r is None or r[idx["Date"]] is None:
                continue
            vals = []
            for k in KEEP:
                v = r[idx[k]]
                if k == "Date" and hasattr(v, "isoformat"):
                    v = v.isoformat(sep=" ")
                vals.append(v if v is not None else "")
            w.writerow([campaign_from_labels(r[idx["Labels"]])] + vals)
            n += 1
    print(f"wrote {n} rows -> {OUT}")
    wb.close()


if __name__ == "__main__":
    main()
