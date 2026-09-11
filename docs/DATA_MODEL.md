# Avant Arte Launch BI - Data Model (v1, LE-first)

This document specifies how every number and target on the Launch Performance dashboard is
calculated. It is the result of reverse-engineering the current tooling:

- **LAUNCH PERFORMANCE OVERVIEW** (Google Sheet snapshot) - the per-release target model + actuals
- **LE Paid Calculator** - the in-flight paid-spend decision tool
- **`Across time.csv`** - the new daily funnel export with campaign-clock columns (the across-time
  target enabler)
- **Draw entry exports** (`draw_…entries_N.csv`) - per-entrant demand data
- **All Sent Emails** (Klaviyo export) and **All editions content** (Emplifi export) - channel
  activity data feeding the funnel diagnostics

LE (Limited Edition, sold by draw / pre-order) is specified fully; TL (Timed Launch, sold by
signup) follows the same architecture and is noted where it differs.

---

## 1. Canonical entities and keys

### 1.1 Release
The unit everything hangs off. **Key = `simple_release_name`**, a string of the form
`Artist · Work · YYYY Qn` (e.g. `Glenn Ligon · Multiple · 2026 Q3`). It is byte-identical across
all Metabase funnel feeds, the order feed, and the model tabs. **There is no numeric ID anywhere;
the string is the join key.**

Attributes (hand-entered per release today, in the LAUNCH INPUT block of each release tab):

| Field | Source cell | Example (Glenn Ligon) |
|---|---|---|
| `marketing_lead` | C77 | Maria |
| `private_room_open` | C79 | 2026-07-31 |
| `announce_date` | C81 | 2026-08-17 |
| `launch_end` (draw close) | C78 | 2026-09-17 |
| `launch_days` | `=C78-C79` | 48 |
| `campaign_name` (Meta ads key) | C85 | `GlennLigon_LE_26 · Enter draw` |
| `campaign_code` | prefix of C85 | `GlennLigon_LE_26` |
| `edition_size` (units) | G77 | 150 |
| `unit_price` | G79 | 3,000 |
| `launch_value` | `=price × size` | 450,000 |
| `artist_profit` (total) | G81 | 176,879 |
| `aa_group_profit` (total) | G82 | 190,745 |
| `artist_profit_share` (who pays ads) | G85 | 0.5 (0 for estates on commission/rev-share) |
| `framing_available` | G87 | Yes |

Derived economics:
- `artist_profit_per_unit = artist_profit / edition_size` (1,218.60)
- `aa_profit_per_unit_ex_framing = aa_group_profit / edition_size` (1,465.29)
- `aa_profit_per_unit = aa_profit_per_unit_ex_framing + (framing_available ? frame_conversion × frame_profit : 0)`
  = 1,465.29 + 0.35 × 94 = **1,498.19**

Global constants (from the workbook's "PROFIT CALC - DO NOT CHANGE" block):
`frame_conversion = 0.35`, `frame_profit = £94/unit`, `cannibalisation = 0.2`
(the LE standard per the spend rules. The 2026-08-28 tab revision left several
per-release cannibalisation cells reading 0 via the broken template reference
(issue 14, §11) - those cells are display artefacts, not the constant. The TL
historical panel still shows 0.10.)

Paid budget share (who funds the ads; distinct from profit share): the workbook's
"Artist budget share (%) / AA budget share (%)" rows where present - Glenn Ligon
is overridden to 100% AA ("he's not sharing paid budget"). Model input
`aa_budget_share` (optional per release); default 100% AA when
`artist_profit_share = 0` (commission / rev-share deals), else 50/50.

### 1.2 Campaign code (cross-system join key)
`campaign_code` (e.g. `GlennLigon_LE_26`) joins the release to:
- **Meta ads**: `campaign_name = '{code} · Enter draw'` in `meta_ads_insights` (campaign_id has
  lost float precision in the export - join on name only).
- **Email**: Klaviyo `Campaign` column equals the code exactly (join `Campaign == campaign_code`,
  i.e. prefix-match the sheet's `{code} · Enter draw`). Never parse email names - 19% don't
  contain the code.
- **Instagram/X content**: Emplifi `Labels` (semicolon-separated, order varies) contains the code;
  strip the generic tokens (`Edition`, `Reel`, `Make-Ready`, free-text artist tags) to find it.

### 1.3 Channel taxonomy
Raw feeds carry 15 channels (split-touch attribution):
`AA Email Auto, AA Email Man, AA Meta, AA Other, AA X, Direct, Organic Search, Other,
Paid Search, Paid Social, Referral Artist, Referral Meta, Referral Other, Referral X, untracked`.

Normalisation rules:
- **Case**: feeds spell `untracked` lowercase; the model uses `Untracked`. Normalise on ingest.
- **Untracked redistribution**: for any "adjusted" metric, redistribute the Untracked value
  pro-rata over the 14 tracked channels:
  `adjusted(c) = x(c) + untracked × x(c) / Σ tracked x`. This is applied to *actuals* before
  comparing to targets. Conversion-rate *benchmarks*, by convention, use **unadjusted**
  denominators (the sheet is consistent about this; keep it).
- **Paid Search** has no benchmarks, no spend feed, and never appears in the daily export -
  every "Total Paid" benchmark is an alias of Paid Social. Model paid = Paid Social; keep Paid
  Search only as a raw actuals bucket.

**Display grouping** (dashboard modules use 4–5 groups):

| Display group | Raw channels |
|---|---|
| AA Email | AA Email Auto + AA Email Man |
| AA Meta (organic social) | AA Meta (+ AA X where the sheet groups "AA Socials") |
| Referral artist | Referral Artist |
| Search / direct / other | Direct + Organic Search + Other + AA Other + Referral Meta + Referral Other + Referral X |
| Paid | Paid Social (+ Paid Search actuals) |

⚠ The sheet's own chart grouping drops **AA Other** entirely (targets short by its share);
include it in Search/direct/other in the rebuild and note the delta vs the sheet.

### 1.4 Product (per-release, for multi-work releases)
From draw entry exports and the sell-through module: `{ product_name, edition, sold, … }`.
Product names contain commas (`Composition with Red, Yellow`) - **never comma-split a product
list without matching against the release's known product set**.

### 1.5 The campaign clock (the new across-time structure)
The daily funnel export now carries 5 computed columns (upstream in BigQuery), the last 5 of
`Across time.csv` / cols AD–AH of the daily import:

| Column | Definition |
|---|---|
| `days_since_announcement` (dsa) | whole days event − announcement timestamp (truncated toward 0; negative = pre-announce) |
| `days_until_launch` (dul) | whole days launch timestamp − event |
| `pct_days_since_announcement` (pdsa) | dsa / L, where **L = campaign length in days (announce → launch)** |
| `pct_days_until_launch` (pdul) | dul / L |
| `campaign_stage` | label derived from the above |

**`pdsa` is the normalised campaign clock: 0 = announcement, 1 = launch/draw close, < 0 = early
access (private room), > 1 = last chance & after.** It lets campaigns of different lengths
(observed 7–107 days, mode 28) be pooled on one axis - this is what makes targets-across-time
possible (§5).

Stage boundary rules (verified empirically):
1. No announcement date on record → `Missing campaign dates` (58% of the export = back catalog).
2. Event before announcement → `Early access` (dsa ≤ 0).
3. Announce → launch split into thirds by pdsa → `Sustain 1 / 2 / 3` (boundaries ≈ ⅓, ⅔ with
   integer-day rounding).
4. First ~24h after the launch timestamp (dul = 0 post-launch) → `Last chance`.
5. Later → `Outside campaign window` (dul ≤ −1).

**The clock is filled in where upstream carries none** (`etl/aggregate_events.py`, §2.3; the
upstream feed has dates for 2026 launches only). Upstream dates always take priority, field by
field. Otherwise, for a release with at least 10 entrants: the announcement is the first big
traffic spike (a day with at least a quarter of the release's busiest day, at least 30 sessions,
and at least three times the previous week's median) when it comes 6 to 30 days before the draw
opens - an announcement with the draw opening later, and the traffic in between is real campaign
traffic - else the day the draw opens (the first of two consecutive days with entrants, or a day
with three); within a week of each other the two are the same announcement and the draw opening
pins the day. The close is the day the draw units are allocated, else the last entry day of a
campaign over for at least a week; a window outside 3..90 days is not used. Checked against the
upstream-dated releases on every run (the `clock rules` line in the log): announce exact on 24 of
27 and within two days on all 27, close exact on 24 (the three misses are draws whose entries ran
past the recorded close). The spike alone would land on the early-access send a day or two early
on most campaigns; for a private-room-led launch it is the private room opening, which the
upstream convention labels early access. Inferred rows use rules 2-5 above cleanly, with days
more than 45 before the announce as `Outside campaign window`; `clock_source` on the rebuilt file
and `data/app/release_windows.csv` say where every release's dates came from.

---

## 2. Source feeds

All funnel data originates in BigQuery `avantarte-data-production.AA_company_tables`:

| Feed | Grain | Key columns | Used for |
|---|---|---|---|
| `le_funnel_report_split_touch_export` | channel × event_date × release | 29 metrics + 5 campaign-clock cols | daily actuals, across-time curves |
| LE funnel lifetime rollup (importrange "Export!A:AB") | channel × release | sessions (D), Total Product Units (S), eligible entries (M/N/Y), units by route (O/P/Q/R), page views (AA), entries (V/W/X/Z/AB) | launch-total actuals, benchmarks |
| `tl_funnel_report_split_touch_export` (+ lifetime) | same, TL metrics (subs) | sessions, subs, customers, units by sub | TL side |
| `order_type_by_release_export` | release × order_date | total_orders, originated_from_drafts, pending_draft, units | draft-order (private room) tracking |
| `meta_ads_insights_export` | campaign × spend_date | impressions, reach, link_clicks, **spend** | paid spend actuals |
| Meta lifetime ("Meta Data for Paid") | campaign | + 7d-click conversions (Purchases, Enter Draw…) | Meta-side attribution |
| Klaviyo email export | email send | Delivered, Opened, Clicked, Unsubscribed | email funnel rungs |
| Emplifi content export | post/story | impressions, reach, engagements, saves, story metrics | social funnel rungs |
| Draw entries export | entrant × draw | tier, score, products, MaxQuantity, winner/claim flags | demand, allocation, sell-through prediction |

**The dashboard reads the BigQuery tables directly when a key is configured**
(`server/bigquery.js`, `BIGQUERY_SERVICE_ACCOUNT_JSON`): `le_funnel_report_split_touch_export`
and `meta_ads_insights_export` are pulled from `BQ_SINCE` (default 2025-01-01) into the same two
CSVs the sheet path writes, so `build.py` is unchanged and the feeds are interchangeable. The
sheet path remains as the fallback, and is the reason to prefer BigQuery: its accumulator tabs
silently truncate (the LE daily tab is capped at exactly 100k rows and has lost everything before
2025-12-20; `Across time.csv` is a 50k-row export cut mid-date at 2026-05-04). Truncation does not
error - the window shortens as new launches push older days off the end - so the feed refuses a
pull that would replace a materially longer history with a shorter one (`BQ_ALLOW_SHRINK=1`
overrides). A BigQuery failure falls back to the sheet but leaves the header reading **Sources
stale**, so a truncated copy is never served as if it were whole. The funnel table is required;
spend is optional, since a service account is easily granted one dataset and not the other -
losing paid spend does not also cost us the funnel.

### 2.1 Event-level feed (`LE_Funnel_Report`) and the personal-data rule

`AA_company_tables.LE_Funnel_Report` is the event-level source behind the daily export: one
row per event (page view, session start, signup, draw entry intent, purchase) since April 2019,
8.1M rows, 368 releases, with the campaign clock, split-touch attribution, draw-entry outcome
(eligibility, exclusion and removal reasons, winner, pre-order, max-quantity preferences), order
detail (type, pieces, cancellation, private-room flag) and page locales. It also carries
**`user_email`** on signed-in rows: 1.9M rows, 109k distinct addresses, 95k of them staff, with
no column-level policy tag - the dashboard's service account can read it (checked 2026-09-10).

**The rule: the address never leaves BigQuery.** The dashboard does not need it - `aa_account_id`
identifies the person on 99.9% of the rows that carry an address (2,428 rows have an address and
no other identifier, all anonymous form fills). `server/bigquery.js` enforces the rule rather than
relying on care:

- the events query names every column it takes (`EVENT_COLUMNS`); `SELECT *` is refused, and so
  is any query text that mentions the email column, so the data team's email-free view is a
  drop-in via `BQ_EVENTS_TABLE`;
- the header BigQuery returns must equal the declared list exactly;
- every cell of every page is scanned for an address-shaped value before it is written; one hit
  aborts the pull, discards the partial file, keeps the previous one and names the column, never
  the value. `processing_error` (free text, up to 7.7k characters) was found to quote addresses
  inside 2,074 error messages and is reduced to `has_processing_error` in SQL.

What is pulled (`sources/le_events.csv`, `node server/bigquery.js --write --events`): the
**conversion events only** - signup, draw entry intent, purchase, ~200k rows all time
(`BQ_EVENTS_SINCE`, default 2019-01-01, because a returning collector's history is the point).
Page views and session starts are the daily export's job; at person level they would be 8M rows
of browsing history for no number the dashboard shows. Identifiers kept: `aa_account_id` (the
person key), `draw_id`, `draw_entry_id`, `campaign_id`. Dropped on purpose: `user_email`,
`user_pseudo_id`, `ga_session_id`, `customer_id`, Shopify order id and name, `subscription_id`,
page URLs and titles, the utm strings (`utm_source` carries an address on 3 rows). Timestamps
are written as ISO.

The account id is still personal data (pseudonymised, GDPR art. 4(5)): the file stays under
`sources/` (gitignored), is served by no endpoint, is rebuilt from BigQuery on every pull so an
erasure upstream propagates within a refresh, and anything that leaves the server - `data/`,
the API, this repository - is aggregated with no identifier column. `BQ_EVENTS=off` skips the
feed; a failure of its guards is reported in the refresh status and never worked around.

Asks of the data team, in order of value: (1) an authorized view over the table without
`user_email` (with `is_staff` derived inside it - 262 of 33,881 draw intents and 63 of 26,525
purchases are staff), the dashboard's service account granted the view and revoked from the
base table, or a policy tag on the column with no fine-grained-reader grant; (2) rotate the
service-account key once access is narrowed, and keep the account to the dashboard alone;
(3) BigQuery data-access audit logs on the dataset; (4) partition the table by `event_date` and
cluster by `simple_release_name` - it is unpartitioned, so every query scans whole columns
(0.7-1.1 GB per aggregate).

Things the feed makes measurable that the daily export cannot: unique entrants and customers per
release (the export's per-channel counts double-count a person across channels and days), new
versus returning collectors per release and per basket (`docs/RELEASE_CLUSTERS.md`), the artist
audience overlap between releases, draw eligibility and removal reasons, pre-order share by
person, cancellations, and hour-level pacing on the campaign clock. Locales are site locales
(three values), not countries - the "Entries by country" open item (§12) is still open.

### 2.2 The daily export's columns, decoded against the events

The daily export (`le_funnel_report_split_touch_export`) is an aggregation of `LE_Funnel_Report`.
Every metric column was reproduced from the events and compared per channel × day × release over
2023-09-01 to 2026-09-10 (323k channel-days). Grain and conventions: channel is
`AA_session_custom_channel_group_split_touch`; *people* means distinct `aa_account_id`; *units*
means `draw_entry_multiset_preference_max_quantity_once` summed, i.e. each entrant's maximum
quantity counted once however many products they entered; an entrant who won one product and
lost another appears on both sides of the winner split.

| Export column | Definition (per channel × day × release) | Match |
|---|---|---|
| `Sessions_Total` | count of `session_start` events | exact |
| `Page_Views_Total` | count of `page_view` events | exact |
| `Draw_Entries` | people with a draw entry intent | −0.4% |
| `Collectors_Eligible_Entries` | people with an eligible intent (`draw_entry_eligible`) | −0.3% |
| `Draw_Entry_Eligible` | people with an eligible intent that did **not** win - post-allocation, see below | −0.4% |
| `Draw_Entries_Eligible_Units` | units wanted by eligible entrants (winners included) | exact |
| `Draw_Entries_Total_Units` | units wanted by all entrants | exact |
| `Draw_Entry_Eligible_No_Conv` | eligible non-winners with no purchase (`draw_with_purchase` = 0) | −0.3% |
| `Draw_Entries_Total_Units_No_Conv` | units of those | exact |
| `Draw_Winner` | people with a winning intent | exact |
| `Preorder_App`, `Preorder_App_Eligable`, `Preorder_Winner` | the same three counts on intents with `pre_order` | within 0.3% |
| `Total_Product_Units` | `order_pieces` summed over `purchase` events | +0.04% |
| `Unique_Customers` | people with a purchase | −0.2% |
| `Product_Units_<route>`, `Customer_<route>` | pieces and people by route; route of a purchase is the first match of `purchase_with_preorder_app` → Preorder App, `purchase_with_presale` → Presale Offered, `pr_order` → Private Room, `purchase_with_draw_entry` → Draw, else Other | within 1.3% per route; 1-3% of channel-days differ, so the precedence is close, not proven |

The sub-percent residuals on the people counts are rows without an account id and the export's
own fan-out (§6.1). `order_type` on the purchase rows (Draw / Private / Pre Order / Regular /
Insiders) is a different classification from the export's five routes and does not reproduce them.

**`Draw_Entry_Eligible` is not "eligible entries".** It shrinks as the draw is allocated: for a
closed draw it is the eligible entrants left without an allocation (Mondrian 2026 Q3: 280,
against 682 eligible entrants and 841 eligible units). Use `Collectors_Eligible_Entries` for
people and `Draw_Entries_Eligible_Units` for units - the latter is the dashboard's entries
currency, includes winners, and is stable after allocation. Benchmark table B (§4, "session →
unique eligible entry") was transcribed from the workbook's lifetime rollup, whose eligible-entry
columns (M/N) may be this post-allocation count; if so those conversion benchmarks are understated
for every closed draw. To be checked in the sheet.

### 2.3 The export rebuilt here, and the switch

`etl/aggregate_events.py` rebuilds the export from the two event-level feeds and reconciles the
result against the export on every refresh (it runs before `build.py`; `npm run etl` and the
live refresh both chain it):

- **Browsing counts** (`sources/le_browsing.csv`, `node server/bigquery.js --browsing`): sessions
  and page views per channel × day × release, counted inside BigQuery with the same incremental
  merge as the export. The only definitions in them are "a session is a `session_start` event, a
  page view a `page_view` event" (§2.2), no identifier is read, and they are the only rows too
  many to bring here (7.4M since 2023 for two numbers per channel-day).
- **Everything with a definition in it** - every entry, eligibility, winner, unit and route column -
  is computed in Python from `sources/le_events.csv` with the §2.2 definitions, where it can be
  read, versioned and tested. One refinement found by the reconciliation:
  `Preorder_App_Eligible_No_Conv` keeps winners in (eligible pre-order entrants with no purchase),
  because a pre-order winner converts by itself.
- **Output** `sources/across_time.rebuilt.csv`: the export's 34 columns at the export's grain, dates
  DD/MM/YYYY, so `build.py` reads either file unchanged. **The build reads the rebuilt file**;
  `FUNNEL_SOURCE=export` makes it read the export instead. The script never overwrites the export.
- **Reconciliation** `data/app/reconciliation.json` (printed on every run): rebuilt against export
  per column over the shared window, the last day excluded because it is still filling. Tolerances
  are the known residuals: 0.2% on sessions and page views (attribution noise between the two
  table builds - 0.09% of page views, spread thinly over the whole history, and the two tables are
  not always built from the same attribution run), 0.6% on counts of people (rows without an
  account id), 0.2% on units, 2% on the routes (the private room lands about 1% low, which no
  precedence order removes). Result on 2026-09-10 over 393,868 channel-days: within tolerance on
  all 26 metric columns; 20 of them within 0.05%.
- **`data/app/release_people.csv`**: per release, unique entrants, eligible entrants, winners and
  buyers; entrants and buyers who had bought (or entered a draw) before the campaign started;
  first-time buyers; and how many entrants and buyers had entered or bought one of the same
  artist's previous releases. Counts only, no identifier. A campaign's start is the upstream
  announcement date where the events carry one, else the first entry or purchase.

Known, harmless differences between the two files: the events carry two release names the
export filters out upstream (a 2027 and a 2021 catalogue entry), and `days_until_launch` runs
one day higher in the export on 2% of release-days (the countdown discrepancy already noted in
§11b - the build uses the announce-based columns, which agree on all but 26 of 180,805
release-days). The export's fan-out pairs (§6.1) carry two clock values, and `load_across_time`
used to keep whichever sub-record came first in the file, an order the two files do not share;
it now keeps the busier sub-record, the same choice from either file. With that, a build on the
rebuilt file against a build on the export (2026-09-10): the same 24-release curve panel, session
and entry curves within 0.001 and 0.009 at any grid point, unit curves within 0.04 (the
booking-day residual around allocation), and release-level numbers differing only by a few
sessions of catalogue trickle on 11 old releases.

**Source of truth.** The rebuilt file is the build's default source (since 2026-09-10);
`FUNNEL_SOURCE=export` in the service's environment switches back to the upstream export. The
build falls back to the export, and says so, when the rebuilt file is missing or more than a day
older than the export (the aggregation has been failing), so the dashboard can never freeze on a
stale copy. The export pull stays on for the reconciliation.
The aggregation peaks at about 330 MB (the events read in chunks, signups dropped, the export
folded chunk by chunk for the reconciliation), against the build's 200 MB, so it fits the 512 MB
instance the same way the build does; `AGG_PROFILE=1` prints the peak after each stage.

- **Campaign clock filled in** (§1.5): 33 releases carry upstream dates, 86 get inferred ones
  (one mixed: Cattelan Window's upstream close precedes its announce and is inferred instead),
  244 catalogue names none. The curve panel grows from 24 campaigns to **96**.

Two feeds now describe the same thing: the rebuilt file is what the dashboard reads, the export
is the reference the reconciliation checks it against on every refresh.

### Draw entries export (per-draw CSV)
One row per entrant per draw (unique on Account ID within a draw). Semantics (pinned down
empirically on the Mondrian and James Jean Blossom draws):

| Column | Meaning |
|---|---|
| `Tier` / `Score` | collector tier (Prospect/Potential/Premium/Patron) and **draw weighting score** (Patron mean ≈ 6.5 vs overall median 2) |
| `Framed` | wants framing (feeds the 0.35 framing-conversion assumption) |
| `MaxQuantity` | max units the entrant will take; **`N/A` = uncapped** (takes everything entered) |
| `Remaining Eligible Entries` | product list the entry is **currently still eligible to win** (equals entered set pre-draw; shrinks during allocation) |
| `Opportunity Cost` | `max(n_products_entered − MaxQuantity, 0)` computed at entry time (can go stale after edits) = the allocator's slack |
| `PreOrder` | pre-order/auto-purchase commitment flag |
| `Winner` / `Claimed` / `KYC Completed` | allocation outcome (all "No" in pre-draw snapshots) |
| `Shopify Draft Order ID` | assigned at **entry** time (pre-auth) - not a win signal |
| `Exclusion` / `Removal` / `Processing Error` | eligibility: eligible ⇔ all three empty |

**Units demanded** (the number to show against edition size):
`wanted_units(entrant) = min(n_products_entered, MaxQuantity if numeric else n_products_entered)`;
`demand(product) = Σ entrants eligible for product` (a lower bound per product);
`total_units_demanded = Σ wanted_units`.

**Allocation rule** (as practised): winners are allocated to maximise sell-through across
products - an entrant who entered N products but wants M < N is awarded the M **least-demanded**
products among those they entered, draw weighted by `Score`. Equivalent to capacitated matching;
`Σ Opportunity Cost` measures the flexibility available.

---

## 3. The LE target model - quartile levers (the "By channel" fallback)

This reproduces the LE_Template TARGET SETTING block exactly. All benchmarks are quartiles of
the historical release panel (§4).

**This is no longer the default.** A release with a benchmark basket takes the basket model of
§4a (`targeting_mode = "benchmark"`, the `Evenly` side of the Target setting switch), where the
edition is split by what comparable launches actually did rather than by a quartile pick per
channel. The quartile levers below are the other side of that switch - `By channel`,
`targeting_mode = "levers"` - and run **unchanged** for any release without a basket, which is
every release until one is chosen and every release whose panel row is missing. Steps 1-6 are
therefore still live code, not history; §4a describes what replaces them and what it keeps.

### Step 1 - split edition into paid vs organic
```
paid_pct      = benchmark("paid share of units", size_pick)      # Low .0789 / Medium .2619 / High .3901
paid_units    = round(edition_size × paid_pct)
organic_units = edition_size − paid_units
```
`size_pick` ("Paid channel size" Small→Low / Medium / Large→High) is a per-release judgement call.
A release can instead carry `paid_share_override` (a fraction of units) - the workbook's "Paid
(% Total)" overwrite on row 137 of the LE tab - which replaces `paid_pct` outright. Warhol's tab
sets 0.66 (1,610 of 2,440 units paid, budget £284,970); the High quartile alone would give 890.
Live releases use Medium (Glenn Ligon, Schnabel) or High (Dali, Mondrian, Zeng Fanzhi, Parra,
James Jean, Abdulnasser).

### Step 2 - split organic into Draw/Pre-order vs Private-Room/Other
```
pr_other_pct = benchmark("PV+Other share of units", reference_point)   # Low .2879 / Medium .4667 / High .7115
pr_units     = organic_units × pr_other_pct
draw_units   = organic_units − pr_units
```
Every live release uses Medium (0.4667). Overridable per release (never used so far).

### Step 3 - channel targets for draw/pre-order purchases
Each of the 12 organic channels gets a **quality pick** (High/Medium/Low = which quartile of the
historical distribution to use; N/A = channel doesn't exist for this release, e.g. Referral
Artist for an estate). The default row used by every live release:
`AA Email Auto: High, AA Email Man: High, AA Meta: Medium, AA Other: Medium, AA X: Low,
Direct: Medium, Organic Search: Medium, Other: Medium, Referral Artist: Medium (N/A for estates,
High for hype artists), Referral Meta: Medium, Referral Other: N/A, Referral X: N/A`.

```
share(c)            = benchmark("order split", c, quality(c))          # §4 table A
order_split(c)      = share(c) / Σ share                               # renormalised over non-N/A channels
target_purchases(c) = draw_units × order_split(c)
```

### Step 4 - back out entries and sessions per channel
```
target_eligible_entries(c) = target_purchases(c) / 0.8            # 0.8 = eligible-entry → order rate ("1 − drop-off")
conv(c)                    = benchmark("session → eligible entry", c, quality(c))   # §4 table B
target_sessions(c)         = target_eligible_entries(c) / conv(c)
```

Private-room sessions are modelled separately, email-only:
`target_pr_sessions = pr_units / email_session_to_purchase` where
`email_session_to_purchase = 0.010727` (median AA Email Man session→purchase across the panel; v2 recompute).

### Step 5 - paid targets and budget
```
paid_eligible_entries = paid_units / 0.8
paid_conv             = benchmark("session → eligible entry", Paid Social, quality_pick)  # Medium = 0.0042099 on all live releases
target_paid_sessions  = paid_eligible_entries / paid_conv
cost_per_purchase     = CPP benchmark pick                        # Low 128.75 / Median 177 / High 291
paid_budget           = cost_per_purchase × paid_units
```
Sense check: `paid_budget / launch_value ≤ 6%` (flag only - 4 of 8 live releases breach it:
Dali & Mondrian 13.8%, Parra 10.6%, James Jean 9.9%).

### Step 6 - buffer
`target_inc_buffer = 0.75 × target` for any metric ("Target inc. buffer") - a 25% haircut used
as the amber line on charts.

### Worked example (Glenn Ligon · Multiple · 2026 Q3)
150 units → paid 39 (Medium 26.19%), organic 111 → PR/Other 51.8 (46.67%), draw 59.2 →
AA Email Man target purchases 26.2, entries 32.8, sessions 1,885 … total organic-draw sessions
3,953; PR sessions 4,558; paid sessions 11,580; budget = 177 × 39 = £6,903.

---

## 4. Benchmarks (how the reference numbers are computed)

Panel: all releases in the funnel import **not** marked excluded on `Release Selection`
(intended rule: exclude pre-2024 + manual exclusions; currently 142 included - see §11 for the
leaks). For each per-release ratio, zero values are blanked (survivorship: benchmark conditions
on the channel having converted at least once).

**"Quality"/"size" = which quartile you pick, not an attribute of the release:**
`Low = 25th percentile, Medium = median (order-split & session-conv tables) or mean (PV-conv and
EE→order tables - inconsistent, see §11), High = 75th percentile.`

Key benchmark values in force (LE):

**A. Order split by channel** (share of unadjusted draw+pre-order units; renormalised at use):

| Channel | Low | Medium | High |
|---|---|---|---|
| AA Email Auto | .0128 | .0224 | .0790 |
| AA Email Man | .1941 | .3054 | .4383 |
| AA Meta | .0407 | .0629 | .1216 |
| AA Other | .0045 | .0077 | .0096 |
| AA X | .0127 | .0588 | .1667 |
| Direct | .1227 | .1667 | .2100 |
| Organic Search | .0476 | .0761 | .1146 |
| Other | .0075 | .0141 | .0228 |
| Paid Social (= paid % of units) | .0789 | .2619 | .3901 |
| Referral Artist | .0622 | .1053 | .2308 |
| Referral Meta | .0095 | .0263 | .0717 |
| Referral Other | .0146 | .0291 | .0499 |
| Referral X | .1397 | .2500 | .3636 |

**B. Session → unique eligible entry** (unadjusted sessions denominator):

| Channel | Low | Medium | High |
|---|---|---|---|
| AA Email Auto | .0062 | .0474 | .3039 |
| AA Email Man | .0067 | .0105 | .0174 |
| AA Meta | .0093 | .0140 | .0258 |
| AA Other | .0396 | .0714 | .1607 |
| AA X | .0133 | .0247 | .0354 |
| Direct | .0090 | .0186 | .0301 |
| Organic Search | .0172 | .0306 | .0670 |
| Other | .0138 | .0172 | .0352 |
| Paid Social | .00163 | .00421 | .01213 |
| Referral Artist | .0060 | .0134 | .0238 |
| Referral Meta | .0072 | .0151 | .0357 |
| Referral Other | .0169 | .0322 | .0667 |
| Referral X | .0093 | .0302 | .0345 |

**C. Unit-mix quartiles** (share of adjusted total units): PV+Other = .2879 / .4667 / .7115;
Draws .1734/.3203/.6939; Preorder .0528/.4758/.6353.

**D. Eligible entry → order** ("drop-off" complement): benchmark table exists
(total .43/.66/.90, capped at 1) but the model **assumes a flat 0.8** everywhere (hardcoded).
Keep 0.8 as the planning constant; surface the per-channel table as diagnostics.

**E. Cost per purchase (paid)**: quartiles over 22 hand-curated historical paid campaigns
(mixing LE + TL): **Low £128.75 / Median £177 / High £291**. Companion stats (static): ROI
2.2/3.4/6.9, paid % of units .11/.21/.31.

**F. Email-only session → purchase** (private room divisor): median .010727 (v2).

Recomputation policy for the rebuild: recompute quartiles nightly from BigQuery over a
**correctly filtered panel** (year ≥ 2024, exclude undersubscribed: oversubscription ≤ 10 units,
exclude in-flight releases), using **median for every "Medium"**. Log benchmark drift vs the
frozen values above.

**Baskets of comparables** (`etl/analysis/release_clusters.py`, findings in
`docs/RELEASE_CLUSTERS.md`): the 108 completed draw campaigns in the 2023-2026 BigQuery pull
fall into two robust kinds (paid-led vs organic) and four defensible ones (paid-led headline
launches, paid-supported small editions, email-led collector launches with a private room,
artist-audience draws); the 47 buy-now launches that predate the draw mechanic are a fifth,
legacy basket. Per-basket quartiles of every channel share, conversion and campaign-stage
share are written to `data/release_cluster_baskets.json`, assignments to
`data/release_clusters.csv`. Campaign windows for releases without the upstream clock (every
launch before 2026) are inferred from the funnel - announce from the first run of draw-entry
days, close from the draw-allocation day - and validated against the clocked releases
(announce within 2 days on 31 of 32, close exact on 24 of 27).

---

## 4a. Baskets, the benchmark and the even uplift (the default target model)

The implementation contract is `docs/BENCHMARK_SPEC.md`; where this section and that file
disagree, **the spec wins**. What follows is the model in the terms of this document.

The quartile model of §3 answers "what share of units should email carry if we pick the good
quartile?" - a question about the panel, not about this launch. The benchmark model answers the
question the launch meeting actually asks: **what do launches like this one reach, and how much
more are we asking for?** Everything below falls out of that one sentence.

### 4a.1 The three references

| | what it is | drawn as |
|---|---|---|
| **Benchmark** | what launches in the matched basket typically reach: the **median** of that basket, per metric and per channel | solid cobalt `#2b5fd9` line, 2px |
| **Target** | benchmark × K, the business target | solid ink `#141413` line, 2px |
| **Stretch** | target − benchmark = benchmark × (K − 1) | a number; a grey hatched bar on the waterfall only |

```
K = edition_size / benchmark_units_total
```

K is **one even uplift**, applied to every volume (sessions, entries, units, spend), in every
channel, at every funnel stage and on every day of the campaign. **Conversion rates are held at
the benchmark**: the plan is "the same launch, bigger", never "the same launch converting
better". Both reference lines are drawn identically - same width, same length - so that colour
and label are the only difference between them (spec §1, §7).

### 4a.2 The basket layer (`etl/baskets.py`)

The panel is `data/release_clusters.csv` filtered to `panel == "draw"` (108 completed draw
campaigns, §4 "Baskets of comparables"); cluster names come from
`data/release_cluster_baskets.json`. Six ready-made baskets: `cluster_0` Paid-led headline
launches, `cluster_1` Paid-supported small editions, `cluster_2` Email-led collector launches,
`cluster_3` Artist-audience draws, `all_12m` (every draw launch whose `window_end` is within 365
days of `as_of`), and `same_artist` (the same artist's earlier launches, disabled under 3
members). A **bespoke** basket is a hand-ticked set of panel releases; one saved from the picker
is written to `data/app/baskets.json` and thereafter offered alongside the ready-made ones.

Two rules carry the weight, and both are in the module because three callers - the ETL, the
picker API and the re-run a saved basket triggers - have to agree to the last unit:

- **A release is never a member of its own benchmark.** Its own `release_name` is dropped from
  every basket before the medians are taken. Left in, a launch grades itself, and on a small
  cluster it drags the median towards its own result.
- **Per-channel benchmark = median share × median total**, never the median of the per-channel
  column. A basket's per-channel medians do not sum to its median total (each channel peaks on a
  different launch), so taking them directly leaves the five channel benchmarks summing to
  something other than the headline printed above them. Shares are renormalised to sum to 1.

Sizes: under **3** members a basket cannot be used at all and the caller falls back to the
suggested one; under **10** it is used but carries `basket.thin = True`, which the picker shows
as a warning. A median over an empty or all-NaN column is `0.0`, never NaN.

The profile is the medians themselves: `n` and `members`; `units` (median
`tot_total_product_units`) with `units_p25` / `units_p75`; `sessions` (median
`tot_sessions_total`); `entries` (median `tot_draw_entries_eligible_units`); `campaign_days`;
`private_room_share`; `share_units` and `share_sessions` per display group; `conv` (median
`conv_sess_entry_<group>`, 0 where there is no history); and the two products
`units_by_group` = `share_units[g] × units` and `sessions_by_group` = `share_sessions[g] ×
sessions`. Groups are the five display groups of §1.3.

`suggest_basket` picks the basket a release starts on: its own `cluster` if the panel has it,
else `nearest_cluster`, else the cluster whose median units are closest to the edition size **in
log space** (the panel runs from tens of units to thousands, so a linear gap would put
everything in the big basket), tie-broken on paid-session share against the release's paid plan.
The suggestion is a starting point and is always overridable - `suggestedId` rides on the
snapshot next to the chosen `id` so the card can say which one was picked for you.

### 4a.3 Target maths (`etl/build.py`)

With a basket in hand, `targeting_mode` is `"benchmark"` and the launch total is divided by what
the basket did, not by a quartile pick:

```
K            = edition_size / profile["units"]
units[g]     = profile["units_by_group"][g]    × K        # sums to edition_size exactly
sessions[g]  = profile["sessions_by_group"][g] × K
entries[g]   = units[g] / 0.8                             # the eligible-entry → order rate, §3 step 4
paid_budget  = profile["units_by_group"]["paid"] × cost_per_purchase("Median") × K
```

`compute_targets` returns the **same top-level keys** in either mode, so nothing downstream
branches on the model: `edition_size`, `paid_pct`, `paid_units`, `organic_units`, `pr_other_pct`,
`pr_units`, `draw_units`, `per_channel`, `pr_sessions`, `paid{…}`, `launch_value`,
`organic_sessions_draw`, `total_sessions`, `entries_target`, `buffer`. The private room keeps the
§6.3½ convention - `pr_units = units["aa_email"] × profile["private_room_share"]`, draw units are
the rest of organic - and `group_targets` still sums to the edition size exactly.

The 12-channel `per_channel` table (§3 step 3) is **synthesised** rather than abandoned: each
group's target is split across its raw channels with the `order_split` medians of
`etl/benchmarks.json`, renormalised inside the group. It carries the keys it always did
(`quality`, `order_split`, `purchases`, `eligible_entries`, `sessions`, `session_to_entry`), with
`quality = "benchmark"` marking where the level came from. So the channel-level cards, the funnel
diagnostics and the untracked-redistribution comparisons of §6.2 all keep working untouched.

### 4a.4 The K ratio holds on every day

The daily plan is the benchmark's own shape, scaled once:

```
benchmark_plan[g][d] = profile["units_by_group"][g] × curve(basket, g, "units", pdsa(d))
target_plan[g][d]    = benchmark_plan[g][d] × K
```

Target and benchmark therefore stand in exactly the ratio K at **every** point of the campaign,
not only at close - which is what makes the even uplift legible on the trajectory: the gap
between the two lines is the stretch, widening with the curve, never crossing and never
converging. The same identity is what the snapshot asserts: `hero.benchmarkToday × K ==
hero.expectedToday` and `channels[].bmExp × K == channels[].exp`, to within rounding. If those
ever disagree, the curve was evaluated twice with different members, not the maths.

---

## 5. Targets across time (the new capability)

The sheet distributes nothing over days (its only daily notion is a run-rate: remaining units ÷
remaining days). The across-time columns enable proper **plan curves** - the design brief
requires `expectedToday(channel)` from "channel-shaped curves, never straight lines".

### 5.1 Method
1. Take completed, clean LE campaigns (campaign window fully observed, ≥ 20 draw entries;
   currently n = 18 from the export - grows over time).
2. For each, compute cumulative share of the campaign's final total at each pdsa, per metric
   (sessions, draw entries, units) - and per channel where volume allows.
3. Pool across releases on the pdsa axis: **median = the target trajectory; p25/p75 = guardrail
   band**.
4. A release's daily plan = `target_total(metric, channel) × curve(pdsa of that day)`.
   `expectedToday = target_total × curve(pdsa_today)`.

### 5.2 The pooled LE curve (v1, from the current export, n=18)

Cumulative share of campaign total at pdsa ≤ t (median across releases):

| pdsa ≤ | Sessions | Draw entries | Units |
|---|---|---|---|
| <0 (Early access) | .072 | .000 | .134 |
| 0.1 | .243 | .272 | .277 |
| 0.2 | .361 | .400 | .407 |
| 0.3 | .446 | .519 | .525 |
| 0.4 | .536 | .555 | .585 |
| 0.5 | .558 | .652 | .597 |
| 0.6 | .618 | .707 | .640 |
| 0.7 | .662 | .734 | .691 |
| 0.8 | .724 | .794 | .718 |
| 0.9 | .832 | .831 | .737 |
| 1.0 | .998 | 1.000 | 1.000 |
| incl. Last chance | 1.000 | 1.000 | 1.000 |

Shape facts the dashboard should encode:
- **Announcement burst**: ~24% of sessions / ~27% of entries land in the first 10% of the campaign.
- **Launch cliff**: the final decile carries ~17% of sessions and ~26–30% of units - daily
  pacing must be piecewise, never linear.
- **Early access**: ~7% of sessions, ~0 draw entries (draws open at announcement), but ~13% of
  units - 79% of Private-Room units transact pre-announcement. Private-room targets should be
  phased into EA, draw targets should not start before pdsa = 0.
- Stage split of totals (pooled): sessions EA .11 / S1 .32 / S2 .17 / S3 .36 / LC .04;
  units .17 / .28 / .16 / .25 / .13.
- Dispersion is wide (sessions p25–p75 at mid-campaign: .41–.81) - always show the band, and
  status vs plan should use the band, not the median alone, before shouting red.

### 5.3 Per-channel curves
Email is spike-driven (sends), socials are post-driven, search/direct is smooth. v1 ships:
pooled per-display-group curves where n permits, else the all-channel curve. The email plan
curve should eventually be derived from the **planned send schedule** (Announcement, Early
Access 1–3, Sustain, Last Chance 48/24h - the taxonomy in §8) rather than history alone.

**Paid units plan uses the entries shape.** Historical `Total_Product_Units` for the paid
group books ~98.6% of draw units on the draw-close date (winners are allocated then), so a
units-shaped plan cliffs ~46% of the paid target onto the final day while the plotted
actual (secured units, §6.3½) accrues entry-timed - the plan would read "behind" all
campaign and "catch up" in one fictional day. `build_curves` therefore substitutes the paid
group's entries curve for its units curve (final step 0.21 instead of 0.46 - the genuine
last-chance surge remains). Verified 2026-08-28: dropping each historical release's close
day removes the units-curve jump entirely, proving it is allocation bookkeeping, not
last-day demand; a historical secured-units curve is NOT reconstructable because the export
retroactively reclassifies converted entries out of `*_No_Conv`.

**Curves are tier-blind, and that is deliberate.** A channel's quality pick sets its
LEVEL (which quartile of the share panel it plans for) but every release shares one pooled
median SHAPE per display group. Tested 2026-08-29 with `etl/analysis/tier_curve_probe.py`:
split the clean panel in half by each group's realised share, difference each group's curve
against that release's own all-channel curve (so a release that simply ran early does not
read as a tier effect in all five of its groups), then permutation-test the gap. Across 11
testable group x metric combinations **nothing survives Benjamini-Hochberg FDR at 5%** -
closest is search/direct/other sessions at p=0.011 against a 0.0045 threshold. Paid is the
one coherent pattern (the three most suggestive results after search/direct/other, gaps of
17-21 pts) and the one with real stakes: cohorted paid curves would move Dali's expected
paid units today from 7.0 to 60.3, the difference between "on plan" and "far behind". High
stakes on a coin flip, so the pooled curve stands. Two channel groups (AA Meta, Referral
Artist) cannot be tested at all - only 5 of 15 releases carry >= 10 units in them. Re-run
the probe at ~25-30 clean releases.

**Re-read on the 96-campaign panel (2026-09-10, inferred clock, §1.5).** With every completed
draw campaign since 2023 on the clock, the shapes do differ by kind of release (the baskets of
`docs/RELEASE_CLUSTERS.md`), and mostly on sessions and units, not entries. Cumulative share at
the announce day / 30% / 50% / 90% of the campaign, all-channel medians:

| Panel | n | Sessions | Entries | Units |
|---|---|---|---|---|
| Pooled | 95 | .15 / .53 / .70 / .89 | .12 / .51 / .65 / .86 | .16 / .39 / .51 / .68 |
| Paid-led | 41 | .14 / .40 / .56 / .89 | .14 / .49 / .65 / .87 | .18 / .44 / .53 / .72 |
| Organic | 52 | .23 / .63 / .75 / .89 | .09 / .51 / .65 / .86 | .13 / .35 / .46 / .57 |
| Email-led private room | 31 | .41 / .71 / .77 / .91 | .23 / .57 / .68 / .86 | .28 / .51 / .59 / .72 |
| Artist-audience draws | 20 | .03 / .48 / .69 / .85 | .03 / .45 / .63 / .86 | .01 / .15 / .25 / .37 |

Largest gap from the pooled curve anywhere in the campaign: sessions 0.19 (paid-led) and 0.30
(email-led), units 0.31 (artist-audience: 60% of its units book at the close), entries only
0.03-0.14. So the entries curve the hero and trajectory run on can stay pooled; the sessions
and units curves should be cohorted, at least paid-led against organic. What is still open is how
a release gets its basket in the dashboard - the paid channel size pick on the Target setting tab
separates paid-led from organic, the private-room share pick separates the two organic kinds -
which is a product decision before the curves can be cohorted in the build.

**The panel is now per basket, with the pooled curve behind it.** The open question closed the
way §5.3's re-read pointed: a release's curves come from **its own basket's members**, not from
the whole panel, and the basket is a product decision made in the picker (§4a.2) rather than
inferred from the paid-size lever. `build_curves(at, members=None)` takes the member filter;
with no filter it builds the pooled panel curve exactly as before, so every release without a
basket is unaffected. Fallback is per metric and per group, not per release: where **fewer than
4** members qualify for a series `build_curves` already returns `None` for it and `curve_value`
drops to the pooled curve for that series alone - a thin basket can be cohorted on units and
pooled on entries at the same time. Curves are cached per basket id for the run, since the
picker, the snapshot and the re-run all ask for the same ones. Entries curves differ least
between baskets (0.03-0.14 from pooled, above), so in practice it is the sessions and units
shapes that move.

### 5.4 Forward projection of entries
Projections describe the **current trajectory**; the paid-spend recommendation is the
intervention shown alongside, never baked into the projection.

**Organic channels** - the remaining volume follows the channel's *historic shape curve*;
its level scales with demonstrated performance, trusted in proportion to how much of the
campaign the curve says has been observed:
```
w        = curve_channel(pdsa_today)                 # share of campaign observed
r        = clamp(actual / expected, 0.25, 2.5)       # demonstrated performance
proj     = actual + target × (1 − w) × (1 + w × (r − 1))
path(d)  = actual + (proj − actual) × (curve(pdsa_d) − w) / (1 − w)   # shaped, not linear
```
Early in a campaign (w small) the future is the plan; late, it scales with what the channel
has actually delivered.

**Paid** - projection = **projected spend ÷ projected efficiency**, day by day:
```
spend_fwd(d) = current daily spend run-rate            # not the recommendation
cpe_fwd(d)   = trailing-3-day CPE × Π (1 + drift)      # drift 5%/7%/10%/day by window third
entries_fwd  = Σ spend_fwd(d) / cpe_fwd(d)
```
Fallback when no spend history exists yet: paid target × remaining share of the paid curve.
Projected *purchases* from any projected entries convert at the 0.8 eligible-entry→order rate.

---

## 6. Actuals and live status

### 6.1 Daily actuals (grain: channel × day × release)
From the daily funnel feed: sessions (`Sessions_Total`), page views, draw entries,
`Draw_Entries_Eligible_Units` (AC - the "eligible entries" actual),
`Draw_Entries_Total_Units_No_Conv` (AB - eligible entered units not yet converted),
`Total_Product_Units` (U - units sold), customer/unit splits by route (Draw / Preorder App /
Private Room / Presale Offered / Other).

⚠ The raw daily export can contain **two sub-records per (channel, day, release)** (two
campaign-date records with launch timestamps ~1 day apart); metrics are split across the pair -
**sum them**, never de-duplicate.

### 6.2 Launch-to-date actuals vs target
- Sessions/purchases per channel: SUMIFS over the lifetime rollup, then **redistribute Untracked
  pro-rata** across tracked channels.
- **Projected purchases ("Actual" on the purchases chart)** =
  `confirmed_purchases + 0.8 × eligible_entries_not_yet_converted`.
- `% sellout = projected_purchases / target_purchases` (release-level: vs edition size).
- Conversion actual = projected purchases ÷ sessions, compared to the target conversion.

### 6.3½ Secured units - the unified page currency
The hero, trajectory, and channels modules run on one unified metric of sales plus
entries:
```
secured units = units sold (all routes, incl. private room)
              + 0.8 × eligible entry units NOT yet converted
```
Only *unconverted* entries carry the 0.8 discount (a converted entry is already a sale -
counting all entries would double-count). Group unit targets sum exactly to the edition
size, so the hero target = sellout (private-room units ride with the AA Email group, the
workbook's own convention). The hero is **capped at edition size**; entries beyond the
units left to sell are shown as an oversubscription signal, not as bar overshoot.
Funnel diagnostics and the paid module stay denominated in entries/spend - the things
marketing moves directly.

### 6.3 Sell-through prediction (per product - LE)
From draw data + orders:
`sold` (units sold to date) + `sold_predicted` (eligible entries in hand × 0.8, allocated per
product by the demand model) + `future_entries_predicted` (remaining plan curve × conversion).
Segments must sum to ≤ edition; total sell-through % = Σ over products / Σ editions.

---

## 7. Paid: in-flight model (the Paid Calculator, reproduced exactly)

Per release, daily grain. Spend actuals = Meta `spend` for `campaign_name` (ad-set key B2);
entry actuals = daily funnel `Draw_Entries_Eligible_Units` filtered to **channel = Paid Social**.

```
drop_off        = 0.2
cannibalisation = 0.2      # LE standard (spend rules); ignore per-tab cells showing 0 (issue 14)
CPE(window)     = spend / entries over the trailing 3 CALENDAR days (dashboard
                  headline + chart line; a window with spend and 0 entries shows
                  ROI 0 and an unknown CPE)
adjCPE(day)     = spend(day) / (entries(day) × (1 − drop_off))          # cost per expected-converting unit
ROI_party(day)  = (1 − cannibalisation) × profit_per_unit_party / (adjCPE × budget_share_party)
cum versions    = same on Σ spend / Σ entries
```
`budget_share` = who pays for ads (AA/artist), e.g. 100/0 (Glenn Ligon), 33/66 (Jaume Plensa);
distinct from `profit_share`.

**Budget to sell out** (the sizing decision). The workbook nets off a manual
`organic_topup` estimate; the dashboard automates it with the shape-following
organic projection (§5.4), so paid is sized to top up only the gap organic is
not on course to fill:
```
secured_now      = units_sold_total + 0.8 × entries_banked    # all channels
organic_future   = Σ over organic groups of (proj − now)      # §5.4 projection
sellout_gap      = max(edition_size − secured_now − organic_future, 0)
entries_needed   = sellout_gap × (1 + drop_off)
forecast_CPE     = trailing_3day_adjCPE × 1.5                 # 1.5 = assumed CPE deterioration to launch
budget_to_sellout= entries_needed × forecast_CPE
daily_spend      = budget_to_sellout / days_until_launch
ROI_check_party  = profit_per_unit_party / (forecast_CPE × budget_share_party)
```
A launch pacing well ahead organically reads a recommendation of £0/day -
nothing extra is needed to secure sell-out, whatever the current ROI.

**Pacing rules** (v1 rules engine; target and thresholds):
- Target ROI (AA) = **1.1** (last-day forecast).
- Daily direction: cum-ROI < 0.9 → Decrease; 0.9–1.3 → Maintain; > 1.3 → Increase.
- Daily spend change capped at **±30%**; changes ≤ 10% are ignored (0%).
- Downside protection: forecast ROI < 1.1 for **3 consecutive days → forced Decrease**.
- Spend-per-unit is expected to deteriorate 5% / 7% / 10% per day across the first/second/final
  third of the window (feeds the forecast when no fresh actuals).

This maps 1:1 onto the design's Paid module contract:
`roiDeclineModel = { start: today's actual ROI, dailyFactor }` (dailyFactor ≈ 1/(1+tier drift));
`recommended = min(spend at ROI floor, spend at supply cap)`, `cap ∈ {roi_floor, supply}` -
supply cap = the budget-to-sell-out logic (spending beyond it buys entries exceeding the units
left); ROI floor = 1.0/1.1 last-day forecast rule.

---

## 8. Email & social (funnel diagnostics layer)

### Email (Klaviyo)
Send-level: `Email Name`, send datetime, `Campaign` (join key), Delivered, Opened, Clicked,
Unsubscribed. Name convention `DDMMYY_TYPE_Campaign - Description (variant)`;
types: `GEN` full-list broadcast, `CUS` segmented send (incl. `Early Access (LE) 1/2/3` tiers),
`INS` insiders/VIP, `TRNS` transactional post-purchase, `AUT` automated flows, `FREQ` frequency
tests. Launch playbook sequence: Announcement → Early Access (1/2/3 + Insiders) → Sustain /
Deepdive / Halfway / Clue n → Last Chance 48h → 24h → post-close surveys → TRNS production chain.
Reference rates for the funnel module: use the release's own campaign sends vs the historical
median for the same send type. ⚠ Bundle sends (`FREQ_LE_Bundle`) promote 2–3 releases and cannot
be attributed to one release.

### Social content (Emplifi)
Post/story-level per platform (instagram 90%, twitter/X since 2025-08). Join via Labels →
campaign code. Useful metrics: impressions, reach, engagements (+ rates, verified =
engagements/impressions and /reach), saves (posts), story views/exits/taps/completion, video
views. Two owned profiles (Avant Arte ~2.9M followers; Avant Insiders ~74k) - normalise
per-1000-followers separately. Funnel-module rungs "Posts" and "Sessions/post" = count of posts
for the campaign in the window; sessions from the funnel feed ÷ posts.

---

## 9. Dashboard metric map (module → formula)

Per the design handoff (README + artboards; the mock's reconciliation rules are requirements):

| Module | Number | Formula (this doc) |
|---|---|---|
| Hero "Entries vs targets" | to date | Σ channels cumulative eligible entries (LE currency) |
| | expected today | Σ channels `target_total × curve(pdsa_today)` (§5) |
| | delta | actual − expected (must equal Σ channel gaps = Σ funnel contributions) |
| | projected at close | §5.4: organic follows the channel's historic shape curve scaled by demonstrated performance; paid = projected spend ÷ projected efficiency. Stored on the day's snapshot (never re-derived client-side) |
| | target | §3 channel targets summed |
| Sidebar status | on-pace % | `heroDelta / expectedToday(total)` |
| Trajectory | plan line | per-channel plan curve × target (§5) |
| | actual line | daily cumulative actuals |
| | projection | linear from today's actual to projected-at-close |
| Channels vs targets | per group | now / expected / projected / target per display group (§1.3) |
| Funnel by channel | rungs | email: Delivered/Open/Click vs reference; social: posts, sessions/post; all: session → entry vs benchmark (§4B); paid: spend & cost/entry vs plan |
| | contribution | units vs expected, repriced one-at-a-time; per-channel contributions sum to that channel's gap |
| Key drivers | top movers | rank funnel steps by |contribution|, Adding vs Costing |
| Paid ROI | series | §7 daily ROI (AA); decline model start = today's ROI |
| Paid spend/day | recommended | §7: min(ROI-floor spend, supply-cap spend), `cap` recorded; Implement → append-only decision log |
| Sell-through | segments | §6.3 (LE: sold / sold-predicted / future-entries-predicted) |
| Entries by country | top 5 | geo split of entries (requires country dim in the daily feed - **currently missing; needs adding to the BigQuery export**) |
| Projection vs target | waterfall | stored model outputs: Organic traffic / Organic conversion / Paid spend / Paid efficiency contributions summing exactly to projection − target |

LE benchmark fields carried on the release document: `chargeDropOff = 0.2`,
`signupToOrderRate` (TL), `firstChoiceWinRate` / `steeredBackupWinRate` (from draw allocation
data), `reOfferRecovery`.

---

## 10. Proposed warehouse shape (for the production build)

```
dim_release(release_name PK, campaign_code, type LE|TL, artist, announce_date,
            private_room_open, launch_end, campaign_length_days, edition_size, unit_price,
            economics…, model_picks {paid_size, reference_point, cpp_pick, quality_by_channel})
dim_product(release_name FK, product_name, edition)
fact_funnel_daily(release_name, channel, event_date, sessions, page_views, draw_entries,
            eligible_entry_units, eligible_units_no_conv, units_total, units_by_route…,
            campaign_stage, dsa, dul, pdsa, pdul)         -- sum over source fan-out on load
fact_spend_daily(campaign_name, spend_date, spend, impressions, reach, link_clicks)
fact_email_sends(campaign_code, send_ts, email_type, description, delivered, opened, clicked, unsub)
fact_content(campaign_code, platform, content_type, published_ts, impressions, reach,
            engagements, saves, story_metrics…)
fact_draw_entries(draw_id, release_name, account_hash, tier, score, products[], max_quantity,
            wanted_units, framed, preorder, winner, claimed, eligible)   -- PII stripped
bench_channel(metric, channel, low, medium, high, n, as_of)              -- recomputed nightly
curve_trajectory(metric, channel_group|all, pdsa_decile, median, p25, p75, n, as_of)
snap_release_day(release_name, date, targets…, expected_today…, projections…, paid_reco…,
            waterfall contributions…)                     -- the document the UI reads (§9)
```

The UI reads one `snap_release_day` document per release per day (matches the design's "one
store per release, fetched per release+day"; projections are stored, not client-derived).

## 10a. Snapshot fields for the benchmark model

Every field here is **additive** (spec §5). A consumer that does not know them renders exactly as
it did before, and a snapshot written in lever mode simply omits `snap.benchmark` - which is the
guard every cobalt mark on the page is written against.

| Field | What it holds |
|---|---|
| `targetingMode` | `"benchmark"` or `"levers"` - which model §4a/§3 wrote this snapshot |
| `benchmark.basket` | `{id, kind, name, n, thin, suggestedId}`; `kind` is `ready`, `bespoke` or `saved` |
| `benchmark.units`, `unitsP25`, `unitsP75` | the basket's median units and its middle half |
| `benchmark.sessions`, `entries`, `campaignDays` | the other headline medians of the profile |
| `benchmark.k` | the even uplift K |
| `benchmark.stretchUnits`, `stretchPct` | `target − benchmark` in units, and `K − 1` |
| `benchmark.unitsByGroup`, `sessionsByGroup`, `convByGroup` | the per-group medians (conversion is held, so `convByGroup` is both benchmark and target) |
| `benchmark.paidBudget` | benchmark paid units × median cost per purchase × K |
| `hero.benchmark`, `benchmarkToday`, `stretch` | benchmark at close, benchmark pace to today, the stretch |
| `channels[].bm`, `bmExp` | per group: benchmark at close, benchmark by today |
| `channels[].daily[].bm` | the benchmark plan for that day, beside `actual` / `plan` / `proj` |
| `funnelByGroup[g].sessions_benchmark`, `conv_benchmark` | the rung references: a volume and a rate |
| `sellthrough.benchmarkUnits` | the benchmark on the sell-through prediction |
| `paid.benchmarkUnits`, `benchmarkBudget` | the paid module's two benchmark marks |
| `waterfall.benchmark`, `stretch`, `target`, `projection` | the at-close waterfall's left-hand columns; `steps` are unchanged |
| `waterfall.today` | `{benchmark, stretch, target, actual, steps}` - the same four contributors measured **to date** |

`waterfall.today.steps` are not the close steps scaled down: they are the contributions as
measured so far, and they must sum exactly to `actual − target`, with the rounding residual
parked on the largest step, exactly as the close steps do (§9, "Projection vs target").
`hero.benchmarkToday` and `channels[].bmExp` are read off the basket curve at today's pdsa
(§5.3), which is what keeps the K identity of §4a.4 true today as well as at close.

---

## 11. Data-quality register (found during reverse-engineering; fix upstream)

Benchmark-panel integrity:
1. Release Selection's pre-2024 exclusion rule is only partially applied - 21 pre-2024 releases
   still leak into every benchmark; the undersubscription screen (oversubscription ≤ 10 → exclude)
   is #REF!-broken beyond release #73, and the 51 releases it flagged are still in the panel.
2. "Medium" is MEDIAN in some tables and AVERAGE in others (and in two totals rows of the
   session-conv table only); averages make Medium > High for AA X / Referral X page-view conv.
3. The email-only conversion benchmark's range covers only the first 73 alphabetical releases.
4. CPP benchmark = quartiles over 22 hand-curated rows mixing LE and TL, hardcoded to rows
   10–42 - newly appended campaigns never enter it.
5. Survivorship: all per-release ratios blank out zeros before quartiling.

Pipeline integrity:
6. LE daily accumulator truncated at exactly 100k rows (data before 2025-12-20 already lost);
   `Across time.csv` is a 50k-row export cut mid-date. **Fixed** where a BigQuery key is set -
   the feed reads the tables directly (§2); unset, the sheet cap still applies.
7. `Maurizio Cattelan · Window · 2026 Q1` has launch < announcement (negative campaign length) -
   fix the campaign-dates table.
8. 58% of daily rows are `Missing campaign dates` (back catalog without announcement dates).
9. `campaign_id` in Meta exports mangled to float - join on campaign_name.
10. Campaign Mapping sheet's static columns are misaligned against a live UNIQUE spill - do not
    use; the reliable link is each release's (release_name, campaign_name) pair.
11. `untracked` vs `Untracked` case; header typos (`Eligable`, `reachs`).

Model bugs found in the sheet (the rebuild should implement the *intent*):
12. "Spend for tomorrow" is clamped to £2 (`min(spend, 2.0)` where 2.0 is a per-unit step;
    open comment "should this be 669?"). Intended cap: ±30%/max-increase rules.
13. ROI shows positive with 0 entries (division fallback) - rebuild should show 0/–.
14. Template's cannibalisation cell reference is broken (G90 → empty cell); live value 0.2.
15. Paid Performance box keys off a hand-typed "Today's date" that goes stale.
16. AA Other silently missing from chart groupings; template tab is a filled copy of
    GlennLigon_LE_26 (double-counting hazard when aggregating tabs).
17. Cannibalisation is 0.2 in LE/calculators but 0.1 in the TL historical panel - pick one per
    release type and record it on the release document.
18. JaumePlen paid tab sizes budget on edition 300 but profits on edition 100.
19. Two generations of entry-counting in paid trackers (eligible units vs total units) - CPE not
    comparable across generations; standardise on `Draw_Entries_Eligible_Units`.
20. Draw entry exports: `Opportunity Cost` goes stale after entry edits - recompute, don't trust.
21. Campaign-code middle segments are free text, not release types: the content feed tags
    Andy Warhol Estate's 2026 Q3 LE as `AndyWarhol_TL_26`. Never infer LE/TL from a code.
22. `LE_Funnel_Report.processing_error` is free text that quotes the entrant's email address in
    2,074 draw-entry rows; treat every free-text column of that table as potentially carrying
    personal data and take flags, not text (§2.1).
23. The export's `Draw_Entry_Eligible` counts eligible entrants *left without an allocation*, not
    eligible entrants, and shrinks as winners are allocated; `Collectors_Eligible_Entries` is the
    people count and `Draw_Entries_Eligible_Units` the units (§2.2). Check which column the
    workbook's eligible-entry benchmarks read.

---

## 11a. Paid recommendation: elastic price and the pacing rules

`cpe_spend_elasticity` (0.38) is the within-campaign elasticity of cost per entry to daily
spend, fitted on the 13 campaigns where daily Meta spend joins to daily paid entries
(`etl/analysis/cpe_elasticity.py`; 170 campaign-days; campaign fixed effects; a day-drift
term absorbs the time trend, which came out at 0.4%/day ± 1.1 against the workbook's
5/7/10% tiers). Before it, the recommendation priced every extra entry at today's cost per
entry and the ROI floor could never bind (flat price → ROI independent of spend), so a
release a long way from sell-out was told to multiply its daily budget fifty-fold. The
workbook's pacing rules (`spend_rules`: ±30%/day, the 0.9/1.3 cumulative-ROI bands, the
10% dead band, the forced decrease) had been transcribed and documented but never
applied; they are now. The old formula also multiplied eligible entries (grossed up for
drop-off) by the per-converting-unit price (also grossed up), overstating sell-out spend
by ~20%.

Reconciling the chart and the recommendation: the Paid ROI chart's dashed line and the
budget recommendation's ROI floor now share one forward cost path (today's price × spend
elasticity × daily drift, compounded). Two workbook figures described that future - the
5/7/10% daily tiers (LE template row 206, "Expected daily increase") and a flat 1.5× forecast
cost per entry - and the code used one for the chart and the other for the floor, so the
projection could head under 1 while the floor passed. The daily tiers are the cost rise along
the workbook's own spend path (row 229 ramps 6-10% a day; at elasticity 0.38 that is 3.5-5%
a day of cost rise on its own), so with elasticity modelled they double count; applied
consistently they told a campaign at cumulative ROI 3.5 to cut. `spend_rules.
cpe_daily_drift_by_third` is now the pure time effect, 0.5% a day (measured 0.36 ± 1.12;
`etl/analysis/cpe_elasticity.py`); the workbook values sit beside it as
`cpe_daily_drift_by_third_workbook`. The workbook's own template, note, produces the same
runaway "expected daily spend" the first version of this card did (Warhol_LE_26 row 229:
£181k-256k a day; Dali_LE_26 row 231 suggests £3.7k-10.9k a day against £1.5k spent) and
tames it with a "max increase per day 2.0" rule rather than a price that responds to spend.

Provenance of `spend_rules`, corrected: the 0.9 / 1.3 bands, the 30% cap and the 10% dead
band are the TL_Template's "ROI / SPEND RULES - DO NOT CHANGE" block (rows 416-428), not the
LE template's. The LE template's SPEND RULES (rows 284-299) read: decrease -0.1, increase
0.1, max increase per day 2.0, target ROI AA 1.1, at zero conversion decrease by 0.3, three
days of zero conversion decrease by 1.0, and "Expected Increase in Spend (%)" 0.05 / 0.07 /
0.10 by third (row 299), which row 206 "Expected daily increase" reads as the daily growth of
"Cost per unit (forecast)" (row 207). No derivation for any of these appears in the workbook.
The zero-conversion rules are now applied (`zero_conversion_decrease`,
`zero_conversion_days_to_pause`); the LE block is recorded under `le_template_rules`.

## 11b. Release discovery (every release is navigable)

The build enumerates every `simple_release_name` in the funnel data and derives a record
per release (`discover_releases`): id (slug of the name), artist / title / quarter (the name
is always `Artist · Title · YYYY Qn`), dates from the campaign clock (§1.5), a campaign code
guessed from the email and content feeds, and traffic totals. Releases with target inputs on
file take the full build (§5-§9); the rest take an actuals-only build (`build_actuals`) that
emits the same snapshot shape with every target-derived field `null` and `targeted: false`.

Date derivation, checked against the eight hand-entered releases: announce from rows with
`days_since_announcement >= 0` (exact, 7/7), campaign length `L = dsa / pdsa` from the pct
column (exact, 7/7), close = announce + L. The countdown-derived close (`event +
days_until_launch`) runs a day early for some releases and is used only to anchor a release
seen before its announce, where the reconstruction can be a day out. A window outside
3..90 days is rejected (one upstream release reads 106 days; another has a close before its
announce). A release with no clock at all is *catalogue*: still drawing traffic, no campaign
window - 320 of the 353 names in the sheet-capped export, median 24 sessions over four
months, versus a median of ~9,000 for the 33 that carry the clock.

Known divergence: a snapshot last written by the server's JavaScript retarget
(`server/retarget.js` + `shared/targetModel.mjs`) differs from the Python build by ~0.05
units on per-day projections and serialises whole numbers as integers. Same model, two
implementations; the Python build is the reference.

## 11c. Benchmark model: decisions taken, and why

The four that were live arguments, recorded so they are not relitigated from the drawing alone.

24. **The benchmark is a single median, never a band.** The basket's p25-p75 exists and is
    shown - in the picker, and as `unitsP25` / `unitsP75` on the snapshot - but it is a
    description of the basket, not a reference line. §5.2's guardrail band was the right shape
    for "is this release pacing normally?"; it is the wrong shape for "did we hit the number",
    because a band gives a launch two answers and lets the reader pick. One cobalt line, one ink
    line, one gap between them that is the stretch.
25. **The stretch is one even uplift, with conversion rates held.** K multiplies every volume in
    every channel on every day; no channel is asked to convert better than the basket did. The
    alternative - spreading the uplift by channel, or buying part of it with a conversion
    assumption - is exactly the quartile-lever model, which is still available behind the
    `By channel` switch for anyone who wants to make that argument release by release. Keeping
    rates at the benchmark is also what lets the funnel rungs (§4a.1, spec §7) put the target
    ring at ×K on a volume rung and **on the centre line** on a rate rung: the two readings are
    the same statement.
26. **A release is never in its own basket.** Self-inclusion is how a benchmark quietly becomes
    a mirror: on a 4-member cluster a launch would set about a quarter of the number it is
    graded against, and a bad launch would lower its own bar as it went. Enforced in
    `etl/baskets.py` for every basket kind, ready-made, bespoke and saved, and validated on the
    API (a `members` list containing this release is a 400, not a silent drop).
27. **Paid ROI carries no reference lines and no horizon.** ROI is a ratio against a floor of
    1.1 (§7), not a volume that scales with K, so a benchmark line there would invite the
    reading "ROI should be K times the basket's", which is false. The card is unchanged: its
    only reference is the ROI floor it always had.

---

## 12. Open items (need product/user decisions)

- **Country dimension** for "Entries by country": not present in any current feed; add
  geo to the BigQuery funnel export.
- **Per-channel trajectory curves** stabilise as clean completed releases accrue (currently 18);
  until n is sufficient per channel, fall back to the all-channel curve.
- Whether the "Paid" display channel is a separate lens vs AA Meta (design mock conflates them;
  data model keeps Paid Social separate - recommended).
- Draw-entry exports are point-in-time; a post-draw export (winners/claims populated) is needed
  to measure the 0.8 drop-off and win/claim rates for real.
