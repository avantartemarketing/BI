/* The campaign dates the Notion log yields (server/notion.js): which moment
 * a row records, read off its own words; the dates that follow per release;
 * and a campaigns database's date columns by name.  node tests/notion_dates.mjs */
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { stageOf, campaignDates, campaignRowDates, datesCsv } = require("../server/notion.js");

// the stage from the row's words: the early-access email, the announce, the launch
assert.strictEqual(stageOf(["Early access email", "AA Email"]), "early_access");
assert.strictEqual(stageOf(["Private room opens - collectors"]), "early_access");
assert.strictEqual(stageOf(["Announce post", "AA IG Main"]), "announce");
assert.strictEqual(stageOf(["Announcement email"]), "announce");
assert.strictEqual(stageOf(["Launch day story"]), "launch");
assert.strictEqual(stageOf(["Draw closes tonight"]), "launch");
assert.strictEqual(stageOf(["Last chance reminder"]), "launch");
assert.strictEqual(stageOf(["Warhol teaser"]), null);
assert.strictEqual(stageOf([]), null);
// early access outranks a launch word on the same row ("early access ends tonight")
assert.strictEqual(stageOf(["Early access ends tonight"]), "early_access");

// per release: the first early-access and announce rows, the last launch row
const stages = new Map([["A_LE_26", { early_access: ["2026-09-03", "2026-09-01"], announce: ["2026-09-05", "2026-09-06"], launch: ["2026-09-28", "2026-09-30"] }],
  ["B_LE_26", { announce: ["2026-10-01"] }]]);
const dates = campaignDates(stages);
assert.deepStrictEqual(dates.A_LE_26, { private_room_open: "2026-09-01", announce_date: "2026-09-05", launch_end: "2026-09-30", rows: { early_access: 2, announce: 2, launch: 2 } });
assert.deepStrictEqual(dates.B_LE_26, { private_room_open: "", announce_date: "2026-10-01", launch_end: "", rows: { early_access: 0, announce: 1, launch: 0 } });

// a campaigns database's date columns, by name, the day only
const d = (s) => ({ type: "date", date: { start: s } });
assert.deepStrictEqual(campaignRowDates({ "Early access send": d("2026-09-01T09:00:00.000+01:00"), Launch: d("2026-09-30"), "Announce date": d("2026-09-03"), "Send date": d("2026-01-01"), Name: { type: "title", title: [] } }),
  { private_room_open: "2026-09-01", launch_end: "2026-09-30", announce_date: "2026-09-03" });
assert.deepStrictEqual(campaignRowDates({ "Draw closes": d("2026-09-30"), "Private room opens": d("2026-09-01") }), { launch_end: "2026-09-30", private_room_open: "2026-09-01" });
assert.deepStrictEqual(campaignRowDates({ Name: { type: "title", title: [] } }), {});

// the file the ETL reads
assert.strictEqual(datesCsv(dates).split("\n")[1], "A_LE_26,2026-09-01,2026-09-05,2026-09-30,2,2,2,posts");
console.log("notion dates: ok");
