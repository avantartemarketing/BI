/* The explainer (web/src/explain): every builder against every snapshot on
 * file, both ways Direct can be read. Each explanation has to land on the
 * figure its card prints, name only sources the catalogue knows, drill only
 * into explanations that exist on the same page, add its parts up to the
 * figure, and read cleanly: no em dash, no "undefined", no NaN. */
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { EXPLAIN, explain, asText, roundParts } from "../web/src/explain/explanations.mjs";
import { SOURCES, sourceRow } from "../web/src/explain/sources.mjs";
import { fmt, fmtPct, fmtSigned } from "../web/src/format.mjs";

const root = new URL("../data/app/", import.meta.url);
const files = [
  ...readdirSync(new URL("releases/", root)).filter((f) => f.endsWith(".json")).map((f) => new URL(`releases/${f}`, root)),
  ...readdirSync(new URL("derived/", root)).filter((f) => f.endsWith(".json")).map((f) => new URL(`derived/${f}`, root)),
];
assert.ok(files.length >= 5, "the snapshots on file");

/* ---- roundParts: whole parts that add up to the rounded whole ---- */
for (const [vals, total] of [[[705, 29, 161.2], 895.2], [[301.4, 26.4, 1.4, 271.7, 204.7], 805.6], [[0.4, 0.4, 0.4], 1.2], [[10, 20], 30]]) {
  const r = roundParts(vals, total);
  assert.strictEqual(r.reduce((a, b) => a + b, 0), Math.round(total), `roundParts ${vals} -> ${r}`);
  r.forEach((x, i) => assert.ok(Math.abs(x - vals[i]) < 1, `a part moves by less than one: ${vals[i]} -> ${x}`));
}
// a tie goes to the larger value, where one unit moves the figure least
assert.deepStrictEqual(roundParts([301.4, 26.4, 1.4, 271.7, 204.7], 805.6), [302, 26, 1, 272, 205]);

const BAD = /\u2014|undefined|NaN|\bnull\b|\[object/;
const textOf = (ex) => [
  ex.where, ex.when, ex.name, ex.value, ex.unit, ex.say, ex.method,
  ...ex.steps.flat().map((x) => (typeof x === "string" ? x : x.d)),
  ...(ex.total ? [ex.total.v, ex.total.label] : []),
  ...(ex.compare || []).flatMap((c) => [c.label, c.v, c.note]),
  ...ex.sources.map((r) => r.gave), ...(ex.notes || []),
].filter((x) => x !== null && x !== undefined).join(" | ");

/* The cases a page offers: every figure the cards mark, with the args they pass. */
function cases(s) {
  const out = [];
  const both = (k, extra = {}) => { out.push([k, { ...extra, close: false }]); out.push([k, { ...extra, close: true }]); };
  for (const k of ["hero.fill", "hero.target", "hero.bm", "hero.delta", "st.head", "framing.head", "paid.units", "paid.spend", "wf.stretch", "wf.net"]) both(k);
  for (const k of ["hero.secured", "hero.proj", "release.target", "release.edition", "hero.over", "k", "st.draw", "st.paid", "st.drafts", "st.future",
    "framing.buyers", "framing.entrants", "framing.plan", "framing.bm", "paid.rec", "paid.current", "launch.days"]) out.push([k, {}]);
  for (const party of ["aa", "artist"]) for (const whole of [false, true]) out.push(["paid.roi", { party, whole }]);
  for (const whole of [false, true]) out.push(["paid.cpe", { whole }]);
  for (const c of s.channels || []) {
    both("channel.pct", { key: c.key });
    both("wf.channel", { key: c.key });
    out.push(["traj.end", { sel: c.key }]);
    out.push(["traj.group", { key: c.key, value: c.proj, total: (s.hero || {}).projected, ahead: true }]);
    out.push(["drivers.step", { key: c.key, step: "Traffic" }]);
    out.push(["drivers.step", { key: c.key, step: "Conversion" }]);
    const g = (s.funnelByGroup || {})[c.key];
    const k = s.benchmark && s.benchmark.k;
    if (g && s.benchmark) out.push(["funnel.rung", { group: c.name, label: "Sessions", kind: "vol", unit: "count", v: g.sessions_actual, target: g.sessions_benchmark * k, bm: g.sessions_benchmark, k }]);
  }
  out.push(["traj.end", { sel: "all" }]);
  for (const p of (s.sellthrough && s.sellthrough.products) || []) both("st.row", { key: p.key });
  for (const h of ["today", "close"]) {
    const wf = s.waterfall;
    const v = wf && (h === "today" ? wf.today || wf : wf);
    for (const st of [...((v && v.steps) || []), ...((v && v.stepsBm) || [])]) out.push(["wf.step", { key: st.key, close: h === "close" }]);
  }
  return out;
}

let checked = 0, shown = 0;
for (const f of files) {
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const views = [raw, ...(raw.variants && raw.variants.direct_spread ? [{ ...raw, ...raw.variants.direct_spread }] : [])];
  for (const s of views) {
    const ctx = { snap: s, st: null };
    const h = s.hero || {};
    for (const [k, arg] of cases(s)) {
      assert.ok(EXPLAIN[k], `${k} has a builder`);
      let ex;
      try { ex = EXPLAIN[k](arg, ctx); } catch (e) { assert.fail(`${s.id} ${k} ${JSON.stringify(arg)} threw: ${e.stack}`); }
      checked++;
      if (!ex) continue;
      shown++;
      const where = `${s.id} ${k} ${JSON.stringify(arg)}`;
      for (const field of ["where", "name", "value", "unit", "say", "method"]) assert.strictEqual(typeof ex[field], "string", `${where}: ${field}`);
      assert.ok(Array.isArray(ex.steps) && ex.steps.length > 0, `${where}: steps`);
      for (const st of ex.steps) {
        assert.ok(Array.isArray(st) && st.length > 0, `${where}: a step is segments`);
        for (const x of st) {
          if (typeof x === "string") continue;
          assert.ok(x && typeof x.d === "string" && EXPLAIN[x.k], `${where}: drill ${JSON.stringify(x)}`);
          assert.ok(explain(x.k, x.arg, ctx), `${where}: the drill to ${x.k} leads somewhere`);
        }
      }
      for (const c of ex.compare || []) {
        if (c.k) assert.ok(explain(c.k, c.arg, ctx), `${where}: the comparison's link to ${c.k} leads somewhere`);
      }
      assert.ok(ex.sources.length > 0, `${where}: names a source`);
      for (const r of ex.sources) {
        assert.ok(SOURCES[r.key], `${where}: source ${r.key} is catalogued`);
        const row = sourceRow(r, s, null);
        assert.ok(row.name && typeof row.via === "string" && (row.fresh || row.set), `${where}: source ${r.key} reads fresh or set`);
      }
      if (ex.total) assert.ok(ex.value.includes(ex.total.v), `${where}: the total ${ex.total.v} is the figure ${ex.value}`);
      const text = textOf(ex);
      assert.ok(!BAD.test(text), `${where}: reads cleanly: ${text.match(BAD)} in ${text}`);
      const copy = asText(ex, { release: `${s.artist} - ${s.title}`, asOf: "24 Sep", sources: ex.sources.map((r) => sourceRow(r, s, null)) });
      assert.ok(!BAD.test(copy), `${where}: the copied text reads cleanly`);

      // the figure the card prints
      const close = !!arg.close;
      const expect = {
        "hero.fill": () => fmt(close ? h.projected : h.now),
        "hero.secured": () => fmt(h.now),
        "hero.proj": () => fmt(h.projected),
        "hero.target": () => fmt(close ? (s.edition && s.edition.target) ?? h.target : h.expectedToday),
        "hero.bm": () => fmt(close ? h.benchmark : h.benchmarkToday),
        "release.target": () => fmt((s.edition && s.edition.target) ?? h.target),
        "st.draw": () => fmt(s.sellthrough.soldPredicted),
        "st.paid": () => fmt(s.sellthrough.sold),
        "paid.rec": () => "€" + fmt(Math.round(s.paid.budget.recommended)),
        "framing.buyers": () => fmtPct(s.framing.rate),
        "framing.plan": () => fmtPct(s.framing.plan),
        "channel.pct": () => {
          const c = s.channels.find((x) => x.key === arg.key);
          return Math.round(((close ? c.proj : c.now) / (close ? c.target : c.exp)) * 100) + "%";
        },
        "paid.roi": () => {
          if (s.targeted === false) return "€" + fmt(arg.whole || s.complete ? s.paid.cumCpe : s.paid.l3dCpe, 2);
          const v = arg.party === "artist" ? s.paid.artist : s.paid;
          return fmt(arg.whole || s.complete ? v.cumRoi : v.l3dRoi, 2);
        },
        "st.head": () => {
          const st = s.sellthrough, ed = st.edition;
          const units = st.sold + (st.drafts ?? 0) + (st.soldPredicted ?? 0);
          const head = close ? st.pct ?? 0 : Math.min(units / ed, 1);
          return ed ? Math.round(head * 100) + "%" : null;
        },
        "st.row": () => {
          const r = s.sellthrough.products.find((p) => p.key === arg.key);
          const p = close ? r.pctClose : r.pct;
          return p === null || p === undefined ? null : Math.round(p * 100) + "%";
        },
        "framing.head": () => {
          const fc = s.framing.forecast && s.framing.forecast[close ? "close" : "today"];
          return fmtPct(fc && fc.prints > 0 && fc.rate !== null ? fc.rate : s.framing.rate);
        },
        "wf.step": () => {
          const wf = s.waterfall, v = !close && wf.today ? wf.today : wf;
          const steps = s.benchmark && Array.isArray(v.stepsBm) ? v.stepsBm : v.steps;
          return fmtSigned(steps.find((x) => x.key === arg.key).value);
        },
        "hero.delta": () => fmtSigned(Math.round(close ? h.projected : h.now) - Math.round(close ? h.target : h.expectedToday)),
      }[k];
      let want;
      try { want = expect ? expect() : undefined; } catch { want = undefined; }   // the card shows no figure there
      if (want !== undefined && want !== null) assert.strictEqual(ex.value, want, `${where}: prints ${ex.value}, the card prints ${want}`);
    }
  }
}
assert.ok(shown > 300, `explanations shown: ${shown} of ${checked}`);

/* ---- a feed the last refresh reported failing turns its sources amber ---- */
const w = JSON.parse(readFileSync(new URL("releases/warhol_le_26.json", root), "utf8"));
const ok = sourceRow({ key: "orders", gave: "x" }, w, { bigquery: "ok: 12 rows" });
const bad = sourceRow({ key: "orders", gave: "x" }, w, { bigquery: "failed: token expired" });
assert.strictEqual(ok.warn, null);
assert.strictEqual(bad.warn, "last refresh failed");
assert.strictEqual(sourceRow({ key: "settings", gave: "x" }, w, { bigquery: "failed" }).warn, null, "an input set here has no feed to fail");

/* ---- the Warhol page, figure by figure, as the design showed it ---- */
const wctx = { snap: w, st: null };
const secured = explain("hero.secured", {}, wctx);
assert.strictEqual(secured.value, "895");
const segText = (st) => st.map((x) => (typeof x === "string" ? x : x.d)).join("");
assert.deepStrictEqual(secured.steps.map(segText).map((t) => Number(t.match(/[\d,]+(?= units)/)[0].replace(/,/g, ""))), [705, 29, 161],
  "units paid, drafts and the draw's expected orders");
assert.strictEqual(705 + 29 + 161, 895, "and they add up to the figure");
const proj = explain("hero.proj", {}, wctx);
const projParts = proj.steps.map(segText).map((t) => Number((t.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")));
assert.strictEqual(projParts.reduce((a, b) => a + b, 0), 1449, `the projection's steps add up: ${projParts}`);
const roi = explain("paid.roi", { party: "aa" }, wctx);
assert.strictEqual(roi.value, "1.79");
assert.ok(segText(roi.steps[2]).includes("€751.34"), "the ROI divides by the last three days' cost per converting entry");
const cpe = explain("paid.cpe", {}, wctx);
assert.ok(segText(cpe.steps[0]).includes("21 Sep to 23 Sep"), "the last three full days");
assert.strictEqual(explain("paid.rec", {}, wctx).value, "€28,281");
assert.ok(segText(explain("paid.rec", {}, wctx).steps.at(-1)).includes("× 1.3"), "held by the pacing rule");
assert.strictEqual(explain("launch.days", {}, wctx).value, "6 days");
assert.strictEqual(explain("nonsense", {}, wctx), null, "an unknown figure explains nothing");

console.log(`explain: ${shown} explanations of ${checked} figures across ${files.length} snapshots ok`);
