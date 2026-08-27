#!/usr/bin/env python3
"""Build the per-release dashboard snapshots (data/app/…) from the source feeds.

Implements docs/DATA_MODEL.md exactly:
  §3 LE target model (unit splits -> channel targets -> entries -> sessions -> budget)
  §5 across-time target curves (pooled pdsa trajectories from the daily funnel export)
  §6 actuals (fan-out-safe aggregation, untracked redistribution, projected sell-through)
  §7 paid in-flight model (adjusted CPE, party ROI, budget-to-sell-out, recommendation + cap)
  §8 email/social funnel rungs
  §9 module map (hero, trajectory, channels, funnel contributions, waterfall)

Inputs:
  sources/across_time.csv           daily funnel export (channel x day x release + campaign clock)
  data/spend_daily.csv              Meta spend by campaign x day (etl/extract_spend.py)
  data/content_posts.csv            Emplifi posts by campaign (etl/extract_content.py)
  sources/all_sent_emails.csv       Klaviyo sends
  sources/draw_*.csv                draw entry exports (PII is stripped here; never committed)
  etl/release_inputs.json           hand-entered launch inputs per release
  etl/benchmarks.json               frozen benchmark values (docs §4)

Outputs:
  data/app/index.json               sidebar index (all releases + status)
  data/app/curves.json              pooled trajectory curves
  data/app/releases/<id>.json       one snapshot document per release (what the UI reads)
"""
from __future__ import annotations

import csv
import json
import math
import pathlib
from collections import defaultdict
from datetime import date, datetime, timedelta

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources"
DATA = ROOT / "data"
APP = DATA / "app"

BENCH = json.loads((ROOT / "etl" / "benchmarks.json").read_text())
INPUTS = json.loads((ROOT / "etl" / "release_inputs.json").read_text())

# Target inputs saved from the dashboard's Target setting tab live in
# data/app/inputs.json (the server rewrites it on save). When the live refresh
# reruns this ETL in-process, those edits must win over the repo defaults.
_live_inputs = APP / "inputs.json"
if _live_inputs.exists():
    try:
        _saved = json.loads(_live_inputs.read_text()).get("releases", {})
        INPUTS["releases"] = [_saved.get(r["id"], r) for r in INPUTS["releases"]]
    except (ValueError, KeyError) as e:
        print(f"warning: ignoring saved inputs overlay: {e}")

ORGANIC_CHANNELS = list(INPUTS["channel_quality_default"].keys())

# Display grouping (docs §1.3). AA Other goes to search/direct/other (the sheet dropped it).
DISPLAY_GROUPS = {
    "aa_email": {"name": "AA Email", "channels": ["AA Email Auto", "AA Email Man"]},
    "aa_social": {"name": "AA Meta", "channels": ["AA Meta", "AA X"]},
    "referral_artist": {"name": "Referral artist", "channels": ["Referral Artist"]},
    "search_direct_other": {
        "name": "Search / direct / other",
        "channels": ["Direct", "Organic Search", "Other", "AA Other",
                     "Referral Meta", "Referral Other", "Referral X"],
    },
    "paid": {"name": "Paid", "channels": ["Paid Social", "Paid Search"]},
}
GROUP_OF = {c: g for g, spec in DISPLAY_GROUPS.items() for c in spec["channels"]}

CURVE_GRID = [round(-0.6 + 0.05 * i, 2) for i in range(int((1.15 + 0.6) / 0.05) + 1)]


# ---------------------------------------------------------------- loading

def load_across_time() -> pd.DataFrame:
    df = pd.read_csv(SOURCES / "across_time.csv")
    df = df.rename(columns={"AA_session_custom_channel_group_split_touch": "channel"})
    df["event_date"] = pd.to_datetime(df["event_date"], format="%d/%m/%Y").dt.date
    # normalise channel case (feed says 'untracked')
    df.loc[df["channel"].str.lower() == "untracked", "channel"] = "Untracked"
    df = df[df["simple_release_name"].notna()]
    keys = ["channel", "event_date", "simple_release_name"]
    clock = ["days_since_announcement", "days_until_launch",
             "pct_days_since_announcement", "pct_days_until_launch"]
    metric_cols = [c for c in df.select_dtypes(include="number").columns
                   if c not in clock and c not in keys]
    # fan-out pairs (two campaign-date sub-records) -> SUM, keep first clock values (docs §6.1)
    agg = {c: "sum" for c in metric_cols}
    for c in ["campaign_stage"] + clock:
        agg[c] = "first"
    df = (df.groupby(["channel", "event_date", "simple_release_name"], as_index=False)
            .agg(agg))
    return df


def load_spend() -> pd.DataFrame:
    df = pd.read_csv(DATA / "spend_daily.csv")
    df["spend_date"] = pd.to_datetime(df["spend_date"]).dt.date
    return df


def load_emails() -> pd.DataFrame:
    # Klaviyo aggregates are not in the live sheet; run without them if absent
    if not (SOURCES / "all_sent_emails.csv").exists():
        print("warning: sources/all_sent_emails.csv missing — email panels will be empty")
        return pd.DataFrame({
            "name": pd.Series(dtype=str), "sent_at": pd.Series(dtype="datetime64[ns]"),
            "campaign": pd.Series(dtype=str), "delivered": pd.Series(dtype=float),
            "opened": pd.Series(dtype=float), "clicked": pd.Series(dtype=float),
            "unsubscribed": pd.Series(dtype=float), "email_type": pd.Series(dtype=str),
        })
    df = pd.read_csv(SOURCES / "all_sent_emails.csv")
    df = df.rename(columns={
        "Email Name": "name", "Send Date (Your time zone)": "sent_at",
        "Campaign": "campaign", "Delivered": "delivered", "Opened": "opened",
        "Clicked": "clicked", "Unsubscribed": "unsubscribed"})
    df["sent_at"] = pd.to_datetime(df["sent_at"])
    def email_type(n):
        for t in ("GEN", "CUS", "INS", "TRNS", "AUT", "FREQ", "TEST"):
            if f"_{t}_" in n or n.startswith(f"{t}_"):
                return t
        return "OTHER"
    df["email_type"] = df["name"].map(email_type)
    return df


def load_content() -> pd.DataFrame:
    df = pd.read_csv(DATA / "content_posts.csv")
    df["Date"] = pd.to_datetime(df["Date"])
    return df


# ---------------------------------------------------------------- target model (docs §3)

def quality_for(release: dict, channel: str) -> str:
    return release.get("channel_quality_overrides", {}).get(
        channel, INPUTS["channel_quality_default"][channel])


def compute_targets(release: dict) -> dict:
    b = BENCH
    size = release["edition_size"]
    paid_pct = b["paid_share_of_units"][
        {"Small": "Low", "Medium": "Medium", "Large": "High",
         "Low": "Low", "High": "High"}[release["paid_channel_size"]]]
    paid_units = round(size * paid_pct)
    organic_units = size - paid_units
    pr_pct = b["pv_other_share_of_units"][release["reference_point"]]
    pr_units = organic_units * pr_pct
    draw_units = organic_units - pr_units

    shares = {}
    for c in ORGANIC_CHANNELS:
        q = quality_for(release, c)
        shares[c] = 0.0 if q == "N/A" else b["order_split"][c][q]
    total_share = sum(shares.values())
    split = {c: (s / total_share if total_share else 0.0) for c, s in shares.items()}

    e2o = b["eligible_entry_to_order"]
    per_channel = {}
    for c in ORGANIC_CHANNELS:
        q = quality_for(release, c)
        purchases = draw_units * split[c]
        entries = purchases / e2o
        conv = b["session_to_eligible_entry"][c][q] if q != "N/A" else 0.0
        sessions = entries / conv if conv else 0.0
        per_channel[c] = {
            "quality": q, "order_split": split[c], "purchases": purchases,
            "eligible_entries": entries, "sessions": sessions, "session_to_entry": conv,
        }

    pr_sessions = pr_units / b["email_session_to_purchase"]

    paid_conv = b["paid_session_to_eligible_entry"][release["paid_conv_quality"]]
    paid_entries = paid_units / e2o
    paid_sessions = paid_entries / paid_conv
    cpp = b["cost_per_purchase"][release["cpp_pick"]]
    budget = cpp * paid_units
    launch_value = size * release["unit_price"]

    return {
        "edition_size": size,
        "paid_pct": paid_pct, "paid_units": paid_units,
        "organic_units": organic_units,
        "pr_other_pct": pr_pct, "pr_units": pr_units, "draw_units": draw_units,
        "per_channel": per_channel,
        "pr_sessions": pr_sessions,
        "paid": {
            "units": paid_units, "eligible_entries": paid_entries,
            "sessions": paid_sessions, "session_to_entry": paid_conv,
            "cost_per_purchase": cpp, "budget": budget,
            "budget_pct_of_launch_value": budget / launch_value if launch_value else None,
            "sense_check_breached": (budget / launch_value) > b["budget_sense_check_max_pct_of_launch_value"] if launch_value else False,
        },
        "launch_value": launch_value,
        "organic_sessions_draw": sum(pc["sessions"] for pc in per_channel.values()),
        "total_sessions": sum(pc["sessions"] for pc in per_channel.values()) + pr_sessions + paid_sessions,
        "buffer": b["target_buffer"],
    }


def group_targets(targets: dict) -> dict:
    """Roll per-channel targets up to display groups.

    `units` is the secured-units target (draw/pre-order purchases per channel;
    private-room units ride with AA Email per the workbook convention — the
    template models all PR purchases through the email channel; paid = paid
    units). Group unit targets sum exactly to the edition size (sellout).
    """
    out = {}
    for g, spec in DISPLAY_GROUPS.items():
        if g == "paid":
            out[g] = {"entries": targets["paid"]["eligible_entries"],
                      "purchases": targets["paid"]["units"],
                      "units": float(targets["paid"]["units"]),
                      "sessions": targets["paid"]["sessions"]}
        else:
            chans = [c for c in spec["channels"] if c in targets["per_channel"]]
            purchases = sum(targets["per_channel"][c]["purchases"] for c in chans)
            out[g] = {
                "entries": sum(targets["per_channel"][c]["eligible_entries"] for c in chans),
                "purchases": purchases,
                "units": purchases + (targets["pr_units"] if g == "aa_email" else 0.0),
                "sessions": sum(targets["per_channel"][c]["sessions"] for c in chans),
            }
    return out


# ---------------------------------------------------------------- curves (docs §5)

CLEAN_EXCLUDE_STAGES = {"Missing campaign dates", "Outside campaign window"}


def pdsa_for(release: dict, d: date) -> float:
    a = date.fromisoformat(release["announce_date"])
    e = date.fromisoformat(release["launch_end"])
    L = (e - a).days
    return (d - a).days / L if L else 0.0


def build_curves(at: pd.DataFrame) -> dict:
    df = at[~at["campaign_stage"].isin(CLEAN_EXCLUDE_STAGES)].copy()
    df = df[df["pct_days_since_announcement"].notna()]
    first_export_date = at["event_date"].min()

    # per release x day totals (all channels) and per display group
    df["group"] = df["channel"].map(GROUP_OF)
    metrics = {"sessions": "Sessions_Total",
               "entries": "Draw_Entries_Eligible_Units",
               "units": "Total_Product_Units"}

    day = (df.groupby(["simple_release_name", "event_date"], as_index=False)
             .agg(pdsa=("pct_days_since_announcement", "first"),
                  **{k: (v, "sum") for k, v in metrics.items()}))

    # clean completed releases: window start captured, launch passed, not cut by export edge
    rel_stats = day.groupby("simple_release_name").agg(
        pdsa_min=("pdsa", "min"), pdsa_max=("pdsa", "max"),
        d_min=("event_date", "min"), entries=("entries", "sum"))
    clean = rel_stats[(rel_stats.pdsa_min <= 0) & (rel_stats.pdsa_max >= 1.0)
                      & (rel_stats.d_min > first_export_date) & (rel_stats.entries >= 20)].index

    def curve_from(frame: pd.DataFrame, value_col: str, releases) -> list[float] | None:
        shares = []
        for r in releases:
            sub = frame[frame["simple_release_name"] == r].sort_values("pdsa")
            total = sub[value_col].sum()
            if total < 10:
                continue
            cum = sub[value_col].cumsum() / total
            row = []
            for t in CURVE_GRID:
                sel = cum[sub["pdsa"] <= t]
                row.append(float(sel.iloc[-1]) if len(sel) else 0.0)
            shares.append(row)
        if len(shares) < 4:
            return None
        arr = pd.DataFrame(shares)
        med = arr.median().tolist()
        # enforce monotone, end at 1
        for i in range(1, len(med)):
            med[i] = max(med[i], med[i - 1])
        top = med[-1] or 1.0
        return [round(min(v / top, 1.0), 4) for v in med]

    curves = {"grid": CURVE_GRID, "n_releases": int(len(clean)), "all": {}, "groups": {}}
    for m in metrics:
        curves["all"][m] = curve_from(day, m, clean)

    gday = (df.groupby(["simple_release_name", "group", "event_date"], as_index=False)
              .agg(pdsa=("pct_days_since_announcement", "first"),
                   **{k: (v, "sum") for k, v in metrics.items()}))
    for g in DISPLAY_GROUPS:
        sub = gday[gday["group"] == g]
        curves["groups"][g] = {}
        for m in metrics:
            c = curve_from(sub, m, clean)
            curves["groups"][g][m] = c  # may be None -> UI/build falls back to all
    # p25/p75 band for the all-entries curve (status guardrails)
    return curves


def curve_value(curves: dict, group: str | None, metric: str, pdsa: float) -> float:
    series = None
    if group:
        series = curves["groups"].get(group, {}).get(metric)
    if series is None:
        series = curves["all"][metric]
    grid = curves["grid"]
    if pdsa <= grid[0]:
        return 0.0
    if pdsa >= grid[-1]:
        return 1.0
    for i in range(1, len(grid)):
        if pdsa <= grid[i]:
            w = (pdsa - grid[i - 1]) / (grid[i] - grid[i - 1])
            return series[i - 1] + w * (series[i] - series[i - 1])
    return 1.0


# ---------------------------------------------------------------- draws (docs §2)

def load_draw(release: dict) -> dict | None:
    fname = release.get("draw_entries_file")
    if not fname or not (SOURCES / fname).exists():
        return None
    products = [p["name"] for p in release.get("products", [])]
    per_product = defaultdict(int)
    tiers = defaultdict(int)
    total = eligible = framed = preorder = wanted_units = surplus = 0
    with (SOURCES / fname).open() as f:
        for row in csv.DictReader(f):
            total += 1
            ok = not (row.get("Exclusion") or row.get("Removal") or row.get("Processing Error"))
            if not ok:
                continue
            eligible += 1
            tiers[row.get("Tier") or "N/A"] += 1
            if row.get("Framed") == "Yes":
                framed += 1
            if row.get("PreOrder") == "Yes":
                preorder += 1
            entered = [p for p in products if p in (row.get("Remaining Eligible Entries") or "")]
            for p in entered:
                per_product[p] += 1
            mq = row.get("MaxQuantity")
            cap = len(entered) if mq in (None, "", "N/A") else min(int(mq), len(entered))
            wanted_units += cap
            surplus += max(len(entered) - cap, 0)
    return {
        "entrants": total, "eligible": eligible,
        "tier_mix": dict(tiers),
        "framed_share": round(framed / eligible, 4) if eligible else None,
        "preorder_share": round(preorder / eligible, 4) if eligible else None,
        "units_demanded": wanted_units,
        "surplus_entries": surplus,
        "per_product": [{"name": p, "entries": per_product.get(p, 0)} for p in products],
    }


# ---------------------------------------------------------------- per-release snapshot

def daterange(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def build_release(release: dict, at: pd.DataFrame, spend: pd.DataFrame,
                  emails: pd.DataFrame, content: pd.DataFrame, curves: dict,
                  as_of: date) -> dict:
    b = BENCH
    name = release["release_name"]
    announce = date.fromisoformat(release["announce_date"])
    launch_end = date.fromisoformat(release["launch_end"])
    pr_open = date.fromisoformat(release["private_room_open"])
    L = (launch_end - announce).days

    targets = compute_targets(release)
    gtargets = group_targets(targets)

    rat = at[at["simple_release_name"] == name].copy()
    rat["group"] = rat["channel"].map(GROUP_OF)
    window_start = min(pr_open, announce)
    win = rat[(rat["event_date"] >= window_start) & (rat["event_date"] <= min(as_of, launch_end + timedelta(days=2)))]

    # untracked redistribution for cumulative channel actuals (docs §1.3)
    def redistribute(series: dict[str, float]) -> dict[str, float]:
        untracked = series.pop("Untracked", 0.0)
        tracked_sum = sum(series.values())
        if tracked_sum <= 0:
            return series
        return {c: v + untracked * v / tracked_sum for c, v in series.items()}

    # daily series per display group: actual cumulative entries + plan
    days = list(daterange(window_start, launch_end))
    day_idx = min((as_of - announce).days, (launch_end - announce).days)
    complete = as_of >= launch_end

    by_group_day = (win.groupby(["group", "event_date"])
                    .agg(sessions=("Sessions_Total", "sum"),
                         entries=("Draw_Entries_Eligible_Units", "sum"),
                         entries_no_conv=("Draw_Entries_Total_Units_No_Conv", "sum"),
                         units=("Total_Product_Units", "sum"),
                         pr_units=("Product_Units_Private_Room", "sum"))
                    .reset_index())

    # ---- paid actuals + forward model, computed first: the paid channel's projection
    # is projected spend ÷ projected cost-per-entry, not a trajectory curve (docs §5.4)
    camp = release.get("campaign_name")
    psp = spend[spend["campaign_name"] == camp] if camp else spend.iloc[0:0]
    psp = psp[(psp["spend_date"] >= window_start) & (psp["spend_date"] <= min(as_of, launch_end))]
    paid_entries_day = (win[win["channel"] == "Paid Social"]
                        .groupby("event_date")["Draw_Entries_Eligible_Units"].sum())
    spend_day = psp.groupby("spend_date")["spend"].sum()
    drop, cann = b["paid_drop_off"], b["cannibalisation"]
    ppu_aa = release["aa_group_profit"] / release["edition_size"] + (
        b["frame_conversion"] * b["frame_profit_per_unit"] if release["framing_available"] else 0)
    ppu_artist = (release["artist_profit"] / release["edition_size"]) if release["edition_size"] else 0
    aa_budget_share = 1.0 if release["artist_profit_share"] == 0 else 0.5

    paid_daily = []
    cum_spend = cum_pentries = 0.0
    for d in days:
        if d > min(as_of, launch_end):
            break
        s = float(spend_day.get(d, 0.0))
        e = float(paid_entries_day.get(d, 0.0))
        cum_spend += s; cum_pentries += e
        adj_cpe = s / (e * (1 - drop)) if e else None
        roi = ((1 - cann) * ppu_aa / (adj_cpe * aa_budget_share)) if adj_cpe else None
        paid_daily.append({"date": d.isoformat(), "spend": round(s, 2), "entries": e,
                           "roi": round(roi, 3) if roi else None})
    # trailing 3-day CPE over days with entries (adjusted = per expected-converting unit)
    recent = [(r["spend"], r["entries"]) for r in paid_daily if r["entries"] > 0][-3:]
    l3d_raw_cpe = (sum(s for s, _ in recent) / sum(e for _, e in recent)) if recent else None
    l3d_cpe = l3d_raw_cpe / (1 - drop) if l3d_raw_cpe else None
    cum_adj_cpe = cum_spend / (cum_pentries * (1 - drop)) if cum_pentries else None
    cum_roi = ((1 - cann) * ppu_aa / (cum_adj_cpe * aa_budget_share)) if cum_adj_cpe else None
    l3d_roi = ((1 - cann) * ppu_aa / (l3d_cpe * aa_budget_share)) if l3d_cpe else None

    forecast_cpe = l3d_cpe * b["cpe_growth_factor"] if l3d_cpe else None
    final_day_roi = ((1 - cann) * ppu_aa / (forecast_cpe * aa_budget_share)) if forecast_cpe else None

    units_sold = float(win["Total_Product_Units"].sum())
    entries_banked = float(win["Draw_Entries_Total_Units_No_Conv"].sum())
    inventory_left = max(release["edition_size"] - units_sold, 0)
    entries_needed = max(inventory_left * (1 + drop) - entries_banked, 0)
    days_left = max((launch_end - as_of).days, 0)
    supply_spend = (entries_needed * forecast_cpe / days_left) if (forecast_cpe and days_left) else 0.0
    # ROI floor: max spend/day keeping final-day ROI >= floor
    cpe_max = (1 - cann) * ppu_aa / (b["roi_floor"] * aa_budget_share)
    if forecast_cpe and forecast_cpe > cpe_max and supply_spend:
        roi_spend = supply_spend * (cpe_max / forecast_cpe)
    else:
        roi_spend = math.inf
    recommended = min(supply_spend, roi_spend) if days_left else 0.0
    cap = "supply" if supply_spend <= roi_spend else "roi_floor"
    current_daily = float(spend_day.get(as_of, spend_day.iloc[-1] if len(spend_day) else 0.0))

    drift = b["spend_rules"]["cpe_daily_drift_by_third"]
    third = min(int(max(pdsa_for(release, as_of), 0) * 3), 2)
    daily_factor = round(1 / (1 + drift[third]), 4)

    # forward path: projected spend ÷ projected cost-per-entry per future day.
    # Projections describe the CURRENT trajectory (spend run-rate as-is); the
    # recommended budget is the intervention shown alongside, not the projection.
    # Efficiency decays by the launch-window-third drift tiers (5%/7%/10% per day).
    planned_spend = current_daily if current_daily > 0 else (
        recommended if (days_left and recommended not in (0.0, math.inf)) else 0.0)
    paid_future = {}          # date -> cumulative projected entries beyond today
    future_cum = 0.0
    cpe_fwd = l3d_raw_cpe
    if not complete:
        prev_curve = curve_value(curves, "paid", "entries", pdsa_for(release, as_of))
        for d in daterange(as_of + timedelta(days=1), launch_end):
            if cpe_fwd and planned_spend:
                t3 = min(int(max(pdsa_for(release, d), 0) * 3), 2)
                cpe_fwd = cpe_fwd * (1 + drift[t3])
                future_cum += planned_spend / cpe_fwd
            else:
                # no spend history yet: fall back to the paid target trajectory
                cv = curve_value(curves, "paid", "entries", pdsa_for(release, d))
                future_cum += gtargets["paid"]["entries"] * max(cv - prev_curve, 0.0)
                prev_curve = cv
            paid_future[d] = future_cum

    channels_out = []
    hero_now = hero_exp = hero_target = hero_proj = 0.0
    funnel_by_group = {}
    e2o = b["eligible_entry_to_order"]
    for g, spec in DISPLAY_GROUPS.items():
        sub = by_group_day[by_group_day["group"] == g].set_index("event_date")
        # SECURED UNITS — the unified page currency (docs §6.4):
        #   secured = units sold (all routes) + 0.8 x eligible entry units not yet
        #   converted. Group unit targets sum to the edition size (sellout).
        tgt = gtargets[g]["units"]
        sess_tgt = gtargets[g]["sessions"]
        daily = []
        cum_u = cum_nc = cum_s = 0.0
        for d in days:
            row = sub.loc[d] if d in sub.index else None
            cum_u += float(row["units"]) if row is not None else 0.0
            cum_nc += float(row["entries_no_conv"]) if row is not None else 0.0
            cum_s += float(row["sessions"]) if row is not None else 0.0
            p = pdsa_for(release, d)
            plan = tgt * curve_value(curves, g, "units", p)
            daily.append({"date": d.isoformat(),
                          "actual": round(cum_u + e2o * cum_nc, 2) if d <= as_of else None,
                          "plan": round(plan, 2), "proj": None})
        pdsa_today = pdsa_for(release, min(as_of, launch_end))
        w = curve_value(curves, g, "units", pdsa_today)   # share of campaign observed, per historic shape
        exp = tgt * w
        sess_exp = sess_tgt * curve_value(curves, g, "sessions", pdsa_today)
        now = next((r["actual"] for r in reversed(daily) if r["actual"] is not None), 0.0)
        # Forward projection (docs §5.4): the remaining volume follows this channel's
        # HISTORIC shape curve; its level scales with demonstrated performance
        # (actual/expected), trusted in proportion to how much of the campaign the
        # curve says we have observed. Paid instead projects spend ÷ efficiency
        # (future entries convert to units at 0.8).
        if complete:
            proj = now
        elif g == "paid":
            proj = now + future_cum * e2o
            for d, cum_f in paid_future.items():
                i = (d - window_start).days
                if 0 <= i < len(daily):
                    daily[i]["proj"] = round(now + cum_f * e2o, 2)
        else:
            r_perf = min(max((now / exp) if exp > 0 else 1.0, 0.25), 2.5)
            r_shrunk = 1 + w * (r_perf - 1)
            proj = now + tgt * (1 - w) * r_shrunk
            for d in daterange(as_of + timedelta(days=1), launch_end):
                i = (d - window_start).days
                cv = curve_value(curves, g, "units", pdsa_for(release, d))
                frac = (cv - w) / (1 - w) if w < 1 else 1.0
                if 0 <= i < len(daily):
                    daily[i]["proj"] = round(now + (proj - now) * max(min(frac, 1.0), 0.0), 2)
        # two-factor decomposition: traffic + conversion = gap (docs §9)
        conv_exp = (exp / sess_exp) if sess_exp else 0.0
        conv_act = (now / cum_s) if cum_s else 0.0
        traffic = (cum_s - sess_exp) * conv_exp
        conversion = (conv_act - conv_exp) * cum_s
        funnel_by_group[g] = {
            "sessions_actual": round(cum_s, 1), "sessions_expected": round(sess_exp, 1),
            "conv_actual": conv_act, "conv_expected": conv_exp,
            "contrib_traffic": round(traffic, 1), "contrib_conversion": round(conversion, 1),
        }
        channels_out.append({
            "key": g, "name": spec["name"],
            "now": round(now, 1), "exp": round(exp, 1),
            "proj": round(proj, 1), "target": round(tgt, 1),
            "daily": daily,
        })
        hero_now += now; hero_exp += exp; hero_target += tgt; hero_proj += proj

    # ---- paid block output (docs §7; inputs computed above, before the channel loop)
    paid_out = {
        "daily": paid_daily,
        "spendToDate": round(cum_spend, 2),
        "entriesToDate": cum_pentries,
        "cumRoi": round(cum_roi, 3) if cum_roi else None,
        "l3dRoi": round(l3d_roi, 3) if l3d_roi else None,
        "l3dCpe": round(l3d_cpe, 2) if l3d_cpe else None,
        "cumCpe": round(cum_adj_cpe, 2) if cum_adj_cpe else None,
        "roiDeclineModel": {"start": round(l3d_roi, 3) if l3d_roi else None,
                            "dailyFactor": daily_factor},
        "roiTarget": b["target_roi_aa"],
        "budget": {
            "current": round(current_daily, 2),
            "recommended": round(recommended, 2) if recommended != math.inf else None,
            "cap": cap, "finalDayRoi": round(final_day_roi, 3) if final_day_roi else None,
            "floor": b["roi_floor"],
            "budgetToSellOut": round(entries_needed * forecast_cpe, 2) if forecast_cpe else None,
            "entriesNeeded": round(entries_needed, 1),
            "daysLeft": days_left,
        },
        "unitTarget": targets["paid"]["units"],
        "entriesProjected": round(cum_pentries + future_cum, 1),
        "unitProjected": round((cum_pentries + future_cum) * (1 - drop), 1),
        "spendBudget": round(targets["paid"]["budget"], 2),
        "spendProjectedTotal": round(cum_spend + (planned_spend or 0) * days_left, 2),
        "profitPerUnitAA": round(ppu_aa, 2),
        "profitPerUnitArtist": round(ppu_artist, 2),
        "aaBudgetShare": aa_budget_share,
    }

    # ---- email funnel (docs §8): launch-window customer sends for this campaign
    em = emails[(emails["campaign"] == release["campaign_code"])
                & (emails["sent_at"].dt.date >= window_start)
                & (emails["sent_at"].dt.date <= min(as_of, launch_end))
                & (emails["email_type"].isin(["GEN", "CUS", "INS"]))]
    email_out = {
        "sends": int(len(em)),
        "delivered": int(em["delivered"].sum()),
        "opened": int(em["opened"].sum()),
        "clicked": int(em["clicked"].sum()),
        "openRate": round(em["opened"].sum() / em["delivered"].sum(), 4) if em["delivered"].sum() else None,
        "clickRate": round(em["clicked"].sum() / em["delivered"].sum(), 4) if em["delivered"].sum() else None,
        "sequence": [
            {"name": r["name"].split(" - ", 1)[-1], "date": r["sent_at"].date().isoformat(),
             "delivered": int(r["delivered"]), "opened": int(r["opened"]), "clicked": int(r["clicked"])}
            for _, r in em.sort_values("sent_at").iterrows()
        ],
    }

    # ---- social content
    ct = content[(content["campaign_code"] == release["campaign_code"])
                 & (content["Date"].dt.date >= window_start)
                 & (content["Date"].dt.date <= min(as_of, launch_end))]
    posts = ct[ct["Content type"].isin(["post", "collaboration", "reply", "shared"])]
    social_out = {
        "posts": int(len(posts)), "stories": int((ct["Content type"] == "story").sum()),
        "impressions": int(pd.to_numeric(ct["Total impressions"], errors="coerce").fillna(0).sum()),
        "engagements": int(pd.to_numeric(ct["Engagements"], errors="coerce").fillna(0).sum()),
    }

    # ---- sell-through (release level; per-product editions not in feeds yet)
    unconverted = float(win["Draw_Entries_Total_Units_No_Conv"].sum())
    sold_predicted = unconverted * b["eligible_entry_to_order"]
    pdsa_today = pdsa_for(release, min(as_of, launch_end))
    # units still to come = the shaped secured-units projection beyond today (docs §5.4/§6.4)
    future_entries = 0.0 if complete else max(hero_proj - hero_now, 0.0)
    sellthrough = {
        "edition": release["edition_size"],
        "sold": round(units_sold, 0),
        "soldPredicted": round(min(sold_predicted, inventory_left), 1),
        "futureEntriesPredicted": round(min(future_entries, max(inventory_left - sold_predicted, 0)), 1),
    }
    sellthrough["pct"] = round(min((sellthrough["sold"] + sellthrough["soldPredicted"]
                                    + sellthrough["futureEntriesPredicted"]) / release["edition_size"], 1.0), 4)

    # ---- waterfall (docs §9): contributors to projection - target, in secured units
    organic_groups = [g for g in DISPLAY_GROUPS if g != "paid"]
    wf_traffic = sum(funnel_by_group[g]["contrib_traffic"] for g in organic_groups)
    wf_conv = sum(funnel_by_group[g]["contrib_conversion"] for g in organic_groups)
    spend_planned_to_date = targets["paid"]["budget"] * curve_value(curves, "paid", "units", pdsa_today)
    wf_paid_spend = ((cum_spend - spend_planned_to_date) / targets["paid"]["cost_per_purchase"]
                     ) if targets["paid"]["cost_per_purchase"] else 0.0
    paid_gap = funnel_by_group["paid"]["contrib_traffic"] + funnel_by_group["paid"]["contrib_conversion"]
    wf_paid_eff = paid_gap - wf_paid_spend
    # scale contributor gaps (to-date) to close: same blend factor as projections
    scale = ((hero_proj - hero_target) / (wf_traffic + wf_conv + wf_paid_spend + wf_paid_eff)
             if (wf_traffic + wf_conv + wf_paid_spend + wf_paid_eff) else 0.0)
    waterfall = {
        "target": round(hero_target, 0), "projection": round(hero_proj, 0),
        "steps": [
            {"key": "organic_traffic", "label": "Organic traffic", "value": round(wf_traffic * scale, 0)},
            {"key": "organic_conversion", "label": "Organic conversion", "value": round(wf_conv * scale, 0)},
            {"key": "paid_spend", "label": "Paid spend", "value": round(wf_paid_spend * scale, 0)},
            {"key": "paid_efficiency", "label": "Paid efficiency", "value": round(wf_paid_eff * scale, 0)},
        ],
    }
    # force exact reconciliation (rounding residual goes to the largest step)
    resid = round(hero_proj - hero_target, 0) - sum(s["value"] for s in waterfall["steps"])
    if waterfall["steps"]:
        biggest = max(waterfall["steps"], key=lambda s: abs(s["value"]))
        biggest["value"] += resid

    draw = load_draw(release)

    day_n = max(min((as_of - announce).days, L), 0)
    edition = float(release["edition_size"])
    status_pct = (min(hero_now, edition) - hero_exp) / hero_exp if hero_exp else 0.0
    snap = {
        "id": release["id"],
        "releaseName": name,
        "artist": name.split(" · ")[0], "title": name.split(" · ")[1],
        "type": "LE",
        "campaignCode": release["campaign_code"], "campaignName": camp,
        "marketingLead": release["marketing_lead"],
        "privateRoomOpen": release["private_room_open"],
        "windowStart": release["announce_date"], "windowEnd": release["launch_end"],
        "campaignLengthDays": L, "day": day_n, "of": L,
        "asOf": as_of.isoformat(), "complete": complete,
        "economics": {
            "unitPrice": release["unit_price"], "launchValue": targets["launch_value"],
            "artistProfitPerUnit": round(ppu_artist, 2), "aaProfitPerUnit": round(ppu_aa, 2),
            "artistProfitShare": release["artist_profit_share"],
        },
        "currency": "units",
        "hero": {
            "now": round(min(hero_now, edition), 0), "expectedToday": round(hero_exp, 0),
            "delta": round(min(hero_now, edition) - hero_exp, 0),
            "projected": round(min(hero_proj, edition), 0), "target": round(hero_target, 0),
            "oversubscribedUnits": round(max(max(hero_now, hero_proj) - edition, 0), 0),
            "statusPct": round(status_pct, 4), "ok": status_pct >= -0.1,
        },
        "targets": targets, "groupTargets": gtargets,
        "channels": channels_out,
        "funnelByGroup": funnel_by_group,
        "paid": paid_out,
        "email": email_out,
        "social": social_out,
        "sellthrough": sellthrough,
        "draw": draw,
        "geo": None,  # country dim not in any feed yet (docs §12)
        "waterfall": waterfall,
        "benchmarks": {
            "chargeDropOff": 1 - b["eligible_entry_to_order"],
            "cannibalisation": b["cannibalisation"],
            "targetBuffer": b["target_buffer"],
        },
    }
    return snap


# ---------------------------------------------------------------- main

def main():
    at = load_across_time()
    as_of = at["event_date"].max() - timedelta(days=1)  # last full day (export cut mid-day)
    spend = load_spend()
    emails = load_emails()
    content = load_content()

    APP.mkdir(parents=True, exist_ok=True)
    (APP / "releases").mkdir(exist_ok=True)

    curves = build_curves(at)
    (APP / "curves.json").write_text(json.dumps(curves, indent=1))
    print(f"curves: n={curves['n_releases']} clean releases")

    index = []
    for release in INPUTS["releases"]:
        snap = build_release(release, at, spend, emails, content, curves, as_of)
        (APP / "releases" / f"{release['id']}.json").write_text(json.dumps(snap, indent=1))
        index.append({
            "id": snap["id"], "name": f"{snap['artist']} — {snap['title']}",
            "releaseName": snap["releaseName"], "type": snap["type"],
            "day": snap["day"], "of": snap["of"], "complete": snap["complete"],
            "statusPct": snap["hero"]["statusPct"], "ok": snap["hero"]["ok"],
        })
        print(f"{snap['id']}: day {snap['day']}/{snap['of']} "
              f"now={snap['hero']['now']} exp={snap['hero']['expectedToday']} "
              f"target={snap['hero']['target']} proj={snap['hero']['projected']}")
    (APP / "index.json").write_text(json.dumps(
        {"asOf": as_of.isoformat(), "releases": index}, indent=1))
    # inputs document for the Target setting tab (server + web read this);
    # meta_campaigns feeds the Meta-campaign matcher (most recently active first)
    camp = (spend.groupby("campaign_name")
                 .agg(spend=("spend", "sum"), last=("spend_date", "max"))
                 .reset_index()
                 .sort_values(["last", "spend"], ascending=False))
    (APP / "inputs.json").write_text(json.dumps({
        "benchmarks": BENCH,
        "channel_quality_default": INPUTS["channel_quality_default"],
        "releases": {r["id"]: r for r in INPUTS["releases"]},
        "meta_campaigns": [
            {"name": r.campaign_name, "spend": round(float(r.spend), 2), "last": r.last.isoformat()}
            for r in camp.itertuples()
        ],
    }, indent=1))
    print(f"wrote {len(index)} releases -> {APP}")


if __name__ == "__main__":
    main()
