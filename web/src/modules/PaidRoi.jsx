/* Paid ROI (spec §4.6) - wide 2-col card.
 * Daily spend bars (own axis, bottom band) + actual ROI line + modelled decline
 * dotted to close, anchored at the line's last actual point so dot and line
 * always meet: roi(i) = lastRoi × roiDeclineModel.dailyFactor^i (falls
 * back to roiDeclineModel.start at today when there are no daily ROI points).
 * The line is the trailing-3-calendar-day rolling ROI, matching the headline:
 * a window with spend but no entries is a genuine 0, a window with no spend is
 * null (the line skips it). Points are mapped to campaign day via
 * date − windowStart and clipped to day 1..of;
 * the y-domain (series ∪ target ± 12%, snapped to 0.25) is clamped at 0 since a
 * negative ROI axis is meaningless; complete releases draw actuals only.
 * Paid is live while there has been spend in the last three days, the window
 * the headline reads; switched off, the projection would be a path for spend
 * nobody is making, so the line ends where the spend did and says so.
 *
 * The ROI is a party's (docs §7): profit per unit net of cannibalisation over
 * the cost of a converting entry and that party's share of the spend, both
 * from the Target setting tab. AA's reading is the default; the switch in the
 * head shows the artist's reading of the same days (paid.artist, daily
 * roiArtist), and stays put when the artist carries none of the spend or has
 * no profit per unit recorded. The ? popup shows the working. */
import React, { useState } from "react";
import { Card, QBadge, GROUP_DOTS, C, fmt, dayLabel, dayAxisLabel } from "../ui.jsx";

const W = 480, H = 200, BAND_TOP = 132;
const DAY_MS = 86400000;
const PARTY_PREF = "paidRoiParty";   // the switch sticks across releases, per browser

function dayIndex(dateStr, windowStart, fallback) {
  if (windowStart) {
    const t = Date.parse(dateStr), t0 = Date.parse(windowStart);
    if (!Number.isNaN(t) && !Number.isNaN(t0)) return Math.round((t - t0) / DAY_MS);
  }
  return fallback;
}

const readParty = () => { try { return localStorage.getItem(PARTY_PREF) === "artist" ? "artist" : "aa"; } catch { return "aa"; } };
const pct = (x) => (x === null || x === undefined ? "–" : fmt(100 * x, 0) + "%");

export default function PaidRoi({ snap }) {
  const [hover, setHover] = useState(null);   // day number
  const [partyPref, setPartyPref] = useState(readParty);
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const complete = !!snap.complete;
  const of = snap.of || 1;
  const DAYS = Math.max(1, of - 1);
  const today = Math.max(1, Math.min(snap.day ?? 0, of));

  const targeted = snap.targeted !== false;
  const hasSpend =
    (paid.spendToDate ?? 0) > 0 || daily.some((d) => (d.spend ?? 0) > 0);

  if (!hasSpend) {
    return (
      <Card wide dot={GROUP_DOTS.paid} title="Paid ROI">
        <div className="empty-state">
          {snap.campaignName ? "No paid spend yet." : targeted ? "No paid spend yet." : "No Meta campaign matched to this release - set one in Target setting."}
        </div>
      </Card>
    );
  }

  // ----- whose ROI: AA's, or the artist's reading of the same days -----
  const artist = paid.artist || null;
  const artistReason = !artist ? "The artist's reading needs a rebuilt snapshot"
    : !((artist.budgetShare ?? 0) > 0) ? "The artist carries none of the paid spend on this deal, so there is no artist ROI"
    : !((artist.profitPerUnit ?? 0) > 0) ? "No artist profit per unit on the Target setting tab yet"
    : null;
  const artistOk = targeted && artistReason === null;
  const party = partyPref === "artist" && artistOk ? "artist" : "aa";
  const setParty = (v) => { setPartyPref(v); try { localStorage.setItem(PARTY_PREF, v); } catch { /* per-browser convenience only */ } };
  const view = party === "artist"
    ? { label: "Artist", key: "roiArtist", cum: artist.cumRoi, l3d: artist.l3dRoi, path: artist.roiPath || [],
        start: (artist.roiDeclineModel || {}).start, target: null, ppu: artist.profitPerUnit, share: artist.budgetShare }
    : { label: "AA", key: "roi", cum: paid.cumRoi, l3d: paid.l3dRoi, path: paid.roiPath || [],
        start: (paid.roiDeclineModel || {}).start, target: paid.roiTarget ?? null, ppu: paid.profitPerUnitAA, share: paid.aaBudgetShare };
  const targetLine = view.target !== null && view.target !== undefined ? "\nTarget " + fmt(view.target, 2) : "";

  // ----- series mapped onto campaign days 1..of -----
  const n = daily.length;
  const pts = daily
    .map((d, i) => ({
      d: dayIndex(d.date, snap.windowStart, (snap.day ?? 0) - (n - 1 - i)),
      spend: d.spend ?? 0,
      entries: d.entries ?? null,
      roi: d[view.key] ?? null,
    }))
    .filter((p) => p.d >= 1 && p.d <= of);

  const roiPts = pts.filter((p) => p.roi !== null);
  const lastRoiPt = roiPts.length ? roiPts[roiPts.length - 1] : null;
  const lastSpendDay = pts.reduce((m, p) => (p.spend > 0 ? Math.max(m, p.d) : m), 0);
  const paidLive = lastSpendDay >= today - 2;

  // modelled decline to close, anchored on the last actual point (L3D level at
  // today only when there are no daily ROI points to anchor to)
  const model = paid.roiDeclineModel || {};
  const factor = model.dailyFactor ?? null;
  const anchor = lastRoiPt
    ? { d: lastRoiPt.d, v: lastRoiPt.roi }
    : view.start !== null && view.start !== undefined ? { d: today, v: view.start } : null;
  // The dotted line is the ETL's forward path (roiPath: today's spend, cost
  // drifting by the spend rules' tiers) - the same path the budget
  // recommendation's ROI floor is judged on, so the two cards cannot
  // disagree. The geometric model is only a fallback for older snapshots.
  const pathPts = view.path
    .map((p) => ({ d: dayIndex(p.date, snap.windowStart, null), v: p.roi }))
    .filter((p) => p.d !== null && p.d >= 1 && p.d <= of && p.v !== null && p.v !== undefined);
  const showModel = !complete && paidLive && anchor !== null && anchor.d <= of && (pathPts.length > 0 || factor !== null);
  const paidOff = !complete && !paidLive && anchor !== null && lastSpendDay > 0;
  const decline = !showModel ? [] : pathPts.length
    ? [{ d: anchor.d, v: anchor.v }, ...pathPts.filter((p) => p.d > anchor.d)]
    : Array.from({ length: of - anchor.d + 1 }, (_, i) => ({ d: anchor.d + i, v: anchor.v * Math.pow(factor, i) }));
  const declineEnd = decline.length ? decline[decline.length - 1].v : null;

  // ----- ROI y-domain: series ∪ target ± 12%, snapped to 0.25, clamped at 0 -----
  const domVals = [
    ...roiPts.map((p) => p.roi),
    ...decline.map((p) => p.v),
    ...(view.target !== null && view.target !== undefined ? [view.target] : []),
  ];
  let lo = 0, hi = 1;
  if (domVals.length) {
    const lo2 = Math.min(...domVals), hi2 = Math.max(...domVals);
    const pad = (hi2 - lo2) * 0.12 || Math.abs(hi2) * 0.12 || 0.5;
    lo = Math.max(0, Math.floor((lo2 - pad) / 0.25) * 0.25);
    hi = Math.ceil((hi2 + pad) / 0.25) * 0.25;
    if (hi <= lo) hi = lo + 1;
  }
  const x = (d) => ((d - 1) / DAYS) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const leftPct = (d) => ((x(d) / W) * 100).toFixed(2) + "%";
  const topPct = (v) => ((y(v) / H) * 100).toFixed(2) + "%";

  const path = (arr, val) =>
    arr.map((p, k) => (k ? "L" : "M") + x(p.d).toFixed(1) + "," + y(val(p)).toFixed(1)).join(" ");
  const actualPath = roiPts.length >= 2 ? path(roiPts, (p) => p.roi) : "";
  const declinePath = decline.length >= 2 ? path(decline, (p) => p.v) : "";

  // ----- spend bars: own axis 0..ceil(max/100)*100 in the bottom band -----
  const spendPts = pts.filter((p) => p.spend > 0);
  const spendHi = Math.max(100, Math.ceil(Math.max(0, ...spendPts.map((p) => p.spend)) / 100) * 100);
  const step = W / DAYS;
  const bw = step * 0.52;
  const bars = spendPts.map((p) => {
    const h = (p.spend / spendHi) * (H - BAND_TOP);
    return {
      d: p.d,
      x: Math.min(Math.max(x(p.d) - bw / 2, 0), W - bw).toFixed(1),
      y: (H - h).toFixed(1),
      h: h.toFixed(1),
      tip: dayLabel(snap, p.d) + ": spend €" + fmt(p.spend),
    };
  });

  // ----- lead + header stats -----
  // ROI needs the profit split; without targets the lead is cost per entry
  const leadVal = !targeted ? (complete ? paid.cumCpe : paid.l3dCpe) : complete ? view.cum : view.l3d;
  const leadCaption = !targeted
    ? (complete ? "€ per entry, whole campaign - ROI needs targets" : "€ per entry, last 3 days - ROI needs targets")
    : complete ? `${view.label} ROI final` : `${view.label} ROI last 3 days`;
  // the working behind the headline: the figures it is read from, in the
  // order they are applied, so the basis is on the card and not in a doc
  const cpeUsed = complete ? paid.cumCpe : paid.l3dCpe;
  const dropOff = paid.dropOff ?? 0.2;
  // the spend feed is Meta's, billed in euros; the build converts it once
  const spendNote = paid.spendCurrency && paid.spendCurrency !== "EUR"
    ? ` Spend is Meta's, billed in ${paid.spendCurrency === "EUR" ? "euros" : paid.spendCurrency}, converted to euros at a fixed rate (${paid.spendRate}).` : "";
  const moreTip = !targeted ? {
    head: "Paid cost",
    rows: [
      { label: "€/entry L3D", value: fmt(paid.l3dCpe, 2) },
      { label: "€/entry total", value: fmt(paid.cumCpe, 2) },
    ],
    body: "Cost per converting entry: spend over the entries that become orders (" + pct(1 - dropOff) + " of them). ROI needs the profit split from the Target setting tab." + spendNote,
  } : {
    head: `${view.label} ROI - how it is read`,
    rows: [
      { label: `${view.label} profit per unit`, value: "€" + fmt(view.ppu, 2) },
      { label: "less cannibalisation", value: pct(paid.cannibalisation ?? 0.2) },
      { label: complete ? "÷ € per converting entry, whole campaign" : "÷ € per converting entry, last 3 days", value: fmt(cpeUsed, 2) },
      { label: `÷ ${view.label} share of the spend`, value: pct(view.share) },
      { label: complete ? "= ROI final" : "= ROI last 3 days", value: fmt(leadVal, 2) },
      { label: "ROI total", value: fmt(view.cum, 2) },
      { label: "€/entry L3D", value: fmt(paid.l3dCpe, 2) },
      { label: "€/entry total", value: fmt(paid.cumCpe, 2) },
    ],
    body: "Profit per unit, the share of the spend and the cannibalisation are the Target setting tab's (products and economics, paid assumptions; the AA figure includes the framing uplift, which is Avant Arte's alone). A converting entry is one that becomes an order, "
      + pct(1 - dropOff) + " of entries." + spendNote,
  };
  const todayTip = `${view.label} ROI last 3 days ` + fmt(view.l3d, 2) + targetLine;
  const projTip = `Projected ${view.label} ROI at close ` + fmt(declineEnd, 2) + targetLine;
  const finalTip = `${view.label} ROI final ` + fmt(view.cum, 2) + targetLine;

  const statVal = { fontSize: 13, fontWeight: 600, color: C.ink };
  // the head keeps the party switch; the two whole-campaign totals stand
  // beside the headline, cost per entry over the cumulative ROI
  const right = targeted && artist ? (
    <span className="seg compact" title="Whose ROI: Avant Arte's or the artist's, each their profit per unit over their share of the spend">
      <button className={party === "aa" ? "active" : ""} onClick={() => setParty("aa")}
        title="Avant Arte's ROI: its profit per unit over its share of the paid spend">AA</button>
      <button className={party === "artist" ? "active" : ""} disabled={!artistOk} onClick={() => setParty("artist")}
        style={artistOk ? undefined : { opacity: 0.45, cursor: "default" }}
        title={artistOk ? "The artist's ROI: their profit per unit over their share of the paid spend" : artistReason}>Artist</button>
    </span>
  ) : null;
  const statRow = { display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap", fontSize: 12, color: C.muted };
  const totals = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flex: "0 0 auto" }}>
      <span
        title={"Cost per converting entry, whole campaign: spend ÷ the entries that become orders (" + pct(1 - dropOff) + " of entries)"}
        style={statRow}
      >
        €/entry total <span className="num" style={statVal}>{fmt(paid.cumCpe, 2)}</span>
      </span>
      <span
        title={`Cumulative ${view.label} ROI: ${view.label} profit on the paid entries that convert, net of cannibalisation, ÷ ${view.label}'s share of the spend, whole campaign`}
        style={statRow}
      >
        ROI total <span className="num" style={statVal}>{fmt(targeted ? view.cum : null, 2)}</span>
      </span>
    </div>
  );

  const todayFrac = (today - 1) / DAYS;
  const showTodayLabel = !complete && todayFrac >= 0.06 && todayFrac <= 0.94;

  const byDay = new Map(pts.map((p) => [p.d, p]));
  const declByDay = new Map(decline.map((p) => [p.d, p.v]));

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };

  return (
    <Card wide dot={GROUP_DOTS.paid} title="Paid ROI" right={right}>
      <div className="spacer-8" />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flex: "0 0 auto" }}>
        <div className="lead">
          <span>{fmt(leadVal, 2)}</span>
          <span style={{ fontSize: 12, fontWeight: 400, letterSpacing: 0, color: C.muted, whiteSpace: "nowrap" }}>{leadCaption}</span>
          <QBadge content={moreTip} />
        </div>
        {totals}
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      <div className="body">
        <div style={{ position: "relative", flex: 1 }}>
          <div
            style={{ position: "absolute", left: 48, right: 56, top: 0, bottom: 24 }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
              setHover(Math.min(Math.max(Math.round(frac * DAYS) + 1, 1), of));
            }}
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}
            >
              <line x1="0" y1={H} x2={W} y2={H} stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {bars.map((b) => (
                <rect key={b.d} x={b.x} y={b.y} width={bw.toFixed(1)} height={b.h} rx="1" fill={C.track}>
                  <title>{b.tip}</title>
                </rect>
              ))}
              {declinePath && (
                <path d={declinePath} fill="none" stroke={C.blueLight} strokeWidth="2.6"
                  strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {actualPath && (
                <path d={actualPath} fill="none" stroke={C.blue} strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {!complete && (
                <line x1={x(today).toFixed(1)} y1="0" x2={x(today).toFixed(1)} y2={H}
                  stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {/* hover: guide line + marker + light popup */}
            {hover !== null && (() => {
              const p = byDay.get(hover);
              const projV = declByDay.get(hover);
              const roiV = p && p.roi !== null && p.roi !== undefined ? p.roi : null;
              const markV = roiV ?? projV ?? null;
              const flip = (hover - 1) / DAYS > 0.6;
              if (!p && projV === undefined) return null;
              return (
                <>
                  <div style={{ position: "absolute", left: leftPct(hover), top: 0, bottom: 0, width: 1, background: "#ddd9cf", pointerEvents: "none" }} />
                  {markV !== null && markV !== undefined && (
                    <div style={{ position: "absolute", left: leftPct(hover), top: topPct(markV), width: 7, height: 7, margin: "-3.5px 0 0 -3.5px", borderRadius: "50%", background: roiV !== null ? C.blue : C.blueLight, boxShadow: "0 0 0 2px #fff", pointerEvents: "none" }} />
                  )}
                  <div className="chart-tip" style={{ left: leftPct(hover), top: 4, transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
                    <div className="t-head">{dayLabel(snap, hover, true)}</div>
                    {p && <div className="t-row"><span>{view.label} ROI (3d)</span><span className="v">{roiV !== null ? fmt(roiV, 2) : "–"}</span></div>}
                    {roiV === null && projV !== undefined && <div className="t-row"><span>ROI projected</span><span className="v">{fmt(projV, 2)}</span></div>}
                    {p && <div className="t-row"><span>Spend</span><span className="v">€{fmt(p.spend, 2)}</span></div>}
                    {p && <div className="t-row"><span>Entries</span><span className="v">{fmt(p.entries ?? 0)}</span></div>}
                  </div>
                </>
              );
            })()}

            {/* current dot on the line's last actual point (projection anchor) */}
            {!complete && anchor !== null && (
              <div
                title={todayTip}
                style={{
                  position: "absolute", left: leftPct(anchor.d), top: topPct(anchor.v),
                  width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                  background: C.blue, boxShadow: "0 0 0 2px #fff",
                }}
              />
            )}
            {/* paid switched off: the line ends where the spend did, and says so
                instead of projecting spend nobody is making */}
            {paidOff && (() => {
              const flip = (anchor.d - 1) / DAYS > 0.6;
              return (
                <div style={{
                  position: "absolute", left: leftPct(anchor.d), top: topPct(anchor.v),
                  transform: flip ? "translate(-100%, -50%)" : "translateY(-50%)",
                  [flip ? "paddingRight" : "paddingLeft"]: 12,
                  fontSize: 12, color: C.muted, whiteSpace: "nowrap",
                }}>
                  paid off · last spend day {lastSpendDay}
                </div>
              );
            })()}
            {/* complete: end dot on the last actual ROI point */}
            {complete && lastRoiPt && (
              <div
                title={finalTip}
                style={{
                  position: "absolute", left: leftPct(lastRoiPt.d), top: topPct(lastRoiPt.roi),
                  width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                  background: C.blue, boxShadow: "0 0 0 2px #fff",
                }}
              />
            )}
            {/* projection end dot (white-cored) + label */}
            {showModel && declineEnd !== null && (
              <>
                <div
                  title={projTip}
                  style={{
                    position: "absolute", left: "100%", top: topPct(declineEnd),
                    width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                    background: "#fff", border: `2.2px solid ${C.blueLight}`, boxSizing: "border-box",
                  }}
                />
                <div
                  style={{
                    position: "absolute", left: "100%", top: topPct(declineEnd),
                    transform: "translateY(-50%)", paddingLeft: 10,
                    fontSize: 12, color: C.muted, whiteSpace: "nowrap",
                  }}
                >
                  projected
                </div>
              </>
            )}

            {/* y axis (snapped to 0.25) - meaningless without an ROI series */}
            {roiPts.length > 0 && <div style={{ ...axisLabel, top: 0 }}>{hi.toFixed(2)}</div>}
            {roiPts.length > 0 && <div style={{ ...axisLabel, top: "100%" }}>{lo.toFixed(2)}</div>}

            {/* x axis */}
            <div style={{ ...xLabel, left: 0 }} title="announced">{dayAxisLabel(snap, 0)}</div>
            {showTodayLabel && (
              <div style={{ ...xLabel, left: leftPct(today), transform: "translateX(-50%)", color: C.ink }}>
                today
              </div>
            )}
            <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }} title={`close · day ${of}`}>{dayAxisLabel(snap, of)}</div>

            {/* spend band caption */}
            <div
              title={"Daily spend bars on their own axis: €0 to €" + fmt(spendHi)}
              style={{ position: "absolute", right: "2%", top: "82%", fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}
            >
              daily spend
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
