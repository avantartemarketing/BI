/* POST /api/releases/:id/slack end to end, against a stand-in Slack.
 *
 * Starts the service with SLACK_API pointed at a local stand-in, signs in,
 * and presses the button the way the browser does: a JSON body naming the
 * horizon and, for a test, a layout. One chat.postMessage call carries the
 * message, blocks and all, to the channel by name; a dry run returns the
 * message and calls nothing; a refusal from Slack is a failed post said in
 * words; a release without a channel is refused before Slack is asked
 * anything; the layout test posts the three candidates, each named, to the
 * channel it is given, and says which of them Slack refused.
 *
 *   node tests/slack_route.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RELEASE = "julianschnabel_le_26";
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.error("FAIL", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in Slack
const seen = [];
let refuse = null;   // an error code to answer with instead of ok
let refuseWhen = null;   // or a test of the message body that earns the refusal
const body = (req) => new Promise((resolve) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => resolve(Buffer.concat(parts)));
});
const slackStub = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const raw = await body(req);
  let json = null;
  try { json = JSON.parse(raw.toString()); } catch { /* not json */ }
  seen.push({ path: url.pathname, json, authorized: /^Bearer \S+$/.test(req.headers.authorization || "") });
  const answer = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/api/chat.postMessage") {
    if (refuse && (!refuseWhen || refuseWhen(json))) return answer({ ok: false, error: refuse });
    return answer({ ok: true, ts: "1.1", channel: "C0SALESUPD1" });
  }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => slackStub.listen(0, "127.0.0.1", r));
const slackBase = `http://127.0.0.1:${slackStub.address().port}`;

// ---- the service
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-route-"));
const PORT = 10175;
const app = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT), SHEETS_REFRESH: "off", BIGQUERY: "off", BQ_EVENTS: "off",
    LOGIN_PASSWORD: "test-pass-1234", LOGIN_USERS: "tom.lloyd@avantarte.com",
    SESSION_SECRET: "test-secret", USERS_PATH: path.join(tmp, "users.json"),
    LAYOUT_PATH: path.join(tmp, "layout.json"), SAVED_INPUTS_PATH: path.join(tmp, "inputs.saved.json"),
    TARGETS_LOG: path.join(tmp, "targets.log"), DECISIONS_PATH: path.join(tmp, "decisions.log"),
    SLACK_STATE_PATH: path.join(tmp, "slack.json"), SLACK_STATE_FALLBACK_PATH: path.join(tmp, "slack.json"),
    SLACK_BOT_TOKEN: "xoxb-test", SLACK_API: `${slackBase}/api/chat.postMessage`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
app.stdout.on("data", (d) => { log += d; });
app.stderr.on("data", (d) => { log += d; });
const stop = () => { app.kill(); slackStub.close(); };
process.on("exit", stop);

const base = `http://127.0.0.1:${PORT}`;
const slackStateNow = () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, "slack.json"), "utf8")); } catch { return null; } };
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* still starting */ }
  await sleep(250);
}

// ---- sign in
const login = await fetch(`${base}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tom.lloyd@avantarte.com", password: "test-pass-1234" }),
});
check(login.ok, `signed in (${login.status}${login.ok ? "" : " - " + log.slice(-300)})`);
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const send = (url, opts = {}) => fetch(base + url, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
const post = (id, payload) => send(`/api/releases/${id}/slack`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

// ---- no channel yet: refused before Slack is asked anything
seen.length = 0;
let r = await post(RELEASE, { horizon: "today" });
let d = await r.json().catch(() => ({}));
check(r.status === 400 && /Target setting/.test(d.error || ""), `no channel, no post: ${r.status} ${d.error}`);
check(seen.length === 0, "and Slack is not called");
r = await post("no_such_release", { horizon: "today" });
check(r.status === 404, `an unknown release is a 404 (${r.status})`);

// ---- set the channel by name, as typed on the Target setting tab
const setCh = await send(`/api/releases/${RELEASE}/slack-channel`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "#sales-updates" }),
});
check(setCh.ok, `channel set (${setCh.status})`);

// ---- the post: one message, blocks and all, to the channel by name
seen.length = 0;
r = await post(RELEASE, { horizon: "today" });
d = await r.json().catch(() => ({}));
check(r.ok && d.ok === true && d.channel === "sales-updates", `posted (${r.status} ${JSON.stringify(d).slice(0, 200)})`);
check(d.slack && d.slack.lastPostAt && d.slack.lastPostBy === "tom.lloyd@avantarte.com", "the post is recorded against the release");
check(seen.length === 1 && seen[0].path === "/api/chat.postMessage", `one call, chat.postMessage: ${seen.map((s) => s.path).join(" ")}`);
const msg = seen[0].json || {};
check(seen[0].authorized, "the call carries the bot token");
check(msg.channel === "#sales-updates", `to the channel by name: ${msg.channel}`);
check(/^Julian Schnabel: \d+% sold through, [\d,]+ of [\d,]+ units$/.test(msg.text || ""), `the notification text: ${msg.text}`);
const types = (msg.blocks || []).map((b) => b.type);
check(types.join(" ") === "header context section table section", `the blocks: ${types.join(" ")}`);
const table = (msg.blocks || []).find((b) => b.type === "table");
check(table && table.rows.length === 4 && table.rows.every((r) => r.length === 3) && /^\d+ of 200$/.test(table.rows[1][1].text), "three products, three cells each: name, units of the edition, share");
check(msg.unfurl_links === false && msg.unfurl_media === false, "no unfurling");
check(!/at close/.test(msg.text), "today's horizon says nothing about close");

// ---- at close, as a dry run: the message comes back, Slack is not called
seen.length = 0;
r = await post(RELEASE, { horizon: "close", dryRun: true });
d = await r.json().catch(() => ({}));
check(r.ok && Array.isArray(d.blocks) && d.channel === "sales-updates", `dry run returns the message (${r.status})`);
check(/: \d+% projected at close, /.test(d.text || "") && /^\*\d+% projected at close\*/.test((d.blocks.find((b) => b.type === "section") || { text: {} }).text.text || ""), `at close: ${d.text}`);
check(seen.length === 0, "a dry run calls nothing");

// ---- a layout named in the body: the chart, as a dry run; an unknown one is the table
seen.length = 0;
r = await post(RELEASE, { horizon: "today", layout: "chart", dryRun: true });
d = await r.json().catch(() => ({}));
check(r.ok && d.layout === "chart" && d.blocks.some((b) => b.type === "data_visualization"), `the chart layout on request (${r.status} ${d.layout})`);
r = await post(RELEASE, { horizon: "today", layout: "no_such", dryRun: true });
d = await r.json().catch(() => ({}));
check(r.ok && d.layout === "table" && d.blocks.some((b) => b.type === "table"), `an unknown layout is the table (${d.layout})`);
check(seen.length === 0, "dry runs call nothing");

// ---- the layout test: three named messages to the channel it is given, nothing recorded
r = await post(RELEASE, { horizon: "today", layout: "test", channel: "#slack-test", dryRun: true });
d = await r.json().catch(() => ({}));
check(r.ok && d.channel === "slack-test" && d.test.map((t) => t.layout).join(" ") === "chart chart_table cards", `the test's dry run lists the three (${r.status} ${JSON.stringify(d).slice(0, 120)})`);
check(d.test.every((t) => t.blocks[0].type === "context" && /Option [ABC]/.test(t.blocks[0].elements[0].text)), "each named as an option");
seen.length = 0;
const before = JSON.stringify(slackStateNow());
r = await post(RELEASE, { horizon: "today", layout: "test", channel: "slack-test" });
d = await r.json().catch(() => ({}));
check(r.ok && d.ok === true && d.posted.join(" ") === "chart chart_table cards" && d.failed.length === 0 && !d.warning, `the test posts three (${r.status} ${JSON.stringify(d).slice(0, 160)})`);
check(seen.length === 3 && seen.every((s) => s.path === "/api/chat.postMessage" && s.json.channel === "#slack-test"), `three messages to #slack-test: ${seen.map((s) => s.json && s.json.channel).join(" ")}`);
check(seen.map((s) => s.json.blocks.map((b) => b.type).filter((t) => ["data_visualization", "data_table", "carousel"].includes(t)).join("+")).join(" ") === "data_visualization data_visualization+data_table carousel", `one layout each, in order: ${seen.map((s) => s.json.blocks.map((b) => b.type).join(",")).join(" | ")}`);
check(JSON.stringify(slackStateNow()) === before, "a test records no post against the release");
// one of them refused by Slack: the others still post, and the answer says which failed
seen.length = 0;
refuse = "invalid_blocks"; refuseWhen = (json) => JSON.stringify(json.blocks).includes('"data_table"');
r = await post(RELEASE, { horizon: "today", layout: "test", channel: "slack-test" });
d = await r.json().catch(() => ({}));
check(r.ok && d.posted.join(" ") === "chart cards" && d.failed.length === 1 && d.failed[0].layout === "chart_table" && /chart_table did not post/.test(d.warning || ""), `a refused layout is named (${r.status} ${JSON.stringify(d).slice(0, 200)})`);
refuse = null; refuseWhen = null;
r = await post(RELEASE, { horizon: "today", layout: "test", channel: "bad name" });
check(r.status === 400, `a channel name Slack could not take is refused (${r.status})`);

// ---- a refusal from Slack is a failed post, said in words
seen.length = 0;
refuse = "not_in_channel";
r = await post(RELEASE, { horizon: "today" });
d = await r.json().catch(() => ({}));
check(r.status === 502 && /chat:write\.public/.test(d.error || "") && /sales-updates/.test(d.error || ""), `refused with the remedy named: ${r.status} ${d.error}`);
refuse = "missing_scope";
r = await post(RELEASE, { horizon: "today" });
d = await r.json().catch(() => ({}));
check(r.status === 502 && /chat:write/.test(d.error || ""), `a missing scope names the scope: ${r.status} ${d.error}`);
refuse = null;

stop();
console.log(failed ? `${failed} failure(s)` : "ok: the Slack route");
process.exit(failed ? 1 : 0);
