#!/usr/bin/env python3
"""What drives framing conversion (frames per print a frame was on offer for).

Asked on 10 October 2026: does the price, the size of the print, the number
of works in the launch or the launch's reliance on paid social move the share
of buyers who take a frame? The figure the Target setting tab needs a
default for (frame_conversion) and Airtable does not hold yet.

Data: data/orders_by_product.csv (per release and work: the paid prints a
frame was on offer for and the frames bought with them, the list price);
data/release_clusters.csv (the draw panel: channel shares, works in the
launch, the Airtable record ids) and data/app/tl_panel.csv (the timed
launches: paid share of units and signups); data/release_pricing.csv (the
Airtable pull: dimensions, framing, product type, artist tier). A work
counts with 10 paid prints or more, a launch with 20; a work Airtable says
is framed as a whole ("Full Edition Framed") is left out, since its buyers
chose nothing.

Reads: rank correlations, medians by band, a binomial logistic regression
with the prints as trials (IRLS in numpy; nothing else is installed here),
the same with each work's prints capped so no launch carries it, the
drivers net of the work's year-and-kind mean, and the within-launch read
(a work against the other works of its launch, which holds the artist, the
moment and the audience fixed).
  python3 etl/analysis/framing_conversion.py

What it found, 10 October 2026 (281 works with ten or more paid prints, in
134 launches, 2023 to 2026; 37% of paid prints took a frame over all):
- The year and the kind of launch dominate. Draw launches went from 26% of
  paid prints framed in 2024 to 45% in 2025 and 53% in 2026; timed launches
  held at 31% to 35% throughout. The rise is the draw's, not a change in
  what was sold.
- Price moves it a little, between launches only: net of year and kind
  +0.12 rank correlation, about two or three points per doubling of price
  in the regression; in 2026 works under 1,000 euros framed at 42%, works
  above at 50% to 52%. Within one launch the pricier work frames no more
  than its siblings (+0.4 points), so the price reads as the audience a
  pricier launch draws, not the print itself.
- Dimensions do not drive it: nothing within a launch (-0.04), nothing net
  of year and kind (-0.05), a weak negative in the regression (bigger
  prints a touch less, their frames costing more).
- The number of works in the launch: flat in the raw bands (36% to 40% from
  one work to five or more); net of year and kind a mild negative (-0.16,
  three or four points per four extra works in the regression).
- Reliance on paid: nothing. The raw rank correlation with the paid share
  of units is +0.02, net of year and kind -0.12, and the regression's
  coefficient is zero once the big launches are capped. A draw-only
  correlation with the paid social share of sessions (+0.38) was the year:
  the 2026 draws lean on paid social and frame more for other reasons.
- The frame's price against the print's (etl/analysis/frame_prices.js,
  asked the same day) is the one lever that holds up. The median frame
  sold for 375 euros, 45% of its print's price (quartiles 26% to 50%).
  Works whose frame cost under 20% of the print framed at 44% (57% in
  2026), 20% to 35% at 43% (52%), 35% to 50% at 38% (45%), 50% and over
  at 33% (38%): rank correlation -0.22, the same net of year and kind. The
  frame's own price in euros does not matter (+0.08); it is the ratio.
  With the ratio in the regression the price's coefficient goes to nothing
  (-0.06, z -1.8): a print's price mattered because frames cost much the
  same in euros whatever the print, so a dearer print carries a cheaper
  frame relative to itself. Within one launch the ratio does not separate
  the works (-0.00), as the price did not: the read is between launches.
  A work with more frame price points on offer frames a little more
  (+0.14).
- Also: bigger editions frame less (-0.26 net of year and kind, with price
  and kind behind it); artist tier and product type (silkscreen, hybrid,
  digital) make no difference.
For a default (frame_conversion on the Target setting tab, the benchmark
constant today): the 2026 launches say about 50% on a draw (median work
52%, quartiles 43% to 62%) and about 35% to 40% on a timed launch (median
40%, quartiles 29% to 46%); a draw whose frame costs half the print or
more nearer 38%, one whose frame costs under a third of the print nearer
52% to 57%.
"""
from __future__ import annotations

import math
import pathlib
import re
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
MIN_PRINTS_WORK, MIN_PRINTS_LAUNCH = 10, 20


def norm(s) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def dims_cm(text) -> tuple[float | None, float | None]:
    """Height and width in cm off Airtable's dimensions text ("60 x 45 cm",
    "60 × 45 × 3 cm", "60cm x 45cm"); None where it carries fewer than two."""
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", str(text or ""))]
    if len(nums) < 2:
        return None, None
    return nums[0], nums[1]


def spearman(x, y) -> tuple[float, int]:
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 4:
        return float("nan"), len(x)
    rx, ry = pd.Series(x).rank().to_numpy(), pd.Series(y).rank().to_numpy()
    return float(np.corrcoef(rx, ry)[0, 1]), len(x)


def logistic(X: np.ndarray, frames: np.ndarray, prints: np.ndarray, names: list[str]) -> list[tuple[str, float, float]]:
    """Binomial logistic regression by IRLS: frames of prints ~ X. Returns
    (name, coefficient, standard error) per column; the intercept first."""
    Xa = np.column_stack([np.ones(len(X)), X])
    beta = np.zeros(Xa.shape[1])
    for _ in range(50):
        eta = Xa @ beta
        p = 1 / (1 + np.exp(-eta))
        w = prints * p * (1 - p) + 1e-9
        z = eta + (frames - prints * p) / w
        XtW = Xa.T * w
        beta_new = np.linalg.solve(XtW @ Xa + 1e-9 * np.eye(Xa.shape[1]), XtW @ z)
        if np.max(np.abs(beta_new - beta)) < 1e-8:
            beta = beta_new
            break
        beta = beta_new
    p = 1 / (1 + np.exp(-(Xa @ beta)))
    w = prints * p * (1 - p) + 1e-9
    cov = np.linalg.inv((Xa.T * w) @ Xa + 1e-9 * np.eye(Xa.shape[1]))
    se = np.sqrt(np.diag(cov))
    return list(zip(["intercept"] + names, beta.tolist(), se.tolist()))


def band_table(df: pd.DataFrame, col: str, edges: list[float], labels: list[str], w: str = "offered") -> pd.DataFrame:
    """Frames over prints (the pooled rate) and the median work's rate per band, with the count."""
    b = pd.cut(df[col], bins=edges, labels=labels, include_lowest=True)
    g = df.groupby(b, observed=True)
    out = pd.DataFrame({"n": g.size(), "pooled": g.apply(lambda s: s["frames"].sum() / max(s[w].sum(), 1)), "median": g["conv"].median()})
    return out.round(3)


def main() -> None:
    o = pd.read_csv(DATA / "orders_by_product.csv")
    o["offered"] = o["prints_offered_paid"].fillna(0).astype(float)
    o["frames"] = o["frames_paid"].fillna(0).astype(float)
    o = o[o["offered"] > 0].copy()
    o["conv"] = o["frames"] / o["offered"]

    # ---- the launches' context: the draw panel and the TL panel
    panel = pd.read_csv(DATA / "release_clusters.csv")[["release_name", "unit_share_paid", "chan_share_Paid Social", "airtable_ids", "n_products", "unit_price_eur", "edition_size", "year"]].copy()
    panel["paid_share"] = pd.to_numeric(panel["unit_share_paid"], errors="coerce")
    panel["paid_social_sessions"] = pd.to_numeric(panel["chan_share_Paid Social"], errors="coerce")
    panel["kind"] = "draw"
    tlp = pd.read_csv(DATA / "app" / "tl_panel.csv")
    tlp["paid_share"] = pd.to_numeric(tlp["paid_share_units"], errors="coerce")
    tlp["kind"] = "timed"
    ctx = pd.concat([
        panel[["release_name", "kind", "paid_share", "paid_social_sessions", "airtable_ids", "n_products", "unit_price_eur", "edition_size", "year"]],
        tlp.assign(year=pd.to_datetime(tlp["close"], errors="coerce").dt.year, airtable_ids=None, n_products=None)[
            ["release_name", "kind", "paid_share", "airtable_release", "airtable_ids", "n_products", "unit_price_eur", "edition_size", "year"]],
    ], ignore_index=True).drop_duplicates("release_name")

    # ---- Airtable's records: dimensions, framing, type, tier; joined per work by title within the launch
    rp = pd.read_csv(DATA / "release_pricing.csv", dtype=str).fillna("")
    rp["h"], rp["w"] = zip(*rp["dimensions"].map(dims_cm))
    rp["area"] = rp["h"] * rp["w"]
    rp["long_side"] = rp[["h", "w"]].max(axis=1)
    rp["key"] = rp["title"].map(norm)
    by_id = rp.set_index(rp["airtable_id"].str.replace(r"\.0$", "", regex=True))
    by_release_code = {code: g for code, g in rp.groupby("release")}

    rows = []
    for r in o.itertuples(index=False):
        c = ctx[ctx["release_name"] == r.release]
        c = c.iloc[0] if len(c) else None
        recs = pd.DataFrame()
        if c is not None and isinstance(c["airtable_ids"], str) and c["airtable_ids"]:
            ids = [i for i in c["airtable_ids"].split("|") if i]
            recs = by_id.loc[[i for i in ids if i in by_id.index]]
        elif c is not None and isinstance(c.get("airtable_release"), str) and c["airtable_release"] in by_release_code:
            recs = by_release_code[c["airtable_release"]]
        rec = None
        if len(recs):
            k = norm(r.product_title)
            hit = recs[recs["key"] == k]
            if not len(hit):
                hit = recs[recs["key"].map(lambda x: bool(x) and (x in k or k in x))]
            rec = hit.iloc[0] if len(hit) else None
        framing = rec["framing"] if rec is not None else ""
        area = rec["area"] if rec is not None and pd.notna(rec["area"]) else (recs["area"].median() if len(recs) else np.nan)
        long_side = rec["long_side"] if rec is not None and pd.notna(rec["long_side"]) else (recs["long_side"].median() if len(recs) else np.nan)
        rows.append({
            "release": r.release, "work": r.product_title, "offered": r.offered, "frames": r.frames, "conv": r.conv,
            "price": float(r.list_price_eur) if pd.notna(r.list_price_eur) else np.nan,
            "kind": c["kind"] if c is not None else None, "paid_share": c["paid_share"] if c is not None else np.nan,
            "paid_social_sessions": c["paid_social_sessions"] if c is not None and "paid_social_sessions" in c else np.nan,
            "year": c["year"] if c is not None else np.nan, "edition_size": c["edition_size"] if c is not None else np.nan,
            "framing": framing, "area": area, "long_side": long_side,
            "product_type": rec["product_type"] if rec is not None else (recs["product_type"].mode().iloc[0] if len(recs) and recs["product_type"].mode().size else ""),
            "artist_tier": rec["artist_tier"] if rec is not None else (recs["artist_tier"].mode().iloc[0] if len(recs) and recs["artist_tier"].mode().size else ""),
            "matched": rec is not None,
        })
    w = pd.DataFrame(rows)
    # works in the launch: the works a frame was on offer for, from the orders themselves
    w["works_in_launch"] = w.groupby("release")["work"].transform("nunique")
    # the frame's price against the print's (etl/analysis/frame_prices.js): joined by the work's SKU code
    w["work_code"] = o["skus"].map(lambda v: str(v or "").split("|")[0].upper().split("-")[:2]).map(lambda parts: "-".join(parts) if len(parts) == 2 else None).to_numpy()
    fp_path = DATA / "frame_prices.csv"
    if fp_path.exists():
        fp = pd.read_csv(fp_path)
        fp = fp[fp["frame_price_median"].notna() & (fp["print_price"] > 0)].drop_duplicates(["release", "work_code"])
        w = w.merge(fp[["release", "work_code", "print_price", "frame_price_median", "frame_price_min", "frame_price_points"]], on=["release", "work_code"], how="left")
        w["frame_ratio"] = w["frame_price_median"] / w["print_price"]
        w["frame_ratio_min"] = w["frame_price_min"] / w["print_price"]
    else:
        w["frame_ratio"] = w["frame_ratio_min"] = w["frame_price_median"] = np.nan
        print("no data/frame_prices.csv: run node etl/analysis/frame_prices.js for the frame price read")
    full = w["framing"].str.startswith("Full Edition")
    print(f"works with a frame on offer: {len(w)} in {w['release'].nunique()} launches; Airtable record matched for {int(w['matched'].sum())}; "
          f"framed as a whole (left out): {int(full.sum())}")
    w = w[~full & (w["offered"] >= MIN_PRINTS_WORK)].copy()
    print(f"kept {len(w)} works with {MIN_PRINTS_WORK}+ paid prints, in {w['release'].nunique()} launches; "
          f"dimensions known for {int(w['area'].notna().sum())}, paid share for {int(w['paid_share'].notna().sum())}")
    w["log_price"] = np.log(w["price"].where(w["price"] > 0))
    w["log_area"] = np.log(w["area"].where(w["area"] > 0))
    pooled = w["frames"].sum() / w["offered"].sum()
    print(f"\nall works pooled: {pooled:.1%} of paid prints took a frame; median work {w['conv'].median():.1%}, "
          f"quartiles {w['conv'].quantile(.25):.1%} to {w['conv'].quantile(.75):.1%}")

    # ---- rank correlations, works and launches
    print("\nSpearman rank correlation with the work's framing rate (n):")
    for col, label in (("price", "price (EUR)"), ("area", "area (cm2)"), ("long_side", "long side (cm)"), ("works_in_launch", "works in the launch"),
                       ("paid_share", "paid share of the launch's units"), ("paid_social_sessions", "paid social share of sessions (draw launches)"),
                       ("edition_size", "edition size"), ("year", "year"), ("offered", "paid prints of the work")):
        rho, n = spearman(w[col], w["conv"])
        print(f"  {label:48s} {rho:+.2f}  (n={n})")
    L = w.groupby("release").agg(offered=("offered", "sum"), frames=("frames", "sum"), price=("price", "median"), area=("area", "median"),
                                 works=("works_in_launch", "first"), paid_share=("paid_share", "first"), year=("year", "first"), kind=("kind", "first")).reset_index()
    L = L[L["offered"] >= MIN_PRINTS_LAUNCH].copy()
    L["conv"] = L["frames"] / L["offered"]
    print(f"\nlaunches with {MIN_PRINTS_LAUNCH}+ paid prints: {len(L)}; pooled {L['frames'].sum() / L['offered'].sum():.1%}, median launch {L['conv'].median():.1%}")
    print("Spearman with the launch's framing rate (n):")
    for col, label in (("price", "median price"), ("area", "median area"), ("works", "works in the launch"), ("paid_share", "paid share of units"), ("year", "year")):
        rho, n = spearman(L[col], L["conv"])
        print(f"  {label:48s} {rho:+.2f}  (n={n})")

    # ---- medians by band
    print("\nby price band (works): n, pooled rate, median work")
    print(band_table(w, "price", [0, 500, 1000, 2000, 4000, 1e9], ["under 500", "500-1,000", "1,000-2,000", "2,000-4,000", "4,000+"]).to_string())
    print("\nby area band, cm2 (works with dimensions): n, pooled rate, median work")
    print(band_table(w[w["area"].notna()], "area", [0, 1500, 3000, 5000, 8000, 1e9], ["under 1,500", "1,500-3,000", "3,000-5,000", "5,000-8,000", "8,000+"]).to_string())
    print("\nby works in the launch (works): n, pooled rate, median work")
    print(band_table(w, "works_in_launch", [0, 1, 2, 4, 100], ["1", "2", "3-4", "5+"]).to_string())
    print("\nby the launch's paid share of units (works): n, pooled rate, median work")
    print(band_table(w[w["paid_share"].notna()], "paid_share", [-0.01, 0.1, 0.25, 0.4, 1.0], ["under 10%", "10-25%", "25-40%", "40%+"]).to_string())
    print("\nby year (works): n, pooled rate, median work")
    print(band_table(w[w["year"].notna()], "year", [2021.5, 2023.5, 2024.5, 2025.5, 2026.5], ["to 2023", "2024", "2025", "2026"]).to_string())
    print("\nby launch kind (works): n, pooled rate, median work")
    print(w.groupby("kind").apply(lambda s: pd.Series({"n": len(s), "pooled": s["frames"].sum() / s["offered"].sum(), "median": s["conv"].median()})).round(3).to_string())
    pt = w[w["product_type"] != ""].groupby("product_type").apply(lambda s: pd.Series({"n": len(s), "pooled": s["frames"].sum() / s["offered"].sum(), "median": s["conv"].median()}))
    print("\nby Airtable product type (works): n, pooled rate, median work")
    print(pt[pt["n"] >= 5].sort_values("pooled", ascending=False).round(3).to_string())
    tier = w[w["artist_tier"] != ""].groupby("artist_tier").apply(lambda s: pd.Series({"n": len(s), "pooled": s["frames"].sum() / s["offered"].sum(), "median": s["conv"].median()}))
    print("\nby artist tier (works): n, pooled rate, median work")
    print(tier.round(3).to_string())

    # ---- the regression: every driver at once, the prints as trials
    m = w.dropna(subset=["log_price", "log_area", "paid_share", "year"]).copy()
    m["timed"] = (m["kind"] == "timed").astype(float)
    cols = ["log_price", "log_area", "works_in_launch", "paid_share", "year", "timed"]
    X = m[cols].to_numpy(float)
    mu, sd = X.mean(axis=0), X.std(axis=0)
    fit = logistic((X - mu) / sd, m["frames"].to_numpy(float), m["offered"].to_numpy(float), cols)
    base = 1 / (1 + math.exp(-fit[0][1]))
    print(f"\nlogistic regression over {len(m)} works ({int(m['offered'].sum())} paid prints), each driver standardised; the rate at the average work {base:.1%}")
    print("  driver                 coefficient   s.e.    z     one s.d. up moves the rate to")
    for (name, b, se), s in zip(fit[1:], sd):
        up = 1 / (1 + math.exp(-(fit[0][1] + b)))
        unit = {"log_price": f"(x{math.exp(s):.2f} on price)", "log_area": f"(x{math.exp(s):.2f} on area)", "works_in_launch": f"(+{s:.1f} works)",
                "paid_share": f"(+{s:.0%} paid)", "year": f"(+{s:.1f} years)", "timed": ""}[name]
        print(f"  {name:22s} {b:+.3f}       {se:.3f}  {b / se:+5.1f}   {up:.1%} {unit}")

    # ---- year and kind apart: the rate by year within each kind, since the timed launches are the older ones
    print("\nby year and kind: pooled rate (n works)")
    yk = w.dropna(subset=["year"]).groupby([pd.cut(w["year"], [2021.5, 2023.5, 2024.5, 2025.5, 2026.5], labels=["to 2023", "2024", "2025", "2026"]), "kind"], observed=True)
    print(yk.apply(lambda s: f"{s['frames'].sum() / s['offered'].sum():.1%} ({len(s)})").unstack().to_string())

    # ---- the drivers with the year taken out: each work's rate against its year-and-kind mean
    ym = w.dropna(subset=["year"]).copy()
    ym["resid"] = ym["conv"] - ym.groupby([ym["year"].round(), "kind"])["conv"].transform("mean")
    print("\nSpearman with the work's rate net of its year-and-kind mean (n):")
    for col, label in (("price", "price (EUR)"), ("area", "area (cm2)"), ("works_in_launch", "works in the launch"), ("paid_share", "paid share of the launch's units"),
                       ("paid_social_sessions", "paid social share of sessions (draw launches)"), ("edition_size", "edition size")):
        rho, n = spearman(ym[col], ym["resid"])
        print(f"  {label:48s} {rho:+.2f}  (n={n})")

    # ---- the regression again with no launch allowed to dominate: each work's prints capped at 100
    mc = m.copy()
    cap = 100.0
    scale = np.minimum(1.0, cap / mc["offered"])
    fitc = logistic((X - mu) / sd, (mc["frames"] * scale).to_numpy(float), (mc["offered"] * scale).to_numpy(float), cols)
    print(f"\nthe same regression with each work's prints capped at {cap:.0f} (the big launches no longer carry it); z is still optimistic, works of one launch move together")
    for (name, b, se), (_, b0, _) in zip(fitc[1:], fit[1:]):
        print(f"  {name:22s} {b:+.3f} (s.e. {se:.3f}, z {b / se:+4.1f})   uncapped {b0:+.3f}")

    # ---- the recent launches alone, the ones a default for a 2026 launch should read
    recent = w[w["year"] >= 2026]
    print(f"\n2026 launches only ({len(recent)} works): pooled {recent['frames'].sum() / recent['offered'].sum():.1%}, median work {recent['conv'].median():.1%}")
    print(recent.groupby("kind").apply(lambda s: pd.Series({"n": len(s), "pooled": s["frames"].sum() / s["offered"].sum(), "median": s["conv"].median(), "q25": s["conv"].quantile(.25), "q75": s["conv"].quantile(.75)})).round(3).to_string())
    print("2026, by price band (works): n, pooled rate, median work")
    print(band_table(recent, "price", [0, 1000, 2000, 1e9], ["under 1,000", "1,000-2,000", "2,000+"]).to_string())
    print("2026, by paid social share of sessions, draw launches: n, pooled, median")
    print(band_table(recent[recent["paid_social_sessions"].notna()], "paid_social_sessions", [-0.01, 0.1, 0.2, 1.0], ["under 10%", "10-20%", "20%+"]).to_string())

    # ---- the frame's price against the print's
    fr = w[w["frame_ratio"].notna()].copy()
    if len(fr):
        print(f"\nframe price (works with a frame price, n={len(fr)}): median frame {fr['frame_price_median'].median():.0f} EUR, "
              f"frame over print price median {fr['frame_ratio'].median():.0%} (quartiles {fr['frame_ratio'].quantile(.25):.0%} to {fr['frame_ratio'].quantile(.75):.0%}); "
              f"price points per work median {fr['frame_price_points'].median():.0f}")
        print("Spearman with the work's framing rate (n):")
        for col, label in (("frame_ratio", "frame price over print price (median frame sold)"), ("frame_ratio_min", "the same with the cheapest frame"),
                           ("frame_price_median", "frame price itself (EUR)"), ("frame_price_points", "frame price points on offer")):
            rho, n = spearman(fr[col], fr["conv"])
            print(f"  {label:48s} {rho:+.2f}  (n={n})")
        fy = fr.dropna(subset=["year"]).copy()
        fy["resid"] = fy["conv"] - fy.groupby([fy["year"].round(), "kind"])["conv"].transform("mean")
        print("net of the year-and-kind mean:")
        for col, label in (("frame_ratio", "frame price over print price"), ("frame_ratio_min", "the same with the cheapest frame"), ("frame_price_median", "frame price itself (EUR)")):
            rho, n = spearman(fy[col], fy["resid"])
            print(f"  {label:48s} {rho:+.2f}  (n={n})")
        print("by the ratio of the frame's price to the print's (works): n, pooled rate, median work")
        print(band_table(fr, "frame_ratio", [0, 0.2, 0.35, 0.5, 10], ["under 20%", "20-35%", "35-50%", "50%+"]).to_string())
        print("2026 only, by the ratio: n, pooled rate, median work")
        print(band_table(fr[fr["year"] >= 2026], "frame_ratio", [0, 0.2, 0.35, 0.5, 10], ["under 20%", "20-35%", "35-50%", "50%+"]).to_string())
        print("by the frame's own price (works): n, pooled rate, median work")
        print(band_table(fr, "frame_price_median", [0, 300, 450, 700, 1e9], ["under 300", "300-450", "450-700", "700+"]).to_string())
        # within a launch: the work whose frame is dearer against the print, beside its siblings
        d = fr[fr["works_in_launch"] >= 2].copy()
        g = d.groupby("release")
        d["dx"] = d["frame_ratio"] - g["frame_ratio"].transform("mean"); d["dy"] = d["conv"] - g["conv"].transform("mean")
        d = d[d.groupby("release")["work"].transform("count") >= 2]
        rho, n = spearman(d["dx"], d["dy"])
        print(f"within a launch, the ratio against the launch's other works: Spearman {rho:+.2f} (n={n} works in {d['release'].nunique()} launches)")
        # the regression again with the ratio in it
        mr = fr.dropna(subset=["log_price", "log_area", "paid_share", "year"]).copy()
        mr["timed"] = (mr["kind"] == "timed").astype(float)
        mr["log_ratio"] = np.log(mr["frame_ratio"])
        cols_r = ["log_ratio", "log_price", "log_area", "works_in_launch", "paid_share", "year", "timed"]
        Xr = mr[cols_r].to_numpy(float)
        mur, sdr = Xr.mean(axis=0), Xr.std(axis=0)
        scale = np.minimum(1.0, 100.0 / mr["offered"])
        fitr = logistic((Xr - mur) / sdr, (mr["frames"] * scale).to_numpy(float), (mr["offered"] * scale).to_numpy(float), cols_r)
        base_r = 1 / (1 + math.exp(-fitr[0][1]))
        print(f"logistic regression with the ratio, {len(mr)} works, prints capped at 100 a work; the rate at the average work {base_r:.1%}")
        for (name, b, se), sdev in zip(fitr[1:], sdr):
            up = 1 / (1 + math.exp(-(fitr[0][1] + b)))
            print(f"  {name:22s} {b:+.3f} (s.e. {se:.3f}, z {b / se:+4.1f})   one s.d. up ({'x%.2f' % math.exp(sdev) if name.startswith('log') else '+%.2f' % sdev}): {up:.1%}")

    # ---- within a launch: the work against its siblings (artist, moment and audience held)
    multi = w[w["works_in_launch"] >= 2].copy()
    for col in ("log_price", "log_area"):
        g = multi.dropna(subset=[col]).groupby("release")
        d = multi.dropna(subset=[col]).assign(dx=lambda s: s[col] - g[col].transform("mean"), dy=lambda s: s["conv"] - g["conv"].transform("mean"))
        d = d[d.groupby("release")["work"].transform("count") >= 2]
        rho, n = spearman(d["dx"], d["dy"])
        print(f"\nwithin a launch, {col.replace('log_', '')} against the launch's other works: Spearman {rho:+.2f} (n={n} works in {d['release'].nunique()} launches)")
        hi = d[d["dx"] > 0]["dy"].mean(); lo = d[d["dx"] < 0]["dy"].mean()
        print(f"  the pricier/bigger works of a launch frame {hi:+.1%} against the launch's mean, the cheaper/smaller {lo:+.1%}")


if __name__ == "__main__":
    main()
