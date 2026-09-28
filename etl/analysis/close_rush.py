"""What the close's lift is made of: the final two days' paid entries read at
account level, and the lift split into sign-ups a euro and entries a sign-up.

An entry is attributed to the channel of the session the person signed up
in, and a draw started and not finished counts as signing up, so the rush in
paid entries on a draw's final days (cpe_close_lift, x1.53 on the close day)
could have been credit deferred from earlier paid sign-ups coming back after
an email: a pool the final day's spend does nothing to, which no budget
should be multiplied by. Part 1 reads sources/le_events.csv (signup and draw
entry intent events with a pseudonymous account id, no address) and joins the
accounts inside the script: the lag from sign-up to entry, who the final
days' paid entries are, and what share of the paid sign-ups who had not
entered by the final two days did so then. Part 2 fits the close's lift on
the cost panel of cpe_elasticity.py on paid sign-ups a euro and on entries
per sign-up, the two things a euro on the final day buys. Aggregates only:
no id is printed.

Run from the repo root after a build: python3 etl/analysis/close_rush.py
"""
import pathlib
import sys
import warnings

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

warnings.filterwarnings("ignore")
CH = "AA_session_custom_channel_group_split_touch"
ev = pd.read_csv(ROOT / "sources/le_events.csv", low_memory=False,
                 usecols=["event_date", "event_name", "aa_account_id", "simple_release_name", "launch_type",
                          "days_until_launch", CH, "converted_signup_draw"])
ev = ev[ev.launch_type == "Draw"].copy()
ev["event_date"] = pd.to_datetime(ev["event_date"], errors="coerce").dt.date
ev = ev.dropna(subset=["event_date"])
# the campaign clock per release and day
to_close = (ev.dropna(subset=["days_until_launch"]).groupby(["simple_release_name", "event_date"])["days_until_launch"]
            .agg(lambda v: v.mode().iat[0]))
su = ev[ev.event_name == "signup"]
en = ev[ev.event_name == "draw entry intent"]

# ---- part 1: who the paid entries are
print("PART 1: paid entries at account level")
first_su = (su.sort_values("event_date").groupby(["simple_release_name", "aa_account_id"])
            .agg(su_date=("event_date", "first"), su_ch=(CH, "first"), conv=("converted_signup_draw", "max")))
first_en = (en.sort_values("event_date").groupby(["simple_release_name", "aa_account_id"])
            .agg(en_date=("event_date", "first"), en_ch=(CH, "first")))
j = first_su.join(first_en, how="outer")
paid_en = j[j.en_ch == "Paid Social"]
has_su = paid_en.su_date.notna()
print(f"paid entries (first per account and release): {len(paid_en):,}; with a sign-up on the same release {int(has_su.sum()):,}; "
      f"of those, sign-up channel paid {int((paid_en.su_ch == 'Paid Social').sum()):,}")
lag = (pd.to_datetime(paid_en.en_date[has_su]) - pd.to_datetime(paid_en.su_date[has_su])).dt.days
bins = pd.cut(lag, [-1e9, -1, 0, 1, 2, 6, 13, 1e9],
              labels=["entry before sign-up", "same day", "1 day", "2 days", "3-6 days", "7-13 days", "14+ days"])
print("lag from sign-up to entry:\n" + bins.value_counts().reindex(bins.cat.categories).to_string())
paid_su = j[j.su_ch == "Paid Social"].copy()
paid_su["entered"] = paid_su.en_date.notna()
print(f"\npaid sign-ups: {len(paid_su):,}; entered the draw {int(paid_su.entered.sum()):,} ({100 * paid_su.entered.mean():.1f}%); "
      f"converted_signup_draw agrees on {int(((paid_su.conv == 1) == paid_su.entered).sum()):,}")
rel_of = paid_su.index.get_level_values(0)
paid_su["su_tc"] = [to_close.get((r, d), np.nan) for r, d in zip(rel_of, paid_su.su_date)]
paid_su["en_tc"] = [to_close.get((r, d), np.nan) if pd.notna(d) else np.nan for r, d in zip(rel_of, paid_su.en_date)]
# per release: the pool at the start of the final two days and what it does
rows = []
for rel, g in paid_su.groupby(level=0):
    g = g[g.su_tc.notna()]
    if len(g) < 30:
        continue
    before = g[g.su_tc >= 2]                                   # signed up before the final two days
    pool = before[~(before.en_tc >= 2)]                        # and not entered by their start
    comp = pool[(pool.en_tc <= 1) & (pool.en_tc >= 0)]         # completed on them
    final_su = g[(g.su_tc <= 1) & (g.su_tc >= 0)]              # signed up on the final two days
    final_su_en = final_su[(final_su.en_tc <= 1) & (final_su.en_tc >= 0)]
    all_final_en = g[(g.en_tc <= 1) & (g.en_tc >= 0)]
    rows.append({"release": rel, "paid_signups": len(g), "entered_before": int((before.en_tc >= 2).sum()),
                 "pool": len(pool), "completions": len(comp), "share": len(comp) / len(pool) if len(pool) else np.nan,
                 "final_signups": len(final_su), "final_signups_entered": len(final_su_en), "final_entries": len(all_final_en)})
t = pd.DataFrame(rows).sort_values("paid_signups", ascending=False)
pd.set_option("display.width", 250)
print(f"\nper release ({len(t)} with 30+ paid sign-ups on the clock):")
print(t.round(3).to_string(index=False))
print(f"\npool at the start of the final two days {t.pool.sum():,} -> completed on them {t.completions.sum():,} "
      f"({100 * t.completions.sum() / t.pool.sum():.1f}%; by release median {100 * t.share.median():.1f}%)")
print(f"final-two-day paid entries {t.final_entries.sum():,}: signed up on those days {t.final_signups_entered.sum():,} "
      f"({100 * t.final_signups_entered.sum() / t.final_entries.sum():.0f}%), earlier sign-ups coming back {t.completions.sum():,}")

# ---- part 2: the lift split, on the cost panel
print("\nPART 2: the lift on sign-ups a euro and on entries a sign-up")
src = (ROOT / "etl/analysis/cpe_elasticity.py").read_text()
head = src[:src.index("G = np.zeros((len(d), len(rels)))")]         # the panel, before its fits
g = {"__file__": str(ROOT / "etl/analysis/cpe_elasticity.py"), "__name__": "panel"}
exec(compile(head, "cpe_elasticity.py", "exec"), g)
d, units, in_funnel = g["d"].copy(), g["units"], g["in_funnel"]
K = float(build.BENCH["cpe_wearout_k"])
label_rels = {}
for u in units.values():
    rels_u = sorted(r for r in u["releases"] if r in in_funnel)
    if rels_u:
        label_rels[rels_u[0] if len(rels_u) == 1 else f"{len(rels_u)} releases on {sorted(u['campaigns'])[0]}"] = rels_u
su_day = su[su[CH] == "Paid Social"].groupby(["simple_release_name", "event_date"]).aa_account_id.nunique()
en_day = en[en[CH] == "Paid Social"].groupby(["simple_release_name", "event_date"]).aa_account_id.nunique()
d["signups"] = [sum(su_day.get((r, day), 0) for r in label_rels[lbl]) for lbl, day in zip(d.rel, d.index)]
d["ev_entries"] = [sum(en_day.get((r, day), 0) for r in label_rels[lbl]) for lbl, day in zip(d.rel, d.index)]
print(f"{d.rel.nunique()} campaigns, {len(d)} campaign-days; paid sign-ups {d.signups.sum():,}, paid entries (events) {d.ev_entries.sum():,}, "
      f"eligible entry units (funnel export) {d.entries.sum():,.0f}")
rels = sorted(d.rel.unique())
G = np.zeros((len(d), len(rels)))
for i, r in enumerate(rels):
    G[(d.rel == r).values, i] = 1
ls, clock = np.log(d.spend.values), np.log1p(d.spent_before.values / K)
c0, c1 = (d.to_close.values == 0).astype(float), (d.to_close.values == 1).astype(float)


def fit(y, cols, offset=None, keep=None):
    keep = np.ones(len(y), bool) if keep is None else keep
    X = np.column_stack([G[keep]] + [c[keep] for c in cols])
    beta, cov = build.poisson_fit(y[keep], X, offset=None if offset is None else offset[keep])
    return beta[len(rels):], np.sqrt(np.diag(cov))[len(rels):]


b, s = fit(d.entries.values, [ls, clock, c0, c1])
print(f"entry units a euro (the fit on file): close x{np.exp(b[2]):.2f} +/- {s[2]:.2f} in logs, day before x{np.exp(b[3]):.2f} +/- {s[3]:.2f}")
b, s = fit(d.ev_entries.values, [ls, clock, c0, c1])
print(f"paid entries a euro (events):        close x{np.exp(b[2]):.2f} +/- {s[2]:.2f}, day before x{np.exp(b[3]):.2f} +/- {s[3]:.2f}")
b, s = fit(d.signups.values, [ls, clock, c0, c1])
print(f"paid sign-ups a euro:                close x{np.exp(b[2]):.2f} +/- {s[2]:.2f}, day before x{np.exp(b[3]):.2f} +/- {s[3]:.2f}; "
      f"elasticity {1 - b[0]:.2f}, wear-out {-b[1]:.2f}")
ok = d.signups.values > 0
off = np.log(np.where(ok, d.signups.values, 1))
b, s = fit(d.ev_entries.values, [c0, c1], offset=off, keep=ok)
print(f"entries per paid sign-up:            close x{np.exp(b[0]):.2f} +/- {s[0]:.2f}, day before x{np.exp(b[1]):.2f} +/- {s[1]:.2f}")
b, s = fit(d.ev_entries.values, [ls, clock, c0, c1], offset=off, keep=ok)
print(f"  with the day's budget and the clock in: close x{np.exp(b[2]):.2f}, day before x{np.exp(b[3]):.2f}; "
      f"budget slope {b[0]:+.2f} +/- {s[0]:.2f}, clock slope {b[1]:+.2f} +/- {s[1]:.2f}")
