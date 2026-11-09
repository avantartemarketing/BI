"""Prototype: the Spend levels curve with its uncertainty, on the real cost
path (etl/build.py CostPath). A synthetic release shaped like the one in the
owner's screenshot (today EUR 363 a day, the point-estimate peak near EUR 5,340,
a few days left). Writes a JSON block the mock card renders.

Uncertainty sampled (N draws):
  eps   ~ N(0.30, 0.10)           the day's-budget elasticity prior
  wear  ~ N(0.20, 0.13)           the wear-out prior
  anchor: the window's price is spend / entries over a handful of entries, so
          the true rate is Gamma(entries + 1/2) around what was seen
  lift  : the close's lift, log-normal around x1.53 / x1.40 (95% ranges on
          file), shrinking 6% +/- 6% per doubling of the day's spend over the
          campaign's usual day
"""
import json
import math
import sys
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

CostPath = build.CostPath
rng = np.random.default_rng(7)

# ---- the synthetic release
S0 = 363.0            # today's daily spend (the last full day)
N_DAYS = 4            # full days left, the last the close
CPE_NOW = 390.0       # the window's price per converting unit
ENTRIES3 = 3.5        # entries the three-day window bought (what the price rests on)
SPEND_REF = 363.0
CLOCK_REF = 6000.0
SPENT = 6500.0
EPS, WEAR, K = 0.30, 0.20, 100.0
LIFT = [1.53, 1.40]
GAIN = 1250.0         # AA profit on a paid unit net of cannibalisation
SHARE = 1.0           # AA carries the spend on this deal
EDITION = 120.0
BASE_UNITS = 84.0     # at close without paid
ROOM = EDITION - BASE_UNITS
BIGGEST_DAY = 520.0   # the campaign's biggest day so far
PANEL_P95 = 3888.0    # 95th percentile of the panel's campaign-days (data/spend_daily.csv)
N = 6000


def path(eps, wear, cpe, lift):
    return CostPath(cpe, SPEND_REF, CLOCK_REF, SPENT, N_DAYS, eps, wear, K, lift=lift, anchor_lift=1.0)


point = path(EPS, WEAR, CPE_NOW, LIFT)
level_point = point.spend_for_profit(GAIN, SHARE, cap=math.inf, room=ROOM)
sellout = point.spend_for_units(ROOM)
print(f"point peak {level_point:,.0f} a day; sells out at {sellout:,.0f}; profit there {point.profit(level_point, GAIN, SHARE, ROOM):,.0f}")

# ---- the draws
eps_s = np.clip(rng.normal(EPS, 0.10, N), 0.0, 0.9)
wear_s = np.clip(rng.normal(WEAR, 0.13, N), 0.0, 0.8)
rate_s = rng.gamma(ENTRIES3 + 0.5, 1.0, N)              # the true entry rate behind the window's count
cpe_s = CPE_NOW * ENTRIES3 / rate_s
l0 = np.exp(rng.normal(math.log(1.53), 0.10, N))
l1 = np.exp(rng.normal(math.log(1.40), 0.135, N))
shrink_s = rng.normal(-0.089, 0.089, N)                   # the lift's exponent on the day's spend over the usual

def profit_draws(s):
    out = np.empty(N)
    for j in range(N):
        if s <= 0:
            out[j] = 0.0
            continue
        sh = (s / SPEND_REF) ** shrink_s[j] if s > SPEND_REF else 1.0
        lift = [max(1.0, l0[j] * sh), max(1.0, l1[j] * sh)]
        out[j] = path(eps_s[j], wear_s[j], cpe_s[j], lift).profit(s, GAIN, SHARE, ROOM)
    return out


def curve_on(grid):
    rows, P = [], np.empty((len(grid), N))
    for i, s in enumerate(grid):
        d = profit_draws(float(s))
        P[i] = d
        rows.append({"daily": round(float(s), 2), "point": round(point.profit(float(s), GAIN, SHARE, ROOM), 2),
                     "mean": round(float(d.mean()), 2), "median": round(float(np.median(d)), 2),
                     "p10": round(float(np.percentile(d, 10)), 2), "p25": round(float(np.percentile(d, 25)), 2),
                     "p75": round(float(np.percentile(d, 75)), 2), "p90": round(float(np.percentile(d, 90)), 2),
                     "lossP": round(float((d < 0).mean()), 3) if s > 0 else 0.0})
    return rows, P


# pass 1: a wide grid, to find the peaks
top = max(level_point * 2.5, S0 * 1.2, 1.0)
grid = np.array([top * i / 40 for i in range(41)])
rows, P = curve_on(grid)

means = np.array([r["mean"] for r in rows]); meds = np.array([r["median"] for r in rows])
p25 = np.array([r["p25"] for r in rows]); lossp = np.array([r["lossP"] for r in rows])
i_mean = int(means.argmax()); i_med = int(meds.argmax()); i_p25 = int(p25.argmax())
cap = 0.20
ok = [i for i in range(len(grid)) if lossp[i] <= cap and grid[i] > 0]
i_cap = max(ok) if ok else 0
i_rec = min(i_med, i_cap)
print(f"expected-profit peak {grid[i_mean]:,.0f}  median peak {grid[i_med]:,.0f}  cautious (p25) peak {grid[i_p25]:,.0f}  loss<=20% up to {grid[i_cap]:,.0f}")
for i in (0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40):
    r = rows[i]
    print(f"  s {r['daily']:>8,.0f}  point {r['point']:>8,.0f}  mean {r['mean']:>8,.0f}  med {r['median']:>8,.0f}  p10 {r['p10']:>8,.0f}  p90 {r['p90']:>8,.0f}  P(loss) {r['lossP']:.2f}")

# where the peak sits across draws: the per-draw argmax over the grid
peaks = grid[P.argmax(axis=0)]
print(f"peak across draws: p10 {np.percentile(peaks,10):,.0f}  p25 {np.percentile(peaks,25):,.0f}  median {np.median(peaks):,.0f}  p75 {np.percentile(peaks,75):,.0f}  p90 {np.percentile(peaks,90):,.0f}")
print(f"share of draws in which paid at {grid[i_rec]:,.0f} loses money: {lossp[i_rec]:.2f}; at the point peak {grid[int(np.abs(grid-level_point).argmin())]:,.0f}: {lossp[int(np.abs(grid-level_point).argmin())]:.2f}")

def paced(level):
    """the schedule from today's spend to a level, at most 30% a day"""
    out, prev = [], S0
    for _ in range(N_DAYS):
        step = min(max(level, prev * 0.7), prev * 1.3)
        if abs(step - level) < 0.1 * max(level, 1e-9):
            step = level
        out.append(step); prev = step
    return out


# ---- the recommendation: the cautious peak, where the profit at the 25th
# percentile (the campaign turning out dear) is highest; tomorrow's step the
# pacing rule's 30%. The fine answer on a finer grid around the grid's peak.
fine = np.linspace(max(grid[i_p25] - top / 40, 1), grid[i_p25] + top / 40, 21)
fp = [np.percentile(profit_draws(float(s)), 25) for s in fine]
rec = float(fine[int(np.argmax(fp))])
d_rec = profit_draws(rec)
sched = paced(rec); tomorrow = sched[0]
units_rec = point.units(rec)
loss_rec = float((d_rec < 0).mean())
print("schedule", [round(x) for x in sched])
print(f"aim {rec:,.0f} a day, P(loss) {loss_rec:.3f}, profit median {np.median(d_rec):,.0f} ({np.percentile(d_rec,10):,.0f} to {np.percentile(d_rec,90):,.0f}), units at close {BASE_UNITS + units_rec:.1f}")

# pass 2: the card's curve, to two and a half times the aim or a little past
# the point estimate's peak, whichever is further, so the reader sees where
# the band goes under zero
top2 = max(rec * 2.5, level_point * 1.2, S0 * 1.2, 1.0)
grid2 = np.array([top2 * i / 40 for i in range(41)])
rows, P2 = curve_on(grid2)

nxt = {
    "today": S0, "daysLeft": N_DAYS, "edition": EDITION, "baseUnits": BASE_UNITS,
    "pointLevel": round(level_point, 2), "sellout": round(sellout, 2),
    "recommended": round(rec, 2), "tomorrow": round(tomorrow, 2), "schedule": [round(x, 2) for x in sched],
    "lossAtRecommended": round(loss_rec, 3),
    "lossAtPoint": round(float(lossp[int(np.abs(grid - level_point).argmin())]), 3),
    "profitAtRecommended": {"median": round(float(np.median(d_rec)), 2), "p10": round(float(np.percentile(d_rec, 10)), 2), "p90": round(float(np.percentile(d_rec, 90)), 2)},
    "unitsAtRecommended": round(BASE_UNITS + units_rec, 1),
    "spendToCome": round(rec * N_DAYS, 2), "spendPaced": round(sum(sched), 2),
    "peakRange": [round(float(np.percentile(peaks, 25)), 2), round(float(np.percentile(peaks, 75)), 2)],
    "biggestDay": BIGGEST_DAY, "panelP95": PANEL_P95,
    "entriesWindow": ENTRIES3, "cpeNow": CPE_NOW, "gain": GAIN, "share": SHARE,
    "elasticity": EPS, "wearout": WEAR,
    "marginalToday": round(point.marginal_roi(S0, GAIN, SHARE, ROOM), 2),
    "curve": rows,
}

# ---- the block the live card reads today (paid.levels as etl/build.py writes it), for the "before"
sd = 0.10
alts = [path(max(EPS - sd, 0.0), WEAR, CPE_NOW, LIFT), path(min(EPS + sd, 0.9), WEAR, CPE_NOW, LIFT)]
old_top = max(level_point * 2.5, S0 * 1.2, 1.0)
old_curve = []
for i in range(41):
    s_pt = old_top * i / 40
    p_pt = point.profit(s_pt, GAIN, SHARE, ROOM)
    p_alt = [c_.profit(s_pt, GAIN, SHARE, ROOM) for c_ in alts]
    old_curve.append({"daily": round(s_pt, 2), "profit": round(p_pt, 2), "lo": round(min(p_pt, *p_alt), 2), "hi": round(max(p_pt, *p_alt), 2)})
old_sched = paced(level_point)


def level_row(key, lvl, mult):
    sch = [s * mult for s in old_sched]
    spend_k = sum(sch)
    bought = point.units_sched(sch) if spend_k > 0 else 0.0
    units_k = min(BASE_UNITS + bought, EDITION)
    return {"key": key, "daily": round(lvl, 2), "unitsAtClose": round(units_k, 1), "pct": round(units_k / EDITION, 4),
            "spendToCome": round(spend_k, 2), "roi": round(GAIN * bought / (SHARE * spend_k), 2) if spend_k > 0 else None,
            "marginal": round(point.marginal_roi(lvl, GAIN, SHARE, ROOM), 2) if lvl > 0 else None}


old = {"today": S0, "recommended": round(level_point, 2), "stop": None,
       "marginalToday": round(point.marginal_roi(S0, GAIN, SHARE, ROOM), 2), "sellout": round(sellout, 2),
       "daysLeft": N_DAYS, "ppu": GAIN, "cannibalisation": 0.2, "elasticity": EPS, "elasticityBand": [EPS - sd, EPS + sd],
       "rows": [level_row("none", 0.0, 0.0), level_row("half", level_point / 2, 0.5), level_row("recommended", level_point, 1.0), level_row("double", level_point * 2, 2.0)],
       "curve": old_curve}
print("old rows", [(r["key"], r["daily"], r["unitsAtClose"], r["spendToCome"], r["roi"]) for r in old["rows"]])

dest = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).with_name("levels_mc.json")
dest.write_text(json.dumps({"old": old, "next": nxt}))
print("wrote", dest)
