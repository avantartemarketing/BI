/* What the Agent's chats keep in the reader's browser, as plain functions
 * over a store (localStorage in the app, a stand-in in tests/agent_store.mjs):
 *
 *   agentChats  every chat with something in it, newest first, each
 *               { id, at, thread, rel? } - `rel` is the release whose Agent
 *               tab it was held on; a chat from the home page has none
 *   agentOpen   { [release id]: chat id } - the chat each release's tab
 *               shows, so the launch's conversation is there on the way back
 *
 * Nothing here leaves the browser. A store that is full, or one the browser
 * will not give (private windows), costs the memory and never the chat. */

export const HOME = "home";
export const CHATS = "agentChats";
export const OPEN = "agentOpen";
export const KEEP = 30;        // chats kept, across every release and the home page
export const TURNS = 30;       // the last turns of a chat kept

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* a chat with an answer in it: what the lists show */
export const answered = (t) => (t || []).some((m) => m.role === "assistant" && !m.error);

export function loadChats(store) {
  try {
    const c = JSON.parse(store.getItem(CHATS) || "[]");
    return Array.isArray(c) ? c.filter((x) => x && x.id && Array.isArray(x.thread) && x.thread.length) : [];
  } catch { return []; }
}

/* when the browser's store is full the oldest chats go first */
export function saveChats(store, chats) {
  for (let n = chats.length; ; n = Math.floor(n / 2)) {
    try { store.setItem(CHATS, JSON.stringify(chats.slice(0, n))); return n; } catch { if (!n) return 0; }
  }
}

/* put a chat at the head of the list (it is the newest now) and return the list */
export function keepChat(store, id, thread, rel, now = Date.now()) {
  const next = [{ id, at: now, thread: thread.slice(-TURNS), ...(rel ? { rel } : {}) }, ...loadChats(store).filter((c) => c.id !== id)].slice(0, KEEP);
  saveChats(store, next);
  return next;
}

export function loadOpen(store) {
  try { const o = JSON.parse(store.getItem(OPEN) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/* The chat a release's tab shows; a null id forgets it (New chat). The entries
 * whose chat has left the list go on the way, so the map never outgrows it. */
export function saveOpen(store, rel, id, chats) {
  try {
    const o = loadOpen(store);
    if (id) o[rel] = id; else delete o[rel];
    const kept = new Set((chats || loadChats(store)).map((c) => c.id));
    for (const k of Object.keys(o)) if (!kept.has(o[k])) delete o[k];
    store.setItem(OPEN, JSON.stringify(o));
  } catch { /* a convenience only */ }
}

/* the conversation a release's tab opens on: the one it was left on, or none */
export function openFor(store, rel) {
  const id = loadOpen(store)[rel];
  const kept = id ? loadChats(store).find((c) => c.id === id && c.rel === rel) : null;
  return kept ? { id: kept.id, thread: kept.thread } : null;
}

/* a chat's name is its first question */
export const chatTitle = (thread) => { const q = (thread || []).find((m) => m.role === "user"); return q ? q.text : ""; };

/* how long ago, the short way a list says it: now, 5m, 3h, 2d, 4w */
export function ago(at, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  const d = Math.floor(m / (60 * 24));
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}
