/* Live data ingestion straight from BigQuery - the origin of every funnel and
 * spend number in the dashboard (docs/DATA_MODEL.md §2).
 *
 * This replaces the Google Sheet relay for the two files the ETL reads:
 *   le_funnel_report_split_touch_export -> sources/across_time.csv
 *   meta_ads_insights_export            -> data/spend_daily.csv
 * Same two files, same row converters as the sheet path (sheets.js), so
 * build.py is unchanged and the two feeds are interchangeable.
 *
 * Why bother: the sheet tabs are query exports capped at 50,000 rows, cut mid
 * date. That cap does not error - it silently shortens the history window as
 * new launches push older days off the end, which is what limits the curve
 * panel to a handful of complete campaigns. Reading the table removes the cap.
 *
 * Incremental: a full pull is ~420k rows and takes minutes, for a few hundred
 * new rows an hour. So the hourly refresh re-pulls only the last
 * BQ_OVERLAP_DAYS (default 45) and keeps the older local rows. The overlap is
 * not a nicety: entry-to-order conversion keeps changing a day's row until the
 * draw settles, so recent history is live. A FULL pull runs every
 * BQ_FULL_EVERY_DAYS (default 7), on ?run=1&full=1, when BQ_SINCE or the
 * column set changes, or when there is no local file - and it counts how many
 * days older than the overlap changed since last time, so the assumption that
 * deep history is static is measured, not trusted. Upstream backfills (e.g.
 * announcement dates for the back catalogue) rewrite the clock columns years
 * back; the weekly full pull is what picks those up.
 *
 * Memory: results are STREAMED to disk a page at a time. A pull back to 2023
 * held in memory as the API's row objects is ~900 MB, and the Render instance
 * has 512. Holding it killed the process, which Render reports as a 502.
 * Nothing here keeps more than one page.
 *
 * Setup (env vars only - never commit a key):
 *   BIGQUERY_SERVICE_ACCOUNT_JSON  the key file's contents, verbatim
 *                                  (falls back to GOOGLE_SERVICE_ACCOUNT_JSON)
 *   BQ_PROJECT                     billing/query project   default avantarte-data-production
 *   BQ_DATASET                     default AA_company_tables
 *   BQ_SINCE                       history window start    default 2025-01-01
 * The service account needs BigQuery Data Viewer on the dataset and BigQuery
 * Job User on the project. Spend is optional - if the account cannot see
 * meta_ads_insights_export the funnel still refreshes (BQ_SPEND=off skips it
 * outright). Set BIGQUERY=off to force the sheet path back on. */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { serviceAccount, accessToken } = require("./googleAuth");

const ROOT = path.resolve(__dirname, "..");
const ACROSS_TIME = path.join(ROOT, "sources", "across_time.csv");
const SPEND_DAILY = path.join(ROOT, "data", "spend_daily.csv");
// what the local funnel file is: window, columns, last date, when it was last
// pulled in full. Absent = never pulled from BigQuery (or it came from the sheet)
const META = path.join(ROOT, "sources", "across_time.meta.json");

const PROJECT = process.env.BQ_PROJECT || "avantarte-data-production";
const DATASET = process.env.BQ_DATASET || "AA_company_tables";
const FUNNEL_TABLE = process.env.BQ_FUNNEL_TABLE || "le_funnel_report_split_touch_export";
const SPEND_TABLE = process.env.BQ_SPEND_TABLE || "meta_ads_insights_export";
const SINCE = process.env.BQ_SINCE || "2025-01-01";
const LOCATION = process.env.BQ_LOCATION || undefined; // e.g. "EU"; omit to let BQ infer
const OVERLAP_DAYS = Math.max(1, Number(process.env.BQ_OVERLAP_DAYS) || 45);
const FULL_EVERY_DAYS = Math.max(1, Number(process.env.BQ_FULL_EVERY_DAYS) || 7);
// One page is the only thing held in memory. 5k rows of the 33-column funnel
// table is ~6 MB of API JSON; with the heap capped at 192 MB in package.json's
// start script (V8 otherwise lets garbage pile up to whatever the box allows)
// the process peaks around 150 MB on a 575k-row pull, leaving the ETL its share
// of the 512 MB instance.
const PAGE_ROWS = 5000;

// Table/dataset names are interpolated into SQL (BigQuery has no bind syntax
// for identifiers), so they are whitelisted rather than trusted.
const IDENT = /^[A-Za-z0-9_]+$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{4,29}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function configured() {
  if (process.env.BIGQUERY === "off") return null;
  const sa = serviceAccount("BIGQUERY_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!sa) return null;
  if (!PROJECT_RE.test(PROJECT)) throw new Error(`BQ_PROJECT "${PROJECT}" is not a valid project id`);
  for (const [name, v] of [["BQ_DATASET", DATASET], ["BQ_FUNNEL_TABLE", FUNNEL_TABLE], ["BQ_SPEND_TABLE", SPEND_TABLE]]) {
    if (!IDENT.test(v)) throw new Error(`${name} "${v}" must be letters, digits and underscores`);
  }
  if (!DATE_RE.test(SINCE)) throw new Error(`BQ_SINCE "${SINCE}" must be YYYY-MM-DD`);
  return sa;
}

// ---------------------------------------------------------------- personal data

/* Customer email addresses live in some BigQuery tables (the LE Funnel Report).
 * They must never leave BigQuery: not onto Render's disk, not into a Claude
 * session's terminal, not into a snapshot. Two rules enforce that here:
 *
 *  1. Every result that passes through query() is checked. A column whose name
 *     looks like an email field, or a cell whose value looks like an address,
 *     aborts the query with PiiDetected before anything is written or handed
 *     on. There is no override flag on purpose.
 *  2. Per-person analysis (repeat buyers, sends per contact) uses a keyed hash
 *     computed inside BigQuery - contactKeySql(column) - with PII_HASH_SALT held
 *     in the environment and never in the repo. The key is stable for joins
 *     and useless outside this system.
 *
 * The stronger control sits with the data team: an authorized view that
 * exposes the hashed key instead of the address, so the service account can
 * never read an email at all. Until that exists, these two rules are the
 * fence. */
const PII_COLUMN = /(^|_|\b)(e-?mail|email_?address|customer_?email|user_?email)(\b|_|$)/i;
const PII_VALUE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
class PiiDetected extends Error {}

function piiCheckHeader(header) {
  const hit = header.find((h) => PII_COLUMN.test(String(h)));
  if (hit) {
    throw new PiiDetected(`column "${hit}" looks like an email address field - select an explicit column list ` +
      "that leaves it out, or replace it with contactKeySql() in the query");
  }
}
function piiCheckRows(rows) {
  // a bounded look at each page: every string cell of the first rows, then the
  // first cell of the rest - enough to catch a column of addresses, cheap enough
  // to run on every page
  for (let i = 0; i < rows.length; i++) {
    const cells = i < 20 ? rows[i] : rows[i].slice(0, 1);
    for (const c of cells) {
      if (typeof c === "string" && c.length < 200 && c.includes("@") && PII_VALUE.test(c.trim())) {
        throw new PiiDetected("a result cell looks like an email address - nothing was written; " +
          "restrict the select list or hash the column in BigQuery with contactKeySql()");
      }
    }
  }
}

/* SQL for a stable, keyed, one-way contact key. Pass the salt as the @salt
 * query parameter (contactKeyParams()) so it never appears in the SQL text. */
function contactKeySql(column) {
  if (!process.env.PII_HASH_SALT) throw new Error("PII_HASH_SALT is not set - per-contact keys need it");
  return `TO_HEX(SHA256(CONCAT(@salt, LOWER(TRIM(${column})))))`;
}
const contactKeyParams = () => ({ salt: { type: "STRING", value: process.env.PII_HASH_SALT } });

// ---------------------------------------------------------------- query

/* Runs one query, streaming the result: onHeader(columnNames) once, then
 * onRows(rows) per page, where each row is an array of strings ("" for NULL -
 * values arrive as strings whatever the column type; the converters and pandas
 * both cope). Resolves to { header, rows: count, bytes, cached }.
 *
 * jobs.query returns the first page inline and the rest through
 * getQueryResults. Nothing accumulates: each page is handed on and dropped. */
async function query(token, sql, params = {}, { pageRows = PAGE_ROWS, onHeader, onRows } = {}) {
  const queryParameters = Object.entries(params).map(([name, p]) => ({
    name, parameterType: { type: p.type }, parameterValue: { value: p.value },
  }));
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}`;
  const post = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
      let hint = "";
      if (res.status === 403) {
        hint = " - the service account needs BigQuery Data Viewer on the dataset " +
          "and BigQuery Job User on the project";
      }
      if (res.status === 404) hint = ` - is BQ_PROJECT "${PROJECT}" right?`;
      throw new Error(`BigQuery ${res.status}: ${msg}${hint}`);
    }
    return json;
  };

  let body = await post(`${base}/queries`, {
    query: sql,
    useLegacySql: false,
    useQueryCache: true,     // a repeat of an unchanged query is free
    timeoutMs: 120000,
    maxResults: pageRows,
    parameterMode: "NAMED",
    queryParameters,
    ...(LOCATION ? { location: LOCATION } : {}),
  });

  const job = body.jobReference || {};
  const bytes = Number(body.totalBytesProcessed || 0);
  const cached = !!body.cacheHit;

  const results = `${base}/queries/${job.jobId}?` +
    (job.location ? `location=${encodeURIComponent(job.location)}&` : "");
  const get = async (qs) => {
    const res = await fetch(results + qs, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`BigQuery ${res.status}: ${(json.error && json.error.message) || "?"}`);
    return json;
  };
  // a query that outran timeoutMs comes back incomplete - poll the job
  let waited = 0;
  while (!body.jobComplete) {
    if (waited > 10 * 60_000) throw new Error("BigQuery job did not finish within 10 minutes");
    body = await get(`maxResults=${pageRows}&timeoutMs=60000`);
    waited += 60_000;
  }

  const header = (body.schema && body.schema.fields ? body.schema.fields : []).map((f) => f.name);
  const total = Number(body.totalRows || 0);
  piiCheckHeader(header);
  if (onHeader) onHeader(header);

  let count = 0;
  const take = (b) => {
    const rows = (b.rows || []).map((r) => (r.f || []).map((c) => (c.v === null || c.v === undefined ? "" : c.v)));
    piiCheckRows(rows);
    count += rows.length;
    if (onRows && rows.length) onRows(rows);
  };
  take(body);
  let pageToken = body.pageToken;
  body = null;   // the first page is done with - let it go before fetching the next
  while (pageToken) {
    const page = await get(`maxResults=${pageRows}&pageToken=${encodeURIComponent(pageToken)}`);
    take(page);
    pageToken = page.pageToken;
  }
  if (count < total) {
    throw new Error(`BigQuery paging stopped early: ${count} of ${total} rows`);
  }
  return { header, rows: count, bytes, cached };
}

const funnelSql = () =>
  `SELECT * FROM \`${PROJECT}.${DATASET}.${FUNNEL_TABLE}\`\n` +
  "WHERE event_date >= @since\nORDER BY event_date";
const spendSql = () =>
  `SELECT * FROM \`${PROJECT}.${DATASET}.${SPEND_TABLE}\`\n` +
  "WHERE spend_date >= @since\nORDER BY campaign_name, spend_date";

// ---------------------------------------------------------------- local file

const isoFromDMY = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
function isoMinusDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
// FNV-1a; per-day sums of line hashes give an order-independent fingerprint
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
class DayFingerprints {
  constructor() { this.days = new Map(); }
  add(iso, line) {
    const d = this.days.get(iso) || { n: 0, h: 0 };
    d.n++; d.h = (d.h + fnv(line)) >>> 0;
    this.days.set(iso, d);
  }
  /* days present in `this` (the local file) before `cutoff` that differ in
   * `other` (the fresh pull) - or are missing from it */
  changedBefore(other, cutoff) {
    const out = [];
    for (const [iso, d] of this.days) {
      if (iso >= cutoff) continue;
      const o = other.days.get(iso);
      if (!o || o.n !== d.n || o.h !== d.h) out.push(iso);
    }
    return out.sort();
  }
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return null; }
}
function writeMeta(m) {
  fs.writeFileSync(META + ".tmp", JSON.stringify(m, null, 1));
  fs.renameSync(META + ".tmp", META);
}

/* Streams the local funnel CSV line by line: onLine(line, iso) per data row.
 * Resolves to { header: string[], rows }. Lines are parsed with the same CSV
 * rules the writer used, so a quoted comma in a release name is safe. */
async function scanLocal(file, onLine) {
  const { parseCsv } = require("./sheets");
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  let header = null, di = -1, rows = 0;
  for await (const line of rl) {
    if (header === null) {
      header = parseCsv(line)[0] || [];
      di = header.indexOf("event_date");
      continue;
    }
    if (!line) continue;
    const cells = parseCsv(line)[0] || [];
    rows++;
    onLine(line, isoFromDMY(cells[di]));
  }
  return { header, rows };
}

function existingRows(file) {
  try {
    // header line does not count
    return Math.max(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length - 1, 0);
  } catch { return 0; }
}

/* Refuse to replace a longer history with a shorter one. The 50k sheet cap
 * caused exactly this failure silently; a mis-set BQ_SINCE would too. */
function guardShrink(label, got, file) {
  const had = existingRows(file);
  if (had > 200 && got < had * 0.5 && process.env.BQ_ALLOW_SHRINK !== "1") {
    throw new Error(`${label} came back with ${got} rows but ${path.basename(file)} already has ` +
      `${had} - refusing to shorten the history. Check BQ_SINCE (currently ${SINCE}), ` +
      "or set BQ_ALLOW_SHRINK=1 if the cut is intended.");
  }
}

// ---------------------------------------------------------------- streaming to disk

class Tmp {
  constructor(dest, write) {
    this.path = dest + ".tmp";
    this.fd = null;
    this.buf = [];
    if (write) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      this.fd = fs.openSync(this.path, "w");
    }
  }
  line(s) { if (this.fd !== null) { this.buf.push(s); if (this.buf.length >= 2000) this.flush(); } }
  flush() { if (this.fd !== null && this.buf.length) { fs.writeSync(this.fd, this.buf.join("\n") + "\n"); this.buf = []; } }
  close() { this.flush(); if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
  discard() { try { this.close(); } catch {} try { fs.unlinkSync(this.path); } catch {} }
  commit(dest) { this.close(); if (fs.existsSync(this.path)) fs.renameSync(this.path, dest); }
}

class HeaderChanged extends Error {}

/* Streams one table through a row converter into `tmp`. onRow(line, iso) is
 * called per kept row (for fingerprints and the max date). expectHeader, when
 * given, is the local file's column list: a different set from BigQuery means
 * the local rows cannot be merged with the new ones (HeaderChanged). */
async function streamTable(token, sql, since, makeWriter, tmp, { onRow, expectHeader } = {}) {
  const { normDate } = require("./sheets");
  let writer = null, kept = 0;
  const q = await query(token, sql, { since: { type: "DATE", value: since } }, {
    onHeader(header) {
      writer = makeWriter(header);   // throws if the columns are not what build.py needs
      if (expectHeader && (header.length !== expectHeader.length || header.some((h, i) => h !== expectHeader[i]))) {
        throw new HeaderChanged(`columns changed upstream (${header.length} vs ${expectHeader.length} locally)`);
      }
      tmp.line(writer.header);
    },
    onRows(rows) {
      for (const r of rows) {
        const line = writer.row(r);
        if (line === null) continue;
        kept++;
        tmp.line(line);
        if (onRow) {
          const d = writer.dateIndex >= 0 ? normDate(r[writer.dateIndex]) : null;
          onRow(line, d ? `${d[0]}-${String(d[1]).padStart(2, "0")}-${String(d[2]).padStart(2, "0")}` : null);
        }
      }
    },
  });
  tmp.flush();
  return { header: q.header, rows: kept, dropped: writer ? writer.dropped : 0, bytes: q.bytes, cached: q.cached };
}

// ---------------------------------------------------------------- pull

/* Decides full vs incremental. Returns { mode, reason, meta }. */
function plan(full) {
  const meta = readMeta();
  const usable = meta && meta.since === SINCE && meta.maxDate && Array.isArray(meta.header) && fs.existsSync(ACROSS_TIME);
  if (full) return { mode: "full", reason: "requested", meta };
  if (!meta) return { mode: "full", reason: "no record of a previous pull", meta: null };
  if (!fs.existsSync(ACROSS_TIME)) return { mode: "full", reason: "local file missing", meta: null };
  if (meta.since !== SINCE) return { mode: "full", reason: `BQ_SINCE changed (${meta.since} -> ${SINCE})`, meta: null };
  if (!usable) return { mode: "full", reason: "previous pull record unreadable", meta: null };
  const ageDays = (Date.now() - Date.parse(meta.fullAt || 0)) / 86400000;
  if (!(ageDays < FULL_EVERY_DAYS)) return { mode: "full", reason: `last full pull ${Math.floor(ageDays)} days ago`, meta };
  return { mode: "incremental", reason: null, meta };
}

async function pullFunnel(token, write, full) {
  const { acrossTimeWriter } = require("./sheets");
  let { mode, reason, meta } = plan(full);
  const now = new Date().toISOString();

  // ---- incremental: BigQuery rows from the overlap start, then the local
  // rows older than that. Order in the file does not matter to pandas.
  if (mode === "incremental") {
    const fromRaw = isoMinusDays(meta.maxDate, OVERLAP_DAYS);
    const from = fromRaw < SINCE ? SINCE : fromRaw;
    const tmp = new Tmp(ACROSS_TIME, write);
    try {
      let maxDate = "";
      const bq = await streamTable(token, funnelSql(), from, acrossTimeWriter, tmp, {
        expectHeader: meta.header,
        onRow(_line, iso) { if (iso && iso > maxDate) maxDate = iso; },
      });
      let keptLocal = 0, localOverlap = 0;
      await scanLocal(ACROSS_TIME, (line, iso) => {
        if (iso && iso < from) { keptLocal++; tmp.line(line); } else localOverlap++;
      });
      // an empty or thin overlap pull is upstream failing, not history ending -
      // writing it would delete the last OVERLAP_DAYS of good data
      if (bq.rows < Math.max(50, localOverlap * 0.5)) {
        throw new Error(`incremental pull returned ${bq.rows} rows for the last ${OVERLAP_DAYS} days ` +
          `where the local file has ${localOverlap} - not overwriting`);
      }
      const total = bq.rows + keptLocal;
      const before = existingRows(ACROSS_TIME);
      if (write) {
        tmp.commit(ACROSS_TIME);
        writeMeta({ ...meta, maxDate: maxDate || meta.maxDate, rows: total, pulledAt: now, mode });
      } else tmp.discard();
      const fullAge = Math.floor((Date.now() - Date.parse(meta.fullAt)) / 86400000);
      return {
        rows: total, bytes: bq.bytes, cached: bq.cached, dropped: bq.dropped, mode,
        note: `funnel ${total} rows (${total - before >= 0 ? "+" : ""}${total - before} since last refresh; ` +
          `${bq.rows} re-pulled over the last ${OVERLAP_DAYS} days, last full pull ${fullAge}d ago)`,
      };
    } catch (e) {
      tmp.discard();
      if (!(e instanceof HeaderChanged)) throw e;
      mode = "full"; reason = e.message; meta = null;   // fall through to a full pull
    }
  }

  // ---- full: everything from SINCE. If the local file came from BigQuery,
  // fingerprint it first so the pull can say what changed outside the overlap.
  const local = meta ? new DayFingerprints() : null;
  if (local) await scanLocal(ACROSS_TIME, (line, iso) => { if (iso) local.add(iso, line); });
  const fresh = new DayFingerprints();
  let maxDate = "";
  const tmp = new Tmp(ACROSS_TIME, write);
  let bq;
  try {
    bq = await streamTable(token, funnelSql(), SINCE, acrossTimeWriter, tmp, {
      onRow(line, iso) { if (iso) { fresh.add(iso, line); if (iso > maxDate) maxDate = iso; } },
    });
    if (bq.rows < 100) throw new Error(`funnel query returned ${bq.rows} rows - not overwriting`);
    guardShrink("funnel query", bq.rows, ACROSS_TIME);
  } catch (e) { tmp.discard(); throw e; }

  let restated = "";
  if (local && maxDate) {
    const changed = local.changedBefore(fresh, isoMinusDays(maxDate, OVERLAP_DAYS));
    restated = changed.length
      ? `; ${changed.length} day${changed.length === 1 ? "" : "s"} older than the ${OVERLAP_DAYS}-day overlap ` +
        `changed upstream (oldest ${changed[0]})`
      : `; nothing older than the ${OVERLAP_DAYS}-day overlap changed`;
  }
  if (write) {
    tmp.commit(ACROSS_TIME);
    writeMeta({ since: SINCE, header: bq.header, maxDate, rows: bq.rows, fullAt: now, pulledAt: now, mode: "full" });
  } else tmp.discard();
  return {
    rows: bq.rows, bytes: bq.bytes, cached: bq.cached, dropped: bq.dropped, mode: "full",
    note: `funnel ${bq.rows} rows (full pull: ${reason}${restated})`,
  };
}

/* Pulls the funnel table (incrementally where it can) and the spend table
 * when the account can see it, and (unless write=false) replaces the CSVs
 * atomically. Spend is small and always pulled in full.
 *
 * The funnel table is required - it is the dashboard. Spend is optional on
 * purpose: a service account can easily be granted one dataset and not the
 * other, and losing paid spend is not a reason to also lose the funnel. When
 * spend is denied the previous data/spend_daily.csv keeps serving and the
 * summary says so, rather than the whole refresh failing with a 403.
 *
 * Resolves to { funnelRows, spendRows (null when not written), mode, summary }. */
async function pull({ write = true, full = false } = {}) {
  const sa = configured();
  if (!sa) return null;
  const token = await accessToken(sa, "bigquery");
  const { spendWriter } = require("./sheets");

  const funnel = await pullFunnel(token, write, full);

  let spend = null, spendNote;
  if (process.env.BQ_SPEND === "off") {
    spendNote = "spend skipped (BQ_SPEND=off)";
  } else {
    const tmp = new Tmp(SPEND_DAILY, write);
    try {
      spend = await streamTable(token, spendSql(), SINCE, spendWriter, tmp);
      guardShrink("spend query", spend.rows, SPEND_DAILY);
      if (write) tmp.commit(SPEND_DAILY); else tmp.discard();
      spendNote = `spend ${spend.rows} rows`;
    } catch (e) {
      tmp.discard();
      spend = null;
      // keep the note short - the full 403 is long and this goes in the header tooltip
      spendNote = `spend unavailable, keeping the last file (${String(e.message || e)
        .replace(/\s+/g, " ").slice(0, 120)})`;
    }
  }

  const bytes = funnel.bytes + (spend ? spend.bytes : 0);
  const gb = (bytes / 1e9).toFixed(2);
  const cached = funnel.cached && (!spend || spend.cached) ? ", cache hit" : "";
  const dropped = funnel.dropped ? `, ${funnel.dropped} undated rows dropped` : "";
  return {
    funnelRows: funnel.rows, spendRows: spend ? spend.rows : null, mode: funnel.mode,
    summary: `${funnel.note}${dropped}, ${spendNote}, since ${SINCE} ` +
      `(${gb} GB scanned${cached}, ${sa._env})`,
  };
}

module.exports = {
  pull, configured, query, plan, PROJECT, DATASET, SINCE, OVERLAP_DAYS, FULL_EVERY_DAYS,
  ACROSS_TIME, SPEND_DAILY, META,
  PiiDetected, contactKeySql, contactKeyParams, piiCheckHeader, piiCheckRows,
};

// ---- CLI: `node server/bigquery.js` checks the connection without writing;
// --write replaces the CSVs, --full forces a full pull. Handy from a Render shell.
if (require.main === module) {
  (async () => {
    if (!configured()) {
      console.error("BigQuery is not configured - set BIGQUERY_SERVICE_ACCOUNT_JSON " +
        "(and BQ_PROJECT/BQ_DATASET if they differ from the defaults).");
      process.exit(1);
    }
    const write = process.argv.includes("--write");
    const full = process.argv.includes("--full");
    const p = plan(full);
    console.log(`plan: ${p.mode}${p.reason ? ` (${p.reason})` : ""}`);
    const out = await pull({ write, full });
    console.log(out.summary);
    console.log(write ? `wrote ${ACROSS_TIME}${out.spendRows !== null ? ` and ${SPEND_DAILY}` : ""}`
      : "dry run - pass --write to replace the CSVs");
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
