/* The campaign dates the Notion log yields (server/notion.js): which moment
 * a row records, read off its own words; which release a row belongs to,
 * by code, by name, or by artist and date; the dates that follow per
 * release, the early-access email's day first; and a campaigns database's
 * date columns by name.  node tests/notion_dates.mjs */
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { stageOf, isEmailRow, matchRelease, inWindow, campaignDates, campaignRowDates, leadProp, leadRank, leadNames, campaignLeads, datesCsv } = require("../server/notion.js");

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

const sel = (name) => ({ type: "select", select: { name } });

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

// the marketing lead's column: named for it, a people, select or text property; the
// most specific name wins, and a "Lead time" or a date is not a lead
const people = (...names) => ({ type: "people", people: names.map((name, i) => ({ object: "user", id: "u" + i, name, type: "person", person: { email: "nobody@example.com" } })) });
assert.strictEqual(leadProp({ Name: { type: "title", title: [] }, "Marketing Lead": people("Maria"), Owner: people("Tom") }), "Marketing Lead");
assert.strictEqual(leadProp({ Owner: people("Tom"), "Lead time": { type: "number", number: 3 } }), "Owner");
assert.strictEqual(leadProp({ Lead: sel("Clare") }), "Lead");
assert.strictEqual(leadProp({ "Campaign lead": { type: "rich_text", rich_text: [{ plain_text: "Clare" }] } }), "Campaign lead");
assert.strictEqual(leadProp({ "Lead magnet": sel("yes"), "Lead date": d("2026-09-01") }), null);
// a relation to a team page is the usual shape; the rank says how specific the name is
assert.strictEqual(leadProp({ Release: { type: "title", title: [] }, "Marketing Lead": { type: "relation", relation: [{ id: "t1" }] } }), "Marketing Lead");
assert.deepStrictEqual(leadRank({ Owner: people("Tom"), "Marketing Lead": { type: "relation", relation: [] } }), { name: "Marketing Lead", rank: 0 });
assert.deepStrictEqual(leadRank({ Owner: people("Tom") }), { name: "Owner", rank: 4 });
assert.strictEqual(leadRank({ Name: { type: "title", title: [] } }), null);
assert.deepStrictEqual(leadNames({ type: "relation", relation: [{ id: "t1" }] }), [], "a relation needs the fetch (leadNamesAsync)");
assert.strictEqual(leadProp({ Name: { type: "title", title: [] } }), null);
// the names on the column: display names only, never the email the API carries beside them
assert.deepStrictEqual(leadNames(people("Maria", "  Tom  Lloyd ")), ["Maria", "Tom Lloyd"]);
assert.ok(!JSON.stringify(leadNames(people("Maria"))).includes("@"), "no email leaves the people property");
assert.deepStrictEqual(leadNames(sel("Clare")), ["Clare"]);
assert.deepStrictEqual(leadNames({ type: "formula", formula: { type: "string", string: "Maria" } }), ["Maria"]);
assert.deepStrictEqual(leadNames({ type: "formula", formula: { type: "number", number: 3 } }), []);
assert.deepStrictEqual(leadNames({ type: "rollup", rollup: { type: "array", array: [people("Maria"), { type: "rich_text", rich_text: [{ plain_text: "Tom" }] }] } }), ["Maria", "Tom"]);
assert.strictEqual(leadProp({ Lead: { type: "formula", formula: { type: "string", string: "Maria" } } }), "Lead");
assert.deepStrictEqual(leadNames({ type: "people", people: [{ object: "user", id: "u9" }] }), []);   // a person the integration cannot name
assert.deepStrictEqual(leadNames(undefined), []);
// one lead per release off the post rows: the commonest name, the alphabetical first on a tie
assert.deepStrictEqual(campaignLeads(new Map([
  ["A_LE_26", new Map([["Maria", 3], ["Clare", 1]])],
  ["B_LE_26", new Map([["Tom", 2], ["Clare", 2]])],
  ["C_LE_26", new Map()],
])), { A_LE_26: "Maria", B_LE_26: "Clare" });

// the file the ETL reads: the code and the name, so a launch without a code is still found,
// and the lead beside the dates (an entry with a lead alone still lists)
dates.A_LE_26.marketing_lead = "Maria";
dates["name:D · Four · 2027 Q1"] = { code: "", name: "D · Four · 2027 Q1", rows: null, marketing_lead: "O'Brien, Tom" };
const csv = datesCsv(dates).split("\n");
assert.strictEqual(csv[0], "campaign_code,release_name,private_room_open,announce_date,launch_end,marketing_lead,early_access_rows,early_access_email_rows,announce_rows,launch_rows,source");
assert.strictEqual(csv[1], "A_LE_26,A · One · 2026 Q3,2026-09-03,2026-09-05,2026-09-30,Maria,2,1,2,2,posts");
assert.strictEqual(csv[3], ",C · Three · 2027 Q1,2026-09-14,,,,2,0,0,0,posts");
assert.strictEqual(csv[4], ',D · Four · 2027 Q1,,,,"O\'Brien, Tom",,,,,posts');
console.log("notion dates: ok");
