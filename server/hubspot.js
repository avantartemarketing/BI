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
const OUT = path.join(ROOT, "sources", "all_sent_emails.csv");
const SAVED = process.env.SAVED_INPUTS_PATH || path.join(ROOT, "data", "inputs.saved.json");
const API = "https://api.hubapi.com/marketing/v3/emails";
const MAX_PAGES = 60; // 100 emails per page
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

async function fetchEmailsCsv() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return null;
  const { targeted, all } = knownCampaignCodes();
  const index = campaignIndex(all);
  const known = new Set(all);
  const rows = [];
  const recs = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = API + "?limit=100&includeStats=true" + (after ? `&after=${encodeURIComponent(after)}` : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 || res.status === 403
        ? " - check the Private App token and its Marketing Email read scope" : "";
      throw new Error(`HubSpot API ${res.status}${hint} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    for (const r of body.results || []) {
      const c = (r.stats && r.stats.counters) || {};
      const sent = c.sent ?? 0;
      const delivered = c.delivered ?? 0;
      const d = parseDate(r.publishDate ?? r.publishedAt ?? r.sendOn);
      if (!d || (sent === 0 && delivered === 0)) continue; // drafts / never sent
      const { code, via } = matchCampaign(r.name || "", r.campaignName || "", index);
      recs.push({ name: r.name || "", ms: d.getTime(), code, via, known: known.has(code) });
      rows.push([
        cell(r.name), sendDate(d), cell(code),
        delivered, c.open ?? c.opened ?? 0, c.click ?? c.clicked ?? 0, c.unsubscribed ?? 0,
      ].join(","));
    }
    after = body.paging && body.paging.next && body.paging.next.after;
    if (!after) break;
  }
  if (rows.length === 0) throw new Error("HubSpot returned no sent emails - not overwriting the CSV");
  const header = "Email Name,Send Date (Your time zone),Campaign,Delivered,Opened,Clicked,Unsubscribed";
  return { csv: header + "\n" + rows.join("\n") + "\n", rows: rows.length, summary: summarise(recs, targeted) };
}

/* Fetch and write the CSV; returns a status string for the refresh summary. */
async function refreshEmails() {
  if (!process.env.HUBSPOT_TOKEN) return "hubspot off (no HUBSPOT_TOKEN)";
  const out = await fetchEmailsCsv();
  const tmp = OUT + ".tmp";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(tmp, out.csv);
  fs.renameSync(tmp, OUT);
  return `hubspot ${out.rows} emails; ${out.summary}`;
}

module.exports = { refreshEmails, fetchEmailsCsv, matchCampaign, campaignIndex, knownCampaignCodes, summarise };
