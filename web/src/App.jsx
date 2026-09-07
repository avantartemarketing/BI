import React, { useEffect, useMemo, useState } from "react";
import { fmtSigned, fmtPct, TipProvider, useTip } from "./ui.jsx";
import HeroBar from "./modules/HeroBar.jsx";
import ChannelsVsTargets from "./modules/ChannelsVsTargets.jsx";
import FunnelByChannel from "./modules/FunnelByChannel.jsx";
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

  useEffect(() => {
    fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);

  const loadIndex = () => getJSON("/api/index").then((ix) => { setIndex(ix); return ix; });
  useEffect(() => {
    loadIndex().then((ix) => {
      const live = ix.releases.filter((r) => r.status === "live" || (!r.status && !r.complete));
      setReleaseId((live[0] || ix.releases[0])?.id ?? null);
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

  const groups = useMemo(() => {
    if (!index) return { live: [], all: [] };
    const all = index.releases.map((r) => ({ ...r, status: r.status || (r.complete ? "closed" : "live") }));
    return { live: all.filter((r) => r.status === "live"), all };
  }, [index]);
  const results = useMemo(() => searchReleases(groups.all, query), [groups, query]);
  const current = groups.all.find((r) => r.id === releaseId);
  const pinned = current && current.status !== "live" && view === "release" ? current : null;

  if (error) return <div style={{ padding: 40 }}>Failed to load: {error}</div>;
  const pick = (id) => { setReleaseId(id); setView("release"); };

  return (
    <TipProvider>
    <div className="app">
      <nav className="sidebar">
        <h1>Launch Performance</h1>
        <div className="section-label">In flight</div>
        {groups.live.length === 0 && <div className="hint">Nothing in flight</div>}
        {groups.live.map((r) => <ReleaseRow key={r.id} r={r} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} />)}
        {pinned && (
          <>
            <div className="section-label">Viewing</div>
            <ReleaseRow r={pinned} active onClick={() => pick(pinned.id)} showStatus />
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
        {results.slice(0, 30).map((r) => <ReleaseRow key={r.id} r={r} active={view === "release" && r.id === releaseId} onClick={() => pick(r.id)} showStatus />)}
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
          snap ? <ReleasePage snap={snap} onSaved={onSaved} /> :
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

function ReleaseRow({ r, active, onClick, showStatus }) {
  const t = useTip();
  const targeted = r.targeted !== false;
  const status = r.status || (r.complete ? "closed" : "live");
  const pct = targeted && r.statusPct !== null && r.statusPct !== undefined ? Math.round(r.statusPct * 100) : null;
  const rows = [];
  if (status !== "catalogue") rows.push({ label: "Day", value: `${r.day} of ${r.of}` });
  if (pct !== null) rows.push({ label: "vs expected", value: `${pct >= 0 ? "+" : ""}${pct}%`, color: pct >= 0 ? "#0f7052" : "#b8461d" });
  rows.push({ label: "Status", value: STATUS_LABEL[status] || status });
  if (r.quarter) rows.push({ label: "Quarter", value: r.quarter });
  if (!targeted) rows.push({ label: "Targets", value: "not set - actuals only" });
  if (status === "catalogue" && r.lastSeen) rows.push({ label: "Last traffic", value: r.lastSeen });
  const content = { head: r.releaseName || r.name, rows };
  return (
    <button className={`release-row${active ? " active" : ""}`} onClick={onClick} {...t.props(content)}>
      {targeted
        ? <span className="dot" style={{ background: r.ok ? "#0f7052" : "#b8461d" }} />
        : <span className="dot hollow" />}
      <span className="nm">{r.name}</span>
      {showStatus
        ? <span className="st">{r.quarter || STATUS_LABEL[status]}</span>
        : <span className="typ">{r.type}</span>}
    </button>
  );
}

/* The header used to assert "Sources fresh" as a literal, so a broken hourly
 * ingestion - expired token, un-shared sheet, an ETL exception - looked
 * identical to a healthy one while the page served frozen numbers. This reads
 * the status the server already records and says which it is. */
function Freshness({ asOf }) {
  const t = useTip();
  const [st, setSt] = useState(undefined); // undefined = still asking
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

  const feeds = st && [["BigQuery", st.bigquery], ["Sheet", st.sheet], ["Email", st.emails],
    ["Notion", st.notion], ["ETL", st.etl]]
    .filter(([, v]) => v !== undefined && v !== null);
  const stale = st && st.ok === false;
  const running = st && st.running;
  const label = st === undefined ? "Checking sources…"
    : running && !st.at ? "Refreshing sources…"
    : st === null || !st.at ? "Source status unknown"
    : stale ? "Sources stale" : "Sources fresh";
  const color = st === undefined ? "#6c6b68" : stale ? "#b8461d" : st && st.at ? "#6c6b68" : "#8a5f00";
  const tip = {
    head: running ? `${label} (refresh in progress)` : label,
    body: running
      ? `A refresh started ${new Date(st.runningSince).toLocaleTimeString()} is still running` +
        (st.at ? `; the figures below are from the previous one at ${new Date(st.at).toLocaleString()}.` : ".")
      : st && st.at
      ? `Last refresh attempt ${new Date(st.at).toLocaleString()}`
      : "The dashboard has not been able to read the refresh status.",
    rows: feeds ? feeds.map(([k, v]) => ({ label: k, value: String(v).slice(0, 70) })) : [],
  };
  return (
    <span className="freshness" style={{ color }} {...t.props(tip)}>
      {stale && <span aria-hidden="true">⚠ </span>}
      {label} · data through {asOf}
    </span>
  );
}

function ReleasePage({ snap, onSaved }) {
  const [tab, setTab] = useState("overview");
  useEffect(() => setTab("overview"), [snap.id]);
  const targeted = snap.targeted !== false;
  const catalogue = !!snap.catalogue;
  return (
    <>
      <header className="page-header" style={{ marginBottom: 0 }}>
        <span className="name">{snap.artist} - {snap.title}</span>
        <span className={`badge ${String(snap.type || "LE").toLowerCase()}`}>{snap.type || "LE"}</span>
        {catalogue
          ? <span className="chip" title="No campaign dates in the funnel export - showing the last 90 days of traffic">Catalogue · last 90 days</span>
          : <span className="chip">Day {snap.day} of {snap.of}</span>}
        {snap.marketingLead && <span className="chip" title="Marketing lead">{snap.marketingLead}</span>}
        {!targeted && (
          <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }}
            title="Nobody has set targets for this release - the page shows actuals only">No targets</span>
        )}
        <Freshness asOf={snap.asOf} />
      </header>
      <nav className="tabs" style={{ marginTop: 20 }}>
        <button className={`tab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`tab${tab === "targets" ? " active" : ""}`} onClick={() => setTab("targets")}>{targeted ? "Target setting" : "Set up targets"}</button>
      </nav>
      {tab === "targets" ? <TargetSetting snap={snap} onSaved={onSaved} /> : targeted ? (
      <div className="grid">
        <HeroBar snap={snap} />
        <ChannelsVsTargets snap={snap} />
        <FunnelByChannel snap={snap} />
        <Trajectory snap={snap} />
        <KeyDrivers snap={snap} />
        <PaidRoi snap={snap} />
        <PaidSpend snap={snap} />
        <SellThrough snap={snap} />
        <Geo snap={snap} />
        <Waterfall snap={snap} />
      </div>
      ) : (
      // actuals only: the modules that read the funnel feed directly, plus
      // what it would take to turn the rest on
      <div className="grid">
        <HeroBar snap={snap} />
        <ChannelsVsTargets snap={snap} />
        <NoTargets snap={snap} onSetup={() => setTab("targets")} />
        <Trajectory snap={snap} />
        <SellThrough snap={snap} />
        <Geo snap={snap} />
      </div>
      )}
    </>
  );
}
