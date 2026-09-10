# Working rules for this repository

## Personal data
- Customer email addresses exist in BigQuery (the LE Funnel Report) and in the draw-entry CSVs under `sources/`. They never leave BigQuery or `sources/`: never onto disk elsewhere, never printed to the terminal (terminal output is part of the retained conversation), never into a snapshot, a download, a commit or a chat message.
- Query BigQuery with an explicit column list; `SELECT *` on a table with an address column trips `PiiDetected` in `server/bigquery.js`, by design and without an override.
- Per-contact analysis uses the keyed hash from `contactKeySql()` computed inside BigQuery, salted from `PII_HASH_SALT`. Aggregate in the query so only aggregate rows travel.
- Do not print sample rows from any table until you have confirmed its column list holds no address field.

## Secrets
- Keys and tokens live only in environment variables (Render, or the Claude cloud environment). Never paste one into chat, a file in the repo or a log line. If one appears anywhere it should not, say so and ask for it to be rotated.

## Conventions
- Develop and push on `claude/bi-dashboard-data-model-d6czue`; Render deploys from it on push. Do not open pull requests unless asked.
- No em dashes anywhere (code, docs, commits, chat): use a plain hyphen.
- No model identifiers in commits, code comments or anything pushed.
- Methodology and data model: `docs/METHODOLOGY.md`, `docs/DATA_MODEL.md`. Operational notes: `README.md`.
