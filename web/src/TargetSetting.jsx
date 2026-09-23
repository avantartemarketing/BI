/* Target setting tab (docs/BENCHMARK_SPEC.md §8, docs/DATA_MODEL.md §1.6):
 * what the feeds hold for the release on the left, the derived targets on
 * the right, recomputing live via shared/economics.mjs and
 * shared/benchmarkModel.mjs. Save persists the inputs and the server rebuilds
 * the release on them.
 *
 * Almost nothing here is typed. The products and their economics come from
 * Airtable, per work (edition, target sell-through, price, the artist's and
 * Avant Arte's profit per unit, the deal's revenue or profit share, the
 * framing assumptions), with a cell to type over any figure Airtable does not
 * hold yet. The dates come from the Notion log (the early-access email opens
 * the private room; the announce; the launch), then the funnel's own clock,
 * then Airtable; the marketing lead from Airtable. What a person decides is
 * which Meta campaigns are this release's, which channels it will not run,
 * and which basket it is measured against.
 *
 * A release set up before the model went per product still carries its
 * release-level figures (legacy_economics); they stand in for its totals
 * until they are cleared here, and the products show what Airtable holds
 * beside them. */
import React, { useEffect, useMemo, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import BasketPicker from "./BasketPicker.jsx";
import { resolveProducts, releaseEconomics, LEGACY_KEYS } from "../../shared/economics.mjs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf, profileOf } from "../../shared/benchmarkModel.mjs";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const BLUE = "#2f5fb3";
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// the five display groups, in the order the profile dicts are written
// (etl/baskets.py GROUPS), so the table reads the same way as the snapshot
const GROUPS = [
  { key: "aa_email", name: "AA Email" },
  { key: "aa_social", name: "AA Meta" },
  { key: "referral_artist", name: "Referral artist" },
  { key: "search_direct_other", name: "Search / direct / other" },
  { key: "paid", name: "Paid" },
];

const SOURCE_WORDS = { notion: "Notion", airtable: "Airtable", clock: "funnel clock", typed: "typed", default: "default", matched: "matched", saved: "chosen" };

/* Where a figure came from, as a small chip. */
function SourceChip({ source, title }) {
  if (!source) return null;
  const strong = source === "notion" || source === "airtable";
  return (
    <span title={title} style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.2, padding: "2px 7px", borderRadius: 999,
      background: strong ? "#e6eefa" : "#f1efe8", color: strong ? BLUE : C.muted, whiteSpace: "nowrap" }}>
      {SOURCE_WORDS[source] || source}
    </span>
  );
}

/* The two rates the sell-through prediction converts entries in hand at: a
 * plain draw entry, and a pre-order entry whose card is already authorised.
 * The per-product overrides still exist in the release's inputs and the ETL
 * still reads them; there is simply no table in the way of the rates. */
function Rates({ inp, setInp }) {
  const asPct = (v) => (v === null || v === undefined || v === "" ? "" : Math.round(Number(v) * 100));
  const ratePct = asPct(inp.entry_conversion_rate);
  const preRatePct = asPct(inp.preorder_conversion_rate);
  return (
    <Card dot="#8a7a52" title="Conversion of entries in hand">
      <div className="spacer-16" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
        <Field label="Entry → order rate (%)" tip="What share of eligible entries in hand become orders - the sell-through prediction counts entries in hand at this rate. Empty means the panel's 80%.">
          <input className="control num" value={ratePct} placeholder="80"
            onChange={(e) => { const raw = String(e.target.value).replace(/[^0-9]/g, ""); setInp({ ...inp, entry_conversion_rate: raw === "" ? null : clamp(parseInt(raw, 10), 1, 100) / 100 }); }} />
        </Field>
        <Field label="Pre-order → order rate (%)" tip="What share of PRE-ORDER entries become orders. Their card is already authorised, so they are charged at the draw rather than invoiced and convert higher than a plain entry. Empty means the panel's 95%.">
          <input className="control num" value={preRatePct} placeholder="95"
            onChange={(e) => { const raw = String(e.target.value).replace(/[^0-9]/g, ""); setInp({ ...inp, preorder_conversion_rate: raw === "" ? null : clamp(parseInt(raw, 10), 1, 100) / 100 }); }} />
        </Field>
      </div>
    </Card>
  );
}

const Field = ({ label, tip, children, right }) => (
  <div>
    <div className="flabel" title={tip} style={right ? { display: "flex", alignItems: "center", gap: 8 } : undefined}>{label}{right}</div>
    {children}
  </div>
);

/* A switch: the control, its name, and one clause on what it does. */
function Switch({ id, on, onChange, label, sub, why }) {
  return (
    <label title={why} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
      <input type="checkbox" id={id} checked={on} onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: C.ink, width: 15, height: 15, margin: 0, cursor: "pointer" }} />
      <span>{label} <span style={{ color: C.muted, fontSize: 12 }}>· {sub}</span></span>
    </label>
  );
}

/* One pick from a few words, the way the framing switch is drawn. */
function Seg({ options, value, onChange, small }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      {options.map((o) => {
        const active = value === o;
        return (
          <button key={o} onClick={() => onChange(o)}
            style={{ fontFamily: "inherit", fontSize: small ? 11.5 : 12, fontWeight: active ? 600 : 500, padding: small ? "3px 10px" : "6px 16px",
              border: "none", cursor: "pointer", background: active ? "#e6eefa" : "#fff", color: active ? BLUE : C.muted }}>{o}</button>
        );
      })}
    </div>
  );
}

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
    <div>
      {listed.length === 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>No campaign in the spend feed is named for {code ? `"${code}"` : "this release's code"} yet.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {listed.map((name) => {
          const hit = byName.get(name);
          return (
            <label key={name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: "pointer" }}>
              <input type="checkbox" checked={chosen.includes(name)} onChange={(e) => toggle(name, e.target.checked)}
                style={{ accentColor: C.ink, width: 14, height: 14, margin: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              <span style={{ color: hit ? C.muted : C.amber, fontSize: 11.5, marginLeft: "auto", whiteSpace: "nowrap" }}>
                {hit ? `${fmtMoney(hit.spend)} · last ${hit.last}` : "no spend rows by this name"}
              </span>
            </label>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input className="control" list="meta-campaigns" value={adding} placeholder="add another campaign by name"
          style={{ fontSize: 12 }} onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <datalist id="meta-campaigns">
          {(all || []).filter((c) => !chosen.includes(c.name)).map((c) => <option key={c.name} value={c.name} />)}
        </datalist>
        <button className="btn secondary" onClick={add} disabled={!adding.trim()} style={{ flex: "0 0 auto" }}>Add</button>
      </div>
    </div>
  );
}

/* One line of the per-channel table. Benchmark values are the basket's own
 * medians; the target is the benchmark lifted by K and the stretch is the
 * difference, so the three columns always read benchmark + stretch = target
 * (§1). Conversion carries no uplift at all - it is held at the benchmark
 * (§4), which is why the column says so. */
function ChannelRow({ label, bmSessions, bmUnits, conv, k, head, total, off }) {
  const cell = {
    fontSize: 12.5, padding: "7px 6px", textAlign: "right",
    borderBottom: `1px solid ${C.hairline}`, fontVariantNumeric: "tabular-nums",
    fontWeight: total ? 600 : 400,
  };
  if (head) {
    const h = { ...cell, fontSize: 11.5, color: C.muted, fontWeight: 500, borderBottom: `1px solid ${C.border}` };
    return (
      <tr>
        <th style={{ ...h, textAlign: "left" }}>Channel</th>
        <th style={h}>Benchmark sessions</th>
        <th style={h}>Target sessions</th>
        <th style={h}>Benchmark units</th>
        <th style={h}>Target units</th>
        <th style={h}>Stretch</th>
        <th style={h} title="Conversion rates are held at the benchmark - the uplift is asked of traffic and spend only.">Conv. (held)</th>
      </tr>
    );
  }
  if (off) {
    return (
      <tr>
        <td style={{ ...cell, textAlign: "left", whiteSpace: "nowrap", color: C.muted }}>{label}</td>
        <td colSpan={6} style={{ ...cell, textAlign: "left", color: C.muted, fontStyle: "italic" }}
          title="Set aside on this tab: its median leaves the benchmark and the other channels carry the whole target.">not in plan</td>
      </tr>
    );
  }
  return (
    <tr>
      <td style={{ ...cell, textAlign: "left", whiteSpace: "nowrap" }}>{label}</td>
      <td style={cell}>{fmt(bmSessions)}</td>
      <td style={cell}>{fmt(bmSessions * k)}</td>
      <td style={cell}>{fmt(bmUnits, 1)}</td>
      <td style={cell}>{fmt(bmUnits * k, 1)}</td>
      <td style={{ ...cell, color: C.muted }}>{fmt(bmUnits * (k - 1), 1)}</td>
      <td style={cell}>{conv === null ? "–" : fmtPct(conv, 2)}</td>
    </tr>
  );
}

/* A number input that shows what is being typed while it is typed - "5." on
 * the way to "5.5" - and the model's figure once it is left, so a decimal can
 * be typed in one go. */
function NumInput({ value, onCommit, className = "control num", ...rest }) {
  const [draft, setDraft] = useState(null);
  return (
    <input className={className} inputMode="decimal" value={draft !== null ? draft : value}
      onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value); }}
      onBlur={() => setDraft(null)} {...rest} />
  );
}

/* The products and their economics: a row per work, Airtable's figures as
 * the placeholders, a typed figure over any of them (blank = Airtable's), the
 * totals the release runs on underneath. Two tables share the rows - the
 * edition and price first, the per-unit economics second - so the whole
 * thing fits beside the rail on a laptop without scrolling sideways. An All
 * products row at the top of each sets every product at once, since the
 * works of a launch mostly share a price and a deal. Percentages are typed
 * as whole numbers and kept as fractions. */
const PCT = new Set(["target_sellthrough", "aa_revenue_share", "aa_profit_share", "frame_conversion"]);
// key -> label, tip, column width (the input plus its cell padding)
const COLS = {
  edition: ["Edition", "Units in the edition of this work.", 70],
  target_sellthrough: ["Target %", "The share of the edition targeted to sell by close. Blank = Airtable's target (its units target over the edition, else the expected sell-through), else 100%.", 64],
  unit_price: ["Price", "Retail price per unit, in the currency shown (Airtable prices in euros, the page's currency; a product in another currency is converted at a fixed rate).", 100],
  artist_profit_per_unit: ["Artist €", "The artist's profit on one unit sold.", 66],
  aa_profit_per_unit: ["AA €", "Avant Arte's profit on one unit sold, before framing.", 66],
  aa_revenue_share: ["AA rev. %", "Avant Arte's share of revenue on a royalty deal. Blank on a profit-share deal.", 62],
  aa_profit_share: ["AA profit %", "Avant Arte's share of profit on a profit-share deal, which is also its share of the paid budget. Blank on a royalty deal, where Avant Arte carries the ads outright.", 66],
  frame_conversion: ["Frame %", "The share of buyers expected to take a frame. Blank = the benchmark default.", 60],
  frame_profit_per_unit: ["Frame €", "Avant Arte's profit on each frame sold, which is Avant Arte's alone. Blank = the benchmark default.", 62],
};
const num = (key) => ({ kind: "num", key, label: COLS[key][0], tip: COLS[key][1], width: COLS[key][2] });
const EDITION_TABLE = [num("edition"), num("target_sellthrough"), num("unit_price"),
  { kind: "target", label: "Target", tip: "Target units: edition × target %.", width: 62 },
  { kind: "remove", width: 30 }];
const ECON_TABLE = [num("artist_profit_per_unit"), num("aa_profit_per_unit"), num("aa_revenue_share"), num("aa_profit_share"),
  { kind: "frame", label: "Frame?", tip: "Whether a frame is offered on this work.", width: 46 },
  num("frame_conversion"), num("frame_profit_per_unit")];

/* The names as the narrow second table shows them: what differs between the
 * products, when they all share a lead ("Brillo Box Collectable (Lifesize)"
 * reads as "(Lifesize)"). The full name stays in the tooltip. */
function shortNames(products) {
  const names = products.map((p) => String(p.name || ""));
  // the lead is what Airtable's names share; a product added by hand keeps
  // its full name unless it shares the lead too
  const pool = products.filter((p) => p.airtable_id).map((p) => String(p.name || ""));
  const base = pool.length >= 2 ? pool : names;
  if (base.length < 2) return names;
  let pre = base[0];
  for (const n of base) {
    let i = 0;
    while (i < pre.length && i < n.length && pre[i] === n[i]) i++;
    pre = pre.slice(0, i);
  }
  pre = pre.slice(0, pre.lastIndexOf(" ") + 1);
  if (pre.trim().length < 4) return names;
  return names.map((n) => (n.startsWith(pre) && n.slice(pre.length).trim() ? "…" + n.slice(pre.length).trim() : n));
}

function ProductsTable({ products, econ, onField, onFieldAll, onName, onAdd, onRemove, airtableNote }) {
  const short = shortNames(products);
  const th = { fontSize: 11, color: C.muted, fontWeight: 500, textAlign: "right", padding: "4px 4px", borderBottom: `1px solid ${C.border}`, lineHeight: 1.25, verticalAlign: "bottom" };
  const td = { padding: "4px 4px", borderBottom: `1px solid ${C.hairline}`, verticalAlign: "middle" };
  const foot = { ...td, borderBottom: "none", textAlign: "right", fontWeight: 600, fontSize: 12.5, fontVariantNumeric: "tabular-nums" };
  const cellInput = { width: "100%", minWidth: 0, padding: "4px 6px", fontSize: 12, textAlign: "right" };
  const show = (key, v) => (v === null || v === undefined ? "" : PCT.has(key) ? String(Math.round(v * 1000) / 10) : String(Math.round(v * 100) / 100));
  // rows are keyed by the Airtable id, else the row's place in the list: a
  // manual product's name is typed in place, so it cannot be the key
  const rowKey = (p, i) => (p.airtable_id ? `a-${p.airtable_id}` : `m-${i}`);
  const numCell = (p, key) => {
    const src = p.sources[key];
    const typedHere = src === "typed";
    return (
      <td key={key} style={td}>
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <NumInput style={{ ...cellInput, fontWeight: typedHere ? 600 : 400 }}
            value={typedHere ? show(key, p[key]) : ""}
            placeholder={src ? show(key, p[key]) || "–" : "–"}
            title={src === "airtable" ? "Airtable's figure - type over it to override" : src === "default" ? "The benchmark default - type over it to override" : typedHere ? "Typed here; clear to go back to Airtable's" : "Airtable holds none - type it"}
            onCommit={(raw) => onField(p, key, raw)} />
          {key === "unit_price" && <span style={{ fontSize: 10.5, color: C.muted, flex: "0 0 26px" }}>{p.currency}</span>}
        </div>
      </td>
    );
  };
  const nameCell = (p, i, editable) => (
    <td style={{ ...td, fontSize: 12.5, overflow: "hidden" }}>
      {editable && !p.airtable_id
        ? <input className="control" value={p.name} placeholder="Product name" style={{ fontSize: 12, padding: "4px 6px" }} onChange={(e) => onName(p, e.target.value)} />
        : <span title={`${p.name || "unnamed"}${p.airtable_id ? ` · Airtable ${p.project_code || p.airtable_id}` : ""}`}
            style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: p.name ? C.ink : C.muted }}>{editable ? p.name || "unnamed" : short[i] || "unnamed"}</span>}
    </td>
  );
  const cell = (p, c, j) => {
    if (c.kind === "num") return numCell(p, c.key);
    if (c.kind === "target") return <td key={j} style={{ ...td, textAlign: "right", fontSize: 12.5, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{p.edition ? fmt(p.target_units) : "–"}</td>;
    if (c.kind === "frame") {
      return (
        <td key={j} style={{ ...td, textAlign: "center" }}>
          <input type="checkbox" checked={!!p.framing_available} title={p.sources.framing_available === "typed" ? "Typed here" : "Airtable's framing option"}
            onChange={(e) => onField(p, "framing_available", e.target.checked)} style={{ accentColor: C.ink, margin: 0 }} />
        </td>
      );
    }
    return (
      <td key={j} style={{ ...td, textAlign: "right" }}>
        {!p.airtable_id && <button className="btn secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => onRemove(p)} title="Remove this product">×</button>}
      </td>
    );
  };
  // one row that writes to every product: shown with the figure when every
  // product carries the same typed one, "varies" when some do, "all" when none
  const allRow = (cols) => (
    <tr key="all" style={{ background: "#faf9f6" }}>
      <td style={{ ...td, fontSize: 12, color: C.muted }} title="Type here to set every product at once; a product can still be typed over on its own row.">All products</td>
      {cols.map((c, j) => {
        if (c.kind === "num" && c.key !== "edition") {
          const vals = products.map((p) => (p.sources[c.key] === "typed" ? p[c.key] : undefined));
          const same = vals.every((v) => v !== undefined && v === vals[0]);
          return (
            <td key={j} style={td}>
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <NumInput style={{ ...cellInput, fontWeight: same ? 600 : 400 }} value={same ? show(c.key, vals[0]) : ""}
                  placeholder={vals.some((v) => v !== undefined) ? "varies" : "all"} title="Every product at once"
                  onCommit={(raw) => onFieldAll(c.key, raw)} />
                {c.key === "unit_price" && <span style={{ flex: "0 0 26px" }} />}
              </div>
            </td>
          );
        }
        if (c.kind === "frame") {
          return (
            <td key={j} style={{ ...td, textAlign: "center" }}>
              <input type="checkbox" checked={products.every((p) => p.framing_available)} title="Every product at once"
                onChange={(e) => onFieldAll("framing_available", e.target.checked)} style={{ accentColor: C.ink, margin: 0 }} />
            </td>
          );
        }
        return <td key={j} style={td} />;
      })}
    </tr>
  );
  const table = (caption, cols, editable, footer) => (
    <div style={{ marginTop: caption ? 14 : 0 }}>
      {caption && <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginBottom: 2 }}>{caption}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col />
          {cols.map((c, j) => <col key={j} style={{ width: c.width }} />)}
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Product</th>
            {cols.map((c, j) => <th key={j} style={{ ...th, textAlign: c.kind === "frame" ? "center" : "right" }} title={c.tip}>{c.label || ""}</th>)}
          </tr>
        </thead>
        <tbody>
          {products.length > 1 && allRow(cols)}
          {products.map((p, i) => (
            <tr key={rowKey(p, i)}>
              {nameCell(p, i, editable)}
              {cols.map((c, j) => cell(p, c, j))}
            </tr>
          ))}
          {products.length === 0 && (
            <tr><td colSpan={cols.length + 1} style={{ ...td, color: C.muted, fontSize: 12.5, padding: "10px 4px" }}>
              No products yet: Airtable has no record matched to this release{airtableNote ? ` (${airtableNote})` : ""}. Add the works by hand until it does.
            </td></tr>
          )}
        </tbody>
        {products.length > 0 && <tfoot><tr>{footer}</tr></tfoot>}
      </table>
    </div>
  );
  const aaBeforeFraming = (econ.ppu_aa || 0) - (econ.frame_uplift_per_unit || 0);
  return (
    <div>
      {table(null, EDITION_TABLE, true, (
        <>
          <td style={{ ...foot, textAlign: "left" }}>Total</td>
          <td style={foot}>{fmt(econ.edition_total)}</td>
          <td style={foot}>{econ.edition_total ? fmtPct(econ.edition_size / econ.edition_total, 0) : "–"}</td>
          <td style={foot} title="Value-weighted mean price per target unit, in euros.">{econ.unit_price ? fmtMoney(econ.unit_price, 0) : "–"}</td>
          <td style={foot}>{fmt(econ.edition_size)}</td>
          <td style={foot} />
        </>
      ))}
      {products.length > 0 && table("Economics per unit", ECON_TABLE, false, (
        <>
          <td style={{ ...foot, textAlign: "left" }} title="Weighted over the target units.">Per target unit</td>
          <td style={foot}>{econ.ppu_artist > 0 ? fmtMoney(econ.ppu_artist, 2) : "–"}</td>
          <td style={foot} title="Before framing.">{aaBeforeFraming > 0 ? fmtMoney(aaBeforeFraming, 2) : "–"}</td>
          <td style={foot} colSpan={3} />
          <td style={foot} colSpan={2} title="The framing uplift over every target unit - Avant Arte's alone.">{econ.frame_uplift_per_unit > 0 ? `+${fmtMoney(econ.frame_uplift_per_unit, 2)}` : "–"}</td>
        </>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn secondary" onClick={onAdd} style={{ fontSize: 12 }}>Add a product</button>
        <span style={{ fontSize: 11.5, color: C.muted }}>Grey figures are Airtable's; a typed figure overrides it, blank goes back to it. Framing profit is Avant Arte's, never split.</span>
      </div>
    </div>
  );
}

export default function TargetSetting({ snap, onSaved }) {
  const [meta, setMeta] = useState(null);       // {inputs, sourced, benchmarks, meta_campaigns, derived, draws, creating}
  const [inp, setInp] = useState(null);         // editable inputs
  const [pick, setPick] = useState(null);       // a basket chosen in the picker, not yet saved
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);
  const [buildSecs, setBuildSecs] = useState(null);   // how long the background rebuild has run
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
    setMeta(null); setInp(null); setError(null); setPick(null); setPicking(false);
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

  if (error && !meta) return <div style={{ color: C.muted, padding: 24 }}>Failed to load inputs: {error}</div>;
  if (!inp || !econ) return <div style={{ color: C.muted, padding: 24 }}>Loading…</div>;

  const set = (k) => (e) => setInp({ ...inp, [k]: e.target.value });
  const dv = meta.derived || {};

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
  const stretchUnits = bmUnits !== null && editionSize > 0 ? editionSize - bmUnits : null;
  const stretchPct = bmUnits ? stretchUnits / bmUnits : null;
  const paidShare = profile ? profile.share_sessions.paid : null;
  const cpp = Number(inp.cost_per_purchase) > 0 ? Number(inp.cost_per_purchase) : (Number((b.cost_per_purchase || {}).Median) || 0);
  const partialEdition = econ.edition_total > econ.edition_size && econ.edition_size > 0;

  /* ---- the products: a typed figure lands on the entry for that product
   * (by Airtable id, or by name for one added by hand), blank clears it */
  const typedEntry = (p) => (inp.products || []).find((t) => (p.airtable_id ? String(t.airtable_id) === String(p.airtable_id) : (t.manual && norm(t.name) === norm(p.name))));
  const applyEntry = (list, p, patch) => {
    const out = [...list];
    let i = out.findIndex((t) => (p.airtable_id ? String(t.airtable_id) === String(p.airtable_id) : (t.manual && norm(t.name) === norm(p.name))));
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
  const onFieldAll = (key, raw) => {
    const v = parseField(key, raw);
    if (v === undefined) return;
    setInp((prev) => ({ ...prev, products: products.reduce((list, p) => applyEntry(list, p, patchFor(key, v)), prev.products || []) }));
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
      if (d.queued) {
        const started = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          setBuildSecs(Math.round((Date.now() - started) / 1000));
          let st = null;
          try { st = await (await fetch(`/api/inputs/${snap.id}/build`)).json(); } catch { st = null; }
          if (st && st.status === "running") continue;
          if (st && st.status === "failed") {
            setError("Inputs saved, but the rebuild failed (" + (st.error || "no detail") + ") - the page will update on the next data refresh.");
            break;
          }
          // done, or the service restarted under it: read the page as it is
          try { const r = await fetch(`/api/releases/${snap.id}`); if (r.ok) snapshot = await r.json(); } catch { /* the page stays as it was */ }
          break;
        }
      }
      if (snapshot) onSaved(snapshot);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(String(e)); } finally { setSaving(false); setBuildSecs(null); }
  };
  const discard = () => {
    setInp({ ...meta.inputs });
    setPick(null);
  };

  /* The rail's three columns (§8.3), from the same model the build runs. */
  const T = profile ? benchmarkTargets(profile, {
    edition_size: editionSize, unit_price: econ.unit_price || 0, cost_per_purchase: cpp,
    units_per_buyer: (snap.targets || {}).units_per_buyer || 0,
    entry_conversion_rate: inp.entry_conversion_rate,
  }, b) : null;
  const BM = T ? T.benchmark : null;
  const railRow = (label, target, bmv, format, tip) => {
    let stretch = target === null || bmv === null ? null : target - bmv;
    if (stretch !== null && format(Math.abs(stretch)) === format(0)) stretch = 0;
    return { label, tip, target, bm: bmv, stretch, format };
  };
  const railRows = [
    railRow("Paid units", T ? T.paid_units : null, BM ? BM.paid_units : null, (v) => fmt(v, 0),
      isOff("paid") ? "Paid is not in plan for this release." : "The basket's median paid units, lifted by K."),
    railRow("Buyers", T ? T.buyers : null, BM ? BM.buyers : null, (v) => fmt(v, 0),
      T ? `People, not pieces: the target divided by ${fmt(T.units_per_buyer, 3)} units per buyer.` : "People, not pieces."),
    railRow("Eligible entries", T ? T.entries_target : null, BM ? BM.entries : null, (v) => fmt(v, 0),
      `Target units ÷ the ${T && T.entry_rate ? Math.round(T.entry_rate * 100) + "%" : "80%"} eligible-entry → order rate (the release's own where typed, else the panel's): every unit is asked for as an entry. The benchmark is the basket's median units asked for the same way.`),
    railRow("Sessions", T ? T.total_sessions : null, BM ? BM.sessions : null, (v) => fmt(v, 0),
      "The basket's median sessions, lifted by the same K as every other volume."),
    railRow("Paid budget", T ? T.paid.budget : null, BM ? BM.paid_budget : null, (v) => fmtMoney(v, 0),
      isOff("paid") ? "Paid is not in plan for this release." : `Paid units × ${fmtMoney(cpp)} per unit, the panel's median cost per purchase.`),
    railRow("% of launch value", T ? (T.paid.budget_pct_of_launch_value ?? 0) : null, BM ? (BM.budget_pct_of_launch_value ?? 0) : null, (v) => fmtPct(v, 1),
      "Sense check: paid budget should stay under 6% of launch value."),
  ];
  const railCell = { fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const dateField = (label, f, value, src, tip) => (
    <Field label={label} tip={tip} right={<SourceChip source={src} title={src === "notion" ? "From the Notion log" : src === "clock" ? "From the funnel export's campaign clock" : src === "airtable" ? "From Airtable" : src === "typed" ? "Typed here" : ""} />}>
      {src === "notion"
        ? <input className="control ro" value={value || ""} readOnly />
        : <input className="control" type="date" value={value || ""} onChange={set(f)} />}
    </Field>
  );
  const legacy = inp.legacy_economics;
  const airtableMatch = (sourced.airtable || {}).match || "none";

  /* Untracked much higher than normal (DATA_MODEL 1.3): the build says which
   * of entries and units has a share over twice the panel's median and past
   * its 90th percentile; the sentence quotes the share, the count behind it
   * and the norm it is read against. */
  const ut = snap.untracked || null;
  const untrackedHigh = ut && Array.isArray(ut.high) ? ut.high.filter((k) => ut[k] && ut[k].share !== null).map((k) => {
    const v = ut[k], n = (ut.normal || {})[k] || {};
    const months = (ut.normal || {}).recentMonths;
    return { key: k, sentence: `${fmtPct(v.share, 0)} of this release's ${k} (${fmt(v.count, 0)} of ${fmt(v.total, 0)}) have no channel, against ${fmtPct(n.median, 0)} on a typical launch${months ? ` of the last ${months} months` : ""} and ${fmtPct(n.p90, 0)} at the 90th percentile.` };
  }) : [];

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 24 }}>

        {creating && snap.upcoming && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.5 }}>
            <b>Upcoming launch.</b> Known to Airtable, not yet to the funnel report. The dates{dv.dates_note ? ` (${dv.dates_note})` : ""} and
            {atProducts.length ? ` the ${atProducts.length} work${atProducts.length === 1 ? "" : "s"} with their editions and prices` : " the works"} below
            come from Airtable with their source shown. Check them, tick the Meta campaign, set the channels in plan, choose the basket
            and save: the page then carries the plan, and the funnel's actuals attach to it once the report picks the launch up.
          </div>
        )}
        {meta.storage && meta.storage.durable === false && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fbe9e6", color: "#7a2e1d", fontSize: 12.5, lineHeight: 1.5 }}
            title={`Saves are written to ${meta.storage.path}`}>
            <b>Targets saved here do not survive a deploy.</b> The service keeps them on its own disk, which Render resets on
            every deploy. Point SAVED_INPUTS_PATH at a file on a persistent disk (README, "Render's disk resets") and they stay.
          </div>
        )}
        {creating && !snap.upcoming && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.5 }}>
            <b>No targets yet.</b> The page currently shows actuals only.
            {" "}The dates come from the Notion log where it has them, else the funnel export's campaign clock, else Airtable - check them.
            {atProducts.length ? ` Airtable holds ${atProducts.length} product${atProducts.length === 1 ? "" : "s"} for this release.` : " Airtable has no product matched to this release yet: add the works by hand."}
            {" "}Tick the Meta campaigns, set the channels in plan, and save: the page rebuilds with expected-today, projections, paid ROI and sell-through.
          </div>
        )}

        {untrackedHigh.length > 0 && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.5 }}
            title="Untracked is the funnel export's channel for entries and units that could not be attributed. The build spreads it across the tracked channels in proportion to what they did that day.">
            <b>Untracked is much higher than normal.</b> {untrackedHigh.map((u) => u.sentence).join(" ")} The build spreads
            untracked across the tracked channels in proportion, so the channel split, the per-channel targets' progress and
            the funnel read less certainly than usual. Worth checking the tracking before reading the channel figures.
          </div>
        )}

        <Card dot="#b8862d" title="Release & timeline">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Release name" tip="Simple Release Name - the join key across every feed; changing it would orphan the actuals, so it is fixed here.">
              <input className="control ro" value={snap.releaseName} readOnly />
            </Field>
            <Field label="Campaign code" tip="The code the email, Instagram and artist-post feeds tag this campaign with (e.g. GlennLigon_LE_26) - it joins those panels to the release. Read off the Meta campaign's name, or guessed from the feeds."
              right={<SourceChip source={inp.campaign_code ? "typed" : inp.campaign_names[0] ? "matched" : dv.campaign_code ? "matched" : null} title={inp.campaign_code ? "As saved" : "From the Meta campaign's name, else the email and content feeds"} />}>
              {codeInForce
                ? <input className="control ro" value={codeInForce} readOnly />
                : <input className="control" value={inp.campaign_code || ""} onChange={set("campaign_code")} placeholder="Artist_LE_26 - no code found in any feed" />}
            </Field>
            <Field label="Meta campaigns" tip="Which Meta ad campaigns this release's paid actuals are read from - rows matching these names in the live spend feed, summed. The draw campaign named for the code is ticked on its own; add a purchases or sign-ups campaign when it belongs to this release.">
              <Campaigns code={codeInForce} chosen={inp.campaign_names} all={meta.meta_campaigns} suggested={sourced.campaigns}
                onChange={(names) => setInp({ ...inp, campaign_names: names })} />
            </Field>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Field label="Marketing lead" right={<SourceChip source={leadFromAirtable ? "airtable" : inp.marketing_lead ? "typed" : null} title={leadFromAirtable ? "From Airtable" : "Typed here until Airtable holds it"} />}>
                {leadFromAirtable
                  ? <input className="control ro" value={leadFromAirtable} readOnly />
                  : <input className="control" value={inp.marketing_lead || ""} onChange={set("marketing_lead")} placeholder="not in Airtable yet - type it" />}
              </Field>
              <Field label="Slack channel" tip="Where the Post to Slack button on the sell-through card sends this release's update. The channel name without the #; for a private channel, invite the Launch Performance bot to it first. Saved on its own, separately from the targets.">
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="control" value={slackDraft} onChange={(e) => setSlackDraft(e.target.value)} placeholder="launch-updates" />
                  <button className="btn secondary" disabled={slackSaving || slackDraft.trim().replace(/^#/, "") === slackCurrent} onClick={saveSlack} style={{ flex: "0 0 auto" }}>
                    {slackSaving ? "Saving…" : "Save"}
                  </button>
                </div>
                {slackError && <div style={{ fontSize: 11.5, marginTop: 4, color: C.red }}>{slackError}</div>}
                {!slackError && slackNote && <div style={{ fontSize: 11.5, marginTop: 4, color: C.amber, lineHeight: 1.5 }}>{slackNote}</div>}
                {!slackError && !slackNote && snap.slack && snap.slack.lastPostAt && (
                  <div style={{ fontSize: 11.5, marginTop: 4, color: C.muted }}>last posted {new Date(snap.slack.lastPostAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                )}
              </Field>
            </div>
          </div>
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
            {dateField("Private room opens", "private_room_open", prOpen, prSrc, "The day of the early-access email, from the Notion log. Until the log has it: what is typed, else two weeks before the announce.")}
            {dateField("Announce date", "announce_date", announce, annSrc, "From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
            {dateField("Draw closes", "launch_end", closes, closeSrc, "The launch: the day the draw closes and sales open. From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <span className="chip" title="Announce → draw close. The campaign clock runs on this window.">Campaign {days === null ? "–" : days} days</span>
            <span className="chip" title="Private room runs from opening to announce - early-access units land here.">Private room {prDays === null ? "–" : prDays} days pre-announce</span>
          </div>
        </Card>

        <Card dot="#8a7a52" title="Products & economics">
          <div className="spacer-8" />
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
            {airtableMatch !== "none"
              ? <>Airtable holds {atProducts.length} product{atProducts.length === 1 ? "" : "s"} for this launch (matched by {airtableMatch}). Their edition, target, price and economics are read from there as they are filled in; type over a figure only where Airtable has none or is wrong. The All products row sets every product at once.</>
              : <>Airtable has no record matched to this release{(sourced.airtable || {}).note ? ` - ${(sourced.airtable || {}).note}` : ""}. Add the works by hand until it does.</>}
          </div>
          {legacy && (
            <div style={{ padding: "10px 14px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.6, marginBottom: 14 }}>
              <b>Release-level figures still in force.</b> This release was set up before the model went per product: target {fmt(legacy.edition_size)}{legacy.edition_total > legacy.edition_size ? ` of ${fmt(legacy.edition_total)}` : ""} units at {fmtMoney(legacy.unit_price || 0, 0)},
              artist {fmtMoney((legacy.artist_profit || 0) / (legacy.edition_size || 1), 0)} and AA {fmtMoney((legacy.aa_group_profit || 0) / (legacy.edition_size || 1), 0)} per unit.
              The products below are what Airtable holds; the totals switch to them when these are cleared.
              {" "}<button className="btn secondary" style={{ fontSize: 11.5, padding: "3px 10px", marginLeft: 6 }}
                onClick={() => setInp({ ...inp, legacy_economics: null })} title="Drop the release-level figures: the products' figures carry the totals from the next save.">Use the products' figures</button>
            </div>
          )}
          <ProductsTable products={products} econ={econ} onField={onField} onFieldAll={onFieldAll} onName={onName} onAdd={onAdd} onRemove={onRemove}
            airtableNote={(sourced.airtable || {}).note} />
          <div style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.7 }}>
            <span style={{ color: C.muted }}>Target </span><b>{fmt(econ.edition_size)}</b>
            {econ.edition_total > econ.edition_size ? <span style={{ color: C.muted }}> of {fmt(econ.edition_total)} in the edition</span> : <span style={{ color: C.muted }}> units, the whole edition</span>}
            <span style={{ color: C.muted }}> · launch value </span><b>{fmtMoney(econ.launch_value, 0)}</b>
            {(econ.launch_currencies || []).some((c) => c !== "EUR") && <span style={{ color: C.muted }}> (from {(econ.launch_currencies || []).join(", ")} at a fixed rate)</span>}
            <span style={{ color: C.muted }}> · artist </span><b>{fmtMoney(econ.ppu_artist, 2)}</b><span style={{ color: C.muted }}> and AA </span><b>{fmtMoney(econ.ppu_aa, 2)}</b><span style={{ color: C.muted }}> per unit</span>
            {econ.frame_uplift_per_unit > 0 && <span style={{ color: C.muted }}> (incl. {fmtMoney(econ.frame_uplift_per_unit, 2)} framing)</span>}
            <span style={{ color: C.muted }}> · AA carries </span><b>{fmtPct(econ.aa_budget_share, 0)}</b><span style={{ color: C.muted }}> of paid spend</span>
            <span style={{ color: C.muted }}> ({econ.deal && econ.deal.length ? econ.deal.join(" and ") : legacy ? "as set up" : "no deal recorded, 50/50 assumed"})</span>
          </div>
        </Card>

        <Rates inp={inp} setInp={setInp} />

        <Card dot={GROUP_DOTS.funnel} title="Benchmark basket">
          <div className="spacer-16" />
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="Basket" tip="The launches this release is benchmarked against. The benchmark is their median, per metric and per channel.">
                <input className="control ro" value={basketName || "- none chosen -"} readOnly />
              </Field>
            </div>
            <button className="btn secondary" onClick={() => setPicking(true)}
              title="Opens the basket picker: the ready-made baskets with their medians, or a bespoke selection.">
              Change basket
            </button>
          </div>

          {profile === null ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 14, lineHeight: 1.6 }}>
              No basket yet. Choose one to see the benchmark and the targets it gives; a release saved without one is
              benchmarked against the launches nearest its target and price.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <span className="chip" title="Launches in the basket. Under six and the median moves a lot on one launch.">
                  {fmt(prof ? prof.n : bm && bm.basket ? bm.basket.n : null)} launches
                </span>
                <span className="chip" title={off.length ? "Median units without the channels set aside, with the 25th to 75th percentile read the same way." : "Median units, with the 25th to 75th percentile of the basket beside it."}>
                  units {fmt(profile.units)} ({fmt(profile.units_p25)}-{fmt(profile.units_p75)})
                </span>
                {profile.price > 0 && (
                  <span className="chip" title="Median unit price of the basket in euros (from Airtable), with its 25th to 75th percentile. The default basket matches on price as well as size (BENCHMARK_SPEC 3.1).">
                    price {fmtMoney(profile.price)} ({fmtMoney(profile.price_p25)}-{fmtMoney(profile.price_p75)})
                  </span>
                )}
                <span className="chip">sessions {fmt(profile.sessions)}</span>
                <span className="chip" title={isOff("paid") ? "Paid is not in plan for this release." : "Median share of sessions from paid."}>
                  {isOff("paid") ? "paid not in plan" : `paid ${fmtPct(paidShare, 0)}`}
                </span>
                <span className="chip">{fmt(profile.campaign_days)} campaign days</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
                {basketDirty
                  ? <>Not saved yet. The figures below follow the launches ticked; save to rebuild the page on them.</>
                  : bm && bm.basket
                    ? <>Matched from {fmt(bm.basket.n)} comparable launches
                      {bm.basket.id === bm.basket.suggestedId ? ", the suggested basket for this release" : ", chosen by hand"}
                      {bm.basket.thin ? ". Thin: under six launches, so the median moves easily." : "."}</>
                    : null}
              </div>
            </>
          )}

          {/* what a basket cannot know: the channels this release will not run
              (§4.3). Off takes the group's median out of the benchmark and its
              share out of the target; the other channels carry the whole sellout. */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.hairline}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}
              title="A channel this release will not run leaves the benchmark and the target: the basket is read on its other channels, and they carry the whole sellout between them.">
              Channels in plan
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 26px", alignItems: "center" }}>
              <Switch id="ch-paid" on={!isOff("paid")} onChange={(on) => setOff("paid", on)} label="Running paid"
                sub={isOff("paid") ? "off: benchmarked on what the basket did without paid, and the other channels carry the whole target" : "paid units, spend and the paid benchmark are in"}
                why="The basket keeps every launch, paid or not; with paid off each counts on its other channels only." />
              <Switch id="ch-artist" on={!isOff("referral_artist")} onChange={(on) => setOff("referral_artist", on)}
                label="Artist's own channels"
                sub={isOff("referral_artist") ? "off: no artist target and no posting benchmark - an estate, or an artist who will not post" : "the artist posts on channels of their own"}
                why="Off for an estate, or a living artist with no channels of their own. The artist group leaves the benchmark and the funnel expects no posts." />
              {!isOff("referral_artist") && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted }}
                  title="How much the artist will post, against the tiers past campaigns were labelled with: the funnel's posting benchmark is the median of completed campaigns in the same tier.">
                  posting
                  <Seg small options={["Low", "Medium", "High"]} value={inp.artist_posting_tier || "Medium"}
                    onChange={(v) => setInp({ ...inp, artist_posting_tier: v })} />
                </span>
              )}
            </div>
          </div>

          {profile && (
            <>
              <div style={{ height: 18 }} />
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><ChannelRow head /></thead>
                <tbody>
                  {GROUPS.map((g) => (
                    <ChannelRow key={g.key} label={g.name} off={isOff(g.key)}
                      bmSessions={profile.sessions_by_group[g.key] || 0}
                      bmUnits={profile.units_by_group[g.key] || 0}
                      conv={profile.conv[g.key] > 0 ? profile.conv[g.key] : null} k={k || 1} />
                  ))}
                  <ChannelRow total label="Total"
                    bmSessions={profile.sessions}
                    bmUnits={profile.units}
                    conv={null} k={k || 1} />
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card dot="#c96a3a" title="Paid assumptions">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Cost per paid unit (€)" tip="What a paid unit costs to buy: paid units × this is the paid budget. Blank = the panel's median.">
              <NumInput value={inp.cost_per_purchase === null || inp.cost_per_purchase === undefined ? "" : String(inp.cost_per_purchase)}
                placeholder={`${fmt(Number((b.cost_per_purchase || {}).Median) || 0)} · panel median`}
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, cost_per_purchase: c === "" ? null : c })); }} />
            </Field>
            <Field label="Paid cannibalisation (%)" tip="The share of paid entries that would have come anyway. The ROI and the budget floor read profit net of it. Blank = the LE standard.">
              <NumInput value={inp.cannibalisation === null || inp.cannibalisation === undefined ? "" : String(Math.round(Number(inp.cannibalisation) * 1000) / 10)}
                placeholder={`${Math.round(100 * (Number(b.cannibalisation) || 0.2))} · standard`}
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), 0, 95) / 100; setInp((prev) => ({ ...prev, cannibalisation: v === null || Number.isNaN(v) ? null : v })); }} />
            </Field>
          </div>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginTop: 12 }}>
            Spend is Meta's, billed in euros, and the page runs in euros: every figure here is euros.
          </div>
        </Card>

        <Card dot="#4f80d6" title="Stretch">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Benchmark (units)" tip="The basket's median units at close - what launches like this one typically reach.">
              <input className="control ro num" value={bmUnits === null ? "–" : fmt(bmUnits)} readOnly />
            </Field>
            <Field label="Target (units)" tip="The products' editions at their target sell-through, summed - the business target, from the products table above.">
              <input className="control ro num" style={{ fontWeight: 600 }} value={editionSize > 0 ? fmt(editionSize) : "–"} readOnly />
            </Field>
            <Field label="Stretch" tip="Target − benchmark: how much more than a typical launch this one is being asked for.">
              <input className="control ro num"
                value={stretchUnits === null ? "–" : `+${fmt(stretchUnits)} units · +${fmtPct(stretchPct, 0)}`} readOnly />
            </Field>
          </div>

          <div style={{ fontSize: 12, color: C.muted, marginTop: 14, lineHeight: 1.6 }}>
            The stretch is spread evenly: every volume - sessions, entries, units and spend - is lifted by the same
            factor in every channel in plan, on every day of the campaign, and conversion rates are held at the
            benchmark. A target that quietly assumes the site converts better than it ever has is a target nobody
            can act on, so the stretch is asked of traffic and spend only.
          </div>
        </Card>
      </div>

      <div style={{ width: 384, flex: "0 0 384px", position: "sticky", top: 28 }}>
        <Card dot="#8a7a52" title="Derived targets">
          <div className="spacer-8" />
          <div className="lead" title="Secured-units target - the hero target on the Overview tab.">
            {editionSize > 0 ? fmt(editionSize) : "–"}
          </div>
          <div className="lead-caption">{editionSize <= 0 ? "target units - a product with an edition is needed"
            : partialEdition ? `target units · ${Math.round((100 * econ.edition_size) / econ.edition_total)}% of the ${fmt(econ.edition_total)} edition` : "target units, the whole edition"}</div>
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px 72px", gap: 4, alignItems: "center" }}>
            <span />
            <span style={{ ...railCell, fontSize: 11.5, color: C.muted, fontWeight: 600 }} title="The basket's median - what launches like this one typically reach.">Benchmark</span>
            <span style={{ ...railCell, fontSize: 11.5, fontWeight: 600 }}>Target</span>
            <span style={{ ...railCell, fontSize: 11.5, color: C.muted, fontWeight: 600 }} title="Target − benchmark: the uplift being asked for.">Stretch</span>
            {railRows.map((r) => (
              <React.Fragment key={r.label}>
                <span style={{ fontSize: 12.5, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }} title={r.tip}>{r.label}</span>
                <span style={{ ...railCell, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }}>{r.bm === null ? "–" : r.format(r.bm)}</span>
                <span style={{ ...railCell, fontWeight: 600, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8,
                  color: r.target === null ? C.muted : r.label === "% of launch value" ? (T && T.paid.sense_check_breached ? C.red : C.green) : C.ink }}>{r.target === null ? "–" : r.format(r.target)}</span>
                <span style={{ ...railCell, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }}>{r.stretch === null ? "–" : r.format(r.stretch)}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={saving || missing.length > 0} onClick={save}
              title={missing.length ? `Still needed: ${missing.join(", ")}` : creating ? "Saves the inputs and rebuilds this release with the full target model." : "Saves the inputs and recomputes this release's targets, plan curves and projections."}>
              {saving ? (buildSecs !== null ? `Rebuilding the page… ${buildSecs}s` : "Saving…") : savedFlash ? "✓ Saved" : creating ? "Set targets" : "Save targets"}
            </button>
            <button className="btn secondary" onClick={discard}>Discard</button>
          </div>
          {!T && !error && missing.length === 0 && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
              Choose a basket to see the targets; saving without one benchmarks against the nearest launches.
            </div>
          )}
          {basketDirty && !error && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
              A new basket rebuilds this release from the panel, so saving takes longer than usual.
            </div>
          )}
          {missing.length > 0 && !error && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Still needed: {missing.join(", ")}</div>
          )}
          {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{error}</div>}
        </Card>
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
    </div>
  );
}
