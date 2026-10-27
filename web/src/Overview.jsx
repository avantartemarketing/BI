/* The Overview's cards, in the order the page shows them, two to a row with
 * the trajectory and the funnel table across both. A card a release has
 * nothing for is left out; before a release has numbers the page shows what
 * it knows instead (Upcoming, no targets, catalogue). */
import React from "react";
import Trajectory from "./modules/Trajectory.jsx";
import SellThroughClose from "./modules/SellThroughClose.jsx";
import SpendLevels from "./modules/SpendLevels.jsx";
import ChannelsVsTargets from "./modules/ChannelsVsTargets.jsx";
import Waterfall from "./modules/Waterfall.jsx";
import PaidRoi from "./modules/PaidRoi.jsx";
import PaidSpend from "./modules/PaidSpend.jsx";
import SellThrough from "./modules/SellThrough.jsx";
import Framing from "./modules/Framing.jsx";
import EmailFunnel from "./modules/EmailFunnel.jsx";
import FunnelTable from "./modules/FunnelTable.jsx";
import Geo from "./modules/Geo.jsx";
import SellForecast from "./modules/SellForecast.jsx";
import FramingForecast from "./modules/FramingForecast.jsx";
import { TLSignupsOutcome } from "./TLPage.jsx";
import Upcoming from "./modules/Upcoming.jsx";

export default function Overview({ snap, base, horizon, onSetup, onOpen }) {
  const isTL = snap.type === "TL";
  const targeted = snap.targeted !== false;
  // before the announce (a timed launch before its signups open too) the page shows what it knows
  if (snap.upcoming || (isTL && snap.tlState === "upcoming")) return <div className="body plain"><Upcoming snap={snap} onSetup={onSetup} /></div>;
  const preWindow = isTL && (snap.tlState === "signups" || snap.tlState === "upcoming");
  const framingOn = !!(snap.framing && (snap.framing.prints > 0 || (snap.framing.works || []).length));
  return (
    <div className="body">
      <div className="grid2">
        <Trajectory snap={snap} horizon={horizon} />
        {!isTL && snap.closeForecast && <SellThroughClose snap={snap} />}
        {!isTL && snap.paid && snap.paid.levels && <SpendLevels snap={snap} />}
        <ChannelsVsTargets snap={snap} horizon={horizon} />
        {targeted && <Waterfall snap={snap} horizon={horizon} />}
        {isTL && !preWindow && snap.sales && <TLSignupsOutcome snap={snap} />}
        {snap.paid && <PaidRoi snap={snap} horizon={horizon} />}
        {snap.paid && <PaidSpend snap={snap} horizon={horizon} />}
        {preWindow && snap.sellForecast && <SellForecast snap={snap} horizon={horizon} />}
        {preWindow && snap.sellForecast && framingOn && <FramingForecast snap={snap} horizon={horizon} />}
        {!preWindow && (snap.sellthrough || snap.sales) && <SellThrough snap={snap} horizon={horizon} />}
        {!preWindow && framingOn && <Framing snap={snap} horizon={horizon} />}
        {snap.email && <EmailFunnel snap={snap} />}
        <FunnelTable snap={snap} />
        {!isTL && snap.geo && <Geo snap={snap} />}
      </div>
    </div>
  );
}
