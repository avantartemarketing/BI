#!/usr/bin/env python3
"""One page's failure never stops the build (etl/build.py guard_page), and
every page carries when it was built (write_page). On 28 September 2026 one
upcoming launch's page stopped the whole build after every release page was
written and before the index, so every refresh failed for an evening.
python3 tests/test_page_guard.py"""
import json
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))
import build  # noqa: E402

failed = 0
def check(cond, msg):
    global failed
    if not cond:
        failed += 1
        print("FAIL", msg)

# the guard: a page that builds counts, a page that raises is skipped with
# its id and error kept, and the build goes on to the next
failures: list = []
built: list = []
check(build.guard_page(failures, "one", lambda: built.append("one")) is True and built == ["one"], "a page that builds comes back True")
def boom():
    raise OSError(36, "File name too long", "/var/data/app/derived/" + "x" * 300 + ".json")
check(build.guard_page(failures, "two", boom) is False, "a page that raises comes back False")
check(build.guard_page(failures, "three", lambda: built.append("three")) is True and built == ["one", "three"], "and the next page still builds")
check(len(failures) == 1 and failures[0][0] == "two" and failures[0][1].startswith("OSError: [Errno 36] File name too long"), f"the failure is kept with its id and error: {failures}")
check(len(failures[0][1]) <= 320, "the error is cut to a line")
# a SystemExit (the build refusing to run) is not a page failure and passes through
try:
    build.guard_page(failures, "four", lambda: (_ for _ in ()).throw(SystemExit("stop")))
    check(False, "SystemExit passes through the guard")
except SystemExit:
    pass

# the page stamp: builtAt is written with the page, as an ISO moment in UTC
with tempfile.TemporaryDirectory() as tmp:
    path = pathlib.Path(tmp) / "page.json"
    snap = {"id": "page", "asOf": "2026-09-30"}
    build.write_page(path, snap)
    doc = json.loads(path.read_text())
    check(doc["id"] == "page" and doc["asOf"] == "2026-09-30", "the page is written as given")
    check(isinstance(doc.get("builtAt"), str) and doc["builtAt"].endswith("+00:00") and doc["builtAt"][:4] == "2026" or doc["builtAt"][:2] == "20", f"builtAt is a UTC moment: {doc.get('builtAt')}")
    check(snap.get("builtAt") == doc["builtAt"], "the stamp is on the snapshot the caller holds too")

if failed:
    sys.exit(f"{failed} check(s) failed")
print("ok: page guard and stamp")
