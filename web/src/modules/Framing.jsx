/* Framing: frames per print on the prints a frame was on offer for
 * (docs/DATA_MODEL.md 6.4). The head counts the same units as the
 * sell-through card beside it at the page's horizon: the paid prints and
 * the frames bought with them, the drafts awaiting payment and the frames
 * on them, the draw's forecast conversions at the rate the entrants ask
 * for (framing.forecast); a snapshot built before the forecast heads the
 * card with the paid prints' rate. Below it a bar per work, on the same
 * units as the head (framing.forecast.products at the horizon, in the
 * sell-through's order), so the bars add up to it; without the forecast's
 * rows, each work's paid prints (framing.works). The basket's take-up is a
 * dotted mark on every bar. The two readings the head is made of, the
 * buyers' prints and the prints the people still in the draw have
 * pre-authorised (on a timed launch the window's orders awaiting payment),
 * are in the head's hover, with the count behind the rate (the head is the
 * rate alone since 13 November 2026). No plan and no target: the card reads what is.
 * With nothing on the release offered a frame the card stays on the page
 * and says so: "No framing", or "No framing yet" while a frame is on offer
 * and nothing has sold. */
import React from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, COL, sw, lk } from "../charts.jsx";
import { fmt, fmtPct } from "../format.mjs";
import { namesTitle, shownNames } from "../workGroups.mjs";

const has = (v) => v !== null && v !== undefined;
const MAX = 22;
/* the works' names for the axis: a variant by its variant alone ("White
 * Portrait" of "Brillo Box Collectable (White Portrait)"), and a long name
 * cut short, keeping its last word where the cut would leave two works
 * reading the same ("... I", "... II") */
function axisNames(works) {
  const names = shownNames(works.map((w, i) => ({ key: i, name: w.name }))).names.map((n) => String(n || ""));
  const cut = names.map((n) => (n.length > MAX ? n.slice(0, MAX - 1).trimEnd() + "…" : n));
  return names.map((n, i) => {
    if (n.length <= MAX || cut.filter((c) => c === cut[i]).length < 2) return cut[i];
    const tail = n.split(/\s+/).pop().slice(-8);
    return n.slice(0, Math.max(4, MAX - 2 - tail.length)).trimEnd() + "… " + tail;
  });
}

export default function Framing({ snap, horizon = "today" }) {
  const f = snap.framing;
  if (!f || (!(f.prints > 0) && !f.entrants)) {
    const offered = !(snap.economics && snap.economics.framingAvailable === false);
    const sold = (snap.sellthrough && snap.sellthrough.sold) || (snap.sales && snap.sales.units) || 0;
    return <Card title="Framing" aria="Framing: none"><div className="empty-state">{offered && !(sold > 0) ? "No framing yet" : "No framing"}</div></Card>;
  }
  const tl = !!f.tl;
  const close = horizon === "close";
  const rate = f.rate ?? null;
  const ent = f.entrants;
  const notOffered = f.notOffered || { units: 0, works: [] };
  const fc = f.forecast && f.forecast[close ? "close" : "today"];
  const head = fc && fc.prints > 0 && has(fc.rate) ? fc : null;
  const headRate = head ? head.rate : rate;
  const leftOut = head ? head.notOffered ?? 0 : notOffered.units;
  const basket = f.benchmark && has(f.benchmark.rate) ? f.benchmark.rate : null;
  const at = close ? "close" : "today";
  const paidWorks = (f.works || []).filter((w) => w.prints > 0 && has(w.rate));
  // the two readings the head is made of, for its hover
  const readings = [
    ...(rate !== null ? [`${tl ? "Paid" : "Buyers"}: ${fmt(f.frames)} of ${fmt(f.prints)} paid prints · ${fmtPct(rate)}`] : []),
    ...(ent ? [`${tl ? "Awaiting payment" : f.entrantsLabel || "Entrants"}: ${fmt(ent.frames)} of ${fmt(ent.prints)} ${tl ? "prints on orders not yet paid" : "prints pre-authorised"} · ${fmtPct(ent.rate ?? 0)}`] : []),
  ];
  const headTip = [head
    ? `Frames on the prints the sell-through counts ${close ? "at close" : "today"}: paid, awaiting payment and expected from the draw. A frame per print at most.`
    : "Frames bought with the prints sold, over the prints a frame was on offer for", ...(head ? readings : [])].join("\n");
  // a bar per work: on the head's units where the forecast has the works, else on the paid prints
  const fcWorks = head ? (f.forecast.products || []).map((r) => ({ name: r.name, ...(r[at] || {}) })).filter((w) => w.prints > 0 && has(w.rate)) : [];
  const onHead = fcWorks.length > 0;
  // nothing by work to draw (a release read as one row, or only pre-authorisations so far): the release as one bar
  const whole = headRate !== null ? [{ name: "All works", prints: head ? head.prints : f.prints, frames: head ? head.frames : f.frames, rate: headRate }]
    : ent && has(ent.rate) ? [{ name: tl ? "Awaiting payment" : f.entrantsLabel || "Entrants", prints: ent.prints, frames: ent.frames, rate: ent.rate }] : [];
  const works = onHead ? fcWorks : paidWorks.length ? paidWorks : whole;
  const unit = onHead || (!paidWorks.length && head) ? `prints${close ? " at close" : ""}` : paidWorks.length || rate !== null ? "paid prints" : tl ? "prints on orders not yet paid" : "prints pre-authorised";
  const labels = axisNames(works);
  const rows = works.map((w, i) => {
    const paid = onHead ? paidWorks.find((x) => namesTitle(w.name, x.name)) : null;
    return { name: w.name, label: labels[i], v: w.rate * 100, n: `${fmt(w.frames)} of ${fmt(w.prints)} ${unit}`,
      tip: paid && Math.round(paid.prints) !== Math.round(w.prints) ? [{ n: "Paid so far", v: `${fmt(paid.frames)} of ${fmt(paid.prints)} · ${fmtPct(paid.rate)}`, k: { width: 8, flex: "0 0 8px" } }] : [] };
  });
  return (
    <Card title="Framing" aria="Framing: frames per print, by work">
      <Head v={headRate !== null ? fmtPct(headRate) : "–"} u="framed"
        tip={[head ? `${fmt(head.frames)} of ${fmt(head.prints)} prints${close ? " at close" : ""}` : rate !== null ? `${fmt(f.frames)} of ${fmt(f.prints)} paid prints` : "No prints sold yet", headTip].join("\n")} />
      {rows.length > 0 && (
        <HBarChart H={34 + rows.length * 34} L={150} bh={12} xmin={0} xmax={100} xticks={[0, 25, 50, 75, 100]} xfmt={(t) => `${t}%`}
          rows={rows.map((r) => r.label)}
          series={[{ color: COL.IND, vals: rows.map((r) => r.v) }, { color: COL.TRACK, vals: rows.map((r) => Math.max(0, 100 - r.v)) }]}
          ticks={basket !== null ? rows.map(() => basket * 100) : undefined} tickDa="1 3"
          legend={[{ n: "Framed", k: sw(COL.IND) }, { n: "Not framed", k: sw(COL.TRACK) },
            ...(basket !== null ? [{ n: "Basket", v: fmtPct(basket), k: lk(COL.INK, "dotted"), tip: `The basket's frames per print, over ${fmt(f.benchmark.n)} of its ${fmt(f.benchmark.of)} launches with a frame on offer` }] : []),
            ...(Math.round(leftOut) > 0 ? [{ n: "No frame on offer", v: `${fmt(leftOut)} units`, k: { width: 8, flex: "0 0 8px" }, tip: notOffered.works.length ? notOffered.works.join(", ") : undefined }] : [])]}
          title={(i) => `${rows[i].name} · ${rows[i].n}`}
          rows2={(i) => [{ n: "Framed", v: fmtPct(rows[i].v / 100), k: sw(COL.IND) }, ...rows[i].tip, ...(basket !== null ? [{ n: "Basket", v: fmtPct(basket), k: lk(COL.INK, "dotted") }] : [])]}
          aria={`Framing by work: ${rows.map((r) => `${r.name} ${fmtPct(r.v / 100)}`).join(", ")}`} />
      )}
    </Card>
  );
}
