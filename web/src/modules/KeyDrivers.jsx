/* Organic funnel / funnel key drivers (spec §4.5, LE relabel per §6). Three-state
 * seg: Funnel (default) | Adding | Costing. Always the Today horizon, so the page
 * toggle is accepted and ignored.
 *
 * Funnel - the organic funnel at a grouped level (the four non-paid display
 * groups combined) as deviation rungs, per the agreed design:
 *   Top of funnel  - emails delivered + posts/stories; no reference yet, so the
 *                    rung is neutral and the counts live in the hover popup
 *   Mid funnel     - sessions, a volume: the target carries the even uplift, so
 *                    reading against the target puts the centre at benchmark × K
 *   Low funnel     - session → entry conversion, a rate held at the benchmark
 *                    (entry-weighted: Σ sessions×conv / Σ sessions on each
 *                    side, benchmark sessions weighting the benchmark side)
 * The target is the centre line, the dot is the actual on a log scale where ×4
 * either way fills the rung, and the benchmark is a dotted tick wherever the
 * basket's own figure lands on the same scale - the rung's form of the dotted
 * outline every bar carries (BENCHMARK_SPEC 7). The printed figure and its RAG
 * are against the target. With no basket the plan is the centre, the line goes
 * to the neutral plan grey and there is no tick.
 *
 * Adding | Costing - per-group step contributions from funnelByGroup, top 4 by
 * |value| of the chosen sign. Methodology notes live in tooltips only. */
import React from "react";
import {
  Card, GROUP_DOTS, C, fmt, fmtSigned, MINUS, useTip, rungGeom, rungPos, RungTrack, RungKey,
  refWords,
} from "../ui.jsx";
import { Ex } from "../explain/Explain.jsx";

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

const finite = (v) => v !== null && v !== undefined && Number.isFinite(v);
const usable = (v) => finite(v) && v !== 0;

function FunnelRung({ tier, metric, r, bench, tip, x }) {
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
        <RungTrack dev={r.dev} bmPos={r.bmPos} up={r.up} neutral={r.neutral} guide bench={bench} />
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
        {x && !r.neutral ? <Ex k="funnel.rung" arg={x}>{r.delta}</Ex> : r.delta}
      </div>
    </div>
  );
}

/* { v, bm, plan, kind } -> render model. The target is the rung centre: the
 * benchmark × K on a volume and the benchmark itself on a rate, or the plan
 * where there is no basket. The benchmark's tick is placed on the same log
 * scale, so on a rate rung it sits on the centre line and on a volume rung it
 * sits 1/K off it. */
function buildRung({ v, bm, plan, kind }, bench, k) {
  const bmv = bench && usable(bm) ? bm : null;
  const target = bmv !== null ? bmv * (kind === "vol" && k > 0 ? k : 1) : plan;
  if (!finite(v) || !usable(target)) {
    return { neutral: true, dev: 50, bmPos: null, beyond: false, rag: C.muted, delta: "–", target: null, bm: null, relPct: null };
  }
  const relPct = (v / target - 1) * 100;
  const geom = rungGeom(v / target) || {};
  return {
    neutral: false,
    up: relPct >= 0,
    dev: geom.dev ?? 50,
    bmPos: bmv !== null ? rungPos(bmv / target) : null,
    beyond: !!geom.beyond,
    rag: relPct >= 0 ? C.green : relPct > -10 ? C.amber : C.red,
    delta: (relPct >= 0 ? "+" : MINUS) + Math.abs(Math.round(relPct)) + "%",
    target, bm: bmv, relPct,
  };
}

function FunnelView({ snap }) {
  const words = refWords("today");
  const fbg = snap?.funnelByGroup || {};
  const email = snap?.email || {};
  const social = snap?.social || {};
  const targeted = snap?.targeted !== false;
  const bench = !!snap?.benchmark;
  const k = snap?.benchmark?.k ?? 1;
  const bmConv = snap?.benchmark?.convByGroup || {};

  /* Sessions take the per-group benchmark the ETL pro-rated to today rather
   * than benchmark.sessionsByGroup, which is the at-close figure, and the
   * conversion is the basket's by today as well (conv_benchmark_today, the
   * figure the waterfalls walk against; the at-close conv_benchmark is the
   * fallback for an older snapshot), because a basket's sessions come earlier
   * than its units and its conversion by today sits well under its conversion
   * at close. The benchmark conversion is entry-weighted by benchmark
   * sessions, so the low funnel compares like with like on both sides. */
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
      entB += sb * (g.conv_benchmark_today ?? g.conv_benchmark ?? bmConv[key] ?? 0);
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
  // both references, the target first because the figure is judged against it
  const refRows = (r, show) => [
    ...(r.target === null ? [] : [{ label: words.target, value: show(r.target) }]),
    ...(r.bm === null || r.bm === undefined ? [] : [{ label: words.bm, value: show(r.bm) }]),
  ];

  return (
    <>
      <FunnelRung
        tier="Top of funnel" metric="Emails + posts" bench={bench}
        r={{ neutral: true, dev: 50, bmPos: null, beyond: false, rag: C.muted, delta: "–" }}
        tip={{
          head: "Top of funnel",
          rows: [
            { label: "Emails delivered", value: fmt(email.delivered ?? null) },
            { label: "Posts + stories", value: fmt(posts) },
            { label: words.target, value: "–" },
          ],
        }}
      />
      <FunnelRung
        tier="Mid funnel" metric="Sessions" r={midR} bench={bench}
        x={{ card: "Organic funnel", group: "Organic channels", label: "Sessions", kind: "vol", unit: "count",
             v: sessA, target: midR.target, bm: midR.bm, k,
             note: "The four organic channels together: AA Email, AA Meta, Artist and Direct etc." }}
        tip={{
          head: "Mid funnel · Sessions",
          body: bench
            ? `Sessions carry the even uplift, so the target is the benchmark × K (${fmt(k, 2)}).`
            : undefined,
          rows: [
            { label: "Actual", value: fmt(sessA) },
            ...(targeted ? refRows(midR, (x) => fmt(x)) : [{ label: words.target, value: "– (no targets)" }]),
            ...relRow(midR),
          ],
        }}
      />
      <FunnelRung
        tier="Low funnel" metric="Session → entry" r={lowR} bench={bench}
        x={{ card: "Organic funnel", group: "Organic channels", label: "Session → entry", kind: "rate", unit: "%",
             v: convA === null ? null : convA * 100, target: lowR.target === null ? null : lowR.target * 100,
             bm: lowR.bm === null || lowR.bm === undefined ? null : lowR.bm * 100, k,
             note: "Units secured per session on the four organic channels together, each channel weighted by its sessions." }}
        tip={{
          head: "Low funnel · Session → entry",
          body: bench
            ? "Conversion is held at the benchmark, so the target and the benchmark are the same figure."
            : undefined,
          rows: [
            { label: "Actual", value: pctTxt(convA) },
            ...(targeted ? refRows(lowR, pctTxt) : [{ label: words.target, value: "– (no targets)" }]),
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
            title="Organic funnel at a grouped level: target down the centre, benchmark as a dotted tick, actual as a dot"
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
                <Ex k="drivers.step" arg={{ key: r.key, step: r.step }}>{fmtSigned(r.v, 1)}</Ex>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
