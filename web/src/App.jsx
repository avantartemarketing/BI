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
import { C, fmtSigned, fmtPct, fmtDay, TipProvider, useTip } from "./ui.jsx";
import HeroBar from "./modules/HeroBar.jsx";
import LaunchStrip from "./modules/LaunchStrip.jsx";
import ChannelsVsTargets from "./modules/ChannelsVsTargets.jsx";
import FunnelByChannel, { FunnelByChannelWide } from "./modules/FunnelByChannel.jsx";
import Trajectory from "./modules/Trajectory.jsx";
import KeyDrivers from "./modules/KeyDrivers.jsx";
import PaidRoi from "./modules/PaidRoi.jsx";
import PaidSpend from "./modules/PaidSpend.jsx";
import SellThrough from "./modules/SellThrough.jsx";
import Geo from "./modules/Geo.jsx";
import Waterfall from "./modules/Waterfall.jsx";
import NoTargets from "./modules/NoTargets.jsx";
import TargetSetting from "./TargetSetting.jsx";
import Permissions from "./Permissions.jsx";
import { PageLayout, LayoutBar, useLayout } from "./Layout.jsx";

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

const STATUS_LABEL = { live: "in flight", closed: "closed", catalogue: "catalogue" };

/* Search across every release the funnel data mentions - artist, title,
 * quarter, campaign code or id - keeping the index's own order (in flight,
 * then closed most recent first, then catalogue by traffic). */
function searchReleases(releases, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/);
  return releases.filter((r) => {
    const hay = `${r.name} ${r.releaseName} ${r.quarter || ""} ${r.id}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
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
  const onSaved = (s) => { setSnap(s); loadIndex().catch(() => {}); };
  // a refresh landed: pull the current page and the index again
  const onRefreshed = () => {
    loadIndex().catch(() => {});
    if (releaseId) getJSON(`/api/releases/${releaseId}`).then(setSnap).catch(() => {});
  };

  const groups = useMemo(() => {
    if (!index) return { live: [], all: [] };
    const all = index.releases.map((r) => ({ ...r, status: r.status || (r.complete ? "closed" : "live") }));
    // in flight reads top to bottom by days to launch; a release whose window
    // has not opened yet sits under the ones that have, soonest first
    const order = (r) => {
      const c = releaseClock(r, index.asOf);
      if (!c) return Infinity;
      return c.opensIn > 0 ? 1e6 + c.opensIn : c.daysLeft;
    };
    const live = all.filter((r) => r.status === "live").sort((a, b) => order(a) - order(b));
    return { live, all };
  }, [index]);
  const results = useMemo(() => searchReleases(groups.all, query), [groups, query]);
  const current = groups.all.find((r) => r.id === releaseId);
  const pinned = current && current.status !== "live" && view === "release" ? current : null;

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
        <div className="section-label split">In flight{groups.live.length > 0 && <small>days left</small>}</div>
        {groups.live.length === 0 && <div className="hint">Nothing in flight</div>}
        {groups.live.map((r) => <ReleaseRow key={r.id} r={r} asOf={index?.asOf} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} />)}
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
        {results.slice(0, 30).map((r) => <ReleaseRow key={r.id} r={r} asOf={index?.asOf} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} />)}
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
          snap ? <ReleasePage snap={snap} onSaved={onSaved} st={st} onRefreshed={onRefreshed} /> :
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

/* One release in the sidebar: the status dot, the artist over the launch date,
 * and the days left to it on the right. Every row is the same two lines - the
 * title, which wraps or crops at any width, lives in the tooltip with the
 * day-of-window and the pace, and the dot's meaning is the tooltip's Pace row
 * rather than a key under the list. */
function ReleaseRow({ r, asOf, active, onClick }) {
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
  if (!targeted) rows.push({ label: "Targets", value: "not set - actuals only" });
  if (status === "catalogue" && r.lastSeen) rows.push({ label: "Last traffic", value: r.lastSeen });
  const content = { head: r.releaseName || r.name, rows };

  // the second line and the figure on the right
  let when, count = null;
  if (!clock) when = status === "closed" ? "Closed" : "Catalogue";
  else if (clock.opensIn > 0) when = `Opens ${fmtDay(clock.announce)}`;
  else if (status === "closed") when = `Closed ${fmtDay(clock.launch)}`;
  else { when = fmtDay(clock.launch); count = Math.max(clock.daysLeft, 0); }
  return (
    <button className={`release-row${active ? " active" : ""}`} onClick={onClick} {...t.props(content)}>
      {state
        ? <span className="dot" style={{ background: STATE[state].color }} />
        : <span className="dot hollow" />}
      <span className="who">
        <span className="nm">{r.artist || r.name}</span>
        <span className="when">{when}</span>
      </span>
      {count !== null && <span className="left">{count}<small>d</small></span>}
      {clock && clock.opensIn > 0 && <span className="left none">·</span>}
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

/* A page built from data older than a day is the committed fallback (served
 * after a deploy until the first refresh lands) or the product of a refresh
 * that has been failing. Both looked like "the numbers are just low". Say
 * which, and what the refresh is doing about it. */
function StaleBanner({ asOf, st, onRefreshed }) {
  const ageDays = asOf ? Math.floor((Date.now() - new Date(asOf + "T00:00:00Z").getTime()) / 86400000) - 1 : 0;
  const prevAt = React.useRef(st && st.at);
  useEffect(() => {
    // a refresh just landed: reload the page's data
    if (st && st.at && prevAt.current && st.at !== prevAt.current && !st.running) onRefreshed();
    prevAt.current = st && st.at;
  }, [st && st.at, st && st.running]);
  if (ageDays < 2) return null;
  const through = new Date(asOf + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  let what;
  if (st === undefined) what = "Checking whether a refresh is running…";
  else if (st && st.running) what = "A refresh is running now - this page reloads when it lands (a first refresh after a deploy takes a few minutes).";
  else if (st && st.at && st.ok === false) what = `The last refresh failed: ${String(st.etl || st.bigquery || st.sheet || "").slice(0, 160)}`;
  else if (st && st.at) what = "The last refresh succeeded but did not move this page - the source feed may not have newer rows for it.";
  else what = "No refresh has completed since the app started - the first one after a deploy takes a few minutes.";
  return (
    <div style={{ margin: "14px 0 0", padding: "10px 14px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.5 }}>
      <b>Built from data through {through}</b> ({ageDays} days old). {what}
    </div>
  );
}

/* The header used to assert "Sources fresh" as a literal, so a broken hourly
 * ingestion - expired token, un-shared sheet, an ETL exception - looked
 * identical to a healthy one while the page served frozen numbers. This reads
 * the status the server already records and says which it is. */
function Freshness({ asOf, st, emailThrough }) {
  const t = useTip();
  // the email feed's last send: when it falls a week or more behind the build,
  // every email rung on the page is reading an empty feed, and the header is
  // where that has to show - the pull itself "succeeds" either way
  const day = (s) => new Date(s + "T00:00:00Z").getTime();
  const emailLag = asOf && emailThrough ? Math.round((day(asOf) - day(emailThrough)) / 864e5) : null;
  const emailBehind = emailLag !== null && emailLag > 7;

  const feeds = st && [["BigQuery", st.bigquery], ["Sheet", st.sheet], ["Email", st.emails],
    ["Notion", st.notion], ["ETL", st.etl]]
    .filter(([, v]) => v !== undefined && v !== null);
  const stale = st && st.ok === false;
  const running = st && st.running;
  /* A feed with no token does not fail, so `ok` stays true and the header read
   * "Sources fresh" while a whole feed was dormant and its panels sat empty.
   * That is not a failure and should not turn the header red, but it is not
   * "fresh" either: name the dormant feeds in the header so nobody has to
   * hover to find out the email panels have no source at all. */
  const dormant = (feeds || [])
    .filter(([, v]) => / off \(/.test(String(v)))
    .map(([k]) => k.toLowerCase());
  const label = st === undefined ? "Checking sources…"
    : running && !st.at ? "Refreshing sources…"
    : st === null || !st.at ? "Source status unknown"
    : stale ? "Sources stale"
    : dormant.length ? `Sources fresh · ${dormant.join(" and ")} off`
    : "Sources fresh";
  const color = st === undefined ? "#6c6b68" : stale ? "#b8461d"
    : dormant.length || emailBehind ? "#8a5f00"
    : st && st.at ? "#6c6b68" : "#8a5f00";
  const tip = {
    head: running ? `${label} (refresh in progress)` : label,
    body: running
      ? `A refresh started ${new Date(st.runningSince).toLocaleTimeString()} is still running` +
        (st.at ? `; the figures below are from the previous one at ${new Date(st.at).toLocaleString()}.` : ".")
      : st && st.at
      ? `Last refresh attempt ${new Date(st.at).toLocaleString()}`
      : "The dashboard has not been able to read the refresh status.",
    // the feed lines are the diagnosis - a HubSpot summary names the releases its
    // sends joined, which starts well past character 70 - so they are not cut
    rows: [
      ...(emailThrough ? [{ label: "Emails through", value: emailThrough, color: emailBehind ? "#8a5f00" : undefined }] : []),
      ...(feeds ? feeds.map(([k, v]) => ({ label: k, value: String(v) })) : []),
    ],
  };
  return (
    <span className="freshness" style={{ color }} {...t.props(tip)}>
      {stale && <span aria-hidden="true">⚠ </span>}
      {label}{emailBehind && ` · emails through ${emailThrough}`} · data through {asOf}
    </span>
  );
}

/* One control, every container. Today reads actuals against the target and
 * benchmark for today; At close reads the projection against the target and
 * benchmark for the whole campaign. Cards with a single horizon - the funnels,
 * paid ROI, geo - ignore it and are not given it. */
function HorizonToggle({ horizon, onChange }) {
  return (
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 12, color: "#6c6b68" }}>Compare</span>
      <div className="seg" role="group" aria-label="Comparison horizon">
        <button
          className={horizon === "today" ? "active" : ""}
          onClick={() => onChange("today")}
          title="Actuals so far against the target and benchmark for today">Today</button>
        <button
          className={horizon === "close" ? "active" : ""}
          onClick={() => onChange("close")}
          title="Projection at close against the target and benchmark for the campaign">At close</button>
      </div>
    </div>
  );
}

function ReleasePage({ snap, onSaved, st, onRefreshed }) {
  const [tab, setTab] = useState("overview");
  const [horizon, setHorizon] = useState("today");
  // a new release is a new reading: start it on the tab and the horizon everyone shares
  useEffect(() => { setTab("overview"); setHorizon("today"); }, [snap.id]);
  const targeted = snap.targeted !== false;
  const catalogue = !!snap.catalogue;
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
      case "clock": return <LaunchStrip snap={snap} />;
      case "hero": return <HeroBar snap={snap} horizon={horizon} />;
      case "channels": return <ChannelsVsTargets snap={snap} horizon={horizon} />;
      case "no_targets": return targeted ? null : <NoTargets snap={snap} onSetup={() => setTab("targets")} />;
      case "funnel": return <FunnelByChannel snap={snap} />;
      case "funnel_wide": return <FunnelByChannelWide snap={snap} />;
      case "trajectory": return <Trajectory snap={snap} horizon={horizon} />;
      case "drivers": return <KeyDrivers snap={snap} />;
      case "paid_roi": return <PaidRoi snap={snap} />;
      case "paid_spend": return <PaidSpend snap={snap} horizon={horizon} />;
      case "sell_through": return <SellThrough snap={snap} horizon={horizon} />;
      case "geo": return <Geo snap={snap} />;
      case "waterfall": return <Waterfall snap={snap} horizon={horizon} />;
      default: return null;
    }
  };
  return (
    <>
      <header className="page-header" style={{ marginBottom: 0 }}>
        <span className="name">{snap.artist} - {snap.title}</span>
        <span className={`badge ${String(snap.type || "LE").toLowerCase()}`}>{snap.type || "LE"}</span>
        {catalogue && (
          <span className="chip" title="No campaign dates in the funnel export - showing the last 90 days of traffic">Catalogue · last 90 days</span>
        )}
        {snap.marketingLead && <span className="chip" title="Marketing lead">{snap.marketingLead}</span>}
        {!targeted && (
          <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }}
            title="Nobody has set targets for this release - the page shows actuals only">No targets</span>
        )}
        {showHorizon && <HorizonToggle horizon={horizon} onChange={setHorizon} />}
        <Freshness asOf={snap.asOf} st={st} emailThrough={snap.email && snap.email.feedThrough} />
      </header>
      <StaleBanner asOf={snap.asOf} st={st} onRefreshed={onRefreshed} />
      <nav className="tabs" style={{ marginTop: 20 }}>
        <button className={`tab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`tab${tab === "targets" ? " active" : ""}`} onClick={() => setTab("targets")}>{targeted ? "Target setting" : "Set up targets"}</button>
        {tab === "overview" && !editing && (
          <button className="edit-link" onClick={startEdit} title="Move the cards and add section headers - saved for everyone">Edit layout</button>
        )}
      </nav>
      {tab === "targets" ? <TargetSetting snap={snap} onSaved={onSaved} /> : (
        <>
          {editing && (
            <LayoutBar items={draft} onChange={setDraft} saving={saving} error={saveError}
              updatedAt={layout.updatedAt} updatedBy={layout.updatedBy} onCancel={stopEdit} onSave={saveLayout} />
          )}
          <PageLayout items={editing ? draft : layout.items} editing={editing} onChange={setDraft} render={renderCard} />
        </>
      )}
    </>
  );
}
