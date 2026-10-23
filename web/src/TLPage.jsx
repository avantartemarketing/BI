/* The timed-launch page's own card (docs/TL_SPEC.md 4, 5, 9): what the
 * pre-window's signups turned into once the window has opened. The cards
 * are otherwise the LE cards in the state's words (web/src/vocab.mjs). The
 * figures are the snapshot's signups block and the hero's signup target
 * and benchmark; the header's chips and the clock strip live in
 * ReleasePage.jsx. */
import React from "react";
import { Card, Head, vsDelta } from "./ui.jsx";
import { fmt, fmtPct } from "./format.mjs";
import { People, Target, Bmk, Basket } from "./icons.jsx";

const has = (v) => v !== null && v !== undefined;

export function TLSignupsOutcome({ snap }) {
  const hero = snap.hero || {};
  const sg = snap.signups || {};
  const pre = sg.preWindow || 0;
  const since = Math.max((sg.total || 0) - pre, 0);
  const rows = [
    { icon: <People />, l: "Signups before the open", v: fmt(pre), tip: "Every signup for the launch from the announce to the sales open" },
    ...(hero.target ? [{ icon: <Target />, l: "Signup target", v: fmt(hero.target), tip: "The pre-window signup target: the units target at the basket's signup to order rate" }] : []),
    ...(hero.benchmark ? [{ icon: <Bmk />, l: "Benchmark", v: fmt(hero.benchmark), tip: "The basket's median pre-window signups" }] : []),
    { icon: <People />, l: "Signups since the open", v: fmt(since), tip: "Signups made after the sales open" },
    { icon: <Basket w={14} />, l: "Signups that ordered", v: has(sg.converted) ? `${fmt(sg.converted)} · ${sg.total > 0 ? fmtPct(sg.converted / sg.total, 1) : "–"}` : "–", tip: "Signups the feed flags as converted, and their share of all signups" },
  ];
  return (
    <Card title="Signups to outcome" aria="Signups to outcome">
      <Head v={fmt(pre)} u="signups before the open" deltas={[vsDelta(pre, hero.target, "target", `${fmt(pre)} signups against the ${fmt(hero.target)} target at the open`)]} />
      <div style={{ marginTop: 2 }}>
        {rows.map((r) => (
          <div className="prow" key={r.l} title={r.tip}>
            <span className="ic">{r.icon}</span><span className="l">{r.l}</span><span className="v">{r.v}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default TLSignupsOutcome;
