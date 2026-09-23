#!/usr/bin/env python3
"""SOURCES_PATH puts the pulled feeds on a disk that survives a deploy.

The server writes the funnel export, the events and browsing feeds and their
bookmarks, and the HubSpot sends, where SOURCES_PATH says; the ETL reads them
there, falling back to a checked-in copy (the HubSpot sends) while the disk
has none. Without the variable everything stays in the repo's sources/. Run:
  python3 tests/test_sources_path.py
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = ("node", "-e",
        "const b = require(process.argv[1]); const h = require(process.argv[2]);"
        "console.log(JSON.stringify({sources: b.SOURCES, across: b.ACROSS_TIME, meta: b.META, events: b.LE_EVENTS,"
        " browsing: b.LE_BROWSING, bmeta: b.BROWSING_META, hubspot: h.OUT || null}))",
        str(ROOT / "server" / "bigquery.js"), str(ROOT / "server" / "hubspot.js"))
PY = ("python3", "-c",
      "import sys, json; sys.path.insert(0, sys.argv[1]); import build, aggregate_events as a, release_features as rf;"
      "print(json.dumps({'sources': str(build.SOURCES), 'emails': str(build.source_file('all_sent_emails.csv')),"
      " 'funnel': str(build.source_file('across_time.csv')), 'export': str(a.EXPORT), 'rebuilt': str(a.REBUILT),"
      " 'rf_src': str(rf.SRC), 'rf_emails': str(rf.EMAILS)}))", str(ROOT / "etl"))


def run(cmd, env_extra):
    env = {k: v for k, v in os.environ.items() if k != "SOURCES_PATH"}
    env.update(env_extra)
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env, cwd=str(ROOT)).stdout
    return json.loads(out.strip().splitlines()[-1])


def test_paths() -> None:
    repo = str(ROOT / "sources")
    node, py = run(NODE, {}), run(PY, {})
    assert all(v.startswith(repo + "/") for k, v in node.items() if v and k != "sources"), node
    assert node["sources"] == repo and py["sources"] == repo and py["export"] == repo + "/across_time.csv"
    with tempfile.TemporaryDirectory() as d:
        disk = str(pathlib.Path(d) / "feeds")     # need not exist: the server creates it
        node, py = run(NODE, {"SOURCES_PATH": disk}), run(PY, {"SOURCES_PATH": disk})
        assert pathlib.Path(disk).is_dir(), "the server makes the directory"
        assert node["across"] == disk + "/across_time.csv" and node["meta"] == disk + "/across_time.meta.json"
        assert node["events"] == disk + "/le_events.csv" and node["browsing"] == disk + "/le_browsing.csv"
        assert node["bmeta"] == disk + "/le_browsing.meta.json"
        assert node["hubspot"] == disk + "/all_sent_emails.csv" or "HUBSPOT_CSV" in os.environ, node
        assert py["sources"] == disk and py["export"] == disk + "/across_time.csv" and py["rebuilt"] == disk + "/across_time.rebuilt.csv"
        assert py["rf_src"] == disk + "/across_time.csv"
        # the checked-in HubSpot sends stand in until the disk has a pull of its own
        assert py["emails"] == repo + "/all_sent_emails.csv" and py["rf_emails"] == repo + "/all_sent_emails.csv", py
        assert py["funnel"] == repo + "/across_time.csv"   # no copy on the disk yet: the repo's, if there is one
        pathlib.Path(disk, "all_sent_emails.csv").write_text("Email Name\n")
        pathlib.Path(disk, "across_time.csv").write_text("event_date\n")
        py = run(PY, {"SOURCES_PATH": disk})
        assert py["emails"] == disk + "/all_sent_emails.csv" and py["rf_emails"] == disk + "/all_sent_emails.csv"
        assert py["funnel"] == disk + "/across_time.csv"
    print("sources path: ok")


if __name__ == "__main__":
    test_paths()
