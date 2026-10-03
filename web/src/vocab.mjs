/* The words a card prints for the quantity it measures. An LE page measures
 * secured units against a sellout; a timed launch (docs/TL_SPEC.md §4, §5)
 * measures signups before its window opens and units sold inside it, on the
 * same cards. The cards ask here rather than carry the TL words themselves,
 * so a card reads the same way on both and the TL words live in one place.
 * Plain JavaScript, no JSX, so the tests can import it. */

const LE = {
  tl: false, state: "le",
  unit: "units", unitOne: "unit", Unit: "Units",
  secured: "Secured", securedLower: "secured", securedUnits: "Secured units",
  toDate: "Secured to date", projected: "Projected demand",
  heroTitle: "Units vs sellout", heroTitlePartial: "Units vs target",
  sellout: "sellout", closeWord: "close", closeLabel: "At close",
  trajTitle: "Unit trajectory", channelsTitle: "Channels vs targets",
  conv: "Session → sale", convBuyer: "Session → buyer", perBuyer: "Units per buyer",
  paidCost: "Cost per secured unit", paidUnits: "Paid units", paidTitle: "Paid ROI",
  stepWord: "day", stepWordPlural: "days",
  outcomeWaterfall: "Actual vs target", projectionWaterfall: "Projection vs target",
  sellThroughTitle: "Sell-through by product",
  launches: "draw launches",   // what a cohort of references is made of
};

const TL_SIGNUPS = {
  ...LE, tl: true, state: "signups",
  unit: "signups", unitOne: "signup", Unit: "Signups",
  secured: "Signed up", securedLower: "signed up", securedUnits: "Signups",
  toDate: "Signups to date", projected: "Projected signups",
  heroTitle: "Signups vs target", heroTitlePartial: "Signups vs target",
  sellout: "target", closeWord: "open", closeLabel: "At the open",
  trajTitle: "Signup trajectory",
  conv: "Session → signup", convBuyer: "Session → signup", perBuyer: "Signups per person",
  paidCost: "Cost per signup", paidUnits: "Paid signups", paidTitle: "Paid cost per signup",
  launches: "timed launches",
};

const TL_UNITS = {
  ...LE, tl: true, state: "window",
  secured: "Sold", securedLower: "sold", securedUnits: "Units sold",
  toDate: "Sold to date", projected: "Projected units",
  heroTitle: "Units vs target", heroTitlePartial: "Units vs target",
  sellout: "target", closeWord: "close", closeLabel: "At close",
  paidCost: "Cost per sale", paidTitle: "Paid cost per sale",
  stepWord: "hour", stepWordPlural: "hours",
  sellThroughTitle: "Sell-through by work",
};

/* The words for a snapshot: the LE's unless it is a timed launch, then the
 * state's - signups until the sales open, units from then on. */
export function wordsOf(snap) {
  if (!snap || snap.type !== "TL") return LE;
  const st = snap.tlState;
  return st === "window" || st === "settling" || st === "closed" ? TL_UNITS : TL_SIGNUPS;
}

/* Whether the page's clock runs in hours (a timed launch inside its window). */
export const hourClock = (snap) => !!(snap && snap.clock && snap.clock.unit === "hour");
