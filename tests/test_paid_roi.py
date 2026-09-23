#!/usr/bin/env python3
"""The party ROI (docs 7) end to end on a synthetic funnel frame: the artist's
figures on the paid block are AA's read with the artist's profit per unit and
share of the spend, day by day and along the forward path, and are None
throughout on a deal where the artist carries no spend.
python3 tests/test_paid_roi.py (needs pandas)"""
import sys, json, pathlib, random, copy
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
base["campaign_name"] = "Synthetic · Enter draw"
base["campaign_names"] = [base["campaign_name"]]
announce, launch = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
pr_open = date.fromisoformat(base["private_room_open"])
name = base["release_name"]
TODAY = announce + timedelta(days=12)
CH = [("AA Email Man", 300, 1.2), ("AA Meta", 120, 0.4), ("Referral Artist", 20, 0.1), ("Direct", 200, 0.8),
      ("Organic Search", 80, 0.2), ("Paid Social", 250, 0.6), ("Untracked", 30, 0.1)]

def frame(through):
    rows, rnd, d = [], random.Random(7), min(pr_open, announce)
    LL = (launch - announce).days
    while d <= through:
        dsa, dul = (d - announce).days, (launch - d).days
        for ch, sess, ent in CH:
            s, e = sess * (1 + 0.1 * rnd.random()), ent
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                         "Sessions_Total": s, "Total_Product_Units": e * 0.3, "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": e * 0.7, "Draw_Entries_Eligible_Units": e,
                         "days_since_announcement": dsa, "days_until_launch": dul,
                         "pct_days_since_announcement": dsa / LL, "pct_days_until_launch": dul / LL})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend_frame(through):
    rows, d = [], announce
    while d <= through:
        rows.append({"campaign_name": base["campaign_name"], "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 500.0})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

emails, content, people = build.load_emails(), build.load_content(), build.load_people()
artist_posts = build.load_artist_posts()
panel = baskets.load_panel()
curves = json.loads((ROOT / "data/app/curves.json").read_text())

def run(cfg):
    at = frame(TODAY)
    snap = build.build_release(cfg, at, spend_frame(TODAY), emails, content, curves, TODAY,
                               artist_posts, {}, None, panel, people, full_through=TODAY, seen=1.0)
    build.check_snapshot(snap)
    return snap

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)

def close(a, b, tol=0.02):
    return a is not None and b is not None and abs(a - b) <= tol * max(abs(b), 1e-9)

# a profit-share deal: the artist carries the other half of the spend
S = run(copy.deepcopy(base))
paid = S["paid"]
art = paid["artist"]
ppu_aa, ppu_artist, share_aa = paid["profitPerUnitAA"], paid["profitPerUnitArtist"], paid["aaBudgetShare"]
check(art is not None and art["budgetShare"] == round(1 - share_aa, 4), f"artist share is the rest of the spend: {art}")
check(art["profitPerUnit"] == ppu_artist and ppu_artist > 0, f"artist profit per unit published: {art['profitPerUnit']} vs {ppu_artist}")
ratio = (ppu_artist / ppu_aa) * (share_aa / art["budgetShare"])
check(close(art["cumRoi"], paid["cumRoi"] * ratio), f"cumulative: {art['cumRoi']} vs {paid['cumRoi']} x {ratio:.4f}")
check(close(art["l3dRoi"], paid["l3dRoi"] * ratio), f"last 3 days: {art['l3dRoi']} vs {paid['l3dRoi']} x {ratio:.4f}")
check(close(art["finalDayRoi"], paid["budget"]["finalDayRoi"] * ratio), "at close, at the recommended spend")
check(close(art["roiDeclineModel"]["start"], art["l3dRoi"]) and art["roiDeclineModel"]["dailyFactor"] == paid["roiDeclineModel"]["dailyFactor"],
      "the artist's decline model starts at the artist's L3D on the same factor")
rows = [r for r in paid["daily"] if r["roi"] is not None]
check(len(rows) > 3 and all(close(r["roiArtist"], r["roi"] * ratio) for r in rows), "every day's artist ROI is AA's in the party ratio")
check(all(r["roiArtist"] is None for r in paid["daily"] if r["roi"] is None), "no AA reading, no artist reading")
check(len(art["roiPath"]) == len(paid["roiPath"]) > 0
      and all(a["date"] == b["date"] and close(a["roi"], b["roi"] * ratio) for a, b in zip(art["roiPath"], paid["roiPath"])),
      "the artist's forward path is AA's path in the party ratio")
check(paid["cannibalisation"] == build.BENCH["cannibalisation"] and paid["dropOff"] == build.BENCH["paid_drop_off"], "the terms travel with the block")
# the working the card shows: profit per unit net of cannibalisation over the cost of a converting entry and the share
check(close(paid["l3dRoi"], (1 - paid["cannibalisation"]) * ppu_aa / (paid["l3dCpe"] * share_aa)), "AA's L3D is the published working")
check(close(art["l3dRoi"], (1 - paid["cannibalisation"]) * ppu_artist / (paid["l3dCpe"] * art["budgetShare"])), "the artist's L3D is the same working")
print(f"profit share: AA {paid['cumRoi']} artist {art['cumRoi']} (ratio {ratio:.3f}); shares AA {share_aa} artist {art['budgetShare']}")

# a revenue-share deal: AA carries the ads, the artist has no ROI to read
cfg = copy.deepcopy(base)
cfg["legacy_economics"]["artist_profit_share"] = 0
R = run(cfg)
paid, art = R["paid"], R["paid"]["artist"]
check(paid["aaBudgetShare"] == 1.0 and art["budgetShare"] == 0.0, f"revenue share: AA carries the spend {paid['aaBudgetShare']} / {art['budgetShare']}")
check(art["cumRoi"] is None and art["l3dRoi"] is None and art["finalDayRoi"] is None and art["roiPath"] == [] and art["roiDeclineModel"]["start"] is None,
      f"no artist ROI on a revenue share: {art}")
check(all(r["roiArtist"] is None for r in paid["daily"]) and any(r["roi"] is not None for r in paid["daily"]), "AA's days still read, the artist's do not")
print(f"revenue share: AA {paid['cumRoi']} artist {art['cumRoi']}")

print("FAILED" if failed else "ok: party ROI", failed if failed else "")
sys.exit(1 if failed else 0)
