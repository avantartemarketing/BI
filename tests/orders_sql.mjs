/* The orders query's shape: the rules the docs promise are in the SQL the
 * pull sends. BigQuery is not reachable from a test, so this reads the text:
 * one row per line id, the upsell orders left out of prints, frames and the
 * draw map alike, the frames matched to the work their SKU names before the
 * rest is shared, the frames counted on the orders awaiting payment too, and
 * the file's columns.  node tests/orders_sql.mjs */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bq = require(path.join(here, "..", "server", "bigquery.js"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const count = (s, re) => (s.match(re) || []).length;

const orders = bq.ordersSql(), draws = bq.drawProductsSql();
const cte = (name) => { const i = orders.indexOf(`${name} AS (`); const j = orders.indexOf("\n),\n", i); return i < 0 ? "" : orders.slice(i, j < 0 ? undefined : j); };
check(count(orders, /upsell_order_merged/g) === 2 && cte("lines").includes("upsell_order_merged") && cte("frame_lines").includes("upsell_order_merged"), "the upsell orders are left out of the prints and the frames");
check(draws.includes("upsell_order_merged"), "and out of the draw map");
check(count(orders, /ROW_NUMBER\(\) OVER \(PARTITION BY order_source_type, order_lineitem_id/g) === 2, "one row per line id, for prints and frames");
check(/work_code/.test(cte("lines")) && /work_code/.test(cte("frame_lines")), "the work a SKU names is read on prints and frames");
check(/frames_named AS \(/.test(orders) && /frames_pool AS \(/.test(orders) && /code_prints AS \(/.test(orders), "frames named by SKU and the rest kept apart");
check(/LEAST\(l\.quantity,/.test(orders) && /fn\.frame_units/.test(orders) && /fp\.frame_units/.test(orders), "a print takes its named frames, a share of the rest, never more than one");
check(/SUM\(IF\(l\.paid, l\.frames_line, 0\)\)/.test(orders) && /SUM\(IF\(l\.entry_draft, l\.frames_line, 0\)\)/.test(orders), "frames counted on paid prints and on entry drafts");
check(/SUM\(IF\(l\.awaiting AND l\.offered, l\.quantity, 0\)\) AS prints_offered_awaiting/.test(orders) && /SUM\(IF\(l\.awaiting, l\.frames_line, 0\)\)/.test(orders),
  "and on the orders awaiting payment, the drafts the sell-through counts");
check(bq.ORDERS_HEADER.length === 25 && bq.ORDERS_HEADER.slice(-2).join(",") === "prints_offered_awaiting,frames_awaiting"
  && bq.ORDERS_HEADER.includes("frames_paid") && bq.ORDERS_HEADER.includes("prints_offered_paid"), `the file's columns, the awaiting pair last (${bq.ORDERS_HEADER.length})`);
// every column the header names is one the query selects
check(bq.ORDERS_HEADER.every((c) => new RegExp(`(AS ${c}\\b|\\bl\\.${c}\\b)`).test(orders)), "the header's columns are all selected");
check(!/user_email|customer_email/.test(orders) && !/user_email|customer_email/.test(draws), "no address column is named");
console.log(failed ? `${failed} failure(s)` : "ok: orders sql");
process.exit(failed ? 1 : 0);
