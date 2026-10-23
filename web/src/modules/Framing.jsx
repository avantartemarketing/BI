/* Framing: frames per print on the prints a frame was on offer for
 * (docs/DATA_MODEL.md 6.4). The head counts the same units as the
 * sell-through card beside it at the page's horizon: the paid prints and
 * the frames bought with them, the drafts awaiting payment and the frames
 * on them, the draw's forecast conversions at the rate the entrants ask
 * for (framing.forecast); a snapshot built before the forecast heads the
 * card with the paid prints' rate. Below it the two parts as bars: the
 * buyers' prints, and the prints the people still in the draw have
 * pre-authorised (on a timed launch the window's orders awaiting payment),
 * the basket's take-up a dotted mark. No plan and no target: the card reads
 * what is. Off the page when nothing on the release was offered a frame. */
import React from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, COL, sw, lk } from "../charts.jsx";
import { fmt, fmtPct } from "../format.mjs";

const has = (v) => v !== null && v !== undefined;

export default function Framing({ snap, horizon = "today" }) {
  const f = snap.framing;
  if (!f || (!(f.prints > 0) && !f.entrants)) return null;
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
  const byWork = head ? (f.forecast.products || []).map((r) => { const x = r[close ? "close" : "today"]; return `${r.name}: ${x && x.prints > 0 ? `${fmt(x.frames)} of ${fmt(x.prints)} · ${fmtPct(x.rate)}` : "–"}`; }) : [];
  const headTip = head
    ? [`Frames on the prints the sell-through counts ${close ? "at close" : "today"}: paid, awaiting payment and expected from the draw. A frame per print at most.`, ...byWork].join("\n")
    : "Frames bought with the prints sold, over the prints a frame was on offer for";
  const rows = [
    ...(rate !== null ? [{ name: tl ? "Paid" : "Buyers", v: rate * 100, n: `${fmt(f.frames)} of ${fmt(f.prints)} paid prints`,
      tip: (f.works || []).map((w) => ({ n: w.name, v: `${fmt(w.frames)} of ${fmt(w.prints)} · ${fmtPct(w.rate)}`, k: { width: 8, flex: "0 0 8px" } })) }] : []),
    ...(ent ? [{ name: tl ? "Awaiting payment" : f.entrantsLabel || "Entrants", v: (ent.rate ?? 0) * 100, n: `${fmt(ent.frames)} of ${fmt(ent.prints)} ${tl ? "prints on orders not yet paid" : "prints pre-authorised"}`,
      tip: [{ n: tl ? "Prints on orders not yet paid" : "Prints pre-authorised", v: fmt(ent.prints), k: { width: 8, flex: "0 0 8px" } }, { n: "With a frame", v: fmt(ent.frames), k: sw(COL.IND) }] }] : []),
  ];
  return (
    <Card title="Framing" aria="Framing: frames per print">
      <Head v={headRate !== null ? fmtPct(headRate) : "–"} u="framed"
        aside={head ? `${fmt(head.frames)} of ${fmt(head.prints)} prints${close ? " at close" : ""}` : rate !== null ? `${fmt(f.frames)} of ${fmt(f.prints)} paid prints` : "no prints sold yet"}
        asideTip={headTip} />
      {rows.length > 0 && (
        <HBarChart H={34 + rows.length * 34} L={124} bh={12} xmin={0} xmax={100} xticks={[0, 25, 50, 75, 100]} xfmt={(t) => `${t}%`}
          rows={rows.map((r) => r.name)}
          series={[{ color: COL.IND, vals: rows.map((r) => r.v) }, { color: COL.TRACK, vals: rows.map((r) => Math.max(0, 100 - r.v)) }]}
          ticks={basket !== null ? rows.map(() => basket * 100) : undefined} tickDa="1 3"
          legend={[{ n: "Framed", k: sw(COL.IND) }, { n: "Not framed", k: sw(COL.TRACK) },
            ...(basket !== null ? [{ n: "Basket", v: fmtPct(basket), k: lk(COL.INK, "dotted"), tip: `The basket's frames per print, over ${fmt(f.benchmark.n)} of its ${fmt(f.benchmark.of)} launches with a frame on offer` }] : []),
            ...(Math.round(leftOut) > 0 ? [{ n: "No frame on offer", v: `${fmt(leftOut)} units`, k: { width: 8, flex: "0 0 8px" }, tip: notOffered.works.length ? notOffered.works.join(", ") : undefined }] : [])]}
          title={(i) => `${rows[i].name} · ${rows[i].n}`}
          rows2={(i) => [{ n: "Framed", v: fmtPct(rows[i].v / 100), k: sw(COL.IND) }, ...(basket !== null ? [{ n: "Basket", v: fmtPct(basket), k: lk(COL.INK, "dotted") }] : []), ...rows[i].tip]}
          aria={`Framing: ${rows.map((r) => `${r.name} ${fmtPct(r.v / 100)}`).join(", ")}`} />
      )}
    </Card>
  );
}
