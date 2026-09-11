/* Paid spend / day (spec §4.7, LE "Capped by" case §6.3; references and horizon
 * per BENCHMARK_SPEC 2 and 7).
 * Lead = recommended daily budget with an arrow lozenge vs current; "Capped by" row
 * names the binding limit (supply sell-out vs ROI floor); two 120%-track bars put
 * paid units and spend on the same visual scale; footer buttons write to the
 * append-only decision log. Complete releases: projection = actual, recommendation "-",
 * buttons disabled. Pre-launch releases (no campaign yet) disable the buttons too.
 *
 * Both bars now carry the cobalt benchmark alongside the ink target, so "behind
 * target" and "behind what a launch like this usually spends to get here" are two
 * different readings rather than one. The Stretch row under "Capped by" names the
 * uplift once in words, because it is the same even multiple on every channel and
 * every day (BENCHMARK_SPEC 1) and so has no business being redrawn per bar.
 *
 * Today reads spend and units to date against the campaign's pro-rata share of the
 * close figures - paid pacing is a daily budget decision, so the day count is the
 * honest denominator here. At close it is the projections against the full target
 * and the full benchmark budget. When snap.benchmark is absent the cobalt ticks and
 * the Stretch row are simply not drawn. */
import React, { useState } from "react";
import { Card, TrackBar, Lozenge, GROUP_DOTS, C, fmt, fmtK, fmtSigned, MINUS, postDecision, useTip } from "../ui.jsx";

const money = (v) => "£" + fmt(Math.round(v ?? 0));
const moneyK = (v) => "£" + fmtK(v ?? 0);

export default function PaidSpend({ snap, horizon = "today" }) {
  const tipApi = useTip();
  const paid = snap.paid || {};
  if (snap.targeted === false) return <PaidSpendActuals snap={snap} />;
  const budget = paid.budget || {};
  const close = horizon === "close";
  const complete = !!snap.complete;
  const noCampaign = !snap.campaignName;
  const [decision, setDecision] = useState(null); // 'implement' | 'ignore'

  const cur = budget.current ?? null;
  const rec = budget.recommended ?? null;
  const d = cur !== null && rec !== null ? Math.round(rec) - Math.round(cur) : null;
  const floorF = fmt(budget.floor ?? 1, 1);
  const noPrice = !noCampaign && rec === null;   // spend exists but no cost-per-entry history yet

  // ----- lozenge (recommended vs current), voice per §6.3 / §4.7 -----
  const lozTip = noCampaign ? { head: "No paid campaign live yet" } : noPrice ? {
    head: "No recommendation yet", body: "Needs a few days of paid entries to price them.",
  } : {
    head: "Daily budget",
    body: "Entries are priced at the cost per entry the recommended spend implies (cost rises with spend), then paced by the workbook's rules: ±30% a day, hold while cumulative ROI sits between 0.9 and 1.3, cut below 0.9.",
    rows: [
      { label: "Current", value: money(cur) },
      { label: "Recommended", value: money(rec) },
      { label: "Cost / unit now", value: budget.cpeNow ? "£" + fmt(budget.cpeNow) : "–" },
      { label: "Cost / unit at recommended", value: budget.cpeAtRecommended ? "£" + fmt(budget.cpeAtRecommended) : "–" },
      { label: "ROI at recommended", value: fmt(budget.finalDayRoi, 2) },
      { label: "Cumulative ROI", value: budget.cumRoi ? fmt(budget.cumRoi, 2) : "–" },
      { label: "Spend to sell out / day", value: budget.supplySpend !== null && budget.supplySpend !== undefined ? money(budget.supplySpend) : "–" },
      { label: "Spend at ROI floor / day", value: budget.roiSpend !== null && budget.roiSpend !== undefined ? money(budget.roiSpend) : "–" },
      ...(typeof budget.selloutGap === "number"
        ? [{ label: "Sell-out gap (units)", value: fmt(budget.selloutGap) }]
        : []),
      { label: "ROI floor", value: floorF },
    ],
  };
  const loz =
    d === null || d === 0 ? (
      <Lozenge dir="neutral" content={lozTip}>-</Lozenge>
    ) : d > 0 ? (
      <Lozenge dir="up" content={lozTip}>{"▲ +£" + fmt(d)}</Lozenge>
    ) : (
      <Lozenge dir="down" content={lozTip}>{"▼ " + MINUS + "£" + fmt(-d)}</Lozenge>
    );

  // ----- "Capped by" row: what bound the recommendation -----
  const showCap = !complete && !noCampaign && rec !== null && !!budget.cap;
  const CAP_LABELS = {
    supply: "Supply - sell-out", roi_floor: "ROI floor", pacing: "Pacing ±30% / day",
    roi_band_hold: "ROI band - hold", roi_band_decrease: "ROI band - decrease",
    forced_decrease: "3 days below target ROI", plan_rate: "Plan rate (first day)",
    zero_conversion: "Zero conversion yesterday", zero_conversion_pause: "3 days of zero conversion - pause",
    hold_small_change: "Change under 10% - hold",
  };
  const capLabel = (CAP_LABELS[budget.cap] || budget.cap) + (budget.paced ? " · paced" : "");
  const bandTip = {
    head: capLabel,
    body: budget.cap === "pacing"
      ? "The workbook's pacing rule: never move the daily budget by more than 30% in a day - a bigger jump resets Meta's learning and the price with it. The unconstrained figure is in the budget tooltip."
      : budget.cap === "roi_band_hold"
      ? "Cumulative ROI is between 0.9 and 1.3: the rules say hold, so spend is not raised even though more would sell more."
      : budget.cap === "roi_band_decrease"
      ? "Cumulative ROI is below 0.9: the rules say decrease, by up to 30% a day."
      : budget.cap === "forced_decrease"
      ? "Forecast ROI has been below target for three days running: the rules force a decrease."
      : budget.cap === "plan_rate"
      ? "No spend yet to anchor a price on, so the first day starts at the plan's daily rate."
      : budget.cap === "zero_conversion"
      ? "The LE spend rules: a day that spent and bought no entries cuts the budget by 30%."
      : budget.cap === "zero_conversion_pause"
      ? "The LE spend rules: three days of spend with no entries pause the campaign."
      : "The recommendation is within 10% of today's spend, which the rules treat as no change.",
    rows: [
      { label: "Cumulative ROI", value: budget.cumRoi ? fmt(budget.cumRoi, 2) : "–" },
      { label: "Unconstrained", value: budget.supplySpend !== null && budget.roiSpend !== null && budget.supplySpend !== undefined && budget.roiSpend !== undefined ? money(Math.min(budget.supplySpend, budget.roiSpend)) + " / day" : "–" },
      { label: "ROI at close, at recommended", value: fmt(budget.finalDayRoi, 2) },
    ],
  };
  const floorTip = {
    head: "ROI floor",
    body: "The floor is on ROI at close, on the same drifting cost path the Paid ROI chart draws. At today's spend that path ends at " +
      fmt(budget.finalDayRoi !== null && budget.cpeAtRecommended && budget.cpeAtClose ? null : null, 2).replace("–", "") +
      "the chart's projected figure; the recommendation is the spend at which it ends on the floor" +
      (budget.paced ? ", cut no faster than 30% a day" : "") + ".",
    rows: [
      { label: "Floor", value: floorF },
      { label: "Cost / unit at close, today's spend", value: budget.cpeAtClose ? "£" + fmt(budget.cpeAtClose) : "–" },
      { label: "Cost / unit at close, recommended", value: budget.cpeAtRecommended ? "£" + fmt(budget.cpeAtRecommended) : "–" },
      { label: "ROI at close, recommended", value: fmt(budget.finalDayRoi, 2) },
      { label: "Spend at the floor", value: money(rec) + " / day" },
      ...(budget.paced ? [{ label: "Pacing", value: "cut limited to 30% / day" }] : []),
    ],
  };
  const capTip = !["supply", "roi_floor"].includes(budget.cap) ? bandTip : budget.cap === "roi_floor" ? floorTip : budget.cap === "supply" ? {
    head: "Supply - sell-out",
    rows: [
      { label: "Spend cap", value: money(rec) + " / day" },
      { label: "Entries needed", value: fmt(budget.entriesNeeded) },
      ...(typeof budget.organicFuture === "number"
        ? [{ label: "Organic still to come", value: fmt(budget.organicFuture) }]
        : []),
      { label: "Final-day ROI", value: fmt(budget.finalDayRoi, 2) },
    ],
  } : {
    head: "ROI floor",
    rows: [
      { label: "Floor", value: floorF },
      { label: "Final-day ROI", value: fmt(budget.finalDayRoi, 2) },
      { label: "Spend cap", value: money(rec) + " / day" },
    ],
  };

  // ----- bars (120% track, target tick at 83.3%) -----
  // Today's references are the pro-rata share of the close figures: the paid plan
  // is a flat daily budget, so days elapsed is the share of it that should be spent.
  const dayFrac = close ? 1
    : snap.day > 0 && snap.of > 0 ? Math.min(1, snap.day / snap.of)
    : 1;
  const hasBm = !!snap.benchmark;
  const bmUnitsAll = hasBm && paid.benchmarkUnits !== null && paid.benchmarkUnits !== undefined
    ? paid.benchmarkUnits : null;
  const bmSpendAll = hasBm && paid.benchmarkBudget !== null && paid.benchmarkBudget !== undefined
    ? paid.benchmarkBudget : null;
  const targetWord = close ? "Target" : "Target today";
  const bmWord = close ? "Benchmark" : "Benchmark today";
  const bmBody = "The median of the matched basket - what launches like this one typically reach.";

  // paid.daily carries draw ENTRIES; the target, the projection and the benchmark
  // are all in secured units, so the bar reads paid.unitsToDate - the same entries
  // one drop-off later. Summing the daily entries here put the bar over its own
  // target on every release with a drop-off.
  const unitsNow = Math.round(paid.unitsToDate ?? 0);
  const unitsProj = complete ? unitsNow : (paid.unitProjected ?? unitsNow);
  const unitsFill = close ? unitsProj : unitsNow;
  const unitsTarget = (paid.unitTarget ?? 0) * dayFrac;
  const unitsBm = bmUnitsAll === null ? null : bmUnitsAll * dayFrac;
  const unitsPct = unitsTarget > 0 ? Math.round((unitsFill / unitsTarget) * 100) : null;
  const unitsTip = {
    head: "Paid units",
    rows: [
      { label: "To date", value: fmt(unitsNow) },
      ...(complete || !close ? [] : [{ label: "Projected", value: fmt(unitsProj) }]),
      { label: targetWord, value: fmt(unitsTarget) },
      ...(unitsBm === null ? [] : [{ label: bmWord, value: fmt(unitsBm) }]),
    ],
  };

  const spendNow = paid.spendToDate ?? 0;
  const spendProj = complete ? spendNow : (paid.spendProjectedTotal ?? spendNow);
  const spendFill = close ? spendProj : spendNow;
  const spendTarget = (paid.spendBudget ?? 0) * dayFrac;
  const spendBm = bmSpendAll === null ? null : bmSpendAll * dayFrac;
  const spendTip = {
    head: "Spend",
    rows: [
      { label: "To date", value: moneyK(spendNow) },
      ...(complete || !close ? [] : [{ label: "Projected", value: moneyK(spendProj) }]),
      { label: close ? "Budget" : "Budget today", value: moneyK(spendTarget) },
      ...(spendBm === null ? [] : [{ label: bmWord, value: moneyK(spendBm) }]),
    ],
  };

  // ----- the stretch, said once in words rather than redrawn on every bar -----
  const k = snap.benchmark?.k ?? null;
  const stretchUnits = bmUnitsAll === null ? null : unitsTarget - bmUnitsAll * dayFrac;
  const showStretch = k > 0 && stretchUnits !== null;
  const stretchTip = {
    head: "Stretch",
    rows: [
      { label: bmWord, value: fmt(unitsBm ?? 0) },
      { label: targetWord, value: fmt(unitsTarget) },
      { label: "Stretch", value: fmtSigned(Math.round(stretchUnits ?? 0)) + " units" },
      { label: "Uplift", value: "×" + fmt(k ?? 0, 2) },
    ],
    body: "The even uplift the business put on the basket's median. It is the same multiple in every channel and on every day, so the paid share of it is simply the benchmark's paid units at that multiple.",
  };

  // ----- decision buttons -----
  const actionable = !complete && !noCampaign &&
    (Math.round(rec ?? 0) !== 0 || Math.round(cur ?? 0) !== 0);
  const disabled = !actionable || decision !== null;
  const act = (action) => {
    if (disabled) return;
    postDecision({ releaseId: snap.id, action, from: cur, to: rec, cap: budget.cap });
    setDecision(action);
  };
  const btnTitle = (base) =>
    complete ? "Campaign closed" : noCampaign ? "No paid campaign live yet" : base;
  const btnStyle = disabled ? { opacity: 0.45, cursor: "default" } : undefined;

  const rowGrid = { display: "grid", gridTemplateColumns: "104px 1fr 44px", gap: 12, alignItems: "center" };
  const rowLabel = { fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const rightLabel = { fontSize: 12, fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const legendItem = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const sw = (bg) => ({ width: 8, height: 8, borderRadius: 2, background: bg, flex: "0 0 8px" });

  return (
    <Card dot={GROUP_DOTS.paid} title="Paid spend / day">
      <div className="spacer-8" />
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 auto" }}>
        {complete ? (
          <div className="lead" title="Campaign closed" style={{ color: C.muted }}>-</div>
        ) : (
          <>
            <div className="lead" style={rec === null ? { color: C.muted } : undefined}>{rec === null ? "–" : money(rec)}</div>
            {loz}
          </>
        )}
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      {showCap && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
          <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>Capped by</span>
          <Lozenge color="blue" content={capTip}>{capLabel}</Lozenge>
        </div>
      )}
      {showStretch && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto",
          marginTop: showCap ? 8 : 0,
        }}>
          <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>Stretch</span>
          <Lozenge dir="neutral" content={stretchTip}>
            {"×" + fmt(k, 2) + " on the benchmark · " + fmtSigned(Math.round(stretchUnits)) +
              " units " + (close ? "at close" : "by today")}
          </Lozenge>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 20 }}>
        <div style={rowGrid}>
          <span style={rowLabel}>Paid units</span>
          <TrackBar
            now={unitsNow}
            proj={close ? unitsProj : null}
            target={unitsTarget}
            bm={unitsBm}
            height={20}
            radius={5}
            tips={{
              now: unitsTip,
              proj: unitsTip,
              target: { head: targetWord, rows: [{ label: "Paid units", value: fmt(unitsTarget) }] },
              bm: unitsBm === null ? null : { head: bmWord, rows: [{ label: "Paid units", value: fmt(unitsBm) }], body: bmBody },
              overshoot: { head: "Over target", rows: [{ label: "Units", value: "+" + fmt(Math.max(0, unitsFill - unitsTarget)) }] },
            }}
          />
          <span
            {...tipApi.props(unitsTip)}
            style={{ ...rightLabel, color: unitsPct !== null && unitsFill >= unitsTarget ? C.ink : C.red }}
          >
            {unitsPct !== null ? unitsPct + "%" : "–"}
          </span>
        </div>
        <div style={rowGrid}>
          <span style={rowLabel}>Spend</span>
          <TrackBar
            now={spendNow}
            proj={close ? spendProj : null}
            target={spendTarget}
            bm={spendBm}
            height={20}
            radius={5}
            tips={{
              now: spendTip,
              proj: spendTip,
              target: { head: close ? "Budget" : "Budget today", rows: [{ label: "Spend", value: moneyK(spendTarget) }] },
              bm: spendBm === null ? null : { head: bmWord, rows: [{ label: "Spend", value: moneyK(spendBm) }], body: bmBody },
              overshoot: { head: "Over budget", rows: [{ label: "Spend", value: "+" + moneyK(Math.max(0, spendFill - spendTarget)) }] },
            }}
          />
          <span {...tipApi.props(spendTip)} style={rightLabel}>{moneyK(spendFill)}</span>
        </div>
        <div style={{ height: 14, display: "flex", gap: 14, alignItems: "center" }}>
          <div style={legendItem}><span style={sw(C.orange)} />To date</div>
          {close && <div style={legendItem}><span style={sw(C.orangeLight)} />Projected</div>}
          <div style={legendItem}>
            <span style={{ width: 2, height: 10, background: C.ink, flex: "0 0 2px" }} />{targetWord}
          </div>
          {unitsBm !== null && (
            <div style={legendItem}>
              <span style={{ width: 2, height: 10, background: C.cobalt, flex: "0 0 2px" }} />{bmWord}
            </div>
          )}
        </div>
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      <div className="btn-row" style={{ marginTop: 0 }}>
        <button
          className="btn primary"
          disabled={disabled}
          style={btnStyle}
          title={btnTitle("Writes the daily budget to Meta via the Marketing API - logged")}
          onClick={() => act("implement")}
        >
          {decision === "implement" ? "✓ Applied" : "Implement"}
        </button>
        <button
          className="btn secondary"
          disabled={disabled}
          style={btnStyle}
          title={btnTitle("Keeps the current budget - logged")}
          onClick={() => act("ignore")}
        >
          {decision === "ignore" ? "Logged" : "Ignore"}
        </button>
      </div>
    </Card>
  );
}


/* No targets: the recommendation, the budget and the entry target are all
 * model outputs, so this shows what the campaign has actually done. */
function PaidSpendActuals({ snap }) {
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const entries = Math.round(daily.reduce((t, x) => t + (x.entries ?? 0), 0));
  const spend = paid.spendToDate ?? 0;
  const cur = paid.budget?.current ?? 0;
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "7px 0", borderBottom: `1px solid ${C.hairline}` };
  const noCampaign = !snap.campaignName;
  return (
    <Card dot={GROUP_DOTS.paid} title="Paid spend / day">
      <div className="spacer-8" />
      <div className="lead" title={noCampaign ? "No Meta campaign matched" : "Latest day's spend on the matched campaign"}>
        {noCampaign ? "–" : money(cur)}
      </div>
      <div className="lead-caption" style={{ color: C.muted }}>
        {noCampaign ? "no Meta campaign matched - set one in Target setting" : "current daily spend - recommendation needs targets"}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={row}><span style={{ color: C.muted }}>Campaign</span><span style={{ fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }} title={snap.campaignName || ""}>{snap.campaignName || "–"}</span></div>
        <div style={row}><span style={{ color: C.muted }}>Spend to date</span><span className="num">{money(spend)}</span></div>
        <div style={row}><span style={{ color: C.muted }}>Paid entries to date</span><span className="num">{fmt(entries)}</span></div>
        <div style={{ ...row, borderBottom: "none" }}><span style={{ color: C.muted }}>£ per entry, whole campaign</span><span className="num">{paid.cumCpe ? "£" + fmt(paid.cumCpe, 2) : "–"}</span></div>
      </div>
    </Card>
  );
}
