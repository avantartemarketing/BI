/* Recompute a release snapshot's targets/plans/projections after its target-setting
 * inputs change (docs §3, §5.4, §6.3½), without re-running the Python ETL.
 *
 * Everything derivable from (existing actual series + curves + new inputs) is
 * recomputed exactly: channel unit targets, daily plan curves, expected-today,
 * organic shaped projections, hero (capped at edition, oversubscription), rail
 * numbers, sell-through, waterfall (rescaled to the new gap, still reconciling).
 * Actual-derived paid fields (spend, CPE, ROI, recommendation) are untouched —
 * the paid forward projection is spend-based and carries over as (proj − now).
 * The daily date domain refreshes only on a full ETL run (a date change here
 * updates the campaign clock/labels, not the array bounds). */

const DAY_MS = 86400000;

function curveValue(curves, group, metric, pdsa) {
  let series = group && curves.groups[group] ? curves.groups[group][metric] : null;
  if (!series) series = curves.all[metric];
  const grid = curves.grid;
  if (pdsa <= grid[0]) return 0;
  if (pdsa >= grid[grid.length - 1]) return 1;
  for (let i = 1; i < grid.length; i++) {
    if (pdsa <= grid[i]) {
      const w = (pdsa - grid[i - 1]) / (grid[i] - grid[i - 1]);
      return series[i - 1] + w * (series[i] - series[i - 1]);
    }
  }
  return 1;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function retargetSnapshot(snap, inputs, bench, curves, computeTargets) {
  const t = computeTargets(inputs, bench);
  const announce = new Date(inputs.announce_date + "T00:00:00Z");
  const end = new Date(inputs.launch_end + "T00:00:00Z");
  const L = Math.max(Math.round((end - announce) / DAY_MS), 1);
  const asOf = new Date(snap.asOf + "T00:00:00Z");
  const complete = asOf >= end;
  const pdsaFor = (d) => (d - announce) / DAY_MS / L;
  const pdsaToday = pdsaFor(new Date(Math.min(asOf, end)));

  let heroNow = 0, heroExp = 0, heroProj = 0, heroTarget = 0;
  for (const ch of snap.channels) {
    const g = ch.key;
    const tgt = t.group_units[g] ?? 0;
    const w = curveValue(curves, g, "units", pdsaToday);
    const now = ch.now ?? 0;
    const exp = tgt * w;
    const oldProjDelta = (ch.proj ?? now) - now;
    for (const row of ch.daily) {
      const p = pdsaFor(new Date(row.date + "T00:00:00Z"));
      row.plan = r2(tgt * curveValue(curves, g, "units", p));
    }
    let proj;
    if (complete) {
      proj = now;
    } else if (g === "paid") {
      proj = now + Math.max(oldProjDelta, 0); // spend ÷ efficiency forward, target-independent
    } else {
      const r = clamp(exp > 0 ? now / exp : 1, 0.25, 2.5);
      const rs = 1 + w * (r - 1);
      proj = now + tgt * (1 - w) * rs;
      for (const row of ch.daily) {
        if (row.proj !== null && row.proj !== undefined) {
          const cv = curveValue(curves, g, "units", pdsaFor(new Date(row.date + "T00:00:00Z")));
          const frac = w < 1 ? clamp((cv - w) / (1 - w), 0, 1) : 1;
          row.proj = r2(now + (proj - now) * frac);
        }
      }
    }
    ch.target = r1(tgt); ch.exp = r1(exp); ch.proj = r1(proj);
    heroNow += now; heroExp += exp; heroProj += proj; heroTarget += tgt;
  }

  const edition = t.edition_size;
  const cappedNow = Math.min(heroNow, edition);
  const cappedProj = Math.min(heroProj, edition);
  const statusPct = heroExp ? (cappedNow - heroExp) / heroExp : 0;

  snap.hero = {
    now: r0(cappedNow), expectedToday: r0(heroExp),
    delta: r0(cappedNow - heroExp),
    projected: r0(complete ? cappedNow : cappedProj), target: r0(heroTarget),
    oversubscribedUnits: r0(Math.max(Math.max(heroNow, heroProj) - edition, 0)),
    statusPct: Math.round(statusPct * 10000) / 10000, ok: statusPct >= -0.1,
  };

  // targets object (same shape the ETL writes)
  snap.targets = {
    edition_size: edition, paid_pct: t.paid_pct, paid_units: t.paid_units,
    organic_units: t.organic_units, pr_other_pct: t.pr_other_pct,
    pr_units: t.pr_units, draw_units: t.draw_units,
    per_channel: t.per_channel, pr_sessions: t.pr_sessions, paid: t.paid,
    launch_value: t.launch_value, organic_sessions_draw: t.organic_sessions_draw,
    total_sessions: t.total_sessions, buffer: t.buffer,
  };
  snap.groupTargets = {};
  for (const g of Object.keys(t.group_units)) {
    snap.groupTargets[g] = {
      entries: t.group_entries[g], purchases: g === "paid" ? t.paid.units : undefined,
      units: t.group_units[g], sessions: t.group_sessions[g],
    };
  }

  snap.paid.unitTarget = t.paid.units;
  snap.paid.spendBudget = r2(t.paid.budget);

  snap.economics = {
    unitPrice: inputs.unit_price, launchValue: t.launch_value,
    artistProfitPerUnit: r2(t.ppu_artist), aaProfitPerUnit: r2(t.ppu_aa),
    artistProfitShare: inputs.artist_profit_share,
  };

  const sold = snap.sellthrough.sold ?? 0;
  const soldPredicted = snap.sellthrough.soldPredicted ?? 0;
  const inventoryLeft = Math.max(edition - sold, 0);
  const future = complete ? 0 : Math.max(cappedProj - cappedNow, 0);
  snap.sellthrough = {
    edition,
    sold,
    soldPredicted: r1(Math.min(soldPredicted, inventoryLeft)),
    futureEntriesPredicted: r1(Math.min(future, Math.max(inventoryLeft - soldPredicted, 0))),
  };
  snap.sellthrough.pct = Math.round(Math.min(
    (snap.sellthrough.sold + snap.sellthrough.soldPredicted + snap.sellthrough.futureEntriesPredicted)
    / (edition || 1), 1) * 10000) / 10000;

  // waterfall: rescale contributors to the new gap so they still sum exactly
  const newTarget = r0(heroTarget);
  const newProj = r0(heroProj);
  const newGap = newProj - newTarget;
  const oldSum = snap.waterfall.steps.reduce((s, st) => s + st.value, 0);
  if (oldSum !== 0) {
    for (const st of snap.waterfall.steps) st.value = r0(st.value * (newGap / oldSum));
  } else if (snap.waterfall.steps.length) {
    snap.waterfall.steps.forEach((st, i) => { st.value = i === 0 ? newGap : 0; });
  }
  const resid = newGap - snap.waterfall.steps.reduce((s, st) => s + st.value, 0);
  if (snap.waterfall.steps.length && resid !== 0) {
    const biggest = snap.waterfall.steps.reduce((a, b) => Math.abs(a.value) >= Math.abs(b.value) ? a : b);
    biggest.value += resid;
  }
  snap.waterfall.target = newTarget;
  snap.waterfall.projection = newProj;

  // identity/timeline fields
  snap.marketingLead = inputs.marketing_lead;
  snap.campaignCode = inputs.campaign_code;
  snap.campaignName = inputs.campaign_name;
  snap.privateRoomOpen = inputs.private_room_open;
  snap.windowStart = inputs.announce_date;
  snap.windowEnd = inputs.launch_end;
  snap.campaignLengthDays = L;
  snap.of = L;
  snap.day = clamp(Math.round((asOf - announce) / DAY_MS), 0, L);
  snap.complete = complete;

  return snap;
}

module.exports = { retargetSnapshot };
