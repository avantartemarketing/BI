# Target-setting methodology

How every target on the Launch Performance dashboard is derived - the inputs, the
benchmarks behind each pick, the step-by-step model, and how a launch-total target
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

## 2. The inputs (Target setting tab)

Each release carries a small set of human decisions, editable on its **Target
setting** tab. Saving recomputes the release's targets, plan curves and
projections immediately - no data rebuild needed.

| Input | What it does |
| --- | --- |
| Edition size, unit price | Sellout target and launch value (size × price) |
| Private room opens / announce / draw close | The campaign clock every curve runs on |
| Artist profit, AA Group profit, profit share | Per-unit economics feeding paid ROI |
| Paid budget share | Who funds the ads. Default: 50/50, or 100% AA on commission / rev-share deals; overridable per release (Glenn Ligon = 100% AA) |
| Framing available | Adds 0.35 conversion × £94 profit per frame to AA profit/unit |
| Paid channel size (Small / Medium / Large) | Which quartile of historical paid share to plan for |
| Private room share (Low / Medium / High) | Quartile of the private-room + other share |
| Paid conversion (Low / Medium / High) | Quartile of paid session → entry conversion |
| Cost per purchase (Low / Median / High) | £128.75 / £177 / £291 per paid unit |
| Channel quality grid (N/A / Low / Medium / High) | Per-channel quartile picks; N/A removes a channel |
| Meta campaign | Which ad campaign the paid actuals are read from |

## 3. Benchmarks: everything is a quartile

Every reference number in the model is a **quartile of the historical LE release
panel**: Low = 25th percentile, Medium = median, High = 75th percentile. Picking
"High" for a channel does not inflate the total - it changes that channel's
*share* of a fixed total, because shares are renormalised (step 3 below).

The benchmark tables are frozen as a versioned file (`etl/benchmarks.json`, dated)
and only change deliberately, so targets never drift silently.

## 4. The target model, step by step

### Step 1 - split the edition into paid vs organic

```
paid_pct      = paid-share benchmark for the size pick    (Low 7.8% · Medium 24.6% · High 36.5%)
paid_units    = round(edition_size × paid_pct)
organic_units = edition_size − paid_units
```

### Step 2 - split organic into draw vs private room

```
pr_share    = private-room + other share benchmark        (Low 24.6% · Medium 46.1% · High 71.1%)
pr_units    = organic_units × pr_share
draw_units  = organic_units − pr_units
```

Private-room units ride with the AA Email group in channel roll-ups (the
workbook's own convention), so group targets still sum exactly to the edition.

### Step 3 - split draw units across the organic channels

Each of the 12 organic channels has an **order-split benchmark** (its historical
share of draw + pre-order units) at the picked quality. Shares are renormalised
over the channels that exist for this release:

```
order_split(c)      = share(c, quality) / Σ share over non-N/A channels
target_purchases(c) = draw_units × order_split(c)
```

The default quality row (overridable per release): AA Email Auto **High**, AA
Email Man **High**, AA Meta **Medium**, AA Other **Medium**, AA X **Low**, Direct
**Medium**, Organic Search **Medium**, Other **Medium**, Referral Artist
**Medium** (N/A for estates, High for hype artists), Referral Meta **Medium**,
Referral Other **N/A**, Referral X **N/A**.

### Step 4 - back out entries and sessions per channel

```
target_entries(c)  = target_purchases(c) / 0.8              (eligible entry → order rate)
target_sessions(c) = target_entries(c) / conv(c, quality)   (session → eligible entry benchmark)
```

Private-room sessions are modelled separately and email-only:
`pr_units ÷ 0.010727` (the median email session → purchase rate).

### Step 5 - paid targets and budget

```
paid_entries      = paid_units / 0.8
paid_sessions     = paid_entries / paid conversion pick     (Medium = 0.42%)
paid_budget       = cost-per-purchase pick × paid_units     (£128.75 / £177 / £291)
```

Sense check: **paid budget should stay under 6% of launch value** - the dashboard
flags a breach but does not block it.

### Step 6 - buffer

`target inc. buffer = 0.75 × target` - a 25% haircut on any target, used as the
amber warning line. Above target is green, between buffer and target is amber,
below buffer is red.

### Worked example - Glenn Ligon (edition 150)

150 units → paid **37** (Medium, 24.6%) + organic 113 → private room **52.1**
(Medium, 46.1%) + draw **60.9** → e.g. AA Email Man: 27.3 purchases → 34.1
entries → 1,961 sessions. Total organic draw sessions 4,076; private-room
sessions 4,857; paid sessions 11,163; paid budget = £177 × 37 = **£6,549**.

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

**Pacing rules:** target ROI (AA) **1.1**, floor **1.0**. Cumulative ROI below
0.9 → decrease; 0.9–1.3 → maintain; above 1.3 → increase. Daily changes are
capped at ±30% and changes under 10% are ignored. Forecast ROI below target for
3 consecutive days forces a decrease. The recommended spend is
`min(budget-to-sell-out spend, spend at the ROI floor)`.

## 8. Where the numbers come from

- **Daily funnel** (sessions, entries, units by channel × day) and **Meta spend**
  are pulled live from the *LE Paid Calculator* Google Sheet on boot and every
  hour; the dashboard header shows the latest complete day.
- **Email** stats pull live from HubSpot when connected (otherwise an uploaded
  snapshot); **Instagram content** (Emplifi) is an uploaded snapshot.
- **Artist posts** pull live from the team's Notion log when connected. Their
  benchmark follows the same cohort approach as every other channel: expected
  posts = the median artist-post count among completed campaigns in the same
  **Referral Artist tier** (the channel-quality pick on the Target setting tab),
  pro-rated by days elapsed. It stays blank until at least two completed
  campaigns in the cohort have logged posts.
- **Benchmarks** are frozen quartiles of the historical panel, versioned and
  dated; recomputing them is a deliberate act, not a side effect of new data.

Open-ended judgement calls - the size pick, channel qualities, the Meta campaign
match - live on each release's Target setting tab, where every change is logged.
