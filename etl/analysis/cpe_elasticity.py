"""How fast does cost per entry rise with daily spend, within a campaign?

Joins daily Meta spend (data/spend_daily.csv) to daily paid draw entries
(Paid Social rows of sources/across_time.csv) for every release with a matched
campaign, and fits

    log(CPE_d) = a_campaign + eps * log(spend_d) + drift * day

The campaign fixed effect absorbs each campaign's price level, the day term
absorbs the time drift the workbook's tiers describe, so eps is the pure
spend effect. It feeds benchmarks.json cpe_spend_elasticity: the paid
recommendation prices the entries it asks for at the CPE the recommended
spend level implies, not today's.

Run from the repo root after a build: python3 etl/analysis/cpe_elasticity.py
"""
import json, pathlib
import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]

sp = pd.read_csv(ROOT / "data/spend_daily.csv"); sp["spend_date"] = pd.to_datetime(sp["spend_date"]).dt.date
at = pd.read_csv(ROOT / "sources/across_time.csv",
                 usecols=["AA_session_custom_channel_group_split_touch", "event_date", "simple_release_name", "Draw_Entries_Eligible_Units"])
at["event_date"] = pd.to_datetime(at["event_date"], format="%d/%m/%Y").dt.date
paid = (at[at["AA_session_custom_channel_group_split_touch"] == "Paid Social"]
        .groupby(["simple_release_name", "event_date"])["Draw_Entries_Eligible_Units"].sum().reset_index())
doc = json.load(open(ROOT / "data/app/inputs.json"))
pairs = {r["release_name"]: r["campaign_name"] for r in doc["releases"].values() if r.get("campaign_name")}
pairs.update({v["release_name"]: v["campaign_name"] for v in doc.get("discovered", {}).values() if v.get("campaign_name")})

rows = []
for rel, camp in pairs.items():
    s = sp[sp["campaign_name"] == camp].groupby("spend_date")["spend"].sum()
    e = paid[paid["simple_release_name"] == rel].set_index("event_date")["Draw_Entries_Eligible_Units"]
    df = pd.concat([s.rename("spend"), e.rename("entries")], axis=1).dropna()
    df = df[(df.spend > 20) & (df.entries >= 1)]      # a day with spend and at least one entry
    if len(df) < 6:
        continue
    df = df.sort_index(); df["day"] = np.arange(len(df)); df["rel"] = rel
    rows.append(df)
d = pd.concat(rows); d["cpe"] = d.spend / d.entries
print(f"{d.rel.nunique()} campaigns, {len(d)} campaign-days with spend and paid entries")
print("daily spend: median £%.0f, p90 £%.0f, max £%.0f | CPE median £%.0f" % (d.spend.median(), d.spend.quantile(.9), d.spend.max(), d.cpe.median()))

rels = sorted(d.rel.unique()); X = np.zeros((len(d), len(rels) + 2))
for i, r in enumerate(rels):
    X[(d.rel == r).values, i] = 1
X[:, -2] = np.log(d.spend.values); X[:, -1] = d.day.values
y = np.log(d.cpe.values)
beta, *_ = np.linalg.lstsq(X, y, rcond=None)
resid = y - X @ beta; dof = len(y) - X.shape[1]
cov = (resid @ resid / dof) * np.linalg.inv(X.T @ X); se = np.sqrt(np.diag(cov))
eps, drift = beta[-2], beta[-1]
print(f"elasticity of CPE to daily spend (within campaign, net of day drift): {eps:.3f} +/- {se[-2]:.3f}")
print(f"day drift: {drift*100:.2f}% per day +/- {se[-1]*100:.2f}  (the workbook's tiers: 5 / 7 / 10 %)")
print(f"=> doubling daily spend raises CPE by {(2**eps-1)*100:.0f}%; 10x by {(10**eps-1)*100:.0f}%; 50x by {(50**eps-1)*100:.0f}%")
d["hi"] = d.groupby("rel").spend.transform(lambda s: s > s.median())
g = d.groupby(["rel", "hi"]).apply(lambda x: x.spend.sum() / x.entries.sum()).unstack().dropna()
print(f"campaign-level check: CPE on above-median-spend days vs below, median ratio {(g[True]/g[False]).median():.2f} across {len(g)} campaigns")
print(f"benchmarks.json cpe_spend_elasticity currently: {json.load(open(ROOT / 'etl/benchmarks.json')).get('cpe_spend_elasticity')}")
