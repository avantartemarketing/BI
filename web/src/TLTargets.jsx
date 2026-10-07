/* Target setting for a timed launch (docs/TL_SPEC.md §7, §8): the LE tab
 * (TargetSetting.jsx) in TL words, on the same components - the form
 * language, the basket picker over the TL panel, the Airtable-style products
 * grid with a units target per work in place of the sell-through, the coupled
 * stretch sliders and the basket's channel table. The header holds the signup
 * target and what follows from it, recomputed live from shared/tlModel.mjs as
 * the boxes are typed, so the tab says what the build will say. Save posts
 * the inputs and follows the rebuild as the LE tab does.
 *
 * What differs from an LE is the target's unit. A timed launch is set a units
 * target (Airtable's, summed over the ticked works, typed over on the grid)
 * and measured, before its window opens, on the signups it gathers: the
 * header's figure is the signup target - orders needed over the signup ->
 * order rate - and the channel table reads signups and sessions where the
 * LE's reads units. The dates are the announce, the window's open (a time, in
 * Amsterdam) and its length, each with the other readings beside it and one
 * click to take one. The basket is picked on the same map as an LE's, over
 * the TL panel, among the launches of the same window length first.
 *
 * A basket picked by hand is previewed over the panel's rows (tlLiveProfile,
 * the shape of etl/tl.py basket_profile) until the save rebuilds the page;
 * the medians on the page are always the build's. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, MINUS, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import BasketPicker from "./BasketPicker.jsx";
import { Field, RoBox, TextBox, NumBox, Switch, Notice, CardHead, Campaigns, GRID, PCT, closedFor, typedKeys, ProductsGrid } from "./TargetSetting.jsx";
import { resolveProducts, releaseEconomics } from "../../shared/economics.mjs";
import { GROUPS as GROUP_KEYS, TL_CANNIBALISATION, applyChannelsOff, channelsOffOf, fullProfile, mixFallbacks, rebalanceShares, stretchWeights, tlEconomics, tlPaidValue, tlTargets } from "../../shared/tlModel.mjs";

// the five display groups, in the order the profile dicts are written
const GROUPS = [
  { key: "aa_email", name: "AA Email" },
  { key: "aa_social", name: "AA Meta" },
  { key: "referral_artist", name: "Referral artist" },
  { key: "search_direct_other", name: "Search / direct / other" },
  { key: "paid", name: "Paid" },
];
const LENGTHS = [["24", "24 hours"], ["48", "48 hours"], ["72", "3 days"], ["168", "7 days"]];
const PAID_COST_MIN_MEMBERS = 3;   // etl/tl.py: a basket's cost medians need three launches with spend
const TL_THIN = 6;                 // etl/tl.py TL_THIN: under this a basket is thin
const CANDIDATES_URL = "/api/tl/baskets/candidates";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fmtDate = (iso) => {
  if (!iso) return "";
  const t = Date.parse(/T/.test(String(iso)) ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : String(iso);
};
const fmtWhen = (iso) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" }) : String(iso);
};
// days only from three days up, as the page's chips (TLPage.jsx)
const hoursWords = (h) => (!(h > 0) ? "" : h % 24 === 0 && h >= 72 ? `${h / 24} days` : `${Math.round(h)} hours`);

/* Amsterdam wall-clock <-> UTC ISO, for the open's datetime box. */
const TZ = "Europe/Amsterdam";
function offsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (k) => Number(parts.find((p) => p.type === k).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((asUtc - utcMs) / 60000);
}
const toLocalInput = (iso) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t + offsetMinutes(t) * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (s) => {
  if (!s) return null;
  const guess = Date.parse(`${s}:00Z`);
  if (!Number.isFinite(guess)) return null;
  // the offset at the instant itself, read twice so a time near the clock change lands right
  let utc = guess - offsetMinutes(guess) * 60000;
  utc = guess - offsetMinutes(utc) * 60000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
};

/* ======================= the products grid's columns ======================= */

/* The LE grid's columns with a units target per work in place of the
 * sell-through and the computed target units: a timed launch's target is
 * Airtable's units target summed over the ticked works, uncapped by the
 * edition, and its works close together, so the Closes column goes too. */
const UNITS_TARGET_COL = {
  key: "units_target", label: "Units target", glyph: "#",
  tip: "Airtable's units target for this work. The launch's target is the sum over the ticked works, and the window is measured against it; the edition caps nothing here. Blank = Airtable's figure; type over it where you know better.",
};
const TL_GRID = GRID.filter((c) => !["target_sellthrough", "target_units", "launch_date"].includes(c.key))
  .flatMap((c) => (c.key === "edition" ? [c, UNITS_TARGET_COL] : [c]));

/* ======================= a basket's medians, live ======================= */

function quantile(values, q) {
  const v = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const median = (values) => quantile(values, 0.5);
const positive = (vals) => median(vals.filter((v) => typeof v === "number" && v > 0));

/* The medians of a set of the panel's rows, in the shape etl/tl.py
 * basket_profile writes (without the curves): what a basket picked by hand
 * reaches, previewed here until the build recomputes it on save. The group
 * shares are each group's median share renormalised, so share x total adds
 * back to the headline median, as the Python side does it. */
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

/* ======================= the basket's channel table ======================= */

/* Nobody types into it: what the basket's median gives each channel before
 * the window opens and what the target asks of it. The target signups are
 * the benchmark plus the channel's share of the stretch; the sessions are
 * what those signups need at the channel's session -> signup rate, which is
 * held at the benchmark - the uplift is asked of traffic and spend only. The
 * last column is the rate the window converts each channel's signups at,
 * which sets the signup target at the basket's mix. */
function TLBasketTable({ profile, off, T }) {
  const rows = GROUPS.map((g) => ({
    ...g, off: off.includes(g.key),
    bmS: (profile.signups_by_group || {})[g.key] || 0, bmSess: (profile.sessions_by_group || {})[g.key] || 0,
    conv: (profile.conv || {})[g.key] || 0, s2o: (profile.signup_order_rate_by_group || {})[g.key] || 0,
    tgS: T ? T.signups_by_group[g.key] : null,
    tgSess: T && T.sessions_by_group[g.key] !== null && T.sessions_by_group[g.key] !== undefined ? T.sessions_by_group[g.key] : null,
  }));
  const cell = (v) => (v === null || v === undefined ? "–" : fmt(v));
  return (
    <div className="ts-tblwrap">
      <table className="ts-table">
        <thead>
          <tr>
            <th className="l">Channel</th>
            <th className="bm" title="The basket's median signups from this channel before the window opened.">Benchmark signups</th>
            <th title="The benchmark plus this channel's share of the stretch: lifted by K everywhere unless the stretch was placed above, then by the channel's own share.">Target signups</th>
            <th className="bm" title="The basket's median pre-window sessions from this channel.">Benchmark sessions</th>
            <th title="The sessions the target signups need at the channel's session -> signup rate, held at the benchmark.">Target sessions</th>
            <th title="The basket's median share of this channel's sessions that sign up. Held at the benchmark: the uplift is asked of traffic and spend only.">Session → signup (held)</th>
            <th title="The basket's median share of this channel's signups that order in the window. A paid signup converts at a fraction of an email one, so the signup target is read at the basket's mix of these rates.">Signup → order</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => r.off ? (
            <tr key={r.key}>
              <td className="l" style={{ color: C.muted }}>{r.name}</td>
              <td className="off" colSpan={6} title="Set aside on this tab: its median leaves the benchmark and the other channels carry the whole target.">not in plan</td>
            </tr>
          ) : (
            <tr key={r.key}>
              <td className="l">{r.name}</td>
              <td className="bm">{fmt(r.bmS)}</td>
              <td className="tg">{cell(r.tgS)}</td>
              <td className="bm">{fmt(r.bmSess)}</td>
              <td className="tg">{cell(r.tgSess)}</td>
              <td>{r.conv > 0 ? fmtPct(r.conv, 1) : ""}</td>
              <td>{r.s2o > 0 ? fmtPct(r.s2o, 1) : ""}</td>
            </tr>
          ))}
          <tr className="foot">
            <td className="l">Total</td>
            <td className="bm">{fmt(profile.signups)}</td>
            <td>{T && T.signup_target !== null ? fmt(T.signup_target) : "–"}</td>
            <td className="bm">{fmt(profile.sessions)}</td>
            <td>{T && T.sessions_needed !== null ? fmt(T.sessions_needed) : "–"}</td>
            <td />
            <td title="The rate the signup target is read at: the basket's rates by channel, weighted by its share of signups from each.">{T && T.signup_order_rate > 0 ? fmtPct(T.signup_order_rate, 1) : ""}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ======================= the tab ======================= */

/* `directSpread`: the Overview is set to spread Direct over the other
 * channels (docs/TL_SPEC.md §3b). The plan here always reads Direct as a
 * channel of its own, so the tab says so rather than contradicting the
 * Channels card silently - as the LE tab does. */
export default function TLTargets({ snap, onSaved, directSpread = false }) {
  const [meta, setMeta] = useState(null);       // {inputs, sourced, benchmarks, meta_campaigns, derived, creating}
  const [inp, setInp] = useState(null);         // editable inputs
  const [pick, setPick] = useState(null);       // a basket chosen in the picker, not yet saved
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);
  const [buildSecs, setBuildSecs] = useState(null);   // how long the background rebuild has run
  const [editing, setEditing] = useState(false);      // the products card's figures unlocked
  const [compact, setCompact] = useState(false);      // the header, once the page has scrolled past it
  const [cands, setCands] = useState(null);           // the TL panel as the picker's rows, for a basket picked by hand
  const sentinel = useRef(null);

  useEffect(() => {
    let live = true;
    setMeta(null); setInp(null); setError(null); setPick(null); setPicking(false); setEditing(false);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (!live) return;
      if (d.error) { setError(d.error); return; }
      // a launch nobody has set targets for comes back with inputs: null and
      // the defaults the build could derive - the form starts from those
      const raw = d.inputs || d.defaults || {};
      const start = {
        ...raw, type: "TL",
        channels_off: Array.isArray(raw.channels_off) ? raw.channels_off : [],
        stretch_from: raw.stretch_from && typeof raw.stretch_from === "object" ? raw.stretch_from : null,
        products: Array.isArray(raw.products) ? raw.products : [],
        campaign_names: Array.isArray(raw.campaign_names) ? raw.campaign_names : (raw.campaign_name ? [raw.campaign_name] : []),
      };
      delete start.campaign_name;
      setMeta({ ...d, inputs: start, creating: !d.inputs });
      setInp({ ...start });
    }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [snap.id]);

  // the TL panel as the picker reads it, once: a basket picked by hand is
  // previewed over these rows until the build recomputes it
  useEffect(() => {
    let live = true;
    fetch(CANDIDATES_URL).then((r) => r.json()).then((d) => { if (live && d && !d.error) setCands(d.rows || []); }).catch(() => { /* no preview until the file is written */ });
    return () => { live = false; };
  }, []);

  const creating = !!(meta && meta.creating);
  const b = (meta && meta.benchmarks) || {};
  const sourced = (meta && meta.sourced) || { airtable: { match: "none", note: "", products: [] }, feed: {}, campaigns: [] };
  const atProducts = (sourced.airtable && sourced.airtable.products) || [];

  // the products in force and the release's economics, live as figures are
  // typed (shared/economics.mjs mirrors etl/tl.py _products for the works)
  const products = useMemo(() => (inp ? resolveProducts(atProducts, inp.products, b) : []), [inp, b, atProducts]);
  const econ = useMemo(() => (inp ? releaseEconomics(products, null, b) : null), [products, inp, b]);
  const candByName = useMemo(() => new Map((cands || []).map((r) => [r.release_name, r])), [cands]);
  const ready = !!(inp && econ);

  // the header compacts once the page has scrolled past where it started
  useEffect(() => {
    const el = sentinel.current;
    if (!ready || !el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([en]) => setCompact(!en.isIntersecting && en.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [ready]);

  // a rebuild still running from a save made before the reader left the
  // tab: pick it up again, counter and all
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
  const sd = snap.derived || {};
  const at = sourced.airtable || {}, feed = sourced.feed || {};
  const dirty = !!pick || JSON.stringify(inp) !== JSON.stringify(meta.inputs);

  /* ---- the dates in force and the other readings (docs/TL_SPEC.md §2):
   * typed, else as the build read them (Airtable's launch time, the feed's
   * hour less the summer hour, Airtable's length, 48 hours assumed) ---- */
  const dsrc = sd.dates_source || {};
  const feedOpen = feed.window_open_adjusted || feed.window_open || null;
  const announce = inp.announce_date || sd.announce_date || dv.announce_date || at.announce_date || feed.announce_date || "";
  const open = inp.window_open || sd.window_open || dv.window_open || at.window_open || feedOpen || "";
  const hoursInForce = Number(inp.window_hours) > 0 ? Number(inp.window_hours) : Number(sd.window_hours) > 0 ? Number(sd.window_hours)
    : Number(dv.window_hours) > 0 ? Number(dv.window_hours) : Number(at.window_hours) > 0 ? Number(at.window_hours) : 48;
  const SRC = { typed: "typed", airtable: "from Airtable", feed: "from the feed's launch time", feed_hour: "Airtable's day at the feed's hour",
                signups: "the first day with ten or more signups", assumed: "assumed", default: "assumed", airtable_end: "from Airtable's end date",
                derived: "as the build read it", "": "not known yet: type it" };
  const srcOf = (value, derivedValue, derivedSrc) => (value && String(value) !== String(derivedValue || "") ? "typed" : derivedSrc || (value ? "derived" : ""));
  const announceSrc = srcOf(announce, sd.announce_date || dv.announce_date, dsrc.announce);
  const openSrc = srcOf(open, sd.window_open || dv.window_open, dsrc.open);
  const hoursSrc = srcOf(hoursInForce, sd.window_hours || dv.window_hours, dsrc.hours);
  const closeIso = open ? new Date(Date.parse(open) + hoursInForce * 3600000).toISOString() : null;
  const preDays = announce && open ? Math.round((Date.parse(open) - Date.parse(`${String(announce).slice(0, 10)}T00:00:00Z`)) / 86400000) : null;
  const useIt = (f, v) => (
    <button type="button" className="ts-link" onClick={() => setInp({ ...inp, [f]: v })} title={`Type ${/T/.test(String(v)) ? fmtWhen(v) : fmtDate(v)} here`}>use it</button>
  );
  // a date another source puts elsewhere than the one in force, said beside
  // it with one click to take the other reading
  const others = (value, readings) => readings.filter(([, v]) => v && String(v) !== String(value));

  /* ---- the products and the economics: the units target is Airtable's,
   * summed over the ticked works and typed over per work; the price is
   * weighted by each work's units target, else its edition (etl/tl.py
   * _products reads them the same way) ---- */
  const live = products.filter((p) => !p.excluded);
  const unitsSum = live.reduce((s, p) => s + (p.units_target || 0), 0);
  const airtableUnits = unitsSum > 0 ? unitsSum : null;
  const editionSize = live.reduce((s, p) => s + (p.edition || 0), 0) || null;
  const priced = live.filter((p) => p.unit_price_eur > 0);
  const weight = (p) => p.units_target || p.edition || 0;
  const w = priced.reduce((s, p) => s + weight(p), 0);
  const price = w > 0 ? priced.reduce((s, p) => s + weight(p) * p.unit_price_eur, 0) / w : priced.length ? priced.reduce((s, p) => s + p.unit_price_eur, 0) / priced.length : 0;
  const releaseUnits = Number(inp.units_target) > 0 ? Number(inp.units_target) : null;   // a target typed for the launch as a whole, over the works'
  const unitsTarget = releaseUnits || airtableUnits;
  const launchValue = unitsTarget && price ? unitsTarget * price : 0;
  const econTL = { ...econ, unit_price: price, launch_value: launchValue };

  /* ---- the products grid's handlers, as on the LE tab: a typed figure lands
   * on the entry for that product (by Airtable id, or by name for one added
   * by hand), blank clears it ---- */
  const sameEntry = (t, p) => (p.airtable_id ? String(t.airtable_id) === String(p.airtable_id) : (t.manual && norm(t.name) === norm(p.name)));
  const applyEntry = (list, p, patch) => {
    const out = [...list];
    let i = out.findIndex((t) => sameEntry(t, p));
    if (i < 0) { out.push(p.airtable_id ? { airtable_id: p.airtable_id } : { manual: true, name: p.name }); i = out.length - 1; }
    out[i] = { ...out[i], ...patch };
    return out;
  };
  // what a typed figure means: a fraction for the percentages, a whole
  // number for an edition or a units target, null for a cleared box,
  // undefined for nonsense
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
    const open_ = products.filter((p) => !closedFor(p, key));
    setInp((prev) => ({ ...prev, products: open_.reduce((list, p) => applyEntry(list, p, patchFor(key, v)), prev.products || []) }));
  };
  const onName = (p, name) => setInp({ ...inp, products: (inp.products || []).map((t) => (t.manual && norm(t.name) === norm(p.name) ? { ...t, name } : t)) });
  const onAdd = () => {
    const n = (inp.products || []).filter((t) => t.manual).length + 1;
    setInp({ ...inp, products: [...(inp.products || []), { manual: true, name: `Product ${n}` }] });
  };
  const onRemove = (p) => setInp({ ...inp, products: (inp.products || []).filter((t) => !(t.manual && norm(t.name) === norm(p.name))) });
  const bare = (t) => Object.entries(t).every(([k, v]) => k === "airtable_id" || k === "manual" || (k === "name" && !t.manual) || v === null || v === undefined || v === "");
  const onInclude = (p, on) => setInp((prev) => {
    const list = prev.products || [];
    if (!on) return { ...prev, products: applyEntry(list, p, { excluded: true }) };
    const out = list.map((t) => (sameEntry(t, p) ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== "excluded")) : t));
    return { ...prev, products: out.filter((t) => !(sameEntry(t, p) && t.airtable_id && bare(t))) };
  });
  const onReset = (p) => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => ((p.airtable_id && String(t.airtable_id) === String(p.airtable_id))
    ? (t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : []) : [t])) }));
  const onResetAll = () => setInp((prev) => ({ ...prev, products: (prev.products || []).flatMap((t) => (!t.airtable_id ? [t] : t.excluded ? [{ airtable_id: t.airtable_id, excluded: true }] : [])) }));
  const typedCount = products.filter((p) => p.airtable_id).reduce((s, p) => s + typedKeys(p).length, 0);
  const manualCount = products.filter((p) => !p.airtable_id).length;
  const excludedCount = products.filter((p) => p.excluded).length;
  // the picker asks for a target and a price when there are none: they land
  // on a product added by hand (its units target and its price), so the
  // basket follows the typing; its paid switch is this tab's
  const onPickerInputs = (patch) => setInp((prev) => {
    const next = { ...prev };
    if (patch.channels_off !== undefined) next.channels_off = patch.channels_off;
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

  /* ---- the basket and the channels (spec §8) ---- */
  const bm = snap.benchmark || null;
  const baskets = snap.baskets || [];
  const spec = inp.benchmark_basket || null;
  const savedSpec = (meta.inputs && meta.inputs.benchmark_basket) || null;
  const basketDirty = JSON.stringify(spec) !== JSON.stringify(savedSpec);
  // a pick's medians over the panel's rows (the ready basket's from the
  // page when the rows are not here); else the page's basket, read whole
  const pickRows = pick ? (pick.members || []).map((m) => candByName.get(m)).filter(Boolean) : [];
  const pickProfile = pick ? (pickRows.length ? tlLiveProfile(pickRows) : (pick.kind === "ready" && (baskets.find((x) => x.id === pick.id) || {}).profile) || null) : null;
  const prof = pickProfile || (bm && bm.profile ? fullProfile(bm.profile) : null);
  const previewPending = !!pick && !pickProfile;
  const basketName = pick ? pick.name : (bm && bm.basket && bm.basket.name) || (spec && spec.name) || "";
  const off = channelsOffOf(inp);
  const isOff = (g) => off.includes(g);
  const setOff = (g, on) => setInp({ ...inp, channels_off: on ? off.filter((x) => x !== g) : [...off, g] });
  const paidOff = isOff("paid");
  const profile = prof ? applyChannelsOff(prof, off) : null;
  const T = profile ? tlTargets(inp, airtableUnits, profile, launchValue, b) : null;
  // what a paid signup is worth to Avant Arte, on the works' profit and framing
  // figures and the basket's paid conversion (shared/tlModel.mjs tlPaidValue,
  // the figure the Overview's paid card reads its ROI against); a work's frame
  // take-up is its own figure or none, the default being the model's to apply
  const econRows = products.map((p) => ({ ...p, frame_conversion: p.sources && p.sources.frame_conversion === "default" ? null : p.frame_conversion }));
  const PV = T ? tlPaidValue(inp, profile, T, tlEconomics(econRows), b) : null;
  const pvOk = !!(PV && PV.readable && PV.value_per_signup !== null);
  const S2O_PAID_WORDS = { release: "typed", basket_paid: "the basket's paid rate", basket: "the basket's blended rate", none: "no rate on file" };
  const FRAME_WORDS = { release: "the works' own take-up", basket: "the basket's frames per print", default: "the default take-up" };
  const BM = T ? T.benchmark : null;
  const k = T ? T.k : null;
  const stretchTyped = !!(T && T.stretch_typed);
  /* the sliders: the shares in force (placed, else the basket's own) over
   * the groups in plan with a benchmark to lift; moving one rescales the
   * others so they always add to 100 (shared/benchmarkModel.mjs) */
  const activeGroups = profile ? GROUP_KEYS.filter((g) => !isOff(g) && Number((profile.signups_by_group || {})[g]) > 0) : [];
  const evenShares = profile ? stretchWeights({ stretch_from: null }, profile.signups_by_group) : {};
  // the signups of stretch a channel carries at the shares set: its target less its benchmark (tlTargets)
  const stretchOf = (key) => (T && BM ? Number((T.signups_by_group || {})[key] || 0) - Number((BM.signups_by_group || {})[key] || 0) : 0);
  const shares = T && T.stretch_from ? T.stretch_from : evenShares;
  const slideStretch = (key) => (e) => setInp({ ...inp, stretch_from: rebalanceShares(shares, key, Number(e.target.value) / 100, activeGroups) });

  const onPick = (chosen) => {
    setPick(chosen);
    setPicking(false);
    setInp({
      ...inp,
      benchmark_basket: chosen.kind === "bespoke"
        ? { kind: "bespoke", members: chosen.members, name: chosen.name }
        : { kind: "ready", id: chosen.id },
      // the picker's recency switch is a release input: the rule reads it on
      // every rebuild, so the suggestion stays the one that was looked at
      prefer_recent: chosen.preferRecent !== false,
    });
  };

  // what the targets still need before the launch can be set up
  const missing = [];
  if (!(unitsTarget > 0)) missing.push("a units target (Airtable's for the ticked works, or typed on the grid)");
  if (!announce) missing.push("the announce date");
  if (!open) missing.push("the window open");

  const save = async () => {
    setSaving(true); setError(null); setBuildSecs(null);
    try {
      const { campaign_name, ...rest } = inp;
      const body = { ...rest, type: "TL", channels_off: off, announce_date: announce ? String(announce).slice(0, 10) : null,
                     window_open: open || null, window_hours: Number(inp.window_hours) > 0 ? Number(inp.window_hours) : (rest.window_hours || null),
                     launch_end: closeIso ? closeIso.slice(0, 10) : rest.launch_end || null };
      const res = await fetch(`/api/inputs/${snap.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: body }) });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `save failed (${res.status})`); return; }
      if (d.warning) setError(d.warning);
      // the inputs are saved at this point, whatever the rebuild does next
      setMeta({ ...meta, creating: false, inputs: { ...inp }, storage: d.storage || meta.storage });
      setPick(null);
      let snapshot = d.snapshot || null;
      if (d.queued) snapshot = await followBuild(Date.now());
      if (snapshot) onSaved(snapshot);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(String(e)); } finally { setSaving(false); setBuildSecs(null); }
  };
  const discard = () => { setInp({ ...meta.inputs }); setPick(null); };

  /* Follow the rebuild running behind a save until it lands, counting the
   * seconds, then read the page as rebuilt. */
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

  /* ---- the header's figures (spec §7), from the model the build runs ---- */
  const signed = (v) => (v < 0 ? MINUS : "+") + fmt(Math.abs(v), 0);
  const figure = (label, target, bmv, format, tip, opts = {}) => {
    let stretch = target === null || bmv === null || target === undefined || bmv === undefined ? null : target - bmv;
    if (stretch !== null && format(Math.abs(stretch)) === format(0)) stretch = 0;
    const subs = opts.paid && paidOff ? ["not in plan"]
      : opts.sense ? [`benchmark ${bmv === null || bmv === undefined ? "–" : format(bmv)}`, `${opts.sense.breached ? "over" : "under"} the 6% sense check`]
        : [`benchmark ${bmv === null || bmv === undefined ? "–" : format(bmv)}`, `stretch ${stretch === null ? "–" : (stretch < 0 ? MINUS : "+") + format(Math.abs(stretch))}`];
    return { label, tip, value: opts.paid && paidOff ? "–" : target === null || target === undefined ? "–" : format(target), subs, red: !!(opts.sense && opts.sense.breached) };
  };
  const figures = T ? [
    figure("Orders needed", T.orders_needed, BM.units > 0 && T.purchases_per_order ? BM.units / T.purchases_per_order : null, (v) => fmt(v, 0), `The units target over ${fmt(T.purchases_per_order, 2)} pieces an order.`),
    figure("Paid signups", T.paid_signups, BM.paid_signups, (v) => fmt(v, 0), "The basket's median paid signups plus paid's share of the stretch.", { paid: true }),
    figure("Sessions", T.sessions_needed, BM.sessions, (v) => fmt(v, 0), "Each channel's signup target over its benchmark session -> signup rate."),
    figure("Pre-window budget", T.budget_pre, BM.budget_pre, (v) => fmtMoney(v, 0), `Paid signups × ${T.cost_per_signup ? fmtMoney(T.cost_per_signup, 2) : "–"} a signup (${T.cost_per_signup_source === "release" ? "typed" : "the basket's median"}).`, { paid: true }),
    figure("Window budget", T.budget_window, null, (v) => fmtMoney(v, 0), `Paid's share of the units target × ${T.cost_per_sale ? fmtMoney(T.cost_per_sale, 0) : "–"} a sale (${T.cost_per_sale_source === "release" ? "typed" : "the basket's median"}).`, { paid: true }),
    figure("Of launch value", T.budget_pct_of_launch_value ?? 0, null, (v) => fmtPct(v, 1), "Sense check: the two budgets together should stay under 6% of launch value.", { paid: true, sense: { breached: !!T.sense_check_breached } }),
  ] : [];

  /* ---- the words ---- */
  const leadCap = !T ? "signup target: a units target and a basket are needed"
    : `signups by the open · ${fmt(T.units_target)} units ÷ ${fmt(T.purchases_per_order, 2)} an order ÷ ${fmtPct(T.signup_order_rate, 1)} · ${k ? `×${fmt(k, 2)} the basket's median` : "no benchmark"}`;
  const saveLabel = saving ? (buildSecs !== null ? `Rebuilding the page… ${buildSecs}s` : "Saving…") : savedFlash ? "✓ Saved" : creating ? "Set targets" : "Save targets";
  const stateText = saving ? null
    : missing.length ? `Needs ${missing.join(", ")}`
      : dirty ? (basketDirty ? "Unsaved changes · a new basket rebuilds from the panel, a longer save" : "Unsaved changes")
        : creating ? "Not set up yet - the page runs on Airtable's target and the suggested basket" : null;
  const s2oWords = { release: "typed", basket_mix: "the basket's rates by channel, at its mix of signups", basket: "the basket's median", none: "no rate on file" };
  const rateHelp = T ? `${s2oWords[T.signup_order_rate_source]}${T.signup_order_rate_source === "basket_mix" ? `: ${GROUPS.filter((g) => T.signup_order_rate_by_group[g.key] > 0).map((g) => `${g.name} ${fmtPct(T.signup_order_rate_by_group[g.key], 1)}`).join(", ")}` : ""}. The share of signups that order in the window; it sets the signup target.` : "Choose a basket first.";
  const stretchHelp = !T ? "Choose a basket first."
    : stretchTyped
      ? `The stretch of ${signed(Math.round((T.signup_target || 0) - BM.signups))} signups is asked of ${GROUPS.filter((g) => T.stretch_from[g.key] > 0).sort((x, y) => T.stretch_from[y.key] - T.stretch_from[x.key]).map((g) => `${g.name} ${Math.round(100 * T.stretch_from[g.key])}%`).join(", ")}; the other channels stay at their benchmark.`
      : `Blank: each channel takes its share of the ${signed(Math.round((T.signup_target || 0) - BM.signups))}-signup stretch in proportion to its benchmark, the same uplift ×${fmt(k || 1, 2)} everywhere. Drag a slider to place it, most of it on paid, say: the other channels follow, so the shares always add to 100%.`;
  const channelsHelp = [
    paidOff ? "Paid off: no paid signups and no budget; the basket is read without its paid signups and the other channels carry the whole target." : null,
    isOff("referral_artist") ? "Artist off: no artist target, as for an estate or an artist who will not post." : null,
  ].filter(Boolean).join(" ") || "Off takes the channel's median out of the benchmark and its share out of the target; the other channels carry the whole signup target.";
  // the one thing the basket field has to say: that a new pick is not the page's yet
  const basketNote = previewPending ? "Not saved yet: the panel's rows are not here to preview this basket, so the figures below are the saved basket's until the save rebuilds the page."
    : basketDirty ? "Not saved yet: the figures below follow the launches picked; save to rebuild the page on them." : null;
  const airtableMatch = at.match || "none";
  const airtableNote = at.note || "";
  const productsDesc = airtableMatch !== "none"
    ? `${atProducts.length} work${atProducts.length === 1 ? "" : "s"} from Airtable, matched by ${airtableMatch}`
    : `Airtable has no record matched to this launch${airtableNote ? ` - ${airtableNote}` : ""}`;
  const productsState = [
    editing ? "Editing" : atProducts.length ? "Figures from Airtable" : null,
    typedCount ? `${typedCount} figure${typedCount === 1 ? "" : "s"} typed over Airtable` : null,
    manualCount ? `${manualCount} product${manualCount === 1 ? "" : "s"} added by hand` : null,
    excludedCount ? `${excludedCount} unticked` : null,
  ].filter(Boolean).join(" · ");
  const pct1 = (v) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 1000) / 10));
  const nCps = profile ? profile.n_cost_per_signup || 0 : 0, nCpu = profile ? profile.n_cost_per_sale || 0 : 0;
  const basketCps = profile && Number(profile.cost_per_signup) > 0 ? Number(profile.cost_per_signup) : 0;
  const basketCpu = profile && Number(profile.cost_per_sale) > 0 ? Number(profile.cost_per_sale) : 0;

  return (
    <>
      <div ref={sentinel} style={{ height: 1, marginBottom: -1 }} aria-hidden="true" />
      <div className={`ts-head${compact ? " compact" : ""}`}>
        <div className="ts-head-top">
          <div style={{ minWidth: 0 }}>
            <div className="ts-eyebrow">Signup target · {snap.releaseName}</div>
            <div className="ts-lead">
              <span className="ts-big" title="The signups the window needs by its open: the units target over pieces per order, over the signup -> order rate.">{T && T.signup_target ? fmt(T.signup_target) : "–"}</span>
              <span className="ts-lead-cap">{leadCap}</span>
            </div>
          </div>
          <div className="ts-actions">
            {stateText && <span className={`ts-state${missing.length ? " warn" : ""}`}>{stateText}</span>}
            <button type="button" className="ts-btn secondary" onClick={discard} disabled={saving || !dirty} title="Back to what is saved.">Discard</button>
            <button type="button" className="ts-btn primary" disabled={saving || missing.length > 0} onClick={save}
              title={missing.length ? `Still needed: ${missing.join(", ")}` : "Saves the inputs and rebuilds this launch's page on them."}>{saveLabel}</button>
          </div>
        </div>
        <div className="ts-figures">
          {T ? figures.map((f) => (
            <div key={f.label} className="ts-fig" title={f.tip}>
              <span className="ts-fig-label">{f.label}</span>
              <span className={`ts-fig-val${f.red ? " red" : ""}`}>{f.value}</span>
              <span className="ts-fig-sub">{f.subs.map((s, i) => <span key={i} className={i === 1 && f.red ? "red" : undefined}>{s}</span>)}</span>
            </div>
          )) : (
            <div className="ts-caption" style={{ padding: "8px 0 2px" }}>
              {unitsTarget > 0 ? "Choose a basket to see the benchmark and the signup target it gives." : "A units target is needed: Airtable's for the ticked works, or typed on the grid below."}
            </div>
          )}
        </div>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="ts" style={{ marginTop: 24 }}>
        {creating && (
          <Notice>
            <b>Timed launch.</b> The page already runs on Airtable's units target, the suggested basket and the dates below{sd.dates_note || dv.dates_note ? ` (${sd.dates_note || dv.dates_note})` : ""}.
            Check the dates and the Meta campaign, set the channels in plan and the basket, type over a rate where you know better, and save: the targets are then yours rather than the defaults.
          </Notice>
        )}
        {meta.storage && meta.storage.durable === false && (
          <Notice red>
            <span title={`Saves are written to ${meta.storage.path}`}><b>Targets saved here do not survive a deploy.</b> The service keeps them on its own disk, which Render resets on
            every deploy. Point SAVED_INPUTS_PATH at a file on a persistent disk (README, "Render's disk resets") and they stay.</span>
          </Notice>
        )}

        <section className="ts-card" aria-label="Release and timeline">
          <CardHead dot="#b8862d" title="Release & timeline" />
          <div className="ts-grid c2">
            <Field label="Release name" src="the join key across every feed" tip="The release's name in the TL funnel report, Airtable and the orders table - the join key across every feed, so it is fixed here.">
              <RoBox value={snap.releaseName} />
            </Field>
            <Field label="Campaign code" src={inp.campaign_code && inp.campaign_code !== (sd.campaign_code || dv.campaign_code) ? "typed" : sd.campaign_code || dv.campaign_code ? ((sd.code_source || dv.code_source) === "airtable" ? "from Airtable" : "guessed from the codes moving on Meta and in the sends") : "not found in any feed"}
              tip="The code the Meta campaigns and the sends carry (BisaButler_TL_26): it joins the spend and the emails to the launch. Guessed from the codes moving around the announce; type over it where the guess is wrong.">
              <TextBox value={inp.campaign_code || ""} onChange={set("campaign_code")} placeholder={sd.campaign_code || dv.campaign_code || "Artist_TL_26"} />
            </Field>
            <Field label="Marketing lead" src={at.marketing_lead ? "Airtable" : "typed"} help={at.marketing_lead ? null : "Not in Airtable yet: typed here until it is."}>
              {at.marketing_lead
                ? <RoBox value={at.marketing_lead} title="From Airtable" />
                : <TextBox value={inp.marketing_lead || ""} onChange={set("marketing_lead")} placeholder="Who runs this launch" />}
            </Field>
            <Field label="Meta campaigns" src="paid actuals are read from these"
              tip="Which Meta ad campaigns this launch's paid actuals are read from: the Sign-ups campaign buys the pre-window's signups and the Purchases campaign the window's sales. Both named for the code are suggested; add another by name when it belongs to this launch.">
              <Campaigns code={inp.campaign_code || sd.campaign_code || dv.campaign_code || ""} chosen={inp.campaign_names || []} all={meta.meta_campaigns} suggested={sourced.campaigns}
                onChange={(names) => setInp({ ...inp, campaign_names: names })} />
            </Field>
            <div className="ts-grid c3" style={{ alignContent: "start", gridColumn: "1 / -1" }}>
              <Field label="Announced" src={SRC[announceSrc]} tip="The day the launch was announced: the pre-window starts here, and signups before it count in the headline. Typed, else Airtable's announce date (the latest before the open), else the feed's."
                help={<>{others(announce, [["Airtable has", at.announce_date], ["the feed has", feed.announce_date]]).map(([n, v]) => <span key={n}>{n} {fmtDate(v)} {useIt("announce_date", v)} · </span>)}the pre-window runs from here to the open</>}>
                <div className="ts-box"><input type="date" value={(announce || "").slice(0, 10)} onChange={set("announce_date")} /></div>
              </Field>
              <Field label="Window opens" src={SRC[openSrc]} tip="The public open. Typed, else Airtable's launch time, else the feed's launch time less the hour it runs late in summer time, else 14:00 Amsterdam on the launch date. The early access starts about a day before."
                help={<>{others(open, [["Airtable has", at.window_open], ["the feed has", feedOpen]]).map(([n, v]) => <span key={n}>{n} {fmtWhen(v)} {useIt("window_open", v)} · </span>)}
                  Amsterdam time · {feed.window_open && feed.window_open_adjusted ? "the feed's timestamp runs an hour late in summer time; the adjusted reading is shown" : "the public open; the early access starts about a day before"}</>}>
                <div className="ts-box"><input type="datetime-local" value={toLocalInput(open)} onChange={(e) => setInp({ ...inp, window_open: fromLocalInput(e.target.value) })} /></div>
              </Field>
              <Field label="Window length" src={SRC[hoursSrc]} tip="How long the window stays open. Typed, else Airtable's TL length, else its end date, else 48 hours assumed."
                help={<>closes {closeIso ? fmtWhen(closeIso) : "–"}{Number(at.window_hours) > 0 && Number(at.window_hours) !== hoursInForce ? <span> · Airtable has {hoursWords(Number(at.window_hours))} {useIt("window_hours", Number(at.window_hours))}</span> : null}</>}>
                <div className="ts-row">
                  <div className="ts-box" style={{ flex: 1 }}>
                    <select value={LENGTHS.some(([h]) => Number(h) === hoursInForce) ? String(hoursInForce) : "custom"} onChange={(e) => setInp({ ...inp, window_hours: e.target.value === "custom" ? hoursInForce : Number(e.target.value) })}>
                      {LENGTHS.map(([h, wds]) => <option key={h} value={h}>{wds}</option>)}
                      <option value="custom">custom</option>
                    </select>
                  </div>
                  <NumBox value={hoursInForce} unit="h" title="The window in hours"
                    onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, window_hours: c === "" ? null : Number(c) })); }} />
                </div>
              </Field>
            </div>
          </div>
          <div className="ts-caption">
            Pre-window <b>{preDays === null ? "–" : preDays}</b> days, announce to open · the window runs <b>{hoursWords(hoursInForce)}</b>, closing <b>{closeIso ? fmtWhen(closeIso) : "–"}</b> Amsterdam time
            {snap.earlyAccessOpen ? <> · the early access {snap.earlyAccessAssumed ? "is expected" : "opened"} {fmtWhen(snap.earlyAccessOpen)}</> : null}.
          </div>
        </section>

        <section className="ts-card" aria-label="Benchmark basket">
          <CardHead dot={C.blue} title="Benchmark basket" desc="the median of timed launches like this one" />
          <div className="ts-grid c2">
            <Field label="Basket" help={basketNote} tip="The completed timed launches this one is benchmarked against. The benchmark is their median, per metric and per channel; the launches of the same window length come first.">
              <div className="ts-row">
                <RoBox value={basketName || "none chosen yet"} />
                <button type="button" className="ts-btn secondary" onClick={() => setPicking(true)}
                  title="Opens the basket picker: every completed timed launch on a map of units sold against price, the nearest ticked.">Change basket</button>
              </div>
            </Field>
            <Field label="Channels in plan" help={channelsHelp}
              tip="A channel this launch will not run leaves the benchmark and the target: the basket is read on its other channels, and they carry the whole signup target between them.">
              <div className="ts-switches">
                <Switch on={!paidOff} onChange={(on) => setOff("paid", on)} label="Running paid"
                  title="The basket keeps every launch, paid or not; with paid off each counts on its other channels only, and there is no budget." />
                <Switch on={!isOff("referral_artist")} onChange={(on) => setOff("referral_artist", on)} label="Artist's own channels"
                  title="Off for an estate, or a living artist with no channels of their own. The artist group leaves the benchmark and the target." />
              </div>
            </Field>
          </div>
          {profile && (
            <div className="ts-grid" style={{ marginTop: 20 }}>
              <Field label="Where the stretch comes from" help={stretchHelp} src={T && BM ? `stretch ${signed(Math.round((T.signup_target || 0) - BM.signups))} signups` : undefined}
                tip="How the gap between the signup target and the basket's median is shared out. Each channel's target is its benchmark plus its share of the stretch, with its sessions lifted to match and its rate held. Even: the basket's own shares, the same uplift in every channel. Drag one channel's slider and the others rescale, so the shares always add to 100%.">
                <div className="ts-stretch">
                  <div className="ts-sliders">
                    {GROUPS.map((g) => {
                      const gOff = isOff(g.key);
                      const active = activeGroups.includes(g.key);
                      const pct = active ? Math.round(100 * Number(shares[g.key] || 0)) : 0;
                      const basketPct = active ? Math.round(100 * Number(evenShares[g.key] || 0)) : 0;
                      return (
                        <label key={g.key} className={`ts-slider${active ? "" : " dis"}`}
                          title={gOff ? "Not in plan: this channel takes none of the stretch." : !active ? "No benchmark in the basket to lift: nothing to place here."
                            : "Drag to set this channel's share of the stretch; the others rescale so the shares add to 100."}>
                          <span className="head"><span>{g.name}{gOff ? " · not in plan" : !active ? " · no benchmark" : ""}</span><b>{active ? `${pct}%` : "–"}</b></span>
                          <input type="range" min="0" max="100" step="1" disabled={!active || activeGroups.length < 2} value={pct}
                            aria-label={`${g.name}: share of the stretch`} onChange={slideStretch(g.key)} />
                          <span className="note">{active ? `${signed(Math.round(stretchOf(g.key)))} signups${stretchTyped && basketPct !== pct ? ` · basket ${basketPct}%` : ""}` : ""}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="ts-row" style={{ gap: 8, marginTop: 10 }}>
                    <button type="button" className="ts-btn secondary" disabled={!stretchTyped} onClick={() => setInp({ ...inp, stretch_from: null })}
                      title="Back to the basket's own shares: the same uplift in every channel.">Even</button>
                    <button type="button" className="ts-btn secondary" disabled={paidOff || !activeGroups.includes("paid")} onClick={() => setInp({ ...inp, stretch_from: { paid: 1 } })}
                      title="The whole stretch from paid: the other channels stay at their benchmark.">All from paid</button>
                  </div>
                </div>
              </Field>
            </div>
          )}
          {profile ? <TLBasketTable profile={profile} off={off} T={T} /> : (
            <div className="ts-caption">
              No completed timed launch to benchmark against yet. A launch saved without a basket is benchmarked against the launches nearest its units target and price, of its window length first.
            </div>
          )}
          <div className="ts-caption">
            {stretchTyped
              ? <>The signup target is the benchmark plus the stretch, placed as above, <b>×{k ? fmt(k, 2) : "–"}</b> over the basket's median signups in all. </>
              : <>The signup target is the benchmark lifted by <b>×{k ? fmt(k, 2) : "–"}</b> in every channel. </>}
            Session → signup rates are held at the benchmark: the uplift is asked of traffic and spend only. The signup → order rate is the basket's, read at its mix of channels, since a paid signup converts at a fraction of an email one.
          </div>
          {directSpread && (
            <div className="ts-caption">
              Direct is read as a channel of its own here, as the TL feed attributes it. The Overview is set to spread it over the other channels,
              so its Channels card splits the same plan differently; the signup target and the paid budget are the same either way.
            </div>
          )}
        </section>

        <section className="ts-card" aria-label="Products and economics">
          <CardHead dot="#8a7a52" title="Products & economics" desc={productsDesc}
            right={(
              <>
                <span className="ts-state">
                  {productsState}
                  {editing && typedCount > 0 && <> · <button type="button" className="ts-link" onClick={onResetAll} title="Drop every typed figure: back to Airtable's on every product.">Reset all</button></>}
                </span>
                <Switch on={editing} onChange={setEditing} label="Edit figures"
                  title={editing ? "Lock the figures again; what was typed stays." : "Unlock the figures to type over Airtable's, or to add a work by hand."} />
              </>
            )} />
          {releaseUnits && (
            <Notice action={(
              <button type="button" className="ts-btn secondary" onClick={() => setInp({ ...inp, units_target: null })}
                title="Drop the launch-level target: the works' targets carry it from the next save.">Use the works' targets</button>
            )}>
              <b>A units target of {fmt(releaseUnits)} is typed for the launch as a whole.</b> It stands over the works' targets below{airtableUnits ? ` (${fmt(airtableUnits)} over the ticked works)` : ""}; clear it and the works carry the target.
            </Notice>
          )}
          <ProductsGrid products={products} econ={econTL} editing={editing} onField={onField} onFieldAll={onFieldAll} onName={onName}
            onAdd={onAdd} onRemove={onRemove} onReset={onReset} onInclude={onInclude} emptyNote={airtableNote} columns={TL_GRID}
            caption={<>The last row is the launch as a whole: edition and units target summed over the ticked works, price weighted by units target,
              the profits and the share per unit, and the framing uplift per unit. A work's units target is Airtable's, typed over here; the edition caps nothing.
              A product has a revenue share or a profit share, never both: fill one and the other closes. Framing profit is Avant Arte's alone.</>} />
          <div className="ts-caption">
            Units target <b>{unitsTarget ? fmt(unitsTarget) : "–"}</b>{releaseUnits ? " typed for the launch" : airtableUnits ? ` over ${live.length} ticked work${live.length === 1 ? "" : "s"}` : " (none yet)"}
            {editionSize ? <> · edition <b>{fmt(editionSize)}</b></> : null}
            {" · "}launch value <b>{fmtMoney(launchValue, 0)}</b>{price > 0 ? ` at ${fmtMoney(price, 0)} a unit` : ""}
            {econ.ppu_artist > 0 || econ.ppu_aa > 0 ? <> · artist <b>{fmtMoney(econ.ppu_artist, 2)}</b> and AA <b>{fmtMoney(econ.ppu_aa, 2)}</b> per unit{econ.frame_uplift_per_unit > 0 ? ` (incl. ${fmtMoney(econ.frame_uplift_per_unit, 2)} framing)` : ""}</> : null}
          </div>
        </section>

        <section className="ts-card" aria-label="Assumptions">
          <CardHead dot="#c96a3a" title="Assumptions" desc="blank means the basket's median" />
          <div className="ts-grid c3">
            <Field label="Signup → order rate" src={Number(inp.signup_order_rate) > 0 ? "typed" : "blank = the basket's"} help={rateHelp}
              tip="What share of the pre-window signups order in the window. Blank reads the basket: each channel's median rate weighted by the basket's share of signups from it. Type a figure only to override that.">
              <NumBox value={pct1(inp.signup_order_rate)} placeholder={T && T.signup_order_rate > 0 ? pct1(T.signup_order_rate) : ""} unit="%"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), 0, 100) / 100; setInp((prev) => ({ ...prev, signup_order_rate: v === null || Number.isNaN(v) ? null : v })); }} />
            </Field>
            <Field label="Pieces per order" src={Number(inp.purchases_per_order) > 0 ? "typed" : `blank = the basket's median${profile && profile.purchases_per_order > 0 ? ` (${fmt(profile.purchases_per_order, 2)})` : ""}`}
              help="How many pieces a buyer takes in one order: the units target over this is the orders needed."
              tip="The basket's median pieces per order; a launch of several works, or of multiples, runs higher.">
              <NumBox value={inp.purchases_per_order === null || inp.purchases_per_order === undefined ? "" : String(inp.purchases_per_order)} placeholder={profile && profile.purchases_per_order > 0 ? fmt(profile.purchases_per_order, 2) : "1.00"}
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, purchases_per_order: c === "" ? null : c })); }} />
            </Field>
            <Field label="Paid cannibalisation" src={`blank = ${Math.round(100 * TL_CANNIBALISATION)}%`}
              help={`The share of paid signups that would have come anyway. Blank = the ${Math.round(100 * TL_CANNIBALISATION)}% standard for timed launches.`}>
              <NumBox value={inp.cannibalisation === null || inp.cannibalisation === undefined ? "" : String(Math.round(Number(inp.cannibalisation) * 1000) / 10)}
                placeholder={String(Math.round(100 * TL_CANNIBALISATION))} unit="%"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); const v = c === "" ? null : clamp(parseFloat(c), 0, 95) / 100; setInp((prev) => ({ ...prev, cannibalisation: v === null || Number.isNaN(v) ? null : v })); }} />
            </Field>
            <Field label="Cost per signup"
              src={(basketCps > 0 ? `blank = the basket's median (${nCps} with spend)` : `blank = none on file (${nCps} of ${PAID_COST_MIN_MEMBERS} with spend)`)
                + (pvOk && PV.cost_per_signup_at_target_roi ? ` · ${fmtMoney(PV.cost_per_signup_at_target_roi, 2)} at the target ROI` : "")}
              help={basketCps > 0 ? `Paid signups at this price is the pre-window budget. Blank reads the basket: each launch's Sign-ups spend over the paid signups it bought, ${nCps} launches with spend on file.`
                : `Paid signups at this price is the pre-window budget. Blank reads the basket once ${PAID_COST_MIN_MEMBERS} of its launches have spend on file (${nCps} do today); until then there is no pre-window budget.`}
              tip="What a paid signup costs to buy, in euros: each launch's Sign-ups campaign spend over the paid signups it bought, the untracked signups folded in at the paid share.">
              <NumBox value={inp.cost_per_signup === null || inp.cost_per_signup === undefined ? "" : String(inp.cost_per_signup)} placeholder={basketCps > 0 ? fmt(basketCps, 2) : ""} unit="€"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, cost_per_signup: c === "" ? null : c })); }} />
            </Field>
            <Field label="Cost per sale"
              src={basketCpu > 0 ? `blank = the basket's median (${nCpu} with spend)` : `blank = none on file (${nCpu} of ${PAID_COST_MIN_MEMBERS} with spend)`}
              help={basketCpu > 0 ? `Paid's share of the units target at this price is the window budget. Blank reads the basket: each launch's Purchases spend over the paid units its window sold, ${nCpu} launches with spend on file.`
                : `Paid's share of the units target at this price is the window budget. Blank reads the basket once ${PAID_COST_MIN_MEMBERS} of its launches have spend on file (${nCpu} do today); until then there is no window budget.`}
              tip="What a paid unit costs to buy in the window, in euros: each launch's Purchases campaign spend over the paid units its window sold.">
              <NumBox value={inp.cost_per_purchase === null || inp.cost_per_purchase === undefined ? "" : String(inp.cost_per_purchase)} placeholder={basketCpu > 0 ? fmt(basketCpu, 0) : ""} unit="€"
                onCommit={(raw) => { const c = String(raw).replace(/[^0-9.]/g, ""); setInp((prev) => ({ ...prev, cost_per_purchase: c === "" ? null : c })); }} />
            </Field>
            <Field label="Worth of a paid signup"
              src={pvOk ? (PV.aa_budget_share_assumed ? "AA's share of the spend assumed at 50%" : `AA carries ${Math.round(100 * PV.aa_budget_share)}% of the spend`) : "needs AA profit per unit"}
              help={pvOk
                ? `${fmtMoney(PV.value_per_unit, 0)} a unit sold (AA profit ${fmtMoney(PV.aa_profit_per_unit, 0)} + framing ${fmtMoney(PV.frame_uplift_per_unit, 0)}: ${fmtPct(PV.frame_share, 0)} of units framed at ${fmtPct(PV.frame_rate, 0)} take-up, ${FRAME_WORDS[PV.frame_rate_source]}, ${fmtMoney(PV.frame_profit_per_unit || 0, 0)} a frame), less ${fmtPct(PV.cannibalisation, 0)} cannibalisation, × ${fmt(PV.purchases_per_order, 2)} pieces an order × ${fmtPct(PV.signup_order_rate, 1)} of paid signups ordering (${S2O_PAID_WORDS[PV.signup_order_rate_source]}). At the ${fmt(PV.roi_target, 2)} target ROI a paid signup may cost ${fmtMoney(PV.cost_per_signup_at_target_roi, 2)}; break-even ${fmtMoney(PV.break_even_cost_per_signup, 2)}.`
                : "The Overview's paid card reads its ROI against this. It needs Avant Arte's profit per unit: type AA profit (and frame profit) per work on the products grid above, or fill them in Airtable."}
              tip="What a paid signup is assumed to be worth to Avant Arte: the chance it orders, the pieces it takes, AA's profit on each with the likely framing profit, net of cannibalisation.">
              <RoBox value={pvOk ? fmtMoney(PV.value_per_signup, 2) : "–"} title="Computed from the products grid and the assumptions here" />
            </Field>
          </div>
          <div className="ts-caption">Spend is Meta's, billed in euros, and the page runs in euros: every figure here is euros.</div>
        </section>
      </div>

      {picking && (
        <BasketPicker releaseId={snap.id} releaseName={snap.releaseName} current={spec}
          targetUnits={unitsTarget || 0} unitPrice={price || 0}
          preferRecent={inp.prefer_recent !== false} channelsOff={off}
          artist={snap.artist || ""} currency="EUR"
          announceDate={announce ? String(announce).slice(0, 10) : null} privateRoomOpen={null}
          // the page's day and the window's close: the rule reads a closed
          // launch at its close, as the build does
          launchEnd={closeIso ? closeIso.slice(0, 10) : null} asOf={snap.asOf || null}
          // the TL panel, and the launches of this window length first
          candidatesUrl={CANDIDATES_URL} lengthHours={hoursInForce}
          onInputs={onPickerInputs} onPick={onPick} onClose={() => setPicking(false)} />
      )}
    </>
  );
}
