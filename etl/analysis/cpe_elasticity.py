"""How does cost per entry respond to the day's budget and to a campaign's
spend so far? The priors for etl/build.py campaign_cost_terms.

Joins daily Meta spend (data/spend_daily.csv) to daily paid draw entries
(Paid Social rows of sources/across_time.csv) for every Meta draw campaign
that can be tied to a release: the configured releases' campaign_names, the
discovered releases' campaign_name, and the draw campaign under the code the
orders feed gives a release. Fits, as Poisson with one level per campaign,

    log E[entries_d] = a_campaign + (1 - eps) * log(spend_d) - w * log(1 + C_d / K)

      + g_k * [the day is k days before the draw's close], k = 0 .. CLOSE_DAYS - 1

on every day with spend over 20 up to the close (days with no entry
included; a campaign still spending after its draw has closed buys nothing
the forecast counts), C_d being what the release's campaigns had spent
before day d. eps is the elasticity of cost per entry to the day's budget; w
is the wear-out, each doubling of the spend so far making the next entry 2^w
times dearer; K, the spend at which the wear-out starts to bite, is profiled
on a grid; exp(g_k) is the close's lift, the extra entries a euro buys on the
final days as the draw's deadline pulls people in (the final days' own paid
sign-ups entering at once, not earlier sign-ups coming back: close_rush.py).
The days to the close are
the funnel export's own campaign clock (days_until_launch). The
between-campaign spread of each campaign's own fit (DerSimonian-Laird, with
the close's lift held at the panel's) is the width of each prior, the width
campaign_cost_terms shrinks a campaign's own estimate with.

For comparison it also fits the calendar-day clocks the model used before:
a straight drift a day, and a curved one, log(1 + day / Kd).

Run from the repo root after a build: python3 etl/analysis/cpe_elasticity.py
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402  (poisson_fit, match_campaign, load_spend, the priors on file)

MIN_DAYS = 6          # a campaign needs this many days with spend to join the panel
CLOSE_DAYS = 2        # the lift's days; a third and later add nothing (x1.07 +/- 0.14 on day 2)
K_GRID = (100, 250, 500, 1000, 2000)   # below 100 the fit is flat (50 reads 1373 against 1375)

sp = build.load_spend()
at = pd.read_csv(ROOT / "sources/across_time.csv",
                 usecols=["AA_session_custom_channel_group_split_touch", "event_date", "simple_release_name",
                          "Draw_Entries_Eligible_Units", "days_until_launch"])
at["event_date"] = pd.to_datetime(at["event_date"], format="%d/%m/%Y").dt.date
# the campaign clock: days to the draw's close, per release and day
to_close = (at.dropna(subset=["days_until_launch"]).groupby(["simple_release_name", "event_date"])["days_until_launch"]
            .agg(lambda v: v.mode().iat[0]))
at = at[at["AA_session_custom_channel_group_split_touch"] == "Paid Social"]
entries = at.groupby(["simple_release_name", "event_date"])["Draw_Entries_Eligible_Units"].sum()

# ---- which Meta campaigns are each release's: every source the build reads
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
# draw campaigns only: a draw entry is what they buy
camps = {rel: [n for n in ns if "draw" in n.lower()] for rel, ns in camps.items()}
camps = {rel: ns for rel, ns in camps.items() if ns}

# One unit per group of campaigns: a group launch (Multiple_Amphorae_24 is
# one campaign the orders feed gives to eight releases) is one campaign whose
# entries are all its releases' together, never its spend counted once per
# release. Releases that share a campaign, directly or through another, are
# one unit.
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
    df["spent_before"] = df["spend"].cumsum() - df["spend"]          # the clock counts every day with spend
    df["entries"] = sum(entries.loc[r].reindex(df.index).fillna(0.0) for r in rels_u)
    df["to_close"] = [to_close.get((rels_u[0], day), np.nan) for day in df.index]
    # up to the close: after it the draw buys nothing the forecast counts
    df = df[(df.spend > 20) & (df.to_close >= 0)]
    if len(df) < MIN_DAYS or df.entries.sum() <= 0:
        continue
    df["day"] = [(d - df.index.min()).days for d in df.index]
    df["rel"] = rels_u[0] if len(rels_u) == 1 else f"{len(rels_u)} releases on {sorted(u['campaigns'])[0]}"
    rows.append(df)
d = pd.concat(rows)
rels = sorted(d.rel.unique())
print(f"{len(rels)} campaigns, {len(d)} campaign-days with spend over 20, {d.entries.sum():,.0f} paid entries, "
      f"spend {d.spend.sum():,.0f}")

G = np.zeros((len(d), len(rels)))
for i, r in enumerate(rels):
    G[(d.rel == r).values, i] = 1
y = d.entries.values
ls = np.log(d.spend.values)
close_cols = [(d.to_close.values == k).astype(float) for k in range(CLOSE_DAYS)]


def fit(*cols):
    res = build.poisson_fit(y, np.column_stack([G] + list(cols)))
    if res is None:
        raise SystemExit("panel fit failed")
    beta, cov = res
    k = len(rels)
    mu = np.exp(np.column_stack([G] + list(cols)) @ beta)
    dev = 2 * float(np.sum(np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0) - (y - mu)))
    return beta[k:], np.sqrt(np.diag(cov)[k:]), dev


devs = {K: fit(ls, np.log1p(d.spent_before.values / K), *close_cols)[2] for K in K_GRID}
K = min(devs, key=devs.get)
clock = np.log1p(d.spent_before.values / K)
coef, se, dev = fit(ls, clock, *close_cols)
eps, eps_se = 1 - coef[0], se[0]
wear, wear_se = -coef[1], se[1]
lift = [float(np.exp(c)) for c in coef[2:]]
print(f"\nspend so far, K = {K} (deviance by K: " + ", ".join(f"{k}: {v:.0f}" for k, v in devs.items()) + ")")
print(f"  elasticity to the day's budget: {eps:.3f} +/- {eps_se:.3f}")
print(f"  wear-out: {wear:.3f} +/- {wear_se:.3f} -> each doubling of spend so far makes an entry "
      f"{(2 ** wear - 1) * 100:.0f}% dearer (buys {(1 - 2 ** -wear) * 100:.0f}% fewer)")
print("  the close's lift: " + ", ".join(f"{k} day(s) out x{np.exp(c):.2f} (95% x{np.exp(c - 1.96 * s_):.2f} to x{np.exp(c + 1.96 * s_):.2f})"
                                         for k, (c, s_) in enumerate(zip(coef[2:], se[2:]))))
dev_noclose = fit(ls, clock)[2]
print(f"  deviance: {dev:.0f} with the close's lift, {dev_noclose:.0f} without")

# the calendar clocks, for comparison (with the same close terms)
c_day, s_day, dev_day = fit(ls, d.day.values.astype(float), *close_cols)
kd = min((0.5, 1, 2, 4, 8), key=lambda v: fit(ls, np.log1p(d.day.values / v), *close_cols)[2])
c_cd, s_cd, dev_cd = fit(ls, np.log1p(d.day.values / kd), *close_cols)
print(f"  deviance: spend so far {dev:.0f}; straight days {dev_day:.0f} (drift {-c_day[1] * 100:.2f}% a day); "
      f"curved days {dev_cd:.0f} (Kd {kd})")

# ---- per-campaign fits and how far they spread beyond their own noise: the
# priors' widths (DerSimonian-Laird)
per = []
for rel, g in d.groupby("rel"):
    if len(g) < int(build.BENCH.get("cpe_fit_min_days", 8)):
        continue
    X = np.column_stack([np.ones(len(g)), np.log(g.spend.values), np.log1p(g.spent_before.values / K)])
    # the close's lift at the panel's, as the build fits a campaign
    off = sum(np.log(lift[k]) * (g.to_close.values == k) for k in range(CLOSE_DAYS))
    res = (build.poisson_fit(g.entries.values, X, offset=off)
           if float(np.std(np.log(g.spend.values))) > 1e-6 else None)
    if res is None:
        continue
    b, c = res
    sd = np.sqrt(np.clip(np.diag(c), 0, None))
    if sd[1] > 0 and sd[2] > 0 and np.isfinite(sd).all():
        per.append((rel, len(g), 1 - b[1], sd[1], -b[2], sd[2]))
per = pd.DataFrame(per, columns=["release", "days", "eps", "eps_se", "wear", "wear_se"])


def spread(est, se):
    w = 1 / se ** 2
    mu = (w * est).sum() / w.sum()
    q = (w * (est - mu) ** 2).sum()
    k = len(est)
    tau2 = max((q - (k - 1)) / (w.sum() - (w ** 2).sum() / w.sum()), 0)
    return mu, np.sqrt(tau2)


mu_e, tau_e = spread(per.eps.values, per.eps_se.values)
mu_w, tau_w = spread(per.wear.values, per.wear_se.values)
print(f"\nper-campaign fits ({len(per)} campaigns with {build.BENCH.get('cpe_fit_min_days', 8)}+ days): "
      f"elasticity mean {mu_e:.3f}, between-campaign sd {tau_e:.3f}; wear-out mean {mu_w:.3f}, between-campaign sd {tau_w:.3f}")
print(per.sort_values("days", ascending=False).round(3).to_string(index=False))
print(f"\non file: cpe_spend_elasticity {build.BENCH.get('cpe_spend_elasticity')} +/- {build.BENCH.get('cpe_spend_elasticity_sd')}, "
      f"cpe_wearout {build.BENCH.get('cpe_wearout')} +/- {build.BENCH.get('cpe_wearout_sd')}, cpe_wearout_k {build.BENCH.get('cpe_wearout_k')}, "
      f"cpe_close_lift {build.BENCH.get('cpe_close_lift')}")
print(f"suggested: cpe_spend_elasticity {eps:.3f} (sd {tau_e:.3f}), cpe_wearout {wear:.3f} (sd {tau_w:.3f}), cpe_wearout_k {K}, "
      f"cpe_close_lift {[round(x, 2) for x in lift]}")
