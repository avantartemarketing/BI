#!/usr/bin/env python3
"""The committed snapshots against this ETL's check_snapshot (docs 6.3, 10a).

data/app/releases/*.json is the fallback the server seeds its disk with, so a
page committed from an older ETL is what anyone sees after a deploy until the
first refresh. Every committed snapshot that carries `unitsSource` (a page
built with the orders sales window) must pass check_snapshot and raise none
of its stale-build warnings. The snapshots committed today predate
`unitsSource`: they are skipped here, named, and replaced by the next rebuild
(the live refresh rebuilds every page hourly), after which this test checks
them in full. What it proves meanwhile is that check_snapshot no longer lets
such a page pass silently: each one draws the warning, and synthetic pages
show each soft rule firing, and staying quiet on a page this ETL would build.
python3 tests/test_committed_snapshots.py (needs pandas)"""
import copy, glob, json, os, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
os.environ.pop("CHECK_SNAPSHOT", None)   # the hard checks raise, as in the refresh
import build

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)

# ---- every committed snapshot
checked, predate = [], []
for path in sorted(glob.glob(str(ROOT / "data/app/releases/*.json"))):
    snap = json.loads(pathlib.Path(path).read_text())
    rid = snap.get("id", pathlib.Path(path).stem)
    if "unitsSource" not in snap:
        # built before the orders window: the next rebuild replaces it; until
        # then check_snapshot must at least say so rather than pass it
        predate.append(rid)
        w = build.stale_build_warnings(snap)
        check(any("unitsSource" in x for x in w), f"{rid}: a page with no unitsSource draws the stale-build warning: {w}")
        continue
    checked.append(rid)
    try:
        soft = build.check_snapshot(snap)
    except AssertionError as e:
        check(False, f"{rid}: check_snapshot fails the committed page: {e}")
        continue
    check(not soft, f"{rid}: the committed page draws stale-build warnings: {soft}")
if predate:
    print(f"{len(predate)} committed snapshot(s) predate unitsSource and are skipped until the next rebuild "
          f"replaces them: {', '.join(predate)}")
print(f"{len(checked)} committed snapshot(s) checked in full")

# ---- the soft rules on synthetic pages
def page(**kw):
    """A small page whose arithmetic holds: 20 paid of an edition of 50,
    every card agreeing, the window shut, nothing in hand."""
    s = {"id": "synthetic", "asOf": "2026-09-24", "windowEnd": "2026-09-01", "complete": True,
         "unitsSource": "orders",
         "salesWindow": {"start": "2026-08-01", "end": "2026-09-03", "closed": True, "firstPaid": None},
         "hero": {"now": 20.0, "projected": 20.0},
         "channels": [{"key": "paid", "now": 12.0}, {"key": "aa_email", "now": 8.0}],
         "sellthrough": {"edition": 50, "sold": 20.0, "unitsPaidOrders": 20.0, "drafts": 0.0, "soldPredicted": 0.0,
                         "inHandUnits": 0.0, "futureEntriesPredicted": 0.0, "patterns": [], "pct": 0.4}}
    for k, v in kw.items():
        s[k] = v
    return s

build.SNAPSHOT_WARNINGS.clear()
good = page()
check(build.check_snapshot(good) == [], "a page this ETL would build draws no warning")
check(not build.SNAPSHOT_WARNINGS, f"and nothing is recorded: {build.SNAPSHOT_WARNINGS}")

# the stale shape: no unitsSource or salesWindow, still counting drafts,
# winners and entries in hand three weeks after its close (the committed Dali
# page's shape), its own arithmetic intact so only the soft rules can see it
stale = page()
stale.pop("unitsSource"); stale.pop("salesWindow")
stale["sellthrough"] = {**stale["sellthrough"], "drafts": 2.0, "soldPredicted": 1.0, "inHandUnits": 30.0,
                        "patterns": [{"open": ["d1"], "won": [], "sold": [], "bought": 0, "max": 1, "pre": [], "n": 30}],
                        "pct": 0.46}
stale["hero"] = {"now": 23.0, "projected": 23.0}
stale["channels"] = [{"key": "paid", "now": 14.0}, {"key": "aa_email", "now": 9.0}]
try:
    w = build.check_snapshot(stale)
except AssertionError as e:
    w = None
    check(False, f"a stale page is warned of, never failed: {e}")
if w is not None:
    check(any("no unitsSource or salesWindow" in x for x in w), f"the missing fields are named: {w}")
    check(any("shut on 2026-09-03" in x and "drafts 2.0" in x and "soldPredicted 1.0" in x
              and "inHandUnits 30.0" in x and "1 entry patterns" in x for x in w),
          f"the leftovers on a shut window are named, the close read from windowEnd + the grace: {w}")
    check(len(build.SNAPSHOT_WARNINGS) == len(w), f"and recorded for the build's summary: {build.SNAPSHOT_WARNINGS}")

# a page with the window fields whose shut window still counts something
leak = page(sellthrough={**page()["sellthrough"], "futureEntriesPredicted": 3.0, "pct": 0.46},
            hero={"now": 20.0, "projected": 23.0})
w = build.check_snapshot(leak)
check(len(w) == 1 and "futureEntriesPredicted 3.0" in w[0] and "unitsSource" not in w[0],
      f"a shut window still counting units to come is warned of: {w}")

# a live window counts what is in hand: no warning
live = page(salesWindow={"start": "2026-08-01", "end": "2026-09-24", "closed": False, "firstPaid": None},
            windowEnd="2026-09-30", complete=False,
            sellthrough={**page()["sellthrough"], "drafts": 2.0, "soldPredicted": 1.0, "pct": 0.46},
            hero={"now": 23.0, "projected": 23.0},
            channels=[{"key": "paid", "now": 14.0}, {"key": "aa_email", "now": 9.0}])
check(build.check_snapshot(live) == [], "a live window keeps its drafts and winners without a warning")

# pages that are not targeted never carry the window fields as a rule
for kind in ({"targeted": False, "upcoming": True, "salesWindow": None, "unitsSource": None},
             {"targeted": False, "catalogue": True, "salesWindow": None, "unitsSource": None, "windowEnd": None}):
    p = page(**kind)
    check(build.stale_build_warnings(p) == [], f"no missing-field warning on {kind}: {build.stale_build_warnings(p)}")

# the Direct switch's view is checked hard but not warned of twice
dup = copy.deepcopy(stale)
dup["variants"] = {"direct_spread": {"channels": [{"key": "paid", "now": 15.0}, {"key": "aa_email", "now": 8.0}]}}
build.SNAPSHOT_WARNINGS.clear()
w = build.check_snapshot(dup)
check(len(build.SNAPSHOT_WARNINGS) == len(w) == 2, f"one warning per rule, not per view: {build.SNAPSHOT_WARNINGS}")

# a hard breach still fails the build as before
bad = page(hero={"now": 25.0, "projected": 20.0})
try:
    build.check_snapshot(bad)
    check(False, "a hero off its channels still fails the build")
except AssertionError:
    pass

print(f"{failed} failure(s)" if failed else "ok: committed snapshots")
sys.exit(1 if failed else 0)
