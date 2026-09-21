/* The basket picker (docs/BENCHMARK_SPEC.md §8, API §6).
 *
 * The benchmark is the median of a basket of comparable past launches (§1, §3),
 * so choosing the basket is the single most consequential thing anyone does on
 * the Target setting tab - it moves every reference mark on every card. This
 * modal is where that choice is made, and it is built to make the choice
 * legible rather than quick: every basket shows what it would benchmark this
 * release against before it is picked.
 *
 * It opens on the launches themselves, ordered by how close they are to this
 * one on the two criteria that carry the benchmark - units and price - with the
 * suggested basket already ticked. That is the whole interaction: look at who
 * is in, untick the ones that do not belong, tick the ones that do. A basket
 * nobody can see is a basket nobody can argue with, and the one before this
 * asked people to accept a named basket whose members were a tooltip away.
 *
 * Ready-made is still there, behind the second tab: the four clusters, the last
 * twelve months and the artist's own earlier launches, already matched and with
 * the suggested one flagged. It is the quick way to swap the whole basket at
 * once rather than edit one.
 *
 * "Off by" is how far a launch sits from this one: the larger of its units
 * ratio and its price ratio, both taken so they read above 1 whichever side
 * they fall. It is the same measure the search in etl/baskets.py widens - a
 * band of 2x means both within 2x - so the order on screen is the order the
 * rule would have considered them in.
 *
 * The medians in the Bespoke rail are recomputed in the browser from the
 * candidate rows as ticks change, because a python round-trip per tick would
 * make the rail lag the ticks and nobody would trust either. They are a preview
 * only: the medians that end up on the page are always the ETL's (etl/baskets.py
 * owns them, §3.2), recomputed server-side when the basket is saved. The one
 * thing the preview must get right is the shape of the answer, and for the
 * headline medians a plain median of the panel column is exactly what the ETL
 * takes.
 *
 * Nothing here writes to a release. `onPick` hands the chosen basket back to
 * TargetSetting, which holds it as an unsaved edit until the targets are saved.
 * The one write is `Save as ready-made` (POST /api/baskets), which adds a basket
 * everyone can pick and is deliberately separate from choosing one.
 */
import React, { useEffect, useMemo, useState } from "react";
import { C, fmt, fmtK, fmtMoney, fmtPct } from "./ui.jsx";

// both mirror etl/baskets.py, which is the only place they are enforced: below
// MIN a basket cannot be used at all, below THIN it is usable but thin (§3.2)
const MIN_MEMBERS = 3;
const THIN_MEMBERS = 10;
const YEAR_MS = 365 * 86400000;

const EXPLAINER = "Benchmark = the median of the basket, per metric and per channel.";

/* Linear-interpolated quantile, the same convention pandas uses, so the rail's
 * preview and the ETL's medians agree on an even-sized basket instead of
 * differing by half a launch. */
function quantile(values, q) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

const col = (rows, key) => rows.map((r) => (r[key] === null || r[key] === undefined ? NaN : Number(r[key])));
const median = (rows, key) => quantile(col(rows, key), 0.5);

/* The headline medians of a hand-picked basket, in the profile's own naming so
 * the ready-made cards and the bespoke rail can be read by the same code. The
 * per-group medians are absent on purpose: they are median share x median total
 * (§3.2) and the candidate rows do not carry the shares, so the browser would
 * have to guess at the one number the spec is most explicit about. */
function liveProfile(rows) {
  // a launch Airtable could not price carries 0, and is left out of the price
  // range the way the ETL leaves it out (§3.2)
  const priced = rows.filter((r) => Number(r.price) > 0);
  return {
    n: rows.length,
    members: rows.map((r) => r.release_name),
    units: median(rows, "units"),
    units_p25: quantile(col(rows, "units"), 0.25),
    units_p75: quantile(col(rows, "units"), 0.75),
    price: median(priced, "price"),
    price_p25: quantile(col(priced, "price"), 0.25),
    price_p75: quantile(col(priced, "price"), 0.75),
    n_priced: priced.length,
    sessions: median(rows, "sessions"),
    campaign_days: median(rows, "campaign_days"),
    paid_share: median(rows, "paid_share"),
  };
}

// a ready-made profile keeps the paid share inside its renormalised session
// shares; a hand-picked one carries it directly. Both answer "paid <pct>%".
const paidShareOf = (p) => (p && p.share_sessions ? p.share_sessions.paid : p && p.paid_share) ?? null;

/* The basket's unit prices in sterling, median and middle half, next to the
 * units range it sits beside - the price band is part of what "comparable"
 * means for the default basket (§3.1), so every basket says where it sits. */
const priceRange = (p) => (p && p.price > 0
  ? `price ${fmtMoney(p.price)} (${fmtMoney(p.price_p25)}-${fmtMoney(p.price_p75)})`
  : "price –");

function statsLine(p, n) {
  return `${fmt(n)} launches · units ${fmt(p.units)} (${fmt(p.units_p25)}-${fmt(p.units_p75)})`
    + ` · ${priceRange(p)}`
    + ` · sessions ${fmtK(p.sessions)} · paid ${fmtPct(paidShareOf(p), 0)} · ${fmt(p.campaign_days)} days`;
}

const Chip = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{
    fontFamily: "inherit", fontSize: 12, fontWeight: active ? 600 : 500, padding: "3px 9px",
    borderRadius: 5, cursor: "pointer", whiteSpace: "nowrap",
    border: `1px solid ${active ? C.ink : C.border}`,
    background: active ? C.ink : C.white, color: active ? "#fff" : C.muted,
  }}>{children}</button>
);

const TH = ({ children, align, w }) => (
  <th style={{
    textAlign: align || "left", fontSize: 11.5, fontWeight: 500, color: C.muted,
    padding: "0 8px 6px", position: "sticky", top: 0, background: C.white,
    borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap",
    ...(w ? { width: w } : {}),
  }}>{children}</th>
);

const TD = ({ children, align, muted, colSpan, title }) => (
  <td colSpan={colSpan} title={title} className={align === "right" ? "num" : undefined} style={{
    textAlign: align || "left", fontSize: 12.5, padding: "6px 8px",
    borderBottom: `1px solid ${C.hairline}`, color: muted ? C.muted : C.ink,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  }}>{children}</td>
);

/* One ready-made basket. A basket under three members is shown rather than
 * hidden - "same artist, only two earlier launches" is a real answer to the
 * question someone came here to ask, and hiding it would read as a bug. */
function ReadyCard({ basket, checked, suggested, onChoose }) {
  const p = basket.profile || {};
  const disabled = !!basket.disabled || (basket.n || 0) < MIN_MEMBERS;
  const members = p.members || basket.members || [];
  return (
    <label style={{
      display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px",
      border: `1px solid ${checked ? C.ink : C.border}`, borderRadius: 10,
      background: checked ? "#faf9f5" : C.white, opacity: disabled ? 0.6 : 1,
      cursor: disabled ? "default" : "pointer",
    }}>
      <input type="radio" name="ready-basket" checked={checked} disabled={disabled}
        onChange={() => onChoose(basket)} style={{ marginTop: 3, accentColor: C.ink, cursor: "inherit" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{basket.name}</span>
          {suggested && (
            <span className="lozenge blue" style={{ fontSize: 11, padding: "1px 6px" }}
              title="The basket this release matches on the clustering (BENCHMARK_SPEC 3.3).">Suggested</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>{basket.desc}</div>
        <div className="num" style={{ fontSize: 12, marginTop: 6, color: disabled ? C.muted : C.ink }}>
          {disabled
            ? `Only ${fmt(basket.n)} comparable ${basket.n === 1 ? "launch" : "launches"} - a basket needs at least ${MIN_MEMBERS} to read a median from.`
            : statsLine(p, basket.n)}
        </div>
        {members.length > 0 && (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={members.join(", ")}>
            e.g. {members.slice(0, 3).join(", ")}
          </div>
        )}
      </div>
    </label>
  );
}

/* The live rail: what the ticked launches would make the benchmark. */
function BespokeRail({ profile, ticked, seed, untouched, saveName, setSaveName, onSave, saving, onUse, note }) {
  const thin = ticked > 0 && ticked < THIN_MEMBERS;
  // which basket this is: the one the modal opened on until a tick changes it
  const which = !seed ? null : untouched ? seed.name : `${seed.name}, edited`;
  const row = (label, value, tip) => (
    <div className="legend-row" title={tip}>
      <span style={{ color: C.muted }}>{label}</span>
      <span className="val">{value}</span>
    </div>
  );
  return (
    <div style={{
      width: 268, flex: "0 0 268px", border: `1px solid ${C.border}`, borderRadius: 10,
      padding: "14px 16px", background: C.white, display: "flex", flexDirection: "column",
    }}>
      <div className="lead" style={{ fontSize: 26 }}>{fmt(ticked)}</div>
      <div className="lead-caption">
        launches ticked{which ? <> · <span title={untouched
          ? "The basket this release is benchmarked against today. Untick a launch to change it."
          : "Ticks have moved from the suggested basket, so this saves as a basket of its own."}>{which}</span></> : null}
      </div>
      <div className="spacer-8" />
      <div className="legend-rows" style={{ marginTop: 0 }}>
        {row("Units (median)", fmt(profile.units), "The benchmark this basket would set for units at close.")}
        {row("Middle half", `${fmt(profile.units_p25)}-${fmt(profile.units_p75)}`, "The 25th to 75th percentile of the basket's units - how spread out it is.")}
        {row("Unit price (median)", profile.price > 0 ? fmtMoney(profile.price) : "–",
          "Median unit price of the ticked launches in sterling, from Airtable. Launches Airtable could not price are left out.")}
        {row("Price middle half", profile.price > 0 ? `${fmtMoney(profile.price_p25)}-${fmtMoney(profile.price_p75)}` : "–",
          "The 25th to 75th percentile of the basket's unit prices.")}
        {row("Sessions (median)", fmtK(profile.sessions))}
        {row("Paid share", fmtPct(profile.paid_share, 0), "Median share of sessions coming from paid.")}
        {row("Campaign days", fmt(profile.campaign_days))}
      </div>
      {thin && (
        <div style={{
          marginTop: 12, padding: "8px 10px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.5,
          background: "#fbf1e6", color: "#5a3f0a",
        }}>
          {fmt(ticked)} launches is thin: one more or one fewer moves the median a lot. Ten or more is steadier.
        </div>
      )}
      <div style={{ height: 14 }} />
      <div className="flabel" style={{ marginBottom: 6 }}>Save as ready-made</div>
      <input className="control" value={saveName} onChange={(e) => setSaveName(e.target.value)}
        placeholder={seed ? `${seed.name} (edited)` : "Basket name"}
        title="Saves this selection as a basket everyone can pick, for every release." />
      {note && <div style={{ fontSize: 11.5, color: note.bad ? C.red : C.muted, marginTop: 8, lineHeight: 1.5 }}>{note.text}</div>}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={ticked < MIN_MEMBERS} onClick={onUse}
          title={ticked < MIN_MEMBERS ? `Tick at least ${MIN_MEMBERS} launches.` : "Uses this selection as the benchmark basket for this release."}>
          Use this basket
        </button>
        <button className="btn secondary" disabled={saving || ticked < MIN_MEMBERS || !saveName.trim()} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export default function BasketPicker({ releaseId, releaseName, targetUnits, unitPrice, current, onPick, onClose }) {
  const [tab, setTab] = useState("list");
  const [ready, setReady] = useState(null);          // {suggested, baskets, saved}
  const [rows, setRows] = useState(null);            // the draw panel, newest close first
  const [error, setError] = useState(null);
  const [pickedId, setPickedId] = useState(current && current.kind !== "bespoke" ? current.id || null : null);
  // a release is never a member of its own benchmark (§3.1), so its own name is
  // never allowed into the set, not merely unticked in the table
  /* The ticks start as the suggested basket, so the modal opens on an answer
     rather than on an empty table. `seed` remembers what that answer was: ticks
     untouched from it are still that basket, and picking them keeps its name
     and id instead of turning every release that was merely looked at into a
     bespoke one. An edit that lands back on the same members is the same
     basket, so this compares the sets rather than tracking that it was
     touched. */
  const [seed, setSeed] = useState(null);       // {id, name, kind, members}
  const [ticked, setTicked] = useState(() => new Set(
    ((current && current.kind === "bespoke" && current.members) || []).filter((m) => m !== releaseName)
  ));
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("similar");
  const [saveName, setSaveName] = useState((current && current.name) || "");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null);

  // Escape closes. Nothing else is trapped: the picker sits over a page that is
  // still readable behind it, and stealing tab focus from it would be worse
  // than letting it keep it.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const q = releaseId ? `?release=${encodeURIComponent(releaseId)}` : "";
    fetch(`/api/baskets${q}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      setReady(d);
      setPickedId((id) => id || d.suggested || null);
      // a release that already carries a bespoke basket keeps it; anything else
      // opens on the suggestion, which is what the page is using today
      const sug = [...(d.baskets || []), ...(d.saved || [])].find((b) => b.id === d.suggested);
      const members = ((sug && (sug.profile || {}).members) || sug?.members || [])
        .filter((m) => m !== releaseName);
      if (sug && members.length) {
        setSeed({ id: sug.id, name: sug.name, kind: sug.kind || "ready", members });
        setTicked((t) => (t.size ? t : new Set(members)));
      }
    }).catch((e) => setError(String(e)));
    fetch("/api/baskets/candidates").then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      setRows(d.rows || []);
    }).catch((e) => setError(String(e)));
  }, [releaseId]);

  const baskets = useMemo(
    () => [...((ready && ready.baskets) || []), ...((ready && ready.saved) || [])],
    [ready]
  );
  const selected = baskets.find((b) => b.id === pickedId) || null;

  const byName = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) m.set(r.release_name, r);
    return m;
  }, [rows]);
  const ownArtist = (byName.get(releaseName) || {}).artist || "";

  /* How far a launch is from this one: the larger of the two ratios, each taken
     so it reads above 1 whichever side it falls. Unknown on either axis is
     unplaceable rather than close, so it sorts to the end. */
  const offBy = useMemo(() => {
    const ratio = (a, b) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : null);
    return (r) => {
      const du = ratio(r.units, targetUnits);
      const dp = ratio(r.price, unitPrice);
      if (du === null && dp === null) return null;
      if (du === null || dp === null) return null;
      return Math.max(du, dp);
    };
  }, [targetUnits, unitPrice]);
  const placeable = targetUnits > 0 && unitPrice > 0;

  const clusterNames = useMemo(() => {
    const seen = [];
    for (const r of rows || []) if (r.cluster_name && !seen.includes(r.cluster_name)) seen.push(r.cluster_name);
    return seen;
  }, [rows]);

  /* Ordered by distance whenever this release has a size and a price to measure
     against, so the launches a basket would be built from are the ones at the
     top; newest first otherwise, which is the only order left. A ticked member
     is never filtered out of the list - unticking something you can no longer
     see is not an edit anyone can follow - so every view keeps the ticks in it.
     "Most similar" is the widest band the search in etl/baskets.py ever widens
     to, 4x on both, and never fewer than a usable basket's worth. */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cutoff = Date.now() - YEAR_MS;
    let list = (rows || []).filter((r) => {
      if (q && !`${r.release_name} ${r.artist} ${r.title}`.toLowerCase().includes(q)) return false;
      if (ticked.has(r.release_name)) return true;
      if (chip === "12m") return r.window_end && new Date(r.window_end).getTime() >= cutoff;
      if (chip === "artist") return !!ownArtist && r.artist === ownArtist;
      if (chip === "ticked") return false;
      if (chip.startsWith("c:")) return r.cluster_name === chip.slice(2);
      return true;
    });
    if (placeable) {
      list = list.map((r) => ({ r, d: offBy(r) }))
        .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity))
        .map((x) => x.r);
      if (chip === "similar") {
        const near = list.filter((r) => ticked.has(r.release_name) || (offBy(r) ?? Infinity) <= 4);
        list = near.length >= THIN_MEMBERS + 2 ? near : list.slice(0, THIN_MEMBERS + 2);
      }
    }
    return list;
  }, [rows, query, chip, ticked, ownArtist, offBy, placeable]);

  const tickedRows = useMemo(
    () => (rows || []).filter((r) => ticked.has(r.release_name)),
    [rows, ticked]
  );
  const live = useMemo(() => liveProfile(tickedRows), [tickedRows]);

  // an edited suggestion says so, rather than every basket being "Bespoke"
  const defaultName = seed ? `${seed.name} (edited)` : "Bespoke basket";

  const toggle = (name) => {
    if (name === releaseName) return;
    const next = new Set(ticked);
    if (next.has(name)) next.delete(name); else next.add(name);
    setTicked(next);
    setNote(null);
  };

  const useReady = () => {
    if (!selected) return;
    onPick({
      kind: selected.kind || "ready", id: selected.id, name: selected.name,
      n: selected.n, members: (selected.profile || {}).members || selected.members || [],
      profile: selected.profile || null,
    });
  };

  // ticks that still match what the modal opened on are that basket, not a new
  // one: picking them keeps its name, id and the ETL's own profile
  const untouched = useMemo(() => {
    if (!seed) return false;
    if (seed.members.length !== ticked.size) return false;
    return seed.members.every((m) => ticked.has(m));
  }, [seed, ticked]);

  const useBespoke = () => {
    if (untouched) {
      const b = baskets.find((x) => x.id === seed.id);
      if (b) {
        onPick({
          kind: b.kind || "ready", id: b.id, name: b.name,
          n: b.n, members: (b.profile || {}).members || b.members || [],
          profile: b.profile || null,
        });
        return;
      }
    }
    const members = tickedRows.map((r) => r.release_name);
    onPick({
      kind: "bespoke", name: saveName.trim() || defaultName,
      n: members.length, members, profile: live,
    });
  };

  /* Save as ready-made. The saved basket comes back with the ETL's own profile,
   * so it is added to the list and selected rather than re-fetched - the answer
   * on screen is then the one the server computed, not the browser's preview. */
  const saveReadyMade = async () => {
    setSaving(true); setNote(null);
    try {
      const res = await fetch("/api/baskets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), members: tickedRows.map((r) => r.release_name) }),
      });
      const d = await res.json();
      if (!res.ok) { setNote({ bad: true, text: d.error || `save failed (${res.status})` }); return; }
      setReady((prev) => ({ ...(prev || {}), saved: [...((prev && prev.saved) || []), d] }));
      setPickedId(d.id);
      setTab("ready");
      setNote({ text: `Saved as "${d.name}".` });
    } catch (e) {
      setNote({ bad: true, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const loading = !ready && !error;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 60, background: "rgba(20,20,19,0.28)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div role="dialog" aria-label="Choose a benchmark basket" style={{
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 12,
        boxShadow: "0 12px 40px rgba(20,20,19,0.18)", width: "min(1280px, 96vw)",
        maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden",
      }}>

        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.hairline}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Benchmark basket</span>
            <span style={{ fontSize: 12, color: C.muted }}>{releaseName}</span>
            <button className="btn secondary" onClick={onClose} style={{ marginLeft: "auto", padding: "4px 10px" }}>Close</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
            <div className="seg" role="group" aria-label="Basket kind">
              <button className={tab === "list" ? "active" : ""} onClick={() => setTab("list")}>Launches</button>
              <button className={tab === "ready" ? "active" : ""} onClick={() => setTab("ready")}>Ready-made</button>
            </div>
            <span style={{ fontSize: 12, color: C.muted }}>{EXPLAINER}</span>
            {placeable && (
              <span style={{ fontSize: 12, color: C.muted, marginLeft: "auto", whiteSpace: "nowrap" }}
                title="Every launch below is measured against these two numbers.">
                This launch: <b style={{ color: C.ink }}>{fmt(targetUnits)}</b> units at{" "}
                <b style={{ color: C.ink }}>{fmtMoney(unitPrice)}</b>
              </span>
            )}
          </div>
        </div>

        {error && <div style={{ padding: "14px 24px", fontSize: 12.5, color: C.red }}>{error}</div>}
        {loading && <div style={{ padding: 24, fontSize: 12.5, color: C.muted }}>Loading baskets…</div>}

        {tab === "ready" && ready && (
          <>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 24px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                {baskets.map((b) => (
                  <ReadyCard key={b.id} basket={b} checked={b.id === pickedId}
                    suggested={b.id === ready.suggested} onChoose={(x) => setPickedId(x.id)} />
                ))}
              </div>
            </div>
            <div style={{
              display: "flex", alignItems: "center", gap: 12, padding: "14px 24px",
              borderTop: `1px solid ${C.hairline}`, background: "#faf9f5",
            }}>
              <span style={{ fontSize: 12.5, color: C.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selected
                  ? <>Selected: <b style={{ color: C.ink }}>{selected.name}</b> · benchmark {fmt((selected.profile || {}).units)} units at close</>
                  : "Nothing selected"}
              </span>
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button className="btn primary" disabled={!selected || selected.disabled} onClick={useReady}>Use this basket</button>
                <button className="btn secondary" onClick={onClose}>Discard</button>
              </div>
            </div>
          </>
        )}

        {tab === "list" && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 20, padding: "16px 24px 20px", overflow: "hidden" }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input className="control" style={{ width: 220 }} value={query}
                  onChange={(e) => setQuery(e.target.value)} placeholder="Search release or artist" />
                {placeable && (
                  <Chip active={chip === "similar"} onClick={() => setChip("similar")}>Most similar</Chip>
                )}
                <Chip active={chip === "all"} onClick={() => setChip("all")}>All</Chip>
                {clusterNames.map((n) => (
                  <Chip key={n} active={chip === `c:${n}`} onClick={() => setChip(`c:${n}`)}>{n}</Chip>
                ))}
                <Chip active={chip === "12m"} onClick={() => setChip("12m")}>Last 12 months</Chip>
                {ownArtist && <Chip active={chip === "artist"} onClick={() => setChip("artist")}>Same artist</Chip>}
                <Chip active={chip === "ticked"} onClick={() => setChip("ticked")}>Ticked</Chip>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 12, border: `1px solid ${C.border}`, borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <TH w={34} />
                      <TH>Release</TH>
                      <TH w={88}>Closed</TH>
                      <TH w={52} align="right">Days</TH>
                      <TH w={64} align="right">Units</TH>
                      <TH w={78} align="right">Price</TH>
                      <TH w={76} align="right">Sessions</TH>
                      <TH w={54} align="right">Paid</TH>
                      {placeable && <TH w={64} align="right">Off by</TH>}
                      <TH w={148}>Basket</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const own = r.release_name === releaseName;
                      return (
                        <tr key={r.release_name} onClick={() => toggle(r.release_name)}
                          title={own ? "A release is never a member of its own benchmark." : `${r.artist} - ${r.title}`}
                          style={{ cursor: own ? "default" : "pointer", opacity: own ? 0.5 : 1 }}>
                          <TD>
                            <input type="checkbox" checked={ticked.has(r.release_name)} disabled={own}
                              onChange={() => toggle(r.release_name)} onClick={(e) => e.stopPropagation()}
                              style={{ accentColor: C.ink, cursor: own ? "default" : "pointer" }} />
                          </TD>
                          <TD>{r.release_name}{own ? " (this release)" : ""}</TD>
                          <TD muted>{r.window_end || "–"}</TD>
                          <TD align="right">{fmt(r.campaign_days)}</TD>
                          <TD align="right">{fmt(r.units)}</TD>
                          <TD align="right" muted={!(r.price > 0)}>{r.price > 0 ? fmtMoney(r.price) : "–"}</TD>
                          <TD align="right">{fmtK(r.sessions)}</TD>
                          <TD align="right">{fmtPct(r.paid_share, 0)}</TD>
                          {placeable && (
                            <TD align="right" muted={(offBy(r) ?? Infinity) > 4}>
                              {offBy(r) === null ? "–" : "×" + fmt(offBy(r), offBy(r) < 10 ? 1 : 0)}
                            </TD>
                          )}
                          <TD muted title={r.cluster_name || ""}>{r.cluster_name || "–"}</TD>
                        </tr>
                      );
                    })}
                    {rows && !shown.length && (
                      <tr><TD muted colSpan={placeable ? 10 : 9}>No launches match that filter.</TD></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <BespokeRail profile={live} ticked={tickedRows.length} seed={seed} untouched={untouched}
              saveName={saveName} setSaveName={setSaveName}
              onSave={saveReadyMade} saving={saving} onUse={useBespoke} note={note} />
          </div>
        )}
      </div>
    </div>
  );
}
