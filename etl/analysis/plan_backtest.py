"""The plan model's price list and its standing back-test against the clock
(docs/PLAN_MODEL.md).

Every closed draw launch with emails and a Notion plan on file is rebuilt day
by day: its demand outside paid (eligible entry units at the entry rate, plus
the private room's units), the emails that went out and the plan's posts. Then:

  the click model   a send's clicks from its kind, its audience's size and
                    its place in the campaign, and how far a launch's earlier
                    sends tell its later ones; scored send by send with each
                    launch left out of the fit.
  the price list    what each kind of day brings, in quiet days, and the usual
                    share of a plan still ahead at each point of a campaign.
  the back-test     the final demand forecast from five points of each launch,
                    three ways: the clock (the pooled median curve, which is
                    what "expected by today" is built on), the plan alone, and
                    the clock scaled by the plan against the usual plan
                    (anchored), at each strength. Every launch is predicted
                    from prices and curves fitted on the other launches.

Writes etl/plan_prices.json (what etl/plan_model.py reads) and
etl/plan_backtest.json (the tables), and prints both. Needs scipy; run from
the repo root after the feeds are in place (README, "The plan model"):
    python3 etl/analysis/plan_backtest.py
"""
from __future__ import annotations

import contextlib
import io
import json
import pathlib
import sys
import warnings

import numpy as np
import pandas as pd
from scipy.optimize import least_squares

warnings.filterwarnings("ignore")
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402
import plan_model as P  # noqa: E402

PRICES_OUT = ROOT / "etl" / "plan_prices.json"
BACKTEST_OUT = ROOT / "etl" / "plan_backtest.json"
MIN_DEMAND = 25.0          # a launch with less than this outside paid says nothing about shape
MIN_PLAN_ROWS = 5          # a launch's plan is on file when this many of its rows went out in its window
FOLDS = 12
SEED = 7
CUTS = [("2 days after announce", None), ("25% through", 0.25), ("50% through", 0.50), ("75% through", 0.75), ("90% through", 0.90)]
GAMMAS = [0.0, 0.25, 0.5, 0.75, 1.0]
STAGES = [round(x, 2) for x in np.arange(0.05, 0.96, 0.05)]
GRID = np.round(np.arange(-0.6, 1.0001, 0.01), 2)
RIDGE = 1.0
PAID = set(build.DISPLAY_GROUPS["paid"]["channels"])


# ---------------------------------------------------------------- the panel
def launches_table(at: pd.DataFrame, as_of, aud: pd.DataFrame, campaigns: pd.DataFrame) -> pd.DataFrame:
    """Every release in the funnel with a campaign window: the funnel's own
    clock first, the committed panel's dates where it has none, then the
    Notion campaign's. Its code is the build's own reading (the release's
    orders, its Airtable launch, else a guess: build.source_campaign_codes)
    and can be none: a launch run before codes were in use (to mid-2024) has
    its plan and its emails found by the artist's name and its days
    (plan_model.plan_campaign, launch_sends). Until 16 November 2026 a launch
    needed a code here, and Notion's campaigns one of their own, which left
    out every launch before May 2024 and those whose code the guess missed."""
    emails, content, posts, spend = build.load_emails(), build.load_content(), build.load_artist_posts(), build.load_spend()
    codes = build.known_codes(emails, content, posts)
    codes |= {c for c in aud["code"].dropna().unique() if build._CODE_RE.match(c)} if len(aud) else set()
    codes |= {c for c in campaigns["campaign_code"] if build._CODE_RE.match(str(c))}
    records = build.discover_releases(at, as_of, codes)
    raw = build.feed_codes(emails, content, posts, spend) | {str(c) for c in campaigns["campaign_code"] if not str(c).startswith(P.STAND_IN)}
    raw |= {str(c).strip() for c in aud["campaign"].dropna().unique() if str(c).strip()} if len(aud) and "campaign" in aud.columns else set()
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            build.source_campaign_codes(records, codes, build.load_launches(), spend, raw=raw)
    except Exception as e:  # noqa: BLE001 - the guesses stand
        print(f"warning: campaign codes from the orders and Airtable failed ({e}) - the guesses stand")
    L = pd.DataFrame(records)
    panel = pd.read_csv(ROOT / "data" / "release_clusters.csv", usecols=["release_name", "announce", "close"]).rename(
        columns={"announce": "ann_panel", "close": "close_panel"})
    L = L.merge(panel, on="release_name", how="left")
    by_code = campaigns.drop_duplicates("campaign_code").set_index("campaign_code")

    def dates(r):
        if isinstance(r["announce_date"], str) and isinstance(r["launch_end"], str):
            return r["announce_date"], r["launch_end"], "funnel clock"
        if isinstance(r["ann_panel"], str) and isinstance(r["close_panel"], str):
            return r["ann_panel"], r["close_panel"], "committed panel"
        c = r["campaign_code"]
        if isinstance(c, str) and c in by_code.index and pd.notna(by_code.at[c, "announce"]) and pd.notna(by_code.at[c, "launch"]):
            return str(by_code.at[c, "announce"].date()), str(by_code.at[c, "launch"].date()), "notion"
        return None, None, None

    L[["announce", "close", "dates_from"]] = L.apply(lambda r: pd.Series(dates(r)), axis=1)
    L["launch_end"] = L["close"]
    L = L[L["announce"].notna() & L["close"].notna()].copy()
    L["announce"], L["close"] = pd.to_datetime(L["announce"]), pd.to_datetime(L["close"])
    L["days"] = (L["close"] - L["announce"]).dt.days
    return L[(L["days"] >= 5) & (L["days"] <= 75)].reset_index(drop=True)


def daily_demand(at: pd.DataFrame, name: str, announce, close) -> pd.Series:
    """Demand outside paid by day, from LEAD_DAYS before the announce to the close."""
    g = at[(at["simple_release_name"] == name) & ~at["channel"].isin(PAID)]
    days = pd.date_range(announce - pd.Timedelta(days=P.LEAD_DAYS), close)
    g = g.assign(day=pd.to_datetime(g["event_date"]))
    y = P.demand_units(g).groupby(g["day"]).sum()
    return y.reindex(days).fillna(0.0)


# the channels each kind of comms is read against in the history checks (the funnel's own names)
CHECK_GROUPS = {"email": ["AA Email Auto", "AA Email Man"], "aa_social": ["AA Meta", "AA X"], "artist": ["Referral Artist"],
                "referrals": ["Referral Other", "Referral Meta", "Referral X"], "direct": ["Direct"], "search": ["Organic Search"]}


def group_demand(at: pd.DataFrame, name: str, announce, close) -> dict:
    """Each checked group's demand by day, over the same days as daily_demand."""
    g = at[at["simple_release_name"] == name]
    g = g.assign(day=pd.to_datetime(g["event_date"]))
    days = pd.date_range(announce - pd.Timedelta(days=P.LEAD_DAYS), close)
    out = {}
    for key, chans in CHECK_GROUPS.items():
        c = g[g["channel"].isin(chans)]
        y = P.demand_units(c).groupby(c["day"]).sum()
        out[key] = y.reindex(days).fillna(0.0).to_numpy(dtype=float)
    return out


def launch_feeds(r, aud, comms, campaigns) -> tuple:
    """A launch's plan rows and emails in its days, with the Notion campaign
    they were found under and how (plan_model.plan_campaign)."""
    start = r["announce"] - pd.Timedelta(days=P.LEAD_DAYS)
    own = r["campaign_code"] if isinstance(r["campaign_code"], str) and r["campaign_code"] else None
    key, how = P.plan_campaign(r["artist"], start, r["close"], comms, campaigns, own=own)
    plan = comms[(comms["campaign_code"] == key) & (comms["date"] >= start) & (comms["date"] <= r["close"])] if key else comms.iloc[0:0]
    sends = P.launch_sends(aud, [own, key], start, r["close"], artist=r["artist"], plan=plan)
    return plan, sends, own, key, how


SKIPPED: dict = {}     # why each launch with a window is not in the panel (build_panel), for the run's own account


def build_panel(at, as_of, aud, comms, campaigns, coef) -> dict:
    """name -> {t, L, y, X (as it ran), G (demand by checked group), sends, plan, announce, close}."""
    L = launches_table(at, as_of, aud, campaigns)
    out = {}
    SKIPPED.clear()
    for _, r in L.iterrows():
        if r["close"] + pd.Timedelta(days=build.UNITS_GRACE_DAYS) >= pd.Timestamp(as_of):
            SKIPPED[r["release_name"]] = "still open"
            continue
        y = daily_demand(at, r["release_name"], r["announce"], r["close"])
        if y.sum() < MIN_DEMAND:
            SKIPPED[r["release_name"]] = "under 25 units of demand outside paid"
            continue
        plan, sends, own, key, how = launch_feeds(r, aud, comms, campaigns)
        went = plan[plan["status"].isin(P.WENT) & plan["family"].isin(P.POST_FAMILIES + ["email"])]
        if sends.empty or len(went) < MIN_PLAN_ROWS:
            SKIPPED[r["release_name"]] = ("no plan found in Notion" if not key else "fewer than 5 plan rows that went out" if len(went) < MIN_PLAN_ROWS else "no launch email found")
            continue
        days = P.launch_days(r["announce"], r["close"], sends, plan, coef)
        out[r["release_name"]] = {"t": days["t"].to_numpy(), "L": int(r["days"]), "y": y.to_numpy(dtype=float),
                                  "X": days[P.VALUE_COLS].to_numpy(dtype=float), "G": group_demand(at, r["release_name"], r["announce"], r["close"]),
                                  "sends": sends, "plan": plan,
                                  "announce": r["announce"], "close": r["close"], "code": own or key, "plan_key": key, "found": how, "artist": r["artist"]}
    # two releases run as one campaign (an edition and its hand-finished run) share one plan: the plan is read
    # against the larger, since read against each it would be asked to explain the same comms twice
    by_key: dict = {}
    for n, d in out.items():
        by_key.setdefault(d["plan_key"], []).append(n)
    for key, names in by_key.items():
        names.sort(key=lambda n: -float(out[n]["y"].sum()))
        for n in names[1:]:
            if out[n]["announce"] <= out[names[0]]["close"] and out[names[0]]["announce"] <= out[n]["close"]:
                SKIPPED[n] = f"shares its plan with {names[0]}"
                del out[n]
    return out


# ---------------------------------------------------------------- the click model
def sends_table(at, as_of, aud, campaigns) -> pd.DataFrame:
    """Every launch email that went out on a launch with a window, whether or
    not the launch has a plan on file: the click model needs sends, not plans."""
    L = launches_table(at, as_of, aud, campaigns)
    comms = P.load_comms()
    rows = []
    for _, r in L.iterrows():
        _, s, _, _, _ = launch_feeds(r, aud, comms, campaigns)
        s = s[s["clicked"] >= 3]
        if s.empty:
            continue
        s = s.assign(launch=r["release_name"], t=(s["day"] - r["announce"]).dt.days, L=int(r["days"]))
        rows.append(s)
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def ridge(X: np.ndarray, y: np.ndarray, alpha: float = RIDGE) -> np.ndarray:
    """Least squares with a small pull towards zero on everything but the constant."""
    pen = alpha * np.eye(X.shape[1])
    pen[0, 0] = 0.0
    return np.linalg.solve(X.T @ X + pen, X.T @ y)


def click_design(S: pd.DataFrame) -> np.ndarray:
    return np.vstack([P.click_features(k, d, int(t), int(L)) for k, d, t, L in zip(S["kind"], S["delivered"], S["t"], S["L"])])


def click_backtest(S: pd.DataFrame, folds) -> dict:
    """A send's clicks predicted with its launch left out of the fit: from
    kind, size and timing alone, then with the launch's earlier days' sends."""
    S = S.reset_index(drop=True)
    y = np.log(S["clicked"] / S["delivered"]).to_numpy()
    X = click_design(S)
    plain, pulled, had = np.zeros(len(S)), np.zeros(len(S)), np.zeros(len(S), dtype=bool)
    for fold in folds:
        te = S["launch"].isin(fold).to_numpy()
        coef = ridge(X[~te], y[~te])
        pred = X @ coef
        for name, g in S[te].groupby("launch"):
            for i in g.index:
                prev = g.index[g["day"] < S.at[i, "day"]]
                pull = P.launch_pull(y[prev] - pred[prev]) if len(prev) else 0.0
                plain[i], pulled[i], had[i] = pred[i], pred[i] + pull, len(prev) > 0
    e0, e1 = np.abs(plain - y), np.abs(pulled - y)

    def read(mask):
        return {"n": int(mask.sum()), "miss": float(np.expm1(np.median(e0[mask]))), "within30": float((e0[mask] < np.log(1.3)).mean()),
                "miss_with_launch": float(np.expm1(np.median(e1[mask]))), "within30_with_launch": float((e1[mask] < np.log(1.3)).mean())}
    out = {"all": read(np.ones(len(S), dtype=bool)), "after_first_day": read(had), "by_kind": {}}
    for k in P.EMAIL_KINDS:
        m = had & (S["kind"] == k).to_numpy()
        if m.sum() >= 12:
            out["by_kind"][k] = read(m)
    resid = (pulled - y)[had]
    out["spread"] = [float(np.quantile(-resid, 0.25)), float(np.quantile(-resid, 0.75))]   # actual over expected, the middle half
    return out


# ---------------------------------------------------------------- the price list
K = len(P.VALUE_COLS)
NE, NP = P.EMAIL_FADE_DAYS, P.POST_FADE_DAYS      # the days after its own that an email, and a post, is still felt
NF = NE + NP
EM = [i for i, c in enumerate(P.VALUE_COLS) if c.startswith("em_")]
PO = [i for i in range(K) if i not in EM]


def parts(d: dict, th: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A launch's days as the price list `th` reads them: what each brings
    with nothing going out, and what the pieces add (each on its own day and,
    fading, on the days after: an email's days and a post's fitted apart)."""
    X, t, L = d["X"], d["t"], d["L"]
    act = X.copy()
    for lag in range(1, NE + 1):
        if lag < len(X):
            act[lag:, EM] += th[K + lag - 1] * X[:-lag, EM]
    for lag in range(1, NP + 1):
        if lag < len(X):
            act[lag:, PO] += th[K + NE + lag - 1] * X[:-lag, PO]
    base = np.where(t >= 0, 1.0, th[K + NF + 2]) + th[K + NF] * (t == L) + th[K + NF + 1] * (t == L - 1)
    return base, act @ th[:K]


def mu(d: dict, th: np.ndarray) -> np.ndarray:
    base, pieces = parts(d, th)
    return base + pieces


def fit_prices(panel: dict, keys, start=None) -> np.ndarray:
    """The weights that best match each launch's day-by-day share of its own
    demand: one set for every launch, none below zero."""
    def resid(th):
        out = []
        for n in keys:
            d = panel[n]
            m = mu(d, th)
            out.append(d["y"] / d["y"].sum() - m / m.sum())
        return np.concatenate(out)
    th0 = np.r_[np.full(K, 0.5), 0.4 * 0.5 ** np.arange(NE), 0.4 * 0.5 ** np.arange(NP), 1.0, 1.0, 0.2] if start is None else start
    hi = np.r_[np.full(K, 1e3), np.ones(NF), 1e3, 1e3, 5.0]
    th0 = np.minimum(np.maximum(th0, 1e-6), hi - 1e-6)
    return least_squares(resid, th0, bounds=(np.zeros(K + NF + 3), hi), x_scale="jac", max_nfev=400).x


def as_prices(th: np.ndarray) -> dict:
    return {"weights": {c: float(w) for c, w in zip(P.VALUE_COLS, th[:K])},
            "fade_email": [float(x) for x in th[K:K + NE]], "fade_posts": [float(x) for x in th[K + NE:K + NF]],
            "close_day": float(th[K + NF]), "day_before": float(th[K + NF + 1]), "pre": float(th[K + NF + 2])}


def quiet_days(d: dict) -> np.ndarray:
    """A launch's days after the announce with nothing going out and nothing still felt."""
    e_on = (d["X"][:, EM].sum(axis=1) > 0).astype(float)
    p_on = (d["X"][:, PO].sum(axis=1) > 0).astype(float)
    near = (P.lagged(e_on, [1.0] * NE) + P.lagged(p_on, [1.0] * NP)) > 0
    return (~near) & (d["t"] >= 0)


# the page's channel groups (etl/build.py DISPLAY_GROUPS) against the demand groups read here
PAGE_GROUPS = {"aa_email": "email", "aa_social": "aa_social", "referral_artist": "artist", "organic_search": "search", "direct_other": "referrals"}


def quiet_split(panel: dict) -> dict:
    """How a quiet day's demand splits over the page's channel groups, Direct
    left out (the page's default view shares it over the others)."""
    tot = {g: 0.0 for g in PAGE_GROUPS}
    for d in panel.values():
        q = quiet_days(d)
        for g, k in PAGE_GROUPS.items():
            tot[g] += float(d["G"][k][q].sum())
    s = sum(tot.values())
    return {g: round(v / s, 4) for g, v in tot.items()} if s > 0 else {}


def quiet_sizes(panel: dict, th: np.ndarray) -> list[dict]:
    """How big a quiet day was on each launch, in demand units: its demand
    over its plan's value. What a new launch's plan is sized on before it has
    results of its own (etl/plan_view.py)."""
    rows = []
    for name, d in panel.items():
        v = float(mu(d, th).sum())
        if v > 0:
            rows.append({"name": name, "artist": name.split(" \u00b7 ")[0], "close": str(pd.Timestamp(d["close"]).date()),
                         "quiet": round(float(d["y"].sum()) / v, 4), "demand": round(float(d["y"].sum()), 1)})
    return sorted(rows, key=lambda r: r["close"])


def curve_of(d: dict) -> np.ndarray:
    return np.interp(GRID, d["t"] / d["L"], np.cumsum(d["y"]) / d["y"].sum(), left=0.0, right=1.0)


def ratio_at(values: np.ndarray, t: np.ndarray, cut: int):
    return P.remaining_ratio(values, t, cut)


def usual_table(panel: dict, keys, th: np.ndarray) -> dict:
    """The usual share of a plan still ahead at each stage: the median over
    the launches of (value after the point) / (value up to it), as they ran."""
    stage, ratio, n = [], [], []
    for s in STAGES:
        rs = []
        for name in keys:
            d = panel[name]
            r = ratio_at(mu(d, th), d["t"], int(round(s * d["L"])))
            if r is not None:
                rs.append(r)
        if len(rs) >= 8:
            stage.append(s); ratio.append(float(np.median(rs))); n.append(len(rs))
    return {"stage": stage, "ratio": ratio, "n": n}


def planned_X(d: dict, coef, cut_day: pd.Timestamp, reliability: dict) -> np.ndarray:
    """The launch's days as its plan stood on `cut_day`: what had gone out, and
    what was written down to come, each still-to-come post at its family's
    reliability whether or not it went in the end. A row added after the cut
    was not in the plan; one marked dropped by then was known to be. The
    emails to come are the sends that did go (the plan's email rows went out
    96 times in 100, and only HubSpot knows a send's audience)."""
    plan = d["plan"]
    known = plan[(plan["date"] <= cut_day) | (pd.to_datetime(plan["created"], errors="coerce") <= cut_day)].copy()
    edited = pd.to_datetime(known["edited"], errors="coerce")
    gone_later = known["status"].isin(P.DROPPED) & (edited > cut_day) & (known["date"] > cut_day)
    known.loc[gone_later, "status"] = "Scheduled"      # still in the plan on the cut's day
    late = (known["date"] > cut_day) & known["status"].isin(P.WENT)
    known.loc[late, "status"] = "Scheduled"
    days = P.launch_days(d["announce"], d["close"], d["sends"], known, coef, as_of=cut_day + pd.Timedelta(days=1), reliability=reliability)
    return days[P.VALUE_COLS].to_numpy(dtype=float)


def history_checks(panel: dict) -> dict:
    """Does demand follow what goes out? For all comms against demand outside
    paid, and for each kind of comms against its own channel: the share of a
    launch's days with that comms going out or the day after, the share of the
    demand that arrives on them, and such a day against one of the launch's
    quiet days after the announce. Means over the launches that ran the comms
    and had at least 5 units of the demand; the multiple is the median."""
    col = {c: i for i, c in enumerate(P.VALUE_COLS)}
    kinds = {"all comms": (list(col), None), "email": (P.EMAIL_COLS, "email"),
             "aa_social": (["pl_aa_post", "pl_aa_story", "pl_aa_social_other"], "aa_social"),
             "artist": (["pl_artist_post", "pl_artist_story", "pl_artist_other"], "artist"), "partner": (["pl_partner"], "referrals"),
             "all comms on direct": (list(col), "direct"), "all comms on search": (list(col), "search")}
    out = {}
    for label, (cols, group) in kinds.items():
        rows = []
        for d in panel.values():
            on = d["X"][:, [col[c] for c in cols]].sum(axis=1) > 0
            y = d["y"] if group is None else d["G"][group]
            if not on.any() or y.sum() < 5:
                continue
            near = on | np.r_[False, on[:-1]]
            quiet = (~near) & (d["t"] >= 0)
            rows.append({"days_on": on.mean(), "days_near": near.mean(), "demand_on": y[on].sum() / y.sum(), "demand_near": y[near].sum() / y.sum(),
                         "lift": (y[on].mean() / y[quiet].mean()) if quiet.sum() >= 3 and y[quiet].mean() > 0 else np.nan})
        if len(rows) >= 8:
            r = pd.DataFrame(rows)
            out[label] = {"launches": int(len(r)), "days_on": float(r["days_on"].mean()), "days_near": float(r["days_near"].mean()),
                          "demand_on": float(r["demand_on"].mean()), "demand_near": float(r["demand_near"].mean()), "lift": float(r["lift"].median())}
    return out


def miss(pred, actual) -> float:
    return float(np.expm1(np.median(np.abs(np.log(np.asarray(pred, dtype=float) / np.asarray(actual, dtype=float))))))


def main() -> None:
    at = build.load_across_time()
    as_of, _, _ = build.observation_clock(at["event_date"].max())
    aud, comms, campaigns = P.load_audiences(), P.load_comms(), P.load_campaigns()
    if aud.empty or comms.empty:
        raise SystemExit("the feeds are missing: run node server/emailAudiences.js --write and node server/commsPlan.js --write first")
    rng = np.random.RandomState(SEED)

    # ---- the click model
    S = sends_table(at, as_of, aud, campaigns)
    y_click = np.log(S["clicked"] / S["delivered"]).to_numpy()
    coef = ridge(click_design(S), y_click)
    s_launches = S["launch"].unique()
    clicks = click_backtest(S, np.array_split(rng.permutation(s_launches), FOLDS))
    print(f"data through {as_of}; {len(S)} launch emails on {len(s_launches)} launches")
    print("\na send's clicks, predicted before it goes (its launch left out of the fit):")
    for label, r in [("every send", clicks["all"]), ("sends after a launch's first day", clicks["after_first_day"])] + [("  " + k, v) for k, v in clicks["by_kind"].items()]:
        print(f"  {label:34s} n={r['n']:3d}  kind, size and timing: typical miss {r['miss']:4.0%}, within 30% {r['within30']:4.0%}"
              f"  |  with the launch's earlier sends: {r['miss_with_launch']:4.0%}, within 30% {r['within30_with_launch']:4.0%}")

    # ---- the price list, on every launch
    reliability = P.plan_reliability(comms, as_of)
    panel = build_panel(at, as_of, aud, comms, campaigns, coef)
    names = sorted(panel)
    th_all = fit_prices(panel, names)
    prices = as_prices(th_all)
    usual = usual_table(panel, names, th_all)
    print(f"\n{len(names)} draw launches with emails and a plan on file, {sum(len(d['t']) for d in panel.values())} launch-days")
    print(f"the price list, in quiet days (an ordinary day after the announce with nothing going out = 1), over a piece's day and the days it is still felt "
          f"(an email {NE} more, a post {NP}):")
    for c in P.VALUE_COLS:
        unit = f"per {P.CLICKS_REF:.0f} expected clicks" if c.startswith("em_") else "each"
        print(f"  {c:20s} {P.action_value(c, 1.0, prices):6.2f}  {unit}")
    print("  an email fades to " + ", ".join(f"x{x:.2f}" for x in prices["fade_email"]) + " on the days after; a post to " + ", ".join(f"x{x:.2f}" for x in prices["fade_posts"])
          + f"; the close day adds {prices['close_day']:.1f} and the day before {prices['day_before']:.1f}; a day before the announce is {prices['pre']:.2f}")
    base_share = [float(b.sum() / (b.sum() + a.sum())) for b, a in (parts(panel[n], th_all) for n in names)]
    print(f"  with nothing going out (the baseline): {np.median(base_share):.0%} of a launch's demand outside paid, the median launch")

    history = history_checks(panel)
    print("\ndoes demand follow what goes out? (days with the comms going out or the day after -> the share of the demand that arrives on them)")
    for label, h in history.items():
        what = "demand outside paid" if label == "all comms" else "its own channel's demand" if " on " not in label else label.split(" on ")[1] + "'s demand"
        print(f"  {label:22s} {h['launches']:3d} launches  {h['days_near']:4.0%} of days -> {h['demand_near']:4.0%} of {what}; such a day against a quiet one x{h['lift']:.1f}")

    # ---- the back-test: every launch from the others
    folds = np.array_split(rng.permutation(names), FOLDS)
    rec, sse_clock, sse_plan, sst = [], 0.0, 0.0, 0.0
    for fold in folds:
        train = [n for n in names if n not in set(fold)]
        th = fit_prices(panel, train, th_all)
        pr = as_prices(th)
        pr["usual"] = usual_table(panel, train, th)
        curve = np.median(np.vstack([curve_of(panel[n]) for n in train]), axis=0)
        for n in fold:
            d = panel[n]
            t, L, y = d["t"], d["L"], d["y"]
            Y = y.sum()
            m_run = mu(d, th)
            share_clock = np.diff(np.r_[0.0, np.interp(t / L, GRID, curve)])
            share_clock = share_clock / share_clock.sum()
            sse_clock += float(((y / Y - share_clock) ** 2).sum()); sse_plan += float(((y / Y - m_run / m_run.sum()) ** 2).sum())
            sst += float(((y / Y - 1.0 / len(y)) ** 2).sum())
            for label, frac in CUTS:
                tc = 2 if frac is None else int(round(frac * L))
                seen = float(y[t <= tc].sum())
                if tc >= L or seen < 5:
                    continue
                w = float(np.interp(tc / L, GRID, curve))
                clock = seen / max(w, 1e-6)
                cut_day = d["announce"] + pd.Timedelta(days=tc)
                dd = dict(d, X=planned_X(d, coef, cut_day, reliability))
                ratio = ratio_at(mu(dd, th), t, tc)
                row = {"launch": n, "cut": label, "final": Y, "seen": seen, "clock": clock,
                       "plan": seen * (1.0 + ratio) if ratio is not None else clock}
                us = P.usual_ratio(pr, tc / L)
                row["against_usual"] = (ratio / us) if ratio and us else None
                for g in GAMMAS:
                    row[f"anchored_{g}"] = P.anchored(seen, clock - seen, ratio, us, g)["forecast"]
                rec.append(row)
    R = pd.DataFrame(rec)
    R["to_come"] = R["final"] - R["seen"]
    table = {}
    print(f"\nday-to-day pattern of demand explained, each launch from the others: clock {1 - sse_clock / sst:.0%}, plan {1 - sse_plan / sst:.0%}")
    print("\nthe final demand outside paid, forecast from each point (typical miss either way; then on what was still to come):")
    print(f"  {'cut':24s} {'n':>3s}  {'clock':>12s}  {'plan alone':>12s}  " + "  ".join(f"{'anchored ' + str(g):>13s}" for g in GAMMAS[1:]))
    for label, _ in CUTS:
        g = R[R["cut"] == label]
        ok = g["to_come"] >= 3
        row = {"n": int(len(g))}
        for col in ["clock", "plan"] + [f"anchored_{x}" for x in GAMMAS]:
            row[col] = {"final": miss(g[col], g["final"]),
                        "to_come": miss((g[col] - g["seen"]).clip(lower=0.5)[ok], g["to_come"].clip(lower=0.5)[ok])}
        table[label] = row
        print(f"  {label:24s} {len(g):3d}  " + "  ".join(f"{row[c]['final']:5.0%} | {row[c]['to_come']:4.0%}" for c in ["clock", "plan"] + [f"anchored_{x}" for x in GAMMAS[1:]]))
    # the strength kept: the one whose neighbourhood on the grid misses least on what was still to come from a
    # quarter of the way in, as the cost curve's slope is kept (etl/paid_cost.py): the medians of 66 launches
    # jump about from one strength to the next, and a single best reading would be chasing that
    later = [c for c, f in CUTS if f is not None]
    score = {g: float(np.mean([table[c][f"anchored_{g}"]["to_come"] for c in later])) for g in GAMMAS}
    near = {g: float(np.mean([score[h] for h in GAMMAS[max(i - 1, 0):i + 2]])) for i, g in enumerate(GAMMAS)}
    gamma = min(GAMMAS, key=lambda g: (round(near[g], 4), g))
    print("  strength kept: " + str(gamma) + "  (mean miss on what was still to come from 25% on: " + ", ".join(f"{g}: {s:.0%}" for g, s in score.items())
          + "; with its neighbours: " + ", ".join(f"{g}: {s:.1%}" for g, s in near.items()) + ")")
    # when the plan left is lighter or heavier than usual, where did the launch land against the clock?
    Q = R[R["cut"].isin(later[:3]) & R["against_usual"].notna() & (R["to_come"] >= 3)].copy()
    Q["came_over_clock"] = Q["to_come"].clip(lower=0.5) / (Q["clock"] - Q["seen"]).clip(lower=0.5)
    light, heavy, mid = Q[Q["against_usual"] < 0.8], Q[Q["against_usual"] > 1.25], Q[(Q["against_usual"] >= 0.8) & (Q["against_usual"] <= 1.25)]
    lean = {"lighter": {"n": int(len(light)), "came_over_clock": float(light["came_over_clock"].median())},
            "usual": {"n": int(len(mid)), "came_over_clock": float(mid["came_over_clock"].median())},
            "heavier": {"n": int(len(heavy)), "came_over_clock": float(heavy["came_over_clock"].median())}}
    print(f"\nreads at 25, 50 and 75%: remaining plan under 0.8 of the usual ({lean['lighter']['n']}): what came was x{lean['lighter']['came_over_clock']:.2f} the clock's figure; "
          f"within 0.8 to 1.25 ({lean['usual']['n']}): x{lean['usual']['came_over_clock']:.2f}; over 1.25 ({lean['heavier']['n']}): x{lean['heavier']['came_over_clock']:.2f}")

    prices.update({"baseline_share": round(float(np.median(base_share)), 4), "split": quiet_split(panel), "quiet": quiet_sizes(panel, th_all),
                   "usual_audience": {k: float(v) for k, v in S.groupby("kind")["delivered"].median().items()},
                   "asOf": str(as_of), "launches": len(names), "launchDays": int(sum(len(d["t"]) for d in panel.values())),
                   "usual": usual, "gamma": gamma, "reliability": {k: round(v, 3) for k, v in sorted(reliability.items())},
                   "clicks": {"names": P.CLICK_NAMES, "coef": [float(c) for c in coef], "spread": clicks["spread"], "sends": int(len(S)),
                              "launches": int(len(s_launches)), "pull_weight": 1.0},
                   "note": "etl/analysis/plan_backtest.py; demand outside paid; quiet day = an ordinary day after the announce with nothing going out"})
    PRICES_OUT.write_text(json.dumps(prices, indent=1) + "\n")
    BACKTEST_OUT.write_text(json.dumps({
        "asOf": str(as_of), "launches": len(names), "names": names,
        "pattern": {"clock": round(1 - sse_clock / sst, 3), "plan": round(1 - sse_plan / sst, 3)},
        "cuts": table, "gamma": gamma, "gamma_scores": {str(g): round(s, 4) for g, s in score.items()},
        "against_usual": lean, "history": history, "clicks": {k: v for k, v in clicks.items() if k != "spread"},
        "note": "typical miss = the median of |log(forecast / actual)| as a share; each launch predicted from the others (12 folds); "
                "the clock is the pooled median curve of the share of demand reached by each point between announce and close"}, indent=1) + "\n")
    print(f"\nwrote {PRICES_OUT.relative_to(ROOT)} and {BACKTEST_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
