/* The dashboard shell - sidebar, release page chrome, and the one place the page's
 * comparison horizon lives.
 *
 * A single "Compare Today | At close" control in the page header is handed to
 * every container, so no card carries its own horizon toggle and the whole page
 * reads one moment at a time. It resets whenever the release changes, because a
 * horizon chosen while reading one launch says nothing about the next one. Both
 * references - target and benchmark - are on every card at once (BENCHMARK_SPEC
 * 7), so there is nothing else to choose up here.
 *
 * The sidebar dot is the other thing this file owns. BENCHMARK_SPEC 7 makes it
 * three-state so that "behind target but still doing what the matched basket
 * typically does" stops looking identical to "behind the basket as well" - the first
 * is a target worth holding, the second is a launch in trouble. */
import React, { useEffect, useMemo, useState } from "react";
import { initial as watchInitial, step as watchStep } from "../../shared/refreshWatch.mjs";
import { freshness, TONE_COLOR } from "../../shared/freshness.mjs";
import { C, fmt, fmtSigned, fmtPct, fmtDay, TipProvider, useTip } from "./ui.jsx";
import HeroBar from "./modules/HeroBar.jsx";
import LaunchStrip from "./modules/LaunchStrip.jsx";
import ChannelsVsTargets from "./modules/ChannelsVsTargets.jsx";
import FunnelByChannel, { FunnelByChannelWide } from "./modules/FunnelByChannel.jsx";
import Trajectory from "./modules/Trajectory.jsx";
import KeyDrivers from "./modules/KeyDrivers.jsx";
import PaidRoi from "./modules/PaidRoi.jsx";
import PaidSpend from "./modules/PaidSpend.jsx";
import Framing from "./modules/Framing.jsx";
import SellThrough from "./modules/SellThrough.jsx";
import Geo from "./modules/Geo.jsx";
import DrawAudit from "./modules/DrawAudit.jsx";
import Waterfall from "./modules/Waterfall.jsx";
import NoTargets from "./modules/NoTargets.jsx";
import Upcoming from "./modules/Upcoming.jsx";
import TargetSetting from "./TargetSetting.jsx";
import TLTargets from "./TLTargets.jsx";
import { TLChips, TLSignupsOutcome } from "./TLPage.jsx";
import SellForecast from "./modules/SellForecast.jsx";
import BasketCard from "./modules/BasketCard.jsx";
import Permissions from "./Permissions.jsx";
import { PageLayout, LayoutBar, useLayout } from "./Layout.jsx";
import { wordsOf } from "./vocab.mjs";
import { ExplainProvider, ExplainHint, Ex } from "./explain/Explain.jsx";

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const e = new Error(body.error || `${url}: ${r.status}`);
    e.pending = !!body.pending;
    throw e;
  }
  return r.json();
}

const STATUS_LABEL = { live: "in flight", upcoming: "upcoming", closed: "closed", catalogue: "catalogue" };

/* Search across every release the funnel data mentions - artist, title,
 * quarter (the name's and the one it closes in), campaign code or id -
 * keeping the index's own order (in flight, then closed most recent first,
 * then catalogue by traffic). */
function searchReleases(releases, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/);
  return releases.filter((r) => {
    const hay = `${r.name} ${r.releaseName} ${r.quarter || ""} ${closeQuarter(r) || ""} ${r.id}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/* The quarter a dated release closes in ("2026 Q4"), from its window end.
 * The quarter in a release's name is the funnel export's and can disagree. */
function closeQuarter(r) {
  if (!r.windowEnd) return null;
  const d = new Date(r.windowEnd + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export default function App() {
  const [index, setIndex] = useState(null);
  const [releaseId, setReleaseId] = useState(null);
  const [snap, setSnap] = useState(null);
  const [snapError, setSnapError] = useState(null); // { message, pending } for the selected release only
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null); // { email, admin }
  const [view, setView] = useState("release"); // "release" | "permissions" (app-level, not per-release)
  const [query, setQuery] = useState("");
  const st = useRefreshStatus();

  useEffect(() => {
    fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);

  const loadIndex = () => getJSON("/api/index").then((ix) => { setIndex(ix); return ix; });
  useEffect(() => {
    loadIndex().then((ix) => {
      // ?release=<id> (the link in a Slack update) opens that release; else the first live one
      const asked = new URLSearchParams(window.location.search).get("release");
      const live = ix.releases.filter((r) => r.status === "live" || (!r.status && !r.complete));
      const first = ix.releases.find((r) => r.id === asked) || live[0] || ix.releases[0];
      setReleaseId(first?.id ?? null);
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!releaseId) return;
    setSnap(null); setSnapError(null);
    getJSON(`/api/releases/${releaseId}`).then(setSnap)
      .catch((e) => setSnapError({ message: e.message, pending: !!e.pending }));
  }, [releaseId]);

  // a save that sets targets promotes the release: swap the page in and
  // refresh the index so the sidebar's dot and status follow
  // a save's rebuild lands whenever it lands, and the reader may have moved
  // to another release by then: only the page on screen is swapped
  const onScreen = React.useRef(releaseId);
  useEffect(() => { onScreen.current = releaseId; }, [releaseId]);
  const onSaved = (s) => { if (s && s.id === onScreen.current) setSnap(s); loadIndex().catch(() => {}); };
  // a refresh landed: pull the current page and the index again
  const onRefreshed = () => {
    loadIndex().catch(() => {});
    if (releaseId) getJSON(`/api/releases/${releaseId}`).then(setSnap).catch(() => {});
  };

  const groups = useMemo(() => {
    if (!index) return { live: [], upcoming: [], all: [] };
    const all = index.releases.map((r) => ({ ...r, status: r.status || (r.complete ? "closed" : "live") }));
    // in flight reads top to bottom by days to launch; a release whose window
    // has not opened yet sits under the ones that have, soonest first
    const order = (r) => {
      const c = releaseClock(r, index.asOf);
      if (!c) return Infinity;
      return c.opensIn > 0 ? 1e6 + c.opensIn : c.daysLeft;
    };
    const live = all.filter((r) => r.status === "live").sort((a, b) => order(a) - order(b));
    // the launches Airtable knows and the funnel does not yet, soonest close first
    const upcoming = all.filter((r) => r.status === "upcoming").sort((a, b) => String(a.windowEnd || "").localeCompare(String(b.windowEnd || "")));
    return { live, upcoming, all };
  }, [index]);
  // an artist with two rows among those listed (Ai Weiwei's LE and timed
  // launch of one quarter; her seven launches in a search): their rows keep
  // the rest of the name (rowWords)
  const twins = useMemo(() => twinSet([...groups.live, ...groups.upcoming]), [groups]);
  const results = useMemo(() => searchReleases(groups.all, query), [groups, query]);
  const resultTwins = useMemo(() => twinSet(results), [results]);
  const current = groups.all.find((r) => r.id === releaseId);
  const pinned = current && current.status !== "live" && current.status !== "upcoming" && view === "release" ? current : null;

  if (error) return <div style={{ padding: 40 }}>Failed to load: {error}</div>;
  const pick = (id) => {
    setReleaseId(id); setView("release");
    // keep the address in step so the page can be shared or reloaded on this release
    try { window.history.replaceState(null, "", `?release=${encodeURIComponent(id)}`); } catch { /* not important */ }
  };

  return (
    <TipProvider>
    <div className="app">
      <nav className="sidebar">
        <h1>Launch Performance</h1>
        <div className="section-label split">In flight{groups.live.length > 0 && <small>days to close</small>}</div>
        {groups.live.length === 0 && <div className="hint">Nothing in flight</div>}
        {groups.live.map((r) => <ReleaseRow key={r.id} r={r} asOf={index?.asOf} twin={twins.has(artistOf(r))} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} />)}
        {groups.upcoming.length > 0 && (
          <>
            <div className="section-label split" title="Launches Airtable knows and the funnel report does not yet - set their targets before they open">Upcoming<small>days to open</small></div>
            {groups.upcoming.map((r) => <ReleaseRow key={r.id} r={r} asOf={index?.asOf} twin={twins.has(artistOf(r))} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} />)}
          </>
        )}
        {pinned && (
          <>
            <div className="section-label">Viewing</div>
            <ReleaseRow r={pinned} asOf={index?.asOf} active onClick={() => pick(pinned.id)} />
          </>
        )}
        <div className="section-label">All releases</div>
        <input
          className="sidebar-search"
          type="search"
          placeholder={`Search ${groups.all.length} releases…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search releases"
        />
        {query.trim() && results.length === 0 && <div className="hint">No release matches</div>}
        {results.slice(0, 30).map((r) => <ReleaseRow key={r.id} r={r} asOf={index?.asOf} twin={resultTwins.has(artistOf(r))} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} />)}
        {results.length > 30 && <div className="hint">{results.length - 30} more - keep typing</div>}
        {me?.admin && (
          <>
            <div className="section-label">Settings</div>
            <button
              className={`release-row${view === "permissions" ? " active" : ""}`}
              onClick={() => setView("permissions")}
              title="Manage who can sign in to the dashboard"
            >
              <span className="nm">Permissions</span>
            </button>
          </>
        )}
        <div style={{ marginTop: 20, padding: "0 12px" }}>
          <a href="/methodology" target="_blank" rel="noreferrer"
            style={{ fontSize: 11.5, color: "#6c6b68", textDecoration: "none" }}
            title="How every target is derived - the full target-setting methodology">
            Methodology ↗
          </a>
        </div>
        <SessionFooter email={me?.email} />
      </nav>
      <main className="content">
        {view === "permissions" && me?.admin ? <Permissions me={me} /> :
          snap ? <ReleasePage snap={snap} onSaved={onSaved} st={st} onRefreshed={onRefreshed} index={groups.all} onOpen={pick} /> :
          snapError ? (
            <div style={{ color: "#6c6b68", maxWidth: 520, lineHeight: 1.5 }}>
              {snapError.pending
                ? <><b style={{ color: "#141413" }}>{current?.name || "This release"}</b> is listed but its page has not been built yet - the first data refresh after a deploy takes a few minutes. Try again shortly.</>
                : <>Could not load this release: {snapError.message}</>}
            </div>
          ) : <div style={{ color: "#6c6b68" }}>Loading…</div>}
      </main>
    </div>
    </TipProvider>
  );
}

function SessionFooter({ email }) {
  if (!email) return null;
  return (
    <div style={{ marginTop: 24, padding: "10px 12px", borderTop: "1px solid #f2f0ea", fontSize: 11.5, color: "#6c6b68", display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={email}>{email}</span>
      <a href="/auth/logout" style={{ color: "#6c6b68" }}>Sign out</a>
    </div>
  );
}

/* BENCHMARK_SPEC 7: the row dot is green at or ahead of target, amber behind target
 * but at or ahead of benchmark, red behind benchmark, hollow when nobody has set
 * targets. benchmarkPct is secured against the benchmark's own pace for today, so
 * the middle band is that sign and nothing else. Releases still on the lever model
 * carry no benchmarkPct: there the shortfall against target is all there is, and a
 * release within 10% of it is called amber rather than red. 1/K moves from +15% to
 * -54% across the launches on file, which is why the fixed boundary is only ever
 * the fallback. */
const BEHIND_TARGET_TOLERANCE = -0.10;
const STATE = {
  green: { color: C.green, word: "at or ahead of target" },
  amber: { color: C.amber, word: "behind target, at or ahead of benchmark" },
  red: { color: C.red, word: "behind benchmark" },
};

function rowState(r) {
  if (r.targeted === false) return null; // hollow: nothing to be ahead or behind of
  const pct = r.statusPct;
  if (pct === null || pct === undefined) return r.ok ? "green" : "red";
  if (pct >= 0) return "green";
  const bm = r.benchmarkPct;
  if (bm === null || bm === undefined) return pct >= BEHIND_TARGET_TOLERANCE ? "amber" : "red";
  return bm >= 0 ? "amber" : "red";
}

/* The sidebar's clock for a dated release, from the index alone: the launch is
 * the window's end, the announce date sits `of` days before it, and the build
 * date says how far each is. A release whose announce is still ahead has not
 * opened and lists after the ones in flight. */
function releaseClock(r, asOf) {
  if (!r.windowEnd || !(r.of > 0)) return null;
  const launch = new Date(r.windowEnd + "T00:00:00Z");
  const announce = new Date(launch.getTime() - r.of * 86400000);
  const today = asOf ? new Date(asOf + "T00:00:00Z") : null;
  const days = (a, b) => Math.round((a - b) / 86400000);
  return {
    launch, announce,
    daysLeft: today ? days(launch, today) : r.of - (r.day || 0),
    opensIn: today ? days(announce, today) : 0,
  };
}

/* A release's name as a sidebar row sets it (5 October 2026): the artist,
 * then a real title in grey; "Multiple" and the quarter are left to the
 * hover, which carries the full name. An artist with two rows in the list
 * (`twin`) keeps the rest of the name on those rows, "timed" added for a
 * timed launch, since the artist alone would not say which launch a row was
 * (Ai Weiwei's LE and TL of one quarter). Before, the full name wrapped over
 * two lines above a date, and the list ran to two screens. */
const QUARTER_RE = /^\d{4} Q\d$/;
const nameParts = (r) => String(r.releaseName || r.name || r.artist || "").split(" \u00b7 ").map((p) => p.trim()).filter(Boolean);
const artistOf = (r) => nameParts(r)[0] || "";
/* the artists with more than one row in a list: their rows keep the whole name */
function twinSet(rows) {
  const n = new Map();
  for (const r of rows) n.set(artistOf(r), (n.get(artistOf(r)) || 0) + 1);
  return new Set([...n].filter(([, c]) => c > 1).map(([a]) => a));
}
function rowWords(r, twin) {
  const [artist, ...rest] = nameParts(r);
  const kept = twin ? [...(r.type === "TL" ? ["timed"] : []), ...rest] : rest.filter((p) => p !== "Multiple" && !QUARTER_RE.test(p));
  return { artist: artist || "", rest: kept.join(" \u00b7 ") };
}

/* One release in the sidebar: the status dot, the artist (a real title in
 * grey after it) on one line, and the days on the right, with a grey verb
 * before the count where it does not run to the section's own event (the
 * close in flight, the open upcoming): "opens" on a timed launch taking
 * signups, "announces" on one before its announce, "closes" on an upcoming
 * launch whose announce has passed. The date is in the hover with the
 * day-of-window and the pace; a date outside the page's year carries its
 * year, since a date without one put a launch of two Novembers ago beside
 * this spring's. The dot's meaning is its Pace row rather than a key under
 * the list. */
function ReleaseRow({ r, asOf, active, onClick, twin = false }) {
  const t = useTip();
  const targeted = r.targeted !== false;
  const state = rowState(r);
  const status = r.status || (r.complete ? "closed" : "live");
  const clock = status === "catalogue" ? null : releaseClock(r, asOf);
  const pct = targeted && r.statusPct !== null && r.statusPct !== undefined ? Math.round(r.statusPct * 100) : null;
  const rows = [];
  if (status !== "catalogue") rows.push({ label: "Day", value: `${r.day} of ${r.of}` });
  if (pct !== null) rows.push({ label: "vs target", value: `${pct >= 0 ? "+" : ""}${pct}%`, color: STATE[state].color });
  const bmPct = targeted && r.benchmarkPct !== null && r.benchmarkPct !== undefined ? Math.round(r.benchmarkPct * 100) : null;
  if (bmPct !== null) rows.push({ label: "vs benchmark", value: `${bmPct >= 0 ? "+" : ""}${bmPct}%` });
  if (state) rows.push({ label: "Pace", value: STATE[state].word, color: STATE[state].color });
  rows.push({ label: "Status", value: STATUS_LABEL[status] || status });
  if (r.quarter) rows.push({ label: "Quarter", value: r.quarter });
  // the name's quarter is upstream's; where the window closes in another, say so
  const closesIn = status === "catalogue" ? null : closeQuarter(r);
  if (closesIn && closesIn !== r.quarter) rows.push({ label: "Closes in", value: closesIn, color: C.amber });
  // an upcoming launch whose window Airtable says has opened, with nothing in the funnel yet, does not "open soon"
  if (!targeted) rows.push({ label: "Targets", value: status !== "upcoming" ? "not set - actuals only"
    : clock && clock.opensIn > 0 ? "not set - opens soon" : "not set - announce passed, no funnel rows yet" });
  if (status === "catalogue" && r.lastSeen) rows.push({ label: "Last traffic", value: r.lastSeen });
  const content = { head: r.releaseName || r.name, rows };
  // a day, with its year where that is not the page's own year
  const thisYear = asOf ? Number(String(asOf).slice(0, 4)) : new Date().getUTCFullYear();
  const on = (d) => (d.getUTCFullYear() === thisYear ? fmtDay(d) : `${fmtDay(d)} ${d.getUTCFullYear()}`);

  // the figure on the right, the verb before it where the count is not to
  // the section's own event, and the date for the hover
  let when, count = null, verb = null;
  if (!clock) when = status === "closed" ? "Closed" : "Catalogue";
  else if (status === "upcoming" && clock.opensIn > 0) { when = `Opens ${on(clock.announce)}`; count = clock.opensIn; }
  else if (status === "upcoming") { when = `Closes ${on(clock.launch)}`; count = Math.max(clock.daysLeft, 0); verb = "closes"; }
  else if (clock.opensIn > 0) { when = `Opens ${on(clock.announce)}`; count = clock.opensIn; verb = "opens"; }
  else if (status === "closed") when = `Closed ${on(clock.launch)}`;
  else { when = `Closes ${on(clock.launch)}`; count = Math.max(clock.daysLeft, 0); }
  // a launch whose works close on different days names each close; the
  // count on the right is to the last (docs 1.6)
  if (status !== "closed" && Array.isArray(r.closes) && r.closes.length > 1) {
    when = `Closes ${r.closes.map((d) => on(new Date(d + "T00:00:00Z"))).join(" · ")}`;
  }
  // a timed launch's row says its state in words (docs/TL_SPEC.md §9): the
  // days to the sales open while signups are watched, the hours left while
  // the window is open, settling or closed after it; read on the clock, since
  // a window is hours long and the index is rebuilt every refresh
  let unit = "d";
  if (r.type === "TL") {
    const nowMs = Date.now();
    const label = r.tlLabel ? r.tlLabel.charAt(0).toUpperCase() + r.tlLabel.slice(1) : null;
    if (r.tlState === "signups" || r.tlState === "upcoming") {
      // the days to the sales open while signups are watched, to the announce before it
      const toMs = r.tlState === "upcoming" && r.windowStart ? Date.parse(r.windowStart + "T00:00:00Z") : r.salesOpen ? Date.parse(r.salesOpen) : NaN;
      when = label || when;
      count = Number.isFinite(toMs) ? Math.max(Math.ceil((toMs - nowMs) / 86400000), 0) : null;
      verb = r.tlState === "upcoming" ? "announces" : "opens";
    } else if (r.tlState === "window") {
      const closeMs = r.windowClose ? Date.parse(r.windowClose) : NaN;
      when = label || when;
      count = Number.isFinite(closeMs) ? Math.max(Math.ceil((closeMs - nowMs) / 3600000), 0) : null;
      unit = "h";
      verb = "closes";
    } else {
      when = label || when;
      count = null;
    }
    rows.splice(rows.findIndex((x) => x.label === "Status"), 1, { label: "Status", value: r.tlLabel || r.tlState });
  }
  // the date, under the status in the hover ("Closes 14 Oct"), now that the
  // row no longer carries it; a timed launch's status row already has its words
  if (clock && r.type !== "TL") {
    const [word, ...date] = String(when).split(" ");
    if (date.length) rows.splice(rows.findIndex((x) => x.label === "Status") + 1, 0, { label: word, value: date.join(" ") });
  }
  const words = rowWords(r, twin);
  return (
    <button className={`release-row${active ? " active" : ""}`} onClick={onClick} {...t.props(content)}>
      {state
        ? <span className="dot" style={{ background: STATE[state].color }} />
        : <span className="dot hollow" />}
      <span className="nm">{words.artist}{words.rest && <span className="rest"> · {words.rest}</span>}</span>
      {count !== null && <span className="left">{verb && <small className="verb">{verb}</small>}{count}<small>{unit}</small></span>}
      {clock && clock.opensIn > 0 && count === null && <span className="left none">·</span>}
    </button>
  );
}

/* The server's refresh status, polled every 5 minutes (every 15 s while a
 * refresh is in flight). undefined = still asking, null = could not read it. */
function useRefreshStatus() {
  const [st, setSt] = useState(undefined);
  useEffect(() => {
    let live = true;
    const poll = () => fetch("/api/refresh/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setSt(d); })
      .catch(() => { if (live) setSt(null); });
    poll();
    const id = setInterval(poll, 5 * 60 * 1000);
    return () => { live = false; clearInterval(id); };
  }, []);
  useEffect(() => {
    if (!st || !st.running) return;
    const id = setInterval(() => fetch("/api/refresh/status")
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setSt(d); }).catch(() => {}), 15 * 1000);
    return () => clearInterval(id);
  }, [st && st.running]);
  return st;
}

/* A page built from data older than the last full day is the committed
 * fallback (served after a deploy until the first refresh lands) or the
 * product of a refresh that has been failing. Both looked like "the numbers
 * are just low". Say which, how far behind, and what the refresh is doing
 * about it, with the time it started. Data through yesterday is normal until
 * the first refresh of the day and is not flagged. */
function StaleBanner({ asOf, st, onRefreshed }) {
  // whole days between the data's last day and today, on the calendar the
  // reader is on: through the 21st read on the 23rd is two days behind
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const ageDays = asOf ? Math.round((today - new Date(asOf + "T00:00:00Z").getTime()) / 86400000) : 0;
  /* "this page reloads when it lands", below, has to hold for the first refresh
     after a deploy as well as for the hourly ones - the rule and why it is not
     the timestamp are in shared/refreshWatch.mjs. */
  const watch = React.useRef(watchInitial());
  useEffect(() => {
    const r = watchStep(watch.current, st);
    watch.current = r.state;
    if (r.reload) onRefreshed();
  }, [st && st.at, st && st.running]);
  if (ageDays < 2) return null;
  const through = fmtDay(new Date(asOf + "T00:00:00Z"), true);
  const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  let what;
  if (st === undefined) what = "Checking whether a refresh is running…";
  else if (st && st.running) what = `A refresh started at ${clock(st.runningSince)} is running now; this page reloads itself when it lands. ` +
    "The first refresh after a deploy takes several minutes.";
  else if (st && st.at && st.ok === false) {
    const failing = [st.etl, st.bigquery, st.sheet, st.airtable, st.notion, st.emails].map((v) => String(v || ""))
      .find((v) => /failed|misconfigured|stale/i.test(v)) || String(st.etl || st.bigquery || st.sheet || "");
    what = `The last refresh, at ${clock(st.at)}, failed: ${failing.slice(0, 160)}`;
  }
  else if (st && st.at) what = `The last refresh, at ${clock(st.at)}, succeeded but did not move this page - the source feed may not have newer rows for it.`;
  else what = "No refresh has completed since the app started - the first one after a deploy takes several minutes.";
  return (
    <div role="status" style={{ margin: "14px 0 0", padding: "10px 14px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a",
                                borderLeft: "3px solid #8a5f00", fontSize: 13, lineHeight: 1.5 }}>
      <b>Built from data through {through}, {ageDays} days behind.</b> {what}
    </div>
  );
}

/* Every card counts units paid from the orders table, each order on the
 * channel of its purchase event (docs 6.3). An order the funnel never saw
 * still counts, on Untracked, but nothing says where it came from. When that
 * is more than a sliver of the window, the channel split is short of
 * evidence and the purchase tag is the thing to check: say so, with the
 * count. The threshold is the build's (NO_EVENT_WARN_SHARE, _MIN). */
function CoverageBanner({ noEvent }) {
  if (!noEvent || !noEvent.high) return null;
  const pct = Math.round((noEvent.share || 0) * 100);
  return (
    <div role="status" style={{ margin: "14px 0 0", padding: "10px 14px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a",
                                borderLeft: "3px solid #8a5f00", fontSize: 13, lineHeight: 1.5 }}>
      <b>{fmt(noEvent.count)} of {fmt(noEvent.total)} units paid ({pct}%) have no purchase event.</b> They count in
      every total, on Untracked and shared out over the tracked channels, but their own channel is unknown - the
      purchase tag may be missing on part of checkout.
    </div>
  );
}

/* The header's freshness line: the page's own age first (the day its data
 * runs to, when it was built), the pipeline's health second, in words a
 * reader can act on. It used to read the refresh's failure flag alone, so a
 * page rebuilt an hour ago read "Sources stale" because a later step of the
 * refresh had failed. The rule is shared/freshness.mjs, which
 * tests/freshness.mjs runs through its states; this only renders it. */
function Freshness({ asOf, st, emailThrough, partial, builtAt, funnelNote }) {
  const t = useTip();
  const f = freshness({ asOf, partial, builtAt, st, emailThrough, funnelNote });
  return (
    <span className="freshness" style={{ color: TONE_COLOR[f.tone] }} {...t.props({ head: f.head, body: f.body, rows: f.rows })}>
      {f.warn && <span aria-hidden="true">⚠ </span>}
      {f.label}
    </span>
  );
}

/* One control, every container. Today reads actuals against the target and
 * benchmark for today; At close reads the projection against the target and
 * benchmark for the whole campaign. Cards with a single horizon - the funnels,
 * paid ROI, geo - ignore it and are not given it. */
function HorizonToggle({ horizon, onChange, closeLabel = "At close" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 12, color: "#6c6b68" }}>Compare</span>
      <div className="seg" role="group" aria-label="Comparison horizon">
        <button
          className={horizon === "today" ? "active" : ""}
          onClick={() => onChange("today")}
          title="Actuals so far against the target and benchmark for today">Today</button>
        <button
          className={horizon === "close" ? "active" : ""}
          onClick={() => onChange("close")}
          title={`Projection ${closeLabel.toLowerCase()} against the target and benchmark for the campaign`}>{closeLabel}</button>
      </div>
    </div>
  );
}

/* Direct as a channel of its own, or spread over the others (docs §1.3).
 * The ETL builds every page both ways and the blocks that differ ride under
 * snap.variants.direct_spread; laying them over the snapshot here makes the
 * switch instant and puts every card on the same attribution. It is a
 * methodology choice, not a reading of one launch, so it sticks per browser. */
const DIRECT_PREF = "directSpread";
// where the header's marketing lead chip read the name from (the snapshot's inputSources, docs 1.6)
const LEAD_FROM = { notion: " · from the Notion log", airtable: " · from Airtable", typed: " · typed on the Target setting tab" };
const readDirectPref = () => { try { return localStorage.getItem(DIRECT_PREF) === "1"; } catch { return false; } };
function DirectToggle({ on, onChange, share, snap }) {
  const pct = (x) => (x === null || x === undefined ? "–" : Math.round(100 * x) + "%");
  const W = wordsOf(snap);
  // a timed launch's switch speaks of signups before its window and units inside it (docs/TL_SPEC.md §3b)
  const tip = W.tl
    ? `Direct is ${pct(share && (W.state === "signups" ? share.signups : share.units))} of this launch's ${W.state === "signups" ? "signups" : "units"} and ${pct(share && share.sessions)} of its sessions as the feed attributes them. `
      + `Spread shares Direct out over the other channels in proportion to their own volumes, ${W.stepWord} by ${W.stepWord}, and reads the basket's launches the same way. `
      + "Totals, the signup target, what has been sold, the paid budget and the sell-through forecast do not move; the plan's split by channel follows the basket, and paid reads the signups it is given, at a cost rescaled to them."
    : `Direct is ${pct(share && share.entries)} of this release's entries and ${pct(share && share.units)} of its units as the funnel attributes them. `
      + "Spread shares Direct out over the other channels in proportion to their own volumes, day by day, and reads the benchmark's channel split the same way. "
      + "Totals, what has been sold and the paid budget do not move; the plan's pace and the projections can shift a little with the channel mix, and paid reads the entries it is given, at a cost per unit rescaled to them.";
  const spreadTitle = W.tl
    ? "Direct's sessions, signups and units are shared out over the other channels in proportion to their own"
    : "Direct's sessions, entries and units are shared out over the other channels in proportion to their own";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={tip}>
      <span style={{ fontSize: 12, color: "#6c6b68" }}>Direct</span>
      <div className="seg" role="group" aria-label="Direct attribution">
        <button className={on ? "" : "active"} onClick={() => onChange(false)}
          title={W.tl ? "Direct stays a channel of its own, as the TL feed attributes it" : "Direct stays a channel of its own, as the funnel export attributes it"}>Channel</button>
        <button className={on ? "active" : ""} onClick={() => onChange(true)} title={spreadTitle}>Spread</button>
      </div>
    </div>
  );
}

function ReleasePage({ snap, onSaved, st, onRefreshed, index, onOpen }) {
  const [tab, setTab] = useState("overview");
  const [horizon, setHorizon] = useState("today");
  const [directSpread, setDirectSpreadState] = useState(readDirectPref);
  const setDirectSpread = (v) => { setDirectSpreadState(v); try { localStorage.setItem(DIRECT_PREF, v ? "1" : "0"); } catch { /* per-browser convenience only */ } };
  const variant = snap.variants && snap.variants.direct_spread;
  // the page the cards read: the snapshot, or the snapshot with Direct spread
  const view = useMemo(() => (directSpread && variant ? { ...snap, ...variant } : snap), [snap, variant, directSpread]);
  // a new release is a new reading: start it on the tab and the horizon everyone shares
  useEffect(() => { setTab("overview"); setHorizon("today"); }, [snap.id]);
  const targeted = snap.targeted !== false;
  const catalogue = !!snap.catalogue;
  const upcoming = !!snap.upcoming;
  // a timed launch (docs/TL_SPEC.md §4, §5): the LE cards on the shared
  // layout, in the state's words - signups before its window, units inside
  // it - with its own chips, clock strip and target setting
  const isTL = snap.type === "TL";
  // nothing to compare against without targets, and a catalogue page has no campaign
  const showHorizon = targeted && !catalogue;

  /* The page's arrangement is shared and editable (Layout.jsx), so the cards
   * are rendered by key in whatever order the layout says. A card a release has
   * nothing for is left out of its page. Without targets every card is on its
   * actual side, and the cards that only exist relative to a plan say so in
   * place. */
  const layout = useLayout();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const startEdit = () => { setDraft(layout.items); setSaveError(null); setEditing(true); };
  const stopEdit = () => { setEditing(false); setDraft(null); setSaveError(null); };
  const saveLayout = async () => {
    setSaving(true); setSaveError(null);
    try { await layout.save(draft); stopEdit(); } catch (e) { setSaveError(e.message); } finally { setSaving(false); }
  };
  useEffect(() => { if (tab !== "overview") stopEdit(); }, [tab]);
  const renderCard = (key) => {
    switch (key) {
      case "clock": return <LaunchStrip snap={view} />;
      case "hero": return <HeroBar snap={view} horizon={horizon} />;
      case "channels": return <ChannelsVsTargets snap={view} horizon={horizon} />;
      case "no_targets": return targeted ? null : <NoTargets snap={view} onSetup={() => setTab("targets")} />;
      case "funnel": return <FunnelByChannel snap={view} />;
      case "funnel_wide": return <FunnelByChannelWide snap={view} />;
      // the trajectory draws one picture: both readings are already on it
      case "trajectory": return <Trajectory snap={view} />;
      case "drivers": return <KeyDrivers snap={view} />;
      case "paid_roi": return <PaidRoi snap={view} />;
      case "paid_spend": return <PaidSpend snap={view} horizon={horizon} />;
      // a timed launch has no sales to show before its window opens
      case "sell_through": return isTL && !view.sellthrough ? null : <SellThrough snap={view} horizon={horizon} />;
      case "framing": return <Framing snap={view} horizon={horizon} />;
      case "geo": return isTL ? null : <Geo snap={view} />;
      case "waterfall": return <Waterfall snap={view} horizon={horizon} />;
      case "tl_signups": return isTL && view.sales ? <TLSignupsOutcome snap={view} /> : null;
      // a timed launch's forecast of the window's sales by work, before it opens
      case "tl_forecast": return isTL && view.sellForecast ? <SellForecast snap={view} horizon={horizon} /> : null;
      // the launches the benchmark is read from; a row opens that launch's page
      case "basket": return <BasketCard snap={view} index={index} onOpen={onOpen} />;
      default: return null;
    }
  };
  return (
    <ExplainProvider snap={view} st={st} resetKey={`${snap.id}|${tab}`} enabled={!isTL}>
      {/* Two groups: what the release is, and the page's controls. When the row
          runs out of room the controls drop to a line of their own, whole; no
          name, chip, button or note ever breaks inside itself. */}
      <header className="page-header" style={{ marginBottom: 0 }}>
        <div className="page-identity">
          <span className="name">{snap.artist} - {snap.title}</span>
          <span className={`badge ${String(snap.type || "LE").toLowerCase()}`}>{snap.type || "LE"}</span>
          {isTL && <TLChips snap={snap} />}
          {!isTL && catalogue && (
            <span className="chip" title="No campaign dates in the funnel export - showing the last 90 days of traffic">Catalogue · last 90 days</span>
          )}
          {!isTL && upcoming && (
            <span className="chip" title="Known to Airtable; the funnel report has no rows for it yet">Upcoming · from Airtable</span>
          )}
          {snap.marketingLead && (
            <span className="chip" title={`Marketing lead${LEAD_FROM[(snap.inputSources || {}).marketing_lead] || ""}`}>{snap.marketingLead}</span>
          )}
          {snap.edition && snap.edition.total > snap.edition.target && (
            <span className="chip" title="The target is part of the edition: the hero cap, the room and the sell-through read against the whole edition, the targets against the target">
              Target <Ex k="release.target">{Number(snap.edition.target).toLocaleString("en-GB")}</Ex> · {Math.round((100 * snap.edition.target) / snap.edition.total)}% of {Number(snap.edition.total).toLocaleString("en-GB")} edition
            </span>
          )}
          {!targeted && !isTL && (
            <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }}
              title="Nobody has set targets for this release - the page shows actuals only">No targets</span>
          )}
        </div>
        <div className="page-controls">
          {(showHorizon || (variant && tab === "overview")) && (
            <div className="page-toggles">
              {showHorizon && <HorizonToggle horizon={horizon} onChange={setHorizon} closeLabel={wordsOf(snap).closeLabel} />}
              {/* the switch lays the variant over the Overview's cards; the other
                  tabs read Direct as a channel, so it is not offered there */}
              {variant && tab === "overview" && <DirectToggle on={directSpread} onChange={setDirectSpread} share={snap.directShare} snap={snap} />}
            </div>
          )}
          <Freshness asOf={snap.asOf} st={st} emailThrough={snap.email && snap.email.feedThrough} builtAt={snap.builtAt}
            partial={typeof snap.asOfFraction === "number" && snap.asOfFraction < 1} funnelNote={snap.funnelNote} />
        </div>
      </header>
      <StaleBanner asOf={snap.asOf} st={st} onRefreshed={onRefreshed} />
      <CoverageBanner noEvent={snap.untracked && snap.untracked.noEvent} />
      <nav className="tabs" style={{ marginTop: 20 }}>
        <button className={`tab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`tab${tab === "targets" ? " active" : ""}`} onClick={() => setTab("targets")}>{targeted ? "Target setting" : "Set up targets"}</button>
        {!upcoming && !isTL && <button className={`tab${tab === "audit" ? " active" : ""}`} onClick={() => setTab("audit")} title="Check the allocator tool against an admin draw-entries export">Draw audit</button>}
        {tab === "overview" && !editing && !upcoming && !isTL && <ExplainHint />}
        {tab === "overview" && !editing && (
          <button className="edit-link" onClick={startEdit} title="Move the cards and add section headers - saved for everyone">Edit layout</button>
        )}
      </nav>
      {tab === "targets" ? (isTL ? <TLTargets snap={snap} onSaved={onSaved} directSpread={!!(variant && directSpread)} /> : <TargetSetting snap={snap} onSaved={onSaved} directSpread={!!(variant && directSpread)} />)
        : tab === "audit" && !upcoming && !isTL ? <DrawAudit snap={snap} /> : upcoming && !isTL ? (
        <div style={{ maxWidth: 560, marginTop: 24 }}><Upcoming snap={snap} onSetup={() => setTab("targets")} /></div>
      ) : (
        <>
          {editing && (
            <LayoutBar items={draft} onChange={setDraft} saving={saving} error={saveError}
              updatedAt={layout.updatedAt} updatedBy={layout.updatedBy} onCancel={stopEdit} onSave={saveLayout} />
          )}
          <PageLayout items={editing ? draft : layout.items} editing={editing} onChange={setDraft} render={renderCard} />
        </>
      )}
    </ExplainProvider>
  );
}
