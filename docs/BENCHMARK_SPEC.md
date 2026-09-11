# Benchmark, target and stretch — implementation contract

The settled design from the "Benchmark and Target Containers" canvas. This file is the
contract every part of the build works to: the snapshot shape, the maths, the API and the
drawing grammar. Where it disagrees with an older doc, this file wins.

## 1. The three references

| | what it is | drawn as |
|---|---|---|
| **Benchmark** | what launches in the matched basket typically reach: the **median** of that basket, per metric and per channel. One value, never a band. | solid **cobalt** `#2b5fd9` line, 2px |
| **Target** | benchmark × K, the business target | solid **ink** `#141413` line, 2px |
| **Stretch** | target − benchmark = benchmark × (K − 1) | a number; a grey hatched bar only on the waterfall |

`K = edition_size / benchmark_units_total` — one **even uplift** applied to every volume
(sessions, entries, units, spend), in every channel, at every funnel stage and on every day
of the campaign. **Conversion rates are held at the benchmark.**

Both reference lines are drawn **identically**: same 2px width, same length, extending 3px
beyond a bar they cross so the colour reads on white either side of a fill. **No white
halos.** Colour and label are the only difference.

## 2. Horizon: one page-level toggle

A single `Today | At close` control in the page header drives every container. No container
carries its own horizon toggle (the Channels card keeps `% | Units` only).

- **Today** — actuals vs the target for today (ink) and the benchmark for today (cobalt).
- **At close** — projection vs the target (ink) and the benchmark (cobalt).

Naming, both horizons: the marks are **"target"** and **"benchmark"**. The words "expected"
and "benchmark pace" are retired. Where a label needs to disambiguate it reads
`target today` / `benchmark today`.

Containers with a single horizon ignore the toggle: **Funnel by channel** and **Organic
funnel** are always Today; **Paid ROI** has no horizon and **no reference lines at all**.

## 3. Basket → benchmark

### 3.1 Ready-made baskets (`etl/baskets.py`)

Built from `data/release_clusters.csv` (rows with `panel == "draw"`, 108 of them) and
`data/release_cluster_baskets.json`.

| id | name | membership |
|---|---|---|
| `cluster_0` | Paid-led headline launches | `cluster == 0` |
| `cluster_1` | Paid-supported small editions | `cluster == 1` |
| `cluster_2` | Email-led collector launches | `cluster == 2` |
| `cluster_3` | Artist-audience draws | `cluster == 3` |
| `all_12m` | All draw launches, last 12 months | `window_end` within 365 days of `as_of` |
| `same_artist` | Same artist, earlier launches | same `artist`, `window_end < window_start` of this release; **disabled when < 3 members** |

A release is **never a member of its own benchmark** — always drop its own
`release_name` from any basket.

### 3.2 Profile (the medians)

```
profile = {
  "n": int,                       # members used
  "members": [release_name, ...],
  "units": float,                 # median tot_total_product_units        -> 214
  "units_p25": float, "units_p75": float,
  "sessions": float,              # median tot_sessions_total             -> 23543
  "entries": float,               # median tot_draw_entries_eligible_units
  "campaign_days": float,         # median campaign_days
  "private_room_share": float,    # median
  "share_units":    {group: float},   # median unit_share_<g>, renormalised to sum 1
  "share_sessions": {group: float},   # median sess_share_<g>, renormalised to sum 1
  "conv":           {group: float},   # median conv_sess_entry_<g> (0 when no history)
  "units_by_group":    {group: share_units[g]    * units},
  "sessions_by_group": {group: share_sessions[g] * sessions},
}
```

Groups are the five display groups: `aa_email`, `aa_social`, `referral_artist`,
`search_direct_other`, `paid`.

Per-channel benchmarks are **median share × median total**, never the median of the
per-channel column — so they sum exactly to the headline median. Medians over an empty or
all-NaN column are `0.0`, never NaN.

A basket with fewer than **3** members cannot be used (the caller falls back to the
suggested cluster and records `basket.thin = True` when `n < 10`).

### 3.3 Suggestion

`suggest_basket(panel, release)` returns the ready-made id for a release:

1. If the release is in the panel and has a `cluster`, use `cluster_<n>`.
2. Otherwise use `nearest_cluster` if present.
3. Otherwise pick the cluster whose median units are closest to the edition size in log
   space, tie-broken by paid-session share against the release's paid plan.

## 4. Target maths (`etl/build.py`)

When a release has a benchmark basket, `targeting_mode` is `"benchmark"`; otherwise the
existing quartile-lever model runs unchanged (`"levers"`).

```
K            = edition_size / profile["units"]
units[g]     = profile["units_by_group"][g]    * K       # sums to edition_size exactly
sessions[g]  = profile["sessions_by_group"][g] * K
entries[g]   = units[g] / e2o                            # e2o = eligible_entry_to_order (0.8)
paid_budget  = profile["units_by_group"]["paid"] * cost_per_purchase["Median"] * K
```

`compute_targets` in benchmark mode returns the **same top-level keys** as the lever model
so nothing downstream breaks: `edition_size`, `paid_pct`, `paid_units`, `organic_units`,
`pr_other_pct`, `pr_units`, `draw_units`, `per_channel`, `pr_sessions`, `paid{...}`,
`launch_value`, `organic_sessions_draw`, `total_sessions`, `entries_target`, `buffer`.

- `pr_units = units["aa_email"] * profile["private_room_share"]`, `draw_units = organic − pr`.
- `per_channel` is **synthesised** by splitting each group's target across its raw channels
  with the `order_split` medians from `etl/benchmarks.json`, renormalised inside the group.
  It carries the same keys as before (`quality`, `order_split`, `purchases`,
  `eligible_entries`, `sessions`, `session_to_entry`); `quality` is `"benchmark"`.
- `group_targets(targets)` is unchanged and must still sum to the edition size.

### 4.1 Pace curves

`build_curves(at, members=None)` gains an optional member filter. The **basket curve** is
built from the basket's own members; when fewer than 4 members qualify for a metric the
function already returns `None` for that series and `curve_value` falls back to the pooled
curve. Curves are cached per basket id for the run.

```
benchmark_plan[g][d] = profile["units_by_group"][g] * curve(basket, g, "units", pdsa(d))
target_plan[g][d]    = benchmark_plan[g][d] * K
```

So target and benchmark stay in exactly the K ratio on every day — which is what makes the
even uplift legible on the trajectory.

## 5. Snapshot additions

All new fields are **additive**. Existing consumers keep working.

```jsonc
{
  "targetingMode": "benchmark",         // or "levers"
  "benchmark": {
    "basket": { "id": "cluster_0", "kind": "ready", "name": "Paid-led headline launches",
                "n": 33, "thin": false, "suggestedId": "cluster_0" },
    "units": 214.0, "unitsP25": 148.0, "unitsP75": 468.0,
    "sessions": 23543.0, "entries": 194.0, "campaignDays": 26.0,
    "k": 1.4019, "stretchUnits": 86.0, "stretchPct": 0.4019,
    "unitsByGroup":    { "aa_email": 83.5, ... },
    "sessionsByGroup": { "aa_email": 4579.0, ... },
    "convByGroup":     { "aa_email": 0.0155, ... },
    "paidBudget": 9735.0
  },
  "hero": {
    "...existing...": null,
    "benchmark": 214.0,          // at close
    "benchmarkToday": 132.0,     // benchmark pace by today
    "stretch": 86.0
  },
  "channels": [ { "...existing...": null,
    "bm": 83.5,        // benchmark at close, this group
    "bmExp": 58.6,     // benchmark by today
    "daily": [ { "date": "...", "actual": 1, "plan": 1, "proj": null, "bm": 31.0 } ]
  } ],
  "funnelByGroup": { "aa_email": { "...existing...": null,
    "sessions_benchmark": 4579.0, "conv_benchmark": 0.0155 } },
  "sellthrough": { "...existing...": null, "benchmarkUnits": 214.0 },
  "paid": { "...existing...": null, "benchmarkUnits": 55.0, "benchmarkBudget": 9735.0 },
  "waterfall": {
    "benchmark": 214.0, "stretch": 86.0, "target": 300.0, "projection": 336.0,
    "steps": [ ... unchanged ... ],
    "today": { "benchmark": 132.0, "stretch": 53.0, "target": 185.0, "actual": 250.0,
               "steps": [ {"key":"organic_traffic","label":"Organic traffic","value":52.0}, ... ] }
  }
}
```

`waterfall.today.steps` are the same four contributors measured **to date** (not scaled to
close): they must sum exactly to `actual − target`, with the rounding residual parked on the
largest step, exactly as the close steps do.

`hero.benchmarkToday` and `channels[].bmExp` use the basket curve at today's pdsa, so
`benchmarkToday × K == expectedToday` to within rounding.

## 6. API

- `GET  /api/baskets?release=<id>` → `{ suggested: "cluster_0", baskets: [ {id, kind, name,
  desc, n, disabled?, profile} ], saved: [...] }`
- `GET  /api/baskets/candidates` → `{ rows: [ {release_name, artist, title, quarter,
  window_end, campaign_days, units, sessions, paid_share, private_room_share, cluster,
  cluster_name} ] }` — the draw panel, newest close first.
- `POST /api/baskets` `{name, members[]}` → saves a custom basket to `data/app/baskets.json`
  and returns it with `kind: "saved"`.
- `POST /api/inputs/:id` additionally accepts
  `benchmark_basket: {kind: "ready"|"bespoke"|"saved", id?: string, members?: string[]}`
  and `stretch_mode: "even" | "levers"`. Validation: `kind` in the three values; `id` must
  resolve; `members` must be known release names, at least 3, and must not contain this
  release. An invalid basket is a 400, not a silent fallback.

Because the benchmark model needs the panel and the basket curves, a save that changes
`benchmark_basket` or `stretch_mode` **re-runs the Python ETL for that release** rather than
using the JS retarget path (`retargetSnapshot` stays for lever-mode edits). The save
response is unchanged in shape.

## 7. Drawing grammar (web)

Token: `--cobalt: #2b5fd9` in `tokens.css`, `C.cobalt` in `ui.jsx`.

| container | Today | At close |
|---|---|---|
| **Units vs sellout** (hero) | fill = to date; ink tick = target today; cobalt tick = benchmark today; legend rows To date / Target today / Stretch today | fill = projected; ink tick = target; cobalt tick = benchmark; orange hatch = demand over the sellout |
| **Unit trajectory** | target and benchmark read off the today line as two short ticks with coloured labels; future faded | target (ink) and benchmark (cobalt) horizontal lines, stretch bracket between them, projection dashed |
| **Channels vs targets** | one fill per column, ink line at target today, cobalt line at benchmark today, foot = % vs target | same with projected fill and close references |
| **Funnel by channel** / **Organic funnel** | always Today. **cobalt centre line = benchmark**, hollow **ink ring = target**, orange/red dot = actual, on a log scale where ×4 either way fills the rung (`›` marks beyond). Pale bar spans ring→dot. The % and its RAG colour stay **vs target**. Volume rungs put the ring at ×K; rate rungs put it on the centre line (rates held at benchmark). | — |
| **Projection vs target** (waterfall) | Benchmark today → Stretch (grey hatch) → Target today → 4 contributors → Actual today | Benchmark → Stretch → Target → 4 contributors → Projection |
| **Paid spend / day** | both track bars carry ink target + cobalt benchmark ticks; a `Stretch` row under `Capped by` states the uplift | same with projected fill |
| **Predicted sell-through** | secured vs target today and benchmark today | prediction vs sellout, cobalt tick at the benchmark |
| **Paid ROI** | unchanged — no reference lines | — |

Sidebar status becomes three-state: green at or ahead of target, amber behind target but
ahead of benchmark, red behind benchmark, hollow when no targets are set.

Everything degrades: when `snap.benchmark` is absent the cobalt marks are simply not drawn
and every card renders exactly as it does today.

## 8. Target setting

The quartile levers are replaced (kept behind an `Evenly | By channel` switch) by:

1. **Benchmark basket** card — the chosen basket, its profile chips, a `Change basket`
   button opening the picker, and the per-channel table
   `benchmark sessions | target sessions | benchmark units | target units | stretch | conv (held)`.
2. **Stretch** card — benchmark (read-only), sellout (the edition size input), the stretch
   that falls out, and the `Evenly | By channel` switch.
3. **Derived targets** rail — three columns: Benchmark, Target, Stretch.

The **basket picker** is a modal with two tabs: `Ready-made` (radio cards with n, median
units and the middle half, median sessions, paid share, campaign days, examples, and a
`Suggested` chip on the matched one) and `Bespoke` (search + filters, a tickable table of
candidates, and a live rail showing the basket's medians, a thin-basket warning under 10,
and `Save as ready-made`).

## 9. Shared web helpers (`web/src/ui.jsx`)

Wave-1 additions every module builds on. Signatures are fixed here so the modules and the
helpers can be written in parallel.

```js
export const C = { ..., cobalt: "#2b5fd9" };

// One reference tick/line, 2px, extending 3px past the bar it crosses. No halo.
// `kind`: "target" (ink) | "benchmark" (cobalt).
export function RefTick({ pct, kind, vertical = true, tip })

// Horizontal track bar. `target` draws the ink tick, `bm` the cobalt tick (both
// optional). `hatchFrom` starts the orange over-sellout hatch at that value.
export function TrackBar({ now, proj, target, bm, hatchFrom, height, radius, tips })

// Deviation rung shared by Funnel by channel and Organic funnel.
//   aOverB : actual / benchmark   (null -> neutral rung)
//   kind   : "vol" (target = benchmark x k) | "rate" (target = benchmark)
//   k      : the even uplift
// Returns { rel, dev, ring, beyond } where rel is % vs target, dev/ring are 4..96
// positions on a log scale (x4 either way fills the rung).
export function rungGeom(aOverB, kind, k)
export function RungTrack({ dev, ring, up, neutral, guide })   // cobalt centre line + ink ring + dot

// The legend marks, so every card says it the same way.
export function RefKey({ horizon, showStretch })
```

Every module receives `horizon` (`"today" | "close"`) as a prop from `App.jsx`, defaulting
to `"today"`. `snap.benchmark` may be absent — guard every cobalt mark on it.
