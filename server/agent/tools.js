/* The Agent's tools: everything it can look at, and nothing it can change.
 *
 * Each tool reads files the dashboard already serves or builds from (the
 * index, the release snapshots, the CSV tables under data/, the docs) and
 * returns compact JSON for the model. None of them writes: there is no path
 * from here to the saved inputs, the targets, the layout or any other state,
 * which is what keeps the Agent from changing the dashboard.
 *
 * Personal data: the tables listed here hold aggregates only (customer
 * addresses never leave BigQuery, CLAUDE.md). As a second guard every table
 * drops any column whose values look like email addresses, and every result
 * has address-shaped strings masked before it goes to the model. */
const fs = require("fs");
const path = require("path");

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const mask = (s) => (typeof s === "string" ? s.replace(EMAIL_RE, "[address hidden]") : s);

/* ------------------------------------------------------------------ tables
 * The data behind the dashboard, by name. `dir` is "data" (the refreshed
 * feeds in the repo's data/), "app" (the build's output under APP_DATA_PATH)
 * or "sources". `about` and `grain` go into the system prompt as the
 * catalogue, so the model knows what to ask for without opening each file. */
const TABLES = {
  releases: {
    virtual: true,
    grain: "one row per release on the dashboard (the index the sidebar and Releases list read)",
    about: "Every release the dashboard knows: id (for get_release), releaseName (the key the CSV tables use), artist, title, quarter, type (LE or TL), status (live, upcoming, closed, catalogue), targeted, day/of (campaign day and length), complete, windowEnd (close date), statusPct (gap to expected-today as a share; negative is behind), benchmarkPct, sessions, lastSeen.",
  },
  units_paid: {
    dir: "data", file: "units_paid.csv",
    grain: "release x product x order day x channel",
    about: "Units paid per day and channel (Shopify orders, each on the channel of its purchase event; purchase_event=false means no event was seen, counted on Untracked). The units every card counts (METHODOLOGY 1). Includes private room units and the prints a frame was offered on and frames bought.",
  },
  orders_by_product: {
    dir: "data", file: "orders_by_product.csv",
    grain: "release x product",
    about: "Orders and drafts per product: units paid, refunded, draft orders pending, units from draws, private room units, list price (EUR), frame price, frames bought, first and last order dates (DATA_MODEL 2.4).",
  },
  draw_products: {
    dir: "data", file: "draw_products.csv",
    grain: "release x draw",
    about: "Draws per release with the product each draw sold and its orders and share.",
  },
  spend_daily: {
    dir: "data", file: "spend_daily.csv",
    grain: "Meta campaign (and ad set) x day",
    about: "Paid social spend from Meta: impressions, reach, link clicks, spend (EUR). campaign_name starts with the campaign code (e.g. AndyWarhol_TL_26) that the snapshots carry as campaignCode.",
  },
  content_posts: {
    dir: "data", file: "content_posts.csv",
    grain: "social post or story",
    about: "Emplifi social content per campaign_code: platform, content type (post, story, collaboration), impressions, reach, engagements, likes, comments, shares, saves, views.",
  },
  email_sends: {
    dir: "sources", file: "all_sent_emails.csv",
    grain: "marketing email send",
    about: "HubSpot marketing sends: email name, send date, campaign, delivered, opened, clicked, unsubscribed (counts only).",
  },
  release_clusters: {
    dir: "data", file: "release_clusters.csv",
    grain: "LE release (the benchmark panel)",
    about: "The panel every LE benchmark and basket is drawn from (RELEASE_CLUSTERS.md): per release its dates, mechanic, lifetime and campaign totals (sessions, entries, units), channel-group shares of sessions/entries/units, conversion rates per group, oversubscription, timing shares, cluster, price and edition size. Columns: tot_* campaign totals; sess_share_/ent_share_/unit_share_<group>; conv_sess_entry_/conv_sess_unit_<group>; panel says whether the release is in the draw panel.",
  },
  release_pricing: {
    dir: "data", file: "release_pricing.csv",
    grain: "Airtable product (edition)",
    about: "Airtable's catalogue of editions: artist, title, release, unit price and currency, price bucket, edition size, edition and launch type, launch/announce/private room dates, quarter, medium, artist tier and genre, new or repeat, target and expected sell-through, unit economics (profit per unit, revenue and profit shares), marketing lead and project manager.",
  },
  release_people: {
    dir: "app", file: "release_people.csv",
    grain: "release",
    about: "People per release (counts, no identities): entrants, eligible entrants, winners, won but unpaid, payment failures, buyers, units, draws, returning entrants and buyers, first-time buyers, buyers from the artist's previous releases, and shares of each.",
  },
  release_windows: {
    dir: "app", file: "release_windows.csv",
    grain: "release",
    about: "Each release's campaign window as the build inferred it: announce, close, the rule behind each, sessions and entrants, campaign days.",
  },
  tl_panel: {
    dir: "app", file: "tl_panel.csv",
    grain: "timed launch (TL)",
    about: "The timed-launch panel (TL_SPEC 8): announce, open, close, window hours, signups, sessions, signup-to-order rate, units, orders, buyers, spend before and in the window, cost per signup and per sale, untracked share, edition, price, launch value, and per-channel-group signups, shares and conversion.",
  },
  tl_signups_by_product: {
    dir: "data", file: "tl_signups_by_product.csv",
    grain: "TL release x day x stage x channel x page",
    about: "Timed-launch signups (Pre-Launch or Post-Launch stage) per day and channel, on the release page or a product page, and how many converted.",
  },
  tl_units_hourly: {
    dir: "data", file: "tl_units_hourly.csv",
    grain: "TL release x product x hour x channel x order status",
    about: "Timed-launch units and orders by hour (UTC) and channel, with status (paid, cancelled, refunded, awaiting), private room units, frames and order value (EUR).",
  },
  tl_buyers: {
    dir: "data", file: "tl_buyers.csv",
    grain: "TL release",
    about: "Timed-launch buyers, buyers of more than one piece, and pieces.",
  },
};

const MAX_TABLE_BYTES = 12 * 1024 * 1024;   // the server runs in a small heap; nothing larger is parsed
const CACHE_BYTES = 6 * 1024 * 1024;   // parsed tables kept, by the size of their files

/* RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
const num = (v) => (v === "" || v == null ? null : typeof v === "number" ? v : isNaN(Number(v)) ? null : Number(v));

function createTools({ ROOT, DATA, SOURCES, readSnapshot, docsDir }) {
  const dirOf = { data: path.join(ROOT, "data"), app: DATA, sources: SOURCES || path.join(ROOT, "sources") };
  const cache = new Map();   // name -> { mtime, table }

  const readIndex = () => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8")); } catch { return { asOf: null, releases: [] }; }
  };

  function tableFile(name) {
    const t = TABLES[name];
    if (!t || t.virtual) return null;
    const own = path.join(dirOf[t.dir], t.file);
    if (fs.existsSync(own)) return own;
    // the build's output seeds from the repo; fall back to the repo's copy
    if (t.dir === "app") { const repo = path.join(ROOT, "data", "app", t.file); if (fs.existsSync(repo)) return repo; }
    if (t.dir === "sources") { const repo = path.join(ROOT, "sources", t.file); if (fs.existsSync(repo)) return repo; }
    return null;
  }

  /* a table as { columns, rows (arrays of strings), dropped } */
  function loadTable(name) {
    const t = TABLES[name];
    if (!t) throw new Error(`No table called "${name}". Tables: ${Object.keys(TABLES).join(", ")}.`);
    if (t.virtual) {
      const ix = readIndex();
      const cols = ["id", "releaseName", "artist", "title", "quarter", "type", "status", "targeted", "day", "of", "complete", "windowEnd", "statusPct", "benchmarkPct", "sessions", "lastSeen"];
      return { columns: cols, rows: (ix.releases || []).map((r) => cols.map((c) => (r[c] == null ? "" : String(r[c])))), dropped: [], asOf: ix.asOf };
    }
    const file = tableFile(name);
    if (!file) throw new Error(`The table "${name}" has not been built on this server yet.`);
    const st = fs.statSync(file);
    if (st.size > MAX_TABLE_BYTES) throw new Error(`The table "${name}" is too large to read here.`);
    const hit = cache.get(name);
    if (hit && hit.mtime === st.mtimeMs) { cache.delete(name); cache.set(name, hit); return hit.table; }
    const all = parseCSV(fs.readFileSync(file, "utf8"));
    const header = all.shift() || [];
    // drop any column whose values look like addresses (a guard, not the rule: the tables carry none)
    const keep = [], dropped = [];
    header.forEach((h, ci) => {
      let hits = 0;
      for (let r = 0; r < Math.min(all.length, 2000); r++) { const v = all[r][ci]; if (v && v.includes("@") && EMAIL_RE.test(v)) hits++; EMAIL_RE.lastIndex = 0; }
      if (hits > 0) dropped.push(h); else keep.push(ci);
    });
    // the feeds spell Untracked in lower case too (DATA_MODEL 1.3): one name
    const chan = keep.map((ci) => /^channel$/i.test(header[ci]));
    const table = {
      columns: keep.map((ci) => header[ci]),
      rows: all.map((r) => keep.map((ci, k) => { const v = r[ci] == null ? "" : r[ci]; return chan[k] && v === "untracked" ? "Untracked" : v; })),
      dropped,
    };
    cache.set(name, { mtime: st.mtimeMs, bytes: st.size, table });
    let held = 0;
    for (const v of cache.values()) held += v.bytes;
    while (cache.size > 1 && held > CACHE_BYTES) { const [k, v] = cache.entries().next().value; held -= v.bytes; cache.delete(k); }
    return table;
  }

  /* ---------------------------------------------------------------- list_releases */
  function listReleases({ type, status, search, limit } = {}) {
    const ix = readIndex();
    let rows = ix.releases || [];
    if (type) rows = rows.filter((r) => String(r.type).toUpperCase() === String(type).toUpperCase());
    if (status) rows = rows.filter((r) => r.status === status);
    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter((r) => [r.id, r.releaseName, r.artist, r.title, r.name].some((v) => v && String(v).toLowerCase().includes(s)));
    }
    const total = rows.length;
    const cap = Math.min(Math.max(Number(limit) || 60, 1), 300);
    const pick = (r) => {
      const o = { id: r.id, releaseName: r.releaseName, type: r.type, status: r.status, quarter: r.quarter };
      if (r.targeted) o.targeted = true;
      if (r.windowEnd) o.closes = r.windowEnd;
      if (r.day != null && r.of) o.day = `${r.day}/${r.of}`;
      if (r.statusPct != null) o.statusPct = r.statusPct;
      if (r.sessions) o.sessions = r.sessions;
      return o;
    };
    return { asOf: ix.asOf, total, shown: Math.min(total, cap), releases: rows.slice(0, cap).map(pick) };
  }

  /* ---------------------------------------------------------------- get_release
   * The page applies the Direct display the reader picked (Spread by default)
   * by laying snap.variants.direct_spread over the snapshot, and a line's
   * variant when a release sells two lines (ReleasePage.jsx). The same here,
   * so the figures match what is on screen. */
  function viewOf(snap, display, line) {
    const v = snap.variants || {};
    const spread = display !== "channel";
    if (line && v.lines && v.lines[line]) {
      const lv = (spread && v.lines_direct && v.lines_direct[line]) || v.lines[line];
      return { view: { ...snap, ...lv }, applied: `line ${line}${spread && v.lines_direct && v.lines_direct[line] ? ", Direct spread" : ""}` };
    }
    if (spread && v.direct_spread) return { view: { ...snap, ...v.direct_spread }, applied: "Direct spread (the page's default)" };
    return { view: snap, applied: v.direct_spread ? "Direct as a channel" : "single view (no Direct variant)" };
  }

  const size = (v) => JSON.stringify(v === undefined ? null : v).length;

  function outline(v, depth = 0) {
    if (Array.isArray(v)) {
      const first = v.find((x) => x != null);
      return { array: v.length, of: first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first).slice(0, 30) : typeof first };
    }
    if (v && typeof v === "object") {
      if (depth >= 1) return { keys: Object.keys(v).slice(0, 40), size: size(v) };
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = x && typeof x === "object" ? outline(x, depth + 1) : x;
      return o;
    }
    return v;
  }

  /* cap every array so the subtree fits; returns [value, truncated] */
  function fit(value, budget) {
    if (size(value) <= budget) return [value, false];
    for (const n of [60, 30, 15, 8, 4]) {
      const cap = (x) => (Array.isArray(x) ? x.slice(0, n).map(cap) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cap(y)])) : x);
      const c = cap(value);
      if (size(c) <= budget) return [c, true];
    }
    return [outline(value, 0), true];
  }

  function getField(obj, p) {
    let cur = obj;
    for (const part of String(p).split(".").filter(Boolean)) {
      if (cur == null) return undefined;
      if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
      else if (Array.isArray(cur)) {
        // channels.AA Email -> the element whose name/key/group matches
        cur = cur.find((x) => x && [x.name, x.key, x.group, x.channel, x.title].some((n) => n != null && String(n).toLowerCase() === part.toLowerCase()));
      } else cur = cur[part];
    }
    return cur;
  }

  function getRelease({ id, fields, display, line } = {}) {
    const clean = String(id || "").replace(/[^a-z0-9_]/g, "");
    if (!clean) throw new Error("Give a release id (from list_releases).");
    const snap = readSnapshot(clean);
    if (!snap) {
      const listed = (readIndex().releases || []).some((r) => r.id === clean);
      throw new Error(listed ? `${clean} is listed but its page has not been built yet.` : `No release with id ${clean}; use list_releases to find it.`);
    }
    const { view, applied } = viewOf(snap, display, line);
    delete view.variants;
    delete view.slack;
    const head = { id: snap.id, releaseName: snap.releaseName, type: snap.type, asOf: snap.asOf, display: applied };
    if (Array.isArray(snap.lines) && snap.lines.length) head.lines = snap.lines.map((l) => (l && typeof l === "object" ? { key: l.key, name: l.name || l.label } : l));
    const want = Array.isArray(fields) ? fields.filter(Boolean).slice(0, 12) : [];
    if (!want.length) {
      return { ...head, note: "Outline of the page snapshot: scalars as they are, objects as their keys and size, arrays as their length and element keys. Ask for fields (dot paths, e.g. hero, channels, sellthrough.products, paid.daily) to read them.", outline: outline(view) };
    }
    const out = { ...head, fields: {} };
    const budget = Math.floor(48000 / want.length);
    for (const f of want) {
      const v = getField(view, f);
      if (v === undefined) { out.fields[f] = { missing: true, topLevelKeys: Object.keys(view) }; continue; }
      const [fitted, cut] = fit(v, budget);
      out.fields[f] = cut ? { truncated: "arrays were shortened to fit; ask for a narrower path for the rest", value: fitted } : fitted;
    }
    return out;
  }

  /* ---------------------------------------------------------------- list / describe tables */
  function describeTable({ table, column } = {}) {
    const t = loadTable(table);
    const meta = TABLES[table];
    if (column) {
      const ci = t.columns.indexOf(column);
      if (ci < 0) throw new Error(`No column "${column}" in ${table}. Columns: ${t.columns.join(", ")}`);
      const counts = new Map();
      let n = 0, mn = null, mx = null;
      for (const r of t.rows) {
        const v = r[ci];
        counts.set(v, (counts.get(v) || 0) + 1);
        if (isNum(v)) { const x = Number(v); n++; mn = mn == null || x < mn ? x : mn; mx = mx == null || x > mx ? x : mx; }
        else if (v) { mn = mn == null || v < mn ? v : mn; mx = mx == null || v > mx ? v : mx; }
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([v, c]) => [v, c]);
      return { table, column, rows: t.rows.length, distinct: counts.size, numeric: n, min: mn, max: mx, topValues: top };
    }
    return {
      table, grain: meta.grain, about: meta.about, rows: t.rows.length, columns: t.columns,
      sample: t.rows.slice(0, 3).map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]]))),
      ...(t.dropped.length ? { hiddenColumns: t.dropped } : {}),
    };
  }

  /* ---------------------------------------------------------------- query_table
   * A small, safe query language over one table: filters, an optional
   * group-by (with day/week/month/quarter/year buckets on a date column),
   * metrics, sorting and a row limit. Rows come back as arrays under a
   * header so a large result stays compact. */
  const BUCKETS = {
    day: (s) => s.slice(0, 10),
    month: (s) => s.slice(0, 7),
    year: (s) => s.slice(0, 4),
    quarter: (s) => `${s.slice(0, 4)} Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`,
    week: (s) => {   // the ISO week's Monday
      const d = new Date(s.slice(0, 10) + "T00:00:00Z");
      if (isNaN(d)) return s;
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    },
    hour: (s) => s.slice(0, 13),
  };

  function keyFn(t, spec) {
    const m = /^(day|week|month|quarter|year|hour)\((.+)\)$/.exec(String(spec).trim());
    const col = m ? m[2].trim() : String(spec);
    const ci = t.columns.indexOf(col);
    if (ci < 0) throw new Error(`No column "${col}" in this table. Columns: ${t.columns.join(", ")}`);
    const b = m ? BUCKETS[m[1]] : null;
    return (r) => (b ? (r[ci] ? b(r[ci]) : "") : r[ci]);
  }

  function filterFn(t, f) {
    const ci = t.columns.indexOf(f.column);
    if (ci < 0) throw new Error(`No column "${f.column}" to filter on. Columns: ${t.columns.join(", ")}`);
    const op = f.op || "eq";
    const val = f.value;
    const cmp = (a, b) => (isNum(a) && isNum(b) ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    const lc = (x) => String(x == null ? "" : x).toLowerCase();
    switch (op) {
      case "eq": return (r) => (isNum(r[ci]) && isNum(val) ? Number(r[ci]) === Number(val) : lc(r[ci]) === lc(val));
      case "ne": return (r) => (isNum(r[ci]) && isNum(val) ? Number(r[ci]) !== Number(val) : lc(r[ci]) !== lc(val));
      case "in": { const set = new Set((Array.isArray(val) ? val : [val]).map(lc)); return (r) => set.has(lc(r[ci])); }
      case "not_in": { const set = new Set((Array.isArray(val) ? val : [val]).map(lc)); return (r) => !set.has(lc(r[ci])); }
      case "contains": return (r) => lc(r[ci]).includes(lc(val));
      case "starts_with": return (r) => lc(r[ci]).startsWith(lc(val));
      case "gt": return (r) => r[ci] !== "" && cmp(r[ci], val) > 0;
      case "gte": return (r) => r[ci] !== "" && cmp(r[ci], val) >= 0;
      case "lt": return (r) => r[ci] !== "" && cmp(r[ci], val) < 0;
      case "lte": return (r) => r[ci] !== "" && cmp(r[ci], val) <= 0;
      case "between": {
        if (!Array.isArray(val) || val.length !== 2) throw new Error("between takes [low, high]");
        return (r) => r[ci] !== "" && cmp(r[ci], val[0]) >= 0 && cmp(r[ci], val[1]) <= 0;
      }
      case "is_empty": return (r) => r[ci] === "";
      case "not_empty": return (r) => r[ci] !== "";
      default: throw new Error(`Unknown filter op "${op}"`);
    }
  }

  function metricFn(t, m) {
    const fn = m.fn;
    const col = (c) => { const ci = t.columns.indexOf(c); if (ci < 0) throw new Error(`No column "${c}" for ${fn}. Columns: ${t.columns.join(", ")}`); return ci; };
    const name = m.as || (fn === "count" ? "count" : fn === "ratio" ? `${m.numerator}/${m.denominator}` : `${fn}(${m.column})`);
    if (fn === "count") return { name, init: () => 0, add: (a) => a + 1, done: (a) => a };
    if (fn === "ratio") {
      const a = col(m.numerator), b = col(m.denominator);
      return { name, init: () => [0, 0], add: (s, r) => { s[0] += num(r[a]) || 0; s[1] += num(r[b]) || 0; return s; }, done: (s) => (s[1] ? s[0] / s[1] : null) };
    }
    const ci = col(m.column);
    switch (fn) {
      case "sum": return { name, init: () => 0, add: (s, r) => s + (num(r[ci]) || 0), done: (s) => s };
      case "avg": return { name, init: () => [0, 0], add: (s, r) => { const x = num(r[ci]); if (x != null) { s[0] += x; s[1]++; } return s; }, done: (s) => (s[1] ? s[0] / s[1] : null) };
      case "min": return { name, init: () => null, add: (s, r) => { const v = r[ci]; if (v === "") return s; const x = isNum(v) ? Number(v) : v; return s == null || x < s ? x : s; }, done: (s) => s };
      case "max": return { name, init: () => null, add: (s, r) => { const v = r[ci]; if (v === "") return s; const x = isNum(v) ? Number(v) : v; return s == null || x > s ? x : s; }, done: (s) => s };
      case "median": return { name, init: () => [], add: (s, r) => { const x = num(r[ci]); if (x != null) s.push(x); return s; }, done: (s) => { if (!s.length) return null; s.sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; } };
      case "count_distinct": return { name, init: () => new Set(), add: (s, r) => { if (r[ci] !== "") s.add(r[ci]); return s; }, done: (s) => s.size };
      default: throw new Error(`Unknown metric fn "${fn}"`);
    }
  }

  const round = (v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);

  function queryTable({ table, filters, group_by, metrics, columns, sort, limit } = {}) {
    const t = loadTable(table);
    const fs_ = (Array.isArray(filters) ? filters : []).map((f) => filterFn(t, f));
    const rows = t.rows.filter((r) => fs_.every((f) => f(r)));
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let header, out;
    const groups = Array.isArray(group_by) ? group_by : group_by ? [group_by] : [];
    const ms = Array.isArray(metrics) ? metrics : [];
    if (groups.length || ms.length) {
      const keys = groups.map((g) => keyFn(t, g));
      const mfs = (ms.length ? ms : [{ fn: "count" }]).map((m) => metricFn(t, m));
      const acc = new Map();
      for (const r of rows) {
        const k = keys.map((f) => f(r));
        const id = JSON.stringify(k);
        let a = acc.get(id);
        if (!a) { a = { k, s: mfs.map((m) => m.init()) }; acc.set(id, a); }
        a.s = a.s.map((s, i) => mfs[i].add(s, r));
      }
      header = [...groups.map(String), ...mfs.map((m) => m.name)];
      out = [...acc.values()].map((a) => [...a.k, ...a.s.map((s, i) => round(mfs[i].done(s)))]);
    } else {
      const cols = Array.isArray(columns) && columns.length ? columns : t.columns;
      const idx = cols.map((c) => { const ci = t.columns.indexOf(c); if (ci < 0) throw new Error(`No column "${c}". Columns: ${t.columns.join(", ")}`); return ci; });
      header = cols;
      out = rows.map((r) => idx.map((ci) => (isNum(r[ci]) ? Number(r[ci]) : r[ci])));
    }
    const sorts = Array.isArray(sort) ? sort : sort ? [sort] : [];
    if (sorts.length) {
      const sk = sorts.map((s) => {
        const ci = header.indexOf(s.column);
        if (ci < 0) throw new Error(`Cannot sort on "${s.column}": the result's columns are ${header.join(", ")}`);
        return [ci, s.desc ? -1 : 1];
      });
      out.sort((a, b) => {
        for (const [ci, d] of sk) {
          const x = a[ci], y = b[ci];
          if (x === y) continue;
          if (x === "" || x == null) return 1;
          if (y === "" || y == null) return -1;
          return (typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : 1) * d;
        }
        return 0;
      });
    } else if (groups.length) {
      out.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
    }
    const res = { table, rowsMatched: rows.length, resultRows: out.length, columns: header, rows: out.slice(0, cap).map((r) => r.map(mask)) };
    if (out.length > cap) res.truncated = `showing ${cap} of ${out.length}; narrow the filters, group, or raise limit (max 500)`;
    if (t.asOf) res.asOf = t.asOf;
    return res;
  }

  /* ---------------------------------------------------------------- read_docs */
  const DOCS = [
    ["AGENT_GUIDE", "docs/AGENT_GUIDE.md", "How the dashboard is built, page by page, and where every card's figures come from"],
    ["METHODOLOGY", "docs/METHODOLOGY.md", "Target-setting methodology: the currency, inputs, basket, target model, projections, paid model"],
    ["DATA_MODEL", "docs/DATA_MODEL.md", "Full data model: entities, channel taxonomy, source feeds, benchmarks, actuals, sell-through, framing, paid, metric map, data-quality register"],
    ["BENCHMARK_SPEC", "docs/BENCHMARK_SPEC.md", "Benchmark, target and stretch: baskets, profiles, target maths, snapshot fields, API, drawing grammar"],
    ["TL_SPEC", "docs/TL_SPEC.md", "Timed launches: states, data, signups, sell-through forecast, in-window sales, targets, baskets"],
    ["RELEASE_CLUSTERS", "docs/RELEASE_CLUSTERS.md", "Baskets of comparable LE releases: the panel, features, clusters, repeat artists"],
    ["LINES_PLAN", "docs/LINES_PLAN.md", "A release selling two lines of work on one page"],
    ["BASKET_PROPOSAL", "docs/BASKET_PROPOSAL.md", "Basket proposal: size and price as criteria, estates, no-paid launches"],
    ["README", "README.md", "Operations: layout, refreshing data, BigQuery, sign-in, target setting, timed launches, Slack, what the dashboard shows"],
  ];
  const docCache = new Map();
  const docExists = (n) => { const d = DOCS.find((x) => x[0] === n); return !!d && fs.existsSync(path.join(docsDir || ROOT, d[1])); };
  function docText(name) {
    const d = DOCS.find((x) => x[0] === String(name || "").toUpperCase().replace(/\.MD$/, ""));
    if (!d) throw new Error(`No doc called "${name}". Docs: ${DOCS.map((x) => x[0]).join(", ")}`);
    const file = path.join(docsDir || ROOT, d[1]);
    if (!fs.existsSync(file)) throw new Error(`${d[0]} is not on this server.`);
    const st = fs.statSync(file);
    const hit = docCache.get(d[0]);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const heads = [];
    let fence = false;
    lines.forEach((l, i) => {
      if (/^```/.test(l)) fence = !fence;
      const m = !fence && /^(#{1,4})\s+(.*)$/.exec(l);
      if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i });
    });
    const doc = { name: d[0], lines, heads, mtime: st.mtimeMs };
    docCache.set(d[0], doc);
    return doc;
  }
  function sectionAt(doc, hi) {
    const h = doc.heads[hi];
    const next = doc.heads.slice(hi + 1).find((x) => x.level <= h.level);
    return doc.lines.slice(h.line, next ? next.line : doc.lines.length).join("\n");
  }
  const sectionOf = (doc, line) => { let h = null; for (const x of doc.heads) { if (x.line <= line) h = x; else break; } return h ? h.title : "(top)"; };

  function readDocs({ doc, section, search, part } = {}) {
    if (search) {
      const words = String(search).toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
      if (!words.length) throw new Error("Give search words.");
      const names = doc ? [docText(doc).name] : DOCS.map((d) => d[0]).filter(docExists);
      const hits = [];
      for (const n of names) {
        const d = docText(n);
        d.lines.forEach((l, i) => {
          const low = l.toLowerCase();
          const score = words.filter((w) => low.includes(w)).length;
          if (score) hits.push({ doc: n, section: sectionOf(d, i), line: i + 1, score, text: l.trim().slice(0, 240) });
        });
      }
      hits.sort((a, b) => b.score - a.score);
      return { search, hits: hits.slice(0, 25).map(({ score, ...h }) => h), more: Math.max(0, hits.length - 25), hint: "Read a section with read_docs({doc, section})." };
    }
    if (!doc) return { docs: DOCS.filter(([n]) => docExists(n)).map(([n, , about]) => ({ doc: n, about, sections: docText(n).heads.length })) };
    const d = docText(doc);
    if (!section) return { doc: d.name, outline: d.heads.map((h) => `${"  ".repeat(h.level - 1)}${h.title}`) };
    const s = String(section).toLowerCase().trim();
    let hi = d.heads.findIndex((h) => h.title.toLowerCase() === s);
    if (hi < 0) hi = d.heads.findIndex((h) => h.title.toLowerCase().startsWith(s + " ") || h.title.toLowerCase().startsWith(s + ".") || h.title.toLowerCase().startsWith(s));
    if (hi < 0) hi = d.heads.findIndex((h) => h.title.toLowerCase().includes(s));
    if (hi < 0) throw new Error(`No section matching "${section}" in ${d.name}. Call read_docs({doc:"${d.name}"}) for the outline.`);
    const text = sectionAt(d, hi);
    const CH = 30000;
    const parts = Math.max(1, Math.ceil(text.length / CH));
    const p = Math.min(Math.max(Number(part) || 1, 1), parts);
    return { doc: d.name, section: d.heads[hi].title, part: p, parts, text: mask(text.slice((p - 1) * CH, p * CH)), ...(parts > p ? { more: `call again with part ${p + 1}` } : {}) };
  }

  /* ---------------------------------------------------------------- make_chart
   * Validates a chart the model wants drawn in the chat; the browser draws it
   * with the dashboard's own chart components (web/src/AgentChart.jsx). */
  const CHART_TYPES = ["line", "bar", "stacked_bar", "hbar", "scatter"];
  const STYLES = ["actual", "target", "benchmark", "projection", "comparison", "positive", "negative"];
  const FORMATS = ["number", "percent", "euro", "units"];
  function makeChart(spec = {}) {
    const type = spec.type;
    if (!CHART_TYPES.includes(type)) throw new Error(`type must be one of ${CHART_TYPES.join(", ")}`);
    const title = String(spec.title || "").slice(0, 120);
    if (!title) throw new Error("Give the chart a title.");
    const finite = (v) => v === null || (typeof v === "number" && isFinite(v));
    const out = { type, title, subtitle: spec.subtitle ? String(spec.subtitle).slice(0, 200) : undefined, source: spec.source ? String(spec.source).slice(0, 200) : undefined,
      format: FORMATS.includes(spec.format) ? spec.format : "number", x_label: spec.x_label ? String(spec.x_label).slice(0, 60) : undefined, y_label: spec.y_label ? String(spec.y_label).slice(0, 60) : undefined };
    if (type === "scatter") {
      const pts = Array.isArray(spec.points) ? spec.points : [];
      if (pts.length < 2 || pts.length > 500) throw new Error("A scatter needs 2 to 500 points: [{x, y, label}].");
      for (const p of pts) if (!finite(p.x) || !finite(p.y) || p.x == null || p.y == null) throw new Error("Every point needs numeric x and y.");
      out.points = pts.map((p) => ({ x: p.x, y: p.y, label: p.label ? String(p.label).slice(0, 80) : undefined, group: p.group ? String(p.group).slice(0, 40) : undefined }));
      out.x_format = FORMATS.includes(spec.x_format) ? spec.x_format : "number";
      return out;
    }
    const x = Array.isArray(spec.x) ? spec.x.map((v) => String(v).slice(0, 40)) : [];
    if (!x.length || x.length > 400) throw new Error("x needs 1 to 400 category labels (dates, names).");
    const series = Array.isArray(spec.series) ? spec.series : [];
    if (!series.length || series.length > 8) throw new Error("Give 1 to 8 series: [{name, values, style}].");
    out.x = x;
    out.series = series.map((s, i) => {
      const values = Array.isArray(s.values) ? s.values : [];
      if (values.length !== x.length) throw new Error(`Series ${i + 1} has ${values.length} values for ${x.length} x labels.`);
      if (!values.every(finite)) throw new Error(`Series ${i + 1} has a value that is not a number or null.`);
      return { name: String(s.name || `Series ${i + 1}`).slice(0, 60), values, style: STYLES.includes(s.style) ? s.style : undefined };
    });
    if (type === "hbar" && x.length > 40) throw new Error("A horizontal bar chart takes at most 40 rows; show the top ones.");
    return out;
  }

  return { listReleases, getRelease, describeTable, queryTable, readDocs, makeChart, loadTable, docText, docExists, TABLES, DOCS, readIndex };
}

/* The tool definitions the model sees. Kept in a fixed order with fixed text
 * so the prompt cache holds across requests. */
const TOOL_DEFS = [
  {
    name: "list_releases",
    description: "List the dashboard's releases from its index (newest first): id, releaseName, type, status, quarter, close date, campaign day, statusPct. Use it to find a release's id for get_release or its releaseName for filtering tables.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Part of an artist, title or id" },
        type: { type: "string", enum: ["LE", "TL"] },
        status: { type: "string", enum: ["live", "upcoming", "closed", "catalogue"] },
        limit: { type: "integer", description: "Default 60, max 300" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_release",
    description: "Read a release's page snapshot: the exact figures its dashboard page shows. With no fields it returns an outline (top-level scalars plus the shape of each block); then ask for the blocks you need by dot path, e.g. [\"hero\", \"channels\", \"sellthrough\", \"paid.daily\"]. An array element can be picked by index or by its name (channels.Paid). The reader's Direct display is applied by default so figures match their screen.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Release id, e.g. warhol_le_26" },
        fields: { type: "array", items: { type: "string" }, description: "Dot paths to read (up to 12)" },
        display: { type: "string", enum: ["spread", "channel"], description: "Direct display; omit to use the reader's" },
        line: { type: "string", description: "A line key, for a release selling two lines" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_table",
    description: "Describe a data table: its grain, columns, row count and three sample rows; or, with column, that column's distinct values, counts and range. Use before querying a table you have not used in this conversation.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name from the catalogue" },
        column: { type: "string" },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
  {
    name: "query_table",
    description: "Query one data table. Filter rows, optionally group them (group_by columns, or day(col), week(col), month(col), quarter(col), year(col), hour(col) to bucket a date column) and aggregate with metrics; or, without group_by and metrics, return raw rows (choose columns). Sort and limit the result (default 100 rows, max 500). Text matching is case-insensitive. Example: {table:\"units_paid\", filters:[{column:\"release\", op:\"contains\", value:\"Warhol\"}], group_by:[\"channel\"], metrics:[{fn:\"sum\", column:\"units_paid\"}], sort:[{column:\"sum(units_paid)\", desc:true}]}",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "ne", "in", "not_in", "contains", "starts_with", "gt", "gte", "lt", "lte", "between", "is_empty", "not_empty"] },
              value: { description: "A string or number; an array for in, not_in and between" },
            },
            required: ["column", "op"],
          },
        },
        group_by: { type: "array", items: { type: "string" } },
        metrics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fn: { type: "string", enum: ["sum", "avg", "min", "max", "median", "count", "count_distinct", "ratio"] },
              column: { type: "string" },
              numerator: { type: "string", description: "ratio only: sum(numerator) / sum(denominator)" },
              denominator: { type: "string" },
              as: { type: "string", description: "A name for the result column" },
            },
            required: ["fn"],
          },
        },
        columns: { type: "array", items: { type: "string" }, description: "Raw rows only: the columns to return" },
        sort: { type: "array", items: { type: "object", properties: { column: { type: "string" }, desc: { type: "boolean" } }, required: ["column"] } },
        limit: { type: "integer" },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
  {
    name: "read_docs",
    description: "Read the project's documentation. With nothing: the list of docs. With doc: its outline. With doc and section (a heading or its number, e.g. \"6.3\" or \"Sell-through prediction\"): that section's text. With search: matching lines across the docs (or one doc) with their section. Read the relevant section before explaining how a figure is worked out.",
    input_schema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "AGENT_GUIDE, METHODOLOGY, DATA_MODEL, BENCHMARK_SPEC, TL_SPEC, RELEASE_CLUSTERS, LINES_PLAN, BASKET_PROPOSAL or README" },
        section: { type: "string" },
        search: { type: "string" },
        part: { type: "integer", description: "For a long section, the part to read" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "make_chart",
    description: "Draw a chart in the chat with the dashboard's chart style. Only the chat shows it: the dashboard itself is never changed. Types: line (a series over time), bar (grouped columns), stacked_bar, hbar (a ranking, up to 40 rows), scatter (points with x, y, label). Give every value from a tool result in this conversation. The result names a marker such as [[chart-1]]: put it on its own line in your answer where the chart belongs.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["line", "bar", "stacked_bar", "hbar", "scatter"] },
        title: { type: "string" },
        subtitle: { type: "string", description: "Unit and window, e.g. \"Units paid per day, 3-30 Sep 2026\"" },
        x: { type: "array", items: { type: "string" }, description: "Category labels (dates, names); not for scatter" },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              values: { type: "array", items: { type: ["number", "null"] } },
              style: { type: "string", enum: ["actual", "target", "benchmark", "projection", "comparison", "positive", "negative"], description: "Colours it as the dashboard does: actual indigo, target grey, benchmark dotted, projection dashed" },
            },
            required: ["name", "values"],
          },
        },
        points: {
          type: "array",
          items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, label: { type: "string" }, group: { type: "string" } }, required: ["x", "y"] },
          description: "Scatter only",
        },
        format: { type: "string", enum: ["number", "percent", "euro", "units"], description: "How y values read (percent takes fractions, 0.25 = 25%)" },
        x_format: { type: "string", enum: ["number", "percent", "euro", "units"], description: "Scatter only" },
        x_label: { type: "string" },
        y_label: { type: "string" },
        source: { type: "string", description: "Where the numbers came from, e.g. \"units_paid table\"" },
      },
      required: ["type", "title"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

module.exports = { createTools, TOOL_DEFS, TABLES, parseCSV, mask };
