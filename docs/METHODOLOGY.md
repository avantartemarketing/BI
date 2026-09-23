# Target-setting methodology

How every target on the Launch Performance dashboard is derived - the inputs, the
benchmark basket behind them, the step-by-step model, and how a launch-total target
becomes a day-by-day expectation and a forward projection.

This page describes **Limited Edition (LE) draw releases**. The full technical
specification, including data sources and known data-quality issues, lives in the
repository (`docs/DATA_MODEL.md`).

---

## 1. The currency: secured units

Everything on the Overview tab is measured in one unified metric:

```
secured units = units sold (all routes, incl. private room)
              + 0.8 × eligible entry units not yet converted
```

An eligible draw entry is worth 0.8 of a sale because historically 80% of eligible
entries convert to orders. Only *unconverted* entries carry the discount - a
converted entry is already a sale, so counting both would double-count. The hero
target equals the edition size (sellout); demand beyond it shows as
**oversubscribed**, not as bar overshoot. Funnel and paid modules stay denominated
in sessions, entries and spend - the things marketing moves directly.

### Sell-through, per product

The sell-through card counts each product of a release separately, and the
headline is those rows added up:

```
sell-through(product) = units paid
                      + draft orders not yet paid
                      + entries in hand counted on the product × 0.8
```

Until the feeds carry sales by product and draft orders, the card wears an
**Incomplete data** stamp: the sales the draw cannot name a product for are
split across the products by edition size, and drafts are not drawn.

**Entries in hand are allocated, not simply counted.** A release runs one draw
per product, and a collector can enter several draws while wanting fewer pieces
than they entered for: someone who enters four products with a maximum quantity
of two is one conversion on two of them, not four. The allocator resolves that
at close for revenue, awarding the priciest of their products with a unit
left, so the prediction counts the same way before close - each such entrant
is counted on their maximum quantity of products, placed one unit at a time
on the priciest of the products they entered that still has room, then on
whichever has the most room left. Winners who have not paid are not counted:
the order an advisor sends them after a failed payment is in the drafts for
72 hours, and unpaid after that it is out, as is a winner with no order at
all. The card says how many entrants moved and where they went.

The 0.8 is the entry → order rate (80% of eligible entries historically become
orders). An entry made as a PRE-ORDER converts higher, at 0.95: the card is
already authorised, so it is charged at the draw rather than invoiced
afterwards. Both rates can be set per release on the Target setting tab,
alongside each product's name and edition size, and a product can set its own
pre-order rate where its draw has already been run and those cards have
already been charged. Sales the draw cannot name a product for
(private room, pre-orders) are shown at release level rather than guessed onto
a product.

## 2. The inputs (Target setting tab)

Each release carries a small set of human decisions, editable on its **Target
setting** tab. Saving rebuilds the release's targets, plan curves and
projections from its basket; it takes a few seconds.

| Input | What it does |
| --- | --- |
| Edition size, unit price | Sellout target and launch value (size × price) |
| Total edition (optional) | The whole edition when the target is only part of it (Warhol: a 2,440 target on 6,100). The hero cap, the room and the sell-through percentages read against it; the targets stay on the target |
| Private room opens / announce / draw close | The campaign clock every curve runs on |
| Artist profit, AA Group profit, profit share | Per-unit economics feeding paid ROI |
| Paid budget share | Who funds the ads. Default: 50/50, or 100% AA on commission / rev-share deals; overridable per release (Glenn Ligon = 100% AA) |
| Framing available | Adds frame take-up × profit per frame to AA profit/unit |
| Frame take-up, frame profit (optional) | The two terms of that uplift, per release; blank = the benchmark defaults of 35% and £94 |
| Benchmark basket | The comparable past launches the release is measured against: the suggested basket (nearest in size and price, the artist's own launches first, recent ones preferred) or one picked by hand |
| Channels in plan | Running paid; the artist's own channels. A group switched off leaves the benchmark and the target, and the other channels carry the whole sellout |
| Artist posting tier (Low / Medium / High) | How much the artist will post: the cohort of past campaigns the artist-posts benchmark is read from |
| Cost per purchase (£, optional) | What a paid unit costs to buy: paid units × this is the paid budget. Blank = the panel's median, £177 |
| Meta campaign | Which ad campaign the paid actuals are read from |
| Products | One row per draw the event feed found: the product's name and its edition size (draws given the same name are one product) |
| Entry → order rate | What share of plain entries in hand become orders on the sell-through card; empty means the panel's 80% |
| Pre-order → order rate | What share of pre-order entries become orders, their card being already authorised; empty means the panel's 95%. A product can override it in the products table |

## 3. The benchmark: a basket of comparable launches

Every reference number on the page comes from the release's **benchmark basket**:
the past draw launches most like this one, matched on edition size and unit
price, with the artist's own earlier launches first and recent launches
preferred. The benchmark is that basket's **median**, per metric and per channel
group: units, sessions and eligible entries at close, each group's share of
them, each group's conversion rate, the campaign length, and the pace through
the window. The basket is suggested automatically and can be changed on the
Target setting tab; a release is never in its own basket.

Until September 2026 the model was a stack of quartile picks instead - a Low /
Medium / High chosen per channel from the whole historical panel. That model was
retired: it asked a question about the panel rather than about this launch, and
nobody used it once baskets existed. What survives of it is a handful of
constants (`etl/benchmarks.json`): the 0.8 eligible-entry → order rate (0.95 for
pre-orders), the 20% cannibalisation, the framing defaults, the 6% budget sense
check, the paid spend rules, and two tables read at the median only - the
channel order split, which places a channel group's target on its individual
channels, and the cost per purchase, the default price of a paid unit.

## 4. The target model, step by step

### Step 1 - the uplift

```
K = target units / benchmark units
```

The target is the edition, or the part of it being sold. K is the one even
uplift applied to **every volume** the basket reports - units, sessions, entries
and spend - in every channel group and on every day of the campaign.
**Conversion rates are held at the benchmark**: a target that quietly assumes
the site converts better than it ever has is a target nobody can act on, so the
stretch is asked of traffic and spend only.

### Step 2 - channel groups

```
target_units(g)    = benchmark_units(g)    × K        for each of the five groups
target_sessions(g) = benchmark_sessions(g) × K
```

The five groups are AA Email, AA Meta (the brand's own social), the artist's own
channels, search / direct / other, and paid. A group switched off under
**Channels in plan** leaves the benchmark first: its medians go to zero, the
benchmark units drop to what the other groups add up to, and K is the target
over that smaller number - so the channels in plan carry the whole sellout
between them.

Organic units are no longer split into a draw half and a private-room half. The
private room is still measured - the sell-through card counts it and the basket
records its share - but it is not a target of its own: every organic unit is
targeted through its channel group, which is how the LE workbook has set its
targets since September 2026.

### Step 3 - channels inside a group

The funnel export is trustworthy at the group level, so the basket knows what a
group sells, not what each channel inside it sells. A group's target is placed
on its channels with the historical **order-split medians** (each channel's
median share of units), renormalised inside the group. Conversion inside a group
is the group's benchmark rate.

### Step 4 - entries

```
target_entries(c) = target_units(c) / 0.8
entries target    = target units / 0.8
```

Every unit is asked for as an eligible entry converting at the panel's 80% rate.
The benchmark beside it is the basket's median units asked for the same way, so
the row keeps the K ratio; what the basket's launches actually drew in entries
stays on the snapshot as data.

### Step 5 - paid budget

```
paid_units  = benchmark_paid_units × K
paid_budget = paid_units × cost per purchase        (the release's figure, else £177)
```

Sense check: **paid budget should stay under 6% of launch value** - the dashboard
flags a breach but does not block it. A release that will not run paid says so
with the switch: paid leaves the benchmark, and its target and budget are zero.

### Step 6 - buffer

`target inc. buffer = 0.75 × target` - a 25% haircut on any target, used as the
amber warning line. Above target is green, between buffer and target is amber,
below buffer is red.

### Worked example - Glenn Ligon (edition 150)

Basket: the 8 launches nearest in size and price, median 134 units → **K = 1.12**.
Benchmark → target by group: AA Email 56.2 → 62.9, AA Meta 4.6 → 5.2, artist
0.6 → 0.6, search / direct / other 53.0 → 59.3, paid 19.5 → 21.9, which sum to
150. Sessions 24,402 → 27,316. Entries target 150 ÷ 0.8 = 187.5, against
134 ÷ 0.8 = 167.5 for the benchmark. Paid budget 21.9 × £177 = **£3,873**
(benchmark £3,460), 0.9% of the £450,000 launch value.

## 5. Targets across time: the campaign clock

A launch-total target is spread over days using **pooled historical curves**, not
straight lines.

1. Every day of a campaign is stamped with `pdsa` - percent of days since
   announcement (0 = announce, 1 = draw close; negative = early access).
2. For each completed, clean historical LE (fully observed window, ≥20 entries -
   currently ~15 releases, growing as campaigns close), compute the cumulative
   share of its final total reached at each pdsa, per metric and per channel
   group.
3. The **median across releases is the target trajectory**; the 25th–75th
   percentile band is the guardrail shading on the trajectory chart.
4. `expected today = target_total × curve(pdsa_today)` - this is the "expected"
   tick every module compares against. Channel groups with thin history fall back
   to the all-channel curve.

One deliberate exception: the **paid unit plan follows the entry-timed shape**,
not the unit-booking shape. Historically ~98% of paid draw units are *recorded*
on the draw-close date (winners are allocated then), so a booking-shaped plan
would cliff ~46% of the paid target onto the final day while the secured-units
actual accrues as entries arrive. Entry timing reflects when the demand actually
came in; a genuine (smaller) last-chance surge remains in the curve.

The campaign stages shown in the header follow the same clock: Early access
(before announce), Sustain 1–3 (thirds of the window), Last chance (draw-close
day onward).

## 6. Forward projections

Projections describe the **current trajectory** - the paid-spend recommendation
is the intervention shown alongside, never baked into the projection.

**Organic channels.** The remaining volume follows the channel's historic shape;
its level scales with demonstrated performance, trusted in proportion to how much
of the campaign has been observed:

```
w    = curve(pdsa_today)                    share of campaign the curve says is done
r    = clamp(actual / expected, 0.25, 2.5)  demonstrated performance vs plan
proj = actual + target × (1 − w) × (1 + w × (r − 1))
```

Early in a campaign (w small) the projection is essentially the plan; late on, it
scales with what the channel actually delivered. The daily path to that endpoint
is shaped by the curve, not drawn straight.

**Paid.** Projection = projected spend ÷ projected efficiency, day by day:
current daily spend run-rate, divided by a cost-per-entry that starts at the
trailing-3-day CPE and deteriorates **5% / 7% / 10% per day** across the first /
second / final third of the window. Projected entries convert to units at 0.8.

## 7. Paid in-flight model

Daily, per release, with spend read from the matched Meta campaign and entries
from the Paid Social channel:

```
adjusted CPE = spend / (entries × 0.8)                cost per expected-converting unit
ROI          = (1 − 0.2 cannibalisation) × profit per unit / (adjusted CPE × budget share)
```

The headline and the chart line are the **trailing-3-calendar-day** rolling
version of this: a window with spend but no entries reads as ROI 0 (money out,
nothing in), and CPE is treated as unknown until entries return.

**Budget to sell out** (the sizing decision). Paid is sized to top up only the
gap organic is *not* on course to fill - not to buy the whole remaining edition
by itself:

```
secured now     = units sold + 0.8 × entries banked        (all channels)
organic to come = shape-following organic projection of further secured units (§6)
sell-out gap    = max(edition size − secured now − organic to come, 0)
entries needed  = sell-out gap × 1.2
forecast CPE    = trailing-3-day adjusted CPE × 1.5   (assumed deterioration to close)
budget          = entries needed × forecast CPE
```

A launch pacing well ahead organically can therefore read a recommendation of
£0/day: nothing extra is needed to secure sell-out, whatever the current ROI.

**Price is not flat in spend.** Within a campaign, cost per entry rises with
daily spend as `spend^0.38` - measured on our own campaigns (13 campaigns, 170
campaign-days, campaign fixed effects, net of the day drift; ±0.06;
`etl/analysis/cpe_elasticity.py`). Doubling the daily budget raises the cost
per entry by about a third; a tenfold jump multiplies it by 2.4. So the
entries a recommendation asks for are priced at the cost the *recommended*
spend implies, anchored on today's price at today's spend:

```
cpe(s)      = cpe_today × (s / spend_today)^0.38
sell-out s  : days_left × s / cpe(s) = units still to secure
ROI-floor s : cpe(s) = (1 − cannibalisation) × AA profit/unit ÷ (floor × AA budget share)
target      = min(sell-out s, ROI-floor s)
```

A release that could only sell out by spending fifty times today's budget is
told so by the ROI floor, which binds long before the supply figure does.

**One forward path.** Cost per entry from today drifts by the spend rules'
daily rate, compounded day by day, and that single path serves both the Paid
ROI chart's dashed projection (at today's spend) and the recommendation's
floor (at the recommended spend). The floor is on **ROI at close**: the
recommended spend is the level at which the line the chart draws ends on the
floor. The two cards therefore cannot disagree - a projection heading under 1
and an "increase" recommendation could only coexist while they ran on
different assumptions, which they did until this was unified.

**About the drift rate, and where the rules come from.** In the LE template
the 5 / 7 / 10% figures are a typed constant in the SPEND RULES block, labelled
"Expected Increase in Spend (%)" by third, which the daily forecast reads as
the growth of cost per unit. There is no derivation behind them on either tab;
the TL template labels its own 2.16% a day "(assumed)". Applied as a pure time
drift on top of the spend elasticity they count the same effect twice (the
workbook's own spend path ramps 6–10% a day, and at elasticity 0.38 that ramp
alone lifts cost per entry 3.5–5% a day) and drive ROI at close under 1 on
every campaign: a release five days in at a cumulative ROI of 3.5 was told to
cut. Net of spend, the within-campaign time drift measures 0.36% a day ± 1.12
on our own campaigns; the model uses 0.5% a day, with the workbook's figures
kept beside it.

The pacing rules themselves are the **TL template's** "ROI / SPEND RULES" block
(cumulative ROI below 0.9 decrease, 0.9–1.3 maintain, above 1.3 increase;
changes under 10% ignored, over 30% capped at 30%; ROI under target for three
days), applied to LE for want of a fuller LE block. The LE template's own
rules are thinner and different: ±10% steps, "max increase per day 2.0",
target ROI 1.1, a 30% cut on a day that spent and bought nothing, and a pause
after three such days. The two zero-conversion rules are applied as written;
which of the two step-size regimes LE should run under is an open question for
the paid team.

**Pacing rules:** target ROI (AA) **1.1**, floor **1.0**. Cumulative ROI below
0.9 → decrease; 0.9–1.3 → hold (never raise); above 1.3 → increase. Daily
changes are capped at ±30% and changes under 10% are ignored. Forecast ROI
below target for 3 consecutive days forces a decrease. The recommendation is
the target above, paced by these rules from today's spend; the card's
"Capped by" names which one bound it in a word (Sellout, Floor, Pacing, Hold,
Decrease, Forced, Plan, Zero, Pause, Steady), with the rule in full at the head
of its tooltip and the unconstrained figures beneath. With no spend yet there is no price to anchor on: the
first day starts at the plan's daily rate. ROI shown against the
recommendation is the ROI at that spend level's cost per entry.

## 8. Where the numbers come from

- **Daily funnel** (sessions, entries, units by channel × day) and **Meta spend**
  are pulled live from the *LE Paid Calculator* Google Sheet on boot and every
  hour. The header's "data through" day is the newest day in the feed, which while the
  feed is live is today, part-observed: the actuals run through it and the header says
  "today so far". The paid pacing rules, the run rates and whether a campaign is complete
  read only full days, and every reference "by today" is read at the share of today seen,
  so a morning reading is not behind for hours that have not happened.
- **Email** stats pull live from HubSpot on every refresh (`HUBSPOT_TOKEN`); the
  checked-in CSV is the last pull and serves only until the first refresh. The header
  says "emails through" a date whenever the feed falls more than a week behind the
  build. **Instagram content** (Emplifi) is an uploaded snapshot.
- **Artist posts** pull live from the team's Notion log when connected. Their
  benchmark follows the same cohort approach as every other channel: expected
  posts = the median artist-post count among completed campaigns in the same
  **posting tier** (Low / Medium / High beside the artist switch on the Target
  setting tab), pro-rated by days elapsed. It stays blank until at least two completed
  campaigns in the cohort have logged posts.
- **Benchmarks** come from the release's basket, cut from the draw panel on every
  build. The few constants that remain (`etl/benchmarks.json`) are versioned and
  dated; recomputing them is a deliberate act, not a side effect of new data.

Open-ended judgement calls - the basket, the channels in plan, the cost per
purchase, the Meta campaign match - live on each release's Target setting tab,
where every change is logged.
