/* Who each marketing email went to, from HubSpot (dormant until HUBSPOT_TOKEN
 * is set, and not yet part of the hourly refresh: docs/PLAN_MODEL.md).
 *
 * server/hubspot.js keeps a send's name, day, campaign and four counts, which
 * is what the email card reads. The plan model (etl/plan_model.py) also needs
 * the audience: how wide a send went is most of what decides its clicks, and
 * an email built but not yet sent already names the lists it will go to, which
 * is the only place a planned audience is written down (the Notion plan's
 * audience column is filled in on about one email row in ten). So this reads
 * the same endpoint again and keeps, per email:
 *
 *   sources/email_audiences.csv   id, name, state, send_at, campaign, sent,
 *       delivered, opened, clicked, unsubscribed, spam, lists_in, lists_out,
 *       contacts_in
 *   sources/hubspot_lists.csv     list_id, name, size, kind   (only when the
 *       token may read lists: the crm.lists.read scope)
 *
 * `lists_in` and `lists_out` are list ids joined by "|": the lists the send
 * was addressed to and the ones it left out. HubSpot records each list under
 * two ids, an older one and a newer one; the newer is kept, the older only
 * where a send has no newer one (prefixed "v1:" so the two cannot collide).
 * `contacts_in` is how many contacts were addressed one by one, a count and
 * never the ids. `state` is HubSpot's: PUBLISHED went out, DRAFT and
 * SCHEDULED have not.
 *
 * No contact, address or name of a person is read: the lists endpoint is
 * asked for a list's name and size only, and the email's own sender and
 * author fields are left where they are.
 *
 * Emails created in the last HORIZON_DAYS are asked for, as in
 * server/hubspot.js (the listing comes back oldest first, so an unbounded
 * pull would cut off the newest), and the rows already on file for older
 * emails are kept.
 *   node server/emailAudiences.js            what a pull would write (counts only)
 *   node server/emailAudiences.js --write    writes the files */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCES = process.env.SOURCES_PATH || path.join(ROOT, "sources");
const OUT = path.join(SOURCES, "email_audiences.csv");
const LISTS_OUT = path.join(SOURCES, "hubspot_lists.csv");
const API = process.env.HUBSPOT_API || "https://api.hubapi.com/marketing/v3/emails";
const LISTS_API = process.env.HUBSPOT_LISTS_API || "https://api.hubapi.com/crm/v3/lists/";
const HORIZON_DAYS = Math.max(30, Number(process.env.HUBSPOT_AUDIENCE_DAYS) || 1100);
const MAX_PAGES = 150;      // 100 emails a page
const LIST_BATCH = 50;      // list ids asked for at once

const HEADER = ["id", "name", "state", "send_at", "campaign", "sent", "delivered", "opened", "clicked", "unsubscribed", "spam",
  "lists_in", "lists_out", "contacts_in"];
const LISTS_HEADER = ["list_id", "name", "size", "kind"];

const ids = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/* The lists on one side of a send (include or exclude): the newer ids, else
 * the older ones marked as such. */
function listsOf(to, side) {
  const newer = ids((((to || {}).contactIlsLists) || {})[side]);
  if (newer.length) return newer;
  return ids((((to || {}).contactLists) || {})[side]).map((id) => "v1:" + id);
}

const sendAt = (raw) => {
  if (raw === null || raw === undefined || raw === "") return "";
  const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace("T", " ").slice(0, 19);
};

/* One email of the listing as a line of the file, or null for one that says
 * nothing: never sent and addressed to nobody (a template, an abandoned draft). */
function audienceRow(e) {
  const c = ((e.stats || {}).counters) || {};
  const to = e.to || {};
  const inc = listsOf(to, "include"), exc = listsOf(to, "exclude");
  const contacts = ids(((to.contactIds) || {}).include).length;
  const sent = c.sent ?? 0, delivered = c.delivered ?? 0;
  if (!sent && !delivered && !inc.length && !contacts) return null;
  return {
    id: String(e.id ?? ""), name: String(e.name || "").replace(/\s+/g, " ").trim(), state: e.state || "",
    send_at: sendAt(e.publishDate ?? e.publishedAt ?? e.sendOn), campaign: e.campaignName || "",
    sent, delivered, opened: c.open ?? c.opened ?? 0, clicked: c.click ?? c.clicked ?? 0,
    unsubscribed: c.unsubscribed ?? 0, spam: c.spamreport ?? 0,
    lists_in: inc.join("|"), lists_out: exc.join("|"), contacts_in: contacts,
  };
}

const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (header, rows) => header.join(",") + "\n" + rows.map((r) => header.map((h) => cell(r[h])).join(",")).join("\n") + (rows.length ? "\n" : "");

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

/* The rows already on file, by email id, so a pull keeps what it did not fetch again. */
function readExisting(file = OUT) {
  const rows = new Map();
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return rows; }
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0] || "");
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const rec = Object.fromEntries(header.map((h, i) => [h, f[i] ?? ""]));
    if (rec.id) rows.set(rec.id, rec);
  }
  return rows;
}

async function getJson(url, token) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return { ok: true, body: await res.json() };
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, (2 + attempt * 2) * 1000));
      continue;
    }
    return { ok: false, status: res.status, text: (await res.text().catch(() => "")).slice(0, 200) };
  }
}

/* What kind of audience a list is, from its name, for the plan model's
 * groups. The names are written by hand, so this reads them by shape and
 * leaves what it cannot place as "other", to be counted, not guessed. */
function listKind(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return "other";
  if (/insider|vip|t1\b|t2\b|top collector/.test(n)) return "insiders";
  if (/unsub|suppress|exclu|bounce|do not|dnc|opt.?out|test\b/.test(n)) return "exclusion";
  if (/related|similar|lookalike/.test(n)) return "related_artist";
  if (/buyer|purchas|collector|owner|customer|order/.test(n)) return "buyers";
  if (/sign.?up|\bsu\b|waitlist|notify|interest|follow|subscri/.test(n)) return "sign_ups";
  if (/miss.?out|loser|lost|unsuccess/.test(n)) return "missed_out";
  if (/engag|open|click|active|visitor|viewed/.test(n)) return "engaged";
  if (/all |general|newsletter|marketable|everyone|full list|master/.test(n)) return "general";
  return "other";
}

/* Names and sizes of the lists the sends name. Resolves to { rows, note }:
 * no rows and a note when the token may not read lists. */
async function fetchLists(listIds, token) {
  const want = [...new Set(listIds.filter((id) => id && !id.startsWith("v1:")))];
  const rows = [];
  for (let i = 0; i < want.length; i += LIST_BATCH) {
    const q = want.slice(i, i + LIST_BATCH).map((id) => "listIds=" + encodeURIComponent(id)).join("&");
    const res = await getJson(`${LISTS_API}?${q}`, token);
    if (!res.ok) {
      const scope = res.status === 403 ? " - the token needs the crm.lists.read scope (HubSpot, Private Apps, the app's Scopes, then Commit changes)" : "";
      return { rows: [], note: `list names unavailable (HubSpot ${res.status}${scope})` };
    }
    for (const l of res.body.lists || []) {
      const size = ((l.additionalProperties || {}).hs_list_size) ?? "";
      rows.push({ list_id: String(l.listId ?? ""), name: String(l.name || "").replace(/\s+/g, " ").trim(), size, kind: listKind(l.name) });
    }
  }
  return { rows, note: `${rows.length} of ${want.length} lists named` };
}

async function fetchAudiences(now = Date.now()) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return null;
  const since = new Date(now - HORIZON_DAYS * 864e5).toISOString();
  const pulled = new Map();
  let after = null, pages = 0, capped = false;
  for (;;) {
    if (pages >= MAX_PAGES) { capped = !!after; break; }
    const url = `${API}?limit=100&includeStats=true&createdAfter=${encodeURIComponent(since)}` + (after ? `&after=${encodeURIComponent(after)}` : "");
    const res = await getJson(url, token);
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " - check the Private App token and its Marketing Email read scope" : "";
      throw new Error(`HubSpot API ${res.status}${hint} ${res.text}`);
    }
    pages++;
    for (const e of res.body.results || []) {
      const row = audienceRow(e);
      if (row && row.id) pulled.set(row.id, row);
    }
    after = res.body.paging && res.body.paging.next && res.body.paging.next.after;
    if (!after) break;
  }
  if (pulled.size === 0) throw new Error("HubSpot returned no emails - not overwriting the audiences file");
  const rows = [];
  let kept = 0;
  for (const [id, row] of readExisting()) if (!pulled.has(id)) { rows.push(row); kept++; }
  rows.push(...pulled.values());
  rows.sort((a, b) => (String(a.send_at) + a.id < String(b.send_at) + b.id ? -1 : 1));
  const listIds = rows.flatMap((r) => String(r.lists_in || "").split("|").concat(String(r.lists_out || "").split("|")));
  const lists = await fetchLists(listIds, token);
  const sentRows = rows.filter((r) => Number(r.delivered) > 0);
  return {
    csv: csv(HEADER, rows), listsCsv: lists.rows.length ? csv(LISTS_HEADER, lists.rows) : null,
    rows: rows.length, pulled: pulled.size, kept, pages, capped, listsNote: lists.note,
    sent: sentRows.length, unsent: rows.length - sentRows.length,
    withLists: rows.filter((r) => r.lists_in).length,
    through: sentRows.reduce((m, r) => (String(r.send_at).slice(0, 10) > m ? String(r.send_at).slice(0, 10) : m), ""),
  };
}

const summary = (out) => `email audiences ${out.rows} emails (${out.sent} sent, through ${out.through}; ${out.unsent} not sent yet; `
  + `${out.withLists} naming a list; ${out.pulled} pulled, ${out.kept} kept from the file); ${out.listsNote}`
  + (out.capped ? `; CAPPED at ${MAX_PAGES} pages, the newest emails are missing` : "");

/* Fetch and write the files; returns a status string. The lists file is left
 * as it is when the names could not be read. */
async function refreshAudiences() {
  if (!process.env.HUBSPOT_TOKEN) return "email audiences off (no HUBSPOT_TOKEN)";
  const out = await fetchAudiences();
  fs.mkdirSync(SOURCES, { recursive: true });
  fs.writeFileSync(OUT + ".tmp", out.csv);
  fs.renameSync(OUT + ".tmp", OUT);
  if (out.listsCsv) {
    fs.writeFileSync(LISTS_OUT + ".tmp", out.listsCsv);
    fs.renameSync(LISTS_OUT + ".tmp", LISTS_OUT);
  }
  return summary(out);
}

module.exports = { fetchAudiences, refreshAudiences, audienceRow, listsOf, listKind, fetchLists, readExisting, csv, summary,
  HEADER, LISTS_HEADER, OUT, LISTS_OUT };

if (require.main === module) {
  (async () => {
    if (!process.env.HUBSPOT_TOKEN) { console.error("HUBSPOT_TOKEN is not set."); process.exit(1); }
    if (process.argv.includes("--write")) { console.log(await refreshAudiences()); return; }
    console.log(summary(await fetchAudiences()));
    console.log("dry run - pass --write to write sources/email_audiences.csv (and sources/hubspot_lists.csv when lists can be read)");
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
