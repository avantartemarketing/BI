# Avant Arte Launch BI - Data Model (v1, LE-first)

This document specifies how every number and target on the Launch Performance dashboard is
calculated. It is the result of reverse-engineering the current tooling:

- **LAUNCH PERFORMANCE OVERVIEW** (Google Sheet snapshot) - the per-release target model + actuals
- **LE Paid Calculator** - the in-flight paid-spend decision tool
- **`Across time.csv`** - the new daily funnel export with campaign-clock columns (the across-time
  target enabler)
- **Draw entry exports** (`draw_…entries_N.csv`) - per-entrant demand data
- **All Sent Emails** (Klaviyo export) and **All editions content** (Emplifi export) - channel
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
  = 1,465.29 + 0.35 × 94 = **1,498.19**

Global constants (from the workbook's "PROFIT CALC - DO NOT CHANGE" block):
`frame_conversion = 0.35`, `frame_profit = £94/unit`, `cannibalisation = 0.2`
(the LE standard per the spend rules. The 2026-08-28 tab revision left several
per-release cannibalisation cells reading 0 via the broken template reference
(issue 14, §11) - those cells are display artefacts, not the constant. The TL
historical panel still shows 0.10.)

Paid budget share (who funds the ads; distinct from profit share): the workbook's
"Artist budget share (%) / AA budget share (%)" rows where present - Glenn Ligon
is overridden to 100% AA ("he's not sharing paid budget"). Model input
`aa_budget_share` (optional per release); default 100% AA when
`artist_profit_share = 0` (commission / rev-share deals), else 50/50.

### 1.2 Campaign code (cross-system join key)
`campaign_code` (e.g. `GlennLigon_LE_26`) joins the release to:
- **Meta ads**: `campaign_name = '{code} · Enter draw'` in `meta_ads_insights` (campaign_id has
  lost float precision in the export - join on name only).
- **Email**: Klaviyo `Campaign` column equals the code exactly (join `Campaign == campaign_code`,
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

---

## 2. Source feeds

All funnel data originates in BigQuery `avantarte-data-production.AA_company_tables`:

| Feed | Grain | Key columns | Used for |
|---|---|---|---|
| `le_funnel_report_split_touch_export` | channel × event_date × release | 29 metrics + 5 campaign-clock cols | daily actuals, across-time curves |
| LE funnel lifetime rollup (importrange "Export!A:AB") | channel × release | sessions (D), Total Product Units (S), eligible entries (M/N/Y), units by route (O/P/Q/R), page views (AA), entries (V/W/X/Z/AB) | launch-total actuals, benchmarks |
| `tl_funnel_report_split_touch_export` (+ lifetime) | same, TL metrics (subs) | sessions, subs, customers, units by sub | TL side |
| `order_type_by_release_export` | release × order_date | total_orders, originated_from_drafts, pending_draft, units | draft-order (private room) tracking |
| `meta_ads_insights_export` | campaign × spend_date | impressions, reach, link_clicks, **spend** | paid spend actuals |
| Meta lifetime ("Meta Data for Paid") | campaign | + 7d-click conversions (Purchases, Enter Draw…) | Meta-side attribution |
| Klaviyo email export | email send | Delivered, Opened, Clicked, Unsubscribed | email funnel rungs |
| Emplifi content export | post/story | impressions, reach, engagements, saves, story metrics | social funnel rungs |
| Draw entries export | entrant × draw | tier, score, products, MaxQuantity, winner/claim flags | demand, allocation, sell-through prediction |

**The dashboard should read the BigQuery tables directly** (the sheet pipeline's accumulator tabs
are already silently truncating: the LE daily tab is capped at exactly 100k rows and has lost
everything before 2025-12-20; `Across time.csv` is a 50k-row export cut mid-date at 2026-05-04).

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

**Allocation rule** (as practised): winners are allocated to maximise sell-through across
products - an entrant who entered N products but wants M < N is awarded the M **least-demanded**
products among those they entered, draw weighted by `Score`. Equivalent to capacitated matching;
`Σ Opportunity Cost` measures the flexibility available.

---

## 3. The LE target model (set at launch planning)

This reproduces the LE_Template TARGET SETTING block exactly. All benchmarks are quartiles of
the historical release panel (§4).

### Step 1 - split edition into paid vs organic
```
paid_pct      = benchmark("paid share of units", size_pick)      # Low .0789 / Medium .2619 / High .3901
paid_units    = round(edition_size × paid_pct)
organic_units = edition_size − paid_units
```
`size_pick` ("Paid channel size" Small→Low / Medium / Large→High) is a per-release judgement call.
Live releases use Medium (Glenn Ligon, Schnabel) or High (Dali, Mondrian, Zeng Fanzhi, Parra,
James Jean, Abdulnasser).

### Step 2 - split organic into Draw/Pre-order vs Private-Room/Other
```
pr_other_pct = benchmark("PV+Other share of units", reference_point)   # Low .2879 / Medium .4667 / High .7115
pr_units     = organic_units × pr_other_pct
draw_units   = organic_units − pr_units
```
Every live release uses Medium (0.4667). Overridable per release (never used so far).

### Step 3 - channel targets for draw/pre-order purchases
Each of the 12 organic channels gets a **quality pick** (High/Medium/Low = which quartile of the
historical distribution to use; N/A = channel doesn't exist for this release, e.g. Referral
Artist for an estate). The default row used by every live release:
`AA Email Auto: High, AA Email Man: High, AA Meta: Medium, AA Other: Medium, AA X: Low,
Direct: Medium, Organic Search: Medium, Other: Medium, Referral Artist: Medium (N/A for estates,
High for hype artists), Referral Meta: Medium, Referral Other: N/A, Referral X: N/A`.

```
share(c)            = benchmark("order split", c, quality(c))          # §4 table A
order_split(c)      = share(c) / Σ share                               # renormalised over non-N/A channels
target_purchases(c) = draw_units × order_split(c)
```

### Step 4 - back out entries and sessions per channel
```
target_eligible_entries(c) = target_purchases(c) / 0.8            # 0.8 = eligible-entry → order rate ("1 − drop-off")
conv(c)                    = benchmark("session → eligible entry", c, quality(c))   # §4 table B
target_sessions(c)         = target_eligible_entries(c) / conv(c)
```

Private-room sessions are modelled separately, email-only:
`target_pr_sessions = pr_units / email_session_to_purchase` where
`email_session_to_purchase = 0.010727` (median AA Email Man session→purchase across the panel; v2 recompute).

### Step 5 - paid targets and budget
```
paid_eligible_entries = paid_units / 0.8
paid_conv             = benchmark("session → eligible entry", Paid Social, quality_pick)  # Medium = 0.0042099 on all live releases
target_paid_sessions  = paid_eligible_entries / paid_conv
cost_per_purchase     = CPP benchmark pick                        # Low 128.75 / Median 177 / High 291
paid_budget           = cost_per_purchase × paid_units
```
Sense check: `paid_budget / launch_value ≤ 6%` (flag only - 4 of 8 live releases breach it:
Dali & Mondrian 13.8%, Parra 10.6%, James Jean 9.9%).

### Step 6 - buffer
`target_inc_buffer = 0.75 × target` for any metric ("Target inc. buffer") - a 25% haircut used
as the amber line on charts.

### Worked example (Glenn Ligon · Multiple · 2026 Q3)
150 units → paid 39 (Medium 26.19%), organic 111 → PR/Other 51.8 (46.67%), draw 59.2 →
AA Email Man target purchases 26.2, entries 32.8, sessions 1,885 … total organic-draw sessions
3,953; PR sessions 4,558; paid sessions 11,580; budget = 177 × 39 = £6,903.

---

## 4. Benchmarks (how the reference numbers are computed)

Panel: all releases in the funnel import **not** marked excluded on `Release Selection`
(intended rule: exclude pre-2024 + manual exclusions; currently 142 included - see §11 for the
leaks). For each per-release ratio, zero values are blanked (survivorship: benchmark conditions
on the channel having converted at least once).

**"Quality"/"size" = which quartile you pick, not an attribute of the release:**
`Low = 25th percentile, Medium = median (order-split & session-conv tables) or mean (PV-conv and
EE→order tables - inconsistent, see §11), High = 75th percentile.`

Key benchmark values in force (LE):

**A. Order split by channel** (share of unadjusted draw+pre-order units; renormalised at use):

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

**B. Session → unique eligible entry** (unadjusted sessions denominator):

| Channel | Low | Medium | High |
|---|---|---|---|
| AA Email Auto | .0062 | .0474 | .3039 |
| AA Email Man | .0067 | .0105 | .0174 |
| AA Meta | .0093 | .0140 | .0258 |
| AA Other | .0396 | .0714 | .1607 |
| AA X | .0133 | .0247 | .0354 |
| Direct | .0090 | .0186 | .0301 |
| Organic Search | .0172 | .0306 | .0670 |
| Other | .0138 | .0172 | .0352 |
| Paid Social | .00163 | .00421 | .01213 |
| Referral Artist | .0060 | .0134 | .0238 |
| Referral Meta | .0072 | .0151 | .0357 |
| Referral Other | .0169 | .0322 | .0667 |
| Referral X | .0093 | .0302 | .0345 |

**C. Unit-mix quartiles** (share of adjusted total units): PV+Other = .2879 / .4667 / .7115;
Draws .1734/.3203/.6939; Preorder .0528/.4758/.6353.

**D. Eligible entry → order** ("drop-off" complement): benchmark table exists
(total .43/.66/.90, capped at 1) but the model **assumes a flat 0.8** everywhere (hardcoded).
Keep 0.8 as the planning constant; surface the per-channel table as diagnostics.

**E. Cost per purchase (paid)**: quartiles over 22 hand-curated historical paid campaigns
(mixing LE + TL): **Low £128.75 / Median £177 / High £291**. Companion stats (static): ROI
2.2/3.4/6.9, paid % of units .11/.21/.31.

**F. Email-only session → purchase** (private room divisor): median .010727 (v2).

Recomputation policy for the rebuild: recompute quartiles nightly from BigQuery over a
**correctly filtered panel** (year ≥ 2024, exclude undersubscribed: oversubscription ≤ 10 units,
exclude in-flight releases), using **median for every "Medium"**. Log benchmark drift vs the
frozen values above.

---

## 5. Targets across time (the new capability)

The sheet distributes nothing over days (its only daily notion is a run-rate: remaining units ÷
remaining days). The across-time columns enable proper **plan curves** - the design brief
requires `expectedToday(channel)` from "channel-shaped curves, never straight lines".

### 5.1 Method
1. Take completed, clean LE campaigns (campaign window fully observed, ≥ 20 draw entries;
   currently n = 18 from the export - grows over time).
2. For each, compute cumulative share of the campaign's final total at each pdsa, per metric
   (sessions, draw entries, units) - and per channel where volume allows.
3. Pool across releases on the pdsa axis: **median = the target trajectory; p25/p75 = guardrail
   band**.
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
  status vs plan should use the band, not the median alone, before shouting red.

### 5.3 Per-channel curves
Email is spike-driven (sends), socials are post-driven, search/direct is smooth. v1 ships:
pooled per-display-group curves where n permits, else the all-channel curve. The email plan
curve should eventually be derived from the **planned send schedule** (Announcement, Early
Access 1–3, Sustain, Last Chance 48/24h - the taxonomy in §8) rather than history alone.

**Paid units plan uses the entries shape.** Historical `Total_Product_Units` for the paid
group books ~98.6% of draw units on the draw-close date (winners are allocated then), so a
units-shaped plan cliffs ~46% of the paid target onto the final day while the plotted
actual (secured units, §6.3½) accrues entry-timed - the plan would read "behind" all
campaign and "catch up" in one fictional day. `build_curves` therefore substitutes the paid
group's entries curve for its units curve (final step 0.21 instead of 0.46 - the genuine
last-chance surge remains). Verified 2026-08-28: dropping each historical release's close
day removes the units-curve jump entirely, proving it is allocation bookkeeping, not
last-day demand; a historical secured-units curve is NOT reconstructable because the export
retroactively reclassifies converted entries out of `*_No_Conv`.

### 5.4 Forward projection of entries
Projections describe the **current trajectory**; the paid-spend recommendation is the
intervention shown alongside, never baked into the projection.

**Organic channels** - the remaining volume follows the channel's *historic shape curve*;
its level scales with demonstrated performance, trusted in proportion to how much of the
campaign the curve says has been observed:
```
w        = curve_channel(pdsa_today)                 # share of campaign observed
r        = clamp(actual / expected, 0.25, 2.5)       # demonstrated performance
proj     = actual + target × (1 − w) × (1 + w × (r − 1))
path(d)  = actual + (proj − actual) × (curve(pdsa_d) − w) / (1 − w)   # shaped, not linear
```
Early in a campaign (w small) the future is the plan; late, it scales with what the channel
has actually delivered.

**Paid** - projection = **projected spend ÷ projected efficiency**, day by day:
```
spend_fwd(d) = current daily spend run-rate            # not the recommendation
cpe_fwd(d)   = trailing-3-day CPE × Π (1 + drift)      # drift 5%/7%/10%/day by window third
entries_fwd  = Σ spend_fwd(d) / cpe_fwd(d)
```
Fallback when no spend history exists yet: paid target × remaining share of the paid curve.
Projected *purchases* from any projected entries convert at the 0.8 eligible-entry→order rate.

---

## 6. Actuals and live status

### 6.1 Daily actuals (grain: channel × day × release)
From the daily funnel feed: sessions (`Sessions_Total`), page views, draw entries,
`Draw_Entries_Eligible_Units` (AC - the "eligible entries" actual),
`Draw_Entries_Total_Units_No_Conv` (AB - eligible entered units not yet converted),
`Total_Product_Units` (U - units sold), customer/unit splits by route (Draw / Preorder App /
Private Room / Presale Offered / Other).

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
The hero, trajectory, and channels modules run on one unified metric of sales plus
entries:
```
secured units = units sold (all routes, incl. private room)
              + 0.8 × eligible entry units NOT yet converted
```
Only *unconverted* entries carry the 0.8 discount (a converted entry is already a sale -
counting all entries would double-count). Group unit targets sum exactly to the edition
size, so the hero target = sellout (private-room units ride with the AA Email group, the
workbook's own convention). The hero is **capped at edition size**; entries beyond the
units left to sell are shown as an oversubscription signal, not as bar overshoot.
Funnel diagnostics and the paid module stay denominated in entries/spend - the things
marketing moves directly.

### 6.3 Sell-through prediction (per product - LE)
From draw data + orders:
`sold` (units sold to date) + `sold_predicted` (eligible entries in hand × 0.8, allocated per
product by the demand model) + `future_entries_predicted` (remaining plan curve × conversion).
Segments must sum to ≤ edition; total sell-through % = Σ over products / Σ editions.

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
`budget_share` = who pays for ads (AA/artist), e.g. 100/0 (Glenn Ligon), 33/66 (Jaume Plensa);
distinct from `profit_share`.

**Budget to sell out** (the sizing decision). The workbook nets off a manual
`organic_topup` estimate; the dashboard automates it with the shape-following
organic projection (§5.4), so paid is sized to top up only the gap organic is
not on course to fill:
```
secured_now      = units_sold_total + 0.8 × entries_banked    # all channels
organic_future   = Σ over organic groups of (proj − now)      # §5.4 projection
sellout_gap      = max(edition_size − secured_now − organic_future, 0)
entries_needed   = sellout_gap × (1 + drop_off)
forecast_CPE     = trailing_3day_adjCPE × 1.5                 # 1.5 = assumed CPE deterioration to launch
budget_to_sellout= entries_needed × forecast_CPE
daily_spend      = budget_to_sellout / days_until_launch
ROI_check_party  = profit_per_unit_party / (forecast_CPE × budget_share_party)
```
A launch pacing well ahead organically reads a recommendation of £0/day -
nothing extra is needed to secure sell-out, whatever the current ROI.

**Pacing rules** (v1 rules engine; target and thresholds):
- Target ROI (AA) = **1.1** (last-day forecast).
- Daily direction: cum-ROI < 0.9 → Decrease; 0.9–1.3 → Maintain; > 1.3 → Increase.
- Daily spend change capped at **±30%**; changes ≤ 10% are ignored (0%).
- Downside protection: forecast ROI < 1.1 for **3 consecutive days → forced Decrease**.
- Spend-per-unit is expected to deteriorate 5% / 7% / 10% per day across the first/second/final
  third of the window (feeds the forecast when no fresh actuals).

This maps 1:1 onto the design's Paid module contract:
`roiDeclineModel = { start: today's actual ROI, dailyFactor }` (dailyFactor ≈ 1/(1+tier drift));
`recommended = min(spend at ROI floor, spend at supply cap)`, `cap ∈ {roi_floor, supply}` -
supply cap = the budget-to-sell-out logic (spending beyond it buys entries exceeding the units
left); ROI floor = 1.0/1.1 last-day forecast rule.

---

## 8. Email & social (funnel diagnostics layer)

### Email (Klaviyo)
Send-level: `Email Name`, send datetime, `Campaign` (join key), Delivered, Opened, Clicked,
Unsubscribed. Name convention `DDMMYY_TYPE_Campaign - Description (variant)`;
types: `GEN` full-list broadcast, `CUS` segmented send (incl. `Early Access (LE) 1/2/3` tiers),
`INS` insiders/VIP, `TRNS` transactional post-purchase, `AUT` automated flows, `FREQ` frequency
tests. Launch playbook sequence: Announcement → Early Access (1/2/3 + Insiders) → Sustain /
Deepdive / Halfway / Clue n → Last Chance 48h → 24h → post-close surveys → TRNS production chain.
Reference rates for the funnel module: use the release's own campaign sends vs the historical
median for the same send type. ⚠ Bundle sends (`FREQ_LE_Bundle`) promote 2–3 releases and cannot
be attributed to one release.

### Social content (Emplifi)
Post/story-level per platform (instagram 90%, twitter/X since 2025-08). Join via Labels →
campaign code. Useful metrics: impressions, reach, engagements (+ rates, verified =
engagements/impressions and /reach), saves (posts), story views/exits/taps/completion, video
views. Two owned profiles (Avant Arte ~2.9M followers; Avant Insiders ~74k) - normalise
per-1000-followers separately. Funnel-module rungs "Posts" and "Sessions/post" = count of posts
for the campaign in the window; sessions from the funnel feed ÷ posts.

---

## 9. Dashboard metric map (module → formula)

Per the design handoff (README + artboards; the mock's reconciliation rules are requirements):

| Module | Number | Formula (this doc) |
|---|---|---|
| Hero "Entries vs targets" | to date | Σ channels cumulative eligible entries (LE currency) |
| | expected today | Σ channels `target_total × curve(pdsa_today)` (§5) |
| | delta | actual − expected (must equal Σ channel gaps = Σ funnel contributions) |
| | projected at close | §5.4: organic follows the channel's historic shape curve scaled by demonstrated performance; paid = projected spend ÷ projected efficiency. Stored on the day's snapshot (never re-derived client-side) |
| | target | §3 channel targets summed |
| Sidebar status | on-pace % | `heroDelta / expectedToday(total)` |
| Trajectory | plan line | per-channel plan curve × target (§5) |
| | actual line | daily cumulative actuals |
| | projection | linear from today's actual to projected-at-close |
| Channels vs targets | per group | now / expected / projected / target per display group (§1.3) |
| Funnel by channel | rungs | email: Delivered/Open/Click vs reference; social: posts, sessions/post; all: session → entry vs benchmark (§4B); paid: spend & cost/entry vs plan |
| | contribution | units vs expected, repriced one-at-a-time; per-channel contributions sum to that channel's gap |
| Key drivers | top movers | rank funnel steps by |contribution|, Adding vs Costing |
| Paid ROI | series | §7 daily ROI (AA); decline model start = today's ROI |
| Paid spend/day | recommended | §7: min(ROI-floor spend, supply-cap spend), `cap` recorded; Implement → append-only decision log |
| Sell-through | segments | §6.3 (LE: sold / sold-predicted / future-entries-predicted) |
| Entries by country | top 5 | geo split of entries (requires country dim in the daily feed - **currently missing; needs adding to the BigQuery export**) |
| Projection vs target | waterfall | stored model outputs: Organic traffic / Organic conversion / Paid spend / Paid efficiency contributions summing exactly to projection − target |

LE benchmark fields carried on the release document: `chargeDropOff = 0.2`,
`signupToOrderRate` (TL), `firstChoiceWinRate` / `steeredBackupWinRate` (from draw allocation
data), `reOfferRecovery`.

---

## 10. Proposed warehouse shape (for the production build)

```
dim_release(release_name PK, campaign_code, type LE|TL, artist, announce_date,
            private_room_open, launch_end, campaign_length_days, edition_size, unit_price,
            economics…, model_picks {paid_size, reference_point, cpp_pick, quality_by_channel})
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
   `Across time.csv` is a 50k-row export cut mid-date. Go straight to BigQuery.
7. `Maurizio Cattelan · Window · 2026 Q1` has launch < announcement (negative campaign length) -
   fix the campaign-dates table.
8. 58% of daily rows are `Missing campaign dates` (back catalog without announcement dates).
9. `campaign_id` in Meta exports mangled to float - join on campaign_name.
10. Campaign Mapping sheet's static columns are misaligned against a live UNIQUE spill - do not
    use; the reliable link is each release's (release_name, campaign_name) pair.
11. `untracked` vs `Untracked` case; header typos (`Eligable`, `reachs`).

Model bugs found in the sheet (the rebuild should implement the *intent*):
12. "Spend for tomorrow" is clamped to £2 (`min(spend, 2.0)` where 2.0 is a per-unit step;
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
