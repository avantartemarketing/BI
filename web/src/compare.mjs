/* What the Overview reads progress against: the target or the benchmark,
 * never both (3 November 2026). The reader picks one in the chips row and
 * the choice sticks per browser; a release that has only one of the two
 * reads against that one. Plain JavaScript, so the tests can import it. */

export const canTarget = (snap) => !!snap && snap.targeted !== false;
export const canBenchmark = (snap) => !!snap && !!snap.benchmark;

/* "target", "benchmark", or null when the release has neither */
export function compareOf(snap, pref) {
  const t = canTarget(snap), b = canBenchmark(snap);
  if (pref === "benchmark" && b) return "benchmark";
  if (t) return "target";
  return b ? "benchmark" : null;
}
