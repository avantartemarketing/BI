#!/usr/bin/env python3
"""Edition pricing on the panel: the join from Airtable to the release list.

Why a module: the panel builder (etl/analysis/release_clusters.py) attaches
price, currency, edition size and launch value to every release it writes, and
the basket layer (etl/baskets.py) reads them off the panel. The join between
the two naming schemes is the part that can go wrong quietly, so it lives here
with a report that says, release by release, how each match was made.

The two sides
  * The panel and the dashboard name a release "Artist · Title · YYYY Qn", from
    the funnel export's simple_release_name. A third of them carry the title
    "Multiple": several works launched together, named after none of them.
  * Airtable's Pipeline table has one record per product: a colourway, a
    hand-finished variant, a bundle of two prints. A launch is the set of
    records sharing a release code (AlbersLE26) on one launch date. Bundles
    ("Set of 4", a diptych of two listed prints) carry the sum of their parts'
    prices and no edition size of their own, so they are left out of the
    aggregate: counting them would price the same print twice.

The match, strictest first, and never silent
  1. exact:          same artist and title, launch date agreeing with the
                     panel's window (or quarter, for a release without one)
  2. artist+window:  same artist, the launch date inside the campaign window
                     [announce - 45d, close + 30d]; the report prints how many
                     days it sits from the close (the announce, for a buy-now
                     launch, whose Airtable date is its launch day)
  3. artist+quarter: same artist, same quarter, for a release with no window
  4. fuzzy:          the artist's name close but not equal (Kukwon Woo against
                     Woo Kuk Won; Anni Albers under "Anni and Josef Albers"),
                     with the same date test; the similarity is printed and
                     nothing under FUZZY_MIN is used
  Two codes that pass the same test and launch within MERGE_DAYS of each other
  are one launch (Ai Weiwei's two works of 2024 Q4) and are merged; when they
  do not, the nearer wins and the report says which lost and by how many days.

What a matched release gets
  unit_price      value-weighted mean price over the launch's sized products,
                  in the currency Airtable holds (EUR today) - the price of the
                  average unit in the edition, not of the average product
  currency        that currency
  unit_price_gbp  unit_price converted at RATES_TO_GBP, a fixed table so the
                  panel does not move with the exchange rate; in log space a
                  fixed rate is a constant shift, so it changes no correlation
                  and no band, only the number printed
  edition_size    the sum of the sized products' units - the edition on offer,
                  which is not the panel's tot_total_product_units (units sold
                  inside the window)
  launch_value    unit_price x edition_size, and launch_value_gbp likewise
  plus the code, product count, price spread, launch and edition type, and
  price_match / price_match_score / price_match_days / price_note saying how
  the row was matched.

Run from the repo root for the full matching report:
  python3 etl/pricing.py
"""
from __future__ import annotations

import difflib
import json
import pathlib
import re
import sys
import unicodedata

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRICING_PATH = ROOT / "data" / "release_pricing.csv"
PANEL_PATH = ROOT / "data" / "release_clusters.csv"
INDEX_PATH = ROOT / "data" / "app" / "index.json"
INPUTS_PATH = ROOT / "data" / "app" / "inputs.json"

# Fixed rates to sterling, documented in docs/DATA_MODEL.md. Rounded 2024-2026
# averages; the point is a panel that does not move with the market, not a
# rate that is right today. Airtable prices in euros; the others are here so a
# record priced in another currency converts rather than failing.
RATES_TO_GBP = {"GBP": 1.0, "EUR": 0.85, "USD": 0.78}

WINDOW_BEFORE_DAYS = 45   # a launch date this far before the announce still belongs to the campaign (early access)
WINDOW_AFTER_DAYS = 30    # and this far after the close (a draw that ran past the clock)
MERGE_DAYS = 3            # codes launching within this of each other are one launch
FUZZY_MIN = 0.85          # artist-name similarity below this is listed, never used
FUZZY_SHOW = 0.6          # ... and below this it is not even listed
STOP_TOKENS = {"the", "estate", "foundation", "of", "and"}
BUNDLE_RE = re.compile(r"set of|\[|diptych|triptych", re.I)

PRICE_COLS = ["airtable_release", "airtable_ids", "n_products", "unit_price", "price_min", "price_max", "currency",
              "unit_price_gbp", "edition_size", "launch_value", "launch_value_gbp", "airtable_launch_date",
              "airtable_launch_type", "airtable_edition_type", "airtable_product_type", "price_status",
              "price_match", "price_match_score", "price_match_days", "price_note"]


# ---------------------------------------------------------------- names

def norm(text: object) -> str:
    """Accents, case, punctuation and spacing folded away: "Michaël" and
    "Michael", "F.U.C.K." and "FUCK", "Study for A, 1968" and "study for a 1968"."""
    s = unicodedata.normalize("NFKD", str(text if text is not None and not (isinstance(text, float) and np.isnan(text)) else ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).casefold().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(text: object) -> list[str]:
    return [t for t in norm(text).split() if t not in STOP_TOKENS]


def artist_key(text: object) -> str:
    """The artist without the words an estate or foundation adds: "The Andy
    Warhol Foundation" and "Andy Warhol Estate" are the same artist."""
    return " ".join(tokens(text))


def artist_similarity(a: str, b: str) -> float:
    """1.0 for the same tokens in any order or spacing ("kukwon woo" against
    "woo kuk won"), 1.0 when one name's tokens all sit inside the other's and
    there are at least two of them ("anni albers" inside "anni josef albers"),
    else the character similarity of the sorted tokens."""
    ta, tb = a.split(), b.split()
    if not ta or not tb:
        return 0.0
    sa, sb = set(ta), set(tb)
    small = min(len(sa), len(sb))
    if small >= 2 and (sa <= sb or sb <= sa):
        return 1.0
    return difflib.SequenceMatcher(None, "".join(sorted(ta)), "".join(sorted(tb))).ratio()


def quarter_of(day: pd.Timestamp) -> str:
    return f"{day.year} Q{(day.month - 1) // 3 + 1}" if pd.notna(day) else ""


# ---------------------------------------------------------------- the Airtable side

def load_pricing(path: pathlib.Path | str | None = None) -> pd.DataFrame:
    p = pathlib.Path(path) if path else PRICING_PATH
    df = pd.read_csv(p, low_memory=False)
    df["launch_date"] = pd.to_datetime(df["launch_date"], errors="coerce")
    for c in ("unit_price", "edition_size"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["artist_key"] = df["artist"].map(artist_key)
    df["title_key"] = df["title"].map(norm)
    df["bundle"] = df["title"].fillna("").str.contains(BUNDLE_RE) | ~(df["edition_size"] > 0)
    return df


def _worst_status(values: pd.Series) -> str:
    order = ["Confirmed", "Pending artist confirmation", "Pricing Target", "Initial estimate"]
    got = [v for v in values.dropna().astype(str) if v]
    if not got:
        return ""
    return max(got, key=lambda v: order.index(v) if v in order else len(order))


def _first_day(values: pd.Series | None):
    """The earliest date in a column, as a Timestamp, or NaT when there is none."""
    if values is None:
        return pd.NaT
    days = pd.to_datetime(values, errors="coerce").dropna()
    return days.min() if len(days) else pd.NaT


def _mode(values: pd.Series) -> str:
    got = values.dropna().astype(str)
    got = got[got != ""]
    return str(got.mode().iloc[0]) if len(got) else ""


def launches(records: pd.DataFrame) -> pd.DataFrame:
    """One row per launch: one artist's records sharing a release code on one
    launch date. The artist is part of the key because a group show puts eight
    artists' works under one code (MultipleAmphorae24), and the panel names
    each artist's release separately; the code is part of it because an artist
    can launch two editions on one day under two codes, and those merge later
    only if the panel treats them as one."""
    rec = records[records["launch_date"].notna()].copy()
    code = rec["release"].fillna("").astype(str).str.strip()
    day = rec["launch_date"].dt.strftime("%Y-%m-%d")
    rec["launch_key"] = np.where(code != "", code + "@" + day + "@" + rec["artist_key"], rec["artist_key"] + "@" + day)
    rows = []
    for key, g in rec.groupby("launch_key", sort=False):
        sized = g[~g["bundle"] & g["unit_price"].notna()]
        priced = g[g["unit_price"].notna()]
        if len(sized):
            size = float(sized["edition_size"].sum())
            value = float((sized["unit_price"] * sized["edition_size"]).sum())
            price = value / size if size > 0 else float("nan")
            pmin, pmax = float(sized["unit_price"].min()), float(sized["unit_price"].max())
        elif len(priced):
            # every product is a bundle or unsized: the mean price is all there is, and no size
            size, value, price = float("nan"), float("nan"), float(priced["unit_price"].mean())
            pmin, pmax = float(priced["unit_price"].min()), float(priced["unit_price"].max())
        else:
            size = value = price = pmin = pmax = float("nan")
        rows.append({
            "launch_key": key,
            "airtable_release": _mode(g["release"]) or "",
            "airtable_ids": "|".join(str(int(v)) for v in pd.to_numeric(g["airtable_id"], errors="coerce").dropna()),
            "artist_key": _mode(g["artist_key"]),
            "artist": _mode(g["artist"]),
            "title_keys": set(g["title_key"].dropna()) - {""},
            "titles": " / ".join(dict.fromkeys(g["title"].dropna().astype(str))),
            "n_products": int(len(g)),
            "n_bundles": int(g["bundle"].sum()),
            "unit_price": price, "price_min": pmin, "price_max": pmax,
            "currency": _mode(priced["currency"]) if len(priced) else "",
            "edition_size": size, "launch_value": value,
            "launch_date": g["launch_date"].min(),
            "quarter": quarter_of(g["launch_date"].min()),
            "launch_type": _mode(g["launch_type"]), "edition_type": _mode(g["edition_type"]),
            "product_type": _mode(g["product_type"]), "price_status": _worst_status(g["price_status"]),
            # the campaign's other dates and where the project stands, for a
            # launch the funnel has not seen yet (etl/build.py upcoming_releases)
            "announce_date": _first_day(g.get("announce_date")),
            "private_room_date": _first_day(g.get("private_room_date")),
            "project_status": _mode(g["project_status"]) if "project_status" in g.columns else "",
        })
    out = pd.DataFrame(rows)
    rate = out["currency"].map(RATES_TO_GBP)
    out["unit_price_gbp"] = out["unit_price"] * rate
    out["launch_value_gbp"] = out["launch_value"] * rate
    return out


# ---------------------------------------------------------------- the match

def _release_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """The columns the matcher needs off a panel-like frame: release_name,
    artist, title, quarter and, where known, announce, close and panel."""
    out = pd.DataFrame({
        "release_name": frame["release_name"].astype(str),
        "artist": frame["artist"].astype(str),
        "title": frame["title"].fillna("").astype(str),
        "quarter": frame["quarter"].fillna("").astype(str) if "quarter" in frame else "",
        "announce": pd.to_datetime(frame["announce"], errors="coerce") if "announce" in frame else pd.NaT,
        "close": pd.to_datetime(frame["close"], errors="coerce") if "close" in frame else pd.NaT,
        "panel": frame["panel"].fillna("").astype(str) if "panel" in frame else "",
    }, index=frame.index)
    out["artist_key"] = out["artist"].map(artist_key)
    out["title_key"] = out["title"].map(norm)
    return out


def _date_test(row: pd.Series, launch: pd.Series, named_quarter: bool = False) -> tuple[str, float | None]:
    """How a launch's date sits against the release: ("window", days from the
    reference date), ("quarter", None) or ("", None) for no agreement. The
    reference is the close for a draw (Airtable's launch date is the day the
    draw closes) and the announce for a buy-now launch (its launch day).

    A release without a window is tested on the quarter in its name. With
    `named_quarter` a dated release is too, when the window says no: an exact
    title in the right quarter outranks a window the panel inferred from the
    funnel, which for a buy-now launch can land on an early sales day."""
    ld = launch["launch_date"]
    if pd.notna(row["announce"]) and pd.notna(row["close"]):
        lo = row["announce"] - pd.Timedelta(days=WINDOW_BEFORE_DAYS)
        hi = row["close"] + pd.Timedelta(days=WINDOW_AFTER_DAYS)
        if lo <= ld <= hi:
            ref = row["announce"] if row["panel"] == "legacy" else row["close"]
            return "window", float(abs((ld - ref).days))
        if not named_quarter:
            return "", None
    if row["quarter"] and launch["quarter"] == row["quarter"]:
        return "quarter", None
    return "", None


def _pick(cands: list[tuple[pd.Series, str, float | None]]) -> tuple[list[pd.Series], str]:
    """The nearest candidate(s) by date: everything within MERGE_DAYS of the
    best is the same launch under several codes. Returns the chosen launches
    and a note naming what lost."""
    windowed = [c for c in cands if c[1] == "window"]
    if windowed:
        best = min(c[2] for c in windowed)
        chosen = [c for c in windowed if c[2] <= best + MERGE_DAYS]
        lost = [c for c in windowed if c[2] > best + MERGE_DAYS]
    else:
        chosen, lost = cands, []
    note = ""
    if len(chosen) > 1:
        note = f"{len(chosen)} codes merged as one launch: " + " + ".join(c[0]["airtable_release"] or c[0]["artist"] for c in chosen)
    if lost:
        note += ("; " if note else "") + "not " + ", ".join(
            f"{c[0]['airtable_release'] or c[0]['artist']} ({c[2]:.0f} days off)" for c in lost)
    return [c[0] for c in chosen], note


def _combine(chosen: list[pd.Series]) -> dict:
    """Several launches that are one launch: sizes and values add, the price is
    the value-weighted mean, the rest is the first's."""
    if len(chosen) == 1:
        return chosen[0].to_dict()
    frame = pd.DataFrame(chosen)
    out = chosen[0].to_dict()
    size = float(frame["edition_size"].sum(min_count=1))
    value = float(frame["launch_value"].sum(min_count=1))
    out.update({
        "airtable_release": "+".join(dict.fromkeys(str(v) for v in frame["airtable_release"] if v)),
        "airtable_ids": "|".join(str(v) for v in frame["airtable_ids"] if v),
        "titles": " / ".join(frame["titles"]), "n_products": int(frame["n_products"].sum()),
        "n_bundles": int(frame["n_bundles"].sum()),
        "edition_size": size, "launch_value": value,
        "unit_price": value / size if size > 0 else float(frame["unit_price"].mean()),
        "price_min": float(frame["price_min"].min()), "price_max": float(frame["price_max"].max()),
        "launch_date": frame["launch_date"].min(),
        "price_status": _worst_status(frame["price_status"]),
    })
    rate = RATES_TO_GBP.get(out.get("currency") or "", float("nan"))
    out["unit_price_gbp"] = out["unit_price"] * rate
    out["launch_value_gbp"] = out["launch_value"] * rate
    return out


def match(frame: pd.DataFrame, launch_frame: pd.DataFrame) -> pd.DataFrame:
    """One row per release in `frame`, index preserved: the PRICE_COLS of the
    launch it matched, or NaN with price_match "none"."""
    rel = _release_frame(frame)
    by_artist: dict[str, list[pd.Series]] = {}
    for _, l in launch_frame.iterrows():
        by_artist.setdefault(l["artist_key"], []).append(l)
    keys = list(by_artist)
    rows = []
    for idx, r in rel.iterrows():
        same = by_artist.get(r["artist_key"], [])
        tiers: list[tuple[str, list[tuple[pd.Series, str, float | None]], float]] = []
        titled = [l for l in same if r["title_key"] and r["title_key"] in l["title_keys"]]
        exact = [(l, *_date_test(r, l, named_quarter=True)) for l in titled]
        exact = [c for c in exact if c[1]]
        if exact:
            tiers.append(("exact", exact, 1.0))
        elif titled:
            # the work is on file under this artist, dated somewhere else: that
            # is a date to fix, not a licence to price the release off another
            # of the artist's works that happens to sit in the window
            pass
        else:
            near = [(l, *_date_test(r, l)) for l in same]
            near = [c for c in near if c[1]]
            if near:
                tiers.append(("artist", near, 1.0))
            else:
                # the artist's name is not written the same way on both sides:
                # every close name whose launch passes the date test is a
                # candidate, tagged with its similarity; the best decides and
                # the rest merge only if they are the same launch
                fuzzy = []
                for k in keys:
                    if k == r["artist_key"]:
                        continue
                    sim = artist_similarity(r["artist_key"], k)
                    if sim < FUZZY_SHOW:
                        continue
                    for l in by_artist[k]:
                        how, days = _date_test(r, l)
                        if how:
                            fuzzy.append((sim, (l, how, days)))
                if fuzzy:
                    best = max(sim for sim, _ in fuzzy)
                    usable = [c for sim, c in fuzzy if sim >= FUZZY_MIN]
                    tiers.append(("fuzzy", usable or [c for sim, c in fuzzy if sim == best], best))
        out = {c: np.nan for c in PRICE_COLS}
        out["price_match"], out["price_note"], out["price_match_score"] = "none", "", np.nan
        if not tiers:
            # say what was there, so the name or the date can be fixed in Airtable
            bits = []
            if titled:
                bits.append("exact title found but launched " + ", ".join(
                    l["launch_date"].date().isoformat() for l in titled) + ", outside the campaign window and the named quarter")
            elif same:
                bits.append("artist found, launches on " + ", ".join(
                    sorted(l["launch_date"].date().isoformat() for l in same)[:6]) + ", none in the window or quarter")
            else:
                bits.append("artist not in the Airtable pull")
            out["price_note"] = "; ".join(bits)
        else:
            kind, cands, score = tiers[0]
            chosen, note = _pick(cands)
            how = cands[0][1] if len(cands) == 1 else ("window" if any(c[1] == "window" for c in cands) else "quarter")
            days = min((c[2] for c in cands if c[1] == "window"), default=None)
            if kind == "fuzzy" and score < FUZZY_MIN:
                out["price_match"] = "none"
                out["price_match_score"] = score
                out["price_note"] = (f"nearest artist {chosen[0]['artist']!r} at similarity {score:.2f}, under "
                                     f"{FUZZY_MIN:.2f} so not used" + (f"; {note}" if note else ""))
            else:
                got = _combine(chosen)
                for c in PRICE_COLS:
                    if c in got:
                        out[c] = got[c]
                out["airtable_launch_date"] = got["launch_date"].date().isoformat() if pd.notna(got["launch_date"]) else ""
                out["airtable_launch_type"] = got.get("launch_type", "")
                out["airtable_edition_type"] = got.get("edition_type", "")
                out["airtable_product_type"] = got.get("product_type", "")
                label = {"exact": "exact", "artist": f"artist+{how}", "fuzzy": f"fuzzy+{how}"}[kind]
                out["price_match"] = label
                out["price_match_score"] = score
                out["price_match_days"] = days if days is not None else np.nan
                bits = []
                if kind == "fuzzy":
                    bits.append(f"artist matched {got['artist']!r} at similarity {score:.2f}")
                if kind != "exact":
                    bits.append(f"titles: {got['titles'][:120]}")
                if note:
                    bits.append(note)
                out["price_note"] = "; ".join(bits)
        rows.append(out)
    res = pd.DataFrame(rows, index=rel.index)
    res["price_match_score"] = pd.to_numeric(res["price_match_score"], errors="coerce")
    return res


def attach_pricing(panel: pd.DataFrame, pricing_path: pathlib.Path | str | None = None) -> pd.DataFrame:
    """The panel with the PRICE_COLS attached (replacing any earlier ones)."""
    keep = [c for c in panel.columns if c not in PRICE_COLS]
    out = panel[keep].copy()
    matched = match(out, launches(load_pricing(pricing_path)))
    return pd.concat([out, matched], axis=1)


# ---------------------------------------------------------------- the report

def _index_frame() -> pd.DataFrame:
    """The dashboard's release list as a panel-like frame, dates from inputs."""
    idx = json.loads(INDEX_PATH.read_text())
    inputs = json.loads(INPUTS_PATH.read_text()) if INPUTS_PATH.exists() else {}
    dated = {**(inputs.get("discovered") or {}), **(inputs.get("releases") or {})}
    rows = []
    for r in idx.get("releases", []):
        d = dated.get(r.get("id"), {})
        rows.append({"release_name": r.get("releaseName") or r.get("name"), "artist": r.get("artist"),
                     "title": r.get("title"), "quarter": r.get("quarter"),
                     "announce": d.get("announce_date"), "close": d.get("launch_end"), "panel": ""})
    return pd.DataFrame(rows)


def report() -> None:
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40); pd.set_option("display.max_rows", 500)
    records = load_pricing()
    lf = launches(records)
    print(f"Airtable: {len(records)} product records, {len(lf)} launches (a release code on a launch date); "
          f"{int(records['bundle'].sum())} records are bundles or unsized and do not count towards a launch's price or size")
    print(f"launches priced: {lf['unit_price'].notna().sum()}, sized: {lf['edition_size'].notna().sum()}; "
          f"currency: {lf['currency'].value_counts().to_dict()}; rates to GBP: {RATES_TO_GBP}")

    panel = pd.read_csv(PANEL_PATH, low_memory=False)
    res = match(panel, lf)
    both = pd.concat([panel[["release_name", "panel", "quarter", "announce", "close", "tot_total_product_units"]], res], axis=1)
    print(f"\n== panel: {len(panel)} releases ==")
    print("matched by:", both["price_match"].value_counts().to_dict())
    for kind, sub in both.groupby("panel", dropna=False):
        name = kind if isinstance(kind, str) else "not in a panel"
        print(f"  {name}: {len(sub)} releases, {(sub['price_match'] != 'none').sum()} matched, "
              f"{sub['unit_price'].notna().sum()} priced, {sub['edition_size'].notna().sum()} sized")
    dated = both[both["announce"].notna()]
    print(f"  with campaign dates: {len(dated)} releases, {(dated['price_match'] != 'none').sum()} matched, "
          f"{dated['unit_price'].notna().sum()} priced")

    non_exact = both[(both["price_match"] != "none") & (both["price_match"] != "exact")]
    print(f"\n== matches that were not an exact artist+title ({len(non_exact)}): the test, the days from the "
          f"reference date, and what was matched ==")
    show = non_exact[["release_name", "panel", "announce", "close", "price_match", "price_match_score",
                      "price_match_days", "airtable_release", "n_products", "unit_price", "edition_size", "price_note"]]
    print(show.sort_values(["price_match", "price_match_days"], na_position="last").to_string(index=False))

    un = both[both["price_match"] == "none"]
    print(f"\n== unmatched panel releases ({len(un)}) - fix the name or the date in Airtable ==")
    print(un[["release_name", "panel", "quarter", "announce", "close", "price_note"]].to_string(index=False))

    merged = both[both["price_note"].fillna("").str.contains("merged")]
    if len(merged):
        print(f"\n== {len(merged)} releases whose price aggregates several Airtable codes ==")
        print(merged[["release_name", "airtable_release", "n_products", "unit_price", "edition_size"]].to_string(index=False))

    sold = both[both["edition_size"].notna() & both["tot_total_product_units"].notna()]
    over = sold[sold["tot_total_product_units"] > sold["edition_size"] * 1.05]
    print(f"\n== sanity: units sold in the window against Airtable's edition size, {len(sold)} releases with both ==")
    print(f"sold / edition: median {float((sold['tot_total_product_units'] / sold['edition_size']).median()):.2f}; "
          f"{len(over)} releases sold more than 5% over the Airtable edition (a size Airtable understates, or a wrong match):")
    if len(over):
        print(over[["release_name", "airtable_release", "tot_total_product_units", "edition_size", "price_match"]].to_string(index=False))

    try:
        idx = _index_frame()
    except (OSError, ValueError):
        idx = None
    if idx is not None and len(idx):
        ires = match(idx, lf)
        print(f"\n== dashboard release list (data/app/index.json): {len(idx)} releases, "
              f"{(ires['price_match'] != 'none').sum()} matched, {ires['unit_price'].notna().sum()} priced ==")
        print("matched by:", ires["price_match"].value_counts().to_dict())
        iun = idx[ires["price_match"] == "none"]
        if len(iun):
            print("unmatched:", "; ".join(iun["release_name"].astype(str)))


if __name__ == "__main__":
    report()


# ---------------------------------------------------------------- one release's products

# the per-product target economics the dashboard reads off a record, when the
# pull found the field (etl/pull_airtable.py OPTIONAL_FIELDS); blank otherwise
PRODUCT_NUMERIC = ("edition_size", "units_target", "unit_price", "target_sellthrough", "expected_sellthrough",
                   "artist_profit_per_unit", "aa_profit_per_unit", "aa_revenue_share", "aa_profit_share",
                   "frame_conversion", "frame_profit_per_unit")
PRODUCT_TEXT = ("airtable_id", "project_code", "title", "release", "currency", "framing", "launch_type",
                "edition_type", "product_type", "price_status", "launch_date", "announce_date",
                "private_room_date", "marketing_lead")
_RECORDS: tuple[float, pd.DataFrame, pd.DataFrame] | None = None   # (mtime, records, launches)


def _num_or_none(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else f


def _text(v) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NaT:
        return ""
    if isinstance(v, pd.Timestamp):
        return v.date().isoformat()
    return str(v).strip()


def records_and_launches(path: pathlib.Path | str | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The pricing file and its launches, read once per file version."""
    global _RECORDS
    p = pathlib.Path(path) if path else PRICING_PATH
    if not p.exists():
        return pd.DataFrame(), pd.DataFrame()
    mtime = p.stat().st_mtime
    if path is None and _RECORDS is not None and _RECORDS[0] == mtime:
        return _RECORDS[1], _RECORDS[2]
    records = load_pricing(p)
    lf = launches(records)
    if path is None:
        _RECORDS = (mtime, records, lf)
    return records, lf


def _release_row(release: dict) -> pd.DataFrame:
    """A one-row frame in the shape match() reads, from a release's inputs or
    a discovered record: the name's artist, title and quarter, and the window."""
    name = str(release.get("release_name") or "")
    parts = [x.strip() for x in name.split(" · ")]
    qm = re.match(r"^(\d{4}) Q([1-4])$", parts[-1]) if len(parts) >= 2 else None
    artist = release.get("artist") or parts[0]
    title = release.get("title") or (" · ".join(parts[1:-1]) if qm and len(parts) >= 3 else " · ".join(parts[1:]))
    quarter = release.get("quarter") or (parts[-1] if qm else "")
    return pd.DataFrame([{
        "release_name": name, "artist": artist, "title": title, "quarter": quarter or "",
        "announce": release.get("announce_date"), "close": release.get("launch_end"), "panel": "",
    }])


def release_products(release: dict, pricing_path: pathlib.Path | str | None = None) -> dict:
    """The Airtable products of one release: the sized, non-bundle records of
    the launch `match` picks for it, by the same rules as the panel's pricing,
    each as a product dict the target model reads, with the launch-level
    figures Airtable holds beside them (dates, the marketing lead).

    Returns {"match": how it matched ("none" when it did not), "note": the
    matcher's note, "products": [...], "launch_date", "announce_date",
    "private_room_date" (the earliest announce and private-room dates and the
    latest launch date across the products), "marketing_lead"}. A record's
    numbers are None where Airtable has none, never zero; the currency is the
    pull's (EUR) and a price is not converted here."""
    records, lf = records_and_launches(pricing_path)
    out = {"match": "none", "note": "no Airtable pull on file" if records.empty else "", "products": [],
           "launch_date": None, "announce_date": None, "private_room_date": None, "marketing_lead": None}
    if records.empty or not release.get("release_name"):
        return out
    res = match(_release_row(release), lf).iloc[0]
    out["match"] = str(res.get("price_match") or "none")
    out["note"] = _text(res.get("price_note"))
    if out["match"] == "none":
        return out
    ids = {s for s in _text(res.get("airtable_ids")).split("|") if s}
    got = records[records["airtable_id"].astype(str).str.replace(r"\.0$", "", regex=True).isin(ids)]
    got = got.sort_values(["bundle", "title"], kind="stable")
    for r in got.itertuples(index=False):
        if bool(r.bundle):
            continue     # a set or an unsized record carries its parts' price, not an edition of its own
        p = {col: _text(getattr(r, col, "")) or None for col in PRODUCT_TEXT if col != "airtable_id"}
        p["airtable_id"] = _text(r.airtable_id).replace(".0", "")
        p["name"] = _text(r.title)
        for col in PRODUCT_NUMERIC:
            p[col] = _num_or_none(getattr(r, col, None))
        p["edition"] = int(round(p["edition_size"])) if p["edition_size"] and p["edition_size"] > 0 else None
        # the target as a share of the edition: the field when it exists, else
        # the units target Airtable already holds, else the expected sell-through
        share = p["target_sellthrough"]
        if share is None and p["units_target"] and p["edition"]:
            share = p["units_target"] / p["edition"]
        if share is None:
            share = p["expected_sellthrough"]
        p["target_sellthrough"] = min(max(share, 0.0), 1.0) if share is not None else None
        # "Framed on order" is a framing option; "No framing option" is not
        fr = (p.get("framing") or "").lower()
        p["framing_available"] = (not fr.startswith("no framing")) if fr else None
        out["products"].append(p)
    dates = [d for d in (p.get("announce_date") for p in out["products"]) if d]
    out["announce_date"] = min(dates) if dates else None
    dates = [d for d in (p.get("private_room_date") for p in out["products"]) if d]
    out["private_room_date"] = min(dates) if dates else None
    dates = [d for d in (p.get("launch_date") for p in out["products"]) if d]
    out["launch_date"] = max(dates) if dates else None
    leads = [p.get("marketing_lead") for p in out["products"] if p.get("marketing_lead")]
    out["marketing_lead"] = max(set(leads), key=leads.count) if leads else None
    return out
