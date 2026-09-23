/* POST /api/inputs/:id end to end: the save answers at once with a build
 * ticket, the inputs are on disk before the build runs, the build's status
 * is polled from GET /api/inputs/:id/build (here it fails, since the checkout
 * has no funnel export - that is a status, not a lost save), and the
 * cannibalisation input is validated as a fraction.
 *
 *   node tests/save_route.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RELEASE = "julianschnabel_le_26";
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.error("FAIL", msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "save-route-"));
const PORT = 10176;
const app = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT), SHEETS_REFRESH: "off", BIGQUERY: "off", BQ_EVENTS: "off",
    LOGIN_PASSWORD: "test-pass-1234", LOGIN_USERS: "tom.lloyd@avantarte.com",
    SESSION_SECRET: "test-secret", USERS_PATH: path.join(tmp, "users.json"),
    LAYOUT_PATH: path.join(tmp, "layout.json"), SAVED_INPUTS_PATH: path.join(tmp, "inputs.saved.json"),
    TARGETS_LOG: path.join(tmp, "targets.log"), DECISIONS_PATH: path.join(tmp, "decisions.log"),
    SLACK_STATE_PATH: path.join(tmp, "slack.json"),
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
const login = await fetch(`${base}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tom.lloyd@avantarte.com", password: "test-pass-1234" }),
});
check(login.ok, `signed in (${login.status}${login.ok ? "" : " - " + log.slice(-300)})`);
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const get = (p) => fetch(`${base}${p}`, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

// the inputs as they stand, and where saves land
const before = await get(`/api/inputs/${RELEASE}`);
check(before.status === 200 && before.body.inputs, "the release's inputs are served");
check(before.body.storage && before.body.storage.durable === true, `saves are durable when SAVED_INPUTS_PATH is set: ${JSON.stringify(before.body.storage)}`);

// a bad cannibalisation is refused before anything is written
const bad = await post(`/api/inputs/${RELEASE}`, { inputs: { cannibalisation: 1.5 } });
check(bad.status === 400 && /cannibalisation/.test(bad.body.error || ""), `a fraction over 1 is refused: ${bad.status} ${bad.body.error}`);
check(!fs.existsSync(path.join(tmp, "inputs.saved.json")), "nothing saved on a refused body");

// a good save answers at once, with the inputs already on disk
const t0 = Date.now();
const ok = await post(`/api/inputs/${RELEASE}`, { inputs: { cannibalisation: 0.3, cost_per_purchase: 210 } });
const answered = Date.now() - t0;
check(ok.status === 200 && ok.body.queued === true && ok.body.build && ok.body.build.status === "running", `queued at once: ${ok.status} ${JSON.stringify(ok.body).slice(0, 200)}`);
check(answered < 3000, `the answer did not wait for the build (${answered}ms)`);
const saved = JSON.parse(fs.readFileSync(path.join(tmp, "inputs.saved.json"), "utf8"));
check(saved.releases[RELEASE].cannibalisation === 0.3 && saved.releases[RELEASE].cost_per_purchase === 210, `the inputs are on disk before the build: ${JSON.stringify(saved.releases[RELEASE].cannibalisation)}`);
const after = await get(`/api/inputs/${RELEASE}`);
check(after.body.inputs.cannibalisation === 0.3, "and served back straight away");

// the build's status is polled; without a funnel export here it fails, and says so
let st = null;
for (let i = 0; i < 120; i++) {
  st = (await get(`/api/inputs/${RELEASE}/build`)).body;
  if (st.status !== "running") break;
  await sleep(500);
}
check(st && ["done", "failed"].includes(st.status) && typeof st.seconds === "number", `the build reported an outcome: ${JSON.stringify(st).slice(0, 200)}`);
check((await get(`/api/inputs/unknown_release_x/build`)).body.status === "idle", "no build on record reads idle");

// a first save of a launch the funnel has not seen (an upcoming page from
// Airtable): queued the same way, as a one-release build, not the catalogue
const inputsDoc = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "app", "inputs.json"), "utf8"));
const upcomingId = Object.keys(inputsDoc.discovered || {}).find((id) => (inputsDoc.discovered[id].source === "airtable") && ((inputsDoc.sourced || {})[id] || {}).airtable && (inputsDoc.sourced[id].airtable.products || []).some((p) => p.edition && p.unit_price));
if (upcomingId) {
  const first = await post(`/api/inputs/${upcomingId}`, { inputs: { cannibalisation: 0.25 } });
  check(first.status === 200 && first.body.queued === true && first.body.created === true && first.body.build.full === false,
    `a first save is queued as a one-release build: ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
  const savedUp = JSON.parse(fs.readFileSync(path.join(tmp, "inputs.saved.json"), "utf8")).releases[upcomingId];
  check(savedUp && savedUp.cannibalisation === 0.25 && savedUp.release_name, "the new release's inputs are on disk with its name");
  for (let i = 0; i < 120; i++) { const b = (await get(`/api/inputs/${upcomingId}/build`)).body; if (b.status !== "running") break; await sleep(500); }
  console.log(`first save of ${upcomingId}: queued, one-release build`);
} else {
  console.log("no upcoming launch with a priced product in inputs.json - first-save check skipped");
}
console.log(`save answered in ${answered}ms; build ${st && st.status} in ${st && st.seconds}s${st && st.error ? " (" + st.error.slice(0, 80) + ")" : ""}`);

app.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "FAILED" : "ok: the save route", failed || "");
process.exit(failed ? 1 : 0);
