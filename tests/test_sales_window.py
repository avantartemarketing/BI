#!/usr/bin/env python3
"""The sales window closes with the draw, not only the clock (docs 6.3).

A synthetic launch whose campaign clock closes on 29 July while its draw runs
to 5 August and its winners pay on the 3rd and the 5th (Jaume Plensa's
UTOPIA: 61 of 218 units counted under the clock's close plus two days). The
page must count those payments, close with the draw in the sidebar and count
the draw's spend and sends; an ordinary launch, whose draw ended by the
clock's close, must build exactly as before; a draw end far past the clock
moves the close DRAW_END_MAX_DAYS at most; a targeted page counts the
winners' payments while its plan keeps the typed dates; and the build warns
when many units are paid just after a window shut.
python3 tests/test_sales_window.py (needs pandas)"""
import contextlib, copy, io, json, pathlib, shutil, sys, tempfile
from datetime import date, timedelta
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import pandas as pd
import build, baskets

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)
near = lambda a, b, tol=0.51: a is not None and b is not None and abs(a - b) <= tol

NAME = "Synthetic Sculptor · Utopia · 2026 Q3"
CODE = "SynthSculpt_LE_26"
ANNOUNCE, CLOCK_CLOSE, DRAW_LAST = date(2026, 7, 7), date(2026, 7, 29), date(2026, 8, 5)
AS_OF = date(2026, 9, 24)
CH = [("AA Email Man", 200, 1.0), ("Paid Social", 300, 2.0), ("Direct", 150, 0.5)]

def funnel(name, announce, close, through):
    rows, d, L = [], announce - timedelta(days=20), (close - announce).days
    while d <= through:
        for ch, sess, ent in CH:
            live = announce <= d <= close
            rows.append({"channel": ch, "event_date": d, "simple_release_name": name, "campaign_stage": None,
                         "Sessions_Total": float(sess if live else 5), "Total_Product_Units": 0.0,
                         "Product_Units_Private_Room": 0.0,
                         "Draw_Entries_Total_Units_No_Conv": ent * 0.7 if live else 0.0,
                         "Draw_Entries_Eligible_Units": ent if live else 0.0,
                         "days_since_announcement": (d - announce).days, "days_until_launch": (close - d).days,
                         "pct_days_since_announcement": (d - announce).days / L, "pct_days_until_launch": (close - d).days / L})
        d += timedelta(days=1)
    return pd.DataFrame(rows)

def spend(first, last):
    rows, d = [], first
    while d <= last:
        rows.append({"campaign_name": f"{CODE} · Enter draw", "spend_date": d, "impressions": 1000, "reach": 800,
                     "link_clicks": 40, "spend": 100.0})
        d += timedelta(days=1)
    return pd.DataFrame(rows, columns=["campaign_name", "spend_date", "impressions", "reach", "link_clicks", "spend"])

def emails(days):
    return pd.DataFrame({"name": [f"{CODE}_GEN_{i}" for i in range(len(days))],
                         "sent_at": pd.to_datetime([d.isoformat() for d in days]),
                         "campaign": [CODE] * len(days), "delivered": [1000.0] * len(days),
                         "opened": [300.0] * len(days), "clicked": [30.0] * len(days),
                         "unsubscribed": [1.0] * len(days), "email_type": ["GEN"] * len(days)})

tmp = pathlib.Path(tempfile.mkdtemp())
real_units = build.UNITS_FILE
build.load_orders_feed()
build.load_products_feed()

def install(name, paid, last_entry):
    """The units feed, the orders feed and the draw feed for one release:
    paid is [(day, channel, units)], all on one product."""
    lines = ["release,product_title,order_date,channel,purchase_event,units_paid,units_private_room,prints_offered_paid,frames_paid"]
    lines += [f"{name},Utopia,{d.isoformat()},{ch},true,{u},0,{u},0" for d, ch, u in paid]
    (tmp / "units_paid.csv").write_text("\n".join(lines) + "\n")
    build.UNITS_FILE = tmp / "units_paid.csv"
    build._UNITS_FEED = None
    total = float(sum(u for _, _, u in paid))
    prod = {"printsOffered": total, "frames": 0.0, "entrantPrints": 0.0, "entrantFrames": 0.0, "unitsPaid": total,
            "drafts": 0.0, "draftCustomers": None, "entryDrafts": 0.0, "entrantDrafts": 0.0, "winnerDrafts": 0.0,
            "winnerDraftsLapsed": 0.0, "refunded": 0.0, "fromDrafts": 0.0, "privateRoom": 0.0, "listPrice": 3000.0,
            "edition": None, "lastOrder": max(d for d, _, _ in paid).isoformat(), "lastDraft": None}
    build._ORDERS_FEED[name] = {"products": {"Utopia": prod}, "draws": {}, "drafts": 0.0, "unitsPaid": total,
                                "asOf": max(d for d, _, _ in paid).isoformat(), "campaignCode": CODE,
                                "framing": {"prints": total, "frames": 0.0, "notOffered": 0.0,
                                            "entrantPrints": 0.0, "entrantFrames": 0.0}}
    if last_entry is None:
        build._PRODUCTS_FEED.pop(name, None)
    else:
        build._PRODUCTS_FEED[name] = {
            "draws": [{"id": "dU", "first": ANNOUNCE.isoformat(), "last": last_entry.isoformat(), "entrants": 900,
                       "eligible": 880, "winners": 150, "sold": 145, "open": 700, "wonUnpaid": 5, "purchaseUnits": 0.0}],
            "entrants": 900, "eligible": 880, "allocated": True, "patterns": []}

def rec(name, close):
    return {"id": build.slugify(name), "release_name": name, "artist": name.split(" · ")[0], "title": name.split(" · ")[1],
            "quarter": "2026 Q3", "type": "LE", "campaign_code": CODE, "campaign_name": f"{CODE} · Enter draw",
            "announce_date": ANNOUNCE.isoformat(), "launch_end": close.isoformat(), "dates_note": None,
            "first_seen": (ANNOUNCE - timedelta(days=20)).isoformat(), "last_seen": AS_OF.isoformat()}

content = build.load_content()

def actuals(name, close, paid, last_entry, old_rule=False, sends=(date(2026, 7, 10), date(2026, 8, 2))):
    install(name, paid, last_entry)
    real = build.sales_close
    if old_rule:
        build.sales_close = lambda n, end: (end, None)   # the rule before: the clock's close alone
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            snap = build.with_direct_spread(build.build_actuals, rec(name, close), funnel(name, ANNOUNCE, close, AS_OF),
                                            spend(ANNOUNCE + timedelta(days=1), DRAW_LAST), emails(list(sends)),
                                            content, AS_OF)
            build.check_snapshot(snap)
    finally:
        build.sales_close = real
    return snap, out.getvalue()

try:
    # 1. the Plensa shape: 21 units in the campaign, the winners pay on the
    #    3rd (26) and on the allocation day, the 5th (119), two stragglers on
    #    the 20th; the clock closed on 29 July
    PAID = [(date(2026, 7, 10), "AA Email Man", 10), (date(2026, 7, 20), "Paid Social", 10),
            (date(2026, 7, 29), "Direct", 1), (date(2026, 8, 3), "AA Email Man", 26),
            (date(2026, 8, 5), "Paid Social", 119), (date(2026, 8, 20), "Direct", 2)]
    S, log = actuals(NAME, CLOCK_CLOSE, PAID, DRAW_LAST)
    O, old_log = actuals(NAME, CLOCK_CLOSE, PAID, DRAW_LAST, old_rule=True)
    st, sw = S["sellthrough"], S["salesWindow"]
    check(sw["end"] == "2026-08-07" and sw["closed"], f"the window shuts two days after the draw ended: {sw}")
    check(near(st["sold"], 166) and near(S["hero"]["now"], 166),
          f"the winners' payments count: sold {st['sold']}, hero {S['hero']['now']} (166 paid by 7 August)")
    check(st["unitsOutsideWindow"]["after"] == 2.0, f"only the stragglers are after it: {st['unitsOutsideWindow']}")
    check(S["windowEnd"] == "2026-08-05" and S["of"] == 29 and S["day"] == 29 and S["campaignLengthDays"] == 29,
          f"the sidebar reads the campaign to the draw's end: {S['windowEnd']} day {S['day']} of {S['of']}")
    check(near(S["paid"]["spendToDate"], 2900.0, 0.01), f"the draw's spend to 5 August counts: {S['paid']['spendToDate']}")
    check(S["email"]["sends"] == 2, f"and so do its sends: {S['email']['sends']}")
    check("the draw ran to 2026-08-05, 7 days past the campaign clock's close of 2026-07-29"
          in (S["derived"]["dates_note"] or "") and S["derived"]["launch_end"] == "2026-08-05",
          f"the page says why it closes on the 5th: {S['derived']}")
    check(near(sum(c["now"] for c in S["channels"]), S["hero"]["now"], 1.0), "the channels add up to the hero")
    check("warning:" not in log, f"no late-payment warning once the window closes with the draw: {log.strip()}")
    # the rule before, on the same feeds: 21 of 168 units, a 22-day campaign
    ost = O["sellthrough"]
    check(O["salesWindow"]["end"] == "2026-07-31" and near(ost["sold"], 21) and O["of"] == 22
          and ost["unitsOutsideWindow"]["after"] == 147.0 and near(O["paid"]["spendToDate"], 2200.0, 0.01)
          and O["email"]["sends"] == 1,
          f"the clock's close alone counted 21 units, 22 days, EUR 2,200 and one send: {O['salesWindow']} "
          f"{ost['sold']} {O['of']} {O['paid']['spendToDate']} {O['email']['sends']}")
    check("145 units paid in the 14 days after its sales window shut on 2026-07-31" in old_log,
          f"and the build would have warned of it: {old_log.strip()}")
    print(f"plensa shape: {ost['sold']:.0f} -> {st['sold']:.0f} units, window to {O['salesWindow']['end']} -> "
          f"{sw['end']}, {O['of']} -> {S['of']} days, spend {O['paid']['spendToDate']:.0f} -> {S['paid']['spendToDate']:.0f}")

    # 2. an ordinary launch: the draw ended on the clock's close and the
    #    winners paid in the grace. The page is the same as under the old rule
    ORD = "Synthetic Painter · Ordinary · 2026 Q3"
    ORD_PAID = [(date(2026, 7, 10), "AA Email Man", 10), (date(2026, 7, 29), "Paid Social", 30),
                (date(2026, 7, 31), "Direct", 5), (date(2026, 8, 12), "Direct", 3)]
    for last in (CLOCK_CLOSE, CLOCK_CLOSE - timedelta(days=3), None):
        A, alog = actuals(ORD, CLOCK_CLOSE, ORD_PAID, last)
        B, _ = actuals(ORD, CLOCK_CLOSE, ORD_PAID, last, old_rule=True)
        check(json.dumps(A, sort_keys=True, default=str) == json.dumps(B, sort_keys=True, default=str),
              f"a draw that ended by the clock's close (last entry {last}) builds exactly as before")
        check(A["salesWindow"]["end"] == "2026-07-31" and near(A["sellthrough"]["sold"], 45) and A["of"] == 22
              and "warning:" not in alog, f"45 units to the close plus two days, 22 days: {A['salesWindow']} {A['of']}")
    print(f"ordinary launch: unchanged, {A['sellthrough']['sold']:.0f} units to {A['salesWindow']['end']}")

    # 3. a draw end far past the clock (a re-run, a stray entry): the close
    #    moves DRAW_END_MAX_DAYS and no further, and the build says so
    FAR = CLOCK_CLOSE + timedelta(days=40)
    F, flog = actuals(NAME, CLOCK_CLOSE, PAID, FAR)
    held = CLOCK_CLOSE + timedelta(days=build.DRAW_END_MAX_DAYS)
    check(F["windowEnd"] == held.isoformat() and F["salesWindow"]["end"] == (held + timedelta(days=2)).isoformat(),
          f"the close is held {build.DRAW_END_MAX_DAYS} days past the clock's: {F['windowEnd']} {F['salesWindow']}")
    check(f"warning: {build.slugify(NAME)}: the draw ran to {FAR}" in flog and "no later" in flog,
          f"and the build warns of it: {flog.strip()}")
    check(build.sales_close("Nobody · Nothing · 2026 Q3", CLOCK_CLOSE) == (CLOCK_CLOSE, None),
          "a release the draw feed does not know keeps the clock's close")

    # 4. a live launch past its clock's close whose draw is still taking
    #    entries: its window stays open to the as-of day
    install(NAME, PAID[:3], date(2026, 8, 1))
    check(build.sales_close(NAME, CLOCK_CLOSE) == (date(2026, 8, 1), date(2026, 8, 1)),
          "the close follows the draw's last entry so far")

    # 5. the late-payment warning: a draw that ended on its close, and 12
    #    units paid eight days after the window shut, against 60 in it
    rows = pd.DataFrame({"event_date": [date(2026, 7, 20), date(2026, 8, 8), date(2026, 9, 20)],
                         "units": [60.0, 12.0, 40.0]})
    info = {"source": "orders", "total": 60.0}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        w = build.late_paid_warning("synthetic", rows, date(2026, 7, 31), info)
        quiet = build.late_paid_warning("synthetic", rows.iloc[[0, 2]], date(2026, 7, 31), info)
        few = build.late_paid_warning("synthetic", rows.assign(units=[600.0, 12.0, 40.0]), date(2026, 7, 31),
                                      {"source": "orders", "total": 600.0})
        funnel_page = build.late_paid_warning("synthetic", rows, date(2026, 7, 31), {"source": "funnel", "total": 60.0})
    check(w is not None and "12 units paid in the 14 days after its sales window shut on 2026-07-31 (17%" in w,
          f"12 of 72 units paid just after the window warn: {w}")
    check(quiet is None, "units paid long after the window (catalogue sales) do not")
    check(few is None, "nor do 12 units beside 600 (2%)")
    check(funnel_page is None, "nor a page on the funnel's units, which has no order days")

    # 6. a targeted page: the winners who pay after the typed close are
    #    counted, folded into its close day; the plan keeps the typed dates
    base = dict(next(r for r in build.INPUTS["releases"] if r["id"] == "julianschnabel_le_26"))
    TNAME = "Synthetic Artist · Targeted Utopia · 2026 Q3"
    base.update(release_name=TNAME, campaign_name=f"{CODE} · Enter draw", campaign_names=[f"{CODE} · Enter draw"])
    t_ann, t_close = date.fromisoformat(base["announce_date"]), date.fromisoformat(base["launch_end"])
    t_last = t_close + timedelta(days=5)
    t_paid = [(t_ann + timedelta(days=2), "AA Email Man", 8), (t_close, "Paid Social", 6),
              (t_last, "Paid Social", 20), (t_last + timedelta(days=15), "Direct", 2)]
    today = t_close + timedelta(days=20)
    tframe = funnel(TNAME, t_ann, t_close, today)
    emails_all, people = build.load_emails(), build.load_people()
    panel, curves = baskets.load_panel(), json.loads((ROOT / "data/app/curves.json").read_text())

    def targeted(last, old_rule=False):
        install(TNAME, t_paid, last)
        real = build.sales_close
        if old_rule:
            build.sales_close = lambda n, end: (end, None)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                snap = build.with_direct_spread(build.build_release, copy.deepcopy(base), tframe,
                                                spend(t_ann, t_last), emails_all, content, curves, today,
                                                None, {}, None, panel, people, full_through=today, seen=1.0)
                build.check_snapshot(snap)
        finally:
            build.sales_close = real
        return snap

    T, TO = targeted(t_last), targeted(t_last, old_rule=True)
    check(T["salesWindow"]["end"] == (t_last + timedelta(days=2)).isoformat() and T["salesWindow"]["closed"],
          f"the targeted window shuts two days after the draw: {T['salesWindow']}")
    check(near(T["sellthrough"]["sold"], 34) and near(TO["sellthrough"]["sold"], 14),
          f"the winners' 20 units count: {TO['sellthrough']['sold']} -> {T['sellthrough']['sold']}")
    check(T["windowEnd"] == TO["windowEnd"] == t_close.isoformat() and T["of"] == TO["of"],
          f"the plan keeps the typed close: {T['windowEnd']} of {T['of']}")
    check(near(sum(c["now"] for c in T["channels"]), T["hero"]["now"], 1.0), "the targeted channels add up to the hero")
    N = targeted(t_close)
    check(N["salesWindow"] == TO["salesWindow"] and near(N["sellthrough"]["sold"], TO["sellthrough"]["sold"]),
          "a targeted draw that ended on its close counts as before")
    print(f"targeted: {TO['sellthrough']['sold']:.0f} -> {T['sellthrough']['sold']:.0f} units, window to "
          f"{T['salesWindow']['end']}, plan close {T['windowEnd']}")
finally:
    build.UNITS_FILE = real_units
    build._UNITS_FEED = None
    for n in (NAME, "Synthetic Painter · Ordinary · 2026 Q3", "Synthetic Artist · Targeted Utopia · 2026 Q3"):
        build._ORDERS_FEED.pop(n, None)
        build._PRODUCTS_FEED.pop(n, None)
    shutil.rmtree(tmp, ignore_errors=True)

print(f"{failed} failure(s)" if failed else "ok: the sales window closes with the draw")
sys.exit(1 if failed else 0)
