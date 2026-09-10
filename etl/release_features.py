"""Release-level features from the daily funnel export, one row per release.

Streams sources/across_time.csv in chunks (constant memory on the 512 MB
instance) and writes data/app/release_features.csv: scale (sessions, page
views, entries, units, customers), units by route, channel mix of sessions,
timing shape (days active, peak-day share, days to half the sessions), the
campaign clock where present (implied announce date, campaign length, close),
the campaign code the ETL inferred, and the launch-window email programme
(sends, delivered, opened, clicked) when both a code and dates exist.

Served by GET /api/funnel/releases.csv for analysis outside the dashboard -
the basket-of-comparables work needs the whole history, and this is the
whole history in a few hundred rows.
"""
import json, pathlib, re, sys
from collections import Counter
from datetime import timedelta
import pandas as pd, numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "sources" / "across_time.csv"
OUT = ROOT / "data" / "app" / "release_features.csv"
INPUTS = ROOT / "data" / "app" / "inputs.json"
EMAILS = ROOT / "sources" / "all_sent_emails.csv"
PR_LEAD_DAYS = 14

GROUPS = {"AA Email Auto": "aa_email", "AA Email Man": "aa_email", "AA Meta": "aa_social", "AA X": "aa_social",
          "Referral Artist": "referral_artist", "Paid Social": "paid", "Paid Search": "paid"}
SUMS = ["Sessions_Total", "Page_Views_Total", "Draw_Entries", "Preorder_App", "Draw_Entry_Eligible",
        "Draw_Entries_Eligible_Units", "Draw_Entry_Eligible_No_Conv", "Total_Product_Units", "Product_Units_Draw",
        "Product_Units_Preorder_App", "Product_Units_Private_Room", "Product_Units_Presale_Offered",
        "Product_Units_Other", "Unique_Customers", "Customer_Private_Room"]
USE = ["AA_session_custom_channel_group_split_touch", "event_date", "simple_release_name",
       "days_since_announcement", "pct_days_since_announcement"] + SUMS


def main():
    tot, daily, mix, clock = {}, {}, {}, {}
    for chunk in pd.read_csv(SRC, usecols=lambda c: c in USE, chunksize=100_000, low_memory=False):
        chunk["event_date"] = pd.to_datetime(chunk["event_date"], format="%d/%m/%Y", errors="coerce")
        chunk = chunk[chunk["event_date"].notna() & chunk["simple_release_name"].notna()]
        chunk["group"] = chunk["AA_session_custom_channel_group_split_touch"].map(lambda c: GROUPS.get(str(c).strip(), "sdo"))
        for name, g in chunk.groupby("simple_release_name", sort=False):
            t = tot.setdefault(name, dict.fromkeys(SUMS, 0.0))
            s = g[SUMS].sum()
            for k in SUMS: t[k] += float(s[k])
            d = daily.setdefault(name, Counter()); d.update(g.groupby("event_date")["Sessions_Total"].sum().to_dict())
            m = mix.setdefault(name, Counter()); m.update(g.groupby("group")["Sessions_Total"].sum().to_dict())
            c = g[g["days_since_announcement"].notna()]
            if len(c):
                cl = clock.setdefault(name, {"announce": Counter(), "L": []})
                cl["announce"].update((c["event_date"] - pd.to_timedelta(c["days_since_announcement"], unit="D")).dt.date.tolist())
                ok = c[(c["pct_days_since_announcement"].abs() > 0.05) & (c["days_since_announcement"] != 0)]
                cl["L"] += (ok["days_since_announcement"] / ok["pct_days_since_announcement"]).round().tolist()
    codes = {}
    try:
        doc = json.loads(INPUTS.read_text())
        for r in list(doc.get("discovered", {}).values()) + list(doc.get("releases", {}).values()):
            if r.get("release_name") and r.get("campaign_code"): codes[r["release_name"]] = r["campaign_code"]
    except Exception as e:
        print(f"warning: no codes ({e})", file=sys.stderr)
    emails = None
    if EMAILS.exists():
        emails = pd.read_csv(EMAILS).rename(columns={"Send Date (Your time zone)": "sent_at", "Campaign": "campaign"})
        emails["sent_at"] = pd.to_datetime(emails["sent_at"], errors="coerce")
        emails["kind"] = emails["Email Name"].astype(str).str.extract(r"_(GEN|CUS|INS|TRNS|AUT|FREQ|TEST)_")[0].fillna("OTHER")
        emails = emails[~emails["kind"].isin(["TRNS", "AUT", "FREQ", "TEST"])]

    rows = []
    for name, t in tot.items():
        d = daily[name]; days = sorted(d); total = sum(d.values())
        cum, half = 0.0, None
        for i, k in enumerate(days):
            cum += d[k]
            if half is None and cum >= total / 2: half = i + 1
        parts = name.split(" · ")
        yq = re.search(r"(\d{4}) Q(\d)", name)
        row = {"release_name": name, "artist": parts[0], "title": parts[1] if len(parts) > 2 else "",
               "year": int(yq.group(1)) if yq else None, "quarter": f"{yq.group(1)} Q{yq.group(2)}" if yq else None,
               "first_seen": days[0].date().isoformat(), "last_seen": days[-1].date().isoformat(),
               "days_active": (days[-1] - days[0]).days + 1, "peak_day_share": (max(d.values()) / total) if total else None,
               "days_to_half_sessions": half}
        row.update({k.lower(): round(v, 1) for k, v in t.items()})
        m = mix[name]; ms = sum(m.values()) or np.nan
        for k in ["aa_email", "paid", "sdo", "aa_social", "referral_artist"]: row[f"session_share_{k}"] = round(m.get(k, 0) / ms, 4) if ms == ms else None
        u = t["Total_Product_Units"]
        row["oversubscription"] = round(t["Draw_Entries_Eligible_Units"] / u, 3) if u else None
        row["units_per_session"] = round(u / t["Sessions_Total"], 5) if t["Sessions_Total"] else None
        row["private_room_share"] = round(t["Product_Units_Private_Room"] / u, 3) if u else None
        cl = clock.get(name)
        row["announce_date"] = row["campaign_days"] = row["close_date"] = None
        if cl and cl["announce"]:
            ann = cl["announce"].most_common(1)[0][0]; row["announce_date"] = ann.isoformat()
            if cl["L"]:
                L = int(np.median(cl["L"]))
                if 3 <= L <= 90: row["campaign_days"] = L; row["close_date"] = (ann + timedelta(days=L)).isoformat()
        code = codes.get(name); row["campaign_code"] = code
        row["email_sends"] = row["email_delivered"] = row["email_opened"] = row["email_clicked"] = None
        if emails is not None and code and row["close_date"]:
            lo = pd.Timestamp(row["announce_date"]) - pd.Timedelta(days=PR_LEAD_DAYS); hi = pd.Timestamp(row["close_date"]) + pd.Timedelta(days=1)
            em = emails[(emails["campaign"] == code) & (emails["sent_at"] >= lo) & (emails["sent_at"] < hi)]
            if len(em):
                row.update(email_sends=int(len(em)), email_delivered=int(em["Delivered"].sum()), email_opened=int(em["Opened"].sum()), email_clicked=int(em["Clicked"].sum()))
        rows.append(row)
    out = pd.DataFrame(rows).sort_values(["year", "sessions_total"], ascending=[False, False])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp"); out.to_csv(tmp, index=False); tmp.replace(OUT)
    n_clock = int(out["announce_date"].notna().sum()); n_code = int(out["campaign_code"].notna().sum()); n_em = int(out["email_sends"].notna().sum())
    print(f"release_features: {len(out)} releases, {n_clock} with announce dates, {n_code} with codes, {n_em} with launch emails -> {OUT}")


if __name__ == "__main__":
    main()
