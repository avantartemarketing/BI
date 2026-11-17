/* The two feeds behind the plan model, against stand-ins for the APIs (fetch
 * is replaced; nothing leaves the machine).
 *
 * server/commsPlan.js: a property's value read by type, with people and email
 * properties reading as nothing; a channel placed in its family; the HubSpot
 * email a plan row links to; a row written once per campaign it belongs to,
 * through the Campaign relation and the campaigns' own codes; the read made in
 * created-time slices and joined by row id; and the pull end to end.
 *
 * server/emailAudiences.js: a send's lists, the newer ids ahead of the older;
 * an email that was never sent kept for the lists it names, a template that
 * names nobody left out; a list's kind read off its name; a token that may
 * not read lists reported, with the audiences still written.
 *   node tests/comms_plan.mjs */
import { createRequire } from "node:module";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);

// the audiences pull keeps the rows already on file: give it an empty place of its own
process.env.SOURCES_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "comms-plan-"));

process.env.NOTION_TOKEN = "stand-in";          // only ever sent to the fetch below
process.env.HUBSPOT_TOKEN = "stand-in";
process.env.NOTION_API = "https://notion.test/v1";
process.env.NOTION_COMMS_DB = "comms";
process.env.NOTION_CHANNELS_DB = "channels";
process.env.NOTION_CAMPAIGNS_DB = "campaigns";
process.env.HUBSPOT_API = "https://hubspot.test/emails";
process.env.HUBSPOT_LISTS_API = "https://hubspot.test/lists/";
const C = require("../server/commsPlan.js");
const A = require("../server/emailAudiences.js");

const title = (t) => ({ type: "title", title: [{ plain_text: t }] });
const rel = (...ids) => ({ type: "relation", relation: ids.map((id) => ({ id })) });
const sel = (name) => ({ type: "select", select: name ? { name } : null });
const status = (name) => ({ type: "status", status: { name } });
const when = (d) => ({ type: "date", date: d ? { start: d } : null });
const url = (u) => ({ type: "url", url: u });
const check = (b) => ({ type: "checkbox", checkbox: b });
const formula = (s) => ({ type: "formula", formula: { type: "string", string: s } });
const rollup = (...vals) => ({ type: "rollup", rollup: { type: "array", array: vals } });

// ---- a property's value
assert.equal(C.value(title(" Announcement ")), "Announcement");
assert.equal(C.value(sel("9am")), "9am");
assert.equal(C.value(sel(null)), null);
assert.equal(C.value(status("Live")), "Live");
assert.equal(C.value(when("2026-09-21T09:00:00.000+01:00")), "2026-09-21T09:00:00.000+01:00");
assert.deepEqual(C.value(rel("a", "b")), ["a", "b"]);
assert.equal(C.value(formula("Parra_LE_26")), "Parra_LE_26");
assert.equal(C.value({ type: "formula", formula: { type: "date", date: { start: "2026-08-21" } } }), "2026-08-21");
assert.deepEqual(C.value(rollup(sel("Draw"), sel("Draw"))), ["Draw", "Draw"]);
assert.equal(C.value({ type: "people", people: [{ name: "Someone", person: { email: "nobody@example.com" } }] }), null);   // never read
assert.equal(C.value({ type: "email", email: "nobody@example.com" }), null);
assert.equal(C.value(undefined), null);

// ---- a channel's family
const fam = { "AA Email": "email", "SMS": "sms", "IG Main · Post": "aa_post", "IG Main · Story": "aa_story", "IG Main · Broadcast": "aa_story",
  "IG Ins · Post": "aa_social_other", "IG Arteinbio · Story": "aa_social_other", "Twitter": "aa_social_other", "TikTok": "aa_social_other",
  "Discord": "aa_social_other", "Artist IG · Post": "artist_post", "Artist IG · Story": "artist_story", "Artist Twitter": "artist_other",
  "Artist Email": "artist_other", "  Arte.bio ": "artist_other", "Partner IG  · Post": "partner", "Partner Email": "partner", "Press": "press",
  "Website": "website", "Scheduling": "scheduling", "Paid Social": "paid", "M\u2013R Paid Social": "make_ready", "IG Make\u2014Ready \u00b7 Post": "make_ready",
  " M-R Website": "make_ready", "Misc": "other", "": "other" };
for (const [ch, want] of Object.entries(fam)) assert.equal(C.familyOf(ch), want, `family of "${ch}"`);

// ---- the HubSpot email a row links to
assert.equal(C.hubspotId("https://app.hubspot.com/email/1234567/details/98765432101/performance"), "98765432101");
assert.equal(C.hubspotId("https://app.hubspot.com/email/1234567/edit/555666777/content?x=1"), "555666777");
assert.equal(C.hubspotId("https://1234567.hubspotpreview-na1.com/_hcms/preview/email/424242"), "424242");
assert.equal(C.hubspotId("https://app.hubspot.com/workflows/1234567/platform/flow/99/edit"), "");
assert.equal(C.hubspotId(null), "");
assert.equal(C.timeOf("2026-09-21T09:00:00.000+01:00", "4pm"), "09:00");
assert.equal(C.timeOf("2026-09-21", "4pm"), "4pm");

// ---- campaigns and rows
const camp = (id, release, code, extra = {}) => ({ id, properties: { Release: title(release), "Campaign Code": formula(code),
  "Formula Announce": formula("2026-09-21"), "Launch Date Formula": formula("2026-10-15"), "◒ Launch mechanic": rollup(sel("Draw"), sel("Draw")),
  Status: status("7. In Flight"), "Content Tier": sel("Programme"), ...extra } });
assert.deepEqual(C.campaignRow(camp("c1", "Maurizio Cattelan - Horse", "MaurizioCatt_HorseLE_26")),
  { id: "c1", code: "MaurizioCatt_HorseLE_26", codes: ["MaurizioCatt_HorseLE_26"], coded: true, release: "Maurizio Cattelan - Horse", announce: "2026-09-21", launch: "2026-10-15", mechanic: "Draw", status: "7. In Flight", tier: "Programme" });
// no code of its own (none before mid-2024, and the plan goes back to September 2023): kept under a stand-in, its page
const older = C.campaignRow(camp("166e6526-5ca2-80a0-8bc9-f239feb76e2d", "George Condo · Three Silkscreens", ""));
assert.deepEqual([older.code, older.codes, older.coded, older.release], ["notion:166e65265ca2", ["notion:166e65265ca2"], false, "George Condo · Three Silkscreens"]);
// one campaign under two codes is found by either
assert.deepEqual(C.campaignRow(camp("c7", "Lee Ufan - From Point", "LeeUfan_From_25,LeeUfan_LE_26")).codes, ["LeeUfan_From_25", "LeeUfan_LE_26"]);
// Make-Ready's campaigns are another business's, and a blank row is nothing
assert.equal(C.campaignRow(camp("c8", "MRE - Capsule", "", { "Make Ready": check(true) })), null);
assert.equal(C.campaignRow(camp("c9", "", "")), null);
const channels = new Map([["ch_email", { name: "AA Email", type: "AA CRM" }], ["ch_post", { name: "IG Main · Post", type: "AA Social" }]]);
const campaigns = new Map([["c1", { code: "Catt_LE_26", release: "Cattelan" }], ["c2", { code: "Longo_LE_26", release: "Longo" }]]);
const row = (id, props, created = "2026-08-20T10:00:00.000Z") => ({ id, created_time: created, last_edited_time: "2026-09-22T08:00:00.000Z", properties: props });
const email = row("r1", { Name: title("Announcement (LE)"), "Live Date": when("2026-09-21T09:00:00.000+01:00"), Channel: rel("ch_email"), Campaign: rel("c1"),
  "Campaign Phase": sel("2-Announce"), Status: status("Live"), "Hubspot link": url("https://app.hubspot.com/email/1/details/777/performance"), "Make Ready": check(false) });
assert.deepEqual(C.commsRows(email, channels, campaigns), [{ campaign_code: "Catt_LE_26", release: "Cattelan", date: "2026-09-21", time: "09:00",
  channel: "AA Email", channel_type: "AA CRM", family: "email", phase: "2-Announce", status: "Live", name: "Announcement (LE)", hubspot_id: "777",
  make_ready: "", created: "2026-08-20", edited: "2026-09-22" }]);
const bundle = row("r2", { Name: title("Bundle"), "Live Date": when("2026-09-17"), "Post Time": sel("4pm"), Channel: rel("ch_post"), Campaign: rel("c1", "c2", "c_gone"), Status: status("Scheduled") });
assert.deepEqual(C.commsRows(bundle, channels, campaigns).map((r) => [r.campaign_code, r.time, r.family]), [["Catt_LE_26", "4pm", "aa_post"], ["Longo_LE_26", "4pm", "aa_post"]]);
assert.deepEqual(C.commsRows(row("r3", { Name: title("No date"), Channel: rel("ch_post"), Campaign: rel("c1") }), channels, campaigns), []);
assert.deepEqual(C.commsRows(row("r4", { Name: title("No campaign"), "Live Date": when("2026-09-17"), Channel: rel("ch_post"), Campaign: rel() }), channels, campaigns), []);
// a row of a campaign under two codes is written under each, one of a campaign with none under its stand-in
const two = new Map([["c7", { code: "LeeUfan_From_25", codes: ["LeeUfan_From_25", "LeeUfan_LE_26"], release: "Lee Ufan" }], ["c5", older]]);
assert.deepEqual(C.commsRows(row("r6", { Name: title("Announce"), "Live Date": when("2026-09-17"), Channel: rel("ch_post"), Campaign: rel("c7", "c5") }), channels, two).map((r) => r.campaign_code),
  ["LeeUfan_From_25", "LeeUfan_LE_26", "notion:166e65265ca2"]);

// ---- the slices a full read is made in
const sl = C.slices("2026-11-16", "2026-01-01", 3);
assert.deepEqual(sl[0], ["2026-01-01", "2026-04-01"]);
assert.deepEqual(sl[sl.length - 1], ["2026-10-01", "2027-01-01"]);                 // runs a month past today, so today's rows are in
assert.equal(sl.every(([a, b], i) => a < b && (i === 0 || a === sl[i - 1][1])), true);

// ---- the pull end to end: three databases, the plan in slices, a row on two slices read once
const queries = [];
const commsRowsAll = [email, bundle, row("r5", { Name: title("Late row"), "Live Date": when("2026-10-01"), Channel: rel("ch_post"), Campaign: rel("c1"), Status: status("Not posted") }, "2026-09-30T10:00:00.000Z")];
globalThis.fetch = async (u, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data), headers: { get: () => null } });
  const href = String(u);
  if (href === "https://notion.test/v1/databases/channels/query") {
    return ok({ results: [{ id: "ch_email", properties: { Name: title("AA Email"), Type: sel("AA CRM") } }, { id: "ch_post", properties: { Name: title("IG Main · Post"), Type: sel("AA Social") } }], has_more: false });
  }
  if (href === "https://notion.test/v1/databases/campaigns/query") {
    return ok({ results: [camp("c1", "Cattelan", "Catt_LE_26"), camp("c2", "Longo", "Longo_LE_26"), camp("c3", "No code yet", "")], has_more: false });
  }
  if (href === "https://notion.test/v1/databases/comms/query") {
    const [from, to] = body.filter.and.map((f) => f.created_time.on_or_after || f.created_time.before);
    queries.push([from, to, body.start_cursor || null]);
    const inSlice = commsRowsAll.filter((r) => r.created_time.slice(0, 10) >= from && r.created_time.slice(0, 10) < to);
    // the first row of a slice comes back on a page of its own, to hold the paging to account
    if (inSlice.length > 1 && !body.start_cursor) return ok({ results: inSlice.slice(0, 1), has_more: true, next_cursor: "page2" });
    return ok({ results: body.start_cursor ? inSlice.slice(1) : inSlice, has_more: false });
  }
  if (href.startsWith("https://hubspot.test/emails")) {
    return ok({ results: hubspotEmails, paging: null });
  }
  if (href.startsWith("https://hubspot.test/lists/")) {
    if (!listsAllowed) return { ok: false, status: 403, text: async () => '{"category":"MISSING_SCOPES"}', json: async () => ({}), headers: { get: () => null } };
    const want = new URL(href).searchParams.getAll("listIds");
    return ok({ lists: want.filter((id) => listNames[id]).map((id) => ({ listId: id, name: listNames[id], additionalProperties: { hs_list_size: "1200" } })) });
  }
  throw new Error("unexpected fetch " + href);
};
const out = await C.fetchCommsPlan("2026-11-16");
assert.equal(out.rows, 3);
assert.equal(out.lines, 4);                                   // the bundle writes two lines
assert.equal(out.campaigns, 3);                               // the campaign with no code is kept, under its stand-in
assert.equal(out.uncoded, 1);
assert.equal(out.campaignsCsv.trim().split("\n").length, 4);  // a header and a line per code
assert.equal(out.codes, 2);
assert.equal(out.capped, false);
assert.equal(out.through, "2026-10-01");
assert.ok(queries.some((q) => q[2] === "page2"), "a slice's second page is asked for");
assert.ok(queries.length >= C.slices("2026-11-16").length);
const lines = out.csv.trim().split("\n");
assert.equal(lines[0], C.HEADER.join(","));
assert.ok(lines.includes("Catt_LE_26,Cattelan,2026-09-21,09:00,AA Email,AA CRM,email,2-Announce,Live,Announcement (LE),777,,2026-08-20,2026-09-22"));
assert.equal(out.campaignsCsv.trim().split("\n")[1], "Catt_LE_26,Cattelan,2026-09-21,2026-10-15,Draw,7. In Flight,Programme");
assert.match(C.summary(out), /comms plan 4 lines for 2 campaigns, dated to 2026-10-01/);

// ---- the audiences
const to = (inc, exc, incOld = [], excOld = [], contacts = []) => ({ contactIlsLists: { include: inc, exclude: exc }, contactLists: { include: incOld, exclude: excOld }, contactIds: { include: contacts, exclude: [] } });
assert.deepEqual(A.listsOf(to(["11068"], ["13134"], ["6083"], ["7982"]), "include"), ["11068"]);          // the newer id, not both
assert.deepEqual(A.listsOf(to([], [], ["6083"], ["7982"]), "exclude"), ["v1:7982"]);                       // the older, marked, where there is no newer
assert.deepEqual(A.listsOf(undefined, "include"), []);
const sentEmail = { id: 101, name: "210926_GEN_Catt_LE_26 -  Announcement (LE)", state: "PUBLISHED", publishDate: "2026-09-21T08:00:00Z", campaignName: "Catt_LE_26",
  stats: { counters: { sent: 137700, delivered: 137575, open: 16677, click: 3103, unsubscribed: 410, spamreport: 3 } }, to: to(["11068"], ["13134", "14274"]),
  from: { fromName: "Avant Arte", replyTo: "nobody@example.com" }, publishedByEmail: "nobody@example.com" };
const rowOut = A.audienceRow(sentEmail);
assert.deepEqual(rowOut, { id: "101", name: "210926_GEN_Catt_LE_26 - Announcement (LE)", state: "PUBLISHED", send_at: "2026-09-21 08:00:00", campaign: "Catt_LE_26",
  sent: 137700, delivered: 137575, opened: 16677, clicked: 3103, unsubscribed: 410, spam: 3, lists_in: "11068", lists_out: "13134|14274", contacts_in: 0 });
assert.ok(!JSON.stringify(rowOut).includes("@"), "no address is carried");
const draft = { id: 102, name: "231026_CUS_Catt_LE_26 - Last Chance (LE)", state: "DRAFT", publishDate: "2026-10-13T08:00:00Z", stats: { counters: {} }, to: to(["9001", "9002"], [], [], [], ["c1", "c2", "c3"]) };
assert.deepEqual([A.audienceRow(draft).lists_in, A.audienceRow(draft).delivered, A.audienceRow(draft).contacts_in], ["9001|9002", 0, 3]);   // not sent yet, and it says who to
assert.equal(A.audienceRow({ id: 103, name: "000000_CUS_Release_code - Last Chance (LE) (2026 TEMPLATE)", state: "DRAFT", stats: { counters: {} }, to: to([], []) }), null);
const kinds = { "Insiders - Tier 1": "insiders", "Ai Weiwei sign ups": "sign_ups", "Parra SU 2026": "sign_ups", "Longo previous buyers": "buyers",
  "Related artist purchasers (Warhol)": "related_artist", "Draw miss outs - Dali": "missed_out", "Engaged last 90 days": "engaged",
  "All marketing contacts": "general", "Global suppression - unsubscribed": "exclusion", "Something else": "other", "": "other" };
for (const [n, want] of Object.entries(kinds)) assert.equal(A.listKind(n), want, `kind of "${n}"`);

// the pull: lists named when the token may read them, and the audiences written either way
const hubspotEmails = [sentEmail, draft, { id: 103, name: "template", state: "DRAFT", stats: { counters: {} }, to: to([], []) }];
const listNames = { 11068: "All marketing contacts", 13134: "Global suppression - unsubscribed", 9001: "Catt sign ups" };
let listsAllowed = true;
const withLists = await A.fetchAudiences(Date.parse("2026-11-16T00:00:00Z"));
assert.equal(withLists.pulled, 2);
assert.equal(withLists.sent, 1);
assert.equal(withLists.unsent, 1);
assert.equal(withLists.through, "2026-09-21");
assert.equal(withLists.listsNote, "3 of 5 lists named");
assert.ok(withLists.listsCsv.includes("11068,All marketing contacts,1200,general"));
assert.ok(withLists.listsCsv.includes("9001,Catt sign ups,1200,sign_ups"));
listsAllowed = false;
const without = await A.fetchAudiences(Date.parse("2026-11-16T00:00:00Z"));
assert.equal(without.listsCsv, null);
assert.match(without.listsNote, /list names unavailable \(HubSpot 403 - the token needs the crm\.lists\.read scope/);
assert.equal(without.csv.trim().split("\n").length, 3);       // the header and the two emails: the audiences are still written
assert.match(A.summary(without), /email audiences \d+ emails \(1 sent, through 2026-09-21; 1 not sent yet/);

console.log("comms plan and email audiences: ok");
