import React, { useEffect, useMemo, useState } from "react";
import { fmtSigned, fmtPct } from "./ui.jsx";
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
    <div className="app">
      <nav className="sidebar">
        <h1>Launch Performance</h1>
        <div className="section-label">Live releases</div>
        {groups.live.map((r) => <ReleaseRow key={r.id} r={r} active={r.id === releaseId} onClick={() => setReleaseId(r.id)} />)}
        {groups.closed.length > 0 && <div className="section-label">Closed</div>}
        {groups.closed.map((r) => <ReleaseRow key={r.id} r={r} active={r.id === releaseId} onClick={() => setReleaseId(r.id)} />)}
        <SessionFooter />
      </nav>
      <main className="content">
        {snap ? <ReleasePage snap={snap} onSaved={setSnap} /> : <div style={{ color: "#6c6b68" }}>Loading…</div>}
      </main>
    </div>
  );
}

function SessionFooter() {
  const [email, setEmail] = useState(null);
  useEffect(() => {
    fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then((d) => setEmail(d?.email ?? null)).catch(() => {});
  }, []);
  if (!email) return null;
  return (
    <div style={{ marginTop: 24, padding: "10px 12px", borderTop: "1px solid #f2f0ea", fontSize: 11.5, color: "#6c6b68", display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={email}>{email}</span>
      <a href="/auth/logout" style={{ color: "#6c6b68" }}>Sign out</a>
    </div>
  );
}

function ReleaseRow({ r, active, onClick }) {
  const delta = `${r.statusPct >= 0 ? "+" : ""}${Math.round(r.statusPct * 100)}% vs expected`;
  const tip = `${r.type === "LE" ? "Limited edition" : "Timed launch"} · day ${r.day} of ${r.of} · ${delta}`;
  return (
    <button className={`release-row${active ? " active" : ""}`} onClick={onClick} title={tip}>
      <span className="dot" style={{ background: r.ok ? "#0f7052" : "#b8461d" }} />
      <span className="nm">{r.name}</span>
      <span className="typ">{r.type}</span>
    </button>
  );
}

function ReleasePage({ snap, onSaved }) {
  const [tab, setTab] = useState("overview");
  useEffect(() => setTab("overview"), [snap.id]);
  return (
    <>
      <header className="page-header" style={{ marginBottom: 0 }}>
        <span className="name">{snap.artist} — {snap.title}</span>
        <span className={`badge ${snap.type.toLowerCase()}`}>{snap.type}</span>
        <span className="chip">Day {snap.day} of {snap.of}</span>
        {snap.marketingLead && <span className="chip" title="Marketing lead">{snap.marketingLead}</span>}
        <span className="freshness" title="Latest complete day in the daily funnel export">
          Sources fresh · data through {snap.asOf}
        </span>
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
