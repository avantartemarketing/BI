/* Sell-through (spec §4.8, LE 3-segment recut §6.4).
 *
 * Two readings of the same edition, chosen by the page horizon, because the two
 * questions want different bars. Today asks "how much of the edition is
 * secured, and is that where it should be by now": sold plus the entries
 * already in hand. At close asks "will it sell out": the three-segment
 * prediction bar. Either way the chosen reference sits behind the segments as a
 * tint running out from zero, so the reading is simply whether the segments end
 * past it.
 *
 * The bar scale is the edition in both horizons, so every position on it is also
 * a share of the edition and the reference needs no axis of its own.
 *
 * If the draw feed is present, a "Demand by product" mini-table (per-product
 * eligible entries; the feed carries no per-product edition sizes yet).
 * Horizontal legend at the bottom, no rule. */
import React from "react";
import {
  Card, GROUP_DOTS, C, fmt, ragColor, useTip, useWidth, labelPx, axisLabelLeft,
  useRefMode, refWord, otherWord,
} from "../ui.jsx";

const SEGS = [
  { key: "sold", color: C.rust, label: "Sold",
    tip: (v) => ({ head: "Sold", rows: [{ label: "Units", value: fmt(v) }] }) },
  { key: "soldPredicted", color: C.orange, label: "Sold predicted",
    tip: (v) => ({ head: "Sold predicted", rows: [{ label: "Units", value: fmt(v) }, { label: "From", value: "entries in hand" }] }) },
  { key: "futureEntriesPredicted", color: C.orangeLight, label: "Future entries",
    tip: (v) => ({ head: "Future entries", rows: [{ label: "Units", value: fmt(v) }, { label: "From", value: "entries still to come" }] }) },
];

/* Today is the same currency as the hero: what is already banked, sold plus the
 * entries in hand. The third segment is a forecast, so it has no place in a
 * reading of today. */
const TODAY_SEGS = [
  SEGS[0],
  { key: "soldPredicted", color: C.orange, label: "From entries in hand",
    tip: (v) => ({ head: "From entries in hand", rows: [{ label: "Units", value: fmt(v) }] }) },
];

export default function SellThrough({ snap, horizon = "today" }) {
  const tipApi = useTip();
  const mode = useRefMode();
  const st = snap?.sellthrough;
  const draw = snap?.draw;
  const close = horizon === "close";
  const title = close ? "Predicted sell-through" : "Sell-through";

  if (!st) {
    return (
      <Card dot={GROUP_DOTS.outcome} title={title}>
        <div className="empty-state">No sell-through model yet</div>
      </Card>
    );
  }

  if (st.edition === null || st.edition === undefined) {
    return (
      <Card dot={GROUP_DOTS.outcome} title="Sell-through">
        <div className="spacer-8" />
        <div className="lead">
          {fmt(st.sold ?? 0)}
          <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>units sold</span>
        </div>
        <div className="lead-caption" style={{ color: C.muted }}>edition size not set - no sell-through %</div>
        <div className="legend-rows" style={{ marginTop: 20 }}>
          <div className="legend-row">
            <span className="swatch" style={{ background: C.rust }} />
            <span style={{ color: C.muted }}>Sold</span>
            <span className="val">{fmt(st.sold ?? 0)}</span>
          </div>
          <div className="legend-row">
            <span className="swatch" style={{ background: C.orange }} />
            <span style={{ color: C.muted }}>Predicted from entries in hand</span>
            <span className="val">{fmt(st.soldPredicted ?? 0)}</span>
          </div>
        </div>
      </Card>
    );
  }
  const edition = st.edition ?? 0;
  const hero = snap?.hero || {};
  const segs = close ? SEGS : TODAY_SEGS;
  const secured = segs.reduce((t, s) => t + (st[s.key] ?? 0), 0);
  // at close the headline is the model's own prediction; today it is what is
  // already banked, which is the same currency the hero and the waterfall use
  const pctFrac = close ? st.pct ?? 0 : edition > 0 ? secured / edition : 0;
  const pct = Math.round(pctFrac * 100);
  const w = (v) => (edition > 0 ? Math.max(0, (v / edition) * 100) : 0);
  const posOf = (v) => Math.max(0, Math.min(100, w(v)));

  // the reference: whichever the page is being read against, absent only where
  // the release has no basket and the benchmark was asked for
  const hasBm = !!snap?.benchmark;
  const bmClose = hasBm ? st.benchmarkUnits ?? null : null;
  const bmToday = hasBm ? hero.benchmarkToday ?? null : null;
  const bm = close ? bmClose : bmToday;
  // at close the target IS the edition, which the track already draws, so the
  // only reference worth a tint there is the benchmark
  const target = close ? null : hero.expectedToday ?? 0;
  const ref = mode === "benchmark" ? bm : target;
  const other = mode === "benchmark" ? target : bm;
  const refLabel = refWord(mode, horizon);
  const otherLabel = otherWord(mode, horizon);
  const shareOf = (v) => (edition > 0 ? Math.round((v / edition) * 100) : null);

  const refTip = ref === null ? null : {
    head: mode === "benchmark" ? (close ? "Benchmark at close" : "Benchmark today") : "Target today",
    rows: [
      { label: "Units", value: fmt(ref) },
      ...(shareOf(ref) !== null ? [{ label: "Of edition", value: shareOf(ref) + "%" }] : []),
      ...(other !== null && other !== undefined
        ? [{ label: otherLabel, value: fmt(other) }] : []),
    ],
    body: mode === "benchmark"
      ? "The median of the matched basket - what launches like this one typically reach."
      : undefined,
  };

  const products = draw?.per_product || [];
  const maxEntries = products.reduce((m, p) => Math.max(m, p.entries ?? 0), 0);

  const axisLabel = { position: "absolute", top: 3, fontSize: 12, whiteSpace: "nowrap" };

  /* The reference label rides above the tint it names, and "sellout" is pinned
     to the right of the axis under it, so on a release near its edition the two
     would collide. Measure the row and slide the reference label clear. */
  const [labRef, labW] = useWidth();
  const refText = ref === null ? "" :
    `${refLabel.toLowerCase()} ${fmt(ref)}${shareOf(ref) !== null ? " · " + shareOf(ref) + "%" : ""}`;
  const selloutText = `sellout ${fmt(edition)}`;
  const refLeft = refText
    ? axisLabelLeft({ pct: posOf(ref), rowW: labW, textW: labelPx(refText) })
    : null;

  return (
    <Card dot={GROUP_DOTS.outcome} title={title}>
      <div className="spacer-8" />
      <div className="lead">
        <span style={{ color: ragColor(pctFrac) }}>{pct}%</span>
        <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, whiteSpace: "nowrap" }}>
          of {fmt(edition)} units
        </span>
      </div>
      <div className="spacer-16" />
      <div className="body">
        <div
          style={{
            flex: 1, display: "flex", flexDirection: "column",
            justifyContent: "center", gap: 16, minHeight: 0,
          }}
        >
          {/* release-level bar: the edition is the full width, so the ticks are
              also shares of the edition and need no scale of their own */}
          <div style={{ flexShrink: 0 }}>
            <div ref={labRef} style={{ position: "relative", height: 18, marginBottom: 6 }}>
              {ref !== null && ref > 0 && (
                <div
                  {...tipApi.props(refTip)}
                  style={refLeft === null
                    ? { position: "absolute", left: `${posOf(ref)}%`, bottom: 0, transform: "translateX(-50%)", fontSize: 12, color: C.ink, whiteSpace: "nowrap" }
                    : { position: "absolute", left: refLeft, bottom: 0, fontSize: 12, color: C.ink, whiteSpace: "nowrap" }}
                >
                  {refText}
                </div>
              )}
            </div>

            {/* the reference as a tint out from zero, the segments inset inside
                it, so the tint still shows above and below them */}
            <div style={{ position: "relative", height: 20, background: C.track, borderRadius: 5 }}>
              {ref !== null && ref > 0 && (
                <div
                  {...tipApi.props(refTip)}
                  style={{
                    position: "absolute", inset: 0, width: `${posOf(ref)}%`,
                    background: C.refFill, borderRadius: 5,
                  }}
                />
              )}
              <div
                style={{
                  position: "absolute", top: 4, bottom: 4, left: 0, right: 0,
                  borderRadius: 3, overflow: "hidden", display: "flex",
                }}
              >
                {segs.map((s) => (
                  <div
                    key={s.key}
                    {...tipApi.props(s.tip(st[s.key] ?? 0))}
                    style={{ width: `${w(st[s.key] ?? 0)}%`, background: s.color, flex: "0 0 auto" }}
                  />
                ))}
              </div>
            </div>

            <div style={{ position: "relative", height: 18, marginTop: 6 }}>
              <div style={{ ...axisLabel, right: 0, color: C.muted }}>{selloutText}</div>
            </div>
          </div>

          {/* demand by product - only when the draw feed is present */}
          {products.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
              <div style={{ fontSize: 12, color: C.muted }}>Demand by product</div>
              {products.map((p) => (
                <div
                  key={p.name}
                  style={{
                    display: "grid", gridTemplateColumns: "104px 1fr 44px",
                    gap: 12, alignItems: "center",
                  }}
                >
                  <div
                    title={p.name}
                    style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {p.name}
                  </div>
                  <div style={{ position: "relative", height: 14, background: C.track, borderRadius: 4 }}>
                    <div
                      {...tipApi.props({ head: p.name, rows: [{ label: "Eligible entries", value: fmt(p.entries) }] })}
                      style={{
                        position: "absolute", left: 0, top: 0, bottom: 0,
                        width: `${maxEntries > 0 ? ((p.entries ?? 0) / maxEntries) * 100 : 0}%`,
                        background: C.orange, borderRadius: 4,
                      }}
                    />
                  </div>
                  <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>
                    {fmt(p.entries)}
                  </div>
                </div>
              ))}
              <div
                title="Units demanded sums every eligible product entry - one entrant can demand several units across products"
                style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}
              >
                {fmt(draw.units_demanded)} units demanded · {fmt(draw.eligible)} eligible entrants
              </div>
            </div>
          )}
        </div>

        {/* bottom horizontal legend, no rule */}
        <div style={{ marginTop: "auto", paddingTop: 12, height: 26, display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
          {segs.map((s) => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{s.label}</span>
            </div>
          ))}
          {ref !== null && ref > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: C.refFill, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{refLabel}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
