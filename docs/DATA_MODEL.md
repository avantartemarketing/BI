# Avant Arte Launch BI - Data Model (v1, LE-first)

This document specifies how every number and target on the Launch Performance dashboard is
calculated. It is the result of reverse-engineering the current tooling:

- **LAUNCH PERFORMANCE OVERVIEW** (Google Sheet snapshot) - the per-release target model + actuals
- **LE Paid Calculator** - the in-flight paid-spend decision tool
- **`Across time.csv`** - the new daily funnel export with campaign-clock columns (the across-time
  target enabler)
- **Draw entry exports** (`draw_…entries_N.csv`) - per-entrant demand data
- **All Sent Emails** (the HubSpot feed, `server/hubspot.js`; the checked-in CSV is its last pull) and **All editions content** (Emplifi export) - channel
  activity data feeding the funnel diagnostics

LE (Limited Edition, sold by draw / pre-order) is specified fully; TL (Timed Launch, sold by
signup) follows the same architecture and is noted where it differs.

---

## 1. Canonical entities and keys

### 1.1 Release
The unit everything hangs off. **Key = `simple_release_name`**, a string of the form
`Artist · Work · YYYY Qn` (e.g. `Glenn Ligon · Multiple · 2026 Q3`). It is byte-identical across
all Metabase funnel feeds, the order feed, and the model tabs. **There is no numeric ID anywhere;
the string is the join key.**

Attributes (hand-entered per release today, in the LAUNCH INPUT block of each release tab):

| Field | Source cell | Example (Glenn Ligon) |
|---|---|---|
| `marketing_lead` | C77 | Maria |
| `private_room_open` | C79 | 2026-07-31 |
| `announce_date` | C81 | 2026-08-17 |
| `launch_end` (draw close) | C78 | 2026-09-17 |
| `launch_days` | `=C78-C79` | 48 |
| `campaign_name` (Meta ads key) | C85 | `GlennLigon_LE_26 · Enter draw` |
| `campaign_code` | prefix of C85 | `GlennLigon_LE_26` |
| `edition_size` (units) | G77 | 150 |
| `edition_total` (units, optional) | - | the whole edition when `edition_size` is a target that is only part of it (Warhol: 6,100 against a 2,440 target); the hero cap, room and sell-through read against it, the targets and K against `edition_size`; the snapshot carries both as `edition.{target,total}` |
| `unit_price` | G79 | 3,000 |
| `launch_value` | `=price × size` | 450,000 |
| `artist_profit` (total) | G81 | 176,879 |
| `aa_group_profit` (total) | G82 | 190,745 |
| `artist_profit_share` (who pays ads) | G85 | 0.5 (0 for estates on commission/rev-share) |
| `framing_available` | G87 | Yes |

Derived economics:
- `artist_profit_per_unit = artist_profit / edition_size` (1,218.60)
- `aa_profit_per_unit_ex_framing = aa_group_profit / edition_size` (1,465.29)
- `aa_profit_per_unit = aa_profit_per_unit_ex_framing + (framing_available ? frame_conversion × frame_profit : 0)`
  = 1,465.29 + 0.35 × 94 = **1,498.19** (the workbook's own worked example, with its €94)

`frame_conversion` (the share of buyers taking a frame) and `frame_profit_per_unit` (AA's
profit per frame, €) are **per-product inputs**: Airtable's Framing profit per unit, or typed on
the Target setting tab, shown when framing is available. The take-up left blank falls back to
the benchmark constant below; the profit per frame has **no default** (the workbook's €94 was
retired on 26 September 2026, since every framed product carries its own): a framed product
without one adds no uplift and the tab shows the cell empty (`frame_terms` in
`etl/build.py`, mirrored in `shared/economics.mjs`). Whether a frame is on offer is
Airtable's Framing ("No framing option" is none; "Framed on order" and "Full Edition Framed"
are one), typed over on the tab; where Airtable's Framing is blank, a **sculpture edition**
(Edition type SE, or a "3D edition" product type) has none and a print has one
(`pricing.is_sculpture`, carried to the tab as `framing_default`). Frame profit is Avant
Arte's alone, so a framed product lifts AA's profit per unit and its paid ROI, never the
artist's. The snapshot's `economics` block publishes the terms in force
(`frameConversion`, `frameProfitPerUnit`, `frameUpliftPerUnit`). The draw export's per-entry
"Framed" flag (`framed_share` in the draw block) is the observed take-up where the export exists;
it is not fed into the calculation automatically.

Global constants (from the workbook's "PROFIT CALC - DO NOT CHANGE" block):
`frame_conversion = 0.35`, `cannibalisation = 0.2` (the workbook's `frame_profit = €94/unit`
is no longer used: the profit per frame is per product)
(the LE standard per the spend rules. The 2026-08-28 tab revision left several
per-release cannibalisation cells reading 0 via the broken template reference
(issue 14, §11) - those cells are display artefacts, not the constant. The TL
historical panel still shows 0.10.)

Paid budget share (who funds the ads): the ads divide as the profit does. On a
profit split each side carries its share of the profit (an artist on 70% of the
profit carries 70% of the spend, Avant Arte 30%); on a revenue-share or
commission deal Avant Arte carries it all. Per product that is its `aa_profit_share`
or 1 for an `aa_revenue_share` (§1.6); on a release still carrying release-level
figures, the typed `aa_budget_share` (the workbook's "AA budget share (%)" row -
Glenn Ligon is overridden to 100% AA, "he's not sharing paid budget"), else
`1 − artist_profit_share`, 100% when that is 0 (`legacy_budget_share`, 2026-09-25:
it used to take a half for any share but 0). Where nothing records the deal the
split is an assumed half, `aaBudgetShareAssumed` on the snapshot, and the Paid ROI
card says "50/50 split assumed".

### 1.2 Campaign code (cross-system join key)
`campaign_code` (e.g. `GlennLigon_LE_26`) joins the release to:
- **Meta ads**: `campaign_name = '{code} · Enter draw'` in `meta_ads_insights` (campaign_id has
  lost float precision in the export - join on name only).
- **Email**: the feed's `Campaign` column equals the code exactly (join `Campaign == campaign_code`,
  i.e. prefix-match the sheet's `{code} · Enter draw`). Never parse email names - 19% don't
  contain the code.
- **Instagram/X content**: Emplifi `Labels` (semicolon-separated, order varies) contains the code;
  strip the generic tokens (`Edition`, `Reel`, `Make-Ready`, free-text artist tags) to find it.

### 1.3 Channel taxonomy
Raw feeds carry 15 channels (split-touch attribution):
`AA Email Auto, AA Email Man, AA Meta, AA Other, AA X, Direct, Organic Search, Other,
Paid Search, Paid Social, Referral Artist, Referral Meta, Referral Other, Referral X, untracked`.

Normalisation rules:
- **Case**: feeds spell `untracked` lowercase; the model uses `Untracked`. Normalise on ingest.
- **Untracked redistribution**: for any "adjusted" metric, redistribute the Untracked value
  pro-rata over the 14 tracked channels:
  `adjusted(c) = x(c) + untracked × x(c) / Σ tracked x`. This is applied to *actuals* before
  comparing to targets. Conversion-rate *benchmarks*, by convention, use **unadjusted**
  denominators (the sheet is consistent about this; keep it).
- **Untracked alert**: the redistribution is a proportion, and the more it has to move the
  less the channel picture can be trusted, so every snapshot carries `untracked`: the
  release's untracked share of eligible entries and of units over its window (sessions always
  carry a channel), the norm it is read against - the median and 90th percentile over the
  draw panel's launches closed in the last 18 months, each over its own window; the whole
  panel when fewer than eight are that recent - and `high`, the metrics whose share is over
  twice the median and past the 90th percentile on at least five rows. The Target setting tab
  shows a warning when `high` is not empty. Tracking has tightened: older launches ran ten to
  fifty per cent untracked, recent ones about three, which is why the norm is recent.
- **Paid units with no purchase event**: units sold are the orders table's, each order on the
  channel of its purchase event (§6.3), so an order the event feed never saw is counted on
  `Untracked` and shared out like the rest. `untracked.noEvent` = `{count, total, share,
  high}` counts those units in the window; `high` when they are over 5% of it and at least
  five units (`NO_EVENT_WARN_SHARE`, `NO_EVENT_WARN_MIN` in `etl/build.py`), and the page
  shows a banner above the tabs: the channel split is then short of evidence, and the
  purchase tag is the thing to check. The reconciliation found one such order in 14,894
  since January 2025.
- **Direct as a source (the dashboard's Direct switch)**: Direct traffic is mostly people who
  saw something elsewhere and typed the address, so the Overview can read it the way Untracked
  is read: `redistribute_channel(win, "Direct")` spreads Direct's sessions, entries and units
  over the other channels in proportion to what they did that day (the rule above with Direct
  in Untracked's place), and the benchmark's channel split is read the same way, with the
  panel's median Direct share of the Search/direct/other group (`direct_share_norm`, the
  cohort of the untracked norm) leaving the group and landing on every group pro rata
  (`spread_profile`; the headline medians and K do not move). The share is the panel's own
  (`direct_in_group_<metric>`, written by `release_clusters.py` from the same pull as the split
  it is applied to); a panel written before those columns falls back to the share on today's
  feed over the same windows, which mixes two attributions once the feed re-attributes (on 24
  September 2026 it fell from 0.73 to 0.33 of the group's units in one refresh). The ETL builds
  every page both ways (`with_direct_spread`) and stores the blocks that differ under
  `variants.direct_spread`; `directShare` carries Direct's share of the release's window as the
  funnel attributes it. The switch in the Overview's head lays the variant over the page, so
  every card reads one attribution; it is a methodology choice and sticks per browser. The
  Target setting tab always reads Direct as a channel: the switch is not shown there, and the
  tab says so when the Overview is set to Spread. Totals, what has been sold, the spend and the
  paid budget do not move: paid takes its share of Direct's units, so its cost per unit is
  rescaled by the paid group's change (`cost_scale`) and paid units × cost is the Channel
  view's. The plan's pace and the projections shift a little with the channel mix (each group
  has its own curve), and paid reads the entries it is given.
- **Paid Search** has no benchmarks, no spend feed, and never appears in the daily export -
  every "Total Paid" benchmark is an alias of Paid Social. Model paid = Paid Social; keep Paid
  Search only as a raw actuals bucket.

**Display grouping** (dashboard modules use 4–5 groups):

| Display group | Raw channels |
|---|---|
| AA Email | AA Email Auto + AA Email Man |
| AA Meta (organic social) | AA Meta (+ AA X where the sheet groups "AA Socials") |
| Referral artist | Referral Artist |
| Search / direct / other | Direct + Organic Search + Other + AA Other + Referral Meta + Referral Other + Referral X |
| Paid | Paid Social (+ Paid Search actuals) |

⚠ The sheet's own chart grouping drops **AA Other** entirely (targets short by its share);
include it in Search/direct/other in the rebuild and note the delta vs the sheet.

### 1.4 Product (per-release, for multi-work releases)
From draw entry exports and the sell-through module: `{ product_name, edition, sold, … }`.
Product names contain commas (`Composition with Red, Yellow`) - **never comma-split a product
list without matching against the release's known product set**.

### 1.5 The campaign clock (the new across-time structure)
The daily funnel export now carries 5 computed columns (upstream in BigQuery), the last 5 of
`Across time.csv` / cols AD–AH of the daily import:

| Column | Definition |
|---|---|
| `days_since_announcement` (dsa) | whole days event − announcement timestamp (truncated toward 0; negative = pre-announce) |
| `days_until_launch` (dul) | whole days launch timestamp − event |
| `pct_days_since_announcement` (pdsa) | dsa / L, where **L = campaign length in days (announce → launch)** |
| `pct_days_until_launch` (pdul) | dul / L |
| `campaign_stage` | label derived from the above |

**`pdsa` is the normalised campaign clock: 0 = announcement, 1 = launch/draw close, < 0 = early
access (private room), > 1 = last chance & after.** It lets campaigns of different lengths
(observed 7–107 days, mode 28) be pooled on one axis - this is what makes targets-across-time
possible (§5).

Stage boundary rules (verified empirically):
1. No announcement date on record → `Missing campaign dates` (58% of the export = back catalog).
2. Event before announcement → `Early access` (dsa ≤ 0).
3. Announce → launch split into thirds by pdsa → `Sustain 1 / 2 / 3` (boundaries ≈ ⅓, ⅔ with
   integer-day rounding).
4. First ~24h after the launch timestamp (dul = 0 post-launch) → `Last chance`.
5. Later → `Outside campaign window` (dul ≤ −1).

**The clock is filled in where upstream carries none** (`etl/aggregate_events.py`, §2.3; the
upstream feed has dates for 2026 launches only). Upstream dates always take priority, field by
field, with one exception: an upstream announce on or after the release's own close, or once
it has passed more than a week after the release's last entry day, is a placeholder and is
treated as absent (`placeholder_announce`, the test the upcoming list puts Airtable's announce
to, §1.7; the entries never judge an announce still to come, since a launch in early access has
entries before it, nor one days after them, since a draw can open after its announce).
Airtable's Announce Date reads 2025-04-17
on 41 launches of 2023-24 (§11, #24), which gave 29 releases a clock of 2025-04-17..their 2024
close, rejected by the build, so 17 closed draws (Pejac 2024 Q3, George Condo 2024 Q1) were
catalogue pages. Their announce is now inferred, and the upstream close they came with is kept
where it is within a week of the draw's last entry day (else the close is inferred too; the
window's source reads `mixed` or `inferred`); `release_people.csv` starts such a release's
campaign at its first event, not at the placeholder, which made every buyer of it read as
returning. Otherwise, for a release with at least 10 entrants: the announcement is the first big
traffic spike (a day with at least a quarter of the release's busiest day, at least 30 sessions,
and at least three times the previous week's median) when it comes 6 to 30 days before the draw
opens - an announcement with the draw opening later, and the traffic in between is real campaign
traffic - else the day the draw opens (the first of two consecutive days with entrants, or a day
with three); within a week of each other the two are the same announcement and the draw opening
pins the day. The close is the day the draw units are allocated, else the last entry day of a
campaign over for at least a week; a window outside 3..90 days is not used. Checked against the
upstream-dated releases on every run (the `clock rules` line in the log): announce exact on 24 of
27 and within two days on all 27, close exact on 24 (the three misses are draws whose entries ran
past the recorded close). The spike alone would land on the early-access send a day or two early
on most campaigns; for a private-room-led launch it is the private room opening, which the
upstream convention labels early access. Inferred rows use rules 2-5 above cleanly, with days
more than 45 before the announce as `Outside campaign window`; `clock_source` on the rebuilt file
and `data/app/release_windows.csv` say where every release's dates came from.

---

### 1.6 Release inputs: what comes from where

The Target setting tab asks for three decisions - the Meta campaigns, the channels in plan,
the basket - and reads everything else off the feeds, per product. `resolve_release` in
`etl/build.py` (mirrored by `shared/economics.mjs` for the tab) resolves every configured
release before the build, and `inputs.json` carries what the feeds hold for every release
under `sourced`, beside the inputs as saved under `releases`.

**Products and economics.** Airtable's Pipeline table has one record per work;
`etl/pricing.py release_products` picks the launch for a release by the same match the panel's
pricing uses (§4a.2½) and hands back its sized, non-bundle records as products: edition, target
sell-through (the `Target sell-through %` field when the table has it, else the units target
over the edition, else the expected sell-through, else 100%), unit price and currency, the
artist's and Avant Arte's profit per unit, the deal's revenue share or profit share, the framing
option and the framing take-up and profit. The figures typed on the tab lay over them per
product (`products[]` entries with `airtable_id`, or `manual: true` for a work Airtable has no
record for); blank means Airtable's. A work Airtable lists under the launch that is not
part of the release is unticked on the grid (`excluded: true` on its entry): it stays on the
grid, greyed, with any figures typed on it kept for when it is ticked again, and counts nothing
below - not in the edition, the targets, the launch value, the works' closes, the sell-through
card or the Slack rows (`excludedProducts` on the snapshot lists them). Its Airtable record
stays with the release, so the upcoming list does not read it as a launch of its own. The
release's figures follow:

```
target units        = Σ round(edition × target sell-through)          # edition_size
edition             = Σ edition                                        # edition_total
launch value        = Σ target units × unit price in euros          # EUR converted at RATES_TO_EUR
profit per unit     = Σ target units × profit per unit / Σ target units, for the products that have one
framing uplift      = Σ over framed products of target units × take-up × profit per frame / Σ target units
AA budget share     = per product: its AA profit share on a profit-share deal, 1 on a revenue-share deal;
                      weighted by target units; 0.5 where no deal is recorded, flagged as assumed
                      (aaBudgetShareAssumed: the Paid ROI card and the Target setting tab say so)
```

A release set up before this carries `legacy_economics` (the release-level `edition_size`,
`edition_total`, `unit_price`, `artist_profit`, `aa_group_profit`, `artist_profit_share`,
framing terms); those stand in for the totals until cleared on the tab, and inputs saved with
them at the top level are read the same way. The snapshot's `economics` block publishes the
products in force, `mode` (`products` or `release`) and `deal`.

**Dates.** The Notion log first: `server/notion.js` reads each matched row's words for the
stage it records (early access, exclusive access, private room → `private_room_open`; announce;
launch, draw close, last chance → `launch_end`) and writes `data/notion_campaigns.csv`. The
private room opens on the day the early-access email is scheduled for: among a release's
early-access rows the one whose channel is an email (`isEmailRow`) sets the date, and a story
or post on that stage stands in only when no email row is on file. A row belongs to a release
by its campaign code, else by its full name, else by the artist's name with the row's Live
Date placing it in the launch whose window holds it (`matchRelease`; an artist has many
launches), so an upcoming launch that has no code yet gets its dates too: the file carries
`campaign_code` and `release_name`, and the ETL looks a release up by either
(`notion_dates_for`). A campaigns database named by `NOTION_CAMPAIGNS_DB` supplies date
columns by name over that. Then what was typed,
then the funnel export's campaign clock (measured, exact for the announce), then Airtable's
planned dates. The private room defaults to two weeks before the announce when nothing has it.
`inputSources` on the snapshot names the source of each.

**A date that moved.** A typed date stands, but never silently: on every build
`resolve_release` compares each date in force with what Airtable and the funnel's clock hold,
and where another source puts it elsewhere the snapshot says so (`dateDrift`: the date in
force, its source, and the other readings), the sidebar's row carries the flag, and the
Target setting tab prints the other reading beside the date with a one-click `use it`. A
launch whose date slipped a fortnight in Airtable is otherwise a page that runs to the wrong
day. **Works that close on different days.** One launch's works can close on different days
(Warhol's Lifesize on 30 September 2026, its colourways on 14 October): the release's close is
the last of them, the day the campaign ends, and each work's own close rides on its product
(`launch_date`), on the snapshot and the sidebar's row (`closes`, one entry per date with the
works on it), on the tab's products grid (a `Closes` column) and beside the `Draw closes`
date; the sell-through card counts each work at its own draw. Read as two launches, the page
took the nearer close alone and a second, "upcoming" page listed the rest (§1.7,
§4a.2½).

**The marketing lead** comes from the Notion log first, where the team records it: the
campaigns database's lead column (a people, select or text property named `Marketing lead`,
`Campaign lead`, `Lead` or `Owner`, `leadProp`), else the name most of the release's matched
post rows carry (`campaignLeads`), written to `notion_campaigns.csv` as `marketing_lead`
beside the dates (a people property is read for its display names only, never an email).
Then Airtable's `Marketing lead` field (a colleague's display name; the pull never takes an
email), else what was typed. `inputSources.marketing_lead` names the source (`notion`,
`airtable`, `typed`), the Target setting tab shows it beside the field, and the page header's
chip carries it in its tooltip; a TL page resolves its lead the same way (`etl/tl.py`
`resolve_lead`). Changed on 7 October 2026: the lead was Airtable's or typed before, and the
log is where it is actually kept. **The campaign code** is what was
saved, else the prefix of the first Meta campaign's name, else the guess from the email and
content feeds. **The Meta campaigns** (`campaign_names`) are the list saved, else the draw
campaign the spend feed names for the code; paid spend is summed over the list. The tab
offers every campaign in the feed (`meta_campaigns`) with its spend and the last day it
spent, most recently active first: a day with spend above zero, since the export keeps a
campaign's rows at zero for about four weeks after it stops ("no spend yet" when it never
spent). A code's active days, which the upcoming launches' code guess reads (§1.7), are
counted the same way.

### 1.7 Upcoming launches (from Airtable)

The funnel report only carries a release once it has traffic under a release name, and a
campaign can be spending on Meta for days before that. Airtable's Pipeline table knows the
launch earlier: its works, its edition and price, its private-room, announce and launch
dates. So the build lists **upcoming launches** from Airtable (`etl/build.py
upcoming_releases`) beside the releases the funnel mentions:

- a draw (`launch_type` Draw, or blank - a project Airtable has not typed yet) closing after
  the build date and within 120 days (60 for a blank type), not at the pitching stage (the
  status most of its records hold, a tie going to the less advanced stage). A blank type
  counts as a draw only when most of the launch's records are not originals (`OG`), NFTs or
  timed editions (`TL`, `TLC`): an originals show or a 48-hour timed print is no draw;
- listed once for a launch whose works close on different days (one launch, §4a.2½, closing
  on the last of them, its `dates_note` naming each close and the page's `closes` carrying
  them for the sidebar), and once for one artist's codes closing within three days of each
  other (`MERGE_DAYS`, the matcher's rule for one launch under several codes): Ai Weiwei's
  Lego prints and Lego Middle Fingers, two codes closing on 30 November 2026, are one launch
  with every code's records, the editions added and the price the value-weighted mean, where
  they listed as "Ai Weiwei · Multiple" beside "Ai Weiwei · Lego Middle Finger 1 - Red / ...
  and 1 more". A launch mostly of originals, NFTs or timed editions stays apart from a draw
  closing the same day, as under one code;
- whose Airtable records no release on file already matched - the same matcher the panel's
  pricing uses (`etl/pricing.py match`), run over every discovered and configured release,
  so the artist's earlier launch does not stand for the new one and a launch the funnel
  already carries under its own title is not listed twice - and whose ids no saved input
  carries (a release set up from an upcoming page keeps them, `airtable_ids`);
- named the way the funnel will name it, `Artist · Title · YYYY Qn` with the title `Multiple`
  when the launch has several works, and the artist spelt as the funnel spells them where a
  release on file already matched that Airtable artist (Airtable's "Kukwon Woo" is the
  funnel's "Woo Kuk Won"), so the page keeps its id when the funnel catches up. A second
  launch of the artist in the same quarter takes its works as its title ("Pejac · Barbed
  Wire / Mind Trip · 2026 Q4"), then its close date, so no two pages share a name or an id.
  A title of many works names the ones that fit in 100 characters and counts the rest
  ("Brillo Box Collectable (Green Landscape) / Brillo Box Collectable (Green Portrait) and 9
  more"), and an id is at most 120 characters (`slugify`): the id names the page's file, and
  one launch of twelve works made an id no file name holds, which stopped every refresh at
  the build with "File name too long" (28 September 2026).

Its page (`build_upcoming`, status `upcoming`, `upcoming: true`) has the dates, the edition,
the price in euros at the panel's fixed rates, the works and the project's Airtable status,
and no actuals; the sidebar lists it under Upcoming with the days until it opens, or until it
closes once Airtable's announce date has passed and the funnel still has no rows for it. The
announce date is Airtable's (the earliest over the launch's sized, non-bundle records, as the
Set up targets tab reads them), else assumed 24 days before the close and said so; one that
has passed while no code for the artist moves on Meta or in the sends in the launch's window
is said to be possibly out of date (`dates_note`). The campaign
code is guessed from the feeds' codes and Meta's campaign names, never from a code a release
on file already carries. `inputs.json` `discovered` carries the edition, the price and the
Airtable record ids as the defaults the Set up targets tab starts from, and a save keeps the
ids on the inputs (`airtable_release`, `airtable_ids`).

**When the funnel catches up, or renames.** A configured release the funnel does not mention
is checked on every build for the funnel release that is the same launch
(`adopt_funnel_names`), and takes its name - written back to the saved inputs with
`adopted_from` - so the actuals attach to the targets that were set, under the page's
existing id, rather than opening a second, untargeted page beside them. Two readings, the
first that answers decides:

- by name: a funnel release with the same artist (an estate's words folded, as the matcher
  folds them) and title in another quarter, with at least half of its draw entries and units
  in the window that was set (`ADOPT_ACTIVITY_SHARE`; from the private room where the inputs
  open one, else the announce, to the close in force run on 30 days, for a close that moved),
  is the release renamed upstream with every row it has.
  A launch whose close moves into the next quarter is renamed that way: Warhol's 2026 Q3
  became 2026 Q4 when its colourways moved to 14 October, and its page stood empty while its
  actuals opened a second page. This reading needs no Airtable, which matters because the
  matcher can fail the renamed release: its campaign clock can be unreadable, and its
  launch's quarter is its first close's (§4a.2½), so the quarter in the new name does not
  agree. The entries test is what keeps the artist's other launches in the same words from
  being taken for it: every past "Ai Weiwei · Multiple" release draws catalogue traffic to
  this day, so its rows overlap any window, but its entries sit in its own campaign. A page
  whose own name is still in the funnel is read the same way when that name holds under a
  tenth of the twin's entries and units in the window (`ADOPT_MOVED_SHARE`): the rows moved
  and stray ones stayed behind, which get no actuals-only page of their own;
- by its launch: the ids its inputs carry when it was set up from an upcoming page, else the
  launch the matcher places it on (a page set up by hand); the funnel release matched to the
  same Airtable records has the name the input takes. That covers a launch set up under a
  guessed name before the funnel named it after one work, and an artist the funnel spells
  another way. Where several funnel releases sit on the launch (the Lifesize read as a release
  of its own beside the colourways), the one named like the input is taken, and with none
  named like it the input is left alone.

A page the funnel has no rows for that neither reading names carries `funnelNote`: what
was considered and why it was not given another name (the same words elsewhere with the
share of their entries in this window, the launch the matcher placed it on). The header's
freshness line shows it in amber, "no funnel rows under this name", with the words in its
popup, and the build's log prints them; a failure inside the adoption is a warning line, never
a lost refresh.

A rename reaches the files through the pull, and the incremental pull keeps the rows older
than its 45-day overlap as they were (README, Incremental): a renamed release's old name would
stay on those rows, the funnel would seem to carry both names, and the release would be
listed twice under each until the weekly full pull (Roy
Lichtenstein Estate, 30 September 2026: one July row under the corrected-away 2027 Q4 beside
the September rows under 2026 Q4). The pull now notices a name that has gone upstream, on
every incremental pull from the overlap's own rows and once a day against upstream, and
pulls in full instead.

The Airtable pull (`etl/pull_airtable.py`) runs on every refresh when `AIRTABLE_TOKEN` is
set; without it the checked-in file stands.

## 2. Source feeds

All funnel data originates in BigQuery `avantarte-data-production.AA_company_tables`:

| Feed | Grain | Key columns | Used for |
|---|---|---|---|
| `le_funnel_report_split_touch_export` | channel × event_date × release | 29 metrics + 5 campaign-clock cols | daily actuals, across-time curves |
| LE funnel lifetime rollup (importrange "Export!A:AB") | channel × release | sessions (D), Total Product Units (S), eligible entries (M/N/Y), units by route (O/P/Q/R), page views (AA), entries (V/W/X/Z/AB) | launch-total actuals, benchmarks |
| `tl_funnel_report_split_touch_export` (+ lifetime) | same, TL metrics (subs) | sessions, subs, customers, units by sub | TL side |
| `Order_Line_Concept` (BigQuery) | Shopify order line | quantity, list and paid price, financial status, draft origin, private room, product, release | units paid and awaiting payment per product, list price, the product each draw sold (§2.4) |
| `meta_ads_insights_export` | campaign × spend_date | impressions, reach, link_clicks, **spend** | paid spend actuals |
| Meta lifetime ("Meta Data for Paid") | campaign | + 7d-click conversions (Purchases, Enter Draw…) | Meta-side attribution |
| HubSpot email feed (`server/hubspot.js`) | email send | Delivered, Opened, Clicked, Unsubscribed | email funnel rungs |
| Emplifi content export | post/story | impressions, reach, engagements, saves, story metrics | social funnel rungs |
| Draw entries export | entrant × draw | tier, score, products, MaxQuantity, winner/claim flags | (legacy) demand by product; the per-product sell-through now reads the event feed's draws (§6.3) |

**The dashboard reads the BigQuery tables directly when a key is configured**
(`server/bigquery.js`, `BIGQUERY_SERVICE_ACCOUNT_JSON`): `le_funnel_report_split_touch_export`
and `meta_ads_insights_export` are pulled from `BQ_SINCE` (default 2025-01-01) into the same two
CSVs the sheet path writes, so `build.py` is unchanged and the feeds are interchangeable. The
sheet path remains as the fallback, and is the reason to prefer BigQuery: its accumulator tabs
silently truncate (the LE daily tab is capped at exactly 100k rows and has lost everything before
2025-12-20; `Across time.csv` is a 50k-row export cut mid-date at 2026-05-04). Truncation does not
error - the window shortens as new launches push older days off the end - so the feed refuses a
pull that would replace a materially longer history with a shorter one (`BQ_ALLOW_SHRINK=1`
overrides). A BigQuery failure falls back to the sheet but leaves the header reading **Sources
stale**, so a truncated copy is never served as if it were whole. The funnel table is required;
spend is optional, since a service account is easily granted one dataset and not the other -
losing paid spend does not also cost us the funnel.

### 2.1 Event-level feed (`LE_Funnel_Report`) and the personal-data rule

`AA_company_tables.LE_Funnel_Report` is the event-level source behind the daily export: one
row per event (page view, session start, signup, draw entry intent, purchase) since April 2019,
8.1M rows, 368 releases, with the campaign clock, split-touch attribution, draw-entry outcome
(eligibility, exclusion and removal reasons, winner, pre-order, max-quantity preferences), order
detail (type, pieces, cancellation, private-room flag) and page locales. It also carries
**`user_email`** on signed-in rows: 1.9M rows, 109k distinct addresses, 95k of them staff, with
no column-level policy tag - the dashboard's service account can read it (checked 2026-09-10).

**The rule: the address never leaves BigQuery.** The dashboard does not need it - `aa_account_id`
identifies the person on 99.9% of the rows that carry an address (2,428 rows have an address and
no other identifier, all anonymous form fills). `server/bigquery.js` enforces the rule rather than
relying on care:

- the events query names every column it takes (`EVENT_COLUMNS`); `SELECT *` is refused, and so
  is any query text that mentions the email column, so the data team's email-free view is a
  drop-in via `BQ_EVENTS_TABLE`;
- the header BigQuery returns must equal the declared list exactly;
- every cell of every page is scanned for an address-shaped value before it is written; one hit
  aborts the pull, discards the partial file, keeps the previous one and names the column, never
  the value. `processing_error` (free text, up to 7.7k characters) was found to quote addresses
  inside 2,074 error messages and is reduced to `has_processing_error` in SQL.

What is pulled (`sources/le_events.csv`, `node server/bigquery.js --write --events`): the
**conversion events only** - signup, draw entry intent, purchase, ~200k rows all time
(`BQ_EVENTS_SINCE`, default 2019-01-01, because a returning collector's history is the point).
Page views and session starts are the daily export's job; at person level they would be 8M rows
of browsing history for no number the dashboard shows. Identifiers kept: `aa_account_id` (the
person key), `draw_id`, `draw_entry_id`, `campaign_id`. Dropped on purpose: `user_email`,
`user_pseudo_id`, `ga_session_id`, `customer_id`, Shopify order id and name, `subscription_id`,
page URLs and titles, the utm strings (`utm_source` carries an address on 3 rows). Timestamps
are written as ISO.

The account id is still personal data (pseudonymised, GDPR art. 4(5)): the file stays under
`sources/` (gitignored), is served by no endpoint, is rebuilt from BigQuery on every pull so an
erasure upstream propagates within a refresh, and anything that leaves the server - `data/`,
the API, this repository - is aggregated with no identifier column. `BQ_EVENTS=off` skips the
feed; a failure of its guards is reported in the refresh status and never worked around.

Asks of the data team, in order of value: (0) a product on the purchase event (or a product
dimension joining orders to draws), so private-room and pre-order sales can be attributed to a
product on the sell-through card - today only a sale through a draw win names its product
(§6.3); (1) an authorized view over the table without
`user_email` (with `is_staff` derived inside it - 262 of 33,881 draw intents and 63 of 26,525
purchases are staff), the dashboard's service account granted the view and revoked from the
base table, or a policy tag on the column with no fine-grained-reader grant; (2) rotate the
service-account key once access is narrowed, and keep the account to the dashboard alone;
(3) BigQuery data-access audit logs on the dataset; (4) partition the table by `event_date` and
cluster by `simple_release_name` - it is unpartitioned, so every query scans whole columns
(0.7-1.1 GB per aggregate).

Things the feed makes measurable that the daily export cannot: unique entrants and customers per
release (the export's per-channel counts double-count a person across channels and days), new
versus returning collectors per release and per basket (`docs/RELEASE_CLUSTERS.md`), the artist
audience overlap between releases, draw eligibility and removal reasons, pre-order share by
person, cancellations, and hour-level pacing on the campaign clock. Locales are site locales
(three values), not countries - the "Entries by country" open item (§12) is still open.

### 2.2 The daily export's columns, decoded against the events

The daily export (`le_funnel_report_split_touch_export`) is an aggregation of `LE_Funnel_Report`.
Every metric column was reproduced from the events and compared per channel × day × release over
2023-09-01 to 2026-09-10 (323k channel-days). Grain and conventions: channel is
`AA_session_custom_channel_group_split_touch`; *people* means distinct `aa_account_id`; *units*
means `draw_entry_multiset_preference_max_quantity_once` summed, i.e. each entrant's maximum
quantity counted once however many products they entered; an entrant who won one product and
lost another appears on both sides of the winner split.

| Export column | Definition (per channel × day × release) | Match |
|---|---|---|
| `Sessions_Total` | count of `session_start` events | exact |
| `Page_Views_Total` | count of `page_view` events | exact |
| `Draw_Entries` | people with a draw entry intent | −0.4% |
| `Collectors_Eligible_Entries` | people with an eligible intent (`draw_entry_eligible`) | −0.3% |
| `Draw_Entry_Eligible` | people with an eligible intent that did **not** win - post-allocation, see below | −0.4% |
| `Draw_Entries_Eligible_Units` | units wanted by eligible entrants (winners included) | exact |
| `Draw_Entries_Total_Units` | units wanted by all entrants | exact |
| `Draw_Entry_Eligible_No_Conv` | eligible non-winners with no purchase (`draw_with_purchase` = 0) | −0.3% |
| `Draw_Entries_Total_Units_No_Conv` | units of those | exact |
| `Draw_Winner` | people with a winning intent | exact |
| `Preorder_App`, `Preorder_App_Eligable`, `Preorder_Winner` | the same three counts on intents with `pre_order` | within 0.3% |
| `Total_Product_Units` | `order_pieces` summed over `purchase` events | +0.04% |
| `Unique_Customers` | people with a purchase | −0.2% |
| `Product_Units_<route>`, `Customer_<route>` | pieces and people by route; route of a purchase is the first match of `purchase_with_preorder_app` → Preorder App, `purchase_with_presale` → Presale Offered, `pr_order` → Private Room, `purchase_with_draw_entry` → Draw, else Other | within 1.3% per route; 1-3% of channel-days differ, so the precedence is close, not proven |

The sub-percent residuals on the people counts are rows without an account id and the export's
own fan-out (§6.1). `order_type` on the purchase rows (Draw / Private / Pre Order / Regular /
Insiders) is a different classification from the export's five routes and does not reproduce them.

**`Draw_Entry_Eligible` is not "eligible entries".** It shrinks as the draw is allocated: for a
closed draw it is the eligible entrants left without an allocation (Mondrian 2026 Q3: 280,
against 682 eligible entrants and 841 eligible units). Use `Collectors_Eligible_Entries` for
people and `Draw_Entries_Eligible_Units` for units - the latter is the dashboard's entries
currency, includes winners, and is stable after allocation. Benchmark table B (§4, "session →
unique eligible entry") was transcribed from the workbook's lifetime rollup, whose eligible-entry
columns (M/N) may be this post-allocation count; if so those conversion benchmarks are understated
for every closed draw. To be checked in the sheet.

### 2.3 The export rebuilt here, and the switch

`etl/aggregate_events.py` rebuilds the export from the two event-level feeds and reconciles the
result against the export on every refresh (it runs before `build.py`; `npm run etl` and the
live refresh both chain it):

- **Browsing counts** (`sources/le_browsing.csv`, `node server/bigquery.js --browsing`): sessions
  and page views per channel × day × release, counted inside BigQuery with the same incremental
  merge as the export. The only definitions in them are "a session is a `session_start` event, a
  page view a `page_view` event" (§2.2), no identifier is read, and they are the only rows too
  many to bring here (7.4M since 2023 for two numbers per channel-day).
- **Everything with a definition in it** - every entry, eligibility, winner, unit and route column -
  is computed in Python from `sources/le_events.csv` with the §2.2 definitions, where it can be
  read, versioned and tested. One refinement found by the reconciliation:
  `Preorder_App_Eligible_No_Conv` keeps winners in (eligible pre-order entrants with no purchase),
  because a pre-order winner converts by itself.
- **Output** `sources/across_time.rebuilt.csv`: the export's 34 columns at the export's grain, dates
  DD/MM/YYYY, so `build.py` reads either file unchanged. **The build reads the rebuilt file**;
  `FUNNEL_SOURCE=export` makes it read the export instead. The script never overwrites the export.
- **Reconciliation** `data/app/reconciliation.json` (printed on every run): rebuilt against export
  per column over the shared window, the last day excluded because it is still filling. Tolerances
  are the known residuals: 0.2% on sessions and page views (attribution noise between the two
  table builds - 0.09% of page views, spread thinly over the whole history, and the two tables are
  not always built from the same attribution run), 0.6% on counts of people (rows without an
  account id), 0.2% on units, 2% on the routes (the private room lands about 1% low, which no
  precedence order removes). Result on 2026-09-10 over 393,868 channel-days: within tolerance on
  all 26 metric columns; 20 of them within 0.05%.
- **`data/app/release_people.csv`**: per release, unique entrants, eligible entrants, winners and
  buyers; `won_unpaid` (eligible winners who did not buy), `payment_failed` and
  `payment_failed_units` (entries excluded for a failed payment that did not buy, and their
  units: the demand the benchmark counts, §4a.2); entrants and buyers who had bought (or entered
  a draw) before the campaign started;
  first-time buyers; and how many entrants and buyers had entered or bought one of the same
  artist's previous releases. Counts only, no identifier. A campaign's start is the upstream
  announcement date where the events carry one, else the first entry or purchase.

Known, harmless differences between the two files: the events carry two release names the
export filters out upstream (a 2027 and a 2021 catalogue entry), and `days_until_launch` runs
one day higher in the export on 2% of release-days (the countdown discrepancy already noted in
§11b - the build uses the announce-based columns, which agree on all but 26 of 180,805
release-days). The export's fan-out pairs (§6.1) carry two clock values, and `load_across_time`
used to keep whichever sub-record came first in the file, an order the two files do not share;
it now keeps the busier sub-record, the same choice from either file. With that, a build on the
rebuilt file against a build on the export (2026-09-10): the same 24-release curve panel, session
and entry curves within 0.001 and 0.009 at any grid point, unit curves within 0.04 (the
booking-day residual around allocation), and release-level numbers differing only by a few
sessions of catalogue trickle on 11 old releases.

**Source of truth.** The rebuilt file is the build's default source (since 2026-09-10);
`FUNNEL_SOURCE=export` in the service's environment switches back to the upstream export. The
build falls back to the export, and says so, when the rebuilt file is missing or more than a day
older than the export (the aggregation has been failing), so the dashboard can never freeze on a
stale copy. The export pull stays on for the reconciliation.
The aggregation peaks at about 330 MB (the events read in chunks, signups dropped, the export
folded chunk by chunk for the reconciliation), against the build's 200 MB, so it fits the 512 MB
instance the same way the build does; `AGG_PROFILE=1` prints the peak after each stage.

- **Campaign clock filled in** (§1.5): 33 releases carry upstream dates, 86 get inferred ones
  (one mixed: Cattelan Window's upstream close precedes its announce and is inferred instead),
  244 catalogue names none. The curve panel grows from 24 campaigns to **96**.

Two feeds now describe the same thing: the rebuilt file is what the dashboard reads, the export
is the reference the reconciliation checks it against on every refresh.

### 2.4 Orders and drafts by product (`Order_Line_Concept`)

`Order_Line_Concept` is one row per Shopify order line (130k rows, 119 columns; some lines appear twice, as a plain copy or once per refund on the order, so the feed keeps one row per line id) with the
release (`simple_release_name`, the same key as the funnel), the campaign code (`release_name`),
the product (`shopify_product_id`, `product_title`, `sku`), `quantity`, the list price
(`shopify_product_variant_price`, EUR: 3,000 for Glenn Ligon, 500 for the Dali, the workbook's
figures) and the paid price (`shop_money_price`), `order_source_type` (`Order`, or `Draft` for
a draft order that has no order yet: no price, no financial status, a
`shopify_draft_order_created_at`), `order_financial_status` (paid, pending, partially_paid,
refunded, partially_refunded), `order_originated_from_drafts`, `is_private_room`,
`cancelled_order`, `order_has_frame`, `launch_type` and `launch_date`. It carries the
customer's email on every row, so it is read under the same rule as the event feed (§2.1):
nothing selects the address, and what leaves BigQuery is three aggregate files written by
`server/bigquery.js` on every refresh, committed together or not at all (`--orders` pulls
them alone; `BQ_ORDERS=off` skips them; `BQ_ORDERS_TABLE` renames the table; all take
`BQ_SINCE`):

| file | grain | columns |
|---|---|---|
| `data/orders_by_product.csv` | release × product (one name per product, below) | `units_paid` (order lines, not cancelled, not pending, not of an order refunded in full; a partly refunded order's lines stay paid, because `refund_id` sits on every line of an order with any refund and cannot say which line came back, and the partial refund is nearly always a frame or the shipping; Shopify's own net items sold agreed on five of the six such lines on the Warhol launch), `units_refunded` (lines of orders refunded in full), one row per line id (the table holds some lines twice, as a plain copy or once per refund on the order), and no line of an order tagged `upsell_order_merged` (an upsell bought after an order is folded into it, and the upsell's own order stays in the table with the same lines: counting it counts them twice; the data team's Metabase questions leave it out too), `units_draft_pending` (draft orders an advisor raised that have no order yet, the orders advisors have out for winners who have not paid while they are under 72 hours old, and orders still pending payment), `draft_customers` (the collectors those are out to who have not paid for anything on the release, for information), `units_winner_drafts` (the winners' part of the pending drafts, for information), `units_winner_drafts_lapsed` (winners' orders unpaid after 72 hours: out of the count, shown for information), `units_entrant_drafts` (a person's drafts for collectors still in a draw, counted apart because the entry is already counted), `units_entry_drafts` (the draw's own pre-authorisation drafts, see below), `units_from_drafts` and `units_private_room` (the paid units placed from a draft and through the private room: parts of `units_paid`, the paid lines as `units_paid.csv` counts them, never a refunded or pending order's), `list_price_eur` (median list price), `product_ids`, `skus`, `first_order` and `last_order` (the first and last day of any order line, cancelled and refunded included: how far the feed runs, the `ordersAsOf` stamp, not when anything sold), `last_draft`; and the framing (§6.4): `prints_offered_paid` (paid units a frame was on offer for), `frames_paid` (the frames bought with them, each to the work its SKU names, else shared across the order's prints, a frame per print at most), `prints_offered_entry_drafts` and `frames_entry_drafts` (the same on the app's pre-authorisation drafts), `prints_offered_awaiting` and `frames_awaiting` (the same on the orders awaiting payment, the lines `units_draft_pending` counts, for the Framing forecast) |
| `data/draw_products.csv` | release × draw | `product_title`: the product the draw's winners bought most, by the same names, else, before the draw has winners, the one its entrants hold the app's pre-authorisation drafts for most; `orders` (the people that reading counted), `share` (their share of it) |
| `data/draw_claims.csv` | release × draw, only draws with any | claims a draw round has made that the order table has not caught up with: `claims` (winners the event feed flags who still hold an open pre-authorisation draft, the app's entry draft, on the draw's own product and have no paid order for it), `units` (on those drafts), and `product_title` (the draw's product: the one its winners have paid orders for most, else the one its entrants hold drafts for most). Written with the orders files, empty when its query fails, never committed: a claims file from another moment than the orders would count a sale twice (§6.3) |
| `data/units_paid.csv` | release × product (the same names) × order day (CET) × channel × `purchase_event` | `units_paid`, `units_private_room`, `prints_offered_paid`, `frames_paid`: the paid lines of `orders_by_product.csv` by the same rule (one set of CTEs, `orderLinesCtes`), each order on the channel of its earliest purchase event in the event feed (`AA_session_custom_channel_group_split_touch`, joined on the Shopify order id alone), `Untracked` with `purchase_event` false where the event feed has no purchase for the order. Summed over its days and channels it is `units_paid` per product. The units every card counts (§6.3); written beside the other two in the same commit, so a deploy resets all three to one committed copy, and `etl/build.py` reads a release whose units here do not add up to its `units_paid` in `orders_by_product.csv` as out of step (two pulls), counting the funnel's units for it until the next pull |

**The draw → product map.** The event feed carries no product on a draw entry, so a draw is
named through its people: the draw entry rows give (release, account, draw) and whether the
person won, the collectors table turns the account into the Shopify customer, and the order
lines give what that customer paid for (`paid`) or holds the app's pre-authorisation draft on
(`entry_draft`, the draft the app raises on the entered product with every live entry). The
draw takes the product its winners paid for most; a draw with no winner yet takes the one its
entrants hold drafts for most, the same reading `draw_claims.csv` makes, so every draw is
named from its first entries and the sell-through's rows carry their products, sales and
drafts from a campaign's first day. Until 2 October 2026 only the winners' reading existed, and
Lichtenstein's four draws stood as "Draw 1" to "Draw 4" with 419 units paid, each split by
edition size, for want of a first winner. The join runs inside BigQuery and only (release,
draw, product, count, share) comes out. Entrants of several draws hold drafts across them and
winners buy across them, so the top product takes the draw (`share` says how clear it was: 0.6
to 0.9 on the September 2026 releases' winners). A draw with neither a winner who paid nor an
entrant holding a draft has no row, and its product keeps the event feed's figures (§6.3).

**Two kinds of draft order.** A draw entry creates a Shopify draft order at entry time as a
pre-authorisation (the draw entries export's `Shopify Draft Order ID`, assigned at entry, not
a win signal), and an entrant can let the entry be claimed early as a pre-order; a winner's
converts to an order (`order_originated_from_drafts = 1`). The app writes those drafts under
one facilitator account: since September 2025 one account has written 9,033 draft lines,
8,998 of them on the `-DRAW` SKU, across 49 releases, and on a release without a DRAW variant
per colour it writes them on the base SKU (Ai Weiwei, September 2026: 24 of its 29 entry
drafts). So the query names the app's accounts by their profile, any facilitator whose drafts
are at least 100 lines and 90% on the DRAW SKU, and an entry draft is any draft the app's
account wrote, or, before that account existed, a draft with no facilitator on the DRAW SKU.
Those are the entries in hand the sell-through already counts, so they are kept apart as
`units_entry_drafts` and never drawn as drafts.

**A person's draft is a draft, whatever the SKU.** The drafts the card draws,
`units_draft_pending`, are the draft lines a person raised, on the PREORDER, DRAW or base
SKU alike, plus orders whose payment is still pending: the way the sales team counts its own
drafts (Julian Schnabel, 16 September 2026: 2, 2 and 3 across the three prints, a PREORDER
and a DRAW line each). They are counted per line, a collector who has bought one print and
holds a draft for another being a second sale in waiting, and `attach_orders` caps a
product's drafts at its room left (edition less units paid). The one exclusion is the draft
that is the payment step of an entry already on the card: a person's draft whose customer
holds a live entry on the release (open, or won and not yet paid: an early claim, a winner's
invoice) is counted apart as `units_entrant_drafts`. The link runs inside BigQuery: live
entries from the event feed, through `Collector_Concept`'s account id and Shopify customer
id (the only two columns read from it), to the draft lines in their name.

**A private-room sale is not a draft.** A collector who buys through the private link places
an order directly: an Order line with `is_private_room = 1` and a private link recorded, no
facilitator, counted in `units_paid` and `units_private_room` (Ai Weiwei, September 2026: six
such orders on 26 and 27 August). An advisor draft is a Draft line a named person raised; the
two are never the same line. The funnel's `Preorder_App` counts are another thing again (the
pre-order requests, allocated like a draw).

Only product lines count as units (`shopify_product_type = 'Product'`): a frame is a line of
its own (`Frame`) with no release on it, left out of units and counted in the four framing
columns by joining it to the prints through the order (§6.4). Test orders are dropped.

**One name per product.** A line carries the title its product had when the line was made,
so each Shopify product is named by the title on its latest line: a work renamed during its
sale, if only in its capitals ('Something forbidden (Blue)', then 'Something Forbidden
(Blue)'; Harland Miller's Willpower, 19 and 2 of 25 on two rows), stays one product. Two
Shopify products with one title (a private-room variant at a different price) are one product
here, unless their SKUs name different works (the SKU's first two segments): Urs Fischer's two
Problem Paintings, `FISCH-PROB1` and `FISCH-PROB2`, are then 'Problem Painting (FISCH-PROB1)'
and 'Problem Painting (FISCH-PROB2)', each against its own edition (`product_editions` reads
Airtable's rows of the title before the work), where the one title had read 110 of 100. The three
files and the claims name products this way (`product_names` in `orderLinesCtes`), so they join
on the name; a file pulled before that, with one Shopify product under two titles, is named in
the build log until the next pull.

**Timed launches** read the same lines by the hour (docs/TL_SPEC.md §5): `data/tl_units_hourly.csv`
is `typed` for every launch's lines from three days before its `launch_date` to sixteen after,
per release x product x hour (UTC, the line's creation; a draft's at the draft) x channel (the
order's purchase event in `TL_Funnel_Report_v2`, matched on the Shopify order id inside
BigQuery, else Untracked) x status (paid, awaiting, refunded, cancelled, other): units, orders,
private-room units, the prints a frame was on offer for and the frames bought with them, the
lines' value. `data/tl_buyers.csv` counts, per release, the collectors with a paid order in the
same band, how many took more than one piece, and the pieces between them. Both are written
with the TL feeds (`node server/bigquery.js --write --tl`), aggregates only.

### Draw entries export (per-draw CSV)
One row per entrant per draw (unique on Account ID within a draw). Semantics (pinned down
empirically on the Mondrian and James Jean Blossom draws):

| Column | Meaning |
|---|---|
| `Tier` / `Score` | collector tier (Prospect/Potential/Premium/Patron) and **draw weighting score** (Patron mean ≈ 6.5 vs overall median 2) |
| `Framed` | wants framing (feeds the 0.35 framing-conversion assumption) |
| `MaxQuantity` | max units the entrant will take; **`N/A` = uncapped** (takes everything entered) |
| `Remaining Eligible Entries` | product list the entry is **currently still eligible to win** (equals entered set pre-draw; shrinks during allocation) |
| `Opportunity Cost` | `max(n_products_entered − MaxQuantity, 0)` computed at entry time (can go stale after edits) = the allocator's slack |
| `PreOrder` | pre-order/auto-purchase commitment flag |
| `Winner` / `Claimed` / `KYC Completed` | allocation outcome (all "No" in pre-draw snapshots) |
| `Shopify Draft Order ID` | assigned at **entry** time (pre-auth) - not a win signal |
| `Exclusion` / `Removal` / `Processing Error` | eligibility: eligible ⇔ all three empty |

**Units demanded** (the number to show against edition size):
`wanted_units(entrant) = min(n_products_entered, MaxQuantity if numeric else n_products_entered)`;
`demand(product) = Σ entrants eligible for product` (a lower bound per product);
`total_units_demanded = Σ wanted_units`.

**Allocation rule** (as practised): winners are allocated to maximise revenue across
products - an entrant who entered N products but wants M < N is awarded the M **priciest**
products among those they entered that still have a unit left, the least-demanded among equal
prices, draw weighted by `Score`. Equivalent to capacitated matching; `Σ Opportunity Cost`
measures the flexibility available.

---

### 2.5 BigQuery tables and columns in use (the data inventory)

What the app reads, and from which columns, so the data team can see the surface a
production model has to serve. Everything else in a table is never selected.

| table | read by | columns | for |
|---|---|---|---|
| `le_funnel_report_split_touch_export` | `server/bigquery.js` (funnel feed, incremental) | all 34 (no personal data; §2.2) | `sources/across_time.csv`: sessions, entries, units by channel × day × release, the campaign clock |
| `LE_Funnel_Report` | `server/bigquery.js` (events and browsing feeds) | the event columns named in `EVENT_COLUMNS`: event, date, release, pseudonymous account id, signup, draw entry, winner and purchase flags, order counts, channel groups, locales; never `user_email` | `sources/le_events.csv` and `sources/le_browsing.csv`: the rebuilt export, people per release, the draws and entry patterns behind the per-product sell-through |
| `LE_Funnel_Report` | `server/bigquery.js` (draw map, §2.4) | event_name, winner, draw_id, aa_account_id, simple_release_name, event_date; the collectors table's aa_account_id and shopify_customer_id (joined on inside BigQuery; neither leaves) | `data/draw_products.csv` |
| `LE_Funnel_Report` | `server/bigquery.js` (units feed, §2.4) | event_name, shopify_order_id, event_timestamp, AA_session_custom_channel_group_split_touch | `data/units_paid.csv`: the channel of each paid order's earliest purchase event, which sets the channel split of units sold on every card |
| `LE_Funnel_Report` | `server/bigquery.js` (orders and units feeds: the live entries behind a person's draft, §2.4) | event_name, simple_release_name, aa_account_id, draw_id, draw_with_purchase, draw_entry_eligible, winner, event_date | `data/orders_by_product.csv`, `data/units_paid.csv` (only through which drafts count; aggregates only) |
| `Collector_Concept` | `server/bigquery.js` (the same link, account to Shopify customer) | aa_account_id, shopify_customer_id | `data/orders_by_product.csv`, `data/units_paid.csv` (joined inside BigQuery; no column of it leaves) |
| `meta_ads_insights_export` | `server/bigquery.js` (spend feed) | campaign_name, spend_date, impressions, reach, link_clicks, spend | `data/spend_daily.csv`: paid spend by campaign × day |
| `Order_Line_Concept` | `server/bigquery.js` (orders feed, §2.4) | simple_release_name, release_name, product_title, shopify_product_id, sku, quantity, order_source_type, cancelled_order, order_financial_status, order_originated_from_drafts, is_private_room, shopify_product_variant_price, shopify_product_type, is_test_order, launch_date, shopify_order_created_date_CET, shopify_draft_order_created_at, shopify_order_id, order_lineitem_id, refund_processed_at, customer_id, framing_offered, shopify_order_facilitator, shopify_order_tags (the last four joined and filtered on inside BigQuery; none leaves) | `data/orders_by_product.csv`, `data/draw_products.csv`, `data/units_paid.csv` |

Granted and profiled, not yet read: `Order_Concept` (order level: basket size and items,
first-time buyer, totals, country - units per buyer and buyer mix per release),
`Marketing_Campaign_Concept` (spend by campaign × day across Meta and Google Ads for both
accounts, 2022 to date - a cross-platform paid feed to replace the Meta-only one),
`Collector_Concept` beyond the two id columns above (364k contacts, one row each with the address, name, phone and survey
answers: only ever aggregates such as marketable contacts by tier and budget band, never a
row), `TL_Funnel_Report_v2` (the timed-launch event feed, 81 launches: what a TL page would
read). `tl_funnel_report_split_touch_export` was still denied when this was written.

## 3. The quartile-lever model (retired 2026-09-23)

The first target model reproduced the LE_Template TARGET SETTING block: the edition split
into paid and organic by a paid-share quartile, organic split into draw and private room by a
private-room-share quartile, the draw units placed on twelve channels by an order-split
quartile per channel, entries backed out at 0.8 and sessions at a session → entry quartile
per channel, private-room sessions at an email-only rate, and a paid budget at a cost per
purchase quartile - every pick Low / Medium / High from the whole historical panel (§4).

It was retired on 2026-09-23. The basket model of §4a had been the default since baskets
existed, every targeted release ran on it, and the levers asked a question about the panel
("what share should email carry at the good quartile?") rather than about the launch. The
same month the LE workbook dropped the private-room split from its own target logic, so the
one thing the levers modelled that the basket did not was gone from the source as well.

What went: the quartile branch of `compute_targets`, `quality_for`, the per-channel quality
grid and its inputs (`paid_channel_size`, `reference_point`, `paid_conv_quality`, `cpp_pick`,
`channel_quality_overrides`, `paid_share_override`, `stretch_mode`), the server's JavaScript
retarget (`server/retarget.js`, `shared/targetModel.mjs`) and the quartile tables it read
(session → entry by channel, paid share of units, paid session → entry, private-room share,
email session → purchase). A save now rebuilds the release with the Python ETL, every time.
A release that cannot be benchmarked - no draw panel on file, or a basket whose channels in
plan sold nothing in the median launch - shows its actuals rather than a target from another
model.

What stayed, and where it moved: the cost per purchase is a figure per release
(`cost_per_purchase`, € per paid unit; blank means the basket's median cost per paid unit, else
the panel's median, §4 E); the Referral
Artist tier became the artist posting tier (`artist_posting_tier`), itself retired on 7 October
2026 when the artist-posts benchmark went to the all-campaign median; "N/A" on Referral Artist became the artist's own channels not in plan
(`channels_off`, spec §4.3); and the order-split medians still place a group's target on its
channels (§4a.3). Inputs saved under the old names are read by the build until they are saved
again, and a save drops them.

The full lever arithmetic is in the repository history at that date, and in the workbook's
`LE_Template - old` tab.

## 3a. The TL target model, as the workbook computes it (recorded 2026-09-23)

Built on 1 October 2026 along the lines of `docs/TL_SPEC.md`, which is the spec for the
timed-launch pages: two page states (signups before the window, units in it), the dates worked
back from Airtable's launch date and window length, a TL panel of completed launches and
baskets cut from it, the targets of §7 there. The pipeline is `server/bigquery.js` (the TL
feeds), `etl/aggregate_tl.py` (counts per release, day, hour and channel), `etl/tl.py` (the
release model, the panel, the baskets, the targets, the pages; `type: "TL"`, ids suffixed
`_tl`) and `shared/tlModel.mjs` (the live header), with `tests/test_tl_model.py` holding the two
sides to one figure. What follows is the workbook's own reading, kept as the background the
spec was agreed against. Its September 2026 revision keeps orders and units apart, which the
earlier tab did not. In its terms:

```
total purchases      = edition target                     # ÷ (1 + 0.2 multiple adjustment) on a Multiple
orders               = total purchases / purchases per order        # 1.0948, the panel median
orders excl. drafts  = orders × (1 − draft-order share)             # 0.0714, the panel median
paid orders          = round(orders excl. drafts × paid share pick) # Low / Median / High of orders paid vs total
organic orders       = orders excl. drafts − paid orders
```

Organic, full release: the organic orders placed on the channels by the order split (median
share per channel), sessions = orders ÷ the channel's session → order rate. Pre-launch: each
channel's orders × its pre-launch share of orders, sign-ups = orders ÷ sign-up → order rate,
sessions = sign-ups ÷ session → sign-up rate. Units on every row = orders × purchases per
order × (1 + bundle adjustment).

Paid: the paid orders split 70 / 30 between pre-launch and launch. Pre-launch: implied
sign-ups = orders ÷ sign-up → order, implied sessions = sign-ups ÷ session → sign-up, budget =
cost per converted sign-up × orders. Launch: implied sessions = orders ÷ session → purchase,
budget = cost per sale × orders. The rate and cost picks are quartiles of the paid data
analysis tab. Units for each phase = orders × purchases per order × (1 + bundle adjustment).
Sense check: total budget ≤ 6% of launch value.

Actuals for the charts are reported in both currencies - sessions → units and sessions →
orders, sign-ups → units and sign-ups → orders - with an unattributed-order check, and the
paid ads block carries an Action row, tomorrow's recommended spend and cumulative ROI.

## 4. Benchmarks (how the reference numbers are computed)

Since 2026-09-23 the benchmark for every volume and rate is the release's basket (§4a). This
section keeps the panel-wide reference tables: the two the build still reads (A at the median,
E), the constants, and the record of the rest.

Panel: all releases in the funnel import **not** marked excluded on `Release Selection`
(intended rule: exclude pre-2024 + manual exclusions; currently 142 included - see §11 for the
leaks). For each per-release ratio, zero values are blanked (survivorship: benchmark conditions
on the channel having converted at least once).

`Low = 25th percentile, Medium = median, High = 75th percentile` of the panel.

Key benchmark values in force (LE):

**A. Order split by channel** (share of unadjusted draw+pre-order units). The build reads the
Medium column only, renormalised inside a display group, to place the group's basket target on
its channels (§4a.3):

| Channel | Low | Medium | High |
|---|---|---|---|
| AA Email Auto | .0128 | .0224 | .0790 |
| AA Email Man | .1941 | .3054 | .4383 |
| AA Meta | .0407 | .0629 | .1216 |
| AA Other | .0045 | .0077 | .0096 |
| AA X | .0127 | .0588 | .1667 |
| Direct | .1227 | .1667 | .2100 |
| Organic Search | .0476 | .0761 | .1146 |
| Other | .0075 | .0141 | .0228 |
| Paid Social (= paid % of units) | .0789 | .2619 | .3901 |
| Referral Artist | .0622 | .1053 | .2308 |
| Referral Meta | .0095 | .0263 | .0717 |
| Referral Other | .0146 | .0291 | .0499 |
| Referral X | .1397 | .2500 | .3636 |

**B, C and F** - session → unique eligible entry by channel, the unit mix (private room +
other, draws, pre-orders) and the email-only session → purchase rate - were the lever model's
tables and were retired with it (§3): the basket's own conversion and mix per group replaced
them (§4a.2). Their last values are in the repository history.

**D. Eligible entry → order** ("drop-off" complement): benchmark table exists
(total .43/.66/.90, capped at 1) but the model **assumes a flat 0.8** everywhere (hardcoded).
Keep 0.8 as the planning constant; surface the per-channel table as diagnostics. The same
rate prices the demand the benchmark is read on (§4a.2).

**E. Cost per purchase (paid)**: quartiles over 22 hand-curated historical paid campaigns
(mixing LE + TL): **Low €128.75 / Median €177 / High €291**. Since 2026-09-23 the price of a
paid unit comes from the basket first: each panel launch's cost per paid unit is Meta's spend
under its campaign code from its window's start to the close, over its paid units of demand
(§4a.2: what the spend bought, whether or not the edition had room for it) with the launch's
Untracked units folded in (`demand_share_paid` × all demand), the page's own basis for a paid
unit (`baskets.attach_paid_costs`, a reading from 5 tracked paid units and
some spend; the campaign code is the orders feed's, §2.4), and the basket's median over the
members with a reading prices the paid budget once three have one (`profile.cost_per_purchase`,
`n_costed`). Until 2026-09-28 it was the spend over the whole panel window, to three days after
the allocation, over the tracked paid units alone: a basis about 7% dearer per unit than the
page's, and far dearer for a launch that spent after its close (Felipe Pantone spent 15,121 of
its 16,750 there), so paid read cheaper against plan than it was. The one difference left is
the window's start, 45 days before the announce where the page opens at the private room;
no costed launch on file has spend that early. The release's own
`cost_per_purchase` on the Target setting tab comes before it (Abdulnasser Gharem carries
€291, the quartile it was planned at), and the Median constant stands in when the basket has
too few readings. `targets.paid.cost_per_purchase_source` says which of the three priced it. Companion stats (static): ROI
2.2/3.4/6.9, paid % of units .11/.21/.31.

Recomputation policy for the rebuild: recompute quartiles nightly from BigQuery over a
**correctly filtered panel** (year ≥ 2024, exclude undersubscribed: oversubscription ≤ 10 units,
exclude in-flight releases), using **median for every "Medium"**. Log benchmark drift vs the
frozen values above.

**Baskets of comparables** (`etl/analysis/release_clusters.py`, findings in
`docs/RELEASE_CLUSTERS.md`): the 108 completed draw campaigns in the 2023-2026 BigQuery pull
fall into two robust kinds (paid-led vs organic) and four defensible ones (paid-led headline
launches, paid-supported small editions, email-led collector launches with a private room,
artist-audience draws); the 47 buy-now launches that predate the draw mechanic are a fifth,
legacy basket. Per-basket quartiles of every channel share, conversion and campaign-stage
share are written to `data/release_cluster_baskets.json`, assignments to
`data/release_clusters.csv`. Campaign windows for releases without the upstream clock (every
launch before 2026) are inferred from the funnel - announce from the first run of draw-entry
days, close from the draw-allocation day - and validated against the clocked releases
(announce within 2 days on 31 of 32, close exact on 24 of 27). Every row also carries the
edition's unit price, currency, edition size and launch value from Airtable (§4a.2½), so the
basket layer can match on price as well as size.

---

## 4a. Baskets, the benchmark and the even uplift (the default target model)

The implementation contract is `docs/BENCHMARK_SPEC.md`; where this section and that file
disagree, **the spec wins**. What follows is the model in the terms of this document.

The quartile model of §3 answers "what share of units should email carry if we pick the good
quartile?" - a question about the panel, not about this launch. The benchmark model answers the
question the launch meeting actually asks: **what do launches like this one reach, and how much
more are we asking for?** Everything below falls out of that one sentence.

### 4a.1 The three references

| | what it is | drawn as |
|---|---|---|
| **Benchmark** | what launches in the matched basket typically reach, in demand (§4a.2): the **median** of that basket, per metric and per channel | a dotted outline of the column it would make, `#ea8f66`, drawn over the target's fill |
| **Target** | benchmark × K, the business target | the fill: `#f8ccba` from zero to whichever of the two is lower, `#f8ddd0` from the benchmark up to the target when the target is the higher |
| **Stretch** | target − benchmark = benchmark × (K − 1) | the lighter band of the fill, a number, and the opening step of the two waterfalls; never a band of its own |

Both references are on every bar at once. The fill says what the business asked for and where
the basket agrees with it; the outline says what the basket typically reaches. Percentages,
RAG colours and the headline deltas read against the target (the hero's as a share of it, the
units on hover): a funnel rung is green at or above
it, amber less than 10% short and red 10% or more short, and the sidebar's dot is amber behind
target only while the release is at or ahead of the benchmark's pace for today (spec §5, §7).
Drawing grammar: spec §7.

```
K = edition_size / benchmark_units_total
```

K is **one even uplift**, applied to every volume (sessions, entries, units, spend), in every
channel, at every funnel stage and on every day of the campaign. **Conversion rates are held at
the benchmark**: the plan is "the same launch, bigger", never "the same launch converting
better". Both reference lines are drawn identically - same width, same length - so that colour
and label are the only difference between them (spec §1, §7).

### 4a.2 The basket layer (`etl/baskets.py`)

The panel is `data/release_clusters.csv` filtered to `panel == "draw"` (108 completed draw
campaigns, §4 "Baskets of comparables"); cluster names come from
`data/release_cluster_baskets.json`. Seven ready-made baskets: `similar_size` (the suggested
one, below), `cluster_0` Paid-led headline launches, `cluster_1` Paid-supported small editions,
`cluster_2` Email-led collector launches, `cluster_3` Artist-audience draws, `all_12m` (every
draw launch whose `window_end` is within 365 days of `as_of`), and `same_artist` (the same
artist's earlier launches, disabled when it has no members). A **bespoke** basket is a
hand-ticked set of panel releases; one saved from the picker is written to
`data/app/baskets.json` and thereafter offered alongside the ready-made ones.

Two rules carry the weight, and both are in the module because three callers - the ETL, the
picker API and the re-run a saved basket triggers - have to agree to the last unit:

- **A release is never a member of its own benchmark.** Its own `release_name` is dropped from
  every basket before the medians are taken. Left in, a launch grades itself, and on a small
  cluster it drags the median towards its own result.
- **Per-channel benchmark = median share × median total**, never the median of the per-channel
  column. A basket's per-channel medians do not sum to its median total (each channel peaks on a
  different launch), so taking them directly leaves the five channel benchmarks summing to
  something other than the headline printed above them. Shares are renormalised to sum to 1.

Sizes: a basket with no members (`MIN_MEMBERS` 1) cannot be used at all and the caller falls
back to the suggested one; a single launch can, its own figures being the medians. Under **6**
members (`THIN_MEMBERS`) a basket is used but carries `basket.thin = True`, which the picker and
the Target setting tab show as a warning. A median over an empty or all-NaN column is `0.0`,
never NaN.

The profile is the medians themselves: `n` and `members`; `units` (median `demand_units`, what
the launch would have sold with enough supply, below) with `units_p25` / `units_p75` on the
same, `units_sold` (median `tot_total_product_units`) and `n_short` (members that sold out
short); `price` (median `unit_price_eur`
over the `n_priced` members Airtable priced) with `price_p25` / `price_p75`, and `edition_size`
(median units on offer); `sessions` (median
`tot_sessions_total`); `entries` (median `tot_draw_entries_eligible_units`); `campaign_days`;
`private_room_share`; `share_units` and `share_sessions` per display group; `conv` (median
`conv_sess_entry_<group>`, 0 where there is no history; a group's rate counts only over 100 of
its sessions and at no more than 0.25 entries or units per session, and `baskets.load_panel`
empties the rest, as the panel script does from its next run); and the two products
`units_by_group` = `share_units[g] × units` and `sessions_by_group` = `share_sessions[g] ×
sessions`. Groups are the five display groups of §1.3. The volumes are the panel window's,
45 days before the announce to three days after the allocation, where the page counts from
the private room to two days after the close, so a session benchmark carries some traffic
from before the private room that the page never counts: a few per cent of sessions on most
launches, more on a channel that runs early (Parra's artist referrals, 2,173 on the panel
against 1,398 on the page). The cost per paid unit is on the page's basis (§4 E).

**Units are demand, not sales** (`baskets.demand_columns`, on the panel as it loads). A
comparable that sold out with people left wanting - We are the Revolution: 1,000 offered, 987
sold, 877 of 1,545 eligible entrants won, 668 were left wanting 658 units and 109 entries were
excluded because the payment failed - read on its sales as a launch that needed 100k sessions
and 1,532 eligible entry units to sell 987, so everything benchmarked against it was asked for
more sessions and entries per unit than it needs, and a bigger stretch. Each launch's
`demand_units` = `tot_total_product_units` + rate × (`tot_draw_entries_total_units_no_conv`,
the units wanted by eligible entrants who neither won nor bought, + `payment_failed_units`, the
units wanted by entrants excluded for a failed payment who did not buy, from
`release_people.csv`), the rate being the panel's eligible-entry → order rate (0.8, §4 D), so a
comparable's demand and a live release's secured units are one currency. Eligible winners who
did not pay (`won_unpaid`, 7.7% of winners on the panel) add nothing: they were offered a unit,
and are inside that rate's own shortfall; an undersubscribed launch therefore reads as its
sales. Per group, the sold part lands where the units did (`unit_share_<g>`) and the unmet
part where the eligible entries came from (`ent_share_<g>`), giving `demand_<g>` and
`demand_share_<g>`; `sold_short` marks a launch whose demand ran a tenth or more past its
sales. Over the 108 draw launches demand runs a median 1.13× sales, 47 of them past 1.25×; on
the nine releases benchmarked on 29 September 2026 it lowered K by 4-30% (Warhol 3.03 → 2.13).
Demand is per release, not per product: Murakami 2026 Q2's unmet demand sat on the products
that sold out while others did not, and a comparable's demand is read as the reach its
marketing produced; the sell-through card handles the product mix of a live release. The
similarity rule below still matches on units sold, the edition's size against the
comparables'; only the medians are read on demand.

The suggested basket, `similar_size` ("Similar size and shape"), is the **`SIMILAR_N` = 8
launches nearest this one on units and unit price** (`similar_members`): the artist's own
earlier launches first, when within ×3 on both axes, then the nearest of everything else, with
launches closed in the last 18 months ranked ahead of older ones among those within ×4 while
`prefer_recent` is on (the default). A launch's distance is the larger of its units multiple and
its price multiple. The rule, why eight and not a widening band, and the test that put price in
it (price predicts session-to-entry conversion beyond size on five of eight benchmarked
metrics) are in `docs/BENCHMARK_SPEC.md` §3.1 and §3.1.1; `shared/basketRule.mjs` mirrors it for
the picker. The picker reads the basket's `reach`, how far its furthest member is: past ×4 it
says nothing on file is this size.
A release that has closed is read at its own close (its panel `window_end`, else its
`launch_end`): the recent tier runs back from it rather than from `as_of`, and launches that
closed after it are left out, so its basket stops moving after it closes.

`suggest_basket` picks the basket a release starts on: `similar_size` whenever it has a
member, which it does for any release with an edition size while the panel holds another launch
with units on file. Only without one does it fall back to the shape clusters: the release's own
`cluster` if the panel has it, else `nearest_cluster`, else the cluster whose median units are
closest to the edition size **in log space** (the panel runs from tens of units to thousands, so
a linear gap would put everything in the big basket), tie-broken on paid-session share against
the release's paid plan. The suggestion is a starting point and is always overridable -
`suggestedId` rides on the snapshot next to the chosen `id` so the card can say which one was
picked for you.

### 4a.2½ Edition pricing (`etl/pull_airtable.py`, `etl/pricing.py`)

The funnel export carries no price and no edition size, and the targets workbook prices only
the releases with targets set. Airtable's Pipeline table holds every edition's retail price,
units, launch type, launch date and medium, one record per product (a colourway, a hand-finished
variant, a bundle). `etl/pull_airtable.py` pulls exactly the fields needed - identity, price,
size, type, dates, medium, artist tier and genre bucket, and the per-product target economics
of §1.6 (`Target sell-through %`, `Artist profit per unit`, `AA profit per unit`, `AA revenue
share`, `AA profit share`, `Framing conversion`, `Framing profit per unit`) plus the
`Marketing lead`, each pulled when the table has the field and left blank when it does not
yet, with `AIRTABLE_FIELD_<column>` naming a field spelled another way - and nothing about
people: it refuses to run if a wanted field turns out to hold a collaborator, email or phone
(the marketing lead excepted, read for its display name only), blanks any cell that looks like
one, strips links out of rich text, and keeps only records with an artist, a title and a launch
date that has passed or comes within 120 days. The live refresh runs the pull every cycle when
`AIRTABLE_TOKEN` is set. The result is committed as
`data/release_pricing.csv` (one row per product record, 44 columns, all prices in EUR because
that is the field's currency in Airtable). Credentials are `AIRTABLE_TOKEN` (read-only),
`AIRTABLE_BASE_ID` and `AIRTABLE_TABLE`, environment only.

`etl/pricing.py` joins the records to the release list. A **launch** is one artist's records
under one release code on one launch date, or on staggered closes: works of one code that
close on different days are one launch, dated by its last close (`launch_date`, the day the
campaign ends), with the first close and every close beside it (`first_launch_date`, `closes`)
and the quarter of the first, the one the funnel names the release in. Staggered means within
`STAGGER_DAYS` (21), draws on both days (an originals show, NFTs or a timed edition under a
draw's code, `STAGGER_APART`, is another launch: Pejac's show on 13 November 2026 and its
print draw on 18 December share a code) and, where the later day's records carry an announce
date, one on or before the earlier close; the same code's wave months later is a launch of
its own (a group show puts eight artists under one code; each artist's release is its own row
in the panel). Bundles (a title with a set word - "Set of
4", "[Pair]", "[Quartet]", "[COMBINED PRODUCT]", a diptych or triptych - or any record without
an edition size; a bracketed note alone, "[Special Print Edition]", "[OG painting - 1/5]", is
not one) carry the sum of their parts and are left out, so
a launch's `unit_price` is the **value-weighted mean over its sized products** (the price of
the average unit in the edition), `edition_size` the sum of their units, `launch_value` the
sum of price × units. The match runs strictest first and is never silent: exact artist + title
(with the launch date inside the campaign window or the named quarter); the artist with the
launch date inside `[announce − 45d, close + 30d]` (Airtable's launch date is the close of a
draw and the launch day of a buy-now release); the artist in the named quarter for a release
without a window; and a close spelling of the artist's name ("Woo Kuk Won" for "Kukwon Woo",
"Anni Albers" under "Anni and Josef Albers", estate against foundation) with the similarity
printed and nothing under 0.85 used. Two codes on one date are merged as one launch; two codes
in the window on different dates go to the nearer one and the report names the loser. Every
panel row records `price_match` (exact / artist+window / artist+quarter / fuzzy+window / none),
`price_match_score`, `price_match_days` and `price_note`; `python3 etl/pricing.py` prints the
whole matching report, with the unmatched releases and their dates to fix in Airtable.

Coverage at the 2026-09-17 pull: 1,103 product records, 660 launches, 358 of the panel's 360
releases matched (225 exact, 58 artist+window, 72 artist+quarter, 3 fuzzy), all 108 draw
launches and 46 of 47 legacy launches priced, 359 of the dashboard's 361 releases. Unmatched:
Michael Kozlowski · Mecha · 2024 Q2 and Michaël Borremans · The Monkey · 2027 Q1 (the artist is
not in the pull). Units sold inside the window sit at a median 0.90 of Airtable's edition size;
twelve launches sold more than 5% over it, mostly where Airtable holds one of several products.

Currency: the page runs in euros (`PAGE_CURRENCY`). Airtable prices are euros and pass
through as they are; `unit_price_eur` and `launch_value_eur` convert a record in another
currency at the fixed table `RATES_TO_EUR = {EUR: 1, GBP: 1.18, USD: 0.92}` (rounded 2024-2026
averages, fixed so the panel does not move with the market; in log space a fixed rate is a
constant shift and changes no band and no correlation). The original price and currency are
kept beside the converted one. Meta's spend is euros too, and the workbook's cost figures the
benchmarks came from (cost per purchase, the framing profit) were the same euro figures under
a euros label, so the numbers stand and only the label moved (2026-09-23).

Refresh: `python3 etl/pull_airtable.py && python3 etl/analysis/release_clusters.py
--pricing-only` re-attaches the pricing to the panel on file without a BigQuery pull; a full
`release_clusters.py` run attaches it as it writes the panel.

### 4a.3 Target maths (`etl/build.py`)

With a basket in hand, `targeting_mode` is `"benchmark"` and the launch total is divided by the
demand the basket had (§4a.2), not by a quartile pick:

```
K            = edition_size / profile["units"]          # the basket's median demand (§4a.2): the stretch as one multiple
stretch      = edition_size − profile["units"]
w[g]         = stretch_from[g] renormalised over the groups in plan with a benchmark, else profile["share_units"][g]   # where the stretch comes from, §4a.4
units[g]     = profile["units_by_group"][g] + stretch × w[g]   # sums to edition_size exactly; = benchmark × K when w is the basket's shares
k[g]         = units[g] / profile["units_by_group"][g]         # the group's own uplift; K for every group with the basket's shares
sessions[g]  = profile["sessions_by_group"][g] × k[g]          # conversion held
entries[g]   = units[g] / 0.8                                  # the eligible-entry → order rate, §4 D
paid_budget  = units["paid"] × cost_per_purchase               # the release's figure, else the basket's median cost per paid unit, else the panel constant (§4 E)
```

`compute_targets` returns `edition_size`, `paid_pct`, `paid_units`, `organic_units`,
`per_channel`, `paid{…}`, `launch_value`, `units_per_buyer`, `buyers`, `buyers_by_group`,
`organic_sessions`, `total_sessions`, `entries_target`, `buffer` - or `None` when the release
has no basket to read (§3). `buffer`, and the snapshot's `benchmarks.targetBuffer`, carry the
LE workbook's 0.75 haircut for reference only: no colour on the page reads them (§4a.1).
Organic units are not split into a draw half and a private-room
half: every organic unit is targeted through its group and asked for as an entry, so
`entries_target = edition_size / 0.8`, and `group_targets` sums to the edition size exactly.
The private room stays a measured quantity - the basket's `private_room_share`, the orders
feed's private-room units on the sell-through card - not a target of its own.

The 12-channel `per_channel` table (§3 step 3) is **synthesised** rather than abandoned: each
group's target is split across its raw channels with the `order_split` medians of
`etl/benchmarks.json`, renormalised inside the group. It carries the keys it always did
(`quality`, `order_split`, `purchases`, `eligible_entries`, `sessions`, `session_to_entry`), with
`quality = "benchmark"` marking where the level came from. So the channel-level cards, the funnel
diagnostics and the untracked-redistribution comparisons of §6.2 all keep working untouched.

**Where the stretch comes from** (`stretch_weights`, `allocate_stretch`, `stretch_typed` in
`etl/build.py`; the release input `stretch_from`, a share per group, saved from the Target
setting tab and validated by the server). The gap between the target and the basket's median
is asked of the groups in shares: the basket's own unit shares by default, which is every
group lifted by the same K (the even uplift), or the shares set on the tab when the plan
knows where the extra will come from - most of it from more paid spend, say, or an artist
expected to outperform. The tab sets them with one slider per group, coupled: moving one
group's share rescales the others so the shares always add to 100%, each keeping its
proportion of the rest (`shared/benchmarkModel.mjs` `rebalanceShares`); a group set aside
or with no benchmark has no slider, Even puts the basket's own shares back and All from paid
places the whole stretch on paid. A group set aside (`channels_off`) or with no benchmark to lift takes
none, and a share typed on it falls to the others; a negative stretch (a basket that reached
more than the edition) is a cut placed the same way, and a cut bigger than a group's benchmark
stops at zero with the rest falling on the others, so the groups always sum to the edition.
Each group then carries its own uplift `k[g]`, its sessions and entries with it, and the paid
budget follows the paid units; K stays the total over the basket. `targets` carries `k`,
`k_by_group`, `stretch_from` (the weights in force), `stretch_typed` and `stretch_units`; the
snapshot's benchmark block `kByGroup`, `stretchFrom` and `stretchTyped`, which the cards read
to say where the stretch was placed (`shared/benchmarkModel.mjs` `describeStretch`).
Decision 25 (§11c) is amended accordingly: the stretch is one even uplift *unless placed*, and
conversion rates are held either way.

### 4a.4 The K ratio holds on every day

The daily plan is the benchmark's own shape, scaled once per group:

```
benchmark_plan[g][d] = profile["units_by_group"][g] × curve(basket, g, "entries", pdsa(d))
target_plan[g][d]    = benchmark_plan[g][d] × k[g]     # K for every group unless the stretch was placed
```

(`"entries"`: every unit plan is entry-timed, §5.3; paid's curve is its even daily share,
`paid_pace`, on both lines alike.)

Target and benchmark therefore stand in exactly the ratio `k[g]` at **every** point of the
campaign, not only at close - which is what makes the uplift legible on the trajectory: the gap
between the two lines is the stretch, widening with the curve, never crossing and never
converging. The same identity is what the snapshot asserts: `channels[].bmExp × k[g] ==
channels[].exp` and, summed over the groups, `hero.expectedToday` (with the basket's own
shares, `hero.benchmarkToday × K`), to within rounding. If those ever disagree, the curve was
evaluated twice with different members, not the maths.

---

## 5. Targets across time (the new capability)

The sheet distributes nothing over days (its only daily notion is a run-rate: remaining units ÷
remaining days). The across-time columns enable proper **plan curves** - the design brief
requires `expectedToday(channel)` from "channel-shaped curves, never straight lines".

### 5.1 Method
1. Take completed, clean LE campaigns (campaign window fully observed, ≥ 20 draw entries;
   n = 18 in v1, 76 in the pooled panel at the 2026-09-24 build; a release reads its basket's,
   §5.3).
2. For each, compute cumulative share of the campaign's final total at each pdsa, per metric
   (sessions, draw entries, units) - and per channel where volume allows.
3. Pool across releases on the pdsa axis: **median = the target trajectory**. (v1 also planned a
   p25/p75 guardrail band; it was never built, and the build publishes the medians alone.)
4. A release's daily plan = `target_total(metric, channel) × curve(pdsa of that day)`.
   `expectedToday = target_total × curve(pdsa_today)`.

### 5.2 The pooled LE curve (v1, from the current export, n=18)

Cumulative share of campaign total at pdsa ≤ t (median across releases):

| pdsa ≤ | Sessions | Draw entries | Units |
|---|---|---|---|
| <0 (Early access) | .072 | .000 | .134 |
| 0.1 | .243 | .272 | .277 |
| 0.2 | .361 | .400 | .407 |
| 0.3 | .446 | .519 | .525 |
| 0.4 | .536 | .555 | .585 |
| 0.5 | .558 | .652 | .597 |
| 0.6 | .618 | .707 | .640 |
| 0.7 | .662 | .734 | .691 |
| 0.8 | .724 | .794 | .718 |
| 0.9 | .832 | .831 | .737 |
| 1.0 | .998 | 1.000 | 1.000 |
| incl. Last chance | 1.000 | 1.000 | 1.000 |

Shape facts the dashboard should encode:
- **Announcement burst**: ~24% of sessions / ~27% of entries land in the first 10% of the campaign.
- **Launch cliff**: the final decile carries ~17% of sessions and ~26–30% of units - daily
  pacing must be piecewise, never linear.
- **Early access**: ~7% of sessions, ~0 draw entries (draws open at announcement), but ~13% of
  units - 79% of Private-Room units transact pre-announcement. Private-room targets should be
  phased into EA, draw targets should not start before pdsa = 0.
- Stage split of totals (pooled): sessions EA .11 / S1 .32 / S2 .17 / S3 .36 / LC .04;
  units .17 / .28 / .16 / .25 / .13.
- Dispersion is wide (sessions p25–p75 at mid-campaign: .41–.81) - always show the band, and
  status vs plan should use the band, not the median alone, before shouting red. (Not built:
  the curves are medians alone and the trajectory draws no band, §5.3.)

### 5.3 Per-channel curves

**What the build does.** A release is paced on its own basket's curves (`basket_curves`; the
basket is §4a.2's): per display group and per metric (sessions, draw entries, units), the median
across the basket's clean completed members of the cumulative share reached at each point of
`CURVE_GRID` (pdsa −0.6 to 1.15 in 0.05 steps), forced monotone and scaled to end at 1. A series
fewer than 4 members can shape reads the pooled panel's (every clean completed launch in the
export: 76 at the 2026-09-24 build, `data/app/curves.json`), and a group the pooled panel cannot
shape either reads the all-channel curve. Medians only: no percentile band is built, and the
trajectory draws none. Which curve each plan reads:
- **units, every organic group: the entries curve** (`UNIT_PLAN_CURVE`, below) - the plan line,
  the expected-by-today and the shape of the forward path (§5.4);
- **sessions: the sessions curve** - the sessions targets by today and the funnel's expected
  sessions;
- **paid: no curve** - the even daily budget's share (below); the paid entries curve is read
  only by the forward path's fallback before any spend (§5.4).

The units curves stay in `curves.json` as measured, and no plan is read off them.

Email is spike-driven (sends), socials are post-driven, search/direct is smooth. v1 shipped
pooled per-display-group curves where n permitted, else the all-channel curve; the build now
reads the basket's (above). The email plan curve should eventually be derived from the
**planned send schedule** (Announcement, Early Access 1–3, Sustain, Last Chance 48/24h - the
taxonomy in §8) rather than history alone.

**Every unit plan runs on the entries shape.** Historical `Total_Product_Units` books the
draw's units on the draw-close date (winners are allocated then): ~98.6% of the paid group's,
and in the pooled panel the last 5% of the clock holds 0.34 of AA Email's units against 0.11 of
its entries (AA Meta 0.37 against 0.12, search / direct / other 0.16 against 0.11). The plotted
actual is secured units (§6.3½), which count an entry the day it is made, so a units-shaped plan
cliffs onto the final day: it reads "behind" all campaign, "catches up" in one fictional day, and
the §5.4 projection books the cliff as demand still to come. Until 2026-09-28 only paid planned on
entries and the organic groups read the booking curve: Warhol's 24 September page put 23% of the
AA Email target on the last day, and its dashed line climbed 236 organic units on 30 September
against a trailing pace of about 17 a day. `build_release` now reads every curve-planned group's
plan, expected-by-today and path off its entries curve (`UNIT_PLAN_CURVE` in `etl/build.py`;
`tests/test_entry_timed_plan.py` holds each group's close-day plan step to its entries curve's
step over the same day). Re-read on the pooled entries curves (the basket's are rebuilt on every
run and not kept), the 24 September pages move from 1,449 to about 1,233 at close and from 1,667
to about 1,957 by today (Warhol), and from 190 to about 161 and 405 to about 452 (Julian
Schnabel); closed releases keep their figures and only their plan line changes shape. The genuine
last-chance surge remains in the entries curve. Verified 2026-08-28: dropping each historical
release's close day removes the units-curve jump entirely, proving it is allocation bookkeeping,
not last-day demand; a historical secured-units curve is NOT reconstructable because the export
retroactively reclassifies converted entries out of `*_No_Conv`. Two limits of the entries
shape: private-room units sold before the announce have no entries to time them (the pooled
curves hold no pre-announce share on any metric either), and on the day before an announce the
plan interpolates part way to the announce-day burst on the 0.05 grid, further on entries than it
did on units.

**Curves were tier-blind, and that was deliberate (2026-08-29; the per-basket curves below
replaced the one pooled shape).** The target sets a channel's LEVEL but
every release shares one median SHAPE per display group. Tested 2026-08-29 with `etl/analysis/tier_curve_probe.py`:
split the clean panel in half by each group's realised share, difference each group's curve
against that release's own all-channel curve (so a release that simply ran early does not
read as a tier effect in all five of its groups), then permutation-test the gap. Across 11
testable group x metric combinations **nothing survives Benjamini-Hochberg FDR at 5%** -
closest is search/direct/other sessions at p=0.011 against a 0.0045 threshold. Paid is the
one coherent pattern (the three most suggestive results after search/direct/other, gaps of
17-21 pts) and the one with real stakes: cohorted paid curves would move Dali's expected
paid units today from 7.0 to 60.3, the difference between "on plan" and "far behind". High
stakes on a coin flip, so the pooled curve stands. Two channel groups (AA Meta, Referral
Artist) cannot be tested at all - only 5 of 15 releases carry >= 10 units in them. Re-run
the probe at ~25-30 clean releases.

**Re-read on the 96-campaign panel (2026-09-10, inferred clock, §1.5).** With every completed
draw campaign since 2023 on the clock, the shapes do differ by kind of release (the baskets of
`docs/RELEASE_CLUSTERS.md`), and mostly on sessions and units, not entries. Cumulative share at
the announce day / 30% / 50% / 90% of the campaign, all-channel medians:

| Panel | n | Sessions | Entries | Units |
|---|---|---|---|---|
| Pooled | 95 | .15 / .53 / .70 / .89 | .12 / .51 / .65 / .86 | .16 / .39 / .51 / .68 |
| Paid-led | 41 | .14 / .40 / .56 / .89 | .14 / .49 / .65 / .87 | .18 / .44 / .53 / .72 |
| Organic | 52 | .23 / .63 / .75 / .89 | .09 / .51 / .65 / .86 | .13 / .35 / .46 / .57 |
| Email-led private room | 31 | .41 / .71 / .77 / .91 | .23 / .57 / .68 / .86 | .28 / .51 / .59 / .72 |
| Artist-audience draws | 20 | .03 / .48 / .69 / .85 | .03 / .45 / .63 / .86 | .01 / .15 / .25 / .37 |

Largest gap from the pooled curve anywhere in the campaign: sessions 0.19 (paid-led) and 0.30
(email-led), units 0.31 (artist-audience: 60% of its units book at the close), entries only
0.03-0.14. So the entries curve the hero and trajectory run on can stay pooled; the sessions
and units curves should be cohorted, at least paid-led against organic. What is still open is how
a release gets its basket in the dashboard - the paid channel size pick on the Target setting tab
separates paid-led from organic, the private-room share pick separates the two organic kinds -
which is a product decision before the curves can be cohorted in the build.

**The panel is now per basket, with the pooled curve behind it.** The open question closed the
way §5.3's re-read pointed: a release's curves come from **its own basket's members**, not from
the whole panel, and the basket is a product decision made in the picker (§4a.2) rather than
inferred from a paid-share pick. `build_curves(at, members=None)` takes the member filter;
with no filter it builds the pooled panel curve exactly as before, so every release without a
basket is unaffected. Fallback is per metric and per group, not per release: where **fewer than
4** members qualify for a series `build_curves` already returns `None` for it and `curve_value`
drops to the pooled curve for that series alone - a thin basket can be cohorted on units and
pooled on entries at the same time. Curves are cached per basket id for the run, since the
picker, the snapshot and the re-run all ask for the same ones. Entries curves differ least
between baskets (0.03-0.14 from pooled, above), so in practice it is the sessions and units
shapes that move.

**Paid's plan by today is the even daily budget's share of the days paid runs.** Paid starts
the day after the announce (`PAID_START_DAYS` = 1) and runs to the close, so the paid group's
plan line, its expected-by-today and its benchmark-by-today read
`target × clamp((days elapsed − 1) / (campaign days − 1))`, the plan's daily rate is the paid
budget over those days, and the paid block publishes `paidStartDays` and `paidDays` for the
cards (`paidDayFrac` in `web/src/ui.jsx`). Not the panel's historic paid shape, which starts
near zero and told the Channels vs targets card there was nothing to expect on days when the
Paid spend card, reading the even plan, showed the units bought. The organic groups keep their
entry-timed shape curves. The waterfall's Paid spend step (§9) measures spend to date, today so
far included, against the same even share of the budget. (2026-09-23.)

### 5.4 Forward projection of entries
Projections describe the **current trajectory**; the paid-spend recommendation is the
intervention shown alongside, never baked into the projection. The trajectory does stop where
the recommendation's own limits say spending on would be wasted (Paid, below).

**Organic channels** - the remaining volume follows the channel's *historic shape curve*, the
entry-timed one its plan reads (§5.3); its level scales with demonstrated performance, trusted in
proportion to how much of the campaign the curve says has been observed:
```
w        = curve(basket, group, "entries", pdsa_today)   # share of campaign observed
r        = clamp(actual / expected, 0.25, 2.5)       # demonstrated performance
proj     = actual + target × (1 − w) × (1 + w × (r − 1))
path(d)  = actual + (proj − actual) × (curve(pdsa_d) − w) / (1 − w)   # shaped, not linear
```
Early in a campaign (w small) the future is the plan; late, it scales with what the channel
has actually delivered.

**Paid** - projection = **projected spend ÷ projected efficiency**, day by day:
```
spend_fwd(d) = current daily spend run-rate            # not the recommendation; nothing from the stop on
cpe_fwd(d)   = trailing-3-day CPE × path(d)            # the cost path of §7: rises with spend so far, the close's lift on its last days
entries_fwd  = Σ spend_fwd(d) / cpe_fwd(d)
stop         = the first of two days (6 October 2026): the day Σ entries_fwd × rate reaches the
               sellout gap of §7 (edition − secured − the organic channels' course; that day's
               spend cut to the units still needed), and the day cpe_fwd(d) before the close's
               lift passes the ROI floor's price (§7 cpe_max, read where the floor is). At the
               recommended spend the stop lands on the close or not at all, which is what sized
               it; a paced cut still above the floor's spend stops before the close.
```
Fallback when no spend history exists yet: paid target × remaining share of the paid curve,
which nothing stops; with a price and no spend there is nothing to project.
Projected *purchases* from any projected entries convert at the 0.8 eligible-entry→order rate.

---

## 6. Actuals and live status

### 6.1 Daily actuals (grain: channel × day × release)
From the daily funnel feed: sessions (`Sessions_Total`), page views, draw entries,
`Draw_Entries_Eligible_Units` (AC - the "eligible entries" actual),
`Draw_Entries_Total_Units_No_Conv` (AB - eligible entered units not yet converted),
`Total_Product_Units` (U - units sold), customer/unit splits by route (Draw / Preorder App /
Private Room / Presale Offered / Other). Since 2026-09-24 the page's units sold are not the
funnel's: `swap_units` zeroes `Total_Product_Units` and `Product_Units_Private_Room` over the
window and adds the orders table's paid units per channel × day in their place (§6.3), so
every reader downstream runs unchanged on the one count.

⚠ The raw daily export can contain **two sub-records per (channel, day, release)** (two
campaign-date records with launch timestamps ~1 day apart); metrics are split across the pair -
**sum them**, never de-duplicate.

### 6.2 Launch-to-date actuals vs target
- Sessions/purchases per channel: SUMIFS over the lifetime rollup, then **redistribute Untracked
  pro-rata** across tracked channels.
- **Projected purchases ("Actual" on the purchases chart)** =
  `confirmed_purchases + 0.8 × eligible_entries_not_yet_converted`.
- `% sellout = projected_purchases / target_purchases` (release-level: vs edition size).
- Conversion actual = projected purchases ÷ sessions, compared to the target conversion.

### 6.3½ Secured units - the unified page currency
The hero, trajectory, channels, funnel and waterfall modules run on one metric of sales plus
entries: the sell-through's own count (§6.3).
```
secured units = units paid (all routes, incl. private room), from the orders table over the
                window (§6.3)
              + draft orders raised and not yet paid (they take room like a sale)
              + the winners the eligible entries still in the draw imply, allocated across
                the products by the maximum-quantity rule, × the release's entry → order
                rate (`entry_conversion_rate` on the Target setting tab, else the panel's 0.8)
```
Only *unconverted* entries carry the rate (a converted entry is already a sale - counting all
entries would double-count). Once the window has shut (close + 2 days) the drafts and the
entries drop out and secured units are the units paid. Units paid sit on their orders'
channels and entries on the funnel's, so the channel columns are each channel's secured units
(units paid + rate × unconverted entries) scaled in proportion to the sell-through's count (`adopt_sellthrough`): drafts and
the allocation rule have no channel of their own, and the scaling is what keeps the channels,
the trajectory, the funnel's conversion steps and the waterfalls summing to the hero. The
projection's further units follow the funnel's shape and are capped at the room left, as the
sell-through caps them. Group unit targets sum exactly to the edition size, so the hero target
= sellout (private-room units ride with the AA Email group, the workbook's own convention).
The hero, the trajectory's all-channels line and the waterfall are **capped at the whole
edition**: the hero names the surplus as oversubscribed, the trajectory flattens at the
sellout, and every waterfall walk carries the surplus as a last step, `Beyond sellout`, so its
steps still close on the figure printed. A single channel's demand is its own and is not
capped. The trajectory's **By channel** view stacks the five channel groups under that
all-channels line, each band a group's units (secured to today, projected after), so the bands
add up to the line; where the line is held at the edition every band is scaled by the same
factor, each group keeping its share. The same entry → order rate prices the paid model's
converting entries (§7) and the
targets' eligible entries (`benchmark_targets`), so one rate runs through the page.
(2026-09-23.)

### 6.3 Sell-through prediction, per product (LE)

**Units sold: the orders table, over one window, on every card (2026-09-24).** The hero, the
trajectory, the channels, the funnel's conversion steps, the waterfalls, the paid card, the
sell-through and the framing all count one figure of units sold: the units paid in the orders
table (§2.4), cut to one window of days.

- **Source.** `data/units_paid.csv` (§2.4), per product, order day and channel. Each order
  sits on the channel of its own purchase event, so the channel split is the funnel's
  attribution, order by order; an order with no purchase event is `Untracked` (§1.3).
- **Window** (`sales_window` in `etl/build.py`). From the campaign start (the private room
  opening, else the announce), or the release's first paid order where that is earlier - an
  early private-room sale opens the window - but never more than 45 days before the announce
  (`EARLY_SALES_DAYS`); to two days after the close (`UNITS_GRACE_DAYS`, the winners paying
  in the grace), or the as-of day while the launch is live. The close is the later of the
  clock's and the day the draw ended, its last entry day in the draw feed (`sales_close`,
  `release_products.json` draws' `last`, the allocation day on the launches checked), moved
  21 days at most (`DRAW_END_MAX_DAYS`): the winners pay when the draw ends, and a clock that
  closed first dropped their payments from every card (Jaume Plensa's UTOPIA, clock 29 July,
  draw to 5 August: 61 of 218 units counted; Johnson Tsang's Alliance read as a 7-day
  campaign that ran 22). An actuals page then closes with the draw - its length in the
  sidebar, and the spend and sends it counts - and says so in `derived.dates_note`; a
  targeted page keeps its typed plan and folds the payments into its close day. The build
  warns when at least 10 units, and 10% of them with the window's own, are paid in the 14
  days after a window shut (`late_paid_warning`). The funnel's sessions and entries
  are cut to the same days. Units paid outside the window count on no card; the snapshot
  says how many (`sellthrough.unitsOutsideWindow.{before, after, pending}`: before it
  opened, after it shut, and, while it is open, paid after the as-of day, which count on
  the next build) and the sell-through's Paid popup names them.
- **After the window.** Once the as-of day is past the close plus two days, drafts and
  entries in hand stop counting, on the orders' units and the funnel's alike: whatever they
  become is paid after the window. The build takes the entries off every channel
  (`Draw_Entries_Total_Units_No_Conv` read as nothing), so each channel, each day of the
  trajectory, each part of a column, the funnel's rungs and the paid card read that
  channel's own units paid, and the hero is their sum.
- **Nowhere to fold.** When every unit in the window is Untracked (the funnel has no row for
  the release yet, and no order had a purchase event) or Direct with the Direct switch on,
  the fold has no channel to spread over; the window's rows come back as they were, Untracked
  as Other (`keep_units`), so no unit is lost. With drafts out and nothing yet on any channel,
  the count is added on the channels' sessions (Search / direct / other when there are none)
  as a part named Not yet paid.
- **One sum at close.** The card's Paid is what its rows add up to (the page's units sold,
  or the products' own paid units where those are more, which only a page on the funnel's
  units can have), and its percentage at close is the same parts the hero adds up (paid,
  drafts, the draw's winners, the units still to come) capped at the edition
  (`close_headline`). Before, the room left was worked out from the orders' paid units while
  Paid and the hero read the funnel's, so a card could reach 100% with the hero short by the
  difference (Maurizio Cattelan, September 2026: 100% against 1,957 of 2,000, 43 = 252 paid
  in the orders less 209 in the funnel). `check_snapshot` fails a build where the two part.
- **Catalogue pages.** A catalogue page's 90 days are all in the orders feed, so a release it
  has no row for sold nothing in them (the funnel's purchase event there was an order with no
  product line on it), rather than falling back to the funnel's count. A catalogue page is
  never closed, so its secured units also keep only what belongs to its 90 days: the entries
  of a draw whose last entry came before them leave the patterns (`entries_in_hand`: its
  losers are not in hand, George Condo 2024 Q1 read 301 secured on nothing sold, Pejac 2024
  Q3 471), and a product whose every draft was raised before them keeps no drafts
  (`orders_in_window` `drafts_since`, on its last draft day: the feed dates a product's latest
  draft, not each one, so a product with a draft inside the window keeps them all).
- **Product rows.** A draw the orders feed does not name yet takes no sales of its own on an
  orders-sourced page (not the event feed's winners who bought, counted over all time on
  another basis), and nor does any draw when nothing at all was paid in the window; its units
  stay at release level with the rest no product is named for, so the rows add up to the Paid
  figure. `check_snapshot` fails a build where they do not, on any page, or where the Direct
  switch's view breaks any of its rules. (Before, two old catalogue pages printed their
  draw's 2024 winners as paid rows under a Paid of nothing: Jake Fried 17, Dawnia Darkstone 5.)
- **Why.** The reconciliation (`etl/analysis/feeds_reconciliation.js`, output in
  `data/reconciliation/`) matched the two feeds order by order from January 2025: 14,580
  orders agreed to the unit, none had a purchase event without a paid line, and one paid order
  had no purchase event. The 313 that differed were the funnel's: `order_pieces` short on
  orders of several units (161 orders, 174 units), and pieces on test orders, refunded orders
  and lines that are not a paid product. The rest of the gap between the cards was the
  window: the funnel counted from the private room or the announce, the orders feed from the
  first order ever, and neither stopped at the same day (Maurizio Cattelan, September 2026:
  133 against 251 before this change).
- **Fallback.** The funnel's units, as before, where there is no units feed, the orders feed
  does not know the release, or the window opens before the feed's first day (`BQ_SINCE`,
  2025-01-01): `unitsSource` says which (`orders` or `funnel`), `salesWindow` gives
  `{start, end, closed, firstPaid}`, and `check_snapshot` fails a build where an
  orders-sourced page's `sellthrough.sold` is not `unitsPaidOrders`.
- **Not moved.** The benchmark panel (`etl/analysis/release_clusters.py`, `etl/baskets.py`)
  still reads the funnel's units for past releases, and moving it to the orders feed is a
  follow-up. The reconciliation's 0.1% is the order-level match on orders both feeds know since
  2025-01-01; over the draw panel's windows the gap is 0.8% of units on launches since 2025 and
  2% overall, most of it two 2023-24 draws whose purchase events carry every unit twice
  (Johnson Tsang's Open the Right Mind, 196 units on an edition of 100, 98 in the orders feed;
  Kaï's Content, 162 against 81). `baskets.load_panel` leaves out any launch past 1.5× its
  edition or the orders feed's units over its window. The panel's channel split is only as
  current as its last run: the feed moved some 10 to 15% of each launch's units from AA Email
  to Referral Other on 24 September 2026, and the panel, last run on 10 September, did not
  follow. The build warns when a closed page's units split is more than 0.05 from its own
  panel row on any group, and when a launch the panel has in flight closed a settle period
  (7 days) ago (README, "Re-running the benchmark panel").

Sell-through is three things added up, per product:

```
sold          units paid for in the window (above)
drafts        orders awaiting payment: the draft orders a person raised, and orders still
              pending payment, capped at the product's room left (not the app's own
              pre-authorisation drafts, which are the entries, nor a person's draft for a
              collector whose entry is already in hand): they take room out of the edition
              like a sale; from the orders feed (§2.4), null until the product's draw is
              named there
in hand       eligible draw entries still in the draw, ALLOCATED across the products by the
              maximum-quantity rule below, × the entry → order rate (0.8 unless the release
              sets its own)
```

plus, at close, the projection's further units placed by the same allocation rule: the entrants
still to come are taken to look like the entrants so far (`future_cohort`: the entry patterns with an
open entry, scaled to the projection's entries and rounded to whole people), and placed against the
room left after what is in hand, so a flexible entrant goes where there is room as one in hand does
and a full work's share falls out as oversubscribed (`futureOversubscribed`, drawn past the edition
at close; `allocation.futureRule` says `cohort`). Without an entry pattern to read (a release the
draw feed does not carry) the units follow the works' demand so far, each held to the room it has
left, the excess going on to the works with room in the same proportion (`split_future`,
`splitFuture`; `futureRule` `demand`). Until 6 October 2026 the units were spread over the room left, which handed
nearly all of them to the work with room once another was full: Cattelan's Novecento read 88% at
close on a third of the entries. `etl/analysis/split_backtest.py` reads fourteen closed multi-work
draws (29 works, every work with a draw) at a share of their window, with the entry patterns
rebuilt from the event feed as of that day and the total still to come taken as known, so the test
is the split alone. Over every work the cohort rule misses by 5 points on average against 6 for the
room rule, and leans 4 points high against 6; on the ten works that ended below 90% of their
edition the room rule reads 15 points high at 40% of the window and 16 later, the cohort rule 9 to
13. The demand split alone (the fallback, with a full work's excess handed on to the works with
room) reads within a point of the room rule on those works, 15 and 16: once the popular work is
full, moving its excess on is what the room rule did. What is
left on those works is not the split but the entrants still to come converting below the rate:
Dali's Spectre of Sex Appeal reads 76% at 40% under the cohort rule and ended at 76, against 100
under the room rule; En Iwamura's lagging Neo Jomon 67 against 95, having ended at 32.
Everything is capped against the product's room (edition − sold) only where it is drawn; the
uncapped demand is kept so an oversubscribed product stays visible as such.

**Where the per-product data comes from.** A release runs **one draw per product**, so the
event feed's `draw_id` is the product dimension (§2.2: exact against the multiset cap on 38 of
38 releases with one or two draws; a re-run or a second wave adds a draw for the same product,
and the two merge where both carry one name typed against their draw ids, `products: [{key:
draw_id, name}]` in the release's inputs, which no page edits today). Per draw entry
(entrant × draw) the flags fold with `any` as the export folds them:

| state | definition | counts as |
|---|---|---|
| open | eligible, not won, not bought | in hand, placed by the rule |
| won | won, not yet bought | not counted: spends the winner's appetite; the advisor's order for them, if any, is in the drafts |
| sold | won and bought | a sale of that product |
| bought without a win | `draw_with_purchase` on a losing entry (a re-offer, a private-room buyer's entry) | out of the in-hand pool, as the export's `No_Conv` treats it, but **not** claimed as a sale of that product |

`draw_entry_multiset_preference_max_quantity` is the entrant's maximum quantity across the
release; empty means no cap. **Sold and drafts per product come from the orders feed** (§2.4):
each draw is named with the Shopify product its winners bought, or before it has winners the
one its entrants hold pre-authorisation drafts for, and a product whose draws are
named takes that product's units paid as `sold`, its orders awaiting payment as `drafts`, the
product title as its name unless a name was typed against one of its draw ids, and its
Airtable edition where none is typed (`attach_orders` in `etl/sellthrough.py`, the same rule in
`shared/sellThrough.mjs`). A name typed with no draw id (the older hand-typed list) is handed
out by position, which says nothing about which draw it meant, so it never stands over a title:
it names only a draw the orders feed cannot place yet, and one that names a placed draw's
product is left out (the names typed that way for Mondrian and James Jean, whose draws all
opened on one day, had sat on each other's works). `check_snapshot` logs a warning, never a
failure, for a row named for the product another draw sold. A title
no draw names is added as a product of its own once every draw is named; before that it is
ambiguous and its units stay at release level. Where a draw is not yet named (no winner has
bought yet) sold per product falls back, on a funnel-sourced page, to the draw's winners who
bought, or to the purchase rows tagged with a draw id (`purchaseUnits`) where the feed tags
them; on an orders-sourced page it takes none of its own (§6.3, product rows); drafts stay null.
Sales no product can be named for - private room, pre-orders and re-offers on titles no draw
names yet - are the page's units sold less the attributed sum (`unattributedSold`): on an
orders-sourced page the orders table's units over the window (above), nothing once every draw
is named; on a funnel-sourced page the funnel's units, which can also run ahead of the orders.
They are split across the products by edition size (by eligible
entrants until every edition is typed), carried per product as `soldAssumed`, drawn inside the
sold segment and named as an estimate in its popup. The snapshot lists what is still missing in
`sellthrough.incomplete` (`sales by product` and `draft orders` until every draw is named;
`products` when the feed has no draws at all) and the card wears an **Incomplete data** stamp
over the rows while the list is not empty; `soldSource` says which rule the sold figures came
from (`orders`, `purchases`, `winners`). The release-level `sellthrough.drafts`,
`unitsPaidOrders` and `ordersAsOf` come from the orders feed whenever it has the release,
draws or no draws, and `ordersByProduct` and `drawProducts` ride on the snapshot so a save
re-runs the same rule on the server.

`etl/aggregate_events.py` (`products_file`) writes `data/app/release_products.json`: per
release, the draws with their counts (`entrants`, `eligible`, `winners`, `sold`, `open`,
`wonUnpaid`, `purchaseUnits`, first and last entry day) and the **entry patterns** - the
multiset of (open draws, unpaid wins, paid wins, pieces bought, max quantity, pre-order
entries) with how many
entrants share each. Patterns are enough to run the allocation anywhere and name nobody.

**The maximum-quantity rule** (`etl/sellthrough.py`, mirrored in `shared/sellThrough.mjs`,
held to the unit by `tests/test_sellthrough.py`). An entrant who entered four products with a
maximum quantity of two is one conversion on two products, not four, and the allocator awards
them at close for revenue: the priciest of them with a unit left. The prediction counts the
same way before close. Each entry converts at its own rate: `pre` on a pattern is the open
entries that person made as a pre-order, whose card is already authorised, and those count at
`preorder_conversion_rate` (0.95) against `entry_conversion_rate` (0.8) for a plain entry, so a
product's prediction is the sum over its entries and not a head count times one rate. The two
rates are the release's, the ones the Target setting tab shows, and every product converts at
them: a per-product pre-order rate (the Warhol Lifesize carried 80% from 21 to 25 September,
set because its draw had already been run) was invisible on the tab and is no longer read or
saved. Flexible entrants are over-allocated for the payments expected to fail, the priciest
editions first, so the editions that drive the most revenue are counted to sell-out before a
cheaper one takes a unit:

```
appetite = max quantity − pieces already bought        (no cap: everything entered)
unpaid wins spend the appetite first but count no units (a winner who has not paid is a
draft when an advisor has an order out for them, and nowhere otherwise); the appetite left
goes to the open entries
claims still landing     → counted first, at the pre-order rate, on their product: a draw
                           round's winners whose orders the order table has not shown yet
                           (see below)
appetite ≥ open entries  → counted once on each (nothing to choose)
appetite < open entries  → FLEXIBLE: placed one unit at a time, for revenue: on the
                           priciest product that still has room, the lowest fill among
                           equal prices, and only once every product is full on the
                           lowest fill; taken from the flexible entrant with the fewest
                           other options left
room(p)  = sold_p + Σ rate_e over counted_p < edition_p   (expected orders still short of the
                                                          edition: the next entrant is the
                                                          over-allocation that covers the
                                                          payments expected to fail; the last
                                                          may pass the edition, and `shown`
                                                          caps it there)
fill(p)  = (sold_p + Σ rate_e over counted_p) / edition_p (plain units, and no price rule,
                                                          until every product has an edition)
price(p) = the list price the orders feed carries       (missing: the median of the others;
                                                          none at all: fill alone)
```

So the expensive product is spoken for, to its whole edition once the expected failures are
covered, before a cheap one gets a unit it could also have sold (with 13 flexible entrants at
80% a 10-unit edition shows sold out, where stopping at 12 left it at 9.6),
a product short of demand is topped up before one already spoken for among equal prices, and an
entrant with one alternative is placed before one with five. Ties break on product order, then pattern
order, so the same input gives the same answer on either side. The snapshot records, per
product, `allocated` = `fixed` + `flexible` (the demand counted there, in people; `pinned`
is the unpaid wins, tracked but not counted),
`predicted` = allocated × rate, `shown` = predicted capped at the room, `oversubscribed` =
the rest; and for the release `allocation.{entrants, flexibleEntrants, surplusEntries,
uncapped, unpaidWinners, flexibleUnits}`.

**Claiming pre-orders never reads as sell-through going down.** A draw round claims its
winners' pre-orders: the pre-authorised card is charged and the app's pre-authorisation
draft becomes the paid order. The event feed flags the winners at once; the order table,
which the page's units sold come from, shows the orders at its next sync, an hour or so
later (on the Warhol Lifesize on 25 September, twelve claims at 10:00 UK time reached the
order table at 11:16). In between, those people are neither entries in hand nor sales, and
the sell-through would dip until the orders land. So the orders pull also counts, per draw,
the winners who still hold an open pre-authorisation draft on the draw's own product and
have no paid order for it (`data/draw_claims.csv`, `drawClaimsSql`): during a round those
are exactly the claims the order table has not caught up with, since the sync that brings
the order removes the draft, and a claim that fails removes it too. Outside a round a few
stale drafts sit there for days (a draft left open after a failed charge; on 25 September,
23 people across 19 draws, most on closed releases). A single pull cannot tell those from a
round, but time can: each pull's counts are kept for a day (`draw_claims_history.json` on
the sources disk) and a draw's claims are still landing only by how far they stand above
their lowest count over the last six hours (`load_draw_claims`). A round shows as the rise
and is gone at the next sync; a stale draft counts for at most six hours, then is part of
the floor. A first pull, or one after a gap, has no floor but itself and counts none.
Each product takes its draws' claims as `claimsInFlight`, counted at the pre-order rate
before any entrant is placed, so they take their room first; the row carries them as
`claims` and the release as `sellthrough.claimsInFlight`.

**The card's colours are one ramp, and the message posted to Slack is the same rows.**
Paid, drafts, the draw winners the entries imply and (at close) the units still to come are
four tints of the page's blue, deepest to palest as the units get less certain, and nothing on
the card is hatched. A product's bar is its edition: demand past it (entrants in hand with no
room and, at close, the further entrants a full work turns away) is not drawn, it is a line in
the row's hover, "Beyond the edition, no room" (6 October 2026; drawn past the sellout in the
winners' tint it read as one more kind of unit). `Post to Slack` sends those rows as a Slack message
composed on the server from the same snapshot (`server/slack.js`): the artist as a header;
the works' shared title and the campaign day on one line; the table's title; Slack's `table`
block (the Work column wrapping, the figures right-aligned), one row per work with its units
sold (today, or projected at close; the column's asterisk points to a footnote at the bottom:
paid units, drafts and the forecast conversions from draw entries), its target (typed per product on the
Target setting tab when targets are set that way, else the release's target split by edition
share, the rule the references follow), how far along the target it is, its framed units
and its framing conversion (the row's `framing.forecast`, §6.4, at the horizon: frames per
print on the same units as the units column, so the asterisk's footnote covers both; a dash
for a work with no frame on offer; the columns left out where the release has no framing
option or the snapshot no forecast), and a bold Total row adding them up (the forecast's own
totals, the rows' frames before rounding); then, in small type, the day the figures
run to (the page's `asOf`, "so far" while `asOfFraction` is under 1), the attribution when the
page has Direct on Spread, the totals (paid, awaiting payment, expected from the draw, at close the units still
to come) and the two framing readings behind the table's figure (`framing.rate` on the paid
prints with the count behind it, and the entrants' rate on their pre-authorised prints, the
Framing card's two bars, §6.4; either alone where only one has anything to say; nothing on a
snapshot without the block or where no print has a frame on offer; the plan's rate is not
repeated) as plain sentences. The figures are computed once, on the server, at the horizon the page is on
and with its Direct switch (on Spread, from the snapshot with `variants.direct_spread` laid over
it, as the cards read it). The notification's headline is the card's: the release's
`sellthrough.edition` (the works' editions added up only when it has none) under both the
percentage and the "of N units", at close the card's `sellthrough.pct`.

**One row of the grid, whatever the count.** The rows have a fixed 196px of the card; the
pitch is that shared by the count, capped at 60px, and the bar is half the pitch (seven
products, 14px bars on 28; five, 19 on 39; four, 24 on 49; three or fewer, 30 on 60, the cap
being what keeps one edition from filling the card). The rows start under the headline and
never spread; past seven they scroll. The key sits on the headline's own line, which is what
gives the rows their height. Each row carries its units of the edition (198 of 1,000) in muted
text and its percentage in ink, each in a column of its own so the two never read as one
figure, and no RAG colour, which said "bad" about a product that was simply mid-campaign. The
head carries the title and the horizon and nothing else: no scale toggle and no rate, by
decision; every bar is its product against its own edition, and the rate the estimate runs at
is in the headline's popup and in the Slack message.

**No references on this card.** The snapshot still carries the release's pace applied to each
product's edition (`expectedToday_p = edition_p × hero.expectedToday / edition`, likewise
`benchmarkToday_p` and `benchmarkClose_p`), but the card draws neither the target fill nor the
benchmark outline, by decision: both are on the hero and the channels, and on this card they
crowded the one reading it is for, each product against its own edition. The card carries no
prose either; the allocation's account is in the draw-winners key's popup, the split of
unattributed sales in the paid key's, and the editions are checked on the Target setting tab.

**Products and editions.** One row per draw the feed found (`productsFromDraws`), named by
the Shopify title its winners bought, or its entrants hold pre-authorisation drafts for until
it has winners, and sized by the Airtable record of that title (§2.4,
`attach_orders`). A name or an edition typed against the draw id (`products: [{key: draw_id,
name, edition}]` in the release's inputs) stands over those, and draws sharing a typed name
merge. The Target setting tab no longer lists the draws: these are typed into the release's
inputs, `etl/release_inputs.json`, or `data/inputs.saved.json` (`SAVED_INPUTS_PATH`) once the
release has been saved on the tab, since that record then stands in for the repo's; the tab
sends them back as they came. A single product with no edition takes the
release's; with several products the card runs on units and says so until every product has
one, and it flags editions that do not add up to the release's (`sellthrough.editionMismatch`:
an amber "editions add to N" beside the card's title, and a note on the Target setting tab,
which leave the figures as they are until one of the two is corrected). `entry_conversion_rate`
(optional, per release) is the rate the prediction converts entries in hand at, and the rate
the whole page runs on: the secured-units currency, the paid model's converting entries and
the targets' eligible entries (§6.3½).

**Headline.** With the draw feed present the release's `soldPredicted`, `futureEntriesPredicted`
and `pct` are the per-product figures summed (each capped at the release's inventory left), so
the card's rows and its headline are one sum; without it they are the release-level figures
as before (`inHandUnits × rate`, capped). The hero adopts the headline (§6.3½), and the funnel's channels are scaled to it.

### 6.4 Framing take-up (the Framing card)

**The measure is frames per print, on the prints a frame was on offer for.** A frame is a
Shopify line of its own (`shopify_product_type = 'Frame'`, no release name), so it is joined
to the prints through the order. Per order the frames count a frame per print at most
(`LEAST(frames, prints on offer)`). A frame goes to the work its SKU names when that work is
on the order: the SKU's first two segments name the work (`WARHO-BRIW1` in the print
`WARHO-BRIW1-PE-DRAW` and the frame `WARHO-BRIW1-FR-REDRAMINW` alike), so a frame on an
order holding two works is counted against the right one. A frame whose SKU names no work
on the order is shared pro rata across the order's prints, which is exact whenever the
order held one print. A release's total is exact either way; a work's is whole wherever its
frames name it, and fractional only for shared frames (on the Warhol launch 322 of 324 named
their work). A print a frame was on offer for is a product line whose
`framing_offered` is `Optional framing on order` or `Frame included`; `No framing` and blank
are the prints that could not be framed (the Lifesize Brillo Box), left out of the rate and
counted apart. The rate is read on prints rather than orders because the economics are per
print: 71% of the Warhol buyers took a frame but 67% of the prints went out framed, a few
multi-print orders having framed only some.

Two populations, on the same scale (the feed's framing columns, §2.4), drawn as the card's
two bars:

| Bar | Numerator / denominator | What it says |
|---|---|---|
| Buyers | `frames_paid` / `prints_offered_paid` (paid orders: not cancelled, not pending, not refunded in full) | what has gone out framed |
| Entrants | `frames_entry_drafts` / `prints_offered_entry_drafts` (the app's pre-authorisation drafts, §2.4) | the frames the people still in the draw have asked for: what allocation brings if they win at this rate |

**The headline is the forecast, on the sell-through's own units.** The card's big number and
the Slack table's framing columns count the same units the sell-through counts (§6.3), at the
page's horizon, so a framing figure never sits beside a units figure on another base:

| Units the sell-through counts | Prints on offer | Frames |
|---|---|---|
| paid | the work's `prints_offered_paid` | its `frames_paid` |
| drafts awaiting payment (the sell-through's `drafts`) | their share on offer, `prints_offered_awaiting / units_draft_pending` | at their own rate, `frames_awaiting / prints_offered_awaiting`; a feed pulled before those columns: the work's buyers' rate |
| the draw winners the entries imply (`shown`) | the share of the work's pre-authorised prints on offer (else of its paid ones) | at the entrants' rate, the work's own, else the release's |
| at close, the entries still to come (`futurePredicted`) | as the winners | as the winners |

Per sell-through row, found through the draw's pairing with the orders feed's product
(`sellthrough.drawProducts`, the pairing the sold column follows), else by name (the same
name, or the one name starting the other); a work paired with two rows shares its paid prints
by their sold units, and a row neither can place takes the release's shares and rates. The
units of rows with no frame on offer are counted apart (the card's key). The forecast sits
between its two parts whenever the entrants ask for more than the buyers took, which is the
point: on the Warhol launch on 24 September, 67% of paid prints had gone out framed and the
entrants had asked for frames on 73%, so the 68.5% headline is the two weighted by the units
each brings. A snapshot built before the forecast heads the card with the buyers' rate, says
"of paid prints", and the Slack table leaves its framing columns out.

**References, kept off the card.** The plan is the release's frame conversion (`frame_terms`:
the product's Airtable figure or the typed one, weighted over the products that frame, else the
panel default `frame_conversion` in `etl/benchmarks.json`); a release whose products have no
framing option has none. The benchmark is the basket's median frames per print, read from the
same feed over the members with at least 30 prints on offer (`framing_benchmark`; none when
fewer than three members qualify, since the feed starts at `BQ_SINCE`). On the September 2026
panel the draw launches run at 0.54 frames per print, the timed launches at 0.35 (which is where
the plan default came from), and the estate draws higher still (Mondrian 0.67, Warhol 0.67,
Dali 0.58, Murakami 0.55). Both stay in the snapshot's `framing` block, and the plan's uplift is
in the economics, but since 3 October 2026 the Framing card draws neither: it reads what is,
the headline, the two bars with their numbers and the units with no frame on offer, and
nothing on it is a target.

The snapshot's `framing` block (`framing_block`): `prints`, `frames`, `rate` (the paid
prints, the Buyers bar); `entrants` (`prints`, `frames`, `rate`, or null without entry
drafts); `plan`; `benchmark` (`rate`, `n` members rated, `of` members in the basket, or
null); `works[]` (per product with paid prints on offer: `name`, `prints`, `frames`, `rate`,
sorted by rate, the Buyers bar's hover); `notOffered` (`units` paid with no framing option,
and the `works`); `forecast` (`framing_forecast`: `today` and `close`, each `prints`,
`frames`, `rate` and `notOffered`, the units counted with no frame on offer, and `parts`,
the same prints and frames by kind of unit - `paid` (with the sales no work is named for),
`drafts`, `draw` and, at close, `future` - which add up to the totals and are the explainer's
working for the headline; and
`products[]`, per sell-through row with a frame on offer, `key` (the row's draw), `name`,
`today` and `close` as `prints`, `frames`, `rate`; null without the sell-through); `asOf`.
Null when nothing on the release has been offered a frame, and the card stays off the page.
A feed pulled before the framing columns existed reads as no framing. The forecast differs
between the Direct views at close (the entries still to come do), so it rides in
`variants.direct_spread` like the sell-through. The sell-through update posted to Slack
reads the forecast for its framing columns and the two bars' rates for its framing sentence
(§6.3), so the channel reads the card's figures.

---

## 7. Paid: in-flight model (the Paid Calculator, reproduced exactly)

Per release, daily grain. Spend actuals = Meta `spend` for `campaign_name` (ad-set key B2);
entry actuals = daily funnel `Draw_Entries_Eligible_Units` filtered to **channel = Paid Social**.

```
drop_off        = 0.2
cannibalisation = 0.2      # LE standard (spend rules); ignore per-tab cells showing 0 (issue 14)
CPE(window)     = spend / entries over the trailing 3 CALENDAR days (dashboard
                  headline + chart line; a window with spend and 0 entries shows
                  ROI 0 and an unknown CPE)
adjCPE(day)     = spend(day) / (entries(day) × (1 − drop_off))          # cost per expected-converting unit
ROI_party(day)  = (1 − cannibalisation) × profit_per_unit_party / (adjCPE × budget_share_party)
cum versions    = same on Σ spend / Σ entries
```
The paid block publishes the adjusted figures: `l3dCpe` (the last three full days), `l1dCpe`
(the last full day alone) and `cumCpe` (every full day) are spend over the entries that
become orders, entries × (1 − drop_off), so the cards label them per converting entry, 1.25×
plain spend per entry at 0.2.
Spend is Meta's, billed in euros: `load_spend` converts it once to euros at the fixed
`RATES_TO_EUR` rate (`SPEND_CURRENCY`, `spendCurrency` and `spendRate` on the paid block), so every
spend, cost per entry, budget and ROI figure on the page is euros. `cannibalisation` is the
release's own where the Target setting tab has one (`cannibalisation`, a fraction), else the
0.2 standard; the paid block publishes the figure in force.
`budget_share` = who pays for ads (AA/artist), e.g. 100/0 (Glenn Ligon), 33/66 (Jaume Plensa);
distinct from `profit_share`. `profit_per_unit_party` and `budget_share_party` are the
release's own, from the Target setting tab (§1.6): the products' figures weighted by their
target units, or the release-level `legacy_economics` while it stands; AA's profit per unit
includes the framing uplift.

Both parties are published. AA's reading is the paid block's `cumRoi`, `l3dRoi`, `l1dRoi`,
`daily[].roi`, `daily[].roi1`, `roiPath` and `budget.finalDayRoi`; the artist's is `paid.artist`
(`cumRoi`, `l3dRoi`, `l1dRoi`, `roiPath`, `roiDeclineModel`, `finalDayRoi`, `profitPerUnit`,
`budgetShare`) and `daily[].roiArtist`, `daily[].roiArtist1`: the same days and the same forward
path, with the artist's profit per unit over the artist's share of the spend (`1 −
aa_budget_share`). `l1dRoi` and `daily[].roi1` are the last full day alone on the same working, one
day's spend over that day's entries, `None` on a day with no spend and 0 on a day that spent and
bought nothing. On a deal where the artist carries no spend (a revenue share, `aa_budget_share` 1)
every artist figure is `None`: there is no artist ROI to read. The terms the figures are read with
sit on the block as `cannibalisation` and `dropOff`, so the Paid ROI card can show its working in
the ? popup. The card reads AA over the three-day window by default and has two switches, 3d / 1d
and AA / Artist (both kept per browser); in the 1d view the headline, the line and the ? working
read the last full day, and the dotted projection is the same cost path re-read from that day's
price (the path scaled by the ratio of the two readings on the last day, ROI being one over the
price). The spend recommendation, its ROI floor and the pacing rules stay AA's on the three-day
window.

**What the paid block publishes in units and days.** `unitsToDate` and `unitProjected` are the
paid group's secured units (§6.3½: units sold + 0.8 × unconverted entries, every paid channel),
the paid column of the channels card, so the Paid spend card's bar and that column are one
figure; `entriesToDate` and `entriesProjected` stay the paid campaign's draw entries, the
quantity the CPE and the ROI are priced on. At close, `spendProjectedTotal` is `spendToDate`
(today so far included) plus the last full day's spend over the full days after today and the
share of today still to come, up to the day the run rate stops (§5.4), and `entriesProjected` is
`entriesToDate` plus the entries that spend buys on the same days, so neither reads below its
figure to date. `stops` says where it stops: `sellout` and `roiFloor` (the day each would stop it,
ISO dates or null), `day` the first of the two and `rule` which; `ifContinued` carries the flat
run to the close beside it (`entriesProjected`, `unitProjected`, `spendProjectedTotal`), for the
card's hover; `atRecommended` the same projection at the recommended daily spend (`spend`), with
its own `stops` and `sellThrough` (`units`, `pct`: the sell-through at close with paid at that
spend and the organic channels as they are, placed by the sell-through's own rule), the figure the
Slack update's paid line prints. All three are null once the campaign is complete. `daily[]` runs over the full days the rules read;
on a live day the as-of day so far rides at the end as one more row marked `partial: true`
(its spend and entries, no ROI point), so the Paid ROI chart's bars sum to `spendToDate` and
the day's spend so far is drawn. `campaign_cost_terms` and the rolling ROI skip that row.

**Budget to sell out** (the sizing decision). The workbook nets off a manual
`organic_topup` estimate; the dashboard automates it with the shape-following
organic projection (§5.4), so paid is sized to top up only the gap organic is
not on course to fill:
```
secured_now       = units paid + draft orders + the draw's expected orders, work by work, capped at the edition   # the hero's secured units (§6.3½)
organic_future    = Σ over organic groups of (proj − now)       # §5.4 projection
sellout_gap       = max(edition_size − secured_now − organic_future, 0)
entries_needed    = sellout_gap / (1 − drop_off)                # every unit asked for as an entry at the rate
cpe(d, s)         = cpe_window × lift_window × (s / spend_window)^eps × ((K + C_d) / (K + C_window))^w ÷ lift(d)
                    # C_d = spent before day d at a flat s from today; lift(d) the close's; see the cost terms below
supply_spend      = s where Σ over the days left of s / cpe(d, s) = sellout_gap
budget_to_sellout = supply_spend × days_left
cpe_max           = (1 − cannibalisation) × profit_per_unit_AA / (roi_floor × budget_share_AA)
roi_spend         = s where cpe(close, s) = cpe_max            # at the close underneath its lift: the worst day
recommended       = min(supply_spend, roi_spend), then the pacing rules below
ROI_close_party   = (1 − cannibalisation) × profit_per_unit_party / (cpe(close, recommended) × budget_share_party)
```
`cpe_now` is the trailing-3-day adjusted CPE and `s_now` the last full day's spend;
`supply_spend` is the daily spend whose entries fill the gap by the close, `roi_spend` the one
whose ROI at close is the floor, and `eps` and `drift` are the campaign's own
(`campaign_cost_terms`, below). With `eps` 0, or no spend on the last full day, the price is
flat in spend: `supply_spend = sellout_gap × cpe_now / Σ_t (1 + drift)^−t`, and the floor
either never binds or stops the spend. The gap is priced in converting units at the adjusted
CPE, which is the same money as `entries_needed` at the raw cost per entry. `paid.budget` publishes `selloutGap`, `organicFuture`, `entriesNeeded`,
`supplySpend`, `budgetToSellOut`, `roiSpend`, `cpeNow`, `cpeAtClose`, `cpeAtRecommended`,
`driftToClose` and `finalDayRoi` (AA's; the artist's is `paid.artist.finalDayRoi`).
A launch pacing well ahead organically reads a recommendation of €0/day -
nothing extra is needed to secure sell-out, whatever the current ROI.

**Pacing rules** (v1 rules engine; target and thresholds):
- Target ROI (AA) = **1.1**: the Paid ROI card's target (`roiTarget`) and the forced-decrease
  test below. The floor the recommendation stops at is `roi_floor` **1.0**, on the ROI at close.
- Daily direction: cum-ROI < 0.9 → Decrease; 0.9–1.3 → Maintain; > 1.3 → Increase.
- Daily spend change capped at **±30%**; changes under 10% are ignored (0%).
- Downside protection: the trailing 3-day ROI (`daily[].roi`, the chart's line) below 1.1 on
  each of the last **3 full days → forced Decrease**.
- Cost per entry is not flat: it rises as the campaign's **spend adds up**, a little with the
  **day's budget**, and falls on the draw's **last two days** as the deadline pulls people in. One
  cost path (`CostPath` in `etl/build.py`) prices every future day, at a flat daily spend s, as
  `cpe_window × lift_window × (s / spend_window)^eps × ((K + spent before the day) / (K + spent at
  the window))^w ÷ lift(day)`: the trailing three days' price, paid at that window's daily spend
  and at its spend-weighted place on the clock, with the close's lift taken out of a window that
  fell in the last days (`lift_window`, its spend-weighted lift) and put on the path's own last
  days (`lift`, `cpe_close_lift`: ×1.53 on the close day, ×1.40 the day before). The clock counts
  every day the release's campaigns spent, ahead of the window included. The paid projection and
  the Paid ROI chart read the path at today's spend, the recommendation at its own, so a bigger
  budget wears the audience out faster. The ROI floor reads the price at the close underneath
  the lift (`cpeAtClose`, `finalDayRoi`, `wearToClose`), the path's worst day: the chart's line
  rises on the last days, the floor does not lean on them. The lift is the final days' own paid
  sign-ups entering at once, not credit deferred from earlier paid sign-ups (an entry is
  attributed to the channel of the session that signed the person up, and a draw started and not
  finished counts as signing up): at account level 87% of the final two days' paid entries signed
  up on those days, and 0.3% of the paid sign-ups who had not entered by then did so then
  (`etl/analysis/close_rush.py`, aggregates only); within a campaign a euro buys ×1.15 as many
  sign-ups on the close day and each is ×1.22 as likely to enter. `cpe_close_lift_applied`
  switches the lift off the path (the fit keeps it and `budget.closeLift` reads `[]`). The
  wear-out `w` and the elasticity `eps` are fitted from the campaign's own days once it has
  `cpe_fit_min_days` (8) with spend, as Poisson (`log E[entries] = a + (1 − eps) × log spend − w ×
  log(1 + spent before / K)`, the close's lift held at the panel's, the regression the panel
  priors come from, days with no entry included), then shrunk to the priors together through
  their joint covariance (`campaign_cost_terms`; published as `budget.elasticity`,
  `budget.wearout`, `budget.wearoutK`, `budget.spentSoFar`, `budget.wearToClose` and
  `budget.costTerms`, with the anchor as `budget.spendAtWindow`, `budget.spentAtWindow` and
  `budget.liftAtWindow` and the lift as `budget.closeLift`, so the path can be rebuilt from the
  block). A campaign that ramps its budget as it goes cannot tell a bigger day from more spend so
  far - Warhol's own days put the two at −0.8 correlation - and the joint shrink moves the pair
  towards the panel along the line its data cannot pin down. The priors are `cpe_wearout` 0.24 ±
  0.17, `cpe_wearout_k` €100, `cpe_spend_elasticity` 0.08 ± 0.08 and `cpe_close_lift` [1.53,
  1.40], from the 2026-09-28 fit on 42 Meta draw campaigns and 705 campaign-days up to the close
  (`etl/analysis/cpe_elasticity.py`; spend after a draw closed is left out): each doubling of
  spend so far makes an entry 18% dearer. It fits better than a straight drift a day (deviance
  1254 against 1294) and, cutting past campaigns at 40, 60 and 80% of their run, predicts the
  rest with a median miss of 42% and a bias of +2% (29 campaigns; without the close's lift 46%
  and −7%, −18% in the last fifth; the drift a day it replaced missed by 57% on 32). The drift a
  day (2.5%, and before it the workbook's 5 / 7 / 10% by third, kept in
  `cpe_daily_drift_by_third_workbook`) is retired.

This maps 1:1 onto the design's Paid module contract:
`roiDeclineModel = { start: today's actual ROI, dailyFactor }` (dailyFactor: the path's average fall a day,
`(1 / wearToClose)^(1 / days left)`; the card draws `roiPath` and uses the factor only for a snapshot without one);
`recommended = min(spend at ROI floor, spend at supply
cap)`, then paced by the rules above, and `cap` names what bound it: `supply` or `roi_floor` (the
lower of the two stood), `pacing` (the +30% a day ceiling when the band says increase),
`roi_band_hold`, `roi_band_decrease`, `forced_decrease`, `plan_rate` (no spend yet to price
from: the first day runs at the plan's daily rate), `zero_conversion` (the last day spent and
bought no entries: −30%), `zero_conversion_pause` (three such days: 0) or `hold_small_change` (a
move under 10%); `paced` marks a cut held to 30% a day. A floor no daily spend can meet (the
path's price at the close is past it however small the day, `roiSpend` 0) is cut towards the
same way, never stopped overnight; only a gap already filled stops paid at once (`supply`, 0). Supply cap = the budget-to-sell-out
logic (spending beyond it buys entries exceeding the units left); ROI floor = the spend at which
the ROI at close ends on `roi_floor` (1.0).

---

## 8. Email & social (funnel diagnostics layer)

### Email (HubSpot)
Send-level: `Email Name`, send datetime, `Campaign` (join key), Delivered, Opened, Clicked,
Unsubscribed. Name convention `DDMMYY_TYPE_Campaign - Description (variant)`;
types: `GEN` full-list broadcast, `CUS` segmented send (incl. `Early Access (LE) 1/2/3` tiers),
`INS` insiders/VIP, `TRNS` transactional post-purchase, `AUT` automated flows, `FREQ` frequency
tests. Launch playbook sequence: Announcement → Early Access (1/2/3 + Insiders) → Sustain /
Deepdive / Halfway / Clue n → Last Chance 48h → 24h → post-close surveys → TRNS production chain.
Reference rates for the funnel module: use the release's own campaign sends vs the historical
median for the same send type. ⚠ Bundle sends (`FREQ_LE_Bundle`) promote 2–3 releases and cannot
be attributed to one release.

**Whose sends, and graded against whom.** A release's email block counts the sends carrying its
campaign code from the day its window opens (§6.3), or from the day after an earlier launch by
the same artist closed when that is later: sends join by code alone, and an artist's launches
can carry one code between them (Zeng Fanzhi's July Rainbow sends were tagged with the LE's).
The reference rates (open, clicks per open, sessions per click) and the delivered fallback are
the medians of completed draw launches, read for each release **without its own sends and
without the launches that closed after it** (left out by id, name and campaign code): the email
form of "a release is never a member of its own benchmark" (§4a.2). A live release reads the
whole cohort, every launch in it having closed before today.

**The Direct switch leaves the email plan alone.** The sends the plan asks for are read on AA
Email's sessions as the funnel attributes them, and the Spread view's
`benchmarks.emailSessionsPerClickRef` carries the spread's share of the basket's email sessions,
so the chain still multiplies out to the plan's sessions and the sessions-per-click rung reads
spread against spread.

### Social content (Emplifi)
Post/story-level per platform (instagram 90%, twitter/X since 2025-08). Join via Labels →
campaign code. Useful metrics: impressions, reach, engagements (+ rates, verified =
engagements/impressions and /reach), saves (posts), story views/exits/taps/completion, video
views. Two owned profiles (Avant Arte ~2.9M followers; Avant Insiders ~74k) - normalise
per-1000-followers separately. Funnel-module rungs "Posts" and "Sessions/post" = count of posts
for the campaign in the window; sessions from the funnel feed ÷ posts.
The export is regenerated by hand, so a count from it says how far it reaches
(`social_block`): `social.postsThrough` is the export's last day, `postsEndsFirst` that it
stops before the release's window (the AA Meta Posts rung then shows a dash, not a zero) and
`postsPartial` that it stops inside it (the rung reads "Posts to 13 Aug"). A count from the
Notion log is read live and carries neither (`postsThrough` null).

---

## 9. Dashboard metric map (module → formula)

Per the design handoff (README + artboards; the mock's reconciliation rules are requirements):

| Module | Number | Formula (this doc) |
|---|---|---|
| Hero "Entries vs targets" | to date | Σ channels cumulative eligible entries (LE currency) |
| | expected today | Σ channels `target_total × curve(pdsa_today)` (§5) |
| | delta | actual − expected (must equal Σ channel gaps = Σ funnel contributions); printed as a share of expected, the units on hover |
| | projected at close | §5.4: organic follows the channel's historic shape curve scaled by demonstrated performance; paid = projected spend ÷ projected efficiency. Stored on the day's snapshot (never re-derived client-side) |
| | target | §3 channel targets summed |
| Sidebar status | on-pace % | `heroDelta / expectedToday(total)` |
| Trajectory | plan line | per-channel plan curve × target (§5) |
| | actual line | daily cumulative actuals |
| | projection | linear from today's actual to projected-at-close |
| Channels vs targets | per group | now / expected / projected / target per display group (§1.3) |
| Funnel by channel | rungs | email: Delivered/Open/Click vs reference; social: posts, sessions/post; all: session → sale (units secured per session; session → buyer where units per buyer differ from the plan's) vs benchmark (§4B), the rate the Organic funnel's low rung reads for the four organic channels together; paid: spend & cost/entry vs plan |
| | contribution | units vs expected, repriced one-at-a-time; per-channel contributions sum to that channel's gap |
| Key drivers | top movers | rank funnel steps by |contribution|, Adding vs Costing |
| Paid ROI | series | §7 daily ROI (AA); decline model start = today's ROI |
| Paid spend/day | recommended | §7: min(ROI-floor spend, supply-cap spend), paced by the spend rules, `cap` naming the rule that bound it; Implement → append-only decision log |
| Sell-through by product | rows | §6.3: per product sold / entries in hand allocated by the maximum-quantity rule × the entry → order rate / (at close) units still to come, against the product's edition; no target or benchmark drawn |
| Entries by country | top 5 | geo split of entries (requires country dim in the daily feed - **currently missing; needs adding to the BigQuery export**) |
| Framing | buyers, entrants | §6.4: frames per print on the prints a frame was on offer for, paid orders and the app's pre-authorisation drafts; no plan or benchmark on the card |
| Projection vs target | waterfall | stored model outputs: Organic traffic / Organic conversion / Paid spend / Paid efficiency contributions summing exactly to projection − target |

Every figure in the table can explain itself: shift-click it on the page and the explainer
panel gives the working in plain words, with the page's own numbers, and the sources behind it
(`web/src/explain/explanations.mjs`; README "How a number is worked out"). The builders read the
same snapshot fields as the cards, and `tests/explain.mjs` holds them to the figures printed.
The Framing headline's working reads `framing.forecast.{today,close}.parts` (§6.4).

LE benchmark fields carried on the release document: `chargeDropOff = 0.2`,
`signupToOrderRate` (TL), `firstChoiceWinRate` / `steeredBackupWinRate` (from draw allocation
data), `reOfferRecovery`.

---

## 10. Proposed warehouse shape (for the production build)

```
dim_release(release_name PK, campaign_code, type LE|TL, artist, announce_date,
            private_room_open, launch_end, campaign_length_days, edition_size, unit_price,
            economics…, benchmark_basket, channels_off, cost_per_purchase, cannibalisation)
dim_product(release_name FK, product_name, edition)
fact_funnel_daily(release_name, channel, event_date, sessions, page_views, draw_entries,
            eligible_entry_units, eligible_units_no_conv, units_total, units_by_route…,
            campaign_stage, dsa, dul, pdsa, pdul)         -- sum over source fan-out on load
fact_spend_daily(campaign_name, spend_date, spend, impressions, reach, link_clicks)
fact_email_sends(campaign_code, send_ts, email_type, description, delivered, opened, clicked, unsub)
fact_content(campaign_code, platform, content_type, published_ts, impressions, reach,
            engagements, saves, story_metrics…)
fact_draw_entries(draw_id, release_name, account_hash, tier, score, products[], max_quantity,
            wanted_units, framed, preorder, winner, claimed, eligible)   -- PII stripped
bench_channel(metric, channel, low, medium, high, n, as_of)              -- recomputed nightly
curve_trajectory(metric, channel_group|all, pdsa_decile, median, p25, p75, n, as_of)
snap_release_day(release_name, date, targets…, expected_today…, projections…, paid_reco…,
            waterfall contributions…)                     -- the document the UI reads (§9)
```

The UI reads one `snap_release_day` document per release per day (matches the design's "one
store per release, fetched per release+day"; projections are stored, not client-derived).

## 10a. Snapshot fields for the benchmark model

Every field here is **additive** (spec §5). A consumer that does not know them renders exactly as
it did before. `snap.benchmark` is the guard every benchmark mark on the page is written
against; since the lever model was retired every targeted snapshot carries it, and an
actuals-only page omits it.

| Field | What it holds |
|---|---|
| `targetingMode` | always `"benchmark"` since 2026-09-23 (§3); kept so older readers of the field still resolve |
| `upcoming`, `airtable` | `true` on a launch listed from Airtable before the funnel carries it (§1.7), with `airtable` holding its release code, record ids, works, edition, price and project status |
| `untracked` | `{entries: {share, count, total}, units: {...}, normal: {recentMonths, entries: {median, p90, n}, units: {...}}, high: [...]}` - the untracked share of the window against what is normal (§1.3); the Target setting tab warns when `high` names a metric |
| `directShare` | `{sessions, entries, units}` - Direct's share of the window as the funnel attributes it (§1.3) |
| `variants.direct_spread` | the top-level blocks that differ when Direct is spread over the other channels (`channels`, `funnelByGroup`, `paid`, `targets`, `groupTargets`, `waterfall`, `benchmark`, ...); the Overview's Direct switch lays them over the page (§1.3) |
| `benchmark.basket` | `{id, kind, name, n, thin, suggestedId}`; `kind` is `ready`, `bespoke` or `saved` |
| `benchmark.units`, `unitsP25`, `unitsP75`, `unitsSold`, `nShort` | the basket's median units of demand (§4a.2) and its middle half, the median sales beside it, and how many members sold out short |
| `benchmark.sessions`, `entries`, `campaignDays` | the other headline medians of the profile |
| `benchmark.k` | the even uplift K |
| `benchmark.stretchUnits`, `stretchPct` | `target − benchmark` in units, and `K − 1` |
| `asOf`, `completeThrough`, `asOfFraction` | the newest day in the feed (today, part-observed, while the feed is live), the last full day, and the share of the as-of day seen (1 on a full day and once the window has closed). The actuals run through `asOf`; the paid pacing rules, the run rates and `complete` read `completeThrough`; every reference by today is read at the share, so the page compares the day so far with the same share of the basket's day |
| `builtAt` | when the page was written (UTC, `write_page`): the header reads it beside `asOf`, so a page's age is its own and not the refresh's. A page that fails to build keeps its previous file and its previous index row (`guard_page`, README "One page's failure never stops the build"), and its `builtAt` says so |
| `benchmark.unitsByGroup`, `sessionsByGroup`, `convByGroup` | the per-group medians. The conversion held is `unitsByGroup / sessionsByGroup` (session → unit), the rate `funnelByGroup.conv_benchmark` carries and the Target setting tab's `Session → unit (held)` column shows; `convByGroup` is the basket's median session → eligible entry rate (`conv_sess_entry`), descriptive only - no target is read from it |
| `benchmark.paidBudget` | benchmark paid units × the cost per purchase in force: the basket's own budget, unscaled, the same figure as `paid.benchmarkBudget`. The target's budget, × K, is `targets.paid.budget` (§4a.3) |
| `benchmark.costPerPurchase`, `costPerPurchaseN` | the basket's median cost per paid unit (0 when fewer than three members have a reading, and the panel constant prices the budget; 6 dp, the precision the Target setting tab prices the budget at) and the members with one (§4 E) |
| `targets.paid.cost_per_purchase`, `cost_per_purchase_source` | the price a paid unit is planned at and where it came from: `release`, `basket` or `panel` |
| `benchmark.channelsOff` | the display groups this release set aside (BENCHMARK_SPEC §4.3); their medians are zero above and the other channels carry the target |
| `benchmark.unitsAll`, `unitsSoldAll`, `sessionsAll`, `entriesAll`, `unitsP25All`, `unitsP75All`, `unitsByGroupAll`, `sessionsByGroupAll`, `convByGroupAll` | the basket's full medians before any channel was set aside, so the page can say what left and the browser can re-read the basket as the switches move; at the build's precision (6 dp, as `costPerPurchase`), so the Target setting tab rebuilds `targets.paid.budget` and `paidBudget` to the cent with nothing edited |
| `benchmark.privateRoomShare` | the basket's median private-room share of email units - descriptive; nothing derives a target from it since the split went (§3) |
| `hero.benchmark`, `benchmarkToday`, `stretch` | benchmark at close, benchmark pace to today, the stretch; the benchmarks in whole units rounded from their one-decimal figure a half away from zero, as the page prints `benchmark.units` (132.5 is 133), and the stretch the printed target less the printed benchmark; `waterfall.benchmark` and `today.benchmark` are the same figures |
| `channels[].bm`, `bmExp` | per group: benchmark at close, benchmark by today |
| `channels[].daily[].bm` | the benchmark plan for that day, beside `actual` / `plan` / `proj` |
| `funnelByGroup[g].sessions_benchmark`, `conv_benchmark` | the basket's sessions by today (the sessions rung's reference) and its conversion at close (the conversion rung's fallback on a snapshot without `conv_benchmark_today`) |
| `funnelByGroup[g].conv_benchmark_today`, `contrib_traffic_bm`, `contrib_conversion_bm`, `contrib_buyers_bm`, `contrib_per_buyer_bm` | the same three-factor decomposition against the basket's pace by today, summing to the group's actual − its benchmark today; the waterfalls' walk from the benchmark, and the conversion rungs' reference (Funnel by channel, Organic funnel), so a rung and the step beside it read the same figure |
| `email.deliveredTarget`, `deliveredBenchmark` | the sends the plan's and the basket's AA Email sessions by today imply at the cohort's open rate, clicks per open and sessions per click (`benchmarks.emailSessionsPerClickRef`); the cohort's median send on the delivery-timing curve until two launches give a sessions-per-click median. Read on the sessions as the funnel attributes them, so the same in both Direct views (§8) |
| `sellthrough.benchmarkUnits` | the benchmark on the sell-through prediction |
| `sellthrough.conversion`, `inHandUnits` | the entry → order rate the prediction runs at, and the entries in hand before it (§6.3) |
| `sellthrough.products[]` | per product: `key`, `name`, `draws`, `edition`, `sold`, `drafts`, `entrants`, `inHand.{open, won}`, `allocated`, `pinned`, `fixed`, `flexible`, `predicted`, `shown`, `room`, `oversubscribed`, `futurePredicted`, `pct`, `pctClose`, `expectedToday`, `benchmarkToday`, `benchmarkClose` (§6.3) |
| `sellthrough.attributedSold`, `unattributedSold`, `soldSource` | sold units the draw feed named a product for, the rest, and whether products' sales came from tagged purchases or from winners who bought |
| `sellthrough.drafts`, `unitsPaidOrders`, `ordersAsOf`, `incomplete` | orders awaiting payment and units paid across the release from the orders feed (over the window when `unitsSource` is `orders`, then equal to `sold`), the last order or draft day they run to (absent without the feed), and what the card is still waiting on: the list behind its Incomplete data stamp (§6.3) |
| `unitsSource`, `salesWindow` | `orders` or `funnel`: where the page's units sold came from; `{start, end, closed, firstPaid}`: the days every card counts sales over, whether the window has shut (close + 2 days), and the first paid order inside the 45-day floor (§6.3). Every targeted page this build writes carries both, so `check_snapshot` warns of one without them (a page from an older ETL), and of a shut window whose sell-through still counts drafts, draw winners, entries in hand or to come, or entry patterns (`stale_build_warnings`: printed, never a stop; `tests/test_committed_snapshots.py` runs the checks over the committed pages) |
| `sellthrough.unitsOutsideWindow` | `{before, after, pending}`: units paid before the window opened and after it shut, counted on no card, and units paid after the as-of day while it is open, which count on the next build (present when `unitsSource` is `orders`) |
| `untracked.noEvent` | `{count, total, share, high}`: the window's paid units with no purchase event, which count on Untracked; `high` shows the banner (§1.3) |
| `framing` | `{prints, frames, rate, entrants: {prints, frames, rate} or null, plan, benchmark: {rate, n, of} or null, works: [...], notOffered: {units, works}, asOf}` - frames per print for the Framing card (§6.4); null when nothing on the release has been offered a frame |
| `slack` | added by the server when it serves the snapshot, not by the ETL: `{channel, updatedAt, updatedBy, lastPostAt, lastPostBy}` from `data/slack.json`, or null. The sell-through card's Post to Slack button posts to `channel`; the Target setting tab sets it (`server/slack.js`) |
| `sellthrough.ordersByProduct`, `drawProducts`, `soldSource` | the orders feed for the release (per product title: units paid, drafts, list price, edition) and the product each draw sold, carried so a save re-runs the rule on the server; which rule the sold figures came from (§6.3) |
| `sellthrough.allocation`, `measure`, `editionSum`, `editionMismatch`, `allocationStarted` | the rule's bookkeeping, whether fill is over editions or in units, the typed editions' sum against the release's, and whether winners have been drawn |
| `sellthrough.draws`, `patterns` | the draw feed as reduced by `products_file`, so a save re-runs the rule on the server without the feed |
| `paid.benchmarkUnits`, `benchmarkBudget` | the paid module's two benchmark marks |
| `waterfall.benchmark`, `stretch`, `target`, `projection` | the at-close waterfall's left-hand columns; `steps` are unchanged and `stepsBm` are the same four contributors against the basket, summing to `projection − benchmark` |
| `waterfall.closeScale`, `closeScaleBm` | the factor the at-close `steps` (`stepsBm`) are the steps to date times; null where they are copied (a closed release) or where the rest of the gap is shared out by size (below) |
| `waterfall.today` | `{benchmark, stretch, target, actual, steps, stepsBm}` - the same four contributors measured **to date**, against the target and against the basket |

`waterfall.today.steps` are not the close steps scaled down: they are the contributions as
measured so far, and they must sum exactly to `actual − target`, with the rounding residual
parked on the largest step, exactly as the close steps do (§9, "Projection vs target");
`stepsBm` the same against `benchmark`, which is the walk the cards draw once the stretch has
been set aside.
At close, a release that has closed has nothing left to project, so its `steps` and `stepsBm`
are its steps to date, copied. A live release's are its steps to date scaled by one factor,
the close gap over the to-date gap, both unrounded (`closeScale`, `closeScaleBm`); where the
to-date gap is under half a unit, or the factor is negative or above 3, a factor would turn
rounding into bars or flip every sign, so the part of the gap still to come is shared over
the steps to date in proportion to their size instead (the same walk as the factor's when they
all point one way).
`hero.benchmarkToday` and `channels[].bmExp` are read off the basket curve at today's pdsa
(§5.3), which is what keeps the K identity of §4a.4 true today as well as at close.

---

## 11. Data-quality register (found during reverse-engineering; fix upstream)

Benchmark-panel integrity:
1. Release Selection's pre-2024 exclusion rule is only partially applied - 21 pre-2024 releases
   still leak into every benchmark; the undersubscription screen (oversubscription ≤ 10 → exclude)
   is #REF!-broken beyond release #73, and the 51 releases it flagged are still in the panel.
2. "Medium" is MEDIAN in some tables and AVERAGE in others (and in two totals rows of the
   session-conv table only); averages make Medium > High for AA X / Referral X page-view conv.
3. The email-only conversion benchmark's range covers only the first 73 alphabetical releases.
4. CPP benchmark = quartiles over 22 hand-curated rows mixing LE and TL, hardcoded to rows
   10–42 - newly appended campaigns never enter it.
5. Survivorship: all per-release ratios blank out zeros before quartiling.

Pipeline integrity:
6. LE daily accumulator truncated at exactly 100k rows (data before 2025-12-20 already lost);
   `Across time.csv` is a 50k-row export cut mid-date. **Fixed** where a BigQuery key is set -
   the feed reads the tables directly (§2); unset, the sheet cap still applies.
7. `Maurizio Cattelan · Window · 2026 Q1` has launch < announcement (negative campaign length) -
   fix the campaign-dates table.
8. 58% of daily rows are `Missing campaign dates` (back catalog without announcement dates).
9. `campaign_id` in Meta exports mangled to float - join on campaign_name.
10. Campaign Mapping sheet's static columns are misaligned against a live UNIQUE spill - do not
    use; the reliable link is each release's (release_name, campaign_name) pair.
11. `untracked` vs `Untracked` case; header typos (`Eligable`, `reachs`).

Model bugs found in the sheet (the rebuild should implement the *intent*):
12. "Spend for tomorrow" is clamped to €2 (`min(spend, 2.0)` where 2.0 is a per-unit step;
    open comment "should this be 669?"). Intended cap: ±30%/max-increase rules.
13. ROI shows positive with 0 entries (division fallback) - rebuild should show 0/–.
14. Template's cannibalisation cell reference is broken (G90 → empty cell); live value 0.2.
15. Paid Performance box keys off a hand-typed "Today's date" that goes stale.
16. AA Other silently missing from chart groupings; template tab is a filled copy of
    GlennLigon_LE_26 (double-counting hazard when aggregating tabs).
17. Cannibalisation is 0.2 in LE/calculators but 0.1 in the TL historical panel - pick one per
    release type and record it on the release document.
18. JaumePlen paid tab sizes budget on edition 300 but profits on edition 100.
19. Two generations of entry-counting in paid trackers (eligible units vs total units) - CPE not
    comparable across generations; standardise on `Draw_Entries_Eligible_Units`.
20. Draw entry exports: `Opportunity Cost` goes stale after entry edits - recompute, don't trust.
21. Campaign-code middle segments are free text, not release types: the content feed tags
    Andy Warhol Estate's 2026 Q3 LE as `AndyWarhol_TL_26`. Never infer LE/TL from a code.
22. `LE_Funnel_Report.processing_error` is free text that quotes the entrant's email address in
    2,074 draw-entry rows; treat every free-text column of that table as potentially carrying
    personal data and take flags, not text (§2.1).
23. The export's `Draw_Entry_Eligible` counts eligible entrants *left without an allocation*, not
    eligible entrants, and shrinks as winners are allocated; `Collectors_Eligible_Entries` is the
    people count and `Draw_Entries_Eligible_Units` the units (§2.2). Check which column the
    workbook's eligible-entry benchmarks read.
24. Airtable's Announce Date is 2025-04-17 on 41 launch records of 2023-24 (launch dates
    2023-12-07..2024-09-18), a bulk fill later than every one of those launches, and it flows
    into the LE Funnel Report's campaign clock (`announcement_date`, `days_since_announcement`)
    for 29 releases. The ETL treats an announce on or after its own close as absent (§1.5).
    Fix upstream: clear or correct the field on those records, and have the report's clock
    ignore an announcement date later than the launch date.

---

## 11a. Paid recommendation: elastic price and the pacing rules

Since 2026-09-28 the forward price runs on the campaign's spend so far (§7): the time drift
described below is retired, and `cpe_spend_elasticity`, refitted beside the wear-out, is 0.09.
What follows is how the recommendation came to be priced at all.

`cpe_spend_elasticity` (0.38 ± 0.19 at the time) was the panel's prior for the within-campaign
elasticity of cost per entry to daily spend, fitted with campaign fixed effects and a calendar-day
drift term on the 29 campaigns and 433 campaign-days where daily Meta spend joins to daily paid
entries (`etl/analysis/cpe_elasticity.py`, 2026-09-23; the first fit, on 13 campaigns and 170
days on 2026-09-07, gave 0.38 as well). Each campaign's own elasticity and drift were fitted from
its days and shrunk to the priors by precision. Before the
elasticity was modelled, the recommendation priced every extra entry at today's cost per
entry and the ROI floor could never bind (flat price → ROI independent of spend), so a
release a long way from sell-out was told to multiply its daily budget fifty-fold. The
workbook's pacing rules (`spend_rules`: ±30%/day, the 0.9/1.3 cumulative-ROI bands, the
10% dead band, the forced decrease) had been transcribed and documented but never
applied; they are now. The old formula also multiplied eligible entries (grossed up for
drop-off) by the per-converting-unit price (also grossed up), overstating sell-out spend
by ~20%.

Reconciling the chart and the recommendation: the Paid ROI chart's dashed line and the
budget recommendation's ROI floor now share one forward cost path (today's price × spend
elasticity × daily drift, compounded). Two workbook figures described that future - the
5/7/10% daily tiers (LE template row 206, "Expected daily increase") and a flat 1.5× forecast
cost per entry - and the code used one for the chart and the other for the floor, so the
projection could head under 1 while the floor passed. The daily tiers are the cost rise along
the workbook's own spend path (row 229 ramps 6-10% a day; at elasticity 0.38 that is 3.5-5%
a day of cost rise on its own), so with elasticity modelled they double count; applied
consistently they told a campaign at cumulative ROI 3.5 to cut. `spend_rules.
cpe_daily_drift_by_third` then became the prior for the pure time effect: 0.5% a day from the first
fit (0.36 ± 1.12 on 13 campaigns), then 2.5% a day ± 3.5 from the 2026-09-23 fit on 29, each
campaign's own fitted drift shrunk to it and clamped to 0-10% a day, until the spend-so-far curve
replaced it on 2026-09-28; the workbook values sit in `cpe_daily_drift_by_third_workbook`. The
workbook's own template, note, produces the same
runaway "expected daily spend" the first version of this card did (Warhol_LE_26 row 229:
€181k-256k a day; Dali_LE_26 row 231 suggests €3.7k-10.9k a day against €1.5k spent) and
tames it with a "max increase per day 2.0" rule rather than a price that responds to spend.

Provenance of `spend_rules`, corrected: the 0.9 / 1.3 bands, the 30% cap and the 10% dead
band are the TL_Template's "ROI / SPEND RULES - DO NOT CHANGE" block (rows 416-428), not the
LE template's. The LE template's SPEND RULES (rows 284-299) read: decrease -0.1, increase
0.1, max increase per day 2.0, target ROI AA 1.1, at zero conversion decrease by 0.3, three
days of zero conversion decrease by 1.0, and "Expected Increase in Spend (%)" 0.05 / 0.07 /
0.10 by third (row 299), which row 206 "Expected daily increase" reads as the daily growth of
"Cost per unit (forecast)" (row 207). No derivation for any of these appears in the workbook.
The zero-conversion rules are now applied (`zero_conversion_decrease`,
`zero_conversion_days_to_pause`); the LE block is recorded under `le_template_rules`.

## 11b. Release discovery (every release is navigable)

The build enumerates every `simple_release_name` in the funnel data and derives a record
per release (`discover_releases`): id (slug of the name), artist / title / quarter (the name
is always `Artist · Title · YYYY Qn`), dates from the campaign clock (§1.5), a campaign code,
and traffic totals. The code is the one the release's orders carry, else its matched Airtable
launch's, taken when exactly one code the sends, posts, inputs or Meta names use is that code
and in their spelling (`source_campaign_codes`, `code_source` `orders` or `airtable`, on the
page as `derived.campaign_code_source`, which the No targets card prints); a code
the orders give several releases, or a launch several releases matched, is a group show's and
nobody's (`Multiple_Amphorae_24`). Only then is it guessed from the email and content feeds
(`guess_code`, `code_source` `guess`), which rejects a code carrying the planning year
(`JeffKoons_LE_25` on a 2026 Q1 launch) or a stub that is not the artist's name: 24 pages had
no code while their orders named it (EUR 121,761 of draw spend and 1.38m emails delivered on
no page, September 2026). A guess that names another code than the orders stays and the build
says so (Eddie Martinez's Scaffold sends are `EDDIE_SCAFFOLD_24`, its orders and Meta
`EddieMart_Scaffold_24`), and the build warns of a Meta draw campaign the orders tie to one
release on file that no page claims (`unclaimed_draw_campaigns`). The name is the export's own
and the join key, so its quarter stands even where the campaign closes in another; the build
prints that and keeps it as the release's `dates_note` ("the name says 2027 Q1, but the
campaign closes 2026-10-15 (2026 Q4)"), for the name to be corrected upstream, and the
sidebar's tooltip shows the quarter it closes in beside the name's. Every sidebar row, a
targeted one too, carries the quarter, the sessions in its window and the last day it was
seen. Releases with target inputs on
file take the full build (§5-§9); the rest take an actuals-only build (`build_actuals`) that
emits the same snapshot shape with every target-derived field `null` and `targeted: false`.

Date derivation, checked against the eight hand-entered releases: announce from rows with
`days_since_announcement >= 0` (exact, 7/7), campaign length `L = dsa / pdsa` from the pct
column (exact, 7/7), close = announce + L. The countdown-derived close (`event +
days_until_launch`) runs a day early for some releases and is used only to anchor a release
seen before its announce, where the reconstruction can be a day out. A window outside
3..90 days is rejected (one upstream release reads 106 days; another has a close before its
announce). A release with no clock at all is *catalogue*: still drawing traffic, no campaign
window - 320 of the 353 names in the sheet-capped export, median 24 sessions over four
months, versus a median of ~9,000 for the 33 that carry the clock.

The server's JavaScript retarget (`server/retarget.js` + `shared/targetModel.mjs`), which
used to rewrite a snapshot in the browser's model on save and differed from the Python build
by ~0.05 units on per-day projections, went with the lever model (§3): every save rebuilds
the release with the Python ETL, so there is one implementation.

## 11c. Benchmark model: decisions taken, and why

The four that were live arguments, recorded so they are not relitigated from the drawing alone.

24. **The benchmark is a single median, never a band.** The basket's p25-p75 exists and is
    shown - in the picker, and as `unitsP25` / `unitsP75` on the snapshot - but it is a
    description of the basket, not a reference line. §5.2's guardrail band was the right shape
    for "is this release pacing normally?"; it is the wrong shape for "did we hit the number",
    because a band gives a launch two answers and lets the reader pick. One fill for the target,
    one dotted outline for the benchmark, and the actual in front of both.
25. **The stretch is one even uplift unless placed, with conversion rates held either way.**
    Since 29 September 2026 the Target setting tab can say where the stretch comes from (§4a.3,
    `stretch_from`): each group's target is then its benchmark plus its share, its sessions and
    entries at its own uplift, and the paid budget follows the paid units. With nothing typed
    the shares are the basket's own, which is the even uplift below. K multiplies every volume in
    every channel on every day; no channel is asked to convert better than the basket did. The
    alternative - spreading the uplift by channel, or buying part of it with a conversion
    assumption - is exactly the quartile-lever model, retired on 2026-09-23 (§3): the one
    channel-level choice that remains is whether a channel is in plan at all
    (BENCHMARK_SPEC §4.3). Keeping
    rates at the benchmark is also what puts the funnel rungs' benchmark tick (§4a.1, spec §7)
    1/K off the centre on a volume rung - target is benchmark × K - and on the centre line on a
    rate rung: there the two references are the same figure, and the two readings are the same
    statement.
26. **A release is never in its own basket.** Self-inclusion is how a benchmark quietly becomes
    a mirror: on a 4-member cluster a launch would set about a quarter of the number it is
    graded against, and a bad launch would lower its own bar as it went. Enforced in
    `etl/baskets.py` for every basket kind, ready-made, bespoke and saved, and validated on the
    API (a `members` list containing this release is a 400, not a silent drop).
27. **Paid ROI carries no reference lines and no horizon.** ROI is a ratio against a floor of
    1.1 (§7), not a volume that scales with K, so a benchmark line there would invite the
    reading "ROI should be K times the basket's", which is false. The card is unchanged: its
    only reference is the ROI floor it always had.

---

## 12. Open items (need product/user decisions)

- **Country dimension** for "Entries by country": not present in any current feed; add
  geo to the BigQuery funnel export.
- **Per-channel trajectory curves** stabilise as clean completed releases accrue (currently 18);
  until n is sufficient per channel, fall back to the all-channel curve.
- Whether the "Paid" display channel is a separate lens vs AA Meta (design mock conflates them;
  data model keeps Paid Social separate - recommended).
- Draw-entry exports are point-in-time; a post-draw export (winners/claims populated) is needed
  to measure the 0.8 drop-off and win/claim rates for real.
