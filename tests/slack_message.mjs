/* The Slack sell-through update as Block Kit - the artist, the day, Slack's
 * table of the works (units, target, share of target, framed units and the
 * framing conversion, the last two on the units column's own units) with a
 * bold Total row, the totals and the framing readings under it - composed
 * from a synthetic snapshot and the real ones on disk, checked block by
 * block.  node tests/slack_message.mjs [--print] */
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
const cellText = (c) => (c.type === "raw_text" ? c.text : c.elements.map((s) => s.elements.map((e) => e.text).join("")).join(""));
// a figure cell's number, read off its words ("1,234", "52%"); null for "-"
const cellNum = (c) => { const t = cellText(c).replace(/[,%]/g, ""); return t === "-" || t === "" ? null : Number(t); };
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
  // the forecast is the ETL's (etl/build.py framing_forecast): each row's units with its
  // frames, keyed by the row's draw; here set by hand to figures that round cleanly
  framing: { prints: 94, frames: 40, rate: 0.4255, entrants: { prints: 30, frames: 20, rate: 0.6667 }, plan: 0.35, benchmark: null, works: [
    { name: "Castles Burning (For Neil Young) I", prints: 46, frames: 20.5, rate: 0.4457 },
    { name: "Castles Burning (For Neil Young) II", prints: 32, frames: 12, rate: 0.375 },
    { name: "Castles Burning (For Neil Young) III", prints: 16, frames: 7.5, rate: 0.4688 },
  ], notOffered: { units: 0, works: [] },
  forecast: {
    today: { prints: 126.2, frames: 58.4, rate: 0.4628, notOffered: 0 },
    close: { prints: 186.2, frames: 98.5, rate: 0.529, notOffered: 0 },
    products: [
      { key: "d1", name: "Castles Burning (For Neil Young) I", today: { prints: 62.4, frames: 30.6, rate: 0.4904 }, close: { prints: 82.4, frames: 44.1, rate: 0.5352 } },
      { key: "d2", name: "Castles Burning (For Neil Young) II", today: { prints: 40.2, frames: 16.5, rate: 0.4104 }, close: { prints: 60.2, frames: 29.8, rate: 0.495 } },
      { key: "d3", name: "Castles Burning (For Neil Young) III", today: { prints: 23.6, frames: 11.3, rate: 0.4788 }, close: { prints: 43.6, frames: 24.6, rate: 0.5642 } },
    ],
  } },
  sellthrough: {
    edition: 600, sold: 94, drafts: 5, soldPredicted: 27.2, futureEntriesPredicted: 60, pct: 0.31, conversion: 0.8, incomplete: [],
    products: [
      { key: "d1", draws: ["d1"], name: "Castles Burning (For Neil Young) I", edition: 200, sold: 46, soldAssumed: 0, drafts: 2, shown: 14.4, futurePredicted: 20, pct: 0.312, pctClose: 0.412 },
      { key: "d2", draws: ["d2"], name: "Castles Burning (For Neil Young) II", edition: 200, sold: 32, soldAssumed: 0, drafts: 1, shown: 7.2, futurePredicted: 20, pct: 0.201, pctClose: 0.301 },
      { key: "d3", draws: ["d3"], name: "Castles Burning (For Neil Young) III", edition: 200, sold: 16, soldAssumed: 0, drafts: 2, shown: 5.6, futurePredicted: 20, pct: 0.118, pctClose: 0.218 },
    ],
  },
};
const at = (o) => composeSellThroughBlocks(snap, { today: "2026-09-17", ...o });

// today: the artist, the day line, the table, the small type under it
{
  const m = at({});
  const p = parts(m.blocks);
  check(p.types === "header section section table section context context", `the blocks: ${p.types}`);
  check(p.header.text.type === "plain_text" && p.header.text.text === "Test Artist", `the artist as the header: ${p.header.text.text}`);
  // the close forecast under the table, at full size and marked beta: the "At close" view's
  // headline figures, so the two never disagree
  check(p.sections[2] === "Projected sell-through at close: *31%*, 186 of 600 units on current results `BETA`", `the beta close line: ${p.sections[2]}`);
  const closeText = at({ horizon: "close" }).text;
  const [, cp, cu, ce] = closeText.match(/(\d+)% projected at close, ([\d,]+) of ([\d,]+) units$/);
  check(p.sections[2].includes(`*${cp}%*, ${cu} of ${ce} units`), `the line is the At close headline's figures: ${closeText}`);
  check(p.sections[0] === "Castles Burning (For Neil Young), day 11 of 24", `the works and the day above the table: ${p.sections[0]}`);
  const t = p.table;
  check(p.sections[1] === "*Sell-through by work*", `the table's title above it: ${p.sections[1]}`);
  check(t.column_settings.length === 6 && t.column_settings[0].is_wrapped === true && t.column_settings[0].align === "left"
    && t.column_settings.slice(1).every((c) => c.align === "right" && !c.is_wrapped), `the Work column wraps, the figures sit right: ${JSON.stringify(t.column_settings)}`);
  check(t.rows[0].every((c) => c.type === "raw_text") && rowsOf(m.blocks)[0] === "Work|Units sold *|Target|% target|Framed units *|Framing conversion", `the header row, plain text: ${rowsOf(m.blocks)[0]}`);
  check(rowsOf(m.blocks)[1] === "I|62|120|52%|31|49%", `the first work: ${rowsOf(m.blocks)[1]}`);
  check(rowsOf(m.blocks)[2] === "II|40|100|40%|17|41%", `the second: ${rowsOf(m.blocks)[2]}`);
  check(rowsOf(m.blocks)[3] === "III|24|133|18%|11|48%", `the third, its target the release's split by edition: ${rowsOf(m.blocks)[3]}`);
  check(rowsOf(m.blocks)[4] === "Total|126|353|36%|58|46%", `the Total row adds the rows up, the frames before rounding: ${rowsOf(m.blocks)[4]}`);
  check(t.rows[4].every((c) => c.type === "rich_text" && c.elements[0].elements[0].style.bold === true), "the Total row is bold");
  const r = t.rows[1];
  // every cell is one of the two types Slack's table reads: raw_number cells
  // posted, and showed blank on the phone app
  check(t.rows.every((row) => row.every((c) => c.type === "raw_text" || c.type === "rich_text")), "every cell is raw_text or rich_text");
  check(r[0].type === "raw_text" && r[1].type === "raw_text" && r[1].text === "62", `units as their words: ${JSON.stringify(r[1])}`);
  check(r[3].text === "52%" && r[5].text === "49%", `shares as shares: ${JSON.stringify(r[3])} ${JSON.stringify(r[5])}`);
  check(r[4].type === "raw_text" && r[4].text === "31", `framed units: ${JSON.stringify(r[4])}`);
  // the framed units are on the units column's own units: never more than the row's units
  check(rowsOf(m.blocks).slice(1).every((x) => { const c = x.split("|"); return Number(c[4]) <= Number(c[1]); }), "no row frames more than it counts");
  check(p.contexts[0] === "Figures to 17 Sep. Paid 94, awaiting payment 5, expected from the draw 27. 43% of paid prints took a frame, 40 of 94; entrants asked for frames on 67% of their pre-authorised prints.", `the small type: ${p.contexts[0]}`);
  check(p.contexts[1] === "* Includes paid units, drafts and forecast conversions from draw entries.", `the footnote last: ${p.contexts[1]}`);
  check(m.text === "Test Artist: 21% sold through, 126 of 600 units", `notification text: ${m.text}`);
  check(!JSON.stringify(m).includes("\u2014") && !JSON.stringify(m).includes("\u00b7"), "no em dash, no middle dot");
}

// at close: the projection in the units column, the totals say what is still to come
{
  const m = at({ horizon: "close" });
  const p = parts(m.blocks);
  check(p.sections[1] === "*Projected at close by work*" && rowsOf(m.blocks)[0] === "Work|Units at close *|Target|% target|Framed units *|Framing conversion", `close header: ${rowsOf(m.blocks)[0]}`);
  check(p.types === "header section section table context context" && !JSON.stringify(m.blocks).includes("BETA"), `no beta line on the At close update, whose table is the projection: ${p.types}`);
  check(rowsOf(m.blocks)[1] === "I|82|120|69%|44|54%", `close row, the forecast at close: ${rowsOf(m.blocks)[1]}`);
  check(rowsOf(m.blocks)[4] === "Total|186|353|53%|99|53%", `close total: ${rowsOf(m.blocks)[4]}`);
  check(p.contexts[0].includes("expected from the draw 27, still to come 60."), `close totals: ${p.contexts[0]}`);
  check(m.text === "Test Artist: 31% projected at close, 186 of 600 units", `close text: ${m.text}`);
}

// the beta line goes once the campaign is complete (today's figure is then the close's), and
// without an edition it gives the units alone
check(!JSON.stringify(at({}).blocks).includes("BETA") === false && !JSON.stringify(composeSellThroughBlocks({ ...snap, complete: true }, { today: "2026-09-17" }).blocks).includes("BETA"), "no beta line on a complete campaign");
check(parts(composeSellThroughBlocks({ ...snap, sellthrough: { ...snap.sellthrough, edition: null, pct: null, products: [] } }, { today: "2026-09-17" }).blocks).sections[2]
  === "Projected at close: *186 units* on current results `BETA`", "no edition at all: the units alone");

// sent two days after the feeds' last complete day: the day moves on, the data day does not
check(parts(at({ today: "2026-09-19" }).blocks).sections[0].endsWith("day 13 of 24") && parts(at({ today: "2026-09-19" }).blocks).contexts[0].startsWith("Figures to 17 Sep."), "the day moves on");
check(parts(at({ today: "2026-10-30" }).blocks).sections[0].endsWith("day 24 of 24"), "never past the last day");

// framing in words: the two readings behind the table's figure, the paid prints and the
// entrants' pre-authorised ones; either alone; nothing without the block or an offer
{
  const framing = (s, o) => {
    const c = parts(composeSellThroughBlocks(s, { today: "2026-09-17", ...o }).blocks).contexts[0];
    return c.includes("draw 27. ") ? c.split("draw 27. ")[1] : null;
  };
  const unsold = { ...snap, framing: { ...snap.framing, prints: 0, frames: 0, rate: null, entrants: { prints: 30, frames: 15, rate: 0.5 } } };
  check(framing(unsold) === "Entrants asked for frames on 50% of their pre-authorised prints.", `before a sale: ${framing(unsold)}`);
  const noEntrants = { ...snap, framing: { ...snap.framing, entrants: null } };
  check(framing(noEntrants) === "43% of paid prints took a frame, 40 of 94.", `no one pre-authorised: ${framing(noEntrants)}`);
  const { framing: _omit, ...older } = snap;
  check(framing(older) === null, `a snapshot without the block says nothing of the plan: ${framing(older)}`);
  check(framing({ ...snap, framing: null }) === null, "no print with a frame on offer, no line");
  check(framing({ ...snap, economics: { ...snap.economics, framingAvailable: false } }) === null, "no framing option on the release, no line");
  check(framing({ ...snap, framing: { ...snap.framing, frames: 0, rate: 0, entrants: null } }) === "0% of paid prints took a frame, 0 of 94.", "an observed nought is still observed");
}

// the table's framing columns: each row's forecast from the snapshot, found by the row's
// draw whatever the names say; a dash for a row with no frame on offer; the columns left
// out where the release has no framing option, the snapshot no framing block, or a block
// built before the forecast (a paid-only figure beside these units would mislead)
{
  const at = (s, o) => rowsOf(composeSellThroughBlocks(s, { today: "2026-09-17", ...o }).blocks);
  const fc = snap.framing.forecast;
  // no frame on offer for II: the forecast has no row for it and leaves its units out
  const noFrameOnII = { ...snap, framing: { ...snap.framing, forecast: { ...fc,
    today: { prints: 86, frames: 41.9, rate: 0.4872, notOffered: 40.2 },
    products: fc.products.filter((r) => r.key !== "d2") } } };
  check(at(noFrameOnII)[2] === "II|40|100|40%|-|-", `no frame on offer, a dash: ${at(noFrameOnII)[2]}`);
  check(at(noFrameOnII)[4] === "Total|126|353|36%|42|49%", `the Total is the forecast's own, on the works with one: ${at(noFrameOnII)[4]}`);
  // the row is found by its draw, whatever the names
  const renamed = { ...snap, sellthrough: { ...snap.sellthrough, products: snap.sellthrough.products.map((q, i) => ({ ...q, name: ["Print", "Vase", "Jar"][i] })) } };
  // (renamed, the rows lose the targets typed by name and take the split; the framing stays)
  check(at(renamed)[1] === "Print|62|133|47%|31|49%" && at(renamed)[2] === "Vase|40|133|30%|17|41%", `by the draw: ${at(renamed).slice(1, 3).join(" / ")}`);
  const swapped = { ...snap, framing: { ...snap.framing, forecast: { ...fc, products: fc.products.map((r) => ({ ...r, key: { d1: "d2", d2: "d1", d3: "d3" }[r.key] })) } } };
  check(at(swapped)[1] === "I|62|120|52%|17|41%", `a row takes the forecast of its own draw: ${at(swapped)[1]}`);
  for (const [label, s] of [
    ["no framing option", { ...snap, economics: { ...snap.economics, framingAvailable: false } }],
    ["no print with a frame on offer", { ...snap, framing: null }],
    ["a snapshot without the block", (({ framing: _f, ...rest }) => rest)(snap)],
    ["a block built before the forecast", { ...snap, framing: (({ forecast: _f, ...rest }) => rest)(snap.framing) }],
  ]) {
    const p = parts(composeSellThroughBlocks(s, { today: "2026-09-17" }).blocks);
    check(p.table.column_settings.length === 4 && p.table.rows.every((r) => r.length === 4) && at(s)[0] === "Work|Units sold *|Target|% target" && at(s)[4] === "Total|126|353|36%",
      `${label}: four columns: ${at(s)[0]} / ${at(s)[4]}`);
  }
  // a block built before the forecast still has its sentence: the readings are observed
  check(parts(composeSellThroughBlocks({ ...snap, framing: (({ forecast: _f, ...rest }) => rest)(snap.framing) }, { today: "2026-09-17" }).blocks).contexts[0].includes("43% of paid prints took a frame"), "the sentence without the forecast");
  // nothing on offer counted yet: the columns are there, dashes in them
  const none = { ...snap, framing: { ...snap.framing, forecast: { today: { prints: 0, frames: 0, rate: null, notOffered: 126.2 }, close: { prints: 0, frames: 0, rate: null, notOffered: 186.2 }, products: [] } } };
  check(at(none)[1] === "I|62|120|52%|-|-" && at(none)[4] === "Total|126|353|36%|-|-", `nothing on offer yet: ${at(none)[4]}`);
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
  check(rowsOf(composeSellThroughBlocks(twice, { today: "2026-09-17" }).blocks)[1] === "Composition with|62|133|47%|31|49%", `an ambiguous title takes the split: ${rowsOf(composeSellThroughBlocks(twice, { today: "2026-09-17" }).blocks)[1]}`);
  const split = { ...snap, economics: { ...snap.economics, products: [] } };
  check(rowsOf(composeSellThroughBlocks(split, { today: "2026-09-17" }).blocks)[1] === "I|62|133|47%|31|49%" && rowsOf(composeSellThroughBlocks(split, { today: "2026-09-17" }).blocks)[4] === "Total|126|399|32%|58|46%", `the release's target split by edition: ${rowsOf(composeSellThroughBlocks(split, { today: "2026-09-17" }).blocks)[4]}`);
  const none = { ...split, edition: { total: 600 } };
  check(rowsOf(composeSellThroughBlocks(none, { today: "2026-09-17" }).blocks)[1] === "I|62|-|-|31|49%" && rowsOf(composeSellThroughBlocks(none, { today: "2026-09-17" }).blocks)[4] === "Total|126|-|-|58|46%", `no target at all: ${rowsOf(composeSellThroughBlocks(none, { today: "2026-09-17" }).blocks)[4]}`);
}

// the headline's edition is the card's, the release's own, when the works' editions add up to
// more (Julian Schnabel: three works of 200 on a release of 500): the percentage and the
// "of N units" are both on it at both horizons, and at close the percentage is the card's
{
  const parts = (st, close) => st.sold + st.drafts + st.soldPredicted + (close ? st.futureEntriesPredicted : 0);
  const st500 = { ...snap.sellthrough, edition: 500, editionSum: 600, editionMismatch: true };
  st500.pct = Math.round(Math.min(parts(st500, true) / 500, 1) * 10000) / 10000;   // etl/build.py close_headline
  const mismatch = { ...snap, sellthrough: st500 };
  const t = composeSellThroughBlocks(mismatch, { today: "2026-09-17" }).text;
  const c = composeSellThroughBlocks(mismatch, { today: "2026-09-17", horizon: "close" }).text;
  check(t === "Test Artist: 25% sold through, 126 of 500 units", `today on the release's edition, as the card: ${t}`);
  check(c === "Test Artist: 37% projected at close, 186 of 500 units", `at close on the release's edition, as the card: ${c}`);
  for (const [text, close] of [[t, false], [c, true]]) {
    const [, p, u, e] = text.match(/(\d+)% [a-z ]+, ([\d,]+) of ([\d,]+) units$/);
    check(Number(p) === Math.round((100 * parts(st500, close)) / Number(e.replace(/,/g, ""))) && Number(u) === Math.round(parts(st500, close)),
      `the percentage is the printed units over the printed edition: ${text}`);
  }
  // the works' split of the release's target still reads the works' own editions
  check(rowsOf(composeSellThroughBlocks(mismatch, { today: "2026-09-17" }).blocks)[3] === "III|24|133|18%|11|48%", "the target split is by the works' editions");
  // a release without an edition of its own: the works' editions stand in, and at close the
  // percentage is read off the units rather than the missing pct
  const noEdition = { ...snap, sellthrough: { ...snap.sellthrough, edition: null, pct: null } };
  check(composeSellThroughBlocks(noEdition, { today: "2026-09-17" }).text === "Test Artist: 21% sold through, 126 of 600 units", "no release edition: the works' sum");
  check(composeSellThroughBlocks(noEdition, { today: "2026-09-17", horizon: "close" }).text === "Test Artist: 31% projected at close, 186 of 600 units", "no release edition at close: off the units, not 0%");
}

// the figures run to the page's as-of day, "so far" while that day is only partly in
{
  const below = (s) => parts(composeSellThroughBlocks(s, { today: s.asOf }).blocks).contexts[0];
  check(below({ ...snap, asOf: "2026-09-18", completeThrough: "2026-09-17", asOfFraction: 0.5 }).startsWith("Figures to 18 Sep so far. Paid 94"), `a live day: ${below({ ...snap, asOf: "2026-09-18", completeThrough: "2026-09-17", asOfFraction: 0.5 })}`);
  check(below({ ...snap, asOf: "2026-09-24", completeThrough: "2026-09-23", asOfFraction: 1 }).startsWith("Figures to 24 Sep. Paid 94"), `a closed window, the page's asOf: ${below({ ...snap, asOf: "2026-09-24", completeThrough: "2026-09-23", asOfFraction: 1 })}`);
}

// with the page's Direct switch on Spread the message is the Spread reading and says so;
// on Channel it says nothing about attribution
{
  const spread = { ...snap, sellthrough: { ...snap.sellthrough, futureEntriesPredicted: 50, pct: 0.2937 } };
  const on = composeSellThroughBlocks(spread, { today: "2026-09-17", horizon: "close", direct: true });
  const off = composeSellThroughBlocks(snap, { today: "2026-09-17", horizon: "close" });
  check(parts(on.blocks).contexts[0].startsWith("Figures to 17 Sep. Attribution: Direct spread over the other channels. Paid 94"), `Spread said: ${parts(on.blocks).contexts[0]}`);
  check(!/Direct/.test(JSON.stringify(off.blocks)), "Channel says nothing of attribution");
  check(on.text === "Test Artist: 29% projected at close, 176 of 600 units" && /still to come 50\./.test(parts(on.blocks).contexts[0]), `the Spread reading's figures: ${on.text}`);
}

// a release without products: the release is the one row, no Total row, and the note says what is missing
{
  const bare = { id: "x", artist: "X", releaseName: "X · Y · 2026 Q1", asOf: "2026-09-17", day: 3, of: 20, edition: { target: 80, total: 100 },
    sellthrough: { edition: 100, sold: 12, drafts: 2, soldPredicted: 8, conversion: 0.8, incomplete: ["products"] } };
  const m = composeSellThroughBlocks(bare, { today: "2026-09-17" });
  const p = parts(m.blocks);
  check(p.types === "header section section table section context context context", `bare blocks: ${p.types}`);
  check(p.sections[0] === "Day 3 of 20" && p.contexts[1] === "_Incomplete data: products_", `bare lines: ${p.sections[0]} / ${p.contexts[1]}`);
  check(p.sections[2] === "Projected sell-through at close: *22%*, 22 of 100 units on current results `BETA`", `bare beta line, nothing still to come: ${p.sections[2]}`);
  check(rowsOf(m.blocks).length === 2 && rowsOf(m.blocks)[1] === "X · Y · 2026 Q1|22|80|28%", `bare row, no Total, no framing block so no framing columns: ${rowsOf(m.blocks).join(" / ")}`);
  // with the framing block, the release's own forecast in the one row
  const framed = composeSellThroughBlocks({ ...bare, framing: { prints: 12, frames: 6, rate: 0.5, entrants: null, plan: 0.35, benchmark: null, works: [], notOffered: { units: 0, works: [] },
    forecast: { today: { prints: 22, frames: 12.2, rate: 0.5545, notOffered: 0 }, close: { prints: 22, frames: 12.2, rate: 0.5545, notOffered: 0 }, products: [] } } }, { today: "2026-09-17" });
  check(rowsOf(framed.blocks)[0] === "Work|Units sold *|Target|% target|Framed units *|Framing conversion" && rowsOf(framed.blocks)[1] === "X · Y · 2026 Q1|22|80|28%|12|55%", `bare row with framing: ${rowsOf(framed.blocks)[1]}`);
  // and without an edition at all: units, dashes for the rest
  const units = composeSellThroughBlocks({ id: "x", releaseName: "X", asOf: "2026-09-17", day: 3, of: 20,
    sellthrough: { sold: 12, drafts: 0, soldPredicted: 8, incomplete: ["products"] } }, { today: "2026-09-17" });
  check(rowsOf(units.blocks)[1] === "X|20|-|-" && units.text === "X: 20 units spoken for", `units only: ${rowsOf(units.blocks)[1]} ${units.text}`);
}

// the real snapshots on disk, if any: both horizons compose, every row as wide as the header
// (six cells with the framing columns, four without), a bold Total that adds up
const dir = path.join(here, "..", "data", "app", "releases");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const horizon of ["today", "close"]) {
      const m = composeSellThroughBlocks(s, { horizon });
      const p = parts(m.blocks);
      const width = p.table ? p.table.rows[0].length : 0;
      check(p.table && (width === 6 || width === 4) && p.table.rows.every((r) => r.length === width) && p.table.rows[0].every((c) => c.type === "raw_text"), `${f} composes at ${horizon} (${width} columns)`);
      check(!JSON.stringify(m.blocks).includes("\u00b7"), `${f}: no middle dots`);
      const works = p.table.rows.slice(1).filter((r) => r[0].type === "raw_text");
      const total = p.table.rows.slice(1).find((r) => r[0].type === "rich_text");
      if (works.length > 1) {
        check(total && cellText(total[0]) === "Total", `${f}: a Total row under ${works.length} works`);
        if (width === 6) {
          // the Total's framed units are the forecast's own at this horizon, the card's headline
          const fcAt = s.framing.forecast[horizon];
          const want = fcAt.prints > 0 ? Math.round(fcAt.frames).toLocaleString("en-GB") : "-";
          check(total && cellText(total[4]) === want, `${f}: the Total framed units are the forecast's (${total && cellText(total[4])} vs ${want})`);
          const rowFrames = works.reduce((n, r) => n + (cellNum(r[4]) ?? 0), 0);
          check(Math.abs(rowFrames - fcAt.frames) <= works.length / 2 + 0.5, `${f}: the rows' framed units add up to the Total within rounding (${rowFrames} vs ${fcAt.frames})`);
          // and no row frames more units than it counts
          check(works.every((r) => cellNum(r[4]) === null || cellNum(r[4]) <= cellNum(r[1])), `${f}: no row frames more than it counts at ${horizon}`);
        }
      } else check(!total, `${f}: no Total row for one work`);
    }
    // the headline is the card's (web/src/modules/SellThrough.jsx: the release's edition, today's
    // units over it, at close the sell-through's pct), on the page as it reads with Direct on
    // Channel and on Spread, the Spread reading being the snapshot with its variant laid over
    const variant = s.variants && s.variants.direct_spread;
    for (const [view, direct] of [[s, false], ...(variant ? [[{ ...s, ...variant }, true]] : [])]) {
      const st = view.sellthrough || {};
      if (!(st.edition > 0)) continue;
      for (const horizon of ["today", "close"]) {
        const close = horizon === "close";
        const units = (st.sold ?? 0) + (st.drafts ?? 0) + (st.soldPredicted ?? 0) + (close ? st.futureEntriesPredicted ?? 0 : 0);
        const cardPct = close ? st.pct ?? 0 : Math.min(units / st.edition, 1);
        const want = `${Math.round(cardPct * 100)}% ${close ? "projected at close" : "sold through"}, ${Math.round(units).toLocaleString("en-GB")} of ${Math.round(st.edition).toLocaleString("en-GB")} units`;
        const m = composeSellThroughBlocks(view, { horizon, direct });
        check(m.text.endsWith(want), `${f} ${horizon}${direct ? " (Spread)" : ""}: the card's headline: ${m.text} vs ${want}`);
        check(/Attribution: Direct spread/.test(JSON.stringify(m.blocks)) === direct, `${f} ${horizon}: the attribution said only on Spread`);
      }
    }
    if (print && /schnabel|warhol/.test(f)) console.log("\n" + asText(composeSellThroughBlocks(s)));
  }
}
// the paid lever under the beta line (6 October 2026): the forecast holds paid at its
// current daily spend, so the line says what the Paid card recommends instead and where
// that would take the close - room to scale up, no room, a cut or a stop - to one decimal
// and in units; nothing without a running campaign, a recommendation, the figure at the
// recommended spend, on an At close update or once the campaign is complete
{
  const withPaid = (current, recommended, pct, units, extra = {}, budget = {}) => ({ ...snap, ...extra,
    paid: { budget: { current, recommended, cap: "pacing", floor: 1, ...budget }, atRecommended: recommended === null ? null : { spend: recommended, sellThrough: pct === null ? null : { pct, units } } } });
  const sectionsOf = (s, o = {}) => parts(composeSellThroughBlocks(s, { today: "2026-09-17", ...o }).blocks).sections;
  const line = (s, o) => sectionsOf(s, o)[3] ?? null;
  const up = composeSellThroughBlocks(withPaid(1000, 1500, 0.3605, 216.3), { today: "2026-09-17" });
  check(parts(up.blocks).types === "header section section table section section context context", `the lever line is its own section under the beta line: ${parts(up.blocks).types}`);
  check(parts(up.blocks).sections[2].endsWith("`BETA`"), "the beta line stays as it was");
  check(line(withPaid(1000, 1500, 0.3605, 216.3)) === "This assumes paid stays at €1,000 a day. It looks like there is room to scale paid further, to €1,500 a day, which might take sell-through at close to *36.1%* (216 units).",
    `room to scale: ${line(withPaid(1000, 1500, 0.3605, 216.3))}`);
  check(line(withPaid(1000, 1500, 0.3141, 188.5)) === "This assumes paid stays at €1,000 a day. It looks like there is room to scale paid further, to €1,500 a day, which might take sell-through at close to *31.4%* (189 units).",
    `a small move still shows, to one decimal: ${line(withPaid(1000, 1500, 0.3141, 188.5))}`);
  check(line(withPaid(1000, 1000, 0.31, 186)) === "This assumes paid stays at €1,000 a day. There is no room to scale paid further.",
    `no room: ${line(withPaid(1000, 1000, 0.31, 186))}`);
  check(line(withPaid(1000, 1000.4, 0.31, 186)) === "This assumes paid stays at €1,000 a day. There is no room to scale paid further.", "a move that rounds to nothing is no move");
  // a cut or a stop says why (8 October 2026): what bound the recommendation, as the Paid card's chip names it
  const cut = (cap, rec = 700, extra = {}, budget = {}) => line(withPaid(1000, rec, 0.28, 168, extra, { cap, ...budget }));
  check(cut("roi_floor") === "This assumes paid stays at €1,000 a day. It looks like we might need to decrease paid spend, to €700 a day: at today's spend the ROI at close would fall below the floor of 1.0. That would leave us at *28.0%* (168 units).",
    `a cut at the ROI floor: ${cut("roi_floor")}`);
  check(cut("roi_floor", 700, {}, { paced: true, floor: 1.2 }) === "This assumes paid stays at €1,000 a day. It looks like we might need to decrease paid spend, to €700 a day: at today's spend the ROI at close would fall below the floor of 1.2, so it is cut by 30% a day. That would leave us at *28.0%* (168 units).",
    `a paced cut at the floor: ${cut("roi_floor", 700, {}, { paced: true, floor: 1.2 })}`);
  // the fixture's release has a target inside its edition, so supply reads "the target" there and "the sellout" on a whole edition
  const whole = { edition: { target: 600, total: 600 } };
  check(cut("supply", 700, whole) === "This assumes paid stays at €1,000 a day. It looks like we might need to decrease paid spend, to €700 a day: today's spend buys more than the sellout needs on current results. That would leave us at *28.0%* (168 units).",
    `a cut for supply: ${cut("supply", 700, whole)}`);
  check(cut("supply", 700, { edition: { target: 300, total: 600 } }) === "This assumes paid stays at €1,000 a day. It looks like we might need to decrease paid spend, to €700 a day: today's spend buys more than the target needs on current results. That would leave us at *28.0%* (168 units).",
    `a cut for supply against a target: ${cut("supply", 700, { edition: { target: 300, total: 600 } })}`);
  check(cut("roi_band_decrease") === "This assumes paid stays at €1,000 a day. It looks like we might need to decrease paid spend, to €700 a day: cumulative ROI is below 0.9, where the spend rules say decrease. That would leave us at *28.0%* (168 units).",
    `a cut by the ROI band: ${cut("roi_band_decrease")}`);
  check(cut("forced_decrease").includes(": the trailing 3-day ROI has been below target on each of the last three full days. That would"), `a forced cut: ${cut("forced_decrease")}`);
  check(cut("zero_conversion").includes(": yesterday's spend bought no entries. That would"), `a zero-conversion cut: ${cut("zero_conversion")}`);
  check(cut("pacing") === "This assumes paid stays at €1,000 a day. It looks like we might need to decrease paid spend, to €700 a day, which would leave us at *28.0%* (168 units).",
    `a cut with no limit to name keeps the plain words: ${cut("pacing")}`);
  const stop = (cap, extra = {}) => line(withPaid(1000, 0, 0.25, 150, extra, { cap }));
  check(stop("supply", whole) === "This assumes paid stays at €1,000 a day. It looks like we might need to stop paid spend: the sellout is reached without it on current results. That would leave us at *25.0%* (150 units).",
    `a stop for supply: ${stop("supply", whole)}`);
  check(stop("supply", { edition: { target: 300, total: 600 } }).includes("stop paid spend: the target is reached without it on current results."), `a stop for supply against a target: ${stop("supply", { edition: { target: 300, total: 600 } })}`);
  check(stop("roi_floor") === "This assumes paid stays at €1,000 a day. It looks like we might need to stop paid spend: at today's spend the ROI at close would fall below the floor of 1.0. That would leave us at *25.0%* (150 units).",
    `a stop at the floor: ${stop("roi_floor")}`);
  check(stop("zero_conversion_pause").includes("stop paid spend: paid has bought no entries for three days running. That would"), `a pause: ${stop("zero_conversion_pause")}`);
  check(stop(null) === "This assumes paid stays at €1,000 a day. It looks like we might need to stop paid spend, which would leave us at *25.0%* (150 units).",
    `a stop with no limit to name keeps the plain words: ${stop(null)}`);
  check(line(withPaid(0, 1500, 0.36, 216)) === null && line(withPaid(null, 1500, 0.36, 216)) === null, "no line without a running campaign");
  check(line(withPaid(1000, null, 0.36, 216)) === null && line(withPaid(1000, 1500, null, 216)) === null, "no line without a recommendation or its figure");
  check(line(withPaid(1000, 1500, 0.36, 216, { complete: true })) === null, "no line once the campaign is complete");
  check(!JSON.stringify(composeSellThroughBlocks(withPaid(1000, 1500, 0.36, 216), { today: "2026-09-17", horizon: "close" }).blocks).includes("assumes paid"), "no line on the At close update");
  check(up.text === "Test Artist: 21% sold through, 126 of 600 units", `the notification text is still the headline: ${up.text}`);
}
console.log(failed ? `${failed} failure(s)` : "ok: slack message");
process.exit(failed ? 1 : 0);
