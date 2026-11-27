/* Which work each draw is for (server/drawPairs.js, docs/DATA_MODEL.md 2.4):
 * the pairing read off the counts the pull takes per draw and product, a
 * release's draws paired together. The cases are the ones the rule was
 * written for, each with the counts the feed would give.
 * node tests/draw_pairs.mjs */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { pairDraws, fit, assign, SHARED_COST } = require(path.join(here, "..", "server", "drawPairs.js"));
const bq = require(path.join(here, "..", "server", "bigquery.js"));
let failed = 0;
const check = (cond, msg) => { if (!cond) { failed += 1; console.log("FAIL " + msg); } };

// a row of evidence: of the draw's `winners` and `entrants`, the winners who
// paid for the product and the entrants who hold a draft on it
const row = (release, draw, title, wonPaid, held, winners, entrants) =>
  ({ release, draw_id: draw, product_title: title, won_paid: wonPaid, held, winners, entrants });
const titles = (rows) => Object.fromEntries(pairDraws(rows).map((r) => [r.draw_id, r.product_title]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Harland Miller's two draws on 27 November 2026. Three people: one entered
// the second draw alone, won it and paid for (RED); the other two entered
// both and hold a draft on each work. Read one at a time the first draw is
// a tie, 2 of 2 against 2 of 2, and the alphabet gave it (RED) as well.
const harland = [
  row("HM", "draw_1", "(RED)", 0, 2, 0, 2), row("HM", "draw_1", "Star", 0, 2, 0, 2),
  row("HM", "draw_2", "(RED)", 1, 2, 1, 3), row("HM", "draw_2", "Star", 0, 2, 1, 3),
];
check(same(titles(harland), { draw_1: "Star", draw_2: "(RED)" }), "the draw that ties takes the work the other draw does not: " + JSON.stringify(titles(harland)));
const file = pairDraws(harland);
check(same(file.map((r) => [r.orders, r.share]), [[2, 0.5], [1, 1]]),
  "orders and share as the file has always had them: the people the product was read from, and their share of the draw's");
check(same(Object.keys(file[0]), bq.DRAW_PRODUCTS_HEADER), "the rows carry the file's columns, in its order");
check(bq.drawProductLine(file[1]) === "HM,draw_2,(RED),1,1.0" && bq.drawProductLine(file[0]) === "HM,draw_1,Star,2,0.5", "and are written as BigQuery wrote them");

// the same launch a day earlier, before anyone has won: the one entrant in a
// single draw holds a draft on (RED) alone, and that settles both draws
const before = [
  row("HM", "draw_1", "(RED)", 0, 2, 0, 2), row("HM", "draw_1", "Star", 0, 2, 0, 2),
  row("HM", "draw_2", "(RED)", 0, 3, 0, 3), row("HM", "draw_2", "Star", 0, 2, 0, 3),
];
check(same(titles(before), { draw_1: "Star", draw_2: "(RED)" }), "named from the entries, before a sale: one entrant in a single draw is enough");

// every entrant so far is in both draws: nothing tells them apart, so they
// take the works in order (draws by id, works by title), the same on every pull
const tied = [
  row("HM", "draw_1", "(RED)", 0, 2, 0, 2), row("HM", "draw_1", "Star", 0, 2, 0, 2),
  row("HM", "draw_2", "(RED)", 0, 2, 0, 2), row("HM", "draw_2", "Star", 0, 2, 0, 2),
];
check(same(titles(tied), { draw_1: "(RED)", draw_2: "Star" }), "a full tie pairs in order, each draw with a work of its own");
check(same(titles([...tied].reverse()), titles(tied)) && same(titles([tied[2], tied[0], tied[3], tied[1]]), titles(tied)), "whatever order the rows come in");

// a second draw run for the same work (Jammie Holmes' Fred): both are Fred's
const rerun = [row("JH", "draw_a", "Fred", 37, 0, 39, 55), row("JH", "draw_b", "Fred", 1, 0, 1, 13)];
check(same(titles(rerun), { draw_a: "Fred", draw_b: "Fred" }), "two draws for one work both take it");
// and stay on it when a few of the second draw's people also touch a work no draw has
const rerunPlus = [...rerun, row("JH", "draw_b", "Poster", 0, 1, 1, 13)];
check(same(titles(rerunPlus), { draw_a: "Fred", draw_b: "Fred" }), "a thin trace of another work does not pull a second draw off its own");
// but a draw whose people are as much on a free work as on the taken one moves to it
const near = [row("R", "d1", "A", 0, 40, 0, 40), row("R", "d2", "A", 0, 30, 0, 30), row("R", "d2", "B", 0, 29, 0, 30)];
check(same(titles(near), { d1: "A", d2: "B" }), "a near tie gives way to the draw with nowhere else to go");

// one of a draw's winners bought the other work in the private room before
// anyone has claimed: one paid order used to name the draw, over fifty
// entrants holding drafts on its own work
const privateRoom = [
  row("R", "d1", "W1", 0, 50, 10, 50), row("R", "d1", "W2", 1, 20, 10, 50),
  row("R", "d2", "W2", 0, 40, 0, 40), row("R", "d2", "W1", 0, 20, 0, 40),
];
check(same(titles(privateRoom), { d1: "W1", d2: "W2" }), "a private-room purchase does not outvote the draw's own entrants");

// overlapping draws with a little noise: draw d1's people are a shade more on
// d2's work than on their own, and d2's are all on theirs. Read alone d1
// takes W2 too; together each has its own.
const noisy = [
  row("R", "d1", "W1", 0, 97, 0, 102), row("R", "d1", "W2", 0, 100, 0, 102),
  row("R", "d2", "W1", 0, 95, 0, 103), row("R", "d2", "W2", 0, 103, 0, 103),
];
check(same(titles(noisy), { d1: "W1", d2: "W2" }), "the pairing that fits best in total, not each draw's own top");

// an older launch has only its winners' paid orders: the product most of them paid for, as before
const older = [
  row("AM", "d1", "Hurriya", 5, 0, 5, 9), row("AM", "d1", "Ray", 2, 0, 5, 9), row("AM", "d1", "Salam", 2, 0, 5, 9),
  row("AM", "d2", "Salam", 11, 0, 11, 23), row("AM", "d2", "Ray", 2, 0, 11, 23), row("AM", "d2", "Hurriya", 1, 0, 11, 23),
  row("AM", "d3", "Ray", 6, 0, 6, 10), row("AM", "d3", "Hurriya", 2, 0, 6, 10), row("AM", "d3", "Salam", 3, 0, 6, 10),
];
check(same(titles(older), { d1: "Hurriya", d2: "Salam", d3: "Ray" }), "winners' paid orders alone pair as they always did");
check(same(pairDraws(older).map((r) => [r.orders, r.share]), [[5, 0.556], [11, 0.786], [6, 0.545]]), "with the orders and the share of the winners' reading");

// nested draws: everyone in the small draws is in the bigger ones too
const nested = [
  row("N", "d1", "W1", 0, 3, 0, 3), row("N", "d1", "W2", 0, 2, 0, 3), row("N", "d1", "W3", 0, 1, 0, 3),
  row("N", "d2", "W1", 0, 2, 0, 2), row("N", "d2", "W2", 0, 2, 0, 2), row("N", "d2", "W3", 0, 1, 0, 2),
  row("N", "d3", "W1", 0, 1, 0, 1), row("N", "d3", "W2", 0, 1, 0, 1), row("N", "d3", "W3", 0, 1, 0, 1),
];
check(same(titles(nested), { d1: "W1", d2: "W2", d3: "W3" }), "nested draws each find their own work");

// releases are paired apart, a draw with no evidence is not paired at all,
// and the cells may come as BigQuery sends them, as text
const mixed = [
  { release: "A", draw_id: "d1", product_title: "One", won_paid: "3", held: "0", winners: "4", entrants: "9" },
  { release: "B", draw_id: "d1", product_title: "One", won_paid: "0", held: "2", winners: "0", entrants: "2" },
  { release: "B", draw_id: "d9", product_title: "One", won_paid: "0", held: "0", winners: "0", entrants: "5" },
  null, { release: "B", draw_id: null, product_title: "One" },
];
check(same(pairDraws(mixed).map((r) => [r.release, r.draw_id, r.product_title, r.orders, r.share]), [["A", "d1", "One", 3, 1], ["B", "d1", "One", 2, 1]]),
  "one release never takes from another, and no evidence is no pairing");
check(same(pairDraws([]), []) && same(pairDraws(null), []), "nothing in, nothing out");

// a launch of many works whose first entrants are in every draw: each draw
// still gets a work of its own, in order, at once
const many = [];
for (let d = 0; d < 23; d++) for (let w = 0; w < 23; w++) many.push(row("P", `draw_${String(d).padStart(2, "0")}`, `Work ${String(w).padStart(2, "0")}`, 0, 4, 0, 4));
const t0 = Date.now();
const got = titles(many);
check(Object.keys(got).length === 23 && Object.entries(got).every(([d, t]) => d.slice(-2) === t.slice(-2)) && Date.now() - t0 < 2000,
  "twenty-three tied draws pair in order, quickly");

// the fit: the share of the winners who paid plus the share of the entrants who hold, each capped at the whole
check(fit(row("R", "d", "W", 1, 2, 1, 3)) === 1 + 2 / 3 && fit(row("R", "d", "W", 0, 0, 5, 5)) === 0 && fit(row("R", "d", "W", 9, 0, 3, 0)) === 1, "the fit is two shares of the draw's own people");
check(SHARED_COST > 0 && SHARED_COST < 1, "sharing a work costs less than a whole draw's fit, and more than nothing");
check(same(assign([[4, 1, 3], [2, 0, 5]]), [1, 0]), "the assignment is the cheapest in total");

// the pull: the query's rows are kept, not written, under the file's header;
// the claims keep the row on each draw's own product
const kept = [];
const w = bq.drawEvidenceWriter(kept)(bq.DRAW_EVIDENCE_HEADER);
check(w.header === bq.DRAW_PRODUCTS_HEADER.join(",") && w.row(["HM", "draw_1", "Star", "0", "2", "0", "2"]) === null
  && same(kept, [{ release: "HM", draw_id: "draw_1", product_title: "Star", won_paid: "0", held: "2", winners: "0", entrants: "2" }]),
  "the evidence is held back and the file keeps its own columns");
let threw = false;
try { bq.drawEvidenceWriter([])(bq.DRAW_PRODUCTS_HEADER); } catch { threw = true; }
check(threw, "other columns than the evidence's are a failed pull");
const cw = bq.drawClaimsWriter(pairDraws(harland))(bq.DRAW_CLAIMS_HEADER);
check(cw.row(["HM", "draw_2", "(RED)", "1", "1"]) === "HM,draw_2,(RED),1,1" && cw.row(["HM", "draw_2", "Star", "1", "1"]) === null
  && cw.row(["HM", "draw_1", "(RED)", "1", "1"]) === null && cw.row(["HM", "draw_1", "Star", "2", "2"]) === "HM,draw_1,Star,2,2",
  "a claim counts on the draw's own product only");
check(bq.drawClaimsWriter([])(bq.DRAW_CLAIMS_HEADER).row(["HM", "draw_1", "Star", "1", "1"]) === null, "and on none where the draw has no pairing");

console.log(failed ? `${failed} check(s) failed` : "ok: draw pairs");
process.exit(failed ? 1 : 0);
