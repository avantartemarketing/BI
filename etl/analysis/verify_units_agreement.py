#!/usr/bin/env python3
"""One count of units sold on every card (docs/DATA_MODEL.md 6.3): after a
build, read every release page and the units feed it was built from, and put
each card's units figure side by side.

For each snapshot in data/app/releases/ (targeted pages) and data/app/derived/
(actuals-only pages) it reads:
  feed      data/units_paid.csv summed over the page's salesWindow
  sold      sellthrough.sold (the Paid segment) and unitsPaidOrders
  products  the products' unitsPaid added up (ordersByProduct)
  hero      hero.now + oversubscribedUnits (the count before the sellout cap)
  count     sold + drafts + soldPredicted (the sell-through's count)
  channels  the channels' now added up, and the same on the Direct-spread variant
  trail     the trajectory's last actual, every channel's daily actuals added up
  waterfall waterfall.today.actual
  paid      paid.unitsToDate against the paid channel's now
  framing   framing.prints + notOffered.units (every paid unit, offered a frame or not)
and flags any pair more than a unit apart. Only release names and counts are
read or written: the units feed holds no identifier.

.venv/bin/python etl/analysis/verify_units_agreement.py [--out data/reconciliation/agreement.csv]
Exit status 1 when any page disagrees."""
import csv, json, os, pathlib, sys
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parents[2]
UNITS = pathlib.Path(os.environ.get("UNITS_FILE") or ROOT / "data" / "units_paid.csv")
TOL = 1.0


def feed_units() -> dict[str, list[tuple[date, float]]]:
    """release -> [(order day, units paid)] from the units feed."""
    out: dict[str, list[tuple[date, float]]] = {}
    path = UNITS
    if not path.exists():
        sys.exit(f"{path} is missing: pull it first (node server/bigquery.js --write --orders)")
    with path.open(newline="") as fh:
        for r in csv.DictReader(fh):
            try:
                d, u = date.fromisoformat(r["order_date"][:10]), float(r["units_paid"] or 0)
            except ValueError:
                continue
            out.setdefault(r["release"], []).append((d, u))
    return out


def near(a, b, tol=TOL) -> bool:
    return a is None or b is None or abs(float(a) - float(b)) <= tol


def main() -> int:
    out_path = None
    if "--out" in sys.argv:
        out_path = ROOT / sys.argv[sys.argv.index("--out") + 1]
    feed = feed_units()
    rows, bad = [], 0
    pages = sorted((ROOT / "data/app/releases").glob("*.json")) + sorted((ROOT / "data/app/derived").glob("*.json"))
    for f in pages:
        s = json.loads(f.read_text())
        st, hero = s.get("sellthrough") or {}, s.get("hero") or {}
        sw = s.get("salesWindow") or {}
        src = s.get("unitsSource")
        name = s.get("releaseName")
        r = {"id": s.get("id"), "release": name, "source": src,
             "start": sw.get("start"), "end": sw.get("end"), "closed": sw.get("closed"),
             "first_paid": sw.get("firstPaid")}
        if sw.get("start") and sw.get("end") and name in feed:
            a, b = date.fromisoformat(sw["start"]), date.fromisoformat(sw["end"])
            r["feed"] = round(sum(u for d, u in feed[name] if a <= d <= b), 2)
            r["feed_before"] = round(sum(u for d, u in feed[name] if d < a), 2)
            r["feed_after"] = round(sum(u for d, u in feed[name] if d > b), 2)
        else:
            r["feed"] = r["feed_before"] = r["feed_after"] = None
        # the products' rows as the card draws them: paid plus the share of
        # what no product is named for
        prows = st.get("products") or []
        r["rows"] = round(sum(float(p.get("sold") or 0) + float(p.get("soldAssumed") or 0) for p in prows), 2) if prows else None
        r["sold"] = st.get("sold")
        r["units_paid_orders"] = st.get("unitsPaidOrders")
        obp = st.get("ordersByProduct")
        r["products"] = round(sum(float(p.get("unitsPaid") or 0) for p in obp.values()), 2) if obp else None
        out_w = st.get("unitsOutsideWindow") or {}
        r["outside_before"], r["outside_after"], r["pending"] = out_w.get("before"), out_w.get("after"), out_w.get("pending")
        r["hero"] = None if hero.get("now") is None else round(float(hero["now"]) + float(hero.get("oversubscribedUnits") or 0), 2)
        r["count"] = None if st.get("sold") is None else round(
            float(st.get("sold") or 0) + float(st.get("drafts") or 0) + float(st.get("soldPredicted") or 0), 2)
        ch = s.get("channels") or []
        r["channels"] = round(sum(float(c.get("now") or 0) for c in ch), 2) if ch else None
        vch = ((s.get("variants") or {}).get("direct_spread") or {}).get("channels") or []
        r["channels_direct_spread"] = round(sum(float(c.get("now") or 0) for c in vch), 2) if vch else None
        trail = 0.0
        for c in ch:
            acts = [d.get("actual") for d in (c.get("daily") or []) if d.get("actual") is not None]
            trail += float(acts[-1]) if acts else 0.0
        r["trail"] = round(trail, 2) if ch else None
        r["waterfall"] = ((s.get("waterfall") or {}).get("today") or {}).get("actual")
        paid = s.get("paid") or {}
        pch = next((c for c in ch if c.get("key") == "paid"), None)
        r["paid_units"], r["paid_channel"] = paid.get("unitsToDate"), (pch or {}).get("now")
        fr = s.get("framing") or {}
        r["framing"] = None if not fr or fr.get("prints") is None else round(
            float(fr["prints"]) + float((fr.get("notOffered") or {}).get("units") or 0), 2)
        r["no_event"] = ((s.get("untracked") or {}).get("noEvent") or {}).get("count")
        r["no_event_high"] = ((s.get("untracked") or {}).get("noEvent") or {}).get("high")

        why = []
        if src == "orders":
            for k in ("sold", "units_paid_orders", "products"):
                if not near(r["feed"], r[k], 0.51):
                    why.append(f"{k} {r[k]} vs feed {r['feed']}")
            if r["feed_before"] is not None and not near(r["outside_before"], r["feed_before"], 0.51):
                why.append(f"outside before {r['outside_before']} vs feed {r['feed_before']}")
            if r["feed_after"] is not None and not near((r["outside_after"] or 0) + (r["pending"] or 0), r["feed_after"], 0.51):
                why.append(f"outside after {r['outside_after']} + pending {r['pending']} vs feed {r['feed_after']}")
            if r["rows"] is not None and not near(r["rows"], r["sold"], 0.51 + 0.05 * len(prows)):
                why.append(f"product rows {r['rows']} vs sold {r['sold']}")
            if r["framing"] is not None and not near(r["framing"], r["sold"]):
                why.append(f"framing {r['framing']} vs sold {r['sold']}")
            if sw.get("closed") and not near(r["count"], r["sold"], 0.51):
                why.append(f"closed window but count {r['count']} is not sold {r['sold']}")
        if r["sold"] is not None and not near(r["hero"], r["count"]):
            why.append(f"hero {r['hero']} vs sell-through count {r['count']}")
        for k in ("channels", "channels_direct_spread", "trail"):
            if not near(r[k], r["hero"], 1.5):
                why.append(f"{k} {r[k]} vs hero {r['hero']}")
        if r["waterfall"] is not None and hero.get("now") is not None and not near(r["waterfall"], hero["now"]):
            why.append(f"waterfall {r['waterfall']} vs hero {hero['now']}")
        if not near(r["paid_units"], r["paid_channel"]):
            why.append(f"paid card {r['paid_units']} vs paid channel {r['paid_channel']}")
        r["disagreement"] = "; ".join(why)
        bad += bool(why)
        rows.append(r)

    cols = list(rows[0].keys()) if rows else []
    w = csv.DictWriter(sys.stdout, cols)
    w.writeheader()
    w.writerows(rows)
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w", newline="") as fh:
            ww = csv.DictWriter(fh, cols)
            ww.writeheader()
            ww.writerows(rows)
    print(f"\n{len(rows)} pages, {sum(r['source'] == 'orders' for r in rows)} on the orders feed, "
          f"{bad} disagreeing", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
