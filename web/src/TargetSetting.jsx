/* The targets page of a limited edition (docs/BENCHMARK_SPEC.md §8,
 * docs/DATA_MODEL.md §1.6), laid out as the design canvas's project page:
 * the title, three pills (the basket, the channels in plan, where the
 * stretch comes from), then the Works, the Basket's launches and the Dates
 * down the middle, and the figures that follow down the side - the outcome
 * (target, benchmark, stretch, launch value), the conversion and paid
 * assumptions with their source tags, the team. A work pressed in the list
 * puts its own figures in the side panel instead.
 *
 * Almost nothing here is typed. The works and their economics come from
 * Airtable, per work (edition, target sell-through, price, the artist's and
 * Avant Arte's profit per unit, the deal's shares, the framing); the dates
 * from the Notion log, then the funnel's own clock, then Airtable; the lead
 * from the Notion log, then Airtable. What a person decides is which basket
 * the release is measured against, which channels it will not run, where
 * the stretch comes from, which Meta campaigns are this release's, and any
 * figure typed over a feed's. Every change saves itself (TargetsKit.jsx
 * useAutosave) and the server rebuilds the page behind it, with the status
 * in the page header. The figures recompute live through
 * shared/economics.mjs and shared/benchmarkModel.mjs, the same code the
 * build runs, so the side says what the page will say.
 *
 * A release set up before the model went per product still carries its
 * release-level figures (legacy_economics); they stand in for its totals
 * until they are cleared here. A release selling lines of work on one page
 * (docs/LINES_PLAN.md) gets a Lines section, each line with its own basket,
 * stretch and ad sets. */
import React, { useEffect, useMemo, useState } from "react";
import { Loz } from "./ui.jsx";
import { fmt, fmtMoney, fmtPct } from "./format.mjs";
import { Bmk, Lines, Ring, Target, Trend, Undo, Wallet, Warn, X, Img } from "./icons.jsx";
import { nameOf } from "./rows.mjs";
import BasketPicker from "./BasketPicker.jsx";
import {
  AddWorkButton, BasketIcon, BasketPill, BasketRow, CampaignsProp, CH, ChannelsPill, DateRow, EditRow, Group, HeadStatus, PickButton,
  Prop, Section, Strip, StretchPill, SaveNote, SwitchRow, TeamGroup, TitleIcon, Val, WorkRow, cellText, clamp, economicsGaps, economicsStrip, fmtDate, liveProfile,
  memberRows, membersOf, norm, signed, useAutosave, useCandidates, useEconomicsItem, useIndexRows, useInputs, useSlackDoc, PCT,
} from "./TargetsKit.jsx";
import { resolveProducts, releaseEconomics, releaseLines, LEGACY_KEYS } from "../../shared/economics.mjs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf, profileOf, rebalanceShares, stretchWeights } from "../../shared/benchmarkModel.mjs";
import { similarMembers } from "../../shared/basketRule.mjs";
import "./targets.css";

const CANDIDATES_URL = "/api/baskets/candidates";
const typedKeys = (p) => Object.keys(p.sources || {}).filter((k) => k !== "currency" && k !== "line" && p.sources[k] === "typed");

/* Inputs saved under earlier shapes: the Referral Artist row of the retired
 * quality grid (N/A = the artist's own channels off), one Meta campaign, and
 * the release-level economics at the top level (kept as legacy_economics
 * until cleared). */
function normaliseLE(raw) {
  const legacyTier = (raw.channel_quality_overrides || {})["Referral Artist"];
  const topLegacy = {};
  for (const k of LEGACY_KEYS) if (raw[k] !== undefined && raw[k] !== null) topLegacy[k] = raw[k];
  // the figures that can be cleared ride as null when absent, so a clearing
  // (and an undo) reaches the server, which keeps a key it is not sent
  const start = { entry_conversion_rate: null, preorder_conversion_rate: null, cost_per_purchase: null, cannibalisation: null, stretch_from: null, marketing_lead: null, campaign_code: "", prefer_recent: true, ...raw };
  for (const k of LEGACY_KEYS) delete start[k];
  Object.assign(start, {
    channels_off: raw.channels_off || (legacyTier === "N/A" ? ["referral_artist"] : []),
    campaign_names: Array.isArray(raw.campaign_names) ? raw.campaign_names : (raw.campaign_name ? [raw.campaign_name] : []),
    products: Array.isArray(raw.products) ? raw.products : [],
    legacy_economics: raw.legacy_economics !== undefined ? raw.legacy_economics : (Object.keys(topLegacy).length ? topLegacy : null),
  });
  delete start.campaign_name;
  return start;
}

/* The figure rows of one work in the side panel: the key, the label, the
 * glyph of its unit. */
const WORK_ROWS = [
  { key: "edition", label: "Edition", glyph: "№", tip: "Units in the edition of this work." },
  { key: "target_sellthrough", label: "Sell-through", glyph: "%", tip: "The share of the edition targeted to sell by close. Blank = Airtable's target (its units target over the edition, else the expected sell-through), else 100%." },
  { key: "unit_price", label: "Price", glyph: "€", tip: "Retail price per unit. Airtable prices in euros, the page's currency; a product in another currency is converted at a fixed rate." },
  { key: "artist_profit_per_unit", label: "Artist profit", glyph: "€", tip: "The artist's profit on one unit sold." },
  { key: "aa_profit_per_unit", label: "AA profit", glyph: "€", tip: "Avant Arte's group profit on one unit sold, before framing." },
  { key: "artist_revenue_cut", label: "Artist revenue cut", glyph: "%", tip: "The artist's or estate's commission on revenue, taken before any profit is split (Airtable's Revenue Commission %)." },
  { key: "aa_profit_share", label: "Profit share", glyph: "%", tip: "Avant Arte's own share of the profit on a profit-share deal, which is also its share of the paid budget. Closed while the product has an AA revenue share." },
  { key: "aa_revenue_share", label: "Revenue share", glyph: "%", tip: "Avant Arte's own share of revenue on a royalty deal, where Avant Arte carries the ads outright. Closed while the product has an AA profit share." },
];
const FRAME_ROWS = [
  { key: "frame_price", label: "Frame price", glyph: "€", tip: "The price of the cheapest frame offered on this work (Airtable's Frame products). It sets the band the default frames per print is read from." },
  { key: "frame_conversion", label: "Frame take-up", glyph: "%", tip: "The share of buyers expected to take a frame. Blank = the default: the share of paid prints that took a frame over the last twelve months' launches, in the band of the frame's price against the print's." },
  { key: "frame_profit_per_unit", label: "Frame profit", glyph: "€", tip: "Avant Arte's profit on each frame sold, which is Avant Arte's alone. There is no default: blank counts no framing profit." },
];
const closedFor = (p, key) => {
  if (key === "aa_revenue_share") return p.aa_profit_share !== null && p.aa_revenue_share === null;
  if (key === "aa_profit_share") return p.aa_revenue_share !== null && p.aa_profit_share === null;
  return false;
};
const SRC_WORD = { typed: "Typed", airtable: "Airtable", default: "Default" };

export default function TargetSetting({ snap, onSaved, directSpread = false, route, setRoute }) {
  const { meta, setMeta, inp, setInp, error } = useInputs(snap.id, normaliseLE);
  const { rows: cands } = useCandidates(CANDIDATES_URL);
  const index = useIndexRows();
  const [sel, setSel] = useState(null);             // the work whose figures the side shows (its row key)
  const [selLine, setSelLine] = useState(null);     // the line whose settings the side shows
  const [pickingLine, setPickingLine] = useState(null);   // the line the picker is open for
  const [pick, setPick] = useState(null);           // a basket chosen in the picker, until the rebuild carries it
  const [linePicks, setLinePicks] = useState({});
  const [hidden, setHidden] = useState({});         // strips dismissed this visit
  const slack = useSlackDoc(snap, onSaved);
  useEffect(() => { setSel(null); setSelLine(null); setPickingLine(null); setPick(null); setLinePicks({}); setHidden({}); }, [snap.id]);
  useEffect(() => { if (!route.basket) setPickingLine(null); }, [route.basket]);

  const b = meta ? meta.benchmarks : null;
  const sourced = (meta && meta.sourced) || { airtable: { match: "none", note: "", products: [] }, notion: {}, clock: {}, campaigns: [] };
  const atProducts = (sourced.airtable && sourced.airtable.products) || [];
  // the products in force and the release's economics, live as figures are
  // typed (shared/economics.mjs mirrors resolve_release in the build)
  const products = useMemo(() => (inp && b ? resolveProducts(atProducts, inp.products, b) : []), [inp, b, atProducts]);
  const econ = useMemo(() => (inp && b ? releaseEconomics(products, inp.legacy_economics, b) : null), [products, inp, b]);
  const lines = useMemo(() => (inp && b && econ && econ.mode === "products" ? releaseLines(products, inp.line_settings, b) : []), [products, inp, b, econ]);
  const ready = !!(inp && econ);

  /* ---- the dates, by source: the Notion log, then what was typed, then the
   * funnel's clock, then Airtable (resolve_release reads them the same way) */
  const dateOf = (f) => {
    if (!inp) return [null, null];
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

  // what the targets still need before they can be saved
  const missing = [];
  if (econ && !(econ.edition_size > 0)) missing.push("a work with an edition");
  if (econ && econ.edition_size > 0 && !(econ.launch_value > 0)) missing.push("a unit price");
  if (ready && !announce) missing.push("the announce date");
  if (ready && !closes) missing.push("the close");

  const off = inp ? channelsOffOf(inp) : [];
  const auto = useAutosave({
    id: snap.id, inp, setInp, meta, setMeta, missing,
    // legacy_economics rides only as a clearing (null): the figures themselves
    // are never re-sent, the server keeps or drops the block
    // a date not known yet is left out: the server keeps what it holds and takes only a day it can read
    body: (cur) => { const { legacy_economics, campaign_name, ...rest } = cur; for (const f of ["private_room_open", "announce_date", "launch_end"]) if (!rest[f]) delete rest[f]; return { ...rest, channels_off: channelsOffOf(cur), ...(legacy_economics === null ? { legacy_economics: null } : {}) }; },
    onSaved: (s) => { setPick(null); setLinePicks({}); onSaved(s); },
  });
  // the ⋯ menu's "Send unit economics to PM" (hooks before the early returns)
  const pmAirtable = snap.projectManager || null;
  const econItem = useEconomicsItem(snap, onSaved, { pmName: slack.pm.trim() || (pmAirtable && pmAirtable.name) || "", busy: auto.dirty || auto.status.state !== "idle" });

  /* ---- the basket: the one the picker chose, else the built page's, else
   * the rule's suggestion over the candidates (the empty state's basket) */
  const bm = snap.benchmark || null;
  const spec = inp ? inp.benchmark_basket || null : null;
  const editionSize = econ ? econ.edition_size || 0 : 0;
  const L = useMemo(() => ({
    name: snap.releaseName, artist: snap.artist || "", target: editionSize, price: econ ? econ.unit_price || 0 : 0, currency: "EUR",
    private_room_open: prOpen || null, announce_date: announce || null, launch_end: closes || null,
  }), [snap.releaseName, snap.artist, editionSize, econ && econ.unit_price, prOpen, announce, closes]);
  const rule = useMemo(() => (cands && editionSize > 0 ? similarMembers(cands, L, { preferRecent: !inp || inp.prefer_recent !== false, asOf: snap.asOf || null }) : null), [cands, L, inp && inp.prefer_recent, snap.asOf]);
  const builtMembers = (bm && bm.basket && Array.isArray(bm.basket.members) && bm.basket.members) || (bm && Array.isArray(bm.members) ? bm.members.map((m) => m.name || m.release_name) : null);
  const memberNames = pick ? pick.members : membersOf({ spec, built: builtMembers, rule: rule ? rule.members : [] });
  const members = useMemo(() => memberRows(memberNames, cands), [memberNames.join("|"), cands]);
  // the basket has no name: the pill says how many launches, and whether the suggestion was edited
  const basketEdited = pick ? pick.kind === "bespoke" : !!(spec && spec.kind === "bespoke");
  // the basket's profile: the pick's preview, else the page's medians read
  // without the channels set aside, else a preview of the suggestion
  const prof = pick && pick.profile ? pick.profile : bm ? profileOf(bm) : members.length ? liveProfile(members) : null;
  const profile = prof ? applyChannelsOff(prof, off) : null;
  const bmUnits = profile && profile.units > 0 ? profile.units : null;
  const k = bmUnits && editionSize > 0 ? editionSize / bmUnits : null;

  if (error && !meta) return <div className="tgap">Failed to load the inputs: {error}</div>;
  if (!ready) return <div className="tgap">Loading…</div>;

  const dv = meta.derived || {};
  const isOff = (g) => off.includes(g);
  const setOff = (g, on) => setInp({ ...inp, channels_off: on ? [...off, g] : off.filter((x) => x !== g) });
  const paidOff = isOff("paid");
  const stretchFrom = inp.stretch_from && typeof inp.stretch_from === "object" && !Array.isArray(inp.stretch_from) ? inp.stretch_from : null;
  const stretchTyped = !!(stretchFrom && CH.some((g) => !isOff(g.key) && Number(stretchFrom[g.key]) > 0));
  const basketCpp = profile && Number(profile.cost_per_purchase) > 0 ? Number(profile.cost_per_purchase) : 0;
  const panelCpp = Number((b.cost_per_purchase || {}).Median) || 0;
  const cpp = Number(inp.cost_per_purchase) > 0 ? Number(inp.cost_per_purchase) : basketCpp > 0 ? basketCpp : panelCpp;
  const partialEdition = econ.edition_total > econ.edition_size && econ.edition_size > 0;
  const T = profile ? benchmarkTargets(profile, {
    edition_size: editionSize, unit_price: econ.unit_price || 0, cost_per_purchase: cpp,
    units_per_buyer: (snap.targets || {}).units_per_buyer || 0, entry_conversion_rate: inp.entry_conversion_rate, stretch_from: stretchFrom,
  }, b) : null;
  const activeGroups = profile ? CH.map((g) => g.key).filter((g) => !isOff(g) && Number((profile.units_by_group || {})[g]) > 0) : [];
  const evenShares = profile ? stretchWeights({ stretch_from: null }, profile.units_by_group) : {};
  const shares = T && T.stretch_from ? T.stretch_from : evenShares;
  const stretchMode = !stretchTyped ? "even" : Number(stretchFrom.paid || 0) >= 0.995 ? "paid" : "custom";
  const onStretchMode = (m) => {
    if (m === "even") setInp({ ...inp, stretch_from: null });
    else if (m === "paid") setInp({ ...inp, stretch_from: { paid: 1 } });
    else if (!stretchTyped) setInp({ ...inp, stretch_from: { ...evenShares } });
  };
  const stretchOf = (key) => (T && T.units_by_group ? Number(T.units_by_group[key] || 0) - Number((profile.units_by_group || {})[key] || 0) : 0);

  /* ---- the products: a typed figure lands on the entry for that product
   * (by Airtable id, or by name for one added by hand); blank takes the key
   * off the entry so Airtable's figure, or the default, stands again */
  const rowKey = (p, i) => (p.airtable_id ? `a-${p.airtable_id}` : `m-${i}`);
  const sameEntry = (t, p) => (p.airtable_id ? String(t.airtable_id) === String(p.airtable_id) : (t.manual && norm(t.name) === norm(p.name)));
  const bare = (t) => Object.entries(t).every(([kk, v]) => kk === "airtable_id" || kk === "manual" || (kk === "name" && !t.manual) || v === null || v === undefined || v === "");
  const applyEntry = (list, p, patch) => {
    const out = [...list];
    let i = out.findIndex((t) => sameEntry(t, p));
    if (i < 0) { out.push(p.airtable_id ? { airtable_id: p.airtable_id } : { manual: true, name: p.name }); i = out.length - 1; }
    const next = { ...out[i] };
    for (const [kk, v] of Object.entries(patch)) { if (v === undefined) delete next[kk]; else next[kk] = v; }
    out[i] = next;
    return out.filter((t) => !(t.airtable_id && bare(t)));
  };
  const parseField = (key, raw) => {
    if (key === "framing_available") return !!raw;
    if (key === "line" || key === "name") { const t = String(raw ?? "").trim(); return t === "" ? null : t.slice(0, 80); }
    const clean = String(raw).replace(/[^0-9.]/g, "");
    if (clean === "") return null;
    let v = parseFloat(clean);
    if (!Number.isFinite(v)) return undefined;
    if (PCT.has(key)) v = clamp(v, 0, 100) / 100;
    if (key === "edition") v = Math.round(v);
    return v;
  };
  // the deal is one or the other: a revenue share typed clears a profit share, and the other way round
  const patchFor = (p, key, v) => {
    const patch = { [key]: v === null && p.airtable_id ? undefined : v };
    if (key === "aa_revenue_share" && v !== null) patch.aa_profit_share = undefined;
    if (key === "aa_profit_share" && v !== null) patch.aa_revenue_share = undefined;
    return patch;
  };
  const onField = (p, key, raw) => {
    const v = parseField(key, raw);
    if (v === undefined) return;
    setInp((prev) => ({ ...prev, products: applyEntry(prev.products || [], p, patchFor(p, key, v)) }));
  };
  const onName = (p, name) => setInp((prev) => ({ ...prev, products: (prev.products || []).map((t) => (t.manual && norm(t.name) === norm(p.name) ? { ...t, name } : t)) }));
  const onAdd = () => {
    const n = (inp.products || []).filter((t) => t.manual).length + 1;
    setInp({ ...inp, products: [...(inp.products || []), { manual: true, name: `Work ${n}` }] });
    setSel(`m-${products.length}`); setSelLine(null);
  };
  const onRemove = (p) => { setInp({ ...inp, products: (inp.products || []).filter((t) => !(t.manual && norm(t.name) === norm(p.name))) }); setSel(null); };
  const onInclude = (p, on) => setInp((prev) => {
    const list = prev.products || [];
    if (!on) return { ...prev, products: applyEntry(list, p, { excluded: true }) };
    return { ...prev, products: applyEntry(list, p, { excluded: undefined }) };
  });
  const onReset = (p) => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => ((p.airtable_id && String(t.airtable_id) === String(p.airtable_id)) ? (t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : []) : [t])) }));
  const onResetAll = () => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => (!t.airtable_id ? [t] : t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : [])) }));
  const typedCount = products.filter((p) => p.airtable_id).reduce((s, p) => s + typedKeys(p).length, 0);
  // the picker asks for a target and a price when there are none: they land
  // on a work added by hand, so the basket follows the typing; its paid
  // toggle is the channels-in-plan setting
  const onPickerInputs = (patch) => setInp((prev) => {
    const next = { ...prev };
    if (patch.channels_off !== undefined) next.channels_off = patch.channels_off;
    if (patch.prefer_recent !== undefined) next.prefer_recent = patch.prefer_recent;
    if (patch.edition_size !== undefined || patch.unit_price !== undefined) {
      const name = "Release";
      const list = prev.products || [];
      const entry = { ...(list.find((t) => t.manual && norm(t.name) === norm(name)) || { manual: true, name }) };
      if (patch.edition_size !== undefined) entry.edition = patch.edition_size || null;
      if (patch.unit_price !== undefined) { entry.unit_price = patch.unit_price || null; entry.currency = "EUR"; }
      next.products = [...list.filter((t) => !(t.manual && norm(t.name) === norm(name))), entry];
    }
    return next;
  });
  const basketSpecOf = (chosen) => (chosen.kind === "bespoke" ? { kind: "bespoke", members: chosen.members } : { kind: chosen.kind, id: chosen.id });
  const onPick = (chosen) => {
    setPick(chosen);
    // the picker's recency switch is a release input: the rule reads it on every rebuild
    setInp({ ...inp, benchmark_basket: basketSpecOf(chosen), prefer_recent: chosen.preferRecent !== false });
    setRoute({ ...route, basket: false });
  };
  const setLine = (key, patch) => setInp((prev) => ({ ...prev, line_settings: { ...(prev.line_settings || {}), [key]: { ...((prev.line_settings || {})[key] || {}), ...patch } } }));
  const onPickLine = (key) => (chosen) => {
    setLinePicks((prev) => ({ ...prev, [key]: chosen }));
    setLine(key, { benchmark_basket: basketSpecOf(chosen) });
    setInp((prev) => ({ ...prev, prefer_recent: chosen.preferRecent !== false }));
    setRoute({ ...route, basket: false });
  };

  /* ---- a date another source puts elsewhere than the one in force: a
   * lozenge beside it with the other reading, one click to take it */
  const driftOf = (f, value, src) => Object.entries({ airtable: (sourced.airtable || {})[f], clock: (sourced.clock || {})[f] })
    .filter(([name, d]) => d && d !== value && name !== src)
    .map(([name, d]) => ({ key: name, text: `${name === "airtable" ? "Airtable" : "Funnel"} says ${fmtDate(d)}`, tip: name === "airtable" ? "The date Airtable holds" : "The funnel export's campaign clock", use: () => setInp({ ...inp, [f]: d }) }));
  const dateRow = (name, f, value, src, tip) => (
    <DateRow key={f} name={name} value={value ? String(value).slice(0, 10) : ""} text={fmtDate(value)} locked={src === "notion"} drift={src === "notion" ? [] : driftOf(f, value, src)}
      tip={`${tip}${src ? ` Now: ${src === "notion" ? "the Notion log" : src === "typed" ? "typed here" : src === "clock" ? "the funnel's clock" : "Airtable"}.` : ""}`}
      onChange={(v) => setInp({ ...inp, [f]: v || null })} />
  );
  const codeInForce = inp.campaign_code || (inp.campaign_names[0] ? inp.campaign_names[0].split(" · ")[0] : "") || dv.campaign_code || "";

  const headMenu = [
    econItem,
    { label: "Reset to Airtable's figures", icon: <Undo />, disabled: typedCount === 0, title: typedCount ? `Drop every typed figure (${typedCount}): back to Airtable's on every work.` : "No figure is typed over Airtable's.", onClick: onResetAll },
  ];

  /* ---- what the page says under the header, when something needs saying */
  const strips = [];
  if (meta.storage && meta.storage.durable === false) strips.push({ key: "storage", icon: <Warn />, text: "Targets saved here do not survive a deploy", sx: `Point SAVED_INPUTS_PATH at a persistent disk (README). Saves go to ${meta.storage.path}` });
  if (missing.length) strips.push({ key: "missing", icon: <Ring />, text: `Not saved yet: needs ${missing.join(", ")}`, sx: snap.upcoming && dv.dates_note ? dv.dates_note : "Saves itself once they are set" });
  else if (meta.creating && !auto.dirty) strips.push({ key: "creating", icon: <Ring />, text: snap.upcoming ? "Upcoming launch, not in the funnel yet" : "No targets yet", sx: snap.upcoming ? (dv.dates_note || "Check the dates, the campaigns and the basket") : "The page shows actuals only; the first change here sets them up" });
  const legacy = inp.legacy_economics;
  if (legacy) strips.push({ key: "legacy", icon: <Ring />, text: `Release-level figures still in force: ${fmt(legacy.edition_size)} units at ${fmtMoney(legacy.unit_price || 0, 0)}`, sx: `artist ${fmtMoney((legacy.artist_profit || 0) / (legacy.edition_size || 1), 0)} and AA ${fmtMoney((legacy.aa_group_profit || 0) / (legacy.edition_size || 1), 0)} per unit`,
    action: <button className="sbtn" onClick={() => setInp({ ...inp, legacy_economics: null })} title="Drop the release-level figures: the works' figures carry the totals from the next save.">Use the works' figures</button> });
  const stEd = snap.sellthrough || {};
  if (stEd.editionMismatch && Number.isFinite(stEd.editionSum) && Number.isFinite(stEd.edition)) strips.push({ key: "edition", icon: <Warn />, text: `The works' editions add up to ${fmt(stEd.editionSum)}; the release's edition is ${fmt(stEd.edition)}`, sx: "One of the two is wrong" });
  const ut = snap.untracked || null;
  for (const key of (ut && Array.isArray(ut.high) ? ut.high : [])) {
    if (!ut[key] || ut[key].share === null) continue;
    const n = (ut.normal || {})[key] || {};
    strips.push({ key: `ut-${key}`, icon: <Warn />, text: `Untracked is ${fmtPct(ut[key].share, 0)} of this release's ${key}, against ${fmtPct(n.median, 0)} on a typical launch`, sx: `Spread over the tracked channels in proportion; the panel's 90th percentile is ${fmtPct(n.p90, 0)}` });
  }
  if (slack.state.state === "failed" || slack.state.state === "warn") strips.push({ key: "slack", icon: <Warn />, text: slack.state.state === "failed" ? "The Slack channel was not saved" : "Slack channel saved, but not for long", sx: slack.state.error });

  /* ---- the lines of work (docs/LINES_PLAN.md) ---- */
  const lineRows = lines.map((ln) => {
    const settings = ((inp.line_settings || {})[ln.key]) || {};
    const built = snap.variants && snap.variants.lines && snap.variants.lines[ln.key] ? snap.variants.lines[ln.key] : null;
    const lbm = built && built.benchmark ? built.benchmark : null;
    const picked = linePicks[ln.key] || null;
    const lprof = picked && picked.profile ? applyChannelsOff(picked.profile, off) : lbm ? applyChannelsOff(profileOf(lbm), off) : null;
    const lcpp = Number(inp.cost_per_purchase) > 0 ? Number(inp.cost_per_purchase) : lprof && Number(lprof.cost_per_purchase) > 0 ? Number(lprof.cost_per_purchase) : panelCpp;
    const lT = lprof && lprof.units > 0 ? benchmarkTargets(lprof, { edition_size: ln.edition_size, unit_price: ln.unit_price || 0, cost_per_purchase: lcpp, units_per_buyer: 0, entry_conversion_rate: inp.entry_conversion_rate, stretch_from: settings.stretch_from || null }, b) : null;
    const summary = (snap.lines || []).find((x) => x.key === ln.key) || null;
    const edited = picked ? picked.kind === "bespoke" : !!(settings.benchmark_basket && settings.benchmark_basket.kind === "bespoke");
    const n = picked ? (picked.members || []).length : lbm && lbm.basket ? lbm.basket.n : null;
    return { line: ln, settings, profile: lprof, T: lT, k: lprof && lprof.units > 0 ? ln.edition_size / lprof.units : null, basketEdited: edited, basketN: n, summary, cpp: lcpp };
  });
  const knownAdsets = (meta.meta_campaigns || []).filter((c) => (inp.campaign_names || []).includes(c.name)).flatMap((c) => (c.adsets || []).map((a) => ({ ...a, campaign: c.name })));
  const pickingRow = pickingLine ? lineRows.find((r) => r.line.key === pickingLine) : null;

  /* ---- the picker page ---- */
  if (route.basket) {
    return (
      <>
        <HeadStatus status={auto.status} onRetry={auto.retry} />
        <BasketPicker kind="le" rows={cands} releaseName={snap.releaseName} artist={snap.artist || ""} badge={snap.type}
          current={pickingRow ? (pickingRow.settings.benchmark_basket || null) : spec} currentMembers={pickingRow ? null : memberNames}
          targetUnits={pickingRow ? pickingRow.line.edition_size : editionSize} unitPrice={pickingRow ? (pickingRow.line.unit_price || 0) : (econ.unit_price || 0)}
          preferRecent={inp.prefer_recent !== false} channelsOff={off} announceDate={announce || null} privateRoomOpen={prOpen || null} launchEnd={closes || null} asOf={snap.asOf || null}
          onInputs={pickingRow ? (patch) => { if (patch.channels_off !== undefined || patch.prefer_recent !== undefined) onPickerInputs(patch); } : onPickerInputs}
          onPick={pickingRow ? onPickLine(pickingRow.line.key) : onPick} onBack={() => setRoute({ ...route, basket: false })} />
        <SaveNote note={auto.note} onUndo={auto.undo} onClose={auto.dismiss} />
      </>
    );
  }

  /* ---- the page ---- */
  const { artist, work } = nameOf({ releaseName: snap.releaseName, artist: snap.artist, title: snap.title });
  const title = `${work && work !== "Multiple" ? work : artist} targets`;
  const workRows = products.map((p, i) => ({ key: rowKey(p, i), name: p.name || "unnamed", target: p.edition ? p.target_units : null, edition: p.edition, price: p.unit_price_eur, framed: p.framing_available, excluded: p.excluded, manual: !p.airtable_id, over: false,
    // the works' figures carry nothing while the release-level ones are in force: nothing is missing from them yet
    gaps: inp.legacy_economics ? [] : economicsGaps(p), tip: p.edition ? `Target ${fmt(p.target_units)} of the edition of ${fmt(p.edition)}: ${Math.round(100 * p.target_sellthrough)}% sell-through` : "No edition yet" }));
  // a work whose unit economics are incomplete: the figures the paid ROI reads per unit
  { const es = economicsStrip(workRows, (key) => { setSel(key); setSelLine(null); }); if (es) strips.push(es); }
  const selP = sel !== null ? products.find((p, i) => rowKey(p, i) === sel) : null;
  const selLineRow = selLine ? lineRows.find((r) => r.line.key === selLine) : null;
  const openRelease = (name) => { const r = index.find((x) => x.releaseName === name); return r ? () => setRoute({ view: "release", id: r.id, tab: "overview", basket: false }) : null; };
  const stretchUnits = T ? Math.round(T.stretch_units) : null;
  const sense = T && T.paid ? T.paid.sense_check_breached : false;
  const asPct = (v) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 100)));
  const cannDefault = Math.round(100 * (Number(b.cannibalisation) || 0.2));
  const e2oDefault = Math.round(100 * (Number(b.eligible_entry_to_order) || 0.8));
  const numCommit = (key, lo, hi, scale) => (raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), lo, hi); setInp((prev) => ({ ...prev, [key]: v === null || Number.isNaN(v) ? null : (scale ? v / scale : c) })); };

  // one work's figure as the side shows it: the figure in force, tagged with its source
  const workField = (p, r) => {
    if (closedFor(p, r.key)) return <Prop key={r.key} label={r.label} tip={r.key === "aa_revenue_share" ? "Closed: this work has an AA profit share." : "Closed: this work has an AA revenue share."}><span className="val ro"><span className="ic">{r.glyph}</span><span className="dim">–</span></span></Prop>;
    const src = p.sources[r.key] || (r.key === "frame_conversion" ? "default" : null);
    return <EditRow key={r.key} id={`w-${r.key}`} label={r.label} glyph={r.glyph} value={cellText(r.key, p[r.key])} placeholder="Empty" tag={src ? SRC_WORD[src] : ""} typed={src === "typed"} tip={r.tip} onCommit={(raw) => onField(p, r.key, raw)} />;
  };

  return (
    <>
      <HeadStatus status={auto.status} onRetry={auto.retry} menu={headMenu} />
      {strips.filter((s) => !hidden[s.key]).map((s) => <Strip key={s.key} icon={s.icon} text={s.text} sx={s.sx} action={s.action} onDismiss={() => setHidden({ ...hidden, [s.key]: true })} />)}
      <div className="split">
        <div className="tmain">
          <div className="tcol">
            <TitleIcon />
            <h1>{title}</h1>
            <div className="tpills">
              <BasketPill n={members.length || (bm && bm.basket ? bm.basket.n : 0)} edited={basketEdited} onClick={() => { setPickingLine(null); setRoute({ ...route, basket: true }); }} />
              <ChannelsPill off={off} setOff={setOff} />
              {!lineRows.length && <StretchPill mode={stretchMode} onMode={onStretchMode} shares={shares} active={activeGroups} paidOff={paidOff} disabled={!profile}
                onSlide={(key, v) => setInp({ ...inp, stretch_from: rebalanceShares(shares, key, v, activeGroups) })} stretchOf={stretchOf} />}
            </div>

            <Section title="Works" count={products.length} action={<AddWorkButton onClick={onAdd} />}>
              {workRows.map((w) => <WorkRow key={w.key} w={w} on={sel === w.key} onPick={() => { setSel(sel === w.key ? null : w.key); setSelLine(null); }} />)}
              {!products.length && <div className="empty-note">No works yet: Airtable has no record matched to this release{(sourced.airtable || {}).note ? ` (${sourced.airtable.note})` : ""}. Add one by hand with the plus.</div>}
            </Section>

            {lineRows.length > 0 && (
              <Section title="Lines" count={lineRows.length} aria="Lines of work">
                {lineRows.map((r) => (
                  <button key={r.line.key} className={`li${selLine === r.line.key ? " on" : ""}`} aria-pressed={selLine === r.line.key} onClick={() => { setSelLine(selLine === r.line.key ? null : r.line.key); setSel(null); }} title={r.line.productNames.join(", ")}>
                    <Lines /><span className="nm">{r.settings.name || r.line.name}</span><span className="sub">{r.line.productNames.length} work{r.line.productNames.length === 1 ? "" : "s"}</span>
                    <span className="meta">
                      <Loz tip="Its target">{fmt(r.line.edition_size)} units</Loz>
                      <Loz kind="ghost" tip={r.basketEdited ? "Its basket, edited from the suggestion" : "Its basket, the suggested launches"}>{r.basketN ? `${r.basketN} launches` : "Basket"}{r.basketEdited ? " · edited" : ""}</Loz>
                      {r.k && <Loz kind="ind" tip="Its uplift over its basket's median">×{fmt(r.k, 2)}</Loz>}
                    </span>
                  </button>
                ))}
              </Section>
            )}

            <Section title="Basket" icon={<BasketIcon />}
              count={members.length} aria="Basket"
              lozes={bmUnits ? <Loz kind="ind" tip={`The basket's median units of demand, the channels not in plan set aside: the benchmark${k ? `, ×${fmt(k, 2)} to the target` : ""}`}>{fmt(Math.round(bmUnits * 10) / 10, bmUnits < 100 ? 1 : 0)} units</Loz> : null}
              action={<PickButton onClick={() => { setPickingLine(null); setRoute({ ...route, basket: true }); }} />}>
              {members.slice().sort((x, y) => (y.units || 0) - (x.units || 0)).map((r) => <BasketRow key={r.release_name} r={{ ...r, unitsTip: r.sold_short && r.demand > r.units ? `Sold ${fmt(r.units)}; it sold out with more wanted, so the benchmark counts its demand of ${fmt(r.demand)}` : "Units it sold in its window" }} onOpen={openRelease(r.release_name)} />)}
              {!members.length && <div className="empty-note">{editionSize > 0 ? (cands ? "No launches on file near this target and price yet." : "Finding the nearest launches…") : "A target and a price are needed before there is anything to be near to: add a work, or type them in the picker."}</div>}
            </Section>

            <Section title="Dates" count={3}>
              {dateRow("Private room", "private_room_open", prOpen, prSrc, "The day of the early-access email, from the Notion log. Until the log has it: what is typed, else two weeks before the announce.")}
              {dateRow("Announce", "announce_date", announce, annSrc, "From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable.")}
              {dateRow("Close", "launch_end", closes, closeSrc, "The day the draw closes and sales open. From the Notion log; else what is typed, else the funnel export's campaign clock, else Airtable. Works closing on different days: the page runs to the last.")}
            </Section>
          </div>
        </div>

        <aside className="side" aria-label="Details">
          {selP ? (
            <div>
              <div className="whead"><span className="img" style={{ color: "#6b6b6f", display: "inline-flex" }}><Img /></span><span className="nm">{selP.name || "unnamed"}</span><button className="ib" aria-label="Close the work" onClick={() => setSel(null)}><X /></button></div>
              <Group>Work</Group>
              {!selP.airtable_id && <EditRow id="w-name" label="Name" text value={selP.name || ""} placeholder="Name of the work" tag="by hand" onCommit={(raw) => onName(selP, raw)} />}
              <EditRow id="w-line" label="Line" text value={selP.line_typed ? selP.line : ""} placeholder={selP.line || "One release"} tag={selP.line_typed ? "Typed" : selP.line ? "Airtable" : ""} typed={selP.line_typed}
                tip="The line of work this product sells on, for a release selling two kinds of edition on one page. Two names split the release into lines, each benchmarked and targeted on its own." onCommit={(raw) => onField(selP, "line", raw)} />
              {WORK_ROWS.map((r) => workField(selP, r))}
              <Group>Framing</Group>
              <SwitchRow label="Offered" on={!!selP.framing_available} onChange={(on) => onField(selP, "framing_available", on)} tip={selP.sources.framing_available === "default" ? "Airtable's Framing is blank: a sculpture edition defaults to no frame, a print to one" : "Whether a frame is offered on this work"} />
              {selP.framing_available && FRAME_ROWS.map((r) => workField(selP, r))}
              <Group>Release</Group>
              {selP.airtable_id && <SwitchRow label="In the release" on={!selP.excluded} onChange={(on) => onInclude(selP, on)} tip="Untick to leave this work out of the release: it stays listed, greyed, and counts nothing." />}
              <div className="acts">
                {selP.airtable_id && typedKeys(selP).length > 0 && <button className="sbtn" onClick={() => onReset(selP)} title={`Back to Airtable's figures on this work (${typedKeys(selP).length} typed)`}><Undo />Reset to Airtable</button>}
                {!selP.airtable_id && <button className="sbtn" onClick={() => onRemove(selP)} title="Take this work off the release"><X />Remove</button>}
              </div>
            </div>
          ) : selLineRow ? (
            <div>
              <div className="whead"><Lines /><span className="nm">{selLineRow.settings.name || selLineRow.line.name}</span><button className="ib" aria-label="Close the line" onClick={() => setSelLine(null)}><X /></button></div>
              <Group>Line</Group>
              <EditRow id="ln-name" label="Name" text value={selLineRow.settings.name || ""} placeholder={selLineRow.line.name} tag={selLineRow.line.code || ""} tip="The line's name on the page. Blank: the words its works' titles share, else its Airtable release code." onCommit={(raw) => setLine(selLineRow.line.key, { name: raw })} />
              <Prop label="Target" tip="Its works' editions at their target sell-through"><Val ic={<Target />}>{fmt(selLineRow.line.edition_size)} units{selLineRow.line.unit_price ? ` at ${fmtMoney(selLineRow.line.unit_price, 0)}` : ""}</Val></Prop>
              <Prop label="Basket" tip="The launches this line is benchmarked against: those whose demand is nearest its own size, at a price nearest its own, the artist's own first.">
                <button className="chipb" onClick={() => { setPickingLine(selLineRow.line.key); setRoute({ ...route, basket: true }); }}>{selLineRow.basketN ? `${selLineRow.basketN} launches` : "Basket"}<span className="tag">{selLineRow.basketEdited ? "Edited" : "Suggested"}</span></button>
              </Prop>
              {selLineRow.profile && <Prop label="Benchmark"><Val ic={<Bmk />}>{fmt(selLineRow.profile.units)} units{selLineRow.k ? ` · ×${fmt(selLineRow.k, 2)}` : ""}</Val></Prop>}
              <Prop label="Stretch" tip="How this line's gap to its basket's median is shared out across the channels.">
                <span className="val"><StretchPill unitWord="units" disabled={!selLineRow.profile} paidOff={paidOff}
                  active={selLineRow.profile ? CH.map((g) => g.key).filter((g) => !isOff(g) && Number((selLineRow.profile.units_by_group || {})[g]) > 0) : []}
                  mode={(() => { const sf = selLineRow.settings.stretch_from; const typed = !!(sf && CH.some((g) => Number(sf[g.key]) > 0)); return !typed ? "even" : Number(sf.paid || 0) >= 0.995 ? "paid" : "custom"; })()}
                  shares={selLineRow.T && selLineRow.T.stretch_from ? selLineRow.T.stretch_from : (selLineRow.profile ? stretchWeights({ stretch_from: null }, selLineRow.profile.units_by_group) : {})}
                  onMode={(m) => setLine(selLineRow.line.key, { stretch_from: m === "even" ? null : m === "paid" ? { paid: 1 } : (selLineRow.profile ? { ...stretchWeights({ stretch_from: null }, selLineRow.profile.units_by_group) } : null) })}
                  onSlide={(key, v) => { const act = CH.map((g) => g.key).filter((g) => !isOff(g) && Number((selLineRow.profile.units_by_group || {})[g]) > 0); setLine(selLineRow.line.key, { stretch_from: rebalanceShares(selLineRow.T && selLineRow.T.stretch_from ? selLineRow.T.stretch_from : {}, key, v, act) }); }} /></span>
              </Prop>
              <Group>Ad sets</Group>
              <AdSets value={selLineRow.settings.adsets || []} known={knownAdsets} onChange={(v) => setLine(selLineRow.line.key, { adsets: v })} />
              {selLineRow.summary && selLineRow.summary.hero && (
                <><Group>Last build</Group><Prop label="Secured"><Val>{fmt(selLineRow.summary.hero.now)} of {fmt(selLineRow.summary.hero.target)}</Val></Prop></>
              )}
            </div>
          ) : (
            <div>
              <Group>Outcome</Group>
              <Prop label="Units target" tip={`The works' editions at their target sell-through, summed${partialEdition ? ` - ${fmt(editionSize)} of the ${fmt(econ.edition_total)} in the editions` : ""}.`}>
                <Val ic={<Target />} tag={econ.mode === "release" ? "Release-level" : partialEdition ? `of ${fmt(econ.edition_total)}` : ""}>{editionSize > 0 ? fmt(editionSize) : "–"}</Val>
              </Prop>
              <Prop label="Benchmark" tip={bmUnits ? `The basket's median units of demand, the channels not in plan set aside${k ? `: ×${fmt(k, 2)} to the target` : ""}.` : "Choose a basket first."}>
                <Val ic={<Bmk />}>{bmUnits ? `${fmt(Math.round(bmUnits * 10) / 10, bmUnits < 100 ? 1 : 0)} units` : "–"}</Val>
              </Prop>
              <Prop label="Stretch" tip={T ? `The target less the benchmark, ${stretchMode === "paid" ? "all from paid" : stretchMode === "custom" ? "on custom shares" : "even across channels"}.` : "Choose a basket first."}>
                <span className="val">{stretchUnits !== null ? <Loz kind={stretchUnits < 0 ? "warm" : "ind"}>{signed(stretchUnits)} units</Loz> : "–"}</span>
              </Prop>
              <Prop label="Launch value" tip={(econ.launch_currencies || []).some((c) => c !== "EUR") ? `Target units at their prices, from ${(econ.launch_currencies || []).join(", ")} at a fixed rate.` : "Target units at their prices."}>
                <Val ic={<Trend />}>{econ.launch_value > 0 ? fmtMoney(econ.launch_value, 0) : "–"}</Val>
              </Prop>

              <Group>Conversion</Group>
              <EditRow id="t-e2o" label="Entry to order" glyph="→" value={asPct(inp.entry_conversion_rate)} placeholder={`${e2oDefault}%`} tag={inp.entry_conversion_rate ? "Typed" : "Panel"} typed={!!inp.entry_conversion_rate}
                tip="What share of eligible entries in hand become orders. Blank is the panel's standard." onCommit={(raw) => { const c = String(raw).replace(/[^0-9]/g, ""); setInp((prev) => ({ ...prev, entry_conversion_rate: c === "" ? null : clamp(parseInt(c, 10), 1, 100) / 100 })); }} />
              <EditRow id="t-pre" label="Pre-order" glyph="→" value={asPct(inp.preorder_conversion_rate)} placeholder="95%" tag={inp.preorder_conversion_rate ? "Typed" : "Default"} typed={!!inp.preorder_conversion_rate}
                tip="What share of pre-order entries become orders. Their card is already authorised, so they convert higher than a plain entry. Blank is 95%." onCommit={(raw) => { const c = String(raw).replace(/[^0-9]/g, ""); setInp((prev) => ({ ...prev, preorder_conversion_rate: c === "" ? null : clamp(parseInt(c, 10), 1, 100) / 100 })); }} />

              <Group>Paid</Group>
              <CampaignsProp code={codeInForce} chosen={inp.campaign_names} all={meta.meta_campaigns} suggested={sourced.campaigns} asOf={snap.asOf} onChange={(names) => setInp({ ...inp, campaign_names: names })} />
              {!codeInForce && <EditRow id="t-code" label="Code" text value={inp.campaign_code || ""} placeholder="Artist_LE_26" tag="" tip="The code the email, Instagram and artist-post feeds tag this campaign with. Read off the Meta campaign's name once one is ticked." onCommit={(raw) => setInp((prev) => ({ ...prev, campaign_code: raw }))} />}
              <Prop label="Paid budget" tip={paidOff ? "Paid is not in plan." : T ? `Paid units × ${fmtMoney(cpp)} per unit${T.benchmark && T.benchmark.paid_budget ? `; the benchmark's is ${fmtMoney(T.benchmark.paid_budget, 0)}` : ""}. ${sense ? "Over" : "Under"} the 6% of launch value sense check.` : "Choose a basket first."}>
                <Val ic={<Wallet />} tag={!paidOff && T && T.paid.budget_pct_of_launch_value ? `${fmtPct(T.paid.budget_pct_of_launch_value, 1)} of value` : ""}>
                  {paidOff ? "–" : T ? <span style={sense ? { color: "var(--red)" } : undefined}>{fmtMoney(T.paid.budget, 0)}</span> : "–"}
                </Val>
              </Prop>
              <EditRow id="t-cpu" label="Cost per unit" glyph="€" value={inp.cost_per_purchase === null || inp.cost_per_purchase === undefined ? "" : String(inp.cost_per_purchase)} placeholder={fmtMoney(basketCpp > 0 ? basketCpp : panelCpp, 0)}
                tag={Number(inp.cost_per_purchase) > 0 ? "Typed" : basketCpp > 0 ? "Basket" : "Panel"} typed={Number(inp.cost_per_purchase) > 0}
                tip="What a paid unit costs to buy: paid units at this price is the paid budget. Blank is the basket's median cost per paid unit, or the panel's when fewer than three of the basket's launches have spend on file." onCommit={numCommit("cost_per_purchase", 0, 1e7)} />
              <EditRow id="t-cann" label="Cannibalised" glyph="%" value={inp.cannibalisation === null || inp.cannibalisation === undefined ? "" : String(Math.round(Number(inp.cannibalisation) * 1000) / 10)} placeholder={`${cannDefault}%`}
                tag={inp.cannibalisation !== null && inp.cannibalisation !== undefined ? "Typed" : "Default"} typed={inp.cannibalisation !== null && inp.cannibalisation !== undefined}
                tip="The share of paid entries that would have come anyway. The ROI and the budget floor read profit net of it." onCommit={numCommit("cannibalisation", 0, 95, 100)} />

              <TeamGroup snap={snap} sourced={sourced} inp={inp} setInp={setInp} slack={slack} />
            </div>
          )}
        </aside>
      </div>
      <SaveNote note={auto.note} onUndo={auto.undo} onClose={auto.dismiss} />
    </>
  );
}

/* The ad sets a line's paid actuals are read from (docs/LINES_PLAN.md): the
 * ones the spend feed lists under the release's campaigns to click on, and
 * a box for one the feed does not carry yet. */
function AdSets({ value, known, onChange }) {
  const [draft, setDraft] = useState("");
  const chosen = Array.isArray(value) ? value : [];
  const add = (names) => {
    const next = [...chosen];
    for (const n of names.map((x) => String(x).trim()).filter(Boolean)) if (!next.some((c) => c.toLowerCase() === n.toLowerCase())) next.push(n);
    onChange(next);
  };
  const commit = () => { if (draft.trim()) { add(draft.split(",")); setDraft(""); } };
  const offer = known.filter((kk) => !chosen.some((c) => c.toLowerCase() === kk.name.toLowerCase()));
  return (
    <div className="lnrow">
      <div className="chips-in">
        {chosen.map((c) => <span key={c} className="tagchip" title="This ad set's spend and paid entries are the line's.">{c}<button type="button" onClick={() => onChange(chosen.filter((x) => x !== c))} aria-label={`Remove ${c}`}>×</button></span>)}
        {!chosen.length && <span className="empty-note">None named: this line reads no spend</span>}
      </div>
      {offer.length > 0 && <div className="chips-in">{offer.map((kk) => <button key={kk.name} type="button" className="sbtn" onClick={() => add([kk.name])} title={`${kk.campaign}: ${fmtMoney(kk.spend, 0)} spent. Click to read it as this line's.`}>{kk.name}</button>)}</div>}
      <span className="val edit"><input className="q" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} placeholder="An ad set's name, as Meta names it" /></span>
    </div>
  );
}
