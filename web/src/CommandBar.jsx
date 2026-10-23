/* ⌘K: every release, searched by artist, work, quarter, code or id, grouped
 * In flight, Upcoming, Closed and Catalogue; the arrow keys move, Enter
 * opens, Escape closes. Without a query each group shows its first few. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "./icons.jsx";
import { Badge } from "./ui.jsx";
import { nameOf, searchRows, stateColor, whenWords } from "./rows.mjs";

const ORDER = [["live", "In flight"], ["upcoming", "Upcoming"], ["closed", "Closed"], ["catalogue", "Catalogue"]];

export default function CommandBar({ groups, asOf, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  useEffect(() => { input.current && input.current.focus(); }, []);
  const res = useMemo(() => {
    const by = { live: groups.live, upcoming: groups.upcoming, closed: groups.closed, catalogue: groups.catalogue };
    const out = [];
    for (const [k, name] of ORDER) {
      let rows = searchRows(by[k] || [], q);
      if (!q.trim()) rows = rows.slice(0, k === "live" || k === "upcoming" ? 6 : 4);
      else rows = rows.slice(0, 12);
      if (rows.length) out.push({ name, rows });
    }
    return out;
  }, [groups, q]);
  const flat = res.flatMap((g) => g.rows);
  useEffect(() => { setSel(0); }, [q]);
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && flat[sel]) { e.preventDefault(); onPick(flat[sel].id); }
  };
  let i = -1;
  return createPortal(
    <div className="palwrap">
      <button className="dlgback" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <section className="pal" role="dialog" aria-modal="true" aria-label="Search releases">
        <div className="palhead">
          <Search />
          <label className="sr" htmlFor="palq">Search releases</label>
          <input id="palq" ref={input} className="palin" placeholder="Search releases, artists or works" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} />
          <span className="kcap">esc</span>
        </div>
        <div className="palbody">
          {res.map((g) => (
            <div key={g.name}>
              <div className="palg">{g.name}</div>
              {g.rows.map((r) => {
                i += 1;
                const idx = i;
                const { artist, work } = nameOf(r);
                const color = stateColor(r);
                return (
                  <button key={r.id} className={`palr${idx === sel ? " sel" : ""}`} onClick={() => onPick(r.id)} onMouseEnter={() => setSel(idx)}>
                    {color ? <span className="nv-dot" style={{ background: color }} /> : <span className="nv-ring" />}
                    <span>{artist}</span>
                    <span className="w">{work}</span>
                    <Badge type={r.type} />
                    <span className="r">{whenWords(r, asOf).text}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div style={{ padding: 28, textAlign: "center", color: "#8a8a8e", fontSize: 13 }}>No releases match</div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
