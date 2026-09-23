/* The basket picker (docs/BENCHMARK_SPEC.md §8, API §6): the map.
 *
 * The benchmark is the median of a basket of comparable past launches (§1, §3),
 * so choosing the basket is the single most consequential thing anyone does on
 * the Target setting tab - it moves every reference mark on every card. This
 * modal is where that choice is made, and it is built so the choice can be
 * seen: every launch on file is a dot on a map of units against unit price,
 * this launch is the ring, and the basket is what is nearest to it. The basket
 * is a picture before it is a list, because "these are the eight nearest" is
 * something a person can check with their eyes and argue with.
 *
 * The rule lives in etl/baskets.py (similar_members), which the build runs
 * when a basket is saved, and in shared/basketRule.mjs, its JS mirror, which
 * this modal runs over the candidate rows as someone types a target or flips
 * the recency switch - tests/test_basket_parity.py holds the two to the same
 * eight in the same order. The rows come from one file the build writes, so
 * opening the picker is one small fetch and no Python process. The rule: the
 * artist's own earlier launches first, then the nearest on units and price,
 * with launches closed in the last eighteen months ranked ahead of older ones
 * among the comparable when "prefer recent" is on.
 *
 * A release with no target or price yet has nothing to be near to, so the
 * picker's first job is to ask for them, and it does so in place: the two
 * fields write straight back to the Target setting form through `onInputs`
 * and the suggestion follows as they are typed, against the unsaved values.
 *
 * Nothing here writes anything. `onPick` hands the chosen members back to
 * TargetSetting, which holds them as an unsaved edit until the targets are
 * saved; ticks still matching what the modal opened on pick the suggestion by
 * id, with the ETL's own profile, so merely looking does not turn a release
 * bespoke.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { C, fmt, fmtK, fmtMoney, fmtPct } from "./ui.jsx";
import { similarMembers, ownMembers, releasePrice, releaseArtist, MIN_MEMBERS, THIN_MEMBERS, NEAR, RECENT_MONTHS } from "../../shared/basketRule.mjs";
import { GROUPS, applyChannelsOff } from "../../shared/benchmarkModel.mjs";

const SIMILAR_NAME = "Similar size and shape";   // etl/baskets.py SIMILAR_NAME: the basket with id similar_size
const SHOW_AT_LEAST = 14;   // the members and the ones that just missed
const YEAR_MS = 365 * 86400000;
const FIELD = "#c9c7c0";    // the launches that are not in the basket: present, recessive

const EXPLAINER = "Benchmark = the median of the basket, per metric and per channel.";

const ratio = (a, b) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : null);
const x = (v) => (v === null || v === undefined ? "–" : "×" + fmt(v, v < 10 ? 1 : 0));
function quantile(values, q) {
  const v = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const median = (values) => quantile(values, 0.5);

/* The preview profile of whatever is ticked, in the shape TargetSetting reads.
 * The medians that end up on the page are always the ETL's, recomputed when
 * the basket is saved; this is the shape of the answer, not the answer. */
function liveProfile(rows) {
  const units = rows.map((r) => r.units), priced = rows.map((r) => r.price).filter((p) => p > 0);
  const total = median(units), sessions = median(rows.map((r) => r.sessions));
  // each group's median share, renormalised so share x total adds back to the
  // headline median - etl/baskets.py _shares, over the same rows
  const shares = (key) => {
    const raw = Object.fromEntries(GROUPS.map((g) => [g, median(rows.map((r) => ((r[key] || {})[g])))]));
    const tot = GROUPS.reduce((s, g) => s + raw[g], 0);
    return Object.fromEntries(GROUPS.map((g) => [g, tot > 0 ? raw[g] / tot : 0]));
  };
  const share_units = shares("unit_shares"), share_sessions = shares("sess_shares");
  const positive = (vals) => median(vals.filter((v) => typeof v === "number" && v > 0));
  return {
    n: rows.length, members: rows.map((r) => r.release_name),
    units: total, units_p25: quantile(units, 0.25), units_p75: quantile(units, 0.75),
    price: median(priced), price_p25: quantile(priced, 0.25), price_p75: quantile(priced, 0.75), n_priced: priced.length,
    sessions, paid_share: median(rows.map((r) => r.paid_share)),
    entries: median(rows.map((r) => r.entries)),
    campaign_days: median(rows.map((r) => r.campaign_days)),
    units_per_buyer: positive(rows.map((r) => r.units_per_buyer)),
    // what a paid unit cost the members' launches: the median over those with
    // a reading once three have one (etl/baskets.py basket_profile)
    cost_per_purchase: rows.filter((r) => r.cost_per_paid_unit > 0).length >= 3 ? positive(rows.map((r) => r.cost_per_paid_unit)) : 0,
    n_costed: rows.filter((r) => r.cost_per_paid_unit > 0).length,
    share_units, share_sessions,
    units_by_group: Object.fromEntries(GROUPS.map((g) => [g, share_units[g] * total])),
    sessions_by_group: Object.fromEntries(GROUPS.map((g) => [g, share_sessions[g] * sessions])),
    conv: Object.fromEntries(GROUPS.map((g) => [g, positive(rows.map((r) => (r.convs || {})[g]))])),
  };
}

const Chip = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{
    fontFamily: "inherit", fontSize: 12, fontWeight: active ? 600 : 500, padding: "3px 9px",
    borderRadius: 5, cursor: "pointer", whiteSpace: "nowrap",
    border: `1px solid ${active ? C.ink : C.border}`, background: active ? C.ink : C.white, color: active ? "#fff" : C.muted,
  }}>{children}</button>
);

/* A switch: the control, its name, and one clause on what it does. An inert one
 * says why, because a switch that pretends is worse than none. */
function Switch({ id, on, onChange, label, sub, off, why }) {
  return (
    <label title={why} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: off ? "default" : "pointer", opacity: off ? 0.55 : 1, userSelect: "none" }}>
      <input type="checkbox" id={id} checked={on} disabled={off} onChange={(e) => onChange && onChange(e.target.checked)}
        style={{ accentColor: C.ink, width: 15, height: 15, margin: 0, cursor: off ? "default" : "pointer" }} />
      <span>{label} <span style={{ color: C.muted, fontSize: 12 }}>· {sub}</span></span>
    </label>
  );
}

/* One distance, as a bar from the centre of its track: a launch that sold
 * fewer units, or was priced lower, than this one extends left; one that sold
 * more, or was priced higher, extends right. The length is log-scaled so ×2
 * fills a third of its side and ×8 all of it, which is the range that matters.
 * An exact match is a tick on the centre line rather than an empty track, so
 * nothing reads as missing, and a bar never shrinks below the tick. Dimmed
 * past NEAR. */
function Bar({ v, under, on, prefix, hint }) {
  const w = v === null ? 0 : Math.min(Math.log(v) / Math.log(8), 1) * 50;
  const tone = on ? C.blue : FIELD;
  return (
    <div title={hint} style={{ display: "grid", gridTemplateColumns: "44px 1fr 40px", gap: "0 8px", alignItems: "center", fontSize: 11, color: C.muted }}>
      <span className="num" style={{ textAlign: "right" }}>{prefix}</span>
      <div style={{ height: 6, borderRadius: 3, background: C.hairline, position: "relative" }}>
        <div style={{ position: "absolute", left: "50%", top: -1, bottom: -1, width: 1, marginLeft: -0.5, background: C.planGrey }} />
        {v === null ? null : v <= 1
          ? <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 3, marginLeft: -1.5, borderRadius: 1.5, background: tone }} />
          : <div style={{ position: "absolute", top: 0, bottom: 0, width: `${w.toFixed(1)}%`, minWidth: 3, background: tone,
              ...(under ? { right: "50%", borderRadius: "3px 0 0 3px" } : { left: "50%", borderRadius: "0 3px 3px 0" }) }} />}
      </div>
      <span className="num" style={{ color: v !== null && v > NEAR ? C.muted : C.ink }}>{x(v)}</span>
    </div>
  );
}

/* The map (named Scatter: a component called Map shadows the Map the file
 * needs for its lookups). Log on both axes because the panel runs from 15 units to 987 and
 * from €425 to €7,225, and a halving is the same distance as a doubling. The
 * reach is drawn as the box it is: "within ×R on both" is a square in log
 * space. This launch is a ring at its target and price, with faint guides to
 * the axes so it can be read off even when it sits past every dot on file. */
function Scatter({ rows, L, ticked, isOwn, reach, hover, setHover }) {
  const W = 900, H = 380, m = { l: 46, r: 14, t: 14, b: 32 };
  const X0 = 10, X1 = 4000, Y0 = 300, Y1 = 12000;
  const sx = (v) => m.l + (Math.log(v) - Math.log(X0)) / (Math.log(X1) - Math.log(X0)) * (W - m.l - m.r);
  const sy = (v) => H - m.b - (Math.log(v) - Math.log(Y0)) / (Math.log(Y1) - Math.log(Y0)) * (H - m.t - m.b);
  const clampX = (v) => Math.min(Math.max(v, X0), X1), clampY = (v) => Math.min(Math.max(v, Y0), Y1);
  const tx = sx(clampX(L.target)), ty = sy(clampY(L.price));
  const box = reach !== null && Number.isFinite(reach) ? {
    x0: Math.max(sx(L.target / reach), m.l), x1: Math.min(sx(L.target * reach), W - m.r),
    y0: Math.max(sy(L.price * reach), m.t), y1: Math.min(sy(L.price / reach), H - m.b),
  } : null;
  // members drawn last so they sit on top of the field
  const ordered = rows.slice().sort((a, b) => (ticked.has(a.release_name) ? 1 : 0) - (ticked.has(b.release_name) ? 1 : 0));
  const hov = hover ? rows.find((r) => r.release_name === hover) : null;
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Every launch on file by units sold and unit price, this launch marked, the basket highlighted"
        style={{ display: "block", width: "100%", height: "auto", overflow: "visible" }}>
        {[10, 30, 100, 300, 1000, 3000].map((t) => (
          <g key={"x" + t}>
            <line x1={sx(t)} y1={m.t} x2={sx(t)} y2={H - m.b} stroke={C.hairline} strokeWidth="1" />
            <text x={sx(t)} y={H - m.b + 16} textAnchor="middle" fontSize="10.5" fill={C.muted}>{fmt(t)}</text>
          </g>
        ))}
        {[300, 1000, 3000, 10000].map((t) => (
          <g key={"y" + t}>
            <line x1={m.l} y1={sy(t)} x2={W - m.r} y2={sy(t)} stroke={C.hairline} strokeWidth="1" />
            <text x={m.l - 6} y={sy(t) + 3.5} textAnchor="end" fontSize="10.5" fill={C.muted}>{t >= 1000 ? "€" + t / 1000 + "k" : "€" + t}</text>
          </g>
        ))}
        <text x={W - m.r} y={H - 4} textAnchor="end" fontSize="10.5" fill={C.muted}>units sold</text>
        {box && (
          <rect x={box.x0} y={box.y0} width={Math.max(0, box.x1 - box.x0)} height={Math.max(0, box.y1 - box.y0)}
            fill={C.refBase} fillOpacity="0.45" stroke={C.refLine} strokeWidth="1" strokeDasharray="3 3" />
        )}
        {ordered.map((r) => {
          if (!(r.units > 0 && r.price > 0)) return null;
          const on = ticked.has(r.release_name), own = isOwn(r), cx = sx(r.units), cy = sy(r.price), h = hover === r.release_name;
          const common = { style: { cursor: "pointer" }, onMouseEnter: () => setHover(r.release_name), onMouseLeave: () => setHover(null) };
          if (on && own) return <rect key={r.release_name} {...common} x={cx - 6.5} y={cy - 6.5} width="13" height="13" transform={`rotate(45 ${cx} ${cy})`} fill={C.blueDeep} stroke={C.white} strokeWidth={h ? 3 : 2} />;
          if (on) return <circle key={r.release_name} {...common} cx={cx} cy={cy} r={h ? 7.5 : 6} fill={C.blue} stroke={C.white} strokeWidth="2" />;
          return <circle key={r.release_name} {...common} cx={cx} cy={cy} r={h ? 6 : 4.5} fill={own ? C.blueDeep : FIELD} fillOpacity={own ? 0.6 : 1} stroke={C.white} strokeWidth="1" />;
        })}
        <line x1={tx} y1={m.t} x2={tx} y2={H - m.b} stroke={C.ink} strokeOpacity="0.18" strokeWidth="1" />
        <line x1={m.l} y1={ty} x2={W - m.r} y2={ty} stroke={C.ink} strokeOpacity="0.18" strokeWidth="1" />
        <circle cx={tx} cy={ty} r="9" fill={C.white} fillOpacity="0.6" stroke={C.ink} strokeWidth="2.2" />
        <text x={tx} y={ty - 14} textAnchor="middle" fontSize="11" fontWeight="600" fill={C.ink}>this launch</text>
      </svg>
      {hov && (
        <div style={{
          position: "absolute", left: `${(sx(hov.units) / W) * 100}%`, top: `${(sy(hov.price) / H) * 100}%`,
          transform: "translate(-50%, calc(-100% - 14px))", pointerEvents: "none", whiteSpace: "nowrap",
          background: C.ink, color: C.white, fontSize: 12, lineHeight: 1.4, padding: "7px 9px", borderRadius: 7, zIndex: 2,
        }}>
          <b>{hov.artist} · {hov.title}</b><br />
          {fmt(hov.units)} units · {fmtMoney(hov.price)} · {String(hov.window_end || "").slice(0, 4)}<br />
          {x(ratio(hov.units, L.target))} on units · {x(ratio(hov.price, L.price))} on price{isOwn(hov) ? " · the artist's own" : ""}
        </div>
      )}
    </div>
  );
}

const Legend = () => {
  const item = { display: "inline-flex", alignItems: "center", gap: 6 };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 12, color: C.muted, marginTop: 8 }}>
      <span style={item}><i style={{ width: 12, height: 12, borderRadius: "50%", border: `2px solid ${C.ink}`, boxSizing: "border-box" }} />this launch</span>
      <span style={item}><i style={{ width: 10, height: 10, borderRadius: "50%", background: C.blue }} />in the basket</span>
      <span style={item}><i style={{ width: 9, height: 9, borderRadius: 2, background: C.blueDeep, transform: "rotate(45deg)" }} />the artist's own</span>
      <span style={item}><i style={{ width: 8, height: 8, borderRadius: "50%", background: FIELD }} />other launches on file</span>
      <span style={item}><i style={{ width: 14, height: 10, borderRadius: 2, background: C.refBase, border: `1px dashed ${C.refLine}`, boxSizing: "border-box" }} />the basket's reach</span>
    </div>
  );
};

export default function BasketPicker({ releaseId, releaseName, artist, currency, announceDate, privateRoomOpen, targetUnits, unitPrice, preferRecent = true, channelsOff = [], current, onInputs, onPick, onClose }) {
  const [recent, setRecent] = useState(preferRecent !== false);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [seed, setSeed] = useState(null);         // {id, name, members, own, reach, profile}
  const seedRef = useRef(null);
  const [ticked, setTicked] = useState(() => new Set(((current && current.members) || []).filter((m) => m !== releaseName)));
  const tickedRef = useRef(null);
  tickedRef.current = ticked;
  const [hover, setHover] = useState(null);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("similar");
  const [draft, setDraft] = useState({ units: targetUnits > 0 ? String(targetUnits) : "", price: unitPrice > 0 ? String(unitPrice) : "" });

  const placeable = targetUnits > 0 && unitPrice > 0;
  const L = useMemo(() => ({
    name: releaseName, artist: artist || "", target: targetUnits, price: unitPrice, currency: currency || "EUR",
    private_room_open: privateRoomOpen || null, announce_date: announceDate || null,
  }), [releaseName, artist, targetUnits, unitPrice, currency, privateRoomOpen, announceDate]);

  // Escape closes. Nothing else is trapped: the picker sits over a page that is
  // still readable behind it.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // the panel, once
  useEffect(() => {
    fetch("/api/baskets/candidates").then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      setRows(d.rows || []);
    }).catch((e) => setError(String(e)));
  }, []);

  /* The suggestion: the rule in shared/basketRule.mjs over the rows, for this
     target and price and this setting of the recency switch - the same rule
     the build runs when the basket is saved, answered here in a few
     milliseconds rather than by a Python process per keystroke. Ticks that
     still equal the previous suggestion (or are empty) move to the new one;
     ticks someone has edited are theirs and stay, with the seed updated
     underneath so the headline still says "edited" against the right thing. */
  const rule = useMemo(() => (rows && placeable ? similarMembers(rows, L, { preferRecent: recent }) : null), [rows, L, recent, placeable]);
  const ownList = useMemo(() => (rows && placeable ? ownMembers(rows, L) : []), [rows, L, placeable]);
  useEffect(() => {
    const next = rule && rule.members.length
      ? { id: "similar_size", name: SIMILAR_NAME, kind: "ready", members: rule.members, own: ownList, reach: rule.reach }
      : null;
    const prev = seedRef.current, cur = tickedRef.current;
    const untouched = !cur.size || (prev && cur.size === prev.members.length && prev.members.every((m) => cur.has(m)));
    seedRef.current = next; setSeed(next);
    if (next && untouched) setTicked(new Set(next.members));
  }, [rule, ownList]);

  const ownArtist = useMemo(() => (rows ? releaseArtist(rows, L) : (artist || String(releaseName || "").split(" · ")[0].trim())), [rows, L, artist, releaseName]);
  // the price the rule ranks on: the panel's for a launch it already prices,
  // the typed one otherwise - the same precedence as the Python side, so the
  // map and the build agree; the headline says when the two differ
  const priceUsed = useMemo(() => (rows ? releasePrice(rows, L) : unitPrice), [rows, L, unitPrice]);
  const LM = useMemo(() => ({ ...L, price: priceUsed }), [L, priceUsed]);
  const isOwn = (r) => !!ownArtist && r.artist === ownArtist && r.release_name !== releaseName;

  // each launch's two distances, and its worse one
  const scored = useMemo(() => (rows || []).filter((r) => r.release_name !== releaseName).map((r) => {
    const du = ratio(r.units, L.target), dp = ratio(r.price, priceUsed);
    return { ...r, du, dp, d: du === null || dp === null ? null : Math.max(du, dp) };
  }).sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity)), [rows, releaseName, L]);

  // what a bar says when pointed at: the figure, which way it falls and by how much
  const unitsHint = (r) => r.units === L.target ? `Sold ${fmt(r.units)} units in its window, the same as this launch's target`
    : `Sold ${fmt(r.units)} units in its window, ${x(r.du)} ${r.units < L.target ? "fewer" : "more"} than this launch's target of ${fmt(L.target)}`;
  const priceHint = (r) => !(r.price > 0) ? "Airtable has no unit price for it, so it is ranked on units alone"
    : r.dp !== null && r.dp <= 1 ? `Priced at ${fmtMoney(r.price)}, the same as this launch`
    : `Priced at ${fmtMoney(r.price)}, ${x(r.dp)} ${r.price < priceUsed ? "lower" : "higher"} than this launch's ${fmtMoney(priceUsed)}`;

  const members = useMemo(() => scored.filter((s) => ticked.has(s.release_name)), [scored, ticked]);
  const reach = members.length ? Math.max(...members.map((m) => m.d ?? 0)) : null;
  const liveAll = useMemo(() => liveProfile(members), [members]);
  // the switches are release inputs: the rail reads the basket the way the
  // build will, without the channels set aside (BENCHMARK_SPEC 4.3)
  const off = channelsOff || [];
  const paidOff = off.includes("paid");
  const live = useMemo(() => applyChannelsOff(liveAll, off), [liveAll, off]);
  const setPaid = (on) => onInputs && onInputs({ channels_off: on ? off.filter((g) => g !== "paid") : [...off, "paid"] });
  const untouched = !!seed && ticked.size === seed.members.length && seed.members.every((m) => ticked.has(m));
  const ownIn = members.filter(isOwn).length;
  const K = live.units > 0 && L.target > 0 ? L.target / live.units : null;

  // what "prefer recent" cost, said only while the ticks are the rule's
  const passedOver = useMemo(() => {
    if (!recent || !untouched || reach === null) return 0;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - RECENT_MONTHS);
    return scored.filter((s) => !ticked.has(s.release_name) && s.d !== null && s.d < reach && s.window_end && new Date(s.window_end) < cutoff).length;
  }, [scored, ticked, recent, untouched, reach]);

  /* The list: members first in rank order, then the rest by distance. "Most
     similar" is everything within NEAR, never fewer than SHOW_AT_LEAST; a ticked
     member is never filtered out of any view, because unticking something you
     can no longer see is not an edit anyone can follow. */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase(), cutoff = Date.now() - YEAR_MS;
    let list = scored.filter((r) => {
      if (q && !`${r.release_name} ${r.artist} ${r.title}`.toLowerCase().includes(q)) return false;
      if (ticked.has(r.release_name)) return true;
      if (chip === "12m") return r.window_end && new Date(r.window_end).getTime() >= cutoff;
      if (chip === "artist") return isOwn(r);
      if (chip === "ticked") return false;
      return true;
    });
    list = [...list.filter((r) => ticked.has(r.release_name)), ...list.filter((r) => !ticked.has(r.release_name))];
    if (chip === "similar") {
      const near = list.filter((r) => ticked.has(r.release_name) || (r.d ?? Infinity) <= NEAR);
      list = near.length >= SHOW_AT_LEAST ? near : list.slice(0, SHOW_AT_LEAST);
    }
    return list;
  }, [scored, query, chip, ticked, ownArtist]);

  const toggle = (name) => {
    const next = new Set(ticked);
    if (next.has(name)) next.delete(name); else next.add(name);
    setTicked(next);
  };
  const typed = (key, raw) => {
    const clean = String(raw).replace(/[^0-9]/g, "");
    setDraft((d) => ({ ...d, [key]: clean }));
    const v = clean === "" ? null : parseInt(clean, 10);
    if (onInputs) onInputs(key === "units" ? { edition_size: v } : { unit_price: v });
  };
  const use = () => {
    if (untouched && seed) {
      onPick({ kind: "ready", id: seed.id, name: seed.name, n: seed.members.length, members: seed.members, profile: liveAll, preferRecent: recent });
      return;
    }
    onPick({ kind: "bespoke", name: `${seed ? seed.name : "Basket"} (edited)`, n: members.length, members: members.map((m) => m.release_name), profile: liveAll, preferRecent: recent });
  };

  const headline = () => {
    const n = members.length, who = ownArtist.split(" ").slice(-1)[0];
    const priced = priceUsed > 0 && unitPrice > 0 && Math.round(priceUsed) !== Math.round(unitPrice)
      ? <span style={{ color: C.muted }}> (the {fmtMoney(priceUsed)} Airtable has for it, not the {fmtMoney(unitPrice)} typed)</span> : null;
    let s = <>The <b>{n}</b> launches nearest to <b>{fmt(L.target)} units at {fmtMoney(priceUsed)}</b>{priced}{ownIn ? <>, starting with {who}'s own {ownIn === 1 ? "one" : ownIn}</> : null}</>;
    const cost = passedOver ? <> <span style={{ color: C.amber }}>{passedOver === 1 ? "One nearer launch was" : `${passedOver} nearer launches were`} passed over for being older than {RECENT_MONTHS} months.</span></> : null;
    // the switches change how the basket is read, not which launches are in it
    const paidNote = paidOff ? <span style={{ color: C.muted }}> Paid is not in plan, so the basket is read without its paid units.</span> : null;
    if (reach === null) return <>{s}.{paidNote}</>;
    if (reach > NEAR) return <>{s}. <span style={{ color: C.amber }}>Nothing on file is this size</span> - these are the nearest we have, the furthest {x(reach)} away.{cost}{paidNote}</>;
    return <>{s} - all within <b>{x(reach)}</b> of it{untouched ? "" : " · edited"}.{cost}{paidNote}</>;
  };

  const loading = !rows && !error;
  const thin = members.length > 0 && members.length < THIN_MEMBERS;
  const railRow = (label, mine, theirs, tip) => (
    <div title={tip} style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px", gap: 8, alignItems: "baseline", padding: "6px 0", borderBottom: `1px solid ${C.hairline}`, fontSize: 13 }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span className="num" style={{ textAlign: "right", color: mine === null ? C.muted : C.ink }}>{mine === null ? "–" : mine}</span>
      <span className="num" style={{ textAlign: "right", fontWeight: 600 }}>{theirs}</span>
    </div>
  );

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(20,20,19,0.28)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div role="dialog" aria-label="Choose a benchmark basket" style={{
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 12px 40px rgba(20,20,19,0.18)",
        width: "min(1280px, 96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.hairline}`, flex: "0 0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Benchmark basket</span>
            <span style={{ fontSize: 12, color: C.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{releaseName}</span>
            <button className="btn secondary" onClick={onClose} style={{ marginLeft: "auto", padding: "4px 10px" }}>Close</button>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{EXPLAINER}</div>
        </div>

        {error && <div style={{ padding: "14px 24px", fontSize: 12.5, color: C.red }}>{error}</div>}
        {loading && <div style={{ padding: 24, fontSize: 12.5, color: C.muted }}>Loading launches…</div>}

        {!loading && !error && (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 24px 20px" }}>
            {/* first, the two numbers everything is measured against; in place, so
                a release with none saved gets its basket the moment they are typed */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "10px 20px" }}>
              <div>
                <div className="flabel" style={{ marginBottom: 5 }}>Target (units)</div>
                <input id="basket-target" className="control num" inputMode="numeric" value={draft.units} placeholder="e.g. 500" style={{ width: 130 }}
                  onChange={(e) => typed("units", e.target.value)} />
              </div>
              <div>
                <div className="flabel" style={{ marginBottom: 5 }}>Unit price (€)</div>
                <input id="basket-price" className="control num" inputMode="numeric" value={draft.price} placeholder="e.g. 1,500" style={{ width: 130 }}
                  onChange={(e) => typed("price", e.target.value)} />
              </div>
              <div style={{ flex: "1 1 320px", fontSize: 14, lineHeight: 1.45, paddingBottom: 6 }}>
                {placeable ? (seed || members.length ? headline() : <span style={{ color: C.muted }}>Finding the nearest launches…</span>)
                  : <span style={{ color: C.amber }}>Both are needed before there is anything to be near to. Type them and the basket appears.</span>}
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", alignItems: "center", marginTop: 12 }}>
              <Switch id="basket-recent" on={recent} onChange={setRecent} label="Prefer recent" sub={`last ${RECENT_MONTHS} months first`} />
              <Switch id="basket-paid" on={!paidOff} onChange={setPaid} label="Running paid"
                sub={paidOff ? "off: the basket is read without its paid units" : "off reads the basket without its paid units"}
                why="The basket keeps every launch, paid or not. With paid off each counts on its other channels only, so the benchmark is what launches like this reached without paid and the whole target falls on the channels in plan. Saved with the targets." />
              <Switch id="basket-estate" on={/estate|foundation/i.test(ownArtist)} off label="Estate" sub="needs the panel labelled"
                why="One of the launches on file is an estate by name. The panel needs labelling before this can change the basket." />
            </div>

            {placeable && (
              <>
                <div style={{ marginTop: 14 }}>
                  <Scatter rows={rows} L={LM} ticked={ticked} isOwn={isOwn} reach={reach} hover={hover} setHover={setHover} />
                  <Legend />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 20, marginTop: 18 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      <input className="control" style={{ width: 200 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search release or artist" />
                      <Chip active={chip === "similar"} onClick={() => setChip("similar")}>Most similar</Chip>
                      <Chip active={chip === "all"} onClick={() => setChip("all")}>All</Chip>
                      <Chip active={chip === "12m"} onClick={() => setChip("12m")}>Last 12 months</Chip>
                      {!!ownArtist && <Chip active={chip === "artist"} onClick={() => setChip("artist")}>Same artist</Chip>}
                      <Chip active={chip === "ticked"} onClick={() => setChip("ticked")}>Ticked</Chip>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) 190px 190px", gap: "0 14px", fontSize: 11, color: C.muted, paddingBottom: 6, borderBottom: `1px solid ${C.border}` }}>
                      <span /><span>Launch</span>
                      {["Units", "Price"].map((h) => (
                        // over the centre line of its bars, which is where this launch sits
                        <span key={h} style={{ display: "grid", gridTemplateColumns: "44px 1fr 40px", gap: "0 8px" }}><span /><span style={{ textAlign: "center" }}>{h}</span><span /></span>
                      ))}
                    </div>
                    {shown.map((r) => {
                      const on = ticked.has(r.release_name), own = isOwn(r);
                      return (
                        <div key={r.release_name} role="checkbox" aria-checked={on} tabIndex={0}
                          onClick={() => toggle(r.release_name)}
                          onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(r.release_name); } }}
                          onMouseEnter={() => setHover(r.release_name)} onMouseLeave={() => setHover(null)}
                          style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) 190px 190px", gap: "0 14px", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${C.hairline}`, cursor: "pointer", background: hover === r.release_name ? C.hairline : "transparent" }}>
                          <input type="checkbox" checked={on} tabIndex={-1} readOnly aria-hidden="true" style={{ accentColor: C.ink, width: 15, height: 15, margin: 0, cursor: "pointer" }} />
                          <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: on ? C.ink : C.muted }} title={`${r.artist} · ${r.title}`}>
                            {r.artist} · {r.title} <span style={{ color: C.muted, fontSize: 11.5 }}>{String(r.window_end || "").slice(0, 4)}</span>
                            {own && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, letterSpacing: ".03em", padding: "1px 6px", borderRadius: 4, background: C.blueDeep, color: C.white, verticalAlign: 1 }}>own</span>}
                          </div>
                          <Bar v={r.du} under={r.units < L.target} on={on} prefix={fmt(r.units)} hint={unitsHint(r)} />
                          <Bar v={r.dp} under={r.price > 0 && r.price < priceUsed} on={on} prefix={r.price > 0 ? fmtMoney(r.price) : "–"} hint={priceHint(r)} />
                        </div>
                      );
                    })}
                    {!shown.length && <div style={{ fontSize: 12.5, color: C.muted, padding: "10px 0" }}>No launches match that filter.</div>}
                  </div>

                  <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", alignSelf: "start", position: "sticky", top: 0 }}>
                    <div className="lead" style={{ fontSize: 26 }}>{fmt(members.length)}</div>
                    <div className="lead-caption">
                      launches ticked{seed ? <> · <span title={untouched ? "These are the launches the rule picks for this release. Untick one to change it." : "Ticks have moved from the suggested launches."}>{untouched ? "as suggested" : "edited"}</span></> : null}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px", gap: 8, fontSize: 11, color: C.muted, marginTop: 10, paddingBottom: 5, borderBottom: `1px solid ${C.border}` }}>
                      <span /><span style={{ textAlign: "right" }}>This launch</span><span style={{ textAlign: "right", color: C.ink, fontWeight: 600 }}>Basket</span>
                    </div>
                    {railRow("Units", fmt(L.target), members.length ? fmt(live.units) : "–", paidOff ? "This launch's target against the basket's median units without paid - the benchmark with paid out of plan." : "This launch's target against the basket's median units at close - the benchmark.")}
                    {railRow("Unit price", fmtMoney(priceUsed), members.length && live.price > 0 ? fmtMoney(live.price) : "–", "Unit price in euros, from Airtable. Launches Airtable could not price are left out of the median.")}
                    {railRow("Sessions", null, members.length ? fmtK(live.sessions) : "–", "The basket's median sessions. This launch's own are to date, so there is nothing to compare them with yet.")}
                    {railRow("Paid share", null, paidOff ? "not run" : members.length ? fmtPct(liveAll.paid_share, 0) : "–", paidOff ? "Paid is not in plan for this release." : "Median share of sessions coming from paid.")}
                    {railRow("Uplift to target (K)", "", K === null ? "–" : "×" + fmt(K, 2), "The target over the basket's median units: how far past the benchmark this launch is being asked to go.")}
                    {thin && (
                      <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.5, background: "#fbf1e6", color: "#5a3f0a" }}>
                        {fmt(members.length)} launches is thin: dropping one moves the median about {members.length <= 4 ? "5" : "3"}%, against under 3% at the eight the suggestion picks.
                      </div>
                    )}
                    <div className="btn-row" style={{ marginTop: 14 }}>
                      <button className="btn primary" disabled={members.length < MIN_MEMBERS} onClick={use}
                        title={members.length < MIN_MEMBERS ? `Tick at least ${MIN_MEMBERS} launch${MIN_MEMBERS === 1 ? "" : "es"}.` : "Uses these launches as the benchmark basket for this release."}>Use this basket</button>
                      <button className="btn secondary" disabled={!seed || untouched} onClick={() => seed && setTicked(new Set(seed.members))}>Back to suggested</button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
