/* The orders query's shape: the rules the docs promise are in the SQL the
 * pull sends. BigQuery is not reachable from a test, so this reads the text:
 * one row per line id, the upsell orders left out of prints, frames and the
 * draw map alike, the frames matched to the work their SKU names before the
 * rest is shared, and the file's columns unchanged.  node tests/orders_sql.mjs */
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
check(bq.ORDERS_HEADER.length === 23 && bq.ORDERS_HEADER.includes("frames_paid") && bq.ORDERS_HEADER.includes("prints_offered_paid"), `the file's columns are unchanged (${bq.ORDERS_HEADER.length})`);
check(!/user_email|customer_email/.test(orders) && !/user_email|customer_email/.test(draws), "no address column is named");
// the units feed counts the same paid lines as the orders feed, by day and
// by the channel of each order's own purchase event, and nothing personal
const units = bq.unitsPaidSql();
check(units.startsWith("WITH " + bq.orderLinesCtes() + ",") && orders.startsWith("WITH " + bq.orderLinesCtes() + ","), "units and orders share one set of line rules");
check(/WHERE l\.paid AND/.test(units) && /SUM\(l\.quantity\) AS units_paid/.test(units), "units counts the paid lines, as units_paid does");
check(/pc\.order_id = l\.order_id/.test(units) && !/pc\.release/.test(units), "an order is matched to its purchase event on the order id alone");
check(/COALESCE\(pc\.channel, 'Untracked'\)/.test(units) && /pc\.order_id IS NOT NULL AS purchase_event/.test(units), "an order with no event is Untracked, and says so apart");
check(/GROUP BY l\.release, l\.product_title, l\.order_date, channel, purchase_event/.test(units), "grain: release, product, day, channel");
check(!/order_id,|customer_id,|aa_account_id/.test(units.slice(units.lastIndexOf("SELECT l.release"))), "no id in the select list");
check(!/user_email|customer_email/.test(units), "no address column is named in the units query");
check(bq.UNITS_PAID_HEADER.join(",") === "release,product_title,order_date,channel,purchase_event,units_paid,units_private_room,prints_offered_paid,frames_paid", "the units file's columns");
check(bq.UNITS_PAID.endsWith(path.join("sources", "units_paid.csv")) || bq.UNITS_PAID.startsWith(bq.SOURCES), "the units file lives under sources/");
console.log(failed ? `${failed} failure(s)` : "ok: orders sql");
process.exit(failed ? 1 : 0);
