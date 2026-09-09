/* HubSpot marketing-email content export, text only, as a background job.
 *
 *   GET /api/emails/content/status?run=1[&years=2]   starts it (returns at once)
 *   GET /api/emails/content/status                    progress / outcome
 *   GET /api/emails/content.csv                       the file, once done
 *
 * One row per email published inside the window: id, name, subject, preview
 * text, campaign, send date, state, delivered / opened / clicked, and the
 * email's text - HubSpot's plain-text version when it holds one, otherwise the
 * text of every content module with the tags stripped. No HTML is kept.
 *
 * The list call already carries stats and sometimes the content modules; an
 * email whose list item has no content is fetched by id. Private-app rate
 * limits (about 100 calls per 10 s) are respected with a small worker pool and
 * Retry-After back-off. The field walk was written without a live response to
 * look at, so the status reports the first email's top-level and content keys
 * and how many rows came out empty: a wrong field name shows on the first run
 * instead of as silent blank rows. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.EMAIL_CONTENT_PATH || path.join(ROOT, "data", "email_content.csv");
const API = "https://api.hubapi.com/marketing/v3/emails";
const MAX_PAGES = 120;   // 100 emails per page
const WORKERS = 4;
const TEXT_KEYS = new Set(["html", "text", "richtext", "rich_text", "richText", "value", "body", "content",
  "paragraph", "heading", "headline", "subheading", "subheadline", "title", "subtitle",
  "button_text", "buttonText", "cta_text", "ctaText", "plainTextVersion", "plain_text"]);

const state = { running: false, startedAt: null, finishedAt: null, years: null, total: null,
  fetched: 0, written: 0, empty: 0, error: null, sample: null, file: null };

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”",
  ldquo: "“", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", pound: "£", euro: "€", middot: "·" };
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\s*(br|hr)\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|td|th|table|section|article|blockquote)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const looksLikeText = (s) => typeof s === "string" && s.trim().length >= 3
  && !/^https?:\/\//i.test(s.trim()) && !/^[{[]/.test(s.trim()) && !/^\s*[.#][\w-]+\s*\{/.test(s);

/* Depth-first over the content tree: every string under a text-like key,
 * tags stripped, in document order, once each. */
function collectText(node, out, seen, depth = 0) {
  if (depth > 12 || node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const v of node) collectText(v, out, seen, depth + 1); return; }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") {
      if (TEXT_KEYS.has(k) && looksLikeText(v)) {
        const t = htmlToText(v);
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    } else collectText(v, out, seen, depth + 1);
  }
}
function findKey(node, key, depth = 0) {
  if (depth > 8 || node === null || typeof node !== "object") return undefined;
  if (typeof node[key] === "string") return node[key];
  for (const v of Object.values(node)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
function extractText(email) {
  const c = email.content || {};
  const plain = typeof c.plainTextVersion === "string" ? c.plainTextVersion.trim() : "";
  if (plain.length >= 40) return htmlToText(plain);
  const out = [], seen = new Set();
  collectText(c.widgets ?? c, out, seen);
  return out.join("\n\n");
}
const hasContent = (e) => !!(e && e.content && (e.content.plainTextVersion || e.content.widgets));

function parseDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}
const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hub(url, token) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * attempt);
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot API ${res.status} ${text.slice(0, 200)}`);
  }
}

async function listEmails(token) {
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await hub(API + "?limit=100&includeStats=true" + (after ? `&after=${encodeURIComponent(after)}` : ""), token);
    rows.push(...(body.results || []));
    after = body.paging && body.paging.next && body.paging.next.after;
    if (!after) break;
  }
  return rows;
}

async function run(years) {
  const token = process.env.HUBSPOT_TOKEN;
  const since = Date.now() - years * 365.25 * 864e5;
  const all = await listEmails(token);
  const wanted = all.map((e) => ({ e, d: parseDate(e.publishDate ?? e.publishedAt ?? e.sendOn) }))
    .filter((x) => x.d && x.d.getTime() >= since)
    .sort((a, b) => b.d - a.d);
  state.total = wanted.length;
  if (wanted.length) {
    const first = wanted[0].e;
    state.sample = { keys: Object.keys(first).slice(0, 40), contentKeys: first.content ? Object.keys(first.content).slice(0, 40) : null };
  }
  // fill in content for list items that came without it
  const queue = wanted.filter((x) => !hasContent(x.e));
  let i = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < queue.length) {
      const x = queue[i++];
      const full = await hub(`${API}/${encodeURIComponent(x.e.id)}`, token);
      x.e = { ...x.e, ...full, stats: x.e.stats || full.stats };
      state.fetched++;
    }
  }));
  const header = ["id", "name", "subject", "preview_text", "campaign", "send_date", "state", "delivered", "opened", "clicked", "text"];
  const lines = [header.join(",")];
  for (const { e, d } of wanted) {
    const c = (e.stats && e.stats.counters) || {};
    const text = extractText(e);
    if (!text) state.empty++;
    lines.push([
      cell(e.id), cell(e.name), cell(e.subject ?? findKey(e, "subject") ?? ""), cell(findKey(e, "previewText") ?? ""),
      cell(e.campaignName ?? e.campaign ?? ""), d.toISOString().slice(0, 19).replace("T", " "), cell(e.state ?? ""),
      c.delivered ?? "", c.open ?? c.opened ?? "", c.click ?? c.clicked ?? "", cell(text),
    ].join(","));
    state.written++;
  }
  if (state.sample) state.sample.firstTextChars = extractText(wanted[0].e).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + ".tmp", lines.join("\n") + "\n");
  fs.renameSync(OUT + ".tmp", OUT);
  state.file = OUT;
}

function start({ years = 2 } = {}) {
  if (!process.env.HUBSPOT_TOKEN) return { error: "HUBSPOT_TOKEN is not set on this server" };
  if (state.running) return { started: false, note: "already running", ...status() };
  Object.assign(state, { running: true, startedAt: new Date().toISOString(), finishedAt: null, years,
    total: null, fetched: 0, written: 0, empty: 0, error: null, sample: null });
  run(years).catch((e) => { state.error = String((e && e.message) || e).slice(0, 400); })
    .finally(() => { state.running = false; state.finishedAt = new Date().toISOString(); });
  return { started: true, ...status() };
}
function status() {
  return { ...state, download: state.file && !state.running ? "/api/emails/content.csv" : null };
}
const file = () => (!state.running && fs.existsSync(OUT) ? OUT : null);

module.exports = { start, status, file, extractText, htmlToText };
