/* The frame prices behind the framing study (etl/analysis/framing_conversion.py):
 * per release and work, the paid prints a frame was on offer for and their
 * price, the frames bought with them and their price - the median, the
 * lowest (the standard frame) and the mean, and how many price points the
 * work's frames sold at. Aggregates only, no customer column, so it runs
 * through the ordinary query helper and its PII guard. Writes
 * data/frame_prices.csv (not committed; a few seconds to regenerate).
 *   node etl/analysis/frame_prices.js */
const fs = require("fs");
const path = require("path");
const bq = require("../../server/bigquery.js");
const { serviceAccount, accessToken } = require("../../server/googleAuth.js");
const OUT = process.env.OUT || path.join(__dirname, "..", "..", "data", "frame_prices.csv");
(async () => {
  const token = await accessToken(serviceAccount("BIGQUERY_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON"), "bigquery");
  const sql =
    "WITH lines AS (\n" +
    "  SELECT simple_release_name AS release,\n" +
    "    REGEXP_EXTRACT(UPPER(COALESCE(sku, '')), r'^([^-]+-[^-]+)-') AS work_code,\n" +
    "    shopify_product_type AS ptype, quantity, CAST(shopify_product_variant_price AS FLOAT64) AS price,\n" +
    "    framing_offered IN ('Optional framing on order', 'Frame included') AS offered,\n" +
    "    order_source_type = 'Order' AND cancelled_order = 0 AND COALESCE(order_financial_status, '') NOT IN ('refunded', 'pending') AS paid,\n" +
    "    shopify_order_id AS order_id\n" +
    `  FROM \`${bq.PROJECT}.${bq.DATASET}.Order_Line_Concept\`\n` +
    "  WHERE is_test_order = 0 AND shopify_order_id IS NOT NULL\n" +
    "    AND NOT REGEXP_CONTAINS(COALESCE(shopify_order_tags, ''), r'upsell_order_merged')\n" +
    "    AND shopify_product_type IN ('Product', 'Frame')),\n" +
    // a frame line's release: its own where it has one, else the release of the print on the same order with the same work
    "print_orders AS (SELECT DISTINCT order_id, work_code, release FROM lines WHERE ptype = 'Product' AND release IS NOT NULL AND release != ''),\n" +
    "placed AS (\n" +
    "  SELECT COALESCE(NULLIF(l.release, ''), p.release) AS release, l.work_code, l.ptype, l.quantity, l.price, l.offered, l.paid\n" +
    "  FROM lines l LEFT JOIN print_orders p ON p.order_id = l.order_id AND p.work_code = l.work_code)\n" +
    "SELECT release, work_code,\n" +
    "  SUM(IF(ptype = 'Product' AND paid AND offered, quantity, 0)) AS prints_offered,\n" +
    "  APPROX_QUANTILES(IF(ptype = 'Product' AND paid AND offered AND price > 0, price, NULL), 2)[OFFSET(1)] AS print_price,\n" +
    "  SUM(IF(ptype = 'Frame' AND paid, quantity, 0)) AS frames,\n" +
    "  APPROX_QUANTILES(IF(ptype = 'Frame' AND paid AND price > 0, price, NULL), 2)[OFFSET(1)] AS frame_price_median,\n" +
    "  MIN(IF(ptype = 'Frame' AND paid AND price > 0, price, NULL)) AS frame_price_min,\n" +
    "  AVG(IF(ptype = 'Frame' AND paid AND price > 0, price, NULL)) AS frame_price_mean,\n" +
    "  COUNT(DISTINCT IF(ptype = 'Frame' AND paid AND price > 0, CAST(ROUND(price) AS INT64), NULL)) AS frame_price_points\n" +
    "FROM placed WHERE work_code IS NOT NULL AND release IS NOT NULL AND release != ''\n" +
    "GROUP BY 1, 2 HAVING prints_offered >= 10 OR frames >= 5\n" +
    "ORDER BY 1, 2";
  const rows = [];
  let header = null;
  await bq.query(token, sql, {}, { onHeader: (h) => { header = h; }, onRows: (rs) => { rows.push(...rs); } });
  const out = [header.join(",")].concat(rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : v)).join(",")));
  fs.writeFileSync(OUT, out.join("\n") + "\n");
  console.log(`${rows.length} release-work rows -> ${OUT}; columns: ${header.join(" | ")}`);
})().catch((e) => { console.error("ERROR", e.message); process.exit(1); });
