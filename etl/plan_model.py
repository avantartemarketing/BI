"""The plan model: what a launch's comms plan is worth, against a usual one.

A parallel reading to the campaign clock (docs/PLAN_MODEL.md), not yet on any
page. The clock says how far along a launch should be by today and projects
the rest on the shape past launches took, which quietly assumes the rest of
this launch's plan is the usual one. This module prices the plan itself:

  the price list   what a day with a given piece of comms going out brings,
                   in quiet days (an ordinary day after the announce with
                   nothing going out = 1): emails by kind and by the clicks a
                   send of that kind and size usually gets, Avant Arte's posts
                   and stories, the artist's, a partner's; how fast a piece
                   fades (an email over the four days after it, a post over
                   the next day); the deadline's own pull.
                   Fitted on every past draw launch with a plan on file, not
                   on a basket (etl/analysis/plan_backtest.py writes
                   etl/plan_prices.json; recomputing it is a deliberate act).
  a plan's value   the price list summed over a launch's days, done and to
                   come, so a launch's remaining plan can be set against what
                   it has already run.
  the forecast     the clock's figure for what is still to come, scaled by how
                   this launch's remaining plan compares with the usual
                   remaining plan at the same point (anchored): a usual plan
                   reads exactly as the clock does, a lighter one below it, a
                   heavier one above. How hard it scales (`gamma`) is chosen by
                   the back-test, and is well under 1: the price list is rough.
  one send         the clicks a send should get before it goes, from its kind,
                   its audience's size and its place in the campaign, and from
                   how this launch's earlier sends did against the same reading.

Everything here is demand outside paid: paid already runs on its budget, not
on the clock (docs/METHODOLOGY.md 6 and 7), and keeps its own model.

Only pandas and numpy, so the build can read it; the fitting needs scipy and
lives in the analysis script.
"""
from __future__ import annotations

import json
import os
import pathlib
import re

import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SOURCES = pathlib.Path(os.environ.get("SOURCES_PATH") or (ROOT / "sources"))
PRICES_PATH = ROOT / "etl" / "plan_prices.json"

# ---------------------------------------------------------------- constants
LEAD_DAYS = 14          # how far before the announce a launch's plan is read (the early access days)
ENTRY_RATE = 0.8        # an eligible entry unit counted as the page counts it (docs/METHODOLOGY.md 1)
MIN_DELIVERED = 100     # a send to fewer than this is a test or a hand-picked note, and is not priced
EMAIL_FADE_DAYS = 4     # an email is felt on its day and the four after (the back-test: longer tails fit no better)
POST_FADE_DAYS = 1      # a post is felt on its day and the next
CLICKS_REF = 100.0      # an email's value is priced per this many expected clicks

# the kinds of marketing email, read off a send's name (email_kind)
EMAIL_KINDS = ["early_access", "insiders", "announce", "sustain", "last_chance", "other"]
# the plan's families that carry a price: an email's is its expected clicks, the others' a count
EMAIL_COLS = ["em_early_access", "em_announce", "em_sustain", "em_last_chance", "em_other"]
POST_FAMILIES = ["aa_post", "aa_story", "aa_social_other", "artist_post", "artist_story", "artist_other", "partner"]
POST_COLS = ["pl_" + f for f in POST_FAMILIES]
VALUE_COLS = EMAIL_COLS + POST_COLS
# families the plan holds but the history is too thin to price (docs/PLAN_MODEL.md): counted, never valued
UNPRICED = ["sms", "press", "website"]

# a plan row's status, as the plan reads it. "Scheduled" on a day gone by went out: the
# team schedules a post and seldom comes back to mark it Live (2,870 past rows on 16
# November 2026 against 6,018 marked Live).
WENT = {"Live", "Scheduled", "Content ready"}
DROPPED = {"Not posted", "Cancelled", "On hold", "No content needed"}
# the share of planned rows of a family that went out, when the history cannot say (plan_reliability)
DEFAULT_RELIABILITY = {"artist_post": 0.73, "artist_story": 0.73, "artist_other": 0.63, "partner": 0.64}

_CODE = re.compile(r"([A-Za-z]+_[A-Za-z0-9]+_\d{2})(?![A-Za-z0-9])")
_TYPES = ("GEN", "CUS", "INS", "TRNS", "AUT", "FREQ", "TEST")


# ---------------------------------------------------------------- reading names
def email_type(name: object) -> str:
    """The send's type from its name's segment (build.load_emails' own reading)."""
    n = str(name or "")
    for t in _TYPES:
        if f"_{t}_" in n or n.startswith(f"{t}_"):
            return t
    return "OTHER"


def email_kind(name: object) -> str:
    """Which kind of launch email a send is, from the words after the dash in
    its name: early_access, insiders (the early access sent to Insiders),
    announce, sustain, last_chance, other, or after (a survey or a thank you,
    which sells nothing and is left out). Read by shape: the names are typed."""
    n = str(name or "").lower()
    d = n.split(" - ", 1)[1] if " - " in n else n
    if re.search(r"survey|thank you|event invite|miss\s?-?out|post[\s-]?launch|post[\s-]?purchase", d):
        return "after"
    if re.search(r"last\s*chance|final (call|day|hours)|48|24\s*h|closing|hours? left|reminder", d):
        return "last_chance"
    if re.search(r"insider", d):
        return "insiders"
    if re.search(r"early|exclusive|priority|private room|skip the draw|sneak|outreach|advisor|demand test", d):
        return "early_access"
    if re.search(r"announc", d):
        return "announce"
    if re.search(r"sustain|deep\s*-?dive|halfway|bundle|clue|follow", d):
        return "sustain"
    return "other"


def code_of(campaign: object, name: object = "") -> str | None:
    """The campaign code a send carries: the first code-shaped token in
    HubSpot's campaign name, else in the email's own name."""
    for s in (campaign, name):
        m = _CODE.search(str(s or ""))
        if m:
            return m.group(1)
    return None


def _norm(s: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


# ---------------------------------------------------------------- feeds
def load_comms(path: pathlib.Path | str | None = None) -> pd.DataFrame:
    """The Notion plan row by row (server/commsPlan.js writes it): empty when
    it has never been pulled."""
    p = pathlib.Path(path) if path else DATA / "notion_comms.csv"
    cols = ["campaign_code", "release", "date", "time", "channel", "channel_type", "family", "phase", "status",
            "name", "hubspot_id", "make_ready", "created", "edited"]
    if not p.exists():
        return pd.DataFrame({c: pd.Series(dtype=str) for c in cols})
    df = pd.read_csv(p, dtype=str).fillna("")
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return df[df["date"].notna()].reset_index(drop=True)


def load_campaigns(path: pathlib.Path | str | None = None) -> pd.DataFrame:
    """The Notion campaign list: a code, its release, its announce and launch days."""
    p = pathlib.Path(path) if path else DATA / "notion_comms_campaigns.csv"
    cols = ["campaign_code", "release", "announce", "launch", "mechanic", "status", "tier"]
    if not p.exists():
        return pd.DataFrame({c: pd.Series(dtype=str) for c in cols})
    df = pd.read_csv(p, dtype=str).fillna("")
    for c in ("announce", "launch"):
        df[c] = pd.to_datetime(df[c], errors="coerce")
    return df


def load_audiences(path: pathlib.Path | str | None = None) -> pd.DataFrame:
    """The HubSpot emails with their audiences (server/emailAudiences.js): one
    row per email, with its kind, its code and the day it went in Amsterdam
    time, which is the funnel's day. Sent and unsent alike; `sent` says which."""
    p = pathlib.Path(path) if path else SOURCES / "email_audiences.csv"
    if not p.exists():
        return pd.DataFrame()
    df = pd.read_csv(p, dtype=str).fillna("")
    for c in ("sent", "delivered", "opened", "clicked", "unsubscribed", "spam", "contacts_in"):
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    ts = pd.to_datetime(df["send_at"], errors="coerce", utc=True)
    df["ts"] = ts.dt.tz_convert("Europe/Amsterdam").dt.tz_localize(None)
    df["day"] = df["ts"].dt.normalize()
    df["type"] = df["name"].map(email_type)
    df["kind"] = df["name"].map(email_kind)
    df["code"] = [code_of(c, n) for c, n in zip(df["campaign"], df["name"])]
    df["went"] = df["delivered"] > 0
    df["n_lists"] = df["lists_in"].map(lambda s: len([x for x in str(s).split("|") if x]))
    return df


def marketing_sends(aud: pd.DataFrame, code: str, start, end) -> pd.DataFrame:
    """A campaign's launch emails that went out in a window: the GEN, CUS and
    INS sends to at least MIN_DELIVERED people, surveys and thank-yous left out."""
    if aud is None or aud.empty or not code:
        return pd.DataFrame(columns=list(aud.columns) if aud is not None else [])
    m = ((aud["code"] == code) & aud["type"].isin(["GEN", "CUS", "INS"]) & (aud["kind"] != "after") & aud["went"]
         & (aud["delivered"] >= MIN_DELIVERED) & (aud["day"] >= pd.Timestamp(start)) & (aud["day"] <= pd.Timestamp(end)))
    return aud[m].sort_values("ts").reset_index(drop=True)


def match_campaign_codes(launches: pd.DataFrame, campaigns: pd.DataFrame, days: int = 4) -> pd.DataFrame:
    """Give a launch the Notion campaign's code where the funnel's own guess
    found none: the campaign whose code begins with the artist's name and whose
    launch day is within `days` of the launch's close. Artist and date together,
    so an artist's two launches in a year cannot cross; two campaigns answering
    is no answer. `launches`: release_name, artist, campaign_code, launch_end."""
    out = launches.copy()
    if "code_from" not in out.columns:
        out["code_from"] = np.where(out["campaign_code"].notna() & (out["campaign_code"] != ""), "feeds", "")
    if campaigns is None or campaigns.empty:
        return out
    c = campaigns[campaigns["launch"].notna() & (campaigns["campaign_code"] != "")].copy()
    c["stub"] = c["campaign_code"].map(lambda s: _norm(str(s).split("_")[0]))
    for i, r in out.iterrows():
        has = isinstance(r["campaign_code"], str) and r["campaign_code"] != ""
        if has or pd.isna(pd.Timestamp(r["launch_end"]) if r["launch_end"] else pd.NaT):
            continue
        a, close = _norm(r["artist"]), pd.Timestamp(r["launch_end"])
        near = c[(c["launch"] - close).abs() <= pd.Timedelta(days=days)]
        fits = np.array([len(s) >= 4 and (a.startswith(s) or (len(s) >= 5 and s in a)) for s in near["stub"]], dtype=bool)
        codes = near.loc[fits, "campaign_code"].unique()
        if len(codes) == 1:
            out.at[i, "campaign_code"] = codes[0]
            out.at[i, "code_from"] = "notion"
    return out


# ---------------------------------------------------------------- the plan's rows
def plan_state(status: object, day, as_of) -> str:
    """What became of a plan row, read on `as_of`: done (it went out), planned
    (still to come), dropped (marked not posted or cancelled, or its day passed
    with nothing to say it went), or blank (a template row nobody filled in)."""
    s = str(status or "")
    d, today = pd.Timestamp(day), pd.Timestamp(as_of)
    if s in DROPPED:
        return "dropped"
    if s == "Not specced":
        return "blank" if d < today else "planned"
    if d < today:
        return "done" if s in WENT else "dropped"
    return "planned"


def plan_reliability(comms: pd.DataFrame, as_of, min_rows: int = 30) -> dict[str, float]:
    """The share of a family's planned rows that went out, from the rows whose
    day has passed: nearly all of Avant Arte's own, about three in four of an
    artist's posts. A family with fewer than `min_rows` reads its default."""
    out = dict(DEFAULT_RELIABILITY)
    if comms is None or comms.empty:
        return out
    past = comms[comms["date"] < pd.Timestamp(as_of)]
    for fam, g in past.groupby("family"):
        st = g["status"].map(lambda s: "done" if s in WENT else "dropped" if s in DROPPED else "")
        n = int((st != "").sum())
        if n >= min_rows:
            out[fam] = float((st == "done").sum() / n)
    return out


# ---------------------------------------------------------------- one send's clicks
def click_features(kind: str, delivered: float, t: int, days: int) -> np.ndarray:
    """The row a send gives the click model: a constant, its audience's size
    (log, centred on about 3,000 people), its kind, where it falls in the
    campaign (before the announce, the announce and the day after, the last
    two days, or between), and the announce's own slope on size."""
    size = np.log(max(float(delivered), 1.0)) - 8.0
    phase = "pre" if t < 0 else "announce" if t <= 1 else "close" if t >= days - 1 else "middle"
    row = [1.0, size]
    row += [1.0 if kind == k else 0.0 for k in EMAIL_KINDS[1:]]
    row += [1.0 if phase == p else 0.0 for p in ("announce", "middle", "close")]
    row.append(size if kind == "announce" else 0.0)
    return np.array(row)


CLICK_NAMES = (["const", "size"] + EMAIL_KINDS[1:] + ["phase_announce", "phase_middle", "phase_close", "announce_x_size"])


def expected_clicks(kind: str, delivered: float, t: int, days: int, coef, pull: float = 0.0) -> float:
    """The clicks a send should get: its audience times the rate its kind, size
    and timing usually see, lifted or lowered by `pull`, the launch's own
    record so far (launch_pull; 0 with none)."""
    rate = float(np.exp(click_features(kind, delivered, t, days) @ np.asarray(coef, dtype=float) + pull))
    return float(delivered) * min(rate, 1.0)


def launch_pull(residuals, weight: float = 1.0) -> float:
    """How a launch's earlier sends did against the usual reading, as one
    number to carry to its next send: the mean of their log misses, shrunk
    towards none by `weight` sends' worth (one send says little)."""
    r = [float(x) for x in residuals if x is not None and np.isfinite(x)]
    return float(sum(r) / (len(r) + weight)) if r else 0.0


def click_range(expected: float, spread) -> tuple[float, float]:
    """The range a send's clicks are quoted over: the middle half of how far
    past sends landed from their own reading (`spread`, two log quantiles)."""
    lo, hi = spread
    return float(expected * np.exp(lo)), float(expected * np.exp(hi))


# ---------------------------------------------------------------- a launch's days
def launch_days(announce, close, sends: pd.DataFrame | None, plan: pd.DataFrame | None, coef, as_of=None,
                reliability: dict | None = None, lead: int = LEAD_DAYS) -> pd.DataFrame:
    """One row per day from `lead` days before the announce to the close, with
    what the plan puts on it: an email's expected clicks under its kind (per
    CLICKS_REF), and the count of posts by family.

    `sends` are the emails that went out (marketing_sends) and, with `as_of`,
    the emails still to come as rows with a `day`, a `kind` and a `delivered`
    (the audience planned). `plan` is the launch's Notion rows; a row counts in
    full when it went out, at its family's reliability when it is still to
    come on `as_of`, and not at all when it was dropped. Without `as_of` the
    launch is read as finished: only what went out counts."""
    announce, close = pd.Timestamp(announce), pd.Timestamp(close)
    L = int((close - announce).days)
    days = pd.date_range(announce - pd.Timedelta(days=lead), close)
    out = pd.DataFrame({"date": days, "t": (days - announce).days, "L": L})
    for c in VALUE_COLS:
        out[c] = 0.0
    idx = {d: i for i, d in enumerate(days)}
    if sends is not None and len(sends):
        for _, s in sends.iterrows():
            i = idx.get(pd.Timestamp(s["day"]))
            if i is None or s["kind"] == "after":
                continue
            kind = s["kind"]
            col = "em_early_access" if kind in ("early_access", "insiders") else "em_" + kind
            t = int(out.at[i, "t"])
            out.at[i, col] += expected_clicks(kind, float(s["delivered"]), t, L, coef) / CLICKS_REF
    if plan is not None and len(plan):
        rel = reliability or DEFAULT_RELIABILITY
        for _, r in plan.iterrows():
            fam = r["family"]
            i = idx.get(pd.Timestamp(r["date"]))
            if i is None or fam not in POST_FAMILIES:
                continue
            state = plan_state(r["status"], r["date"], as_of) if as_of is not None else ("done" if r["status"] in WENT else "dropped")
            if state == "done":
                out.at[i, "pl_" + fam] += 1.0
            elif state == "planned":
                out.at[i, "pl_" + fam] += float(rel.get(fam, 1.0))
    return out


# ---------------------------------------------------------------- the price list
def load_prices(path: pathlib.Path | str | None = None) -> dict | None:
    p = pathlib.Path(path) if path else PRICES_PATH
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def fade_of(col: str, prices: dict) -> list[float]:
    """How much of a piece is still felt on each day after its own: an email's
    days and a post's days are fitted apart. A price list written before that
    (one `fade` for every piece) still reads."""
    key = "fade_email" if col.startswith("em_") else "fade_posts"
    return [float(x) for x in (prices.get(key) if prices.get(key) is not None else prices.get("fade") or [])]


def lagged(x: np.ndarray, fade: list[float]) -> np.ndarray:
    """A day-by-day series with each day's amount still felt, fading, on the days after it."""
    out = np.asarray(x, dtype=float).copy()
    for lag, f in enumerate(fade, 1):
        if lag < len(out) and f:
            out[lag:] += f * np.asarray(x, dtype=float)[:-lag]
    return out


def piece_values(days: pd.DataFrame, prices: dict, cols: list[str] | None = None) -> np.ndarray:
    """What the pieces in `cols` (every piece when None) bring each day, in
    quiet days: each on its own day and, fading, on the days after."""
    out = np.zeros(len(days))
    for c in (VALUE_COLS if cols is None else cols):
        w = float(prices["weights"].get(c, 0.0))
        if w:
            out += w * lagged(days[c].to_numpy(dtype=float), fade_of(c, prices))
    return out


def base_values(days: pd.DataFrame, prices: dict) -> np.ndarray:
    """What a day brings with nothing going out, in quiet days: 1 from the
    announce on, `pre` before it, and the deadline's own pull on the last two days."""
    t = days["t"].to_numpy()
    L = int(days["L"].iloc[0])
    return np.where(t >= 0, 1.0, float(prices["pre"])) + float(prices["close_day"]) * (t == L) + float(prices["day_before"]) * (t == L - 1)


def day_values(days: pd.DataFrame, prices: dict) -> np.ndarray:
    """Each day's value in quiet days: the baseline (1 from the announce on,
    `pre` before it), what goes out that day and what still lingers from the
    days before, and the deadline's own pull on the last two days."""
    return base_values(days, prices) + piece_values(days, prices)


def action_value(col: str, amount: float, prices: dict) -> float:
    """What one piece of comms adds over its day and the days it is still
    felt, in quiet days: `amount` posts of a family, or an email's expected
    clicks per CLICKS_REF."""
    return float(prices["weights"].get(col, 0.0)) * float(amount) * (1.0 + sum(fade_of(col, prices)))


def remaining_ratio(values, t, cut: int) -> float | None:
    """The value of the days after day `cut` over the value of the days up to
    it: how much of a plan is still ahead, against what it has already run."""
    v, t = np.asarray(values, dtype=float), np.asarray(t)
    done = float(v[t <= cut].sum())
    return float(v[t > cut].sum() / done) if done > 0 else None


def usual_ratio(prices: dict, stage: float) -> float | None:
    """The usual remaining ratio at a point of the campaign (`stage`, the share
    of the days from announce to close gone by): the median over the price
    list's launches, read between its grid points."""
    u = prices.get("usual") or {}
    xs, ys = u.get("stage") or [], u.get("ratio") or []
    if len(xs) < 2:
        return None
    return float(np.interp(float(stage), xs, ys))


def anchored(seen: float, clock_remainder: float, ratio: float | None, usual: float | None, gamma: float,
             limits: tuple[float, float] = (0.4, 2.5)) -> dict:
    """The plan's forecast: what has come in, plus the clock's figure for what
    is still to come scaled by how this launch's remaining plan compares with
    the usual one, to the power `gamma` (0 = the clock as it is, 1 = scaled in
    full). The scale is held inside `limits`: a plan read as ten times the
    usual one is a plan mis-read, not a launch about to sell ten times over.
    With no ratio to read the forecast is the clock's."""
    rem = max(float(clock_remainder), 0.0)
    if not ratio or not usual or usual <= 0 or ratio <= 0:
        return {"forecast": float(seen) + rem, "scale": 1.0, "against_usual": None}
    rel = float(ratio) / float(usual)
    scale = float(np.clip(rel ** float(gamma), limits[0], limits[1]))
    return {"forecast": float(seen) + rem * scale, "scale": scale, "against_usual": rel}
