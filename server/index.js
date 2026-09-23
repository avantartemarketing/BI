/* Minimal web service for Render: serves the built SPA + the snapshot data +
 * an append-only paid-spend decision log (see docs/DATA_MODEL.md §9).
 * Note: Render's disk is ephemeral on the free tier - the decision log resets on
 * deploy; point DECISIONS_PATH at a persistent disk when one is attached. */
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data", "app");
const DIST = path.join(ROOT, "web", "dist");
const DECISIONS_PATH = process.env.DECISIONS_PATH || path.join(ROOT, "data", "decisions.log.jsonl");

app.use(express.json());

// password login (avantarte.com only) - installs /login, /auth/* and the gate;
// every route registered after this line requires a signed session cookie.
const auth = require("./auth");
auth.install(app);

// methodology page (markdown-rendered; behind the session gate like the app)
require("./methodology").install(app);

// ---- permissions (the Permissions tab; admin-only user management) ----
const users = require("./users");
function adminSession(req, res) {
  const s = auth.sessionFrom(req);
  const u = s && users.get(s.email);
  if (!u || !u.admin) {
    res.status(403).json({ error: "Admins only." });
    return null;
  }
  return s;
}
app.get("/api/users", (req, res) => {
  const s = adminSession(req, res);
  if (!s) return;
  res.json({ users: users.list().map((u) => ({ ...u, self: u.email === s.email })) });
});
app.post("/api/users", (req, res) => {
  const s = adminSession(req, res);
  if (!s) return;
  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !email.endsWith("@" + auth.DOMAIN)) {
    return res.status(400).json({ error: `Use an @${auth.DOMAIN} email address.` });
  }
  const existing = users.get(email);
  const change = {};
  if (auth.googleConfigured()) {
    // Google is the only way in: accounts are an access list plus a role
    if (body.password !== undefined && body.password !== "") {
      return res.status(400).json({ error: "Passwords are no longer used - people sign in with Google." });
    }
  } else if (body.password !== undefined && body.password !== "") {
    if (typeof body.password !== "string" || body.password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    change.password = body.password;
  } else if (!existing) {
    return res.status(400).json({ error: "A password is required for a new user." });
  }
  if (body.admin !== undefined) {
    // never let the last admin demote themselves - that orphans the tab
    if (existing && existing.admin && !body.admin && users.adminCount() === 1) {
      return res.status(400).json({ error: "Cannot demote the last admin." });
    }
    change.admin = !!body.admin;
  }
  const saved = users.upsert(email, change, s.email);
  res.json({ ok: true, user: { ...saved, self: saved.email === s.email }, created: !existing });
});
app.delete("/api/users/:email", (req, res) => {
  const s = adminSession(req, res);
  if (!s) return;
  const email = String(req.params.email || "").trim().toLowerCase();
  if (email === s.email) return res.status(400).json({ error: "You cannot remove yourself." });
  const target = users.get(email);
  if (!target) return res.status(404).json({ error: "No such user." });
  if (target.admin && users.adminCount() === 1) {
    return res.status(400).json({ error: "Cannot remove the last admin." });
  }
  users.remove(email, s.email);
  res.json({ ok: true });
});

app.get("/api/index", (_req, res) => res.sendFile(path.join(DATA, "index.json")));
app.get("/api/curves", (_req, res) => res.sendFile(path.join(DATA, "curves.json")));
// Targeted releases live in releases/ (committed - the boot-time fallback);
// actuals-only pages for everything else in derived/ (rebuilt every refresh,
// not committed). A release the index lists but neither dir has is one the
// first refresh after a deploy has not built yet - say so, not "unknown".
const slack = require("./slack");
/* The release's snapshot as the ETL wrote it, or null. */
function readSnapshot(id) {
  for (const dir of ["releases", "derived"]) {
    const file = path.join(DATA, dir, `${id}.json`);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
    }
  }
  return null;
}
app.get("/api/releases/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const snap = readSnapshot(id);
  // the Slack channel set for the release rides on the snapshot, so the
  // sell-through card knows whether its button has somewhere to post
  if (snap) return res.json({ ...snap, slack: slack.stateFor(id) });
  let listed = false;
  try {
    listed = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8")).releases.some((r) => r.id === id);
  } catch {}
  if (listed) {
    return res.status(404).json({ error: "This page has not been built yet - the first data refresh after a deploy takes a few minutes.", pending: true });
  }
  res.status(404).json({ error: "unknown release" });
});

// ---- target-setting inputs (docs §3; the Target setting tab) ----
// the benchmark basket behind a release's targets (docs/BENCHMARK_SPEC.md §6);
// every median it serves comes from etl/baskets.py, never from JS
const baskets = require("./baskets");
// inputs.json is the ETL's output (benchmarks, defaults, the discovered
// releases). Saves from the Target setting tab go to their own file, so the
// ETL never reads its own output back as an edit, and so the file can live on
// a persistent disk (SAVED_INPUTS_PATH) and survive a deploy.
const INPUTS_PATH = path.join(DATA, "inputs.json");
const SAVED_INPUTS_PATH = process.env.SAVED_INPUTS_PATH || path.join(ROOT, "data", "inputs.saved.json");
const TARGETS_LOG = process.env.TARGETS_LOG || path.join(ROOT, "data", "targets.log.jsonl");
// the per-product sell-through rule, re-run on a save that changes product
// editions or the entry -> order rate (docs/DATA_MODEL.md §6.3)
// the draws the event feed found per release (etl/aggregate_events.py), so the
// Target setting tab can list them for naming and sizing; counts only
const PRODUCTS_FEED = path.join(DATA, "release_products.json");
let productsFeedCache = { mtime: null, doc: {} };
function productsFeed() {
  try {
    const mtime = fs.statSync(PRODUCTS_FEED).mtimeMs;
    if (productsFeedCache.mtime !== mtime) productsFeedCache = { mtime, doc: JSON.parse(fs.readFileSync(PRODUCTS_FEED, "utf8")) };
  } catch { productsFeedCache = { mtime: null, doc: {} }; }
  return productsFeedCache.doc;
}
function drawsFor(releaseName) {
  const rec = releaseName ? productsFeed()[releaseName] : null;
  if (!rec) return null;
  return { draws: rec.draws || [], entrants: rec.entrants ?? null, eligible: rec.eligible ?? null, allocated: !!rec.allocated };
}

// Express 4 does not catch a rejection from an async handler, and Node exits on
// an unhandled one - which would take the SPA down with it, since the same
// process serves it. Every async route goes through here.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, e);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong saving that - nothing was changed." });
});

// the display groups a release can set aside - "not running paid", "the
// artist has no channels of their own" (BENCHMARK_SPEC 4.3; etl/baskets.py GROUPS)
const CHANNEL_GROUPS = ["aa_email", "aa_social", "referral_artist", "search_direct_other", "paid"];
// how much the artist is expected to post: the cohort the artist-posts
// benchmark pools completed campaigns by (etl/build.py referral_artist_tier)
const POSTING_TIERS = ["Low", "Medium", "High"];
// the inputs of the quartile-lever model, retired 2026-09-23 (docs/DATA_MODEL.md
// §3): a save drops them from a release that still carries them
const RETIRED_INPUTS = ["paid_channel_size", "reference_point", "paid_conv_quality", "cpp_pick",
  "channel_quality_overrides", "paid_share_override", "stretch_mode", "budget_file"];
// the release-level economics a release was set up with before the model went
// per product (docs §1.6): kept under legacy_economics until cleared on the tab
const LEGACY_KEYS = ["edition_size", "edition_total", "unit_price", "artist_profit", "aa_group_profit",
  "artist_profit_share", "framing_available", "frame_conversion", "frame_profit_per_unit", "aa_budget_share"];
// a product's figures as typed over Airtable's: [field, floor, ceiling, integer?]
const PRODUCT_FIELDS = [["edition", 1, null, true], ["target_sellthrough", 0, 1, false], ["unit_price", 0.01, null, false],
  ["artist_profit_per_unit", 0, null, false], ["aa_profit_per_unit", 0, null, false], ["aa_revenue_share", 0, 1, false],
  ["aa_profit_share", 0, 1, false], ["frame_conversion", 0, 1, false], ["frame_profit_per_unit", 0, null, false]];
const CURRENCIES = ["GBP", "EUR", "USD"];
const economicsPromise = import("../shared/economics.mjs");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readSaved() {
  try { return JSON.parse(fs.readFileSync(SAVED_INPUTS_PATH, "utf8")); } catch { return { releases: {} }; }
}
function writeSaved(id, inputs) {
  const saved = readSaved();
  saved.releases = { ...(saved.releases || {}), [id]: inputs };
  fs.mkdirSync(path.dirname(SAVED_INPUTS_PATH), { recursive: true });
  const tmp = SAVED_INPUTS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 1));
  fs.renameSync(tmp, SAVED_INPUTS_PATH);
}
/* The ETL's inputs document with the dashboard's saves laid over it: a saved
 * release wins over the repo default, and a release set up from the dashboard
 * moves from discovered to releases. */
function readInputsDoc() {
  const doc = JSON.parse(fs.readFileSync(INPUTS_PATH, "utf8"));
  const saved = readSaved().releases || {};
  doc.releases = { ...doc.releases, ...saved };
  if (doc.discovered) for (const id of Object.keys(saved)) delete doc.discovered[id];
  return doc;
}

/* A release nobody has set targets for starts from what the ETL could derive
 * (dates from the campaign clock, a campaign code guessed from the email and
 * content feeds) plus the model's usual defaults. Economics have no sensible
 * default and stay null until someone types them. */
function defaultsFor(id, disc) {
  return {
    id, release_name: disc.release_name, campaign_code: disc.campaign_code || "",
    campaign_names: disc.campaign_name ? [disc.campaign_name] : [], marketing_lead: null,
    private_room_open: disc.private_room_open, announce_date: disc.announce_date, launch_end: disc.launch_end,
    products: [], legacy_economics: null,
    preorder_conversion_rate: null,
    prefer_recent: true,
    cost_per_purchase: null, artist_posting_tier: "Medium", channels_off: [],
  };
}

/* What the feeds hold for a release (the ETL's sourced block of inputs.json,
 * docs §1.6): Airtable's products and dates, the Notion dates, the campaigns
 * named for the code. Empty until the build has run once on this checkout. */
function sourcedFor(doc, id) {
  return (doc.sourced && doc.sourced[id]) || { airtable: { match: "none", note: "", products: [] }, notion: {}, clock: {}, campaigns: [] };
}

app.get("/api/inputs/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const doc = readInputsDoc();
  const inputs = doc.releases[id];
  const disc = !inputs && doc.discovered ? doc.discovered[id] : null;
  if (!inputs && !disc) return res.status(404).json({ error: "unknown release" });
  res.json({
    inputs: inputs || null,
    defaults: disc ? defaultsFor(id, disc) : null,
    derived: disc || null,
    sourced: sourcedFor(doc, id),
    benchmarks: doc.benchmarks,
    meta_campaigns: doc.meta_campaigns || [],
    // the draws (one per product) the event feed found for this release
    draws: drawsFor((inputs || disc || {}).release_name),
  });
});

app.post("/api/inputs/:id", route(async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const doc = readInputsDoc();
  let current = doc.releases[id];
  // first save for a release the ETL discovered: create it from the defaults
  const creating = !current;
  if (creating) {
    const disc = doc.discovered ? doc.discovered[id] : null;
    if (!disc) return res.status(404).json({ error: "unknown release" });
    current = defaultsFor(id, disc);
  }
  const body = (req.body && req.body.inputs) || {};

  const next = { ...current };
  const errors = [];
  const sourced = sourcedFor(doc, id);
  const { resolveProducts, releaseEconomics } = await economicsPromise;
  // the release-level figures a release was set up with before the model went
  // per product: inputs saved under the old shape carry them at the top level,
  // and a save moves them under legacy_economics; null clears them, and the
  // products carry the totals from then on
  const topLegacy = {};
  for (const k of LEGACY_KEYS) if (next[k] !== undefined) { if (next[k] !== null) topLegacy[k] = next[k]; delete next[k]; }
  if (next.legacy_economics === undefined && Object.keys(topLegacy).length) next.legacy_economics = topLegacy;
  if (body.legacy_economics !== undefined) {
    if (body.legacy_economics === null) next.legacy_economics = null;
    else errors.push("legacy_economics can only be cleared (null); the figures are per product now");
  }
  const dateOf = (f) => body[f] || current[f] || (sourced.notion || {})[f] || (sourced.clock || {})[f] || (sourced.airtable || {})[f];
  if (creating) {
    for (const f of ["announce_date", "launch_end"]) {
      if (!dateOf(f)) errors.push(`${f} is needed to set targets - none in the Notion log, the funnel's clock or Airtable, so type it`);
    }
  }
  // what a paid unit costs to buy, £: paid units x this is the paid budget.
  // Empty means the panel's median (etl/benchmarks.json cost_per_purchase).
  if (body.cost_per_purchase !== undefined) {
    if (body.cost_per_purchase === null || body.cost_per_purchase === "") next.cost_per_purchase = null;
    else {
      const v = Number(body.cost_per_purchase);
      if (!Number.isFinite(v) || v <= 0) errors.push("cost_per_purchase must be a positive number (£ per paid unit) or empty");
      else next.cost_per_purchase = Math.round(v * 100) / 100;
    }
  }
  // how much the artist will post, the cohort of the artist-posts benchmark
  if (body.artist_posting_tier !== undefined) {
    if (!POSTING_TIERS.includes(body.artist_posting_tier)) errors.push(`artist_posting_tier must be one of ${POSTING_TIERS.join("/")}`);
    else next.artist_posting_tier = body.artist_posting_tier;
  }
  /* The Meta campaigns whose spend is this release's: names as the spend feed
   * spells them, the draw campaign first. campaign_name is kept as the first
   * for readers of the older field. */
  if (body.campaign_names !== undefined || body.campaign_name !== undefined) {
    let raw = body.campaign_names !== undefined ? body.campaign_names : [body.campaign_name];
    if (raw === null) raw = [];
    if (!Array.isArray(raw) || raw.some((n) => n !== null && typeof n !== "string")) errors.push("campaign_names must be a list of campaign names");
    else {
      const names = [...new Set(raw.map((n) => String(n || "").trim().slice(0, 200)).filter(Boolean))];
      if (names.length > 12) errors.push("campaign_names: at most 12 campaigns");
      next.campaign_names = names;
      next.campaign_name = names[0] || null;
    }
  }
  for (const f of ["private_room_open", "announce_date", "launch_end"]) {
    if (body[f] !== undefined) {
      if (!DATE_RE.test(String(body[f]))) errors.push(`${f} must be YYYY-MM-DD`);
      else next[f] = body[f];
    }
  }
  for (const f of ["marketing_lead", "campaign_code"]) {
    if (body[f] !== undefined) next[f] = body[f] === null ? null : String(body[f]).slice(0, 200);
  }
  /* The benchmark basket (BENCHMARK_SPEC §6). An unresolvable basket is
   * reported here and the save is refused: falling back to the suggestion
   * would leave someone looking at a benchmark line they did not choose and
   * cannot tell apart from the one they did. null clears the basket, and the
   * release is benchmarked against the suggested one again. */
  if (body.benchmark_basket !== undefined) {
    const check = await baskets.validateBasketSpec(body.benchmark_basket, id);
    if (!check.ok) errors.push(check.error);
    else next.benchmark_basket = check.normalised;
  }
  if (body.prefer_recent !== undefined) {
    // the basket's recency preference: launches closed in the last 18 months
    // rank first among the comparable ones (etl/baskets.py similar_members)
    if (typeof body.prefer_recent !== "boolean") errors.push("prefer_recent must be true or false");
    else next.prefer_recent = body.prefer_recent;
  }
  /* The channels this release will not run (BENCHMARK_SPEC 4.3): group keys,
   * kept to the known ones and in their fixed order. Every group off would
   * leave nothing to benchmark or target, so that is refused. */
  if (body.channels_off !== undefined) {
    const raw = body.channels_off === null ? [] : body.channels_off;
    if (!Array.isArray(raw) || raw.some((g) => typeof g !== "string")) errors.push("channels_off must be a list of channel groups");
    else {
      const unknown = raw.filter((g) => !CHANNEL_GROUPS.includes(g));
      if (unknown.length) errors.push(`unknown channel group ${unknown.join(", ")}`);
      const off = CHANNEL_GROUPS.filter((g) => raw.includes(g));
      if (off.length === CHANNEL_GROUPS.length) errors.push("every channel is off - at least one has to be in plan");
      next.channels_off = off;
    }
  }
  // the retired inputs leave a release the first time it is saved again; the
  // posting tier they carried has its own field now, so it is carried over
  const legacyTier = ((next.channel_quality_overrides || {})["Referral Artist"]);
  if (next.artist_posting_tier === undefined && POSTING_TIERS.includes(legacyTier)) next.artist_posting_tier = legacyTier;
  for (const f of RETIRED_INPUTS) delete next[f];
  /* The products (docs §1.6, §6.3). Two kinds share the list. An economics
   * product carries airtable_id (Airtable's record for the work) or manual:
   * true (a work Airtable has no record for), and the figures typed over
   * Airtable's: its edition, target sell-through, price and currency, the
   * artist's and Avant Arte's profit per unit, the deal's revenue or profit
   * share, the framing take-up and profit; empty means Airtable's, or the
   * default. A draw entry (key = the draw id) is the sell-through card's: the
   * name typed for the draw, its edition and its pre-order rate. */
  if (body.products !== undefined) {
    if (body.products === null) next.products = null;
    else if (!Array.isArray(body.products) || body.products.length > 60) errors.push("products is a list of up to 60 entries");
    else {
      const list = [];
      for (const p of body.products) {
        if (!p || typeof p !== "object") { errors.push("every product is an object"); break; }
        const key = p.key === undefined || p.key === null || p.key === "" ? null : String(p.key).slice(0, 80);
        const airtableId = p.airtable_id === undefined || p.airtable_id === null || p.airtable_id === "" ? null : String(p.airtable_id).slice(0, 40);
        const manual = !!p.manual && !airtableId;
        const name = p.name === undefined || p.name === null ? "" : String(p.name).slice(0, 160).trim();
        const label = name || airtableId || key || "a product";
        const entry = airtableId ? { airtable_id: airtableId, name } : manual ? { manual: true, name } : { key, name };
        if (manual && !name) errors.push("a product added by hand needs a name");
        const numField = (f, floor, ceil, integer) => {
          if (p[f] === undefined || p[f] === null || p[f] === "") return null;
          const v = Number(p[f]);
          if (!Number.isFinite(v) || (floor !== null && v < floor) || (ceil !== null && v > ceil)) {
            errors.push(`the ${f.replace(/_/g, " ")} of ${label} must be ${ceil !== null ? `a fraction between ${floor} and ${ceil}` : `a number of at least ${floor}`}, or empty`);
            return null;
          }
          return integer ? Math.round(v) : v;
        };
        if (airtableId || manual) {
          for (const [f, floor, ceil, integer] of PRODUCT_FIELDS) entry[f] = numField(f, floor, ceil, integer);
          if (p.currency !== undefined && p.currency !== null && p.currency !== "") {
            const c = String(p.currency).toUpperCase();
            if (!CURRENCIES.includes(c)) errors.push(`the currency of ${label} must be one of ${CURRENCIES.join("/")}`);
            else entry.currency = c;
          }
          if (p.framing_available !== undefined && p.framing_available !== null && p.framing_available !== "") entry.framing_available = !!p.framing_available;
          if (entry.aa_revenue_share !== null && entry.aa_profit_share !== null) errors.push(`${label} cannot carry both a revenue share and a profit share - the deal is one or the other`);
        } else {
          entry.edition = numField("edition", 0, null, true);
        }
        // a product can convert its pre-orders at its own rate, where its
        // draw has already been run; empty means the release's
        entry.preorderRate = numField("preorderRate", 0.000001, 1, false);
        list.push(entry);
      }
      next.products = list;
    }
  }
  // what the targets need: a product with an edition and a price, from
  // Airtable or typed, or the release-level figures it still carries
  if (creating || next.legacy_economics === null) {
    const products = resolveProducts((sourced.airtable || {}).products || [], next.products || [], doc.benchmarks || {});
    const econ = releaseEconomics(products, next.legacy_economics || null, doc.benchmarks || {});
    if (!(econ.edition_size > 0)) errors.push("no product has an edition yet - Airtable holds none for this release, so type one on the products table");
    else if (!(econ.launch_value > 0)) errors.push("no product has a unit price yet - type one on the products table");
  }
  // the entry -> order rate the sell-through prediction converts entries in
  // hand at; empty means the panel's 0.8
  // the rate a pre-order entry converts at; empty means the panel's 0.95
  if (body.preorder_conversion_rate !== undefined) {
    if (body.preorder_conversion_rate === null || body.preorder_conversion_rate === "") next.preorder_conversion_rate = null;
    else {
      const v = Number(body.preorder_conversion_rate);
      if (!Number.isFinite(v) || v <= 0 || v > 1) errors.push("preorder_conversion_rate must be a fraction between 0 and 1, or empty");
      else next.preorder_conversion_rate = v;
    }
  }
  if (body.entry_conversion_rate !== undefined) {
    if (body.entry_conversion_rate === null || body.entry_conversion_rate === "") next.entry_conversion_rate = null;
    else {
      const v = Number(body.entry_conversion_rate);
      if (!Number.isFinite(v) || v <= 0 || v > 1) errors.push("entry_conversion_rate must be a fraction between 0 and 1, or empty");
      else next.entry_conversion_rate = Math.round(v * 1000) / 1000;
    }
  }
  if (new Date(next.launch_end) <= new Date(next.announce_date)) {
    errors.push("launch_end must be after announce_date");
  }
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const snapPath = path.join(DATA, "releases", `${id}.json`);
  // the ETL overlays only stamped entries over the repo defaults - its own
  // output carries no stamp, so a default can still change under it
  next.saved_at = new Date().toISOString();
  if (creating) {
    // Nothing to rebuild in place - the release only has an actuals-only page. Save
    // the inputs and let the full ETL build it (build.py picks the saved
    // inputs up and promotes the release). This one stays on the whole-
    // catalogue build on purpose: promotion moves the release out of the
    // derived set, and only the full build clears the actuals-only page it
    // leaves behind.
    writeSaved(id, next);
    fs.appendFileSync(TARGETS_LOG, JSON.stringify({
      ts: new Date().toISOString(), releaseId: id, inputs: next, actor: "dashboard", created: true,
    }) + "\n");
    try {
      await sheets.runEtl();
    } catch (e) {
      return res.status(502).json({
        error: "Inputs saved, but the rebuild failed (" + String((e && e.message) || e).slice(0, 200) +
          ") - the page will update on the next data refresh.",
      });
    }
    if (!fs.existsSync(snapPath)) return res.status(502).json({ error: "Inputs saved, but the rebuild did not produce the page - check the refresh status." });
    return res.json({ snapshot: JSON.parse(fs.readFileSync(snapPath, "utf8")), created: true });
  }
  if (!fs.existsSync(snapPath)) return res.status(404).json({ error: "no snapshot for release" });

  /* Every save rebuilds the release with the Python ETL: the benchmark is the
   * basket's medians and its pace curves are built from the basket's own
   * members (BENCHMARK_SPEC §4, §4.1), neither of which is in the snapshot,
   * and a changed Meta-campaign match re-attributes the paid spend, which only
   * the build can do. One release, not the catalogue: a save cannot move any
   * other page, and the whole-catalogue build costs about seven times as much
   * (server/sheets.js). On a failed rebuild the inputs still stand and the
   * page catches up on the next data refresh. */
  writeSaved(id, next);
  fs.appendFileSync(TARGETS_LOG, JSON.stringify({
    ts: new Date().toISOString(), releaseId: id, inputs: next, actor: "dashboard",
  }) + "\n");
  try {
    await sheets.runEtl(id);
  } catch (e) {
    return res.status(502).json({
      error: "Inputs saved, but the rebuild failed (" + String((e && e.message) || e).slice(0, 200) +
        ") - the page will update on the next data refresh.",
    });
  }
  baskets.invalidate();   // a full ETL run is the one thing that moves the panel
  if (!fs.existsSync(snapPath)) return res.status(502).json({ error: "Inputs saved, but the rebuild did not produce the page - check the refresh status." });
  res.json({ snapshot: JSON.parse(fs.readFileSync(snapPath, "utf8")) });
}));

/* ---- benchmark baskets (BENCHMARK_SPEC §6; the basket picker) ----
 * Read-only for anyone with a session, like the inputs routes above: the
 * baskets are the panel's own history, and the only write here saves a basket
 * for everyone, which is the same posture as saving a release's targets. */
app.get("/api/baskets", route(async (req, res) => {
  // ?recent=0|1 previews the suggestion with the recency preference off or on;
  // absent, the release's saved prefer_recent (on by default) applies
  const opts = {};
  if (req.query.recent === "0" || req.query.recent === "1") opts.preferRecent = req.query.recent === "1";
  // ?units=&price= preview the basket for a target and price not yet saved
  const units = Number(req.query.units), price = Number(req.query.price);
  if (Number.isFinite(units) && units > 0 && units < 1e7) opts.units = Math.round(units);
  if (Number.isFinite(price) && price > 0 && price < 1e7) opts.price = Math.round(price);
  res.json(await baskets.readyBaskets(req.query.release, opts));
}));

app.get("/api/baskets/candidates", route(async (_req, res) => {
  res.json(await baskets.candidates());
}));

app.post("/api/baskets", route(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  if (!name) return res.status(400).json({ error: "a saved basket needs a name" });
  const check = await baskets.validateBasketSpec({ kind: "bespoke", members: body.members });
  if (!check.ok) return res.status(400).json({ error: check.error });
  res.json(await baskets.saveBasket({ name, members: check.normalised.members }));
}));

// ---- live data refresh (BigQuery / Google Sheet -> sources -> ETL; server/sheets.js) ----
const sheets = require("./sheets");
// What the last refresh did, feed by feed - open in the browser to debug.
// ?run=1 (or POST /api/refresh) STARTS a fresh attempt and returns at once
// with running:true; poll without ?run=1 for the outcome. A full refresh is a
// multi-year BigQuery pull plus the ETL and takes minutes - holding the request
// open for it outran Render's proxy, which reports that as a 502.
// &full=1 (or POST {full:true}) forces a full BigQuery pull instead of the
// incremental one - e.g. after an upstream backfill, or to measure what moved.
function startRefresh(full) {
  sheets.refresh({ full }).catch((e) => console.error("refresh crashed:", e));   // outcome lands in status()
  return { started: true, full: !!full, ...sheets.status() };
}
app.get("/api/refresh/status", (req, res) => {
  if (req.query.run) return res.json(startRefresh(!!req.query.full));
  const st = sheets.status();
  res.json(st.at || st.running ? st : { ...st, note: "no refresh attempted since boot yet" });
});
app.post("/api/refresh", (req, res) => res.json(startRefresh(!!(req.body && req.body.full))));

// What the BigQuery service account can see: every dataset, table and view
// with its column names (never a row), from the metadata endpoints. Cached a
// day in data/app/bigquery_schema.json; ?refresh=1 lists again; ?format=text
// gives the readable form for pasting. The first place to look when the
// account is granted a new table.
const SCHEMA_PATH = path.join(DATA, "bigquery_schema.json");
app.get("/api/bigquery/schema", route(async (req, res) => {
  const bq = require("./bigquery");
  if (!bq.configured()) return res.status(503).json({ error: "BigQuery is not configured on this server (BIGQUERY_SERVICE_ACCOUNT_JSON)." });
  let doc = null;
  const fresh = fs.existsSync(SCHEMA_PATH) && Date.now() - fs.statSync(SCHEMA_PATH).mtimeMs < 24 * 3600 * 1000;
  if (!req.query.refresh && fresh) {
    try { doc = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")); } catch { doc = null; }
  }
  if (!doc) {
    doc = await bq.listSchema();
    fs.writeFileSync(SCHEMA_PATH, JSON.stringify(doc, null, 1));
  }
  if (req.query.format === "text") return res.type("text/plain").send(bq.schemaText(doc));
  res.json(doc);
}));

// HubSpot email text export (server/emailContent.js): ?run=1 starts the job,
// the same URL without it reports progress, and the CSV downloads once done.
const emailContent = require("./emailContent");
app.get("/api/emails/content/status", (req, res) => {
  if (req.query.run) return res.json(emailContent.start({ years: Math.min(Math.max(Number(req.query.years) || 2, 0.1), 10) }));
  res.json(emailContent.status());
});
// Release-level features across the whole funnel history (etl/release_features.py),
// rebuilt on demand when the funnel file is newer than the last build.
const FEATURES = path.join(DATA, "release_features.csv");
let featuresBuild = null;
app.get("/api/funnel/releases.csv", async (_req, res) => {
  const src = path.join(ROOT, "sources", "across_time.csv");
  const stale = !fs.existsSync(FEATURES) || (fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(FEATURES).mtimeMs);
  if (stale) {
    featuresBuild = featuresBuild || new Promise((resolve, reject) => {
      const venvPy = path.join(ROOT, ".venv", "bin", "python3");
      require("child_process").execFile(fs.existsSync(venvPy) ? venvPy : "python3", [path.join(ROOT, "etl", "release_features.py")],
        { cwd: ROOT, timeout: 150 * 1000, maxBuffer: 4 * 1024 * 1024 },
        (err, _stdout, stderr) => (err ? reject(new Error((stderr || err.message).slice(-600))) : resolve()));
    }).finally(() => { featuresBuild = null; });
    try { await featuresBuild; } catch (e) { return res.status(500).json({ error: "release features failed: " + e.message }); }
  }
  res.setHeader("Content-Disposition", 'attachment; filename="release-features.csv"');
  res.type("text/csv").sendFile(FEATURES);
});

app.get("/api/emails/content.csv", (_req, res) => {
  const f = emailContent.file();
  if (!f) return res.status(404).json({ error: "no export yet - open /api/emails/content/status?run=1 first, then poll it without run=1" });
  res.setHeader("Content-Disposition", 'attachment; filename="hubspot-email-content.csv"');
  res.type("text/csv").sendFile(f);
});

app.get("/api/decisions", (_req, res) => {
  if (!fs.existsSync(DECISIONS_PATH)) return res.json([]);
  const rows = fs.readFileSync(DECISIONS_PATH, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  res.json(rows);
});
app.post("/api/decisions", (req, res) => {
  const { releaseId, action, from, to, cap } = req.body || {};
  if (!releaseId || !["implement", "ignore"].includes(action)) {
    return res.status(400).json({ error: "releaseId and action (implement|ignore) required" });
  }
  const entry = { ts: new Date().toISOString(), releaseId, action, from, to, cap, actor: "dashboard" };
  fs.appendFileSync(DECISIONS_PATH, JSON.stringify(entry) + "\n");
  res.json(entry);
});

// ---- the page layout: one arrangement of the release page's cards and section
// headers for everyone (web/src/Layout.jsx; README "Arranging the page"). The
// client owns the list of cards; here the shape is checked and the document
// kept. No document means the default. `removed` names the cards taken off
// the page, so the client can tell them from a card the code gained since the
// save, which still joins everyone's page. ----
const LAYOUT_PATH = process.env.LAYOUT_PATH || path.join(ROOT, "data", "layout.json");
const keysIn = (items) => new Set(items.filter((it) => it.type === "card").map((it) => it.key));
function readLayout() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_PATH, "utf8")); } catch { return { items: null, updatedAt: null, updatedBy: null }; }
}
function layoutProblem(items, removed) {
  if (!Array.isArray(items) || items.length > 60) return "items is a list of at most 60 entries";
  const keys = new Set();
  for (const it of items) {
    if (!it || typeof it !== "object") return "every entry is an object";
    if (it.type === "card") {
      if (typeof it.key !== "string" || !/^[a-z_]{1,32}$/.test(it.key)) return "a card entry names its card";
      if (keys.has(it.key)) return `the card ${it.key} appears twice`;
      keys.add(it.key);
    } else if (it.type === "header") {
      if (typeof it.text !== "string" || it.text.length > 80) return "a header carries up to 80 characters of text";
    } else return "an entry is a card or a header";
  }
  if (removed !== undefined && (!Array.isArray(removed) || removed.length > 60
      || removed.some((k) => typeof k !== "string" || !/^[a-z_]{1,32}$/.test(k)))) return "removed is a list of card names";
  return null;
}
app.get("/api/layout", (_req, res) => res.json(readLayout()));
app.post("/api/layout", route(async (req, res) => {
  const items = req.body ? req.body.items : undefined;
  const removed = req.body ? req.body.removed : undefined;
  if (items === undefined) return res.status(400).json({ error: "items required: a list, or null for the default" });
  if (items === null) {
    fs.rmSync(LAYOUT_PATH, { force: true });
    return res.json({ items: null, updatedAt: null, updatedBy: null });
  }
  const problem = layoutProblem(items, removed);
  if (problem) return res.status(400).json({ error: problem });
  const s = auth.sessionFrom(req);
  const doc = {
    items: items.map((it) => (it.type === "card" ? { type: "card", key: it.key } : { type: "header", text: it.text.trim() })),
    removed: (removed || []).filter((k) => !keysIn(items).has(k)),
    updatedAt: new Date().toISOString(),
    updatedBy: (s && s.email) || null,
  };
  fs.mkdirSync(path.dirname(LAYOUT_PATH), { recursive: true });
  const tmp = LAYOUT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, LAYOUT_PATH);
  res.json(doc);
}));

// ---- sell-through updates to Slack (server/slack.js) ----
app.post("/api/releases/:id/slack-channel", route(async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  if (!req.body || req.body.channel === undefined) return res.status(400).json({ error: "channel required (empty clears it)" });
  const s = auth.sessionFrom(req);
  try {
    const state = slack.setChannel(id, req.body.channel, s && s.email);
    res.json({ slack: state, warning: slack.stateWarning() });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
}));
/* The card to Slack. The body is either nothing (the figures alone) or the
 * card drawn as a PNG by the browser that is showing it - the one place with
 * a canvas and the page's own typeface. Slack can only attach a file to a
 * channel it knows by ID, so the first post to a channel is the figures
 * (which returns the ID, kept for next time) and then the picture, and every
 * post after that is one: the picture with the figures as its comment. A
 * picture that will not upload never costs the figures. */
app.post("/api/releases/:id/slack", express.raw({ type: "image/png", limit: "8mb" }), route(async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const snap = readSnapshot(id);
  if (!snap) return res.status(404).json({ error: "unknown release" });
  const st = slack.stateFor(id);
  if (!st || !st.channel) return res.status(400).json({ error: "Set a Slack channel for this release on the Target setting tab first." });
  // the picture, and nothing else: the browser draws it, so a body that is
  // not a PNG is a browser that could not
  const png = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
  if (!png) return res.status(400).json({ error: "the browser could not draw the card as a picture, so nothing was posted" });
  const title = `${snap.releaseName || id} - sell-through`;
  const filename = `sell-through-${id}-${snap.asOf || new Date().toISOString().slice(0, 10)}.png`;
  try {
    // the channel by id: kept from an earlier post, typed as one, or looked up by name once
    let channelId = slack.channelIdFor(id);
    if (!channelId) {
      channelId = await slack.lookupChannelId(st.channel);
      if (!channelId) return res.status(502).json({ error: `Slack has no channel called #${st.channel} that the app can see - check the name, or type the channel's id instead` });
      slack.rememberChannelId(id, channelId);
    }
    await slack.uploadImage({ channelId, png, filename, title });
    const s = auth.sessionFrom(req);
    res.json({ ok: true, channel: st.channel, slack: slack.recordPost(id, s && s.email) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}));

app.use(express.static(DIST));
app.get(/.*/, (_req, res) => res.sendFile(path.join(DIST, "index.html")));

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`launch-bi listening on :${port}`);
  sheets.startScheduler();
});
