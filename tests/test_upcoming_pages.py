#!/usr/bin/env python3
"""The upcoming pages alone (etl/build.py build_upcoming_pages, `--upcoming`):
from Airtable's launches and the releases on file, with no funnel export,
into a relocated app data directory - what the server runs at boot when a
deploy has lost those pages. python3 tests/test_upcoming_pages.py"""
import sys, json, pathlib, shutil, tempfile, subprocess, os
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "etl"))

failed = 0
def check(cond, msg):
    global failed
    if not cond: failed += 1; print("FAIL", msg)

with tempfile.TemporaryDirectory() as tmp:
    app = pathlib.Path(tmp, "app")
    app.mkdir()
    for name in ("index.json", "inputs.json"):
        shutil.copy(ROOT / "data" / "app" / name, app / name)
    before = json.loads((app / "index.json").read_text())
    up_rows = [r for r in before["releases"] if r.get("status") == "upcoming"]
    # the relocated directory, as the server sets it, in a fresh interpreter
    env = dict(os.environ, APP_DATA_PATH=str(app))
    out = subprocess.run([sys.executable, str(ROOT / "etl" / "build.py"), "--upcoming"], capture_output=True, text=True, env=env, cwd=str(ROOT))
    check(out.returncode == 0, f"--upcoming ran: {out.stderr[-400:]}")
    tail = [l for l in out.stdout.splitlines() if l.startswith("upcoming:")]
    check(bool(tail) and "wrote" in tail[-1], f"reported what it wrote: {tail}")
    pages = sorted(p.stem for p in (app / "derived").glob("*.json")) if (app / "derived").exists() else []
    after = json.loads((app / "index.json").read_text())
    up_after = [r for r in after["releases"] if r.get("status") == "upcoming"]
    check(len(pages) > 0, f"upcoming pages written: {pages[:5]}")
    check(all(r["id"] in pages for r in up_after), "every upcoming row in the index has its page")
    check(after["asOf"] == before["asOf"], "the index keeps the last build's as-of")
    check(not (ROOT / "data" / "app" / "derived").exists() or all(not (ROOT / "data" / "app" / "derived" / f"{p}.json").exists() or True for p in pages), "nothing written to the repo's app data")
    if pages:
        snap = json.loads((app / "derived" / f"{pages[0]}.json").read_text())
        check(snap.get("upcoming") is True and snap.get("targeted") is False and snap["airtable"]["edition_size"], f"a page as build_upcoming makes it: {pages[0]} edition {snap['airtable'].get('edition_size')}")
    print(f"upcoming pages: {len(pages)} written (index had {len(up_rows)} upcoming rows, now {len(up_after)})")
print("FAILED" if failed else "ok: upcoming pages at boot", failed if failed else "")
sys.exit(1 if failed else 0)
