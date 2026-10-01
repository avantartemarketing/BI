/* The timed-launch feeds (server/bigquery.js, the TL feeds section; docs/TL_SPEC.md §3).
 * BigQuery is not reachable from a test, so this reads the queries' text and
 * runs the two writers on made-up rows: the events query names every column
 * it takes and never the address column or the identifiers the LE feed drops,
 * the browsing query keeps the hour only around a launch's window, both
 * writers refuse a header that differs and a cell shaped like an address, the
 * feeds run from their own start (all time) and carry the rename check, and
 * the incremental merge reads a row's date in either format the feeds write.
 *   node tests/tl_feeds.mjs */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bq = require(path.join(here, "..", "server", "bigquery.js"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message || e)); } };

// ---- the events query
const ev = bq.tlEventsSql();
check(ev.includes(`.${bq.TL_TABLE}\`\n`) && bq.TL_TABLE === "TL_Funnel_Report_v2", `the TL table (${bq.TL_TABLE})`);
check(/WHERE event_name IN \('signup', 'purchase'\) AND event_date >= @since/.test(ev), "signups and purchases, from @since");
check(!/select\s+\*|\.\*/i.test(ev), "every column is named");
check(!/user_email|customer_email|user_pseudo_id|ga_session_id|customer_id|subscription_id|shopify_order|utm_|page_path|page_title|private_room_slug/.test(ev),
  "no address column, no identifier the LE feed drops, no page string");
check(bq.TL_EVENT_COLUMNS.every((c) => ev.includes(`\`${c}\``)), "the declared columns are the selected ones");
for (const c of ["event_timestamp", "event_date", "event_name", "aa_account_id", "simple_release_name", "launch_date", "announcement_date",
                 "pre_post_launch_signup", "converted_signup", "order_pieces", "cancelled_order", "pr_order", "purchase_with_signup",
                 "AA_session_custom_channel_group_split_touch", "campaign_id", "campaign_stage"]) {
  check(bq.TL_EVENT_HEADER.includes(c), `the events file carries ${c}`);
}
check(bq.TL_EVENT_HEADER.every((c) => /^[A-Za-z0-9_]+$/.test(c)), "plain identifiers only");
check(/ORDER BY event_date, event_timestamp$/.test(ev), "ordered by day then time");

// ---- the events writer: the LE guard on the TL column list
const W = bq.tlEventsWriter;
check(throws(() => W(bq.TL_EVENT_HEADER.slice(0, -1)), /TL events feed returned columns that differ/), "a header that differs is refused");
check(throws(() => W(bq.TL_EVENT_HEADER.concat(["user_email"])), /differ from the declared list/), "an extra column is refused");
const w = W(bq.TL_EVENT_HEADER);
check(w.dateIndex === bq.TL_EVENT_HEADER.indexOf("event_date") && w.dateIndex > 0, "the writer knows the date column");
const row = bq.TL_EVENT_HEADER.map(() => "");
row[0] = "1789047878"; row[1] = "2026-09-15"; row[2] = "signup"; row[3] = "acc_1";
row[bq.TL_EVENT_HEADER.indexOf("simple_release_name")] = "Bisa Butler · Multiple · 2026 Q4";
row[bq.TL_EVENT_HEADER.indexOf("launch_date")] = "1791910800";
const line = w.row(row);
check(line.startsWith("2026-09-10T"), `event_timestamp becomes ISO (${line.slice(0, 24)})`);
check(line.split(",")[1] === "2026-09-15", "event_date passes through as ISO");
check(line.includes("2026-10-13T17:00:00.000Z"), "launch_date becomes ISO too (the window's open hour)");
const bad = row.slice(); bad[bq.TL_EVENT_HEADER.indexOf("release_name")] = "someone@example.com";
check(throws(() => w.row(bad), /TL events pull aborted: column release_name carries an address-shaped value \(row dated 2026-09-15\)/),
  "an address-shaped cell aborts the pull, naming the column and the day");
check(!throws(() => w.row(bad), /example\.com/), "and never the value");

// ---- the browsing query: counts, with the hour around the window only
const br = bq.tlBrowsingSql();
check(br.includes(`.${bq.TL_TABLE}\`\n`) && /WHERE event_name IN \('page_view', 'session_start'\) AND event_date >= @since/.test(br), "page views and session starts from the TL table");
check(/COUNTIF\(event_name = 'session_start'\) AS Sessions_Total/.test(br) && /COUNTIF\(event_name = 'page_view'\) AS Page_Views_Total/.test(br), "the two counts");
check(/IF\(launch_date IS NOT NULL AND event_timestamp >= TIMESTAMP_SUB\(launch_date, INTERVAL 2 DAY\)/.test(br)
  && /event_timestamp < TIMESTAMP_ADD\(launch_date, INTERVAL 9 DAY\)/.test(br)
  && /FORMAT_TIMESTAMP\('%Y-%m-%dT%H:00:00Z', event_timestamp\), NULL\) AS event_hour/.test(br),
  "the hour is kept from two days before the open to nine days after, UTC, else null");
check(bq.TL_HOUR_DAYS_BEFORE === 2 && bq.TL_HOUR_DAYS_AFTER === 9, "the band covers the early access the day before, a 7-day window and its settling day");
check(/GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9\n/.test(br), "grouped on the eight keys and the hour");
check(!/aa_account_id|user_pseudo_id|user_email|ga_session_id/.test(br), "no identifier is read");
check(bq.TL_BROWSING_HEADER.join(",") === "AA_session_custom_channel_group_split_touch,event_date,simple_release_name,campaign_stage,days_since_announcement,days_until_launch,pct_days_since_announcement,pct_days_until_launch,event_hour,Sessions_Total,Page_Views_Total",
  "the browsing file's columns: the LE browsing keys, the hour, the two counts");

// ---- the browsing writer
const B = bq.tlBrowsingWriter;
check(throws(() => B(bq.BROWSING_HEADER), /TL browsing feed returned columns that differ/), "the LE browsing header is not the TL one");
const b = B(bq.TL_BROWSING_HEADER);
const bl = b.row(["AA Email", "2026-10-13", "Bisa Butler · Multiple · 2026 Q4", "TL - Now live", "28", "0", "1", "0", "2026-10-13T17:00:00Z", "40", "95"]);
check(bl === "AA Email,13/10/2026,Bisa Butler · Multiple · 2026 Q4,TL - Now live,28,0,1,0,2026-10-13T17:00:00Z,40,95", `the date is written DD/MM/YYYY, the hour kept (${bl})`);
const bd = b.row(["AA Email", "2026-09-15", "Bisa Butler · Multiple · 2026 Q4", "TL - Announcement", "0", "28", "0", "1", "", "40", "95"]);
check(bd.split(",")[8] === "", "a daily row has no hour");

// ---- the feeds: their own start, the rename check, the LE pair unchanged
check(bq.TL_SINCE === "2019-01-01", `the TL feeds run from all time by default (${bq.TL_SINCE})`);
check(bq.TL_EVENTS_FEED.since === bq.TL_SINCE && bq.TL_BROWSING_FEED.since === bq.TL_SINCE, "both TL feeds carry that start");
check(bq.FUNNEL_FEED.since === undefined && bq.BROWSING_FEED.since === undefined, "the LE feeds still run from BQ_SINCE");
check(bq.TL_EVENTS_FEED.label === "TL events" && bq.TL_BROWSING_FEED.label === "TL browsing", "the labels the notes use");
check(path.basename(bq.TL_EVENTS) === "tl_events.csv" && path.basename(bq.TL_BROWSING) === "tl_browsing.csv"
  && path.dirname(bq.TL_EVENTS) === path.dirname(bq.LE_EVENTS), "the files sit with the LE feeds under sources/ (gitignored, served by no endpoint)");
check(path.basename(bq.TL_EVENTS_META) === "tl_events.meta.json" && path.basename(bq.TL_BROWSING_META) === "tl_browsing.meta.json", "each with its own bookmark");
const en = bq.TL_EVENTS_FEED.namesSql(), bn = bq.TL_BROWSING_FEED.namesSql();
check(/^SELECT DISTINCT simple_release_name FROM `[^`]+TL_Funnel_Report_v2`\n/.test(en) && /event_date >= @since AND event_date < @before/.test(en)
  && /event_name IN \('signup', 'purchase'\)/.test(en), "the events feed's names query: one column, the rows before the overlap, its own filter");
check(/^SELECT DISTINCT simple_release_name FROM `[^`]+TL_Funnel_Report_v2`\n/.test(bn) && /event_date >= @since AND event_date < @before/.test(bn)
  && /event_name IN \('page_view', 'session_start'\)/.test(bn), "the browsing feed's names query likewise");
check(bq.eventsWriter === undefined || typeof bq.eventsWriter === "function", "the LE events writer is still exported");
check(bq.EVENT_HEADER.length === 48 && !bq.EVENT_HEADER.includes("shopify_order_id"), `the LE events feed is unchanged (${bq.EVENT_HEADER.length} columns)`);
check(bq.BROWSING_HEADER.length === 10 && !bq.BROWSING_HEADER.includes("event_hour"), "the LE browsing feed stays daily");

// ---- the incremental merge reads a row's date in either format
check(bq.isoDate("13/10/2026") === "2026-10-13", "DD/MM/YYYY (the export, the browsing feeds)");
check(bq.isoDate("2026-10-13") === "2026-10-13", "YYYY-MM-DD (the event feeds)");
check(bq.isoDate("2026-10-13T17:00:00Z") === "2026-10-13", "a timestamp reads as its day");
check(bq.isoDate("") === null && bq.isoDate(undefined) === null && bq.isoDate("13 Oct 2026") === null, "anything else is no date");

// ---- the summary names the pair, the CLI knows --tl
import fs from "node:fs";
const src = fs.readFileSync(path.join(here, "..", "server", "bigquery.js"), "utf8");
check(/process\.argv\.includes\("--tl"\) \? "tl"/.test(src), "--tl pulls the pair alone");
check(/process\.env\.BQ_TL === "off"/.test(src), "BQ_TL=off skips it");
check(/tlRows: tl \? tl\.rows : null/.test(src) && /\$\{tlNote\}, since \$\{SINCE\}/.test(src), "the pull reports the pair");
check(!src.includes(String.fromCharCode(8212)), "no em dash");

if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("tl feeds: ok");
