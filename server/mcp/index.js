/* The connector: the dashboard's data as an MCP server, so a Claude outside
 * the dashboard (claude.ai, Claude Code) can answer questions on it.
 *
 * POST /mcp speaks the Model Context Protocol over Streamable HTTP, the
 * simplest shape of it: every request is answered in the response body as
 * JSON, there is no server-sent stream and no session, so the service keeps no
 * state between calls. The tools are the Agent's read-only ones
 * (server/agent/tools.js: the releases, a release's page, the dashboard's
 * tables, the docs) plus three of its own:
 *   start_here       the guide a Claude reads first (docs/CONNECTOR_GUIDE.md)
 *   bigquery_tables  what the service account can see: tables and columns, never a row
 *   bigquery_sql     one read-only query on BigQuery, through the guarded client
 * Nothing here writes: there is no path from a tool to the saved inputs, the
 * targets or any other state, and the BigQuery token is read-only by scope.
 *
 * Switched off until MCP_TOKEN is set (the route answers 404). With it set,
 * every request must carry the token, as "Authorization: Bearer <token>" or
 * "X-API-Key: <token>": one shared credential, entered once on the connector
 * (README, "The connector"). The route sits before the session gate, since a
 * Claude has no browser session; the token is what lets a request in.
 *
 * Personal data: bigquery_sql runs through server/bigquery.js's query(), which
 * refuses a result with an address column, and every cell is masked for an
 * address-shaped value on the way out, as the Agent's tools do. The log line
 * names the tool, the rows, the bytes and the time; never the question, the
 * query, the result or the token.
 *
 *   MCP_TOKEN            the shared token; at least 24 characters; unset = off
 *   MCP_RATE_PER_MIN     requests a minute across everyone, default 120
 *   MCP_SQL_MAX_GB       the most one query may scan, default 10
 *   MCP_SQL_WAIT_S       how long a query may run, default 90
 *   MCP_SQL_CONCURRENCY  queries running at once, default 3 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createTools, TOOL_DEFS, mask } = require("../agent/tools");

const SERVER = { name: "avant-arte-launch-bi", title: "Avant Arte launch data", version: "1.0.0" };
// newest first: the version answered when a client asks for one this server does not know
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "Avant Arte's launch data, read-only: every release's dashboard page, the tables behind the dashboard, " +
  "the project's documentation, and BigQuery (the event-level funnel, orders and ad spend, back to 2019). " +
  "Call start_here once before the first question: it says which tool answers which kind of question, names the tables and columns, " +
  "and lists the caveats that change answers. Aggregate in the query and report counts, not people.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MAX_SQL_CHARS = 20000;
const MAX_RESULT_CHARS = 60000;    // a tool result past this is cut at a row boundary and says so
const DEFAULT_ROWS = 200, MAX_ROWS = 1000;

/* Columns that identify a person. Two checks, both against accidents rather
 * than intent (whoever holds the token reads what the service account reads):
 * a query that names one of the READ columns is refused before it runs, so an
 * alias cannot carry a name or a number out; and a result that carries a
 * PERSONAL column under its own name (a SELECT * does that) is refused when
 * its header arrives. The address itself is also refused by query(), by
 * column name and by the shape of a cell. A person inside a query is
 * aa_account_id. */
const PERSONAL_NAMES = ["aa_account_name", "aa_account_first_name", "aa_account_username", "phone_number", "aa_account_date_of_birth",
  "instagram_handle", "discord_username", "linkedin_profile", "web3_wallet_address", "web3_signature", "shopify_order_note"];
const ADDRESS_NAMES = ["user_email", "shopify_customer_email", "email"];
const PERSONAL_COLUMN = new RegExp(`^(${[...PERSONAL_NAMES, "notes", "shopify_order_name", "user_pseudo_id"].join("|")})$`, "i");
const PERSONAL_READ = new RegExp(`\\b(${[...PERSONAL_NAMES, ...ADDRESS_NAMES].join("|")})\\b`, "gi");
/* the personal columns a query names, outside its strings and comments */
function personalRead(sql) {
  const found = bareSql(String(sql || ""), true).match(PERSONAL_READ) || [];
  return [...new Set(found.map((c) => c.toLowerCase()))];
}

const rpcError = (code, message) => Object.assign(new Error(message), { rpc: code });
const posNum = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/* A query with its comments, string literals and quoted names blanked out, so
 * the checks below read the statement and not what is written inside a string. */
function bareSql(sql, keepNames = false) {
  let out = "", i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], two = sql.slice(i, i + 2), three = sql.slice(i, i + 3);
    if (two === "--" || c === "#") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (two === "/*") { const end = sql.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; out += " "; continue; }
    if (three === "'''" || three === '"""') { const end = sql.indexOf(three, i + 3); i = end < 0 ? n : end + 3; out += "''"; continue; }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n && sql[j] !== c) j += sql[j] === "\\" ? 2 : 1;
      out += c !== "`" ? "''" : keepNames ? ` ${sql.slice(i + 1, j)} ` : "x";
      i = Math.min(n, j + 1); continue;
    }
    out += c; i++;
  }
  return out;
}

/* One read-only statement: a SELECT, or a WITH that ends in one. BigQuery has
 * no data-modifying CTE, so a statement that opens this way cannot write; the
 * token's read-only scope is the second fence. */
function checkSql(sql) {
  const refuse = (message) => { throw Object.assign(new Error(message), { kind: "sql-refused" }); };
  if (typeof sql !== "string" || !sql.trim()) refuse("Give the query as sql.");
  if (sql.length > MAX_SQL_CHARS) refuse(`That query is over ${MAX_SQL_CHARS.toLocaleString("en-GB")} characters - narrow it.`);
  const stmt = bareSql(sql).trim().replace(/;\s*$/, "");
  if (stmt.includes(";")) refuse("One statement at a time: remove the semicolon and what follows it.");
  if (!/^\(*\s*(select|with)\b/i.test(stmt)) refuse("Only a SELECT (or a WITH ... SELECT) runs here: this connector reads, it does not change anything.");
  return sql.trim().replace(/;\s*$/, "");
}

/* A cell as BigQuery typed it: numbers as numbers where they are safe ones,
 * booleans as booleans, NULL as null, text masked for an address. */
function typedCell(v, type) {
  if (v === "" || v === null || v === undefined) return type === "STRING" ? (v === "" ? "" : null) : null;
  const t = String(type || "").toUpperCase();
  if (t === "INTEGER" || t === "INT64") { const n = Number(v); return Number.isSafeInteger(n) ? n : String(v); }
  if (t === "FLOAT" || t === "FLOAT64" || t === "NUMERIC" || t === "BIGNUMERIC") { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
  if (t === "BOOLEAN" || t === "BOOL") return v === true || v === "true";
  if (typeof v === "object") return mask(JSON.stringify(v));   // a RECORD or an ARRAY, as BigQuery nests it
  return mask(String(v));
}

function install(app, opts = {}) {
  const { ROOT, DATA, SOURCES, readSnapshot } = opts;
  const TOKEN = String(opts.token !== undefined ? opts.token : process.env.MCP_TOKEN || "").trim();
  const bq = opts.bq || require("../bigquery");
  const accessToken = opts.accessToken || require("../googleAuth").accessToken;
  const RATE = posNum(opts.ratePerMin !== undefined ? opts.ratePerMin : process.env.MCP_RATE_PER_MIN, 120);
  const MAX_BYTES = posNum(process.env.MCP_SQL_MAX_GB, 10) * 1e9;
  const WAIT_MS = posNum(process.env.MCP_SQL_WAIT_S, 90) * 1000;
  const CONCURRENCY = posNum(process.env.MCP_SQL_CONCURRENCY, 3);
  const log = opts.log || ((line) => console.log(line));

  if (TOKEN && TOKEN.length < 24) {
    console.warn("mcp: MCP_TOKEN is shorter than 24 characters - the connector stays off until it is longer");
  }
  const enabled = TOKEN.length >= 24;
  const tools = createTools({ ROOT, DATA, SOURCES, readSnapshot });

  // ------------------------------------------------------------ the tools
  const fromAgent = (name, patch = {}) => {
    const d = TOOL_DEFS.find((t) => t.name === name);
    const schema = JSON.parse(JSON.stringify(d.input_schema));
    if (patch.schema) patch.schema(schema);
    return { name, title: patch.title, description: patch.description || d.description, inputSchema: schema, annotations: READ_ONLY };
  };
  const tableNames = Object.keys(tools.TABLES).join(", ");
  const TOOLS = [
    {
      name: "start_here", title: "Start here",
      description: "Read this first, once per conversation. The guide to this connector: what the data is, which tool answers which kind of question, the BigQuery tables and their columns, the channel groups, how Untracked and Direct are read, worked queries, and the caveats that change answers (channel attribution only starts in late 2022, part periods, funnel units against units paid).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
    },
    fromAgent("list_releases", { title: "List releases" }),
    fromAgent("get_release", {
      title: "Read a release's page",
      description: "Read a release's page snapshot: the exact figures its dashboard page shows. With no fields it returns an outline (top-level scalars plus the shape of each block); then ask for the blocks you need by dot path, e.g. [\"hero\", \"channels\", \"sellthrough\", \"paid.daily\"]. An array element can be picked by index or by its name (channels.Paid). Direct is spread over the other channels by default, as the page shows it; pass display \"channel\" to read Direct as a channel of its own.",
      schema: (s) => { s.properties.display.description = "Direct display: spread (the default, as the page shows it) or channel"; },
    }),
    fromAgent("describe_table", {
      title: "Describe a dashboard table",
      description: `Describe one of the dashboard's own tables (the aggregates its pages are built from, not BigQuery): its grain, columns, row count and three sample rows; or, with column, that column's distinct values, counts and range. Use before querying a table you have not used in this conversation. Tables: ${tableNames}.`,
      schema: (s) => { s.properties.table.description = `One of: ${tableNames}`; },
    }),
    fromAgent("query_table", { title: "Query a dashboard table" }),
    fromAgent("read_docs", { title: "Read the documentation" }),
    {
      name: "bigquery_tables", title: "List BigQuery tables and columns",
      description: "What BigQuery holds for bigquery_sql. With no arguments: the tables the dashboard is built on (kind, rows, last modified, number of columns). With table: that table's columns and their types, and which of them identify a person. Names only, never a row. Kept for an hour; refresh reads again.",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", description: "A table name, e.g. LE_Funnel_Report (or dataset.table)" },
          refresh: { type: "boolean", description: "Read again instead of the hour's copy" },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
    },
    {
      name: "bigquery_sql", title: "Query BigQuery",
      description: `Run one read-only GoogleSQL query on BigQuery and get the rows back. For what the dashboard's tables cannot answer: the whole history, the event level, questions by person or by launch. One SELECT (or WITH ... SELECT); name tables in full, in backticks, e.g. \`${bq.PROJECT || "avantarte-data-production"}.${bq.DATASET || "AA_company_tables"}.LE_Funnel_Report\`. Aggregate in the query and return counts, not rows of people: a result with an email address column is refused. Up to max_rows rows come back (default ${DEFAULT_ROWS}, at most ${MAX_ROWS}); one query may scan up to ${Math.round(MAX_BYTES / 1e9)} GB and run for ${Math.round(WAIT_MS / 1000)} seconds. start_here has the tables, the columns and worked examples.`,
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "One SELECT or WITH statement in GoogleSQL" },
          max_rows: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: `Rows to return, default ${DEFAULT_ROWS}` },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
    },
  ];

  // ------------------------------------------------------------ start_here
  const GUIDE = path.join(ROOT, "docs", "CONNECTOR_GUIDE.md");
  let guide = { mtime: 0, text: "" };
  function startHere() {
    let text = "(The guide is not on this server.)";
    try {
      const st = fs.statSync(GUIDE);
      if (st.mtimeMs !== guide.mtime) guide = { mtime: st.mtimeMs, text: fs.readFileSync(GUIDE, "utf8") };
      text = guide.text;
    } catch { /* said above */ }
    const ix = tools.readIndex();
    const catalogue = Object.entries(tools.TABLES).map(([name, t]) => `- ${name} (${t.grain}): ${t.about}`).join("\n");
    const docs = tools.DOCS.filter(([n]) => tools.docExists(n)).map(([n, , about]) => `- ${n}: ${about}`).join("\n");
    return [
      `Today is ${new Date().toISOString().slice(0, 10)}. The dashboard's data runs to ${ix.asOf || "an unknown date"}; BigQuery is live.`,
      text.trim(),
      "## The dashboard's tables (describe_table, query_table)\n\n" + catalogue,
      "## The documents (read_docs)\n\n" + docs,
    ].join("\n\n");
  }

  // ------------------------------------------------------------ BigQuery
  // a table's columns for an hour: the tables are described by name (bq.tableInfo), since
  // the account is granted tables one by one and cannot list the dataset
  const described = new Map();
  async function describe(token, name, refresh) {
    const key = String(name).toLowerCase();
    const hit = described.get(key);
    if (!refresh && hit && Date.now() - hit.at < 3600 * 1000) return hit.info;
    const info = await bq.tableInfo(token, name);
    described.set(key, { at: Date.now(), info });
    return info;
  }
  async function bigqueryTables({ table, refresh } = {}) {
    const sa = bq.configured();
    if (!sa) throw new Error("BigQuery is not configured on this server.");
    const token = await accessToken(sa, "bigquery");
    if (table) {
      const t = await describe(token, table, !!refresh);
      const personal = t.columns.map((c) => c.name).filter((n) => PERSONAL_COLUMN.test(n) && !t.address.includes(n));
      return {
        table: `${t.project}.${t.dataset}.${t.id}`, kind: t.type, rows: t.rows, modified: t.modified,
        scan: t.partitioned ? "partitioned: filter on the partition column" : "not partitioned: a query scans every row of the columns it names, so name only the columns it needs",
        columns: t.columns.map((c) => `${c.name} ${c.type}`),
        neverReturn: t.address.length || personal.length ? [...t.address, ...personal] : undefined,
        note: t.address.length || personal.length ? "The neverReturn columns identify a person: use them inside a query to count or join if you must, never in its result." : undefined,
      };
    }
    const tables = await Promise.all(bq.KNOWN_TABLES.map(async (name) => {
      try {
        const t = await describe(token, name, !!refresh);
        return { table: `${t.dataset}.${t.id}`, kind: t.type, rows: t.rows, modified: t.modified, columns: t.columns.length };
      } catch (e) {
        return { table: name, error: mask(String(e.message || e)).slice(0, 160) };
      }
    }));
    return {
      project: bq.PROJECT, tables,
      next: "Call bigquery_tables with table for a table's columns. A table not listed here can be described by name too, if the connector has been granted it.",
    };
  }

  let running = 0;
  async function bigquerySql({ sql, max_rows: maxRows } = {}) {
    const text = checkSql(sql);
    const reads = personalRead(text);
    if (reads.length) {
      throw Object.assign(new Error(`That query reads columns that identify a person (${reads.join(", ")}). This connector reports counts, not people: join and count on aa_account_id, and leave those columns out.`), { kind: "person-refused" });
    }
    const sa = bq.configured();
    if (!sa) throw new Error("BigQuery is not configured on this server.");
    if (running >= CONCURRENCY) throw new Error("Several queries are already running - try again in a few seconds.");
    const cap = Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(maxRows)) || DEFAULT_ROWS));
    let header = [], types = [], size = 0, cut = false;
    const rows = [];
    running += 1;
    let r;
    try {
      const token = await accessToken(sa, "bigquery");
      r = await bq.query(token, text, {}, {
        pageRows: Math.min(1000, cap), maxRows: cap, maxBytesBilled: MAX_BYTES, maxWaitMs: WAIT_MS,
        onHeader: (h, fields) => {
          const personal = h.filter((c) => PERSONAL_COLUMN.test(c));
          if (personal.length) throw Object.assign(new Error(personal.join(", ")), { personal: true });
          header = h; types = (fields || []).map((f) => (f.mode === "REPEATED" ? "ARRAY" : f.type));
        },
        onRows: (page) => {
          for (const raw of page) {
            if (cut) return;
            const row = raw.map((v, i) => typedCell(v, types[i]));
            size += JSON.stringify(row).length + 1;
            if (size > MAX_RESULT_CHARS && rows.length) { cut = true; return; }
            rows.push(row);
          }
        },
      });
    } catch (e) {
      if (e instanceof bq.PiiDetected) {
        throw Object.assign(new Error("That result has an email address column or value, which does not leave BigQuery through this connector. Count or group instead (under a column name that is not an email field), or join on aa_account_id and leave the address out."), { kind: "address-refused" });
      }
      if (e && e.personal) {
        throw Object.assign(new Error(`That result names people (${e.message}). This connector reports counts, not people: count or group instead, and leave those columns out of the result.`), { kind: "person-refused" });
      }
      const m = String(e.message || e);
      if (/bytes billed|bytesBilledLimitExceeded|exceeded limit for bytes billed/i.test(m)) {
        throw Object.assign(new Error(`That query would scan more than ${Math.round(MAX_BYTES / 1e9)} GB. Select fewer columns or a narrower date range.`), { kind: "over-bytes" });
      }
      if (e && !e.kind && /^BigQuery \d/.test(m)) e.kind = "bigquery-refused";   // a mistake in the SQL, as BigQuery words it
      throw e;
    } finally {
      running -= 1;
    }
    const total = Number.isFinite(r.total) ? r.total : rows.length;
    const out = {
      columns: header, rows, rowsReturned: rows.length, rowsInResult: total,
      scanned: `${(r.bytes / 1e9).toFixed(2)} GB${r.cached ? " (cached)" : ""}`,
    };
    if (rows.length < total) out.truncated = `Showing ${rows.length} of ${total} rows: aggregate further, add a filter or an ORDER BY with LIMIT, or raise max_rows (to ${MAX_ROWS} at most).`;
    return { out, stats: `rows=${rows.length}/${total} gb=${(r.bytes / 1e9).toFixed(2)}${r.cached ? " cached" : ""}` };
  }

  async function run(name, input) {
    const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    switch (name) {
      case "start_here": return { out: startHere() };
      case "list_releases": return { out: tools.listReleases(i) };
      case "get_release": return { out: tools.getRelease(i) };
      case "describe_table": return { out: tools.describeTable(i) };
      case "query_table": return { out: tools.queryTable(i) };
      case "read_docs": return { out: tools.readDocs(i) };
      case "bigquery_tables": return { out: await bigqueryTables(i) };
      case "bigquery_sql": return bigquerySql(i);
      default: throw rpcError(-32602, `Unknown tool: ${name}`);
    }
  }

  async function callTool(params) {
    const name = params && typeof params.name === "string" ? params.name : "";
    if (!TOOLS.some((t) => t.name === name)) throw rpcError(-32602, `Unknown tool: ${name || "(none)"}`);
    const started = Date.now();
    try {
      const { out, stats } = await run(name, params.arguments);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      log(`mcp: ${name} ok ${stats ? stats + " " : ""}chars=${text.length} ms=${Date.now() - started}`);
      return { content: [{ type: "text", text }], isError: false };
    } catch (e) {
      if (e && e.rpc) throw e;
      // a mistake in the call or a refusal from BigQuery: the model reads it and tries again
      const message = mask(String((e && e.message) || e)).replace(/\s+/g, " ").slice(0, 1500);
      // why, in a word (a refusal's kind, else the error's class): never the message, which can quote the query
      log(`mcp: ${name} error ${(e && e.kind) || (e && e.constructor && e.constructor.name) || "Error"} ms=${Date.now() - started}`);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const asked = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        };
      }
      case "ping": return {};
      case "tools/list": return { tools: TOOLS };
      case "tools/call": return callTool(params || {});
      default: throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  // ------------------------------------------------------------ the route
  const given = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    return (m ? m[1] : req.get("x-api-key") || "").trim();
  };
  const digest = (s) => crypto.createHash("sha256").update(s).digest();
  const authed = (req) => { const g = given(req); return !!g && crypto.timingSafeEqual(digest(g), digest(TOKEN)); };

  let windowStart = 0, inWindow = 0;
  const allow = () => {
    const now = Date.now();
    if (now - windowStart >= 60000) { windowStart = now; inWindow = 0; }
    inWindow += 1;
    return inWindow <= RATE;
  };
  const fail = (res, status, code, message) => res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

  app.all("/mcp", async (req, res) => {
    if (!enabled) return res.status(404).json({ error: "not found" });
    if (!authed(req)) {
      res.set("WWW-Authenticate", 'Bearer realm="mcp"');
      return fail(res, 401, -32001, "Unauthorized: send the connector's token as \"Authorization: Bearer <token>\".");
    }
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return fail(res, 405, -32000, "Method not allowed: this server answers POST only (no server-sent stream, no sessions).");
    }
    if (!allow()) {
      res.set("Retry-After", "30");
      return fail(res, 429, -32000, "Too many requests - try again in a minute.");
    }
    const version = req.get("mcp-protocol-version");
    if (version && !PROTOCOLS.includes(version)) return fail(res, 400, -32600, `Unsupported MCP-Protocol-Version: ${String(version).slice(0, 40)}`);
    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length || messages.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0")) {
      return fail(res, 400, -32600, "Invalid Request: expected a JSON-RPC 2.0 message.");
    }
    const replies = [];
    for (const m of messages) {
      if (typeof m.method !== "string") continue;                 // a response from the client: nothing to answer
      const wantsReply = m.id !== undefined && m.id !== null;     // a notification carries no id
      if (!wantsReply) continue;                                  // notifications/initialized, cancelled: acknowledged below
      try {
        replies.push({ jsonrpc: "2.0", id: m.id, result: await dispatch(m.method, m.params) });
      } catch (e) {
        const code = e && e.rpc ? e.rpc : -32603;
        if (!(e && e.rpc)) log(`mcp: ${m.method} failed ${(e && e.constructor && e.constructor.name) || "Error"}`);
        replies.push({ jsonrpc: "2.0", id: m.id, error: { code, message: e && e.rpc ? e.message : "Internal error" } });
      }
    }
    if (!replies.length) return res.status(202).end();
    res.status(200).type("application/json").send(JSON.stringify(batch ? replies : replies[0]));
  });
  // a body that is not JSON reaches here from express.json(), ahead of the route
  app.use("/mcp", (err, _req, res, next) => {
    if (!enabled) return next(err);
    if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) return fail(res, 400, -32700, "Parse error: the body is not JSON.");
    if (err && err.type === "entity.too.large") return fail(res, 413, -32600, "Request too large.");
    return next(err);
  });
  // a client looking for an OAuth server finds none, as JSON, instead of the sign-in page
  if (enabled) {
    app.get(/^\/\.well-known\/(oauth-|openid-configuration)/, (_req, res) => res.status(404).json({ error: "not found" }));
    log(`mcp: the connector is on at /mcp (${TOOLS.length} tools)`);
  }

  return { enabled, TOOLS, dispatch };
}

module.exports = { install, checkSql, bareSql, personalRead, typedCell, PROTOCOLS, SERVER, PERSONAL_COLUMN };
