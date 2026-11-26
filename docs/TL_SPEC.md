# Timed launches (TL): the dashboard spec

Agreed with Tom Lloyd on 1 October 2026 from 24 tappable answers (the log is in §12). This is
the build spec for timed-launch pages; the workbook's TL target model as recorded in
`DATA_MODEL.md` §3a is background, not the spec. Where this document and the LE behaviour in
`DATA_MODEL.md` agree, the LE words apply; where a TL differs, this document says so.

## 1. Scope

- **What is a TL.** A release whose launch Airtable types `Timed`, matched to the timed-launch
  event feed (`TL_Funnel_Report_v2`, 81 launches since 2019) by the same matcher the LE pages
  use for the LE feed (artist and window, then quarter). An upcoming TL is listed from Airtable
  before the feed carries a row for it, as upcoming LEs are.
- **First launch.** Bisa Butler · Multiple · 2026 Q4 (Be Mine; I Go To Prepare a Place For You,
  code `BisaButlerTL26`): announced 15 September, window opens 13 October at 16:00 UTC, 18:00
  Amsterdam time (the feed's timestamp less the hour it runs late in summer, §11a; Airtable's
  `launch_time` is blank), 48 hours, closes 15 October. Units target
  400, two works of 300 at 750 EUR, framing on order. It is in its pre-window now, with about
  7,600 signups to 1 October, so the signups state can be checked against live data at once and
  the sales state on the 13th. Then Carrie Mae Weems (announce 26 October, window 18 November)
  and Ai Weiwei's Lego Middle Finger (announce 29 October, window 30 November).
- **Where it lives.** TL pages sit with the LE pages in the sidebar, badged TL, the row saying
  the state (§9). The Target setting tab serves TLs with TL wording (§7). No Slack posts for TLs
  yet (§10).

## 2. The three states and their boundaries

| State | Runs | Watching | Grain |
|---|---|---|---|
| Pre-window | announce to window open | signups against a signup target | daily |
| In-window | window open to window close | units sold against the units target | hourly |
| Closed | after the close | the final figures, settling for 7 days, then frozen | hourly curve kept |

**Dates are worked back from Airtable's launch date and window length.** Window open =
Airtable `launch_date` at the opening hour; close = open + `tl_length` (48 hours, 7 days, 24
hours), else `tl_end_date`. Announce = Airtable `announce_date`. The opening hour is Airtable's
`launch_time`, else the feed's `launch_date` timestamp (the platform's own, 17:00 UTC for Bisa
Butler), else 14:00 CET. Every date can be typed over on the tab, and drift between the date in
force and Airtable or the feed is said beside it with a one-click `use it`, as for LEs (§1.6
of the data model).

**A TL with no announce date in Airtable** starts its pre-window when the first few signups
land: the first day with 10 or more signups for the release within 45 days of the open, said on
the page as assumed until Airtable has the date. (Bisa Butler's August teasers, 25 signups on 6
August, fall outside 45 days and would not start it; 9 September with 40 would.)

**Pre-announce signups count.** The headline is every signup for the release to date; the
day-by-day chart runs from the announce date with the earlier signups as its opening level.

**Closing.** The window shuts at the close hour. For 7 days after, drafts are paid, payments
clear and cancellations land, and the page keeps reading them (`settling`); then the figures are
final and the page is a closed page, listed with the closed releases, the in-window layout
frozen at the final figures.

**Freshness.** Both event feeds run about half an hour behind (newest event 11:10 UTC when read
at 11:42 UTC on 1 October) and the orders table carries the day's orders, so the hourly state
can run off BigQuery. The refresh runs hourly; while a window is open it should run every 30
minutes (a scheduler setting, `REFRESH_WINDOW_MINUTES`), with the page saying "data to hh:mm".
The feed's own flags are cross-checks, never the boundary: `campaign_stage` (TL - Pre-campaign,
TL - Announcement, TL - Sustain, and the launch stages), `pre_post_launch_signup`,
`pre_post_launch_purchase`.

## 3. Data

**`TL_Funnel_Report_v2`** (event level, 54 columns): `event_timestamp`, `event_date`,
`event_name` (`signup`, `session_start`, `page_view`, `purchase`), `simple_release_name`,
`release_name`, `launch_type`, `launch_date` (timestamp), `aa_account_id`, `subscription_id`,
`aa_subscription_type`, `pre_post_launch_signup`, `converted_signup`, `shopify_order_id`,
`pre_post_launch_purchase`, `order_type`, `order_source_type`, `cancelled_order`, `pr_order`,
`order_products`, `order_pieces`, `purchase_with_signup`, the split-touch channel
(`AA_session_custom_channel_group_split_touch`), `campaign_id`, the campaign clock
(`announcement_date`, `campaign_stage`, `days_since_announcement`, `days_until_launch`, the two
`pct_` columns) and the page locales. It carries `user_email`: the personal-data rule of the LE
feed applies unchanged (the query names every column it takes, the address column is never
selected, every cell is scanned before it is written, and the account id stays under
`sources/`, served by no endpoint). The aggregated `tl_funnel_report_split_touch_export` is
still denied to the service account and is not needed.

**Pulls.** Two feeds like the LE pair, through the same incremental machinery (overlap, weekly
full pull, the rename check): `sources/tl_events.csv`, the conversion events (signups and
purchases, with the pseudonymous account id, the order id, the pieces, the flags) and
`sources/tl_browsing.csv`, sessions and page views counted inside BigQuery per release, channel,
day **and hour** (the hour is what the in-window state needs; the LE browsing feed stays daily).

**Orders.** `Order_Line_Concept` as today, extended to TL releases: paid, awaiting payment
(drafts and pending), cancelled and refunded per product and per hour of the window
(`shopify_order_created_date_CET`), frames per print, private-room lines. Units in the
in-window headline are the orders table's paid plus awaiting lines joined to the feed's purchase
events on `shopify_order_id` for the channel; the feed's `order_pieces` is the cross-check.

**Signups by work** (`data/tl_signups_by_product.csv`, `server/bigquery.js tlSignupProductsSql`): per
release x day x the feed's pre/post flag x channel x subscription type x product page, the signups
and how many of them went on to order. A signup row names no work; the work is the product page
viewed last in the signup's own session before it, joined on the session id inside BigQuery, and
only counts leave. Release-level signups and product-level ones made outside a session (an app, an
email form) have no page and count against an empty one. Pulled in full with the TL feeds.

**Airtable** (`data/release_pricing.csv`): `launch_type`, `launch_date`, `launch_time`,
`tl_length`, `tl_end_date`, `announce_date`, `units_target`, `edition_size`, `unit_price`,
`currency`, `framing`, `preorder_window`. **HubSpot** sends and **Meta** spend by campaign code
as today.

## 3b. Direct as a source (the Direct switch)

The Overview's Direct switch (docs/METHODOLOGY.md §1.3) is on a timed launch's page too, in
both states (5 October 2026). *Channel* reads Direct as the TL feed attributes it. *Spread*
shares Direct's rows out over the other tracked channels in proportion to what each did in the
same step - a day before the window, an hour inside it, an hour of one work in one order status
on the orders table's lines, a day and a page on the signups by work - every measure alike
(`etl/tl.py spread_direct`, the LE build's `redistribute_channel` on the TL frames). A step with
nothing else to spread it over keeps its volume in place, split over the channels on the
launch's overall mix, so a series keeps its shape; the untracked rows stay apart, as the TL
cards hold them; totals by step are kept to the figure.

The basket is read the same way: the panel is built a second time from the spread frames, so
every by-channel median - signups, sessions and units by group, the session -> signup and
session -> sale rates, the signup -> order rates by kind, the window's non-signup units - is on
the basis the page is on (`direct_spread_data`, `panel_frame`, `spread_profile`). The money is
held: paid takes its share of Direct's signups and units, so the same spend buys more of them,
and the basket's cost per signup and per sale are the Channel view's rescaled by the paid
group's change. The plan is the plan: the signup target, the units target, the rates and the
budgets do not move with a display switch; each group's share of them follows the spread basket
(`respread_targets`, the stretch placed as the inputs say), and the cost of a paid signup, and of
a paid sale, is the budget over the paid signups, and units, the spread view gives paid - so
paid reads the signups it is given at a cost rescaled to them. A paid signup's worth
(`tl_paid_value`, §7) is read on the basket as the feed attributes it whichever view is on.

One exception: the sell-through forecast by work (§4b) reads the feed's attribution whichever
view the page is on. Its rates by channel and kind are measured on that attribution, and under
the spread a launch whose own Direct share differs from its basket's would have its signups
credited with Direct's conversion it did not have (Bisa Butler's read 7% higher, on 1% of its
signups from Direct against the basket's 5%). A display switch should not move a sales forecast.

The build makes every page both ways and the blocks that differ ride under
`variants.direct_spread`, with Direct's share of the page's own signups, sessions and units
before the spread under `directShare` for the switch's words; the dashboard lays the variant over
the page as it does for an LE (`web/src/App.jsx`), and the Target setting tab reads Direct as a
channel and says so when the Overview spreads it. Over the panel's launches Direct is 44% of the
Search/direct/other group's pre-window signups, 65% of its sessions and 56% of its window units
at the median (`direct_norm`, 71 launches; about 5% of a launch's signups and 18% of its units).
Held to the page's identities both ways by `tests/test_tl_page.py`, and to its rule by
`tests/test_tl_direct_spread.py`.

## 4. Pre-window state: signups

**Headline: signups to date against the signup target**, with the benchmark underneath, as the
LE page shows units. A signup is every signup event the feed tags to the release before the
window opens, whatever the person's existing subscription (as the TL funnel export counts subs);
unique people (distinct account ids) is a secondary figure beside it.

```
units from signups = units target x (1 - the basket's non-signup share)   (§7)
orders needed   = units from signups / purchases per order
signup target   = orders needed / signup -> order rate
pace            = the basket's median cumulative share of pre-window signups at the same share
                  of each launch's own announce -> open span (the campaign clock)
benchmark       = the basket's median signups at the same share of the span
```

**The pace is read on the campaign clock**, as the LE pages read theirs (`docs/METHODOLOGY.md`
5), not by days to the open (16 November 2026). Each of the basket's launches is read at the
share of its own announce -> open span gone by, 0 at its announce and 1 at its sales open
(`etl/tl.py pace_curve`, on `PACE_FRACS`), and the page reads the median at the share of its own
span gone by, so a launch announced six days out and one announced three weeks out line up at
their announces. A launch's span starts at its announce on file, or on the day its signups began
where that is later (the first day with 10 or more, decision 17's rule; `pace_days`): an announce
on file weeks before any signup arrived is not the day the launch was announced. A basket with
fewer than 4 launches (`TL_PACE_MIN`) does not shape a pace of its own and takes the median of
every completed launch on the panel, as an LE basket under four launches takes the pooled
panel's curve; the profile says which (`pace_source`, `pace_n`).

Read by days to the open, a launch announced earlier than its basket's launches was given a
target of nothing until the basket's announces came round. Matt DesLauriers' Serac, announced 19
days before its sales open against five launches of which three took their first signups six
days out or fewer, read 99 signups against 1 expected (+12275%) on day 12 and a projection of
its signups to date plus the whole target; on the campaign clock the same basket expects 412 of
the 488 by then. `etl/analysis/tl_pace_backtest.py` reads each of the 73 completed launches with
an announce and a curve as if live, at each tenth of its span, against every other launch and
against the eight nearest on signups: the mean gap between the pace and the launch's own share
falls from 0.18 to 0.16 (0.30 to 0.16 for the launches with a longer lead than their basket,
against every other launch), and the readings where a launch had a fifth of its signups and the
pace had not started (under 5%) fall from 7% to none. Starting a member's span at its announce
on file or where its signups began reads the same on that test (0.164 and 0.165, 0.160 and
0.158); the second is kept because 9 of the 73 took no signups to speak of until three days or
more after the announce on file, a median 23 days out on file against 11.

Purchases per order and the signup -> order rate are the basket's medians, typed over on the
tab. The launch strip reads "Announced d Mon, opens in N days".

**The cards are the LE page's cards**, in the shared layout and in signup words (decided 2
October 2026: the page mirrors the LE page's containers, changing only where a timed launch is
conceptually different). The build writes the blocks the LE cards read (`etl/tl.py le_blocks`:
the channels with their daily series and projections, the funnel's two factors and their
contributions, the outcome waterfall, the hero, the paid pacing) in signups by day from the
announce to the open, with the pre-window signup curve as the plan's shape and the untracked
share spread over the channels in proportion, so the cards add up to the headline as the LE
cards do; `web/src/vocab.mjs` gives each card its words.

| LE card | On a timed launch before its window |
|---|---|
| Campaign clock | announce -> open, days to the open (the TL strip) |
| Units vs sellout | **Signups vs target**: signups to date against the target by today, the benchmark's pace as the outline, the signup target at the end of the track; at the open the projection |
| Channels vs targets | signups by channel against each channel's share of the signup target and the basket's |
| Funnel by channel | the rungs per channel (delivered emails, opens, clicks, sessions per click, sessions, session -> signup; paid spend and cost per signup) and the waterfall from the benchmark through each channel's traffic and conversion to the signups today. The email stages read against the **TL email cohort** (`email_cohort`: the panel's launches' pre-window sends, as the LE's email cohort reads draw launches, a page's own launch and the launches that closed after it set aside): the delivered target is the sends the plan's expected AA Email sessions by today imply at the cohort's open rate, clicks per open and sessions per click, the benchmark the same for the basket's sessions. The post rows read the Emplifi export and the Notion log over the pre-window, as the LE's do (a dot where the export stops before the campaign) |
| Unit trajectory | **Signup trajectory**: cumulative signups from the announce against the target's pace and the benchmark's, the projection to the open, by channel |
| Page funnel | on a timed launch the card keeps the **Organic funnel**: sessions and session -> signup over the organic channels; the drivers adding and costing signups (the draw launch's page funnel reads the draw entry, which a timed launch has none of) |
| Paid ROI | **Paid ROI** on what a paid signup is assumed to be worth (`tl_paid_value`, §7), the LE card: the trailing three days' AA ROI (or the last full day's, the 3d/1d switch) against the target ROI, the artist's reading on the AA/Artist switch (their profit per unit over their share of the spend), the ETL's forward path to the open as the dotted end (the LE cost path, `build.CostPath`, at today's spend on the panel's priors or the campaign's own fit), the daily spend as bars, the line ending where the spend did once paid is off, and the LE's zeros (a day with spend and no signups reads 0). A cost view keeps the cost per signup against the plan's and against the most a signup can cost at the target ROI. ROI needs AA's profit per unit (Airtable's, or typed on the Target setting tab's products grid); without it the card is **Paid cost per signup** and says what it needs |
| Spend levels | **Spend levels**, the LE card read on signups (25 November 2026; `etl/tl.py spend_levels`, `paid.levels`): what to set tomorrow's daily budget to, the level it is heading for, the chance that level loses money, and AA's profit from the spend still to come at each flat daily spend to the sales open, with the range eight in ten runs land in. It is read on the path the Paid ROI card's dotted end runs on (`build.CostPath`, `build.PathDraws`: the last three days' price of a signup, dearer on a bigger day and as the spend adds up), each signup worth what `tl_paid_value` gives it and costing AA its share of the spend. One more thing is allowed its uncertainty here than on a draw launch, and it is the widest: what a paid signup is worth, which rests on the share of paid signups that go on to order, a basket's median its launches sit far apart on (the sd of its log across the basket, `signup_order_rate_paid_log_sd`; 0.6 where the basket is thin, the panel reading 0.7). The level is the cautious peak, as on a draw launch (the daily spend that earns the most at the 25th percentile of the profit), and tomorrow's budget is today's moved toward it by at most the pacing rule's 30%. An open edition has no sell-out, so nothing caps the spend; the budget's own pace (what is left of the pre-window budget, spent evenly to the open) is marked on the plot and is no cap either. The card is on the page once paid has run a full day and bought signups, and the ROI is readable; inside the window there is none |
| Paid spend / day | the daily spend that paces the pre-window budget left over the days to the open, the paid signups and the spend against the budget's share by today and the basket's; no rule engine yet, so the buttons wait |
| Sell-through, Framing, Entries by country | not before the window: nothing has been sold |
| Actual vs target | the waterfall from the target through the stretch and the benchmark, organic traffic and conversion, paid spend and efficiency, to the signups today |
| Sell-through forecast by work | a card of its own, timed launches only (§4b): the units each work is expected to sell in the window, from the signups and the basket, as a share of its edition, on the page's horizon |
| Direct switch | the same switch (§3b): Direct's signups and sessions spread over the other channels before the window, its units and sessions inside it, the basket read the same way; the forecast keeps the feed's attribution |
| Benchmark basket | the same card: the basket's timed launches with the units their windows sold and their price, each a link to its page; the medians and the rule stay on the Target setting tab (§8) |

**The plan-based view** (24 November 2026, docs/PLAN_MODEL.md 6b, `etl/tl_plan.py`). A launch
gathering signups with a comms plan on file has the LE page's Targets from switch. On Plan the
signups outside paid follow the plan's emails and posts, and paid follows the spend still to
come at what a signup will cost, in place of the pace; the plan card and the suggested actions
lead the page, and the sell-through forecast reads the plan's signups at the open. That view is
built as the feed attributes its channels, so the Direct switch reads Channel while it is on.
The clock's page above is the default and is unchanged; the window has no such view.

Sessions and signup rates by channel, the email sends and their signups, and the paid signups'
cost are in the funnel card's rungs and popups, as they are on an LE page.

## 4a. Signup conversions (assumed): the page's unit before the window

Asked by the repository owner on 25 November 2026. Counted in signups, paid looks far bigger than it is: a paid
signup goes on to order far less often than one from an email or a post (on Marina Abramović's launch that day,
about 6 in 100 against 33 in 100 for email), so paid was four fifths of the signup target and half of what the
launch needs from its signups. The pre-window page therefore reads, by default, in **signup conversions
(assumed)**: the signups expected to buy, each channel's signups weighted by the share of that channel's signups
the basket's launches saw order (`targets.signup_order_rate_by_group`; the blended rate where the basket has none
for a channel). The target in this unit is the orders the launch needs from its signups (`targets.orders_needed`),
so it does not move with the reading of Direct: with Direct spread over the other channels one factor keeps it
there.

- **The switch.** `Count: Conversions | Signups` in the page's chips, beside Targets from and Compare to. Conversions
  is the default; the choice is kept per browser (`countAs`). It shows on a timed launch gathering signups whose
  targets carry the rates, and not once the window opens, where the page is in units.
- **What changes.** The trajectory, the channels card, the gap card (its drivers closed onto the gap in the new
  unit, whole and adding up), the funnel table's signups added and lost, the email card's headline, the signups side
  of the forecast table (4c), and on the plan-based view the plan card (every piece at its channel's rate, the rows
  the sum of their pieces, Not covered worked out again) and the suggested actions' sizes. The plan check's
  verdict is read again in this unit, the target against the similar launches' range as both stand in conversions
  (from 26 November 2026): the weights move the plan and the target by different amounts, a plan heavy on email
  being worth more conversions than its signups say, so the signups' verdict could sit against the figures the
  page shows. The page's warning that a plan is too small (docs/PLAN_MODEL.md 6) follows this verdict.
- **What does not.** Sessions and the session to signup rate; the sales forecast (4b), which is already in units;
  and the Paid section, whose cost per signup and return on spend already carry paid's own rate.
- **Where it lives.** Nothing is stored and the build is unchanged: `web/src/conversions.mjs` lays the weights over
  the view the page has already chosen (as the feed attributes Direct, Direct spread, or the plan-based one), and
  `web/src/vocab.mjs` gives the cards the words. The connector and the Agent still read the page in signups.
  `node tests/conversions.mjs` holds the sums.
- **Read it as.** An assumption, as its name says: the rates are the basket's medians, not this launch's own, and
  the forecast table's sales columns use a finer reading (product and release signups apart), so forecast
  conversions times the pieces an order takes will sit near, not on, the forecast sales from signups.

## 4b. Sell-through forecast by work (pre-window)

The question before the window opens is what it will sell, work by work. The card answers from
two halves (`etl/tl.py sell_forecast`, the `sellForecast` block, `web/src/modules/SellForecast.jsx`):

```
signups(h, c, kind)     = this launch's pre-window signups by channel c and kind (product / release),
                          today's, or projected to the open (h = open: each channel's projection on the page)
work share w(p)         = the work's share of the signups keyed to a work (its product page), when
                          FORECAST_MIN_KEYED (20) or more are keyed; else its share of the units target (else edition)
signup-led units(p, h)  = sum over c of [keyed(p, c) x rate_prod(c) + w(p) x (unkeyed product(c) x rate_prod(c)
                          + release(c) x rate_rel(c))] x pieces per signup-led order
non-signup units(h)     = sum over c of basket median non-signup window units(c)
                          x clip(signups(h, c) / basket signups(c), 0.5, 2) ^ FORECAST_BETA (0.2), plus the untracked median
units(p, h)             = signup-led units(p, h) + w(p) x non-signup units(h)
sell-through(p, h)      = units(p, h) / edition(p); the band is units x FORECAST_BAND (0.63 to 1.62)
```

A signup's page is matched to its work (`etl/tl.py work_for_page`) first by the page Airtable
names for the work (its `Product page URL`), then by the page's title against the works' names,
then by the words of the page's address; where one shop title fits several works the address
picks between them, and the works it cannot separate share the page's signups equally (a page
selling two works as a pair is for both); a page no work fits leaves its signups unkeyed, spread
over every work.
Until 23 November 2026 the first work listed took them: Marina Abramović's four Energy Hats
(two titles, each in red and yellow, all four under the shop title "Energy Hat") read as one
work with every signup and three with none.

The rates are the basket's medians by channel and kind (a product subscription is a work's own
notify-me and converts at about twice a release subscription's rate: 18.9% against 9.6% in the
median completed launch); a rate typed on the Target setting tab stands in for both. The pieces per
order are the basket's on signup-led orders, or the typed figure. The non-signup half is what the
basket's launches sold in their windows to buyers who had never signed up (48% of window units in
the median launch), by channel; it follows this launch's signup window only a fifth of the way,
because that is the relationship the completed launches show (a within-basket slope of 0.25; scaling
it fully made the backtest worse).

Why these choices (`etl/analysis/tl_forecast_backtest.py`), on the completed launches with signups and
window purchases, each read at its open against the basket it could have had then (its plan size, Airtable's units target else edition,
and price; launches that closed later left out; 66 of 71 have a plan size). Two launches are set
aside from this fit alone, at the owner's word on 4 October 2026, and stay on the panel and in the
baskets: Danielle McKinney's Sandman (2025 Q1) and Parra's 2025 Q3 launch, whose pre-window
campaigns brought a flood of signups that hardly ordered (6% and 2.5% signup -> order against the
panel's 15%), so neither says how signups turn into sales. Setting them aside moved nothing that
matters: with them in the fit the figures below read 41%, 35%, 6% high, a band of 0.61 to 1.64 and a
slope of 0.21 (`--keep` reruns that). The figures: the forecast's median error on a launch's window
units is 41% (35% of launches within 25%, a 4% lean high); the signup-led half alone reads at 32%;
converted signups times pieces per order reproduces the signup-led units to 2%. The product page keys 90% of a launch's product signups to a work (middle
half 81 to 94%), and the split it gives is 6 share points off the window's, with the best seller
right 87% of the time, against 8 points and 48% for Airtable's units-target split. Within a launch
the works' own signup -> order rates differ by 5 points at the median, so the basket's rates by
channel and kind are applied to each work's signups. Where those launches landed around this
forecast is the band: the middle half between 0.63 and 1.62 times it.

A launch far above its basket on signups does not get a new basket. Tested: picking the eight
launches nearest on pre-window signups and price instead of on the plan's size reads the window
42 to 55% off and 23 to 36% high, because the launches that drew many signups did not sell in
proportion (those at 2 to 4 times their basket's signups sold 0.9 times its non-signup units and
1.1 times its units; the two above 4 times, 1.0 and 1.3 times). The plan-size basket with the
fifth-of-the-way adjustment stays. The panel carries the measures behind the medians
(`signup_order_rate_prod_*`, `signup_order_rate_rel_*`, `nonsu_units_*`, `ppo_su`, from the feed's
`signups_product`, `signups_product_converted` and `units_with_signup` columns, `etl/aggregate_tl.py`).

The card is one row per work, the signup-led and non-signup units on the work's edition, the band
behind them and the units target as a tick; the headline is the release's sell-through on the
page's horizon with the band's ends beside it, and the foot says how the works were keyed. Decided
on 4 October 2026: a fifth of the signup effect on the non-signup half, works split by signup
interest, the page's horizon, a point with its range.

## 4c. The forecast as a table (pre-window)

Under the signup trajectory and above the forecast card, across the page: the LE page's
sell-through table in a timed launch's terms (12 November 2026, `web/src/modules/TLForecastTable.jsx`,
rows from `web/src/tlForecastRows.mjs`). A row per work and the release as the last row where
there is more than one work. It adds no model: every figure is one the page already carries.

| Column | Reads |
|---|---|
| Signups | the hero's signups to date |
| Signup target to date, vs target | the target's pace by today (`hero.expectedToday`) and the gap to it |
| Forecast signups | the signups projected to the open (`sellForecast.open.signups`) |
| Forecast sales from signups | the signup-led units at the open (§4b) |
| Forecast non-signup sales | the non-signup units at the open (§4b) |
| Forecast total sales | their sum, the band's ends on hover |
| Target | the units target |
| Forecast | total sales over the units target: a timed launch has no edition to sell through, so its target is the measure |

Where two works carry the same name, each has a second line under it that tells them apart: the
words of its page's address the other does not have (`etl/tl.py work_lines`, `line` on the
forecast's works: "Red" and "Yellow" under Marina Abramović's two Energy Hat (Eyes Closed)).

A work's signups are the ones keyed to it by product page plus its share of the rest; under the
keyed minimum, its share of the units target. Its target to date is the release's on its share of
the units target. The works add up to the release's row (`tests/tl_forecast_rows.mjs`).

## 5. In-window state: sales

An entirely separate page state, not a toggle on the pre-window one. **Headline: units sold
against Airtable's units target**, with hours left. Units are paid plus awaiting payment
(drafts and pending), cancelled out, by pieces; private-room orders in the window count. The
LE page's secured-units reading, without a draw forecast.

```
units           = pieces on paid lines + pieces on draft and pending lines, in the window
pace            = the basket's median cumulative share of window units by hour of window,
                  the hour read as a share of the window (hour h of H), so 24, 48 hour and
                  7 day windows compare
benchmark       = the basket's median units at the same share of the window
```

**The cards are the LE page's cards**, in the shared layout and in units, the page's clock
running in hours from the sales open (`clock: {unit: "hour"}`; the day helpers in
`web/src/format.mjs` read it, so a day of the LE page is an hour of the window, "Tue 30 Jun
20:00 · hour 31"):

| LE card | On a timed launch inside its window |
|---|---|
| Campaign clock | open -> close, hours left (the TL strip) |
| Units vs sellout | **Units vs target**: units sold against the target by now, the benchmark's pace as the outline, the units target at the end of the track; at close the projection |
| Channels vs targets | units by split-touch channel against each channel's share of the target (the basket's unit shares) and the basket's |
| Funnel by channel | the window's sessions by channel and the rate they bought at, held at the basket's window rates (`conv_window`, a panel measure), the buyers and the pieces per buyer split where they differ from the plan's; paid spend and cost per sale. The email stages step aside (`email.funnelStages` false): the sends on the card are the pre-window's and do not explain the window's sessions, so AA Email reads as sessions and conversion like the other groups |
| Unit trajectory | cumulative units by hour from the sales open against the target's pace and the benchmark's (the basket's unit curve), the projection to the close, by channel |
| Page funnel | the Organic funnel still: the window's sessions and session -> sale over the organic channels |
| Paid ROI | **Paid ROI** on a paid sale's worth (AA's profit on a unit with the likely framing profit, net of cannibalisation) over what it cost AA; the cost view the window's daily spend and the cost per sale against the plan's and the cost at the target ROI |
| Paid spend / day | the spend that paces the window budget left over the hours left, paid units and spend against the budget's share by now and the basket's |
| Sell-through by product | **Sell-through by work**: one row per work, paid and awaiting payment from the orders table against the work's units target (the bar runs past the target where the work has sold more), at close with the projection's still to come; the headline the launch's units over its target, uncapped |
| Framing | frames per print on the window's paid prints and on the orders awaiting payment, by work, against the basket and Airtable's take-up |
| Entries by country | not on a timed launch |
| Actual vs target | the waterfall from the target to the units today (the projection at close) |
| Pre-window signups | a card of its own, timed launches only: the pre-window's result once the window has opened |

Orders, pieces per order, awaiting payment with its value, the private-room and cancelled units
and the feed's purchase events as the cross-check stay in the snapshot's `sales` block (the
sell-through card's popups read it); the multiples are the funnel's pieces-per-buyer row.

## 6. Closed state

The in-window layout at its final figures: units against target, the complete hourly curve,
the channel split, paid cost, framing, the works and the pre-window's result. For 7 days after
the close the page is `settling` and keeps reading drafts paid, payments cleared and
cancellations (the close hour's step of every series takes them, so the window's units are its
lines paid or awaiting by the settle, as the panel counts them); the sidebar row says so. Then
the figures are final, the page is `closed`, and it is listed with the closed releases. A
settling or closed page projects nothing: its projection is its actual.

## 7. Target setting for TLs

The tab is the LE tab's own components in TL words (`web/src/TLTargets.jsx` on
`TargetSetting.jsx`: the form language, the basket picker, the products grid, the stretch
sliders and the channel table), so the two tabs read the same way; what differs is the target's
unit, signups before the open where the LE reads units. It asks for:

- **Units target.** Airtable's `units_target` summed over the ticked works (400 for Bisa Butler:
  one work carries 400, the other none and adds nothing), typed over per work on the products
  grid, where a Units target column stands in place of the LE grid's sell-through. Edition sizes
  are shown beside it (300 and 300) and cap nothing.
- **Signup -> order rate** and **purchases per order**: the basket's medians by default, typed
  over.
- **Channels in plan** and **where the stretch comes from**, as LE (the sliders).
- **The basket**, picked from TL baskets (§8).
- **Paid budget**, split between the pre-window (buying signups, priced at the basket's median
  cost per signup) and the window (buying sales, at the basket's median cost per sale); the split
  defaults to the basket's median, else 70 / 30 as the workbook template has it, and is typed
  over. Sense check as the template: total budget at most 6% of launch value.
- **Cannibalisation** for paid: the TL panel's 0.1 by default (the LE default is 0.2), typed
  over.
- **Products grid** as LE (the same grid with the TL column set), with the tick; a work unticked
  counts nothing (§1.6 of the data model).
- **Marketing lead**, read rather than asked, as on the LE tab: the Notion log's name for the
  campaign (by code, else by the launch's name), else Airtable's field on the launch's records,
  else typed (`resolve_lead`; the snapshot's `marketingLead` and `inputSources.marketing_lead`).

```
units from signups    = units target x (1 - non-signup share)
orders needed         = units from signups / purchases per order
signup target         = orders needed / signup -> order rate
sessions needed       = per channel: signups share / session -> signup rate
pre-window budget     = paid share of signups x signup target x cost per signup
worth of a unit       = AA profit per unit + share of units framing x frame take-up x AA profit per frame
worth of a paid sale  = worth of a unit x (1 - cannibalisation)
worth of a paid signup = worth of a paid sale x pieces per order x paid signup -> order rate
cost at an ROI        = worth / (AA's share of the spend x ROI)
in-window budget      = paid share of units x units target x cost per sale
```

**The non-signup share** (23 November 2026) is the basket's median share of a launch's units
bought by people who never signed up (`units_nonsu` over the two kinds, `nonsu_share` on the
profile, held under 0.9; `nonsignup_share`, `nonsignup_units` and `signup_units` on the targets).
The signup -> order rate is the orders the signups placed over the signups, so it only ever
accounts for the units signups bring; until this date the sum asked the signups for every unit,
and Marina Abramović's 1,600 units read as 16,530 signups, a third more than any launch has
gathered. The window's budget still reads the whole units target. A basket with no share on file
(a profile saved before this date) asks as before.

What it was held to (`etl/analysis/tl_signup_target_backtest.py`, 35 launches closed since 2025
with 300 or more signups and 100 or more units): each is taken off the panel, given the basket the
live rule picks today, and the sum is asked how many signups the units it sold needed. Asking
every unit of the signups read 1.64 times the signups the launch gathered at the median (a typical
miss of 95%); less the non-signup share it reads 1.01 times (62%), and 1.03 against 1.67 on the 12
that sold 600 or more. Two cautions. Signups are a loose guide to sales either way: the middle
half of launches sits between 0.56 and 1.40 times the sum. And launches are gathering more signups
for each sale than they did (the 23 closed since July 2025 turned 9.4% of signups into orders
where their baskets read 12.4%), so on those the new sum reads 0.67 times what they gathered, as
far under as the old one's 1.18 was over; a launch built on a large paid signup drive wants its
signup -> order rate typed on the tab. A closed page is read against the basket it could have had
at its close (§8), older launches that sold more without a signup, so past pages' signup targets
fall further than live ones (`--at-close`: 0.54 against the old sum's 1.13).

The frame take-up is the works' own (Airtable's or typed), else the basket's frames per print,
else the last twelve months' frames per print in the band of each work's frame price against
its print's, weighted over the works that frame (`tl_economics`, `shared/tlModel.mjs`
`tlEconomics`; `DATA_MODEL.md` §1.6), else the constant in `etl/benchmarks.json`.

The header shows the units target, the signup target, the two budgets and their uplift over
the basket, recomputed live in the browser as the LE header is (`shared/benchmarkModel.mjs`),
with the Python build agreeing to the figure (a parity test as for LE).

## 8. Benchmarks: TL baskets

The panel is every completed TL in the feed (81; 38 since 2025). Per launch, from the feed, the
orders table and the spend feed:

- window length; the pre-window length actually run;
- signups: total, by channel, and the cumulative share by day to open, read on the campaign clock as the pace (§4);
- sessions by channel and session -> signup rate by channel;
- signup -> order rate (`converted_signup` on the signups, cross-checked against purchases
  carrying `purchase_with_signup`), purchases per order;
- units: total (paid plus awaiting at 7 days), by channel, and the cumulative share by hour of
  window as a share of the window (the sales pace curve);
- paid share of signups and of units, cost per signup (pre-window spend over paid signups) and
  cost per sale (window spend over paid units);
- frames per print; the share of buyers taking multiples.

Baskets are picked as LE baskets are (`BENCHMARK_SPEC` §4a: price band, target, the
similar-size rule, the picker), with the window length as a further filter (a 48-hour launch is
measured against 48-hour launches first, falling back to all TLs when thin, and saying so). The
medians feed the targets of §7 and the benchmarks of §4 and §5. A release saved without a
basket is benchmarked against the TLs nearest its target and price, as LEs are. The rule is the
LE rule's (`shared/basketRule.mjs`, which the picker runs over `data/app/tl_basket_candidates.json`;
`etl/tl.py similar_members` in the build): the artist's own earlier launches first, then the
nearest on the units the window sold and on price, those closed in the last eighteen months
first, read on the page's day and a closed launch at its own close, so its basket stops moving
once it closes. `tests/test_tl_basket_parity.py` holds the two sides to the same members in the
same order, over the live launches, every closed launch on the panel and launches being planned.

A basket whose launches carry no channel on a measure - the earliest feed named none on their
units, or on their signups - takes another measure's mix for it (the signups' for the units, the
units' for the signups, the sessions' next) and an even split when it has none (`mix_fallbacks`,
`mixFallbacks`), so a page's channel figures add up to its headline and the waterfall's walks hold
(`tests/walks.mjs`). It touches the ten earliest closed launches and no page in flight
(7 October 2026).

## 9. Sidebar and index

TL rows carry a `TL` badge and the state in words: "signups · opens in 12 d", "window open ·
31 h left", "settling · 5 d", "closed". They sort with the LE rows by window end. Upcoming TLs
are listed from Airtable's timed launches as upcoming LEs are (`UPCOMING_TYPES` grows a TL
path; a timed launch is no longer "not a draw, so not listed" but "a TL, so listed as one").
The index row carries `type: "TL"` and `tlState`; the snapshot carries the state, the open and
close timestamps and the hours left.

A record saved from the TL Target setting tab (type `TL`, the TL page's id) is the TL build's alone:
`build.py` leaves TL-typed records out of the LE loops (`le_records`) and keeps one sidebar row per
id, the TL row where two meet (`one_row_per_id`). Before (5 October 2026) a saved TL record was
also built as an LE page under the same id: Bisa Butler stood twice in the sidebar, "signups ·
opens in 7 d" and "15 Oct".

## 10. Out of scope now

Slack posts for TLs (pages only until asked); the denied aggregated TL export (not needed); a
signup-led attribution of window sales to the channel that produced the signup (recorded as a
possible toggle later; the page attributes by split touch).

## 11. Build plan

1. **Feeds and release model (to 6 October).** The two TL pulls with the hourly browsing grain
   and the personal-data rule; TL release discovery and matching (`type: "TL"`), Airtable's
   timed launches as upcoming TLs; the TL panel and baskets (§8); the Target setting tab in TL
   words with the live header; the pre-window page with Bisa Butler live; the sidebar state.
2. **The window (to 12 October).** The in-window state at hourly grain with its eight cards, the
   30-minute refresh while a window is open, the settling and closed states; rehearsed by
   replaying a completed 48-hour launch's window from the feed, since no live window runs before
   the 13th; tests and Python / JS parity as for LE.
3. **After the first window (from 16 October).** What the first live window taught; Slack posts
   if wanted; the signup-led attribution toggle if wanted.

Risks and costs: the TL feed is 0.5 GB to scan in full, so the pulls are incremental like the
LE ones and the hourly browsing counts are aggregated inside BigQuery; the hourly state has no
live test before 13 October, hence the replay; Airtable's `launch_time` is blank on the first
launch, hence the feed's timestamp as the second reading.

## 11a. Where the build stands (1 October 2026)

Phases one and two are built and deployed: the two feeds, the aggregation, the release model
with its states, the panel (74 completed launches) and baskets, the targets with the live
header, the signups state's cards, the sidebar state; and the window state from the orders
table (`data/tl_units_hourly.csv`, `data/tl_buyers.csv`, pulled with the TL feeds: units paid
plus awaiting by hour, channel, product and status, framing, the buyers of several pieces,
the feed's purchase events as the cross-check), the settling and closed states at the final
figures, the 30-minute refresh while a window is open (`REFRESH_WINDOW_MINUTES`), and the
replay (`etl/tl.py --now=`), rehearsed on Gregory Crewdson's 2026 window: at 20:00 UTC on 30
June it read 1,700 units against 852 expected by then, 44 hours left. Not built: Slack posts
and the signup-led attribution (§10).

What the data showed on the way, and how the build reads it:

- **The sales start a day before the public open.** The platform's "TL - Early access" stage
  sells private-room orders from about 24 hours before the open (Gregory Crewdson's 2026
  launch took 2,147 pieces in the 48 hours from 16:00 UTC on 29 June, the day before its
  30 June open). The window state begins with the first hour that sold five pieces or more
  within 36 hours of the open, the sales pace curve is measured from it, and a launch still
  to open expects an early access 24 hours before, said as expected.
- **A private-room sale is the early access begun** (24 November 2026). The private room is
  the early access, so the first hour within 36 hours of the open that holds a private-room
  sale starts the window as an hour of five pieces does, whichever comes first: on the feed's
  purchases, and on the orders table's paid and awaiting lines where it has the launch's
  (`etl/tl.py early_access_from`). Until then a quiet early access was not seen at all. Matt
  DesLauriers' Serac sold three private-room pieces at 14:00 UTC on 23 November, the day
  before a 17:00 UTC open on Airtable's time (the feed dates its launch 14:00 UTC); no hour
  reached five, so the window was counted from the hour expected, 17:00 UTC, and the page
  read 3 units at noon on the 24th where the orders table held 7 (6 paid in the private
  room, 1 awaiting payment). At the public open the expectation would have lapsed and the
  page counted from the open, with none of them. On the panel 16 of the 75 completed
  launches move: six whose early access had never been seen, their windows now opening 21
  to 35 hours before the public open (Em Cooper's 2026 launch read 25 units where it sold
  43; Grayson Perry's Magical Thinking counted 614 signups of its early-access day as
  pre-window) and ten whose windows open 1 to 17 hours earlier (4 at the median) and hold
  1 to 9 units more (Gregory Crewdson's 2026 window runs 75 hours, from 13:00 UTC on 29
  June). The panel's medians hold: signup -> order 14.5%, 401 units, 1,036 signups.
- **The early access is timed from when its email went, not from when the room opened** (24
  November 2026, the owner's call). The room can sell a piece before anyone is told it is
  open: William Mapan's (Un)confined sold one at 12:00 UTC on 23 November and its early
  access email went at 14:00 UTC, so the reading above began its window two hours before
  the early access. The window now opens on the hour the launch's first early access email
  was sent (`early_access_email`): a batch email of its campaign whose name says early
  access, within 36 hours of the open. Three things hold it to what the sends can say.
  *Batch emails only.* HubSpot keeps a send time for an email sent once; for an automated
  email, sent by a workflow, it keeps the time it was published, hours or days before it
  went (Bisa Butler's "Early Access (TL Flow)": published 9 October 2026, sent on the 12th),
  so the sends file carries each email's `Kind` (`server/hubspot.js`) and an automated email
  times nothing. *An hour of five pieces before the batch email still starts the window*:
  that burst is an early access email the file cannot time, the workflow's (Barry McGee's
  2025 launch sold 32 pieces at 11:00 UTC, three hours before the insiders' batch email); a
  lone private-room sale before the email does not. *With no email timed on file the sales
  say it as before* (the hour of five pieces or the first private-room sale), which is every
  launch whose early access went by workflow alone. Two launches sold together share their
  emails and each email is filed under one code, so a launch reads the emails under its own
  code and those named for the campaign its own are named for (the one "WillMatt_TL_26"
  early access email, filed under Serac's code, times both). **No piece is left out for
  having been sold before the email**: the orders table's lines made between the room's
  first sale and the email are counted in the window's first hour (`tl_dates`
  `count_from`, `window_from_orders`), so (Un)confined's clock starts at 14:00 UTC and its
  window still holds the 10 pieces the orders table does. On the 75 completed launches 28
  of the 39 since November 2024 carry a batch early access email, and it falls on the hour
  the sales reading gave for all but two, whose windows open with the email and not with
  the private-room sales a few hours ahead of it: Gregory Crewdson's 2026 launch (16:00 UTC
  on 29 June again, where the reading above had moved it to 13:00) and Cleon Peterson's
  Shame (16:00 UTC on 16 September 2025, from 12:00). Their units on the orders table stand
  (2,870 and 200); the feed's own count of the window, which is not moved into the first
  hour, reads 5 and 1 fewer (2,806 and 197). The panel's medians hold. The snapshot says which reading is
  in force (`earlyAccessSource`: email, sales or expected).
- **The feed's `launch_date` runs an hour late in summer time.** Against Airtable's
  `launch_time` and the sales bursts over the 2025-26 launches it reads 17:00Z where the
  launch was 16:00Z (18:00 Amsterdam) in CEST, and agrees in CET. The open is Airtable's
  time first, else the feed's less that hour in summer, else 14:00 Amsterdam time; Bisa
  Butler opens 13 October at 16:00 UTC, 18:00 Amsterdam, not 17:00 UTC as §1 first read it.
- **Airtable's records can carry a stale announce date beside the current one** (Carrie Mae
  Weems: 3 August on two works, 26 October on the third). The latest date before the open is
  taken.
- **`tl_events.csv` carries no Shopify order id**, as the LE feed carries none: the window's
  units are joined to their purchase events inside BigQuery (`tlUnitsSql`), so no order id
  travels. §3 said the id would; this is the safer reading.
- **The orders table reads a little under the feed** (Crewdson: 2,879 paid pieces in the
  settled window against 2,941 pieces on the feed's purchase events, after cancellations and
  refunds), so the two are shown side by side and the orders table is the headline.
- **Signups on some launches carry no channel.** Carrie Mae Weems' 2025 launch had 8,549 of
  11,213 signups untracked. The channel shares are read over the tracked signups and the paid
  cost per signup prices the untracked ones in at the tracked paid share, as the LE panel
  folds its untracked units.
- **A paid signup converts at a fraction of an email one** (the panel's medians: paid 8%,
  AA Email 29%, Search etc. 30%). The signup target's rate is the basket's rates by channel
  weighted at its mix of signups, so a paid-led plan needs more signups per order; a typed
  rate still wins.
- **The feed names the release on fewer sessions than signups for some launches**, so a
  session → signup rate over 50% is unread rather than taken as a conversion.
- **The TL feed and the LE feed share the release naming**, and an artist can have one of
  each in a quarter (Ai Weiwei, 2026 Q4), so a TL page's id carries a `_tl` suffix.
- **A TL page runs before anyone saves**: on Airtable's units target summed over the ticked
  works and the suggested basket (the nearest launches by target and price among those of the
  same window length, falling back to every length when fewer than six). Saving on the tab
  makes the targets the release's own.
- **The Overview is the LE Overview** (2 October 2026). The first cut had cards of its own (a
  pace chart, group columns, tables of sends, paid signups and orders); the page now renders the
  LE cards through the shared layout, in the state's words, off the LE-shaped blocks the build
  writes beside the TL ones (§4, §5; `tests/test_tl_page.py` holds the channels to the hero, the
  funnel's contributions and the waterfall's steps to their gaps, on the build's day and on the
  Crewdson replay). The explainer stays off on a timed launch until its explanations are
  written; Slack posts and the LE paid rule engine are not applied to timed launches.
- **The Direct switch** (5 October 2026, §3b): every TL page is built both ways, the basket's
  launches read the same way and the plan's budgets held; the sell-through forecast is the one
  card that keeps the feed's attribution. The TL build takes about twice as long for it (59 s
  against 32 s on the day).
- **The Target setting tab is the LE tab in TL words** (2 October 2026). Its first cut was a
  compact form of its own, with a basket select and a plain products table; it now runs on the
  LE tab's components (the basket picker over the TL panel, the products grid with a units
  target per work, the stretch sliders and the channel table in signups and sessions), and the
  TL basket rule was brought onto the LE rule's clock so the picker's suggestion is the build's
  basket (`tests/test_tl_basket_parity.py`, 136 cases on the day it was written). Bisa Butler's
  suggested basket moved with it, from eight launches at ×2.40 to eight at ×2.07 over the
  basket's median signups.

## 12. Decisions log

| # | Question | Answer |
|---|---|---|
| 1 | Which releases get a TL page | Airtable `Timed`, matched to the TL feed; upcoming TLs from Airtable |
| 2 | First launch to build and test on | Bisa Butler, Be Mine (13 October, 48 hours) |
| 3 | Where the state boundaries come from | Worked back from Airtable's launch date and window length |
| 4 | In-window time grain | Hourly in-window, daily elsewhere |
| 5 | Pre-window headline | Signups against a signup target worked back from the units target |
| 6 | What a signup is | Every signup event for the release before the window opens |
| 7 | Target basis | Airtable's units target |
| 8 | Benchmarks | A basket of past TLs |
| 9 | In-window headline | Units sold against Airtable's units target |
| 10 | Which sales count | Paid plus drafts |
| 11 | Channel attribution in-window | Split touch, as LE |
| 12 | Paid across the states | Two page states; pre-window paid is the signups it buys, in-window paid is the sales it drives directly |
| 13 | Sidebar | Mixed with LEs, badged, the state shown |
| 14 | Slack | None for TLs yet |
| 15 | After the close | A closed page at the final figures |
| 16 | Opening hour | Airtable `launch_time`, else the feed's timestamp, else 14:00 CET |
| 17 | Pre-window start without an announce date | When the first few signups land (10 or more in a day, within 45 days of the open) |
| 18 | Target setting for TLs | Target, rates, channels, basket, paid split |
| 19 | Pre-window cards | Signups by channel; sessions and signup rate; email sends to signups; paid signups and cost per signup |
| 20 | In-window cards | Hourly curve; channels; paid sales and ROI; orders and awaiting; framing conversion; orders per product; multiples; broadly the LE page |
| 21 | Pre-announce signups | Counted in the headline; the chart runs from announce |
| 22 | Opening hour precedence | Airtable, then the feed's timestamp, then 14:00 CET |
| 23 | Units target over several works | The sum of the targets present (400) |
| 24 | Settling after the close | 7 days, then frozen |
| 25 | Direct switch on TL pages | The LE switch in both states, the basket's launches read the same way, the plan and its budgets held; the sell-through forecast keeps the feed's attribution (5 October 2026) |
| 26 | Where the basket's launches show | A card in the Overview's grid, last by default: one launch per row with units and price, nothing else (5 October 2026) |
| 27 | The clock the signup pace is read on | The campaign clock, as LE: the share of each launch's announce -> open span gone by, a span starting where the signups began when that is after the announce on file; the panel's pace under 4 launches (16 November 2026) |
| 28 | How much to spend a day before the open | The LE's Spend levels card, read on signups: the cautious level on the page's own cost path, what a paid signup is worth among what is unsure, the budget's pace marked and no cap (section 4; 25 November 2026) |
| 29 | The pre-window page's unit | Signup conversions (assumed): each channel's signups at the rate they go on to order, the target the orders needed from signups; a switch back to signups (section 4a; 25 November 2026) |
