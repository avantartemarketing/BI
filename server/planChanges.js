/* The Plan changes card's ticks and dismissals (web/src/modules/PlanChanges.jsx).
 *
 * The build proposes changes to a live launch's comms plan on its page
 * (etl/plan_changes.py, `planChanges` on the snapshot). What a person does
 * with one - accept it, or dismiss it - is theirs, not the build's, so it is
 * kept here, by release and by the change's key, and laid over the page's
 * list by the card: an accepted or dismissed change leaves the list until it
 * is undone. Nothing is written to the plan in Notion; this is a record.
 *
 *   GET  /api/releases/:id/plan-changes   -> { visible, states: { key: { state, by, at } } }
 *   POST /api/releases/:id/plan-changes   { key, state: "accepted" | "dismissed" | null }
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
const STATES = new Set(["accepted", "dismissed"]);

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

const statesOf = (id) => read()[id] || {};

/* One change's state for one release; null clears it. Returns the release's states. */
function setState(id, key, state, by, now = new Date()) {
  if (!ID.test(String(id || ""))) throw Object.assign(new Error("unknown release"), { status: 400 });
  if (!KEY.test(String(key || ""))) throw Object.assign(new Error("key is required"), { status: 400 });
  if (state !== null && !STATES.has(state)) throw Object.assign(new Error("state is accepted, dismissed or null"), { status: 400 });
  const doc = read();
  const rel = { ...(doc[id] || {}) };
  if (state === null) delete rel[key];
  else rel[key] = { state, by: String(by || "").split("@")[0].slice(0, 60), at: now.toISOString() };
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
    if (!visibleTo(user)) return res.status(403).json({ error: "The Plan changes card is not open to this account." });
    const { key, state } = req.body || {};
    try {
      res.json({ states: setState(req.params.id, key, state === undefined ? null : state, session && session.email) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : "The change could not be saved." });
    }
  });
}

module.exports = { install, setState, statesOf, visibleTo, FILE };
