/* The connector (server/mcp/index.js): the MCP endpoint a Claude outside the
 * dashboard reads the data through. Runs the route on a local port with a
 * stand-in for BigQuery, so no key and no network are needed: it is off
 * without a token and closed without the right one, it speaks the protocol
 * (initialize, notifications, tools/list, tools/call, batches, errors), the
 * Agent's read-only tools answer on the committed data and make_chart is not
 * offered, the SQL tool runs one SELECT with its limits and refuses anything
 * else, addresses and the columns that name a person never come back, and it
 * sits ahead of the session gate without opening anything else. Then the
 * limits query() gained for it, on a stubbed fetch.  node tests/mcp.mjs */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data", "app");
const express = require("express");
const mcp = require("../server/mcp/index.js");
const { TOOL_DEFS } = require("../server/agent/tools.js");

const TOKEN = "test-token-0123456789abcdefghij";
const readSnapshot = (id) => {
  const f = path.join(DATA, "releases", `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};

/* a stand-in for server/bigquery.js: records what the SQL tool asked for and
 * hands back whatever the test set up */
class PiiDetected extends Error {}
function fakeBq() {
  const bq = {
    PROJECT: "proj", DATASET: "ds", PiiDetected, calls: [], configuredValue: { client_email: "x" },
    KNOWN_TABLES: ["LE_Funnel_Report", "Collector_Concept", "Gone_Table"],
    header: ["year", "channel", "units", "share", "ok"],
    fields: [{ name: "year", type: "INTEGER" }, { name: "channel", type: "STRING" }, { name: "units", type: "INTEGER" }, { name: "share", type: "FLOAT" }, { name: "ok", type: "BOOLEAN" }],
    rows: [["2024", "AA Meta", "590", "0.042", "true"], ["2024", "write to jo.bloggs@example.com", "", "", "false"]],
    total: 2, fail: null,
    configured() { return this.configuredValue; },
    async query(token, sql, params, o) {
      this.calls.push({ token, sql, o });
      if (this.fail) throw this.fail;
      o.onHeader(this.header, this.fields);
      const rows = this.rows.slice(0, o.maxRows);
      o.onRows(rows);
      return { header: this.header, rows: rows.length, total: this.total, truncated: rows.length < this.total, bytes: 4.2e8, cached: false };
    },
    async tableInfo(token, name) {
      if (/gone/i.test(name)) throw new Error(`No table ds.${name} that this service account can read`);
      const cols = /collector/i.test(name)
        ? [["aa_account_id", "STRING"], ["email", "STRING"], ["phone_number", "STRING"], ["country", "STRING"]]
        : [["event_date", "DATE"], ["order_pieces", "INTEGER"]];
      return { project: "proj", dataset: "ds", id: name.split(".").pop(), type: "TABLE", rows: 10, modified: "2026-11-09", partitioned: false,
        columns: cols.map(([n, type]) => ({ name: n, type })), address: cols.map((c) => c[0]).filter((n) => n === "email") };
    },
  };
  return bq;
}

async function serve(opts, { gate = true } = {}) {
  const app = express();
  app.use(express.json());
  const lines = [];
  const bq = opts.bq || fakeBq();
  const handle = mcp.install(app, { ROOT, DATA, readSnapshot, bq, accessToken: async () => "bq-token", log: (l) => lines.push(l), ...opts });
  if (gate) {   // the session gate as server/auth.js closes the rest: 401 under /api, the sign-in page otherwise
    app.use((req, res) => (req.path.startsWith("/api/") ? res.status(401).json({ error: "not signed in" }) : res.redirect("/login")));
  }
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const post = (body, headers = { Authorization: `Bearer ${TOKEN}` }) => fetch(`${base}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const rpc = async (method, params, headers) => {
    const res = await post({ jsonrpc: "2.0", id: ++id, method, params }, headers);
    return { status: res.status, type: res.headers.get("content-type") || "", json: await res.json() };
  };
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    assert.strictEqual(r.status, 200);
    const result = r.json.result;
    assert.ok(result && Array.isArray(result.content) && result.content[0].type === "text", `${name}: a text result`);
    return { isError: result.isError, text: result.content[0].text };
  };
  return { base, post, rpc, call, bq, lines, handle, close: () => new Promise((r) => server.close(r)) };
}

// ---- off until a token is set, and a short one does not count
for (const token of ["", "short-token"]) {
  const off = await serve({ token });
  assert.strictEqual(off.handle.enabled, false);
  assert.strictEqual((await off.post({ jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, "off: the route answers 404, token or no token");
  assert.strictEqual((await off.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: `Bearer ${token}` })).status, 404);
  // and the OAuth lookups are left to the gate, as they were before the connector existed
  assert.strictEqual((await fetch(`${off.base}/.well-known/oauth-authorization-server`, { redirect: "manual" })).status, 302);
  await off.close();
}

const s = await serve({ token: TOKEN });
assert.strictEqual(s.handle.enabled, true);

// ---- the token: none, a wrong one, the right one either way
for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: `Basic ${TOKEN}` }, { "X-API-Key": TOKEN + "x" }]) {
  const res = await s.post({ jsonrpc: "2.0", id: 1, method: "ping" }, headers);
  assert.strictEqual(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /^Bearer/);
  assert.strictEqual((await res.json()).error.code, -32001);
}
assert.deepStrictEqual((await s.rpc("ping")).json.result, {});
assert.deepStrictEqual((await s.rpc("ping", undefined, { "X-API-Key": TOKEN })).json.result, {});
// GET (a server-sent stream) and DELETE (a session) are not offered
for (const method of ["GET", "DELETE"]) {
  const res = await fetch(`${s.base}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.strictEqual(res.status, 405);
  assert.strictEqual(res.headers.get("allow"), "POST");
}
// the gate still closes everything else, and an OAuth lookup finds nothing rather than the sign-in page
assert.strictEqual((await fetch(`${s.base}/api/index`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 401);
assert.strictEqual((await fetch(`${s.base}/.well-known/oauth-protected-resource/mcp`, { redirect: "manual" })).status, 404);
assert.strictEqual((await fetch(`${s.base}/.well-known/oauth-authorization-server`, { redirect: "manual" })).status, 404);

// ---- initialize: the version asked for when known, the newest otherwise
const init = await s.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
assert.match(init.type, /application\/json/);
assert.strictEqual(init.json.result.protocolVersion, "2025-03-26");
assert.deepStrictEqual(init.json.result.capabilities, { tools: { listChanged: false } });
assert.strictEqual(init.json.result.serverInfo.name, mcp.SERVER.name);
assert.match(init.json.result.instructions, /start_here/);
assert.strictEqual((await s.rpc("initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, mcp.PROTOCOLS[0]);
// a notification is acknowledged with no body
const note = await s.post({ jsonrpc: "2.0", method: "notifications/initialized" });
assert.strictEqual(note.status, 202);
assert.strictEqual(await note.text(), "");
// a version header this server does not know is refused; a known one is fine
assert.strictEqual((await s.rpc("ping", undefined, { Authorization: `Bearer ${TOKEN}`, "MCP-Protocol-Version": "1999-01-01" })).status, 400);
assert.strictEqual((await s.rpc("ping", undefined, { Authorization: `Bearer ${TOKEN}`, "MCP-Protocol-Version": "2025-06-18" })).status, 200);

// ---- tools/list: the Agent's read-only tools and the connector's three, never the chart
const list = (await s.rpc("tools/list")).json.result.tools;
assert.deepStrictEqual(list.map((t) => t.name), ["start_here", "list_releases", "get_release", "describe_table", "query_table", "read_docs", "bigquery_tables", "bigquery_sql"]);
for (const t of list) {
  assert.strictEqual(t.inputSchema.type, "object", `${t.name}: an object schema`);
  assert.ok(t.description.length > 40 && t.title, `${t.name}: described`);
  assert.deepStrictEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
}
// the Agent's own definitions are untouched by the connector's wording (its prompt cache rests on them)
assert.match(TOOL_DEFS.find((t) => t.name === "get_release").description, /The reader's Direct display/);
assert.doesNotMatch(list.find((t) => t.name === "get_release").description, /reader/);
assert.match(list.find((t) => t.name === "describe_table").description, /units_paid/);

// ---- the guide, and the Agent's tools on the committed data
const guide = await s.call("start_here", {});
assert.ok(!guide.isError);
assert.match(guide.text, /^Today is \d{4}-\d{2}-\d{2}\./);
for (const needle of ["## 2. Which tool", "LE_Funnel_Report", "AA_session_custom_channel_group_split_touch", "- units_paid (", "- METHODOLOGY:"]) {
  assert.ok(guide.text.includes(needle), `the guide carries ${needle}`);
}
assert.ok(!guide.text.includes(String.fromCharCode(8212)), "no em dash in the guide");
const releases = JSON.parse((await s.call("list_releases", { search: "warhol" })).text);
assert.ok(JSON.stringify(releases).includes("warhol_le_26"));
const page = JSON.parse((await s.call("get_release", { id: "warhol_le_26", fields: ["hero"] })).text);
assert.match(page.display, /^Direct spread/, "the page's default display, with no reader to ask");
assert.ok(page.fields.hero);
const byChannel = JSON.parse((await s.call("query_table", { table: "units_paid", filters: [{ column: "release", op: "contains", value: "warhol" }], group_by: ["channel"], metrics: [{ fn: "sum", column: "units_paid" }] })).text);
assert.ok(byChannel.rows.length > 1);
assert.ok(JSON.parse((await s.call("read_docs", {})).text));
// a mistake in a call comes back as a result the model can read, not a protocol error
const wrong = await s.call("query_table", { table: "nope" });
assert.strictEqual(wrong.isError, true);
assert.match(wrong.text, /^Error: No table/);
// the chart tool and an unknown tool are not there; an unknown method says so
assert.strictEqual((await s.rpc("tools/call", { name: "make_chart", arguments: {} })).json.error.code, -32602);
assert.strictEqual((await s.rpc("tools/call", { name: "nope" })).json.error.code, -32602);
assert.strictEqual((await s.rpc("resources/list")).json.error.code, -32601);

// ---- the SQL tool: one SELECT, with its limits, typed, masked
const out = await s.call("bigquery_sql", { sql: "SELECT year, channel, units FROM `proj.ds.t`;" });
assert.ok(!out.isError, out.text);
const res = JSON.parse(out.text);
assert.deepStrictEqual(res.columns, ["year", "channel", "units", "share", "ok"]);
assert.deepStrictEqual(res.rows[0], [2024, "AA Meta", 590, 0.042, true]);
assert.deepStrictEqual(res.rows[1], [2024, "write to [address hidden]", null, null, false]);
assert.strictEqual(res.rowsReturned, 2);
assert.match(res.scanned, /^0\.42 GB$/);
assert.strictEqual(res.truncated, undefined);
const asked = s.bq.calls.at(-1);
assert.strictEqual(asked.token, "bq-token");
assert.strictEqual(asked.sql, "SELECT year, channel, units FROM `proj.ds.t`", "the trailing semicolon is dropped");
assert.strictEqual(asked.o.maxRows, 200);
assert.strictEqual(asked.o.maxBytesBilled, 10e9);
assert.strictEqual(asked.o.maxWaitMs, 90000);
// the row cap: asked for, bounded, and said when it cut
await s.call("bigquery_sql", { sql: "SELECT 1", max_rows: 5000 });
assert.strictEqual(s.bq.calls.at(-1).o.maxRows, 1000);
s.bq.total = 50;
const cut = JSON.parse((await s.call("bigquery_sql", { sql: "SELECT 1", max_rows: 1 })).text);
assert.strictEqual(cut.rowsReturned, 1);
assert.strictEqual(cut.rowsInResult, 50);
assert.match(cut.truncated, /Showing 1 of 50 rows/);
s.bq.total = 2;
// anything but one read-only statement never reaches BigQuery
const before = s.bq.calls.length;
for (const sql of ["DELETE FROM `proj.ds.t` WHERE true", "SELECT 1; DROP TABLE `proj.ds.t`", "CREATE TABLE x AS SELECT 1", "EXPORT DATA OPTIONS() AS SELECT 1", "", "/* SELECT */ UPDATE t SET a = 1"]) {
  const r = await s.call("bigquery_sql", { sql });
  assert.strictEqual(r.isError, true, sql);
}
assert.strictEqual(s.bq.calls.length, before);
assert.doesNotThrow(() => mcp.checkSql("WITH a AS (SELECT ';' AS x) -- done;\nSELECT * FROM a"));
assert.doesNotThrow(() => mcp.checkSql("(SELECT 1) UNION ALL (SELECT 2)"));
// an address column is refused by the client; a column that names a person by the connector
s.bq.fail = new PiiDetected('column "user_email" looks like an email address field');
const pii = await s.call("bigquery_sql", { sql: "SELECT * FROM `proj.ds.t`" });
assert.strictEqual(pii.isError, true);
assert.match(pii.text, /does not leave BigQuery through this connector/);
assert.ok(!pii.text.includes("@"));
s.bq.fail = null;
// a result that carries a person's column under its own name (a SELECT * does) is refused when its header arrives
s.bq.header = ["aa_account_id", "phone_number"]; s.bq.fields = [{ name: "aa_account_id", type: "STRING" }, { name: "phone_number", type: "STRING" }];
const named = await s.call("bigquery_sql", { sql: "SELECT * FROM `proj.ds.Collector_Concept`" });
assert.strictEqual(named.isError, true);
assert.match(named.text, /names people \(phone_number\)/);
// and a query that names one never runs, alias or no alias, quoted or not: an alias cannot carry a name out
const ran = s.bq.calls.length;
for (const sql of ["SELECT aa_account_first_name AS anything FROM `proj.ds.Collector_Concept`", "SELECT `phone_number` x FROM `proj.ds.Collector_Concept`",
  "SELECT TO_HEX(SHA256(user_email)) AS k FROM `proj.ds.t`", "SELECT COUNT(DISTINCT c.email) AS n FROM `proj.ds.Collector_Concept` c"]) {
  const r = await s.call("bigquery_sql", { sql });
  assert.strictEqual(r.isError, true, sql);
  assert.match(r.text, /reads columns that identify a person \((aa_account_first_name|phone_number|user_email|email)\)/);
}
assert.strictEqual(s.bq.calls.length, ran);
// the words in a string, a comment or a longer name are not the columns
assert.deepStrictEqual(mcp.personalRead("SELECT 'AA Email Man' AS email_channel, hs_email_optout_Global -- phone_number\nFROM t WHERE ch = 'email'"), []);
assert.deepStrictEqual(mcp.personalRead("SELECT `email`, Phone_Number FROM t"), ["email", "phone_number"]);
// a count by account is the way through
s.bq.header = ["country", "collectors"]; s.bq.fields = [{ name: "country", type: "STRING" }, { name: "collectors", type: "INTEGER" }];
s.bq.rows = [["GB", "12"]]; s.bq.total = 1;
assert.deepStrictEqual(JSON.parse((await s.call("bigquery_sql", { sql: "SELECT country, COUNT(DISTINCT aa_account_id) AS collectors FROM `proj.ds.Collector_Concept` GROUP BY 1" })).text).rows, [["GB", 12]]);
// BigQuery's own refusals read as something to act on; an unconfigured server says so
s.bq.fail = new Error("BigQuery 400: Query exceeded limit for bytes billed: 10000000000. 20000000000 or higher required.");
assert.match((await s.call("bigquery_sql", { sql: "SELECT 1" })).text, /would scan more than 10 GB/);
s.bq.fail = new Error("BigQuery 400: Unrecognized name: nope at [1:8]");
assert.match((await s.call("bigquery_sql", { sql: "SELECT nope" })).text, /^Error: BigQuery 400: Unrecognized name: nope/);
s.bq.fail = null;
s.bq.configuredValue = null;
assert.match((await s.call("bigquery_sql", { sql: "SELECT 1" })).text, /not configured/);
assert.match((await s.call("bigquery_tables", {})).text, /not configured/);
s.bq.configuredValue = { client_email: "x" };

// ---- the tables: the known ones by name, one that is not granted says so, a person's columns are flagged
const tables = JSON.parse((await s.call("bigquery_tables", {})).text);
assert.deepStrictEqual(tables.tables.map((t) => t.table), ["ds.LE_Funnel_Report", "ds.Collector_Concept", "Gone_Table"]);
assert.match(tables.tables[2].error, /No table/);
const collector = JSON.parse((await s.call("bigquery_tables", { table: "ds.Collector_Concept" })).text);
assert.strictEqual(collector.table, "proj.ds.Collector_Concept");
assert.deepStrictEqual(collector.neverReturn, ["email", "phone_number"]);
assert.ok(collector.columns.includes("country STRING"));
assert.strictEqual(JSON.parse((await s.call("bigquery_tables", { table: "LE_Funnel_Report" })).text).neverReturn, undefined);
assert.strictEqual((await s.call("bigquery_tables", { table: "Gone_Table" })).isError, true);

// ---- the wire: a batch, a body that is not JSON, a message that is not JSON-RPC
const batch = await (await s.post([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "tools/list" }])).json();
assert.deepStrictEqual(batch.map((m) => m.id), ["a", "b"]);
const bad = await s.post("{not json");
assert.strictEqual(bad.status, 400);
assert.strictEqual((await bad.json()).error.code, -32700);
const notRpc = await s.post({ hello: "there" });
assert.strictEqual(notRpc.status, 400);
assert.strictEqual((await notRpc.json()).error.code, -32600);

// ---- the log: the tool, the rows, the time; never the query, the token or a value
assert.ok(s.lines.some((l) => /^mcp: bigquery_sql ok rows=2\/2 gb=0\.42 chars=\d+ ms=\d+$/.test(l)), s.lines.join("\n"));
for (const kind of ["address-refused", "person-refused", "over-bytes", "sql-refused", "bigquery-refused"]) {
  assert.ok(s.lines.some((l) => new RegExp(`^mcp: bigquery_sql error ${kind} ms=\\d+$`).test(l)), `${kind} is logged by its kind`);
}
assert.ok(!s.lines.some((l) => /SELECT|proj\.ds|jo\.bloggs|test-token/i.test(l)), "nothing asked or answered is logged");
await s.close();

// ---- the rate limit is the whole connector's
const limited = await serve({ token: TOKEN, ratePerMin: 3 });
const statuses = [];
for (let i = 0; i < 5; i++) statuses.push((await limited.rpc("ping")).status);
assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
await limited.close();

// ---- the server installs it ahead of the session gate, and nowhere else
const index = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
const at = index.indexOf('require("./mcp").install(app');
assert.ok(at > 0 && at < index.indexOf("auth.install(app)"), "the connector is registered before the gate");
assert.ok(at > index.indexOf("app.use(express.json())"), "and after the body parser");

// ---- query()'s limits (server/bigquery.js), on a stubbed fetch
const bqReal = require("../server/bigquery.js");
const realFetch = globalThis.fetch;
function stubBigQuery({ pages, total, complete = true }) {
  const seen = { posts: [], gets: [] };
  globalThis.fetch = async (url, init = {}) => {
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (init.method === "POST") {
      seen.posts.push(JSON.parse(init.body));
      return json({ jobReference: { jobId: "j1" }, jobComplete: complete, totalBytesProcessed: "1000", cacheHit: false, totalRows: String(total),
        schema: { fields: [{ name: "n", type: "INTEGER" }] }, rows: complete ? pages[0] : undefined, pageToken: complete && pages.length > 1 ? "p1" : undefined });
    }
    seen.gets.push(String(url));
    const m = /pageToken=p(\d+)/.exec(String(url));
    if (!m) return json({ jobComplete: false });
    const i = Number(m[1]);
    return json({ rows: pages[i], pageToken: i + 1 < pages.length ? `p${i + 1}` : undefined });
  };
  return seen;
}
const rowsOf = (from, n) => Array.from({ length: n }, (_, i) => ({ f: [{ v: String(from + i) }] }));
try {
  // no limits: every page, as before, and no cap sent to BigQuery
  let seen = stubBigQuery({ pages: [rowsOf(0, 3), rowsOf(3, 3), rowsOf(6, 1)], total: 7 });
  let got = [], fields = null;
  let r = await bqReal.query("tok", "SELECT n", {}, { pageRows: 3, onHeader: (h, f) => { fields = f; }, onRows: (rows) => got.push(...rows) });
  assert.strictEqual(got.length, 7);
  assert.deepStrictEqual({ rows: r.rows, total: r.total, truncated: r.truncated }, { rows: 7, total: 7, truncated: false });
  assert.strictEqual(seen.posts[0].maximumBytesBilled, undefined);
  assert.strictEqual(seen.posts[0].timeoutMs, 120000);
  assert.deepStrictEqual(fields, [{ name: "n", type: "INTEGER" }], "the header's types reach a caller that asks");
  // a row cap: stops paging, says it cut, and asks BigQuery for no more than it will hand on
  seen = stubBigQuery({ pages: [rowsOf(0, 3), rowsOf(3, 3), rowsOf(6, 1)], total: 7 });
  got = [];
  r = await bqReal.query("tok", "SELECT n", {}, { pageRows: 3, maxRows: 4, maxBytesBilled: 5e9, maxWaitMs: 30000, onRows: (rows) => got.push(...rows) });
  assert.deepStrictEqual(got.map((x) => x[0]), ["0", "1", "2", "3"]);
  assert.deepStrictEqual({ rows: r.rows, total: r.total, truncated: r.truncated }, { rows: 4, total: 7, truncated: true });
  assert.strictEqual(seen.posts[0].maximumBytesBilled, "5000000000");
  assert.strictEqual(seen.posts[0].timeoutMs, 30000);
  assert.strictEqual(seen.gets.length, 1, "one more page, not the rest");
  assert.match(seen.gets[0], /maxResults=1&/);
  // a result that runs short without a cap is still an error, as it was
  stubBigQuery({ pages: [rowsOf(0, 3)], total: 9 });
  await assert.rejects(() => bqReal.query("tok", "SELECT n", {}, { pageRows: 3 }), /paging stopped early: 3 of 9/);
  // a job that does not finish in the time allowed gives up there
  stubBigQuery({ pages: [[]], total: 0, complete: false });
  await assert.rejects(() => bqReal.query("tok", "SELECT n", {}, { maxWaitMs: 20 }), /did not finish within 0 seconds/);
  // a table by name: a bad name never leaves, a refusal reads as "not one this account can read"
  await assert.rejects(() => bqReal.tableInfo("tok", "a b; drop"), /is not a table name/);
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Access Denied" } }) });
  await assert.rejects(() => bqReal.tableInfo("tok", "Some_Table"), /No table \w+\.Some_Table that this service account can read/);
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ type: "TABLE", numRows: "5", lastModifiedTime: "1794182400000",
    schema: { fields: [{ name: "user_email", type: "STRING" }, { name: "tags", type: "STRING", mode: "REPEATED" }] }, url }) });
  const info = await bqReal.tableInfo("tok", "`proj.other_ds.T1`");
  assert.deepStrictEqual({ dataset: info.dataset, id: info.id, rows: info.rows, address: info.address }, { dataset: "other_ds", id: "T1", rows: 5, address: ["user_email"] });
  assert.deepStrictEqual(info.columns[1], { name: "tags", type: "STRING[]" });
} finally {
  globalThis.fetch = realFetch;
}

console.log("mcp: ok");
