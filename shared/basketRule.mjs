/* The basket rule, JS side: the SIMILAR_N launches nearest a release on units
 * and unit price, the artist's own earlier launches first, recent ones ahead
 * of older among the comparable when asked.
 *
 * This mirrors etl/baskets.py (similar_members, own_members, _distances,
 * _release_start, _release_price) to the member and to the reach, and
 * tests/test_basket_parity.py holds the two to it over the real panel and a
 * set of edge cases. The Python side is what the build runs when a basket is
 * saved; this side is what the picker runs as someone types a target, flips
 * the recency switch or opens the modal - so the picker can answer at once
 * from the candidate rows it already has, instead of asking a Python process
 * to start, import pandas and read the panel for every keystroke. A shared
 * half-CPU box made that seconds per keystroke; it is now a few milliseconds.
 *
 * Rows are the candidate rows (etl/baskets.py candidate_rows): release_name,
 * artist, title, window_start, window_end (ISO days), units, price (GBP, 0
 * when Airtable has none), sessions, paid_share, campaign_days, edition_size.
 * `L` is the release: {name, artist, target, price, currency?,
 * private_room_open?, announce_date?, launch_end?}.
 */
export const SIMILAR_N = 8;
export const OWN_MAX = 3.0;
export const NEAR = 4.0;
export const RECENT_MONTHS = 18;
export const MIN_MEMBERS = 3;
export const THIN_MEMBERS = 6;
export const SCALE_MISMATCH_FACTOR = 4.0;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const day = (s) => { if (!s) return null; const d = new Date(String(s).slice(0, 10) + "T00:00:00Z"); return Number.isNaN(d.getTime()) ? null : d; };
const fold = (s) => String(s || "").trim().toLowerCase();

/* This release's unit price in sterling, the way the Python side finds it: a
 * release already on the panel carries Airtable's value-weighted price and
 * that is used; one being planned has the price typed into the form, in the
 * currency the form says. A typed price does not move a release the panel
 * already prices - that is the Python behaviour, mirrored here so the picker
 * and the build rank on the same number. */
// mirrors etl/pricing.py RATES_TO_GBP, which tests/test_basket_parity.py checks
const RATES_TO_GBP = { GBP: 1.0, EUR: 0.85, USD: 0.78 };
export function releasePrice(rows, L) {
  const me = rows.find((r) => r.release_name === L.name);
  if (me && num(me.price) > 0) return num(me.price);
  const p = num(L.price);
  if (p <= 0) return 0;
  return p * (RATES_TO_GBP[String(L.currency || "GBP").toUpperCase()] ?? 1.0);
}

/* When this launch's own window opens - the cut-off for "earlier" launches by
 * the same artist: its panel row's window_start when it has one, else the
 * announce date (or the private room opening, which comes first), else today. */
export function releaseStart(rows, L, asOf) {
  const me = rows.find((r) => r.release_name === L.name);
  if (me && day(me.window_start)) return day(me.window_start);
  for (const k of ["private_room_open", "announce_date", "launch_end"]) {
    const d = day(L[k]);
    if (d) return d;
  }
  return asOf;
}

/* The release's artist: its panel row's, else the one given, else the first
 * part of the name - launches are named "Artist · Title · 2026 Q3" throughout. */
export function releaseArtist(rows, L) {
  const me = rows.find((r) => r.release_name === L.name);
  if (me && String(me.artist || "").trim()) return String(me.artist).trim();
  if (String(L.artist || "").trim()) return String(L.artist).trim();
  return String(L.name || "").split(" · ")[0].trim();
}

/* How far every launch in the pool is from this one: the larger of its units
 * multiple and its price multiple, each taken above 1 whichever side it falls,
 * so a launch is only as near as its worse axis. A launch Airtable could not
 * price is ranked on units alone rather than dropped over a missing field. */
export function distances(pool, L, price) {
  const target = num(L.target);
  const usePrice = price > 0 && pool.length > 0;
  const mult = (v, ref) => (v > 0 && ref > 0 ? Math.max(v / ref, ref / v) : Infinity);
  const d = pool.map((r) => {
    let x = mult(num(r.units), target);
    if (usePrice) {
      const dp = mult(num(r.price), price);
      x = Math.max(x, Number.isFinite(dp) ? dp : 1.0);
    }
    return x;
  });
  return { d, on: usePrice ? ["size", "price"] : ["size"] };
}

/* The artist's own earlier launches that belong in the basket: same artist,
 * closed before this launch opened, within OWN_MAX on both axes. Nearest first. */
export function ownMembers(rows, L, opts = {}) {
  const asOf = opts.asOf ? day(opts.asOf) || new Date() : new Date();
  const pool = rows.filter((r) => r.release_name !== L.name);
  if (!pool.length || !(num(L.target) > 0)) return [];
  const artist = releaseArtist(rows, L);
  if (!artist) return [];
  const start = releaseStart(rows, L, asOf);
  const { d } = distances(pool, L, releasePrice(rows, L));
  const idx = [];
  for (let i = 0; i < pool.length; i++) {
    const end = day(pool[i].window_end);
    if (fold(pool[i].artist) === fold(artist) && end && end < start && d[i] <= OWN_MAX) idx.push(i);
  }
  // nearest first, then by name: a total order, the same as the Python side's
  const name = (i) => String(pool[i].release_name);
  idx.sort((a, b) => d[a] - d[b] || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  return idx.map((i) => pool[i].release_name);
}

/* The SIMILAR_N nearest. Returns {members, reach, on}: the members in basket
 * order, how far the furthest of them is, and the axes that ranked them. */
export function similarMembers(rows, L, opts = {}) {
  const asOf = opts.asOf ? day(opts.asOf) || new Date() : new Date();
  const preferRecent = opts.preferRecent === undefined || opts.preferRecent === null ? true : !!opts.preferRecent;
  const pool = rows.filter((r) => r.release_name !== L.name);
  if (!(num(L.target) > 0) || !pool.length) return { members: [], reach: null, on: [] };
  const { d, on } = distances(pool, L, releasePrice(rows, L));
  const first = ownMembers(rows, L, { asOf });
  const taken = new Set(first);
  // the final key on every sort is the name, a total order shared with Python
  const nameOrder = (a, b) => { const x = String(pool[a].release_name), y = String(pool[b].release_name); return x < y ? -1 : x > y ? 1 : 0; };
  let rest = [];
  for (let i = 0; i < pool.length; i++) if (!taken.has(pool[i].release_name) && Number.isFinite(d[i])) rest.push(i);
  if (preferRecent && rest.length) {
    // three tiers, distance within each: comparable and recent, comparable and
    // older, then everything beyond NEAR
    const cutoff = new Date(asOf); cutoff.setUTCMonth(cutoff.getUTCMonth() - RECENT_MONTHS);
    const tier = (i) => {
      if (d[i] > NEAR) return 2;
      const end = day(pool[i].window_end);
      return end && end >= cutoff ? 0 : 1;
    };
    rest.sort((a, b) => tier(a) - tier(b) || d[a] - d[b] || nameOrder(a, b));
  } else {
    rest.sort((a, b) => d[a] - d[b] || nameOrder(a, b));
  }
  const members = [...first, ...rest.map((i) => pool[i].release_name)].slice(0, SIMILAR_N);
  if (!members.length) return { members: [], reach: null, on: [] };
  const byName = new Map(pool.map((r, i) => [r.release_name, d[i]]));
  const reach = Math.max(...members.map((m) => byName.get(m)));
  return { members, reach, on };
}
