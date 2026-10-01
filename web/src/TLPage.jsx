/* The timed-launch page (docs/TL_SPEC.md §4, §5, §6). Two page states, not
 * a toggle: before the window the cards watch signups against a signup
 * target worked back from the units target; from the sales open they watch
 * units against Airtable's units target by the hour. The header's chips
 * (TLChips) say the state, the open and the close; the body (TLOverview)
 * renders the state's cards from the snapshot etl/tl.py build_tl writes.
 *
 * The cards are the LE cards' shapes in TL words, drawn with the shared
 * primitives (Card, TrackBar, the colour tokens, the formatters): one bar
 * carries both references (the target as the fill, the benchmark as the
 * dotted outline) with the actual in front, a line chart carries the pace,
 * the channel split is columns rising from one baseline. Phase one carries
 * the signups state in full and a sales summary from the feed's purchase
 * events; the window's eight cards from the orders table come with phase two. */
import React, { useMemo, useState } from "react";
import { Card, TrackBar, C, GROUP_DOTS, fmt, fmtSigned, fmtMoney, fmtPct, fmtDay, useTip, useBoxSize } from "./ui.jsx";

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const DAY_MS = 86400000;
const when = (iso, withTime = true) => {
  if (!iso) return "–";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  const day = fmtDay(d, true);
  if (!withTime || !/T/.test(String(iso))) return day;
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  return `${day} ${hm}`;
};
const hours = (h) => (h === null || h === undefined ? "" : h % 24 === 0 && h >= 72 ? `${h / 24} days` : `${Math.round(h)} hours`);
const pctOf = (a, b) => (b > 0 && a !== null ? Math.round((100 * a) / b) : null);
const STATE_WORDS = {
  upcoming: "Upcoming", signups: "Signups", window: "Window open", settling: "Settling", closed: "Closed",
};

/* ---------------------------------------------------------------- header chips */

export function TLChips({ snap }) {
  const t = useTip();
  const st = snap.tlState;
  const rows = [
    { label: "Announced", value: when(snap.windowStart, false) },
    ...(snap.earlyAccessOpen ? [{ label: snap.earlyAccessAssumed ? "Early access (expected)" : "Early access", value: when(snap.earlyAccessOpen) }] : []),
    { label: "Opens", value: when(snap.windowOpen) },
    { label: "Closes", value: when(snap.windowClose) },
    { label: "Window", value: hours(snap.windowHours) },
    { label: "Settles", value: when(snap.settleEnd, false) },
  ];
  const note = (snap.derived || {}).dates_note;
  return (
    <>
      <span className="chip" {...t.props({ head: `${STATE_WORDS[st] || st} · ${snap.tlLabel || ""}`, rows, body: note || undefined })}
        style={st === "window" ? { background: "#e4f3ec", color: C.green } : undefined}>
        {snap.tlLabel || STATE_WORDS[st]}
      </span>
      <span className="chip" title="The public window, Amsterdam time: Airtable's launch date at its launch time, else the feed's timestamp, else 14:00">
        {st === "window" || st === "settling" || st === "closed" ? `Closed ${when(snap.windowClose)}` : `Opens ${when(snap.windowOpen)}`} · {hours(snap.windowHours)}
      </span>
      {snap.economics && snap.economics.units_target > 0 && (
        <span className="chip" title={`Airtable's units target summed over the ticked works${snap.economics.edition_size ? `, of an edition of ${fmt(snap.economics.edition_size)}` : ""}`}>
          Target {fmt(snap.economics.units_target)} units{snap.economics.edition_size ? ` · ${fmt(snap.economics.edition_size)} edition` : ""}
        </span>
      )}
      {!snap.targeted && (
        <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }}
          title="No units target in Airtable and none typed, so there is no signup target - the page shows actuals and the basket">No target</span>
      )}
      {(snap.derived || {}).dates_assumed && (
        <span className="chip" style={{ background: "#fbf1e6", color: "#8a5f00" }} title={note || "A date is assumed"}>Dates assumed</span>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- the strip */

function TLStrip({ snap }) {
  const t = useTip();
  if (!snap.windowStart || !snap.salesOpen) return null;
  const announce = new Date(snap.windowStart + "T00:00:00Z");
  const open = new Date(snap.salesOpen);
  const close = new Date(snap.windowClose);
  const now = snap.builtAt ? new Date(snap.builtAt) : new Date();
  const st = snap.tlState;
  const inWindow = st === "window" || st === "settling" || st === "closed";
  const a = inWindow ? open : announce, b = inWindow ? close : open;
  const span = b - a;
  const p = span > 0 ? Math.max(0, Math.min((now - a) / span, 1)) * 100 : 0;
  const daysTo = Math.ceil((open - now) / DAY_MS);
  const hoursLeft = (close - now) / 3600000;
  const rows = [
    { label: "Announced", value: when(snap.windowStart, false) },
    { label: snap.earlyAccessAssumed ? "Early access expected" : snap.earlyAccessOpen ? "Early access" : "Sales open", value: when(snap.salesOpen) },
    { label: "Public open", value: when(snap.windowOpen) },
    { label: "Closes", value: when(snap.windowClose) },
    { label: "Window", value: hours(snap.windowHours) },
  ];
  let right;
  if (st === "upcoming" || st === "signups") right = <><b>{daysTo} {daysTo === 1 ? "day" : "days"} to the open</b> · {when(snap.salesOpen)}</>;
  else if (st === "window") right = <><b>{Math.max(Math.ceil(hoursLeft), 0)} h left</b> · closes {when(snap.windowClose)}</>;
  else if (st === "settling") right = <><b>Settling</b> · final {when(snap.settleEnd, false)}</>;
  else right = <>Closed {when(snap.windowClose)}</>;
  return (
    <div className="launch-strip" {...t.props({ head: "Launch window", rows })}>
      <span>{inWindow ? `Opened ${when(snap.salesOpen)}` : `Announced ${when(snap.windowStart, false)}`}</span>
      <span className="track">
        <span className="fill" style={{ width: `${p}%` }} />
        {p > 0 && p < 100 && <span className="knob" style={{ left: `${p}%` }} />}
        <span className="launch" />
      </span>
      <span>{right}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- the pace chart */

/* Cumulative actual against the target's pace and the benchmark's, by day
 * (signups) or by hour (units). pts: [{x: label, actual, plan, bm}], with
 * `todayIndex` the last point with an actual. One picture, three lines: the
 * actual solid blue, the target's pace a solid grey, the benchmark dotted. */
function PaceChart({ pts, todayIndex, unit, xLabel, hoverLabel }) {
  const [ref, w] = useBoxSize();
  const [hover, setHover] = useState(null);
  const W = Math.max(w || 600, 320), H = 180, L = 44, R = 12, T = 10, B = 26;
  const n = pts.length;
  if (!n) return <div style={{ color: C.muted, fontSize: 12.5 }}>Nothing to draw yet.</div>;
  const maxV = Math.max(1, ...pts.flatMap((p) => [p.actual, p.plan, p.bm].filter((v) => v !== null && v !== undefined)));
  const top = maxV * 1.08;
  const x = (i) => L + ((W - L - R) * i) / Math.max(n - 1, 1);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const path = (key) => {
    let d = "", pen = false;
    pts.forEach((p, i) => {
      const v = p[key];
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const ticks = (() => {
    const raw = top / 3, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
    const out = [];
    for (let v = step; v <= top; v += step) out.push(v);
    return out;
  })();
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(Math.floor((W - L - R) / 70), 2)));
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    setHover(i);
  };
  const hp = hover !== null ? pts[hover] : null;
  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={C.hairline} />
            <text x={L - 6} y={y(v) + 4} fontSize="11" textAnchor="end" fill={C.muted}>{fmt(v)}</text>
          </g>
        ))}
        {todayIndex !== null && todayIndex >= 0 && todayIndex < n && (
          <line x1={x(todayIndex)} x2={x(todayIndex)} y1={T} y2={H - B} stroke={C.todayLine} strokeWidth="6" />
        )}
        <path d={path("bm")} fill="none" stroke={C.refLine} strokeWidth="1.5" strokeDasharray="2 3" />
        <path d={path("plan")} fill="none" stroke={C.targetLine} strokeWidth="1.5" />
        <path d={path("actual")} fill="none" stroke={C.blue} strokeWidth="2.2" />
        {todayIndex !== null && pts[todayIndex] && pts[todayIndex].actual !== null && (
          <circle cx={x(todayIndex)} cy={y(pts[todayIndex].actual)} r="3.5" fill={C.blue} />
        )}
        {pts.map((p, i) => (i === n - 1 || (i % labelEvery === 0 && n - 1 - i >= Math.max(labelEvery / 2, 1))) && (
          <text key={i} x={x(i)} y={H - 8} fontSize="11" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fill={C.muted}>{xLabel(p, i)}</text>
        ))}
        {hp && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke={C.ink} strokeWidth="1" strokeDasharray="2 2" />}
      </svg>
      {hp && (
        <div className="chart-tip" style={{ position: "absolute", left: Math.min(Math.max(((x(hover) / W) * (w || W)) - 70, 0), (w || W) - 160), top: 4, visibility: "visible" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{hoverLabel(hp)}</div>
          {[["Actual", hp.actual, C.blue], ["Target pace", hp.plan, C.targetLine], ["Benchmark", hp.bm, C.refLine]].map(([l, v, col]) => (
            v !== null && v !== undefined ? <div key={l} style={{ display: "flex", gap: 12, justifyContent: "space-between" }}><span style={{ color: col }}>{l}</span><b className="num">{fmt(v)} {unit}</b></div> : null
          ))}
        </div>
      )}
      <div className="legend-rows" style={{ marginTop: 6 }}>
        <div className="legend-row"><span className="swatch" style={{ background: C.blue }} /><span style={{ color: C.muted }}>Actual</span></div>
        <div className="legend-row"><span className="swatch" style={{ background: C.targetLine }} /><span style={{ color: C.muted }}>Target pace</span></div>
        <div className="legend-row"><span className="swatch" style={{ background: "transparent", border: `1.5px dotted ${C.refLine}` }} /><span style={{ color: C.muted }}>Benchmark</span></div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- group columns */

/* Each channel group as a column: the target for today the fill, the
 * benchmark for today the dotted outline, the actual the blue column in
 * front, and the actual as a share of the target underneath. */
function GroupColumns({ rows, unit, targeted }) {
  const t = useTip();
  const max = Math.max(1, ...rows.flatMap((r) => [r.now, r.exp, r.bmExp].filter((v) => v !== null && v !== undefined))) * 1.05;
  const h = (v) => `${Math.max(0, Math.min(((v || 0) / max) * 100, 100))}%`;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${rows.length}, 1fr)`, gap: 10, alignItems: "end", height: 150 }}>
        {rows.map((r) => {
          const tip = { head: r.name, rows: [
            { label: `${unit} to date`, value: fmt(r.now) },
            ...(r.exp !== null && r.exp !== undefined ? [{ label: "Target today", value: fmt(r.exp) }] : []),
            ...(r.bmExp !== null && r.bmExp !== undefined ? [{ label: "Benchmark today", value: fmt(r.bmExp) }] : []),
            ...(r.target !== null && r.target !== undefined ? [{ label: "Target at the open", value: fmt(r.target) }] : []),
          ], body: r.off ? "Not in plan: no target and no benchmark for this channel." : undefined };
          return (
            <div key={r.key} {...t.props(tip)} style={{ position: "relative", height: "100%" }}>
              {targeted && r.exp > 0 && !r.off && <div style={{ position: "absolute", left: "6%", right: "6%", bottom: 0, height: h(r.exp), background: C.refBase, borderRadius: 4 }} />}
              {r.bmExp > 0 && !r.off && <div style={{ position: "absolute", left: "6%", right: "6%", bottom: 0, height: h(r.bmExp), border: `1.5px dotted ${C.refLine}`, borderBottom: "none", borderRadius: "4px 4px 0 0" }} />}
              <div style={{ position: "absolute", left: "27%", right: "27%", bottom: 0, height: h(r.now), background: C.blue, borderRadius: 3 }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${rows.length}, 1fr)`, gap: 10, marginTop: 8 }}>
        {rows.map((r) => {
          const pct = pctOf(r.now, r.exp);
          return (
            <div key={r.key} style={{ textAlign: "center", fontSize: 11.5, color: C.muted, lineHeight: 1.35 }}>
              <div style={{ color: C.ink, fontWeight: 600 }}>{r.name}</div>
              <div className="num">{fmt(r.now)}</div>
              {r.off ? <div>not in plan</div> : pct !== null && targeted ? <div className="num" style={{ color: pct >= 100 ? C.green : C.red }}>{pct}% of target</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the cards: signups */

function SignupsHero({ snap }) {
  const t = useTip();
  const hero = snap.hero || {};
  const targeted = !!snap.targeted;
  const now = hero.now ?? 0;
  const target = num(hero.target), exp = num(hero.expectedToday), bm = num(hero.benchmarkToday), bmFull = num(hero.benchmark);
  // before the announce the pace asks for nothing yet, so there is no delta to read
  const delta = exp !== null && exp > 0 ? now - exp : null;
  const unique = num(hero.unique);
  const pre = num(hero.preAnnounce) || 0;
  const tip = { head: "Signups to date", body: "Every signup event the feed tags to the release before the window opens, whatever the person's existing subscription, as the TL funnel export counts them" + (pre > 0 ? `; ${fmt(pre)} of them came before the announce` : "") + "." };
  const refRows = [
    ...(exp !== null ? [{ label: "Target today", value: fmt(exp) }] : []),
    ...(bm !== null ? [{ label: "Benchmark today", value: fmt(bm) }] : []),
    ...(target !== null ? [{ label: "Target at the open", value: fmt(target) }] : []),
    ...(bmFull !== null ? [{ label: "Benchmark at the open", value: fmt(bmFull) }] : []),
  ];
  return (
    <Card dot={GROUP_DOTS.volume} title={targeted ? "Signups vs target" : "Signups"}>
      <div className="spacer-8" />
      <div className="lead" {...t.props(tip, 300)}>
        {fmt(now)}
        {delta !== null && <span className="delta" style={{ color: delta >= 0 ? C.green : C.red }}>{fmtSigned(delta)}</span>}
        {delta !== null && <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>vs target today</span>}
      </div>
      <div className="lead-caption">{unique !== null && unique !== now ? `${fmt(unique)} people · ` : ""}{hero.daysToOpen > 0 ? `${hero.daysToOpen} days to the open` : "window open"}{pre > 0 ? ` · ${fmt(pre)} before the announce` : ""}</div>
      <div style={{ marginTop: 14 }}>
        <TrackBar now={now} target={exp ?? 0} bm={bm} full={target ?? 0} height={24} radius={5}
          tips={{ now: tip, target: { head: "Target today", rows: refRows }, base: { head: bm !== null && exp !== null && bm < exp ? "Benchmark today" : "Target today", rows: refRows },
                  stretch: { head: "Stretch", rows: refRows, body: "What the target asks for over the basket's median pace." } }} />
        <div style={{ position: "relative", height: 20, marginTop: 8, fontSize: 12, color: C.muted }}>
          <span style={{ position: "absolute", left: 0 }}>0</span>
          {target !== null && <span style={{ position: "absolute", right: 0 }}>signup target {fmt(target)}</span>}
        </div>
      </div>
      <div className="legend-rows">
        <div className="legend-row"><span className="swatch" style={{ background: C.blue }} /><span style={{ color: C.muted }}>To date</span><span className="val">{fmt(now)}</span></div>
        {exp !== null && <div className="legend-row"><span className="swatch" style={{ background: C.refBase }} /><span style={{ color: C.muted }}>Target today</span><span className="val">{fmt(exp)}</span></div>}
        {bm !== null && <div className="legend-row"><span className="swatch" style={{ background: "transparent", border: `1.5px dotted ${C.refLine}` }} /><span style={{ color: C.muted }}>Benchmark today</span><span className="val">{fmt(bm)}</span></div>}
        {hero.projected !== null && hero.projected !== undefined && targeted && (
          <div className="legend-row"><span className="swatch" style={{ background: C.blueLight }} /><span style={{ color: C.muted }}>On this pace, at the open</span><span className="val">{fmt(hero.projected)}</span></div>
        )}
      </div>
    </Card>
  );
}

function SignupsTrajectory({ snap }) {
  const days = (snap.signups || {}).byDay || [];
  const asOf = snap.asOf;
  const pts = days.map((d) => ({ x: d.date, actual: d.actual, plan: d.plan, bm: d.bm, dayToOpen: d.dayToOpen, signups: d.signups }));
  let todayIndex = pts.findIndex((p) => p.x === asOf);
  if (todayIndex < 0) todayIndex = pts.reduce((m, p, i) => (p.actual !== null && p.actual !== undefined ? i : m), -1);
  const label = (p) => fmtDay(new Date(p.x + "T00:00:00Z"));
  return (
    <Card wide dot={GROUP_DOTS.volume} title="Signup trajectory" right={<span>cumulative, from the announce to the open</span>}>
      <div className="spacer-8" />
      <PaceChart pts={pts} todayIndex={todayIndex} unit="signups" xLabel={label}
        hoverLabel={(p) => `${label(p)} · ${p.dayToOpen === 0 ? "the open" : `${-p.dayToOpen} days to the open`}${p.signups !== null && p.signups !== undefined ? ` · ${fmt(p.signups)} that day` : ""}`} />
    </Card>
  );
}

function SignupsByChannel({ snap }) {
  const groups = (snap.signups || {}).byGroup || [];
  const targeted = !!snap.targeted;
  const k = snap.targets && snap.targets.k;
  return (
    <Card dot={GROUP_DOTS.funnel} title={targeted ? "Signups by channel vs target" : "Signups by channel"}
      right={k ? <span title="The signup target over the basket's median: the uplift asked of every channel when the stretch is even">×{fmt(k, 2)} the basket</span> : null}>
      <div className="spacer-8" />
      <GroupColumns rows={groups} unit="Signups" targeted={targeted} />
      {(snap.signups || {}).untracked && (snap.signups.untracked.signups > 0) && (
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>{fmt(snap.signups.untracked.signups)} signups carry no channel (untracked) and are in the headline, not the columns.</div>
      )}
    </Card>
  );
}

function SessionsAndRate({ snap }) {
  const groups = (snap.signups || {}).byGroup || [];
  const row = { display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1fr", gap: 8, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}`, alignItems: "baseline" };
  const head = { ...row, color: C.muted, fontSize: 11.5, borderBottom: `1px solid ${C.border}` };
  const totalSess = groups.reduce((s, g) => s + (g.sessions || 0), 0);
  const totalSign = groups.reduce((s, g) => s + (g.now || 0), 0);
  return (
    <Card dot={GROUP_DOTS.funnel} title="Sessions and signup rate by channel">
      <div className="spacer-8" />
      <div style={head}><span>Channel</span><span className="num" style={{ textAlign: "right" }}>Sessions</span><span className="num" style={{ textAlign: "right" }}>Signups</span><span className="num" style={{ textAlign: "right" }}>Rate</span><span className="num" style={{ textAlign: "right" }}>Benchmark rate</span></div>
      {groups.map((g) => (
        <div key={g.key} style={row} title={g.sessionsNeeded ? `${fmt(g.sessionsNeeded)} sessions needed for this channel's signup target at the benchmark rate` : undefined}>
          <span style={{ color: g.off ? C.muted : C.ink }}>{g.name}{g.off ? " (not in plan)" : ""}</span>
          <span className="num" style={{ textAlign: "right" }}>{fmt(g.sessions)}</span>
          <span className="num" style={{ textAlign: "right" }}>{fmt(g.now)}</span>
          <span className="num" style={{ textAlign: "right", color: g.rate !== null && g.bmRate ? (g.rate >= g.bmRate ? C.green : C.red) : C.ink }}>{g.rate !== null && g.rate !== undefined ? fmtPct(g.rate, 1) : "–"}</span>
          <span className="num" style={{ textAlign: "right", color: C.muted }}>{g.bmRate ? fmtPct(g.bmRate, 1) : "–"}</span>
        </div>
      ))}
      <div style={{ ...row, borderBottom: "none", fontWeight: 600 }}>
        <span>All channels</span>
        <span className="num" style={{ textAlign: "right" }}>{fmt(totalSess)}</span>
        <span className="num" style={{ textAlign: "right" }}>{fmt(totalSign)}</span>
        <span className="num" style={{ textAlign: "right" }}>{totalSess > 0 ? fmtPct(totalSign / totalSess, 1) : "–"}</span>
        <span />
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>Sessions the feed names the release on; some launches carry fewer sessions than signups, so a rate over the benchmark can be a tagging gap rather than a conversion.</div>
    </Card>
  );
}

function EmailSends({ snap }) {
  const em = snap.email;
  const row = { display: "grid", gridTemplateColumns: "48px minmax(0, 1fr) 58px 44px 44px 50px", gap: 6, fontSize: 12, padding: "6px 0", borderBottom: `1px solid ${C.hairline}`, alignItems: "baseline" };
  const head = { ...row, color: C.muted, fontSize: 11, borderBottom: `1px solid ${C.border}` };
  const right = { textAlign: "right" };
  return (
    <Card dot={GROUP_DOTS.funnel} title="Email sends to signups" right={em && em.code ? <span>{em.code}</span> : null}>
      <div className="spacer-8" />
      {!em ? <div style={{ fontSize: 12.5, color: C.muted }}>No campaign code yet, so no sends can be matched. Set the code in Target setting.</div>
        : !em.sends.length ? <div style={{ fontSize: 12.5, color: C.muted }}>No marketing send under {em.code} in the pre-window yet{em.automated ? ` (${em.automated} automated sends: confirmations and welcomes)` : ""}.</div>
          : (
            <>
              <div style={head}><span>Sent</span><span>Send</span><span className="num" style={right}>Delivered</span><span className="num" style={right}>Opens</span><span className="num" style={right}>Clicks</span><span className="num" style={right}>Signups</span></div>
              {em.sends.map((s, i) => (
                <div key={i} style={row} title={`${s.name}: the AA Email signups on the send's day, every send of the day together`}>
                  <span className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(new Date(s.date + "T00:00:00Z"))}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name.replace(/^\d+_/, "")}</span>
                  <span className="num" style={right}>{fmt(s.delivered)}</span>
                  <span className="num" style={right}>{s.delivered > 0 ? fmtPct(s.opened / s.delivered) : fmt(s.opened)}</span>
                  <span className="num" style={right}>{s.delivered > 0 ? fmtPct(s.clicked / s.delivered, 1) : fmt(s.clicked)}</span>
                  <span className="num" style={right}>{fmt(s.signups)}</span>
                </div>
              ))}
              {em.totals && (
                <div style={{ ...row, borderBottom: "none", fontWeight: 600 }}>
                  <span /><span>{em.totals.sends} send{em.totals.sends === 1 ? "" : "s"}</span>
                  <span className="num" style={right}>{fmt(em.totals.delivered)}</span>
                  <span className="num" style={right}>{em.totals.delivered > 0 ? fmtPct(em.totals.opened / em.totals.delivered) : "–"}</span>
                  <span className="num" style={right}>{em.totals.delivered > 0 ? fmtPct(em.totals.clicked / em.totals.delivered, 1) : "–"}</span>
                  <span className="num" style={right}>{fmt(em.totals.signups)}</span>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>Signups are the AA Email channel's on each send's day, and the total over the pre-window{em.automated ? `; ${em.automated} automated sends (confirmations, welcomes) are left out` : ""}.</div>
            </>
          )}
    </Card>
  );
}

function PaidSignups({ snap }) {
  const p = snap.paid || {};
  const t = snap.targets || {};
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  const cps = num(p.costPerSignup), bmCps = num(p.bmCostPerSignup);
  const left = num(p.leftPre);
  return (
    <Card dot={GROUP_DOTS.paid} title="Paid signups and cost per signup" right={p.code ? <span title={p.codeSource === "guessed" ? "Guessed from the codes moving on Meta and in the sends - correct it in Target setting" : "The campaign code in force"}>{p.code}{p.codeSource === "guessed" ? " (guessed)" : ""}</span> : null}>
      <div className="spacer-8" />
      <div className="lead" title="Meta spend under the campaign code before the window opens">
        {fmtMoney(p.spendPre || 0)}
        {left !== null && <span className="delta" style={{ color: left >= 0 ? C.green : C.red }}>{left >= 0 ? `${fmtMoney(left)} left` : `${fmtMoney(-left)} over`}</span>}
      </div>
      <div className="lead-caption">spent before the open{p.budgetPre ? ` of a ${fmtMoney(p.budgetPre)} pre-window budget` : ""}</div>
      <div style={{ marginTop: 10 }}>
        <div style={row}><span style={{ color: C.muted }}>Paid signups (split touch)</span><span className="num">{fmt(p.signups || 0)}{p.signupsFolded && Math.round(p.signupsFolded) !== Math.round(p.signups) ? ` · ${fmt(p.signupsFolded)} with untracked folded in` : ""}</span></div>
        {t.paid_signups ? <div style={row}><span style={{ color: C.muted }}>Paid signup target{p.expSignups ? " · today" : ""}</span><span className="num">{fmt(t.paid_signups)}{p.expSignups ? ` · ${fmt(p.expSignups)}` : ""}</span></div> : null}
        <div style={row}><span style={{ color: C.muted }}>Cost per signup</span><span className="num" style={{ color: cps !== null && bmCps ? (cps <= bmCps ? C.green : C.red) : C.ink }}>{cps !== null ? fmtMoney(cps, 2) : "–"}{bmCps ? <span style={{ color: C.muted }}> · basket {fmtMoney(bmCps, 2)}</span> : null}</span></div>
        <div style={{ ...row, borderBottom: "none" }}><span style={{ color: C.muted }}>Share of signups paid</span><span className="num">{p.shareSignups !== null && p.shareSignups !== undefined ? fmtPct(p.shareSignups) : "–"}{p.bmShareSignups ? <span style={{ color: C.muted }}> · basket {fmtPct(p.bmShareSignups)}</span> : null}</span></div>
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }} title="The sales paid drives in the window are the window's business; the window budget is on the How the target is set card">
        The signups paid buys before the window{(p.campaigns || []).length ? `: ${p.campaigns.map((c) => c.name.replace(/^.*·\s*/, "")).join(", ")}` : ""}.
      </div>
    </Card>
  );
}

function HowTheTarget({ snap, onSetup }) {
  const t = snap.targets;
  const bm = snap.benchmark;
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  const src = { airtable: "Airtable", release: "typed", basket: "the basket", basket_mix: "the basket, by channel mix", default: "default", none: "none" };
  return (
    <Card dot={GROUP_DOTS.outcome} title="How the target is set">
      <div className="spacer-8" />
      {!t ? (
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>No units target: Airtable holds none for the ticked works and none is typed. Set one in Target setting and the signup target follows.</div>
      ) : (
        <div>
          <div style={row}><span style={{ color: C.muted }}>Units target ({src[t.units_target_source]})</span><span className="num">{fmt(t.units_target)}</span></div>
          <div style={row}><span style={{ color: C.muted }}>÷ pieces per order ({src[t.purchases_per_order_source]})</span><span className="num">{fmt(t.purchases_per_order, 2)} → {fmt(t.orders_needed)} orders</span></div>
          <div style={row}><span style={{ color: C.muted }}>÷ signup → order rate ({src[t.signup_order_rate_source]})</span><span className="num">{fmtPct(t.signup_order_rate, 1)} → {fmt(t.signup_target)} signups</span></div>
          <div style={{ ...row, borderBottom: "none" }} title={t.sessions_needed ? `${fmt(t.sessions_needed)} sessions needed at the benchmark rates` : undefined}>
            <span style={{ color: C.muted }}>Paid budget{t.sense_check_breached ? ", over the 6% sense check" : ""}</span>
            <span className="num" style={{ color: t.sense_check_breached ? C.amber : C.ink }}>{t.budget_total ? `${fmtMoney(t.budget_total)}${t.budget_pct_of_launch_value ? ` · ${fmtPct(t.budget_pct_of_launch_value, 1)} of launch value` : ""}` : "–"}</span>
          </div>
        </div>
      )}
      {bm && bm.basket && (
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginTop: 8 }} title={(bm.basket.members || []).join("\n") || undefined}>
          Benchmark: <b style={{ color: C.ink }}>{bm.basket.name}</b>, {bm.basket.n} launch{bm.basket.n === 1 ? "" : "es"}{bm.basket.thin ? ", thin" : ""}{bm.basket.fallback ? ", every window length" : ""}.
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={onSetup}>{snap.targeted ? "Target setting" : "Set up targets"}</button>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- the cards: sales */

function SalesHero({ snap }) {
  const t = useTip();
  const s = snap.sales || {};
  const now = s.units || 0;
  const target = num(s.unitsTarget), exp = num(s.expectedNow), bm = num(s.bmNow), bmFull = num(s.bmUnits);
  const delta = exp !== null ? now - exp : null;
  const refRows = [
    ...(exp !== null ? [{ label: "Target by now", value: fmt(exp) }] : []),
    ...(bm !== null ? [{ label: "Benchmark by now", value: fmt(bm) }] : []),
    ...(target !== null ? [{ label: "Units target", value: fmt(target) }] : []),
    ...(bmFull !== null ? [{ label: "Benchmark at the close", value: fmt(bmFull) }] : []),
  ];
  const st = snap.tlState;
  return (
    <Card dot={GROUP_DOTS.volume} title={target ? "Units sold vs target" : "Units sold"}>
      <div className="spacer-8" />
      <div className="lead" {...t.props({ head: "Units sold", body: s.note }, 300)}>
        {fmt(now)}
        {delta !== null && <span className="delta" style={{ color: delta >= 0 ? C.green : C.red }}>{fmtSigned(delta)}</span>}
        {delta !== null && <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>vs target {st === "window" ? "by now" : ""}</span>}
      </div>
      <div className="lead-caption">{fmt(s.orders || 0)} orders{s.piecesPerOrder ? ` · ${fmt(s.piecesPerOrder, 2)} pieces an order` : ""}{snap.hoursLeft !== null && snap.hoursLeft !== undefined ? ` · ${Math.ceil(snap.hoursLeft)} h left` : st === "settling" ? " · settling" : st === "closed" ? " · final" : ""}</div>
      <div style={{ marginTop: 14 }}>
        <TrackBar now={now} target={exp ?? 0} bm={bm} full={target ?? 0} height={24} radius={5}
          tips={{ now: { head: "Units sold", rows: [{ label: "Units", value: fmt(now) }] }, target: { head: "Target", rows: refRows }, base: { head: "Target", rows: refRows }, stretch: { head: "Stretch", rows: refRows } }} />
        <div style={{ position: "relative", height: 20, marginTop: 8, fontSize: 12, color: C.muted }}>
          <span style={{ position: "absolute", left: 0 }}>0</span>
          {target !== null && <span style={{ position: "absolute", right: 0 }}>target {fmt(target)}</span>}
        </div>
      </div>
      <div className="legend-rows">
        <div className="legend-row"><span className="swatch" style={{ background: C.blue }} /><span style={{ color: C.muted }}>Sold</span><span className="val">{fmt(now)}</span></div>
        {exp !== null && <div className="legend-row"><span className="swatch" style={{ background: C.refBase }} /><span style={{ color: C.muted }}>Target by now</span><span className="val">{fmt(exp)}</span></div>}
        {bm !== null && <div className="legend-row"><span className="swatch" style={{ background: "transparent", border: `1.5px dotted ${C.refLine}` }} /><span style={{ color: C.muted }}>Benchmark by now</span><span className="val">{fmt(bm)}</span></div>}
      </div>
    </Card>
  );
}

function SalesCurve({ snap }) {
  const s = snap.sales || {};
  const pts = (s.byHour || []).map((h) => ({ x: h.hour, actual: h.cum, plan: h.plan, bm: h.bm, sinceOpen: h.sinceOpen, units: h.units }));
  const todayIndex = pts.reduce((m, p, i) => (p.actual !== null && p.actual !== undefined ? i : m), -1);
  const H = snap.windowHours || 48;
  return (
    <Card wide dot={GROUP_DOTS.volume} title="Hourly sales curve vs pace" right={<span>cumulative units by hour since the sales open{snap.earlyAccessOpen ? ", early access first" : ""}</span>}>
      <div className="spacer-8" />
      <PaceChart pts={pts} todayIndex={todayIndex} unit="units" xLabel={(p) => `${Math.round(p.sinceOpen)}h`}
        hoverLabel={(p) => `${when(p.x)} · hour ${Math.round(p.sinceOpen)} of ${Math.round(H + (snap.earlyAccessOpen ? 24 : 0))}${p.units !== null && p.units !== undefined ? ` · ${fmt(p.units)} that hour` : ""}`} />
    </Card>
  );
}

function SalesByChannel({ snap }) {
  const s = snap.sales || {};
  const rows = (s.byGroup || []).map((g) => ({ key: g.key, name: g.name, now: g.units, exp: g.target, bmExp: g.bm, target: g.target, off: false }));
  return (
    <Card dot={GROUP_DOTS.funnel} title="Units by channel vs target">
      <div className="spacer-8" />
      <GroupColumns rows={rows} unit="Units" targeted={!!s.unitsTarget} />
      {s.untracked > 0 && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>{fmt(s.untracked)} units carry no channel and are in the headline, not the columns.</div>}
    </Card>
  );
}

function SalesOrders({ snap }) {
  const s = snap.sales || {};
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  const cpu = num(s.costPerSale), bm = num((snap.paid || {}).bmCostPerSale);
  return (
    <Card dot={GROUP_DOTS.paid} title="Orders, private room and paid sales">
      <div className="spacer-8" />
      <div style={row}><span style={{ color: C.muted }}>Orders</span><span className="num">{fmt(s.orders || 0)}</span></div>
      <div style={row}><span style={{ color: C.muted }}>Pieces per order</span><span className="num">{s.piecesPerOrder ? fmt(s.piecesPerOrder, 2) : "–"}</span></div>
      <div style={row}><span style={{ color: C.muted }}>Private-room units</span><span className="num">{s.private !== null && s.private !== undefined ? fmt(s.private) : "–"}</span></div>
      <div style={row}><span style={{ color: C.muted }}>Cancelled units</span><span className="num">{s.cancelled !== null && s.cancelled !== undefined ? fmt(s.cancelled) : "–"}</span></div>
      <div style={row}><span style={{ color: C.muted }}>Spend in the window</span><span className="num">{fmtMoney(s.spend || 0)}</span></div>
      <div style={row}><span style={{ color: C.muted }}>Paid units (split touch)</span><span className="num">{fmt(s.paidUnits || 0)}</span></div>
      <div style={{ ...row, borderBottom: "none" }}><span style={{ color: C.muted }}>Cost per sale</span><span className="num" style={{ color: cpu !== null && bm ? (cpu <= bm ? C.green : C.red) : C.ink }}>{cpu !== null ? fmtMoney(cpu) : "–"}{bm ? <span style={{ color: C.muted }}> · basket {fmtMoney(bm)}</span> : null}</span></div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>{s.note}</div>
    </Card>
  );
}

function SignupsOutcome({ snap }) {
  const hero = snap.hero || {};
  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.hairline}` };
  const sg = snap.signups || {};
  return (
    <Card dot={GROUP_DOTS.outcome} title="The pre-window: signups">
      <div className="spacer-8" />
      <div style={row}><span style={{ color: C.muted }}>Signups before the open</span><span className="num">{fmt(sg.preWindow || 0)}</span></div>
      {hero.target ? <div style={row}><span style={{ color: C.muted }}>Signup target</span><span className="num">{fmt(hero.target)}</span></div> : null}
      {hero.benchmark ? <div style={row}><span style={{ color: C.muted }}>Benchmark</span><span className="num">{fmt(hero.benchmark)}</span></div> : null}
      <div style={row}><span style={{ color: C.muted }}>Signups since the open</span><span className="num">{fmt(Math.max((sg.total || 0) - (sg.preWindow || 0), 0))}</span></div>
      <div style={{ ...row, borderBottom: "none" }}><span style={{ color: C.muted }}>Signups that converted (feed flag)</span><span className="num">{sg.converted !== null && sg.converted !== undefined ? `${fmt(sg.converted)} · ${sg.total > 0 ? fmtPct(sg.converted / sg.total, 1) : "–"}` : "–"}</span></div>
    </Card>
  );
}

/* ---------------------------------------------------------------- the overview */

export function TLOverview({ snap, onSetup }) {
  const st = snap.tlState;
  const sales = st === "window" || st === "settling" || st === "closed";
  return (
    <>
      <div style={{ marginTop: 4 }}><TLStrip snap={snap} /></div>
      {sales ? (
        <div className="grid" style={{ marginTop: 16 }}>
          <SalesHero snap={snap} />
          <SalesByChannel snap={snap} />
          <SalesCurve snap={snap} />
          <SalesOrders snap={snap} />
          <SignupsOutcome snap={snap} />
          <HowTheTarget snap={snap} onSetup={onSetup} />
          <div className="card ghost" style={{ display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>
            <span style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>Framing conversion, orders per product, multiples and awaiting payment come with the window build from the orders table.</span>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ marginTop: 16 }}>
          <SignupsHero snap={snap} />
          <SignupsByChannel snap={snap} />
          <SignupsTrajectory snap={snap} />
          <SessionsAndRate snap={snap} />
          <EmailSends snap={snap} />
          <PaidSignups snap={snap} />
          <HowTheTarget snap={snap} onSetup={onSetup} />
        </div>
      )}
    </>
  );
}

export default TLOverview;
