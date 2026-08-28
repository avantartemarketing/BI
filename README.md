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

**Live (production):** the server pulls two tabs of the *LE Paid Calculator* Google Sheet
on boot and every hour (`server/sheets.js`), rewrites `sources/across_time.csv` and
`data/spend_daily.csv`, and reruns the ETL in place - no redeploy needed. Force a pull
with `POST /api/refresh` (signed-in session required). Configuration:

- `GOOGLE_SERVICE_ACCOUNT_JSON` - a Google service-account key (Sheets API enabled);
  share the sheet with the key's `client_email` as **Viewer** and the sheet can stay
  Restricted. While unset, the fetch falls back to the public CSV export, which only
  works while the sheet is link-shared.
- `SHEET_ID`, `SHEET_FUNNEL_TAB`, `SHEET_SPEND_TAB`, `REFRESH_MINUTES` - optional
  overrides; `SHEETS_REFRESH=off` disables the scheduler.

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
