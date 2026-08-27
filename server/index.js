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

app.get("/api/index", (_req, res) => res.sendFile(path.join(DATA, "index.json")));
app.get("/api/curves", (_req, res) => res.sendFile(path.join(DATA, "curves.json")));
app.get("/api/releases/:id", (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9_]/g, "");
  const file = path.join(DATA, "releases", `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "unknown release" });
  res.sendFile(file);
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
app.listen(port, () => console.log(`launch-bi listening on :${port}`));
