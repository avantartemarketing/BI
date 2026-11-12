/* The Spend levels card without a level from the build (web/src/modules/
 * noLevels.mjs): the card stays on the page and says why there is no
 * recommendation, read from the snapshot's own days.  node tests/no_levels.mjs */
import assert from "node:assert";
import { noLevels } from "../web/src/modules/noLevels.mjs";

const day = (date, spend, entries, extra = {}) => ({ date, spend, entries, ...extra });
const base = { type: "LE", campaignName: "X_LE_26 · Enter draw", windowStart: "2026-11-03", windowEnd: "2026-11-27", day: 9, of: 24, complete: false };
// the reported case: spend on days 3 to 6, the last three full days bought no entries, nothing spent since day 6
const reported = { ...base, paid: { spendToDate: 804.86, levels: null, budget: { daysLeft: 15 }, daily: [
  day("2026-11-06", 143.21, 0), day("2026-11-07", 271.89, 5), day("2026-11-08", 284.38, 1),
  day("2026-11-09", 105.38, 0), day("2026-11-10", 0, 0), day("2026-11-11", 0, 0), day("2026-11-12", 0, 0, { partial: true })] } };
let n = noLevels(reported);
assert.strictEqual(n.v, "€0");
assert.strictEqual(n.aside, "off since day 6");
assert.strictEqual(n.loz, "No entries in 3 days");
assert.match(n.why, /^No recommendation: the €105 spent in the last three days bought no entries/);
assert.match(n.why, /Paid has been off since day 6\./);

// three full days with nothing spent: paid is off, said as such
const off = { ...reported, paid: { ...reported.paid, daily: [...reported.paid.daily.slice(0, 6), day("2026-11-12", 0, 0), day("2026-11-13", 0, 0, { partial: true })] } };
n = noLevels(off);
assert.strictEqual(n.loz, "Paid off");
assert.match(n.why, /spent nothing in the last three days \(off since day 6\)/);

// spending every day and buying nothing: today's spend heads the card, no "off since"
const dry = { ...base, paid: { spendToDate: 900, daily: [day("2026-11-09", 240, 0), day("2026-11-10", 240, 0), day("2026-11-11", 240, 0), day("2026-11-12", 60, 0, { partial: true })] } };
n = noLevels(dry);
assert.strictEqual(n.v, "€240");
assert.strictEqual(n.aside, "");
assert.match(n.why, /the €720 spent in the last three days bought no entries/);
assert.doesNotMatch(n.why, /off since/);

// paid back on today after days off: not "off"
const back = { ...reported, paid: { ...reported.paid, daily: [...reported.paid.daily.slice(0, 6), day("2026-11-12", 80, 0, { partial: true })] } };
assert.strictEqual(noLevels(back).aside, "");

// a closed release, one with no spend yet, one with no campaign, one without targets
n = noLevels({ ...reported, complete: true });
assert.strictEqual(n.v, "€805");
assert.strictEqual(n.loz, "Closed");
n = noLevels({ ...base, paid: { spendToDate: 0, daily: [day("2026-11-03", 0, 0)] } });
assert.match(n.why, /^No paid spend yet/);
assert.match(noLevels({ ...base, campaignName: null, paid: { spendToDate: 0, daily: [] } }).why, /No Meta campaign matched/);
assert.strictEqual(noLevels({ ...reported, targeted: false }).loz, "No targets");

// the last day, and anything else: a reason either way, never an empty card
const last = { ...base, paid: { spendToDate: 500, budget: { daysLeft: 0 }, daily: [day("2026-11-09", 100, 2), day("2026-11-10", 100, 1), day("2026-11-11", 100, 3)] } };
assert.strictEqual(noLevels(last).loz, "Last day");
n = noLevels({ ...last, paid: { ...last.paid, budget: { daysLeft: 4 } } });
assert.ok(n.why.length > 0 && n.loz === null);
assert.ok(noLevels({}).why.length > 0);
console.log("no_levels: ok");
