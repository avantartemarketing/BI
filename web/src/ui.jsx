/* Shared primitives for dashboard modules.
 * Chart conventions (design handoff, final):
 *  actual = solid #eb6834 · projection = dotted #f7c4ad · plan = grey dashed #c8c5bc
 *  target = ink 2px tick (or #b8b3a6 line) · expected tick on bars = white 2px + ink ring
 *  overshoot = 135° hatch · bar tracks run to 120% of reference, target tick at 83.3%.
 */
import React from "react";

export const C = {
  orange: "#eb6834", orangeLight: "#f7c4ad", rust: "#8f3415",
  track: "#ece9e1", ink: "#141413", muted: "#6c6b68", hairline: "#f2f0ea",
  planGrey: "#c8c5bc", targetLine: "#b8b3a6", border: "#e5e4df",
  green: "#0f7052", amber: "#8a5f00", red: "#b8461d", wfGreen: "#2f7d3f",
  periwinkle: "#a5b6e3", todayLine: "#eeece5", white: "#fffefb",
};

export const GROUP_DOTS = {
  volume: "#b8862d", funnel: "#4f6fc0", paid: "#eb6834", outcome: "#8a7a52",
};

export const MINUS = "−";

export function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const v = Number(n);
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return v < 0 ? MINUS + s : s;
}

export function fmtSigned(n, digits = 0) {
  if (n === null || n === undefined) return "–";
  return (n >= 0 ? "+" : MINUS) + fmt(Math.abs(n), digits);
}

export function fmtMoney(n, digits = 0) {
  if (n === null || n === undefined) return "–";
  return (n < 0 ? MINUS : "") + "£" + fmt(Math.abs(n), digits);
}

export function fmtK(n) {
  if (n === null || n === undefined) return "–";
  return Math.abs(n) >= 10000 ? fmt(n / 1000, 1) + "k" : fmt(n);
}

export function fmtPct(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return fmt(x * 100, digits) + "%";
}

export function ragColor(pct) {
  // sell-through style: ≥90 ink, ≥70 amber, else red
  if (pct >= 0.9) return C.ink;
  if (pct >= 0.7) return C.amber;
  return C.red;
}

export function Card({ tall, wide, dot, title, right, children, style }) {
  return (
    <div className={`card${tall ? " tall" : ""}${wide ? " wide" : ""}`} style={style}>
      <div className="mod-head">
        <span className="gdot" style={{ background: dot }} />
        <span className="title">{title}</span>
        {right ? <span className="right">{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function QBadge({ tip }) {
  return <span className="qbadge" title={tip}>?</span>;
}

/* Horizontal bar on the 120%-of-target track (target tick fixed at 83.3%).
 * Layers: projected fill (light) -> overshoot hatch past the target tick ->
 * to-date fill (orange) -> expected tick (white + ink ring) -> target tick (ink). */
export function TrackBar({
  now, exp, proj, target, height = 20,
  tips = {}, radius = 4,
}) {
  const TICK = 100 / 1.2; // 83.333
  const scale = target > 0 ? TICK / target : 0;
  const pct = (v) => Math.max(0, Math.min(v * scale, 100));
  const projW = pct(proj);
  const nowW = pct(now);
  const overshoot = proj > target && target > 0;
  const hatch = `repeating-linear-gradient(135deg, ${C.orange} 0 1.5px, ${C.orangeLight} 1.5px 5px)`;
  return (
    <div style={{ position: "relative", height, background: C.track, borderRadius: radius }}>
      <div title={tips.proj} style={{
        position: "absolute", inset: 0, width: `${projW}%`,
        background: C.orangeLight, borderRadius: radius,
      }} />
      {overshoot && (
        <div title={tips.overshoot} style={{
          position: "absolute", top: 0, bottom: 0, left: `${TICK}%`,
          width: `${Math.max(projW - TICK, 0)}%`, background: hatch,
        }} />
      )}
      <div title={tips.now} style={{
        position: "absolute", inset: 0, width: `${nowW}%`,
        background: C.orange, borderRadius: radius,
      }} />
      {exp !== undefined && exp !== null && (
        <div title={tips.exp} style={{
          position: "absolute", top: 0, bottom: 0, left: `calc(${pct(exp)}% - 1px)`, width: 2,
          background: C.white, boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
        }} />
      )}
      <div title={tips.target} style={{
        position: "absolute", top: 0, bottom: 0, left: `calc(${TICK}% - 1px)`, width: 2,
        background: C.ink,
      }} />
    </div>
  );
}

export function Lozenge({ dir, children, tip, color }) {
  const cls = color || (dir === "up" ? "up" : dir === "down" ? "down" : "neutral");
  return <span className={`lozenge ${cls}`} title={tip}>{children}</span>;
}

export async function postDecision(payload) {
  try {
    const res = await fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
