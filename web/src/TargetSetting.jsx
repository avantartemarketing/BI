/* Target setting tab (docs/BENCHMARK_SPEC.md §8, docs/DATA_MODEL.md §1.6):
 * the outcome in one strip under the actions - the target, the benchmark,
 * the stretch, the paid budget, the launch value - then the inputs in the
 * order the decisions are made, Works, Target, Launch, Assumptions,
 * recomputing live via shared/economics.mjs and shared/benchmarkModel.mjs.
 * Save persists the inputs and the server rebuilds the release on them.
 *
 * Almost nothing here is typed. The products and their economics come from
 * Airtable, per work (edition, target sell-through, price, the artist's and
 * Avant Arte's profit per unit, the deal's revenue or profit share, the
 * framing assumptions), laid out as one sheet: the figures down the side,
 * a column per work, All works first, the labels held while it scrolls
 * sideways. The figures are locked until Edit figures is switched on; then
 * the cell is the input, a typed one tinted with Airtable's figure on
 * hover. The dates come from the Notion log (the early-access email
 * opens the private room; the announce; the launch), then the funnel's own
 * clock, then Airtable; the marketing lead from the Notion log, then
 * Airtable. What a person decides is which Meta campaigns are this
 * release's, which channels it will not run, and which basket it is
 * measured against.
 *
 * The products grid (ProductsGrid) stays here for the timed launches' tab,
 * which still draws the works as a sheet.
 *
 * A release set up before the model went per product still carries its
 * release-level figures (legacy_economics); they stand in for its totals
 * until they are cleared here, and the products show what Airtable holds
 * beside them. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, MINUS, fmt, fmtK, fmtMoney, fmtPct } from "./ui.jsx";
import BasketPicker from "./BasketPicker.jsx";
import { resolveProducts, releaseEconomics, LEGACY_KEYS } from "../../shared/economics.mjs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf, profileOf, rebalanceShares, stretchWeights } from "../../shared/benchmarkModel.mjs";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fmtDate = (iso) => {
  if (!iso) return "";
  const t = Date.parse(/T/.test(String(iso)) ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : String(iso);
};

// the five display groups, in the order the profile dicts are written
// (etl/baskets.py GROUPS), so the table reads the same way as the snapshot
const GROUPS = [
  { key: "aa_email", name: "AA Email" },
  { key: "aa_social", name: "AA Meta" },
  { key: "referral_artist", name: "Referral artist" },
  { key: "search_direct_other", name: "Search / direct / other" },
  { key: "paid", name: "Paid" },
];

/* ======================= the form language ======================= */

/* One field: the label, a source or unit caption beside it, the box, a
 * helper under. The tip sits on the label. */
export function Field({ label, src, tip, help, helpKind, children }) {
  return (
    <div className="ts-field">
      <div className="ts-label"><span title={tip}>{label}</span>{src ? <span className="src">{src}</span> : null}</div>
      {children}
      {help ? <div className={`ts-help${helpKind ? ` ${helpKind}` : ""}`}>{help}</div> : null}
    </div>
  );
}

export const RoBox = ({ value, title }) => <div className="ts-box ro" title={title}><span className="txt">{value}</span></div>;

export const TextBox = ({ value, onChange, placeholder, title, list }) => (
  <div className="ts-box" title={title}>
    <input value={value} onChange={onChange} placeholder={placeholder} list={list} />
  </div>
);

/* A number box: what is being typed while it is typed ("5." on the way to
 * "5.5"), the model's figure once it is left, the unit inside the box. */
export function NumBox({ value, placeholder, unit, onCommit, title, disabled }) {
  const [draft, setDraft] = useState(null);
  return (
    <div className={`ts-box num${disabled ? " dis" : ""}`} title={title}>
      <input inputMode="decimal" value={draft !== null ? draft : value} placeholder={placeholder} disabled={disabled}
        onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value); }}
        onBlur={() => setDraft(null)} />
      {unit ? <span className="unit">{unit}</span> : null}
    </div>
  );
}

/* A switch: the control and its name; the clause on what it does is the
 * field's helper. */
export function Switch({ on, onChange, label, title }) {
  return (
    <button type="button" className={`ts-switch${on ? " on" : ""}`} aria-pressed={on} onClick={() => onChange(!on)} title={title}>
      <span className="tr" />{label}
    </button>
  );
}

export const Notice = ({ red, children, action }) => (
  <div className={`ts-notice${red ? " red" : ""}`}><span>{children}</span>{action || null}</div>
);

export const CardHead = ({ dot, title, desc, right }) => (
  <div className="ts-card-head">
    <span className="dot" style={{ background: dot }} /><span className="t">{title}</span>
    {desc ? <span className="d">{desc}</span> : null}
    {right ? <div className="right">{right}</div> : null}
  </div>
);

/* The Meta campaigns whose spend is this release's: the ones the spend feed
 * names for the campaign code, ticked or not, and any other campaign added by
 * name. The draw campaign is what the code matches on its own. */
export function Campaigns({ code, chosen, all, suggested, onChange }) {
  const [adding, setAdding] = useState("");
  const byName = new Map((all || []).map((c) => [c.name, c]));
  const named = (all || []).filter((c) => code && c.name.startsWith(`${code} · `)).map((c) => c.name);
  const listed = [...new Set([...named, ...(suggested || []), ...chosen])];
  const toggle = (name, on) => onChange(on ? [...chosen, name] : chosen.filter((n) => n !== name));
  const add = () => {
    const name = adding.trim();
    if (name && !chosen.includes(name)) onChange([...chosen, name]);
    setAdding("");
  };
  return (
    <div className="ts-stack">
      {listed.length === 0 && (
        <div className="ts-help">No campaign in the spend feed is named for {code ? `"${code}"` : "this release's code"} yet.</div>
      )}
      {listed.map((name) => {
        const hit = byName.get(name);
        return (
          <label key={name} className="ts-check-row">
            <input type="checkbox" checked={chosen.includes(name)} onChange={(e) => toggle(name, e.target.checked)} />
            <span className="nm" title={name}>{name}</span>
            <span className={`meta${hit ? "" : " warn"}`}>{!hit ? "no spend rows by this name" : hit.last ? `${fmtMoney(hit.spend)} · last ${hit.last}` : "no spend yet"}</span>
          </label>
        );
      })}
      <div className="ts-row">
        <div className="ts-box">
          <input list="meta-campaigns" value={adding} placeholder="Add another campaign by name" onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        </div>
        <datalist id="meta-campaigns">
          {(all || []).filter((c) => !chosen.includes(c.name)).map((c) => <option key={c.name} value={c.name} />)}
        </datalist>
        <button type="button" className="ts-btn secondary" onClick={add} disabled={!adding.trim()}>Add</button>
      </div>
    </div>
  );
}

/* ======================= the products grid ======================= */

/* Percentages are typed as whole numbers and kept as fractions. */
const PCT = new Set(["target_sellthrough", "aa_revenue_share", "aa_profit_share", "artist_revenue_cut", "frame_conversion"]);
// the grid's columns after the product: the header on one line, a glyph
// carrying the unit (# a count, % and € units, ƒ computed, ✓ on or off)
const GRID = [
  { key: "edition", label: "Edition", glyph: "#", tip: "Units in the edition of this work." },
  { key: "target_sellthrough", label: "Sell-through", glyph: "%", tip: "The share of the edition targeted to sell by close. Blank = Airtable's target (its units target over the edition, else the expected sell-through), else 100%." },
  { key: "unit_price", label: "Price", glyph: "€", tip: "Retail price per unit. Airtable prices in euros, the page's currency; a product in another currency is converted at a fixed rate." },
  { key: "target_units", label: "Target units", glyph: "ƒ", calc: true, tip: "Computed: edition × sell-through." },
  { key: "launch_date", label: "Closes", glyph: "", calc: true, date: true, tip: "The day this work's draw closes, from Airtable. Works of one launch can close on different days: the page runs to the last, the sell-through card counts each work at its own draw." },
  { key: "artist_profit_per_unit", label: "Artist profit", glyph: "€", tip: "The artist's profit on one unit sold." },
  { key: "aa_profit_per_unit", label: "AA profit", glyph: "€", tip: "Avant Arte's profit on one unit sold, before framing." },
  { key: "artist_revenue_cut", label: "Artist revenue cut", glyph: "%", tip: "The artist's or estate's commission on revenue, taken before any profit is split (Airtable's Revenue Commission %). On a revenue deal it is the whole deal; a profit-share deal can carry one beside the AA profit share." },
  { key: "aa_revenue_share", label: "AA revenue share", glyph: "%", tip: "Avant Arte's own share of revenue on a royalty deal (not the artist's), where Avant Arte carries the ads outright. Closed while the product has an AA profit share." },
  { key: "aa_profit_share", label: "AA profit share", glyph: "%", tip: "Avant Arte's own share of the profit on a profit-share deal (not the artist's), which is also its share of the paid budget. Closed while the product has an AA revenue share." },
  { key: "framing_available", label: "Framing", glyph: "✓", check: true, tip: "Whether a frame is offered on this work. Unticked closes the two frame cells. Where Airtable's Framing is blank, a sculpture edition has no frame and a print has one." },
  { key: "frame_conversion", label: "Frames per print", glyph: "%", tip: "The share of buyers expected to take a frame. Blank = the benchmark default." },
  { key: "frame_profit_per_unit", label: "Frame profit", glyph: "€", tip: "Avant Arte's profit on each frame sold, which is Avant Arte's alone. There is no default: blank counts no framing profit." },
];
const cellText = (key, v, raw = false) => {
  if (v === null || v === undefined || v === "") return "";
  const n = PCT.has(key) ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100;
  return raw ? String(n) : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
/* The one-or-the-other rule: a product's deal is a revenue share or a profit
 * share, so while either holds a figure the other is closed; unticked
 * framing closes the two frame cells beside it. */
const OFF_WHY = "Unticked: this work is not part of the release, so it counts nothing here. Tick it to count it again.";
const closedFor = (p, key) => {
  if (p.excluded) return true;   // unticked: every figure cell is closed
  if (key === "aa_revenue_share") return p.aa_profit_share !== null && p.aa_revenue_share === null;
  if (key === "aa_profit_share") return p.aa_revenue_share !== null && p.aa_profit_share === null;
  if (key === "frame_conversion" || key === "frame_profit_per_unit") return !p.framing_available;
  return false;
};
const typedKeys = (p) => Object.keys(p.sources || {}).filter((k) => k !== "currency" && p.sources[k] === "typed");

/* A cell's input: the typed figure with its thousands while it is not being
 * typed in, the bare figure while it is, Airtable's figure as the grey
 * placeholder underneath. */
function CellInput({ shown, raw, placeholder, onCommit, title }) {
  const [draft, setDraft] = useState(null);
  return (
    <input className="cell" size={1} inputMode="decimal" title={title} value={draft !== null ? draft : shown} placeholder={placeholder}
      onFocus={() => setDraft(raw)}
      onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value); }}
      onBlur={() => setDraft(null)} />
  );
}

/* Enter moves down the column (Shift+Enter up); Tab moves along the row on
 * its own. */
function moveByRow(e) {
  if (e.key !== "Enter" || e.target.tagName !== "INPUT" || e.target.type === "checkbox") return;
  const td = e.target.closest("td"), tr = td && td.parentElement;
  if (!tr) return;
  e.preventDefault();
  const col = td.cellIndex;
  let row = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
  while (row) {
    const cell = row.cells[col], inp = cell && cell.querySelector("input");
    if (inp && !inp.disabled) { inp.focus(); return; }
    row = e.shiftKey ? row.previousElementSibling : row.nextElementSibling;
  }
}

/* `columns` is the grid's column set, GRID for an LE; a timed launch's tab
 * passes its own (TLTargets.jsx), with a units target per work in place of
 * the sell-through. `caption` replaces the LE words under the grid. */
function ProductsGrid({ products, econ, editing, onField, onFieldAll, onName, onAdd, onRemove, onReset, onInclude, emptyNote, columns = GRID, caption,
  ticks = true, addRow = true, nameOnly = false }) {
  // rows are keyed by the Airtable id, else the row's place in the list: a
  // manual product's name is typed in place, so it cannot be the key
  const rowKey = (p, i) => (p.airtable_id ? `a-${p.airtable_id}` : `m-${i}`);
  // the works in the release: the totals and the set-all row read these; an
  // unticked work stays on the grid, greyed, with every cell closed
  const live = products.filter((p) => !p.excluded);
  const glyph = (c) => <span className="glyph" aria-hidden="true">{c.glyph}</span>;
  const srcTitle = (src) => (src === "airtable" ? "Airtable's figure - type over it to override" : src === "default" ? "The benchmark default - type over it to override" : src === "typed" ? "Typed here; clear to go back to Airtable's" : "Airtable holds none - type it");
  const cell = (p, c) => {
    if (p.excluded) return <td key={c.key} className="closed" title={OFF_WHY} />;
    if (c.date) return <td key={c.key} className="calc" title={c.tip}>{p.launch_date ? fmtDate(p.launch_date) : ""}</td>;
    if (c.calc) return <td key={c.key} className="calc" title={c.tip}>{p.edition ? fmt(p.target_units) : ""}</td>;
    const typed = p.airtable_id && p.sources[c.key] === "typed";
    if (c.check) {
      return (
        <td key={c.key} className={`check${typed ? " typed" : ""}`}>
          <input type="checkbox" className="tick" checked={!!p.framing_available} disabled={!editing}
            title={typed ? "Typed here" : p.sources.framing_available === "default"
              ? "Airtable's Framing is blank: a sculpture edition defaults to no frame, a print to one" : "Airtable's framing option"}
            onChange={(e) => onField(p, c.key, e.target.checked)} />
        </td>
      );
    }
    if (closedFor(p, c.key)) {
      const why = c.key === "aa_revenue_share" ? "Closed: this product has an AA profit share." : c.key === "aa_profit_share" ? "Closed: this product has an AA revenue share." : "Closed: no frame is offered on this product.";
      return <td key={c.key} className="closed" title={why} />;
    }
    const src = p.sources[c.key];
    const text = cellText(c.key, p[c.key]);
    const suffix = c.key === "unit_price" && p.currency && p.currency !== "EUR" ? ` ${p.currency}` : "";
    if (!editing) return <td key={c.key} className={`lock${typed ? " typed" : ""}`} title={srcTitle(src)}>{text}{text ? suffix : ""}</td>;
    return (
      <td key={c.key} className={`edit${typed ? " typed" : ""}`}>
        <CellInput shown={typed || !p.airtable_id ? text : ""} raw={typed || !p.airtable_id ? cellText(c.key, p[c.key], true) : ""}
          placeholder={src ? text : ""} title={srcTitle(src)} onCommit={(raw) => onField(p, c.key, raw)} />
      </td>
    );
  };
  const nameCell = (p, i) => {
    const n = typedKeys(p).length;
    if (nameOnly) return <td className="l primary"><div className="pc"><span className="nm" title={p.name || "unnamed"}>{p.name || "unnamed"}</span></div></td>;
    return (
      <td className="l primary">
        <div className="pc">
          {editing && !p.airtable_id
            ? <input className="cell name" size={1} value={p.name || ""} placeholder="Product name" onChange={(e) => onName(p, e.target.value)} />
            : <span className="nm" title={p.name || "unnamed"}>{p.name || "unnamed"}</span>}
          {!p.airtable_id && <span className="src" title="Added on this tab, not in Airtable">added by hand</span>}
          {p.excluded && <span className="src off" title={OFF_WHY}>unticked</span>}
          {editing && p.airtable_id && n > 0 && (
            <button type="button" className="ts-link" onClick={() => onReset(p)} title={`Back to Airtable's figures on this row (${n} typed)`}>Reset</button>
          )}
          {editing && !p.airtable_id && (
            <button type="button" className="ts-link" onClick={() => onRemove(p)} title="Take this product off the release">Remove</button>
          )}
        </div>
      </td>
    );
  };
  // one row that writes to every product: the figure when every product
  // carries the same typed one, "varies" when some do, blank when none
  const setAll = () => (
    <tr className="setall">
      <td className="gut">↓</td>
      <td className="l primary">Set all<span className="src">type here to fill a column</span></td>
      {columns.map((c) => {
        if (c.calc) return <td key={c.key} className="calc" />;
        if (c.check) {
          return (
            <td key={c.key} className="check">
              <input type="checkbox" className="tick" checked={live.every((p) => p.framing_available)} title="Every product at once"
                onChange={(e) => onFieldAll(c.key, e.target.checked)} />
            </td>
          );
        }
        if (c.key === "edition") return <td key={c.key} className="closed" title="Editions differ by work: type each on its own row." />;
        if (c.key === "units_target") return <td key={c.key} className="closed" title="Targets differ by work: type each on its own row." />;
        const vals = products.filter((p) => !closedFor(p, c.key)).map((p) => (p.sources[c.key] === "typed" ? p[c.key] : undefined));
        const same = vals.length > 0 && vals.every((v) => v !== undefined && v === vals[0]);
        return (
          <td key={c.key} className="edit">
            <CellInput shown={same ? cellText(c.key, vals[0]) : ""} raw={same ? cellText(c.key, vals[0], true) : ""}
              placeholder={vals.some((v) => v !== undefined) ? "varies" : ""} title="Every product at once"
              onCommit={(raw) => onFieldAll(c.key, raw)} />
          </td>
        );
      })}
    </tr>
  );
  // the last row is the release as a whole: edition and target units summed,
  // sell-through and price weighted by target units, the profits and the
  // share per target unit, the framing uplift per target unit
  const weighted = (key) => {
    const rows = live.filter((p) => p[key] !== null && p[key] !== undefined && p.target_units > 0);
    const tot = rows.reduce((s, p) => s + p.target_units, 0);
    return tot ? rows.reduce((s, p) => s + p.target_units * p[key], 0) / tot : null;
  };
  const aaBefore = (econ.ppu_aa || 0) - (econ.frame_uplift_per_unit || 0);
  const revShare = weighted("aa_revenue_share"), profShare = weighted("aa_profit_share");
  const unitsTargetSum = live.reduce((t, p) => t + (p.units_target || 0), 0);
  const sumCell = (c) => {
    switch (c.key) {
      case "edition": return <td key={c.key} title="The editions summed.">{fmt(econ.edition_total)}</td>;
      case "target_sellthrough": return <td key={c.key} title="Target units over the editions.">{econ.edition_total ? Math.round((100 * econ.edition_size) / econ.edition_total) : ""}</td>;
      case "unit_price": return <td key={c.key} title="Price per target unit, weighted by target units, in euros.">{econ.unit_price ? cellText("unit_price", econ.unit_price) : ""}</td>;
      case "target_units": return <td key={c.key} title="The target units summed: the secured-units target.">{fmt(econ.edition_size)}</td>;
      case "units_target": return <td key={c.key} title="The units targets summed over the ticked works: the launch's units target.">{unitsTargetSum > 0 ? fmt(unitsTargetSum) : ""}</td>;
      case "artist_profit_per_unit": return <td key={c.key} title="Weighted over the target units.">{econ.ppu_artist > 0 ? cellText("artist_profit_per_unit", econ.ppu_artist) : ""}</td>;
      case "aa_profit_per_unit": return <td key={c.key} title="Weighted over the target units, before framing.">{aaBefore > 0 ? cellText("aa_profit_per_unit", aaBefore) : ""}</td>;
      case "aa_revenue_share": return <td key={c.key} title="Weighted over the target units of the products on a revenue share.">{revShare !== null ? cellText("aa_revenue_share", revShare) : ""}</td>;
      case "aa_profit_share": return <td key={c.key} title="Weighted over the target units of the products on a profit share.">{profShare !== null ? cellText("aa_profit_share", profShare) : ""}</td>;
      case "frame_profit_per_unit": return <td key={c.key} title="The framing uplift per target unit over every product: Avant Arte's alone.">{econ.frame_uplift_per_unit > 0 ? `+${cellText("frame_profit_per_unit", econ.frame_uplift_per_unit)}` : ""}</td>;
      default: return <td key={c.key} />;
    }
  };
  const sum = () => (
    <tr className="sum">
      <td className="gut" />
      <td className="l primary">Total<span className="src">per target unit</span></td>
      {columns.map(sumCell)}
    </tr>
  );
  return (
    <>
      <div className="ts-tblwrap">
        <table className="sheet" onKeyDown={moveByRow}>
          <colgroup><col style={{ width: 32 }} /><col style={{ width: 230 }} /></colgroup>
          <thead>
            <tr>
              <th className="gut" title="Ticked: part of the release. Untick a work to leave it out; it stays here, greyed, and counts nothing." />
              <th className="l primary"><span className="glyph" aria-hidden="true">A</span>Product</th>
              {columns.map((c) => <th key={c.key} className={c.calc ? "calc" : undefined} title={c.tip}>{glyph(c)}{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {editing && products.length > 1 && setAll()}
            {products.map((p, i) => (
              <tr key={rowKey(p, i)} className={p.excluded ? "off" : undefined}>
                <td className="gut">
                  {ticks && (
                    <input type="checkbox" className="tick" checked={!p.excluded} disabled={!editing || !p.airtable_id}
                      title={p.excluded ? "Unticked: not part of the release. Tick to count it again."
                        : !p.airtable_id ? "Added by hand: Remove takes it off the release."
                          : editing ? "Untick to leave this work out of the release: it stays here, greyed, and counts nothing." : "Part of the release. Switch on Edit figures to untick it."}
                      onChange={(e) => onInclude(p, e.target.checked)} />
                  )}
                </td>
                {nameCell(p, i)}
                {columns.map((c) => cell(p, c))}
              </tr>
            ))}
            {products.length === 0 && (
              <tr className="empty">
                <td className="gut" />
                <td className="l" colSpan={columns.length + 1}>
                  No products yet: Airtable has no record matched to this release{emptyNote ? ` (${emptyNote})` : ""}.
                  {editing ? " Add the works by hand until it does." : " Switch on Edit figures to add the works by hand until it does."}
                </td>
              </tr>
            )}
            {editing && addRow && (
              <tr className="add">
                <td className="gut">+</td>
                <td className="l primary"><button type="button" className="ts-link" onClick={onAdd}>Add a product</button></td>
                <td colSpan={columns.length} />
              </tr>
            )}
            {products.length > 0 && sum()}
          </tbody>
        </table>
      </div>
      {caption !== null && (
        <div className="ts-caption">
          {caption || <>The last row is the release as a whole: edition and target units summed, sell-through and price weighted by target units,
          the profits and the share per target unit, and the framing uplift per target unit. A product has a revenue share or a
          profit share, never both: fill one and the other closes. Framing profit is Avant Arte's alone.</>}
        </div>
      )}
    </>
  );
}

// the grid and its rules, for the timed launches' tab (TLTargets.jsx)
export { GRID, PCT, closedFor, typedKeys, ProductsGrid };

/* ======================= the works as a sheet ======================= */

/* The works as one table (the 9 October 2026 design, its option A with the
 * second of its headers): the figures down the side, one column per work
 * with the whole name on up to two lines, All works as the first column.
 * The figure labels hold while the table scrolls sideways; a column's edge
 * drags, and a double-click on it puts the width back. With Edit figures on
 * the cell is the input, selected whole on focus so typing replaces it, a
 * typed one tinted with Airtable's figure on hover; a figure typed under
 * All works lands on every work whose cell is open. A work left out keeps
 * its column, greyed, its tick off; a work added by hand types its name in
 * its header. */
const blankV = (v) => v === null || v === undefined || v === "";
const TIPS = Object.fromEntries(GRID.map((c) => [c.key, c.tip]));
// the figures down the side, in the order the deal is read
const ROWS = [
  { key: "edition", label: "Edition", kind: "count" },
  { key: "target_sellthrough", label: "Sell-through", kind: "pct" },
  { key: "target_units", label: "Target units", calc: true },
  { key: "launch_date", label: "Closes", calc: true },
  { key: "unit_price", label: "Price", kind: "money" },
  { key: "artist_profit_per_unit", label: "Artist profit per unit", kind: "money" },
  { key: "aa_profit_per_unit", label: "Avant Arte profit per unit", kind: "money" },
  { key: "artist_revenue_cut", label: "Artist revenue cut", kind: "pct" },
  { key: "aa_profit_share", label: "AA profit share", kind: "pct" },
  { key: "aa_revenue_share", label: "AA revenue share", kind: "pct" },
  { key: "framing_available", label: "Framing", check: true },
  { key: "frame_conversion", label: "Frames per print", kind: "pct" },
  { key: "frame_profit_per_unit", label: "Frame profit per frame", kind: "money" },
  { key: "launch_value", label: "Launch value", calc: true, total: true, tip: "Target units at the price." },
  { key: "aa_total", label: "Avant Arte, with framing", calc: true, total: true, tip: "Avant Arte's profit on the target units, the framing uplift included." },
];
const figText = (row, v, currency) => {
  if (blankV(v)) return "";
  if (row.kind === "pct") return `${cellText(row.key, v)}%`;
  if (row.kind === "money") return row.key === "unit_price" && currency && currency !== "EUR" ? `${cellText(row.key, v)} ${currency}` : `€${cellText(row.key, v)}`;
  return fmt(v);
};
const SHEET_W = { lbl: 224, all: 118, work: 176, min: 72 };
// the rows that open a section of the sheet: a heavier rule above them
const SECTION = new Set(["edition", "unit_price", "framing_available", "launch_value"]);

/* The cell as the input: the figure with its unit while it is not being
 * typed in, the bare figure while it is, selected whole on focus so typing
 * replaces it. */
function SheetInput({ shown, raw, placeholder, onCommit, title, typed, row, col, label }) {
  const [draft, setDraft] = useState(null);
  return (
    <input className={`ws-in${typed ? " typed" : ""}`} inputMode="decimal" title={title} aria-label={label} data-row={row} data-col={col}
      value={draft !== null ? draft : shown} placeholder={placeholder}
      onFocus={(e) => { setDraft(raw); const el = e.target; setTimeout(() => el.select(), 0); }}
      onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value); }}
      onBlur={() => setDraft(null)} />
  );
}

function WorksSheet({ products, econ, airtable, b, editing, onField, onFieldAll, onName, onRemove, onReset, onInclude, emptyNote }) {
  // a column is keyed by the Airtable id, else the work's place in the list
  const rowKey = (p, i) => (p.airtable_id ? `a-${p.airtable_id}` : `m-${i}`);
  const atById = new Map((airtable || []).filter((p) => p.airtable_id).map((p) => [String(p.airtable_id), p]));
  const live = products.filter((p) => !p.excluded);
  const name = (p) => p.name || "unnamed";
  // the column widths: dragged at a header's edge, kept for the visit
  const [widths, setWidths] = useState({});
  const drag = useRef(null);
  const wOf = (key) => widths[key] || (key === "lbl" ? SHEET_W.lbl : key === "all" ? SHEET_W.all : SHEET_W.work);
  const resizer = (key) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no capture */ }
      drag.current = { key, x: e.clientX, w: wOf(key) };
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || d.key !== key) return;
      const w = Math.max(SHEET_W.min, Math.round(d.w + e.clientX - d.x));
      setWidths((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
    },
    onPointerUp: (e) => {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no capture */ }
      drag.current = null;
    },
    onDoubleClick: () => setWidths((prev) => { const next = { ...prev }; delete next[key]; return next; }),
  });
  const gridTemplateColumns = ["lbl", "all", ...products.map(rowKey)].map((k) => `${wOf(k)}px`).join(" ");
  // Enter moves down the column (Shift+Enter up); Tab moves along the row on its own
  const onKeyDown = (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT" || e.target.type === "checkbox") return;
    const col = e.target.dataset.col, row = Number(e.target.dataset.row);
    if (!col || !Number.isFinite(row)) return;
    e.preventDefault();
    const dir = e.shiftKey ? -1 : 1;
    const next = [...e.currentTarget.querySelectorAll("input[data-col]")]
      .filter((el) => el.dataset.col === col && !el.disabled && (Number(el.dataset.row) - row) * dir > 0)
      .sort((x, y) => (Number(x.dataset.row) - Number(y.dataset.row)) * dir)[0];
    if (next) next.focus();
  };

  if (products.length === 0) {
    return (
      <div className="ws-empty">
        No works yet: Airtable has no record matched to this release{emptyNote ? ` (${emptyNote})` : ""}.
        {editing ? " Add the works by hand until it does." : " Switch on Edit figures to add the works by hand until it does."}
      </div>
    );
  }

  // the figure a work carries without the typed one: Airtable's, else the default
  const priorOf = (p, key) => {
    const at = atById.get(String(p.airtable_id)) || {};
    if (!blankV(at[key])) return { from: "Airtable", v: at[key] };
    if (key === "target_sellthrough") return { from: "default", v: 1 };
    if (key === "frame_conversion") return { from: "default", v: Number(b.frame_conversion) };
    return { from: "Airtable", v: null };
  };
  const srcTitle = (src) => (src === "airtable" ? "Airtable's figure: type over it to override." : src === "default" ? "The benchmark default: type over it to override." : "Airtable holds none: type it.");
  const sec = (key) => (SECTION.has(key) ? " sec" : "");
  const cell = (key, cls, node, title) => <div key={key} className={`ws-c${cls ? ` ${cls}` : ""}`} title={title}>{node}</div>;
  const handle = (key, what) => <button type="button" className="ws-rz" aria-label={`Resize the ${what} column; double-click to put it back`} title="Drag to widen; double-click to put it back" {...resizer(key)} />;

  /* ---- the header: the figure corner, All works, a work per column ---- */
  const headRow = () => [
    <div key="l" className="ws-c ws-h ws-l"><span className="nm">Figure</span>{handle("lbl", "figure")}</div>,
    <div key="all" className="ws-c ws-h all"><span className="nm">All works</span>{handle("all", "All works")}</div>,
    ...products.map((p, i) => {
      const key = rowKey(p, i);
      return (
        <div key={key} className={`ws-c ws-h${p.excluded ? " out" : ""}`} title={p.excluded ? `${name(p)}: not in the release, counts nothing.` : name(p)}>
          {editing && !p.airtable_id
            ? <input className="ws-name" value={p.name || ""} placeholder="Name of the work" aria-label="Name of the work" onChange={(e) => onName(p, e.target.value)} />
            : <span className="nm">{name(p)}</span>}
          {(!p.airtable_id || p.excluded) && (
            <span className="tags">
              {!p.airtable_id && <span className="ts2-tag" title="Added on this tab, not in Airtable">by hand</span>}
              {p.excluded && <span className="ts2-tag warn" title={OFF_WHY}>left out</span>}
            </span>
          )}
          {handle(key, name(p))}
        </div>
      );
    }),
  ];
  /* ---- in the release: the tick per work ---- */
  const inRow = () => [
    cell("l", "ws-l", "In the release", "Ticked: part of the release. Untick a work to leave it out; it stays here, greyed, and counts nothing."),
    cell("all", "all", `${live.length} of ${products.length}`, "The works in the release."),
    ...products.map((p, i) => cell(rowKey(p, i), p.excluded ? "out" : "", p.airtable_id
      ? <input type="checkbox" className="ws-tick" checked={!p.excluded} disabled={!editing} aria-label={`${name(p)}: in the release`}
          title={p.excluded ? "Unticked: not in the release. Tick to count it again." : editing ? "Untick to leave this work out of the release: it stays here, greyed, and counts nothing." : "Part of the release. Switch on Edit figures to untick it."}
          onChange={(e) => onInclude(p, e.target.checked)} />
      : <span className="ws-v" title="Added by hand: Remove takes it off the release.">–</span>)),
  ];
  /* ---- a figure: the label, the release as a whole, a cell per work ---- */
  const weighted = (key, of) => {
    const rows = (of || live).filter((p) => !blankV(p[key]) && p.target_units > 0);
    const tot = rows.reduce((s, p) => s + p.target_units, 0);
    return tot ? rows.reduce((s, p) => s + p.target_units * p[key], 0) / tot : null;
  };
  // while a release still carries its release-level figures, the release as a whole reads them, as the build does
  const fromLegacy = econ.mode === "release" ? {
    artist_profit_per_unit: econ.ppu_artist || null, aa_profit_per_unit: (econ.ppu_aa - econ.frame_uplift_per_unit) || null,
    aa_profit_share: econ.aa_budget_share_assumed ? null : econ.aa_budget_share, aa_revenue_share: null,
    frame_conversion: econ.framing_available ? econ.frame_conversion : null, frame_profit_per_unit: econ.framing_available ? econ.frame_profit_per_unit : null,
  } : null;
  // the release closes with the last of its works' draws (etl/build.py product_closes)
  const lastClose = live.map((p) => (p.edition && p.launch_date ? String(p.launch_date).slice(0, 10) : null)).filter(Boolean).sort().pop() || null;
  const figRow = (r, ri) => {
    const title = r.tip || TIPS[r.key];
    const cls = `${sec(r.key)}${r.total ? " total" : ""}`;
    let allNode, allTitle = title;
    if (r.key === "edition") { allNode = econ.edition_total ? fmt(econ.edition_total) : "–"; allTitle = "The editions summed over the works in the release."; }
    else if (r.calc) {
      allNode = r.key === "target_units" ? (econ.edition_size ? fmt(econ.edition_size) : "–")
        : r.key === "launch_date" ? (lastClose ? fmtDate(lastClose) : "–")
          : r.key === "launch_value" ? (econ.launch_value > 0 ? fmtMoney(econ.launch_value, 0) : "–")
            : (econ.ppu_aa > 0 && econ.edition_size ? fmtMoney(econ.ppu_aa * econ.edition_size, 0) : "–");
      if (r.key === "target_units") allTitle = "The target units summed: the secured-units target.";
      if (r.key === "launch_date") allTitle = "The last of the works' closes: the day the page runs to.";
    } else if (r.check) {
      const all = econ.mode === "release" ? econ.framing_available : live.length > 0 && live.every((p) => p.framing_available);
      const text = econ.mode === "release" ? (all ? "Offered" : "Not offered") : !live.length ? "–" : all ? "Offered" : live.every((p) => !p.framing_available) ? "Not offered" : "Varies";
      allNode = editing
        ? <input type="checkbox" className="ws-tick" checked={all} aria-label="All works: framing" title="Every work at once" onChange={(e) => onFieldAll(r.key, e.target.checked)} />
        : text;
    } else {
      const of = r.key === "frame_conversion" || r.key === "frame_profit_per_unit" ? live.filter((p) => p.framing_available) : live;
      const v = r.key === "target_sellthrough" ? (econ.edition_total ? econ.edition_size / econ.edition_total : null)
        : r.key === "unit_price" ? (econ.unit_price || null) : fromLegacy ? fromLegacy[r.key] : weighted(r.key, of);
      if (!editing) { allNode = figText(r, v) || "–"; allTitle = `${title} Weighted by target units over the works in the release.`; }
      else {
        const vals = live.filter((p) => !closedFor(p, r.key)).map((p) => (p.sources[r.key] === "typed" ? p[r.key] : undefined));
        const same = vals.length > 0 && vals.every((x) => x !== undefined && x === vals[0]);
        allNode = <SheetInput shown={same ? figText(r, vals[0]) : ""} raw={same ? cellText(r.key, vals[0], true) : ""} placeholder={vals.some((x) => x !== undefined) ? "varies" : figText(r, v) || ""}
          typed={same} title="Every work at once: type here to set this figure on every work." row={ri} col="all" label={`All works: ${r.label}`} onCommit={(raw) => onFieldAll(r.key, raw)} />;
        allTitle = undefined;
      }
    }
    return [
      cell("l", `ws-l${cls}`, r.label, title),
      cell("all", `all${cls}`, allNode, allTitle),
      ...products.map((p, i) => {
        const key = rowKey(p, i);
        if (r.calc) {
          const v = r.key === "target_units" ? (p.edition ? fmt(p.target_units) : "–")
            : r.key === "launch_date" ? (p.launch_date ? fmtDate(p.launch_date) : "–")
              : r.key === "launch_value" ? (p.target_units && p.unit_price_eur ? fmtMoney(p.target_units * p.unit_price_eur, 0) : "–")
                : (p.target_units && (Number(p.aa_profit_per_unit) > 0 || p.frame_uplift_per_unit > 0) ? fmtMoney(p.target_units * ((Number(p.aa_profit_per_unit) || 0) + (p.frame_uplift_per_unit || 0)), 0) : "–");
          return cell(key, `${cls}${p.excluded ? " out" : ""}`, v, title);
        }
        if (p.excluded) return cell(key, `${cls} out`, r.check ? (p.framing_available ? "Offered" : "Not offered") : figText(r, p[r.key], p.currency) || "–", OFF_WHY);
        const typed = !!(p.airtable_id && p.sources[r.key] === "typed");
        const src = p.sources[r.key] || (r.key === "frame_conversion" ? "default" : null);
        if (r.check) {
          return cell(key, cls, <input type="checkbox" className="ws-tick" checked={!!p.framing_available} disabled={!editing} aria-label={`${name(p)}: framing`}
            title={typed ? "Typed here" : src === "default" ? "Airtable's Framing is blank: a sculpture edition defaults to no frame, a print to one" : "Airtable's framing option"}
            onChange={(e) => onField(p, r.key, e.target.checked)} />, title);
        }
        if (closedFor(p, r.key)) {
          const why = r.key === "aa_revenue_share" ? "Closed: this work has an AA profit share." : r.key === "aa_profit_share" ? "Closed: this work has an AA revenue share." : "Closed: no frame is offered on this work.";
          return cell(key, `${cls} closed`, "–", why);
        }
        // the figure a typed one replaced is on the hover, when there was one
        const prior = typed ? priorOf(p, r.key) : null;
        const note = prior && prior.v !== null && Number(prior.v) !== Number(p[r.key]) ? `${prior.from} ${figText(r, prior.v, p.currency)}` : null;
        const cellTitle = typed ? `Typed here${note ? `; ${note}` : ""}. Clear it to go back.` : srcTitle(src);
        const text = figText(r, p[r.key], p.currency);
        return cell(key, cls, editing
          ? <SheetInput shown={text} raw={cellText(r.key, p[r.key], true)} placeholder="" typed={typed} title={cellTitle} row={ri} col={key} label={`${name(p)}: ${r.label}`} onCommit={(raw) => onField(p, r.key, raw)} />
          : <span className={`ws-v${typed ? " typed" : ""}`} title={cellTitle}>{text || "–"}</span>);
      }),
    ];
  };
  /* ---- the deal's share of the paid spend, per work and as a whole ---- */
  const aaRow = () => [
    cell("l", "ws-l", "AA share of paid spend", "Avant Arte's share of the paid budget, from the deal: its profit share on a profit-share deal, all of it on a revenue share."),
    cell("all", "all", <>{fmtPct(econ.aa_budget_share, 0)}{econ.aa_budget_share_assumed && <span className="ws-note">assumed</span>}</>,
      econ.aa_budget_share_assumed ? "No deal recorded: 50/50 assumed." : econ.deal && econ.deal.length ? `From the deal: ${econ.deal.join(" and ")}.` : "As set up."),
    ...products.map((p, i) => cell(rowKey(p, i), p.excluded ? "out" : "", !blankV(p.aa_budget_share) ? fmtPct(p.aa_budget_share, 0) : "–",
      p.deal ? `From the ${p.deal}.` : "No deal recorded on this work: the release assumes 50/50.")),
  ];
  /* ---- while editing: the typed figures and the way back, per work ---- */
  const actRow = () => [
    cell("l", "ws-l", "Typed figures", "The figures typed over Airtable's on each work."),
    cell("all", "all", ""),
    ...products.map((p, i) => {
      const n = typedKeys(p).length;
      return cell(rowKey(p, i), p.excluded ? "out" : "", p.airtable_id
        ? (n > 0 ? <>{n} typed{!p.excluded && <button type="button" className="ts-link" onClick={() => onReset(p)} title={`Back to Airtable's figures on this work (${n} typed).`}>Reset</button>}</> : "none")
        : <button type="button" className="ts-link" onClick={() => onRemove(p)} title="Take this work off the release.">Remove</button>);
    }),
  ];
  const rows = [
    ["head", headRow()], ["in_release", inRow()],
    ...ROWS.map((r, ri) => [r.key, figRow(r, ri + 1)]),
    ["aa_budget_share", aaRow()],
    ...(editing ? [["typed", actRow()]] : []),
  ];
  return (
    <div className="ws-wrap">
      <div className="ws" style={{ gridTemplateColumns }} onKeyDown={onKeyDown} aria-label="The works and their figures">
        {rows.map(([id, cells]) => <React.Fragment key={id}>{cells}</React.Fragment>)}
      </div>
    </div>
  );
}

/* ======================= the tab ======================= */

/* The 8 October 2026 layout: the actions and the outcome strip on top, then
 * the form in four groups in the order the decisions are made - Works,
 * Target, Launch, Assumptions - and the actions again at the foot. No header
 * strip of derived figures, no channel table, no copy: a figure's source is
 * a one-word tag in its box. `directSpread` is accepted for the App's sake;
 * the plan here reads Direct as a channel of its own either way. */
export default function TargetSetting({ snap, onSaved, directSpread = false }) {
  const [meta, setMeta] = useState(null);       // {inputs, sourced, benchmarks, meta_campaigns, derived, creating}
  const [inp, setInp] = useState(null);         // editable inputs
  const [pick, setPick] = useState(null);       // a basket chosen in the picker, not yet saved
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);
  const [buildSecs, setBuildSecs] = useState(null);   // how long the background rebuild has run
  const [editing, setEditing] = useState(false);      // the works' figures unlocked
  const [whyOpen, setWhyOpen] = useState(false);      // the untracked notice's explanation
  const [stretchUi, setStretchUi] = useState(null);   // even | paid | custom, once chosen on this visit
  const [assumeOpen, setAssumeOpen] = useState(false); // the assumptions' boxes open
  // the Slack channel the sell-through card posts to: its own small document
  // on the server (server/slack.js), saved on its own so a release without
  // targets can have one too
  const [slackDraft, setSlackDraft] = useState((snap.slack && snap.slack.channel) || "");
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackError, setSlackError] = useState(null);
  const [slackNote, setSlackNote] = useState(null);   // the server saved, but somewhere that will not last
  const slackCurrent = (snap.slack && snap.slack.channel) || "";
  const saveSlack = async () => {
    setSlackSaving(true); setSlackError(null); setSlackNote(null);
    try {
      const res = await fetch(`/api/releases/${snap.id}/slack-channel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: slackDraft }),
      });
      const d = await res.json();
      if (!res.ok) { setSlackError(d.error || `save failed (${res.status})`); return; }
      setSlackDraft((d.slack && d.slack.channel) || "");
      setSlackNote(d.warning || null);
      onSaved({ ...snap, slack: d.slack });
    } catch (e) { setSlackError(String(e)); } finally { setSlackSaving(false); }
  };

  useEffect(() => {
    setMeta(null); setInp(null); setError(null); setPick(null); setPicking(false); setEditing(false); setWhyOpen(false);
    setStretchUi(null); setAssumeOpen(false);
    setSlackDraft((snap.slack && snap.slack.channel) || ""); setSlackError(null); setSlackNote(null);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      // a release nobody has set targets for comes back with inputs: null and
      // the defaults the ETL could derive - the form starts from those
      const raw = d.inputs || d.defaults;
      // inputs saved under earlier shapes: the Referral Artist row of the
      // retired quality grid (N/A = the artist's own channels off), one Meta
      // campaign, and the release-level economics at the top level (kept as
      // legacy_economics until cleared); the posting tier that row became was
      // retired on 7 October 2026 and is dropped on the next save
      const legacyTier = (raw.channel_quality_overrides || {})["Referral Artist"];
      const topLegacy = {};
      for (const k of LEGACY_KEYS) if (raw[k] !== undefined && raw[k] !== null) topLegacy[k] = raw[k];
      const start = { ...raw };
      for (const k of LEGACY_KEYS) delete start[k];
      Object.assign(start, {
        channels_off: raw.channels_off || (legacyTier === "N/A" ? ["referral_artist"] : []),
        campaign_names: Array.isArray(raw.campaign_names) ? raw.campaign_names : (raw.campaign_name ? [raw.campaign_name] : []),
        products: Array.isArray(raw.products) ? raw.products : [],
        legacy_economics: raw.legacy_economics !== undefined ? raw.legacy_economics : (Object.keys(topLegacy).length ? topLegacy : null),
      });
      delete start.campaign_name;
      setMeta({ ...d, inputs: start, creating: !d.inputs });
      setInp({ ...start });
    }).catch((e) => setError(String(e)));
  }, [snap.id]);

  const creating = !!(meta && meta.creating);
  const b = meta ? meta.benchmarks : null;
  const sourced = (meta && meta.sourced) || { airtable: { match: "none", note: "", products: [] }, notion: {}, clock: {}, campaigns: [] };
  const atProducts = (sourced.airtable && sourced.airtable.products) || [];

  // the products in force and the release's economics, live as figures are
  // typed (shared/economics.mjs mirrors resolve_release in the build)
  const products = useMemo(() => (inp && b ? resolveProducts(atProducts, inp.products, b) : []), [inp, b, atProducts]);
  const econ = useMemo(() => (inp && b ? releaseEconomics(products, inp.legacy_economics, b) : null), [products, inp, b]);
  const ready = !!(inp && econ);

  // a rebuild still running from a save made before the reader left the
  // tab: pick it up again, counter and all, so coming back shows where it
  // is and the page lands when it finishes
  useEffect(() => {
    let live = true;
    fetch(`/api/inputs/${snap.id}/build`).then((r) => r.json()).then(async (st) => {
      if (!live || !st || st.status !== "running") return;
      setSaving(true);
      const startedAt = st.startedAt ? Date.parse(st.startedAt) : NaN;
      try {
        const snapshot = await followBuild(Number.isFinite(startedAt) ? startedAt : Date.now());
        if (live && snapshot) onSaved(snapshot);
      } finally {
        if (live) { setSaving(false); setBuildSecs(null); }
      }
    }).catch(() => { /* no build record: nothing to follow */ });
    return () => { live = false; };
  }, [snap.id]);

  if (error && !meta) return <div style={{ color: C.muted, padding: 24 }}>Failed to load inputs: {error}</div>;
  if (!ready) return <div style={{ color: C.muted, padding: 24 }}>Loading…</div>;

  const set = (k) => (e) => setInp({ ...inp, [k]: e.target.value });
  const dv = meta.derived || {};
  const dirty = !!pick || JSON.stringify(inp) !== JSON.stringify(meta.inputs);

  /* ---- the dates, by source: the Notion log, then what was typed, then the
   * funnel's clock, then Airtable (resolve_release reads them the same way) */
  const dateOf = (f) => {
    const n = (sourced.notion || {})[f], c = (sourced.clock || {})[f], a = (sourced.airtable || {})[f];
    if (n) return [n, "notion"];
    if (inp[f] && inp[f] !== c) return [inp[f], "typed"];
    if (inp[f] && inp[f] === c) return [c, "clock"];
    if (c) return [c, "clock"];
    if (a) return [a, "airtable"];
    return [null, null];
  };
  const [prOpen, prSrc] = dateOf("private_room_open");
  const [announce, annSrc] = dateOf("announce_date");
  const [closes, closeSrc] = dateOf("launch_end");
  // the marketing lead the feeds hold: the Notion log first (where the team records it), else Airtable's field
  const leadSourced = (sourced.notion || {}).marketing_lead ? { value: sourced.notion.marketing_lead, from: "Notion" }
    : (sourced.airtable || {}).marketing_lead ? { value: sourced.airtable.marketing_lead, from: "Airtable" } : null;
  const codeInForce = inp.campaign_code || (inp.campaign_names[0] ? inp.campaign_names[0].split(" · ")[0] : "") || dv.campaign_code || "";

  /* ---- the benchmark half of the form (§5, §8) ---- */
  const bm = snap.benchmark || null;
  const savedSpec = (meta.inputs && meta.inputs.benchmark_basket) || null;
  const spec = inp.benchmark_basket || null;
  const basketDirty = JSON.stringify(spec) !== JSON.stringify(savedSpec);
  const prof = (pick && pick.profile) || null;
  const basketName = pick ? pick.name
    : (bm && bm.basket && bm.basket.name) || (spec && spec.name) || "";
  const off = channelsOffOf(inp);
  const isOff = (g) => off.includes(g);
  const setOff = (g, on) => setInp({ ...inp, channels_off: on ? off.filter((x) => x !== g) : [...off, g] });
  const profile = prof ? applyChannelsOff(prof, off) : bm ? applyChannelsOff(profileOf(bm), off) : null;
  const editionSize = econ.edition_size || 0;
  const bmUnits = profile && profile.units > 0 ? profile.units : null;
  const k = bmUnits ? (editionSize > 0 ? editionSize / bmUnits : bm ? bm.k : null) : null;
  /* where the stretch comes from (BENCHMARK_SPEC 4.4): a share per channel
   * group, kept as fractions that add to 1; null means the basket's own
   * shares - the even uplift */
  const stretchFrom = inp.stretch_from && typeof inp.stretch_from === "object" && !Array.isArray(inp.stretch_from) ? inp.stretch_from : null;
  const stretchTyped = !!(stretchFrom && GROUPS.some((g) => !isOff(g.key) && Number(stretchFrom[g.key]) > 0));
  // the price of a paid unit: the release's own, else the basket's median cost
  // per paid unit, else the panel's constant (shared/benchmarkModel.mjs)
  const basketCpp = profile && Number(profile.cost_per_purchase) > 0 ? Number(profile.cost_per_purchase) : 0;
  const panelCpp = Number((b.cost_per_purchase || {}).Median) || 0;
  const cpp = Number(inp.cost_per_purchase) > 0 ? Number(inp.cost_per_purchase) : basketCpp > 0 ? basketCpp : panelCpp;
  const partialEdition = econ.edition_total > econ.edition_size && econ.edition_size > 0;

  /* ---- the products: a typed figure lands on the entry for that product
   * (by Airtable id, or by name for one added by hand), blank clears it */
  const sameEntry = (t, p) => (p.airtable_id ? String(t.airtable_id) === String(p.airtable_id) : (t.manual && norm(t.name) === norm(p.name)));
  const applyEntry = (list, p, patch) => {
    const out = [...list];
    let i = out.findIndex((t) => sameEntry(t, p));
    if (i < 0) { out.push(p.airtable_id ? { airtable_id: p.airtable_id } : { manual: true, name: p.name }); i = out.length - 1; }
    out[i] = { ...out[i], ...patch };
    return out;
  };
  // what a typed figure means: a fraction for the percentages, a whole
  // number for an edition, null for a cleared box, undefined for nonsense
  const parseField = (key, raw) => {
    if (key === "framing_available") return !!raw;
    const clean = String(raw).replace(/[^0-9.]/g, "");
    if (clean === "") return null;
    let v = parseFloat(clean);
    if (!Number.isFinite(v)) return undefined;
    if (PCT.has(key)) v = clamp(v, 0, 100) / 100;
    if (key === "edition") v = Math.round(v);
    return v;
  };
  // the deal is one or the other: a revenue share typed clears a profit
  // share, and the other way round, so the two never travel together
  const patchFor = (key, v) => {
    const patch = { [key]: v };
    if (key === "aa_revenue_share" && v !== null) patch.aa_profit_share = null;
    if (key === "aa_profit_share" && v !== null) patch.aa_revenue_share = null;
    return patch;
  };
  const onField = (p, key, raw) => {
    const v = parseField(key, raw);
    if (v === undefined) return;
    setInp((prev) => ({ ...prev, products: applyEntry(prev.products || [], p, patchFor(key, v)) }));
  };
  // every product at once, leaving out the ones whose cell is closed
  const onFieldAll = (key, raw) => {
    const v = parseField(key, raw);
    if (v === undefined) return;
    const open = products.filter((p) => !closedFor(p, key));
    setInp((prev) => ({ ...prev, products: open.reduce((list, p) => applyEntry(list, p, patchFor(key, v)), prev.products || []) }));
  };
  const onName = (p, name) => {
    const list = (inp.products || []).map((t) => (t.manual && norm(t.name) === norm(p.name) ? { ...t, name } : t));
    setInp({ ...inp, products: list });
  };
  const onAdd = () => {
    const n = (inp.products || []).filter((t) => t.manual).length + 1;
    setInp({ ...inp, products: [...(inp.products || []), { manual: true, name: `Product ${n}` }] });
  };
  const onRemove = (p) => setInp({ ...inp, products: (inp.products || []).filter((t) => !(t.manual && norm(t.name) === norm(p.name))) });
  // the tick: an unticked work stays on the grid with its typed figures and
  // counts nothing; ticked again, an entry that carried nothing else goes
  const bare = (t) => Object.entries(t).every(([k, v]) => k === "airtable_id" || k === "manual" || (k === "name" && !t.manual) || v === null || v === undefined || v === "");
  const onInclude = (p, on) => setInp((prev) => {
    const list = prev.products || [];
    if (!on) return { ...prev, products: applyEntry(list, p, { excluded: true }) };
    const out = list.map((t) => (sameEntry(t, p) ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== "excluded")) : t));
    return { ...prev, products: out.filter((t) => !(sameEntry(t, p) && t.airtable_id && bare(t))) };
  });
  // back to Airtable's figures: one product's typed entry dropped, or all of
  // them; a tick left off stays off
  const onReset = (p) => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => ((p.airtable_id && String(t.airtable_id) === String(p.airtable_id))
    ? (t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : []) : [t])) }));
  const onResetAll = () => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => (!t.airtable_id ? [t] : t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : [])) }));
  const typedCount = products.filter((p) => p.airtable_id).reduce((s, p) => s + typedKeys(p).length, 0);
  const manualCount = products.filter((p) => !p.airtable_id).length;
  const excludedCount = products.filter((p) => p.excluded).length;
  // the picker asks for a target and a price when there are none: they land
  // on a product added by hand, so the basket follows the typing
  const onPickerInputs = (patch) => {
    const name = "Release";
    const entry = (inp.products || []).find((t) => t.manual && norm(t.name) === norm(name)) || { manual: true, name };
    const next = { ...entry };
    if (patch.edition_size !== undefined) next.edition = patch.edition_size || null;
    if (patch.unit_price !== undefined) { next.unit_price = patch.unit_price || null; next.currency = "EUR"; }
    const rest = (inp.products || []).filter((t) => !(t.manual && norm(t.name) === norm(name)));
    setInp({ ...inp, products: [...rest, next] });
  };

  const onPick = (chosen) => {
    setPick(chosen);
    setPicking(false);
    setInp({
      ...inp,
      benchmark_basket: chosen.kind === "bespoke"
        ? { kind: "bespoke", members: chosen.members, name: chosen.name }
        : { kind: chosen.kind, id: chosen.id },
      // the picker's recency switch is a release input: the rule reads it on
      // every rebuild, so the suggestion stays the one that was looked at
      prefer_recent: chosen.preferRecent !== false,
    });
  };

  // what the targets still need before the release can be set up
  const missing = [];
  if (!(econ.edition_size > 0)) missing.push("a product with an edition");
  if (econ.edition_size > 0 && !(econ.launch_value > 0)) missing.push("a unit price");
  if (!announce) missing.push("the announce date");
  if (!closes) missing.push("the draw close");

  const save = async () => {
    setSaving(true); setError(null); setBuildSecs(null);
    try {
      // legacy_economics rides only as a clearing (null): the figures
      // themselves are never re-sent, the server keeps or drops the block
      const { legacy_economics, campaign_name, ...rest } = inp;
      const body = { ...rest, channels_off: off, ...(legacy_economics === null ? { legacy_economics: null } : {}) };
      const res = await fetch(`/api/inputs/${snap.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: body }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `save failed (${res.status})`); return; }
      if (d.warning) setError(d.warning);
      // the inputs are saved at this point, whatever the rebuild does next
      setMeta({ ...meta, creating: false, inputs: { ...inp }, storage: d.storage || meta.storage });
      setPick(null);
      // the page is rebuilt behind the answer; the tab follows the build so
      // the new figures land here too, and the browser is never held on it
      let snapshot = d.snapshot || null;
      if (d.queued) snapshot = await followBuild(Date.now());
      if (snapshot) onSaved(snapshot);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(String(e)); } finally { setSaving(false); setBuildSecs(null); }
  };
  const discard = () => {
    setInp({ ...meta.inputs });
    setPick(null);
    setStretchUi(null);
  };

  /* Follow the rebuild running behind a save until it lands, counting the
   * seconds, then read the page as rebuilt (null when it failed, or when the
   * service restarted under it and the page is read as it is). Shared by a
   * save made here and one made before the reader left the tab. */
  async function followBuild(startedAt) {
    let snapshot = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      setBuildSecs(Math.round((Date.now() - startedAt) / 1000));
      let st = null;
      try { st = await (await fetch(`/api/inputs/${snap.id}/build`)).json(); } catch { st = null; }
      if (st && st.status === "running") continue;
      if (st && st.status === "failed") {
        setError("Inputs saved, but the rebuild failed (" + (st.error || "no detail") + ") - the page will update on the next data refresh.");
        break;
      }
      try { const r = await fetch(`/api/releases/${snap.id}`); if (r.ok) snapshot = await r.json(); } catch { /* the page stays as it was */ }
      break;
    }
    return snapshot;
  }

  /* The rail's figures (§8.3), from the same model the build runs: the
   * target, the basket's benchmark and the stretch between them. */
  const T = profile ? benchmarkTargets(profile, {
    edition_size: editionSize, unit_price: econ.unit_price || 0, cost_per_purchase: cpp,
    units_per_buyer: (snap.targets || {}).units_per_buyer || 0,
    entry_conversion_rate: inp.entry_conversion_rate,
    stretch_from: stretchFrom,
  }, b) : null;
  const signed = (v) => (v < 0 ? MINUS : "+") + fmt(Math.abs(v), 0);
  const BM = T ? T.benchmark : null;
  const paidOff = isOff("paid");
  /* the stretch: a three-way choice - the basket's own shares (the even
   * uplift), all of it from paid, or custom shares on coupled sliders that
   * always add to 100 (shared/benchmarkModel.mjs rebalanceShares) */
  const activeGroups = profile ? GROUPS.map((g) => g.key).filter((g) => !isOff(g) && Number((profile.units_by_group || {})[g]) > 0) : [];
  const evenShares = profile ? stretchWeights({ stretch_from: null }, profile.units_by_group) : {};
  const shares = T && T.stretch_from ? T.stretch_from : evenShares;
  const allPaid = stretchTyped && Number(stretchFrom.paid || 0) >= 0.995;
  const stretchMode = stretchUi || (!stretchTyped ? "even" : allPaid ? "paid" : "custom");
  const chooseStretch = (mode) => {
    setStretchUi(mode);
    if (mode === "even") setInp({ ...inp, stretch_from: null });
    else if (mode === "paid") setInp({ ...inp, stretch_from: { paid: 1 } });
    else if (!stretchTyped) setInp({ ...inp, stretch_from: { ...evenShares } });
  };
  const slideStretch = (key) => (e) => setInp({ ...inp, stretch_from: rebalanceShares(shares, key, Number(e.target.value) / 100, activeGroups) });
  // the units of stretch a channel carries at the shares set: its target less its benchmark (benchmarkTargets)
  const stretchOf = (key) => (T && T.units_by_group ? Number(T.units_by_group[key] || 0) - Number((profile.units_by_group || {})[key] || 0) : 0);
  const stretchWords = T ? (stretchMode === "paid" ? "all from paid" : stretchMode === "even" ? "even across channels" : "custom shares") : null;

  /* a date another source puts elsewhere than the one in force (docs 1.6):
     a small button beside it with the other reading, one click to take it */
  const driftOf = (f, value, src) => Object.entries({ airtable: (sourced.airtable || {})[f], clock: (sourced.clock || {})[f] })
    .filter(([name, d]) => d && d !== value && name !== src);
  // the works' own closes as the build reads them (etl/build.py
  // product_closes over the sized works in the release): an unticked work's
  // day drops out, so the line under Draw closes says what the page will
  const workCloses = (() => {
    const by = new Map();
    for (const p of products) {
      if (p.excluded || !p.edition || !p.launch_date) continue;
      const d = String(p.launch_date).slice(0, 10);
      if (!by.has(d)) by.set(d, []);
      by.get(d).push(p.name || "");
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, names]) => ({ date, works: names.length, names }));
  })();
  const SRC_TAG = { notion: "Notion", typed: "typed", clock: "funnel", airtable: "Airtable" };
  const dateCol = (label, f, value, src, tip) => {
    const drift = driftOf(f, value, src);
    return (
      <div key={f} className="ts2-col">
        <label className="sub" htmlFor={`ts-${f}`} title={tip}>{label}</label>
        <div className="ts2-ctl" style={{ minHeight: 0 }}>
          {src === "notion"
            ? <div className="ts-box ro" style={{ flex: "1 1 150px" }} title="From the Notion log"><span className="txt">{fmtDate(value)}</span><span className="ts2-tag">Notion</span></div>
            : (
              <div className="ts-box" style={{ flex: "1 1 150px" }}>
                <input id={`ts-${f}`} type="date" value={value || ""} onChange={set(f)} />
                {src ? <span className={`ts2-tag${src === "typed" ? " typed" : ""}`}>{SRC_TAG[src]}</span> : null}
              </div>
            )}
          {src !== "notion" && drift.map(([name, d]) => (
            <button key={name} type="button" className="ts-btn secondary sm" onClick={() => setInp({ ...inp, [f]: d })}
              title={`Take the ${name === "airtable" ? "Airtable" : "funnel clock"} date, ${fmtDate(d)}.`}>
              {name === "airtable" ? "Airtable" : "Funnel"}: {fmtDate(d)}
            </button>
          ))}
        </div>
        {f === "launch_end" && workCloses.length > 1 && (
          <span className="ts2-tag" style={{ maxWidth: "100%", justifySelf: "start" }} title="The works close on different days: the page runs to the last, the sell-through counts each at its own draw.">
            {workCloses.map((c) => `${fmtDate(c.date)} ${c.works === 1 && c.names && c.names[0] ? c.names[0] : `${c.works} works`}`).join(" · ")}
          </span>
        )}
      </div>
    );
  };
  const legacy = inp.legacy_economics;
  // the last build found the works' editions do not add up to the release's
  // (docs 6.3): said here, where both are set, as on the Sell-through card
  const stEd = snap.sellthrough || {};
  const editionNote = stEd.editionMismatch && Number.isFinite(stEd.editionSum) && Number.isFinite(stEd.edition)
    ? { sum: stEd.editionSum, release: stEd.edition } : null;
  const airtableMatch = (sourced.airtable || {}).match || "none";
  const airtableNote = (sourced.airtable || {}).note || "";

  /* Untracked much higher than normal (DATA_MODEL 1.3): the build says which
   * of entries and units has a share over twice the panel's median and past
   * its 90th percentile; the line quotes the share and the norm. */
  const ut = snap.untracked || null;
  const untrackedHigh = ut && Array.isArray(ut.high) ? ut.high.filter((key) => ut[key] && ut[key].share !== null).map((key) => ({ key, v: ut[key], n: (ut.normal || {})[key] || {} })) : [];

  const saveLabel = saving ? (buildSecs !== null ? `Rebuilding… ${buildSecs}s` : "Saving…") : savedFlash ? "✓ Saved" : creating ? "Set targets" : "Save targets";
  const stateText = saving ? null
    : missing.length ? `Needs ${missing.join(", ")}`
      : dirty ? (basketDirty ? "Unsaved · a new basket is a longer save" : "Unsaved changes")
        : creating ? "Not set up yet" : null;
  const worksDesc = [
    airtableMatch !== "none" ? `${atProducts.length} from Airtable` : "none in Airtable",
    typedCount ? `${typedCount} typed` : null,
    manualCount ? `${manualCount} by hand` : null,
    excludedCount ? `${excludedCount} unticked` : null,
  ].filter(Boolean).join(" · ");
  const asPct = (v) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 100)));
  const cannDefault = Math.round(100 * (Number(b.cannibalisation) || 0.2));
  const e2oDefault = Math.round(100 * (Number(b.eligible_entry_to_order) || 0.8));
  const sense = T && T.paid ? T.paid.sense_check_breached : false;
  const actions = (cls) => (
    <div className={cls}>
      {stateText && <span className={`ts2-state${missing.length ? " warn" : ""}`}>{stateText}</span>}
      <button type="button" className="ts-btn secondary" onClick={discard} disabled={saving || !dirty} title="Back to what is saved.">Discard</button>
      <button type="button" className="ts-btn primary" disabled={saving || missing.length > 0} onClick={save}
        title={missing.length ? `Still needed: ${missing.join(", ")}` : creating ? "Saves the inputs and rebuilds this release with the full target model." : "Saves the inputs and recomputes this release's targets, plan curves and projections."}>
        {saveLabel}
      </button>
      {error && <span className="ts2-state err">{error}</span>}
    </div>
  );

  return (
    <>
      <div className="ts2">
        {meta.storage && meta.storage.durable === false && (
          <Notice red>
            <span title={`Saves are written to ${meta.storage.path}`}><b>Targets saved here do not survive a deploy.</b> Point SAVED_INPUTS_PATH at a persistent disk (README, "Render's disk resets").</span>
          </Notice>
        )}
        {creating && (
          <Notice>
            {snap.upcoming
              ? <><b>Upcoming launch</b>, not in the funnel yet{dv.dates_note ? ` (${dv.dates_note})` : ""}. Check the dates, the campaigns and the basket, then save.</>
              : <><b>No targets yet.</b> The page shows actuals only until you save.</>}
          </Notice>
        )}
        {untrackedHigh.map((u) => (
          <Notice key={u.key} action={<button type="button" className="why" onClick={() => setWhyOpen(!whyOpen)}>{whyOpen ? "Close" : "Why"}</button>}>
            <b>Untracked is {fmtPct(u.v.share, 0)} of this release's {u.key}</b>, against {fmtPct(u.n.median, 0)} on a typical launch.
            {whyOpen && (
              <span> Untracked is the funnel export's channel for {u.key} that could not be attributed; the panel's 90th percentile is {fmtPct(u.n.p90, 0)}. The build spreads
                it across the tracked channels in proportion to what they did that day, so the channel split reads less certainly than usual.</span>
            )}
          </Notice>
        ))}

        {actions("ts2-bar")}

        {/* the outcome, one strip: what the inputs give, live */}
        <div className="ts2-strip" aria-label="Outcome">
          <div className="f" title={`Secured-units target: the hero target on the Overview tab, the works' editions at their target sell-through, summed${partialEdition ? ` - ${fmt(editionSize)} of the ${fmt(econ.edition_total)} in the editions` : ""}.`}>
            <span className="k">Target</span><span className="v">{editionSize > 0 ? fmt(editionSize) : "–"}</span>
          </div>
          <div className="f" title={bmUnits ? `The basket's median units of demand, the channels not in plan set aside${k ? `: ×${fmt(k, 2)} to the target` : ""}.` : "Choose a basket first."}>
            <span className="k">Benchmark</span><span className="v">{bmUnits ? fmt(bmUnits) : "–"}</span>
          </div>
          <div className="f" title={T ? `The target less the benchmark, ${stretchWords}.` : "Choose a basket first."}>
            <span className="k">Stretch</span><span className="v">{T ? signed(Math.round(T.stretch_units)) : "–"}</span>
          </div>
          <div className={`f${sense ? " red" : ""}`} title={paidOff ? "Paid is not in plan." : T ? `Paid units × ${fmtMoney(cpp)} per unit${BM && BM.paid_budget ? `; the benchmark's is ${fmtMoney(BM.paid_budget, 0)}` : ""}${T.paid.budget_pct_of_launch_value ? `; ${fmtPct(T.paid.budget_pct_of_launch_value, 1)} of the launch value` : ""}. ${sense ? "Over" : "Under"} the 6% of launch value sense check.` : "Choose a basket first."}>
            <span className="k">Paid budget</span><span className="v">{paidOff ? "–" : T ? fmtMoney(T.paid.budget, 0) : "–"}</span>
          </div>
          <div className="f" title={(econ.launch_currencies || []).some((c) => c !== "EUR") ? `Target units at their prices, from ${(econ.launch_currencies || []).join(", ")} at a fixed rate.` : "Target units at their prices."}>
            <span className="k">Launch value</span><span className="v">{econ.launch_value > 0 ? fmtMoney(econ.launch_value, 0) : "–"}</span>
          </div>
        </div>

        <div className="ts2-form">
          {/* 1 · works */}
          <section className="ts2-sec" aria-label="Works">
            <div className="ts2-sec-head">
              <h2>Works</h2>
              <span className="d">{worksDesc}</span>
              <div className="right">
                {editing && <button type="button" className="ts-btn secondary sm" onClick={onAdd}>Add a work</button>}
                {editing && typedCount > 0 && <button type="button" className="ts-btn secondary sm" onClick={onResetAll} title="Drop every typed figure: back to Airtable's on every work.">Reset all</button>}
                <button type="button" className={`ts-switch${editing ? " on" : ""}`} aria-pressed={editing} onClick={() => setEditing(!editing)}
                  title={editing ? "Lock the figures again; what was typed stays." : "Unlock the figures to type over Airtable's, or to add a work by hand."}>
                  <span className="tr" />Edit figures
                </button>
              </div>
            </div>
            {legacy && (
              <Notice action={(
                <button type="button" className="ts-btn secondary" onClick={() => setInp({ ...inp, legacy_economics: null })}
                  title="Drop the release-level figures: the works' figures carry the totals from the next save.">Use the works' figures</button>
              )}>
                <b>Release-level figures still in force:</b> target {fmt(legacy.edition_size)}{legacy.edition_total > legacy.edition_size ? ` of ${fmt(legacy.edition_total)}` : ""} units at {fmtMoney(legacy.unit_price || 0, 0)},
                artist {fmtMoney((legacy.artist_profit || 0) / (legacy.edition_size || 1), 0)} and AA {fmtMoney((legacy.aa_group_profit || 0) / (legacy.edition_size || 1), 0)} per unit.
              </Notice>
            )}
            {editionNote && (
              <Notice>
                <b>The works' editions add up to {fmt(editionNote.sum)}; the release's edition is {fmt(editionNote.release)}.</b> One of the two is wrong.
              </Notice>
            )}
            <WorksSheet products={products} econ={econ} airtable={atProducts} b={b} editing={editing}
              onField={onField} onFieldAll={onFieldAll} onName={onName} onRemove={onRemove} onReset={onReset} onInclude={onInclude} emptyNote={airtableNote} />
          </section>

          {/* 2 · target */}
          <section className="ts2-sec" aria-label="Target">
            <div className="ts2-sec-head"><h2>Target</h2></div>
            <div className="ts2-rows">
              <span className="ts2-lbl" title="The launches this release is benchmarked against. The benchmark is their median, per metric and per channel.">Basket</span>
              <div className="ts2-ctl">
                <div className="ts-box ro" style={{ flex: "1 1 240px", maxWidth: 480 }} title={bm && bm.basket ? `${fmt(bm.basket.n)} launches${bm.basket.thin ? ", thin" : ""}` : undefined}>
                  <span className="txt">{basketName || "none chosen yet"}</span>
                  {basketDirty ? <span className="ts2-tag typed">unsaved</span> : bm && bm.basket ? <span className="ts2-tag">{fmt(bm.basket.n)} launches</span> : null}
                </div>
                <button type="button" className="ts-btn secondary" onClick={() => setPicking(true)}
                  title="The ready-made baskets with their medians, or a bespoke selection.">Change basket</button>
              </div>

              <span className="ts2-lbl" title="A channel this release will not run leaves the benchmark and the target: the basket is read on its other channels, and they carry the whole sellout between them.">Channels in plan</span>
              <div className="ts2-ctl ts-switches" style={{ height: "auto", minHeight: 44 }}>
                <Switch on={!paidOff} onChange={(on) => setOff("paid", on)} label="Running paid"
                  title="The basket keeps every launch, paid or not; with paid off each counts on its other channels only." />
                <Switch on={!isOff("referral_artist")} onChange={(on) => setOff("referral_artist", on)} label="Artist's own channels"
                  title="Off for an estate, or a living artist with no channels of their own: the artist group leaves the benchmark and the funnel expects no posts." />
              </div>

              <span className="ts2-lbl" title="How the gap between the target and the basket's median is shared out. Each channel's target is its benchmark plus its share of the stretch, with its sessions and entries lifted to match; conversion is held.">Stretch from</span>
              <div className="ts2-ctl" style={{ flexDirection: "column", alignItems: "stretch", gap: 14 }}>
                <div className="ts2-ctl">
                  <div className="seg" role="group" aria-label="Where the stretch comes from">
                    <button type="button" className={stretchMode === "even" ? "active" : ""} disabled={!profile} onClick={() => chooseStretch("even")}
                      title="The basket's own shares: the same uplift in every channel.">Even across channels</button>
                    <button type="button" className={stretchMode === "paid" ? "active" : ""} disabled={!profile || paidOff} onClick={() => chooseStretch("paid")}
                      title="The whole stretch from paid: the other channels stay at their benchmark.">All from paid</button>
                    <button type="button" className={stretchMode === "custom" ? "active" : ""} disabled={!profile || activeGroups.length < 2} onClick={() => chooseStretch("custom")}
                      title="Set each channel's share on a slider; the others rescale so the shares add to 100.">Custom</button>
                  </div>
                  {T && <span className="ts2-stretch num" title={`${stretchWords}: ×${fmt(k || 1, 2)} over the basket in all`}>{signed(Math.round(T.stretch_units))} <span>units</span></span>}
                </div>
                {stretchMode === "custom" && profile && (
                  <div className="ts2-card ts-sliders" style={{ padding: "16px 20px", maxWidth: 640 }}>
                    {GROUPS.map((g) => {
                      const gOff = isOff(g.key);
                      const active = activeGroups.includes(g.key);
                      const pct = active ? Math.round(100 * Number(shares[g.key] || 0)) : 0;
                      return (
                        <label key={g.key} className={`ts-slider${active ? "" : " dis"}`}
                          title={gOff ? "Not in plan: this channel takes none of the stretch." : !active ? "No benchmark in the basket to lift." : "Drag to set this channel's share; the others rescale so the shares add to 100."}>
                          <span className="head"><span>{g.name}</span><b>{active ? `${pct}%` : "–"}</b></span>
                          <input type="range" min="0" max="100" step="1" disabled={!active || activeGroups.length < 2} value={pct}
                            aria-label={`${g.name}: share of the stretch`} onChange={slideStretch(g.key)} />
                          <span className="note">{active ? `${signed(Math.round(stretchOf(g.key)))} units` : ""}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* 3 · launch */}
          <section className="ts2-sec" aria-label="Launch">
            <div className="ts2-sec-head"><h2>Launch</h2></div>
            <div className="ts2-rows">
              <span className="ts2-lbl" style={{ paddingTop: 0 }}>Dates</span>
              <div className="ts2-dates">
                {dateCol("Private room opens", "private_room_open", prOpen, prSrc, "The day of the early-access email, from the Notion log. Until the log has it: what is typed, else two weeks before the announce.")}
                {dateCol("Announce", "announce_date", announce, annSrc, "From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
                {dateCol("Draw closes", "launch_end", closes, closeSrc, "The launch: the day the draw closes and sales open. From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
              </div>

              <span className="ts2-lbl" title="Which Meta ad campaigns this release's paid actuals are read from - rows matching these names in the live spend feed, summed.">Meta campaigns</span>
              <div className="ts2-ctl" style={{ display: "block" }}>
                <Campaigns code={codeInForce} chosen={inp.campaign_names} all={meta.meta_campaigns} suggested={sourced.campaigns}
                  onChange={(names) => setInp({ ...inp, campaign_names: names })} />
              </div>

              {!codeInForce && (
                <>
                  <label className="ts2-lbl" htmlFor="ts-code" title="The code the email, Instagram and artist-post feeds tag this campaign with (e.g. GlennLigon_LE_26). Read off the Meta campaign's name when one is ticked.">Campaign code</label>
                  <div className="ts2-ctl"><div className="ts-box" style={{ flex: "1 1 200px", maxWidth: 320 }}><input id="ts-code" value={inp.campaign_code || ""} onChange={set("campaign_code")} placeholder="Artist_LE_26" /></div></div>
                </>
              )}

              <span className="ts2-lbl" style={{ paddingTop: 0 }}>Lead and Slack</span>
              <div className="ts2-two">
                <div className="ts2-col">
                  <label className="sub" htmlFor="ts-lead">Marketing lead</label>
                  <div className="ts2-ctl" style={{ minHeight: 0 }}>
                    {leadSourced
                      ? <div className="ts-box ro" style={{ flex: "1 1 150px" }} title={`From ${leadSourced.from}`}><span className="txt">{leadSourced.value}</span><span className="ts2-tag">{leadSourced.from}</span></div>
                      : <div className="ts-box" style={{ flex: "1 1 150px" }}><input id="ts-lead" value={inp.marketing_lead || ""} onChange={set("marketing_lead")} placeholder="Who runs this launch" /></div>}
                  </div>
                </div>
                <div className="ts2-col">
                  <label className="sub" htmlFor="ts-slack" title="Where Post to Slack on the sell-through card sends this release's update: the channel name without the #. For a private channel, invite the Launch Performance bot first. Saved on its own.">Slack channel</label>
                  <div className="ts2-ctl" style={{ minHeight: 0 }}>
                    <div className="ts-box" style={{ flex: "1 1 150px" }}>
                      <input id="ts-slack" value={slackDraft} onChange={(e) => setSlackDraft(e.target.value)} placeholder="launch-updates" />
                      {slackError ? <span className="ts2-tag red" title={slackError}>not saved</span>
                        : slackNote ? <span className="ts2-tag warn" title={slackNote}>saved, not for long</span>
                          : snap.slack && snap.slack.lastPostAt ? <span className="ts2-tag" title={`Last posted ${new Date(snap.slack.lastPostAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}>posted</span> : null}
                    </div>
                    <button type="button" className="ts-btn secondary sm" disabled={slackSaving || slackDraft.trim().replace(/^#/, "") === slackCurrent} onClick={saveSlack}>
                      {slackSaving ? "Saving…" : "Save channel"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 4 · assumptions */}
          <section className="ts2-sec" aria-label="Assumptions">
            <div className="ts2-sec-head">
              <h2>Assumptions</h2>
              <div className="right">
                <button type="button" className="ts-btn secondary sm" onClick={() => setAssumeOpen(!assumeOpen)}>{assumeOpen ? "Done" : "Edit"}</button>
              </div>
            </div>
            {!assumeOpen ? (
              <div className="ts2-sum">
                <span><span className="k">Entry to order</span> <b>{inp.entry_conversion_rate ? `${asPct(inp.entry_conversion_rate)}%` : `${e2oDefault}%`}</b></span>
                <span><span className="k">Pre-order to order</span> <b>{inp.preorder_conversion_rate ? `${asPct(inp.preorder_conversion_rate)}%` : "95%"}</b></span>
                <span><span className="k">Cost per paid unit</span> <b>{fmtMoney(cpp, 0)}</b></span>
                <span><span className="k">Paid cannibalisation</span> <b>{inp.cannibalisation !== null && inp.cannibalisation !== undefined ? `${Math.round(Number(inp.cannibalisation) * 100)}%` : `${cannDefault}%`}</b></span>
              </div>
            ) : (
              <div className="ts2-rows">
                <label className="ts2-lbl" title="What share of eligible entries in hand become orders. Blank is the panel's standard.">Entry to order</label>
                <div className="ts2-ctl">
                  <div style={{ width: 150 }}>
                    <NumBox value={asPct(inp.entry_conversion_rate)} placeholder={String(e2oDefault)} unit="%"
                      onCommit={(raw) => { const c = String(raw).replace(/[^0-9]/g, ""); setInp((prev) => ({ ...prev, entry_conversion_rate: c === "" ? null : clamp(parseInt(c, 10), 1, 100) / 100 })); }} />
                  </div>
                  {inp.entry_conversion_rate ? <span className="ts2-tag typed">typed</span> : <span className="ts2-tag">default</span>}
                </div>
                <label className="ts2-lbl" title="What share of pre-order entries become orders. Their card is already authorised, so they convert higher than a plain entry. Blank is 95%.">Pre-order to order</label>
                <div className="ts2-ctl">
                  <div style={{ width: 150 }}>
                    <NumBox value={asPct(inp.preorder_conversion_rate)} placeholder="95" unit="%"
                      onCommit={(raw) => { const c = String(raw).replace(/[^0-9]/g, ""); setInp((prev) => ({ ...prev, preorder_conversion_rate: c === "" ? null : clamp(parseInt(c, 10), 1, 100) / 100 })); }} />
                  </div>
                  {inp.preorder_conversion_rate ? <span className="ts2-tag typed">typed</span> : <span className="ts2-tag">default</span>}
                </div>
                <label className="ts2-lbl" title="What a paid unit costs to buy: paid units at this price is the paid budget. Blank is the basket's median cost per paid unit, or the panel's when fewer than three of the basket's launches have spend on file.">Cost per paid unit</label>
                <div className="ts2-ctl">
                  <div style={{ width: 150 }}>
                    <NumBox value={inp.cost_per_purchase === null || inp.cost_per_purchase === undefined ? "" : String(inp.cost_per_purchase)}
                      placeholder={fmt(basketCpp > 0 ? basketCpp : panelCpp)} unit="€"
                      onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, cost_per_purchase: c === "" ? null : c })); }} />
                  </div>
                  {Number(inp.cost_per_purchase) > 0 ? <span className="ts2-tag typed">typed</span> : <span className="ts2-tag">{basketCpp > 0 ? "basket" : "panel"}</span>}
                </div>
                <label className="ts2-lbl" title="The share of paid entries that would have come anyway. The ROI and the budget floor read profit net of it.">Paid cannibalisation</label>
                <div className="ts2-ctl">
                  <div style={{ width: 150 }}>
                    <NumBox value={inp.cannibalisation === null || inp.cannibalisation === undefined ? "" : String(Math.round(Number(inp.cannibalisation) * 1000) / 10)}
                      placeholder={String(cannDefault)} unit="%"
                      onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), 0, 95) / 100; setInp((prev) => ({ ...prev, cannibalisation: v === null || Number.isNaN(v) ? null : v })); }} />
                  </div>
                  {inp.cannibalisation !== null && inp.cannibalisation !== undefined ? <span className="ts2-tag typed">typed</span> : <span className="ts2-tag">default</span>}
                </div>
              </div>
            )}
          </section>

          {actions("ts2-foot")}
        </div>
      </div>

      {picking && (
        <BasketPicker releaseId={snap.id} releaseName={snap.releaseName} current={spec}
          targetUnits={editionSize} unitPrice={econ.unit_price || 0}
          preferRecent={inp.prefer_recent !== false} channelsOff={off}
          // what the rule needs to find the artist's own earlier launches and
          // to read the typed price in its currency (shared/basketRule.mjs)
          artist={snap.artist || ""} currency="EUR"
          announceDate={announce || null} privateRoomOpen={prOpen || null}
          // the page's day and the release's close: the rule reads a closed
          // release at its close, as the build does
          launchEnd={closes || null} asOf={snap.asOf || null}
          // the picker asks for a target and a price when there are none, and
          // writes them onto a product added by hand so the basket follows
          onInputs={onPickerInputs}
          onPick={onPick} onClose={() => setPicking(false)} />
      )}
    </>
  );
}
