/* Live data ingestion straight from BigQuery - the origin of every funnel and
 * spend number in the dashboard (docs/DATA_MODEL.md §2).
 *
 * This replaces the Google Sheet relay for the two files the ETL reads:
 *   le_funnel_report_split_touch_export -> sources/across_time.csv
 *   meta_ads_insights_export            -> data/spend_daily.csv
 * Same two files, same row converters as the sheet path (sheets.js), so
 * build.py is unchanged and the two feeds are interchangeable. A third,
 * BigQuery-only feed takes the conversion events of the event-level table:
 *   LE_Funnel_Report                    -> sources/le_events.csv
 * under the personal-data rule set out at the events section below.
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
// the event-level feed: pseudonymous person ids only, never the address (see
// the events section). Lives under sources/ (gitignored), served by no endpoint.
const LE_EVENTS = path.join(ROOT, "sources", "le_events.csv");
// orders and drafts by product, and the product each draw sold: aggregates
// only, written from Order_Line_Concept on every refresh (docs/DATA_MODEL.md 2.4)
const ORDERS_BY_PRODUCT = path.join(ROOT, "data", "orders_by_product.csv");
const DRAW_PRODUCTS = path.join(ROOT, "data", "draw_products.csv");
// what the local funnel file is: window, columns, last date, when it was last
// pulled in full. Absent = never pulled from BigQuery (or it came from the sheet)
const META = path.join(ROOT, "sources", "across_time.meta.json");

const PROJECT = process.env.BQ_PROJECT || "avantarte-data-production";
const DATASET = process.env.BQ_DATASET || "AA_company_tables";
const FUNNEL_TABLE = process.env.BQ_FUNNEL_TABLE || "le_funnel_report_split_touch_export";
const SPEND_TABLE = process.env.BQ_SPEND_TABLE || "meta_ads_insights_export";
// point this at the data team's email-free view when it exists: same columns, same guards
const EVENTS_TABLE = process.env.BQ_EVENTS_TABLE || "LE_Funnel_Report";
const ORDERS_TABLE = process.env.BQ_ORDERS_TABLE || "Order_Line_Concept";
// links a draw entrant's account to their Shopify customer id (two id columns, nothing else is selected)
const COLLECTORS_TABLE = process.env.BQ_COLLECTORS_TABLE || "Collector_Concept";
const EVENTS_SINCE = process.env.BQ_EVENTS_SINCE || "2019-01-01";   // all time: a returning collector's history is the point
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
  for (const [name, v] of [["BQ_DATASET", DATASET], ["BQ_FUNNEL_TABLE", FUNNEL_TABLE], ["BQ_SPEND_TABLE", SPEND_TABLE],
                           ["BQ_EVENTS_TABLE", EVENTS_TABLE], ["BQ_ORDERS_TABLE", ORDERS_TABLE], ["BQ_COLLECTORS_TABLE", COLLECTORS_TABLE]]) {
    if (!IDENT.test(v)) throw new Error(`${name} "${v}" must be letters, digits and underscores`);
  }
  if (!DATE_RE.test(SINCE)) throw new Error(`BQ_SINCE "${SINCE}" must be YYYY-MM-DD`);
  if (!DATE_RE.test(EVENTS_SINCE)) throw new Error(`BQ_EVENTS_SINCE "${EVENTS_SINCE}" must be YYYY-MM-DD`);
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

// ---------------------------------------------------------------- what the account can see (names only)

/* Every dataset, table and view the service account can list in the project,
 * with column names and types, from the REST metadata endpoints: no query
 * runs, no row is read, nothing is billed. Column names are matched against
 * the address pattern and FLAGGED, never selected, and a view's SQL is left
 * out (free text). The first place to look when the account is granted a
 * new table: `node server/bigquery.js --schema` prints it, GET
 * /api/bigquery/schema serves it. The product, order, draft and draw flags
 * are there to answer "does anything here carry the product of a sale". */
const PRODUCT_COLUMN = /product|sku|variant|artwork|edition|item_|_item|line_item|title/i;
const ORDER_COLUMN = /order|invoice|checkout|fulfil|refund|cancel|payment|paid/i;
const DRAFT_COLUMN = /draft/i;
const DRAW_COLUMN = /draw|entry|entrant|winner|allocat/i;
const MAX_TABLES = 600;

async function schema(token) {
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}`;
  const get = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`BigQuery ${res.status}: ${(json.error && json.error.message) || "?"}`);
    return json;
  };
  const list = async (url, key) => {
    const out = [];
    let pageToken = null;
    do {
      const page = await get(url + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""));
      out.push(...(page[key] || []));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    return out;
  };
  const datasets = await list(`${base}/datasets?all=true&maxResults=200`, "datasets");
  const out = { project: PROJECT, at: new Date().toISOString(), datasets: [], tables: 0, truncated: false };
  for (const d of datasets) {
    const id = d.datasetReference.datasetId;
    const ds = { id, tables: [] };
    out.datasets.push(ds);
    let tables;
    try { tables = await list(`${base}/datasets/${encodeURIComponent(id)}/tables?maxResults=500`, "tables"); }
    catch (e) { ds.error = String(e.message || e).replace(/\s+/g, " ").slice(0, 160); continue; }
    for (const t of tables) {
      if (out.tables >= MAX_TABLES) { out.truncated = true; break; }
      out.tables += 1;
      const tid = t.tableReference.tableId;
      let meta;
      try { meta = await get(`${base}/datasets/${encodeURIComponent(id)}/tables/${encodeURIComponent(tid)}`); }
      catch (e) { ds.tables.push({ id: tid, type: t.type, error: String(e.message || e).replace(/\s+/g, " ").slice(0, 160) }); continue; }
      const columns = ((meta.schema && meta.schema.fields) || []).map((f) => ({ name: f.name, type: f.type + (f.mode === "REPEATED" ? "[]" : "") }));
      const names = columns.map((c) => c.name);
      ds.tables.push({
        id: tid, type: meta.type || t.type,
        rows: meta.numRows !== undefined ? Number(meta.numRows) : null,
        modified: meta.lastModifiedTime ? new Date(Number(meta.lastModifiedTime)).toISOString().slice(0, 10) : null,
        columns,
        address: names.filter((n) => PII_COLUMN.test(n)),
        product: names.filter((n) => PRODUCT_COLUMN.test(n)),
        order: names.filter((n) => ORDER_COLUMN.test(n)),
        draft: names.filter((n) => DRAFT_COLUMN.test(n)),
        draw: names.filter((n) => DRAW_COLUMN.test(n)),
      });
    }
  }
  return out;
}

async function listSchema() {
  const sa = configured();
  if (!sa) return null;
  const token = await accessToken(sa, "bigquery");
  return schema(token);
}

/* The listing as text, for the terminal and for pasting into a chat: one
 * line per table with its column names, then the tables worth a look. */
function schemaText(doc) {
  const lines = [`${doc.project} - what the service account can see (${doc.at.slice(0, 16)}, ${doc.tables} tables${doc.truncated ? ", truncated" : ""})`];
  const fmtRows = (n) => (n === null || n === undefined ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M rows` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k rows` : `${n} rows`);
  for (const ds of doc.datasets) {
    lines.push("", `${ds.id}${ds.error ? `  (${ds.error})` : ""}`);
    for (const t of ds.tables) {
      if (t.error) { lines.push(`  ${t.id}  (${t.error})`); continue; }
      const tags = [t.type, fmtRows(t.rows), t.modified].filter(Boolean).join(", ");
      lines.push(`  ${t.id}  [${tags}]`);
      lines.push(`    ${t.columns.map((c) => c.name).join(", ")}`);
      const flags = [];
      if (t.address.length) flags.push(`address column, never select: ${t.address.join(", ")}`);
      if (t.product.length) flags.push(`product: ${t.product.join(", ")}`);
      if (t.draft.length) flags.push(`draft: ${t.draft.join(", ")}`);
      if (flags.length) lines.push(`    ! ${flags.join(" | ")}`);
    }
  }
  const worth = [];
  for (const ds of doc.datasets) for (const t of ds.tables) {
    if (t.error) continue;
    if (t.product.length && (t.order.length || t.draw.length)) worth.push(`${ds.id}.${t.id} (product + ${t.order.length ? "order" : "draw"} columns)`);
    else if (t.draft.length) worth.push(`${ds.id}.${t.id} (draft columns)`);
  }
  lines.push("", worth.length ? `Worth a look for sales and drafts by product:\n  ${worth.join("\n  ")}` : "No table carries both a product column and an order or draw column.");
  return lines.join("\n") + "\n";
}

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

// ---------------------------------------------------------------- orders and drafts by product

/* Order_Line_Concept is one row per Shopify order line and carries the
 * customer's email on every row. Nothing here reads it: both queries return
 * aggregates per release and product, and the join that names the product a
 * draw sold runs inside BigQuery on the pseudonymous account id, so the rows
 * that travel are release, product, draw and counts (docs/DATA_MODEL.md 2.4).
 *   orders_by_product.csv  per release x Shopify product title: units paid
 *                          (orders, not cancelled, not refunded), refunded,
 *                          awaiting payment (draft orders an advisor raised
 *                          that have no order yet - the PREORDER route is the
 *                          advisor's pre-sale during a campaign - and orders
 *                          still pending), the collectors those are out to
 *                          who have not paid for anything on the release (an
 *                          advisor offers several colours to one collector;
 *                          the card counts the collector), the drafts sent
 *                          to winners who have not paid (already on the card
 *                          as unpaid wins), the draw's own
 *                          pre-authorisation drafts (one per live entry: the
 *                          DRAW SKU, or any draft the app's own facilitator
 *                          account wrote - counted apart, because the card
 *                          already counts those as entries), from drafts,
 *                          private room, the list price, first and last
 *                          order day, last draft day
 *   draw_products.csv      per draw: the product its winners bought most, and
 *                          the share of their orders it took
 * Both take @since (BQ_SINCE): a release launched, ordered or drafted since
 * that day is in; the draw map reads events from that day. */
const ORDERS_HEADER = ["release", "campaign_code", "product_title", "product_ids", "skus", "units_paid", "units_refunded",
  "units_draft_pending", "draft_customers", "units_winner_drafts", "units_entry_drafts", "units_from_drafts", "units_private_room", "list_price_eur", "first_order", "last_order", "last_draft"];
const DRAW_PRODUCTS_HEADER = ["release", "draw_id", "product_title", "orders", "share"];

const ordersSql = () =>
  "WITH lines AS (\n" +
  "  SELECT simple_release_name AS release, release_name, product_title, shopify_product_id, sku, quantity, customer_id, order_lineitem_id,\n" +
  "    order_source_type, cancelled_order, order_financial_status, order_originated_from_drafts, is_private_room,\n" +
  "    shopify_product_variant_price, shopify_order_created_date_CET AS order_date, DATE(shopify_draft_order_created_at) AS draft_date,\n" +
  "    COALESCE(shopify_order_facilitator, '') AS facilitator,\n" +
  "    REGEXP_CONTAINS(UPPER(COALESCE(sku, '')), r'-DRAW$') AS draw_sku,\n" +
  "    order_source_type = 'Order' AND cancelled_order = 0 AND COALESCE(order_financial_status, '') NOT IN ('refunded', 'pending') AS paid\n" +
  `  FROM \`${PROJECT}.${DATASET}.${ORDERS_TABLE}\`\n` +
  "  WHERE is_test_order = 0 AND shopify_product_type = 'Product'\n" +
  "    AND simple_release_name IS NOT NULL AND simple_release_name != '' AND product_title IS NOT NULL AND product_title != ''\n" +
  "    AND (DATE(launch_date) >= @since OR shopify_order_created_date_CET >= @since OR DATE(shopify_draft_order_created_at) >= @since)),\n" +
  // the app that pre-authorises a draw entry writes its drafts under one
  // facilitator account: any account whose drafts are nearly all on the DRAW
  // SKU is the app, and every draft it writes (some land on the base SKU) is
  // an entry, not an advisor's draft
  "app_facilitators AS (\n" +
  "  SELECT facilitator FROM lines WHERE order_source_type = 'Draft' AND facilitator != ''\n" +
  "  GROUP BY facilitator HAVING COUNT(*) >= 100 AND COUNTIF(draw_sku) >= 0.9 * COUNT(*)),\n" +
  // a winner who has not bought is already on the card as a pinned unpaid
  // win, and the draft an advisor sends them to pay is the same unit: joined
  // here through the collector table's two id columns, counted apart
  "unpaid_winners AS (\n" +
  "  SELECT e.simple_release_name AS release, c.shopify_customer_id AS customer_id\n" +
  "  FROM (SELECT simple_release_name, aa_account_id, draw_id, MAX(IF(draw_with_purchase = 1, 1, 0)) AS bought\n" +
  `        FROM \`${PROJECT}.${DATASET}.${EVENTS_TABLE}\`\n` +
  "        WHERE event_name = 'draw entry intent' AND winner AND aa_account_id IS NOT NULL AND event_date >= @since\n" +
  "        GROUP BY 1, 2, 3) e\n" +
  `  JOIN \`${PROJECT}.${DATASET}.${COLLECTORS_TABLE}\` c ON c.aa_account_id = e.aa_account_id AND c.shopify_customer_id IS NOT NULL\n` +
  "  WHERE e.bought = 0\n" +
  "  GROUP BY 1, 2),\n" +
  "typed AS (\n" +
  "  SELECT l.*,\n" +
  "    l.order_source_type = 'Draft' AND l.cancelled_order = 0 AND (l.draw_sku OR a.facilitator IS NOT NULL) AS entry_draft,\n" +
  "    l.order_source_type = 'Draft' AND l.cancelled_order = 0 AND NOT (l.draw_sku OR a.facilitator IS NOT NULL) AND w.customer_id IS NOT NULL AS winner_draft,\n" +
  "    l.cancelled_order = 0 AND ((l.order_source_type = 'Draft' AND NOT (l.draw_sku OR a.facilitator IS NOT NULL) AND w.customer_id IS NULL)\n" +
  "      OR (l.order_source_type = 'Order' AND l.order_financial_status = 'pending')) AS awaiting\n" +
  "  FROM lines l LEFT JOIN app_facilitators a ON a.facilitator = l.facilitator\n" +
  "  LEFT JOIN unpaid_winners w ON w.release = l.release AND w.customer_id = l.customer_id),\n" +
  "paid_customers AS (SELECT DISTINCT release, customer_id FROM typed WHERE paid AND customer_id IS NOT NULL)\n" +
  "SELECT l.release, ANY_VALUE(l.release_name) AS campaign_code, l.product_title,\n" +
  "  STRING_AGG(DISTINCT CAST(l.shopify_product_id AS STRING), '|') AS product_ids,\n" +
  "  STRING_AGG(DISTINCT l.sku, '|') AS skus,\n" +
  "  SUM(IF(l.paid, l.quantity, 0)) AS units_paid,\n" +
  "  SUM(IF(l.order_source_type = 'Order' AND l.cancelled_order = 0 AND l.order_financial_status = 'refunded', l.quantity, 0)) AS units_refunded,\n" +
  "  SUM(IF(l.awaiting, l.quantity, 0)) AS units_draft_pending,\n" +
  "  COUNT(DISTINCT IF(l.awaiting AND p.customer_id IS NULL, COALESCE(CAST(l.customer_id AS STRING), CONCAT('line', CAST(l.order_lineitem_id AS STRING))), NULL)) AS draft_customers,\n" +
  "  SUM(IF(l.winner_draft, l.quantity, 0)) AS units_winner_drafts,\n" +
  "  SUM(IF(l.entry_draft, l.quantity, 0)) AS units_entry_drafts,\n" +
  "  SUM(IF(l.order_source_type = 'Order' AND l.cancelled_order = 0 AND l.order_originated_from_drafts = 1, l.quantity, 0)) AS units_from_drafts,\n" +
  "  SUM(IF(l.order_source_type = 'Order' AND l.cancelled_order = 0 AND l.is_private_room = 1, l.quantity, 0)) AS units_private_room,\n" +
  "  APPROX_QUANTILES(IF(l.shopify_product_variant_price > 0, CAST(l.shopify_product_variant_price AS FLOAT64), NULL), 2)[OFFSET(1)] AS list_price_eur,\n" +
  "  MIN(IF(l.order_source_type = 'Order', l.order_date, NULL)) AS first_order,\n" +
  "  MAX(IF(l.order_source_type = 'Order', l.order_date, NULL)) AS last_order,\n" +
  "  MAX(l.draft_date) AS last_draft\n" +
  "FROM typed l LEFT JOIN paid_customers p ON p.release = l.release AND p.customer_id = l.customer_id\n" +
  "GROUP BY l.release, l.product_title\nORDER BY l.release, l.product_title";

const drawProductsSql = () =>
  "WITH wins AS (\n" +
  "  SELECT DISTINCT simple_release_name AS release, aa_account_id, draw_id\n" +
  `  FROM \`${PROJECT}.${DATASET}.${EVENTS_TABLE}\`\n` +
  "  WHERE event_name = 'draw entry intent' AND winner AND draw_id IS NOT NULL AND aa_account_id IS NOT NULL AND event_date >= @since),\n" +
  "buys AS (\n" +
  "  SELECT DISTINCT simple_release_name AS release, aa_account_id, shopify_order_id\n" +
  `  FROM \`${PROJECT}.${DATASET}.${EVENTS_TABLE}\`\n` +
  "  WHERE event_name = 'purchase' AND shopify_order_id IS NOT NULL AND aa_account_id IS NOT NULL AND event_date >= @since),\n" +
  "pairs AS (\n" +
  "  SELECT w.release, w.draw_id, o.product_title, COUNT(DISTINCT o.shopify_order_id) AS orders\n" +
  "  FROM wins w\n" +
  "  JOIN buys b ON b.release = w.release AND b.aa_account_id = w.aa_account_id\n" +
  `  JOIN \`${PROJECT}.${DATASET}.${ORDERS_TABLE}\` o ON o.shopify_order_id = b.shopify_order_id AND o.simple_release_name = w.release\n` +
  "    AND o.shopify_product_type = 'Product' AND o.is_test_order = 0 AND o.product_title IS NOT NULL AND o.product_title != ''\n" +
  "  GROUP BY 1, 2, 3)\n" +
  "SELECT release, draw_id, product_title, orders,\n" +
  "  ROUND(orders / SUM(orders) OVER (PARTITION BY release, draw_id), 3) AS share\n" +
  "FROM pairs\n" +
  "QUALIFY ROW_NUMBER() OVER (PARTITION BY release, draw_id ORDER BY orders DESC, product_title) = 1\n" +
  "ORDER BY release, draw_id";

/* A writer that keeps the columns as they come, once they are the expected
 * ones: these files are read by name in etl/build.py, so a column added or
 * renamed upstream is a failed pull, not a silently different file. */
function passthroughWriter(expect, label) {
  return (headerRow) => {
    const header = headerRow.map((h) => String(h ?? "").trim());
    if (header.length !== expect.length || header.some((h, i) => h !== expect[i])) {
      throw new Error(`${label} columns are not the expected ${expect.length}: ${header.join(", ")}`);
    }
    return { header: header.map(csvCell).join(","), dateIndex: -1, dropped: 0, row: (cells) => cells.map(csvCell).join(",") };
  };
}

// ---------------------------------------------------------------- events feed (personal-data rule)

/* LE_Funnel_Report is event level - page views, session starts, signups, draw
 * entries, purchases, one row per event since 2019 - and carries the customer's
 * email address on signed-in rows (1.9M of 8.1M rows, 109k distinct addresses
 * when this was written). The dashboard never needs the address: aa_account_id
 * identifies the person on 99.9% of the rows that carry one. So the rule is
 * that the address never leaves BigQuery, and this code makes it hard to get
 * wrong rather than easy to get right:
 *   - the query names every column it takes. SELECT * is refused, and so is any
 *     query text that mentions the email column at all - which also makes the
 *     data team's email-free view a drop-in (BQ_EVENTS_TABLE);
 *   - the header BigQuery returns must equal the declared list exactly;
 *   - every cell of every page is scanned for an address-shaped value before
 *     it is written. One hit aborts the pull, discards the partial file and
 *     names the column, never the value. processing_error was found to quote
 *     addresses inside error text, so it is reduced to a boolean in SQL.
 * Only the conversion events are taken - signup, draw entry intent, purchase,
 * about 200k rows all time. Page views and session starts are the daily
 * funnel export's job, and at person level they would be 8M rows of browsing
 * history for no number the dashboard shows. Identifiers kept: the account id
 * (the person key), draw and draw-entry ids, the Meta campaign id. Dropped on
 * purpose: user_email, user_pseudo_id, ga_session_id, customer_id, Shopify
 * order id and name, subscription id, page URLs and titles, utm strings.
 * The account id is still personal data under GDPR: the file stays under
 * sources/ (gitignored), is served by no endpoint, and is rebuilt from
 * BigQuery on every pull, so an erasure upstream propagates. */
const EVENT_ROW_FILTER = "event_name IN ('signup', 'draw entry intent', 'purchase')";
const EVENT_COLUMNS = [
  "event_timestamp", "event_date", "event_name", "aa_account_id",
  "simple_release_name", "release_name", "launch_type", "launch_date", "announcement_date",
  "campaign_stage", "days_since_announcement", "days_until_launch",
  "pct_days_since_announcement", "pct_days_until_launch",
  "aa_subscription_type", "pre_post_launch_signup", "converted_signup", "converted_signup_draw",
  "pre_post_launch_purchase", "order_type", "pr_order", "cancelled_order", "order_products", "order_pieces",
  "purchase_with_signup", "purchase_with_draw_entry", "purchase_with_preorder_app", "purchase_with_presale",
  "draw_id", "draw_entry_id", "draw_entry_eligible",
  "draw_entry_multiset_preference_max_quantity", "draw_entry_multiset_preference_max_quantity_once",
  "exclusion_reason", "removal_reason", "winner", "pre_order", "draw_with_signup", "draw_with_purchase",
  "session_default_channel_group", "AA_session_custom_channel_group", "campaign_id",
  "session_default_channel_group_split_touch", "AA_session_custom_channel_group_split_touch",
  "page_view_page_locale", "purchase_page_locale", "draw_entry_page_locale",
];
// derived in SQL so the source text never leaves BigQuery
const EVENT_DERIVED = { has_processing_error: "processing_error IS NOT NULL AND processing_error != ''" };
const EVENT_HEADER = EVENT_COLUMNS.concat(Object.keys(EVENT_DERIVED));
const FORBIDDEN_COLUMNS = ["user_email"];
const EVENT_TIMESTAMP_COLUMNS = new Set(["event_timestamp", "launch_date"]);
// address-shaped: local part, @, domain with a dot. Loose on purpose - a false
// positive costs a pull, a false negative costs an address.
const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

for (const c of EVENT_HEADER) {
  if (!IDENT.test(c)) throw new Error(`events column "${c}" is not a plain identifier`);
  if (FORBIDDEN_COLUMNS.includes(c)) throw new Error(`events column list must not include ${c}`);
}

function eventsSql() {
  const cols = EVENT_COLUMNS.map((c) => `\`${c}\``)
    .concat(Object.entries(EVENT_DERIVED).map(([k, expr]) => `(${expr}) AS \`${k}\``));
  const sql = `SELECT ${cols.join(", ")}\nFROM \`${PROJECT}.${DATASET}.${EVENTS_TABLE}\`\n` +
    `WHERE ${EVENT_ROW_FILTER} AND event_date >= @since\nORDER BY event_date, event_timestamp`;
  for (const f of FORBIDDEN_COLUMNS) {
    if (sql.toLowerCase().includes(f)) throw new Error(`events query must not mention ${f}`);
  }
  if (/select\s+\*|\.\*/i.test(sql)) throw new Error("events query must name every column it takes");
  return sql;
}

// TIMESTAMP arrives as epoch seconds ("1.789047878E9"); anything else passes through as is
const toIso = (v) => { const n = Number(v); return v !== "" && Number.isFinite(n) ? new Date(n * 1000).toISOString() : v; };

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* Row converter for the events feed. The header must be the declared list;
 * each cell is checked for an address-shaped value; timestamps (epoch seconds
 * from the API) become ISO. Throws rather than writes on anything unexpected. */
function eventsWriter(headerRow) {
  const header = headerRow.map((h) => String(h ?? "").trim());
  if (header.length !== EVENT_HEADER.length || header.some((h, i) => h !== EVENT_HEADER[i])) {
    throw new Error("events feed returned columns that differ from the declared list " +
      `(${header.length} vs ${EVENT_HEADER.length}) - not writing`);
  }
  const di = header.indexOf("event_date");
  const isTs = header.map((h) => EVENT_TIMESTAMP_COLUMNS.has(h));
  const w = {
    header: header.map(csvCell).join(","),
    dateIndex: di,
    dropped: 0,
    row(cells) {
      if (!cells || !cells.length) return null;
      const out = new Array(header.length);
      for (let i = 0; i < header.length; i++) {
        const v = cells[i] === null || cells[i] === undefined ? "" : String(cells[i]);
        if (v.length > 5 && ADDRESS_RE.test(v)) {
          // the message names the column and the day, never the value
          throw new Error(`events pull aborted: column ${header[i]} carries an address-shaped value ` +
            `(row dated ${cells[di]}) - nothing written, previous file kept`);
        }
        out[i] = isTs[i] ? csvCell(toIso(v)) : csvCell(v);
      }
      return out.join(",");
    },
  };
  return w;
}

// ---------------------------------------------------------------- browsing feed (counts only)

/* Sessions and page views per channel x day x release, counted inside
 * BigQuery. These are the two export columns that have no definition in them
 * (a session is a session_start event, a page view a page_view event - proven
 * to the event, docs/DATA_MODEL.md #2.2), and the only ones whose rows would
 * be too many to bring here: 7.4M since 2023 for two numbers per channel-day.
 * No identifier is read, so nothing personal is involved. The result has the
 * daily export's grain and lets etl/aggregate_events.py rebuild the export. */
const LE_BROWSING = path.join(ROOT, "sources", "le_browsing.csv");
const BROWSING_META = path.join(ROOT, "sources", "le_browsing.meta.json");
const BROWSING_KEYS = ["AA_session_custom_channel_group_split_touch", "event_date", "simple_release_name",
                       "campaign_stage", "days_since_announcement", "days_until_launch",
                       "pct_days_since_announcement", "pct_days_until_launch"];
const BROWSING_HEADER = BROWSING_KEYS.concat(["Sessions_Total", "Page_Views_Total"]);

function browsingSql() {
  const keys = BROWSING_KEYS.map((c) => `\`${c}\``).join(", ");
  const sql = `SELECT ${keys},\n  COUNTIF(event_name = 'session_start') AS Sessions_Total,\n` +
    `  COUNTIF(event_name = 'page_view') AS Page_Views_Total\n` +
    `FROM \`${PROJECT}.${DATASET}.${EVENTS_TABLE}\`\n` +
    `WHERE event_name IN ('page_view', 'session_start') AND event_date >= @since\n` +
    `GROUP BY ${BROWSING_KEYS.map((_, i) => i + 1).join(", ")}\nORDER BY event_date`;
  for (const f of FORBIDDEN_COLUMNS) {
    if (sql.toLowerCase().includes(f)) throw new Error(`browsing query must not mention ${f}`);
  }
  return sql;
}

const fmtDMY = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };

/* Same shape of guard as the events writer: declared header, address scan,
 * and the date written DD/MM/YYYY like the export so the ETL's parser and the
 * incremental merge (scanLocal) treat the two files alike. */
function browsingWriter(headerRow) {
  const header = headerRow.map((h) => String(h ?? "").trim());
  if (header.length !== BROWSING_HEADER.length || header.some((h, i) => h !== BROWSING_HEADER[i])) {
    throw new Error("browsing feed returned columns that differ from the declared list " +
      `(${header.length} vs ${BROWSING_HEADER.length}) - not writing`);
  }
  const di = header.indexOf("event_date");
  const w = {
    header: header.map(csvCell).join(","),
    dateIndex: di,
    dropped: 0,
    row(cells) {
      if (!cells || !cells.length) return null;
      const out = new Array(header.length);
      for (let i = 0; i < header.length; i++) {
        const v = cells[i] === null || cells[i] === undefined ? "" : String(cells[i]);
        if (v.length > 5 && ADDRESS_RE.test(v)) {
          throw new Error(`browsing pull aborted: column ${header[i]} carries an address-shaped value ` +
            `(row dated ${cells[di]}) - nothing written, previous file kept`);
        }
        out[i] = csvCell(i === di ? fmtDMY(v) : v);
      }
      return out.join(",");
    },
  };
  return w;
}

const BROWSING_FEED = { label: "browsing", file: LE_BROWSING, meta: BROWSING_META, sql: browsingSql, makeWriter: browsingWriter };

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

function readMeta(file = META) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeMeta(m, file = META) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(m, null, 1));
  fs.renameSync(file + ".tmp", file);
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

/* A feed pulled incrementally: { label, file, meta, sql, makeWriter }. The funnel
 * export and the browsing counts are the two instances; both are keyed by
 * event_date, written DD/MM/YYYY, and merged on the same overlap rules. */
const FUNNEL_FEED = {
  label: "funnel", file: ACROSS_TIME, meta: META, sql: funnelSql,
  makeWriter: (h) => require("./sheets").acrossTimeWriter(h),
};

/* Decides full vs incremental for a feed. Returns { mode, reason, meta }. */
function plan(full, feed = FUNNEL_FEED) {
  const meta = readMeta(feed.meta);
  const usable = meta && meta.since === SINCE && meta.maxDate && Array.isArray(meta.header) && fs.existsSync(feed.file);
  if (full) return { mode: "full", reason: "requested", meta };
  if (!meta) return { mode: "full", reason: "no record of a previous pull", meta: null };
  if (!fs.existsSync(feed.file)) return { mode: "full", reason: "local file missing", meta: null };
  if (meta.since !== SINCE) return { mode: "full", reason: `BQ_SINCE changed (${meta.since} -> ${SINCE})`, meta: null };
  if (!usable) return { mode: "full", reason: "previous pull record unreadable", meta: null };
  const ageDays = (Date.now() - Date.parse(meta.fullAt || 0)) / 86400000;
  if (!(ageDays < FULL_EVERY_DAYS)) return { mode: "full", reason: `last full pull ${Math.floor(ageDays)} days ago`, meta };
  return { mode: "incremental", reason: null, meta };
}

async function pullIncremental(token, write, full, feed) {
  let { mode, reason, meta } = plan(full, feed);
  const now = new Date().toISOString();

  // ---- incremental: BigQuery rows from the overlap start, then the local
  // rows older than that. Order in the file does not matter to pandas.
  if (mode === "incremental") {
    const fromRaw = isoMinusDays(meta.maxDate, OVERLAP_DAYS);
    const from = fromRaw < SINCE ? SINCE : fromRaw;
    const tmp = new Tmp(feed.file, write);
    try {
      let maxDate = "";
      const bq = await streamTable(token, feed.sql(), from, feed.makeWriter, tmp, {
        expectHeader: meta.header,
        onRow(_line, iso) { if (iso && iso > maxDate) maxDate = iso; },
      });
      let keptLocal = 0, localOverlap = 0;
      await scanLocal(feed.file, (line, iso) => {
        if (iso && iso < from) { keptLocal++; tmp.line(line); } else localOverlap++;
      });
      // an empty or thin overlap pull is upstream failing, not history ending -
      // writing it would delete the last OVERLAP_DAYS of good data
      if (bq.rows < Math.max(50, localOverlap * 0.5)) {
        throw new Error(`incremental ${feed.label} pull returned ${bq.rows} rows for the last ${OVERLAP_DAYS} days ` +
          `where the local file has ${localOverlap} - not overwriting`);
      }
      const total = bq.rows + keptLocal;
      const before = existingRows(feed.file);
      if (write) {
        tmp.commit(feed.file);
        writeMeta({ ...meta, maxDate: maxDate || meta.maxDate, rows: total, pulledAt: now, mode }, feed.meta);
      } else tmp.discard();
      const fullAge = Math.floor((Date.now() - Date.parse(meta.fullAt)) / 86400000);
      return {
        rows: total, bytes: bq.bytes, cached: bq.cached, dropped: bq.dropped, mode,
        note: `${feed.label} ${total} rows (${total - before >= 0 ? "+" : ""}${total - before} since last refresh; ` +
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
  if (local) await scanLocal(feed.file, (line, iso) => { if (iso) local.add(iso, line); });
  const fresh = new DayFingerprints();
  let maxDate = "";
  const tmp = new Tmp(feed.file, write);
  let bq;
  try {
    bq = await streamTable(token, feed.sql(), SINCE, feed.makeWriter, tmp, {
      onRow(line, iso) { if (iso) { fresh.add(iso, line); if (iso > maxDate) maxDate = iso; } },
    });
    if (bq.rows < 100) throw new Error(`${feed.label} query returned ${bq.rows} rows - not overwriting`);
    guardShrink(`${feed.label} query`, bq.rows, feed.file);
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
    tmp.commit(feed.file);
    writeMeta({ since: SINCE, header: bq.header, maxDate, rows: bq.rows, fullAt: now, pulledAt: now, mode: "full" }, feed.meta);
  } else tmp.discard();
  return {
    rows: bq.rows, bytes: bq.bytes, cached: bq.cached, dropped: bq.dropped, mode: "full",
    note: `${feed.label} ${bq.rows} rows (full pull: ${reason}${restated})`,
  };
}

const pullFunnel = (token, write, full) => pullIncremental(token, write, full, FUNNEL_FEED);

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
async function pull({ write = true, full = false, events = true, only = null } = {}) {
  const sa = configured();
  if (!sa) return null;
  const token = await accessToken(sa, "bigquery");
  const { spendWriter } = require("./sheets");
  if (events === "only") only = "events";   // the CLI's --events / --browsing: one feed alone
  const skip = (name) => only !== null && only !== name;

  const funnel = skip("funnel") ? null : await pullFunnel(token, write, full);

  let spend = null, spendNote;
  if (skip("spend")) {
    spendNote = `spend not pulled (--${only})`;
  } else if (process.env.BQ_SPEND === "off") {
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

  // orders and drafts by product, and the product each draw sold: two
  // aggregate queries into two small files, optional like spend
  let orders = null, ordersNote;
  if (skip("orders")) {
    ordersNote = `orders not pulled (--${only})`;
  } else if (process.env.BQ_ORDERS === "off") {
    ordersNote = "orders skipped (BQ_ORDERS=off)";
  } else {
    const t1 = new Tmp(ORDERS_BY_PRODUCT, write), t2 = new Tmp(DRAW_PRODUCTS, write);
    try {
      const a = await streamTable(token, ordersSql(), SINCE, passthroughWriter(ORDERS_HEADER, "orders"), t1);
      if (a.rows < 10) throw new Error(`orders query returned ${a.rows} rows - not overwriting`);
      guardShrink("orders query", a.rows, ORDERS_BY_PRODUCT);
      const b = await streamTable(token, drawProductsSql(), SINCE, passthroughWriter(DRAW_PRODUCTS_HEADER, "draw products"), t2);
      if (write) { t1.commit(ORDERS_BY_PRODUCT); t2.commit(DRAW_PRODUCTS); } else { t1.discard(); t2.discard(); }
      orders = { rows: a.rows, draws: b.rows, bytes: a.bytes + b.bytes, cached: a.cached && b.cached };
      ordersNote = `orders ${a.rows} products, ${b.rows} draws named`;
    } catch (e) {
      t1.discard(); t2.discard();
      ordersNote = `orders unavailable, keeping the last files (${String(e.message || e).replace(/\s+/g, " ").slice(0, 160)})`;
    }
  }

  // the event-level feed: optional like spend, and a failure of its guards is
  // reported, never worked around - the previous (clean) file keeps serving
  let ev = null, eventsNote;
  if (skip("events")) {
    eventsNote = `events not pulled (--${only})`;
  } else if (events === false || process.env.BQ_EVENTS === "off") {
    eventsNote = "events skipped (BQ_EVENTS=off)";
  } else {
    const tmp = new Tmp(LE_EVENTS, write);
    try {
      ev = await streamTable(token, eventsSql(), EVENTS_SINCE, eventsWriter, tmp);
      if (ev.rows < 100) throw new Error(`events query returned ${ev.rows} rows - not overwriting`);
      guardShrink("events query", ev.rows, LE_EVENTS);
      if (write) tmp.commit(LE_EVENTS); else tmp.discard();
      eventsNote = `events ${ev.rows} rows (conversion events since ${EVENTS_SINCE}, ${EVENT_HEADER.length} columns, no address column)`;
    } catch (e) {
      tmp.discard();
      ev = null;
      eventsNote = `events unavailable, keeping the last file (${String(e.message || e).replace(/\s+/g, " ").slice(0, 160)})`;
    }
  }

  // the browsing counts: incremental like the funnel, optional like spend
  let br = null, browsingNote;
  if (skip("browsing")) {
    browsingNote = `browsing not pulled (--${only})`;
  } else if (process.env.BQ_BROWSING === "off" || process.env.BQ_EVENTS === "off") {
    browsingNote = "browsing skipped (BQ_BROWSING=off)";
  } else {
    try {
      br = await pullIncremental(token, write, full, BROWSING_FEED);
      browsingNote = br.note;
    } catch (e) {
      browsingNote = `browsing unavailable, keeping the last file (${String(e.message || e).replace(/\s+/g, " ").slice(0, 160)})`;
    }
  }

  const parts = [funnel, spend, orders, ev, br].filter(Boolean);
  const bytes = parts.reduce((n, x) => n + x.bytes, 0);
  const gb = (bytes / 1e9).toFixed(2);
  const cached = parts.every((x) => x.cached) ? ", cache hit" : "";
  const dropped = funnel && funnel.dropped ? `, ${funnel.dropped} undated rows dropped` : "";
  const funnelNote = funnel ? `${funnel.note}${dropped}, ` : "";
  return {
    funnelRows: funnel ? funnel.rows : null, spendRows: spend ? spend.rows : null,
    ordersRows: orders ? orders.rows : null,
    eventsRows: ev ? ev.rows : null, browsingRows: br ? br.rows : null, mode: funnel ? funnel.mode : (only || "events"),
    summary: `${funnelNote}${spendNote}, ${ordersNote}, ${eventsNote}, ${browsingNote}, since ${SINCE} ` +
      `(${gb} GB scanned${cached}, ${sa._env})`,
  };
}

module.exports = {
  pull, configured, query, plan, PROJECT, DATASET, SINCE, OVERLAP_DAYS, FULL_EVERY_DAYS,
  ACROSS_TIME, SPEND_DAILY, META, ORDERS_BY_PRODUCT, DRAW_PRODUCTS, ORDERS_HEADER, DRAW_PRODUCTS_HEADER, ordersSql, drawProductsSql,
  LE_EVENTS, EVENTS_TABLE, EVENTS_SINCE, EVENT_COLUMNS, EVENT_HEADER, FORBIDDEN_COLUMNS, eventsSql, eventsWriter,
  LE_BROWSING, BROWSING_HEADER, browsingSql, browsingWriter, pullIncremental, FUNNEL_FEED, BROWSING_FEED,
  PiiDetected, contactKeySql, contactKeyParams, piiCheckHeader, piiCheckRows,
  schema, listSchema, schemaText,
};

// ---- CLI: `node server/bigquery.js` checks the connection without writing;
// --write replaces the CSVs, --full forces a full pull, --events or --browsing
// pulls that one feed alone (--orders the orders-by-product pair), --schema
// lists what the account can see (names only, no rows). Handy from a Render shell.
if (require.main === module) {
  (async () => {
    if (!configured()) {
      console.error("BigQuery is not configured - set BIGQUERY_SERVICE_ACCOUNT_JSON " +
        "(and BQ_PROJECT/BQ_DATASET if they differ from the defaults).");
      process.exit(1);
    }
    if (process.argv.includes("--schema")) {
      process.stdout.write(schemaText(await listSchema()));
      return;
    }
    const write = process.argv.includes("--write");
    const full = process.argv.includes("--full");
    const only = process.argv.includes("--events") ? "events" : process.argv.includes("--browsing") ? "browsing"
      : process.argv.includes("--orders") ? "orders" : null;
    if (only !== "events" && only !== "orders") {
      const feed = only === "browsing" ? BROWSING_FEED : FUNNEL_FEED;
      const p = plan(full, feed);
      console.log(`plan (${feed.label}): ${p.mode}${p.reason ? ` (${p.reason})` : ""}`);
    }
    const out = await pull({ write, full, only });
    console.log(out.summary);
    const wrote = [out.funnelRows !== null && ACROSS_TIME, out.spendRows !== null && SPEND_DAILY,
                   out.ordersRows !== null && `${ORDERS_BY_PRODUCT} + ${DRAW_PRODUCTS}`,
                   out.eventsRows !== null && LE_EVENTS, out.browsingRows !== null && LE_BROWSING].filter(Boolean);
    console.log(write ? `wrote ${wrote.join(", ")}` : "dry run - pass --write to replace the CSVs");
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
