/* Minimal web service for Render: serves the built SPA + the snapshot data +
 * an append-only paid-spend decision log (see docs/DATA_MODEL.md §9).
 * Note: Render's disk is ephemeral on the free tier — the decision log resets on
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

// magic-link login (avantarte.com only) — installs /login, /auth/* and the gate;
// every route registered after this line requires a signed session cookie.
require("./auth").install(app);

// methodology page (markdown-rendered; behind the session gate like the app)
require("./methodology").install(app);

app.get("/api/index", (_req, res) => res.sendFile(path.join(DATA, "index.json")));
app.get("/api/curves", (_req, res) => res.sendFile(path.join(DATA, "curves.json")));
app.get("/api/releases/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const file = path.join(DATA, "releases", `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "unknown release" });
  res.sendFile(file);
});

// ---- target-setting inputs (docs §3; the Target setting tab) ----
const { retargetSnapshot } = require("./retarget");
const INPUTS_PATH = path.join(DATA, "inputs.json");
const TARGETS_LOG = process.env.TARGETS_LOG || path.join(ROOT, "data", "targets.log.jsonl");
const modelPromise = import("../shared/targetModel.mjs");

const PICKS = {
  paid_channel_size: ["Small", "Medium", "Large", "Low", "High"],
  reference_point: ["Low", "Medium", "High"],
  paid_conv_quality: ["Low", "Medium", "High"],
  cpp_pick: ["Low", "Median", "High"],
};
const QUALITIES = ["High", "Medium", "Low", "N/A"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readInputsDoc() {
  return JSON.parse(fs.readFileSync(INPUTS_PATH, "utf8"));
}

app.get("/api/inputs/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const doc = readInputsDoc();
  const inputs = doc.releases[id];
  if (!inputs) return res.status(404).json({ error: "unknown release" });
  res.json({
    inputs,
    channel_quality_default: doc.channel_quality_default,
    benchmarks: doc.benchmarks,
    meta_campaigns: doc.meta_campaigns || [],
  });
});

app.post("/api/inputs/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const doc = readInputsDoc();
  const current = doc.releases[id];
  if (!current) return res.status(404).json({ error: "unknown release" });
  const body = (req.body && req.body.inputs) || {};

  const next = { ...current };
  const errors = [];
  for (const f of ["edition_size", "unit_price", "artist_profit", "aa_group_profit"]) {
    if (body[f] !== undefined) {
      const v = Number(body[f]);
      if (!Number.isFinite(v) || v < 0) errors.push(`${f} must be a non-negative number`);
      else next[f] = f === "edition_size" ? Math.round(v) : v;
    }
  }
  if (body.artist_profit_share !== undefined) {
    const v = Number(body.artist_profit_share);
    if (!Number.isFinite(v) || v < 0 || v > 1) errors.push("artist_profit_share must be 0..1");
    else next.artist_profit_share = v;
  }
  if (body.framing_available !== undefined) next.framing_available = !!body.framing_available;
  for (const [f, allowed] of Object.entries(PICKS)) {
    if (body[f] !== undefined) {
      if (!allowed.includes(body[f])) errors.push(`${f} must be one of ${allowed.join("/")}`);
      else next[f] = body[f];
    }
  }
  for (const f of ["private_room_open", "announce_date", "launch_end"]) {
    if (body[f] !== undefined) {
      if (!DATE_RE.test(String(body[f]))) errors.push(`${f} must be YYYY-MM-DD`);
      else next[f] = body[f];
    }
  }
  for (const f of ["marketing_lead", "budget_file", "campaign_name"]) {
    if (body[f] !== undefined) next[f] = body[f] === null ? null : String(body[f]).slice(0, 200);
  }
  if (body.channel_quality_overrides !== undefined) {
    const ov = {};
    for (const [c, q] of Object.entries(body.channel_quality_overrides || {})) {
      if (!(c in doc.channel_quality_default)) errors.push(`unknown channel ${c}`);
      else if (!QUALITIES.includes(q)) errors.push(`bad quality for ${c}`);
      else if (doc.channel_quality_default[c] !== q) ov[c] = q;
    }
    next.channel_quality_overrides = ov;
  }
  if (new Date(next.launch_end) <= new Date(next.announce_date)) {
    errors.push("launch_end must be after announce_date");
  }
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const snapPath = path.join(DATA, "releases", `${id}.json`);
  if (!fs.existsSync(snapPath)) return res.status(404).json({ error: "no snapshot for release" });
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  const curves = JSON.parse(fs.readFileSync(path.join(DATA, "curves.json"), "utf8"));
  const bench = doc.benchmarks;
  const mergedForModel = { ...next, channel_quality_default: doc.channel_quality_default };
  const { computeTargets } = await modelPromise;
  const updated = retargetSnapshot(snap, mergedForModel, bench, curves, computeTargets);

  doc.releases[id] = next;
  fs.writeFileSync(INPUTS_PATH, JSON.stringify(doc, null, 1));
  fs.writeFileSync(snapPath, JSON.stringify(updated, null, 1));
  fs.appendFileSync(TARGETS_LOG, JSON.stringify({
    ts: new Date().toISOString(), releaseId: id, inputs: next, actor: "dashboard",
  }) + "\n");

  // A changed Meta-campaign match re-attributes paid spend, which only the full
  // ETL can do — rerun it (build.py overlays the inputs just saved) and return
  // the rebuilt snapshot. On failure the retargeted snapshot still stands.
  if ((next.campaign_name || null) !== (current.campaign_name || null)) {
    try {
      await sheets.runEtl();
      return res.json({ snapshot: JSON.parse(fs.readFileSync(snapPath, "utf8")) });
    } catch (e) {
      return res.json({
        snapshot: updated,
        warning: "Saved, but paid spend could not be re-attributed yet (" +
          String((e && e.message) || e).slice(0, 200) + ") — it will catch up on the next data refresh.",
      });
    }
  }
  res.json({ snapshot: updated });
});

// ---- live data refresh (Google Sheet -> sources -> ETL; server/sheets.js) ----
const sheets = require("./sheets");
app.post("/api/refresh", async (_req, res) => {
  try {
    res.json(await sheets.refresh());
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
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

app.use(express.static(DIST));
app.get(/.*/, (_req, res) => res.sendFile(path.join(DIST, "index.html")));

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`launch-bi listening on :${port}`);
  sheets.startScheduler();
});
