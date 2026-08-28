/* Notion artist-posts ingestion (dormant until NOTION_TOKEN is set).
 *
 * The marketing team logs artist-account posts in a Notion database (one row
 * per post). Each refresh queries it and writes data/artist_posts.csv
 * (campaign_code,date,posts) for the ETL, which turns it into the Referral
 * artist "Posts" rung and its tier benchmark.
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
const OUT = path.join(ROOT, "data", "artist_posts.csv");
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
  const counts = new Map(); // "code|date" -> n
  let matched = 0, unmatched = 0, cursor = undefined, propNames = null;
  for (let page = 0; page < 40; page++) {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await notionFetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, token, body);
    for (const row of res.results || []) {
      const props = row.properties || {};
      if (!propNames) propNames = Object.keys(props);
      const texts = [];
      for (const p of Object.values(props)) {
        texts.push(...propText(p));
        texts.push(...await relationTitles(p, token));
      }
      const code = matchRelease(texts, releases);
      if (!code) { unmatched++; continue; }
      const date = propDate(props) || String(row.created_time || "").slice(0, 10);
      if (!date) { unmatched++; continue; }
      matched++;
      const key = `${code}|${date}`;
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
  const lines = ["campaign_code,date,posts"];
  for (const [key, n] of [...counts.entries()].sort()) {
    const [code, date] = key.split("|");
    lines.push(`${code},${date},${n}`);
  }
  return { csv: lines.join("\n") + "\n", matched, unmatched };
}

/* Fetch and write the CSV; returns a status string for the refresh summary. */
async function refreshArtistPosts() {
  if (!process.env.NOTION_TOKEN) return "notion off (no NOTION_TOKEN)";
  const out = await fetchPostsCsv();
  const tmp = OUT + ".tmp";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(tmp, out.csv);
  fs.renameSync(tmp, OUT);
  return `notion ${out.matched} posts` + (out.unmatched ? ` (${out.unmatched} unmatched)` : "");
}

module.exports = { refreshArtistPosts, fetchPostsCsv, matchRelease, propText, propDate };
