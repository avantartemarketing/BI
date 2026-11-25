/* How the HubSpot pull merges what it fetched with the file on disk
 * (server/hubspot.js fetchEmailsCsv). Rows are replaced by HubSpot id, so an
 * email renamed after it went replaces its own row instead of standing beside
 * it. Marina Abramovic's announcement of 18 November 2026 was pulled as
 * "131126_CUS_..." and renamed "181126_GEN_..." afterwards: the file kept both
 * rows and the page counted 273,244 delivered for a send of 136,622.
 *   node tests/hubspot_merge.mjs */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const dir = mkdtempSync(join(tmpdir(), "hubspot-merge-"));
const csv = join(dir, "all_sent_emails.csv");
process.env.HUBSPOT_TOKEN = "stand-in";
process.env.HUBSPOT_API = "https://hubspot.test/emails";
process.env.HUBSPOT_CSV = csv;

const require = createRequire(import.meta.url);
const { fetchEmailsCsv } = require("../server/hubspot.js");

const header = "Email Name,Send Date (Your time zone),Campaign,Delivered,Opened,Clicked,Unsubscribed,Kind";
const email = (id, name, publishDate, type, delivered, open, click) =>
  ({ id, name, publishDate, type, campaignName: "", stats: { counters: { sent: delivered + 10, delivered, open, click, unsubscribed: 0 } } });
let results = [];
globalThis.fetch = async (url) => {
  assert.ok(String(url).startsWith("https://hubspot.test/emails"), `only the stand-in is called: ${url}`);
  return { ok: true, status: 200, json: async () => ({ results, paging: null }), text: async () => "" };
};
const lines = () => readFileSync(csv, "utf8").trim().split("\n");
const rows = (out) => out.csv.trim().split("\n").slice(1).map((l) => l.split(","));

/* ---- a file from before the Id column, holding the send under its earlier
 * name, and a pull that brings it back renamed */
writeFileSync(csv, header + "\n"
  + "\"131126_CUS_MarinaAbram_TL_26 - Announcement (TL Non-flow)\",2026-11-18 17:00:06,MarinaAbram_TL_26,136622,13857,2105,290,\n"
  + "\"130126_GEN_MarinaAbr-1502 - Announcement\",2026-01-13 17:00:46,MarinaAbr-1502,126189,21755,4028,952,batch\n"
  + "\"181126_GEN_OtherArtist_TL_26 - Announcement\",2026-11-18 17:00:06,OtherArtist_TL_26,9000,900,90,9,batch\n");
results = [email("227328693040", "181126_GEN_MarinaAbram_TL_26 - Announcement (TL Non-flow)", "2026-11-18T17:00:06Z", "BATCH_EMAIL", 136622, 13916, 2109)];
let out = await fetchEmailsCsv(Date.parse("2026-11-25T12:00:00Z"));
assert.strictEqual(out.csv.split("\n")[0], header + ",Id", "the Id column is written");
let got = rows(out);
assert.deepStrictEqual(got.map((r) => r[0]).filter((n) => n.includes("MarinaAbram")),
  ["181126_GEN_MarinaAbram_TL_26 - Announcement (TL Non-flow)"], "the renamed send stands once, under its new name");
assert.strictEqual(got.length, 3, "the two other sends are kept");
assert.strictEqual(out.renamed, 1, "the earlier name is reported as dropped");
assert.strictEqual(out.kept, 2);
const marina = got.find((r) => r[0].includes("MarinaAbram"));
assert.strictEqual(marina[8], "227328693040", "the row carries the HubSpot id");
assert.strictEqual(marina[3], "136622");
// a different send that happened to go at the same second is not the same send
assert.ok(got.some((r) => r[0].includes("OtherArtist")), "a send at the same second with another delivered count is kept");
writeFileSync(csv, out.csv);

/* ---- the next pull: renamed again, replaced by id whatever the name says */
results = [email("227328693040", "181126_GEN_MarinaAbram_TL_26 - Announcement (TL Non-flow) v2", "2026-11-18T17:00:06Z", "BATCH_EMAIL", 136622, 13920, 2110)];
out = await fetchEmailsCsv(Date.parse("2026-11-26T12:00:00Z"));
got = rows(out);
assert.deepStrictEqual(got.filter((r) => r[0].includes("MarinaAbram")).map((r) => [r[0], r[4]]),
  [["181126_GEN_MarinaAbram_TL_26 - Announcement (TL Non-flow) v2", "13920"]], "replaced by id, with the fresh counts");
assert.strictEqual(out.renamed, 0);
assert.strictEqual(got.length, 3);
writeFileSync(csv, out.csv);

/* ---- a row kept from the file keeps its id, so a later pull still replaces it */
results = [email("1", "x_GEN_Nobody - y", "2026-11-20T10:00:00Z", "BATCH_EMAIL", 5, 1, 0)];
out = await fetchEmailsCsv(Date.parse("2026-11-27T12:00:00Z"));
got = rows(out);
assert.strictEqual(got.find((r) => r[0].includes("MarinaAbram"))[8], "227328693040", "the kept row keeps its id");
assert.strictEqual(got.length, 4);
assert.strictEqual(lines().length, 4, "the file on disk is untouched by the pull itself");

console.log("hubspot merge: ok");
