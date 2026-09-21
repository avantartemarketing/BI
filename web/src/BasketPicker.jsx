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
 * There is nothing else in it. A gallery of named baskets to choose between -
 * the four clusters, the last twelve months, the artist's own earlier launches,
 * and saved ones - was a second way to answer the same question that made the
 * list look like the advanced option, and a basket chosen by name is the thing
 * this modal exists to stop. The rule that picks the suggestion is untouched;
 * only the gallery is gone, so what it used to offer is now the order the list
 * is already in.
 *
 * Units x and Price x are how far a launch sits from this one on each axis,
 * each taken so it reads above 1 whichever side it falls. One number cannot
 * carry both: a launch matched on size and four times the price is not close,
 * and the larger of the two said so without saying which. They sort on the
 * worse of the two, which is how the search in etl/baskets.py reads a band -
 * 2x means both within 2x - so the order on screen is the order the rule
 * considered them in.
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
 * The rail puts this launch beside the basket, a row per statistic, so whether
 * the basket resembles the launch is read across rather than held in the head.
 *
 * Nothing here writes anything. `onPick` hands the chosen members back to
 * TargetSetting, which holds them as an unsaved edit until the targets are
 * saved.
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

const TH = ({ children, align, w, title }) => (
  <th title={title} style={{
    textAlign: align || "left", fontSize: 11.5, fontWeight: 500, color: C.muted,
    padding: "0 8px 6px", position: "sticky", top: 0, background: C.white,
    borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap",
    ...(w ? { width: w } : {}),
  }}>{children}</th>
);

/* One multiple. Dimmed past 4x, the widest band the search in etl/baskets.py
   ever widens to, so how far down the list "still comparable" runs is visible
   without reading every number. */
const Mult = ({ v }) => (
  <TD align="right" muted={v === null || v > 4}>
    {v === null ? "–" : "×" + fmt(v, v < 10 ? 1 : 0)}
  </TD>
);

const TD = ({ children, align, muted, colSpan, title }) => (
  <td colSpan={colSpan} title={title} className={align === "right" ? "num" : undefined} style={{
    textAlign: align || "left", fontSize: 12.5, padding: "6px 8px",
    borderBottom: `1px solid ${C.hairline}`, color: muted ? C.muted : C.ink,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  }}>{children}</td>
);

/* The rail: this launch beside the basket it is being measured against, one
 * row per statistic, so "is this basket like my launch?" is answered by
 * reading across rather than by remembering the header. A launch's own units
 * and price are the target and the price being set on the tab, which is what
 * the whole comparison is for; its sessions and paid share are to date and
 * would be read against closed launches' totals, so those rows are the
 * basket's alone. */
function BasketRail({ profile, ticked, seed, untouched, targetUnits, unitPrice, own, placeable, onUse, onClose }) {
  const thin = ticked > 0 && ticked < THIN_MEMBERS;
  const which = !seed ? null : untouched ? "as suggested" : "edited";
  // no launches ticked is no basket at all, and a median of zero is a figure
  const has = ticked > 0;
  const bm = (v) => (has ? v : "–");
  // the sub-line gets the width of the row rather than of the label column: a
  // price range in the label column is the first thing to be cut off
  const row = (label, mine, theirs, tip, sub) => (
    <div title={tip} style={{ padding: "5px 0", borderBottom: `1px solid ${C.hairline}` }}>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 68px 68px", gap: 6, alignItems: "baseline", fontSize: 12,
      }}>
        <span style={{ color: C.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span className="num" style={{ textAlign: "right", color: mine === null ? C.muted : C.ink }}>
          {mine === null ? "–" : mine}
        </span>
        <span className="num" style={{ textAlign: "right", fontWeight: 600 }}>{theirs}</span>
      </div>
      {sub && <div style={{ fontSize: 10.5, color: C.muted, opacity: 0.85, marginTop: 1 }}>{sub}</div>}
    </div>
  );
  const days = own && own.campaign_days > 0 ? own.campaign_days : null;
  return (
    <div style={{
      width: 318, flex: "0 0 318px", border: `1px solid ${C.border}`, borderRadius: 10,
      padding: "14px 16px", background: C.white, display: "flex", flexDirection: "column",
    }}>
      <div className="lead" style={{ fontSize: 26 }}>{fmt(ticked)}</div>
      <div className="lead-caption">
        launches ticked{which ? <> · <span title={untouched
          ? "These are the launches the rule picks for this release. Untick one to change it."
          : "Ticks have moved from the suggested launches."}>{which}</span></> : null}
      </div>
      <div className="spacer-8" />
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 68px 68px", gap: 6,
        fontSize: 10.5, color: C.muted, paddingBottom: 5, borderBottom: `1px solid ${C.border}`,
      }}>
        <span />
        <span style={{ textAlign: "right" }}>This launch</span>
        <span style={{ textAlign: "right", color: C.ink, fontWeight: 600 }}>Basket</span>
      </div>
      {row("Units", placeable ? fmt(targetUnits) : null, bm(fmt(profile.units)),
        "This launch's target against the basket's median units at close - the benchmark.",
        has ? `median · middle half ${fmt(profile.units_p25)}-${fmt(profile.units_p75)}` : "median")}
      {row("Unit price", unitPrice > 0 ? fmtMoney(unitPrice) : null,
        has && profile.price > 0 ? fmtMoney(profile.price) : "–",
        "Unit price in sterling, from Airtable. Launches Airtable could not price are left out of the median.",
        has && profile.price > 0 ? `median · middle half ${fmtMoney(profile.price_p25)}-${fmtMoney(profile.price_p75)}` : "median")}
      {row("Sessions", null, bm(fmtK(profile.sessions)),
        "The basket's median sessions. This launch's own are to date, so there is nothing to compare them with yet.", "median")}
      {row("Paid share", null, bm(fmtPct(profile.paid_share, 0)),
        "Median share of sessions coming from paid.", "median")}
      {row("Campaign days", days === null ? null : fmt(days), bm(fmt(profile.campaign_days)), undefined, "median")}
      {thin && (
        <div style={{
          marginTop: 12, padding: "8px 10px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.5,
          background: "#fbf1e6", color: "#5a3f0a",
        }}>
          {fmt(ticked)} launches is thin: one more or one fewer moves the median a lot. Ten or more is steadier.
        </div>
      )}
      <div style={{ flex: 1, minHeight: 8 }} />
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={ticked < MIN_MEMBERS} onClick={onUse}
          title={ticked < MIN_MEMBERS ? `Tick at least ${MIN_MEMBERS} launches.` : "Uses these launches as the benchmark basket for this release."}>
          Use this basket
        </button>
        <button className="btn secondary" onClick={onClose}>Discard</button>
      </div>
    </div>
  );
}

export default function BasketPicker({ releaseId, releaseName, targetUnits, unitPrice, current, onPick, onClose }) {
  const [ready, setReady] = useState(null);          // {suggested, baskets, saved}
  const [rows, setRows] = useState(null);            // the draw panel, newest close first
  const [error, setError] = useState(null);
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
    ((current && current.members) || []).filter((m) => m !== releaseName)
  ));
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("similar");

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
  const byName = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) m.set(r.release_name, r);
    return m;
  }, [rows]);
  const ownArtist = (byName.get(releaseName) || {}).artist || "";

  /* How far a launch is from this one: the larger of the two ratios, each taken
     so it reads above 1 whichever side it falls. Unknown on either axis is
     unplaceable rather than close, so it sorts to the end. */
  const ratios = useMemo(() => {
    const ratio = (a, b) => (a > 0 && b > 0 ? Math.max(a / b, b / a) : null);
    return (r) => ({ units: ratio(r.units, targetUnits), price: ratio(r.price, unitPrice) });
  }, [targetUnits, unitPrice]);
  // one number to sort on: a launch is only as close as its worse axis, which
  // is how the search in etl/baskets.py reads a band too
  const offBy = useMemo(() => (r) => {
    const { units, price } = ratios(r);
    return units === null || price === null ? null : Math.max(units, price);
  }, [ratios]);
  const placeable = targetUnits > 0 && unitPrice > 0;

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
  };

  // ticks that still match what the modal opened on are that basket, not a new
  // one: picking them keeps its name, id and the ETL's own profile
  const untouched = useMemo(() => {
    if (!seed) return false;
    if (seed.members.length !== ticked.size) return false;
    return seed.members.every((m) => ticked.has(m));
  }, [seed, ticked]);

  const usePick = () => {
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
      kind: "bespoke", name: defaultName,
      n: members.length, members, profile: live,
    });
  };

  const loading = (!ready || !rows) && !error;

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
        {loading && <div style={{ padding: 24, fontSize: 12.5, color: C.muted }}>Loading launches…</div>}

        {!loading && !error && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 20, padding: "16px 24px 20px", overflow: "hidden" }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input className="control" style={{ width: 220 }} value={query}
                  onChange={(e) => setQuery(e.target.value)} placeholder="Search release or artist" />
                {placeable && (
                  <Chip active={chip === "similar"} onClick={() => setChip("similar")}>Most similar</Chip>
                )}
                <Chip active={chip === "all"} onClick={() => setChip("all")}>All</Chip>
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
                      {placeable && <TH w={74} align="right" title="This launch's units divided by theirs, or theirs by this launch's - whichever reads above 1.">Units ×</TH>}
                      {placeable && <TH w={74} align="right" title="The same on unit price.">Price ×</TH>}
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
                          {placeable && <Mult v={ratios(r).units} />}
                          {placeable && <Mult v={ratios(r).price} />}
                        </tr>
                      );
                    })}
                    {rows && !shown.length && (
                      <tr><TD muted colSpan={placeable ? 10 : 8}>No launches match that filter.</TD></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <BasketRail profile={live} ticked={tickedRows.length} seed={seed} untouched={untouched}
              targetUnits={targetUnits} unitPrice={unitPrice} own={byName.get(releaseName)}
              placeable={placeable} onUse={usePick} onClose={onClose} />
          </div>
        )}
      </div>
    </div>
  );
}
