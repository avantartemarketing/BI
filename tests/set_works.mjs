/* The connector's one write, end to end (server/index.js setWorksTicked through
 * POST /mcp, tools/call set_works): a work of a limited edition is left out and
 * counted in again as the tick on the Target setting tab does; the save is on
 * disk at once and in the targets log as the connector's; nothing else on the
 * release changes; and a work the release does not have, every work at once, a
 * release with no targets and a call with no token are refused before anything
 * is written.
 *
 *   node tests/set_works.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RELEASE = "dali_le_26";            // three works on file: 2821, 3047, 3046
const TOKEN = "t".repeat(40);
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.error("FAIL", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "set-works-"));
const PORT = 10177;
const app = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT), SHEETS_REFRESH: "off", BIGQUERY: "off", BQ_EVENTS: "off", MCP_TOKEN: TOKEN,
    LOGIN_PASSWORD: "test-pass-1234", LOGIN_USERS: "dev@avantarte.com",
    SESSION_SECRET: "test-secret", USERS_PATH: path.join(tmp, "users.json"),
    LAYOUT_PATH: path.join(tmp, "layout.json"), SAVED_INPUTS_PATH: path.join(tmp, "inputs.saved.json"),
    TARGETS_LOG: path.join(tmp, "targets.log"), DECISIONS_PATH: path.join(tmp, "decisions.log"),
    SLACK_STATE_PATH: path.join(tmp, "slack.json"), APP_DATA_PATH: path.join(tmp, "app"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
app.stdout.on("data", (d) => { log += d; });
app.stderr.on("data", (d) => { log += d; });
process.on("exit", () => app.kill());

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* still starting */ }
  await sleep(250);
}
let n = 0;
const rpc = (method, params, headers = { Authorization: `Bearer ${TOKEN}` }) => fetch(`${base}/mcp`, {
  method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
}).then(async (r) => ({ status: r.status, json: await r.json() }));
const call = async (args) => {
  const r = await rpc("tools/call", { name: "set_works", arguments: args });
  const res = (r.json && r.json.result) || {};
  const text = ((res.content || [])[0] || {}).text || "";
  return { status: r.status, isError: !!res.isError, text, out: res.isError ? null : JSON.parse(text || "null") };
};
const savedFile = path.join(tmp, "inputs.saved.json");
const saved = () => JSON.parse(fs.readFileSync(savedFile, "utf8")).releases[RELEASE];

// listed, and marked as a write so a client asks its user first
const list = (await rpc("tools/list")).json.result.tools;
const tool = list.find((t) => t.name === "set_works");
check(tool && tool.annotations.readOnlyHint === false && tool.annotations.destructiveHint === false, `set_works is listed as a write: ${JSON.stringify(tool && tool.annotations)}`);
check(list.filter((t) => t.annotations.readOnlyHint === false).length === 1, "it is the connector's only write");

// refused before anything is written: no token, an unknown work, every work at once, a release with no targets
check((await rpc("tools/call", { name: "set_works", arguments: { id: RELEASE, works: ["3046"], ticked: false } }, {})).status === 401, "no token, no call");
const unknown = await call({ id: RELEASE, works: ["999999"], ticked: false });
check(unknown.isError && /not works of/.test(unknown.text) && /2821/.test(unknown.text), `a work the release does not have is refused, with its works named: ${unknown.text.slice(0, 160)}`);
const all = await call({ id: RELEASE, works: ["2821", "3047", "3046"], ticked: false });
check(all.isError && /every work unticked/.test(all.text), `every work at once is refused: ${all.text.slice(0, 120)}`);
const none = await call({ id: "no_such_release", works: ["1"], ticked: false });
check(none.isError && /no targets set/.test(none.text), `a release with no targets is refused: ${none.text.slice(0, 120)}`);
check((await call({ id: RELEASE, works: ["3046"] })).isError, "ticked has to be said");
check(!fs.existsSync(savedFile), "nothing saved on a refused call");

// one work left out: on disk at once, in the log as the connector's, the rest of the release as it was
const out = await call({ id: RELEASE, works: ["3046"], ticked: false });
check(!out.isError && out.out.saved === true && out.out.leftOut[0].airtable_id === "3046" && /Spectre/.test(out.out.leftOut[0].name), `left out: ${out.text.slice(0, 200)}`);
check(out.out.editionOfTickedWorks === 800, `the works still ticked add up to 800: ${out.out.editionOfTickedWorks}`);
check(/typed for the release as a whole/.test(out.out.note), "a release on release-level figures is told its target does not follow the tick");
const after = saved();
check(after.products.length === 1 && after.products[0].airtable_id === "3046" && after.products[0].excluded === true, `the tick is saved: ${JSON.stringify(after.products)}`);
check(after.campaign_code === "SalvadorDali_LE_26" && after.announce_date === "2026-08-21", "nothing else on the release changed");
const line = JSON.parse(fs.readFileSync(path.join(tmp, "targets.log"), "utf8").trim().split("\n").pop());
check(line.actor === "connector" && line.releaseId === RELEASE && line.ticked === false && line.works[0] === "3046", `logged as the connector's: ${JSON.stringify({ actor: line.actor, works: line.works })}`);

// counted in again; the same call twice leaves it as it was
const back = await call({ id: RELEASE, works: ["3046"], ticked: true });
check(!back.isError && back.out.ticked[0].airtable_id === "3046" && back.out.editionOfTickedWorks === 1200, `ticked again: ${back.text.slice(0, 160)}`);
check(saved().products[0].excluded === undefined, "the tick is back");
await call({ id: RELEASE, works: ["3046"], ticked: true });
check(saved().products.length === 1 && saved().products[0].excluded === undefined, "asked twice, the same");

app.kill();
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`${failed} check(s) failed`); console.error(log.slice(-600)); process.exit(1); }
console.log("set works: ok");
