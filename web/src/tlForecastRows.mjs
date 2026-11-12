/* The rows of the timed launch's forecast table (modules/TLForecastTable.jsx,
 * docs/TL_SPEC.md 4c), kept apart from the card so a test can read them. A
 * row per work and the release as the last row. The signups side reads the
 * hero (signups to date, the target's pace by today, the projection to the
 * open); the sales side reads sellForecast.open (4b): the units the signups
 * projected to the open are expected to buy, the units from buyers who never
 * signed up, their sum, the units target and the sum as a share of it. A
 * work's signups are the ones keyed to it by product page plus its share of
 * the rest (release signups and product ones without a page); under the
 * keyed minimum, its share of the units target. Its target by today is the
 * release's on its share of the units target, else on the same share. */
const has = (v) => v !== null && v !== undefined && Number.isFinite(v);

export function tlForecastRows(snap) {
  const f = snap.sellForecast || null;
  const hero = snap.hero || {};
  const open = f && f.open ? f.open : null;
  const today = f && f.today ? f.today : null;
  if (!f || !open) return { rows: [], all: null };
  const now = has(hero.now) ? hero.now : (today && has(today.signups) ? today.signups : null);
  const targetNow = has(hero.expectedToday) ? hero.expectedToday : null;
  const projected = has(open.signups) ? open.signups : (has(hero.projected) ? hero.projected : null);
  const works = open.works || [];
  const rest = (f.unkeyedProduct || 0) + (f.releaseSignups || 0);
  const pool = (f.keyed || 0) + rest;
  const byPage = f.source === "signup pages" && pool > 0;
  const targetSum = works.reduce((s, w) => s + (has(w.target) ? w.target : 0), 0);
  const rows = works.map((w) => {
    const frac = byPage ? ((w.keyed || 0) + (w.share || 0) * rest) / pool : (w.share || 0);
    const tShare = targetSum > 0 && has(w.target) ? w.target / targetSum : (w.share || 0);
    return {
      key: w.key || w.name, name: w.name,
      signups: has(now) ? now * frac : null,
      targetToDate: has(targetNow) ? targetNow * tShare : null,
      forecastSignups: has(projected) ? projected * frac : null,
      su: has(w.su) ? w.su : null, non: has(w.non) ? w.non : null, units: has(w.units) ? w.units : null,
      lo: has(w.lo) ? w.lo : null, hi: has(w.hi) ? w.hi : null,
      target: has(w.target) && w.target > 0 ? w.target : null,
    };
  });
  const all = {
    key: "_all", name: "All works",
    signups: now, targetToDate: targetNow, forecastSignups: projected,
    su: has(open.su) ? open.su : null, non: has(open.non) ? open.non : null, units: has(open.units) ? open.units : null,
    lo: has(open.lo) ? open.lo : null, hi: has(open.hi) ? open.hi : null,
    target: has(open.target) && open.target > 0 ? open.target : null,
  };
  return { rows, all, byPage };
}
