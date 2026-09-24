#!/usr/bin/env node
/* Reconcile the two counts of units sold, inside BigQuery (docs/DATA_MODEL.md 2.3, 2.4).
 *
 * The page has two sources for units sold. The funnel's units are the
 * `order_pieces` of the `purchase` events in LE_Funnel_Report, summed per
 * release and day (etl/aggregate_events.py rebuilds the export from them;
 * the upstream export agrees to +0.04%). The sell-through's units are the
 * paid order lines in Order_Line_Concept, counted the way the orders feed
 * counts them (server/bigquery.js ordersSql: orders, not cancelled, not
 * refunded or pending, not test orders, products not frames, one row per
 * line id, merged upsell orders left out).
 *
 * This matches the two order by order, on the Shopify order id and the
 * release, and writes only counts: no order id, customer id, account id or
 * address leaves BigQuery, and every page returned passes the module's
 * address checks (query() in server/bigquery.js).
 *
 *   data/reconciliation/by_day.csv       release x day: units paid by order
 *                                        date (CET), and of those private-room
 *                                        and from-draft units; funnel units by
 *                                        event date, from the purchase events
 *                                        and from the upstream export
 *   data/reconciliation/order_match.csv  release x how an order matched x the
 *                                        reasons it might not: orders, units
 *                                        paid, funnel units
 *   data/reconciliation/README.md        when it ran, and the totals
 *
 * Run where BIGQUERY_SERVICE_ACCOUNT_JSON is set:
 *   node etl/analysis/feeds_reconciliation.js [--since 2025-01-01]
 */
const fs = require("fs");
const path = require("path");
const bq = require("../../server/bigquery.js");
const { accessToken } = require("../../server/googleAuth.js");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "data", "reconciliation");
const argSince = process.argv.indexOf("--since");
const SINCE = argSince > 0 ? process.argv[argSince + 1] : "2025-01-01";
const T = (name) => `\`${bq.PROJECT}.${bq.DATASET}.${name}\``;
const ORDERS = T(process.env.BQ_ORDERS_TABLE || "Order_Line_Concept");
const EVENTS = T(process.env.BQ_EVENTS_TABLE || "LE_Funnel_Report");
const EXPORT = T(process.env.BQ_FUNNEL_TABLE || "le_funnel_report_split_touch_export");

// the paid order lines as the orders feed counts them, plus every other order
// line kept with the reason it is not counted, one row per order and release
const ORDER_CTES = `
lines AS (
  SELECT simple_release_name AS release, shopify_order_id AS order_id, quantity,
    shopify_product_type AS product_type, shopify_order_created_date_CET AS order_date,
    cancelled_order = 1 AS cancelled, COALESCE(order_financial_status, '') = 'refunded' AS refunded,
    COALESCE(order_financial_status, '') = 'pending' AS pending, is_test_order = 1 AS test,
    REGEXP_CONTAINS(COALESCE(shopify_order_tags, ''), r'upsell_order_merged') AS upsell_merged,
    is_private_room = 1 AS private_room, order_originated_from_drafts = 1 AS from_draft,
    COALESCE(shopify_order_facilitator, '') != '' AS facilitated,
    (shopify_product_type = 'Product' AND is_test_order = 0 AND cancelled_order = 0
      AND COALESCE(order_financial_status, '') NOT IN ('refunded', 'pending')
      AND product_title IS NOT NULL AND product_title != ''
      AND NOT REGEXP_CONTAINS(COALESCE(shopify_order_tags, ''), r'upsell_order_merged')) AS paid
  FROM ${ORDERS}
  WHERE order_source_type = 'Order' AND shopify_order_id IS NOT NULL
    AND simple_release_name IS NOT NULL AND simple_release_name != ''
    AND shopify_order_created_date_CET >= @since
  QUALIFY order_lineitem_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY order_source_type, order_lineitem_id ORDER BY refund_processed_at DESC) = 1),
ord AS (
  SELECT release, order_id, MIN(order_date) AS order_date,
    SUM(IF(paid, quantity, 0)) AS paid_units,
    SUM(IF(product_type = 'Product', quantity, 0)) AS product_units,
    SUM(IF(product_type = 'Frame', quantity, 0)) AS frame_units,
    LOGICAL_OR(cancelled) AS cancelled, LOGICAL_OR(refunded) AS refunded, LOGICAL_OR(pending) AS pending,
    LOGICAL_OR(test) AS test, LOGICAL_OR(upsell_merged) AS upsell_merged,
    LOGICAL_OR(private_room) AS private_room, LOGICAL_OR(from_draft) AS from_draft, LOGICAL_OR(facilitated) AS facilitated
  FROM lines GROUP BY release, order_id)`;

// the purchase events the funnel sums, one row per order and release
const PURCHASE_CTE = `
pur AS (
  SELECT simple_release_name AS release, shopify_order_id AS order_id, MIN(event_date) AS event_date,
    SUM(COALESCE(SAFE_CAST(order_pieces AS FLOAT64), 0)) AS pieces, COUNT(*) AS event_rows,
    LOGICAL_OR(LOWER(CAST(cancelled_order AS STRING)) IN ('1', 'true')) AS ev_cancelled
  FROM ${EVENTS}
  WHERE event_name = 'purchase' AND event_date >= @since
    AND simple_release_name IS NOT NULL AND simple_release_name != ''
  GROUP BY release, order_id)`;

const byDaySql = () => `WITH ${ORDER_CTES},${PURCHASE_CTE},
od AS (
  SELECT release, order_date AS day, SUM(paid_units) AS orders_paid_units,
    SUM(IF(private_room, paid_units, 0)) AS orders_private_room_units,
    SUM(IF(from_draft, paid_units, 0)) AS orders_from_draft_units
  FROM ord GROUP BY release, day),
pd AS (
  SELECT simple_release_name AS release, event_date AS day, SUM(COALESCE(SAFE_CAST(order_pieces AS FLOAT64), 0)) AS funnel_event_units
  FROM ${EVENTS}
  WHERE event_name = 'purchase' AND event_date >= @since AND simple_release_name IS NOT NULL AND simple_release_name != ''
  GROUP BY release, day),
xd AS (
  SELECT simple_release_name AS release, event_date AS day, SUM(SAFE_CAST(Total_Product_Units AS FLOAT64)) AS funnel_export_units
  FROM ${EXPORT}
  WHERE event_date >= @since AND simple_release_name IS NOT NULL AND simple_release_name != ''
  GROUP BY release, day)
SELECT release, day,
  COALESCE(orders_paid_units, 0) AS orders_paid_units,
  COALESCE(orders_private_room_units, 0) AS orders_private_room_units,
  COALESCE(orders_from_draft_units, 0) AS orders_from_draft_units,
  COALESCE(funnel_event_units, 0) AS funnel_event_units,
  COALESCE(funnel_export_units, 0) AS funnel_export_units
FROM od FULL OUTER JOIN pd USING (release, day) FULL OUTER JOIN xd USING (release, day)
WHERE COALESCE(orders_paid_units, 0) != 0 OR COALESCE(funnel_event_units, 0) != 0 OR COALESCE(funnel_export_units, 0) != 0
ORDER BY release, day`;

const orderMatchSql = () => `WITH ${ORDER_CTES},${PURCHASE_CTE},
o_ids AS (SELECT DISTINCT order_id FROM ord),
p_ids AS (SELECT DISTINCT order_id FROM pur WHERE order_id IS NOT NULL),
any_ids AS (SELECT DISTINCT shopify_order_id AS order_id FROM ${ORDERS} WHERE shopify_order_id IS NOT NULL),
j AS (
  SELECT COALESCE(o.release, p.release) AS release,
    CASE
      WHEN o.order_id IS NOT NULL AND p.release IS NOT NULL AND o.paid_units = p.pieces THEN 'both, same units'
      WHEN o.order_id IS NOT NULL AND p.release IS NOT NULL THEN 'both, units differ'
      WHEN o.order_id IS NOT NULL THEN 'orders only'
      ELSE 'funnel only' END AS match,
    COALESCE(o.cancelled, FALSE) AS cancelled, COALESCE(o.refunded, FALSE) AS refunded,
    COALESCE(o.pending, FALSE) AS pending, COALESCE(o.test, FALSE) AS test,
    COALESCE(o.upsell_merged, FALSE) AS upsell_merged, COALESCE(o.frame_units, 0) > 0 AS has_frames,
    COALESCE(o.private_room, FALSE) AS private_room, COALESCE(o.from_draft, FALSE) AS from_draft,
    COALESCE(o.facilitated, FALSE) AS facilitated,
    COALESCE(p.ev_cancelled, FALSE) AS event_says_cancelled,
    COALESCE(p.event_rows, 0) > 1 AS repeated_event,
    o.order_id IS NOT NULL AND p.release IS NOT NULL AND o.order_date != p.event_date AS day_differs,
    p.release IS NOT NULL AND p.order_id IS NULL AS event_without_order_id,
    o.order_id IS NULL AND p.order_id IS NOT NULL AND p.order_id IN (SELECT order_id FROM o_ids) AS orders_have_it_under_another_release,
    o.order_id IS NULL AND p.order_id IS NOT NULL AND p.order_id NOT IN (SELECT order_id FROM o_ids)
      AND p.order_id IN (SELECT order_id FROM any_ids) AS in_orders_table_but_not_an_order_since,
    o.order_id IS NULL AND p.order_id IS NOT NULL AND p.order_id NOT IN (SELECT order_id FROM any_ids) AS not_in_orders_table,
    p.release IS NULL AND o.order_id IN (SELECT order_id FROM p_ids) AS funnel_has_it_under_another_release,
    COALESCE(o.paid_units, 0) AS paid_units, COALESCE(p.pieces, 0) AS funnel_units
  FROM ord o FULL OUTER JOIN pur p ON o.order_id = p.order_id AND o.release = p.release)
SELECT release, match, cancelled, refunded, pending, test, upsell_merged, has_frames, private_room, from_draft,
  facilitated, event_says_cancelled, repeated_event, day_differs, event_without_order_id,
  orders_have_it_under_another_release, in_orders_table_but_not_an_order_since, not_in_orders_table,
  funnel_has_it_under_another_release,
  COUNT(*) AS orders, SUM(paid_units) AS paid_units, SUM(funnel_units) AS funnel_units
FROM j
WHERE paid_units != 0 OR funnel_units != 0
GROUP BY release, match, cancelled, refunded, pending, test, upsell_merged, has_frames, private_room, from_draft,
  facilitated, event_says_cancelled, repeated_event, day_differs, event_without_order_id,
  orders_have_it_under_another_release, in_orders_table_but_not_an_order_since, not_in_orders_table,
  funnel_has_it_under_another_release
ORDER BY release, match`;

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function toCsv(token, sql, file) {
  const out = [];
  let header = null;
  const meta = await bq.query(token, sql, { since: { type: "DATE", value: SINCE } }, {
    onHeader: (h) => { header = h; },
    onRows: (rows) => { for (const r of rows) out.push(r); },
  });
  fs.writeFileSync(file, [header.join(","), ...out.map((r) => r.map(csvCell).join(","))].join("\n") + "\n");
  return { header, rows: out, bytes: meta.bytes };
}

(async () => {
  const sa = bq.configured();
  if (!sa) {
    console.error("BigQuery is not configured here: set BIGQUERY_SERVICE_ACCOUNT_JSON.");
    process.exit(1);
  }
  const token = await accessToken(sa, "bigquery");
  fs.mkdirSync(OUT, { recursive: true });
  const ranAt = new Date().toISOString();
  const day = await toCsv(token, byDaySql(), path.join(OUT, "by_day.csv"));
  const match = await toCsv(token, orderMatchSql(), path.join(OUT, "order_match.csv"));

  // the totals, printed and kept beside the files: aggregates only
  const col = (res, name) => res.header.indexOf(name);
  const sum = (res, name, keep = () => true) => res.rows.filter(keep).reduce((s, r) => s + Number(r[col(res, name)] || 0), 0);
  const lines = [];
  lines.push(`# Units sold: the orders feed against the funnel`, "",
    `Queried ${ranAt}, orders and events from ${SINCE}. Written by etl/analysis/feeds_reconciliation.js.`, "",
    `| Measure | Units |`, `|---|---|`,
    `| Units paid, orders feed definition | ${sum(day, "orders_paid_units")} |`,
    `| Funnel units, purchase events | ${sum(day, "funnel_event_units")} |`,
    `| Funnel units, upstream export | ${sum(day, "funnel_export_units")} |`, "",
    `| How the orders matched | Orders | Units paid | Funnel units |`, `|---|---|---|---|`);
  for (const m of ["both, same units", "both, units differ", "orders only", "funnel only"]) {
    const keep = (r) => r[col(match, "match")] === m;
    lines.push(`| ${m} | ${sum(match, "orders", keep)} | ${sum(match, "paid_units", keep)} | ${sum(match, "funnel_units", keep)} |`);
  }
  lines.push("", `by_day.csv: ${day.rows.length} rows. order_match.csv: ${match.rows.length} rows.`);
  fs.writeFileSync(path.join(OUT, "README.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
