/* The days to launch on a sidebar row (web/src/rows.mjs launchWords): whole
 * days to a draw's close and to a timed launch's sale opening, "Open" inside
 * the window, the day it launched once it has.  node tests/launch_words.mjs */
import assert from "node:assert";
import { byLaunch, byLaunched, launchWords, sidebarGroups, typeOf } from "../web/src/rows.mjs";

const asOf = "2026-11-13";
// a draw in flight: the days to its close, darker inside a week
assert.deepStrictEqual(launchWords({ type: "LE", status: "live", of: 32, windowEnd: "2026-11-30" }, asOf), { text: "17d", days: 17, soon: false });
assert.deepStrictEqual(launchWords({ type: "LE", status: "live", of: 25, windowEnd: "2026-11-20" }, asOf), { text: "7d", days: 7, soon: true });
// closing today, and a close the build has not caught up with: Today
assert.strictEqual(launchWords({ type: "LE", status: "live", of: 25, windowEnd: "2026-11-13" }, asOf).text, "Today");
assert.strictEqual(launchWords({ type: "LE", status: "live", of: 25, windowEnd: "2026-11-12" }, asOf).text, "Today");
// a launch Airtable alone knows counts to its close the same way
assert.strictEqual(launchWords({ type: "LE", status: "upcoming", of: 25, windowEnd: "2026-12-18" }, asOf).text, "35d");
// a timed launch counts to the sale opening, in calendar days, not to the window's close
const tl = { type: "TL", status: "live", of: 19, windowStart: "2026-11-04", windowEnd: "2026-11-26", salesOpen: "2026-11-23T14:00:00Z", windowClose: "2026-11-26T14:00:00Z" };
assert.deepStrictEqual(launchWords({ ...tl, tlState: "signups" }, asOf), { text: "10d", days: 10, soon: false });
assert.strictEqual(launchWords({ ...tl, status: "upcoming", tlState: "upcoming" }, "2026-10-27").text, "27d");
// inside its window it is open; settling and closed carry the day it launched
assert.deepStrictEqual(launchWords({ ...tl, tlState: "window" }, "2026-11-24"), { text: "Open", days: 0, soon: true });
assert.strictEqual(launchWords({ ...tl, tlState: "settling" }, "2026-11-28").text, "23 Nov");
assert.strictEqual(launchWords({ ...tl, status: "closed", tlState: "closed", complete: true }, "2026-12-10").text, "23 Nov");
// a closed draw: the day it closed, with the year where it is not this one
assert.strictEqual(launchWords({ type: "LE", status: "closed", of: 24, windowEnd: "2026-10-30" }, asOf).text, "30 Oct");
assert.strictEqual(launchWords({ type: "LE", status: "closed", of: 24, windowEnd: "2025-10-30" }, asOf).text, "30 Oct 2025");
// nothing to say without a date, or on the catalogue
assert.strictEqual(launchWords({ type: "LE", status: "live", of: 0 }, asOf).text, "");
assert.strictEqual(launchWords({ type: "LE", status: "catalogue", of: 90, windowEnd: "2026-01-01" }, asOf).text, "");
// the type on the tag: TL or LE, LE where the row does not say
assert.strictEqual(typeOf({ type: "tl" }), "TL");
assert.strictEqual(typeOf({}), "LE");
// the sidebar lists a section in the order of the count it prints: a timed launch by its sale opening
const rows = [
  { id: "le12", type: "LE", status: "live", of: 25, windowEnd: "2026-11-25" },
  { id: "tl10", ...tl, tlState: "signups" },
  { id: "le17", type: "LE", status: "live", of: 32, windowEnd: "2026-11-30" },
  { id: "up35", type: "LE", status: "upcoming", of: 25, windowEnd: "2026-12-18" },
  { id: "up28", type: "LE", status: "upcoming", of: 25, windowEnd: "2026-12-11" },
  { id: "tlOct12", ...tl, status: "closed", tlState: "closed", complete: true, salesOpen: "2026-10-12T14:00:00Z", windowClose: "2026-10-15T14:00:00Z", windowEnd: "2026-10-22" },
  { id: "leOct15", type: "LE", status: "closed", of: 24, windowEnd: "2026-10-15" },
];
const g = sidebarGroups(rows, asOf);
assert.deepStrictEqual(byLaunch(g.live, asOf).map((r) => r.id), ["tl10", "le12", "le17"]);
assert.deepStrictEqual(byLaunch(g.upcoming, asOf).map((r) => r.id), ["up28", "up35"]);
assert.deepStrictEqual(byLaunched(g.recent).map((r) => r.id), ["leOct15", "tlOct12"]);
// the releases list keeps its own order: in flight by the close, recent by the window's end
assert.deepStrictEqual(g.live.map((r) => r.id), ["le12", "tl10", "le17"]);
assert.deepStrictEqual(g.recent.map((r) => r.id), ["tlOct12", "leOct15"]);
console.log("launch words: ok");
