/* POST /api/releases/:id/slack end to end, against a stand-in Slack.
 *
 * Starts the service with SLACK_API_BASE pointed at a local stand-in, signs
 * in, and presses the button the way the browser does: a PNG body. The post
 * is the picture and nothing else. The first post to a channel named on the
 * Target setting tab looks its id up (conversations.list) and keeps it;
 * every post after that is the upload alone. A picture Slack refuses is a
 * failed post, said plainly, with no text sent in its place; a body that is
 * not a picture is refused before Slack is asked anything.
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
  seen.push({ path: url.pathname, raw, query: url.searchParams });
  const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/api/conversations.list") {
    // two pages: the channel is on the second, so the paging is exercised
    if (!url.searchParams.get("cursor")) return json({ ok: true, channels: [{ id: "C0OTHER0001", name: "general" }], response_metadata: { next_cursor: "p2" } });
    return json({ ok: true, channels: [{ id: "C0SALESUPD1", name: "sales-updates" }], response_metadata: { next_cursor: "" } });
  }
  if (url.pathname === "/api/files.getUploadURLExternal") {
    if (refuseUpload) return json({ ok: false, error: "missing_scope" });
    return json({ ok: true, file_id: "F1", upload_url: `http://127.0.0.1:${slackStub.address().port}/upload` });
  }
  if (url.pathname === "/upload") { res.writeHead(200); return res.end("OK"); }
  if (url.pathname === "/api/files.completeUploadExternal") return json({ ok: true, files: [{ id: "F1" }] });
  if (url.pathname === "/api/chat.postMessage") return json({ ok: true, ts: "1.1", channel: "C0SALESUPD1" });
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

// ---- the first post: the channel looked up by name, then the picture, no message
seen.length = 0;
let r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
let d = await r.json().catch(() => ({}));
check(r.ok, `first post accepted (${r.status} ${JSON.stringify(d).slice(0, 200)})`);
check(seen.map((s) => s.path).join(" ") ===
  "/api/conversations.list /api/conversations.list /api/files.getUploadURLExternal /upload /api/files.completeUploadExternal",
  `looked up over two pages, then the picture: ${seen.map((s) => s.path).join(" ")}`);
check(!seen.some((s) => s.path === "/api/chat.postMessage"), "no message goes with the picture");
check(seen[1].query.get("cursor") === "p2", "the second page is asked for by its cursor");
check(seen[3].raw.includes(PNG), "the picture's bytes reached the upload url");
const done = JSON.parse(seen[4].raw.toString());
check(done.channel_id === "C0SALESUPD1", "the picture is attached to the id the lookup found");
check(done.initial_comment === undefined, "and carries no comment");

// ---- the second: the id is kept, so it is the upload alone
seen.length = 0;
r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
d = await r.json().catch(() => ({}));
check(r.ok, `second post accepted (${r.status})`);
check(seen.map((s) => s.path).join(" ") ===
  "/api/files.getUploadURLExternal /upload /api/files.completeUploadExternal",
  `the upload alone: ${seen.map((s) => s.path).join(" ")}`);

// ---- a picture Slack will not take is a failed post, said plainly; nothing else is sent
seen.length = 0;
refuseUpload = true;
r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
d = await r.json().catch(() => ({}));
check(r.status === 502 && /files:write/.test(d.error || ""), `a refused picture fails with the scope named: ${r.status} ${d.error}`);
check(!seen.some((s) => s.path === "/api/chat.postMessage"), "no text is sent in its place");
refuseUpload = false;

// ---- no picture at all is refused before Slack is asked anything
seen.length = 0;
r = await send(`/api/releases/${RELEASE}/slack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
d = await r.json().catch(() => ({}));
check(r.status === 400 && /could not draw/.test(d.error || ""), `a post without a picture is refused: ${r.status} ${d.error}`);
check(seen.length === 0, "and Slack is not called");

stop();
console.log(failed ? `${failed} failure(s)` : "ok: the Slack route");
process.exit(failed ? 1 : 0);
