/* The explainer's working for the paid spend at close and the waterfall's
 * steps (web/src/explain/explanations.mjs paid.spend, wf.step) on the
 * committed snapshots, with the build's newer fields laid over them where a
 * snapshot predates them:
 * - spend at close: the spend to date (today so far included), the last full
 *   day's spend over the full days after today, and the rest of today, in
 *   parts that add up to the total printed;
 * - the Paid spend step reads the spend to date, not the full days alone;
 * - at close, a closed release's walk is its walk to date (no factor), a live
 *   one's is scaled by the build's own factor, or shared out by size.
 *   node tests/explain_paid_wf.mjs */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { explain } from "../web/src/explain/explanations.mjs";
import { fmt } from "../web/src/format.mjs";

const root = new URL("../data/app/releases/", import.meta.url);
const load = (id) => JSON.parse(readFileSync(new URL(`${id}.json`, root), "utf8"));
const text = (ex) => ex.steps.map((st) => st.map((x) => (typeof x === "string" ? x : x.d)).join("")).join(" | ");
const euros = (s) => [...s.matchAll(/€([\d,]+)(?![\d,]*\.\d)/g)].map((m) => Number(m[1].replace(/,/g, "")));

/* ---- Warhol, 24 Sep: part way through day 21 of 27 */
const w = load("warhol_le_26");
assert.ok(w.asOfFraction < 1 && !w.complete && (w.paid.daily || []).some((d) => d.partial), "a live page on a part day");
const days = w.of - w.day, rest = 1 - w.asOfFraction, rate = w.paid.budget.current;
const total = w.paid.spendToDate + rate * (days + rest);
const ws = { ...w, paid: { ...w.paid, spendProjectedTotal: Math.round(total * 100) / 100 } };
const sp = explain("paid.spend", { close: true }, { snap: ws });
const parts = sp.steps.map((st) => euros(st.map((x) => (typeof x === "string" ? x : x.d)).join("")).at(-1));
assert.strictEqual(parts.length, 3, `start, the full days after today, the rest of today: ${text(sp)}`);
assert.strictEqual(parts[0], Math.round(w.paid.spendToDate), "the spend to date the card prints");
assert.strictEqual(parts.reduce((a, b) => a + b, 0), Math.round(total), `the parts add up to the total: ${parts} vs ${fmt(total)}`);
assert.ok(text(sp).includes(`for each of the ${days} days after today`) && text(sp).includes("today still to come"), text(sp));
assert.strictEqual(sp.value, "€" + fmt(total), "the figure printed");

/* the Paid spend step: the spend to date, today so far included */
for (const close of [false, true]) {
  const ex = explain("wf.step", { key: "paid_spend", close }, { snap: w });
  assert.ok(text(ex).includes(`€${fmt(w.paid.spendToDate)} to date, today so far included`), text(ex));
  assert.ok(!text(ex).includes("full days"), "not the full days alone");
}

/* ---- at close: the build's factor, or the rest shared out by size */
const scaled = explain("wf.step", { key: "organic_traffic", close: true }, { snap: { ...w, waterfall: { ...w.waterfall, closeScaleBm: 1.8634 } } });
assert.ok(text(scaled).includes("×1.86"), text(scaled));
const shared = explain("wf.step", { key: "organic_traffic", close: true }, { snap: { ...w, waterfall: { ...w.waterfall, closeScaleBm: null } } });
assert.ok(text(shared).includes("shared over the four in proportion to their size to date") && !text(shared).includes("×"), text(shared));

/* ---- a closed release: its walk at close is its walk to date */
for (const id of ["parra_le_26", "glennligon_le_26"]) {
  const s = load(id);
  assert.ok(s.complete, `${id} has closed`);
  for (const key of ["organic_traffic", "organic_conversion", "paid_spend", "paid_efficiency"]) {
    const ex = explain("wf.step", { key, close: true }, { snap: s });
    assert.ok(text(ex).includes("its walk at close is its walk to date") && !text(ex).includes("scaled by"), `${id} ${key}: ${text(ex)}`);
  }
}
console.log("explain paid and waterfall: ok");
