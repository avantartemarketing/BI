#!/usr/bin/env python3
"""Rebuild the daily funnel export from the event-level feeds, add what the
export cannot carry, and reconcile the rebuild against the export on every run.

Inputs, both written by server/bigquery.js:
  sources/le_browsing.csv   sessions and page views per channel x day x release,
                            counted inside BigQuery (no identifier involved)
  sources/le_events.csv     signup, draw entry intent and purchase events with a
                            pseudonymous account id and no address

Outputs:
  sources/across_time.rebuilt.csv  the export's 34 columns at the export's grain,
                                   dates DD/MM/YYYY like the export; what build.py
                                   reads (FUNNEL_SOURCE=export reads the export instead)
  data/app/release_people.csv      one row per release: unique entrants and buyers,
                                   returning collectors, overlap with the artist's
                                   previous releases - no identifier in it
  data/app/reconciliation.json     rebuilt against export, column by column

The definitions are the ones decoded against the export in docs/DATA_MODEL.md
#2.2: people are distinct account ids; an entrant's units are their maximum
quantity counted once; Draw_Entry_Eligible is the post-allocation remainder;
a purchase's route is the first match of pre-order app, presale, private room,
draw entry, else other; the pre-order not-converted count keeps winners in,
because a pre-order winner converts by itself. This script writes next to the
export and reports the differences; the build reads the rebuilt file unless
FUNNEL_SOURCE=export.

Run from the repo root: python3 etl/aggregate_events.py  (the refresh runs it before build.py)
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources"
BROWSING = SOURCES / "le_browsing.csv"
EVENTS = SOURCES / "le_events.csv"
EXPORT = SOURCES / "across_time.csv"
REBUILT = SOURCES / "across_time.rebuilt.csv"
PEOPLE = ROOT / "data" / "app" / "release_people.csv"
RECON = ROOT / "data" / "app" / "reconciliation.json"
SINCE = os.environ.get("BQ_SINCE", "2023-01-01")

CH = "AA_session_custom_channel_group_split_touch"
CLOCK = ["campaign_stage", "days_since_announcement", "days_until_launch",
         "pct_days_since_announcement", "pct_days_until_launch"]
KEY = [CH, "event_date", "simple_release_name"] + CLOCK
EXPORT_COLUMNS = [
    CH, "event_date", "simple_release_name", "Page_Views_Total", "Sessions_Total", "Draw_Entries", "Preorder_App",
    "Collectors_Eligible_Entries", "Draw_Entry_Eligible", "Draw_Winner", "Preorder_App_Eligable", "Preorder_Winner",
    "Unique_Customers", "Customer_Draw", "Customer_Preorder_App", "Customer_Private_Room", "Customers_Presale_Offered",
    "Customer_Other", "Draw_Entry_Eligible_No_Conv", "Preorder_App_Eligible_No_Conv", "Total_Product_Units",
    "Product_Units_Draw", "Product_Units_Preorder_App", "Product_Units_Private_Room", "Product_Units_Presale_Offered",
    "Product_Units_Other", "Draw_Entries_Total_Units", "Draw_Entries_Total_Units_No_Conv", "Draw_Entries_Eligible_Units",
] + CLOCK
METRICS = [c for c in EXPORT_COLUMNS if c not in KEY]
# route of a purchase: first match wins (docs #2.2)
ROUTES = [("purchase_with_preorder_app", "Preorder_App"), ("purchase_with_presale", "Presale_Offered"),
          ("pr_order", "Private_Room"), ("purchase_with_draw_entry", "Draw")]
CUSTOMER_COL = {"Draw": "Customer_Draw", "Preorder_App": "Customer_Preorder_App", "Private_Room": "Customer_Private_Room",
                "Presale_Offered": "Customers_Presale_Offered", "Other": "Customer_Other"}
# what the reconciliation accepts as the known residuals (docs #2.2): sessions
# and page views carry attribution noise between the two table builds (0.1% of
# page views, spread thinly over the history), counts of people the rows
# without an account id, routes the precedence
TOLERANCE = {"counts": 0.002, "people": 0.006, "units": 0.002, "route": 0.02}
KIND = {**{c: "counts" for c in ["Sessions_Total", "Page_Views_Total"]},
        **{c: "units" for c in ["Total_Product_Units", "Draw_Entries_Total_Units", "Draw_Entries_Eligible_Units",
                                "Draw_Entries_Total_Units_No_Conv"]},
        **{c: "route" for c in ["Customer_Draw", "Customer_Preorder_App", "Customer_Private_Room", "Customers_Presale_Offered",
                                "Customer_Other", "Product_Units_Draw", "Product_Units_Preorder_App", "Product_Units_Private_Room",
                                "Product_Units_Presale_Offered", "Product_Units_Other"]}}


def flag(s: pd.Series) -> pd.Series:
    """BigQuery booleans arrive as true/false strings (or NaN); 0/1 ints for the flag columns."""
    if s.dtype == bool:
        return s
    return s.map(lambda v: str(v).strip().lower() in ("true", "1", "1.0")).astype(bool)


FLAGS = ["draw_entry_eligible", "winner", "pre_order", "draw_with_purchase",
         "purchase_with_preorder_app", "purchase_with_presale", "pr_order", "purchase_with_draw_entry"]
EVENT_COLS = [CH, "event_date", "event_name", "aa_account_id", "simple_release_name", "announcement_date",
              "draw_entry_multiset_preference_max_quantity_once", "order_pieces"] + CLOCK + FLAGS
LABELS = [CH, "simple_release_name", "campaign_stage", "event_name"]


def load_events() -> pd.DataFrame:
    # The file has 48 columns and 200k rows; the aggregation reads the 21
    # columns it uses and keeps only the draw-entry and purchase rows (signups
    # are two thirds of the file and feed nothing here), in chunks so the peak
    # is one chunk plus what is kept. The whole frame as strings peaked over
    # 1 GB, which the 512 MB Render instance does not have.
    chunks = []
    for chunk in pd.read_csv(EVENTS, usecols=lambda c: c in EVENT_COLS, dtype={c: "category" for c in LABELS},
                             chunksize=50_000, low_memory=False):
        chunks.append(chunk[chunk["event_name"].isin(["draw entry intent", "purchase"])])
    ev = pd.concat(chunks, ignore_index=True)
    del chunks
    for c in LABELS:
        ev[c] = ev[c].astype(str).where(ev[c].notna(), None).astype("category")
    ev["event_date"] = pd.to_datetime(ev["event_date"])
    for c in FLAGS:
        ev[c] = flag(ev[c])
    ev["units_once"] = ev["draw_entry_multiset_preference_max_quantity_once"].fillna(0).astype("float32")
    ev["order_pieces"] = ev["order_pieces"].fillna(0).astype("float32")
    ev.drop(columns=["draw_entry_multiset_preference_max_quantity_once"], inplace=True)
    return ev


def people(sub: pd.DataFrame, name: str) -> pd.DataFrame:
    return sub.groupby(KEY, dropna=False, observed=True)["aa_account_id"].nunique().rename(name).reset_index()


def units(sub: pd.DataFrame, col: str, name: str) -> pd.DataFrame:
    return sub.groupby(KEY, dropna=False, observed=True)[col].sum().rename(name).reset_index()


def rebuild(browsing: pd.DataFrame, ev: pd.DataFrame) -> pd.DataFrame:
    ev = ev[ev["event_date"] >= pd.Timestamp(SINCE)]
    de = ev[ev["event_name"] == "draw entry intent"]
    pu = ev[ev["event_name"] == "purchase"].copy()
    E, W, P, C = de["draw_entry_eligible"], de["winner"], de["pre_order"], de["draw_with_purchase"]
    parts = [
        people(de, "Draw_Entries"), people(de[P], "Preorder_App"), people(de[E], "Collectors_Eligible_Entries"),
        people(de[E & ~W], "Draw_Entry_Eligible"), people(de[W], "Draw_Winner"), people(de[P & E], "Preorder_App_Eligable"),
        people(de[P & W], "Preorder_Winner"), people(de[E & ~W & ~C], "Draw_Entry_Eligible_No_Conv"),
        people(de[P & E & ~C], "Preorder_App_Eligible_No_Conv"),      # winners stay in: a pre-order winner converts by itself
        units(de, "units_once", "Draw_Entries_Total_Units"), units(de[E], "units_once", "Draw_Entries_Eligible_Units"),
        units(de[E & ~W & ~C], "units_once", "Draw_Entries_Total_Units_No_Conv"),
        units(pu, "order_pieces", "Total_Product_Units"), people(pu, "Unique_Customers"),
    ]
    pu["route"] = "Other"
    for col, route in reversed(ROUTES):          # earlier in ROUTES wins, so assign last
        pu.loc[pu[col], "route"] = route
    for route, ccol in CUSTOMER_COL.items():
        sub = pu[pu["route"] == route]
        parts += [units(sub, "order_pieces", f"Product_Units_{route}"), people(sub, ccol)]
    # One frame of partial rows - the browsing counts and each conversion
    # aggregate carry their own metric column and zeros elsewhere - summed in a
    # single grouped pass on categorical keys. No merge on string keys, no
    # second copy: the rebuild peaked over 600 MB the merge way.
    del de, pu
    frames = [browsing] + parts
    for f in frames:
        for c in [CH, "simple_release_name", "campaign_stage"]:
            f[c] = f[c].astype(str).where(f[c].notna(), None)
    stack = pd.concat(frames, ignore_index=True, sort=False)
    del frames, parts
    for c in [CH, "simple_release_name", "campaign_stage"]:
        stack[c] = stack[c].astype("category")
    for c in METRICS:
        stack[c] = stack[c].fillna(0).astype("float32")
    out = stack.groupby(KEY, dropna=False, observed=True, sort=False)[METRICS].sum().reset_index()
    del stack
    ints = [c for c in METRICS if c not in ["Draw_Entries_Total_Units", "Draw_Entries_Eligible_Units",
                                             "Draw_Entries_Total_Units_No_Conv", "Total_Product_Units"]
            + [f"Product_Units_{r}" for r in CUSTOMER_COL]]
    out[ints] = out[ints].round().astype("int32")
    for c in [CH, "simple_release_name", "campaign_stage"]:
        out[c] = out[c].astype(object)
    return out[EXPORT_COLUMNS].sort_values(["event_date", CH, "simple_release_name"], kind="stable")


GROUP3 = [CH, "event_date", "simple_release_name"]


def grouped(frame: pd.DataFrame) -> pd.DataFrame:
    """Metrics summed to channel x day x release (the fan-out folded), float32."""
    f = frame[GROUP3 + METRICS].copy()
    for c in [CH, "simple_release_name"]:
        f[c] = f[c].astype(str).astype("category")
    for c in METRICS:
        f[c] = f[c].astype("float32")
    return f.groupby(GROUP3, observed=True)[METRICS].sum()


def load_export_grouped() -> pd.DataFrame:
    """The export folded to channel x day x release, read in chunks so the whole
    424k-row file is never in memory at once (it cost 200 MB on its own)."""
    parts = []
    for chunk in pd.read_csv(EXPORT, usecols=lambda c: c in GROUP3 + METRICS, chunksize=100_000, low_memory=False):
        chunk["event_date"] = pd.to_datetime(chunk["event_date"], format="%d/%m/%Y")
        parts.append(grouped(chunk).reset_index())
    stack = pd.concat(parts, ignore_index=True)
    del parts
    for c in [CH, "simple_release_name"]:
        stack[c] = stack[c].astype(str).astype("category")
    return stack.groupby(GROUP3, observed=True)[METRICS].sum()


def reconcile(b: pd.DataFrame, a: pd.DataFrame) -> dict:
    """b: the rebuilt side, a: the export side, both from grouped()."""
    lo = max(b.index.get_level_values("event_date").min(), a.index.get_level_values("event_date").min())
    hi = min(b.index.get_level_values("event_date").max(), a.index.get_level_values("event_date").max()) - pd.Timedelta(days=1)   # the last day is still filling
    a = a[(a.index.get_level_values("event_date") >= lo) & (a.index.get_level_values("event_date") <= hi)]
    b = b[(b.index.get_level_values("event_date") >= lo) & (b.index.get_level_values("event_date") <= hi)]
    idx = a.index.union(b.index)
    cols, beyond = {}, []
    for c in METRICS:
        x, r = a[c].reindex(idx, fill_value=0), b[c].reindex(idx, fill_value=0)
        tot = float(x.sum()); diff = float(r.sum() - tot)
        pct = diff / tot if tot else 0.0
        kind = KIND.get(c, "people")
        ok = abs(pct) <= TOLERANCE[kind]
        cols[c] = {"export": tot, "rebuilt": float(r.sum()), "pct": pct, "kind": kind, "within_tolerance": ok,
                   "channel_days_differing": int((x != r).sum()), "max_abs_diff": float((x - r).abs().max())}
        if not ok:
            beyond.append(c)
    return {"window": [lo.date().isoformat(), hi.date().isoformat()], "channel_days": int(len(idx)),
            "columns": cols, "beyond_tolerance": beyond, "verdict": "within known residuals" if not beyond else "differences beyond the known residuals"}


def people_file(ev: pd.DataFrame) -> pd.DataFrame:
    de = ev[ev["event_name"] == "draw entry intent"]
    pu = ev[ev["event_name"] == "purchase"]
    ann = ev.groupby("simple_release_name")["announcement_date"].agg(lambda s: pd.to_datetime(s.dropna()).min() if s.notna().any() else pd.NaT)
    first = ev[ev["event_name"] != "signup"].groupby("simple_release_name")["event_date"].min()
    releases = sorted(set(de["simple_release_name"].dropna()) | set(pu["simple_release_name"].dropna()))
    start = {r: (ann.get(r) if pd.notna(ann.get(r)) else first.get(r)) for r in releases}
    artist_of = {r: str(r).split(" · ")[0] for r in releases}
    ent_sets = {r: set(de.loc[de["simple_release_name"] == r, "aa_account_id"].dropna()) for r in releases}
    buy_sets = {r: set(pu.loc[pu["simple_release_name"] == r, "aa_account_id"].dropna()) for r in releases}
    rows = []
    for r in releases:
        s0 = pd.Timestamp(start[r])
        entr, buyers = ent_sets[r], buy_sets[r]
        sub_e = de[de["simple_release_name"] == r]
        prior_buyers = set(pu.loc[pu["event_date"] < s0, "aa_account_id"].dropna())
        prior_entrants = set(de.loc[de["event_date"] < s0, "aa_account_id"].dropna())
        prev = [q for q in releases if artist_of[q] == artist_of[r] and q != r and pd.Timestamp(start[q]) < s0]
        prev_people = set().union(*[ent_sets[q] | buy_sets[q] for q in prev]) if prev else set()
        rows.append({
            "release_name": r, "artist": artist_of[r], "campaign_start": s0.date().isoformat(),
            "entrants": len(entr), "eligible_entrants": int(sub_e.loc[sub_e["draw_entry_eligible"], "aa_account_id"].nunique()),
            "winners": int(sub_e.loc[sub_e["winner"], "aa_account_id"].nunique()),
            "buyers": len(buyers), "units": float(pu.loc[pu["simple_release_name"] == r, "order_pieces"].sum()),
            "entrants_bought_before": len(entr & prior_buyers), "entrants_entered_before": len(entr & prior_entrants),
            "buyers_bought_before": len(buyers & prior_buyers), "buyers_first_time": len(buyers - prior_buyers),
            "artist_previous_releases": len(prev),
            "entrants_from_artist_previous": len(entr & prev_people), "buyers_from_artist_previous": len(buyers & prev_people),
        })
    out = pd.DataFrame(rows)
    for num, den, name in [("entrants_bought_before", "entrants", "share_entrants_returning"),
                           ("buyers_bought_before", "buyers", "share_buyers_returning"),
                           ("entrants_from_artist_previous", "entrants", "share_entrants_from_artist_previous")]:
        out[name] = (out[num] / out[den].replace(0, np.nan)).round(4)
    return out.sort_values("campaign_start", ascending=False)


def rss(label: str) -> None:
    """AGG_PROFILE=1 prints the peak resident set after each stage (MB)."""
    if os.environ.get("AGG_PROFILE"):
        import resource
        print(f"  [memory] {label}: peak {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB", file=sys.stderr)


def main() -> int:
    missing = [p.name for p in (BROWSING, EVENTS) if not p.exists()]
    if missing:
        print(f"aggregate_events: nothing to do - missing {', '.join(missing)} (run node server/bigquery.js --write)")
        return 0
    browsing = pd.read_csv(BROWSING, dtype={c: "category" for c in [CH, "simple_release_name", "campaign_stage"]}, low_memory=False)
    browsing["event_date"] = pd.to_datetime(browsing["event_date"], format="%d/%m/%Y")
    rss("browsing loaded")
    ev = load_events()
    rss("events loaded")
    rebuilt = rebuild(browsing, ev)
    del browsing
    rss("rebuilt")
    tmp = REBUILT.with_suffix(".tmp"); rebuilt.to_csv(tmp, index=False, date_format="%d/%m/%Y"); tmp.replace(REBUILT)
    note = f"rebuilt {len(rebuilt)} channel-day rows -> {REBUILT.name}"
    rss("written")
    b = grouped(rebuilt)
    del rebuilt
    rss("grouped")

    if EXPORT.exists():
        a = load_export_grouped()
        rss("export grouped")
        rec = reconcile(b, a)
        del a, b
        rss("reconciled")
        RECON.parent.mkdir(parents=True, exist_ok=True)
        RECON.write_text(json.dumps(rec, indent=1))
        print(f"reconciliation {rec['window'][0]}..{rec['window'][1]} ({rec['channel_days']} channel-days): {rec['verdict']}")
        for c, v in rec["columns"].items():
            mark = "  " if v["within_tolerance"] else "!!"
            print(f" {mark} {c:34s} export {v['export']:12,.0f}  rebuilt {v['rebuilt']:12,.0f}  {v['pct']*100:+7.2f}%  "
                  f"({v['channel_days_differing']} channel-days differ, max {v['max_abs_diff']:.0f})")
        note += f"; reconciliation: {rec['verdict']}"
    else:
        note += "; no export to reconcile against"

    ppl = people_file(ev)
    PEOPLE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PEOPLE.with_suffix(".tmp"); ppl.to_csv(tmp, index=False); tmp.replace(PEOPLE)
    src = os.environ.get("FUNNEL_SOURCE", "events")
    print(f"aggregate_events: {note}; people {len(ppl)} releases -> {PEOPLE.name}; build reads {'the export' if src == 'export' else 'the rebuilt file'} (FUNNEL_SOURCE={src})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
