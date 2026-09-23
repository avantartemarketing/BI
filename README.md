# Avant Arte Launch BI

Launch-performance dashboard for releases (LE-first), built from the reverse-engineered
target-setting model. **Read [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) first** - it specifies
how every number and target is calculated, where each feed comes from, and the data-quality
issues found in the current tooling.

## Layout

```
docs/DATA_MODEL.md      the specification: target model, benchmarks, across-time curves,
                        paid model, draw-entry semantics, metric map, data-quality register
docs/BENCHMARK_SPEC.md  the benchmark / target / stretch contract: basket medians, the even
                        uplift K, the snapshot additions, the drawing grammar
etl/                    Python pipeline
  release_inputs.json     hand-entered launch inputs per release (the human decisions)
  benchmarks.json         frozen benchmark values (v1; recompute policy in docs §4)
  sellthrough.py          the per-product sell-through rule (entries in hand allocated by
                          maximum quantity, for revenue; docs §6.3) - the reference;
                          shared/sellThrough.mjs is the same rule for the server and the web app
  extract_spend.py        Meta spend by campaign × day  (from the workbook snapshot)
  extract_content.py      Emplifi posts by campaign     (from the content export)
  build.py                computes targets, trajectory curves, and per-release snapshots
  baskets.py              baskets of comparable launches and the medians the benchmark reads
  pull_airtable.py        edition pricing from Airtable's Pipeline table -> data/release_pricing.csv
  pricing.py              the join from that file to the release panel (python3 etl/pricing.py
                          prints the matching report and the unmatched releases)
  release_features.py     one row per release from the daily funnel (data/app/release_features.csv)
  analysis/               one-off studies behind documented decisions (cpe_elasticity.py,
                          tier_curve_probe.py, release_clusters.py - the baskets of comparables,
                          price_probe.py - whether price belongs in the basket; it does)
data/
  spend_daily.csv         extracted spend facts
  content_posts.csv       extracted content facts (manual Emplifi export; see below)
  notion_posts.csv        posts by release, date and channel, from the Notion log (live)
  release_clusters.csv    every release's campaign window, features, basket and edition pricing
                          (docs/RELEASE_CLUSTERS.md; pricing columns in docs/DATA_MODEL.md 4a.2½)
  release_pricing.csv     one row per Airtable product record: price (EUR), units, launch type,
                          dates, medium - no personal data (etl/pull_airtable.py)
  orders_by_product.csv   per release x Shopify product: units paid, awaiting payment (draft orders),
                          list price - aggregates from Order_Line_Concept (server/bigquery.js, docs 2.4)
  draw_products.csv       the product each draw's winners bought: the draw to product map
  release_cluster_baskets.json  per-basket quartiles by channel and campaign stage
  app/                    what the UI reads: index.json, curves.json, releases/<id>.json
  app/release_products.json  per release, the draws (one per product) and the entry patterns
                          the per-product sell-through runs on - counts only, no identifier
tests/                  the sell-through rule on fixtures, in both languages, and its parity
                        (python3 tests/test_sellthrough.py runs both sides), the events
                        aggregation on a synthetic feed, the build block, the save path
server/index.js         Express service: serves the SPA + /api/* + the spend decision log
web/                    React (Vite) SPA - the dashboard per the design handoff
render.yaml             Render deployment (single web service)
sources/                NOT in git: raw exports (workbooks, CSVs, draw entries with PII)
```

## Running locally

```bash
npm ci
npm run build          # builds web/dist
npm start              # serves on :10000
```

Dev mode: `npm start` in one shell (API), `npm run dev` in another (Vite on :5173, proxies /api).

Edition pricing (needs `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE` in the environment):

```bash
python3 etl/pull_airtable.py --list-fields              # field names and types only
python3 etl/pull_airtable.py                            # -> data/release_pricing.csv
python3 etl/analysis/release_clusters.py --pricing-only # re-attach prices to the panel on file
python3 etl/pricing.py                                  # the matching report: what matched how, and what did not
```

## Every release, not just the targeted ones

The ETL builds a page for **every** release the funnel data mentions (`discover_releases` in
`etl/build.py`), not only the ones with target inputs in `etl/release_inputs.json`:

- **Targeted** releases (inputs on file) get the full build: targets, expected-today,
  projections, paid ROI, sell-through. Their snapshots live in `data/app/releases/` and are
  committed, so the app has pages at boot.
- **Everything else** gets an actuals-only page (`build_actuals`): secured units, channel
  mix, trajectory, sold units, email and social where a campaign code could be matched.
  Snapshots go to `data/app/derived/` (not committed; rebuilt every refresh). The page
  carries `targeted: false`, the header says **No targets**, and the target-driven cards
  are replaced by one that explains what is missing and offers **Set up targets**.
- **Dates** come from the campaign clock the export carries: announce from
  `days_since_announcement`, campaign length from the pct column (both exact against the
  hand-entered releases), close = announce + length. A release seen only before its
  announce is reconstructed the other way and can be a day out. A release with no clock is
  **catalogue** - a work still drawing traffic - and is shown over its last 90 days.
- **In flight** = has dates and today is before the close. The sidebar lists those, fewest
  days to launch first (a release whose window has not opened yet sits last, with its
  opening date). Each row is the artist over the launch date with the days left on the
  right; the row's tooltip carries the title, the day of the window and the pace the dot
  means, so there is no key under the list. Every other release is reachable from the
  search box (artist, title, quarter, id), on the same row with the date it closed. A
  closed or catalogue release you pick stays pinned under **Viewing** while selected.
- **Campaign codes** for unconfigured releases are guessed from the codes the email and
  content feeds use (`AntonyMic_LE_26`), by artist and year; a guess is only taken when it
  is unambiguous, is labelled as a guess, and can be corrected in Target setting. The code's
  middle segment is not treated as a release type - every release in the LE export is an LE,
  whatever the feed tagged it (the content feed tags Warhol's 2026 LE `AndyWarhol_TL_26`).

**Setting targets** on such a release uses the same Target setting tab, starting from the
derived defaults; edition size, price and both profits are required. Saving writes the
inputs to `data/inputs.saved.json` (never to the ETL's own `data/app/inputs.json`, which is
output) and reruns the full ETL, which promotes the release.

## Keeping state across deploys (Render)

Render's disk resets on every deploy. Five things live on it and are lost without these:

| What | Symptom when lost | Fix |
|---|---|---|
| Session secret | everyone is signed out after each deploy | set `SESSION_SECRET` (any long random string) under Environment |
| `data/users.json` | roles set in Permissions reset; people are re-added as users on their next Google sign-in | `USERS_PATH` on a persistent disk |
| `data/inputs.saved.json` | targets edited in the dashboard revert to the repo defaults | `SAVED_INPUTS_PATH` on the disk |
| `data/targets.log.jsonl`, `data/decisions.log.jsonl` | the audit trails restart | `TARGETS_LOG`, `DECISIONS_PATH` on the disk |
| `data/layout.json` | the page goes back to its default arrangement (card order, section headers) | `LAYOUT_PATH` on the disk |
| `data/slack.json` | the Slack channel set per release is forgotten; the Post to Slack button goes grey | `SLACK_STATE_PATH` on the disk |

`SESSION_SECRET` is the one-line fix for re-logins and needs no disk. For the rest, add a
persistent disk to the service (Render → the service → Disks; 1 GB is plenty), mount it
at `/var/data`, and set

```
USERS_PATH=/var/data/users.json
SAVED_INPUTS_PATH=/var/data/inputs.saved.json
TARGETS_LOG=/var/data/targets.log.jsonl
DECISIONS_PATH=/var/data/decisions.log.jsonl
LAYOUT_PATH=/var/data/layout.json
SLACK_STATE_PATH=/var/data/slack.json
```

`render.yaml` lists the same keys, but Render ignores that file for a service created in the
dashboard, so they have to be set by hand. The ETL's own output (`data/app/`) is regenerated
on every refresh and needs nothing.

## Refreshing data

**Live (production):** on boot and every hour the server rewrites
`sources/across_time.csv` and `data/spend_daily.csv` and reruns the ETL in place - no
redeploy needed. Force a pull with `POST /api/refresh` or `GET /api/refresh/status?run=1`
(signed-in session required): both **start** the refresh and return at once with
`running: true`; poll `GET /api/refresh/status` for the outcome, or hover the header's
source-freshness line, which shows the same thing. A refresh is a multi-year BigQuery pull
plus the ETL and takes a few minutes - longer than Render's proxy will hold a request
open, so an endpoint that waited for it came back as a 502.
There are two paths to the same two files, and BigQuery wins whenever it is configured.

### BigQuery (preferred; `server/bigquery.js`)

Reads `le_funnel_report_split_touch_export` and `meta_ads_insights_export` straight from
`avantarte-data-production.AA_company_tables` - the origin of every funnel and spend
number in the dashboard. Prefer it: the sheet tabs below are query *exports* capped at
50,000 rows per tab, and that cap does not error. It silently drops the oldest days as
new launches push rows off the end, which is why the across-time curves are fitted on a
handful of complete campaigns rather than the hundreds we have run.

- `BIGQUERY_SERVICE_ACCOUNT_JSON` - the key file's contents, verbatim (falls back to
  `GOOGLE_SERVICE_ACCOUNT_JSON` if one account does both jobs). The account needs
  **BigQuery Data Viewer** on the dataset and **BigQuery Job User** on the project.
- `BQ_PROJECT` (default `avantarte-data-production`), `BQ_DATASET` (default
  `AA_company_tables`), `BQ_FUNNEL_TABLE`, `BQ_SPEND_TABLE`, `BQ_LOCATION`.
- `BQ_SINCE` (default `2025-01-01`) - how far back to pull. Widening it is the whole
  point of this path; it also sets the bill, since BigQuery charges per byte scanned and
  both queries filter on the partition column - and the memory, see below.
- `BIGQUERY=off` forces the sheet path back on. `BQ_ALLOW_SHRINK=1` disables the guard
  that refuses to replace a long history with a much shorter one.

The funnel table is required; **spend is optional**. A service account granted the funnel
dataset but not `meta_ads_insights_export` still refreshes the funnel, and spend falls
back to the sheet's `meta_ads_insights_Extract` tab so paid spend keeps moving (the
refresh note reads `spend only: N rows from the sheet`). If that tab is unreachable too,
the previous `data/spend_daily.csv` keeps serving and the header reads **Sources stale**
until one of the two is fixed - granting the BigQuery table is the better fix, since it
keeps spend on the same attribution basis as the funnel. `BQ_SPEND=off` skips the
BigQuery spend query outright.

**Incremental.** The hourly refresh does not re-pull the window. It asks BigQuery for the
last `BQ_OVERLAP_DAYS` (default 45) only, keeps the older local rows, and swaps the merged
file in atomically (`sources/across_time.meta.json` records the window, columns and last
date). The overlap is not a nicety: entry-to-order conversion keeps changing a day's row
until the draw settles, so recent history is live. A **full** pull runs every
`BQ_FULL_EVERY_DAYS` (default 7), on `?run=1&full=1`, when `BQ_SINCE` or the column set
changes, or when there is no local file - and it reports how many days older than the
overlap changed upstream since the last full pull, so "historic data doesn't change" is
measured rather than assumed. An upstream backfill (announcement dates for the back
catalogue, say) rewrites the clock columns years back; the weekly full pull is what picks
it up, or force one. An incremental pull that comes back thin (fewer than half the rows
the local file has for the overlap) is refused rather than written, since writing it
would delete the last 45 days.

Check the connection without writing anything: `node server/bigquery.js` prints the plan
(full or incremental, and why), row counts and GB scanned; add `--write` to replace the
CSVs, `--full` to force a full pull, `--events` to pull the event-level feed alone, `--orders`
the orders-by-product pair alone.

**What the account can see.** `node server/bigquery.js --schema` lists every dataset, table
and view the service account can list, with column names and types, from the metadata
endpoints - no query runs and no row is read - and names the tables that carry both a product
column and an order or draw column, which is the question behind sales and drafts by product
(docs §6.3). Signed in, `/api/bigquery/schema?format=text` serves the same listing from the
live service (`?refresh=1` lists again; the JSON form without `format`), so a newly granted
table can be checked without a shell. Address-shaped column names are flagged in the listing
and are never selected by anything here.

**Event-level feed.** The same pull also takes the conversion events (signup, draw entry
intent, purchase) of `LE_Funnel_Report` into `sources/le_events.csv`. That table carries
customer email addresses; the pull is written so the address never leaves BigQuery - an
explicit column list, a header check, and an address scan on every cell that aborts the
pull rather than write (docs/DATA_MODEL.md §2.1). `BQ_EVENTS_TABLE` points it at the data
team's email-free view once one exists, `BQ_EVENTS_SINCE` (default 2019-01-01) sets the
window, `BQ_EVENTS=off` skips it. The file holds pseudonymous account ids, which are still
personal data: it stays under `sources/`, is served by no endpoint, and nothing derived from
it leaves the server with an identifier column.

**Orders and drafts by product.** The pull also reads `Order_Line_Concept`, the Shopify order
lines, into two aggregate files: `data/orders_by_product.csv` (per release and product: units
paid, orders awaiting payment, list price; the draw's own pre-authorisation drafts, one per
live entry, are counted apart and never shown as drafts) and `data/draw_products.csv` (the product each
draw's winners bought, joined inside BigQuery on the pseudonymous account id). That table
carries email addresses too; nothing selects them, and only counts per release and product
leave (docs/DATA_MODEL.md 2.4). `BQ_ORDERS=off` skips the pair, `BQ_ORDERS_TABLE` renames
the table.

**The export, rebuilt here.** The pull also counts sessions and page views per channel-day
inside BigQuery (`sources/le_browsing.csv`, `--browsing` pulls it alone, `BQ_BROWSING=off`
skips it), and `etl/aggregate_events.py` - run before `build.py` on every refresh - rebuilds
the daily export from that and the conversion events with the definitions in
docs/DATA_MODEL.md §2.2, reconciles the rebuild against the export column by column
(`data/app/reconciliation.json`, and the verdict in the refresh status), and writes
`data/app/release_people.csv`: per release, unique entrants and buyers, returning collectors
and overlap with the artist's previous releases. It also fills in the campaign clock for the
releases the upstream feed has no dates for (upstream dates always win; otherwise the first
big traffic spike or the day the draw opens, and the allocation day - docs §1.5), recorded
in `data/app/release_windows.csv`, which takes the across-time curve panel from 24 campaigns
to 96. The build reads the rebuilt file
(`sources/across_time.rebuilt.csv`); `FUNNEL_SOURCE=export` makes it read the export
instead. A missing or stale rebuilt file makes the build fall back to the export and say so. The aggregation peaks at about 330 MB, in line with the build;
`AGG_PROFILE=1` prints its memory after each stage.

**Memory on the 512 MB starter instance.** Results are streamed to disk a page at a time
and the start script caps Node's heap at 192 MB, so the pull itself is flat (~150 MB)
however deep `BQ_SINCE` goes. The ETL is what scales: pandas peaks at roughly 90 MB plus
0.4 MB per 1,000 funnel rows, and the table runs about 430 rows a day. Measured:

| `BQ_SINCE` | funnel rows | ETL peak | with Node | on 512 MB |
|---|---|---|---|---|
| 2025-01-01 | ~260k | ~175 MB | ~325 MB | comfortable |
| 2024-01-01 | ~420k | ~240 MB | ~390 MB | comfortable |
| 2023-01-01 | ~575k | ~300 MB | ~450 MB | fits, little headroom |

Deeper than that wants Render's 2 GB plan. The history only earns its keep once the
upstream table carries announcement dates for the back catalogue (data-quality issue 8),
so there is no rush to reach for it. If the process is ever OOM-killed mid-refresh the
symptom is the whole app going 502 for a moment and the header reading **Source status
unknown** afterwards; shorten `BQ_SINCE`.

### Google Sheet (fallback; `server/sheets.js`)

Pulls two tabs of the *LE Paid Calculator* sheet. Used when BigQuery is unconfigured, and
attempted as a fallback when a BigQuery pull fails - in that case the header reads
**Sources stale**, because the numbers on screen came from the truncated copy.

- `GOOGLE_SERVICE_ACCOUNT_JSON` - a Google service-account key (Sheets API enabled);
  share the sheet with the key's `client_email` as **Viewer** and the sheet can stay
  Restricted. While unset, the fetch falls back to the public CSV export, which only
  works while the sheet is link-shared.
- `SHEET_ID`, `SHEET_FUNNEL_TAB`, `SHEET_SPEND_TAB`, `REFRESH_MINUTES` - optional
  overrides; `SHEETS_REFRESH=off` disables the scheduler.

Whichever path ran, and whether it worked, is on `GET /api/refresh/status` and in the
tooltip behind the header's source-freshness line.

Target inputs saved from the dashboard survive the rerun (`build.py` overlays
`data/app/inputs.json` over the repo defaults). If a pull or the ETL fails, the previous
snapshots keep serving.

Email stats can also refresh live: set `HUBSPOT_TOKEN` to a HubSpot **Private App**
token (Settings → Integrations → Private Apps, Marketing Email read scope) and each
refresh pulls every sent marketing email's delivered/open/click counts into
`sources/all_sent_emails.csv` (`server/hubspot.js`). The listing comes back oldest first, so
the pull asks only for emails created in the last two years (well inside its page cap), keeps
older sends from the file it already has, and opens its status line with `sends through
<date>`; a pull that still hits the cap says `CAPPED`. The header shows `emails through
<date>` in amber whenever that date is more than a week behind the build. Emails join a release when the
HubSpot campaign name is the release's campaign code, when the code appears in the
email or campaign name, or when an `Artist_Type_YY` token in either names the same
artist and year as exactly one known code (so `AndyWarhol_LE_26` sends join the
`AndyWarhol_TL_26` Meta code); known codes are every configured, saved and discovered
release. The GEN/CUS/INS send-type filter still reads the name convention. The
`emails` field of `/api/refresh/status` says, per targeted release, how many sends in
the last 60 days joined it and lists the recent sends that joined nothing - the first
place to look when a release's email rows are blank. The email references are
recomputed from that file at every refresh: open rate, click rate, clicks per open and
sessions per click (AA Email sessions over tracked clicks) as the median pooled rate
across completed draw launches of the last 24 months (configured and discovered). The
delivered target is the sends the release's own AA Email sessions plan implies by today
at those rates, so a release sending to a small list is judged against a volume that fits
it, and the benchmark's sends are the same at the basket's pace (the waterfall's walk from
the benchmark reads those); the median delivered total across completed configured launches
on the pooled delivery-timing curve is the fallback until two launches give a
sessions-per-click median.
The dashboard's 19.6% and 4.3% defaults apply only until two launches qualify. Without the
token the committed CSV snapshot (sends to 14 Aug 2026) is used.

Instagram content (`data/content_posts.csv`) remains a manual export - the live refresh
runs `aggregate_events.py` and `build.py` only, never `extract_content.py`, and the
Emplifi workbook it reads is not on the server - so it is frozen wherever it was last
regenerated by hand. The Notion log above supersedes it for the AA Meta post count;
impressions and engagements still come from it, and nothing reads those.

The same token also serves a one-off **email text export**: open
`/api/emails/content/status?run=1` (add `&years=3` to widen the default two-year window),
poll the same URL without `run=1` until `running` is false, then download
`/api/emails/content.csv`: one row per sent email with its name, subject, preview text,
campaign, send date, delivered / opened / clicked and the email's text with HTML stripped
(`server/emailContent.js`). The status shows the first email's field names and how many
rows came out empty, which is the check that the text extraction matched HubSpot's shape.

Posts refresh from the team's **Notion log**: set `NOTION_TOKEN` to an
internal-integration secret (notion.so → Settings → Integrations → develop your own)
and share the posts database page with that integration. Each refresh queries
the database (`server/notion.js`), matches rows to releases by campaign code / release
name / artist name found in any text column, and writes `data/notion_posts.csv`
(`campaign_code,date,channel,posts`). `NOTION_ARTIST_POSTS_DB` overrides the database id.

The channel comes from the database's Channel column - values are written by hand
("AA IG Main", "Artist post", "Partner post") so they are read by shape, not from a
list: anything starting `AA` or naming Avant Arte is the brand's own account, then
artist, then partner, and anything else is kept as `other` and named in the refresh
status line so a new channel shows up as a question rather than landing silently in a
bucket. The status line also prints every column, with the values in each
choice-typed one, which is how to check the split without opening Notion.

Two rungs read it. The AA Meta "Posts" rung takes the brand rows, and the Referral
artist "Posts" rung the artist rows, compared against the tier benchmark: median posts
among completed campaigns in the same Referral Artist tier (the channel quality pick),
pro-rated by days elapsed - the same benchmark-by-cohort approach as every other
channel. Partner rows are carried in the file and claimed by neither.

The AA Meta rung has a second source, the Emplifi export below, and Notion wins
wherever the log was being kept - decided per release, on whether any row at all falls
in that release's window, so campaigns that ran before the log existed keep the numbers
they have. Notion records a row per post and no format, so a Notion count goes to
`posts` with `stories` at zero; `impressions` and `engagements` stay on the export, and
nothing reads them today. `social.postsSource` on the snapshot says which source a
release used.

**Manual (local):** drop the source exports into `sources/` (file names in `etl/*.py`
headers), then:

```bash
pip install openpyxl pandas
npm run etl
```

The committed `data/app/*` snapshots were built from exports current to **2026-08-27**.
### Personal data in BigQuery

The LE Funnel Report table in BigQuery carries customer email addresses. The rule is
that an address never leaves BigQuery: not onto Render's disk, not into a Claude
session's terminal or transcript, not into a snapshot, a download or the repo. Three
things hold that line:

- **A tripwire in the query path.** Every result that passes through `query()` in
  `server/bigquery.js` is checked: a column named like an email field, or a cell that
  looks like an address, aborts the query with `PiiDetected` before anything is written
  or handed on. There is no override. Queries against that table must name their
  columns; `SELECT *` will trip it.
- **Per-contact analysis uses a keyed hash, computed in BigQuery.** `contactKeySql(col)`
  gives `TO_HEX(SHA256(CONCAT(@salt, LOWER(TRIM(col)))))`, with the salt passed as a
  query parameter from `PII_HASH_SALT`. The key is stable, so repeat buyers and sends per
  contact can be counted, and it cannot be turned back into an address without the salt,
  which lives only in the environment. An unsalted hash would not do: anyone holding a
  list of addresses could hash them and match.
- **Aggregate in BigQuery, not here.** Anything the dashboard shows is a count per
  release, date and channel. Group in the query so only aggregate rows travel.

The control that makes the rest unnecessary is on the data team's side: an
**authorized view** over the table that exposes the hashed key in place of the address,
with the raw table not granted to the service account at all. Ask for that; until it
exists, the three rules above are the fence. In a Claude session, never print sample
rows from that table - the terminal output is part of the retained conversation.

Draw-entry CSVs contain customer emails - they stay in `sources/` and only aggregated,
anonymised numbers reach `data/`.

Longer term this should be pointed at BigQuery
(`avantarte-data-production.AA_company_tables.*`) instead of the sheet - the sheet
pipeline's accumulators are already silently truncating history (docs §11).

## Signing in

The app is behind **Sign in with Google**, restricted to the company Workspace domain.
Create a "Web application" OAuth client in Google Cloud Console (consent screen type
**Internal** so only avantarte.com accounts can sign in), give it the redirect URI
`https://<your host>/auth/google/callback`, and set `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET` on Render. The login page shows "Continue with Google"; the
server verifies the ID token itself (signature, issuer, audience, expiry, nonce, verified
email, domain) and issues a 90-day session cookie that renews itself on activity. An
account in the domain that is not yet on the Permissions tab is added as a user on first
sign-in; set `GOOGLE_LOGIN_ALLOWLIST_ONLY=1` to refuse those instead. `PUBLIC_URL` pins
the redirect base when the host header cannot be trusted. `/healthz` says whether the
Google client is configured and, if not, which variable name is unset.

The Permissions tab (admins only) is the access list plus a role per person. The first
listed email in `LOGIN_USERS` (default `tom.lloyd@avantarte.com`) seeds the admin when the
user store is missing, so the tab can never be orphaned; `SESSION_SECRET` is REQUIRED for
sign-ins to survive deploys (check it exists under the service's Environment tab).

Without a Google client configured - local development, or a broken deployment - the
login page falls back to the old password form (`LOGIN_PASSWORD`, default accounts from
`LOGIN_USERS`) and the dormant magic-link flow (`RESEND_API_KEY`, `MAIL_FROM`). The
moment the two Google variables are set, those routes answer 404.

## Target setting

Each release has a **Target setting** tab: launch inputs, economics, and the
target model. Targets are set from a **basket of comparable launches** (docs
§4a, contract in `docs/BENCHMARK_SPEC.md`): the basket's median is the
**benchmark** - what launches like this one reach - the edition size is the
**target**, and the gap between them is the **stretch**. The target is the
benchmark times one even uplift `K = edition_size / benchmark units`, applied
to every volume in every channel on every day, with conversion rates held at
the benchmark. The basket is picked in a modal (ready-made clusters, or a
bespoke tick-list of past launches that can be saved); a release is never in
its own basket.

The older quartile levers (docs §3/§4) are gone from the page; the build keeps
that model only as the fallback for a basket with no median units, and the
model in force is on the snapshot as `targetingMode`. What the page asks
instead is which channels are in plan - Running paid, the artist's own
channels - and what a paid unit costs to buy (BENCHMARK_SPEC 4.3, 8).

The derived-targets rail recomputes live in the browser via
`shared/targetModel.mjs`; **Save** persists the inputs (`POST /api/inputs/:id`)
and the server retargets the release snapshot in place (`server/retarget.js`) -
plans, expected-today, projections and the rail all update without a full ETL
run. A save that changes the basket or the stretch mode instead **re-runs the
Python ETL for that release**, because the benchmark model needs the panel and
the per-basket curves; the response is the same either way. Full daily-domain
refreshes still come from `npm run etl`. Saved inputs live in
`data/app/inputs.json` (ephemeral on Render's free disk - copy changes back
into `etl/release_inputs.json` to make them permanent); custom baskets live
beside them in `data/app/baskets.json`.

## Auditing the allocator tool with an admin export

The release page has a **Draw audit** tab. Download a draw's entries from the admin
(`draw-<draw id>-entries.csv`), drop the file on the tab and type the three numbers the
allocator tool prints for that product: Sold, Entries and Expected Sales. The tab reads the
file in the browser (nothing is uploaded; it shows counts and draw entry ids, never a name or
an email) and says how many of the tool's entries can still be allocated, how many are winners
whose payment failed, and whether the tool allocates more units than there are people to
allocate to. The logic is `shared/drawAudit.mjs`, tested by `tests/draw_audit.mjs`.

## Posting sell-through to Slack

The sell-through card has a **Post to Slack** button. It sends the card itself as a
picture, with the release's current figures under it in the sales team's own layout, to
the channel set for that release:

```
*Julian Schnabel · Multiple · 2026 Q3* - sales update, 17 Sep (day 11 of 24)
Paid = 94 units (16% of 600)
• I: 46/200 ...
Draw = 30 unique entrants (2 won and not yet paid: not counted, their orders are in Drafts)
• I: 24 open + 1 to pay ...
Drafts = 5
• I: 2 · II: 1 · III: 2
Estimated sell-through (entries at 80% entry → order, pre-orders at 95%, placed by maximum quantity for revenue)
• I: ~62 units → 31% ...
Total ~126 units → 21% of 600
```

The picture is the card's own rows, drawn on a canvas in the browser that is showing them
(`web/src/modules/sellThroughImage.mjs`) - the one place with the page's typeface - from a
model the card builds out of what it has just rendered, so only the drawing is written
twice and never the figures. It carries the release, the campaign day and the rate along
the top, which the card on the page does not need, so it stands on its own in a channel.
It is composed 500 CSS pixels wide (drawn at two times that), because Slack shows a
picture inline about 400 pixels wide whatever the file's size: at the page's width it
arrived at a third of its size, unreadable. A browser that cannot give us a PNG posts the
figures alone rather than nothing.

Slack attaches a file only to a channel it knows by ID, and `chat.postMessage` is the one
call that hands an ID back, so the **first** post to a channel is the figures and then the
picture, and every post after that is one: the picture with the figures as its comment. A
picture Slack will not take (`files:write` missing, say) never costs the figures - they go
as text and the button says why in amber. A public channel nobody invited the bot to takes
the figures as they are (`chat:write.public`), and when it refuses the picture because the
bot is not a member, the bot joins the channel (`channels:join`) and sends it again; a
private channel cannot be joined that way, so the button asks for an invite.

The message is composed on the server from the same snapshot the card is drawn from
(`server/slack.js`), so what lands in Slack is what the page says at that moment. The
header carries the day it is sent, with the campaign day moved on to match; when the
feeds' last complete day is earlier than that, a last line says "Complete data through"
that day. The percentages are of the whole edition, the products' editions added up
(Warhol: 6,100 with the Lifesize), not of the sellout target the page's targets use; the
release's own edition size stands in only when a product has no edition.

Setup, once:

1. Create a Slack app (api.slack.com/apps → Create New App → From scratch) in the
   workspace, add the bot scopes `chat:write`, `chat:write.public`, `files:write` and
   `channels:join` under OAuth & Permissions, install it to the workspace, and copy the
   **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN` on Render. The token lives
   only in the environment. Without `files:write` the figures still post; only the picture
   does not, and the button says so. Without `channels:join` the picture only reaches
   channels the bot has been invited to. An app installed before a scope existed needs
   the scope added and the app reinstalled.
2. For a private channel, invite the app to it (`/invite @<app name>`); public channels
   need nothing, the bot joins one by itself the first time it posts a picture there.
3. On the release's **Target setting** tab, type the channel name (without the `#`) in
   **Slack channel** and press its own **Save**. It is stored in `data/slack.json`
   (`SLACK_STATE_PATH` on the disk), separately from the targets, so a release without
   targets can have a channel too. If `SLACK_STATE_PATH` points somewhere the service
   cannot write (an `EACCES` on `/var/data` means no disk is mounted there), the save
   still lands in `data/slack.json` and the field says so in amber: that copy resets
   on the next deploy, so mount the disk or unset the variable.

`PUBLIC_URL` (or Render's own `RENDER_EXTERNAL_URL`) puts an "Open in Launch Performance"
link at the end of each message that opens the release itself (`?release=<id>`; the address
bar follows the sidebar for the same reason). Slack's refusals come back on the button in
words (wrong channel name, bot not invited, token revoked, missing scope).

## Deploying on Render

The repo ships `render.yaml` - create a Blueprint service from the repo and Render will
`npm ci && npm run build` then `npm start`. The paid-spend decision log
(`POST /api/decisions`) appends to `data/decisions.log.jsonl`; attach a persistent disk and
set `DECISIONS_PATH` if the log must survive deploys.

## What the dashboard shows

One page per release (sidebar switches): entries vs targets, per-channel targets, the entry
trajectory vs the across-time plan curve, funnel diagnostics with contribution
decomposition, paid ROI + recommended daily spend (supply-cap vs ROI-floor), sell-through
by product, projection-vs-target waterfall. Formulas for every module: docs §9. The
Overview opens with the campaign clock, a thin strip from announcement to launch, blue to
today and the days to launch on the right (the day of the window is in the strip's popup);
it is a card like the others and moves with them.

**Sell-through by product** (docs §6.3) is one row per product, drawn in one ramp of the
page's blue, deepest to palest as the units get less certain: units paid (deep blue), draft
orders an advisor raised that are not yet paid (blue; the draw's own pre-authorisation
drafts are the entries, not drafts), the draw entries in hand counted on the product at the
entry → order rate, or at the pre-order rate where the entrant's card is already authorised
(light blue), and at close the units still to come (palest), against the product's
edition. Nothing is hatched: the four tints are the whole key, and demand a product has no
room for simply carries on past the point where the paler room behind the bar stops. The card
is one row of the grid whatever the count: the rows share a fixed height, the bars growing
from 14px for seven products to a 30px cap for three or fewer, each row carrying its units of
the edition and its percentage in columns of their own, with the key beside the headline. It is
the one card with no target or benchmark on it and no prose: the detail is in the popups. Units paid and draft
orders per product come from the Shopify order lines in BigQuery (`data/orders_by_product.csv`),
joined to the draws through the product each draw's winners bought (docs 2.4); until every draw
of a release is named that way the card wears an **Incomplete data** stamp, and the sales the
draw cannot name a product for sit inside the sold segment split by edition size. The entries in hand are allocated the way the allocator would place them: an
entrant who entered more products than their maximum quantity is counted on that many
products only, placed for revenue: on the priciest of them that still has room, then on
whichever has the most room. Products come from the event feed's draws
(one draw per product) and are named and sized on the Target setting tab, where the entry →
order rate can also be set per release; a product nobody has named takes its Shopify title
and, where the title matches an Airtable record, its edition. Until the feed has run once after
a deploy the card shows the release as one row and says so. **Post to Slack** in the card's
header sends the card as a picture, with these figures under it, to the release's channel
(see "Posting sell-through to Slack").

Every card but sell-through carries both references at once: the target as a fill in two tints of the actual's
own blue (darker to whichever of target and benchmark is lower, lighter from the benchmark up
to the target), the benchmark as a dotted outline over it, and the actual in front. A single
`Compare Today | At close` toggle in the page header drives all of them, and the percentages and
headline deltas read against the target. Plan curves are built from the release's own basket
where it has enough members and fall back to the pooled panel curve per metric (docs §5.3).
Paid ROI is the exception: no reference and no horizon.

### Arranging the page

**Edit layout**, at the right of the Overview / Target setting tabs, turns the page into a
drag-and-drop board: drag a card to move it, **Add header** puts a section title at the top
of the page to drag into place (a header ends one grid and starts the next, so each section
packs on its own), the **×** on a card takes it off the page, and **Add a card** puts one back
at the top. That list also holds the cards that are not on the page by default: **Funnel by
channel, 2 × 2** is the funnel card's waterfall at two columns by two rows, the bars running
across the card on a unit axis with the figures in a column of their own; take **Funnel by
channel, 1 × 2** off and add the 2 × 2 to swap one for the other. **Save
for everyone** keeps the arrangement for the whole team in `data/layout.json` (`LAYOUT_PATH`
on Render, see above); the saved layout records the cards taken off, so they stay off. **Back
to the default** restores the built-in order. The list of cards lives in `web/src/Layout.jsx`:
a card added to the code later joins the end of everyone's page (the campaign clock, which
belongs at the top, joins there), a strip such as the clock is a full-width row of its own
between the grids, and a card a release has nothing for (No targets set on a targeted release,
the clock on a catalogue release) is left out of that release's page and shows as a ghost while
editing.
