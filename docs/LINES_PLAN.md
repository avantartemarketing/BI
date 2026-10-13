# Lines: a release with two product groups

Plan for the Ai Weiwei toy-brick release of November 2026, and for any later
release that sells two kinds of edition on one page. Decisions taken with the
repository owner on 13 October 2026; the numbers are from Airtable at that
pull and from a dry run of the basket rule (`etl/baskets.similar_members`).

## 1. The release

Two Airtable project codes, one announce (29 October) and one close (30
November), one release page, one release name in the funnel export, one Meta
campaign with an ad set per code.

| Code | Products | Price | Edition each | Edition | Value |
| --- | --- | --- | --- | --- | --- |
| AiWeiweiLego2026 | 3 prints | EUR 2,500 | 100 | 300 | EUR 750k |
| AiWeiweiLegoMiddleFinger | 4 colourways | EUR 550 | 750 | 3,000 | EUR 1.65M |

The toy-brick target is well under its 750 per colourway. Airtable will carry
each product's `Target sell-through %`, which the model already reads, so the
targets land without typing and the baskets re-suggest when they do.

## 2. Why the model needs a change

Left alone, `etl/pricing.py` merges the two codes into one launch (same
artist, same close), prices it at the value-weighted mean of about EUR 727
over 3,300 units, and the basket rule looks for the eight launches nearest
that. Nothing on the draw panel is that size (We are the Revolution, 1,000
units, is the largest), so the basket reaches past x4 and benchmarks a EUR
2,500 print and a EUR 550 brick against the same medians. The per-product
sell-through rows work for seven products already, but targets, benchmarks,
plan curves, projections and paid are all release-level, so "how is each
line doing" has no answer beyond sold against edition.

## 3. The dry run

The basket rule run on each line alone, matched on the line's target units
and its own price (`as_of` 13 October 2026):

| Line | Matched on | Basket | Median demand | Reach |
| --- | --- | --- | --- | --- |
| Prints | 300 units, EUR 2,500 | Ai Weiwei's own four draws first (To Be Looked At, Multiple 2024 Q4, Multiple 2025 Q4, Arm), then Woo Kuk Won and the nearest others | about 260 | within x2 |
| Toy bricks at 4 x 200 | 800 units, EUR 550 | Albers, Mondrian, Murakami, James Jean, Cattelan (We are the Revolution, THERAPY), Cindy Sherman, Parra | about 830 | x2.7 |
| Toy bricks at 4 x 300 | 1,200 units, EUR 550 | the same, La Nona Ora in for Parra | about 880 | x4.0 |

The prints line benchmarks cleanly on the artist's own record. The toy line
benchmarks on the recent big multiples as long as it is matched on its
target, not its edition. Two baskets, summed, is the design.

## 4. Decisions

| Question | Decision |
| --- | --- |
| Identity in the feeds | One funnel release name, one Meta campaign, one ad set per line |
| Baskets | One basket per line, suggested by the existing rule on the line's size and price; the release benchmark is the two profiles summed |
| Stretch | K per line; where the stretch comes from is set per line |
| Sessions | Each line's sessions and conversion are its basket's; release sessions target is the sum and release conversion the blended rate; actual sessions stay release-level |
| Paid | Read Meta at ad set grain and map ad sets to lines, so spend, cost per entry and the recommendation run per line |
| Page | A line switch on the Overview like the Direct switch: Combined, Prints, Toy bricks |
| Targets | Airtable's target sell-through per product |

## 5. The model, per line

**Line key.** A line is the set of a release's products that share an Airtable
release code (`release` in `data/release_pricing.csv`, carried on each
product as `project_code` today and to be carried as `line` on the snapshot).
A release whose products carry one code has one line and behaves exactly as
today; nothing moves for the 360 releases on file. A manually added product
goes on the line typed for it, else the release's first line.

**Targets.** Line target = sum over its products of edition x target
sell-through, the same rule as the release target now. Release target = the
lines summed. Each line carries its target units as `edition.target` and its
full edition as `edition.total`, the way Warhol carries 2,440 against 6,100,
so the hero cap and room read against the edition and the basket matches on
the target.

**Price.** Each line's unit price is the value-weighted mean over its own
products, as a launch's is today. The release's blended price is kept for the
launch value and the 6% paid sense check, and is no longer what any basket
is matched on.

**Baskets.** `similar_members` runs once per line with the line's
`edition_size` and `unit_price`, the release's own name excluded as now, the
artist's own launches first. The Target setting tab shows one picker per
line, each overridable, each with its own thin and reach warnings. The saved
input becomes `baskets: {line: basket_id}` beside the single `basket` for
one-line releases.

**Benchmark.** The release profile is the line profiles summed, metric by
metric: `units`, `units_by_group`, `sessions`, `sessions_by_group`,
`entries`, paid units, cost per paid unit weighted by paid units. Conversion
per group is blended: line entries over line sessions, summed across lines.
`campaign_days`, `private_room_share` and the curves are per line and the
release reads the target-weighted combination. The picker and the tab show
the line profiles and the sum.

**K and stretch.** `K(line) = line target / line benchmark demand`. The
release K is the ratio of the sums, shown on the tab as derived and never
typed. `stretch_from` becomes per line (`stretch_from: {line: shares}`), the
sliders on the tab grouped under the line, the existing single-line form
kept for every other release. Channels in plan stay per release: a channel
the release does not run is off for both lines.

**Entries.** `target_entries(line) = line target / entry rate`, the release's
entry rate and pre-order rate as now (the prints carry a pre-order window;
the rate is the release's, 0.95 by default).

**Paid.** Per line: `paid_units = line benchmark paid units x K(line)`,
`paid_budget = paid_units x cost per purchase(line)`, the cost per purchase
from the line's own typed figure, else its basket's median, else the panel's
EUR 177. The release's paid budget is the sum and the 6% check reads the
release's launch value.

**Curves.** Each line's plan curve is its own basket's median curve, per
metric and group, with the pooled panel behind a thin basket as now. The
release curve at each `pdsa` is the target-weighted sum of the lines', so the
combined plan is consistent with the two line plans by construction.

**Actuals per line.** Entries by draw come from the draw-entry exports (one
draw per product, entry day on each row) and units by product from
`data/units_paid.csv`, both already by day, so a line's entries, units,
secured units and sell-through are observed. Sessions are not: the page is
shared. On a line view the sessions card shows the line's expected sessions
from its basket and says the traffic is shared; the funnel's session rungs
and the session-to-entry conversion are shown on the combined view only, and
the line view's funnel starts at entries.

**Projections.** The organic projection runs per line on the line's entries
and units curves and its own K. The paid projection runs per line on the
line's ad set (below). The release projection is the sum.

**Status colours.** Per line and for the release, by the same rules
(METHODOLOGY section 4 step 6). The sidebar dot is the release's.

**Sell-through card.** Rows grouped under a line header with a line subtotal.
Two flags on the card for this release: the allocation rule awards a
flexible entrant the priciest product first, so an entrant in both lines is
counted on the prints; and the units-per-buyer curve reads 1 + 0.178 ln 7 =
1.35 pieces per buyer, fitted over nothing like this mix, so the typed rate
on the tab should be set from the brief.

## 6. Paid at ad set grain

`data/spend_daily.csv` is campaign x day (`campaign_name, spend_date,
impressions, reach, link_clicks, spend`), pulled by `server/bigquery.js` as
`SELECT *` from `meta_ads_insights_export`. To run paid per line the pull
needs ad set rows. Open check, first thing to do: read the export's schema.
If it carries `adset_name`, the pull adds it and `spend_daily.csv` gains an
`adset_name` column (blank on old rows, which stay campaign-level). If it
does not, the data team adds an ad-set-level export, or the pull reads the
Meta Marketing API at `level=adset` for the ticked campaigns.

Mapping: on the Target setting tab each ad set under a ticked campaign is
assigned to a line (suggested by name, the line's code in the ad set name),
unassigned ad sets counting on the release and on no line. Paid entries per
line come from the funnel's paid entries by draw, where the draw names the
product; paid sessions stay release-level. Per line the Paid module runs as
now: spend to date, cost per entry, trailing-3-day CPE and drift, the
run-rate projection and the recommendation.

## 7. Build order

1. **Pricing and the line key.** `etl/pricing.py` keeps merging the two
   codes into one launch for the panel, and additionally emits the lines
   (code, products, units, value-weighted price, target units). Products on
   the snapshot carry `line`. Tests: a two-code release yields two lines; a
   one-code release yields one and an unchanged snapshot.
2. **Baskets and target maths per line.** `etl/baskets.py` profiles per
   line; `etl/build.py` sums the profiles, computes K, stretch, entries and
   paid budget per line and for the release. `tests/basket_parity.mjs` and
   `tests/channels_off_parity.mjs` extended with a two-line fixture; a
   one-line fixture must come out identical to today, to the unit.
3. **Curves, actuals and projections per line.** Entries by draw and units
   by product rolled to lines by day; line curves; release curve as the
   weighted sum; projections per line. Test: the line projections sum to
   the release projection on every day.
4. **Paid at ad set grain.** Schema check, pull, `adset_name` column, the
   ad set to line mapping in the inputs, Paid module per line.
5. **Target setting tab.** Products grouped by line, one basket picker per
   line, stretch sliders per line, the ad set mapping, derived release K.
   Save re-runs per line on the server as it does for the release now.
6. **Overview.** The line switch beside the Direct switch; cards re-read for
   the line; the sessions card's shared-traffic note; sell-through grouped
   by line. The switch is hidden on a one-line release.
7. **Docs and the explain popups.** METHODOLOGY gains a section on lines;
   DATA_MODEL records the line key, the summed profile, the per-line inputs
   and the ad set column; shift-click working shows the line's figures.

Steps 1 to 3 are ETL and run offline against the panel on file. Step 4
depends on the schema check. Steps 5 and 6 need the snapshot shape from
steps 2 and 3 settled first.

## 8. Open checks

- Whether `meta_ads_insights_export` carries ad set columns (section 6).
- The toy-brick target sell-through, to be entered in Airtable on the four
  records; the line's basket and K wait on it.
- The units-per-buyer rate for this release, from the brief.
- Whether the prints' pre-order window changes how their entries are read
  (the funnel's `preorder_app` rows); the release-level pre-order rate
  applies as now unless it does.
