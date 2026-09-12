/* Live data ingestion + the refresh scheduler.
 *
 * Two paths write the same two files. BigQuery is the origin and is preferred
 * when a key is configured (server/bigquery.js); this Google Sheet path is the
 * fallback, and is capped at 50,000 rows per tab by the sheet export itself.
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
// The JWT/RS256 exchange lives in googleAuth.js - BigQuery needs the same
// machinery with a different scope, and one cache keyed only by account would
// hand the wrong token to whichever feed asked second.
const googleAuth = require("./googleAuth");
const serviceAccount = () => googleAuth.serviceAccount("GOOGLE_SERVICE_ACCOUNT_JSON");
const accessToken = (sa) => googleAuth.accessToken(sa, "sheets");

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

/* Row-wise converters, shared by the sheet path (whole tab in memory) and the
 * BigQuery path (one page at a time, streamed to disk). Each takes the header
 * row and returns { header: csv header line, row(cells) -> csv line or null,
 * dropped: rows skipped for an unreadable date }. */

/* Funnel rows -> across_time.csv (build.py expects event_date as DD/MM/YYYY). */
function acrossTimeWriter(headerRow) {
  const header = headerRow.map((h) => String(h ?? "").trim());
  while (header.length && header[header.length - 1] === "") header.pop();
  const di = header.indexOf("event_date");
  if (di < 0 || !header.includes("simple_release_name")) {
    throw new Error(`funnel header not recognised: ${header.slice(0, 5).join(", ")}…`);
  }
  const w = {
    header: header.map(csvCell).join(","),
    dateIndex: di,
    dropped: 0,
    row(cells) {
      if (!cells || !cells.length || cells.every((c) => c === "" || c === null || c === undefined)) return null;
      const d = normDate(cells[di]);
      if (!d) { w.dropped++; return null; }
      const out = new Array(header.length);
      for (let i = 0; i < header.length; i++) out[i] = i === di ? fmtDMY(d) : csvCell(cells[i]);
      return out.join(",");
    },
  };
  return w;
}

/* Meta ads rows -> spend_daily.csv (same mapping as etl/extract_spend.py). */
function spendWriter(headerRow) {
  const header = headerRow.map((h) => String(h ?? "").trim().toLowerCase());
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
    throw new Error(`spend header not recognised: ${header.join(", ")}`);
  }
  const w = {
    header: "campaign_name,spend_date,impressions,reach,link_clicks,spend",
    dateIndex: -1,
    dropped: 0,
    row(cells) {
      if (!cells || !cells[ci.name]) return null;
      const d = normDate(cells[ci.date]);
      if (!d) { w.dropped++; return null; }
      return [
        csvCell(cells[ci.name]), fmtISO(d),
        Number(cells[ci.imp]) || 0, Number(cells[ci.reach]) || 0,
        Number(cells[ci.clicks]) || 0, Number(cells[ci.spend]) || 0,
      ].join(",");
    },
  };
  return w;
}

/* Whole-tab forms, used by the sheet path. */
function convertAcrossTime(values) {
  if (!values.length) throw new Error("funnel tab came back empty");
  const w = acrossTimeWriter(values[0]);
  const out = [w.header];
  for (let r = 1; r < values.length; r++) {
    const line = w.row(values[r]);
    if (line !== null) out.push(line);
  }
  return { csv: out.join("\n") + "\n", rows: out.length - 1, dropped: w.dropped };
}

function convertSpend(values) {
  let rows = values;
  // the _export variant carries a "Custom query:" banner row above the header
  if (rows.length && rows[0].length <= 1) rows = rows.slice(1);
  if (!rows.length) throw new Error("spend tab came back empty");
  const w = spendWriter(rows[0]);
  const out = [w.header];
  for (let r = 1; r < rows.length; r++) {
    const line = w.row(rows[r]);
    if (line !== null) out.push(line);
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

function runPy(script, timeoutMs, args = []) {
  const venvPy = path.join(ROOT, ".venv", "bin", "python3");
  const py = fs.existsSync(venvPy) ? venvPy : "python3";
  return new Promise((resolve, reject) => {
    execFile(py, [path.join(ROOT, "etl", script), ...args],
      { cwd: ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${script} failed: ${(stderr || err.message).slice(-800)}`));
        else resolve(stdout.trim());
      });
  });
}

/* The event-level feeds are aggregated first (the export rebuilt, the people
 * file, the reconciliation), then the build. The aggregation failing is
 * reported, not fatal: the build still runs on whatever funnel file
 * FUNNEL_SOURCE points at, exactly as a failed pull leaves the previous file. */
/* `release` rebuilds one release instead of the catalogue. A save changes one
 * release's inputs and nothing else, so rebuilding all 363 pages to answer it
 * costs about eighteen seconds of which that release is a fraction. The
 * event-level aggregation is skipped with it: it rebuilds the funnel export
 * from the raw feeds, which a save cannot touch either. Roughly seven times
 * faster, and byte-identical for the release in question. */
async function runEtlOnce(release) {
  if (release) {
    const build = await runPy("build.py", 5 * 60 * 1000, ["--release", release]);
    return build.split("\n").slice(-2).filter(Boolean).join(" | ");
  }
  let agg = "";
  try {
    const out = await runPy("aggregate_events.py", 5 * 60 * 1000);
    agg = out.split("\n").slice(-1)[0];
  } catch (e) {
    agg = String(e.message || e).replace(/\s+/g, " ").slice(0, 300);
    console.error("sheets: " + agg);
  }
  const build = await runPy("build.py", 5 * 60 * 1000);
  return [agg, ...build.split("\n").slice(-3)].filter(Boolean).join(" | ");
}

// only one build.py at a time (a save-triggered rerun can race the scheduler)
let etlLock = Promise.resolve();
function runEtl(release) {
  const p = etlLock.then(() => runEtlOnce(release));
  etlLock = p.catch(() => {});
  return p;
}

let running = null;
let runningSince = null;
let lastRefresh = null; // last attempt's outcome, for /api/refresh/status

/* The three feeds are independent - each is attempted on every refresh and one
 * failing never blocks the others. The ETL reruns when any feed updated. The
 * result never throws: read `ok` (every attempted feed succeeded) and the
 * per-feed fields. */
async function refresh({ full = false } = {}) {
  if (running) return running; // serialize concurrent calls (a full flag joins the one in flight)
  runningSince = new Date().toISOString();
  running = (async () => {
    const started = Date.now();
    const out = { ok: true };
    let updated = false;

    // BigQuery is the same data without the sheet's 50k-row export cap, so it
    // wins when configured. If it fails we still try the sheet - a shorter
    // history beats a frozen one - but ok stays false so the header says stale
    // rather than quietly serving the truncated fallback as if nothing broke.
    let bqDone = false, bqSpend = false;
    const bq = require("./bigquery");
    let bqOn = false;
    try { bqOn = !!bq.configured(); } catch (e) {
      out.bigquery = "bigquery misconfigured: " + String((e && e.message) || e).slice(0, 300);
      out.ok = false;
      console.error("sheets: " + out.bigquery);
    }
    if (bqOn) {
      try {
        // streams straight to disk and swaps the files in atomically; when the
        // account cannot see the spend table the previous spend_daily.csv is
        // left in place rather than blanked
        const pulled = await bq.pull({ full });
        out.bigquery = pulled.summary;
        bqDone = true;
        bqSpend = pulled.spendRows !== null;
        updated = true;
      } catch (e) {
        out.bigquery = "bigquery failed: " + String((e && e.message) || e).slice(0, 300);
        out.ok = false;
        console.error("sheets: " + out.bigquery);
      }
    }

    if (bqDone && bqSpend) {
      out.sheet = "skipped - BigQuery is the source";
    } else if (bqDone) {
      // BigQuery covered the funnel but the account cannot see the spend
      // table. Take spend from the sheet's tab so paid spend keeps refreshing,
      // rather than freezing at whatever the last pull left behind.
      try {
        const sa = serviceAccount();
        const token = sa ? await accessToken(sa) : null;
        const sp = convertSpend(await fetchTab(SPEND_TAB, token));
        writeAtomic(SPEND_DAILY, sp.csv);
        out.sheet = `spend only: ${sp.rows} rows from the sheet (${token ? "service-account" : "public-link"}); ` +
          "funnel from BigQuery";
      } catch (e) {
        // paid spend is stale from both sources - say so rather than reading fresh
        out.sheet = "spend stale - BigQuery denies the spend table and the sheet fallback failed: " +
          String((e && e.message) || e).slice(0, 200);
        out.ok = false;
        console.error("sheets: " + out.sheet);
      }
    } else try {
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
      out.sheet = `funnel ${at.rows} rows, spend ${sp.rows} rows (${token ? "service-account" : "public-link"})`;
      updated = true;
    } catch (e) {
      out.sheet = "sheet failed: " + String((e && e.message) || e).slice(0, 300);
      out.ok = false;
      console.error("sheets: " + out.sheet);
    }

    try {
      out.emails = await require("./hubspot").refreshEmails();
      if (!out.emails.startsWith("hubspot off")) updated = true;
    } catch (e) {
      out.emails = "hubspot failed: " + String((e && e.message) || e).slice(0, 300);
      out.ok = false;
      console.error("sheets: " + out.emails);
    }

    try {
      out.notion = await require("./notion").refreshArtistPosts();
      if (!out.notion.startsWith("notion off")) updated = true;
    } catch (e) {
      out.notion = "notion failed: " + String((e && e.message) || e).slice(0, 300);
      out.ok = false;
      console.error("sheets: " + out.notion);
    }

    if (updated) {
      try {
        out.etl = await runEtl();
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 300);
        out.etl = msg.startsWith("etl failed") ? msg : "etl failed: " + msg;
        out.ok = false;
        console.error("sheets: " + out.etl);
      }
    } else {
      out.etl = "skipped - no feed updated";
    }
    out.tookMs = Date.now() - started;
    return out;
  })();
  try {
    const result = await running;
    lastRefresh = { at: new Date().toISOString(), ...result };
    return result;
  } finally { running = null; runningSince = null; }
}

/* The last attempt's outcome plus whether one is in flight right now. A full
 * refresh (multi-year BigQuery pull + ETL) takes minutes - longer than Render's
 * proxy will hold a request open - so callers start one and poll this. */
function status() {
  return { running: !!running, runningSince, ...(lastRefresh || {}) };
}

function startScheduler() {
  if (process.env.SHEETS_REFRESH === "off") {
    console.log("sheets: refresh disabled (SHEETS_REFRESH=off)");
    return;
  }
  const mins = Math.max(5, Number(process.env.REFRESH_MINUTES) || 60);
  const tick = (label) => refresh()
    .then((r) => console.log(`sheets: ${label} refresh ${r.ok ? "ok" : "with failures"} - ` +
      `${r.bigquery ? r.bigquery + " | " : ""}${r.sheet} | ${r.emails} | ${r.notion} | ` +
      `${r.tookMs}ms | ${r.etl}`))
    .catch((e) => console.error(`sheets: ${label} refresh crashed - ${e.message}`));
  setTimeout(() => tick("boot"), 8000);
  setInterval(() => tick("scheduled"), mins * 60 * 1000).unref();
  console.log(`sheets: live refresh every ${mins}m from sheet ${SHEET_ID.slice(0, 8)}…`);
}

module.exports = {
  refresh, status, startScheduler, runEtl, writeAtomic,
  convertAcrossTime, convertSpend, acrossTimeWriter, spendWriter, normDate, parseCsv,
};
