/* What an index row says about a release, in the words the sidebar, the
 * releases list, the command bar and the page header share: its state (the
 * dot), the status word, when it closes or opens, how far from target. Plain
 * JavaScript, so the tests can read it. */
import { releaseClock, sectionOf } from "./sections.mjs";
import { fmtDay } from "./format.mjs";

export const STATE_COLOR = { green: "#0f7052", amber: "#8a5f00", red: "#b8461d" };
const STATE_WORD = { green: "Ahead", amber: "Behind target", red: "Behind benchmark" };
const BEHIND_TARGET_TOLERANCE = -0.10;

/* BENCHMARK_SPEC 7: green at or ahead of target, amber behind target but at
 * or ahead of the benchmark, red behind the benchmark; null when nobody has
 * set targets. */
export function rowState(r) {
  if (!r || r.targeted === false) return null;
  const pct = r.statusPct;
  if (pct === null || pct === undefined) return r.ok === null || r.ok === undefined ? null : r.ok ? "green" : "red";
  if (pct >= 0) return "green";
  const bm = r.benchmarkPct;
  if (bm === null || bm === undefined) return pct >= BEHIND_TARGET_TOLERANCE ? "amber" : "red";
  return bm >= 0 ? "amber" : "red";
}
export const stateColor = (r) => { const s = rowState(r); return s ? STATE_COLOR[s] : null; };

export const groupOf = (r, asOf) => sectionOf(r, asOf);
export const GROUP_WORD = { live: "In flight", upcoming: "Upcoming", closed: "Closed", catalogue: "Catalogue", recent: "Recent" };

/* the status in a word or two, as the list's lozenge prints it */
export function statusWord(r, asOf) {
  const g = groupOf(r, asOf);
  if (r.type === "TL") {
    if (r.tlState === "upcoming") return r.targeted === false ? "No targets" : "Targets set";
    if (r.tlState === "window") return "Window open";
    if (r.tlState === "settling") return "Settling";
  }
  if (g === "catalogue") return "Catalogue";
  if (g === "upcoming") return r.targeted === false ? "No targets" : "Targets set";
  const s = rowState(r);
  return s ? STATE_WORD[s] : "No targets";
}

/* "+13% vs target", or null without targets */
export function vsTarget(r) {
  if (!r || r.targeted === false || r.statusPct === null || r.statusPct === undefined) return null;
  const p = Math.round(r.statusPct * 100);
  return `${p >= 0 ? "+" : "−"}${Math.abs(p)}% vs target`;
}
export function vsBenchmark(r) {
  if (!r || r.targeted === false || r.benchmarkPct === null || r.benchmarkPct === undefined) return null;
  const p = Math.round(r.benchmarkPct * 100);
  return `${p >= 0 ? "+" : "−"}${Math.abs(p)}% vs benchmark`;
}

const day = (s) => new Date(String(s).slice(0, 10) + "T00:00:00Z");
const hm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
/* a date, with its year where that is not the page's own */
export function onDay(d, asOf) {
  const thisYear = asOf ? Number(String(asOf).slice(0, 4)) : new Date().getUTCFullYear();
  return d.getUTCFullYear() === thisYear ? fmtDay(d) : `${fmtDay(d)} ${d.getUTCFullYear()}`;
}

/* When it closes or opens, as the list's right-hand column prints it, and the
 * count to it in days (hours inside a timed launch's window). */
export function whenWords(r, asOf) {
  const g = groupOf(r, asOf);
  if (r.type === "TL") {
    const now = asOf ? day(asOf).getTime() + 12 * 3600000 : Date.now();
    const to = (iso, unit) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(Math.ceil((t - now) / (unit === "h" ? 3600000 : 86400000)), 0) : null; };
    if (r.tlState === "upcoming" && r.windowStart) return { text: `Announces ${onDay(day(r.windowStart), asOf)}`, count: to(r.windowStart + "T00:00:00Z"), unit: "d" };
    if (r.tlState === "signups" && r.salesOpen) return { text: `Opens ${onDay(new Date(r.salesOpen), asOf)} ${hm(r.salesOpen)}`, count: to(r.salesOpen), unit: "d" };
    if (r.tlState === "window" && r.windowClose) return { text: `Closes ${onDay(new Date(r.windowClose), asOf)} ${hm(r.windowClose)}`, count: to(r.windowClose, "h"), unit: "h" };
    if (r.tlState === "settling" && r.windowClose) { const f = new Date(Date.parse(r.windowClose) + 7 * 86400000); return { text: `Final ${onDay(f, asOf)}`, count: null }; }
    if (r.windowClose) return { text: `Closed ${onDay(new Date(r.windowClose), asOf)}`, count: null };
  }
  if (g === "catalogue") return { text: r.lastSeen ? `Last traffic ${onDay(day(r.lastSeen), asOf)}` : "Catalogue", count: null };
  const c = releaseClock(r, asOf);
  if (!c) return { text: g === "closed" ? "Closed" : "", count: null };
  if (g === "upcoming") {
    if (c.opensIn > 0) return { text: `Announces ${onDay(c.announce, asOf)}`, count: c.opensIn, unit: "d" };
    return { text: `Closes ${onDay(c.launch, asOf)}`, count: Math.max(c.daysLeft, 0), unit: "d" };
  }
  if (g === "closed") return { text: `Closed ${onDay(c.launch, asOf)}`, count: null };
  if (Array.isArray(r.closes) && r.closes.length > 1) return { text: `Closes ${r.closes.map((d) => onDay(day(d), asOf)).join(" · ")}`, count: Math.max(c.daysLeft, 0), unit: "d" };
  return { text: `Closes ${onDay(c.launch, asOf)}`, count: Math.max(c.daysLeft, 0), unit: "d" };
}

/* the artist and the work, from the row's name ("Artist · Title · 2026 Q4") */
const QUARTER_RE = /^\d{4} Q\d$/;
export function nameOf(r) {
  const parts = String(r.releaseName || r.name || r.artist || "").split(" · ").map((p) => p.trim()).filter(Boolean);
  const artist = r.artist || parts[0] || "";
  const work = r.title || parts.slice(1).filter((p) => !QUARTER_RE.test(p)).join(" · ");
  return { artist, work };
}

/* the sidebar's groups: in flight by days to close, upcoming soonest first,
 * recent: closed within `days` of the as-of day, newest first */
export function sidebarGroups(rows, asOf, { recentDays = 90, recentMax = 8 } = {}) {
  const all = rows.map((r) => ({ ...r, group: groupOf(r, asOf) }));
  const order = (r) => { const c = releaseClock(r, asOf); if (!c) return Infinity; return c.opensIn > 0 ? 1e6 + c.opensIn : c.daysLeft; };
  const soon = (r) => { const c = releaseClock(r, asOf); if (!c) return Infinity; return c.opensIn > 0 ? c.opensIn : c.daysLeft; };
  const live = all.filter((r) => r.group === "live").sort((a, b) => order(a) - order(b));
  const upcoming = all.filter((r) => r.group === "upcoming").sort((a, b) => soon(a) - soon(b));
  const today = asOf ? day(asOf).getTime() : Date.now();
  const closed = all.filter((r) => r.group === "closed" && r.windowEnd).sort((a, b) => (a.windowEnd < b.windowEnd ? 1 : -1));
  const recent = closed.filter((r) => today - day(r.windowEnd).getTime() <= recentDays * 86400000).slice(0, recentMax);
  const catalogue = all.filter((r) => r.group === "catalogue");
  return { all, live, upcoming, recent, closed, catalogue };
}

/* search across every release: artist, title, quarter, code or id */
export function searchRows(rows, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  const terms = needle.split(/\s+/);
  return rows.filter((r) => {
    const hay = `${r.name} ${r.releaseName} ${r.quarter || ""} ${r.id} ${r.type || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
