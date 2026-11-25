/* Live data ingestion + the refresh scheduler.
 *
 * The funnel (sources/across_time.csv) and Meta spend (data/spend_daily.csv)
 * come from BigQuery alone (server/bigquery.js). The Google Sheet fallback was
 * removed on 25 November 2026: when BigQuery is off or fails, the previous
 * files keep serving and the header reads stale. This file keeps the row
 * converters BigQuery's writers share, the other feeds (HubSpot, Notion,
 * Airtable) and the ETL rerun. The ETL needs python3 + pandas on PATH (see
 * render.yaml).
 *
 * The refresh runs on boot and every REFRESH_MINUTES (default 60), and can be
 * forced with POST /api/refresh. Failures leave the previous snapshots serving. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
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
    // the ad set, where the export carries it (a release selling two lines
    // of work on one page runs an ad set per line, docs/LINES_PLAN.md);
    // blank on a campaign-level export, and the build sums over it
    adset: col("adset_name", "ad_set_name"),
  };
  if (ci.name < 0 || ci.date < 0 || ci.spend < 0) {
    throw new Error(`spend header not recognised: ${header.join(", ")}`);
  }
  const w = {
    header: "campaign_name,spend_date,impressions,reach,link_clicks,spend,adset_name",
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
        ci.adset >= 0 ? csvCell(cells[ci.adset]) : "",
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

/* A Python script's failure, the error first. A traceback's last line is the
 * exception; the refresh status keeps 300 characters of the message, which
 * used to be the middle of the traceback (pathlib's own frames) with the
 * exception cut off the end, so the header read "Sources stale" and the
 * tooltip could not say why. Lead with the exception and the innermost frame
 * in etl/, then the tail of the traceback for the rest. */
function pyFailure(script, stderr, fallback) {
  const text = String(stderr || "").trimEnd();
  if (!text) return `${script} failed: ${fallback || "no output"}`;
  const lines = text.split("\n");
  const error = lines[lines.length - 1].trim();
  const frame = [...lines].reverse()
    .map((l) => /^\s*File "([^"]+)", line (\d+), in (.+)$/.exec(l))
    .find((m) => m && m[1].includes(`${path.sep}etl${path.sep}`));
  const where = frame ? ` (etl/${path.basename(frame[1])}:${frame[2]} in ${frame[3]})` : "";
  return `${script} failed: ${error}${where} | ${text.slice(-800)}`;
}

/* The build's line for the pages that did not build ("pages failed: N -
 * id: error; ..."), read off the whole of its output rather than its last
 * lines, so the status can say how many and which (etl/build.py main). */
function parseBuildSummary(stdout) {
  const m = /^pages failed: (\d+) - (.*)$/m.exec(String(stdout || ""));
  if (!m) return { pagesFailed: 0, failedPages: [] };
  const failedPages = m[2].split(";").map((s) => s.trim())
    .filter((s) => s && !/^and \d+ more$/.test(s))
    .map((s) => s.split(":")[0].trim()).slice(0, 5);
  return { pagesFailed: Number(m[1]), failedPages };
}
let lastBuild = { pagesFailed: 0, failedPages: [] };   // the last full build's summary

function runPy(script, timeoutMs, args = []) {
  const venvPy = path.join(ROOT, ".venv", "bin", "python3");
  const py = fs.existsSync(venvPy) ? venvPy : "python3";
  return new Promise((resolve, reject) => {
    execFile(py, [path.join(ROOT, "etl", script), ...args],
      { cwd: ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(pyFailure(script, stderr, err.message)));
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
  // the timed launches' aggregation (docs/TL_SPEC.md §3): its own feeds, its
  // own files, and a failure that costs the TL pages a refresh, never the LE ones
  try {
    const out = await runPy("aggregate_tl.py", 5 * 60 * 1000);
    agg += (agg ? " | " : "") + out.split("\n").filter(Boolean).slice(-1)[0];
  } catch (e) {
    const msg = String(e.message || e).replace(/\s+/g, " ").slice(0, 300);
    agg += (agg ? " | " : "") + msg;
    console.error("sheets: " + msg);
  }
  const build = await runPy("build.py", 5 * 60 * 1000);
  lastBuild = parseBuildSummary(build);
  return [agg, ...build.split("\n").slice(-6)].filter(Boolean).join(" | ");
}

// only one build.py at a time (a save-triggered rerun can race the scheduler)
let etlLock = Promise.resolve();
function runEtl(release) {
  const p = etlLock.then(() => runEtlOnce(release));
  etlLock = p.catch(() => {});
  return p;
}
/* The upcoming pages alone, from Airtable (build.py --upcoming): seconds,
 * no funnel export needed. Run at boot when a deploy has lost them. */
function buildUpcoming() {
  const p = etlLock.then(async () => {
    const out = await runPy("build.py", 2 * 60 * 1000, ["--upcoming"]);
    return out.split("\n").filter(Boolean).slice(-1)[0] || "done";
  });
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

    // BigQuery is the only source for the funnel and Meta spend. The Google
    // Sheet fallback was removed on 25 November 2026 at the repository
    // owner's request: when BigQuery is off or fails, the previous files keep
    // serving and the header reads stale, rather than swapping in the sheet.
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
        updated = true;
        if (pulled.spendRows === null && process.env.BQ_SPEND !== "off") {
          out.spend = "spend stale - BigQuery denies or skips the spend table (no sheet fallback)";
          out.ok = false;
          console.error("sheets: " + out.spend);
        }
      } catch (e) {
        out.bigquery = "bigquery failed: " + String((e && e.message) || e).slice(0, 300);
        out.ok = false;
        console.error("sheets: " + out.bigquery);
      }
    } else if (!out.bigquery) {
      out.bigquery = "bigquery failed: not configured, and the Google Sheet is no longer used - previous files keep serving";
      out.ok = false;
      console.error("sheets: " + out.bigquery);
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

    // The plan-based view's two feeds (docs/PLAN_MODEL.md): the Notion comms
    // plan row by row, and the HubSpot emails with their audiences. A failed
    // pull leaves the previous file in place and costs the launch pages their
    // plan view at worst (the clock's page never reads these), so it is
    // reported here and in the log and does not fail the refresh.
    try {
      const comms = require("./commsPlan");
      out.commsPlan = await comms.refreshCommsPlan({ days: comms.REFRESH_DAYS });   // the recent and coming rows: the whole plan takes minutes and only the back-test needs it
      if (!out.commsPlan.startsWith("comms plan off")) updated = true;
    } catch (e) {
      out.commsPlan = "comms plan failed: " + String((e && e.message) || e).slice(0, 300);
      console.error("sheets: " + out.commsPlan);
    }
    try {
      out.audiences = await require("./emailAudiences").refreshAudiences();
      if (!out.audiences.startsWith("email audiences off")) updated = true;
    } catch (e) {
      out.audiences = "email audiences failed: " + String((e && e.message) || e).slice(0, 300);
      console.error("sheets: " + out.audiences);
    }

    // Airtable's Pipeline table: every product's edition, price, target
    // economics and dates, which the Target setting tab reads per release
    // (etl/pull_airtable.py). Off without a token; a failed pull leaves the
    // previous file in place.
    if (process.env.AIRTABLE_TOKEN) {
      try {
        const pulled = await runPy("pull_airtable.py", 5 * 60 * 1000);
        out.airtable = "airtable " + pulled.split("\n").filter(Boolean).slice(0, 2).join(" | ").slice(0, 300);
        updated = true;
      } catch (e) {
        out.airtable = "airtable failed: " + String((e && e.message) || e).slice(0, 300);
        out.ok = false;
        console.error("sheets: " + out.airtable);
      }
    } else {
      out.airtable = "airtable off (no AIRTABLE_TOKEN)";
    }

    if (updated) {
      try {
        out.etl = await runEtl();
        // the pages that did not build: the build went on without them and
        // wrote the index, so the step succeeded, and the header says how many
        out.etlPagesFailed = lastBuild.pagesFailed;
        out.etlFailedPages = lastBuild.failedPages;
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
    const now = new Date().toISOString();
    // when the current run of failed refreshes began, for the header's
    // "refresh failing since"; cleared by the first one that succeeds
    failingSince = result.ok === false ? (failingSince || now) : null;
    lastRefresh = { at: now, failingSince, ...result };
    alertRefresh(lastRefresh, now).catch((e) => console.error("sheets: alert failed - " + String((e && e.message) || e).slice(0, 200)));
    return result;
  } finally { running = null; runningSince = null; }
}
let failingSince = null;

/* Refresh alerts: one line to SLACK_ALERT_CHANNEL on the second consecutive
 * troubled refresh (a failed feed or step, or a page that did not build),
 * once per run of trouble, and one line when it recovers. Nobody hovers the
 * header's tooltip: on 28 September the build failed all evening before
 * anyone saw. Without the channel or the token nothing is posted. The
 * decision is a pure function so tests/py_failure.mjs can run it. */
let alertState = { troubled: 0, alerted: false, since: null };
function alertDecision(state, result, now) {
  const troubled = result.ok === false || Number(result.etlPagesFailed || 0) > 0;
  if (troubled) {
    const next = { troubled: (state.troubled || 0) + 1, alerted: !!state.alerted, since: state.since || now };
    if (next.troubled >= 2 && !next.alerted) return { post: "trouble", state: { ...next, alerted: true } };
    return { post: null, state: next };
  }
  return { post: state.alerted ? "recovery" : null, state: { troubled: 0, alerted: false, since: null } };
}
/* What is wrong, one line per failing feed or step, as the status words it. */
function troubleLines(result) {
  const feeds = [["BigQuery", result.bigquery], ["Spend", result.spend], ["Email", result.emails],
    ["Notion", result.notion], ["Airtable", result.airtable], ["ETL", result.etl]];
  const lines = feeds.filter(([, v]) => /failed|misconfigured|stale/i.test(String(v || "")))
    .map(([k, v]) => `${k}: ${String(v).slice(0, 240)}`);
  const n = Number(result.etlPagesFailed || 0);
  if (n > 0) lines.push(`${n} page${n === 1 ? "" : "s"} did not build: ${(result.etlFailedPages || []).join(", ")}`);
  return lines;
}
async function alertRefresh(result, now = new Date().toISOString()) {
  const d = alertDecision(alertState, result, now);
  alertState = d.state;
  const channel = process.env.SLACK_ALERT_CHANNEL;
  if (!d.post || !channel || !process.env.SLACK_BOT_TOKEN) return null;
  const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) + " UK";
  const text = d.post === "trouble"
    ? `Dashboard refresh: failing since ${clock(alertState.since)}, ${alertState.troubled} attempts in a row.\n` + troubleLines(result).join("\n")
    : `Dashboard refresh: back to normal at ${clock(now)}.`;
  return require("./slack").postMessage(channel, text);
}

/* The last attempt's outcome plus whether one is in flight right now. A full
 * refresh (multi-year BigQuery pull + ETL) takes minutes - longer than Render's
 * proxy will hold a request open - so callers start one and poll this. */
function status() {
  return { running: !!running, runningSince, ...(lastRefresh || {}) };
}

/* How long until the next refresh (docs/TL_SPEC.md §2): REFRESH_MINUTES
 * (default 60), or REFRESH_WINDOW_MINUTES (default 30) while a timed launch's
 * window is open or opens before the next hourly tick would run, read off the
 * index the last build wrote. `index` is the index document (or null) and
 * `now` a Date; both are injectable for the test. */
function refreshIntervalMinutes(index, now = new Date(), env = process.env) {
  const mins = Math.max(5, Number(env.REFRESH_MINUTES) || 60);
  const windowMins = Math.max(5, Math.min(mins, Number(env.REFRESH_WINDOW_MINUTES) || 30));
  const rows = (index && Array.isArray(index.releases)) ? index.releases : [];
  const t = now.getTime();
  const soon = rows.some((r) => {
    if (r.type !== "TL") return false;
    if (r.tlState === "window") return true;
    // a window that opens before the hourly tick would come round
    const open = r.salesOpen ? Date.parse(r.salesOpen) : NaN;
    return Number.isFinite(open) && open > t && open - t <= mins * 60 * 1000;
  });
  return soon ? windowMins : mins;
}

function readIndexDoc() {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.APP_DATA_PATH || path.join(ROOT, "data", "app"), "index.json"), "utf8")); } catch { return null; }
}

function startScheduler() {
  if (process.env.SHEETS_REFRESH === "off") {
    console.log("sheets: refresh disabled (SHEETS_REFRESH=off)");
    return;
  }
  const tick = (label) => refresh()
    .then((r) => console.log(`sheets: ${label} refresh ${r.ok ? "ok" : "with failures"} - ` +
      `${r.bigquery ? r.bigquery + " | " : ""}${r.spend ? r.spend + " | " : ""}${r.emails} | ${r.notion} | ` +
      `${r.commsPlan ? r.commsPlan + " | " : ""}${r.audiences ? r.audiences + " | " : ""}` +
      `${r.tookMs}ms | ${r.etl}`))
    .catch((e) => console.error(`sheets: ${label} refresh crashed - ${e.message}`));
  // the interval is read after every refresh: a timed launch's window opening
  // brings the next tick forward to REFRESH_WINDOW_MINUTES (docs/TL_SPEC.md §2)
  let lastMins = null;
  const schedule = () => {
    const mins = refreshIntervalMinutes(readIndexDoc());
    if (mins !== lastMins) {
      console.log(`sheets: next refresh in ${mins}m${mins < (Math.max(5, Number(process.env.REFRESH_MINUTES) || 60)) ? " (a timed launch's window is open or about to)" : ""}`);
      lastMins = mins;
    }
    setTimeout(() => tick("scheduled").finally(schedule), mins * 60 * 1000).unref();
  };
  setTimeout(() => tick("boot").finally(schedule), 8000);
  console.log(`sheets: live refresh every ${refreshIntervalMinutes(readIndexDoc())}m from BigQuery`);
}

module.exports = {
  refresh, status, startScheduler, refreshIntervalMinutes, runEtl, buildUpcoming, writeAtomic, pyFailure, parseBuildSummary, alertDecision, troubleLines,
  convertAcrossTime, convertSpend, acrossTimeWriter, spendWriter, normDate, parseCsv,
};
