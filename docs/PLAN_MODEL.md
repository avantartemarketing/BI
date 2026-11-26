# The plan model: reading a launch by what goes out

A second way to read a draw launch, built beside the campaign clock and replacing nothing.
The clock (docs/METHODOLOGY.md 5 and 6) says how far along a launch should be by today.
The plan model says what the launch's comms plan is worth: what each email and post should
bring, what has gone out, what is still to come, and what a change would add.

**Where it stands (16 November 2026).** It is on the dashboard behind a switch. A live draw
launch's page reads "Targets from: Time" by default, which is the clock's page unchanged;
"Plan" lays the plan-based view over it (section 6), so the two can be compared before
the plan becomes the default. The two feeds are pulled in the hourly refresh.

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

Two pulls, each part of the hourly refresh (`server/sheets.js`, after the artist-post log)
and each runnable by hand. A failed pull leaves the previous file in place, is reported in
the refresh's status and the log, and does not fail the refresh: the clock's page never
reads these files. Together they add about a minute and a half to a refresh. The refresh
reads only the plan rows going live from 120 days ago onwards (`NOTION_COMMS_DAYS`), which
is every row a live launch's page can need; run by hand the pull reads the whole plan,
which takes a few minutes and is what the back-test needs.

**The comms plan (Notion).** `node server/commsPlan.js --write` reads the team's Comms
database: one row per piece of comms (an email, a post, a story, an artist's post, a
partner's) with the day it goes live, its channel, the campaign phase and a status. Read on
16 November 2026 it held 12,850 rows, live dates from September 2023 onwards, written a
median of 27 days before they go live, so it is the plan and the record at once. The pull
writes `data/notion_comms.csv` (10,406 lines for 324 campaigns on 17 November 2026: the
rows with a live date on a campaign, Make-Ready's left out) and
`data/notion_comms_campaigns.csv` (the campaigns' codes, names and dates). `server/notion.js`, which the dashboard already runs, reads a different
database as it is set up in this repository: the artist-post log, which holds what artists
posted and none of the emails or Avant Arte's own posts (run on 16 November 2026 it read
663 rows, none of them an email).

Three things about that pull worth knowing:

- A Notion query stops at 10,000 rows without saying so. The plan is read in slices of the
  rows' created time and joined by row id; the status line says if a slice ever reaches the cap.
- A plan row reaches its campaign code through its Campaign relation and the Campaigns
  database. The rollup of the code on the plan row itself comes back empty from the API.
- A campaign need not have a code. The Campaign Code field was not filled in before
  mid-2024, and 259 of the 462 campaigns read have none. Until 17 November 2026 the pull
  kept only campaigns with a code, which silently left out every launch before May 2024
  (and the owner was told, wrongly, that the plan began then). A campaign with no code is
  now filed under a stand-in, `notion:` and its page id, and found by the artist it is
  named for and the days it ran (`plan_model.plan_campaign`, section 6). A campaign
  holding two codes (`LeeUfan_From_25,LeeUfan_LE_26`) is written under each. Make-Ready's
  campaigns, which are another business's, and rows on no campaign at all are left out
  (1,783 dated rows).

**Email audiences (HubSpot).** `node server/emailAudiences.js --write` reads the marketing
emails again and keeps what `server/hubspot.js` does not: the lists each email was
addressed to and the lists it left out, unsubscribes, and the emails built but not yet
sent. It writes `sources/email_audiences.csv` (3,433 emails from November 2023, 3,221 of
them sent). An email built in HubSpot names its lists before it goes, which is the only
place a planned audience is written down: the Notion plan's audience column is filled in
on about one email row in ten.

With the `crm.lists.read` scope on the HubSpot private app the same pull also writes
`sources/hubspot_lists.csv` (each list's name and size, and the kind of audience its name
says it is). The model does not read the names yet: it reads an audience by its size only
(section 7).

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
going out is 1. A day before the announce is next to nothing on its own: what comes then
comes with the early access pieces. The unit is the launch's own, so a big
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

What a piece of comms adds over its day and the days it is still felt. An email is felt
for four more days (x0.42 the day after, then x0.28, x0.13 and x0.13); a post for one
(x0.32):

| Piece | Quiet days |
| --- | --- |
| Early access email, per 100 expected clicks | 7.0 |
| Announce email, per 100 expected clicks | 2.4 |
| Last chance email, per 100 expected clicks | 2.0 |
| Sustain email, per 100 expected clicks | 1.5 |
| Avant Arte IG post | 3.0 |
| Avant Arte IG story or broadcast | 1.3 |
| Other AA social (X, Insiders IG, TikTok, Discord) | 0.9 |
| Artist IG post | 6.0 |
| Artist's other channels (their email, X, arte.bio) | 6.1 |
| Partner post | 6.0 |
| Artist IG story | 0.1 |

The close day adds 0.9 on its own and the day before it 1.1: most of the last days' rush
is the last chance comms, not the date. So an announce email to the full list (about 2,000
expected clicks) is worth about 50 quiet days, an early access email to 3,000 people about
25, and a last chance email to 15,000 about 9.

The weights are one set for every launch, none below zero, chosen to match each launch's
day-by-day share of its own demand (`fit_prices`). Read them as rough. Pieces that go out
on the same days share the credit between them and the fit cannot always tell them apart:
the artist's story reads as next to nothing because it goes out beside the artist's post,
and the partner post's price rests on few launches and on a channel check that shows
little (section 3).

**How long a piece is felt.** Until 16 November 2026 every piece was given its day and the
two after. Read that way, a quarter of a typical launch's demand outside paid was left as
baseline (what an ordinary day brings with nothing going out). The question was whether a
longer tail is real or only moves baseline onto the pieces by another name, so the price
list was refitted with longer tails, each launch judged from the others:

| A piece is felt for | Baseline's share of a launch | Day-to-day pattern explained | Typical miss on the final at 25, 50, 75% |
| --- | --- | --- | --- |
| Its day and 2 after, every piece (as it was) | 25% | 65.6% | 10%, 7%, 4% |
| Email 4 after, post 1 after (kept) | 19% | 66.7% | 11%, 7%, 5% |
| Email 6 after, post 1 after | 16% | 67.1% | 12%, 7%, 5% |
| Email on a smooth fade over about ten days, post 1 after | 13% | 67.4% | 12%, 7%, 6% |
| Its day and 9 after, every piece | 10% | 66.7% | 12%, 7%, 5% |

Two things hold whichever way it is cut. A post is over by the next day: given more days,
the fit sets them to nothing, for Avant Arte's posts and the artist's alike. An email is
not: its third and fourth days after each still carry about an eighth of its first. Beyond
that the fit gets no better and the forecast of what is still to come gets worse (at three
quarters of the way through, a typical miss of 31% with the short tail, 37 to 38% with four days
and 58% with the smooth fade), because a campaign is short enough that with a week-long
tail every day is "after" something and the baseline cannot be told from the tail. So the
rule kept is an email for four more days and a post for one. (The comparison was run once
and is not kept as a script; `plan_backtest.py` fits the rule kept.)

### 4.4 A plan's value, and the usual plan left

A launch's days are laid out with what goes out on each (`launch_days`) and priced
(`day_values`). The value of the days after a point over the value of the days up to it is
how much of the plan is still ahead (`remaining_ratio`). The **usual** figure at each point
is the median over the 66 launches as they ran: 0.43 a quarter of the way from announce to
close, 0.27 at halfway, 0.15 at three-quarters.

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
more. Its plan left is worth 0.20 of what it has run, where the usual is 0.27: three
quarters of a usual plan, because no artist post is left and the last chance email is going
narrow. `0.75 ^ 0.5 = 0.87`, so the forecast is `180 + 120 x 0.87 = 284`, against the
clock's 300.

This is the case the model exists for: a launch that is on the clock's pace so far, with
less left in its plan than a usual launch has. The anchored forecast is the back-test's
(section 5) and is on no page: the plan-based view (section 6) reads the plan alone, with
no clock in it, which the owner chose on 16 November 2026 so that one page has one source.

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
41%, the plan 66%.

**The final, from each point.** Typical miss either way on the final, then on what was
still to come:

| Read at | Clock | Plan alone | Anchored (0.5) |
| --- | --- | --- | --- |
| 2 days after announce | 11% and 29% | 16% and 47% | 11% and 31% |
| 25% through | 11% and 39% | 12% and 53% | 11% and 35% |
| 50% through | 9% and 41% | 6% and 37% | 7% and 38% |
| 75% through | 4% and 34% | 5% and 38% | 4% and 36% |
| 90% through | 4% and 40% | 4% and 44% | 4% and 35% |

**When the plan left is lighter or heavier than usual** (192 reads at 25, 50 and 75%):

| Plan left against the usual | Reads | What came, against the clock's figure |
| --- | --- | --- |
| Under 0.8 | 62 | x0.76 |
| 0.8 to 1.25 | 66 | x1.09 |
| Over 1.25 | 64 | x1.32 |

**How to read it.**

- The clock is already a good guess at the final total, because most launches run much the
  same pattern of comms, so time stands in for the plan. Up to a quarter of the way in it
  is the better of the two on the final (11% against 16%, then 11% against 12%); from
  halfway the plan alone is level with it or better (6% against 9%).
- The plan explains when demand arrives far better than the clock does, and it is the only
  one of the two that can say what a change is worth.
- When the plan left differs from the usual, the launch lands where the plan says: about a
  quarter under the clock's figure when it is lighter, about a third over when heavier.
- On average the anchored forecast is only a little better than the clock on what is still
  to come (36% against 39% from a quarter of the way in), and the tables above move a few
  points either way from one strength to the next. The strength kept, 0.5, is the one whose
  neighbours on the grid miss least, as the cost curve's slope is kept (`etl/paid_cost.py`).
- What is still to come is hard to call either way: a typical miss of 30 to 50%.

## 6. The plan-based view (the page)

`etl/plan_view.py`, laid under `variants.plan` on a launch's page by the build
(`with_direct_spread` in `etl/build.py`), and shown by the page's **Targets from** switch
(`web/src/ReleasePage.jsx`): **Time** is the clock's page, unchanged and the default;
**Plan** is this view. The choice is kept per browser. The switch is only on a page the
build has read both ways.

**Which launches.** A draw launch in its window with targets set, not a timed launch,
with a plan found in Notion (below), at least three emails and posts on file in it, and
at least one email sent or planned. Anything else keeps the clock's page alone and shows
no switch. The build's closing lines name the launches that have the view and, for a
live draw launch with targets that has none, why (`plan views: 4 - ...; without one:
<id> (no plan on file in Notion under <code>)`), and the refresh's log carries that line.

The plan is found (`plan_model.plan_campaign`) under the page's own code when the Notion
plan has rows under it in the launch's days; else under the campaign whose code begins
with the artist's name and whose launch day is within four days of the page's close
(`match_campaign_codes`; two campaigns with different codes answering is no answer); else
under the campaign named for the artist ("Artist | Title", "Artist - Title") with the most
plan rows in the launch's days, when no other campaign named for the artist has half as
many. The last finds a campaign with no code of its own and one whose code is not built on
the artist's name as the funnel spells it (`PietParra_Repeat_24` for Parra). The page's
own code can be a guess, and a guess can be the artist's last launch's: Ferrari Sheppard's
All Blues ran under `FerrariSh_LE_Repeat26` while its page carried `FerrariSh_LE_26`,
January's.

A code is read off an email's name with its year as two digits or in full
(`AntonyMic_LE_26`, `AiWeiwei_Lego_2026`); until 16 November 2026 only two digits were
read, so a launch coded with the full year had its emails on no launch. A code that ends
in no year at all (`FerrariSh_LE_Repeat26`) cannot be read by its shape, so a send is the
campaign's when its name or HubSpot's campaign spells the code out, in any case
(`plan_model.carries_code`). A send's name and its HubSpot campaign can disagree
(`040425_CUS_FerrariSh_Iris_25` under the campaign `FerrariSh_Iirs_25`), and the name is
the one typed for the send. A launch run before codes were written into names
(`220224_GEN_CONDOPRINT - Announcement`) has its sends found through its plan
(`launch_sends`): the one HubSpot campaign with a send on a day the plan has an email
whose key begins a word of the artist's name, with the sends that name the artist. A
HubSpot campaign with sends in six or more months is a standing one (NEWSLETTER,
INSIDERSEA) and is never a launch's.

**A launch selling lines of work** (docs/LINES_PLAN.md: Ai Weiwei's prints beside his toy
bricks) is read as one launch, on its combined page: one email and one post reach one
audience, so the plan cannot be split between the lines. A line's own page keeps the clock
and shows no switch. Paid is the one thing with comms of its own there, an ad set per
line, so on the combined page the paid suggestions are each line's own, read off its own
spend levels as on the clock's page, and the cards per ad set at the foot of the page are
the same in both views. Until 16 November 2026 these launches had no plan view at all.

**One source for every card.** The build makes the page a third time, in the view with
Direct spread over the other channels, reading for each channel group outside paid the
plan's path where it would read the clock's curve: what the plan as set expected by each
day and by today, and what is still to come. So the trajectory, the channel columns, the
funnel table, the gap card, the email card and the forecast all move to the plan together,
and paid, which keeps its own model, is sized against what the plan's comms leave to do.
In this view the page has one reference, the plan, so the Compare to switch is off.

**The plan as set.** Every plan row written by the day the launch's first piece went out
counts, each as planned (a post at how often its family goes out, section 3), plus the
emails. An email's plan is sized on the audience it went to. One still to come is sized, in
order (`planned_size`, from 25 November 2026): on the lists it names once it is built in
HubSpot, when the token may read list sizes (the `crm.lists.read` scope, which HubSpot
also calls `crm.segments.read`); for an announcement, on the "Email audience" number the
team types on the campaign in Notion; else on the usual audience for its kind, and only
then does its line say the audience is not set. Until then every email to come took the
usual audience, which read an announcement going to 70,000 people as one to 11,700. A piece dropped later keeps its plan and lands at
nothing, and its line says so.

**The level (from 25 November 2026).** A plan is sized on the launches that sold nearest
its target at a similar price (`similar_launches`): the eight nearest on what each sold,
or could have sold where it sold out, and on its price, among those closed in the last
18 months when there are twelve of them. The new launch is matched on its target, never
its edition, and a past launch on what it sold, never on what it was asked to sell: one
that aimed at 100 and sold 50 is no guide to selling 100, and one that aimed at 200 and
sold 100 is (the owner's rule). From them comes the range a quiet day of plan ran at,
the lowest and the highest left out. Inside that range the plan is sized to the target:
a quiet day is given the size the target asks of it (the target less paid's part, over
the plan's value), so the pieces' figures add up to the target and the card says the plan
as written is in line with it. A plan that would need more from each quiet day than the
strongest of them reads short, at the strongest's size, and one that needs less than the
weakest reads over. The target carries the judgement of how much the work is wanted; the
plan check asks only whether the comms are enough for a launch of that size, and the
artist's own earlier launches are printed beside it (sold of the edition, and how many
times over it was entered for) and move no figure. The older reading below stands where
the price list has no sales on it or the launch has no target or price.

Read on 90 launches, each from those closed before it announced: what a launch sold
outside paid is told to within 52% this way against 76% the older way, and the plan of
the middle launch reads at 101% of its target. A plan's size does not tell whether a
launch sells out: once the edition's size is allowed for it adds nothing, and among
editions of 150 or more the lighter half of plans sold 83% against 92%. So "in line" says
the comms are usual for a launch that sold this many, not that this one will.

**The level, the older reading.** The price list is in quiet days, so a plan needs to know how big a quiet
day is for this launch before it has results: the median of the artist's last three
launches when the artist has at least two on file, else the median of the launches the
page is benchmarked on (when three have a size on file), else of every launch. The sizes
are written by the back-test into `plan_prices.json` (`quiet`), so they are as old as its
last run. The level is the weakest part of the view: one artist's last three launches can
differ by a factor of two, and the range beside the headline before a launch starts
("likely 195 to 301") is that spread and nothing finer.

**How the launch is running.** Each channel's pull is what it has brought over what the
plan as set expected of it by today, read once the plan expected at least 5 units of it,
averaged half and half with the launch's pull across every channel and held between x0.3
and x2.0. From 25 November 2026 the pull is then raised to a strength below one while
little of the plan is in: 0.3 plus the share of the plan's value already landed, capped
at 1. At full strength from the first piece, one early access email to 2,733 people
marked a whole campaign down to the floor on its announce day. On the history the
strength that tells what is still to come best is about a half before the announce and
full from two thirds of the plan in; this rule misses by 43% before the announce against
49% at full strength, 41% against 48% over the announce day and the next, and no worse
at any later point. A weak early access is still a warning: of 74 launches with an early
access phase, the weakest third on it sold 72% of the edition at the median and the
others 97%. What is still to come is the plan's remaining pieces and baseline at that pull.
The headline ("185 at the close, 15 short of the 200 target") is the plan as it stands
with nothing changed: paid held at today's spend. What a change would add is the suggested
actions'.

**Target and edition.** The target is the page's unit target, which is the edition unless
a lower sell-through is aimed for (Ai Weiwei's toy bricks aim at a third of their 3,000).
The plan card and the trajectory's level line read the target; the ceiling on what the
page can count is the edition, so a plan strong enough lands past the target; and the
Sell-through at close card reads shares of the edition, as on the clock's page, with its
default reading (today's paid held to the close) set to the plan's own landing so the two
cards agree. The first build read all three off the target, which only showed on a launch
where target and edition differ.

**Credit by the day people entered.** What has come in is shared out between the pieces
and the baseline by the day a person entered or bought, each channel scaled to the page's
own count for it so the card adds up to every other card. The page's own daily series
cannot be used for this: it dates a unit by its order, and a draw books its orders in
batches days after the entries (Johnson Tsang's In Position booked 20 on 10 November, 20
on 13 November and 16 on 16 November, from entries mostly made on the 9th), so read on
those days the announce's units land on days with nothing going out and are called
baseline. On each channel and day, what came in is split between the pieces felt that day
and the baseline in proportion to what the plan put there. Emails sent on the same day are
told apart by the clicks each got. A day's posts from one sender are one line. This is an
estimate, not a measurement: nothing in the feeds ties a unit to a piece.

**The card.** A bar per phase (early access, announce, sustain, last chance), one for the
baseline and one for paid: the plan in grey, as long as the plan and ending at a tick, and
on it what is in so far and what is still to come, with the two figures beside it. The grey
left showing is what the phase is short of its plan by; a bar that passes the tick is over
it (26 November 2026: until then the grey ran the full width of every row, whatever the plan). A box beside the bars, the same height and scrolling
inside, lists the pieces: every email and post with the one furthest behind its plan first
(in date order before anything has gone out), or the phase picked, the baseline by
channel, or paid by what is spent and still to spend.

**Suggested actions in this view** are valued by the same price list, at the launch's
level and at how the piece's channel is running: an email still to come sent to the full
list or to a middle size (the full list is the widest send of the last 120 days), a
sustain email when none is planned, a post from the artist, Avant Arte or a partner three
days out, and the paid budget's step for tomorrow from the Spend levels card's own reading
(`plan_changes.paid_changes`: the campaign's, or one per line of work on a launch that runs
an ad set per line). An email's range is the middle half of how past sends landed
around their reading; a post's is x0.6 to x1.4. The clock's page keeps its own suggested
actions (`etl/plan_changes.py`), which read what comparable launches did. The two sizes
an email is offered at are one row on the card, the larger the list's load leaves standing
with the other inside it (`etl/list_load.py one_each`). On both pages an
email to half the list or more is held to the list's load (`etl/list_load.py`,
docs/METHODOLOGY.md 7d): a cap on general sends in a week and a scale on how busy the list
has been, read across every launch, so this view's emails each say how many people they go
to (`people`).

`python3 tests/test_plan_view.py` holds the view to a hand-built launch: the rows adding up
to the page's counts and each row's pieces to the row, the credit going to the day people
entered, a target under the edition, and a paid suggestion per line of work.
`python3 tests/test_lines.py` builds a two-line release through the real build and holds
the view to its combined page.

## 6b. A timed launch's signups, read by the plan

A timed launch gathering signups has the same switch (24 November 2026, `etl/tl_plan.py`).
The window's hours stay on the clock: nothing is laid over a page once its sales have
opened. The view has two halves, because the launches closed so far insist on it (section
8, "Timed launches"): two thirds of a timed launch's signups are bought, and what tells one
launch from another is its paid budget, not its comms.

**Outside paid** it is section 6's own reading (`plan_view.override`, given the launch's
kind) on a price list fitted to timed launches' signups, `etl/tl_plan_prices.json`
(`etl/analysis/tl_plan_backtest.py --write`; 46 launches since September 2023, signups
outside paid from the announce to the sales open). In quiet days: an announcement email
3.05 for each 100 expected clicks, an early access email 1.90, an Avant Arte post 3.13, an
artist's story 4.15 and post 1.05; a sustain or a last chance email, which the launches
hardly ran before their opens, has no price (`unpriced`) and no line on the card. With
nothing going out a launch takes 28% of its signups outside paid. A quiet day splits over
the page's channels 15% email, 14% Avant Arte social, 15% artist, 15% search and 41%
other. The clicks an email should bring are the draw launches' click model.

- **The days** run from the announce to the sales open, and what came in is the launch's
  own signups by day and channel from its feed, scaled to the page's count for each
  channel (the page shares the signups with no channel over the others).
- **The phases** are a timed launch's own: Announce (a piece up to a day after the
  announce, the teasers before it among them), Sustain, and The open (a day or less
  before the sales open).
- **An email still to come** is a plan row that is not a flow's own email, which goes to
  the people already signed up, nor a survey; its audience is the usual one for its kind.
- **The level** is section 6's rule on the timed launches' levels: the artist's last
  three timed launches when two or more are on file, else the page's basket, else every
  launch.

**Paid** is read from the spend and not the calendar (`paid_path`):

```
today's spend      = the mean of the last 3 full days with spend (none when the last full day had none)
days to come       = the days to the open's day, with the rest of today
cost of a signup   = the launch's own so far x how much dearer later signups have been at this point
                     of its span (paid_up, about x1.8), once it has 30 paid signups and EUR 200 spent;
                     until then the basket's cost a signup, with no mark-up
paid still to come = today's spend x days to come / cost of a signup
at the budget      = the pre-window budget left / cost of a signup, at budget left / days to come a day
```

The plan's line for paid stays the budget's, on the clock: its expected figure is paid's
share of the signup target. The clock's own projection reads paid as it reads every
channel, by the share of the span gone by, whatever is being spent
(`etl/tl.py _project`), which is the reading this view changes most. On Marina
Abramović's launch on the day it was built, six days into twenty-two: the clock projected
3,324 signups at the open and this view 1,455, against a target of 6,683, with EUR 627 a
day being spent of a budget whose own pace was EUR 2,722.

**The page.** `etl/tl.py` builds the launch a third time on that path (`le_blocks`,
`plan_ov`) and the blocks that differ ride under `variants.plan`, as a draw launch's do. It
is read as the feed attributes its channels, not with Direct spread: the sell-through
forecast reads that attribution whichever view the page is on (docs/TL_SPEC.md 3b), and on
this view it follows the plan's signups at the open. A channel's total on this view is its
plan's; the headline's target is the signup target.

**Suggested actions** are on this view of a timed launch alone (the clock's page has
none): the paid budget's own pace against today's spend, sized in the signups it adds by
the open (a cut in the spend it saves; within a tenth of today's spend, nothing; the row
says when spending that much faster may cost more a signup, so its size is the most it
brings); an announcement still to come sent to the full list; a second announcement, to
the list or to fewer, when no email is planned before the open's last days; and a post
from the artist or Avant Arte. An email to half the list or more is held to the list's
load as a draw launch's is (docs/METHODOLOGY.md 7d).

**Limits.** The cost of a signup at a spend several times today's is not modelled. The
window is not read by its plan: whether its paid spend tells its sales is not established
(section 8). An email's audience is the usual one for its kind until it has gone.

`python3 tests/test_tl_plan.py` holds the view's own parts to hand-built cases; a built
page needs the timed launches' feeds, which a checkout does not carry.

## 7. Limits

- **Groups of people.** The model reads an audience by its size. Which groups (artist
  sign-ups, past buyers, related artists, Insiders) needs the lists' names; the scope is
  granted and `listKind` in `server/emailAudiences.js` is ready to sort them, but nothing
  reads them yet.
- **An email still to come has no audience.** Until HubSpot's draft says who it goes to,
  the usual audience for its kind is assumed, and the view says so on the line.
- **Units per piece are shared out, not measured.** See section 6. A price is what a day
  with that piece usually brings, and a piece's "brought" is its share of its channel's
  units on the days it was felt; neither is proof of what the piece alone caused. Units
  that arrive after a piece is no longer felt are the baseline's.
- **Same-day pieces share credit.** See 4.3.
- **Launches the matching misses.** A launch has no plan here when no Notion campaign
  answers to its code or its artist in its days, and no emails when neither its code nor
  its plan finds them. Of the closed draw launches in the funnel with 25 units of demand
  outside paid, 91 are read and 17 are not: 7 with no plan found (three of them before
  the Notion plan begins), 6 whose plan has fewer than five rows that went out (its first
  months held emails only), 3 with no email found (HubSpot's record begins on 13 November
  2023), and one that shares its plan with a larger release.
- **Before the announce.** The level a plan starts from is rough (section 6). A quick try
  at predicting a launch's demand from its price, edition size, artist tier and the
  artist's last launch missed by 43% (typical, 64 launches predicted from earlier ones);
  edition size times the usual demand per edition missed by 31%. After the announce the
  launch's own response is the better guide, and the view leans on it.
- **Early in a launch the plan alone is the weaker forecast.** Up to a quarter of the way
  in, the clock calls the final better (section 5). The switch is there so the two can be
  read side by side.
- **The view is read with Direct spread.** The plan is priced on demand by channel group
  with Direct shared out, which is the dashboard's default view.
- **Thin history.** 66 launches in the committed fit, 91 on file. Every figure here should be re-read as launches close,
  and the price list is only as fresh as the last run of the back-test.

## 8. What comes next

- **The price list on the wider history, with the level rule.** The back-test now reads 91
  launches from November 2023 (it read 66 from May 2024, for want of the campaigns with no
  code). The committed `plan_prices.json` is still the 66-launch fit: re-fitted alone, more
  artists reach two launches on file and today's level rule (the artist's last three)
  takes over for them, which the level test below shows is the weakest reading (Ferrari
  Sheppard's plan would rise by 46%). The re-fit and the level rule go in together, on
  the owner's go-ahead.
- **The level a plan starts from** (tested 17 November 2026, each launch read only from
  the launches closed before it announced; typical miss on the plan's size). On the 91
  launches (74 scored): today's rule 57%, the eight launches nearest in edition size and
  price 46%, a blend 46%. Where the artist had two or more earlier launches (11): today's
  rule 78%, similar launches 22%, the blend 20%. First launches (47): 51%, one in three off
  by double or half. On the wider draw record, demand outside paid, 87 scored: 48%, 42%,
  42%; two or more earlier (12): 51%, 20%, 14%. An artist's follow-up launch ran at x0.56
  of the median of their earlier ones (25 follow-ups), so their own record flatters. The
  blend: half the similar launches, half the artist's last three marked down by that
  figure, when the artist has two or more; else similar launches alone. With one earlier
  launch the artist's record made it worse. Edition size carries most of it, price a
  little; the artist's tier, the early access audience and the plan's own size gave no
  reliable gain. A launch's own days settle it quickly: with similar launches, the typical
  miss is 31% on the morning of the announce (a fifth of the demand is in), 18% at the end
  of the announce day and 14% a day later.
- **Timed launches** (read 23 November 2026, `etl/analysis/tl_plan_backtest.py`, on the 46
  launches since September 2023 with a plan and emails on file, each read from the others;
  the figures are the run on that day's feeds). The owner asked for the same approach on
  timed launches. A timed launch has two stages, signups to its sales open and then units by
  the hour (docs/TL_SPEC.md 2), and the activity that tells its launches apart before the
  open is the paid budget, not the comms:
  - Paid brings 68% of a launch's tracked signups at the median, and a launch sends four
    marketing emails before its open, nearly all of them the announcement.
  - Signups outside paid: the price list explains their day-to-day pattern (62% against the
    clock's 37%) and forecasts their final count no better (two days after the announce the
    clock is within 15% of it; they nearly all arrive with the announcement).
  - Before a launch starts, its signups are told to within 174% from similar past launches,
    38% from its paid budget at their cost a signup with their signups outside paid, and 35%
    with its plan's comms in place of theirs (97%, 34% and 35% on the 27 with all three).
  - Paid signups part way through, on what is still to come: at halfway the clock misses by
    39% and the spend still to come by 29% (the launch's own cost a signup so far, marked up
    by how much dearer later signups have been, x1.8); at three quarters 40% and 21%. A
    quarter of the way in the clock reads better (42% against 55%). 31 launches with daily
    spend.
  - The window: 44% of its units go to people who never signed up. Whether the window's
    paid spend tells them is not established: added to similar launches' median it read 45%
    against 58% on the panel as committed on 13 November and 56% against 53% on the panel
    rebuilt on the 23rd. The window's emails add nothing either way (40 of 46 launches
    emailed 50,000 people or more, so the email tells them apart no further).
  So a timed launch's plan-based view is led by the budget: signups at the open as what has
  come in, the spend still to come at its cost, and the comms' pieces. Until it, every
  channel on a timed launch's page, paid among them, was projected on the clock
  (`etl/tl.py _project`). The window's forecast is left as it is. Built on 24 November
  2026: section 6b.
- The plan as the default, once the two have been compared on live launches.
- An email's planned audience read from its HubSpot draft, and audiences read by who is in
  them as well as how many.
- The level a plan starts from, from more than the artist's last three launches.
- The page before a launch's first piece goes out is built (the plan alone), but a launch
  only has a page once its targets are set; the upcoming pages do not carry the plan yet.

## 9. Log

- **25 November 2026.** The owner asked why Harland Miller's launch read 36 at the close
  against a target of 100 on its announce day, and worked through the model with it. Agreed
  and built, and live the same day once the owner had seen the before and after of the
  seven live draw launches and the one timed launch gathering signups: demand
  counted with pre-orders at 0.95 and plain entries at 0.8 (`plan_model.demand_units`; with
  it counted demand is 0.98 of the units sold outside paid at the median, so the two rates
  close the gap between them); a plan sized on the launches that sold nearest its target at
  a similar price and to the target inside their range, with no markdown of an artist's
  follow-up (section 6, "The level"); the pull eased in as the plan lands (section 6, "How
  the launch is running"); an email to come sized from HubSpot's lists, then Notion's
  "Email audience", then the usual audience; the plan check's words on the card. The price
  list is fitted again on 91 launches with what each sold kept on it. On that launch the
  card reads 47 at the close in place of 36, its rows add up to the 100 target and the plan
  as written reads in line. Tried and not borne out: sizing an email's units straight from
  its clicks, with no quiet day between. What each click brings varies from launch to
  launch as much as the quiet day does (x2.5 against x2.6 across the middle half) and is
  told worse from similar launches, and two fifths of the demand outside paid arrives by
  search and direct, which leave no clicks. A plan that reads short carries the gap as a
  row of its own, "Not covered", so the card's rows still add up to the target. The same
  reading was applied to a timed launch's signups that day, at the owner's asking
  (etl/tl_plan.py, which reads them through the same code): its plan is sized on the timed
  launches that drew nearest its signup target at a similar price, which tells the signups
  outside paid to within about 40% against 59% the older way on 40 launches, each read from
  those that opened before it; the pull is eased in as on a draw launch, 63% against 71%
  over the announce day and the next and no worse later; the card gives the same verdict
  and the same row. The two payment rates do not apply there: a signup is not an entry.
  The page's switch is as it was (the paragraph at the head of this file): Time is the
  default and Plan is this view. Still to build: the plan check as a step before early
  access (the gap, the ways to close it, an agreed plan and an accepted shortfall as one
  line), and the view on a launch's page before its first piece goes out.

- **16 November 2026.** The brief (section 1). The first study on 64 launches, then the
  feeds, the price list and the back-test, on 66. The strength kept at 0.5.
- **16 November 2026, later.** The owner chose one forecast built only from the plan, no
  clock in the view, then a page mockup (the plan card as bars with a box of the pieces
  beside them), then asked for it to be built behind a switch with the clock's page as the
  default. With it: an email felt for four more days and a post for one (4.3); what came
  in credited to the day people entered, after the mockup showed a draw's batched orders
  landing on the baseline; the two feeds in the hourly refresh; `etl/plan_view.py`.
- **16 November 2026, evening.** The owner asked why Ai Weiwei's launch had no switch. Two
  reasons, both fixed: a launch selling lines of work was left out of the first build (it
  is now read on its combined page), and its code carries the year in full
  (`AiWeiwei_Lego_2026`), which the reading of an email's name did not take, so its six
  sends were on no launch. With it: the code found through the Notion campaign when the
  page has none, the reason a launch has no view on the build's closing line, and the
  target told apart from the edition (the trajectory's level line, the ceiling, the
  shares on the Sell-through at close card), which that launch was the first to show.
  The same change gave Ferrari Sheppard's and Harland Miller's launches the view, through
  their Notion campaigns, and showed a third way a code is written: Ferrari Sheppard's
  ends in no year, so its four sends were missing from its plan card for one refresh
  until a send with no code was matched on the code written out.
- **17 November 2026.** The owner asked why only 66 launches were read, and then whether the
  Notion plan did not go back further than May 2024. It does, to September 2023: the pull
  had kept only campaigns with a code, and codes begin in mid-2024. The pull now keeps
  every campaign, a launch finds its plan by its artist and days where there is no code,
  and its emails through the plan where their names carry none; the back-test's launches
  take their codes as the build does. 91 launches are read in place of 66. Alongside: the
  level test (section 8), asked for as "test a blend" and a plan for artists with no past
  release.
- **20 November 2026.** The owner noted that the suggestions almost always say to email
  everyone when a launch is behind, with no thought for what else the list is getting or
  what the release is worth. The email history was read for a cost and shows none in the
  short run (a send does no worse in a busy week or a day after another, and launches in
  busy weeks were no smaller, 74 launches), so an earlier reading of 8% fewer clicks an
  extra email in the week before was withdrawn: it was the long decline in response
  showing up. The team's own frequency test (four groups, December 2025 to March 2026)
  read the same way: a quarter fewer emails, 6% more clicks on the same email two months
  in, fewer clicks overall. The cost is therefore held as a rule the team sets and not a
  price the model works out: `etl/list_load.py`, a cap on general sends in a week and a
  scale on the list's four-week load, read across every launch (docs/METHODOLOGY.md 7d).
- **23 November 2026.** The owner asked whether the approach could be applied to timed
  launches. Read on the launches closed so far before anything was built (section 8,
  "Timed launches"): the comms explain the pattern of a timed launch's signups and little
  of their number, and the paid budget is the activity that does before the open; in the
  window its part did not hold from one day's feeds to the next. `etl/analysis/tl_plan_backtest.py`
  holds the four readings, and with `--write` the price list a plan-based view would read.
- **24 November 2026.** The owner said go on a mockup of a timed launch's plan-based view
  (Marina Abramović's Energy Hat, six days into twenty-two), and it went live: section 6b.
  On the way the paid cost chart was found drawing its line on the ROI's scale, off the
  card and across the page, and was given its own. The same day the owner asked why a
  last chance email stood twice among a launch's suggested actions: it was one email at
  two audiences, and is now one row that opens to the other.
