/* Draw audit: the allocator tool checked against the admin's draw-entries
 * export. Drop the export for a draw, type the three numbers the tool prints
 * for that product (Sold, Entries, Expected), and the card says how many of
 * the tool's entries can be allocated, how many are winners whose payment
 * failed, and whether the tool allocates more units than there are people.
 * The file is read in the browser and goes nowhere; the card shows counts
 * and draw entry ids, never a name or an email. */
import React, { useState } from "react";
import { Card, C, fmt } from "../ui.jsx";
import { parseCsv, auditExport, compareWithTool, drawIdFromName } from "../../../shared/drawAudit.mjs";

const label = { fontSize: 11.5, color: C.muted, marginBottom: 4 };
const cell = { padding: "6px 10px 6px 0", fontSize: 12.5, borderTop: `1px solid ${C.hairline}` };

function Draw({ item, productName, onTool }) {
  const { audit, tool } = item;
  const cmp = compareWithTool(audit, tool);
  const rows = [
    ["Entries in the export", audit.total],
    ["Claimed winners (the tool removes these as buyers)", audit.claimedWinners],
    ["Left for the tool's list", audit.toolList],
    ["Of which winners whose payment failed" + (audit.cardDeclined ? ` (${audit.cardDeclined} card declined)` : ""), audit.failedWinners],
    ["Of which removed or excluded", audit.flagged],
    ["Of which can still be allocated", audit.allocatable],
  ];
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{productName || item.drawId || item.name}</div>
      <div style={{ fontSize: 11.5, color: C.muted }}>{item.name}{item.drawId && productName ? ` · ${item.drawId}` : ""}</div>
      <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        {[["sold", "Tool: sold"], ["entries", "Tool: entries"], ["expected", "Tool: expected sales"]].map(([k, l]) => (
          <div key={k}>
            <div style={label}>{l}</div>
            <input className="control num" style={{ width: 110 }} value={tool[k]} placeholder="–"
              onChange={(e) => onTool({ ...tool, [k]: e.target.value.replace(/[^0-9]/g, "") })} />
          </div>
        ))}
      </div>
      <table style={{ borderCollapse: "collapse", marginTop: 12, width: "100%", maxWidth: 560 }}>
        <tbody>
          {rows.map(([l, v]) => (
            <tr key={l}><td style={{ ...cell, color: C.muted }}>{l}</td><td style={{ ...cell, textAlign: "right", fontWeight: 600, width: 60 }}>{fmt(v)}</td></tr>
          ))}
          {cmp.allocations !== null && (
            <tr><td style={{ ...cell, color: C.muted }}>Units the tool allocates (expected less sold)</td>
              <td style={{ ...cell, textAlign: "right", fontWeight: 600, color: cmp.excess > 0 ? C.red : C.ink }}>{fmt(cmp.allocations)}</td></tr>
          )}
        </tbody>
      </table>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 10, maxWidth: 640 }}>
        {cmp.lines.map((l, i) => <div key={i} style={i === cmp.lines.length - 1 && cmp.excess > 0 ? { color: C.red, fontWeight: 600 } : undefined}>{l}</div>)}
      </div>
      {audit.ids.failedWinners.length > 0 && (
        <details style={{ marginTop: 8, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: C.muted }}>The {audit.failedWinners} winners whose payment failed, by draw entry id</summary>
          <div style={{ fontFamily: "monospace", fontSize: 11.5, lineHeight: 1.7, marginTop: 4 }}>{audit.ids.failedWinners.join("\n").split("\n").map((id) => <div key={id}>{id}</div>)}</div>
        </details>
      )}
    </div>
  );
}

export default function DrawAudit({ snap }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const drawProducts = (snap && snap.sellthrough && snap.sellthrough.drawProducts) || {};
  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    setError(null);
    try {
      const next = [];
      for (const f of files) {
        const rows = parseCsv(await f.text());
        if (!rows.length || !("Winner" in rows[0])) { setError(`${f.name} is not a draw-entries export (no Winner column)`); continue; }
        next.push({ name: f.name, drawId: drawIdFromName(f.name), audit: auditExport(rows), tool: { sold: "", entries: "", expected: "" } });
      }
      setItems((cur) => [...cur, ...next]);
    } catch (err) { setError(String(err.message || err)); }
    e.target.value = "";
  };
  return (
    <Card dot="#8a7a52" title="Draw audit">
      <div className="spacer-8" />
      <div style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 680, color: C.muted }}>
        Download a draw's entries from the admin (draw-…-entries.csv), drop it here, and type the three numbers the allocator tool
        prints for that product. The file is read in your browser and is not uploaded; only counts and draw entry ids are shown.
      </div>
      <div style={{ marginTop: 12 }}>
        <input type="file" accept=".csv,text/csv" multiple onChange={onFiles} />
      </div>
      {error && <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>{error}</div>}
      {items.map((item, i) => (
        <Draw key={item.name + i} item={item} productName={item.drawId ? drawProducts[item.drawId] : null}
          onTool={(tool) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, tool } : x)))} />
      ))}
    </Card>
  );
}
