/* The Slack sell-through update as Block Kit - the artist, the day, Slack's
 * data table of the works with a bold Total row, the totals and the framing
 * under it - composed from a synthetic snapshot and the real ones on disk,
 * checked block by block.  node tests/slack_message.mjs [--print] */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { composeSellThroughBlocks, shortNames, sharedPrefix } = require(path.join(here, "..", "server", "slack.js"));
const print = process.argv.includes("--print");
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const cellText = (c) => (c.type === "raw_text" ? c.text : c.type === "raw_number" ? String(c.text ?? c.value) : c.elements.map((s) => s.elements.map((e) => e.text).join("")).join(""));
const parts = (blocks) => ({
  types: blocks.map((b) => b.type).join(" "),
  header: blocks.find((b) => b.type === "header"),
  sections: blocks.filter((b) => b.type === "section").map((b) => b.text.text),
  contexts: blocks.filter((b) => b.type === "context").map((b) => b.elements.map((e) => e.text).join(" ")),
  table: blocks.find((b) => b.type === "table"),
});
const rowsOf = (blocks) => parts(blocks).table.rows.map((r) => r.map(cellText).join("|"));
const asText = ({ blocks }) => { const p = parts(blocks); return [p.header.text.text, ...p.sections, ...rowsOf(blocks), ...p.contexts].join("\n"); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// names lose what they share
check(same(shortNames(["Untitled (White on White)", "Untitled (Black on Black)"]), ["White on White", "Black on Black"]), "bracketed titles");
check(same(shortNames(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"]), ["Green Landscape", "Lifesize"]), "brillo titles");
check(same(shortNames(["Castles Burning (For Neil Young) I", "Castles Burning (For Neil Young) II", "Castles Burning (For Neil Young) III"]), ["I", "II", "III"]), "numbered prints");
check(same(shortNames(["Red", "Blue"]), ["Red", "Blue"]), "short unrelated names stay");
check(same(shortNames(["Only one"]), ["Only one"]), "a single name stays");
check(sharedPrefix(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"]) === "Brillo Box Collectable (", "the shared part");
check(sharedPrefix(["Red", "Blue"]) === null && sharedPrefix(["Only one"]) === null, "no shared part");

// a synthetic release, mid-campaign: two works with targets of their own on the tab, one
// without (its target is the release's, split by edition share)
const snap = {
  id: "test_le_26", artist: "Test Artist", releaseName: "Test Artist · Multiple · 2026 Q3", asOf: "2026-09-17", completeThrough: "2026-09-17", day: 11, of: 24,
  edition: { target: 400, total: 600 },
  economics: { mode: "release", framingAvailable: true, frameConversion: 0.35, products: [
    { name: "Castles Burning (For Neil Young) I", edition: 200, target_units: 120 },
    { name: "Castles Burning (For Neil Young) II", edition: 200, target_units: 100 },
  ] },
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
const at = (o) => composeSellThroughBlocks(snap, { today: "2026-09-17", ...o });

// today: the artist, the day line, the table, the small type under it
{
  const m = at({});
  const p = parts(m.blocks);
  check(p.types === "header section section table context context", `the blocks: ${p.types}`);
  check(p.header.text.type === "plain_text" && p.header.text.text === "Test Artist", `the artist as the header: ${p.header.text.text}`);
  check(p.sections[0] === "Castles Burning (For Neil Young), day 11 of 24", `the works and the day above the table: ${p.sections[0]}`);
  const t = p.table;
  check(p.sections[1] === "*Sell-through by work*", `the table's title above it: ${p.sections[1]}`);
  check(t.column_settings.length === 6 && t.column_settings[0].is_wrapped === true && t.column_settings[0].align === "left"
    && t.column_settings.slice(1).every((c) => c.align === "right" && !c.is_wrapped), `the Work column wraps, the figures sit right: ${JSON.stringify(t.column_settings)}`);
  check(t.rows[0].every((c) => c.type === "raw_text") && rowsOf(m.blocks)[0] === "Work|Units sold *|Target|% target|Edition|Sell-through", `the header row, plain text: ${rowsOf(m.blocks)[0]}`);
  check(rowsOf(m.blocks)[1] === "I|62|120|52%|200|31%", `the first work: ${rowsOf(m.blocks)[1]}`);
  check(rowsOf(m.blocks)[2] === "II|40|100|40%|200|20%", `the second: ${rowsOf(m.blocks)[2]}`);
  check(rowsOf(m.blocks)[3] === "III|24|133|18%|200|12%", `the third, its target the release's split by edition: ${rowsOf(m.blocks)[3]}`);
  check(rowsOf(m.blocks)[4] === "Total|126|353|36%|600|21%", `the Total row adds the rows up: ${rowsOf(m.blocks)[4]}`);
  check(t.rows[4].every((c) => c.type === "rich_text" && c.elements[0].elements[0].style.bold === true), "the Total row is bold");
  const r = t.rows[1];
  check(r[0].type === "raw_text" && r[1].type === "raw_number" && r[1].value === 62 && r[1].text === "62", `units as a number with its words: ${JSON.stringify(r[1])}`);
  check(r[3].value === 52 && r[3].text === "52%" && r[5].value === 31.2 && r[5].text === "31%", `shares as numbers that show as shares: ${JSON.stringify(r[3])} ${JSON.stringify(r[5])}`);
  check(p.contexts[0] === "Figures to 17 Sep. Paid 94, awaiting payment 5, expected from the draw 27. 43% of prints sold took a frame, 40 of 94.", `the small type: ${p.contexts[0]}`);
  check(p.contexts[1] === "* Includes paid units, drafts and forecast conversions from draw entries.", `the footnote last: ${p.contexts[1]}`);
  check(m.text === "Test Artist: 21% sold through, 126 of 600 units", `notification text: ${m.text}`);
  check(!JSON.stringify(m).includes("\u2014") && !JSON.stringify(m).includes("\u00b7"), "no em dash, no middle dot");
}

// at close: the projection in the units column, the totals say what is still to come
{
  const m = at({ horizon: "close" });
  const p = parts(m.blocks);
  check(p.sections[1] === "*Projected at close by work*" && rowsOf(m.blocks)[0] === "Work|Units at close *|Target|% target|Edition|Sell-through", `close header: ${rowsOf(m.blocks)[0]}`);
  check(rowsOf(m.blocks)[1] === "I|82|120|69%|200|41%", `close row: ${rowsOf(m.blocks)[1]}`);
  check(rowsOf(m.blocks)[4] === "Total|186|353|53%|600|31%", `close total: ${rowsOf(m.blocks)[4]}`);
  check(p.contexts[0].includes("expected from the draw 27, still to come 60."), `close totals: ${p.contexts[0]}`);
  check(m.text === "Test Artist: 31% projected at close, 186 of 600 units", `close text: ${m.text}`);
}

// sent two days after the feeds' last complete day: the day moves on, the data day does not
check(parts(at({ today: "2026-09-19" }).blocks).sections[0].endsWith("day 13 of 24") && parts(at({ today: "2026-09-19" }).blocks).contexts[0].startsWith("Figures to 17 Sep."), "the day moves on");
check(parts(at({ today: "2026-10-30" }).blocks).sections[0].endsWith("day 24 of 24"), "never past the last day");

// framing: the frames per print the orders observed; before a sale the entrants' prints; a
// snapshot without the block says the plan; none where no print has a frame on offer
{
  const framing = (s, o) => {
    const c = parts(composeSellThroughBlocks(s, { today: "2026-09-17", ...o }).blocks).contexts[0];
    return c.includes("draw 27. ") ? c.split("draw 27. ")[1] : null;
  };
  const unsold = { ...snap, framing: { ...snap.framing, prints: 0, frames: 0, rate: null, entrants: { prints: 30, frames: 15, rate: 0.5 } } };
  check(framing(unsold) === "Entrants asked for frames on 50% of their pre-authorised prints.", `before a sale: ${framing(unsold)}`);
  const { framing: _omit, ...older } = snap;
  check(framing(older) === null, `a snapshot without the block says nothing of the plan: ${framing(older)}`);
  check(framing({ ...snap, framing: null }) === null, "no print with a frame on offer, no line");
  check(framing({ ...snap, economics: { ...snap.economics, framingAvailable: false } }) === null, "no framing option on the release, no line");
  check(framing({ ...snap, framing: { ...snap.framing, frames: 0, rate: 0 } }) === "0% of prints sold took a frame, 0 of 94.", "an observed nought is still observed");
}

// targets: a work's own from the tab, matched by name or by the short title starting the
// long one; without any, the release's target split by edition share; without that, none
{
  // the draw feed's short titles against Airtable's long ones, as on the Mondrian release
  const byPrefix = { ...snap, economics: { ...snap.economics, products: [
    { name: "Composition with Red, Yellow, Black, Blue, and Gray", edition: 200, target_units: 150 },
    { name: "Composition with Large Red Plane, Yellow, Black, Gray, and Blue", edition: 200, target_units: 100 },
    { name: "Tableau No.1 with Red, Blue, Yellow, Black, and Gray", edition: 200, target_units: 90 },
  ] }, sellthrough: { ...snap.sellthrough, products: snap.sellthrough.products.map((q, i) => ({ ...q, name: ["Composition with Red, Yellow", "Composition with Large Red Plane", "Tableau no.1"][i] })) } };
  const bp = rowsOf(composeSellThroughBlocks(byPrefix, { today: "2026-09-17" }).blocks);
  check(bp[1].startsWith("Composition with Red, Yellow|62|150|") && bp[2].startsWith("Composition with Large Red Plane|40|100|") && bp[3].startsWith("Tableau no.1|24|90|"), `matched where the short title starts the long: ${bp.slice(1, 4).join(" / ")}`);
  // a short title that starts two long ones is left to the split, never guessed
  const twice = { ...byPrefix, sellthrough: { ...byPrefix.sellthrough, products: byPrefix.sellthrough.products.map((q, i) => (i === 0 ? { ...q, name: "Composition with" } : q)) } };
  check(rowsOf(composeSellThroughBlocks(twice, { today: "2026-09-17" }).blocks)[1] === "Composition with|62|133|47%|200|31%", `an ambiguous title takes the split: ${rowsOf(composeSellThroughBlocks(twice, { today: "2026-09-17" }).blocks)[1]}`);
  const split = { ...snap, economics: { ...snap.economics, products: [] } };
  check(rowsOf(composeSellThroughBlocks(split, { today: "2026-09-17" }).blocks)[1] === "I|62|133|47%|200|31%" && rowsOf(composeSellThroughBlocks(split, { today: "2026-09-17" }).blocks)[4] === "Total|126|399|32%|600|21%", `the release's target split by edition: ${rowsOf(composeSellThroughBlocks(split, { today: "2026-09-17" }).blocks)[4]}`);
  const none = { ...split, edition: { total: 600 } };
  check(rowsOf(composeSellThroughBlocks(none, { today: "2026-09-17" }).blocks)[1] === "I|62|-|-|200|31%" && rowsOf(composeSellThroughBlocks(none, { today: "2026-09-17" }).blocks)[4] === "Total|126|-|-|600|21%", `no target at all: ${rowsOf(composeSellThroughBlocks(none, { today: "2026-09-17" }).blocks)[4]}`);
}

// the whole edition is the products' editions added up, not the page's sellout target
check(composeSellThroughBlocks({ ...snap, sellthrough: { ...snap.sellthrough, edition: 500 } }, { today: "2026-09-17" }).text === "Test Artist: 21% sold through, 126 of 600 units", "edition sum");

// a release without products: the release is the one row, no Total row, and the note says what is missing
{
  const bare = { id: "x", artist: "X", releaseName: "X · Y · 2026 Q1", asOf: "2026-09-17", day: 3, of: 20, edition: { target: 80, total: 100 },
    sellthrough: { edition: 100, sold: 12, drafts: 2, soldPredicted: 8, conversion: 0.8, incomplete: ["products"] } };
  const m = composeSellThroughBlocks(bare, { today: "2026-09-17" });
  const p = parts(m.blocks);
  check(p.types === "header section section table context context context", `bare blocks: ${p.types}`);
  check(p.sections[0] === "Day 3 of 20" && p.contexts[1] === "_Incomplete data: products_", `bare lines: ${p.sections[0]} / ${p.contexts[1]}`);
  check(rowsOf(m.blocks).length === 2 && rowsOf(m.blocks)[1] === "X · Y · 2026 Q1|22|80|28%|100|22%", `bare row, no Total: ${rowsOf(m.blocks).join(" / ")}`);
  // and without an edition at all: units, dashes for the rest
  const units = composeSellThroughBlocks({ id: "x", releaseName: "X", asOf: "2026-09-17", day: 3, of: 20,
    sellthrough: { sold: 12, drafts: 0, soldPredicted: 8, incomplete: ["products"] } }, { today: "2026-09-17" });
  check(rowsOf(units.blocks)[1] === "X|20|-|-|-|-" && units.text === "X: 20 units spoken for", `units only: ${rowsOf(units.blocks)[1]} ${units.text}`);
}

// the real snapshots on disk, if any: both horizons compose, six cells a row, a bold Total that adds up
const dir = path.join(here, "..", "data", "app", "releases");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const horizon of ["today", "close"]) {
      const m = composeSellThroughBlocks(s, { horizon });
      const p = parts(m.blocks);
      check(p.table && p.table.rows.every((r) => r.length === 6) && p.table.rows[0].every((c) => c.type === "raw_text"), `${f} composes at ${horizon}`);
      check(!JSON.stringify(m.blocks).includes("\u00b7"), `${f}: no middle dots`);
      const works = p.table.rows.slice(1).filter((r) => r[0].type === "raw_text");
      const total = p.table.rows.slice(1).find((r) => r[0].type === "rich_text");
      if (works.length > 1) {
        check(total && cellText(total[0]) === "Total", `${f}: a Total row under ${works.length} works`);
        const editions = works.reduce((n, r) => n + (r[4].type === "raw_number" ? r[4].value : 0), 0);
        check(total && cellText(total[4]) === editions.toLocaleString("en-GB"), `${f}: the Total edition is the editions added up (${total && cellText(total[4])} vs ${editions})`);
      } else check(!total, `${f}: no Total row for one work`);
    }
    if (print && /schnabel|warhol/.test(f)) console.log("\n" + asText(composeSellThroughBlocks(s)));
  }
}
console.log(failed ? `${failed} failure(s)` : "ok: slack message");
process.exit(failed ? 1 : 0);
