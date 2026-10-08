/* The sidebar's sections: where a release's row sits (App.jsx groups).
 *
 * The build's status says what the page is: live (the funnel has rows for
 * it and the close is ahead), upcoming (a launch Airtable knows and the
 * funnel does not yet), closed, catalogue. The sidebar reads it with one
 * change: a live release whose announce is still ahead sits under Upcoming
 * with the days to it, beside the launches Airtable alone knows, as a timed
 * launch before its announce does (TL_SPEC 9). In flight is announced and
 * not yet closed. Before 8 October 2026 such a release sat last in flight
 * with its opening date (Ai Weiwei's Lego draw, announced 29 October, read
 * "opens 22 d" there because its page already had traffic). */

/* The row's clock from the close and the campaign length the build wrote:
 * the announce, the days left to the close and the days to the announce on
 * the index's as-of day (asOf), or null without a close on file. */
export function releaseClock(r, asOf) {
  if (!r.windowEnd || !(r.of > 0)) return null;
  const launch = new Date(r.windowEnd + "T00:00:00Z");
  const announce = new Date(launch.getTime() - r.of * 86400000);
  const today = asOf ? new Date(asOf + "T00:00:00Z") : null;
  const days = (a, b) => Math.round((a - b) / 86400000);
  return {
    launch, announce,
    daysLeft: today ? days(launch, today) : r.of - (r.day || 0),
    opensIn: today ? days(announce, today) : 0,
  };
}

export function sectionOf(r, asOf) {
  const status = r.status || (r.complete ? "closed" : "live");
  if (status !== "live") return status;
  const c = releaseClock(r, asOf);
  return c && c.opensIn > 0 ? "upcoming" : "live";
}
