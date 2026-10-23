/* The shared primitives every page and card is built from (the Linear
 * redesign, October 2026): the card with its head, options menu and
 * headline figure, the segmented switch, the dropdown menu, the lozenge,
 * the badge, the avatar, the toast, and the hook a chart measures its box
 * with. The charts themselves are in charts.jsx. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dots, Up, Dn } from "./icons.jsx";

/* A card of the redesign: the title on the left of its head, then any
 * switch (`seg`), then the ⋯ menu (`menu`: [{ label, onClick, checked,
 * icon, right, sep }]); the headline numbers go in a <Head> under it. */
export function Card({ wide, title, seg, menu, right, children, style, aria, className, onClick }) {
  const m = useMenu();
  return (
    <section className={`card${wide ? " wide" : ""}${className ? " " + className : ""}`} style={style} aria-label={aria || (typeof title === "string" ? title : undefined)} onClick={onClick}>
      <div className="ch">
        <span className="t">{title}</span>
        <span className="sp" />
        {right || null}
        {seg || null}
        {menu && menu.length > 0 && (
          <span style={{ position: "relative", display: "inline-flex" }}>
            <button className="ib" aria-label={`${typeof title === "string" ? title : "Card"} options`} aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}><Dots /></button>
            <Menu open={m.open} onClose={m.close} style={{ top: 30, right: 0, minWidth: 220 }}>
              {menu.map((it, i) => it.sep ? <div className="msep" key={i} /> : (
                <MenuItem key={i} icon={it.icon} right={it.right} checked={it.checked} radio={it.radio} disabled={it.disabled}
                  onClick={() => { m.close(); if (it.onClick) it.onClick(); }}>{it.label}</MenuItem>
              ))}
            </Menu>
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/* The headline in a card's head: the figure, its unit, the deltas (each
 * { t, dir: "up" | "dn" | "flat" }) and a quiet aside with a hover. */
export function Head({ v, u, deltas = [], aside, asideTip, children }) {
  return (
    <div className="hn">
      <span className="hv">{v}</span>
      {u ? <span className="hu">{u}</span> : null}
      {deltas.filter(Boolean).map((d, i) => (
        <span key={i} className={`dl ${d.dir || "flat"}`} title={d.tip}>{d.dir === "up" ? <Up /> : d.dir === "dn" ? <Dn /> : null}{d.t}</span>
      ))}
      {aside ? <span className="hs" title={asideTip}>{aside}</span> : null}
      {children}
    </div>
  );
}

/* a delta against a reference, as the head prints it: "48% vs target", up or down */
export function vsDelta(actual, ref, word, tip) {
  if (!(ref > 0) || actual === null || actual === undefined) return null;
  const p = Math.round((actual / ref - 1) * 100);
  if (!Number.isFinite(p)) return null;
  return { t: `${Math.abs(p)}% vs ${word}`, dir: p >= 0 ? "up" : "dn", tip };
}

/* A two- or three-way switch in a card head: options [[key, label, tip]]. */
export function Seg({ options, value, onChange, label, big }) {
  return (
    <span className={`seg${big ? " big" : ""}`} role="group" aria-label={label}>
      {options.map(([k, l, tip]) => (
        <button key={k} type="button" className={value === k ? "on" : ""} aria-pressed={value === k} title={tip} onClick={() => onChange(k)}>{l}</button>
      ))}
    </span>
  );
}

/* A dropdown menu under a control: `useMenu` keeps it open or closed, `Menu`
 * draws it (absolute, inside a relative wrapper) with a scrim behind it that
 * closes it, Escape too. */
export function useMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  return useMemo(() => ({ open, toggle: (e) => { if (e && e.stopPropagation) e.stopPropagation(); setOpen((o) => !o); }, close: () => setOpen(false), show: () => setOpen(true) }), [open]);
}

export function Menu({ open, onClose, children, style, role = "menu", label, scroll }) {
  if (!open) return null;
  return (
    <>
      {createPortal(<button className="scrim" aria-label="Close the menu" onClick={(e) => { e.stopPropagation(); onClose(); }} />, document.body)}
      <div className={`menu${scroll ? " scroll" : ""}`} role={role} aria-label={label} style={style} onClick={(e) => e.stopPropagation()}>{children}</div>
    </>
  );
}

export function MenuItem({ icon, children, right, onClick, checked, radio, checkbox, disabled, title }) {
  const role = radio ? "menuitemradio" : checkbox || checked !== undefined ? "menuitemcheckbox" : "menuitem";
  return (
    <button className="mrow" role={role} aria-checked={checked !== undefined ? !!checked : undefined} disabled={disabled} title={title} onClick={onClick}>
      {checkbox ? <span className={`box${checked ? " on" : ""}`}>{checked ? "✓" : ""}</span> : radio || checked !== undefined ? <span className="tk">{checked ? "✓" : ""}</span> : null}
      {icon || null}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
      {right !== undefined && right !== null ? <span className="r">{right}</span> : null}
    </button>
  );
}

export function Switch({ on, onChange, label }) {
  return <button className={`sw${on ? " on" : ""}`} role="switch" aria-checked={!!on} aria-label={label} onClick={() => onChange(!on)}><span /></button>;
}

export function Badge({ type }) {
  const t = String(type || "LE").toUpperCase();
  return <span className={`badge ${t.toLowerCase()}`}>{t}</span>;
}

/* a lozenge of the redesign: kind "ind" (indigo), "warm", "good", "ghost" or plain */
export function Loz({ kind, children, tip, style, icon }) {
  return <span className={`loz${kind ? " " + kind : ""}`} title={tip} style={style}>{icon || null}{children}</span>;
}
/* a person's initial in a coloured disc, the colour from the name */
const AV_COLS = ["#b8461d", "#0f7052", "#5e6ad2", "#8a5f00", "#6d3fa8", "#1877f2", "#3a3a3c", "#c2185b"];

export function colorOf(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return AV_COLS[h % AV_COLS.length];
}

export function Avatar({ name, size = 16, title }) {
  const shown = String(name || "").includes("@") ? String(name).split("@")[0] : String(name || "");
  if (!shown) return <span className="av none" style={{ width: size, height: size, flex: `0 0 ${size}px` }} title={title || "No lead"} />;
  return <span className="av" style={{ width: size, height: size, flex: `0 0 ${size}px`, background: colorOf(shown), fontSize: Math.round(size * 0.56) }} title={title || shown}>{shown[0].toUpperCase()}</span>;
}

/* the dark note at the foot of the page: a word on what just happened, with an undo */
export function Note({ text, onUndo, onClose, bad }) {
  if (!text) return null;
  return createPortal(
    <div className={`note${bad ? " bad" : ""}`} role="status">
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
      {onUndo && <button onClick={onUndo}>Undo</button>}
      <button aria-label="Dismiss" onClick={onClose}>×</button>
    </div>,
    document.body,
  );
}

/* The live size of an element. Label collision is a pixel question, never a
 * fraction one - two labels 20% apart are comfortable on a wide card and on top
 * of each other on a narrow one - so a card that places labels by value measures
 * the plot or row it is placing them in (the arithmetic is in labels.mjs). It
 * measures again whenever the element resizes, and renders once more when the
 * page's webfont lands, since a label measured before then was measured in the
 * fallback face. A callback ref, so an element that mounts after the card
 * (a plot behind an empty state) is measured too. */
export function useBoxSize() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [, setFonts] = useState(0);
  const ro = useRef(null);
  const ref = useCallback((el) => {
    if (ro.current) { ro.current.disconnect(); ro.current = null; }
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver !== "undefined") { ro.current = new ResizeObserver(measure); ro.current.observe(el); }
  }, []);
  useEffect(() => {
    let live = true;
    const fonts = typeof document !== "undefined" ? document.fonts : null;
    const bump = () => { if (live) setFonts((n) => n + 1); };
    if (fonts) {
      if (fonts.status !== "loaded") fonts.ready.then(bump);
      if (fonts.addEventListener) fonts.addEventListener("loadingdone", bump);
    }
    return () => {
      live = false;
      if (fonts && fonts.removeEventListener) fonts.removeEventListener("loadingdone", bump);
      if (ro.current) ro.current.disconnect();
    };
  }, []);
  return [ref, size.w, size.h];
}
