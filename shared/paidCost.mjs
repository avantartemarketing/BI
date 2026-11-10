/* What a paid entry costs, as the plan prices it: the browser's copy of
 * etl/paid_cost.py (docs/METHODOLOGY.md step 5). The average price of an
 * entry over a campaign that spends S in all is
 *     ref x ((K + S) / (K + S_ref)) ** slope
 * ref being the price at the reference spend S_ref, slope how fast it rises
 * with the spend and K the wear-out's scale. The entries a spend buys are
 * S over that; the budget for a number of entries is the spend that buys
 * them, by the same bisection as the Python so the two agree to the cent;
 * the last entry's price is the derivative. tests/test_paid_cost.py holds
 * the two sides together. */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function averagePrice(spend, ref, slope, k, sRef) {
  if (!(ref > 0)) return 0;
  return ref * Math.pow((k + Math.max(num(spend), 0)) / (k + sRef), slope);
}

export function entriesForSpend(spend, ref, slope, k, sRef) {
  if (!(spend > 0) || !(ref > 0)) return 0;
  return spend / averagePrice(spend, ref, slope, k, sRef);
}

export function marginalPrice(spend, ref, slope, k, sRef) {
  const a = averagePrice(spend, ref, slope, k, sRef);
  const s = Math.max(num(spend), 0);
  const denom = k + s - slope * s;
  return denom > 0 ? (a * (k + s)) / denom : a;
}

export function spendForEntries(entries, ref, slope, k, sRef) {
  if (!(entries > 0) || !(ref > 0)) return 0;
  let hi = Math.max(entries * ref, 1);
  for (let i = 0; i < 200; i++) {
    if (entriesForSpend(hi, ref, slope, k, sRef) >= entries) break;
    hi *= 2;
  }
  let lo = 0;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (entriesForSpend(mid, ref, slope, k, sRef) < entries) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-9 * Math.max(hi, 1)) break;
  }
  return 0.5 * (lo + hi);
}

export function referencePrice(avg, spend, slope, k, sRef) {
  if (!(avg > 0)) return 0;
  return avg / Math.pow((k + Math.max(num(spend), 0)) / (k + sRef), slope);
}
