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
const DB_ID = process.env.NOTION_ARTIST_POSTS_DB || "1b6e65265ca280a898d1e74c0661344c";
const NOTION_VERSION = "2022-06-28";

function knownReleases() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "inputs.json"), "utf8"));
    return Object.values(doc.releases || {}).map((r) => ({
      code: r.campaign_code,
      name: r.release_name || "",
      artist: String(r.release_name || "").split("·")[0].trim(),
    })).filter((r) => r.code);
  } catch {
    return [];
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function matchRelease(texts, releases) {
  const hay = norm(texts.join(" | "));
  if (!hay) return null;
  for (const r of releases) {
    if (hay.includes(norm(r.code))) return r.code;
  }
  for (const r of releases) {
    if (r.name && hay.includes(norm(r.name))) return r.code;
  }
  for (const r of releases) {
    if (r.artist && r.artist.length >= 4 && hay.includes(norm(r.artist))) return r.code;
  }
  return null;
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

const relationTitleCache = new Map();
async function relationTitles(p, token) {
  if (!p || p.type !== "relation") return [];
  const out = [];
  for (const rel of (p.relation || []).slice(0, 3)) {
    if (!relationTitleCache.has(rel.id)) {
      try {
        const page = await notionFetch(`https://api.notion.com/v1/pages/${rel.id}`, token);
        const titleProp = Object.values(page.properties || {}).find((q) => q.type === "title");
        relationTitleCache.set(rel.id, propText(titleProp).join(" "));
      } catch {
        relationTitleCache.set(rel.id, "");
      }
    }
    out.push(relationTitleCache.get(rel.id));
  }
  return out.filter(Boolean);
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
  let matched = 0, unmatched = 0, cursor = undefined, propNames = null, chanProp = null;
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
      const code = matchRelease(texts, releases);
      if (!code) { unmatched++; continue; }
      const date = propDate(props) || String(row.created_time || "").slice(0, 10);
      if (!date) { unmatched++; continue; }
      matched++;
      const { channel, value } = rowChannel(props, chanProp || null);
      if (channel === "other" && value) unnamed.set(value, (unnamed.get(value) || 0) + 1);
      byChannel.set(channel, (byChannel.get(channel) || 0) + 1);
      const key = `${code}|${date}|${channel}`;
      counts.set(key, (counts.get(key) || 0) + 1);
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
  const split = [...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ");
  const strays = [...unnamed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([v, n]) => `"${v}" ${n}`).join(", ");
  return {
    csv: lines.join("\n") + "\n", matched, unmatched,
    schema: summariseSchema(schema), split, strays, chanProp,
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
  return `notion ${out.matched} posts` + (out.unmatched ? ` (${out.unmatched} unmatched)` : "")
    + `; by channel: ${out.split || "none"}`
    + (out.chanProp ? ` (from "${out.chanProp}")` : " (no channel column found)")
    + (out.strays ? `; unrecognised channels: ${out.strays}` : "")
    + (out.schema ? `; columns: ${out.schema}` : "");
}

module.exports = { refreshArtistPosts, fetchPostsCsv, matchRelease, propText, propDate, noteSchema, summariseSchema, channelOf, channelProp, rowChannel };
