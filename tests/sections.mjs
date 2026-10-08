/* Where a release's row sits in the sidebar (web/src/sections.mjs): a live
 * release whose announce is still ahead sits under Upcoming, announced ones
 * in flight, and the build's other statuses stand.  node tests/sections.mjs */
import assert from "node:assert";
import { sectionOf, releaseClock } from "../web/src/sections.mjs";

const asOf = "2026-10-08";
// a draw announced in three weeks whose page already has traffic (the build says live): upcoming, 21 days to its announce
const lego = { type: "LE", status: "live", day: 0, of: 32, windowEnd: "2026-11-30", complete: false };
assert.strictEqual(sectionOf(lego, asOf), "upcoming");
assert.strictEqual(releaseClock(lego, asOf).opensIn, 21);
assert.strictEqual(releaseClock(lego, asOf).daysLeft, 53);
// announced today, and announced a week ago: in flight
assert.strictEqual(sectionOf({ type: "LE", status: "live", day: 0, of: 28, windowEnd: "2026-11-05" }, asOf), "live");
assert.strictEqual(sectionOf({ type: "LE", status: "live", day: 7, of: 28, windowEnd: "2026-10-29" }, asOf), "live");
// a timed launch taking signups (its announce has passed): in flight
assert.strictEqual(sectionOf({ type: "TL", status: "live", tlState: "signups", day: 16, of: 30, windowEnd: "2026-10-15" }, asOf), "live");
// the build's other statuses stand
assert.strictEqual(sectionOf({ status: "upcoming", windowEnd: "2026-12-01", of: 30 }, asOf), "upcoming");
assert.strictEqual(sectionOf({ status: "closed", windowEnd: "2026-09-01", of: 30 }, asOf), "closed");
assert.strictEqual(sectionOf({ status: "catalogue", of: 90 }, asOf), "catalogue");
assert.strictEqual(sectionOf({ complete: true, windowEnd: "2026-09-01", of: 30 }, asOf), "closed");
// no close on file: no clock, in flight as the build said
assert.strictEqual(releaseClock({ status: "live", of: 0 }, asOf), null);
assert.strictEqual(sectionOf({ status: "live", of: 0 }, asOf), "live");
// without an as-of day the clock counts from the row's own day and nothing is "still to announce"
assert.strictEqual(releaseClock(lego, null).opensIn, 0);
assert.strictEqual(sectionOf(lego, null), "live");
console.log("sections: ok");
