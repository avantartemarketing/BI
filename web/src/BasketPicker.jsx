/* The basket picker (docs/BENCHMARK_SPEC.md §8, docs/TL_SPEC.md §8): a page
 * of its own under the targets tab, as the design canvas draws it. The
 * benchmark is the median of a basket of comparable past launches, so
 * choosing the basket is the most consequential thing anyone does on the
 * targets page: it moves every reference mark on every card. Every launch
 * on file is a dot on a map of units of demand (what it would have sold with
 * enough supply, shared/basketRule.mjs sizeOf) against unit price, this launch
 * is the orange ring, and the basket is what is nearest to it; the list
 * under the map says the same thing in rows, the basket first, then the
 * near misses, with each launch's distance (the larger of its units
 * multiple and its price multiple).
 *
 * The rule lives in etl/baskets.py (similar_members), which the build runs
 * when a basket is saved, and in shared/basketRule.mjs, its JS mirror, which
 * runs here over the candidate rows as someone types a target or flips a
 * toggle. The artist's own earlier launches come first, then the nearest on
 * units and price, with launches closed in the last eighteen months ranked
 * ahead of older ones among the comparable when Recent first is on. It is
 * read on the page's day (asOf), and a release that has closed at its own
 * close, leaving out the launches that closed after it. A timed launch's
 * rows are the TL panel's, and with 48 h first on the rule runs over the
 * launches of the same window length when enough are on file (etl/tl.py
 * ready_baskets, TL_THIN), so the map suggests what the build will use.
 *
 * Nothing here writes anything. Use hands the ticked launches back to the
 * page, which saves them; ticks still matching the suggestion pick it by
 * id, with the ETL's own profile, so merely looking does not turn a release
 * bespoke. The Paid toggle is the release's channels-in-plan setting, read
 * back through onInputs (it was wired to nothing before). */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Menu, MenuItem, useMenu } from "./ui.jsx";
import { fmt, fmtMoney, fmtPct } from "./format.mjs";
import { Bars, Chev, Clock, Euro, Filter, People, Search, Undo, Wallet } from "./icons.jsx";
import { similarMembers, ownMembers, releasePrice, releaseArtist, basketClock, MIN_MEMBERS, THIN_MEMBERS, NEAR, sizeOf } from "../../shared/basketRule.mjs";
import { applyChannelsOff } from "../../shared/benchmarkModel.mjs";
import { colorFor, fmtMonth, hoursShort, liveProfile, median } from "./TargetsKit.jsx";

const SIMILAR_NAME = "Similar size and shape";   // etl/baskets.py SIMILAR_NAME: the basket with id similar_size
const NEAR_MISSES = 8;
const YEAR_MS = 365 * 86400000;
const ratio = (a, b) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : null);
const day = (s) => (s ? new Date(String(s).slice(0, 10) + "T00:00:00Z") : null);
const x2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `×${v.toFixed(2)}`);
const positive = (vals) => median(vals.filter((v) => typeof v === "number" && v > 0));

/* The medians of a set of the TL panel's rows, in the shape etl/tl.py
 * basket_profile writes (without the curves): the picker's own reading of a
 * basket until the save rebuilds the page. */
function tlProfile(rows) {
  const col = (f) => rows.map((r) => (typeof r[f] === "number" ? r[f] : null));
  return { n: rows.length, units: median(col("units")), signups: median(col("signups")), price: positive(col("price")), sessions: median(col("sessions")),
    paid_share: median(rows.map((r) => ((r.signup_shares || r.unit_shares || {}).paid))) };
}

/* The map: units of demand across, price up, both on log scales; a dot is pressed
 * to tick its launch. The axes run over nice bounds that cover the rows and
 * this launch. */
const X_TICKS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const Y_TICKS = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];
const bounds = (vals, ticks) => {
  const v = vals.filter((n) => n > 0);
  if (!v.length) return [ticks[0], ticks[ticks.length - 1]];
  const lo = Math.min(...v), hi = Math.max(...v);
  let i0 = ticks.findIndex((t) => t > lo) - 1, i1 = ticks.findIndex((t) => t >= hi);
  if (i0 < 0) i0 = 0; if (i1 < 0) i1 = ticks.length - 1;
  if (i1 <= i0) i1 = Math.min(i0 + 1, ticks.length - 1);
  return [ticks[i0], ticks[i1]];
};
function MapPlot({ rows, L, ticked, nearMiss, otherLength, reach, hov, setHov, toggle, tipOf }) {
  const W = 1000, H = 280, Lm = 48, R = 8, T = 8, B = 28;
  const [X0, X1] = useMemo(() => bounds([...rows.map((r) => sizeOf(r)), L.target], X_TICKS), [rows, L.target]);
  const [Y0, Y1] = useMemo(() => bounds([...rows.map((r) => r.price), L.price], Y_TICKS), [rows, L.price]);
  const lx = (u) => Lm + (Math.log(Math.max(X0, Math.min(X1, u))) - Math.log(X0)) / (Math.log(X1) - Math.log(X0)) * (W - Lm - R);
  const ly = (p) => T + (1 - (Math.log(Math.max(Y0, Math.min(Y1, p))) - Math.log(Y0)) / (Math.log(Y1) - Math.log(Y0))) * (H - T - B);
  const pc = (val, t) => `${((val / t) * 100).toFixed(2)}%`;
  const xt = X_TICKS.filter((t) => t >= X0 && t <= X1), yt = Y_TICKS.filter((t) => t >= Y0 && t <= Y1);
  let grid = "";
  for (const u of xt) grid += `M${lx(u).toFixed(1)} ${T}V${H - B}`;
  for (const p of yt) grid += `M${Lm} ${ly(p).toFixed(1)}H${W - R}`;
  const mx = lx(L.target || X0), my = ly(L.price || Y0);
  const reachD = reach && Number.isFinite(reach) ? reach : null;
  const box = reachD && L.target > 0 && L.price > 0 ? `M${lx(L.target / reachD).toFixed(1)} ${ly(L.price * reachD).toFixed(1)}H${lx(L.target * reachD).toFixed(1)}V${ly(L.price / reachD).toFixed(1)}H${lx(L.target / reachD).toFixed(1)}Z` : null;
  const tip = hov ? rows.find((r) => r.release_name === hov) : null;
  return (
    <div className="pkmap">
      <div className="in">
        <div className="pkplot">
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <path d={grid || "M0 0"} stroke="#f3f3f5" strokeWidth="1" fill="none" />
            {box && <path d={box} stroke="#d5d8f6" strokeWidth="1" strokeDasharray="3 4" fill="#5e6ad2" fillOpacity="0.04" />}
            {L.target > 0 && L.price > 0 && <><circle cx={mx.toFixed(1)} cy={my.toFixed(1)} r="9" fill="#fff" stroke="#e8743b" strokeWidth="2.5" /><circle cx={mx.toFixed(1)} cy={my.toFixed(1)} r="2.4" fill="#e8743b" /></>}
          </svg>
          {xt.map((u) => <span key={`x${u}`} className="lab" style={{ left: pc(lx(u), W), top: pc(H - B + 9, H), transform: "translate(-50%,0)" }}>{fmt(u)}</span>)}
          {yt.map((p) => <span key={`y${p}`} className="lab" style={{ left: pc(Lm - 8, W), top: pc(ly(p), H), transform: "translate(-100%,-50%)" }}>€{p >= 1000 ? `${p / 1000}k` : p}</span>)}
          <span className="lab" style={{ right: 0, top: pc(H - B - 14, H) }}>Units of demand →</span>
          <span className="lab" style={{ left: pc(Lm + 6, W), top: 0 }}>Price ↑</span>
          {rows.map((r) => {
            if (!(r.price > 0) || !(sizeOf(r) > 0) || r.later) return null;
            const on = ticked.has(r.release_name), ms = nearMiss.has(r.release_name), other = otherLength && otherLength(r);
            const sz = on ? 11 : ms ? 8 : 6;
            const style = { left: pc(lx(sizeOf(r)), W), top: pc(ly(r.price), H), width: sz, height: sz,
              ...(on ? { background: "#5e6ad2", boxShadow: "0 0 0 1.5px #fff" } : ms ? { background: "#fff", boxShadow: "inset 0 0 0 1.2px #8a8a8e" } : other ? { background: "#fff", boxShadow: "inset 0 0 0 1px #d4d4d8" } : { background: "#dcdce0" }) };
            return <button key={r.release_name} className={`mdot${hov === r.release_name ? " hv" : ""}`} style={style} aria-label={`${on ? "Untick" : "Tick"} ${r.artist}${r.title ? `, ${r.title}` : ""}`} onClick={() => toggle(r.release_name)} onMouseEnter={() => setHov(r.release_name)} onMouseLeave={() => setHov(null)} />;
          })}
          {tip && tip.price > 0 && sizeOf(tip) > 0 && (
            <div className="maptip" style={{ left: pc(lx(sizeOf(tip)), W), top: pc(ly(tip.price), H) }}>
              <div style={{ fontWeight: 500 }}>{tip.artist}{tip.title && tip.title !== "Multiple" ? ` · ${tip.title}` : ""}</div>
              <div style={{ color: "#6b6b6f", marginTop: 2 }}>{tipOf(tip)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BasketPicker({ kind = "le", rows, releaseName, artist, badge, current, currentMembers, targetUnits, unitPrice, preferRecent = true, channelsOff = [],
                                       announceDate, privateRoomOpen, launchEnd, asOf, lengthHours = null, onInputs, onPick, onBack }) {
  const tl = kind === "tl";
  const [recent, setRecent] = useState(preferRecent !== false);
  const [same, setSame] = useState(!!lengthHours);
  const [view, setView] = useState("near");
  const [artistPick, setArtistPick] = useState(null);
  const [q, setQ] = useState("");
  const [hov, setHov] = useState(null);
  const [draft, setDraft] = useState({ units: targetUnits > 0 ? String(targetUnits) : "", price: unitPrice > 0 ? String(unitPrice) : "" });
  const [ticked, setTicked] = useState(() => new Set(((current && current.members) || currentMembers || []).filter((m) => m !== releaseName)));
  const seedRef = useRef(null);
  const [seed, setSeed] = useState(null);           // the suggestion in force: {id, name, kind, members}
  const tickedRef = useRef(null);
  tickedRef.current = ticked;
  const am = useMenu();

  // the two numbers everything is measured against: the release's own, else
  // what is typed here, which the page keeps as a work added by hand
  const typedUnits = Number(String(draft.units).replace(/[^0-9]/g, "")) || 0, typedPrice = Number(String(draft.price).replace(/[^0-9]/g, "")) || 0;
  const target = targetUnits > 0 ? targetUnits : typedUnits, price = unitPrice > 0 ? unitPrice : typedPrice;
  const placeable = target > 0 && price > 0;
  const L = useMemo(() => ({ name: releaseName, artist: artist || "", target, price, currency: "EUR", private_room_open: privateRoomOpen || null, announce_date: announceDate || null, launch_end: launchEnd || null }),
    [releaseName, artist, target, price, privateRoomOpen, announceDate, launchEnd]);
  const typed = (key, raw) => {
    const clean = String(raw).replace(/[^0-9]/g, "");
    setDraft((d) => ({ ...d, [key]: clean }));
    const v = clean === "" ? null : parseInt(clean, 10);
    // the release has nothing of its own to measure against: the figure is the page's too
    if (onInputs && (key === "units" ? !(targetUnits > 0) : !(unitPrice > 0))) onInputs(key === "units" ? { edition_size: v } : { unit_price: v });
  };

  // a timed launch's rule runs over the launches of its window length when enough are on file
  const sameLength = useMemo(() => (rows && lengthHours ? rows.filter((r) => Number(r.window_hours) === Number(lengthHours)) : null), [rows, lengthHours]);
  const lengthFiltered = !!(same && sameLength && sameLength.filter((r) => r.release_name !== releaseName).length >= THIN_MEMBERS);
  const ruleRows = lengthFiltered ? sameLength : rows;
  const rule = useMemo(() => (ruleRows && placeable ? similarMembers(ruleRows, L, { preferRecent: recent, asOf }) : null), [ruleRows, L, recent, placeable, asOf]);
  const ownList = useMemo(() => (rows && placeable ? ownMembers(rows, L, { asOf }) : []), [rows, L, placeable, asOf]);
  const clock = useMemo(() => (rows ? basketClock(rows, L, asOf) : null), [rows, L, asOf]);
  /* Ticks that still equal the previous suggestion (or are empty) move to
     the new one; ticks someone has edited are theirs and stay. */
  useEffect(() => {
    const next = rule && rule.members.length ? { id: "similar_size", name: SIMILAR_NAME, kind: "ready", members: rule.members } : null;
    const prev = seedRef.current, cur = tickedRef.current;
    const untouched = !cur.size || (prev && cur.size === prev.members.length && prev.members.every((m) => cur.has(m)));
    seedRef.current = next; setSeed(next);
    if (next && untouched) setTicked(new Set(next.members));
  }, [rule]);

  const ownArtist = useMemo(() => (rows ? releaseArtist(rows, L) : (artist || String(releaseName || "").split(" · ")[0].trim())), [rows, L, artist, releaseName]);
  const priceUsed = useMemo(() => (rows ? releasePrice(rows, L) : price), [rows, L, price]);
  const isOwn = (r) => !!ownArtist && r.artist === ownArtist && r.release_name !== releaseName;
  /* every launch's two distances and its worse one, whether it closed after
     this one (left out of the rule) and whether it is recent */
  const scored = useMemo(() => (rows || []).filter((r) => r.release_name !== releaseName).map((r) => {
    const du = ratio(sizeOf(r), target), dp = r.price > 0 ? ratio(r.price, priceUsed) : 1;
    const end = day(r.window_end);
    return { ...r, du, dp, d: du === null || dp === null ? null : Math.max(du, dp), own: isOwn(r), color: colorFor(r.artist),
      later: !!(clock && clock.closed && end && end > clock.ref), recent: !!(clock && end && end >= clock.cutoff), same: lengthHours ? Number(r.window_hours) === Number(lengthHours) : true };
  }), [rows, releaseName, target, priceUsed, clock, ownArtist, lengthHours]);
  /* the rule's own order over every comparable launch: the artist's own
     first, then by tier (recent before older, beyond NEAR last, and with 48 h
     first the same window length ahead), then by distance */
  const order = useMemo(() => {
    const ownSet = new Set(ownList);
    const tier = (r) => (ownSet.has(r.release_name) ? -1 : r.d > NEAR ? 10 : (same && lengthHours && !r.same ? 2 : 0) + (recent && !r.recent ? 1 : 0));
    return scored.filter((r) => !r.later && r.d !== null && Number.isFinite(r.d)).sort((a, b) => tier(a) - tier(b) || a.d - b.d || (a.release_name < b.release_name ? -1 : 1));
  }, [scored, ownList, recent, same, lengthHours]);
  const byD = useMemo(() => scored.filter((r) => r.d !== null && Number.isFinite(r.d)).sort((a, b) => a.d - b.d || (a.release_name < b.release_name ? -1 : 1)), [scored]);

  const members = useMemo(() => scored.filter((s) => ticked.has(s.release_name)), [scored, ticked]);
  const reach = members.length ? Math.max(...members.map((m) => m.d ?? 0)) : null;
  const off = channelsOff || [];
  const paidOff = off.includes("paid");
  const liveAll = useMemo(() => (tl ? null : liveProfile(members)), [members, tl]);
  const live = useMemo(() => (liveAll ? applyChannelsOff(liveAll, off) : null), [liveAll, off.join("|")]);
  const tlp = useMemo(() => (tl ? tlProfile(members) : null), [members, tl]);
  const untouched = !!seed && ticked.size === seed.members.length && seed.members.every((m) => ticked.has(m));
  const nearMiss = useMemo(() => new Set(order.filter((r) => !ticked.has(r.release_name)).slice(0, NEAR_MISSES).map((r) => r.release_name)), [order, ticked]);

  const toggle = (name) => setTicked((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const use = () => {
    if (members.length < MIN_MEMBERS) return;
    if (untouched && seed) onPick({ kind: "ready", id: seed.id, name: seed.name, n: seed.members.length, members: seed.members, profile: liveAll, preferRecent: recent });
    else onPick({ kind: "bespoke", name: `${seed ? seed.name : "Basket"} (edited)`, n: members.length, members: members.map((m) => m.release_name), profile: liveAll, preferRecent: recent });
  };
  // Enter uses the basket, Escape goes back; neither while a box is being typed in
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "Enter") use(); else if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* the list: the basket then the near misses on the Nearest view; else the
     view's launches by distance, searched and filtered by artist */
  const query = q.trim().toLowerCase();
  const match = (r) => (!query || `${r.release_name} ${r.artist} ${r.title}`.toLowerCase().includes(query)) && (!artistPick || r.artist === artistPick);
  const cutoff12 = Date.now() - YEAR_MS;
  const in12 = (r) => r.window_end && new Date(r.window_end).getTime() >= cutoff12;
  let groups;
  if (view === "near" && !query && !artistPick) {
    const inB = [...order.filter((r) => ticked.has(r.release_name)), ...scored.filter((r) => ticked.has(r.release_name) && !order.includes(r))];
    const miss = order.filter((r) => !ticked.has(r.release_name)).slice(0, NEAR_MISSES);
    const nSame = members.filter((m) => m.same).length;
    const note = lengthHours && members.length ? (nSame === members.length ? `All ${hoursShort(lengthHours)} launches` : `${nSame} of ${members.length} are ${hoursShort(lengthHours)} launches; the rest are the nearest of any length`) : "";
    groups = [{ key: "in", name: "In the basket", rows: inB, dot: "bdot", note }, { key: "miss", name: "Near misses", rows: miss, dot: "bring", note: "" }];
  } else {
    const src = view === "own" ? byD.filter((r) => r.own) : view === "12m" ? byD.filter(in12) : view === "ticked" ? byD.filter((r) => ticked.has(r.release_name)) : byD;
    groups = [{ key: "all", rows: src.filter(match) }];
  }
  const none = groups.every((g) => !g.rows.length);
  const counts = {};
  for (const r of scored) counts[r.artist] = (counts[r.artist] || 0) + 1;
  const artists = Object.keys(counts).filter((a) => counts[a] > 1).sort();
  const views = [
    ["near", "Nearest", order.filter((r) => ticked.has(r.release_name)).length + Math.min(NEAR_MISSES, order.filter((r) => !ticked.has(r.release_name)).length), null],
    ...(ownArtist ? [["own", ownArtist, byD.filter((r) => r.own).length, colorFor(ownArtist)]] : []),
    ["12m", "Last 12 months", byD.filter(in12).length, null], ["all", "All", byD.length, null], ["ticked", "Ticked", ticked.size, null],
  ];
  const K = tl ? (tlp && tlp.units > 0 && target > 0 ? target / tlp.units : null) : (live && live.units > 0 && target > 0 ? target / live.units : null);
  const tipOf = (r) => `${lengthHours ? `${hoursShort(r.window_hours)} · ` : ""}Edition ${r.edition_size > 0 ? fmt(r.edition_size) : "–"} · ${fmt(r.units)} sold · ${r.price > 0 ? fmtMoney(r.price) : "no price"} · ${fmtMonth(r.window_end)}${r.sold_short && r.demand > r.units ? ` · sold out, demand ${fmt(r.demand)}` : ""}`;
  const loading = !rows;
  const crumbArtist = String(artist || releaseName || "").split(" · ")[0];

  const row = (r) => {
    const on = ticked.has(r.release_name);
    return (
      <div key={r.release_name} className={`pk-grid pk-tr${tl ? " tl" : ""}${on ? "" : " off"}${hov === r.release_name ? " hl" : ""}`} onMouseEnter={() => setHov(r.release_name)} onMouseLeave={() => setHov(null)}>
        <span><button className={`tick${on ? " on" : ""}`} role="checkbox" aria-checked={on} aria-label={`${r.artist}${r.title ? `, ${r.title}` : ""}`} onClick={() => toggle(r.release_name)} /></span>
        <span className="n"><span className="dot" style={{ background: r.color }} /><span className="nm">{r.artist}{r.title && r.title !== "Multiple" ? <span className="t"> · {r.title}</span> : null}{r.own && <span className="t"> · own</span>}</span></span>
        {tl && <span><span className={`dist${r.same ? "" : " after"}`} title={r.same ? "The same window length" : "Another window length"}>{hoursShort(r.window_hours)}</span></span>}
        <span>{r.edition_size > 0 ? fmt(r.edition_size) : "–"}</span>
        <span title={r.sold_short && r.demand > r.units ? `Sold out with more wanted: the benchmark counts its demand of ${fmt(r.demand)}` : undefined}>{fmt(r.units)}</span>
        <span>{r.price > 0 ? fmtMoney(r.price) : "–"}</span>
        <span className={r.later ? "later" : !r.recent ? "old" : ""} title={r.later ? "Closed after this launch: left out of the rule" : !r.recent ? "Older than eighteen months" : undefined}>{fmtMonth(r.window_end)}</span>
        <span><span className={`dist${r.later ? " after" : on ? " in" : ""}`} title={r.d !== null ? `${x2(r.du)} on units · ${x2(r.dp)} on price` : "No distance: a figure is missing"}>{r.later ? "After" : x2(r.d)}</span></span>
      </div>
    );
  };

  return (
    <div>
      <div className="pkbar">
        <span className="crumb">{crumbArtist}</span><Chev /><button className="vp" onClick={onBack}>Targets</button><Chev /><span className="here">Basket</span><Badge type={badge || (tl ? "TL" : "LE")} />
        <span className="sp" />
        <button className="ib" aria-label="Back to the suggested launches" title="Back to the suggested launches" disabled={!seed || untouched} onClick={() => seed && setTicked(new Set(seed.members))}><Undo /></button>
        <button className="act" disabled={members.length < MIN_MEMBERS} onClick={use} title={members.length < MIN_MEMBERS ? `Tick at least ${MIN_MEMBERS} launch` : untouched ? "Use the suggested launches as the benchmark basket" : "Use these launches as the benchmark basket"}>Use {members.length}<span className="k">↵</span></button>
      </div>
      <div className="vrow">
        {views.map(([k, name, n, dot]) => (
          <button key={k} className={`vp${view === k ? " on" : ""}`} aria-pressed={view === k} onClick={() => { setView(k); setArtistPick(null); }}>{dot ? <span className="vdot" style={{ background: dot }} /> : null}{name}<span className="c">{n}</span></button>
        ))}
        <span style={{ position: "relative" }}>
          <button className="vp" aria-haspopup="menu" aria-expanded={am.open} onClick={am.toggle}><Filter />{artistPick || "Artist"}</button>
          <Menu open={am.open} onClose={am.close} scroll style={{ top: 30, left: 0, minWidth: 220 }}>
            <MenuItem onClick={() => { am.close(); setArtistPick(null); }}>Any artist</MenuItem>
            {artists.map((a) => <MenuItem key={a} icon={<span className="cdot" style={{ background: colorFor(a) }} />} right={counts[a]} onClick={() => { am.close(); setArtistPick(a); setView("all"); }}>{a}</MenuItem>)}
          </Menu>
        </span>
        <span style={{ flex: 1 }} />
        <label className="find"><Search w={13} /><span className="sr">Search launches</span><input placeholder="Search artist or title" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      <div className="pkrow">
        <label className="lzin" title={targetUnits > 0 ? "The release's target, from its works" : "No target yet: type one and the basket appears"}><Bars /><span className="sr">Units target</span><input value={targetUnits > 0 ? String(targetUnits) : draft.units} readOnly={targetUnits > 0} onChange={(e) => typed("units", e.target.value)} inputMode="numeric" style={{ width: 48 }} /><span className="u">units</span></label>
        <label className="lzin" title={unitPrice > 0 ? "The release's unit price, from its works" : "No price yet: type one"}><Euro /><span className="sr">Unit price in euros</span><input value={unitPrice > 0 ? String(Math.round(unitPrice)) : draft.price} readOnly={unitPrice > 0} onChange={(e) => typed("price", e.target.value)} inputMode="numeric" style={{ width: 52 }} /></label>
        {lengthHours ? <button className={`tg${same ? " on" : ""}`} aria-pressed={same} onClick={() => setSame(!same)} title={`${hoursShort(lengthHours)} launches first; the nearest of any length when fewer than ${THIN_MEMBERS} are on file`}><Clock w={12} />{hoursShort(lengthHours)} first</button> : null}
        <button className={`tg${recent ? " on" : ""}`} aria-pressed={recent} onClick={() => setRecent(!recent)} title="Launches closed in the last eighteen months ranked ahead of older ones among the comparable. Saved with the basket."><Bars w={12} />Recent first</button>
        <button className={`tg${!paidOff ? " on" : ""}`} aria-pressed={!paidOff} onClick={() => onInputs && onInputs({ channels_off: paidOff ? off.filter((g) => g !== "paid") : [...off, "paid"] })}
          title="Running paid. The basket keeps every launch, paid or not; with paid off each counts on its other channels only, so the benchmark is what launches like this reached without paid. The release's channels-in-plan setting, saved with the targets."><Wallet w={12} />Paid</button>
        <span className="sp" />
        {tl ? (
          <>
            <span className="sv" title="The basket's median units sold in the window">Units<b>{tlp && tlp.units ? fmt(tlp.units) : "–"}</b></span>
            <span className="sv" title="The basket's median signups before the window opened">Signups<b>{tlp && tlp.signups ? fmt(tlp.signups) : "–"}</b></span>
            <span className="sv" title="The target over the basket's median units">Uplift<b>{K === null ? "–" : `×${fmt(K, 2)}`}</b></span>
            <span className="sv" title="The basket's median unit price">Price<b>{tlp && tlp.price > 0 ? fmtMoney(tlp.price) : "–"}</b></span>
            <span className="sv" title="The basket's median share of signups from paid">Paid<b>{paidOff ? "Off" : tlp && tlp.paid_share > 0 ? fmtPct(tlp.paid_share, 0) : "–"}</b></span>
          </>
        ) : (
          <>
            <span className="sv" title={paidOff ? "The basket's median units without paid: the benchmark with paid out of plan" : "The basket's median units of demand at close: the benchmark"}>Benchmark<b>{live && members.length ? fmt(Math.round(live.units * 10) / 10, live.units < 100 ? 1 : 0) : "–"}</b></span>
            <span className="sv" title="The target over the basket's median units: how far past the benchmark this launch is being asked to go">Uplift<b>{K === null ? "–" : `×${fmt(K, 2)}`}</b></span>
            <span className="sv" title="The basket's median unit price in euros; launches Airtable could not price are left out">Price<b>{live && members.length && live.price > 0 ? fmtMoney(live.price) : "–"}</b></span>
            <span className="sv" title={paidOff ? "Paid is not in plan" : "The basket's median share of sessions from paid"}>Paid<b>{paidOff ? "Off" : live && members.length ? fmtPct(live.share_sessions.paid, 0) : "–"}</b></span>
          </>
        )}
      </div>
      {loading ? <div className="pk-loading">Loading launches…</div> : (
        <>
          <MapPlot rows={scored} L={{ ...L, price: priceUsed }} ticked={ticked} nearMiss={nearMiss} otherLength={lengthHours ? (r) => !r.same : null} reach={reach} hov={hov} setHov={setHov} toggle={toggle} tipOf={tipOf} />
          <div>
            <div className={`pk-grid pk-th${tl ? " tl" : ""}`}><span /><span>Launch</span>{tl && <span>Window</span>}<span>Edition</span><span>Sold</span><span>Price</span><span>Closed</span><span>Distance</span></div>
            <div className={`pk-grid pk-tr me${tl ? " tl" : ""}`}>
              <span><span className="me" /></span>
              <span className="n"><span className="nm">{crumbArtist}{L.name && L.name.split(" · ")[1] && L.name.split(" · ")[1] !== "Multiple" ? <span className="t"> · {L.name.split(" · ")[1]}</span> : null}</span></span>
              {tl && <span><span className="dist">{hoursShort(lengthHours)}</span></span>}
              <span>{target > 0 ? fmt(target) : "–"}</span><span style={{ color: "#a1a1aa" }}>target</span><span>{priceUsed > 0 ? fmtMoney(priceUsed) : "–"}</span><span>{launchEnd ? fmtMonth(launchEnd) : ""}</span><span />
            </div>
            {!placeable && <div className="empty"><People w={22} />Both a target and a price are needed before there is anything to be near to. Type them above and the basket appears.</div>}
            {placeable && groups.map((g) => (
              <div key={g.key}>
                {g.name && <div className="band"><span className={g.dot} />{g.name}<span className="c">{g.rows.length}</span>{g.note ? <span className="nt">{g.note}</span> : null}</div>}
                {g.rows.map(row)}
              </div>
            ))}
            {placeable && none && <div className="empty"><People w={22} />{view === "own" ? `No earlier launches by ${ownArtist}` : "No launches match"}</div>}
            {placeable && !tl && members.length > 0 && members.length < THIN_MEMBERS && (
              <div className="band"><span className="bring" />Thin basket<span className="nt">{fmt(members.length)} launches: dropping one moves the median about {members.length <= 4 ? "5" : "3"}%, against under 3% at the eight the suggestion picks</span></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
