/* Entries vs targets — hero module (spec §4.1, LE relabel per §6).
 * Single 24px bar on the shared 120%-of-target track: projected fill,
 * overshoot hatch past the target tick, to-date fill, expected + target ticks.
 * All methodology lives in title tooltips, never captions. */
import React from "react";
import { Card, TrackBar, GROUP_DOTS, C, fmt, fmtSigned, MINUS } from "../ui.jsx";

const HATCH = `repeating-linear-gradient(135deg, ${C.orange} 0 1.5px, ${C.orangeLight} 1.5px 5px)`;
const TICK = 100 / 1.2; // target tick at 83.333% of the track

export default function HeroBar({ snap }) {
  const hero = snap?.hero || {};
  const now = hero.now ?? 0;
  const exp = hero.expectedToday ?? 0;
  const proj = hero.projected ?? 0;
  const target = hero.target ?? 0;
  const delta = hero.delta ?? now - exp;
  const day = snap?.day;

  const over = proj - target;
  const overPct = target > 0 ? Math.round((proj / target - 1) * 100) : null;
  const projTip =
    `Projected ${fmt(proj)} at close` +
    (overPct === null
      ? ""
      : overPct > 0
      ? ` — ${overPct}% over target`
      : overPct < 0
      ? ` — ${Math.abs(overPct)}% under target`
      : " — on target");

  // expected tick position on the shared track scale (for the floating label)
  const expPct = target > 0 ? Math.min((exp / target) * TICK, 100) : 0;
  const showExp = exp > 0 && target > 0;

  return (
    <Card dot={GROUP_DOTS.volume} title="Entries vs targets">
      <div className="spacer-8" />
      <div className="lead">
        {fmt(now)}
        <span className="delta" style={{ color: delta >= 0 ? C.ink : C.red }}>
          {fmtSigned(delta)}
        </span>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          vs today
        </span>
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ position: "relative", height: 20, marginBottom: 8 }}>
          {showExp && (
            <div
              style={{
                position: "absolute", left: `${expPct}%`, bottom: 0,
                transform: "translateX(-50%)", maxWidth: "100%",
                fontSize: 12, color: C.muted, whiteSpace: "nowrap",
              }}
            >
              expected {fmt(exp)}
            </div>
          )}
        </div>

        <TrackBar
          now={now}
          exp={showExp ? exp : null}
          proj={proj}
          target={target}
          height={24}
          tips={{
            proj: projTip,
            now: `${fmt(now)} entries to date`,
            exp: `${fmt(exp)} expected by day ${day}`,
            overshoot: `Beyond target ${MINUS} ${fmt(over)} entries of overshoot`,
            target: `Target ${fmt(target)} at close`,
          }}
        />

        <div style={{ position: "relative", height: 20, marginTop: 8 }}>
          <div style={{ position: "absolute", left: 0, top: 4, fontSize: 12, color: C.muted }}>0</div>
          <div style={{ position: "absolute", right: 0, top: 4, fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>
            target {fmt(target)}
          </div>
        </div>
      </div>

      <div className="legend-rows">
        <div className="legend-row">
          <span className="swatch" style={{ background: C.orange }} />
          <span style={{ color: C.muted }}>To date</span>
          <span className="val">{fmt(now)}</span>
        </div>
        <div className="legend-row">
          <span className="swatch" style={{ background: C.orangeLight }} />
          <span style={{ color: C.muted }}>Projected at close</span>
          <span className="val">{fmt(proj)}</span>
        </div>
        <div className="legend-row">
          <span className="swatch" style={{ background: HATCH }} />
          <span style={{ color: C.muted }}>{over >= 0 ? "Over target" : "Under target"}</span>
          <span className="val">{fmtSigned(over)}</span>
        </div>
      </div>
    </Card>
  );
}
