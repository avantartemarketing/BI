/* Target setting for a timed launch (docs/TL_SPEC.md §7): the LE tab's form
 * language in TL words. The header holds the signup target and what follows
 * from it, recomputed live from shared/tlModel.mjs as the boxes are typed;
 * the cards are the release and its dates (the announce, the open and the
 * window length, each with the other readings beside it and one click to
 * take one), the target (Airtable's units target summed over the ticked
 * works, the pieces per order and the signup -> order rate, the paid prices),
 * the channels in plan with the stretch sliders and the basket, and the
 * products grid with the tick. Save posts the inputs and follows the rebuild
 * as the LE tab does. */
import React, { useEffect, useMemo, useState } from "react";
import { C, MINUS, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import { Field, RoBox, TextBox, NumBox, Switch, Notice, CardHead, Campaigns } from "./TargetSetting.jsx";
import { GROUPS as GROUP_KEYS, applyChannelsOff, channelsOffOf, fullProfile, rebalanceShares, stretchWeights, tlTargets } from "../../shared/tlModel.mjs";

const GROUPS = [
  { key: "aa_email", name: "AA Email" },
  { key: "aa_social", name: "AA Meta" },
  { key: "referral_artist", name: "Referral artist" },
  { key: "search_direct_other", name: "Search / direct / other" },
  { key: "paid", name: "Paid" },
];
const LENGTHS = [["24", "24 hours"], ["48", "48 hours"], ["72", "72 hours"], ["168", "7 days"]];
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
  const local = new Date(t + offsetMinutes(t) * 60000);
  return local.toISOString().slice(0, 16);
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

export default function TLTargets({ snap, onSaved }) {
  const [meta, setMeta] = useState(null);
  const [inp, setInp] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [buildSecs, setBuildSecs] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    setMeta(null); setInp(null); setError(null);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (!live) return;
      if (d.error) { setError(d.error); return; }
      const base = d.inputs || d.defaults || {};
      const start = { type: "TL", channels_off: [], stretch_from: null, products: [], campaign_names: [], ...base };
      setMeta({ ...d, creating: !d.inputs, inputs: start });
      setInp(start);
    }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [snap.id]);

  const sourced = (meta && meta.sourced) || { airtable: {}, feed: {} };
  const b = (meta && meta.benchmarks) || {};
  const set = (k) => (e) => setInp({ ...inp, [k]: e.target.value });
  const setNum = (k) => (raw) => {
    const clean = String(raw).replace(/[^0-9.]/g, "");
    setInp({ ...inp, [k]: clean === "" ? null : Number(clean) });
  };
  const setPct = (k) => (raw) => {
    const clean = String(raw).replace(/[^0-9.]/g, "");
    setInp({ ...inp, [k]: clean === "" ? null : Math.min(Math.max(Number(clean), 0), 100) / 100 });
  };

  /* ---- the products: Airtable's with the typed figures over them, the tick ---- */
  const atProducts = useMemo(() => ((sourced.airtable || {}).products || []), [sourced]);
  const typedFor = (p) => ((inp && inp.products) || []).find((t) => t.airtable_id && String(t.airtable_id) === String(p.airtable_id)) || {};
  const products = useMemo(() => atProducts.map((p) => {
    const t = typedFor(p);
    const pick = (k, at) => (t[k] !== undefined && t[k] !== null ? Number(t[k]) : at === null || at === undefined ? null : Number(at));
    return { ...p, excluded: !!t.excluded, edition_eff: pick("edition", p.edition), units_target_eff: pick("units_target", p.units_target),
             unit_price_eff: pick("unit_price", p.unit_price), typed: t };
  }), [atProducts, inp]);
  const live = products.filter((p) => !p.excluded);
  const airtableUnits = live.reduce((s, p) => s + (p.units_target_eff || 0), 0) || null;
  const editionSize = live.reduce((s, p) => s + (p.edition_eff || 0), 0) || null;
  const priced = live.filter((p) => p.unit_price_eff > 0);
  const price = priced.length ? priced.reduce((s, p) => s + (p.units_target_eff || p.edition_eff || 1) * p.unit_price_eff, 0) / priced.reduce((s, p) => s + (p.units_target_eff || p.edition_eff || 1), 0) : 0;
  const unitsTarget = inp && Number(inp.units_target) > 0 ? Number(inp.units_target) : airtableUnits;
  const launchValue = unitsTarget && price ? unitsTarget * price : 0;
  const setProduct = (p, patch) => setInp((prev) => {
    const list = [...(prev.products || [])];
    let i = list.findIndex((t) => t.airtable_id && String(t.airtable_id) === String(p.airtable_id));
    if (i < 0) { list.push({ airtable_id: String(p.airtable_id) }); i = list.length - 1; }
    const next = { ...list[i], ...patch };
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
    const bare = Object.keys(next).every((k) => k === "airtable_id");
    if (bare) list.splice(i, 1); else list[i] = next;
    return { ...prev, products: list };
  });

  /* ---- the basket and the channels ---- */
  const off = inp ? channelsOffOf(inp) : [];
  const isOff = (g) => off.includes(g);
  const baskets = snap.baskets || [];
  const chosenId = (inp && inp.benchmark_basket && inp.benchmark_basket.id) || (snap.benchmark && snap.benchmark.basket && snap.benchmark.basket.id) || (snap.benchmark && snap.benchmark.suggested) || null;
  const chosen = baskets.find((x) => x.id === chosenId) || null;
  const baseProfile = chosen && chosen.profile ? chosen.profile : (snap.benchmark && snap.benchmark.profile ? fullProfile(snap.benchmark.profile) : null);
  const profile = baseProfile ? applyChannelsOff(baseProfile, off) : null;
  const T = profile ? tlTargets(inp, airtableUnits, profile, launchValue, b) : null;
  const BM = T ? T.benchmark : null;
  const activeGroups = profile ? GROUP_KEYS.filter((g) => !isOff(g) && Number((profile.signups_by_group || {})[g]) > 0) : [];
  const evenShares = profile ? stretchWeights({ stretch_from: null }, profile.signups_by_group) : {};
  const shares = T && T.stretch_from ? T.stretch_from : evenShares;
  const slideStretch = (key) => (e) => setInp({ ...inp, stretch_from: rebalanceShares(shares, key, Number(e.target.value) / 100, activeGroups) });

  if (error && !meta) return <div style={{ color: C.muted, padding: 24 }}>Failed to load inputs: {error}</div>;
  if (!meta || !inp) return <div style={{ color: C.muted, padding: 24 }}>Loading…</div>;

  const creating = meta.creating;
  const dirty = JSON.stringify(inp) !== JSON.stringify(meta.inputs);
  const dv = meta.derived || {};
  const at = sourced.airtable || {}, feed = sourced.feed || {};

  /* ---- the dates in force and the other readings (docs/TL_SPEC.md §2) ---- */
  const announce = inp.announce_date || dv.announce_date || at.announce_date || feed.announce_date || "";
  const announceSrc = inp.announce_date ? "typed" : at.announce_date && at.announce_date === announce ? "airtable" : feed.announce_date && feed.announce_date === announce ? "feed" : dv.announce_date ? "derived" : "";
  const open = inp.window_open || dv.window_open || at.window_open || feed.window_open_adjusted || feed.window_open || "";
  const openSrc = inp.window_open ? "typed" : at.window_open && at.window_open === open ? "airtable" : (feed.window_open_adjusted || feed.window_open) === open ? "feed" : dv.window_open ? "derived" : "";
  const hoursInForce = Number(inp.window_hours) > 0 ? Number(inp.window_hours) : Number(dv.window_hours) > 0 ? Number(dv.window_hours) : Number(at.window_hours) > 0 ? Number(at.window_hours) : 48;
  const hoursSrc = Number(inp.window_hours) > 0 ? "typed" : Number(at.window_hours) > 0 && Number(at.window_hours) === hoursInForce ? "airtable" : "derived";
  const closeIso = open && hoursInForce ? new Date(Date.parse(open) + hoursInForce * 3600000).toISOString() : null;
  const SRC = { typed: "typed", airtable: "from Airtable", feed: "from the feed's launch time", derived: "as the build read it", "": "not known yet" };
  const useIt = (f, v) => <button type="button" className="ts-link" onClick={() => setInp({ ...inp, [f]: v })} title={`Type ${/T/.test(String(v)) ? fmtWhen(v) : fmtDate(v)} here`}>use it</button>;
  const otherDates = (value, readings) => readings.filter(([, v]) => v && v !== value);

  const missing = [];
  if (!(unitsTarget > 0)) missing.push("a units target (Airtable's, or typed)");
  if (!announce) missing.push("the announce date");
  if (!open) missing.push("the window open");

  const save = async () => {
    setSaving(true); setError(null); setBuildSecs(null);
    try {
      const { campaign_name, ...rest } = inp;
      const body = { ...rest, type: "TL", channels_off: off, announce_date: announce || null, window_open: open || null, window_hours: hoursInForce,
                     launch_end: closeIso ? closeIso.slice(0, 10) : rest.launch_end };
      const res = await fetch(`/api/inputs/${snap.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: body }) });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `save failed (${res.status})`); return; }
      setMeta({ ...meta, creating: false, inputs: { ...inp }, storage: d.storage || meta.storage });
      let snapshot = d.snapshot || null;
      if (d.queued) snapshot = await followBuild(Date.now());
      if (snapshot) onSaved(snapshot);
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) { setError(String(e)); } finally { setSaving(false); setBuildSecs(null); }
  };
  async function followBuild(startedAt) {
    let snapshot = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      setBuildSecs(Math.round((Date.now() - startedAt) / 1000));
      let st = null;
      try { st = await (await fetch(`/api/inputs/${snap.id}/build`)).json(); } catch { st = null; }
      if (st && st.status === "running") continue;
      if (st && st.status === "failed") { setError("Inputs saved, but the rebuild failed (" + (st.error || "no detail") + ") - the page will update on the next data refresh."); break; }
      try { const r = await fetch(`/api/releases/${snap.id}`); if (r.ok) snapshot = await r.json(); } catch { /* the page stays as it was */ }
      break;
    }
    return snapshot;
  }
  const discard = () => setInp({ ...meta.inputs });

  /* ---- the header's figures ---- */
  const signed = (v) => (v < 0 ? MINUS : "+") + fmt(Math.abs(v), 0);
  const figure = (label, target, bmv, format, tip, opts = {}) => {
    let stretch = target === null || bmv === null || target === undefined || bmv === undefined ? null : target - bmv;
    if (stretch !== null && format(Math.abs(stretch)) === format(0)) stretch = 0;
    const subs = opts.paid && isOff("paid") ? ["not in plan"]
      : opts.sense ? [`benchmark ${bmv === null || bmv === undefined ? "–" : format(bmv)}`, `${opts.sense.breached ? "over" : "under"} the 6% sense check`]
        : [`benchmark ${bmv === null || bmv === undefined ? "–" : format(bmv)}`, `stretch ${stretch === null ? "–" : (stretch < 0 ? MINUS : "+") + format(Math.abs(stretch))}`];
    return { label, tip, value: opts.paid && isOff("paid") ? "–" : target === null || target === undefined ? "–" : format(target), subs, red: !!(opts.sense && opts.sense.breached) };
  };
  const figures = T ? [
    figure("Orders needed", T.orders_needed, BM.units > 0 && T.purchases_per_order ? BM.units / T.purchases_per_order : null, (v) => fmt(v, 0), `The units target over ${fmt(T.purchases_per_order, 2)} pieces an order.`),
    figure("Paid signups", T.paid_signups, BM.paid_signups, (v) => fmt(v, 0), "The basket's median paid signups plus paid's share of the stretch.", { paid: true }),
    figure("Sessions", T.sessions_needed, BM.sessions, (v) => fmt(v, 0), "Each channel's signup target over its benchmark session -> signup rate."),
    figure("Pre-window budget", T.budget_pre, BM.budget_pre, (v) => fmtMoney(v, 0), `Paid signups × ${T.cost_per_signup ? fmtMoney(T.cost_per_signup, 2) : "–"} a signup (${T.cost_per_signup_source === "release" ? "typed" : "the basket's median"}).`, { paid: true }),
    figure("Window budget", T.budget_window, null, (v) => fmtMoney(v, 0), `Paid's share of the units target × ${T.cost_per_sale ? fmtMoney(T.cost_per_sale, 0) : "–"} a sale (${T.cost_per_sale_source === "release" ? "typed" : "the basket's median"}).`, { paid: true }),
    figure("Of launch value", T.budget_pct_of_launch_value ?? 0, null, (v) => fmtPct(v, 1), "Sense check: the two budgets together should stay under 6% of launch value.", { paid: true, sense: { breached: !!T.sense_check_breached } }),
  ] : [];
  const saveLabel = saving ? (buildSecs !== null ? `Rebuilding the page… ${buildSecs}s` : "Saving…") : savedFlash ? "✓ Saved" : creating ? "Set targets" : "Save targets";
  const stateText = saving ? null : missing.length ? `Needs ${missing.join(", ")}` : dirty ? "Unsaved changes" : creating ? "Not set up yet - the page runs on Airtable's target and the suggested basket" : null;
  const leadCap = !T ? "signup target: a units target and a basket are needed"
    : `signups by the open · ${fmt(T.units_target)} units ÷ ${fmt(T.purchases_per_order, 2)} an order ÷ ${fmtPct(T.signup_order_rate, 1)} · ${T.k ? `×${fmt(T.k, 2)} the basket's median` : "no benchmark"}`;
  const s2oWords = { release: "typed", basket_mix: "the basket's rates by channel, at its mix", basket: "the basket's median", none: "no rate on file" };
  const rateHelp = T ? `${s2oWords[T.signup_order_rate_source]}${T.signup_order_rate_source === "basket_mix" ? `: ${GROUPS.filter((g) => T.signup_order_rate_by_group[g.key] > 0).map((g) => `${g.name} ${fmtPct(T.signup_order_rate_by_group[g.key], 1)}`).join(", ")}` : ""}.` : "Choose a basket first.";
  const stretchHelp = !T ? "Choose a basket first."
    : T.stretch_typed
      ? `The stretch of ${signed(Math.round((T.signup_target || 0) - BM.signups))} signups is asked of ${GROUPS.filter((g) => T.stretch_from[g.key] > 0).sort((x, y) => T.stretch_from[y.key] - T.stretch_from[x.key]).map((g) => `${g.name} ${Math.round(100 * T.stretch_from[g.key])}%`).join(", ")}; the other channels stay at their benchmark.`
      : `Blank: each channel takes its share of the ${signed(Math.round((T.signup_target || 0) - BM.signups))}-signup stretch in proportion to its benchmark, the same uplift everywhere. Drag a slider to place it; the others follow, so the shares add to 100%.`;

  return (
    <>
      <div className="ts-head">
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
          )) : <div className="ts-caption" style={{ padding: "8px 0 2px" }}>No completed timed launch to benchmark against yet, or no units target.</div>}
        </div>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="ts" style={{ marginTop: 24 }}>
        {creating && (
          <Notice>
            <b>Timed launch.</b> The page already runs on Airtable's units target, the suggested basket and the dates below{dv.dates_note ? ` (${dv.dates_note})` : ""}.
            Check the dates and the Meta campaign, set the channels in plan and the basket, type over a rate where you know better, and save: the targets are then yours rather than the defaults.
          </Notice>
        )}
        {meta.storage && meta.storage.durable === false && (
          <Notice red><span title={`Saves are written to ${meta.storage.path}`}><b>Targets saved here do not survive a deploy.</b> Point SAVED_INPUTS_PATH at a persistent disk (README) and they stay.</span></Notice>
        )}

        <section className="ts-card" aria-label="Release and timeline">
          <CardHead dot="#b8862d" title="Release & timeline" desc="worked back from Airtable's launch date and window length" />
          <div className="ts-grid c2">
            <Field label="Release name" src="the join key across every feed"><RoBox value={snap.releaseName} /></Field>
            <Field label="Campaign code" src={inp.campaign_code ? "typed" : dv.campaign_code ? "guessed from the codes moving on Meta and in the sends" : "not found in any feed"}
              tip="The code the Meta campaigns and the sends carry (BisaButler_TL_26): it joins the spend and the emails to the launch.">
              <TextBox value={inp.campaign_code || ""} onChange={set("campaign_code")} placeholder={dv.campaign_code || "Artist_TL_26"} />
            </Field>
            <Field label="Marketing lead" src="typed"><TextBox value={inp.marketing_lead || ""} onChange={set("marketing_lead")} placeholder="Who runs this launch" /></Field>
            <Field label="Meta campaigns" src="paid actuals are read from these"
              tip="The Sign-ups campaign buys the pre-window's signups and the Purchases campaign the window's sales; both named for the code are suggested.">
              <Campaigns code={inp.campaign_code || dv.campaign_code || ""} chosen={inp.campaign_names || []} all={meta.meta_campaigns} suggested={sourced.campaigns}
                onChange={(names) => setInp({ ...inp, campaign_names: names })} />
            </Field>
            <Field label="Announced" src={SRC[announceSrc]}
              help={<>{otherDates(announce, [["Airtable", at.announce_date], ["the feed", feed.announce_date]]).map(([n, v]) => <span key={n}>{n} has {fmtDate(v)} {useIt("announce_date", v)} · </span>)}the pre-window starts here; signups before it count in the headline</>}>
              <div className="ts-box"><input type="date" value={(announce || "").slice(0, 10)} onChange={set("announce_date")} /></div>
            </Field>
            <Field label="Window opens" src={`${SRC[openSrc]}, Amsterdam time`}
              help={<>{otherDates(open, [["Airtable", at.window_open], ["the feed", feed.window_open_adjusted || feed.window_open]]).map(([n, v]) => <span key={n}>{n} has {fmtWhen(v)} {useIt("window_open", v)} · </span>)}
                {feed.window_open && feed.window_open_adjusted ? "the feed's timestamp runs an hour late in summer time; the adjusted reading is shown" : "the public open; the early access starts about a day before"}</>}>
              <div className="ts-box"><input type="datetime-local" value={toLocalInput(open)} onChange={(e) => setInp({ ...inp, window_open: fromLocalInput(e.target.value) })} /></div>
            </Field>
            <Field label="Window length" src={SRC[hoursSrc]}
              help={<>closes {closeIso ? fmtWhen(closeIso) : "–"}{at.window_hours && Number(at.window_hours) !== hoursInForce ? <span> · Airtable has {at.window_hours} hours {useIt("window_hours", Number(at.window_hours))}</span> : null}</>}>
              <div className="ts-row">
                <div className="ts-box" style={{ flex: 1 }}>
                  <select value={LENGTHS.some(([h]) => Number(h) === hoursInForce) ? String(hoursInForce) : "custom"} onChange={(e) => setInp({ ...inp, window_hours: e.target.value === "custom" ? hoursInForce : Number(e.target.value) })}>
                    {LENGTHS.map(([h, w]) => <option key={h} value={h}>{w}</option>)}
                    <option value="custom">custom</option>
                  </select>
                </div>
                <NumBox value={hoursInForce} unit="h" onCommit={setNum("window_hours")} title="The window in hours" />
              </div>
            </Field>
          </div>
        </section>

        <section className="ts-card" aria-label="Target">
          <CardHead dot="#4f80d6" title="Target" desc="the units target and the rates that turn it into signups" />
          <div className="ts-grid c3">
            <Field label="Units target" src={Number(inp.units_target) > 0 ? "typed" : airtableUnits ? `Airtable, summed over ${live.length} ticked work${live.length === 1 ? "" : "s"}` : "none in Airtable"}
              help={editionSize ? `Edition ${fmt(editionSize)} across the ticked works; it caps nothing unless typed as the target.` : "Type one when Airtable has none."}>
              <NumBox value={inp.units_target ?? ""} placeholder={airtableUnits ? fmt(airtableUnits) : ""} unit="units" onCommit={setNum("units_target")} />
            </Field>
            <Field label="Pieces per order" src={Number(inp.purchases_per_order) > 0 ? "typed" : "the basket's median"} help="How many pieces a buyer takes in one order.">
              <NumBox value={inp.purchases_per_order ?? ""} placeholder={profile && profile.purchases_per_order ? fmt(profile.purchases_per_order, 2) : "1.00"} onCommit={setNum("purchases_per_order")} />
            </Field>
            <Field label="Signup → order rate" src={Number(inp.signup_order_rate) > 0 ? "typed" : "the basket"} help={rateHelp}>
              <NumBox value={inp.signup_order_rate !== null && inp.signup_order_rate !== undefined ? String(Math.round(inp.signup_order_rate * 1000) / 10) : ""} placeholder={T ? String(Math.round(T.signup_order_rate * 1000) / 10) : ""} unit="%" onCommit={setPct("signup_order_rate")} />
            </Field>
            <Field label="Cost per signup" src={Number(inp.cost_per_signup) > 0 ? "typed" : profile && profile.cost_per_signup ? "the basket's median" : "none on file"} help="Pre-window spend over the paid signups it bought; prices the pre-window budget.">
              <NumBox value={inp.cost_per_signup ?? ""} placeholder={profile && profile.cost_per_signup ? fmt(profile.cost_per_signup, 2) : ""} unit="€" onCommit={setNum("cost_per_signup")} />
            </Field>
            <Field label="Cost per sale" src={Number(inp.cost_per_purchase) > 0 ? "typed" : profile && profile.cost_per_sale ? "the basket's median" : "none on file"} help="Window spend over the paid units it drove; prices the window budget.">
              <NumBox value={inp.cost_per_purchase ?? ""} placeholder={profile && profile.cost_per_sale ? fmt(profile.cost_per_sale, 0) : ""} unit="€" onCommit={setNum("cost_per_purchase")} />
            </Field>
            <Field label="Cannibalisation" src={inp.cannibalisation !== null && inp.cannibalisation !== undefined ? "typed" : "the TL panel's 10%"} help="The share of paid signups that would have come anyway.">
              <NumBox value={inp.cannibalisation !== null && inp.cannibalisation !== undefined ? String(Math.round(inp.cannibalisation * 100)) : ""} placeholder="10" unit="%" onCommit={setPct("cannibalisation")} />
            </Field>
          </div>
        </section>

        <section className="ts-card" aria-label="Channels and basket">
          <CardHead dot="#8a7a52" title="Channels & basket" desc="the launches this one is measured against, and the channels in plan" />
          <div className="ts-grid c2">
            <Field label="Benchmark basket" src={chosen ? `${chosen.n} launch${chosen.n === 1 ? "" : "es"}${chosen.thin ? ", thin" : ""}${chosen.fallback ? ", every window length" : ""}` : "none"}
              help={chosen ? chosen.desc : "Every completed timed launch is a candidate; the baskets are cut by window length, size and recency."}>
              <div className="ts-box">
                <select value={chosenId || ""} onChange={(e) => setInp({ ...inp, benchmark_basket: { kind: "ready", id: e.target.value } })}>
                  {baskets.map((x) => <option key={x.id} value={x.id} disabled={!x.n}>{x.name} ({x.n}){snap.benchmark && snap.benchmark.suggested === x.id ? " · suggested" : ""}</option>)}
                </select>
              </div>
            </Field>
            <Field label="Channels in plan" src="off takes the channel out of the benchmark and the target"
              help={isOff("paid") ? "Paid off: no paid signups, no budget; the other channels carry the whole target." : "Each channel on takes its share of the signup target from the basket."}>
              <div className="ts-row" style={{ flexWrap: "wrap", gap: 8 }}>
                {GROUPS.map((g) => <Switch key={g.key} on={!isOff(g.key)} label={g.name} onChange={(on) => setInp({ ...inp, channels_off: on ? off.filter((x) => x !== g.key) : [...off, g.key] })} />)}
              </div>
            </Field>
          </div>
          <Field label="Where the stretch comes from" src={T && T.stretch_typed ? "placed" : "the basket's own shares"} help={stretchHelp}>
            <div className="ts-stretch">
              <div className="ts-sliders">
                {GROUPS.map((g) => {
                  const active = activeGroups.includes(g.key);
                  const pct = Math.round(100 * (shares[g.key] || 0));
                  return (
                    <label key={g.key} className={`ts-slider${active ? "" : " dis"}`}>
                      <span className="head"><span>{g.name}</span><b>{active ? `${pct}%` : "–"}</b></span>
                      <input type="range" min="0" max="100" step="1" disabled={!active || activeGroups.length < 2} value={active ? pct : 0} onChange={slideStretch(g.key)} aria-label={`${g.name}'s share of the stretch`} />
                      <span className="note">{!active ? (isOff(g.key) ? "not in plan" : "no benchmark to lift") : T && BM ? `${fmt(BM.signups_by_group[g.key])} → ${fmt(T.signups_by_group[g.key])}` : ""}</span>
                    </label>
                  );
                })}
              </div>
              <div className="ts-row" style={{ marginTop: 8 }}>
                <button type="button" className="ts-btn secondary" disabled={!T || !T.stretch_typed} onClick={() => setInp({ ...inp, stretch_from: null })}>Even</button>
                <button type="button" className="ts-btn secondary" disabled={!activeGroups.includes("paid")} onClick={() => setInp({ ...inp, stretch_from: { paid: 1 } })}>All from paid</button>
              </div>
            </div>
          </Field>
        </section>

        <section className="ts-card" aria-label="Products">
          <CardHead dot="#2f5fb3" title="Products" desc={atProducts.length ? `${atProducts.length} work${atProducts.length === 1 ? "" : "s"} from Airtable; an unticked work counts nothing` : "Airtable has no record matched to this launch"}
            right={<Switch on={editing} onChange={setEditing} label="Edit figures" />} />
          {atProducts.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="sheet" style={{ width: "100%", fontSize: 12.5 }}>
                <thead><tr><th style={{ width: 28 }} /><th style={{ textAlign: "left" }}>Work</th><th>Edition</th><th>Units target</th><th>Price (EUR)</th><th>Framing</th></tr></thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.airtable_id} className={p.excluded ? "off" : undefined}>
                      <td><input type="checkbox" className="tick" checked={!p.excluded} disabled={!editing} onChange={(e) => setProduct(p, { excluded: e.target.checked ? null : true })} title={p.excluded ? "Unticked: counts nothing" : "Ticked: in the release"} /></td>
                      <td style={{ textAlign: "left" }}>{p.name}</td>
                      <td className="num">{editing ? <NumBox value={p.typed.edition ?? ""} placeholder={p.edition ? fmt(p.edition) : ""} onCommit={(raw) => setProduct(p, { edition: raw === "" ? null : Math.round(Number(String(raw).replace(/[^0-9.]/g, ""))) })} disabled={p.excluded} /> : (p.edition_eff ? fmt(p.edition_eff) : "–")}</td>
                      <td className="num">{editing ? <NumBox value={p.typed.units_target ?? ""} placeholder={p.units_target ? fmt(p.units_target) : ""} onCommit={(raw) => setProduct(p, { units_target: raw === "" ? null : Number(String(raw).replace(/[^0-9.]/g, "")) })} disabled={p.excluded} /> : (p.units_target_eff ? fmt(p.units_target_eff) : "–")}</td>
                      <td className="num">{editing ? <NumBox value={p.typed.unit_price ?? ""} placeholder={p.unit_price ? fmt(p.unit_price) : ""} onCommit={(raw) => setProduct(p, { unit_price: raw === "" ? null : Number(String(raw).replace(/[^0-9.]/g, "")) })} disabled={p.excluded} /> : (p.unit_price_eff ? fmtMoney(p.unit_price_eff) : "–")}</td>
                      <td style={{ color: C.muted }}>{p.framing_available === false ? "none" : p.framing_available ? "on offer" : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="ts-help">Type the units target above; the works and their editions come from Airtable once the launch is matched.</div>}
        </section>
      </div>
    </>
  );
}
