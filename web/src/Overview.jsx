/* The Overview's cards, in the order the page shows them (11 November 2026;
 * the Suggested actions card above them all on a live draw launch, 12 November;
 * on the plan-based view the trajectory first, then the plan card and the
 * Suggested actions, 26 November; a heading over each section, "Plan" between
 * the trajectory and the plan's cards and "Sell through" under the Suggested
 * actions, 27 November, when the page had grown long),
 * two to a row with the sell-through table and the trajectory across both,
 * in three sections: the outcome (the trajectory; the sell-through table, a
 * row per work today and at the close, on a timed launch before its window
 * the forecast table in its place; the sell-through bars by product and
 * at close; framing and where the orders ship), the channels and the funnel (channels against
 * targets and the gap; the funnel by channel and the email funnel) and paid
 * (ROI and the spend levels; on a release selling lines of work, the All
 * lines view shows the pair once per line, each on its line's ad set and
 * with its own recommendation). The Paid spend card is gone: its spend by day
 * is on the Paid ROI chart, its recommendation on the Spend levels card,
 * which stays on a draw launch with no level to give and says why. Two more
 * keep their place and say so: Framing ("No framing") and, on a draw launch
 * in flight, Suggested actions ("No suggested actions"). Any other card a
 * release has nothing for is left out; before a release has numbers
 * the page shows what it knows instead (Upcoming, no targets, catalogue). */
import React, { useState } from "react";
import { Bars, Caret, Euro, Filter, Lines } from "./icons.jsx";
import Trajectory from "./modules/Trajectory.jsx";
import SpendLevels from "./modules/SpendLevels.jsx";
import AdsetEntries from "./modules/AdsetEntries.jsx";
import ChannelsVsTargets from "./modules/ChannelsVsTargets.jsx";
import Waterfall from "./modules/Waterfall.jsx";
import PaidRoi from "./modules/PaidRoi.jsx";
import SellThroughClose from "./modules/SellThroughClose.jsx";
import SellThrough from "./modules/SellThrough.jsx";
import SellThroughTable from "./modules/SellThroughTable.jsx";
import Framing from "./modules/Framing.jsx";
import EmailFunnel from "./modules/EmailFunnel.jsx";
import FunnelTable from "./modules/FunnelTable.jsx";
import Geo from "./modules/Geo.jsx";
import SellForecast from "./modules/SellForecast.jsx";
import TLForecastTable from "./modules/TLForecastTable.jsx";
import FramingForecast from "./modules/FramingForecast.jsx";
import { TLSignupsOutcome } from "./TLPage.jsx";
import Upcoming from "./modules/Upcoming.jsx";
import PlanChanges from "./modules/PlanChanges.jsx";
import PlanCard from "./modules/PlanCard.jsx";
import "./cards.css";

/* The sections a reader has folded away, kept per browser like the page's other switches: a section's key
 * ("plan", "sell", "channels", "paid", or "paid:" and a line's key) and true. A folded section is its heading
 * alone, on every launch's page until it is opened again. */
const FOLD_PREF = "sectionsShut";
const readShut = () => { try { const v = JSON.parse(localStorage.getItem(FOLD_PREF) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/* a section's heading, across both columns: a band with the section's glyph and its name, which folds the
 * section under it away and opens it again (27 November 2026, the owner's pick of three drawn that day, with
 * the name at a heading's size; until then a quiet label in small capitals) */
const Sect = ({ children, icon, shut, onFold }) => (
  <h2 className={`wide sect${shut ? " shut" : ""}`}>
    <button type="button" aria-expanded={!shut} onClick={onFold}><span className="caret"><Caret /></span>{icon}<span className="sn">{children}</span></button>
  </h2>
);
// the paid section's heading on a line of work: what is read is the line's ad
// set, spend and return (docs 7b), so the heading says so; a line with no ad
// set named keeps its name alone
const paidHead = (name, adsets) => `Paid · ${name}${(adsets || []).length > 1 ? " ad sets" : (adsets || []).length ? " ad set" : ""}`;

export default function Overview({ snap, base, actions, vs, horizon, onSetup, onOpen, lineViews }) {
  const [shut, setShut] = useState(readShut);   // the sections folded away (before any return: a hook runs on every draw)
  const isTL = snap.type === "TL";
  const targeted = snap.targeted !== false;
  // before the announce (a timed launch before its signups open too) the page shows what it knows
  if (snap.upcoming || (isTL && snap.tlState === "upcoming")) return <div className="body plain"><Upcoming snap={snap} onSetup={onSetup} /></div>;
  const preWindow = isTL && (snap.tlState === "signups" || snap.tlState === "upcoming");
  const framingOn = !!(snap.framing && (snap.framing.prints > 0 || (snap.framing.works || []).length));
  // the Suggested actions card stays on a draw launch in flight with nothing to suggest, and says so
  // (a timed launch has the card on its plan-based view alone, where its suggestions are built)
  const actionsOn = isTL ? (snap.method === "plan" && !!snap.planChanges) : !snap.line && (!!snap.planChanges || (!snap.complete && !snap.catalogue));
  const geoOn = !isTL && !!(snap.geo && (Array.isArray(snap.geo) ? snap.geo.length : (snap.geo.rows || []).length));
  const paidOn = !!snap.paid;
  // the plan-based view (the page's switch, docs/PLAN_MODEL.md): the trajectory leads, as on the clock's page,
  // with the plan card and the suggested actions under it (26 November 2026, at the owner's asking; the plan
  // card led until then), and before anything has gone out the page is the plan alone
  const planOn = snap.method === "plan" && !!snap.plan;
  const planStart = planOn && snap.plan.state === "start";
  // the Spend levels card is on every draw launch with a paid block: without
  // a level from the build it says why there is none (12 November 2026)
  // ... and on a timed launch gathering signups once the build has a level for it (etl/tl.py spend_levels,
  // 25 November 2026): before that its Paid section said what the spend returned and not what to spend
  const levelsOn = paidOn && (!isTL || !!(snap.paid && snap.paid.levels));
  // a release selling lines of work, on the All lines view: paid per line, each its own ad set
  const paidLines = !isTL && Array.isArray(lineViews) && lineViews.length > 1 ? lineViews.filter((l) => l.snap.paid) : [];
  // the sell-through section: the table, the bars by product and at the close, framing and where the orders ship
  const sellOn = !!(snap.sellthrough || snap.sales || snap.sellForecast || snap.closeForecast || geoOn);
  const fold = (k) => () => { const next = { ...shut, [k]: !shut[k] }; setShut(next); try { localStorage.setItem(FOLD_PREF, JSON.stringify(next)); } catch { /* per-browser convenience only */ } };
  const open = (k) => !shut[k];
  return (
    <div className="body">
      <div className="grid2">
        {planOn && <Trajectory snap={snap} vs={vs} horizon={horizon} />}
        {planOn && <Sect icon={<Lines />} shut={!open("plan")} onFold={fold("plan")}>Plan</Sect>}
        {planOn && open("plan") && <PlanCard snap={snap} />}
        {actionsOn && !planStart && (!planOn || open("plan")) && <PlanChanges snap={snap} state={actions} />}
        {!planOn && <Trajectory snap={snap} vs={vs} horizon={horizon} />}
        {sellOn && <Sect icon={<Bars />} shut={!open("sell")} onFold={fold("sell")}>Sell through</Sect>}
        {open("sell") && (
          <>
            {!isTL && !preWindow && snap.sellthrough && <SellThroughTable snap={snap} />}
            {preWindow && snap.sellForecast && <TLForecastTable snap={snap} />}
            {preWindow && snap.sellForecast && <SellForecast snap={snap} horizon={horizon} />}
            {preWindow && snap.sellForecast && framingOn && <FramingForecast snap={snap} horizon={horizon} />}
            {!preWindow && (snap.sellthrough || snap.sales) && <SellThrough snap={snap} horizon={horizon} />}
            {!isTL && snap.closeForecast && <SellThroughClose snap={snap} vs={vs} />}
            {!preWindow && !planStart && <Framing snap={snap} horizon={horizon} />}
            {geoOn && <Geo snap={snap} />}
            {isTL && !preWindow && snap.sales && <TLSignupsOutcome snap={snap} vs={vs} />}
          </>
        )}
        <Sect icon={<Filter />} shut={!open("channels")} onFold={fold("channels")}>{planStart ? "The plan by channel" : "Channels and funnel"}</Sect>
        {open("channels") && (
          <>
            <ChannelsVsTargets snap={snap} vs={vs} horizon={planStart ? "close" : horizon} />
            {!planStart && <FunnelTable snap={snap} vs={vs} />}
            {targeted && vs && !planStart && <Waterfall snap={snap} vs={vs} horizon={horizon} />}
            {snap.email && <EmailFunnel snap={snap} vs={vs} />}
          </>
        )}
        {paidLines.length > 0 ? paidLines.map((l) => (
          <React.Fragment key={`paid:${l.key}`}>
            <Sect icon={<Euro />} shut={!open(`paid:${l.key}`)} onFold={fold(`paid:${l.key}`)}>{paidHead(l.name, (l.snap.line || {}).adsets || l.adsets)}</Sect>
            {open(`paid:${l.key}`) && (
              <>
                <PaidRoi snap={l.snap} horizon={horizon} />
                <SpendLevels snap={l.snap} />
                {l.snap.paid.adsetEntries && <AdsetEntries snap={l.snap} />}
              </>
            )}
          </React.Fragment>
        )) : paidOn && (
          <>
            <Sect icon={<Euro />} shut={!open("paid")} onFold={fold("paid")}>{snap.line && snap.line.name ? paidHead(snap.line.name, snap.line.adsets) : "Paid"}</Sect>
            {open("paid") && (
              <>
                <PaidRoi snap={snap} horizon={horizon} />
                {levelsOn && <SpendLevels snap={snap} />}
                {snap.paid.adsetEntries && <AdsetEntries snap={snap} />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
