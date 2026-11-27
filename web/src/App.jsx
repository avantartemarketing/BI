/* The dashboard shell (the Linear redesign, October 2026): the sidebar, the
 * Agent's chat as the home page, the releases list, a release's page (its
 * Overview, Targets and Agent tabs), the permissions page and the command
 * bar. The address carries where the reader is (nothing for the home page,
 * ?release=<id>, &tab=targets or &tab=agent, &basket=1, ?view=releases,
 * ?view=permissions) so a page can be shared or reloaded.
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
import AgentHome from "./AgentHome.jsx";
import { HOME, useAgentChat } from "./agentChat.js";
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

const TABS = ["overview", "targets", "agent"];   // a release's pages

/* the address -> where the reader is */
function readRoute() {
  const q = new URLSearchParams(window.location.search);
  const id = q.get("release");
  if (q.get("view") === "permissions") return { view: "permissions" };
  if (id) return { view: "release", id, tab: TABS.includes(q.get("tab")) ? q.get("tab") : "overview", basket: q.get("basket") === "1" };
  if (q.get("view") === "releases") return { view: "releases" };
  return { view: "home" };   // nothing named opens the Agent's chat
}
function writeRoute(r) {
  const q = new URLSearchParams();
  if (r.view === "permissions") q.set("view", "permissions");
  else if (r.view === "release" && r.id) { q.set("release", r.id); if (r.tab && r.tab !== "overview" && TABS.includes(r.tab)) q.set("tab", r.tab); if (r.basket) q.set("basket", "1"); }
  else if (r.view === "releases") q.set("view", "releases");
  const s = q.toString() ? "?" + q.toString() : "";
  if (s !== window.location.search) { try { window.history.pushState(null, "", s || window.location.pathname); } catch { /* not important */ } }
}

const DIRECT_PREF = "directSpread";
const readDirectPref = () => { try { return localStorage.getItem(DIRECT_PREF) !== "0"; } catch { return true; } };
const METHOD_PREF = "targetsFrom";   // the launch pages' targets: "time" (the campaign clock, the default) or "plan" (the comms plan)
const readMethodPref = () => { try { return localStorage.getItem(METHOD_PREF) === "plan" ? "plan" : "time"; } catch { return "time"; } };
const COUNT_PREF = "countAs";   // a timed launch before its window: "conversions" (signup conversions, the default) or "signups"
const readCountPref = () => { try { return localStorage.getItem(COUNT_PREF) === "signups" ? "signups" : "conversions"; } catch { return "conversions"; } };
const COMPARE_PREF = "compareTo";
const readComparePref = () => { try { return localStorage.getItem(COMPARE_PREF) === "benchmark" ? "benchmark" : "target"; } catch { return "target"; } };

/* The server's refresh status, polled every 5 minutes (every 15 s while a
 * refresh is in flight). undefined = still asking, null = could not read it.
 * `start` asks the server for a refresh now (POST /api/refresh) and takes the
 * status it answers with, so the page sees running:true at once and reloads
 * when the run lands. Resolves false when the server would not start one. */
function useRefreshStatus() {
  const [st, setSt] = useState(undefined);
  const start = useCallback(() => fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setSt(d); return !!d; }).catch(() => false), []);
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
  return [st, start];
}

export default function App() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null);
  const [route, setRoute] = useState(readRoute);
  const [snap, setSnap] = useState(null);
  const [snapError, setSnapError] = useState(null);
  const [actions, setActions] = useState(null);   // the Suggested actions card's { visible, states }, loaded with the page
  const [nav, setNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const [directSpread, setDirectSpreadState] = useState(readDirectPref);
  const setDirectSpread = (v) => { setDirectSpreadState(v); try { localStorage.setItem(DIRECT_PREF, v ? "1" : "0"); } catch { /* per-browser convenience only */ } };
  const [targetsFrom, setTargetsFromState] = useState(readMethodPref);
  const setTargetsFrom = (v) => { setTargetsFromState(v); try { localStorage.setItem(METHOD_PREF, v); } catch { /* per-browser convenience only */ } };
  const [compareTo, setCompareToState] = useState(readComparePref);
  const setCompareTo = (v) => { setCompareToState(v); try { localStorage.setItem(COMPARE_PREF, v); } catch { /* per-browser convenience only */ } };
  const [countAs, setCountAsState] = useState(readCountPref);
  const setCountAs = (v) => { setCountAsState(v); try { localStorage.setItem(COUNT_PREF, v); } catch { /* per-browser convenience only */ } };
  const [st, startRefresh] = useRefreshStatus();

  useEffect(() => { fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {}); }, []);
  const loadIndex = useCallback(() => getJSON("/api/index").then((ix) => { setIndex(ix); return ix; }), []);
  useEffect(() => { loadIndex().catch((e) => setError(String(e))); }, [loadIndex]);
  useEffect(() => { writeRoute(route); }, [route]);
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
    if (!releaseId) return undefined;
    setSnap(null); setSnapError(null); setActions(null);
    // the Suggested actions card's ticks are asked for beside the page and
    // land with it, so the card is there at the first paint, not a moment
    // after; a read that fails, or is not back in four seconds, costs the
    // ticks, never the page
    let live = true;
    const acts = Promise.race([
      fetch(`/api/releases/${releaseId}/plan-changes`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      new Promise((done) => setTimeout(() => done(null), 4000)),
    ]);
    Promise.all([getJSON(`/api/releases/${releaseId}`), acts])
      .then(([s, a]) => { if (live) { setActions(a); setSnap(s); } })
      .catch((e) => { if (live) setSnapError({ message: e.message, pending: !!e.pending }); });
    return () => { live = false; };
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

  // the Agent's chats: the home page's, and one per release, shown on that release's Agent tab (agentChat.js)
  const chat = useAgentChat({ place: releaseId || HOME,
    context: { view: route.view, release: releaseId, tab: route.tab, display: directSpread ? "spread" : "channel", compareTo } });

  const pick = (id, tab) => { setRoute({ view: "release", id, tab: tab || "overview", basket: false }); setNav(false); setPalette(false); window.scrollTo(0, 0); };
  const go = (r) => { setRoute(r); setNav(false); window.scrollTo(0, 0); };
  // a kept chat opens where it was held: on its release's Agent tab, or here on the home page
  const openChat = (c) => { chat.openChat(c); if (c && c.rel) pick(c.rel, "agent"); };
  // a card hands a question over (the Suggested actions card's Ask): the release's Agent tab opens and asks it
  const asker = React.useRef(null);
  asker.current = (q) => { if (!releaseId || !q) return; setRoute((r) => (r.view === "release" ? { ...r, tab: "agent", basket: false } : r)); chat.ask(q); };
  useEffect(() => {
    const on = (e) => { const q = e && e.detail && e.detail.text; if (q && asker.current) asker.current(q); };
    window.addEventListener("agent:ask", on);
    return () => window.removeEventListener("agent:ask", on);
  }, []);

  if (error) return <div style={{ padding: 40 }}>Failed to load: {error}</div>;
  return (
    <>
      <div className="app">
        <Sidebar groups={groups} asOf={index && index.asOf} currentId={releaseId} view={route.view} me={me} open={nav} onClose={() => setNav(false)}
          onPick={pick} onHome={() => go({ view: "home" })} onReleases={() => go({ view: "releases" })} onPermissions={() => go({ view: "permissions" })}
          onSearch={() => setPalette(true)} />
        {route.view === "permissions" ? (
          <Permissions me={me} onMenu={() => setNav(true)} />
        ) : route.view === "release" ? (
          <ReleasePage snap={snap} snapError={snapError} actions={actions} row={current} asOf={index && index.asOf} st={st} route={route} setRoute={setRoute}
            directSpread={directSpread} setDirectSpread={setDirectSpread} compareTo={compareTo} setCompareTo={setCompareTo} targetsFrom={targetsFrom} setTargetsFrom={setTargetsFrom} countAs={countAs} setCountAs={setCountAs} onSaved={onSaved} onRefreshed={onRefreshed} onRefresh={startRefresh} onOpen={pick} onMenu={() => setNav(true)} chat={chat} />
        ) : route.view === "releases" ? (
          <Releases groups={groups} asOf={index && index.asOf} onPick={pick} onMenu={() => setNav(true)} />
        ) : (
          <AgentHome chat={chat} groups={groups} onMenu={() => setNav(true)} onOpenChat={openChat} />
        )}
      </div>
      {palette && <CommandBar groups={groups} asOf={index && index.asOf} onPick={pick} onClose={() => setPalette(false)} />}
    </>
  );
}
