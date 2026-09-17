# Benchmark, target and stretch — implementation contract

The settled design from the "Benchmark and Target Containers" canvas. This file is the
contract every part of the build works to: the snapshot shape, the maths, the API and the
drawing grammar. Where it disagrees with an older doc, this file wins.

## 1. The three references

| | what it is | drawn as |
|---|---|---|
| **Benchmark** | what launches in the matched basket typically reach: the **median** of that basket, per metric and per channel. One value, never a band. | a **dotted outline** of the column it would make, `#ea8f66`, drawn over the target's fill - tracing the fill's edges where it sits inside the target, standing in the air above it where it does not |
| **Target** | benchmark × K, the business target | the **fill**: `#f8ccba` from zero to whichever of target and benchmark is lower, `#f8ddd0` from the benchmark up to the target when the target is the higher |
| **Stretch** | target − benchmark = benchmark × (K − 1) | the lighter band of the fill, one line of words at the foot of the channels card, and the opening step of the two waterfalls (§9); never a band of its own |

`K = edition_size / benchmark_units_total` — one **even uplift** applied to every volume
(sessions, entries, units, spend), in every channel, at every funnel stage and on every day
of the campaign. **Conversion rates are held at the benchmark.**

**Both references on every bar, always** - the "G" board of the Target and Benchmark Together
canvas. The fill says what the business asked for and where the basket agrees with it; the
outline says what the basket typically reaches. Nothing about the drawing changes between a
target above its benchmark and one below - only where the outline sits - so the legend has the
same shape on every card, and a benchmark above its target needs no special case.
Percentages, RAG colours and the headline deltas read **against the target**: it is what the
business committed to, and the benchmark is there to say how ambitious that commitment was.

Two earlier grammars are retired by this one: the first build's pair of marks (a near-black
target line beside a cobalt benchmark line, both crossing the fill), which made every reading
a three-way comparison in two hues; and the page-level `Against Benchmark | Target` toggle that
briefly replaced it, which drew one reference at a time and left the other as a footer figure.

## 2. Horizon: one page-level toggle

A single `Compare Today | At close` control in the page header drives every container. No
container carries its own horizon toggle (the Channels card keeps `% | Units` only).

- **Today** - actuals vs the target and the benchmark for today.
- **At close** - projection vs the target and the benchmark for the whole campaign.

Naming, both horizons: the references are **"target"** and **"benchmark"**. The words
"expected" and "benchmark pace" are retired. Where a label needs to disambiguate it reads
`target today` / `benchmark today`; `refWords(horizon)` in `ui.jsx` is the one place the
words come from.

Containers with a single horizon ignore the toggle: **Funnel by channel** and **Organic
funnel** are always Today; **Paid ROI** has no horizon and **no reference at all**.

## 3. Basket → benchmark

### 3.1 Ready-made baskets (`etl/baskets.py`)

Built from `data/release_clusters.csv` (rows with `panel == "draw"`, 108 of them) and
`data/release_cluster_baskets.json`.

| id | name | membership |
|---|---|---|
| `cluster_0` | Paid-led headline launches | `cluster == 0` |
| `cluster_1` | Paid-supported small editions | `cluster == 1` |
| `cluster_2` | Email-led collector launches | `cluster == 2` |
| `cluster_3` | Artist-audience draws | `cluster == 3` |
| `all_12m` | All draw launches, last 12 months | `window_end` within 365 days of `as_of` |
| `same_artist` | Same artist, earlier launches | same `artist`, `window_end < window_start` of this release; **disabled when < 3 members** |

A release is **never a member of its own benchmark** — always drop its own
`release_name` from any basket.

`similar_size` is the suggested basket and the one nearly every release lands on. The clusters
are **shapes, not sizes** (cluster 0 runs from 15 units to 987 with a median of 214), so
benchmarking a large edition against its cluster compares it to launches an order of magnitude
smaller and calls the difference a stretch. `similar_members` therefore searches from strictest
to loosest and stops at the first rung that answers:

1. the shape cluster intersected with a size band, widening the band through 2×, 2.5×, 3×, 4×,
   needing 8 members;
2. the size band alone, widening the same way, needing 8;
3. the **widest** band alone (4×), needing only the 3-member minimum — the widest, not the
   first that clears 3, because once the band cannot be tight enough to be a real comparable
   there is nothing won by keeping it narrow and a median over three launches moves under any
   one of them;
4. failing all of that, simply the launches nearest this edition in size, in log space.

**Every release gets a benchmark.** An edition larger than anything on record is benchmarked
against the largest launches there have been, and the multiplier states how far past them it is
being asked to go: Andy Warhol at 2,440 units, against a panel whose biggest launch ever is 987,
lands on the six biggest launches on file (both Cattelan editions among them), a benchmark of
865 and an uplift of ×2.82. "Nearly three times the biggest thing we have ever done" is a plan
someone can argue with; a blank panel is not. Such a basket is flagged `thin` (under 10 members)
and carries `scaleMismatch`, so a card can say the basket is nowhere near this edition's size.

### 3.2 Profile (the medians)

```
profile = {
  "n": int,                       # members used
  "members": [release_name, ...],
  "units": float,                 # median tot_total_product_units        -> 214
  "units_p25": float, "units_p75": float,
  "sessions": float,              # median tot_sessions_total             -> 23543
  "entries": float,               # median tot_draw_entries_eligible_units
  "campaign_days": float,         # median campaign_days
  "private_room_share": float,    # median
  "share_units":    {group: float},   # median unit_share_<g>, renormalised to sum 1
  "share_sessions": {group: float},   # median sess_share_<g>, renormalised to sum 1
  "conv":           {group: float},   # median conv_sess_entry_<g> (0 when no history)
  "units_by_group":    {group: share_units[g]    * units},
  "sessions_by_group": {group: share_sessions[g] * sessions},
}
```

Groups are the five display groups: `aa_email`, `aa_social`, `referral_artist`,
`search_direct_other`, `paid`.

Per-channel benchmarks are **median share × median total**, never the median of the
per-channel column — so they sum exactly to the headline median. Medians over an empty or
all-NaN column are `0.0`, never NaN.

A basket with fewer than **3** members cannot be used (the caller falls back to the
suggested cluster and records `basket.thin = True` when `n < 10`).

### 3.3 Suggestion

`suggest_basket(panel, release)` returns the ready-made id for a release:

1. If the release is in the panel and has a `cluster`, use `cluster_<n>`.
2. Otherwise use `nearest_cluster` if present.
3. Otherwise pick the cluster whose median units are closest to the edition size in log
   space, tie-broken by paid-session share against the release's paid plan.

## 4. Target maths (`etl/build.py`)

When a release has a benchmark basket, `targeting_mode` is `"benchmark"`; otherwise the
existing quartile-lever model runs unchanged (`"levers"`).

```
K            = edition_size / profile["units"]
units[g]     = profile["units_by_group"][g]    * K       # sums to edition_size exactly
sessions[g]  = profile["sessions_by_group"][g] * K
entries[g]   = units[g] / e2o                            # e2o = eligible_entry_to_order (0.8)
paid_budget  = profile["units_by_group"]["paid"] * cost_per_purchase["Median"] * K
```

`compute_targets` in benchmark mode returns the **same top-level keys** as the lever model
so nothing downstream breaks: `edition_size`, `paid_pct`, `paid_units`, `organic_units`,
`pr_other_pct`, `pr_units`, `draw_units`, `per_channel`, `pr_sessions`, `paid{...}`,
`launch_value`, `organic_sessions_draw`, `total_sessions`, `entries_target`, `buffer`.

- `pr_units = units["aa_email"] * profile["private_room_share"]`, `draw_units = organic − pr`.
- `per_channel` is **synthesised** by splitting each group's target across its raw channels
  with the `order_split` medians from `etl/benchmarks.json`, renormalised inside the group.
  It carries the same keys as before (`quality`, `order_split`, `purchases`,
  `eligible_entries`, `sessions`, `session_to_entry`); `quality` is `"benchmark"`.
- `group_targets(targets)` is unchanged and must still sum to the edition size.

### 4.1 Pace curves

`build_curves(at, members=None)` gains an optional member filter. The **basket curve** is
built from the basket's own members; when fewer than 4 members qualify for a metric the
function already returns `None` for that series and `curve_value` falls back to the pooled
curve. Curves are cached per basket id for the run.

```
benchmark_plan[g][d] = profile["units_by_group"][g] * curve(basket, g, "units", pdsa(d))
target_plan[g][d]    = benchmark_plan[g][d] * K
```

So target and benchmark stay in exactly the K ratio on every day — which is what makes the
even uplift legible on the trajectory.

### 4.2 Units per buyer

Targets are in units; campaigns reach people. On a multi-product release the median buyer
takes more than one piece, so a 900-unit target is not 900 people, and a model with no buyer
step implicitly assumes it is - overstating the audience a campaign must reach by the whole
multi-buy rate.

**The rate.** `units_per_buyer`, sourced in order from: what someone typed for the release;
the fitted curve at its product count (the curated `products` list, else `product_count`,
else the count the draw recorded); the basket's own median; then 1. The typed value comes
first because the curve is fitted on a handful of multi-product launches and the lead running
the release knows things it does not.

**The curve.** `1 + 0.178 x ln(products)`, least squares through the origin on the log of the
product count, so one product is exactly one piece per buyer by definition rather than by fit.
One monotonic curve, not a median per count: twelve launches at two products, six at three,
three at four and one each at five and six means a per-count median moves under any one of
them and says nothing at all about eight. The curve rises by construction and extrapolates
past the counts on file.

**The fit base is every release whose count is recorded**, not just the draw panel: how many
pieces a buyer takes when a release offers several is not a property of the draw mechanic, so
restricting it to draw launches threw away a fifth of the evidence for nothing. Releases with
fewer than ten buyers are left out, a rate over fewer than that being noise rather than a rate.

**Two signals count the products, and the fit uses both.** The multiset cap is authoritative
but only recorded from **2025-08-28**, which is 54 of the 357 releases in the feed. The number
of **distinct draws** reaches back to September 2023 and covers 126, because a release runs one
draw per product. Where both exist and the draw count is one or two it agrees with the cap
exactly, 38 cases out of 38. Above two it over-counts - re-runs and waves put one 3-product
release on 24 draws - and it is right only half the time there, so 3+ draws are read as
"multi-product, count unknown" and left out rather than guessed at.

Together they reach **115 releases** against 51 for the cap alone, and the fitted slope barely
moves, 0.178 against 0.182. That stability across a base twice the size is the strongest
evidence the curve is real rather than an artefact of a small sample. The draw count also
settles the older launches without appealing to the naming convention: before the cap existed,
single-draw releases run 1.000 units per buyer and releases with two or more run 1.061.

**No release type is excluded, and none should be.** How many pieces a buyer takes has nothing
to do with whether the release was an LE or a TL, and both are in the fit. What decides
membership is the **mechanic**, and only because both product-count signals live in draw-entry
events. Of the 357 releases, 155 ran a draw, 171 were public, 22 enquiry and 9 pre-order.

A public launch cannot be counted at all. One candidate is worth naming so nobody spends an
afternoon on it twice: `order_products` is **identical to `order_pieces` in all 26,948 purchase
rows** on file. It counts pieces, not distinct products. The tidy monotonic relationship
between its per-release maximum and units per buyer is therefore circular - both sides measure
how many pieces people bought - and against the draw counts we do know it is exact only three
times in five. The 157 releases from before the draw feed starts are out of reach for the same
reason.

`product_count` is the combined figure; `products` and `products_known` keep the cap's own
answer beside it, and `draws` the draw count.

**Where the uplift goes.** Entirely on buyers. The rate is held at the benchmark like every
other rate, so `benchmark.buyers x K == targets.buyers` exactly. Asking the stretch of
multi-buying would assume the release persuades people to take more pieces each, which no
lever on the page controls.

**Both sides of the rate come from the event feed** - purchased pieces over the people who
purchased them. Dividing the funnel export's units by the event feed's buyers mixes two counts
of the same thing, because the export's units include unconverted entries at the eligible
rate and those have no buyer yet.

**In the funnel.** `Session -> sale` is two things at once: how many sessions became a buyer,
and how many pieces each took. Those are a traffic-and-offer problem and a merchandising
problem, so the waterfall splits the step into `Session -> buyer` per channel and one
release-level `Units per buyer`. The decomposition is the same one-factor-at-a-time repricing
as before - `units = sessions x buyers-per-session x units-per-buyer` - so the steps still sum
to the gap; the two new steps sum to the old single one to the last unit. The multi-buy rate
is measured for the release, not per channel: the only buyer count that is neither
double-counted across channel-days nor missing where the channel feed does not reach is the
release's own distinct one. Where plan and actual rates are equal the second step is zero and
the card reads exactly as it did.

**Visible** as a Buyers row on the Derived targets rail, with its own benchmark and stretch.

## 5. Snapshot additions

All new fields are **additive**. Existing consumers keep working.

```jsonc
{
  "targetingMode": "benchmark",         // or "levers"
  "benchmark": {
    "basket": { "id": "cluster_0", "kind": "ready", "name": "Paid-led headline launches",
                "n": 33, "thin": false, "suggestedId": "cluster_0" },
    "units": 214.0, "unitsP25": 148.0, "unitsP75": 468.0,
    "sessions": 23543.0, "entries": 194.0, "campaignDays": 26.0,
    "k": 1.4019, "stretchUnits": 86.0, "stretchPct": 0.4019,
    "unitsByGroup":    { "aa_email": 83.5, ... },
    "sessionsByGroup": { "aa_email": 4579.0, ... },
    "convByGroup":     { "aa_email": 0.0155, ... },
    "paidBudget": 9735.0
  },
  "hero": {
    "...existing...": null,
    "benchmark": 214.0,          // at close
    "benchmarkToday": 132.0,     // benchmark pace by today
    "stretch": 86.0,
    "benchmarkPct": 0.1212       // secured vs benchmarkToday; null in lever mode
  },
  "channels": [ { "...existing...": null,
    "bm": 83.5,        // benchmark at close, this group
    "bmExp": 58.6,     // benchmark by today
    "daily": [ { "date": "...", "actual": 1, "plan": 1, "proj": null, "bm": 31.0 } ]
  } ],
  "funnelByGroup": { "aa_email": { "...existing...": null,
    "sessions_benchmark": 4579.0, "conv_benchmark": 0.0155 } },
  "sellthrough": { "...existing...": null, "benchmarkUnits": 214.0 },
  "paid": { "...existing...": null, "benchmarkUnits": 55.0, "benchmarkBudget": 9735.0,
            "unitsToDate": 44.0 },   // entriesToDate x (1 - drop-off); always present
  "waterfall": {
    "benchmark": 214.0, "stretch": 86.0, "target": 300.0, "projection": 336.0,
    "steps": [ ... unchanged ... ],
    "today": { "benchmark": 132.0, "stretch": 53.0, "target": 185.0, "actual": 250.0,
               "steps": [ {"key":"organic_traffic","label":"Organic traffic","value":52.0}, ... ] }
  }
}
```

`waterfall.today.steps` are the same four contributors measured **to date** (not scaled to
close): they must sum exactly to `actual − target`, with the rounding residual parked on the
largest step, exactly as the close steps do.

`hero.benchmarkToday` and `channels[].bmExp` use the basket curve at today's pdsa, so
`benchmarkToday × K == expectedToday` to within rounding.

`funnelByGroup[g].conv_benchmark` is the basket's median **units** over its median sessions
for that group, not its entries per session: it is read against `conv_actual`, which is
secured units per session, and the two have to be the same quantity.

`paid.unitsToDate` is the paid campaign's own entries one drop-off later, so the Paid spend
card's "to date", "projected", target and benchmark are all secured units. It is written in
both the targeted and the actuals-only build. `paid.entriesToDate` keeps its old meaning.

`hero.benchmarkPct` and the matching `benchmarkPct` on each `index.json` row are
`(min(secured, edition) − benchmarkToday) / benchmarkToday`. The sidebar's three-state dot
reads the **sign** of it; there is no threshold to pick, and 1/K runs from +15% to −54%
across the launches on file, so a fixed one is wrong on most of them. Lever-mode releases
carry `null` and fall back to a −10% band on `statusPct`.

## 6. API

- `GET  /api/baskets?release=<id>` → `{ suggested: "cluster_0", baskets: [ {id, kind, name,
  desc, n, disabled?, profile} ], saved: [...] }`
- `GET  /api/baskets/candidates` → `{ rows: [ {release_name, artist, title, quarter,
  window_end, campaign_days, units, sessions, paid_share, private_room_share, cluster,
  cluster_name} ] }` — the draw panel, newest close first.
- `POST /api/baskets` `{name, members[]}` → saves a custom basket to `data/app/baskets.json`
  and returns it with `kind: "saved"`.
- `POST /api/inputs/:id` additionally accepts
  `benchmark_basket: {kind: "ready"|"bespoke"|"saved", id?: string, members?: string[]}`
  and `stretch_mode: "even" | "levers"`. Validation: `kind` in the three values; `id` must
  resolve; `members` must be known release names, at least 3, and must not contain this
  release. An invalid basket is a 400, not a silent fallback.

Because the benchmark model needs the panel and the basket curves, **every** save on a
release whose snapshot carries a `benchmark` block re-runs the Python ETL, as does any save
that changes `benchmark_basket` or `stretch_mode`. Benchmark mode is sticky: the JS
`retargetSnapshot` only knows the lever model, so on a benchmark release it would move
`hero.target` and leave `benchmark.units` and `benchmark.k` behind, and the page would then
quote a target and a benchmark that no longer agree. `retargetSnapshot` stays as the fast
path for lever-mode edits only. The save response is unchanged in shape.

That ETL run rebuilds **one release**, not the catalogue: `build.py --release <id>` reuses the
curve panel already on disk, builds the one snapshot and patches its row into `index.json`.
A save cannot move any other page, and the whole-catalogue build spends its time on 354
actuals-only pages, the shared curve panel and seven other baskets' pace curves. The save
endpoint went from about 30 seconds to under 3, with byte-identical output for the release in
question. Creating a release still takes the full build, because promotion moves it out of the
derived set and only the full build clears the actuals-only page it leaves behind.

## 7. Drawing grammar (web)

Tokens, in `tokens.css` and `C` in `ui.jsx`:

| token | value | where |
|---|---|---|
| `--ref-base` / `C.refBase` | `#f8ccba` | the fill from zero to whichever of target and benchmark is lower - the ground both agree on |
| `--ref-stretch` / `C.refStretch` | `#f8ddd0` | the fill from the benchmark up to the target, when the target is the higher |
| `--ref-line` / `C.refLine` | `#ea8f66` | the benchmark's dotted outline; also the target's solid centre line on a rung and its solid edge on the trajectory, where there is no fill to be |
| `--ref-track` / `C.refTrack` | `#faf7f4` | a bar's remaining room out to the sellout |
| `--orange-light` / `C.orangeLight` | `#f2a07f` | the projection |

All five are one hue - the actual's own orange at five strengths. Two reference colours meant
two systems on every card; one hue means the reading is which mark ends where. The line tone
is a step darker than either tint so it reads on both. `C.ink` stays the colour of values and
body text; a reference never uses it.

`orangeLight` was the much paler `#f7c4ad` while the reference was a blue mark. With the
reference now a tint of the same orange sitting directly behind it, two pale oranges one in
front of the other told the reader nothing, so the projection was deepened until it reads as
orange against the reference tints without ever passing for the solid.

**Three layers, always in this order.** The target's fill takes the whole height of its
track; the benchmark's dotted outline is drawn over it with the same inset, so the two share a
silhouette; the actual sits inside both, inset top and bottom (about a fifth of the bar's
height), so the tints show on both sides of the orange and the three never read as one bar. In
the column form the inset is horizontal: fill and outline are inset 6% of the column, the
actual 27%. The outline takes no hover of its own (it would sit on top of every fill beneath
it and steal theirs); the figure it names goes in the fills' popups.

Labels that are placed by value never print through one another. Two rules, both measured in
pixels off the real element rather than assumed from a fraction, because the same fraction
buys different room on a one-column card and a two-column one:

- **Readings stacked on one line** (the trajectory's today column) spread with `spreadLabels`:
  sorted, pushed to a minimum gap, squeezed back inside the plot. The ticks and dots stay on
  their true values - only the text moves, which is what keeps a moved label honest.
- **A value-anchored label on an axis row with fixed end labels** (the hero and sell-through
  benchmark, against `0` and `sellout`) is placed by `axisLabelLeft`: centred on its tick
  where it fits, slid just clear of the end label where it does not.

`Tick`'s horizontal form takes an `inset`: the mark measures the **bar** it crosses plus the
standard 3px bleed, never the whole column. Column-wide segments leave only the column gap
between one and the next, and a row of them reads as a single broken line across the card
rather than as one mark per channel.

| container | Today | At close |
|---|---|---|
| **Units vs sellout** (hero) | fill = target today in two tints, outline = benchmark today, orange = to date, track = out to the sellout; two label rows above the bar, the benchmark on the upper and the target on the lower, so the two never print through each other; legend rows To date / Target today / Benchmark today | fill = projected; orange hatch = demand over the sellout, which takes the third legend row when there is any (the label above the bar still names the benchmark) |
| **Unit trajectory** | two columns wide. The target's pace as a solid 1.5px line, the benchmark's pace as a dotted 1.5px line, the actual in front, no area under any of them; three readings on the today line (benchmark, target, actual), each set where no curve, dot or other label runs; ahead of today the references drop back | both run the full width, plus a solid 2px level at the target and a dotted one at the benchmark, named together at the left |
| **Channels vs targets** | fill and outline per column, actual inside them, foot = % vs target with its own green/red; in the % view every target is 100% and, the uplift being one multiple, every outline sits at the same height too | same with the projected fill |
| **Funnel by channel** / **Organic funnel** | always Today. **The target runs down the centre of every rung**, the benchmark is a **dotted tick** wherever the basket's figure lands on the same log scale, orange/red dot = actual; ×4 either way fills the rung (`›` marks beyond). Pale bar spans centre→dot. The % and its RAG colour are vs target. Volume rungs carry the uplift, so the tick sits 1/K off the centre; rate rungs are held at the benchmark, so the tick sits on the centre line. | - |
| **Actual / Projection vs target** (waterfall) | Target today → Stretch (a bar in the stretch tint from the target down, or up, to the benchmark: the part of the gap that is ambition beyond the basket, its popup naming the uplift) → Benchmark today (dotted tick) → the steps, each read against the basket (`waterfall.today.stepsBm`, summing to actual − benchmark) → Actual today; with the stretch they sum to the gap the header prints. Without a basket the list opens at the target and the steps read against it. A `Drivers | Channels` toggle in the card's header picks the steps: the four stored contributors, or each channel's units against its own benchmark in the page's order (they add up to the release before the sellout cap, so on a sold-out release the last drop is the cap and the outcome's popup says so) | the same, ending at Projection (`waterfall.stepsBm`) |
| **Funnel by channel**, waterfall view | the same opening - target, stretch, benchmark - above the per-stage rows, every reference read off the basket's pace by today (sessions, implied sends, the benchmark budget) so the rows sum to actual − benchmark, off the same snapshot figures | - |
| **Paid spend / day** | both track bars carry fill and outline; the units row's % reads against the target; a `Stretch` row under `Capped by` states the uplift in words | same with the projected fill |
| **Predicted sell-through** | fill and outline out from zero, the segments inset inside them; two label rows above the bar as on the hero | at close the target *is* the edition, which the track already draws, so only the benchmark is labelled there |
| **Paid ROI** | unchanged - no reference | - |

The stretch is never a band of its own. It is the lighter tint of the fill, and it is the
same even uplift in every channel and on every day (§1), so it is said once in words at the
foot of the channels card (`target is ×1.49 the benchmark`), once as a lozenge on Paid spend,
and in the target's popup on every card that has one. The one place it is a step is where the
two waterfalls open: the target, then the stretch as a bar in the stretch tint down (or up) to
the benchmark, so that the rows below can read against the basket and the distance the business
asked for is drawn like every other distance on those cards - the part of the gap to target that
is ambition, set aside before the part that is performance.

Sidebar status becomes three-state: green at or ahead of target, amber behind target but
ahead of benchmark, red behind benchmark, hollow when no targets are set. There is no key
under the list: the row's tooltip names the state on its Pace row.

Everything degrades: when `snap.benchmark` is absent there is no outline, no tick and no
lighter band - the fill is one tint to the target - the rung centres fall back to the neutral
plan grey, and every card renders exactly as it did before the benchmark model existed. Both
waterfalls say so in their footer - `levers, no comparable basket` - because a mark that is
simply missing explains nothing.

The email card distinguishes its two silences the same way. `email.feedThrough` is the last
send anywhere in the file, so a campaign that began after it cannot have sends to find: that
is an ingestion fault and the card says which date the feed stops at. A current feed with no
send naming this release is a naming fault instead, and the card names the campaign code the
sends have to carry. Reporting both as "no sends have joined this release yet" reads as "we
sent nothing", which is a third thing entirely.

## 8. Target setting

The quartile levers are replaced (kept behind an `Evenly | By channel` switch) by:

1. **Benchmark basket** card — the chosen basket, its profile chips, a `Change basket`
   button opening the picker, and the per-channel table
   `benchmark sessions | target sessions | benchmark units | target units | stretch | conv (held)`.
2. **Stretch** card — benchmark (read-only), sellout (the edition size input), the stretch
   that falls out, and the `Evenly | By channel` switch.
3. **Derived targets** rail — three columns: Benchmark, Target, Stretch.

The rail's Benchmark column takes the basket's own median wherever the basket has one
(`unitsByGroup.paid`, `entries`, `sessions`, `paidBudget`, and `paidBudget ÷ basket launch
value` for the percentage row), so the rail and the per-channel table above it quote the
same figures. `target ÷ K` is the fallback, and only under `Evenly`, for the two rows the
basket has no equivalent for — the draw / private-room split is a target-model construct,
not a channel. Under `By channel` those rows show a dash: the levers' targets come out of
the quartile model, so the quotient is not the basket's median and printing it would invent
a figure. The percentage row is why the division cannot be applied everywhere — K is in both
the budget and the launch value and cancels, so dividing again would print a benchmark share
1/K of the real one.

The **basket picker** is a modal with two tabs: `Ready-made` (radio cards with n, median
units and the middle half, median sessions, paid share, campaign days, examples, and a
`Suggested` chip on the matched one) and `Bespoke` (search + filters, a tickable table of
candidates, and a live rail showing the basket's medians, a thin-basket warning under 10,
and `Save as ready-made`).

## 9. Shared web helpers (`web/src/ui.jsx`)

Wave-1 additions every module builds on. Signatures are fixed here so the modules and the
helpers can be written in parallel.

```js
export const C = { ..., refBase: "#f8ccba", refStretch: "#f8ddd0", refLine: "#ea8f66", refTrack: "#faf7f4" };

// What the two references are called on a card.
export function refWords(horizon)      // -> { target: "Target today" | "Target", bm: "Benchmark today" | "Benchmark" }

// One 2px mark, extending 3px past the bar it crosses. No halo. Used only where a
// bar cannot be drawn - the waterfall anchors, which are levels rather than
// quantities rising from zero. `dotted` is the benchmark's form.
export function Tick({ pct, color, vertical = true, tip, inset, dotted })

// The benchmark's mark: a dotted outline of the column (or bar) it would make,
// over the target's fill, sharing the fill's inset so the two share a silhouette.
// Takes no hover of its own.
export function BmOutline({ pct, column = false, inset, radius })

// Horizontal track bar: target fill (two tints) behind, benchmark outline over
// it, actual inset in front. `bm` may be null (no basket). `full` fixes the
// right edge (the hero's sellout) instead of the default 120%-of-the-higher-
// reference track. `hatchFrom` starts the orange over-sellout hatch.
// tips: { target, base, stretch, now, proj, overshoot }
export function TrackBar({ now, proj, target, bm, full, hatchFrom, height, radius, tips })

// Deviation rung shared by Funnel by channel and Organic funnel.
//   aOverTarget : actual / target   (null -> neutral rung)
// Returns { rel, dev, beyond }: rel is % vs target, dev is a 4..96 position on
// a log scale (x4 either way fills the rung). rungPos is the same scale on its
// own, for placing the benchmark's tick.
export function rungPos(ratio)
export function rungGeom(aOverTarget)
export function RungTrack({ dev, bmPos, up, neutral, guide, bench })  // target centre + dotted benchmark tick + dot
export function RungKey({ bench })                                    // Actual · Target · Benchmark
```

Every module receives `horizon` (`"today" | "close"`) as a prop from `App.jsx`, defaulting to
`"today"`. `snap.benchmark` may be absent - guard on it; with no `bm` the helpers draw the
target alone.
