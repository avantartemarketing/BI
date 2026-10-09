/* The Slack channel document: a configured path the service cannot write
 * falls back to the repo copy with a warning, a writable one gives none.
 * node tests/slack_state.mjs */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-state-"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };

// a file where a directory is needed: mkdir on it fails, like an unmounted disk path
fs.writeFileSync(path.join(tmp, "notadir"), "");
process.env.SLACK_STATE_PATH = path.join(tmp, "notadir", "state", "slack.json");
process.env.SLACK_STATE_FALLBACK_PATH = path.join(tmp, "fallback", "slack.json");
const warned = [];
const origWarn = console.warn;
console.warn = (m) => warned.push(String(m));
const slack = require(path.join(here, "..", "server", "slack.js"));
check(slack.stateWarning() === null, "no warning before any save");
const st = slack.setChannel("rel_a", "#launch-updates", "someone");
console.warn = origWarn;
check(st && st.channel === "launch-updates", "the channel is saved");
check(fs.existsSync(process.env.SLACK_STATE_FALLBACK_PATH), "the save landed in the fallback copy");
check(!fs.existsSync(process.env.SLACK_STATE_PATH), "nothing at the unwritable path");
const w = slack.stateWarning();
check(typeof w === "string" && w.includes(process.env.SLACK_STATE_PATH) && /deploy/.test(w), "the warning names the path and the consequence: " + w);
check(warned.length === 1 && /cannot write/.test(warned[0]), "one console warning");
check(slack.stateFor("rel_a") && slack.stateFor("rel_a").channel === "launch-updates", "the fallback copy is read back");
check(slack.recordPost("rel_a", "someone").lastPostAt, "a post is recorded through the fallback too");
check(slack.setChannel("rel_a", "") === null && slack.stateFor("rel_a") === null, "an empty name clears the channel");

// the project manager who confirms the unit economics: saved with the
// channel as typed without its @, changed alone or with the channel, cleared
// alone, and gone with the channel
const withPm = slack.setSlack("rel_b", { channel: "#launch-updates", pm: "@clare" }, "someone");
check(withPm && withPm.channel === "launch-updates" && withPm.pm === "clare", "saved with the channel, without its @: " + JSON.stringify(withPm));
check(slack.setSlack("rel_b", { pm: "U0PMTEST01" }, "someone").pm === "U0PMTEST01" && slack.stateFor("rel_b").channel === "launch-updates", "the project manager changes alone, the channel stays");
check(slack.setSlack("rel_b", { channel: "launch-updates-2" }, "someone").pm === "U0PMTEST01", "the channel changes alone, the project manager stays");
check(slack.recordEconomicsPost("rel_b", "someone").lastEconomicsAt && slack.stateFor("rel_b").lastPostAt === undefined, "an economics post is recorded apart from the sell-through ones");
check(!("pm" in slack.setSlack("rel_b", { pm: "" }, "someone")), "an empty project manager clears it");
let threw = null;
try { slack.setSlack("rel_b", { pm: "two words" }, "someone"); } catch (e) { threw = e.message; }
check(/no spaces/.test(threw || ""), "a project manager with spaces is refused: " + threw);
check(slack.setSlack("rel_b", { channel: "" }, "someone") === null && slack.stateFor("rel_b") === null, "clearing the channel clears the release, project manager and all");
check(slack.pmKind("U05LE1G3AJC") === "id" && slack.pmKind("W012ABCDEFG") === "id" && slack.pmKind("clare@example.com") === "email"
  && slack.pmKind("@clare") === "handle" && slack.pmKind("clare.f") === "handle" && slack.pmKind("") === null, "the kind is read off the shape");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "ok: slack state falls back with a warning");
process.exit(failed ? 1 : 0);
