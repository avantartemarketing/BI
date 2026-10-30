-- Signups of 2025, split by whether they bought the release they signed up
-- for, and the revenue each group brought in the twelve months after.
--
-- A signup is a draw entry on a limited edition ('draw entry intent' in
-- LE_Funnel_Report) or a signup to a timed launch ('signup' in
-- TL_Funnel_Report_v2). A person is an aa_account_id; their anchor is their
-- first signup in 2025, and its release is the one they are judged on:
-- "bought" means a paid order line on that release at any time. Revenue is
-- quantity x variant price over the paid lines (the dashboard's own rule:
-- an Order, not cancelled, not refunded in full, not pending, not a test)
-- of the person's Shopify customer (Collector_Concept), in the 365 days from
-- the anchor. The anchor release's own purchase is inside that window, so
-- the revenue is also given without it: what the group spent beyond the
-- release that brought them in. Only signups that have had a full twelve
-- months are counted (anchor on or before @as_of less 365 days).
-- Aggregates only: no account id, customer id or address leaves BigQuery.

DECLARE as_of DATE DEFAULT CURRENT_DATE();

WITH signups AS (
  SELECT aa_account_id, simple_release_name AS release, event_date, 'LE' AS kind
  FROM `avantarte-data-production.AA_company_tables.LE_Funnel_Report`
  WHERE event_name = 'draw entry intent' AND aa_account_id IS NOT NULL AND simple_release_name IS NOT NULL
    AND event_date BETWEEN '2025-01-01' AND '2025-12-31'
  UNION ALL
  SELECT aa_account_id, simple_release_name, event_date, 'TL'
  FROM `avantarte-data-production.AA_company_tables.TL_Funnel_Report_v2`
  WHERE event_name = 'signup' AND aa_account_id IS NOT NULL AND simple_release_name IS NOT NULL
    AND event_date BETWEEN '2025-01-01' AND '2025-12-31'
),
anchor AS (
  -- one row a person: the first signup of the year
  SELECT aa_account_id, release, event_date AS anchor_date, kind
  FROM signups
  QUALIFY ROW_NUMBER() OVER (PARTITION BY aa_account_id ORDER BY event_date, release) = 1
),
people AS (
  SELECT a.*, c.shopify_customer_id AS customer_id
  FROM anchor a
  LEFT JOIN `avantarte-data-production.AA_company_tables.Collector_Concept` c ON c.aa_account_id = a.aa_account_id
  WHERE a.anchor_date <= DATE_SUB(as_of, INTERVAL 365 DAY)
),
lines AS (
  SELECT customer_id, simple_release_name AS release, shopify_order_id AS order_id,
    shopify_order_created_date_CET AS order_date, quantity,
    quantity * CAST(shopify_product_variant_price AS FLOAT64) AS revenue
  FROM `avantarte-data-production.AA_company_tables.Order_Line_Concept`
  WHERE is_test_order = 0 AND customer_id IS NOT NULL
    AND order_source_type = 'Order' AND cancelled_order = 0
    AND COALESCE(order_financial_status, '') NOT IN ('refunded', 'pending')
    AND shopify_order_created_date_CET >= '2025-01-01'
),
bought AS (
  -- did the person buy the release they signed up for, at any time
  SELECT DISTINCT p.aa_account_id
  FROM people p JOIN lines l ON l.customer_id = p.customer_id AND l.release = p.release
),
window_lines AS (
  SELECT p.aa_account_id, l.order_id, l.quantity, l.revenue, l.release = p.release AS on_anchor
  FROM people p JOIN lines l ON l.customer_id = p.customer_id
  WHERE l.order_date >= p.anchor_date AND l.order_date < DATE_ADD(p.anchor_date, INTERVAL 365 DAY)
),
per_person AS (
  SELECT p.aa_account_id, p.kind,
    IF(b.aa_account_id IS NULL, 'did not buy the release', 'bought the release') AS grp,
    COUNT(DISTINCT w.order_id) AS orders,
    COALESCE(SUM(w.quantity), 0) AS units,
    COALESCE(SUM(w.revenue), 0) AS revenue,
    COALESCE(SUM(IF(w.on_anchor, 0, w.revenue)), 0) AS revenue_beyond_anchor,
    COUNT(DISTINCT IF(w.on_anchor, NULL, w.order_id)) AS orders_beyond_anchor
  FROM people p
  LEFT JOIN bought b ON b.aa_account_id = p.aa_account_id
  LEFT JOIN window_lines w ON w.aa_account_id = p.aa_account_id
  GROUP BY 1, 2, 3
)
SELECT grp, kind,
  COUNT(*) AS people,
  COUNTIF(orders > 0) AS buyers_in_12m,
  COUNTIF(orders_beyond_anchor > 0) AS buyers_beyond_anchor,
  SUM(orders) AS orders,
  SUM(units) AS units,
  ROUND(SUM(revenue)) AS revenue,
  ROUND(SUM(revenue_beyond_anchor)) AS revenue_beyond_anchor,
  ROUND(SUM(revenue) / COUNT(*)) AS revenue_per_person,
  ROUND(SUM(revenue_beyond_anchor) / COUNT(*)) AS revenue_beyond_anchor_per_person,
  ROUND(SUM(revenue_beyond_anchor) / NULLIF(COUNTIF(orders_beyond_anchor > 0), 0)) AS revenue_beyond_anchor_per_buyer
FROM per_person
GROUP BY ROLLUP (grp, kind)
HAVING grp IS NOT NULL
ORDER BY grp, kind
