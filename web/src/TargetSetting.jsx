/* Target setting tab - the settled design (docs/BENCHMARK_SPEC.md §8, and the
 * Release Target Setting canvas for the parts §8 does not move):
 * inputs left (Release & timeline, Economics with derived per-unit fields,
 * Benchmark basket, Stretch), derived targets rail right, recomputing live via
 * the shared target model. Save persists inputs and the server retargets the
 * release snapshot in place.
 *
 * §8 replaces the old Model levers card with two cards, and the reason is the
 * change of question. The levers asked "what shape of launch is this?" and
 * every answer was a quartile pick; the benchmark model asks "which past
 * launches is this one like?" and then applies one even uplift K to reach the
 * sellout (§1, §4). So the basket is now the first-class input and the sellout
 * is the only lever - what is left over is the stretch, stated rather than
 * dialled in.
 *
 * The levers have not gone: a release with no basket, and anyone who picks
 * `By channel`, still runs the quartile model exactly as before (§4,
 * targeting_mode "levers"), so that whole code path survives here untouched
 * behind the `stretch_mode` switch.
 *
 * Everything benchmark-shaped is guarded on `snap.benchmark` being present
 * (§5: all new fields are additive). Without it the two cards say so, the rail's
 * Benchmark and Stretch columns are dashes, and every other part of this tab
 * behaves exactly as it did before the benchmark existed. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import BasketPicker from "./BasketPicker.jsx";
import { computeTargets } from "../../shared/targetModel.mjs";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const BLUE = "#28518f", BLUE_FILL = "#c3d5ee";

// the five display groups, in the order the profile dicts are written
// (etl/baskets.py GROUPS), so the table reads the same way as the snapshot
const GROUPS = [
  { key: "aa_email", name: "AA Email" },
  { key: "aa_social", name: "AA Meta" },
  { key: "referral_artist", name: "Referral artist" },
  { key: "search_direct_other", name: "Search / direct / other" },
  { key: "paid", name: "Paid" },
];

function Slider({ options, value, onChange, big, tip }) {
  const ref = useRef(null);
  const n = options.length;
  const idx = Math.max(options.indexOf(value), 0);
  const pos = (idx / (n - 1)) * 100;
  const pick = (clientX) => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.round(clamp((clientX - r.left) / r.width, 0, 1) * (n - 1));
    if (options[i] !== value) onChange(options[i]);
  };
  const trackTop = big ? 12 : 7;
  return (
    <div
      ref={ref}
      title={tip}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons) pick(e.clientX); }}
      style={{ position: "relative", height: big ? 46 : 20, touchAction: "none", cursor: "pointer", flex: 1 }}
    >
      <div style={{ position: "absolute", left: 0, right: 0, top: trackTop, height: 6, background: C.track, borderRadius: 3 }} />
      <div style={{ position: "absolute", left: 0, top: trackTop, width: `${pos}%`, height: 6, background: BLUE_FILL, borderRadius: 3 }} />
      {options.map((o, i) => (
        <span key={o} style={{
          position: "absolute", left: `${(i / (n - 1)) * 100}%`, top: trackTop - 3,
          width: 2, height: 12, marginLeft: -1, background: "#c8c5bc",
        }} />
      ))}
      <span style={{
        position: "absolute", left: `${pos}%`, top: trackTop - 7, width: big ? 20 : 16, height: big ? 20 : 16,
        marginLeft: big ? -10 : -8, borderRadius: "50%", background: "#fff",
        border: `${big ? 2.5 : 2}px solid ${BLUE}`, boxSizing: "border-box",
        boxShadow: "0 1px 4px rgba(20,20,19,0.15)", cursor: "grab",
      }} />
      {big && options.map((o, i) => (
        <span key={o + "-l"} style={{
          position: "absolute", top: 32, whiteSpace: "nowrap", fontSize: 11.5,
          left: `${(i / (n - 1)) * 100}%`,
          transform: i === 0 ? "none" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)",
          fontWeight: o === value ? 600 : 500, color: o === value ? BLUE : C.muted,
        }}>{o}</span>
      ))}
    </div>
  );
}

const Field = ({ label, tip, children }) => (
  <div>
    <div className="flabel" title={tip}>{label}</div>
    {children}
  </div>
);

/* Match status for the Meta-campaign picker, against the live spend feed. */
function CampaignHint({ value, campaigns }) {
  const v = (value || "").trim();
  const style = { fontSize: 11.5, marginTop: 4, color: C.muted };
  if (!v) return <div style={style}>no campaign matched - paid modules stay empty</div>;
  const hit = (campaigns || []).find((c) => c.name === v);
  if (!hit) return <div style={{ ...style, color: C.amber }}>no spend rows with this exact name yet</div>;
  return <div style={style}>{fmtMoney(hit.spend)} spend · last active {hit.last}</div>;
}

function ScaleHeader() {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ width: 120, flex: "0 0 120px" }} />
      <div style={{ position: "relative", flex: 1, height: 14, fontSize: 11.5, color: C.muted }}>
        <span style={{ position: "absolute", left: 0 }}>N/A</span>
        <span style={{ position: "absolute", left: "33.333%", transform: "translateX(-50%)" }}>Low</span>
        <span style={{ position: "absolute", left: "66.667%", transform: "translateX(-50%)" }}>Medium</span>
        <span style={{ position: "absolute", left: "100%", transform: "translateX(-100%)" }}>High</span>
      </div>
    </div>
  );
}

/* The quartile levers, exactly as they were when they had a card of their own.
 * They are the whole model for a release with no basket, and the `By channel`
 * arm of the stretch switch for one that has (§4), so this markup is lifted
 * across unchanged rather than rebuilt around the benchmark. */
function Levers({ inp, setInp, qual, setQual, derived, channels }) {
  const leverTip = "Every pick selects a quartile of the historical LE panel: Low = 25th percentile, Medium = median, High = 75th.";
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "28px 48px", padding: "6px 10px 0" }} title={leverTip}>
        {[
          { label: "Paid channel size", options: ["Small", "Medium", "Large"], key: "paid_channel_size",
            tip: `${fmtPct(derived.paid_pct, 1)} · ${fmt(derived.paid_units)} units` },
          { label: "Private room share", options: ["Low", "Medium", "High"], key: "reference_point",
            tip: `${fmtPct(derived.pr_other_pct, 1)} · ${fmt(derived.pr_units, 0)} units` },
          { label: "Paid conversion", options: ["Low", "Medium", "High"], key: "paid_conv_quality",
            tip: fmtPct(derived.paid.session_to_entry, 2) + " session → entry" },
          { label: "Cost per purchase", options: ["Low", "Median", "High"], key: "cpp_pick",
            tip: fmtMoney(derived.paid.cost_per_purchase) + " / unit" },
        ].map((lv) => (
          <div key={lv.key}>
            <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "baseline", gap: 10 }}>
              {lv.label}
              {lv.key === "paid_channel_size" && (
                <label style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 500, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}
                  title="The workbook's 'Paid (% Total)' overwrite: set the paid share of units directly instead of taking it from the channel-size quartile. Leave empty to use the slider.">
                  overwrite
                  <input className="control num" style={{ width: 64, padding: "3px 6px", fontSize: 12 }}
                    value={inp.paid_share_override === null || inp.paid_share_override === undefined ? "" : Math.round(inp.paid_share_override * 100)}
                    placeholder="–"
                    onChange={(e) => {
                      const raw = String(e.target.value).replace(/[^0-9]/g, "");
                      setInp({ ...inp, paid_share_override: raw === "" ? null : clamp(parseInt(raw, 10), 0, 100) / 100 });
                    }} />
                  <span>% paid</span>
                </label>
              )}
            </div>
            <div style={{ marginTop: 10, display: "flex", opacity: lv.key === "paid_channel_size" && inp.paid_share_override !== null && inp.paid_share_override !== undefined ? 0.45 : 1 }}>
              <Slider big options={lv.options}
                value={lv.key === "paid_channel_size" ? ({ Low: "Small", High: "Large" }[inp[lv.key]] || inp[lv.key]) : inp[lv.key]}
                onChange={(v) => setInp({ ...inp, [lv.key]: v })} tip={lv.tip} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ height: 28 }} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, borderBottom: `1px solid ${C.hairline}`, paddingBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}
          title="Which quartile of each channel's historical order-split and conversion distributions the targets use. N/A removes the channel (e.g. Referral Artist for an estate).">
          Channel quality
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0 48px", padding: "10px 10px 2px" }}>
        <ScaleHeader /><ScaleHeader />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gridTemplateRows: `repeat(${Math.ceil(channels.length / 2)}, 36px)`, gridAutoFlow: "column",
        gap: "0 48px", padding: "0 10px" }}>
        {channels.map((c) => (
          <div key={c} style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.hairline}` }}>
            <span style={{ width: 120, flex: "0 0 120px", fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c}</span>
            <Slider options={["N/A", "Low", "Medium", "High"]} value={qual[c]}
              onChange={(v) => setQual({ ...qual, [c]: v })}
              tip={`${c} - ${qual[c]}${qual[c] === "N/A" ? " (channel excluded)" : " quartile"}`} />
          </div>
        ))}
      </div>
    </>
  );
}

/* One line of the per-channel table. Benchmark values are the basket's own
 * medians; the target is the benchmark lifted by K and the stretch is the
 * difference, so the three columns always read benchmark + stretch = target
 * (§1). Conversion carries no uplift at all - it is held at the benchmark
 * (§4), which is why the column says so. */
function ChannelRow({ label, bmSessions, bmUnits, conv, k, head, total }) {
  const cell = {
    fontSize: 12.5, padding: "7px 6px", textAlign: "right",
    borderBottom: `1px solid ${C.hairline}`, fontVariantNumeric: "tabular-nums",
    fontWeight: total ? 600 : 400,
  };
  if (head) {
    const h = { ...cell, fontSize: 11.5, color: C.muted, fontWeight: 500, borderBottom: `1px solid ${C.border}` };
    return (
      <tr>
        <th style={{ ...h, textAlign: "left" }}>Channel</th>
        <th style={h}>Benchmark sessions</th>
        <th style={h}>Target sessions</th>
        <th style={h}>Benchmark units</th>
        <th style={h}>Target units</th>
        <th style={h}>Stretch</th>
        <th style={h} title="Conversion rates are held at the benchmark - the uplift is asked of traffic and spend only.">Conv. (held)</th>
      </tr>
    );
  }
  return (
    <tr>
      <td style={{ ...cell, textAlign: "left", whiteSpace: "nowrap" }}>{label}</td>
      <td style={cell}>{fmt(bmSessions)}</td>
      <td style={cell}>{fmt(bmSessions * k)}</td>
      <td style={cell}>{fmt(bmUnits, 1)}</td>
      <td style={cell}>{fmt(bmUnits * k, 1)}</td>
      <td style={{ ...cell, color: C.muted }}>{fmt(bmUnits * (k - 1), 1)}</td>
      <td style={cell}>{conv === null ? "–" : fmtPct(conv, 2)}</td>
    </tr>
  );
}

export default function TargetSetting({ snap, onSaved }) {
  const [meta, setMeta] = useState(null);       // {inputs, channel_quality_default, benchmarks}
  const [inp, setInp] = useState(null);         // editable inputs
  const [qual, setQual] = useState(null);       // full channel->quality map
  const [pick, setPick] = useState(null);       // a basket chosen in the picker, not yet saved
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setMeta(null); setInp(null); setQual(null); setError(null); setPick(null); setPicking(false);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      // a release nobody has set targets for comes back with inputs: null and
      // the defaults the ETL could derive - the form starts from those
      const start = d.inputs || d.defaults;
      setMeta({ ...d, inputs: start, creating: !d.inputs });
      setInp({ ...start });
      setQual({ ...d.channel_quality_default, ...(start.channel_quality_overrides || {}) });
    }).catch((e) => setError(String(e)));
  }, [snap.id]);

  const creating = !!(meta && meta.creating);
  const missing = useMemo(() => {
    if (!inp) return [];
    const req = [["edition_size", "edition size"], ["unit_price", "unit price"], ["artist_profit", "artist profit"],
      ["aa_group_profit", "AA Group profit"], ["private_room_open", "private room date"],
      ["announce_date", "announce date"], ["launch_end", "close date"]];
    return req.filter(([k]) => inp[k] === null || inp[k] === undefined || inp[k] === "").map(([, l]) => l);
  }, [inp]);

  const derived = useMemo(() => {
    if (!meta || !inp || !qual) return null;
    // the model divides by edition size and price - feed it placeholders while
    // the economics are still blank so the rail can render at all
    const safe = { ...inp, edition_size: Number(inp.edition_size) || 1, unit_price: Number(inp.unit_price) || 0,
      artist_profit: Number(inp.artist_profit) || 0, aa_group_profit: Number(inp.aa_group_profit) || 0 };
    return computeTargets(
      { ...safe, channel_quality_default: meta.channel_quality_default, channel_quality_overrides: qual },
      meta.benchmarks
    );
  }, [meta, inp, qual]);

  if (error && !meta) return <div style={{ color: C.muted, padding: 24 }}>Failed to load inputs: {error}</div>;
  if (!derived) return <div style={{ color: C.muted, padding: 24 }}>Loading…</div>;

  const b = meta.benchmarks;
  const set = (k) => (e) => setInp({ ...inp, [k]: e.target.value });
  const setNum = (k) => (e) => {
    const raw = String(e.target.value).replace(/[^0-9]/g, "");
    setInp({ ...inp, [k]: raw === "" ? null : parseInt(raw, 10) });
  };
  const dateDiff = (a, c) => (a && c ? Math.round((new Date(a) - new Date(c)) / 86400000) : null);
  const days = dateDiff(inp.launch_end, inp.announce_date);
  const prDays = dateDiff(inp.announce_date, inp.private_room_open);
  const dv = meta.derived || {};

  /* ---- the benchmark half of the form (§5, §8) ----
   * `bm` is the snapshot's benchmark block: the basket in force on the page as
   * it stands. `pick` is a basket chosen in the picker and not yet saved - its
   * profile is what the chips show, because that is what the person is
   * choosing, while the per-channel table stays on `bm` because per-channel
   * medians are median share x median total (§3.2) and only the ETL computes
   * them. The pending line below the chips says which is which. */
  const bm = snap.benchmark || null;
  const savedSpec = (meta.inputs && meta.inputs.benchmark_basket) || null;
  const spec = inp.benchmark_basket || null;
  const basketDirty = JSON.stringify(spec) !== JSON.stringify(savedSpec);
  const prof = (pick && pick.profile) || null;
  const basketName = pick ? pick.name
    : (bm && bm.basket && bm.basket.name) || (spec && spec.name) || "";
  const editionSize = Number(inp.edition_size) || 0;
  // K follows the sellout box as it is typed, so the table and the stretch
  // never disagree with the number above them; the snapshot's own K is the
  // fallback for a release whose economics are still blank (§4).
  const k = bm ? (bm.units > 0 && editionSize > 0 ? editionSize / bm.units : bm.k) : null;
  const bmUnits = prof ? prof.units : bm ? bm.units : null;
  const stretchUnits = bmUnits !== null && editionSize > 0 ? editionSize - bmUnits : null;
  const stretchPct = bmUnits ? stretchUnits / bmUnits : null;
  // Benchmarking is the default (§4): a release is on the even uplift unless it
  // has opted out, so the switch starts on the arm the snapshot was actually
  // built with - `bm` is present exactly when the ETL ran the basket model.
  // Reading the saved basket instead would start every release on the levers,
  // since a release that took the suggested basket never saved one.
  const stretchMode = inp.stretch_mode || (bm || spec ? "even" : "levers");
  const paidShare = prof
    ? (prof.share_sessions ? prof.share_sessions.paid : prof.paid_share)
    : bm && bm.sessions ? bm.sessionsByGroup.paid / bm.sessions : null;

  const onPick = (chosen) => {
    setPick(chosen);
    setPicking(false);
    setInp({
      ...inp,
      benchmark_basket: chosen.kind === "bespoke"
        ? { kind: "bespoke", members: chosen.members, name: chosen.name }
        : { kind: chosen.kind, id: chosen.id },
      // picking a basket is what puts a release on the benchmark model; without
      // a stretch mode the server would leave it on whatever it had
      stretch_mode: inp.stretch_mode || "even",
    });
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/inputs/${snap.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // benchmark_basket and stretch_mode ride inside `inputs` with everything
        // else (§6); they are only present in `inp` once a basket has been
        // chosen or the switch touched, and a save that leaves them out keeps
        // the release on the JS retarget path rather than a full ETL run.
        body: JSON.stringify({ inputs: {
          ...inp,
          campaign_name: (inp.campaign_name || "").trim() || null,
          channel_quality_overrides: qual,
        } }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `save failed (${res.status})`); return; }
      if (d.warning) setError(d.warning);
      if (d.created) setMeta({ ...meta, creating: false, inputs: { ...inp } });
      else setMeta({ ...meta, inputs: { ...inp } });
      setPick(null);
      onSaved(d.snapshot);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };
  const discard = () => {
    setInp({ ...meta.inputs });
    setQual({ ...meta.channel_quality_default, ...(meta.inputs.channel_quality_overrides || {}) });
    setPick(null);
  };

  const channels = Object.keys(meta.channel_quality_default);

  /* The rail's three columns (§8.3). Wherever the basket has the figure itself,
   * that is what the Benchmark column shows - so the rail and the per-channel
   * table above it quote the same medians rather than two roundings of them.
   *
   * Target ÷ K is only the fallback, and only on the even uplift, for the two
   * rows the basket has no equivalent for: the draw / private-room split is a
   * target-model construct, not a channel. On the levers even that is
   * meaningless - those targets come out of the quartile model, so the quotient
   * is not the basket's median and printing it would invent a figure - and the
   * row shows a dash instead.
   *
   * The percentage row is why the division cannot simply be applied everywhere:
   * the uplift is in both the budget and the launch value, so it cancels, and
   * dividing once more would print a benchmark share 1/K of the real one. */
  const railRow = (label, value, format, tip, basketBm) => {
    const bmv = basketBm !== null && basketBm !== undefined ? basketBm
      : stretchMode === "even" && k && k > 0 ? value / k
      : null;
    let stretch = bmv === null ? null : value - bmv;
    // a stretch that rounds away to nothing in the row's own format is zero, not
    // a negative sliver of one - the percentage row carries K top and bottom, so
    // all that is left there is the rounding in the medians the rail quotes
    if (stretch !== null && format(Math.abs(stretch)) === format(0)) stretch = 0;
    return { label, tip, target: value, bm: bmv, stretch, format };
  };
  // the basket's own medians, in the currencies the rail prints
  const bmPaidUnits = bm ? (bm.unitsByGroup || {}).paid ?? null : null;
  const bmLaunchValue = bm && bm.units > 0 ? bm.units * (Number(inp.unit_price) || 0) : 0;
  /* On the even uplift the rail has to read the basket, not the levers. The
   * lever model is still computed above (it drives the By channel arm and the
   * economics), but its sessions target is backed out of quartile conversions
   * and can sit several times the basket's own median - two cards on this page
   * disagreeing about the same number. The ETL already wrote the basket's
   * targets into the snapshot, so take those and rescale by the edition size as
   * it is typed: every volume carries the same K, so one factor moves them all.
   */
  const benchScale = bm && bm.k > 0 && k ? k / bm.k : 1;
  const st = snap.targets || {};
  const D = stretchMode === "even" && bm && st.total_sessions
    ? {
      buyers: (st.buyers || 0) * benchScale,
      paid_units: (st.paid_units || 0) * benchScale,
      draw_units: (st.draw_units || 0) * benchScale,
      pr_units: (st.pr_units || 0) * benchScale,
      entries_target: (st.entries_target || 0) * benchScale,
      total_sessions: (st.total_sessions || 0) * benchScale,
      paid: {
        budget: ((st.paid || {}).budget || 0) * benchScale,
        budget_pct_of_launch_value: derived.launch_value
          ? ((st.paid || {}).budget || 0) * benchScale / derived.launch_value
          : null,
      },
    }
    : derived;

  /* People, not pieces. On a multi-product release the median buyer takes more
     than one, so a 900-unit target is not 900 people and reading it as though
     it were overstates the audience the campaign has to reach by the whole
     multi-buy rate. The rate is held at the benchmark, so the uplift falls
     entirely on finding more buyers (BENCHMARK_SPEC 4.2). On the levers there
     is no scaled target to read, so the row is the edition at the same rate. */
  const upb = (snap.targets || {}).units_per_buyer || null;
  const buyersTarget = stretchMode === "even" && bm && D.buyers
    ? D.buyers
    : upb ? (Number(inp.edition_size) || 0) / upb : null;
  const railRows = [
    railRow("Paid units", D.paid_units, (v) => fmt(v, 0), undefined, bmPaidUnits),
    railRow("Draw / pre-order units", D.draw_units, (v) => fmt(v, 0), undefined, null),
    railRow("Private room units", D.pr_units, (v) => fmt(v, 0), undefined, null),
    railRow("Buyers", buyersTarget ?? 0, (v) => fmt(v, 0),
      upb ? `People, not pieces: the target divided by ${fmt(upb, 3)} units per buyer.`
          : "People, not pieces.",
      bm && bm.buyers ? bm.buyers : null),
    railRow("Eligible entries", D.entries_target, (v) => fmt(v, 0),
      "Draw + paid units ÷ 0.8 eligible-entry → order rate.",
      bm ? bm.entries : null),
    railRow("Sessions", D.total_sessions, (v) => fmt(v, 0),
      stretchMode === "even"
        ? "The basket's median sessions, lifted by the same K as every other volume."
        : "Backed out per channel: entries ÷ session→entry conversion, plus private-room sessions at the email-only conversion. The benchmark beside it is the basket's own median, which the levers are under no obligation to be a multiple of.",
      bm ? bm.sessions : null),
    railRow("Paid budget", D.paid.budget, (v) => fmtMoney(v, 0), undefined,
      bm ? bm.paidBudget : null),
    railRow("% of launch value", D.paid.budget_pct_of_launch_value ?? 0, (v) => fmtPct(v, 1),
      "Sense check: paid budget should stay under 6% of launch value.",
      bm && bmLaunchValue > 0 ? bm.paidBudget / bmLaunchValue : null),
  ];
  const railCell = { fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 24 }}>

        {creating && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.5 }}>
            <b>No targets yet.</b> The page currently shows actuals only.
            {dv.announce_date
              ? <> Dates below come from the funnel export's campaign clock and can be a day out - check them.</>
              : <> No campaign dates were found in the funnel export - enter them.</>}
            {dv.campaign_code ? <> The campaign code is a guess from the email feed.</> : null}
            {" "}Fill in the economics and save: the page rebuilds with expected-today, projections, paid ROI and sell-through.
          </div>
        )}

        <Card dot="#b8862d" title="Release & timeline">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Release name" tip="Simple Release Name - the join key across every feed; changing it would orphan the actuals, so it is fixed here.">
              <input className="control ro" value={snap.releaseName} readOnly />
            </Field>
            <Field label="Meta campaign" tip="Which Meta ad campaign this release's paid actuals are read from - rows matching this exact name in the live spend feed. Saving a change re-attributes the paid numbers.">
              <input className="control" list="meta-campaigns" value={inp.campaign_name || ""}
                placeholder="- not matched -" onChange={set("campaign_name")} />
              <datalist id="meta-campaigns">
                {(meta.meta_campaigns || []).map((c) => <option key={c.name} value={c.name} />)}
              </datalist>
              <CampaignHint value={inp.campaign_name} campaigns={meta.meta_campaigns} />
            </Field>
            <Field label="Campaign code" tip="The code the email, Instagram and artist-post feeds tag this campaign with (e.g. GlennLigon_LE_26) - it joins those panels to the release.">
              <input className="control" value={inp.campaign_code || ""} onChange={set("campaign_code")} placeholder="Artist_LE_26" />
              {creating && dv.campaign_code && <div style={{ fontSize: 11.5, marginTop: 4, color: C.muted }}>guessed from the email and content feeds - correct it if wrong</div>}
            </Field>
            <Field label="Marketing lead">
              <input className="control" value={inp.marketing_lead || ""} onChange={set("marketing_lead")} />
            </Field>
            <Field label="Budget file">
              <input className="control" value={inp.budget_file || ""} onChange={set("budget_file")} />
            </Field>
          </div>
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Private room opens">
              <input className="control" type="date" value={inp.private_room_open || ""} onChange={set("private_room_open")} />
            </Field>
            <Field label="Announce date">
              <input className="control" type="date" value={inp.announce_date || ""} onChange={set("announce_date")} />
            </Field>
            <Field label="Draw closes">
              <input className="control" type="date" value={inp.launch_end || ""} onChange={set("launch_end")} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <span className="chip" title="Announce → draw close. The campaign clock runs on this window.">Campaign {days === null ? "–" : days} days</span>
            <span className="chip" title="Private room runs from opening to announce - early-access units land here.">Private room {prDays === null ? "–" : prDays} days pre-announce</span>
          </div>
        </Card>

        <Card dot="#8a7a52" title="Economics">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Edition size (units)">
              <input className="control num" style={{ fontWeight: 600 }} value={inp.edition_size ?? ""} onChange={setNum("edition_size")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="Unit price (£)">
              <input className="control num" value={inp.unit_price ?? ""} onChange={setNum("unit_price")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="Launch value" tip="Edition size × unit price - derived.">
              <input className="control ro num" value={fmtMoney(derived.launch_value)} readOnly />
            </Field>
            <Field label="Artist profit (total £)">
              <input className="control num" value={inp.artist_profit ?? ""} onChange={setNum("artist_profit")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="AA Group profit (total £)">
              <input className="control num" value={inp.aa_group_profit ?? ""} onChange={setNum("aa_group_profit")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="Artist profit share" tip="Who pays for paid ads. 0% for commission / rev-share estates - AA then carries 100% of spend.">
              <input className="control num" value={Math.round((inp.artist_profit_share ?? 0) * 100) + "%"}
                onChange={(e) => setInp({ ...inp, artist_profit_share: clamp((parseInt(String(e.target.value).replace(/[^0-9]/g, ""), 10) || 0) / 100, 0, 1) })} />
            </Field>
            <Field label="Framing available">
              <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                {["Yes", "No"].map((o) => {
                  const active = (inp.framing_available !== false) === (o === "Yes");
                  return (
                    <button key={o} onClick={() => setInp({ ...inp, framing_available: o === "Yes" })}
                      style={{ fontFamily: "inherit", fontSize: 12, fontWeight: active ? 600 : 500, padding: "6px 16px",
                        border: "none", cursor: "pointer", background: active ? "#eaf0fa" : "#fff",
                        color: active ? BLUE : C.muted }}>{o}</button>
                  );
                })}
              </div>
            </Field>
            <Field label="Artist profit / unit" tip="Artist total profit ÷ edition size - derived.">
              <input className="control ro num" value={fmtMoney(derived.ppu_artist, 2)} readOnly />
            </Field>
            <Field label="AA profit / unit" tip={`Includes framing: ${b.frame_conversion} conversion × £${b.frame_profit_per_unit} per frame when available - derived.`}>
              <input className="control ro num" value={fmtMoney(derived.ppu_aa, 2)} readOnly />
            </Field>
          </div>
        </Card>

        <Card dot={GROUP_DOTS.funnel} title="Benchmark basket">
          <div className="spacer-16" />
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="Basket" tip="The launches this release is benchmarked against. The benchmark is their median, per metric and per channel.">
                <input className="control ro" value={basketName || "- none chosen -"} readOnly />
              </Field>
            </div>
            <button className="btn secondary" onClick={() => setPicking(true)}
              title="Opens the basket picker: the ready-made baskets with their medians, or a bespoke selection.">
              Change basket
            </button>
          </div>

          {bmUnits === null ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 14, lineHeight: 1.6 }}>
              This release has no benchmark basket, so it runs on the quartile levers under Stretch.
              Choose a basket to benchmark it against comparable past launches instead.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <span className="chip" title="Launches in the basket. Under ten and the median moves a lot on one launch.">
                  {fmt(prof ? prof.n : bm && bm.basket ? bm.basket.n : null)} launches
                </span>
                <span className="chip" title="Median units, with the 25th to 75th percentile of the basket beside it.">
                  units {fmt(bmUnits)} ({fmt(prof ? prof.units_p25 : bm.unitsP25)}-{fmt(prof ? prof.units_p75 : bm.unitsP75)})
                </span>
                <span className="chip">sessions {fmt(prof ? prof.sessions : bm.sessions)}</span>
                <span className="chip" title="Median share of sessions from paid.">paid {fmtPct(paidShare, 0)}</span>
                <span className="chip">{fmt(prof ? prof.campaign_days : bm.campaignDays)} campaign days</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
                {basketDirty
                  ? <>Not saved yet. The per-channel figures below are still the basket in force - save to rebuild them.</>
                  : bm && bm.basket
                    ? <>Matched from {fmt(bm.basket.n)} comparable launches
                      {bm.basket.id === bm.basket.suggestedId ? ", the suggested basket for this release" : ", chosen by hand"}
                      {bm.basket.thin ? ". Thin: under ten launches, so the median moves easily." : "."}</>
                    : null}
              </div>
            </>
          )}

          {bm && (
            <>
              <div style={{ height: 18 }} />
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><ChannelRow head /></thead>
                <tbody>
                  {GROUPS.map((g) => (
                    <ChannelRow key={g.key} label={g.name}
                      bmSessions={bm.sessionsByGroup[g.key] || 0}
                      bmUnits={bm.unitsByGroup[g.key] || 0}
                      conv={(bm.convByGroup || {})[g.key] ?? null} k={k} />
                  ))}
                  <ChannelRow total label="Total"
                    bmSessions={GROUPS.reduce((s, g) => s + (bm.sessionsByGroup[g.key] || 0), 0)}
                    bmUnits={GROUPS.reduce((s, g) => s + (bm.unitsByGroup[g.key] || 0), 0)}
                    conv={null} k={k} />
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card dot="#4f6fc0" title="Stretch">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Benchmark (units)" tip="The basket's median units at close - what launches like this one typically reach.">
              <input className="control ro num" value={bmUnits === null ? "–" : fmt(bmUnits)} readOnly />
            </Field>
            <Field label="Sellout (units)" tip="The edition size, mirrored from Economics - the business target.">
              <input className="control num" style={{ fontWeight: 600 }} value={inp.edition_size ?? ""}
                onChange={setNum("edition_size")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="Stretch" tip="Sellout − benchmark: how much more than a typical launch this one is being asked for.">
              <input className="control ro num"
                value={stretchUnits === null ? "–" : `+${fmt(stretchUnits)} units · +${fmtPct(stretchPct, 0)}`} readOnly />
            </Field>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
            <div className="seg" role="group" aria-label="How the stretch is spread">
              <button className={stretchMode === "even" ? "active" : ""} disabled={!bm && !spec}
                title="One uplift on the basket median, on every channel, stage and day."
                onClick={() => setInp({ ...inp, stretch_mode: "even" })}>Evenly</button>
              <button className={stretchMode === "levers" ? "active" : ""}
                onClick={() => setInp({ ...inp, stretch_mode: "levers" })}>By channel</button>
            </div>
            <span style={{ fontSize: 12, color: C.muted }}>
              {stretchMode === "even"
                ? "One uplift, every channel, every day."
                : "Quartile levers set each channel's share."}
            </span>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 10, lineHeight: 1.6 }}>
            {stretchMode === "even"
              ? <>Evenly lifts every volume - sessions, entries, units and spend - by the same factor in every channel,
                on every day of the campaign, and holds conversion rates at the benchmark. A target that quietly assumes
                the site converts better than it ever has is a target nobody can act on, so the stretch is asked of
                traffic and spend only.</>
              : <>By channel hands the split back to the quartile levers below: each one picks a quartile of the
                historical LE panel, and the channel shares and conversions follow from those picks rather than from the
                basket. Use it when this release is deliberately shaped unlike the launches it is benchmarked against.</>}
          </div>

          {stretchMode === "levers" && (
            <>
              <div style={{ height: 22 }} />
              <Levers inp={inp} setInp={setInp} qual={qual} setQual={setQual} derived={derived} channels={channels} />
            </>
          )}
        </Card>
      </div>

      <div style={{ width: 384, flex: "0 0 384px", position: "sticky", top: 28 }}>
        <Card dot="#8a7a52" title="Derived targets">
          <div className="spacer-8" />
          <div className="lead" title="Secured-units sellout target - the hero target on the Overview tab.">
            {creating && missing.length ? "–" : fmt(derived.edition_size)}
          </div>
          <div className="lead-caption">{creating && missing.length ? "sellout units - enter the economics" : "sellout units"}</div>
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px 72px", gap: 4, alignItems: "center" }}>
            <span />
            <span style={{ ...railCell, fontSize: 11.5, color: C.refBm, fontWeight: 600 }} title="The basket's median - what launches like this one typically reach.">Benchmark</span>
            <span style={{ ...railCell, fontSize: 11.5, fontWeight: 600 }}>Target</span>
            <span style={{ ...railCell, fontSize: 11.5, color: C.muted, fontWeight: 600 }} title="Target − benchmark: the uplift being asked for.">Stretch</span>
            {railRows.map((r) => (
              <React.Fragment key={r.label}>
                <span style={{ fontSize: 12.5, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }} title={r.tip}>{r.label}</span>
                <span style={{ ...railCell, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }}>{r.bm === null ? "–" : r.format(r.bm)}</span>
                <span style={{ ...railCell, fontWeight: 600, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8,
                  color: r.label === "% of launch value" ? (derived.paid.sense_check_breached ? C.red : C.green) : C.ink }}>{r.format(r.target)}</span>
                <span style={{ ...railCell, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }}>{r.stretch === null ? "–" : r.format(r.stretch)}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={saving || (creating && missing.length > 0)} onClick={save}
              title={creating
                ? (missing.length ? `Still needed: ${missing.join(", ")}` : "Saves the inputs and rebuilds this release with the full target model.")
                : "Saves the inputs and recomputes this release's targets, plan curves and projections."}>
              {saving ? (creating ? "Building…" : "Saving…") : savedFlash ? "✓ Saved" : creating ? "Set targets" : "Save targets"}
            </button>
            <button className="btn secondary" onClick={discard}>Discard</button>
          </div>
          {basketDirty && !error && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
              A new basket rebuilds this release from the panel, so saving takes longer than usual.
            </div>
          )}
          {creating && missing.length > 0 && !error && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Still needed: {missing.join(", ")}</div>
          )}
          {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{error}</div>}
        </Card>
      </div>

      {picking && (
        <BasketPicker releaseId={snap.id} releaseName={snap.releaseName} current={spec}
          onPick={onPick} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
