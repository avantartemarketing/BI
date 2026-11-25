/* The comms plan from Notion (dormant until NOTION_TOKEN is set, and not yet
 * part of the hourly refresh: docs/PLAN_MODEL.md).
 *
 * The marketing team plans every launch in one Notion database, Comms: a row
 * per piece of comms (an email, a post, a story, an artist's post, a partner's)
 * with the day it goes live, its channel, the campaign phase and a status that
 * ends at Live, Not posted or Cancelled. Rows are written weeks ahead (a
 * median of 27 days before they go live on the rows read on 16 November 2026),
 * so it is the plan and the record at once. server/notion.js reads a different
 * database, the artist-post log, which holds what artists posted and nothing
 * of the emails or Avant Arte's own posts.
 *
 * This writes two files for the plan model (etl/plan_model.py):
 *   data/notion_comms.csv            one line per plan row and campaign:
 *       campaign_code, release, date, time, channel, channel_type, family,
 *       phase, status, name, hubspot_id, make_ready, created, edited
 *   data/notion_comms_campaigns.csv  one line per campaign in the Campaigns
 *       database and code of it: campaign_code, release, announce, launch,
 *       mechanic, status, tier. A campaign with no code of its own (none
 *       before mid-2024) is filed under a stand-in, "notion:" and its page id,
 *       and found by its name and days; Make-Ready's campaigns are left out
 *
 * Three databases are read, each in full: Channels (46 rows, a channel's name
 * and type), Campaigns (the campaign code, which a plan row reaches through
 * its Campaign relation; the rollup of it on the plan row comes back empty
 * from the API) and Comms. A query stops at 10,000 rows without saying so,
 * and Comms holds more, so it is read in slices of the rows' created time and
 * joined by row id.
 *
 * People and email properties are never read (value() has no case for them):
 * the plan's rows name colleagues, and nothing here needs them.
 *
 * Token: the same internal integration as server/notion.js; the three
 * databases must be shared with it. NOTION_COMMS_DB, NOTION_CHANNELS_DB and
 * NOTION_CAMPAIGNS_DB override the ids.
 *   node server/commsPlan.js            what a pull would write (counts only)
 *   node server/commsPlan.js --write    writes the two files */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "notion_comms.csv");
const CAMPAIGNS_OUT = path.join(ROOT, "data", "notion_comms_campaigns.csv");
const COMMS_DB = process.env.NOTION_COMMS_DB || "fa06c16e-c6c9-44d9-afef-c39105912807";
const CHANNELS_DB = process.env.NOTION_CHANNELS_DB || "4db5a73a-5fa2-4288-935a-07cd48d2c15e";
const CAMPAIGNS_DB = process.env.NOTION_CAMPAIGNS_DB || "33a7c7b3-58be-4401-a0ad-0698d6331d6b";
const NOTION_VERSION = "2022-06-28";
const API = process.env.NOTION_API || "https://api.notion.com/v1";
const FIRST_SLICE = "2023-01-01";   // nothing in Comms was created before this (its first row is of 8 September 2023)
const SLICE_MONTHS = 3;             // a slice holds about 1,100 rows at 2026's pace, far under the 10,000 cap
const QUERY_CAP = 10000;

const HEADER = ["campaign_code", "release", "date", "time", "channel", "channel_type", "family", "phase", "status",
  "name", "hubspot_id", "make_ready", "created", "edited"];
const CAMPAIGNS_HEADER = ["campaign_code", "release", "announce", "launch", "mechanic", "status", "tier", "email_audience"];

/* A property's value as plain data. A formula gives its string, number or
 * date; a rollup the values it gathers; a relation the ids it points to.
 * People, files and email properties have no case, so they read as null. */
function value(p) {
  if (!p) return null;
  switch (p.type) {
    case "title": return (p.title || []).map((t) => t.plain_text).join("").trim();
    case "rich_text": return (p.rich_text || []).map((t) => t.plain_text).join("").trim();
    case "select": return p.select ? p.select.name : null;
    case "status": return p.status ? p.status.name : null;
    case "multi_select": return (p.multi_select || []).map((o) => o.name);
    case "date": return p.date ? p.date.start : null;
    case "checkbox": return !!p.checkbox;
    case "number": return p.number;
    case "url": return p.url || null;
    case "relation": return (p.relation || []).map((r) => r.id);
    case "formula": {
      const f = p.formula || {};
      if (f.type === "date") return f.date ? f.date.start : null;
      return f[f.type] ?? null;
    }
    case "rollup": {
      const r = p.rollup || {};
      if (r.type === "array") return (r.array || []).map(value);
      if (r.type === "date") return r.date ? r.date.start : null;
      return r[r.type] ?? null;
    }
    default: return null;
  }
}

/* Which kind of comms a channel is, for the plan model: the families it has a
 * price for, and the rest named so they can be counted. Read by shape, like
 * server/notion.js's channelOf, since the list grows by hand ("IG Main ·
 * Broadcast" arrived in 2026). `scheduling` rows are the date markers of the
 * plan (Tease, Announce, Launch), not comms; `paid` rows note a paid phase,
 * and the spend itself comes from Meta. */
function familyOf(channel) {
  const c = String(channel || "").toLowerCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  if (!c) return "other";
  if (c === "scheduling") return "scheduling";
  if (/^m-r\b|make-ready/.test(c)) return "make_ready";
  if (c === "aa email") return "email";
  if (c === "sms") return "sms";
  if (/paid/.test(c)) return "paid";
  if (/^ig main/.test(c)) return /post/.test(c) ? "aa_post" : "aa_story";   // a broadcast reaches followers as a story does
  if (/^ig (ins|arteinbio)/.test(c)) return "aa_social_other";
  if (/^(twitter|tiktok|bluesky|linkedin|youtube|influencer)$/.test(c)) return "aa_social_other";
  if (/^(discord|forum|community management|aa other)$/.test(c)) return "aa_social_other";
  if (/^artist ig/.test(c)) return /post/.test(c) ? "artist_post" : "artist_story";
  if (/^artist|arte\.bio/.test(c)) return "artist_other";
  if (/^partner/.test(c)) return "partner";
  if (c === "press") return "press";
  if (c === "website") return "website";
  return "other";
}

/* The HubSpot email a plan row links to, from the link's own path: the id
 * after /details/ or /edit/ in the app, or at the end of a preview link. A
 * link to a workflow, or anything else, is no email. */
function hubspotId(url) {
  const u = String(url || "");
  const m = /\/email\/\d+\/(?:details|edit)\/(\d+)/.exec(u) || /\/preview\/email\/(\d+)/.exec(u);
  return m ? m[1] : "";
}

const day = (v) => (v ? String(v).slice(0, 10) : "");
// a live date with a time carries it; else the Post Time column's word ("9am"), as written
function timeOf(live, postTime) {
  const m = /T(\d{2}:\d{2})/.exec(String(live || ""));
  return m ? m[1] : (postTime || "");
}
const flat = (v) => (Array.isArray(v) ? v.flat(Infinity).filter((x) => x !== null && x !== "" && x !== undefined) : (v === null || v === undefined || v === "" ? [] : [v]));

/* The key a campaign with no code of its own is filed under: its page, so its
 * plan is kept and the plan model can find it by the artist it is named for
 * and the days it ran (etl/plan_model.py plan_campaign). The Campaign Code
 * field was not filled in before mid-2024, and the plan goes back to September
 * 2023: read by code alone, 96 campaigns' plans were left out, and with them
 * every launch before May 2024. */
const STAND_IN = "notion:";
const standIn = (id) => STAND_IN + String(id || "").replace(/-/g, "").slice(0, 12);

/* One campaign of the Campaigns database, or null for one of Make-Ready's
 * (another business's, with codes of its own) and for a blank row. `codes` are
 * the codes the field holds, since one campaign can run under two
 * ("LeeUfan_From_25,LeeUfan_LE_26"), or its stand-in when it holds none;
 * `code` is the first, and `coded` says whether it is a code of its own. */
function campaignRow(row) {
  const p = row.properties || {};
  if (value(p["Make Ready"])) return null;
  const own = String(value(p["Campaign Code"]) || "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const release = String(value(p["Release"]) || "").trim();
  if (!own.length && !release) return null;
  const codes = own.length ? [...new Set(own)] : [standIn(row.id)];
  return {
    id: row.id, code: codes[0], codes, coded: own.length > 0,
    release,
    announce: day(value(p["Formula Announce"])),
    launch: day(value(p["Launch Date Formula"])),
    mechanic: [...new Set(flat(value(p["◒ Launch mechanic"])).map(String))].sort().join("; "),
    status: value(p["Status"]) || "",
    tier: value(p["Content Tier"]) || "",
    email_audience: emailAudience(p),
  };
}

/* How many people the campaign's announcement email is planned to go to: the
 * Campaigns database's "Email audience" number, typed by the team before the
 * email is built (HubSpot knows an audience only once it is). One number a
 * campaign, so it is the announcement's; "" when empty or not a count. The
 * field is found by its name with the spaces trimmed, since it was made as
 * "Email audience " with one after it. */
function emailAudience(p) {
  const key = Object.keys(p || {}).find((k) => k.trim().toLowerCase() === "email audience");
  const v = key ? Number(value(p[key])) : NaN;
  return Number.isFinite(v) && v >= 1 ? String(Math.round(v)) : "";
}

/* A plan row as the lines it writes: one per campaign it belongs to (a bundle
 * email belongs to several) and per code of that campaign, none when it has
 * no live date or belongs to no campaign read (campaignRow). `channels` and
 * `campaigns` are the two lookups by page id. */
function commsRows(row, channels, campaigns) {
  const p = row.properties || {};
  const live = value(p["Live Date"]);
  if (!live || row.archived) return [];
  const ch = flat(value(p["Channel"])).map((id) => channels.get(id)).filter(Boolean)[0] || { name: "", type: "" };
  const base = {
    date: day(live), time: timeOf(live, value(p["Post Time"])),
    channel: ch.name, channel_type: ch.type || "", family: familyOf(ch.name),
    phase: value(p["Campaign Phase"]) || "", status: value(p["Status"]) || "",
    name: String(value(p["Name"]) || "").replace(/\s+/g, " ").slice(0, 120),
    hubspot_id: hubspotId(value(p["Hubspot link"])),
    make_ready: value(p["Make Ready"]) ? "1" : "",
    created: day(row.created_time), edited: day(row.last_edited_time),
  };
  const out = [];
  for (const id of flat(value(p["Campaign"]))) {
    const c = campaigns.get(id);
    if (c) for (const code of c.codes || [c.code]) out.push({ campaign_code: code, release: c.release, ...base });
  }
  return out;
}

/* The created-time slices a full read is made in: [from, to) pairs of ISO
 * days, SLICE_MONTHS long, from FIRST_SLICE to a month past `today`. */
function slices(today, first = FIRST_SLICE, months = SLICE_MONTHS) {
  const out = [];
  let from = new Date(first + "T00:00:00Z");
  const end = new Date(String(today).slice(0, 10) + "T00:00:00Z");
  end.setUTCMonth(end.getUTCMonth() + 1);
  while (from < end) {
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + months);
    out.push([from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
    from = to;
  }
  return out;
}

const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (header, rows) => header.join(",") + "\n" + rows.map((r) => header.map((h) => cell(r[h])).join(",")).join("\n") + (rows.length ? "\n" : "");

async function notionPost(url, token, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    // rate limits and passing faults are waited out; anything else is said
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get("retry-after")) || 2 + attempt * 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text().catch(() => "");
    const hint = res.status === 401 ? " - check NOTION_TOKEN"
      : res.status === 404 ? " - is the database shared with the integration?" : "";
    throw new Error(`Notion API ${res.status}${hint} ${text.slice(0, 200)}`);
  }
}

/* Every row of a database, or of one created-time slice of it. */
/* Every row of a database, a page at a time, handed to `each` as it is read,
 * and how many there were. The comms plan is some 13,000 rows and this runs
 * inside the server in the hourly refresh, whose heap is small: no more than
 * one page of raw rows is held at a time. */
async function queryEach(db, token, filter, each) {
  let cursor, n = 0;
  do {
    const body = { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await notionPost(`${API}/databases/${db}/query`, token, body);
    for (const row of res.results || []) { each(row); n++; }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return n;
}

async function queryAll(db, token, filter) {
  const rows = [];
  await queryEach(db, token, filter, (row) => rows.push(row));
  return rows;
}

/* `opts.days` reads only the rows going live from that many days ago onwards
 * (one query on the Live Date, a fraction of the plan): what the hourly
 * refresh asks for, since a live launch's page needs its own weeks and no
 * more. Without it the whole plan is read, in slices of the rows' created
 * time, which is what the back-test needs and takes a few minutes. */
async function fetchCommsPlan(today = new Date().toISOString().slice(0, 10), opts = {}) {
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  const days = Number(opts.days) > 0 ? Math.round(Number(opts.days)) : 0;
  const liveSince = days ? new Date(Date.parse(today + "T00:00:00Z") - days * 864e5).toISOString().slice(0, 10) : null;
  const channels = new Map();
  for (const row of await queryAll(CHANNELS_DB, token)) {
    const p = row.properties || {};
    channels.set(row.id, { name: String(value(p["Name"]) || "").trim(), type: value(p["Type"]) || "" });
  }
  const campaigns = new Map();
  for (const row of await queryAll(CAMPAIGNS_DB, token)) {
    const c = campaignRow(row);
    if (c) campaigns.set(row.id, c);
  }
  // row id -> the row's lines, or why it has none: a row on a slice's edge is
  // read once, and each row is boiled down as it arrives (queryEach)
  const seen = new Map();
  let capped = false;
  const keep = (row) => {
    if (seen.has(row.id)) return;
    const got = commsRows(row, channels, campaigns);
    seen.set(row.id, got.length ? got : (value((row.properties || {})["Live Date"]) ? "loose" : "undated"));
  };
  if (liveSince) {
    const n = await queryEach(COMMS_DB, token, { property: "Live Date", date: { on_or_after: liveSince } }, keep);
    if (n >= QUERY_CAP) capped = true;
  } else {
    for (const [from, to] of slices(today)) {
      const n = await queryEach(COMMS_DB, token, { and: [
        { timestamp: "created_time", created_time: { on_or_after: from } },
        { timestamp: "created_time", created_time: { before: to } },
      ] }, keep);
      if (n >= QUERY_CAP) capped = true;
    }
  }
  const lines = [];
  let undated = 0, loose = 0;
  for (const got of seen.values()) {
    if (got === "undated") undated++;
    else if (got === "loose") loose++;
    else lines.push(...got);
  }
  lines.sort((a, b) => (a.campaign_code + a.date + a.channel + a.name).localeCompare(b.campaign_code + b.date + b.channel + b.name));
  const camps = [...campaigns.values()].sort((a, b) => a.code.localeCompare(b.code));
  // a line per code, so a campaign under two codes is found by either
  const campLines = camps.flatMap((c) => (c.codes || [c.code]).map((code) => ({ campaign_code: code, release: c.release, announce: c.announce, launch: c.launch, mechanic: c.mechanic, status: c.status, tier: c.tier, email_audience: c.email_audience || "" })))
    .sort((a, b) => a.campaign_code.localeCompare(b.campaign_code));
  return {
    csv: csv(HEADER, lines),
    campaignsCsv: csv(CAMPAIGNS_HEADER, campLines),
    rows: seen.size, lines: lines.length, undated, loose, capped, liveSince,
    campaigns: camps.length, uncoded: camps.filter((c) => c.coded === false).length, channels: channels.size,
    codes: new Set(lines.map((l) => l.campaign_code)).size,
    through: lines.reduce((m, l) => (l.date > m ? l.date : m), ""),
  };
}

/* Fetch and write the two files; returns a status string. A pull that reads
 * nothing leaves the files as they are. */
async function refreshCommsPlan(opts = {}) {
  if (!process.env.NOTION_TOKEN) return "comms plan off (no NOTION_TOKEN)";
  const out = await fetchCommsPlan(undefined, opts);
  if (!out.lines) throw new Error(`the comms plan read ${out.rows} rows and none with a live date and a campaign - not overwriting`);
  for (const [file, text] of [[OUT, out.csv], [CAMPAIGNS_OUT, out.campaignsCsv]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", text);
    fs.renameSync(file + ".tmp", file);
  }
  return summary(out);
}

const summary = (out) => `comms plan ${out.lines} lines for ${out.codes} campaigns, dated ${out.liveSince ? "from " + out.liveSince + " " : ""}to ${out.through} `
  + `(${out.rows} rows read; ${out.undated} with no live date, ${out.loose} on no campaign read; `
  + `${out.campaigns} campaigns, ${out.uncoded || 0} of them with no code of their own, ${out.channels} channels)`
  + (out.capped ? `; A SLICE HIT THE ${QUERY_CAP}-ROW CAP, rows are missing: shorten SLICE_MONTHS` : "");

/* How far back the hourly refresh reads the plan (server/sheets.js): the days
 * of plan a live launch's page can need, with room to spare. */
const REFRESH_DAYS = Math.max(30, Number(process.env.NOTION_COMMS_DAYS) || 120);

module.exports = { fetchCommsPlan, refreshCommsPlan, REFRESH_DAYS, value, familyOf, hubspotId, timeOf, campaignRow, commsRows, slices, csv, summary, standIn, STAND_IN,
  HEADER, CAMPAIGNS_HEADER, OUT, CAMPAIGNS_OUT };

if (require.main === module) {
  (async () => {
    if (!process.env.NOTION_TOKEN) { console.error("NOTION_TOKEN is not set."); process.exit(1); }
    if (process.argv.includes("--write")) { console.log(await refreshCommsPlan()); return; }
    console.log(summary(await fetchCommsPlan()));
    console.log("dry run - pass --write to write data/notion_comms.csv and data/notion_comms_campaigns.csv");
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
