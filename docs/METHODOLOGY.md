# Target-setting methodology

How every target on the Launch Performance dashboard is derived - the inputs, the
benchmark basket behind them, the step-by-step model, and how a launch-total target
becomes a day-by-day expectation and a forward projection.

This page describes **Limited Edition (LE) draw releases**. The full technical
specification, including data sources and known data-quality issues, lives in the
repository (`docs/DATA_MODEL.md`).

---

## 1. The currency: secured units

Everything on the Overview tab is measured in one unified metric, the sell-through's
own count of what is spoken for:

```
secured units = units paid (all routes, incl. private room)
              + draft orders raised and not yet paid
              + rate × eligible entry units still in the draw
```

The rate is the release's entry → order rate from the Target setting tab, 0.8 unless
typed, because historically 80% of eligible entries convert to orders; the entries in
hand are allocated across the products by the maximum-quantity rule before the rate
is applied (the sell-through card's own count, below). Only *unconverted* entries
carry the rate - a converted entry is already a sale, so counting both would
double-count. Each channel's share is its units paid (every order on the channel
of its own purchase event) and its entries in hand, scaled in proportion to this
count so the channels always sum to the hero.

**One count of units sold, over one window.** Every card counts the same units
sold: the units paid in the Shopify orders table, never the funnel's own
purchase count, over the same days. The window opens at the campaign start (the
private room, else the announce), or at the first paid order where that came
first - but never more than 45 days before the announce - and shuts two days
after the close, when the last winners have paid. What is paid outside it counts
on no card, and the sell-through's Paid popup says how much that is. Once the
window has shut, drafts and entries in hand no longer count: the page is the
units paid, each channel its own. A paid order the funnel has no purchase event for still counts, on
Untracked; when such orders are more than 5% of the window the page says so
above the tabs, because the channel split is then short of evidence. (Why: the
two feeds were matched order by order and agree, except that the funnel
undercounts orders of several units and counts some test and refunded orders;
the cards disagreed mostly because they counted different days. DATA_MODEL
§6.3.) The hero target equals the
edition size (sellout); demand beyond it shows as **oversubscribed** on the hero,
flattens the trajectory at the sellout and is the last step of the waterfall,
"Beyond sellout". Funnel and paid modules stay denominated in sessions, entries and
spend - the things marketing moves directly - and price entries at the same rate.

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
afterwards. Both rates are the release's: they can be set on the Target setting
tab, alongside each product's name and edition size, and every product converts
at the same two (a product no longer carries a pre-order rate of its own). Sales
the draw cannot name a product for (private room, pre-orders) are shown at
release level rather than guessed onto a product.

**Direct as a source.** The Overview has a Direct switch. As a channel, Direct
is what the funnel export attributes to it. Spread, its sessions, entries and
units are shared out over the other channels in proportion to what each did
that day, the way the untracked rows always are, and the benchmark's channel
split is read the same way (the panel's typical Direct share of the
Search/direct/other group, spread over every group pro rata). Totals, what has
been sold and the paid budget do not move - paid's cost per unit falls by the
share of Direct it takes on - while the channel cards, the funnel and paid's
units do, and the plan's pace shifts a little with the channel mix. The Target
setting tab always reads Direct as a channel.

## 2. The inputs (Target setting tab)

Almost nothing on the **Target setting** tab is typed. The figures come from
the systems that already hold them, per product, and the tab shows where each
came from; what a person decides is which Meta campaigns are the release's,
which channels it will not run, and which basket it is measured against.
Saving rebuilds the release's targets, plan curves and projections from its
basket; it takes a few seconds.

**From Airtable, per product** (the Pipeline table, one record per work):
the edition size, the target sell-through, the unit price, the artist's and
Avant Arte's profit per unit, the deal's revenue share or profit share, and
the framing take-up and profit per frame. The release's target is the
products' editions at their target sell-through, summed; its launch value the
target units at their prices, in euros; its profits per unit the products'
weighted by target units; and the paid-budget split follows from the deal -
on a profit-share deal Avant Arte carries its share of the profit, on a
revenue-share (royalty) deal it carries the ads outright. Until Airtable
holds a figure, it can be typed over on the products table, and a work
Airtable has no record for can be added by hand.

**From the Notion log:** the private room opens with the early-access email,
then the announce and the launch (the day the draw closes). Where the log has
no date yet, what was typed stands, then the funnel export's own campaign
clock, then Airtable's planned dates. **From Airtable:** the marketing lead.

| Decision | What it does |
| --- | --- |
| Meta campaigns | Which ad campaigns the paid actuals are read from, summed. The draw campaign named for the code is ticked on its own |
| Channels in plan | Running paid; the artist's own channels. A group switched off leaves the benchmark and the target, and the other channels carry the whole sellout |
| Benchmark basket | The comparable past launches the release is measured against: the suggested basket (nearest in size and price, the artist's own launches first, recent ones preferred) or one picked by hand |
| Artist posting tier (Low / Medium / High) | How much the artist will post: the cohort of past campaigns the artist-posts benchmark is read from |
| Entry → order rate, pre-order → order rate | What share of entries in hand become orders on the sell-through card; empty means the panel's 80% and 95% |

A release set up before the model went per product still carries the
release-level figures it was set up with (target, edition, price, profits).
They stand in for its totals, and the tab says so, until they are cleared
there; the products then carry them.

## 3. The benchmark: a basket of comparable launches

Every reference number on the page comes from the release's **benchmark basket**:
the past draw launches most like this one, matched on edition size and unit
price, with the artist's own earlier launches first and recent launches
preferred. The benchmark is that basket's **median**, per metric and per channel
group: units of demand, sessions and eligible entries at close, each group's
share of them, each group's conversion rate, the campaign length, and the pace
through the window. The basket is suggested automatically and can be changed on
the Target setting tab; a release is never in its own basket.

**Units are demand, not sales.** A launch that sold out with people left
wanting reads as the demand it had: its units sold, plus what the eligible
entrants left without a unit, and the entrants whose payment failed, would have
bought at the 80% entry rate - the same reading as a live release's secured
units. We are the Revolution sold 987 of 1,000 with 668 eligible entrants left
wanting 658 units and 109 entries whose payment failed: on sales it looks like a
launch that needed all of its traffic for 987 units; on demand it reached about
1,600. A comparable that did not sell out reads as its sales, and a winner who
did not pay adds nothing: they were offered a unit. The picker and the Target
setting tab say how many of the basket sold out short and what their median
sales were. (Why: read on sales, a basket of sold-out launches asks the next one
for more sessions and entries per unit than it needs, and calls the difference a
stretch; on the nine releases benchmarked in September 2026 the uplift fell by
4-30%, Warhol's from ×3.0 to ×2.1.)

Until September 2026 the model was a stack of quartile picks instead - a Low /
Medium / High chosen per channel from the whole historical panel. That model was
retired: it asked a question about the panel rather than about this launch, and
nobody used it once baskets existed. What survives of it is a handful of
constants (`etl/benchmarks.json`): the 0.8 eligible-entry → order rate (0.95 for
pre-orders), the 20% cannibalisation, the 35% frame take-up (the profit per frame is
always the product's own), the 6% budget sense
check, the paid spend rules, and two tables read at the median only - the
channel order split, which places a channel group's target on its individual
channels, and the cost per purchase, the price of a paid unit when neither the
release nor its basket has one (Step 5).

## 4. The target model, step by step

### Step 1 - the uplift

```
K = target units / benchmark units of demand
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
paid_budget = paid_units × cost per purchase
```

The cost per purchase is the price of a paid unit, taken in this order: the
release's own figure, where one is typed on the Target setting tab; else the
basket's median cost per paid unit (each launch's Meta spend over its paid units
of demand), once three or more of the basket's launches have one on file; else the
panel's €177. The tab says which of the three priced the release.

Sense check: **paid budget should stay under 6% of launch value** - the dashboard
flags a breach but does not block it. A release that will not run paid says so
with the switch: paid leaves the benchmark, and its target and budget are zero.

### Step 6 - status colours

The colours read the target and the benchmark, never a fixed haircut. The dot
beside each release in the sidebar is green at or ahead of target, amber behind
target but at or ahead of the benchmark's pace for today, red behind the
benchmark as well, and hollow when no targets are set; where there is no
benchmark pace to read, amber is anything no more than 10% behind target. The
rungs of Funnel by channel and the Organic funnel are green at or above their
target, amber when less than 10% short of it and red when 10% or more short,
with a cost rung judged the other way round. The LE workbook's 25% buffer
(`target inc. buffer = 0.75 × target`) colours nothing on the page.

### Worked example - an illustrative release

This release is made up, with round numbers so the arithmetic can be followed
by hand; it is not a release on the dashboard. A real release's own figures are
on its Target setting tab, and shift-clicking a figure on its page shows the
working with them.

An edition of 300 at €1,500 a unit, so the launch value is €450,000. Its basket
is the 8 launches nearest in size and price, whose median launch sold 240
units: **K = 300 ÷ 240 = 1.25**. Each group's benchmark is its median share of
units times those 240, and its target is that times K:

| Group | Median share of units | Benchmark | Target (× 1.25) |
| --- | --- | --- | --- |
| AA Email | 40% | 96 | 120 |
| AA Meta | 5% | 12 | 15 |
| Artist's own channels | 2.5% | 6 | 7.5 |
| Search / direct / other | 32.5% | 78 | 97.5 |
| Paid | 20% | 48 | 60 |
| All five | 100% | 240 | 300 |

Inside a group the target is placed on its channels by the order-split
medians: AA Email's 120 go about 93% to the manual sends and 7% to the
automated flows, 112 and 8. Sessions take the same uplift, the basket's median
of 20,000 becoming a target of 20,000 × 1.25 = 25,000, while the conversion
rates stay the basket's. Entries target 300 ÷ 0.8 = 375, against 240 ÷ 0.8 =
300 for the benchmark.

No cost per purchase is typed for the release, and 6 of the 8 launches in the
basket have a cost per paid unit on file (their Meta spend over their paid
units), so the median of those six, €200, prices a paid unit. Paid budget
60 × €200 = **€12,000** (benchmark 48 × €200 = €9,600), 2.7% of the launch
value and inside the 6% sense check. Had fewer than three of the launches had
a reading, the panel's €177 would have priced it: 60 × €177 = €10,620.

Paid runs from the day after the announce to the close. On a campaign 25 days
long that is 24 days, so the plan spends €12,000 ÷ 24 = €500 a day, and 13
days after the announce the paid plan by today is (13 − 1) ÷ 24 = half of it:
30 of the 60 units, and €6,000 spent. The organic groups are read off the
basket's own pace curves instead (§5).

## 5. Targets across time: the campaign clock

A launch-total target is spread over days using **the median curves of the
release's basket** (§3), not straight lines.

1. Every day of a campaign is stamped with `pdsa` - percent of days since
   announcement (0 = announce, 1 = draw close; negative = early access).
2. For each clean, completed launch in the basket (fully observed window, ≥20
   entries), compute the cumulative share of its final total reached at each
   pdsa, per metric (sessions, draw entries, units) and per channel group.
3. The **median across the basket's launches is the target trajectory**. Where
   fewer than 4 of them can shape a series, that series comes from the pooled
   panel of every clean, completed launch in the export (76 at the 24 September
   build), and a channel group the panel cannot shape either reads the
   all-channel curve. Only the median is used: the trajectory chart draws no
   percentile band.
4. `expected today = target_total × curve(pdsa_today)` - this is the "expected"
   tick every module compares against.

**Units are planned on the entry-timed shape.** The page counts secured units
(§1), which take a draw entry the day it is made, while the funnel records a
draw's units on the draw-close date, when the winners are allocated. So each
organic channel group's unit plan, its expected-by-today and the path of its
projection (§6) follow the group's draw-entries curve, not the unit-booking curve: a
booking-shaped plan put about a quarter of the email and social targets on the
final day, and the projection read that as demand still to come. Entry timing
reflects when the demand actually came in; a genuine (smaller) last-chance surge
remains in the curve. Sessions targets follow the sessions curve.

**Paid follows its budget, not a curve.** Paid starts the day after the announce
and runs to the close, and its budget is planned evenly over those days, so its
plan by any day is the even daily share of its target (§6).

## 6. Forward projections

Projections describe the **current trajectory** - the paid-spend recommendation
is the intervention shown alongside, never baked into the projection.

**Organic channels.** The remaining volume follows the channel's historic
entry-timed shape (§5); its level scales with demonstrated performance, trusted
in proportion to how much of the campaign has been observed:

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
trailing-3-day CPE and rises by **the campaign's own daily drift**, the same every
day to the close: fitted on its own days once it has 8 with spend and an entry,
shrunk to a 2.5%-a-day prior and held between 0 and 10% a day (the prior alone
until then; §7). Projected entries convert to units at 0.8.
Today counts for what is left of it, so the spend projected at close is the spend
to date, today so far included, plus the last full day's spend over the full days
after today and the rest of today, and the entries in hand today stay in.
Paid starts the day after the announce and runs to the close; its plan by today is the
even daily budget's share of its target over those days, not the panel's historic paid
shape, so every card reads the same paid plan.

## 7. Paid in-flight model

Daily, per release, with spend read from the matched Meta campaign and entries
from the Paid Social channel:

```
adjusted CPE = spend / (entries × rate)               cost per expected-converting unit
ROI          = (1 − cannibalisation) × profit per unit / (adjusted CPE × budget share)
```

The rate is the release's entry → order rate and the cannibalisation the release's
own, both from the Target setting tab (0.8 and 20% unless typed): the same rate the
secured units and the targets' eligible entries are read at.

The headline and the chart line are the **trailing-3-calendar-day** rolling
version of this: a window with spend but no entries reads as ROI 0 (money out,
nothing in), and CPE is treated as unknown until entries return.

The units the Paid spend card draws are the paid group's secured units (§1), the
same figure as its column on the channels card; the entries above are what the
cost per entry and the ROI are priced on. The Paid ROI chart's bars are the full
days plus the day so far, which is drawn but carries no ROI point, so the bars
sum to the spend to date.

The profit per unit and the budget share are the release's own, from the Target
setting tab (§2): the products' figures weighted by their target units (AA's
includes the framing uplift). The card shows Avant Arte's ROI by default and
can be switched to the artist's reading of the same days - the artist's profit
per unit over the artist's share of the spend. The spend divides as the profit
does: on a profit split each side carries its share of the profit, so on a deal
where Avant Arte takes 30% of the profit it carries 30% of the ads; on a
revenue-share deal Avant Arte carries them all and the artist none, so there is
no artist ROI to show. Where no product records its deal, half is assumed and
the card says "50/50 split assumed" until the AA profit share (or AA revenue
share) is typed on the Target setting tab: Avant Arte's own share, not the
artist's. The ? popup on the card sets out the working
with the release's figures.

The spend is Meta's, billed in euros, and the page runs in euros, so every
figure on it is euros (a product priced in another currency is converted at a
fixed rate). The
cannibalisation is the release's own from the Target setting tab where one is
typed, else the 20% standard. Framing profit is Avant Arte's alone: it sits in
AA's profit per unit and never in the artist's.

**Budget to sell out** (the sizing decision). Paid is sized to top up only the
gap organic is *not* on course to fill - not to buy the whole remaining edition
by itself:

```
secured now     = units paid + draft orders + orders expected from the draw, work by work,
                  capped at the edition        (the hero's secured units, §1)
organic to come = shape-following organic projection of further secured units (§6)
sell-out gap    = max(edition size − secured now − organic to come, 0)
entries needed  = sell-out gap ÷ rate       (every unit asked for as an entry, as in the targets)
supply spend    = the daily spend whose entries fill the gap by the close, at the price below
budget          = supply spend × days left
```

A launch pacing well ahead organically can therefore read a recommendation of
€0/day: nothing extra is needed to secure sell-out, whatever the current ROI.

**Price rises as the spend adds up.** Within a campaign, what a euro buys falls
as the campaign's total spend grows: each doubling of what it has spent makes
the next entry about 18% dearer (15% fewer entries a euro). A bigger day costs
a little more on top, and the draw's last two days buy more, as the deadline
pulls people in. On a future day, at a flat daily spend s:

```
cpe(day, s) = cpe_window × lift_window × (s / spend_window)^eps
              × ((K + spent before the day) / (K + spent at the window))^w ÷ lift(day)
```

`cpe_window` is the trailing three days' price, paid at that window's daily
spend (`spend_window`) and at its place on the clock (`spent at the window`,
its spend-weighted spend so far). The wear-out `w` is 0.24 and `K` €100; the
elasticity `eps` to the day's budget is 0.08 (doubling the day's budget makes
an entry about 6% dearer). `lift(day)` is the close's: ×1.53 on the close day
and ×1.40 the day before (95% ranges ×1.26 to ×1.87 and ×1.07 to ×1.83), 1
before that, where the day before those reads ×1.07 ± 0.14 and nothing earlier
shows. `lift_window` takes it back out of a trailing window that itself fell
in those days, so the price underneath is what the path carries forward. All
of it is measured on our own campaigns: 42 Meta draw campaigns tied to a
release, 705 campaign-days up to the draw's close, entries as Poisson with one
level per campaign and the days to the close from the funnel export's own
campaign clock (`etl/analysis/cpe_elasticity.py`, 28 September 2026). Spend
after a draw has closed (72 campaign-days, €62k for 230 entries) is left out:
the forecast never runs past the close. A campaign with 8 days of its own has
its pair fitted, with the close's lift held at the panel's, and shrunk to the
panel's together: a campaign that ramps its budget as it goes cannot tell a
bigger day from more spend so far, so the pair moves towards the panel along
the line its data cannot pin down. A release's own figures are in the
explainer on its Paid spend recommendation and in the card's floor popup.

**What the close's lift is.** An entry is attributed to the channel of the
session the person signed up in, and a draw started and not finished counts
as signing up, so the rush could have been credit deferred from earlier paid
sign-ups coming back on the final day after an email: a pool the final day's
spend does nothing to, which no budget should be multiplied by. The events
feed, read at account level (`etl/analysis/close_rush.py`, aggregates only),
says it is not. Of 5,228 paid entries with a sign-up on the same release,
4,873 (93%) entered on the day they signed up; of the 528 paid entries on the
final two days, 458 (87%) signed up on those days and 70 came back from
earlier; of the 27,974 paid sign-ups across 58 releases who had not entered
by the final two days, 70 (0.3%) did so then. The lift is the final days' own
paid sign-ups, who enter at once: within a campaign a euro buys ×1.15 as many
sign-ups on the close day (×1.08 the day before) and each sign-up is ×1.22
(×1.20) as likely to enter. So the path lifts the final days' spend
(`cpe_close_lift_applied`; switched off, the path runs on the curve alone,
the fit keeps the lift, and the projection runs about a fifth low over a
campaign's last fifth). The lift's reach on a very big final day is the one
thing the panel cannot pin down: the final days' entries read it shrinking by
6% per doubling of the day's spend against the campaign's usual, ± 6%, so a
day at four times the usual could be buying ×1.35 rather than ×1.53.

Why spend so far and not days: on the panel it fits better than a straight
drift a day (deviance 1254 against 1294, where the straight drift read 4.6% a
day), and a back-test that cut past campaigns at 40, 60 and 80% of their run
and predicted the rest from the spend they actually had missed by 46% against
the old drift's 57% (median, either direction; 32 campaigns). It also says what
a drift a day could not: a bigger budget wears the audience out faster,
because the clock moves with the money. The sign-ups the draw campaigns bring
and the link clicks of every campaign, the sign-up campaigns included, wear
out alike (17% and 14% fewer a euro per doubling). Without the close's lift
every version under-predicted the last fifth of a campaign by about a fifth;
with it, on the 29 campaigns with 14 days up to their close, the miss falls
from 46% to 42% overall and the bias from −7% to +2% (−18% to −3% in the last
fifth).

The ROI floor reads the price at the close underneath the lift, the path's
worst day: the deadline's rush is a bonus on the last two days, and a budget
that only clears the floor because of it would be paying under it on every
day before.

```
sell-out s  : Σ over the days left of s / cpe(day, s) = units still to secure
ROI-floor s : cpe(close, s) = (1 − cannibalisation) × AA profit/unit ÷ (floor × AA budget share)
target      = min(sell-out s, ROI-floor s)
```

A release that could only sell out by spending fifty times today's budget is
told so by the ROI floor, which binds long before the supply figure does. A
floor no daily spend can meet, because the spend already made has worn the
price past it, is a cut like any other, held to 30% a day; only a gap already
filled stops paid at once.

**One forward path.** That single path serves the paid projection on the
trajectory and the Paid ROI chart's dotted line (both at today's spend) and the
recommendation (at the recommended spend). The floor is on **ROI at close**:
the recommended spend is the level at which the path ends on the floor. The
cards therefore cannot disagree - a projection heading under 1 and an
"increase" recommendation could only coexist while they ran on different
assumptions, which they did until this was unified.

**Where the old drift came from.** In the LE template the 5 / 7 / 10% figures
are a typed constant in the SPEND RULES block, labelled "Expected Increase in
Spend (%)" by third, which the daily forecast reads as the growth of cost per
unit; there is no derivation behind them, and the TL template labels its own
2.16% a day "(assumed)". They are the cost rise along the workbook's own
ramping spend path, so applied as a pure time drift on top of a spend
elasticity they counted the same effect twice. The model then ran on a fitted
drift a day (2.5%) until 28 September 2026, when the spend-so-far curve
replaced it; the workbook's figures are kept in `etl/benchmarks.json` for
reference.

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
changes are capped at ±30% and changes under 10% are ignored. The trailing
3-day ROI below target on each of the last three full days forces a decrease. The recommendation is
the target above, paced by these rules from today's spend; the card's
"Capped by" names which one bound it in a word (Sellout, Floor, Pacing, Hold,
Decrease, Forced, Plan, Zero, Pause, Steady), with the rule in full at the head
of its tooltip and the unconstrained figures beneath. With no spend yet there is no price to anchor on: the
first day starts at the plan's daily rate. ROI shown against the
recommendation is the ROI at the close at that spend level's cost per entry.

## 8. Where the numbers come from

- **Units sold** come from the Shopify orders table in BigQuery, per product, day
  and channel (the channel of each order's purchase event), pulled on every
  refresh with the other orders figures.
- **Daily funnel** (sessions, entries, units by channel × day) and **Meta spend**
  are pulled live from BigQuery (the LE Funnel Report's daily export and the Meta
  ads insights table) on boot and every hour. The *LE Paid Calculator* Google
  Sheet stands in while BigQuery is not configured and is tried when a BigQuery
  pull fails, in which case the header reads "Sources stale", since the sheet's
  copy is cut at 50,000 rows a tab.
  The header's "data through" day is the newest day in the feed, which while the
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
