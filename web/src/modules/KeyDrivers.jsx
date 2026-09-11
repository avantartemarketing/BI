/* Organic funnel / funnel key drivers (spec §4.5, LE relabel per §6; rung
 * grammar per BENCHMARK_SPEC 7). Three-state seg: Funnel (default) | Adding |
 * Costing. Always the Today horizon, so the page toggle is accepted and
 * ignored (BENCHMARK_SPEC 2).
 *
 * Funnel - the organic funnel at a grouped level (the four non-paid display
 * groups combined) as deviation rungs, per the agreed design:
 *   Top of funnel  - emails delivered + posts/stories; no reference yet, so the
 *                    rung is neutral and the counts live in the hover popup
 *   Mid funnel     - sessions, a volume: the target carries the even uplift, so
 *                    its ring sits at ×K off the benchmark centre
 *   Low funnel     - session → entry conversion, a rate held at the benchmark
 *                    (entry-weighted: Σ sessions×conv / Σ sessions on each
 *                    side, benchmark sessions weighting the benchmark side)
 * The rung reads benchmark-first - cobalt centre line = benchmark, hollow ink
 * ring = target, dot = actual, on a log scale where ×4 either way fills it -
 * but the printed figure and its RAG stay vs TARGET, unchanged in meaning, so
 * the card still answers "are we on plan". With no basket the plan stands in as
 * the rung centre, the ring lands on it and the centre line goes back to
 * neutral grey.
 *
 * Adding | Costing - per-group step contributions from funnelByGroup, top 4 by
 * |value| of the chosen sign. Methodology notes live in tooltips only. */
import React from "react";
import { Card, GROUP_DOTS, C, fmt, fmtSigned, MINUS, useTip, rungGeom, RungTrack } from "../ui.jsx";

const GROUPS = [
  { key: "aa_email", name: "AA Email", short: "Email" },
  { key: "aa_social", name: "AA Meta", short: "Meta" },
  { key: "referral_artist", name: "Referral artist", short: "Referral" },
  { key: "search_direct_other", name: "Search / direct / other", short: "Search" },
  { key: "paid", name: "Paid", short: "Paid" },
];
const ORGANIC = ["aa_email", "aa_social", "referral_artist", "search_direct_other"];

const NOTE =
  "Each step's contribution is repriced one-at-a-time vs plan; together the steps sum to the gap vs expected today.";
const RING = "0 0 0 1px rgba(20,20,19,.45)";
const GUIDE = "#ddd9cf";

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const usable = (v) => finite(v) && v !== 0;

/* RungTrack without the cobalt: with no basket there is no benchmark to name
 * (BENCHMARK_SPEC 7), so the centre goes back to the neutral grey guide that
 * ties the three tiers together. Same rail, bar, dot and ring otherwise. */
function PlainRung({ dev, ring, up, neutral }) {
  return (
    <div style={{ position: "relative", height: 12 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: C.hairline }} />
      <div style={{ position: "absolute", left: "50%", top: -14, bottom: -14, width: 1, marginLeft: -0.5, background: GUIDE }} />
      {!neutral && (
        <div style={{
          position: "absolute", top: 5, height: 4, left: `${Math.min(dev, ring)}%`,
          width: `${Math.abs(dev - ring)}%`,
          background: up ? "#f7c4ad" : "#eeb9a3", borderRadius: 2,
        }} />
      )}
      <div style={{
        position: "absolute", left: `${neutral ? 50 : dev}%`, top: 1, width: 10, height: 10,
        marginLeft: -5, borderRadius: "50%",
        background: neutral ? "#c8c5bc" : up ? C.orange : C.red, boxShadow: RING,
      }} />
      {!neutral && (
        <div style={{
          position: "absolute", left: `${ring}%`, top: 0, width: 12, height: 12,
          marginLeft: -6, borderRadius: "50%", border: `1.5px solid ${C.ink}`,
          background: "transparent", boxSizing: "border-box",
        }} />
      )}
    </div>
  );
}

function FunnelRung({ tier, metric, r, bench, tip }) {
  const tipApi = useTip();
  return (
    <div
      {...tipApi.props(tip)}
      style={{
        flex: 1, minHeight: 0, display: "grid",
        gridTemplateColumns: "128px 1fr 56px", gap: 10, alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{tier}</div>
        <div style={{ fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" }}>{metric}</div>
      </div>
      <div style={{ position: "relative" }}>
        {bench
          ? <RungTrack dev={r.dev} ring={r.ring} up={r.up} neutral={r.neutral} guide />
          : <PlainRung dev={r.dev} ring={r.ring} up={r.up} neutral={r.neutral} />}
        {r.beyond && (
          /* the dot ran off the scale - say so at the end it ran off, rather
             than letting it pile up silently against the clamp */
          <span style={{
            position: "absolute", top: -1, fontSize: 11, lineHeight: "12px", color: C.muted,
            ...(r.dev >= 96 ? { left: "calc(100% + 2px)" } : { right: "calc(100% + 2px)" }),
          }}>
            {r.dev >= 96 ? "›" : "‹"}
          </span>
        )}
      </div>
      <div className="num" style={{ fontSize: 13.5, fontWeight: 600, textAlign: "right", color: r.rag }}>
        {r.delta}
      </div>
    </div>
  );
}

/* The rung grammar in four marks, so nobody has to guess what the ring is.
 * It has to hold one line inside a 400px card (350px of content): in Inter at
 * 11.5px the three items and the note measure ~300px, which leaves room. The
 * cobalt mark is dropped with no basket, exactly as the rung drops it. */
function RungKey({ bench }) {
  const item = {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 11.5, color: C.muted, whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 18px", marginTop: 6 }}>
      <span style={item}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", flex: "0 0 10px",
          background: C.orange, boxShadow: RING,
        }} />
        Actual
      </span>
      <span style={item}>
        <span style={{
          width: 12, height: 12, borderRadius: "50%", flex: "0 0 12px",
          border: `1.5px solid ${C.ink}`, boxSizing: "border-box",
        }} />
        Target
      </span>
      {bench && (
        <span style={item}>
          <span style={{ width: 12, height: 2, background: C.cobalt, flex: "0 0 12px" }} />
          Benchmark
        </span>
      )}
      <span style={{ ...item, marginLeft: "auto" }}>×4 fills the rung</span>
    </div>
  );
}

/* { v, bm, plan, kind } -> render model. The benchmark is the rung centre when
 * a basket exists; the target is bm × K on a volume and bm itself on a rate.
 * Without a basket the plan is both, which puts the ring on the centre line. */
function buildRung({ v, bm, plan, kind }, bench, k) {
  const useBm = bench && usable(bm);
  const ref = useBm ? bm : plan;
  if (!finite(v) || !usable(ref)) {
    return { neutral: true, dev: 50, ring: 50, beyond: false, rag: C.muted, delta: "–", target: null, relPct: null };
  }
  const gKind = useBm && kind === "vol" ? "vol" : "rate";
  const target = ref * (gKind === "vol" && k > 0 ? k : 1);
  const relPct = (v / target - 1) * 100;
  const geom = rungGeom(v / ref, gKind, k) || {};
  return {
    neutral: false,
    up: relPct >= 0,
    dev: geom.dev ?? 50,
    ring: geom.ring ?? 50,
    beyond: !!geom.beyond,
    rag: relPct >= 0 ? C.green : relPct > -10 ? C.amber : C.red,
    delta: (relPct >= 0 ? "+" : MINUS) + Math.abs(Math.round(relPct)) + "%",
    target, relPct, useBm, benchmark: ref,
  };
}

function FunnelView({ snap }) {
  const fbg = snap?.funnelByGroup || {};
  const email = snap?.email || {};
  const social = snap?.social || {};
  const targeted = snap?.targeted !== false;
  const bench = !!snap?.benchmark;
  const k = snap?.benchmark?.k ?? 1;
  const bmConv = snap?.benchmark?.convByGroup || {};

  /* Sessions take the per-group benchmark the ETL pro-rated to today rather
   * than benchmark.sessionsByGroup, which is the at-close figure. The
   * benchmark conversion is entry-weighted by benchmark sessions, so the low
   * funnel compares like with like on both sides. */
  let sessA = 0, sessE = 0, sessB = 0, entA = 0, entE = 0, entB = 0;
  for (const key of ORGANIC) {
    const g = fbg[key];
    if (!g) continue;
    const sa = g.sessions_actual ?? 0, se = g.sessions_expected ?? 0;
    sessA += sa; sessE += se;
    entA += sa * (g.conv_actual ?? 0);
    entE += se * (g.conv_expected ?? 0);
    const sb = g.sessions_benchmark ?? null;
    if (finite(sb)) {
      sessB += sb;
      entB += sb * (g.conv_benchmark ?? bmConv[key] ?? 0);
    }
  }
  const convA = sessA > 0 ? entA / sessA : null;
  const convE = sessE > 0 ? entE / sessE : null;
  const convB = sessB > 0 ? entB / sessB : null;

  const midR = buildRung({ v: sessA, bm: sessB || null, plan: sessE, kind: "vol" }, bench, k);
  const lowR = buildRung({ v: convA, bm: convB, plan: convE, kind: "rate" }, bench, k);

  const posts = (social.posts ?? 0) + (social.stories ?? 0);
  const pctTxt = (x) => (x === null || x === undefined ? "–" : fmt(x * 100, 1) + "%");
  const relRow = (r) => (r.relPct === null ? [] : [{
    label: "vs target",
    value: (r.relPct >= 0 ? "+" : MINUS) + Math.abs(r.relPct).toFixed(1) + "%",
    color: r.rag,
  }]);
  const bmRow = (r, show) => (r.useBm ? [{ label: "Benchmark today", value: show(r.benchmark), color: C.cobalt }] : []);

  return (
    <>
      <FunnelRung
        tier="Top of funnel" metric="Emails + posts" bench={bench}
        r={{ neutral: true, dev: 50, ring: 50, beyond: false, rag: C.muted, delta: "–" }}
        tip={{
          head: "Top of funnel",
          rows: [
            { label: "Emails delivered", value: fmt(email.delivered ?? null) },
            { label: "Posts + stories", value: fmt(posts) },
            { label: "Target", value: "–" },
          ],
        }}
      />
      <FunnelRung
        tier="Mid funnel" metric="Sessions" r={midR} bench={bench}
        tip={{
          head: "Mid funnel · Sessions",
          body: midR.useBm
            ? `Sessions carry the even uplift, so the target is the benchmark × K (${fmt(k, 2)}).`
            : undefined,
          rows: [
            { label: "Actual", value: fmt(sessA) },
            ...bmRow(midR, (x) => fmt(x)),
            { label: "Target today", value: targeted ? fmt(midR.target ?? sessE) : "– (no targets)" },
            ...relRow(midR),
          ],
        }}
      />
      <FunnelRung
        tier="Low funnel" metric="Session → entry" r={lowR} bench={bench}
        tip={{
          head: "Low funnel · Session → entry",
          body: lowR.useBm
            ? "Conversion is held at the benchmark, so the target and the benchmark are one line."
            : undefined,
          rows: [
            { label: "Actual", value: pctTxt(convA) },
            ...bmRow(lowR, pctTxt),
            { label: "Target today", value: targeted ? pctTxt(lowR.target ?? convE) : "– (no targets)" },
            ...relRow(lowR),
          ],
        }}
      />
      <RungKey bench={bench} />
    </>
  );
}

/* `horizon` is accepted and ignored: this card is always the Today horizon
 * (BENCHMARK_SPEC 2), so the page toggle must not reach it. */
export default function KeyDrivers({ snap, horizon }) {
  const tipApi = useTip();
  const [view, setView] = React.useState("funnel"); // 'funnel' | 'pos' | 'neg'
  React.useEffect(() => setView("funnel"), [snap?.id]);

  const fbg = snap?.funnelByGroup || {};
  const isPos = view === "pos";

  const all = [];
  GROUPS.forEach((g) => {
    const f = fbg[g.key];
    if (!f) return;
    all.push({ ...g, step: "Traffic", v: f.contrib_traffic ?? 0 });
    all.push({ ...g, step: "Conversion", v: f.contrib_conversion ?? 0 });
  });
  const rows = all
    .filter((r) => (isPos ? r.v > 0 : r.v < 0))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 4);

  return (
    <Card
      dot={GROUP_DOTS.funnel}
      title={view === "funnel" ? "Organic funnel" : "Funnel key drivers"}
      right={
        <span className="seg">
          <button
            className={view === "funnel" ? "active" : ""}
            title="Organic funnel at a grouped level: benchmark centre, target ring, actual dot"
            onClick={() => setView("funnel")}
          >
            Funnel
          </button>
          <button
            className={view === "pos" ? "active" : ""}
            title={"Steps adding units vs expected\n" + NOTE}
            onClick={() => setView("pos")}
          >
            Adding
          </button>
          <button
            className={view === "neg" ? "active" : ""}
            title={"Steps costing units vs expected\n" + NOTE}
            onClick={() => setView("neg")}
          >
            Costing
          </button>
        </span>
      }
    >
      <div className="spacer-16" />
      <div className="body">
        {view === "funnel" ? (
          <FunnelView snap={snap} />
        ) : rows.length === 0 ? (
          <div className="empty-state">
            {snap?.targeted === false
              ? "Needs targets - the steps are measured against the plan"
              : isPos ? "No steps adding units vs expected yet" : "No steps costing units vs expected"}
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r.key + r.step}
              style={{
                flex: 1, minHeight: 0, display: "grid",
                gridTemplateColumns: "20px 1fr 56px", gap: 12,
                alignItems: "center", borderTop: `1px solid ${C.hairline}`,
              }}
            >
              <div className="num" style={{ fontSize: 12, color: C.muted }}>{i + 1}</div>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`chan-loz ${r.key}`} style={{ flexShrink: 0 }}>{r.short}</span>
                <span style={{ fontSize: 13, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.step}
                </span>
              </div>
              <div
                className="num"
                {...tipApi.props({
                  head: `${r.name} · ${r.step}`,
                  rows: [{ label: "vs expected today", value: fmtSigned(r.v, 1) + " units", color: r.v >= 0 ? "#0f7052" : "#b8461d" }],
                })}
                style={{
                  fontSize: 13.5, fontWeight: 600, textAlign: "right",
                  color: r.v > 0 ? C.green : C.red,
                }}
              >
                {fmtSigned(r.v, 1)}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
