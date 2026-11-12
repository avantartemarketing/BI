# The connector's guide

What a Claude reading Avant Arte's launch data through the connector needs before it
answers: which tool to reach for, what the BigQuery tables hold, how the channels are
grouped and read, and the traps that change answers. The connector's `start_here` tool
returns this file, with the list of the dashboard's tables and documents after it
(`server/mcp/index.js`). Keep it accurate when a feed or a convention changes.

Everything here is read-only. No tool changes a target, an input, a page or the data.

## 1. What this is

Avant Arte sells art editions in launches ("releases"). Two kinds:

- **LE, limited edition.** A fixed edition, mostly sold by draw: collectors enter during
  a campaign of two to four weeks, winners pay. Some are sold on a public page, by
  enquiry or as pre-orders.
- **TL, timed launch.** An open edition sold for a fixed window (hours to days) after a
  signup period.

The Launch Performance dashboard tracks each release against a target. The connector
gives you the dashboard's own figures, the tables it is built from, its documentation,
and the BigQuery tables underneath, back to 2019.

## 2. Which tool

| The question | Use |
|---|---|
| How is a release doing; a figure on its page | `list_releases` for its id, then `get_release` |
| Across releases, from what the dashboard already aggregates: units paid by day and channel, ad spend, email sends, posts, past launches | `describe_table`, then `query_table` |
| Anything over the whole history, by channel, by launch or by person: trends over years, funnels, cohorts, repeat buyers | `bigquery_sql` (and `bigquery_tables` for a table's columns) |
| How a figure is worked out, what a term means | `read_docs` |

For a figure a release's page shows, read the page (`get_release`) and use it as it is:
do not recompute it. The page counts units paid in the Shopify orders over the release's
window; the funnel's own purchase count differs slightly (METHODOLOGY 1).

## 3. The BigQuery tables

All in `avantarte-data-production.AA_company_tables`. Name them in full, in backticks.
None is partitioned: a query scans every row of the columns it names (0.3 to 1 GB for a
typical one), so name only the columns it needs and aggregate in the query.

**`LE_Funnel_Report`**: one row per event on a limited edition release (10 million rows).
`event_name` is one of `page_view`, `session_start`, `signup`, `draw entry intent`,
`purchase`. Signups run from April 2019, purchases from 2021, page views and sessions
from 16 August 2022, draw entries from September 2023.

- when and what: `event_timestamp`, `event_date`, `event_name`
- the release: `simple_release_name` (the key every feed shares, `Artist · Work · 2026 Q3`),
  `launch_type` (`Draw`, `Public`, `Enquiry`, `TBC (Pre-order)`), `launch_date`,
  `announcement_date`, and the campaign clock (`days_since_announcement`,
  `pct_days_since_announcement`: 0 at the announce, 1 at the close; `campaign_stage`)
- the channel: `AA_session_custom_channel_group_split_touch` (section 4)
- the person: `aa_account_id`, on signed-in rows only (section 7)
- a purchase: `order_pieces` (units), `order_products`, `order_type`, `pr_order` (private
  room), `shopify_order_id`, `purchase_with_draw_entry`, `purchase_with_preorder_app`
- a draw entry: `draw_id`, `draw_entry_eligible`, `winner`, `pre_order`,
  `draw_entry_multiset_preference_max_quantity_once` (units wanted, counted once per
  entrant), `exclusion_reason`, `removal_reason`
- a signup: `aa_subscription_type`, `pre_post_launch_signup`, `converted_signup`

**`TL_Funnel_Report_v2`**: the same for timed launches (8 million rows; `launch_type` is
`Timed`). No draw columns. Purchases from September 2021, page views and sessions from
16 August 2022.

**`le_funnel_report_split_touch_export`**: the LE funnel already counted per channel, day
and release (sessions, entries, units by route). Cheaper than the events for a daily LE
series. One trap: `Draw_Entry_Eligible` shrinks as a draw is allocated; for eligible
entries use `Collectors_Eligible_Entries` (people) or `Draw_Entries_Eligible_Units`
(units). There is no TL equivalent the connector can read.

**`Order_Line_Concept`**: one row per Shopify order line (141 thousand rows), with the
release (`simple_release_name`), the product, `quantity`, prices, `order_financial_status`,
`cancelled_order`, `order_source_type` (`Order` or `Draft`), `is_private_room`,
`order_has_frame`, the shipping country. What counts as a unit paid has rules (refunds,
drafts, duplicated lines, merged upsells): read DATA_MODEL section 2.4 before counting
from it, or use the dashboard's `units_paid` table, which has applied them.

**`ads_insights_AA_export`**: Meta ad spend per ad per day (`campaign_name`, `adset_name`,
`ad_name`, `spend_date`, `spend` in euros, `impressions`, `reachs`, `link_clicks`).
`meta_ads_insights_export` is the same spend per campaign. A release's campaign is named
for its campaign code (DATA_MODEL 1.2).

**`Collector_Concept`**: one row per collector. Use it only as the bridge between
`aa_account_id` and `shopify_customer_id`, and for counts by `country` or
`collector_tier`. It holds names, contact details and dates of birth: see section 7.

`bigquery_tables` lists these with their size, and gives any one's columns.

## 4. Channels

The channel of an event is `AA_session_custom_channel_group_split_touch`: the split-touch
attribution of the session it happened in. Fifteen values. The feeds spell the last one
`untracked`, in lower case, and leave it empty on some rows.

The dashboard reads them in six groups (DATA_MODEL 1.3). In SQL:

```sql
CASE
  WHEN ch IN ('AA Email Man', 'AA Email Auto') THEN 'AA Email'
  WHEN ch IN ('AA Meta', 'AA X') THEN 'AA Social'
  WHEN ch = 'Referral Artist' THEN 'Referral artist'
  WHEN ch = 'Organic Search' THEN 'Organic Search'
  WHEN ch IN ('Paid Social', 'Paid Search') THEN 'Paid'
  WHEN ch = 'Untracked' THEN 'Untracked'
  ELSE 'Other'   -- Direct, Other, AA Other, Referral Meta, Referral Other, Referral X
END
```

with `ch` as `IF(LOWER(COALESCE(NULLIF(AA_session_custom_channel_group_split_touch, ''), 'untracked')) = 'untracked', 'Untracked', AA_session_custom_channel_group_split_touch)`.

- **AA Email** is Avant Arte's own email: manual sends (Man) and automated flows (Auto).
- **AA Social** is the brand's own organic social: Instagram (AA Meta) and X (AA X). It was labelled AA Meta until 12 November 2026.
- **Organic Search** and **Other** were one group, Search / direct / other, until the same day.
- **Referral artist** is the artist's own channels.
- **Paid** is in practice Paid Social, Meta ads.

**Untracked and Direct.** Untracked is a purchase or entry the feed has no channel for.
Direct is mostly someone who saw something elsewhere and typed the address. The
dashboard's pages share both out over the other channels, in proportion to what each did
in the same period (Untracked first, over Direct too; then Direct over the rest). A
question about the channel mix can be read either way, and the answers differ a great
deal, so say which reading you used: "as attributed", or "with Direct and Untracked
spread, as the dashboard shows it". To spread in SQL, scale each remaining channel by
total over (total less the part being spread), per period.

## 5. Counting

- **Units sold** over the whole history, LE and TL together: `SUM(order_pieces)` over
  `event_name = 'purchase'` in the two funnel tables, by `event_date`. Orders are the
  purchase rows. These are gross: the feeds flag no cancellations or refunds.
- **Sessions** are `session_start` rows; **page views** `page_view` rows.
- **People** are distinct `aa_account_id`.
- **A launch's year or quarter** is the one in its name; a period of sales is the
  purchase date's. Say which you used when it matters.
- **Money** is euros.

## 6. Traps that change answers

- **Channel attribution starts in the second half of 2022.** Every purchase of 2021 and
  nearly all of 2022 up to September is untracked. Untracked units: 60% of 2022, 20% of
  2023, 12% of 2024, about 5% since. A channel trend that starts before 2023 is mostly
  a trend in tracking; a spread reading of 2022 rests on the 40% that was tracked.
- **Paid Social starts in 2024.** Before 2024 Q1 it is a handful of units.
- **X faded.** AA X sold a few hundred units in 2023, nearly all on that year's
  NFT-related launches, and almost nothing since 2025. Split AA Meta from AA X before
  reading a change in the group.
- **Part periods.** The current year, quarter and month are part-observed: label them,
  or leave them out of a trend.
- **Launches differ in size and number from year to year.** Read a channel per launch as
  well as in total before calling a change a decline.
- **A person's history is a lower bound.** Sessions carry an account only when signed
  in, so "had an earlier visit from channel X" undercounts for every channel alike.
- **The funnel against the orders.** A release's page counts units paid in the Shopify
  orders within its window; the funnel's purchase events are close but not the same
  count. Use the funnel for history across launches and the page for a release.
- **Catalogue rows.** Old releases keep drawing traffic and the odd sale for years.
  Filter to a launch's own window, or to releases with a floor of units, for per-launch
  work.

## 7. People

Report counts, never people. Do not return names, email addresses, phone numbers,
handles, order names or dates of birth, and do not try to identify a customer. The
connector refuses a query that reads an address or one of those columns, and a result
that carries one; the rule holds for any column it does not catch. Inside a query a
person is `aa_account_id`: join and count on it, and return the counts. If someone asks
for a list of people, say the connector does not give one and that the repository owner
can pull it.

## 8. Worked queries

Units a year by channel group, both kinds of launch:

```sql
WITH buys AS (
  SELECT event_date, AA_session_custom_channel_group_split_touch AS raw, order_pieces
  FROM `avantarte-data-production.AA_company_tables.LE_Funnel_Report` WHERE event_name = 'purchase'
  UNION ALL
  SELECT event_date, AA_session_custom_channel_group_split_touch, order_pieces
  FROM `avantarte-data-production.AA_company_tables.TL_Funnel_Report_v2` WHERE event_name = 'purchase'
), named AS (
  SELECT EXTRACT(YEAR FROM event_date) AS year, order_pieces,
    IF(LOWER(COALESCE(NULLIF(raw, ''), 'untracked')) = 'untracked', 'Untracked', raw) AS ch
  FROM buys WHERE event_date >= '2022-01-01'
)
SELECT year,
  CASE WHEN ch IN ('AA Email Man', 'AA Email Auto') THEN 'AA Email'
       WHEN ch IN ('AA Meta', 'AA X') THEN 'AA Social'
       WHEN ch = 'Referral Artist' THEN 'Referral artist'
       WHEN ch = 'Organic Search' THEN 'Organic Search'
       WHEN ch IN ('Paid Social', 'Paid Search') THEN 'Paid'
       WHEN ch = 'Untracked' THEN 'Untracked'
       ELSE 'Other' END AS channel_group,
  SUM(order_pieces) AS units, COUNT(*) AS orders
FROM named GROUP BY year, channel_group ORDER BY year, units DESC
```

One channel launch by launch, with its sessions (here Instagram on timed launches):

```sql
SELECT simple_release_name AS release,
  COUNTIF(event_name = 'session_start' AND AA_session_custom_channel_group_split_touch = 'AA Meta') AS instagram_sessions,
  SUM(IF(event_name = 'purchase' AND AA_session_custom_channel_group_split_touch = 'AA Meta', order_pieces, 0)) AS instagram_units,
  SUM(IF(event_name = 'purchase', order_pieces, 0)) AS units
FROM `avantarte-data-production.AA_company_tables.TL_Funnel_Report_v2`
WHERE event_date >= '2023-01-01' AND simple_release_name LIKE '% 2024 Q%'
GROUP BY release HAVING units >= 20 ORDER BY instagram_units DESC
```

Whether one channel's buyers had been reached by another before (here: of each year's
purchases by channel, the share whose account had an earlier organic-social event):

```sql
WITH ev AS (
  SELECT aa_account_id AS acct, event_timestamp AS ts, event_name, AA_session_custom_channel_group_split_touch AS ch
  FROM `avantarte-data-production.AA_company_tables.LE_Funnel_Report` WHERE aa_account_id IS NOT NULL AND event_date >= '2022-08-16'
  UNION ALL
  SELECT aa_account_id, event_timestamp, event_name, AA_session_custom_channel_group_split_touch
  FROM `avantarte-data-production.AA_company_tables.TL_Funnel_Report_v2` WHERE aa_account_id IS NOT NULL AND event_date >= '2022-08-16'
), buys AS (
  SELECT acct, ts, ch FROM ev WHERE event_name = 'purchase' AND ts >= TIMESTAMP '2024-01-01'
), flagged AS (
  SELECT b.acct, b.ts, b.ch, MAX(IF(e.ch IN ('AA Meta', 'AA X') AND e.ts < b.ts, 1, 0)) AS had_social
  FROM buys b JOIN ev e ON e.acct = b.acct GROUP BY b.acct, b.ts, b.ch
)
SELECT EXTRACT(YEAR FROM ts) AS year, ch AS purchase_channel, COUNT(*) AS purchases,
  ROUND(AVG(had_social), 3) AS share_with_earlier_social
FROM flagged GROUP BY year, purchase_channel HAVING purchases >= 50 ORDER BY year, purchases DESC
```

## 9. Answering

The people asking run marketing and launches. Lead with the answer in a sentence, give
the two or three numbers that carry it, rounded, and name the reading (as attributed or
spread; gross units from the funnel or units paid from the orders) when it changes the
figure. One caveat, and only one that would change what they do. Say plainly when the
data cannot answer, and what would. British English, plain words, no table or column
names unless they ask where a number comes from.
