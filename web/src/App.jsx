/* The dashboard shell (the Linear redesign, October 2026): the sidebar, the
 * releases list, a release's page, the permissions page, the command bar
 * and the Agent (on every page but Permissions). The address carries where the reader is (?release=<id>,
 * &tab=targets, &basket=1, ?view=releases, ?view=permissions) so a page can
 * be shared or reloaded.
 *
 * Settings that hold for every release (Direct spread) live here and stick
 * per browser; a reading of one release (its horizon, its line) lives on its
 * page and resets with the release. */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./Sidebar.jsx";
import CommandBar from "./CommandBar.jsx";
import Releases from "./Releases.jsx";
import ReleasePage from "./ReleasePage.jsx";
import Permissions from "./Permissions.jsx";
import AgentDock from "./Agent.jsx";
import { sidebarGroups } from "./rows.mjs";

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

/* the address -> where the reader is */
function readRoute() {
  const q = new URLSearchParams(window.location.search);
  const id = q.get("release");
  if (q.get("view") === "permissions") return { view: "permissions" };
  if (id) return { view: "release", id, tab: q.get("tab") === "targets" ? "targets" : "overview", basket: q.get("basket") === "1" };
  if (q.get("view") === "releases") return { view: "releases" };
  return { view: null };
}
function writeRoute(r) {
  const q = new URLSearchParams();
  if (r.view === "permissions") q.set("view", "permissions");
  else if (r.view === "release" && r.id) { q.set("release", r.id); if (r.tab === "targets") q.set("tab", "targets"); if (r.basket) q.set("basket", "1"); }
  else q.set("view", "releases");
  const s = "?" + q.toString();
  if (s !== window.location.search) { try { window.history.pushState(null, "", s); } catch { /* not important */ } }
}

const DIRECT_PREF = "directSpread";
const readDirectPref = () => { try { return localStorage.getItem(DIRECT_PREF) !== "0"; } catch { return true; } };

/* The server's refresh status, polled every 5 minutes (every 15 s while a
 * refresh is in flight). undefined = still asking, null = could not read it. */
function useRefreshStatus() {
  const [st, setSt] = useState(undefined);
  useEffect(() => {
    let live = true;
    const poll = () => fetch("/api/refresh/status").then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setSt(d); }).catch(() => { if (live) setSt(null); });
    poll();
    const id = setInterval(poll, 5 * 60 * 1000);
    return () => { live = false; clearInterval(id); };
  }, []);
  useEffect(() => {
    if (!st || !st.running) return undefined;
    const id = setInterval(() => fetch("/api/refresh/status").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setSt(d); }).catch(() => {}), 15 * 1000);
    return () => clearInterval(id);
  }, [st && st.running]);
  return st;
}

export default function App() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null);
  const [route, setRoute] = useState(readRoute);
  const [snap, setSnap] = useState(null);
  const [snapError, setSnapError] = useState(null);
  const [nav, setNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const [directSpread, setDirectSpreadState] = useState(readDirectPref);
  const setDirectSpread = (v) => { setDirectSpreadState(v); try { localStorage.setItem(DIRECT_PREF, v ? "1" : "0"); } catch { /* per-browser convenience only */ } };
  const st = useRefreshStatus();

  useEffect(() => { fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {}); }, []);
  const loadIndex = useCallback(() => getJSON("/api/index").then((ix) => { setIndex(ix); return ix; }), []);
  useEffect(() => { loadIndex().catch((e) => setError(String(e))); }, [loadIndex]);
  // the address opens the page it names; nothing named opens the releases list
  useEffect(() => { if (route.view === null) setRoute({ view: "releases" }); }, [route.view]);
  useEffect(() => { if (route.view) writeRoute(route); }, [route]);
  useEffect(() => {
    const back = () => setRoute(readRoute());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  // ⌘K opens the command bar; Escape closes the drawer
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      if (e.key === "Escape") setNav(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { document.body.classList.toggle("nav-open", nav); }, [nav]);

  const releaseId = route.view === "release" ? route.id : null;
  useEffect(() => {
    if (!releaseId) return;
    setSnap(null); setSnapError(null);
    getJSON(`/api/releases/${releaseId}`).then(setSnap).catch((e) => setSnapError({ message: e.message, pending: !!e.pending }));
  }, [releaseId]);
  // a save's rebuild lands whenever it lands: only the page on screen is swapped
  const onScreen = React.useRef(releaseId);
  useEffect(() => { onScreen.current = releaseId; }, [releaseId]);
  const onSaved = (s) => { if (s && s.id === onScreen.current) setSnap(s); loadIndex().catch(() => {}); };
  const onRefreshed = () => {
    loadIndex().catch(() => {});
    if (releaseId) getJSON(`/api/releases/${releaseId}`).then(setSnap).catch(() => {});
  };

  const groups = useMemo(() => (index ? sidebarGroups(index.releases, index.asOf) : { all: [], live: [], upcoming: [], recent: [], closed: [], catalogue: [] }), [index]);
  const current = groups.all.find((r) => r.id === releaseId) || null;

  const pick = (id, tab) => { setRoute({ view: "release", id, tab: tab || "overview", basket: false }); setNav(false); setPalette(false); window.scrollTo(0, 0); };
  const go = (r) => { setRoute(r); setNav(false); window.scrollTo(0, 0); };

  if (error) return <div style={{ padding: 40 }}>Failed to load: {error}</div>;
  return (
    <>
      <div className="app">
        <Sidebar groups={groups} asOf={index && index.asOf} currentId={releaseId} view={route.view} me={me} open={nav} onClose={() => setNav(false)}
          onPick={pick} onReleases={() => go({ view: "releases" })} onPermissions={() => go({ view: "permissions" })}
          onTargets={() => { const id = releaseId || (groups.live[0] && groups.live[0].id); if (id) pick(id, "targets"); }}
          onSearch={() => setPalette(true)} />
        {route.view === "permissions" ? (
          <Permissions me={me} onMenu={() => setNav(true)} />
        ) : route.view === "release" ? (
          <ReleasePage snap={snap} snapError={snapError} row={current} asOf={index && index.asOf} st={st} route={route} setRoute={setRoute}
            directSpread={directSpread} setDirectSpread={setDirectSpread} onSaved={onSaved} onRefreshed={onRefreshed} onOpen={pick} onMenu={() => setNav(true)} />
        ) : (
          <Releases groups={groups} asOf={index && index.asOf} onPick={pick} />
        )}
      </div>
      {palette && <CommandBar groups={groups} asOf={index && index.asOf} onPick={pick} onClose={() => setPalette(false)} />}
      {route.view !== "permissions" && (
        <AgentDock snap={route.view === "release" ? snap : null}
          context={{ view: route.view, release: releaseId, tab: route.tab, display: directSpread ? "spread" : "channel" }} />
      )}
    </>
  );
}
