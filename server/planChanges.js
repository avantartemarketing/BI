/* What a reader has done with a suggested action (web/src/modules/PlanChanges.jsx;
 * the card was named Plan changes for its first hours, and the files, the
 * route and the setting keep that name).
 *
 * The build proposes changes to a live launch's comms plan on its page
 * (etl/plan_changes.py, `planChanges` on the snapshot). What a person does
 * with one - mark it complete, snooze it, or delete it - is theirs, not the
 * build's, so it is kept here, by release and by the change's key, and laid
 * over the page's list by the card: a handled change leaves the list until it
 * is undone, and a snoozed one comes back by itself once its day arrives.
 * Nothing is written to the plan in Notion; this is a record.
 *
 * The saved words are older than the card's: "accepted" is the card's Mark
 * as complete and "dismissed" its Delete (the first card said Accept and
 * Dismiss, and the file on the disk keeps those). "snoozed" carries `until`.
 *
 *   GET  /api/releases/:id/plan-changes   -> { visible, states: { key: { state, by, at, until? } } }
 *   POST /api/releases/:id/plan-changes   { key | keys: [..], state: "accepted" | "dismissed" | "snoozed" | null, until? }
 *
 * `keys` handles several rows in one write (the card's tickboxes and its
 * Actions menu). `until` is a time ahead of now and at most SNOOZE_MAX_DAYS
 * off; a snooze past its `until` is left out of what a read returns.
 *
 * Who sees the card is decided here too. PLAN_CHANGES_AUDIENCE is "admins"
 * (the default while the rules are new: the people on the Permissions tab
 * marked admin), "everyone" or "off"; `visible` carries the answer and the
 * card draws nothing without it.
 *
 * The file sits beside the decision log (PLAN_CHANGES_PATH, else the folder
 * DECISIONS_PATH names, else data/), so on the persistent disk it survives a
 * deploy without a variable of its own. `by` is the part of the signed-in
 * address before the @, never the address. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILE = process.env.PLAN_CHANGES_PATH
  || path.join(process.env.DECISIONS_PATH ? path.dirname(process.env.DECISIONS_PATH) : path.join(ROOT, "data"), "plan_changes.json");
const AUDIENCES = new Set(["admins", "everyone", "off"]);
const audience = () => (AUDIENCES.has(process.env.PLAN_CHANGES_AUDIENCE) ? process.env.PLAN_CHANGES_AUDIENCE : "admins");

const ID = /^[a-z0-9_]{1,120}$/;
const KEY = /^[a-z0-9_.]{1,64}$/;
const STATES = new Set(["accepted", "dismissed", "snoozed"]);
const MAX_KEYS = 50;
const SNOOZE_MAX_DAYS = 60;
const DAY_MS = 86400000;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function read() {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

function write(doc) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, FILE);
}

/* a release's states as a read gives them: a snooze whose day has come is no longer one */
const current = (rel, now) => Object.fromEntries(Object.entries(rel || {}).filter(([, v]) => !(v && v.state === "snoozed" && !(Date.parse(v.until) > now.getTime()))));
const statesOf = (id, now = new Date()) => current(read()[id], now);

/* One state for one change or several of one release; null clears it, and
 * "snoozed" needs `until`. All of it is checked before anything is written.
 * Returns the release's states. */
function setState(id, key, state, by, now = new Date(), until = null) {
  const keys = Array.isArray(key) ? key : [key];
  if (!ID.test(String(id || ""))) throw bad("unknown release");
  if (!keys.length || keys.length > MAX_KEYS || !keys.every((k) => typeof k === "string" && KEY.test(k))) throw bad("key is required");
  if (state !== null && !STATES.has(state)) throw bad("state is accepted, dismissed, snoozed or null");
  let till = null;
  if (state === "snoozed") {
    const t = typeof until === "string" ? Date.parse(until) : NaN;
    if (!(t > now.getTime()) || t > now.getTime() + SNOOZE_MAX_DAYS * DAY_MS) throw bad(`until is a time ahead of now, at most ${SNOOZE_MAX_DAYS} days off`);
    till = new Date(t).toISOString();
  }
  const doc = read();
  const rel = current(doc[id], now);   // a snooze that has run out goes from the file with the next write
  const who = String(by || "").split("@")[0].slice(0, 60);
  for (const k of keys) {
    if (state === null) delete rel[k];
    else rel[k] = { state, by: who, at: now.toISOString(), ...(till ? { until: till } : {}) };
  }
  if (Object.keys(rel).length) doc[id] = rel;
  else delete doc[id];
  write(doc);
  return rel;
}

/* whether this person sees the card */
function visibleTo(user) {
  const a = audience();
  return a === "everyone" || (a === "admins" && !!(user && user.admin));
}

function install(app, { sessionFrom, userOf }) {
  const who = (req) => {
    const s = sessionFrom(req);
    return { session: s, user: s ? userOf(s.email) : null };
  };
  app.get("/api/releases/:id/plan-changes", (req, res) => {
    const { user } = who(req);
    const visible = visibleTo(user);
    res.json({ visible, states: visible && ID.test(req.params.id) ? statesOf(req.params.id) : {} });
  });
  app.post("/api/releases/:id/plan-changes", (req, res) => {
    const { session, user } = who(req);
    if (!visibleTo(user)) return res.status(403).json({ error: "The Suggested actions card is not open to this account." });
    const { key, keys, state, until } = req.body || {};
    try {
      res.json({ states: setState(req.params.id, keys === undefined ? key : keys, state === undefined ? null : state, session && session.email, new Date(), until) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : "The change could not be saved." });
    }
  });
}

module.exports = { install, setState, statesOf, visibleTo, FILE };
