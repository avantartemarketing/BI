/* POST /api/releases/:id/slack end to end, against a stand-in Slack.
 *
 * Starts the service with SLACK_API_BASE pointed at a local stand-in, signs
 * in, and presses the button the way the browser does: a PNG body. Checks
 * the two shapes the route has - the first post to a channel is the figures
 * and then the picture, because only a message hands Slack's channel id
 * back; every post after that is one, the picture with the figures as its
 * comment - and that a picture Slack will not take never costs the figures.
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
let refuseUpload = false;
const body = (req) => new Promise((resolve) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => resolve(Buffer.concat(parts)));
});
const slackStub = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const raw = await body(req);
  seen.push({ path: url.pathname, raw });
  const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/api/chat.postMessage") return json({ ok: true, ts: "1.1", channel: "C0SALESUPD1" });
  if (url.pathname === "/api/files.getUploadURLExternal") {
    if (refuseUpload) return json({ ok: false, error: "missing_scope" });
    return json({ ok: true, file_id: "F1", upload_url: `http://127.0.0.1:${slackStub.address().port}/upload` });
  }
  if (url.pathname === "/upload") { res.writeHead(200); return res.end("OK"); }
  if (url.pathname === "/api/files.completeUploadExternal") return json({ ok: true, files: [{ id: "F1" }] });
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
    SLACK_BOT_TOKEN: "xoxb-test", SLACK_API: `${slackBase}/api/chat.postMessage`, SLACK_API_BASE: `${slackBase}/api`,
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

// ---- sign in and set the channel
const login = await fetch(`${base}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tom.lloyd@avantarte.com", password: "test-pass-1234" }),
});
check(login.ok, `signed in (${login.status}${login.ok ? "" : " - " + log.slice(-300)})`);
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const send = (url, opts = {}) => fetch(base + url, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });

const setCh = await send(`/api/releases/${RELEASE}/slack-channel`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "sales-updates" }),
});
check(setCh.ok, `channel set (${setCh.status})`);

// a real PNG, 1x1, so the route sees bytes a browser could have sent
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

// ---- the first post: the figures, then the picture
seen.length = 0;
let r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
let d = await r.json().catch(() => ({}));
check(r.ok, `first post accepted (${r.status} ${JSON.stringify(d).slice(0, 200)})`);
check(!d.warning, `nothing to warn about: ${d.warning || "none"}`);
check(seen.map((s) => s.path).join(" ") ===
  "/api/chat.postMessage /api/files.getUploadURLExternal /upload /api/files.completeUploadExternal",
  `figures then picture: ${seen.map((s) => s.path).join(" ")}`);
const posted = JSON.parse(seen[0].raw.toString());
check(/sales update/.test(posted.text) && posted.channel === "#sales-updates", "the figures went to the channel by name");
check(seen[2].raw.includes(PNG), "the picture's bytes reached the upload url");
check(JSON.parse(seen[3].raw.toString()).channel_id === "C0SALESUPD1", "the picture is attached to the id the message returned");

// ---- the second: one post, the picture with the figures as its comment
seen.length = 0;
r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
d = await r.json().catch(() => ({}));
check(r.ok && !d.warning, `second post accepted (${r.status})`);
check(seen.map((s) => s.path).join(" ") ===
  "/api/files.getUploadURLExternal /upload /api/files.completeUploadExternal",
  `one post, no message: ${seen.map((s) => s.path).join(" ")}`);
check(/sales update/.test(JSON.parse(seen[2].raw.toString()).initial_comment || ""), "the figures are the picture's comment");

// ---- a picture Slack will not take still posts the figures, and says so
seen.length = 0;
refuseUpload = true;
r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
d = await r.json().catch(() => ({}));
check(r.ok, `a refused picture is not a failed post (${r.status})`);
check(/picture did not go up/.test(d.warning || ""), `the card is told why: ${d.warning}`);
check(seen.some((s) => s.path === "/api/chat.postMessage"), "the figures went as text instead");
refuseUpload = false;

// ---- no picture at all: the figures, as before
seen.length = 0;
r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check(r.ok, `figures-only post accepted (${r.status})`);
check(seen.map((s) => s.path).join(" ") === "/api/chat.postMessage", `with no picture it is a message and nothing else: ${seen.map((s) => s.path).join(" ")}`);

// ---- the dry run still answers with the text, unposted
seen.length = 0;
r = await send(`/api/releases/${RELEASE}/slack`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }),
});
d = await r.json().catch(() => ({}));
check(r.ok && /sales update/.test(d.text || "") && seen.length === 0, "a dry run composes and sends nothing");

stop();
console.log(failed ? `${failed} failure(s)` : "ok: the Slack route");
process.exit(failed ? 1 : 0);
