/* The targets page of a timed launch (docs/TL_SPEC.md §7, §8): the LE page
 * (TargetSetting.jsx) in TL words, on the same furniture (TargetsKit.jsx)
 * and the TL model (shared/tlModel.mjs), recomputed live as figures are
 * typed so the side says what the build will say. Every change saves itself
 * and the server rebuilds the page behind it.
 *
 * What differs from an LE is the target's unit. A timed launch is set a
 * units target (Airtable's, summed over the ticked works, typed over per
 * work or for the launch as a whole) and measured, before its window
 * opens, on the signups it gathers: the side's signup target is the orders
 * needed over the signup -> order rate, and the paid budget splits between
 * buying signups before the open and sales in the window. The dates are the
 * announce, the window's open (a time, in Amsterdam) and its length, each
 * with the feeds' other readings beside it and one click to take one. The
 * basket is picked on the same map as an LE's, over the TL panel, among the
 * launches of the same window length first.
 *
 * A basket picked by hand is previewed over the panel's rows (tlLiveProfile,
 * the shape of etl/tl.py basket_profile) until the save rebuilds the page;
 * the medians on the page are always the build's. No timed launch is built
 * on a fresh checkout, so every read of the snapshot here is guarded. */
import React, { useEffect, useMemo, useState } from "react";
import { Loz } from "./ui.jsx";
import { fmt, fmtMoney, fmtPct } from "./format.mjs";
import { Bmk, Clock, Img, Ring, Target, Trend, Undo, Wallet, Warn, X } from "./icons.jsx";
import { nameOf } from "./rows.mjs";
import BasketPicker from "./BasketPicker.jsx";
import {
  AddWorkButton, BasketIcon, BasketPill, BasketRow, CampaignsProp, CH, ChannelsPill, DateRow, EditRow, Group, HeadStatus, PickButton, Prop,
  RadioPill, Section, Strip, StretchPill, SaveNote, SwitchRow, TeamGroup, TitleIcon, Val, WorkRow, cellText, clamp, fmtDate, fmtWhen, hoursShort,
  hoursWords, median, memberRows, membersOf, norm, signed, useAutosave, useCandidates, useEconomicsItem, useIndexRows, useInputs, useSlackDoc, PCT,
} from "./TargetsKit.jsx";
import { resolveProducts, releaseEconomics } from "../../shared/economics.mjs";
import { GROUPS as GROUP_KEYS, TL_CANNIBALISATION, applyChannelsOff, channelsOffOf, fullProfile, mixFallbacks, rebalanceShares, stretchWeights, tlEconomics, tlPaidValue, tlTargets } from "../../shared/tlModel.mjs";
import { similarMembers, THIN_MEMBERS } from "../../shared/basketRule.mjs";
import "./targets.css";

const CANDIDATES_URL = "/api/tl/baskets/candidates";
const SIMILAR_NAME = "Similar size and shape";
const LENGTHS = [["24", "24 hours"], ["48", "48 hours"], ["72", "3 days"], ["168", "7 days"]];
const PAID_COST_MIN_MEMBERS = 3;   // etl/tl.py: a basket's cost medians need three launches with spend
const typedKeys = (p) => Object.keys(p.sources || {}).filter((k) => k !== "currency" && k !== "line" && p.sources[k] === "typed");
const positive = (vals) => median(vals.filter((v) => typeof v === "number" && v > 0));
const quantile = (values, q) => { const v = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b); if (!v.length) return 0; const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo); };

/* Amsterdam wall-clock <-> UTC ISO, for the open's datetime box. */
const TZ = "Europe/Amsterdam";
function offsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (k) => Number(parts.find((p) => p.type === k).value);
  return Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - utcMs) / 60000);
}
const toLocalInput = (iso) => { if (!iso) return ""; const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + offsetMinutes(t) * 60000).toISOString().slice(0, 16) : ""; };
const fromLocalInput = (s) => {
  if (!s) return null;
  const guess = Date.parse(`${s}:00Z`);
  if (!Number.isFinite(guess)) return null;
  let utc = guess - offsetMinutes(guess) * 60000;
  utc = guess - offsetMinutes(utc) * 60000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
};

function normaliseTL(raw) {
  const start = {
    // the figures that can be cleared ride as null when absent, so a clearing (and an undo) reaches the server
    units_target: null, purchases_per_order: null, signup_order_rate: null, cost_per_signup: null, cost_per_purchase: null, cannibalisation: null, marketing_lead: null, campaign_code: "", prefer_recent: true,
    ...raw, type: "TL",
    channels_off: Array.isArray(raw.channels_off) ? raw.channels_off : [],
    stretch_from: raw.stretch_from && typeof raw.stretch_from === "object" ? raw.stretch_from : null,
    products: Array.isArray(raw.products) ? raw.products : [],
    campaign_names: Array.isArray(raw.campaign_names) ? raw.campaign_names : (raw.campaign_name ? [raw.campaign_name] : []),
  };
  delete start.campaign_name;
  return start;
}

/* The medians of a set of the panel's rows, in the shape etl/tl.py
 * basket_profile writes (without the curves): what a basket picked by hand
 * reaches, previewed here until the build recomputes it on save. */
function tlLiveProfile(rows) {
  const n = rows.length;
  const col = (f) => rows.map((r) => (typeof r[f] === "number" ? r[f] : null));
  const signups = median(col("signups")), sessions = median(col("sessions")), units = median(col("units"));
  const shares = (key) => {
    const raw = Object.fromEntries(GROUP_KEYS.map((g) => [g, median(rows.map((r) => (r[key] || {})[g]))]));
    const tot = GROUP_KEYS.reduce((s, g) => s + raw[g], 0);
    return Object.fromEntries(GROUP_KEYS.map((g) => [g, tot > 0 ? raw[g] / tot : 0]));
  };
  const byGroup = (sh, total) => Object.fromEntries(GROUP_KEYS.map((g) => [g, sh[g] * total]));
  const [ss, sess, us] = mixFallbacks(shares("signup_shares"), shares("sess_shares"), shares("unit_shares"));
  const nCps = rows.filter((r) => r.cost_per_signup > 0).length, nCpu = rows.filter((r) => r.cost_per_paid_unit > 0).length;
  return {
    n, members: rows.map((r) => r.release_name),
    signups, signups_p25: quantile(col("signups"), 0.25), signups_p75: quantile(col("signups"), 0.75),
    sessions, units, orders: median(col("orders")),
    units_target: positive(col("units_target")), price: positive(col("price")),
    window_hours: positive(col("window_hours")), pre_days: positive(col("campaign_days")),
    early_access_share: n ? rows.filter((r) => r.early_access).length / n : 0,
    signup_order_rate: positive(col("signup_order_rate")), purchases_per_order: positive(col("units_per_buyer")),
    share_signups: ss, share_sessions: sess, share_units: us,
    signups_by_group: byGroup(ss, signups), sessions_by_group: byGroup(sess, sessions), units_by_group: byGroup(us, units),
    conv: Object.fromEntries(GROUP_KEYS.map((g) => [g, positive(rows.map((r) => (r.convs || {})[g]))])),
    signup_order_rate_by_group: Object.fromEntries(GROUP_KEYS.map((g) => [g, positive(rows.map((r) => (r.s2o || {})[g]))])),
    paid_share_signups: ss.paid, paid_share_units: us.paid,
    cost_per_signup: nCps >= PAID_COST_MIN_MEMBERS ? positive(col("cost_per_signup")) : 0,
    cost_per_sale: nCpu >= PAID_COST_MIN_MEMBERS ? positive(col("cost_per_paid_unit")) : 0,
    n_cost_per_signup: nCps, n_cost_per_sale: nCpu,
  };
}

const WORK_ROWS = [
  { key: "edition", label: "Edition", glyph: "№", tip: "Units in the edition of this work; a timed launch's edition caps nothing." },
  { key: "units_target", label: "Units target", glyph: "◎", tip: "Airtable's units target for this work. The launch's target is the sum over the ticked works, and the window is measured against it. Blank = Airtable's figure; type over it where you know better." },
  { key: "unit_price", label: "Price", glyph: "€", tip: "Retail price per unit, in euros." },
  { key: "artist_profit_per_unit", label: "Artist profit", glyph: "€", tip: "The artist's profit on one unit sold." },
  { key: "aa_profit_per_unit", label: "AA profit", glyph: "€", tip: "Avant Arte's group profit on one unit sold, before framing." },
  { key: "artist_revenue_cut", label: "Artist revenue cut", glyph: "%", tip: "The artist's or estate's commission on revenue, taken before any profit is split." },
  { key: "aa_profit_share", label: "Profit share", glyph: "%", tip: "Avant Arte's own share of the profit on a profit-share deal, which is also its share of the paid budget." },
  { key: "aa_revenue_share", label: "Revenue share", glyph: "%", tip: "Avant Arte's own share of revenue on a royalty deal, where Avant Arte carries the ads outright." },
];
const FRAME_ROWS = [
  { key: "frame_price", label: "Frame price", glyph: "€", tip: "The price of the cheapest frame offered on this work." },
  { key: "frame_conversion", label: "Frame take-up", glyph: "%", tip: "The share of buyers expected to take a frame. Blank = the last twelve months' take-up for frames priced like this one." },
  { key: "frame_profit_per_unit", label: "Frame profit", glyph: "€", tip: "Avant Arte's profit on each frame sold. Blank counts no framing profit." },
];
const closedFor = (p, key) => {
  if (key === "aa_revenue_share") return p.aa_profit_share !== null && p.aa_revenue_share === null;
  if (key === "aa_profit_share") return p.aa_revenue_share !== null && p.aa_profit_share === null;
  return false;
};
const SRC_WORD = { typed: "Typed", airtable: "Airtable", default: "Default" };

export default function TLTargets({ snap, onSaved, directSpread = false, route, setRoute }) {
  const { meta, setMeta, inp, setInp, error } = useInputs(snap.id, normaliseTL);
  const { rows: cands } = useCandidates(CANDIDATES_URL);
  const index = useIndexRows();
  const [sel, setSel] = useState(null);
  const [pick, setPick] = useState(null);
  const [hidden, setHidden] = useState({});
  const slack = useSlackDoc(snap, onSaved);
  useEffect(() => { setSel(null); setPick(null); setHidden({}); }, [snap.id]);

  const b = (meta && meta.benchmarks) || {};
  const sourced = (meta && meta.sourced) || { airtable: { match: "none", note: "", products: [] }, feed: {}, campaigns: [] };
  const atProducts = (sourced.airtable && sourced.airtable.products) || [];
  const products = useMemo(() => (inp ? resolveProducts(atProducts, inp.products, b) : []), [inp, b, atProducts]);
  const econ = useMemo(() => (inp ? releaseEconomics(products, null, b) : null), [products, inp, b]);
  const candByName = useMemo(() => new Map((cands || []).map((r) => [r.release_name, r])), [cands]);
  const ready = !!(inp && econ);

  /* ---- the dates in force and the other readings (docs/TL_SPEC.md §2):
   * typed, else as the build read them ---- */
  const dv = (meta && meta.derived) || {};
  const sd = snap.derived || {};
  const at = sourced.airtable || {}, feed = sourced.feed || {};
  const dsrc = sd.dates_source || {};
  const feedOpen = feed.window_open_adjusted || feed.window_open || null;
  const announce = inp ? (inp.announce_date || sd.announce_date || dv.announce_date || at.announce_date || feed.announce_date || "") : "";
  const open = inp ? (inp.window_open || sd.window_open || dv.window_open || at.window_open || feedOpen || "") : "";
  const hoursInForce = inp ? (Number(inp.window_hours) > 0 ? Number(inp.window_hours) : Number(sd.window_hours) > 0 ? Number(sd.window_hours)
    : Number(dv.window_hours) > 0 ? Number(dv.window_hours) : Number(at.window_hours) > 0 ? Number(at.window_hours) : 48) : 48;
  const closeIso = open ? new Date(Date.parse(open) + hoursInForce * 3600000).toISOString() : null;

  /* ---- the products and the economics: the units target is Airtable's,
   * summed over the ticked works and typed over per work; the price is
   * weighted by each work's units target, else its edition ---- */
  const live = products.filter((p) => !p.excluded);
  const unitsSum = live.reduce((s, p) => s + (p.units_target || 0), 0);
  const airtableUnits = unitsSum > 0 ? unitsSum : null;
  const priced = live.filter((p) => p.unit_price_eur > 0);
  const weight = (p) => p.units_target || p.edition || 0;
  const w = priced.reduce((s, p) => s + weight(p), 0);
  const price = w > 0 ? priced.reduce((s, p) => s + weight(p) * p.unit_price_eur, 0) / w : priced.length ? priced.reduce((s, p) => s + p.unit_price_eur, 0) / priced.length : 0;
  const releaseUnits = inp && Number(inp.units_target) > 0 ? Number(inp.units_target) : null;
  const unitsTarget = releaseUnits || airtableUnits;
  const launchValue = unitsTarget && price ? unitsTarget * price : 0;

  const missing = [];
  if (ready && !(unitsTarget > 0)) missing.push("a units target (Airtable's for the ticked works, or typed)");
  if (ready && !announce) missing.push("the announce date");
  if (ready && !open) missing.push("the window open");

  const auto = useAutosave({
    id: snap.id, inp, setInp, meta, setMeta, missing,
    body: (cur) => { const { campaign_name, ...rest } = cur; return { ...rest, type: "TL", channels_off: channelsOffOf(cur), announce_date: announce ? String(announce).slice(0, 10) : null,
      window_open: open || null, window_hours: Number(cur.window_hours) > 0 ? Number(cur.window_hours) : (rest.window_hours || null), launch_end: closeIso ? closeIso.slice(0, 10) : rest.launch_end || null }; },
    onSaved: (s) => { setPick(null); onSaved(s); },
  });
  const pmAirtable = snap.projectManager || null;
  const econItem = useEconomicsItem(snap, onSaved, { pmName: slack.pm.trim() || (pmAirtable && pmAirtable.name) || "", busy: auto.dirty || auto.status.state !== "idle" });

  /* ---- the basket and the channels (spec §8) ---- */
  const bm = snap.benchmark || null;
  const baskets = Array.isArray(snap.baskets) ? snap.baskets : [];
  const spec = inp ? inp.benchmark_basket || null : null;
  const off = inp ? channelsOffOf(inp) : [];
  const L = useMemo(() => ({ name: snap.releaseName, artist: snap.artist || "", target: unitsTarget || 0, price: price || 0, currency: "EUR", announce_date: announce ? String(announce).slice(0, 10) : null, launch_end: closeIso ? closeIso.slice(0, 10) : null }),
    [snap.releaseName, snap.artist, unitsTarget, price, announce, closeIso]);
  const sameLength = useMemo(() => (cands ? cands.filter((r) => Number(r.window_hours) === Number(hoursInForce)) : null), [cands, hoursInForce]);
  const ruleRows = sameLength && sameLength.filter((r) => r.release_name !== snap.releaseName).length >= THIN_MEMBERS ? sameLength : cands;
  const rule = useMemo(() => (ruleRows && unitsTarget > 0 ? similarMembers(ruleRows, L, { preferRecent: !inp || inp.prefer_recent !== false, asOf: snap.asOf || null }) : null), [ruleRows, L, inp && inp.prefer_recent, snap.asOf]);
  const builtMembers = (bm && bm.basket && Array.isArray(bm.basket.members) && bm.basket.members) || (bm && Array.isArray(bm.members) ? bm.members.map((m) => m.name || m.release_name) : null)
    || (spec && spec.kind === "ready" && (baskets.find((x) => x.id === spec.id) || {}).members) || null;
  const memberNames = pick ? pick.members : membersOf({ spec, built: builtMembers, rule: rule ? rule.members : [] });
  const members = useMemo(() => memberRows(memberNames, cands), [memberNames.join("|"), cands]);
  const basketName = pick ? pick.name : (bm && bm.basket && bm.basket.name) || (spec && spec.name) || (spec && spec.kind === "bespoke" ? "Bespoke basket" : SIMILAR_NAME);
  // a pick's medians over the panel's rows (the ready basket's from the
  // page when the rows are not here); else the page's basket, read whole;
  // else a preview of the suggestion
  const pickRows = pick ? (pick.members || []).map((m) => candByName.get(m)).filter(Boolean) : [];
  const pickProfile = pick ? (pickRows.length ? tlLiveProfile(pickRows) : (pick.kind === "ready" && (baskets.find((x) => x.id === pick.id) || {}).profile) || null) : null;
  const prof = pickProfile || (bm && bm.profile ? fullProfile(bm.profile) : members.length ? tlLiveProfile(members) : null);
  const profile = prof ? applyChannelsOff(prof, off) : null;

  if (error && !meta) return <div className="tgap">Failed to load the inputs: {error}</div>;
  if (!ready) return <div className="tgap">Loading…</div>;

  const isOff = (g) => off.includes(g);
  const setOff = (g, on) => setInp({ ...inp, channels_off: on ? [...off, g] : off.filter((x) => x !== g) });
  const paidOff = isOff("paid");
  const T = profile ? tlTargets(inp, airtableUnits, profile, launchValue, b) : null;
  const econRows = products.map((p) => ({ ...p, frame_conversion: p.sources && p.sources.frame_conversion === "default" ? null : p.frame_conversion }));
  const PV = T ? tlPaidValue(inp, profile, T, tlEconomics(econRows, b), b) : null;
  const pvOk = !!(PV && PV.readable && PV.value_per_signup !== null);
  const BM = T ? T.benchmark : null;
  const k = T ? T.k : null;
  const stretchTyped = !!(T && T.stretch_typed);
  const activeGroups = profile ? GROUP_KEYS.filter((g) => !isOff(g) && Number((profile.signups_by_group || {})[g]) > 0) : [];
  const evenShares = profile ? stretchWeights({ stretch_from: null }, profile.signups_by_group) : {};
  const shares = T && T.stretch_from ? T.stretch_from : evenShares;
  const stretchOf = (key) => (T && BM ? Number((T.signups_by_group || {})[key] || 0) - Number((BM.signups_by_group || {})[key] || 0) : 0);
  const sf = inp.stretch_from;
  const stretchMode = !stretchTyped ? "even" : Number((sf || {}).paid || 0) >= 0.995 ? "paid" : "custom";
  const onStretchMode = (m) => {
    if (m === "even") setInp({ ...inp, stretch_from: null });
    else if (m === "paid") setInp({ ...inp, stretch_from: { paid: 1 } });
    else if (!stretchTyped) setInp({ ...inp, stretch_from: { ...evenShares } });
  };

  /* ---- the works' handlers, as on the LE page ---- */
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
    const clean = String(raw).replace(/[^0-9.]/g, "");
    if (clean === "") return null;
    let v = parseFloat(clean);
    if (!Number.isFinite(v)) return undefined;
    if (PCT.has(key)) v = clamp(v, 0, 100) / 100;
    if (key === "edition" || key === "units_target") v = Math.round(v);
    if (key === "units_target" && v <= 0) return null;
    return v;
  };
  const patchFor = (p, key, v) => {
    const patch = { [key]: v === null && p.airtable_id ? undefined : v };
    if (key === "aa_revenue_share" && v !== null) patch.aa_profit_share = undefined;
    if (key === "aa_profit_share" && v !== null) patch.aa_revenue_share = undefined;
    return patch;
  };
  const onField = (p, key, raw) => { const v = parseField(key, raw); if (v === undefined) return; setInp((prev) => ({ ...prev, products: applyEntry(prev.products || [], p, patchFor(p, key, v)) })); };
  const onName = (p, name) => setInp((prev) => ({ ...prev, products: (prev.products || []).map((t) => (t.manual && norm(t.name) === norm(p.name) ? { ...t, name } : t)) }));
  const onAdd = () => { const n = (inp.products || []).filter((t) => t.manual).length + 1; setInp({ ...inp, products: [...(inp.products || []), { manual: true, name: `Work ${n}` }] }); setSel(`m-${products.length}`); };
  const onRemove = (p) => { setInp({ ...inp, products: (inp.products || []).filter((t) => !(t.manual && norm(t.name) === norm(p.name))) }); setSel(null); };
  const onInclude = (p, on) => setInp((prev) => ({ ...prev, products: applyEntry(prev.products || [], p, on ? { excluded: undefined } : { excluded: true }) }));
  const onReset = (p) => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => ((p.airtable_id && String(t.airtable_id) === String(p.airtable_id)) ? (t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : []) : [t])) }));
  const onResetAll = () => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => (!t.airtable_id ? [t] : t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : [])) }));
  const typedCount = products.filter((p) => p.airtable_id).reduce((s, p) => s + typedKeys(p).length, 0);
  // the picker asks for a target and a price when there are none: they land
  // on a work added by hand (its units target and its price); its paid
  // toggle is the channels-in-plan setting
  const onPickerInputs = (patch) => setInp((prev) => {
    const next = { ...prev };
    if (patch.channels_off !== undefined) next.channels_off = patch.channels_off;
    if (patch.prefer_recent !== undefined) next.prefer_recent = patch.prefer_recent;
    if (patch.edition_size !== undefined || patch.unit_price !== undefined) {
      const name = "Release";
      const list = prev.products || [];
      const entry = { ...(list.find((t) => t.manual && norm(t.name) === norm(name)) || { manual: true, name }) };
      if (patch.edition_size !== undefined) entry.units_target = patch.edition_size || null;
      if (patch.unit_price !== undefined) { entry.unit_price = patch.unit_price || null; entry.currency = "EUR"; }
      next.products = [...list.filter((t) => !(t.manual && norm(t.name) === norm(name))), entry];
    }
    return next;
  });
  const onPick = (chosen) => {
    setPick(chosen);
    setInp({ ...inp, benchmark_basket: chosen.kind === "bespoke" ? { kind: "bespoke", members: chosen.members, name: chosen.name } : { kind: "ready", id: chosen.id }, prefer_recent: chosen.preferRecent !== false });
    setRoute({ ...route, basket: false });
  };

  /* ---- the picker page ---- */
  if (route.basket) {
    return (
      <>
        <HeadStatus status={auto.status} onRetry={auto.retry} />
        <BasketPicker kind="tl" rows={cands} releaseName={snap.releaseName} artist={snap.artist || ""} badge="TL" current={spec} currentMembers={memberNames}
          targetUnits={unitsTarget || 0} unitPrice={price || 0} preferRecent={inp.prefer_recent !== false} channelsOff={off}
          announceDate={announce ? String(announce).slice(0, 10) : null} privateRoomOpen={null} launchEnd={closeIso ? closeIso.slice(0, 10) : null} asOf={snap.asOf || null}
          lengthHours={hoursInForce} onInputs={onPickerInputs} onPick={onPick} onBack={() => setRoute({ ...route, basket: false })} />
        <SaveNote note={auto.note} onUndo={auto.undo} onClose={auto.dismiss} />
      </>
    );
  }

  /* ---- the words ---- */
  const SRC = { typed: "typed", airtable: "Airtable", feed: "the feed's launch time", feed_hour: "Airtable's day at the feed's hour", signups: "the first day with ten or more signups", assumed: "assumed", default: "assumed", airtable_end: "Airtable's end date", derived: "as the build read it" };
  const srcOf = (value, derivedValue, derivedSrc) => (value && String(value) !== String(derivedValue || "") ? "typed" : derivedSrc || (value ? "derived" : ""));
  const announceSrc = srcOf(announce, sd.announce_date || dv.announce_date, dsrc.announce);
  const openSrc = srcOf(open, sd.window_open || dv.window_open, dsrc.open);
  const hoursSrc = srcOf(hoursInForce, sd.window_hours || dv.window_hours, dsrc.hours);
  const others = (value, readings) => readings.filter(([, v]) => v && String(v) !== String(value));
  const announceDrift = others(announce, [["airtable", at.announce_date], ["feed", feed.announce_date]]).map(([n, v]) => ({ key: n, text: `${n === "airtable" ? "Airtable" : "Feed"} says ${fmtDate(v)}`, tip: n === "airtable" ? "Airtable's announce date" : "The feed's", use: () => setInp({ ...inp, announce_date: String(v).slice(0, 10) }) }));
  const openDrift = others(open, [["airtable", at.window_open], ["feed", feedOpen]]).map(([n, v]) => ({ key: n, text: `${n === "airtable" ? "Airtable" : "Feed"} says ${fmtWhen(v)}`, tip: n === "airtable" ? "Airtable's launch time" : feed.window_open_adjusted ? "The feed's timestamp, less the hour it runs late in summer time" : "The feed's launch time", use: () => setInp({ ...inp, window_open: v }) }));
  const { artist, work } = nameOf({ releaseName: snap.releaseName, artist: snap.artist, title: snap.title });
  const title = `${work && work !== "Multiple" ? work : artist} targets`;
  const workRows = products.map((p, i) => ({ key: rowKey(p, i), name: p.name || "unnamed", target: p.units_target, edition: p.edition, price: p.unit_price_eur, framed: p.framing_available, excluded: p.excluded, manual: !p.airtable_id,
    over: !!(p.units_target && p.edition && p.units_target > p.edition), tip: p.units_target ? `Units target ${fmt(p.units_target)}${p.edition ? ` of an edition of ${fmt(p.edition)}` : ""}` : "No units target: Airtable holds none for this work" }));
  const selP = sel !== null ? products.find((p, i) => rowKey(p, i) === sel) : null;
  const openRelease = (name) => { const r = index.find((x) => x.releaseName === name); return r ? () => setRoute({ view: "release", id: r.id, tab: "overview", basket: false }) : null; };
  const pct1 = (v) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 1000) / 10));
  const nCps = profile ? profile.n_cost_per_signup || 0 : 0, nCpu = profile ? profile.n_cost_per_sale || 0 : 0;
  const basketCps = profile && Number(profile.cost_per_signup) > 0 ? Number(profile.cost_per_signup) : 0;
  const basketCpu = profile && Number(profile.cost_per_sale) > 0 ? Number(profile.cost_per_sale) : 0;
  const stretchSignups = T && BM && T.signup_target !== null ? Math.round(T.signup_target - BM.signups) : null;
  const sense = !!(T && T.sense_check_breached);
  const S2O_PAID_WORDS = { release: "typed", basket_paid: "the basket's paid rate", basket: "the basket's blended rate", none: "no rate on file" };
  const FRAME_WORDS = { release: "the works' own take-up", basket: "the basket's frames per print", default: "the last twelve months' take-up for frames priced like these" };
  const s2oWords = { release: "typed", basket_mix: "the basket's rates by channel, at its mix of signups", basket: "the basket's median", none: "no rate on file" };
  const numCommit = (key, lo, hi, scale) => (raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), lo, hi); setInp((prev) => ({ ...prev, [key]: v === null || Number.isNaN(v) ? null : (scale ? v / scale : c) })); };
  const headMenu = [econItem, { label: "Reset to Airtable's figures", icon: <Undo />, disabled: typedCount === 0, title: typedCount ? `Drop every typed figure (${typedCount}): back to Airtable's on every work.` : "No figure is typed over Airtable's.", onClick: onResetAll }];

  const strips = [];
  if (meta.storage && meta.storage.durable === false) strips.push({ key: "storage", icon: <Warn />, text: "Targets saved here do not survive a deploy", sx: `Point SAVED_INPUTS_PATH at a persistent disk (README). Saves go to ${meta.storage.path}` });
  if (missing.length) strips.push({ key: "missing", icon: <Ring />, text: `Not saved yet: needs ${missing.join(", ")}`, sx: "Saves itself once they are set" });
  else if (meta.creating && !auto.dirty) strips.push({ key: "creating", icon: <Ring />, text: "Timed launch on Airtable's target and the suggested basket", sx: `${sd.dates_note || dv.dates_note || "Check the dates and the campaigns"}; the first change here makes the targets yours` });
  if (releaseUnits) strips.push({ key: "units", icon: <Ring />, text: `A units target of ${fmt(releaseUnits)} is typed for the launch as a whole`, sx: airtableUnits ? `It stands over the works' ${fmt(airtableUnits)}` : "It stands over the works' targets", action: <button className="sbtn" onClick={() => setInp({ ...inp, units_target: null })} title="Drop the launch-level target: the works' targets carry it.">Use the works' targets</button> });
  if (slack.state.state === "failed" || slack.state.state === "warn") strips.push({ key: "slack", icon: <Warn />, text: slack.state.state === "failed" ? "The Slack channel was not saved" : "Slack channel saved, but not for long", sx: slack.state.error });

  const workField = (p, r) => {
    if (closedFor(p, r.key)) return <Prop key={r.key} label={r.label} tip={r.key === "aa_revenue_share" ? "Closed: this work has an AA profit share." : "Closed: this work has an AA revenue share."}><span className="val ro"><span className="ic">{r.glyph}</span><span className="dim">–</span></span></Prop>;
    const src = p.sources[r.key] || (r.key === "frame_conversion" ? "default" : null);
    return <EditRow key={r.key} id={`w-${r.key}`} label={r.label} glyph={r.glyph} value={cellText(r.key, p[r.key])} placeholder={r.key === "units_target" ? "None" : "Empty"} tag={src ? SRC_WORD[src] : ""} typed={src === "typed"} tip={r.tip} onCommit={(raw) => onField(p, r.key, raw)} />;
  };
  const lengthOpts = LENGTHS.some(([h]) => Number(h) === hoursInForce) ? LENGTHS : [...LENGTHS, [String(hoursInForce), hoursWords(hoursInForce)]];

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
              <BasketPill name={basketName} n={members.length || (bm && bm.basket ? bm.basket.n : 0)} onClick={() => setRoute({ ...route, basket: true })} />
              <ChannelsPill off={off} setOff={setOff} />
              <StretchPill mode={stretchMode} onMode={onStretchMode} shares={shares} active={activeGroups} paidOff={paidOff} disabled={!profile} unitWord="signups"
                onSlide={(key, v) => setInp({ ...inp, stretch_from: rebalanceShares(shares, key, v, activeGroups) })} stretchOf={stretchOf} />
              <RadioPill icon={<Clock />} label="Window" value={String(hoursInForce)} options={lengthOpts} onChange={(v) => setInp({ ...inp, window_hours: Number(v) })}
                tip={`How long the window stays open: ${SRC[hoursSrc] || "as read"}${Number(at.window_hours) > 0 && Number(at.window_hours) !== hoursInForce ? `; Airtable has ${hoursWords(Number(at.window_hours))}` : ""}. Typed, else Airtable's TL length, else its end date, else 48 hours assumed.`} />
            </div>

            <Section title="Works" count={products.length} action={<AddWorkButton onClick={onAdd} />}>
              {workRows.map((wr) => <WorkRow key={wr.key} w={wr} on={sel === wr.key} onPick={() => setSel(sel === wr.key ? null : wr.key)} />)}
              {!products.length && <div className="empty-note">No works yet: Airtable has no record matched to this launch{at.note ? ` (${at.note})` : ""}. Add one by hand with the plus.</div>}
            </Section>

            <Section title={basketName} icon={<BasketIcon />} count={members.length} aria="Basket"
              lozes={profile ? <><Loz kind="ind" tip="The basket's median units their windows sold">{fmt(profile.units)} units</Loz><Loz tip="The basket's median signups before their windows opened">{fmt(profile.signups)} signups</Loz></> : null}
              action={<PickButton onClick={() => setRoute({ ...route, basket: true })} />}>
              {members.slice().sort((x, y) => (y.units || 0) - (x.units || 0)).map((r) => <BasketRow key={r.release_name} r={{ ...r, unitsTip: "Units its window sold" }} onOpen={openRelease(r.release_name)}
                extra={(row) => <Loz tip="Its window length">{hoursShort(row.window_hours)}</Loz>} />)}
              {!members.length && <div className="empty-note">{unitsTarget > 0 ? (cands ? "No completed timed launch to benchmark against yet." : "Finding the nearest launches…") : "A units target is needed before there is anything to be near to: Airtable's for the ticked works, or typed."}</div>}
            </Section>

            <Section title="Dates" count={5}>
              <DateRow name="Announce" value={String(announce || "").slice(0, 10)} text={fmtDate(announce)} drift={announceDrift} onChange={(v) => setInp({ ...inp, announce_date: v || null })}
                tip={`The day the launch was announced: the pre-window starts here. Now: ${SRC[announceSrc] || "not known yet, type it"}.`} />
              <DateRow name="Early access" text={snap.earlyAccessOpen ? fmtWhen(snap.earlyAccessOpen) : "–"} tip={snap.earlyAccessAssumed ? "Expected about a day before the open" : "When the early access opened"} />
              <DateRow name="Window opens" time value={toLocalInput(open)} text={fmtWhen(open)} drift={openDrift} onChange={(v) => setInp({ ...inp, window_open: fromLocalInput(v) })}
                tip={`The public open, Amsterdam time. Now: ${SRC[openSrc] || "not known yet, type it"}.`} />
              <DateRow name="Window closes" text={closeIso ? fmtWhen(closeIso) : "–"} tip={`The open plus the window's ${hoursWords(hoursInForce)}`} />
              <DateRow name="Settles" text={snap.settleEnd ? fmtDate(snap.settleEnd) : "–"} tip="When the window's sales are read as final" />
            </Section>
          </div>
        </div>

        <aside className="side" aria-label="Details">
          {selP ? (
            <div>
              <div className="whead"><span style={{ color: "#6b6b6f", display: "inline-flex" }}><Img /></span><span className="nm">{selP.name || "unnamed"}</span><button className="ib" aria-label="Close the work" onClick={() => setSel(null)}><X /></button></div>
              <Group>Work</Group>
              {!selP.airtable_id && <EditRow id="w-name" label="Name" text value={selP.name || ""} placeholder="Name of the work" tag="by hand" onCommit={(raw) => onName(selP, raw)} />}
              {WORK_ROWS.map((r) => workField(selP, r))}
              <Group>Framing</Group>
              <SwitchRow label="Offered" on={!!selP.framing_available} onChange={(on) => onField(selP, "framing_available", on)} tip={selP.sources.framing_available === "default" ? "Airtable's Framing is blank: a sculpture edition defaults to no frame, a print to one" : "Whether a frame is offered on this work"} />
              {selP.framing_available && FRAME_ROWS.map((r) => workField(selP, r))}
              <Group>Launch</Group>
              {selP.airtable_id && <SwitchRow label="In the launch" on={!selP.excluded} onChange={(on) => onInclude(selP, on)} tip="Untick to leave this work out: it stays listed, greyed, and counts nothing." />}
              <div className="acts">
                {selP.airtable_id && typedKeys(selP).length > 0 && <button className="sbtn" onClick={() => onReset(selP)} title={`Back to Airtable's figures on this work (${typedKeys(selP).length} typed)`}><Undo />Reset to Airtable</button>}
                {!selP.airtable_id && <button className="sbtn" onClick={() => onRemove(selP)} title="Take this work off the launch"><X />Remove</button>}
              </div>
            </div>
          ) : (
            <div>
              <Group>Outcome</Group>
              <EditRow id="t-units" label="Units target" glyph={<Target />} value={releaseUnits ? String(releaseUnits) : ""} placeholder={airtableUnits ? fmt(airtableUnits) : "None"} tag={releaseUnits ? "Typed" : airtableUnits ? "Airtable" : ""} typed={!!releaseUnits}
                tip="The launch's units target: Airtable's, summed over the ticked works, or typed here for the launch as a whole. The window is measured against it; the edition caps nothing." onCommit={numCommit("units_target", 0, 1e7)} />
              <Prop label="Signup target" tip={T && T.signup_target ? `${fmt(T.units_target)} units ÷ ${fmt(T.purchases_per_order, 2)} an order ÷ ${fmtPct(T.signup_order_rate, 1)}${k ? ` · ×${fmt(k, 2)} the basket's median` : ""}` : "A units target and a basket are needed."}>
                <Val ic={<Target />}>{T && T.signup_target ? fmt(T.signup_target) : "–"}</Val>
              </Prop>
              <Prop label="Benchmark" tip={BM ? "The basket's median signups before the open and units sold in the window, the channels not in plan set aside." : "Choose a basket first."}>
                <Val ic={<Bmk />}>{BM ? `${fmt(BM.signups)} signups · ${fmt(BM.units)} units` : "–"}</Val>
              </Prop>
              <Prop label="Stretch" tip={T && BM ? (stretchTyped ? `The signup target less the benchmark, on the shares placed: ${CH.filter((g) => Number((T.stretch_from || {})[g.key]) > 0).map((g) => `${g.name} ${Math.round(100 * T.stretch_from[g.key])}%`).join(", ")}` : `The signup target less the benchmark, the same uplift ×${fmt(k || 1, 2)} in every channel`) : "Choose a basket first."}>
                <span className="val">{stretchSignups !== null ? <Loz kind={stretchSignups < 0 ? "warm" : "ind"}>{signed(stretchSignups)} signups</Loz> : "–"}</span>
              </Prop>
              <Prop label="Launch value" tip={price > 0 ? `Units target at ${fmtMoney(price, 0)} a unit, weighted by the works' targets` : "Units target at the works' prices"}><Val ic={<Trend />}>{launchValue > 0 ? fmtMoney(launchValue, 0) : "–"}</Val></Prop>

              <Group>Conversion</Group>
              <EditRow id="t-s2o" label="Signup to order" glyph="→" value={pct1(inp.signup_order_rate)} placeholder={T && T.signup_order_rate > 0 ? `${pct1(T.signup_order_rate)}%` : "–"} tag={Number(inp.signup_order_rate) > 0 ? "Typed" : "Basket"} typed={Number(inp.signup_order_rate) > 0}
                tip={`What share of the pre-window signups order in the window; it sets the signup target. ${T ? `Blank reads ${s2oWords[T.signup_order_rate_source]}${T.signup_order_rate_source === "basket_mix" ? `: ${CH.filter((g) => T.signup_order_rate_by_group[g.key] > 0).map((g) => `${g.name} ${fmtPct(T.signup_order_rate_by_group[g.key], 1)}`).join(", ")}` : ""}.` : "Choose a basket first."}`}
                onCommit={numCommit("signup_order_rate", 0, 100, 100)} />
              <EditRow id="t-ppo" label="Per order" glyph="№" value={inp.purchases_per_order === null || inp.purchases_per_order === undefined ? "" : String(inp.purchases_per_order)} placeholder={profile && profile.purchases_per_order > 0 ? fmt(profile.purchases_per_order, 2) : "1.00"} tag={Number(inp.purchases_per_order) > 0 ? "Typed" : "Basket"} typed={Number(inp.purchases_per_order) > 0}
                tip="How many pieces a buyer takes in one order: the units target over this is the orders needed. Blank is the basket's median." onCommit={numCommit("purchases_per_order", 0, 100)} />

              <Group>Paid</Group>
              <CampaignsProp code={inp.campaign_code || sd.campaign_code || dv.campaign_code || ""} chosen={inp.campaign_names || []} all={meta.meta_campaigns} suggested={sourced.campaigns} asOf={snap.asOf} onChange={(names) => setInp({ ...inp, campaign_names: names })} />
              {!(inp.campaign_code || sd.campaign_code || dv.campaign_code) && <EditRow id="t-code" label="Code" text value={inp.campaign_code || ""} placeholder="Artist_TL_26" tag="" tip="The code the Meta campaigns and the sends carry: it joins the spend and the emails to the launch." onCommit={(raw) => setInp((prev) => ({ ...prev, campaign_code: raw }))} />}
              <Prop label="Before the open" tip={paidOff ? "Paid is not in plan." : T && T.budget_pre !== null ? `Paid signups ${fmt(T.paid_signups)} × ${fmtMoney(T.cost_per_signup, 2)} a signup (${T.cost_per_signup_source === "release" ? "typed" : "the basket's median"})${BM && BM.budget_pre ? `; the benchmark's is ${fmtMoney(BM.budget_pre, 0)}` : ""}` : "No cost per signup on file yet, so no pre-window budget."}>
                <Val ic={<Wallet />}>{paidOff ? "–" : T && T.budget_pre !== null ? fmtMoney(T.budget_pre, 0) : "–"}</Val>
              </Prop>
              <Prop label="In the window" tip={paidOff ? "Paid is not in plan." : T && T.budget_window !== null ? `Paid's share of the units target (${fmt(T.paid_units)}) × ${fmtMoney(T.cost_per_sale, 0)} a sale (${T.cost_per_sale_source === "release" ? "typed" : "the basket's median"}). ${sense ? "Over" : "Under"} the 6% of launch value sense check.` : "No cost per sale on file yet, so no window budget."}>
                <Val ic={<Wallet />} tag={!paidOff && T && T.budget_pct_of_launch_value ? `${fmtPct(T.budget_pct_of_launch_value, 1)} of value` : ""}>{paidOff ? "–" : T && T.budget_window !== null ? <span style={sense ? { color: "var(--red)" } : undefined}>{fmtMoney(T.budget_window, 0)}</span> : "–"}</Val>
              </Prop>
              <EditRow id="t-cps" label="Cost per signup" glyph="€" value={inp.cost_per_signup === null || inp.cost_per_signup === undefined ? "" : String(inp.cost_per_signup)} placeholder={basketCps > 0 ? fmtMoney(basketCps, 2) : "none on file"} tag={Number(inp.cost_per_signup) > 0 ? "Typed" : basketCps > 0 ? "Basket" : `${nCps} of ${PAID_COST_MIN_MEMBERS}`} typed={Number(inp.cost_per_signup) > 0}
                tip={`What a paid signup costs to buy, in euros: each launch's Sign-ups spend over the paid signups it bought. ${basketCps > 0 ? `Blank reads the basket, ${nCps} launches with spend on file.` : `Blank reads the basket once ${PAID_COST_MIN_MEMBERS} of its launches have spend on file (${nCps} do today).`}${pvOk && PV.cost_per_signup_at_target_roi ? ` ${fmtMoney(PV.cost_per_signup_at_target_roi, 2)} at the target ROI.` : ""}`}
                onCommit={numCommit("cost_per_signup", 0, 1e6)} />
              <EditRow id="t-cpu" label="Cost per sale" glyph="€" value={inp.cost_per_purchase === null || inp.cost_per_purchase === undefined ? "" : String(inp.cost_per_purchase)} placeholder={basketCpu > 0 ? fmtMoney(basketCpu, 0) : "none on file"} tag={Number(inp.cost_per_purchase) > 0 ? "Typed" : basketCpu > 0 ? "Basket" : `${nCpu} of ${PAID_COST_MIN_MEMBERS}`} typed={Number(inp.cost_per_purchase) > 0}
                tip={`What a paid unit costs to buy in the window, in euros: each launch's Purchases spend over the paid units its window sold. ${basketCpu > 0 ? `Blank reads the basket, ${nCpu} launches with spend on file.` : `Blank reads the basket once ${PAID_COST_MIN_MEMBERS} of its launches have spend on file (${nCpu} do today).`}`}
                onCommit={numCommit("cost_per_purchase", 0, 1e7)} />
              <EditRow id="t-cann" label="Cannibalised" glyph="%" value={inp.cannibalisation === null || inp.cannibalisation === undefined ? "" : String(Math.round(Number(inp.cannibalisation) * 1000) / 10)} placeholder={`${Math.round(100 * TL_CANNIBALISATION)}%`} tag={inp.cannibalisation !== null && inp.cannibalisation !== undefined ? "Typed" : "TL default"} typed={inp.cannibalisation !== null && inp.cannibalisation !== undefined}
                tip={`The share of paid signups that would have come anyway. Blank = the ${Math.round(100 * TL_CANNIBALISATION)}% standard for timed launches.`} onCommit={numCommit("cannibalisation", 0, 95, 100)} />
              <Prop label="Signup worth" tip={pvOk
                ? `${fmtMoney(PV.value_per_unit, 0)} a unit sold (AA group profit ${fmtMoney(PV.aa_profit_per_unit, 0)} + framing ${fmtMoney(PV.frame_uplift_per_unit, 0)}: ${fmtPct(PV.frame_share, 0)} of units framed at ${fmtPct(PV.frame_rate, 0)} take-up, ${FRAME_WORDS[PV.frame_rate_source]}), less ${fmtPct(PV.cannibalisation, 0)} cannibalisation, × ${fmt(PV.purchases_per_order, 2)} pieces an order × ${fmtPct(PV.signup_order_rate, 1)} of paid signups ordering (${S2O_PAID_WORDS[PV.signup_order_rate_source]}). At the ${fmt(PV.roi_target, 2)} target ROI a paid signup may cost ${fmtMoney(PV.cost_per_signup_at_target_roi, 2)}; break-even ${fmtMoney(PV.break_even_cost_per_signup, 2)}. ${PV.aa_budget_share_assumed ? "AA's share of the spend assumed at 50%." : `AA carries ${Math.round(100 * PV.aa_budget_share)}% of the spend.`}`
                : "What a paid signup is worth to Avant Arte: the Overview's paid card reads its ROI against this. It needs AA's group profit per unit: type it per work, or fill it in Airtable."}>
                <Val ic={<Trend />} tag={pvOk ? (PV.aa_budget_share_assumed ? "AA 50% assumed" : `AA ${Math.round(100 * PV.aa_budget_share)}%`) : "needs AA profit"}>{pvOk ? fmtMoney(PV.value_per_signup, 2) : "–"}</Val>
              </Prop>

              <TeamGroup snap={snap} sourced={sourced} inp={inp} setInp={setInp} slack={slack} />
            </div>
          )}
        </aside>
      </div>
      <SaveNote note={auto.note} onUndo={auto.undo} onClose={auto.dismiss} />
    </>
  );
}
