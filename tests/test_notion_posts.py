#!/usr/bin/env python3
"""The two post sources: Notion where the log was being kept, Emplifi where it
was not, and the artist's account always from Notion."""
import datetime as dt
import pathlib
import sys

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "etl"))
from build import notion_covers, posts_in, social_block  # noqa: E402

D = dt.date


def notion(rows):
    return pd.DataFrame(rows, columns=["campaign_code", "date", "channel", "posts"])


def emplifi(rows):
    df = pd.DataFrame(rows, columns=["campaign_code", "Date", "Content type",
                                     "Total impressions", "Engagements"])
    df["Date"] = pd.to_datetime(df["Date"])
    return df


CONTENT = emplifi([
    ("A_LE_26", "2026-01-05", "post", 1000, 50),
    ("A_LE_26", "2026-01-06", "story", 400, 10),
    ("A_LE_26", "2026-01-07", "post", 900, 40),
    ("A_LE_26", "2026-03-20", "post", 100, 5),      # outside the window
    ("B_LE_26", "2026-01-05", "post", 700, 20),     # another release
])
NONE = notion([])

# --- no Notion rows in the window: the Emplifi export answers ----------------
s = social_block(CONTENT, NONE, "A_LE_26", D(2026, 1, 1), D(2026, 1, 31))
assert s["postsSource"] == "emplifi", s
assert s["posts"] == 2 and s["stories"] == 1, s
assert s["impressions"] == 2300 and s["engagements"] == 100, s
assert s["artistPosts"] is None, s        # no log at all, so not a zero

# --- Notion logging during the window: it wins, for every release -----------
LOG = notion([
    ("A_LE_26", D(2026, 1, 4), "brand", 3),
    ("A_LE_26", D(2026, 1, 9), "brand", 2),
    ("A_LE_26", D(2026, 1, 9), "artist", 4),
    ("A_LE_26", D(2026, 1, 9), "partner", 7),
    ("A_LE_26", D(2026, 2, 2), "brand", 9),         # outside the window
    ("B_LE_26", D(2026, 1, 9), "brand", 6),         # another release
])
s = social_block(CONTENT, LOG, "A_LE_26", D(2026, 1, 1), D(2026, 1, 31))
assert s["postsSource"] == "notion", s
assert s["posts"] == 5, s                  # brand only, in window, this release
assert s["stories"] == 0, s                # Notion records no format
assert s["artistPosts"] == 4, s            # the artist's account, not the brand's
assert s["impressions"] == 2300, s         # still the export's, unchanged

# a release the log covers but nobody posted for is a real zero, not a fallback
s = social_block(CONTENT, LOG, "C_LE_26", D(2026, 1, 1), D(2026, 1, 31))
assert s["postsSource"] == "notion" and s["posts"] == 0 and s["artistPosts"] == 0, s

# ... and a window the log does not reach falls back even though it has rows
s = social_block(CONTENT, LOG, "A_LE_26", D(2025, 1, 1), D(2025, 1, 31))
assert s["postsSource"] == "emplifi" and s["posts"] == 0, s
assert s["artistPosts"] == 0, s            # the log exists, so zero is a figure

# --- partner posts are carried but claimed by neither rung ------------------
assert posts_in(LOG, "A_LE_26", "partner", D(2026, 1, 1), D(2026, 1, 31)) == 7
assert s["posts"] != 7 and s["artistPosts"] != 7

# --- the legacy file, which has no channel column, reads as all artist ------
old = notion([("A_LE_26", D(2026, 1, 9), "artist", 4)])
assert posts_in(old, "A_LE_26", "artist", D(2026, 1, 1), D(2026, 1, 31)) == 4
assert posts_in(old, "A_LE_26", "brand", D(2026, 1, 1), D(2026, 1, 31)) == 0

# --- coverage is any row, any release, any channel --------------------------
assert notion_covers(LOG, D(2026, 1, 1), D(2026, 1, 31)) is True
assert notion_covers(LOG, D(2026, 6, 1), D(2026, 6, 30)) is False
assert notion_covers(NONE, D(2026, 1, 1), D(2026, 1, 31)) is False
assert notion_covers(None, D(2026, 1, 1), D(2026, 1, 31)) is False

# --- a release with no campaign code can only be the export ----------------
s = social_block(CONTENT, LOG, None, D(2026, 1, 1), D(2026, 1, 31))
assert s["posts"] == 0 and s["artistPosts"] == 0, s

print("notion posts: all cases ok")
