"""The sell-through forecast's backtest, read without hindsight (docs/TL_SPEC.md §4b).

Each completed timed launch with 50 or more pre-window signups and window
units is read at its open with a basket it could have had then: A, the plan's
size basket (Airtable's units target, else the edition, and the price: the
live rule, with launches that closed later left out); B, the eight launches
nearest on pre-window signups and price among those closed before its open;
C, every earlier launch. The forecast is the live one (etl/tl.py
sell_forecast): the basket's signup -> order rates by channel and kind on this
launch's signups, times pieces per signup-led order, plus the basket's
non-signup window units by channel moved clip(signups over the basket's,
0.5 to 2) ** beta of the way. Printed: the error on window units at each
beta, the within-basket slope of non-signup units on signups, and how the
launches far above their basket on signups sold.

Two launches are set aside from the fit at the owner's word (4 October 2026):
their pre-window campaigns brought a flood of signups that hardly ordered, so
neither says how signups turn into sales. They stay on the panel and in the
live baskets; --keep leaves them in the fit for the comparison.

Reads sources/tl_events.csv (the signup, purchase and channel columns only;
no account id, no address) and the built panel. Aggregates only: no id is
printed. Run from the repo root after a build:
python3 etl/analysis/tl_forecast_backtest.py [--keep]
"""
import json
import math
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import tl  # noqa: E402

SET_ASIDE = ("Danielle Mckinney · Sandman · 2025 Q1", "Parra · Multiple · 2025 Q3")
MIN_SIGNUPS = 50
BETAS = ((0.0, (1, 1)), (0.2, (0.5, 2.0)), (0.5, (0.25, 4.0)), (1.0, (0.1, 10.0)))
GROUPS = tl.GROUPS
G2 = GROUPS + ["untracked"]
COLS = ["event_timestamp", "event_name", "simple_release_name", "aa_subscription_type", "converted_signup",
        "order_pieces", "purchase_with_signup", "cancelled_order", "AA_session_custom_channel_group_split_touch"]


def flag(s):
    return s.map(lambda v: str(v).strip().lower() in ("1", "1.0", "true"))


def med(frame, col):
    v = pd.to_numeric(frame[col], errors="coerce").dropna()
    return float(v.median()) if len(v) else np.nan


def launches(panel):
    ev = pd.read_csv(ROOT / "sources" / "tl_events.csv", usecols=COLS, low_memory=False)
    ev["ts"] = pd.to_datetime(ev["event_timestamp"], utc=True, errors="coerce")
    ev["group"] = ev["AA_session_custom_channel_group_split_touch"].fillna("Untracked").map(tl.GROUP_OF).fillna("untracked")
    ev["conv"], ev["with_su"], ev["cancelled"] = flag(ev["converted_signup"]), flag(ev["purchase_with_signup"]), flag(ev["cancelled_order"])
    ev["pieces"] = pd.to_numeric(ev["order_pieces"], errors="coerce").fillna(0.0)
    ev["ptype"] = np.where(ev["aa_subscription_type"].astype(str).str.lower().eq("product"), "prod", "rel")
    rows = []
    for r in panel.itertuples():
        g = ev[ev["simple_release_name"] == r.release_name]
        if not len(g):
            continue
        so, cl = pd.Timestamp(r.sales_open), pd.Timestamp(r.close)
        settle = cl + pd.Timedelta(days=tl.TL_SETTLE_DAYS)
        su = g[(g["event_name"] == "signup") & (g["ts"] < so)]
        pu = g[(g["event_name"] == "purchase") & ~g["cancelled"] & (g["ts"] >= so) & (g["ts"] <= settle)]
        row = {"release": r.release_name, "artist": r.artist, "signups": len(su), "units": pu["pieces"].sum(),
               "units_su": pu.loc[pu["with_su"], "pieces"].sum(), "units_nonsu": pu.loc[~pu["with_su"], "pieces"].sum(),
               "ppo_su": pu.loc[pu["with_su"], "pieces"].mean() if pu["with_su"].any() else np.nan,
               "conv_all": su["conv"].mean() if len(su) else np.nan, "open": so, "close": cl,
               "units_target": r.units_target, "edition_size": r.edition_size, "price": r.unit_price_eur,
               "window_hours": r.window_hours, "announce": r.announce}
        for grp in G2:
            sg, pg = su[su["group"] == grp], pu[pu["group"] == grp]
            row[f"su_{grp}"] = len(sg)
            row[f"conv_{grp}"] = sg["conv"].mean() if len(sg) else np.nan
            for t in ("prod", "rel"):
                st = sg[sg["ptype"] == t]
                row[f"su_{grp}_{t}"] = len(st)
                row[f"conv_{grp}_{t}"] = st["conv"].mean() if len(st) else np.nan
            row[f"nonsu_{grp}"] = pg.loc[~pg["with_su"], "pieces"].sum()
        for t in ("prod", "rel"):
            st = su[su["ptype"] == t]
            row[f"conv_{t}"] = st["conv"].mean() if len(st) else np.nan
        rows.append(row)
    d = pd.DataFrame(rows)
    return d[(d["signups"] >= MIN_SIGNUPS) & (d["units"] > 0)].reset_index(drop=True)


def forecast(r, ref, beta, clip):
    su_units = 0.0
    for grp in G2:
        for t in ("prod", "rel"):
            c = med(ref, f"conv_{grp}_{t}")
            if np.isnan(c):
                c = med(ref, f"conv_{t}")
            if np.isnan(c):
                c = med(ref, "conv_all")
            su_units += r[f"su_{grp}_{t}"] * c
    ppo = med(ref, "ppo_su")
    su_units *= ppo if not np.isnan(ppo) else 1.0
    nonsu = 0.0
    for grp in G2:
        m_units, m_su = med(ref, f"nonsu_{grp}"), med(ref, f"su_{grp}")
        perf = (r[f"su_{grp}"] / m_su) if m_su > 0 else 1.0
        nonsu += m_units * (min(max(perf, clip[0]), clip[1]) ** beta)
    return su_units, nonsu


def main():
    keep = "--keep" in sys.argv
    panel = pd.read_csv(ROOT / "data" / "app" / "tl_panel.csv")
    curves = json.load(open(ROOT / "data" / "app" / "tl_curves.json")).get("curves", {})
    d = launches(panel)
    if not keep:
        print("set aside from the fit:", [r for r in d["release"] if r in SET_ASIDE])
        d = d[~d["release"].isin(SET_ASIDE)].reset_index(drop=True)
    print(f"launches: {len(d)}; with a plan size (target or edition): {int((d['units_target'].notna() | d['edition_size'].notna()).sum())}")

    def earlier(r):
        return d[(d["close"] < r["open"]) & (d["release"] != r["release"])]

    def basket_plan(r):
        size = r["units_target"] if pd.notna(r["units_target"]) else r["edition_size"]
        if pd.isna(size):
            return None
        rel = {"release_name": r["release"], "artist": r["artist"], "window_open": str(r["open"]), "window_hours": float(r["window_hours"]),
               "units_target": float(size), "unit_price_eur": float(r["price"]) if pd.notna(r["price"]) else None,
               "announce_date": str(r["announce"])[:10], "launch_end": str(r["open"])[:10], "prefer_recent": True}
        bs = {b["id"]: b for b in tl.ready_baskets(panel, curves, rel, pd.Timestamp(r["open"]).date())}
        b = bs.get("similar_size") or bs.get("all_tl")
        return [m for m in (b["members"] if b else []) if m != r["release"]]

    def basket_signups(r, n=8):
        pool = earlier(r)
        if len(pool) < 2:
            return []
        ds = np.abs(np.log(pool["signups"].clip(lower=1) / max(r["signups"], 1)))
        if pd.notna(r["price"]):
            ds = ds + 0.5 * np.abs(np.log(pool["price"].astype(float) / float(r["price"]))).fillna(0.0)
        return pool.assign(dist=ds).sort_values("dist").head(n)["release"].tolist()

    sets = {"A plan-size basket": {}, "B signups basket": {}, "C every earlier launch": {}}
    for _, r in d.iterrows():
        pa, pb, pc = basket_plan(r), basket_signups(r), earlier(r)
        sets["A plan-size basket"][r["release"]] = d[d["release"].isin(pa)] if pa else None
        sets["B signups basket"][r["release"]] = d[d["release"].isin(pb)] if len(pb) >= 2 else None
        sets["C every earlier launch"][r["release"]] = pc if len(pc) >= 2 else None
    for name, refs in sets.items():
        for beta, clip in BETAS:
            errs, es, en, ratios = [], [], [], []
            for _, r in d.iterrows():
                ref = refs.get(r["release"])
                if ref is None or len(ref) < 2:
                    continue
                su_u, non_u = forecast(r, ref, beta, clip)
                errs.append((su_u + non_u - r["units"]) / r["units"])
                ratios.append(r["units"] / (su_u + non_u) if su_u + non_u > 0 else np.nan)
                if r["units_su"] > 0:
                    es.append((su_u - r["units_su"]) / r["units_su"])
                if r["units_nonsu"] > 0:
                    en.append((non_u - r["units_nonsu"]) / r["units_nonsu"])
            e, es_, en_, rt = pd.Series(errs), pd.Series(es), pd.Series(en), pd.Series(ratios).dropna()
            print(f"{name:24s} beta {beta:3.1f}: total med abs {100 * e.abs().median():3.0f}% within25 {100 * (e.abs() <= 0.25).mean():3.0f}% "
                  f"signed {100 * e.median():+3.0f}% | su {100 * es_.abs().median():3.0f}% | non-su {100 * en_.abs().median():3.0f}% "
                  f"signed {100 * en_.median():+3.0f}% | band P25 {rt.quantile(0.25):.2f} P75 {rt.quantile(0.75):.2f} (n {len(e)})")
    for name in ("A plan-size basket", "B signups basket"):
        ps, pn = [], []
        for _, r in d.iterrows():
            ref = sets[name].get(r["release"])
            if ref is None or len(ref) < 2 or med(ref, "signups") <= 0 or med(ref, "units_nonsu") <= 0 or r["units_nonsu"] <= 0:
                continue
            ps.append(math.log(r["signups"] / med(ref, "signups")))
            pn.append(math.log(r["units_nonsu"] / med(ref, "units_nonsu")))
        ps, pn = pd.Series(ps), pd.Series(pn)
        print(f"{name}: within-basket slope of non-signup units on signups {np.polyfit(ps, pn, 1)[0]:.2f}, "
              f"rank corr {ps.rank().corr(pn.rank()):.2f}, n {len(ps)}")
    big = []
    for _, r in d.iterrows():
        ref = sets["A plan-size basket"].get(r["release"])
        if ref is None or len(ref) < 2 or med(ref, "signups") <= 0 or med(ref, "units_nonsu") <= 0:
            continue
        big.append((r["release"], r["signups"] / med(ref, "signups"), r["units_nonsu"] / med(ref, "units_nonsu"),
                    r["units"] / med(ref, "units"), r["units_su"] / max(r["units"], 1)))
    bf = pd.DataFrame(big, columns=["release", "perf_signups", "perf_nonsu", "perf_units", "su_share"])
    for lo, hi in ((0, 0.5), (0.5, 1), (1, 2), (2, 4), (4, 100)):
        sub = bf[(bf["perf_signups"] > lo) & (bf["perf_signups"] <= hi)]
        if len(sub):
            print(f"A {lo}-{hi}x signups: n {len(sub)}, non-signup units {sub['perf_nonsu'].median():.2f}x basket "
                  f"(IQR {sub['perf_nonsu'].quantile(0.25):.2f}-{sub['perf_nonsu'].quantile(0.75):.2f}), units {sub['perf_units'].median():.2f}x, "
                  f"signup-led share {100 * sub['su_share'].median():.0f}%")
    print(bf.sort_values("perf_signups", ascending=False).head(6).round(2).to_string(index=False))


if __name__ == "__main__":
    main()
