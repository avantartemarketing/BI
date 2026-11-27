/* The Agent's diagnosis skill, end to end without a key or the network: the
 * route (server/agent/index.js) runs against a stand-in for the Claude API on
 * a local port, on a small launch made up for the test.
 *
 *   - the skill on file: its header, its method;
 *   - the diagnosis sheet (server/agent/diagnose.js): the stages in order, the
 *     plan and the reference launches off the page, the artist's earlier
 *     launch read from its own days at the same point of its campaign, the
 *     reader's Direct display, a launch with nothing to diagnose;
 *   - the Diagnose press (skill "diagnose" on the request): the method and the
 *     sheet go to the model with the question, after the cached prompt, and
 *     the chat is told what is being compared;
 *   - a typed question: the model calls diagnose_release and gets the method
 *     back with the sheet;
 *   - nothing here writes.                         node tests/agent_skill.mjs */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const express = require("express");
const { loadSkill, listSkills, parse } = require("../server/agent/skills.js");
const { createTools, TOOL_DEFS } = require("../server/agent/tools.js");
const { createDiagnose, reading, shareGone, shortName } = require("../server/agent/diagnose.js");

// ---- the skill on file
const skill = loadSkill("diagnose");
assert.ok(skill && skill.title === "Diagnose this release" && /going wrong/.test(skill.when), "the skill's header");
assert.ok(/^# Diagnosing a launch/.test(skill.body) && !skill.body.startsWith("---"), "the method, without its header");
for (const word of ["sameArtist", "reference", "Stage by stage", "Ruled out", "weak point"]) assert.ok(skill.body.includes(word), `the method names ${word}`);
assert.ok(!skill.body.includes(String.fromCharCode(0x2014)), "the method keeps to plain hyphens");
assert.deepStrictEqual(listSkills().map((s) => s.name), ["diagnose"]);
assert.strictEqual(loadSkill("../../etc/passwd"), null, "a skill is a name, never a path");
assert.strictEqual(loadSkill("nope"), null);
assert.deepStrictEqual(parse("---\nname: x\nwhen: a: b\n---\nBody"), { name: "x", when: "a: b", body: "Body" });

// ---- the small things the sheet is built from
assert.strictEqual(reading(50, 100), "well short");
assert.strictEqual(reading(85, 100), "short");
assert.strictEqual(reading(100, 100), "in line");
assert.strictEqual(reading(130, 100), "ahead");
assert.strictEqual(reading(0.5, 0.25, { of: 12 }), "too few to read", "a rate over a handful of visits is not read");
assert.strictEqual(reading(1, 2, { floor: 3 }), "too few to read");
assert.strictEqual(reading(5, null), undefined);
assert.strictEqual(shareGone(2, 20, 0.5, false), 0.075, "the part of today not yet seen comes off the clock");
assert.strictEqual(shareGone(5, 20, 1, true), 1, "a closed campaign is whole");
assert.strictEqual(shortName("Ann Artist · Blue Work · 2025 Q2"), "Blue Work (2025 Q2)");

// ---- a launch made up for the test: live, day 2 of 20, with one earlier launch by the same artist
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skill-"));
const app = path.join(tmp, "data", "app");
fs.mkdirSync(app, { recursive: true });
const NOW = "Ann Artist · New Work · 2026 Q4", THEN = "Ann Artist · Blue Work · 2025 Q2", OTHER = "Bo Other · Red · 2025 Q3";
fs.writeFileSync(path.join(app, "index.json"), JSON.stringify({ asOf: "2026-11-27", releases: [
  { id: "new_le", releaseName: NOW, artist: "Ann Artist", type: "LE", status: "live", targeted: true, day: 2, of: 20 },
  { id: "blue_le", releaseName: THEN, artist: "Ann Artist", type: "LE", status: "closed", windowEnd: "2025-04-14" },
  { id: "ann_tl", releaseName: "Ann Artist · Timed Thing · 2025 Q4", artist: "Ann Artist", type: "TL", status: "closed" },
  { id: "soon_le", releaseName: "Cy Coming · Next · 2027 Q1", artist: "Cy Coming", type: "LE", status: "upcoming" },
] }));
const HEAD = "release,date,day,of,channel,visits,entrants,eligible,entries,units,visits_spread,entries_spread,units_spread,release_page_visits,went_to_product,product_page_visits,entered_from_product";
fs.writeFileSync(path.join(app, "funnel_daily.csv"), [HEAD,
  // the earlier launch: 40 days long, so the same point as day 2 of 20 (10%) is its day 4
  `${THEN},2025-03-05,0,40,AA Email,3000,60,50,50,2,3300,55,2,900,300,1500,45`,
  `${THEN},2025-03-05,0,40,Direct,300,5,5,5,0,0,0,0,100,20,150,5`,
  `${THEN},2025-03-09,4,40,AA Email,1000,20,15,15,1,1000,15,1,300,90,500,15`,
  `${THEN},2025-03-10,5,40,AA Email,500,10,10,10,0,500,10,0,100,30,250,10`,       // past the point: in its final, not its so-far
  `${THEN},2025-04-14,40,40,AA Email,700,10,10,10,90,700,10,90,100,30,300,10`,
  `${OTHER},2025-08-01,0,20,AA Email,2000,30,20,20,1,2000,20,1,500,100,900,18`,
  `${OTHER},2025-08-03,2,20,Paid,400,2,2,2,0,400,2,0,300,30,60,2`,
  `${OTHER},2025-08-21,20,20,AA Email,500,10,10,10,30,500,10,30,100,20,200,9`,
  `${NOW},2026-11-25,0,20,AA Email,1500,3,2,2,3,1600,2,4,500,110,900,3`,
  `${NOW},2026-11-26,1,20,Direct,100,0,0,0,1,0,0,0,60,10,50,0`,
].join("\n") + "\n");
const page = {
  id: "new_le", releaseName: NOW, artist: "Ann Artist", title: "New Work", type: "LE", asOf: "2026-11-27", asOfFraction: 1, day: 2, of: 20, complete: false, targeted: true,
  windowStart: "2026-11-25", windowEnd: "2026-12-15", edition: { total: 100 }, economics: { unitPrice: 6000 },
  hero: { now: 5, expectedToday: 32, delta: -27, projected: 60, target: 100, benchmark: 86, benchmarkToday: 28 },
  targets: { entries_target: 125, paid: { cost_per_entry: 700 } },
  channels: [{ key: "aa_email", name: "AA Email" }, { key: "direct_other", name: "Other" }, { key: "paid", name: "Paid" }],
  funnelByGroup: {
    aa_email: { sessions_actual: 1500, sessions_expected: 1700, sessions_benchmark: 1480, conv_actual: 0.003, conv_expected: 0.016, conv_benchmark_today: 0.016, contrib_traffic: -3.2, contrib_conversion: -19.5, contrib_traffic_bm: 0.3, contrib_conversion_bm: -19.5 },
    direct_other: { sessions_actual: 100, sessions_expected: 40, sessions_benchmark: 34, conv_actual: 0, conv_expected: 0.013, conv_benchmark_today: 0.013, contrib_traffic: 0.8, contrib_conversion: -1.3, contrib_traffic_bm: 0.9, contrib_conversion_bm: -1.3 },
    paid: { sessions_actual: 0, sessions_expected: 220, sessions_benchmark: 190, conv_actual: 0, conv_expected: 0.003, conv_benchmark_today: 0.003, contrib_traffic: 300, contrib_conversion: -304, contrib_traffic_bm: 280, contrib_conversion_bm: -284 },
  },
  pageFunnel: { organic: { clickThrough: { sessions: 560, through: 120, rate: 0.2143, bm: 0.2, bmN: 7 }, entry: { sessions: 950, through: 3, rate: 0.0032, bm: 0.0138, bmN: 8 } }, paid: { clickThrough: { sessions: 7, through: 0, rate: null, bm: 0.05, bmN: 1 }, entry: { sessions: 9, through: 0, rate: null, bm: 0.01, bmN: 3 } } },
  email: { sends: 2, delivered: 54000, opened: 6500, clicked: 1100, openRate: 0.12, clickRate: 0.0204, feedThrough: "2026-11-27", deliveredTarget: 38000, deliveredBenchmark: 33000,
    sequence: [{ name: "Early Access (LE)", date: "2026-11-23", delivered: 2700, opened: 900, clicked: 430 }, { name: "Announcement (LE)", date: "2026-11-25", delivered: 51300, opened: 5600, clicked: 670 }] },
  benchmarks: { emailOpenRateRef: 16.3, emailClickRateRef: 3.2, emailRefCohort: { n: 55 } },
  social: { posts: 0, stories: 0, artistPosts: 0, artistPostsTarget: 2 },
  paid: { spendToDate: 0, spendBudget: 13000, entriesToDate: 0, roiTarget: 1.1 },
  sellthrough: { unitsPaidOrders: 4, sold: 4, drafts: 0, inHandUnits: 1, conversion: 0.8, draws: [{ entrants: 3, eligible: 2, winners: 1, sold: 1, wonUnpaid: 0, open: 1 }],
    products: [{ name: "One", edition: 50, sold: 4, shown: 0, expectedToday: 16, benchmarkToday: 14 }, { name: "Two", edition: 50, sold: 0, shown: 0.8, expectedToday: 16, benchmarkToday: 14 }] },
  unitsPerBuyer: { plan: 1, actual: 1 },
  waterfall: { today: { steps: [{ key: "organic_traffic", value: -2 }, { key: "organic_conversion", value: -21 }, { key: "paid_spend", value: -4 }, { key: "paid_efficiency", value: 0 }], stepsBm: [{ key: "organic_traffic", value: 1 }, { key: "organic_conversion", value: -21 }] } },
  benchmark: { basket: { id: "similar", name: "Similar size and shape", n: 2 }, members: [{ name: OTHER, artist: "Bo Other", title: "Red", quarter: "2025 Q3", units: 31, price: 4000 }, { name: THEN, artist: "Ann Artist", title: "Blue Work", quarter: "2025 Q2", units: 93, price: 6000 }] },
  variants: { direct_spread: { funnelByGroup: null } },
};
page.variants.direct_spread.funnelByGroup = { ...page.funnelByGroup, aa_email: { ...page.funnelByGroup.aa_email, sessions_actual: 1600 }, direct_other: { ...page.funnelByGroup.direct_other, sessions_actual: 0 } };
const pages = {
  new_le: page,
  blue_le: { id: "blue_le", releaseName: THEN, type: "LE", complete: true, hero: { now: 93 }, sellthrough: { editionSum: 100 } },
  soon_le: { id: "soon_le", releaseName: "Cy Coming · Next · 2027 Q1", artist: "Cy Coming", type: "LE", upcoming: true },
  old_le: { id: "old_le", releaseName: "Di Old · Then · 2022 Q1", artist: "Di Old", type: "LE", catalogue: true },
};
const readSnapshot = (id) => (pages[id] ? JSON.parse(JSON.stringify(pages[id])) : null);
const tools = createTools({ ROOT: tmp, DATA: app, readSnapshot });
const { diagnose } = createDiagnose({ tools, readSnapshot });

// ---- the sheet
const sheet = diagnose({ id: "new_le" });
assert.deepStrictEqual(sheet.stages.map((s) => s.stage), ["Told", "Responded", "Visited", "Looked at a work", "Entered", "Bought", "Which work"], "the funnel, in order");
assert.match(sheet.release.state, /day 2 of 20, 18 days left/);
assert.match(sheet.comparison.point, /10%: day 2 of 20 here/);
// the artist's earlier launch, read to the same share of its own campaign, never its totals
assert.deepStrictEqual(sheet.comparison.sameArtist.map((m) => [m.launch, m.readTo, m.edition, m.price, m.finalUnits]), [["Blue Work (2025 Q2)", "day 4 of 40", 100, 6000, 93]]);
const stage = (name) => sheet.stages.find((s) => s.stage === name);
const visited = stage("Visited");
assert.deepStrictEqual([visited.total.now, visited.total.plan, visited.total.reference], [1600, 1960, 1704], "this launch off its page, as the reader sees it");
assert.deepStrictEqual(visited.sameArtist, [{ launch: "Blue Work (2025 Q2)", byThisPoint: 4300, final: 5500, byChannel: { "AA Email": 4300 } }], "the earlier launch by day 4, Direct spread as the page is");
const entered = stage("Entered");
assert.deepStrictEqual(entered.sameArtist[0].byThisPoint, { visits: 4300, entrants: 85, eligibleEntrants: 70, entries: 70, unitsPaid: 3, entriesPerVisit: 0.0163, eligibleShare: 0.8235 });
assert.deepStrictEqual(entered.sameArtist[0].final.entries, 90);
assert.deepStrictEqual(entered.sameArtist[0].shareOfFinalByThisPoint, { visits: 0.7818, entries: 0.7778 });
assert.deepStrictEqual(entered.soFar.entries, 2);
assert.strictEqual(entered.read, "well short");
assert.match(entered.readAgainst, /Blue Work/);
assert.strictEqual(entered.fromAWorkPage.everythingButAds.read, "well short");
assert.strictEqual(entered.fromAWorkPage.ads.read, undefined, "nine visits are too few for a rate");
assert.deepStrictEqual(entered.fromAWorkPage.sameArtist, [{ launch: "Blue Work (2025 Q2)", everythingButAds: 0.0302 }], "65 of the 2,150 who saw a work's page by day 4");
assert.strictEqual(entered.reference.launches, "2 of 2 read from their own days");
assert.strictEqual(stage("Looked at a work").everythingButAds.read, "in line");
assert.strictEqual(stage("Responded").opened.read, "short");
assert.strictEqual(stage("Told").emails.read, "ahead");
assert.strictEqual(stage("Told").ads.started, false);
assert.deepStrictEqual(stage("Which work").works.map((w) => [w.work, w.read]), [["One", "well short"], ["Two", "well short"]]);
// the gap, in units, and the first pass: ads read as one figure, so the email visits' conversion leads
assert.strictEqual(sheet.gap.againstPlan.total, -27);
assert.deepStrictEqual(sheet.gap.byChannel.find((c) => c.channel === "Paid").net, -4);
assert.match(sheet.firstRead, /what AA Email visits turned into, -19 units of the -27/);
assert.ok(JSON.stringify(sheet).length < 16000, "the sheet stays small");
assert.ok(!/undefined|null|NaN/.test(JSON.stringify(sheet)), "nothing empty on the sheet");
// the reader's Direct display: Direct left in Other
const asChannel = diagnose({ id: "new_le", display: "channel" });
assert.strictEqual(asChannel.stages.find((s) => s.stage === "Visited").total.now, 1600);
assert.deepStrictEqual(asChannel.stages.find((s) => s.stage === "Visited").sameArtist[0].byChannel, { "AA Email": 4000, Other: 300 });
// nothing to diagnose
assert.match(diagnose({ id: "soon_le" }).nothingYet, /not been announced/);
assert.match(diagnose({ id: "old_le" }).nothingYet, /older work/);
assert.throws(() => diagnose({ id: "no_such" }), /No release/);
// a server whose build has not written the launches' days yet still gives the page's stages
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skill-bare-"));
  fs.mkdirSync(path.join(bare, "data", "app"), { recursive: true });
  fs.writeFileSync(path.join(bare, "data", "app", "index.json"), JSON.stringify({ releases: [] }));
  const t2 = createTools({ ROOT: bare, DATA: path.join(bare, "data", "app"), readSnapshot });
  const s2 = createDiagnose({ tools: t2, readSnapshot }).diagnose({ id: "new_le" });
  assert.match(s2.comparison.sameArtistNote, /has not been built/);
  assert.ok(s2.stages.some((s) => s.stage === "Visited") && !s2.stages.find((s) => s.stage === "Visited").sameArtist);
  fs.rmSync(bare, { recursive: true, force: true });
}

// ---- the tools the model sees: the diagnosis beside the six, none of them a writer
assert.deepStrictEqual(TOOL_DEFS.map((x) => x.name), ["list_releases", "get_release", "diagnose_release", "describe_table", "query_table", "read_docs", "make_chart"]);
for (const f of ["diagnose.js", "skills.js"]) {
  assert.ok(!/writeFile|appendFile|unlink|rename|mkdir/.test(fs.readFileSync(path.join(ROOT, "server", "agent", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")), `${f} only reads`);
}

// ---- the route, against a stand-in for the Claude API
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
const textReply = (text) => sse([start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" }]);
const toolReply = (name, input) => sse([start,
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_test", name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" }]);
const asked = [];      // every request body the route sent to the API
let script = [];       // the replies to give, in order
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    asked.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(script.shift() || textReply("(no reply scripted)"));
  });
});
await new Promise((ok) => api.listen(0, "127.0.0.1", ok));
const keep = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const site = express();
site.use(express.json());
const logged = [];
const realLog = console.log;
console.log = (...a) => { logged.push(a.join(" ")); };
require("../server/agent/index.js").install(site, { ROOT: tmp, DATA: app, readSnapshot, sessionEmail: () => "tester" });
const server = await new Promise((ok) => { const s = site.listen(0, "127.0.0.1", () => ok(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/agent`;
async function ask(body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const events = [];
  for (const chunk of (await r.text()).split("\n\n")) {
    const ev = /^event: (.*)$/m.exec(chunk), data = /^data: (.*)$/m.exec(chunk);
    if (ev && data) events.push([ev[1], JSON.parse(data[1])]);
  }
  return events;
}
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text || (typeof b.content === "string" ? b.content : "")).join("\n"));

try {
  // the Diagnose press: the method and the launch's sheet go with the question, after the cached prompt
  script = [textReply("**The finding.** People are arriving but not entering.")];
  let ev = await ask({ context: { view: "release", release: "new_le", tab: "agent", display: "spread" }, messages: [{ role: "user", content: "Diagnose this release" }], skill: "diagnose" });
  assert.deepStrictEqual(ev.filter(([e]) => e === "status").map(([, d]) => d.text), ["Comparing each stage with Ann Artist's earlier launches"], "the chat is told what is being compared");
  assert.strictEqual(ev.find(([e]) => e === "done")[1].text, "**The finding.** People are arriving but not entering.");
  let sent = asked.pop();
  assert.ok(sent.tools.some((t) => t.name === "diagnose_release"));
  assert.match(sent.system[0].text, /<skills>\n- diagnose \("Diagnose this release"\)/, "the prompt lists the skill");
  assert.ok(!sent.system[0].text.includes("<diagnosis_sheet"), "the sheet is not in the cached prompt");
  const brief = textOf(sent.messages[sent.messages.length - 1]);
  assert.match(brief, /in the Agent tab of the page of Ann Artist · New Work · 2026 Q4/);
  assert.match(brief, /The reader pressed "Diagnose this release"/);
  assert.ok(!/keep it short: the answer first/.test(brief), "the short-answer line gives way to the method's shape");
  assert.match(brief, /<skill name="diagnose">\n# Diagnosing a launch/);
  assert.deepStrictEqual(JSON.parse(/<diagnosis_sheet release="new_le">\n(.*)\n<\/diagnosis_sheet>/.exec(brief)[1]), sheet, "the sheet the model reads is the one above");
  assert.ok(logged.some((l) => /agent: new_le 200 .*skill=diagnose/.test(l)) && !logged.some((l) => /Diagnose this release|arriving/.test(l)), "the log names the skill, never the question or the answer");

  // a skill nobody wrote is not switched on; the question is answered as any other
  script = [textReply("Fine.")];
  ev = await ask({ context: { view: "release", release: "new_le" }, messages: [{ role: "user", content: "How is it doing?" }], skill: "nope" });
  sent = asked.pop();
  assert.match(textOf(sent.messages[sent.messages.length - 1]), /keep it short: the answer first/);
  assert.ok(!textOf(sent.messages[sent.messages.length - 1]).includes("<skill"));

  // the press away from a release's page: the method, and a word to find the launch first
  script = [textReply("Which launch?")];
  await ask({ context: { view: "home" }, messages: [{ role: "user", content: "Diagnose this release" }], skill: "diagnose" });
  sent = asked.pop();
  assert.match(textOf(sent.messages[sent.messages.length - 1]), /not on a release's page: ask which launch/);

  // a typed question: the model reaches for the tool and gets the method back with the sheet
  script = [toolReply("diagnose_release", { id: "new_le" }), textReply("It is the entry step.")];
  ev = await ask({ context: { view: "release", release: "new_le", display: "channel" }, messages: [{ role: "user", content: "What is going wrong here?" }] });
  assert.deepStrictEqual(ev.filter(([e]) => e === "status").map(([, d]) => d.text), ["Going through Ann Artist's funnel stage by stage"]);
  assert.strictEqual(ev.find(([e]) => e === "done")[1].text, "It is the entry step.");
  sent = asked.pop();
  const result = JSON.parse(sent.messages[sent.messages.length - 1].content.find((b) => b.type === "tool_result").content);
  assert.match(result.method, /^# Diagnosing a launch/);
  assert.deepStrictEqual(result.sheet, asChannel, "with the reader's Direct display, since the model named none");
} finally {
  console.log = realLog;
  await new Promise((ok) => server.close(ok));
  await new Promise((ok) => api.close(ok));
  for (const [k, v] of [["ANTHROPIC_API_KEY", keep.key], ["ANTHROPIC_BASE_URL", keep.base], ["ANTHROPIC_AUTH_TOKEN", keep.token]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("agent skill: ok");
