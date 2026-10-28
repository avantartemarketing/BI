/* Paid ROI: the trailing-three-day ROI by day as the line (the 3d/1d switch
 * reads the last full day alone: quicker and noisier), the target ROI a
 * dashed line, the ETL's forward path (paid.roiPath: ROI at today's spend as
 * the campaign's spend adds up) dashed on from the line's last point to the
 * close, and the daily spend as faint bars behind on their own scale. A
 * window with spend but no entries is a genuine 0, one with no spend is a
 * gap. The ROI is a party's (docs 7): profit per unit net of cannibalisation
 * over the cost of a converting entry and that party's share of the spend;
 * AA's is the default, the AA/Artist switch reads the artist's (paid.artist,
 * daily roiArtist) and stays put when the artist carries none of the spend.
 * A timed launch (docs/TL_SPEC.md 7) reads the same card on what a paid
 * signup or sale is worth; inside its window the clock runs in hours and
 * the switch reads 6h/1h. Without targets the head is the cost per
 * converting entry, which needs no profit split. The working behind the
 * head is on its hover. Points sit on campaign day N (date less the
 * announce); the as-of day so far is a bar, never a point on the line. */
import React, { useState } from "react";
import { Card, Head, Seg, useBoxSize } from "../ui.jsx";
import { LineChart, niceAxis, COL, lk, sw, Keys } from "../charts.jsx";
import { fmt, fmtMoney, dayLabel } from "../format.mjs";
import { wordsOf, hourClock } from "../vocab.mjs";
import { stepTicks, stepOf } from "./clock.mjs";

const PARTY_PREF = "paidRoiParty", WINDOW_PREF = "paidRoiWindow";
const readPref = (key, ok, dflt) => { try { const v = localStorage.getItem(key); return ok.includes(v) ? v : dflt; } catch { return dflt; } };
const savePref = (key, v) => { try { localStorage.setItem(key, v); } catch { /* per-browser convenience only */ } };
const has = (v) => v !== null && v !== undefined;
const pct = (x) => (has(x) ? fmt(100 * x, Math.abs(x) < 0.1 ? 1 : 0) + "%" : "–");
const H = 250, L = 36, R = 8, T = 10, B = 26;
const tick = (t) => (t >= 1000 ? `${Math.round(t / 100) / 10}k` : String(Math.round(t * 100) / 100));

/* the daily spend as faint bars behind the line's plot, in the bottom third,
 * drawn in the same pixels the line chart measures: the days spent solid
 * grey (today so far paler), the days ahead at the recommended schedule an
 * outline, so what is planned reads apart from what was spent */
const AHEAD_STROKE = "#b4bbec";
function SpendBars({ W, bars, n, top }) {
  if (!(W > 0) || !bars.length) return null;
  const N = Math.max(1, n - 1), step = (W - L - R) / N, bw = Math.max(2, step * 0.6);
  const x = (i) => L + (i * (W - L - R)) / N;
  const band = (H - T - B) * 0.34;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "auto", display: "block" }} aria-hidden="true">
      {bars.map((b) => {
        const h = Math.max(1, (b.v / top) * band);
        return b.ahead
          ? <rect key={b.i} x={(x(b.i) - bw / 2 + 0.5).toFixed(1)} y={(H - B - h + 0.5).toFixed(1)} width={Math.max(1, bw - 1).toFixed(1)} height={Math.max(1, h - 1).toFixed(1)} rx="1.5" fill="#f6f7fd" stroke={AHEAD_STROKE} strokeWidth="1" strokeDasharray="2 2" />
          : <rect key={b.i} x={(x(b.i) - bw / 2).toFixed(1)} y={(H - B - h).toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} rx="1.5" fill={b.partial ? COL.PALE : COL.TRACK} />;
      })}
    </svg>
  );
}
const aheadKey = { width: 10, height: 10, flex: "0 0 10px", borderRadius: 2, background: "#f6f7fd", border: `1px dashed ${AHEAD_STROKE}`, boxSizing: "border-box" };

export default function PaidRoi({ snap }) {
  const [partyPref, setPartyPref] = useState(() => readPref(PARTY_PREF, ["aa", "artist"], "aa"));
  const [windowPref, setWindowPref] = useState(() => readPref(WINDOW_PREF, ["3d", "1d"], "3d"));
  const [ref, boxW] = useBoxSize();
  const V = wordsOf(snap);
  const tl = snap.type === "TL";
  const hours = hourClock(snap);
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const complete = !!snap.complete;
  const of = Math.max(1, snap.of || 1);
  const today = Math.max(0, Math.min(snap.day ?? 0, of));
  const n = of + 1;
  const targeted = snap.targeted !== false;
  // a timed launch's ROI is readable once the works give AA a profit per unit
  const roiOk = tl ? !!paid.roiReadable && (has(paid.l3dRoi) || has(paid.cumRoi)) : targeted;
  const hasSpend = (paid.spendToDate ?? 0) > 0 || daily.some((d) => (d.spend ?? 0) > 0);
  const unitWord = tl ? (paid.unit === "sale" ? "sale" : "signup") : "converting entry";

  if (!hasSpend) {
    return (
      <Card title="Paid ROI">
        <div className="empty-state">{snap.campaignName ? "No paid spend yet" : "No Meta campaign matched to this release: set one on the Targets tab"}</div>
      </Card>
    );
  }

  // ----- whose ROI, and which window -----
  const artist = paid.artist || null;
  const artistReason = !artist ? "The artist's reading needs a rebuilt snapshot"
    : !((artist.budgetShare ?? 0) > 0) ? "The artist carries none of the paid spend on this deal, so there is no artist ROI"
    : !((artist.profitPerUnit ?? 0) > 0) ? "No artist profit per unit on the Targets tab yet" : null;
  const artistOk = roiOk && artistReason === null && (!tl || has(artist.l3dRoi) || has(artist.cumRoi));
  const party = partyPref === "artist" && artistOk ? "artist" : "aa";
  const setParty = (v) => { setPartyPref(v); savePref(PARTY_PREF, v); };
  const oneDayOk = tl ? paid.l1dCost !== undefined : paid.l1dCpe !== undefined;
  const win = windowPref === "1d" && oneDayOk ? "1d" : "3d";
  const setWindow = (v) => { setWindowPref(v); savePref(WINDOW_PREF, v); };
  const short = win === "1d";
  const winLabel = hours ? (short ? "1h" : "6h") : short ? "1d" : "3d";
  const winWords = hours ? (short ? "last hour" : "last 6 hours") : short ? "last full day" : "last 3 days";
  const winShort = hours ? (short ? "L1H" : "L6H") : short ? "L1D" : "L3D";
  const P = party === "artist"
    ? { label: "Artist", key: short ? "roiArtist1" : "roiArtist", key3: "roiArtist", cum: artist.cumRoi, recent: short ? artist.l1dRoi : artist.l3dRoi,
        path: artist.roiPath || [], start: (artist.roiDeclineModel || {}).start, target: null, ppu: artist.profitPerUnit, share: artist.budgetShare, value: artist.value }
    : { label: "AA", key: short ? "roi1" : "roi", key3: "roi", cum: paid.cumRoi, recent: short ? paid.l1dRoi : paid.l3dRoi,
        path: paid.roiPath || [], start: (paid.roiDeclineModel || {}).start, target: paid.roiTarget ?? null, ppu: paid.profitPerUnitAA, share: paid.aaBudgetShare, value: paid.value };
  const cpeRecent = tl ? (short ? paid.l1dCost : paid.l3dCost) : short ? paid.l1dCpe : paid.l3dCpe;
  const cpeTotal = tl ? paid.cumCost : paid.cumCpe;

  // ----- the rows on the clock: day N is date less the announce (hours inside a window) -----
  const pts = daily.map((d, i) => {
    let s = stepOf(snap, d.date);
    if (s === null) s = (snap.day ?? 0) - (daily.length - 1 - i);
    return { s: Math.round(s), spend: d.spend ?? 0, entries: d.entries ?? null, roi: roiOk ? d[P.key] ?? null : null, roi3: roiOk ? d[P.key3] ?? null : null,
      cost: short ? d.cost1 ?? null : d.cost3 ?? null, partial: !!d.partial, full: Array.isArray(d.full) ? d.full : null };
  }).filter((p) => p.s >= 0 && p.s <= of);
  const byStep = new Map(pts.map((p) => [p.s, p]));
  const roiVals = Array.from({ length: n }, (_, i) => { const p = byStep.get(i); return p && !p.partial && has(p.roi) ? p.roi : null; });
  const roiPts = pts.filter((p) => !p.partial && has(p.roi));
  const lastRoiPt = roiPts.length ? roiPts[roiPts.length - 1] : null;
  const lastSpendStep = pts.reduce((m, p) => (p.spend > 0 ? Math.max(m, p.s) : m), -1);
  const paidLive = lastSpendStep >= today - (hours ? 48 : 2);

  // the forward path, anchored on the line's last point (the geometric model
  // only for a snapshot without a path); in the 1d view re-read from the
  // last full day's price, ROI being one over the price
  const factor = (paid.roiDeclineModel || {}).dailyFactor ?? null;
  const anchor = lastRoiPt ? { s: lastRoiPt.s, v: lastRoiPt.roi } : has(P.start) ? { s: today, v: P.start } : null;
  const pathScale = short && lastRoiPt && lastRoiPt.roi > 0 && lastRoiPt.roi3 > 0 ? lastRoiPt.roi / lastRoiPt.roi3 : 1;
  const pathPts = P.path.map((p) => ({ s: stepOf(snap, p.date), v: has(p.roi) ? p.roi * pathScale : null, full: p.full }))
    .filter((p) => p.s !== null && p.s >= 0 && p.s <= of && has(p.v)).map((p) => ({ ...p, s: Math.round(p.s) }));
  const showModel = roiOk && !complete && paidLive && anchor !== null && anchor.s <= of && (pathPts.length > 0 || factor !== null);
  const paidOff = !complete && !paidLive && lastSpendStep >= 0;
  const decline = !showModel ? [] : pathPts.length
    ? [{ s: anchor.s, v: anchor.v }, ...pathPts.filter((p) => p.s > anchor.s)]
    : Array.from({ length: of - anchor.s + 1 }, (_, i) => ({ s: anchor.s + i, v: anchor.v * Math.pow(factor, i) }));
  // the spend ahead: the schedule the projection runs at (budget.schedule,
  // the recommended spend reached in steps), by step; a day with nothing on
  // it has no ROI to draw, so the path ends where the spend does
  const schedByStep = new Map();
  if (!tl && !complete) {
    for (const x of (paid.budget || {}).schedule || []) {
      const s = stepOf(snap, x.date);
      if (s !== null && has(x.spend)) schedByStep.set(Math.round(s), x.spend);
    }
  }
  const projVals = Array.from({ length: n }, () => null);
  decline.forEach((p) => { if (!(schedByStep.has(p.s) && p.s > today && schedByStep.get(p.s) <= 0)) projVals[p.s] = p.v; });
  const declinePts = decline.filter((p) => has(projVals[p.s]));
  const declineEnd = declinePts.length ? declinePts[declinePts.length - 1].v : null;
  const aheadBars = [...schedByStep.entries()].filter(([s, v]) => s > today && s <= of && v > 0).map(([s, v]) => ({ i: s, v, ahead: true }));
  const aheadLevel = aheadBars.length ? aheadBars[aheadBars.length - 1].v : null;
  const stopsAhead = !complete && schedByStep.size > 0 && !aheadBars.length;
  // the days a work fills (docs 7): the ETL names the work on that day's point
  const fullByStep = new Map(pathPts.filter((p) => Array.isArray(p.full) && p.full.length && p.s > (anchor ? anchor.s : -1)).map((p) => [p.s, p.full]));

  // ----- the scale: the line, the path and the target, from zero -----
  const vals = [...roiVals, ...projVals, P.target].filter(has);
  const ax = niceAxis(Math.max(0.5, ...vals) * 1.08);
  const spendTop = Math.max(1, ...pts.map((p) => p.spend), ...aheadBars.map((b) => b.v));

  // ----- the head -----
  const leadVal = !roiOk ? (complete ? cpeTotal : cpeRecent) : complete ? P.cum : P.recent;
  const dropOff = paid.dropOff ?? 0.2;
  const claims = daily.some((d) => d.converting !== undefined);
  const convWords = tl ? `the paid ${V.unit} on each day` : claims
    ? `what paid entrants bought once given a pre-order or drawn on launch day, and ${pct(paid.preorderRate ?? 0.95)} of pre-order and ${pct(1 - dropOff)} of other entries still waiting`
    : `${pct(1 - dropOff)} of entries`;
  const splitAssumed = roiOk && paid.aaBudgetShareAssumed === true;
  const frameUplift = !tl && (snap.economics?.frameUpliftPerUnit ?? 0) > 0;
  const working = !roiOk ? [
    `Cost per ${unitWord}: spend over ${convWords}. ROI needs ${tl ? "AA's group profit per unit on the Targets tab's products grid" : "the profit split from the Targets tab"}.`,
    `€ per ${unitWord} ${winShort}: ${fmt(cpeRecent, 2)}`, `€ per ${unitWord} total: ${fmt(cpeTotal, 2)}`,
  ] : [
    `${P.label} ROI, how it is read`,
    ...(party === "artist" ? [`Artist profit per unit €${fmt(P.ppu, 2)}`]
      : frameUplift ? [`AA group profit per unit €${fmt(P.ppu - snap.economics.frameUpliftPerUnit, 2)}`, `+ framing uplift per unit €${fmt(snap.economics.frameUpliftPerUnit, 2)}`, `= profit per unit, framing included €${fmt(P.ppu, 2)}`]
      : [`AA group profit per unit €${fmt(P.ppu, 2)}`]),
    `less cannibalisation ${pct(paid.cannibalisation ?? 0.2)}`,
    ...(tl && has(P.value) ? [`= worth of a paid ${unitWord} to ${P.label} ${fmtMoney(P.value, 2)}`] : []),
    `÷ € per ${unitWord}, ${complete ? "whole campaign" : winWords} ${fmt(complete ? cpeTotal : cpeRecent, 2)}`,
    `÷ ${P.label} share of the spend${splitAssumed ? " (assumed)" : ""} ${pct(P.share)}`,
    `= ROI ${complete ? "final" : winWords} ${fmt(leadVal, 2)}`,
    `ROI total ${fmt(P.cum, 2)}`,
    ...(has(P.target) ? [`Target ${fmt(P.target, 2)}`] : []),
    `A converting entry is one that becomes an order: ${convWords}.`,
    ...(splitAssumed ? ["No product records its deal yet, so half the spend is assumed Avant Arte's."] : []),
  ];
  const seg = (
    <>
      <Seg label="ROI window" value={win} onChange={setWindow}
        options={[["3d", winLabel === "6h" ? "6h" : "3d", `The trailing ${hours ? "six hours" : "three full days"}: steadier, and a little behind`],
          ["1d", winLabel === "1h" ? "1h" : "1d", oneDayOk ? `The ${winWords}: the quickest read, and the noisiest` : "The one-day reading needs a rebuilt snapshot"]]} />
      {roiOk && artist ? (
        <Seg label="Whose return" value={party} onChange={(v) => { if (v === "aa" || artistOk) setParty(v); }}
          options={[["aa", "AA", "Avant Arte's ROI: its group profit per unit over its share of the paid spend"], ["artist", "Artist", artistOk ? "The artist's ROI: their profit per unit over their share of the paid spend" : artistReason]]} />
      ) : null}
    </>
  );
  const lineName = roiOk ? `ROI, ${winWords}` : `€ per ${unitWord}, ${winWords}`;
  const lineVals = roiOk ? roiVals : Array.from({ length: n }, (_, i) => { const p = byStep.get(i); return p && !p.partial && has(p.cost) ? p.cost : null; });
  const hasLine = lineVals.some(has);
  const aheadWords = aheadLevel !== null ? `${fmtMoney(aheadLevel, 0)} a ${hours ? "hour" : "day"}` : null;
  const legend = [
    ...(hasLine ? [{ n: lineName, k: lk(COL.IND), tip: `${P.label} ROI ${winWords} ${fmt(P.recent, 2)}${has(P.target) ? ` · target ${fmt(P.target, 2)}` : ""}` }] : []),
    ...(showModel && has(declineEnd) ? [{ n: `ROI ahead, at the ${V.closeWord}`, v: fmt(declineEnd, 2), k: lk(COL.IND, "dashed"),
      tip: `${P.label} ROI projected day by day at the recommended spend${aheadWords ? ` (${aheadWords})` : ""}, ending at ${fmt(declineEnd, 2)} at the ${V.closeWord}${short ? "; the cost path from the last full day's price" : ""}` }] : []),
    ...(has(P.target) && roiOk ? [{ n: "Target", v: fmt(P.target, 2), k: lk(COL.DARK, "dashed") }] : []),
    { n: "Spend", k: sw(COL.TRACK), tip: `Spend by day on its own scale, up to ${fmtMoney(spendTop)}` },
    ...(aheadBars.length ? [{ n: "Spend ahead", v: aheadWords, k: aheadKey, tip: `The recommended spend the projection runs at, from tomorrow to the ${V.closeWord}: today's spend stepping to ${aheadWords} by at most 30% a day` }] : []),
    ...(stopsAhead ? [{ n: "Paid stops: no spend ahead", k: { width: 0 }, tip: "The recommendation is to spend nothing more, so there is no ROI to project" }] : []),
    ...(paidOff ? [{ n: `Paid off since ${V.stepWord} ${lastSpendStep}`, k: { width: 0 }, tip: `No paid spend since ${V.stepWord} ${lastSpendStep}: the line ends where the spend did` }] : []),
  ];
  // a release selling two lines of work, each on its own ad set (docs/LINES_PLAN.md)
  const byLine = !snap.line && Array.isArray(snap.lines) && snap.lines.length > 1 ? snap.lines.filter((l) => l.paid && (l.paid.spendToDate ?? 0) > 0) : [];
  const lineKeys = byLine.map((l) => {
    const roi = party === "artist" ? (l.paid.artist || {}).cumRoi : l.paid.cumRoi;
    return { n: l.name, v: `${fmtMoney(l.paid.spendToDate, 0)} · ROI ${has(roi) ? fmt(roi, 2) : "–"}`, k: { width: 0 },
      tip: `${l.name}: ${(l.adsets || []).join(", ") || "no ad set named"}. Spend ${fmtMoney(l.paid.spendToDate, 0)}, ${fmt(l.paid.entriesToDate ?? 0)} entries, cost per converting entry ${l.paid.cumCpe ? fmtMoney(l.paid.cumCpe) : "–"}, ROI to date ${has(roi) ? fmt(roi, 2) : "–"}` };
  });
  return (
    <Card title="Paid ROI" seg={seg} aria="Paid ROI by day against target">
      <Head v={roiOk ? fmt(leadVal, 2) : fmtMoney(leadVal, 2)} u={roiOk ? (complete ? "overall" : winShort) : `per ${unitWord}${complete ? " overall" : ""}`}
        aside={complete ? (has(P.recent) && roiOk ? `${fmt(P.recent, 2)} ${winShort} at the close` : "") : roiOk ? `${fmt(P.cum, 2)} overall` : `${fmtMoney(cpeTotal, 2)} overall`}
        asideTip={working.join("\n")} />
      <div ref={ref} style={{ position: "relative" }}>
        <SpendBars W={boxW} bars={[...pts.filter((p) => p.spend > 0).map((p) => ({ i: p.s, v: p.spend, partial: p.partial })), ...aheadBars]} n={n} top={spendTop} />
        <div style={{ position: "relative" }}>
          <LineChart H={H} L={L} R={R} T={T} B={B} n={n} ymax={ax.ymax} yticks={ax.ticks} yfmt={(t) => (roiOk ? `${tick(t)}×` : `€${tick(t)}`)} xticks={stepTicks(snap, of)}
            marks={complete ? [] : [today]} legend={legend}
            series={[
              ...(has(P.target) && roiOk ? [{ name: "Target", color: COL.DARK, w: 1.5, da: "4 4", vals: Array.from({ length: n }, () => P.target) }] : []),
              ...(showModel ? [{ name: "ROI ahead", color: COL.IND, w: 1.5, da: "4 4", vals: projVals }] : []),
              ...(hasLine ? [{ name: lineName, color: COL.IND, w: 2, vals: lineVals }] : []),
            ]}
            dotAt={(i) => (has(lineVals[i]) ? lineVals[i] : has(projVals[i]) ? projVals[i] : null)}
            title={(i) => dayLabel(snap, i, true) + (!complete && i === today ? ", today" : "") + (byStep.get(i) && byStep.get(i).partial ? " · so far today" : "")}
            rows={(i) => {
              const p = byStep.get(i);
              const out = [];
              if (has(lineVals[i])) out.push({ n: roiOk ? `${P.label} ROI (${winLabel})` : `€ per ${unitWord} (${winLabel})`, v: roiOk ? `${fmt(lineVals[i], 2)}×` : fmtMoney(lineVals[i], 2), k: lk(COL.IND) });
              else if (has(projVals[i])) out.push({ n: "ROI ahead", v: `${fmt(projVals[i], 2)}×`, k: lk(COL.IND, "dashed") });
              if (has(P.target) && roiOk) out.push({ n: "Target", v: `${fmt(P.target, 2)}×`, k: lk(COL.DARK, "dashed") });
              if (p) out.push({ n: "Spend", v: fmtMoney(p.spend, 0), k: sw(COL.TRACK) });
              else if (i > today && schedByStep.has(i)) out.push({ n: "Spend ahead", v: schedByStep.get(i) > 0 ? fmtMoney(schedByStep.get(i), 0) : "nothing: paid stops", k: aheadKey });
              if (p && has(p.entries)) out.push({ n: tl ? `Paid ${V.unit}` : "Entries", v: fmt(p.entries), k: { width: 8, flex: "0 0 8px" } });
              if (fullByStep.has(i)) out.push({ n: "Full from this day", v: fullByStep.get(i).join(", "), k: { width: 8, flex: "0 0 8px" } });
              return out;
            }}
            aria={`Paid ROI: ${fmt(leadVal, 2)} ${winShort}, ${fmt(P.cum, 2)} overall`} />
        </div>
      </div>
      {lineKeys.length > 0 && <Keys legend={lineKeys} />}
    </Card>
  );
}
