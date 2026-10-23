/* Funnel by channel: the table beside the email funnel, one row a channel
 * group - sessions and conversion, each against the plan (or the basket when
 * the release has no targets). The card's menu swaps the table for the
 * waterfall reading: the units each channel's traffic and conversion added
 * or cost against the plan. */
import React, { useState } from "react";
import { Card } from "../ui.jsx";
import { HBarChart, COL, sw } from "../charts.jsx";
import { fmt, fmtPct } from "../format.mjs";
import { wordsOf } from "../vocab.mjs";
import { Bars, Frame } from "../icons.jsx";

const GROUPS = [["aa_email", "AA Email"], ["aa_social", "AA Meta"], ["referral_artist", "Artist"], ["search_direct_other", "Direct etc."], ["paid", "Paid"]];
const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const signed = (p) => (p === null ? "–" : `${p >= 0 ? "+" : "−"}${Math.abs(Math.round(p * 100))}%`);
const rel = (a, b) => (finite(a) && finite(b) && b > 0 ? a / b - 1 : null);

export default function FunnelTable({ snap }) {
  const [mode, setMode] = useState("table");
  const fbg = snap.funnelByGroup || {};
  const targeted = snap.targeted !== false && Object.values(fbg).some((g) => finite(g.sessions_expected) && g.sessions_expected > 0);
  const W = wordsOf(snap);
  const refWord = targeted ? "plan" : "basket";
  const rows = GROUPS.map(([k, name]) => {
    const g = fbg[k] || {};
    const sessRef = targeted ? g.sessions_expected : g.sessions_benchmark;
    const convRef = targeted ? g.conv_expected : g.conv_benchmark_today ?? g.conv_benchmark;
    return { k, name, sessions: g.sessions_actual, vsSess: rel(g.sessions_actual, sessRef), conv: g.conv_actual, vsConv: rel(g.conv_actual, convRef),
      traffic: targeted ? g.contrib_traffic : g.contrib_traffic_bm, conversion: targeted ? g.contrib_conversion : g.contrib_conversion_bm };
  }).filter((r) => finite(r.sessions));
  const menu = [
    { label: "Table", radio: true, checked: mode === "table", icon: <Bars />, onClick: () => setMode("table") },
    { label: `Waterfall against the ${refWord}`, radio: true, checked: mode === "waterfall", icon: <Frame />, onClick: () => setMode("waterfall") },
  ];
  if (!rows.length) return <Card title="Funnel by channel" menu={menu}><div className="empty-state">No sessions by channel yet</div></Card>;
  if (mode === "waterfall") {
    const vals = rows.flatMap((r) => [r.traffic || 0, r.conversion || 0]);
    const lim = Math.max(1, ...vals.map((v) => Math.abs(v)));
    const top = Math.ceil(lim / 5) * 5;
    const labels = rows.flatMap((r) => [`${r.name} · traffic`, `${r.name} · conversion`]);
    return (
      <Card title="Funnel by channel" menu={menu}>
        <HBarChart H={34 + labels.length * 26} L={190} bh={10} xmin={-top} xmax={top} xticks={[-top, 0, top]} xfmt={(t) => (t > 0 ? `+${t}` : String(t))}
          rows={labels} diverging vals={vals} posColor={COL.IND} negColor={COL.ORANGE}
          legend={[{ n: `${W.Unit} added`, k: sw(COL.IND) }, { n: `${W.Unit} lost`, k: sw(COL.ORANGE) }]}
          title={(i) => labels[i]}
          rows2={(i) => {
            const r = rows[Math.floor(i / 2)];
            const traffic = i % 2 === 0;
            return [
              { n: traffic ? `Sessions vs ${refWord}` : `Conversion vs ${refWord}`, v: signed(traffic ? r.vsSess : r.vsConv), k: "" },
              { n: `${W.Unit} ${vals[i] >= 0 ? "added" : "lost"}`, v: fmt(Math.abs(vals[i]), 1), k: sw(vals[i] >= 0 ? COL.IND : COL.ORANGE) },
            ];
          }}
          aria={`Units added or lost by each channel's traffic and conversion against the ${refWord}`} />
      </Card>
    );
  }
  return (
    <Card title="Funnel by channel" menu={menu}>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Channel</th><th>Sessions</th><th>vs {refWord}</th><th>Conversion</th><th>vs {refWord}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td>{r.name}</td>
                <td>{fmt(r.sessions)}</td>
                <td className="dim">{signed(r.vsSess)}</td>
                <td>{finite(r.conv) ? fmtPct(r.conv, 2) : "–"}</td>
                <td className="dim">{signed(r.vsConv)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
