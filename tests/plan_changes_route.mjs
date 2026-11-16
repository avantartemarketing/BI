/* The Suggested actions card's server side end to end (server/planChanges.js): an
 * admin sees the card and a change they complete ("accepted"), delete
 * ("dismissed"), snooze or undo is kept by release and key with who and when
 * (the name before the @, never the address), one row or several in a write,
 * a snooze until its day and no longer; a body that is not a change is
 * refused; and while the audience is
 * admins another account is told the card is not theirs and can save nothing.
 *
 *   node tests/plan_changes_route.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-changes-"));
const FILE = path.join(tmp, "plan_changes.json");

async function serve(port, extra) {
  const app = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), SHEETS_REFRESH: "off", BIGQUERY: "off", BQ_EVENTS: "off",
      LOGIN_PASSWORD: "test-pass-1234", LOGIN_USERS: "tom.lloyd@avantarte.com,lead@avantarte.com",
      SESSION_SECRET: "test-secret", USERS_PATH: path.join(tmp, "users.json"),
      LAYOUT_PATH: path.join(tmp, "layout.json"), SAVED_INPUTS_PATH: path.join(tmp, "inputs.saved.json"),
      TARGETS_LOG: path.join(tmp, "targets.log"), DECISIONS_PATH: path.join(tmp, "decisions.log"),
      SLACK_STATE_PATH: path.join(tmp, "slack.json"), APP_DATA_PATH: path.join(tmp, "app"),
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  app.stdout.on("data", (d) => { log += d; });
  app.stderr.on("data", (d) => { log += d; });
  process.on("exit", () => app.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* still starting */ }
    await sleep(250);
  }
  const as = async (email) => {
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "test-pass-1234" }) });
    check(login.ok, `${email} signed in (${login.status}${login.ok ? "" : " - " + log.slice(-300)})`);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    return {
      get: (p) => fetch(`${base}${p}`, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() })),
      post: (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json() })),
    };
  };
  return { app, as };
}

const url = `/api/releases/${RELEASE}/plan-changes`;

// the default audience: admins. The first listed account is the admin.
let srv = await serve(10177, {});
const admin = await srv.as("tom.lloyd@avantarte.com");
const lead = await srv.as("lead@avantarte.com");

let r = await admin.get(url);
check(r.status === 200 && r.body.visible === true && Object.keys(r.body.states).length === 0, `an admin sees the card, nothing saved yet: ${JSON.stringify(r.body)}`);
check(!fs.existsSync(FILE), "nothing is written by a read");

r = await admin.post(url, { key: "email.last_chance.widen", state: "accepted" });
const st = r.body.states && r.body.states["email.last_chance.widen"];
check(r.status === 200 && st && st.state === "accepted" && st.by === "tom.lloyd" && !Number.isNaN(Date.parse(st.at)), `accepted, by name and when: ${JSON.stringify(r.body)}`);
check(fs.existsSync(FILE), "the file sits beside the decision log when no path of its own is set");
check(!fs.readFileSync(FILE, "utf8").includes("@"), "no address in the file");

r = await admin.post(url, { key: "artist.post.unseen", state: "dismissed" });
check(r.status === 200 && Object.keys(r.body.states).length === 2 && r.body.states["artist.post.unseen"].state === "dismissed", `a second change beside the first: ${JSON.stringify(r.body)}`);
r = await admin.get(url);
check(Object.keys(r.body.states).length === 2, "a read returns what was saved");
r = await admin.get("/api/releases/warhol_le_26/plan-changes");
check(Object.keys(r.body.states).length === 0, "another release has its own");

// undo
r = await admin.post(url, { key: "email.last_chance.widen", state: null });
check(r.status === 200 && !r.body.states["email.last_chance.widen"] && r.body.states["artist.post.unseen"], `undone: ${JSON.stringify(r.body)}`);

// several rows in one write, and a snooze: kept with its day, gone from a read once the day has come
const soon = new Date(Date.now() + 3 * 86400000).toISOString();
r = await admin.post(url, { keys: ["email.mid.add", "paid.lower"], state: "snoozed", until: soon });
check(r.status === 200 && ["email.mid.add", "paid.lower"].every((k) => r.body.states[k] && r.body.states[k].state === "snoozed" && r.body.states[k].until === soon) && r.body.states["artist.post.unseen"],
  `two snoozed in one write, the rest as it was: ${JSON.stringify(r.body)}`);
r = await admin.post(url, { keys: ["email.mid.add", "paid.lower"], state: null });
check(r.status === 200 && Object.keys(r.body.states).join() === "artist.post.unseen", `and both undone in one: ${JSON.stringify(r.body)}`);
const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
doc[RELEASE]["email.mid.add"] = { state: "snoozed", by: "tom.lloyd", at: "2026-01-01T09:00:00.000Z", until: "2026-01-02T00:00:00.000Z" };
fs.writeFileSync(FILE, JSON.stringify(doc));
r = await admin.get(url);
check(!r.body.states["email.mid.add"] && r.body.states["artist.post.unseen"], `a snooze whose day has come is back in the list: ${JSON.stringify(r.body)}`);
r = await admin.post(url, { key: "artist.post.unseen", state: "dismissed" });
check(!JSON.parse(fs.readFileSync(FILE, "utf8"))[RELEASE]["email.mid.add"], "and leaves the file with the next write");

// refused bodies write nothing
const before = fs.readFileSync(FILE, "utf8");
const far = new Date(Date.now() + 90 * 86400000).toISOString();
for (const body of [{ key: "email.last_chance.widen", state: "done" }, { state: "accepted" }, { key: "../etc", state: "accepted" }, { key: "x".repeat(80), state: "accepted" },
  { keys: [], state: "accepted" }, { keys: ["a.b", "../etc"], state: "accepted" }, { keys: Array.from({ length: 51 }, (_, i) => `k.${i}`), state: "accepted" },
  { key: "a.b", state: "snoozed" }, { key: "a.b", state: "snoozed", until: "2026-01-02T00:00:00.000Z" }, { key: "a.b", state: "snoozed", until: far }, { key: "a.b", state: "snoozed", until: "soon" }]) {
  r = await admin.post(url, body);
  check(r.status === 400, `refused: ${JSON.stringify(body)} -> ${r.status}`);
}
r = await admin.post("/api/releases/Not%20An%20Id/plan-changes", { key: "a.b", state: "accepted" });
check(r.status === 400, `a release id that is not one is refused: ${r.status}`);
check(fs.readFileSync(FILE, "utf8") === before, "nothing saved on a refused body");

// another account while the audience is admins
r = await lead.get(url);
check(r.status === 200 && r.body.visible === false && Object.keys(r.body.states).length === 0, `not theirs yet, and nothing of it shown: ${JSON.stringify(r.body)}`);
r = await lead.post(url, { key: "email.mid.add", state: "accepted" });
check(r.status === 403, `and nothing saved by them: ${r.status}`);
check(fs.readFileSync(FILE, "utf8") === before, "the file is as it was");
srv.app.kill();

// opened to everyone
srv = await serve(10178, { PLAN_CHANGES_AUDIENCE: "everyone" });
const lead2 = await srv.as("lead@avantarte.com");
r = await lead2.get(url);
check(r.body.visible === true && r.body.states["artist.post.unseen"], `everyone sees it, with what was saved: ${JSON.stringify(r.body)}`);
r = await lead2.post(url, { key: "email.mid.add", state: "accepted" });
check(r.status === 200 && r.body.states["email.mid.add"].by === "lead", `and can save: ${JSON.stringify(r.body)}`);
srv.app.kill();

// switched off
srv = await serve(10179, { PLAN_CHANGES_AUDIENCE: "off" });
const admin3 = await srv.as("tom.lloyd@avantarte.com");
r = await admin3.get(url);
check(r.body.visible === false, "off hides it from admins too");
srv.app.kill();

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`plan changes route: ${failed} failed`); process.exit(1); }
console.log("plan changes route: ok (complete, delete, snooze, several at once, undo, refusals, admins only by default, everyone, off)");
process.exit(0);
