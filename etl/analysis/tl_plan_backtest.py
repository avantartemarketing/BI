"""Would the plan model read a timed launch? Four readings on the launches closed so far
(docs/PLAN_MODEL.md 8, "Timed launches").

The plan model (etl/plan_model.py, etl/analysis/plan_backtest.py) reads a draw launch by
the comms that go out. A timed launch has two stages (docs/TL_SPEC.md 2): signups from the
announce to the sales open, then units by the hour in the window. This asks, of each stage,
what the activity explains that the campaign clock and the basket do not:

  1. signups outside paid, announce to open: the draw launches' price list fitted to them,
     the day-to-day pattern and the forecast of the final count from five points, against
     the clock (the pooled median curve). plan_backtest's own fit and forecast, on signups.
  2. before a launch starts: its pre-window signups told from similar past launches alone,
     from its paid budget at their cost a signup, and from the budget with its plan's comms.
  3. paid signups part way through: the clock against the spend still to come, at the
     launch's own cost a signup so far, marked up by how much dearer the later signups have
     usually been.
  4. the window: units to people who never signed up, told from similar launches, and with
     the window's emails, its paid spend and the launch's signups added.

Every launch is read from the others (1, 3: left out of the fit; 2, 4: only the launches
that opened before it announced). It writes nothing: the figures are printed, and
docs/PLAN_MODEL.md records them. Needs the Notion plan read in full and the HubSpot
audiences (README, "The plan model"); run from the repo root:
    python3 etl/analysis/tl_plan_backtest.py [--comms data/notion_comms.csv --campaigns data/notion_comms_campaigns.csv]
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
sys.path.insert(0, str(ROOT / "etl" / "analysis"))
import build  # noqa: E402
import plan_backtest as B  # noqa: E402
import tl  # noqa: E402

P = B.P
PLAN_FROM = pd.Timestamp("2023-09-15")     # the Notion plan begins in September 2023
SIZED_FROM = pd.Timestamp("2024-06-01")    # readings 2 and 4: launches with a year of launches behind them
MIN_SIGNUPS = 25.0                         # a launch with fewer signups outside paid says nothing about shape
NEAR = 8                                   # the similar launches a reading is taken from
PARTWAY = (0.25, 0.5, 0.75)


def miss(pred, actual) -> tuple[float, int]:
    """The typical miss either way (the median of |log(forecast / actual)| as a share), and on how many."""
    pred, actual = np.asarray(pred, dtype=float), np.asarray(actual, dtype=float)
    ok = (pred > 0) & (actual > 0) & np.isfinite(pred) & np.isfinite(actual)
    return (float(np.expm1(np.median(np.abs(np.log(pred[ok] / actual[ok]))))) if ok.any() else float("nan")), int(ok.sum())


def load(comms_path=None, campaigns_path=None) -> dict:
    pan = pd.read_csv(ROOT / "data" / "app" / "tl_panel.csv")
    for c in ("announce", "sales_open", "close"):
        pan[c] = pd.to_datetime(pan[c], errors="coerce", utc=True).dt.tz_localize(None)
    pan = pan[pan["announce"].notna() & pan["sales_open"].notna()].sort_values("sales_open").reset_index(drop=True)
    s = pd.read_csv(ROOT / "data" / "tl_signups_by_product.csv", low_memory=False)
    s["day"] = pd.to_datetime(s["date"])
    s["group"] = s["channel"].map(tl.GROUP_OF).fillna("untracked")
    prices = P.load_prices()
    if not prices or "clicks" not in prices:
        raise SystemExit("etl/plan_prices.json is missing: run etl/analysis/plan_backtest.py first")
    return {"panel": pan, "signups": s[s["stage"] == "Pre-Launch"], "comms": P.load_comms(comms_path), "campaigns": P.load_campaigns(campaigns_path),
            "aud": P.load_audiences(), "coef": np.array(prices["clicks"]["coef"]), "spend": build.load_spend()}


def feeds(r, lo, hi, d: dict):
    """A launch's Notion plan rows and marketing emails between two days, found as a draw launch's are."""
    own = r["campaign_code"] if isinstance(r["campaign_code"], str) and r["campaign_code"] else None
    artist = r["artist"] if isinstance(r.get("artist"), str) else str(r["release_name"]).split(" · ")[0]
    key, _ = P.plan_campaign(artist, lo, hi, d["comms"], d["campaigns"], own=own)
    plan = d["comms"][(d["comms"]["campaign_code"] == key) & (d["comms"]["date"] >= lo) & (d["comms"]["date"] <= hi)] if key else d["comms"].iloc[0:0]
    return plan, P.launch_sends(d["aud"], [own, key], lo, hi, artist=artist, plan=plan), own or key, key


def signup_panel(d: dict) -> tuple[dict, dict]:
    """name -> the launch's days from before its announce to its sales open: signups outside paid (y), paid
    signups, the plan's pieces as they ran (X). And why each launch left out is."""
    out, skipped = {}, {}
    for _, r in d["panel"].iterrows():
        name, ann, opn = r["release_name"], r["announce"].normalize(), r["sales_open"].normalize()
        if opn < PLAN_FROM:
            skipped[name] = "before the Notion plan begins"
            continue
        L = int((opn - ann).days)
        if not 4 <= L <= 75:
            skipped[name] = "announce to open under 4 days or over 75"
            continue
        days = pd.date_range(ann - pd.Timedelta(days=P.LEAD_DAYS), opn)
        g = d["signups"][(d["signups"]["release"] == name) & (d["signups"]["day"] <= opn)]
        y = g[~g["group"].isin(["paid", "untracked"])].groupby("day")["signups"].sum().reindex(days).fillna(0.0)
        paid = g[g["group"] == "paid"].groupby("day")["signups"].sum().reindex(days).fillna(0.0)
        if y.sum() < MIN_SIGNUPS:
            skipped[name] = "under 25 signups outside paid"
            continue
        plan, sends, code, key = feeds(r, days[0], opn, d)
        went = plan[plan["status"].isin(P.WENT) & plan["family"].isin(P.POST_FAMILIES + ["email"])]
        if sends.empty or len(went) < B.MIN_PLAN_ROWS:
            skipped[name] = "no plan found in Notion" if not key else "fewer than 5 plan rows that went out" if len(went) < B.MIN_PLAN_ROWS else "no launch email found"
            continue
        ld = P.launch_days(ann, opn, sends, plan, d["coef"])
        out[name] = {"t": ld["t"].to_numpy(), "L": L, "y": y.to_numpy(dtype=float), "paid": paid.to_numpy(dtype=float), "X": ld[P.VALUE_COLS].to_numpy(dtype=float),
                     "sends": sends, "plan": plan, "announce": ann, "close": opn, "code": code}
    return out, skipped


def reading_1(panel: dict, d: dict) -> np.ndarray:
    names = sorted(panel)
    th_all = B.fit_prices(panel, names)
    pr = B.as_prices(th_all)
    reliability = P.plan_reliability(d["comms"], d["panel"]["close"].max())
    print("\n1. Signups outside paid, from the announce to the sales open")
    print("   the price list fitted to them, in quiet days (an email per 100 expected clicks, a post each):")
    for c in P.VALUE_COLS:
        used = int(sum((x["X"][:, P.VALUE_COLS.index(c)] > 0).sum() for x in panel.values()))
        if used >= 10:
            print(f"     {c:20s} {P.action_value(c, 1.0, pr):6.2f}   on {used} launch-days")
    base = [float(b.sum() / (b.sum() + a.sum())) for b, a in (B.parts(panel[n], th_all) for n in names)]
    print(f"   with nothing going out: {np.median(base):.0%} of a launch's signups outside paid, the median launch")
    rng = np.random.RandomState(B.SEED)
    rec, sse_clock, sse_plan, sst = [], 0.0, 0.0, 0.0
    for fold in np.array_split(rng.permutation(names), min(B.FOLDS, len(names))):
        train = [n for n in names if n not in set(fold)]
        th = B.fit_prices(panel, train, th_all)
        p2 = B.as_prices(th)
        p2["usual"] = B.usual_table(panel, train, th)
        curve = np.median(np.vstack([B.curve_of(panel[n]) for n in train]), axis=0)
        for n in fold:
            x = panel[n]
            t, L, y = x["t"], x["L"], x["y"]
            Y, m_run = y.sum(), B.mu(x, th)
            share = np.diff(np.r_[0.0, np.interp(t / L, B.GRID, curve)])
            share = share / share.sum()
            sse_clock += float(((y / Y - share) ** 2).sum())
            sse_plan += float(((y / Y - m_run / m_run.sum()) ** 2).sum())
            sst += float(((y / Y - 1.0 / len(y)) ** 2).sum())
            for label, frac in B.CUTS:
                tc = 2 if frac is None else int(round(frac * L))
                seen = float(y[t <= tc].sum())
                if tc >= L or seen < 5:
                    continue
                clock = seen / max(float(np.interp(tc / L, B.GRID, curve)), 1e-6)
                xx = dict(x, X=B.planned_X(x, d["coef"], x["announce"] + pd.Timedelta(days=tc), reliability))
                ratio = B.ratio_at(B.mu(xx, th), t, tc)
                row = {"cut": label, "final": Y, "seen": seen, "clock": clock, "plan": seen * (1.0 + ratio) if ratio is not None else clock}
                row["anchored"] = P.anchored(seen, clock - seen, ratio, P.usual_ratio(p2, tc / L), 0.5)["forecast"]
                rec.append(row)
    R = pd.DataFrame(rec)
    R["to_come"] = R["final"] - R["seen"]
    print(f"   day-to-day pattern explained, each launch from the others: clock {1 - sse_clock / sst:.0%}, plan {1 - sse_plan / sst:.0%}")
    print("   the final count forecast from each point (typical miss on the final | on what was still to come):")
    for label, _ in B.CUTS:
        g = R[R["cut"] == label]
        ok = g["to_come"] >= 3
        cells = [f"{miss(g[c], g['final'])[0]:4.0%} | {miss((g[c] - g['seen']).clip(lower=0.5)[ok], g['to_come'].clip(lower=0.5)[ok])[0]:4.0%}" for c in ("clock", "plan", "anchored")]
        print(f"     {label:24s} n={len(g):2d}   clock {cells[0]}   plan alone {cells[1]}   anchored 0.5 {cells[2]}")
    return th_all


def near(pan: pd.DataFrame, i: int, need: str | None = None) -> pd.DataFrame:
    """The NEAR launches that opened before launch i announced, nearest it on size and price."""
    r = pan.iloc[i]
    e = pan[pan["sales_open"] < r["announce"]]
    if need:
        e = e[e[need].notna() & (e[need] > 0)]
    if len(e) < 4:
        return e.iloc[0:0]
    dist = np.maximum(np.abs(e["lsize"] - r["lsize"]) / pan["lsize"].std(), np.abs(e["lprice"] - r["lprice"]) / pan["lprice"].std())
    return e.loc[dist.sort_values().index[:NEAR]]


def reading_2(panel: dict, th: np.ndarray, pan: pd.DataFrame) -> None:
    rows = []
    for i, r in pan.iterrows():
        e = near(pan, i)
        if r["sales_open"] < SIZED_FROM or not (r["signups"] >= 100) or not len(e):
            continue
        cps, lev = near(pan, i, "cost_per_signup")["cost_per_signup"].median(), near(pan, i, "level")["level"].median()
        by_budget = (r["spend_pre"] / cps) if cps and r["spend_pre"] > 0 else np.nan
        by_plan = (r["value"] * lev) if pd.notna(r["value"]) and pd.notna(lev) else np.nan
        rows.append({"signups": r["signups"], "paid": r["signups_paid"], "org": r["org"], "similar": e["signups"].median(), "paid_similar": e["signups_paid"].median(),
                     "paid_budget": by_budget, "org_similar": e["org"].median(), "org_plan": by_plan,
                     "budget": by_budget + e["org"].median(), "budget_plan": by_budget + by_plan})
    T = pd.DataFrame(rows)
    print(f"\n2. A launch's pre-window signups, told before it starts ({len(T)} launches opened since June 2024)")
    for col, act, label in (("similar", "signups", "all signups: the median of similar past launches"),
                            ("budget", "signups", "all signups: its paid budget at their cost a signup, plus their signups outside paid"),
                            ("budget_plan", "signups", "all signups: the budget, plus its plan's comms at their level"),
                            ("paid_similar", "paid", "paid signups: similar launches' median"), ("paid_budget", "paid", "paid signups: its budget at their cost a signup"),
                            ("org_similar", "org", "signups outside paid: similar launches' median"), ("org_plan", "org", "signups outside paid: its plan at their level")):
        m, n = miss(T[col], T[act])
        print(f"     {label:86s} typical miss {m:4.0%}  (n {n})")
    both = T[T["budget_plan"].notna()]
    print(f"   on the {len(both)} with a plan on file: similar {miss(both['similar'], both['signups'])[0]:.0%}, the budget {miss(both['budget'], both['signups'])[0]:.0%}, "
          f"the budget and the plan {miss(both['budget_plan'], both['signups'])[0]:.0%}")


def reading_3(panel: dict, d: dict) -> None:
    rows = {}
    for n, x in panel.items():
        sp = tl.code_spend(d["spend"], x["code"]) if x.get("code") else None
        if sp is None or not len(sp):
            continue
        days = pd.date_range(x["announce"] - pd.Timedelta(days=P.LEAD_DAYS), x["close"])
        e = sp.assign(day=pd.to_datetime(sp["spend_date"])).groupby("day")["spend"].sum().reindex(days).fillna(0.0).to_numpy(dtype=float)
        if e.sum() >= 200 and x["paid"].sum() >= 50:
            rows[n] = {"t": x["t"], "L": x["L"], "paid": x["paid"], "spend": e}
    names = sorted(rows)

    def curve(r):
        return np.interp(B.GRID, r["t"] / r["L"], np.cumsum(r["paid"]) / r["paid"].sum(), left=0.0, right=1.0)

    rec = []
    for n in names:
        r, others = rows[n], [rows[m] for m in names if m != n]
        usual = np.median(np.vstack([curve(o) for o in others]), axis=0)
        for frac in PARTWAY:
            tc = int(round(frac * r["L"]))
            seen, spent, left = float(r["paid"][r["t"] <= tc].sum()), float(r["spend"][r["t"] <= tc].sum()), float(r["spend"][r["t"] > tc].sum())
            if seen < 10 or spent <= 0:
                continue
            ups = []
            for o in others:
                oc = int(round(frac * o["L"]))
                s0, e0, s1, e1 = o["paid"][o["t"] <= oc].sum(), o["spend"][o["t"] <= oc].sum(), o["paid"][o["t"] > oc].sum(), o["spend"][o["t"] > oc].sum()
                if s0 >= 10 and s1 >= 10 and e0 > 0 and e1 > 0:
                    ups.append((e1 / s1) / (e0 / s0))
            up = float(np.median(ups)) if len(ups) >= 5 else 1.0
            rec.append({"cut": frac, "final": float(r["paid"].sum()), "seen": seen, "clock": seen / max(float(np.interp(frac, B.GRID, usual)), 1e-6),
                        "spend": seen + left / ((spent / seen) * up), "up": up})
    T = pd.DataFrame(rec)
    T["to_come"] = T["final"] - T["seen"]
    print(f"\n3. Paid signups at the open, forecast part way ({len(names)} launches with daily spend; spend before the open, median EUR "
          f"{np.median([r['spend'].sum() for r in rows.values()]):,.0f}; a paid signup, median EUR {np.median([r['spend'].sum() / r['paid'].sum() for r in rows.values()]):.2f})")
    for frac in PARTWAY:
        g = T[T["cut"] == frac]
        ok = g["to_come"] >= 5
        cells = [f"{miss(g[c], g['final'])[0]:4.0%} | {miss((g[c] - g['seen']).clip(lower=1)[ok], g['to_come'][ok])[0]:4.0%}" for c in ("clock", "spend")]
        print(f"     {int(frac * 100)}% through  n={len(g):2d}   clock {cells[0]}   the spend still to come {cells[1]}   (later signups cost x{g['up'].median():.2f} the earlier ones)")


def reading_4(pan: pd.DataFrame, d: dict) -> None:
    rows = []
    for i, r in pan.iterrows():
        e = near(pan, i)
        if r["sales_open"] < SIZED_FROM or not (r["units_window"] >= 20) or not (r["signups"] >= 100) or not len(e):
            continue
        opn, cls = r["sales_open"].normalize(), r["close"].normalize()
        _, sends, _, _ = feeds(r, opn, cls, d)
        rows.append({"units": r["units_window"], "su": r["units_su"], "nonsu": r["units_nonsu"], "signups": r["signups"],
                     "su_pred": r["signups"] * e["signup_order_rate"].median() * e["purchases_per_order"].median(), "nonsu_similar": e["units_nonsu"].median(),
                     "reach": float(sends["delivered"].sum()) if len(sends) else 0.0, "spend": float(r["spend_window"]) if pd.notna(r["spend_window"]) else 0.0})
    W = pd.DataFrame(rows)
    ok = (W["nonsu"] > 0) & (W["nonsu_similar"] > 0)
    y = np.log(W.loc[ok, "nonsu"]).to_numpy()

    def left_out(X):
        pred = np.zeros(len(y))
        for j in range(len(y)):
            k = np.arange(len(y)) != j
            b, *_ = np.linalg.lstsq(X[k], y[k], rcond=None)
            pred[j] = X[j] @ b
        return float(np.expm1(np.median(np.abs(pred - y))))

    base = np.column_stack([np.ones(int(ok.sum())), np.log(W.loc[ok, "nonsu_similar"])])
    print(f"\n4. The window's units, told at the open ({len(W)} launches); {(W['nonsu'] / W['units']).median():.0%} of a window's units go to people who never signed up")
    print(f"   signups at similar launches' rates plus their non-signup units: typical miss {miss(W['su_pred'] + W['nonsu_similar'], W['units'])[0]:.0%} "
          "(the page's own forecast, by channel and kind, reads 41%: etl/analysis/tl_forecast_backtest.py)")
    print(f"   units to people who never signed up, each launch left out of the fit: similar launches alone {left_out(base):.0%}; "
          f"with the window's email reach {left_out(np.column_stack([base, np.log1p(W.loc[ok, 'reach'])])):.0%}; "
          f"with the window's paid spend {left_out(np.column_stack([base, np.log1p(W.loc[ok, 'spend'])])):.0%}; "
          f"with the launch's signups {left_out(np.column_stack([base, np.log(W.loc[ok, 'signups'])])):.0%}")
    print(f"   {int((W['reach'] >= 50000).sum())} of the {len(W)} emailed 50,000 people or more in the window, so the email tells launches apart no further")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--comms")
    ap.add_argument("--campaigns")
    a = ap.parse_args()
    d = load(a.comms, a.campaigns)
    if d["aud"].empty or d["comms"].empty:
        raise SystemExit("the feeds are missing: run node server/emailAudiences.js --write and node server/commsPlan.js --write first")
    panel, skipped = signup_panel(d)
    why = pd.Series(skipped).value_counts()
    paid_share = np.median([x["paid"].sum() / (x["paid"].sum() + x["y"].sum()) for x in panel.values()])
    print(f"timed launches on the panel: {len(d['panel'])}; read here: {len(panel)}; left out: " + "; ".join(f"{k} {v}" for k, v in why.items()))
    print(f"a launch's signups before its open: {np.median([x['y'].sum() for x in panel.values()]):.0f} outside paid and {np.median([x['paid'].sum() for x in panel.values()]):.0f} "
          f"paid at the median; paid's share of the tracked signups {paid_share:.0%}; {np.median([len(x['sends']) for x in panel.values()]):.0f} marketing emails a launch")
    th = reading_1(panel, d)
    pan = d["panel"].copy()
    pan["org"] = pan["signups"] - pan["signups_paid"].fillna(0)
    pan["lsize"] = np.log(pan["units_target"].fillna(pan["units_window"]).clip(lower=20))
    pan["lprice"] = np.log(pan["unit_price_eur"].clip(lower=50).fillna(pan["unit_price_eur"].median()))
    pan["value"] = [float(B.mu(panel[n], th).sum()) if n in panel else np.nan for n in pan["release_name"]]
    pan["level"] = pan["org"] / pan["value"]
    reading_2(panel, th, pan)
    reading_3(panel, d)
    reading_4(pan, d)


if __name__ == "__main__":
    main()
