/* Paid spend / day (spec §4.7, LE "Capped by" case §6.3).
 * Lead = recommended daily budget with an arrow lozenge vs current; "Capped by" row
 * names the binding limit (supply sell-out vs ROI floor); two 120%-track bars put
 * paid entries and spend on the same visual scale; footer buttons write to the
 * append-only decision log. Complete releases: projection = actual, recommendation "—",
 * buttons disabled. Pre-launch releases (no campaign yet) disable the buttons too. */
import React, { useState } from "react";
import { Card, TrackBar, Lozenge, GROUP_DOTS, C, fmt, fmtK, MINUS, postDecision } from "../ui.jsx";

const money = (v) => "£" + fmt(Math.round(v ?? 0));
const moneyK = (v) => "£" + fmtK(v ?? 0);

export default function PaidSpend({ snap }) {
  const paid = snap.paid || {};
  const budget = paid.budget || {};
  const complete = !!snap.complete;
  const noCampaign = !snap.campaignName;
  const [decision, setDecision] = useState(null); // 'implement' | 'ignore'

  const cur = budget.current ?? null;
  const rec = budget.recommended ?? null;
  const d = cur !== null && rec !== null ? Math.round(rec) - Math.round(cur) : null;
  const floorF = fmt(budget.floor ?? 1, 1);

  // ----- lozenge (recommended vs current), voice per §6.3 / §4.7 -----
  const lozTip = noCampaign
    ? "No paid campaign live yet"
    : budget.cap === "supply"
      ? "Daily budget " + money(cur) + " → " + money(rec) +
        "\nSupply caps spend before the ROI floor binds: beyond " + money(rec) +
        "/day, forecast entries exceed the units left to sell."
      : d !== null && d < 0
        ? "Daily budget " + money(cur) + " → " + money(rec) +
          "\nFinal-day ROI would fall below the " + floorF +
          " floor at the current budget, so spend pulls back — final-day ROI projected " +
          fmt(budget.finalDayRoi, 2) + "."
        : "Daily budget " + money(cur) + " → " + money(rec) +
          "\nFinal-day ROI projected " + fmt(budget.finalDayRoi, 2) + " — above the " +
          floorF + " floor, so spend rises. Below the floor, spend pulls back.";
  const loz =
    d === null || d === 0 ? (
      <Lozenge dir="neutral" tip={lozTip}>—</Lozenge>
    ) : d > 0 ? (
      <Lozenge dir="up" tip={lozTip}>{"▲ +£" + fmt(d)}</Lozenge>
    ) : (
      <Lozenge dir="down" tip={lozTip}>{"▼ " + MINUS + "£" + fmt(-d)}</Lozenge>
    );

  // ----- "Capped by" row -----
  const showCap = !complete && !noCampaign && (rec ?? 0) > 0;
  const capLabel = budget.cap === "supply" ? "Supply — sell-out" : "ROI floor";
  const capTip =
    budget.cap === "supply"
      ? "Sell-out caps spend: " + money(rec) + "/day covers the " + fmt(budget.entriesNeeded) +
        " entries still needed at forecast cost per entry.\nThe ROI floor is not binding — final-day ROI projected " +
        fmt(budget.finalDayRoi, 2) + " vs the " + floorF + " floor."
      : "The ROI floor binds: beyond " + money(rec) +
        "/day the final-day ROI is projected to fall below the " + floorF +
        " floor.\nFinal-day ROI projected " + fmt(budget.finalDayRoi, 2) + ".";

  // ----- bars (120% track, target tick at 83.3%) -----
  const entriesNow = Math.round((paid.daily || []).reduce((t, x) => t + (x.entries ?? 0), 0));
  const entriesProj = complete ? entriesNow : (paid.unitProjected ?? entriesNow);
  const entriesTarget = paid.unitTarget ?? 0;
  const entriesPct = entriesTarget > 0 ? Math.round((entriesProj / entriesTarget) * 100) : null;
  const entriesTip = complete
    ? fmt(entriesNow) + " paid entries at close vs the " + fmt(entriesTarget) + " target"
    : fmt(entriesNow) + " paid entries to date · projected " + fmt(entriesProj) +
      " at close vs the " + fmt(entriesTarget) + " target";

  const spendNow = paid.spendToDate ?? 0;
  const spendProj = complete ? spendNow : (paid.spendProjectedTotal ?? spendNow);
  const spendTarget = paid.spendBudget ?? 0;
  const spendTip = complete
    ? moneyK(spendNow) + " spent at close vs the " + moneyK(spendTarget) + " budget"
    : moneyK(spendNow) + " spent to date · " + moneyK(spendProj) +
      " projected by day " + (snap.of ?? "–") + " vs the " + moneyK(spendTarget) + " budget";

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
          <div className="lead" title="Campaign closed" style={{ color: C.muted }}>—</div>
        ) : (
          <>
            <div className="lead">{money(rec)}</div>
            {loz}
          </>
        )}
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      {showCap && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
          <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>Capped by</span>
          <Lozenge color="blue" tip={capTip}>{capLabel}</Lozenge>
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
              target: "Target " + fmt(entriesTarget) + " paid entries at close",
              overshoot: "Over target by " + fmt(Math.max(0, entriesProj - entriesTarget)) + " entries",
            }}
          />
          <span
            title={complete
              ? fmt(entriesNow) + " paid entries at close vs the " + fmt(entriesTarget) + " target"
              : "Projected " + fmt(entriesProj) + " paid entries at close vs the " + fmt(entriesTarget) + " target"}
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
              target: "Budget " + moneyK(spendTarget),
              overshoot: "Over budget by " + moneyK(Math.max(0, spendProj - spendTarget)),
            }}
          />
          <span title={spendTip} style={rightLabel}>{moneyK(spendProj)}</span>
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
          title={btnTitle("Writes the daily budget to Meta via the Marketing API — logged")}
          onClick={() => act("implement")}
        >
          {decision === "implement" ? "✓ Applied" : "Implement"}
        </button>
        <button
          className="btn secondary"
          disabled={disabled}
          style={btnStyle}
          title={btnTitle("Keeps the current budget — logged")}
          onClick={() => act("ignore")}
        >
          {decision === "ignore" ? "Logged" : "Ignore"}
        </button>
      </div>
    </Card>
  );
}
