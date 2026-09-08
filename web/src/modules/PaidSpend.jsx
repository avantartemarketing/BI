/* Paid spend / day (spec §4.7, LE "Capped by" case §6.3).
 * Lead = recommended daily budget with an arrow lozenge vs current; "Capped by" row
 * names the binding limit (supply sell-out vs ROI floor); two 120%-track bars put
 * paid entries and spend on the same visual scale; footer buttons write to the
 * append-only decision log. Complete releases: projection = actual, recommendation "-",
 * buttons disabled. Pre-launch releases (no campaign yet) disable the buttons too. */
import React, { useState } from "react";
import { Card, TrackBar, Lozenge, GROUP_DOTS, C, fmt, fmtK, MINUS, postDecision, useTip } from "../ui.jsx";

const money = (v) => "£" + fmt(Math.round(v ?? 0));
const moneyK = (v) => "£" + fmtK(v ?? 0);

export default function PaidSpend({ snap }) {
  const tipApi = useTip();
  const paid = snap.paid || {};
  if (snap.targeted === false) return <PaidSpendActuals snap={snap} />;
  const budget = paid.budget || {};
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
    hold_small_change: "Change under 10% - hold",
  };
  const capLabel = CAP_LABELS[budget.cap] || budget.cap;
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
      : "The recommendation is within 10% of today's spend, which the rules treat as no change.",
    rows: [
      { label: "Cumulative ROI", value: budget.cumRoi ? fmt(budget.cumRoi, 2) : "–" },
      { label: "Unconstrained", value: budget.supplySpend !== null && budget.roiSpend !== null && budget.supplySpend !== undefined && budget.roiSpend !== undefined ? money(Math.min(budget.supplySpend, budget.roiSpend)) + " / day" : "–" },
      { label: "ROI at recommended", value: fmt(budget.finalDayRoi, 2) },
    ],
  };
  const capTip = !["supply", "roi_floor"].includes(budget.cap) ? bandTip : budget.cap === "supply" ? {
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
  const entriesNow = Math.round((paid.daily || []).reduce((t, x) => t + (x.entries ?? 0), 0));
  const entriesProj = complete ? entriesNow : (paid.unitProjected ?? entriesNow);
  const entriesTarget = paid.unitTarget ?? 0;
  const entriesPct = entriesTarget > 0 ? Math.round((entriesProj / entriesTarget) * 100) : null;
  const entriesTip = {
    head: "Paid entries",
    rows: [
      { label: "To date", value: fmt(entriesNow) },
      ...(complete ? [] : [{ label: "Projected", value: fmt(entriesProj) }]),
      { label: "Target", value: fmt(entriesTarget) },
    ],
  };

  const spendNow = paid.spendToDate ?? 0;
  const spendProj = complete ? spendNow : (paid.spendProjectedTotal ?? spendNow);
  const spendTarget = paid.spendBudget ?? 0;
  const spendTip = {
    head: "Spend",
    rows: [
      { label: "To date", value: moneyK(spendNow) },
      ...(complete ? [] : [{ label: "Projected", value: moneyK(spendProj) }]),
      { label: "Budget", value: moneyK(spendTarget) },
    ],
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
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 20 }}>
        <div style={rowGrid}>
          <span style={rowLabel}>Paid entries</span>
          <TrackBar
            now={entriesNow}
            proj={entriesProj}
            target={entriesTarget}
            height={20}
            radius={5}
            tips={{
              now: entriesTip,
              proj: entriesTip,
              target: { head: "Target", rows: [{ label: "Paid entries", value: fmt(entriesTarget) }] },
              overshoot: { head: "Over target", rows: [{ label: "Entries", value: "+" + fmt(Math.max(0, entriesProj - entriesTarget)) }] },
            }}
          />
          <span
            {...tipApi.props(entriesTip)}
            style={{ ...rightLabel, color: entriesPct !== null && entriesProj >= entriesTarget ? C.ink : C.red }}
          >
            {entriesPct !== null ? entriesPct + "%" : "–"}
          </span>
        </div>
        <div style={rowGrid}>
          <span style={rowLabel}>Spend</span>
          <TrackBar
            now={spendNow}
            proj={spendProj}
            target={spendTarget}
            height={20}
            radius={5}
            tips={{
              now: spendTip,
              proj: spendTip,
              target: { head: "Budget", rows: [{ label: "Spend", value: moneyK(spendTarget) }] },
              overshoot: { head: "Over budget", rows: [{ label: "Spend", value: "+" + moneyK(Math.max(0, spendProj - spendTarget)) }] },
            }}
          />
          <span {...tipApi.props(spendTip)} style={rightLabel}>{moneyK(spendProj)}</span>
        </div>
        <div style={{ height: 14, display: "flex", gap: 14, alignItems: "center" }}>
          <div style={legendItem}><span style={sw(C.orange)} />To date</div>
          <div style={legendItem}><span style={sw(C.orangeLight)} />Projected</div>
          <div style={legendItem}>
            <span style={{ width: 2, height: 10, background: C.ink, flex: "0 0 2px" }} />Target
          </div>
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
