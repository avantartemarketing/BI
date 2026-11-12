/* The Overview's cards, in the order the page shows them (11 November 2026;
 * the Suggested actions card above them all on a live draw launch, 12 November),
 * two to a row with the sell-through table and the trajectory across both,
 * in three sections: the outcome (the trajectory; the sell-through table, a
 * row per work today and at the close; the sell-through bars by product and
 * at close; framing and where the orders ship), the channels and the funnel (channels against
 * targets and the gap; the funnel by channel and the email funnel) and paid
 * (ROI and the spend levels; on a release selling lines of work, the All
 * lines view shows the pair once per line, each on its line's ad set and
 * with its own recommendation). The Paid spend card is gone: its spend by day
 * is on the Paid ROI chart, its recommendation on the Spend levels card. A
 * card a release has nothing for is left out, but for two that keep their
 * place and say so: Framing ("No framing") and, on a draw launch in flight,
 * Suggested actions ("No suggested actions"); before a release has numbers
 * the page shows what it knows instead (Upcoming, no targets, catalogue). */
import React from "react";
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
import FramingForecast from "./modules/FramingForecast.jsx";
import { TLSignupsOutcome } from "./TLPage.jsx";
import Upcoming from "./modules/Upcoming.jsx";
import PlanChanges from "./modules/PlanChanges.jsx";
import "./cards.css";

/* a section's heading, across both columns */
const Sect = ({ children }) => <div className="wide sect">{children}</div>;
// the paid section's heading on a line of work: what is read is the line's ad
// set, spend and return (docs 7b), so the heading says so; a line with no ad
// set named keeps its name alone
const paidHead = (name, adsets) => `Paid · ${name}${(adsets || []).length > 1 ? " ad sets" : (adsets || []).length ? " ad set" : ""}`;

export default function Overview({ snap, base, vs, horizon, onSetup, onOpen, lineViews }) {
  const isTL = snap.type === "TL";
  const targeted = snap.targeted !== false;
  // before the announce (a timed launch before its signups open too) the page shows what it knows
  if (snap.upcoming || (isTL && snap.tlState === "upcoming")) return <div className="body plain"><Upcoming snap={snap} onSetup={onSetup} /></div>;
  const preWindow = isTL && (snap.tlState === "signups" || snap.tlState === "upcoming");
  const framingOn = !!(snap.framing && (snap.framing.prints > 0 || (snap.framing.works || []).length));
  // the Suggested actions card stays on a draw launch in flight with nothing to suggest, and says so
  const actionsOn = !isTL && !snap.line && (!!snap.planChanges || (!snap.complete && !snap.catalogue));
  const geoOn = !isTL && !!(snap.geo && (Array.isArray(snap.geo) ? snap.geo.length : (snap.geo.rows || []).length));
  const paidOn = !!snap.paid;
  const levelsOn = !isTL && paidOn && !!snap.paid.levels;
  // a release selling lines of work, on the All lines view: paid per line, each its own ad set
  const paidLines = !isTL && Array.isArray(lineViews) && lineViews.length > 1 ? lineViews.filter((l) => l.snap.paid) : [];
  return (
    <div className="body">
      <div className="grid2">
        {actionsOn && <PlanChanges snap={snap} />}
        <Trajectory snap={snap} vs={vs} horizon={horizon} />
        {!isTL && !preWindow && snap.sellthrough && <SellThroughTable snap={snap} />}
        {preWindow && snap.sellForecast && <SellForecast snap={snap} horizon={horizon} />}
        {preWindow && snap.sellForecast && framingOn && <FramingForecast snap={snap} horizon={horizon} />}
        {!preWindow && (snap.sellthrough || snap.sales) && <SellThrough snap={snap} horizon={horizon} />}
        {!isTL && snap.closeForecast && <SellThroughClose snap={snap} vs={vs} />}
        {!preWindow && <Framing snap={snap} horizon={horizon} />}
        {geoOn && <Geo snap={snap} />}
        {isTL && !preWindow && snap.sales && <TLSignupsOutcome snap={snap} vs={vs} />}
        <Sect>Channels and funnel</Sect>
        <ChannelsVsTargets snap={snap} vs={vs} horizon={horizon} />
        <FunnelTable snap={snap} vs={vs} />
        {targeted && vs && <Waterfall snap={snap} vs={vs} horizon={horizon} />}
        {snap.email && <EmailFunnel snap={snap} vs={vs} />}
        {paidLines.length > 0 ? paidLines.map((l) => (
          <React.Fragment key={`paid:${l.key}`}>
            <Sect>{paidHead(l.name, (l.snap.line || {}).adsets || l.adsets)}</Sect>
            <PaidRoi snap={l.snap} horizon={horizon} />
            {l.snap.paid.levels && <SpendLevels snap={l.snap} />}
            {l.snap.paid.adsetEntries && <AdsetEntries snap={l.snap} />}
          </React.Fragment>
        )) : paidOn && (
          <>
            <Sect>{snap.line && snap.line.name ? paidHead(snap.line.name, snap.line.adsets) : "Paid"}</Sect>
            <PaidRoi snap={snap} horizon={horizon} />
            {levelsOn && <SpendLevels snap={snap} />}
            {snap.paid.adsetEntries && <AdsetEntries snap={snap} />}
          </>
        )}
      </div>
    </div>
  );
}
