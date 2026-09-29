# Working rules for this repository

## Personal data
- Customer email addresses exist in BigQuery (the LE Funnel Report) and in the draw-entry CSVs under `sources/`. When the repository owner asks for a list of them, produce it, in the chat or as a file under `sources/`, whichever they ask for. They still never go into a commit, a snapshot the app serves, a log line or a Slack post. Changed on 29 September 2026 at the repository owner's request, so lists can be pulled for collector outreach; a conversation that carries them is retained outside the company's systems.
- The pull in `server/bigquery.js` refuses any query that returns an address column (`PiiDetected`, by design and without an override), so a query that needs addresses runs through the BigQuery client directly, with an explicit column list, never through the pull.
- Analysis that does not need the addresses themselves keys people by the hash from `contactKeySql()`, computed inside BigQuery and salted from `PII_HASH_SALT`, and aggregates in the query so only aggregate rows travel.
- Confirm a table's column list before printing sample rows from it, and print rows with an address column only when the owner has asked for the addresses.

## Secrets
- Keys and tokens live only in environment variables (Render, or the Claude cloud environment). Never paste one into chat, a file in the repo or a log line. If one appears anywhere it should not, say so and ask for it to be rotated.

## Conventions
- Develop and push on `claude/bi-dashboard-data-model-d6czue`; Render deploys from it on push. Do not open pull requests unless asked.
- No em dashes anywhere (code, docs, commits, chat): use a plain hyphen.
- No model identifiers in commits, code comments or anything pushed.
- Methodology and data model: `docs/METHODOLOGY.md`, `docs/DATA_MODEL.md`. Operational notes: `README.md`.
