"""Does a bigger day really cost only 6% more an entry? The 0.08 elasticity in
etl/benchmarks.json (cpe_spend_elasticity, from cpe_elasticity.py) is put
under pressure from several directions, on the same panel that script
builds: every Meta draw campaign tied to a release, day by day, with the
campaign's spend so far (the wear-out clock) and the close's lift held as
the model holds them.

The worry (27 October 2026): the budget is set by people watching the price.
A day's spend is raised when entries are cheap and cut when they are dear,
so a fit on what happened sees big days that were cheap because they were
made big on cheap days, and reads the penalty for a bigger day too low.

The tests, each printed with what it says about the 0.08:

  1. Profile: the fit's deviance with the elasticity held at each of a grid
     of values, the wear-out, the lift and the levels refitted. How much
     worse is 0.3 than 0.08, in the data's own terms?
  2. The reaction: does a day's budget change follow the previous day's
     price? And does a cheap day stay cheap (the residuals' autocorrelation)?
     Together they say which way the fit is biased.
  3. Consecutive days: the elasticity from pairs of adjacent days alone
     (conditional on the pair's entries), which drops everything that moves
     slowly within a campaign.
  4. Budget steps: the days the budget jumped or was cut by 30% or more
     against the day before, read as an event: entries a euro on the step
     day against the day before, rises and cuts apart.
  5. The lag as an instrument: a control-function fit, today's budget
     explained by yesterday's, the part it does not explain carried into the
     Poisson as a control for the reaction.
  6. Impressions: the spend feed carries impressions, so the day's-budget
     effect splits into what a euro buys in the auction (impressions a euro)
     and what an impression is worth (entries an impression). The auction
     part is Meta's price and cannot be a reaction to our entries.
  7. Shape: is the penalty the same for a day at twice the campaign's usual
     as for a day at half? A kink at the campaign's median.
  8. Backtest: cut each campaign at 40, 60 and 80% of its run, anchor on the
     trailing three days as the dashboard does, and predict the rest of its
     entries from the spend it actually had, at each elasticity on the grid.
     Which elasticity predicts best?

Run from the repo root after the funnel export is in place:
    python3 etl/analysis/cpe_elasticity_challenge.py
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

MIN_DAYS = 6
CLOSE_DAYS = 2
EPS_GRID = (0.0, 0.08, 0.15, 0.25, 0.35, 0.5)
STEP = np.log(1.3)          # a budget step: 30% or more against the day before

# ---------------------------------------------------------------- the panel
# (as cpe_elasticity.py builds it, with impressions and reach carried along)
sp = build.load_spend()
raw = pd.read_csv(ROOT / "data/spend_daily.csv")
raw["spend_date"] = pd.to_datetime(raw["spend_date"]).dt.date
at = pd.read_csv(ROOT / "sources/across_time.csv",
                 usecols=["AA_session_custom_channel_group_split_touch", "event_date", "simple_release_name",
                          "Draw_Entries_Eligible_Units", "days_until_launch"])
at["event_date"] = pd.to_datetime(at["event_date"], format="%d/%m/%Y").dt.date
to_close = (at.dropna(subset=["days_until_launch"]).groupby(["simple_release_name", "event_date"])["days_until_launch"]
            .agg(lambda v: v.mode().iat[0]))
at = at[at["AA_session_custom_channel_group_split_touch"] == "Paid Social"]
entries = at.groupby(["simple_release_name", "event_date"])["Draw_Entries_Eligible_Units"].sum()

doc = json.load(open(ROOT / "data/app/inputs.json"))
camps: dict[str, list[str]] = {}
for r in doc["releases"].values():
    names = r.get("campaign_names") or ([r["campaign_name"]] if r.get("campaign_name") else [])
    if names:
        camps[r["release_name"]] = list(names)
for r in (doc.get("discovered") or {}).values():
    if r.get("campaign_name"):
        camps.setdefault(r["release_name"], [r["campaign_name"]])
orders = pd.read_csv(ROOT / "data/orders_by_product.csv", usecols=["release", "campaign_code"]).dropna().drop_duplicates()
for rel, code in zip(orders.release, orders.campaign_code):
    first = build.match_campaign(str(code).strip(), sp)
    if first:
        camps.setdefault(rel, [first])
camps = {rel: [n for n in ns if "draw" in n.lower()] for rel, ns in camps.items()}
camps = {rel: ns for rel, ns in camps.items() if ns}

parent: dict[str, str] = {}


def find(x: str) -> str:
    parent.setdefault(x, x)
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


for rel, names in camps.items():
    for n in names:
        parent[find("r:" + rel)] = find("c:" + n)
units: dict[str, dict] = {}
for rel, names in camps.items():
    u = units.setdefault(find("r:" + rel), {"releases": set(), "campaigns": set()})
    u["releases"].add(rel)
    u["campaigns"].update(names)

in_funnel = set(entries.index.get_level_values(0))
rows = []
for u in units.values():
    rels_u = sorted(r for r in u["releases"] if r in in_funnel)
    s = sp[sp["campaign_name"].isin(u["campaigns"])].groupby("spend_date")["spend"].sum().sort_index()
    if s.empty or not rels_u:
        continue
    df = s.rename("spend").to_frame()
    imp = raw[raw["campaign_name"].isin(u["campaigns"])].groupby("spend_date")[["impressions", "reach"]].sum()
    df["impressions"] = imp["impressions"].reindex(df.index).fillna(0.0)
    df["reach"] = imp["reach"].reindex(df.index).fillna(0.0)
    df["spent_before"] = df["spend"].cumsum() - df["spend"]
    df["entries"] = sum(entries.loc[r].reindex(df.index).fillna(0.0) for r in rels_u)
    df["to_close"] = [to_close.get((rels_u[0], day), np.nan) for day in df.index]
    df = df[(df.spend > 20) & (df.to_close >= 0)]
    if len(df) < MIN_DAYS or df.entries.sum() <= 0:
        continue
    df["day"] = [(d - df.index.min()).days for d in df.index]
    df["gap"] = [np.nan] + [(b - a).days for a, b in zip(df.index[:-1], df.index[1:])]
    df["rel"] = rels_u[0] if len(rels_u) == 1 else f"{len(rels_u)} releases on {sorted(u['campaigns'])[0]}"
    rows.append(df)
d = pd.concat(rows).reset_index().rename(columns={"index": "date", "spend_date": "date"})
rels = sorted(d.rel.unique())
K = float(build.BENCH.get("cpe_wearout_k", 100) or 100)
print(f"{len(rels)} campaigns, {len(d)} campaign-days with spend over 20 up to the close, "
      f"{d.entries.sum():,.0f} paid entries, spend {d.spend.sum():,.0f}; "
      f"{int((d.impressions > 0).sum())} days carry impressions")

G = np.zeros((len(d), len(rels)))
for i, r in enumerate(rels):
    G[(d.rel == r).values, i] = 1
y = d.entries.values.astype(float)
ls = np.log(d.spend.values)
clock = np.log1p(d.spent_before.values / K)
close_cols = [(d.to_close.values == k).astype(float) for k in range(CLOSE_DAYS)]


def deviance(y, mu):
    return 2 * float(np.sum(np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0) - (y - mu)))


def fit(cols, offset=None, fe=G):
    X = np.column_stack([fe] + list(cols)) if cols else fe
    res = build.poisson_fit(y, X, offset=offset)
    if res is None:
        raise SystemExit("panel fit failed")
    beta, cov = res
    k = fe.shape[1]
    mu = np.exp(X @ beta + (0 if offset is None else offset))
    phi = max(float(np.sum((y - mu) ** 2 / mu)) / max(len(y) - X.shape[1], 1), 1.0)
    return beta[k:], np.sqrt(np.diag(cov)[k:]), deviance(y, mu), mu, phi


# ---------------------------------------------------------------- 0. baseline
coef, se, dev0, mu0, phi = fit([ls, clock] + close_cols)
eps0, w0 = 1 - coef[0], -coef[1]
lift = [float(np.exp(c)) for c in coef[2:]]
lift_off = sum(np.log(lift[k]) * close_cols[k] for k in range(CLOSE_DAYS))
print(f"\n0. Baseline (as on file): elasticity {eps0:.3f} +/- {se[0]:.3f}, wear-out {w0:.3f} +/- {se[1]:.3f}, "
      f"close lift x{lift[0]:.2f}, x{lift[1]:.2f}; deviance {dev0:.0f}, dispersion {phi:.2f}")
print("   A doubled day costs " + f"{(2 ** eps0 - 1) * 100:.0f}% more an entry on this reading.")

# ---------------------------------------------------------------- 1. profile
print("\n1. Profile: the elasticity held at each value, everything else refitted")
print("   eps   deviance   worse by   (worse by / dispersion; 3.8 is the 95% line)   wear-out refitted")
prof = {}
for e in EPS_GRID:
    c, s_, dv, _, _ = fit([clock] + close_cols, offset=(1 - e) * ls)
    prof[e] = dv
    print(f"   {e:.2f}  {dv:8.0f}   {dv - dev0:8.1f}   {(dv - dev0) / phi:8.1f}{'':34s}{-c[0]:.3f}")

# ---------------------------------------------------------------- 2. reaction
# the price residual: entries a euro against what the baseline expects
resid = np.log((y + 0.5) / (mu0 + 0.5))        # + = cheaper than expected
d["resid"] = resid
d["dls"] = d.groupby("rel")["spend"].transform(lambda s: np.log(s).diff())
d["resid_lag"] = d.groupby("rel")["resid"].shift(1)
d["gap1"] = d["gap"] == 1
pairs = d[d.gap1 & d.dls.notna() & d.resid_lag.notna()]
X = np.column_stack([np.ones(len(pairs)), pairs.resid_lag.values])
b_react = np.linalg.lstsq(X, pairs.dls.values, rcond=None)[0]
r_react = np.corrcoef(pairs.resid_lag.values, pairs.dls.values)[0, 1]
ac = np.corrcoef(pairs.resid.values, pairs.resid_lag.values)[0, 1]
print(f"\n2. The reaction, on {len(pairs)} consecutive-day pairs")
print(f"   today's budget change on yesterday's price residual: slope {b_react[1]:+.3f} (r {r_react:+.2f})")
print(f"     (a cheaper-than-expected day is followed by a {'bigger' if b_react[1] > 0 else 'smaller'} budget)")
print(f"   the residual's day-to-day autocorrelation: {ac:+.2f}")
print(f"     (a cheap day {'tends to stay cheap' if ac > 0.1 else 'does not persist' if ac > -0.1 else 'tends to reverse'})")
bias = "low" if (b_react[1] > 0 and ac > 0) or (b_react[1] < 0 and ac < 0) else "high"
print(f"   together: the plain fit reads the elasticity too {bias}")

# ---------------------------------------------------------------- 3. consecutive days
# conditional on the pair's total, the share landing on the later day is
# binomial with logit = (1 - eps) dls + w dclock + dlift: slow-moving things cancel
d["dclock"] = d.groupby("rel")["spent_before"].transform(lambda s: np.log1p(s / K).diff())
d["dlift"] = pd.Series(lift_off).groupby(d["rel"]).diff().values
d["e_lag"] = d.groupby("rel")["entries"].shift(1)
pp = d[d.gap1 & d.dls.notna() & ((d.entries + d.e_lag) > 0)].copy()


def binom_fit(n, k, X, iters=100):
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ b)))
        W = n * p * (1 - p)
        g = X.T @ (k - n * p)
        H = (X.T * W) @ X
        try:
            step = np.linalg.solve(H, g)
        except np.linalg.LinAlgError:
            return None
        b = b + step
        if np.max(np.abs(step)) < 1e-10:
            break
    p = 1 / (1 + np.exp(-(X @ b)))
    W = n * p * (1 - p)
    cov = np.linalg.inv((X.T * W) @ X)
    pear = float(np.sum((k - n * p) ** 2 / np.maximum(n * p * (1 - p), 1e-9))) / max(len(k) - X.shape[1], 1)
    return b, np.sqrt(np.diag(cov) * max(pear, 1.0))


n_pair = (pp.entries + pp.e_lag).values
Xp = np.column_stack([pp.dls.values, pp.dclock.values, pp.dlift.values])
bp, sp_ = binom_fit(n_pair, pp.entries.values, Xp)
print(f"\n3. Consecutive days only ({len(pp)} pairs): elasticity {1 - bp[0]:.3f} +/- {sp_[0]:.3f}, "
      f"wear-out {-bp[1]:.3f} +/- {sp_[1]:.3f}")
print(f"   a doubled day costs {(2 ** (1 - bp[0]) - 1) * 100:.0f}% more an entry on this reading")

# ---------------------------------------------------------------- 4. budget steps
print("\n4. Budget steps against the day before (entries a euro on the step day over the day before,")
print("   the wear-out and the close's lift taken out at the baseline's values)")
pp["adj"] = pp.resid.values - 0  # placeholder, computed below
# entries a euro on each day, net of the clock and lift at baseline values
eff = np.log((d.entries.values + 0.5) / d.spend.values) + w0 * clock - lift_off
d["eff"] = eff
d["eff_lag"] = d.groupby("rel")["eff"].shift(1)
st = d[d.gap1 & d.dls.notna() & d.eff_lag.notna()].copy()
st["deff"] = st.eff - st.eff_lag
for name, m in [("rises of 30%+", st.dls >= STEP), ("cuts of 30%+", st.dls <= -STEP), ("steady (within 10%)", st.dls.abs() < np.log(1.1))]:
    g = st[m]
    if len(g) < 5:
        print(f"   {name}: {len(g)} days, too few")
        continue
    # implied elasticity: d log(entries/spend) = -eps d log(spend)
    e_imp = -np.sum(g.deff * g.dls) / np.sum(g.dls ** 2) if np.sum(g.dls ** 2) > 0 else np.nan
    print(f"   {name}: {len(g)} days, budget x{np.exp(g.dls.mean()):.2f} on average, entries a euro x{np.exp(g.deff.mean()):.2f} "
          f"(median x{np.exp(g.deff.median()):.2f}); implied elasticity {e_imp:.3f}" if np.isfinite(e_imp) else
          f"   {name}: {len(g)} days, entries a euro x{np.exp(g.deff.mean()):.2f}")

# ---------------------------------------------------------------- 5. lag as instrument
# first stage: today's log spend on yesterday's, the clock, the lift and the campaign
d["ls"] = ls
d["ls_lag"] = d.groupby("rel")["ls"].shift(1)
m5 = (d.gap1 & d.ls_lag.notna()).values
G5 = G[m5][:, G[m5].sum(0) > 0]
X1 = np.column_stack([G5, d.ls_lag.values[m5], clock[m5]] + [c[m5] for c in close_cols])
b1 = np.linalg.lstsq(X1, ls[m5], rcond=None)[0]
v = ls[m5] - X1 @ b1                          # the part of today's budget yesterday's does not explain
y_s, G_s = y[m5], G5
res5 = build.poisson_fit(y_s, np.column_stack([G5, ls[m5], clock[m5]] + [c[m5] for c in close_cols] + [v]))
if res5 is not None:
    b5, c5 = res5
    k5 = G5.shape[1]
    s5 = np.sqrt(np.diag(c5))
    print(f"\n5. Control function ({int(m5.sum())} days with a previous day): elasticity {1 - b5[k5]:.3f} +/- {s5[k5]:.3f}, "
          f"wear-out {-b5[k5 + 1]:.3f}; the reaction term {b5[-1]:+.3f} +/- {s5[-1]:.3f}")
    print("   (the reaction term is how the unexpected part of today's budget relates to entries; "
          "a positive one means the budget was raised on days that turned out cheap)")
    print(f"   first stage: today's budget follows yesterday's with slope {b1[k5]:.2f}")

# ---------------------------------------------------------------- 6. impressions
mi = (d.impressions > 0).values
if mi.sum() > 50:
    Gi = G[mi][:, G[mi].sum(0) > 0]
    li = np.log(d.impressions.values[mi])
    Xa = np.column_stack([Gi, ls[mi], clock[mi]] + [c[mi] for c in close_cols])
    ba = np.linalg.lstsq(Xa, li, rcond=None)[0]
    ra = li - Xa @ ba
    sa = np.sqrt(np.sum(ra ** 2) / (len(li) - Xa.shape[1]) * np.linalg.inv(Xa.T @ Xa)[Gi.shape[1], Gi.shape[1]])
    ki = Gi.shape[1]
    print(f"\n6. Impressions, on the {int(mi.sum())} days that carry them")
    print(f"   impressions on the day's budget: slope {ba[ki]:.3f} +/- {sa:.3f} -> a doubled day buys {(2 ** ba[ki] - 1) * 100:+.0f}% impressions, "
          f"so the auction price (CPM) rises {(2 ** (1 - ba[ki]) - 1) * 100:.0f}% per doubling (elasticity {1 - ba[ki]:.3f})")
    print(f"   impressions on spend so far: {ba[ki + 1]:+.3f} (CPM wear-out {-ba[ki + 1]:.3f})")
    resi = build.poisson_fit(y[mi], np.column_stack([Gi, li, clock[mi]] + [c[mi] for c in close_cols]))
    if resi is not None:
        bi, ci = resi
        si = np.sqrt(np.diag(ci))
        print(f"   entries on impressions: slope {bi[ki]:.3f} +/- {si[ki]:.3f} -> an impression on a doubled day is worth "
              f"{(2 ** (bi[ki] - 1) - 1) * 100:+.0f}% (conversion elasticity {1 - bi[ki]:.3f}); wear-out on impressions {-bi[ki + 1]:.3f}")
        tot = 1 - ba[ki] * bi[ki]
        print(f"   combined: a doubled day's entries scale by 2^{ba[ki] * bi[ki]:.3f}, an elasticity of {tot:.3f} "
              f"({(2 ** tot - 1) * 100:.0f}% dearer an entry per doubling)")
    # the plain elasticity on these same days, for a like-for-like reading
    ce, se_, _, _, _ = fit([ls[mi], clock[mi]] + [c[mi] for c in close_cols], fe=Gi) if False else (None,) * 5
    res_same = build.poisson_fit(y[mi], np.column_stack([Gi, ls[mi], clock[mi]] + [c[mi] for c in close_cols]))
    if res_same is not None:
        print(f"   the plain fit on these same days: elasticity {1 - res_same[0][ki]:.3f}")
else:
    print("\n6. Impressions: too few days carry them")

# ---------------------------------------------------------------- 7. shape
med = d.groupby("rel")["spend"].transform("median").values
dev_med = ls - np.log(med)
up, dn = np.maximum(dev_med, 0), np.minimum(dev_med, 0)
c7, s7, dv7, _, _ = fit([up, dn, clock] + close_cols)
print(f"\n7. Shape: above the campaign's usual day the elasticity reads {1 - c7[0]:.3f} +/- {s7[0]:.3f}; "
      f"below it {1 - c7[1]:.3f} +/- {s7[1]:.3f} (deviance {dv7:.0f} against {dev0:.0f})")
big = dev_med > np.log(2)
print(f"   {int(big.sum())} days ran at over twice the campaign's usual")

# ---------------------------------------------------------------- 8. backtest
print("\n8. Backtest: anchor on the trailing three days, predict the rest from the spend it had")
print("   (median |log(predicted / actual)| over the remaining entries; campaigns with 14+ days; wear-out held at the baseline)")
cuts = (0.4, 0.6, 0.8)
scores = {e: [] for e in EPS_GRID}
n_used = 0
for rel, g in d.groupby("rel"):
    g = g.sort_values("date")
    if len(g) < 14:
        continue
    n_used += 1
    for cut in cuts:
        i = int(round(len(g) * cut))
        if i < 3 or i >= len(g) - 1:
            continue
        win, rest = g.iloc[i - 3:i], g.iloc[i:]
        if win.entries.sum() <= 0 or rest.entries.sum() <= 0:
            continue
        cpe_win = win.spend.sum() / win.entries.sum()
        s_ref = win.spend.mean()
        clock_ref = np.sum(np.log1p(win.spent_before / K) * win.spend) / win.spend.sum()
        lift_win = np.exp(np.sum(np.array([np.log(lift[int(k)]) if k < CLOSE_DAYS else 0.0 for k in win.to_close]) * win.spend) / win.spend.sum())
        for e in EPS_GRID:
            m = ((rest.spend / s_ref) ** e) * np.exp(w0 * (np.log1p(rest.spent_before / K) - clock_ref)) * lift_win
            m = m / np.array([lift[int(k)] if k < CLOSE_DAYS else 1.0 for k in rest.to_close])
            pred = float(np.sum(rest.spend / (cpe_win * m)))
            scores[e].append(np.log(pred / rest.entries.sum()))
print(f"   {n_used} campaigns, {len(scores[EPS_GRID[0]])} cuts")
print("   eps   median miss   bias (median log ratio)")
for e in EPS_GRID:
    a = np.array(scores[e])
    print(f"   {e:.2f}   {np.median(np.abs(a)) * 100:6.0f}%        {np.median(a):+.2f}")

# ---------------------------------------------------------------- 8b. backtest, the pair free
print("\n8b. The same backtest with the wear-out on a grid too (median miss %, the bias in brackets)")
W_GRID = (0.10, 0.15, 0.20, 0.25, 0.30)
tab = {}
for rel, g in d.groupby("rel"):
    g = g.sort_values("date")
    if len(g) < 14:
        continue
    for cut in cuts:
        i = int(round(len(g) * cut))
        if i < 3 or i >= len(g) - 1:
            continue
        win, rest = g.iloc[i - 3:i], g.iloc[i:]
        if win.entries.sum() <= 0 or rest.entries.sum() <= 0:
            continue
        cpe_win = win.spend.sum() / win.entries.sum()
        s_ref = win.spend.mean()
        clock_ref = np.sum(np.log1p(win.spent_before / K) * win.spend) / win.spend.sum()
        lift_win = np.exp(np.sum(np.array([np.log(lift[int(k)]) if k < CLOSE_DAYS else 0.0 for k in win.to_close]) * win.spend) / win.spend.sum())
        lift_rest = np.array([lift[int(k)] if k < CLOSE_DAYS else 1.0 for k in rest.to_close])
        for e in EPS_GRID:
            for w in W_GRID:
                m = ((rest.spend / s_ref) ** e) * np.exp(w * (np.log1p(rest.spent_before / K) - clock_ref)) * lift_win / lift_rest
                tab.setdefault((e, w), []).append(np.log(float(np.sum(rest.spend / (cpe_win * m))) / rest.entries.sum()))
print("   eps \\ wear " + "".join(f"{w:>14.2f}" for w in W_GRID))
for e in EPS_GRID:
    print(f"   {e:.2f}       " + "".join(f"{np.median(np.abs(tab[(e, w)])) * 100:5.0f}% ({np.median(tab[(e, w)]):+.2f})" for w in W_GRID))

# ---------------------------------------------------------------- 9. the lag
# entries attributed to a day may have been bought by the day before's spend:
# the baseline with yesterday's log spend alongside today's
m9 = (d.gap1 & d.ls_lag.notna()).values
G9 = G[m9][:, G[m9].sum(0) > 0]
res9 = build.poisson_fit(y[m9], np.column_stack([G9, ls[m9], d.ls_lag.values[m9], clock[m9]] + [c[m9] for c in close_cols]))
if res9 is not None:
    b9, c9 = res9
    k9 = G9.shape[1]
    s9 = np.sqrt(np.diag(c9))
    print(f"\n9. The lag ({int(m9.sum())} days with a previous day): entries on today's budget {b9[k9]:.3f} +/- {s9[k9]:.3f}, "
          f"on yesterday's {b9[k9 + 1]:.3f} +/- {s9[k9 + 1]:.3f}")
    print(f"   the two together {b9[k9] + b9[k9 + 1]:.3f}: a sustained doubling costs {(2 ** (1 - b9[k9] - b9[k9 + 1]) - 1) * 100:.0f}% more an entry; "
          f"a one-day doubling, read on its own day, {(2 ** (1 - b9[k9]) - 1) * 100:.0f}% more")
    print("   (a large yesterday term means same-day tests, 3 and 4, read the penalty too high)")

# ---------------------------------------------------------------- 4b. budget steps on two-day windows
# the step day and the day after against the two days before, so an entry
# that lands a day late is still counted on its budget
d["spend2"] = d.spend + d.groupby("rel")["spend"].shift(-1)
d["ent2"] = d.entries + d.groupby("rel")["entries"].shift(-1)
d["spend2_lag"] = d.groupby("rel")["spend"].shift(1) + d.groupby("rel")["spend"].shift(2)
d["ent2_lag"] = d.groupby("rel")["entries"].shift(1) + d.groupby("rel")["entries"].shift(2)
d["gap_next"] = d.groupby("rel")["gap"].shift(-1)
d["gap_prev"] = d.groupby("rel")["gap"].shift(1)
d["clock2"] = w0 * (np.log1p((d.spent_before + d.groupby("rel")["spent_before"].shift(-1)) / 2 / K)
                    - np.log1p((d.groupby("rel")["spent_before"].shift(1) + d.groupby("rel")["spent_before"].shift(2)) / 2 / K))
m4 = d[(d.gap == 1) & (d.gap_next == 1) & (d.gap_prev == 1) & d.spend2_lag.notna() & d.ent2.notna()
       & (d.to_close >= 3)].copy()   # clear of the close's lift
m4["dls2"] = np.log(m4.spend2 / m4.spend2_lag)
m4["deff2"] = np.log((m4.ent2 + 0.5) / m4.spend2) - np.log((m4.ent2_lag + 0.5) / m4.spend2_lag) + m4.clock2
print("\n4b. Budget steps on two-day windows (the step day and the next against the two before, clear of the close)")
for name, m in [("rises of 30%+", m4.dls2 >= STEP), ("cuts of 30%+", m4.dls2 <= -STEP)]:
    g = m4[m]
    e_imp = -np.sum(g.deff2 * g.dls2) / np.sum(g.dls2 ** 2)
    print(f"   {name}: {len(g)} windows, budget x{np.exp(g.dls2.mean()):.2f}, entries a euro x{np.exp(g.deff2.mean()):.2f} "
          f"(median x{np.exp(g.deff2.median()):.2f}); implied elasticity {e_imp:.3f}")

# ---------------------------------------------------------------- what it means for the next euro
print("\nWhat each elasticity means for the next euro, on a flat day with the wear-out at the baseline:")
print("   marginal ROI over average ROI of the remaining spend is about (1 - eps - wear-out share)")
for e in EPS_GRID:
    print(f"   eps {e:.2f}: a doubled day {(2 ** e - 1) * 100:4.0f}% dearer; marginal / average about {1 - e - w0 * 0.5:.2f}")
