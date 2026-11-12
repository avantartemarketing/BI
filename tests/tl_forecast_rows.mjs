/* The timed launch's forecast table (web/src/tlForecastRows.mjs, docs/TL_SPEC.md
 * 4c): the works' rows add up to the release's, a work's signups follow its
 * product page where enough are keyed and the units target where not, and a
 * page with no forecast has no rows.  node tests/tl_forecast_rows.mjs */
import assert from "node:assert";
import { tlForecastRows } from "../web/src/tlForecastRows.mjs";

const near = (a, b) => Math.abs(a - b) < 1e-6;
const works = [
  { key: "a", name: "A", share: 0.75, keyed: 30, su: 15, non: 7.5, units: 22.5, lo: 14, hi: 36, target: 40 },
  { key: "b", name: "B", share: 0.25, keyed: 10, su: 5, non: 2.5, units: 7.5, lo: 5, hi: 12, target: 20 },
];
const snap = (source) => ({
  hero: { now: 100, expectedToday: 80, projected: 999 },
  sellForecast: { source, keyed: 40, unkeyedProduct: 10, releaseSignups: 50, today: { signups: 100 },
    open: { signups: 150, su: 20, non: 10, units: 30, lo: 19, hi: 49, target: 60, works } },
});
for (const source of ["signup pages", "units target"]) {
  const { rows, all } = tlForecastRows(snap(source));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  for (const k of ["signups", "targetToDate", "forecastSignups", "su", "non", "units", "target"]) assert.ok(near(sum(k), all[k]), `${source}: ${k} adds up`);
  assert.strictEqual(all.forecastSignups, 150);   // the forecast's own signups at the open, not the hero's capped projection
}
// keyed by product page: 30 of 40 keyed plus three quarters of the 60 that name no work
assert.ok(near(tlForecastRows(snap("signup pages")).rows[0].signups, 75));
// the target to date follows the units target: 40 of 60
assert.ok(near(tlForecastRows(snap("signup pages")).rows[0].targetToDate, 80 * 40 / 60));
// nothing to forecast against: no rows
assert.deepStrictEqual(tlForecastRows({ hero: { now: 5 } }), { rows: [], all: null });
console.log("tl_forecast_rows: ok");
