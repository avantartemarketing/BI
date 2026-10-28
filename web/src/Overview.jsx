/* The Overview's cards, in the order the page shows them (28 October 2026),
 * two to a row with the trajectory across both, in three sections: the
 * outcome (the trajectory; sell-through today and at close; framing and
 * where the orders ship), the channels and the funnel (channels against
 * targets and the gap; the funnel by channel and the email funnel) and paid
 * (ROI and the spend levels). The Paid spend card is gone: its spend by day
 * is on the Paid ROI chart, its recommendation on the Spend levels card. A
 * card a release has nothing for is left out; before a release has numbers
 * the page shows what it knows instead (Upcoming, no targets, catalogue). */
import React from "react";
import Trajectory from "./modules/Trajectory.jsx";
import SellThroughClose from "./modules/SellThroughClose.jsx";
import SpendLevels from "./modules/SpendLevels.jsx";
import ChannelsVsTargets from "./modules/ChannelsVsTargets.jsx";
import Waterfall from "./modules/Waterfall.jsx";
import PaidRoi from "./modules/PaidRoi.jsx";
import SellThrough from "./modules/SellThrough.jsx";
import Framing from "./modules/Framing.jsx";
import EmailFunnel from "./modules/EmailFunnel.jsx";
import FunnelTable from "./modules/FunnelTable.jsx";
import Geo from "./modules/Geo.jsx";
import SellForecast from "./modules/SellForecast.jsx";
import FramingForecast from "./modules/FramingForecast.jsx";
import { TLSignupsOutcome } from "./TLPage.jsx";
import Upcoming from "./modules/Upcoming.jsx";
import "./cards.css";

/* a section's heading, across both columns */
const Sect = ({ children }) => <div className="wide sect">{children}</div>;

export default function Overview({ snap, base, horizon, onSetup, onOpen }) {
  const isTL = snap.type === "TL";
  const targeted = snap.targeted !== false;
  // before the announce (a timed launch before its signups open too) the page shows what it knows
  if (snap.upcoming || (isTL && snap.tlState === "upcoming")) return <div className="body plain"><Upcoming snap={snap} onSetup={onSetup} /></div>;
  const preWindow = isTL && (snap.tlState === "signups" || snap.tlState === "upcoming");
  const framingOn = !!(snap.framing && (snap.framing.prints > 0 || (snap.framing.works || []).length));
  const geoOn = !isTL && !!(snap.geo && (Array.isArray(snap.geo) ? snap.geo.length : (snap.geo.rows || []).length));
  const paidOn = !!snap.paid;
  const levelsOn = !isTL && paidOn && !!snap.paid.levels;
  return (
    <div className="body">
      <div className="grid2">
        <Trajectory snap={snap} horizon={horizon} />
        {preWindow && snap.sellForecast && <SellForecast snap={snap} horizon={horizon} />}
        {preWindow && snap.sellForecast && framingOn && <FramingForecast snap={snap} horizon={horizon} />}
        {!preWindow && (snap.sellthrough || snap.sales) && <SellThrough snap={snap} horizon={horizon} />}
        {!isTL && snap.closeForecast && <SellThroughClose snap={snap} />}
        {!preWindow && framingOn && <Framing snap={snap} horizon={horizon} />}
        {geoOn && <Geo snap={snap} />}
        {isTL && !preWindow && snap.sales && <TLSignupsOutcome snap={snap} />}
        <Sect>Channels and funnel</Sect>
        <ChannelsVsTargets snap={snap} horizon={horizon} />
        {targeted && <Waterfall snap={snap} horizon={horizon} />}
        <FunnelTable snap={snap} />
        {snap.email && <EmailFunnel snap={snap} />}
        {paidOn && (
          <>
            <Sect>Paid</Sect>
            <PaidRoi snap={snap} horizon={horizon} />
            {levelsOn && <SpendLevels snap={snap} />}
          </>
        )}
      </div>
    </div>
  );
}
