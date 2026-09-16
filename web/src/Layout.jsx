/* The release page's arrangement: which cards, in what order, with section
 * headers between them. One arrangement for everyone, kept on the server
 * (GET and POST /api/layout; README "Arranging the page"). This file owns the
 * list of cards, so a saved layout naming a card the code no longer has drops
 * it, and a card the code gained since the save joins at the end.
 *
 * Editing is drag and drop: every card is a handle, a header is dragged by its
 * grip, and a header ends one grid and starts the next, so each section packs
 * on its own. Nothing is kept until Save, which keeps it for everyone. */
import React, { useEffect, useState } from "react";
import { C } from "./ui.jsx";

export const CARDS = [
  { key: "hero", title: "Units vs sellout" },
  { key: "channels", title: "Channels vs targets" },
  { key: "no_targets", title: "No targets set", note: "shown only on a release without targets" },
  { key: "funnel", title: "Funnel by channel", size: "tall" },
  { key: "trajectory", title: "Unit trajectory", size: "wide" },
  { key: "drivers", title: "Funnel key drivers" },
  { key: "paid_roi", title: "Paid ROI", size: "wide" },
  { key: "paid_spend", title: "Paid spend / day" },
  { key: "sell_through", title: "Sell-through" },
  { key: "geo", title: "Entries by country" },
  { key: "waterfall", title: "Actual vs target" },
];
const BY_KEY = Object.fromEntries(CARDS.map((c) => [c.key, c]));

let seq = 0;
const newId = () => `h${++seq}`;
export const defaultItems = () => CARDS.map((c) => ({ type: "card", key: c.key }));
const isDefault = (items) => items.length === CARDS.length && items.every((it, i) => it.type === "card" && it.key === CARDS[i].key);

/* A stored layout against the cards the code has: unknown cards go, repeats go,
 * cards the layout never heard of join at the end. Headers pass through and get
 * an id for React's benefit; the server keeps only their text. */
export function reconcile(items) {
  const out = [], seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "card" && BY_KEY[it.key] && !seen.has(it.key)) { seen.add(it.key); out.push({ type: "card", key: it.key }); }
    else if (it.type === "header") out.push({ type: "header", text: String(it.text ?? "").slice(0, 80), id: it.id || newId() });
  }
  for (const c of CARDS) if (!seen.has(c.key)) out.push({ type: "card", key: c.key });
  return out;
}

export function useLayout() {
  const [doc, setDoc] = useState({ items: defaultItems(), updatedAt: null, updatedBy: null });
  useEffect(() => {
    let live = true;
    fetch("/api/layout").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (live && d) setDoc({ items: reconcile(d.items), updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null });
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const save = async (items) => {
    // the default is kept as no document at all, so the bar can say nobody has changed it
    const body = isDefault(items) ? null
      : items.map((it) => (it.type === "card" ? { type: "card", key: it.key } : { type: "header", text: it.text.trim() }));
    const r = await fetch("/api/layout", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: body }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Could not save the layout - nothing was changed.");
    setDoc({ items: reconcile(d.items), updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null });
  };
  return { ...doc, save };
}

/* The bar above the page while editing: add a header, go back to the default,
 * cancel, or save for everyone. */
export function LayoutBar({ items, onChange, onSave, onCancel, saving, error, updatedAt, updatedBy }) {
  const when = updatedAt ? new Date(updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null;
  const note = updatedBy ? `Last saved by ${updatedBy}${when ? " on " + when : ""}.` : "Nobody has changed the default yet.";
  return (
    <div className="layout-bar">
      <button className="btn secondary" onClick={() => onChange([{ type: "header", text: "", id: newId() }, ...items])}>Add header</button>
      <button className="btn secondary" onClick={() => onChange(defaultItems())} disabled={isDefault(items)}>Back to the default</button>
      <span className="note" style={error ? { color: C.red } : undefined}>{error || `Drag a card or a header to move it. ${note}`}</span>
      <button className="btn secondary" onClick={onCancel} disabled={saving}>Cancel</button>
      <button className="btn primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save for everyone"}</button>
    </div>
  );
}

/* items -> the page. `render(key)` gives the card for a key, or null when the
 * card has nothing to show on this release; a null card is left out, or drawn
 * as a ghost while editing so it can still be placed. */
export function PageLayout({ items, render, editing = false, onChange }) {
  const [drag, setDrag] = useState(null);   // index of the item on the move
  const [over, setOver] = useState(null);   // { idx, before }: where it would land
  useEffect(() => { if (!editing) { setDrag(null); setOver(null); } }, [editing]);

  const move = (from, to) => {
    // `to` counts positions before the removal; the item lands in front of it
    if (to === from || to === from + 1) return;
    const next = items.slice();
    const [it] = next.splice(from, 1);
    next.splice(from < to ? to - 1 : to, 0, it);
    onChange(next);
  };
  const dragStart = (idx) => (e) => {
    setDrag(idx);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(idx)); } catch { /* a browser that lets a drag carry nothing */ }
  };
  const dragOver = (idx, axis) => (e) => {
    if (drag === null || idx === drag) { setOver(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = e.currentTarget.getBoundingClientRect();
    const before = axis === "x" ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    setOver((o) => (o && o.idx === idx && o.before === before ? o : { idx, before }));
  };
  const drop = (e) => {
    e.preventDefault();
    if (drag !== null && over) move(drag, over.before ? over.idx : over.idx + 1);
    setDrag(null); setOver(null);
  };
  const dragEnd = () => { setDrag(null); setOver(null); };
  const dropClass = (idx) =>
    (over && over.idx === idx ? (over.before ? " drop-before" : " drop-after") : "") + (drag === idx ? " dragging" : "");
  const setText = (idx, text) => onChange(items.map((it, i) => (i === idx ? { ...it, text } : it)));
  const remove = (idx) => onChange(items.filter((_, i) => i !== idx));

  // sections: each header opens one; the cards before any header make the first
  const sections = [];
  items.forEach((it, idx) => {
    if (it.type === "header" || !sections.length) sections.push({ header: it.type === "header" ? { ...it, idx } : null, cards: [] });
    if (it.type === "card") sections[sections.length - 1].cards.push({ ...it, idx });
  });

  return (
    <div className="layout">
      {sections.map((s) => {
        const cards = s.cards.map((c) => ({ ...c, node: render(c.key) })).filter((c) => editing || c.node);
        const h = s.header;
        return (
          <React.Fragment key={h ? h.id : "top"}>
            {h && (editing ? (
              <div className={`section-row${dropClass(h.idx)}`} onDragOver={dragOver(h.idx, "y")} onDrop={drop}>
                <span className="grip" draggable onDragStart={dragStart(h.idx)} onDragEnd={dragEnd} title="Drag to move the header">&#8942;&#8942;</span>
                <input className="section-input" value={h.text} placeholder="Section name" autoFocus={h.text === ""}
                  onChange={(e) => setText(h.idx, e.target.value)} />
                <button className="x" onClick={() => remove(h.idx)} title="Remove the header">&#215;</button>
              </div>
            ) : (h.text.trim() ? <h2 className="section-head">{h.text}</h2> : null))}
            {(cards.length > 0 || editing) && (
              <div className="grid">
                {cards.map((c) => {
                  const card = BY_KEY[c.key];
                  return (
                    <div key={c.key} className={`slot${card.size ? " " + card.size : ""}${editing ? " edit" : ""}${dropClass(c.idx)}`}
                      draggable={editing} onDragStart={editing ? dragStart(c.idx) : undefined} onDragEnd={dragEnd}
                      onDragOver={dragOver(c.idx, "x")} onDrop={drop}>
                      {c.node || (
                        <div className="card ghost">
                          <div className="mod-head"><span className="gdot" style={{ background: "#c8c5bc" }} /><span className="title">{card.title}</span></div>
                          <div className="empty-state">{card.note || "nothing to show on this release"}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {editing && h && cards.length === 0 && (
                  <div className={`slot drop-empty${over && over.idx === h.idx && !over.before ? " drop-after" : ""}`}
                    onDragOver={(e) => { if (drag === null || drag === h.idx) return; e.preventDefault(); setOver({ idx: h.idx, before: false }); }}
                    onDrop={drop}>
                    Drop a card here
                  </div>
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
