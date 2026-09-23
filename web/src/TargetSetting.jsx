/* Target setting tab - the settled design (docs/BENCHMARK_SPEC.md §8, and the
 * Release Target Setting canvas for the parts §8 does not move):
 * inputs left (Release & timeline, Economics with derived per-unit fields,
 * Benchmark basket with the channels in plan, Stretch), derived targets rail
 * right, recomputing live via shared/benchmarkModel.mjs. Save persists the
 * inputs and the server rebuilds the release on them.
 *
 * The question this tab asks is "which past launches is this one like?", and
 * the answer is a basket; one even uplift K then reaches the sellout (§1,
 * §4). So the basket is the first-class input, the sellout is the only lever
 * and what is left over is the stretch, stated rather than dialled in. The
 * quartile levers that used to sit here asked a different question - "what
 * shape of launch is this?" - and are gone from the page; the build keeps
 * that model only as the fallback for a basket with no median units.
 *
 * Two things a basket cannot know are asked here instead: which channels
 * this release will not run (paid; the artist's own channels), which take
 * their medians out of the benchmark and their share out of the target
 * (§4.3), and what a paid unit costs to buy, which sets the paid budget.
 *
 * Everything benchmark-shaped is guarded on a basket being present - the
 * snapshot's, or one picked and not yet saved. Without one the cards say so
 * and the rail's figures are dashes until a basket is chosen. */
import React, { useEffect, useMemo, useState } from "react";
import { Card, GROUP_DOTS, C, fmt, fmtMoney, fmtPct } from "./ui.jsx";
import BasketPicker from "./BasketPicker.jsx";
import { computeTargets } from "../../shared/targetModel.mjs";
import { applyChannelsOff, benchmarkTargets, channelsOffOf, profileOf } from "../../shared/benchmarkModel.mjs";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const BLUE = "#2f5fb3";

// the five display groups, in the order the profile dicts are written
// (etl/baskets.py GROUPS), so the table reads the same way as the snapshot
const GROUPS = [
  { key: "aa_email", name: "AA Email" },
  { key: "aa_social", name: "AA Meta" },
  { key: "referral_artist", name: "Referral artist" },
  { key: "search_direct_other", name: "Search / direct / other" },
  { key: "paid", name: "Paid" },
];

/* The two rates the sell-through prediction converts entries in hand at: a
 * plain draw entry, and a pre-order entry whose card is already authorised.
 *
 * This used to be a table as well, a row per draw the feed found, with a name,
 * an edition and a pre-order rate typed against each. The names were never
 * typed - every release showed "Draw 1" to "Draw 7" - the editions were left
 * blank because the feed carries them, and the whole grid was three columns of
 * nothing above the two fields that were actually used. The per-product
 * overrides still exist in the release's inputs and the ETL still reads them,
 * so a product that already has one keeps it; there is simply no longer a
 * table in the way of the rates. */
function Products({ inp, setInp }) {
  const asPct = (v) => (v === null || v === undefined || v === "" ? "" : Math.round(Number(v) * 100));
  const ratePct = asPct(inp.entry_conversion_rate);
  const preRatePct = asPct(inp.preorder_conversion_rate);
  return (
    <Card dot="#8a7a52" title="Conversion of entries in hand">
      <div className="spacer-16" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "16px 20px" }}>
        <Field label="Entry → order rate (%)" tip="What share of eligible entries in hand become orders - the sell-through prediction counts entries in hand at this rate. Empty means the panel's 80%.">
          <input className="control num" value={ratePct} placeholder="80"
            onChange={(e) => { const raw = String(e.target.value).replace(/[^0-9]/g, ""); setInp({ ...inp, entry_conversion_rate: raw === "" ? null : clamp(parseInt(raw, 10), 1, 100) / 100 }); }} />
        </Field>
        <Field label="Pre-order → order rate (%)" tip="What share of PRE-ORDER entries become orders. Their card is already authorised, so they are charged at the draw rather than invoiced and convert higher than a plain entry. Empty means the panel's 95%.">
          <input className="control num" value={preRatePct} placeholder="95"
            onChange={(e) => { const raw = String(e.target.value).replace(/[^0-9]/g, ""); setInp({ ...inp, preorder_conversion_rate: raw === "" ? null : clamp(parseInt(raw, 10), 1, 100) / 100 }); }} />
        </Field>
      </div>
    </Card>
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

/* A switch: the control, its name, and one clause on what it does. */
function Switch({ id, on, onChange, label, sub, why }) {
  return (
    <label title={why} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
      <input type="checkbox" id={id} checked={on} onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: C.ink, width: 15, height: 15, margin: 0, cursor: "pointer" }} />
      <span>{label} <span style={{ color: C.muted, fontSize: 12 }}>· {sub}</span></span>
    </label>
  );
}

/* One pick from a few words, the way the framing switch is drawn. */
function Seg({ options, value, onChange, small }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      {options.map((o) => {
        const active = value === o;
        return (
          <button key={o} onClick={() => onChange(o)}
            style={{ fontFamily: "inherit", fontSize: small ? 11.5 : 12, fontWeight: active ? 600 : 500, padding: small ? "3px 10px" : "6px 16px",
              border: "none", cursor: "pointer", background: active ? "#e6eefa" : "#fff", color: active ? BLUE : C.muted }}>{o}</button>
        );
      })}
    </div>
  );
}

/* One line of the per-channel table. Benchmark values are the basket's own
 * medians; the target is the benchmark lifted by K and the stretch is the
 * difference, so the three columns always read benchmark + stretch = target
 * (§1). Conversion carries no uplift at all - it is held at the benchmark
 * (§4), which is why the column says so. */
function ChannelRow({ label, bmSessions, bmUnits, conv, k, head, total, off }) {
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
  if (off) {
    return (
      <tr>
        <td style={{ ...cell, textAlign: "left", whiteSpace: "nowrap", color: C.muted }}>{label}</td>
        <td colSpan={6} style={{ ...cell, textAlign: "left", color: C.muted, fontStyle: "italic" }}
          title="Set aside on this tab: its median leaves the benchmark and the other channels carry the whole target.">not in plan</td>
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
  // the Slack channel the sell-through card posts to: its own small document
  // on the server (server/slack.js), saved on its own so a release without
  // targets can have one too
  const [slackDraft, setSlackDraft] = useState((snap.slack && snap.slack.channel) || "");
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackError, setSlackError] = useState(null);
  const [slackNote, setSlackNote] = useState(null);   // the server saved, but somewhere that will not last
  const slackCurrent = (snap.slack && snap.slack.channel) || "";
  const saveSlack = async () => {
    setSlackSaving(true); setSlackError(null); setSlackNote(null);
    try {
      const res = await fetch(`/api/releases/${snap.id}/slack-channel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: slackDraft }),
      });
      const d = await res.json();
      if (!res.ok) { setSlackError(d.error || `save failed (${res.status})`); return; }
      setSlackDraft((d.slack && d.slack.channel) || "");
      setSlackNote(d.warning || null);
      onSaved({ ...snap, slack: d.slack });
    } catch (e) { setSlackError(String(e)); } finally { setSlackSaving(false); }
  };

  useEffect(() => {
    setMeta(null); setInp(null); setQual(null); setError(null); setPick(null); setPicking(false);
    setSlackDraft((snap.slack && snap.slack.channel) || ""); setSlackError(null); setSlackNote(null);
    fetch(`/api/inputs/${snap.id}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      // a release nobody has set targets for comes back with inputs: null and
      // the defaults the ETL could derive - the form starts from those
      const start = d.inputs || d.defaults;
      setMeta({ ...d, inputs: start, creating: !d.inputs });
      // an estate marked Referral Artist N/A under the old levers is an artist
      // with no channels of their own: the same choice, under its new name
      const artistNA = ((start.channel_quality_overrides || {})["Referral Artist"]) === "N/A";
      setInp({ ...start, channels_off: start.channels_off || (artistNA ? ["referral_artist"] : []) });
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
  // the target is only part of the edition: the rail says so
  const partialEdition = Number(inp.edition_total) > Number(inp.edition_size) && Number(inp.edition_size) > 0;
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
  /* The channels this release will not run (§4.3), and the basket read
   * without them: the pending pick's live medians when there is one, else
   * the snapshot's basket re-read from its full medians. Both go through the
   * same function the build runs, so the table and the rail say now what the
   * page will say after the save. */
  const off = channelsOffOf(inp);
  const isOff = (g) => off.includes(g);
  const setOff = (g, on) => setInp({ ...inp, channels_off: on ? off.filter((x) => x !== g) : [...off, g] });
  const profile = prof ? applyChannelsOff(prof, off) : bm ? applyChannelsOff(profileOf(bm), off) : null;
  const editionSize = Number(inp.edition_size) || 0;
  const bmUnits = profile && profile.units > 0 ? profile.units : null;
  // K follows the sellout box as it is typed, so the table and the stretch
  // never disagree with the number above them; the snapshot's own K is the
  // fallback for a release whose economics are still blank (§4).
  const k = bmUnits ? (editionSize > 0 ? editionSize / bmUnits : bm ? bm.k : null) : null;
  const stretchUnits = bmUnits !== null && editionSize > 0 ? editionSize - bmUnits : null;
  const stretchPct = bmUnits ? stretchUnits / bmUnits : null;
  const paidShare = profile ? profile.share_sessions.paid : null;
  const cpp = (b.cost_per_purchase || {})[inp.cpp_pick || "Median"] ?? 0;

  const onPick = (chosen) => {
    setPick(chosen);
    setPicking(false);
    setInp({
      ...inp,
      benchmark_basket: chosen.kind === "bespoke"
        ? { kind: "bespoke", members: chosen.members, name: chosen.name }
        : { kind: chosen.kind, id: chosen.id },
      // the picker's recency switch is a release input: the rule reads it on
      // every rebuild, so the suggestion stays the one that was looked at
      prefer_recent: chosen.preferRecent !== false,
    });
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/inputs/${snap.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // benchmark_basket rides inside `inputs` with everything else (§6).
        // The even uplift is the only stretch there is, so every save says so:
        // a release that once opted for the levers comes back to the basket.
        body: JSON.stringify({ inputs: {
          ...inp,
          campaign_name: (inp.campaign_name || "").trim() || null,
          channel_quality_overrides: qual,
          channels_off: off,
          stretch_mode: "even",
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

  /* The rail's three columns (§8.3), from the same model the build runs:
   * the target is the basket's median lifted by K, the benchmark is the
   * median itself, and the stretch is the difference, so benchmark + stretch
   * = target on every row. Without a basket, or before the sellout is typed,
   * there is nothing to lift and the rows are dashes. */
  const T = profile ? benchmarkTargets(profile, {
    edition_size: editionSize, unit_price: Number(inp.unit_price) || 0, cpp_pick: inp.cpp_pick || "Median",
    units_per_buyer: (snap.targets || {}).units_per_buyer || 0,
  }, b) : null;
  const BM = T ? T.benchmark : null;
  const railRow = (label, target, bmv, format, tip) => {
    let stretch = target === null || bmv === null ? null : target - bmv;
    // a stretch that rounds away to nothing in the row's own format is zero, not
    // a negative sliver of one
    if (stretch !== null && format(Math.abs(stretch)) === format(0)) stretch = 0;
    return { label, tip, target, bm: bmv, stretch, format };
  };
  const railRows = [
    railRow("Paid units", T ? T.paid_units : null, BM ? BM.paid_units : null, (v) => fmt(v, 0),
      isOff("paid") ? "Paid is not in plan for this release." : "The basket's median paid units, lifted by K."),
    railRow("Draw / pre-order units", T ? T.draw_units : null, BM ? BM.draw_units : null, (v) => fmt(v, 0),
      "The organic target less the private room's share of it."),
    railRow("Private room units", T ? T.pr_units : null, BM ? BM.pr_units : null, (v) => fmt(v, 0),
      "The email group's target at the basket's private-room share."),
    railRow("Buyers", T ? T.buyers : null, BM ? BM.buyers : null, (v) => fmt(v, 0),
      T ? `People, not pieces: the target divided by ${fmt(T.units_per_buyer, 3)} units per buyer.` : "People, not pieces."),
    railRow("Eligible entries", T ? T.entries_target : null, BM ? BM.entries : null, (v) => fmt(v, 0),
      "Draw + paid units ÷ 0.8 eligible-entry → order rate. The benchmark is the basket's own median entries."),
    railRow("Sessions", T ? T.total_sessions : null, BM ? BM.sessions : null, (v) => fmt(v, 0),
      "The basket's median sessions, lifted by the same K as every other volume."),
    railRow("Paid budget", T ? T.paid.budget : null, BM ? BM.paid_budget : null, (v) => fmtMoney(v, 0),
      isOff("paid") ? "Paid is not in plan for this release." : `Paid units × ${fmtMoney(cpp)} per unit, the cost per purchase picked under Economics.`),
    railRow("% of launch value", T ? (T.paid.budget_pct_of_launch_value ?? 0) : null, BM ? (BM.budget_pct_of_launch_value ?? 0) : null, (v) => fmtPct(v, 1),
      "Sense check: paid budget should stay under 6% of launch value."),
  ];
  const railCell = { fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  /* Untracked much higher than normal (DATA_MODEL 1.3): the build says which
   * of entries and units has a share over twice the panel's median and past
   * its 90th percentile; the sentence quotes the share, the count behind it
   * and the norm it is read against. */
  const ut = snap.untracked || null;
  const untrackedHigh = ut && Array.isArray(ut.high) ? ut.high.filter((k) => ut[k] && ut[k].share !== null).map((k) => {
    const v = ut[k], n = (ut.normal || {})[k] || {};
    const months = (ut.normal || {}).recentMonths;
    return { key: k, sentence: `${fmtPct(v.share, 0)} of this release's ${k} (${fmt(v.count, 0)} of ${fmt(v.total, 0)}) have no channel, against ${fmtPct(n.median, 0)} on a typical launch${months ? ` of the last ${months} months` : ""} and ${fmtPct(n.p90, 0)} at the 90th percentile.` };
  }) : [];

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

        {untrackedHigh.length > 0 && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fbf1e6", color: "#5a3f0a", fontSize: 12.5, lineHeight: 1.5 }}
            title="Untracked is the funnel export's channel for entries and units that could not be attributed. The build spreads it across the tracked channels in proportion to what they did that day.">
            <b>Untracked is much higher than normal.</b> {untrackedHigh.map((u) => u.sentence).join(" ")} The build spreads
            untracked across the tracked channels in proportion, so the channel split, the per-channel targets' progress and
            the funnel read less certainly than usual. Worth checking the tracking before reading the channel figures.
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
            <Field label="Slack channel" tip="Where the Post to Slack button on the sell-through card sends this release's update. The channel name without the #; for a private channel, invite the Launch Performance bot to it first. Saved on its own, separately from the targets.">
              <div style={{ display: "flex", gap: 8 }}>
                <input className="control" value={slackDraft} onChange={(e) => setSlackDraft(e.target.value)} placeholder="launch-updates" />
                <button className="btn secondary" disabled={slackSaving || slackDraft.trim().replace(/^#/, "") === slackCurrent} onClick={saveSlack} style={{ flex: "0 0 auto" }}>
                  {slackSaving ? "Saving…" : "Save"}
                </button>
              </div>
              {slackError && <div style={{ fontSize: 11.5, marginTop: 4, color: C.red }}>{slackError}</div>}
              {!slackError && slackNote && <div style={{ fontSize: 11.5, marginTop: 4, color: C.amber, lineHeight: 1.5 }}>{slackNote}</div>}
              {!slackError && !slackNote && snap.slack && snap.slack.lastPostAt && (
                <div style={{ fontSize: 11.5, marginTop: 4, color: C.muted }}>last posted {new Date(snap.slack.lastPostAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
              )}
            </Field>
            <Field label="Budget file" tip="A link to the budget sheet, kept here for reference. A web address gets an open link beside it.">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input className="control" value={inp.budget_file || ""} onChange={set("budget_file")} placeholder="https://docs.google.com/spreadsheets/…" />
                {/^https?:\/\/\S+$/i.test(String(inp.budget_file || "").trim()) && (
                  <a href={String(inp.budget_file).trim()} target="_blank" rel="noopener noreferrer" className="btn secondary" style={{ flex: "0 0 auto", textDecoration: "none" }}>Open</a>
                )}
              </div>
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
            <Field label="Target (units)" tip="The units the launch is targeted to sell by close: the whole edition for most launches. When the target is only part of the edition, put the edition in Total edition.">
              <input className="control num" style={{ fontWeight: 600 }} value={inp.edition_size ?? ""} onChange={setNum("edition_size")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="Total edition (units)" tip="Only when the target is part of the edition (Warhol: a 2,440 target on 6,100). The hero cap, the room and the sell-through percentages then read against this; the targets stay on the target. Leave empty when the target is the whole edition.">
              <input className="control num" value={inp.edition_total ?? ""} onChange={setNum("edition_total")} placeholder="same as target" />
            </Field>
            <Field label="Unit price (£)">
              <input className="control num" value={inp.unit_price ?? ""} onChange={setNum("unit_price")} placeholder={creating ? "required" : ""} />
            </Field>
            <Field label="Launch value" tip="Target units × unit price - derived.">
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
                        border: "none", cursor: "pointer", background: active ? "#e6eefa" : "#fff",
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
            <Field label="Cost per purchase" tip="What a paid unit costs to buy: the low, median or high quartile of the panel's cost per purchase. Paid units × this is the paid budget.">
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Seg options={["Low", "Median", "High"]} value={inp.cpp_pick || "Median"} onChange={(v) => setInp({ ...inp, cpp_pick: v })} />
                <span className="num" style={{ fontSize: 12, color: C.muted }}>{fmtMoney(cpp)} / unit</span>
              </div>
            </Field>
          </div>
        </Card>

        <Products inp={inp} setInp={setInp} />

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

          {profile === null ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 14, lineHeight: 1.6 }}>
              No basket yet. Choose one to see the benchmark and the targets it gives; a release saved without one is
              benchmarked against the launches nearest its target and price.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <span className="chip" title="Launches in the basket. Under six and the median moves a lot on one launch.">
                  {fmt(prof ? prof.n : bm && bm.basket ? bm.basket.n : null)} launches
                </span>
                <span className="chip" title={off.length ? "Median units without the channels set aside, with the 25th to 75th percentile read the same way." : "Median units, with the 25th to 75th percentile of the basket beside it."}>
                  units {fmt(profile.units)} ({fmt(profile.units_p25)}-{fmt(profile.units_p75)})
                </span>
                {profile.price > 0 && (
                  <span className="chip" title="Median unit price of the basket in sterling (from Airtable), with its 25th to 75th percentile. The default basket matches on price as well as size (BENCHMARK_SPEC 3.1).">
                    price {fmtMoney(profile.price)} ({fmtMoney(profile.price_p25)}-{fmtMoney(profile.price_p75)})
                  </span>
                )}
                <span className="chip">sessions {fmt(profile.sessions)}</span>
                <span className="chip" title={isOff("paid") ? "Paid is not in plan for this release." : "Median share of sessions from paid."}>
                  {isOff("paid") ? "paid not in plan" : `paid ${fmtPct(paidShare, 0)}`}
                </span>
                <span className="chip">{fmt(profile.campaign_days)} campaign days</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
                {basketDirty
                  ? <>Not saved yet. The figures below follow the launches ticked; save to rebuild the page on them.</>
                  : bm && bm.basket
                    ? <>Matched from {fmt(bm.basket.n)} comparable launches
                      {bm.basket.id === bm.basket.suggestedId ? ", the suggested basket for this release" : ", chosen by hand"}
                      {bm.basket.thin ? ". Thin: under six launches, so the median moves easily." : "."}</>
                    : null}
              </div>
            </>
          )}

          {/* what a basket cannot know: the channels this release will not run
              (§4.3). Off takes the group's median out of the benchmark and its
              share out of the target; the other channels carry the whole sellout. */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.hairline}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}
              title="A channel this release will not run leaves the benchmark and the target: the basket is read on its other channels, and they carry the whole sellout between them.">
              Channels in plan
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 26px", alignItems: "center" }}>
              <Switch id="ch-paid" on={!isOff("paid")} onChange={(on) => setOff("paid", on)} label="Running paid"
                sub={isOff("paid") ? "off: benchmarked on what the basket did without paid, and the other channels carry the whole target" : "paid units, spend and the paid benchmark are in"}
                why="The basket keeps every launch, paid or not; with paid off each counts on its other channels only." />
              <Switch id="ch-artist" on={!isOff("referral_artist")} onChange={(on) => { setOff("referral_artist", on); if (on && qual["Referral Artist"] === "N/A") setQual({ ...qual, "Referral Artist": "Medium" }); }}
                label="Artist's own channels"
                sub={isOff("referral_artist") ? "off: no artist target and no posting benchmark - an estate, or an artist who will not post" : "the artist posts on channels of their own"}
                why="Off for an estate, or a living artist with no channels of their own. The artist group leaves the benchmark and the funnel expects no posts." />
              {!isOff("referral_artist") && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted }}
                  title="How much the artist will post, against the tiers past campaigns were labelled with: the funnel's posting benchmark is the median of completed campaigns in the same tier.">
                  posting
                  <Seg small options={["Low", "Medium", "High"]} value={["Low", "Medium", "High"].includes(qual["Referral Artist"]) ? qual["Referral Artist"] : "Medium"}
                    onChange={(v) => setQual({ ...qual, "Referral Artist": v })} />
                </span>
              )}
            </div>
          </div>

          {profile && (
            <>
              <div style={{ height: 18 }} />
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><ChannelRow head /></thead>
                <tbody>
                  {GROUPS.map((g) => (
                    <ChannelRow key={g.key} label={g.name} off={isOff(g.key)}
                      bmSessions={profile.sessions_by_group[g.key] || 0}
                      bmUnits={profile.units_by_group[g.key] || 0}
                      conv={profile.conv[g.key] > 0 ? profile.conv[g.key] : null} k={k || 1} />
                  ))}
                  <ChannelRow total label="Total"
                    bmSessions={profile.sessions}
                    bmUnits={profile.units}
                    conv={null} k={k || 1} />
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card dot="#4f80d6" title="Stretch">
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

          <div style={{ fontSize: 12, color: C.muted, marginTop: 14, lineHeight: 1.6 }}>
            The stretch is spread evenly: every volume - sessions, entries, units and spend - is lifted by the same
            factor in every channel in plan, on every day of the campaign, and conversion rates are held at the
            benchmark. A target that quietly assumes the site converts better than it ever has is a target nobody
            can act on, so the stretch is asked of traffic and spend only.
          </div>
        </Card>
      </div>

      <div style={{ width: 384, flex: "0 0 384px", position: "sticky", top: 28 }}>
        <Card dot="#8a7a52" title="Derived targets">
          <div className="spacer-8" />
          <div className="lead" title="Secured-units sellout target - the hero target on the Overview tab.">
            {creating && missing.length ? "–" : fmt(editionSize)}
          </div>
          <div className="lead-caption">{creating && missing.length ? "sellout units - enter the economics"
            : partialEdition ? `target units · ${Math.round((100 * Number(inp.edition_size)) / Number(inp.edition_total))}% of the ${fmt(inp.edition_total)} edition` : "sellout units"}</div>
          <div className="spacer-16" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 72px 72px 72px", gap: 4, alignItems: "center" }}>
            <span />
            <span style={{ ...railCell, fontSize: 11.5, color: C.muted, fontWeight: 600 }} title="The basket's median - what launches like this one typically reach.">Benchmark</span>
            <span style={{ ...railCell, fontSize: 11.5, fontWeight: 600 }}>Target</span>
            <span style={{ ...railCell, fontSize: 11.5, color: C.muted, fontWeight: 600 }} title="Target − benchmark: the uplift being asked for.">Stretch</span>
            {railRows.map((r) => (
              <React.Fragment key={r.label}>
                <span style={{ fontSize: 12.5, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }} title={r.tip}>{r.label}</span>
                <span style={{ ...railCell, color: C.muted, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8 }}>{r.bm === null ? "–" : r.format(r.bm)}</span>
                <span style={{ ...railCell, fontWeight: 600, borderTop: `1px solid ${C.hairline}`, paddingTop: 8, paddingBottom: 8,
                  color: r.target === null ? C.muted : r.label === "% of launch value" ? (T && T.paid.sense_check_breached ? C.red : C.green) : C.ink }}>{r.target === null ? "–" : r.format(r.target)}</span>
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
          {!T && !error && !(creating && missing.length > 0) && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
              {profile ? "Type the target units to see the targets." : "Choose a basket to see the targets; saving without one benchmarks against the nearest launches."}
            </div>
          )}
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
          targetUnits={Number(inp.edition_size) || 0} unitPrice={Number(inp.unit_price) || 0}
          preferRecent={inp.prefer_recent !== false} channelsOff={off}
          // what the rule needs to find the artist's own earlier launches and
          // to read the typed price in its currency (shared/basketRule.mjs)
          artist={snap.artist || ""} currency={inp.currency || "GBP"}
          announceDate={inp.announce_date || null} privateRoomOpen={inp.private_room_open || null}
          // the picker asks for a target and a price when there are none, and
          // writes them straight into this form so the basket follows the typing
          onInputs={(patch) => setInp({ ...inp, ...patch })}
          onPick={onPick} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
