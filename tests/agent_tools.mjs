/* The Agent's read-only tools (server/agent/tools.js) on the committed data:
 * the page view matches what the page shows (Direct spread by default), the
 * query language filters, groups, buckets and sorts, address-shaped values
 * never come back, the docs reader finds sections, and charts are checked
 * before the chat draws them. No API key needed.  node tests/agent_tools.mjs */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createTools, TOOL_DEFS, parseCSV, mask } = require("../server/agent/tools.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data", "app");
const readSnapshot = (id) => {
  const f = path.join(DATA, "releases", `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const t = createTools({ ROOT, DATA, readSnapshot });

// CSV: quotes, doubled quotes, commas and newlines inside quotes
assert.deepStrictEqual(parseCSV('a,b\n"x, y","he said ""hi"""\n"two\nlines",3\n'), [["a", "b"], ["x, y", 'he said "hi"'], ["two\nlines", "3"]]);
assert.strictEqual(mask("write to jo.bloggs@example.com today"), "write to [address hidden] today");

// get_release: the page's view - the Direct spread variant laid over the snapshot unless the reader picked Channel
const snap = readSnapshot("warhol_le_26");
const spread = t.getRelease({ id: "warhol_le_26", fields: ["channels", "hero"] });
assert.deepStrictEqual(spread.fields.channels, snap.variants.direct_spread.channels);
const channel = t.getRelease({ id: "warhol_le_26", fields: ["channels"], display: "channel" });
assert.deepStrictEqual(channel.fields.channels, snap.channels);
assert.notDeepStrictEqual(spread.fields.channels, channel.fields.channels);
// a block the variant does not carry reads the snapshot's own
assert.deepStrictEqual(spread.fields.hero, snap.hero);
// an array element by name; a missing field says so; the outline is small
assert.strictEqual(t.getRelease({ id: "warhol_le_26", fields: ["channels.Paid"] }).fields["channels.Paid"].key, "paid");
assert.ok(t.getRelease({ id: "warhol_le_26", fields: ["nope"] }).fields.nope.missing);
assert.ok(JSON.stringify(t.getRelease({ id: "warhol_le_26" })).length < 20000);
assert.throws(() => t.getRelease({ id: "no_such_release" }), /No release/);

// get_release for the connector: the plan-based view where the page has one, and the saved target settings, read only
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bi-settings-"));
  const app = path.join(tmp, "data", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "index.json"), JSON.stringify({ asOf: "2026-11-25", releases: [{ id: "a_le_26" }, { id: "b_le_26" }, { id: "c_le_26" }] }));
  fs.writeFileSync(path.join(app, "inputs.json"), JSON.stringify({ releases: { b_le_26: { id: "b_le_26", announce_date: "2026-11-01" } }, discovered: { c_le_26: { release_name: "C" } } }));
  fs.writeFileSync(path.join(tmp, "data", "inputs.saved.json"), JSON.stringify({ releases: { a_le_26: { id: "a_le_26", campaign_code: "A_LE_26", products: [{ airtable_id: "1", excluded: true }] } } }));
  const pages = {
    a_le_26: { id: "a_le_26", type: "LE", hero: { projected: 74 }, variants: { direct_spread: { hero: { projected: 75 } }, plan: { hero: { projected: 36 }, plan: { lands: 36 }, method: "plan" } } },
    b_le_26: { id: "b_le_26", type: "LE", hero: { projected: 10 }, variants: { direct_spread: { hero: { projected: 11 } } } },
    c_le_26: { id: "c_le_26", type: "LE", hero: { projected: 5 } },
  };
  const before = process.env.SAVED_INPUTS_PATH;
  delete process.env.SAVED_INPUTS_PATH;
  const u = createTools({ ROOT: tmp, DATA: app, readSnapshot: (id) => (pages[id] ? JSON.parse(JSON.stringify(pages[id])) : null) });
  const plan = u.getRelease({ id: "a_le_26", fields: ["hero", "plan"], targets_from: "plan" });
  assert.match(plan.display, /plan-based view/);
  assert.deepStrictEqual([plan.fields.hero.projected, plan.fields.plan.lands], [36, 36]);
  assert.strictEqual(u.getRelease({ id: "a_le_26", fields: ["hero"] }).fields.hero.projected, 75, "the clock's page stays the default");
  const none = u.getRelease({ id: "b_le_26", fields: ["hero"], targets_from: "plan" });
  assert.match(none.display, /no plan-based view/);
  assert.strictEqual(none.fields.hero.projected, 11);
  assert.strictEqual(u.getRelease({ id: "a_le_26", fields: ["hero"] }).settings, undefined, "settings only when asked for");
  const saved = u.getRelease({ id: "a_le_26", fields: ["hero"], settings: true }).settings;
  assert.match(saved.from, /saved on the Target setting tab/);
  assert.strictEqual(saved.inputs.products[0].excluded, true);
  assert.match(u.getRelease({ id: "b_le_26", settings: true }).settings.from, /repository's defaults/);
  const bare = u.getRelease({ id: "c_le_26", settings: true }).settings;
  assert.match(bare.from, /nothing saved/);
  assert.strictEqual(bare.inputs.release_name, "C");
  if (before !== undefined) process.env.SAVED_INPUTS_PATH = before;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// query_table: group and sum agree with a straight sum; untracked is one channel
const byChannel = t.queryTable({ table: "units_paid", filters: [{ column: "release", op: "contains", value: "warhol" }], group_by: ["channel"], metrics: [{ fn: "sum", column: "units_paid" }], sort: [{ column: "sum(units_paid)", desc: true }] });
const raw = t.queryTable({ table: "units_paid", filters: [{ column: "release", op: "contains", value: "warhol" }], columns: ["units_paid"], limit: 500 });
assert.strictEqual(byChannel.rows.reduce((a, r) => a + r[1], 0), t.queryTable({ table: "units_paid", filters: [{ column: "release", op: "contains", value: "warhol" }], metrics: [{ fn: "sum", column: "units_paid" }] }).rows[0][0]);
assert.ok(raw.rowsMatched > 0);
assert.ok(!byChannel.rows.some((r) => r[0] === "untracked"));
for (let i = 1; i < byChannel.rows.length; i++) assert.ok(byChannel.rows[i - 1][1] >= byChannel.rows[i][1]);
// buckets and ratios
const monthly = t.queryTable({ table: "spend_daily", group_by: ["month(spend_date)"], metrics: [{ fn: "sum", column: "spend" }, { fn: "ratio", numerator: "spend", denominator: "link_clicks", as: "cpc" }], limit: 500 });
assert.ok(monthly.rows.every((r) => /^\d{4}-\d{2}$/.test(r[0])));
assert.deepStrictEqual(monthly.columns, ["month(spend_date)", "sum(spend)", "cpc"]);
const weekly = t.queryTable({ table: "spend_daily", filters: [{ column: "spend_date", op: "between", value: ["2026-09-01", "2026-09-30"] }], group_by: ["week(spend_date)"], metrics: [{ fn: "count" }] });
assert.ok(weekly.rows.every((r) => new Date(r[0] + "T00:00:00Z").getUTCDay() === 1));
// the index as a table
assert.ok(t.queryTable({ table: "releases", filters: [{ column: "id", op: "eq", value: "warhol_le_26" }] }).rows.length === 1);
// mistakes come back as messages the model can act on
assert.throws(() => t.queryTable({ table: "nope" }), /No table/);
assert.throws(() => t.queryTable({ table: "units_paid", group_by: ["nope"] }), /No column "nope"/);

// address-shaped columns are dropped from any table
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
fs.mkdirSync(path.join(tmp, "data"));
fs.writeFileSync(path.join(tmp, "data", "units_paid.csv"), "release,contact,units_paid\nA,jo@example.com,2\nB,,3\n");
const t2 = createTools({ ROOT: tmp, DATA: path.join(tmp, "data", "app"), readSnapshot: () => null });
const d = t2.describeTable({ table: "units_paid" });
assert.deepStrictEqual(d.columns, ["release", "units_paid"]);
assert.deepStrictEqual(d.hiddenColumns, ["contact"]);
assert.ok(!JSON.stringify(t2.queryTable({ table: "units_paid" })).includes("@"));
fs.rmSync(tmp, { recursive: true });

// read_docs: list, outline, a section by number, search
assert.ok(t.readDocs({}).docs.some((x) => x.doc === "AGENT_GUIDE"));
assert.ok(t.readDocs({ doc: "DATA_MODEL" }).outline.length > 20);
assert.match(t.readDocs({ doc: "DATA_MODEL", section: "6.4" }).section, /^6\.4/);
assert.ok(t.readDocs({ search: "secured units" }).hits.length > 0);
assert.throws(() => t.readDocs({ doc: "DATA_MODEL", section: "no such heading at all" }), /No section/);

// make_chart: checked before drawing
assert.strictEqual(t.makeChart({ type: "line", title: "x", x: ["a", "b"], series: [{ name: "s", values: [1, null] }] }).series[0].values[1], null);
assert.throws(() => t.makeChart({ type: "line", title: "x", x: ["a"], series: [{ name: "s", values: [1, 2] }] }), /values for 1 x labels/);
assert.throws(() => t.makeChart({ type: "pie", title: "x" }), /type must be/);
assert.throws(() => t.makeChart({ type: "scatter", title: "x", points: [{ x: 1 }] }), /scatter/);

// nothing the model can call writes: the six tools, all readers or the chat's chart
assert.deepStrictEqual(TOOL_DEFS.map((x) => x.name), ["list_releases", "get_release", "describe_table", "query_table", "read_docs", "make_chart"]);
assert.ok(!/writeFile|appendFile|unlink|rename|mkdir/.test(fs.readFileSync(path.join(ROOT, "server", "agent", "tools.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));

console.log("agent tools: ok");
