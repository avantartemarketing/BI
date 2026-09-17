/* HubSpot marketing-email ingestion (dormant until HUBSPOT_TOKEN is set).
 *
 * Pulls every marketing email with its stats from the HubSpot API and rewrites
 * sources/all_sent_emails.csv in the shape the ETL already reads:
 *   Email Name, Send Date (Your time zone), Campaign, Delivered, Opened,
 *   Clicked, Unsubscribed
 *
 * Campaign attribution, in order: the HubSpot campaign name is a known release
 * campaign_code; the code appears in the email name or the campaign name; the
 * email carries an Artist_Type_YY token whose artist and year name exactly one
 * known code (so AndyWarhol_LE_26 sends join the AndyWarhol_TL_26 Meta code).
 * Known codes are every release the ETL knows (data/app/inputs.json: configured
 * and discovered) plus the dashboard's saved target inputs. Unmatched emails
 * keep their raw campaign name and simply don't join a release. Email type
 * (the GEN/CUS/INS filter) still comes from the name convention in
 * etl/build.py, so email names should keep the *_CUS_* style segments.
 *
 * The refresh status line reports, per targeted release, how many sends in the
 * last 60 days joined it (and through which token when the join was by artist
 * and year), plus the recent sends that joined nothing - the first place to
 * look when a release's email panel is empty.
 *
 * Token: HubSpot Settings -> Integrations -> Private Apps -> create one with the
 * Marketing Email read scope; put its token in HUBSPOT_TOKEN. Failures leave the
 * existing CSV in place. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.HUBSPOT_CSV || path.join(ROOT, "sources", "all_sent_emails.csv");
const SAVED = process.env.SAVED_INPUTS_PATH || path.join(ROOT, "data", "inputs.saved.json");
const API = process.env.HUBSPOT_API || "https://api.hubapi.com/marketing/v3/emails";
/* The listing comes back oldest first, so a page cap cuts off the newest sends,
 * not the oldest: a 6,000-email cap once froze the feed at 14 Aug 2026 while
 * the header said the sources were fresh. The pull therefore asks only for
 * emails created inside a horizon, which keeps it far below the cap, and keeps
 * every older send from the file it already has. A pull that still hits the
 * cap says so in the status line. HUBSPOT_API and HUBSPOT_CSV exist so a test
 * can point the module at a local server and a scratch file. */
const HORIZON_DAYS = 730;
const MAX_PAGES = 150; // 100 emails per page
const MATCH_DAYS = 60;  // status: sends per targeted release over this window
const RECENT_DAYS = 21; // status: unmatched sends listed over this window
const RECENT_NAMES = 5;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const codesOf = (obj) => Object.values(obj || {}).map((r) => r && r.campaign_code).filter(Boolean);

/* {targeted: codes of releases with targets, all: every known code} */
function knownCampaignCodes() {
  const doc = readJson(path.join(ROOT, "data", "app", "inputs.json")) || {};
  const saved = readJson(SAVED) || {};
  const targeted = [...new Set([...codesOf(doc.releases), ...codesOf(saved.releases)])];
  const all = [...new Set([...targeted, ...codesOf(doc.discovered)])];
  return { targeted, all };
}

// Artist_Type_YY tokens; artistYear folds one to "artist_yy" (null for other shapes)
const TOKEN = /([A-Za-z]+)_[A-Za-z0-9]+_(\d{2})(?![A-Za-z0-9])/g;
function artistYear(code) {
  const m = /^([A-Za-z]+)_[A-Za-z0-9]+_(\d{2})$/.exec(code || "");
  return m ? `${m[1].toLowerCase()}_${m[2]}` : null;
}

/* Index of known codes: the exact list plus artist+year keys that name exactly
 * one code (an artist with two coded releases in a year gets no fuzzy join). */
function campaignIndex(codes) {
  const byKey = new Map();
  for (const c of codes) {
    const k = artistYear(c);
    if (k) byKey.set(k, byKey.has(k) ? null : c); // null = ambiguous
  }
  return { codes, byKey };
}

/* -> {code, via}: via is the token that carried an artist+year join, else null.
 * An unmatched email returns its raw campaign name as code. */
function matchCampaign(name, campaignName, index) {
  const { codes, byKey } = Array.isArray(index) ? campaignIndex(index) : index;
  if (campaignName && codes.includes(campaignName)) return { code: campaignName, via: null };
  for (const c of codes) {
    if ((name && name.includes(c)) || (campaignName && campaignName.includes(c))) return { code: c, via: null };
  }
  for (const s of [campaignName || "", name || ""]) {
    for (const m of s.matchAll(TOKEN)) {
      const hit = byKey.get(artistYear(m[0]));
      if (hit) return { code: hit, via: m[0] };
    }
  }
  return { code: campaignName || "", via: null };
}

function parseDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}
const sendDate = (d) => d.toISOString().replace("T", " ").slice(0, 19);

const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* One line for the refresh status: per targeted release the sends that joined
 * it recently, then the recent sends that joined no release at all. */
function summarise(recs, targeted, now = Date.now()) {
  const days = (r) => (now - r.ms) / 864e5;
  const joined = targeted.map((code) => {
    const hits = recs.filter((r) => r.code === code && days(r) <= MATCH_DAYS);
    const via = [...new Set(hits.map((r) => r.via).filter(Boolean))];
    return `${code} ${hits.length}${via.length ? ` (as ${via.join("/")})` : ""}`;
  });
  const loose = recs.filter((r) => !r.known && days(r) <= RECENT_DAYS).sort((a, b) => b.ms - a.ms);
  const names = loose.slice(0, RECENT_NAMES).map((r) => `"${r.name.slice(0, 48)}"`).join(", ");
  return `joined in last ${MATCH_DAYS}d: ${joined.join(", ") || "no targeted releases"}; ` +
    `sends in last ${RECENT_DAYS}d joining no release: ${loose.length}${names ? ` - ${names}` : ""}` +
    (loose.length > RECENT_NAMES ? ", …" : "");
}

/* The CSV on disk, keyed by email name and send day so a pull replaces the
 * rows it fetched again and keeps the rest. Quoted cells carry commas and
 * quotes; the writer below quotes the same way. */
function parseCsvLine(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const rowKey = (name, sent) => `${name}#${String(sent).slice(0, 10)}`;
function readExisting() {
  let text;
  try { text = fs.readFileSync(OUT, "utf8"); } catch { return new Map(); }
  const rows = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 7) continue;
    rows.set(rowKey(f[0], f[1]), { sent: f[1], line: f.slice(0, 7).map(cell).join(",") });
  }
  return rows;
}

async function fetchEmailsCsv(now = Date.now()) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return null;
  const { targeted, all } = knownCampaignCodes();
  const index = campaignIndex(all);
  const known = new Set(all);
  const since = new Date(now - HORIZON_DAYS * 864e5);
  const pulled = new Map();
  const recs = [];
  let filtered = true, after = null, pages = 0, capped = false;
  for (;;) {
    if (pages >= MAX_PAGES) { capped = !!after; break; }
    const url = API + "?limit=100&includeStats=true" +
      (filtered ? `&createdAfter=${encodeURIComponent(since.toISOString())}` : "") +
      (after ? `&after=${encodeURIComponent(after)}` : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 400 && filtered && pages === 0) {
      // an API that refuses the date filter: pull everything, and say if it was cut
      filtered = false;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 || res.status === 403
        ? " - check the Private App token and its Marketing Email read scope" : "";
      throw new Error(`HubSpot API ${res.status}${hint} ${text.slice(0, 200)}`);
    }
    pages++;
    const body = await res.json();
    for (const r of body.results || []) {
      const c = (r.stats && r.stats.counters) || {};
      const sent = c.sent ?? 0;
      const delivered = c.delivered ?? 0;
      const d = parseDate(r.publishDate ?? r.publishedAt ?? r.sendOn);
      if (!d || (sent === 0 && delivered === 0)) continue; // drafts / never sent
      const { code, via } = matchCampaign(r.name || "", r.campaignName || "", index);
      recs.push({ name: r.name || "", ms: d.getTime(), code, via, known: known.has(code) });
      const at = sendDate(d);
      pulled.set(rowKey(r.name || "", at), {
        sent: at,
        line: [cell(r.name), at, cell(code), delivered, c.open ?? c.opened ?? 0, c.click ?? c.clicked ?? 0, c.unsubscribed ?? 0].join(","),
      });
    }
    after = body.paging && body.paging.next && body.paging.next.after;
    if (!after) break;
  }
  if (pulled.size === 0) throw new Error("HubSpot returned no sent emails - not overwriting the CSV");
  const rows = [];
  let kept = 0;
  for (const [k, row] of readExisting()) if (!pulled.has(k)) { rows.push(row); kept++; }
  for (const row of pulled.values()) rows.push(row);
  rows.sort((a, b) => (a.sent < b.sent ? -1 : a.sent > b.sent ? 1 : 0));
  const through = rows[rows.length - 1].sent.slice(0, 10);
  const header = "Email Name,Send Date (Your time zone),Campaign,Delivered,Opened,Clicked,Unsubscribed";
  return {
    csv: header + "\n" + rows.map((r) => r.line).join("\n") + "\n",
    rows: rows.length, pulled: pulled.size, kept, through, pages, capped, filtered,
    since: since.toISOString().slice(0, 10), summary: summarise(recs, targeted, now),
  };
}

/* Fetch and write the CSV; returns a status string for the refresh summary.
 * "sends through" is the line's first fact: the header turns amber when that
 * date falls more than a week behind the build. */
async function refreshEmails() {
  if (!process.env.HUBSPOT_TOKEN) return "hubspot off (no HUBSPOT_TOKEN)";
  const out = await fetchEmailsCsv();
  const tmp = OUT + ".tmp";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(tmp, out.csv);
  fs.renameSync(tmp, OUT);
  const how = out.filtered ? `created since ${out.since}` : "unfiltered - the API refused the date filter";
  const cap = out.capped ? `; CAPPED at ${MAX_PAGES} pages, the newest sends are missing` : "";
  return `hubspot ${out.rows} emails, sends through ${out.through} (${out.pulled} pulled, ${how}, ${out.kept} kept from the file${cap}); ${out.summary}`;
}

module.exports = { refreshEmails, fetchEmailsCsv, matchCampaign, campaignIndex, knownCampaignCodes, summarise, parseCsvLine };
