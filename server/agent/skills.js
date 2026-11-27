/* The Agent's skills: a written method for one kind of question, kept as a
 * Markdown file under server/agent/skills/ so the method can be read and
 * changed without touching the code. The file opens with a small header
 * between two lines of --- (name, title, when), then the method.
 *
 * A skill is switched on two ways. The chat's press sends its name with the
 * question (the Diagnose press sends skill "diagnose"; server/agent/index.js
 * puts the method, and the evidence it works from, in front of the model).
 * Or the model picks it up itself when a typed question calls for it: the
 * tool that gathers the skill's evidence hands the method back with it
 * (diagnose_release). The prompt lists each skill's name and when it applies.
 *
 * Read from disk, re-read when the file changes. Nothing here writes. */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "skills");
const cache = new Map();   // name -> { mtime, skill }

/* "key: value" lines between the opening --- pair, then the body */
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const head = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return { ...head, body: (m ? text.slice(m[0].length) : text).trim() };
}

/* a skill by name: { name, title, when, body }, or null when there is none */
function loadSkill(name) {
  const clean = String(name || "").replace(/[^a-z0-9_-]/g, "");
  if (!clean) return null;
  const file = path.join(DIR, `${clean}.md`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(clean);
  if (hit && hit.mtime === st.mtimeMs) return hit.skill;
  const skill = { name: clean, ...parse(fs.readFileSync(file, "utf8")) };
  skill.name = clean;
  cache.set(clean, { mtime: st.mtimeMs, skill });
  return skill;
}

/* every skill on file, by name */
function listSkills() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort(); } catch { /* none */ }
  return names.map(loadSkill).filter(Boolean);
}

/* what makes the prompt stale: the skills' files and when each last changed */
function skillsStamp() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort().map((f) => `${f}:${fs.statSync(path.join(DIR, f)).mtimeMs}`).join(","); } catch { return ""; }
}

module.exports = { loadSkill, listSkills, skillsStamp, parse };
