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
  spend_daily.csv         extracted spend facts: Meta's spend, in euros, the page's currency
  content_posts.csv       extracted content facts (manual Emplifi export; see below)
  notion_posts.csv        posts by release, date and channel, from the Notion log (live)
  release_clusters.csv    every release's campaign window, features, basket and edition pricing
                          (docs/RELEASE_CLUSTERS.md; pricing columns in docs/DATA_MODEL.md 4a.2½)
  release_pricing.csv     one row per Airtable product record: price (EUR), units, launch type,
                          dates, medium - no personal data (etl/pull_airtable.py)
  orders_by_product.csv   per release x Shopify product: units paid, awaiting payment (draft orders),
                          list price, prints with a frame on offer and the frames bought with them
                          (docs 6.4) - aggregates from Order_Line_Concept (server/bigquery.js, docs 2.4)
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

Edition pricing and the per-product target economics (needs `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`,
`AIRTABLE_TABLE` in the environment; the live refresh runs this every cycle when the token is set;
`AIRTABLE_FIELD_<column>` names a target field spelled another way, e.g.
`AIRTABLE_FIELD_MARKETING_LEAD="Marketing owner"`):

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

Render's disk resets on every deploy. Seven things live on it and are lost without these:

| What | Symptom when lost | Fix |
|---|---|---|
| Session secret | everyone is signed out after each deploy | set `SESSION_SECRET` (any long random string) under Environment |
| `sources/` - the pulled feeds: the funnel export, the events and browsing feeds and their incremental bookmarks, the HubSpot sends | every deploy starts with no feed, so the boot refresh is a full multi-year pull plus the whole ETL, and until it finishes the page serves the snapshots committed in the repo, however old their data; a second deploy in that time kills the refresh and starts it over | `SOURCES_PATH` on the disk: the boot refresh is then an incremental pull |
| `data/app/` - the built pages, the index and the inputs document (the 350-odd actuals-only and upcoming pages are not in the repo) | after a deploy every page not in the repo reads "not built yet" until the boot refresh has pulled the feeds and built the catalogue, minutes at best; the upcoming pages alone are rebuilt from Airtable within seconds of the start | `APP_DATA_PATH` on the disk: the last run's pages serve at once and the refresh updates them; the repo's copies seed an empty disk |
| `data/users.json` | roles set in Permissions reset; people are re-added as users on their next Google sign-in | `USERS_PATH` on a persistent disk |
| `data/inputs.saved.json` | targets edited in the dashboard revert to the repo defaults | `SAVED_INPUTS_PATH` on the disk |
| `data/targets.log.jsonl`, `data/decisions.log.jsonl` | the audit trails restart | `TARGETS_LOG`, `DECISIONS_PATH` on the disk |
| `data/layout.json` | the page goes back to its default arrangement (card order, section headers) | `LAYOUT_PATH` on the disk |
| `data/slack.json` | the Slack channel set per release is forgotten; the Post to Slack button goes grey | `SLACK_STATE_PATH` on the disk |

`SESSION_SECRET` is the one-line fix for re-logins and needs no disk. For the rest, add a
persistent disk to the service (Render → the service → Disks → Add disk; 1 GB is plenty), mount it
at `/var/data`, and set the eight variables under Environment (`render.yaml` carries the same disk
and paths for a service created from the blueprint). Until this is done the Target setting tab
shows a red warning on every release, since every save would be lost on the next deploy. Set

```
SOURCES_PATH=/var/data/sources
APP_DATA_PATH=/var/data/app
USERS_PATH=/var/data/users.json
SAVED_INPUTS_PATH=/var/data/inputs.saved.json
TARGETS_LOG=/var/data/targets.log.jsonl
DECISIONS_PATH=/var/data/decisions.log.jsonl
LAYOUT_PATH=/var/data/layout.json
SLACK_STATE_PATH=/var/data/slack.json
```

`SOURCES_PATH` is a directory (the server creates it); the feeds are about 250 MB, so the
1 GB disk still has room. The first refresh after setting it is a full pull, since the disk
starts empty; every deploy after that finds the feeds and their bookmarks in place. The
checked-in `sources/all_sent_emails.csv` stands in for the email panels until the first
HubSpot pull has written the disk's own copy.

`render.yaml` lists the same keys, but Render ignores that file for a service created in the
dashboard, so they have to be set by hand. The ETL's own output (`data/app/`) is regenerated
on every refresh and needs nothing.

## Refreshing data

**Live (production):** on boot and every hour the server rewrites
`sources/across_time.csv` and `data/spend_daily.csv`, pulls Airtable's Pipeline table to
`data/release_pricing.csv` when `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID` and `AIRTABLE_TABLE`
are set (the launches ahead of the funnel appear in the sidebar as Upcoming, docs
`DATA_MODEL.md` 1.7), and reruns the ETL in place - no redeploy needed. Force a pull with `POST /api/refresh` or `GET /api/refresh/status?run=1`
(signed-in session required): both **start** the refresh and return at once with
`running: true`; poll `GET /api/refresh/status` for the outcome, or hover the header's
source-freshness line, which shows the same thing. A page built from data older than the last full
day also carries an amber banner under the header: how many days behind it is, and what the
refresh is doing about it, with the time it started. The page reloads itself when that refresh
lands. Data through yesterday is normal until the first refresh of the day and is not flagged. A refresh is a multi-year BigQuery pull
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
changes, or when there is no local file (which on Render is after every deploy unless
`SOURCES_PATH` keeps the feeds on the persistent disk) - and it reports how many days older than the
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
live entry, are counted apart and never shown as drafts; and the framing, the prints a frame
was on offer for and the frames bought with them, joined to the prints through the order,
docs 6.4) and `data/draw_products.csv` (the product each
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
The same pass reads each row's words for the moment it records - an early-access email
(which opens the private room), the announce, the launch or draw close - and writes
`data/notion_campaigns.csv` (`campaign_code,private_room_open,announce_date,launch_end`),
which the build reads before anything typed; `NOTION_CAMPAIGNS_DB` names a campaigns
database whose date columns (matched by name: early access / private room, announce,
launch / close) override those.

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

The older quartile levers (docs/DATA_MODEL.md §3) are gone from the page and,
since September 2026, from the build: a release that cannot be benchmarked
shows its actuals. Almost nothing on the tab is typed (docs/DATA_MODEL.md
§1.6): the products and their economics come from Airtable per work (edition,
target sell-through, price, profits per unit, the deal's revenue or profit
share, framing), with a cell to type over any figure Airtable does not hold
yet; the dates from the Notion log (the early-access email opens the private
room), then the funnel's clock, then Airtable; the marketing lead from
Airtable. What the page asks is which Meta campaigns are the release's, which
channels are in plan - Running paid, the artist's own channels - and which
basket it is measured against (BENCHMARK_SPEC 4.3, 8).

The derived-targets rail recomputes live in the browser via
`shared/benchmarkModel.mjs` (the per-unit economics via `shared/economics.mjs`);
**Save** persists the inputs (`POST /api/inputs/:id`) and answers at once; the Python ETL rebuilds the release behind the answer (`build.py --release <id>`, one page, not the catalogue, a first save included: the server removes the upcoming or actuals-only page the built one replaces) and the tab follows `GET /api/inputs/:id/build` until it is done, then reloads the page. A failed rebuild leaves the inputs saved and says so; the page catches up on the next refresh. The single-release build reuses the parsed funnel frame and the untracked norm from the last build and prints a `timing:` line, which the refresh status shows.

## Auditing the allocator tool with an admin export

The release page has a **Draw audit** tab. Download a draw's entries from the admin
(`draw-<draw id>-entries.csv`), drop the file on the tab and type the three numbers the
allocator tool prints for that product: Sold, Entries and Expected Sales. The tab reads the
file in the browser (nothing is uploaded; it shows counts and draw entry ids, never a name or
an email) and says how many of the tool's entries can still be allocated, how many are winners
whose payment failed, and whether the tool allocates more units than there are people to
allocate to. The logic is `shared/drawAudit.mjs`, tested by `tests/draw_audit.mjs`.

## Posting sell-through to Slack

The sell-through card has a **Post to Slack** button. It sends the card as a Slack message
to the channel set for that release: the release as a header, the card's headline with the
campaign day and the framing take-up under it, a table of the products (name, units of the
edition, share sold) and the release's totals (paid, drafts, draw winners, at close the
units still to come) in a line under it. The message is composed on the server
(`server/slack.js`) from the same snapshot the card reads, by the card's own rules, at the
horizon the page is on; the browser sends only `{horizon}`. It replaced a picture of the
card, which Slack fits to a fixed height whatever the file's size, and then a table with
bars drawn in text, which wrapped on a phone: figures only, three columns, and the name
column may wrap so the figures never do. The table is Slack's `table` block, which needs a
current Slack workspace; the notification text is the headline alone.

The framing line is the Framing card's own figure (docs 6.4): frames per print on the prints
sold that a frame was on offer for, with the count behind it and the plan's rate beside it.
Before a print is sold it is the rate the entrants' pre-authorised prints ask for; a snapshot
from before the framing block says the plan's rate, marked "(plan)". A release where no print
has a frame on offer gets no line.

The button itself only ever reads Post to Slack, Posting, Done or Failed, so the card's head
never reflows; what happened is on its hover.

Setup, once:

1. Create a Slack app (api.slack.com/apps → Create New App → From scratch) in the
   workspace, add the bot scopes `chat:write` and `chat:write.public` under OAuth &
   Permissions, install it to the workspace, and copy the **Bot User OAuth Token**
   (`xoxb-…`) into `SLACK_BOT_TOKEN` on Render. The token lives only in the environment.
   `chat:write.public` lets the bot post in a public channel nobody invited it to; without
   it, invite the bot to each channel. An app installed before a scope was added needs
   the scope added and the app reinstalled.
2. For a private channel, invite the app to it (`/invite @<app name>`); a public channel
   needs nothing.
3. On the release's **Target setting** tab, type the channel name (without the `#`), or
   its ID, in **Slack channel** and press its own **Save**. It is stored in
   `data/slack.json` (`SLACK_STATE_PATH` on the disk), separately from the targets, so a
   release without targets can have a channel too. If `SLACK_STATE_PATH` points somewhere
   the service cannot write (an `EACCES` on `/var/data` means no disk is mounted there),
   the save still lands in `data/slack.json` and the field says so in amber: that copy
   resets on the next deploy, so mount the disk or unset the variable.

Slack's refusals come back on the button's hover in words (a channel name Slack cannot
find, the bot not invited to a private channel, the token revoked, a missing scope). The
address bar follows the sidebar (`?release=<id>`), so a release can be linked to directly.

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
head sends the card as a message, these rows as a table of figures with the framing take-up
above them, to the release's channel (see "Posting sell-through to Slack").

**Framing** (docs §6.4) is frames per print on the prints a frame was on offer for: the
headline is the prints sold that went out framed, against the plan's frame conversion, and
two bars on one 0 to 100% scale carry the buyers (prints sold) and the entrants (the frames
on the app's pre-authorisation drafts, which is what allocation brings), each with the plan
as the pale fill and the basket's median as the dotted outline. Prints with no framing option
(the Lifesize Brillo Box) are left out of the rate and counted in the key. Hover the buyers'
bar for the rate by work. The card is off the page on a release nothing has been offered a
frame on, and reads from the same orders feed as sell-through.

Every card but sell-through carries both references at once: the target as a fill in two tints of the actual's
own blue (darker to whichever of target and benchmark is lower, lighter from the benchmark up
to the target), the benchmark as a dotted outline over it, and the actual in front. A single
`Compare Today | At close` toggle in the page header drives all of them, and the percentages and
headline deltas read against the target. Plan curves are built from the release's own basket
where it has enough members and fall back to the pooled panel curve per metric (docs §5.3).
Paid ROI is the exception: no reference and no horizon.

Beside it, a **Direct** switch (shown once the ETL has built the page both ways): *Channel*
reads Direct as the funnel attributes it; *Spread* shares Direct's sessions, entries and units
out over the other channels in proportion to their own, day by day, and reads the benchmark's
channel split the same way (docs/DATA_MODEL.md 1.3). Totals and what has been sold do not
move; the plan's pace shifts a little with the mix. The choice sticks per browser.

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
