/* The campaign dates the Notion log yields (server/notion.js): which moment
 * a row records, read off its own words; which release a row belongs to,
 * by code, by name, or by artist and date; the dates that follow per
 * release, the early-access email's day first; and a campaigns database's
 * date columns by name.  node tests/notion_dates.mjs */
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { stageOf, isEmailRow, matchRelease, inWindow, campaignDates, campaignRowDates, datesCsv } = require("../server/notion.js");

// the stage from the row's words: the early-access email, the announce, the launch
assert.strictEqual(stageOf(["Early access email", "AA Email"]), "early_access");
assert.strictEqual(stageOf(["Early/Exclusive access (LE)", "AA Email"]), "early_access");        // the log's own name for it
assert.strictEqual(stageOf(["Early/Exclusive access (LE) (Artist send)", "AA Email"]), "early_access");
assert.strictEqual(stageOf(["Early - exclusive access"]), "early_access");
assert.strictEqual(stageOf(["Exclusive access for collectors"]), "early_access");
assert.strictEqual(stageOf(["Private room opens - collectors"]), "early_access");
assert.strictEqual(stageOf(["Announce post", "AA IG Main"]), "announce");
assert.strictEqual(stageOf(["Announcement email"]), "announce");
assert.strictEqual(stageOf(["Launch day story"]), "launch");
assert.strictEqual(stageOf(["Draw closes tonight"]), "launch");
assert.strictEqual(stageOf(["Last chance reminder"]), "launch");
assert.strictEqual(stageOf(["Warhol teaser"]), null);
assert.strictEqual(stageOf(["Coming Soon", "IG Main · Story"]), null);
assert.strictEqual(stageOf([]), null);
// early access outranks a launch word on the same row ("early access ends tonight")
assert.strictEqual(stageOf(["Early access ends tonight"]), "early_access");
// the email rows, by their channel
assert.strictEqual(isEmailRow(["Early/Exclusive access (LE)", "AA Email"]), true);
assert.strictEqual(isEmailRow(["Coming Soon", "IG Main · Story"]), false);
assert.strictEqual(isEmailRow(["Newsletter teaser"]), true);

// which release a row belongs to
const R = [
  { code: "Maurizio_NonaOra_26", name: "Maurizio Cattelan · La Nona Ora · 2026 Q2", artist: "Maurizio Cattelan", announce: "2026-04-02", close: "2026-04-23", key: "Maurizio_NonaOra_26" },
  { code: "", name: "Maurizio Cattelan · Multiple · 2027 Q1", artist: "Maurizio Cattelan", announce: "2026-09-21", close: "2026-10-15", key: "name:Maurizio Cattelan · Multiple · 2027 Q1" },
  { code: "AndyWarhol_TL_26", name: "Andy Warhol Estate · Multiple · 2026 Q3", artist: "Andy Warhol Estate", announce: "2026-09-03", close: "2026-09-30", key: "AndyWarhol_TL_26" },
];
assert.strictEqual(matchRelease(["AndyWarhol_TL_26 launch story"], R, "2026-09-10").key, "AndyWarhol_TL_26");         // by code
assert.strictEqual(matchRelease(["Maurizio Cattelan · Multiple · 2027 Q1", "Coming Soon"], R, null).key, "name:Maurizio Cattelan · Multiple · 2027 Q1");   // by name
// by the artist alone, the row's date says which launch: the one whose window holds it
assert.strictEqual(matchRelease(["Maurizio Cattelan", "Early/Exclusive access (LE)"], R, "2026-09-18").key, "name:Maurizio Cattelan · Multiple · 2027 Q1");
assert.strictEqual(matchRelease(["Maurizio Cattelan", "Announce"], R, "2026-04-01").key, "Maurizio_NonaOra_26");
// outside every window: the nearest announce; no date: the first on file
assert.strictEqual(matchRelease(["Maurizio Cattelan"], R, "2026-07-01").key, "name:Maurizio Cattelan · Multiple · 2027 Q1");
assert.strictEqual(matchRelease(["Maurizio Cattelan"], R, null).key, "Maurizio_NonaOra_26");
assert.strictEqual(matchRelease(["Somebody Else"], R, "2026-09-18"), null);
assert.strictEqual(inWindow(R[1], "2026-08-08"), true);
assert.strictEqual(inWindow(R[1], "2026-08-06"), false);
assert.strictEqual(inWindow(R[1], "2026-11-14"), true);
assert.strictEqual(inWindow(R[1], null), false);

// per release: the early-access email's day for the private room (a story on
// the same stage does not move it), the first announce row, the last launch row
const stages = new Map([
  ["A_LE_26", { code: "A_LE_26", name: "A · One · 2026 Q3", early_access: ["2026-09-03", "2026-09-01"], early_access_email: ["2026-09-03"], announce: ["2026-09-05", "2026-09-06"], launch: ["2026-09-28", "2026-09-30"] }],
  ["B_LE_26", { code: "B_LE_26", name: "B · Two · 2026 Q4", announce: ["2026-10-01"] }],
  ["name:C · Three · 2027 Q1", { code: "", name: "C · Three · 2027 Q1", early_access: ["2026-09-14", "2026-09-18"] }],
]);
const dates = campaignDates(stages);
assert.deepStrictEqual(dates.A_LE_26, { code: "A_LE_26", name: "A · One · 2026 Q3", private_room_open: "2026-09-03", announce_date: "2026-09-05", launch_end: "2026-09-30",
  rows: { early_access: 2, early_access_email: 1, announce: 2, launch: 2 } });
assert.deepStrictEqual(dates.B_LE_26, { code: "B_LE_26", name: "B · Two · 2026 Q4", private_room_open: "", announce_date: "2026-10-01", launch_end: "",
  rows: { early_access: 0, early_access_email: 0, announce: 1, launch: 0 } });
assert.strictEqual(dates["name:C · Three · 2027 Q1"].private_room_open, "2026-09-14");   // no email row: the first early-access row stands in

// a campaigns database's date columns, by name, the day only
const d = (s) => ({ type: "date", date: { start: s } });
assert.deepStrictEqual(campaignRowDates({ "Early access send": d("2026-09-01T09:00:00.000+01:00"), Launch: d("2026-09-30"), "Announce date": d("2026-09-03"), "Send date": d("2026-01-01"), Name: { type: "title", title: [] } }),
  { private_room_open: "2026-09-01", launch_end: "2026-09-30", announce_date: "2026-09-03" });
assert.deepStrictEqual(campaignRowDates({ "Draw closes": d("2026-09-30"), "Private room opens": d("2026-09-01") }), { launch_end: "2026-09-30", private_room_open: "2026-09-01" });
assert.deepStrictEqual(campaignRowDates({ Name: { type: "title", title: [] } }), {});

// the file the ETL reads: the code and the name, so a launch without a code is still found
const csv = datesCsv(dates).split("\n");
assert.strictEqual(csv[0], "campaign_code,release_name,private_room_open,announce_date,launch_end,early_access_rows,early_access_email_rows,announce_rows,launch_rows,source");
assert.strictEqual(csv[1], "A_LE_26,A · One · 2026 Q3,2026-09-03,2026-09-05,2026-09-30,2,1,2,2,posts");
assert.strictEqual(csv[3], ",C · Three · 2027 Q1,2026-09-14,,,2,0,0,0,posts");
console.log("notion dates: ok");
