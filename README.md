# Avant Arte Launch BI

Launch-performance dashboard for releases (LE-first), built from the reverse-engineered
target-setting model. **Read [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) first** - it specifies
how every number and target is calculated, where each feed comes from, and the data-quality
issues found in the current tooling.

## Layout

```
docs/DATA_MODEL.md      the specification: target model, benchmarks, across-time curves,
                        paid model, draw-entry semantics, metric map, data-quality register
etl/                    Python pipeline
  release_inputs.json     hand-entered launch inputs per release (the human decisions)
  benchmarks.json         frozen benchmark values (v1; recompute policy in docs §4)
  extract_spend.py        Meta spend by campaign × day  (from the workbook snapshot)
  extract_content.py      Emplifi posts by campaign     (from the content export)
  build.py                computes targets, trajectory curves, and per-release snapshots
data/
  spend_daily.csv         extracted spend facts
  content_posts.csv       extracted content facts
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

## Refreshing data

**Live (production):** on boot and every hour the server rewrites
`sources/across_time.csv` and `data/spend_daily.csv` and reruns the ETL in place - no
redeploy needed. Force a pull with `POST /api/refresh` (signed-in session required).
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
  both queries filter on the partition column.
- `BIGQUERY=off` forces the sheet path back on. `BQ_ALLOW_SHRINK=1` disables the guard
  that refuses to replace a long history with a much shorter one.

The funnel table is required; **spend is optional**. A service account granted the funnel
dataset but not `meta_ads_insights_export` still refreshes the funnel - the previous
`data/spend_daily.csv` keeps serving and the refresh note says spend was unavailable and
why, rather than the whole pull failing on a 403. `BQ_SPEND=off` skips the spend query
outright.

Check the connection without writing anything: `node server/bigquery.js` prints the row
counts and GB scanned; add `--write` to replace the CSVs.

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
HubSpot campaign name matches the release's campaign code, or the code appears in the
email name; the GEN/CUS/INS send-type filter still reads the name convention. Without
the token the committed CSV snapshot is used. Instagram content
(`data/content_posts.csv`) remains a manual export.

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
model levers (notched sliders over the benchmark quartiles, per docs §3/§4).
The derived-targets rail recomputes live in the browser via
`shared/targetModel.mjs`; **Save** persists the inputs (`POST /api/inputs/:id`)
and the server retargets the release snapshot in place (`server/retarget.js`) -
plans, expected-today, projections and the rail all update without a full ETL
run. Full daily-domain refreshes still come from `npm run etl`. Saved inputs
live in `data/app/inputs.json` (ephemeral on Render's free disk - copy changes
back into `etl/release_inputs.json` to make them permanent).

## Deploying on Render

The repo ships `render.yaml` - create a Blueprint service from the repo and Render will
`npm ci && npm run build` then `npm start`. The paid-spend decision log
(`POST /api/decisions`) appends to `data/decisions.log.jsonl`; attach a persistent disk and
set `DECISIONS_PATH` if the log must survive deploys.

## What the dashboard shows

One page per release (sidebar switches): entries vs targets, per-channel targets, the entry
trajectory vs the pooled across-time plan curve, funnel diagnostics with contribution
decomposition, paid ROI + recommended daily spend (supply-cap vs ROI-floor), predicted
sell-through, projection-vs-target waterfall. Formulas for every module: docs §9.
