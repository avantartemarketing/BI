/* The release's economics as the Target setting form prints them, from its
 * products: a mirror of resolve_release / _effective_product in etl/build.py,
 * so the form says what the build will as the figures are typed.
 *
 * A product is Airtable's record for one work (etl/pricing.py
 * release_products) with the figures typed over it on the tab; a product
 * Airtable has no record for can be added by hand. Typed beats Airtable
 * beats the default, per field, and each figure says where it came from.
 * The release's totals are the products' target units summed, the launch
 * value in euros, the profits per unit weighted by target units, the
 * framing terms over the products that offer a frame, and the paid-budget
 * split from the deal: on a profit-share deal Avant Arte carries its share
 * of the profit, on a revenue-share (royalty) deal it carries the ads
 * outright. tests/test_release_inputs.py holds the two sides to the figure. */
export const PAGE_CURRENCY = "EUR";
export const RATES_TO_EUR = { EUR: 1.0, GBP: 1.18, USD: 0.92 };
export const PRODUCT_KEYS = ["edition", "target_sellthrough", "unit_price", "currency", "artist_profit_per_unit",
  "aa_profit_per_unit", "aa_revenue_share", "aa_profit_share", "framing_available", "frame_conversion",
  "frame_profit_per_unit"];
export const LEGACY_KEYS = ["edition_size", "edition_total", "unit_price", "artist_profit", "aa_group_profit",
  "artist_profit_share", "framing_available", "frame_conversion", "frame_profit_per_unit", "aa_budget_share"];

const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const blank = (v) => v === null || v === undefined || v === "";
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const round2 = (v) => Math.round(v * 100) / 100;

/* Airtable's products with the typed entries laid over them: matched by
 * Airtable id, a manual product by name; a draw's entry (the sell-through
 * card's names and rates, keyed by draw id) is not a product here. */
export function mergeProducts(airtable, typed) {
  const out = (airtable || []).map((p) => ({ ...p, source: "airtable", typed: {} }));
  const byId = new Map(out.filter((p) => p.airtable_id).map((p) => [String(p.airtable_id), p]));
  const byName = new Map(out.filter((p) => p.name).map((p) => [norm(p.name), p]));
  for (const t of typed || []) {
    if (!t || typeof t !== "object" || !(t.airtable_id || t.manual)) continue;
    const keys = {};
    for (const k of PRODUCT_KEYS) if (k in t && !blank(t[k])) keys[k] = t[k];
    if (t.name !== undefined && t.name !== null) keys.name = String(t.name);   // as typed: the server trims on save
    let target = t.airtable_id ? byId.get(String(t.airtable_id)) : null;
    if (!target && t.manual) target = byName.get(norm(t.name)) || null;
    if (!target) {
      if (t.airtable_id && !t.manual) continue;
      target = { airtable_id: null, name: keys.name !== undefined ? keys.name : "Product", source: "typed", typed: {} };
      out.push(target);
      if (keys.name) byName.set(norm(keys.name), target);
    }
    Object.assign(target.typed, keys);
  }
  return out;
}

/* One product's figures in force, and where each came from. */
export function effectiveProduct(p, b) {
  const typed = p.typed || {};
  const src = {};
  const pick = (key, atKey, dflt) => {
    if (key in typed) { src[key] = "typed"; return typed[key]; }
    const v = p[atKey || key];
    if (!blank(v)) { src[key] = "airtable"; return v; }
    src[key] = dflt !== undefined && dflt !== null ? "default" : null;
    return dflt === undefined ? null : dflt;
  };
  const e = { airtable_id: p.airtable_id || null, name: typed.name !== undefined ? typed.name : p.name || "Product", project_code: p.project_code || null };
  const edition = num(pick("edition"));
  e.edition = edition && edition > 0 ? Math.round(edition) : null;
  const share = num(pick("target_sellthrough", null, 1.0));
  e.target_sellthrough = share === null ? 1.0 : Math.min(Math.max(share, 0), 1);
  e.target_units = e.edition ? Math.round(e.edition * e.target_sellthrough) : 0;
  const price = num(pick("unit_price"));
  e.unit_price = price && price > 0 ? price : null;
  e.currency = String(pick("currency", null, PAGE_CURRENCY) || PAGE_CURRENCY).toUpperCase();
  const rate = RATES_TO_EUR[e.currency] ?? 1.0;
  e.unit_price_eur = e.unit_price ? round2(e.unit_price * rate) : null;
  e.artist_profit_per_unit = num(pick("artist_profit_per_unit"));
  e.aa_profit_per_unit = num(pick("aa_profit_per_unit"));
  e.aa_revenue_share = num(pick("aa_revenue_share"));
  e.aa_profit_share = num(pick("aa_profit_share"));
  const fa = pick("framing_available", null, true);
  e.framing_available = fa !== false;
  const conv = num(pick("frame_conversion")), profit = num(pick("frame_profit_per_unit"));
  e.frame_conversion = Math.min(Math.max(conv === null ? Number(b.frame_conversion) : conv, 0), 1);
  e.frame_profit_per_unit = Math.max(profit === null ? Number(b.frame_profit_per_unit) : profit, 0);
  e.frame_uplift_per_unit = e.framing_available ? round2(e.frame_conversion * e.frame_profit_per_unit) : 0;
  if (e.aa_profit_share !== null) { e.aa_budget_share = Math.min(Math.max(e.aa_profit_share, 0), 1); e.deal = "profit share"; }
  else if (e.aa_revenue_share !== null) { e.aa_budget_share = 1.0; e.deal = "revenue share"; }
  else { e.aa_budget_share = null; e.deal = null; }
  e.sources = src;
  return e;
}

export function resolveProducts(airtable, typed, b) {
  return mergeProducts(airtable, typed).map((p) => effectiveProduct(p, b));
}

/* The release's totals from its products, or from the typed release-level
 * figures while a release still carries them (legacy). */
export function releaseEconomics(products, legacy, b) {
  const sized = (products || []).filter((p) => p.edition);
  const targets = sized.reduce((s, p) => s + p.target_units, 0);
  const lnum = (k) => num(legacy && legacy[k]);
  if (legacy && lnum("edition_size") > 0) {
    const size = lnum("edition_size");
    const framing = legacy.framing_available !== false;
    const conv = num(legacy.frame_conversion), profit = num(legacy.frame_profit_per_unit);
    const frameConv = Math.min(Math.max(conv === null ? Number(b.frame_conversion) : conv, 0), 1);
    const frameProfit = Math.max(profit === null ? Number(b.frame_profit_per_unit) : profit, 0);
    // the ads divide as the profit does (etl/build.py legacy_budget_share):
    // AA's share of the profit, all of it when the artist takes none, and
    // half, flagged as assumed, when nothing is typed
    const aps = lnum("artist_profit_share"), typedShare = lnum("aa_budget_share");
    const aaShare = typedShare ?? (aps === null ? 0.5 : aps <= 0 ? 1.0 : Math.round(Math.min(Math.max(1 - aps, 0), 1) * 10000) / 10000);
    const assumed = typedShare === null && aps === null;
    return {
      mode: "release", edition_size: size, edition_total: Math.max(lnum("edition_total") || 0, size),
      unit_price: lnum("unit_price") || 0, currency: PAGE_CURRENCY, launch_value: size * (lnum("unit_price") || 0),
      ppu_artist: (lnum("artist_profit") || 0) / size,
      ppu_aa: (lnum("aa_group_profit") || 0) / size + (framing ? frameConv * frameProfit : 0),
      framing_available: framing, frame_conversion: frameConv, frame_profit_per_unit: frameProfit,
      frame_uplift_per_unit: framing ? frameConv * frameProfit : 0,
      aa_budget_share: aaShare, aa_budget_share_assumed: assumed, artist_profit_share: 1 - aaShare, deal: [],
    };
  }
  if (!sized.length || targets <= 0) {
    return { mode: "none", edition_size: 0, edition_total: sized.reduce((s, p) => s + p.edition, 0), unit_price: 0, currency: PAGE_CURRENCY,
      launch_value: 0, ppu_artist: 0, ppu_aa: 0, framing_available: false, frame_conversion: 0, frame_profit_per_unit: 0,
      frame_uplift_per_unit: 0, aa_budget_share: 0.5, aa_budget_share_assumed: true, artist_profit_share: 0.5, deal: [] };
  }
  const priced = sized.filter((p) => p.unit_price_eur);
  const pricedUnits = priced.reduce((s, p) => s + p.target_units, 0);
  const value = priced.reduce((s, p) => s + p.target_units * p.unit_price_eur, 0);
  const weighted = (key, of) => {
    const rows = (of || sized).filter((p) => p[key] !== null && p[key] !== undefined && p.target_units > 0);
    const tot = rows.reduce((s, p) => s + p.target_units, 0);
    return tot ? rows.reduce((s, p) => s + p.target_units * p[key], 0) / tot : null;
  };
  const framed = sized.filter((p) => p.framing_available);
  const ppuArtist = weighted("artist_profit_per_unit"), ppuAA = weighted("aa_profit_per_unit");
  const frameConv = framed.length ? weighted("frame_conversion", framed) : null;
  const frameProfit = framed.length ? weighted("frame_profit_per_unit", framed) : null;
  const share = weighted("aa_budget_share");
  const aaShare = share === null ? 0.5 : share;
  const uplift = framed.length ? weighted("frame_uplift_per_unit", framed) * (framed.reduce((s, p) => s + p.target_units, 0) / targets) : 0;
  return {
    mode: "products", edition_size: targets, edition_total: sized.reduce((s, p) => s + p.edition, 0),
    unit_price: pricedUnits ? round2(value / pricedUnits) : 0, currency: PAGE_CURRENCY,
    launch_value: round2(value), launch_currencies: [...new Set(priced.map((p) => p.currency))].sort(),
    ppu_artist: ppuArtist === null ? 0 : ppuArtist,
    // AA's profit per unit as the build reads it: the group profit spread
    // over the target plus the framing uplift over the products that frame
    ppu_aa: (ppuAA === null ? 0 : ppuAA) + uplift,
    framing_available: framed.length > 0, frame_conversion: frameConv, frame_profit_per_unit: frameProfit,
    frame_uplift_per_unit: uplift,
    aa_budget_share: aaShare, aa_budget_share_assumed: share === null,
    artist_profit_share: Math.round((1 - aaShare) * 10000) / 10000,
    deal: [...new Set(sized.map((p) => p.deal).filter(Boolean))].sort(),
  };
}
