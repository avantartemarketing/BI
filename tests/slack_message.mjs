/* The Slack sell-through update as Block Kit - a three-column table of the
 * products, figures only - composed from a synthetic snapshot and the real
 * ones on disk, checked block by block.
 *   node tests/slack_message.mjs [--print]   (--print shows the real ones as text) */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { composeSellThroughBlocks, shortNames } = require(path.join(here, "..", "server", "slack.js"));
const print = process.argv.includes("--print");
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const cellText = (c) => (c.type === "raw_text" ? c.text : c.elements.map((s) => s.elements.map((e) => e.text).join("")).join(""));
const parts = (blocks) => ({
  header: blocks.find((b) => b.type === "header"),
  section: blocks.find((b) => b.type === "section"),
  table: blocks.find((b) => b.type === "table"),
  contexts: blocks.filter((b) => b.type === "context").map((b) => b.elements.map((e) => e.text).join(" ")),
});
/* the message as lines, for --print and for the eye */
const asText = ({ blocks }) => {
  const p = parts(blocks);
  return [p.header.text.text, p.section.text.text,
    ...p.table.rows.map((r) => r.map(cellText).join("  ")), ...p.contexts].join("\n");
};

// names lose what they share
check(JSON.stringify(shortNames(["Untitled (White on White)", "Untitled (Black on Black)"])) === JSON.stringify(["White on White", "Black on Black"]), "bracketed titles");
check(JSON.stringify(shortNames(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"])) === JSON.stringify(["Green Landscape", "Lifesize"]), "brillo titles");
check(JSON.stringify(shortNames(["Castles Burning (For Neil Young) I", "Castles Burning (For Neil Young) II", "Castles Burning (For Neil Young) III"])) === JSON.stringify(["I", "II", "III"]), "numbered prints");
check(JSON.stringify(shortNames(["Red", "Blue"])) === JSON.stringify(["Red", "Blue"]), "short unrelated names stay");
check(JSON.stringify(shortNames(["Only one"])) === JSON.stringify(["Only one"]), "a single name stays");

// a synthetic release, mid-campaign
const snap = {
  id: "test_le_26", releaseName: "Test Artist · Multiple · 2026 Q3", asOf: "2026-09-17", completeThrough: "2026-09-17", day: 11, of: 24,
  economics: { framingAvailable: true, frameConversion: 0.35 },
  framing: { prints: 94, frames: 40, rate: 0.4255, entrants: { prints: 30, frames: 20, rate: 0.6667 }, plan: 0.35, benchmark: null, works: [], notOffered: { units: 0, works: [] } },
  sellthrough: {
    edition: 600, sold: 94, drafts: 5, soldPredicted: 27.2, futureEntriesPredicted: 60, pct: 0.31, conversion: 0.8, incomplete: [],
    products: [
      { name: "Castles Burning (For Neil Young) I", edition: 200, sold: 46, soldAssumed: 0, drafts: 2, shown: 14.4, futurePredicted: 20, pct: 0.312, pctClose: 0.412 },
      { name: "Castles Burning (For Neil Young) II", edition: 200, sold: 32, soldAssumed: 0, drafts: 1, shown: 7.2, futurePredicted: 20, pct: 0.201, pctClose: 0.301 },
      { name: "Castles Burning (For Neil Young) III", edition: 200, sold: 16, soldAssumed: 0, drafts: 2, shown: 5.6, futurePredicted: 20, pct: 0.118, pctClose: 0.218 },
    ],
  },
};
const today = composeSellThroughBlocks(snap, { today: "2026-09-17" });
{
  const { header, section, table, contexts } = parts(today.blocks);
  check(today.blocks.map((b) => b.type).join(" ") === "header section table context", `the blocks: ${today.blocks.map((b) => b.type).join(" ")}`);
  check(header.text.type === "plain_text" && header.text.text === "Test Artist · Multiple · 2026 Q3", `header: ${header.text.text}`);
  const lines = section.text.text.split("\n");
  check(lines[0] === "*Sell-through by product · 21% of 600 units* · day 11 of 24 · data through 17 Sep", `headline: ${lines[0]}`);
  check(lines[1] === "Framing conversion *43%* · 40 frames on 94 prints sold · plan 35%", `framing from the orders: ${lines[1]}`);
  check(table.column_settings.length === 3 && table.column_settings[0].is_wrapped === true && table.column_settings[2].align === "right",
    "three columns: the name may wrap on a phone, the figures sit right");
  check(table.rows.length === 4 && table.rows[0].map(cellText).join("|") === "Product|Units|Sold", `the header row: ${table.rows[0].map(cellText).join("|")}`);
  const row = table.rows[1].map(cellText);
  check(row[0] === "I" && table.rows[3].map(cellText)[0] === "III", `short names in the rows: ${row[0]}`);
  check(row.length === 3 && row[1] === "62 of 200" && row[2] === "31%", `units and share, nothing else: ${row.join(" | ")}`);
  check(table.rows[1][2].type === "rich_text" && table.rows[1][0].type === "raw_text", "the share is bold, the name plain");
  check(contexts.length === 1 && contexts[0] === "Paid *94* · Drafts *5* · Draw winners (estimate) *27*", `the totals: ${contexts[0]}`);
  check(today.text === "Test Artist · Multiple · 2026 Q3: sell-through 21% of 600 units", `notification text: ${today.text}`);
  check(!JSON.stringify(today).includes("\u2014"), "no em dash");
}

// at close: the projection's share, the units still to come in the rows and the totals
const close = composeSellThroughBlocks(snap, { horizon: "close", today: "2026-09-17" });
{
  const { section, table, contexts } = parts(close.blocks);
  check(section.text.text.startsWith("*Sell-through by product · 31% of 600 units* · at close · day 11"), `close headline: ${section.text.text.split("\n")[0]}`);
  const row = table.rows[1].map(cellText);
  check(row[1] === "82 of 200" && row[2] === "41%", `close row: ${row.join(" | ")}`);
  check(contexts[0].endsWith(" · Still to come *60*"), `close totals: ${contexts[0]}`);
  check(close.text.endsWith(" at close"), `close text: ${close.text}`);
}

// sent two days after the feeds' last complete day: the day moves on, the data day does not
{
  const later = parts(composeSellThroughBlocks(snap, { today: "2026-09-19" }).blocks).section.text.text;
  check(later.includes("· day 13 of 24 · data through 17 Sep"), `later: ${later.split("\n")[0]}`);
  const closed = parts(composeSellThroughBlocks(snap, { today: "2026-10-30" }).blocks).section.text.text;
  check(closed.includes("· day 24 of 24 ·"), `never past the last day: ${closed.split("\n")[0]}`);
}

// framing: the frames per print the orders observed, the Framing card's figure; before a
// sale the entrants' pre-authorised prints; a snapshot without the block says the plan; none
// where no print has a frame on offer
{
  const framing = (s, o) => (parts(composeSellThroughBlocks(s, { today: "2026-09-17", ...o }).blocks).section.text.text.split("\n")[1] || null);
  const unsold = { ...snap, framing: { ...snap.framing, prints: 0, frames: 0, rate: null, entrants: { prints: 30, frames: 15, rate: 0.5 } } };
  check(framing(unsold) === "Framing conversion *50%* of the prints entrants pre-authorised · plan 35%", `before a sale: ${framing(unsold)}`);
  const { framing: _omit, ...older } = snap;
  check(framing(older) === "Framing conversion *35%* (plan)", `a snapshot without the block: ${framing(older)}`);
  check(framing({ ...older, economics: {} }) === null, "no block and no plan, no line");
  check(framing({ ...snap, framing: null }) === null, "no print with a frame on offer, no line");
  check(framing({ ...snap, economics: { framingAvailable: false, frameConversion: 0.35 } }) === null, "no framing option on the release, no line");
  const nought = { ...snap, framing: { ...snap.framing, frames: 0, rate: 0 } };
  check(framing(nought) === "Framing conversion *0%* · 0 frames on 94 prints sold · plan 35%", "an observed nought is still observed");
}

// the whole edition is the products' editions added up, not the page's sellout target
{
  const targeted = composeSellThroughBlocks({ ...snap, sellthrough: { ...snap.sellthrough, edition: 500 } }, { today: "2026-09-17" });
  check(parts(targeted.blocks).section.text.text.startsWith("*Sell-through by product · 21% of 600 units*"), "edition sum");
}

// a release without products: the release is the one row, and the note says what is missing
{
  const bare = composeSellThroughBlocks({ id: "x", releaseName: "X · Y · 2026 Q1", asOf: "2026-09-17", day: 3, of: 20,
    sellthrough: { edition: 100, sold: 12, drafts: 2, soldPredicted: 8, conversion: 0.8, incomplete: ["products"] } }, { today: "2026-09-17" });
  const { section, table, contexts } = parts(bare.blocks);
  check(section.text.text.startsWith("*Sell-through by product · 22% of 100 units*"), `bare headline: ${section.text.text}`);
  const row = table.rows[1].map(cellText);
  check(table.rows.length === 2 && row[0] === "X · Y · 2026 Q1" && row[1] === "22 of 100" && row[2] === "22%", `bare row: ${row.join(" | ")}`);
  check(contexts[1] === "_Incomplete data: products_", `bare note: ${contexts[1]}`);
  // and without an edition at all: units, no share
  const units = composeSellThroughBlocks({ id: "x", releaseName: "X", asOf: "2026-09-17", day: 3, of: 20,
    sellthrough: { sold: 12, drafts: 0, soldPredicted: 8, incomplete: ["products"] } }, { today: "2026-09-17" });
  const urow = parts(units.blocks).table.rows[1].map(cellText);
  check(parts(units.blocks).section.text.text.startsWith("*Sell-through by product · 20 units*") && urow[1] === "20" && urow[2] === "-", `units only: ${urow.join(" | ")}`);
}

// the real snapshots on disk, if any: they must compose, three cells a row, figures only
const dir = path.join(here, "..", "data", "app", "releases");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const horizon of ["today", "close"]) {
      const m = composeSellThroughBlocks(s, { horizon });
      const { table } = parts(m.blocks);
      check(table && table.rows.length >= 2, `${f} composes at ${horizon}`);
      check(table.rows.every((r) => r.length === 3) && !/[█▓▒░─]/.test(JSON.stringify(m.blocks)), `${f}: three cells a row and no bar glyphs at ${horizon}`);
      check(JSON.stringify(m.blocks).length < 10000, `${f}: under Slack's size limit at ${horizon}`);
    }
    if (print && /schnabel|warhol/.test(f)) console.log("\n" + asText(composeSellThroughBlocks(s)));
  }
}
console.log(failed ? `${failed} failure(s)` : "ok: slack message");
process.exit(failed ? 1 : 0);
