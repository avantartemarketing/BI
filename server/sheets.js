/* Live data ingestion from the "LE Paid Calculator" Google Sheet.
 *
 * Pulls two tabs and rewrites the ETL inputs, then reruns the ETL so the
 * dashboard serves fresh snapshots without a redeploy:
 *   "Metabase LE Funnel Import by Day"  -> sources/across_time.csv
 *   "meta_ads_insights_Extract"         -> data/spend_daily.csv
 *
 * Auth: a Google service account (share the sheet with its client_email as
 * Viewer, put the key JSON in GOOGLE_SERVICE_ACCOUNT_JSON). Without a key it
 * falls back to the public CSV export, which only works while the sheet is
 * link-shared. The ETL needs python3 + pandas on PATH (see render.yaml).
 *
 * The refresh runs on boot and every REFRESH_MINUTES (default 60), and can be
 * forced with POST /api/refresh. Failures leave the previous snapshots serving. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SHEET_ID = process.env.SHEET_ID || "147xGRf0fKfsdgh_AqHqsRiajdd7bQANrhbipCbzby_o";
const FUNNEL_TAB = process.env.SHEET_FUNNEL_TAB || "Metabase LE Funnel Import by Day";
const SPEND_TAB = process.env.SHEET_SPEND_TAB || "meta_ads_insights_Extract";
const ACROSS_TIME = path.join(ROOT, "sources", "across_time.csv");
const SPEND_DAILY = path.join(ROOT, "data", "spend_daily.csv");

// ---------------------------------------------------------------- auth

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) throw new Error("missing client_email/private_key");
    return sa;
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service-account key: ${e.message}`);
  }
}

let cachedToken = null; // { token, exp }

async function accessToken(sa) {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;
  const b64u = (s) => Buffer.from(s).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64u(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64u(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now, exp: now + 3600,
    }));
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  const jwt = unsigned + "." + sig.toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(jwt),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed (${res.status}): ${body.error_description || body.error || "?"}`);
  }
  cachedToken = { token: body.access_token, exp: (now + (body.expires_in || 3600)) * 1000 };
  return cachedToken.token;
}

// ---------------------------------------------------------------- fetch

async function listTabs(token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return (body.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
}

/* Returns the tab as an array of row arrays (strings/numbers; dates as Sheets
 * serial numbers when authenticated, locale-formatted strings via the public
 * fallback - normDate handles both). */
async function fetchTab(tab, token) {
  if (token) {
    const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}` +
      "?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 400) hint = ` - tabs on the sheet: ${(await listTabs(token)).join(" | ")}`;
      if (res.status === 403) hint = " - is the sheet shared with the service account email?";
      throw new Error(`Sheets API ${res.status} for tab "${tab}"${hint} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    return body.values || [];
  }
  // public fallback (sheet must be link-shared)
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { redirect: "follow" });
  const text = await res.text();
  if (!res.ok || text.startsWith("<")) {
    throw new Error(`public CSV export failed for tab "${tab}" (${res.status}) - ` +
      "set GOOGLE_SERVICE_ACCOUNT_JSON or keep the sheet link-shared");
  }
  return parseCsv(text);
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- convert

/* Accepts a Sheets serial number, "YYYY-MM-DD[ hh:mm:ss]", "DD/MM/YYYY" or a
 * Date-ish string; returns [y, m, d] or null. */
function normDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const serial = Number(v);
    if (serial < 20000 || serial > 80000) return null; // not a plausible date serial
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return [+m[1], +m[2], +m[3]];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return [+m[3], +m[2], +m[1]]; // DD/MM/YYYY (sheet locale is en-GB)
  return null;
}

const p2 = (n) => String(n).padStart(2, "0");
const fmtDMY = ([y, m, d]) => `${p2(d)}/${p2(m)}/${y}`;
const fmtISO = ([y, m, d]) => `${y}-${p2(m)}-${p2(d)}`;

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* Funnel tab -> across_time.csv (build.py expects event_date as DD/MM/YYYY). */
function convertAcrossTime(values) {
  if (!values.length) throw new Error("funnel tab came back empty");
  const header = values[0].map((h) => String(h ?? "").trim());
  while (header.length && header[header.length - 1] === "") header.pop();
  const di = header.indexOf("event_date");
  if (di < 0 || !header.includes("simple_release_name")) {
    throw new Error(`funnel tab header not recognised: ${header.slice(0, 5).join(", ")}…`);
  }
  const out = [header.map(csvCell).join(",")];
  let dropped = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row || !row.length || row.every((c) => c === "" || c === null || c === undefined)) continue;
    const d = normDate(row[di]);
    if (!d) { dropped++; continue; }
    const cells = header.map((_, i) => (i === di ? fmtDMY(d) : csvCell(row[i])));
    out.push(cells.join(","));
  }
  return { csv: out.join("\n") + "\n", rows: out.length - 1, dropped };
}

/* Meta ads tab -> spend_daily.csv (same mapping as etl/extract_spend.py). */
function convertSpend(values) {
  let rows = values;
  // the _export variant carries a "Custom query:" banner row above the header
  if (rows.length && rows[0].length <= 1) rows = rows.slice(1);
  if (!rows.length) throw new Error("spend tab came back empty");
  const header = rows[0].map((h) => String(h ?? "").trim().toLowerCase());
  const col = (name, alt) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : header.indexOf(alt ?? name);
  };
  const ci = {
    name: col("campaign_name"), date: col("spend_date"),
    imp: col("impressions"), reach: col("reachs", "reach"),
    clicks: col("link_clicks"), spend: col("spend"),
  };
  if (ci.name < 0 || ci.date < 0 || ci.spend < 0) {
    throw new Error(`spend tab header not recognised: ${header.join(", ")}`);
  }
  const out = ["campaign_name,spend_date,impressions,reach,link_clicks,spend"];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[ci.name]) continue;
    const d = normDate(row[ci.date]);
    if (!d) continue;
    out.push([
      csvCell(row[ci.name]), fmtISO(d),
      Number(row[ci.imp]) || 0, Number(row[ci.reach]) || 0,
      Number(row[ci.clicks]) || 0, Number(row[ci.spend]) || 0,
    ].join(","));
  }
  return { csv: out.join("\n") + "\n", rows: out.length - 1 };
}

// ---------------------------------------------------------------- refresh

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function runEtlOnce() {
  return new Promise((resolve, reject) => {
    execFile("python3", [path.join(ROOT, "etl", "build.py")],
      { cwd: ROOT, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`etl failed: ${(stderr || err.message).slice(-800)}`));
        else resolve(stdout.trim().split("\n").slice(-3).join(" | "));
      });
  });
}

// only one build.py at a time (a save-triggered rerun can race the scheduler)
let etlLock = Promise.resolve();
function runEtl() {
  const p = etlLock.then(runEtlOnce);
  etlLock = p.catch(() => {});
  return p;
}

let running = null;
let lastRefresh = null; // last attempt's outcome, for /api/refresh/status

async function refresh() {
  if (running) return running; // serialize concurrent calls
  running = (async () => {
    const started = Date.now();
    const sa = serviceAccount();
    const token = sa ? await accessToken(sa) : null;
    const [funnel, spend] = await Promise.all([
      fetchTab(FUNNEL_TAB, token), fetchTab(SPEND_TAB, token),
    ]);
    const at = convertAcrossTime(funnel);
    const sp = convertSpend(spend);
    if (at.rows < 100) throw new Error(`funnel tab suspiciously small (${at.rows} rows) - not overwriting`);
    writeAtomic(ACROSS_TIME, at.csv);
    writeAtomic(SPEND_DAILY, sp.csv);
    // email stats from HubSpot when a token is present; failure keeps the last CSV
    let emails;
    try {
      emails = await require("./hubspot").refreshEmails();
    } catch (e) {
      emails = "hubspot failed: " + String((e && e.message) || e).slice(0, 160);
      console.error("sheets: " + emails);
    }
    // artist posts from Notion when a token is present; failure keeps the last CSV
    let notion;
    try {
      notion = await require("./notion").refreshArtistPosts();
    } catch (e) {
      notion = "notion failed: " + String((e && e.message) || e).slice(0, 160);
      console.error("sheets: " + notion);
    }
    const etl = await runEtl();
    return {
      ok: true, auth: token ? "service-account" : "public-link",
      funnelRows: at.rows, funnelDropped: at.dropped, spendRows: sp.rows,
      emails, notion, etl, tookMs: Date.now() - started,
    };
  })();
  try {
    const result = await running;
    lastRefresh = { at: new Date().toISOString(), ...result };
    return result;
  } catch (e) {
    lastRefresh = { at: new Date().toISOString(), ok: false, error: String((e && e.message) || e) };
    throw e;
  } finally { running = null; }
}

function status() {
  return lastRefresh;
}

function startScheduler() {
  if (process.env.SHEETS_REFRESH === "off") {
    console.log("sheets: refresh disabled (SHEETS_REFRESH=off)");
    return;
  }
  const mins = Math.max(5, Number(process.env.REFRESH_MINUTES) || 60);
  const tick = (label) => refresh()
    .then((r) => console.log(`sheets: ${label} refresh ok - funnel ${r.funnelRows} rows, ` +
      `spend ${r.spendRows} rows, ${r.emails}, ${r.notion}, ${r.auth}, ${r.tookMs}ms | ${r.etl}`))
    .catch((e) => console.error(`sheets: ${label} refresh failed - ${e.message}`));
  setTimeout(() => tick("boot"), 8000);
  setInterval(() => tick("scheduled"), mins * 60 * 1000).unref();
  console.log(`sheets: live refresh every ${mins}m from sheet ${SHEET_ID.slice(0, 8)}…`);
}

module.exports = { refresh, status, startScheduler, runEtl, convertAcrossTime, convertSpend, normDate, parseCsv };
