/* Framing forecast by work, a timed launch before its window opens: each
 * work's forecast units (the sell-through forecast's) times the release's
 * frame take-up - the works' own from Airtable where set, else the basket's
 * frames per print, else the default. Framed in indigo, the rest on the
 * track; the head carries the total with its range and the take-up. */
import React from "react";
import { Card, Head } from "../ui.jsx";
import { HBarChart, COL, sw } from "../charts.jsx";
import { fmt } from "../format.mjs";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const SRC = { release: "Airtable", basket: "Basket", default: "Default" };
const short = (s) => (s && s.length > 22 ? s.slice(0, 21) + "…" : s || "");

export default function FramingForecast({ snap, horizon = "today" }) {
  const f = snap.sellForecast;
  const H = f ? (horizon === "close" ? f.open : f.today) : null;
  const p = snap.paid || {};
  const rate = finite(p.frameRate) ? p.frameRate : null;
  const share = finite(p.frameShare) ? p.frameShare : 1;
  if (!H || !H.works || !H.works.length || rate === null) {
    return <Card title="Framing forecast by work"><div className="empty-state">No frame take-up to forecast with yet</div></Card>;
  }
  const src = SRC[p.frameRateSource] || "Basket";
  const band = f.band || [0.63, 1.62];
  const works = H.works.map((w) => ({ name: w.name, units: w.units * share, frames: w.units * share * rate }));
  const total = works.reduce((a, w) => a + w.frames, 0);
  const prints = works.reduce((a, w) => a + w.units, 0);
  const xmax = Math.max(1, ...works.map((w) => w.units));
  const top = Math.ceil(xmax / 50) * 50 || 50;
  const ticks = [0, top / 2, top].map((t) => Math.round(t));
  return (
    <Card title="Framing forecast by work">
      <Head v={fmt(total)} u="frames forecast" aside={`${fmt(total * band[0])}–${fmt(total * band[1])} · ${Math.round(rate * 100)}% take-up`}
        asideTip={`Forecast prints times the frame take-up: ${src === "Airtable" ? "Airtable's where set" : src === "Basket" ? "the basket's frames per print" : "the default take-up"}`} />
      <HBarChart H={34 + works.length * 34} L={150} bh={14} xmin={0} xmax={top} xticks={ticks} xfmt={(t) => fmt(t)}
        rows={works.map((w) => short(w.name))}
        series={[{ color: COL.IND, vals: works.map((w) => w.frames) }, { color: COL.TRACK, vals: works.map((w) => w.units - w.frames) }]}
        legend={[{ n: "Framed", v: fmt(total), k: sw(COL.IND) }, { n: "Not framed", v: fmt(prints - total), k: sw(COL.TRACK) }]}
        title={(i) => `${works[i].name} · ${fmt(works[i].units)} prints forecast`}
        rows2={(i) => {
          const w = works[i];
          return [
            { n: "Frames", v: fmt(w.frames), k: sw(COL.IND) },
            { n: "Take-up", v: `${Math.round(rate * 100)}% · ${src}`, k: "" },
            { n: "Range", v: `${fmt(w.frames * band[0])}–${fmt(w.frames * band[1])}`, k: sw(COL.PALE) },
          ];
        }}
        aria={`Frames forecast by work: ${works.map((w) => `${w.name} ${fmt(w.frames)}`).join(", ")}`} />
    </Card>
  );
}
