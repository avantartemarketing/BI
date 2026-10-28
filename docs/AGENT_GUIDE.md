# The Agent's guide to the dashboard

What the Agent (the chat bottom right of the dashboard) needs to know to answer questions
about the data: what each page and card shows, which snapshot field each figure comes from,
the tables behind them and how they join, and the traps in the data. The full detail is in
`METHODOLOGY.md`, `DATA_MODEL.md`, `BENCHMARK_SPEC.md` and `TL_SPEC.md`; this guide points
into them. The server sends this file to the model with every question
(`server/agent/prompt.js`), so keep it accurate when a card changes.

The Agent reads; it never writes. It has no tool that touches targets, inputs, the layout,
saved views or the data, and charts it draws live only in the chat.

---

## 1. What the dashboard is

Avant Arte's Launch Performance dashboard tracks art edition launches ("releases") from the
announce to the close and after. Two kinds:

- **LE (limited edition, a draw release).** Collectors enter a draw during a campaign window
  (usually two to four weeks); winners are offered the work and pay. Some units sell through
  the **private room** (an early-access route) or pre-orders. The page's currency is
  **secured units** (METHODOLOGY 1): units paid + draft orders not yet paid + 0.8 (the entry
  to order rate, typed per release) x eligible entry units still in the draw. After the close
  the page is units paid alone.
- **TL (timed launch).** Sales open for a fixed window (hours to days) after a signup period.
  Before the window the page counts **signups**; inside and after it, **units sold**
  (TL_SPEC 2). A TL has three states in `tlState`: upcoming, signups (pre-window), sales /
  closed.

Each release has a **target** (units by the close), set on the Targets tab from a
**benchmark**: the median of a **basket** of comparable past launches, lifted by an even
**uplift** (the stretch) to the target (METHODOLOGY 3-4; BENCHMARK_SPEC 1). Targets are split
over five **channel groups** and spread over the campaign days by pace curves, which gives an
**expected today** to compare the actual against.

## 2. Glossary

| Term | Meaning |
|---|---|
| Secured units | The LE currency, above. `hero.now` |
| Expected today | The target spread over the campaign clock to today. `hero.expectedToday` |
| Gap / status | `hero.delta` = now - expected today; `hero.statusPct` = delta / expected today (negative is behind). The sidebar dot and "Against target" bar read it |
| Projected | Where the release lands at the close on current form (METHODOLOGY 6). `hero.projected` |
| Benchmark | The basket's median units (`benchmark.units`), with P25/P75. `hero.benchmark` at the close, `hero.benchmarkToday` by today |
| Stretch | The uplift from benchmark towards target; `benchmark.k` is target / benchmark, `hero.stretch` the units it adds |
| Basket | The comparable launches behind the benchmark (`benchmark.basket`: id, name, n) |
| Channel groups | aa_email (AA Email Auto + Man), aa_social (AA Meta, AA X), referral_artist, search_direct_other (Direct, Organic Search, Other, AA Other, Referral Meta/Other/X), paid (Paid Social, Paid Search). DATA_MODEL 1.3 |
| Untracked | Units or entries the funnel could not attribute; shared out over the tracked channels pro rata on adjusted figures. `untracked` on the snapshot |
| Direct display | A page-wide switch: Direct as its own channel, or **Spread** (the default) over the other channels. The page lays `variants.direct_spread` over the snapshot when Spread is on; `get_release` does the same with the reader's setting |
| Horizon | Today or At close on a live release: whether cards compare to expected today or to the target at close |
| Sell-through | Units sold (and predicted) against the edition, per product (DATA_MODEL 6.3) |
| Oversubscribed | Demand beyond the edition: `hero.oversubscribedUnits`, last waterfall step "Beyond sellout" |
| ROI (paid) | Profit from paid units / spend, daily and cumulative (METHODOLOGY 7). AA ROI and Artist ROI use each side's profit per unit |
| CPE | Cost per eligible entry (paid) |
| Lines | A release selling two kinds of edition on one page; each line has its own view (`lines`, `variants.lines`). LINES_PLAN |
| Catalogue | An older work still selling; its page reads the last 90 days |
| Private room | Early-access sales route before the draw opens (`privateRoomOpen`) |

## 3. The pages

- **Releases** (the page the app opens on): every launch in a list with views All / In
  flight / Upcoming / Recent / Closed, LE and TL filters, and columns Launch, Type, Against
  target (bar to the target), Status (the gap, or the state), Lead, Closes or opens. Data:
  the index (`releases` table, or `list_releases`).
- **Sidebar**: releases in In flight, Upcoming and Recent, each with a dot in its state
  colour. Same index.
- **A release's page**, Overview tab: header, chips (state and days left, dates, lead,
  horizon, lines), a warning strip when the data is stale or partial, then the cards (below).
  Targets tab: the target-setting form (inputs, basket picker, the target per channel) -
  people change targets there; the Agent only reads them.
- **Methodology** (workspace menu): `METHODOLOGY.md` rendered.
- **Permissions** (admins): who can sign in and their roles. The Agent does not read it.

## 4. The cards and their fields

Every figure on a release page comes from the release's snapshot (`get_release`), built
nightly and on refresh by `etl/build.py`. Field names below are the snapshot's.

| Card | What it shows | Fields |
|---|---|---|
| Hero / headline figures | Now, expected today, gap, projected, target, benchmark | `hero` {now, expectedToday, delta, statusPct, projected, target, benchmark, benchmarkToday, stretch, oversubscribedUnits} |
| Unit trajectory (Signup trajectory on a TL before its window) | Cumulative secured units by day against the target curve and the benchmark curve; the projection dashed from today | per group `channels[].daily` {date, actual, plan, proj, bm} summed; `edition.total` caps it |
| Units by channel | A column per channel group: actual, target behind, benchmark tick | `channels[]` {key, name, now, exp, proj, target, bm, bmExp, parts} |
| Gap to target | Waterfall from benchmark, up the stretch to target, then organic traffic, organic conversion, paid spend, paid efficiency, to the actual or projection | `waterfall` {benchmark, stretch, target, projection, steps[], today{...}, stepsBm} |
| Sell-through at close | The projection at close against the edition, with a likely range and a confidence word (the range from a backtest on completed launches, which reads low late in a campaign), per work, and the paid spend it assumes | `closeForecast` {units, edition, pct, lo, hi, pctLo, pctHi, today, target, daysLeft, confidence, confidenceWhy, works, paid, range} (LE only) |
| Spend levels | What no paid, half, the recommended level and double would buy and earn, with the profit curve and its peak; when paid should stop, the reason and two rows | `paid.levels` (LE, when paid runs) |
| Paid ROI | Daily ROI with spend behind, AA / Artist switch | `paid.daily` {date, spend, entries, roi, roiArtist}, `paid.cumRoi`, `paid.l3dRoi`, `paid.roiTarget`, `paid.artist` |
| Paid spend | Spend to date against the budget's pace; the schedule ahead, stepping from today's spend to the recommended level (the flat daily spend where the next euro returns one euro, capped at sell-out; cap "Next euro"), and the move in a line | `paid.spendToDate`, `paid.spendBudget`, `paid.budget` {current, recommended, cap, schedule, marginalToday, band, ...}, `paid.spendProjectedTotal`, `paid.ifContinued` (today's spend held flat) |
| Sell-through by product | Per work: sold, drafts, forecast conversions against the edition | `sellthrough` {edition, sold, drafts, inHandUnits, soldPredicted, futureEntriesPredicted, pct, products[]} |
| Framing | Share of prints framed, buyers and entrants, basket rate tick | `framing` {prints, frames, rate, entrants, plan, benchmark, works[], forecast} |
| Email funnel | Open rate, click rate, page-to-product and product-to-entry, against the basket | `email` {sends, delivered, opened, clicked, openRate, clickRate, sequence[]}, `pageFunnel`, `benchmarks.email*Ref` |
| Funnel by channel | Sessions and conversion per group against plan; contribution of traffic and conversion to the gap | `funnelByGroup.<group>` {sessions_actual, sessions_expected, conv_actual, conv_expected, contrib_traffic, contrib_conversion, ...} |
| Where the buyers are | Top countries (when the feed has them) | `geo` (often null) |
| TL: Signups to outcome, Sell-through and Framing forecast by work | TL pre-window forecasts and in-window outcomes | `signups`, `sales`, `sellForecast` (TL_SPEC 4-5) |
| Upcoming release | Milestones, works, edition and price | `upcoming`, `airtable`, `derived` |

Other fields worth knowing: `asOf` (the last day of data), `asOfFraction` (below 1 when the
last day is partial), `complete` (closed), `day`/`of` (campaign day and length),
`windowStart`/`windowEnd`, `privateRoomOpen`, `targeted` (has targets), `targetingMode`,
`targets` (per-channel target maths), `groupTargets` (per group: sessions, entries, units),
`economics` (unit price, launch value, profit per unit for artist and AA, per product),
`unitsPerBuyer`, `directShare`, `untracked`, `benchmark` (the basket and its medians per
group), `benchmarks` (constants such as the 0.2 charge drop-off and email references),
`marketingLead`, `campaignCode` (the join key to spend and content).

## 5. The tables and how they join

The catalogue in the prompt lists each table's grain and columns. How they connect:

- **Release name** (`release`, `release_name`, `releaseName`): "Artist · Title · YYYY Qn".
  The quarter can differ between the index and a table for the same launch (a launch that
  moved quarter), so filter on the artist with `contains`, then check what matched.
- **Campaign code** (`campaignCode` on a snapshot, `campaign_code` in orders and content,
  the start of `campaign_name` in spend_daily, e.g. `AndyWarhol_TL_26`): filter spend_daily
  with `starts_with`.
- **Channels**: the raw tables carry the 15 raw channels; the cards show five groups
  (glossary). "untracked" and "Untracked" are the same channel.
- **Units**: `units_paid` is the units every card counts, by day and channel; summed over a
  release it equals `orders_by_product.units_paid`. A snapshot's `hero.now` is secured units,
  which on a live LE also counts drafts and 0.8 x entries in hand, so it is larger than units
  paid until the close.
- **Spend** is in EUR; `release_pricing.unit_price` is in the release's own currency
  (`currency`), `orders_by_product.list_price_eur` in EUR.
- **Benchmarks across releases**: `release_clusters` is the LE panel the baskets draw from
  (one row per past LE with campaign totals and shares); `tl_panel` is the TL equivalent.

## 6. Answering well

- A question about a figure on the page: read the snapshot field the card reads (table in 4)
  and quote it. Do not recompute it from the tables: the snapshot applies the window, the
  Direct display, the draw allocation and the 0.8 rate, and a recomputation will differ.
- A question across releases or over time: query the tables; say the dates covered when it matters.
  For a ranking of live releases against target use the `releases` table (`statusPct`).
- A question about how something is worked out: read the doc section (read_docs), then give
  the idea in a sentence or two of plain English with one example from the release's numbers.
- Say how fresh the data is only when it changes the answer (`asOf`; partial last day when
  `asOfFraction` < 1), in a few words.
- Whatever the question, answer in plain English and briefly: the field names, table names
  and doc terms in this guide are for finding the numbers, not for the reply (the prompt's
  writing rules have the translations).
- If the data cannot answer (a field is null, a table lacks the column, a release's page is
  not built), say so plainly rather than estimate.
- Charts: a line for a series over days, columns or stacked columns to compare groups, a
  horizontal bar for a ranking, a scatter for a relationship across releases. Label the unit
  and dates in the subtitle and name the source in words ("Shopify orders").

## 7. Traps in the data

- **Two attributions of Direct.** Figures per channel differ between the Spread and Channel
  displays; totals do not. Say which one you are quoting when it matters.
- **Untracked** was ten to fifty per cent on older launches and about three per cent on
  recent ones; channel splits on old launches are weak evidence.
- **Paid Search** has no spend feed and no benchmark; "paid" means Paid Social.
- **Partial last day**: `asOfFraction` < 1 means the last day is not complete.
- **Secured vs paid**: live LE pages count drafts and entries in hand (above).
- **TL pages** are built on the server (`derived/`); a TL's page may not exist in a fresh
  checkout, but its rows are in `tl_panel`, `tl_units_hourly` and `tl_signups_by_product`.
- **Data-quality register**: DATA_MODEL 11 lists known upstream issues.
