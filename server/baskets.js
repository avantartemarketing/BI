/* The basket picker's API layer (docs/BENCHMARK_SPEC.md §6).
 *
 * The benchmark is the median of a matched basket of past launches (§3), and
 * those medians are computed in exactly one place: etl/baskets.py. This module
 * is a shim in front of it, not a second implementation - a JS re-derivation of
 * the medians would drift from the ETL's the first time either side changed a
 * rounding rule or a renormalisation, and the symptom of that is a benchmark
 * line that moves when nobody touched anything. So the panel, the ready-made
 * baskets, the profiles and the suggestion all come back from Python; this file
 * only decides what to ask, caches the answer and validates what the dashboard
 * sends back.
 *
 * Why a short inline program rather than a CLI in etl/baskets.py: the ETL module
 * stays importable and side-effect free, and the shape of what the API needs can
 * change here without touching the maths. It reads a JSON request off argv and
 * writes a JSON reply to stdout - see PY below.
 *
 * Caching: the panel is rebuilt only by a full ETL run, so a fresh python
 * process per keystroke in the picker would be pure cost. Answers are held for
 * TTL_MS and dropped outright when a basket is saved or an ETL run lands
 * (invalidate()), which is the only other thing that can change them.
 *
 * Validation lives here because §6 is explicit that an invalid basket is a 400
 * and never a silent fallback. resolve_basket() in the ETL does fall back - by
 * then the build must not be stoppable by a rebuilt panel - so the API is the
 * only place a bad basket can be reported to the person who chose it.
 */
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data", "app");
const INPUTS_PATH = path.join(DATA, "inputs.json");
// same file the dashboard's own saves go to (server/index.js), so a release set
// up from the dashboard can be benchmarked before the next ETL run
const SAVED_INPUTS_PATH = process.env.SAVED_INPUTS_PATH || path.join(ROOT, "data", "inputs.saved.json");
// must stay in step with baskets.py SAVED_PATH - both sides read this file
const SAVED_BASKETS_PATH = path.join(DATA, "baskets.json");

const KINDS = ["ready", "bespoke", "saved"];
const MIN_MEMBERS = 3;            // baskets.py MIN_MEMBERS (§3.2)
const TTL_MS = 2 * 60 * 1000;
const PY_TIMEOUT_MS = 60 * 1000;

/* The request/reply contract with the ETL. Three ops, one process each:
 *   {op:"baskets", release}    -> {suggested, baskets, saved}
 *   {op:"candidates"}          -> {rows}          the draw panel, newest first
 *   {op:"profile", members}    -> {profile, unknown}
 * as_of is today because that is what the build uses - all_12m is "the last
 * twelve months" as of the run, and the picker has to show the same basket the
 * ETL would use. allow_nan=False on the way out: a NaN would serialise as
 * invalid JSON and fail in the browser rather than here. */
const PY = `
import json, sys
from datetime import date
from etl import baskets as B

req = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
panel = B.load_panel()
release = req.get("release") or None
own = str((release or {}).get("release_name") or "")
pd = B.pd

def txt(value):
    return "" if pd.isna(value) else str(value)

def day(value):
    return None if pd.isna(value) else str(pd.Timestamp(value).date())

if req.get("op") == "candidates":
    names = B._cluster_names(panel)
    rows = []
    for r in panel.sort_values("window_end", ascending=False, na_position="last").to_dict("records"):
        cid = B._cluster_id(r.get("cluster"))
        rows.append({
            "release_name": txt(r.get("release_name")),
            "artist": txt(r.get("artist")),
            "title": txt(r.get("title")),
            "quarter": txt(r.get("quarter")),
            "window_end": day(r.get("window_end")),
            "campaign_days": B._num(r.get("campaign_days")),
            "units": B._num(r.get("tot_total_product_units")),
            "sessions": B._num(r.get("tot_sessions_total")),
            "paid_share": B._num(r.get("sess_share_paid")),
            "private_room_share": B._num(r.get("private_room_share")),
            "cluster": cid,
            "cluster_name": names.get(cid, "") if cid is not None else "",
        })
    out = {"rows": rows}
elif req.get("op") == "profile":
    members = [str(m) for m in (req.get("members") or [])]
    known = set(panel["release_name"].tolist())
    out = {"profile": B.basket_profile(panel, members),
           "unknown": [m for m in members if m not in known]}
else:
    saved = []
    for b in B.saved_baskets():
        members = [m for m in b["members"] if m != own]
        saved.append(dict(b, members=members, n=len(members),
                          disabled=len(members) < B.MIN_MEMBERS,
                          profile=B.basket_profile(panel, members)))
    out = {"suggested": B.suggest_basket(panel, release or {}),
           "baskets": B.ready_baskets(panel, date.today(), release),
           "saved": saved}

json.dump(out, sys.stdout, allow_nan=False)
`;

/* runPy in server/sheets.js is not exported, so the same venv-then-PATH rule is
 * repeated here rather than reaching into that module for it. */
function runBaskets(payload) {
  const venvPy = path.join(ROOT, ".venv", "bin", "python3");
  const py = fs.existsSync(venvPy) ? venvPy : "python3";
  return new Promise((resolve, reject) => {
    execFile(py, ["-c", PY, JSON.stringify(payload || {})],
      { cwd: ROOT, timeout: PY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error("etl/baskets.py failed: " + String(stderr || err.message).trim().slice(-800)));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("etl/baskets.py returned no JSON: " + String(stdout).trim().slice(0, 200)));
        }
      });
  });
}

// Promises are cached, not values, so two picker requests arriving together
// share one python process instead of racing two.
const cache = new Map();

function cached(key, make) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = make().catch((e) => {
    cache.delete(key);    // a failure must not be served for the rest of the TTL
    throw e;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidate() {
  cache.clear();
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/* The release as the ETL knows it: a dashboard save wins over the ETL's own
 * inputs, and a release nobody has set targets for is still in `discovered`
 * with enough (name, dates, edition size) for the suggestion to work. Python
 * reads release_name, edition_size, paid_channel_size, paid_share_override and
 * the dates off this, and tolerates any of them being absent. */
function releaseFor(releaseId) {
  const id = String(releaseId || "").replace(/[^a-z0-9_]/g, "");
  if (!id) return null;
  const doc = readJson(INPUTS_PATH, {});
  const saved = readJson(SAVED_INPUTS_PATH, {}).releases || {};
  return saved[id] || (doc.releases || {})[id] || (doc.discovered || {})[id] || null;
}

function releaseName(releaseId) {
  const release = releaseFor(releaseId);
  return String((release && release.release_name) || "");
}

/* GET /api/baskets?release=<id>: the six ready-made baskets for this release
 * with their profiles, the saved ones, and which one is suggested (§3.3).
 * A missing or unknown release id is not an error - the picker can be opened
 * without one, and then same_artist is simply empty. */
function readyBaskets(releaseId) {
  const release = releaseFor(releaseId);
  const key = "baskets:" + ((release && release.release_name) || "");
  return cached(key, () => runBaskets({ op: "baskets", release }));
}

// GET /api/baskets/candidates: the whole draw panel for the Bespoke tab.
function candidates() {
  return cached("candidates", () => runBaskets({ op: "candidates" }));
}

function slug(text) {
  return String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueId(base, taken) {
  const seen = new Set(taken);
  if (!seen.has(base)) return base;
  // saving twice under one name keeps both - silently overwriting someone
  // else's basket would change the benchmark of every release using it
  for (let i = 2; ; i++) {
    if (!seen.has(`${base}_${i}`)) return `${base}_${i}`;
  }
}

/* Validate a `benchmark_basket` spec (§6). Returns {ok, error?, normalised?}:
 * `normalised` is what to store on the release - the id for a ready or saved
 * basket, the de-duplicated member list for a bespoke one.
 *
 * `releaseId` is optional and only used for the "not a member of its own
 * benchmark" rule (§3.1); the picker's Save-as-ready-made path has no release.
 * Async because every rule needs the panel, which lives in Python.
 */
async function validateBasketSpec(spec, releaseId) {
  if (spec === null || spec === undefined) return { ok: true, normalised: null };
  if (typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "benchmark_basket must be an object like {kind, id} or {kind:\"bespoke\", members}" };
  }
  const kind = String(spec.kind || "").trim();
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `benchmark_basket.kind must be one of ${KINDS.join("/")}` };
  }

  if (kind === "bespoke") {
    if (!Array.isArray(spec.members)) {
      return { ok: false, error: "a bespoke benchmark_basket needs a members list" };
    }
    const members = spec.members.map((m) => String(m).trim()).filter(Boolean);
    const { rows } = await candidates();
    const known = new Set(rows.map((r) => r.release_name));
    const unknown = members.filter((m) => !known.has(m));
    if (unknown.length) {
      return { ok: false, error: `not launches in the draw panel: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""}` };
    }
    const own = releaseName(releaseId);
    if (own && members.includes(own)) {
      return { ok: false, error: `a release is never a member of its own benchmark - remove ${own}` };
    }
    const unique = [...new Set(members)];
    if (unique.length < MIN_MEMBERS) {
      return { ok: false, error: `a basket needs at least ${MIN_MEMBERS} comparable launches - this one has ${unique.length}` };
    }
    const normalised = { kind: "bespoke", members: unique };
    if (spec.name) normalised.name = String(spec.name).slice(0, 200);
    return { ok: true, normalised };
  }

  const id = spec.id === null || spec.id === undefined ? "" : String(spec.id).trim();
  if (!id) return { ok: false, error: `a ${kind} benchmark_basket needs an id` };
  const listed = await readyBaskets(releaseId);
  const pool = (kind === "saved" ? listed.saved : listed.baskets) || [];
  const hit = pool.find((b) => b.id === id);
  if (!hit) return { ok: false, error: `no ${kind} basket with id "${id}"` };
  // a basket under three members cannot be used at all (§3.2) - same_artist is
  // routinely that thin, so this is a real answer to give the picker, not an edge case
  if (hit.n < MIN_MEMBERS) {
    return { ok: false, error: `"${hit.name}" has only ${hit.n} comparable launches - a basket needs at least ${MIN_MEMBERS}` };
  }
  return { ok: true, normalised: { kind, id } };
}

/* POST /api/baskets: save a bespoke basket as a ready-made one (§6, §8). The
 * file is the one etl/baskets.py reads, so a saved basket is usable by the
 * build the moment it is written. */
async function saveBasket({ name, members } = {}) {
  const clean = String(name || "").trim().slice(0, 120);
  const check = await validateBasketSpec({ kind: "bespoke", members });
  if (!clean || !check.ok) {
    const err = new Error(check.ok ? "a saved basket needs a name" : check.error);
    err.status = 400;
    throw err;
  }
  const doc = readJson(SAVED_BASKETS_PATH, {});
  const rows = Array.isArray(doc.baskets) ? doc.baskets.filter((r) => r && typeof r === "object") : [];
  const row = {
    id: uniqueId(slug(clean) || "saved", rows.map((r) => String(r.id || ""))),
    name: clean,
    desc: `${check.normalised.members.length} launches, saved from the picker.`,
    members: check.normalised.members,
    created: new Date().toISOString(),
  };
  writeAtomic(SAVED_BASKETS_PATH, JSON.stringify({ ...doc, baskets: [...rows, row] }, null, 1));
  invalidate();
  const { profile } = await runBaskets({ op: "profile", members: row.members });
  return { ...row, kind: "saved", n: row.members.length, disabled: false, profile };
}

module.exports = { readyBaskets, candidates, saveBasket, validateBasketSpec, invalidate, MIN_MEMBERS, KINDS };
