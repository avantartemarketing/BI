/* The refresh's interval while a timed launch's window is open (server/sheets.js
 * refreshIntervalMinutes, docs/TL_SPEC.md §2): hourly as a rule, every
 * REFRESH_WINDOW_MINUTES while a TL row of the index is in its window or opens
 * before the next hourly tick, read off the index the last build wrote.
 *   node tests/refresh_interval.mjs */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { refreshIntervalMinutes } = require(path.join(here, "..", "server", "sheets.js"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const now = new Date("2026-10-12T15:00:00Z");
const env = {};
const idx = (rows) => ({ releases: rows });
const le = { id: "le", type: "LE", status: "live" };
check(refreshIntervalMinutes(idx([le]), now, env) === 60, "no timed launch: hourly");
check(refreshIntervalMinutes(null, now, env) === 60 && refreshIntervalMinutes({}, now, env) === 60, "no index yet: hourly");
check(refreshIntervalMinutes(idx([le, { id: "t", type: "TL", tlState: "window", salesOpen: "2026-10-12T16:00:00Z" }]), now, env) === 30, "a window open: every 30 minutes");
check(refreshIntervalMinutes(idx([{ id: "t", type: "TL", tlState: "signups", salesOpen: "2026-10-12T15:40:00Z" }]), now, env) === 30, "a window opening within the hour: every 30 minutes already");
check(refreshIntervalMinutes(idx([{ id: "t", type: "TL", tlState: "signups", salesOpen: "2026-10-13T16:00:00Z" }]), now, env) === 60, "a window opening tomorrow: hourly");
check(refreshIntervalMinutes(idx([{ id: "t", type: "TL", tlState: "settling", salesOpen: "2026-10-10T16:00:00Z" }]), now, env) === 60, "settling: hourly again");
check(refreshIntervalMinutes(idx([{ id: "t", type: "TL", tlState: "window" }]), now, { REFRESH_WINDOW_MINUTES: "15" }) === 15, "REFRESH_WINDOW_MINUTES sets the window's cadence");
check(refreshIntervalMinutes(idx([{ id: "t", type: "TL", tlState: "window" }]), now, { REFRESH_MINUTES: "20" }) === 20, "never slower in the window than the hourly setting");
check(refreshIntervalMinutes(idx([{ id: "t", type: "TL", tlState: "window" }]), now, { REFRESH_WINDOW_MINUTES: "1" }) === 5, "and never under five minutes");
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("refresh interval: ok");
