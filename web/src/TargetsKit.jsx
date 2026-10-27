/* The pieces the two targets pages share (TargetSetting.jsx for a limited
 * edition, TLTargets.jsx for a timed launch): the Linear project-page
 * furniture from the design canvas (the pills under the title, the Works,
 * Basket and Dates lists, the property rows of the side panel, the save
 * status in the page header), the autosave that every change goes through,
 * and the reads both pages make (the inputs document, the panel's candidate
 * rows, the index). Nothing here computes a target: the maths stays on the
 * pages, in shared/economics.mjs, shared/benchmarkModel.mjs and
 * shared/tlModel.mjs, as the build runs it.
 *
 * Autosave: the inputs are posted, debounced, whenever they differ from what
 * was last saved; the server rebuilds the page behind the answer and the
 * page follows the build. A Note at the foot says "Saved" with an Undo that
 * puts the previous inputs back (and saves them). The status sits in the
 * page header's #phead-status slot through a portal: nothing when idle, a
 * lozenge while saving or rebuilding, a warm one with a retry when the
 * rebuild failed. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loz, Menu, MenuItem, Note, Switch, useMenu } from "./ui.jsx";
import { fmt, fmtDay, fmtMoney } from "./format.mjs";
import { Arrow, Basket, Cal, Diamond, Dots, Img, Lines, Meta, Plus, ProgressRing, Scatter, Send, Spinner, Undo, Warn, X } from "./icons.jsx";
import { GROUPS } from "../../shared/benchmarkModel.mjs";

/* ---------- words and formats ---------- */
export const CH = [
  { key: "aa_email", name: "AA Email", color: "#d9a400" },
  { key: "aa_social", name: "AA Meta", color: "#1877f2" },
  { key: "referral_artist", name: "Artist", color: "#0f7052" },
  { key: "search_direct_other", name: "Direct etc.", color: "#8a8a8e" },
  { key: "paid", name: "Paid", color: "#5e6ad2" },
];
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const dayOf = (iso) => { if (!iso) return null; const t = Date.parse(/T/.test(String(iso)) ? iso : `${String(iso).slice(0, 10)}T00:00:00Z`); return Number.isFinite(t) ? new Date(t) : null; };
/* "23 Jun" (this year) or "23 Jun 2025" (another year), from an ISO day */
export const fmtDate = (iso) => {
  const d = dayOf(iso);
  if (!d) return "";
  const y = d.getUTCFullYear();
  return y === new Date().getUTCFullYear() ? fmtDay(d) : `${fmtDay(d)} ${y}`;
};
/* "13 Oct 18:00" in Amsterdam time, from an ISO instant */
export const fmtWhen = (iso) => {
  const d = dayOf(iso);
  if (!d) return "";
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  const day = new Date(d.toLocaleDateString("en-US", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }) + " UTC");
  return `${fmtDay(day)} ${hm}`;
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* "Apr 2025", from an ISO day */
export const fmtMonth = (iso) => (iso ? `${MON[Number(String(iso).slice(5, 7)) - 1] || ""} ${String(iso).slice(0, 4)}` : "");
export const signed = (v) => (v < 0 ? "−" : "+") + fmt(Math.abs(v), 0);
/* a figure as it is typed: percentages as whole numbers, money and counts to two places */
export const PCT = new Set(["target_sellthrough", "aa_revenue_share", "aa_profit_share", "artist_revenue_cut", "frame_conversion"]);
export const cellText = (key, v) => {
  if (v === null || v === undefined || v === "") return "";
  const n = PCT.has(key) ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100;
  return String(n);
};
export const hoursWords = (h) => (!(h > 0) ? "" : h % 24 === 0 && h >= 72 ? `${h / 24} days` : `${Math.round(h)} hours`);
export const hoursShort = (h) => (!(h > 0) ? "–" : h % 24 === 0 && h >= 72 ? `${h / 24} d` : `${Math.round(h)} h`);

/* ---------- the reads ---------- */
/* The inputs document for a release (GET /api/inputs/:id): what was saved,
 * else the defaults the ETL derived, with the feeds' readings (sourced), the
 * panel constants and the Meta campaigns on file. `normalise` puts a saved
 * record into the shape the page edits. */
export function useInputs(id, normalise) {
  const [meta, setMeta] = useState(null);
  const [inp, setInp] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    setMeta(null); setInp(null); setError(null);
    fetch(`/api/inputs/${id}`).then((r) => r.json()).then((d) => {
      if (!live) return;
      if (d.error) { setError(d.error); return; }
      const start = normalise(d.inputs || d.defaults || {});
      setMeta({ ...d, inputs: start, creating: !d.inputs });
      setInp({ ...start });
    }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [id]);
  return { meta, setMeta, inp, setInp, error };
}
/* The panel's candidate rows, once: what the picker ranks and the basket list reads. */
export function useCandidates(url) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(url).then((r) => r.json()).then((d) => { if (!live) return; if (d.error) setError(d.error); else setRows(d.rows || []); }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [url]);
  return { rows, error };
}
/* The index, for the page each basket launch links to. */
export function useIndexRows() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let live = true;
    fetch("/api/index").then((r) => r.json()).then((d) => { if (live) setRows((d && d.releases) || []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return rows;
}

/* ---------- autosave ---------- */
/* `body(inp)` is what the server is posted; `missing` lists what the targets
 * still need (nothing is posted while it does). The status: {state: idle |
 * saving | building | failed, error, secs}. */
export function useAutosave({ id, inp, setInp, meta, setMeta, missing, body, onSaved, delay = 900 }) {
  const [status, setStatus] = useState({ state: "idle" });
  const [note, setNote] = useState(null);           // {text, prev}
  const savedRef = useRef(null);                    // the inputs as last saved
  const timer = useRef(null);
  const live = useRef(true);
  const idRef = useRef(id);
  useEffect(() => { live.current = true; return () => { live.current = false; clearTimeout(timer.current); }; }, []);
  // a new release: nothing saved yet; the saved inputs are the document's once it is read
  useEffect(() => { savedRef.current = null; idRef.current = id; setStatus({ state: "idle" }); setNote(null); }, [id]);
  useEffect(() => { if (meta && !savedRef.current) savedRef.current = meta.inputs; }, [meta]);

  /* Follow the rebuild running behind a save until it lands, then read the
   * page as rebuilt. Shared by a save made here and one made before the
   * reader left the tab. */
  async function followBuild(startedAt) {
    const rid = idRef.current;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!live.current || idRef.current !== rid) return;
      setStatus({ state: "building", secs: Math.round((Date.now() - startedAt) / 1000) });
      let st = null;
      try { st = await (await fetch(`/api/inputs/${rid}/build`)).json(); } catch { st = null; }
      if (st && st.status === "running") continue;
      if (st && st.status === "failed") { setStatus({ state: "failed", error: st.error || "no detail" }); return; }
      try { const r = await fetch(`/api/releases/${rid}`); if (r.ok) { const snap = await r.json(); if (live.current && idRef.current === rid) onSaved(snap); } } catch { /* the page stays as it was */ }
      if (live.current && idRef.current === rid) setStatus({ state: "idle" });
      return;
    }
  }
  // a rebuild still running from a save made before the reader left the tab
  useEffect(() => {
    let on = true;
    fetch(`/api/inputs/${id}/build`).then((r) => r.json()).then((st) => {
      if (!on || !st || st.status !== "running") return;
      const startedAt = st.startedAt ? Date.parse(st.startedAt) : NaN;
      followBuild(Number.isFinite(startedAt) ? startedAt : Date.now());
    }).catch(() => {});
    return () => { on = false; };
  }, [id]);

  async function save(toSave, words) {
    const rid = idRef.current;
    setStatus({ state: "saving" });
    try {
      const res = await fetch(`/api/inputs/${rid}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: body(toSave) }) });
      const d = await res.json().catch(() => ({}));
      if (!live.current || idRef.current !== rid) return;
      if (!res.ok) { setStatus({ state: "failed", error: d.error || `save failed (${res.status})`, save: true }); return; }
      const prev = savedRef.current;
      savedRef.current = toSave;
      setMeta((m) => (m ? { ...m, creating: false, inputs: toSave, storage: d.storage || m.storage } : m));
      setNote({ text: words || "Saved", prev });
      if (d.queued) await followBuild(Date.now());
      else { if (d.snapshot) onSaved(d.snapshot); setStatus({ state: "idle" }); }
    } catch (e) {
      if (live.current && idRef.current === rid) setStatus({ state: "failed", error: String(e), save: true });
    }
  }
  // every change is saved, debounced, once the targets have what they need
  useEffect(() => {
    if (!inp || !meta || !savedRef.current) return undefined;
    if (JSON.stringify(inp) === JSON.stringify(savedRef.current)) return undefined;
    if (missing && missing.length) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (live.current) save(inp); }, delay);
    return () => clearTimeout(timer.current);
  }, [inp, missing && missing.join("|")]);

  const undo = () => { if (note && note.prev) setInp({ ...note.prev }); setNote(null); };
  const retry = () => { if (savedRef.current) save(inp && JSON.stringify(inp) !== JSON.stringify(savedRef.current) ? inp : savedRef.current); };
  const dirty = !!(inp && savedRef.current && JSON.stringify(inp) !== JSON.stringify(savedRef.current));
  return { status, note, undo, dismiss: () => setNote(null), retry, dirty, saved: savedRef.current };
}

/* ---------- the header's status and ⋯ menu, through a portal ---------- */
export function HeadStatus({ status, onRetry, menu }) {
  const [slot, setSlot] = useState(null);
  const m = useMenu();
  useEffect(() => { setSlot(document.getElementById("phead-status")); }, []);
  if (!slot) return null;
  const s = status || { state: "idle" };
  return createPortal(
    <>
      {s.state === "saving" && <Loz kind="ind" icon={<Spinner />}>Saving…</Loz>}
      {s.state === "building" && <Loz kind="ind" icon={<Spinner />} tip="The page is being rebuilt with these targets">Rebuilding{s.secs > 4 ? ` ${s.secs}s` : ""}</Loz>}
      {s.state === "failed" && (
        <>
          <Loz kind="warm" tip={s.error}>{s.save ? "Not saved" : "Rebuild failed"}</Loz>
          <button className="sbtn" onClick={onRetry}>Retry</button>
        </>
      )}
      {menu && menu.length > 0 && (
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button className="ib" aria-label="More" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}><Dots /></button>
          <Menu open={m.open} onClose={m.close} style={{ top: 30, right: 0, width: 310 }}>
            {menu.map((it, i) => (
              <MenuItem key={i} icon={it.icon} right={it.right} disabled={it.disabled} title={it.title} onClick={() => { m.close(); if (it.onClick) it.onClick(); }}>{it.label}</MenuItem>
            ))}
          </Menu>
        </span>
      )}
    </>,
    slot,
  );
}
export const SendIcon = Send;
export const UndoIcon = Undo;

/* ---------- the quiet strip under the header ---------- */
export function Strip({ icon, text, sx, action, onDismiss }) {
  return (
    <div className="strip" role="status">{icon || null}<span>{text}</span>{sx ? <span className="sx">{sx}</span> : null}<span className="sp" />{action || null}
      {onDismiss && <button className="ib" style={{ margin: 0 }} aria-label="Dismiss" onClick={onDismiss}><X /></button>}</div>
  );
}

/* ---------- the pills under the title ---------- */
/* The basket has no name: it is the launches in it, so the pill says how
 * many and whether someone has edited the suggestion. */
export function BasketPill({ n, edited, onClick }) {
  return <button className="pill" onClick={onClick} title={`The launches this release is benchmarked against: the benchmark is their median, per metric and per channel. ${edited ? "Edited from the suggestion" : "The suggested launches"}. Opens the picker.`}><Basket />{n ? `${n} launch${n === 1 ? "" : "es"}` : "Basket"}{edited ? <span className="g">edited</span> : null}</button>;
}
/* Channels in plan: a multi-select menu, one row a channel. A channel left
 * out leaves the benchmark and the target: the basket is read on its other
 * channels, and they carry the whole target between them. */
export function ChannelsPill({ off, setOff, word }) {
  const m = useMenu();
  const on = CH.filter((c) => !off.includes(c.key)).length;
  return (
    <span className="pw">
      <button className="pill" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle} title="A channel this release will not run leaves the benchmark and the target: the basket is read on its other channels."><Lines />{on === CH.length ? "All channels" : `${on} of ${CH.length} channels`}</button>
      <Menu open={m.open} onClose={m.close} style={{ top: 32, left: 0, width: 240 }}>
        {CH.map((c, i) => {
          const isOn = !off.includes(c.key);
          return (
            <MenuItem key={c.key} checkbox checked={isOn} icon={<span className="cdot" style={{ background: c.color }} />} right={String(i + 1)}
              title={c.key === "paid" ? "The basket keeps every launch, paid or not; with paid off each counts on its other channels only, and there is no budget." : c.key === "referral_artist" ? "Off for an estate, or a living artist with no channels of their own: the artist group leaves the benchmark and the funnel expects no posts." : undefined}
              onClick={() => setOff(c.key, !isOn)}>{c.name}</MenuItem>
          );
        })}
      </Menu>
    </span>
  );
}
/* Where the stretch comes from (BENCHMARK_SPEC 4.4): even across channels
 * (the basket's own shares), all from paid, or custom shares on coupled
 * sliders that always add to 100 (shared/benchmarkModel.mjs rebalanceShares). */
export function StretchPill({ mode, onMode, shares, onSlide, active, paidOff, disabled, unitWord = "units", stretchOf }) {
  const m = useMenu();
  const [mix, setMix] = useState(false);
  const word = mode === "paid" ? "from paid" : mode === "custom" ? "custom" : "even";
  const opts = [["even", "Even across channels", "The basket's own shares: the same uplift in every channel."], ["paid", "All from paid", "The whole stretch from paid: the other channels stay at their benchmark."], ["custom", "Custom", "Set each channel's share on a slider; the others rescale so the shares add to 100."]];
  const sum = Math.round(CH.reduce((s, c) => s + (active.includes(c.key) ? 100 * Number(shares[c.key] || 0) : 0), 0));
  return (
    <span className="pw">
      <button className="pill" aria-haspopup="menu" aria-expanded={m.open || mix} disabled={disabled} onClick={() => { if (mix) setMix(false); else m.toggle(); }}
        title="How the gap between the target and the basket's median is shared out. Each channel's target is its benchmark plus its share of the stretch, with its sessions lifted to match; conversion is held."><Arrow />Stretch<span className="g">{word}</span></button>
      <Menu open={m.open} onClose={m.close} style={{ top: 32, left: 0, width: 240 }}>
        {opts.map(([k, label, tip], i) => (
          <MenuItem key={k} radio checked={mode === k} right={String(i + 1)} title={tip} disabled={(k === "paid" && (paidOff || !active.includes("paid"))) || (k === "custom" && active.length < 2)}
            onClick={() => { m.close(); if (k === "custom") { onMode("custom"); setMix(true); } else onMode(k); }}>{label}</MenuItem>
        ))}
      </Menu>
      <Menu open={mix} onClose={() => setMix(false)} role="dialog" label="Where the stretch comes from" style={{ top: 32, left: 0, width: 320, padding: "8px 4px" }}>
        <div className="mixh">Where the stretch comes from<Loz kind={sum === 100 ? "ghost" : "warm"}>{sum}%</Loz></div>
        {CH.map((c) => {
          const isActive = active.includes(c.key);
          const pct = isActive ? Math.round(100 * Number(shares[c.key] || 0)) : 0;
          return (
            <label key={c.key} className={`mixr${isActive ? "" : " dis"}`} title={!isActive ? "Not in plan, or no benchmark in the basket to lift." : stretchOf ? `${signed(Math.round(stretchOf(c.key)))} ${unitWord}` : undefined}>
              <span className="nm"><span className="cdot" style={{ background: c.color, width: 8, height: 8, borderRadius: "50%", flex: "0 0 8px" }} />{c.name}</span>
              <input className="rng" type="range" min="0" max="100" step="1" value={pct} disabled={!isActive || active.length < 2} aria-label={`${c.name}: share of the stretch`} onChange={(e) => onSlide(c.key, Number(e.target.value) / 100)} />
              <span className="p">{isActive ? `${pct}%` : "–"}</span>
            </label>
          );
        })}
        <div className="mixf"><button className="sbtn" onClick={() => setMix(false)}>Done</button></div>
      </Menu>
    </span>
  );
}
/* A pill with a radio menu: the window length of a timed launch, say. */
export function RadioPill({ icon, label, value, options, onChange, tip, width = 220 }) {
  const m = useMenu();
  const cur = options.find((o) => o[0] === value);
  return (
    <span className="pw">
      <button className="pill" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle} title={tip}>{icon || null}{label}<span className="g">{cur ? cur[1] : value}</span></button>
      <Menu open={m.open} onClose={m.close} style={{ top: 32, left: 0, width }}>
        {options.map(([k, l]) => <MenuItem key={k} radio checked={value === k} onClick={() => { m.close(); onChange(k); }}>{l}</MenuItem>)}
      </Menu>
    </span>
  );
}

/* ---------- the sections of the main column ---------- */
export function Section({ title, icon, count, lozes, action, children, aria }) {
  return (
    <section className="sec" aria-label={aria || (typeof title === "string" ? title : undefined)}>
      <div className="sh">{icon || null}<span className="t">{title}</span>{count !== undefined && count !== null ? <Loz kind="ghost">{count}</Loz> : null}{lozes || null}{action ? <span className="ib sp" style={{ display: "inline-flex", padding: 0, background: "transparent" }}>{action}</span> : null}</div>
      <div className="rule" />
      {children}
    </section>
  );
}
/* One work: the name, its target over its edition on a ring, its price,
 * whether a frame is offered. Pressed, the side panel shows its figures. */
export function WorkRow({ w, on, onPick, unitWord = "" }) {
  const pct = w.edition > 0 && w.target !== null ? Math.min(1, w.target / w.edition) : 0;
  return (
    <button className={`li${on ? " on" : ""}${w.excluded ? " off" : ""}`} aria-pressed={on} onClick={onPick} title={w.excluded ? `${w.name}: not in the release, counts nothing` : w.name}>
      <span className="img"><Img /></span><span className="nm">{w.name}</span>
      {w.manual && <Loz kind="ghost" tip="Added on this tab, not in Airtable">by hand</Loz>}
      <span className="meta">
        <Loz kind={w.over ? "warm" : undefined} tip={w.over ? "The target is more than the edition; editions cap nothing on a timed launch" : w.tip} icon={<ProgressRing pct={pct} color={w.over ? "#e8743b" : "#5e6ad2"} />}>{w.target === null || w.target === undefined ? "–" : fmt(w.target)} / {w.edition ? fmt(w.edition) : "–"}{unitWord}</Loz>
        <Loz tip="Unit price">{w.price ? fmtMoney(w.price) : "–"}</Loz>
        {w.framed && <Loz tip="Framing offered" icon={<FrameIc />}>Framed</Loz>}
        {w.gaps && w.gaps.length > 0 && !w.excluded && <Loz kind="warm" tip={`Unit economics missing: ${w.gaps.join(", ")}. Press the row to type them.`}>{w.gaps.length} missing</Loz>}
      </span>
    </button>
  );
}
/* What a work's unit economics still lack: the figures the ROI model and
 * the Slack post to the project manager read per unit (price, the two
 * profits, the deal's share, the frame profit when a frame is offered) and
 * the volume the target is worked from. A work out of the release lacks
 * nothing, since it counts nothing. */
export function economicsGaps(p, { tl = false } = {}) {
  if (!p || p.excluded) return [];
  const gaps = [];
  if (tl ? !(p.units_target > 0) : !(p.edition > 0)) gaps.push(tl ? "units target" : "edition");
  if (!(p.unit_price > 0)) gaps.push("price");
  if (p.artist_profit_per_unit === null || p.artist_profit_per_unit === undefined) gaps.push("artist profit");
  if (p.aa_profit_per_unit === null || p.aa_profit_per_unit === undefined) gaps.push("AA profit");
  if ((p.aa_profit_share === null || p.aa_profit_share === undefined) && (p.aa_revenue_share === null || p.aa_revenue_share === undefined)) gaps.push("profit or revenue share");
  if (p.framing_available && (p.frame_profit_per_unit === null || p.frame_profit_per_unit === undefined)) gaps.push("frame profit");
  return gaps;
}
/* The strip under the header when a work's unit economics are incomplete:
 * one work named with what it lacks, several counted with the figures they
 * lack by how many lack them. Open puts the first in the side panel. */
export function economicsStrip(all_rows, onOpen) {
  const rows = all_rows.filter((r) => !r.excluded);
  const short = rows.filter((r) => r.gaps && r.gaps.length);
  if (!short.length) return null;
  const name = (r) => `${r.name}: ${r.gaps.join(", ")}`;
  // several works: the figures by how many lack them, the ones every short work lacks first
  const counts = new Map();
  for (const r of short) for (const g of r.gaps) counts.set(g, (counts.get(g) || 0) + 1);
  const all = [...counts].filter(([, c]) => c === short.length).map(([g]) => g);
  const some = [...counts].filter(([, c]) => c < short.length).map(([g, c]) => `${c} lack the ${g}`);
  const text = short.length === 1 ? `Unit economics incomplete on ${name(short[0])}` : `Unit economics incomplete on ${short.length === rows.length ? "every work" : `${short.length} of ${rows.length} works`}`;
  const sx = short.length === 1 ? "The paid ROI and the post to the PM read these per unit"
    : [all.length ? `${short.length === rows.length ? "All" : "Each"} lack${short.length === rows.length ? "" : "s"} ${all.join(", ")}` : "", ...some].filter(Boolean).join(" · ");
  return { key: "econ", icon: <Warn />, text, sx, action: <button className="sbtn" onClick={() => onOpen(short[0].key)} title={`Put ${short[0].name}'s figures in the side panel to type them`}>Open{short.length > 1 ? " the first" : ""}</button> };
}
const FrameIc = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#8a8a8e" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1" /><rect x="5" y="5" width="6" height="6" /></svg>;
export function AddWorkButton({ onClick }) {
  return <button className="ib" aria-label="Add a work" title="Add a work by hand" onClick={onClick}><Plus /></button>;
}
/* One launch of the basket: a dot in the artist's colour, the artist, the
 * title, then what it sold, its price and when it closed. Opens the launch's
 * own page where the index has one. */
export function BasketRow({ r, onOpen, extra }) {
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag className={`li${onOpen ? "" : " still"}`} onClick={onOpen || undefined} title={onOpen ? `${r.release_name} · opens its page` : r.release_name}>
      <span className="tdot" style={{ background: r.color }} /><span className="nm">{r.artist}</span>{r.title && r.title !== "Multiple" ? <span className="sub">{r.title}</span> : null}
      <span className="meta">
        <Loz tip={r.unitsTip}>{fmt(r.units)} sold</Loz>
        <Loz tip="Unit price">{r.price > 0 ? fmtMoney(r.price) : "–"}</Loz>
        {extra ? extra(r) : null}
        <Loz kind="ghost" icon={<Cal w={12} />} tip="When it closed">{fmtMonth(r.window_end)}</Loz>
      </span>
    </Tag>
  );
}
export function PickButton({ onClick }) {
  return <button className="ib" aria-label="Pick launches" title="Pick the launches on the map" onClick={onClick}><Scatter /></button>;
}
/* One date: the milestone's name, the other reading a feed has for it with
 * one click to take it, and the date itself, typed in place unless the
 * Notion log holds it. */
export function DateRow({ name, value, text, drift, onChange, time, tip, locked }) {
  return (
    <div className="li still" title={tip}>
      <Diamond /><span className="nm">{name}</span>
      <span className="meta">
        {drift && drift.map((d) => (
          <React.Fragment key={d.key}>
            <Loz kind="warm" tip={d.tip}>{d.text}</Loz>
            <button className="sbtn" onClick={d.use} title={`Take ${d.text.toLowerCase()}`}>Use</button>
          </React.Fragment>
        ))}
        {onChange && !locked
          ? <label className="loz dated" title="Click to type it"><Cal w={12} /><span className={text ? "" : "dim"}>{text || "Empty"}</span>
              <input type={time ? "datetime-local" : "date"} aria-label={name} value={value || ""} onChange={(e) => onChange(e.target.value)} />
            </label>
          : <Loz icon={<Cal w={12} />} tip={locked ? "From the Notion log" : undefined}>{text || "–"}</Loz>}
      </span>
    </div>
  );
}

/* ---------- the side panel's property rows ---------- */
export function Group({ children }) { return <div className="gh">{children}</div>; }
export function Prop({ label, children, htmlFor, tip }) {
  return <div className="pr" title={tip}>{htmlFor ? <label className="l" htmlFor={htmlFor}>{label}</label> : <span className="l">{label}</span>}{children}</div>;
}
/* A read-only value: an icon, the figure, a tag on the right. */
export function Val({ ic, children, tag, typed, tip, loz }) {
  return (
    <span className="val ro" title={tip}>
      {ic ? <span className="ic">{ic}</span> : null}
      {loz ? <Loz kind={loz}>{children}</Loz> : children}
      {tag ? <span className={`tag${typed ? " typed" : ""}`}>{tag}</span> : null}
    </span>
  );
}
/* A typed value: the glyph of its unit, the box, the source tag. The draft
 * is shown while it is typed ("5." on the way to "5.5"), the model's figure
 * once it is left. Blank clears it, so the default stands again. */
export function EditRow({ id, label, glyph, value, placeholder, onCommit, tag, typed, tip, text, disabled, right }) {
  const [draft, setDraft] = useState(null);
  return (
    <Prop label={label} htmlFor={id} tip={tip}>
      <span className={`val edit${disabled ? " dis" : ""}`}>
        {glyph ? <span className="ic">{glyph}</span> : null}
        <input id={id} className="q" inputMode={text ? undefined : "decimal"} value={draft !== null ? draft : (value ?? "")} placeholder={placeholder || "Empty"} disabled={disabled}
          onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value); }} onBlur={() => setDraft(null)}
          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
        {right || null}
        {tag ? <span className={`tag${typed ? " typed" : ""}`}>{tag}</span> : null}
      </span>
    </Prop>
  );
}
export function SwitchRow({ label, on, onChange, tip }) {
  return <Prop label={label} tip={tip}><span className="val"><Switch on={on} onChange={onChange} label={label} /></span></Prop>;
}
/* A person: a dot in their colour and their name, read from a feed (tag) or typed. */
export function PersonRow({ id, label, name, tag, typed, onChange, placeholder, tip, right }) {
  if (!onChange) {
    return (
      <Prop label={label} tip={tip}>
        <span className="chipb ro" title={tip}><span className="dot" style={{ background: name ? colorFor(name) : "transparent", border: name ? 0 : "1.2px dashed #a1a1aa" }} />{name || "Empty"}{right || null}{tag ? <span className="tag">{tag}</span> : null}</span>
      </Prop>
    );
  }
  return (
    <Prop label={label} htmlFor={id} tip={tip}>
      <span className="val edit">
        <span className="dot" style={{ background: name ? colorFor(name) : "transparent", border: name ? 0 : "1.2px dashed #a1a1aa" }} />
        <input id={id} className="q" value={name || ""} placeholder={placeholder || "Empty"} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
        {right || null}
        {tag ? <span className={`tag${typed ? " typed" : ""}`}>{tag}</span> : null}
      </span>
    </Prop>
  );
}
const AV_COLS = ["#b8461d", "#0f7052", "#5e6ad2", "#8a5f00", "#6d3fa8", "#1877f2", "#3a3a3c", "#c2185b"];
export function colorFor(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return AV_COLS[h % AV_COLS.length];
}

/* The Meta campaigns whose spend is this release's (etl/build.py
 * meta_campaigns): a tick list of the ones the spend feed names for the
 * campaign code and any added by name, each with its spend and a warning
 * where the feed has no rows for it or has not seen it lately, and a box to
 * add another by name. */
export function CampaignsProp({ code, chosen, all, suggested, onChange, asOf }) {
  const m = useMenu();
  const [adding, setAdding] = useState("");
  const byName = new Map((all || []).map((c) => [c.name, c]));
  const named = (all || []).filter((c) => code && c.name.startsWith(`${code} · `)).map((c) => c.name);
  const listed = [...new Set([...named, ...(suggested || []), ...chosen])];
  const toggle = (name, on) => onChange(on ? [...chosen, name] : chosen.filter((n) => n !== name));
  const add = () => { const name = adding.trim(); if (name && !chosen.includes(name)) onChange([...chosen, name]); setAdding(""); };
  const stale = (hit) => { if (!hit || !hit.last || !asOf) return false; return (Date.parse(asOf) - Date.parse(hit.last)) / 86400000 > 14; };
  const n = chosen.length;
  return (
    <Prop label="Campaigns" tip="Which Meta ad campaigns this release's paid actuals are read from: rows matching these names in the live spend feed, summed.">
      <span className="wrap">
        <button className="chipb" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}><Meta />{n === 0 ? "None ticked" : `${n} campaign${n === 1 ? "" : "s"}`}</button>
        <Menu open={m.open} onClose={m.close} style={{ top: 30, right: -8, left: "auto", width: 320, maxHeight: "none" }}>
          {listed.length === 0 && <div className="empty-note" style={{ padding: "8px 10px" }}>No campaign in the spend feed is named for {code ? `"${code}"` : "this release's code"} yet.</div>}
          {listed.map((name) => {
            const hit = byName.get(name), on = chosen.includes(name);
            const warn = !hit ? "No spend rows by this name" : !hit.spend ? "No spend yet" : stale(hit) ? `Last spend ${fmtDate(hit.last)}` : null;
            return (
              <button key={name} className="mrow tall" role="menuitemcheckbox" aria-checked={on} onClick={() => toggle(name, !on)} title={hit && hit.last ? `${fmtMoney(hit.spend)} · last ${fmtDate(hit.last)}` : undefined}>
                <span className={`box${on ? " on" : ""}`}>{on ? "✓" : ""}</span>
                <span className="col"><span>{name}</span>{warn && <Loz kind="warm">{warn}</Loz>}</span>
                <span className="r">{hit && hit.spend ? fmtMoney(hit.spend) : ""}</span>
              </button>
            );
          })}
          <div className="msep" />
          <label className="sr" htmlFor="addc">Add a campaign by name</label>
          <input id="addc" className="mfind" style={{ borderBottom: 0, margin: 0 }} list="meta-campaigns" value={adding} placeholder="Add a campaign by name" onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={add} />
          <datalist id="meta-campaigns">{(all || []).filter((c) => !chosen.includes(c.name)).map((c) => <option key={c.name} value={c.name} />)}</datalist>
        </Menu>
      </span>
    </Prop>
  );
}

/* ---------- the Note at the foot ---------- */
export function SaveNote({ note, onUndo, onClose }) {
  return <Note text={note ? note.text : null} onUndo={note && note.prev ? onUndo : undefined} onClose={onClose} />;
}

/* ---------- the basket's medians, live ---------- */
function quantile(values, q) {
  const v = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
export const median = (values) => quantile(values, 0.5);
const positive = (vals) => median(vals.filter((v) => typeof v === "number" && v > 0));
/* The preview profile of a set of the draw panel's rows, in the shape the
 * LE page reads (etl/baskets.py basket_profile without the curves). The
 * medians on the page are always the ETL's, recomputed when the basket is
 * saved; this is the shape of the answer, not the answer. The benchmark's
 * units are demand: what each launch would have sold with enough supply. */
export function liveProfile(rows) {
  const units = rows.map((r) => r.units), priced = rows.map((r) => r.price).filter((p) => p > 0);
  const demand = rows.map((r) => (r.demand > 0 ? r.demand : r.units));
  const total = median(demand), sessions = median(rows.map((r) => r.sessions));
  const shares = (key, fallback) => {
    const raw = Object.fromEntries(GROUPS.map((g) => [g, median(rows.map((r) => ((r[key] || r[fallback] || {})[g])))]));
    const tot = GROUPS.reduce((s, g) => s + raw[g], 0);
    return Object.fromEntries(GROUPS.map((g) => [g, tot > 0 ? raw[g] / tot : 0]));
  };
  const share_units = shares("demand_shares", "unit_shares"), share_sessions = shares("sess_shares");
  return {
    n: rows.length, members: rows.map((r) => r.release_name),
    units: total, units_sold: median(units), n_short: rows.filter((r) => r.sold_short).length,
    units_p25: quantile(demand, 0.25), units_p75: quantile(demand, 0.75),
    price: median(priced), price_p25: quantile(priced, 0.25), price_p75: quantile(priced, 0.75), n_priced: priced.length,
    sessions, entries: median(rows.map((r) => r.entries)), campaign_days: median(rows.map((r) => r.campaign_days)),
    units_per_buyer: positive(rows.map((r) => r.units_per_buyer)),
    cost_per_purchase: rows.filter((r) => r.cost_per_paid_unit > 0).length >= 3 ? positive(rows.map((r) => r.cost_per_paid_unit)) : 0,
    n_costed: rows.filter((r) => r.cost_per_paid_unit > 0).length,
    share_units, share_sessions,
    units_by_group: Object.fromEntries(GROUPS.map((g) => [g, share_units[g] * total])),
    sessions_by_group: Object.fromEntries(GROUPS.map((g) => [g, share_sessions[g] * sessions])),
    conv: Object.fromEntries(GROUPS.map((g) => [g, positive(rows.map((r) => (r.convs || {})[g]))])),
  };
}
/* The rows of the basket as the list and the map draw them: the panel's row
 * for each member name, coloured by artist. */
export function memberRows(names, cands) {
  const by = new Map((cands || []).map((r) => [r.release_name, r]));
  return (names || []).map((n) => by.get(n)).filter(Boolean).map((r) => ({ ...r, color: colorFor(r.artist) }));
}
/* The members of a basket spec, with the rule as the fallback: a bespoke
 * list as saved; a ready basket from the built page's member names, else the
 * rule over the candidates for this target and price. */
export function membersOf({ spec, built, rule }) {
  if (spec && spec.kind === "bespoke" && Array.isArray(spec.members)) return spec.members;
  if (built && built.length) return built;
  return rule || [];
}
export const useKey = (deps) => useMemo(() => deps.join("|"), deps);

/* ---------- the team: the Slack channel, the project manager, the lead ---------- */
/* The Slack channel the sell-through card posts to and the project manager
 * who confirms the unit economics: a small document of their own on the
 * server (server/slack.js), saved on its own a moment after they are typed,
 * so a release without targets can have a channel too. */
export function useSlackDoc(snap, onSaved) {
  const [channel, setChannel] = useState((snap.slack && snap.slack.channel) || "");
  const [pm, setPm] = useState((snap.slack && snap.slack.pm) || "");
  const [state, setState] = useState({ state: "idle" });
  useEffect(() => { setChannel((snap.slack && snap.slack.channel) || ""); setPm((snap.slack && snap.slack.pm) || ""); setState({ state: "idle" }); }, [snap.id]);
  const cur = (snap.slack && snap.slack.channel) || "", curPm = (snap.slack && snap.slack.pm) || "";
  const dirty = channel.trim().replace(/^#/, "") !== cur || pm.trim().replace(/^@/, "") !== curPm;
  useEffect(() => {
    if (!dirty) return undefined;
    const t = setTimeout(async () => {
      setState({ state: "saving" });
      try {
        const res = await fetch(`/api/releases/${snap.id}/slack-channel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, pm }) });
        const d = await res.json();
        if (!res.ok) { setState({ state: "failed", error: d.error || `save failed (${res.status})` }); return; }
        setState({ state: d.warning ? "warn" : "idle", error: d.warning || null });
        onSaved({ ...snap, slack: d.slack });
      } catch (e) { setState({ state: "failed", error: String(e) }); }
    }, 1200);
    return () => clearTimeout(t);
  }, [channel, pm, dirty]);
  return { channel, setChannel, pm, setPm, state, dirty };
}
/* "Send unit economics to PM" (the ⋯ menu): the unit economics as saved and
 * built, to the release's channel with the project manager mentioned
 * (server/slack.js composeEconomicsBlocks). The figures set the Paid ROI,
 * so the person who knows the deal is asked to check them where they will
 * see it. Returns the menu item. */
export function useEconomicsItem(snap, onSaved, { pmName, busy }) {
  const [post, setPost] = useState({ state: "idle" });
  useEffect(() => { setPost({ state: "idle" }); }, [snap.id]);
  const pmAirtable = snap.projectManager || null;
  const ready = !!(snap.slack && snap.slack.channel && (snap.slack.pm || (pmAirtable && pmAirtable.slackId)));
  const title = post.state === "error" ? `Not sent: ${post.message}`
    : !ready ? (!(snap.slack && snap.slack.channel) ? "Set the Slack channel under Team first."
      : pmAirtable && pmAirtable.name ? `Airtable names ${pmAirtable.name} as the project manager but has no PM Slack ID for them: type their member ID, @handle or email under Team.`
        : "No project manager: type one under Team.")
      : busy ? "Wait for the save: the message carries the figures as saved and built."
        : "Post the unit economics to the release's Slack channel and ask the project manager to confirm them: they set the Paid ROI.";
  const send = async () => {
    setPost({ state: "posting" });
    try {
      const r = await fetch(`/api/releases/${snap.id}/slack-economics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Slack post failed (${r.status})`);
      setPost({ state: "done", channel: d.channel, to: d.to });
      if (d.slack) onSaved({ ...snap, slack: d.slack });
      setTimeout(() => setPost((p) => (p.state === "done" ? { state: "idle" } : p)), 6000);
    } catch (e) { setPost({ state: "error", message: String(e.message || e) }); }
  };
  return {
    label: post.state === "posting" ? "Sending…" : post.state === "done" ? `Sent to #${post.channel}` : post.state === "error" ? "Not sent: try again" : "Send unit economics to PM",
    icon: <Send />, right: pmName ? String(pmName).split(" ")[0] : undefined, disabled: !ready || busy || post.state === "posting", title, onClick: send,
  };
}
/* The Team group: the marketing lead (the Notion log, then Airtable, then
 * typed), the project manager and the Slack channel. */
export function TeamGroup({ snap, sourced, inp, setInp, slack }) {
  const leadSourced = (sourced.notion || {}).marketing_lead ? { value: sourced.notion.marketing_lead, from: "Notion" }
    : (sourced.airtable || {}).marketing_lead ? { value: sourced.airtable.marketing_lead, from: "Airtable" } : null;
  const pmAirtable = snap.projectManager || null;
  const sent = snap.slack && snap.slack.lastEconomicsAt;
  return (
    <>
      <Group>Team</Group>
      {leadSourced
        ? <PersonRow label="Lead" name={leadSourced.value} tag={leadSourced.from} tip={`Who runs this launch, from ${leadSourced.from}`} />
        : <PersonRow id="t-lead" label="Lead" name={inp.marketing_lead || ""} tag={inp.marketing_lead ? "Typed" : ""} typed placeholder="Who runs this launch" tip="Who runs this launch. Not in the Notion log or Airtable yet: typed here until it is." onChange={(v) => setInp((prev) => ({ ...prev, marketing_lead: v }))} />}
      <PersonRow id="t-pm" label="PM" name={slack.pm} placeholder={pmAirtable && pmAirtable.name ? pmAirtable.name : "@handle, email or member ID"}
        tag={slack.pm.trim() ? "Typed" : pmAirtable && pmAirtable.slackId ? "Airtable" : pmAirtable && pmAirtable.name ? "no Slack ID" : ""} typed={!!slack.pm.trim()}
        tip="Who confirms the unit economics: Send unit economics to PM (the ⋯ menu) posts them to the channel and mentions this person. Airtable's Project Manager unless someone is typed here: a Slack member ID, @handle or email. Saved with the channel."
        right={sent ? <Loz kind="ghost" tip={`Economics sent for confirmation ${new Date(sent).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${snap.slack.lastEconomicsBy ? ` by ${snap.slack.lastEconomicsBy}` : ""}`}>sent</Loz> : null}
        onChange={slack.setPm} />
      <EditRow id="t-slack" label="Slack" glyph="#" text value={slack.channel} placeholder="launch-updates" tag={slack.state.state === "saving" ? "Saving…" : slack.state.state === "failed" ? "not saved" : snap.slack && snap.slack.lastPostAt ? "posted" : ""}
        tip="Where Post to Slack on the sell-through card sends this release's update: the channel name without the #. For a private channel, invite the Launch Performance bot first. Saved on its own." onCommit={slack.setChannel} />
    </>
  );
}
/* The title icon of the targets page. */
export const TitleIcon = () => <svg className="ticon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5e6ad2" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" fill="#5e6ad2" /></svg>;
export const BasketIcon = () => <span style={{ display: "inline-flex", color: "#6b6b6f" }}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6h11l-1.2 7.5h-8.6z" /><path d="M5.5 6l2.5-3.5L10.5 6" /></svg></span>;
