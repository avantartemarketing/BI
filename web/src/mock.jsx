import React from "react";
import { createRoot } from "react-dom/client";
import PaidRoi from "./modules/PaidRoi.jsx";
import base from "../../data/app/releases/warhol_le_26.json";
import "./tokens.css";

// the live page's figures, read off the screenshot: announce 29 Oct, close 30 Nov, today 13 Nov
const iso = (n) => new Date(Date.UTC(2026, 9, 29) + n * 86400000).toISOString().slice(0, 10);
const roi = [null, null, 9.2, 4.9, 2.78, 2.18, 1.88, 2.38, 2.15, 2.17, 1.8, 1.53, 1.2, 0.27, 0.33];
const spend = [0, 0, 480, 1210, 3957, 2480, 1010, 960, 920, 700, 760, 560, 540, 300, 240, 60];
const entries = [0, 0, 9, 14, 25, 17, 6, 8, 7, 5, 5, 3, 2, 0, 1, 0];
const conv = [0, 0, 8, 12, 21, 14, 5, 7, 6, 4, 4, 3, 2, 0, 1, 0];
const daily = spend.map((s, i) => ({ date: iso(i), spend: s, entries: entries[i], converting: conv[i], roi: roi[i] ?? null, roiArtist: roi[i] ? roi[i] * 0.62 : null, roi1: roi[i] ?? null, roiArtist1: null, partial: i === 15 }));
const ahead = Array.from({ length: 17 }, (_, k) => 16 + k);
const snap = {
  ...base, windowStart: iso(0), windowEnd: iso(32), campaignLengthDays: 32, day: 15, of: 32, complete: false, asOf: iso(15),
  paid: { ...base.paid, daily, l3dRoi: 0.33, cumRoi: 2.18, l1dRoi: 0.41, roiTarget: 1.1, spendToDate: 14177,
    roiPath: [{ date: iso(15), roi: 0.36 }, ...ahead.map((s, k) => ({ date: iso(s), roi: [0.34, 0.33, 0.32, 0.31, 0.31, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.29, 0.29, 0.3, 0.4, 0.43][k] }))],
    budget: { ...base.paid.budget, schedule: ahead.map((s) => ({ date: iso(s), spend: 330 })) } },
};
const q = new URLSearchParams(location.search);
const hover = q.get("hover");
function Page() {
  return (
    <div style={{ padding: 24, width: 558, background: "var(--bg)" }} id="shot">
      <PaidRoi snap={snap} look={q.get("look") || ""} />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Page />);
