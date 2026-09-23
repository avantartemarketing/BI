# Baskets: what the data says and a proposal

> Figures in this proposal are in sterling at the 0.85 rate then in use; the dashboard now runs in euros (docs/DATA_MODEL.md, currency).

An analysis of how the benchmark basket could be chosen and shown better,
against the five points raised on 20 September: size and price as the
primary criteria, seeing and editing the basket every time, estates against
living artists, a switch for launches that cannot run paid, and naming the
basket's members on the results page. Numbers come from the draw panel
(`data/release_clusters.csv`, `panel == "draw"`, 108 launches, all priced
from Airtable, 106 with an edition size) and from leave-one-out tests in
which each launch is benchmarked by a basket that never contains itself.
The scratch scripts are not in the repo; the rule under test is
`similar_members` in `etl/baskets.py` with its constants swapped.

## 1. What the basket does today

The suggested basket is `similar_size` for every live release. It searches
from strictest to loosest: launches within a band of the target on units
AND within the same band on price AND in the same shape cluster, widening
the bands through 2x, 2.5x, 3x and 4x until eight members answer; then
size and price without the shape; then size and shape; then size alone.
On the panel that answers at 2x for 56 launches, 2.5x for 30, 3x for 6 and
4x for 14, and the shape rung answers for 98 of 106. The typical basket has
11 members. The benchmark is the basket's median units, per channel median
share times median total, and the target is that median times one even
uplift K.

The live releases today:

| Release | Target | Basket | Median units | K |
|---|---|---|---|---|
| Glenn Ligon | 150 | 9 | 149 | 1.01 |
| Dali | 1,200 | 8 | 806 | 1.49 |
| Abdulnasser | 40 | 10 | 32 | 1.25 |
| Zeng Fanzhi | 100 | 23 | 101 | 0.99 |
| Mondrian | 900 | 8 | 676 | 1.33 |
| Schnabel | 500 | 11 | 317 | 1.58 |
| Parra | 300 | 10 | 269 | 1.12 |
| James Jean | 600 | 12 | 476 | 1.26 |
| Warhol | 2,440 | 6 | 865 | 2.82 |

Warhol's basket is the six largest draws on file, found on size alone at 4x:
two Cattelans, the Albers, the Mondrian, Murakami and Pejac, with paid unit
shares from 0 to 37%. Mondrian's eight include Murakami and Pejac, which ran
no paid at all. That is the mix the estate and paid points are about.

## 2. Size and price as the primary criteria

Size is the criterion that carries the units benchmark; price is the one
that carries the conversion benchmarks; the shape cluster takes away from
the first without being needed for the second.

Leave-one-out on the 106 sized launches, benchmark = basket median units:

| Rule | Median error | Within 1.5x | Within 2x | Typical basket |
|---|---|---|---|---|
| Current: size, price and shape, then looser | x1.31 | 68% | 92% | 11 |
| Size and price | x1.22 | 76% | 96% | 22 |
| Size and shape | x1.23 | 77% | 95% | 15 |
| Size alone | x1.22 | 80% | 96% | 45 |

The tighter the basket, the noisier its median: the current rule's baskets
of 11 predict units worse than size alone at 45. Price does not improve the
volume prediction because the panel's price and size already move together
(big editions are cheap), so the size band carries the price information.

Conversion is another matter. The targets hold conversion at the benchmark
and ask the uplift of traffic, so the sessions and entries targets are the
units target divided by the basket's conversion rates, and those rates move
with price more than with anything else on file. By price quartile of the
draw panel (108 launches, medians):

| Price quartile | Median price | Entries per session | Units per session | Entry to unit |
|---|---|---|---|---|
| Cheapest | £616 | 1.4% | 2.29% | 0.39 |
| Second | £1,275 | 1.6% | 1.76% | 0.21 |
| Third | £1,976 | 1.1% | 0.92% | 0.22 |
| Dearest | £5,100 | 0.6% | 0.67% | 0.11 |

Doubling the price cuts units per session by about a quarter (elasticity
-0.45 in log-log; -0.38 for entries per session), and price explains three
times as much of the conversion variance as size does (R2 0.20 against 0.07
for units per session). A £5,000 launch benchmarked on size alone inherits
a cheaper basket's conversion and a sessions target it could hit without
trying; a £600 launch the reverse. Conversion is noisy launch to launch (no
basket predicts it within 1.5x more than four times in ten), so the price
band does not make the conversion benchmark precise, but it stops it being
wrong in a known direction.

What the shape cluster is good for is the channel mix. It predicts the paid
share of units with a mean error of 0.06 against 0.08 to 0.09 for the size
and price rules, and entries per session within 1.5x for 43% of launches
against 34% to 38%. Shape is a mix signal, not a volume signal, and section
4 proposes an explicit switch for the mix instead.

Recommendation: match on size and price together, keep the widening bands
and print the band that answered ("within x2.5 on units and price"), raise
the floor from 8 members to 12, and drop the shape cluster from the default.
Size sets the units median, price sets the conversion medians, and neither
is given up before the other; the band widens on both. Keep the clusters as
ready-made baskets the picker can offer.

What this changes on the live releases: nothing on seven of the nine, whose
size and price band already answers before the shape rung; Parra's basket
grows from 10 to 15 and its median falls from 269 to 200 (K 1.12 to 1.50);
James Jean's from 12 to 13 and 476 to 456. Against size alone the price
band costs four points of accuracy on the units median and buys conversion
benchmarks of the right order, which is the better trade.

## 3. Seeing and editing the basket every time

The picker exists (`web/src/BasketPicker.jsx`) behind a button on the
Target setting tab: ready-made baskets as radio buttons, each with its
medians and "e.g." three member names, and a bespoke rail for a hand-picked
basket. The members are visible only in a tooltip and only after opening
the picker.

Proposal: the basket is shown on the Target setting tab without a click, as
a list of its members with the fields that make them comparable, one line
each: launch, units sold, price, paid share of units, estate or living, and
the band it was found in. Every member has a tick; unticking one, or ticking
a launch from the rest of the panel below the list, turns the basket into a
bespoke one through the machinery that already saves bespoke baskets, and a
"back to the suggested basket" link undoes it. The medians and K update as
the ticks change, which the picker already does in the browser.

## 4. Estates against living artists

The panel has no estate flag. Airtable carries tier and genre but not
whether the artist is living; only Mondrian carries "Estate" in its name,
the Albers launch is a foundation and reads as a living name, and Warhol is
not in the panel yet. Names will not do.

A proxy shows the effect is real. Launches whose artist referral traffic
is under 1% of sessions, which is what an estate looks like in the data,
against the rest:

| | Launches | Median units | Median price | Ran paid | Paid share of units |
|---|---|---|---|---|---|
| Artist audience present | 69 | 87 | £1,402 | 39% | 0.08 |
| No artist audience | 39 | 101 | £2,125 | 64% | 0.13 |

Launches with no artist audience run paid two thirds of the time, at a
higher paid share, and at a higher price. Restricting the basket to the same
kind by this proxy did not change the units accuracy (x1.22 either way), so
the flag is not about volume. It is about the channel mix the plan inherits:
an estate benchmarked against Murakami and Pejac inherits a paid share of
zero and an email share it cannot reach.

Proposal:

- An input on the Target setting tab, `artist_status`: living or estate.
  Required when targets are set.
- A column in the panel with the same values, labelled once by hand for the
  108 draw launches (a morning's work for someone who knows them), and an
  Airtable field "Artist status" on the artist record so new launches carry
  it. Until the column exists, the referral proxy above stands in and is
  named as a proxy on the page.
- The basket search adds the status to its first rung: size, price and same
  status; then size and price; then size. The per-channel medians, which set
  each channel's share of the target, are read from the same-status members
  when there are at least six of them, so an estate's plan leans on paid and
  email the way estates do.

## 5. A switch for launches that cannot run paid

56 of the 108 draw launches ran next to no paid (under 2% of units), so any
size basket already mixes launches with and without paid, and the question
is what to do with the paid part of the members that ran it.

Leave-one-out with a size and price basket, benchmark = the members' median
of total units, or of organic units (units less the paid share):

| Launches | Total-units median within 1.5x | Organic-units median within 1.5x |
|---|---|---|
| Ran no paid (55) | 80% | 84% |
| Ran paid (51) | 73% | 65% |

For a launch that will not run paid, the organic median is the better
benchmark; for one that will, the total median is. That is the switch.

Proposal: an input `paid_allowed` (yes or no) on the Target setting tab,
next to the paid channel size pick. When it is no:

- the basket keeps every member, including those that ran paid; they count
  with their organic units only, so the benchmark is the median of
  `units x (1 - paid unit share)`, and K is target over that median;
- the paid group leaves the per-channel benchmarks and the targets, the way
  a channel marked N/A does today; the paid budget, cost per purchase and
  the paid recommendation are not computed; the page shows the paid channel
  as "not run";
- the sell-through and the hero are unchanged, since they read actuals.

For Warhol that would move the basket median from 865 to 688 and K from
2.82 to 3.55, which is the honest statement of what organic alone would
have to do.

## 6. Naming the basket on the results page

The snapshot carries the basket's id, name and count but not its members
(`snap.benchmark.basket`), so the results page cannot list them today.
`resolve_basket` already returns the members; writing them into the
snapshot with each member's units, price and paid share is a small change
in `etl/build.py`.

Proposal: a "Basket" line under the hero on the Overview: "9 launches within
x2 on units and price: Glenn Ligon 149, ... " with the full list in the
tip, the band, the estate and paid settings in force, and "paid stripped"
when the switch is off. The same line is the header of the picker on the
Target setting tab, so the two tabs describe the same basket in the same
words.

## 7. Order of work

1. Members into the snapshot and the Basket line on the Overview. Small,
   and it makes every later change visible.
2. The rule: size and price first, shape out of the default, floor 12. One
   function and its tests; two live releases move. **Done, but not as
   written.** The floor of 12 was wrong, and so was the reading of section 2
   that led to it: the leave-one-out above compares *rules*, and the basket
   sizes they happen to produce came along with them. Re-run against basket
   size directly, over the same 106 launches, units at close:

   | basket | median error | within 1.5x | within 2x |
   |---|---|---|---|
   | the band rule | x1.31 | 72% | 92% |
   | nearest 6 | x1.15 | 82% | 95% |
   | nearest 8 | x1.21 | 83% | 95% |
   | nearest 12 | x1.23 | 72% | 97% |
   | nearest 45 | x1.32 | 65% | 84% |

   Smaller is better, and 45 is worse than the rule it was supposed to beat.
   "Size alone, typical basket 45, best error" in section 2 was measuring a
   size-only band, not the 45 nearest on units and price, and the two are not
   the same selection. The rule is now the 8 nearest on units and price, 8
   settled on steadiness (dropping one member moves the median 2.8% at eight
   against 3.3% at six) and on the conversion benchmarks, which prefer more
   members and are near-indifferent between 8 and 45 while 6 gives up ground.
   Shape is out of selection, worth two live releases as predicted. Six live
   releases move in all.
3. The basket list with ticks on the Target setting tab, on the existing
   bespoke machinery. **Done, then redesigned as the map** (22 September):
   a scatter of units against price with this launch as the ring, the eight
   nearest as the basket, the reach drawn as the box it is, the list under it
   for editing. The rule gained the artist's own earlier launches first
   (within x3) and a per-release "prefer recent" switch (18 months, a tier
   among launches within x4, on by default). A release with no target asks
   for units and price in place. The ready-made gallery is gone. Still open
   from step 1: the members are not on the snapshot, so the results page
   cannot yet name them. Step 2 is not done, so the suggestion is still the old rule's -
   the list shows what that rule picked, which is the point: Warhol's six
   members and their 2.5x to 3.9x spread are now on screen rather than
   behind a name.
4. `paid_allowed`: the organic median, the paid group removed from the
   targets, the page wording. **Done, as `channels_off`** (BENCHMARK_SPEC
   4.3): a list of groups rather than one flag, so the artist's own channels
   can be set aside the same way. The picker's switch is live, the Target
   setting tab has the switches and the per-channel table reads `not in
   plan`, the Overview's channel and paid cards say so, and
   `tests/test_channels_off.py` holds the JS rail to the Python build. The
   median is share-based - the basket's median share of each group times its
   median total, which is what the per-channel table already read - rather
   than the per-member organic median first proposed, so the table, the rail
   and the build all quote one number.
5. `artist_status`: the input, the panel column and its hand labelling,
   the same-status rung and the same-status channel shares.

Steps 1 to 3 change no target the team has not chosen to change. Steps 4
and 5 do, release by release, as the switches are set.
