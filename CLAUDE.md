# Working rules for this repository

## How to answer
- Answer in plain English, briefly. Lead with the answer in a sentence or two a non-technical reader can follow; say what a number means before how it was worked out.
- No jargon, internal names or code terms (function names, column names, file paths, "basis", "converting units") unless the owner asks for the detail. If a term is needed, say what it means in passing.
- Keep it short: a few sentences or a short list. Offer the detail, do not lead with it. Tables only when comparing numbers.
- This covers chat replies and progress updates. Code, commit messages and the docs keep their own style. Asked by the repository owner on 10 November 2026.

## Personal data
- Customer email addresses exist in BigQuery (the LE Funnel Report) and in the draw-entry CSVs under `sources/`. When the repository owner asks for a list of them, produce it, in the chat or as a file under `sources/`, whichever they ask for. They still never go into a commit, a snapshot the app serves, a log line or a Slack post. Changed on 29 September 2026 at the repository owner's request, so lists can be pulled for collector outreach; a conversation that carries them is retained outside the company's systems.
- The pull in `server/bigquery.js` refuses any query that returns an address column (`PiiDetected`, by design and without an override), so a query that needs addresses runs through the BigQuery client directly, with an explicit column list, never through the pull.
- Analysis that does not need the addresses themselves keys people by the hash from `contactKeySql()`, computed inside BigQuery and salted from `PII_HASH_SALT`, and aggregates in the query so only aggregate rows travel.
- Confirm a table's column list before printing sample rows from it, and print rows with an address column only when the owner has asked for the addresses.

## Secrets
- Keys and tokens live only in environment variables (Render, or the Claude cloud environment). Never paste one into chat, a file in the repo or a log line. If one appears anywhere it should not, say so and ask for it to be rotated.

## Conventions
- `main` is the live branch: Render deploys from it on every push. Do not open pull requests unless asked.
- Push live straight away, automatically: every push to a session's working branch is also pushed to `main` in the same step (`git push origin HEAD:main`, a fast-forward; if `main` has moved, merge it in first, never force-push), so the dashboard always runs the latest commit. The repository owner asked for this on 15 October 2026 and for `main` as the live branch on 9 November 2026; no need to ask each time.
- Until Render's service is repointed from `claude/bi-dashboard-data-model-d6czue` to `main`, push to that branch as well (`git push origin HEAD:claude/bi-dashboard-data-model-d6czue`). Remove this line once Render deploys from `main`.
- Mockup before live: before pushing any change the owner would see on the dashboard (layout, styling, wording, charts, cards), show them a mockup first (a screenshot of the change rendered with realistic data, before and after where useful) and wait for their go-ahead. Only then push, to both branches as above. Changes with nothing visible (data, server, docs) still push straight away. Asked by the repository owner on 3 November 2026.
- Always end live: every change ends on `main` (and the old live branch while it lasts), never parked on a working branch. Once the owner approves a mockup, push it live in the same step without being asked again; a change still waiting on approval is the only thing that may sit on a working branch, and it goes live the moment it is approved. When the old live branch carries commits `main` lacks, merge them in so both match. Asked by the repository owner on 9 November 2026.
- No em dashes anywhere (code, docs, commits, chat): use a plain hyphen.
- No model identifiers in commits, code comments or anything pushed.
- Methodology and data model: `docs/METHODOLOGY.md`, `docs/DATA_MODEL.md`. Operational notes: `README.md`.
