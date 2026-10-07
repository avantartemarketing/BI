/* Notion artist-posts ingestion (dormant until NOTION_TOKEN is set).
 *
 * The marketing team logs posts in a Notion database (one row per post). Each
 * refresh queries it and writes data/notion_posts.csv
 * (campaign_code,date,channel,posts) for the ETL, which turns it into the
 * Referral artist "Posts" rung and its tier benchmark, and the AA Meta "Posts"
 * rung. The channel is read from the database's Channel column ("AA IG Main",
 * "Artist post", "Partner post", ...) and bucketed to brand / artist /
 * partner / other - see channelOf.
 *
 * The database schema is discovered at runtime rather than hard-coded:
 *  - date     = a date-typed property (name matching date/post/publish wins),
 *               falling back to the row's created_time
 *  - campaign = any title/select/multi-select/rich-text/relation text on the
 *               row that contains a known campaign code, release name, or the
 *               artist segment of a release name (from data/app/inputs.json)
 * Rows matching no known release are counted and reported, not written.
 *
 * Token: Notion -> Settings -> Integrations -> Develop or manage integrations
 * -> new internal integration; then share the posts database page with it.
 * NOTION_TOKEN holds the secret; NOTION_ARTIST_POSTS_DB overrides the db id. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
/* Posts by release, date and channel. It was artist_posts.csv when the artist
 * was all it carried; the channel split made the name wrong. build.py reads
 * the old name too, so a box that has not refreshed since the rename keeps
 * working off the file it already has. */
const OUT = path.join(ROOT, "data", "notion_posts.csv");
/* The campaign dates the same log yields (data/notion_campaigns.csv): per
 * release, the day of the early-access email (the private room opening), the
 * announce and the launch - read off the rows' own words (stageOf), or off a
 * campaigns database's date columns when NOTION_CAMPAIGNS_DB names one. The
 * marketing lead rides in the same file: the name in a lead column (a
 * relation to a team page, a people, select or text property, named for it:
 * leadProp) on the campaigns database's row, or on the release page a post
 * row links to, else the row itself, the name most of the release's rows
 * carry standing (leadOf, campaignLeads). A relation is read for the linked
 * page's title and a people property for its display names, never an email
 * (DATA_MODEL 1.6). The ETL reads them first, before anything typed
 * (etl/build.py resolve_release). */
const DATES_OUT = path.join(ROOT, "data", "notion_campaigns.csv");
const CAMPAIGNS_DB_ID = process.env.NOTION_CAMPAIGNS_DB || "";
const DB_ID = process.env.NOTION_ARTIST_POSTS_DB || "1b6e65265ca280a898d1e74c0661344c";
const NOTION_VERSION = "2022-06-28";

/* The releases a row can belong to: the configured ones and the discovered
 * ones alike (an upcoming launch has a page before it has a code), each with
 * its code, its name, its artist and its window, so a row can be placed by
 * artist and date when its words carry no code. `key` names the release in
 * the dates file: the code where there is one, else the release name. */
function knownReleases() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(process.env.APP_DATA_PATH || path.join(ROOT, "data", "app"), "inputs.json"), "utf8"));
    const out = [];
    const seen = new Set();
    for (const r of [...Object.values(doc.releases || {}), ...Object.values(doc.discovered || {})]) {
      const name = String(r.release_name || "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const code = r.campaign_code ? String(r.campaign_code) : "";
      out.push({ code, name, artist: name.split("·")[0].trim(), announce: r.announce_date || "", close: r.launch_end || "", key: code || `name:${name}` });
    }
    return out.filter((r) => r.code || (r.announce && r.close));
  } catch {
    return [];
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const DAY_MS = 86400000;
const WINDOW_BEFORE_DAYS = 45, WINDOW_AFTER_DAYS = 30;   // how far around a campaign a row may fall (the pricing join's window)
function inWindow(r, date) {
  if (!date || !r.announce || !r.close) return false;
  const t = Date.parse(date);
  return Number.isFinite(t) && t >= Date.parse(r.announce) - WINDOW_BEFORE_DAYS * DAY_MS && t <= Date.parse(r.close) + WINDOW_AFTER_DAYS * DAY_MS;
}

/* The release a row belongs to: by its campaign code, else by its full name,
 * else by the artist's name - and an artist has many launches, so the row's
 * date picks the one whose window holds it, or the one announced nearest.
 * Returns the release record (code, name, key, window), or null. */
function matchRelease(texts, releases, date) {
  const hay = norm(texts.join(" | "));
  if (!hay) return null;
  for (const r of releases) {
    if (r.code && hay.includes(norm(r.code))) return r;
  }
  for (const r of releases) {
    if (r.name && hay.includes(norm(r.name))) return r;
  }
  const byArtist = releases.filter((r) => r.artist && r.artist.length >= 4 && hay.includes(norm(r.artist)));
  if (!byArtist.length) return null;
  const inside = byArtist.filter((r) => inWindow(r, date));
  const cands = inside.length ? inside : byArtist;
  if (!date) return cands[0];
  const dist = (r) => (r.announce ? Math.abs(Date.parse(date) - Date.parse(r.announce)) : Infinity);
  return cands.slice().sort((a, b) => dist(a) - dist(b))[0];
}

/* Pull the text out of one Notion property value (relations resolved by caller). */
function propText(p) {
  if (!p) return [];
  switch (p.type) {
    case "title": return (p.title || []).map((t) => t.plain_text);
    case "rich_text": return (p.rich_text || []).map((t) => t.plain_text);
    case "select": return p.select ? [p.select.name] : [];
    case "multi_select": return (p.multi_select || []).map((s) => s.name);
    case "status": return p.status ? [p.status.name] : [];
    case "url": return p.url ? [p.url] : [];
    default: return [];
  }
}

/* What the database actually holds, put where it can be read from the
 * dashboard rather than from a Notion tab or a server log. The names and types
 * are every column the matcher had to choose from; the values of the
 * choice-typed ones are where a post's account, channel or format is recorded,
 * and that is what a second series - Avant Arte's own posts beside the
 * artist's - has to be split on. Capped hard on both axes: this rides in a
 * status line a person reads. */
const CHOICE = new Set(["select", "multi_select", "status"]);
const SCHEMA_VALUES = 6;

function noteSchema(schema, props) {
  for (const [name, p] of Object.entries(props)) {
    if (!p || !p.type) continue;
    let e = schema.get(name);
    if (!e) { e = { type: p.type, values: new Map() }; schema.set(name, e); }
    if (!CHOICE.has(p.type)) continue;
    for (const v of propText(p)) e.values.set(v, (e.values.get(v) || 0) + 1);
  }
}

function summariseSchema(schema) {
  return [...schema.entries()].map(([name, e]) => {
    if (!CHOICE.has(e.type) || !e.values.size) return `${name} (${e.type})`;
    const vals = [...e.values.entries()].sort((x, y) => y[1] - x[1]);
    const shown = vals.slice(0, SCHEMA_VALUES).map(([v, n]) => `${v} ${n}`).join(", ");
    return `${name} (${e.type}: ${shown}${vals.length > SCHEMA_VALUES ? ", …" : ""})`;
  }).join(" | ");
}

/* Whose account a post went out on, from the Channel column.
 *
 * The values are written by hand ("AA IG Main", "Artist post", "Partner
 * post"), so this reads them by shape rather than matching a list that would
 * go stale the first time someone adds a channel. The account prefix is asked
 * first, because it answers the actual question: a post on "AA IG Artist
 * Takeover" went out on Avant Arte's account whatever else the name says.
 * Anything that classifies to nothing is kept as "other" and named in the
 * status line, so a new channel shows up as a question rather than quietly
 * landing in a bucket. */
function channelOf(value) {
  const v = norm(value);
  if (!v) return null;
  if (/^aa\b/.test(v) || v.includes("avant arte")) return "brand";
  if (v.includes("artist")) return "artist";
  if (v.includes("partner")) return "partner";
  return "other";
}

/* The column the channel is recorded in. Named properties win over a guess,
 * and a database with no such column puts every row in "other" - which the
 * status line then says, rather than the pull inventing a split. */
const CHANNEL_NAME = /channel|account|platform|surface/i;

function channelProp(props) {
  const choices = Object.entries(props).filter(([, p]) => p && CHOICE.has(p.type));
  const named = choices.find(([name]) => CHANNEL_NAME.test(name));
  return named ? named[0] : null;
}

/* A row's bucket: the first of its channel values that names an account, so a
 * multi-select carrying "AA IG Main" and a format tag still reads as brand. */
function rowChannel(props, propName) {
  const vals = propName ? propText(props[propName]) : [];
  for (const v of vals) {
    const c = channelOf(v);
    if (c && c !== "other") return { channel: c, value: v };
  }
  return { channel: "other", value: vals[0] || null };
}

/* Which moment of the campaign a row records, from its own words: the
 * early-access email (which opens the private room), the announce, or the
 * launch - the day the draw closes and sales open, which is what Airtable
 * calls the launch date too. Read by shape, like the channel, so a stage
 * spelled a new way still lands; a row naming none is no evidence. */
const STAGE_RE = {
  early_access: /early[\s\/-]*(?:exclusive|excl\.?|vip)?[\s\/-]*access|exclusive[\s-]?access|private[\s-]?room|pre[\s-]?launch access|collector preview|priority access/,
  announce: /announc/,
  launch: /\blaunch\b|draw clos|closing|last chance|final (day|hours|call)|ends? (today|tonight)|go(es)? live/,
};

/* An email row: the channel column reads "AA Email" or the like. The private
 * room opens on the day the early-access email is scheduled for, so among the
 * early-access rows the email's date is the one that counts. */
const EMAIL_RE = /\bemail\b|\be-?mail\b|newsletter/;
function isEmailRow(texts) {
  return EMAIL_RE.test(norm(texts.join(" | ")));
}

function stageOf(texts) {
  const t = norm(texts.join(" | "));
  if (!t) return null;
  if (STAGE_RE.early_access.test(t)) return "early_access";
  if (STAGE_RE.announce.test(t)) return "announce";
  if (STAGE_RE.launch.test(t)) return "launch";
  return null;
}

/* The campaign dates from the classified rows: the private room opens with
 * the first early-access row, the announce is the first announce row, the
 * launch is the last launch row. */
function campaignDates(stageDates) {
  const out = {};
  for (const [key, st] of stageDates.entries()) {
    const ea = st.early_access || [], em = st.early_access_email || [], an = st.announce || [], la = st.launch || [];
    out[key] = {
      code: st.code || "", name: st.name || "",
      // the early-access email's day; another early-access row (a story, a
      // post) stands in only when no email row is on file
      private_room_open: em.length ? em.slice().sort()[0] : ea.length ? ea.slice().sort()[0] : "",
      announce_date: an.length ? an.slice().sort()[0] : "",
      launch_end: la.length ? la.slice().sort().slice(-1)[0] : "",
      rows: { early_access: ea.length, early_access_email: em.length, announce: an.length, launch: la.length },
    };
  }
  return out;
}

/* A campaigns database's date columns by name: which stage each records. */
const DATE_PROP_RE = {
  private_room_open: /early[\s-]?access|private[\s-]?room|preview|priority/i,
  announce_date: /announc/i,
  launch_end: /\blaunch|\bclos(e|es|ing)?\b|\bend(s|ing)?\b|draw date/i,
};

function campaignRowDates(props) {
  const out = {};
  for (const [name, p] of Object.entries(props)) {
    if (!p || p.type !== "date" || !p.date || !p.date.start) continue;
    // the first stage whose words the column carries claims it, in the order
    // above: an "Early access send" is the private room, not a launch
    const key = Object.keys(DATE_PROP_RE).find((k) => DATE_PROP_RE[k].test(name));
    if (key && !out[key]) out[key] = p.date.start.slice(0, 10);
  }
  return out;
}

/* The column the marketing lead is recorded in: a people property (a
 * colleague picked from the workspace), or a select or text one, named for it.
 * The names are tried in order, so a "Marketing lead" wins over an "Owner"
 * when a database has both, and a "Lead time" is not a lead. Nothing found:
 * the status line says so, and the lead stays Airtable's or typed. */
const LEAD_TYPES = new Set(["people", "relation", "select", "multi_select", "rich_text", "status", "formula", "rollup"]);
const LEAD_NAMES = [/marketing\s*lead/i, /(campaign|launch|project)\s*lead/i, /^lead$/i, /\blead\b(?!\s*(time|magnet|gen))/i, /\bowner\b/i, /marketing\s*manager/i];

/* The lead column among some properties and how specific its name is (its
 * index in LEAD_NAMES, lower the more so), so a "Marketing Lead" on the
 * release's page outranks an "Owner" on the post row that links to it. */
function leadRank(props) {
  const cands = Object.entries(props || {}).filter(([, p]) => p && LEAD_TYPES.has(p.type));
  for (let i = 0; i < LEAD_NAMES.length; i++) {
    const hit = cands.find(([name]) => LEAD_NAMES[i].test(name));
    if (hit) return { name: hit[0], rank: i };
  }
  return null;
}

function leadProp(props) {
  const r = leadRank(props);
  return r ? r.name : null;
}

/* The names on a lead column that needs no fetching. A people value is read
 * for each person's display name and nothing else: the API's user object also
 * carries an email, which is left where it is (DATA_MODEL 1.6: a colleague's
 * display name, never an address). A formula reads its string, a rollup each
 * value it gathers, and any other type reads through propText; a relation
 * reads nothing here (leadNamesAsync fetches the linked pages' titles). Empty
 * names drop out. */
const cleanNames = (vals) => vals.map((v) => String(v || "").replace(/\s+/g, " ").trim()).filter(Boolean);
function leadNames(p) {
  if (!p) return [];
  let vals;
  if (p.type === "people") vals = (p.people || []).map((u) => (u && u.name) || "");
  else if (p.type === "formula") vals = p.formula && p.formula.type === "string" && p.formula.string ? [p.formula.string] : [];
  else if (p.type === "rollup") vals = p.rollup && p.rollup.type === "array" ? (p.rollup.array || []).flatMap((v) => leadNames(v)) : [];
  else if (p.type === "relation") vals = [];
  else vals = propText(p);
  return cleanNames(vals);
}

/* The same with the relations followed: a lead that is a relation to a team
 * page (the usual shape - a person's page with their photo for its icon) is
 * read for that page's title, and a rollup over one the same way. */
async function leadNamesAsync(p, token) {
  if (!p) return [];
  if (p.type === "relation") return cleanNames((await relatedPages(p, token)).map((pg) => pg.title));
  if (p.type === "rollup" && p.rollup && p.rollup.type === "array") {
    const out = [];
    for (const v of p.rollup.array || []) out.push(...await leadNamesAsync(v, token));
    return cleanNames(out);
  }
  return leadNames(p);
}

/* The lead a row records, as {names, from} or null: its own lead column, or
 * the one on a page it links to - a post row's release page in the campaigns
 * database, where the team actually keeps the lead - with the most specific
 * column name winning and the row's own on a tie. `from` names the column
 * for the status line ("Release → Marketing Lead"). A column found whose
 * names could not be read (the linked pages are not shared with the
 * integration) comes back with no names, so the status can say so. */
async function leadOf(props, token) {
  const found = [];
  const own = leadRank(props);
  if (own) found.push({ ...own, names: await leadNamesAsync(props[own.name], token), from: own.name });
  for (const [pname, p] of Object.entries(props || {})) {
    if (!p || p.type !== "relation") continue;
    for (const page of await relatedPages(p, token)) {
      const r = leadRank(page.props);
      if (r) found.push({ ...r, names: await leadNamesAsync(page.props[r.name], token), from: `${pname} → ${r.name}` });
    }
  }
  const named = found.filter((f) => f.names.length).sort((a, b) => a.rank - b.rank);
  return named[0] || (found.length ? { ...found[0], names: [] } : null);
}

/* Co-leads stay together: a row's lead is its names in one string. */
const leadText = (names) => names.join(", ");

/* One lead per release from the post rows' names: the name most rows carry,
 * the alphabetical first on a tie, so the file is the same from one refresh
 * to the next. A release whose rows name nobody has no lead here. */
function campaignLeads(leadCounts) {
  const out = {};
  for (const [key, names] of leadCounts.entries()) {
    const ranked = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length) out[key] = ranked[0][0];
  }
  return out;
}

const csvField = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
function datesCsv(dates) {
  const lines = ["campaign_code,release_name,private_room_open,announce_date,launch_end,marketing_lead,early_access_rows,early_access_email_rows,announce_rows,launch_rows,source"];
  for (const key of Object.keys(dates).sort()) {
    const d = dates[key];
    const code = d.code !== undefined ? d.code : (key.startsWith("name:") ? "" : key);
    lines.push([csvField(code || ""), csvField(d.name || (key.startsWith("name:") ? key.slice(5) : "")), d.private_room_open || "", d.announce_date || "", d.launch_end || "",
      csvField(d.marketing_lead || ""),
      d.rows ? d.rows.early_access : "", d.rows ? (d.rows.early_access_email || 0) : "", d.rows ? d.rows.announce : "", d.rows ? d.rows.launch : "", d.source || "posts"].join(","));
  }
  return lines.join("\n") + "\n";
}

function propDate(props) {
  const entries = Object.entries(props).filter(([, p]) => p && p.type === "date" && p.date && p.date.start);
  if (!entries.length) return null;
  const preferred = entries.find(([name]) => /date|post|publish/i.test(name)) || entries[0];
  return preferred[1].date.start.slice(0, 10);
}

async function notionFetch(url, token, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint = res.status === 401 ? " - check NOTION_TOKEN"
      : res.status === 404 ? " - is the database page shared with the integration?" : "";
    throw new Error(`Notion API ${res.status}${hint} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/* The pages a relation property points to (the first three), each with its
 * title and its properties, fetched once per page id and kept for the life
 * of the process: a post row's release page is read for its title (the
 * matcher's words) and for the lead column it carries (leadOf), a lead's own
 * page for its title. A page the integration cannot read - its database is
 * not shared with it - is left out and counted, and tried again next pull. */
const pageCache = new Map();
let pagesUnread = 0;
async function relatedPages(p, token) {
  if (!p || p.type !== "relation") return [];
  const out = [];
  for (const rel of (p.relation || []).slice(0, 3)) {
    if (!pageCache.has(rel.id)) {
      try {
        const page = await notionFetch(`https://api.notion.com/v1/pages/${rel.id}`, token);
        const titleProp = Object.values(page.properties || {}).find((q) => q.type === "title");
        pageCache.set(rel.id, { id: rel.id, title: propText(titleProp).join(" ").trim(), props: page.properties || {} });
      } catch {
        pageCache.set(rel.id, null);
        pagesUnread++;
      }
    }
    const page = pageCache.get(rel.id);
    if (page) out.push(page);
  }
  return out;
}

async function relationTitles(p, token) {
  return (await relatedPages(p, token)).map((pg) => pg.title).filter(Boolean);
}

async function fetchPostsCsv() {
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  const releases = knownReleases();
  if (!releases.length) throw new Error("no known releases to match against");
  const counts = new Map(); // "code|date|channel" -> n
  const schema = new Map();  // property name -> {type, values}
  const byChannel = new Map();   // channel -> n, for the status line
  const unnamed = new Map();     // an unclassified channel value -> n
  const stageDates = new Map();  // code -> {early_access: [dates], announce: [...], launch: [...]}
  const leadCounts = new Map();  // release key -> Map(name -> rows naming it), off the rows' lead column or their release page's
  const leadCols = new Set();    // the lead columns read, for the status line
  let matched = 0, unmatched = 0, cursor = undefined, propNames = null, chanProp = null;
  // a page that could not be read last time is tried again: sharing it with the integration is the usual fix
  for (const [id, page] of pageCache) if (page === null) pageCache.delete(id);
  pagesUnread = 0;
  for (let page = 0; page < 40; page++) {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await notionFetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, token, body);
    for (const row of res.results || []) {
      const props = row.properties || {};
      if (!propNames) propNames = Object.keys(props);
      // every row, matched or not: an unmatched row is still evidence of what
      // the columns hold, and the unmatched are the ones being asked about
      noteSchema(schema, props);
      const texts = [];
      for (const p of Object.values(props)) {
        texts.push(...propText(p));
        texts.push(...await relationTitles(p, token));
      }
      if (chanProp === null) chanProp = channelProp(props) || "";
      const date = propDate(props) || String(row.created_time || "").slice(0, 10);
      const rel = matchRelease(texts, releases, date || null);
      if (!rel) { unmatched++; continue; }
      if (!date) { unmatched++; continue; }
      matched++;
      const { channel, value } = rowChannel(props, chanProp || null);
      if (channel === "other" && value) unnamed.set(value, (unnamed.get(value) || 0) + 1);
      byChannel.set(channel, (byChannel.get(channel) || 0) + 1);
      // the posts file is by campaign code: a launch without one yet has no
      // posts row, and its dates below still find it by name
      if (rel.code) {
        const key = `${rel.code}|${date}|${channel}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const stage = stageOf(texts);
      if (stage) {
        if (!stageDates.has(rel.key)) stageDates.set(rel.key, { code: rel.code, name: rel.name });
        const st = stageDates.get(rel.key);
        (st[stage] = st[stage] || []).push(date);
        if (stage === "early_access" && isEmailRow(texts)) (st.early_access_email = st.early_access_email || []).push(date);
      }
      // the row's lead - its own column, or its release page's - counted towards the release's (campaignLeads picks the commonest)
      const lead = await leadOf(props, token);
      if (lead) {
        leadCols.add(lead.from);
        if (lead.names.length) {
          if (!leadCounts.has(rel.key)) leadCounts.set(rel.key, new Map());
          const names = leadCounts.get(rel.key);
          const n = leadText(lead.names);
          names.set(n, (names.get(n) || 0) + 1);
        }
      }
    }
    cursor = res.has_more ? res.next_cursor : null;
    if (!cursor) break;
  }
  if (propNames) console.log("notion: database properties:", propNames.join(" | "));
  if (matched === 0) {
    throw new Error(`no rows matched a known release (${unmatched} unmatched) - ` +
      "check the database's campaign/artist column against the release names");
  }
  const lines = ["campaign_code,date,channel,posts"];
  for (const [key, n] of [...counts.entries()].sort()) {
    const [code, date, channel] = key.split("|");
    lines.push(`${code},${date},${channel},${n}`);
  }
  // the campaign dates: the rows' own words first, a campaigns database's
  // date columns over them where one is named
  const dates = campaignDates(stageDates);
  // the marketing lead the post rows name per release (the campaigns database's own column wins below)
  const leads = campaignLeads(leadCounts);
  for (const [key, lead] of Object.entries(leads)) {
    const rel = releases.find((r) => r.key === key);
    dates[key] = { ...(dates[key] || { rows: null, code: rel ? rel.code : "", name: rel ? rel.name : "" }), marketing_lead: lead };
  }
  let fromDb = 0;
  const leadColsDb = new Set();
  if (CAMPAIGNS_DB_ID) {
    let dcursor = undefined;
    for (let page = 0; page < 10; page++) {
      const body = { page_size: 100, ...(dcursor ? { start_cursor: dcursor } : {}) };
      const res = await notionFetch(`https://api.notion.com/v1/databases/${CAMPAIGNS_DB_ID}/query`, token, body);
      for (const row of res.results || []) {
        const props = row.properties || {};
        const texts = [];
        for (const p of Object.values(props)) {
          texts.push(...propText(p));
          texts.push(...await relationTitles(p, token));
        }
        const got = campaignRowDates(props);
        const lead = await leadOf(props, token);
        if (lead) leadColsDb.add(lead.from);
        const name = lead && lead.names.length ? leadText(lead.names) : "";
        // a row with neither a date nor a lead says nothing about its release
        if (!Object.keys(got).length && !name) continue;
        const rel = matchRelease(texts, releases, got.announce_date || got.private_room_open || got.launch_end || null);
        if (!rel) continue;
        fromDb++;
        const before = dates[rel.key] || { rows: null };
        dates[rel.key] = { ...before, code: rel.code, name: rel.name, ...got, source: Object.keys(got).length ? "campaigns db" : before.source || "campaigns db",
          ...(name ? { marketing_lead: name } : {}) };
      }
      dcursor = res.has_more ? res.next_cursor : null;
      if (!dcursor) break;
    }
  }
  const split = [...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ");
  const strays = [...unnamed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([v, n]) => `"${v}" ${n}`).join(", ");
  const dated = Object.values(dates);
  // the lead, for the status line: how many releases have one and which columns gave it, or why none did
  const leadsFor = dated.filter((d) => d.marketing_lead).length;
  const leadFrom = [...[...leadColsDb].map((c) => `${c} (campaigns database)`), ...leadCols];
  const unread = pagesUnread ? `; ${pagesUnread} linked page${pagesUnread === 1 ? "" : "s"} could not be read (share the database it is in with the integration)` : "";
  const leadNote = leadsFor ? `marketing lead for ${leadsFor} releases (from ${leadFrom.map((c) => `"${c}"`).join(", ")})${unread}`
    : leadFrom.length ? `a marketing lead column (${leadFrom.map((c) => `"${c}"`).join(", ")}) but no names could be read from it${unread}`
    : `no marketing lead column found${unread}`;
  return {
    csv: lines.join("\n") + "\n", matched, unmatched,
    schema: summariseSchema(schema), split, strays, chanProp,
    datesCsv: datesCsv(dates), datesFor: dated.filter((d) => d.private_room_open || d.announce_date || d.launch_end).length, fromDb,
    datesSplit: `private room ${dated.filter((d) => d.private_room_open).length}, announce ${dated.filter((d) => d.announce_date).length}, launch ${dated.filter((d) => d.launch_end).length}`,
    leadsFor, leadFrom, leadNote, pagesUnread,
  };
}

/* Fetch and write the CSV; returns a status string for the refresh summary. */
async function refreshArtistPosts() {
  if (!process.env.NOTION_TOKEN) return "notion off (no NOTION_TOKEN)";
  const out = await fetchPostsCsv();
  const tmp = OUT + ".tmp";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(tmp, out.csv);
  fs.renameSync(tmp, OUT);
  fs.writeFileSync(DATES_OUT + ".tmp", out.datesCsv);
  fs.renameSync(DATES_OUT + ".tmp", DATES_OUT);
  return `notion ${out.matched} posts` + (out.unmatched ? ` (${out.unmatched} unmatched)` : "")
    + `; campaign dates for ${out.datesFor} releases (${out.datesSplit}` + (CAMPAIGNS_DB_ID ? `; ${out.fromDb} from the campaigns database` : "") + ")"
    + `; ${out.leadNote}`
    + `; by channel: ${out.split || "none"}`
    + (out.chanProp ? ` (from "${out.chanProp}")` : " (no channel column found)")
    + (out.strays ? `; unrecognised channels: ${out.strays}` : "")
    + (out.schema ? `; columns: ${out.schema}` : "");
}

module.exports = { refreshArtistPosts, fetchPostsCsv, matchRelease, propText, propDate, noteSchema, summariseSchema, channelOf, channelProp, rowChannel,
  stageOf, isEmailRow, campaignDates, campaignRowDates, leadProp, leadRank, leadNames, leadNamesAsync, leadOf, campaignLeads, datesCsv, inWindow, knownReleases };
