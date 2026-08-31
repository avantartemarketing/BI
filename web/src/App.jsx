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
import TargetSetting from "./TargetSetting.jsx";
import Permissions from "./Permissions.jsx";

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export default function App() {
  const [index, setIndex] = useState(null);
  const [releaseId, setReleaseId] = useState(null);
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null); // { email, admin }
  const [view, setView] = useState("release"); // "release" | "permissions" (app-level, not per-release)

  useEffect(() => {
    fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);

  useEffect(() => {
    getJSON("/api/index").then((ix) => {
      setIndex(ix);
      const live = ix.releases.filter((r) => !r.complete);
      setReleaseId((live[0] || ix.releases[0])?.id ?? null);
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!releaseId) return;
    setSnap(null);
    getJSON(`/api/releases/${releaseId}`).then(setSnap).catch((e) => setError(String(e)));
  }, [releaseId]);

  const groups = useMemo(() => {
    if (!index) return { live: [], closed: [] };
    return {
      live: index.releases.filter((r) => !r.complete),
      closed: index.releases.filter((r) => r.complete),
    };
  }, [index]);

  if (error) return <div style={{ padding: 40 }}>Failed to load: {error}</div>;

  return (
    <TipProvider>
    <div className="app">
      <nav className="sidebar">
        <h1>Launch Performance</h1>
        <div className="section-label">Live releases</div>
        {groups.live.map((r) => <ReleaseRow key={r.id} r={r} active={view === "release" && r.id === releaseId} onClick={() => { setReleaseId(r.id); setView("release"); }} />)}
        {groups.closed.length > 0 && <div className="section-label">Closed</div>}
        {groups.closed.map((r) => <ReleaseRow key={r.id} r={r} active={view === "release" && r.id === releaseId} onClick={() => { setReleaseId(r.id); setView("release"); }} />)}
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
          snap ? <ReleasePage snap={snap} onSaved={setSnap} /> : <div style={{ color: "#6c6b68" }}>Loading…</div>}
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

function ReleaseRow({ r, active, onClick }) {
  const t = useTip();
  const pct = Math.round(r.statusPct * 100);
  const content = {
    head: r.name,
    rows: [
      { label: "Day", value: `${r.day} of ${r.of}` },
      { label: "vs expected", value: `${pct >= 0 ? "+" : ""}${pct}%`, color: pct >= 0 ? "#0f7052" : "#b8461d" },
      { label: "Status", value: r.complete ? "closed" : "live" },
    ],
  };
  return (
    <button className={`release-row${active ? " active" : ""}`} onClick={onClick} {...t.props(content)}>
      <span className="dot" style={{ background: r.ok ? "#0f7052" : "#b8461d" }} />
      <span className="nm">{r.name}</span>
      <span className="typ">{r.type}</span>
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

  const feeds = st && [["Sheet", st.sheet], ["Email", st.emails], ["Notion", st.notion], ["ETL", st.etl]]
    .filter(([, v]) => v !== undefined && v !== null);
  const stale = st && st.ok === false;
  const label = st === undefined ? "Checking sources…"
    : st === null || !st.at ? "Source status unknown"
    : stale ? "Sources stale" : "Sources fresh";
  const color = st === undefined ? "#6c6b68" : stale ? "#b8461d" : st && st.at ? "#6c6b68" : "#8a5f00";
  const tip = {
    head: label,
    body: st && st.at
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
  return (
    <>
      <header className="page-header" style={{ marginBottom: 0 }}>
        <span className="name">{snap.artist} - {snap.title}</span>
        <span className={`badge ${snap.type.toLowerCase()}`}>{snap.type}</span>
        <span className="chip">Day {snap.day} of {snap.of}</span>
        {snap.marketingLead && <span className="chip" title="Marketing lead">{snap.marketingLead}</span>}
        <Freshness asOf={snap.asOf} />
      </header>
      <nav className="tabs" style={{ marginTop: 20 }}>
        <button className={`tab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
        <button className={`tab${tab === "targets" ? " active" : ""}`} onClick={() => setTab("targets")}>Target setting</button>
      </nav>
      {tab === "targets" ? <TargetSetting snap={snap} onSaved={onSaved} /> : (
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
      )}
    </>
  );
}
