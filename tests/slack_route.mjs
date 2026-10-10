/* POST /api/releases/:id/slack end to end, against a stand-in Slack.
 *
 * Starts the service with SLACK_API pointed at a local stand-in, signs in,
 * and presses the button the way the browser does: a JSON body naming the
 * horizon. One chat.postMessage call carries the message, blocks and all,
 * to the channel by name; a dry run returns the message and calls nothing;
 * a refusal from Slack is a failed post said in words; a release without a
 * channel is refused before Slack is asked anything.
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
    if (refuse) return answer({ ok: false, error: refuse });
    return answer({ ok: true, ts: "1.1", channel: "C0SALESUPD1" });
  }
  // the project manager looked up for the economics message: one email is
  // known, and this app has not been granted users:read for handles
  if (url.pathname === "/api/users.lookupByEmail") {
    return answer(url.searchParams.get("email") === "clare@example.com"
      ? { ok: true, user: { id: "U0EMAIL001", name: "clare", real_name: "Clare Ferris" } }
      : { ok: false, error: "users_not_found" });
  }
  if (url.pathname === "/api/users.list") return answer({ ok: false, error: "missing_scope" });
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
    // the build a boot or a save runs writes its pages here, not into the checkout
    APP_DATA_PATH: path.join(tmp, "app"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
app.stdout.on("data", (d) => { log += d; });
app.stderr.on("data", (d) => { log += d; });
const stop = () => { app.kill(); slackStub.close(); };
process.on("exit", stop);

const base = `http://127.0.0.1:${PORT}`;
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
check(types.join(" ") === "header section section table section context context", `the blocks: ${types.join(" ")}`);
// the beta close forecast under the table on a Today update (5 October 2026), the notification text still today's
const beta = (msg.blocks || []).filter((b) => b.type === "section").map((b) => b.text.text).find((t) => /BETA/.test(t)) || "";
check(/^Projected sell-through at close: \*\d+%\*, [\d,]+ of [\d,]+ units on current results `BETA`$/.test(beta), `the beta close line: ${beta}`);
const table = (msg.blocks || []).find((b) => b.type === "table");
check(table && table.rows.length === 5 && table.rows.every((r) => r.length === 6), "three works and a Total row, six cells each");
check(msg.unfurl_links === false && msg.unfurl_media === false, "no unfurling");
check(!/at close/.test(msg.text), "today's horizon says nothing about close");

// ---- at close, as a dry run: the message comes back, Slack is not called
seen.length = 0;
r = await post(RELEASE, { horizon: "close", dryRun: true });
d = await r.json().catch(() => ({}));
check(r.ok && Array.isArray(d.blocks) && d.channel === "sales-updates", `dry run returns the message (${r.status})`);
check(/: \d+% projected at close, /.test(d.text || "") && d.blocks.find((b) => b.type === "table").rows[0][1].text === "Units at close *", `at close: ${d.text}`);
check(seen.length === 0, "a dry run calls nothing");

// ---- the page's Direct switch: on Spread the message is the snapshot with its
// variants.direct_spread laid over it, as the cards read it, and says so; on
// Channel (or with nothing sent) it is the snapshot as built
const SPREAD = "warhol_le_26";
const spreadSnap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "releases", `${SPREAD}.json`), "utf8"));
const variant = spreadSnap.variants && spreadSnap.variants.direct_spread;
if (variant && variant.sellthrough) {
  await send(`/api/releases/${SPREAD}/slack-channel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "sales-updates" }),
  });
  const closeUnits = (st) => Math.round(st.sold + (st.drafts || 0) + st.soldPredicted + st.futureEntriesPredicted).toLocaleString("en-GB");
  const asBuilt = closeUnits(spreadSnap.sellthrough), spread = closeUnits({ ...spreadSnap.sellthrough, ...variant.sellthrough });
  seen.length = 0;
  const on = await (await post(SPREAD, { horizon: "close", dryRun: true, directSpread: true })).json();
  const off = await (await post(SPREAD, { horizon: "close", dryRun: true, directSpread: false })).json();
  const none = await (await post(SPREAD, { horizon: "close", dryRun: true })).json();
  const said = (m) => JSON.stringify(m.blocks || []).includes("Attribution: Direct spread over the other channels.");
  check(new RegExp(`, ${spread} of [\\d,]+ units$`).test(on.text || "") && said(on), `Spread posts the Spread reading and says so: ${on.text} (want ${spread})`);
  check(new RegExp(`, ${asBuilt} of [\\d,]+ units$`).test(off.text || "") && !said(off), `Channel posts the snapshot as built: ${off.text} (want ${asBuilt})`);
  check(none.text === off.text && !said(none), "nothing sent reads as Channel");
  check(asBuilt !== spread, `the fixture tells the two apart (${asBuilt} vs ${spread})`);
  check(seen.length === 0, "dry runs call nothing");
}

// ---- the unit economics for confirmation: posted to the channel with the
// project manager mentioned, who is set beside the channel
const jsonPost = (url, payload) => send(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
const econ = (payload = {}) => jsonPost(`/api/releases/${RELEASE}/slack-economics`, payload);
const setPm = (pm) => jsonPost(`/api/releases/${RELEASE}/slack-channel`, { channel: "sales-updates", pm });
seen.length = 0;
r = await econ();
d = await r.json().catch(() => ({}));
check(r.status === 400 && /project manager/.test(d.error || "") && /Target setting/.test(d.error || ""), `no project manager, no post: ${r.status} ${d.error}`);
check(seen.length === 0, "and Slack is not called");
r = await setPm("@U0PMTEST01");
d = await r.json().catch(() => ({}));
check(r.ok && d.slack && d.slack.pm === "U0PMTEST01" && d.slack.channel === "sales-updates", `the project manager is saved with the channel, without its @: ${JSON.stringify(d.slack)}`);
seen.length = 0;
r = await econ();
d = await r.json().catch(() => ({}));
check(r.ok && d.ok === true && d.to === "U0PMTEST01" && d.channel === "sales-updates", `posted (${r.status} ${JSON.stringify(d).slice(0, 200)})`);
check(d.slack && d.slack.lastEconomicsAt && d.slack.lastEconomicsBy === "tom.lloyd@avantarte.com", "recorded as an economics post");
check(seen.length === 1 && seen[0].path === "/api/chat.postMessage", `a member ID costs no lookup: ${seen.map((s) => s.path).join(" ")}`);
const em = seen[0].json || {};
check(em.channel === "#sales-updates" && /^Julian Schnabel: unit economics to confirm, U0PMTEST01 please$/.test(em.text || ""), `to the channel, named for what it is: ${em.text}`);
const etypes = (em.blocks || []).map((b) => b.type).join(" ");
check(etypes === "header section table section section section context", `the blocks: ${etypes}`);
const sections = (em.blocks || []).filter((b) => b.type === "section").map((b) => b.text.text);
check(sections.some((t) => /^<@U0PMTEST01> Please confirm these figures are right/.test(t) && /Paid ROI/.test(t)), `the ask mentions the project manager and says what the figures set: ${sections.at(-1)}`);
check(sections.some((t) => /^Paid spend: Avant Arte carries \d+%/.test(t) && /Cannibalisation \d+%/.test(t) && /Entry → order rate \d+%/.test(t)), "the terms the Paid ROI reads are under the table");
const etable = (em.blocks || []).find((b) => b.type === "table");
check(etable && etable.rows[0].length === 7 && etable.rows.length >= 3 && etable.rows[0][0].text === "Work" && etable.rows[0][6].text === "Deal",
  `the table: ${etable && etable.rows.length} rows of ${etable && etable.rows[0].length}`);
const ctx = (em.blocks || []).filter((b) => b.type === "context").map((b) => b.elements[0].text).join(" ");
check(/Sent by tom\.lloyd@avantarte\.com/.test(ctx) && /release=julianschnabel_le_26\|Target setting>/.test(ctx), `the context says who sent it and links the tab: ${ctx}`);
// an email is looked up, and the name comes back
await setPm("clare@example.com");
seen.length = 0;
r = await econ();
d = await r.json().catch(() => ({}));
check(r.ok && d.to === "Clare Ferris", `an email is looked up: ${r.status} ${d.to || d.error}`);
check(seen.length === 2 && seen[0].path === "/api/users.lookupByEmail" && seen[0].authorized && seen[1].path === "/api/chat.postMessage",
  `one lookup with the token, then one post: ${seen.map((s) => s.path).join(" ")}`);
check(JSON.stringify((seen[1].json || {}).blocks || []).includes("<@U0EMAIL001>") && /Clare Ferris please$/.test((seen[1].json || {}).text || ""), "the mention is the member found, the text their name");
// an email nobody has, and a handle the app has no scope to look up: refused in words, nothing posted
await setPm("nobody@example.com");
seen.length = 0;
r = await econ();
d = await r.json().catch(() => ({}));
check(r.status === 400 && /no Slack member has the email nobody@example\.com/.test(d.error || "") && /Copy member ID/.test(d.error || ""), `an unknown email: ${r.status} ${d.error}`);
check(!seen.some((s) => s.path === "/api/chat.postMessage"), "nothing posted");
await setPm("@clare");
seen.length = 0;
r = await econ();
d = await r.json().catch(() => ({}));
check(r.status === 400 && /users:read scope/.test(d.error || "") && /reinstall/.test(d.error || ""), `a handle without the scope names the scope: ${r.status} ${d.error}`);
check(!seen.some((s) => s.path === "/api/chat.postMessage"), "nothing posted either");
// a dry run composes the message and looks nobody up
seen.length = 0;
r = await econ({ dryRun: true });
d = await r.json().catch(() => ({}));
check(r.ok && Array.isArray(d.blocks) && d.to === "clare" && d.channel === "sales-updates" && seen.length === 0, `a dry run returns the message and calls nothing (${r.status})`);
await setPm("U0PMTEST01");

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
