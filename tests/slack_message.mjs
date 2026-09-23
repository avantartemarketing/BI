/* The Slack sell-through update as Block Kit, in its four layouts (a table,
 * Slack's own chart, the chart with a data table, cards), composed from a
 * synthetic snapshot and the real ones on disk, checked block by block.
 *   node tests/slack_message.mjs [--print]   (--print shows two real ones) */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { composeSellThroughBlocks, LAYOUTS, shortNames, sharedPrefix, chartLabels } = require(path.join(here, "..", "server", "slack.js"));
const print = process.argv.includes("--print");
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };
const cellText = (c) => (c.type === "raw_text" ? c.text : c.type === "raw_number" ? String(c.text ?? c.value) : c.elements.map((s) => s.elements.map((e) => e.text).join("")).join(""));
const parts = (blocks) => ({
  types: blocks.map((b) => b.type).join(" "),
  header: blocks.find((b) => b.type === "header"),
  contexts: blocks.filter((b) => b.type === "context").map((b) => b.elements.map((e) => e.text).join(" ")),
  sections: blocks.filter((b) => b.type === "section").map((b) => b.text.text),
  table: blocks.find((b) => b.type === "table"),
  chart: blocks.find((b) => b.type === "data_visualization"),
  dataTable: blocks.find((b) => b.type === "data_table"),
  carousel: blocks.find((b) => b.type === "carousel"),
});
const asText = ({ blocks }) => {
  const p = parts(blocks);
  return [p.header.text.text, ...p.contexts, ...p.sections, ...(p.table ? p.table.rows.map((r) => r.map(cellText).join("  ")) : [])].join("\n");
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// names lose what they share
check(same(shortNames(["Untitled (White on White)", "Untitled (Black on Black)"]), ["White on White", "Black on Black"]), "bracketed titles");
check(same(shortNames(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"]), ["Green Landscape", "Lifesize"]), "brillo titles");
check(same(shortNames(["Castles Burning (For Neil Young) I", "Castles Burning (For Neil Young) II", "Castles Burning (For Neil Young) III"]), ["I", "II", "III"]), "numbered prints");
check(same(shortNames(["Red", "Blue"]), ["Red", "Blue"]), "short unrelated names stay");
check(same(shortNames(["Only one"]), ["Only one"]), "a single name stays");
check(sharedPrefix(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"]) === "Brillo Box Collectable (", `the shared part: ${sharedPrefix(["Brillo Box Collectable (Green Landscape)", "Brillo Box Collectable (Lifesize)"])}`);
check(sharedPrefix(["Red", "Blue"]) === null && sharedPrefix(["Only one"]) === null, "no shared part");

// chart labels: 20 characters at most, unique
{
  const labels = chartLabels(["A very long product name indeed", "A very long product name too", "Short", "Short"]);
  check(labels.every((l) => [...l].length <= 20), `labels cut to 20: ${labels.join(" | ")}`);
  check(new Set(labels).size === 4, `labels unique: ${labels.join(" | ")}`);
  check(labels[2] === "Short" && labels[3] === "Short 2", `a collision is numbered: ${labels[3]}`);
}

// a synthetic release, mid-campaign
const snap = {
  id: "test_le_26", artist: "Test Artist", releaseName: "Test Artist · Multiple · 2026 Q3", asOf: "2026-09-17", completeThrough: "2026-09-17", day: 11, of: 24,
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
const at = (o) => composeSellThroughBlocks(snap, { today: "2026-09-17", ...o });

// the table layout, the default: the shared top and bottom around a table
{
  const m = at({});
  const p = parts(m.blocks);
  check(m.layout === "table" && p.types === "header context section table section", `the default blocks: ${p.types}`);
  check(p.header.text.type === "plain_text" && p.header.text.text === "Test Artist", `the artist as the header: ${p.header.text.text}`);
  check(p.contexts[0] === "Castles Burning (For Neil Young), 3 works. Day 11 of 24, figures to 17 Sep.", `the works and the day: ${p.contexts[0]}`);
  check(p.sections[0] === "*21% sold through*, 126 of 600 units", `the headline: ${p.sections[0]}`);
  check(p.table.column_settings.length === 3 && p.table.column_settings[0].is_wrapped === true, "three columns, the name may wrap");
  check(p.table.rows.length === 4 && p.table.rows[0].map(cellText).join("|") === "Work|Units|Sold", `the header row: ${p.table.rows[0].map(cellText).join("|")}`);
  const row = p.table.rows[1].map(cellText);
  check(row.join("|") === "I|62 of 200|31%" && p.table.rows[3].map(cellText)[0] === "III", `the first row: ${row.join("|")}`);
  check(p.sections[1] === "Paid 94, awaiting payment 5, expected from the draw 27.\n43% of prints sold took a frame, 40 of 94 (plan 35%).", `the totals and the framing: ${p.sections[1]}`);
  check(m.text === "Test Artist: 21% sold through, 126 of 600 units", `notification text: ${m.text}`);
  check(!JSON.stringify(m).includes("\u2014") && !JSON.stringify(m).includes("\u00b7"), "no em dash, no middle dot");
}

// at close: the projection, the units still to come in the rows and the totals
{
  const m = at({ horizon: "close" });
  const p = parts(m.blocks);
  check(p.sections[0] === "*31% projected at close*, 186 of 600 units", `close headline: ${p.sections[0]}`);
  check(p.table.rows[1].map(cellText).join("|") === "I|82 of 200|41%", `close row: ${p.table.rows[1].map(cellText).join("|")}`);
  check(p.sections[1].startsWith("Paid 94, awaiting payment 5, expected from the draw 27, still to come 60."), `close totals: ${p.sections[1]}`);
  check(m.text === "Test Artist: 31% projected at close, 186 of 600 units", `close text: ${m.text}`);
}

// sent two days after the feeds' last complete day: the day moves on, the data day does not
check(parts(at({ today: "2026-09-19" }).blocks).contexts[0].endsWith("Day 13 of 24, figures to 17 Sep."), "the day moves on");
check(parts(at({ today: "2026-10-30" }).blocks).contexts[0].endsWith("Day 24 of 24, figures to 17 Sep."), "never past the last day");

// framing: the frames per print the orders observed; before a sale the entrants' prints; a
// snapshot without the block says the plan; none where no print has a frame on offer
{
  const framing = (s, o) => (parts(composeSellThroughBlocks(s, { today: "2026-09-17", ...o }).blocks).sections[1].split("\n")[1] || null);
  const unsold = { ...snap, framing: { ...snap.framing, prints: 0, frames: 0, rate: null, entrants: { prints: 30, frames: 15, rate: 0.5 } } };
  check(framing(unsold) === "Entrants asked for frames on 50% of their pre-authorised prints (plan 35%).", `before a sale: ${framing(unsold)}`);
  const { framing: _omit, ...older } = snap;
  check(framing(older) === "Framing plan 35%, no framed orders in the feed yet.", `a snapshot without the block: ${framing(older)}`);
  check(framing({ ...older, economics: {} }) === null, "no block and no plan, no line");
  check(framing({ ...snap, framing: null }) === null, "no print with a frame on offer, no line");
  check(framing({ ...snap, economics: { framingAvailable: false, frameConversion: 0.35 } }) === null, "no framing option on the release, no line");
  check(framing({ ...snap, framing: { ...snap.framing, frames: 0, rate: 0 } }) === "0% of prints sold took a frame, 0 of 94 (plan 35%).", "an observed nought is still observed");
}

// the chart layout: Slack's bar chart, one bar per work, the share of the edition
{
  const m = at({ layout: "chart", label: "Option A: Chart" });
  const p = parts(m.blocks);
  check(m.layout === "chart" && p.types === "context header context section data_visualization section", `chart blocks: ${p.types}`);
  check(p.contexts[0] === "*Option A: Chart*", `the test label leads: ${p.contexts[0]}`);
  const c = p.chart;
  check(c.title === "Sell-through by work" && c.chart.type === "bar" && c.chart.series.length === 1 && c.chart.series[0].name === "Sold through", `the chart: ${c.title} ${c.chart.type} ${c.chart.series[0].name}`);
  check(same(c.chart.axis_config.categories, ["I", "II", "III"]) && c.chart.axis_config.y_label === "% of edition" && c.chart.axis_config.x_label === "Work", `the axis: ${JSON.stringify(c.chart.axis_config)}`);
  check(same(c.chart.series[0].data, [{ label: "I", value: 31.2 }, { label: "II", value: 20.1 }, { label: "III", value: 11.8 }]), `the bars: ${JSON.stringify(c.chart.series[0].data)}`);
  check(c.chart.series[0].data.every((d) => [...d.label].length <= 20) && c.chart.axis_config.categories.every((x) => [...x].length <= 20), "labels within 20 characters");
  const close = parts(at({ layout: "chart", horizon: "close" }).blocks).chart;
  check(close.title === "Projected at close by work" && close.chart.series[0].name === "At close" && close.chart.series[0].data[0].value === 41.2, `the chart at close: ${close.title} ${close.chart.series[0].data[0].value}`);
  // long names that collide once cut still give every bar its own label
  const longNames = { ...snap, sellthrough: { ...snap.sellthrough, products: snap.sellthrough.products.map((q, i) => ({ ...q, name: `An unusually long title for a print ${i < 2 ? "" : "x"}` })) } };
  const lc = parts(composeSellThroughBlocks(longNames, { layout: "chart", today: "2026-09-17" }).blocks).chart;
  check(new Set(lc.chart.axis_config.categories).size === 3 && lc.chart.axis_config.categories.every((x) => [...x].length <= 20), `long names charted: ${lc.chart.axis_config.categories.join(" | ")}`);
  check(same(lc.chart.series[0].data.map((d) => d.label), lc.chart.axis_config.categories), "every point on a category");
}

// the chart with the data table: the figures under the picture, numbers sorting as numbers
{
  const m = at({ layout: "chart_table" });
  const p = parts(m.blocks);
  check(m.layout === "chart_table" && p.types === "header context section data_visualization data_table section", `chart and table blocks: ${p.types}`);
  const t = p.dataTable;
  check(t.caption === "Sell-through by work" && t.page_size === 5 && t.row_header_column_index === 0, `the data table: ${t.caption} ${t.page_size}`);
  check(t.rows[0].every((c) => c.type === "raw_text") && t.rows[0].map(cellText).join("|") === "Work|Sold|Units|Paid", `the header row, plain text: ${t.rows[0].map(cellText).join("|")}`);
  const r = t.rows[1];
  check(r[0].type === "raw_text" && r[0].text === "I", `the work: ${JSON.stringify(r[0])}`);
  check(r[1].type === "raw_number" && r[1].value === 31.2 && r[1].text === "31%", `the share as a number that shows as a share: ${JSON.stringify(r[1])}`);
  check(r[2].type === "raw_number" && r[2].value === 62 && r[2].text === "62 of 200", `the units: ${JSON.stringify(r[2])}`);
  check(r[3].type === "raw_number" && r[3].value === 46 && r[3].text === "46", `the paid: ${JSON.stringify(r[3])}`);
}

// the cards: a carousel, one per work, ten at most
{
  const m = at({ layout: "cards" });
  const p = parts(m.blocks);
  check(m.layout === "cards" && p.types === "header context section carousel section", `cards blocks: ${p.types}`);
  check(p.carousel.elements.length === 3 && p.carousel.elements.every((c) => c.type === "card"), "three cards");
  const c = p.carousel.elements[0];
  check(c.title.text === "*I*" && c.subtitle.text === "31% sold through" && c.body.text === "62 of 200 units spoken for. 46 paid.", `the first card: ${c.title.text} ${c.subtitle.text} ${c.body.text}`);
  check(c.title.type === "mrkdwn" && c.body.text.length <= 200, "card text within Slack's limits");
  const many = { ...snap, sellthrough: { ...snap.sellthrough, products: Array.from({ length: 12 }, (_, i) => ({ ...snap.sellthrough.products[0], name: `Print number ${i + 1}` })) } };
  const mp = parts(composeSellThroughBlocks(many, { layout: "cards", today: "2026-09-17" }).blocks);
  check(mp.carousel.elements.length === 10 && mp.contexts[1] === "and 2 more works.", `ten cards and a note: ${mp.carousel.elements.length} ${mp.contexts[1]}`);
}

// the whole edition is the products' editions added up, not the page's sellout target
check(parts(composeSellThroughBlocks({ ...snap, sellthrough: { ...snap.sellthrough, edition: 500 } }, { today: "2026-09-17" }).blocks).sections[0] === "*21% sold through*, 126 of 600 units", "edition sum");

// a release without products: the release is the one table row whatever the layout, and the note says what is missing
{
  const bare = { id: "x", artist: "X", releaseName: "X · Y · 2026 Q1", asOf: "2026-09-17", day: 3, of: 20,
    sellthrough: { edition: 100, sold: 12, drafts: 2, soldPredicted: 8, conversion: 0.8, incomplete: ["products"] } };
  for (const layout of LAYOUTS) {
    const m = composeSellThroughBlocks(bare, { layout, today: "2026-09-17" });
    const p = parts(m.blocks);
    check(m.layout === "table" && p.types === "header context section table section context", `${layout} without products falls back to the table: ${p.types}`);
    check(p.contexts[0] === "Day 3 of 20, figures to 17 Sep." && p.contexts[1] === "_Incomplete data: products_", `bare lines: ${p.contexts.join(" / ")}`);
    check(p.sections[0] === "*22% sold through*, 22 of 100 units" && p.table.rows[1].map(cellText).join("|") === "X · Y · 2026 Q1|22 of 100|22%", `bare row: ${p.table.rows[1].map(cellText).join("|")}`);
  }
  // and without an edition at all: units, no share
  const units = composeSellThroughBlocks({ id: "x", releaseName: "X", asOf: "2026-09-17", day: 3, of: 20,
    sellthrough: { sold: 12, drafts: 0, soldPredicted: 8, incomplete: ["products"] } }, { today: "2026-09-17" });
  const up = parts(units.blocks);
  check(up.sections[0] === "*20 units spoken for*" && up.table.rows[1].map(cellText).join("|") === "X|20|-", `units only: ${up.sections[0]} ${up.table.rows[1].map(cellText).join("|")}`);
  const unitsChart = { ...snap, sellthrough: { ...snap.sellthrough, edition: null, products: snap.sellthrough.products.map((q) => ({ ...q, edition: null })) } };
  const uc = parts(composeSellThroughBlocks(unitsChart, { layout: "chart", today: "2026-09-17" }).blocks).chart;
  check(uc.chart.axis_config.y_label === "Units" && uc.chart.series[0].data[0].value === 62, `a chart in units without editions: ${uc.chart.axis_config.y_label} ${uc.chart.series[0].data[0].value}`);
}

// the real snapshots on disk, if any: every layout at both horizons composes within Slack's limits
const dir = path.join(here, "..", "data", "app", "releases");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const layout of LAYOUTS) for (const horizon of ["today", "close"]) {
      const m = composeSellThroughBlocks(s, { layout, horizon });
      const p = parts(m.blocks);
      check(m.blocks.length >= 4 && m.blocks.length <= 50, `${f} composes as ${layout} at ${horizon}`);
      check(!JSON.stringify(m.blocks).includes("·"), `${f}: no middle dots as ${layout}`);
      if (p.chart) {
        const cats = p.chart.chart.axis_config.categories;
        check(cats.every((x) => [...x].length <= 20) && new Set(cats).size === cats.length && cats.length <= 20, `${f}: chart labels within limits`);
        check(p.chart.chart.series[0].data.length === cats.length, `${f}: one point per category`);
      }
      if (p.carousel) check(p.carousel.elements.length <= 10 && p.carousel.elements.every((c) => c.body.text.length <= 200 && c.title.text.length <= 150), `${f}: cards within limits`);
    }
    if (print && /schnabel|warhol/.test(f)) console.log("\n" + asText(composeSellThroughBlocks(s)));
  }
}
console.log(failed ? `${failed} failure(s)` : "ok: slack message");
process.exit(failed ? 1 : 0);
