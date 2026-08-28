/* Per-user login store behind the Permissions tab.
 *
 * data/users.json (relocate via USERS_PATH, e.g. onto a persistent disk):
 *   { "users": { "<email>": { "hash": "...", "admin": true } } }
 * Hash formats: "scrypt:<salt hex>:<hash hex>" (anything set via the tab) and
 * "sha256:<hex>" (legacy seed - the pre-tab shared password).
 *
 * When the file is missing the store seeds itself from LOGIN_USERS /
 * LOGIN_PASSWORD (defaults below; the FIRST listed email becomes the admin),
 * so the dashboard can never lock everyone out. Note Render's free-tier disk
 * is ephemeral: a redeploy resets this file to the seed list - point
 * USERS_PATH at a persistent disk to keep tab-managed users across deploys.
 *
 * Changes are appended to data/users.log.jsonl (who did what, never hashes). */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USERS_PATH = process.env.USERS_PATH || path.resolve(__dirname, "..", "data", "users.json");
const AUDIT_PATH = process.env.USERS_LOG || path.resolve(__dirname, "..", "data", "users.log.jsonl");

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const SEED_HASH = process.env.LOGIN_PASSWORD
  ? "sha256:" + sha(process.env.LOGIN_PASSWORD)
  : "sha256:08f489b7d0593eceaba28695ada6a038e6f35f944bf8f958f4e89fea66387c2c";

let doc = null;

function save() {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(doc, null, 1), { mode: 0o600 });
}

function load() {
  if (doc) return doc;
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
    if (!parsed || typeof parsed.users !== "object") throw new Error("bad shape");
    doc = parsed;
  } catch {
    const emails = (process.env.LOGIN_USERS || "tom.lloyd@avantarte.com,fatima@avantarte.com")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    doc = { users: {} };
    emails.forEach((e, i) => { doc.users[e] = { hash: SEED_HASH, admin: i === 0 }; });
    save();
    console.log(`users: seeded ${emails.length} account(s) into ${USERS_PATH} (admin: ${emails[0]})`);
  }
  return doc;
}

function audit(entry) {
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}

function verifyPassword(user, pw) {
  const [kind, a, b] = String((user && user.hash) || "").split(":");
  if (kind === "scrypt" && a && b) {
    const got = crypto.scryptSync(pw, Buffer.from(a, "hex"), 32);
    const want = Buffer.from(b, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  if (kind === "sha256" && a) {
    const got = Buffer.from(sha(pw));
    const want = Buffer.from(a);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  return false;
}

const get = (email) => load().users[String(email || "").toLowerCase()] || null;
const exists = (email) => !!get(email);
const adminCount = () => Object.values(load().users).filter((u) => u.admin).length;
const list = () => Object.entries(load().users)
  .map(([email, u]) => ({ email, admin: !!u.admin }))
  .sort((x, y) => x.email.localeCompare(y.email));

function upsert(email, { password, admin }, actor) {
  const users = load().users;
  const key = email.toLowerCase();
  const existing = users[key];
  const next = existing ? { ...existing } : { hash: null, admin: false };
  if (password !== undefined) next.hash = hashPassword(password);
  if (admin !== undefined) next.admin = !!admin;
  users[key] = next;
  save();
  audit({ action: existing ? "update" : "add", email: key, admin: next.admin,
          passwordChanged: password !== undefined, actor });
  return { email: key, admin: next.admin };
}

function remove(email, actor) {
  const users = load().users;
  const key = email.toLowerCase();
  if (!users[key]) return false;
  delete users[key];
  save();
  audit({ action: "remove", email: key, actor });
  return true;
}

module.exports = { get, exists, list, upsert, remove, verifyPassword, adminCount };
