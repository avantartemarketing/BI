#!/usr/bin/env python3
"""The email references a release is read against (docs 8), and the sends it
counts as its own.

- The rate cohort leaves out the release's own sends and the launches that
  closed after it: a closed release is never graded against itself (seven
  closed releases were), and a live one reads the whole cohort.
- An email window never reaches back into an earlier launch by the same
  artist: sends join a release by campaign code alone, and Zeng Fanzhi's LE
  counted two sends of the artist's July Rainbow launch that carried its code.
python3 tests/test_email_refs.py (needs pandas)"""
import sys, json, pathlib, random
from datetime import date, datetime, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)

AS_OF = date(2026, 9, 24)
def release(rid, artist, code, pr, ann, end):
    return {"id": rid, "release_name": f"{artist} · Multiple · 2026 Q3", "campaign_code": code,
            "private_room_open": pr, "announce_date": ann, "launch_end": end}
# five closed launches and one live, each sending at its own open rate
CFG = [release("a_le_26", "Artist A", "ArtistA_LE_26", "2026-04-28", "2026-05-01", "2026-05-20"),
       release("b_le_26", "Artist B", "ArtistB_LE_26", "2026-05-28", "2026-06-01", "2026-06-20"),
       release("c_le_26", "Artist C", "ArtistC_LE_26", "2026-06-28", "2026-07-01", "2026-07-20"),
       release("d_le_26", "Artist D", "ArtistD_LE_26", "2026-07-28", "2026-08-01", "2026-08-20"),
       release("e_le_26", "Artist E", "ArtistE_LE_26", "2026-09-10", "2026-09-12", "2026-10-10")]
DISC = [{"id": "artist_f_multiple_2026_q2", "release_name": "Artist F · Multiple · 2026 Q2", "campaign_code": "ArtistF_LE_26",
         "announce_date": "2026-06-01", "launch_end": "2026-06-10"},
        # the discovered twin of a configured release: another id, the same code
        {"id": "artist_b_multiple_2026_q2", "release_name": "Artist B · Multiple · 2026 Q2", "campaign_code": "ArtistB_LE_26",
         "announce_date": "2026-06-01", "launch_end": "2026-06-20"}]
OPEN = {"ArtistA_LE_26": 0.10, "ArtistB_LE_26": 0.20, "ArtistC_LE_26": 0.30, "ArtistD_LE_26": 0.40,
        "ArtistE_LE_26": 0.50, "ArtistF_LE_26": 0.15}
rows = []
for r in CFG + DISC[:1]:
    ann = date.fromisoformat(r["announce_date"])
    for i, day in enumerate((ann, ann + timedelta(days=3))):
        rows.append({"name": f"{day:%d%m%y}_CUS_{r['campaign_code']} - Send {i}", "sent_at": pd.Timestamp(day) + pd.Timedelta(hours=9),
                     "campaign": r["campaign_code"], "delivered": 1000.0, "opened": 1000.0 * OPEN[r["campaign_code"]],
                     "clicked": 100.0, "unsubscribed": 1.0, "email_type": "CUS"})
emails = pd.DataFrame(rows)
spend = pd.DataFrame([{"campaign_name": "ArtistF_LE_26 · Enter draw", "spend_date": date(2026, 6, 2), "impressions": 1,
                       "reach": 1, "link_clicks": 1, "spend": 10.0}])

keep = build.INPUTS["releases"]
build.INPUTS["releases"] = CFG
try:
    bench = build.email_delivered_benchmark(emails, AS_OF, DISC, spend, None)
    check(bench["cohort"]["n"] == 5 and sorted(bench["cohort"]["releases"]) == sorted(["a_le_26", "b_le_26", "c_le_26", "d_le_26", "artist_f_multiple_2026_q2"]),
          f"the run's cohort: every closed launch with sends, the twin once: {bench['cohort']}")
    check(abs(bench["open_rate"] - 0.20) < 1e-9, f"the run's median open rate: {bench['open_rate']}")
    # a closed release: itself and the launches that closed after it left out
    b = build.email_bench_for(bench, CFG[1])
    check(b["cohort"]["n"] == 2 and sorted(b["cohort"]["releases"]) == ["a_le_26", "artist_f_multiple_2026_q2"]
          and abs(b["open_rate"] - 0.125) < 1e-9,
          f"B reads A and F only, the launches closed by its own close: {b['cohort']} open {b['open_rate']}")
    d = build.email_bench_for(bench, CFG[3])
    check(d["cohort"]["n"] == 4 and "d_le_26" not in d["cohort"]["releases"] and abs(d["open_rate"] - 0.175) < 1e-9,
          f"D reads everything else: {d['cohort']} open {d['open_rate']}")
    check(build.email_bench_for(bench, CFG[4]) is bench, "a live release reads the whole cohort")
    twin = build.email_bench_for(bench, dict(DISC[1]))
    check("b_le_26" not in twin["cohort"]["releases"], f"the discovered twin is left out by its code: {twin['cohort']}")
    refs = build.email_refs(b)
    check(refs["emailOpenRateRef"] == 12.5 and refs["emailRefCohort"]["n"] == 2, f"the page's references: {refs}")

    # ---- the same artist's earlier launch: its sends tagged with this code
    # are not this release's (Zeng Fanzhi: the Rainbow launch, 26 Jun to 22
    # Jul, then the LE, private room typed 29 Jun, announced 29 Jul)
    zed = release("zed_le_26", "Zed Artist", "ZedArtist_LE_26", "2026-06-29", "2026-07-29", "2026-08-26")
    rainbow = {"id": "zed_artist_rainbow_2026_q3", "release_name": "Zed Artist · Rainbow · 2026 Q3", "campaign_code": None,
               "announce_date": "2026-06-26", "launch_end": "2026-07-22"}
    zrows = [("2026-07-14", 115192, 5882, 360), ("2026-07-21", 3427, 1095, 175),          # the Rainbow's, mis-tagged
             ("2026-07-28", 8239, 1964, 996), ("2026-07-30", 23488, 3500, 409), ("2026-08-25", 33745, 10418, 527)]
    zmail = pd.DataFrame([{"name": f"x_CUS_ZedArtist_LE_26 - Send {i}", "sent_at": pd.Timestamp(d) + pd.Timedelta(hours=9),
                           "campaign": "ZedArtist_LE_26", "delivered": float(dv), "opened": float(o), "clicked": float(c),
                           "unsubscribed": 0.0, "email_type": "CUS"} for i, (d, dv, o, c) in enumerate(zrows)])
    launches = [{"name": rainbow["release_name"], "artist": "zed artist", "close": date(2026, 7, 22)}]
    check(build.email_window_start(zed, date(2026, 6, 29), launches) == date(2026, 7, 23),
          "the window opens the day after the artist's earlier launch closed")
    check(build.email_window_start(zed, date(2026, 7, 28), launches) == date(2026, 7, 28),
          "a window that already opens after it is left alone")
    check(build.email_window_start(dict(zed, release_name="Other Artist · Multiple · 2026 Q3"), date(2026, 6, 29), launches) == date(2026, 6, 29),
          "another artist's launch does not clip it")
    check(build.email_window_start(zed, date(2026, 6, 29), [{"name": zed["release_name"], "artist": "zed artist", "close": date(2026, 7, 22)}]) == date(2026, 6, 29),
          "a launch does not clip itself")
    check(build.email_window_start(zed, date(2026, 6, 29), [{"name": "Zed Artist · Later · 2026 Q4", "artist": "zed artist", "close": date(2026, 10, 1)}]) == date(2026, 6, 29),
          "a launch closing after this one's announce is not an earlier one")
    build.INPUTS["releases"] = [zed, CFG[0]]
    all_mail = pd.concat([emails, zmail], ignore_index=True)
    build.note_launches([])
    row_before = next(r for r in build.email_delivered_benchmark(all_mail, AS_OF, [], spend, None)["rows"] if r["id"] == "zed_le_26")
    build.note_launches([zed, rainbow])
    row_after = next(r for r in build.email_delivered_benchmark(all_mail, AS_OF, [], spend, None)["rows"] if r["id"] == "zed_le_26")
    check(row_before["total"] == 184091 and row_after["total"] == 65472,
          f"the cohort row counts the release's own sends: {row_before['total']} -> {row_after['total']}")
    check(abs(row_after["rate"][2] - 15882 / 65472) < 1e-12 and abs(row_after["rate"][4] - 1932 / 15882) < 1e-12,
          f"and their rates: open {row_after['rate'][2]:.4f}, clicks per open {row_after['rate'][4]:.4f}")

    # ---- the page's own email block, built with the same window
    name = zed["release_name"]
    cfg = dict(next(r for r in keep if r["id"] == "julianschnabel_le_26"))
    cfg.update(zed, campaign_name="Synthetic · Enter draw", campaign_names=["Synthetic · Enter draw"])
    rnd, frows, d = random.Random(5), [], date(2026, 6, 29)
    while d <= date(2026, 8, 26):
        for ch, sess, ent in (("AA Email Man", 300, 1.2), ("Direct", 200, 0.8), ("Paid Social", 250, 0.6)):
            frows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": "launch",
                          "Sessions_Total": sess * (1 + 0.1 * rnd.random()), "Total_Product_Units": ent * 0.3,
                          "Product_Units_Private_Room": 0.0, "Draw_Entries_Total_Units_No_Conv": ent * 0.7,
                          "Draw_Entries_Eligible_Units": ent, "days_since_announcement": (d - date(2026, 7, 29)).days,
                          "days_until_launch": (date(2026, 8, 26) - d).days, "pct_days_since_announcement": (d - date(2026, 7, 29)).days / 28,
                          "pct_days_until_launch": (date(2026, 8, 26) - d).days / 28})
        d += timedelta(days=1)
    sp = pd.DataFrame([{"campaign_name": "Synthetic · Enter draw", "spend_date": date(2026, 7, 30) + timedelta(days=i),
                        "impressions": 1000, "reach": 800, "link_clicks": 40, "spend": 500.0} for i in range(27)])
    snap = build.build_release(cfg, pd.DataFrame(frows), sp, all_mail, build.load_content(),
                               json.loads((ROOT / "data/app/curves.json").read_text()), AS_OF, build.load_artist_posts(),
                               {}, None, baskets.load_panel(), build.load_people())
    build.check_snapshot(snap)
    e = snap["email"]
    check(e["sends"] == 3 and e["delivered"] == 65472 and [s["date"] for s in e["sequence"]] == ["2026-07-28", "2026-07-30", "2026-08-25"],
          f"the page counts the LE's own sends: {e['sends']} sends, {e['delivered']} delivered, {[s['date'] for s in e['sequence']]}")
finally:
    build.INPUTS["releases"] = keep
    build.note_launches([])

# ---- Zeng Fanzhi on the committed feed: the LE's private room opens with
# its own early-access send, and the sends the pull re-tagged are the
# Rainbow launch's again
inputs = json.loads((ROOT / "etl/release_inputs.json").read_text())
zeng = next(r for r in inputs["releases"] if r["id"] == "zengfanzhi_le_26")
check(zeng["private_room_open"] == "2026-07-28", f"Zeng's private room opens with the LE's early access: {zeng['private_room_open']}")
app = json.loads((ROOT / "data/app/inputs.json").read_text())
check(app["releases"]["zengfanzhi_le_26"]["private_room_open"] == "2026-07-28", "and the app's copy of the inputs agrees")
feed = build.load_emails()
z = feed[feed["campaign"] == "ZengFanzhi_LE_26"]
z = z[(z["sent_at"].dt.date >= date(2026, 7, 28)) & (z["sent_at"].dt.date <= date(2026, 8, 26)) & z["email_type"].isin(["GEN", "CUS", "INS"])]
check(len(z) == 3 and int(z["delivered"].sum()) == 65472, f"Zeng's own sends on file: {len(z)} sends, {int(z['delivered'].sum())} delivered")
tl = feed[feed["name"].str.contains("_ZengFanzhi_TL_26 - ", regex=False) & (feed["sent_at"].dt.date <= date(2026, 7, 22))]
check(len(tl) == 8 and set(tl["campaign"]) == {"ZengFanzhi_TL_26"}, f"the Rainbow's sends carry its own code: {sorted(set(tl['campaign']))} on {len(tl)}")
print("FAILED" if failed else "ok: email references", failed if failed else "")
sys.exit(1 if failed else 0)
