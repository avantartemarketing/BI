/* HubSpot marketing-email ingestion (dormant until HUBSPOT_TOKEN is set).
 *
 * Pulls every marketing email with its stats from the HubSpot API and rewrites
 * sources/all_sent_emails.csv in the shape the ETL already reads:
 *   Email Name, Send Date (Your time zone), Campaign, Delivered, Opened,
 *   Clicked, Unsubscribed
 *
 * Campaign attribution: a known release campaign_code (from data/app/inputs.json)
 * matched against the HubSpot campaign name or found inside the email name;
 * unmatched emails keep their raw campaign name and simply don't join a release.
 * Email type (GEN/CUS/INS filter) still comes from the name convention in
 * etl/build.py, so email names should keep the *_CUS_* style segments.
 *
 * Token: HubSpot Settings -> Integrations -> Private Apps -> create one with the
 * Marketing Email read scope; put its token in HUBSPOT_TOKEN. Failures leave the
 * existing CSV in place. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "sources", "all_sent_emails.csv");
const API = "https://api.hubapi.com/marketing/v3/emails";
const MAX_PAGES = 60; // 100 emails per page

function knownCampaignCodes() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "inputs.json"), "utf8"));
    return Object.values(doc.releases || {}).map((r) => r.campaign_code).filter(Boolean);
  } catch {
    return [];
  }
}

function matchCampaign(name, campaignName, codes) {
  if (campaignName && codes.includes(campaignName)) return campaignName;
  for (const c of codes) {
    if ((name && name.includes(c)) || (campaignName && campaignName.includes(c))) return c;
  }
  return campaignName || "";
}

function sendDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function fetchEmailsCsv() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return null;
  const codes = knownCampaignCodes();
  const rows = [];
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
      const date = sendDate(r.publishDate ?? r.publishedAt ?? r.sendOn);
      if (!date || (sent === 0 && delivered === 0)) continue; // drafts / never sent
      rows.push([
        cell(r.name), date,
        cell(matchCampaign(r.name || "", r.campaignName || "", codes)),
        delivered, c.open ?? c.opened ?? 0, c.click ?? c.clicked ?? 0, c.unsubscribed ?? 0,
      ].join(","));
    }
    after = body.paging && body.paging.next && body.paging.next.after;
    if (!after) break;
  }
  if (rows.length === 0) throw new Error("HubSpot returned no sent emails - not overwriting the CSV");
  const header = "Email Name,Send Date (Your time zone),Campaign,Delivered,Opened,Clicked,Unsubscribed";
  return { csv: header + "\n" + rows.join("\n") + "\n", rows: rows.length };
}

/* Fetch and write the CSV; returns a status string for the refresh summary. */
async function refreshEmails() {
  if (!process.env.HUBSPOT_TOKEN) return "hubspot off (no HUBSPOT_TOKEN)";
  const out = await fetchEmailsCsv();
  const tmp = OUT + ".tmp";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(tmp, out.csv);
  fs.renameSync(tmp, OUT);
  return `hubspot ${out.rows} emails`;
}

module.exports = { refreshEmails, fetchEmailsCsv, matchCampaign };
