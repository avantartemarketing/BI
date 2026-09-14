/* Organic funnel / funnel key drivers (spec §4.5, LE relabel per §6). Three-state
 * seg: Funnel (default) | Adding | Costing. Always the Today horizon, so the page
 * horizon toggle is accepted and ignored; the page REFERENCE toggle is followed
 * like everywhere else.
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
 * One reference, so one centre line: whichever of the two the page is read
 * against, with the dot at the actual on a log scale where ×4 either way fills
 * the rung, and the printed figure and its RAG against that same centre. The
 * old hollow target ring was the second reference, and it goes with it. With no
 * basket the plan is the centre and the line goes to the neutral plan grey.
 *
 * Adding | Costing - per-group step contributions from funnelByGroup, top 4 by
 * |value| of the chosen sign. Methodology notes live in tooltips only. */
import React from "react";
import {
  Card, GROUP_DOTS, C, fmt, fmtSigned, MINUS, useTip, rungGeom, RungTrack, RungKey,
  useRefMode, refWord, otherWord,
} from "../ui.jsx";

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
        <RungTrack dev={r.dev} up={r.up} neutral={r.neutral} guide bench={bench} />
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

/* { v, bm, plan, kind } -> render model. The rung centre is whichever reference
 * the page is read against: the benchmark itself, or the target, which is the
 * benchmark × K on a volume and the benchmark itself on a rate. Without a basket
 * the plan stands in for both, which is the same rung either way. */
function buildRung({ v, bm, plan, kind }, bench, k, mode) {
  const bmv = bench && usable(bm) ? bm : null;
  const target = bmv !== null ? bmv * (kind === "vol" && k > 0 ? k : 1) : plan;
  const ref = mode === "benchmark" && bmv !== null ? bmv : target;
  if (!finite(v) || !usable(ref)) {
    return { neutral: true, dev: 50, beyond: false, rag: C.muted, delta: "–", ref: null, other: null, relPct: null };
  }
  const relPct = (v / ref - 1) * 100;
  const geom = rungGeom(v / ref) || {};
  return {
    neutral: false,
    up: relPct >= 0,
    dev: geom.dev ?? 50,
    beyond: !!geom.beyond,
    rag: relPct >= 0 ? C.green : relPct > -10 ? C.amber : C.red,
    delta: (relPct >= 0 ? "+" : MINUS) + Math.abs(Math.round(relPct)) + "%",
    ref, relPct,
    other: bmv === null ? null : mode === "benchmark" ? target : bmv,
  };
}

function FunnelView({ snap }) {
  const mode = useRefMode();
  const refLabel = refWord(mode, "today");
  const otherLabel = otherWord(mode, "today");
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

  const midR = buildRung({ v: sessA, bm: sessB || null, plan: sessE, kind: "vol" }, bench, k, mode);
  const lowR = buildRung({ v: convA, bm: convB, plan: convE, kind: "rate" }, bench, k, mode);

  const posts = (social.posts ?? 0) + (social.stories ?? 0);
  const pctTxt = (x) => (x === null || x === undefined ? "–" : fmt(x * 100, 1) + "%");
  const relRow = (r) => (r.relPct === null ? [] : [{
    label: "vs " + refLabel.toLowerCase(),
    value: (r.relPct >= 0 ? "+" : MINUS) + Math.abs(r.relPct).toFixed(1) + "%",
    color: r.rag,
  }]);
  // the reference this page is read against, then the other one as a plain figure
  const refRows = (r, show) => [
    ...(r.ref === null ? [] : [{ label: refLabel, value: show(r.ref) }]),
    ...(r.other === null || r.other === undefined ? [] : [{ label: otherLabel, value: show(r.other) }]),
  ];

  return (
    <>
      <FunnelRung
        tier="Top of funnel" metric="Emails + posts" bench={bench}
        r={{ neutral: true, dev: 50, beyond: false, rag: C.muted, delta: "–" }}
        tip={{
          head: "Top of funnel",
          rows: [
            { label: "Emails delivered", value: fmt(email.delivered ?? null) },
            { label: "Posts + stories", value: fmt(posts) },
            { label: refLabel, value: "–" },
          ],
        }}
      />
      <FunnelRung
        tier="Mid funnel" metric="Sessions" r={midR} bench={bench}
        tip={{
          head: "Mid funnel · Sessions",
          body: bench
            ? `Sessions carry the even uplift, so the target is the benchmark × K (${fmt(k, 2)}).`
            : undefined,
          rows: [
            { label: "Actual", value: fmt(sessA) },
            ...(targeted ? refRows(midR, (x) => fmt(x)) : [{ label: refLabel, value: "– (no targets)" }]),
            ...relRow(midR),
          ],
        }}
      />
      <FunnelRung
        tier="Low funnel" metric="Session → entry" r={lowR} bench={bench}
        tip={{
          head: "Low funnel · Session → entry",
          body: bench
            ? "Conversion is held at the benchmark, so the target and the benchmark are the same figure."
            : undefined,
          rows: [
            { label: "Actual", value: pctTxt(convA) },
            ...(targeted ? refRows(lowR, pctTxt) : [{ label: refLabel, value: "– (no targets)" }]),
            ...relRow(lowR),
          ],
        }}
      />
      <RungKey word={refLabel} bench={bench} />
    </>
  );
}

/* `horizon` is accepted and ignored: this card is always the Today horizon
 * (BENCHMARK_SPEC 2), so the page HORIZON toggle must not reach it. The
 * reference toggle does reach it, through the context, like every other card. */
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
            title="Organic funnel at a grouped level: the chosen reference down the centre, the actual as a dot"
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
