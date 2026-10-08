/* The Notion pull end to end against a stand-in for the API (fetch is
 * replaced; nothing leaves the machine): the posts rows link to release pages
 * in a campaigns database, where the marketing lead is a relation to a team
 * page whose title is the name - the shape the team's database has. The
 * lead comes through one hop (Release → Marketing Lead), a campaigns
 * database's own column wins over it, a team page the integration cannot
 * read is counted and said, and the posts and dates files are as before.
 *   node tests/notion_pull.mjs */
import { createRequire } from "node:module";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);

// the releases the pull matches against, as the build writes them to inputs.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notion-pull-"));
fs.writeFileSync(path.join(tmp, "inputs.json"), JSON.stringify({
  releases: { bisa: { release_name: "Bisa Butler · Multiple · 2026 Q4", campaign_code: "BisaButler_TL_26", announce_date: "2026-10-01", launch_end: "2026-10-20" } },
  discovered: {
    catt: { release_name: "Maurizio Cattelan · Multiple · 2026 Q4", campaign_code: "", announce_date: "2026-10-05", launch_end: "2026-10-28" },
    dali: { release_name: "Salvador Dali Estate · Multiple · 2026 Q3", campaign_code: "Dali_LE_26", announce_date: "2026-09-01", launch_end: "2026-09-25" },
  },
}));
process.env.APP_DATA_PATH = tmp;
process.env.NOTION_TOKEN = "stand-in";          // only ever sent to the fetch below
process.env.NOTION_ARTIST_POSTS_DB = "postsdb";
process.env.NOTION_CAMPAIGNS_DB = "campdb";

const title = (t) => ({ type: "title", title: [{ plain_text: t }] });
const rel = (...ids) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false });
const sel = (name) => ({ type: "select", select: { name } });
const when = (d) => ({ type: "date", date: { start: d } });
const status = (name) => ({ type: "status", status: { name } });

// the pages behind the relations: release pages (the campaigns database) and team pages
const pages = {
  r_bisa: { Release: title("Bisa Butler - Be Mine / Harriet Tubman"), Status: status("7. In Flight"), "Marketing Lead": rel("t_maria"), Designer: sel("Iz") },
  r_catt: { Release: title("Maurizio Cattelan - Horse & Elephant"), Status: status("7. In Flight"), "Marketing Lead": rel("t_clare") },
  r_dali: { Release: title("Salvador Dali Estate - TBC"), Status: status("7. In Flight"), "Marketing Lead": rel("t_missing") },   // a team page not shared with the integration
  t_maria: { Name: title("Maria"), Email: { type: "email", email: "nobody@example.com" } },
  t_clare: { Name: title("Clare") },
};
const post = (id, name, date, channel, release) => ({ id, created_time: `${date}T10:00:00.000Z`, properties: { Name: title(name), "Live Date": when(date), Channel: sel(channel), Release: rel(release) } });
const postRows = [
  post("p1", "Announce post", "2026-10-02", "AA IG Main", "r_bisa"),
  post("p2", "Early/Exclusive access (LE)", "2026-10-03", "AA Email", "r_bisa"),
  post("p3", "Announce story", "2026-10-06", "Artist post", "r_catt"),
  post("p4", "Launch day story", "2026-09-24", "AA IG Main", "r_dali"),
];
// the campaigns database read directly: its own lead column, a relation too, and a launch date
const campRows = [
  { id: "c1", properties: { Release: title("Bisa Butler - Be Mine / Harriet Tubman"), "Marketing Lead": rel("t_clare"), Launch: when("2026-10-20") } },
];
const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push(u);
  assert.ok(opts && opts.headers && opts.headers.Authorization === "Bearer stand-in", "the token rides in the header");
  let body;
  if (u.endsWith("/databases/postsdb/query")) body = { results: postRows, has_more: false };
  else if (u.endsWith("/databases/campdb/query")) body = { results: campRows, has_more: false };
  else {
    const m = u.match(/\/pages\/([^/]+)$/);
    const id = m && m[1];
    if (!id || !pages[id]) return new Response("object_not_found", { status: 404 });
    body = { id, properties: pages[id] };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const { fetchPostsCsv, leadOf, leadNamesAsync, leadRank } = require("../server/notion.js");

// a relation lead reads the linked page's title; the row's own column by rank, the linked page's over a weaker one
assert.deepStrictEqual(await leadNamesAsync(rel("t_maria", "t_clare"), "stand-in"), ["Maria", "Clare"]);
assert.deepStrictEqual(await leadNamesAsync(rel("t_missing"), "stand-in"), []);
assert.deepStrictEqual(leadRank(pages.r_bisa), { name: "Marketing Lead", rank: 0 });
let lead = await leadOf(postRows[0].properties, "stand-in");
assert.deepStrictEqual(lead, { name: "Marketing Lead", rank: 0, names: ["Maria"], from: "Release → Marketing Lead" }, JSON.stringify(lead));
lead = await leadOf({ ...postRows[0].properties, Owner: { type: "people", people: [{ object: "user", id: "u1", name: "Poster" }] } }, "stand-in");
assert.strictEqual(lead.names[0], "Maria", "the release page's Marketing Lead outranks the row's Owner: " + JSON.stringify(lead));
lead = await leadOf({ Name: title("x"), Owner: { type: "people", people: [{ object: "user", id: "u1", name: "Poster" }] } }, "stand-in");
assert.deepStrictEqual(lead.names, ["Poster"], "the row's own column stands when nothing links further");
lead = await leadOf(postRows[3].properties, "stand-in");
assert.deepStrictEqual([lead.names, lead.from], [[], "Release → Marketing Lead"], "a column whose page cannot be read comes back named but empty");
assert.strictEqual(await leadOf({ Name: title("x") }, "stand-in"), null);

// the whole pull
const out = await fetchPostsCsv();
assert.strictEqual(out.matched, 4, `every row matched its release (${out.matched}, ${out.unmatched} unmatched)`);
const rows = (csv) => { const [h, ...ls] = csv.trim().split("\n").map((l) => l.split(",")); return ls.map((l) => Object.fromEntries(h.map((k, i) => [k, l[i]]))); };
const posts = rows(out.csv);
assert.deepStrictEqual(posts.find((r) => r.campaign_code === "BisaButler_TL_26" && r.date === "2026-10-02"), { campaign_code: "BisaButler_TL_26", date: "2026-10-02", channel: "brand", posts: "1" });
const dates = Object.fromEntries(rows(out.datesCsv).map((r) => [r.campaign_code || `name:${r.release_name}`, r]));
// the campaigns database's own lead (Clare) wins over the posts' reading (Maria) for Bisa Butler, with its launch date
assert.strictEqual(dates.BisaButler_TL_26.marketing_lead, "Clare", JSON.stringify(dates.BisaButler_TL_26));
assert.strictEqual(dates.BisaButler_TL_26.launch_end, "2026-10-20");
assert.strictEqual(dates.BisaButler_TL_26.private_room_open, "2026-10-03", "the dates read off the posts still stand");
assert.strictEqual(dates.BisaButler_TL_26.source, "campaigns db");
// Cattelan, no code yet: the lead through the post's release page, keyed by name
assert.strictEqual(dates["name:Maurizio Cattelan · Multiple · 2026 Q4"].marketing_lead, "Clare", JSON.stringify(dates));
// Dali: a launch date off the rows, no lead - the team page could not be read
assert.strictEqual(dates.Dali_LE_26.marketing_lead, "");
assert.strictEqual(dates.Dali_LE_26.launch_end, "2026-09-24");
assert.strictEqual(out.leadsFor, 2);
assert.strictEqual(out.pagesUnread, 1);
assert.ok(out.leadNote.startsWith('marketing lead for 2 releases (from "Marketing Lead (campaigns database)", "Release → Marketing Lead")'), out.leadNote);
assert.ok(out.leadNote.includes("1 linked page could not be read (share the database it is in with the integration)"), out.leadNote);
// no email left the people or team pages
assert.ok(!out.datesCsv.includes("@") && !out.leadNote.includes("@"));
// each linked page was fetched once for the whole pull
assert.strictEqual(calls.filter((u) => u.endsWith("/pages/t_maria")).length, 1, "the team page is read once");
assert.strictEqual(calls.filter((u) => u.endsWith("/pages/r_bisa")).length, 1, "the release page is read once");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("notion pull: ok (the lead through the release page, the campaigns database over it, an unreadable page said)");
