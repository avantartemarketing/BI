/* The pages feed (server/bigquery.js, the pages section; docs/DATA_MODEL.md
 * 2.6): the shape of the query the pull sends, read as text since BigQuery
 * is not reachable from a test. Session grain inside BigQuery, the three
 * events it reads, a step counted only after the step before it in the same
 * session, a session keyed by its first event's day and channel, no
 * identifier and no address column in what comes out, the file's columns,
 * the writer's guards, and the feed's place among the incremental feeds.
 *   node tests/pages_sql.mjs */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bq = require(path.join(here, "..", "server", "bigquery.js"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message || e)); } };

const sql = bq.pagesSql();
check(sql.includes(`.${bq.EVENTS_TABLE}\`\n`), `reads the event table (${bq.EVENTS_TABLE})`);
check(/\(\(event_name = 'page_view' AND page_type IN \('release page', 'product page'\)\) OR event_name = 'draw entry intent'\)/.test(sql),
  "the two page types and the draw entry, nothing else");
check(/AND event_date >= @since AND ga_session_id IS NOT NULL AND simple_release_name IS NOT NULL\)/.test(sql), "from @since, sessions with an id, rows with a release");
check(/per_session AS \(\n\s+SELECT release, sid,/.test(sql) && /FROM ev GROUP BY 1, 2\)/.test(sql), "one row per release and session inside BigQuery");
check(/MIN\(IF\(on_release, ts, NULL\)\) AS first_release/.test(sql) && /MIN\(IF\(on_product, ts, NULL\)\) AS first_product/.test(sql)
  && /MAX\(IF\(on_product, ts, NULL\)\) AS last_product/.test(sql) && /MAX\(IF\(entered, ts, NULL\)\) AS last_entry/.test(sql),
  "the first release page view, the first and last product page view, the last entry of the session");
check(/COUNTIF\(first_release IS NOT NULL AND last_product >= first_release\) AS release_product_sessions/.test(sql),
  "a product page counts after the release page");
check(/COUNTIF\(first_product IS NOT NULL AND last_entry >= first_product\) AS product_entry_sessions/.test(sql),
  "an entry counts after a product page");
check(/ARRAY_AGG\(STRUCT\(event_date, channel\) ORDER BY ts LIMIT 1\)\[OFFSET\(0\)\] AS first/.test(sql)
  && /SELECT first\.channel AS AA_session_custom_channel_group_split_touch, first\.event_date AS event_date, release AS simple_release_name,/.test(sql),
  "a session is keyed by its first event's day and channel");
check(/FROM per_session GROUP BY 1, 2, 3 ORDER BY event_date$/.test(sql), "grain: channel, day, release");
const select = sql.slice(sql.lastIndexOf("SELECT first.channel"));
check(!/sid|ga_session_id|aa_account_id|user_pseudo_id|customer_id|page_path|page_title/.test(select), "no identifier or page string in what comes out");
check(!/user_email|customer_email/.test(sql) && !/select\s+\*|\.\*/i.test(sql), "no address column is named, no *");
check(bq.PAGES_HEADER.join(",") === "AA_session_custom_channel_group_split_touch,event_date,simple_release_name,"
  + "release_sessions,release_product_sessions,product_sessions,product_entry_sessions", `the file's columns (${bq.PAGES_HEADER})`);
check(bq.PAGES_COUNTS.length === 4 && bq.PAGES_HEADER.every((c) => new RegExp(`AS ${c}\\b`).test(select)), "every column the header names is selected");

// the names query the rename check runs, with the feed's own filter
const names = bq.pagesNamesSql();
check(/SELECT DISTINCT simple_release_name FROM/.test(names) && names.includes(bq.EVENTS_TABLE)
  && /event_date >= @since AND event_date < @before/.test(names) && names.includes("page_type IN ('release page', 'product page')"),
  "the names before the overlap, under the feed's own filter");

// the writer: the declared header, the address scan, the date DD/MM/YYYY like the browsing feed
const W = bq.pagesWriter;
check(throws(() => W(bq.PAGES_HEADER.slice(0, -1)), /pages feed returned columns that differ/), "a header that differs is refused");
check(throws(() => W(bq.BROWSING_HEADER), /pages feed returned columns that differ/), "the browsing header is not the pages one");
const w = W(bq.PAGES_HEADER);
check(w.row(["Paid Social", "2026-07-29", "Zeng Fanzhi · Multiple · 2026 Q3", "10", "2", "5", "1"]) === "Paid Social,29/07/2026,Zeng Fanzhi · Multiple · 2026 Q3,10,2,5,1",
  "a row written with the date as the export writes it");
check(throws(() => w.row(["Paid Social", "2026-07-29", "someone@example.com", "10", "2", "5", "1"]), /carries an address-shaped value/), "an address-shaped cell aborts the pull");
check(w.dateIndex === 1, "the merge reads the date column");

// the feed among the incremental feeds, under the sources directory, with its own bookmark
check(bq.PAGES_FEED.label === "pages" && bq.PAGES_FEED.sql === bq.pagesSql && bq.PAGES_FEED.namesSql === bq.pagesNamesSql
  && bq.PAGES_FEED.makeWriter === bq.pagesWriter && !bq.PAGES_FEED.since, "the feed descriptor, from BQ_SINCE like the browsing feed");
check(path.basename(bq.LE_PAGES) === "le_pages.csv" && path.dirname(bq.LE_PAGES) === path.dirname(bq.LE_BROWSING)
  && path.basename(bq.PAGES_META) === "le_pages.meta.json", "beside the browsing feed, with a bookmark of its own");

if (failed) { console.log(`pages sql: ${failed} failed`); process.exit(1); }
console.log("pages sql: ok");
