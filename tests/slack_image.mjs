/* The Slack picture path (server/slack.js), against a stand-in Slack.
 *
 * Starts a local server that answers the three calls the external upload
 * makes plus chat.postMessage, points SLACK_API_BASE at it, and checks what
 * the module sends: the channel id remembered from a message, the upload's
 * three steps in order, the picture's bytes arriving intact inside the
 * multipart body, the figures riding along as the file's comment, and a
 * refusal coming back as the sentence the card shows.
 *
 *   node tests/slack_image.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.error("FAIL", msg); } };

// ---- the stand-in Slack
const seen = [];
let refuse = null;                       // an error code to answer with, once
let outsider = null;                     // "public" | "private": the bot is not in the channel
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const body = (req) => new Promise((resolve) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => resolve(Buffer.concat(parts)));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const raw = await body(req);
  const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  seen.push({ path: url.pathname, auth: req.headers.authorization, type: req.headers["content-type"], raw });
  if (refuse && url.pathname !== "/upload") { const e = refuse; refuse = null; return json({ ok: false, error: e }); }
  switch (url.pathname) {
    case "/api/chat.postMessage": return json({ ok: true, ts: "1700000000.1", channel: "C0SELLTHRU" });
    case "/api/files.getUploadURLExternal":
      return json({ ok: true, file_id: "F123", upload_url: `http://127.0.0.1:${server.address().port}/upload` });
    case "/upload": { res.writeHead(200); return res.end("OK"); }
    case "/api/files.completeUploadExternal":
      // a channel the bot is not in refuses the file until the bot has joined
      if (outsider) return json({ ok: false, error: "not_in_channel" });
      return json({ ok: true, files: [{ id: "F123" }] });
    case "/api/conversations.list": {
      // two pages, the wanted channel on the second
      if (!url.searchParams.get("cursor")) return json({ ok: true, channels: [{ id: "C0GENERAL01", name: "general" }], response_metadata: { next_cursor: "page2" } });
      return json({ ok: true, channels: [{ id: "C0SELLTHRU", name: "sales-updates" }, { id: "C0PRIV0001", name: "sales-private" }], response_metadata: { next_cursor: "" } });
    }
    case "/api/conversations.join": {
      if (outsider === "private") return json({ ok: false, error: "method_not_supported_for_channel_type" });
      outsider = null;   // joined: the next completion goes through
      return json({ ok: true, channel: { id: JSON.parse(raw.toString()).channel } });
    }
    default: { res.writeHead(404); return res.end("no"); }
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- the module, with the environment it reads at load
const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slack-test-")), "slack.json");
process.env.SLACK_STATE_PATH = state;
process.env.SLACK_STATE_FALLBACK_PATH = state;
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_API = `${base}/api/chat.postMessage`;
process.env.SLACK_API_BASE = `${base}/api`;
const slack = require(path.join(ROOT, "server", "slack.js"));

// ---- the picture and the message name the products the same way
const { shortNames } = await import(path.join(ROOT, "web", "src", "modules", "sellThroughImage.mjs"));
const NAMES = [
  ["Don\u2019t Let It Bring You Down, It\u2019s Only Castles Burning (For Neil Young) I",
   "Don\u2019t Let It Bring You Down, It\u2019s Only Castles Burning (For Neil Young) II"],
  ["Brillo Box Collectable (White Portrait)", "Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"],
  ["Etching", "Lithograph"],                       // nothing shared: both left alone
  ["Only one"],
];
for (const set of NAMES) {
  check(JSON.stringify(shortNames(set)) === JSON.stringify(slack.shortNames(set)),
    `the picture and the message shorten alike: ${JSON.stringify(shortNames(set))} vs ${JSON.stringify(slack.shortNames(set))}`);
}
check(shortNames(NAMES[1]).join("|") === "White Portrait|Green Landscape|Lifesize",
  `the shared part goes: ${shortNames(NAMES[1]).join("|")}`);
check(shortNames(NAMES[2]).join("|") === "Etching|Lithograph", "names with nothing in common are left alone");

// ---- a channel named on the tab is looked up by name, over the pages, then kept
slack.setChannel("rel", "sales-updates", "tester");
check(slack.channelIdFor("rel") === null, "no channel id before the lookup");
seen.length = 0;
const found = await slack.lookupChannelId("#Sales-Updates");
check(found === "C0SELLTHRU", `the lookup finds the channel by name, whatever its case or #: ${found}`);
check(seen.length === 2 && seen[1].path === "/api/conversations.list", "it turned the page to find it");
check(await slack.lookupChannelId("nowhere") === null, "a name no channel has is null, not an error");
refuse = "missing_scope";
let caught = null;
try { await slack.lookupChannelId("sales-updates"); } catch (e) { caught = String(e.message); }
check(caught && /channels:read/.test(caught), `a missing scope names channels:read: ${caught}`);
slack.rememberChannelId("rel", found);
check(slack.channelIdFor("rel") === "C0SELLTHRU", "the id is kept for next time");
check(JSON.parse(fs.readFileSync(state, "utf8")).rel.channel === "sales-updates", "the channel name is kept beside it");

// a channel typed as an id is its own, with nothing sent yet
slack.setChannel("rel2", "C0TYPEDIN", "tester");
check(slack.channelIdFor("rel2") === "C0TYPEDIN", "an id typed into the field needs no message first");

// ---- the upload: three steps, the bytes, and the comment
seen.length = 0;
await slack.uploadImage({ channelId: "C0SELLTHRU", png: PNG, filename: "card.png", title: "A release - sell-through", comment: "the figures" });
check(seen.map((s) => s.path).join(" ") ===
  "/api/files.getUploadURLExternal /upload /api/files.completeUploadExternal", `three steps in order: ${seen.map((s) => s.path).join(" ")}`);
check(seen.every((s) => s.path === "/upload" || s.auth === "Bearer xoxb-test"), "every api call carries the bot token");
check(!seen.some((s) => s.path === "/upload" && s.auth), "the upload url is not handed the token");

const ask = new URLSearchParams(seen[0].raw.toString());
check(ask.get("filename") === "card.png" && ask.get("length") === String(PNG.length),
  `the ask names the file and its length: ${ask.get("filename")}, ${ask.get("length")}`);

const put = seen[1];
check(/^multipart\/form-data; boundary=/.test(put.type || ""), `the bytes go as a form: ${put.type}`);
check(put.raw.includes(PNG), "the picture's bytes arrive unchanged");
check(put.raw.toString("latin1").includes('filename="card.png"'), "the part is named after the file");

const done = JSON.parse(seen[2].raw.toString());
check(done.channel_id === "C0SELLTHRU", "the file is attached to the channel by id");
check(done.initial_comment === "the figures", "the figures ride with the picture as its comment");
check(done.files[0].id === "F123" && done.files[0].title === "A release - sell-through", "the file is completed by id, with a title");

// ---- no comment when the figures went first, as its own message
seen.length = 0;
await slack.uploadImage({ channelId: "C0SELLTHRU", png: PNG, filename: "card.png", title: "t" });
check(JSON.parse(seen[2].raw.toString()).initial_comment === undefined, "no comment when the figures were posted already");

// ---- a public channel nobody invited the bot to: it joins, then asks again
seen.length = 0;
outsider = "public";
await slack.uploadImage({ channelId: "C0PUBLIC", png: PNG, filename: "card.png", title: "t", comment: "the figures" });
check(seen.map((s) => s.path).join(" ") ===
  "/api/files.getUploadURLExternal /upload /api/files.completeUploadExternal /api/conversations.join /api/files.completeUploadExternal",
  `refused, joins, asks again: ${seen.map((s) => s.path).join(" ")}`);
check(JSON.parse(seen[3].raw.toString()).channel === "C0PUBLIC", "it joins the channel the file is for");
check(JSON.parse(seen[4].raw.toString()).initial_comment === "the figures", "the second ask still carries the figures");

// ---- a private channel cannot be joined: the refusal says to invite the bot
seen.length = 0;
outsider = "private";
caught = null;
try { await slack.uploadImage({ channelId: "C0PRIVATE", png: PNG }); } catch (e) { caught = String(e.message); }
check(caught && /private channel/.test(caught) && /invite/.test(caught), `a private channel says invite the bot: ${caught}`);
check(seen.filter((s) => s.path === "/api/files.completeUploadExternal").length === 1, "no second ask after a join that failed");
outsider = null;

// ---- a refusal comes back as the sentence the card shows
refuse = "missing_scope";
caught = null;
try { await slack.uploadImage({ channelId: "C0SELLTHRU", png: PNG }); } catch (e) { caught = String(e.message); }
check(caught && /files:write/.test(caught), `a missing scope names the scope: ${caught}`);
caught = null;
try { await slack.uploadImage({ channelId: null, png: PNG }); } catch (e) { caught = String(e.message); }
check(caught && /channel id/.test(caught), `no channel id is refused here, not at Slack: ${caught}`);

server.close();
console.log(failed ? `${failed} failure(s)` : "ok: the Slack picture path");
process.exit(failed ? 1 : 0);
