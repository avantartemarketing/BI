---
name: diagnose
title: Diagnose this release
when: Someone asks what is going wrong (or right) with a launch, why it is behind or ahead, what is driving it, or asks for a diagnosis. Not for a quick "how is it doing" or a single figure.
---

# Diagnosing a launch

The reader wants to know what is going on with this launch and where it is going wrong, worked out methodically and not from the first number that looks bad. The aim is one clear finding they can act on: the stage of the funnel where this launch first falls away, how much of the shortfall that stage carries, and what to check or change. A launch that is doing well gets the same treatment, pointing at what is carrying it.

You have the launch's diagnosis sheet (in this message, or as the result of `diagnose_release`). It lays the funnel out stage by stage, with this launch's figure so far beside what to hold it against, and it has already done the like-for-like arithmetic. Work from the sheet. Reach for the other tools only to dig into the stage you settle on.

## What to hold it against

Three yardsticks. Say which one each comparison uses.

1. **The artist's own earlier launches** at the same point of their campaigns (`sameArtist` on the sheet). When the sheet has them they are the best guide: the same audience and a similar kind of work. Name them the way a colleague would ("York, spring 2025"). Mind what differs between them and this launch: price, edition size, how long ago, how many works.
2. **Similar past launches**: the reference launches this one's targets were set from (`reference`), at the same point. Use them when the artist has no earlier launch on the sheet, and alongside when there are only one or two.
3. **The plan**: what the targets expect by now (`plan`). It says how far behind the launch is, but it is the least independent of the three, because a plan can be wrong. A launch that matches the artist's earlier launches and misses its plan may simply have an ambitious plan: say so.

"At the same point" means the same share of the campaign gone. The sheet has applied it (`comparison.point` says how), so never set a part-run launch against a finished one's totals. An earlier launch also shows `final` figures: use them to judge pace (what share of its final entries it had by this point) and size (its edition against this one's).

## Walk the stages in order

For each stage ask whether this launch is short, in line or ahead. The sheet's `read` is a first pass on fixed thresholds, not a verdict: use your judgment, above all on small numbers.

1. **Told.** What has gone out: emails delivered and how many sends, posts, the artist's own posts, ad spend. A launch nobody has been told about yet is not a weak launch.
2. **Responded.** Of the emails, how many were opened and clicked.
3. **Visited.** Visits to the launch, in total and channel by channel.
4. **Looked at a work.** Of visitors to the release page, how many went on to a product page.
5. **Entered** (a draw) or **signed up** (a timed launch). Of those who looked, how many entered; entries per visit; entries so far.
6. **Bought.** Entries turning into sales (winners paying, payments failing) and units per buyer; on a timed launch, signups turning into orders.
7. **Which work.** Whether one work or one line carries the shortfall.

Ads run through the same stages (spend, visits from ads, cost per entry), but read them as their own lane. Ad traffic converts far lower than email traffic, so a launch with heavy ad spend shows a poor overall rate with nothing wrong. Compare paid with paid and the rest with the rest.

## Find the weak point

The weak point is the earliest stage that is clearly short while the stages before it are fine. Every stage after a weak one looks short too, because less reached it: that is a consequence, not a second problem. So judge a later stage by its rate, not by its count.

Size it. The sheet's `gap` splits the shortfall in units between visits and conversion, channel by channel, against the plan and against similar past launches. Lead with the part that carries most of it. If two things each carry a real share, give both, the bigger first.

Then rule things out. Name the stages that are fine in one line, so the reader knows they were checked and can stop worrying about them.

## Dig one level into the weak stage

Go one step further into the stage you settle on, with three or four more lookups at most:

- Too few told: which sends are missing or small beside the usual run of a launch (`get_release`, `email.sequence`), and whether posts or ads have started.
- Poor response: which sends fell short.
- Too few visits: which channel, and whether it is reach (not enough sent) or response.
- Few go on to a work, or few enter once there: set paid against the rest, and price and edition against the earlier launches. Say plainly that the product page, the price, what is still available or the entry step is where to look. If entries are near zero while visits are normal, say the entry step should be tested, since that is what a broken form looks like.
- Entries fine, sales short: winners not paying, payments failing, or fewer units per buyer.
- One work: which, and how the others are doing.

For an earlier launch day by day, query `funnel_daily` (draws) or `tl_funnel_daily` (timed launches); both carry the day of the campaign.

## How sure to be

Say how firm the finding is. Early in a campaign, or on a few dozen visits, a rate swings on a handful of people: give the counts and call it an early sign. Where part of today is still to come, or a feed is behind, say so once. If nothing is clearly wrong, say that, and do not manufacture a culprit.

Do not guess at causes the data cannot show (the creative, the news, collector mood). You may say what the pattern is consistent with, and what would confirm it.

## The answer

This is the one kind of answer that runs longer than the usual few sentences: about 200 words and a table. The plain-English rules still hold: no field, table or tool names, everyday words, rounded numbers.

1. **The finding**, in one or two sentences: how the launch stands, and the stage that explains most of it.
2. **Stage by stage**: a small table, a row per stage that has data, in funnel order. Columns: the stage; this launch; the yardstick, named in the header (the artist's earlier launch by name, or "similar past launches"); and a reading of a word or two. Eight rows at most.
3. **Where it is going wrong**: two to four sentences on the weak stage, with the comparison that shows it and how much of the shortfall it carries.
4. **Ruled out**: one line.
5. **What to check or do next**: up to three concrete things, the most useful first.
6. A closing caveat only where it changes how far to trust the finding.

Put a short bold label on each part, as above. No preamble, and nothing on what you looked up. End by offering the one follow-up most worth having.
