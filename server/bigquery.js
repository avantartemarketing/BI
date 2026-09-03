/* Live data ingestion straight from BigQuery - the origin of every funnel and
 * spend number in the dashboard (docs/DATA_MODEL.md §2).
 *
 * This replaces the Google Sheet relay for the two files the ETL reads:
 *   le_funnel_report_split_touch_export -> sources/across_time.csv
 *   meta_ads_insights_export            -> data/spend_daily.csv
 * Same two files, same converters as the sheet path, so build.py is unchanged
 * and the two feeds are interchangeable.
 *
 * Why bother: the sheet tabs are query exports capped at 50,000 rows, cut mid
 * date. That cap does not error - it silently shortens the history window as
 * new launches push older days off the end, which is what limits the curve
 * panel to a handful of complete campaigns. Reading the table removes the cap.
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
const { serviceAccount, accessToken } = require("./googleAuth");

const ROOT = path.resolve(__dirname, "..");
const ACROSS_TIME = path.join(ROOT, "sources", "across_time.csv");
const SPEND_DAILY = path.join(ROOT, "data", "spend_daily.csv");

const PROJECT = process.env.BQ_PROJECT || "avantarte-data-production";
const DATASET = process.env.BQ_DATASET || "AA_company_tables";
const FUNNEL_TABLE = process.env.BQ_FUNNEL_TABLE || "le_funnel_report_split_touch_export";
const SPEND_TABLE = process.env.BQ_SPEND_TABLE || "meta_ads_insights_export";
const SINCE = process.env.BQ_SINCE || "2025-01-01";
const LOCATION = process.env.BQ_LOCATION || undefined; // e.g. "EU"; omit to let BQ infer

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

/* Runs one query and returns { header, rows, bytes, cached }.
 *
 * jobs.query returns the first page inline and the rest through
 * getQueryResults; a two-year pull of the funnel table is several hundred
 * thousand rows, so paging is not optional. Values arrive as strings (or null)
 * regardless of column type - the converters and pandas both cope. */
async function query(token, sql, params = {}, { pageRows = 20000 } = {}) {
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

  // a query that outran timeoutMs comes back incomplete - poll the job
  const results = `${base}/queries/${job.jobId}?` +
    (job.location ? `location=${encodeURIComponent(job.location)}&` : "");
  const get = async (qs) => {
    const res = await fetch(results + qs, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`BigQuery ${res.status}: ${(json.error && json.error.message) || "?"}`);
    return json;
  };
  let waited = 0;
  while (!body.jobComplete) {
    if (waited > 10 * 60_000) throw new Error("BigQuery job did not finish within 10 minutes");
    body = await get(`maxResults=${pageRows}&timeoutMs=60000`);
    waited += 60_000;
  }

  const header = (body.schema && body.schema.fields ? body.schema.fields : []).map((f) => f.name);
  const rows = [];
  const take = (b) => {
    for (const r of b.rows || []) rows.push((r.f || []).map((c) => (c.v === null ? "" : c.v)));
  };
  take(body);
  let pageToken = body.pageToken;
  while (pageToken) {
    const page = await get(`maxResults=${pageRows}&pageToken=${encodeURIComponent(pageToken)}`);
    take(page);
    pageToken = page.pageToken;
  }
  const total = Number(body.totalRows || rows.length);
  if (rows.length < total) {
    throw new Error(`BigQuery paging stopped early: ${rows.length} of ${total} rows`);
  }
  return { header, rows, bytes, cached };
}

const since = { type: "DATE", value: SINCE };

async function fetchFunnel(token) {
  const sql =
    `SELECT * FROM \`${PROJECT}.${DATASET}.${FUNNEL_TABLE}\`\n` +
    "WHERE event_date >= @since\nORDER BY event_date";
  return query(token, sql, { since });
}

async function fetchSpend(token) {
  const sql =
    `SELECT * FROM \`${PROJECT}.${DATASET}.${SPEND_TABLE}\`\n` +
    "WHERE spend_date >= @since\nORDER BY campaign_name, spend_date";
  return query(token, sql, { since });
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

/* Pulls the funnel table, and the spend table when the account can see it.
 *
 * The funnel table is required - it is the dashboard. Spend is optional on
 * purpose: a service account can easily be granted one dataset and not the
 * other, and losing paid spend is not a reason to also lose the funnel. When
 * spend is denied the previous data/spend_daily.csv keeps serving and the
 * summary says so, rather than the whole refresh failing with a 403.
 *
 * Writing is the caller's job (sheets.js writes atomically, then reruns the
 * ETL); spendDaily comes back null when there was nothing new to write. */
async function pull() {
  const sa = configured();
  if (!sa) return null;
  const token = await accessToken(sa, "bigquery");
  const { convertAcrossTime, convertSpend } = require("./sheets");

  const wantSpend = process.env.BQ_SPEND !== "off";
  const [funnel, spend] = await Promise.all([
    fetchFunnel(token),
    wantSpend ? fetchSpend(token).catch((e) => ({ error: e })) : Promise.resolve(null),
  ]);

  if (!funnel.header.includes("event_date") || !funnel.header.includes("simple_release_name")) {
    throw new Error(`${FUNNEL_TABLE} is missing event_date/simple_release_name - ` +
      `columns: ${funnel.header.slice(0, 6).join(", ")}…`);
  }
  const at = convertAcrossTime([funnel.header, ...funnel.rows]);
  if (at.rows < 100) throw new Error(`funnel query returned ${at.rows} rows - not overwriting`);
  guardShrink("funnel query", at.rows, ACROSS_TIME);

  let spendCsv = null;
  let spendNote;
  if (!wantSpend) {
    spendNote = "spend skipped (BQ_SPEND=off)";
  } else if (spend.error) {
    // keep the note short - the full 403 is long and this goes in the header tooltip
    spendNote = `spend unavailable, keeping the last file (${String(spend.error.message || spend.error)
      .replace(/\s+/g, " ").slice(0, 120)})`;
  } else {
    const sp = convertSpend([spend.header, ...spend.rows]);
    guardShrink("spend query", sp.rows, SPEND_DAILY);
    spendCsv = sp.csv;
    spendNote = `spend ${sp.rows} rows`;
  }

  const bytes = funnel.bytes + ((spend && !spend.error && spend.bytes) || 0);
  const gb = (bytes / 1e9).toFixed(2);
  const cached = funnel.cached && (!spend || spend.error || spend.cached) ? ", cache hit" : "";
  return {
    acrossTime: at.csv, spendDaily: spendCsv,
    summary: `funnel ${at.rows} rows, ${spendNote}, since ${SINCE} ` +
      `(${gb} GB scanned${cached}, ${sa._env})`,
  };
}

module.exports = { pull, configured, query, PROJECT, DATASET, SINCE, ACROSS_TIME, SPEND_DAILY };

// ---- CLI: `node server/bigquery.js` checks the connection without writing;
// add --write to actually replace the two CSVs. Handy from a Render shell.
if (require.main === module) {
  (async () => {
    if (!configured()) {
      console.error("BigQuery is not configured - set BIGQUERY_SERVICE_ACCOUNT_JSON " +
        "(and BQ_PROJECT/BQ_DATASET if they differ from the defaults).");
      process.exit(1);
    }
    const out = await pull();
    console.log(out.summary);
    if (process.argv.includes("--write")) {
      const { writeAtomic } = require("./sheets");
      writeAtomic(ACROSS_TIME, out.acrossTime);
      writeAtomic(SPEND_DAILY, out.spendDaily);
      console.log(`wrote ${ACROSS_TIME} and ${SPEND_DAILY}`);
    } else {
      console.log("dry run - pass --write to replace the CSVs");
    }
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
