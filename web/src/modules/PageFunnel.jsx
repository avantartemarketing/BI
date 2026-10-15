/* Page funnel: the sessions through a release's pages, paid and organic,
 * against the basket (docs/DATA_MODEL.md 2.6; the Funnel view of the key
 * drivers card, KeyDrivers.jsx). Two steps, each read on each side:
 *   Release page → product page   of the sessions that saw the release page,
 *                                 the share that went on to a product page
 *   Product page → draw entry     of the sessions that saw a product page,
 *                                 the share that entered the draw
 * Four deviation rungs in the page's rung grammar (BENCHMARK_SPEC 7). A rate
 * is held at the benchmark, so the benchmark is the rung's centre line with
 * its dotted tick on it; the dot is the actual on the log scale where ×4
 * either way fills the rung; the printed figure and its RAG are against the
 * benchmark: green at or above it, amber less than 10% short, red 10% or more
 * short. The benchmark is the basket's median by the same point of its
 * launches' campaigns, over the members with enough sessions on the step
 * (pageFunnel.minSessions). A rung with too few sessions, or no benchmark to
 * read, is neutral: the first says how many sessions it has, the second
 * prints the rate itself where the gap would go.
 *
 * Paid is the paid channels; organic the four organic groups, Direct among
 * them whichever way the Overview's Direct switch is set; Untracked is on
 * neither side. The counts are sessions, keyed by the session's first page on
 * the release, so a session counts once on one side and one day. */
import React from "react";
import { C, fmt, fmtPct, fmtDay, MINUS, useTip, rungGeom, rungPos, RungTrack, RungKey, refWords } from "../ui.jsx";
import { Ex } from "../explain/Explain.jsx";

const SIDES = [{ key: "paid", name: "Paid" }, { key: "organic", name: "Organic" }];
export const STAGES = {
  clickThrough: { name: "Release page → product page", from: "Saw the release page", to: "Went on to a product page" },
  entry: { name: "Product page → draw entry", from: "Saw a product page", to: "Entered the draw" },
};

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const pct = (x) => (finite(x) ? fmtPct(x, 1) : "–");
const dayOf = (iso) => (iso ? fmtDay(new Date(String(iso).slice(0, 10) + "T00:00:00Z")) : null);

/* { sessions, through, rate, bm, bmN } -> the rung's render model. */
export function buildPageRung(x, pf) {
  const words = refWords("today");
  const min = pf.minSessions ?? 30;
  const base = { dev: 50, bmPos: null, beyond: false, rag: C.muted, neutral: true, up: false, delta: "–", relPct: null };
  const feedNote = pf.feedThrough && pf.through && String(pf.feedThrough) < String(pf.through)
    ? ` Page sessions run to ${dayOf(pf.feedThrough)}.` : "";
  if (!x || !finite(x.rate)) {
    const n = x ? x.sessions ?? 0 : 0;
    return { ...base, sub: n > 0 ? `${fmt(n)} session${n === 1 ? "" : "s"}` : "no sessions",
      body: `A rate is read over ${fmt(min)} sessions or more; this step has ${fmt(n)}.${feedNote}` };
  }
  const hasBm = finite(x.bm) && x.bm > 0;
  if (!hasBm) {
    return { ...base, sub: pct(x.rate), delta: pct(x.rate),
      body: (pf.bench
        ? `None of the basket's ${fmt(pf.basketN)} launches has ${fmt(min)} or more sessions on this step, so there is no benchmark to read against.`
        : "No basket on this page, so there is no benchmark to read against.") + feedNote };
  }
  const relPct = (x.rate / x.bm - 1) * 100;
  const geom = rungGeom(x.rate / x.bm) || {};
  return {
    neutral: false, up: relPct >= 0,
    dev: geom.dev ?? 50, bmPos: rungPos(1), beyond: !!geom.beyond,
    rag: relPct >= 0 ? C.green : relPct > -10 ? C.amber : C.red,
    delta: (relPct >= 0 ? "+" : MINUS) + Math.abs(Math.round(relPct)) + "%",
    relPct, sub: pct(x.rate),
    rows: [
      { label: words.bm, value: pct(x.bm) },
      { label: "Launches read", value: `${fmt(x.bmN)} of ${fmt(pf.basketN)}` },
      { label: "vs benchmark", value: (relPct >= 0 ? "+" : MINUS) + Math.abs(relPct).toFixed(1) + "%",
        color: relPct >= 0 ? C.green : relPct > -10 ? C.amber : C.red },
    ],
    body: `The benchmark is the basket's median by the same point of its launches' campaigns, over the launches with ` +
      `${fmt(min)} or more sessions on the step. A rate is held at the benchmark, so the benchmark is the centre line.${feedNote}`,
  };
}

function StageHead({ children }) {
  return (
    <div style={{ flex: "0 0 auto", fontSize: 11.5, fontWeight: 600, color: C.muted, whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
      {children}
    </div>
  );
}

function Rung({ side, stage, x, pf, bench }) {
  const tipApi = useTip();
  const r = buildPageRung(x, pf);
  const st = STAGES[stage];
  const tip = {
    head: `${side.name} · ${st.name}`,
    rows: [
      { label: st.from, value: fmt(x ? x.sessions ?? 0 : 0) },
      { label: st.to, value: fmt(x ? x.through ?? 0 : 0) },
      { label: "Actual", value: x && finite(x.rate) ? pct(x.rate) : "–" },
      ...(r.rows || []),
    ],
    body: r.body,
  };
  const figure = x && finite(x.rate) ? <Ex k="pages.rung" arg={{ side: side.key, stage }}>{r.delta}</Ex> : r.delta;
  return (
    <div {...tipApi.props(tip)}
      style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "128px 1fr 56px", gap: 10, alignItems: "center" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{side.name}</div>
        <div className="num" style={{ fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }}>{r.sub}</div>
      </div>
      <div style={{ position: "relative" }}>
        <RungTrack dev={r.dev} bmPos={r.bmPos} up={r.up} neutral={r.neutral} guide bench={bench} />
        {r.beyond && (
          /* the dot ran off the scale: say so at the end it ran off */
          <span style={{
            position: "absolute", top: -1, fontSize: 11, lineHeight: "12px", color: C.muted,
            ...(r.dev >= 96 ? { left: "calc(100% + 2px)" } : { right: "calc(100% + 2px)" }),
          }}>
            {r.dev >= 96 ? "›" : "‹"}
          </span>
        )}
      </div>
      <div className="num" style={{ fontSize: 13.5, fontWeight: 600, textAlign: "right", color: r.rag }}>{figure}</div>
    </div>
  );
}

export function PageFunnelView({ snap }) {
  const pf = snap?.pageFunnel;
  if (!pf) {
    return (
      <div className="empty-state">
        No page sessions yet: the pages feed has not been pulled since this page was built
      </div>
    );
  }
  const bench = !!pf.bench;
  return (
    <>
      {Object.entries(STAGES).map(([stage, st]) => (
        <React.Fragment key={stage}>
          <StageHead>{st.name}</StageHead>
          {SIDES.map((side) => (
            <Rung key={side.key} side={side} stage={stage} x={(pf[side.key] || {})[stage]} pf={pf} bench={bench} />
          ))}
        </React.Fragment>
      ))}
      <RungKey bench={bench} />
    </>
  );
}
