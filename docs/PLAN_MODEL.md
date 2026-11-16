# The plan model: reading a launch by what goes out

A second way to read a draw launch, built beside the campaign clock and replacing nothing.
The clock (docs/METHODOLOGY.md 5 and 6) says how far along a launch should be by today.
The plan model says what the launch's comms plan is worth: what has gone out, what is still
to come, and how that compares with the plan a usual launch would still have ahead of it.

**Where it stands (16 November 2026).** The feeds, the price list and the back-test are in
the repository. Nothing is on a page yet, and nothing here is part of the hourly refresh.
The page comes next, mockup first (section 7).

---

## 1. The brief

The repository owner's, on 16 November 2026:

- Targets exist to make decisions, and the decisions are two: the comms that go out and the
  paid budget. The clock does not tie performance to either, so it is hard to know what to
  change.
- The question to answer: given where we are and what we have planned, should we change
  anything?
- The target stays where it is. A lighter plan does not lower the bar; it shows as a shortfall.
- Every channel whose effect the history can show, and no others.
- Draw launches first.
- Built in parallel. The existing model keeps running as it is.

And agreed in the same conversation: when it reaches a page, the plan is the reading shown,
and the clock stays underneath as a check that speaks up when the two are far apart (most
often a sign that the plan in Notion is incomplete).

## 2. The feeds

Two new pulls, each run by hand for now.

**The comms plan (Notion).** `node server/commsPlan.js --write` reads the team's Comms
database: one row per piece of comms (an email, a post, a story, an artist's post, a
partner's) with the day it goes live, its channel, the campaign phase and a status. Read on
16 November 2026 it held 12,850 rows, live dates from September 2023 onwards, written a
median of 27 days before they go live, so it is the plan and the record at once. The pull
writes `data/notion_comms.csv` (7,100 lines for 195 campaigns: the rows with a live date
on a campaign that has a code) and `data/notion_comms_campaigns.csv` (the campaigns' codes
and dates). `server/notion.js`, which the dashboard already runs, reads a different
database as it is set up in this repository: the artist-post log, which holds what artists
posted and none of the emails or Avant Arte's own posts (run on 16 November 2026 it read
663 rows, none of them an email).

Three things about that pull worth knowing:

- A Notion query stops at 10,000 rows without saying so. The plan is read in slices of the
  rows' created time and joined by row id; the status line says if a slice ever reaches the cap.
- A plan row reaches its campaign code through its Campaign relation and the Campaigns
  database. The rollup of the code on the plan row itself comes back empty from the API.
- 4,804 dated rows are on no campaign with a code (Make-Ready, older campaigns, and rows
  tied to no campaign at all), and are left out. A launch whose campaign has no code in
  Notion has no plan here.

**Email audiences (HubSpot).** `node server/emailAudiences.js --write` reads the marketing
emails again and keeps what `server/hubspot.js` does not: the lists each email was
addressed to and the lists it left out, unsubscribes, and the emails built but not yet
sent. It writes `sources/email_audiences.csv` (3,433 emails from November 2023, 3,221 of
them sent). An email built in HubSpot names its lists before it goes, which is the only
place a planned audience is written down: the Notion plan's audience column is filled in
on about one email row in ten.

With the `crm.lists.read` scope on the HubSpot private app the same pull also writes
`sources/hubspot_lists.csv` (each list's name and size, and the kind of audience its name
says it is). On 16 November 2026 the token did not carry the scope, so the model reads an
audience by its size only (section 6).

**Personal data.** Neither pull reads a person. The Notion pull has no case for people or
email properties; the HubSpot pull keeps list ids and counts, and of contacts addressed one
by one only how many. Both files are ignored by git.

## 3. What the history shows

66 closed draw launches from 2024 to 2026 have both emails and a plan on file. Demand here
is demand outside paid: eligible entry units at the entry rate plus the private room's
units, by day, from 14 days before the announce to the close.

| Comms going out | Launches | Days with it, or the day after | Share of the demand arriving on those days | Such a day against a quiet one |
| --- | --- | --- | --- | --- |
| Any comms, on all demand outside paid | 66 | 28% | 72% | x7.0 |
| Emails, on AA Email's demand | 66 | 16% | 76% | x23.5 |
| Avant Arte's posts, on AA Social's | 40 | 20% | 60% | x6.0 |
| The artist's posts, on the artist's channels' | 23 | 17% | 64% | x11.6 |
| Partner posts, on other referrals' | 9 | 15% | 24% | x1.4 |
| Any comms, on Direct's | 60 | 28% | 53% | x2.0 |
| Any comms, on Organic Search's | 45 | 29% | 49% | x1.7 |

So performance follows actions closely for email, Avant Arte's own social and the artist's
channels. Partner posts show little. Direct and search rise on the days comms go out, which
is why the price list is fitted on all demand outside paid: a piece's price includes what it
brings through direct and search. Press (4 rows) and SMS (51) are too rare to read, and are
counted in a plan but given no price.

**How reliable a plan is.** Of the plan's rows whose day has passed, the share marked as
having gone out: Avant Arte's posts 99%, stories 98%, emails 96%, other AA social 94%; the
artist's posts and stories 73%, the artist's other channels 63%, partner posts 64%. A row
still to come counts at its family's share (`plan_reliability`).

**Audiences.** Of 888 launch emails since November 2023, 91% name the lists they went to
and 82% the lists they left out. Going wider brings fewer clicks a person and many more in
all: on 36 launches whose announce went to both a narrow and a wide audience, about 1,900
people clicked at 55 per 1,000 and about 56,000 at 29 per 1,000. Unsubscribes ran at about
3 to 5 per 1,000 at either width. Most lists are built for one launch (450 of 512 lists
were used on one send only), so a list's id says little without its name.

## 4. The model

`etl/plan_model.py`, pandas and numpy only. The fitted numbers are in
`etl/plan_prices.json`, written by the back-test script and committed; recomputing them is
a deliberate act, not a side effect of new data.

### 4.1 The unit: a quiet day

Everything is priced in **quiet days**: an ordinary day after the announce with nothing
going out is 1. A day before the announce is 0.10. The unit is the launch's own, so a big
launch's quiet day is bigger than a small one's, and the price list can be one list for
every launch.

### 4.2 What one email should bring

A send's clicks are read from its kind, its audience's size and where it falls in the
campaign (`expected_clicks`), fitted on 433 launch emails across 88 launches:

| Send | Audience | Expected clicks | Per 1,000 |
| --- | --- | --- | --- |
| Early access, before the announce | 3,000 | 372 | 124 |
| Early access, before the announce | 10,000 | 845 | 85 |
| Announce | 3,000 | 174 | 58 |
| Announce | 130,000 | 2,022 | 16 |
| Last chance | 3,000 | 154 | 52 |
| Last chance | 15,000 | 462 | 31 |

The rate falls as the audience widens: ten times the people brings about five times the
clicks. A launch's own record then moves its next send (`launch_pull`): the mean of how its
earlier sends did against this reading, shrunk by one send's weight.

How well that tells one send before it goes, with its launch left out of the fit: from
kind, size and timing alone the typical miss is 47% either way; with the launch's earlier
sends, 40% (announce 36%, early access 33%, last chance 38%). A single send is noisy, so a
send's figure is always quoted as a range, the middle half of how past sends landed around
their reading (x0.65 to x1.31).

### 4.3 The price list

What a piece of comms adds over its day and the two after (it fades to x0.40 the day after
and x0.19 the day after that):

| Piece | Quiet days |
| --- | --- |
| Early access email, per 100 expected clicks | 4.7 |
| Announce email, per 100 expected clicks | 1.7 |
| Last chance email, per 100 expected clicks | 1.3 |
| Sustain email, per 100 expected clicks | 0.9 |
| Avant Arte IG post | 3.3 |
| Avant Arte IG story or broadcast | 1.2 |
| Other AA social (X, Insiders IG, TikTok, Discord) | 1.2 |
| Artist IG post | 6.3 |
| Artist's other channels (their email, X, arte.bio) | 6.1 |
| Partner post | 5.3 |
| Artist IG story | 0.0 |

The close day adds 0.6 on its own and the day before it 1.0: most of the last days' rush
is the last chance comms, not the date. So an announce email to the full list (about 2,000
expected clicks) is worth about 35 quiet days, an early access email to 3,000 people about
17, and a last chance email to 15,000 about 6.

The weights are one set for every launch, none below zero, chosen to match each launch's
day-by-day share of its own demand (`fit_prices`). Read them as rough. Pieces that go out
on the same days share the credit between them and the fit cannot always tell them apart:
the artist's story reads as nothing because it goes out beside the artist's post, and the
partner post's price rests on few launches and on a channel check that shows little
(section 3).

### 4.4 A plan's value, and the usual plan left

A launch's days are laid out with what goes out on each (`launch_days`) and priced
(`day_values`). The value of the days after a point over the value of the days up to it is
how much of the plan is still ahead (`remaining_ratio`). The **usual** figure at each point
is the median over the 66 launches as they ran: 0.49 a quarter of the way from announce to
close, 0.31 at halfway, 0.17 at three-quarters.

### 4.5 The forecast

```
forecast = in so far + (the clock's figure for what is still to come)
                       x (this launch's plan left / the usual plan left) ^ 0.5
```

`anchored`. A usual plan reads exactly as the clock does, a lighter one below it, a heavier
one above. The power is the **strength**: 0 would be the clock as it is, 1 the plan taken
in full. The back-test keeps 0.5 (section 5), because the price list is rough. The scale is
held between x0.4 and x2.5.

An example with round numbers. At halfway a launch has 180 units in and the clock says 120
more. Its plan left is worth 0.23 of what it has run, where the usual is 0.31: three
quarters of a usual plan, because no artist post is left and the last chance email is going
narrow. `0.75 ^ 0.5 = 0.87`, so the forecast is `180 + 120 x 0.87 = 284`, against the
clock's 300.

This is the case the model exists for: a launch that is on the clock's pace so far, with
less left in its plan than a usual launch has.

### 4.6 Paid

Paid is left out of all of this. It already runs on its budget, not on the clock, and keeps
its own model (docs/METHODOLOGY.md 6 and 7).

## 5. The back-test

`python3 etl/analysis/plan_backtest.py` (needs scipy) rebuilds every one of the 66
launches day by day and forecasts its final demand outside paid from five points, three
ways, each launch predicted from prices and curves fitted on the other launches (12
folds). It writes `etl/plan_backtest.json` and prints the tables below. The clock in it is
the pooled median curve of the share of demand reached by each point between announce and
close, a stand-in for the page's own, which reads a basket's.

The plan as it stood at each point is rebuilt as honestly as the rows allow: a post still
to come counts at its family's reliability whether or not it went in the end, a row added
after the point is not in it, and one already marked dropped is known to be. The emails to
come are the sends that did go, since only HubSpot knows an audience.

**Day by day.** How much of the pattern of when demand arrives each explains: the clock
41%, the plan 65%.

**The final, from each point.** Typical miss either way on the final, then on what was
still to come:

| Read at | Clock | Plan alone | Anchored (0.5) |
| --- | --- | --- | --- |
| 2 days after announce | 11% and 29% | 17% and 42% | 13% and 33% |
| 25% through | 11% and 39% | 10% and 37% | 11% and 38% |
| 50% through | 9% and 41% | 7% and 40% | 7% and 37% |
| 75% through | 4% and 34% | 5% and 30% | 4% and 37% |
| 90% through | 4% and 40% | 4% and 40% | 4% and 35% |

**When the plan left is lighter or heavier than usual** (192 reads at 25, 50 and 75%):

| Plan left against the usual | Reads | What came, against the clock's figure |
| --- | --- | --- |
| Under 0.8 | 58 | x0.77 |
| 0.8 to 1.25 | 74 | x1.07 |
| Over 1.25 | 60 | x1.32 |

**How to read it.**

- The clock is already a good guess at the final total, because most launches run much the
  same pattern of comms, so time stands in for the plan. Two days after the announce it is
  the better of the two, and the plan alone should not be trusted that early.
- The plan explains when demand arrives far better than the clock does, and it is the only
  one of the two that can say what a change is worth.
- When the plan left differs from the usual, the launch lands where the plan says: about a
  quarter under the clock's figure when it is lighter, about a third over when heavier.
- On average the anchored forecast is only a little better than the clock on what is still
  to come (37% against 39% from a quarter of the way in), and the tables above move a few
  points either way from one strength to the next. The strength kept, 0.5, is the one whose
  neighbours on the grid miss least, as the cost curve's slope is kept (`etl/paid_cost.py`).
- What is still to come is hard to call either way: a typical miss of 30 to 40%.

## 6. Limits

- **Groups of people.** The model reads an audience by its size. Which groups (artist
  sign-ups, past buyers, related artists, Insiders) needs the lists' names, which need the
  `crm.lists.read` scope; `listKind` in `server/emailAudiences.js` is ready to sort them.
- **Units per email.** HubSpot gives clicks per email; units are known per day for email as
  a whole. A send's units are its clicks times the launch's units per click.
- **Same-day pieces share credit.** See 4.3. A price is what a day with that piece usually
  brings, not proof of what the piece alone caused.
- **Launches without a code.** A campaign with no code in Notion has no plan here, and a
  funnel release is matched to a code by the feeds' own guess or by artist and launch day
  (`match_campaign_codes`).
- **Before the announce.** The model needs a level to start from. A quick try at predicting
  a launch's demand from its price, edition size, artist tier and the artist's last launch
  missed by 43% (typical, 64 launches predicted from earlier ones); edition size times the
  usual demand per edition missed by 31%. So the simple rule stands until a model beats it,
  and after the announce the launch's own response is the better guide anyway. (That study
  is not kept as a script.)
- **Thin history.** 66 launches. Every figure here should be re-read as launches close.
- **Not in the refresh.** The two pulls are run by hand; a page will need them hourly.

## 7. What comes next

The page, as a mockup first (CLAUDE.md, "Mockup before live"). On a live draw launch:

1. **What went out**: each piece with what it should have brought and what it brought.
2. **Where the plan lands** against the target, with the clock underneath as a check.
3. **What a change is worth**: a piece added, moved, widened or dropped, as a range in
   units. This would replace the rough sizes on Suggested actions.

And with it: the two pulls in the hourly refresh, and Suggested actions reading the full
plan. Reading the artist-post log, it cannot see a planned email, so it may propose a send
that is already planned.

## 8. Log

- **16 November 2026.** The brief (section 1). The first study on 64 launches, then the
  feeds, the price list and the back-test as they stand here, on 66. The strength kept at
  0.5. The HubSpot token did not carry `crm.lists.read`.
