/* Sell-through (spec §4.8, LE 3-segment recut §6.4; horizon and reference
 * grammar per BENCHMARK_SPEC 2 and 7).
 *
 * Two readings of the same edition, chosen by the page horizon, because the two
 * questions want different bars. Today asks "how much of the edition is
 * secured, and is that where it should be by now": one bar of sold plus the
 * entries already in hand, crossed by the target for today (ink) and what the
 * matched basket typically has by now (cobalt). At close asks "will it sell
 * out": the three-segment prediction bar, with the basket's median marked in
 * cobalt so an ambitious prediction can be read against what launches like this
 * one actually reach.
 *
 * The bar scale is the edition in both horizons, so every mark on it is also a
 * share of the edition and the ticks need no axis of their own. The reference
 * ticks sit outside the clipped track, because they bleed 3px past the bar they
 * cross and a rounded, overflow-hidden track would cut that bleed off.
 *
 * If the draw feed is present, a "Demand by product" mini-table (per-product
 * eligible entries; the feed carries no per-product edition sizes yet).
 * Horizontal legend at the bottom, no rule. When snap.benchmark is absent the
 * cobalt tick is simply not drawn. */
import React from "react";
import { Card, GROUP_DOTS, RefTick, C, fmt, ragColor, useTip, useWidth, labelPx, axisLabelLeft } from "../ui.jsx";

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

  // the references, both absent unless the release has a basket behind it
  const hasBm = !!snap?.benchmark;
  const bmClose = hasBm ? st.benchmarkUnits ?? null : null;
  const bmToday = hasBm ? hero.benchmarkToday ?? null : null;
  const bm = close ? bmClose : bmToday;
  const targetToday = hero.expectedToday ?? 0;
  const bmPct = bm !== null && edition > 0 ? Math.round((bm / edition) * 100) : null;

  const bmTip = {
    head: close ? "Benchmark at close" : "Benchmark today",
    rows: [
      { label: "Units", value: fmt(bm ?? 0) },
      ...(bmPct !== null ? [{ label: "Of edition", value: bmPct + "%" }] : []),
    ],
    body: "The median of the matched basket - what launches like this one typically reach.",
  };
  const targetTip = {
    head: "Target today",
    rows: [
      { label: "Units", value: fmt(targetToday) },
      ...(edition > 0 ? [{ label: "Of edition", value: Math.round((targetToday / edition) * 100) + "%" }] : []),
    ],
  };

  const products = draw?.per_product || [];
  const maxEntries = products.reduce((m, p) => Math.max(m, p.entries ?? 0), 0);

  const axisLabel = { position: "absolute", top: 3, fontSize: 12, whiteSpace: "nowrap" };

  /* Same axis row as the hero: the benchmark label is anchored to its tick and
     "sellout" is pinned to the right, so on a release near its edition the two
     collided. Measure the row and slide the benchmark clear. */
  const [axisRef, axisW] = useWidth();
  const bmText = bm === null ? "" :
    `benchmark ${fmt(bm)}${close && bmPct !== null ? " · " + bmPct + "%" : ""}`;
  const selloutText = `sellout ${fmt(edition)}`;
  const bmLeft = bmText
    ? axisLabelLeft({
      pct: posOf(bm), rowW: axisW, textW: labelPx(bmText),
      hiW: close ? 0 : labelPx(selloutText),
    })
    : null;
  const lineSwatch = (bg) => ({ width: 12, height: 2, background: bg, borderRadius: 0, flex: "0 0 12px" });

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
            {!close && targetToday > 0 && (
              <div style={{ position: "relative", height: 18, marginBottom: 6 }}>
                <div
                  {...tipApi.props(targetTip)}
                  style={{
                    position: "absolute", left: `${posOf(targetToday)}%`, bottom: 0,
                    transform: "translateX(-50%)", fontSize: 12, color: C.refTarget, whiteSpace: "nowrap",
                  }}
                >
                  target {fmt(targetToday)}
                </div>
              </div>
            )}

            <div style={{ position: "relative" }}>
              <div
                style={{
                  height: 20, background: C.track,
                  borderRadius: 5, overflow: "hidden", display: "flex",
                }}
              >
                {segs.map((s) => (
                  <div
                    key={s.key}
                    {...tipApi.props(s.tip(st[s.key] ?? 0))}
                    style={{ width: `${w(st[s.key] ?? 0)}%`, background: s.color }}
                  />
                ))}
              </div>
              {bm !== null && (
                <RefTick pct={posOf(bm)} kind="benchmark" tip={bmTip} />
              )}
              {!close && targetToday > 0 && (
                <RefTick pct={posOf(targetToday)} kind="target" tip={targetTip} />
              )}
            </div>

            {(bm !== null || !close) && (
              <div ref={axisRef} style={{ position: "relative", height: 18, marginTop: 6 }}>
                {bm !== null && (
                  <div
                    {...tipApi.props(bmTip)}
                    style={bmLeft === null
                      ? { ...axisLabel, left: `${posOf(bm)}%`, transform: "translateX(-50%)", color: C.refBm }
                      : { ...axisLabel, left: bmLeft, color: C.refBm }}
                  >
                    {bmText}
                  </div>
                )}
                {!close && (
                  <div style={{ ...axisLabel, right: 0, color: C.muted }}>{selloutText}</div>
                )}
              </div>
            )}
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
          {!close && targetToday > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={lineSwatch(C.refTarget)} />
              <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>Target</span>
            </div>
          )}
          {bm !== null && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={lineSwatch(C.refBm)} />
              <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>Benchmark</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
