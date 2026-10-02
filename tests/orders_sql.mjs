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
// claims still landing: winners holding an open pre-authorisation draft on the draw's own product, no paid order for it
const claims = bq.drawClaimsSql();
check(/held_drafts AS \(/.test(claims) && /WHERE entry_draft AND customer_id IS NOT NULL/.test(claims), "claims read the app's pre-authorisation drafts only");
check(/WHERE p\.won AND b\.customer_id IS NULL/.test(claims) && /paid_by AS \(SELECT DISTINCT release, customer_id, product_title FROM typed WHERE paid/.test(claims),
  "a claim is a winner with no paid order for the product");
check(/h\.product_title = dp\.product_title/.test(claims) && /ORDER BY source, n DESC, product_title/.test(claims),
  "on the draw's own product: its winners' paid orders first, else its entrants' drafts");
check(bq.DRAW_CLAIMS_HEADER.join(",") === "release,draw_id,product_title,claims,units", `the claims file's columns (${bq.DRAW_CLAIMS_HEADER})`);
check(!/user_email|customer_email/.test(claims) && !/SELECT\s+\*/i.test(claims), "the claims query names no address column and takes no *");
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
check(path.dirname(bq.UNITS_PAID) === path.dirname(bq.ORDERS_BY_PRODUCT), "the units file lives beside orders_by_product.csv, from the same pull");
// one name per product (docs/DATA_MODEL.md 2.4): each Shopify product goes by
// the title on its latest line, so a renamed work, if only in its capitals,
// is one product; two products under one title stay one (a private-room
// variant) unless their SKUs name different works, which are then told apart
// by the work; and all three files name products that way, so they join
const ctes = bq.orderLinesCtes();
check(/product_titles AS \(\n\s+SELECT release, shopify_product_id,\n\s+ARRAY_AGG\(product_title ORDER BY COALESCE\(order_date, draft_date\) DESC, product_title LIMIT 1\)\[OFFSET\(0\)\] AS title,/.test(ctes)
  && /FROM lines WHERE shopify_product_id IS NOT NULL GROUP BY 1, 2\)/.test(ctes), "a Shopify product is named by the title on its latest line");
check(/MIN\(work_code\) AS work_code/.test(ctes)
  && /IF\(work_code IS NOT NULL AND MIN\(work_code\) OVER \(PARTITION BY release, title\) != MAX\(work_code\) OVER \(PARTITION BY release, title\),\n\s+CONCAT\(title, ' \(', work_code, '\)'\), title\) AS product_title/.test(ctes),
  "a title two works share is told apart by the work each one's SKUs name, and only then");
check(/typed AS \(\n\s+SELECT l\.\* EXCEPT \(product_title\), COALESCE\(pn\.product_title, l\.product_title\) AS product_title,/.test(ctes)
  && /LEFT JOIN product_names pn ON pn\.release = l\.release AND pn\.shopify_product_id = l\.shopify_product_id\n/.test(ctes),
  "every typed line carries its product's one name");
check(/FROM typed l LEFT JOIN paid_customers/.test(orders) && /GROUP BY l\.release, l\.product_title\n/.test(orders) && /FROM typed l LEFT JOIN purchase_channel/.test(units),
  "orders and units group on that name");
// the draw map: a draw's product is what its winners paid for most, else what
// its entrants hold the app's pre-authorisation drafts for most, both read off
// the feed's own typed lines (one name per product) through the collectors
// table's customer id, so a draw is named from its first entries
check(draws.startsWith("WITH " + ctes + ","), "the draw map reads the feed's own lines");
check(/paid_by AS \(SELECT DISTINCT release, customer_id, product_title FROM typed WHERE paid AND customer_id IS NOT NULL\)/.test(draws)
  && /held_drafts AS \(SELECT DISTINCT release, customer_id, product_title FROM typed WHERE entry_draft AND customer_id IS NOT NULL\)/.test(draws),
  "winners' paid orders and entrants' pre-authorisation drafts, by the product's one name");
check(/FROM draw_people p JOIN paid_by b ON b\.release = p\.release AND b\.customer_id = p\.customer_id\n\s+WHERE p\.won GROUP BY 1, 2, 3/.test(draws)
  && /FROM draw_people p JOIN held_drafts h ON h\.release = p\.release AND h\.customer_id = p\.customer_id\n\s+GROUP BY 1, 2, 3/.test(draws)
  && /ORDER BY source, n DESC, product_title\) = 1/.test(draws), "the winners' reading first, else the entrants', the top product taking the draw");
check(count(draws.slice(ctes.length), /JOIN `/g) === 1 && /JOIN `[^`]+` c ON c\.aa_account_id = e\.aa_account_id AND c\.shopify_customer_id IS NOT NULL/.test(draws)
  && /LOGICAL_OR\(COALESCE\(e\.winner, FALSE\)\) AS won/.test(draws), "the people join runs on the collectors table's customer id, inside BigQuery");
check(/SELECT release, draw_id, product_title, n AS orders,\n\s+ROUND\(n \/ SUM\(n\) OVER \(PARTITION BY release, draw_id, source\), 3\) AS share/.test(draws)
  && bq.DRAW_PRODUCTS_HEADER.join(",") === "release,draw_id,product_title,orders,share", "the file's columns are unchanged");
check(!/aa_account_id/.test(draws.slice(draws.indexOf("pairs AS ("))) && !/customer_id/.test(draws.slice(draws.indexOf("SELECT release, draw_id, product_title, n AS orders"))),
  "no person's id leaves: counts per draw and product only");
check(/FROM typed\s+WHERE entry_draft/.test(claims) && /FROM typed WHERE paid AND customer_id IS NOT NULL/.test(claims), "the claims name products the same way");
check([orders, draws, units, claims].every((s) => !/SELECT\s+\*/i.test(s) && !/user_email|customer_email/.test(s)),
  "no orders query takes * from a table or names an address column");
// the private-room and from-draft units are a part of units_paid: paid lines
// only, as units_paid.csv counts them, never a refunded or pending order's
check(/SUM\(IF\(l\.paid AND l\.order_originated_from_drafts = 1, l\.quantity, 0\)\) AS units_from_drafts/.test(orders)
  && /SUM\(IF\(l\.paid AND l\.is_private_room = 1, l\.quantity, 0\)\) AS units_private_room/.test(orders)
  && /SUM\(IF\(l\.is_private_room = 1, l\.quantity, 0\)\) AS units_private_room/.test(units) && /WHERE l\.paid AND/.test(units),
  "from-draft and private-room units count the paid lines, in both files");
// first and last order stay the feed's freshness: any order line
check(/MIN\(IF\(l\.order_source_type = 'Order', l\.order_date, NULL\)\) AS first_order/.test(orders)
  && /MAX\(IF\(l\.order_source_type = 'Order', l\.order_date, NULL\)\) AS last_order/.test(orders), "first and last order read any order line");
console.log(failed ? `${failed} failure(s)` : "ok: orders sql");
process.exit(failed ? 1 : 0);
