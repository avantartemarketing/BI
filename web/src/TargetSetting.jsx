/* Target setting tab (docs/BENCHMARK_SPEC.md §8, docs/DATA_MODEL.md §1.6):
 * the target in a header that stays put and compacts as the page scrolls,
 * then one column of cards - Release & timeline, Benchmark basket, Products
 * & economics, Assumptions - recomputing live via shared/economics.mjs and
 * shared/benchmarkModel.mjs. Save persists the inputs and the server rebuilds
 * the release on them.
 *
 * Almost nothing here is typed. The products and their economics come from
 * Airtable, per work (edition, target sell-through, price, the artist's and
 * Avant Arte's profit per unit, the deal's revenue or profit share, the
 * framing assumptions), on a grid drawn the way Airtable draws one: the cell
 * is the input, locked until Edit figures is switched on, with a typed figure
 * marked and Airtable's underneath it. The dates come from the Notion log
 * (the early-access email opens the private room; the announce; the launch),
 * then the funnel's own clock, then Airtable; the marketing lead from
 * Airtable. What a person decides is which Meta campaigns are this
 * release's, which channels it will not run, and which basket it is measured
 * against.
 *
 * One form language throughout: a label above, the source or unit as a
 * caption beside it, a 44px box, a helper under (tokens.css, ".ts-").
 *
 * A release set up before the model went per product still carries its
 * release-level figures (legacy_economics); they stand in for its totals
 * until they are cleared here, and the products show what Airtable holds
 * beside them. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, MINUS, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import BasketPicker from "./BasketPicker.jsx";
import { resolveProducts, releaseEconomics, LEGACY_KEYS } from "../../shared/economics.mjs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf, profileOf } from "../../shared/benchmarkModel.mjs";

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
function Field({ label, src, tip, help, helpKind, children }) {
  return (
    <div className="ts-field">
      <div className="ts-label"><span title={tip}>{label}</span>{src ? <span className="src">{src}</span> : null}</div>
      {children}
      {help ? <div className={`ts-help${helpKind ? ` ${helpKind}` : ""}`}>{help}</div> : null}
    </div>
  );
}

const RoBox = ({ value, title }) => <div className="ts-box ro" title={title}><span className="txt">{value}</span></div>;

const TextBox = ({ value, onChange, placeholder, title, list }) => (
  <div className="ts-box" title={title}>
    <input value={value} onChange={onChange} placeholder={placeholder} list={list} />
  </div>
);

/* A number box: what is being typed while it is typed ("5." on the way to
 * "5.5"), the model's figure once it is left, the unit inside the box. */
function NumBox({ value, placeholder, unit, onCommit, title, disabled }) {
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
function Switch({ on, onChange, label, title }) {
  return (
    <button type="button" className={`ts-switch${on ? " on" : ""}`} aria-pressed={on} onClick={() => onChange(!on)} title={title}>
      <span className="tr" />{label}
    </button>
  );
}

const Notice = ({ red, children, action }) => (
  <div className={`ts-notice${red ? " red" : ""}`}><span>{children}</span>{action || null}</div>
);

const CardHead = ({ dot, title, desc, right }) => (
  <div className="ts-card-head">
    <span className="dot" style={{ background: dot }} /><span className="t">{title}</span>
    {desc ? <span className="d">{desc}</span> : null}
    {right ? <div className="right">{right}</div> : null}
  </div>
);

/* The Meta campaigns whose spend is this release's: the ones the spend feed
 * names for the campaign code, ticked or not, and any other campaign added by
 * name. The draw campaign is what the code matches on its own. */
function Campaigns({ code, chosen, all, suggested, onChange }) {
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
            <span className={`meta${hit ? "" : " warn"}`}>{hit ? `${fmtMoney(hit.spend)} · last ${hit.last}` : "no spend rows by this name"}</span>
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

/* ======================= the basket's channel table ======================= */

/* Nobody types into it: what the basket's median gives each channel and what
 * the target asks of it. Benchmark values are the basket's own medians; the
 * target is the benchmark lifted by K (§1). Conversion carries no uplift at
 * all - it is held at the benchmark (§4), which is why the column says so. */
function BasketTable({ profile, off, k }) {
  const rows = GROUPS.map((g) => ({
    ...g, off: off.includes(g.key),
    bmS: profile.sessions_by_group[g.key] || 0, bmU: profile.units_by_group[g.key] || 0,
    conv: profile.conv[g.key] > 0 ? profile.conv[g.key] : null,
  }));
  return (
    <div className="ts-tblwrap">
      <table className="ts-table">
        <thead>
          <tr>
            <th className="l">Channel</th>
            <th className="bm" title="The basket's median units from this channel.">Benchmark units</th>
            <th title="The benchmark lifted by the same K as every other volume.">Target units</th>
            <th className="bm" title="The basket's median sessions from this channel.">Benchmark sessions</th>
            <th title="The benchmark lifted by K.">Target sessions</th>
            <th title="Conversion rates are held at the benchmark - the uplift is asked of traffic and spend only.">Session → unit (held)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => r.off ? (
            <tr key={r.key}>
              <td className="l" style={{ color: C.muted }}>{r.name}</td>
              <td className="off" colSpan={5} title="Set aside on this tab: its median leaves the benchmark and the other channels carry the whole target.">not in plan</td>
            </tr>
          ) : (
            <tr key={r.key}>
              <td className="l">{r.name}</td>
              <td className="bm">{fmt(r.bmU)}</td>
              <td className="tg">{fmt(r.bmU * k)}</td>
              <td className="bm">{fmt(r.bmS)}</td>
              <td className="tg">{fmt(r.bmS * k)}</td>
              <td>{r.conv === null ? "" : fmtPct(r.conv, 2)}</td>
            </tr>
          ))}
          <tr className="foot">
            <td className="l">Total</td>
            <td className="bm">{fmt(profile.units)}</td>
            <td>{fmt(profile.units * k)}</td>
            <td className="bm">{fmt(profile.sessions)}</td>
            <td>{fmt(profile.sessions * k)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ======================= the products grid ======================= */

/* Percentages are typed as whole numbers and kept as fractions. */
const PCT = new Set(["target_sellthrough", "aa_revenue_share", "aa_profit_share", "frame_conversion"]);
// the grid's columns after the product: the header on one line, a glyph
// carrying the unit (# a count, % and € units, ƒ computed, ✓ on or off)
const GRID = [
  { key: "edition", label: "Edition", glyph: "#", tip: "Units in the edition of this work." },
  { key: "target_sellthrough", label: "Sell-through", glyph: "%", tip: "The share of the edition targeted to sell by close. Blank = Airtable's target (its units target over the edition, else the expected sell-through), else 100%." },
  { key: "unit_price", label: "Price", glyph: "€", tip: "Retail price per unit. Airtable prices in euros, the page's currency; a product in another currency is converted at a fixed rate." },
  { key: "target_units", label: "Target units", glyph: "ƒ", calc: true, tip: "Computed: edition × sell-through." },
  { key: "artist_profit_per_unit", label: "Artist profit", glyph: "€", tip: "The artist's profit on one unit sold." },
  { key: "aa_profit_per_unit", label: "AA profit", glyph: "€", tip: "Avant Arte's profit on one unit sold, before framing." },
  { key: "aa_revenue_share", label: "Revenue share", glyph: "%", tip: "Avant Arte's share of revenue on a royalty deal, where Avant Arte carries the ads outright. Closed while the product has a profit share." },
  { key: "aa_profit_share", label: "Profit share", glyph: "%", tip: "Avant Arte's share of profit on a profit-share deal, which is also its share of the paid budget. Closed while the product has a revenue share." },
  { key: "framing_available", label: "Framing", glyph: "✓", check: true, tip: "Whether a frame is offered on this work. Unticked closes the two frame cells." },
  { key: "frame_conversion", label: "Frames per print", glyph: "%", tip: "The share of buyers expected to take a frame. Blank = the benchmark default." },
  { key: "frame_profit_per_unit", label: "Frame profit", glyph: "€", tip: "Avant Arte's profit on each frame sold, which is Avant Arte's alone. Blank = the benchmark default." },
];
const cellText = (key, v, raw = false) => {
  if (v === null || v === undefined || v === "") return "";
  const n = PCT.has(key) ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100;
  return raw ? String(n) : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
/* The one-or-the-other rule: a product's deal is a revenue share or a profit
 * share, so while either holds a figure the other is closed; unticked
 * framing closes the two frame cells beside it. */
const closedFor = (p, key) => {
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

function ProductsGrid({ products, econ, editing, onField, onFieldAll, onName, onAdd, onRemove, onReset, emptyNote }) {
  // rows are keyed by the Airtable id, else the row's place in the list: a
  // manual product's name is typed in place, so it cannot be the key
  const rowKey = (p, i) => (p.airtable_id ? `a-${p.airtable_id}` : `m-${i}`);
  const glyph = (c) => <span className="glyph" aria-hidden="true">{c.glyph}</span>;
  const srcTitle = (src) => (src === "airtable" ? "Airtable's figure - type over it to override" : src === "default" ? "The benchmark default - type over it to override" : src === "typed" ? "Typed here; clear to go back to Airtable's" : "Airtable holds none - type it");
  const cell = (p, c) => {
    if (c.calc) return <td key={c.key} className="calc" title={c.tip}>{p.edition ? fmt(p.target_units) : ""}</td>;
    const typed = p.airtable_id && p.sources[c.key] === "typed";
    if (c.check) {
      return (
        <td key={c.key} className={`check${typed ? " typed" : ""}`}>
          <input type="checkbox" className="tick" checked={!!p.framing_available} disabled={!editing}
            title={typed ? "Typed here" : "Airtable's framing option"} onChange={(e) => onField(p, c.key, e.target.checked)} />
        </td>
      );
    }
    if (closedFor(p, c.key)) {
      const why = c.key === "aa_revenue_share" ? "Closed: this product has a profit share." : c.key === "aa_profit_share" ? "Closed: this product has a revenue share." : "Closed: no frame is offered on this product.";
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
    return (
      <td className="l primary">
        <div className="pc">
          {editing && !p.airtable_id
            ? <input className="cell name" size={1} value={p.name || ""} placeholder="Product name" onChange={(e) => onName(p, e.target.value)} />
            : <span className="nm" title={p.name || "unnamed"}>{p.name || "unnamed"}</span>}
          <span className="src" title={p.airtable_id ? `Airtable record ${p.project_code || p.airtable_id}` : "Added on this tab, not in Airtable"}>{p.airtable_id ? `Airtable ${p.project_code || p.airtable_id}` : "added by hand"}</span>
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
      {GRID.map((c) => {
        if (c.calc) return <td key={c.key} className="calc" />;
        if (c.check) {
          return (
            <td key={c.key} className="check">
              <input type="checkbox" className="tick" checked={products.every((p) => p.framing_available)} title="Every product at once"
                onChange={(e) => onFieldAll(c.key, e.target.checked)} />
            </td>
          );
        }
        if (c.key === "edition") return <td key={c.key} className="closed" title="Editions differ by work: type each on its own row." />;
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
    const rows = products.filter((p) => p[key] !== null && p[key] !== undefined && p.target_units > 0);
    const tot = rows.reduce((s, p) => s + p.target_units, 0);
    return tot ? rows.reduce((s, p) => s + p.target_units * p[key], 0) / tot : null;
  };
  const aaBefore = (econ.ppu_aa || 0) - (econ.frame_uplift_per_unit || 0);
  const revShare = weighted("aa_revenue_share"), profShare = weighted("aa_profit_share");
  const sum = () => (
    <tr className="sum">
      <td className="gut" />
      <td className="l primary">Total · per target unit<span className="src">{products.length === 1 ? "the one product" : `the ${products.length} products together`}</span></td>
      <td title="The editions summed.">{fmt(econ.edition_total)}</td>
      <td title="Target units over the editions.">{econ.edition_total ? Math.round((100 * econ.edition_size) / econ.edition_total) : ""}</td>
      <td title="Price per target unit, weighted by target units, in euros.">{econ.unit_price ? cellText("unit_price", econ.unit_price) : ""}</td>
      <td title="The target units summed: the secured-units target.">{fmt(econ.edition_size)}</td>
      <td title="Weighted over the target units.">{econ.ppu_artist > 0 ? cellText("artist_profit_per_unit", econ.ppu_artist) : ""}</td>
      <td title="Weighted over the target units, before framing.">{aaBefore > 0 ? cellText("aa_profit_per_unit", aaBefore) : ""}</td>
      <td title="Weighted over the target units of the products on a revenue share.">{revShare !== null ? cellText("aa_revenue_share", revShare) : ""}</td>
      <td title="Weighted over the target units of the products on a profit share.">{profShare !== null ? cellText("aa_profit_share", profShare) : ""}</td>
      <td />
      <td />
      <td title="The framing uplift per target unit over every product: Avant Arte's alone.">{econ.frame_uplift_per_unit > 0 ? `+${cellText("frame_profit_per_unit", econ.frame_uplift_per_unit)}` : ""}</td>
    </tr>
  );
  return (
    <>
      <div className="ts-tblwrap">
        <table className="sheet" onKeyDown={moveByRow}>
          <colgroup><col style={{ width: 32 }} /><col style={{ width: 230 }} /></colgroup>
          <thead>
            <tr>
              <th className="gut" />
              <th className="l primary"><span className="glyph" aria-hidden="true">A</span>Product</th>
              {GRID.map((c) => <th key={c.key} className={c.calc ? "calc" : undefined} title={c.tip}>{glyph(c)}{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {editing && products.length > 1 && setAll()}
            {products.map((p, i) => (
              <tr key={rowKey(p, i)}>
                <td className="gut">{i + 1}</td>
                {nameCell(p, i)}
                {GRID.map((c) => cell(p, c))}
              </tr>
            ))}
            {products.length === 0 && (
              <tr className="empty">
                <td className="gut" />
                <td className="l" colSpan={GRID.length + 1}>
                  No products yet: Airtable has no record matched to this release{emptyNote ? ` (${emptyNote})` : ""}.
                  {editing ? " Add the works by hand until it does." : " Switch on Edit figures to add the works by hand until it does."}
                </td>
              </tr>
            )}
            {editing && (
              <tr className="add">
                <td className="gut">+</td>
                <td className="l primary"><button type="button" className="ts-link" onClick={onAdd}>Add a product</button></td>
                <td colSpan={GRID.length} />
              </tr>
            )}
            {products.length > 0 && sum()}
          </tbody>
        </table>
      </div>
      <div className="ts-caption">
        The last row is the release as a whole: edition and target units summed, sell-through and price weighted by target units,
        the profits and the share per target unit, and the framing uplift per target unit. A product has a revenue share or a
        profit share, never both: fill one and the other closes. Framing profit is Avant Arte's alone.
      </div>
    </>
  );
}

/* ======================= the tab ======================= */

export default function TargetSetting({ snap, onSaved }) {
  const [meta, setMeta] = useState(null);       // {inputs, sourced, benchmarks, meta_campaigns, derived, draws, creating}
  const [inp, setInp] = useState(null);         // editable inputs
  const [pick, setPick] = useState(null);       // a basket chosen in the picker, not yet saved
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);
  const [buildSecs, setBuildSecs] = useState(null);   // how long the background rebuild has run
  const [editing, setEditing] = useState(false);      // the products card's figures unlocked
  const [whyOpen, setWhyOpen] = useState(false);      // the untracked notice's explanation
  const [compact, setCompact] = useState(false);      // the header, once the page has scrolled past it
  const sentinel = useRef(null);
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
    setSlackDraft((snap.slack && snap.slack.channel) || ""); setSlackError(null); setSlackNote(null);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      // a release nobody has set targets for comes back with inputs: null and
      // the defaults the ETL could derive - the form starts from those
      const raw = d.inputs || d.defaults;
      // inputs saved under earlier shapes: the Referral Artist row of the
      // retired quality grid (N/A = the artist's own channels off; Low / High
      // the posting tier), one Meta campaign, and the release-level economics
      // at the top level (kept as legacy_economics until cleared)
      const legacyTier = (raw.channel_quality_overrides || {})["Referral Artist"];
      const topLegacy = {};
      for (const k of LEGACY_KEYS) if (raw[k] !== undefined && raw[k] !== null) topLegacy[k] = raw[k];
      const start = { ...raw };
      for (const k of LEGACY_KEYS) delete start[k];
      Object.assign(start, {
        channels_off: raw.channels_off || (legacyTier === "N/A" ? ["referral_artist"] : []),
        artist_posting_tier: raw.artist_posting_tier || (["Low", "Medium", "High"].includes(legacyTier) ? legacyTier : "Medium"),
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

  // the header compacts once the page has scrolled past where it started: a
  // one-pixel sentinel above it says when
  useEffect(() => {
    const el = sentinel.current;
    if (!ready || !el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([en]) => setCompact(!en.isIntersecting && en.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [ready]);

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
  const dateDiff = (a, c) => (a && c ? Math.round((new Date(a) - new Date(c)) / 86400000) : null);
  const days = dateDiff(closes, announce);
  const prDays = dateDiff(announce, prOpen);
  const leadFromAirtable = (sourced.airtable || {}).marketing_lead || null;
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
  const paidShare = profile ? profile.share_sessions.paid : null;
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
  // back to Airtable's figures: one product's typed entry dropped, or all of them
  const onReset = (p) => setInp((prev) => ({ ...prev, products: (prev.products || []).filter((t) => !(p.airtable_id && String(t.airtable_id) === String(p.airtable_id))) }));
  const onResetAll = () => setInp((prev) => ({ ...prev, products: (prev.products || []).filter((t) => !t.airtable_id) }));
  const typedCount = products.filter((p) => p.airtable_id).reduce((s, p) => s + typedKeys(p).length, 0);
  const manualCount = products.filter((p) => !p.airtable_id).length;
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

  /* The header's figures (§8.3), from the same model the build runs: the
   * target, the basket's benchmark and the stretch between them. */
  const T = profile ? benchmarkTargets(profile, {
    edition_size: editionSize, unit_price: econ.unit_price || 0, cost_per_purchase: cpp,
    units_per_buyer: (snap.targets || {}).units_per_buyer || 0,
    entry_conversion_rate: inp.entry_conversion_rate,
  }, b) : null;
  const BM = T ? T.benchmark : null;
  const paidOff = isOff("paid");
  const figure = (label, target, bmv, format, tip, opts = {}) => {
    let stretch = target === null || bmv === null ? null : target - bmv;
    if (stretch !== null && format(Math.abs(stretch)) === format(0)) stretch = 0;
    const subs = opts.paid && paidOff ? ["not in plan"]
      : opts.sense ? [`benchmark ${bmv === null ? "–" : format(bmv)}`, `${opts.sense.breached ? "over" : "under"} the 6% sense check`]
        : [`benchmark ${bmv === null ? "–" : format(bmv)}`, `stretch ${stretch === null ? "–" : (stretch < 0 ? MINUS : "+") + format(Math.abs(stretch))}`];
    return { label, tip, value: opts.paid && paidOff ? "–" : target === null ? "–" : format(target), subs, red: !!(opts.sense && opts.sense.breached), subRed: !!(opts.sense && opts.sense.breached) };
  };
  const figures = T ? [
    figure("Paid units", T.paid_units, BM.paid_units, (v) => fmt(v, 0), "The basket's median paid units, lifted by K.", { paid: true }),
    figure("Buyers", T.buyers, BM.buyers, (v) => fmt(v, 0), `People, not pieces: the target divided by ${fmt(T.units_per_buyer, 3)} units per buyer.`),
    figure("Eligible entries", T.entries_target, BM.entries, (v) => fmt(v, 0),
      `Target units ÷ the ${T.entry_rate ? Math.round(T.entry_rate * 100) + "%" : "80%"} eligible-entry → order rate (the release's own where typed, else the panel's): every unit is asked for as an entry. The benchmark is the basket's median units asked for the same way.`),
    figure("Sessions", T.total_sessions, BM.sessions, (v) => fmt(v, 0), "The basket's median sessions, lifted by the same K as every other volume."),
    figure("Paid budget", T.paid.budget, BM.paid_budget, (v) => fmtMoney(v, 0), `Paid units × ${fmtMoney(cpp)} per unit.`, { paid: true }),
    figure("Of launch value", T.paid.budget_pct_of_launch_value ?? 0, BM.budget_pct_of_launch_value ?? 0, (v) => fmtPct(v, 1),
      "Sense check: paid budget should stay under 6% of launch value.", { paid: true, sense: { breached: !!T.paid.sense_check_breached } }),
  ] : [];

  const DATE_WORDS = { notion: "from the Notion log", typed: "typed", clock: "from the funnel clock", airtable: "from Airtable" };
  const dateField = (label, f, value, src, tip) => (
    <Field key={f} label={label} tip={tip} help={src ? DATE_WORDS[src] : "not known yet: type it"}>
      {src === "notion"
        ? <RoBox value={fmtDate(value)} title="From the Notion log" />
        : <div className="ts-box"><input type="date" value={value || ""} onChange={set(f)} /></div>}
    </Field>
  );
  const legacy = inp.legacy_economics;
  const airtableMatch = (sourced.airtable || {}).match || "none";
  const airtableNote = (sourced.airtable || {}).note || "";

  /* Untracked much higher than normal (DATA_MODEL 1.3): the build says which
   * of entries and units has a share over twice the panel's median and past
   * its 90th percentile; the line quotes the share, the count behind it and
   * the norm it is read against. */
  const ut = snap.untracked || null;
  const untrackedHigh = ut && Array.isArray(ut.high) ? ut.high.filter((key) => ut[key] && ut[key].share !== null).map((key) => ({ key, v: ut[key], n: (ut.normal || {})[key] || {} })) : [];
  const untrackedMonths = ut && ut.normal ? ut.normal.recentMonths : null;

  /* ---- the header's words ---- */
  const leadCap = editionSize <= 0 ? "target units: a product with an edition is needed"
    : `${partialEdition ? `of ${fmt(econ.edition_total)} in the edition` : "units, the whole edition"} · ${k ? `×${fmt(k, 2)} the basket's median` : "no basket chosen yet"}`;
  const saveLabel = saving ? (buildSecs !== null ? `Rebuilding the page… ${buildSecs}s` : "Saving…") : savedFlash ? "✓ Saved" : creating ? "Set targets" : "Save targets";
  const stateText = saving ? null
    : missing.length ? `Needs ${missing.join(", ")}`
      : dirty ? (basketDirty ? "Unsaved changes · a new basket rebuilds from the panel, a longer save" : "Unsaved changes")
        : creating ? "Not set up yet" : null;
  const channelsHelp = [
    paidOff ? "Paid off: benchmarked on what the basket did without paid, and the other channels carry the whole target." : null,
    isOff("referral_artist") ? "Artist off: no artist target and no posting benchmark, as for an estate or an artist who will not post." : null,
  ].filter(Boolean).join(" ") || "Off takes the channel's median out of the benchmark and its share out of the target; the other channels carry the whole sellout.";
  const basketNote = basketDirty ? "Not saved yet: the figures below follow the launches ticked; save to rebuild the page on them."
    : bm && bm.basket ? `Matched from ${fmt(bm.basket.n)} comparable launches${bm.basket.id === bm.basket.suggestedId ? ", the suggested basket for this release" : ", chosen by hand"}${bm.basket.thin ? ". Thin: under six launches, so the median moves easily." : "."}`
      : null;
  const productsDesc = airtableMatch !== "none"
    ? `${atProducts.length} product${atProducts.length === 1 ? "" : "s"} from Airtable, matched by ${airtableMatch}`
    : `Airtable has no record matched to this release${airtableNote ? ` - ${airtableNote}` : ""}`;
  const productsState = [
    editing ? "Editing" : atProducts.length ? "Figures from Airtable" : null,
    typedCount ? `${typedCount} figure${typedCount === 1 ? "" : "s"} typed over Airtable` : null,
    manualCount ? `${manualCount} product${manualCount === 1 ? "" : "s"} added by hand` : null,
  ].filter(Boolean).join(" · ");
  const asPct = (v) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 100)));

  return (
    <>
      <div ref={sentinel} style={{ height: 1, marginBottom: -1 }} aria-hidden="true" />
      <div className={`ts-head${compact ? " compact" : ""}`}>
        <div className="ts-head-top">
          <div style={{ minWidth: 0 }}>
            <div className="ts-eyebrow">Target · {snap.releaseName}</div>
            <div className="ts-lead">
              <span className="ts-big" title="Secured-units target: the hero target on the Overview tab, the products' editions at their target sell-through, summed.">{editionSize > 0 ? fmt(editionSize) : "–"}</span>
              <span className="ts-lead-cap">{leadCap}</span>
            </div>
          </div>
          <div className="ts-actions">
            {stateText && <span className={`ts-state${missing.length ? " warn" : ""}`}>{stateText}</span>}
            <button type="button" className="ts-btn secondary" onClick={discard} disabled={saving || !dirty} title="Back to what is saved.">Discard</button>
            <button type="button" className="ts-btn primary" disabled={saving || missing.length > 0} onClick={save}
              title={missing.length ? `Still needed: ${missing.join(", ")}` : creating ? "Saves the inputs and rebuilds this release with the full target model." : "Saves the inputs and recomputes this release's targets, plan curves and projections."}>
              {saveLabel}
            </button>
          </div>
        </div>
        <div className="ts-figures">
          {T ? figures.map((f) => (
            <div key={f.label} className="ts-fig" title={f.tip}>
              <span className="ts-fig-label">{f.label}</span>
              <span className={`ts-fig-val${f.red ? " red" : ""}`}>{f.value}</span>
              <span className="ts-fig-sub">{f.subs.map((s, i) => <span key={i} className={i === 1 && f.subRed ? "red" : undefined}>{s}</span>)}</span>
            </div>
          )) : (
            <div className="ts-caption" style={{ padding: "8px 0 2px" }}>
              Choose a basket to see the benchmark and the targets it gives. Saving without one benchmarks against the launches nearest this release's target and price.
            </div>
          )}
        </div>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="ts" style={{ marginTop: 24 }}>
        {creating && snap.upcoming && (
          <Notice>
            <b>Upcoming launch.</b> Known to Airtable, not yet to the funnel report. The dates{dv.dates_note ? ` (${dv.dates_note})` : ""} and
            {atProducts.length ? ` the ${atProducts.length} work${atProducts.length === 1 ? "" : "s"} with their editions and prices` : " the works"} below
            come from Airtable with their source shown. Check them, tick the Meta campaign, set the channels in plan, choose the basket
            and save: the page then carries the plan, and the funnel's actuals attach to it once the report picks the launch up.
          </Notice>
        )}
        {meta.storage && meta.storage.durable === false && (
          <Notice red>
            <span title={`Saves are written to ${meta.storage.path}`}><b>Targets saved here do not survive a deploy.</b> The service keeps them on its own disk, which Render resets on
            every deploy. Point SAVED_INPUTS_PATH at a file on a persistent disk (README, "Render's disk resets") and they stay.</span>
          </Notice>
        )}
        {creating && !snap.upcoming && (
          <Notice>
            <b>No targets yet.</b> The page currently shows actuals only.
            {" "}The dates come from the Notion log where it has them, else the funnel export's campaign clock, else Airtable - check them.
            {atProducts.length ? ` Airtable holds ${atProducts.length} product${atProducts.length === 1 ? "" : "s"} for this release.` : " Airtable has no product matched to this release yet: add the works by hand."}
            {" "}Tick the Meta campaigns, set the channels in plan, and save: the page rebuilds with expected-today, projections, paid ROI and sell-through.
          </Notice>
        )}
        {untrackedHigh.map((u) => (
          <Notice key={u.key} action={<button type="button" className="why" onClick={() => setWhyOpen(!whyOpen)}>{whyOpen ? "Close" : "Why"}</button>}>
            <b>Untracked is {fmtPct(u.v.share, 0)} of this release's {u.key}</b> ({fmt(u.v.count, 0)} of {fmt(u.v.total, 0)}), against {fmtPct(u.n.median, 0)} on a typical launch
            {untrackedMonths ? ` of the last ${untrackedMonths} months` : ""}: the channel split reads less certainly than usual.
            {whyOpen && (
              <span> Untracked is the funnel export's channel for {u.key} that could not be attributed; the 90th percentile of the panel is {fmtPct(u.n.p90, 0)}. The build spreads
                untracked across the tracked channels in proportion to what they did that day, so the channel split, the per-channel targets' progress and
                the funnel read less certainly than usual. Worth checking the tracking before reading the channel figures.</span>
            )}
          </Notice>
        ))}

        <section className="ts-card" aria-label="Release and timeline">
          <CardHead dot="#b8862d" title="Release & timeline" />
          <div className="ts-grid c2">
            <Field label="Release name" src="the join key across every feed" tip="Simple Release Name - the join key across every feed; changing it would orphan the actuals, so it is fixed here.">
              <RoBox value={snap.releaseName} />
            </Field>
            <Field label="Campaign code" src={inp.campaign_code ? "typed" : codeInForce ? "matched to the Meta campaign" : "not found in any feed"}
              tip="The code the email, Instagram and artist-post feeds tag this campaign with (e.g. GlennLigon_LE_26) - it joins those panels to the release. Read off the Meta campaign's name, or guessed from the feeds.">
              {codeInForce
                ? <RoBox value={codeInForce} title={inp.campaign_code ? "As saved" : "From the Meta campaign's name, else the email and content feeds"} />
                : <TextBox value={inp.campaign_code || ""} onChange={set("campaign_code")} placeholder="Artist_LE_26" />}
            </Field>
            <Field label="Marketing lead" src={leadFromAirtable ? "Airtable" : "typed"} help={leadFromAirtable ? null : "Not in Airtable yet: typed here until it is."}>
              {leadFromAirtable
                ? <RoBox value={leadFromAirtable} title="From Airtable" />
                : <TextBox value={inp.marketing_lead || ""} onChange={set("marketing_lead")} placeholder="Who runs this launch" />}
            </Field>
            <Field label="Slack channel" src="saved on its own"
              tip="Where the Post to Slack button on the sell-through card sends this release's update. The channel name without the #; for a private channel, invite the Launch Performance bot to it first. Saved on its own, separately from the targets."
              help={slackError || slackNote || (snap.slack && snap.slack.lastPostAt ? `last posted ${new Date(snap.slack.lastPostAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : null)}
              helpKind={slackError ? "err" : slackNote ? "warn" : undefined}>
              <div className="ts-row">
                <TextBox value={slackDraft} onChange={(e) => setSlackDraft(e.target.value)} placeholder="launch-updates" />
                <button type="button" className="ts-btn secondary" disabled={slackSaving || slackDraft.trim().replace(/^#/, "") === slackCurrent} onClick={saveSlack}>
                  {slackSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </Field>
            <Field label="Meta campaigns" src="paid actuals are read from these"
              tip="Which Meta ad campaigns this release's paid actuals are read from - rows matching these names in the live spend feed, summed. The draw campaign named for the code is ticked on its own; add a purchases or sign-ups campaign when it belongs to this release.">
              <Campaigns code={codeInForce} chosen={inp.campaign_names} all={meta.meta_campaigns} suggested={sourced.campaigns}
                onChange={(names) => setInp({ ...inp, campaign_names: names })} />
            </Field>
            <div className="ts-grid c3" style={{ alignContent: "start" }}>
              {dateField("Private room opens", "private_room_open", prOpen, prSrc, "The day of the early-access email, from the Notion log. Until the log has it: what is typed, else two weeks before the announce.")}
              {dateField("Announce", "announce_date", announce, annSrc, "From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
              {dateField("Draw closes", "launch_end", closes, closeSrc, "The launch: the day the draw closes and sales open. From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
            </div>
          </div>
          <div className="ts-caption">
            Campaign <b>{days === null ? "–" : days}</b> days, announce to draw close · the private room opens <b>{prDays === null ? "–" : prDays}</b> days before the announce.
          </div>
        </section>

        <section className="ts-card" aria-label="Benchmark basket">
          <CardHead dot={C.blue} title="Benchmark basket" desc="the median of launches like this one" />
          <div className="ts-grid c2">
            <Field label="Basket" tip="The launches this release is benchmarked against. The benchmark is their median, per metric and per channel.">
              <div className="ts-row">
                <RoBox value={basketName || "none chosen yet"} />
                <button type="button" className="ts-btn secondary" onClick={() => setPicking(true)}
                  title="Opens the basket picker: the ready-made baskets with their medians, or a bespoke selection.">Change basket</button>
              </div>
            </Field>
            <Field label="What the basket reaches" help={basketNote}>
              {profile ? (
                <div className="ts-chips">
                  <span className="ts-chip" title="Launches in the basket. Under six and the median moves a lot on one launch.">{fmt(prof ? prof.n : bm && bm.basket ? bm.basket.n : null)} launches</span>
                  <span className="ts-chip" title={off.length ? "Median units without the channels set aside, with the 25th to 75th percentile read the same way." : "Median units, with the 25th to 75th percentile of the basket beside it."}>
                    median {fmt(profile.units)} units · P25 {fmt(profile.units_p25)} to P75 {fmt(profile.units_p75)}
                  </span>
                  {profile.price > 0 && (
                    <span className="ts-chip" title="Median unit price of the basket in euros (from Airtable), with its 25th to 75th percentile. The default basket matches on price as well as size (BENCHMARK_SPEC 3.1).">
                      median price {fmtMoney(profile.price)} · {fmtMoney(profile.price_p25)} to {fmtMoney(profile.price_p75)}
                    </span>
                  )}
                  <span className="ts-chip">{fmt(profile.sessions)} sessions</span>
                  <span className="ts-chip" title={paidOff ? "Paid is not in plan for this release." : "Median share of sessions from paid."}>{paidOff ? "paid not in plan" : `paid ${fmtPct(paidShare, 0)} of sessions`}</span>
                  <span className="ts-chip">{fmt(profile.campaign_days)} campaign days</span>
                </div>
              ) : <div className="ts-box dis">no basket yet</div>}
            </Field>
            <Field label="Channels in plan" help={channelsHelp}
              tip="A channel this release will not run leaves the benchmark and the target: the basket is read on its other channels, and they carry the whole sellout between them.">
              <div className="ts-switches">
                <Switch on={!paidOff} onChange={(on) => setOff("paid", on)} label="Running paid"
                  title="The basket keeps every launch, paid or not; with paid off each counts on its other channels only." />
                <Switch on={!isOff("referral_artist")} onChange={(on) => setOff("referral_artist", on)} label="Artist's own channels"
                  title="Off for an estate, or a living artist with no channels of their own. The artist group leaves the benchmark and the funnel expects no posts." />
              </div>
            </Field>
            <Field label="Artist posting tier" help={isOff("referral_artist") ? "Not applicable: the artist's own channels are off." : "The funnel's posting benchmark is the median of completed campaigns labelled with the same tier."}
              tip="How much the artist will post, against the tiers past campaigns were labelled with.">
              <div className={`ts-box${isOff("referral_artist") ? " dis" : ""}`}>
                <select value={inp.artist_posting_tier || "Medium"} disabled={isOff("referral_artist")} onChange={(e) => setInp({ ...inp, artist_posting_tier: e.target.value })}>
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </select>
              </div>
            </Field>
          </div>
          {profile ? <BasketTable profile={profile} off={off} k={k || 1} /> : (
            <div className="ts-caption">
              No basket yet. Choose one to see the benchmark and the targets it gives; a release saved without one is
              benchmarked against the launches nearest its target and price.
            </div>
          )}
          <div className="ts-caption">
            The target is the benchmark lifted by <b>×{k ? fmt(k, 2) : "–"}</b> in every channel and on every day. Conversion rates are held at the
            benchmark: the uplift is asked of traffic and spend only.
          </div>
        </section>

        <section className="ts-card" aria-label="Products and economics">
          <CardHead dot="#8a7a52" title="Products & economics" desc={productsDesc}
            right={(
              <>
                <span className="ts-state">
                  {productsState}
                  {editing && typedCount > 0 && <> · <button type="button" className="ts-link" onClick={onResetAll} title="Drop every typed figure: back to Airtable's on every product.">Reset all</button></>}
                </span>
                <button type="button" className={`ts-switch${editing ? " on" : ""}`} aria-pressed={editing} onClick={() => setEditing(!editing)}
                  title={editing ? "Lock the figures again; what was typed stays." : "Unlock the figures to type over Airtable's, or to add a work by hand."}>
                  <span className="tr" />Edit figures
                </button>
              </>
            )} />
          {legacy && (
            <Notice action={(
              <button type="button" className="ts-btn secondary" onClick={() => setInp({ ...inp, legacy_economics: null })}
                title="Drop the release-level figures: the products' figures carry the totals from the next save.">Use the products' figures</button>
            )}>
              <b>Release-level figures still in force.</b> This release was set up before the model went per product: target {fmt(legacy.edition_size)}{legacy.edition_total > legacy.edition_size ? ` of ${fmt(legacy.edition_total)}` : ""} units at {fmtMoney(legacy.unit_price || 0, 0)},
              artist {fmtMoney((legacy.artist_profit || 0) / (legacy.edition_size || 1), 0)} and AA {fmtMoney((legacy.aa_group_profit || 0) / (legacy.edition_size || 1), 0)} per unit.
              The products below are what Airtable holds; the totals switch to them when these are cleared.
            </Notice>
          )}
          <ProductsGrid products={products} econ={econ} editing={editing} onField={onField} onFieldAll={onFieldAll} onName={onName}
            onAdd={onAdd} onRemove={onRemove} onReset={onReset} emptyNote={airtableNote} />
          <div className="ts-caption">
            Launch value <b>{fmtMoney(econ.launch_value, 0)}</b>
            {(econ.launch_currencies || []).some((c) => c !== "EUR") ? ` (from ${(econ.launch_currencies || []).join(", ")} at a fixed rate)` : ""}
            {" · "}artist <b>{fmtMoney(econ.ppu_artist, 2)}</b> and AA <b>{fmtMoney(econ.ppu_aa, 2)}</b> per unit{econ.frame_uplift_per_unit > 0 ? ` (incl. ${fmtMoney(econ.frame_uplift_per_unit, 2)} framing)` : ""}
            {" · "}AA carries <b>{fmtPct(econ.aa_budget_share, 0)}</b> of paid spend ({econ.deal && econ.deal.length ? econ.deal.join(" and ") : legacy ? "as set up" : "no deal recorded, 50/50 assumed"})
          </div>
        </section>

        <section className="ts-card" aria-label="Assumptions">
          <CardHead dot="#c96a3a" title="Assumptions" desc="blank means the panel's standard" />
          <div className="ts-grid c4">
            <Field label="Entry → order rate" help="Prices every entry on the page: secured units, the paid model's converting entries and the eligible-entries target."
              tip="What share of eligible entries in hand become orders - the sell-through prediction counts entries in hand at this rate. Empty means the panel's 80%.">
              <NumBox value={asPct(inp.entry_conversion_rate)} placeholder={String(Math.round(100 * (Number(b.eligible_entry_to_order) || 0.8)))} unit="%"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9]/g, ""); setInp((prev) => ({ ...prev, entry_conversion_rate: c === "" ? null : clamp(parseInt(c, 10), 1, 100) / 100 })); }} />
            </Field>
            <Field label="Pre-order → order rate" help="A pre-order's card is already authorised, so it converts higher than a plain entry."
              tip="What share of PRE-ORDER entries become orders. Their card is already authorised, so they are charged at the draw rather than invoiced. Empty means the panel's 95%.">
              <NumBox value={asPct(inp.preorder_conversion_rate)} placeholder="95" unit="%"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9]/g, ""); setInp((prev) => ({ ...prev, preorder_conversion_rate: c === "" ? null : clamp(parseInt(c, 10), 1, 100) / 100 })); }} />
            </Field>
            <Field label="Cost per paid unit" src="blank = the median"
              help={basketCpp > 0 ? `Paid units at this price is the paid budget. The basket's median is each launch's Meta spend over the paid units it sold, ${profile.n_costed || 0} launches with spend on file.` : "Paid units at this price is the paid budget. The panel's median stands in until three of the basket's launches have spend on file."}
              tip="What a paid unit costs to buy. Blank = the basket's median cost per paid unit (each launch's Meta spend over the paid units it sold), or the panel's median when fewer than three of the basket's launches have spend on file.">
              <NumBox value={inp.cost_per_purchase === null || inp.cost_per_purchase === undefined ? "" : String(inp.cost_per_purchase)}
                placeholder={fmt(basketCpp > 0 ? basketCpp : panelCpp)} unit="€"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, cost_per_purchase: c === "" ? null : c })); }} />
            </Field>
            <Field label="Paid cannibalisation" src={`blank = ${Math.round(100 * (Number(b.cannibalisation) || 0.2))}%`}
              help={`The share of paid entries that would have come anyway. The ROI and the budget floor read profit net of it. Blank = the ${Math.round(100 * (Number(b.cannibalisation) || 0.2))}% standard.`}>
              <NumBox value={inp.cannibalisation === null || inp.cannibalisation === undefined ? "" : String(Math.round(Number(inp.cannibalisation) * 1000) / 10)}
                placeholder={String(Math.round(100 * (Number(b.cannibalisation) || 0.2)))} unit="%"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), 0, 95) / 100; setInp((prev) => ({ ...prev, cannibalisation: v === null || Number.isNaN(v) ? null : v })); }} />
            </Field>
          </div>
          <div className="ts-caption">Spend is Meta's, billed in euros, and the page runs in euros: every figure here is euros.</div>
        </section>
      </div>

      {picking && (
        <BasketPicker releaseId={snap.id} releaseName={snap.releaseName} current={spec}
          targetUnits={editionSize} unitPrice={econ.unit_price || 0}
          preferRecent={inp.prefer_recent !== false} channelsOff={off}
          // what the rule needs to find the artist's own earlier launches and
          // to read the typed price in its currency (shared/basketRule.mjs)
          artist={snap.artist || ""} currency="EUR"
          announceDate={announce || null} privateRoomOpen={prOpen || null}
          // the picker asks for a target and a price when there are none, and
          // writes them onto a product added by hand so the basket follows
          onInputs={onPickerInputs}
          onPick={onPick} onClose={() => setPicking(false)} />
      )}
    </>
  );
}
