#!/usr/bin/env python3
"""How the entries still to come split across a release's works, on the
closed multi-work draws (docs/DATA_MODEL.md 6.3, 6 October 2026).

The sell-through at close takes the release's entries still to come and
places them on the works. Until 6 October 2026 they were spread over the room
left after what was in hand, which handed nearly all of them to the work with
room once another was full (Cattelan's Novecento read 88% at close on a third
of the entries). Now they are placed by the allocation rule itself
(etl/sellthrough.py future_cohort): the entrants still to come are taken to
look like the entrants so far and placed against the room left, so a full
work's share is turned away.

This reads every closed draw with two or more works and known editions at a
share of its window (25, 40, 60 and 80%), builds the entry patterns the page
would have had at that day from the event feed, and runs the rule with the
release's total entries still to come taken as known, so the test is the
split alone. Each work's sell-through at close under the rule, under the
room rule it replaced and under the demand split the page falls back on
without a pattern (split_future), is read against the units finally paid. Aggregates
only: no account id or address is printed.

Run from the repo root: python3 etl/analysis/split_backtest.py [--cut 0.4]
"""
from __future__ import annotations

import glob
import json
import pathlib
import sys
from datetime import date, timedelta

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "etl"))
from sellthrough import sell_through_products, split_future  # noqa: E402

RATE, PRE_RATE = 0.8, 0.95
CUTS = [0.25, 0.4, 0.6, 0.8]
SET_ASIDE = {"pejac_multiple_2024_q3"}   # nine numbered ranges of one print: nothing to choose between them


def norm(t: str) -> str:
    return "".join(ch for ch in str(t).lower() if ch.isalnum())


def main() -> None:
    args = sys.argv[1:]
    cuts = [float(args[args.index("--cut") + 1])] if "--cut" in args else CUTS
    ev = pd.read_csv(ROOT / "sources" / "le_events.csv", low_memory=False,
                     usecols=["event_name", "event_date", "simple_release_name", "draw_id", "aa_account_id",
                              "draw_entry_multiset_preference_max_quantity", "pre_order", "winner", "order_pieces"])
    ev["event_date"] = pd.to_datetime(ev["event_date"], errors="coerce").dt.date
    units = pd.read_csv(ROOT / "data" / "units_paid.csv")
    units["order_date"] = pd.to_datetime(units["order_date"], errors="coerce").dt.date
    draw_map = pd.read_csv(ROOT / "data" / "draw_products.csv")

    snaps = []
    for f in glob.glob(str(ROOT / "data" / "app" / "releases" / "*.json")) + glob.glob(str(ROOT / "data" / "app" / "derived" / "*.json")):
        s = json.load(open(f))
        ps = (s.get("sellthrough") or {}).get("products") or []
        if len(ps) < 2 or not s.get("complete") or not all((p.get("edition") or 0) >= 10 for p in ps) or len(ps) > 9:
            continue
        if not all(p.get("draws") for p in ps):   # a work sold with no draw (Condo's Lost in Time) has no entries to split
            continue
        snaps.append(s)

    rows = []
    for s in sorted(snaps, key=lambda s: s.get("windowEnd") or ""):
        name, ps = s.get("releaseName"), s["sellthrough"]["products"]
        start, end = date.fromisoformat(s["windowStart"]), date.fromisoformat(s["windowEnd"])
        e = ev[ev["simple_release_name"] == name]
        de = e[(e["event_name"] == "draw entry intent") & e["draw_id"].notna()].copy()
        draw_of = {d: i for i, p in enumerate(ps) for d in (p.get("draws") or [])}
        de = de[de["draw_id"].isin(draw_of)]
        if de.empty:
            continue
        de["work"] = de["draw_id"].map(draw_of)
        de["q"] = de["draw_entry_multiset_preference_max_quantity"].fillna(1).clip(lower=1)
        de["pre"] = de["pre_order"].astype(str).str.lower().isin(("true", "1", "yes"))
        first = (de.sort_values("event_date").groupby(["aa_account_id", "work"])
                 .agg(day=("event_date", "first"), q=("q", "max"), pre=("pre", "max"), draw=("draw_id", "first")).reset_index())
        buys = e[e["event_name"] == "purchase"].groupby("aa_account_id").agg(day=("event_date", "min"), pieces=("order_pieces", "sum"))
        # the orders' titles for each work: the draw map, then the name
        title_of = {r["product_title"]: draw_of[r["draw_id"]] for _, r in draw_map[draw_map["release"] == name].iterrows() if r["draw_id"] in draw_of}
        u = units[units["release"] == name]
        for t in u["product_title"].unique():
            if t in title_of:
                continue
            hit = [i for i, p in enumerate(ps) if norm(p["name"]) == norm(t)] or \
                  [i for i, p in enumerate(ps) if norm(t).startswith(norm(p["name"])) or norm(p["name"]).startswith(norm(t))]
            if hit:
                title_of[t] = hit[0]
        u = u[u["product_title"].isin(title_of)].copy()
        u["work"] = u["product_title"].map(title_of)
        final = u[u["order_date"] <= end + timedelta(days=14)].groupby("work")["units_paid"].sum()
        eds = [float(p["edition"]) for p in ps]
        for f in cuts:
            cut = start + timedelta(days=round((end - start).days * f))
            at, later = first[first["day"] <= cut], first[first["day"] > cut]
            if later.empty:
                continue
            paid_t = u[u["order_date"] <= cut].groupby("work")["units_paid"].sum()
            # the patterns the page would have had: each entrant's open draws (bought by
            # the cut: sold, at the pieces they bought), their quantity and pre-order entries
            pats: dict[tuple, int] = {}
            for acc, g in at.groupby("aa_account_id"):
                b = buys.loc[acc] if acc in buys.index else None
                bought = int(b["pieces"]) if b is not None and b["day"] <= cut and pd.notna(b["pieces"]) else 0
                open_, sold, pre = [], [], []
                for _, r in g.iterrows():
                    (sold if bought > 0 else open_).append(r["draw"])
                    if r["pre"]:
                        pre.append(r["draw"])
                key = (tuple(sorted(open_)), tuple(sorted(sold)), tuple(sorted(pre)), int(g["q"].max()), bought)
                pats[key] = pats.get(key, 0) + 1
            patterns = [{"open": list(k[0]), "won": [], "sold": list(k[1]), "pre": list(k[2]), "max": k[3], "bought": k[4], "n": n}
                        for k, n in pats.items()]
            products = [{"key": str(i), "name": p["name"], "edition": eds[i], "draws": p.get("draws") or [],
                         "sold": float(paid_t.get(i, 0))} for i, p in enumerate(ps)]
            # the entries still to come, as if known: each later entrant once, at the units
            # the rule counts them for
            per = later.groupby("aa_account_id").agg(q=("q", "max"), k=("work", "nunique"))
            future_units = RATE * float((per[["q", "k"]].min(axis=1)).sum())
            out = sell_through_products(products, patterns, rate=RATE, edition=sum(eds), sold_total=float(paid_t.sum()),
                                        future_units=future_units, preorder_rate=PRE_RATE)
            today = [r["sold"] + r["soldAssumed"] + (r["drafts"] or 0) + r["shown"] for r in out["products"]]
            room_after = [max(eds[i] - today[i], 0.0) for i in range(len(ps))]
            rs = sum(room_after)
            # the demand split (split_future): the rule the page falls back on without a pattern to read
            by_demand = split_future(future_units, today, room_after)
            for i, r in enumerate(out["products"]):
                actual = min(float(final.get(i, 0)), eds[i])
                old = min(today[i] + (future_units * room_after[i] / rs if rs > 0 else 0.0), eds[i])
                for rule, pred in (("room (before)", old / eds[i]), ("demand split", min(today[i] + by_demand[i], eds[i]) / eds[i]), ("cohort (now)", r["pctClose"])):
                    rows.append({"release": s["id"], "cut": f, "work": r["name"][:24], "rule": rule, "today": today[i] / eds[i],
                                 "pred": pred, "actual": actual / eds[i], "futureRule": out["allocation"]["futureRule"]})
    df = pd.DataFrame(rows)
    df["err"] = (df["pred"] - df["actual"]) * 100
    kept = df[~df["release"].isin(SET_ASIDE)]
    print(f"releases {kept['release'].nunique()}, works {kept.groupby(['release', 'work']).ngroups}; set aside: {sorted(SET_ASIDE)}")
    print("\nerror in sell-through points (prediction minus actual)")
    for cut, g in kept.groupby("cut"):
        line = " | ".join(f"{r}: avg {abs(h['err']).mean():.1f}, lean {h['err'].mean():+.1f}" for r, h in g.groupby("rule"))
        lag = g[g["actual"] < 0.9]
        lag_line = " | ".join(f"{r}: avg {abs(h['err']).mean():.1f}, lean {h['err'].mean():+.1f}" for r, h in lag.groupby("rule"))
        print(f"  at {cut:.0%}  every work: {line}\n          below 90%:  {lag_line} ({lag.groupby(['release', 'work']).ngroups} works)")
    show = kept[kept["cut"] == (0.4 if 0.4 in cuts else cuts[0])]
    piv = show.pivot_table(index=["release", "work", "today", "actual"], columns="rule", values="pred").reset_index()
    for c in ["today", "actual", "room (before)", "demand split", "cohort (now)"]:
        piv[c] = (piv[c] * 100).round(0).astype(int)
    pd.set_option("display.width", 200)
    print(f"\nwork by work at {show['cut'].iloc[0]:.0%} of the window, in % of the edition")
    print(piv.to_string(index=False))


if __name__ == "__main__":
    main()
