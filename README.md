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
  extract_spend.py        Meta spend by campaign × day  (from the workbook snapshot)
  extract_content.py      Emplifi posts by campaign     (from the content export)
  build.py                computes targets, trajectory curves, and per-release snapshots
  baskets.py              baskets of comparable launches and the medians the benchmark reads
  release_features.py     one row per release from the daily funnel (data/app/release_features.csv)
  analysis/               one-off studies behind documented decisions (cpe_elasticity.py,
                          tier_curve_probe.py, release_clusters.py - the baskets of comparables)
data/
  spend_daily.csv         extracted spend facts
  content_posts.csv       extracted content facts
  release_clusters.csv    every release's campaign window, features and basket (docs/RELEASE_CLUSTERS.md)
  release_cluster_baskets.json  per-basket quartiles by channel and campaign stage
  app/                    what the UI reads: index.json, curves.json, releases/<id>.json
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
- **In flight** = has dates and today is before the close. The sidebar lists those; every
  other release is reachable from the search box (artist, title, quarter, id). A closed or
  catalogue release you pick stays pinned under **Viewing** while selected.
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

Render's disk resets on every deploy. Four things live on it and are lost without these:

| What | Symptom when lost | Fix |
|---|---|---|
| Session secret | everyone is signed out after each deploy | set `SESSION_SECRET` (any long random string) under Environment |
| `data/users.json` | users added in Permissions vanish, passwords reset to `LOGIN_PASSWORD` | `USERS_PATH` on a persistent disk |
| `data/inputs.saved.json` | targets edited in the dashboard revert to the repo defaults | `SAVED_INPUTS_PATH` on the disk |
| `data/targets.log.jsonl`, `data/decisions.log.jsonl` | the audit trails restart | `TARGETS_LOG`, `DECISIONS_PATH` on the disk |

`SESSION_SECRET` is the one-line fix for re-logins and needs no disk. For the rest, add a
persistent disk to the service (Render → the service → Disks; 1 GB is plenty), mount it
at `/var/data`, and set

```
USERS_PATH=/var/data/users.json
SAVED_INPUTS_PATH=/var/data/inputs.saved.json
TARGETS_LOG=/var/data/targets.log.jsonl
DECISIONS_PATH=/var/data/decisions.log.jsonl
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
CSVs, `--full` to force a full pull, `--events` to pull the event-level feed alone.

**Event-level feed.** The same pull also takes the conversion events (signup, draw entry
intent, purchase) of `LE_Funnel_Report` into `sources/le_events.csv`. That table carries
customer email addresses; the pull is written so the address never leaves BigQuery - an
explicit column list, a header check, and an address scan on every cell that aborts the
pull rather than write (docs/DATA_MODEL.md §2.1). `BQ_EVENTS_TABLE` points it at the data
team's email-free view once one exists, `BQ_EVENTS_SINCE` (default 2019-01-01) sets the
window, `BQ_EVENTS=off` skips it. The file holds pseudonymous account ids, which are still
personal data: it stays under `sources/`, is served by no endpoint, and nothing derived from
it leaves the server with an identifier column.

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
`sources/all_sent_emails.csv` (`server/hubspot.js`). Emails join a release when the
HubSpot campaign name is the release's campaign code, when the code appears in the
email or campaign name, or when an `Artist_Type_YY` token in either names the same
artist and year as exactly one known code (so `AndyWarhol_LE_26` sends join the
`AndyWarhol_TL_26` Meta code); known codes are every configured, saved and discovered
release. The GEN/CUS/INS send-type filter still reads the name convention. The
`emails` field of `/api/refresh/status` says, per targeted release, how many sends in
the last 60 days joined it and lists the recent sends that joined nothing - the first
place to look when a release's email rows are blank. The email references are
recomputed from that file at every refresh: open rate, click rate and clicks per open
as the median pooled rate across completed draw launches of the last 24 months
(configured and discovered),
the delivered target as the median delivered total across completed configured
launches on the pooled delivery-timing curve. The dashboard's 19.6% and 4.3% defaults
apply only until two launches qualify. Without the token the committed CSV snapshot
(sends to 14 Aug 2026) is used. Instagram content (`data/content_posts.csv`) remains a
manual export.

The same token also serves a one-off **email text export**: open
`/api/emails/content/status?run=1` (add `&years=3` to widen the default two-year window),
poll the same URL without `run=1` until `running` is false, then download
`/api/emails/content.csv`: one row per sent email with its name, subject, preview text,
campaign, send date, delivered / opened / clicked and the email's text with HTML stripped
(`server/emailContent.js`). The status shows the first email's field names and how many
rows came out empty, which is the check that the text extraction matched HubSpot's shape.

Artist-account posts refresh from the team's **Notion log**: set `NOTION_TOKEN` to an
internal-integration secret (notion.so → Settings → Integrations → develop your own)
and share the artist-posts database page with that integration. Each refresh queries
the database (`server/notion.js`), matches rows to releases by campaign code / release
name / artist name found in any text column, and writes `data/artist_posts.csv`. The
Referral artist "Posts" funnel rung compares posts to date against the tier benchmark:
median posts among completed campaigns in the same Referral Artist tier (the channel
quality pick), pro-rated by days elapsed - the same benchmark-by-cohort approach as
every other channel. `NOTION_ARTIST_POSTS_DB` overrides the database id.

**Manual (local):** drop the source exports into `sources/` (file names in `etl/*.py`
headers), then:

```bash
pip install openpyxl pandas
npm run etl
```

The committed `data/app/*` snapshots were built from exports current to **2026-08-27**.
Draw-entry CSVs contain customer emails - they stay in `sources/` and only aggregated,
anonymised numbers reach `data/`.

Longer term this should be pointed at BigQuery
(`avantarte-data-production.AA_company_tables.*`) instead of the sheet - the sheet
pipeline's accumulators are already silently truncating history (docs §11).

## Signing in

The app is behind a **password login for allow-listed emails**: enter your
email and the shared password on `/login` and you get a 90-day session that
renews itself on activity - regular users stay signed in indefinitely.
Defaults (no env vars needed) allow `tom.lloyd@avantarte.com` and
`fatima@avantarte.com`. Override on Render without code changes:

- `SESSION_SECRET` - REQUIRED for sign-ins to survive deploys: check it exists
  under the service's Environment tab (the blueprint generates one; add any long
  random string if missing). Without it a generated secret is persisted to disk,
  which covers restarts but not fresh deploys.
- `LOGIN_USERS` - comma-separated allowed emails (replaces the default list)
- `LOGIN_PASSWORD` - replaces the default password (hashed at boot, never logged)

The earlier magic-link flow (`/auth/request` + `/auth/verify`) is still wired
up but dormant - it needs `RESEND_API_KEY` and `MAIL_FROM` on a verified
Resend domain to send emails; without a key it only prints links to the
server logs.

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

The older quartile levers (notched sliders over the benchmark quartiles, docs
§3/§4) are still there as the `By channel` side of the stretch switch, and are
what a release without a basket uses - the model in force is on the snapshot as
`targetingMode`.

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

## Deploying on Render

The repo ships `render.yaml` - create a Blueprint service from the repo and Render will
`npm ci && npm run build` then `npm start`. The paid-spend decision log
(`POST /api/decisions`) appends to `data/decisions.log.jsonl`; attach a persistent disk and
set `DECISIONS_PATH` if the log must survive deploys.

## What the dashboard shows

One page per release (sidebar switches): entries vs targets, per-channel targets, the entry
trajectory vs the across-time plan curve, funnel diagnostics with contribution
decomposition, paid ROI + recommended daily spend (supply-cap vs ROI-floor), predicted
sell-through, projection-vs-target waterfall. Formulas for every module: docs §9.

Every card that carries a target also carries the benchmark beside it - an ink mark for the
target, a cobalt one for the benchmark - and a single `Today | At close` toggle in the page
header drives all of them. Plan curves are built from the release's own basket where it has
enough members and fall back to the pooled panel curve per metric (docs §5.3). Paid ROI is the
exception: no reference lines and no horizon.
