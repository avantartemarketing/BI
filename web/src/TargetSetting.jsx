/* Target setting tab - the settled design (see the Release Target Setting canvas):
 * inputs left (Release & timeline, Economics with derived per-unit fields, Model
 * levers as notched sliders + 6×2 channel-quality slider grid), derived targets
 * rail right, recomputing live via the shared target model. Save persists inputs
 * and the server retargets the release snapshot in place. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import { computeTargets } from "../../shared/targetModel.mjs";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const BLUE = "#28518f", BLUE_FILL = "#c3d5ee";

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

export default function TargetSetting({ snap, onSaved }) {
  const [meta, setMeta] = useState(null);       // {inputs, channel_quality_default, benchmarks}
  const [inp, setInp] = useState(null);         // editable inputs
  const [qual, setQual] = useState(null);       // full channel->quality map
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setMeta(null); setInp(null); setQual(null); setError(null);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      setMeta(d);
      setInp({ ...d.inputs });
      setQual({ ...d.channel_quality_default, ...(d.inputs.channel_quality_overrides || {}) });
    }).catch((e) => setError(String(e)));
  }, [snap.id]);

  const derived = useMemo(() => {
    if (!meta || !inp || !qual) return null;
    return computeTargets(
      { ...inp, channel_quality_default: meta.channel_quality_default, channel_quality_overrides: qual },
      meta.benchmarks
    );
  }, [meta, inp, qual]);

  if (error) return <div style={{ color: C.muted, padding: 24 }}>Failed to load inputs: {error}</div>;
  if (!derived) return <div style={{ color: C.muted, padding: 24 }}>Loading…</div>;

  const b = meta.benchmarks;
  const set = (k) => (e) => setInp({ ...inp, [k]: e.target.value });
  const setNum = (k) => (e) => setInp({ ...inp, [k]: parseInt(String(e.target.value).replace(/[^0-9]/g, ""), 10) || 0 });
  const days = Math.round((new Date(inp.launch_end) - new Date(inp.announce_date)) / 86400000);
  const prDays = Math.round((new Date(inp.announce_date) - new Date(inp.private_room_open)) / 86400000);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/inputs/${snap.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: {
          ...inp,
          campaign_name: (inp.campaign_name || "").trim() || null,
          channel_quality_overrides: qual,
        } }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `save failed (${res.status})`); return; }
      if (d.warning) setError(d.warning);
      onSaved(d.snapshot);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };
  const discard = () => {
    setInp({ ...meta.inputs });
    setQual({ ...meta.channel_quality_default, ...(meta.inputs.channel_quality_overrides || {}) });
  };

  const channels = Object.keys(meta.channel_quality_default);
  const leverTip = "Every pick selects a quartile of the historical LE panel: Low = 25th percentile, Medium = median, High = 75th.";

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 24 }}>

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
              <input className="control" type="date" value={inp.private_room_open} onChange={set("private_room_open")} />
            </Field>
            <Field label="Announce date">
              <input className="control" type="date" value={inp.announce_date} onChange={set("announce_date")} />
            </Field>
            <Field label="Draw closes">
              <input className="control" type="date" value={inp.launch_end} onChange={set("launch_end")} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <span className="chip" title="Announce → draw close. The campaign clock runs on this window.">Campaign {days} days</span>
            <span className="chip" title="Private room runs from opening to announce - early-access units land here.">Private room {prDays} days pre-announce</span>
          </div>
        </Card>

        <Card dot="#8a7a52" title="Economics">
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
            <Field label="Edition size (units)">
              <input className="control num" style={{ fontWeight: 600 }} value={inp.edition_size} onChange={setNum("edition_size")} />
            </Field>
            <Field label="Unit price (£)">
              <input className="control num" value={inp.unit_price} onChange={setNum("unit_price")} />
            </Field>
            <Field label="Launch value" tip="Edition size × unit price - derived.">
              <input className="control ro num" value={fmtMoney(derived.launch_value)} readOnly />
            </Field>
            <Field label="Artist profit (total £)">
              <input className="control num" value={inp.artist_profit} onChange={setNum("artist_profit")} />
            </Field>
            <Field label="AA Group profit (total £)">
              <input className="control num" value={inp.aa_group_profit} onChange={setNum("aa_group_profit")} />
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

        <Card dot="#4f6fc0" title="Model levers" right={null}>
          <div className="spacer-16" />
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
                <div style={{ fontSize: 13, fontWeight: 600 }}>{lv.label}</div>
                <div style={{ marginTop: 10, display: "flex" }}>
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
        </Card>
      </div>

      <div style={{ width: 384, flex: "0 0 384px", position: "sticky", top: 28 }}>
        <Card dot="#8a7a52" title="Derived targets">
          <div className="spacer-8" />
          <div className="lead" title="Secured-units sellout target - the hero target on the Overview tab.">{fmt(derived.edition_size)}</div>
          <div className="lead-caption">sellout units</div>
          <div className="spacer-16" />
          <div className="legend-rows" style={{ marginTop: 0 }}>
            <div className="legend-row"><span style={{ color: C.muted }}>Paid units</span><span className="val">{fmt(derived.paid_units)}</span></div>
            <div className="legend-row"><span style={{ color: C.muted }}>Draw / pre-order units</span><span className="val">{fmt(derived.draw_units, 0)}</span></div>
            <div className="legend-row"><span style={{ color: C.muted }}>Private room units</span><span className="val">{fmt(derived.pr_units, 0)}</span></div>
            <div className="legend-row"><span style={{ color: C.muted }} title="Draw + paid units ÷ 0.8 eligible-entry → order rate.">Eligible entries target</span><span className="val">{fmt(derived.entries_target, 0)}</span></div>
            <div className="legend-row"><span style={{ color: C.muted }} title="Backed out per channel: entries ÷ session→entry conversion, plus private-room sessions at the email-only conversion.">Sessions target</span><span className="val">{fmt(derived.total_sessions, 0)}</span></div>
            <div className="legend-row"><span style={{ color: C.muted }}>Paid budget</span><span className="val">{fmtMoney(derived.paid.budget, 0)}</span></div>
            <div className="legend-row">
              <span style={{ color: C.muted }} title="Sense check: paid budget should stay under 6% of launch value.">% of launch value</span>
              <span className="val" style={{ color: derived.paid.sense_check_breached ? C.red : C.green }}>
                {fmtPct(derived.paid.budget_pct_of_launch_value ?? 0, 1)}
              </span>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={saving} onClick={save}
              title="Saves the inputs and recomputes this release's targets, plan curves and projections.">
              {saving ? "Saving…" : savedFlash ? "✓ Saved" : "Save targets"}
            </button>
            <button className="btn secondary" onClick={discard}>Discard</button>
          </div>
          {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{error}</div>}
        </Card>
      </div>
    </div>
  );
}
