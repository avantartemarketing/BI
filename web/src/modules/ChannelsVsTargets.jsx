/* Units by channel: the five channel groups as columns, each the reference as
 * a dotted outline on a faint tint, a little wider than the indigo actual
 * inside it, which rises past the outline when over (5 November 2026). The
 * reference is the target or the benchmark, whichever the
 * page's Compare to switch reads against, never both (3 November 2026). Today compares each group's
 * units to date (c.now) with its target by today (c.exp) and the basket's
 * by today (c.bmExp); at close the projection (c.proj) with the full target
 * and benchmark (docs 5.4, 9). The card's menu swaps the units scale for
 * every channel against its own target on one 100% line. A release with no
 * targets shows the units alone. */
import React, { useState } from "react";
import { Card, Head, vsDelta } from "../ui.jsx";
import { ColChart, niceAxis, kfmt, COL, sw, ol } from "../charts.jsx";
import { fmt } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";

/* the column labels, the two organic groups on two lines so six columns fit a
 * half-width card; a key not listed (a page built before the 9 November 2026
 * split, until the refresh rebuilds it) reads the snapshot's own name */
const SHORT = { aa_email: "Email", aa_social: "Meta", referral_artist: "Artist", organic_search: ["Organic", "Search"], organic_other: ["Organic", "Other"], paid: "Paid" };
const has = (v) => v !== null && v !== undefined;
const unit = (v) => fmt(v, v < 10 && v > 0 ? 1 : 0);
const diff = (a, b) => { if (!(b > 0)) return ""; const p = Math.round((a / b - 1) * 100); return `  ${p >= 0 ? "+" : "−"}${Math.abs(p)}%`; };

export default function ChannelsVsTargets({ snap, vs = "target", horizon = "today" }) {
  const [scale, setScale] = useState("units");
  const rows = snap.channels || [];
  const byBm = vs === "benchmark" && !!snap.benchmark;
  const targeted = snap.targeted !== false || byBm;
  const complete = !!snap.complete;
  const today = horizon !== "close" && !complete;
  const refWord = byBm ? "benchmark" : "target";
  const RefName = byBm ? "Benchmark" : "Target";
  const W = wordsOf(snap);
  const off = new Set((snap.benchmark && snap.benchmark.channelsOff) || []);
  const base = rows.map((c) => {
    const ref = !targeted ? 0 : byBm ? (today ? c.bmExp : c.bm) : (today ? c.exp : c.target);
    return { key: c.key, name: c.name, parts: c.parts || [], bar: (today ? c.now : c.proj) ?? 0, target: ref ?? 0 };
  });
  const pct = targeted && scale === "pct";
  const val = (v, t) => (pct ? (t > 0 ? (v / t) * 100 : 0) : v);
  const data = base.map((r) => [r.name, val(r.bar, r.target), pct ? (r.target > 0 ? 100 : 0) : r.target, null]);
  const top = Math.max(1, ...data.flatMap((r) => [r[1], r[2]]));
  const ax = pct ? { ymax: Math.max(100, Math.ceil(top / 50) * 50), ticks: [0, 50, 100, 150, 200, 250, 300].filter((t) => t <= Math.max(100, Math.ceil(top / 50) * 50)) } : niceAxis(top);
  const total = base.reduce((a, r) => a + r.bar, 0), totalT = base.reduce((a, r) => a + r.target, 0);
  const when = today ? "today" : "at close";
  const title = `${W.Unit} by channel`;
  const menu = targeted ? [
    { label: W.Unit, radio: true, checked: !pct, onClick: () => setScale("units") },
    { label: `% of ${refWord}`, radio: true, checked: pct, onClick: () => setScale("pct") },
  ] : undefined;
  if (!base.length) return <Card title={title} menu={menu}><div className="empty-state">No channel data yet</div></Card>;
  return (
    <Card title={title} menu={menu} aria={`${title} against ${refWord} ${when}`}>
      <Head v={fmt(total)} u={W.unit}
        deltas={[targeted ? vsDelta(total, totalT, refWord, `${fmt(total)} ${W.unit} ${today ? "to date" : "projected"} against the ${fmt(totalT)} ${refWord} ${when}`) : null]}
        aside={targeted ? "" : "no targets"} asideTip={targeted ? undefined : "No targets set, so the columns are the units alone"} />
      <ColChart H={250} L={pct ? 36 : 30} ymax={ax.ymax} yticks={ax.ticks} yfmt={pct ? (t) => `${t}%` : kfmt}
        cats={base.map((r) => SHORT[r.key] || r.name)} rows={data} refName={RefName}
        title={(i) => `${base[i].name}, ${when}`}
        tipRows={(i) => {
          const r = base[i];
          const over = r.target > 0 && r.bar > r.target;
          return [
            { n: over ? (today ? `To date, over ${refWord}` : `Projected, over ${refWord}`) : today ? "To date" : "Projected", v: unit(r.bar), k: sw(COL.IND) },
            ...(targeted ? [{ n: off.has(r.key) ? "Not in plan" : RefName, v: off.has(r.key) ? "no target, no benchmark" : unit(r.target) + diff(r.bar, r.target), k: ol() }] : []),
            ...(r.parts.length > 1 ? r.parts.map((p) => ({ n: p.name, v: unit(p.value), k: { width: 8, flex: "0 0 8px" } })) : []),
          ];
        }}
        aria={`${title}: ${base.map((r) => `${r.name} ${unit(r.bar)}${targeted ? ` of ${unit(r.target)} ${refWord}` : ""}`).join(", ")}`} />
    </Card>
  );
}
