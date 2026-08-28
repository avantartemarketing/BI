/* Shared primitives for dashboard modules.
 * Chart conventions (design handoff, final):
 *  actual = solid #eb6834 · projection = dotted #f7c4ad · plan = grey dashed #c8c5bc
 *  target = ink 2px tick (or #b8b3a6 line) · expected tick on bars = white 2px + ink ring
 *  overshoot = 135° hatch · bar tracks run to 120% of reference, target tick at 83.3%.
 */
import React, { createContext, useContext, useMemo, useRef, useState } from "react";

/* ---- the popup system (agreed on the Dashboard Popups canvas) ----
 * One chrome, three tiers: chart readouts (inline, .chart-tip), element details
 * (this fixed singleton layer, 150ms, header + label/value rows ONLY - no prose),
 * methodology (same layer, 300ms, titled prose for ? badges).
 * Content: { head, rows?: [{ label, value, color? }], body? } */
const TipCtx = createContext(null);

export function TipProvider({ children }) {
  const [tip, setTip] = useState(null);
  const timer = useRef(null);
  const api = useMemo(() => ({
    show(el, content, delay) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.top < 160;
        setTip({
          x: Math.min(Math.max(r.left + r.width / 2, 140), window.innerWidth - 140),
          y: below ? r.bottom + 10 : r.top - 10,
          below, content,
        });
      }, delay);
    },
    hide() { clearTimeout(timer.current); setTip(null); },
  }), []);
  return (
    <TipCtx.Provider value={api}>
      {children}
      {tip && (
        <div className="sys-tip" style={{
          left: tip.x, top: tip.y,
          transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
        }}>
          {tip.content.head && <div className="t-head">{tip.content.head}</div>}
          {(tip.content.rows || []).map((r, i) => (
            <div className="t-row" key={i}>
              <span>{r.label}</span>
              <span className="v" style={r.color ? { color: r.color } : undefined}>{r.value}</span>
            </div>
          ))}
          {tip.content.body && <div className="t-body">{tip.content.body}</div>}
        </div>
      )}
    </TipCtx.Provider>
  );
}

export function useTip() {
  const ctx = useContext(TipCtx);
  return useMemo(() => ({
    props: (content, delay = 150) => (content && ctx ? {
      onMouseEnter: (e) => ctx.show(e.currentTarget, content, delay),
      onMouseLeave: ctx.hide,
    } : {}),
  }), [ctx]);
}


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

export function QBadge({ tip, content }) {
  const t = useTip();
  if (content) return <span className="qbadge" {...t.props(content, 300)}>?</span>;
  return <span className="qbadge" title={tip}>?</span>;
}

/* Horizontal bar on a vs-target track. The target tick sits at 83.3% (a
 * 120%-of-target track) unless a value would overflow - then the scale widens
 * so the largest bar fits with a little headroom and the tick slides left.
 * Layers: projected fill (light) -> to-date fill (orange) ->
 * expected tick (white + ink ring) -> target tick (ink). */
export function TrackBar({
  now, exp, proj, target, height = 20,
  tips = {}, radius = 4,
}) {
  const t = useTip();
  const tp = (x) => t.props(typeof x === "string" ? { head: x } : x);
  const TICK = 100 / 1.2; // 83.333
  const maxData = Math.max(now ?? 0, proj ?? 0, exp ?? 0);
  const maxV = Math.max(target > 0 ? target * 1.2 : 0, maxData * 1.04);
  const scale = maxV > 0 ? 100 / maxV : 0;
  const pct = (v) => Math.max(0, Math.min((v ?? 0) * scale, 100));
  const projW = pct(proj);
  const nowW = pct(now);
  const tickPct = target > 0 ? pct(target) : TICK;
  return (
    <div style={{ position: "relative", height, background: C.track, borderRadius: radius }}>
      <div {...tp(tips.proj)} style={{
        position: "absolute", inset: 0, width: `${projW}%`,
        background: C.orangeLight, borderRadius: radius,
      }} />
      <div {...tp(tips.now)} style={{
        position: "absolute", inset: 0, width: `${nowW}%`,
        background: C.orange, borderRadius: radius,
      }} />
      {exp !== undefined && exp !== null && (
        <div {...tp(tips.exp)} style={{
          position: "absolute", top: 0, bottom: 0, left: `calc(${pct(exp)}% - 1px)`, width: 2,
          background: C.white, boxShadow: "0 0 0 1px rgba(20,20,19,.45)",
        }} />
      )}
      <div {...tp(tips.target)} style={{
        position: "absolute", top: 0, bottom: 0, left: `calc(${tickPct}% - 1px)`, width: 2,
        background: C.ink,
      }} />
    </div>
  );
}

export function Lozenge({ dir, children, tip, content, color }) {
  const t = useTip();
  const cls = color || (dir === "up" ? "up" : dir === "down" ? "down" : "neutral");
  if (content) return <span className={`lozenge ${cls}`} {...t.props(content)}>{children}</span>;
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
