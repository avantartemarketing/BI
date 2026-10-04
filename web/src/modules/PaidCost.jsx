/* A timed launch's paid card (docs/TL_SPEC.md §4, §5): the Paid ROI card, in
 * TL words. A timed launch's paid buys signups before the window opens and
 * sales inside it. The ROI view reads what paid bought at what it is assumed
 * to be worth to Avant Arte - a paid signup at the basket's paid signup ->
 * order rate (or the typed rate), the pieces an order takes and AA's profit on
 * a unit with the likely framing profit, net of cannibalisation; a paid sale
 * the same without the conversion - over what it cost AA, its share of the
 * spend (etl/tl.py tl_paid_value). The card is the LE card's: the trailing
 * three days' ROI (or the last full day's, the 3d/1d switch) as the line
 * against the target ROI, the artist's reading on the AA/Artist switch, the
 * ETL's forward path to the open or the close as the dotted end, the daily
 * spend as bars on their own axis in the bottom band, the line ending where
 * the spend did once paid is off. The cost view is the same chart in euros:
 * the trailing cost per signup (or per sale) against the plan's cost - the
 * basket's median, or the figure typed on the Target setting tab - and the
 * cost at the target ROI. ROI needs AA's profit per unit (Airtable's, or typed
 * on the Target setting tab's products grid); without it the card reads the
 * cost alone and says so. Before the window the clock runs in days from the
 * announce, inside it in hours from the sales open, and a day's spend then
 * spans its hours. The words on the plot are set in clear space with a leader
 * to what they name, as the LE charts set theirs (labels.mjs). */
import React, { useState } from "react";
import {
  Card, QBadge, GROUP_DOTS, C, fmt, fmtMoney, dayLabel, dayAxisLabel, textPx, timeAxis, nameLines, useBoxSize, LineNames, ChartTip,
} from "../ui.jsx";
import { wordsOf, hourClock } from "../vocab.mjs";

const W = 480, H = 200, BAND_TOP = 132;
const DAY_MS = 86400000, HOUR_MS = 3600000;
const VIEW_PREF = "tl_paid_view";      // per-browser: the view the reader left the card in
const PARTY_PREF = "paidRoiParty";     // the LE card's switches, shared so a choice sticks across pages
const WINDOW_PREF = "paidRoiWindow";
const readPref = (key, ok, dflt) => { try { const v = localStorage.getItem(key); return ok.includes(v) ? v : dflt; } catch { return dflt; } };
const savePref = (key, v) => { try { localStorage.setItem(key, v); } catch { /* per-browser convenience only */ } };
const has = (v) => v !== null && v !== undefined;
const pct = (x) => (has(x) ? fmt(100 * x, Math.abs(x) < 0.1 ? 1 : 0) + "%" : "–");
const ratio = (x) => (has(x) ? fmt(x, 2) : "–");
const S2O_WORDS = { release: "the rate typed on the Target setting tab", basket_paid: "the basket's paid signup → order rate",
  basket: "the basket's blended signup → order rate", none: "no rate on file" };
const FRAME_WORDS = { release: "the works' own take-up", basket: "the basket's frames per print", default: "the default take-up" };

export default function PaidCost({ snap }) {
  const [hover, setHover] = useState(null);   // a step of the clock
  const [viewPref, setViewPref] = useState(() => readPref(VIEW_PREF, ["roi", "cost"], null));
  const [partyPref, setPartyPref] = useState(() => readPref(PARTY_PREF, ["aa", "artist"], "aa"));
  const [windowPref, setWindowPref] = useState(() => readPref(WINDOW_PREF, ["3d", "1d"], "3d"));
  const [plotRef, plotW, plotH] = useBoxSize();
  const V = wordsOf(snap);
  const paid = snap.paid || {};
  const daily = paid.daily || [];
  const complete = !!snap.complete;
  const hours = hourClock(snap);
  const of = Math.max(1, snap.of || 1);
  const today = Math.max(0, Math.min(snap.day ?? 0, of));
  const unitWord = paid.unit === "sale" ? "sale" : "signup";
  const period = V.state === "signups" ? "pre-window" : "window";
  const hasSpend = (paid.spendToDate ?? 0) > 0 || daily.some((d) => (d.spend ?? 0) > 0);
  // ROI is readable once the works give Avant Arte a profit per unit
  const roiOk = !!paid.roiReadable && (has(paid.l3dRoi) || has(paid.cumRoi));
  const view = roiOk && viewPref !== "cost" ? "roi" : "cost";
  const setView = (v) => { setViewPref(v); savePref(VIEW_PREF, v); };
  // ----- whose ROI: AA's, or the artist's reading of the same days -----
  const artist = paid.artist || null;
  const artistReason = !artist ? "The artist's reading needs a rebuilt page"
    : !((artist.budgetShare ?? 0) > 0) ? "The artist carries none of the paid spend on this deal, so there is no artist ROI"
    : !((artist.profitPerUnit ?? 0) > 0) ? "No artist profit per unit on the Target setting tab yet"
    : null;
  const artistOk = roiOk && artistReason === null && (has(artist.l3dRoi) || has(artist.cumRoi));
  const party = partyPref === "artist" && artistOk ? "artist" : "aa";
  const setParty = (v) => { setPartyPref(v); savePref(PARTY_PREF, v); };
  // ----- which window: the trailing three full days, or the last full day alone -----
  const oneDayOk = paid.l1dCost !== undefined;   // a page built before the 1d reading has none
  const win = windowPref === "1d" && oneDayOk ? "1d" : "3d";
  const setWindow = (v) => { setWindowPref(v); savePref(WINDOW_PREF, v); };
  const winWords = win === "1d" ? "last full day" : "last 3 days";
  const winShort = win === "1d" ? "L1D" : "L3D";
  const P = party === "artist"
    ? { label: "Artist", key: win === "1d" ? "roiArtist1" : "roiArtist", key3: "roiArtist", cum: artist.cumRoi,
        recent: win === "1d" ? artist.l1dRoi : artist.l3dRoi, path: artist.roiPath || [], value: artist.value,
        ppu: artist.profitPerUnit, share: artist.budgetShare, uplift: 0 }
    : { label: "AA", key: win === "1d" ? "roi1" : "roi", key3: "roi", cum: paid.cumRoi,
        recent: win === "1d" ? paid.l1dRoi : paid.l3dRoi, path: paid.roiPath || [], value: paid.value,
        ppu: paid.profitPerUnitAA, share: paid.aaBudgetShare, uplift: paid.frameUpliftPerUnit ?? 0 };
  const costKey = win === "1d" ? "cost1" : "cost3";
  const costRecent = win === "1d" ? paid.l1dCost : paid.l3dCost;
  const title = view === "roi" ? "Paid ROI" : V.paidTitle;

  if (!hasSpend) {
    return (
      <Card wide dot={GROUP_DOTS.paid} title={V.paidTitle}>
        <div className="empty-state">
          {snap.campaignName ? "No paid spend yet." : "No Meta campaign matched to this launch - set one in Target setting."}
        </div>
      </Card>
    );
  }
  const needsProfit = "ROI needs Avant Arte's profit per unit: AA profit (and frame profit) per work on the Target setting tab's products grid, or in Airtable";
  const right = (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span className="seg compact" title="The days the headline and the line read: the last three full days, or the last full day alone">
        <button className={win === "3d" ? "active" : ""} onClick={() => setWindow("3d")} title="The trailing three full days: steadier, and a day or two behind">3d</button>
        <button className={win === "1d" ? "active" : ""} disabled={!oneDayOk} onClick={() => setWindow("1d")}
          style={oneDayOk ? undefined : { opacity: 0.45, cursor: "default" }}
          title={oneDayOk ? "The last full day alone: the quickest read, and the noisiest" : "The last-day reading needs a rebuilt page"}>1d</button>
      </span>
      {roiOk && artist ? (
        <span className="seg compact" title="Whose ROI: Avant Arte's or the artist's, each their profit per unit over their share of the spend">
          <button className={party === "aa" ? "active" : ""} onClick={() => setParty("aa")} title="Avant Arte's ROI: its profit per unit, framing included, over its share of the paid spend">AA</button>
          <button className={party === "artist" ? "active" : ""} disabled={!artistOk} onClick={() => setParty("artist")}
            style={artistOk ? undefined : { opacity: 0.45, cursor: "default" }}
            title={artistOk ? "The artist's ROI: their profit per unit over their share of the paid spend" : artistReason}>Artist</button>
        </span>
      ) : null}
      <span className="seg compact" title={roiOk
        ? `ROI: what paid bought at what it is worth, over what it cost. Cost: the euros a paid ${unitWord} cost`
        : needsProfit}>
        <button className={view === "roi" ? "active" : ""} disabled={!roiOk} onClick={() => setView("roi")} style={roiOk ? undefined : { opacity: 0.45, cursor: "default" }}>ROI</button>
        <button className={view === "cost" ? "active" : ""} onClick={() => setView("cost")}>Cost</button>
      </span>
    </span>
  );

  // ----- each day of spend on the clock: a day is a step before the window, 24 steps inside it -----
  const start = hours ? Date.parse(snap.clock.start) : Date.parse(snap.windowStart + "T00:00:00Z");
  const stepOf = (dateStr) => {
    const t = Date.parse(dateStr + "T00:00:00Z");
    if (!Number.isFinite(t) || !Number.isFinite(start)) return null;
    return hours ? (t - start) / HOUR_MS : Math.round((t - start) / DAY_MS);
  };
  const span = hours ? 24 : 1;   // the steps a day covers
  const pts = daily.map((d) => ({ ...d, s0: stepOf(d.date) })).filter((p) => p.s0 !== null && p.s0 + span > 0 && p.s0 <= of)
    .map((p) => ({ ...p, a: Math.max(p.s0, 0), b: Math.min(p.s0 + span, of), mid: (Math.max(p.s0, 0) + Math.min(p.s0 + span, of)) / 2 }));
  const valueKey = view === "roi" ? P.key : costKey;
  const linePts = pts.filter((p) => !p.partial && has(p[valueKey])).map((p) => ({ ...p, v: p[valueKey] }));
  const lastPt = linePts.length ? linePts[linePts.length - 1] : null;
  const plan = paid.costPlan ?? null;
  const bm = paid.costBm ?? null;
  const atTarget = roiOk && has(paid.costAtTargetRoi) ? paid.costAtTargetRoi : null;
  const roiTarget = has(paid.roiTarget) ? paid.roiTarget : null;
  // paid is live while it spent within the last two days; off, the line ends where the spend did
  const lastSpend = pts.filter((p) => p.spend > 0).slice(-1)[0] || null;
  const paidLive = !!lastSpend && lastSpend.b >= today - 2 * span;
  const paidOff = !complete && !paidLive && !!lastSpend;

  // ----- the dotted end: the ETL's forward ROI at today's spend along the cost
  // path (the price rising as the spend adds up), anchored on the line's last
  // point; in the 1d view re-read from the last full day's price, ROI being one
  // over the price, so the path scales by the two readings on that day -----
  const anchor = view === "roi" && lastPt ? { mid: lastPt.mid, v: lastPt.v } : null;
  const pathScale = win === "1d" && lastPt && lastPt.v > 0 && has(lastPt[P.key3]) && lastPt[P.key3] > 0 ? lastPt.v / lastPt[P.key3] : 1;
  const pathPts = view === "roi" && anchor ? P.path.map((p) => {
    const s0 = stepOf(p.date);
    return s0 === null || !has(p.roi) ? null : { mid: Math.min(Math.max(s0, 0) + span / 2, of), v: p.roi * pathScale };
  }).filter((p) => p && p.mid > anchor.mid) : [];
  if (pathPts.length) pathPts[pathPts.length - 1] = { ...pathPts[pathPts.length - 1], mid: of };   // the path ends at the open or the close
  const showModel = view === "roi" && !complete && paidLive && anchor !== null && pathPts.length > 0;
  const decline = showModel ? [anchor, ...pathPts] : [];
  const declineEnd = decline.length ? decline[decline.length - 1] : null;

  // the reference lines of the view in force
  const refs = view === "roi"
    ? (roiTarget !== null ? [{ key: "target", v: roiTarget, text: `target ${ratio(roiTarget)}`, dash: false,
        title: "The target ROI for Avant Arte's paid spend, the LE pages' (etl/benchmarks.json target_roi_aa)" }] : [])
    : [
      ...(plan !== null ? [{ key: "plan", v: plan, text: `plan ${fmtMoney(plan, 2)}`, dash: false,
        title: `The plan's cost per ${unitWord} (${paid.costPlanSource === "release" ? "typed" : "the basket's median"}), the price the ${period} budget was set at` }] : []),
      ...(bm !== null && plan !== null && Math.abs(bm - plan) > 0.005 ? [{ key: "bm", v: bm, text: null, dash: true, title: `The basket's median cost per ${unitWord}` }] : []),
      ...(atTarget !== null ? [{ key: "roi", v: atTarget, text: `at target ROI ${fmtMoney(atTarget, 2)}`, dash: true,
        title: `The most a paid ${unitWord} can cost Avant Arte at the ${ratio(roiTarget)} target ROI: its worth over AA's share of the spend and the target` }] : []),
    ];

  // ----- the y axis: the line, the path and the references, padded; ROI in quarters from a floor of zero, cost from zero -----
  let lo = 0, hi = 1;
  const domVals = [...linePts.map((p) => p.v), ...refs.map((r) => r.v), ...decline.map((p) => p.v)];
  if (domVals.length) {
    if (view === "roi") {
      const lo2 = Math.min(...domVals), hi2 = Math.max(...domVals);
      const pad = (hi2 - lo2) * 0.12 || Math.abs(hi2) * 0.12 || 0.5;
      lo = Math.max(0, Math.floor((lo2 - pad) / 0.25) * 0.25);
      hi = Math.ceil((hi2 + pad) / 0.25) * 0.25;
      if (hi <= lo) hi = lo + 1;
    } else {
      hi = Math.ceil((Math.max(...domVals) * 1.15) / 0.5) * 0.5 || 1;
    }
  }
  const x = (st) => (st / of) * W;
  const y = (v) => H - ((Math.max(lo, Math.min(v, hi)) - lo) / (hi - lo)) * H;
  const leftPct = (st) => ((x(st) / W) * 100).toFixed(2) + "%";
  const topPct = (v) => ((y(v) / H) * 100).toFixed(2) + "%";
  const pathOf = (arr) => (arr.length >= 2 ? arr.map((p, k) => (k ? "L" : "M") + x(p.mid).toFixed(1) + "," + y(p.v).toFixed(1)).join(" ") : "");
  const linePath = pathOf(linePts), declinePath = pathOf(decline);

  // ----- the spend bars: their own axis in the bottom band -----
  const spendPts = pts.filter((p) => p.spend > 0);
  const spendHi = Math.max(100, Math.ceil(Math.max(0, ...spendPts.map((p) => p.spend)) / 100) * 100);
  const bars = spendPts.map((p) => {
    const h = (p.spend / spendHi) * (H - BAND_TOP);
    const w = Math.max(x(p.b) - x(p.a) - 2, 2);
    return { key: p.date, x: (x(p.a) + 1).toFixed(1), w: w.toFixed(1), y: (H - h).toFixed(1), h: h.toFixed(1), partial: p.partial, mid: p.mid,
      tip: `${p.date}: spend €${fmt(p.spend)}${p.partial ? " so far today" : ""}` };
  });

  // ----- the words -----
  const leadVal = view === "roi" ? (complete ? P.cum : P.recent) : (complete ? paid.cumCost : costRecent);
  const lead = view === "roi" ? ratio(leadVal) : (leadVal ? fmtMoney(leadVal, 2) : "–");
  const leadCaption = view === "roi"
    ? (complete ? `${P.label} ROI, the whole ${period}` : `${P.label} ROI, ${winWords}`)
    : (complete ? `cost per ${unitWord}, the whole ${period}` : `cost per ${unitWord}, ${winWords}`) + (roiOk ? "" : " - ROI needs AA profit per unit");
  const costUsed = complete ? paid.cumCost : costRecent;
  const splitAssumed = roiOk && paid.aaBudgetShareAssumed === true;
  const costTip = {
    head: `Cost per ${unitWord} - how it is read`,
    rows: [
      { label: "Spend to date", value: fmtMoney(paid.spendToDate ?? 0, 0) },
      { label: `Paid ${V.unit} to date`, value: fmt(paid.unitsToDate ?? 0) },
      { label: `Cost per ${unitWord}, whole period`, value: paid.cumCost ? fmtMoney(paid.cumCost, 2) : "–" },
      { label: `Cost per ${unitWord}, ${winWords}`, value: costRecent ? fmtMoney(costRecent, 2) : "–" },
      { label: `Plan (${paid.costPlanSource === "release" ? "typed" : "the basket's median"})`, value: plan !== null ? fmtMoney(plan, 2) : "–" },
      ...(roiOk ? [{ label: `At the ${ratio(roiTarget)} target ROI`, value: fmtMoney(atTarget, 2) }] : []),
    ],
    body: (V.state === "signups"
      ? "Meta's spend under the campaign code before the open, over the paid signups it bought on each day (the signups the feed attributes to paid, with untracked signups folded in at the tracked paid share). "
      : "Meta's spend under the campaign code inside the window, over the paid units sold on each day. ")
      + `The line is the ${winWords}; the plan is the price the ${period} budget was set at.`
      + (roiOk ? ` The dotted line is the most a paid ${unitWord} can cost Avant Arte at the target ROI (the ROI view's working).` : ` ${needsProfit}.`),
  };
  const roiTip = {
    head: `${P.label} ROI - how it is read`,
    rows: [
      { label: `${P.label} profit per unit`, value: fmtMoney(P.ppu ?? 0, 2) },
      ...(party === "aa" ? [{ label: `+ likely framing profit (${pct(paid.frameShare)} of units framed × ${pct(paid.frameRate)} take-up × ${fmtMoney(paid.frameProfit ?? 0, 0)} a frame)`, value: fmtMoney(P.uplift, 2) }] : []),
      { label: "less cannibalisation", value: pct(paid.cannibalisation ?? 0) },
      ...(unitWord === "signup" ? [
        { label: "× pieces per order", value: fmt(paid.piecesPerOrder ?? 1, 2) },
        { label: "× paid signup → order rate", value: pct(paid.signupOrderRate) },
      ] : []),
      { label: `= worth of a paid ${unitWord} to ${P.label}`, value: fmtMoney(P.value ?? 0, 2) },
      { label: complete ? `÷ cost per ${unitWord}, whole ${period}` : `÷ cost per ${unitWord}, ${winWords}`, value: costUsed ? fmtMoney(costUsed, 2) : "–" },
      { label: `÷ ${P.label} share of the spend${splitAssumed ? " (assumed)" : ""}`, value: pct(P.share) },
      { label: complete ? `= ${P.label} ROI` : `= ${P.label} ROI, ${winWords}`, value: ratio(leadVal) },
      { label: "ROI total", value: ratio(P.cum) },
      { label: "Target ROI", value: ratio(roiTarget) },
      ...(party === "aa" ? [
        { label: `Cost per ${unitWord} at the target`, value: has(paid.costAtTargetRoi) ? fmtMoney(paid.costAtTargetRoi, 2) : "–" },
        { label: `Break-even cost per ${unitWord}`, value: has(paid.breakEvenCost) ? fmtMoney(paid.breakEvenCost, 2) : "–" },
      ] : []),
      { label: `Cost per ${unitWord} ${winShort}`, value: costRecent ? fmtMoney(costRecent, 2) : "–" },
      { label: `Cost per ${unitWord} total`, value: paid.cumCost ? fmtMoney(paid.cumCost, 2) : "–" },
    ],
    body: `What paid bought, at what it is assumed to be worth to ${party === "aa" ? "Avant Arte" : "the artist"}, over what it cost ${party === "aa" ? "Avant Arte" : "the artist"}. `
      + (party === "aa" ? "A unit sold is worth AA's profit on it plus the likely framing profit, which is Avant Arte's alone; " : "A unit sold is worth the artist's profit on it; ")
      + (unitWord === "signup"
        ? `a paid signup is worth that for the pieces an order takes, at the share of paid signups that go on to order (${S2O_WORDS[paid.signupOrderRateSource] || S2O_WORDS.none}), net of cannibalisation. `
        : "a paid sale is worth that net of cannibalisation. ")
      + `The frame take-up is ${FRAME_WORDS[paid.frameRateSource] || FRAME_WORDS.default}; the profits per unit and per frame, the pieces per order and the deal are the Target setting tab's (products and economics, assumptions; Airtable's figures where none is typed). `
      + "The spend divides as the profit does: on a profit share each side carries its share of the ads, on a revenue share Avant Arte carries them all"
      + (splitAssumed ? "; no work records its deal yet, so half is assumed. " : ". ")
      + `The dotted end is the ETL's forward path: today's spend along the cost path, each ${unitWord} dearer as the campaign's spend adds up (etl/build.py CostPath on the panel's priors, the campaign's own fit once it has the days).`,
  };
  const moreTip = view === "roi" ? roiTip : costTip;
  const targetLine = roiTarget !== null ? `\nTarget ${ratio(roiTarget)}` : "";
  const todayTip = `${P.label} ROI ${winWords} ${ratio(P.recent)}${targetLine}`;
  const projTip = `Projected ${P.label} ROI at the ${V.closeWord} ${ratio(declineEnd ? declineEnd.v : null)}${win === "1d" ? " (the cost path from the last full day's price)" : ""}${targetLine}`;
  const statVal = { fontSize: 13, fontWeight: 600, color: C.ink };
  const statRow = { display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" };
  const totals = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flex: "0 0 auto", fontSize: 12, color: C.muted }}>
      <span style={statRow} title={`Cost per ${unitWord}, the whole ${period}: spend over the paid ${V.unit} it bought`}>
        cost per {unitWord} total <span className="num" style={statVal}>{paid.cumCost ? fmtMoney(paid.cumCost, 2) : "–"}</span>
      </span>
      {view === "roi" ? (
        <span style={statRow} title={`Cumulative ${P.label} ROI: what every paid ${unitWord} to date is worth to ${P.label} over what they cost ${P.label}, the whole ${period}`}>
          ROI total <span className="num" style={statVal}>{ratio(P.cum)}</span>
        </span>
      ) : (
        <span style={statRow}>
          paid {V.unit} <span className="num" style={statVal}>{fmt(paid.unitsToDate ?? 0)}</span>
        </span>
      )}
    </div>
  );

  // ----- the axis and the names on the plot -----
  const todayFrac = today / of;
  const startText = dayAxisLabel(snap, 0), endText = dayAxisLabel(snap, of);
  const xAxis = timeAxis({ rowW: plotW, frac: todayFrac, live: !complete, startText, endText });
  const offWords = lastSpend ? (hours ? `paid off · last spend ${lastSpend.date}` : `paid off · last spend day ${Math.round(lastSpend.mid)}`) : "";
  let names = [];
  if (plotW > 0 && plotH > 0) {
    const sx = plotW / W, sy = plotH / H;
    const curves = [
      ...(linePts.length >= 2 ? [{ pts: linePts.map((p) => ({ x: x(p.mid) * sx, y: y(p.v) * sy })) }] : []),
      ...(decline.length >= 2 ? [{ pts: decline.map((p) => ({ x: x(p.mid) * sx, y: y(p.v) * sy })) }] : []),
      ...refs.map((r) => ({ pts: [{ x: 0, y: y(r.v) * sy }, { x: plotW, y: y(r.v) * sy }] })),
      ...(!complete ? [{ pts: [{ x: x(today) * sx, y: 0 }, { x: x(today) * sx, y: plotH }] }] : []),
    ];
    const dot = (st, v) => ({ x0: x(st) * sx - 7, y0: y(v) * sy - 7, x1: x(st) * sx + 7, y1: y(v) * sy + 7 });
    const blocks = [
      ...bars.map((b) => ({ x0: +b.x * sx, y0: +b.y * sy, x1: (+b.x + +b.w) * sx, y1: plotH })),
      ...(lastPt ? [dot(lastPt.mid, lastPt.v)] : []),
      ...(showModel && declineEnd ? [dot(of, declineEnd.v), { x0: plotW + 8, y0: y(declineEnd.v) * sy - 8, x1: plotW + 12 + textPx("projected"), y1: y(declineEnd.v) * sy + 8 }] : []),
    ];
    const label = (key, text, title, anchors, extra) => ({ key, text, title, anchors, color: C.muted, weight: 400, w: textPx(text), h: 14, ...extra });
    const standing = bars.filter((b) => !b.partial && +b.h * sy >= 3);
    const tops = (standing.length ? standing : bars).map((b) => ({ x: (+b.x + +b.w / 2) * sx, y: +b.y * sy, cost: 0 }));
    const labels = [
      ...(paidOff && lastPt ? [label("off", offWords, "No paid spend in the last two days: the line ends where the spend did", [{ x: x(lastPt.mid) * sx, y: y(lastPt.v) * sy, cost: 0 }], { dot: 7.5 })] : []),
      ...refs.filter((r) => r.text).map((r) => label(r.key, r.text, r.title, [{ x: plotW * 0.3, y: y(r.v) * sy, cost: 0 }, { x: plotW * 0.7, y: y(r.v) * sy, cost: 1 }])),
      ...(tops.length ? [label("spend", "daily spend", `Daily spend bars on their own axis: €0 to €${fmt(spendHi)}`, tops)] : []),
    ];
    names = nameLines({ labels, curves, blocks, bounds: { x0: 0, y0: 0, x1: plotW, y1: plotH } });
  }
  const byStep = (st) => pts.find((p) => st >= p.a && st < p.b) || null;
  const projAt = (st) => { const p = decline.find((q) => Math.abs(q.mid - st) <= span / 2) || null; return p && p !== anchor ? p.v : null; };

  const axisLabel = { position: "absolute", left: 0, transform: "translate(-100%,-50%)", paddingRight: 8, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const xLabel = { position: "absolute", top: "100%", paddingTop: 6, fontSize: 12, color: C.muted, whiteSpace: "nowrap" };
  const lastTitle = !lastPt ? "" : view === "roi" ? (complete ? `${P.label} ROI final ${ratio(P.cum)}${targetLine}` : todayTip)
    : `Cost per ${unitWord}, ${winWords}: ${fmtMoney(lastPt.v, 2)}`;

  return (
    <Card wide dot={GROUP_DOTS.paid} title={title} right={right}>
      <div className="spacer-8" />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flex: "0 0 auto" }}>
        <div className="lead">
          <span>{lead}</span>
          <span style={{ fontSize: 12, fontWeight: 400, letterSpacing: 0, color: C.muted, whiteSpace: "nowrap" }}>{leadCaption}</span>
          <QBadge content={moreTip} />
          {splitAssumed && (
            <span title="No work records its deal, so Avant Arte is assumed to carry half the paid spend. Type each work's AA profit share (or AA revenue share) on the Target setting tab: the spend divides as the profit does."
              style={{ fontSize: 11.5, fontWeight: 500, letterSpacing: 0, color: C.amber, whiteSpace: "nowrap" }}>50/50 split assumed</span>
          )}
        </div>
        {totals}
      </div>
      <div style={{ height: 12, flex: "0 0 12px" }} />
      <div className="body">
        <div style={{ position: "relative", flex: 1 }}>
          <div
            ref={plotRef}
            style={{ position: "absolute", left: 56, right: 56, top: 0, bottom: 24 }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
              setHover(Math.min(Math.max(frac * of, 0), of));
            }}
            onMouseLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}>
              <line x1="0" y1={H} x2={W} y2={H} stroke={C.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke={C.hairline} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {bars.map((b) => (
                <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill={C.track}><title>{b.tip}</title></rect>
              ))}
              {refs.map((r) => (
                <line key={r.key} x1="0" y1={y(r.v).toFixed(1)} x2={W} y2={y(r.v).toFixed(1)} stroke={C.refLine} strokeWidth="1.5"
                  strokeDasharray={r.dash ? "2 3" : undefined} vectorEffect="non-scaling-stroke"><title>{r.title}</title></line>
              ))}
              {declinePath && (
                <path d={declinePath} fill="none" stroke={C.blueLight} strokeWidth="2.6" strokeDasharray="6 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {linePath && (
                <path d={linePath} fill="none" stroke={C.blue} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
              {!complete && (
                <line x1={x(today).toFixed(1)} y1="0" x2={x(today).toFixed(1)} y2={H} stroke={C.todayLine} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {hover !== null && (() => {
              const p = byStep(hover);
              const proj = showModel ? projAt(hover) : null;
              if (!p && proj === null) return null;
              const cost = p && !p.partial && has(p[costKey]) ? p[costKey] : null;
              const roi = p && !p.partial && has(p[P.key]) ? p[P.key] : null;
              const mark = view === "roi" ? (roi ?? proj) : cost;
              const at = p ? p.mid : hover;
              return (
                <>
                  <div style={{ position: "absolute", left: leftPct(at), top: 0, bottom: 0, width: 1, background: "#ddd9cf", pointerEvents: "none" }} />
                  {mark !== null && (
                    <div style={{ position: "absolute", left: leftPct(at), top: topPct(mark), width: 7, height: 7, margin: "-3.5px 0 0 -3.5px", borderRadius: "50%", background: roi !== null || view === "cost" ? C.blue : C.blueLight, boxShadow: "0 0 0 2px #fff", pointerEvents: "none" }} />
                  )}
                  <ChartTip left={leftPct(at)}>
                    <div className="t-head">{p ? (hours ? p.date : dayLabel(snap, Math.round(p.mid), true)) : dayLabel(snap, Math.round(hover), true)}{p && p.partial ? " · so far today" : ""}</div>
                    {roiOk && p && <div className="t-row"><span>{P.label} ROI ({win})</span><span className="v">{ratio(roi)}</span></div>}
                    {roiOk && roi === null && proj !== null && <div className="t-row"><span>ROI projected</span><span className="v">{ratio(proj)}</span></div>}
                    {p && <div className="t-row"><span>Spend</span><span className="v">€{fmt(p.spend, 2)}</span></div>}
                    {p && <div className="t-row"><span>Paid {V.unit}</span><span className="v">{fmt(p.entries ?? 0)}</span></div>}
                    {p && <div className="t-row"><span>Cost per {unitWord} ({win})</span><span className="v">{cost !== null ? fmtMoney(cost, 2) : "–"}</span></div>}
                  </ChartTip>
                </>
              );
            })()}

            {lastPt && (
              <div title={lastTitle}
                style={{ position: "absolute", left: leftPct(lastPt.mid), top: topPct(lastPt.v), width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%", background: C.blue, boxShadow: "0 0 0 2px #fff" }} />
            )}
            {showModel && declineEnd && (
              <>
                <div title={projTip}
                  style={{ position: "absolute", left: "100%", top: topPct(declineEnd.v), width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%",
                    background: "#fff", border: `2.2px solid ${C.blueLight}`, boxSizing: "border-box" }} />
                <div style={{ position: "absolute", left: "100%", top: topPct(declineEnd.v), transform: "translateY(-50%)", paddingLeft: 10, fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
                  projected
                </div>
              </>
            )}
            {linePts.length > 0 && <div style={{ ...axisLabel, top: 0 }}>{view === "roi" ? ratio(hi) : `€${fmt(hi, hi < 10 ? 1 : 0)}`}</div>}
            {linePts.length > 0 && <div style={{ ...axisLabel, top: "100%" }}>{view === "roi" ? ratio(lo) : "€0"}</div>}
            <LineNames names={names} />
            {xAxis.start && <div style={{ ...xLabel, left: 0 }} title={V.state === "signups" ? "the announce" : "the sales open"}>{startText}</div>}
            {!complete && (
              <div style={{ ...xLabel, color: C.ink, ...(xAxis.todayLeft === null ? { left: leftPct(today), transform: "translateX(-50%)" } : { left: xAxis.todayLeft }) }}>today</div>
            )}
            {xAxis.end && <div style={{ ...xLabel, left: "100%", transform: "translateX(-100%)" }} title={`the ${V.closeWord}`}>{endText}</div>}
          </div>
        </div>
      </div>
    </Card>
  );
}
